import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedEditorialWorkflowFixture, editorialWorkflowAt as at } from '../fixtures/editorial-workflow-fiction.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { AccessControl } from '../src/security/service.ts';
import { AuthenticatedEditorialOperations } from '../src/security/operations.ts';
import { AssignedResourcePolicy, type ResourcePolicy } from '../src/security/resources.ts';
import { SecurityError } from '../src/security/verifier.ts';
import type { OperationsOverview, OperationsSources, OperationsSourceDetail, OperationsStories, OperationsEditions } from '../src/security/operations-types.ts';
import type { Story } from '../src/newsroom/model.ts';
import { SourceQueueError } from '../src/source-queue/service.ts';

type Seed = Awaited<ReturnType<typeof seedEditorialWorkflowFixture>>;
type Fixture = Seed & { repository: JsonRepository; clock: { now: string }; currentAccess: AccessControl;
  operations(policy?: ResourcePolicy): AuthenticatedEditorialOperations };
async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-operations-projection-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const seeded = await seedEditorialWorkflowFixture(repository), clock = { now: at };
    const currentAccess = new AccessControl(repository, { verifier: seeded.verifier, clock: () => clock.now });
    await run({ ...seeded, repository, clock, currentAccess,
      operations(policy = seeded.resourcePolicy) { return new AuthenticatedEditorialOperations(repository, currentAccess, { resourcePolicy: policy }); } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const credential = (f: Fixture) => f.accounts.managing.credential;
async function overview(f: Fixture, actor: keyof Fixture['accounts'] = 'managing', policy?: ResourcePolicy): Promise<OperationsOverview> {
  let result!: OperationsOverview; await f.operations(policy).withOverview(f.accounts[actor].credential, value => { result = value; }); return result;
}
async function sources(f: Fixture, policy?: ResourcePolicy): Promise<OperationsSources> {
  let result!: OperationsSources; await f.operations(policy).withSources(credential(f), undefined, value => { result = value; }); return result;
}
async function detail(f: Fixture, id = f.sourceIds.pending, actor: keyof Fixture['accounts'] = 'managing', policy?: ResourcePolicy): Promise<OperationsSourceDetail> {
  let result!: OperationsSourceDetail; await f.operations(policy).withSource(f.accounts[actor].credential, id, value => { result = value; }); return result;
}
async function stories(f: Fixture, policy?: ResourcePolicy, actor: keyof Fixture['accounts'] = 'managing'): Promise<OperationsStories> {
  let result!: OperationsStories; await f.operations(policy).withStories(f.accounts[actor].credential, value => { result = value; }); return result;
}
async function editions(f: Fixture, policy?: ResourcePolicy): Promise<OperationsEditions> {
  let result!: OperationsEditions; await f.operations(policy).withEditions(credential(f), value => { result = value; }); return result;
}
const denied = (code?: string) => (error: unknown): boolean => {
  assert.ok(error instanceof SecurityError); if (code) assert.equal(error.code, code);
  assert.equal(error.message, error.code); assert.doesNotMatch(JSON.stringify(error), /PRIVATE|fictional\.json|credential|providerMetadata/); return true;
};
function without(f: Fixture, predicate: (row: Fixture['assignments'][number]) => boolean): AssignedResourcePolicy {
  return new AssignedResourcePolicy(f.assignments.filter(row => !predicate(row)));
}
async function propose(f: Fixture, actor: keyof Fixture['accounts'] = 'managing') {
  const auth = f.accounts[actor].credential, id = f.sourceIds.pending;
  const initial = await f.sourceReview.inspect(auth, id);
  const started = await f.sourceReview.begin(auth, id, { revision: initial.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: [f.sourceIds.proof] });
  return f.sourceReview.propose(auth, id, { revision: started.revision, reasonCode: 'EVIDENCE_SUPPORTED',
    evidenceReferences: [f.sourceIds.proof], classification: 'SECONDARY', originId: null });
}
async function prepare(f: Fixture): Promise<Pick<Story, 'id' | 'version' | 'status'>> {
  await f.resolvePending();
  const selection = await f.sourceHandoff.inspect(credential(f), [f.sourceIds.pending]);
  return f.sourceHandoff.prepare(credential(f), { sources: selection, story: f.humanStory });
}
async function assembled(f: Fixture) {
  let row = await prepare(f);
  for (const status of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW'] as const) row = await f.editorial.reviewStory(credential(f), row.id, row.version, status);
  row = await f.editorial.approveStory(credential(f), row.id, row.version);
  const edition = await f.editorial.assembleEdition(credential(f), { date: '2026-06-01', timezone: 'UTC',
    placements: [{ storyId: row.id, storyVersion: row.version, section: 'TOP_STORIES', featured: true }] });
  const policy = new AssignedResourcePolicy([...f.assignments, ...(['EDITION_ASSEMBLE', 'EDITION_REVIEW', 'EDITION_READY'] as const)
    .map(permission => ({ identityId: f.accounts.managing.identity.id, kind: 'EDITION' as const, id: edition.id, permission }))]);
  return { edition, policy };
}

test('operations overview contains only own roles, permissions, and a bounded server lease', async () => fixture(async f => {
  const value = await overview(f); assert.deepEqual(Object.keys(value).sort(), ['asOf', 'permissions', 'roles', 'validForMs']);
  assert.equal(value.asOf, at); assert.equal(value.validForMs, 1500); assert.deepEqual(value.roles, ['MANAGING_EDITOR']);
  assert.ok(value.permissions.includes('SOURCE_RESOLVE')); assert.doesNotMatch(JSON.stringify(value), /identity|session|subject|count/i);
}));
for (const actor of ['reporter', 'editor', 'admin'] as const) test(`operations overview permits current ${actor} without inventing resource authority`, async () => fixture(async f => {
  const value = await overview(f, actor); assert.deepEqual(value.roles, f.accounts[actor].identity.roles);
  assert.equal(value.permissions.includes('SOURCE_RESOLVE'), false);
}));
test('operations reject invalid credentials with fixed errors', async () => fixture(async f => {
  await assert.rejects(f.operations().withOverview('PRIVATE_INVALID', () => {}), denied('INVALID_CREDENTIAL'));
}));
test('operations reject a revoked registered session', async () => fixture(async f => {
  await f.repository.transact(state => { state.sessions.find(row => row.id === f.accounts.managing.claims.sessionId)!.revokedAt = at; });
  await assert.rejects(overview(f), denied('SESSION_REVOKED'));
}));
test('operations reject a disabled identity', async () => fixture(async f => {
  await f.repository.transact(state => { state.identities.find(row => row.id === f.accounts.managing.identity.id)!.status = 'DISABLED'; });
  await assert.rejects(overview(f), denied('IDENTITY_DISABLED'));
}));
test('all operations reads preserve repository bytes and every audit collection', async () => fixture(async f => {
  const before = await readFile(f.repository.file, 'utf8');
  await overview(f); await sources(f); await detail(f); await stories(f); await editions(f);
  assert.equal(await readFile(f.repository.file, 'utf8'), before);
}));
test('operations source page exposes only exact assigned source IDs and existing metadata', async () => fixture(async f => {
  const value = await sources(f); assert.equal(value.page.entries.length, 3);
  assert.equal(value.page.entries.some(row => row.sourceId === f.sourceIds.other), false);
  assert.doesNotMatch(JSON.stringify(value), /providerMetadata|actorAssertion|proposedBy|audit|fictional-workflow-cluster/);
  assert.ok(value.page.entries.every(row => row.metadata.canAdvance === false));
}));
test('operations source capabilities distinguish proof and reviewed handoff eligibility', async () => fixture(async f => {
  let value = await sources(f); assert.equal(value.page.entries.find(row => row.sourceId === f.sourceIds.proof)!.proofEligible, true);
  assert.equal(value.page.entries.find(row => row.sourceId === f.sourceIds.pending)!.handoffEligible, false);
  await f.resolvePending(); value = await sources(f);
  assert.equal(value.page.entries.find(row => row.sourceId === f.sourceIds.pending)!.handoffEligible, true);
}));
for (const actor of ['reporter', 'admin'] as const) test(`operations sources require SOURCE_READ role even with ${actor} assignments`, async () => fixture(async f => {
  await assert.rejects(f.operations().withSources(f.accounts[actor].credential, undefined, () => {}), denied('PERMISSION_DENIED'));
}));
test('operations source cursors retain exact authorization context and pagination', async () => fixture(async f => {
  let first!: OperationsSources, second!: OperationsSources;
  await f.operations().withSources(credential(f), { limit: 1 }, value => { first = value; });
  assert.ok(first.page.nextCursor);
  await f.operations().withSources(credential(f), { limit: 1, cursor: first.page.nextCursor! }, value => { second = value; });
  assert.notEqual(first.page.entries[0].sourceId, second.page.entries[0].sourceId);
  await assert.rejects(f.operations(new AssignedResourcePolicy(f.assignments)).withSources(credential(f),
    { limit: 1, cursor: first.page.nextCursor! }, () => {}), error => error instanceof SourceQueueError && error.code === 'STALE_CURSOR');
}));
test('operations reject unknown source query fields and invalid limits', async () => fixture(async f => {
  await assert.rejects(f.operations().withSources(credential(f), { unexpected: 'PRIVATE' } as never, () => {}), error => error instanceof SourceQueueError && error.code === 'INVALID_QUERY');
  await assert.rejects(f.operations().withSources(credential(f), { limit: 0 }, () => {}), error => error instanceof SourceQueueError && error.code === 'INVALID_QUERY');
}));
test('operations source detail hides provider, actors, private history and credentials', async () => fixture(async f => {
  const value = await detail(f); assert.equal(value.sourceId, f.sourceIds.pending); assert.equal(value.review.status, 'UNREVIEWED');
  assert.equal(value.actions.begin, true); assert.equal(value.actions.confirm, false);
  assert.doesNotMatch(JSON.stringify(value), /providerMetadata|proposedBy|actorId|authenticatedActions|credential|subject/);
}));
test('operations cannot inspect an unassigned source or an invalid source identifier', async () => fixture(async f => {
  await assert.rejects(detail(f, f.sourceIds.other), denied('PERMISSION_DENIED'));
  await assert.rejects(detail(f, '../PRIVATE'), denied('DOMAIN_REJECTED'));
}));
test('pending proposal detail requires separate read permission for every proof', async () => fixture(async f => {
  await propose(f);
  const policy = without(f, row => row.identityId === f.accounts.managing.identity.id && row.permission === 'SOURCE_READ' && row.id === f.sourceIds.proof);
  await assert.rejects(detail(f, f.sourceIds.pending, 'managing', policy), denied('PERMISSION_DENIED'));
  const page = await sources(f, policy); assert.equal(page.page.entries.length, 2);
  assert.equal(page.page.entries.find(row => row.sourceId === f.sourceIds.pending)!.handoffEligible, false);
}));
test('pending proposal exposes only classification, origin, assigned evidence, and reason code', async () => fixture(async f => {
  await propose(f); const value = await detail(f);
  assert.deepEqual(value.proposal, { classification: 'SECONDARY', originId: null, evidenceReferences: [f.sourceIds.proof], reasonCode: 'EVIDENCE_SUPPORTED' });
  assert.equal(value.actions.confirm, false); assert.equal(value.actions.reject, false);
}));
test('independent managing editor may resolve while the proposing identity cannot self-confirm', async () => fixture(async f => {
  await propose(f); const value = await detail(f, f.sourceIds.pending, 'confirming');
  assert.equal(value.actions.confirm, true); assert.equal(value.actions.reject, true);
}));
test('editor cannot acquire managing-editor resolution authority from assignments', async () => fixture(async f => {
  await propose(f); const value = await detail(f, f.sourceIds.pending, 'editor');
  assert.equal(value.actions.confirm, false); assert.equal(value.actions.reject, false); assert.equal(value.actions.hold, true);
}));
test('source capability flags require the exact action assignment', async () => fixture(async f => {
  const policy = without(f, row => row.identityId === f.accounts.managing.identity.id && row.permission !== 'SOURCE_READ');
  const value = await detail(f, f.sourceIds.pending, 'managing', policy);
  assert.ok(Object.values(value.actions).every(value => value === false));
}));
test('expired source rights suppress pending proof data and disable every action', async () => fixture(async f => {
  await propose(f);
  await f.repository.transact(state => { state.quarantine.find(row => row.sourceId === f.sourceIds.pending)!.deleteAt = at; });
  const value = await detail(f); assert.equal(value.review.blocked, true); assert.equal(value.proposal, null);
  assert.ok(Object.values(value.actions).every(value => value === false)); assert.equal(value.handoffEligible, false);
}));
for (const mode of ['async', 'nonvoid', 'throw'] as const) test(`operations fail closed for ${mode} resource policies`, async () => fixture(async f => {
  const policy: ResourcePolicy = { sourceReadRevision: () => 'a'.repeat(64), authorize: () => {
    if (mode === 'throw') throw Error('PRIVATE_POLICY_DETAILS');
    return (mode === 'async' ? Promise.resolve() : true) as never;
  } };
  await assert.rejects(sources(f, policy), denied('PERMISSION_DENIED'));
}));
test('operations require a synchronous valid policy epoch even for overview', async () => fixture(async f => {
  assert.throws(() => f.operations({ authorize() {} }), denied('PERMISSION_DENIED'));
  await assert.rejects(overview(f, 'managing', { authorize() {}, sourceReadRevision: () => Promise.resolve('a'.repeat(64)) as never }), denied('PERMISSION_DENIED'));
}));
test('policy receives a deeply frozen state and principal rather than mutable repository state', async () => fixture(async f => {
  const policy: ResourcePolicy = { sourceReadRevision: () => f.resourcePolicy.sourceReadRevision(), authorize(principal, permission, targets, state) {
    assert.ok(Object.isFrozen(state)); assert.ok(Object.isFrozen(state.sources)); assert.ok(Object.isFrozen(principal)); assert.ok(Object.isFrozen(targets));
    f.resourcePolicy.authorize(principal, permission, targets, state);
  } };
  await sources(f, policy);
}));
test('an epoch change during the final disclosure check prevents serialization disclosure', async () => fixture(async f => {
  let epoch = 'a'.repeat(64); const policy: ResourcePolicy = { sourceReadRevision: () => epoch, authorize(principal, permission, targets, state) {
    f.resourcePolicy.authorize(principal, permission, targets, state);
  } };
  await assert.rejects(f.operations(policy).withOverview(credential(f), (_value, assertCurrent) => { epoch = 'b'.repeat(64); assertCurrent(); }), denied('PERMISSION_DENIED'));
}));
test('operations leases reject elapsed time and clock rollback at the trusted serializer boundary', async () => fixture(async f => {
  await assert.rejects(f.operations().withOverview(credential(f), (_value, assertCurrent) => {
    f.clock.now = '2026-06-01T12:00:01.500Z'; assertCurrent();
  }), denied('STALE_TARGET'));
  f.clock.now = at;
  await assert.rejects(f.operations().withOverview(credential(f), (_value, assertCurrent) => {
    f.clock.now = '2026-06-01T11:59:59.999Z'; assertCurrent();
  }), denied());
}));
test('final serializer gate rejects a clock rollback after a successful current projection', async () => fixture(async f => {
  let checks = 0, rollback = false;
  const operations = new AuthenticatedEditorialOperations(f.repository, f.currentAccess, { resourcePolicy: f.resourcePolicy,
    assertPrincipal() {
      if (rollback && ++checks === 2) f.clock.now = '2026-06-01T12:00:00.500Z';
    } });
  await assert.rejects(operations.withOverview(credential(f), (_value, assertCurrent) => {
    f.clock.now = '2026-06-01T12:00:01.000Z'; rollback = true; assertCurrent();
  }), denied('STALE_TARGET'));
}));
test('operations lease is capped by registered session expiration', async () => fixture(async f => {
  f.clock.now = new Date(Date.parse(f.accounts.managing.claims.expiresAt) - 500).toISOString();
  assert.equal((await overview(f)).validForMs, 500);
}));
test('operations source lease is capped by retention expiry and final recheck withholds expired data', async () => fixture(async f => {
  await f.repository.transact(state => { state.managedSources.find(row => row.sourceId === f.sourceIds.proof)!.deleteAt = '2026-06-01T12:00:00.500Z'; });
  const value = await sources(f); assert.equal(value.validForMs, 500);
  await assert.rejects(f.operations().withSources(credential(f), undefined, (_value, assertCurrent) => {
    f.clock.now = '2026-06-01T12:00:00.500Z'; assertCurrent();
  }), denied('STALE_TARGET'));
}));
test('reviewed source detail and page leases include independently assigned proof expiry', async () => fixture(async f => {
  await f.resolvePending();
  await f.repository.transact(state => { state.managedSources.find(row => row.sourceId === f.sourceIds.proof)!.deleteAt = '2026-06-01T12:00:00.350Z'; });
  const page = await sources(f), source = await detail(f);
  assert.equal(page.page.entries.find(row => row.sourceId === f.sourceIds.pending)!.handoffEligible, true);
  assert.equal(page.validForMs, 350); assert.equal(source.validForMs, 350);
  await assert.rejects(f.operations().withSource(credential(f), f.sourceIds.pending, (_value, assertCurrent) => {
    f.clock.now = '2026-06-01T12:00:00.350Z'; assertCurrent();
  }), denied('STALE_TARGET'));
}));
test('a registered revocation committed between preliminary read and guarded read prevents every disclosure', async () => fixture(async f => {
  const original = f.repository.read.bind(f.repository); let preliminary = true, disclosed = false;
  f.repository.read = async () => {
    const snapshot = await original();
    if (preliminary) {
      preliminary = false;
      await f.repository.transact(state => { state.sessions.find(row => row.id === f.accounts.managing.claims.sessionId)!.revokedAt = at; });
    }
    return snapshot;
  };
  await assert.rejects(f.operations().withOverview(credential(f), () => { disclosed = true; }), denied('SESSION_REVOKED'));
  assert.equal(disclosed, false);
}));
test('changing assignments without advancing epoch still fails the final projected-payload check', async () => fixture(async f => {
  let removed = false;
  const policy: ResourcePolicy = { sourceReadRevision: () => 'a'.repeat(64), authorize(principal, permission, targets, state) {
    if (removed && targets.some(row => row.id === f.sourceIds.proof)) throw new SecurityError('PERMISSION_DENIED');
    f.resourcePolicy.authorize(principal, permission, targets, state);
  } };
  await assert.rejects(f.operations(policy).withSources(credential(f), undefined, (_value, assertCurrent) => {
    removed = true; assertCurrent();
  }), denied('STALE_TARGET'));
}));
test('operations principal fence applies to overview and empty story/edition lists', async () => fixture(async f => {
  const operations = new AuthenticatedEditorialOperations(f.repository, f.currentAccess, { resourcePolicy: f.resourcePolicy,
    assertPrincipal() { throw new SecurityError('SESSION_REVOKED'); } });
  await assert.rejects(operations.withOverview(credential(f), () => {}), denied('SESSION_REVOKED'));
  await assert.rejects(operations.withStories(credential(f), () => {}), denied('SESSION_REVOKED'));
  await assert.rejects(operations.withEditions(credential(f), () => {}), denied('SESSION_REVOKED'));
}));
test('operations reject asynchronous and nonvoid disclosure callbacks', async () => fixture(async f => {
  await assert.rejects(f.operations().withOverview(credential(f), async () => {}), denied('DOMAIN_REJECTED'));
  await assert.rejects(f.operations().withOverview(credential(f), (() => true) as never), denied('DOMAIN_REJECTED'));
}));
test('a trusted principal fence cannot authorize through an asynchronous decision', async () => fixture(async f => {
  const operations = new AuthenticatedEditorialOperations(f.repository, f.currentAccess, { resourcePolicy: f.resourcePolicy,
    assertPrincipal: (() => Promise.resolve()) as never });
  await assert.rejects(operations.withOverview(credential(f), () => {}), denied('PERMISSION_DENIED'));
}));
test('the listener revocation fence is rechecked after bounded serialization', async () => fixture(async f => {
  let revoked = false;
  const operations = new AuthenticatedEditorialOperations(f.repository, f.currentAccess, { resourcePolicy: f.resourcePolicy,
    assertPrincipal() { if (revoked) throw new SecurityError('SESSION_REVOKED'); } });
  await assert.rejects(operations.withOverview(credential(f), (_value, assertCurrent) => { revoked = true; assertCurrent(); }), denied('SESSION_REVOKED'));
}));
test('operations story projection exposes explicit human text without private bindings or reviewer assertions', async () => fixture(async f => {
  await prepare(f); const value = await stories(f); assert.equal(value.stories.length, 1);
  const story = value.stories[0]; assert.equal(story.headline, f.humanStory.headline); assert.equal(story.blocked, false);
  assert.deepEqual(story.actions.reviewStatuses, ['CLUSTERED', 'ON_HOLD', 'REJECTED']);
  assert.doesNotMatch(JSON.stringify(value), /sourceHandoff|dependencies|preparedAt|reviewerDecisions|actorId|reviewer|session|snapshotDigest/);
}));
test('STORY_CREATE alone does not grant visibility or inferred ownership of a newly prepared story', async () => fixture(async f => {
  await prepare(f); const policy = without(f, row => row.kind === 'STORY' && row.permission !== 'STORY_CREATE');
  assert.deepEqual((await stories(f, policy)).stories, []);
}));
test('story projection requires READ of stored and current proof dependencies', async () => fixture(async f => {
  await prepare(f); const policy = without(f, row => row.permission === 'SOURCE_READ' && row.id === f.sourceIds.proof);
  assert.deepEqual((await stories(f, policy)).stories, []);
}));
test('story projection withholds prose and source IDs when a current proof changes', async () => fixture(async f => {
  await prepare(f);
  await f.repository.transact(state => { state.sources.find(row => row.id === f.sourceIds.proof)!.verification = 'DISPUTED'; });
  const story = (await stories(f)).stories[0]; assert.equal(story.blocked, true); assert.equal(story.headline, null);
  assert.equal(story.summary, null); assert.deepEqual(story.sourceIds, []); assert.deepEqual(story.evidence, []);
  assert.deepEqual(story.actions, { edit: false, approve: false, reviewStatuses: [] });
}));
test('story projection withholds prose when licensed rights expire', async () => fixture(async f => {
  await prepare(f);
  await f.repository.transact(state => { state.managedSources.find(row => row.sourceId === f.sourceIds.pending)!.deleteAt = at; });
  const story = (await stories(f)).stories[0]; assert.equal(story.blocked, true); assert.equal(story.headline, null);
}));
test('story cap is applied after exact assignment filtering', async () => fixture(async f => {
  await prepare(f);
  await f.repository.transact(state => {
    const template = state.revisions.find(row => row.id === f.humanStory.id)!;
    for (let index = 0; index < 12; index++) {
      const hidden = { ...structuredClone(template), id: `a-hidden-${index}` }; delete hidden.sourceHandoff; state.revisions.push(hidden);
    }
  });
  const value = await stories(f); assert.equal(value.stories.length, 1); assert.equal(value.stories[0].id, f.humanStory.id);
}));
test('a retention replacement ID is not visible under an old story assignment', async () => fixture(async f => {
  await prepare(f);
  await f.repository.transact(state => {
    state.revisions = state.revisions.map(row => { const result = structuredClone(row); result.id = 'retention-replacement-unassigned';
      delete result.sourceHandoff; result.retentionRedacted = true; result.headline = ''; result.summary = ''; result.evidence = []; result.sourceIds = []; return result; });
  });
  assert.deepEqual((await stories(f)).stories, []);
}));
test('story approvals are advertised only for exact assigned current NEEDS_REVIEW revisions', async () => fixture(async f => {
  let row = await prepare(f);
  for (const status of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW'] as const) row = await f.editorial.reviewStory(credential(f), row.id, row.version, status);
  assert.equal((await stories(f)).stories[0].actions.approve, true);
  assert.equal((await stories(f, undefined, 'editor')).stories[0].actions.approve, false);
  assert.equal((await stories(f)).stories[0].actions.reviewStatuses.includes('PUBLISHED'), false);
}));
test('story edit capabilities follow the existing ON_HOLD lifecycle restriction', async () => fixture(async f => {
  const row = await prepare(f); await f.editorial.reviewStory(credential(f), row.id, row.version, 'ON_HOLD');
  const value = (await stories(f)).stories[0]; assert.equal(value.actions.edit, false);
  assert.deepEqual(value.actions.reviewStatuses, ['DRAFT', 'REJECTED']);
}));
test('oversized projected prose is rejected before disclosure and without a repository write', async () => fixture(async f => {
  await prepare(f);
  await f.repository.transact(state => {
    const row = state.revisions[0]; delete row.sourceHandoff; row.summary = 'FICTIONAL '.repeat(30_000);
  });
  const before = await readFile(f.repository.file, 'utf8'); let disclosed = false;
  await assert.rejects(f.operations().withStories(credential(f), () => { disclosed = true; }), denied('STORAGE_UNAVAILABLE'));
  assert.equal(disclosed, false); assert.equal(await readFile(f.repository.file, 'utf8'), before);
}));
test('edition allocation permission does not confer ownership of the created edition', async () => fixture(async f => {
  await assembled(f); assert.deepEqual((await editions(f)).editions, []);
}));
test('edition projection requires exact edition and all contained story grants and never exposes prose', async () => fixture(async f => {
  const { edition, policy } = await assembled(f); const value = await editions(f, policy);
  assert.equal(value.editions.length, 1); assert.equal(value.editions[0].id, edition.id); assert.equal(value.editions[0].storyCount, 1);
  assert.equal(value.editions[0].available, true); assert.deepEqual(value.editions[0].actions.reviewStatuses, ['NEEDS_REVIEW', 'ON_HOLD', 'REJECTED']);
  assert.doesNotMatch(JSON.stringify(value), /headline|summary|sourceId|evidence|actorAssertion|reviewer|snapshotDigest/);
}));
test('edition projection omits the whole edition when a contained story lacks the same action assignment', async () => fixture(async f => {
  const { edition } = await assembled(f);
  const policy = new AssignedResourcePolicy([...f.assignments.filter(row => row.kind !== 'STORY'),
    { identityId: f.accounts.managing.identity.id, kind: 'EDITION', id: edition.id, permission: 'EDITION_REVIEW' }]);
  assert.deepEqual((await editions(f, policy)).editions, []);
}));
test('edition projection omits the whole edition when any stored proof is unassigned', async () => fixture(async f => {
  const { edition } = await assembled(f);
  const policy = new AssignedResourcePolicy([...f.assignments.filter(row => !(row.permission === 'SOURCE_READ' && row.id === f.sourceIds.proof)),
    { identityId: f.accounts.managing.identity.id, kind: 'EDITION', id: edition.id, permission: 'EDITION_REVIEW' }]);
  assert.deepEqual((await editions(f, policy)).editions, []);
}));
test('edition projection omits expired licensed payload and preserves repository bytes', async () => fixture(async f => {
  const { policy } = await assembled(f);
  await f.repository.transact(state => { state.managedSources.find(row => row.sourceId === f.sourceIds.pending)!.deleteAt = at; });
  const before = await readFile(f.repository.file, 'utf8'); assert.deepEqual((await editions(f, policy)).editions, []);
  assert.equal(await readFile(f.repository.file, 'utf8'), before);
}));
