import type { ProviderArticle } from '../src/ingestion/types.ts';
/** Fictional examples for development; not real provider content or a license. */
export const context = { providerId: 'fictional-fixture', policyId: 'fictional-metadata-v1' };
export const fixtureAt = '2026-06-01T12:00:00.000Z';
export const articles: ProviderArticle[] = [
  { providerId: 'fictional-fixture', url: 'https://fiction.example.test/one?utm_source=fixture', publisher: 'Fictional Gazette', publishedAt: '2026-01-01T12:00:00Z', retrievedAt: fixtureAt, provenance: {type:'ORIGINAL', originId:null} },
  { providerId: 'fictional-fixture', url: 'https://fiction.example.test/one', publisher: 'Fictional Gazette', publishedAt: '2026-01-01T12:00:00Z', retrievedAt: fixtureAt, provenance: {type:'ORIGINAL', originId:null} },
  { providerId: 'fictional-fixture', url: 'https://fiction.example.test/unknown', publisher: 'Fictional Wire', publishedAt: '2026-01-01T12:00:00Z', retrievedAt: fixtureAt, provenance: {type:'UNKNOWN', originId:null} }
];

import { sourceId } from '../src/ingestion/metadata.ts';
import type { ResolutionInput } from '../src/ingestion/records.ts';
export const resolutions: ResolutionInput[] = [{ sourceId: sourceId(articles[0].url), classification: 'ORIGINAL', originId: null, actorAssertion: 'fictional-reviewer', at: fixtureAt, evidenceReferences: ['fictional-fixture-only:original-report'], reason: 'Fictional original-report fixture' }];
