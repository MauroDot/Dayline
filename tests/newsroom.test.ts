import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/newsroom/store.ts';
import { Newsroom } from '../src/newsroom/service.ts';
import { canonicalURL, type Source, type Story } from '../src/newsroom/model.ts';

// Entirely fictional locations, publishers, stories and source URLs.
const source = (id: string, type: Source['type'] = 'ORIGINAL', originId = id): Omit<Source, 'canonicalUrl'> => ({ id, publisher: `Fictional ${id}`, url: `https://example.test/reports/${id}?utm_source=fiction`, type, publishedAt: '2026-01-01T00:00:00Z', retrievedAt: '2026-01-02T00:00:00Z', originId, rights: 'fictional test fixture only', verification: 'VERIFIED' });
const story = (id: string): Omit<Story, 'status' | 'version'> => ({ id, headline: 'Fictional town garden proposal', topic: 'fiction', summary: 'A fictional event', geography: 'Imaginary Town', eventAt: null, firstSeenAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', clusterId: 'fiction-cluster', sourceIds: ['original', 'independent', 'copy1', 'copy2'], evidence: [{ id: 'claim1', claim: 'A fictional proposal exists', support: ['original', 'independent'], contradict: [], verification: 'VERIFIED', uncertainty: 'Only a fixture', reviewerDecisions: [] }] });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dayline-newsroom-')); const repo = new JsonRepository(join(dir, 'data.json')); const service = new Newsroom(repo);
  for (const s of [source('original'), source('independent'), source('copy1', 'SYNDICATED', 'original'), source('copy2', 'SYNDICATED', 'original')]) await service.ingest(s, 'fixture');
  return { dir, repo, service, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
async function draftToReview(service: Newsroom, id: string) {
  for (const status of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW'] as const) await service.transition(id, status, 'editor');
}
test('canonical URLs normalize tracking and reject dangerous credentials or schemes', () => {
  assert.equal(canonicalURL('HTTPS://EXAMPLE.TEST:443/a/?utm_source=x&z=2&a=1#top'), 'https://example.test/a?a=1&z=2');
  assert.throws(() => canonicalURL('file:///etc/passwd')); assert.throws(() => canonicalURL('https://u:p@example.test/'));
});
test('source validation, provenance, independence and duplicate ingestion', async () => {
  const f = await fixture(); try {
    assert.equal(await f.service.independentCount(['original', 'copy1', 'copy2', 'independent']), 2);
    await assert.rejects(f.service.ingest(source('copy1'), 'editor'), /Duplicate/);
    await assert.rejects(f.service.ingest({ ...source('other'), url: 'https://example.test/reports/original' }, 'editor'), /Duplicate/);
    await assert.rejects(f.service.ingest(source('copy3', 'SYNDICATED', 'missing'), 'editor'), /original/);
    await assert.rejects(f.service.ingest({ ...source('invalid'), rights: '' }, 'editor'), /Missing/);
    const data = await f.service.snapshot(); assert.equal(data.sources.find(x => x.id === 'copy1')?.originId, 'original');
  } finally { await f.cleanup(); }
});
test('similarity creates review candidates without merging', async () => {
  const f = await fixture(); try {
    await f.service.create(story('first'), 'editor');
    assert.deepEqual(await f.service.candidates('Fictional town garden event'), ['first']);
    assert.deepEqual(await f.service.candidates('Oceanic volcano'), []);
    assert.equal((await f.service.snapshot()).revisions.length, 1);
  } finally { await f.cleanup(); }
});
test('revision-specific approval, stale edits and preserved corrections', async () => {
  const f = await fixture(); try {
    await f.service.create(story('first'), 'editor');
    await assert.rejects(f.service.transition('first', 'PUBLISHED', 'editor'), /transition/);
    await draftToReview(f.service, 'first');
    const approval = await f.service.transition('first', 'APPROVED', 'reviewer-1');
    await f.service.edit('first', { summary: 'Fictional revised summary' }, 'editor');
    await assert.rejects(f.service.transition('first', 'PUBLISHED', 'editor'), /transition/);
    await f.service.transition('first', 'NEEDS_REVIEW', 'editor'); await f.service.transition('first', 'APPROVED', 'reviewer-2');
    const published = await f.service.transition('first', 'PUBLISHED', 'editor');
    await assert.rejects(f.service.edit('first', { summary: 'silent edit' }, 'editor'), /cannot be edited/);
    await f.service.transition('first', 'CORRECTION_REQUIRED', 'editor'); await f.service.edit('first', { summary: 'Fictional correction' }, 'editor');
    const data = await f.service.snapshot();
    assert.ok(data.revisions.some(r => r.version === published.version && r.status === 'PUBLISHED'));
    assert.ok(data.approvals.some(a => a.version === approval.version && a.reviewer === 'reviewer-1'));
    assert.ok(data.audit.some(a => a.action === 'STATUS_CORRECTION_REQUIRED'));
  } finally { await f.cleanup(); }
});
test('insufficient evidence and hold or rejection cannot publish', async () => {
  const f = await fixture(); try {
    const insufficient = story('weak'); insufficient.evidence[0].verification = 'UNVERIFIED'; insufficient.evidence[0].support = [];
    await f.service.create(insufficient, 'editor'); await draftToReview(f.service, 'weak');
    await assert.rejects(f.service.transition('weak', 'APPROVED', 'reviewer'), /Verified/);
    await f.service.transition('weak', 'ON_HOLD', 'editor'); await assert.rejects(f.service.transition('weak', 'PUBLISHED', 'editor'), /transition/);
    await f.service.transition('weak', 'REJECTED', 'editor'); await assert.rejects(f.service.transition('weak', 'DRAFT', 'editor'), /transition/);
    const invalid = story('invalid'); invalid.evidence[0].support = []; await assert.rejects(f.service.create(invalid, 'editor'), /supporting/);
  } finally { await f.cleanup(); }
});
test('concurrent writers, persistence, independent snapshots and corrupt storage', async () => {
  const f = await fixture(); try {
    await Promise.all(Array.from({length: 8}, (_, i) => new Newsroom(new JsonRepository(f.repo.file)).ingest(source('parallel' + i), 'editor')));
    const results = await Promise.allSettled([f.service.ingest(source('race'), 'editor'), f.service.ingest(source('race'), 'editor')]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const snapshot = await f.service.snapshot(); const count = snapshot.audit.length; snapshot.audit.length = 0; snapshot.sources[0].publisher = 'tampered';
    const reread = await new Newsroom(new JsonRepository(f.repo.file)).snapshot(); assert.equal(reread.audit.length, count); assert.notEqual(reread.sources[0].publisher, 'tampered');
    await writeFile(f.repo.file, '{'); await assert.rejects(f.service.snapshot());
  } finally { await f.cleanup(); }
});
