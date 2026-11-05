import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestArticles, sourceId } from '../src/ingestion/ingest.ts';
import { cleanupRetention } from '../src/ingestion/retention.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import { JsonRepository } from '../src/newsroom/store.ts';

const at = '2026-06-02T12:00:00.000Z';
const expired = '2026-05-31T12:00:00.000Z';
const later = '2026-06-05T12:00:00.000Z';
const counts = { processed: 0, duplicate: 0, rejected: 0, quarantined: 0, failed: 0 };
const article: ProviderArticle = { providerId: 'fictional-fixture', url: 'https://fiction.example.test/audit-only-rejection',
  publisher: 'FICTIONAL_REJECTED_PUBLISHER', publishedAt: expired, retrievedAt: expired,
  provenance: { type: 'UNKNOWN', originId: null } };

async function fixture(run: (repository: JsonRepository) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-audit-retention-'));
  try { await run(new JsonRepository(join(directory, 'fictional.json'))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('expired rejections retain no identifying subject under either no-audit or finite-audit policy', async () => {
  for (const policyId of ['fictional-no-audit-v1', 'fictional-metadata-v1']) {
    await fixture(async repository => {
      assert.deepEqual(await ingestArticles(repository, [article], { providerId: article.providerId, policyId },
        { dryRun: false, clock: () => at }), { ...counts, rejected: 1 });
      const state = await repository.read();
      assert.deepEqual(state.sources, []); assert.deepEqual(state.quarantine, []);
      assert.equal(state.audit.length, 1);
      assert.equal(state.audit[0].action, 'INGESTION_REJECTED');
      assert.equal(state.audit[0].subjectId, undefined);
      assert.doesNotMatch(JSON.stringify(state), /FICTIONAL_REJECTED|fiction\.example\.test|url-[a-f0-9]{64}/);
      await cleanupRetention(repository, later, false);
      assert.ok((await repository.read()).audit.every(event => event.subjectId === undefined));
    });
  }
});

test('contradictory provenance rejection cannot leave an ungoverned identifying audit', async () => {
  await fixture(async repository => {
    const input: ProviderArticle = { ...article, retrievedAt: at, provenance: { type: 'ORIGINAL', originId: null } };
    assert.deepEqual(await ingestArticles(repository, [input], { providerId: input.providerId, policyId: 'fictional-no-audit-v1' },
      { dryRun: false, clock: () => at, resolutions: [{ sourceId: sourceId(input.url), classification: 'SECONDARY', originId: null,
        actorAssertion: 'FICTIONAL_REJECTED_ASSERTION', at, evidenceReferences: ['FICTIONAL_REJECTED_EVIDENCE'], reason: 'FICTIONAL_REJECTED_REASON' }] }),
    { ...counts, rejected: 1 });
    await cleanupRetention(repository, later, false);
    const state = await repository.read();
    assert.deepEqual(state.managedSources, []); assert.deepEqual(state.provenanceDecisions, []);
    assert.equal(state.audit.length, 1); assert.equal(state.audit[0].subjectId, undefined);
    assert.doesNotMatch(JSON.stringify(state), /FICTIONAL_REJECTED|fiction\.example\.test|url-[a-f0-9]{64}/);
  });
});

test('legacy orphan subject audits are scrubbed without retaining raw identifiers or asserted actors', async () => {
  await fixture(async repository => {
    await repository.transact(state => {
      state.audit.push(Object.assign({ id: 'FICTIONAL_ORPHAN_EVENT', storyId: null, action: 'INGESTION_REJECTED',
        actor: 'FICTIONAL_ORPHAN_ACTOR', at, version: null, subjectId: 'FICTIONAL_ORPHAN_SOURCE_ID' },
      { copiedProviderText: 'FICTIONAL_ORPHAN_TEXT https://fiction.example.test/orphan' }));
    });
    const before = await readFile(repository.file, 'utf8');
    await cleanupRetention(repository, later);
    assert.equal(await readFile(repository.file, 'utf8'), before);
    await cleanupRetention(repository, later, false);
    const state = await repository.read();
    assert.equal(state.retentionReviewRequired, true);
    assert.ok(state.audit.every(event => event.subjectId === undefined && event.storyId === null));
    for (const event of state.audit) assert.deepEqual(Object.keys(event).sort(), ['id', 'storyId', 'action', 'actor', 'at', 'version'].sort());
    assert.deepEqual(state.deletions, []);
    assert.doesNotMatch(JSON.stringify(state), /FICTIONAL_ORPHAN|fiction\.example\.test/);
    await cleanupRetention(repository, later, false);
    assert.deepEqual(await repository.read(), state);
  });
});

test('an orphan source-to-story audit link taints copied prose even after revision references disappear', async () => {
  await fixture(async repository => {
    await repository.transact(state => {
      state.revisions.push({ id: 'FICTIONAL_LINKED_STORY', headline: 'FICTIONAL_LINKED_HEADLINE', topic: 'FICTIONAL_LINKED_TOPIC',
        summary: 'FICTIONAL_LINKED_COPIED_TEXT', geography: 'FICTIONAL_LINKED_GEOGRAPHY', eventAt: null,
        firstSeenAt: at, updatedAt: at, clusterId: null, sourceIds: [], evidence: [], status: 'APPROVED', version: 1 });
      state.approvals.push({ storyId: 'FICTIONAL_LINKED_STORY', version: 1, reviewer: 'FICTIONAL_LINKED_REVIEWER', at });
      state.audit.push({ id: 'FICTIONAL_LINKED_AUDIT', storyId: 'FICTIONAL_LINKED_STORY', action: 'STATUS_APPROVED',
        actor: 'FICTIONAL_LINKED_ACTOR', at, version: 1, subjectId: 'FICTIONAL_LINKED_REMOVED_SOURCE' });
    });
    await cleanupRetention(repository, later, false);
    const state = await repository.read();
    assert.equal(state.retentionReviewRequired, true);
    assert.equal(state.revisions[0].retentionRedacted, true);
    assert.equal(state.approvals[0].retentionRedacted, true);
    assert.equal(state.revisions[0].summary, '[retention redacted]');
    assert.doesNotMatch(JSON.stringify(state), /FICTIONAL_LINKED/);
  });
});
