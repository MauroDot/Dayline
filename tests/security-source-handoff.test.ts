import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSecurityFixture } from '../fixtures/security-fiction.ts';
import { ingestArticles, sourceId } from '../src/ingestion/ingest.ts';
import { cleanupRetention } from '../src/ingestion/retention.ts';
import { getPolicy, policyStatus } from '../src/ingestion/policies.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { Newsroom } from '../src/newsroom/service.ts';
import type { Story } from '../src/newsroom/model.ts';
import { AccessControl } from '../src/security/service.ts';
import { AssignedResourcePolicy, editionSlot, type ResourceAssignment, type ResourcePolicy } from '../src/security/resources.ts';
import { AuthenticatedEditorial } from '../src/security/editorial.ts';
import { AuthenticatedSourceReview } from '../src/security/source-review.ts';
import { AuthenticatedSourceHandoff } from '../src/security/source-handoff.ts';
import { SecurityError } from '../src/security/verifier.ts';
import type { Permission } from '../src/security/types.ts';

const at = '2026-06-01T12:00:00.000Z';
const privateValue = 'FICTIONAL_PRIVATE_HANDOFF_098c';
const storyId = 'fictional-handoff-story';
const sourcePermissions: Permission[] = ['SOURCE_READ', 'SOURCE_REVIEW', 'SOURCE_RESOLVE', 'SOURCE_HOLD', 'SOURCE_RELEASE'];
const storyPermissions: Permission[] = ['STORY_CREATE', 'STORY_EDIT', 'STORY_REVIEW', 'STORY_APPROVE', 'EDITION_ASSEMBLE', 'EDITION_REVIEW', 'EDITION_READY'];
type SecurityFixture = Awaited<ReturnType<typeof seedSecurityFixture>>;
type Accounts = SecurityFixture['accounts'];
type HumanStory = Omit<Story, 'status' | 'version' | 'sourceHandoff'>;
interface Fixture {
  repository: JsonRepository; security: SecurityFixture; access: AccessControl; clock: { now: string };
  ids: { target: string; proof: string; other: string; quarantine: string };
  policy: AssignedResourcePolicy; grants: ResourceAssignment[];
  handoff(policy?: ResourcePolicy): AuthenticatedSourceHandoff;
  editorial(policy?: ResourcePolicy): AuthenticatedEditorial;
  review(): AuthenticatedSourceReview;
  resolve(id?: string): Promise<void>;
  story(id?: string): HumanStory;
}
async function fixture(run: (f: Fixture) => Promise<void>, resolve = true): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-handoff-security-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const security = await seedSecurityFixture(repository, at), clock = { now: at };
    const access = new AccessControl(repository, { verifier: security.verifier, clock: () => clock.now });
    const article = (name: string, original = false): ProviderArticle => ({ providerId: 'fictional-fixture',
      url: `https://handoff-security.example.test/${name}`, publisher: `Fictional ${name}`, publishedAt: at, retrievedAt: at,
      provenance: { type: original ? 'ORIGINAL' : 'UNKNOWN', originId: null } });
    const target = article('target'), proof = article('proof', true), other = article('other'), quarantine = article('quarantine');
    const counts = await ingestArticles(repository, [target, proof, other, quarantine],
      { providerId: 'fictional-fixture', policyId: 'fictional-ai-editorial-v1' }, { dryRun: false, clock: () => at,
        resolutions: [{ sourceId: sourceId(proof.url), classification: 'ORIGINAL', originId: null, at,
          actorAssertion: privateValue, reason: privateValue, evidenceReferences: [privateValue] }] });
    assert.equal(counts.processed, 1); assert.equal(counts.quarantined, 3); assert.equal(counts.failed, 0);
    await repository.transact(state => { state.sources.find(row => row.id === sourceId(proof.url))!.verification = 'VERIFIED'; });
    const ids = { target: sourceId(target.url), proof: sourceId(proof.url), other: sourceId(other.url), quarantine: sourceId(quarantine.url) };
    const grants: ResourceAssignment[] = Object.values(security.accounts).flatMap(account => [
      ...Object.values(ids).flatMap(id => sourcePermissions.map(permission => ({ identityId: account.identity.id, permission, kind: 'SOURCE' as const, id }))),
      ...[storyId, 'fictional-handoff-other'].flatMap(id => storyPermissions.map(permission => ({ identityId: account.identity.id, permission, kind: 'STORY' as const, id }))),
      { identityId: account.identity.id, permission: 'EDITION_ASSEMBLE' as const, kind: 'EDITION' as const, id: editionSlot('2026-06-01', 'UTC') },
    ]);
    const policy = new AssignedResourcePolicy(grants);
    const review = () => new AuthenticatedSourceReview(repository, access, { resourcePolicy: policy });
    async function resolveSource(id = ids.target) {
      const workflow = review(), credential = security.accounts.editor.credential;
      const initial = await workflow.inspect(credential, id);
      const started = await workflow.begin(credential, id, { revision: initial.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: [ids.proof] });
      const proposed = await workflow.propose(credential, id, { revision: started.revision, reasonCode: 'EVIDENCE_SUPPORTED',
        evidenceReferences: [ids.proof], classification: 'SECONDARY', originId: null });
      const confirmed = await workflow.confirm(security.accounts.managing.credential, id,
        { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [ids.proof] });
      assert.equal(confirmed.independentlyResolved, true);
    }
    if (resolve) await resolveSource();
    await resolveSource(ids.other);
    await run({ repository, security, access, clock, ids, policy, grants, review, resolve: resolveSource,
      handoff(resourcePolicy = policy) { return new AuthenticatedSourceHandoff(repository, access, { resourcePolicy }); },
      editorial(resourcePolicy = policy) { return new AuthenticatedEditorial(repository, access, { resourcePolicy }); },
      story(id = storyId) { return { id, headline: 'A fictional hand-authored review is being prepared', topic: 'fiction',
        summary: 'An explicitly fictional human-authored summary supplied to the preparation call.', geography: 'Imaginary Town',
        eventAt: null, firstSeenAt: at, updatedAt: at, clusterId: 'fictional-handoff-cluster', sourceIds: [ids.target],
        evidence: [{ id: 'fictional-claim', claim: 'A fictional proposal is under review.', support: [ids.target], contradict: [],
          verification: 'VERIFIED', uncertainty: 'This is an invented local fixture, not real reporting.', reviewerDecisions: [] }] }; },
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function denied(expected?: string | readonly string[]) { return (error: unknown) => {
  assert.ok(error instanceof SecurityError); assert.equal(error.message, error.code);
  if (typeof expected === 'string') assert.equal(error.code, expected);
  else if (expected) assert.ok(expected.includes(error.code), error.code);
  assert.doesNotMatch(JSON.stringify(error), /FICTIONAL_PRIVATE|handoff-security|fictional\.json|dayline-handoff/);
  return true;
}; }
async function selection(f: Fixture, actor: keyof Accounts = 'editor') {
  return f.handoff().inspect(f.security.accounts[actor].credential, [f.ids.target]);
}
async function request(f: Fixture) { return { sources: await selection(f), story: f.story() }; }
async function unchanged(f: Fixture, action: () => Promise<unknown>, code?: string | readonly string[]) {
  const before = await f.repository.read();
  await assert.rejects(action(), denied(code));
  const after = await f.repository.read();
  for (const key of ['revisions', 'approvals', 'editions', 'editionReviews', 'drafts', 'schedules', 'preparationRuns'] as const)
    assert.deepEqual(after[key], before[key], key + ' changed after denial');
  // Existing downstream retention hooks may prune invalid old receipts on a
  // denied action. They must never append a successful receipt for that action.
  for (const receipt of after.authenticatedActions) assert.deepEqual(receipt, before.authenticatedActions.find(row => row.id === receipt.id));
}
async function prepared(f: Fixture) {
  return f.handoff().prepare(f.security.accounts.editor.credential, await request(f));
}
async function reviewable(f: Fixture) {
  let row: Pick<Story, 'id' | 'version' | 'status'> = await prepared(f);
  for (const next of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW'] as const)
    row = await f.editorial().reviewStory(f.security.accounts.managing.credential, row.id, row.version, next);
  return row;
}

test('handoff creates exactly the supplied human-authored INGESTED story with source bindings and no editorial approval', async () => fixture(async f => {
  const before = await f.repository.read(), input = await request(f);
  const receipt = await f.handoff().prepare(f.security.accounts.editor.credential, input);
  assert.deepEqual(receipt, { id: storyId, version: 1, status: 'INGESTED' });
  const after = await f.repository.read(), story = after.revisions.find(row => row.id === storyId)!;
  assert.equal(story.headline, input.story.headline); assert.equal(story.summary, input.story.summary);
  assert.deepEqual(story.evidence, input.story.evidence); assert.deepEqual(story.sourceIds, input.story.sourceIds);
  assert.deepEqual(story.sourceHandoff?.selected, input.sources); assert.equal(story.sourceHandoff?.preparedAt, at);
  assert.ok(story.sourceHandoff?.dependencies.some(row => row.id === f.ids.proof));
  assert.equal(after.authenticatedActions.filter(row => row.resourceKind === 'STORY' && row.permission === 'STORY_CREATE' && row.resourceId === storyId && row.resourceVersion === 1).length, 1);
  for (const key of ['approvals', 'editions', 'editionReviews', 'schedules', 'preparationRuns', 'provenanceDecisions', 'sourceReviews'] as const)
    assert.deepEqual(after[key], before[key], key);
  assert.equal(after.revisions.some(row => ['APPROVED', 'PUBLISHED'].includes(row.status)), false);
}));

test('selection is a bounded read-only exact token view without source payload, reviewer or credential fields', async () => fixture(async f => {
  const before = await readFile(f.repository.file, 'utf8'), rows = await selection(f);
  assert.equal(rows.length, 1); assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'revision']);
  assert.equal(rows[0].id, f.ids.target); assert.match(rows[0].revision, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(rows), /publisher|canonicalUrl|FICTIONAL_PRIVATE|proposedBy|evidenceReferences|actorId|Bearer/);
  assert.equal(await readFile(f.repository.file, 'utf8'), before);
}));

for (const actor of ['reporter', 'admin'] as const) test(`${actor} receives no handoff authority from exact object grants alone`, async () => fixture(async f => {
  const input = await request(f);
  await unchanged(f, () => f.handoff().prepare(f.security.accounts[actor].credential, input), 'PERMISSION_DENIED');
  await assert.rejects(f.handoff().inspect(f.security.accounts[actor].credential, [f.ids.target]), denied('PERMISSION_DENIED'));
}));

test('a managing editor with separate exact source and story grants can prepare without approving', async () => fixture(async f => {
  const receipt = await f.handoff().prepare(f.security.accounts.managing.credential, await request(f));
  assert.equal(receipt.status, 'INGESTED'); assert.deepEqual((await f.repository.read()).approvals, []);
}));

for (const absent of ['target', 'proof', 'story'] as const) test(`preparation requires the exact ${absent} grant in addition to current role`, async () => fixture(async f => {
  const input = await request(f), actor = f.security.accounts.editor.identity.id;
  const policy = new AssignedResourcePolicy(f.grants.filter(row => row.identityId !== actor || (absent === 'story'
    ? !(row.kind === 'STORY' && row.id === storyId && row.permission === 'STORY_CREATE')
    : !(row.kind === 'SOURCE' && row.id === f.ids[absent] && row.permission === 'SOURCE_READ'))));
  await unchanged(f, () => f.handoff(policy).prepare(f.security.accounts.editor.credential, input), 'PERMISSION_DENIED');
}));

test('inspection requires source grants but does not grant or require story allocation authority', async () => fixture(async f => {
  const policy = new AssignedResourcePolicy(f.grants.filter(row => row.kind === 'SOURCE'));
  const sources = await f.handoff(policy).inspect(f.security.accounts.editor.credential, [f.ids.target]);
  assert.equal(sources.length, 1);
  await unchanged(f, () => f.handoff(policy).prepare(f.security.accounts.editor.credential, { sources, story: f.story() }), 'PERMISSION_DENIED');
}));

test('a legacy provider resolution without independent authenticated review is not a selectable source', async () => fixture(async f => {
  await assert.rejects(f.handoff().inspect(f.security.accounts.editor.credential, [f.ids.proof]), denied('DOMAIN_REJECTED'));
}));

test('review history without its matching authenticated confirmation receipt cannot authorize a handoff', async () => fixture(async f => {
  await f.repository.transact(state => { state.authenticatedActions = state.authenticatedActions.filter(row =>
    !(row.resourceKind === 'SOURCE' && row.resourceId === f.ids.target && row.permission === 'SOURCE_RESOLVE')); });
  await assert.rejects(f.handoff().inspect(f.security.accounts.editor.credential, [f.ids.target]), denied('DOMAIN_REJECTED'));
  assert.deepEqual((await f.repository.read()).revisions, []);
}));

test('syndicated selection requires exact origin access and a currently verified original', async () => fixture(async f => {
  const workflow = f.review(), credential = f.security.accounts.editor.credential;
  const initial = await workflow.inspect(credential, f.ids.target);
  const begun = await workflow.begin(credential, f.ids.target, { revision: initial.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: [f.ids.proof] });
  const proposal = await workflow.propose(credential, f.ids.target, { revision: begun.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.proof], classification: 'SYNDICATED', originId: f.ids.proof });
  await workflow.confirm(f.security.accounts.managing.credential, f.ids.target, { revision: proposal.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.proof] });
  assert.equal((await selection(f)).length, 1);
  const policy = new AssignedResourcePolicy(f.grants.filter(row => row.identityId !== f.security.accounts.editor.identity.id
    || row.kind !== 'SOURCE' || row.id !== f.ids.proof || row.permission !== 'SOURCE_READ'));
  await assert.rejects(f.handoff(policy).inspect(credential, [f.ids.target]), denied('PERMISSION_DENIED'));
  await f.repository.transact(state => { state.sources.find(row => row.id === f.ids.proof)!.verification = 'UNVERIFIED'; });
  await assert.rejects(f.handoff().inspect(credential, [f.ids.target]), denied('DOMAIN_REJECTED'));
  assert.deepEqual((await f.repository.read()).revisions, []);
}, false));

test('an unresolved quarantined source cannot enter story preparation', async () => fixture(async f => {
  await assert.rejects(f.handoff().inspect(f.security.accounts.editor.credential, [f.ids.target]), denied('DOMAIN_REJECTED'));
}, false));

test('a recommendation alone never enables selection or a story mutation', async () => fixture(async f => {
  const workflow = f.review(), credential = f.security.accounts.editor.credential;
  const initial = await workflow.inspect(credential, f.ids.target);
  const begun = await workflow.begin(credential, f.ids.target, { revision: initial.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: [f.ids.proof] });
  await workflow.propose(credential, f.ids.target, { revision: begun.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.proof], classification: 'SECONDARY', originId: null });
  await assert.rejects(f.handoff().inspect(credential, [f.ids.target]), denied('DOMAIN_REJECTED'));
  assert.deepEqual((await f.repository.read()).revisions, []);
}, false));

for (const restriction of ['hold', 'deletion', 'retentionHold', 'targetExpiry', 'proofExpiry', 'proofUnverified', 'disputed', 'revokedPolicy', 'supersededPolicy', 'noStoryRights'] as const)
  test(`${restriction} prevents currently stale source selection and preparation`, async () => fixture(async f => {
    const input = await request(f);
    if (restriction === 'hold') {
      const summary = await f.review().inspect(f.security.accounts.editor.credential, f.ids.target);
      await f.review().hold(f.security.accounts.editor.credential, f.ids.target, { revision: summary.revision, reasonCode: 'REVIEW_HOLD', evidenceReferences: [f.ids.proof] });
    } else await f.repository.transact(state => {
      if (restriction === 'deletion') state.deletions.push({ sourceId: f.ids.target, at, reason: 'FICTIONAL_DELETE', expiresAt: '2026-06-02T12:00:00.000Z' });
      if (restriction === 'retentionHold') state.retentionReviewRequired = true;
      if (restriction === 'targetExpiry') state.managedSources.find(row => row.sourceId === f.ids.target)!.deleteAt = at;
      if (restriction === 'proofExpiry') state.managedSources.find(row => row.sourceId === f.ids.proof)!.deleteAt = at;
      if (restriction === 'proofUnverified') state.sources.find(row => row.id === f.ids.proof)!.verification = 'UNVERIFIED';
      if (restriction === 'disputed') state.sources.find(row => row.id === f.ids.target)!.verification = 'DISPUTED';
      if (['revokedPolicy', 'supersededPolicy', 'noStoryRights'].includes(restriction)) {
        const row = state.managedSources.find(row => row.sourceId === f.ids.target)!;
        // Captured inactive snapshots can exist historically; they cannot be silently upgraded by the handoff.
        if (restriction === 'noStoryRights') row.policy = getPolicy('fictional-fixture', 'fictional-metadata-v1', at);
        else {
          const policyId = restriction === 'revokedPolicy' ? 'fictional-ai-revoked-v1' : 'fictional-superseded-v1';
          row.policy = { ...getPolicy('fictional-fixture', restriction === 'revokedPolicy' ? 'fictional-ai-editorial-v1' : 'fictional-metadata-v1', at),
            id: policyId, evidenceReference: `fictional-fixture-only:${policyId}`, reviewStatus: restriction === 'revokedPolicy' ? 'REVOKED' : 'SUPERSEDED' };
          assert.equal(policyStatus(row.policy, at), restriction === 'revokedPolicy' ? 'REVOKED' : 'SUPERSEDED');
        }
        state.sources.find(source => source.id === f.ids.target)!.rights = JSON.stringify(row.policy);
      }
    });
    await unchanged(f, () => f.handoff().prepare(f.security.accounts.editor.credential, input), ['DOMAIN_REJECTED', 'STALE_TARGET']);
    await assert.rejects(f.handoff().inspect(f.security.accounts.editor.credential, [f.ids.target]), denied('DOMAIN_REJECTED'));
  }));

for (const change of ['revoked', 'rotated', 'disabled', 'demoted', 'expired'] as const) test(`current ${change} identity/session state overrides an earlier valid selection`, async () => fixture(async f => {
  const input = await request(f), actor = f.security.accounts.editor;
  if (change === 'revoked') await f.access.invalidateSession(actor.credential);
  if (change === 'rotated') await f.access.rotateCredentials(f.security.accounts.admin.credential, actor.identity.id, 1);
  if (change === 'disabled') await f.access.setStatus(f.security.accounts.admin.credential, actor.identity.id, 1, 'DISABLED');
  if (change === 'demoted') await f.access.setRoles(f.security.accounts.admin.credential, actor.identity.id, 1, ['REPORTER']);
  if (change === 'expired') f.clock.now = actor.claims.expiresAt;
  const codes = { revoked: 'SESSION_REVOKED', rotated: 'INVALID_SESSION', disabled: 'IDENTITY_DISABLED', demoted: 'PERMISSION_DENIED', expired: 'SESSION_EXPIRED' };
  await unchanged(f, () => f.handoff().prepare(actor.credential, input), codes[change]);
}));

test('a signed but unregistered session cannot reuse another session selection', async () => fixture(async f => {
  const input = await request(f), claims = { ...f.security.accounts.editor.claims, sessionId: randomUUID() };
  await unchanged(f, () => f.handoff().prepare(f.security.verifier.issue(claims), input), 'INVALID_SESSION');
}));

for (const credential of [undefined, 'not-a-bearer-credential']) test(`invalid handoff credentials fail closed: ${String(credential)}`, async () => fixture(async f => {
  const input = await request(f); await unchanged(f, () => f.handoff().prepare(credential, input), 'INVALID_CREDENTIAL');
}));

test('another eligible source cannot reuse a selection token for the originally inspected source', async () => fixture(async f => {
  const input = await request(f); input.sources[0].id = f.ids.other; input.story.sourceIds = [f.ids.other]; input.story.evidence[0].support = [f.ids.other];
  await unchanged(f, () => f.handoff().prepare(f.security.accounts.editor.credential, input), 'STALE_TARGET');
}));

test('a relevant same-clock source update invalidates the selected fingerprint', async () => fixture(async f => {
  const input = await request(f); await f.repository.transact(state => { state.managedSources.find(row => row.sourceId === f.ids.target)!.deleteAt = '2026-06-02T11:59:59.000Z'; });
  await unchanged(f, () => f.handoff().prepare(f.security.accounts.editor.credential, input), 'STALE_TARGET');
}));

for (const duplicate of ['selected', 'storySources', 'evidenceSupports', 'claimIds'] as const) test(`duplicate ${duplicate} references cannot create ambiguous source authority`, async () => fixture(async f => {
  const input = await request(f);
  if (duplicate === 'selected') input.sources.push({ ...input.sources[0] });
  if (duplicate === 'storySources') input.story.sourceIds.push(f.ids.target);
  if (duplicate === 'evidenceSupports') input.story.evidence[0].support.push(f.ids.target);
  if (duplicate === 'claimIds') input.story.evidence.push(structuredClone(input.story.evidence[0]));
  await unchanged(f, () => f.handoff().prepare(f.security.accounts.editor.credential, input), 'DOMAIN_REJECTED');
}));

test('story evidence cannot substitute an unselected source or fabricate a missing verified claim', async () => fixture(async f => {
  for (const edit of [(story: HumanStory) => { story.evidence[0].support = [f.ids.other]; },
    (story: HumanStory) => { story.evidence = []; }, (story: HumanStory) => { story.evidence[0].verification = 'UNVERIFIED'; },
    (story: HumanStory) => { story.evidence[0].reviewerDecisions = ['forged authenticated reviewer']; }]) {
    const input = await request(f); edit(input.story);
    await unchanged(f, () => f.handoff().prepare(f.security.accounts.editor.credential, input), 'DOMAIN_REJECTED');
  }
}));

for (const field of ['actor', 'permission', 'policy', 'sourceHandoff', 'status', 'version'] as const) test(`caller-supplied story ${field} cannot create authority or bypass human preparation`, async () => fixture(async f => {
  const input = await request(f); Object.assign(input.story, { [field]: privateValue });
  await unchanged(f, () => f.handoff().prepare(f.security.accounts.editor.credential, input), 'DOMAIN_REJECTED');
}));

test('prototype-bearing selection and accessor story inputs are denied without invoking getters', async () => fixture(async f => {
  const input = await request(f); let invoked = 0;
  const malicious = Object.defineProperty({ ...input.story }, 'sourceIds', { enumerable: true, get() { invoked++; return [f.ids.target]; } });
  await unchanged(f, () => f.handoff().prepare(f.security.accounts.editor.credential, { sources: input.sources, story: malicious }), 'DOMAIN_REJECTED');
  const inherited = Object.assign(Object.create({ permission: 'STORY_CREATE' }), input.sources[0]);
  await unchanged(f, () => f.handoff().prepare(f.security.accounts.editor.credential, { sources: [inherited], story: f.story() }), 'DOMAIN_REJECTED');
  assert.equal(invoked, 0);
}));

test('source selection grants no edit, story review, approval or edition ownership', async () => fixture(async f => {
  const actor = f.security.accounts.editor.identity.id;
  const grants = f.grants.filter(row => row.kind === 'SOURCE' || row.identityId !== actor || row.permission === 'STORY_CREATE');
  const policy = new AssignedResourcePolicy(grants), handoff = f.handoff(policy), editorial = f.editorial(policy);
  const receipt = await handoff.prepare(f.security.accounts.editor.credential, { sources: await handoff.inspect(f.security.accounts.editor.credential, [f.ids.target]), story: f.story() });
  await unchanged(f, () => editorial.editStory(f.security.accounts.editor.credential, receipt.id, receipt.version, { summary: 'A new fictional summary' }), 'PERMISSION_DENIED');
  await unchanged(f, () => editorial.reviewStory(f.security.accounts.editor.credential, receipt.id, receipt.version, 'CLUSTERED'), 'PERMISSION_DENIED');
  await unchanged(f, () => editorial.approveStory(f.security.accounts.editor.credential, receipt.id, receipt.version), 'PERMISSION_DENIED');
}));

test('legacy authenticated creation cannot bypass the handoff for independently reviewed source metadata', async () => fixture(async f => {
  await unchanged(f, () => f.editorial().createStory(f.security.accounts.editor.credential, f.story()), 'DOMAIN_REJECTED');
}));

test('normal bound editing preserves source bindings and cannot substitute a source', async () => fixture(async f => {
  const created = await prepared(f), before = (await f.repository.read()).revisions.at(-1)!;
  const edited = await f.editorial().editStory(f.security.accounts.editor.credential, created.id, created.version, { summary: 'Another explicitly human-written fictional summary.' });
  assert.deepEqual(edited.sourceHandoff, before.sourceHandoff);
  await unchanged(f, () => f.editorial().editStory(f.security.accounts.editor.credential, edited.id, edited.version,
    { sourceIds: [f.ids.other], evidence: [{ ...f.story().evidence[0], support: [f.ids.other] }] }), ['DOMAIN_REJECTED', 'STALE_TARGET']);
}));

test('approval remains an explicit existing action and edition assembly remains separately assigned', async () => fixture(async f => {
  const review = await reviewable(f); assert.deepEqual((await f.repository.read()).approvals, []);
  const approved = await f.editorial().approveStory(f.security.accounts.managing.credential, review.id, review.version);
  assert.equal(approved.status, 'APPROVED');
  const edition = await f.editorial().assembleEdition(f.security.accounts.editor.credential, { date: '2026-06-01', timezone: 'UTC',
    placements: [{ storyId: approved.id, storyVersion: approved.version, section: 'TOP_STORIES', featured: true }] });
  assert.equal(edition.status, 'ASSEMBLING');
  await unchanged(f, () => f.editorial().reviewEdition(f.security.accounts.managing.credential, edition.id, edition.revision, 'NEEDS_REVIEW'), 'PERMISSION_DENIED');
  assert.equal((await f.repository.read()).revisions.some(row => row.status === 'PUBLISHED'), false);
}));

test('downstream story approval needs current source grants as well as story approval authority', async () => fixture(async f => {
  const review = await reviewable(f), actor = f.security.accounts.managing.identity.id;
  const policy = new AssignedResourcePolicy(f.grants.filter(row => row.identityId !== actor || row.kind !== 'SOURCE' || row.id !== f.ids.proof || row.permission !== 'SOURCE_READ'));
  await unchanged(f, () => f.editorial(policy).approveStory(f.security.accounts.managing.credential, review.id, review.version), 'PERMISSION_DENIED');
}));

test('bound downstream commands cannot fall back to an omitted policy or a legacy policy without a source epoch', async () => fixture(async f => {
  const created = await prepared(f);
  const facades = [new AuthenticatedEditorial(f.repository, f.access),
    new AuthenticatedEditorial(f.repository, f.access, { resourcePolicy: { authorize() {} } })];
  for (const facade of facades) await unchanged(f, () => facade.reviewStory(f.security.accounts.managing.credential,
    created.id, created.version, 'CLUSTERED'), 'PERMISSION_DENIED');
}));

test('source hold after preparation blocks subsequent approval and does not silently refresh a released source binding', async () => fixture(async f => {
  const review = await reviewable(f), workflow = f.review(), credential = f.security.accounts.editor.credential;
  const current = await workflow.inspect(credential, f.ids.target);
  const held = await workflow.hold(credential, f.ids.target, { revision: current.revision, reasonCode: 'REVIEW_HOLD', evidenceReferences: [f.ids.proof] });
  await unchanged(f, () => f.editorial().approveStory(f.security.accounts.managing.credential, review.id, review.version), ['DOMAIN_REJECTED', 'STALE_TARGET']);
  await workflow.release(f.security.accounts.managing.credential, f.ids.target,
    { revision: held.revision, reasonCode: 'HOLD_RELEASED', evidenceReferences: [f.ids.proof] });
  await unchanged(f, () => f.editorial().approveStory(f.security.accounts.managing.credential, review.id, review.version), ['DOMAIN_REJECTED', 'STALE_TARGET']);
}));

test('a source-state change after approval prevents edition preparation with the old story binding', async () => fixture(async f => {
  const review = await reviewable(f), approved = await f.editorial().approveStory(f.security.accounts.managing.credential, review.id, review.version);
  await f.repository.transact(state => { state.managedSources.find(row => row.sourceId === f.ids.target)!.deleteAt = '2026-06-02T11:00:00.000Z'; });
  await unchanged(f, () => f.editorial().assembleEdition(f.security.accounts.editor.credential, { date: '2026-06-01', timezone: 'UTC',
    placements: [{ storyId: approved.id, storyVersion: approved.version, section: 'TOP_STORIES' }] }), ['DOMAIN_REJECTED', 'STALE_TARGET']);
}));

test('retention cleanup redacts historical human content linked through a supporting proof dependency', async () => fixture(async f => {
  await prepared(f);
  await f.repository.transact(state => { state.managedSources.find(row => row.sourceId === f.ids.proof)!.deleteAt = at; });
  await cleanupRetention(f.repository, at, false);
  const state = await f.repository.read();
  assert.ok(state.revisions.length); assert.ok(state.revisions.every(row => row.retentionRedacted));
  assert.ok(state.revisions.every(row => row.sourceHandoff === undefined && row.sourceIds.length === 0 && row.evidence.length === 0));
  assert.equal(JSON.stringify(state.revisions).includes('explicitly fictional human-authored summary'), false);
  assert.equal(state.authenticatedActions.some(row => row.resourceKind === 'STORY' && row.resourceId === storyId), false);
}));

test('trusted direct legacy creation cannot bypass the guarded requirement on later authenticated editing or review', async () => fixture(async f => {
  await new Newsroom(f.repository, { clock: () => at }).create(f.story(), 'fictional-trusted-fixture');
  await unchanged(f, () => f.editorial().editStory(f.security.accounts.editor.credential, storyId, 1, { summary: 'Unbound bypass attempt' }), 'DOMAIN_REJECTED');
  await unchanged(f, () => f.editorial().reviewStory(f.security.accounts.managing.credential, storyId, 1, 'CLUSTERED'), 'DOMAIN_REJECTED');
  await unchanged(f, () => f.editorial().approveStory(f.security.accounts.managing.credential, storyId, 1), 'DOMAIN_REJECTED');
}));
