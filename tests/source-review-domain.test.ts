import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonRepository } from '../src/newsroom/store.ts';
import { emptyState, type State } from '../src/newsroom/model.ts';
import { seedSourceQueueFixture, sourceQueueFixtureAt as at } from '../fixtures/source-queue-fiction.ts';
import { sourceId } from '../src/ingestion/metadata.ts';
import { getPolicy } from '../src/ingestion/policies.ts';
import { eligibleSource } from '../src/ingestion/eligibility.ts';
import { cleanupRetention } from '../src/ingestion/retention.ts';
import { applySourceReview, assertSourceReviewCurrent, sourceReviewDependencyIds, sourceReviewFingerprint, sourceReviewRevision, sourceReviewSummary, sourceReviewValidUntil, validateSourceReviewInput, SourceReviewError } from '../src/source-review/domain.ts';
import { validSourceReviewHistory, type SourceReviewAction, type SourceReviewInput, type SourceReviewReasonCode } from '../src/source-review/types.ts';

const reviewer = 'reviewer-principal-one', confirmer = 'reviewer-principal-two';
const pending = sourceId('https://source-queue.example.test/new');
const original = sourceId('https://source-queue.example.test/original');
const disputed = sourceId('https://source-queue.example.test/disputed');
const copy = sourceId('https://source-queue.example.test/copy');
let seeded: Promise<State> | undefined;
async function state(): Promise<State> {
  seeded ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dayline-source-review-domain-base-'));
    try {
      const repository = new JsonRepository(join(directory, 'fictional.json'));
      await seedSourceQueueFixture(repository, at);
      const value = await repository.read();
      value.sources.find(row => row.id === original)!.verification = 'VERIFIED';
      return value;
    } finally { await rm(directory, { recursive: true, force: true }); }
  })();
  return structuredClone(await seeded);
}
function input(value: State, id = pending, reasonCode: SourceReviewReasonCode = 'INITIAL_REVIEW', extra: Partial<SourceReviewInput> = {}): SourceReviewInput {
  return { revision: sourceReviewRevision(value, id), reasonCode, evidenceReferences: [original], ...extra };
}
function transition(value: State, action: SourceReviewAction, id = pending, actor = reviewer, extra: Partial<SourceReviewInput> = {}, time = at) {
  const reasons: Record<SourceReviewAction, SourceReviewReasonCode> = { begin: 'INITIAL_REVIEW', propose: 'EVIDENCE_SUPPORTED', confirm: 'EVIDENCE_SUPPORTED', reject: 'INSUFFICIENT_EVIDENCE', hold: 'REVIEW_HOLD', release: 'HOLD_RELEASED', withdraw: 'WITHDRAWN' };
  return applySourceReview(value, id, action, input(value, id, reasons[action], extra), actor, time);
}
function proposal(value: State, id = pending, actor = reviewer) {
  transition(value, 'begin', id, actor);
  return transition(value, 'propose', id, actor, { classification: 'ORIGINAL', originId: null });
}
function code(expected: SourceReviewError['code']) { return (error: unknown) => error instanceof SourceReviewError && error.code === expected && error.message === expected; }
async function repository(value: State, action: (repo: JsonRepository) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-review-domain-repository-'));
  try { const repo = new JsonRepository(join(directory, 'fictional.json')); await repo.transact(current => Object.assign(current, value)); await action(repo); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('domain review entry records a deterministic bounded revision without changing source data', async () => {
  const value = await state(), before = structuredClone(value);
  const first = transition(value, 'begin');
  assert.equal(first.status, 'UNDER_REVIEW'); assert.equal(first.reviewRevision, 1);
  assert.deepEqual(value.sources, before.sources); assert.deepEqual(value.quarantine, before.quarantine);
  assert.equal(value.sourceReviews![0].actorId, reviewer); assert.equal(value.sourceReviews![0].at, at);
  assert.ok(validSourceReviewHistory(value.sourceReviews));
  assert.equal(sourceReviewRevision(value, pending), sourceReviewRevision(structuredClone(value), pending));
});

test('a recommendation alone never promotes quarantine or establishes source eligibility', async () => {
  const value = await state(), before = structuredClone(value);
  const result = proposal(value);
  assert.equal(result.status, 'PROPOSED'); assert.equal(result.pendingProposal, true); assert.equal(result.blocked, true);
  assert.equal(result.independentlyResolved, false);
  assert.deepEqual(value.quarantine, before.quarantine); assert.deepEqual(value.sources, before.sources);
  assert.deepEqual(value.provenanceDecisions, before.provenanceDecisions);
});

test('independent confirmation reuses provenance promotion and preserves exact captured rights and retention', async () => {
  const value = await state(), captured = structuredClone(value.quarantine.find(row => row.sourceId === pending)!);
  proposal(value);
  const result = transition(value, 'confirm', pending, confirmer);
  assert.equal(result.status, 'RESOLVED'); assert.equal(result.independentlyResolved, true);
  assert.equal(value.quarantine.some(row => row.sourceId === pending), false);
  const managed = value.managedSources.find(row => row.sourceId === pending)!;
  const { metadata: _metadata, ...expected } = captured;
  assert.deepEqual(managed, expected);
  assert.equal(value.sources.find(row => row.id === pending)!.verification, 'UNVERIFIED');
  assert.equal(eligibleSource(value, value.sources.find(row => row.id === pending)!, at), true);
  assert.equal(value.sourceReviews!.length, 3); assert.ok(validSourceReviewHistory(value.sourceReviews));
});

test('authenticated proposer identity cannot confirm or reject the same recommendation', async () => {
  const value = await state(); proposal(value); const before = structuredClone(value);
  assert.throws(() => transition(value, 'confirm'), code('SELF_CONFIRMATION'));
  assert.throws(() => transition(value, 'reject'), code('SELF_CONFIRMATION'));
  assert.deepEqual(value, before);
});

test('stale and duplicate revisions reject without appending a review', async () => {
  const value = await state(), initial = input(value);
  transition(value, 'begin');
  assert.throws(() => applySourceReview(value, pending, 'begin', initial, reviewer, at), code('STALE_REVISION'));
  transition(value, 'propose', pending, reviewer, { classification: 'ORIGINAL', originId: null });
  transition(value, 'confirm', pending, confirmer);
  const before = structuredClone(value);
  assert.throws(() => transition(value, 'confirm', pending, confirmer), code('INVALID_TRANSITION'));
  assert.deepEqual(value, before);
});

test('proposal source-state fingerprint rejects a newly rebound token after target retention changes', async () => {
  const value = await state(); proposal(value);
  value.quarantine.find(row => row.sourceId === pending)!.deleteAt = '2026-06-01T12:00:10.000Z';
  assert.throws(() => transition(value, 'confirm', pending, confirmer), code('STALE_REVISION'));
  assert.equal(sourceReviewSummary(value, pending, at).status, 'EXPIRED');
});

test('same-clock active evidence deadline edits invalidate the captured recommendation', async () => {
  const value = await state(); proposal(value);
  const old = sourceReviewRevision(value, pending);
  value.managedSources.find(row => row.sourceId === original)!.deleteAt = '2026-06-01T12:00:09.000Z';
  assert.notEqual(sourceReviewRevision(value, pending), old);
  assert.throws(() => transition(value, 'confirm', pending, confirmer), code('STALE_REVISION'));
  assert.equal(sourceReviewSummary(value, pending, at).reviewAllowed, false);
});

test('supporting evidence verification cannot silently change during pending review', async () => {
  const value = await state(); proposal(value);
  value.sources.find(row => row.id === original)!.verification = 'UNVERIFIED';
  assert.throws(() => transition(value, 'confirm', pending, confirmer), code('CONTRADICTORY_EVIDENCE'));
  assert.equal(sourceReviewSummary(value, pending, at).status, 'EXPIRED');
});

test('self-only evidence and unverified provider assertions cannot support a recommendation', async () => {
  const value = await state(); transition(value, 'begin');
  assert.throws(() => transition(value, 'propose', pending, reviewer, { evidenceReferences: [pending], classification: 'ORIGINAL', originId: null }), code('CONTRADICTORY_EVIDENCE'));
  value.sources.find(row => row.id === original)!.verification = 'UNVERIFIED';
  assert.throws(() => transition(value, 'propose', pending, reviewer, { classification: 'ORIGINAL', originId: null }), code('CONTRADICTORY_EVIDENCE'));
});

test('all distinct supporting references must be independently verified managed original reports', async () => {
  const value = await state(); transition(value, 'begin');
  assert.throws(() => transition(value, 'propose', pending, reviewer, { evidenceReferences: [original, copy], classification: 'ORIGINAL', originId: null }), code('CONTRADICTORY_EVIDENCE'));
});

test('confirmation and rejection cannot replace the exact pending evidence set', async () => {
  const value = await state(); proposal(value);
  for (const action of ['confirm', 'reject'] as const) assert.throws(() => transition(value, action, pending, confirmer, { evidenceReferences: [original, pending] }), code('CONTRADICTORY_EVIDENCE'));
});

test('syndication requires an exact eligible independently verified original included as evidence', async () => {
  const value = await state(); transition(value, 'begin');
  assert.throws(() => transition(value, 'propose', pending, reviewer, { classification: 'SYNDICATED', originId: pending }), code('CONTRADICTORY_EVIDENCE'));
  const proposed = transition(value, 'propose', pending, reviewer, { classification: 'SYNDICATED', originId: original });
  assert.equal(proposed.status, 'PROPOSED');
  transition(value, 'confirm', pending, confirmer);
  assert.equal(value.sources.find(row => row.id === pending)!.type, 'SYNDICATED');
  assert.equal(value.sources.find(row => row.id === pending)!.originId, original);
});

test('known provider provenance and prior accepted classifications cannot be rewritten', async () => {
  const value = await state(); proposal(value); transition(value, 'confirm', pending, confirmer);
  transition(value, 'hold'); transition(value, 'release');
  assert.throws(() => transition(value, 'propose', pending, reviewer, { classification: 'SECONDARY', originId: null }), code('CONTRADICTORY_EVIDENCE'));
});

test('a confirmed disputed finding stays quarantined and blocked', async () => {
  const value = await state(); transition(value, 'begin', disputed);
  transition(value, 'propose', disputed, reviewer, { classification: 'DISPUTED', originId: null, reasonCode: 'CONTRADICTORY_EVIDENCE' });
  const result = transition(value, 'confirm', disputed, confirmer);
  assert.equal(result.status, 'DISPUTED'); assert.equal(result.blocked, true); assert.equal(result.independentlyResolved, false);
  assert.equal(value.sources.some(row => row.id === disputed), false); assert.ok(value.quarantine.some(row => row.sourceId === disputed));
});

test('a confirmed unknown finding cannot fabricate a resolved source', async () => {
  const value = await state(); transition(value, 'begin');
  transition(value, 'propose', pending, reviewer, { classification: 'UNKNOWN', originId: null, reasonCode: 'INSUFFICIENT_EVIDENCE' });
  const result = transition(value, 'confirm', pending, confirmer);
  assert.equal(result.status, 'DISPUTED'); assert.equal(result.blocked, true);
  assert.equal(value.sources.some(row => row.id === pending), false);
});

test('an independent rejection preserves source metadata and discards pending recommendation', async () => {
  const value = await state(), before = structuredClone(value.quarantine); proposal(value);
  const result = transition(value, 'reject', pending, confirmer);
  assert.equal(result.status, 'REJECTED'); assert.equal(result.pendingProposal, false); assert.deepEqual(value.quarantine, before);
  assert.equal(value.sourceReviews!.at(-1)!.proposal, null);
  assert.equal(transition(value, 'begin').status, 'UNDER_REVIEW');
});

test('review hold blocks an eligible managed source and explicit release drops the old proposal', async () => {
  const value = await state(), source = value.sources.find(row => row.id === original)!;
  assert.equal(eligibleSource(value, source, at), true);
  assert.equal(transition(value, 'hold', original).status, 'ON_HOLD');
  assert.equal(eligibleSource(value, source, at), false);
  assert.equal(sourceReviewSummary(value, original, at).reviewAllowed, true);
  assert.equal(transition(value, 'release', original, confirmer).status, 'UNDER_REVIEW');
  assert.equal(eligibleSource(value, source, at), true);
  assert.equal(value.retentionReviewRequired, false);
});

test('release cannot clear a repository-wide retention hold', async () => {
  const value = await state(); transition(value, 'hold'); value.retentionReviewRequired = true;
  const before = structuredClone(value);
  assert.throws(() => transition(value, 'release', pending, confirmer), code('INELIGIBLE_SOURCE'));
  assert.deepEqual(value, before); assert.equal(value.retentionReviewRequired, true);
});

test('withdrawal is explicit, blocking and terminal', async () => {
  const value = await state(); transition(value, 'begin');
  assert.equal(transition(value, 'withdraw').status, 'WITHDRAWN');
  assert.throws(() => transition(value, 'begin'), code('INVALID_TRANSITION'));
  assert.throws(() => transition(value, 'propose', pending, reviewer, { classification: 'ORIGINAL', originId: null }), code('INVALID_TRANSITION'));
});

test('retention expiry during pending review denies confirmation and exposes only a safe expired status', async () => {
  const value = await state(); proposal(value);
  value.managedSources.find(row => row.sourceId === original)!.deleteAt = '2026-06-01T12:00:01.000Z';
  const later = '2026-06-01T12:00:01.000Z';
  assert.throws(() => transition(value, 'confirm', pending, confirmer, {}, later), code('INELIGIBLE_SOURCE'));
  const summary = sourceReviewSummary(value, pending, later);
  assert.equal(summary.status, 'EXPIRED'); assert.equal(summary.pendingProposal, false); assert.equal(summary.reviewAllowed, false);
  assert.doesNotMatch(JSON.stringify(summary), /url-|reviewer|evidence|provider/i);
});

test('deleted targets and expired or revoked policy snapshots reject all review mutation', async () => {
  for (const mode of ['deleted', 'revoked', 'superseded', 'expired'] as const) {
    const value = await state(), row = value.quarantine.find(row => row.sourceId === pending)!;
    if (mode === 'deleted') value.deletions.push({ sourceId: pending, at, expiresAt: '2026-06-02T12:00:00.000Z', reason: 'fictional' });
    else row.policy = getPolicy('fictional-fixture', 'fictional-metadata-v1', at), row.policy.reviewStatus = mode === 'revoked' ? 'REVOKED' : mode === 'superseded' ? 'SUPERSEDED' : 'APPROVED';
    assert.throws(() => transition(value, 'begin', pending, reviewer, {}, mode === 'expired' ? '2027-01-01T00:00:00.000Z' : at), code('INELIGIBLE_SOURCE'));
  }
});

test('the no-audit grant cannot authorize a workflow that persists authenticated review history', async () => {
  const value = await state(), row = value.quarantine.find(row => row.sourceId === pending)!;
  row.policy = getPolicy('fictional-fixture', 'fictional-no-audit-v1', at);
  assert.throws(() => transition(value, 'begin'), code('INELIGIBLE_SOURCE'));
  assert.equal(sourceReviewSummary(value, pending, at).reviewAllowed, false);
});

test('strict schemas reject missing, malformed, duplicate and injected authority fields without getters', async () => {
  const value = await state(), valid = input(value);
  for (const invalid of [{ ...valid, evidenceReferences: [] }, { ...valid, evidenceReferences: [original, original] }, { ...valid, evidenceReferences: ['https://private.test'] },
    { ...valid, actorAssertion: reviewer }, { ...valid, at }, { ...valid, policy: {} }, { ...valid, deleteAt: at }, { ...valid, revision: '0' }, Object.assign(Object.create({ inherited: true }), valid)]) {
    assert.throws(() => validateSourceReviewInput('begin', invalid), code('INVALID_INPUT'));
  }
  let invoked = 0;
  const getter = Object.defineProperty({ ...valid }, 'revision', { enumerable: true, get() { invoked++; return valid.revision; } });
  assert.throws(() => validateSourceReviewInput('begin', getter), code('INVALID_INPUT')); assert.equal(invoked, 0);
});

test('action-specific reason codes cannot masquerade as review, release or confirmation authority', async () => {
  const value = await state();
  for (const action of ['begin', 'confirm', 'hold', 'release', 'withdraw'] as const) {
    assert.throws(() => validateSourceReviewInput(action, input(value, pending, 'CONTRADICTORY_EVIDENCE')), code('INVALID_INPUT'));
  }
});

test('captured policy JSON property order does not deny an otherwise valid managed source', async () => {
  const value = await state(), source = value.sources.find(row => row.id === original)!;
  source.rights = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(source.rights)).reverse()));
  assert.doesNotThrow(() => assertSourceReviewCurrent(value, original, at));
});

test('temporal fences include pending and accepted evidence deadlines and finite dependency graphs', async () => {
  const value = await state(); proposal(value);
  value.managedSources.find(row => row.sourceId === original)!.deleteAt = '2026-06-01T12:00:05.000Z';
  assert.equal(sourceReviewValidUntil(value, pending, at), Date.parse('2026-06-01T12:00:05.000Z'));
  assert.deepEqual(sourceReviewDependencyIds(value, [pending]), [original, pending].sort());
  assert.throws(() => sourceReviewDependencyIds(value, Array.from({ length: 65 }, (_, index) => 'url-' + index.toString(16).padStart(64, '0'))), code('INVALID_INPUT'));
});

test('earlier evidence expiry redacts whole historical review, source receipts and linked provenance decisions', async () => {
  const value = await state(); proposal(value); transition(value, 'confirm', pending, confirmer);
  const proof = value.managedSources.find(row => row.sourceId === original)!;
  proof.deleteAt = '2026-06-01T12:00:01.000Z';
  value.authenticatedActions.push({ id: 'receipt-source-review', actorId: confirmer, identityRevision: 1, sessionRef: 'session-review-proof', permission: 'SOURCE_RESOLVE', resourceKind: 'SOURCE', resourceId: pending, resourceVersion: 3, at });
  await repository(value, async repo => {
    await cleanupRetention(repo, '2026-06-01T12:00:02.000Z', false);
    const scrubbed = await repo.read();
    assert.deepEqual(scrubbed.sourceReviews, []); assert.deepEqual(scrubbed.authenticatedActions, []);
    assert.equal(scrubbed.provenanceDecisions.some(row => row.sourceId === pending), false);
    assert.equal(scrubbed.retentionReviewRequired, true);
    assert.equal(JSON.stringify(scrubbed.sourceReviews).includes(reviewer), false);
    // Captured minimal audit permits only the finite source marker until its expiry.
    assert.ok(scrubbed.deletions.some(row => row.sourceId === original));
    await cleanupRetention(repo, '2026-06-03T12:00:00.000Z', false);
    assert.equal(JSON.stringify(await repo.read()).includes(original), false);
  });
});

test('orphan evidence identities are removed from authenticated provenance even without a selected retention record', async () => {
  const value = await state(); proposal(value); transition(value, 'confirm', pending, confirmer);
  value.sources = value.sources.filter(row => row.id !== original);
  value.managedSources = value.managedSources.filter(row => row.sourceId !== original);
  await repository(value, async repo => {
    await cleanupRetention(repo, at, false);
    const current = await repo.read();
    assert.deepEqual(current.sourceReviews, []);
    assert.equal(current.provenanceDecisions.some(row => row.actorAssertion === 'authenticated-source-review'), false);
    assert.equal(current.provenanceDecisions.some(row => row.sourceId === original || row.originId === original), false);
  });
});

test('additive review storage preserves schema7 without manufacturing review history for old repositories', async () => {
  const value = await state();
  assert.equal(value.sourceReviews, undefined);
  await repository(value, async repo => { assert.equal((await repo.read()).sourceReviews, undefined); await repo.transact(current => { transition(current, 'begin'); }); assert.equal((await repo.read()).schema, 7); });
});

test('storage rejects private extra fields, forged transitions and nonmonotonic review histories', async () => {
  const value = await state(); proposal(value); assert.ok(validSourceReviewHistory(value.sourceReviews));
  for (const mutate of [(copy: State) => { copy.sourceReviews![0].revision = 2; }, (copy: State) => { (copy.sourceReviews![0] as unknown as Record<string, unknown>).privatePayload = 'secret'; }, (copy: State) => { copy.sourceReviews![0].status = 'RESOLVED'; }]) {
    const invalid = structuredClone(value); mutate(invalid); assert.equal(validSourceReviewHistory(invalid.sourceReviews), false);
    await assert.rejects(repository(invalid, async () => {}), /Invalid repository format/);
  }
});

test('older schemas cannot smuggle the new authenticated source-review collection through migration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-review-schema-'));
  try {
    const file = join(directory, 'fictional.json'), value = emptyState();
    await writeFile(file, JSON.stringify({ ...value, schema: 6, sourceReviews: [] }));
    await assert.rejects(new JsonRepository(file).read(), /Invalid repository format/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('inspection dependency scope includes pending and accepted evidence without disclosure of identities', async () => {
  const value = await state(); proposal(value);
  assert.deepEqual(sourceReviewDependencyIds(value, [pending]), [pending, original].sort());
  transition(value, 'confirm', pending, confirmer); transition(value, 'hold'); transition(value, 'release', pending, confirmer);
  assert.deepEqual(sourceReviewDependencyIds(value, [pending]), [pending, original].sort());
  value.managedSources.find(row => row.sourceId === original)!.deleteAt = '2026-06-01T12:00:03.000Z';
  assert.equal(sourceReviewValidUntil(value, pending, at), Date.parse('2026-06-01T12:00:03.000Z'));
});

test('private-only source, policy and provider additions never change action tokens or pending review state', async () => {
  const value = await state(); proposal(value);
  const before = sourceReviewSummary(value, pending, at), token = sourceReviewRevision(value, pending);
  const row = value.quarantine.find(row => row.sourceId === pending)!;
  (row.policy as unknown as Record<string, unknown>).privateNote = 'private-policy-sentinel';
  (row.providerMetadata as unknown as Record<string, unknown>).rawArticle = 'private-provider-sentinel';
  (row.providerProvenance as unknown as Record<string, unknown>).reviewer = 'private-reviewer-sentinel';
  const proof = value.sources.find(row => row.id === original)!;
  proof.rights = JSON.stringify({ ...JSON.parse(proof.rights), privateAssertion: 'private-rights-sentinel' });
  assert.equal(sourceReviewRevision(value, pending), token);
  assert.deepEqual(sourceReviewSummary(value, pending, at), before);
  assert.doesNotThrow(() => assertSourceReviewCurrent(value, original, at));
});

test('accepted resolution reports blocked when its verified evidence is held or demoted', async () => {
  for (const mode of ['hold', 'demote'] as const) {
    const value = await state(); proposal(value); transition(value, 'confirm', pending, confirmer);
    if (mode === 'hold') transition(value, 'hold', original);
    else value.sources.find(row => row.id === original)!.verification = 'UNVERIFIED';
    const summary = sourceReviewSummary(value, pending, at);
    assert.equal(summary.blocked, true); assert.equal(summary.independentlyResolved, false);
    assert.equal(eligibleSource(value, value.sources.find(row => row.id === pending)!, at), false);
  }
});

test('legacy private provenance assertions and free-text evidence are not action-token fingerprints', async () => {
  const value = await state(); proposal(value);
  const before = sourceReviewSummary(value, pending, at), token = sourceReviewRevision(value, pending);
  const legacy = value.provenanceDecisions.find(row => row.sourceId === original)!;
  legacy.actorAssertion = 'private actor changed'; legacy.reason = 'private reviewer note changed';
  legacy.evidenceReferences = ['private inaccessible prose reference'];
  assert.equal(sourceReviewRevision(value, pending), token);
  assert.deepEqual(sourceReviewSummary(value, pending, at), before);
});
