/** Synthetic identities and invented source records for isolated development tests only. */
import { sourceId } from '../src/ingestion/ingest.ts';
import type { JsonRepository } from '../src/newsroom/store.ts';
import { AssignedResourcePolicy } from '../src/security/resources.ts';
import { AuthenticatedSourceQueue } from '../src/security/source.ts';
import { seedSecurityFixture } from './security-fiction.ts';
import { seedSourceQueueFixture, sourceQueueFixtureAt } from './source-queue-fiction.ts';

/**
 * Trusted fixture composition, never an HTTP input or production credential source.
 * Returned identities, credentials and raw source IDs stay inside test code.
 * SOURCE_READ assignments authorize no story, draft, edition or publishing action.
 */
export async function seedSourceAccessFixture(repository: JsonRepository) {
  const { duplicateDiscoveries } = await seedSourceQueueFixture(repository, sourceQueueFixtureAt);
  const { accounts, access, verifier } = await seedSecurityFixture(repository, sourceQueueFixtureAt);
  const sourceIds = {
    original: sourceId('https://source-queue.example.test/original'),
    copy: sourceId('https://source-queue.example.test/copy'),
    new: sourceId('https://source-queue.example.test/new'),
  };
  const resourcePolicy = new AssignedResourcePolicy([
    { identityId: accounts.editor.identity.id, permission: 'SOURCE_READ', kind: 'SOURCE', id: sourceIds.original },
    // An explicit assignment still cannot replace the required editorial role.
    { identityId: accounts.admin.identity.id, permission: 'SOURCE_READ', kind: 'SOURCE', id: sourceIds.original },
  ]);
  const sourceQueue = new AuthenticatedSourceQueue(repository, access, { resourcePolicy });
  return { accounts, access, verifier, sourceIds, resourcePolicy, sourceQueue, duplicateDiscoveries };
}
