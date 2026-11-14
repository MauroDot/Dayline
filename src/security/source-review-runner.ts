/** Deterministic fictional review demonstration; no listener, caller repository or live mode. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSourceReviewFixture, sourceReviewFixtureAt } from '../../fixtures/source-review-fiction.ts';
import { eligibleSource } from '../ingestion/eligibility.ts';
import { JsonRepository } from '../newsroom/store.ts';
import { SecurityError } from './verifier.ts';

const editorialKeys = ['revisions', 'approvals', 'drafts', 'draftReviews', 'editions', 'editionReviews', 'schedules', 'preparationRuns'] as const;

async function denied(action: () => Promise<unknown>, expected: 'PERMISSION_DENIED' | 'SESSION_REVOKED') {
  try { await action(); }
  catch (error) {
    if (error instanceof SecurityError && error.code === expected) return { denied: true, code: expected };
    throw Error('Unexpected fictional review outcome');
  }
  throw Error('Unexpected fictional review outcome');
}

async function sourceEligible(repository: JsonRepository, id: string): Promise<boolean> {
  const state = await repository.read(), source = state.sources.find(row => row.id === id);
  return !!source && eligibleSource(state, source, sourceReviewFixtureAt);
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw Error('Only the isolated fictional source review fixture is supported');
  const directory = await mkdtemp(join(tmpdir(), 'dayline-fictional-source-review-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const { accounts, access, sourceIds, sourceReview } = await seedSourceReviewFixture(repository);
    const before = await repository.read();
    const retainedBefore = before.quarantine.find(row => row.sourceId === sourceIds.pending)!;
    const evidenceReferences = [sourceIds.original];
    const initial = await sourceReview.inspect(accounts.managing.credential, sourceIds.pending);
    const entered = await sourceReview.begin(accounts.managing.credential, sourceIds.pending,
      { revision: initial.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences });
    const proposed = await sourceReview.propose(accounts.managing.credential, sourceIds.pending,
      { revision: entered.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences,
        classification: 'ORIGINAL', originId: null });
    const eligibleBeforeConfirmation = await sourceEligible(repository, sourceIds.pending);
    const selfConfirmation = await denied(() => sourceReview.confirm(accounts.managing.credential, sourceIds.pending,
      { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences }), 'PERMISSION_DENIED');
    const confirmed = await sourceReview.confirm(accounts.confirming.credential, sourceIds.pending,
      { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences });
    const eligibleAfterConfirmation = await sourceEligible(repository, sourceIds.pending);
    if (initial.status !== 'UNREVIEWED' || entered.status !== 'UNDER_REVIEW' || proposed.status !== 'PROPOSED'
      || eligibleBeforeConfirmation || confirmed.status !== 'RESOLVED' || !eligibleAfterConfirmation) throw Error('Unexpected fictional review transition');

    const disputedInitial = await sourceReview.inspect(accounts.managing.credential, sourceIds.disputed);
    const disputedEntered = await sourceReview.begin(accounts.managing.credential, sourceIds.disputed,
      { revision: disputedInitial.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences });
    const disputedProposed = await sourceReview.propose(accounts.managing.credential, sourceIds.disputed,
      { revision: disputedEntered.revision, reasonCode: 'CONTRADICTORY_EVIDENCE', evidenceReferences,
        classification: 'DISPUTED', originId: null });
    const disputed = await sourceReview.confirm(accounts.confirming.credential, sourceIds.disputed,
      { revision: disputedProposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences });
    const disputedEligible = await sourceEligible(repository, sourceIds.disputed);
    if (disputed.status !== 'DISPUTED' || disputedEligible) throw Error('Unexpected fictional disputed outcome');

    await access.invalidateSession(accounts.managing.credential);
    const revokedReviewer = await denied(() => sourceReview.hold(accounts.managing.credential, sourceIds.pending,
      { revision: confirmed.revision, reasonCode: 'REVIEW_HOLD', evidenceReferences }), 'SESSION_REVOKED');
    const after = await repository.read();
    const retainedAfter = after.managedSources.find(row => row.sourceId === sourceIds.pending)!;
    const rightsAndRetentionUnchanged = retainedAfter.retainedAt === retainedBefore.retainedAt
      && retainedAfter.deleteAt === retainedBefore.deleteAt && JSON.stringify(retainedAfter.policy) === JSON.stringify(retainedBefore.policy);
    const editorialStateUnchanged = editorialKeys.every(key => JSON.stringify(before[key]) === JSON.stringify(after[key]));
    if (!rightsAndRetentionUnchanged || !editorialStateUnchanged
      || ['approveStory', 'reviewStory', 'publish'].some(method => method in sourceReview)) throw Error('Unexpected fictional authority expansion');
    console.log(JSON.stringify({ fictional: true, developmentOnly: true, asOf: sourceReviewFixtureAt,
      provenanceWorkflow: { initial: initial.status, entered: entered.status, proposed: proposed.status,
        eligibleBeforeConfirmation, selfConfirmation, independentConfirmation: confirmed.status, eligibleAfterConfirmation },
      disputedSource: { status: disputed.status, eligible: disputedEligible }, revokedReviewer, rightsAndRetentionUnchanged,
      editorialAuthority: { canApproveStory: false, canReadyEdition: false, canPublish: false, editorialStateUnchanged } }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

main().catch(() => { console.error('Fictional source review demonstration failed'); process.exitCode = 1; });
