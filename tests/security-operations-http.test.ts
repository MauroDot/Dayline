import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedEditorialWorkflowFixture, editorialWorkflowAt } from '../fixtures/editorial-workflow-fiction.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import type { State } from '../src/newsroom/model.ts';
import { AccessControl } from '../src/security/service.ts';
import { AssignedResourcePolicy, type ResourceAssignment, type ResourcePolicy } from '../src/security/resources.ts';
import { startInternalEditorialHTTP, type InternalEditorialHTTP, type InternalEditorialHTTPOptions } from '../src/security/http.ts';

const root = '/internal/operations';
const dataRoutes = ['overview', 'sources', 'source', 'stories', 'editions'] as const;
type Seed = Awaited<ReturnType<typeof seedEditorialWorkflowFixture>>;
type Context = Omit<Seed, 'policy'> & { repository: JsonRepository; policy: ResourcePolicy; server: InternalEditorialHTTP;
  clock: { now: string }; setPolicy(assignments: ResourceAssignment[]): void };
async function fixture(action: (context: Context) => Promise<void>, options: {
  ui?: boolean; environment?: string; repositoryFor?: (file: string) => JsonRepository;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline operations http '));
  let server: InternalEditorialHTTP | null = null;
  const oldEnvironment = process.env.NODE_ENV;
  try {
    if (options.environment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = options.environment;
    const repository = options.repositoryFor?.(join(directory, 'fictional.json')) ?? new JsonRepository(join(directory, 'fictional.json'));
    const seeded = await seedEditorialWorkflowFixture(repository), clock = { now: editorialWorkflowAt };
    const access = new AccessControl(repository, { verifier: seeded.verifier, clock: () => clock.now });
    let current = seeded.resourcePolicy;
    const policy: ResourcePolicy = { authorize: (...args) => current.authorize(...args), sourceReadRevision: () => current.sourceReadRevision() };
    server = await startInternalEditorialHTTP({ enabled: true, operationsUI: options.ui ?? true, mode: 'development', repository, access, policy });
    assert.ok(server);
    await action({ ...seeded, access, policy, repository, server, clock,
      setPolicy: assignments => { current = new AssignedResourcePolicy(assignments); } });
  } finally {
    await server?.close(); await rm(directory, { recursive: true, force: true });
    if (oldEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnvironment;
  }
}
type Reply = { status: number; headers: IncomingMessage['headers']; text: string; body: unknown };
function req(c: Context, path: string, token?: string, body: unknown = {}, options: {
  method?: string; headers?: OutgoingHttpHeaders; raw?: string;
} = {}): Promise<Reply> {
  const method = options.method ?? 'POST', serialized = options.raw ?? JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const origin = new URL(c.server.origin);
    const request = httpRequest({ hostname: origin.hostname, port: origin.port, path: path.startsWith('/') ? path : `${root}/${path}`,
      method, agent: false, headers: {
        ...(method === 'GET' || method === 'HEAD' ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized) }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers,
      },
    }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let body: unknown = null;
        if (text && response.headers['content-type']?.startsWith('application/json')) body = JSON.parse(text);
        resolve({ status: response.statusCode!, headers: response.headers, text, body }); });
    });
    request.on('error', reject); request.end(method === 'GET' || method === 'HEAD' ? undefined : serialized);
  });
}
function secured(reply: Reply) {
  assert.equal(reply.headers['cache-control'], 'no-store, max-age=0'); assert.equal(reply.headers.pragma, 'no-cache');
  assert.equal(reply.headers['x-content-type-options'], 'nosniff'); assert.equal(reply.headers['referrer-policy'], 'no-referrer');
  assert.equal(reply.headers['access-control-allow-origin'], undefined); assert.equal(reply.headers['set-cookie'], undefined);
  assert.ok(Buffer.byteLength(reply.text) <= 262_144);
}
function denied(reply: Reply, status: number) {
  assert.equal(reply.status, status, reply.text); secured(reply);
  if (reply.text) {
    assert.deepEqual(Object.keys(reply.body as object).sort(), ['error', 'requestId']);
    assert.doesNotMatch(reply.text, /url-|editorial-workflow|private|actorId|identityId|sessionId|providerMetadata|credential|policy|audit/i);
  }
}
function successful(reply: Reply): Record<string, unknown> {
  assert.equal(reply.status, 200, reply.text); secured(reply); assert.ok(reply.body && typeof reply.body === 'object');
  assert.doesNotMatch(reply.text, /"(?:credential|sessionId|sessionRef|actorId|providerMetadata|securityAudit|authenticatedActions|identityId|providerKey|rawPayload)"/);
  const body = reply.body as Record<string, unknown>; assert.equal(body.asOf, editorialWorkflowAt);
  assert.ok(typeof body.validForMs === 'number' && body.validForMs > 0 && body.validForMs <= 1500);
  return body;
}
const sourceBody = (c: Context, route: typeof dataRoutes[number]) => route === 'source' ? { sourceId: c.sourceIds.pending } : {};

test('operations opt-in does not bind a listener when the existing listener is disabled', async () => {
  const disabled = await startInternalEditorialHTTP({ operationsUI: true } as InternalEditorialHTTPOptions);
  assert.equal(disabled, null);
});

test('the existing listener exposes no operations shell or projections without their separate opt-in', async () => fixture(async c => {
  for (const path of [root, `${root}/operations.css`, `${root}/operations.js`]) denied(await req(c, path, undefined, {}, { method: 'GET' }), 404);
  for (const route of dataRoutes) denied(await req(c, route, c.accounts.editor.credential, sourceBody(c, route)), 404);
  assert.equal((await req(c, '/internal/principal', c.accounts.editor.credential, {}, { method: 'GET' })).status, 200);
}, { ui: false }));

test('staging never exposes the operations shell or data despite the development listener opt-in', async () => fixture(async c => {
  denied(await req(c, root, undefined, {}, { method: 'GET' }), 404);
  for (const route of dataRoutes) denied(await req(c, route, c.accounts.editor.credential, sourceBody(c, route)), 404);
}, { environment: 'staging' }));

test('production and nondevelopment modes cannot start an operations listener', async () => fixture(async c => {
  const options = { enabled: true, operationsUI: true, repository: c.repository, access: c.access, policy: c.policy };
  for (const mode of ['production', 'test'] as const) await assert.rejects(startInternalEditorialHTTP({ ...options, mode }), /INTERNAL_LISTENER_DISABLED/);
  const old = process.env.NODE_ENV;
  try { process.env.NODE_ENV = 'production'; await assert.rejects(startInternalEditorialHTTP({ ...options, mode: 'development' }), /INTERNAL_LISTENER_DISABLED/); }
  finally { if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old; }
}));

test('allowlisted static shell assets have strict CSP and no embedded credential or private content', async () => fixture(async c => {
  for (const [path, type] of [[root, 'text/html'], [`${root}/operations.css`, 'text/css'], [`${root}/operations.js`, 'text/javascript']]) {
    const reply = await req(c, path, undefined, {}, { method: 'GET' }); assert.equal(reply.status, 200, reply.text); secured(reply);
    assert.ok(reply.headers['content-type']?.startsWith(type)); assert.equal(Number(reply.headers['content-length']), Buffer.byteLength(reply.text));
    const csp = String(reply.headers['content-security-policy']);
    for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(directive));
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|data:|\*/);
    for (const account of Object.values(c.accounts)) { assert.equal(reply.text.includes(account.credential), false); assert.equal(reply.text.includes(account.identity.id), false); }
    for (const id of Object.values(c.sourceIds)) assert.equal(reply.text.includes(id), false);
    assert.equal(reply.text.includes(c.humanStory.headline), false);
    const head = await req(c, path, undefined, {}, { method: 'HEAD' }); assert.equal(head.status, 200); secured(head);
    assert.equal(head.text, ''); assert.equal(head.headers['content-length'], reply.headers['content-length']);
  }
}));

test('the static allowlist refuses traversal source files directory listings and arbitrary downloads', async () => fixture(async c => {
  for (const path of [`${root}/`, `${root}/index.html`, `${root}/../http.ts`, `${root}/operations.js.map`,
    `${root}/../../src/security/http.ts`, '/src/security/http.ts', '/internal/operations.json', '/internal/session/create', '/internal/login']) {
    denied(await req(c, path, undefined, {}, { method: 'GET' }), 404);
  }
  for (const path of [`${root}%2Foperations.js`, `${root}/%2e%2e/http.ts`, `${root}\\operations.js`, `${root}?token=private`, `${root}/overview?role=EDITOR`]) {
    denied(await req(c, path, undefined, {}, { method: 'GET' }), 400);
  }
}));

test('operations asset and data requests retain strict loopback Host Origin cookie forwarding and cross-site fences', async () => fixture(async c => {
  for (const headers of [{ Host: 'localhost' }, { Origin: 'https://private.example.test' }, { Origin: 'null' },
    { Cookie: 'private=sentinel' }, { Forwarded: 'for=127.0.0.1' }, { 'X-Forwarded-Host': '127.0.0.1' },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Access-Control-Request-Method': 'POST' }]) {
    denied(await req(c, root, undefined, {}, { method: 'GET', headers }), 403);
    denied(await req(c, 'sources', c.accounts.editor.credential, {}, { headers }), 403);
  }
  successful(await req(c, 'sources', c.accounts.editor.credential, {}, { headers: { Origin: c.server.origin, 'Sec-Fetch-Site': 'same-origin' } }));
}));

test('operations assets reject writes and privileged projections reject GET HEAD OPTIONS and PUT', async () => fixture(async c => {
  for (const path of [root, `${root}/operations.css`, `${root}/operations.js`]) denied(await req(c, path, c.accounts.editor.credential), 405);
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT']) for (const route of dataRoutes) {
    denied(await req(c, route, c.accounts.editor.credential, sourceBody(c, route), { method }), 405);
  }
}));

test('each operations projection requires an explicitly supplied current bearer credential', async () => fixture(async c => {
  for (const route of dataRoutes) denied(await req(c, route, undefined, sourceBody(c, route)), 401);
  const original = c.accounts.editor.credential;
  for (const token of ['a.b.c', original.slice(0, -4) + 'xxxx', c.verifier.issue({ ...c.accounts.editor.claims, sessionId: randomUUID() })]) {
    denied(await req(c, 'sources', token), 401);
  }
  denied(await req(c, 'sources', undefined, {}, { headers: { Authorization: 'Basic private-sentinel' } }), 401);
}));

test('overview stories and editions accept only an empty JSON object', async () => fixture(async c => {
  for (const route of ['overview', 'stories', 'editions']) for (const body of [null, [], true, 1, '', { role: 'MANAGING_EDITOR' }, { limit: 1 }]) {
    denied(await req(c, route, c.accounts.editor.credential, body), 400);
  }
}));

test('source inspection accepts only an exact canonical managed source identity', async () => fixture(async c => {
  for (const body of [{}, [], { sourceId: c.sourceIds.pending, role: 'EDITOR' }, { sourceId: 'private-source' },
    { sourceId: 'url-' + 'A'.repeat(64) }, { sourceId: 3 }, { sourceId: c.sourceIds.pending, revision: 'a'.repeat(64) }]) {
    denied(await req(c, 'source', c.accounts.editor.credential, body), 400);
  }
}));

test('source list accepts only the strict bounded existing queue query schema', async () => fixture(async c => {
  for (const body of [null, [], { role: 'EDITOR' }, { view: 'PRIVATE' }, { view: null }, { limit: 0 }, { limit: 51 },
    { limit: 1.5 }, { limit: '1' }, { cursor: '' }, { cursor: 'x'.repeat(1025) }, { cursor: 'not.a.cursor' }]) {
    denied(await req(c, 'sources', c.accounts.editor.credential, body), 400);
  }
  for (const body of [{}, { view: 'UNRESOLVED', limit: 1 }, { view: 'BLOCKED', limit: 50 }]) successful(await req(c, 'sources', c.accounts.editor.credential, body));
}));

test('operations pagination cursors remain bound to the exact current identity and assignment epoch', async () => fixture(async c => {
  const page = successful(await req(c, 'sources', c.accounts.editor.credential, { limit: 1 })).page as { nextCursor: string | null };
  assert.ok(page.nextCursor);
  successful(await req(c, 'sources', c.accounts.editor.credential, { limit: 1, cursor: page.nextCursor }));
  denied(await req(c, 'sources', c.accounts.managing.credential, { limit: 1, cursor: page.nextCursor }), 409);
  c.setPolicy(c.assignments);
  denied(await req(c, 'sources', c.accounts.editor.credential, { limit: 1, cursor: page.nextCursor }), 409);
}));

test('operations request bodies preserve JSON framing media type prototype and size limits', async () => fixture(async c => {
  denied(await req(c, 'sources', c.accounts.editor.credential, {}, { headers: { 'Content-Type': 'text/plain' } }), 415);
  denied(await req(c, 'sources', c.accounts.editor.credential, {}, { raw: '{' }), 400);
  denied(await req(c, 'sources', c.accounts.editor.credential, {}, { raw: '{"__proto__":{}}' }), 400);
  denied(await req(c, 'sources', c.accounts.editor.credential, {}, { raw: '{"constructor":{}}' }), 400);
  denied(await req(c, 'sources', c.accounts.editor.credential, {}, { raw: ' '.repeat(16_385) }), 413);
  denied(await req(c, root, undefined, {}, { method: 'GET', headers: { 'Content-Length': '2' } }), 400);
}));

test('a stalled operations JSON body is denied within the existing one-second deadline', { timeout: 5000 }, async () => fixture(async c => {
  const url = new URL(c.server.origin);
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(url.port), '127.0.0.1'); let result = '';
    socket.setTimeout(3500, () => { socket.destroy(); reject(Error('Body timeout guard did not complete')); });
    socket.on('error', reject); socket.on('data', bytes => { result += bytes.toString(); }); socket.on('end', () => resolve(result));
    socket.on('connect', () => socket.write(`POST ${root}/sources HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${c.accounts.editor.credential}\r\nContent-Type: application/json\r\nContent-Length: 12\r\n\r\n{`));
  });
  assert.match(response, /^HTTP\/1\.1 408 /); assert.match(response, /REQUEST_TIMEOUT/);
  assert.doesNotMatch(response, /editorial-workflow|url-|credential|sessionId/);
}));

test('authorized operations reads expose assigned source metadata without mutating the repository', async () => fixture(async c => {
  const before = await readFile(c.repository.file, 'utf8');
  for (const route of dataRoutes) {
    const reply = await req(c, route, c.accounts.editor.credential, sourceBody(c, route)); successful(reply);
    assert.equal(reply.text.includes(c.sourceIds.other), false); assert.equal(reply.text.includes('/other'), false);
    assert.equal(reply.text.includes(c.accounts.managing.identity.id), false);
  }
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
}));

test('an assigned-source list and detail never authorize resource substitution', async () => fixture(async c => {
  successful(await req(c, 'source', c.accounts.editor.credential, { sourceId: c.sourceIds.pending }));
  for (const id of [c.sourceIds.other, 'url-' + 'f'.repeat(64)]) denied(await req(c, 'source', c.accounts.editor.credential, { sourceId: id }), 403);
  c.setPolicy(c.assignments.filter(row => !(row.identityId === c.accounts.editor.identity.id && row.permission === 'SOURCE_READ' && row.id === c.sourceIds.pending)));
  denied(await req(c, 'source', c.accounts.editor.credential, { sourceId: c.sourceIds.pending }), 403);
  const page = await req(c, 'sources', c.accounts.editor.credential); successful(page); assert.equal(page.text.includes(c.sourceIds.pending), false);
}));

test('reporter and administrator accounts do not inherit source metadata visibility from assignments', async () => fixture(async c => {
  const before = await readFile(c.repository.file, 'utf8');
  for (const account of [c.accounts.reporter, c.accounts.admin]) for (const route of ['sources', 'source']) {
    denied(await req(c, route, account.credential, route === 'source' ? { sourceId: c.sourceIds.pending } : {}), 403);
  }
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
}));

test('overview exposes only the current account roles and empty unauthorized story or edition lists', async () => fixture(async c => {
  for (const account of [c.accounts.reporter, c.accounts.admin]) {
    const overview = successful(await req(c, 'overview', account.credential)); assert.deepEqual(overview.roles, account.identity.roles);
    assert.deepEqual(successful(await req(c, 'stories', account.credential)).stories, []);
    assert.deepEqual(successful(await req(c, 'editions', account.credential)).editions, []);
  }
}));

test('story and edition projections require exact resources and every retained evidence dependency', async () => fixture(async c => {
  const token = c.accounts.editor.credential;
  await c.resolvePending();
  const sources = await c.sourceHandoff.inspect(token, [c.sourceIds.pending]);
  let story = await c.sourceHandoff.prepare(token, { sources, story: c.humanStory });
  for (const status of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW'] as const) {
    const reviewed = await c.editorial.reviewStory(token, story.id, story.version, status);
    story = { id: reviewed.id, version: reviewed.version, status: 'INGESTED' };
  }
  const approved = await c.editorial.approveStory(c.accounts.managing.credential, story.id, story.version);
  const edition = await c.editorial.assembleEdition(token, { date: '2026-06-01', timezone: 'UTC',
    placements: [{ storyId: approved.id, storyVersion: approved.version, section: 'TOP_STORIES', featured: true }] });
  const assignments: ResourceAssignment[] = [...c.assignments, ...(['EDITION_ASSEMBLE', 'EDITION_REVIEW'] as const).map(permission => ({
    identityId: c.accounts.editor.identity.id, kind: 'EDITION' as const, id: edition.id, permission }))];
  c.setPolicy(assignments);
  const stories = await req(c, 'stories', token), editions = await req(c, 'editions', token);
  successful(stories); successful(editions);
  assert.ok(stories.text.includes(c.humanStory.headline)); assert.ok(editions.text.includes(edition.id));
  assert.doesNotMatch(stories.text, /sourceHandoff|reviewerDecisions|proposedBy|audit|actorId/);
  c.setPolicy(assignments.filter(row => !(row.identityId === c.accounts.editor.identity.id && row.permission === 'SOURCE_READ' && row.id === c.sourceIds.proof)));
  assert.deepEqual(successful(await req(c, 'stories', token)).stories, []);
  assert.deepEqual(successful(await req(c, 'editions', token)).editions, []);
  const state = await c.repository.read(); assert.equal(state.editions.at(-1)!.status, 'ASSEMBLING');
  assert.equal(state.revisions.some(row => row.status === 'PUBLISHED'), false);
}));

test('concurrent operations reads are deterministic and create no domain audit or grant records', async () => fixture(async c => {
  const before = await readFile(c.repository.file, 'utf8');
  const replies = await Promise.all(Array.from({ length: 6 }, () => req(c, 'sources', c.accounts.editor.credential)));
  replies.forEach(successful); for (const reply of replies) assert.deepEqual(reply.body, replies[0].body);
  // Await lock cleanup, which can finish immediately after the HTTP response has arrived.
  await c.repository.readGuarded(() => undefined);
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
}));

for (const variant of ['revoked', 'expired', 'disabled', 'rotated', 'demoted'] as const) {
  test(`operations data uses current ${variant} identity or session authority`, async () => fixture(async c => {
    successful(await req(c, 'sources', c.accounts.editor.credential));
    if (variant === 'expired') c.clock.now = c.accounts.editor.claims.expiresAt;
    else await c.repository.transact(state => {
      const identity = state.identities.find(row => row.id === c.accounts.editor.identity.id)!;
      if (variant === 'revoked') state.sessions.find(row => row.id === c.accounts.editor.claims.sessionId)!.revokedAt = editorialWorkflowAt;
      else if (variant === 'disabled') identity.status = 'DISABLED';
      else if (variant === 'rotated') { identity.credentialVersion++; identity.revision++; }
      else { identity.roles = ['REPORTER']; identity.revision++; }
    });
    denied(await req(c, 'sources', c.accounts.editor.credential), variant === 'demoted' ? 403 : 401);
  }));
}

test('malformed asynchronous or nonvoid resource policies cannot become successful operations reads', async () => fixture(async c => {
  const original = c.policy.authorize;
  try {
    for (const decide of [() => true, () => false, () => Promise.resolve(), () => Promise.reject(Error('private-policy-sentinel'))]) {
      c.policy.authorize = decide as ResourcePolicy['authorize'];
      denied(await req(c, 'sources', c.accounts.editor.credential), 403);
    }
  } finally { c.policy.authorize = original; }
}));

test('operations denial and unexpected storage errors never reflect private paths or domain payloads', async () => fixture(async c => {
  const read = c.repository.read.bind(c.repository);
  c.repository.read = async () => { throw Error('/private/repository token=private-sentinel providerPayload'); };
  try { denied(await req(c, 'sources', c.accounts.editor.credential), 503); }
  finally { c.repository.read = read; }
}));

for (const route of dataRoutes) test(`policy replacement during final ${route} serialization withholds the whole operations response`, async () => fixture(async c => {
  const stringify = JSON.stringify, seen = new WeakSet<object>(); let changed = false;
  JSON.stringify = function(value: unknown, ...args: unknown[]) {
    const serialized = Reflect.apply(stringify, JSON, [value, ...args]);
    if (value && typeof value === 'object' && Object.hasOwn(value, 'asOf') && Object.hasOwn(value, 'validForMs')) {
      if (seen.has(value) && !changed) { changed = true; c.setPolicy(c.assignments); } else seen.add(value);
    }
    return serialized;
  } as typeof JSON.stringify;
  try { denied(await req(c, route, c.accounts.editor.credential, sourceBody(c, route)), 403); assert.equal(changed, true); }
  finally { JSON.stringify = stringify; }
}));

test('source retention expiry during final operations serialization withholds the complete leased detail', async () => fixture(async c => {
  await c.repository.transact(state => { state.quarantine.find(row => row.sourceId === c.sourceIds.pending)!.deleteAt = '2026-06-01T12:00:00.500Z'; });
  const stringify = JSON.stringify, seen = new WeakSet<object>(); let expired = false;
  JSON.stringify = function(value: unknown, ...args: unknown[]) {
    const serialized = Reflect.apply(stringify, JSON, [value, ...args]);
    if (value && typeof value === 'object' && Object.hasOwn(value, 'asOf') && Object.hasOwn(value, 'validForMs')) {
      if (seen.has(value) && !expired) { expired = true; c.clock.now = '2026-06-01T12:00:00.600Z'; } else seen.add(value);
    }
    return serialized;
  } as typeof JSON.stringify;
  try { denied(await req(c, 'source', c.accounts.editor.credential, { sourceId: c.sourceIds.pending }), 409); assert.equal(expired, true); }
  finally { JSON.stringify = stringify; }
}));

test('session expiration during final overview serialization withholds even an otherwise public role summary', async () => fixture(async c => {
  const stringify = JSON.stringify, seen = new WeakSet<object>(); let expired = false;
  JSON.stringify = function(value: unknown, ...args: unknown[]) {
    const serialized = Reflect.apply(stringify, JSON, [value, ...args]);
    if (value && typeof value === 'object' && Object.hasOwn(value, 'asOf') && Object.hasOwn(value, 'validForMs')) {
      if (seen.has(value) && !expired) { expired = true; c.clock.now = c.accounts.editor.claims.expiresAt; } else seen.add(value);
    }
    return serialized;
  } as typeof JSON.stringify;
  try { denied(await req(c, 'overview', c.accounts.editor.credential), 401); assert.equal(expired, true); }
  finally { JSON.stringify = stringify; }
}));

test('forged interface actions still require existing independent source and story authorization', async () => fixture(async c => {
  const { securityAudit: beforeAudit, ...before } = await c.repository.read();
  denied(await req(c, '/internal/source-handoff/inspect', c.accounts.reporter.credential, { sourceIds: [c.sourceIds.pending] }), 403);
  denied(await req(c, '/internal/source-review/confirm', c.accounts.editor.credential, { sourceId: c.sourceIds.pending,
    revision: 'a'.repeat(64), reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.proof] }), 403);
  denied(await req(c, `/internal/stories/${c.humanStory.id}/approve`, c.accounts.editor.credential, { version: 1 }), 403);
  const { securityAudit: afterAudit, ...after } = await c.repository.read();
  assert.deepEqual(after, before);
  assert.ok(afterAudit.length >= beforeAudit.length); // Existing protected mutations may audit their denials.
}));

for (const route of dataRoutes) test(`same-listener revocation fences ${route} before repository revocation can commit`, { timeout: 7000 }, async () => {
  let reached!: () => void, release!: () => void, revoking!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const revocationStarted = new Promise<void>(resolve => { revoking = resolve; });
  class PausedRepository extends JsonRepository {
    armed = false; lockedRead = false;
    override async readGuarded<T>(read: (state: State) => T): Promise<T> {
      this.lockedRead = true;
      try { return await super.readGuarded(read); } finally { this.lockedRead = false; }
    }
    override async read(): Promise<State> {
      const state = await super.read();
      if (this.armed && this.lockedRead) { this.armed = false; reached(); await gate; }
      return state;
    }
    override async transactGuarded<T>(change: (state: State) => T, guard: (state: State) => void): Promise<T> {
      if (this.lockedRead) revoking();
      return super.transactGuarded(change, guard);
    }
  }
  await fixture(async c => {
    (c.repository as PausedRepository).armed = true;
    const reading = req(c, route, c.accounts.editor.credential, sourceBody(c, route));
    await waiting;
    const revocation = req(c, '/internal/session/revoke', c.accounts.editor.credential, {});
    await revocationStarted; release();
    const [result, revoked] = await Promise.all([reading, revocation]);
    denied(result, 401); assert.equal(revoked.status, 200);
  }, { repositoryFor: file => new PausedRepository(file) });
});
