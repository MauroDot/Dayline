import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { seedSecurityFixture, securityAt } from '../fixtures/security-fiction.ts';
import { seedSourceQueueFixture } from '../fixtures/source-queue-fiction.ts';
import { sourceId } from '../src/ingestion/ingest.ts';
import { cleanupRetention } from '../src/ingestion/retention.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import type { State } from '../src/newsroom/model.ts';
import { AccessControl } from '../src/security/service.ts';
import { AssignedResourcePolicy, type ResourceAssignment, type ResourcePolicy } from '../src/security/resources.ts';
import { startInternalEditorialHTTP, validateInternalRequest, type InternalEditorialHTTP } from '../src/security/http.ts';
import type { SourceQueuePage } from '../src/source-queue/types.ts';

const endpoint = '/internal/source-queue';
const fixtureSource = (name: string) => sourceId(`https://source-queue.example.test/${name}`);
type Accounts = Awaited<ReturnType<typeof seedSecurityFixture>>['accounts'];
type Context = { server: InternalEditorialHTTP; repository: JsonRepository; accounts: Accounts;
  clock: { now: string }; access: AccessControl; policy: ResourcePolicy;
  setPolicy(assignments: ResourceAssignment[]): void; allAssignments: ResourceAssignment[];
  fixture: Awaited<ReturnType<typeof seedSecurityFixture>> };
async function fixture(run: (context: Context) => Promise<void>, repositoryFor: (file: string) => JsonRepository = file => new JsonRepository(file)) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-http-'));
  let server: InternalEditorialHTTP | null = null;
  try {
    const repository = repositoryFor(join(directory, 'fictional.json'));
    const seeded = await seedSecurityFixture(repository);
    await seedSourceQueueFixture(repository);
    const clock = { now: securityAt };
    const access = new AccessControl(repository, { verifier: seeded.verifier, clock: () => clock.now });
    const state = await repository.read();
    const ids = [...new Set([...state.sources.map(row => row.id), ...state.managedSources.map(row => row.sourceId), ...state.quarantine.map(row => row.sourceId)])];
    const allAssignments: ResourceAssignment[] = Object.values(seeded.accounts).flatMap(account => ids.map(id => ({ identityId: account.identity.id, permission: 'SOURCE_READ', kind: 'SOURCE', id })));
    let current: ResourcePolicy = new AssignedResourcePolicy(allAssignments);
    const policy: ResourcePolicy = {
      authorize: (...args) => current.authorize(...args),
      sourceReadRevision: () => current.sourceReadRevision!(),
    };
    server = await startInternalEditorialHTTP({ enabled: true, mode: 'development', repository, access, policy });
    assert.ok(server);
    await run({ server, repository, accounts: seeded.accounts, fixture: seeded, clock, access, policy, allAssignments,
      setPolicy: assignments => { current = new AssignedResourcePolicy(assignments); } });
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
}
function req(server: InternalEditorialHTTP, path: string, token?: string, options: { method?: string; headers?: OutgoingHttpHeaders; body?: string } = {}) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; text: string; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: OutgoingHttpHeaders = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(options.body) } : {}), ...options.headers };
    const request = httpRequest(server.origin + path, { method: options.method ?? 'GET', headers, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode!, headers: response.headers, text, body: text ? JSON.parse(text) : {} }); });
    });
    request.on('error', reject); request.end(options.body);
  });
}
function raw(server: InternalEditorialHTTP, path: string, headers: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(server.origin), socket = connect(Number(url.port), '127.0.0.1'); let value = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('test client deadline')));
    socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\n${headers}\r\n`));
    socket.on('data', chunk => { value += chunk.toString(); }); socket.on('end', () => resolve(value)); socket.on('error', reject);
  });
}
function page(reply: Awaited<ReturnType<typeof req>>): SourceQueuePage {
  assert.equal(reply.status, 200); return reply.body as unknown as SourceQueuePage;
}
function denied(reply: Awaited<ReturnType<typeof req>>, status: number): void {
  assert.equal(reply.status, status);
  assert.deepEqual(Object.keys(reply.body).sort(), ['error', 'requestId']);
  assert.doesNotMatch(reply.text, /source-queue\.example\.test|Fictional|candidate-|sourceId|actorAssertion|evidenceReferences|fictional-source-reviewer/);
}

test('source HTTP exposes only bounded assigned metadata with no-store headers and grants no editorial authority', async () => fixture(async c => {
  const before = await readFile(c.repository.file, 'utf8');
  const response = await req(c.server, endpoint, c.accounts.editor.credential);
  const result = page(response);
  assert.equal(result.entries.length, 7); assert.ok(result.entries.every(row => row.canAdvance === false));
  assert.deepEqual(Object.keys(result).sort(), ['entries', 'limit', 'nextCursor', 'retentionReviewRequired', 'view']);
  assert.deepEqual(Object.keys(result.entries[0]).sort(), ['blockedReason', 'canAdvance', 'candidateRef', 'canonicalUrl', 'provenance', 'provenanceStatus', 'publishedAt', 'publisher', 'quarantineStatus', 'relationship', 'retentionStatus', 'retrievedAt', 'rightsStatus', 'sourceEligible']);
  assert.ok(Buffer.byteLength(response.text) <= 262_144);
  assert.equal(response.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(response.headers['pragma'], 'no-cache'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.match(String(response.headers['x-request-id']), /^[a-f0-9-]{36}$/);
  assert.doesNotMatch(response.text, /fictional-source-reviewer|fictional-evidence|actorAssertion|evidenceReferences|providerMetadata|reviewer|rawPayload|credential|securityAudit/);
  assert.equal(response.text.includes(c.accounts.editor.credential), false);
  assert.equal(response.text.includes(c.accounts.editor.claims.sessionId), false);
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
}));

test('source HTTP denies missing malformed tampered unregistered expired and revoked credentials without metadata', async () => fixture(async c => {
  const token = c.accounts.editor.credential;
  for (const credential of [undefined, 'not-a-session', 'a.b.c', token.slice(0, -4) + 'zzzz', c.fixture.verifier.issue({ ...c.accounts.editor.claims, sessionId: randomUUID() })]) {
    denied(await req(c.server, endpoint, credential), 401);
  }
  c.clock.now = c.accounts.editor.claims.expiresAt;
  denied(await req(c.server, endpoint, token), 401);
  c.clock.now = securityAt;
  assert.equal((await req(c.server, '/internal/session/revoke', token, { method: 'POST', body: '{}' })).status, 200);
  denied(await req(c.server, endpoint, token), 401);
}));

test('source HTTP denies disabled and demoted current identities', async () => fixture(async c => {
  await c.repository.transact(state => { state.identities.find(row => row.id === c.accounts.editor.identity.id)!.status = 'DISABLED'; });
  denied(await req(c.server, endpoint, c.accounts.editor.credential), 401);
  await c.repository.transact(state => { const identity = state.identities.find(row => row.id === c.accounts.managing.identity.id)!; identity.roles = ['REPORTER']; identity.revision++; });
  denied(await req(c.server, endpoint, c.accounts.managing.credential), 403);
}));

test('source HTTP administrator and reporter receive no implicit read grant even with exact assignments', async () => fixture(async c => {
  denied(await req(c.server, endpoint, c.accounts.admin.credential), 403);
  denied(await req(c.server, endpoint, c.accounts.reporter.credential), 403);
  assert.equal(page(await req(c.server, endpoint, c.accounts.managing.credential)).entries.length, 7);
}));

test('source HTTP requires exact source assignments and provides no caller-targeted alternate read endpoint', async () => fixture(async c => {
  c.setPolicy(c.allAssignments.filter(row => row.identityId === c.accounts.editor.identity.id && row.id === fixtureSource('original')));
  const result = page(await req(c.server, endpoint, c.accounts.editor.credential));
  assert.equal(result.entries.length, 1); assert.match(result.entries[0].canonicalUrl!, /\/original$/);
  assert.equal(result.nextCursor, null);
  denied(await req(c.server, endpoint, c.accounts.managing.credential), 403);
  denied(await req(c.server, endpoint + '?sourceId=' + fixtureSource('copy'), c.accounts.editor.credential), 400);
  denied(await req(c.server, endpoint + '/' + fixtureSource('copy'), c.accounts.editor.credential), 404);
}));

test('source HTTP paginates the authorized view without unauthorized counts or relationship references', async () => fixture(async c => {
  c.setPolicy(c.allAssignments.filter(row => row.identityId === c.accounts.editor.identity.id && [fixtureSource('new'), fixtureSource('copy')].includes(row.id)));
  const first = page(await req(c.server, endpoint + '?limit=1', c.accounts.editor.credential));
  assert.equal(first.entries.length, 1); assert.ok(first.nextCursor);
  const second = page(await req(c.server, endpoint + '?limit=1&cursor=' + first.nextCursor, c.accounts.editor.credential));
  assert.equal(second.entries.length, 1); assert.equal(second.nextCursor, null);
  const values = [...first.entries, ...second.entries];
  assert.equal(new Set(values.map(row => row.candidateRef)).size, 2);
  assert.ok(values.every(row => row.relationship === null));
  assert.doesNotMatch(JSON.stringify([first, second]), /count|total|Fictional Original Gazette|\/original|Fictional Expired Archive|\/revoked/);
  assert.deepEqual(page(await req(c.server, endpoint + '?limit=1', c.accounts.editor.credential)), first);
}));

test('source HTTP rejects stale cursors after equal-assignment policy replacement or source changes', async () => fixture(async c => {
  const first = page(await req(c.server, endpoint + '?limit=1', c.accounts.editor.credential)); assert.ok(first.nextCursor);
  c.setPolicy(c.allAssignments);
  denied(await req(c.server, endpoint + '?limit=1&cursor=' + first.nextCursor, c.accounts.editor.credential), 409);
  const next = page(await req(c.server, endpoint + '?limit=1', c.accounts.editor.credential)); assert.ok(next.nextCursor);
  await c.repository.transact(state => { state.sources.find(row => row.id === fixtureSource('original'))!.verification = 'DISPUTED'; });
  denied(await req(c.server, endpoint + '?limit=1&cursor=' + next.nextCursor, c.accounts.editor.credential), 409);
}));

test('source HTTP preserves quarantine rights expiry revocation and deleted metadata restrictions', async () => fixture(async c => {
  const entries = page(await req(c.server, endpoint, c.accounts.editor.credential)).entries;
  const fresh = entries.find(row => row.canonicalUrl?.endsWith('/new'))!;
  assert.equal(fresh.quarantineStatus, 'QUARANTINED'); assert.equal(fresh.canAdvance, false); assert.equal(fresh.sourceEligible, false);
  const revoked = entries.find(row => row.rightsStatus === 'REVOKED')!;
  const expired = entries.find(row => row.retentionStatus === 'EXPIRED')!;
  for (const entry of [revoked, expired]) { assert.ok(entry); assert.equal(entry.publisher, null); assert.equal(entry.canonicalUrl, null); assert.equal(entry.relationship, null); }
  await cleanupRetention(c.repository, securityAt, false);
  const deleted = page(await req(c.server, endpoint, c.accounts.editor.credential)).entries.find(row => row.retentionStatus === 'DELETED')!;
  assert.ok(deleted); assert.equal(deleted.publisher, null); assert.equal(deleted.canonicalUrl, null);
  await c.repository.transact(state => { const row = state.managedSources.find(row => row.sourceId === fixtureSource('original'))!;
    row.policy.id = 'fictional-expired-v1'; row.policy.evidenceReference = 'fictional-fixture-only:fictional-expired-v1'; row.policy.expiresAt = '2026-01-02T00:00:00.000Z'; });
  const rights = page(await req(c.server, endpoint, c.accounts.editor.credential)).entries;
  assert.ok(rights.some(row => row.rightsStatus === 'EXPIRED' && row.canonicalUrl === null));
}));

test('source HTTP HEAD applies the complete GET authentication policy and emits no body', async () => fixture(async c => {
  const result = await req(c.server, endpoint + '?view=ELIGIBLE&limit=1', c.accounts.editor.credential, { method: 'HEAD' });
  assert.equal(result.status, 200); assert.equal(result.text, ''); assert.equal(result.headers['cache-control'], 'no-store, max-age=0');
  for (const credential of [undefined, 'a.b.c', c.accounts.admin.credential]) {
    const reply = await req(c.server, endpoint, credential, { method: 'HEAD' });
    assert.equal(reply.status, credential === c.accounts.admin.credential ? 403 : 401); assert.equal(reply.text, '');
  }
  assert.equal((await req(c.server, endpoint + '?limit=0', c.accounts.editor.credential, { method: 'HEAD' })).status, 400);
}));

test('source HTTP rejects unsafe queries encoded paths prototype keys credentials and oversized URLs', async () => fixture(async c => {
  const paths = ['?limit=0', '?limit=51', '?limit=01', '?limit=1.5', '?limit=1&limit=2', '?view=RECENT&view=ELIGIBLE', '?view=PRIVATE', '?cursor=', '?cursor=../secret', '?cursor=' + 'a'.repeat(1025), '?cursor=a=b', '?limit=1&&view=RECENT', '?limit=1?', '?__proto__=x', '?constructor=x', '?prototype=x', '?token=fictional-private-token', '?authorization=Bearer', '?repository=/tmp/private.json', '?sourceId=private-source', '?view=%52ECENT', '?%6cimit=1', '?cursor=a+b'];
  for (const suffix of paths) denied(await req(c.server, endpoint + suffix, c.accounts.editor.credential), 400);
  for (const path of ['/internal/%73ource-queue', '/internal/source-queue%3Flimit=1', endpoint + '?', endpoint + '#secret', endpoint + '\\secret', endpoint + '?cursor=' + 'a'.repeat(2200)]) {
    const response = await raw(c.server, path, `Authorization: Bearer ${c.accounts.editor.credential}\r\n`);
    assert.match(response, /HTTP\/1.1 400/); assert.doesNotMatch(response, /Fictional|candidate-/);
  }
  for (const path of ['/internal/principal?limit=1', '/internal/schedules?view=RECENT', '/internal/stories?limit=1']) denied(await req(c.server, path, c.accounts.editor.credential), 400);
}));

test('source HTTP retains loopback Host Origin cookie forwarded and duplicate-header protections', async () => fixture(async c => {
  for (const headers of [{ Host: 'evil.test' }, { Origin: 'https://evil.test' }, { Origin: 'null' }, { Cookie: 'private=fictional' }, { Forwarded: 'for=127.0.0.1' }, { 'X-Forwarded-Host': '127.0.0.1' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Access-Control-Request-Method': 'GET' }]) {
    denied(await req(c.server, endpoint + '?limit=1', c.accounts.editor.credential, { headers }), 403);
  }
  assert.equal((await req(c.server, endpoint, c.accounts.editor.credential, { headers: { Origin: c.server.origin, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  const duplicate = await raw(c.server, endpoint, `Authorization: Bearer ${c.accounts.editor.credential}\r\nAuthorization: Bearer ${c.accounts.managing.credential}\r\n`);
  assert.match(duplicate, /HTTP\/1.1 400/); assert.doesNotMatch(duplicate, /Fictional|candidate-/);
  assert.throws(() => validateInternalRequest({ socket: { remoteAddress: '10.0.0.1' }, rawHeaders: ['Host', '127.0.0.1:4000'], headers: { host: '127.0.0.1:4000' }, url: endpoint + '?limit=1' } as Pick<IncomingMessage, 'socket' | 'headers' | 'rawHeaders' | 'url'>, 4000), /FORBIDDEN/);
}));

test('source HTTP has no source mutation provenance resolution login or publishing routes', async () => fixture(async c => {
  const before = await readFile(c.repository.file, 'utf8');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) denied(await req(c.server, endpoint, c.accounts.managing.credential, { method, body: '{}' }), 405);
  for (const path of [endpoint + '/approve', endpoint + '/advance', endpoint + '/publish', '/internal/sources', '/internal/provenance/resolve', '/internal/login', '/internal/token', '/internal/session/register', '/dev/source-queue']) denied(await req(c.server, path, c.accounts.managing.credential), 404);
  denied(await req(c.server, endpoint, c.accounts.editor.credential, { headers: { 'Content-Length': '1' } }), 400);
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
}));

test('policies without a source-read revision capability deny only the new source endpoint', async () => fixture(async c => {
  const server = await startInternalEditorialHTTP({ enabled: true, mode: 'development', repository: c.repository, access: c.access, policy: { authorize() {} } });
  assert.ok(server);
  try {
    denied(await req(server, endpoint, c.accounts.editor.credential), 403);
    assert.equal((await req(server, '/internal/principal', c.accounts.editor.credential)).status, 200);
  } finally { await server.close(); }
}));

test('HTTP scope wrappers preserve nonvoid and asynchronous policy failures as whole-read denials', async () => fixture(async c => {
  for (const decision of [true, Promise.resolve()]) {
    const assigned = new AssignedResourcePolicy(c.allAssignments);
    const policy: ResourcePolicy = {
      authorize(principal, permission, targets, state) {
        if (targets[0]?.id === fixtureSource('original')) return decision as unknown as void;
        return assigned.authorize(principal, permission, targets, state);
      },
      sourceReadRevision: () => assigned.sourceReadRevision(),
    };
    const server = await startInternalEditorialHTTP({ enabled: true, mode: 'development', repository: c.repository, access: c.access, policy });
    assert.ok(server);
    try { denied(await req(server, endpoint, c.accounts.editor.credential), 403); }
    finally { await server.close(); }
  }
}));

test('malformed source storage returns a fixed sanitized unavailable category', async () => fixture(async c => {
  await writeFile(c.repository.file, '{"fictional-private-provider-payload":');
  const response = await req(c.server, endpoint, c.accounts.editor.credential);
  denied(response, 503); assert.equal(response.body.error, 'UNAVAILABLE'); assert.equal(response.text.includes(c.repository.file), false);
}));

test('accepted HTTP self-revocation fences a source disclosure while durable revocation waits for its lock', { timeout: 8000 }, async () => {
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
    const reading = req(c.server, endpoint, c.accounts.editor.credential);
    await waiting;
    const revocation = req(c.server, '/internal/session/revoke', c.accounts.editor.credential, { method: 'POST', body: '{}' });
    await revocationStarted; release();
    const [readReply, revokedReply] = await Promise.all([reading, revocation]);
    denied(readReply, 401); assert.equal(revokedReply.status, 200);
  }, file => new PausedRepository(file));
});

test('policy replacement during the final locked source read prevents partial HTTP disclosure', { timeout: 5000 }, async () => {
  let reached!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
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
  }
  await fixture(async c => {
    (c.repository as PausedRepository).armed = true;
    const reading = req(c.server, endpoint, c.accounts.editor.credential);
    await waiting; c.setPolicy([]); release();
    denied(await reading, 403);
  }, file => new PausedRepository(file));
});

test('HTTP rechecks source authority after response serialization and before synchronous send', async () => fixture(async c => {
  const stringify = JSON.stringify;
  const seen = new WeakSet<object>();
  let changed = false;
  JSON.stringify = function (value: unknown, ...args: unknown[]) {
    const serialized = Reflect.apply(stringify, JSON, [value, ...args]);
    if (value && typeof value === 'object' && Object.hasOwn(value, 'entries') && Object.hasOwn(value, 'nextCursor')) {
      if (seen.has(value) && !changed) { changed = true; c.setPolicy([]); }
      else seen.add(value);
    }
    return serialized;
  } as typeof JSON.stringify;
  try {
    denied(await req(c.server, endpoint, c.accounts.editor.credential), 403);
    assert.equal(changed, true);
  } finally { JSON.stringify = stringify; }
}));

test('HTTP final source gate also catches policy changes while recomputing its disclosure check', async () => fixture(async c => {
  const stringify = JSON.stringify;
  const seen = new WeakSet<object>();
  let httpSerialized = false, changed = false;
  JSON.stringify = function (value: unknown, ...args: unknown[]) {
    const serialized = Reflect.apply(stringify, JSON, [value, ...args]);
    if (value && typeof value === 'object' && Object.hasOwn(value, 'entries') && Object.hasOwn(value, 'nextCursor')) {
      if (seen.has(value)) httpSerialized = true;
      else if (httpSerialized && !changed) { changed = true; c.setPolicy([]); }
      seen.add(value);
    }
    return serialized;
  } as typeof JSON.stringify;
  try {
    denied(await req(c.server, endpoint, c.accounts.editor.credential), 403);
    assert.equal(changed, true);
  } finally { JSON.stringify = stringify; }
}));

test('HTTP withholds metadata when retention expires during final disclosure serialization while the session remains valid', async () => fixture(async c => {
  const expires = '2026-06-01T12:00:01.000Z';
  c.setPolicy(c.allAssignments.filter(row => row.identityId === c.accounts.editor.identity.id && row.id === fixtureSource('original')));
  await c.repository.transact(state => { state.managedSources.find(row => row.sourceId === fixtureSource('original'))!.deleteAt = expires; });
  const original = page(await req(c.server, endpoint, c.accounts.editor.credential));
  assert.equal(original.entries.length, 1); assert.equal(original.entries[0].sourceEligible, true);
  const stringify = JSON.stringify;
  const seen = new WeakSet<object>();
  let httpSerialized = false, changed = false;
  JSON.stringify = function (value: unknown, ...args: unknown[]) {
    const serialized = Reflect.apply(stringify, JSON, [value, ...args]);
    if (value && typeof value === 'object' && Object.hasOwn(value, 'entries') && Object.hasOwn(value, 'nextCursor')) {
      if (seen.has(value)) httpSerialized = true;
      else if (httpSerialized && !changed) { changed = true; c.clock.now = expires; }
      seen.add(value);
    }
    return serialized;
  } as typeof JSON.stringify;
  try {
    denied(await req(c.server, endpoint, c.accounts.editor.credential), 409);
    assert.equal(changed, true);
  } finally { JSON.stringify = stringify; }
  const state = await c.repository.read();
  assert.equal(c.access.authorizeInState(state, c.accounts.editor.credential, 'SOURCE_READ', c.clock.now).identityId, c.accounts.editor.identity.id);
  const after = page(await req(c.server, endpoint, c.accounts.editor.credential));
  assert.equal(after.entries[0].retentionStatus, 'EXPIRED'); assert.equal(after.entries[0].canonicalUrl, null); assert.equal(after.entries[0].publisher, null);
}));
