import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { seedEditionFixture } from '../fixtures/edition-fiction.ts';
import { EditionService } from '../src/editions/service.ts';
import { SchedulerService } from '../src/scheduling/service.ts';
import type { PreparationRun, ScheduleDefinition } from '../src/scheduling/types.ts';
import { JsonRepository } from '../src/newsroom/store.ts';

const createdAt = '2026-06-01T11:59:00.000Z';
const dueAt = '2026-06-01T12:00:00.000Z';
const execute = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const definition = (): ScheduleDefinition => ({ name: 'Fictional noon preparation', timezone: 'UTC', localTime: '12:00', weekdays: [0,1,2,3,4,5,6], enabled: true, maxAttempts: 3, retryDelayMs: 1000, catchUpWindowMs: 3_600_000 });
const plus = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();

async function withRepository(run: (repository: JsonRepository, service: SchedulerService, time: { now: string }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-scheduling-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const time = { now: createdAt };
    await run(repository, new SchedulerService(repository, { clock: () => time.now, leaseMs: 1000 }), time);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function due(service: SchedulerService, time: { now: string }): Promise<PreparationRun> {
  const schedule = await service.create(definition());
  time.now = dueAt;
  const evaluated = await service.evaluate({ dryRun: false });
  const run = evaluated.runs.find(run => run.scheduleId === schedule.id);
  assert.ok(run);
  assert.equal(run.status, 'SCHEDULED');
  return run;
}
async function preparing(service: SchedulerService, run: PreparationRun) {
  const claimed = await service.claim(run.id);
  assert.ok(claimed.claimId);
  const claimId = claimed.claimId;
  const active = await service.begin(run.id, claimId);
  assert.equal(active.status, 'PREPARING');
  return { run: active, claimId };
}

test('dry-run evaluation is the default and leaves bytes, audit and evaluation cursors unchanged', async () => {
  await withRepository(async (repository, service, time) => {
    const schedule = await service.create(definition());
    time.now = dueAt;
    const before = await readFile(repository.file, 'utf8');
    const prediction = await service.evaluate();
    assert.equal(prediction.runs.length, 1);
    assert.equal(prediction.runs[0].status, 'SCHEDULED');
    assert.equal(prediction.runs[0].occurrence.date, '2026-06-01');
    assert.equal(await readFile(repository.file, 'utf8'), before);
    assert.deepEqual((await service.snapshot()).runs, []);
    assert.equal((await service.snapshot()).schedules[0].lastEvaluatedAt, schedule.lastEvaluatedAt);
  });
});

test('dry-run evaluation of an absent repository creates no files', async () => {
  await withRepository(async (repository, service) => {
    assert.deepEqual(await service.evaluate({ dryRun: true }), { schedules: [], runs: [] });
    assert.deepEqual(await readdir(dirname(repository.file)), []);
  });
});

test('repeated applied evaluation creates exactly one preparation for a scheduled occurrence', async () => {
  await withRepository(async (_repository, service, time) => {
    const first = await due(service, time);
    await service.evaluate({ dryRun: false });
    await service.evaluate({ dryRun: false });
    const state = await service.snapshot();
    assert.equal(state.runs.length, 1);
    assert.equal(state.runs[0].id, first.id);
    assert.equal(state.runs[0].attempts, 0);
    assert.ok(state.schedules[0].nextOccurrence && state.schedules[0].nextOccurrence.at > dueAt);
  });
});

test('backlog evaluation coalesces to the latest due occurrence and records the missed interval', async () => {
  await withRepository(async (_repository, service, time) => {
    await service.create(definition());
    time.now = '2026-06-04T12:30:00.000Z';
    const result = await service.evaluate({ dryRun: false });
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].occurrence.date, '2026-06-04');
    assert.equal(result.runs[0].status, 'SCHEDULED');
    assert.ok(result.runs[0].missedSince);
    assert.equal(result.runs[0].missedSince, dueAt);
    assert.equal(result.runs[0].attempts, 0);
  });
});

test('an occurrence outside the catch-up window requires attention without preparing an edition', async () => {
  await withRepository(async (repository, service, time) => {
    await service.create(definition()); time.now = '2026-06-01T14:00:00.000Z';
    const result = await service.evaluate({ dryRun: false });
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].status, 'NEEDS_ATTENTION');
    assert.equal(result.runs[0].failure, 'MISSED_WINDOW');
    assert.equal(result.runs[0].attempts, 0);
    assert.deepEqual((await repository.read()).editions, []);
  });
});

test('concurrent independent evaluators persist only one run for each occurrence', async () => {
  await withRepository(async (repository, service, time) => {
    await service.create(definition()); time.now = dueAt;
    await Promise.all(Array.from({ length: 8 }, () => new SchedulerService(new JsonRepository(repository.file), { clock: () => time.now }).evaluate({ dryRun: false })));
    const state = await service.snapshot();
    assert.equal(state.runs.length, 1);
    assert.equal(new Set(state.runs.map(run => run.occurrence.key)).size, 1);
  });
});

test('concurrent claimants obtain one fenced claim and increment the attempt counter once', async () => {
  await withRepository(async (repository, service, time) => {
    const run = await due(service, time);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => new SchedulerService(new JsonRepository(repository.file), { clock: () => time.now, leaseMs: 1000 }).claim(run.id)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 7);
    const stored = (await service.snapshot()).runs[0];
    assert.equal(stored.status, 'CLAIMED');
    assert.equal(stored.attempts, 1);
    assert.ok(stored.claimId);
    assert.equal(stored.leaseUntil, plus(dueAt, 1000));
  });
});

test('claim tokens and state transitions are checked before any edition can be written', async () => {
  await withRepository(async (repository, service, time) => {
    const run = await due(service, time);
    const claimed = await service.claim(run.id); assert.ok(claimed.claimId);
    await assert.rejects(service.prepare(run.id, claimed.claimId));
    await assert.rejects(service.begin(run.id, 'wrong-claim'));
    await service.begin(run.id, claimed.claimId);
    await assert.rejects(service.prepare(run.id, 'wrong-claim'));
    await assert.rejects(service.fail(run.id, 'wrong-claim'));
    assert.equal((await service.snapshot()).runs[0].status, 'PREPARING');
    assert.deepEqual((await repository.read()).editions, []);
  });
});

test('leases remain active before the deadline and require explicit recovery at the exact deadline', async () => {
  await withRepository(async (_repository, service, time) => {
    const run = await due(service, time);
    const claimed = await service.claim(run.id); assert.ok(claimed.claimId); assert.ok(claimed.leaseUntil);
    time.now = plus(claimed.leaseUntil, -1);
    assert.deepEqual(await service.recover(), []);
    time.now = claimed.leaseUntil;
    await assert.rejects(service.begin(run.id, claimed.claimId));
    await assert.rejects(service.claim(run.id));
    const recovered = await service.recover();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'FAILED');
    assert.equal(recovered[0].failure, 'INTERRUPTED');
    assert.equal(recovered[0].claimId, null);
    assert.equal(recovered[0].attempts, 1);
    assert.deepEqual(await service.recover(), []);
  });
});

test('recovery and a fresh claim fence an old worker from creating or completing an edition', async () => {
  await withRepository(async (repository, service, time) => {
    const run = await due(service, time);
    const old = await preparing(service, run); assert.ok(old.run.leaseUntil);
    time.now = old.run.leaseUntil;
    const recovered = (await service.recover())[0]; assert.ok(recovered.nextRetryAt);
    time.now = recovered.nextRetryAt;
    const current = await preparing(service, recovered);
    assert.notEqual(current.claimId, old.claimId);
    assert.equal(current.run.attempts, 2);
    await assert.rejects(service.prepare(run.id, old.claimId));
    await assert.rejects(service.fail(run.id, old.claimId));
    assert.deepEqual((await repository.read()).editions, []);
    const prepared = await service.prepare(run.id, current.claimId);
    assert.equal(prepared.status, 'PREPARED');
    assert.equal((await repository.read()).editions.length, 1);
  });
});

test('transient failures require an explicit bounded retry after its configured delay', async () => {
  await withRepository(async (_repository, service, time) => {
    const run = await due(service, time);
    const active = await preparing(service, run);
    const failed = await service.fail(run.id, active.claimId);
    assert.equal(failed.status, 'FAILED'); assert.equal(failed.failure, 'TRANSIENT_FAILURE');
    assert.equal(failed.claimId, null); assert.equal(failed.leaseUntil, null);
    assert.equal(failed.nextRetryAt, plus(dueAt, 1000));
    time.now = plus(dueAt, 999); await assert.rejects(service.claim(run.id));
    time.now = plus(dueAt, 60_000);
    const unchanged = (await service.snapshot()).runs[0];
    assert.equal(unchanged.status, 'FAILED'); assert.equal(unchanged.attempts, 1);
    const retry = await service.claim(run.id);
    assert.equal(retry.attempts, 2); assert.equal(retry.status, 'CLAIMED');
  });
});

test('retry exhaustion is terminal after three attempts and cannot be claimed again', async () => {
  await withRepository(async (_repository, service, time) => {
    let run = await due(service, time);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const active = await preparing(service, run);
      assert.equal(active.run.attempts, attempt);
      run = await service.fail(run.id, active.claimId);
      if (attempt < 3) { assert.ok(run.nextRetryAt); time.now = run.nextRetryAt; }
    }
    assert.equal(run.status, 'FAILED'); assert.equal(run.failure, 'RETRY_EXHAUSTED');
    assert.equal(run.nextRetryAt, null); assert.equal(run.claimId, null);
    time.now = plus(time.now, 86_400_000);
    await assert.rejects(service.claim(run.id));
    assert.equal((await service.snapshot()).runs[0].attempts, 3);
  });
});

test('terminal retry exhaustion survives cancellation denial and later schedule pausing', async () => {
  await withRepository(async (_repository, service, time) => {
    const schedule = await service.create({ ...definition(), maxAttempts: 1 });
    time.now = dueAt;
    const run = (await service.evaluate({ dryRun: false })).runs[0];
    const active = await preparing(service, run);
    const exhausted = await service.fail(run.id, active.claimId);
    assert.equal(exhausted.failure, 'RETRY_EXHAUSTED');
    assert.equal(exhausted.nextRetryAt, null);
    await assert.rejects(service.cancel(run.id), /RUN_NOT_PENDING/);
    time.now = plus(dueAt, 2000);
    assert.equal((await service.pause(schedule.id)).enabled, false);
    assert.deepEqual((await service.snapshot()).runs[0], exhausted);
  });
});

test('interrupted claims also consume the retry budget without unbounded recovery loops', async () => {
  await withRepository(async (_repository, service, time) => {
    let run = await due(service, time);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = await service.claim(run.id); assert.ok(claimed.leaseUntil);
      time.now = claimed.leaseUntil;
      run = (await service.recover())[0];
      assert.equal(run.attempts, attempt);
      if (attempt < 3) { assert.ok(run.nextRetryAt); time.now = run.nextRetryAt; }
    }
    assert.equal(run.failure, 'RETRY_EXHAUSTED'); assert.equal(run.status, 'FAILED');
    assert.equal(run.nextRetryAt, null);
    assert.deepEqual(await service.recover(), []);
    await assert.rejects(service.claim(run.id));
  });
});

test('cancellation fences scheduled, claimed, preparing and retryable failed work', async () => {
  for (const status of ['SCHEDULED', 'CLAIMED', 'PREPARING', 'FAILED'] as const) {
    await withRepository(async (repository, service, time) => {
      let run = await due(service, time); let claimId: string | null = null;
      if (status !== 'SCHEDULED') { run = await service.claim(run.id); claimId = run.claimId; assert.ok(claimId); }
      if (status === 'PREPARING' || status === 'FAILED') run = await service.begin(run.id, claimId!);
      if (status === 'FAILED') run = await service.fail(run.id, claimId!);
      const cancelled = await service.cancel(run.id);
      assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.failure, 'CANCELLED');
      assert.equal(cancelled.claimId, null); assert.equal(cancelled.nextRetryAt, null);
      if (claimId) await assert.rejects(service.prepare(run.id, claimId));
      await assert.rejects(service.claim(run.id));
      assert.deepEqual((await repository.read()).editions, []);
    });
  }
});

test('pausing cancels all pending states and prevents late worker completion', async () => {
  for (const status of ['SCHEDULED', 'CLAIMED', 'PREPARING', 'FAILED'] as const) {
    await withRepository(async (repository, service, time) => {
      let run = await due(service, time); let claimId: string | null = null;
      if (status !== 'SCHEDULED') { run = await service.claim(run.id); claimId = run.claimId; assert.ok(claimId); }
      if (status === 'PREPARING' || status === 'FAILED') run = await service.begin(run.id, claimId!);
      if (status === 'FAILED') run = await service.fail(run.id, claimId!);
      const paused = await service.pause(run.scheduleId);
      assert.equal(paused.enabled, false);
      const stored = (await service.snapshot()).runs[0];
      assert.equal(stored.status, 'CANCELLED'); assert.equal(stored.failure, 'PAUSED');
      assert.equal(stored.claimId, null);
      if (claimId) await assert.rejects(service.prepare(run.id, claimId));
      assert.deepEqual((await repository.read()).editions, []);
    });
  }
});

test('resuming schedules only future occurrences and never catches up the paused interval', async () => {
  await withRepository(async (_repository, service, time) => {
    const run = await due(service, time); await service.pause(run.scheduleId);
    time.now = '2026-06-03T12:30:00.000Z';
    const resumed = await service.resume(run.scheduleId);
    assert.equal(resumed.enabled, true); assert.ok(resumed.nextOccurrence);
    assert.ok(resumed.nextOccurrence.at > time.now);
    assert.equal(resumed.nextOccurrence.date, '2026-06-04');
    assert.equal((await service.evaluate({ dryRun: false })).runs.length, 1);
    time.now = resumed.nextOccurrence.at;
    const evaluated = await service.evaluate({ dryRun: false });
    assert.equal(evaluated.runs.length, 2);
    assert.equal(evaluated.runs.find(candidate => candidate.id !== run.id)?.occurrence.date, '2026-06-04');
    assert.equal(evaluated.runs.find(candidate => candidate.id !== run.id)?.missedSince, null);
  });
});

test('preparation creates one empty assembling edition and grants no editorial or publication authority', async () => {
  await withRepository(async (repository, service, time) => {
    const run = await due(service, time); const active = await preparing(service, run);
    const prepared = await service.prepare(run.id, active.claimId);
    assert.equal(prepared.status, 'PREPARED'); assert.ok(prepared.editionId); assert.equal(prepared.editionRevision, 1);
    const state = await repository.read();
    assert.equal(state.editions.length, 1);
    const edition = state.editions[0]; assert.notEqual(edition.status, 'INVALIDATED');
    if (edition.status === 'INVALIDATED') assert.fail('Preparation must not create an invalid edition');
    assert.equal(edition.status, 'ASSEMBLING'); assert.equal(edition.date, '2026-06-01'); assert.equal(edition.timezone, 'UTC');
    assert.equal(edition.sections.length, 8); assert.ok(edition.sections.every(section => section.placements.length === 0));
    assert.deepEqual(state.approvals, []); assert.deepEqual(state.editionReviews, []);
    assert.equal(state.audit.some(event => /PUBLISHED|STATUS_APPROVED|EDITION_REVIEW_RECORDED/.test(event.action)), false);
    await assert.rejects(service.prepare(run.id, active.claimId));
    assert.equal((await repository.read()).editions.length, 1);
  });
});

test('concurrent completion with one claim creates one edition and records one successful outcome', async () => {
  await withRepository(async (repository, service, time) => {
    const run = await due(service, time);
    const active = await preparing(service, run);
    const results = await Promise.allSettled(Array.from({ length: 2 }, () => new SchedulerService(new JsonRepository(repository.file), { clock: () => time.now, leaseMs: 1000 }).prepare(run.id, active.claimId)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const state = await repository.read();
    assert.equal(state.editions.length, 1);
    const stored = (await service.snapshot()).runs[0];
    assert.equal(stored.status, 'PREPARED');
    assert.equal(stored.editionId, state.editions[0].id);
    assert.equal(stored.attempts, 1);
    assert.equal(state.audit.filter(event => event.action === 'PREPARATION_PREPARED').length, 1);
  });
});

test('approved fictional placements are copied in order without retaining selections in schedules or runs', async () => {
  await withRepository(async (repository, service, time) => {
    const fixture = await seedEditionFixture(repository, createdAt);
    const run = await due(service, time); const active = await preparing(service, run);
    await service.prepare(run.id, active.claimId, [{ storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES', featured: true }]);
    const state = await repository.read();
    const edition = state.editions[0]; assert.notEqual(edition.status, 'INVALIDATED');
    if (edition.status === 'INVALIDATED') assert.fail('Expected eligible fixture edition');
    assert.equal(edition.sections[0].placements[0].storyId, fixture.story.id);
    assert.equal(edition.sections[0].placements[0].storyVersion, fixture.story.version);
    assert.equal(edition.sections[0].placements[0].featured, true);
    assert.equal(edition.status, 'ASSEMBLING');
    assert.equal(state.approvals.length, 1); assert.deepEqual(state.editionReviews, []);
    const scheduling = JSON.stringify(await service.snapshot());
    for (const licensed of [fixture.story.id, fixture.story.headline, fixture.story.summary, ...fixture.sources]) assert.equal(scheduling.includes(licensed), false);
  });
});

test('preparation never overwrites an existing manual edition for the same date and timezone', async () => {
  await withRepository(async (repository, service, time) => {
    const manual = await new EditionService(repository, { clock: () => time.now }).create({ date: '2026-06-01', timezone: 'UTC', placements: [] }, 'fictional-manual-editor');
    const run = await due(service, time); const active = await preparing(service, run);
    const result = await service.prepare(run.id, active.claimId);
    assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.failure, 'EDITION_CONFLICT');
    assert.equal(result.editionId, null);
    assert.deepEqual((await repository.read()).editions, [manual]);
  });
});

test('ineligible placements produce attention status without any partial edition', async () => {
  await withRepository(async (repository, service, time) => {
    const run = await due(service, time); const active = await preparing(service, run);
    const result = await service.prepare(run.id, active.claimId, [{ storyId: 'nonexistent-fictional-story', storyVersion: 1, section: 'TOP_STORIES' }]);
    assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.failure, 'INELIGIBLE_CONTENT');
    assert.equal(result.editionId, null); assert.deepEqual((await repository.read()).editions, []);
  });
});

test('expired source rights block preparation even when the story was previously approved', async () => {
  await withRepository(async (repository, service, time) => {
    const fixture = await seedEditionFixture(repository, createdAt);
    await service.create(definition()); time.now = '2026-06-02T12:00:00.000Z';
    const run = (await service.evaluate({ dryRun: false })).runs[0];
    const active = await preparing(service, run);
    const result = await service.prepare(run.id, active.claimId, [{ storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES' }]);
    assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.failure, 'INELIGIBLE_CONTENT');
    assert.deepEqual((await repository.read()).editions, []);
  });
});

test('a retention review hold blocks even empty edition preparation', async () => {
  await withRepository(async (repository, service, time) => {
    const run = await due(service, time); const active = await preparing(service, run);
    await repository.transact(state => { state.retentionReviewRequired = true; });
    const result = await service.prepare(run.id, active.claimId);
    assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.failure, 'RETENTION_HOLD');
    assert.deepEqual((await repository.read()).editions, []);
  });
});

test('failed claim persistence does not consume an attempt or leave a claim capability', async () => {
  await withRepository(async (repository, service, time) => {
    const run = await due(service, time); const before = await readFile(repository.file, 'utf8');
    const failing = new SchedulerService(new JsonRepository(repository.file, { beforeCommit: () => { throw Error('fictional claim storage failure'); } }), { clock: () => time.now, leaseMs: 1000 });
    await assert.rejects(failing.claim(run.id));
    assert.equal(await readFile(repository.file, 'utf8'), before);
    const claimed = await service.claim(run.id); assert.equal(claimed.attempts, 1); assert.ok(claimed.claimId);
  });
});

test('edition creation, run completion and audit commit atomically or remain unchanged for retry', async () => {
  await withRepository(async (repository, service, time) => {
    const run = await due(service, time); const active = await preparing(service, run);
    const before = await readFile(repository.file, 'utf8');
    const failing = new SchedulerService(new JsonRepository(repository.file, { beforeCommit: () => { throw Error('fictional edition storage failure'); } }), { clock: () => time.now, leaseMs: 1000 });
    await assert.rejects(failing.prepare(run.id, active.claimId));
    assert.equal(await readFile(repository.file, 'utf8'), before);
    assert.equal((await service.snapshot()).runs[0].status, 'PREPARING');
    const retried = await service.prepare(run.id, active.claimId);
    assert.equal(retried.status, 'PREPARED'); assert.equal(retried.attempts, 1);
    assert.equal((await repository.read()).editions.length, 1);
  });
});

test('fixture CLI defaults to a nonpersisting prediction and prints no claim or source capabilities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-schedule-cli-'));
  try {
    const { stdout } = await execute(process.execPath, ['--experimental-strip-types', 'src/scheduling/runner.ts'], { cwd: repositoryRoot, env: { ...process.env, TMPDIR: directory } });
    const result = JSON.parse(stdout);
    assert.equal(result.mode, 'dry-run'); assert.equal(result.fictional, true); assert.equal(result.developmentOnly, true); assert.equal(result.publiclyPublished, false);
    assert.equal(result.run.status, 'SCHEDULED'); assert.equal(result.persistedRuns, 0); assert.equal(result.editions, 0);
    assert.doesNotMatch(stdout, /claimId|leaseUntil|sourceId|fictional-editorial-story|editorial\.example\.test/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fixture CLI explicit apply prepares only one temporary assembling edition and cleans it up', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-schedule-apply-'));
  try {
    const { stdout } = await execute(process.execPath, ['--experimental-strip-types', 'src/scheduling/runner.ts', '--apply-fixture'], { cwd: repositoryRoot, env: { ...process.env, TMPDIR: directory } });
    const result = JSON.parse(stdout);
    assert.equal(result.mode, 'temporary-fixture-apply'); assert.equal(result.publiclyPublished, false);
    assert.equal(result.run.status, 'PREPARED'); assert.equal(result.run.attempts, 1); assert.equal(result.persistedRuns, 1); assert.equal(result.editions, 1);
    assert.doesNotMatch(stdout, /claimId|leaseUntil|sourceId|fictional-editorial-story|editorial\.example\.test/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fixture CLI rejects live modes, existing paths and duplicate apply flags before creating files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-schedule-cli-args-'));
  try {
    for (const args of [['--live'], ['--repository=/workspace/Dayline'], ['--apply-fixture=true'], ['--apply-fixture', '--apply-fixture'], ['--publish']]) {
      await assert.rejects(execute(process.execPath, ['--experimental-strip-types', 'src/scheduling/runner.ts', ...args], { cwd: repositoryRoot, env: { ...process.env, TMPDIR: directory } }));
      assert.deepEqual(await readdir(directory), []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
