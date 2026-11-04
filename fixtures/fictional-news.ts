import type { ProviderArticle, RightsPolicy } from '../src/ingestion/types.ts';
/** Fictional examples for development; not real provider content or a license. */
export const policy: RightsPolicy = { id: 'fictional-test-policy', discoveryMetadata: true, licensedExcerpt: false, licensedFullText: false, media: false, internalAnalysis: false, publicRedistribution: false, aiSummarization: false, aiNarration: false, retentionDays: 1, deletionRequired: true };
export const articles: ProviderArticle[] = [
  { url: 'https://fiction.example.test/one?utm_source=fixture', publisher: 'Fictional Gazette', publishedAt: '2026-01-01T12:00:00Z', retrievedAt: '2026-01-02T12:00:00Z', provenance: {type:'ORIGINAL', originId:null} },
  { url: 'https://fiction.example.test/one', publisher: 'Fictional Gazette', publishedAt: '2026-01-01T12:00:00Z', retrievedAt: '2026-01-02T12:00:00Z', provenance: {type:'ORIGINAL', originId:null} },
  { url: 'https://fiction.example.test/unknown', publisher: 'Fictional Wire', publishedAt: '2026-01-01T12:00:00Z', retrievedAt: '2026-01-02T12:00:00Z', provenance: {type:'UNKNOWN', originId:null} }
];
