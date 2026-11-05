import type { EditionService } from './service.ts';
import { sectionIds, sectionLabels, type EditionStatus } from './types.ts';

const reviewLabels: Record<EditionStatus, string> = {
  ASSEMBLING: 'Assembly in progress; human review is required.',
  NEEDS_REVIEW: 'Human review is required.',
  READY_FOR_APPROVAL: 'Ready for approval review; development assertions are unauthenticated.',
  REVISION_REQUESTED: 'Changes requested; human review is required.',
  ON_HOLD: 'On hold for human review.',
  REJECTED: 'Rejected development proposal.',
  INVALIDATED: 'Invalidated; story or source eligibility changed.',
};

/**
 * JSON-only development display. Fresh service validation precedes every render;
 * no preview path changes a story, verifies a reviewer, or publishes an edition.
 * Random record IDs and wall-clock timestamps are omitted for fixture repeatability.
 */
export async function previewEdition(service: Pick<EditionService, 'snapshot'>, id: string) {
  const edition = await service.snapshot(id);
  const base = {
    label: 'Fictional development edition preview',
    fictional: true as const,
    developmentOnly: true as const,
    publiclyPublished: false as const,
    date: edition.date,
    timezone: edition.timezone,
    revision: edition.revision,
    status: edition.status,
    reviewLabel: reviewLabels[edition.status],
  };
  if (edition.status === 'INVALIDATED') return { ...base, reason: edition.reason, sections: [] };
  return {
    ...base,
    suggestions: edition.suggestions.map(suggestion => ({
      code: suggestion.code,
      storyId: suggestion.storyId,
      message: suggestion.message,
    })),
    sections: sectionIds.map(id => ({
      id,
      label: sectionLabels[id],
      placements: (edition.sections.find(section => section.id === id)?.placements ?? []).map(placement => ({
        storyId: placement.storyId,
        storyVersion: placement.storyVersion,
        headline: placement.headline,
        summary: placement.summary,
        featured: placement.featured,
        independentSourceCount: placement.independentSourceCount,
        sources: placement.sources.map(source => ({
          sourceId: source.sourceId,
          originId: source.originId,
          publisher: source.publisher,
          url: source.url,
        })),
        evidence: placement.evidence.map(evidence => ({
          id: evidence.id,
          support: [...evidence.support],
          contradict: [...evidence.contradict],
          uncertainty: evidence.uncertainty,
        })),
        uncertainties: [...new Set(placement.evidence.filter(evidence => evidence.uncertainty.trim()).map(evidence => evidence.uncertainty))],
        contradictionDisclosure: {
          recorded: placement.evidence.some(evidence => evidence.contradict.length > 0),
          label: placement.evidence.some(evidence => evidence.contradict.length > 0)
            ? 'Counterevidence is recorded in the selected evidence.'
            : 'No counterevidence is recorded in the selected evidence.',
          evidence: placement.evidence.filter(evidence => evidence.contradict.length > 0).map(evidence => ({
            evidenceId: evidence.id,
            sourceIds: [...evidence.contradict],
          })),
        },
      })),
    })),
  };
}
