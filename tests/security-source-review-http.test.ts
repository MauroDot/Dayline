import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { seedSourceReviewFixture, sourceReviewFixtureAt } from '../fixtures/source-review-fiction.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import type { State } from '../src/newsroom/model.ts';
import { AccessControl } from '../src/security/service.ts';
import { AssignedResourcePolicy, type ResourceAssignment, type ResourcePolicy } from '../src/security/resources.ts';
import type { Permission } from '../src/security/types.ts';
import { startInternalEditorialHTTP, type InternalEditorialHTTP } from '../src/security/http.ts';

const route = '/internal/source-review/';
type Seed = Awaited<ReturnType<typeof seedSourceReviewFixture>>;
type Context = Omit<Seed, 'policy'> & { policy: ResourcePolicy; server: InternalEditorialHTTP; repository: JsonRepository; clock: { now: string };
  allAssignments: ResourceAssignment[]; setPolicy(assignments: ResourceAssignment[]): void };
async function fixture(action: (context: Context) => Promise<void>, repositoryFor: (path: string) => JsonRepository = file => new JsonRepository(file)) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-review-http-'));
  let server: InternalEditorialHTTP | null = null;
  try {
    const repository = repositoryFor(join(directory, 'fictional.json'));
    const seeded = await seedSourceReviewFixture(repository);
    const clock = { now: sourceReviewFixtureAt };
    const access = new AccessControl(repository, { verifier: seeded.verifier, clock: () => clock.now });
    const permissions: Permission[] = ['SOURCE_READ', 'SOURCE_REVIEW', 'SOURCE_RESOLVE', 'SOURCE_HOLD', 'SOURCE_RELEASE'];
    const allAssignments: ResourceAssignment[] = Object.values(seeded.accounts).flatMap(account => Object.values(seeded.sourceIds)
      .flatMap(id => permissions.map(permission => ({ identityId: account.identity.id, kind: 'SOURCE' as const, id, permission }))));
    let current = new AssignedResourcePolicy(allAssignments);
    const policy: ResourcePolicy = { authorize: (...args) => current.authorize(...args), sourceReadRevision: () => current.sourceReadRevision() };
    server = await startInternalEditorialHTTP({ enabled: true, mode: 'development', repository, access, policy });
    assert.ok(server);
    await action({ ...seeded, access, policy, server, repository, clock, allAssignments,
      setPolicy: assignments => { current = new AssignedResourcePolicy(assignments); } });
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
}
type Reply = { status: number; headers: IncomingMessage['headers']; text: string; body: Record<string, unknown> };
function req(c: Context, action: string, token?: string, body: unknown = { sourceId: c.sourceIds.pending }, options: { method?: string; headers?: OutgoingHttpHeaders; raw?: string } = {}): Promise<Reply> {
  const serialized = options.raw ?? JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(c.server.origin + (action.startsWith('/') ? action : route + action), { method: options.method ?? 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized),
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode!, headers: response.headers, text, body: text ? JSON.parse(text) : {} }); });
    });
    request.on('error', reject); request.end(serialized);
  });
}
function safeSummary(reply: Reply, expected?: string): Record<string, unknown> {
  assert.equal(reply.status, 200, reply.text);
  assert.deepEqual(Object.keys(reply.body).sort(), ['blocked', 'independentlyResolved', 'pendingProposal', 'reviewAllowed', 'reviewRevision', 'revision', 'status']);
  assert.match(String(reply.body.revision), /^[a-f0-9]{64}$/);
  assert.equal(typeof reply.body.reviewRevision, 'number');
  if (expected) assert.equal(reply.body.status, expected);
  assert.ok(Buffer.byteLength(reply.text, 'utf8') <= 262_144);
  assert.equal(reply.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(reply.headers['pragma'], 'no-cache');
  assert.equal(reply.headers['x-content-type-options'], 'nosniff');
  assert.equal(reply.headers['access-control-allow-origin'], undefined);
  assert.doesNotMatch(reply.text, /url-|sourceId|source-queue\.example|Fictional|actor|reviewer|evidence|provider|credential|session|audit/i);
  return reply.body;
}
function denied(reply: Reply, status: number) {
  assert.equal(reply.status, status, reply.text);
  if (reply.text) {
    assert.deepEqual(Object.keys(reply.body).sort(), ['error', 'requestId']);
    assert.doesNotMatch(reply.text, /url-|sourceId|source-queue\.example|Fictional|private|actor|evidence|provider|credential|session|audit/i);
  }
  assert.equal(reply.headers['cache-control'], 'no-store, max-age=0');
}
function input(c: Context, revision: unknown, reasonCode = 'INITIAL_REVIEW') {
  return { sourceId: c.sourceIds.pending, revision, reasonCode, evidenceReferences: [c.sourceIds.original] };
}
async function inspect(c: Context, token = c.accounts.editor.credential, sourceId = c.sourceIds.pending) {
  return safeSummary(await req(c, 'inspect', token, { sourceId }));
}
async function begun(c: Context, token = c.accounts.editor.credential) {
  const initial = await inspect(c, token);
  return safeSummary(await req(c, 'begin', token, input(c, initial.revision)), 'UNDER_REVIEW');
}
async function proposed(c: Context, token = c.accounts.editor.credential) {
  const current = await begun(c, token);
  return safeSummary(await req(c, 'propose', token, { ...input(c, current.revision, 'EVIDENCE_SUPPORTED'), classification: 'ORIGINAL', originId: null }), 'PROPOSED');
}

test('source review HTTP inspects only assigned metadata status without writes or private source fields', async () => fixture(async c => {
  const before = await readFile(c.repository.file, 'utf8');
  const result = safeSummary(await req(c, 'inspect', c.accounts.editor.credential), 'UNREVIEWED');
  assert.equal(result.pendingProposal, false); assert.equal(result.independentlyResolved, false);
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
}));

test('source review HTTP proposal alone preserves quarantine and independent confirmation resolves atomically', async () => fixture(async c => {
  const before = await c.repository.read();
  const proposal = await proposed(c);
  const pending = await c.repository.read();
  assert.ok(pending.quarantine.some(row => row.sourceId === c.sourceIds.pending));
  assert.equal(pending.sources.some(row => row.id === c.sourceIds.pending), false);
  assert.equal(proposal.pendingProposal, true); assert.equal(proposal.independentlyResolved, false);
  const confirmed = safeSummary(await req(c, 'confirm', c.accounts.managing.credential, input(c, proposal.revision, 'EVIDENCE_SUPPORTED')), 'RESOLVED');
  assert.equal(confirmed.independentlyResolved, true); assert.equal(confirmed.pendingProposal, false);
  const after = await c.repository.read();
  assert.ok(after.sources.some(row => row.id === c.sourceIds.pending));
  assert.equal(after.quarantine.some(row => row.sourceId === c.sourceIds.pending), false);
  const initialRecord = before.quarantine.find(row => row.sourceId === c.sourceIds.pending)!;
  const finalRecord = after.managedSources.find(row => row.sourceId === c.sourceIds.pending)!;
  assert.equal(finalRecord.deleteAt, initialRecord.deleteAt); assert.deepEqual(finalRecord.policy, initialRecord.policy);
  assert.deepEqual(after.revisions, before.revisions); assert.deepEqual(after.approvals, before.approvals);
  assert.deepEqual(after.editions, before.editions);
}));

test('source review HTTP enforces independent authenticated principals even for managing editors', async () => fixture(async c => {
  const proposal = await proposed(c, c.accounts.managing.credential);
  const before = await readFile(c.repository.file, 'utf8');
  denied(await req(c, 'confirm', c.accounts.managing.credential, input(c, proposal.revision, 'EVIDENCE_SUPPORTED')), 403);
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
  safeSummary(await req(c, 'confirm', c.accounts.confirming.credential, input(c, proposal.revision, 'EVIDENCE_SUPPORTED')), 'RESOLVED');
}));

test('reporter and administrator cannot inspect or review even with exact configured source assignments', async () => fixture(async c => {
  for (const account of [c.accounts.reporter, c.accounts.admin]) {
    denied(await req(c, 'inspect', account.credential), 403);
    denied(await req(c, 'begin', account.credential, input(c, 'a'.repeat(64))), 403);
    denied(await req(c, 'hold', account.credential, input(c, 'a'.repeat(64), 'REVIEW_HOLD')), 403);
  }
}));

test('editor cannot accept a different reviewer proposal or release a hold without resolution role', async () => fixture(async c => {
  const proposal = await proposed(c, c.accounts.managing.credential);
  denied(await req(c, 'confirm', c.accounts.editor.credential, input(c, proposal.revision, 'EVIDENCE_SUPPORTED')), 403);
  denied(await req(c, 'reject', c.accounts.editor.credential, input(c, proposal.revision, 'INSUFFICIENT_EVIDENCE')), 403);
  const held = safeSummary(await req(c, 'hold', c.accounts.editor.credential, input(c, proposal.revision, 'REVIEW_HOLD')), 'ON_HOLD');
  denied(await req(c, 'release', c.accounts.editor.credential, input(c, held.revision, 'HOLD_RELEASED')), 403);
  const released = safeSummary(await req(c, 'release', c.accounts.managing.credential, input(c, held.revision, 'HOLD_RELEASED')), 'UNDER_REVIEW');
  assert.equal(released.pendingProposal, false);
}));

test('source review HTTP requires both exact source inspection and exact action assignments', async () => fixture(async c => {
  const revision = (await inspect(c)).revision;
  const token = c.accounts.editor.credential, identity = c.accounts.editor.identity.id;
  c.setPolicy(c.allAssignments.filter(row => !(row.identityId === identity && row.id === c.sourceIds.pending && row.permission === 'SOURCE_REVIEW')));
  safeSummary(await req(c, 'inspect', token));
  denied(await req(c, 'begin', token, input(c, revision)), 403);
  c.setPolicy(c.allAssignments.filter(row => !(row.identityId === identity && row.id === c.sourceIds.pending && row.permission === 'SOURCE_READ')));
  denied(await req(c, 'inspect', token), 403);
  denied(await req(c, 'begin', token, input(c, revision)), 403);
}));

test('source review HTTP cannot inspect another source or inaccessible evidence under a target grant', async () => fixture(async c => {
  const token = c.accounts.editor.credential, identity = c.accounts.editor.identity.id;
  const initial = await inspect(c);
  c.setPolicy(c.allAssignments.filter(row => row.identityId !== identity || row.id === c.sourceIds.pending));
  denied(await req(c, 'inspect', token, { sourceId: c.sourceIds.original }), 403);
  denied(await req(c, 'begin', token, input(c, initial.revision)), 403);
}));

test('source review HTTP rejects duplicate and stale revisions without partial mutations or receipts', async () => fixture(async c => {
  const initial = await inspect(c);
  safeSummary(await req(c, 'begin', c.accounts.editor.credential, input(c, initial.revision)), 'UNDER_REVIEW');
  const before = await readFile(c.repository.file, 'utf8');
  denied(await req(c, 'begin', c.accounts.editor.credential, input(c, initial.revision)), 409);
  denied(await req(c, 'propose', c.accounts.editor.credential, { ...input(c, initial.revision, 'EVIDENCE_SUPPORTED'), classification: 'ORIGINAL', originId: null }), 409);
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
}));

test('source review HTTP rejects forged actor time policy rights and authority fields without reflection', async () => fixture(async c => {
  const revision = (await inspect(c)).revision;
  for (const extra of [{ actorId: c.accounts.managing.identity.id }, { actorAssertion: 'private-reviewer' }, { at: sourceReviewFixtureAt },
    { policy: { publicRedistribution: true } }, { deleteAt: '2030-01-01T00:00:00.000Z' }, { authorized: true }, { repository: '/private/source.json' }]) {
    denied(await req(c, 'begin', c.accounts.editor.credential, { ...input(c, revision), ...extra }), 400);
  }
  const state = await c.repository.read(); assert.equal(state.sourceReviews?.length ?? 0, 0);
}));

test('source review HTTP rejects malformed missing duplicate and oversized evidence or target tokens', async () => fixture(async c => {
  const valid = input(c, (await inspect(c)).revision);
  for (const patch of [{ evidenceReferences: [] }, { evidenceReferences: [c.sourceIds.original, c.sourceIds.original] },
    { evidenceReferences: ['private-evidence'] }, { evidenceReferences: new Array(17).fill(c.sourceIds.original) },
    { evidenceReferences: null }, { revision: 'stale' }, { sourceId: 'https://private.example.test/path' },
    { sourceId: '/private/repository.json' }, { reasonCode: 'private arbitrary prose' }]) {
    denied(await req(c, 'begin', c.accounts.editor.credential, { ...valid, ...patch }), 400);
  }
  denied(await req(c, 'begin', c.accounts.editor.credential, { sourceId: c.sourceIds.pending, revision: valid.revision, reasonCode: 'INITIAL_REVIEW' }), 400);
}));

test('source review HTTP enforces content framing, JSON schema and prototype-sensitive key rejection', async () => fixture(async c => {
  const token = c.accounts.editor.credential;
  for (const raw of ['null', '[]', 'true', '{"sourceId":', '{"sourceId":"' + c.sourceIds.pending + '","__proto__":{}}',
    '{"sourceId":"' + c.sourceIds.pending + '","nested":{"constructor":"private"}}']) {
    denied(await req(c, 'inspect', token, undefined, { raw }), 400);
  }
  denied(await req(c, 'inspect', token, undefined, { headers: { 'Content-Type': 'text/plain' } }), 415);
  denied(await req(c, 'inspect', token, undefined, { raw: ' '.repeat(16_385) }), 413);
}));

test('source review endpoints accept POST only and provide no source IDs in path or query', async () => fixture(async c => {
  const token = c.accounts.editor.credential;
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const result = await req(c, 'inspect', token, undefined, { method }); denied(result, 405);
    if (method === 'HEAD') assert.equal(result.text, '');
  }
  for (const action of ['inspect?sourceId=' + c.sourceIds.pending, 'inspect?token=private', 'inspect%3FsourceId=private']) denied(await req(c, action, token), 400);
  for (const action of [c.sourceIds.pending + '/confirm', 'publish', 'approve', 'mint', 'login']) denied(await req(c, action, token), 404);
}));

test('source review HTTP preserves Host Origin cookie forwarding and cross-site restrictions', async () => fixture(async c => {
  for (const headers of [{ Host: 'private.example.test' }, { Origin: 'https://private.example.test' }, { Origin: 'null' },
    { Cookie: 'private=sentinel' }, { 'X-Forwarded-Host': '127.0.0.1' }, { Forwarded: 'for=127.0.0.1' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    denied(await req(c, 'inspect', c.accounts.editor.credential, undefined, { headers }), 403);
  }
  safeSummary(await req(c, 'inspect', c.accounts.editor.credential, undefined, { headers: { Origin: c.server.origin, 'Sec-Fetch-Site': 'same-origin' } }));
}));

test('source review HTTP rejects missing invalid tampered unregistered expired and revoked sessions', async () => fixture(async c => {
  const token = c.accounts.editor.credential;
  for (const credential of [undefined, 'a.b.c', token.slice(0, -4) + 'xxxx',
    c.verifier.issue({ ...c.accounts.editor.claims, sessionId: randomUUID() })]) denied(await req(c, 'inspect', credential), 401);
  c.clock.now = c.accounts.editor.claims.expiresAt;
  denied(await req(c, 'inspect', token), 401);
  c.clock.now = sourceReviewFixtureAt;
  await c.access.invalidateSession(token);
  denied(await req(c, 'inspect', token), 401);
  denied(await req(c, 'begin', token, input(c, 'a'.repeat(64))), 401);
}));

test('source review HTTP uses current disabled demoted and rotated identity state', async () => fixture(async c => {
  await c.repository.transact(state => { state.identities.find(row => row.id === c.accounts.editor.identity.id)!.status = 'DISABLED'; });
  denied(await req(c, 'inspect', c.accounts.editor.credential), 401);
  await c.repository.transact(state => { const identity = state.identities.find(row => row.id === c.accounts.managing.identity.id)!; identity.roles = ['REPORTER']; identity.revision++; });
  denied(await req(c, 'inspect', c.accounts.managing.credential), 403);
  await c.repository.transact(state => { const identity = state.identities.find(row => row.id === c.accounts.confirming.identity.id)!; identity.credentialVersion++; identity.revision++; });
  denied(await req(c, 'inspect', c.accounts.confirming.credential), 401);
}));

test('source review HTTP rejection and withdrawal do not resolve or promote pending source metadata', async () => fixture(async c => {
  const proposal = await proposed(c);
  const rejected = safeSummary(await req(c, 'reject', c.accounts.managing.credential, input(c, proposal.revision, 'INSUFFICIENT_EVIDENCE')), 'REJECTED');
  assert.equal(rejected.independentlyResolved, false);
  const state = await c.repository.read();
  assert.ok(state.quarantine.some(row => row.sourceId === c.sourceIds.pending));
  assert.equal(state.sources.some(row => row.id === c.sourceIds.pending), false);
}));

test('source review HTTP withdraws a pending recommendation without granting source or story authority', async () => fixture(async c => {
  const proposal = await proposed(c);
  const withdrawn = safeSummary(await req(c, 'withdraw', c.accounts.editor.credential, input(c, proposal.revision, 'WITHDRAWN')), 'WITHDRAWN');
  assert.equal(withdrawn.independentlyResolved, false);
  const state = await c.repository.read();
  assert.ok(state.quarantine.some(row => row.sourceId === c.sourceIds.pending));
  assert.deepEqual(state.approvals, []); assert.deepEqual(state.editions, []);
}));

test('source review HTTP denied storage failures never reflect repository paths or private error payloads', async () => {
  let fail = false;
  await fixture(async c => {
    const current = await inspect(c);
    const before = await readFile(c.repository.file, 'utf8');
    fail = true;
    denied(await req(c, 'begin', c.accounts.editor.credential, input(c, current.revision)), 503);
    assert.equal(await readFile(c.repository.file, 'utf8'), before);
  }, file => new JsonRepository(file, { beforeCommit: () => { if (fail) throw Error('/private/repository.json token=private provider-payload'); } }));
});

test('source review HTTP withholds an expired pending recommendation and cannot confirm after retention ends', async () => fixture(async c => {
  await c.repository.transact(state => { state.quarantine.find(row => row.sourceId === c.sourceIds.pending)!.deleteAt = '2026-06-01T12:00:01.000Z'; });
  const proposal = await proposed(c);
  c.clock.now = '2026-06-01T12:00:02.000Z';
  const before = await readFile(c.repository.file, 'utf8');
  denied(await req(c, 'confirm', c.accounts.managing.credential, input(c, proposal.revision, 'EVIDENCE_SUPPORTED')), 400);
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
  const summary = safeSummary(await req(c, 'inspect', c.accounts.managing.credential), 'EXPIRED');
  assert.equal(summary.reviewAllowed, false); assert.equal(summary.pendingProposal, false);
}));

test('source review HTTP listener-local revocation fences an in-flight locked summary before repository revocation commits', { timeout: 5000 }, async () => {
  let reached!: () => void, release!: () => void, revoking!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
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
    const reading = req(c, 'inspect', c.accounts.editor.credential);
    await waiting;
    const revocation = req(c, '/internal/session/revoke', c.accounts.editor.credential, {});
    await revocationStarted; release();
    const [result, revoked] = await Promise.all([reading, revocation]);
    denied(result, 401); assert.equal(revoked.status, 200);
  }, file => new PausedRepository(file));
});

test('source review HTTP policy changes during final summary serialization deny before synchronous send', async () => fixture(async c => {
  const stringify = JSON.stringify, seen = new WeakSet<object>(); let changed = false;
  JSON.stringify = function (value: unknown, ...args: unknown[]) {
    const result = Reflect.apply(stringify, JSON, [value, ...args]);
    if (value && typeof value === 'object' && Object.hasOwn(value, 'reviewRevision') && Object.hasOwn(value, 'pendingProposal')) {
      if (seen.has(value) && !changed) { changed = true; c.setPolicy([]); }
      else seen.add(value);
    }
    return result;
  } as typeof JSON.stringify;
  try {
    denied(await req(c, 'inspect', c.accounts.editor.credential), 403); assert.equal(changed, true);
  } finally { JSON.stringify = stringify; }
}));

test('source review HTTP does not undo an accepted atomic mutation when later response inspection is denied', async () => {
  let afterCommit: (() => void) | undefined;
  class AcceptedRepository extends JsonRepository {
    override async transactGuarded<T>(change: (state: State) => T, guard: (state: State) => void): Promise<T> {
      const result = await super.transactGuarded(change, guard);
      const callback = afterCommit; afterCommit = undefined; callback?.();
      return result;
    }
  }
  await fixture(async c => {
    const initial = await inspect(c);
    afterCommit = () => c.setPolicy([]);
    denied(await req(c, 'begin', c.accounts.editor.credential, input(c, initial.revision)), 403);
    const state = await c.repository.read();
    assert.equal(state.sourceReviews?.length, 1); assert.equal(state.sourceReviews?.[0].status, 'UNDER_REVIEW');
    assert.equal(state.authenticatedActions.filter(row => row.resourceKind === 'SOURCE' && row.resourceId === c.sourceIds.pending).length, 1);
    c.setPolicy(c.allAssignments);
    const current = safeSummary(await req(c, 'inspect', c.accounts.editor.credential), 'UNDER_REVIEW');
    assert.notEqual(current.revision, initial.revision);
    denied(await req(c, 'begin', c.accounts.editor.credential, input(c, initial.revision)), 409);
    assert.equal((await c.repository.read()).sourceReviews?.length, 1);
  }, file => new AcceptedRepository(file));
});
