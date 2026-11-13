import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestArticles, sourceId } from '../src/ingestion/ingest.ts';
import { getPolicy } from '../src/ingestion/policies.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import { canonicalURL, type State } from '../src/newsroom/model.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { SourceQueue, SourceQueueError } from '../src/source-queue/service.ts';
import type { SourceQueueEntry, SourceQueueQuery } from '../src/source-queue/types.ts';

const at = '2026-06-01T12:00:00.000Z';
const expired = '2026-06-02T12:00:00.000Z';
const secret = 'FICTIONAL_PRIVATE_SENTINEL_7e42';
const context = { providerId: 'fictional-fixture', policyId: 'fictional-metadata-v1' };

async function withRepository(run: (repository: JsonRepository, queue: SourceQueue) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-queue-security-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    await seed(repository);
    await run(repository, new SourceQueue(repository, { clock: () => at }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function seed(repository: JsonRepository, name = 'original'): Promise<void> {
  const article: ProviderArticle = { providerId: context.providerId, url: `https://queue-security.example.test/${name}`,
    publisher: 'Fictional Security Gazette', publishedAt: '2026-06-01T11:00:00.000Z', retrievedAt: at,
    provenance: { type: 'ORIGINAL', originId: null } };
  const result = await ingestArticles(repository, [article], context, { dryRun: false, clock: () => at, resolutions: [{
    sourceId: sourceId(article.url), classification: 'ORIGINAL', originId: null, actorAssertion: 'fictional-independent-reviewer',
    at, evidenceReferences: ['fictional-evidence:independent-source'], reason: 'Invented source for independent adversarial tests',
  }] });
  assert.equal(result.processed, 1);
}

function withheld(entry: SourceQueueEntry): void {
  assert.equal(entry.publisher, null);
  assert.equal(entry.canonicalUrl, null);
  assert.equal(entry.publishedAt, null);
  assert.equal(entry.retrievedAt, null);
  assert.equal(entry.relationship, null);
  assert.equal(entry.quarantineStatus, 'WITHHELD');
  assert.equal(entry.sourceEligible, false);
  assert.equal(entry.canAdvance, false);
  assert.notEqual(entry.blockedReason, null);
}

function queueError(code: SourceQueueError['code']): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof SourceQueueError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.doesNotMatch(JSON.stringify(error), /FICTIONAL_PRIVATE|fictional\.json|dayline-source-queue-security/);
    return true;
  };
}

test('source queue explicitly projects metadata while preserving private repository records', async () => withRepository(async (repository, queue) => {
  await repository.transact(state => {
    const record = state.managedSources[0];
    Object.assign(record, { rawProviderResponse: { content: secret }, apiKey: secret, privateNotes: secret });
    Object.assign(record.providerMetadata, { headline: secret, excerpt: secret, body: secret, image: secret, token: secret });
    Object.assign(record.policy, { privateContract: secret, licensedBody: secret });
    Object.assign(state.sources[0], { articleBody: secret, privateNotes: secret });
    state.provenanceDecisions[0].actorAssertion = secret;
    state.provenanceDecisions[0].evidenceReferences = [secret];
    state.provenanceDecisions[0].reason = secret;
    state.audit[0].actor = secret;
  });
  const before = await readFile(repository.file, 'utf8');
  const page = await queue.read();
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].sourceEligible, true);
  assert.equal(page.entries[0].publisher, 'Fictional Security Gazette');
  assert.equal(page.entries[0].canAdvance, false);
  assert.equal(page.entries[0].quarantineStatus, 'NOT_QUARANTINED');
  assert.deepEqual(Object.keys(page.entries[0]).sort(), ['candidateRef', 'publisher', 'canonicalUrl', 'publishedAt', 'retrievedAt',
    'provenance', 'provenanceStatus', 'rightsStatus', 'retentionStatus', 'quarantineStatus', 'relationship',
    'sourceEligible', 'canAdvance', 'blockedReason'].sort());
  assert.match(page.entries[0].candidateRef, /^candidate-[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(page), /FICTIONAL_PRIVATE|rawProviderResponse|apiKey|privateNotes|licensedBody|actorAssertion|evidenceReferences|articleBody|fictional-independent-reviewer|fictional-evidence/);
  assert.equal(await readFile(repository.file, 'utf8'), before);
  assert.match(before, /FICTIONAL_PRIVATE/);
}));

const malformed: Array<[string, (state: State) => void]> = [
  ['impossible publication date', state => { state.managedSources[0].providerMetadata.publishedAt = state.sources[0].publishedAt = '2026-02-30T12:00:00.000Z'; }],
  ['future retained timestamp', state => { state.managedSources[0].retainedAt = '2026-06-01T13:00:00.000Z'; }],
  ['retrieval later than retention', state => { state.managedSources[0].providerMetadata.retrievedAt = state.sources[0].retrievedAt = '2026-06-01T13:00:00.000Z'; }],
  ['invalid deletion deadline', state => { state.managedSources[0].deleteAt = 'invalid-date'; }],
  ['incorrect canonical URL', state => { state.sources[0].canonicalUrl = 'https://queue-security.example.test/unrelated'; }],
  ['publisher disagreement', state => { state.sources[0].publisher = 'Fictional Unrelated Publisher'; }],
  ['provider identity mismatch', state => { state.managedSources[0].providerId = 'gnews'; }],
  ['unregistered snapshot identity', state => { state.managedSources[0].policy.id = 'fictional-unregistered-grant'; }],
  ['upgraded captured permissions', state => { state.managedSources[0].policy.publicRedistribution = true; state.managedSources[0].policy.licensedFullText = true; }],
  ['source rights disagreement', state => { state.sources[0].rights = JSON.stringify(getPolicy(context.providerId, 'fictional-metadata-v2', at)); }],
  ['missing provenance decision', state => { state.provenanceDecisions = []; }],
  ['empty provenance evidence', state => { state.provenanceDecisions[0].evidenceReferences = []; }],
  ['future provenance decision', state => { state.provenanceDecisions[0].at = '2026-06-01T13:00:00.000Z'; }],
  ['contradictory provenance history', state => { state.provenanceDecisions.push({ ...state.provenanceDecisions[0], id: 'fictional-conflicting-decision', classification: 'SECONDARY' }); }],
  ['duplicate managed snapshot', state => { state.managedSources.push(structuredClone(state.managedSources[0])); }],
  ['duplicate newsroom source', state => { state.sources.push(structuredClone(state.sources[0])); }],
  ['source removed while managed metadata remains', state => { state.sources = []; }],
];
for (const [name, mutate] of malformed) {
  test(`shape-valid ${name} cannot disclose retained metadata or establish eligibility`, async () => withRepository(async (repository, queue) => {
    await repository.transact(mutate);
    const before = await readFile(repository.file, 'utf8');
    const page = await queue.read();
    assert.equal(page.entries.length, 1);
    withheld(page.entries[0]);
    assert.deepEqual((await queue.read({ view: 'ELIGIBLE' })).entries, []);
    assert.equal(await readFile(repository.file, 'utf8'), before);
  }));
}

test('one malformed candidate cannot contaminate an independent retained candidate', async () => withRepository(async (repository, queue) => {
  await seed(repository, 'independent');
  await repository.transact(state => { state.managedSources[0].providerMetadata.publisher = secret; });
  const page = await queue.read();
  assert.equal(page.entries.length, 2);
  assert.equal(page.entries.filter(entry => entry.sourceEligible).length, 1);
  assert.equal(page.entries.filter(entry => entry.publisher === 'Fictional Security Gazette').length, 1);
  assert.doesNotMatch(JSON.stringify(page), /FICTIONAL_PRIVATE/);
}));

for (const status of ['revoked', 'superseded'] as const) {
  test(`a registered ${status} grant cannot be upgraded by an approved stored review status`, async () => withRepository(async (repository, queue) => {
    await repository.transact(state => {
      const policy = state.managedSources[0].policy;
      policy.id = `fictional-${status}-v1`;
      policy.evidenceReference = `fictional-fixture-only:${policy.id}`;
      policy.reviewStatus = 'APPROVED';
      state.sources[0].rights = JSON.stringify(policy);
    });
    const entry = (await queue.read()).entries[0];
    withheld(entry);
    assert.equal(entry.rightsStatus, status.toUpperCase());
    assert.deepEqual((await queue.read({ view: 'ELIGIBLE' })).entries, []);
  }));
}

test('an inflated stored deletion deadline cannot extend the retrieval grant', async () => withRepository(async (repository) => {
  await repository.transact(state => { state.managedSources[0].deleteAt = '2026-12-30T12:00:00.000Z'; });
  const before = await repository.read();
  const page = await new SourceQueue(repository, { clock: () => expired }).read();
  assert.equal(page.entries.length, 1);
  withheld(page.entries[0]);
  assert.equal(page.entries[0].retentionStatus, 'EXPIRED');
  assert.deepEqual(await repository.read(), before);
}));

test('an authoritative deletion marker prevents retained metadata from being restored by a read', async () => withRepository(async (repository, queue) => {
  await repository.transact(state => { state.deletions.push({ sourceId: state.managedSources[0].sourceId, at,
    expiresAt: expired, reason: secret }); });
  const before = await repository.read();
  const page = await queue.read();
  assert.equal(page.entries.length, 1);
  withheld(page.entries[0]);
  assert.equal(page.entries[0].retentionStatus, 'DELETED');
  assert.doesNotMatch(JSON.stringify(page), /FICTIONAL_PRIVATE|Fictional Security Gazette|queue-security\.example/);
  assert.deepEqual(await repository.read(), before);
}));

test('retention review holds stay effective without deleting retained metadata or making approvals', async () => withRepository(async (repository, queue) => {
  await repository.transact(state => { state.retentionReviewRequired = true; });
  const before = await repository.read();
  const page = await queue.read();
  assert.equal(page.retentionReviewRequired, true);
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].sourceEligible, false);
  assert.equal(page.entries[0].canAdvance, false);
  assert.equal(page.entries[0].quarantineStatus, 'NOT_QUARANTINED');
  assert.equal(page.entries[0].blockedReason, 'RETENTION_REVIEW_REQUIRED');
  assert.deepEqual((await queue.read({ view: 'ELIGIBLE' })).entries, []);
  assert.deepEqual(await repository.read(), before);
  assert.equal(before.approvals.length + before.revisions.length + before.editions.length, 0);
}));

test('active rights and an original-origin assertion cannot turn procedural quarantine into eligibility', async () => withRepository(async (repository, queue) => {
  const article: ProviderArticle = { providerId: context.providerId, url: 'https://queue-security.example.test/quarantined-original',
    publisher: 'Fictional Quarantined Desk', publishedAt: '2026-06-01T11:00:00.000Z', retrievedAt: at,
    provenance: { type: 'ORIGINAL', originId: null } };
  const outcome = await ingestArticles(repository, [article], context, { dryRun: false, clock: () => at });
  assert.equal(outcome.quarantined, 1);
  const before = await readFile(repository.file, 'utf8');
  const entry = (await queue.read()).entries.find(candidate => candidate.publisher === article.publisher);
  assert.ok(entry);
  assert.equal(entry.quarantineStatus, 'QUARANTINED');
  assert.equal(entry.rightsStatus, 'ACTIVE');
  assert.equal(entry.retentionStatus, 'RETAINED');
  assert.equal(entry.provenance, 'ORIGINAL');
  assert.equal(entry.provenanceStatus, 'UNRESOLVED');
  assert.equal(entry.sourceEligible, false);
  assert.equal(entry.canAdvance, false);
  assert.equal(entry.blockedReason, 'PROVENANCE_UNRESOLVED');
  const eligible = await queue.read({ view: 'ELIGIBLE' });
  assert.ok(eligible.entries.every(candidate => candidate.quarantineStatus === 'NOT_QUARANTINED'));
  assert.ok(eligible.entries.every(candidate => candidate.candidateRef !== entry.candidateRef));
  assert.equal(await readFile(repository.file, 'utf8'), before);
  const state = await repository.read();
  assert.equal(state.approvals.length + state.revisions.length + state.editions.length, 0);
}));

const sensitiveURLs = [
  `https://fictional-user:${secret}@queue-security.example.test/credentials`,
  `https://queue-security.example.test/query?api_key=${secret}`,
  `https://queue-security.example.test/query?authorization=${secret}`,
  `https://queue-security.example.test/query?client_secret=${secret}`,
  `https://queue-security.example.test/query?x-api-key=${secret}`,
  `javascript:${secret}`,
  `http://127.0.0.1/${secret}`,
  `https://real-provider.example.org/${secret}`,
];
for (const [index, url] of sensitiveURLs.entries()) {
  test(`unsafe or credential-bearing persisted URL ${index + 1} cannot reach queue output`, async () => withRepository(async (repository, queue) => {
    await repository.transact(state => {
      const previous = state.managedSources[0].sourceId;
      let id = previous;
      let canonical = url;
      try { id = sourceId(url); canonical = canonicalURL(url); } catch { /* Exercise malformed persisted data as well as accepted URL syntax. */ }
      state.managedSources[0].sourceId = id;
      state.managedSources[0].providerMetadata.url = url;
      state.sources[0].id = state.sources[0].originId = id;
      state.sources[0].url = url;
      state.sources[0].canonicalUrl = canonical;
      state.provenanceDecisions[0].sourceId = id;
    });
    const page = await queue.read();
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].sourceEligible, false);
    assert.equal(page.entries[0].canonicalUrl, null);
    assert.equal(page.entries[0].canAdvance, false);
    assert.doesNotMatch(JSON.stringify(page), /FICTIONAL_PRIVATE|fictional-user|real-provider|127\.0\.0\.1/);
  }));
}

test('canonical attribution discards tracking values and fragments without copying the original URL', async () => withRepository(async (repository, queue) => {
  await repository.transact(state => {
    const url = `https://queue-security.example.test/original?utm_source=${secret}#${secret}`;
    state.managedSources[0].providerMetadata.url = state.sources[0].url = url;
  });
  const before = await readFile(repository.file, 'utf8');
  const page = await queue.read();
  assert.equal(page.entries[0].sourceEligible, true);
  assert.equal(page.entries[0].canonicalUrl, 'https://queue-security.example.test/original');
  assert.doesNotMatch(JSON.stringify(page), /FICTIONAL_PRIVATE|utm_source|#/);
  assert.equal(await readFile(repository.file, 'utf8'), before);
}));

test('query accessors and prototype-injected fields reject without executing caller code', async () => withRepository(async (_repository, queue) => {
  let invoked = 0;
  const accessor = (field: string) => Object.defineProperty({}, field, { enumerable: true, get() { invoked++; throw Error(secret); } });
  const queries: unknown[] = [accessor('view'), accessor('limit'), accessor('cursor'), accessor('credential'),
    Object.create({ view: 'ELIGIBLE' }), JSON.parse('{"__proto__":{"view":"ELIGIBLE"}}'),
    { constructor: { prototype: { view: 'ELIGIBLE' } } }, { limit: { valueOf() { invoked++; throw Error(secret); } } },
    Object.defineProperty({}, 'view', { enumerable: false, value: 'RECENT' }), { [Symbol('private')]: secret }];
  for (const query of queries) await assert.rejects(queue.read(query as SourceQueueQuery), queueError('INVALID_QUERY'));
  assert.equal(invoked, 0);
  assert.equal((await queue.read()).entries[0].sourceEligible, true);
}));

test('unreadable or structurally malformed stores return fixed unavailable errors without reflecting private bytes', async () => withRepository(async (repository, queue) => {
  const original = await readFile(repository.file, 'utf8');
  const invalid = [secret, JSON.stringify({ schema: 7, managedSources: secret }),
    JSON.stringify({ ...JSON.parse(original), managedSources: [{ secret }] })];
  for (const raw of invalid) {
    await writeFile(repository.file, raw);
    await assert.rejects(queue.read(), queueError('UNAVAILABLE'));
    assert.equal(await readFile(repository.file, 'utf8'), raw);
  }
  await writeFile(repository.file, original);
  assert.equal((await queue.read()).entries[0].sourceEligible, true);
}));

test('queue reads neither call a provider nor manufacture repository state or authority', async () => withRepository(async (repository, queue) => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error('Fictional network access forbidden'); };
  try {
    const before = await readFile(repository.file, 'utf8');
    for (const view of ['RECENT', 'UNRESOLVED', 'RELATED', 'ELIGIBLE', 'BLOCKED', 'WITHDRAWN'] as const) {
      const page = await queue.read({ view });
      assert.ok(page.entries.every(entry => entry.canAdvance === false));
    }
    assert.equal(calls, 0);
    assert.equal(await readFile(repository.file, 'utf8'), before);
  } finally { globalThis.fetch = previous; }
}));
