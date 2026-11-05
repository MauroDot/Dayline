import type { DraftClaim, DraftOutput, DraftSection, GroundedEvidence, Suggestion } from './types.ts';

const maxItems = 32;
const maxString = 4096;
const maxOutputCharacters = 65_536;
const humanReview = 'Human review is required.';
type JsonRecord = Record<string, unknown>;

function fail(): never { throw Error('Invalid or unsupported editorial output'); }
function object(value: unknown, keys: string[]): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(descriptor => !('value' in descriptor))) fail();
  return value as JsonRecord;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maxItems) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)))) fail();
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !('value' in descriptor))) fail();
  return value;
}
function string(value: unknown, empty = false): string {
  if (typeof value !== 'string' || value.length > maxString || (!empty && !value.trim())) fail();
  return value;
}
function strings(value: unknown, empty = true): string[] {
  const result = array(value).map(item => string(item));
  if ((!empty && !result.length) || new Set(result).size !== result.length) fail();
  return result;
}
function same(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * A conservative local heuristic, not an injection-immunity guarantee. Source
 * text remains untrusted and never authorizes instructions, tools, or policy.
 * This prototype has no licensed quotation path; ordinary apostrophes remain
 * usable in contractions and possessives.
 */
export function assertSafeSource(text: string): void {
  string(text, true);
  if (/["`\u201c-\u201f\u00ab\u00bb\u2039\u203a]/u.test(text)) throw Error('Quotation is unsupported by this editorial prototype');
  for (let index = 0; index < text.length; index++) {
    if (!/[\u0027\u2018\u2019]/u.test(text[index])) continue;
    const previous = text[index - 1] ?? '';
    const next = text[index + 1] ?? '';
    if (!/[\p{L}\p{N}]/u.test(previous) || (next && !/[\p{L}\p{N}\s.,;:!?)/\]}-]/u.test(next))) {
      throw Error('Quotation is unsupported by this editorial prototype');
    }
  }
  const attempts = [
    /\b(?:ignore|disregard|forget|bypass)\s+(?:(?:all|the|any)\s+)?(?:(?:previous|prior|above|system|developer|safety|security|editorial)\s+){0,5}(?:instructions?|prompts?|messages?|polic(?:y|ies)|rules?)\b/i,
    /\b(?:reveal|disclose|expose|print|dump|extract|send|show|return)\b[^.!?\n]{0,80}\b(?:secrets?|credentials?|passwords?|api[\s_-]?keys?|access[\s_-]?tokens?|private[\s_-]?keys?|system[\s_-]?prompts?)\b/i,
    /\b(?:override|disable|evade)\s+(?:(?:all|any|the)\s+)?(?:(?:safety|rights|security|editorial)\s+){0,4}(?:polic(?:y|ies)|rules?|instructions?|restrictions?|safeguards?)\b/i,
    /(?:<\|(?:im_start|im_end|system|developer|assistant|tool)[^>]*\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(?:system|developer|assistant|tool)>)/i,
    /(?:^|[\r\n])\s*(?:system|developer|assistant|tool)\s*:/i,
    /\b(?:system|developer)\s+(?:message|prompt|instructions?)\s*:/i,
    /\b(?:call|execute|invoke|run|use)\s+(?:the\s+)?(?:tools?|functions?|shell|terminal|commands?|fetch|curl)\b/i,
    /\b(?:tool_calls?|function_calls?)\s*[:=(]/i,
  ];
  if (attempts.some(pattern => pattern.test(text))) throw Error('Unsupported instruction-like source content');
}

function selectedEvidence(value: GroundedEvidence[]): GroundedEvidence[] {
  const result = array(value).map(item => {
    const entry = object(item, ['id', 'claim', 'support', 'contradict', 'uncertainty']);
    const claim = string(entry.claim); const uncertainty = string(entry.uncertainty, true);
    assertSafeSource(claim); assertSafeSource(uncertainty);
    return { id: string(entry.id), claim, support: strings(entry.support, false), contradict: strings(entry.contradict), uncertainty };
  });
  if (!result.length || new Set(result.map(entry => entry.id)).size !== result.length) fail();
  return result;
}

/** Exact extraction checks provenance consistency, not the truth of a claim. */
export function validateOutput(value: unknown, evidence: GroundedEvidence[]): DraftOutput {
  const selected = selectedEvidence(evidence);
  const evidenceById = new Map(selected.map(entry => [entry.id, entry]));
  const root = object(value, ['headline', 'summary', 'sections', 'claims', 'uncertainties']);
  const headline = string(root.headline); const summary = string(root.summary);
  assertSafeSource(headline); assertSafeSource(summary);
  const claims: DraftClaim[] = array(root.claims).map(item => {
    const entry = object(item, ['evidenceId', 'text', 'supportingSourceIds', 'contradictingSourceIds']);
    const evidenceId = string(entry.evidenceId); const text = string(entry.text); assertSafeSource(text);
    const supportingSourceIds = strings(entry.supportingSourceIds, false);
    const contradictingSourceIds = strings(entry.contradictingSourceIds);
    const stored = evidenceById.get(evidenceId);
    if (!stored || stored.claim !== text || !same(stored.support, supportingSourceIds) || !same(stored.contradict, contradictingSourceIds)) fail();
    return { evidenceId, text, supportingSourceIds, contradictingSourceIds };
  });
  if (claims.length !== selected.length || new Set(claims.map(claim => claim.evidenceId)).size !== claims.length) fail();
  if (!claims.some(claim => claim.text === headline) || summary !== claims.map(claim => claim.text).join(' ')) fail();
  const factIds = new Set<string>();
  const uncertaintyIds = new Set<string>();
  let analysisSeen = false;
  const sections: DraftSection[] = array(root.sections).map(item => {
    const entry = object(item, ['kind', 'text', 'evidenceIds']);
    const kind = string(entry.kind); const text = string(entry.text); assertSafeSource(text);
    const evidenceIds = strings(entry.evidenceIds, false);
    if (!evidenceIds.every(id => evidenceById.has(id))) fail();
    if (kind === 'FACT') {
      if (evidenceIds.length !== 1 || factIds.has(evidenceIds[0]) || evidenceById.get(evidenceIds[0])!.claim !== text) fail();
      factIds.add(evidenceIds[0]);
    } else if (kind === 'UNCERTAINTY') {
      if (evidenceIds.some(id => uncertaintyIds.has(id) || !evidenceById.get(id)!.uncertainty.trim() || evidenceById.get(id)!.uncertainty !== text)) fail();
      evidenceIds.forEach(id => uncertaintyIds.add(id));
    } else if (kind === 'ANALYSIS') {
      if (analysisSeen || text !== humanReview) fail();
      analysisSeen = true;
    } else fail();
    return { kind, text, evidenceIds } as DraftSection;
  });
  const expectedUncertainties = [...new Set(selected.filter(entry => entry.uncertainty.trim()).map(entry => entry.uncertainty))];
  const uncertainties = strings(root.uncertainties);
  uncertainties.forEach(assertSafeSource);
  if (factIds.size !== selected.length || uncertaintyIds.size !== selected.filter(entry => entry.uncertainty.trim()).length
    || uncertainties.length !== expectedUncertainties.length || uncertainties.some(value => !expectedUncertainties.includes(value))) fail();
  const result = { headline, summary, sections, claims, uncertainties };
  if (JSON.stringify(result).length > maxOutputCharacters) fail();
  return result;
}

const readable = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor) ? value as JsonRecord : {};
const readableArray = (value: unknown): unknown[] => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor) ? value : [];
const readableText = (value: unknown): string => typeof value === 'string' ? value : '';
const numericTokens = (value: string): string[] => value.match(/(?<![\p{L}\p{N}])[-+]?\d+(?:[,.]\d+)*(?:%|\b)/gu) ?? [];

/** Advisory review cues; they never change facts, rights, approval or publication. */
export function analyzeNeutrality(output: DraftOutput, evidence: GroundedEvidence[]): Suggestion[] {
  const root = readable(output);
  const selected = readableArray(evidence).map(readable);
  const claims = readableArray(root.claims).map(readable);
  const sections = readableArray(root.sections).map(readable);
  const headline = readableText(root.headline); const summary = readableText(root.summary);
  const texts = [headline, summary, ...claims.map(claim => readableText(claim.text)), ...sections.map(section => readableText(section.text))];
  const stored = new Map(selected.map(entry => [readableText(entry.id), entry]));
  const exactTexts = new Set(selected.flatMap(entry => [readableText(entry.claim), readableText(entry.uncertainty)]));
  exactTexts.add(selected.map(entry => readableText(entry.claim)).join(' '));
  const suggestions: Suggestion[] = [];
  const add = (code: Suggestion['code'], message: string) => { if (!suggestions.some(suggestion => suggestion.code === code)) suggestions.push({ code, message }); };
  if (texts.some(text => /\b(?:evil|traitors?|vermin|disgusting|outrageous|shameful|hysterical|idiotic?|monsters?|tyrannical|corrupt)\b/i.test(text))) {
    add('LOADED_LANGUAGE', 'Review loaded or inflammatory wording in its evidentiary context.');
  }
  if (texts.some(text => /\b(?:caused?|causes|because|therefore|led to|resulted in|as a result)\b/i.test(text) && !exactTexts.has(text))) {
    add('UNSUPPORTED_CAUSALITY', 'Review causal wording that is not an exact supported evidence claim.');
  }
  if (texts.some(text => /\b(?:fraud(?:ulent)?|bribery|stole|lied|criminal|corrupt)\b/i.test(text)
    && !/\b(?:according to|said|says|alleged|accused|reported|court|complaint|prosecutor|audit|convicted|found)\b/i.test(text))) {
    add('UNATTRIBUTED_ALLEGATION', 'Check attribution and the established status of an allegation.');
  }
  if (texts.some(text => /\b(?:undeniably|certainly|undoubtedly|definitely|always|never|proves?|guaranteed|no doubt)\b/i.test(text) && !exactTexts.has(text))) {
    add('MISLEADING_CERTAINTY', 'Review certainty that goes beyond the supplied evidence wording.');
  }
  const expressedUncertainties = readableArray(root.uncertainties).filter((value): value is string => typeof value === 'string');
  if (selected.some(entry => readableText(entry.uncertainty).trim() && (!expressedUncertainties.includes(readableText(entry.uncertainty))
    || !sections.some(section => section.kind === 'UNCERTAINTY' && section.text === entry.uncertainty && readableArray(section.evidenceIds).includes(entry.id))))) {
    add('MISSING_UNCERTAINTY', 'Preserve every selected evidence uncertainty with its evidence reference.');
  }
  let unsupportedNumbers = claims.some(claim => {
    const reference = stored.get(readableText(claim.evidenceId));
    const allowed = new Set(numericTokens(readableText(reference?.claim)));
    return numericTokens(readableText(claim.text)).some(token => !allowed.has(token));
  });
  unsupportedNumbers ||= sections.some(section => {
    const ids = readableArray(section.evidenceIds);
    const allowedText = ids.flatMap(id => {
      const reference = typeof id === 'string' ? stored.get(id) : undefined;
      return section.kind === 'UNCERTAINTY' ? [readableText(reference?.uncertainty)] : section.kind === 'FACT' ? [readableText(reference?.claim)] : [];
    }).join(' ');
    const allowed = new Set(numericTokens(allowedText));
    return numericTokens(readableText(section.text)).some(token => !allowed.has(token));
  });
  unsupportedNumbers ||= numericTokens(headline).length > 0 && !selected.some(entry => entry.claim === headline);
  unsupportedNumbers ||= numericTokens(summary).length > 0 && summary !== claims.map(claim => readableText(claim.text)).join(' ');
  if (unsupportedNumbers) add('UNSUPPORTED_NUMBERS', 'Verify numbers and dates against the particular cited evidence.');
  if ([...claims, ...sections.filter(section => section.kind === 'FACT')].some(entry => /\b(?:should|best|worst|obviously|unacceptable|deserves?|ought to)\b/i.test(readableText(entry.text))
    && !exactTexts.has(readableText(entry.text)))) {
    add('OPINION_AS_FACT', 'Separate recommendations or evaluative judgments from supported factual claims.');
  }
  if (selected.some(entry => readableArray(entry.contradict).some(id => !claims.some(claim => claim.evidenceId === entry.id && readableArray(claim.contradictingSourceIds).includes(id))))) {
    add('MISSING_COUNTEREVIDENCE', 'Preserve counterevidence references attached to the selected claims.');
  }
  if (!headline || !claims.some(claim => claim.text === headline) || !summary.includes(headline)) {
    add('HEADLINE_BODY_CONFLICT', 'Align the headline with a supported claim represented in the body.');
  }
  return suggestions;
}
