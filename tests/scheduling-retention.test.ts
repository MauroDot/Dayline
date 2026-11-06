import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcilePreparedRuns } from '../src/scheduling/lifecycle.ts';
import { SchedulerService } from '../src/scheduling/service.ts';
import type { PreparationRun } from '../src/scheduling/types.ts';
import { invalidateEditions } from '../src/editions/lifecycle.ts';
import { sectionIds, type ActiveEdition } from '../src/editions/types.ts';
import { emptyState } from '../src/newsroom/model.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { Newsroom } from '../src/newsroom/service.ts';
import { cleanupRetention } from '../src/ingestion/retention.ts';
import { seedEditionFixture } from '../fixtures/edition-fiction.ts';

const at = '2026-06-01T12:00:00.000Z';
const fixtureAt = '2026-06-01T11:59:00.000Z';

function edition(id = randomUUID(), revision = 1): ActiveEdition {
  return { id, revision, date: '2026-06-01', timezone: 'UTC', status: 'ASSEMBLING', createdAt: at, updatedAt: at,
    sections: sectionIds.map(id => ({ id, placements: [] })), suggestions: [] };
}

function run(editionId: string | null, editionRevision: number | null = 1): PreparationRun {
  return { id: randomUUID(), scheduleId: randomUUID(), occurrence: { key: 'fictional-occurrence', date: '2026-06-01',
    timezone: 'UTC', localTime: '12:00', at }, status: 'PREPARED', attempts: 1, maxAttempts: 2, retryDelayMs: 1000,
    claimId: null, leaseUntil: null, nextRetryAt: null, editionId, editionRevision, failure: null,
    missedSince: null, createdAt: at, updatedAt: at };
}

test('prepared reconciliation binds the exact edition revision instead of an unrelated later revision', () => {
  const state = emptyState(), first = edition();
  state.editions.push(first, { ...first, revision: 2, status: 'INVALIDATED', reason: 'STALE_OR_INELIGIBLE' });
  state.preparationRuns.push(run(first.id));
  const before = structuredClone(state);
  assert.equal(reconcilePreparedRuns(state, at), 0);
  assert.deepEqual(state, before);
});

test('missing and invalidated prepared editions need attention and retain only procedural bookkeeping', () => {
  for (const missing of [true, false]) {
    const state = emptyState(), original = edition(), prepared = run(original.id);
    if (!missing) state.editions.push({ id: original.id, revision: 1, date: original.date, timezone: original.timezone,
      createdAt: at, updatedAt: at, status: 'INVALIDATED', reason: 'STALE_OR_INELIGIBLE' });
    prepared.claimId = randomUUID(); prepared.leaseUntil = '2026-06-01T12:01:00Z'; prepared.nextRetryAt = '2026-06-01T12:02:00Z';
    Object.assign(prepared, { copiedHeadline: 'FICTIONAL_PROHIBITED_HEADLINE', sourceIds: ['FICTIONAL_PROHIBITED_SOURCE'] });
    Object.assign(prepared.occurrence, { copiedEvidence: 'FICTIONAL_PROHIBITED_EVIDENCE' });
    state.preparationRuns.push(prepared);
    assert.equal(reconcilePreparedRuns(state, '2026-06-01T12:03:00Z'), 1);
    const result = state.preparationRuns[0];
    assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.failure, 'INELIGIBLE_CONTENT');
    assert.equal(result.editionId, original.id); assert.equal(result.editionRevision, 1);
    assert.equal(result.claimId, null); assert.equal(result.leaseUntil, null); assert.equal(result.nextRetryAt, null);
    assert.equal(result.updatedAt, '2026-06-01T12:03:00.000Z');
    assert.equal(result.attempts, prepared.attempts);
    assert.doesNotMatch(JSON.stringify(result), /FICTIONAL_PROHIBITED|sourceIds|headline|evidence/);
    assert.deepEqual(Object.keys(result).sort(), ['id', 'scheduleId', 'occurrence', 'status', 'attempts', 'maxAttempts',
      'retryDelayMs', 'claimId', 'leaseUntil', 'nextRetryAt', 'editionId', 'editionRevision', 'failure', 'missedSince', 'createdAt', 'updatedAt'].sort());
    const before = structuredClone(state);
    assert.equal(reconcilePreparedRuns(state, '2026-06-01T12:04:00Z'), 0); assert.deepEqual(state, before);
  }
});

test('a different edition revision cannot substitute for a missing exact preparation result', () => {
  const state = emptyState(), current = edition(undefined, 2);
  state.editions.push(current); state.preparationRuns.push(run(current.id, 1));
  assert.equal(reconcilePreparedRuns(state, at), 1);
  assert.equal(state.preparationRuns[0].status, 'NEEDS_ATTENTION');
});

test('unrelated safe runs and non-prepared states are not changed by reconciliation', () => {
  const state = emptyState(), safe = edition();
  state.editions.push(safe);
  for (const status of ['SCHEDULED', 'CLAIMED', 'PREPARING', 'NEEDS_ATTENTION', 'FAILED', 'CANCELLED'] as const) {
    state.preparationRuns.push({ ...run(null, null), status });
  }
  state.preparationRuns.push(run(safe.id));
  const before = structuredClone(state);
  assert.equal(reconcilePreparedRuns(state, at), 0); assert.deepEqual(state, before);
});

test('edition invalidation reconciles every prepared binding in the same in-memory change', () => {
  const state = emptyState(), original = edition();
  state.editions.push(original, { ...structuredClone(original), revision: 2 });
  state.preparationRuns.push(run(original.id, 1), run(original.id, 2));
  state.retentionReviewRequired = true;
  assert.equal(invalidateEditions(state, at), 2);
  assert.ok(state.editions.every(row => row.status === 'INVALIDATED'));
  assert.ok(state.preparationRuns.every(row => row.status === 'NEEDS_ATTENTION' && row.failure === 'INELIGIBLE_CONTENT'));
});

test('edition lifecycle also reconciles a dangling prepared binding when no fresh invalidation occurs', () => {
  const state = emptyState(); state.preparationRuns.push(run(randomUUID()));
  assert.equal(invalidateEditions(state, at), 0);
  assert.equal(state.preparationRuns[0].status, 'NEEDS_ATTENTION');
  assert.equal(state.preparationRuns[0].failure, 'INELIGIBLE_CONTENT');
});

test('invalid reconciliation clocks cannot partially change run or edition histories', () => {
  const state = emptyState(); state.preparationRuns.push(run(randomUUID()));
  const before = structuredClone(state);
  assert.throws(() => reconcilePreparedRuns(state, '2026-02-30T00:00:00Z'));
  assert.deepEqual(state, before);
  assert.throws(() => invalidateEditions(state, 'not-a-date'));
  assert.deepEqual(state, before);
});

async function repositoryFixture(run: (repository: JsonRepository) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-scheduling-retention-'));
  try { await run(new JsonRepository(join(directory, 'fictional.json'))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function preparing(repository: JsonRepository, dueAt = at) {
  const fixture = await seedEditionFixture(repository, fixtureAt);
  let now = new Date(Date.parse(dueAt) - 60_000).toISOString();
  const clock = () => now;
  const scheduler = new SchedulerService(repository, { clock });
  const schedule = await scheduler.create({ name: 'Fictional retention preparation', timezone: 'UTC',
    localTime: dueAt.slice(11, 16), weekdays: [0, 1, 2, 3, 4, 5, 6], enabled: true });
  now = dueAt;
  const evaluation = await scheduler.evaluate({ dryRun: false });
  const scheduled = evaluation.runs.find(row => row.scheduleId === schedule.id);
  assert.ok(scheduled);
  const claimed = await scheduler.claim(scheduled.id);
  assert.ok(claimed.claimId);
  await scheduler.begin(claimed.id, claimed.claimId);
  const placements = [{ storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES' as const, featured: true }];
  return { scheduler, fixture, claimed, claimId: claimed.claimId, placements, clock, setClock: (value: string) => { now = value; } };
}

test('explicit preparation creates only an assembling edition and never changes story approval history', async () => {
  await repositoryFixture(async repository => {
    const setup = await preparing(repository), before = await repository.read();
    const prepared = await setup.scheduler.prepare(setup.claimed.id, setup.claimId, setup.placements);
    assert.equal(prepared.status, 'PREPARED'); assert.ok(prepared.editionId); assert.equal(prepared.editionRevision, 1);
    const after = await repository.read();
    assert.deepEqual(after.approvals, before.approvals); assert.deepEqual(after.revisions, before.revisions);
    assert.equal(after.editionReviews.length, 0); assert.equal(after.editions.length, 1);
    assert.equal(after.editions[0].status, 'ASSEMBLING');
    assert.doesNotMatch(JSON.stringify(prepared), /fictional-editorial-story|garden|editorial\.example|policyId|sourceIds|claim-a/);
  });
});

test('expired rights reject explicit preparation without a partial edition or approval mutation', async () => {
  await repositoryFixture(async repository => {
    const setup = await preparing(repository, '2026-06-02T12:00:00.000Z'), before = await repository.read();
    const result = await setup.scheduler.prepare(setup.claimed.id, setup.claimId, setup.placements);
    assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.failure, 'INELIGIBLE_CONTENT');
    const after = await repository.read();
    assert.equal(after.editions.length, 0); assert.deepEqual(after.approvals, before.approvals);
    assert.deepEqual(after.revisions, before.revisions);
  });
});

test('quarantined, redacted and stale story selections cannot be prepared', async () => {
  for (const mode of ['quarantine', 'redaction', 'stale-version'] as const) {
    await repositoryFixture(async repository => {
      const setup = await preparing(repository);
      if (mode === 'stale-version') {
        await new Newsroom(repository, { clock: setup.clock }).edit(setup.fixture.story.id, { summary: 'A revised fictional summary.' }, 'fixture');
      } else {
        await repository.transact(state => {
          if (mode === 'redaction') state.revisions.filter(story => story.id === setup.fixture.story.id).at(-1)!.retentionRedacted = true;
          else {
            const record = state.managedSources[0];
            state.quarantine.push({ ...record, metadata: { ...record.providerMetadata } });
            state.managedSources = state.managedSources.filter(row => row.sourceId !== record.sourceId);
            state.sources = state.sources.filter(row => row.id !== record.sourceId);
          }
        });
      }
      const before = await repository.read();
      const result = await setup.scheduler.prepare(setup.claimed.id, setup.claimId, setup.placements);
      assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.failure, 'INELIGIBLE_CONTENT');
      const after = await repository.read();
      assert.equal(after.editions.length, 0); assert.deepEqual(after.approvals, before.approvals);
      assert.deepEqual(after.revisions, before.revisions);
    });
  }
});

test('retention hold blocks even an empty preparation without manufacturing editorial readiness', async () => {
  await repositoryFixture(async repository => {
    const setup = await preparing(repository);
    await repository.transact(state => { state.retentionReviewRequired = true; });
    const before = await repository.read();
    const result = await setup.scheduler.prepare(setup.claimed.id, setup.claimId, []);
    assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.failure, 'RETENTION_HOLD');
    const after = await repository.read();
    assert.equal(after.editions.length, 0); assert.deepEqual(after.approvals, before.approvals);
    assert.deepEqual(after.revisions, before.revisions);
  });
});

test('newsroom edits reconcile a prepared result in the same atomic edition invalidation', async () => {
  await repositoryFixture(async repository => {
    const setup = await preparing(repository);
    const prepared = await setup.scheduler.prepare(setup.claimed.id, setup.claimId, setup.placements);
    assert.equal(prepared.status, 'PREPARED');
    await new Newsroom(repository, { clock: setup.clock }).edit(setup.fixture.story.id, { summary: 'A revised fictional summary.' }, 'fixture');
    const after = await repository.read(), changed = after.preparationRuns.find(row => row.id === prepared.id)!;
    assert.equal(changed.status, 'NEEDS_ATTENTION'); assert.equal(changed.failure, 'INELIGIBLE_CONTENT');
    assert.equal(changed.editionId, prepared.editionId); assert.equal(changed.editionRevision, prepared.editionRevision);
    assert.equal(after.editions[0].status, 'INVALIDATED');
  });
});

test('fresh scheduler snapshots reconcile a prepared result after rights expiry without approving anything', async () => {
  await repositoryFixture(async repository => {
    const setup = await preparing(repository), before = await repository.read();
    const prepared = await setup.scheduler.prepare(setup.claimed.id, setup.claimId, setup.placements);
    setup.setClock('2026-06-02T12:00:00.000Z');
    const snapshot = await setup.scheduler.snapshot(), result = snapshot.runs.find(row => row.id === prepared.id)!;
    assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.failure, 'INELIGIBLE_CONTENT');
    const after = await repository.read();
    assert.equal(after.editions[0].status, 'INVALIDATED'); assert.deepEqual(after.approvals, before.approvals);
    assert.deepEqual(after.revisions, before.revisions);
  });
});

test('source cleanup and run reconciliation commit together and failed cleanup preserves the complete prior state', async () => {
  await repositoryFixture(async repository => {
    const setup = await preparing(repository);
    const prepared = await setup.scheduler.prepare(setup.claimed.id, setup.claimId, setup.placements);
    const before = await readFile(repository.file, 'utf8');
    const failing = new JsonRepository(repository.file, { beforeCommit: () => { throw Error('injected scheduling cleanup failure'); } });
    const expiredAt = '2026-06-02T12:00:00.000Z';
    await assert.rejects(cleanupRetention(failing, expiredAt, false), /injected scheduling cleanup failure/);
    assert.equal(await readFile(repository.file, 'utf8'), before);
    await cleanupRetention(repository, expiredAt, false);
    const after = await repository.read(), result = after.preparationRuns.find(row => row.id === prepared.id)!;
    assert.equal(after.sources.length, 0); assert.equal(after.managedSources.length, 0);
    assert.ok(after.editions.every(row => row.status === 'INVALIDATED'));
    assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.failure, 'INELIGIBLE_CONTENT');
    assert.equal(result.editionId, prepared.editionId); assert.equal(result.editionRevision, 1);
    assert.equal(result.claimId, null); assert.equal(result.leaseUntil, null); assert.equal(result.nextRetryAt, null);
    assert.doesNotMatch(JSON.stringify(result), /fictional-editorial-story|garden|editorial\.example|policyId|sourceIds|claim-a/);
    const cleaned = structuredClone(after);
    await cleanupRetention(repository, expiredAt, false);
    assert.deepEqual(await repository.read(), cleaned);
  });
});
