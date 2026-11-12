import { createHash } from 'node:crypto';
import type { State } from '../newsroom/model.ts';
import type { PreparationSchedule, PreparationRun } from '../scheduling/types.ts';
import { permissions, type Permission, type Principal, type ResourceKind } from './types.ts';
import { SecurityError } from './verifier.ts';

export interface ResourceTarget { readonly kind: ResourceKind; readonly id: string }
export interface ResourceAssignment extends ResourceTarget { readonly identityId: string; readonly permission: Permission }
/** Trusted configuration only. Requests never supply their own policy or assignments. */
export interface ResourcePolicy {
  authorize(principal: Principal, permission: Permission, targets: readonly ResourceTarget[], state: Readonly<State>): void;
}
/** Policies are synchronous predicates by throwing; returned/async decisions never authorize. */
export function assertResourcePolicy(policy: ResourcePolicy, principal: Principal, permission: Permission,
  targets: readonly ResourceTarget[], state: Readonly<State>): void {
  if (!policy || typeof policy.authorize !== 'function') throw new SecurityError('PERMISSION_DENIED');
  const decision: unknown = policy.authorize(structuredClone(principal), permission, structuredClone(targets), structuredClone(state));
  if (decision !== undefined) {
    // A mistaken asynchronous implementation cannot authorize or emit an unhandled rejection.
    void Promise.resolve(decision).catch(() => undefined);
    throw new SecurityError('PERMISSION_DENIED');
  }
}
const kinds: readonly ResourceKind[] = ['STORY','DRAFT','EDITION','SCHEDULE','RUN','IDENTITY','SESSION'];
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:@./+-]{0,255}$/.test(value);
}
function assignmentKey(identityId: string, permission: Permission, target: ResourceTarget): string {
  return JSON.stringify([identityId, permission, target.kind, target.id]);
}
/** Immutable, explicit development assignments. No wildcard, ownership inference or role upgrade. */
export class AssignedResourcePolicy implements ResourcePolicy {
  readonly #assignments: ReadonlySet<string>;
  constructor(assignments: readonly ResourceAssignment[]) {
    if (!Array.isArray(assignments) || assignments.length > 1024) throw new SecurityError('PERMISSION_DENIED');
    const keys = new Set<string>();
    for (const row of assignments) {
      if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== 'id,identityId,kind,permission'
        || !identifier(row.identityId) || !identifier(row.id) || !permissions.includes(row.permission) || !kinds.includes(row.kind)) {
        throw new SecurityError('PERMISSION_DENIED');
      }
      keys.add(assignmentKey(row.identityId, row.permission, row));
    }
    this.#assignments = keys;
    Object.freeze(this);
  }
  authorize(principal: Principal, permission: Permission, targets: readonly ResourceTarget[], _state: Readonly<State>): void {
    if (!principal || !identifier(principal.identityId) || !permissions.includes(permission)
      || !Array.isArray(targets) || targets.length === 0 || targets.length > 101
      || targets.some(target => !target || !identifier(target.id) || !kinds.includes(target.kind)
        || !this.#assignments.has(assignmentKey(principal.identityId, permission, target)))) throw new SecurityError('PERMISSION_DENIED');
  }
}
/** Explicit allocation permission for one canonical edition date/timezone; grants no later ownership. */
export function editionSlot(date: string, timezone: string): string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date
    || typeof timezone !== 'string') throw new SecurityError('DOMAIN_REJECTED');
  try { return `slot:${date}@${new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone}`; }
  catch { throw new SecurityError('DOMAIN_REJECTED'); }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
/** Opaque exact-state token, not a credential; also detects same-clock schedule changes. */
export function scheduleRevision(schedule: PreparationSchedule): string {
  return createHash('sha256').update(JSON.stringify(canonical(schedule))).digest('hex');
}

/** Exact procedural run state token; claim/attempt changes invalidate prior requests. */
export function runRevision(run: PreparationRun): string {
  return createHash('sha256').update(JSON.stringify(canonical(run))).digest('hex');
}
