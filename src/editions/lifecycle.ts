import { randomUUID } from 'node:crypto';
import type { State } from '../newsroom/model.ts';
import { timestamp } from '../ingestion/metadata.ts';
import { reconcilePreparedRuns } from '../scheduling/lifecycle.ts';
import { buildPlacement } from './eligibility.ts';
import { sectionIds, type InvalidEdition } from './types.ts';

function stableJSON(value: unknown): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted)
    : item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted((item as Record<string, unknown>)[key])]))
      : item;
  return JSON.stringify(sorted(value));
}

function safeDate(value: string, fallback: string): string {
  try {
    const time = timestamp(value);
    return time <= timestamp(fallback) ? new Date(time).toISOString() : fallback;
  } catch { return fallback; }
}

/** Revalidate every retained revision, including earlier copies of licensed text. */
export function invalidateEditions(state: State, at: string): number {
  const now = timestamp(at), cleanupAt = new Date(now).toISOString();
  const editions = new Set<string>();
  let count = 0;
  state.editions = state.editions.map(edition => {
    if (edition.status === 'INVALIDATED') return edition;
    try {
      if (state.retentionReviewRequired || !Array.isArray(edition.sections)
        || edition.sections.length !== sectionIds.length) throw Error('Ineligible edition');
      for (const [index, section] of edition.sections.entries()) {
        if (section.id !== sectionIds[index] || !Array.isArray(section.placements)) throw Error('Invalid edition section');
        for (const placement of section.placements) {
          const rebuilt = buildPlacement(state, placement.storyId, placement.storyVersion, placement.featured, at);
          if (timestamp(placement.expiresAt) <= now || stableJSON(placement) !== stableJSON(rebuilt)) throw Error('Stale edition placement');
        }
      }
      return edition;
    } catch {
      editions.add(edition.id); count++;
      // Whitelisting removes every snapshot, suggestion, linkage and hidden field.
      const invalid: InvalidEdition = { id: edition.id, date: edition.date, timezone: edition.timezone,
        revision: edition.revision, createdAt: safeDate(edition.createdAt, cleanupAt),
        updatedAt: cleanupAt, status: 'INVALIDATED', reason: 'STALE_OR_INELIGIBLE' };
      return invalid;
    }
  });
  state.editionReviews = state.editionReviews.map(review => editions.has(review.editionId)
    ? { editionId: review.editionId, fromRevision: review.fromRevision, toRevision: review.toRevision,
      fromState: review.fromState, toState: review.toState, actorAssertion: '[invalidated]',
      unauthenticated: true, at: safeDate(review.at, cleanupAt) }
    : review);
  for (let index = 0; index < count; index++) {
    state.audit.push({ id: randomUUID(), storyId: null, action: 'EDITION_INVALIDATED',
      actor: 'edition-service', at: cleanupAt, version: null });
  }
  reconcilePreparedRuns(state, cleanupAt);
  return count;
}
