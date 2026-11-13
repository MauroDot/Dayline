import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestArticles, resolveQuarantined, sourceId } from '../src/ingestion/ingest.ts';
import { cleanupRetention } from '../src/ingestion/retention.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import type { ResolutionInput } from '../src/ingestion/records.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { emptyState, type State } from '../src/newsroom/model.ts';
import { SourceQueue, SourceQueueError } from '../src/source-queue/service.ts';
import type { SourceQueueQuery } from '../src/source-queue/types.ts';

const at = '2026-06-01T12:00:00.000Z';
const context = { providerId: 'fictional-fixture', policyId: 'fictional-metadata-v1' };
const article = (name: string, changes: Partial<ProviderArticle> = {}): ProviderArticle => ({
  providerId: context.providerId, publisher: `Fictional ${name}`, url: `https://queue.example.test/${name}`,
  publishedAt: '2026-06-01T09:00:00.000Z', retrievedAt: at, provenance: { type: 'ORIGINAL', originId: null }, ...changes,
});
const resolution = (value: ProviderArticle): ResolutionInput => ({ sourceId: sourceId(value.url), classification: value.provenance.type,
  originId: value.provenance.originId, actorAssertion: 'fictional-private-reviewer', at,
  evidenceReferences: ['fictional-private-evidence'], reason: 'Fictional private provenance assertion' });
async function withRepository(run: (repo: JsonRepository) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-queue-'));
  try { await run(new JsonRepository(join(directory, 'fictional.json'))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function seed(repo: JsonRepository, values: ProviderArticle[], resolved = true) {
  return ingestArticles(repo, values, context, { dryRun: false, clock: () => at, maxArticles: 100,
    resolutions: resolved ? values.map(resolution) : [] });
}
const code = (expected: SourceQueueError['code']) => (error: unknown) => error instanceof SourceQueueError && error.code === expected && error.message === expected;

test('new fictional discovery is inspectable but unresolved, quarantined and unable to advance', async () => {
  await withRepository(async repo => {
    const value = article('new', { provenance: { type: 'UNKNOWN', originId: null } });
    await seed(repo, [value], false);
    const queue = new SourceQueue(repo, { clock: () => at });
    const page = await queue.read();
    assert.equal(page.entries.length, 1);
    const entry = page.entries[0];
    assert.match(entry.candidateRef, /^candidate-[a-f0-9]{64}$/);
    assert.notEqual(entry.candidateRef, sourceId(value.url));
    assert.equal(entry.publisher, value.publisher);
    assert.equal(entry.canonicalUrl, value.url);
    assert.equal(entry.provenanceStatus, 'UNRESOLVED');
    assert.equal(entry.quarantineStatus, 'QUARANTINED');
    assert.equal(entry.rightsStatus, 'ACTIVE');
    assert.equal(entry.blockedReason, 'PROVENANCE_UNRESOLVED');
    assert.equal(entry.sourceEligible, false); assert.equal(entry.canAdvance, false);
    assert.equal((await queue.read({ view: 'UNRESOLVED' })).entries.length, 1);
    assert.equal((await queue.read({ view: 'ELIGIBLE' })).entries.length, 0);
    assert.equal((await repo.read()).revisions.length, 0);
    assert.equal((await repo.read()).approvals.length, 0);
  });
});

test('eligible means managed metadata only and queue reads grant no approval or extra rights', async () => {
  await withRepository(async repo => {
    await seed(repo, [article('eligible')]);
    const queue = new SourceQueue(repo, { clock: () => at });
    const before = await readFile(repo.file, 'utf8');
    const page = await queue.read({ view: 'ELIGIBLE' });
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].sourceEligible, true);
    assert.equal(page.entries[0].quarantineStatus, 'NOT_QUARANTINED');
    assert.equal(page.entries[0].blockedReason, null); assert.equal(page.entries[0].canAdvance, false);
    const state = await repo.read();
    assert.equal(state.managedSources[0].policy.internalAnalysis, false);
    assert.equal(state.managedSources[0].policy.aiSummarization, false);
    assert.equal(state.managedSources[0].policy.publicRedistribution, false);
    assert.equal(state.approvals.length, 0);
    assert.equal(await readFile(repo.file, 'utf8'), before);
  });
});

test('duplicate discovery stays one candidate, anonymous and unable to refresh retrieval or retention', async () => {
  await withRepository(async repo => {
    const value = article('duplicate');
    await seed(repo, [value]);
    const queue = new SourceQueue(repo, { clock: () => at });
    const original = await repo.read(); const page = await queue.read();
    const result = await ingestArticles(repo, [{ ...value, url: `${value.url}/?utm_source=fixture`, retrievedAt: '2026-06-01T13:00:00.000Z' }],
      { ...context, policyId: 'fictional-metadata-v2' }, { dryRun: false, clock: () => '2026-06-01T13:00:00.000Z' });
    assert.equal(result.duplicate, 1);
    assert.deepEqual((await repo.read()).managedSources, original.managedSources);
    assert.deepEqual(await queue.read(), page);
    assert.equal((await repo.read()).audit.find(row => row.action === 'INGESTION_DUPLICATE')?.subjectId, undefined);
    assert.equal((await queue.read({ view: 'RELATED' })).entries.length, 0);
  });
});

test('verified syndication links one eligible original without claiming independent reporting', async () => {
  await withRepository(async repo => {
    const original = article('origin');
    const copy = article('copy', { provenance: { type: 'SYNDICATED', originId: sourceId(original.url) } });
    await seed(repo, [original, copy]);
    const queue = new SourceQueue(repo, { clock: () => at });
    const all = await queue.read(); const related = await queue.read({ view: 'RELATED' });
    assert.equal(related.entries.length, 1);
    const originRef = all.entries.find(row => row.canonicalUrl === original.url)!.candidateRef;
    assert.deepEqual(related.entries[0].relationship, { kind: 'SYNDICATED', originRef });
    assert.equal(related.entries[0].provenance, 'SYNDICATED');
    assert.equal(related.entries[0].canAdvance, false);
    assert.doesNotMatch(JSON.stringify(related), /independentCount|corroborated|fictional-private/);
    await repo.transact(state => { state.sources = state.sources.filter(row => row.id !== sourceId(original.url)); });
    assert.equal((await queue.read({ view: 'RELATED' })).entries.length, 0);
    const unavailable = (await queue.read()).entries.find(row => row.candidateRef === related.entries[0].candidateRef)!;
    assert.equal(unavailable.sourceEligible, false); assert.equal(unavailable.canonicalUrl, null);
    assert.equal(unavailable.blockedReason, 'ORIGIN_UNAVAILABLE');
  });
});

test('UNKNOWN and DISPUTED decisions remain unresolved and captured deadlines survive resolution', async () => {
  await withRepository(async repo => {
    const unknown = article('unknown', { provenance: { type: 'UNKNOWN', originId: null } });
    const disputed = article('disputed', { provenance: { type: 'DISPUTED', originId: null } });
    await seed(repo, [unknown, disputed], false);
    const queue = new SourceQueue(repo, { clock: () => at });
    const captured = (await repo.read()).quarantine.find(row => row.sourceId === sourceId(unknown.url))!;
    assert.equal(await resolveQuarantined(repo, resolution(unknown), at), 'unresolved');
    assert.equal(await resolveQuarantined(repo, resolution(disputed), at), 'unresolved');
    assert.equal((await queue.read({ view: 'UNRESOLVED' })).entries.length, 2);
    assert.equal((await queue.read()).entries.find(row => row.canonicalUrl === disputed.url)!.blockedReason, 'PROVENANCE_DISPUTED');
    assert.equal(await resolveQuarantined(repo, { ...resolution(unknown), classification: 'ORIGINAL' }, at), 'resolved');
    assert.equal((await queue.read({ view: 'ELIGIBLE' })).entries.length, 1);
    const managed = (await repo.read()).managedSources[0];
    assert.equal(managed.deleteAt, captured.deleteAt); assert.equal(managed.providerMetadata.retrievedAt, captured.providerMetadata.retrievedAt);
  });
});

test('the exact original retention deadline withholds metadata before cleanup', async () => {
  await withRepository(async repo => {
    await seed(repo, [article('expires')]);
    let clock = at;
    const queue = new SourceQueue(repo, { clock: () => clock });
    assert.equal((await queue.read()).entries[0].sourceEligible, true);
    clock = '2026-06-02T12:00:00.000Z';
    const entry = (await queue.read()).entries[0];
    assert.equal(entry.retentionStatus, 'EXPIRED'); assert.equal(entry.blockedReason, 'RETENTION_EXPIRED');
    assert.equal(entry.quarantineStatus, 'WITHHELD');
    assert.equal(entry.publisher, null); assert.equal(entry.canonicalUrl, null);
    assert.equal(entry.publishedAt, null); assert.equal(entry.retrievedAt, null);
    assert.equal((await queue.read({ view: 'WITHDRAWN' })).entries.length, 1);
    assert.equal((await repo.read()).managedSources.length, 1);
  });
});

test('a disputed source or later unresolved decision cannot silently retain metadata eligibility', async () => {
  for (const variant of ['verification', 'DISPUTED', 'UNKNOWN'] as const) await withRepository(async repo => {
    const value = article(`later-${variant.toLowerCase()}`);
    await seed(repo, [value]);
    await repo.transact(state => {
      if (variant === 'verification') state.sources[0].verification = 'DISPUTED';
      else state.provenanceDecisions.push({ ...resolution(value), id: `fictional-later-${variant}`, classification: variant, originId: null });
    });
    const entry = (await new SourceQueue(repo, { clock: () => at }).read()).entries[0];
    assert.equal(entry.sourceEligible, false); assert.equal(entry.canAdvance, false);
    assert.equal(entry.provenanceStatus, variant === 'UNKNOWN' ? 'UNRESOLVED' : 'DISPUTED');
    assert.equal(entry.blockedReason, variant === 'UNKNOWN' ? 'PROVENANCE_UNRESOLVED' : 'PROVENANCE_DISPUTED');
  });
});

test('registered revoked and superseded snapshots cannot expose retained attribution', async () => {
  for (const status of ['REVOKED', 'SUPERSEDED'] as const) await withRepository(async repo => {
    await seed(repo, [article(status.toLowerCase())]);
    await repo.transact(state => {
      const policy = state.managedSources[0].policy;
      policy.id = `fictional-${status.toLowerCase()}-v1`; policy.evidenceReference = `fictional-fixture-only:${policy.id}`; policy.reviewStatus = status;
      state.sources[0].rights = JSON.stringify(policy);
    });
    const entry = (await new SourceQueue(repo, { clock: () => at }).read()).entries[0];
    assert.equal(entry.rightsStatus, status); assert.equal(entry.blockedReason, `POLICY_${status}`);
    assert.equal(entry.quarantineStatus, 'WITHHELD');
    assert.equal(entry.publisher, null); assert.equal(entry.canonicalUrl, null); assert.equal(entry.relationship, null);
  });
});

test('rights expiry and a missing managed grant are blocked without upgrading from source rights text', async () => {
  await withRepository(async repo => {
    await seed(repo, [article('policy-expiry')]);
    const expired = await new SourceQueue(repo, { clock: () => '2027-01-01T00:00:00.000Z' }).read();
    assert.equal(expired.entries[0].rightsStatus, 'EXPIRED'); assert.equal(expired.entries[0].canonicalUrl, null);
    await repo.transact(state => { state.managedSources = []; });
    const missing = (await new SourceQueue(repo, { clock: () => at }).read()).entries[0];
    assert.equal(missing.rightsStatus, 'MISSING'); assert.equal(missing.blockedReason, 'MISSING_RIGHTS');
    assert.equal(missing.publisher, null); assert.equal(missing.sourceEligible, false);
  });
});

test('repository retention review holds block all metadata eligibility without rewriting state', async () => {
  await withRepository(async repo => {
    await seed(repo, [article('held')]);
    await repo.transact(state => { state.retentionReviewRequired = true; });
    const before = await readFile(repo.file, 'utf8');
    const page = await new SourceQueue(repo, { clock: () => at }).read();
    assert.equal(page.retentionReviewRequired, true); assert.equal(page.entries[0].sourceEligible, false);
    assert.equal(page.entries[0].quarantineStatus, 'NOT_QUARANTINED');
    assert.equal(page.entries[0].retentionStatus, 'REVIEW_REQUIRED'); assert.equal(page.entries[0].blockedReason, 'RETENTION_REVIEW_REQUIRED');
    assert.equal(page.entries[0].canAdvance, false);
    assert.equal(await readFile(repo.file, 'utf8'), before);
  });
});

test('retention review preserves known quarantine status and never advances a quarantined discovery', async () => {
  await withRepository(async repo => {
    await seed(repo, [article('held-quarantine', { provenance: { type: 'UNKNOWN', originId: null } })], false);
    await repo.transact(state => { state.retentionReviewRequired = true; });
    const entry = (await new SourceQueue(repo, { clock: () => at }).read()).entries[0];
    assert.equal(entry.quarantineStatus, 'QUARANTINED');
    assert.equal(entry.retentionStatus, 'REVIEW_REQUIRED');
    assert.equal(entry.blockedReason, 'RETENTION_REVIEW_REQUIRED');
    assert.equal(entry.sourceEligible, false); assert.equal(entry.canAdvance, false);
  });
});

test('malformed quarantine records withhold procedural status and metadata', async () => {
  await withRepository(async repo => {
    await seed(repo, [article('malformed-quarantine', { provenance: { type: 'UNKNOWN', originId: null } })], false);
    await repo.transact(state => { state.quarantine[0].metadata.publisher = 'Fictional mismatched attribution'; });
    const entry = (await new SourceQueue(repo, { clock: () => at }).read()).entries[0];
    assert.equal(entry.quarantineStatus, 'WITHHELD');
    assert.equal(entry.publisher, null); assert.equal(entry.canonicalUrl, null);
    assert.equal(entry.blockedReason, 'MALFORMED_RECORD');
    assert.equal(entry.sourceEligible, false); assert.equal(entry.canAdvance, false);
  });
});

test('cleanup and deletion/redaction are authoritative and expired markers cannot reconstruct candidates', async () => {
  await withRepository(async repo => {
    await seed(repo, [article('deleted')]);
    const queue = new SourceQueue(repo, { clock: () => '2026-06-02T12:00:00.000Z' });
    await cleanupRetention(repo, '2026-06-02T12:00:00.000Z', false);
    const page = await queue.read();
    assert.equal(page.entries.length, 1); assert.equal(page.entries[0].retentionStatus, 'DELETED');
    assert.equal(page.entries[0].canonicalUrl, null); assert.equal(page.entries[0].publisher, null);
    const expiredMarkers = await new SourceQueue(repo, { clock: () => '2026-06-03T12:00:00.000Z' }).read();
    assert.equal(expiredMarkers.entries.length, 0); assert.equal(expiredMarkers.retentionReviewRequired, true);
    await cleanupRetention(repo, '2026-06-03T12:00:00.000Z', false);
    assert.equal((await queue.read()).entries.length, 0);
    assert.doesNotMatch(JSON.stringify(page), /queue\.example\.test|Fictional deleted/);
  });
});

test('bounded deterministic pagination has stable ties, no repetition, and scoped cursors', async () => {
  await withRepository(async repo => {
    await seed(repo, Array.from({ length: 23 }, (_, i) => article(`page-${i}`)));
    const queue = new SourceQueue(repo, { clock: () => at });
    const before = await readFile(repo.file, 'utf8');
    const refs: string[] = []; let cursor: string | undefined;
    do {
      const page = await queue.read({ limit: 7, ...(cursor ? { cursor } : {}) });
      assert.ok(page.entries.length <= 7); assert.ok(!page.nextCursor || page.nextCursor.length <= 1024);
      refs.push(...page.entries.map(row => row.candidateRef)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(refs.length, 23); assert.equal(new Set(refs).size, 23); assert.deepEqual(refs, [...refs].sort());
    const first = await queue.read({ limit: 7 });
    assert.deepEqual(await queue.read({ limit: 7 }), first);
    await assert.rejects(queue.read({ view: 'ELIGIBLE', limit: 7, cursor: first.nextCursor! }), code('STALE_CURSOR'));
    await assert.rejects(queue.read({ limit: 8, cursor: first.nextCursor! }), code('STALE_CURSOR'));
    assert.equal(await readFile(repo.file, 'utf8'), before);
  });
});

test('relevant mutations and current-time expiry reject stale pages while private audit changes do not', async () => {
  await withRepository(async repo => {
    await seed(repo, [article('stale-one'), article('stale-two')]);
    let clock = at; const queue = new SourceQueue(repo, { clock: () => clock });
    const first = await queue.read({ limit: 1 });
    await repo.transact(state => { state.audit[0].actor = 'changed-private-actor'; });
    assert.equal((await queue.read({ limit: 1, cursor: first.nextCursor! })).entries.length, 1);
    clock = '2026-06-02T12:00:00.000Z';
    await assert.rejects(queue.read({ limit: 1, cursor: first.nextCursor! }), code('STALE_CURSOR'));
    clock = at;
    await seed(repo, [article('stale-three')]);
    await assert.rejects(queue.read({ limit: 1, cursor: first.nextCursor! }), code('STALE_CURSOR'));
  });
});

test('concurrent fresh reads and atomic repository mutations never create partial candidates or lost updates', async () => {
  await withRepository(async repo => {
    await seed(repo, [article('concurrent-zero')]);
    const queue = new SourceQueue(new JsonRepository(repo.file), { clock: () => at });
    const jobs = Array.from({ length: 10 }, (_, i) => seed(new JsonRepository(repo.file), [article(`concurrent-${i + 1}`)]));
    const reads = Array.from({ length: 20 }, () => queue.read());
    const snapshots = await Promise.all(reads);
    await Promise.all(jobs);
    for (const page of snapshots) {
      assert.ok(page.entries.length >= 1 && page.entries.length <= 11);
      assert.ok(page.entries.every(row => row.sourceEligible && row.publisher && row.canonicalUrl && row.canAdvance === false));
      assert.equal(new Set(page.entries.map(row => row.candidateRef)).size, page.entries.length);
    }
    assert.equal((await queue.read()).entries.length, 11);
    const before = await readFile(repo.file, 'utf8');
    await Promise.all(Array.from({ length: 20 }, () => queue.read()));
    assert.equal(await readFile(repo.file, 'utf8'), before);
    await cleanupRetention(repo, '2026-06-02T12:00:00.000Z', false);
    const removed = await new SourceQueue(new JsonRepository(repo.file), { clock: () => '2026-06-02T12:00:00.000Z' }).read();
    assert.ok(removed.entries.every(row => row.retentionStatus === 'DELETED' && row.canonicalUrl === null));
  });
});

test('malformed queries, malformed cursors, unsupported views and invalid clocks have fixed safe errors', async () => {
  await withRepository(async repo => {
    const queue = new SourceQueue(repo, { clock: () => at });
    for (const input of [null, [], { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: NaN }, { view: 'PRIVATE' }, { cursor: '' },
      { cursor: 'a'.repeat(1025) }, { cursor: '../secret' }, { provider: 'gnews' }, { clock: at }, { view: undefined }]) {
      await assert.rejects(queue.read(input as SourceQueueQuery), code('INVALID_QUERY'));
    }
    for (const body of ['{}', 'null', '{"fingerprint":"private-secret","offset":1}', '{"fingerprint":"' + 'a'.repeat(64) + '","offset":0}']) {
      await assert.rejects(queue.read({ cursor: Buffer.from(body).toString('base64url') }), code('INVALID_QUERY'));
    }
    await assert.rejects(new SourceQueue(repo, { clock: () => '2026-02-30T00:00:00Z' }).read(), code('UNAVAILABLE'));
  });
});

test('missing repository stays absent and malformed storage never exposes its raw errors or content', async () => {
  await withRepository(async repo => {
    const page = await new SourceQueue(repo, { clock: () => at }).read();
    assert.deepEqual(page.entries, []); assert.equal(page.nextCursor, null);
    await assert.rejects(access(repo.file));
    await writeFile(repo.file, '{"private-provider-body":"DO NOT DISCLOSE"}');
    await assert.rejects(new SourceQueue(repo, { clock: () => at }).read(), code('UNAVAILABLE'));
  });
});

test('oversized repository scans return unavailable instead of partial queue data', async () => {
  const state = emptyState();
  state.sources = Array.from({ length: 10001 }, (_, i) => ({ id: `fictional-oversized-${i}` } as State['sources'][number]));
  class SnapshotRepository extends JsonRepository { override async read() { return state; } }
  await assert.rejects(new SourceQueue(new SnapshotRepository('/unused'), { clock: () => at }).read(), code('UNAVAILABLE'));
});

test('repository accessors are rejected without evaluating private-field getters', async () => {
  let getterCalls = 0;
  const state = emptyState();
  const source = { id: 'fictional-accessor' };
  Object.defineProperty(source, 'privateLicensedBody', { enumerable: true, get() { getterCalls++; throw Error('PRIVATE BODY'); } });
  state.sources = [source as State['sources'][number]];
  class SnapshotRepository extends JsonRepository { override async read() { return state; } }
  await assert.rejects(new SourceQueue(new SnapshotRepository('/unused'), { clock: () => at }).read(), code('UNAVAILABLE'));
  assert.equal(getterCalls, 0);
});
