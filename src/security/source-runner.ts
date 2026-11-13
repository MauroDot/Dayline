/** Isolated fictional source-access demonstration. No listener, caller path or live mode. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSourceAccessFixture } from '../../fixtures/source-access-fiction.ts';
import { sourceQueueFixtureAt } from '../../fixtures/source-queue-fiction.ts';
import { JsonRepository } from '../newsroom/store.ts';
import type { SourceQueueEntry } from '../source-queue/types.ts';
import { AuthenticatedEditorial } from './editorial.ts';
import { SecurityError } from './verifier.ts';

const editorialKeys = ['revisions', 'approvals', 'drafts', 'draftReviews', 'editions', 'editionReviews', 'schedules', 'preparationRuns'] as const;

/** Keep the demonstration output independent of internal page/cursor/session state. */
function metadata(entry: SourceQueueEntry): SourceQueueEntry {
  return { candidateRef: entry.candidateRef, publisher: entry.publisher, canonicalUrl: entry.canonicalUrl,
    publishedAt: entry.publishedAt, retrievedAt: entry.retrievedAt, provenance: entry.provenance,
    provenanceStatus: entry.provenanceStatus, rightsStatus: entry.rightsStatus, retentionStatus: entry.retentionStatus,
    quarantineStatus: entry.quarantineStatus,
    relationship: entry.relationship ? { kind: entry.relationship.kind, originRef: entry.relationship.originRef } : null,
    sourceEligible: entry.sourceEligible, canAdvance: entry.canAdvance, blockedReason: entry.blockedReason };
}

async function denial(action: () => Promise<unknown>, expected: 'PERMISSION_DENIED' | 'SESSION_REVOKED') {
  try { await action(); }
  catch (error) {
    if (error instanceof SecurityError && error.code === expected) return { denied: true, code: expected };
    throw Error('Unexpected fictional access outcome');
  }
  throw Error('Unexpected fictional access outcome');
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw Error('Only the isolated fictional source access fixture is supported');
  const directory = await mkdtemp(join(tmpdir(), 'dayline-fictional-source-access-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const { accounts, access, resourcePolicy, sourceQueue } = await seedSourceAccessFixture(repository);
    const before = await repository.read();
    const page = await sourceQueue.read(accounts.editor.credential, { limit: 50 });
    if (page.entries.length !== 1 || page.nextCursor !== null || page.entries[0].publisher !== 'Fictional Original Gazette'
      || page.entries[0].relationship !== null || page.entries.some(entry => entry.canAdvance)) throw Error('Unexpected fictional source view');
    const unauthorizedEditorial = await denial(() => sourceQueue.read(accounts.managing.credential), 'PERMISSION_DENIED');
    const administrator = await denial(() => sourceQueue.read(accounts.admin.credential), 'PERMISSION_DENIED');

    const editorial = new AuthenticatedEditorial(repository, access, { resourcePolicy });
    for (const account of Object.values(accounts)) {
      await denial(() => editorial.approveStory(account.credential, 'fictional-unassigned-story', 1), 'PERMISSION_DENIED');
      await denial(() => editorial.reviewStory(account.credential, 'fictional-unassigned-story', 1, 'DRAFT'), 'PERMISSION_DENIED');
    }
    if (['approveStory', 'reviewStory', 'publish'].some(method => method in sourceQueue)) throw Error('Unexpected fictional source interface');
    const after = await repository.read();
    if (editorialKeys.some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))) throw Error('Unexpected fictional editorial change');

    await access.invalidateSession(accounts.editor.credential);
    const revokedEditorial = await denial(() => sourceQueue.read(accounts.editor.credential), 'SESSION_REVOKED');
    console.log(JSON.stringify({ fictional: true, developmentOnly: true, asOf: sourceQueueFixtureAt,
      authorizedEditorial: { entries: page.entries.map(metadata) }, unauthorizedEditorial, administrator, revokedEditorial,
      sourceReadOnly: { canApprove: false, canAdvance: false, canPublish: false, editorialStateUnchanged: true } }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

main().catch(() => { console.error('Fictional source access demonstration failed'); process.exitCode = 1; });
