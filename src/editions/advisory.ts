import type { Story } from '../newsroom/model.ts';
import type { AdvisoryCode, EditionSuggestion, Placement } from './types.ts';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor) ? value as Row : {};
const list = (value: unknown): unknown[] => Array.isArray(value)
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor) ? value.slice(0, 64) : [];
const text = (value: unknown): string => typeof value === 'string' ? value.slice(0, 8192) : '';
const numbers = (value: string): string[] => value.match(/(?<![\p{L}\p{N}])\d+(?:[,.]\d+)*(?:%|\b)/gu) ?? [];

/** Review cues only. These heuristics neither assess truth nor grant editorial approval. */
export function analyzePlacement(placement: Placement, story: Story): EditionSuggestion[] {
  const selected = row(placement), article = row(story);
  const storyId = text(selected.storyId);
  const headline = text(selected.headline), summary = text(selected.summary), combined = `${headline} ${summary}`;
  const evidence = list(article.evidence).map(row);
  const sources = list(selected.sources).map(row);
  const claims = evidence.map(item => text(item.claim));
  const suggestions: EditionSuggestion[] = [];
  const add = (code: AdvisoryCode, message: string) => { suggestions.push({ code, storyId, message }); };
  const allowedNumbers = new Set(claims.flatMap(numbers));
  if (!claims.includes(headline) || numbers(headline).some(value => !allowedNumbers.has(value))) {
    add('UNSUPPORTED_HEADLINE', 'Check that the headline is supported by the approved evidence.');
  }
  if (selected.featured === true && (Number(selected.independentSourceCount) < 2
    || evidence.some(item => text(item.uncertainty).trim() || list(item.contradict).length))) {
    add('MISLEADING_PROMINENCE', 'Review featured prominence in light of the evidence and its limitations.');
  }
  if (!sources.length || sources.some(source => !text(source.publisher).trim() || !text(source.url).trim())
    || (/\b(?:fraud|bribery|stole|lied|criminal|corrupt)\b/i.test(combined)
      && !/\b(?:according to|said|says|alleged|accused|reported|court|complaint|prosecutor|audit|convicted|found)\b/i.test(combined))) {
    add('MISSING_ATTRIBUTION', 'Check source attribution and the stated status of any allegation.');
  }
  if (evidence.some(item => text(item.uncertainty).trim() && !combined.includes(text(item.uncertainty)))) {
    add('MISSING_UNCERTAINTY', 'Make relevant evidence uncertainty visible beside the headline and summary.');
  }
  if (evidence.some(item => list(item.contradict).length)
    && !/\b(?:contradict\w*|disput\w*|conflict\w*|counterevidence|questions?|uncertain\w*|however|although)\b/i.test(combined)) {
    add('UNDISCLOSED_CONTRADICTIONS', 'Review whether the presentation discloses recorded counterevidence.');
  }
  if (sources.length > Number(selected.independentSourceCount)) {
    add('SYNDICATED_REPETITION', 'Shared origins and syndicated copies do not add independent reporting.');
  }
  const headlineNumbers = numbers(headline), summaryNumbers = numbers(summary);
  if ((headlineNumbers.length > 0 && summaryNumbers.length > 0 && headlineNumbers.some(value => !summaryNumbers.includes(value)))
    || (/\b(?:not|never|no longer|denied|without)\b/i.test(headline) !== /\b(?:not|never|no longer|denied|without)\b/i.test(summary)
      && headline.toLowerCase() !== summary.toLowerCase())) {
    add('HEADLINE_ARTICLE_CONFLICT', 'Compare headline and summary wording for conflicting numbers or negation.');
  }
  if (/\b(?:should|must|obviously|outrageous|shameful|evil|best|worst)\b/i.test(combined)
    && !/\b(?:opinion|commentary|analysis|argues?|advocates?)\b/i.test(combined)) {
    add('OPINION_AS_FACT', 'Review whether evaluative or prescriptive wording needs an explicit opinion label.');
  }
  return suggestions;
}
