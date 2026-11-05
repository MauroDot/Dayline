import { createHash, randomUUID } from 'node:crypto';
import type { State, Story } from '../newsroom/model.ts';
import { canonicalURL } from '../newsroom/model.ts';
import { eligibleSource } from '../ingestion/eligibility.ts';
import { retentionDeadline, sourceId, timestamp } from '../ingestion/metadata.ts';
import { policyStatus, type RegistryPolicy } from '../ingestion/policies.ts';
import type { DraftPolicyReference, GroundedEvidence } from './types.ts';
import { assertSafeSource, validateOutput } from './validation.ts';

function sortedJSON(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  return JSON.stringify(sorted(value));
}

/** Digest the complete captured grant; property insertion order cannot change it. */
export function policyDigest(policy: RegistryPolicy): string {
  return createHash('sha256').update(sortedJSON(policy)).digest('hex');
}

export interface DraftContext {
  story: Story;
  evidence: GroundedEvidence[];
  sourceIds: string[];
  policies: DraftPolicyReference[];
  expiresAt: string;
}

/** Construct an allowlisted, currently licensed evidence context; never invent claims. */
export function buildDraftContext(state: State, storyId: string, at: string): DraftContext {
  const now = timestamp(at);
  const story = state.revisions.filter(revision => revision.id === storyId).at(-1);
  if (state.retentionReviewRequired || !story || story.retentionRedacted
    || !['DRAFT', 'NEEDS_REVIEW'].includes(story.status)
    || !Number.isSafeInteger(story.version) || story.version < 1) throw Error('Ineligible editorial story');
  if (!Array.isArray(story.evidence) || !story.evidence.length || story.evidence.length > 16
    || new Set(story.evidence.map(evidence => evidence.id)).size !== story.evidence.length
    || !Array.isArray(story.sourceIds) || !story.sourceIds.length
    || new Set(story.sourceIds).size !== story.sourceIds.length) throw Error('Invalid editorial evidence');
  assertSafeSource(story.headline); assertSafeSource(story.summary);
  const ids = [...story.sourceIds].sort();
  const policies: DraftPolicyReference[] = [];
  let expires = Infinity;
  for (const id of ids) {
    const matches = state.sources.filter(source => source.id === id);
    const records = state.managedSources.filter(record => record.sourceId === id);
    if (matches.length !== 1 || records.length !== 1) throw Error('Managed editorial source required');
    const source = matches[0], record = records[0], policy = record.policy;
    if (record.providerId !== 'fictional-fixture' || policy.providerId !== record.providerId
      || policyStatus(policy, at) !== 'ACTIVE' || !policy.aiSummarization
      || !policy.internalAnalysis || !policy.licensedExcerpt
      || !new URL(source.url).hostname.endsWith('.test')
      || !new URL(record.providerMetadata.url).hostname.endsWith('.test')
      || source.id !== sourceId(record.providerMetadata.url)
      || source.canonicalUrl !== canonicalURL(source.url)
      || source.canonicalUrl !== canonicalURL(record.providerMetadata.url)
      || !eligibleSource(state, source, at)) throw Error('Ineligible editorial source rights');
    const deadline = Math.min(retentionDeadline(record), timestamp(policy.expiresAt));
    if (!Number.isFinite(deadline) || deadline <= now) throw Error('Expired editorial source');
    expires = Math.min(expires, deadline);
    policies.push({ sourceId: id, providerId: record.providerId, policyId: policy.id,
      policyVersion: policy.version, snapshotDigest: policyDigest(policy) });
  }
  const evidence = story.evidence.map(entry => {
    if (typeof entry.id !== 'string' || !entry.id.trim() || typeof entry.claim !== 'string' || !entry.claim.trim()
      || typeof entry.uncertainty !== 'string' || entry.verification !== 'VERIFIED'
      || !Array.isArray(entry.support) || !entry.support.length || !Array.isArray(entry.contradict)
      || new Set(entry.support).size !== entry.support.length
      || new Set(entry.contradict).size !== entry.contradict.length
      || [...entry.support, ...entry.contradict].some(id => !ids.includes(id))) throw Error('Unverified editorial evidence');
    assertSafeSource(entry.claim); assertSafeSource(entry.uncertainty);
    return { id: entry.id, claim: entry.claim, support: [...entry.support],
      contradict: [...entry.contradict], uncertainty: entry.uncertainty };
  });
  return { story: structuredClone(story), evidence, sourceIds: ids, policies, expiresAt: new Date(expires).toISOString() };
}

function safeDate(value: string, fallback: string): string {
  try { return new Date(timestamp(value)).toISOString(); } catch { return fallback; }
}

/** Remove proposal payload and linkages as soon as any captured authorization fails. */
export function invalidateDrafts(state: State, at: string): number {
  const now = timestamp(at), cleanupAt = new Date(now).toISOString();
  const invalidated = new Set<string>();
  state.drafts = state.drafts.map(draft => {
    if (draft.status === 'INVALIDATED') return draft;
    try {
      const context = buildDraftContext(state, draft.storyId, at);
      const expiry = timestamp(draft.expiresAt);
      if (draft.storyVersion !== context.story.version || timestamp(draft.generatedAt) > now
        || now >= expiry || expiry > timestamp(context.expiresAt)
        || sortedJSON([...draft.sourceIds].sort()) !== sortedJSON(context.sourceIds)
        || sortedJSON([...draft.policies].sort((a, b) => a.sourceId.localeCompare(b.sourceId))) !== sortedJSON(context.policies)) {
        throw Error('Stale editorial proposal');
      }
      validateOutput(draft.output, context.evidence);
      return draft;
    } catch {
      invalidated.add(draft.id);
      return { id: draft.id, status: 'INVALIDATED', invalidatedAt: cleanupAt, reason: 'STALE_OR_INELIGIBLE' };
    }
  });
  state.draftReviews = state.draftReviews.map(review => invalidated.has(review.draftId)
    ? { draftId: review.draftId, fromVersion: review.fromVersion, toVersion: review.toVersion,
      storyVersion: null, fromState: review.fromState, toState: review.toState,
      actorAssertion: '[invalidated]', unauthenticated: true, at: safeDate(review.at, cleanupAt) }
    : review);
  for (const _id of invalidated) {
    state.audit.push({ id: randomUUID(), storyId: null, action: 'AI_DRAFT_INVALIDATED',
      actor: 'editorial-service', at: cleanupAt, version: null });
  }
  return invalidated.size;
}
