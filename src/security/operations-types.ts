/** Allowlisted private development-interface projections; never credentials or editorial authority. */
import type { Status, Verification } from '../newsroom/model.ts';
import type { EditionStatus } from '../editions/types.ts';
import type { SourceQueueEntry, SourceQueuePage } from '../source-queue/types.ts';
import type { SourceReviewAction, SourceReviewProposal, SourceReviewSummary } from '../source-review/types.ts';
import type { Permission, Role } from './types.ts';

export interface OperationsLease { asOf: string; validForMs: number }
export interface OperationsOverview extends OperationsLease { roles: Role[]; permissions: Permission[] }
export interface OperationsSource {
  sourceId: string; metadata: SourceQueueEntry; proofEligible: boolean; handoffEligible: boolean;
}
export interface OperationsSources extends OperationsLease {
  page: Omit<SourceQueuePage, 'entries'> & { entries: OperationsSource[] };
}
export interface OperationsSourceDetail extends OperationsLease, OperationsSource {
  review: SourceReviewSummary;
  proposal: Pick<SourceReviewProposal, 'classification' | 'originId' | 'evidenceReferences' | 'reasonCode'> | null;
  actions: Record<SourceReviewAction, boolean>;
}
export interface OperationsStory {
  id: string; version: number; status: Status; blocked: boolean; headline: string | null; summary: string | null;
  sourceIds: string[];
  evidence: { id: string; claim: string; support: string[]; contradict: string[]; verification: Verification; uncertainty: string }[];
  actions: { edit: boolean; approve: boolean; reviewStatuses: Status[] };
}
export interface OperationsStories extends OperationsLease { stories: OperationsStory[] }
export interface OperationsEdition {
  id: string; date: string; timezone: string; revision: number; status: EditionStatus; storyCount: number; available: boolean;
  actions: { reviewStatuses: EditionStatus[] };
}
export interface OperationsEditions extends OperationsLease { editions: OperationsEdition[] }
export type OperationsDisclosure<T> = (value: T, assertCurrent: () => void) => void;
