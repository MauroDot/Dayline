/** Offline synthetic end-to-end workflow; no listener, caller repository, provider or publication. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { seedEditorialWorkflowFixture, editorialWorkflowAt } from '../../fixtures/editorial-workflow-fiction.ts';
import { JsonRepository } from '../newsroom/store.ts';
import { AccessControl } from './service.ts';
import { AuthenticatedSourceHandoff } from './source-handoff.ts';
import { SecurityError } from './verifier.ts';
import type { SecurityCode } from './types.ts';

async function denial(action: () => Promise<unknown>, allowed: readonly SecurityCode[]) {
  try { await action(); }
  catch (error) {
    if (error instanceof SecurityError && allowed.includes(error.code)) return { denied: true, code: error.code };
    throw Error('Unexpected fictional workflow denial');
  }
  throw Error('Unexpected fictional workflow allowance');
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw Error('Only the isolated fictional editorial workflow is supported');
  const directory = await mkdtemp(join(tmpdir(), 'dayline-fictional-editorial-workflow-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const c = await seedEditorialWorkflowFixture(repository);
    // Trusted fixture setup captures a short original deadline before any review/handoff.
    await repository.transact(state => {
      state.quarantine.find(row => row.sourceId === c.sourceIds.pending)!.deleteAt = '2026-06-01T12:00:10.000Z';
    });
    const before = await repository.read(), retainedBefore = before.quarantine.find(row => row.sourceId === c.sourceIds.pending)!;
    const queue = await c.sourceQueue.read(c.accounts.editor.credential, { limit: 50 });
    const discovered = queue.entries.find(row => row.canonicalUrl === 'https://editorial-workflow.example.test/pending');
    if (!discovered || discovered.sourceEligible || discovered.quarantineStatus !== 'QUARANTINED') throw Error('Unexpected fictional discovery');
    const initial = await c.sourceReview.inspect(c.accounts.managing.credential, c.sourceIds.pending);
    const evidenceReferences = [c.sourceIds.proof];
    const begun = await c.sourceReview.begin(c.accounts.managing.credential, c.sourceIds.pending,
      { revision: initial.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences });
    const proposed = await c.sourceReview.propose(c.accounts.managing.credential, c.sourceIds.pending,
      { revision: begun.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences, classification: 'SECONDARY', originId: null });
    const proposalPreparation = await denial(() => c.sourceHandoff.inspect(c.accounts.editor.credential, [c.sourceIds.pending]), ['DOMAIN_REJECTED', 'STALE_TARGET']);
    const selfConfirmation = await denial(() => c.sourceReview.confirm(c.accounts.managing.credential, c.sourceIds.pending,
      { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences }), ['PERMISSION_DENIED']);
    const confirmed = await c.sourceReview.confirm(c.accounts.confirming.credential, c.sourceIds.pending,
      { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences });
    const sources = await c.sourceHandoff.inspect(c.accounts.editor.credential, [c.sourceIds.pending]);
    const prepared = await c.sourceHandoff.prepare(c.accounts.editor.credential, { sources, story: c.humanStory });
    const preparedState = await repository.read(), preparedStory = preparedState.revisions.find(row => row.id === c.humanStory.id)!;
    if (prepared.status !== 'INGESTED' || prepared.version !== 1 || preparedState.approvals.length || preparedState.editions.length
      || preparedStory.headline !== c.humanStory.headline || preparedStory.summary !== c.humanStory.summary
      || !isDeepStrictEqual(preparedStory.evidence, c.humanStory.evidence)) throw Error('Unexpected fictional preparation');

    // These are separate, explicitly called existing editorial operations, never handoff side effects.
    let currentVersion = prepared.version;
    for (const status of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW'] as const) {
      const reviewed = await c.editorial.reviewStory(c.accounts.editor.credential, c.humanStory.id, currentVersion, status);
      currentVersion = reviewed.version;
    }
    const approved = await c.editorial.approveStory(c.accounts.managing.credential, c.humanStory.id, currentVersion);
    const edition = await c.editorial.assembleEdition(c.accounts.editor.credential, {
      date: '2026-06-01', timezone: 'UTC', placements: [{ storyId: approved.id, storyVersion: approved.version, section: 'TOP_STORIES', featured: true }],
    });
    if (approved.status !== 'APPROVED' || edition.status !== 'ASSEMBLING') throw Error('Unexpected fictional editorial progression');

    const disputed = await c.resolveDisputed();
    const disputedPreparation = await denial(() => c.sourceHandoff.inspect(c.accounts.editor.credential, [c.sourceIds.disputed]), ['DOMAIN_REJECTED', 'STALE_TARGET']);
    const substitution = await denial(() => c.sourceHandoff.prepare(c.accounts.editor.credential, {
      sources: [{ id: c.sourceIds.other, revision: sources[0].revision }],
      story: { ...structuredClone(c.humanStory), id: 'fictional-workflow-substitution', sourceIds: [c.sourceIds.other],
        evidence: c.humanStory.evidence.map(row => ({ ...structuredClone(row), support: [c.sourceIds.other] })) },
    }), ['PERMISSION_DENIED']);
    await c.access.invalidateSession(c.accounts.editor.credential);
    const revokedAuthor = await denial(() => c.sourceHandoff.inspect(c.accounts.editor.credential, [c.sourceIds.pending]), ['SESSION_REVOKED']);
    const expiredAccess = new AccessControl(repository, { verifier: c.verifier, clock: () => '2026-06-01T12:00:11.000Z' });
    const expiredHandoff = new AuthenticatedSourceHandoff(repository, expiredAccess, { resourcePolicy: c.resourcePolicy });
    const expiredPreparation = await denial(() => expiredHandoff.prepare(c.accounts.managing.credential, {
      sources, story: { ...structuredClone(c.humanStory), id: 'fictional-workflow-expired' },
    }), ['DOMAIN_REJECTED', 'STALE_TARGET']);
    const after = await repository.read(), retainedAfter = after.managedSources.find(row => row.sourceId === c.sourceIds.pending)!;
    const rightsAndRetentionUnchanged = retainedBefore.retainedAt === retainedAfter.retainedAt && retainedBefore.deleteAt === retainedAfter.deleteAt
      && JSON.stringify(retainedBefore.policy) === JSON.stringify(retainedAfter.policy);
    if (!rightsAndRetentionUnchanged || after.revisions.some(row => ['fictional-workflow-substitution', 'fictional-workflow-expired'].includes(row.id))
      || after.revisions.some(row => row.status === 'PUBLISHED') || after.editions.some(row => row.status === 'READY_FOR_APPROVAL')
      || after.preparationRuns.length) throw Error('Unexpected fictional authority expansion');
    console.log(JSON.stringify({ fictional: true, developmentOnly: true, asOf: editorialWorkflowAt,
      discovery: { quarantined: true, authenticatedInspection: initial.status },
      provenance: { proposed: proposed.status, proposalPreparation, selfConfirmation, independentConfirmation: confirmed.status },
      storyPreparation: { status: prepared.status, suppliedHumanContentPreserved: true, automaticallyApproved: false },
      editorialReview: { approvalRequiredSeparateAction: true, statusAfterExplicitApproval: approved.status },
      edition: { status: edition.status, ready: false, published: false },
      disputedSource: { status: disputed.status, preparation: disputedPreparation }, substitution, revokedAuthor, expiredPreparation,
      rightsAndRetentionUnchanged, productionAuthority: { publicPublication: false, schedulingActivated: false } }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

main().catch(() => { console.error('Fictional editorial workflow demonstration failed'); process.exitCode = 1; });
