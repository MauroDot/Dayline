/** Invented source metadata and synthetic editorial identities for isolated local tests only. */
import { randomUUID } from 'node:crypto';
import { sourceId } from '../src/ingestion/ingest.ts';
import type { JsonRepository } from '../src/newsroom/store.ts';
import { AssignedResourcePolicy } from '../src/security/resources.ts';
import { AuthenticatedSourceQueue } from '../src/security/source.ts';
import { AuthenticatedSourceReview } from '../src/security/source-review.ts';
import type { Permission } from '../src/security/types.ts';
import { seedSecurityFixture, type FictionalSecurityAccount } from './security-fiction.ts';
import { seedSourceQueueFixture, sourceQueueFixtureAt } from './source-queue-fiction.ts';

export const sourceReviewFixtureAt = sourceQueueFixtureAt;

/**
 * Trusted fixture composition only. This seeds records and exact assignments,
 * never review actions, story approval or publication. Returned credentials,
 * raw IDs and policy configuration belong exclusively inside trusted tests.
 */
export async function seedSourceReviewFixture(repository: JsonRepository) {
  await seedSourceQueueFixture(repository, sourceReviewFixtureAt);
  const seeded = await seedSecurityFixture(repository, sourceReviewFixtureAt);
  const { access, verifier } = seeded;
  const confirming: FictionalSecurityAccount = structuredClone(seeded.accounts.managing);
  confirming.identity.id = randomUUID();
  confirming.identity.provider.subject = randomUUID();
  confirming.claims.subject = confirming.identity.provider.subject;
  confirming.claims.sessionId = randomUUID();
  confirming.credential = verifier.issue(confirming.claims);
  const accounts = { ...seeded.accounts, confirming };
  const sourceIds = {
    pending: sourceId('https://source-queue.example.test/new'),
    original: sourceId('https://source-queue.example.test/original'),
    disputed: sourceId('https://source-queue.example.test/disputed'),
    copy: sourceId('https://source-queue.example.test/copy'),
  };
  await repository.transact(state => {
    state.identities.push(structuredClone(confirming.identity));
    // This is an explicitly invented original, not a verification claim about real reporting.
    state.sources.find(source => source.id === sourceIds.original)!.verification = 'VERIFIED';
  });
  await access.registerSession(confirming.credential);
  const sourcePermissions: Permission[] = ['SOURCE_READ', 'SOURCE_REVIEW', 'SOURCE_RESOLVE', 'SOURCE_HOLD', 'SOURCE_RELEASE'];
  const resourcePolicy = new AssignedResourcePolicy(Object.values(accounts).flatMap(account =>
    Object.values(sourceIds).flatMap(id => sourcePermissions.map(permission => ({
      identityId: account.identity.id, kind: 'SOURCE' as const, id, permission,
    })))));
  const sourceReview = new AuthenticatedSourceReview(repository, access, { resourcePolicy });
  const sourceQueue = new AuthenticatedSourceQueue(repository, access, { resourcePolicy });
  return { accounts, access, verifier, sourceIds, resourcePolicy, policy: resourcePolicy,
    sourceReview, workflow: sourceReview, sourceQueue };
}
