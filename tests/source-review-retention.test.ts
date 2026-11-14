import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedSourceReviewFixture, sourceReviewFixtureAt } from '../fixtures/source-review-fiction.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { emptyState } from '../src/newsroom/model.ts';
import { cleanupRetention } from '../src/ingestion/retention.ts';
import { eligibleSource } from '../src/ingestion/eligibility.ts';
import { getPolicy } from '../src/ingestion/policies.ts';
import { SecurityError } from '../src/security/verifier.ts';

type Fixture = Awaited<ReturnType<typeof seedSourceReviewFixture>> & { repository: JsonRepository };
const earlyDeadline = '2026-06-01T12:00:01.000Z';
const firstCleanup = '2026-06-01T12:00:02.000Z';
const afterMarkerExpiry = '2026-06-02T12:00:03.000Z';

async function fixture(action: (context: Fixture) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-review-retention-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    await action({ ...await seedSourceReviewFixture(repository), repository });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function resolvePending(c: Fixture, shortenProof = false) {
  if (shortenProof) await c.repository.transact(state => {
    state.managedSources.find(row => row.sourceId === c.sourceIds.original)!.deleteAt = earlyDeadline;
  });
  const credential = c.accounts.editor.credential;
  const initial = await c.sourceReview.inspect(credential, c.sourceIds.pending);
  const started = await c.sourceReview.begin(credential, c.sourceIds.pending, {
    revision: initial.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: [c.sourceIds.original],
  });
  const proposed = await c.sourceReview.propose(credential, c.sourceIds.pending, {
    revision: started.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.original],
    classification: 'SECONDARY', originId: null,
  });
  const confirmed = await c.sourceReview.confirm(c.accounts.managing.credential, c.sourceIds.pending, {
    revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.original],
  });
  assert.equal(confirmed.status, 'RESOLVED');
  return confirmed;
}

test('cleanup removes accepted evidence linkage and full review history before a still-retained target expires', async () => fixture(async c => {
  await resolvePending(c, true);
  const before = await c.repository.read();
  assert.equal(before.sourceReviews?.filter(row => row.sourceId === c.sourceIds.pending).length, 3);
  assert.ok(before.provenanceDecisions.some(row => row.sourceId === c.sourceIds.pending && row.evidenceReferences.includes(c.sourceIds.original)));
  assert.equal(before.authenticatedActions.filter(row => row.resourceKind === 'SOURCE' && row.resourceId === c.sourceIds.pending).length, 3);

  await cleanupRetention(c.repository, firstCleanup, false);
  const after = await c.repository.read();
  assert.ok(after.managedSources.some(row => row.sourceId === c.sourceIds.pending), 'the target metadata has a later governing deadline');
  assert.equal(after.retentionReviewRequired, true);
  assert.deepEqual(after.sourceReviews, []);
  assert.equal(after.provenanceDecisions.some(row => row.evidenceReferences.includes(c.sourceIds.original)), false);
  assert.equal(after.provenanceDecisions.some(row => row.sourceId === c.sourceIds.pending && row.actorAssertion === 'authenticated-source-review'), false);
  assert.equal(after.authenticatedActions.some(row => row.resourceKind === 'SOURCE' && row.resourceId === c.sourceIds.pending), false);
  const marker = after.deletions.find(row => row.sourceId === c.sourceIds.original)!;
  assert.ok(marker);
  assert.deepEqual(Object.keys(marker).sort(), ['at', 'expiresAt', 'reason', 'sourceId']);
  assert.equal(marker.expiresAt, '2026-06-02T12:00:02.000Z');
  assert.doesNotMatch(JSON.stringify(marker), /actorId|proposedBy|evidenceReferences|sourceFingerprint|credential/);
}));

test('finite marker expiry removes the original proof identity without leaving accepted provenance or audit remnants', async () => fixture(async c => {
  await resolvePending(c, true);
  await cleanupRetention(c.repository, firstCleanup, false);
  assert.ok((await c.repository.read()).deletions.some(row => row.sourceId === c.sourceIds.original));
  await cleanupRetention(c.repository, afterMarkerExpiry, false);
  const state = await c.repository.read();
  assert.equal(state.retentionReviewRequired, true);
  assert.equal(JSON.stringify(state).includes(c.sourceIds.original), false, 'expired proof ID must not survive in another record or fingerprint field');
  assert.deepEqual(state.sourceReviews, []);
  assert.equal(state.authenticatedActions.some(row => row.resourceKind === 'SOURCE'), false);
  for (const row of state.deletions) {
    assert.ok(Date.parse(row.expiresAt!) > Date.parse(afterMarkerExpiry));
    assert.deepEqual(Object.keys(row).sort(), ['at', 'expiresAt', 'reason', 'sourceId']);
  }
}));

test('orphaned supporting evidence is removed from accepted resolution history even without a new expired metadata candidate', async () => fixture(async c => {
  // Other queue fixtures intentionally include already-expired records. Keep
  // only the two active records needed to exercise the orphan-only path.
  const kept = new Set([c.sourceIds.pending, c.sourceIds.original]);
  await c.repository.transact(state => {
    state.sources = state.sources.filter(row => kept.has(row.id));
    state.managedSources = state.managedSources.filter(row => kept.has(row.sourceId));
    state.quarantine = state.quarantine.filter(row => kept.has(row.sourceId));
    state.provenanceDecisions = state.provenanceDecisions.filter(row => kept.has(row.sourceId));
    state.audit = state.audit.filter(row => !row.subjectId || kept.has(row.subjectId));
  });
  assert.equal((await cleanupRetention(c.repository, sourceReviewFixtureAt)).candidates, 0);
  await resolvePending(c);
  await c.repository.transact(state => {
    state.sources = state.sources.filter(row => row.id !== c.sourceIds.original);
    state.managedSources = state.managedSources.filter(row => row.sourceId !== c.sourceIds.original);
    state.quarantine = state.quarantine.filter(row => row.sourceId !== c.sourceIds.original);
  });
  const result = await cleanupRetention(c.repository, sourceReviewFixtureAt, false);
  assert.equal(result.candidates, 0);
  const after = await c.repository.read();
  assert.deepEqual(after.sourceReviews, []);
  assert.equal(after.provenanceDecisions.some(row => row.actorAssertion === 'authenticated-source-review'), false);
  assert.equal(after.authenticatedActions.some(row => row.resourceKind === 'SOURCE'), false);
  assert.equal(after.retentionReviewRequired, true);
}));

test('a no-audit captured grant denies linked review mutation without changing any repository byte', async () => fixture(async c => {
  await c.repository.transact(state => {
    state.quarantine.find(row => row.sourceId === c.sourceIds.pending)!.policy = getPolicy('fictional-fixture', 'fictional-no-audit-v1', sourceReviewFixtureAt);
  });
  const summary = await c.sourceReview.inspect(c.accounts.editor.credential, c.sourceIds.pending);
  assert.equal(summary.reviewAllowed, false);
  const before = await readFile(c.repository.file, 'utf8');
  await assert.rejects(c.sourceReview.begin(c.accounts.editor.credential, c.sourceIds.pending, {
    revision: summary.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: [c.sourceIds.original],
  }), error => error instanceof SecurityError && error.code === 'DOMAIN_REJECTED');
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
  assert.equal((await c.repository.read()).authenticatedActions.some(row => row.resourceKind === 'SOURCE'), false);
}));

test('an existing schema-7 repository without review history reads without manufacturing history or rewriting bytes', async () => fixture(async c => {
  const before = await readFile(c.repository.file, 'utf8');
  assert.equal(Object.hasOwn(JSON.parse(before), 'sourceReviews'), false);
  const state = await c.repository.read();
  assert.equal(state.schema, 7);
  assert.equal(Object.hasOwn(state, 'sourceReviews'), false);
  assert.equal(await readFile(c.repository.file, 'utf8'), before);
}));

test('malformed review revisions and injected private fields cannot be partially committed by storage', async () => fixture(async c => {
  const summary = await c.sourceReview.inspect(c.accounts.editor.credential, c.sourceIds.pending);
  await c.sourceReview.begin(c.accounts.editor.credential, c.sourceIds.pending, {
    revision: summary.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: [c.sourceIds.original],
  });
  const before = await readFile(c.repository.file, 'utf8');
  for (const malformed of ['revision-gap', 'private-field', 'forged-state'] as const) {
    await assert.rejects(c.repository.transact(state => {
      const row = state.sourceReviews![0];
      if (malformed === 'revision-gap') row.revision = 3;
      else if (malformed === 'private-field') Reflect.set(row, 'credential', 'FICTIONAL_PRIVATE_REVIEW_STORAGE_SENTINEL');
      else Reflect.set(row, 'status', 'RESOLVED');
    }), /Invalid repository format/);
    assert.equal(await readFile(c.repository.file, 'utf8'), before);
  }
}));

test('older repository schemas cannot smuggle source-review history through migration', async () => fixture(async c => {
  const legacy: Record<string, unknown> = { ...emptyState(), schema: 6, sourceReviews: [] };
  for (const name of ['identities', 'sessions', 'securityAudit', 'authenticatedActions']) delete legacy[name];
  const bytes = JSON.stringify(legacy);
  await writeFile(c.repository.file, bytes);
  await assert.rejects(c.repository.read(), /Invalid repository format/);
  assert.equal(await readFile(c.repository.file, 'utf8'), bytes);
}));

for (const restriction of ['held', 'unverified'] as const) test(`accepted review cannot keep target eligible after its supporting original becomes ${restriction}`, async () => fixture(async c => {
  await resolvePending(c);
  const before = await c.repository.read();
  assert.equal(eligibleSource(before, before.sources.find(row => row.id === c.sourceIds.pending)!, sourceReviewFixtureAt), true);
  if (restriction === 'held') {
    const summary = await c.sourceReview.inspect(c.accounts.editor.credential, c.sourceIds.original);
    await c.sourceReview.hold(c.accounts.editor.credential, c.sourceIds.original, {
      revision: summary.revision, reasonCode: 'REVIEW_HOLD', evidenceReferences: [c.sourceIds.original],
    });
  } else await c.repository.transact(state => { state.sources.find(row => row.id === c.sourceIds.original)!.verification = 'UNVERIFIED'; });
  const after = await c.repository.read();
  assert.equal(eligibleSource(after, after.sources.find(row => row.id === c.sourceIds.pending)!, sourceReviewFixtureAt), false);
  const summary = await c.sourceReview.inspect(c.accounts.editor.credential, c.sourceIds.pending);
  assert.equal(summary.blocked, true); assert.equal(summary.independentlyResolved, false);
  assert.equal(summary.reviewAllowed, false);
}));
