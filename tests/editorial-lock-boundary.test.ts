import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/newsroom/store.ts';
import type { State } from '../src/newsroom/model.ts';
import { EditorialService } from '../src/editorial/service.ts';
import { seedEditorialFixture } from '../fixtures/editorial-fiction.ts';

const beforeExpiry = '2026-06-02T11:59:59.999Z';
const expiry = '2026-06-02T12:00:00.000Z';

/** Advance time only after the repository lock is held and just before the service callback. */
class BoundaryRepository extends JsonRepository {
  private calls = 0;
  private readonly boundary: (call: number) => void;
  constructor(file: string, boundary: (call: number) => void) { super(file); this.boundary = boundary; }
  override async transact<T>(change: (state: State) => T): Promise<T> {
    return super.transact(state => { this.boundary(++this.calls); return change(state); });
  }
}

async function fixture(run: (repository: JsonRepository) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-editorial-boundary-'));
  try { await run(new JsonRepository(join(directory, 'fictional.json'))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('generation cannot commit expired payload when rights expire while waiting for the commit lock', async () => fixture(async repository => {
  const { story } = await seedEditorialFixture(repository);
  let now = beforeExpiry;
  const existing = await new EditorialService(repository, { clock: () => now }).generate(story.id, story.version);
  const before = await repository.read();
  const delayed = new BoundaryRepository(repository.file, call => { if (call === 2) now = expiry; });
  await assert.rejects(new EditorialService(delayed, { clock: () => now }).generate(story.id, story.version), /DRAFTING_BLOCKED/);
  const state = await repository.read();
  assert.deepEqual(state.drafts, [{ id: existing.id, status: 'INVALIDATED', invalidatedAt: expiry, reason: 'STALE_OR_INELIGIBLE' }]);
  assert.equal(state.audit.filter(event => event.action === 'AI_DRAFT_GENERATED').length, before.audit.filter(event => event.action === 'AI_DRAFT_GENERATED').length);
  assert.ok(state.audit.some(event => event.action === 'AI_DRAFT_GENERATION_FAILED'));
  assert.deepEqual(state.revisions, before.revisions);
  assert.deepEqual(state.approvals, before.approvals);
}));

test('review cannot succeed after a lock wait crosses expiry and existing review assertions are scrubbed', async () => fixture(async repository => {
  const { story } = await seedEditorialFixture(repository);
  let now = beforeExpiry;
  const initial = new EditorialService(repository, { clock: () => now });
  const draft = await initial.generate(story.id, story.version);
  await initial.review(draft.id, 1, 'NEEDS_REVIEW', 'boundary-reviewer');
  const before = await repository.read();
  const delayed = new BoundaryRepository(repository.file, () => { now = expiry; });
  await assert.rejects(new EditorialService(delayed, { clock: () => now }).review(draft.id, 2, 'READY_FOR_APPROVAL', 'boundary-reviewer'), /DRAFT_INVALIDATED_OR_MISSING/);
  const state = await repository.read();
  assert.equal(state.drafts[0].status, 'INVALIDATED');
  assert.equal(state.draftReviews.length, 1);
  assert.equal(state.draftReviews[0].actorAssertion, '[invalidated]');
  assert.equal(state.draftReviews[0].storyVersion, null);
  assert.equal(state.audit.filter(event => event.action === 'AI_DRAFT_REVIEW_RECORDED').length, before.audit.filter(event => event.action === 'AI_DRAFT_REVIEW_RECORDED').length);
  assert.deepEqual(state.approvals, before.approvals);
}));

test('snapshot rechecks expiry after lock acquisition before returning or retaining active draft data', async () => fixture(async repository => {
  const { story } = await seedEditorialFixture(repository);
  let now = beforeExpiry;
  const initial = new EditorialService(repository, { clock: () => now });
  const draft = await initial.generate(story.id, story.version);
  await initial.review(draft.id, 1, 'NEEDS_REVIEW', 'boundary-reviewer');
  const delayed = new BoundaryRepository(repository.file, () => { now = expiry; });
  const snapshot = await new EditorialService(delayed, { clock: () => now }).snapshot();
  assert.deepEqual(snapshot.drafts, [{ id: draft.id, status: 'INVALIDATED', invalidatedAt: expiry, reason: 'STALE_OR_INELIGIBLE' }]);
  assert.equal(snapshot.reviews[0].actorAssertion, '[invalidated]');
  assert.equal(snapshot.reviews[0].storyVersion, null);
  const state = await repository.read();
  assert.deepEqual(state.drafts, snapshot.drafts);
  assert.deepEqual(state.draftReviews, snapshot.reviews);
  assert.doesNotMatch(JSON.stringify({ drafts: state.drafts, reviews: state.draftReviews }), /A fictional garden proposal|snapshotDigest|fictional-editorial-story|boundary-reviewer/);
}));

test('cancellation while waiting for the commit lock cannot persist a generated proposal', async () => fixture(async repository => {
  const { story } = await seedEditorialFixture(repository);
  const controller = new AbortController();
  const delayed = new BoundaryRepository(repository.file, call => { if (call === 2) controller.abort(); });
  await assert.rejects(new EditorialService(delayed, { clock: () => beforeExpiry }).generate(story.id, story.version, controller.signal), /CANCELLED/);
  const state = await repository.read();
  assert.deepEqual(state.drafts, []);
  assert.deepEqual(state.draftReviews, []);
  assert.equal(state.audit.some(event => event.action === 'AI_DRAFT_GENERATED'), false);
  assert.ok(state.audit.some(event => event.action === 'AI_DRAFT_GENERATION_FAILED'));
}));
