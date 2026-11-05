/** Internal fictional editions. No state authorizes public publication. */
export const sectionIds = ['TOP_STORIES', 'US', 'WORLD', 'POLITICS_GOVERNMENT', 'BUSINESS_MARKETS', 'TECHNOLOGY', 'SCIENCE', 'HEALTH'] as const;
export type SectionId = typeof sectionIds[number];
export const sectionLabels: Record<SectionId, string> = { TOP_STORIES:'Top Stories', US:'U.S.', WORLD:'World', POLITICS_GOVERNMENT:'Politics & Government', BUSINESS_MARKETS:'Business & Markets', TECHNOLOGY:'Technology', SCIENCE:'Science', HEALTH:'Health' };
export type EditionStatus = 'ASSEMBLING' | 'NEEDS_REVIEW' | 'READY_FOR_APPROVAL' | 'REVISION_REQUESTED' | 'ON_HOLD' | 'REJECTED' | 'INVALIDATED';
export interface PlacementInput { storyId: string; storyVersion: number; section: SectionId; featured?: boolean }
export interface EditionSource { sourceId: string; originId: string; publisher: string; url: string; providerId: string; policyId: string; policyVersion: number; snapshotDigest: string; expiresAt: string }
export interface EditionEvidence { id: string; support: string[]; contradict: string[]; uncertainty: string }
export interface Placement { storyId: string; storyVersion: number; headline: string; summary: string; featured: boolean; sources: EditionSource[]; evidence: EditionEvidence[]; independentSourceCount: number; expiresAt: string }
export interface EditionSection { id: SectionId; placements: Placement[] }
export type AdvisoryCode = 'UNSUPPORTED_HEADLINE' | 'MISLEADING_PROMINENCE' | 'MISSING_ATTRIBUTION' | 'MISSING_UNCERTAINTY' | 'UNDISCLOSED_CONTRADICTIONS' | 'SYNDICATED_REPETITION' | 'HEADLINE_ARTICLE_CONFLICT' | 'OPINION_AS_FACT';
export interface EditionSuggestion { code: AdvisoryCode; storyId: string; message: string }
export interface EditionBase { id: string; date: string; timezone: string; revision: number; createdAt: string; updatedAt: string }
export interface ActiveEdition extends EditionBase { status: Exclude<EditionStatus, 'INVALIDATED'>; sections: EditionSection[]; suggestions: EditionSuggestion[] }
/** No licensed payload, story/source linkage or reviewer identity survives invalidation. */
export interface InvalidEdition extends EditionBase { status: 'INVALIDATED'; reason: 'STALE_OR_INELIGIBLE' }
export type EditionRevision = ActiveEdition | InvalidEdition;
export interface EditionReview { editionId: string; fromRevision: number; toRevision: number; fromState: EditionStatus; toState: EditionStatus; actorAssertion: string; unauthenticated: true; at: string }
