import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/newsroom/store.ts';
import { emptyState, type State, type Source } from '../src/newsroom/model.ts';

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
    assert.equal(migrated.schema, 2);
    for (const key of ['sources', 'revisions', 'approvals', 'audit'] as const) assert.deepEqual(migrated[key], legacy[key]);
    for (const key of ['managedSources', 'quarantine', 'provenanceDecisions', 'deletions'] as const) assert.deepEqual(migrated[key], []);
    assert.equal(await readFile(f.file, 'utf8'), bytes);
    migrated.sources[0].rights = 'changed by caller';
    assert.deepEqual((await repo.read()).sources, legacy.sources);
  } finally { await f.cleanup(); }
});

test('schema-1 files containing schema-2 authority fields are rejected without silently dropping data', async () => {
  const f = await fixture();
  try {
    const repo = new JsonRepository(f.file);
    for (const key of ['managedSources', 'quarantine', 'provenanceDecisions', 'deletions']) {
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

test('the next successful legacy transaction persists schema 2 and preserves old records exactly', async () => {
  const f = await fixture();
  try {
    const legacy = legacyFixture();
    await writeFile(f.file, JSON.stringify(legacy));
    const repo = new JsonRepository(f.file);
    assert.equal(await repo.transact(appendSourceAndAudit), 'new-source');
    const saved = JSON.parse(await readFile(f.file, 'utf8'));
    assert.equal(saved.schema, 2);
    assert.deepEqual(saved.sources.slice(0, legacy.sources.length), legacy.sources);
    assert.deepEqual(saved.revisions, legacy.revisions);
    assert.deepEqual(saved.approvals, legacy.approvals);
    assert.deepEqual(saved.audit.slice(0, legacy.audit.length), legacy.audit);
    for (const key of ['managedSources', 'quarantine', 'provenanceDecisions', 'deletions'] as const) assert.deepEqual(saved[key], []);
    assert.deepEqual(await repo.read(), saved);
  } finally { await f.cleanup(); }
});

test('schema-2 snapshots retain captured restrictions, quarantine, provenance and deletion history unchanged', async () => {
  const f = await fixture();
  try {
    const state: State = emptyState();
    state.sources.push(source('historical'));
    const captured = {
      sourceId: 'historical', providerId: 'fictional-fixture', retainedAt: at, deleteAt: '2026-01-03T00:00:00.000Z',
      policy: { id: 'historical-policy', providerId: 'fictional-fixture', version: 1, reviewStatus: 'REVOKED' as const, effectiveAt: at, expiresAt: '2026-01-03T00:00:00.000Z', evidenceReference: 'fictional-fixture-only:history', discoveryMetadata: true, licensedExcerpt: false, licensedFullText: false, media: false, internalAnalysis: false, publicRedistribution: false, aiSummarization: false, aiNarration: false, retentionDays: 1, deletionRequired: true, quarantineMetadata: false, minimalAudit: false },
      providerMetadata: { url: 'https://example.test/historical', publisher: 'Fictional publisher', publishedAt: at, retrievedAt: at },
      providerProvenance: { type: 'UNKNOWN' as const, originId: null }
    };
    state.managedSources.push(captured);
    state.quarantine.push({ ...captured, sourceId: 'quarantined', providerProvenance: { type: 'DISPUTED', originId: null }, metadata: { url: 'https://example.test/quarantined', publisher: 'Fictional publisher', publishedAt: at, retrievedAt: at } });
    state.provenanceDecisions.push({ id: 'decision', sourceId: 'historical', classification: 'DISPUTED', originId: null, actorAssertion: 'fixture-reviewer', at, evidenceReferences: ['fictional-evidence'], reason: 'Fixture disagreement' });
    state.deletions.push({ sourceId: 'deleted', at, reason: 'Fixture retention expiry' });
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
    const invalid: unknown[] = [null, [], {}, { ...emptyState(), schema: 0 }, { ...emptyState(), schema: 3 }, { ...emptyState(), schema: '2' }, { ...emptyState(), sources: [{}] }, { ...emptyState(), audit: [null] }, { ...emptyState(), managedSources: [{ sourceId: 'legacy' }] }, { ...emptyState(), provenanceDecisions: [{ sourceId: 'legacy' }] }];
    for (const key of Object.keys(emptyState()).filter(key => key !== 'schema')) {
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
      assert.equal(staged.schema, 2);
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

test('new repositories use schema 2 and failed changes cannot leave partial state', async () => {
  const f = await fixture();
  try {
    const repo = new JsonRepository(f.file);
    assert.deepEqual(await repo.read(), emptyState());
    assert.deepEqual(await readdir(f.dir), []);
    await assert.rejects(repo.transact(state => { appendSourceAndAudit(state); throw Error('Rejected transaction'); }), /Rejected transaction/);
    assert.deepEqual(await readdir(f.dir), []);
    await assert.rejects(repo.transact(state => { appendSourceAndAudit(state); (state as unknown as Record<string, unknown>).quarantine = null; }), /Invalid repository format/);
    assert.deepEqual(await readdir(f.dir), []);
    assert.deepEqual(await repo.read(), emptyState());
  } finally { await f.cleanup(); }
});
