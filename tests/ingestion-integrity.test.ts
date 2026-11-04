import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { articles, context, fixtureAt, resolutions } from '../fixtures/fictional-news.ts';
import { ingestArticles, resolveQuarantined, sourceId, type IngestionContext } from '../src/ingestion/ingest.ts';
import { getPolicy } from '../src/ingestion/policies.ts';
import type { ResolutionInput } from '../src/ingestion/records.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import { emptyState, type Source, type State, type Story } from '../src/newsroom/model.ts';
import { Newsroom } from '../src/newsroom/service.ts';
import { JsonRepository } from '../src/newsroom/store.ts';

const clock = () => fixtureAt;
const write = { dryRun: false, clock, resolutions };
const counts = { processed: 0, duplicate: 0, rejected: 0, quarantined: 0, failed: 0 };
const later = '2026-06-01T13:00:00.000Z';
const expired = '2026-06-02T12:00:00.000Z';

async function withRepository(run: (repository: JsonRepository) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-integrity-'));
  try { await run(new JsonRepository(join(directory, 'fictional.json'))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function decision(article: ProviderArticle, patch: Partial<ResolutionInput> = {}): ResolutionInput {
  return { ...resolutions[0], sourceId: sourceId(article.url), ...patch };
}
function story(sourceIds: string[], status: Story['status'] = 'INGESTED'): Story {
  return { id: 'fictional-story', headline: 'Fictional reporting exercise', topic: 'fiction', summary: 'Invented test story', geography: 'Fictional location',
    firstSeenAt: fixtureAt, updatedAt: fixtureAt, eventAt: null, clusterId: 'fictional-cluster', sourceIds, status, version: 1,
    evidence: [{ id: 'fictional-evidence', claim: 'Fictional verified claim', support: sourceIds, contradict: [], verification: 'VERIFIED', uncertainty: '', reviewerDecisions: ['fictional-reviewer'] }] };
}
function seedApproved(state: State, sourceIds: string[]): void {
  state.revisions.push(story(sourceIds, 'APPROVED'));
  state.approvals.push({ storyId: 'fictional-story', version: 1, reviewer: 'fictional-reviewer', at: fixtureAt });
}
function legacySource(id: string, url: string): Omit<Source, 'canonicalUrl'> {
  return { id, url, publisher: 'Fictional legacy fixture', publishedAt: articles[0].publishedAt, retrievedAt: fixtureAt,
    type: 'ORIGINAL', originId: id, rights: 'fictional test fixture only', verification: 'VERIFIED' };
}

test('ingestion rejects caller policies and fabricated registry identities before writing', async () => {
  await withRepository(async repository => {
    const forged = [
      { ...context, publicRedistribution: true },
      { ...context, policy: { ...getPolicy(context.providerId, context.policyId, fixtureAt), publicRedistribution: true } },
      { ...context, policyId: 'caller-approved-fictional-policy' },
      { ...context, providerId: 'caller-approved-provider' },
      { ...context, providerId: 'gnews' },
    ];
    for (const candidate of forged) await assert.rejects(ingestArticles(repository, [articles[0]], candidate as IngestionContext, write), /policy|provider/i);
    assert.deepEqual(await repository.read(), emptyState());
  });
});

test('provider identity in an article cannot borrow another registered context', async () => {
  await withRepository(async repository => {
    assert.deepEqual(await ingestArticles(repository, [{ ...articles[0], providerId: 'gnews' }], context, write), { ...counts, rejected: 1 });
    const state = await repository.read();
    assert.equal(state.sources.length + state.quarantine.length + state.managedSources.length, 0);
    assert.equal(state.audit.length, 1);
    assert.equal(state.audit[0].action, 'INGESTION_REJECTED');
  });
});

test('mutating a returned registry policy cannot grant stored rights', async () => {
  await withRepository(async repository => {
    const returned = getPolicy(context.providerId, context.policyId, fixtureAt);
    returned.publicRedistribution = true;
    returned.licensedFullText = true;
    returned.retentionDays = 365;
    assert.deepEqual(await ingestArticles(repository, [articles[0]], context, write), { ...counts, processed: 1 });
    const state = await repository.read();
    assert.equal(state.managedSources[0].policy.publicRedistribution, false);
    assert.equal(state.managedSources[0].policy.licensedFullText, false);
    assert.equal(state.managedSources[0].policy.retentionDays, 1);
    assert.equal(JSON.parse(state.sources[0].rights).publicRedistribution, false);
  });
});

test('a newer registry version cannot silently upgrade previously retained permissions', async () => {
  await withRepository(async repository => {
    await ingestArticles(repository, [articles[0]], context, write);
    const before = (await repository.read()).managedSources[0];
    assert.equal(getPolicy(context.providerId, 'fictional-metadata-v2', fixtureAt).publicRedistribution, true);
    assert.deepEqual(await ingestArticles(repository, [articles[0]], { ...context, policyId: 'fictional-metadata-v2' }, write), { ...counts, duplicate: 1 });
    const state = await repository.read();
    assert.deepEqual(state.managedSources[0], before);
    assert.equal(JSON.parse(state.sources[0].rights).version, 1);
    assert.equal(JSON.parse(state.sources[0].rights).publicRedistribution, false);
  });
});

test('duplicate quarantine ingestion cannot upgrade rights, metadata or the retention deadline', async () => {
  await withRepository(async repository => {
    await ingestArticles(repository, [articles[2]], context, { dryRun: false, clock });
    const before = (await repository.read()).quarantine[0];
    const replay = { ...articles[2], publisher: 'Fictional replacement publisher', retrievedAt: later };
    assert.deepEqual(await ingestArticles(repository, [replay], { ...context, policyId: 'fictional-metadata-v2' }, { dryRun: false, clock: () => later }), { ...counts, duplicate: 1 });
    assert.deepEqual((await repository.read()).quarantine, [before]);
  });
});

test('delayed ingestion retains the original retrieval-based deadline instead of extending it', async () => {
  await withRepository(async repository => {
    const input = { ...articles[0], retrievedAt: '2026-06-01T06:00:00.000Z' };
    await ingestArticles(repository, [input], context, write);
    const state = await repository.read();
    assert.equal(state.managedSources[0].retainedAt, fixtureAt);
    assert.equal(state.managedSources[0].deleteAt, '2026-06-02T06:00:00.000Z');
    assert.equal(await new Newsroom(repository, { clock: () => '2026-06-02T06:00:00.000Z' }).independentCount([sourceId(input.url)]), 0);
  });
});

test('future retrieval timestamps and credential-bearing URLs reject without leaking metadata', async () => {
  await withRepository(async repository => {
    const inputs = [
      { ...articles[0], retrievedAt: later },
      { ...articles[0], url: 'https://fiction.example.test/secret?api_key=fictional-sensitive-value' },
      { ...articles[0], url: 'https://fictional-user:fictional-password@fiction.example.test/private' },
      { ...articles[0], url: 'https://real-provider.example.org/article' },
    ];
    assert.deepEqual(await ingestArticles(repository, inputs, context, write), { ...counts, rejected: inputs.length });
    const state = await repository.read();
    assert.equal(state.sources.length + state.managedSources.length + state.quarantine.length + state.provenanceDecisions.length, 0);
    assert.doesNotMatch(JSON.stringify(state), /fictional-sensitive-value|fictional-password|real-provider|Fictional Gazette/);
    assert.equal(state.audit.length, inputs.length);
  });
});

test('retained source metadata preserves provider attribution and discards unlicensed extra fields', async () => {
  await withRepository(async repository => {
    const input = { ...articles[0], title: 'UNLICENSED TITLE', description: 'UNLICENSED DESCRIPTION', content: 'UNLICENSED FULL TEXT', image: 'https://fiction.example.test/private-image' };
    await ingestArticles(repository, [input], context, write);
    const state = await repository.read();
    const retained = state.managedSources[0];
    assert.deepEqual(retained.providerMetadata, { url: input.url, publisher: input.publisher, publishedAt: input.publishedAt, retrievedAt: input.retrievedAt });
    assert.equal(retained.providerId, input.providerId);
    assert.deepEqual(retained.providerProvenance, input.provenance);
    assert.equal(state.sources[0].publisher, input.publisher);
    assert.equal(state.sources[0].url, input.url);
    assert.equal(state.sources[0].publishedAt, input.publishedAt);
    assert.equal(state.sources[0].retrievedAt, input.retrievedAt);
    assert.doesNotMatch(JSON.stringify(state), /UNLICENSED|private-image/);
  });
});

test('provider ORIGINAL assertions remain quarantined without explicit decision evidence', async () => {
  await withRepository(async repository => {
    assert.deepEqual(await ingestArticles(repository, [articles[0]], context, { dryRun: false, clock }), { ...counts, quarantined: 1 });
    const state = await repository.read();
    assert.equal(state.sources.length, 0);
    assert.equal(state.provenanceDecisions.length, 0);
    assert.deepEqual(state.quarantine[0].providerProvenance, articles[0].provenance);
  });
});

test('UNKNOWN and DISPUTED reports are retained only in authorized quarantine', async () => {
  await withRepository(async repository => {
    const disputed: ProviderArticle = { ...articles[2], url: 'https://fiction.example.test/disputed', provenance: { type: 'DISPUTED', originId: null } };
    assert.deepEqual(await ingestArticles(repository, [articles[2], disputed], context, { dryRun: false, clock }), { ...counts, quarantined: 2 });
    const state = await repository.read();
    assert.deepEqual(state.quarantine.map(row => row.providerProvenance.type), ['UNKNOWN', 'DISPUTED']);
    assert.equal(state.sources.length, 0);
    assert.equal(state.managedSources.length, 0);
    assert.equal(state.provenanceDecisions.length, 0);
  });
});

test('a policy forbidding quarantine discards unresolved provider metadata', async () => {
  await withRepository(async repository => {
    const disputed: ProviderArticle = { ...articles[2], url: 'https://fiction.example.test/discarded', provenance: { type: 'DISPUTED', originId: null } };
    assert.deepEqual(await ingestArticles(repository, [articles[2], disputed], { ...context, policyId: 'fictional-discard-v1' }, { dryRun: false, clock }), { ...counts, rejected: 2 });
    const state = await repository.read();
    assert.equal(state.sources.length + state.managedSources.length + state.quarantine.length + state.provenanceDecisions.length, 0);
    assert.equal(state.audit.length, 2);
    assert.doesNotMatch(JSON.stringify(state), /Fictional Wire|fiction\.example\.test/);
  });
});

test('explicit provenance resolution records evidence and preserves the original retention deadline', async () => {
  await withRepository(async repository => {
    const input = articles[2];
    await ingestArticles(repository, [input], context, { dryRun: false, clock });
    const before = (await repository.read()).quarantine[0];
    const resolution = decision(input, { at: later, reason: 'Fictional independently reviewed provenance' });
    assert.equal(await resolveQuarantined(repository, resolution, later), 'resolved');
    const state = await repository.read();
    assert.equal(state.quarantine.length, 0);
    assert.equal(state.sources.length, 1);
    assert.equal(state.managedSources[0].retainedAt, before.retainedAt);
    assert.equal(state.managedSources[0].deleteAt, before.deleteAt);
    assert.deepEqual(state.managedSources[0].policy, before.policy);
    assert.deepEqual(state.managedSources[0].providerProvenance, { type: 'UNKNOWN', originId: null });
    assert.deepEqual(state.managedSources[0].providerMetadata, before.providerMetadata);
    const { id: _, ...recorded } = state.provenanceDecisions[0];
    assert.deepEqual(recorded, resolution);
    assert.equal(state.audit.filter(row => row.action === 'PROVENANCE_RESOLVED' && row.subjectId === resolution.sourceId).length, 1);
  });
});

test('contradictory, anonymous, missing-evidence and future ingestion decisions reject without partial source data', async () => {
  await withRepository(async repository => {
    const patches: Partial<ResolutionInput>[] = [
      { classification: 'PRIMARY' }, { actorAssertion: '' }, { evidenceReferences: [] },
      { evidenceReferences: [' '] }, { reason: '' }, { at: later },
    ];
    for (const [index, patch] of patches.entries()) {
      const input = { ...articles[0], url: `https://fiction.example.test/invalid-decision-${index}` };
      assert.deepEqual(await ingestArticles(repository, [input], context, { ...write, resolutions: [decision(input, patch)] }), { ...counts, rejected: 1 });
    }
    const state = await repository.read();
    assert.equal(state.sources.length + state.managedSources.length + state.quarantine.length + state.provenanceDecisions.length, 0);
    assert.equal(state.audit.length, patches.length);
    assert.ok(state.audit.every(row => row.action === 'INGESTION_REJECTED'));
  });
});

test('rejected quarantine decisions leave metadata quarantined and record no partial decision', async () => {
  await withRepository(async repository => {
    await ingestArticles(repository, [articles[0]], context, { dryRun: false, clock });
    const before = (await repository.read()).quarantine[0];
    for (const patch of [{ evidenceReferences: [] }, { actorAssertion: ' ' }, { classification: 'PRIMARY' as const }]) {
      assert.equal(await resolveQuarantined(repository, decision(articles[0], patch), fixtureAt), 'rejected');
    }
    const state = await repository.read();
    assert.deepEqual(state.quarantine, [before]);
    assert.equal(state.sources.length + state.managedSources.length + state.provenanceDecisions.length, 0);
    assert.equal(state.audit.filter(row => row.action === 'PROVENANCE_REJECTED').length, 3);
  });
});

test('an evidence-backed unresolved decision cannot turn UNKNOWN into a countable source', async () => {
  await withRepository(async repository => {
    await ingestArticles(repository, [articles[2]], context, { dryRun: false, clock });
    const before = (await repository.read()).quarantine[0];
    assert.equal(await resolveQuarantined(repository, decision(articles[2], { classification: 'UNKNOWN', at: later }), later), 'unresolved');
    const state = await repository.read();
    assert.deepEqual(state.quarantine, [before]);
    assert.equal(state.sources.length + state.managedSources.length, 0);
    assert.equal(state.provenanceDecisions[0].classification, 'UNKNOWN');
  });
});

test('expired quarantine metadata cannot be promoted or have its deadline extended', async () => {
  await withRepository(async repository => {
    await ingestArticles(repository, [articles[2]], context, { dryRun: false, clock });
    const before = (await repository.read()).quarantine[0];
    assert.equal(await resolveQuarantined(repository, decision(articles[2], { at: expired }), expired), 'rejected');
    const state = await repository.read();
    assert.deepEqual(state.quarantine, [before]);
    assert.equal(state.sources.length + state.managedSources.length + state.provenanceDecisions.length, 0);
  });
});

test('an inflated stored deadline cannot promote quarantine after the original retention deadline', async () => {
  await withRepository(async repository => {
    await ingestArticles(repository, [articles[2]], context, { dryRun: false, clock });
    await repository.transact(state => { state.quarantine[0].deleteAt = '2026-06-03T12:00:00.000Z'; });
    const before = (await repository.read()).quarantine[0];
    assert.equal(await resolveQuarantined(repository, decision(articles[2], { at: expired }), expired), 'rejected');
    const state = await repository.read();
    assert.deepEqual(state.quarantine, [before]);
    assert.equal(state.sources.length + state.managedSources.length + state.provenanceDecisions.length, 0);
    assert.equal(state.audit.at(-1)?.action, 'PROVENANCE_REJECTED');
  });
});

test('legacy fixture ingestion cannot bypass quarantine by assigning an arbitrary source identifier', async () => {
  await withRepository(async repository => {
    await ingestArticles(repository, [articles[2]], context, { dryRun: false, clock });
    const before = await repository.read();
    const newsroom = new Newsroom(repository, { clock });
    await assert.rejects(newsroom.ingest(legacySource('arbitrary-legacy-id', `${articles[2].url}?utm_source=legacy-alias`), 'fictional-reviewer'));
    assert.deepEqual(await repository.read(), before);
  });
});

test('legacy fixture ingestion cannot bypass managed duplicates or deletion markers using URL aliases', async () => {
  await withRepository(async repository => {
    await ingestArticles(repository, [articles[0]], context, write);
    const newsroom = new Newsroom(repository, { clock });
    const canonicalAlias = 'https://fiction.example.test/one/?utm_source=legacy-alias#fictional-section';
    const before = await repository.read();
    await assert.rejects(newsroom.ingest(legacySource('arbitrary-managed-alias', canonicalAlias), 'fictional-reviewer'));
    assert.deepEqual(await repository.read(), before);
    await repository.transact(state => {
      state.sources = []; state.managedSources = []; state.provenanceDecisions = [];
      state.deletions.push({ sourceId: sourceId(articles[0].url), at: later, reason: 'Fictional retention deletion' });
    });
    const deleted = await repository.read();
    await assert.rejects(newsroom.ingest(legacySource('arbitrary-deleted-alias', canonicalAlias), 'fictional-reviewer'));
    assert.deepEqual(await repository.read(), deleted);
  });
});

test('quarantined reports cannot be counted, associated with new stories or approved from seeded history', async () => {
  await withRepository(async repository => {
    await ingestArticles(repository, [articles[2]], context, { dryRun: false, clock });
    const newsroom = new Newsroom(repository, { clock });
    const id = sourceId(articles[2].url);
    await assert.rejects(newsroom.independentCount([id]), /Unknown source/);
    await assert.rejects(newsroom.create(story([id]), 'fictional-reviewer'), /Unknown story source/);
    await repository.transact(state => { state.revisions.push(story([id], 'NEEDS_REVIEW')); });
    await assert.rejects(newsroom.transition('fictional-story', 'APPROVED', 'fictional-reviewer'), /Ineligible source/);
    const state = await repository.read();
    assert.equal(state.approvals.length, 0);
    assert.equal(state.revisions.at(-1)?.status, 'NEEDS_REVIEW');
  });
});

test('syndication cannot claim quarantined metadata as a resolved original source', async () => {
  await withRepository(async repository => {
    await ingestArticles(repository, [articles[2]], context, { dryRun: false, clock });
    const originalId = sourceId(articles[2].url);
    const input: ProviderArticle = { ...articles[0], url: 'https://fiction.example.test/unsupported-syndication', provenance: { type: 'SYNDICATED', originId: originalId } };
    assert.deepEqual(await ingestArticles(repository, [input], context, { ...write, resolutions: [decision(input, { classification: 'SYNDICATED', originId: originalId })] }), { ...counts, rejected: 1 });
    const state = await repository.read();
    assert.equal(state.sources.length + state.managedSources.length + state.provenanceDecisions.length, 0);
    assert.equal(state.quarantine.length, 1);
  });
});

test('concurrent independent repository instances commit one source and one outcome for every attempt', async () => {
  await withRepository(async repository => {
    const attempts = 12;
    const results = await Promise.all(Array.from({ length: attempts }, () => ingestArticles(new JsonRepository(repository.file), [articles[0]], context, write)));
    assert.equal(results.filter(result => result.processed === 1).length, 1);
    assert.equal(results.filter(result => result.duplicate === 1).length, attempts - 1);
    for (const result of results) assert.equal(result.failed + result.rejected + result.quarantined, 0);
    const state = await repository.read();
    assert.equal(state.sources.length, 1);
    assert.equal(state.managedSources.length, 1);
    assert.equal(state.provenanceDecisions.length, 1);
    assert.equal(state.audit.filter(row => row.action === 'INGESTION_PROCESSED').length, 1);
    assert.equal(state.audit.filter(row => row.action === 'INGESTION_DUPLICATE').length, attempts - 1);
    assert.equal(state.audit.filter(row => row.action === 'PROVENANCE_RESOLVED').length, 1);
    assert.equal(state.audit.length, attempts + 1);
    assert.ok(state.audit.every(row => row.subjectId === sourceId(articles[0].url)));
  });
});

test('failed source commit leaves no partial source, provenance or audit and a retry commits once', async () => {
  await withRepository(async repository => {
    const failing = new JsonRepository(repository.file, { beforeCommit: () => { throw Error('fictional disk failure'); } });
    assert.deepEqual(await ingestArticles(failing, [articles[0]], context, write), { ...counts, failed: 1 });
    assert.deepEqual(await repository.read(), emptyState());
    assert.deepEqual(await ingestArticles(repository, [articles[0]], context, write), { ...counts, processed: 1 });
    assert.deepEqual(await ingestArticles(repository, [articles[0]], context, write), { ...counts, duplicate: 1 });
    const state = await repository.read();
    assert.equal(state.sources.length, 1);
    assert.equal(state.managedSources.length, 1);
    assert.equal(state.provenanceDecisions.length, 1);
    assert.equal(state.audit.filter(row => row.action === 'INGESTION_PROCESSED').length, 1);
    assert.equal(state.audit.some(row => row.action === 'INGESTION_FAILED'), false);
  });
});

test('failed quarantine commit leaves no retained metadata or success audit and can be retried', async () => {
  await withRepository(async repository => {
    const failing = new JsonRepository(repository.file, { beforeCommit: () => { throw Error('fictional disk failure'); } });
    assert.deepEqual(await ingestArticles(failing, [articles[2]], context, { dryRun: false, clock }), { ...counts, failed: 1 });
    assert.deepEqual(await repository.read(), emptyState());
    assert.deepEqual(await ingestArticles(repository, [articles[2]], context, { dryRun: false, clock }), { ...counts, quarantined: 1 });
    const state = await repository.read();
    assert.equal(state.quarantine.length, 1);
    assert.equal(state.audit.filter(row => row.action === 'INGESTION_QUARANTINED').length, 1);
    assert.equal(state.audit.filter(row => row.action === 'PROVENANCE_UNRESOLVED').length, 1);
  });
});

test('managed sources stop counting and cannot receive approval at the exact retention deadline', async () => {
  await withRepository(async repository => {
    await ingestArticles(repository, [articles[0]], context, write);
    const id = sourceId(articles[0].url);
    await repository.transact(state => { state.revisions.push(story([id], 'NEEDS_REVIEW')); });
    const newsroom = new Newsroom(repository, { clock: () => expired });
    assert.equal(await newsroom.independentCount([id]), 0);
    await assert.rejects(newsroom.transition('fictional-story', 'APPROVED', 'fictional-reviewer'), /Ineligible source/);
    assert.equal((await repository.read()).approvals.length, 0);
  });
});

test('previous editorial approval cannot authorize publication after source retention expires', async () => {
  await withRepository(async repository => {
    await ingestArticles(repository, [articles[0]], context, write);
    await repository.transact(state => seedApproved(state, [sourceId(articles[0].url)]));
    await assert.rejects(new Newsroom(repository, { clock: () => expired }).transition('fictional-story', 'PUBLISHED', 'fictional-reviewer'), /Ineligible source/);
    const state = await repository.read();
    assert.equal(state.revisions.length, 1);
    assert.equal(state.revisions[0].status, 'APPROVED');
    assert.equal(state.audit.some(row => row.action === 'STATUS_PUBLISHED'), false);
  });
});

test('an invalid stored policy snapshot blocks independent counting and publication of approved history', async () => {
  await withRepository(async repository => {
    await ingestArticles(repository, [articles[0]], context, write);
    const id = sourceId(articles[0].url);
    await repository.transact(state => { state.managedSources[0].policy.publicRedistribution = true; seedApproved(state, [id]); });
    const newsroom = new Newsroom(repository, { clock });
    assert.equal(await newsroom.independentCount([id]), 0);
    await assert.rejects(newsroom.transition('fictional-story', 'PUBLISHED', 'fictional-reviewer'), /Ineligible source/);
    assert.equal((await repository.read()).revisions.at(-1)?.status, 'APPROVED');
  });
});
