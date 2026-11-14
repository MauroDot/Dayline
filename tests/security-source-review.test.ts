import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSecurityFixture } from '../fixtures/security-fiction.ts';
import { ingestArticles, sourceId } from '../src/ingestion/ingest.ts';
import { cleanupRetention } from '../src/ingestion/retention.ts';
import { eligibleSource } from '../src/ingestion/eligibility.ts';
import { getPolicy } from '../src/ingestion/policies.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { AccessControl } from '../src/security/service.ts';
import { AssignedResourcePolicy, type ResourceAssignment, type ResourcePolicy } from '../src/security/resources.ts';
import { AuthenticatedSourceReview } from '../src/security/source-review.ts';
import { AuthenticatedSourceQueue } from '../src/security/source.ts';
import { SecurityError } from '../src/security/verifier.ts';
import type { Permission } from '../src/security/types.ts';
import { SourceQueueError } from '../src/source-queue/service.ts';

const at = '2026-06-01T12:00:00.000Z';
const privateValue = 'FICTIONAL_PRIVATE_SOURCE_REVIEW_924b';
const context = { providerId: 'fictional-fixture', policyId: 'fictional-metadata-v1' };
const sourcePermissions: Permission[] = ['SOURCE_READ', 'SOURCE_REVIEW', 'SOURCE_RESOLVE', 'SOURCE_HOLD', 'SOURCE_RELEASE'];
const article = (name: string, type: ProviderArticle['provenance']['type'] = 'UNKNOWN'): ProviderArticle => ({
  providerId: context.providerId, url: `https://review-security.example.test/${name}`, publisher: `Fictional ${name}`,
  publishedAt: at, retrievedAt: at, provenance: { type, originId: null } as ProviderArticle['provenance'],
});
type SecurityFixture = Awaited<ReturnType<typeof seedSecurityFixture>>;
type Accounts = SecurityFixture['accounts'];
interface Fixture {
  repository: JsonRepository; security: SecurityFixture; access: AccessControl;
  clock: { now: string }; ids: { pending: string; evidence: string; other: string };
  policy: AssignedResourcePolicy; grants: ResourceAssignment[];
  workflow(policy?: ResourcePolicy): AuthenticatedSourceReview;
}
async function fixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-review-security-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const security = await seedSecurityFixture(repository, at);
    const clock = { now: at }, access = new AccessControl(repository, { verifier: security.verifier, clock: () => clock.now });
    const pending = article('pending'), evidence = article('evidence', 'ORIGINAL'), other = article('other');
    const counts = await ingestArticles(repository, [pending, evidence, other], context, { dryRun: false, clock: () => at,
      resolutions: [{ sourceId: sourceId(evidence.url), classification: 'ORIGINAL', originId: null, at,
        actorAssertion: privateValue, reason: privateValue, evidenceReferences: [privateValue] }] });
    assert.deepEqual(counts, { processed: 1, duplicate: 0, rejected: 0, quarantined: 2, failed: 0 });
    await repository.transact(state => { state.sources.find(row => row.id === sourceId(evidence.url))!.verification = 'VERIFIED'; });
    const ids = { pending: sourceId(pending.url), evidence: sourceId(evidence.url), other: sourceId(other.url) };
    const grants: ResourceAssignment[] = Object.values(security.accounts).flatMap(account => Object.values(ids).flatMap(id =>
      sourcePermissions.map(permission => ({ identityId: account.identity.id, permission, kind: 'SOURCE' as const, id }))));
    const policy = new AssignedResourcePolicy(grants);
    await run({ repository, security, access, clock, ids, policy, grants,
      workflow(resourcePolicy = policy) { return new AuthenticatedSourceReview(repository, access, { resourcePolicy }); } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function denied(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof SecurityError); assert.equal(error.code, expected); assert.equal(error.message, expected);
    assert.doesNotMatch(JSON.stringify(error), /FICTIONAL_PRIVATE|review-security|fictional\.json|dayline-source-review/);
    return true;
  };
}
async function input(f: Fixture, actor: keyof Accounts = 'editor', id = f.ids.pending, reasonCode = 'INITIAL_REVIEW' as const) {
  return { revision: (await f.workflow().inspect(f.security.accounts[actor].credential, id)).revision,
    reasonCode, evidenceReferences: [f.ids.evidence] };
}
async function begin(f: Fixture, actor: keyof Accounts = 'editor', id = f.ids.pending) {
  return f.workflow().begin(f.security.accounts[actor].credential, id, await input(f, actor, id));
}
async function propose(f: Fixture, actor: keyof Accounts = 'editor', classification = 'ORIGINAL' as 'ORIGINAL' | 'DISPUTED' | 'SYNDICATED', originId: string | null = null) {
  const workflow = f.workflow(), credential = f.security.accounts[actor].credential;
  const current = await workflow.inspect(credential, f.ids.pending);
  if (current.status === 'UNREVIEWED') await begin(f, actor);
  const revision = (await workflow.inspect(credential, f.ids.pending)).revision;
  return workflow.propose(credential, f.ids.pending, { revision, reasonCode: classification === 'DISPUTED' ? 'CONTRADICTORY_EVIDENCE' : 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence], classification, originId });
}
async function unchanged(f: Fixture, action: () => Promise<unknown>, code: string): Promise<void> {
  const before = await readFile(f.repository.file, 'utf8');
  await assert.rejects(action(), denied(code));
  assert.equal(await readFile(f.repository.file, 'utf8'), before, 'rejected actions must not leave partial content or success receipts');
}

test('an assigned editor proposes metadata without resolving it and an independent managing editor confirms atomically', async () => fixture(async f => {
  const workflow = f.workflow(), before = await f.repository.read();
  assert.equal((await workflow.inspect(f.security.accounts.editor.credential, f.ids.pending)).status, 'UNREVIEWED');
  assert.equal((await begin(f)).status, 'UNDER_REVIEW');
  const proposed = await propose(f), pending = await f.repository.read();
  assert.equal(proposed.status, 'PROPOSED'); assert.equal(proposed.pendingProposal, true); assert.equal(proposed.independentlyResolved, false);
  for (const key of ['sources', 'managedSources', 'quarantine', 'provenanceDecisions'] as const) assert.deepEqual(pending[key], before[key], key);
  const original = before.quarantine.find(row => row.sourceId === f.ids.pending)!;
  const confirmed = await workflow.confirm(f.security.accounts.managing.credential, f.ids.pending,
    { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence] });
  assert.equal(confirmed.status, 'RESOLVED'); assert.equal(confirmed.pendingProposal, false); assert.equal(confirmed.independentlyResolved, true);
  const after = await f.repository.read(), record = after.managedSources.find(row => row.sourceId === f.ids.pending)!;
  assert.ok(record); assert.equal(after.quarantine.some(row => row.sourceId === f.ids.pending), false);
  assert.deepEqual(record.policy, original.policy); assert.equal(record.deleteAt, original.deleteAt); assert.equal(record.retainedAt, original.retainedAt);
  assert.deepEqual(record.providerMetadata, original.providerMetadata); assert.deepEqual(record.providerProvenance, { type: 'UNKNOWN', originId: null });
  assert.equal(after.sources.find(row => row.id === f.ids.pending)!.type, 'ORIGINAL');
  assert.equal(after.provenanceDecisions.filter(row => row.sourceId === f.ids.pending).length, 1);
  assert.ok(after.authenticatedActions.some(row => row.permission === 'SOURCE_RESOLVE' && row.resourceKind === 'SOURCE' && row.resourceId === f.ids.pending));
  for (const key of ['revisions', 'approvals', 'drafts', 'draftReviews', 'editions', 'editionReviews', 'schedules', 'preparationRuns'] as const) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.audit.some(row => /PUBLISHED|STORY_APPROVED|EDITION_READY/.test(row.action)), false);
}));

test('inspection exposes only bounded safe status and opaque exact revision, never review evidence or principal IDs', async () => fixture(async f => {
  await propose(f);
  const summary = await f.workflow().inspect(f.security.accounts.editor.credential, f.ids.pending);
  assert.deepEqual(Object.keys(summary).sort(), ['blocked', 'independentlyResolved', 'pendingProposal', 'reviewAllowed', 'reviewRevision', 'revision', 'status']);
  assert.match(summary.revision, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(summary);
  for (const secret of [privateValue, f.ids.pending, f.ids.evidence, f.security.accounts.editor.identity.id,
    f.security.accounts.editor.credential, f.repository.file]) assert.equal(serialized.includes(secret), false);
}));

test('detailed inspection requires proof-source grants while target-only queue visibility remains minimal', async () => fixture(async f => {
  const proposed = await propose(f), credential = f.security.accounts.editor.credential;
  const policy = new AssignedResourcePolicy([{ identityId: f.security.accounts.editor.identity.id,
    permission: 'SOURCE_READ', kind: 'SOURCE', id: f.ids.pending }]);
  const restricted = f.workflow(policy), queue = new AuthenticatedSourceQueue(f.repository, f.access, { resourcePolicy: policy });
  const visible = async (status: 'PROPOSED' | 'RESOLVED') => {
    const before = await readFile(f.repository.file, 'utf8');
    await assert.rejects(restricted.inspect(credential, f.ids.pending), denied('PERMISSION_DENIED'));
    const page = await queue.read(credential);
    assert.equal(page.entries.length, 1); assert.equal(page.nextCursor, null);
    const review = page.entries[0].review; assert.ok(review);
    assert.deepEqual(Object.keys(review).sort(), ['blocked', 'independentlyResolved', 'proposalPending', 'reviewAllowed', 'revision', 'status']);
    assert.equal(review.status, status); assert.ok(Number.isSafeInteger(review.revision));
    assert.equal(review.proposalPending, status === 'PROPOSED');
    assert.equal(review.independentlyResolved, status === 'RESOLVED');
    const serialized = JSON.stringify(page);
    for (const hidden of [f.ids.evidence, 'Fictional evidence', 'https://review-security.example.test/evidence',
      proposed.revision, f.security.accounts.editor.identity.id, f.security.accounts.managing.identity.id]) assert.equal(serialized.includes(hidden), false);
    assert.equal(await readFile(f.repository.file, 'utf8'), before);
  };
  await visible('PROPOSED');
  await f.workflow().confirm(f.security.accounts.managing.credential, f.ids.pending,
    { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence] });
  await visible('RESOLVED');
}));

for (const role of ['reporter', 'admin'] as const) test(`${role} cannot inspect or review despite exact assignments for every source permission`, async () => fixture(async f => {
  const workflow = f.workflow(), credential = f.security.accounts[role].credential;
  await assert.rejects(workflow.inspect(credential, f.ids.pending), denied('PERMISSION_DENIED'));
  const valid = await input(f);
  await unchanged(f, () => workflow.begin(credential, f.ids.pending, valid), 'PERMISSION_DENIED');
}));

test('editor inspection and proposal authority do not imply resolution or hold-release permission', async () => fixture(async f => {
  const workflow = f.workflow(), proposed = await propose(f);
  const decision = { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED' as const, evidenceReferences: [f.ids.evidence] };
  await unchanged(f, () => workflow.confirm(f.security.accounts.editor.credential, f.ids.pending, decision), 'PERMISSION_DENIED');
  await unchanged(f, () => workflow.reject(f.security.accounts.editor.credential, f.ids.pending,
    { ...decision, reasonCode: 'INSUFFICIENT_EVIDENCE' }), 'PERMISSION_DENIED');
}));

test('a managing editor cannot confirm their own proposal using their authenticated identity', async () => fixture(async f => {
  const proposal = await propose(f, 'managing');
  await unchanged(f, () => f.workflow().confirm(f.security.accounts.managing.credential, f.ids.pending,
    { revision: proposal.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence] }), 'PERMISSION_DENIED');
}));

test('a second registered session for the same proposer does not evade independent confirmation', async () => fixture(async f => {
  const proposal = await propose(f, 'managing'), claims = { ...f.security.accounts.managing.claims, sessionId: randomUUID() };
  const secondCredential = f.security.verifier.issue(claims); await f.access.registerSession(secondCredential);
  await unchanged(f, () => f.workflow().confirm(secondCredential, f.ids.pending,
    { revision: proposal.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence] }), 'PERMISSION_DENIED');
}));

test('promoting the proposing editor to managing editor cannot enable self-confirmation', async () => fixture(async f => {
  const proposal = await propose(f), account = f.security.accounts.editor;
  await f.access.setRoles(f.security.accounts.admin.credential, account.identity.id, 1, ['MANAGING_EDITOR']);
  // Identity changes may stale the token before the independent-identity check; use the current exact revision.
  const revision = (await f.workflow().inspect(account.credential, f.ids.pending)).revision;
  assert.ok(proposal.pendingProposal);
  await unchanged(f, () => f.workflow().confirm(account.credential, f.ids.pending,
    { revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence] }), 'PERMISSION_DENIED');
}));

for (const credential of [undefined, null, '', 'not-a-credential', 'a.b.c']) test(`source review rejects missing or invalid credential ${String(credential)}`, async () => fixture(async f => {
  const valid = await input(f);
  await unchanged(f, () => f.workflow().begin(credential, f.ids.pending, valid), 'INVALID_CREDENTIAL');
}));

test('a correctly signed but unregistered session cannot inspect or mutate source review', async () => fixture(async f => {
  const valid = await input(f), claims = { ...f.security.accounts.editor.claims, sessionId: randomUUID() };
  const credential = f.security.verifier.issue(claims);
  await assert.rejects(f.workflow().inspect(credential, f.ids.pending), denied('INVALID_SESSION'));
  await unchanged(f, () => f.workflow().begin(credential, f.ids.pending, valid), 'INVALID_SESSION');
}));

test('session expiry takes effect at its exact boundary and creates no review receipt', async () => fixture(async f => {
  const valid = await input(f); f.clock.now = f.security.accounts.editor.claims.expiresAt;
  await unchanged(f, () => f.workflow().begin(f.security.accounts.editor.credential, f.ids.pending, valid), 'SESSION_EXPIRED');
}));

test('a revoked registered session cannot continue a pending review', async () => fixture(async f => {
  const proposed = await propose(f), account = f.security.accounts.editor;
  await f.access.invalidateSession(account.credential);
  await unchanged(f, () => f.workflow().withdraw(account.credential, f.ids.pending,
    { revision: proposed.revision, reasonCode: 'WITHDRAWN', evidenceReferences: [f.ids.evidence] }), 'SESSION_REVOKED');
}));

test('credential rotation invalidates an earlier source reviewer session', async () => fixture(async f => {
  const valid = await input(f), account = f.security.accounts.editor;
  await f.access.rotateCredentials(f.security.accounts.admin.credential, account.identity.id, 1);
  await unchanged(f, () => f.workflow().begin(account.credential, f.ids.pending, valid), 'INVALID_SESSION');
}));

test('identity disablement takes effect before source-review mutation', async () => fixture(async f => {
  const valid = await input(f), account = f.security.accounts.editor;
  await f.access.setStatus(f.security.accounts.admin.credential, account.identity.id, 1, 'DISABLED');
  await unchanged(f, () => f.workflow().begin(account.credential, f.ids.pending, valid), 'IDENTITY_DISABLED');
}));

test('demotion removes source-review permission without changing bearer claims', async () => fixture(async f => {
  const valid = await input(f), account = f.security.accounts.editor;
  await f.access.setRoles(f.security.accounts.admin.credential, account.identity.id, 1, ['REPORTER']);
  await unchanged(f, () => f.workflow().begin(account.credential, f.ids.pending, valid), 'PERMISSION_DENIED');
}));

test('read permission, action permission and exact target assignment are independently required', async () => fixture(async f => {
  const account = f.security.accounts.editor, valid = await input(f);
  const variants = [
    f.grants.filter(row => !(row.identityId === account.identity.id && row.permission === 'SOURCE_READ' && row.id === f.ids.pending)),
    f.grants.filter(row => !(row.identityId === account.identity.id && row.permission === 'SOURCE_REVIEW' && row.id === f.ids.pending)),
    f.grants.filter(row => !(row.identityId === account.identity.id && row.id === f.ids.pending)),
  ];
  for (const grants of variants) {
    const policy = new AssignedResourcePolicy(grants);
    await unchanged(f, () => f.workflow(policy).begin(account.credential, f.ids.pending, valid), 'PERMISSION_DENIED');
  }
}));

test('an inaccessible evidence source cannot be used to authorize a recommendation', async () => fixture(async f => {
  await begin(f); const account = f.security.accounts.editor;
  const revision = (await f.workflow().inspect(account.credential, f.ids.pending)).revision;
  const policy = new AssignedResourcePolicy(f.grants.filter(row => !(row.identityId === account.identity.id && row.permission === 'SOURCE_READ' && row.id === f.ids.evidence)));
  await unchanged(f, () => f.workflow(policy).propose(account.credential, f.ids.pending,
    { revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence], classification: 'ORIGINAL', originId: null }), 'PERMISSION_DENIED');
}));

test('target revision is bound to source identity and cannot be replayed onto another assigned source', async () => fixture(async f => {
  const valid = await input(f);
  await unchanged(f, () => f.workflow().begin(f.security.accounts.editor.credential, f.ids.other, valid), 'STALE_TARGET');
}));

test('duplicate begin and repeated confirmation fail without new history or success receipts', async () => fixture(async f => {
  const started = await begin(f);
  await unchanged(f, () => f.workflow().begin(f.security.accounts.editor.credential, f.ids.pending,
    { revision: started.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: [f.ids.evidence] }), 'DOMAIN_REJECTED');
  const proposed = await propose(f), workflow = f.workflow();
  const decision = { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED' as const, evidenceReferences: [f.ids.evidence] };
  const confirmed = await workflow.confirm(f.security.accounts.managing.credential, f.ids.pending, decision);
  await unchanged(f, () => workflow.confirm(f.security.accounts.managing.credential, f.ids.pending, decision), 'STALE_TARGET');
  await unchanged(f, () => workflow.confirm(f.security.accounts.managing.credential, f.ids.pending,
    { ...decision, revision: confirmed.revision }), 'DOMAIN_REJECTED');
}));

test('a stale proposal revision cannot overwrite a later hold decision', async () => fixture(async f => {
  const proposed = await propose(f);
  await f.workflow().hold(f.security.accounts.editor.credential, f.ids.pending,
    { revision: proposed.revision, reasonCode: 'REVIEW_HOLD', evidenceReferences: [f.ids.evidence] });
  await unchanged(f, () => f.workflow().confirm(f.security.accounts.managing.credential, f.ids.pending,
    { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence] }), 'STALE_TARGET');
}));

test('placing a source hold blocks eligibility and only explicit release authority restores review', async () => fixture(async f => {
  const workflow = f.workflow(), source = (await f.repository.read()).sources.find(row => row.id === f.ids.evidence)!;
  assert.equal(eligibleSource(await f.repository.read(), source, at), true);
  const revision = (await workflow.inspect(f.security.accounts.editor.credential, f.ids.evidence)).revision;
  const held = await workflow.hold(f.security.accounts.editor.credential, f.ids.evidence,
    { revision, reasonCode: 'REVIEW_HOLD', evidenceReferences: [f.ids.evidence] });
  assert.equal(held.status, 'ON_HOLD'); assert.equal(held.blocked, true);
  assert.ok((await f.repository.read()).authenticatedActions.some(row => row.permission === 'SOURCE_HOLD'
    && row.resourceKind === 'SOURCE' && row.resourceId === f.ids.evidence && row.resourceVersion === held.reviewRevision));
  assert.equal(eligibleSource(await f.repository.read(), source, at), false);
  const release = { revision: held.revision, reasonCode: 'HOLD_RELEASED' as const, evidenceReferences: [f.ids.evidence] };
  await unchanged(f, () => workflow.release(f.security.accounts.editor.credential, f.ids.evidence, release), 'PERMISSION_DENIED');
  assert.equal((await workflow.release(f.security.accounts.managing.credential, f.ids.evidence, release)).status, 'UNDER_REVIEW');
  assert.equal((await f.repository.read()).retentionReviewRequired, false);
}));

test('release cannot clear the independent repository-wide retention review hold', async () => fixture(async f => {
  const revision = (await f.workflow().inspect(f.security.accounts.editor.credential, f.ids.pending)).revision;
  await f.workflow().hold(f.security.accounts.editor.credential, f.ids.pending,
    { revision, reasonCode: 'REVIEW_HOLD', evidenceReferences: [f.ids.evidence] });
  await f.repository.transact(state => { state.retentionReviewRequired = true; });
  const current = await f.workflow().inspect(f.security.accounts.managing.credential, f.ids.pending);
  await unchanged(f, () => f.workflow().release(f.security.accounts.managing.credential, f.ids.pending,
    { revision: current.revision, reasonCode: 'HOLD_RELEASED', evidenceReferences: [f.ids.evidence] }), 'DOMAIN_REJECTED');
  assert.equal((await f.repository.read()).retentionReviewRequired, true);
}));

test('an independently accepted dispute leaves the candidate blocked and quarantined', async () => fixture(async f => {
  const proposed = await propose(f, 'editor', 'DISPUTED');
  const confirmed = await f.workflow().confirm(f.security.accounts.managing.credential, f.ids.pending,
    { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence] });
  assert.equal(confirmed.status, 'DISPUTED'); assert.equal(confirmed.blocked, true);
  const state = await f.repository.read();
  assert.equal(state.sources.some(row => row.id === f.ids.pending), false);
  assert.equal(state.quarantine.some(row => row.sourceId === f.ids.pending), true);
  assert.ok(state.authenticatedActions.some(row => row.permission === 'SOURCE_RESOLVE'
    && row.resourceId === f.ids.pending && row.resourceVersion === confirmed.reviewRevision));
}));

test('independent rejection does not resolve or promote a pending source', async () => fixture(async f => {
  const proposed = await propose(f);
  const rejected = await f.workflow().reject(f.security.accounts.managing.credential, f.ids.pending,
    { revision: proposed.revision, reasonCode: 'INSUFFICIENT_EVIDENCE', evidenceReferences: [f.ids.evidence] });
  assert.equal(rejected.status, 'REJECTED'); assert.equal(rejected.blocked, true); assert.equal(rejected.pendingProposal, false);
  assert.equal((await f.repository.read()).sources.some(row => row.id === f.ids.pending), false);
}));

test('syndication without an eligible resolved original is rejected without inferred independence', async () => fixture(async f => {
  await begin(f); const revision = (await f.workflow().inspect(f.security.accounts.editor.credential, f.ids.pending)).revision;
  await unchanged(f, () => f.workflow().propose(f.security.accounts.editor.credential, f.ids.pending,
    { revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.other], classification: 'SYNDICATED', originId: f.ids.other }), 'DOMAIN_REJECTED');
}));

test('provider assertions cannot be contradicted or silently rewritten by a provenance recommendation', async () => fixture(async f => {
  await f.repository.transact(state => { state.quarantine.find(row => row.sourceId === f.ids.pending)!.providerProvenance = { type: 'ORIGINAL', originId: null }; });
  await begin(f);
  const current = await f.workflow().inspect(f.security.accounts.editor.credential, f.ids.pending);
  await unchanged(f, () => f.workflow().propose(f.security.accounts.editor.credential, f.ids.pending,
    { revision: current.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence], classification: 'SECONDARY', originId: null }), 'DOMAIN_REJECTED');
}));

test('an unverified provider assertion cannot count itself as independently verified evidence', async () => fixture(async f => {
  await begin(f); const current = await f.workflow().inspect(f.security.accounts.editor.credential, f.ids.pending);
  await unchanged(f, () => f.workflow().propose(f.security.accounts.editor.credential, f.ids.pending,
    { revision: current.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.pending], classification: 'ORIGINAL', originId: null }), 'DOMAIN_REJECTED');
}));

test('a deleted assigned source cannot be restored by begin or confirmation', async () => fixture(async f => {
  const proposed = await propose(f);
  await f.repository.transact(state => { state.deletions.push({ sourceId: f.ids.pending, at, expiresAt: '2026-06-02T12:00:00.000Z', reason: 'FICTIONAL_RETENTION_DELETE' }); });
  const current = await f.workflow().inspect(f.security.accounts.managing.credential, f.ids.pending);
  assert.equal(current.status, 'WITHDRAWN'); assert.equal(current.reviewAllowed, false);
  assert.notEqual(current.revision, proposed.revision);
  await unchanged(f, () => f.workflow().confirm(f.security.accounts.managing.credential, f.ids.pending,
    { revision: current.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence] }), 'DOMAIN_REJECTED');
}));

test('a valid syndicated proposal preserves the independently verified original linkage', async () => fixture(async f => {
  const proposed = await propose(f, 'editor', 'SYNDICATED', f.ids.evidence);
  await f.workflow().confirm(f.security.accounts.managing.credential, f.ids.pending,
    { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence] });
  const state = await f.repository.read(), source = state.sources.find(row => row.id === f.ids.pending)!;
  assert.equal(source.type, 'SYNDICATED'); assert.equal(source.originId, f.ids.evidence);
  assert.equal(eligibleSource(state, source, at), true);
}));

test('rights expiry during a pending proposal prevents confirmation and metadata renewal', async () => fixture(async f => {
  const proposal = await propose(f), before = await f.repository.read();
  await f.repository.transact(state => { state.quarantine.find(row => row.sourceId === f.ids.pending)!.deleteAt = '2026-06-01T12:00:01.000Z'; });
  f.clock.now = '2026-06-01T12:00:01.000Z';
  const current = await f.workflow().inspect(f.security.accounts.managing.credential, f.ids.pending);
  assert.equal(current.status, 'EXPIRED'); assert.equal(current.reviewAllowed, false);
  await unchanged(f, () => f.workflow().confirm(f.security.accounts.managing.credential, f.ids.pending,
    { revision: current.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence] }), 'DOMAIN_REJECTED');
  assert.equal(before.quarantine.find(row => row.sourceId === f.ids.pending)!.deleteAt, '2026-06-02T12:00:00.000Z');
  assert.notEqual(proposal.revision, current.revision);
}));

for (const policyId of ['fictional-revoked-v1', 'fictional-superseded-v1']) test(`${policyId} cannot be overridden by an authenticated provenance decision`, async () => fixture(async f => {
  await propose(f);
  const policy = getPolicy(context.providerId, context.policyId, at);
  await f.repository.transact(state => { state.quarantine.find(row => row.sourceId === f.ids.pending)!.policy = { ...policy, id: policyId, reviewStatus: policyId.includes('revoked') ? 'REVOKED' : 'SUPERSEDED', evidenceReference: `fictional-fixture-only:${policyId}` }; });
  const current = await f.workflow().inspect(f.security.accounts.managing.credential, f.ids.pending);
  assert.equal(current.reviewAllowed, false);
  await unchanged(f, () => f.workflow().confirm(f.security.accounts.managing.credential, f.ids.pending,
    { revision: current.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence] }), 'DOMAIN_REJECTED');
}));

test('retention cleanup removes linked review history and authenticated source receipts', async () => fixture(async f => {
  await propose(f);
  await f.repository.transact(state => { state.quarantine.find(row => row.sourceId === f.ids.pending)!.deleteAt = at; });
  await cleanupRetention(f.repository, at, false);
  const state = await f.repository.read();
  assert.equal(state.sourceReviews?.some(row => row.sourceId === f.ids.pending), false);
  assert.equal(state.authenticatedActions.some(row => row.resourceKind === 'SOURCE' && row.resourceId === f.ids.pending), false);
  assert.equal(state.retentionReviewRequired, true);
  const serialized = JSON.stringify(state.sourceReviews ?? []);
  assert.equal(serialized.includes(f.ids.pending), false);
}));

for (const variant of ['missing', 'empty', 'duplicate', 'malformed'] as const) test(`${variant} review evidence fails closed before mutation`, async () => fixture(async f => {
  const valid = await input(f);
  const inputValue: unknown = variant === 'missing' ? { revision: valid.revision, reasonCode: 'INITIAL_REVIEW' }
    : { ...valid, evidenceReferences: variant === 'empty' ? [] : variant === 'duplicate' ? [f.ids.evidence, f.ids.evidence] : [null] };
  await unchanged(f, () => f.workflow().begin(f.security.accounts.editor.credential, f.ids.pending, inputValue as typeof valid), 'DOMAIN_REJECTED');
}));

for (const extra of ['actorId', 'actorAssertion', 'at', 'policy', 'deleteAt', 'permission', 'approvedBy']) test(`caller-supplied ${extra} cannot select review authority or extend data rights`, async () => fixture(async f => {
  const valid = await input(f), forged = { ...valid, [extra]: privateValue };
  await unchanged(f, () => f.workflow().begin(f.security.accounts.editor.credential, f.ids.pending, forged), 'DOMAIN_REJECTED');
}));

test('prototype-bearing and accessor input is rejected without invoking authority getters', async () => fixture(async f => {
  const valid = await input(f); let invoked = 0;
  const getter = Object.defineProperty({ revision: valid.revision, reasonCode: 'INITIAL_REVIEW' }, 'evidenceReferences',
    { enumerable: true, get() { invoked++; return [f.ids.evidence]; } });
  await unchanged(f, () => f.workflow().begin(f.security.accounts.editor.credential, f.ids.pending, getter as typeof valid), 'DOMAIN_REJECTED');
  assert.equal(invoked, 0);
  const inherited = Object.assign(Object.create({ authority: true }) as typeof valid, valid);
  await unchanged(f, () => f.workflow().begin(f.security.accounts.editor.credential, f.ids.pending, inherited), 'DOMAIN_REJECTED');
}));

test('source actions cannot be redirected through candidate display hashes or arbitrary filesystem paths', async () => fixture(async f => {
  const valid = await input(f);
  for (const [id, code] of [['../private/fictional.json', 'DOMAIN_REJECTED'],
    ['https://review-security.example.test/pending', 'PERMISSION_DENIED'], ['candidate-' + 'a'.repeat(64), 'PERMISSION_DENIED']]) {
    await unchanged(f, () => f.workflow().begin(f.security.accounts.editor.credential, id, valid), code);
  }
}));

test('a relevant source-review decision invalidates an existing authorized queue cursor', async () => fixture(async f => {
  const queue = new AuthenticatedSourceQueue(f.repository, f.access, { resourcePolicy: f.policy });
  const page = await queue.read(f.security.accounts.editor.credential, { limit: 1 }); assert.ok(page.nextCursor);
  await begin(f);
  await assert.rejects(queue.read(f.security.accounts.editor.credential, { limit: 1, cursor: page.nextCursor! }), error => {
    assert.ok(error instanceof SourceQueueError); assert.equal(error.code, 'STALE_CURSOR'); return true;
  });
}));
