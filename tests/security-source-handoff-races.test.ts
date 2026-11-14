import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSecurityFixture } from '../fixtures/security-fiction.ts';
import { ingestArticles, sourceId } from '../src/ingestion/ingest.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import type { State, Story } from '../src/newsroom/model.ts';
import { AccessControl } from '../src/security/service.ts';
import { AssignedResourcePolicy, type ResourceAssignment, type ResourcePolicy } from '../src/security/resources.ts';
import { AuthenticatedEditorial } from '../src/security/editorial.ts';
import { AuthenticatedSourceReview } from '../src/security/source-review.ts';
import { AuthenticatedSourceHandoff } from '../src/security/source-handoff.ts';
import { SecurityError } from '../src/security/verifier.ts';
import type { Permission, TrustedSessionVerifier } from '../src/security/types.ts';

const at = '2026-06-01T12:00:00.000Z';
const deadline = '2026-06-01T12:00:01.000Z';
const privateValue = 'FICTIONAL_PRIVATE_HANDOFF_RACE_a271';
const storyId = 'fictional-handoff-race-story';
const sourcePermissions: Permission[] = ['SOURCE_READ', 'SOURCE_REVIEW', 'SOURCE_RESOLVE', 'SOURCE_HOLD', 'SOURCE_RELEASE'];
type SecurityFixture = Awaited<ReturnType<typeof seedSecurityFixture>>;
interface Fixture {
  repository: JsonRepository; security: SecurityFixture; access: AccessControl; verifier: TrustedSessionVerifier;
  clock: { now: string }; hooks: { beforeCommit?: () => void; reject?: boolean };
  ids: { target: string; proof: string }; grants: ResourceAssignment[];
  policy: { current: AssignedResourcePolicy }; resourcePolicy: ResourcePolicy;
  handoff(repository?: JsonRepository, policy?: ResourcePolicy): AuthenticatedSourceHandoff;
  editorial(repository?: JsonRepository, policy?: ResourcePolicy): AuthenticatedEditorial;
  review(): AuthenticatedSourceReview;
  story(): Omit<Story, 'status' | 'version' | 'sourceHandoff'>;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
class PausedWrite extends JsonRepository {
  readonly reached = deferred(); readonly released = deferred(); private armed = false;
  arm() { this.armed = true; }
  override async transactGuarded<T>(change: (state: State) => T, guard: (state: State) => void): Promise<T> {
    if (this.armed) { this.armed = false; this.reached.resolve(); await this.released.promise; }
    return super.transactGuarded(change, guard);
  }
}
class PausedRead extends JsonRepository {
  readonly reached = deferred(); readonly released = deferred(); private armed = false;
  arm() { this.armed = true; }
  override async readGuarded<T>(read: (state: State) => T): Promise<T> {
    if (this.armed) { this.armed = false; this.reached.resolve(); await this.released.promise; }
    return super.readGuarded(read);
  }
}
async function fixture(run: (f: Fixture) => Promise<void>, short: 'target' | 'proof' | null = null) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-handoff-races-'));
  try {
    const hooks: Fixture['hooks'] = {}, clock = { now: at };
    const repository = new JsonRepository(join(directory, 'fictional.json'), { beforeCommit: () => hooks.beforeCommit?.() });
    const security = await seedSecurityFixture(repository, at);
    const verifier: TrustedSessionVerifier = { issuer: security.verifier.issuer, audience: security.verifier.audience,
      maxSessionMs: security.verifier.maxSessionMs, verify(credential) { if (hooks.reject) throw Error(privateValue); return security.verifier.verify(credential); } };
    const access = new AccessControl(repository, { verifier, clock: () => clock.now });
    const target: ProviderArticle = { providerId: 'fictional-fixture', url: 'https://handoff-races.example.test/target',
      publisher: 'Fictional target', publishedAt: at, retrievedAt: at, provenance: { type: 'UNKNOWN', originId: null } };
    const proof: ProviderArticle = { ...target, url: 'https://handoff-races.example.test/proof', publisher: 'Fictional proof', provenance: { type: 'ORIGINAL', originId: null } };
    const counts = await ingestArticles(repository, [target, proof], { providerId: 'fictional-fixture', policyId: 'fictional-ai-editorial-v1' },
      { dryRun: false, clock: () => at, resolutions: [{ sourceId: sourceId(proof.url), classification: 'ORIGINAL', originId: null,
        actorAssertion: privateValue, at, reason: privateValue, evidenceReferences: [privateValue] }] });
    assert.equal(counts.processed, 1); assert.equal(counts.quarantined, 1); assert.equal(counts.failed, 0);
    const ids = { target: sourceId(target.url), proof: sourceId(proof.url) };
    await repository.transact(state => {
      state.sources.find(row => row.id === ids.proof)!.verification = 'VERIFIED';
      if (short) [...state.managedSources, ...state.quarantine].find(row => row.sourceId === ids[short])!.deleteAt = deadline;
    });
    const grants: ResourceAssignment[] = Object.values(security.accounts).flatMap(account => [
      ...Object.values(ids).flatMap(id => sourcePermissions.map(permission => ({ identityId: account.identity.id, permission, kind: 'SOURCE' as const, id }))),
      ...(['STORY_CREATE', 'STORY_EDIT', 'STORY_REVIEW', 'STORY_APPROVE'] as const).map(permission => ({ identityId: account.identity.id, permission, kind: 'STORY' as const, id: storyId })),
    ]);
    const policy = { current: new AssignedResourcePolicy(grants) };
    const resourcePolicy: ResourcePolicy = { sourceReadRevision: () => policy.current.sourceReadRevision(), authorize: (...args) => policy.current.authorize(...args) };
    const review = () => new AuthenticatedSourceReview(repository, access, { resourcePolicy });
    const sourceReview = review(), credential = security.accounts.editor.credential;
    const initial = await sourceReview.inspect(credential, ids.target);
    const begun = await sourceReview.begin(credential, ids.target, { revision: initial.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: [ids.proof] });
    const proposed = await sourceReview.propose(credential, ids.target, { revision: begun.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [ids.proof], classification: 'SECONDARY', originId: null });
    await sourceReview.confirm(security.accounts.managing.credential, ids.target, { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [ids.proof] });
    await run({ repository, security, access, verifier, clock, hooks, ids, grants, policy, resourcePolicy, review,
      handoff(sourceRepository = repository, sourcePolicy = resourcePolicy) {
        return new AuthenticatedSourceHandoff(sourceRepository, new AccessControl(sourceRepository, { verifier, clock: () => clock.now }), { resourcePolicy: sourcePolicy });
      },
      editorial(sourceRepository = repository, sourcePolicy = resourcePolicy) {
        return new AuthenticatedEditorial(sourceRepository, new AccessControl(sourceRepository, { verifier, clock: () => clock.now }), { resourcePolicy: sourcePolicy });
      },
      story() { return { id: storyId, headline: 'A fictional human-prepared story', summary: 'An explicitly supplied fictional summary.',
        topic: 'fiction', geography: 'Imaginary Town', eventAt: null, firstSeenAt: at, updatedAt: at, clusterId: 'fictional-race-cluster',
        sourceIds: [ids.target], evidence: [{ id: 'fictional-claim', claim: 'A fictional event is under review.', support: [ids.target],
          contradict: [], verification: 'VERIFIED', uncertainty: 'Invented test evidence only.', reviewerDecisions: [] }] }; },
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function denied(expected?: string | readonly string[]) { return (error: unknown) => {
  assert.ok(error instanceof SecurityError); assert.equal(error.message, error.code);
  if (typeof expected === 'string') assert.equal(error.code, expected);
  else if (expected) assert.ok(expected.includes(error.code), error.code);
  assert.doesNotMatch(JSON.stringify(error), /FICTIONAL_PRIVATE|handoff-races|fictional\.json|dayline-handoff/); return true;
}; }
async function request(f: Fixture) { return { sources: await f.handoff().inspect(f.security.accounts.editor.credential, [f.ids.target]), story: f.story() }; }
async function rollback(f: Fixture, action: () => Promise<unknown>, code?: string | readonly string[]) {
  const before = await readFile(f.repository.file, 'utf8');
  await assert.rejects(action(), denied(code));
  assert.equal(await readFile(f.repository.file, 'utf8'), before, 'failed guarded handoff must preserve exact repository bytes');
}

test('a post-sync storage failure leaves neither story content nor a successful creation receipt', async () => fixture(async f => {
  const input = await request(f); f.hooks.beforeCommit = () => { throw Error(privateValue + '/private/fixture.json'); };
  await rollback(f, () => f.handoff().prepare(f.security.accounts.editor.credential, input), 'STORAGE_UNAVAILABLE');
}));

test('session expiry after story serialization rolls back the entire handoff', async () => fixture(async f => {
  const input = await request(f); f.hooks.beforeCommit = () => { f.clock.now = f.security.accounts.editor.claims.expiresAt; };
  await rollback(f, () => f.handoff().prepare(f.security.accounts.editor.credential, input), 'SESSION_EXPIRED');
}));

for (const source of ['target', 'proof'] as const) test(`${source} retention expiry at commit prevents prepared text and success receipts`, async () => fixture(async f => {
  const input = await request(f); f.hooks.beforeCommit = () => { f.clock.now = deadline; };
  await rollback(f, () => f.handoff().prepare(f.security.accounts.editor.credential, input), ['DOMAIN_REJECTED', 'STALE_TARGET']);
}, source));

for (const missing of ['target', 'proof', 'story'] as const) test(`removing ${missing} assignment after sync prevents the full commit`, async () => fixture(async f => {
  const input = await request(f), identityId = f.security.accounts.editor.identity.id;
  f.hooks.beforeCommit = () => { f.policy.current = new AssignedResourcePolicy(f.grants.filter(row => row.identityId !== identityId
    || (missing === 'story' ? row.kind !== 'STORY' || row.permission !== 'STORY_CREATE' : row.kind !== 'SOURCE' || row.id !== f.ids[missing] || row.permission !== 'SOURCE_READ'))); };
  await rollback(f, () => f.handoff().prepare(f.security.accounts.editor.credential, input), 'PERMISSION_DENIED');
}));

test('replacing identical assignments at commit cannot restore an earlier authorization epoch', async () => fixture(async f => {
  const input = await request(f); f.hooks.beforeCommit = () => { f.policy.current = new AssignedResourcePolicy(f.grants); };
  await rollback(f, () => f.handoff().prepare(f.security.accounts.editor.credential, input), 'PERMISSION_DENIED');
}));

test('verifier revocation at commit fails closed without committing human content', async () => fixture(async f => {
  const input = await request(f); f.hooks.beforeCommit = () => { f.hooks.reject = true; };
  await rollback(f, () => f.handoff().prepare(f.security.accounts.editor.credential, input), 'INVALID_CREDENTIAL');
}));

test('clock rollback at the final boundary cannot backdate a successful handoff', async () => fixture(async f => {
  const input = await request(f); f.clock.now = '2026-06-01T12:00:00.500Z'; f.hooks.beforeCommit = () => { f.clock.now = at; };
  // A rollback also makes the trusted preparedAt later than the current clock,
  // so the domain continuity gate can reject before the final temporal fence.
  await rollback(f, () => f.handoff().prepare(f.security.accounts.editor.credential, input), ['STALE_TARGET', 'DOMAIN_REJECTED']);
}));

test('a supporting evidence mutation at the final commit guard invalidates the bound source snapshot', async () => fixture(async f => {
  class ChangedProof extends JsonRepository {
    override async transactGuarded<T>(change: (state: State) => T, guard: (state: State) => void): Promise<T> {
      return super.transactGuarded(change, state => { state.sources.find(row => row.id === f.ids.proof)!.verification = 'UNVERIFIED'; guard(state); });
    }
  }
  const input = await request(f);
  await rollback(f, () => f.handoff(new ChangedProof(f.repository.file)).prepare(f.security.accounts.editor.credential, input), ['DOMAIN_REJECTED', 'STALE_TARGET']);
}));

test('two concurrent preparations with one exact story allocation produce one story and one creation receipt', async () => fixture(async f => {
  const input = await request(f), before = await f.repository.read();
  const results = await Promise.allSettled([f.handoff().prepare(f.security.accounts.editor.credential, input),
    f.handoff().prepare(f.security.accounts.managing.credential, input)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const rejected = results.find(row => row.status === 'rejected')!;
  if (rejected.status === 'rejected') denied(['DOMAIN_REJECTED', 'STALE_TARGET'])(rejected.reason);
  const after = await f.repository.read(); assert.equal(after.revisions.length, before.revisions.length + 1);
  assert.equal(after.authenticatedActions.filter(row => row.resourceKind === 'STORY' && row.permission === 'STORY_CREATE' && row.resourceId === storyId).length, 1);
  assert.deepEqual(after.approvals, before.approvals); assert.deepEqual(after.editions, before.editions);
}));

test('a durable revocation ordered before a pending repository write denies the prepared story', async () => fixture(async f => {
  const paused = new PausedWrite(f.repository.file), handoff = f.handoff(paused), input = await request(f); paused.arm();
  const pending = handoff.prepare(f.security.accounts.editor.credential, input), rejected = assert.rejects(pending, denied('SESSION_REVOKED'));
  await paused.reached.promise; await f.access.invalidateSession(f.security.accounts.editor.credential);
  const afterRevocation = await readFile(f.repository.file, 'utf8'); paused.released.resolve(); await rejected;
  assert.equal(await readFile(f.repository.file, 'utf8'), afterRevocation);
  assert.deepEqual((await f.repository.read()).revisions, []);
}));

test('a concurrent review hold committed before preparation invalidates the queued selection', async () => fixture(async f => {
  const paused = new PausedWrite(f.repository.file), handoff = f.handoff(paused), input = await request(f); paused.arm();
  const pending = handoff.prepare(f.security.accounts.editor.credential, input), rejected = assert.rejects(pending, denied(['DOMAIN_REJECTED', 'STALE_TARGET']));
  await paused.reached.promise;
  const summary = await f.review().inspect(f.security.accounts.managing.credential, f.ids.target);
  await f.review().hold(f.security.accounts.managing.credential, f.ids.target,
    { revision: summary.revision, reasonCode: 'REVIEW_HOLD', evidenceReferences: [f.ids.proof] });
  const afterHold = await readFile(f.repository.file, 'utf8'); paused.released.resolve(); await rejected;
  assert.equal(await readFile(f.repository.file, 'utf8'), afterHold); assert.deepEqual((await f.repository.read()).revisions, []);
}));

test('input objects are snapshotted before asynchronous repository access and cannot substitute selected sources', async () => fixture(async f => {
  const input = await request(f), original = structuredClone(input.story);
  const pending = f.handoff().prepare(f.security.accounts.editor.credential, input);
  input.story.summary = 'A caller mutation after submission'; input.story.sourceIds = [f.ids.proof]; input.sources[0].id = f.ids.proof;
  await pending;
  const story = (await f.repository.read()).revisions.at(-1)!;
  assert.equal(story.summary, original.summary); assert.deepEqual(story.sourceIds, original.sourceIds);
}));

test('in-flight selection observes durable revocation before guarded metadata disclosure', async () => fixture(async f => {
  const paused = new PausedRead(f.repository.file), handoff = f.handoff(paused); paused.arm(); let disclosed = 0;
  const pending = handoff.withSelection(f.security.accounts.editor.credential, [f.ids.target], () => { disclosed++; });
  const rejected = assert.rejects(pending, denied('SESSION_REVOKED'));
  await paused.reached.promise; await f.access.invalidateSession(f.security.accounts.editor.credential);
  paused.released.resolve(); await rejected; assert.equal(disclosed, 0);
}));

test('source expiry crossed inside final selection serialization discloses no earlier token', async () => fixture(async f => {
  const stringify = JSON.stringify; let serializations = 0, disclosed = 0;
  JSON.stringify = function (value: unknown, ...args: unknown[]) {
    const text = Reflect.apply(stringify, JSON, [value, ...args]);
    if (Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === 'object'
      && Object.keys(value[0]).sort().join(',') === 'id,revision' && ++serializations === 2) f.clock.now = deadline;
    return text;
  } as typeof JSON.stringify;
  try {
    await assert.rejects(f.handoff().withSelection(f.security.accounts.editor.credential, [f.ids.target], () => { disclosed++; }), denied(['STALE_TARGET', 'DOMAIN_REJECTED']));
    assert.equal(disclosed, 0); assert.ok(serializations >= 2);
  } finally { JSON.stringify = stringify; }
}, 'target'));

test('an assignment replacement during final selection serialization prevents any token disclosure', async () => fixture(async f => {
  const stringify = JSON.stringify; let serializations = 0, disclosed = 0;
  JSON.stringify = function (value: unknown, ...args: unknown[]) {
    const text = Reflect.apply(stringify, JSON, [value, ...args]);
    if (Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === 'object'
      && Object.keys(value[0]).sort().join(',') === 'id,revision' && ++serializations === 2) f.policy.current = new AssignedResourcePolicy([]);
    return text;
  } as typeof JSON.stringify;
  try {
    await assert.rejects(f.handoff().withSelection(f.security.accounts.editor.credential, [f.ids.target], () => { disclosed++; }), denied('PERMISSION_DENIED'));
    assert.equal(disclosed, 0); assert.ok(serializations >= 2);
  } finally { JSON.stringify = stringify; }
}));

test('declared asynchronous disclosure callbacks are rejected before receiving selection data', async () => fixture(async f => {
  let disclosed = false;
  await assert.rejects(f.handoff().withSelection(f.security.accounts.editor.credential, [f.ids.target], async () => { disclosed = true; }), denied('DOMAIN_REJECTED'));
  assert.equal(disclosed, false);
}));

test('an accepted atomic handoff is not rolled back when later receipt disclosure is revoked', async () => fixture(async f => {
  const receipt = await f.handoff().prepare(f.security.accounts.editor.credential, await request(f));
  await f.access.invalidateSession(f.security.accounts.editor.credential); const before = await readFile(f.repository.file, 'utf8'); let disclosed = false;
  await assert.rejects(f.handoff().withPreparedStory(f.security.accounts.editor.credential, receipt.id, receipt.version, () => { disclosed = true; }), denied('SESSION_REVOKED'));
  assert.equal(disclosed, false); assert.equal(await readFile(f.repository.file, 'utf8'), before);
  const state = await f.repository.read(); assert.equal(state.revisions.length, 1);
  assert.equal(state.authenticatedActions.filter(row => row.resourceKind === 'STORY' && row.permission === 'STORY_CREATE').length, 1);
}));

test('a prepared story receipt is withheld if current proof assignments change during final serialization', async () => fixture(async f => {
  const receipt = await f.handoff().prepare(f.security.accounts.editor.credential, await request(f));
  const stringify = JSON.stringify; let serializations = 0, disclosed = false;
  JSON.stringify = function (value: unknown, ...args: unknown[]) {
    const text = Reflect.apply(stringify, JSON, [value, ...args]);
    if (value && typeof value === 'object' && Object.keys(value).sort().join(',') === 'id,status,version' && ++serializations === 2)
      f.policy.current = new AssignedResourcePolicy(f.grants.filter(row => row.kind !== 'SOURCE' || row.id !== f.ids.proof || row.permission !== 'SOURCE_READ'));
    return text;
  } as typeof JSON.stringify;
  try {
    await assert.rejects(f.handoff().withPreparedStory(f.security.accounts.editor.credential, receipt.id, receipt.version, () => { disclosed = true; }), denied('PERMISSION_DENIED'));
    assert.equal(disclosed, false); assert.ok(serializations >= 2);
  } finally { JSON.stringify = stringify; }
  assert.equal((await f.repository.read()).revisions.length, 1);
}));

test('unexpected policy/storage exceptions are reconstructed without private messages, paths or extra fields', async () => fixture(async f => {
  const input = await request(f);
  class FailedRead extends JsonRepository { override async read(): Promise<State> { const error = new Error(privateValue); Object.assign(error, { credential: privateValue, path: f.repository.file }); throw error; } }
  await assert.rejects(f.handoff(new FailedRead(f.repository.file)).prepare(f.security.accounts.editor.credential, input), denied('STORAGE_UNAVAILABLE'));
  const policy: ResourcePolicy = { sourceReadRevision: () => 'a'.repeat(64), authorize() { throw Error(privateValue); } };
  await assert.rejects(f.handoff(f.repository, policy).prepare(f.security.accounts.editor.credential, input), denied('PERMISSION_DENIED'));
}));

test('downstream approval rechecks bound evidence at commit rather than trusting earlier story preparation', async () => fixture(async f => {
  let row: Pick<Story, 'id' | 'version' | 'status'> = await f.handoff().prepare(f.security.accounts.editor.credential, await request(f));
  for (const next of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW'] as const) row = await f.editorial().reviewStory(f.security.accounts.managing.credential, row.id, row.version, next);
  const before = await f.repository.read();
  f.hooks.beforeCommit = () => { f.policy.current = new AssignedResourcePolicy(f.grants.filter(grant => grant.kind !== 'SOURCE' || grant.id !== f.ids.proof || grant.permission !== 'SOURCE_READ')); };
  await assert.rejects(f.editorial().approveStory(f.security.accounts.managing.credential, row.id, row.version), denied('PERMISSION_DENIED'));
  const after = await f.repository.read(); assert.deepEqual(after.revisions, before.revisions); assert.deepEqual(after.approvals, before.approvals);
  assert.deepEqual(after.authenticatedActions, before.authenticatedActions);
}));
