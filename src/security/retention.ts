import type { State } from '../newsroom/model.ts';
import { timestamp } from '../ingestion/metadata.ts';
import type { AuthenticatedAction, SecurityEvent } from './types.ts';

const lifetime = 7 * 86_400_000;
const capacity = 512;

function recent(at: string, now: number): boolean {
  try { const time = timestamp(at); return time <= now && time > now - lifetime; }
  catch { return false; }
}

function eligibleReceipt(state: State, receipt: AuthenticatedAction): boolean {
  if (!state.identities.some(identity => identity.id === receipt.actorId)) return false;
  if (receipt.resourceKind === 'STORY') {
    const history = state.revisions.filter(story => story.id === receipt.resourceId);
    return history.length > 0 && !history.at(-1)!.retentionRedacted
      && history.some(story => story.version === receipt.resourceVersion && !story.retentionRedacted);
  }
  if (receipt.resourceKind === 'DRAFT') {
    return state.drafts.some(draft => draft.id === receipt.resourceId && draft.status !== 'INVALIDATED'
      && receipt.resourceVersion !== null && receipt.resourceVersion > 0 && receipt.resourceVersion <= draft.version);
  }
  if (receipt.resourceKind === 'EDITION') {
    return state.editions.some(edition => edition.id === receipt.resourceId && edition.revision === receipt.resourceVersion
      && edition.status !== 'INVALIDATED');
  }
  if (receipt.resourceKind === 'RUN') {
    return state.preparationRuns.some(run => run.id === receipt.resourceId
      && !['FAILED', 'CANCELLED', 'NEEDS_ATTENTION'].includes(run.status));
  }
  if (receipt.resourceKind === 'SCHEDULE') return state.schedules.some(schedule => schedule.id === receipt.resourceId);
  if (receipt.resourceKind === 'IDENTITY') return state.identities.some(identity => identity.id === receipt.resourceId);
  if (receipt.resourceKind === 'SESSION') return state.sessions.some(session => session.auditRef === receipt.resourceId);
  return false;
}

function newest<T extends { at: string }>(rows: T[]): T[] {
  // Retain chronological ordering, breaking equal timestamps by insertion order.
  return rows.map((row, index) => ({ row, index }))
    .sort((a, b) => timestamp(a.row.at) - timestamp(b.row.at) || a.index - b.index)
    .slice(-capacity).map(value => value.row);
}

/** Bounded security metadata only. This never changes editorial content or identities. */
export function pruneSecurityState(state: State, at: string): number {
  const now = timestamp(at), before = state.securityAudit.length + state.authenticatedActions.length;
  state.securityAudit = newest(state.securityAudit.filter(event => recent(event.at, now)).map((event): SecurityEvent => ({
    id: event.id, at: event.at, category: event.category, code: event.code, userRef: event.userRef,
    sessionRef: event.sessionRef, subjectRef: event.subjectRef, permission: event.permission,
  })));
  state.authenticatedActions = newest(state.authenticatedActions.filter(receipt => recent(receipt.at, now)
    && eligibleReceipt(state, receipt)).map((receipt): AuthenticatedAction => ({
    id: receipt.id, actorId: receipt.actorId, identityRevision: receipt.identityRevision,
    sessionRef: receipt.sessionRef, permission: receipt.permission, resourceKind: receipt.resourceKind,
    resourceId: receipt.resourceId, resourceVersion: receipt.resourceVersion, at: receipt.at,
  })));
  return before - state.securityAudit.length - state.authenticatedActions.length;
}
