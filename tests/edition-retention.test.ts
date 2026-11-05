import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invalidateEditions } from '../src/editions/lifecycle.ts';
import { buildPlacement } from '../src/editions/eligibility.ts';
import { sectionIds, type ActiveEdition } from '../src/editions/types.ts';
import { cleanupRetention } from '../src/ingestion/retention.ts';
import { managed } from '../src/ingestion/metadata.ts';
import { getPolicy } from '../src/ingestion/policies.ts';
import { canonicalURL, emptyState, type State } from '../src/newsroom/model.ts';
import { Newsroom } from '../src/newsroom/service.ts';
import { JsonRepository } from '../src/newsroom/store.ts';

const at = '2026-01-01T12:00:00.000Z';
const retrievedAt = '2026-01-01T00:00:00.000Z';
const expiry = '2026-01-02T00:00:00.000Z';

function fixture(): State {
  const state = emptyState(), policy = getPolicy('fictional-fixture', 'fictional-ai-editorial-v1', at);
  for (const name of ['support', 'counter']) {
    const article = { providerId: 'fictional-fixture', url: `https://fiction.example.test/edition-${name}`,
      publisher: `Fictional ${name}`, publishedAt: retrievedAt, retrievedAt, provenance: { type: 'ORIGINAL' as const, originId: null } };
    const record = managed(article, policy, at);
    state.managedSources.push(record);
    state.sources.push({ id: record.sourceId, url: article.url, canonicalUrl: canonicalURL(article.url), publisher: article.publisher,
      publishedAt: article.publishedAt, retrievedAt, type: 'ORIGINAL', originId: record.sourceId, rights: JSON.stringify(policy), verification: 'VERIFIED' });
    state.provenanceDecisions.push({ id: `decision-${name}`, sourceId: record.sourceId, classification: 'ORIGINAL', originId: null,
      actorAssertion: 'fixture provenance assertion', at, evidenceReferences: ['fictional-fixture-evidence'], reason: 'fixture provenance' });
  }
  state.revisions.push({ id: 'fictional-story', headline: 'A fictional council adopted the proposal.', topic: 'fixture',
    summary: 'A fictional council adopted the proposal.', geography: 'Fictional Town', eventAt: null, firstSeenAt: at, updatedAt: at,
    clusterId: 'fictional-cluster', sourceIds: state.sources.map(source => source.id), status: 'APPROVED', version: 5,
    evidence: [{ id: 'fictional-evidence', claim: 'A fictional council adopted the proposal.', support: [state.sources[0].id],
      contradict: [state.sources[1].id], verification: 'VERIFIED', uncertainty: 'The fictional timetable is not confirmed.',
      reviewerDecisions: ['fixture assertion'] }] });
  state.approvals.push({ storyId: 'fictional-story', version: 5, reviewer: 'fixture story reviewer', at });
  return state;
}

function edition(state: State, changes: Partial<ActiveEdition> = {}): ActiveEdition {
  return { id: 'edition-fixture', date: '2026-01-01', timezone: 'UTC', revision: 1, createdAt: at, updatedAt: at,
    status: 'ASSEMBLING', sections: sectionIds.map(id => ({ id,
      placements: id === 'TOP_STORIES' ? [buildPlacement(state, 'fictional-story', 5, true, at)] : [] })),
    suggestions: [], ...changes };
}

function historical(state: State): void {
  const first = edition(state);
  state.editions.push(first, { ...structuredClone(first), revision: 2, status: 'NEEDS_REVIEW' });
  state.editionReviews.push({ editionId: first.id, fromRevision: 1, toRevision: 2, fromState: 'ASSEMBLING',
    toState: 'NEEDS_REVIEW', actorAssertion: 'FICTIONAL_PRIVATE_REVIEWER', unauthenticated: true, at });
}

async function repositoryFixture(run: (repository: JsonRepository) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dayline-edition-retention-'));
  try { await run(new JsonRepository(join(dir, 'fictional.json'))); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('current licensed snapshots remain unchanged across every historical edition revision', () => {
  const state = fixture(); historical(state);
  const before = structuredClone(state);
  assert.equal(invalidateEditions(state, at), 0);
  assert.deepEqual(state, before);
});

test('a newer story version invalidates every copied historical edition snapshot', () => {
  const state = fixture(); historical(state);
  state.revisions.push({ ...state.revisions[0], version: 6 });
  assert.equal(invalidateEditions(state, at), 2);
  for (const entry of state.editions) {
    assert.equal(entry.status, 'INVALIDATED');
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'date', 'timezone', 'revision', 'createdAt', 'updatedAt', 'status', 'reason'].sort());
  }
  assert.deepEqual(state.editions.map(entry => entry.revision), [1, 2]);
  assert.doesNotMatch(JSON.stringify({ editions: state.editions, reviews: state.editionReviews }), /fictional-story|url-|fiction\.example|council|timetable|FICTIONAL_PRIVATE/);
  assert.equal(state.audit.length, 2);
  assert.ok(state.audit.every(event => event.storyId === null && event.action === 'EDITION_INVALIDATED' && !event.subjectId));
});

test('same-version copied content, source attributes and captured deadlines cannot drift', () => {
  for (const change of [
    (state: State) => { state.revisions[0].headline = 'A fictional council revised the proposal.'; },
    (state: State) => { state.revisions[0].summary = 'A fictional council revised the proposal.'; },
    (state: State) => { state.revisions[0].evidence[0].uncertainty = 'The fictional schedule remains unknown.'; },
    (state: State) => { state.sources[0].publisher = 'Altered fictional publisher'; },
    (state: State) => { state.managedSources[0].deleteAt = '2026-01-01T18:00:00Z'; },
  ]) {
    const state = fixture(); state.editions.push(edition(state)); change(state);
    assert.equal(invalidateEditions(state, at), 1);
  }
  const captured = fixture(), snapshot = edition(captured);
  snapshot.sections[0].placements[0].expiresAt = '2026-01-01T18:00:00Z';
  captured.editions.push(snapshot);
  assert.equal(invalidateEditions(captured, at), 1);
});

test('expiry, revoked rights, quarantine, global hold and redaction invalidate edition payloads', () => {
  const expired = fixture(); historical(expired);
  assert.equal(invalidateEditions(expired, expiry), 2);
  for (const change of [
    (state: State) => { const policy = state.managedSources[0].policy; policy.id = 'fictional-ai-revoked-v1'; policy.evidenceReference = 'fictional-fixture-only:fictional-ai-revoked-v1'; },
    (state: State) => { state.quarantine.push({ ...state.managedSources[0], metadata: { ...state.managedSources[0].providerMetadata } }); },
    (state: State) => { state.retentionReviewRequired = true; },
    (state: State) => { state.revisions[0].retentionRedacted = true; },
    (state: State) => { state.revisions[0].status = 'ON_HOLD'; },
  ]) {
    const state = fixture(); historical(state); change(state);
    assert.equal(invalidateEditions(state, at), 2);
    assert.ok(state.editions.every(entry => entry.status === 'INVALIDATED'));
  }
});

test('rejected and held historical snapshots also lose their copied payload after expiry', () => {
  const state = fixture();
  for (const status of ['ASSEMBLING', 'NEEDS_REVIEW', 'READY_FOR_APPROVAL', 'REVISION_REQUESTED', 'ON_HOLD', 'REJECTED'] as const) {
    state.editions.push(edition(state, { id: `edition-${status}`, status }));
  }
  assert.equal(invalidateEditions(state, expiry), 6);
  assert.ok(state.editions.every(entry => entry.status === 'INVALIDATED'));
});

test('global retention hold invalidates even editions that have no placements', () => {
  const state = fixture(); state.editions.push(edition(state, { sections: sectionIds.map(id => ({ id, placements: [] })) }));
  assert.equal(invalidateEditions(state, at), 0);
  state.retentionReviewRequired = true;
  assert.equal(invalidateEditions(state, at), 1);
  assert.equal(state.editions[0].status, 'INVALIDATED');
});

test('edition review invalidation uses a strict whitelist and repeated runs preserve minimal histories', () => {
  const state = fixture(); historical(state);
  Object.assign(state.editions[0], { hiddenCopiedText: 'FICTIONAL_PRIVATE_PAYLOAD' });
  Object.assign(state.editionReviews[0], { hiddenReviewerNote: 'FICTIONAL_PRIVATE_PAYLOAD' });
  state.editionReviews[0].at = 'FICTIONAL_PRIVATE_INVALID_DATE';
  state.retentionReviewRequired = true;
  assert.equal(invalidateEditions(state, at), 2);
  assert.deepEqual(state.editionReviews, [{ editionId: 'edition-fixture', fromRevision: 1, toRevision: 2,
    fromState: 'ASSEMBLING', toState: 'NEEDS_REVIEW', actorAssertion: '[invalidated]', unauthenticated: true, at }]);
  assert.doesNotMatch(JSON.stringify({ editions: state.editions, reviews: state.editionReviews, audit: state.audit }), /FICTIONAL_PRIVATE|url-|fiction\.example/);
  const before = structuredClone(state);
  assert.equal(invalidateEditions(state, at), 0); assert.deepEqual(state, before);
});

test('invalidated base and review timestamps cannot retain future dates or block a valid cleanup', () => {
  const state = fixture(); historical(state);
  state.editions[0].createdAt = '2026-01-03T00:00:00Z';
  state.editionReviews[0].at = '2026-01-03T00:00:00Z';
  state.retentionReviewRequired = true;
  assert.equal(invalidateEditions(state, at), 2);
  assert.equal(state.editions[0].createdAt, at);
  assert.equal(state.editions[0].updatedAt, at);
  assert.equal(state.editionReviews[0].at, at);
});

test('unrelated safe edition revisions and their review assertions remain exact', () => {
  const state = fixture();
  state.revisions.push({ ...structuredClone(state.revisions[0]), id: 'unrelated-story' });
  state.approvals.push({ storyId: 'unrelated-story', version: 5, reviewer: 'unrelated fixture reviewer', at });
  state.editions.push(edition(state));
  const unrelated = edition(state, { id: 'unrelated-edition', sections: sectionIds.map(id => ({ id,
    placements: id === 'US' ? [buildPlacement(state, 'unrelated-story', 5, false, at)] : [] })) });
  const review = { editionId: unrelated.id, fromRevision: 1, toRevision: 2, fromState: 'ASSEMBLING' as const,
    toState: 'NEEDS_REVIEW' as const, actorAssertion: 'unrelated assertion', unauthenticated: true as const, at };
  state.editions.push(unrelated); state.editionReviews.push(review);
  const before = structuredClone({ unrelated, review });
  state.revisions.push({ ...state.revisions[0], version: 6 });
  assert.equal(invalidateEditions(state, at), 1);
  assert.deepEqual(state.editions[1], before.unrelated); assert.deepEqual(state.editionReviews[0], before.review);
});

test('story edits invalidate every edition revision within the same repository transaction', async () => {
  await repositoryFixture(async repository => {
    const state = fixture(); historical(state);
    await repository.transact(stored => { Object.assign(stored, state); });
    await new Newsroom(repository, { clock: () => at }).edit('fictional-story', { summary: 'A revised fictional summary.' }, 'fixture editor');
    const snapshot = await repository.read();
    assert.equal(snapshot.revisions.at(-1)?.version, 6);
    assert.ok(snapshot.editions.every(entry => entry.status === 'INVALIDATED'));
  });
});

test('story transitions invalidate edition snapshots atomically without approving the edition', async () => {
  await repositoryFixture(async repository => {
    const state = fixture(); historical(state);
    await repository.transact(stored => { Object.assign(stored, state); });
    await new Newsroom(repository, { clock: () => at }).transition('fictional-story', 'DRAFT', 'fixture editor');
    const snapshot = await repository.read();
    assert.equal(snapshot.revisions.at(-1)?.status, 'DRAFT');
    assert.ok(snapshot.editions.every(entry => entry.status === 'INVALIDATED'));
    assert.equal(snapshot.approvals.length, 1);
  });
});

test('newsroom writes use one injected clock reading per transaction for revisions, approvals and audit', async () => {
  await repositoryFixture(async repository => {
    const state = fixture();
    await repository.transact(stored => { Object.assign(stored, state); });
    let calls = 0;
    const newsroom = new Newsroom(repository, { clock: () => { calls++; return at; } });
    await newsroom.ingest({ id: 'legacy-clock-fixture', publisher: 'Fictional clock fixture', url: 'https://fiction.example.test/clock',
      type: 'ORIGINAL', publishedAt: retrievedAt, retrievedAt, originId: 'legacy-clock-fixture', rights: 'fictional test fixture only', verification: 'UNVERIFIED' }, 'fixture');
    const { status: _status, version: _version, ...input } = state.revisions[0];
    await newsroom.create({ ...input, id: 'clock-story' }, 'fixture');
    for (const status of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW', 'APPROVED'] as const) await newsroom.transition('clock-story', status, 'fixture');
    await newsroom.edit('clock-story', { summary: 'A revised fictional clock summary.' }, 'fixture');
    const snapshot = await repository.read();
    assert.equal(calls, 7);
    assert.ok(snapshot.revisions.filter(story => story.id === 'clock-story').every(story => story.updatedAt === at));
    assert.ok(snapshot.approvals.filter(approval => approval.storyId === 'clock-story').every(approval => approval.at === at));
    assert.ok(snapshot.audit.every(event => event.at === at));
  });
});

test('retention cleanup removes copied edition prose, source URLs, uncertainty and reviewer identity from all versions', async () => {
  await repositoryFixture(async repository => {
    const state = fixture(); historical(state);
    await repository.transact(stored => { Object.assign(stored, state); });
    const before = await readFile(repository.file, 'utf8');
    await cleanupRetention(repository, expiry);
    assert.equal(await readFile(repository.file, 'utf8'), before);
    await cleanupRetention(repository, expiry, false);
    const snapshot = await new Newsroom(repository).snapshot();
    assert.equal(snapshot.editions.length, 2);
    assert.ok(snapshot.editions.every(entry => entry.status === 'INVALIDATED'));
    assert.equal(snapshot.sources.length, 0); assert.equal(snapshot.managedSources.length, 0);
    assert.doesNotMatch(JSON.stringify(snapshot), /fiction\.example|council|timetable|FICTIONAL_PRIVATE_REVIEWER|fictional-story/);
    const cleaned = structuredClone(snapshot);
    await cleanupRetention(repository, expiry, false);
    assert.deepEqual(await repository.read(), cleaned);
  });
});

test('failed cleanup preserves source metadata and every edition snapshot until a complete retry', async () => {
  await repositoryFixture(async repository => {
    const state = fixture(); historical(state);
    await repository.transact(stored => { Object.assign(stored, state); });
    const before = await readFile(repository.file, 'utf8');
    const failing = new JsonRepository(repository.file, { beforeCommit: () => { throw Error('injected edition cleanup failure'); } });
    await assert.rejects(cleanupRetention(failing, expiry, false), /injected edition cleanup failure/);
    assert.equal(await readFile(repository.file, 'utf8'), before);
    await cleanupRetention(repository, expiry, false);
    assert.ok((await repository.read()).editions.every(entry => entry.status === 'INVALIDATED'));
  });
});

test('malformed edition-validation clocks cannot partially mutate snapshots or audit', () => {
  const state = fixture(); historical(state);
  const before = structuredClone(state);
  assert.throws(() => invalidateEditions(state, '2026-02-30T00:00:00Z'));
  assert.deepEqual(state, before);
});
