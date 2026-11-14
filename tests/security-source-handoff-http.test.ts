import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedEditorialWorkflowFixture, editorialWorkflowAt } from '../fixtures/editorial-workflow-fiction.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { AccessControl } from '../src/security/service.ts';
import { AssignedResourcePolicy, type ResourceAssignment, type ResourcePolicy } from '../src/security/resources.ts';
import { startInternalEditorialHTTP, type InternalEditorialHTTP } from '../src/security/http.ts';
import type { SourceSelection } from '../src/source-handoff/types.ts';

const route = '/internal/source-handoff/';
type Seed = Awaited<ReturnType<typeof seedEditorialWorkflowFixture>>;
type Context = Omit<Seed, 'policy'> & { policy: ResourcePolicy; repository: JsonRepository; server: InternalEditorialHTTP;
  clock: { now: string }; setPolicy(assignments: ResourceAssignment[]): void };
async function fixture(action: (context: Context) => Promise<void>, options: {
  resolve?: boolean; repositoryFor?: (file: string) => JsonRepository;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-handoff-http-')); let server: InternalEditorialHTTP | null = null;
  try {
    const repository = options.repositoryFor?.(join(directory, 'fictional.json')) ?? new JsonRepository(join(directory, 'fictional.json'));
    const seeded = await seedEditorialWorkflowFixture(repository);
    if (options.resolve !== false) await seeded.resolvePending();
    const clock = { now: editorialWorkflowAt };
    const access = new AccessControl(repository, { verifier: seeded.verifier, clock: () => clock.now });
    let current = seeded.resourcePolicy;
    const policy: ResourcePolicy = { authorize: (...args) => current.authorize(...args), sourceReadRevision: () => current.sourceReadRevision() };
    server = await startInternalEditorialHTTP({ enabled: true, mode: 'development', repository, access, policy }); assert.ok(server);
    await action({ ...seeded, access, policy, repository, server, clock,
      setPolicy: assignments => { current = new AssignedResourcePolicy(assignments); } });
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
}
type Reply = { status: number; headers: IncomingMessage['headers']; text: string; body: unknown };
function req(c: Context, action: string, token?: string, body: unknown = { sourceIds: [c.sourceIds.pending] },
  options: { method?: string; headers?: OutgoingHttpHeaders; raw?: string } = {}): Promise<Reply> {
  const serialized = options.raw ?? JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(c.server.origin + (action.startsWith('/') ? action : route + action), {
      method: options.method ?? 'POST', agent: false, headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized),
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers,
      },
    }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode!,
        headers: response.headers, text, body: text ? JSON.parse(text) : null }); });
    });
    request.on('error', reject); request.end(serialized);
  });
}
function headers(reply: Reply) {
  assert.equal(reply.headers['cache-control'], 'no-store, max-age=0'); assert.equal(reply.headers.pragma, 'no-cache');
  assert.equal(reply.headers['x-content-type-options'], 'nosniff'); assert.equal(reply.headers['access-control-allow-origin'], undefined);
  assert.ok(Buffer.byteLength(reply.text) <= 262_144);
}
function denied(reply: Reply, status: number) {
  assert.equal(reply.status, status, reply.text); headers(reply);
  if (reply.text) { assert.deepEqual(Object.keys(reply.body as object).sort(), ['error', 'requestId']);
    assert.doesNotMatch(reply.text, /url-|editorial-workflow|private|actorId|sourceHandoff|evidenceReferences|credential|sessionId|policy/i); }
}
function selected(reply: Reply, c: Context): SourceSelection[] {
  assert.equal(reply.status, 200, reply.text); headers(reply); assert.ok(Array.isArray(reply.body));
  assert.equal(reply.body.length, 1); assert.deepEqual(Object.keys(reply.body[0]).sort(), ['id', 'revision']);
  assert.equal(reply.body[0].id, c.sourceIds.pending); assert.match(reply.body[0].revision, /^[a-f0-9]{64}$/);
  assert.equal(reply.text.includes(c.sourceIds.proof), false);
  assert.doesNotMatch(reply.text, /actor|proposedBy|policy|provider|evidence|sourceHandoff|credential|session|audit/i);
  return reply.body as SourceSelection[];
}
async function selection(c: Context) { return selected(await req(c, 'inspect', c.accounts.editor.credential), c); }
function receipt(reply: Reply, c: Context) {
  assert.equal(reply.status, 200, reply.text); headers(reply);
  assert.deepEqual(reply.body, { id: c.humanStory.id, version: 1, status: 'INGESTED' });
  assert.doesNotMatch(reply.text, /sourceHandoff|url-|claim|headline|summary|actor|evidence|policy|credential|audit/i);
}
async function unchanged(c: Context, operation: () => Promise<Reply>, status: number) {
  const before = await readFile(c.repository.file, 'utf8'); denied(await operation(), status);
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
}

test('handoff HTTP selection returns only authorized exact revision tokens without writing metadata', async () => fixture(async c => {
  const before = await readFile(c.repository.file, 'utf8'); await selection(c);
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
}));

test('HTTP discovery, independent review and handoff preserve explicit human content and separate editorial approval', async () => fixture(async c => {
  const token = c.accounts.managing.credential, proof = [c.sourceIds.proof];
  denied(await req(c, 'inspect', token), 400);
  const initial = await req(c, '/internal/source-review/inspect', token, { sourceId: c.sourceIds.pending }); assert.equal(initial.status, 200);
  const begun = await req(c, '/internal/source-review/begin', token, { sourceId: c.sourceIds.pending,
    revision: (initial.body as { revision: string }).revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: proof }); assert.equal(begun.status, 200);
  const proposal = await req(c, '/internal/source-review/propose', token, { sourceId: c.sourceIds.pending,
    revision: (begun.body as { revision: string }).revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: proof,
    classification: 'SECONDARY', originId: null }); assert.equal(proposal.status, 200);
  denied(await req(c, 'inspect', token), 400);
  const confirmation = { sourceId: c.sourceIds.pending, revision: (proposal.body as { revision: string }).revision,
    reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: proof };
  denied(await req(c, '/internal/source-review/confirm', token, confirmation), 403);
  assert.equal((await req(c, '/internal/source-review/confirm', c.accounts.confirming.credential, confirmation)).status, 200);
  const sources = await selection(c);
  receipt(await req(c, 'prepare', c.accounts.editor.credential, { sources, story: c.humanStory }), c);
  const state = await c.repository.read(), story = state.revisions.find(row => row.id === c.humanStory.id)!;
  assert.equal(story.status, 'INGESTED'); assert.equal(story.version, 1);
  assert.equal(story.headline, c.humanStory.headline); assert.deepEqual(story.evidence, c.humanStory.evidence);
  assert.ok(story.sourceHandoff); assert.deepEqual(state.approvals, []); assert.deepEqual(state.editions, []);
  assert.equal(state.revisions.some(row => row.status === 'PUBLISHED'), false);
  assert.equal(state.authenticatedActions.filter(row => row.resourceKind === 'STORY' && row.resourceId === story.id && row.permission === 'STORY_CREATE').length, 1);
}, { resolve: false }));

test('reporter and administrator assignments do not confer source-to-story role authority', async () => fixture(async c => {
  const sources = await selection(c);
  for (const account of [c.accounts.reporter, c.accounts.admin]) {
    await unchanged(c, () => req(c, 'inspect', account.credential), 403);
    await unchanged(c, () => req(c, 'prepare', account.credential, { sources, story: c.humanStory }), 403);
  }
}));

test('source inspection grants no story creation ownership or permission', async () => fixture(async c => {
  const sources = await selection(c);
  c.setPolicy(c.assignments.filter(row => !(row.identityId === c.accounts.editor.identity.id && row.permission === 'STORY_CREATE')));
  selected(await req(c, 'inspect', c.accounts.editor.credential), c);
  await unchanged(c, () => req(c, 'prepare', c.accounts.editor.credential, { sources, story: c.humanStory }), 403);
}));

test('prepared stories use existing independent story approval and edition allocation without inferred ownership', async () => fixture(async c => {
  const sources = await selection(c), token = c.accounts.editor.credential;
  receipt(await req(c, 'prepare', token, { sources, story: c.humanStory }), c);
  let version = 1;
  for (const status of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW']) {
    const response = await req(c, `/internal/stories/${c.humanStory.id}/review`, token, { version, status });
    assert.equal(response.status, 200, response.text); version = (response.body as { version: number }).version;
    assert.equal((response.body as { status: string }).status, status);
  }
  denied(await req(c, `/internal/stories/${c.humanStory.id}/approve`, token, { version }), 403);
  const approved = await req(c, `/internal/stories/${c.humanStory.id}/approve`, c.accounts.managing.credential, { version });
  assert.equal(approved.status, 200, approved.text); assert.equal((approved.body as { status: string }).status, 'APPROVED');
  const body = { date: '2026-06-01', timezone: 'UTC', placements: [{ storyId: c.humanStory.id,
    storyVersion: (approved.body as { version: number }).version, section: 'TOP_STORIES', featured: true }] };
  denied(await req(c, '/internal/editions', c.accounts.reporter.credential, body), 403);
  const edition = await req(c, '/internal/editions', token, body); assert.equal(edition.status, 200, edition.text);
  const row = edition.body as { id: string; revision: number; status: string }; assert.equal(row.status, 'ASSEMBLING');
  denied(await req(c, `/internal/editions/${row.id}/review`, c.accounts.managing.credential,
    { revision: row.revision, status: 'NEEDS_REVIEW' }), 403);
  const state = await c.repository.read(); assert.equal(state.approvals.length, 1); assert.equal(state.editions.length, 1);
  assert.equal(state.editions[0].status, 'ASSEMBLING'); assert.deepEqual(state.editionReviews, []);
  assert.equal(state.revisions.some(story => story.status === 'PUBLISHED'), false);
}));

test('inaccessible provenance proof blocks both token inspection and preparation', async () => fixture(async c => {
  const sources = await selection(c);
  c.setPolicy(c.assignments.filter(row => !(row.identityId === c.accounts.editor.identity.id && row.permission === 'SOURCE_READ' && row.id === c.sourceIds.proof)));
  await unchanged(c, () => req(c, 'inspect', c.accounts.editor.credential), 403);
  await unchanged(c, () => req(c, 'prepare', c.accounts.editor.credential, { sources, story: c.humanStory }), 403);
}));

test('exact source and story target assignments prevent resource substitution', async () => fixture(async c => {
  const sources = await selection(c);
  c.setPolicy(c.assignments.filter(row => !(row.identityId === c.accounts.editor.identity.id && row.permission === 'SOURCE_READ' && row.id === c.sourceIds.pending)));
  await unchanged(c, () => req(c, 'prepare', c.accounts.editor.credential, { sources, story: c.humanStory }), 403);
  c.setPolicy(c.assignments);
  await unchanged(c, () => req(c, 'prepare', c.accounts.editor.credential, { sources, story: { ...c.humanStory, id: 'unassigned-story' } }), 403);
  await unchanged(c, () => req(c, 'inspect', c.accounts.editor.credential, { sourceIds: [c.sourceIds.other] }), 403);
}));

test('a changed captured source deadline invalidates an earlier handoff fingerprint', async () => fixture(async c => {
  const sources = await selection(c);
  await c.repository.transact(state => { state.managedSources.find(row => row.sourceId === c.sourceIds.pending)!.deleteAt = '2026-06-01T12:00:10.000Z'; });
  await unchanged(c, () => req(c, 'prepare', c.accounts.editor.credential, { sources, story: c.humanStory }), 409);
}));

test('duplicate and substituted source identities cannot enter story preparation', async () => fixture(async c => {
  const sources = await selection(c), body = { sources, story: c.humanStory };
  for (const value of [{ sourceIds: [c.sourceIds.pending, c.sourceIds.pending] }, { sourceIds: [] }]) {
    await unchanged(c, () => req(c, 'inspect', c.accounts.editor.credential, value), 400);
  }
  await unchanged(c, () => req(c, 'prepare', c.accounts.editor.credential, { ...body, sources: [...sources, ...sources] }), 400);
  await unchanged(c, () => req(c, 'prepare', c.accounts.editor.credential, { ...body,
    story: { ...c.humanStory, sourceIds: [c.sourceIds.other] } }), 400);
}));

test('a disputed independently reviewed source remains blocked from handoff', async () => fixture(async c => {
  await c.resolveDisputed();
  await unchanged(c, () => req(c, 'inspect', c.accounts.editor.credential, { sourceIds: [c.sourceIds.disputed] }), 400);
}));

test('an explicit source hold blocks use of an earlier eligible selection', async () => fixture(async c => {
  const sources = await selection(c), status = await c.sourceReview.inspect(c.accounts.editor.credential, c.sourceIds.pending);
  await c.sourceReview.hold(c.accounts.editor.credential, c.sourceIds.pending, { revision: status.revision,
    reasonCode: 'REVIEW_HOLD', evidenceReferences: [c.sourceIds.proof] });
  await unchanged(c, () => req(c, 'prepare', c.accounts.editor.credential, { sources, story: c.humanStory }), 400);
}));

test('expired source rights and repository retention holds prevent progression', async () => fixture(async c => {
  const sources = await selection(c);
  await c.repository.transact(state => { state.managedSources.find(row => row.sourceId === c.sourceIds.pending)!.deleteAt = editorialWorkflowAt; });
  await unchanged(c, () => req(c, 'prepare', c.accounts.editor.credential, { sources, story: c.humanStory }), 400);
  await c.repository.transact(state => { state.retentionReviewRequired = true; });
  await unchanged(c, () => req(c, 'inspect', c.accounts.editor.credential), 400);
}));

for (const variant of ['revoked', 'expired', 'rotated', 'disabled', 'demoted'] as const) test(`${variant} current editorial identity/session cannot use an earlier selection`, async () => fixture(async c => {
  const sources = await selection(c), account = c.accounts.editor;
  if (variant === 'expired') c.clock.now = account.claims.expiresAt;
  else await c.repository.transact(state => {
    const identity = state.identities.find(row => row.id === account.identity.id)!;
    if (variant === 'revoked') state.sessions.find(row => row.id === account.claims.sessionId)!.revokedAt = editorialWorkflowAt;
    if (variant === 'rotated') { identity.credentialVersion++; identity.revision++; identity.credentialsRotatedAt = editorialWorkflowAt; }
    if (variant === 'disabled') { identity.status = 'DISABLED'; identity.revision++; }
    if (variant === 'demoted') { identity.roles = ['REPORTER']; identity.revision++; }
  });
  await unchanged(c, () => req(c, 'prepare', account.credential, { sources, story: c.humanStory }), variant === 'demoted' ? 403 : 401);
}));

test('missing and malformed credentials never disclose selection metadata', async () => fixture(async c => {
  for (const token of [undefined, 'not-a-signed-credential']) denied(await req(c, 'inspect', token), 401);
}));

test('caller actor, permission, policy, binding and fabricated verification fields are rejected', async () => fixture(async c => {
  const sources = await selection(c);
  for (const extra of [{ actor: 'forged' }, { permission: 'STORY_APPROVE' }, { policy: {} }]) {
    await unchanged(c, () => req(c, 'prepare', c.accounts.editor.credential, { sources, story: c.humanStory, ...extra }), 400);
  }
  for (const extra of [{ actorId: c.accounts.managing.identity.id }, { status: 'APPROVED' }, { sourceHandoff: {} }, { version: 100 }]) {
    await unchanged(c, () => req(c, 'prepare', c.accounts.editor.credential, { sources, story: { ...c.humanStory, ...extra } }), 400);
  }
  for (const verification of ['UNVERIFIED', 'DISPUTED']) {
    const story = structuredClone(c.humanStory); story.evidence[0].verification = verification as 'UNVERIFIED' | 'DISPUTED';
    await unchanged(c, () => req(c, 'prepare', c.accounts.editor.credential, { sources, story }), 400);
  }
}));

test('HTTP methods, URLs and strict transport headers preserve private listener restrictions', async () => fixture(async c => {
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) denied(await req(c, 'inspect', c.accounts.editor.credential, undefined, { method }), 405);
  for (const path of [route + 'inspect?sourceIds=private', route + 'inspect%3F', route + 'prepare/extra']) {
    denied(await req(c, path, c.accounts.editor.credential), path.includes('?') || path.includes('%') ? 400 : 404);
  }
  for (const headers of [{ Origin: 'https://hostile.example.test' }, { Host: 'hostile.example.test' }, { Cookie: 'private=sentinel' }, { 'X-Forwarded-For': '127.0.0.1' }]) {
    denied(await req(c, 'inspect', c.accounts.editor.credential, undefined, { headers }), 403);
  }
  denied(await req(c, 'inspect', c.accounts.editor.credential, undefined, { headers: { 'Content-Type': 'text/plain' } }), 415);
}));

test('body size, unsafe source references and prototype-sensitive payloads fail before mutation', async () => fixture(async c => {
  const token = c.accounts.editor.credential;
  denied(await req(c, 'prepare', token, {}, { raw: ' '.repeat(16_385) }), 413);
  for (const body of [{ sourceIds: ['https://private.example.test/source'] }, { sourceIds: ['/private/repository.json'] },
    { sourceIds: Array.from({ length: 9 }, (_, index) => 'url-' + String(index).padStart(64, '0')) }]) {
    await unchanged(c, () => req(c, 'inspect', token, body), 400);
  }
  for (const raw of ['{"sourceIds":[],"__proto__":{"admin":true}}', '{"sourceIds":[],"constructor":{}}', '{']) {
    await unchanged(c, () => req(c, 'inspect', token, undefined, { raw }), 400);
  }
}));

test('legacy authenticated story creation cannot bypass handoff for a reviewed source', async () => fixture(async c => {
  const before = await c.repository.read();
  denied(await req(c, '/internal/stories', c.accounts.editor.credential, c.humanStory), 400);
  const after = await c.repository.read();
  assert.deepEqual(after.revisions, before.revisions); assert.deepEqual(after.authenticatedActions, before.authenticatedActions);
}));

test('concurrent duplicate handoffs commit exactly one story and one creation receipt', async () => fixture(async c => {
  const sources = await selection(c), body = { sources, story: c.humanStory };
  const results = await Promise.all([req(c, 'prepare', c.accounts.editor.credential, body), req(c, 'prepare', c.accounts.editor.credential, body)]);
  assert.equal(results.filter(row => row.status === 200).length, 1);
  assert.equal(results.filter(row => row.status === 400 || row.status === 409).length, 1);
  const state = await c.repository.read();
  assert.equal(state.revisions.filter(row => row.id === c.humanStory.id).length, 1);
  assert.equal(state.authenticatedActions.filter(row => row.resourceKind === 'STORY' && row.resourceId === c.humanStory.id && row.permission === 'STORY_CREATE').length, 1);
}));

test('injected storage failure rolls back the prepared story, bindings and successful receipt atomically', async () => {
  let fail = false;
  await fixture(async c => {
    const sources = await selection(c), before = await readFile(c.repository.file, 'utf8'); fail = true;
    denied(await req(c, 'prepare', c.accounts.editor.credential, { sources, story: c.humanStory }), 503);
    assert.equal(await readFile(c.repository.file, 'utf8'), before);
  }, { repositoryFor: file => new JsonRepository(file, { beforeCommit: () => { if (fail) throw Error('private storage path and credential sentinel'); } }) });
});

test('a policy replacement during final selection serialization withholds the entire response', async () => fixture(async c => {
  const stringify = JSON.stringify; let changed = false;
  JSON.stringify = function (value: unknown, ...args: unknown[]) {
    const serialized = Reflect.apply(stringify, JSON, [value, ...args]);
    if (!changed && Array.isArray(value) && value.length === 1 && value[0]?.id === c.sourceIds.pending && typeof value[0]?.revision === 'string') {
      changed = true; c.setPolicy(c.assignments.filter(row => !(row.identityId === c.accounts.editor.identity.id && row.id === c.sourceIds.proof && row.permission === 'SOURCE_READ')));
    }
    return serialized;
  } as typeof JSON.stringify;
  try { denied(await req(c, 'inspect', c.accounts.editor.credential), 403); assert.equal(changed, true); }
  finally { JSON.stringify = stringify; }
}));

test('a postcommit response denial preserves accepted state without granting a duplicate action', async () => fixture(async c => {
  const sources = await selection(c), original = c.repository.transactGuarded.bind(c.repository);
  let armed = true;
  c.repository.transactGuarded = async function (...args) {
    const result = await original(...args);
    if (armed) { armed = false; c.setPolicy(c.assignments.filter(row => !(row.identityId === c.accounts.editor.identity.id && row.permission === 'STORY_CREATE'))); }
    return result;
  } as typeof c.repository.transactGuarded;
  denied(await req(c, 'prepare', c.accounts.editor.credential, { sources, story: c.humanStory }), 403);
  const state = await c.repository.read(); assert.equal(state.revisions.filter(row => row.id === c.humanStory.id).length, 1);
  assert.equal(state.authenticatedActions.filter(row => row.resourceKind === 'STORY' && row.resourceId === c.humanStory.id && row.permission === 'STORY_CREATE').length, 1);
  assert.deepEqual(state.approvals, []); assert.deepEqual(state.editions, []);
}));

test('same-listener session revocation fences a handoff already waiting for the repository lock', async () => fixture(async c => {
  const sources = await selection(c), originalAuthorize = c.policy.authorize.bind(c.policy);
  let authorized!: () => void, revoked!: () => void;
  const authorizedSignal = new Promise<void>(resolve => { authorized = resolve; });
  const revokedSignal = new Promise<void>(resolve => { revoked = resolve; });
  c.policy.authorize = (...args) => { if (args[1] === 'STORY_CREATE') authorized(); return originalAuthorize(...args); };
  const invalidate = c.access.invalidateSession.bind(c.access);
  c.access.invalidateSession = credential => { revoked(); return invalidate(credential); };
  const within = async (signal: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([signal, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('Expected handoff revocation boundary was not reached')), 3000); })]); }
    finally { clearTimeout(timer); }
  };
  // The HTTP response can arrive before the accepted read releases its lock.
  // Serialize one empty read first, then create only this test's own lock.
  await c.repository.readGuarded(() => undefined);
  const lock = c.repository.file + '.lock'; await mkdir(lock);
  let handoff: Promise<Reply> | undefined, revocation: Promise<Reply> | undefined;
  try {
    handoff = req(c, 'prepare', c.accounts.editor.credential, { sources, story: c.humanStory });
    await within(authorizedSignal);
    revocation = req(c, '/internal/session/revoke', c.accounts.editor.credential, {});
    await within(revokedSignal);
  } finally { await rm(lock, { recursive: true, force: true }); }
  denied(await handoff!, 401); assert.equal((await revocation!).status, 200);
  const state = await c.repository.read();
  assert.equal(state.revisions.some(row => row.id === c.humanStory.id), false);
  assert.equal(state.authenticatedActions.some(row => row.resourceKind === 'STORY' && row.resourceId === c.humanStory.id), false);
}));
