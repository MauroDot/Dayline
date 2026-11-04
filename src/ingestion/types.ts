import type { SourceType } from '../newsroom/model.ts';
export interface RightsPolicy {
  id: string; discoveryMetadata: boolean; licensedExcerpt: boolean; licensedFullText: boolean; media: boolean;
  internalAnalysis: boolean; publicRedistribution: boolean; aiSummarization: boolean; aiNarration: boolean;
  retentionDays: number; deletionRequired: boolean;
}
export type Provenance = { type: Exclude<SourceType, 'SYNDICATED'>; originId: null } | { type: 'SYNDICATED'; originId: string } | { type: 'UNKNOWN'; originId: null };
export interface ProviderArticle { url: string; publisher: string; publishedAt: string; retrievedAt: string; provenance: Provenance }
export interface DiscoveryRequest { query: string; page: number; limit: number }
export interface ProviderConfig { name: string; maxArticles: number; maxPage: number; timeoutMs: number; maxAttempts: number }
export interface Provider { readonly config: ProviderConfig; discover(request: DiscoveryRequest): Promise<unknown[]> }
export function validatePolicy(policy: RightsPolicy): void {
  const keys: (keyof RightsPolicy)[] = ['discoveryMetadata','licensedExcerpt','licensedFullText','media','internalAnalysis','publicRedistribution','aiSummarization','aiNarration','deletionRequired'];
  if (!policy || typeof policy.id !== 'string' || !policy.id.trim() || keys.some(k => typeof policy[k] !== 'boolean') || !Number.isInteger(policy.retentionDays) || policy.retentionDays < 1) throw Error('Incomplete rights policy');
  if (!policy.discoveryMetadata) throw Error('Discovery metadata rights required');
}
