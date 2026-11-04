import type { Source, State } from '../newsroom/model.ts';
import { canonicalURL } from '../newsroom/model.ts';
import { sourceId, retentionDeadline } from './metadata.ts';
import { policyStatus } from './policies.ts';
/** Legacy internal newsroom sources are preserved; imported sources must still be eligible. */
export function eligibleSource(state: State, source: Source, at: string, visited = new Set<string>()): boolean {
  if (visited.has(source.id) || state.quarantine.some(q => q.sourceId === source.id) || state.deletions.some(d => d.sourceId === source.id)) return false;
  visited.add(source.id);
  if (state.deletions.some(d => d.sourceId === sourceId(source.url)) || state.quarantine.some(q => canonicalURL(q.providerMetadata.url) === source.canonicalUrl)) return false;
  const record = state.managedSources.find(m => m.sourceId === source.id);
  if (!record && (source.id.startsWith('url-') || state.managedSources.some(m => canonicalURL(m.providerMetadata.url) === source.canonicalUrl))) return false;
  const now = Date.parse(at);
  if (!Number.isFinite(now)) return false;
  let deadline = Infinity;
  try { if (record) deadline = retentionDeadline(record); } catch { return false; }
  if (record && (policyStatus(record.policy, at) !== 'ACTIVE' || deadline <= now
    || !Number.isFinite(deadline) || !state.provenanceDecisions.some(d => d.sourceId === source.id && !['UNKNOWN','DISPUTED'].includes(d.classification)))) return false;
  if (source.type === 'SYNDICATED') {
    const original = state.sources.find(s => s.id === source.originId && ['PRIMARY','ORIGINAL'].includes(s.type));
    return !!original && eligibleSource(state, original, at, visited);
  }
  return true;
}
