/** Invented source metadata for local development only; no real reporting or licensing. */
import { ingestArticles, sourceId } from '../src/ingestion/ingest.ts';
import { managed, metadata, timestamp } from '../src/ingestion/metadata.ts';
import { getPolicy } from '../src/ingestion/policies.ts';
import { resolveDecision } from '../src/ingestion/provenance.ts';
import type { ResolutionInput } from '../src/ingestion/records.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import { Newsroom } from '../src/newsroom/service.ts';
import type { JsonRepository } from '../src/newsroom/store.ts';

/** Historical fixture time inside the existing fictional registry grant. */
export const sourceQueueFixtureAt = '2026-06-01T12:00:00.000Z';

const context = { providerId: 'fictional-fixture', policyId: 'fictional-metadata-v1' };
const fixtureURL = (name: string) => `https://source-queue.example.test/${name}`;

function article(name: string, publisher: string, at: string, provenance: ProviderArticle['provenance']): ProviderArticle {
  return { providerId: context.providerId, url: fixtureURL(name), publisher, publishedAt: at, retrievedAt: at, provenance };
}

function resolution(input: ProviderArticle, at: string): ResolutionInput {
  return { sourceId: sourceId(input.url), classification: input.provenance.type, originId: input.provenance.originId,
    actorAssertion: 'fictional-source-reviewer', at, evidenceReferences: ['fictional-evidence:source-queue'],
    reason: 'Invented provenance assertion for the fictional development fixture only' };
}

/**
 * Populate existing repository records only. No story, approval, provider call,
 * publication, new policy grant, or separate queue database is created.
 */
export async function seedSourceQueueFixture(repository: JsonRepository, at = sourceQueueFixtureAt): Promise<{ duplicateDiscoveries: number }> {
  const fixtureAt = new Date(timestamp(at)).toISOString();
  const expiredAt = new Date(timestamp(fixtureAt) - 2 * 86_400_000).toISOString();
  // Validate both historical ingestion times before writing any fixture state.
  const activePolicy = getPolicy(context.providerId, context.policyId, fixtureAt);
  getPolicy(context.providerId, context.policyId, expiredAt);

  const fresh = article('new', 'Fictional New Discovery Desk', fixtureAt, { type: 'UNKNOWN', originId: null });
  const original = article('original', 'Fictional Original Gazette', fixtureAt, { type: 'ORIGINAL', originId: null });
  const disputed = article('disputed', 'Fictional Disputed Origin Desk', fixtureAt, { type: 'DISPUTED', originId: null });
  const copy = article('copy', 'Fictional Syndication Desk', fixtureAt, { type: 'SYNDICATED', originId: sourceId(original.url) });
  const duplicate = { ...original, url: `${original.url}?utm_source=fictional-repeat` };
  const current = await ingestArticles(repository, [fresh, original, disputed, copy, duplicate], context,
    { dryRun: false, clock: () => fixtureAt, resolutions: [original, disputed, copy].map(input => resolution(input, fixtureAt)) });
  if (current.rejected || current.failed) throw Error('Fictional source queue fixture could not be seeded');

  // Ingest through the ordinary workflow at the original retrieval time. The
  // current queue must withhold this metadata after its one-day grant ends.
  const expired = article('expired', 'Fictional Expired Archive', expiredAt, { type: 'ORIGINAL', originId: null });
  const historical = await ingestArticles(repository, [expired], context,
    { dryRun: false, clock: () => expiredAt, resolutions: [resolution(expired, expiredAt)] });
  if (historical.rejected || historical.failed) throw Error('Fictional historical source could not be seeded');

  // The registry cannot return a revoked grant for new ingestion. Model an
  // already captured historical snapshot, matching the existing registered
  // fictional revoked fixture exactly, without adding or approving a policy.
  const revoked = article('revoked', 'Fictional Revoked Archive', fixtureAt, { type: 'ORIGINAL', originId: null });
  const revokedPolicy = { ...activePolicy, id: 'fictional-revoked-v1', evidenceReference: 'fictional-fixture-only:fictional-revoked-v1' };
  await repository.transact(state => {
    if (state.managedSources.some(record => record.sourceId === sourceId(revoked.url))) return;
    const record = managed(metadata(revoked, context.providerId), revokedPolicy, fixtureAt);
    const result = resolveDecision(state, record, resolution(revoked, fixtureAt), fixtureAt);
    if (!result.source) throw Error('Fictional historical provenance was not resolved');
    state.managedSources.push(record);
    state.sources.push(result.source);
    state.provenanceDecisions.push(result.decision);
  });

  // Existing legacy fixture ingestion intentionally provides no registered
  // rights snapshot. Its free-text assertion must never become queue eligibility.
  if (!(await repository.read()).sources.some(source => source.id === 'fictional-source-queue-blocked')) {
    await new Newsroom(repository, { clock: () => fixtureAt }).ingest({ id: 'fictional-source-queue-blocked',
      url: fixtureURL('blocked'), publisher: 'Fictional Missing Rights Desk', publishedAt: fixtureAt, retrievedAt: fixtureAt,
      type: 'ORIGINAL', originId: 'fictional-source-queue-blocked', rights: 'fictional test fixture only', verification: 'UNVERIFIED' }, 'fictional-source-reviewer');
  }

  // Duplicate audits are intentionally anonymous in the existing ingestion
  // model. Report only outcomes observed during these actual ingestion calls.
  return { duplicateDiscoveries: current.duplicate + historical.duplicate };
}
