import { randomUUID } from 'node:crypto';
import { canonicalURL, type State } from '../newsroom/model.ts';
import { JsonRepository } from '../newsroom/store.ts';
import { getPolicy, policyStatus } from './policies.ts';
import { metadata, managed, timestamp, retentionDeadline } from './metadata.ts';
import { resolveDecision } from './provenance.ts';
import type { ResolutionInput } from './records.ts';
import type { ProviderArticle } from './types.ts';
export { sourceId } from './metadata.ts';
export type Counts = { processed: number; duplicate: number; rejected: number; quarantined: number; failed: number };
export interface IngestionContext { providerId: string; policyId: string }
interface Options {
  dryRun?: boolean;
  maxArticles?: number;
  resolutions?: ResolutionInput[];
  onOutcome?: (index: number, outcome: keyof Counts) => void;
  /** Trusted composition/test clock, never request-supplied authorization. */
  clock?: () => string;
}
function appendAudit(state: State, action: string, at: string, subjectId?: string) {
  state.audit.push({id:randomUUID(), storyId:null, action, actor:'development-ingestion', at, version:null, ...(subjectId ? {subjectId} : {})});
}
function assertContext(context: IngestionContext): void {
  if (!context || typeof context !== 'object' || Object.keys(context).some(k => !['providerId','policyId'].includes(k)) || typeof context.providerId !== 'string' || typeof context.policyId !== 'string') throw Error('Registered provider and policy identifiers required; caller policies are forbidden');
}
function decide(state: State, input: ProviderArticle, context: IngestionContext, at: string, resolutions: ResolutionInput[]): keyof Counts {
  if (state.retentionReviewRequired) { appendAudit(state, 'INGESTION_BLOCKED_REVIEW_REQUIRED', at); return 'rejected'; }
  const policy = getPolicy(context.providerId, context.policyId, at);
  let proposed = structuredClone(state);
  let subjectId: string | undefined;
  let outcome: keyof Counts;
  try {
    const article = metadata(input, context.providerId);
    const record = managed(article, policy, at); subjectId = record.sourceId;
    if (retentionDeadline(record) <= timestamp(at)) throw Error('Expired metadata');
    if (proposed.deletions.some(d => d.sourceId === subjectId)) outcome = 'rejected';
    else if (proposed.sources.some(s => s.id === subjectId || s.canonicalUrl === canonicalURL(article.url)) || proposed.quarantine.some(q => q.sourceId === subjectId)) outcome = 'duplicate';
    else {
      const resolution = resolutions.find(d => d.sourceId === subjectId);
      const resolved = resolution ? resolveDecision(proposed, record, resolution, at) : null;
      if (resolved?.source) {
        proposed.sources.push(resolved.source); proposed.managedSources.push(record); proposed.provenanceDecisions.push(resolved.decision);
        appendAudit(proposed, 'PROVENANCE_RESOLVED', at, subjectId); outcome = 'processed';
      } else if (policy.quarantineMetadata) {
        proposed.quarantine.push({ ...record, metadata: { ...record.providerMetadata } });
        if (resolved) proposed.provenanceDecisions.push(resolved.decision);
        appendAudit(proposed, 'PROVENANCE_UNRESOLVED', at, subjectId); outcome = 'quarantined';
      } else outcome = 'rejected';
    }
  } catch {
    // Rejections are committed as decisions without storing input or raw errors.
    proposed = structuredClone(state);
    outcome = 'rejected';
  }
  appendAudit(proposed, `INGESTION_${outcome.toUpperCase()}`, at, ['processed', 'quarantined'].includes(outcome) ? subjectId : undefined);
  Object.assign(state, proposed);
  return outcome;
}
/** Exactly one repository transaction per item; network access never occurs under its lock. */
export async function ingestArticles(repository: JsonRepository, articles: ProviderArticle[], context: IngestionContext, options: Options = {}): Promise<Counts> {
  assertContext(context);
  const at = (options.clock ?? (() => new Date().toISOString()))(); timestamp(at);
  getPolicy(context.providerId, context.policyId, at);
  const max = options.maxArticles ?? 10;
  if (!Array.isArray(articles) || !Number.isInteger(max) || max < 1 || max > 100 || articles.length > max) throw Error('Article count exceeds limit');
  const resolutions = structuredClone(options.resolutions ?? []);
  if (new Set(resolutions.map(r => r.sourceId)).size !== resolutions.length) throw Error('Duplicate provenance decisions');
  const dryRun = options.dryRun !== false;
  const preview = dryRun ? await repository.read() : undefined;
  const result: Counts = { processed:0, duplicate:0, rejected:0, quarantined:0, failed:0 };
  for (const [index, article] of articles.entries()) {
    let outcome: keyof Counts;
    try { outcome = preview ? decide(preview, article, context, at, resolutions) : await repository.transact(state => decide(state, article, context, at, resolutions)); }
    catch { outcome = 'failed'; } // Failed transaction: neither success nor an outcome event was committed.
    result[outcome]++; options.onOutcome?.(index, outcome);
  }
  return result;
}
/** Resolve retained metadata without extending its original rights or retention deadline. */
export async function resolveQuarantined(repository: JsonRepository, input: ResolutionInput, at = new Date().toISOString()): Promise<'resolved' | 'unresolved' | 'rejected'> {
  timestamp(at);
  return repository.transact(state => {
    if (state.retentionReviewRequired) { appendAudit(state, 'PROVENANCE_BLOCKED_REVIEW_REQUIRED', at); return 'rejected'; }
    const record = state.quarantine.find(q => q.sourceId === input.sourceId);
    if (!record) throw Error('Unknown quarantined source');
    try {
      const proposed = structuredClone(state);
      if (policyStatus(record.policy, at) !== 'ACTIVE' || retentionDeadline(record) <= timestamp(at)) throw Error('Ineligible policy or retention deadline');
      const result = resolveDecision(proposed, record, input, at);
      if (result.source) {
        proposed.sources.push(result.source);
        const { metadata: _, ...retained } = record;
        proposed.managedSources.push(retained); proposed.quarantine = proposed.quarantine.filter(q => q.sourceId !== record.sourceId);
      }
      proposed.provenanceDecisions.push(result.decision);
      appendAudit(proposed, result.source ? 'PROVENANCE_RESOLVED' : 'PROVENANCE_UNRESOLVED', at, record.sourceId);
      Object.assign(state, proposed);
      return result.source ? 'resolved' : 'unresolved';
    } catch {
      appendAudit(state, 'PROVENANCE_REJECTED', at, record.sourceId);
      return 'rejected';
    }
  });
}
