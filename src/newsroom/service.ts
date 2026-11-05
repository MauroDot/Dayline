import { randomUUID } from 'node:crypto';
import { canonicalURL, validateSource, validateEvidence, similarityCandidates, type Source, type Story, type Status, type State, type Audit } from './model.ts';
import { JsonRepository } from './store.ts';
import { sourceId } from '../ingestion/metadata.ts';
import { invalidateDrafts } from '../editorial/lifecycle.ts';
import { eligibleSource } from '../ingestion/eligibility.ts';

const transitions: Record<Status, Status[]> = {
  INGESTED: ['CLUSTERED', 'ON_HOLD', 'REJECTED'], CLUSTERED: ['DRAFT', 'ON_HOLD', 'REJECTED'],
  DRAFT: ['NEEDS_REVIEW', 'ON_HOLD', 'REJECTED'], NEEDS_REVIEW: ['DRAFT', 'APPROVED', 'ON_HOLD', 'REJECTED'],
  APPROVED: ['PUBLISHED', 'DRAFT', 'ON_HOLD', 'REJECTED'], PUBLISHED: ['CORRECTION_REQUIRED'],
  CORRECTION_REQUIRED: ['DRAFT', 'ON_HOLD'], ON_HOLD: ['DRAFT', 'REJECTED'], REJECTED: []
};
const now = () => new Date().toISOString();
const actorName = (actor: string) => { if (!actor?.trim()) throw Error('Actor required'); return actor.trim(); };
function current(state: State, id: string): Story {
  const story = state.revisions.filter(x => x.id === id).at(-1);
  if (!story) throw Error('Unknown story');
  return story;
}
function audit(state: State, action: string, actor: string, story: Story | null): void {
  const event: Audit = { id: randomUUID(), storyId: story?.id ?? null, action, actor: actorName(actor), at: now(), version: story?.version ?? null };
  state.audit.push(event);
}
function checkStory(story: Story, state: State): void {
  if (![story.id, story.headline, story.topic, story.summary, story.geography].every(x => typeof x === 'string' && x.trim())) throw Error('Missing story fields');
  if (!Number.isFinite(Date.parse(story.firstSeenAt)) || !Number.isFinite(Date.parse(story.updatedAt)) || (story.eventAt !== null && !Number.isFinite(Date.parse(story.eventAt)))) throw Error('Invalid story timestamp');
  if (!Array.isArray(story.sourceIds) || !Array.isArray(story.evidence)) throw Error('Invalid story references');
  const ids = new Set(state.sources.map(s => s.id));
  if (story.sourceIds.some(id => !ids.has(id))) throw Error('Unknown story source');
  for (const e of story.evidence) { validateEvidence(e, ids); if ([...e.support, ...e.contradict].some(id => !story.sourceIds.includes(id))) throw Error('Evidence source not associated with story'); }
}
export class Newsroom {
  private readonly repository: JsonRepository;
  private readonly clock: () => string;
  constructor(repository: JsonRepository, options: { clock?: () => string } = {}) { this.repository = repository; this.clock = options.clock ?? now; }
  async snapshot(): Promise<State> { return this.repository.read(); }
  async ingest(input: Omit<Source, 'canonicalUrl'>, actor: string): Promise<Source> {
    return this.repository.transact(state => {
      if (state.retentionReviewRequired) throw Error('Retention policy review required before ingestion');
      const source: Source = { ...input, canonicalUrl: canonicalURL(input.url) }; validateSource(source);
      if (!new URL(source.url).hostname.endsWith('.test') || source.id.startsWith('url-') || source.rights !== 'fictional test fixture only') throw Error('Legacy fixture ingestion only; provider sources require registry workflow');
      if (state.quarantine.some(q => canonicalURL(q.providerMetadata.url) === source.canonicalUrl) || state.managedSources.some(m => canonicalURL(m.providerMetadata.url) === source.canonicalUrl) || state.deletions.some(d => d.sourceId === sourceId(source.url))) throw Error('Provider metadata cannot bypass registry or quarantine');
      if (state.sources.some(s => s.id === source.id || s.canonicalUrl === source.canonicalUrl)) throw Error('Duplicate source');
      if (source.type === 'SYNDICATED' && !state.sources.some(s => s.id === source.originId && s.type !== 'SYNDICATED')) throw Error('Unknown original report');
      state.sources.push(source); audit(state, 'SOURCE_INGESTED', actor, null); return source;
    });
  }
  async independentCount(ids: string[]): Promise<number> {
    const state = await this.snapshot();
    return new Set(ids.flatMap(id => { const source = state.sources.find(s => s.id === id); if (!source) throw Error('Unknown source'); return eligibleSource(state, source, this.clock()) ? [source.originId] : []; })).size;
  }
  async candidates(headline: string): Promise<string[]> {
    const state = await this.snapshot(); const latest = new Map(state.revisions.filter(s => !s.retentionRedacted).map(s => [s.id, s]));
    return similarityCandidates(headline, [...latest.values()]);
  }
  async create(story: Omit<Story, 'status' | 'version'>, actor: string): Promise<Story> {
    return this.repository.transact(state => {
      if (state.revisions.some(s => s.id === story.id)) throw Error('Duplicate story');
      const revision: Story = { ...story, status: 'INGESTED', version: 1 }; checkStory(revision, state);
      state.revisions.push(structuredClone(revision)); audit(state, 'STORY_CREATED', actor, revision); return revision;
    });
  }
  async edit(id: string, patch: Partial<Pick<Story, 'headline' | 'summary' | 'topic' | 'geography' | 'eventAt' | 'clusterId' | 'evidence' | 'sourceIds'>>, actor: string): Promise<Story> {
    return this.repository.transact(state => {
      const prior = current(state, id);
      if (prior.retentionRedacted) throw Error('Retention-redacted history cannot be edited');
      if (['PUBLISHED', 'REJECTED', 'ON_HOLD'].includes(prior.status)) throw Error('Story cannot be edited in this state');
      const allowed = ['headline', 'summary', 'topic', 'geography', 'eventAt', 'clusterId', 'evidence', 'sourceIds'];
      if (Object.keys(patch).some(key => !allowed.includes(key))) throw Error('Invalid edit field');
      const revision: Story = { ...prior, ...structuredClone(patch), status: ['APPROVED', 'NEEDS_REVIEW', 'CORRECTION_REQUIRED'].includes(prior.status) ? 'DRAFT' : prior.status, version: prior.version + 1, updatedAt: now() };
      checkStory(revision, state); state.revisions.push(revision); invalidateDrafts(state, this.clock()); audit(state, 'STORY_EDITED', actor, revision); return revision;
    });
  }
  async transition(id: string, next: Status, actor: string): Promise<Story> {
    return this.repository.transact(state => {
      const prior = current(state, id); const reviewer = actorName(actor);
      if (prior.retentionRedacted) throw Error('Retention-redacted history cannot transition');
      if (state.retentionReviewRequired && ['APPROVED', 'PUBLISHED'].includes(next)) throw Error('Retention policy review required before approval or publication');
      if (['APPROVED', 'PUBLISHED'].includes(next) && prior.sourceIds.some(sourceId => { const source = state.sources.find(s => s.id === sourceId); return !source || !eligibleSource(state, source, this.clock()); })) throw Error('Ineligible source for editorial approval or publication');
      if (!transitions[prior.status].includes(next)) throw Error('Invalid editorial transition');
      if (next === 'CLUSTERED' && !prior.clusterId) throw Error('Cluster identifier required');
      if (next === 'APPROVED' && (!prior.evidence.length || prior.evidence.some(e => e.verification !== 'VERIFIED' || !e.support.length))) throw Error('Verified supported claims required');
      if (next === 'PUBLISHED' && !state.approvals.some(a => a.storyId === id && a.version === prior.version)) throw Error('Current revision requires approval');
      const revision: Story = { ...prior, status: next, version: prior.version + 1, updatedAt: now() };
      state.revisions.push(revision);
      if (next === 'APPROVED') state.approvals.push({ storyId: id, version: revision.version, reviewer, at: now() });
      invalidateDrafts(state, this.clock()); audit(state, `STATUS_${next}`, reviewer, revision); return revision;
    });
  }
}
