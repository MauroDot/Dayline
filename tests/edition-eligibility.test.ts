import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, canonicalURL, type Source, type State, type Story } from '../src/newsroom/model.ts';
import { managed, sourceId } from '../src/ingestion/metadata.ts';
import { getPolicy } from '../src/ingestion/policies.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import { buildPlacement } from '../src/editions/eligibility.ts';
import { analyzePlacement } from '../src/editions/advisory.ts';
import type { AdvisoryCode, Placement } from '../src/editions/types.ts';

const at = '2026-06-01T12:00:00.000Z';
const tomorrow = '2026-06-02T12:00:00.000Z';
const storyId = 'fictional-edition-story';
const headline = 'The fictional vote passed.';

function fixture(): { state: State; story: Story; ids: string[] } {
  const state = emptyState();
  const policy = getPolicy('fictional-fixture', 'fictional-ai-editorial-v1', at);
  const ids = ['first', 'second'].map(name => sourceId(`https://edition.example.test/${name}`));
  for (const [index, name] of ['first', 'second'].entries()) {
    const url = `https://edition.example.test/${name}`;
    const article: ProviderArticle = { providerId: 'fictional-fixture', url, publisher: `Fictional ${name} publisher`,
      publishedAt: at, retrievedAt: at, provenance: { type: 'ORIGINAL', originId: null } };
    state.managedSources.push(managed(article, policy, at));
    state.sources.push({ id: ids[index], url, canonicalUrl: canonicalURL(url), publisher: article.publisher,
      publishedAt: at, retrievedAt: at, type: 'ORIGINAL', originId: ids[index], rights: JSON.stringify(policy), verification: 'UNVERIFIED' });
    state.provenanceDecisions.push({ id: `decision-${index}`, sourceId: ids[index], classification: 'ORIGINAL', originId: null,
      actorAssertion: 'fictional-reviewer', at, reason: 'Invented original report fixture', evidenceReferences: ['fictional-evidence:origin'] });
  }
  const story: Story = { id: storyId, headline, summary: headline, topic: 'Fictional policy', geography: 'Invented town',
    eventAt: null, firstSeenAt: at, updatedAt: at, clusterId: 'fictional-cluster', sourceIds: [...ids], status: 'APPROVED', version: 3,
    evidence: [
      { id: 'claim-one', claim: headline, support: [ids[0]], contradict: [], verification: 'VERIFIED', uncertainty: '', reviewerDecisions: [] },
      { id: 'claim-two', claim: 'A fictional meeting is planned.', support: [ids[1]], contradict: [], verification: 'VERIFIED', uncertainty: '', reviewerDecisions: [] },
    ] };
  state.revisions.push({ ...structuredClone(story), status: 'DRAFT', version: 1 },
    { ...structuredClone(story), status: 'NEEDS_REVIEW', version: 2 }, story);
  state.approvals.push({ storyId, version: 3, reviewer: 'fictional-reviewer', at });
  return { state, story, ids };
}
function placement(state: State): Placement { return buildPlacement(state, storyId, 3, false, at); }
function blocked(change: (state: State, story: Story, ids: string[]) => void): void {
  const { state, story, ids } = fixture(); change(state, story, ids);
  assert.throws(() => placement(state), error => error instanceof Error && error.message === 'Ineligible edition placement');
}

test('eligible placements copy exact approved presentation and allowlisted evidence with sorted provenance snapshots', () => {
  const { state, story } = fixture(), before = structuredClone(state);
  const result = placement(state);
  assert.equal(result.storyVersion, 3); assert.equal(result.headline, story.headline); assert.equal(result.summary, story.summary);
  assert.equal(result.independentSourceCount, 2); assert.equal(result.expiresAt, tomorrow);
  assert.deepEqual(result.sources.map(source => source.sourceId), [...story.sourceIds].sort());
  assert.ok(result.sources.every(source => /^[a-f0-9]{64}$/.test(source.snapshotDigest)));
  assert.deepEqual(Object.keys(result.evidence[0]).sort(), ['id', 'support', 'contradict', 'uncertainty'].sort());
  assert.equal(JSON.stringify(result).includes('fictional-reviewer'), false);
  assert.deepEqual(state, before);
});

test('only the latest exact approved revision is eligible', () => {
  for (const status of ['DRAFT', 'NEEDS_REVIEW', 'PUBLISHED', 'ON_HOLD', 'REJECTED', 'CORRECTION_REQUIRED'] as const) {
    blocked((_state, story) => { story.status = status; });
  }
  const { state } = fixture();
  for (const version of [0, 1, 2, 4, Number.NaN, 1.5]) assert.throws(() => buildPlacement(state, storyId, version, false, at));
  assert.throws(() => buildPlacement(state, 'missing-story', 3, false, at));
});

test('duplicate or out-of-order story versions fail closed', () => {
  blocked((state, story) => { state.revisions.push(structuredClone(story)); });
  blocked(state => { state.revisions[0].version = 2; });
  blocked(state => { state.revisions.reverse(); });
  blocked((_state, story) => { story.version = Number.NaN; });
});

test('a real matching unredacted approval is required rather than a status label alone', () => {
  blocked(state => { state.approvals = []; });
  blocked(state => { state.approvals[0].version = 2; });
  blocked(state => { state.approvals[0].retentionRedacted = true; });
  blocked(state => { state.approvals.push(structuredClone(state.approvals[0])); });
  blocked(state => { state.approvals[0].reviewer = ''; });
  blocked(state => { state.approvals[0].at = tomorrow; });
  blocked(state => { state.approvals[0].at = 'invalid approval date'; });
});

test('retention holds and redacted stories block placement even with an old approval', () => {
  blocked(state => { state.retentionReviewRequired = true; });
  blocked((_state, story) => { story.retentionRedacted = true; });
  blocked((_state, story) => { story.updatedAt = '2026-02-30T12:00:00.000Z'; });
});

test('copied headline and summary are bounded without silently truncating approved text', () => {
  const { state, story } = fixture(); story.headline = 'h'.repeat(512); story.summary = 's'.repeat(4096);
  assert.equal(placement(state).headline.length, 512); assert.equal(placement(state).summary.length, 4096);
  blocked((_state, item) => { item.headline = 'h'.repeat(513); });
  blocked((_state, item) => { item.summary = 's'.repeat(4097); });
  blocked((_state, item) => { item.headline = ' '; });
  blocked((_state, item) => { item.summary = ''; });
});

test('every evidence record must be unique verified supported and internally referenced', () => {
  const changes: ((story: Story, ids: string[]) => void)[] = [
    item => { item.evidence = []; }, item => { item.evidence[0].verification = 'DISPUTED'; },
    item => { item.evidence[0].verification = 'UNVERIFIED'; }, item => { item.evidence[0].claim = ''; },
    item => { item.evidence[0].id = ''; }, item => { item.evidence[0].support = []; },
    item => { item.evidence.push(structuredClone(item.evidence[0])); },
    (item, ids) => { item.evidence[0].support = [ids[0], ids[0]]; },
    (item, ids) => { item.evidence[0].contradict = [ids[1], ids[1]]; },
    item => { item.evidence[0].support = ['missing-source']; }, item => { item.evidence[0].contradict = ['missing-source']; },
    (item, ids) => { item.evidence[0].contradict = [ids[0]]; },
    item => { item.evidence[0].uncertainty = 'u'.repeat(2049); },
  ];
  for (const change of changes) blocked((_state, story, ids) => change(story, ids));
});

test('evidence cardinality is bounded at sixteen and source IDs cannot duplicate', () => {
  const { state, story } = fixture();
  story.evidence = Array.from({ length: 16 }, (_, index) => ({ ...structuredClone(story.evidence[0]), id: `claim-${index}` }));
  assert.equal(placement(state).evidence.length, 16);
  story.evidence.push({ ...structuredClone(story.evidence[0]), id: 'claim-over-limit' });
  assert.throws(() => placement(state));
  blocked((_state, item) => { item.sourceIds.push(item.sourceIds[0]); });
});

test('each source needs exactly one managed record and a matching stored source', () => {
  blocked(state => { state.managedSources.shift(); });
  blocked(state => { state.managedSources.push(structuredClone(state.managedSources[0])); });
  blocked(state => { state.sources.shift(); });
  blocked(state => { state.sources.push(structuredClone(state.sources[0])); });
  blocked(state => { state.sources[0].verification = 'DISPUTED'; });
  blocked(state => { state.managedSources[0].providerId = 'gnews'; });
});

test('exact active fictional excerpt and internal-analysis rights are required', () => {
  blocked(state => { state.managedSources[0].policy = getPolicy('fictional-fixture', 'fictional-metadata-v1', at); });
  blocked(state => { state.managedSources[0].policy.licensedExcerpt = false; });
  blocked(state => { state.managedSources[0].policy.internalAnalysis = false; });
  blocked(state => { state.managedSources[0].policy.aiSummarization = false; });
  blocked(state => { state.managedSources[0].policy.id = 'unknown-policy'; });
  blocked(state => { Object.assign(state.managedSources[0].policy, { id: 'fictional-ai-revoked-v1', reviewStatus: 'REVOKED', evidenceReference: 'fictional-fixture-only:fictional-ai-revoked-v1' }); });
  blocked(state => { Object.assign(state.managedSources[0].policy, { undeclaredGrant: true }); });
});

test('source identity cannot diverge from retained provider metadata', () => {
  blocked(state => { state.sources[0].publisher = 'Other publisher'; });
  blocked(state => { state.sources[0].url += '?utm_source=alias'; state.sources[0].canonicalUrl = canonicalURL(state.sources[0].url); });
  blocked(state => { state.sources[0].publishedAt = '2026-06-01T11:00:00.000Z'; });
  blocked(state => { state.sources[0].retrievedAt = '2026-06-01T11:00:00.000Z'; });
  blocked(state => { state.sources[0].canonicalUrl = 'https://different.example.test/'; });
  blocked(state => { state.managedSources[0].providerMetadata.url = 'https://real.example.com/report'; });
  blocked(state => { state.managedSources[0].providerMetadata.url += '?api_key=FICTIONAL_SECRET'; });
});

test('provenance must have explicit consistent current decisions with evidence and valid timing', () => {
  blocked(state => { state.provenanceDecisions.shift(); });
  blocked(state => { state.provenanceDecisions[0].classification = 'SECONDARY'; });
  blocked(state => { state.provenanceDecisions[0].originId = 'other-origin'; });
  blocked(state => { state.provenanceDecisions[0].evidenceReferences = []; });
  blocked(state => { state.provenanceDecisions[0].actorAssertion = ''; });
  blocked(state => { state.provenanceDecisions[0].at = tomorrow; });
  blocked(state => { state.provenanceDecisions.push({ ...state.provenanceDecisions[0], classification: 'DISPUTED' }); });
  blocked(state => { state.managedSources[0].providerProvenance = { type: 'SECONDARY', originId: null }; });
});

test('expiry is the earliest captured deadline and expires at its exact boundary', () => {
  const { state } = fixture();
  state.managedSources[1].deleteAt = '2026-06-01T18:00:00.000Z';
  assert.equal(placement(state).expiresAt, '2026-06-01T18:00:00.000Z');
  assert.throws(() => buildPlacement(state, storyId, 3, false, '2026-06-01T18:00:00.000Z'));
  assert.throws(() => buildPlacement(fixture().state, storyId, 3, false, tomorrow));
  blocked(item => { item.managedSources[0].retainedAt = tomorrow; });
});

test('quarantined aliases and deletion markers cannot restore approval eligibility', () => {
  blocked(state => { state.quarantine.push({ ...structuredClone(state.managedSources[0]), metadata: structuredClone(state.managedSources[0].providerMetadata) }); });
  blocked((state, _story, ids) => { state.deletions.push({ sourceId: ids[0], at, reason: 'RETENTION_EXPIRED', expiresAt: tomorrow }); });
});

test('syndicated copies capture the licensed original and share one independence identity', () => {
  const { state, story, ids } = fixture();
  const original = state.sources[0], url = 'https://edition.example.test/syndicated';
  const id = sourceId(url), policy = state.managedSources[0].policy;
  const article: ProviderArticle = { providerId: 'fictional-fixture', url, publisher: 'Fictional syndication publisher',
    publishedAt: at, retrievedAt: at, provenance: { type: 'SYNDICATED', originId: original.id } };
  state.managedSources.push(managed(article, policy, at));
  const syndicated: Source = { ...structuredClone(original), id, url, canonicalUrl: canonicalURL(url), publisher: article.publisher,
    type: 'SYNDICATED', originId: original.id };
  state.sources.push(syndicated);
  state.provenanceDecisions.push({ ...structuredClone(state.provenanceDecisions[0]), id: 'syndication-decision', sourceId: id,
    classification: 'SYNDICATED', originId: original.id });
  story.sourceIds = [id]; story.evidence = [{ ...story.evidence[0], support: [id], contradict: [] }];
  state.managedSources[0].deleteAt = '2026-06-01T16:00:00.000Z';
  const result = placement(state);
  assert.deepEqual(result.sources.map(source => source.sourceId), [ids[0], id].sort());
  assert.equal(result.independentSourceCount, 1); assert.equal(result.expiresAt, '2026-06-01T16:00:00.000Z');
  original.verification = 'DISPUTED';
  assert.throws(() => placement(state));
  original.verification = 'UNVERIFIED';
  state.managedSources[0].policy = getPolicy('fictional-fixture', 'fictional-metadata-v1', at);
  assert.throws(() => placement(state));
});

test('placement snapshots are independent copies and generic failures expose no source payload', () => {
  const { state } = fixture(), before = structuredClone(state);
  const result = placement(state); result.evidence[0].support.length = 0; result.sources[0].publisher = 'changed';
  assert.deepEqual(state, before);
  state.sources[0].url = 'FICTIONAL_SECRET_INVALID_URL';
  assert.throws(() => placement(state), error => error instanceof Error && error.message === 'Ineligible edition placement'
    && !String(error).includes('FICTIONAL_SECRET'));
});

test('a fully supported plain presentation needs no advisory warning and analysis mutates nothing', () => {
  const { state, story } = fixture(), selected = placement(state), before = structuredClone({ selected, story });
  assert.deepEqual(analyzePlacement(selected, story), []);
  assert.deepEqual({ selected, story }, before);
});

test('all eight edition advisory cues remain bounded generic suggestions rather than approval decisions', () => {
  const cases: [AdvisoryCode, (selected: Placement, story: Story) => void][] = [
    ['UNSUPPORTED_HEADLINE', selected => { selected.headline = 'An unsupported fictional assertion'; }],
    ['MISLEADING_PROMINENCE', selected => { selected.featured = true; selected.independentSourceCount = 1; }],
    ['MISSING_ATTRIBUTION', selected => { selected.sources[0].publisher = ''; }],
    ['MISSING_UNCERTAINTY', (_selected, story) => { story.evidence[0].uncertainty = 'The fictional result remains uncertain.'; }],
    ['UNDISCLOSED_CONTRADICTIONS', (_selected, story) => { story.evidence[0].contradict = [story.sourceIds[1]]; }],
    ['SYNDICATED_REPETITION', selected => { selected.independentSourceCount = 1; }],
    ['HEADLINE_ARTICLE_CONFLICT', selected => { selected.headline = 'The fictional vote passed by 10 votes.'; selected.summary = 'The fictional vote passed by 3 votes.'; }],
    ['OPINION_AS_FACT', selected => { selected.headline = 'The fictional proposal is obviously the best.'; }],
  ];
  for (const [code, change] of cases) {
    const { state, story } = fixture(), selected = placement(state); change(selected, story);
    const before = structuredClone({ selected, story }), suggestions = analyzePlacement(selected, story);
    assert.ok(suggestions.some(suggestion => suggestion.code === code), code);
    assert.equal(new Set(suggestions.map(suggestion => suggestion.code)).size, suggestions.length);
    assert.ok(suggestions.every(suggestion => suggestion.storyId === storyId && suggestion.message.length < 200));
    assert.deepEqual({ selected, story }, before);
  }
});

test('advisory preserves explicitly disclosed uncertainty counterevidence and opinion labels', () => {
  const { state, story } = fixture(), selected = placement(state);
  story.evidence[0].uncertainty = 'Timing remains uncertain.'; story.evidence[0].contradict = [story.sourceIds[1]];
  selected.summary = 'Analysis argues the proposal should proceed. Timing remains uncertain. Counterevidence questions the result.';
  const suggestions = analyzePlacement(selected, story);
  for (const code of ['MISSING_UNCERTAINTY', 'UNDISCLOSED_CONTRADICTIONS', 'OPINION_AS_FACT']) assert.equal(suggestions.some(item => item.code === code), false);
});
