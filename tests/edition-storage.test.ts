import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/newsroom/store.ts';
import { emptyState, type State } from '../src/newsroom/model.ts';
import { sectionIds, type ActiveEdition, type EditionReview, type Placement } from '../src/editions/types.ts';

const at = '2026-06-01T12:00:00.000Z';
const expiresAt = '2026-06-02T12:00:00.000Z';
function placement(id = 'fictional-story'): Placement {
  return {
    storyId: id, storyVersion: 1, headline: 'Fictional proposal remains under review', summary: 'Two fictional reports describe a proposal.', featured: true,
    sources: ['first', 'second'].map(name => ({ sourceId: `source-${name}`, originId: `origin-${name}`, publisher: `Fictional ${name} publisher`, url: `https://edition.example.test/${name}`, providerId: 'fictional-fixture', policyId: 'fictional-edition-policy', policyVersion: 1, snapshotDigest: 'a'.repeat(64), expiresAt })),
    evidence: [{ id: 'fictional-claim', support: ['source-first'], contradict: ['source-second'], uncertainty: 'The fictional timetable is uncertain.' }], independentSourceCount: 2, expiresAt
  };
}
function edition(revision = 1): ActiveEdition {
  return {
    id: 'fictional-edition', date: '2026-06-01', timezone: 'America/New_York', revision, createdAt: at, updatedAt: at, status: revision === 1 ? 'ASSEMBLING' : 'NEEDS_REVIEW',
    sections: sectionIds.map(id => ({ id, placements: id === 'TOP_STORIES' ? [placement()] : [] })),
    suggestions: [{ code: 'MISSING_UNCERTAINTY', storyId: 'fictional-story', message: 'Fictional advisory reminder only.' }]
  };
}
function review(): EditionReview {
  return { editionId: 'fictional-edition', fromRevision: 1, toRevision: 2, fromState: 'ASSEMBLING', toState: 'NEEDS_REVIEW', actorAssertion: 'fictional-reviewer', unauthenticated: true, at };
}
function state(): State { return { ...emptyState(), editions: [edition(1), edition(2)], editionReviews: [review()] }; }
async function fixture(run: (repo: JsonRepository, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-edition-storage-'));
  try { await run(new JsonRepository(join(directory, 'fictional.json')), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function rejected(repo: JsonRepository, directory: string, values: unknown[]) {
  for (const value of values) {
    const bytes = JSON.stringify(value);
    await writeFile(repo.file, bytes);
    await assert.rejects(repo.read(), /Invalid repository format/);
    await assert.rejects(repo.transact(() => undefined), /Invalid repository format/);
    assert.equal(await readFile(repo.file, 'utf8'), bytes);
    assert.deepEqual(await readdir(directory), ['fictional.json']);
  }
}
function withEdition(value: unknown): unknown { return { ...emptyState(), editions: [value] }; }

test('edition revisions and unauthenticated reviews roundtrip without changing placement order or creating approval', async () => fixture(async repo => {
  const original = state();
  original.editions.forEach(row => { if (row.status !== 'INVALIDATED') row.sections[0].placements.push({ ...placement('second-fictional-story'), featured: false }); });
  await repo.transact(value => { value.editions = original.editions; value.editionReviews = original.editionReviews; });
  assert.deepEqual(await repo.read(), original);
  const snapshot = await repo.read();
  if (snapshot.editions[0].status === 'INVALIDATED') assert.fail('Expected an active edition');
  snapshot.editions[0].sections[0].placements[0].summary = 'Caller mutation';
  snapshot.editionReviews[0].actorAssertion = 'Caller mutation';
  const saved = await repo.read();
  assert.deepEqual(saved, original);
  assert.deepEqual(saved.approvals, []);
  assert.deepEqual(saved.revisions, []);
  assert.ok(saved.editionReviews.every(row => row.unauthenticated === true));
}));

test('canonical storage serialization is deterministic for object-key order and preserves array order', async () => fixture(async (repo, directory) => {
  const original = state();
  const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value;
  await writeFile(repo.file, JSON.stringify(original, null, 2) + '\n');
  const other = new JsonRepository(join(directory, 'other-fictional.json'));
  await writeFile(other.file, JSON.stringify(reverseKeys(original)));
  await repo.transact(() => undefined);
  await other.transact(() => undefined);
  const bytes = await readFile(repo.file, 'utf8');
  assert.equal(await readFile(other.file, 'utf8'), bytes);
  await repo.transact(() => undefined);
  assert.equal(await readFile(repo.file, 'utf8'), bytes);
  assert.deepEqual(await repo.read(), original);
  const saved = await repo.read();
  if (saved.editions[0].status === 'INVALIDATED') assert.fail('Expected an active edition');
  assert.deepEqual(saved.editions[0].sections.map(section => section.id), [...sectionIds]);
}));

test('edition commit failure keeps original schema-4 bytes and rolls back revisions, reviews and audit together', async () => fixture(async (repo, directory) => {
  const { editions: _newEditions, editionReviews: _newReviews, schedules: _newSchedules, preparationRuns: _newRuns, ...oldState } = emptyState();
  const bytes = JSON.stringify({ ...oldState, schema: 4 }, null, 2) + '\n';
  await writeFile(repo.file, bytes);
  const injected = new Error('Injected edition commit failure');
  let calls = 0;
  const failing = new JsonRepository(repo.file, { beforeCommit: () => {
    calls++;
    assert.equal(readFileSync(repo.file, 'utf8'), bytes);
    const temps = readdirSync(directory).filter(name => name.endsWith('.tmp'));
    assert.equal(temps.length, 1);
    const staged = JSON.parse(readFileSync(join(directory, temps[0]), 'utf8'));
    assert.equal(staged.schema, 6);
    assert.equal(staged.editions.length, 2);
    assert.equal(staged.editionReviews.length, 1);
    assert.equal(staged.audit.length, 1);
    if (calls === 1) throw injected;
  } });
  const change = (value: State) => {
    value.editions.push(edition(1), edition(2)); value.editionReviews.push(review());
    value.audit.push({ id: 'fictional-audit', storyId: null, action: 'EDITION_REVIEW_RECORDED', actor: 'edition-service', at, version: null });
    return value.editions[1];
  };
  await assert.rejects(failing.transact(change), error => error === injected);
  assert.equal(await readFile(repo.file, 'utf8'), bytes);
  assert.deepEqual(await readdir(directory), ['fictional.json']);
  assert.deepEqual((await repo.read()).editions, []);
  assert.deepEqual((await repo.read()).editionReviews, []);
  assert.deepEqual((await repo.read()).audit, []);
  await failing.transact(change);
  const saved = await repo.read();
  assert.equal(calls, 2);
  assert.equal(saved.schema, 6);
  assert.equal(saved.editions.length, 2);
  assert.equal(saved.editionReviews.length, 1);
  assert.equal(saved.audit.length, 1);
  assert.deepEqual(await readdir(directory), ['fictional.json']);
}));

test('edition records reject invalid calendars, timezones, revisions, states and extra publication authority', async () => fixture(async (repo, directory) => {
  const valid = edition();
  const invalid: unknown[] = [
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity].map(revision => ({ ...valid, revision })),
    ...['2026-02-29', '2026-06-31', '2026-1-01', 'not-a-date'].map(date => ({ ...valid, date })),
    ...['', 'Not/A_Timezone', 'Mars/Olympus'].map(timezone => ({ ...valid, timezone })),
    { ...valid, createdAt: '2026-02-30T00:00:00Z' }, { ...valid, updatedAt: '2026-06-01' }, { ...valid, updatedAt: '2026-06-01T12:00:00+01:00' },
    { ...valid, status: 'PUBLISHED' }, { ...valid, status: 'APPROVED' }, { ...valid, published: true }, { ...valid, approval: { actor: 'invented' } }
  ];
  await rejected(repo, directory, invalid.map(withEdition));
  await writeFile(repo.file, JSON.stringify(withEdition({ ...valid, date: '2028-02-29', timezone: 'UTC' })));
  assert.equal((await repo.read()).editions.length, 1);
}));

test('edition sections and snapshots reject duplicates, misplaced prominence and malformed evidence or grants', async () => fixture(async (repo, directory) => {
  const valid = edition(), item = placement();
  const sectionsWith = (value: unknown) => valid.sections.map((section, index) => index === 0 ? { ...section, placements: [value] } : section);
  const invalidPlacements: unknown[] = [
    { ...item, storyVersion: 0 }, { ...item, headline: 'x'.repeat(513) }, { ...item, summary: 'x'.repeat(4097) }, { ...item, featured: 'true' },
    { ...item, independentSourceCount: 0 }, { ...item, independentSourceCount: 1 }, { ...item, approved: true }, { ...item, expiresAt: 'not-a-date' },
    { ...item, sources: [] }, { ...item, sources: [item.sources[0], item.sources[0]] }, { ...item, sources: item.sources.map(source => ({ ...source, policyVersion: 0 })) },
    { ...item, sources: item.sources.map(source => ({ ...source, url: 'https://user:secret@edition.example.test/' })) },
    { ...item, sources: item.sources.map(source => ({ ...source, url: 'file:///private' })) },
    { ...item, sources: item.sources.map(source => ({ ...source, publicRedistribution: true })) },
    { ...item, evidence: [] }, { ...item, evidence: [item.evidence[0], item.evidence[0]] },
    { ...item, evidence: [{ ...item.evidence[0], support: [] }] }, { ...item, evidence: [{ ...item.evidence[0], support: ['unknown-source'] }] },
    { ...item, evidence: [{ ...item.evidence[0], contradict: ['source-second', 'source-second'] }] },
    { ...item, evidence: [{ ...item.evidence[0], uncertainty: 'x'.repeat(2049) }] },
    { ...item, evidence: Array.from({ length: 17 }, (_, index) => ({ ...item.evidence[0], id: `evidence-${index}` })) },
    { ...item, sources: Array.from({ length: 65 }, (_, index) => ({ ...item.sources[0], sourceId: `source-${index}` })) }
  ];
  const invalid: unknown[] = invalidPlacements.map(value => ({ ...valid, sections: sectionsWith(value) }));
  invalid.push({ ...valid, sections: valid.sections.slice(1) }, { ...valid, sections: [...valid.sections].reverse() },
    { ...valid, sections: valid.sections.map((section, index) => index === 1 ? valid.sections[0] : section) },
    { ...valid, sections: valid.sections.map((section, index) => index === 1 ? { ...section, placements: [item] } : section) },
    { ...valid, sections: valid.sections.map((section, index) => index === 1 ? { ...section, placements: [{ ...item, storyId: 'other', featured: true }] } : section) },
    { ...valid, sections: valid.sections.map((section, index) => index === 0 ? { ...section, placements: [item, placement('other')] } : section) },
    { ...valid, suggestions: [{ ...valid.suggestions[0], code: 'APPROVED' }] },
    { ...valid, suggestions: [{ ...valid.suggestions[0], storyId: 'unplaced-story' }] });
  await rejected(repo, directory, invalid.map(withEdition));
}));

test('invalidated editions whitelist procedural fields and reject retained payload, linkage or reviewer identity', async () => fixture(async (repo, directory) => {
  const active = edition();
  const marker = { id: active.id, date: active.date, timezone: active.timezone, revision: active.revision, createdAt: active.createdAt, updatedAt: active.updatedAt, status: 'INVALIDATED', reason: 'STALE_OR_INELIGIBLE' };
  await writeFile(repo.file, JSON.stringify(withEdition(marker)));
  assert.deepEqual((await repo.read()).editions, [marker]);
  await repo.transact(() => undefined);
  assert.deepEqual((await repo.read()).editions, [marker]);
  const invalid: unknown[] = [
    { ...marker, reason: 'OTHER' }, { ...marker, sections: active.sections }, { ...marker, suggestions: active.suggestions },
    { ...marker, storyId: 'licensed-story' }, { ...marker, sourceIds: ['licensed-source'] }, { ...marker, actorAssertion: 'private-reviewer' },
    { ...marker, hiddenPayload: 'Fictional prose must not survive invalidation' }
  ];
  await rejected(repo, directory, invalid.map(withEdition));
}));

test('edition history rejects duplicate or descending revisions and review references without retained revisions', async () => fixture(async (repo, directory) => {
  const valid = state(), event = review();
  await rejected(repo, directory, [
    { ...valid, editions: [edition(1), edition(1)] }, { ...valid, editions: [edition(2), edition(1)] },
    { ...valid, editionReviews: [{ ...event, editionId: 'missing-edition' }] }, { ...valid, editionReviews: [{ ...event, toRevision: 3 }] },
    { ...valid, editionReviews: [{ ...event, fromRevision: 2, toRevision: 1 }] }, { ...valid, editionReviews: [{ ...event, toRevision: 1 }] },
    { ...valid, editionReviews: [{ ...event, unauthenticated: false }] }, { ...valid, editionReviews: [{ ...event, authenticated: true }] },
    { ...valid, editionReviews: [{ ...event, toState: 'PUBLISHED' }] }, { ...valid, editionReviews: [{ ...event, at: '2026-02-30T00:00:00Z' }] }
  ]);
  // Retention invalidates historical snapshots in place, preserving their review transitions.
  const redacted = valid.editions.map(row => ({ id: row.id, date: row.date, timezone: row.timezone, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt, status: 'INVALIDATED', reason: 'STALE_OR_INELIGIBLE' }));
  await writeFile(repo.file, JSON.stringify({ ...valid, editions: redacted, editionReviews: [{ ...event, actorAssertion: '[invalidated]' }] }));
  assert.equal((await repo.read()).editionReviews[0].toState, 'NEEDS_REVIEW');
}));
