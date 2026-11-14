/** Private development provenance-review records. Stored evidence and actors are never display DTO fields. */
export const sourceReviewActions = ['begin', 'propose', 'confirm', 'reject', 'hold', 'release', 'withdraw'] as const;
export type SourceReviewAction = typeof sourceReviewActions[number];
export const sourceReviewStatuses = ['UNREVIEWED', 'UNDER_REVIEW', 'PROPOSED', 'RESOLVED', 'DISPUTED', 'REJECTED', 'ON_HOLD', 'EXPIRED', 'WITHDRAWN'] as const;
export type SourceReviewStatus = typeof sourceReviewStatuses[number];
export const sourceReviewReasonCodes = ['INITIAL_REVIEW', 'EVIDENCE_SUPPORTED', 'INSUFFICIENT_EVIDENCE', 'CONTRADICTORY_EVIDENCE', 'REVIEW_HOLD', 'HOLD_RELEASED', 'WITHDRAWN'] as const;
export type SourceReviewReasonCode = typeof sourceReviewReasonCodes[number];
export const provenanceClassifications = ['PRIMARY', 'ORIGINAL', 'SECONDARY', 'SYNDICATED', 'UNKNOWN', 'DISPUTED'] as const;
export type ReviewClassification = typeof provenanceClassifications[number];
export interface SourceReviewInput { revision: string; reasonCode: SourceReviewReasonCode; evidenceReferences: string[]; classification?: ReviewClassification; originId?: string | null }
export interface SourceReviewProposal { classification: ReviewClassification; originId: string | null; evidenceReferences: string[]; reasonCode: SourceReviewReasonCode; proposedBy: string; proposedAt: string; sourceFingerprint: string }
export interface SourceReviewRevision { sourceId: string; revision: number; status: SourceReviewStatus; action: SourceReviewAction; actorId: string; at: string; reasonCode: SourceReviewReasonCode; evidenceReferences: string[]; proposal: SourceReviewProposal | null; sourceFingerprint: string }
export interface SourceReviewSummary { revision: string; reviewRevision: number; status: SourceReviewStatus; blocked: boolean; pendingProposal: boolean; independentlyResolved: boolean; reviewAllowed: boolean }
export class SourceReviewError extends Error {
  readonly code: 'INVALID_INPUT' | 'STALE_REVISION' | 'INELIGIBLE_SOURCE' | 'INVALID_TRANSITION' | 'SELF_CONFIRMATION' | 'CONTRADICTORY_EVIDENCE' | 'STORAGE_LIMIT';
  constructor(code: SourceReviewError['code']) { super(code); this.name = 'SourceReviewError'; this.code = code; }
}
type Row = Record<string, unknown>;
export function reviewObject(value: unknown, keys: readonly string[]): value is Row {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(d => d.enumerable && Object.hasOwn(d, 'value'));
}
export const reviewSourceId = (value: unknown): value is string => typeof value === 'string' && /^url-[a-f0-9]{64}$/.test(value);
export const reviewFingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const actor = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value);
export function reviewEvidence(value: unknown): value is string[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length >= 1 && value.length <= 16
    && Reflect.ownKeys(value).length === value.length + 1
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(d => Object.hasOwn(d, 'value'))
    && value.every(reviewSourceId) && new Set(value).size === value.length;
}
function utc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const time = Date.parse(value), expected = value.replace(/(?:\.(\d{1,3}))?Z$/, (_m, f: string | undefined) => `.${(f ?? '').padEnd(3, '0')}Z`);
  return Number.isFinite(time) && new Date(time).toISOString() === expected;
}
function proposal(value: unknown): value is SourceReviewProposal {
  return reviewObject(value, ['classification', 'originId', 'evidenceReferences', 'reasonCode', 'proposedBy', 'proposedAt', 'sourceFingerprint'])
    && provenanceClassifications.includes(value.classification as ReviewClassification)
    && (value.classification === 'SYNDICATED' ? reviewSourceId(value.originId) : value.originId === null)
    && reviewEvidence(value.evidenceReferences) && sourceReviewReasonCodes.includes(value.reasonCode as SourceReviewReasonCode)
    && actor(value.proposedBy) && utc(value.proposedAt) && reviewFingerprint(value.sourceFingerprint);
}
/** Additive schema-7 extension: missing collection is valid, present malformed history is not. */
export function validSourceReviewHistory(value: unknown): value is SourceReviewRevision[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 512
    || Reflect.ownKeys(value).length !== value.length + 1
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, 'value'))) return false;
  const prior = new Map<string, SourceReviewRevision>();
  for (const item of value) {
    if (!reviewObject(item, ['sourceId', 'revision', 'status', 'action', 'actorId', 'at', 'reasonCode', 'evidenceReferences', 'proposal', 'sourceFingerprint'])
      || !reviewSourceId(item.sourceId) || !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || (item.revision as number) > 64
      || !sourceReviewStatuses.includes(item.status as SourceReviewStatus) || !sourceReviewActions.includes(item.action as SourceReviewAction)
      || !actor(item.actorId) || !utc(item.at) || !sourceReviewReasonCodes.includes(item.reasonCode as SourceReviewReasonCode)
      || !reviewEvidence(item.evidenceReferences) || (item.proposal !== null && !proposal(item.proposal)) || !reviewFingerprint(item.sourceFingerprint)) return false;
    const row = item as unknown as SourceReviewRevision, last = prior.get(row.sourceId);
    if (row.revision !== (last?.revision ?? 0) + 1 || (last && Date.parse(row.at) < Date.parse(last.at))) return false;
    const before = last?.status ?? 'UNREVIEWED';
    if (row.action === 'begin' && (!['UNREVIEWED', 'REJECTED', 'DISPUTED'].includes(before) || row.status !== 'UNDER_REVIEW' || row.proposal !== null || row.reasonCode !== 'INITIAL_REVIEW')) return false;
    if (row.action === 'propose' && (before !== 'UNDER_REVIEW' || row.status !== 'PROPOSED' || !row.proposal || row.proposal.proposedBy !== row.actorId || row.proposal.proposedAt !== row.at
      || row.proposal.reasonCode !== row.reasonCode || JSON.stringify(row.evidenceReferences) !== JSON.stringify(row.proposal.evidenceReferences))) return false;
    if (row.action === 'confirm' && (before !== 'PROPOSED' || !last?.proposal || !row.proposal || row.actorId === row.proposal.proposedBy
      || row.status !== (['UNKNOWN', 'DISPUTED'].includes(row.proposal.classification) ? 'DISPUTED' : 'RESOLVED')
      || row.reasonCode !== 'EVIDENCE_SUPPORTED' || JSON.stringify(row.proposal) !== JSON.stringify(last.proposal))) return false;
    if (row.action === 'reject' && (before !== 'PROPOSED' || row.status !== 'REJECTED' || row.proposal !== null || !last?.proposal
      || last.proposal.proposedBy === row.actorId || !['CONTRADICTORY_EVIDENCE', 'INSUFFICIENT_EVIDENCE'].includes(row.reasonCode))) return false;
    if (row.action === 'hold' && (['ON_HOLD', 'WITHDRAWN'].includes(before) || row.status !== 'ON_HOLD' || row.proposal !== null || row.reasonCode !== 'REVIEW_HOLD')) return false;
    if (row.action === 'release' && (before !== 'ON_HOLD' || row.status !== 'UNDER_REVIEW' || row.proposal !== null || row.reasonCode !== 'HOLD_RELEASED')) return false;
    if (row.action === 'withdraw' && (['UNREVIEWED', 'WITHDRAWN'].includes(before) || row.status !== 'WITHDRAWN' || row.proposal !== null || row.reasonCode !== 'WITHDRAWN')) return false;
    prior.set(row.sourceId, row);
  }
  return true;
}
export function latestSourceReview(rows: readonly SourceReviewRevision[] | undefined, id: string): SourceReviewRevision | undefined { return rows?.filter(row => row.sourceId === id).at(-1); }
