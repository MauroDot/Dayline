import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/newsroom/store.ts';
import { seedSourceReviewFixture, sourceReviewFixtureAt } from '../fixtures/source-review-fiction.ts';
import { AuthenticatedSourceQueue } from '../src/security/source.ts';
import { AssignedResourcePolicy } from '../src/security/resources.ts';
import { AccessControl } from '../src/security/service.ts';
import { SecurityError } from '../src/security/verifier.ts';
import { projectSourceQueue, SourceQueueError } from '../src/source-queue/service.ts';

type Context = Awaited<ReturnType<typeof seedSourceReviewFixture>> & { repository: JsonRepository };
async function fixture(action: (context: Context) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-review-visibility-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    await action({ ...await seedSourceReviewFixture(repository), repository });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function begin(c: Context, id: string) {
  const summary = await c.sourceReview.inspect(c.accounts.editor.credential, id);
  return c.sourceReview.begin(c.accounts.editor.credential, id, { revision: summary.revision,
    reasonCode: 'INITIAL_REVIEW', evidenceReferences: [c.sourceIds.original] });
}

test('only the exact authorized source gains minimal review metadata; fictional legacy projection stays separate', async () => fixture(async c => {
  await begin(c, c.sourceIds.pending);
  const current = await c.sourceQueue.read(c.accounts.editor.credential, { limit: 50 });
  const entry = current.entries.find(row => row.canonicalUrl === 'https://source-queue.example.test/new')!;
  assert.ok(entry.review);
  assert.deepEqual(Object.keys(entry.review).sort(), ['blocked', 'independentlyResolved', 'proposalPending', 'reviewAllowed', 'revision', 'status']);
  assert.equal(entry.review.status, 'UNDER_REVIEW'); assert.equal(entry.review.revision, 1);
  assert.equal(entry.sourceEligible, false); assert.equal(entry.canAdvance, false);
  const serialized = JSON.stringify(current);
  for (const account of Object.values(c.accounts)) assert.equal(serialized.includes(account.identity.id), false);
  for (const sourceId of Object.values(c.sourceIds)) assert.equal(serialized.includes(sourceId), false);
  assert.doesNotMatch(serialized, /evidenceReferences|actorId|proposedBy|sourceFingerprint|reasonCode|credential/);
  const state = await c.repository.read();
  assert.ok(projectSourceQueue(state, sourceReviewFixtureAt, { limit: 50 }).entries.every(row => row.review === undefined));
}));

test('a relevant review invalidates continuation even when the source remains quarantined', async () => fixture(async c => {
  const before = await c.sourceQueue.read(c.accounts.editor.credential, { limit: 1 });
  assert.ok(before.nextCursor);
  await begin(c, c.sourceIds.pending);
  await assert.rejects(c.sourceQueue.read(c.accounts.editor.credential, { limit: 1, cursor: before.nextCursor }),
    error => error instanceof SourceQueueError && error.code === 'STALE_CURSOR');
  const after = await c.sourceQueue.read(c.accounts.editor.credential, { limit: 50 });
  assert.equal(after.entries.find(row => row.canonicalUrl === 'https://source-queue.example.test/new')!.sourceEligible, false);
}));

test('unrelated inaccessible review history changes neither authorized entries nor cursor', async () => fixture(async c => {
  const policy = new AssignedResourcePolicy([c.sourceIds.pending, c.sourceIds.original].map(id => ({
    identityId: c.accounts.editor.identity.id, kind: 'SOURCE' as const, id, permission: 'SOURCE_READ' as const,
  })));
  const queue = new AuthenticatedSourceQueue(c.repository, c.access, { resourcePolicy: policy });
  const before = await queue.read(c.accounts.editor.credential, { limit: 1 });
  assert.ok(before.nextCursor);
  await begin(c, c.sourceIds.copy);
  const after = await queue.read(c.accounts.editor.credential, { limit: 1 });
  assert.deepEqual(after, before);
  assert.equal((await queue.read(c.accounts.editor.credential, { limit: 1, cursor: before.nextCursor })).entries.length, 1);
  assert.ok((await queue.read(c.accounts.editor.credential, { limit: 50 })).entries.every(row => row.review === undefined));
}));

test('an explicit review hold blocks source eligibility and appears only in the scoped queue', async () => fixture(async c => {
  const summary = await c.sourceReview.inspect(c.accounts.editor.credential, c.sourceIds.original);
  await c.sourceReview.hold(c.accounts.editor.credential, c.sourceIds.original, { revision: summary.revision,
    reasonCode: 'REVIEW_HOLD', evidenceReferences: [c.sourceIds.original] });
  const page = await c.sourceQueue.read(c.accounts.editor.credential, { limit: 50 });
  const row = page.entries.find(entry => entry.canonicalUrl === 'https://source-queue.example.test/original')!;
  assert.equal(row.review?.status, 'ON_HOLD'); assert.equal(row.review?.blocked, true);
  assert.equal(row.sourceEligible, false); assert.equal(row.blockedReason, 'SOURCE_REVIEW_HOLD');
  assert.equal(page.entries.find(entry => entry.canonicalUrl === 'https://source-queue.example.test/copy')?.sourceEligible ?? false, false);
}));

test('proposals do not establish eligibility; only independently accepted existing provenance does', async () => fixture(async c => {
  const started = await begin(c, c.sourceIds.pending);
  const proposed = await c.sourceReview.propose(c.accounts.editor.credential, c.sourceIds.pending, {
    revision: started.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.original],
    classification: 'SECONDARY', originId: null,
  });
  const before = (await c.sourceQueue.read(c.accounts.editor.credential, { limit: 50 })).entries
    .find(entry => entry.canonicalUrl === 'https://source-queue.example.test/new')!;
  assert.equal(before.review?.proposalPending, true); assert.equal(before.review?.independentlyResolved, false);
  assert.equal(before.sourceEligible, false);
  await c.sourceReview.confirm(c.accounts.managing.credential, c.sourceIds.pending, {
    revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.original],
  });
  const after = (await c.sourceQueue.read(c.accounts.editor.credential, { limit: 50 })).entries
    .find(entry => entry.canonicalUrl === 'https://source-queue.example.test/new')!;
  assert.equal(after.provenance, 'SECONDARY'); assert.equal(after.sourceEligible, true);
  assert.equal(after.review?.status, 'RESOLVED'); assert.equal(after.review?.independentlyResolved, true);
  assert.equal(after.canAdvance, false);
}));

test('evidence expiry during final queue serialization withholds the entire earlier review page', async () => fixture(async c => {
  const expires = '2026-06-01T12:00:01.000Z';
  await c.repository.transact(state => { state.managedSources.find(row => row.sourceId === c.sourceIds.original)!.deleteAt = expires; });
  const started = await begin(c, c.sourceIds.pending);
  await c.sourceReview.propose(c.accounts.editor.credential, c.sourceIds.pending, {
    revision: started.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.original],
    classification: 'SECONDARY', originId: null,
  });
  let at = sourceReviewFixtureAt;
  const access = new AccessControl(c.repository, { verifier: c.verifier, clock: () => at });
  const policy = new AssignedResourcePolicy([{ identityId: c.accounts.editor.identity.id, kind: 'SOURCE',
    id: c.sourceIds.pending, permission: 'SOURCE_READ' }]);
  const queue = new AuthenticatedSourceQueue(c.repository, access, { resourcePolicy: policy });
  assert.equal((await queue.read(c.accounts.editor.credential)).entries[0].review?.proposalPending, true);
  const stringify = JSON.stringify;
  let pages = 0, disclosed = false;
  JSON.stringify = function (value: unknown, ...args: unknown[]) {
    const serialized = Reflect.apply(stringify, JSON, [value, ...args]);
    if (value && typeof value === 'object' && Object.hasOwn(value, 'entries') && Object.hasOwn(value, 'nextCursor')) {
      if (++pages === 2) at = expires;
    }
    return serialized;
  } as typeof JSON.stringify;
  try {
    await assert.rejects(queue.withPage(c.accounts.editor.credential, undefined, () => { disclosed = true; }),
      error => error instanceof SecurityError && error.code === 'STALE_TARGET');
    assert.equal(disclosed, false); assert.ok(pages >= 2);
  } finally { JSON.stringify = stringify; }
  const current = (await queue.read(c.accounts.editor.credential)).entries[0];
  assert.equal(current.review?.status, 'EXPIRED'); assert.equal(current.review?.proposalPending, false);
  assert.equal(current.sourceEligible, false);
}));
