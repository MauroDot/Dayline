import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactEditorialHistory } from '../src/ingestion/history.ts';
import { cleanupRetention } from '../src/ingestion/retention.ts';
import { emptyState, type State, type Story } from '../src/newsroom/model.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { Newsroom } from '../src/newsroom/service.ts';

const at = '2026-01-02T00:00:00.000Z';
const earlier = '2026-01-01T00:00:00.000Z';
const sourceId = 'FICTIONAL_PROHIBITED_SOURCE_REFERENCE';
const oldStoryId = 'FICTIONAL_PROHIBITED_STORY_ID';

function story(changes: Partial<Story> = {}): Story {
  return { id: oldStoryId, headline: 'FICTIONAL_PROHIBITED_TITLE', topic: 'FICTIONAL_PROHIBITED_TOPIC',
    summary: 'FICTIONAL_PROHIBITED_SUMMARY https://fiction.example.test/prohibited', geography: 'FICTIONAL_PROHIBITED_GEO',
    eventAt: earlier, firstSeenAt: earlier, updatedAt: earlier, clusterId: 'FICTIONAL_PROHIBITED_CLUSTER',
    evidence: [{ id: 'FICTIONAL_PROHIBITED_EVIDENCE', claim: 'FICTIONAL_PROHIBITED_CLAIM', support: [sourceId], contradict: [],
      verification: 'VERIFIED', uncertainty: 'FICTIONAL_PROHIBITED_UNCERTAINTY', reviewerDecisions: ['FICTIONAL_PROHIBITED_REVIEWER_NOTE'] }],
    sourceIds: [sourceId], status: 'DRAFT', version: 1, ...changes };
}

function historicalState(): State {
  const state = emptyState();
  state.revisions = ['DRAFT', 'NEEDS_REVIEW', 'APPROVED', 'PUBLISHED', 'CORRECTION_REQUIRED'].map((status, index) => {
    const revision = story({ status: status as Story['status'], version: index + 1,
      ...(index ? { sourceIds: [], evidence: [] } : {}) });
    return Object.assign(revision, { hiddenProviderText: 'FICTIONAL_PROHIBITED_HIDDEN_FIELD' });
  });
  state.approvals = [Object.assign({ storyId: oldStoryId, version: 3, reviewer: 'FICTIONAL_PROHIBITED_REVIEWER', at: earlier },
    { hiddenApprovalText: 'FICTIONAL_PROHIBITED_APPROVAL_FIELD' })];
  state.audit = [Object.assign({ id: 'FICTIONAL_PROHIBITED_AUDIT_ID', storyId: oldStoryId, action: 'STATUS_APPROVED',
    actor: 'FICTIONAL_PROHIBITED_ACTOR', at: earlier, version: 3, subjectId: sourceId },
  { hiddenAuditText: 'FICTIONAL_PROHIBITED_AUDIT_FIELD' })];
  return state;
}

async function fixture(run: (repository: JsonRepository) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dayline-history-retention-'));
  try { await run(new JsonRepository(join(dir, 'fictional.json'))); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('editorial retention redacts all copied versions and keeps only opaque procedural history', () => {
  const state = historicalState();
  assert.equal(redactEditorialHistory(state, new Set([sourceId]), at), 1);
  assert.deepEqual(state.revisions.map(revision => revision.status), ['DRAFT', 'NEEDS_REVIEW', 'APPROVED', 'PUBLISHED', 'CORRECTION_REQUIRED']);
  assert.deepEqual(state.revisions.map(revision => revision.version), [1, 2, 3, 4, 5]);
  const replacement = state.revisions[0].id;
  assert.match(replacement, /^retention-[0-9a-f-]{36}$/);
  assert.notEqual(replacement, oldStoryId);
  for (const revision of state.revisions) {
    assert.equal(revision.id, replacement); assert.equal(revision.retentionRedacted, true);
    assert.equal(revision.headline, '[retention redacted]'); assert.equal(revision.summary, '[retention redacted]');
    assert.deepEqual(revision.sourceIds, []); assert.deepEqual(revision.evidence, []);
    assert.equal(revision.eventAt, null); assert.equal(revision.clusterId, null);
    assert.equal(revision.firstSeenAt, at); assert.equal(revision.updatedAt, at);
    assert.deepEqual(Object.keys(revision).sort(), ['id', 'headline', 'topic', 'summary', 'geography', 'eventAt', 'firstSeenAt',
      'updatedAt', 'clusterId', 'evidence', 'sourceIds', 'status', 'version', 'retentionRedacted'].sort());
  }
  assert.deepEqual(state.approvals, [{ storyId: replacement, version: 3, reviewer: '[retention redacted]', at: earlier, retentionRedacted: true }]);
  assert.equal(state.audit[0].storyId, replacement); assert.equal(state.audit[0].version, 3);
  assert.equal(state.audit[0].action, 'STATUS_APPROVED'); assert.equal(state.audit[0].actor, '[retention redacted]');
  assert.equal(state.audit[0].subjectId, undefined);
  assert.doesNotMatch(JSON.stringify(state), /FICTIONAL_PROHIBITED|fiction\.example/);
});

test('support and contradict links identify affected history even without story sourceIds', () => {
  for (const reference of ['support', 'contradict'] as const) {
    const state = historicalState();
    state.revisions = [story({ sourceIds: [], evidence: [{ id: 'claim', claim: 'fictional', support: [], contradict: [],
      verification: 'UNVERIFIED', uncertainty: '', reviewerDecisions: [], [reference]: [sourceId] }] })];
    assert.equal(redactEditorialHistory(state, new Set([sourceId]), at), 1);
    assert.deepEqual(state.revisions[0].evidence, []);
    assert.doesNotMatch(JSON.stringify(state), /FICTIONAL_PROHIBITED/);
  }
});

test('editorial retention preserves unrelated revisions, approval assertions and audit exactly', () => {
  const state = historicalState();
  const unrelated = story({ id: 'unrelated-story', headline: 'Unrelated fictional title', summary: 'Unrelated summary',
    topic: 'fixture', geography: 'fixture', clusterId: 'unrelated-cluster', sourceIds: ['unrelated-source'], evidence: [] });
  const approval = { storyId: unrelated.id, version: 1, reviewer: 'Unrelated reviewer', at: earlier };
  const audit = { id: 'unrelated-audit', storyId: unrelated.id, action: 'STORY_CREATED', actor: 'Unrelated actor',
    at: earlier, version: 1, subjectId: 'unrelated-source' };
  state.revisions.push(unrelated); state.approvals.push(approval); state.audit.push(audit);
  const before = structuredClone({ unrelated, approval, audit });
  assert.equal(redactEditorialHistory(state, new Set([sourceId]), at), 1);
  assert.deepEqual(state.revisions.at(-1), before.unrelated);
  assert.deepEqual(state.approvals.at(-1), before.approval);
  assert.deepEqual(state.audit.at(-1), before.audit);
});

test('editorial audit stubs use an exact action allowlist and safe timestamps', () => {
  const state = historicalState();
  state.approvals[0].at = 'FICTIONAL_PROHIBITED_INVALID_DATE';
  state.audit.push({ id: 'second', storyId: oldStoryId, action: 'STATUS_APPROVED_FICTIONAL_PROHIBITED',
    actor: 'FICTIONAL_PROHIBITED_ACTOR', at: 'invalid date', version: null });
  assert.equal(redactEditorialHistory(state, new Set([sourceId]), at), 1);
  assert.equal(state.approvals[0].at, at);
  assert.equal(state.audit[0].at, earlier);
  assert.equal(state.audit[1].at, at);
  assert.equal(state.audit[1].action, 'EDITORIAL_EVENT_REDACTED');
  assert.equal(state.audit[1].version, null);
  assert.notEqual(state.audit[0].id, state.audit[1].id);
  assert.doesNotMatch(JSON.stringify(state), /FICTIONAL_PROHIBITED/);
});

test('editorial retention is idempotent and never persists an old-to-new identity map', () => {
  const state = historicalState();
  assert.equal(redactEditorialHistory(state, new Set([sourceId]), at), 1);
  const before = structuredClone(state);
  assert.equal(redactEditorialHistory(state, new Set([sourceId]), at), 0);
  assert.deepEqual(state, before);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(`${sourceId}|${oldStoryId}`));
});

test('separate affected histories receive separate random internal identities', () => {
  const state = historicalState();
  state.revisions.push(story({ id: 'FICTIONAL_PROHIBITED_OTHER_STORY' }));
  assert.equal(redactEditorialHistory(state, new Set([sourceId]), at), 2);
  const identities = new Set(state.revisions.map(revision => revision.id));
  assert.equal(identities.size, 2);
  assert.ok([...identities].every(identity => /^retention-[0-9a-f-]{36}$/.test(identity)));
});

test('invalid cleanup timestamps cannot partially redact editorial history', () => {
  const state = historicalState(), before = structuredClone(state);
  assert.throws(() => redactEditorialHistory(state, new Set([sourceId]), '2026-02-30T00:00:00Z'), /timestamp/);
  assert.deepEqual(state, before);
});

test('redaction transaction failure preserves all original histories and a retry commits stubs together', async () => {
  await fixture(async repository => {
    await repository.transact(state => { Object.assign(state, historicalState()); });
    const before = await readFile(repository.file, 'utf8');
    const failing = new JsonRepository(repository.file, { beforeCommit: () => { throw Error('injected history commit failure'); } });
    await assert.rejects(failing.transact(state => redactEditorialHistory(state, new Set([sourceId]), at)), /injected history commit failure/);
    assert.equal(await readFile(repository.file, 'utf8'), before);
    assert.equal(await repository.transact(state => redactEditorialHistory(state, new Set([sourceId]), at)), 1);
    const snapshot = await new Newsroom(repository).snapshot();
    assert.doesNotMatch(JSON.stringify(snapshot), /FICTIONAL_PROHIBITED|fiction\.example/);
    assert.deepEqual(snapshot.revisions.map(revision => revision.version), [1, 2, 3, 4, 5]);
    assert.equal(snapshot.approvals.length, 1);
  });
});

test('cleanup redacts histories with already missing sources even when no managed metadata remains', async () => {
  await fixture(async repository => {
    await repository.transact(state => { Object.assign(state, historicalState()); });
    await cleanupRetention(repository, at, false);
    const snapshot = await new Newsroom(repository).snapshot();
    assert.doesNotMatch(JSON.stringify(snapshot), /FICTIONAL_PROHIBITED|fiction\.example/);
    assert.deepEqual(snapshot.revisions.map(revision => revision.status), ['DRAFT', 'NEEDS_REVIEW', 'APPROVED', 'PUBLISHED', 'CORRECTION_REQUIRED']);
    assert.equal(snapshot.approvals.length, 1);
    const before = await repository.read();
    await cleanupRetention(repository, at, false);
    assert.deepEqual(await repository.read(), before);
  });
});
