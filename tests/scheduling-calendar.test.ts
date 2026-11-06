import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDate, latestOccurrence, nextOccurrence, occurrenceOn, validateDefinition } from '../src/scheduling/calendar.ts';
import type { PreparationSchedule, ScheduleDefinition } from '../src/scheduling/types.ts';

const at = '2026-01-01T00:00:00.000Z';
const definition: ScheduleDefinition = { name: 'Fictional morning preparation', timezone: 'America/Chicago', localTime: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6] };
function schedule(changes: Partial<ScheduleDefinition> = {}): PreparationSchedule {
  return { id: 'fictional-schedule', ...validateDefinition({ ...definition, ...changes }), createdAt: at, updatedAt: at,
    lastEvaluatedAt: null, nextOccurrence: null };
}
function invalid(changes: Record<string, unknown>): void {
  assert.throws(() => validateDefinition({ ...definition, ...changes } as ScheduleDefinition),
    error => error instanceof Error && error.message === 'Invalid preparation schedule calendar configuration');
}

test('schedule definitions canonicalize zones and weekdays with disabled bounded defaults', () => {
  const input = { ...definition, name: '  Fictional   morning_1-prepare ', timezone: 'US/Central', weekdays: [5, 1, 3] };
  const before = structuredClone(input), result = validateDefinition(input);
  assert.equal(result.name, 'Fictional morning_1-prepare');
  assert.equal(result.timezone, 'America/Chicago');
  assert.deepEqual(result.weekdays, [1, 3, 5]);
  assert.equal(result.enabled, false); assert.equal(result.maxAttempts, 3);
  assert.equal(result.retryDelayMs, 60000); assert.equal(result.catchUpWindowMs, 900000);
  result.weekdays.push(6); assert.deepEqual(input, before);
  for (const alias of ['UTC', 'utc', 'GMT', 'Etc/UTC', 'Etc/GMT', 'Zulu', 'UCT']) assert.equal(validateDefinition({ ...definition, timezone: alias }).timezone, 'UTC');
});

test('definition names contain only bounded plain labels rather than URLs or instructions', () => {
  assert.equal(validateDefinition({ ...definition, name: 'x'.repeat(80) }).name.length, 80);
  for (const name of ['', ' '.repeat(8), '---', 'x'.repeat(81), 'https://fiction.example.test', 'name\nother', '<script>', 'Fictional: review']) invalid({ name });
});

test('timezones require explicit named regions or UTC aliases and reject offsets or ambiguous abbreviations', () => {
  for (const timezone of ['CST', 'EST', 'PST', 'CET', '+05:45', '-0600', 'UTC+5', 'Mars/Olympus', '', ' America/Chicago ']) invalid({ timezone });
  assert.equal(validateDefinition({ ...definition, timezone: 'America/Argentina/Buenos_Aires' }).timezone,
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }).resolvedOptions().timeZone);
});

test('explicit valid IANA identifiers retain legitimate hyphens plus signs and digits', () => {
  for (const timezone of ['America/Port-au-Prince', 'Etc/GMT+5', 'Etc/GMT-0']) {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
    assert.equal(validateDefinition({ ...definition, timezone }).timezone, canonical);
  }
  assert.equal(occurrenceOn(schedule({ timezone: 'Etc/GMT+5', localTime: '09:00' }), '2026-06-01')?.at, '2026-06-01T14:00:00.000Z');
  assert.equal(occurrenceOn(schedule({ timezone: 'America/Port-au-Prince', localTime: '09:00' }), '2026-06-01')?.at, '2026-06-01T13:00:00.000Z');
  for (const timezone of ['Etc/GMT+25', 'America/Port-au-Fictional', 'UTC+05:00', '+05:00']) invalid({ timezone });
});

test('local time and weekdays are strict and duplicate-free', () => {
  for (const localTime of ['9:00', '24:00', '12:60', '09:00:00', '09:00Z', '09:00 ', '', 900]) invalid({ localTime });
  for (const weekdays of [[], [0, 0], [-1], [7], [1.5], ['1'], [NaN], [Infinity], null, Array(2)]) invalid({ weekdays });
  const disguised = [0, ,]; Object.assign(disguised, { extra: 1 }); invalid({ weekdays: disguised });
  assert.deepEqual(validateDefinition({ ...definition, localTime: '00:00', weekdays: [6, 0] }).weekdays, [0, 6]);
  assert.equal(validateDefinition({ ...definition, localTime: '23:59' }).localTime, '23:59');
});

test('retry catch-up and enabled configuration fail closed outside finite documented bounds', () => {
  for (const maxAttempts of [0, 4, 1.5, NaN, Infinity, '3', undefined]) invalid({ maxAttempts });
  for (const retryDelayMs of [0, 999, 3600001, NaN, Infinity, '1000']) invalid({ retryDelayMs });
  for (const catchUpWindowMs of [0, 999, 86400001, NaN, Infinity, '1000']) invalid({ catchUpWindowMs });
  for (const enabled of [1, 'true', null, undefined]) invalid({ enabled });
  const smallest = validateDefinition({ ...definition, enabled: true, maxAttempts: 1, retryDelayMs: 1000, catchUpWindowMs: 1000 });
  assert.equal(smallest.enabled, true); assert.equal(smallest.maxAttempts, 1);
  assert.equal(validateDefinition({ ...definition, retryDelayMs: 3600000, catchUpWindowMs: 86400000 }).retryDelayMs, 3600000);
});

test('extra authority keys symbols accessors and non-record definitions are rejected without invoking getters', () => {
  for (const key of ['id', 'createdAt', 'publish', 'approved', 'actorAssertion', 'reviewer', 'apiKey', 'editionId']) invalid({ [key]: 'FICTIONAL_UNTRUSTED_VALUE' });
  let read = false;
  const accessor = Object.defineProperty({ ...definition }, 'name', { enumerable: true, get() { read = true; return 'Not permitted'; } });
  assert.throws(() => validateDefinition(accessor)); assert.equal(read, false);
  const symbol = Object.assign({ ...definition }, { [Symbol('authority')]: true }); assert.throws(() => validateDefinition(symbol));
  for (const input of [null, undefined, [], 'schedule']) assert.throws(() => validateDefinition(input as unknown as ScheduleDefinition));
});

test('UTC calendar occurrences preserve stable schedule-date identity and disabled definitions remain previewable', () => {
  const item = schedule({ timezone: 'Etc/UTC', localTime: '09:00' });
  const occurrence = occurrenceOn(item, '2026-06-01'); assert.ok(occurrence);
  assert.deepEqual(occurrence, { key: 'fictional-schedule:2026-06-01', date: '2026-06-01', timezone: 'UTC', localTime: '09:00', at: '2026-06-01T09:00:00.000Z' });
  item.enabled = true; assert.deepEqual(occurrenceOn(item, '2026-06-01'), occurrence);
  assert.notEqual(occurrenceOn({ ...item, id: 'another-schedule' }, '2026-06-01')?.key, occurrence.key);
});

test('Chicago spring-forward gaps skip the missing local time without inventing a shifted occurrence', () => {
  const item = schedule({ localTime: '02:30' });
  assert.equal(occurrenceOn(item, '2026-03-08'), null);
  assert.equal(occurrenceOn(item, '2026-03-07')?.at, '2026-03-07T08:30:00.000Z');
  assert.equal(occurrenceOn(item, '2026-03-09')?.at, '2026-03-09T07:30:00.000Z');
  assert.equal(nextOccurrence(item, '2026-03-07T08:30:00.000Z')?.at, '2026-03-09T07:30:00.000Z');
  assert.equal(latestOccurrence(item, '2026-03-08T12:00:00.000Z')?.date, '2026-03-07');
});

test('Chicago fall-back folds emit only the earliest matching local occurrence', () => {
  const item = schedule({ localTime: '01:30' });
  assert.equal(occurrenceOn(item, '2026-11-01')?.at, '2026-11-01T06:30:00.000Z');
  assert.equal(nextOccurrence(item, '2026-11-01T06:30:00.000Z')?.at, '2026-11-02T07:30:00.000Z');
  assert.equal(nextOccurrence(item, '2026-11-01T07:00:00.000Z')?.date, '2026-11-02');
  assert.equal(latestOccurrence(item, '2026-11-01T07:30:00.000Z')?.at, '2026-11-01T06:30:00.000Z');
});

test('next and latest searches respect exact boundaries inclusivity and selected local weekdays', () => {
  const item = schedule({ timezone: 'UTC', weekdays: [1, 3], localTime: '09:00' });
  const monday = '2026-06-01T09:00:00.000Z';
  assert.equal(nextOccurrence(item, monday)?.date, '2026-06-03');
  assert.equal(nextOccurrence(item, monday, true)?.at, monday);
  assert.equal(latestOccurrence(item, monday)?.at, monday);
  assert.equal(latestOccurrence(item, '2026-06-01T08:59:59.999Z')?.date, '2026-05-27');
  assert.equal(occurrenceOn(item, '2026-06-02'), null);
});

test('weekly schedules cross a skipped Sunday within the bounded calendar search', () => {
  const item = schedule({ localTime: '02:30', weekdays: [0] });
  assert.equal(nextOccurrence(item, '2026-03-01T08:30:00.000Z')?.at, '2026-03-15T07:30:00.000Z');
  assert.equal(latestOccurrence(item, '2026-03-14T23:00:00.000Z')?.at, '2026-03-01T08:30:00.000Z');
});

test('Kathmandu quarter-hour offsets preserve exact local minutes', () => {
  const item = schedule({ timezone: 'Asia/Kathmandu', localTime: '09:00' });
  assert.equal(occurrenceOn(item, '2026-06-01')?.at, '2026-06-01T03:15:00.000Z');
  assert.equal(calendarDate('2026-06-01T18:30:00.000Z', 'Asia/Kathmandu'), '2026-06-02');
});

test('Lord Howe half-hour transitions handle both its short gap and earliest folded instant', () => {
  const gap = schedule({ timezone: 'Australia/Lord_Howe', localTime: '02:15' });
  assert.equal(occurrenceOn(gap, '2026-10-04'), null);
  assert.equal(occurrenceOn(gap, '2026-10-05')?.at, '2026-10-04T15:15:00.000Z');
  const folded = schedule({ timezone: 'Australia/Lord_Howe', localTime: '01:45' });
  assert.equal(occurrenceOn(folded, '2026-04-05')?.at, '2026-04-04T14:45:00.000Z');
  assert.equal(nextOccurrence(folded, '2026-04-04T15:00:00.000Z')?.date, '2026-04-06');
});

test('Apia dateline transition skips an entire missing local calendar date', () => {
  const item = schedule({ timezone: 'Pacific/Apia', localTime: '09:00' });
  assert.equal(occurrenceOn(item, '2011-12-30'), null);
  assert.equal(occurrenceOn(item, '2011-12-29')?.at, '2011-12-29T19:00:00.000Z');
  assert.equal(occurrenceOn(item, '2011-12-31')?.at, '2011-12-30T19:00:00.000Z');
  assert.equal(nextOccurrence(item, '2011-12-29T19:00:00.000Z')?.date, '2011-12-31');
});

test('date-boundary zones use local date rather than the UTC date at evaluation', () => {
  const east = schedule({ timezone: 'Pacific/Kiritimati', localTime: '09:00' });
  assert.equal(calendarDate('2026-06-01T12:00:00.000Z', east.timezone), '2026-06-02');
  assert.equal(nextOccurrence(east, '2026-06-01T12:00:00.000Z')?.at, '2026-06-01T19:00:00.000Z');
  const west = schedule({ timezone: 'Pacific/Honolulu', localTime: '23:30' });
  assert.equal(calendarDate('2026-06-01T05:00:00.000Z', west.timezone), '2026-05-31');
  assert.equal(nextOccurrence(west, '2026-06-01T05:00:00.000Z')?.at, '2026-06-01T09:30:00.000Z');
});

test('year and leap-day boundaries use Gregorian calendar addition', () => {
  const item = schedule({ timezone: 'UTC', localTime: '00:00' });
  assert.equal(nextOccurrence(item, '2027-12-31T23:59:59.999Z')?.date, '2028-01-01');
  assert.equal(nextOccurrence(item, '2028-02-28T00:00:00.000Z')?.date, '2028-02-29');
  assert.equal(nextOccurrence(item, '2026-02-28T00:00:00.000Z')?.date, '2026-03-01');
  assert.equal(latestOccurrence(item, '2028-01-01T00:00:00.000Z')?.date, '2028-01-01');
});

test('malformed dates timestamps schedule identities and inclusivity values fail closed', () => {
  const item = schedule({ timezone: 'UTC' });
  for (const date of ['2026-02-30', '2026-13-01', '2026-2-01', '2026-06-01Z', 'not-date']) assert.throws(() => occurrenceOn(item, date));
  for (const value of ['2026-02-30T00:00:00Z', '2026-06-01', '2026-06-01T09:00:00+00:00', 'invalid']) {
    assert.throws(() => nextOccurrence(item, value)); assert.throws(() => latestOccurrence(item, value)); assert.throws(() => calendarDate(value, 'UTC'));
  }
  assert.throws(() => occurrenceOn({ ...item, id: 'https://fiction.example.test/id' }, '2026-06-01'));
  assert.throws(() => nextOccurrence(item, at, 'yes' as unknown as boolean));
});

test('occurrence calculations do not mutate schedules and tolerate fractional UTC clock precision', () => {
  const item = schedule({ timezone: 'UTC' }), before = structuredClone(item);
  assert.equal(nextOccurrence(item, '2026-06-01T08:59:59.9Z')?.at, '2026-06-01T09:00:00.000Z');
  latestOccurrence(item, '2026-06-01T09:00:00Z'); occurrenceOn(item, '2026-06-01');
  assert.deepEqual(item, before);
});
