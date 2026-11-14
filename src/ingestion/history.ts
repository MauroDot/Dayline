import { randomUUID } from 'node:crypto';
import type { State } from '../newsroom/model.ts';
import { timestamp } from './metadata.ts';

const redacted = '[retention redacted]';
const actions = new Set([
  'STORY_CREATED', 'STORY_EDITED', 'STATUS_INGESTED', 'STATUS_CLUSTERED',
  'STATUS_DRAFT', 'STATUS_NEEDS_REVIEW', 'STATUS_APPROVED', 'STATUS_PUBLISHED',
  'STATUS_REJECTED', 'STATUS_ON_HOLD', 'STATUS_CORRECTION_REQUIRED',
]);

function safeDate(value: string, fallback: string): string {
  try { return new Date(timestamp(value)).toISOString(); }
  catch { return fallback; }
}

/**
 * Remove source-linked prose from every version, keeping only procedural history.
 * References in an older revision taint the whole story because a later revision
 * can copy prose after dropping its explicit references. Replacement story IDs
 * are random internal identities; no old-to-new map or source digest is stored.
 * Call inside the same repository transaction that removes the source metadata.
 */
export function redactEditorialHistory(state: State, sourceIds: ReadonlySet<string>, at: string): number {
  const cleanupAt = new Date(timestamp(at)).toISOString();
  const affected = new Set([
    ...state.revisions.filter(revision => revision.sourceIds.some(id => sourceIds.has(id))
      || revision.sourceHandoff?.dependencies.some(dependency => sourceIds.has(dependency.id))
      || revision.evidence.some(evidence => [...evidence.support, ...evidence.contradict].some(id => sourceIds.has(id))))
      .map(revision => revision.id),
    ...state.audit.filter(event => event.subjectId && sourceIds.has(event.subjectId) && event.storyId !== null).map(event => event.storyId!),
  ]);
  if (affected.size === 0) return 0;

  const occupied = new Set(state.revisions.map(revision => revision.id));
  const replacements = new Map<string, string>();
  for (const storyId of affected) {
    let replacement: string;
    do { replacement = `retention-${randomUUID()}`; } while (occupied.has(replacement));
    occupied.add(replacement); replacements.set(storyId, replacement);
  }
  state.revisions = state.revisions.map(revision => {
    const replacement = replacements.get(revision.id);
    if (!replacement) return revision;
    // An explicit whitelist also removes hidden provider fields or copied prose.
    return { id: replacement, headline: redacted, topic: redacted, summary: redacted,
      geography: redacted, eventAt: null, firstSeenAt: cleanupAt, updatedAt: cleanupAt,
      clusterId: null, evidence: [], sourceIds: [], status: revision.status,
      version: revision.version, retentionRedacted: true };
  });
  state.approvals = state.approvals.map(approval => {
    const replacement = replacements.get(approval.storyId);
    return replacement ? { storyId: replacement, version: approval.version, reviewer: redacted,
      at: safeDate(approval.at, cleanupAt), retentionRedacted: true } : approval;
  });
  state.audit = state.audit.map(event => {
    const replacement = event.storyId === null ? undefined : replacements.get(event.storyId);
    if (!replacement) return event;
    return { id: randomUUID(), storyId: replacement,
      action: actions.has(event.action) ? event.action : 'EDITORIAL_EVENT_REDACTED',
      actor: redacted, at: safeDate(event.at, cleanupAt), version: event.version };
  });
  return affected.size;
}
