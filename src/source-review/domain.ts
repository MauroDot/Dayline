/** Trusted pure provenance-review transitions, invoked only inside the authenticated transaction facade. */
import { createHash } from 'node:crypto';
import type { State } from '../newsroom/model.ts';
import { canonicalURL, validateSource } from '../newsroom/model.ts';
import type { ManagedSource } from '../ingestion/records.ts';
import { retentionDeadline, sourceId, timestamp } from '../ingestion/metadata.ts';
import { policyStatus } from '../ingestion/policies.ts';
import { resolveDecision } from '../ingestion/provenance.ts';
import { eligibleSource } from '../ingestion/eligibility.ts';
import { invalidateDrafts } from '../editorial/lifecycle.ts';
import { invalidateEditions } from '../editions/lifecycle.ts';
import { latestSourceReview, provenanceClassifications, reviewEvidence, reviewFingerprint, reviewObject, reviewSourceId,
  sourceReviewActions, sourceReviewReasonCodes, SourceReviewError } from './types.ts';
import type { SourceReviewAction, SourceReviewInput, SourceReviewProposal, SourceReviewRevision, SourceReviewSummary } from './types.ts';
export { SourceReviewError } from './types.ts';
const fail = (code: SourceReviewError['code']): never => { throw new SourceReviewError(code); };
const policyFields = ['id', 'providerId', 'version', 'reviewStatus', 'effectiveAt', 'expiresAt', 'evidenceReference',
  'discoveryMetadata', 'licensedExcerpt', 'licensedFullText', 'media', 'internalAnalysis', 'publicRedistribution',
  'aiSummarization', 'aiNarration', 'retentionDays', 'deletionRequired', 'quarantineMetadata', 'minimalAudit', 'auditRetentionDays'];
function fields(value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== 'object') return null;
  return keys.map(key => [key, Object.getOwnPropertyDescriptor(value, key)?.value ?? null]);
}
function rights(value: unknown): unknown { try { return typeof value === 'string' ? fields(JSON.parse(value), policyFields) : null; } catch { return null; } }
function provenanceValid(value: State['provenanceDecisions'][number]): boolean {
  try {
    return reviewSourceId(value.sourceId) && provenanceClassifications.includes(value.classification)
      && (value.classification === 'SYNDICATED' ? reviewSourceId(value.originId) : value.originId === null)
      && typeof value.actorAssertion === 'string' && !!value.actorAssertion.trim() && value.actorAssertion.length <= 4096
      && typeof value.reason === 'string' && !!value.reason.trim() && value.reason.length <= 4096
      && Number.isFinite(timestamp(value.at)) && Array.isArray(value.evidenceReferences)
      && value.evidenceReferences.length >= 1 && value.evidenceReferences.length <= 100
      && value.evidenceReferences.every(reference => typeof reference === 'string' && !!reference.trim() && reference.length <= 4096);
  } catch { return false; }
}
function sorted(value: unknown): unknown { return Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])])) : value; }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex'); }
/** Snapshot only fixed protocol fields; a getter or prototype can never supply authority. */
export function validateSourceReviewInput(action: SourceReviewAction, input: unknown): SourceReviewInput {
  const keys = ['revision', 'reasonCode', 'evidenceReferences', ...(action === 'propose' ? ['classification', 'originId'] : [])];
  if (!sourceReviewActions.includes(action) || !reviewObject(input, keys) || !reviewFingerprint(input.revision)
    || !sourceReviewReasonCodes.includes(input.reasonCode as never) || !reviewEvidence(input.evidenceReferences)) return fail('INVALID_INPUT');
  if (action === 'propose' && (!provenanceClassifications.includes(input.classification as never)
    || (input.classification === 'SYNDICATED' ? !reviewSourceId(input.originId) : input.originId !== null))) return fail('INVALID_INPUT');
  const expected = action === 'begin' ? ['INITIAL_REVIEW'] : action === 'propose' ? [input.classification === 'DISPUTED' ? 'CONTRADICTORY_EVIDENCE' : input.classification === 'UNKNOWN' ? 'INSUFFICIENT_EVIDENCE' : 'EVIDENCE_SUPPORTED']
    : action === 'confirm' ? ['EVIDENCE_SUPPORTED'] : action === 'reject' ? ['CONTRADICTORY_EVIDENCE', 'INSUFFICIENT_EVIDENCE']
      : action === 'hold' ? ['REVIEW_HOLD'] : action === 'release' ? ['HOLD_RELEASED'] : ['WITHDRAWN'];
  if (!expected.includes(input.reasonCode as string)) return fail('INVALID_INPUT');
  return structuredClone(input) as unknown as SourceReviewInput;
}
function retained(state: State, id: string): ManagedSource {
  if (!reviewSourceId(id)) return fail('INVALID_INPUT');
  const rows = [...state.managedSources, ...state.quarantine].filter(row => row.sourceId === id);
  if (rows.length !== 1) return fail('INELIGIBLE_SOURCE');
  return rows[0];
}
function relevantIds(state: State, id: string): string[] {
  const ids = new Set([id]), pending = [id];
  for (let index = 0; index < pending.length; index++) {
    const source = state.sources.find(row => row.id === pending[index]);
    const record = [...state.managedSources, ...state.quarantine].find(row => row.sourceId === pending[index]);
    for (const origin of [source?.type === 'SYNDICATED' ? source.originId : null, record?.providerProvenance.type === 'SYNDICATED' ? record.providerProvenance.originId : null]) {
      if (origin && !ids.has(origin)) { ids.add(origin); pending.push(origin); }
    }
    if (ids.size > 64) return fail('INELIGIBLE_SOURCE');
  }
  return [...ids].sort();
}
/** Exact finite transitive source dependencies for trusted authorization and retention composition. */
export function sourceReviewDependencyIds(state: State, ids: readonly string[]): string[] {
  const all = new Set(ids), pending = [...all];
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index];
    for (const reference of [...relevantIds(state, id), ...pendingIds(state, id), ...acceptedIds(state, id)]) {
      if (!all.has(reference)) { all.add(reference); pending.push(reference); }
      if (all.size > 64) return fail('INVALID_INPUT');
    }
  }
  if (all.size > 64) return fail('INVALID_INPUT');
  return [...all].sort();
}
export function sourceReviewInspectionTargets(state: State, id: string): string[] { return sourceReviewDependencyIds(state, [id]); }
function pendingIds(state: State, id: string): string[] {
  const last = latestSourceReview(state.sourceReviews, id), proposal = last?.proposal;
  return [...(last?.evidenceReferences ?? []), ...(proposal ? [...proposal.evidenceReferences, ...(proposal.originId ? [proposal.originId] : [])] : [])];
}
function acceptedIds(state: State, id: string): string[] {
  const proposal = state.sourceReviews?.filter(row => row.sourceId === id && row.action === 'confirm' && row.status === 'RESOLVED').at(-1)?.proposal;
  return proposal ? [...proposal.evidenceReferences, ...(proposal.originId ? [proposal.originId] : [])] : [];
}
function sourceState(state: State, id: string): unknown {
  const ids = new Set(relevantIds(state, id));
  return [state.retentionReviewRequired,
    state.sources.filter(row => ids.has(row.id)).map(row => [row.id, row.url, row.canonicalUrl, row.publisher, row.publishedAt, row.retrievedAt, row.type, row.originId, rights(row.rights), row.verification]),
    [...state.managedSources, ...state.quarantine].filter(row => ids.has(row.sourceId)).map(row => [row.sourceId, row.providerId, row.retainedAt, row.deleteAt,
      fields(row.policy, policyFields), fields(row.providerMetadata, ['url', 'publisher', 'publishedAt', 'retrievedAt']), fields(row.providerProvenance, ['type', 'originId']), 'metadata' in row]),
    state.provenanceDecisions.filter(row => ids.has(row.sourceId)).map(row => [row.sourceId, row.classification, row.originId, row.at, provenanceValid(row)]),
    state.deletions.filter(row => ids.has(row.sourceId)).map(row => [row.sourceId, row.at, row.expiresAt])];
}
export function sourceReviewFingerprint(state: State, id: string, extraIds: readonly string[] = []): string {
  return hash([sourceState(state, id), sourceReviewDependencyIds(state, extraIds).filter(reference => reference !== id).map(reference => {
    const review = latestSourceReview(state.sourceReviews, reference);
    return [reference, sourceState(state, reference), review ? [review.revision, review.status] : null];
  })]);
}
export function sourceReviewRevision(state: State, id: string): string {
  if (!reviewSourceId(id)) return fail('INVALID_INPUT');
  const row = latestSourceReview(state.sourceReviews, id);
  // Reviewer identities and free private extras are not cursor inputs.
  return hash([id, sourceState(state, id), row ? [row.revision, row.status, row.action, row.at, row.reasonCode, row.evidenceReferences,
    row.proposal ? [row.proposal.classification, row.proposal.originId, row.proposal.evidenceReferences, row.proposal.proposedAt, row.proposal.sourceFingerprint,
      sourceReviewFingerprint(state, id, [...row.proposal.evidenceReferences, ...(row.proposal.originId ? [row.proposal.originId] : [])])] : null] : null]);
}
/** Current captured registry grant and retained metadata are mandatory even when quarantined. */
export function assertSourceReviewCurrent(state: State, id: string, at: string): void {
  try {
    const now = timestamp(at), record = retained(state, id);
    if (state.retentionReviewRequired || state.deletions.some(row => row.sourceId === id)
      || policyStatus(record.policy, at) !== 'ACTIVE' || record.providerId !== record.policy.providerId
      || record.policy.minimalAudit !== true || !Number.isSafeInteger(record.policy.auditRetentionDays) || record.policy.auditRetentionDays <= 0
      || sourceId(record.providerMetadata.url) !== id || new URL(canonicalURL(record.providerMetadata.url)).search
      || !new URL(record.providerMetadata.url).hostname.endsWith('.test')
      || timestamp(record.retainedAt) > now || retentionDeadline(record) <= now
      || timestamp(record.providerMetadata.publishedAt) > timestamp(record.providerMetadata.retrievedAt)) return fail('INELIGIBLE_SOURCE');
    if (state.deletions.some(row => timestamp(row.at) > now || timestamp(row.expiresAt!) <= now)) return fail('INELIGIBLE_SOURCE');
    if (state.provenanceDecisions.filter(row => row.sourceId === id).some(row => !provenanceValid(row) || timestamp(row.at) > now)) return fail('INELIGIBLE_SOURCE');
    const sources = state.sources.filter(row => row.id === id), quarantine = state.quarantine.filter(row => row.sourceId === id);
    if (quarantine.length ? sources.length !== 0 || !record.policy.quarantineMetadata : sources.length !== 1) return fail('INELIGIBLE_SOURCE');
    if (quarantine.length && ['url', 'publisher', 'publishedAt', 'retrievedAt'].some(key => quarantine[0].metadata[key as keyof typeof quarantine[0]['metadata']] !== record.providerMetadata[key as keyof typeof record.providerMetadata])) return fail('INELIGIBLE_SOURCE');
    if (sources.length) {
      const source = sources[0];
      validateSource(source);
      if (source.canonicalUrl !== canonicalURL(record.providerMetadata.url) || hash(rights(source.rights)) !== hash(fields(record.policy, policyFields))
        || ['url', 'publisher', 'publishedAt', 'retrievedAt'].some(key => source[key as keyof typeof source] !== record.providerMetadata[key as keyof typeof record.providerMetadata])) return fail('INELIGIBLE_SOURCE');
    }
  } catch (error) { if (error instanceof SourceReviewError) throw error; return fail('INELIGIBLE_SOURCE'); }
}
export function sourceReviewTargets(state: State, id: string, action: SourceReviewAction, input: SourceReviewInput): string[] {
  input = validateSourceReviewInput(action, input);
  const proposal = latestSourceReview(state.sourceReviews, id)?.proposal;
  const references = [...new Set([id, ...input.evidenceReferences, ...(input.originId ? [input.originId] : []),
    ...(proposal ? [...proposal.evidenceReferences, ...(proposal.originId ? [proposal.originId] : [])] : [])])];
  return sourceReviewDependencyIds(state, references);
}
export function sourceReviewValidUntil(state: State, id: string, at: string, extraIds: readonly string[] = []): number | null {
  const now = timestamp(at); let next = Infinity;
  const consider = (value: unknown) => { if (typeof value === 'string') { const time = Date.parse(value); if (Number.isFinite(time) && time > now) next = Math.min(next, time); } };
  const allIds = sourceReviewDependencyIds(state, [id, ...extraIds]);
  for (const target of allIds) {
    for (const row of [...state.managedSources, ...state.quarantine].filter(row => row.sourceId === target)) {
      consider(row.retainedAt); consider(row.policy.effectiveAt); consider(row.policy.expiresAt);
      try { const deadline = retentionDeadline(row); if (deadline > now) next = Math.min(next, deadline); } catch {}
    }
    for (const decision of state.provenanceDecisions.filter(row => row.sourceId === target)) consider(decision.at);
  }
  for (const marker of state.deletions) { consider(marker.at); consider(marker.expiresAt); }
  return Number.isFinite(next) ? next : null;
}
export const sourceReviewTemporalDeadline = sourceReviewValidUntil;
function validEvidence(state: State, reference: string, at: string): boolean {
  const source = state.sources.find(row => row.id === reference);
  return !!source && ['PRIMARY', 'ORIGINAL'].includes(source.type) && source.verification === 'VERIFIED'
    && state.managedSources.some(row => row.sourceId === reference) && eligibleSource(state, source, at);
}
export function sourceReviewSummary(state: State, id: string, at: string): SourceReviewSummary {
  const last = latestSourceReview(state.sourceReviews, id);
  let allowed = true;
  try {
    assertSourceReviewCurrent(state, id, at);
    if (last?.status === 'PROPOSED') {
      if (!last.proposal || last.proposal.sourceFingerprint !== sourceReviewFingerprint(state, id, pendingIds(state, id))) return { revision: sourceReviewRevision(state, id), reviewRevision: last.revision,
        status: 'EXPIRED', blocked: true, pendingProposal: false, independentlyResolved: false, reviewAllowed: false };
      for (const target of pendingIds(state, id)) assertSourceReviewCurrent(state, target, at);
    }
    for (const target of acceptedIds(state, id)) assertSourceReviewCurrent(state, target, at);
    if (acceptedIds(state, id).some(reference => reference !== id && !validEvidence(state, reference, at))) allowed = false;
  } catch { allowed = false; }
  const removed = state.deletions.some(row => row.sourceId === id) || ![...state.managedSources, ...state.quarantine].some(row => row.sourceId === id);
  const status = !allowed ? removed ? 'WITHDRAWN' : 'EXPIRED' : last?.status ?? 'UNREVIEWED';
  const acceptedSource = state.sources.find(row => row.id === id);
  const blocked = !allowed || state.quarantine.some(row => row.sourceId === id) || ['ON_HOLD', 'DISPUTED', 'WITHDRAWN'].includes(status)
    || (status === 'RESOLVED' && (!acceptedSource || !eligibleSource(state, acceptedSource, at)));
  return { revision: sourceReviewRevision(state, id), reviewRevision: last?.revision ?? 0, status, blocked,
    pendingProposal: status === 'PROPOSED', independentlyResolved: !blocked && status === 'RESOLVED' && !!last?.proposal && last.actorId !== last.proposal.proposedBy, reviewAllowed: allowed };
}
/** Apply only to an isolated candidate state; the facade atomically commits history, resolution and receipts. */
export function applySourceReview(state: State, id: string, action: SourceReviewAction, input: SourceReviewInput, actorId: string, at: string): SourceReviewSummary {
  input = validateSourceReviewInput(action, input);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(actorId)) return fail('INVALID_INPUT');
  if (input.revision !== sourceReviewRevision(state, id)) return fail('STALE_REVISION');
  assertSourceReviewCurrent(state, id, at);
  const last = latestSourceReview(state.sourceReviews, id), current = last?.status ?? 'UNREVIEWED';
  if (last && timestamp(at) < timestamp(last.at)) return fail('INVALID_TRANSITION');
  if ((state.sourceReviews?.length ?? 0) >= 512 || (last?.revision ?? 0) >= 64) return fail('STORAGE_LIMIT');
  const targets = sourceReviewTargets(state, id, action, input);
  for (const target of targets) assertSourceReviewCurrent(state, target, at);
  if (action === 'propose' || action === 'confirm') {
    const evidence = action === 'propose' ? input.evidenceReferences : last?.proposal?.evidenceReferences ?? [];
    const independent = evidence.filter(reference => reference !== id);
    if (!independent.length || !independent.every(reference => validEvidence(state, reference, at))) return fail('CONTRADICTORY_EVIDENCE');
  }
  let proposal: SourceReviewProposal | null = null;
  let status: SourceReviewRevision['status'];
  if (action === 'begin') {
    if (!['UNREVIEWED', 'REJECTED', 'DISPUTED'].includes(current)) return fail('INVALID_TRANSITION');
    status = 'UNDER_REVIEW';
  } else if (action === 'propose') {
    if (current !== 'UNDER_REVIEW') return fail('INVALID_TRANSITION');
    proposal = { classification: input.classification!, originId: input.originId!, evidenceReferences: [...input.evidenceReferences],
      reasonCode: input.reasonCode, proposedBy: actorId, proposedAt: at, sourceFingerprint: sourceReviewFingerprint(state, id,
        [...input.evidenceReferences, ...(input.originId ? [input.originId] : [])]) };
    // Validate a recommendation against the established provenance rules without applying it.
    try { resolveDecision(state, retained(state, id), { sourceId: id, classification: proposal.classification, originId: proposal.originId,
      actorAssertion: 'authenticated-source-review', at, reason: input.reasonCode, evidenceReferences: proposal.evidenceReferences }, at); }
    catch { return fail('CONTRADICTORY_EVIDENCE'); }
    if (proposal.classification === 'SYNDICATED' && (!proposal.originId || !proposal.evidenceReferences.includes(proposal.originId))) return fail('CONTRADICTORY_EVIDENCE');
    if (proposal.classification === 'SYNDICATED' && state.sources.find(row => row.id === proposal!.originId)?.verification !== 'VERIFIED') return fail('CONTRADICTORY_EVIDENCE');
    status = 'PROPOSED';
  } else if (action === 'confirm' || action === 'reject') {
    if (current !== 'PROPOSED' || !last?.proposal) return fail('INVALID_TRANSITION');
    if (last.proposal.proposedBy === actorId) return fail('SELF_CONFIRMATION');
    if (hash([...input.evidenceReferences].sort()) !== hash([...last.proposal.evidenceReferences].sort())) return fail('CONTRADICTORY_EVIDENCE');
    if (last.proposal.sourceFingerprint !== sourceReviewFingerprint(state, id, pendingIds(state, id))) return fail('STALE_REVISION');
    if (action === 'reject') { status = 'REJECTED'; }
    else {
      proposal = structuredClone(last.proposal);
      if (proposal.classification === 'SYNDICATED' && state.sources.find(row => row.id === proposal!.originId)?.verification !== 'VERIFIED') return fail('CONTRADICTORY_EVIDENCE');
      const record = retained(state, id);
      let result;
      try { result = resolveDecision(state, record, { sourceId: id, classification: proposal.classification, originId: proposal.originId,
        actorAssertion: 'authenticated-source-review', at, reason: proposal.reasonCode, evidenceReferences: proposal.evidenceReferences }, at); }
      catch { return fail('CONTRADICTORY_EVIDENCE'); }
      if (result.source) {
        if (state.sources.some(row => row.id === id)) state.sources = state.sources.map(row => row.id === id ? result.source! : row);
        else {
          state.sources.push(result.source);
          const quarantined = state.quarantine.find(row => row.sourceId === id)!;
          const { metadata: _metadata, ...managed } = quarantined;
          state.managedSources.push(managed); state.quarantine = state.quarantine.filter(row => row.sourceId !== id);
        }
        status = 'RESOLVED';
      } else {
        state.sources = state.sources.map(row => row.id === id ? { ...row, verification: 'DISPUTED' as const } : row);
        status = 'DISPUTED';
      }
      state.provenanceDecisions.push(result.decision);
    }
  } else if (action === 'hold') {
    if (['ON_HOLD', 'WITHDRAWN'].includes(current)) return fail('INVALID_TRANSITION');
    status = 'ON_HOLD';
  } else if (action === 'release') {
    if (current !== 'ON_HOLD') return fail('INVALID_TRANSITION');
    status = 'UNDER_REVIEW';
  } else {
    if (['UNREVIEWED', 'WITHDRAWN'].includes(current)) return fail('INVALID_TRANSITION');
    status = 'WITHDRAWN';
  }
  const row: SourceReviewRevision = { sourceId: id, revision: (last?.revision ?? 0) + 1, status, action, actorId, at,
    reasonCode: input.reasonCode, evidenceReferences: [...input.evidenceReferences], proposal, sourceFingerprint: sourceReviewFingerprint(state, id) };
  (state.sourceReviews ??= []).push(row);
  if (['hold', 'confirm', 'reject', 'withdraw'].includes(action)) { invalidateDrafts(state, at); invalidateEditions(state, at); }
  return sourceReviewSummary(state, id, at);
}
