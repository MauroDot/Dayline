/** Trusted source-to-story checks shared by authenticated handoff and downstream domain continuity. */
import type { State, Story } from '../newsroom/model.ts';
import { eligibleSource } from '../ingestion/eligibility.ts';
import { timestamp } from '../ingestion/metadata.ts';
import { policyStatus } from '../ingestion/policies.ts';
import { sourceReviewDependencyIds, sourceReviewRevision, sourceReviewSummary, sourceReviewValidUntil, assertSourceReviewCurrent } from '../source-review/domain.ts';
import { latestSourceReview } from '../source-review/types.ts';
import { handoffArray, handoffObject, handoffSourceId, validSourceSelections, validStorySourceHandoff, SourceHandoffError } from './types.ts';
import type { HumanStoryInput, SourceHandoffInput, SourceSelection, StorySourceHandoff } from './types.ts';
export { SourceHandoffError } from './types.ts';
const fail = (code: SourceHandoffError['code']): never => { throw new SourceHandoffError(code); };
const receiptLifetime = 7 * 86_400_000;
const text = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && value.length <= max
  && (empty || Boolean(value.trim())) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
function date(value: unknown): boolean { try { return typeof value === 'string' && Number.isFinite(timestamp(value)); } catch { return false; } }
function sourceIds(value: unknown, maximum = 8, minimum = 0): value is string[] {
  return handoffArray(value, maximum, minimum) && value.every(handoffSourceId) && new Set(value).size === value.length;
}
export function validateHandoffSourceIds(value: unknown): string[] {
  if (!sourceIds(value, 8, 1)) return fail('INVALID_INPUT');
  return [...value];
}
export function validateHandoffSources(value: unknown): SourceSelection[] {
  if (!validSourceSelections(value)) return fail('INVALID_INPUT');
  return structuredClone(value);
}
/** Human-authored claims/verification are explicit inputs, never generated or upgraded here. */
export function validateHandoffStory(value: unknown): HumanStoryInput {
  if (!handoffObject(value, ['id', 'headline', 'topic', 'summary', 'geography', 'eventAt', 'firstSeenAt', 'updatedAt', 'clusterId', 'evidence', 'sourceIds'])
    || !identifier(value.id) || !text(value.headline, 512) || !text(value.topic, 128) || !text(value.summary, 4096) || !text(value.geography, 256)
    || !(value.eventAt === null || date(value.eventAt)) || !date(value.firstSeenAt) || !date(value.updatedAt)
    || !(value.clusterId === null || identifier(value.clusterId)) || !sourceIds(value.sourceIds, 8, 1) || !handoffArray(value.evidence, 16, 1)) return fail('INVALID_INPUT');
  const used = new Set<string>(), evidenceIds = new Set<string>();
  for (const row of value.evidence) {
    if (!handoffObject(row, ['id', 'claim', 'support', 'contradict', 'verification', 'uncertainty', 'reviewerDecisions'])
      || !identifier(row.id) || evidenceIds.has(row.id) || !text(row.claim, 4096) || !text(row.uncertainty, 2048, true)
      || row.verification !== 'VERIFIED' || !sourceIds(row.support, 8, 1) || !sourceIds(row.contradict)
      || !handoffArray(row.reviewerDecisions, 0)) return fail('INVALID_INPUT');
    const support = row.support, contradict = row.contradict;
    if (support.some(id => contradict.includes(id))) return fail('INVALID_INPUT');
    evidenceIds.add(row.id);
    for (const id of [...support, ...contradict]) { if (!value.sourceIds.includes(id)) return fail('INVALID_INPUT'); used.add(id); }
  }
  if (value.sourceIds.some(id => !used.has(id))) return fail('INVALID_INPUT');
  return structuredClone(value) as unknown as HumanStoryInput;
}
export function validateHandoffInput(value: unknown): SourceHandoffInput {
  if (!handoffObject(value, ['sources', 'story'])) return fail('INVALID_INPUT');
  const sources = validateHandoffSources(value.sources), story = validateHandoffStory(value.story);
  const selected = new Set(sources.map(row => row.id));
  if (selected.size !== story.sourceIds.length || story.sourceIds.some(id => !selected.has(id))) return fail('INVALID_INPUT');
  return { sources, story };
}
/** Every source and its finite review/proof/origin dependencies need separate read authorization. */
export function sourceHandoffTargets(state: State, ids: readonly string[]): string[] {
  const selected = validateHandoffSourceIds(ids);
  try { return sourceReviewDependencyIds(state, selected); }
  catch { return fail('INELIGIBLE_SOURCE'); }
}
function eligible(state: State, id: string, at: string): void {
  try {
    assertSourceReviewCurrent(state, id, at);
    const review = latestSourceReview(state.sourceReviews, id), summary = sourceReviewSummary(state, id, at);
    const sources = state.sources.filter(row => row.id === id), records = state.managedSources.filter(row => row.sourceId === id);
    if (!review || review.action !== 'confirm' || review.status !== 'RESOLVED' || !review.proposal
      || review.actorId === review.proposal.proposedBy || !summary.independentlyResolved || summary.blocked || !summary.reviewAllowed
      || sources.length !== 1 || records.length !== 1 || sources[0].verification === 'DISPUTED'
      || policyStatus(records[0].policy, at) !== 'ACTIVE' || !records[0].policy.licensedExcerpt || !records[0].policy.internalAnalysis
      || !eligibleSource(state, sources[0], at)) return fail('INELIGIBLE_SOURCE');
    const proposed = state.sourceReviews?.find(row => row.sourceId === id && row.revision === review.revision - 1
      && row.action === 'propose' && row.status === 'PROPOSED' && row.actorId === review.proposal!.proposedBy
      && row.at === review.proposal!.proposedAt);
    const receipt = (actorId: string, version: number, when: string, permission: 'SOURCE_REVIEW' | 'SOURCE_RESOLVE') =>
      timestamp(when) <= timestamp(at) && timestamp(when) > timestamp(at) - receiptLifetime
      && state.identities.some(identity => identity.id === actorId) && state.authenticatedActions.some(row => row.resourceKind === 'SOURCE'
        && row.resourceId === id && row.resourceVersion === version && row.actorId === actorId && row.at === when && row.permission === permission);
    if (!proposed || !receipt(proposed.actorId, proposed.revision, proposed.at, 'SOURCE_REVIEW')
      || !receipt(review.actorId, review.revision, review.at, 'SOURCE_RESOLVE')) return fail('INELIGIBLE_SOURCE');
  } catch (error) { if (error instanceof SourceHandoffError) throw error; return fail('INELIGIBLE_SOURCE'); }
}
export function inspectHandoffSelection(state: State, rawIds: readonly string[], at: string): SourceSelection[] {
  const ids = validateHandoffSourceIds(rawIds); timestamp(at);
  const dependencies = sourceHandoffTargets(state, ids);
  for (const id of dependencies) { try { assertSourceReviewCurrent(state, id, at); } catch { return fail('INELIGIBLE_SOURCE'); } }
  for (const id of ids) eligible(state, id, at);
  return ids.map(id => ({ id, revision: sourceReviewRevision(state, id) }));
}
/** Validate the caller's exact source revisions and construct a private immutable continuity snapshot. */
export function buildSourceHandoff(state: State, rawSources: SourceSelection[], at: string): StorySourceHandoff {
  const sources = validateHandoffSources(rawSources), ids = sources.map(row => row.id);
  const current = inspectHandoffSelection(state, ids, at);
  if (sources.some((row, index) => row.revision !== current[index].revision)) return fail('STALE_SOURCE');
  const dependencies = sourceHandoffTargets(state, ids).map(id => ({ id, revision: sourceReviewRevision(state, id) }));
  return { preparedAt: new Date(timestamp(at)).toISOString(), selected: current, dependencies };
}
export function sourceHandoffValidUntil(state: State, ids: readonly string[], at: string): number | null {
  const targets = sourceHandoffTargets(state, ids); let cutoff = Infinity;
  for (const id of validateHandoffSourceIds(ids)) {
    const next = sourceReviewValidUntil(state, id, at, targets); if (next !== null) cutoff = Math.min(cutoff, next);
    const confirmed = latestSourceReview(state.sourceReviews, id);
    const proposed = state.sourceReviews?.find(row => row.sourceId === id && row.revision === (confirmed?.revision ?? 0) - 1 && row.action === 'propose');
    for (const row of [confirmed, proposed]) if (row && timestamp(row.at) + receiptLifetime > timestamp(at)) cutoff = Math.min(cutoff, timestamp(row.at) + receiptLifetime);
  }
  return Number.isFinite(cutoff) ? cutoff : null;
}
/** Legacy stories are unchanged; integrated stories retain exact current source and proof bindings. */
export function assertStorySourceHandoff(state: State, story: Story, at: string): void {
  if (!Object.hasOwn(story, 'sourceHandoff')) return;
  const binding = story.sourceHandoff;
  if (!validStorySourceHandoff(binding) || story.retentionRedacted || timestamp(binding.preparedAt) > timestamp(at)) return fail('INELIGIBLE_SOURCE');
  const input = validateHandoffStory(Object.fromEntries(['id', 'headline', 'topic', 'summary', 'geography', 'eventAt', 'firstSeenAt', 'updatedAt', 'clusterId', 'evidence', 'sourceIds']
    .map(key => [key, story[key as keyof Story]])));
  const selected = new Set(binding.selected.map(row => row.id));
  if (input.sourceIds.length !== selected.size || input.sourceIds.some(id => !selected.has(id))) return fail('INVALID_INPUT');
  const current = buildSourceHandoff(state, binding.selected, at);
  if (JSON.stringify(current.dependencies) !== JSON.stringify(binding.dependencies)) return fail('STALE_SOURCE');
}
export function storySourceHandoffTargets(state: State, story: Story): string[] {
  if (!Object.hasOwn(story, 'sourceHandoff')) return [];
  if (!validStorySourceHandoff(story.sourceHandoff)) return fail('INELIGIBLE_SOURCE');
  return sourceHandoffTargets(state, story.sourceHandoff.selected.map(row => row.id));
}
