import { createHash } from 'node:crypto';
import { canonicalURL, validateSource, type State, type Story } from '../newsroom/model.ts';
import { eligibleSource } from '../ingestion/eligibility.ts';
import { metadata, retentionDeadline, sourceId, timestamp } from '../ingestion/metadata.ts';
import { getPolicy, policyStatus, type RegistryPolicy } from '../ingestion/policies.ts';
import { assertStorySourceHandoff, sourceHandoffValidUntil } from '../source-handoff/domain.ts';
import type { EditionEvidence, EditionSource, Placement } from './types.ts';

const bounds = Object.freeze({ sources: 64, evidence: 16, headline: 512, summary: 4096, uncertainty: 2048 });
function fail(): never { throw Error('Ineligible edition placement'); }
function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && value.length <= max && (empty || Boolean(value.trim()));
}
function strings(value: unknown, max: number, empty = false): value is string[] {
  return Array.isArray(value) && value.length <= max && (empty || value.length > 0)
    && value.every(item => text(item, 256)) && new Set(value).size === value.length;
}
function policyDigest(policy: RegistryPolicy): string {
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(policy).sort()
    .map(key => [key, policy[key as keyof RegistryPolicy]])))).digest('hex');
}

function approvedStory(state: State, storyId: string, storyVersion: number, now: number): Story {
  if (!text(storyId, 256) || !Number.isSafeInteger(storyVersion) || storyVersion < 1 || state.retentionReviewRequired) fail();
  const history = state.revisions.filter(story => story.id === storyId);
  if (!history.length || history.some((story, index) => !Number.isSafeInteger(story.version) || story.version < 1
    || (index > 0 && history[index - 1].version >= story.version))) fail();
  const story = history.at(-1)!;
  if (story.version !== storyVersion || story.status !== 'APPROVED' || story.retentionRedacted
    || !text(story.headline, bounds.headline) || !text(story.summary, bounds.summary)
    || !strings(story.sourceIds, bounds.sources)
    || !Array.isArray(story.evidence) || !story.evidence.length || story.evidence.length > bounds.evidence
    || new Set(story.evidence.map(item => item.id)).size !== story.evidence.length) fail();
  timestamp(story.firstSeenAt); timestamp(story.updatedAt);
  const approvals = state.approvals.filter(approval => approval.storyId === storyId && approval.version === storyVersion);
  if (approvals.length !== 1 || approvals[0].retentionRedacted || !text(approvals[0].reviewer, 256)
    || timestamp(approvals[0].at) > now) fail();
  return story;
}

/** Exact internal approvals and captured fictional rights; no publication permission is granted. */
export function buildPlacement(state: State, storyId: string, storyVersion: number, featured: boolean, at: string): Placement {
  try {
    const now = timestamp(at);
    if (typeof featured !== 'boolean') fail();
    const story = approvedStory(state, storyId, storyVersion, now);
    assertStorySourceHandoff(state, story, at);
    const captured = new Map<string, EditionSource>();
    const visiting = new Set<string>();
    function capture(id: string): void {
      if (visiting.has(id)) fail();
      if (captured.has(id)) return;
      if (captured.size + visiting.size >= bounds.sources) fail();
      visiting.add(id);
      const matches = state.sources.filter(source => source.id === id);
      const records = state.managedSources.filter(record => record.sourceId === id);
      if (matches.length !== 1 || records.length !== 1) fail();
      const source = matches[0], record = records[0], policy = record.policy;
      validateSource(source);
      if (record.providerId !== 'fictional-fixture' || policy.providerId !== record.providerId
        || source.verification === 'DISPUTED'
        || policyStatus(policy, at) !== 'ACTIVE' || !policy.licensedExcerpt || !policy.internalAnalysis
        || policyDigest(policy) !== policyDigest(getPolicy(record.providerId, policy.id, at))
        || source.id !== sourceId(record.providerMetadata.url)
        || source.canonicalUrl !== canonicalURL(source.url)
        || source.url !== record.providerMetadata.url || source.publisher !== record.providerMetadata.publisher
        || source.publishedAt !== record.providerMetadata.publishedAt || source.retrievedAt !== record.providerMetadata.retrievedAt
        || !text(source.publisher, 256) || !text(source.url, 2048)
        || timestamp(source.publishedAt) > now || timestamp(source.retrievedAt) > now
        || timestamp(record.retainedAt) > now || !eligibleSource(state, source, at)) fail();
      metadata({ providerId: record.providerId, ...record.providerMetadata, provenance: record.providerProvenance }, record.providerId);
      const decisions = state.provenanceDecisions.filter(decision => decision.sourceId === id);
      const resolved = decisions.filter(decision => !['UNKNOWN', 'DISPUTED'].includes(decision.classification));
      const expectedOrigin = source.type === 'SYNDICATED' ? source.originId : null;
      if (!resolved.length || !decisions.length || ['UNKNOWN', 'DISPUTED'].includes(decisions.at(-1)!.classification)
        || resolved.some(decision => decision.classification !== source.type || decision.originId !== expectedOrigin)
        || decisions.some(decision => !text(decision.actorAssertion, 256) || !text(decision.reason, 2048)
          || !strings(decision.evidenceReferences, 64) || timestamp(decision.at) > now)) fail();
      const asserted = record.providerProvenance;
      if (!['UNKNOWN', 'DISPUTED'].includes(asserted.type)
        && (asserted.type !== source.type || asserted.originId !== expectedOrigin)) fail();
      const expires = Math.min(retentionDeadline(record), timestamp(policy.expiresAt));
      if (!Number.isFinite(expires) || expires <= now) fail();
      if (source.type === 'SYNDICATED') {
        const origin = state.sources.filter(item => item.id === source.originId);
        if (origin.length !== 1 || !['PRIMARY', 'ORIGINAL'].includes(origin[0].type)) fail();
        capture(source.originId);
      }
      captured.set(id, { sourceId: id, originId: source.originId, publisher: source.publisher, url: source.url,
        providerId: record.providerId, policyId: policy.id, policyVersion: policy.version,
        snapshotDigest: policyDigest(policy), expiresAt: new Date(expires).toISOString() });
      visiting.delete(id);
    }
    for (const id of story.sourceIds) capture(id);
    const evidence: EditionEvidence[] = story.evidence.map(item => {
      if (!text(item.id, 256) || !text(item.claim, 4096) || item.verification !== 'VERIFIED'
        || !strings(item.support, bounds.sources) || !strings(item.contradict, bounds.sources, true)
        || !text(item.uncertainty, bounds.uncertainty, true)
        || [...item.support, ...item.contradict].some(id => !story.sourceIds.includes(id))
        || item.support.some(id => item.contradict.includes(id))) fail();
      return { id: item.id, support: [...item.support], contradict: [...item.contradict], uncertainty: item.uncertainty };
    });
    const sources = [...captured.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    if (sources.length > bounds.sources) fail();
    const boundExpiry = story.sourceHandoff ? sourceHandoffValidUntil(state, story.sourceHandoff.selected.map(row => row.id), at) : null;
    return { storyId, storyVersion, headline: story.headline, summary: story.summary, featured,
      sources, evidence, independentSourceCount: new Set(sources.map(source => source.originId)).size,
      expiresAt: new Date(Math.min(...sources.map(source => timestamp(source.expiresAt)), boundExpiry ?? Infinity)).toISOString() };
  } catch { fail(); }
}
