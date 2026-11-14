import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/newsroom/store.ts';
import { seedEditorialWorkflowFixture, editorialWorkflowAt } from '../fixtures/editorial-workflow-fiction.ts';
import { AccessControl } from '../src/security/service.ts';
import { AuthenticatedEditorial } from '../src/security/editorial.ts';
import { SecurityError } from '../src/security/verifier.ts';
import { EditionService } from '../src/editions/service.ts';
import { cleanupRetention } from '../src/ingestion/retention.ts';

type Context = Awaited<ReturnType<typeof seedEditorialWorkflowFixture>> & { repository: JsonRepository };
async function fixture(action: (context: Context) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-workflow-continuity-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    await action({ ...await seedEditorialWorkflowFixture(repository), repository });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function prepared(c: Context) {
  await c.resolvePending();
  const sources = await c.sourceHandoff.inspect(c.accounts.editor.credential, [c.sourceIds.pending]);
  return c.sourceHandoff.prepare(c.accounts.editor.credential, { sources, story: structuredClone(c.humanStory) });
}
async function reviewable(c: Context) {
  const story = await prepared(c);
  let version = story.version;
  for (const status of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW'] as const) {
    version = (await c.editorial.reviewStory(c.accounts.editor.credential, story.id, version, status)).version;
  }
  return { id: story.id, version };
}
async function approvedEdition(c: Context) {
  const review = await reviewable(c);
  const story = await c.editorial.approveStory(c.accounts.managing.credential, review.id, review.version);
  return c.editorial.assembleEdition(c.accounts.editor.credential, { date: '2026-06-01', timezone: 'UTC',
    placements: [{ storyId: story.id, storyVersion: story.version, section: 'TOP_STORIES', featured: true }] });
}

test('the actual integrated workflow reaches assembly through separate existing review and approval actions', async () => fixture(async c => {
  const initial = await prepared(c);
  assert.equal(initial.status, 'INGESTED');
  assert.deepEqual((await c.repository.read()).approvals, []);
  assert.deepEqual((await c.repository.read()).editions, []);
  let version = initial.version;
  for (const status of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW'] as const) {
    version = (await c.editorial.reviewStory(c.accounts.editor.credential, initial.id, version, status)).version;
  }
  await assert.rejects(c.editorial.approveStory(c.accounts.editor.credential, initial.id, version),
    error => error instanceof SecurityError && error.code === 'PERMISSION_DENIED');
  const approved = await c.editorial.approveStory(c.accounts.managing.credential, initial.id, version);
  const edition = await c.editorial.assembleEdition(c.accounts.editor.credential, { date: '2026-06-01', timezone: 'UTC',
    placements: [{ storyId: approved.id, storyVersion: approved.version, section: 'TOP_STORIES' }] });
  assert.equal(edition.status, 'ASSEMBLING');
  const state = await c.repository.read();
  assert.equal(state.approvals.length, 1); assert.equal(state.editionReviews.length, 0);
  assert.equal(state.revisions.some(row => row.status === 'PUBLISHED'), false);
  assert.equal(state.schedules.length, 0); assert.equal(state.preparationRuns.length, 0);
}));

test('orphaned proof bindings redact real prepared story history even without expired metadata or source audits', async () => fixture(async c => {
  const receipt = await prepared(c);
  await c.repository.transact(state => {
    state.sources = state.sources.filter(row => row.id !== c.sourceIds.proof);
    state.managedSources = state.managedSources.filter(row => row.sourceId !== c.sourceIds.proof);
    state.quarantine = state.quarantine.filter(row => row.sourceId !== c.sourceIds.proof);
    state.provenanceDecisions = state.provenanceDecisions.filter(row => row.sourceId !== c.sourceIds.proof);
    state.audit = state.audit.filter(row => row.subjectId !== c.sourceIds.proof);
  });
  assert.ok(JSON.stringify(await c.repository.read()).includes(c.sourceIds.proof));
  const cleanup = await cleanupRetention(c.repository, editorialWorkflowAt, false);
  assert.equal(cleanup.candidates, 0);
  const state = await c.repository.read();
  assert.equal(state.retentionReviewRequired, true);
  assert.equal(state.revisions.some(row => row.id === receipt.id), false);
  assert.ok(state.revisions.length > 0 && state.revisions.every(row => row.retentionRedacted === true));
  assert.ok(state.revisions.every(row => !Object.hasOwn(row, 'sourceHandoff') && row.sourceIds.length === 0 && row.evidence.length === 0));
  assert.equal(JSON.stringify(state).includes(c.humanStory.headline), false);
  assert.equal(JSON.stringify(state).includes(c.sourceIds.proof), false);
  assert.equal(state.authenticatedActions.some(row => row.resourceKind === 'STORY' && row.resourceId === receipt.id), false);
}));

test('an undisplayed proof deadline caps actual edition content and expires it without disclosing proof attribution', async () => fixture(async c => {
  const deadline = '2026-06-01T12:00:02.000Z';
  await c.repository.transact(state => { state.managedSources.find(row => row.sourceId === c.sourceIds.proof)!.deleteAt = deadline; });
  const edition = await approvedEdition(c);
  const placement = edition.sections[0].placements[0];
  assert.equal(placement.expiresAt, deadline);
  assert.deepEqual(placement.sources.map(row => row.sourceId), [c.sourceIds.pending]);
  const expired = await new EditionService(c.repository, { clock: () => '2026-06-01T12:00:03.000Z' }).snapshot(edition.id);
  assert.equal(expired.status, 'INVALIDATED');
  assert.equal(Object.hasOwn(expired, 'sections'), false);
  assert.equal(JSON.stringify(expired).includes(c.humanStory.headline), false);
}));

test('proof expiry with a still-valid session prevents later approval and persists no successful approval', async () => fixture(async c => {
  await c.repository.transact(state => { state.managedSources.find(row => row.sourceId === c.sourceIds.proof)!.deleteAt = '2026-06-01T12:00:02.000Z'; });
  const story = await reviewable(c);
  const access = new AccessControl(c.repository, { verifier: c.verifier, clock: () => '2026-06-01T12:00:03.000Z' });
  const later = new AuthenticatedEditorial(c.repository, access, { resourcePolicy: c.resourcePolicy });
  assert.ok(Date.parse(c.accounts.managing.claims.expiresAt) > Date.parse(access.now()));
  await assert.rejects(later.approveStory(c.accounts.managing.credential, story.id, story.version), SecurityError);
  const state = await c.repository.read();
  assert.equal(state.approvals.length, 0);
  assert.equal(state.revisions.filter(row => row.id === story.id).at(-1)!.status, 'NEEDS_REVIEW');
  assert.equal(state.authenticatedActions.some(row => row.permission === 'STORY_APPROVE' && row.resourceId === story.id), false);
}));
