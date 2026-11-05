import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/newsroom/store.ts';
import { emptyState, type State, type Source } from '../src/newsroom/model.ts';
import { getPolicy, policyStatus } from '../src/ingestion/policies.ts';
import type { ActiveDraft, DraftReview } from '../src/editorial/types.ts';

const at = '2026-01-02T00:00:00.000Z';
const source = (id: string): Source => ({ id, publisher: 'Fictional publisher', url: `https://example.test/${id}`, canonicalUrl: `https://example.test/${id}`, type: 'ORIGINAL', publishedAt: at, retrievedAt: at, originId: id, rights: 'Legacy fixture assertion; not a license', verification: 'VERIFIED' });
function legacyFixture() {
  return {
    schema: 1,
    sources: [{ ...source('legacy'), originalExtra: { note: 'Preserve historical fields exactly' } }],
    revisions: [{ id: 'story', headline: 'Fictional legacy story', topic: 'fiction', summary: 'Historical summary', geography: 'Imaginary Town', eventAt: null, firstSeenAt: at, updatedAt: at, clusterId: 'legacy-cluster', evidence: [{ id: 'claim', claim: 'Fictional claim', support: ['legacy'], contradict: [], verification: 'VERIFIED', uncertainty: 'Fixture only', reviewerDecisions: ['legacy-reviewer'] }], sourceIds: ['legacy'], status: 'APPROVED', version: 1 }],
    approvals: [{ storyId: 'story', version: 1, reviewer: 'legacy-reviewer', at }],
    audit: [{ id: 'legacy-audit', storyId: 'story', action: 'STATUS_APPROVED', actor: 'legacy-reviewer', at, version: 1 }]
  };
}
function schema2Fixture() {
  const { auditRetentionDays: _notPreviouslyCaptured, ...legacyPolicy } = getPolicy('fictional-fixture', 'fictional-metadata-v1', at);
  const captured = {
    sourceId: 'legacy', providerId: 'fictional-fixture', policy: legacyPolicy,
    retainedAt: at, deleteAt: '2026-01-03T00:00:00.000Z',
    providerMetadata: { url: 'https://example.test/legacy', publisher: 'Fictional publisher', publishedAt: at, retrievedAt: at },
    providerProvenance: { type: 'UNKNOWN', originId: null }
  };
  return {
    ...legacyFixture(), schema: 2,
    managedSources: [captured],
    quarantine: [{ ...captured, sourceId: 'quarantined', metadata: { ...captured.providerMetadata, url: 'https://example.test/quarantined' } }],
    provenanceDecisions: [{ id: 'legacy-decision', sourceId: 'legacy', classification: 'UNKNOWN', originId: null, actorAssertion: 'legacy-reviewer', at, evidenceReferences: ['fictional-evidence'], reason: 'Fixture uncertainty' }],
    deletions: [{ sourceId: 'previously-deleted', at, reason: 'Legacy deletion without an expiry' }]
  };
}
function activeDraftFixture(): ActiveDraft {
  return {
    id: 'draft', storyId: 'story', storyVersion: 1, version: 1, status: 'GENERATED',
    generatedAt: at, expiresAt: '2026-01-03T00:00:00.000Z', providerId: 'fictional-provider', modelVersion: 'fictional-model-v1', promptTemplateVersion: 'dayline-editorial-v1',
    sourceIds: ['legacy'], policies: [{ sourceId: 'legacy', providerId: 'fictional-fixture', policyId: 'fictional-policy', policyVersion: 1, snapshotDigest: 'fictional-digest' }],
    output: { headline: 'Fictional draft headline', summary: 'Fictional draft summary', sections: [{ kind: 'FACT', text: 'Fictional claim', evidenceIds: ['claim'] }], claims: [{ evidenceId: 'claim', text: 'Fictional claim', supportingSourceIds: ['legacy'], contradictingSourceIds: [] }], uncertainties: ['Fixture only'] },
    suggestions: [{ code: 'MISSING_UNCERTAINTY', message: 'Fictional advisory suggestion' }], usage: { inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 }
  };
}
function draftReviewFixture(): DraftReview {
  return { draftId: 'draft', fromVersion: 1, toVersion: 2, storyVersion: 1, fromState: 'GENERATED', toState: 'NEEDS_REVIEW', actorAssertion: 'fictional-reviewer', unauthenticated: true, at };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dayline-repository-'));
  const file = join(dir, 'repository.json');
  return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
function appendSourceAndAudit(state: State): string {
  state.sources.push(source('new-source'));
  state.audit.push({ id: 'new-audit', storyId: null, action: 'SOURCE_INGESTED', actor: 'fixture', at, version: null, subjectId: 'new-source' });
  return 'new-source';
}

test('legacy reads preserve historical snapshots without rewriting or granting new authority', async () => {
  const f = await fixture();
  try {
    const legacy = legacyFixture();
    const bytes = JSON.stringify(legacy, null, 2) + '\n';
    await writeFile(f.file, bytes);
    const repo = new JsonRepository(f.file);
    const migrated = await repo.read();
    assert.equal(migrated.schema, 5);
    assert.equal(migrated.retentionReviewRequired, true);
    for (const key of ['sources', 'revisions', 'approvals', 'audit'] as const) assert.deepEqual(migrated[key], legacy[key]);
    for (const key of ['managedSources', 'quarantine', 'provenanceDecisions', 'deletions', 'drafts', 'draftReviews', 'editions', 'editionReviews'] as const) assert.deepEqual(migrated[key], []);
    assert.equal(await readFile(f.file, 'utf8'), bytes);
    migrated.sources[0].rights = 'changed by caller';
    assert.deepEqual((await repo.read()).sources, legacy.sources);
  } finally { await f.cleanup(); }
});

test('schema-1 files containing later authority fields are rejected without silently dropping data', async () => {
  const f = await fixture();
  try {
    const repo = new JsonRepository(f.file);
    for (const key of ['managedSources', 'quarantine', 'provenanceDecisions', 'deletions', 'retentionReviewRequired', 'drafts', 'draftReviews', 'editions', 'editionReviews']) {
      for (const value of [[], [{ sourceId: 'legacy', publicRedistribution: true }]]) {
        const bytes = JSON.stringify({ ...legacyFixture(), [key]: value }, null, 2) + '\n';
        await writeFile(f.file, bytes);
        await assert.rejects(repo.read(), /Invalid repository format/);
        let changed = false;
        await assert.rejects(repo.transact(() => { changed = true; }), /Invalid repository format/);
        assert.equal(changed, false);
        assert.equal(await readFile(f.file, 'utf8'), bytes);
        assert.deepEqual(await readdir(f.dir), ['repository.json']);
      }
    }
  } finally { await f.cleanup(); }
});

test('the next successful legacy transaction persists schema 5 and preserves old records exactly', async () => {
  const f = await fixture();
  try {
    const legacy = legacyFixture();
    await writeFile(f.file, JSON.stringify(legacy));
    const repo = new JsonRepository(f.file);
    assert.equal(await repo.transact(appendSourceAndAudit), 'new-source');
    const saved = JSON.parse(await readFile(f.file, 'utf8'));
    assert.equal(saved.schema, 5);
    assert.equal(saved.retentionReviewRequired, true);
    assert.deepEqual(saved.sources.slice(0, legacy.sources.length), legacy.sources);
    assert.deepEqual(saved.revisions, legacy.revisions);
    assert.deepEqual(saved.approvals, legacy.approvals);
    assert.deepEqual(saved.audit.slice(0, legacy.audit.length), legacy.audit);
    for (const key of ['managedSources', 'quarantine', 'provenanceDecisions', 'deletions', 'drafts', 'draftReviews', 'editions', 'editionReviews'] as const) assert.deepEqual(saved[key], []);
    assert.deepEqual(await repo.read(), saved);
  } finally { await f.cleanup(); }
});

test('schema-2 migration requires retention review and preserves history without inventing audit retention', async () => {
  const f = await fixture();
  try {
    const legacy = schema2Fixture();
    const bytes = JSON.stringify(legacy, null, 2) + '\n';
    await writeFile(f.file, bytes);
    const repo = new JsonRepository(f.file);
    const migrated = await repo.read();
    assert.equal(migrated.schema, 5);
    assert.equal(migrated.retentionReviewRequired, true);
    for (const key of ['sources', 'revisions', 'approvals', 'audit', 'managedSources', 'quarantine', 'provenanceDecisions', 'deletions'] as const) assert.deepEqual(migrated[key], legacy[key]);
    assert.equal(Object.hasOwn(migrated.managedSources[0].policy, 'auditRetentionDays'), false);
    assert.equal(Object.hasOwn(migrated.deletions[0], 'expiresAt'), false);
    assert.deepEqual(migrated.drafts, []);
    assert.deepEqual(migrated.draftReviews, []);
    assert.deepEqual(migrated.editions, []);
    assert.deepEqual(migrated.editionReviews, []);
    assert.equal(policyStatus(migrated.managedSources[0].policy, at), 'UNKNOWN');
    assert.equal(await readFile(f.file, 'utf8'), bytes);
    await repo.transact(() => undefined);
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), migrated);
    assert.deepEqual(await repo.read(), migrated);
    assert.equal(policyStatus((await repo.read()).managedSources[0].policy, at), 'UNKNOWN');
  } finally { await f.cleanup(); }
});

test('schema-2 files reject supplied review flags and incomplete authority arrays', async () => {
  const f = await fixture();
  try {
    const repo = new JsonRepository(f.file);
    const invalid: unknown[] = [false, true, null, 0, 'false'].map(retentionReviewRequired => ({ ...schema2Fixture(), retentionReviewRequired }));
    for (const key of ['managedSources', 'quarantine', 'provenanceDecisions', 'deletions']) {
      const missing: Record<string, unknown> = { ...schema2Fixture() }; delete missing[key];
      invalid.push(missing);
    }
    for (const auditRetentionDays of [-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      const legacy = schema2Fixture();
      invalid.push({ ...legacy, managedSources: legacy.managedSources.map(row => ({ ...row, policy: { ...row.policy, auditRetentionDays } })) });
    }
    for (const state of invalid) {
      const bytes = JSON.stringify(state);
      await writeFile(f.file, bytes);
      await assert.rejects(repo.read(), /Invalid repository format/);
      await assert.rejects(repo.transact(() => undefined), /Invalid repository format/);
      assert.equal(await readFile(f.file, 'utf8'), bytes);
    }
  } finally { await f.cleanup(); }
});

test('schema-3 migration preserves retention decisions and all history without granting draft or AI rights', async () => {
  const f = await fixture();
  try {
    const repo = new JsonRepository(f.file);
    for (const retentionReviewRequired of [false, true]) {
      const legacy = { ...schema2Fixture(), schema: 3, retentionReviewRequired };
      const bytes = JSON.stringify(legacy, null, 2) + '\n';
      await writeFile(f.file, bytes);
      const migrated = await repo.read();
      assert.deepEqual(migrated, { ...legacy, schema: 5, drafts: [], draftReviews: [], editions: [], editionReviews: [] });
      assert.equal(migrated.retentionReviewRequired, retentionReviewRequired);
      assert.equal(migrated.managedSources[0].policy.aiSummarization, false);
      assert.equal(migrated.managedSources[0].policy.aiNarration, false);
      assert.equal(Object.hasOwn(migrated.managedSources[0].policy, 'auditRetentionDays'), false);
      assert.equal(await readFile(f.file, 'utf8'), bytes);
      await repo.transact(() => undefined);
      assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), migrated);
      assert.deepEqual(await repo.read(), migrated);
    }
  } finally { await f.cleanup(); }
});

test('schema-4 migration preserves drafts and retention holds without rewriting bytes or granting edition authority', async () => {
  const f = await fixture();
  try {
    const repo = new JsonRepository(f.file);
    for (const retentionReviewRequired of [false, true]) {
      const legacy = { ...schema2Fixture(), schema: 4, retentionReviewRequired, drafts: [activeDraftFixture()], draftReviews: [draftReviewFixture()] };
      const bytes = JSON.stringify(legacy, null, 2) + '\n';
      await writeFile(f.file, bytes);
      const migrated = await repo.read();
      assert.deepEqual(migrated, { ...legacy, schema: 5, editions: [], editionReviews: [] });
      assert.equal(await readFile(f.file, 'utf8'), bytes);
      assert.equal(migrated.managedSources[0].policy.publicRedistribution, false);
      assert.equal(migrated.managedSources[0].policy.aiSummarization, false);
      await repo.transact(() => undefined);
      assert.deepEqual(await repo.read(), migrated);
      assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), migrated);
    }
  } finally { await f.cleanup(); }
});

test('pre-edition schemas reject edition fields rather than silently losing or adopting their authority', async () => {
  const f = await fixture();
  try {
    const repo = new JsonRepository(f.file);
    const schema3 = { ...schema2Fixture(), schema: 3, retentionReviewRequired: false };
    const schema4 = { ...schema3, schema: 4, drafts: [activeDraftFixture()], draftReviews: [draftReviewFixture()] };
    for (const legacy of [legacyFixture(), schema2Fixture(), schema3, schema4]) {
      for (const key of ['editions', 'editionReviews']) {
        for (const value of [[], [{ id: 'untrusted-edition', status: 'PUBLISHED' }]]) {
          const bytes = JSON.stringify({ ...legacy, [key]: value });
          await writeFile(f.file, bytes);
          await assert.rejects(repo.read(), /Invalid repository format/);
          await assert.rejects(repo.transact(() => undefined), /Invalid repository format/);
          assert.equal(await readFile(f.file, 'utf8'), bytes);
          assert.deepEqual(await readdir(f.dir), ['repository.json']);
        }
      }
    }
  } finally { await f.cleanup(); }
});

test('pre-draft schemas reject draft fields instead of silently discarding proposed content or reviews', async () => {
  const f = await fixture();
  try {
    const repo = new JsonRepository(f.file);
    for (const legacy of [legacyFixture(), schema2Fixture(), { ...schema2Fixture(), schema: 3, retentionReviewRequired: false }]) {
      for (const key of ['drafts', 'draftReviews']) {
        for (const value of [[], [activeDraftFixture()], [draftReviewFixture()]]) {
          const bytes = JSON.stringify({ ...legacy, [key]: value });
          await writeFile(f.file, bytes);
          await assert.rejects(repo.read(), /Invalid repository format/);
          await assert.rejects(repo.transact(() => undefined), /Invalid repository format/);
          assert.equal(await readFile(f.file, 'utf8'), bytes);
          assert.deepEqual(await readdir(f.dir), ['repository.json']);
        }
      }
    }
  } finally { await f.cleanup(); }
});

test('schema 5 roundtrips typed draft records and rejects malformed active payloads or review identities', async () => {
  const f = await fixture();
  try {
    const repo = new JsonRepository(f.file);
    const valid = activeDraftFixture();
    const review = draftReviewFixture();
    const state: State = { ...emptyState(), drafts: [valid], draftReviews: [review, { ...review, storyVersion: null, fromState: 'ON_HOLD', toState: 'INVALIDATED' }] };
    const bytes = JSON.stringify(state, null, 2) + '\n';
    await writeFile(f.file, bytes);
    assert.deepEqual(await repo.read(), state);
    assert.equal(await readFile(f.file, 'utf8'), bytes);
    await repo.transact(() => undefined);
    assert.deepEqual(await repo.read(), state);
    const invalidDrafts: unknown[] = [
      { id: 'draft', status: 'GENERATED' }, { ...valid, status: 'PUBLISHED' }, { ...valid, storyVersion: 0 }, { ...valid, version: 1.5 }, { ...valid, promptTemplateVersion: 'unrecognized-template' },
      { ...valid, output: undefined }, { ...valid, output: { headline: 'Missing body' } },
      { ...valid, output: { ...valid.output, sections: [{ ...valid.output.sections[0], kind: 'PROMOTION' }] } },
      { ...valid, output: { ...valid.output, claims: [{ ...valid.output.claims[0], supportingSourceIds: null }] } },
      { ...valid, output: { ...valid.output, uncertainties: [true] } },
      { ...valid, policies: [{ ...valid.policies[0], snapshotDigest: undefined }] }, { ...valid, policies: [{ ...valid.policies[0], policyVersion: 0 }] },
      { ...valid, sourceIds: [3] }, { ...valid, suggestions: [{ code: 'UNKNOWN', message: 'Unknown suggestion' }] },
      { ...valid, usage: undefined }, { ...valid, usage: { ...valid.usage, inputTokens: -1 } }, { ...valid, usage: { ...valid.usage, estimatedCostMicros: 0.5 } }
    ];
    const invalidReviews: unknown[] = [
      { ...review, unauthenticated: false }, { ...review, unauthenticated: undefined }, { ...review, actorAssertion: undefined },
      { ...review, fromVersion: 0 }, { ...review, toVersion: 1.5 }, { ...review, storyVersion: '1' }, { ...review, storyVersion: -1 },
      { ...review, fromState: 'PUBLISHED' }, { ...review, toState: undefined }
    ];
    for (const malformed of [...invalidDrafts.map(row => ({ ...emptyState(), drafts: [row] })), ...invalidReviews.map(row => ({ ...emptyState(), draftReviews: [row] }))]) {
      const badBytes = JSON.stringify(malformed);
      await writeFile(f.file, badBytes);
      await assert.rejects(repo.read(), /Invalid repository format/);
      await assert.rejects(repo.transact(() => undefined), /Invalid repository format/);
      assert.equal(await readFile(f.file, 'utf8'), badBytes);
    }
  } finally { await f.cleanup(); }
});

test('invalidated drafts retain only their minimal marker and reject every extra payload or linkage field', async () => {
  const f = await fixture();
  try {
    const repo = new JsonRepository(f.file);
    const marker = { id: 'invalidated-draft', status: 'INVALIDATED', invalidatedAt: at, reason: 'STALE_OR_INELIGIBLE' };
    const state = { ...emptyState(), drafts: [marker] };
    await writeFile(f.file, JSON.stringify(state));
    assert.deepEqual(await repo.read(), state);
    await repo.transact(() => undefined);
    assert.deepEqual(await repo.read(), state);
    const invalid: unknown[] = [{ ...marker, reason: 'UNRECOGNIZED' }, { ...marker, invalidatedAt: undefined }];
    for (const [key, value] of Object.entries(activeDraftFixture()).filter(([key]) => !['id', 'status'].includes(key))) invalid.push({ ...marker, [key]: value });
    invalid.push({ ...marker, unexpectedLicensedText: 'Fictional content must not survive invalidation' });
    for (const row of invalid) {
      const bytes = JSON.stringify({ ...emptyState(), drafts: [row] });
      await writeFile(f.file, bytes);
      await assert.rejects(repo.read(), /Invalid repository format/);
      await assert.rejects(repo.transact(() => undefined), /Invalid repository format/);
      assert.equal(await readFile(f.file, 'utf8'), bytes);
      assert.deepEqual(await readdir(f.dir), ['repository.json']);
    }
  } finally { await f.cleanup(); }
});

test('schema 3 requires its review flag and preserves only explicit true historical redaction markers', async () => {
  const f = await fixture();
  try {
    const legacy = legacyFixture();
    const repo = new JsonRepository(f.file);
    for (const retentionReviewRequired of [false, true]) {
      const state = { ...legacy, schema: 3, retentionReviewRequired, managedSources: [], quarantine: [], provenanceDecisions: [], deletions: [], revisions: legacy.revisions.map(row => ({ ...row, retentionRedacted: true })), approvals: legacy.approvals.map(row => ({ ...row, retentionRedacted: true })) };
      const bytes = JSON.stringify(state);
      const migrated = { ...state, schema: 5, drafts: [], draftReviews: [], editions: [], editionReviews: [] };
      await writeFile(f.file, bytes);
      assert.deepEqual(await repo.read(), migrated);
      assert.equal(await readFile(f.file, 'utf8'), bytes);
      await repo.transact(() => undefined);
      assert.deepEqual(await repo.read(), migrated);
    }
    const missingFlag: Record<string, unknown> = { ...emptyState() }; delete missingFlag.retentionReviewRequired;
    const invalid: unknown[] = [missingFlag, ...[null, 'false', 0, []].map(retentionReviewRequired => ({ ...emptyState(), retentionReviewRequired }))];
    for (const key of ['revisions', 'approvals'] as const) {
      for (const retentionRedacted of [false, null, 'true', 1]) invalid.push({ ...emptyState(), [key]: legacy[key].map(row => ({ ...row, retentionRedacted })) });
    }
    for (const state of invalid) {
      const bytes = JSON.stringify(state);
      await writeFile(f.file, bytes);
      await assert.rejects(repo.read(), /Invalid repository format/);
      await assert.rejects(repo.transact(() => undefined), /Invalid repository format/);
      assert.equal(await readFile(f.file, 'utf8'), bytes);
    }
  } finally { await f.cleanup(); }
});

test('schema-5 snapshots retain captured restrictions, quarantine, provenance and deletion history unchanged', async () => {
  const f = await fixture();
  try {
    const state: State = emptyState();
    state.sources.push(source('historical'));
    const captured = {
      sourceId: 'historical', providerId: 'fictional-fixture', retainedAt: at, deleteAt: '2026-01-03T00:00:00.000Z',
      policy: { id: 'historical-policy', providerId: 'fictional-fixture', version: 1, reviewStatus: 'REVOKED' as const, effectiveAt: at, expiresAt: '2026-01-03T00:00:00.000Z', evidenceReference: 'fictional-fixture-only:history', discoveryMetadata: true, licensedExcerpt: false, licensedFullText: false, media: false, internalAnalysis: false, publicRedistribution: false, aiSummarization: false, aiNarration: false, retentionDays: 1, auditRetentionDays: 0, deletionRequired: true, quarantineMetadata: false, minimalAudit: false },
      providerMetadata: { url: 'https://example.test/historical', publisher: 'Fictional publisher', publishedAt: at, retrievedAt: at },
      providerProvenance: { type: 'UNKNOWN' as const, originId: null }
    };
    state.managedSources.push(captured);
    state.quarantine.push({ ...captured, sourceId: 'quarantined', providerProvenance: { type: 'DISPUTED', originId: null }, metadata: { url: 'https://example.test/quarantined', publisher: 'Fictional publisher', publishedAt: at, retrievedAt: at } });
    state.provenanceDecisions.push({ id: 'decision', sourceId: 'historical', classification: 'DISPUTED', originId: null, actorAssertion: 'fixture-reviewer', at, evidenceReferences: ['fictional-evidence'], reason: 'Fixture disagreement' });
    state.deletions.push({ sourceId: 'deleted', at, reason: 'Fixture retention expiry', expiresAt: '2026-01-03T00:00:00.000Z' });
    const bytes = JSON.stringify(state, null, 2) + '\n';
    await writeFile(f.file, bytes);
    const repo = new JsonRepository(f.file);
    assert.deepEqual(await repo.read(), state);
    assert.equal(await readFile(f.file, 'utf8'), bytes);
    await repo.transact(() => undefined);
    assert.deepEqual(await repo.read(), state);
    const savedQuarantine = (await repo.read()).quarantine[0];
    assert.deepEqual(savedQuarantine.providerProvenance, { type: 'DISPUTED', originId: null });
    for (const key of ['licensedExcerpt', 'licensedFullText', 'media', 'internalAnalysis', 'publicRedistribution', 'aiSummarization', 'aiNarration'] as const) assert.equal(savedQuarantine.policy[key], false);
  } finally { await f.cleanup(); }
});

test('unsupported, corrupt and incomplete repository formats fail closed without changing bytes', async () => {
  const f = await fixture();
  try {
    const repo = new JsonRepository(f.file);
    const invalid: unknown[] = [null, [], {}, { ...emptyState(), schema: 0 }, { ...emptyState(), schema: 6 }, { ...emptyState(), schema: '5' }, { ...emptyState(), retentionReviewRequired: 'false' }, { ...emptyState(), sources: [{}] }, { ...emptyState(), audit: [null] }, { ...emptyState(), managedSources: [{ sourceId: 'legacy' }] }, { ...emptyState(), provenanceDecisions: [{ sourceId: 'legacy' }] }, { ...emptyState(), deletions: [{ sourceId: 'deleted', at, reason: 'Fixture expiry', expiresAt: 3 }] }];
    for (const key of Object.keys(emptyState()).filter(key => key !== 'schema' && key !== 'retentionReviewRequired')) {
      const missing: Record<string, unknown> = { ...emptyState() }; delete missing[key];
      invalid.push(missing, { ...emptyState(), [key]: {} }, { ...emptyState(), [key]: [null] }, { ...emptyState(), [key]: [{}] });
    }
    for (const state of invalid) {
      const bytes = JSON.stringify(state);
      await writeFile(f.file, bytes);
      await assert.rejects(repo.read(), /Invalid repository format/);
      await assert.rejects(repo.transact(appendSourceAndAudit), /Invalid repository format/);
      assert.equal(await readFile(f.file, 'utf8'), bytes);
      assert.deepEqual(await readdir(f.dir), ['repository.json']);
    }
    await writeFile(f.file, '{');
    await assert.rejects(repo.read(), SyntaxError);
    assert.equal(await readFile(f.file, 'utf8'), '{');
  } finally { await f.cleanup(); }
});

test('an injected failure after synced staging preserves the old repository and permits a complete retry', async () => {
  const f = await fixture();
  try {
    const legacy = legacyFixture();
    const bytes = JSON.stringify(legacy, null, 2) + '\n';
    await writeFile(f.file, bytes);
    const injected = new Error('Injected pre-commit failure');
    let attempts = 0;
    const repo = new JsonRepository(f.file, { beforeCommit: () => {
      attempts++;
      assert.equal(readFileSync(f.file, 'utf8'), bytes);
      const temps = readdirSync(f.dir).filter(name => name.endsWith('.tmp'));
      assert.equal(temps.length, 1);
      const staged = JSON.parse(readFileSync(join(f.dir, temps[0]), 'utf8'));
      assert.equal(staged.schema, 5);
      assert.equal(staged.retentionReviewRequired, true);
      assert.ok(staged.sources.some((entry: Source) => entry.id === 'new-source'));
      assert.ok(staged.audit.some((entry: { id: string }) => entry.id === 'new-audit'));
      if (attempts === 1) throw injected;
    } });
    await assert.rejects(repo.transact(appendSourceAndAudit), error => error === injected);
    assert.equal(await readFile(f.file, 'utf8'), bytes);
    assert.deepEqual(await readdir(f.dir), ['repository.json']);
    const unchanged = await repo.read();
    assert.deepEqual(unchanged.sources, legacy.sources);
    assert.deepEqual(unchanged.audit, legacy.audit);
    assert.equal(await repo.transact(appendSourceAndAudit), 'new-source');
    assert.equal(attempts, 2);
    const committed = await repo.read();
    assert.equal(committed.sources.filter(entry => entry.id === 'new-source').length, 1);
    assert.equal(committed.audit.filter(entry => entry.id === 'new-audit').length, 1);
    assert.deepEqual(await readdir(f.dir), ['repository.json']);
  } finally { await f.cleanup(); }
});

test('an uncloneable transaction result fails before staging or committing its mutations', async () => {
  const f = await fixture();
  try {
    const bytes = JSON.stringify(emptyState());
    await writeFile(f.file, bytes);
    let called = false;
    const repo = new JsonRepository(f.file, { beforeCommit: () => { called = true; } });
    await assert.rejects(repo.transact(state => { appendSourceAndAudit(state); return () => 'cannot clone'; }), { name: 'DataCloneError' });
    assert.equal(called, false);
    assert.equal(await readFile(f.file, 'utf8'), bytes);
    assert.deepEqual(await readdir(f.dir), ['repository.json']);
    assert.equal(await repo.transact(appendSourceAndAudit), 'new-source');
  } finally { await f.cleanup(); }
});

test('new repositories use schema 5 and failed changes cannot leave partial state', async () => {
  const f = await fixture();
  try {
    const repo = new JsonRepository(f.file);
    assert.deepEqual(await repo.read(), emptyState());
    assert.equal((await repo.read()).retentionReviewRequired, false);
    assert.deepEqual(await readdir(f.dir), []);
    await assert.rejects(repo.transact(state => { appendSourceAndAudit(state); throw Error('Rejected transaction'); }), /Rejected transaction/);
    assert.deepEqual(await readdir(f.dir), []);
    await assert.rejects(repo.transact(state => { appendSourceAndAudit(state); (state as unknown as Record<string, unknown>).quarantine = null; }), /Invalid repository format/);
    assert.deepEqual(await readdir(f.dir), []);
    assert.deepEqual(await repo.read(), emptyState());
  } finally { await f.cleanup(); }
});
