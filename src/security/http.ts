/** Explicit synthetic development listener; never installed on the public reader server. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Socket } from 'node:net';
import { JsonRepository } from '../newsroom/store.ts';
import type { Story, State } from '../newsroom/model.ts';
import type { EditionStatus, PlacementInput } from '../editions/types.ts';
import { AuthenticatedEditorial } from './editorial.ts';
import { AuthenticatedSourceQueue } from './source.ts';
import { AuthenticatedSourceReview } from './source-review.ts';
import { AuthenticatedSourceHandoff } from './source-handoff.ts';
import type { SourceReviewAction, SourceReviewInput } from '../source-review/types.ts';
import type { SourceSelection } from '../source-handoff/types.ts';
import { SourceQueueError } from '../source-queue/service.ts';
import { sourceQueueViews, type SourceQueueQuery } from '../source-queue/types.ts';
import { AccessControl } from './service.ts';
import { permissionMatrix } from './policy.ts';
import { SecurityError } from './verifier.ts';
import { assertResourcePolicy, runRevision, scheduleRevision, type ResourcePolicy } from './resources.ts';
import type { Permission, Principal } from './types.ts';

export interface InternalEditorialHTTPOptions {
  enabled?: boolean;
  mode?: 'development' | 'production' | 'test';
  repository: JsonRepository;
  access: AccessControl;
  policy: ResourcePolicy;
  port?: number;
}
export interface InternalEditorialHTTP { readonly origin: string; close(): Promise<void> }
const bodyLimit = 16_384;
const bodyTimeout = 1000;
const sourceResponseLimit = 262_144;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
function reject(status = 400, code = 'INVALID_REQUEST'): never { throw new RequestError(status, code); }

/** Peer and raw-header checks also apply to clients that do not enforce browser CORS rules. */
export function validateInternalRequest(request: Pick<IncomingMessage, 'socket' | 'rawHeaders' | 'headers' | 'url'>, port: number): void {
  if (request.socket.remoteAddress !== '127.0.0.1' && request.socket.remoteAddress !== '::ffff:127.0.0.1') reject(403, 'FORBIDDEN');
  if (request.rawHeaders.length > 96) reject(431, 'HEADERS_TOO_LARGE');
  const counts = new Map<string, number>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index].toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const name of ['host', 'authorization', 'origin', 'content-type', 'content-length', 'transfer-encoding']) {
    if ((counts.get(name) ?? 0) > 1) reject();
  }
  const host = `127.0.0.1:${port}`;
  if (request.headers.host !== host) reject(403, 'FORBIDDEN');
  if (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) reject(403, 'FORBIDDEN');
  if (Object.keys(request.headers).some(name => ['cookie', 'forwarded', 'transfer-encoding', 'expect', 'upgrade'].includes(name)
    || name.startsWith('x-forwarded-') || name.startsWith('access-control-request-'))) reject(403, 'FORBIDDEN');
  if (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) reject(403, 'FORBIDDEN');
  if (typeof request.url !== 'string' || !request.url.startsWith('/') || /[#%\\]/.test(request.url)) reject();
  if (request.url.split('?')[0] === '/internal/source-queue') {
    if (request.url.length > 2048) reject();
    sourceQuery(request.url);
  } else if (request.url.length > 512 || request.url.includes('?')) reject();
}
/** Raw ASCII query parsing prevents alternate key spellings, decoding ambiguity and credential URLs. */
function sourceQuery(path: string): SourceQueueQuery | undefined {
  const [pathname, raw, ...extra] = path.split('?');
  if (pathname !== '/internal/source-queue' || extra.length) reject();
  if (raw === undefined) return undefined;
  if (!raw || raw.length > 1536) reject();
  const query: SourceQueueQuery = {};
  const seen = new Set<string>();
  for (const part of raw.split('&')) {
    const [name, value, ...rest] = part.split('=');
    if (!value || rest.length || seen.has(name)) reject();
    seen.add(name);
    if (name === 'view' && (sourceQueueViews as readonly string[]).includes(value)) query.view = value as SourceQueueQuery['view'];
    else if (name === 'limit' && /^[1-9][0-9]?$/.test(value) && Number(value) <= 50) query.limit = Number(value);
    else if (name === 'cursor' && /^[A-Za-z0-9_-]{1,1024}$/.test(value)) query.cursor = value;
    else reject();
  }
  return query;
}
function credential(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || header.length > 8200 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header)) reject(401, 'UNAUTHENTICATED');
  return header.slice(7);
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function fingerprint(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
const managedSourceId = (value: unknown): value is string => typeof value === 'string' && /^url-[a-f0-9]{64}$/.test(value);
function sourceReviewBody(value: unknown, action: SourceReviewAction | 'inspect'): { sourceId: string; input?: SourceReviewInput } {
  const common = ['sourceId', 'revision', 'reasonCode', 'evidenceReferences'];
  if (action === 'inspect') {
    if (!exact(value, ['sourceId']) || !managedSourceId(value.sourceId)) reject();
    return { sourceId: value.sourceId };
  }
  if (!exact(value, action === 'propose' ? [...common, 'classification', 'originId'] : common)
    || !managedSourceId(value.sourceId) || !fingerprint(value.revision)
    || typeof value.reasonCode !== 'string' || !['INITIAL_REVIEW', 'EVIDENCE_SUPPORTED', 'INSUFFICIENT_EVIDENCE',
      'CONTRADICTORY_EVIDENCE', 'REVIEW_HOLD', 'HOLD_RELEASED', 'WITHDRAWN'].includes(value.reasonCode)
    || !Array.isArray(value.evidenceReferences) || value.evidenceReferences.length < 1 || value.evidenceReferences.length > 16
    || value.evidenceReferences.some(id => !managedSourceId(id)) || new Set(value.evidenceReferences).size !== value.evidenceReferences.length) reject();
  if (action === 'propose' && (typeof value.classification !== 'string'
    || !['PRIMARY', 'ORIGINAL', 'SECONDARY', 'SYNDICATED', 'UNKNOWN', 'DISPUTED'].includes(value.classification)
    || (value.classification === 'SYNDICATED' ? !managedSourceId(value.originId) : value.originId !== null))) reject();
  const { sourceId, ...input } = value;
  return { sourceId, input: input as unknown as SourceReviewInput };
}
function sourceHandoffBody(value: unknown, action: 'inspect' | 'prepare'):
  { sourceIds: string[] } | { sources: SourceSelection[]; story: Omit<Story, 'status' | 'version' | 'sourceHandoff'> } {
  if (action === 'inspect') {
    if (!exact(value, ['sourceIds']) || !Array.isArray(value.sourceIds) || value.sourceIds.length < 1 || value.sourceIds.length > 8
      || value.sourceIds.some(id => !managedSourceId(id)) || new Set(value.sourceIds).size !== value.sourceIds.length) reject();
    return { sourceIds: value.sourceIds as string[] };
  }
  if (!exact(value, ['sources', 'story']) || !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 8
    || value.sources.some(row => !exact(row, ['id', 'revision']) || !managedSourceId(row.id) || !fingerprint(row.revision))
    || new Set(value.sources.map(row => (row as { id: string }).id)).size !== value.sources.length
    || !value.story || typeof value.story !== 'object' || Array.isArray(value.story)
    || typeof (value.story as Record<string, unknown>).id !== 'string' || !idPattern.test((value.story as Record<string, unknown>).id as string)) reject();
  // The facade applies the exact human-authored story/evidence schema before authorization or mutation.
  return { sources: value.sources as SourceSelection[], story: value.story as Omit<Story, 'status' | 'version' | 'sourceHandoff'> };
}
async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type'] !== 'application/json') reject(415, 'UNSUPPORTED_MEDIA_TYPE');
  const length = request.headers['content-length'];
  if (typeof length !== 'string' || !/^(0|[1-9][0-9]*)$/.test(length)) reject(411, 'LENGTH_REQUIRED');
  if (Number(length) > bodyLimit) reject(413, 'BODY_TOO_LARGE');
  const bytes = await new Promise<Buffer>((resolve, fail) => {
    const chunks: Buffer[] = []; let size = 0, settled = false;
    const finish = (error?: RequestError) => {
      if (settled) return; settled = true; clearTimeout(timer);
      request.off('data', data); request.off('end', end); request.off('aborted', aborted); request.off('error', aborted);
      if (error) { request.resume(); fail(error); } else resolve(Buffer.concat(chunks));
    };
    const data = (chunk: Buffer) => { size += chunk.length; if (size > bodyLimit) finish(new RequestError(413, 'BODY_TOO_LARGE')); else chunks.push(chunk); };
    const end = () => finish(size === Number(length) ? undefined : new RequestError(400, 'INVALID_REQUEST'));
    const aborted = () => finish(new RequestError(400, 'INVALID_REQUEST'));
    const timer = setTimeout(() => finish(new RequestError(408, 'REQUEST_TIMEOUT')), bodyTimeout);
    request.on('data', data); request.on('end', end); request.on('aborted', aborted); request.on('error', aborted);
  });
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Prototype-sensitive keys are forbidden at every nesting level.
    return JSON.parse(text, (key, value: unknown) => { if (['__proto__', 'prototype', 'constructor'].includes(key)) reject(); return value; });
  } catch { return reject(); }
}
function sendSerialized(response: ServerResponse, status: number, serialized: string, requestId: string, head = false): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0',
    'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer', 'X-Request-ID': requestId, 'Connection': 'close' });
  response.end(head ? undefined : serialized);
}
function send(response: ServerResponse, status: number, value: unknown, requestId: string, head = false): void {
  sendSerialized(response, status, JSON.stringify(value), requestId, head);
}
function failure(error: unknown): { status: number; code: string } {
  if (error instanceof RequestError) return { status: error.status, code: error.code };
  if (error instanceof SourceQueueError) {
    if (error.code === 'INVALID_QUERY') return { status: 400, code: 'INVALID_REQUEST' };
    if (error.code === 'STALE_CURSOR') return { status: 409, code: 'CONFLICT' };
    return { status: 503, code: 'UNAVAILABLE' };
  }
  if (error instanceof SecurityError) {
    if (error.code === 'PERMISSION_DENIED') return { status: 403, code: 'FORBIDDEN' };
    if (error.code === 'STALE_TARGET') return { status: 409, code: 'CONFLICT' };
    if (error.code === 'DOMAIN_REJECTED') return { status: 400, code: 'INVALID_REQUEST' };
    if (error.code !== 'STORAGE_UNAVAILABLE') return { status: 401, code: 'UNAUTHENTICATED' };
  }
  return { status: 503, code: 'UNAVAILABLE' };
}
function grants(state: State, principal: Principal): Permission[] {
  const identity = state.identities.find(row => row.id === principal.identityId)!;
  return [...new Set(identity.roles.flatMap(role => [...permissionMatrix[role]]))];
}
function fictionalSources(state: Readonly<State>, ids: unknown): void {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new SecurityError('PERMISSION_DENIED');
  for (const id of ids) {
    const source = state.sources.find(row => row.id === id);
    if (!source) throw new SecurityError('PERMISSION_DENIED');
    let fictionalHost = false;
    try { const url = new URL(source.url); fictionalHost = ['http:', 'https:'].includes(url.protocol) && url.hostname.endsWith('.test') && !url.username && !url.password; } catch {}
    if (!fictionalHost) throw new SecurityError('PERMISSION_DENIED');
    const managed = state.managedSources.find(row => row.sourceId === id);
    if (managed) {
      if (managed.providerId !== 'fictional-fixture' || managed.policy.providerId !== 'fictional-fixture'
        || managed.policy.evidenceReference !== `fictional-fixture-only:${managed.policy.id}`
        || managed.providerMetadata.url !== source.url) throw new SecurityError('PERMISSION_DENIED');
    } else if (source.rights !== 'fictional test fixture only' || source.id.startsWith('url-')) throw new SecurityError('PERMISSION_DENIED');
  }
}
function mutation(value: unknown): unknown {
  const row = value as { id: string; version?: number; revision?: number; status?: string; enabled?: boolean };
  return { id: row.id, ...(row.version === undefined ? {} : { version: row.version }),
    ...(row.revision === undefined ? {} : { revision: row.revision }), ...(row.status === undefined ? {} : { status: row.status }),
    ...(row.enabled === undefined ? {} : { enabled: row.enabled }) };
}

/** Calling with absent enablement does not allocate a server or bind a port. No environment variable enables it. */
export async function startInternalEditorialHTTP(options: InternalEditorialHTTPOptions): Promise<InternalEditorialHTTP | null> {
  if (options?.enabled !== true) return null;
  if (options.mode !== 'development' || process.env.NODE_ENV === 'production') throw new Error('INTERNAL_LISTENER_DISABLED');
  if (!options.policy || typeof options.policy.authorize !== 'function' || !options.repository || !options.access
    || typeof options.repository.file !== 'string' || resolve(options.repository.file) !== options.access.repositoryFile
    || !Number.isInteger(options.port ?? 0) || (options.port ?? 0) < 0 || (options.port ?? 0) > 65535) throw new Error('INVALID_INTERNAL_CONFIGURATION');
  const { repository, access, policy } = options;
  // Listener-local revocation requests fence concurrent HTTP actions before waiting for the JSON lock.
  // Entries contain only registered opaque session IDs and expiry metadata, never bearer credentials.
  let closing = false;
  const pending = new Set<Promise<void>>();
  const revocations = new Map<string, string>();
  const pruneRevocations = () => { const now = Date.parse(access.now()); for (const [id, expires] of revocations) if (Date.parse(expires) <= now) revocations.delete(id); };
  const fence = (principal: Principal) => { if (closing) throw new SecurityError('STORAGE_UNAVAILABLE'); pruneRevocations(); if (revocations.has(principal.sessionId)) throw new SecurityError('SESSION_REVOKED'); };
  const scopedPolicy: ResourcePolicy = { authorize: (principal, permission, targets, state) => {
    fence(principal);
    // The source facade validates decisions against its frozen shared snapshot.
    if (['SOURCE_READ', 'SOURCE_REVIEW', 'SOURCE_RESOLVE', 'SOURCE_HOLD', 'SOURCE_RELEASE'].includes(permission)) return policy.authorize(principal, permission, targets, state);
    assertResourcePolicy(policy, principal, permission, targets, state);
  }, ...(typeof policy.sourceReadRevision === 'function' ? { sourceReadRevision: () => policy.sourceReadRevision!() } : {}) };
  let port = 0;
  const sockets = new Set<Socket>();
  const server = createServer({ maxHeaderSize: 12_288, requestTimeout: 5000, headersTimeout: 5000, connectionsCheckingInterval: 1000 }, (request, response) => {
    const requestId = randomUUID();
    const task = (async () => {
      validateInternalRequest(request, port);
      const path = request.url!;
      const sourceHandoff = /^\/internal\/source-handoff\/(inspect|prepare)$/.exec(path);
      if (sourceHandoff) {
        if (request.method !== 'POST') reject(405, 'METHOD_NOT_ALLOWED');
        const token = credential(request);
        const action = sourceHandoff[1] as 'inspect' | 'prepare';
        const body = sourceHandoffBody(await jsonBody(request), action);
        const workflow = new AuthenticatedSourceHandoff(repository, access, { resourcePolicy: scopedPolicy });
        if ('sourceIds' in body) {
          await workflow.withSelection(token, body.sourceIds, (selection, assertCurrent) => {
            const serialized = JSON.stringify(selection);
            if (Buffer.byteLength(serialized, 'utf8') > sourceResponseLimit) throw new SecurityError('STORAGE_UNAVAILABLE');
            assertCurrent();
            sendSerialized(response, 200, serialized, requestId);
          });
        } else {
          const prepared = await workflow.prepare(token, body);
          // Commitment and final response disclosure are distinct. A later denial does not undo the accepted story.
          await workflow.withPreparedStory(token, prepared.id, prepared.version, (receipt, assertCurrent) => {
            const serialized = JSON.stringify(receipt);
            if (Buffer.byteLength(serialized, 'utf8') > sourceResponseLimit) throw new SecurityError('STORAGE_UNAVAILABLE');
            assertCurrent();
            sendSerialized(response, 200, serialized, requestId);
          });
        }
        return;
      }
      const sourceReview = /^\/internal\/source-review\/(inspect|begin|propose|confirm|reject|hold|release|withdraw)$/.exec(path);
      if (sourceReview) {
        if (request.method !== 'POST') reject(405, 'METHOD_NOT_ALLOWED');
        const token = credential(request);
        const action = sourceReview[1] as SourceReviewAction | 'inspect';
        const body = sourceReviewBody(await jsonBody(request), action);
        const workflow = new AuthenticatedSourceReview(repository, access, { resourcePolicy: scopedPolicy });
        if (action !== 'inspect') await workflow[action](token, body.sourceId, body.input!);
        // A mutation has already committed here. A later response failure does not roll it back.
        // Reauthorize current source inspection before disclosing its resulting review status.
        await workflow.withSummary(token, body.sourceId, (summary, assertCurrent) => {
          const serialized = JSON.stringify(summary);
          if (Buffer.byteLength(serialized, 'utf8') > sourceResponseLimit) throw new SecurityError('STORAGE_UNAVAILABLE');
          assertCurrent();
          sendSerialized(response, 200, serialized, requestId);
        });
        return;
      }
      if (path.split('?')[0] === '/internal/source-queue') {
        if (request.method !== 'GET' && request.method !== 'HEAD') reject(405, 'METHOD_NOT_ALLOWED');
        if (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0') reject();
        const token = credential(request);
        const sourceQueue = new AuthenticatedSourceQueue(repository, access, { resourcePolicy: scopedPolicy });
        await sourceQueue.withPage(token, sourceQuery(path), (page, assertCurrent) => {
          const serialized = JSON.stringify(page);
          if (Buffer.byteLength(serialized) > sourceResponseLimit) throw new SecurityError('STORAGE_UNAVAILABLE');
          // Serialization can invoke userland hooks. Recheck immediately before synchronous disclosure.
          assertCurrent();
          sendSerialized(response, 200, serialized, requestId, request.method === 'HEAD');
        });
        return;
      }
      const story = /^\/internal\/stories\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(edit|review|approve)$/.exec(path);
      const edition = /^\/internal\/editions\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/review$/.exec(path);
      const schedule = /^\/internal\/schedules\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/pause$/.exec(path);
      const run = /^\/internal\/runs\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/claim$/.exec(path);
      const read = ['/internal/principal', '/internal/schedules'].includes(path);
      if (!read && !['/internal/session/revoke', '/internal/stories', '/internal/editions'].includes(path) && !story && !edition && !schedule && !run) reject(404, 'NOT_FOUND');
      if (request.method !== (read ? 'GET' : 'POST')) reject(405, 'METHOD_NOT_ALLOWED');
      if (read && request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0') reject();
      const token = credential(request);
      const state = await repository.read();
      const principal = access.authorizeInState(state, token, null, access.now());
      fence(principal);
      if (read) {
        const permissions = grants(state, principal);
        if (path === '/internal/principal') {
          send(response, 200, { id: principal.identityId, roles: state.identities.find(row => row.id === principal.identityId)!.roles, permissions }, requestId); return;
        }
        if (!permissions.some(value => value === 'SCHEDULE_CONFIGURE' || value === 'SCHEDULE_EXECUTE')) reject(403, 'FORBIDDEN');
        const schedules = permissions.includes('SCHEDULE_CONFIGURE') ? state.schedules.flatMap(row => {
          try { assertResourcePolicy(scopedPolicy, principal, 'SCHEDULE_CONFIGURE', [{ kind: 'SCHEDULE', id: row.id }], state); }
          catch { return []; }
          return [{ id: row.id, enabled: row.enabled, revision: scheduleRevision(row) }];
        }) : [];
        const runs = permissions.includes('SCHEDULE_EXECUTE') ? state.preparationRuns.flatMap(row => {
          try { assertResourcePolicy(scopedPolicy, principal, 'SCHEDULE_EXECUTE', [{ kind: 'RUN', id: row.id }], state); }
          catch { return []; }
          return [{ id: row.id, status: row.status, attempts: row.attempts, revision: runRevision(row) }];
        }) : [];
        send(response, 200, { schedules, runs }, requestId); return;
      }
      const body = await jsonBody(request);
      const proposedSources = path === '/internal/stories' && body && typeof body === 'object' ? (body as Record<string, unknown>).sourceIds
        : story?.[2] === 'edit' && body && typeof body === 'object' && (body as Record<string, unknown>).patch && typeof (body as Record<string, unknown>).patch === 'object'
          ? ((body as Record<string, unknown>).patch as Record<string, unknown>).sourceIds : undefined;
      const workflow = new AuthenticatedEditorial(repository, access, { resourcePolicy: { authorize: (actor, permission, targets, snapshot) => {
        assertResourcePolicy(scopedPolicy, actor, permission, targets, snapshot);
        if (proposedSources !== undefined) fictionalSources(snapshot, proposedSources);
        for (const target of targets) if (target.kind === 'STORY') {
          const current = snapshot.revisions.filter(row => row.id === target.id).at(-1);
          if (current) fictionalSources(snapshot, current.sourceIds);
        }
      }, ...(typeof scopedPolicy.sourceReadRevision === 'function' ? { sourceReadRevision: () => scopedPolicy.sourceReadRevision!() } : {}) } });
      // The facade reloads current identity/session/roles and checks exact resources under its mutation lock.
      let result: unknown;
      if (path === '/internal/session/revoke') {
        if (!exact(body, [])) reject();
        pruneRevocations();
        if (revocations.size >= 512) throw new SecurityError('STORAGE_UNAVAILABLE');
        const session = state.sessions.find(row => row.id === principal.sessionId)!;
        revocations.set(principal.sessionId, session.expiresAt);
        await access.invalidateSession(token); send(response, 200, { revoked: true }, requestId); return;
      } else if (path === '/internal/stories') {
        if (!exact(body, ['id', 'headline', 'topic', 'summary', 'geography', 'eventAt', 'firstSeenAt', 'updatedAt', 'clusterId', 'evidence', 'sourceIds']) || typeof body.id !== 'string' || !idPattern.test(body.id)) reject();
        result = await workflow.createStory(token, body as unknown as Omit<Story, 'status' | 'version'>);
      } else if (story) {
        const [, id, action] = story;
        if (action === 'edit') {
          if (!exact(body, ['version', 'patch']) || !revision(body.version) || !body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) reject();
          result = await workflow.editStory(token, id, body.version, body.patch);
        } else if (action === 'review') {
          if (!exact(body, ['version', 'status']) || !revision(body.version) || typeof body.status !== 'string') reject();
          result = await workflow.reviewStory(token, id, body.version, body.status as Story['status']);
        } else {
          if (!exact(body, ['version']) || !revision(body.version)) reject();
          result = await workflow.approveStory(token, id, body.version);
        }
      } else if (path === '/internal/editions') {
        if (!exact(body, ['date', 'timezone', 'placements']) || typeof body.date !== 'string' || typeof body.timezone !== 'string' || !Array.isArray(body.placements)) reject();
        result = await workflow.assembleEdition(token, { date: body.date, timezone: body.timezone, placements: body.placements as PlacementInput[] });
      } else if (edition) {
        if (!exact(body, ['revision', 'status']) || !revision(body.revision) || typeof body.status !== 'string') reject();
        result = await workflow.reviewEdition(token, edition[1], body.revision, body.status as EditionStatus);
      } else if (schedule) {
        if (!exact(body, ['revision']) || !fingerprint(body.revision)) reject();
        result = await workflow.pauseSchedule(token, schedule[1], body.revision);
      } else if (run) {
        if (!exact(body, ['revision']) || !fingerprint(body.revision)) reject();
        result = await workflow.claimRun(token, run[1], body.revision);
      }
      send(response, 200, mutation(result), requestId);
    })().catch(error => {
      const safe = failure(error);
      send(response, safe.status, { error: safe.code, requestId }, requestId, request.method === 'HEAD');
      // Neither errors nor request headers/body/credentials are logged or reflected.
    });
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  server.maxHeadersCount = 48;
  server.maxConnections = 32;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 1;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  server.on('checkContinue', (_request, response) => send(response, 400, { error: 'INVALID_REQUEST' }, randomUUID()));
  server.on('checkExpectation', (_request, response) => send(response, 400, { error: 'INVALID_REQUEST' }, randomUUID()));
  server.on('upgrade', (_request, socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', rejectListen); resolve(); });
    });
  } catch { throw new Error('INTERNAL_LISTENER_UNAVAILABLE'); }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('INTERNAL_LISTENER_UNAVAILABLE');
  port = address.port;
  return Object.freeze({ origin: `http://127.0.0.1:${port}`, close: async () => {
    closing = true;
    const closed = new Promise<void>((resolve, rejectClose) => server.close(error => error ? rejectClose(new Error('INTERNAL_LISTENER_CLOSE_FAILED')) : resolve()));
    for (const socket of sockets) socket.destroy();
    await closed; await Promise.allSettled([...pending]);
  } });
}
