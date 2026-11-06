import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/newsroom/store.ts';
import { emptyState, type State } from '../src/newsroom/model.ts';
import { sectionIds, type ActiveEdition } from '../src/editions/types.ts';
import { occurrenceOn, validateDefinition } from '../src/scheduling/calendar.ts';
import type { PreparationRun, PreparationSchedule } from '../src/scheduling/types.ts';

const at = '2026-06-01T12:00:00.000Z';
function schedule(): PreparationSchedule {
  const value: PreparationSchedule = {
    id: 'fictional-schedule', ...validateDefinition({ name: 'Fictional daily preparation', timezone: 'UTC', localTime: '12:00', weekdays: [1], enabled: true, retryDelayMs: 1000 }),
    createdAt: '2026-06-01T11:00:00.000Z', updatedAt: at, lastEvaluatedAt: at, nextOccurrence: null,
  };
  value.nextOccurrence = occurrenceOn(value, '2026-06-08');
  return value;
}
function run(owner = schedule(), date = '2026-06-01', id = 'fictional-run'): PreparationRun {
  const occurrence = occurrenceOn(owner, date);
  assert.ok(occurrence);
  return { id, scheduleId: owner.id, occurrence, status: 'SCHEDULED', attempts: 0,
    maxAttempts: owner.maxAttempts, retryDelayMs: owner.retryDelayMs,
    claimId: null, leaseUntil: null, nextRetryAt: null, editionId: null, editionRevision: null,
    failure: null, missedSince: null, createdAt: occurrence.at, updatedAt: occurrence.at };
}
function edition(date = '2026-06-01', timezone = 'UTC'): ActiveEdition {
  return { id: 'fictional-edition', date, timezone, revision: 1, status: 'ASSEMBLING', createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z`, sections: sectionIds.map(id => ({ id, placements: [] })), suggestions: [] };
}
function state(): State { const owner = schedule(); return { ...emptyState(), schedules: [owner], preparationRuns: [run(owner)] }; }
async function fixture(change: (repo: JsonRepository, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-scheduling-storage-'));
  try { await change(new JsonRepository(join(directory, 'fictional.json')), directory); }
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
const withSchedule = (value: unknown): unknown => ({ ...emptyState(), schedules: [value] });
const withRun = (value: unknown): unknown => ({ ...emptyState(), schedules: [schedule()], preparationRuns: [value] });

test('schema 6 roundtrips procedural scheduling states without adding editorial approval or publication', async () => fixture(async repo => {
  const value = state(), owner = value.schedules[0];
  owner.updatedAt = '2026-07-13T12:00:00.000Z'; owner.lastEvaluatedAt = owner.updatedAt;
  owner.nextOccurrence = occurrenceOn(owner, '2026-07-20');
  const scheduled = run(owner, '2026-06-01', 'scheduled');
  const claimed = { ...run(owner, '2026-06-08', 'claimed'), status: 'CLAIMED' as const, attempts: 1, claimId: 'claim-one', leaseUntil: '2026-06-08T12:00:30.000Z' };
  const preparing = { ...run(owner, '2026-06-15', 'preparing'), status: 'PREPARING' as const, attempts: 2, claimId: 'claim-two', leaseUntil: '2026-06-15T12:00:30.000Z' };
  const failed = { ...run(owner, '2026-06-22', 'failed'), status: 'FAILED' as const, attempts: 1, failure: 'TRANSIENT_FAILURE' as const, nextRetryAt: '2026-06-22T12:00:01.000Z' };
  const cancelled = { ...run(owner, '2026-06-29', 'cancelled'), status: 'CANCELLED' as const, failure: 'PAUSED' as const };
  const attention = { ...run(owner, '2026-07-06', 'attention'), status: 'NEEDS_ATTENTION' as const, failure: 'MISSED_WINDOW' as const, missedSince: '2026-06-29T12:00:00.000Z' };
  const prepared = { ...run(owner, '2026-07-13', 'prepared'), status: 'PREPARED' as const, attempts: 1, editionId: 'fictional-edition', editionRevision: 1 };
  value.preparationRuns = [scheduled, claimed, preparing, failed, cancelled, attention, prepared];
  value.editions = [edition('2026-07-13')];
  value.audit.push({ id: 'fictional-audit', storyId: null, action: 'PREPARATION_PREPARED', actor: 'scheduler-service', at, version: null, scheduleId: owner.id, preparationRunId: prepared.id });
  await writeFile(repo.file, JSON.stringify(value));
  assert.deepEqual(await repo.read(), value);
  await repo.transact(() => undefined);
  const saved = await repo.read();
  assert.deepEqual(saved, value);
  assert.deepEqual(saved.approvals, []);
  assert.deepEqual(saved.editionReviews, []);
  assert.deepEqual(saved.revisions, []);
  saved.schedules[0].name = 'Caller mutation'; saved.preparationRuns[0].occurrence.date = '1900-01-01';
  assert.deepEqual(await repo.read(), value);
}));

test('scheduling storage rejects incomplete definitions, noncanonical configuration and administration fields', async () => fixture(async (repo, directory) => {
  const value = schedule();
  const invalid: unknown[] = [
    ...['', ' ', 'x'.repeat(129), 'invalid:id'].map(id => ({ ...value, id, nextOccurrence: null })),
    ...['   ', 'untrimmed  name', 'x'.repeat(81)].map(name => ({ ...value, name })),
    ...['CST', '+01:00', 'Not/A_Zone', 'US/Eastern', 'GMT'].map(timezone => ({ ...value, timezone, nextOccurrence: null })),
    ...['24:00', '2:30', '12:60'].map(localTime => ({ ...value, localTime, nextOccurrence: null })),
    ...[[], [1, 1], [2, 1], [7]].map(weekdays => ({ ...value, weekdays, nextOccurrence: null })),
    { ...value, maxAttempts: 0 }, { ...value, maxAttempts: 4 }, { ...value, retryDelayMs: 999 }, { ...value, retryDelayMs: 3600001 },
    { ...value, catchUpWindowMs: 999 }, { ...value, catchUpWindowMs: 86400001 }, { ...value, enabled: 'true' },
    { ...value, createdAt: '2026-02-30T00:00:00Z' }, { ...value, updatedAt: 'not-a-date' }, { ...value, lastEvaluatedAt: '2026-06-01' },
    { ...value, publishAutomatically: true }, { ...value, reviewerIdentity: 'invented-authority' }, { ...value, maxAttempts: undefined }
  ];
  await rejected(repo, directory, invalid.map(withSchedule));
}));

test('run occurrence identity must match its schedule, weekday and deterministic DST choice', async () => fixture(async (repo, directory) => {
  const value = run();
  const invalid: unknown[] = [
    { ...value, scheduleId: 'missing' }, { ...value, maxAttempts: 2 }, { ...value, retryDelayMs: 2000 },
    { ...value, occurrence: { ...value.occurrence, key: 'foreign-key' } },
    { ...value, occurrence: { ...value.occurrence, localTime: '13:00' } },
    { ...value, occurrence: { ...value.occurrence, timezone: 'GMT' } },
    { ...value, occurrence: { ...value.occurrence, at: '2026-06-01T12:01:00.000Z' } },
    { ...value, occurrence: { ...value.occurrence, key: 'fictional-schedule:2026-06-02', date: '2026-06-02', at: '2026-06-02T12:00:00.000Z' } },
    { ...value, occurrence: { ...value.occurrence, published: true } },
    { ...value, occurrence: { ...value.occurrence, date: '2026-02-30' } }
  ];
  await rejected(repo, directory, invalid.map(withRun));
  for (const localTime of ['02:30', '01:30']) {
    const owner = { ...schedule(), ...validateDefinition({ name: 'DST fixture', timezone: 'America/New_York', localTime, weekdays: [0], enabled: true, retryDelayMs: 1000 }), nextOccurrence: null };
    const date = localTime === '02:30' ? '2026-03-08' : '2026-11-01';
    const wrong = { ...value, occurrence: { key: `${owner.id}:${date}`, date, timezone: owner.timezone, localTime, at: localTime === '02:30' ? '2026-03-08T07:30:00.000Z' : '2026-11-01T06:30:00.000Z' } };
    await rejected(repo, directory, [{ ...emptyState(), schedules: [owner], preparationRuns: [wrong] }]);
  }
}));

test('claims, retry attempts and terminal outcomes reject impossible or authority-bearing combinations', async () => fixture(async (repo, directory) => {
  const value = run();
  const active = { ...value, status: 'CLAIMED', attempts: 1, claimId: 'claim', leaseUntil: '2026-06-01T12:00:30.000Z' };
  const failed = { ...value, status: 'FAILED', attempts: 1, failure: 'TRANSIENT_FAILURE', nextRetryAt: '2026-06-01T12:00:01.000Z' };
  const invalid: unknown[] = [
    ...[-1, .5, 4, Infinity].map(attempts => ({ ...value, attempts })), { ...value, attempts: 1 }, { ...value, status: 'PUBLISHED' },
    { ...active, claimId: null }, { ...active, leaseUntil: null }, { ...active, leaseUntil: at }, { ...active, failure: 'INTERRUPTED' }, { ...active, nextRetryAt: at }, { ...active, attempts: 0 },
    { ...failed, attempts: 0 }, { ...failed, nextRetryAt: null }, { ...failed, failure: 'PRIVATE_PROVIDER_EXCEPTION' },
    { ...failed, attempts: 3 }, { ...failed, failure: 'RETRY_EXHAUSTED', nextRetryAt: null },
    { ...value, status: 'NEEDS_ATTENTION', failure: null }, { ...value, status: 'CANCELLED', failure: 'RETENTION_HOLD' },
    { ...value, status: 'PREPARED', attempts: 1 }, { ...value, editionId: 'fictional-edition', editionRevision: null },
    { ...value, status: 'CANCELLED', failure: 'CANCELLED', claimId: 'claim', leaseUntil: '2026-06-01T12:00:30.000Z' },
    { ...value, approved: true }, { ...value, paidProvider: 'unsupported' }, { ...value, missedSince: 'not-a-date' }
  ];
  await rejected(repo, directory, invalid.map(withRun));
  const exhausted = { ...failed, attempts: 3, failure: 'RETRY_EXHAUSTED', nextRetryAt: null };
  await writeFile(repo.file, JSON.stringify(withRun(exhausted)));
  assert.equal((await repo.read()).preparationRuns[0].status, 'FAILED');
}));

test('schedule and occurrence uniqueness and bounded collections fail closed', async () => fixture(async (repo, directory) => {
  const value = state(), owner = value.schedules[0];
  await rejected(repo, directory, [
    { ...value, schedules: [owner, owner] },
    { ...value, preparationRuns: [run(owner), { ...run(owner, '2026-06-08'), id: 'fictional-run' }] },
    { ...value, preparationRuns: [run(owner), { ...run(owner), id: 'different-run' }] },
    { ...value, preparationRuns: [{ ...run(owner), id: 'x'.repeat(129) }] },
    { ...emptyState(), schedules: Array.from({ length: 33 }, (_, index) => ({ ...owner, id: `schedule-${index}`, nextOccurrence: null })) },
    { ...value, preparationRuns: Array.from({ length: 4097 }, (_, index) => {
      const date = new Date(Date.parse('2026-06-01T12:00:00.000Z') + index * 7 * 86400000).toISOString().slice(0, 10);
      return { ...run(owner), id: `run-${index}`, occurrence: { key: `${owner.id}:${date}`, date, timezone: 'UTC', localTime: '12:00', at: `${date}T12:00:00.000Z` } };
    }) }
  ]);
}));

test('prepared runs bind only to their exact assembling edition and retain safe history after invalidation', async () => fixture(async (repo, directory) => {
  const value = state(), target = edition();
  value.editions = [target];
  value.preparationRuns[0] = { ...value.preparationRuns[0], status: 'PREPARED', attempts: 1, editionId: target.id, editionRevision: 1 };
  await writeFile(repo.file, JSON.stringify(value));
  assert.equal((await repo.read()).preparationRuns[0].status, 'PREPARED');
  const reviewed = { ...value, editions: [target, { ...target, revision: 2, status: 'NEEDS_REVIEW' }], editionReviews: [{ editionId: target.id, fromRevision: 1, toRevision: 2, fromState: 'ASSEMBLING', toState: 'NEEDS_REVIEW', actorAssertion: 'fictional-reviewer', unauthenticated: true, at }] };
  await writeFile(repo.file, JSON.stringify(reviewed));
  assert.equal((await repo.read()).preparationRuns[0].status, 'PREPARED');
  await rejected(repo, directory, [
    { ...value, editions: [] }, { ...value, preparationRuns: [{ ...value.preparationRuns[0], editionRevision: 2 }] },
    { ...value, editions: [{ ...target, date: '2026-06-02' }] }, { ...value, editions: [{ ...target, timezone: 'America/Chicago' }] },
    { ...value, editions: [{ ...target, status: 'NEEDS_REVIEW' }] },
    { ...value, preparationRuns: [{ ...value.preparationRuns[0], failure: 'INELIGIBLE_CONTENT' }] }
  ]);
  const { sections: _licensedSections, suggestions: _suggestions, ...base } = target;
  const attention = { ...value, editions: [{ ...base, status: 'INVALIDATED', reason: 'STALE_OR_INELIGIBLE' }], preparationRuns: [{ ...value.preparationRuns[0], status: 'NEEDS_ATTENTION', failure: 'INELIGIBLE_CONTENT' }] };
  await writeFile(repo.file, JSON.stringify(attention));
  assert.equal((await repo.read()).preparationRuns[0].editionId, target.id);
  await writeFile(repo.file, JSON.stringify({ ...attention, editions: [] }));
  assert.equal((await repo.read()).preparationRuns[0].status, 'NEEDS_ATTENTION');
}));

test('structured scheduling audit identifiers are optional bounded data and never publication authority', async () => fixture(async (repo, directory) => {
  const event = { id: 'event', storyId: null, action: 'PREPARATION_SCHEDULED', actor: 'scheduler-service', at, version: null };
  const value = { ...state(), audit: [{ ...event, scheduleId: 'fictional-schedule', preparationRunId: 'fictional-run' }] };
  await writeFile(repo.file, JSON.stringify(value));
  assert.deepEqual((await repo.read()).audit, value.audit);
  assert.equal(Object.hasOwn((await repo.read()).audit[0], 'subjectId'), false);
  const invalid: unknown[] = [];
  for (const key of ['scheduleId', 'preparationRunId']) {
    for (const id of ['', ' ', 'x'.repeat(129), null, 3]) invalid.push({ ...state(), audit: [{ ...event, [key]: id }] });
  }
  await rejected(repo, directory, invalid);
}));

test('an injected scheduling commit failure rolls back the migrated file, schedule, run and audit together', async () => fixture(async (repo, directory) => {
  const { schedules: _newSchedules, preparationRuns: _newRuns, ...legacy } = emptyState();
  const bytes = JSON.stringify({ ...legacy, schema: 5 }, null, 2) + '\n';
  await writeFile(repo.file, bytes);
  const injected = new Error('Injected pre-rename failure');
  let attempts = 0;
  const failing = new JsonRepository(repo.file, { beforeCommit: () => {
    attempts++;
    assert.equal(readFileSync(repo.file, 'utf8'), bytes);
    const temps = readdirSync(directory).filter(name => name.endsWith('.tmp'));
    assert.equal(temps.length, 1);
    const staged = JSON.parse(readFileSync(join(directory, temps[0]), 'utf8'));
    assert.equal(staged.schema, 6);
    assert.equal(staged.schedules.length, 1); assert.equal(staged.preparationRuns.length, 1); assert.equal(staged.audit.length, 1);
    if (attempts === 1) throw injected;
  } });
  const change = (value: State) => {
    const owner = schedule(), item = run(owner);
    value.schedules.push(owner); value.preparationRuns.push(item);
    value.audit.push({ id: 'event', storyId: null, action: 'PREPARATION_SCHEDULED', actor: 'scheduler-service', at, version: null, scheduleId: owner.id, preparationRunId: item.id });
    return item;
  };
  await assert.rejects(failing.transact(change), error => error === injected);
  assert.equal(await readFile(repo.file, 'utf8'), bytes);
  assert.deepEqual(await readdir(directory), ['fictional.json']);
  assert.deepEqual((await repo.read()).schedules, []); assert.deepEqual((await repo.read()).preparationRuns, []); assert.deepEqual((await repo.read()).audit, []);
  await failing.transact(change);
  const saved = await repo.read();
  assert.equal(attempts, 2); assert.equal(saved.schedules.length, 1); assert.equal(saved.preparationRuns.length, 1); assert.equal(saved.audit.length, 1);
  const committed = await readFile(repo.file, 'utf8');
  await repo.transact(() => undefined);
  assert.equal(await readFile(repo.file, 'utf8'), committed);
  assert.deepEqual(await readdir(directory), ['fictional.json']);
}));
