import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneSecurityState } from '../src/security/retention.ts';
import type { AuthenticatedAction, IdentityRecord, ResourceKind, SecurityEvent } from '../src/security/types.ts';
import { emptyState, type State, type Story } from '../src/newsroom/model.ts';
import type { ActiveDraft } from '../src/editorial/types.ts';
import { invalidateDrafts } from '../src/editorial/lifecycle.ts';
import { invalidateEditions } from '../src/editions/lifecycle.ts';
import { sectionIds } from '../src/editions/types.ts';
import { redactEditorialHistory } from '../src/ingestion/history.ts';
import type { PreparationRun } from '../src/scheduling/types.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { AuthenticatedEditorial } from '../src/security/editorial.ts';
import { seedSecurityFixture, securityAt } from '../fixtures/security-fiction.ts';
import { seedEditionFixture } from '../fixtures/edition-fiction.ts';

const at = '2026-06-08T12:00:00.000Z';
const earlier = '2026-06-08T11:00:00.000Z';
const identityId = randomUUID();
const sessionRef = randomUUID();

function identity(): IdentityRecord {
  return { id: identityId, status: 'ACTIVE', roles: ['MANAGING_EDITOR'], provider: { issuer: 'fictional-issuer', subject: 'fictional-subject' },
    revision: 1, credentialVersion: 1, credentialsRotatedAt: null, createdAt: earlier, updatedAt: earlier };
}
function audit(changes: Partial<SecurityEvent> = {}): SecurityEvent {
  return { id: randomUUID(), at, category: 'PROTECTED_ACTION', code: 'SUCCESS', userRef: identityId,
    sessionRef, subjectRef: null, permission: 'STORY_APPROVE', ...changes };
}
function receipt(kind: ResourceKind, id: string, version: number | null = 1, changes: Partial<AuthenticatedAction> = {}): AuthenticatedAction {
  return { id: randomUUID(), actorId: identityId, identityRevision: 1, sessionRef,
    permission: 'STORY_APPROVE', resourceKind: kind, resourceId: id, resourceVersion: version, at, ...changes };
}
function story(id = 'fictional-story'): Story {
  return { id, headline: 'FICTIONAL_PRIVATE_HEADLINE', summary: 'FICTIONAL_PRIVATE_SUMMARY', topic: 'fixture', geography: 'fixture',
    eventAt: null, firstSeenAt: earlier, updatedAt: earlier, clusterId: null, evidence: [], sourceIds: [], status: 'DRAFT', version: 1 };
}
function state(): State { const value = emptyState(); value.identities.push(identity()); return value; }

test('security audit expires at seven days and retains at most the newest 512 safe events', () => {
  const value = state();
  value.securityAudit = Array.from({ length: 515 }, (_, index) => audit({ at: new Date(Date.parse(at) - 1000 + index).toISOString() }));
  const oldest = value.securityAudit.slice(0, 3).map(event => event.id), retained = value.securityAudit.slice(3).map(event => event.id);
  value.securityAudit.push(audit({ at: '2026-06-01T12:00:00.000Z' }), audit({ at: '2026-06-09T12:00:00Z' }), audit({ at: 'invalid-date' }));
  assert.equal(pruneSecurityState(value, at), 6);
  assert.equal(value.securityAudit.length, 512);
  assert.deepEqual(value.securityAudit.map(event => event.id), retained);
  assert.ok(value.securityAudit.every(event => !oldest.includes(event.id)));
});

test('authenticated receipts are independently bounded by time and capacity', () => {
  const value = state(); value.revisions.push(story());
  value.authenticatedActions = Array.from({ length: 514 }, () => receipt('STORY', 'fictional-story'));
  const retained = value.authenticatedActions.slice(2).map(action => action.id);
  value.authenticatedActions.push(receipt('STORY', 'fictional-story', 1, { at: '2026-06-01T12:00:00Z' }),
    receipt('STORY', 'fictional-story', 1, { at: '2026-06-09T12:00:00Z' }));
  assert.equal(pruneSecurityState(value, at), 4);
  assert.deepEqual(value.authenticatedActions.map(action => action.id), retained);
});

test('story receipts disappear after linked history redaction without rewriting other editorial arrays', () => {
  const value = state(), original = story(); original.sourceIds = ['FICTIONAL_PRIVATE_SOURCE'];
  value.revisions.push(original); value.authenticatedActions.push(receipt('STORY', original.id));
  value.securityAudit.push(audit());
  assert.equal(redactEditorialHistory(value, new Set(original.sourceIds), at), 1);
  const editorial = structuredClone({ revisions: value.revisions, approvals: value.approvals, audit: value.audit });
  assert.equal(pruneSecurityState(value, at), 1);
  assert.deepEqual(value.authenticatedActions, []); assert.equal(value.securityAudit.length, 1);
  assert.deepEqual({ revisions: value.revisions, approvals: value.approvals, audit: value.audit }, editorial);
  assert.doesNotMatch(JSON.stringify(value.authenticatedActions), /FICTIONAL_PRIVATE|fictional-story/);
});

test('missing, redacted and unmatched story versions cannot retain authenticated action linkages', () => {
  const value = state(); value.revisions.push(story('safe'), { ...story('redacted'), retentionRedacted: true });
  value.authenticatedActions.push(receipt('STORY', 'safe'), receipt('STORY', 'missing'), receipt('STORY', 'redacted'), receipt('STORY', 'safe', 99));
  assert.equal(pruneSecurityState(value, at), 3);
  assert.equal(value.authenticatedActions[0].resourceId, 'safe');
});

test('draft invalidation prunes its protected receipts as part of the lifecycle change', () => {
  const value = state();
  const draft: ActiveDraft = { id: randomUUID(), storyId: 'missing-story', storyVersion: 1, version: 2, status: 'NEEDS_REVIEW',
    generatedAt: earlier, expiresAt: '2026-06-09T12:00:00Z', providerId: 'mock-editorial', modelVersion: 'extractive-v1',
    promptTemplateVersion: 'dayline-editorial-v1', sourceIds: ['FICTIONAL_PRIVATE_SOURCE'], policies: [],
    output: { headline: 'FICTIONAL_PRIVATE_HEADLINE', summary: 'FICTIONAL_PRIVATE_SUMMARY', claims: [], sections: [], uncertainties: [] },
    suggestions: [], usage: { inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 } };
  value.drafts.push(draft); value.authenticatedActions.push(receipt('DRAFT', draft.id, 1));
  assert.equal(invalidateDrafts(value, at), 1);
  assert.equal(value.drafts[0].status, 'INVALIDATED'); assert.deepEqual(value.authenticatedActions, []);
  assert.doesNotMatch(JSON.stringify({ drafts: value.drafts, actions: value.authenticatedActions }), /FICTIONAL_PRIVATE|missing-story/);
});

test('edition receipts bind exact historical revisions and disappear when that revision invalidates', () => {
  const value = state(), editionId = randomUUID();
  value.editions.push({ id: editionId, date: '2026-06-08', timezone: 'UTC', revision: 1, createdAt: earlier, updatedAt: earlier,
    status: 'ASSEMBLING', sections: sectionIds.map(id => ({ id, placements: [] })), suggestions: [] },
  { id: editionId, date: '2026-06-08', timezone: 'UTC', revision: 2, createdAt: earlier, updatedAt: earlier,
    status: 'INVALIDATED', reason: 'STALE_OR_INELIGIBLE' });
  value.authenticatedActions.push(receipt('EDITION', editionId, 1), receipt('EDITION', editionId, 2), receipt('EDITION', editionId, 3));
  assert.equal(pruneSecurityState(value, at), 2);
  assert.equal(value.authenticatedActions[0].resourceVersion, 1);
  value.retentionReviewRequired = true;
  assert.equal(invalidateEditions(value, at), 1);
  assert.deepEqual(value.authenticatedActions, []);
});

test('run receipts retain pending or prepared procedures and drop terminal ineligible results', () => {
  const value = state();
  for (const status of ['SCHEDULED', 'CLAIMED', 'PREPARING', 'PREPARED', 'FAILED', 'CANCELLED', 'NEEDS_ATTENTION'] as const) {
    const run: PreparationRun = { id: randomUUID(), scheduleId: randomUUID(), occurrence: { key: randomUUID(), date: '2026-06-08', timezone: 'UTC', localTime: '12:00', at },
      status, attempts: 1, maxAttempts: 2, retryDelayMs: 1000, claimId: null, leaseUntil: null, nextRetryAt: null,
      editionId: null, editionRevision: null, failure: null, missedSince: null, createdAt: earlier, updatedAt: at };
    value.preparationRuns.push(run); value.authenticatedActions.push(receipt('RUN', run.id, null));
  }
  assert.equal(pruneSecurityState(value, at), 3);
  assert.equal(value.authenticatedActions.length, 4);
  assert.deepEqual(value.authenticatedActions.map(action => value.preparationRuns.find(run => run.id === action.resourceId)!.status), ['SCHEDULED', 'CLAIMED', 'PREPARING', 'PREPARED']);
});

test('security metadata pruning uses explicit field allowlists with no licensed text or credential copies', () => {
  const value = state(); value.revisions.push(story());
  value.securityAudit.push(Object.assign(audit(), { rawCredential: 'FICTIONAL_SECRET_CREDENTIAL', sourceUrl: 'https://fiction.example.test/private', actorAssertion: 'FICTIONAL_PRIVATE_ACTOR' }));
  value.authenticatedActions.push(Object.assign(receipt('STORY', 'fictional-story'), { copiedHeadline: 'FICTIONAL_PRIVATE_HEADLINE', sourceIds: ['FICTIONAL_PRIVATE_SOURCE'] }));
  const editorialBefore = structuredClone(value.revisions);
  assert.equal(pruneSecurityState(value, at), 0);
  assert.doesNotMatch(JSON.stringify({ audit: value.securityAudit, actions: value.authenticatedActions }), /FICTIONAL_PRIVATE|FICTIONAL_SECRET|fiction\.example|rawCredential|actorAssertion|sourceIds/);
  assert.deepEqual(value.revisions, editorialBefore);
  assert.deepEqual(Object.keys(value.securityAudit[0]).sort(), ['id', 'at', 'category', 'code', 'userRef', 'sessionRef', 'subjectRef', 'permission'].sort());
});

test('receipts for missing identities or removed administrative resources cannot retain orphan references', () => {
  const value = state(); value.revisions.push(story());
  value.authenticatedActions.push(receipt('STORY', 'fictional-story', 1, { actorId: randomUUID() }), receipt('SCHEDULE', randomUUID(), null),
    receipt('IDENTITY', randomUUID(), null), receipt('SESSION', randomUUID(), null));
  assert.equal(pruneSecurityState(value, at), 4); assert.deepEqual(value.authenticatedActions, []);
});

test('malformed retention clocks leave all security and editorial state unchanged', () => {
  const value = state(); value.revisions.push(story()); value.securityAudit.push(audit()); value.authenticatedActions.push(receipt('STORY', 'fictional-story'));
  const before = structuredClone(value);
  assert.throws(() => pruneSecurityState(value, '2026-02-30T00:00:00Z'));
  assert.deepEqual(value, before);
  assert.equal(pruneSecurityState(value, at), 0);
  assert.equal(pruneSecurityState(value, at), 0);
});

test('authenticated edition editing reassembles an invalidated revision only from fresh approved placements', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-security-reassembly-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const security = await seedSecurityFixture(repository);
    const fixture = await seedEditionFixture(repository, securityAt);
    const workflow = new AuthenticatedEditorial(repository, security.access);
    const edition = await workflow.assembleEdition(security.accounts.reporter.credential, { date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES', featured: true },
    ] });
    const edited = await workflow.editStory(security.accounts.reporter.credential, fixture.story.id, fixture.story.version,
      { summary: 'A changed fictional garden summary.' });
    const review = await workflow.reviewStory(security.accounts.editor.credential, edited.id, edited.version, 'NEEDS_REVIEW');
    const approved = await workflow.approveStory(security.accounts.managing.credential, review.id, review.version);
    assert.equal((await repository.read()).editions[0].status, 'INVALIDATED');
    const fresh = await workflow.editEdition(security.accounts.reporter.credential, edition.id, edition.revision, [
      { storyId: approved.id, storyVersion: approved.version, section: 'TOP_STORIES', featured: true },
    ]);
    assert.equal(fresh.status, 'ASSEMBLING'); assert.equal(fresh.revision, edition.revision + 1);
    assert.equal(fresh.sections[0].placements[0].storyVersion, approved.version);
    assert.equal(fresh.sections[0].placements[0].summary, 'A changed fictional garden summary.');
    const stored = await repository.read();
    assert.equal(stored.editions[0].status, 'INVALIDATED');
    assert.equal('sections' in stored.editions[0], false);
    await assert.rejects(workflow.editEdition(security.accounts.reporter.credential, edition.id, edition.revision, []), error => error instanceof Error && 'code' in error && error.code === 'STALE_TARGET');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
