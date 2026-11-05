import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { articles, context, fixtureAt, resolutions } from '../fixtures/fictional-news.ts';
import { ingestArticles, resolveQuarantined, sourceId } from '../src/ingestion/ingest.ts';
import { getPolicy, policyStatus } from '../src/ingestion/policies.ts';
import { cleanupRetention } from '../src/ingestion/retention.ts';
import type { ResolutionInput } from '../src/ingestion/records.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import type { Source, State, Story } from '../src/newsroom/model.ts';
import { Newsroom } from '../src/newsroom/service.ts';
import { JsonRepository } from '../src/newsroom/store.ts';

const cleanupAt = '2026-06-02T12:00:00.000Z';
const auditExpiresAt = '2026-06-03T12:00:00.000Z';
const later = '2026-06-01T18:00:00.000Z';
const counts = { processed: 0, duplicate: 0, rejected: 0, quarantined: 0, failed: 0 };
const originalId = sourceId(articles[0].url);
const noAuditContext = { ...context, policyId: 'fictional-no-audit-v1' };
const initial = { dryRun: false, clock: () => fixtureAt, resolutions };

async function withRepository(run: (repository: JsonRepository) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-reingestion-'));
  try { await run(new JsonRepository(join(directory, 'fictional.json'))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function fresh(at = cleanupAt): ProviderArticle {
  return { ...articles[0], url: 'https://fiction.example.test/one/?utm_source=replay#fictional-alias', retrievedAt: at };
}
function settings(at = cleanupAt) {
  return { dryRun: false, clock: () => at, resolutions: [{ ...resolutions[0], at }] };
}
async function seed(repository: JsonRepository, policyId = context.policyId): Promise<void> {
  assert.deepEqual(await ingestArticles(repository, [articles[0]], { ...context, policyId }, initial), { ...counts, processed: 1 });
}
function assertNoOriginalIdentity(state: State): void {
  const serialized = JSON.stringify(state);
  for (const identity of [originalId, articles[0].url, 'fiction.example.test/one', articles[0].publisher,
    resolutions[0].actorAssertion, resolutions[0].reason, ...resolutions[0].evidenceReferences]) {
    assert.equal(serialized.includes(identity), false, `Removed identity must not persist: ${identity}`);
  }
  assert.deepEqual(state.sources, []);
  assert.deepEqual(state.managedSources, []);
  assert.deepEqual(state.quarantine, []);
  assert.deepEqual(state.provenanceDecisions, []);
}
function unrelatedStory(id: string, status: Story['status']): Story {
  return { id: 'fictional-unrelated-story', headline: 'Fictional unrelated exercise', topic: 'fixture', summary: 'Invented test example', geography: 'Fictional location',
    firstSeenAt: later, updatedAt: later, eventAt: null, clusterId: 'fictional-cluster', sourceIds: [id], status, version: 1,
    evidence: [{ id: 'fictional-claim', claim: 'Fictional claim', support: [id], contradict: [], verification: 'VERIFIED', uncertainty: '', reviewerDecisions: [] }] };
}
async function seedUnexpiredIndependent(repository: JsonRepository, unresolved = false): Promise<ProviderArticle> {
  const input: ProviderArticle = { ...articles[0], url: 'https://fiction.example.test/unrelated', retrievedAt: later,
    provenance: unresolved ? { type: 'UNKNOWN', originId: null } : { type: 'ORIGINAL', originId: null } };
  const resolution: ResolutionInput = { ...resolutions[0], sourceId: sourceId(input.url), at: later };
  assert.deepEqual(await ingestArticles(repository, [input], context, { dryRun: false, clock: () => later, resolutions: unresolved ? [] : [resolution] }), { ...counts, [unresolved ? 'quarantined' : 'processed']: 1 });
  return input;
}

test('approved permitted audit creates a bounded marker and blocks refreshed original or alternate-policy replay', async () => {
  await withRepository(async repository => {
    await seed(repository);
    assert.equal((await repository.read()).retentionReviewRequired, false);
    assert.deepEqual(await cleanupRetention(repository, cleanupAt, false), { candidates: 1, deleted: 1 });
    const deleted = await repository.read();
    assert.equal(deleted.retentionReviewRequired, true);
    assert.deepEqual(deleted.sources, []);
    assert.equal(deleted.deletions.length, 1);
    assert.equal(deleted.deletions[0].sourceId, originalId);
    assert.equal(deleted.deletions[0].expiresAt, auditExpiresAt);
    for (const policyId of [context.policyId, 'fictional-metadata-v2']) {
      const before = await repository.read();
      assert.deepEqual(await ingestArticles(repository, [fresh()], { ...context, policyId }, settings()), { ...counts, rejected: 1 });
      const after = await repository.read();
      assert.equal(after.audit.length, before.audit.length + 1);
      assert.equal(after.audit.at(-1)?.subjectId, undefined);
      assert.deepEqual(after.sources, []);
      assert.deepEqual(after.quarantine, []);
      assert.equal(after.retentionReviewRequired, true);
    }
  });
});

test('a genuine approved no-audit policy deletes identifiers while blocking all refreshed replay', async () => {
  await withRepository(async repository => {
    const policy = getPolicy(noAuditContext.providerId, noAuditContext.policyId, fixtureAt);
    assert.equal(policyStatus(policy, fixtureAt), 'ACTIVE');
    assert.equal(policy.minimalAudit, false);
    assert.equal(policy.auditRetentionDays, 0);
    await seed(repository, noAuditContext.policyId);
    assert.deepEqual(await cleanupRetention(repository, cleanupAt, false), { candidates: 1, deleted: 1 });
    const removed = await repository.read();
    assert.equal(removed.retentionReviewRequired, true);
    assertNoOriginalIdentity(removed);
    assert.deepEqual(removed.deletions, []);
    assert.deepEqual(removed.audit, []);
    for (const policyId of [noAuditContext.policyId, context.policyId, 'fictional-metadata-v2']) {
      assert.deepEqual(await ingestArticles(repository, [fresh()], { ...context, policyId }, settings()), { ...counts, rejected: 1 });
    }
    const blocked = await repository.read();
    assertNoOriginalIdentity(blocked);
    assert.deepEqual(blocked.deletions, []);
    assert.equal(blocked.audit.length, 3);
    assert.ok(blocked.audit.every(event => event.subjectId === undefined && event.storyId === null));
  });
});

test('unknown or altered policy snapshots cannot retain identifiers or restore deleted sources', async () => {
  for (const change of ['unknown-id', 'altered-permission', 'unapproved-no-audit'] as const) {
    await withRepository(async repository => {
      await seed(repository);
      await repository.transact(state => {
        const policy = state.managedSources[0].policy;
        if (change === 'unknown-id') policy.id = 'fictional-unregistered-policy';
        else if (change === 'altered-permission') policy.publicRedistribution = true;
        else policy.minimalAudit = false;
      });
      assert.equal(policyStatus((await repository.read()).managedSources[0].policy, cleanupAt), 'UNKNOWN');
      assert.deepEqual(await cleanupRetention(repository, cleanupAt, false), { candidates: 1, deleted: 1 });
      const removed = await repository.read();
      assertNoOriginalIdentity(removed);
      assert.deepEqual(removed.deletions, []);
      assert.deepEqual(removed.audit, []);
      assert.equal(removed.retentionReviewRequired, true);
      for (const policyId of [context.policyId, 'fictional-metadata-v2']) {
        assert.deepEqual(await ingestArticles(repository, [fresh()], { ...context, policyId }, settings()), { ...counts, rejected: 1 });
      }
      assertNoOriginalIdentity(await repository.read());
    });
  }
});

test('inactive provider policy contexts remain denied without writing while a retention review is required', async () => {
  await withRepository(async repository => {
    await seed(repository, noAuditContext.policyId);
    await cleanupRetention(repository, cleanupAt, false);
    const before = await readFile(repository.file, 'utf8');
    for (const policyId of ['fictional-expired-v1', 'fictional-revoked-v1', 'fictional-superseded-v1']) {
      await assert.rejects(ingestArticles(repository, [fresh()], { ...context, policyId }, settings()), /policy/i);
    }
    assert.equal(await readFile(repository.file, 'utf8'), before);
  });
});

test('expired markers and all linked audit identifiers are purged without clearing the review requirement', async () => {
  await withRepository(async repository => {
    await seed(repository);
    await cleanupRetention(repository, cleanupAt, false);
    const marker = (await repository.read()).deletions[0];
    assert.equal(marker.expiresAt, auditExpiresAt);
    assert.deepEqual(await cleanupRetention(repository, '2026-06-03T11:59:59.999Z', false), { candidates: 0, deleted: 0 });
    assert.equal((await repository.read()).deletions.length, 1);
    assert.deepEqual(await cleanupRetention(repository, auditExpiresAt, false), { candidates: 0, deleted: 0 });
    const removed = await repository.read();
    assertNoOriginalIdentity(removed);
    assert.deepEqual(removed.deletions, []);
    assert.ok(removed.audit.every(event => event.subjectId === undefined));
    assert.equal(removed.retentionReviewRequired, true);
    assert.deepEqual(await ingestArticles(repository, [fresh(auditExpiresAt)], context, settings(auditExpiresAt)), { ...counts, rejected: 1 });
    assertNoOriginalIdentity(await repository.read());
  });
});

test('repeated cleanup is idempotent after identifier-free deletion and after marker expiration', async () => {
  for (const policyId of [noAuditContext.policyId, context.policyId]) {
    await withRepository(async repository => {
      await seed(repository, policyId);
      await cleanupRetention(repository, cleanupAt, false);
      await cleanupRetention(repository, auditExpiresAt, false);
      const before = await readFile(repository.file, 'utf8');
      assert.deepEqual(await cleanupRetention(repository, auditExpiresAt, false), { candidates: 0, deleted: 0 });
      assert.equal(await readFile(repository.file, 'utf8'), before);
      assert.equal((await repository.read()).retentionReviewRequired, true);
    });
  }
});

test('dry-run cleanup and dry-run replay never alter persisted retention decisions', async () => {
  await withRepository(async repository => {
    await seed(repository);
    const original = await readFile(repository.file, 'utf8');
    assert.deepEqual(await cleanupRetention(repository, cleanupAt), { candidates: 1, deleted: 0 });
    assert.equal(await readFile(repository.file, 'utf8'), original);
    assert.equal((await repository.read()).retentionReviewRequired, false);
    await cleanupRetention(repository, cleanupAt, false);
    const before = await readFile(repository.file, 'utf8');
    assert.deepEqual(await cleanupRetention(repository, auditExpiresAt), { candidates: 0, deleted: 0 });
    assert.deepEqual(await ingestArticles(repository, [fresh()], context, { ...settings(), dryRun: true }), { ...counts, rejected: 1 });
    assert.equal(await readFile(repository.file, 'utf8'), before);
  });
});

test('a wholly new repository cannot infer deletion history from another repository', async () => {
  await withRepository(async original => {
    await seed(original, noAuditContext.policyId);
    await cleanupRetention(original, cleanupAt, false);
    await withRepository(async independent => {
      assert.equal((await independent.read()).retentionReviewRequired, false);
      assert.deepEqual(await ingestArticles(independent, [fresh()], context, settings()), { ...counts, processed: 1 });
      assert.equal((await independent.read()).sources.length, 1);
    });
    assert.equal((await original.read()).retentionReviewRequired, true);
    assertNoOriginalIdentity(await original.read());
  });
});

test('concurrent cleanup and refreshed duplicate attempts leave a deterministic deleted final state', async () => {
  for (const policyId of [context.policyId, noAuditContext.policyId]) {
    await withRepository(async repository => {
      await seed(repository, policyId);
      const results = await Promise.all([
        cleanupRetention(new JsonRepository(repository.file), cleanupAt, false),
        ...Array.from({ length: 8 }, () => ingestArticles(new JsonRepository(repository.file), [fresh()], { ...context, policyId }, settings())),
      ]);
      assert.deepEqual(results[0], { candidates: 1, deleted: 1 });
      for (const result of results.slice(1)) {
        assert.ok('processed' in result);
        assert.equal(result.processed + result.failed + result.quarantined, 0);
        assert.equal(result.duplicate + result.rejected, 1);
      }
      const state = await repository.read();
      assert.equal(state.retentionReviewRequired, true);
      assert.deepEqual(state.sources, []);
      assert.deepEqual(state.managedSources, []);
      assert.deepEqual(state.quarantine, []);
      assert.deepEqual(state.provenanceDecisions, []);
      if (policyId === noAuditContext.policyId) assertNoOriginalIdentity(state);
    });
  }
});

test('a failed retention transaction preserves all state and a retry atomically sets the review requirement', async () => {
  await withRepository(async repository => {
    await seed(repository, noAuditContext.policyId);
    const before = await readFile(repository.file, 'utf8');
    const failing = new JsonRepository(repository.file, { beforeCommit: () => { throw Error('fictional cleanup commit failure'); } });
    await assert.rejects(cleanupRetention(failing, cleanupAt, false), /fictional cleanup commit failure/);
    assert.equal(await readFile(repository.file, 'utf8'), before);
    assert.equal((await repository.read()).retentionReviewRequired, false);
    assert.deepEqual(await cleanupRetention(repository, cleanupAt, false), { candidates: 1, deleted: 1 });
    const state = await repository.read();
    assert.equal(state.retentionReviewRequired, true);
    assertNoOriginalIdentity(state);
    assert.deepEqual(state.audit, []);
  });
});

test('a failed blocked-ingestion audit reports failure and a retry records one generic rejection', async () => {
  await withRepository(async repository => {
    await seed(repository, noAuditContext.policyId);
    await cleanupRetention(repository, cleanupAt, false);
    const before = await readFile(repository.file, 'utf8');
    const failing = new JsonRepository(repository.file, { beforeCommit: () => { throw Error('fictional blocked audit commit failure'); } });
    assert.deepEqual(await ingestArticles(failing, [fresh()], context, settings()), { ...counts, failed: 1 });
    assert.equal(await readFile(repository.file, 'utf8'), before);
    assert.deepEqual(await ingestArticles(repository, [fresh()], context, settings()), { ...counts, rejected: 1 });
    const state = await repository.read();
    assertNoOriginalIdentity(state);
    assert.equal(state.audit.length, 1);
    assert.equal(state.audit[0].subjectId, undefined);
    assert.equal(state.retentionReviewRequired, true);
  });
});

test('legacy fixture ingestion cannot bypass a repository-wide retention review requirement', async () => {
  await withRepository(async repository => {
    await seed(repository, noAuditContext.policyId);
    await cleanupRetention(repository, cleanupAt, false);
    const before = await readFile(repository.file, 'utf8');
    const source: Omit<Source, 'canonicalUrl'> = { id: 'fictional-legacy-new-id', url: 'https://fiction.example.test/entirely-new', publisher: 'Fictional legacy publisher',
      publishedAt: fixtureAt, retrievedAt: cleanupAt, type: 'ORIGINAL', originId: 'fictional-legacy-new-id', rights: 'fictional test fixture only', verification: 'VERIFIED' };
    await assert.rejects(new Newsroom(repository, { clock: () => cleanupAt }).ingest(source, 'fictional-legacy-reviewer'));
    assert.equal(await readFile(repository.file, 'utf8'), before);
  });
});

test('quarantine resolution remains blocked for unexpired unrelated metadata under a review requirement', async () => {
  await withRepository(async repository => {
    await seed(repository, noAuditContext.policyId);
    const input = await seedUnexpiredIndependent(repository, true);
    await cleanupRetention(repository, cleanupAt, false);
    const before = await repository.read();
    const resolution: ResolutionInput = { ...resolutions[0], sourceId: sourceId(input.url), at: cleanupAt, actorAssertion: 'private-blocked-resolution-actor' };
    assert.equal(await resolveQuarantined(repository, resolution, cleanupAt), 'rejected');
    const after = await repository.read();
    assert.deepEqual(after.quarantine, before.quarantine);
    assert.deepEqual(after.sources, []);
    assert.deepEqual(after.provenanceDecisions, []);
    assert.equal(after.audit.length, before.audit.length + 1);
    assert.equal(after.audit.at(-1)?.subjectId, undefined);
    assert.equal(JSON.stringify(after).includes(resolution.actorAssertion), false);
  });
});

test('unexpired unrelated sources stop counting and cannot receive approval while retention review is required', async () => {
  await withRepository(async repository => {
    await seed(repository, noAuditContext.policyId);
    const input = await seedUnexpiredIndependent(repository);
    const id = sourceId(input.url);
    await repository.transact(state => { state.revisions.push(unrelatedStory(id, 'NEEDS_REVIEW')); });
    await cleanupRetention(repository, cleanupAt, false);
    const newsroom = new Newsroom(repository, { clock: () => cleanupAt });
    assert.equal(await newsroom.independentCount([id]), 0);
    await assert.rejects(newsroom.transition('fictional-unrelated-story', 'APPROVED', 'fictional-reviewer'));
    assert.equal((await repository.read()).approvals.length, 0);
  });
});

test('previous approval cannot publish an unexpired unrelated source while retention review is required', async () => {
  await withRepository(async repository => {
    await seed(repository, noAuditContext.policyId);
    const input = await seedUnexpiredIndependent(repository);
    await repository.transact(state => {
      state.revisions.push(unrelatedStory(sourceId(input.url), 'APPROVED'));
      state.approvals.push({ storyId: 'fictional-unrelated-story', version: 1, reviewer: 'fictional-reviewer', at: later });
    });
    await cleanupRetention(repository, cleanupAt, false);
    const before = await readFile(repository.file, 'utf8');
    await assert.rejects(new Newsroom(repository, { clock: () => cleanupAt }).transition('fictional-unrelated-story', 'PUBLISHED', 'fictional-reviewer'));
    assert.equal(await readFile(repository.file, 'utf8'), before);
  });
});
