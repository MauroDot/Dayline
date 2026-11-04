import type { ProviderArticle } from './types.ts';
import type { RegistryPolicy } from './policies.ts';
export type ResolvedType = 'PRIMARY' | 'ORIGINAL' | 'SECONDARY' | 'SYNDICATED';
export interface ResolutionInput {
  sourceId: string;
  classification: ResolvedType | 'UNKNOWN' | 'DISPUTED';
  originId: string | null;
  actorAssertion: string;
  at: string;
  evidenceReferences: string[];
  reason: string;
}
export interface ProvenanceDecision extends ResolutionInput { id: string }
export interface ManagedSource {
  sourceId: string;
  providerId: string;
  policy: RegistryPolicy;
  retainedAt: string;
  deleteAt: string;
  providerMetadata: Pick<ProviderArticle, 'url' | 'publisher' | 'publishedAt' | 'retrievedAt'>;
  providerProvenance: ProviderArticle['provenance'];
}
export interface QuarantinedSource extends ManagedSource {
  metadata: Pick<ProviderArticle, 'url' | 'publisher' | 'publishedAt' | 'retrievedAt'>;
}
export interface DeletionMarker { sourceId: string; at: string; reason: string }
