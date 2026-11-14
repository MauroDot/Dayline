/** Internal discovery metadata, never editorial approval or publication authority. */
import type { SourceReviewStatus } from '../source-review/types.ts';
export const sourceQueueViews = ['RECENT', 'UNRESOLVED', 'RELATED', 'ELIGIBLE', 'BLOCKED', 'WITHDRAWN'] as const;
export type SourceQueueView = typeof sourceQueueViews[number];
export const sourceQueueBlockedReasons = ['RETENTION_REVIEW_REQUIRED', 'SOURCE_DELETED', 'RETENTION_EXPIRED',
  'POLICY_EXPIRED', 'POLICY_REVOKED', 'POLICY_SUPERSEDED', 'MISSING_RIGHTS', 'UNKNOWN_RIGHTS',
  'MALFORMED_RECORD', 'SOURCE_REMOVED', 'PROVENANCE_UNRESOLVED', 'PROVENANCE_DISPUTED', 'ORIGIN_UNAVAILABLE', 'SOURCE_REVIEW_HOLD'] as const;
export type SourceQueueBlockedReason = typeof sourceQueueBlockedReasons[number];
export interface SourceQueueQuery { view?: SourceQueueView; limit?: number; cursor?: string }
export interface SourceQueueEntry {
  candidateRef: string;
  publisher: string | null;
  canonicalUrl: string | null;
  publishedAt: string | null;
  retrievedAt: string | null;
  provenance: 'PRIMARY' | 'ORIGINAL' | 'SECONDARY' | 'SYNDICATED' | 'UNKNOWN' | 'DISPUTED';
  provenanceStatus: 'RESOLVED' | 'UNRESOLVED' | 'DISPUTED';
  rightsStatus: 'ACTIVE' | 'MISSING' | 'EXPIRED' | 'REVOKED' | 'SUPERSEDED' | 'UNKNOWN';
  retentionStatus: 'RETAINED' | 'EXPIRED' | 'DELETED' | 'REVIEW_REQUIRED';
  quarantineStatus: 'QUARANTINED' | 'NOT_QUARANTINED' | 'WITHHELD';
  relationship: { kind: 'SYNDICATED'; originRef: string } | null;
  sourceEligible: boolean;
  canAdvance: false;
  blockedReason: SourceQueueBlockedReason | null;
  /** Authenticated exact-source visibility only; no actor, evidence or action token. */
  review?: { status: SourceReviewStatus; revision: number; blocked: boolean; proposalPending: boolean;
    independentlyResolved: boolean; reviewAllowed: boolean };
}
export interface SourceQueuePage {
  entries: SourceQueueEntry[];
  nextCursor: string | null;
  view: SourceQueueView;
  limit: number;
  retentionReviewRequired: boolean;
}
