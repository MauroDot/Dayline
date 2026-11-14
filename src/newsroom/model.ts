import type { DraftRecord, DraftReview } from '../editorial/types.ts';
import type { EditionRevision, EditionReview } from '../editions/types.ts';
import type { PreparationSchedule, PreparationRun } from '../scheduling/types.ts';
import type { IdentityRecord, SessionRecord, SecurityEvent, AuthenticatedAction } from '../security/types.ts';
import type { ManagedSource, QuarantinedSource, ProvenanceDecision, DeletionMarker } from '../ingestion/records.ts';
import type { SourceReviewRevision } from '../source-review/types.ts';
/** Internal newsroom records. Historical fixture assertions grant no authentication or publication authority. */
export type SourceType = 'PRIMARY' | 'ORIGINAL' | 'SYNDICATED' | 'SECONDARY';
export type Verification = 'UNVERIFIED' | 'VERIFIED' | 'DISPUTED';
export type Status = 'INGESTED' | 'CLUSTERED' | 'DRAFT' | 'NEEDS_REVIEW' | 'APPROVED' | 'PUBLISHED' | 'REJECTED' | 'ON_HOLD' | 'CORRECTION_REQUIRED';
export interface Source { id: string; publisher: string; url: string; canonicalUrl: string; type: SourceType; publishedAt: string; retrievedAt: string; originId: string; rights: string; verification: Verification }
export interface Evidence { id: string; claim: string; support: string[]; contradict: string[]; verification: Verification; uncertainty: string; reviewerDecisions: string[] }
export interface Story { id: string; headline: string; topic: string; summary: string; geography: string; eventAt: string | null; firstSeenAt: string; updatedAt: string; clusterId: string | null; evidence: Evidence[]; sourceIds: string[]; status: Status; version: number; retentionRedacted?: true }
export interface Approval { storyId: string; version: number; reviewer: string; at: string; retentionRedacted?: true }
export interface Audit { id: string; storyId: string | null; action: string; actor: string; at: string; version: number | null; subjectId?: string; scheduleId?: string; preparationRunId?: string }
export interface State { schema: 7; sourceReviews?: SourceReviewRevision[]; identities: IdentityRecord[]; sessions: SessionRecord[]; securityAudit: SecurityEvent[]; authenticatedActions: AuthenticatedAction[]; schedules: PreparationSchedule[]; preparationRuns: PreparationRun[]; editions: EditionRevision[]; editionReviews: EditionReview[]; drafts: DraftRecord[]; draftReviews: DraftReview[]; retentionReviewRequired: boolean; sources: Source[]; revisions: Story[]; approvals: Approval[]; audit: Audit[]; managedSources: ManagedSource[]; quarantine: QuarantinedSource[]; provenanceDecisions: ProvenanceDecision[]; deletions: DeletionMarker[] }
export const emptyState = (): State => ({ schema: 7, identities: [], sessions: [], securityAudit: [], authenticatedActions: [], schedules: [], preparationRuns: [], editions: [], editionReviews: [], drafts: [], draftReviews: [], retentionReviewRequired: false, sources: [], revisions: [], approvals: [], audit: [], managedSources: [], quarantine: [], provenanceDecisions: [], deletions: [] });
export function canonicalURL(raw: string): string {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('Invalid source URL');
  u.hash = ''; u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid)$/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  if (u.pathname !== '/') u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}
export function validateSource(source: Source): void {
  if (![source.id, source.publisher, source.originId, source.rights].every(x => typeof x === 'string' && x.trim())) throw Error('Missing source fields');
  if (!['PRIMARY', 'ORIGINAL', 'SYNDICATED', 'SECONDARY'].includes(source.type) || !['UNVERIFIED', 'VERIFIED', 'DISPUTED'].includes(source.verification)) throw Error('Invalid source classification');
  if (!Number.isFinite(Date.parse(source.publishedAt)) || !Number.isFinite(Date.parse(source.retrievedAt))) throw Error('Invalid source timestamp');
  if (canonicalURL(source.url) !== source.canonicalUrl) throw Error('Invalid canonical URL');
  if (source.type !== 'SYNDICATED' && source.originId !== source.id) throw Error('Original source must identify itself');
  if (source.type === 'SYNDICATED' && source.originId === source.id) throw Error('Syndication requires original source');
}
export function validateEvidence(e: Evidence, sourceIds: Set<string>): void {
  if (!e.id?.trim() || !e.claim?.trim() || !Array.isArray(e.support) || !Array.isArray(e.contradict) || !Array.isArray(e.reviewerDecisions) || typeof e.uncertainty !== 'string' || !['UNVERIFIED', 'VERIFIED', 'DISPUTED'].includes(e.verification)) throw Error('Invalid evidence');
  if (e.verification === 'VERIFIED' && e.support.length === 0) throw Error('Verified claim requires supporting evidence');
  if ([...e.support, ...e.contradict].some(id => !sourceIds.has(id))) throw Error('Unknown evidence source');
}
/** Candidate suggestions are never automatic merges. */
export function similarityCandidates(headline: string, stories: Story[]): string[] {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  const a = words(headline);
  return stories.filter(s => { const b = words(s.headline); return [...a].filter(w => b.has(w)).length >= 2; }).map(s => s.id).sort();
}
