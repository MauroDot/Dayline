/** Invented licensed fixture metadata and synthetic identities; no production provider or identity. */
import { randomUUID } from 'node:crypto';
import type { JsonRepository } from '../src/newsroom/store.ts';
import type { Story } from '../src/newsroom/model.ts';
import { ingestArticles, sourceId } from '../src/ingestion/ingest.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import { AssignedResourcePolicy, editionSlot, type ResourceAssignment } from '../src/security/resources.ts';
import { AuthenticatedSourceQueue } from '../src/security/source.ts';
import { AuthenticatedSourceReview } from '../src/security/source-review.ts';
import { AuthenticatedSourceHandoff } from '../src/security/source-handoff.ts';
import { AuthenticatedEditorial } from '../src/security/editorial.ts';
import type { Permission } from '../src/security/types.ts';
import { seedSecurityFixture, type FictionalSecurityAccount } from './security-fiction.ts';

export const editorialWorkflowAt = '2026-06-01T12:00:00.000Z';
export const editorialWorkflowFixtureAt = editorialWorkflowAt;

/** Trusted composition into the caller's disposable fictional repository, never an HTTP input. */
export async function seedEditorialWorkflowFixture(repository: JsonRepository) {
  const articles: ProviderArticle[] = ['pending', 'proof', 'disputed', 'other'].map(name => ({
    providerId: 'fictional-fixture', url: `https://editorial-workflow.example.test/${name}`,
    publisher: `Fictional workflow ${name} report`, publishedAt: editorialWorkflowAt, retrievedAt: editorialWorkflowAt,
    provenance: { type: name === 'proof' ? 'ORIGINAL' : 'UNKNOWN', originId: null },
  }));
  const sourceIds = Object.fromEntries(articles.map(article => [new URL(article.url).pathname.slice(1), sourceId(article.url)])) as {
    pending: string; proof: string; disputed: string; other: string;
  };
  const discovery = await ingestArticles(repository, articles,
    { providerId: 'fictional-fixture', policyId: 'fictional-ai-editorial-v1' }, {
      dryRun: false, clock: () => editorialWorkflowAt,
      resolutions: [{ sourceId: sourceIds.proof, classification: 'ORIGINAL', originId: null,
        actorAssertion: 'fictional-proof-bootstrap', at: editorialWorkflowAt,
        evidenceReferences: ['fictional-proof:original-record'], reason: 'Invented original provenance evidence' }],
    });
  if (discovery.processed !== 1 || discovery.quarantined !== 3 || discovery.failed || discovery.rejected || discovery.duplicate) {
    throw Error('Unexpected fictional discovery outcome');
  }
  const seeded = await seedSecurityFixture(repository, editorialWorkflowAt);
  const confirming: FictionalSecurityAccount = structuredClone(seeded.accounts.managing);
  confirming.identity.id = randomUUID(); confirming.identity.provider.subject = randomUUID();
  confirming.claims.subject = confirming.identity.provider.subject; confirming.claims.sessionId = randomUUID();
  confirming.credential = seeded.verifier.issue(confirming.claims);
  const accounts = { ...seeded.accounts, confirming };
  await repository.transact(state => {
    state.identities.push(structuredClone(confirming.identity));
    // This invented evidence label is fixture setup, never an automatic review upgrade.
    state.sources.find(source => source.id === sourceIds.proof)!.verification = 'VERIFIED';
  });
  await seeded.access.registerSession(confirming.credential);

  const humanStory: Omit<Story, 'status' | 'version' | 'sourceHandoff'> = {
    id: 'fictional-workflow-story', headline: 'An invented community garden proposal is under review',
    summary: 'A human-authored fictional summary supplied explicitly for the isolated workflow demonstration.',
    topic: 'fiction', geography: 'Imaginary Town', eventAt: null, firstSeenAt: editorialWorkflowAt,
    updatedAt: editorialWorkflowAt, clusterId: 'fictional-workflow-cluster', sourceIds: [sourceIds.pending],
    evidence: [{ id: 'fictional-workflow-claim', claim: 'An invented community garden proposal is under review.',
      support: [sourceIds.pending], contradict: [], verification: 'VERIFIED',
      uncertainty: 'This is invented fixture evidence and establishes no real-world fact.', reviewerDecisions: [] }],
  };
  const sourcePermissions: Permission[] = ['SOURCE_READ', 'SOURCE_REVIEW', 'SOURCE_RESOLVE', 'SOURCE_HOLD', 'SOURCE_RELEASE'];
  const storyPermissions: Permission[] = ['STORY_CREATE', 'STORY_EDIT', 'STORY_REVIEW', 'STORY_APPROVE',
    'EDITION_ASSEMBLE', 'EDITION_REVIEW', 'EDITION_READY'];
  const assignments: ResourceAssignment[] = [];
  for (const account of Object.values(accounts)) {
    for (const id of [sourceIds.pending, sourceIds.proof, sourceIds.disputed]) {
      for (const permission of sourcePermissions) assignments.push({ identityId: account.identity.id, kind: 'SOURCE', id, permission });
    }
    for (const id of [humanStory.id, 'fictional-workflow-expired', 'fictional-workflow-substitution']) {
      for (const permission of storyPermissions) assignments.push({ identityId: account.identity.id, kind: 'STORY', id, permission });
    }
    assignments.push({ identityId: account.identity.id, kind: 'EDITION', id: editionSlot('2026-06-01', 'UTC'), permission: 'EDITION_ASSEMBLE' });
  }
  // The unassigned 'other' source deliberately receives no SOURCE grant.
  const resourcePolicy = new AssignedResourcePolicy(assignments);
  const { access, verifier } = seeded;
  const sourceQueue = new AuthenticatedSourceQueue(repository, access, { resourcePolicy });
  const sourceReview = new AuthenticatedSourceReview(repository, access, { resourcePolicy });
  const sourceHandoff = new AuthenticatedSourceHandoff(repository, access, { resourcePolicy });
  const editorial = new AuthenticatedEditorial(repository, access, { resourcePolicy });
  async function resolve(id: string, classification: 'SECONDARY' | 'DISPUTED') {
    const evidenceReferences = [sourceIds.proof];
    const initial = await sourceReview.inspect(accounts.managing.credential, id);
    const begun = await sourceReview.begin(accounts.managing.credential, id,
      { revision: initial.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences });
    const proposed = await sourceReview.propose(accounts.managing.credential, id,
      { revision: begun.revision, reasonCode: classification === 'DISPUTED' ? 'CONTRADICTORY_EVIDENCE' : 'EVIDENCE_SUPPORTED',
        evidenceReferences, classification, originId: null });
    return sourceReview.confirm(accounts.confirming.credential, id,
      { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences });
  }
  return { accounts, access, verifier, sourceIds, assignments, resourcePolicy, policy: resourcePolicy,
    sourceQueue, sourceReview, sourceHandoff, editorial, discovery,
    humanStory, story: humanStory, storyTemplate: humanStory,
    resolvePending: () => resolve(sourceIds.pending, 'SECONDARY'),
    resolveDisputed: () => resolve(sourceIds.disputed, 'DISPUTED') };
}
