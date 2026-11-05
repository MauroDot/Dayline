export type DraftStatus = 'GENERATED' | 'NEEDS_REVIEW' | 'REVISION_REQUESTED' | 'READY_FOR_APPROVAL' | 'REJECTED' | 'INVALIDATED' | 'ON_HOLD';
export interface GroundedEvidence {
  id: string;
  claim: string;
  support: string[];
  contradict: string[];
  uncertainty: string;
}
export interface GenerationRequest {
  promptTemplateVersion: 'dayline-editorial-v1';
  systemInstructions: string;
  /** Untrusted source assertions; never interpolated into system instructions. */
  untrustedData: { evidence: GroundedEvidence[] };
}
export interface DraftClaim { evidenceId: string; text: string; supportingSourceIds: string[]; contradictingSourceIds: string[] }
export interface DraftSection { kind: 'FACT' | 'ANALYSIS' | 'UNCERTAINTY'; text: string; evidenceIds: string[] }
export interface DraftOutput { headline: string; summary: string; sections: DraftSection[]; claims: DraftClaim[]; uncertainties: string[] }
export interface Usage { inputTokens: number; outputTokens: number; estimatedCostMicros: number }
export interface Suggestion { code: 'LOADED_LANGUAGE' | 'UNSUPPORTED_CAUSALITY' | 'UNATTRIBUTED_ALLEGATION' | 'MISLEADING_CERTAINTY' | 'MISSING_UNCERTAINTY' | 'UNSUPPORTED_NUMBERS' | 'OPINION_AS_FACT' | 'MISSING_COUNTEREVIDENCE' | 'HEADLINE_BODY_CONFLICT'; message: string }
export interface DraftPolicyReference { sourceId: string; providerId: string; policyId: string; policyVersion: number; snapshotDigest: string }
export interface ActiveDraft {
  id: string; storyId: string; storyVersion: number; version: number;
  status: Exclude<DraftStatus, 'INVALIDATED'>;
  generatedAt: string; expiresAt: string;
  providerId: string; modelVersion: string; promptTemplateVersion: 'dayline-editorial-v1';
  sourceIds: string[]; policies: DraftPolicyReference[]; output: DraftOutput;
  suggestions: Suggestion[]; usage: Usage;
}
/** Invalidated proposals retain no source/story linkage or licensed payload. */
export interface InvalidDraft { id: string; status: 'INVALIDATED'; invalidatedAt: string; reason: 'STALE_OR_INELIGIBLE' }
export type DraftRecord = ActiveDraft | InvalidDraft;
export interface DraftReview {
  draftId: string; fromVersion: number; toVersion: number;
  storyVersion: number | null; fromState: DraftStatus; toState: DraftStatus;
  actorAssertion: string; unauthenticated: true; at: string;
}
