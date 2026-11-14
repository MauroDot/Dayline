/** Private source-to-story continuity bindings; these contain no approval or publication grant. */
import type { Story } from '../newsroom/model.ts';

export interface SourceSelection { id: string; revision: string }
export interface StorySourceHandoff { preparedAt: string; selected: SourceSelection[]; dependencies: SourceSelection[] }
export type HumanStoryInput = Omit<Story, 'status' | 'version' | 'sourceHandoff' | 'retentionRedacted'>;
export interface SourceHandoffInput { sources: SourceSelection[]; story: HumanStoryInput }
export class SourceHandoffError extends Error {
  readonly code: 'INVALID_INPUT' | 'STALE_SOURCE' | 'INELIGIBLE_SOURCE';
  constructor(code: SourceHandoffError['code']) { super(code); this.name = 'SourceHandoffError'; this.code = code; }
}

export function handoffObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(row => row.enumerable && Object.hasOwn(row, 'value'));
}
export function handoffArray(value: unknown, maximum: number, minimum = 0): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length >= minimum && value.length <= maximum
    && Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every(key => key === 'length' || typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length)
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(row => Object.hasOwn(row, 'value'));
}
export const handoffSourceId = (value: unknown): value is string => typeof value === 'string' && /^url-[a-f0-9]{64}$/.test(value);
export const handoffRevision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function utc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const time = Date.parse(value), normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, f: string | undefined) => `.${(f ?? '').padEnd(3, '0')}Z`);
  return Number.isFinite(time) && new Date(time).toISOString() === normalized;
}
export function validSourceSelections(value: unknown, maximum = 8): value is SourceSelection[] {
  return handoffArray(value, maximum, 1) && value.every(row => handoffObject(row, ['id', 'revision']) && handoffSourceId(row.id) && handoffRevision(row.revision))
    && new Set(value.map(row => (row as unknown as SourceSelection).id)).size === value.length;
}
/** Storage validation only; current authority and source eligibility belong to the guarded services. */
export function validStorySourceHandoff(value: unknown): value is StorySourceHandoff {
  if (!handoffObject(value, ['preparedAt', 'selected', 'dependencies']) || !utc(value.preparedAt)
    || !validSourceSelections(value.selected) || !validSourceSelections(value.dependencies, 64)) return false;
  const dependencies = new Map(value.dependencies.map(row => [row.id, row.revision]));
  return value.selected.every(row => dependencies.get(row.id) === row.revision);
}
