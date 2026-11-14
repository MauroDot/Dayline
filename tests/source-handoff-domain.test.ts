import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedEditorialWorkflowFixture, editorialWorkflowAt as at } from '../fixtures/editorial-workflow-fiction.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { Newsroom } from '../src/newsroom/service.ts';
import { emptyState, type State, type Story } from '../src/newsroom/model.ts';
import { getPolicy } from '../src/ingestion/policies.ts';
import { cleanupRetention } from '../src/ingestion/retention.ts';
import { redactEditorialHistory } from '../src/ingestion/history.ts';
import { buildPlacement } from '../src/editions/eligibility.ts';
import { EditionService } from '../src/editions/service.ts';
import { buildDraftContext } from '../src/editorial/lifecycle.ts';
import { SourceHandoffError, assertStorySourceHandoff, buildSourceHandoff, inspectHandoffSelection, sourceHandoffTargets,
  sourceHandoffValidUntil, storySourceHandoffTargets, validateHandoffInput, validateHandoffStory } from '../src/source-handoff/domain.ts';
import { validStorySourceHandoff, type SourceSelection } from '../src/source-handoff/types.ts';

type Context = Awaited<ReturnType<typeof seedEditorialWorkflowFixture>> & { repository: JsonRepository };
async function fixture(action: (context: Context) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-handoff-domain-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    await action({ ...await seedEditorialWorkflowFixture(repository), repository });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function failure(code: SourceHandoffError['code']) { return (error: unknown) => error instanceof SourceHandoffError && error.code === code; }
async function selected(c: Context): Promise<SourceSelection[]> {
  await c.resolvePending();
  return inspectHandoffSelection(await c.repository.read(), [c.sourceIds.pending], at);
}
async function prepared(c: Context, selection?: SourceSelection[]) {
  const sources = selection ?? await selected(c), state = await c.repository.read();
  const input = validateHandoffInput({ sources, story: c.humanStory });
  const binding = buildSourceHandoff(state, input.sources, at);
  const newsroom = new Newsroom(c.repository, { clock: () => at });
  const story = await newsroom.create({ ...input.story, sourceHandoff: binding }, 'fictional-domain-test');
  return { story, newsroom, binding, sources };
}
async function approved(c: Context) {
  const result = await prepared(c);
  await result.newsroom.transition(result.story.id, 'CLUSTERED', 'fictional-domain-test');
  await result.newsroom.transition(result.story.id, 'DRAFT', 'fictional-domain-test');
  await result.newsroom.transition(result.story.id, 'NEEDS_REVIEW', 'fictional-domain-test');
  return { ...result, approved: await result.newsroom.transition(result.story.id, 'APPROVED', 'fictional-domain-test') };
}

test('discovery and a recommendation alone cannot supply a source-to-story selection', async () => fixture(async c => {
  const initial = await c.repository.read();
  assert.throws(() => inspectHandoffSelection(initial, [c.sourceIds.pending], at), failure('INELIGIBLE_SOURCE'));
  const inspected = await c.sourceReview.inspect(c.accounts.managing.credential, c.sourceIds.pending);
  const begun = await c.sourceReview.begin(c.accounts.managing.credential, c.sourceIds.pending,
    { revision: inspected.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: [c.sourceIds.proof] });
  await c.sourceReview.propose(c.accounts.managing.credential, c.sourceIds.pending,
    { revision: begun.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.proof], classification: 'SECONDARY', originId: null });
  const awaitedState = await c.repository.read();
  assert.throws(() => inspectHandoffSelection(awaitedState, [c.sourceIds.pending], at), failure('INELIGIBLE_SOURCE'));
  assert.throws(() => inspectHandoffSelection(initial, [c.sourceIds.proof], at), failure('INELIGIBLE_SOURCE'));
  assert.equal((await c.repository.read()).revisions.length, 0);
}));

test('independent authenticated confirmation permits exact selection without fabricating source verification', async () => fixture(async c => {
  const before = await c.repository.read(), sources = await selected(c), after = await c.repository.read();
  assert.deepEqual(sources.map(row => row.id), [c.sourceIds.pending]); assert.match(sources[0].revision, /^[a-f0-9]{64}$/);
  assert.equal(after.sources.find(row => row.id === c.sourceIds.pending)!.verification, 'UNVERIFIED');
  assert.equal(before.revisions.length, 0); assert.equal(after.revisions.length, 0); assert.equal(after.approvals.length, 0);
  assert.deepEqual(after.quarantine.find(row => row.sourceId === c.sourceIds.pending), undefined);
  assert.equal(after.managedSources.find(row => row.sourceId === c.sourceIds.pending)!.deleteAt,
    before.quarantine.find(row => row.sourceId === c.sourceIds.pending)!.deleteAt);
}));

for (const permission of ['SOURCE_REVIEW', 'SOURCE_RESOLVE'] as const) test(`missing ${permission} receipt cannot turn raw review history into authenticated handoff authority`, async () => fixture(async c => {
  await selected(c); const state = await c.repository.read();
  state.authenticatedActions = state.authenticatedActions.filter(row => !(row.resourceId === c.sourceIds.pending && row.permission === permission));
  assert.throws(() => inspectHandoffSelection(state, [c.sourceIds.pending], at), failure('INELIGIBLE_SOURCE'));
}));

test('legacy original labels and verification flags do not substitute for an independently confirmed target', async () => fixture(async c => {
  const state = await c.repository.read();
  assert.equal(state.sources.find(row => row.id === c.sourceIds.proof)!.verification, 'VERIFIED');
  assert.throws(() => inspectHandoffSelection(state, [c.sourceIds.proof], at), failure('INELIGIBLE_SOURCE'));
}));

test('disputed, quarantined and deleted targets remain unavailable for handoff', async () => fixture(async c => {
  await c.resolveDisputed();
  let state = await c.repository.read();
  assert.throws(() => inspectHandoffSelection(state, [c.sourceIds.disputed], at), failure('INELIGIBLE_SOURCE'));
  const sources = await selected(c); state = await c.repository.read();
  state.deletions.push({ sourceId: c.sourceIds.pending, at, expiresAt: '2026-06-02T12:00:00.000Z', reason: 'fixture removal' });
  assert.throws(() => buildSourceHandoff(state, sources, at), failure('INELIGIBLE_SOURCE'));
}));

for (const policyId of ['fictional-metadata-v1', 'fictional-revoked-v1', 'fictional-superseded-v1', 'fictional-expired-v1', 'fictional-no-audit-v1']) {
  test(`${policyId} cannot supply broadened story-preparation rights`, async () => fixture(async c => {
    const sources = await selected(c), state = await c.repository.read();
    let policy;
    try { policy = getPolicy('fictional-fixture', policyId, at); }
    catch { policy = { ...state.managedSources.find(row => row.sourceId === c.sourceIds.pending)!.policy,
      reviewStatus: policyId.includes('revoked') ? 'REVOKED' as const : policyId.includes('superseded') ? 'SUPERSEDED' as const : 'APPROVED' as const,
      ...(policyId.includes('expired') ? { expiresAt: at } : {}) }; }
    state.managedSources.find(row => row.sourceId === c.sourceIds.pending)!.policy = policy;
    state.sources.find(row => row.id === c.sourceIds.pending)!.rights = JSON.stringify(policy);
    assert.throws(() => buildSourceHandoff(state, sources, at), failure('INELIGIBLE_SOURCE'));
  }));
}

test('same-clock target and evidence changes invalidate previously inspected selections', async () => fixture(async c => {
  const sources = await selected(c), state = await c.repository.read();
  for (const id of [c.sourceIds.pending, c.sourceIds.proof]) {
    const changed = structuredClone(state); changed.managedSources.find(row => row.sourceId === id)!.deleteAt = '2026-06-01T12:00:30.000Z';
    assert.throws(() => buildSourceHandoff(changed, sources, at), error => error instanceof SourceHandoffError);
  }
}));

test('selection and human-authored story source identities must match exactly without duplicates', async () => fixture(async c => {
  const sources = await selected(c);
  for (const input of [
    { sources: [...sources, ...sources], story: c.humanStory },
    { sources, story: { ...c.humanStory, sourceIds: [c.sourceIds.other] } },
    { sources: [{ ...sources[0], extra: 'caller-authority' }], story: c.humanStory },
    { sources: [], story: c.humanStory },
  ]) assert.throws(() => validateHandoffInput(input), failure('INVALID_INPUT'));
}));

test('human claims and explicit verification remain required and are never manufactured by handoff', async () => fixture(async c => {
  const sources = await selected(c), input = validateHandoffInput({ sources, story: c.humanStory });
  assert.deepEqual(input.story, c.humanStory);
  for (const evidence of [[], [{ ...c.humanStory.evidence[0], claim: '' }], [{ ...c.humanStory.evidence[0], verification: 'UNVERIFIED' }],
    [{ ...c.humanStory.evidence[0], support: [] }], [{ ...c.humanStory.evidence[0], reviewerDecisions: ['forged authenticated reviewer'] }]]) {
    assert.throws(() => validateHandoffStory({ ...c.humanStory, evidence }), failure('INVALID_INPUT'));
  }
  c.humanStory.summary = 'caller mutation after validation';
  assert.notEqual(input.story.summary, c.humanStory.summary);
}));

test('prototype, accessor, forged actor and policy fields cannot enter the trusted binding', async () => fixture(async c => {
  let getters = 0;
  const getter = Object.defineProperty({ ...c.humanStory }, 'headline', { enumerable: true, get() { getters++; return 'forged'; } });
  for (const input of [getter, Object.assign(Object.create({ actor: 'forged' }), c.humanStory), { ...c.humanStory, actorId: 'forged' },
    { ...c.humanStory, permission: 'STORY_APPROVE' }, { ...c.humanStory, sourceHandoff: {} }, { ...c.humanStory, policy: {} }]) {
    assert.throws(() => validateHandoffStory(input), failure('INVALID_INPUT'));
  }
  assert.equal(getters, 0);
}));

test('preparation creates only an INGESTED story with unchanged supplied text and no approval', async () => fixture(async c => {
  const { story, binding } = await prepared(c), state = await c.repository.read();
  assert.equal(story.status, 'INGESTED'); assert.equal(story.version, 1); assert.equal(story.summary, c.humanStory.summary);
  assert.deepEqual(binding.dependencies.map(row => row.id).sort(), [c.sourceIds.pending, c.sourceIds.proof].sort());
  assert.deepEqual(storySourceHandoffTargets(state, story), binding.dependencies.map(row => row.id));
  assert.equal(state.approvals.length, 0); assert.equal(state.editions.length, 0);
}));

test('normal content editing preserves an immutable source handoff and cannot substitute sources', async () => fixture(async c => {
  const { story, newsroom, binding } = await prepared(c);
  const edited = await newsroom.edit(story.id, { summary: 'A separately supplied fictional correction.' }, 'fictional-domain-test');
  assert.deepEqual(edited.sourceHandoff, binding); assert.equal(edited.version, 2);
  const before = await readFile(c.repository.file, 'utf8');
  await assert.rejects(newsroom.edit(story.id, { sourceIds: [c.sourceIds.proof], evidence: [{ ...edited.evidence[0], support: [c.sourceIds.proof] }] }, 'fictional-domain-test'));
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
}));

test('a post-preparation source hold prevents further active story progression and approval', async () => fixture(async c => {
  const { story, newsroom } = await prepared(c);
  const current = await c.sourceReview.inspect(c.accounts.editor.credential, c.sourceIds.pending);
  await c.sourceReview.hold(c.accounts.editor.credential, c.sourceIds.pending,
    { revision: current.revision, reasonCode: 'REVIEW_HOLD', evidenceReferences: [c.sourceIds.proof] });
  const before = await readFile(c.repository.file, 'utf8');
  await assert.rejects(newsroom.transition(story.id, 'CLUSTERED', 'fictional-domain-test'));
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
  assert.equal((await c.repository.read()).approvals.length, 0);
}));

test('an approved integrated story cannot enter an edition using a stale source binding', async () => fixture(async c => {
  const { approved: story } = await approved(c);
  const before = buildPlacement(await c.repository.read(), story.id, story.version, false, at);
  assert.equal(before.storyId, story.id);
  await c.repository.transact(state => { state.managedSources.find(row => row.sourceId === c.sourceIds.pending)!.deleteAt = '2026-06-01T12:00:30.000Z'; });
  const stale = await c.repository.read();
  assert.throws(() => buildPlacement(stale, story.id, story.version, false, at), /Ineligible edition placement/);
}));

test('edition expiry includes an earlier supporting-proof deadline outside selected story sources', async () => fixture(async c => {
  await c.repository.transact(state => { state.managedSources.find(row => row.sourceId === c.sourceIds.proof)!.deleteAt = '2026-06-01T12:00:05.000Z'; });
  const { approved: story } = await approved(c), state = await c.repository.read();
  assert.equal(story.sourceIds.includes(c.sourceIds.proof), false);
  const placement = buildPlacement(state, story.id, story.version, false, at);
  assert.equal(placement.expiresAt, '2026-06-01T12:00:05.000Z');
  assert.equal(sourceHandoffValidUntil(state, [c.sourceIds.pending], at), Date.parse(placement.expiresAt));
}));

test('a prepared edition is invalidated after bound proof changes without publishing anything', async () => fixture(async c => {
  const { approved: story } = await approved(c);
  const service = new EditionService(c.repository, { clock: () => at });
  const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [{ storyId: story.id, storyVersion: story.version, section: 'TOP_STORIES' }] }, 'fictional-domain-test');
  await c.repository.transact(state => { state.sources.find(row => row.id === c.sourceIds.proof)!.verification = 'UNVERIFIED'; });
  const current = await service.snapshot(edition.id);
  assert.equal(current.status, 'INVALIDATED'); assert.equal((await c.repository.read()).revisions.some(row => row.status === 'PUBLISHED'), false);
}));

test('existing draft contexts retain bound source revisions and expire at the hidden proof deadline', async () => fixture(async c => {
  await c.repository.transact(state => { state.managedSources.find(row => row.sourceId === c.sourceIds.proof)!.deleteAt = '2026-06-01T12:00:05.000Z'; });
  const { story, newsroom } = await prepared(c);
  await newsroom.transition(story.id, 'CLUSTERED', 'fictional-domain-test');
  await newsroom.transition(story.id, 'DRAFT', 'fictional-domain-test');
  const state = await c.repository.read(), context = buildDraftContext(state, story.id, at);
  assert.equal(context.expiresAt, '2026-06-01T12:00:05.000Z');
  assert.deepEqual(context.sourceIds, [c.sourceIds.pending]);
  state.sources.find(row => row.id === c.sourceIds.proof)!.verification = 'UNVERIFIED';
  assert.throws(() => buildDraftContext(state, story.id, at));
}));

test('retention cleanup follows private supporting-proof bindings through every historical story revision', async () => fixture(async c => {
  const { story, newsroom } = await prepared(c);
  await newsroom.edit(story.id, { summary: 'An independently entered fictional historical revision.' }, 'fictional-domain-test');
  assert.equal(story.sourceIds.includes(c.sourceIds.proof), false);
  await c.repository.transact(state => { state.managedSources.find(row => row.sourceId === c.sourceIds.proof)!.deleteAt = '2026-06-01T12:00:01.000Z'; });
  await cleanupRetention(c.repository, '2026-06-01T12:00:02.000Z', false);
  const state = await c.repository.read();
  assert.equal(state.retentionReviewRequired, true); assert.equal(state.revisions.length, 2);
  for (const row of state.revisions) {
    assert.equal(row.retentionRedacted, true); assert.equal(Object.hasOwn(row, 'sourceHandoff'), false);
    assert.deepEqual(row.sourceIds, []); assert.deepEqual(row.evidence, []);
    assert.equal(row.summary, '[retention redacted]'); assert.notEqual(row.id, story.id);
  }
}));

test('orphan binding dependencies trigger redaction even after ordinary source/evidence references were removed', async () => fixture(async c => {
  const { story } = await prepared(c), state = await c.repository.read();
  // Trusted corruption/recovery seam: provenance linkage persists only in the private binding.
  const historical = state.revisions[0]; historical.sourceIds = []; historical.evidence = [];
  assert.equal(redactEditorialHistory(state, new Set([c.sourceIds.proof]), at), 1);
  assert.equal(state.revisions[0].retentionRedacted, true); assert.equal(Object.hasOwn(state.revisions[0], 'sourceHandoff'), false);
  assert.notEqual(state.revisions[0].id, story.id);
}));

test('storage cannot strip, replace or add binding authority midway through a story history', async () => fixture(async c => {
  const { story } = await prepared(c), before = await readFile(c.repository.file, 'utf8');
  for (const alteration of ['strip', 'change'] as const) {
    await assert.rejects(c.repository.transact(state => {
      const copy: Story = { ...structuredClone(story), version: 2 };
      if (alteration === 'strip') delete copy.sourceHandoff;
      else copy.sourceHandoff!.preparedAt = '2026-06-01T12:00:00.001Z';
      state.revisions.push(copy);
    }), /Invalid repository format/);
    assert.equal(await readFile(c.repository.file, 'utf8'), before);
  }
}));

test('strict binding storage rejects private extras and older schemas cannot upgrade legacy authority', async () => fixture(async c => {
  const { story } = await prepared(c);
  assert.ok(validStorySourceHandoff(story.sourceHandoff));
  assert.equal(validStorySourceHandoff({ ...story.sourceHandoff, actorId: 'forged' }), false);
  const directory = await mkdtemp(join(tmpdir(), 'dayline-handoff-schema-'));
  try {
    const file = join(directory, 'fictional.json'), state = await c.repository.read();
    await writeFile(file, JSON.stringify({ ...state, schema: 6 }));
    await assert.rejects(new JsonRepository(file).read(), /Invalid repository format/);
  } finally { await rm(directory, { recursive: true, force: true }); }
  const legacy = structuredClone(story); delete legacy.sourceHandoff;
  assert.doesNotThrow(() => assertStorySourceHandoff(emptyState(), legacy, at));
}));
