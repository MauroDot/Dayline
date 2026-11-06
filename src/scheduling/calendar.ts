import type { Occurrence, PreparationSchedule, ScheduleDefinition } from './types.ts';

type Configuration = Omit<PreparationSchedule, 'id' | 'createdAt' | 'updatedAt' | 'lastEvaluatedAt' | 'nextOccurrence'>;
const keys = ['name', 'timezone', 'localTime', 'weekdays', 'enabled', 'maxAttempts', 'retryDelayMs', 'catchUpWindowMs'] as const;
const utcAliases = new Set(['utc', 'gmt', 'uct', 'universal', 'zulu']);
const formatters = new Map<string, Intl.DateTimeFormat>();
const hour = 3_600_000;
function fail(): never { throw Error('Invalid preparation schedule calendar configuration'); }

function zone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100
    || (!utcAliases.has(value.toLowerCase()) && !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/.test(value))) fail();
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone; }
  catch { fail(); }
}

/** Calendar configuration carries no reviewer, publication or execution authority. */
export function validateDefinition(input: ScheduleDefinition): Configuration {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !(keys as readonly string[]).includes(key))
      || Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !descriptor.enumerable || !('value' in descriptor))) fail();
    if (typeof input.name !== 'string' || input.name.length > 80 || !/^[A-Za-z0-9 _-]+$/.test(input.name)
      || !/[A-Za-z0-9]/.test(input.name) || typeof input.localTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.localTime)
      || !Array.isArray(input.weekdays) || input.weekdays.length === 0 || input.weekdays.length > 7
      || Object.getPrototypeOf(input.weekdays) !== Array.prototype
      || Reflect.ownKeys(input.weekdays).length !== input.weekdays.length + 1
      || Reflect.ownKeys(input.weekdays).some(key => key !== 'length' && (typeof key !== 'string'
        || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.weekdays.length))
      || Object.values(Object.getOwnPropertyDescriptors(input.weekdays)).some(descriptor => !('value' in descriptor))
      || input.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)
      || new Set(input.weekdays).size !== input.weekdays.length) fail();
    const enabled = Object.hasOwn(input, 'enabled') ? input.enabled : false;
    const maxAttempts = Object.hasOwn(input, 'maxAttempts') ? input.maxAttempts : 3;
    const retryDelayMs = Object.hasOwn(input, 'retryDelayMs') ? input.retryDelayMs : 60_000;
    const catchUpWindowMs = Object.hasOwn(input, 'catchUpWindowMs') ? input.catchUpWindowMs : 900_000;
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(maxAttempts) || maxAttempts! < 1 || maxAttempts! > 3
      || !Number.isSafeInteger(retryDelayMs) || retryDelayMs! < 1000 || retryDelayMs! > 3_600_000
      || !Number.isSafeInteger(catchUpWindowMs) || catchUpWindowMs! < 1000 || catchUpWindowMs! > 86_400_000) fail();
    return { name: input.name.trim().replace(/ +/g, ' '), timezone: zone(input.timezone), localTime: input.localTime,
      weekdays: [...input.weekdays].sort((left, right) => left - right), enabled,
      maxAttempts: maxAttempts!, retryDelayMs: retryDelayMs!, catchUpWindowMs: catchUpWindowMs! };
  } catch { fail(); }
}

function instant(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) fail();
  const parsed = Date.parse(value);
  const expected = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== expected) fail();
  return parsed;
}

function dateInstant(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
  return instant(`${value}T00:00:00.000Z`);
}

function formatter(timezone: string): Intl.DateTimeFormat {
  let current = formatters.get(timezone);
  if (!current) {
    current = new Intl.DateTimeFormat('en-GB-u-ca-iso8601-nu-latn', { timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit', era: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(timezone, current);
  }
  return current;
}

function parts(at: number, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const values = Object.fromEntries(formatter(timezone).formatToParts(at).map(part => [part.type, part.value]));
  const year = Number(values.year);
  return { year: values.era === 'BC' ? 1 - year : year, month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
}

function utcFromParts(value: ReturnType<typeof parts>): number {
  const result = new Date(0);
  result.setUTCFullYear(value.year, value.month - 1, value.day);
  result.setUTCHours(value.hour, value.minute, value.second, 0);
  return result.getTime();
}

/** The schedule's calendar date, independently of the host's operating-system zone. */
export function calendarDate(at: string, timezone: string): string {
  const value = parts(instant(at), zone(timezone));
  if (value.year < 0 || value.year > 9999) fail();
  return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

function scheduleConfiguration(schedule: PreparationSchedule): Configuration {
  if (!schedule || typeof schedule.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(schedule.id)) fail();
  return validateDefinition(Object.fromEntries(keys.map(key => [key, schedule[key]])) as unknown as ScheduleDefinition);
}

/** Gaps are skipped and folds resolve to the earliest matching UTC instant only. */
export function occurrenceOn(schedule: PreparationSchedule, date: string): Occurrence | null {
  try {
    const configuration = scheduleConfiguration(schedule), midnight = dateInstant(date);
    if (!configuration.weekdays.includes(new Date(midnight).getUTCDay())) return null;
    const [wantedHour, wantedMinute] = configuration.localTime.split(':').map(Number);
    const naive = midnight + wantedHour * hour + wantedMinute * 60_000;
    const offsets = new Set<number>();
    // Sample offsets on both sides of any nearby transition, including a whole
    // skipped dateline date. Offsets are not rounded to hours or assumed static.
    for (let delta = -48; delta <= 48; delta += 3) {
      const sample = naive + delta * hour;
      offsets.add(utcFromParts(parts(sample, configuration.timezone)) - sample);
    }
    const candidates = [...offsets].map(offset => naive - offset).filter(candidate => {
      const local = parts(candidate, configuration.timezone);
      return local.year === Number(date.slice(0, 4)) && local.month === Number(date.slice(5, 7))
        && local.day === Number(date.slice(8, 10)) && local.hour === wantedHour && local.minute === wantedMinute && local.second === 0;
    });
    if (!candidates.length) return null;
    return { key: `${schedule.id}:${date}`, date, timezone: configuration.timezone, localTime: configuration.localTime,
      at: new Date(Math.min(...candidates)).toISOString() };
  } catch { fail(); }
}

function shiftedDate(date: string, days: number): string | null {
  const result = new Date(dateInstant(date));
  result.setUTCDate(result.getUTCDate() + days);
  const value = result.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** Search at most sixteen local dates, using calendar addition rather than 24h UTC intervals. */
export function nextOccurrence(schedule: PreparationSchedule, at: string, inclusive = false): Occurrence | null {
  if (typeof inclusive !== 'boolean') fail();
  const now = instant(at), configuration = scheduleConfiguration(schedule);
  const current = calendarDate(at, configuration.timezone);
  for (let days = 0; days < 16; days++) {
    const date = shiftedDate(current, days); if (date === null) break;
    const occurrence = occurrenceOn(schedule, date);
    if (occurrence && (inclusive ? instant(occurrence.at) >= now : instant(occurrence.at) > now)) return occurrence;
  }
  return null;
}

export function latestOccurrence(schedule: PreparationSchedule, at: string): Occurrence | null {
  const now = instant(at), configuration = scheduleConfiguration(schedule);
  const current = calendarDate(at, configuration.timezone);
  for (let days = 0; days < 16; days++) {
    const date = shiftedDate(current, -days); if (date === null) break;
    const occurrence = occurrenceOn(schedule, date);
    if (occurrence && instant(occurrence.at) <= now) return occurrence;
  }
  return null;
}
