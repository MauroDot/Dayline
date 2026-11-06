import { randomUUID } from 'node:crypto';
import { JsonRepository } from '../newsroom/store.ts';
import type { State } from '../newsroom/model.ts';
import { timestamp } from '../ingestion/metadata.ts';
import { buildPlacement } from './eligibility.ts';
import { analyzePlacement } from './advisory.ts';
import { invalidateEditions } from './lifecycle.ts';
import { sectionIds, type ActiveEdition, type EditionRevision, type EditionSection, type EditionStatus, type PlacementInput } from './types.ts';

const transitions: Record<EditionStatus, readonly EditionStatus[]> = {
  ASSEMBLING: ['NEEDS_REVIEW', 'ON_HOLD', 'REJECTED'],
  NEEDS_REVIEW: ['READY_FOR_APPROVAL', 'REVISION_REQUESTED', 'ON_HOLD', 'REJECTED'],
  READY_FOR_APPROVAL: ['REVISION_REQUESTED', 'ON_HOLD', 'REJECTED'],
  REVISION_REQUESTED: ['NEEDS_REVIEW', 'ON_HOLD', 'REJECTED'],
  ON_HOLD: ['NEEDS_REVIEW', 'REVISION_REQUESTED', 'REJECTED'],
  REJECTED: [], INVALIDATED: [],
};
export class EditionError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'EditionError'; this.code = code; }
}
function assertion(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) throw new EditionError('INVALID_REVIEWER_ASSERTION');
}
function dateScope(date: string, timezone: string): string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date
    || typeof timezone !== 'string' || !timezone.trim()) throw new EditionError('INVALID_EDITION_DATE');
  try { return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone; }
  catch { throw new EditionError('INVALID_EDITION_TIMEZONE'); }
}
function latest(state: State, id: string): EditionRevision {
  const edition = state.editions.filter(row => row.id === id).at(-1);
  if (!edition) throw new EditionError('EDITION_NOT_FOUND');
  return edition;
}
function audit(state: State, action: string, at: string): void {
  state.audit.push({ id:randomUUID(), storyId:null, action, actor:'edition-service', at, version:null });
}
function sectionsFor(state: State, inputs: PlacementInput[], at: string): Pick<ActiveEdition, 'sections' | 'suggestions'> {
  if (!Array.isArray(inputs) || inputs.length > 100) throw new EditionError('INVALID_PLACEMENTS');
  const sections: EditionSection[] = sectionIds.map(id => ({id, placements:[]}));
  const suggestions: ActiveEdition['suggestions'] = [];
  const seen = new Set<string>(); let featured = false;
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['storyId','storyVersion','section','featured'].includes(key))
      || typeof input.storyId !== 'string' || !input.storyId.trim()
      || !Number.isSafeInteger(input.storyVersion) || input.storyVersion < 1
      || !sectionIds.includes(input.section)
      || (input.featured !== undefined && typeof input.featured !== 'boolean')) throw new EditionError('INVALID_PLACEMENT');
    if (seen.has(input.storyId)) throw new EditionError('DUPLICATE_STORY_PLACEMENT');
    seen.add(input.storyId);
    if (input.featured && (featured || input.section !== 'TOP_STORIES')) throw new EditionError('INVALID_FEATURED_PLACEMENT');
    featured ||= input.featured === true;
    let placement;
    try { placement = buildPlacement(state, input.storyId, input.storyVersion, input.featured === true, at); }
    catch { throw new EditionError('INELIGIBLE_STORY_PLACEMENT'); }
    sections.find(section => section.id === input.section)!.placements.push(placement);
    const story = state.revisions.find(row => row.id === input.storyId && row.version === input.storyVersion)!;
    suggestions.push(...analyzePlacement(placement, story));
  }
  return {sections, suggestions};
}

/** Shared atomic assembly boundary; creates no review or publication authority. */
export function createEditionInState(state: State, input: {date: string; timezone: string; placements: PlacementInput[]}, at: string): ActiveEdition {
  timestamp(at);
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['date','timezone','placements'].includes(key))) throw new EditionError('INVALID_EDITION_INPUT');
  const timezone = dateScope(input.date, input.timezone);
  if (state.editions.some(row => row.date === input.date && row.timezone === timezone)) throw new EditionError('EDITION_DATE_ALREADY_EXISTS');
  const contents = sectionsFor(state, input.placements, at);
  const edition: ActiveEdition = { id:randomUUID(), date:input.date, timezone, revision:1, status:'ASSEMBLING', createdAt:at, updatedAt:at, ...contents };
  state.editions.push(edition); audit(state, 'EDITION_CREATED', at); return edition;
}

/** Trusted local fictional workflow only; reviewer labels are unauthenticated assertions. */
export class EditionService {
  private readonly repository: JsonRepository;
  private readonly clock: () => string;
  constructor(repository: JsonRepository, options: {clock?: () => string} = {}) {
    this.repository = repository; this.clock = options.clock ?? (() => new Date().toISOString());
  }
  private now(): string { return new Date(timestamp(this.clock())).toISOString(); }
  /** Persist invalidation even when the requested action is denied. No partial edit is applied. */
  private async transact<T>(change: (state: State, at: string) => T): Promise<T> {
    const result = await this.repository.transact(state => {
      const at = this.now(); // Read time only after obtaining the repository lock.
      invalidateEditions(state, at);
      const proposed = structuredClone(state);
      try { const value = change(proposed, at); Object.assign(state, proposed); return {value}; }
      catch (error) {
        audit(state, 'EDITION_ACTION_DENIED', at);
        return {error: error instanceof EditionError ? error.code : 'EDITION_ACTION_FAILED'};
      }
    });
    if ('error' in result) throw new EditionError(result.error ?? 'EDITION_ACTION_FAILED');
    return result.value as T;
  }
  async create(input: {date: string; timezone: string; placements: PlacementInput[]}, actorAssertion: string): Promise<ActiveEdition> {
    return this.transact((state, at) => {
      assertion(actorAssertion);
      return createEditionInState(state, input, at);
    });
  }
  async edit(id: string, expectedRevision: number, placements: PlacementInput[], actorAssertion: string): Promise<ActiveEdition> {
    return this.transact((state, at) => {
      assertion(actorAssertion); const prior = latest(state, id);
      if (prior.revision !== expectedRevision) throw new EditionError('STALE_EDITION_REVISION');
      if (prior.status === 'REJECTED') throw new EditionError('EDITION_REJECTED');
      const contents = sectionsFor(state, placements, at);
      const edition: ActiveEdition = {id:prior.id, date:prior.date, timezone:prior.timezone, revision:prior.revision+1,
        createdAt:prior.createdAt, updatedAt:at, status:'ASSEMBLING', ...contents};
      state.editions.push(edition); audit(state, 'EDITION_EDITED', at); return edition;
    });
  }
  async review(id: string, expectedRevision: number, next: EditionStatus, actorAssertion: string): Promise<ActiveEdition> {
    return this.transact((state, at) => {
      assertion(actorAssertion); const prior = latest(state, id);
      if (prior.revision !== expectedRevision) throw new EditionError('STALE_EDITION_REVISION');
      if (prior.status === 'INVALIDATED') throw new EditionError('EDITION_INVALIDATED');
      if (!transitions[prior.status].includes(next)) throw new EditionError('INVALID_EDITION_TRANSITION');
      if (['NEEDS_REVIEW','READY_FOR_APPROVAL'].includes(next)
        && (state.retentionReviewRequired || !prior.sections.some(section => section.placements.length))) throw new EditionError('EDITION_READINESS_BLOCKED');
      const edition: ActiveEdition = {...prior, revision:prior.revision+1, updatedAt:at, status:next as ActiveEdition['status']};
      state.editions.push(edition);
      state.editionReviews.push({editionId:id, fromRevision:prior.revision, toRevision:edition.revision,
        fromState:prior.status, toState:edition.status, actorAssertion, unauthenticated:true, at});
      audit(state, 'EDITION_REVIEW_RECORDED', at); return edition;
    });
  }
  async snapshot(id: string): Promise<EditionRevision> { return this.transact(state => latest(state, id)); }
}
