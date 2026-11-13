import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyState, type State } from '../src/newsroom/model.ts';
import { managed, metadata } from '../src/ingestion/metadata.ts';
import { getPolicy } from '../src/ingestion/policies.ts';
import { resolveDecision } from '../src/ingestion/provenance.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import { projectSourceQueue, sourceCandidateIds, sourceQueueValidUntil, SourceQueueError, type SourceQueueScope } from '../src/source-queue/service.ts';
import type { SourceQueueQuery } from '../src/source-queue/types.ts';

const at = '2026-06-01T12:00:00.000Z';
const authorizationContext = 'a'.repeat(64);
const privateValue = 'FICTIONAL_PRIVATE_SCOPE_SENTINEL';
const ref = (id: string) => `candidate-${createHash('sha256').update(id).digest('hex')}`;
const scope = (...sourceIds: string[]): SourceQueueScope => ({ sourceIds, authorizationContext });
const errorCode = (expected: SourceQueueError['code']) => (error: unknown) => error instanceof SourceQueueError
  && error.code === expected && error.message === expected;

function append(state: State, name: string, provenance: ProviderArticle['provenance'] = { type: 'ORIGINAL', originId: null }): string {
  const article: ProviderArticle = { providerId: 'fictional-fixture', publisher: `Fictional ${name}`,
    url: `https://scoped-queue.example.test/${name}`, publishedAt: at, retrievedAt: at, provenance };
  const record = managed(metadata(article, article.providerId), getPolicy(article.providerId, 'fictional-metadata-v1', at), at);
  const result = resolveDecision(state, record, { sourceId: record.sourceId, classification: provenance.type, originId: provenance.originId,
    actorAssertion: 'fictional-private-reviewer', reason: 'Fictional scope test only', evidenceReferences: ['fictional-private-evidence'], at }, at);
  if (result.source) { state.managedSources.push(record); state.sources.push(result.source); }
  else state.quarantine.push({ ...record, metadata: structuredClone(record.providerMetadata) });
  state.provenanceDecisions.push(result.decision);
  return record.sourceId;
}

function twoVisible(): { state: State; ids: string[]; access: SourceQueueScope; cursor: string } {
  const state = emptyState(), ids = [append(state, 'visible-one'), append(state, 'visible-two')];
  const access = scope(...ids);
  const cursor = projectSourceQueue(state, at, { limit: 1 }, access).nextCursor!;
  assert.ok(cursor);
  return { state, ids, access, cursor };
}

test('candidate identities combine existing records exactly once without exposing projected metadata', () => {
  const state = emptyState();
  const original = append(state, 'original');
  const quarantined = append(state, 'unknown', { type: 'UNKNOWN', originId: null });
  state.deletions.push({ sourceId: original, at, expiresAt: '2026-06-02T12:00:00.000Z', reason: privateValue },
    { sourceId: 'fictional-deleted-only', at, expiresAt: '2026-06-02T12:00:00.000Z', reason: privateValue });
  const before = structuredClone(state);
  assert.deepEqual(sourceCandidateIds(state), [original, quarantined, 'fictional-deleted-only'].sort());
  assert.deepEqual(state, before);
  assert.doesNotMatch(JSON.stringify(sourceCandidateIds(state)), /Fictional |PRIVATE|publisher|reason/);
});

test('mixed assignments paginate only the deterministic authorized view and expose no hidden counts', () => {
  const state = emptyState();
  const ids = Array.from({ length: 27 }, (_, index) => append(state, `candidate-${index}`));
  const allowed = ids.filter((_id, index) => index % 3 === 0), access = scope(...allowed);
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = projectSourceQueue(state, at, { limit: 2, ...(cursor ? { cursor } : {}) }, access);
    assert.deepEqual(Object.keys(page).sort(), ['entries', 'nextCursor', 'view', 'limit', 'retentionReviewRequired'].sort());
    assert.ok(page.entries.length <= 2);
    assert.ok(page.entries.every(entry => allowed.some(id => ref(id) === entry.candidateRef)));
    seen.push(...page.entries.map(entry => entry.candidateRef));
    if (page.nextCursor) {
      const decoded = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8'));
      assert.deepEqual(Object.keys(decoded).sort(), ['fingerprint', 'offset']);
      assert.equal(decoded.offset, seen.length);
      assert.match(decoded.fingerprint, /^[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(decoded), /candidate-|url-|publisher|sourceId/);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(seen, allowed.map(ref).sort());
  assert.equal(new Set(seen).size, allowed.length);
  const onlyOne = projectSourceQueue(state, at, { limit: 1 }, scope(ids[0]));
  assert.equal(onlyOne.entries.length, 1);
  assert.equal(onlyOne.nextCursor, null);
  assert.deepEqual(projectSourceQueue(state, at, undefined, scope()).entries, []);
});

test('visibility precedes every view filter and never fills a page with inaccessible candidates', () => {
  const state = emptyState();
  const original = append(state, 'assigned-original');
  const unknown = append(state, 'assigned-unknown', { type: 'UNKNOWN', originId: null });
  append(state, 'hidden-original');
  append(state, 'hidden-disputed', { type: 'DISPUTED', originId: null });
  const access = scope(original, unknown);
  for (const [view, expected] of [['RECENT', [original, unknown]], ['ELIGIBLE', [original]], ['UNRESOLVED', [unknown]],
    ['BLOCKED', [unknown]], ['RELATED', []], ['WITHDRAWN', []]] as const) {
    const page = projectSourceQueue(state, at, { view, limit: 50 }, access);
    assert.deepEqual(page.entries.map(entry => entry.candidateRef).sort(), expected.map(ref).sort());
    assert.equal(page.nextCursor, null);
    assert.doesNotMatch(JSON.stringify(page), /hidden-original|hidden-disputed|Fictional hidden/);
  }
});

test('syndicated metadata cannot reveal an inaccessible origin or enter RELATED through its reference', () => {
  const state = emptyState(), origin = append(state, 'private-origin');
  const copy = append(state, 'assigned-copy', { type: 'SYNDICATED', originId: origin });
  const page = projectSourceQueue(state, at, undefined, scope(copy));
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].candidateRef, ref(copy));
  assert.equal(page.entries[0].sourceEligible, true);
  assert.equal(page.entries[0].relationship, null);
  assert.equal(page.nextCursor, null);
  assert.doesNotMatch(JSON.stringify(page), new RegExp(`${origin}|${ref(origin)}|private-origin`));
  assert.deepEqual(projectSourceQueue(state, at, { view: 'RELATED' }, scope(copy)).entries, []);
  const related = projectSourceQueue(state, at, { view: 'RELATED' }, scope(copy, origin));
  assert.deepEqual(related.entries[0].relationship, { kind: 'SYNDICATED', originRef: ref(origin) });
});

test('unrelated inaccessible source changes and new hidden candidates leave scoped cursors unchanged', () => {
  const { state, access, cursor } = twoVisible();
  const hidden = append(state, 'hidden-before');
  const expected = projectSourceQueue(state, at, { limit: 1, cursor }, access);
  const hiddenSource = state.sources.find(row => row.id === hidden)!;
  const hiddenRecord = state.managedSources.find(row => row.sourceId === hidden)!;
  hiddenSource.publisher = hiddenRecord.providerMetadata.publisher = 'Fictional changed inaccessible publisher';
  hiddenSource.verification = 'VERIFIED';
  hiddenRecord.policy = getPolicy('fictional-fixture', 'fictional-metadata-v2', at);
  hiddenSource.rights = JSON.stringify(hiddenRecord.policy);
  append(state, 'hidden-after');
  assert.deepEqual(projectSourceQueue(state, at, { limit: 1, cursor }, access), expected);
});

test('an authoritative source change invalidates its cursor even when metadata is identical', () => {
  const { state, access, cursor } = twoVisible();
  const before = projectSourceQueue(state, at, { limit: 50 }, access).entries;
  state.sources[0].verification = 'VERIFIED';
  assert.deepEqual(projectSourceQueue(state, at, { limit: 50 }, access).entries, before);
  assert.throws(() => projectSourceQueue(state, at, { limit: 1, cursor }, access), errorCode('STALE_CURSOR'));
});

test('captured rights changes invalidate scoped cursors without requiring visible metadata changes', () => {
  const { state, access, cursor } = twoVisible();
  const before = projectSourceQueue(state, at, { limit: 50 }, access).entries;
  state.managedSources[0].policy = getPolicy('fictional-fixture', 'fictional-metadata-v2', at);
  state.sources[0].rights = JSON.stringify(state.managedSources[0].policy);
  assert.deepEqual(projectSourceQueue(state, at, { limit: 50 }, access).entries, before);
  assert.throws(() => projectSourceQueue(state, at, { limit: 1, cursor }, access), errorCode('STALE_CURSOR'));
});

test('a more restrictive retained deadline invalidates the cursor before it expires', () => {
  const { state, access, cursor } = twoVisible();
  const before = projectSourceQueue(state, at, { limit: 50 }, access).entries;
  state.managedSources[0].deleteAt = '2026-06-01T13:00:00.000Z';
  assert.deepEqual(projectSourceQueue(state, at, { limit: 50 }, access).entries, before);
  assert.throws(() => projectSourceQueue(state, at, { limit: 1, cursor }, access), errorCode('STALE_CURSOR'));
});

test('private provider additions, reviewer assertions and audit values affect neither metadata nor cursors', () => {
  const { state, access, cursor } = twoVisible();
  const expected = projectSourceQueue(state, at, { limit: 1, cursor }, access);
  Object.assign(state.managedSources[0], { rawProviderPayload: { licensedBody: privateValue }, credential: privateValue });
  Object.assign(state.managedSources[0].providerMetadata, { body: privateValue, token: privateValue });
  Object.assign(state.managedSources[0].policy, { privateContract: privateValue });
  Object.assign(state.sources[0], { privateNotes: privateValue });
  state.sources[0].rights = JSON.stringify({ ...JSON.parse(state.sources[0].rights), privateContract: privateValue });
  state.provenanceDecisions[0].actorAssertion = privateValue;
  state.provenanceDecisions[0].reason = privateValue;
  state.provenanceDecisions[0].evidenceReferences = [privateValue];
  state.audit.push({ id: 'fictional-private-audit', storyId: null, action: 'FICTIONAL', actor: privateValue, at, version: null });
  const actual = projectSourceQueue(state, at, { limit: 1, cursor }, access);
  assert.deepEqual(actual, expected);
  assert.doesNotMatch(JSON.stringify(actual), /PRIVATE|rawProviderPayload|licensedBody|credential|actorAssertion|privateContract/);
});

test('cursor contexts cannot cross sessions, assignment revisions, authorized sets or unscoped reads', () => {
  const { state, ids, access, cursor } = twoVisible();
  for (const context of ['b'.repeat(64), 'c'.repeat(64)]) {
    assert.throws(() => projectSourceQueue(state, at, { limit: 1, cursor }, { ...access, authorizationContext: context }), errorCode('STALE_CURSOR'));
  }
  append(state, 'newly-assigned');
  assert.throws(() => projectSourceQueue(state, at, { limit: 1, cursor }, scope(...sourceCandidateIds(state))), errorCode('STALE_CURSOR'));
  assert.throws(() => projectSourceQueue(state, at, { limit: 1, cursor }, scope(ids[0])), errorCode('STALE_CURSOR'));
  assert.throws(() => projectSourceQueue(state, at, { limit: 1, cursor }), errorCode('STALE_CURSOR'));
  assert.deepEqual(projectSourceQueue(state, at, { limit: 1 }, scope(...ids)), projectSourceQueue(state, at, { limit: 1 }, scope(...ids.reverse())));
});

test('scoped reads preserve authoritative quarantine, deletion, expiry and global retention holds', () => {
  const state = emptyState(), original = append(state, 'retained');
  const quarantined = append(state, 'quarantined', { type: 'UNKNOWN', originId: null });
  const deleted = append(state, 'deleted');
  state.deletions.push({ sourceId: deleted, at, expiresAt: '2026-06-03T12:00:00.000Z', reason: privateValue });
  const access = scope(original, quarantined, deleted), before = structuredClone(state);
  const current = projectSourceQueue(state, at, undefined, access);
  assert.equal(current.entries.find(entry => entry.candidateRef === ref(quarantined))!.quarantineStatus, 'QUARANTINED');
  const removed = current.entries.find(entry => entry.candidateRef === ref(deleted))!;
  assert.equal(removed.retentionStatus, 'DELETED');
  assert.equal(removed.canonicalUrl, null);
  assert.equal(removed.publisher, null);
  const expired = projectSourceQueue(state, '2026-06-02T12:00:00.000Z', undefined, access);
  assert.ok(expired.entries.every(entry => entry.canonicalUrl === null && entry.canAdvance === false));
  assert.deepEqual(state, before);
  state.retentionReviewRequired = true;
  const held = projectSourceQueue(state, at, undefined, scope(original));
  assert.equal(held.retentionReviewRequired, true);
  assert.equal(held.entries[0].sourceEligible, false);
  assert.equal(held.entries[0].blockedReason, 'RETENTION_REVIEW_REQUIRED');
});

test('queries cannot inject authorization decisions and malformed scopes fail without invoking accessors', () => {
  const state = emptyState(), id = append(state, 'assigned');
  let invoked = 0;
  const accessor = Object.defineProperty({}, 'sourceIds', { enumerable: true, get() { invoked++; throw Error(privateValue); } });
  const sparse = new Array(1);
  for (const invalid of [null, [], Object.create({ sourceIds: [id], authorizationContext }), accessor,
    { sourceIds: [id], authorizationContext, allowed: true }, { sourceIds: sparse, authorizationContext },
    { sourceIds: [id, id], authorizationContext }, { sourceIds: [''], authorizationContext },
    { sourceIds: ['x'.repeat(257)], authorizationContext }, { sourceIds: [id], authorizationContext: 'session-secret' },
    { sourceIds: Array.from({ length: 10001 }, (_, index) => `fictional-${index}`), authorizationContext }]) {
    assert.throws(() => projectSourceQueue(state, at, undefined, invalid as SourceQueueScope), errorCode('UNAVAILABLE'));
  }
  for (const query of [{ sourceIds: [id] }, { authorizationContext }, { allowed: true }, { scope: scope(id) },
    JSON.parse('{"__proto__":{"sourceIds":["fictional"]}}')]) {
    assert.throws(() => projectSourceQueue(state, at, query as SourceQueueQuery, scope(id)), errorCode('INVALID_QUERY'));
  }
  assert.equal(invoked, 0);
});

test('candidate scans reject prototype-bearing, accessor, sparse and oversized repository values safely', () => {
  let invoked = 0;
  const state = emptyState();
  const accessor = Object.defineProperty({}, 'id', { enumerable: true, get() { invoked++; throw Error(privateValue); } });
  const variants: State[] = [Object.create(state), { ...state, sources: [accessor] } as State,
    { ...state, sources: new Array(1) },
    { ...state, sources: Array.from({ length: 10001 }, (_, index) => ({ id: `fictional-${index}` })) } as State];
  for (const invalid of variants) {
    assert.throws(() => sourceCandidateIds(invalid), errorCode('UNAVAILABLE'));
    assert.throws(() => projectSourceQueue(invalid, at, undefined, scope()), errorCode('UNAVAILABLE'));
  }
  assert.equal(invoked, 0);
});

test('temporal fences use the granted retention deadline while excluding unrelated source timers', () => {
  const state = emptyState(), assigned = append(state, 'assigned-timer'), hidden = append(state, 'hidden-timer');
  const cutoff = '2026-06-01T12:00:10.000Z';
  state.managedSources.find(row => row.sourceId === assigned)!.deleteAt = cutoff;
  state.managedSources.find(row => row.sourceId === hidden)!.deleteAt = '2026-06-01T12:00:01.000Z';
  assert.equal(sourceQueueValidUntil(state, at, scope(assigned)), Date.parse(cutoff));
  assert.equal(sourceQueueValidUntil(state, '2026-06-01T12:00:00.001Z', scope(assigned)), Date.parse(cutoff));
  assert.equal(sourceQueueValidUntil(state, at), Date.parse('2026-06-01T12:00:01.000Z'));
  // The exact deadline has already changed the projection; only a later transition remains future.
  assert.ok(sourceQueueValidUntil(state, cutoff, scope(assigned))! > Date.parse(cutoff));
  assert.equal(sourceQueueValidUntil(emptyState(), at, scope()), null);
});

test('an inaccessible origin still constrains the temporal validity of assigned syndicated metadata', () => {
  const state = emptyState(), origin = append(state, 'hidden-origin-timer');
  const copy = append(state, 'assigned-copy-timer', { type: 'SYNDICATED', originId: origin });
  const unrelated = append(state, 'unrelated-timer');
  state.managedSources.find(row => row.sourceId === origin)!.deleteAt = '2026-06-01T12:00:05.000Z';
  state.managedSources.find(row => row.sourceId === copy)!.deleteAt = '2026-06-01T12:00:10.000Z';
  state.managedSources.find(row => row.sourceId === unrelated)!.deleteAt = '2026-06-01T12:00:01.000Z';
  assert.equal(sourceQueueValidUntil(state, at, scope(copy)), Date.parse('2026-06-01T12:00:05.000Z'));
  assert.equal(projectSourceQueue(state, at, undefined, scope(copy)).entries[0].relationship, null);
});

test('temporal fences include captured rights, future retention and provenance transitions', () => {
  const state = emptyState(), id = append(state, 'future-timers');
  const record = state.managedSources.find(row => row.sourceId === id)!;
  record.retainedAt = '2026-06-01T12:00:20.000Z';
  assert.equal(sourceQueueValidUntil(state, at, scope(id)), Date.parse(record.retainedAt));
  record.policy.effectiveAt = '2026-06-01T12:00:10.000Z';
  assert.equal(sourceQueueValidUntil(state, at, scope(id)), Date.parse(record.policy.effectiveAt));
  const source = state.sources.find(row => row.id === id)!;
  source.rights = JSON.stringify({ ...JSON.parse(source.rights), expiresAt: '2026-06-01T12:00:05.000Z' });
  assert.equal(sourceQueueValidUntil(state, at, scope(id)), Date.parse('2026-06-01T12:00:05.000Z'));
  state.provenanceDecisions.find(row => row.sourceId === id)!.at = '2026-06-01T12:00:02.000Z';
  assert.equal(sourceQueueValidUntil(state, at, scope(id)), Date.parse('2026-06-01T12:00:02.000Z'));
});

test('global deletion hold timers constrain authorized reads without exposing their private fields', () => {
  const state = emptyState(), id = append(state, 'global-hold-timer');
  state.deletions.push({ sourceId: 'inaccessible-deletion-timer', at: '2026-06-01T12:00:02.000Z',
    expiresAt: '2026-06-01T12:00:04.000Z', reason: privateValue });
  const before = structuredClone(state);
  assert.equal(sourceQueueValidUntil(state, at, scope(id)), Date.parse('2026-06-01T12:00:02.000Z'));
  assert.equal(sourceQueueValidUntil(state, '2026-06-01T12:00:02.000Z', scope(id)), Date.parse('2026-06-01T12:00:04.000Z'));
  assert.deepEqual(state, before);
  let invoked = 0;
  const invalid = Object.defineProperty({}, 'sourceIds', { enumerable: true, get() { invoked++; return [id]; } });
  assert.throws(() => sourceQueueValidUntil(state, at, invalid as SourceQueueScope), errorCode('UNAVAILABLE'));
  assert.equal(invoked, 0);
});
