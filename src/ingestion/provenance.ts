import { randomUUID } from 'node:crypto';
import { canonicalURL, validateSource, type Source, type State } from '../newsroom/model.ts';
import type { ManagedSource, ProvenanceDecision, ResolutionInput } from './records.ts';
import { timestamp } from './metadata.ts';
import { eligibleSource } from './eligibility.ts';

/** Assertions and evidence, not authentication or production publishing privileges. */
export function resolveDecision(state: State, record: ManagedSource, input: ResolutionInput, at: string): { decision: ProvenanceDecision; source: Source | null } {
  if (!input || input.sourceId !== record.sourceId || !['PRIMARY','ORIGINAL','SECONDARY','SYNDICATED','UNKNOWN','DISPUTED'].includes(input.classification)
    || typeof input.actorAssertion !== 'string' || !input.actorAssertion.trim() || typeof input.reason !== 'string' || !input.reason.trim()
    || !Array.isArray(input.evidenceReferences) || !input.evidenceReferences.length || input.evidenceReferences.some(e => typeof e !== 'string' || !e.trim())) throw Error('Unsupported provenance decision');
  if (timestamp(input.at) > timestamp(at)) throw Error('Future provenance decision');
  if (input.classification === 'SYNDICATED' ? typeof input.originId !== 'string' || !input.originId : input.originId !== null) throw Error('Unsupported provenance origin');
  const raw = record.providerProvenance;
  if (!['UNKNOWN','DISPUTED'].includes(raw.type) && (raw.type !== input.classification || (raw.type === 'SYNDICATED' && raw.originId !== input.originId))) throw Error('Contradictory provenance decision');
  const prior = state.provenanceDecisions.filter(d => d.sourceId === record.sourceId && !['UNKNOWN','DISPUTED'].includes(d.classification));
  if (prior.some(d => d.classification !== input.classification || d.originId !== input.originId)) throw Error('Contradictory provenance history');
  const decision: ProvenanceDecision = { id: randomUUID(), sourceId: input.sourceId, classification: input.classification, originId: input.originId,
    actorAssertion: input.actorAssertion, at: input.at, evidenceReferences: [...input.evidenceReferences], reason: input.reason };
  if (['UNKNOWN', 'DISPUTED'].includes(input.classification)) return { decision, source: null };
  if (input.classification === 'SYNDICATED') {
    const original = state.sources.find(s => s.id === input.originId && ['PRIMARY','ORIGINAL'].includes(s.type));
    if (!original || !eligibleSource(state, original, at)) throw Error('Unknown or ineligible original report');
  }
  const m = record.providerMetadata;
  const source: Source = { id: record.sourceId, url: m.url, canonicalUrl: canonicalURL(m.url), publisher: m.publisher, publishedAt: m.publishedAt, retrievedAt: m.retrievedAt,
    type: input.classification as Source['type'], originId: input.classification === 'SYNDICATED' ? input.originId! : record.sourceId,
    rights: JSON.stringify(record.policy), verification: 'UNVERIFIED' };
  validateSource(source);
  return { decision, source };
}
