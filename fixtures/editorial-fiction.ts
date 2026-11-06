/** Invented source assertions, claims and policy approvals for local tests only. */
import { JsonRepository } from '../src/newsroom/store.ts';
import { Newsroom } from '../src/newsroom/service.ts';
import { ingestArticles, sourceId } from '../src/ingestion/ingest.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import type { ResolutionInput } from '../src/ingestion/records.ts';
import { timestamp } from '../src/ingestion/metadata.ts';
export const editorialAt = '2026-06-01T12:00:00.000Z';
export async function seedEditorialFixture(repository: JsonRepository, at = editorialAt) {
  const fixtureAt = new Date(timestamp(at)).toISOString();
  const articles: ProviderArticle[] = ['first', 'second'].map(name => ({ providerId:'fictional-fixture', url:`https://editorial.example.test/${name}`, publisher:`Fictional ${name} report`, publishedAt:fixtureAt, retrievedAt:fixtureAt, provenance:{type:'ORIGINAL',originId:null} }));
  const resolutions: ResolutionInput[] = articles.map(a => ({sourceId:sourceId(a.url),classification:'ORIGINAL',originId:null,actorAssertion:'fictional-editor',at:fixtureAt,evidenceReferences:['fictional-evidence:origin'],reason:'Fictional original source'}));
  const sources = articles.map(a => sourceId(a.url));
  await ingestArticles(repository, articles, {providerId:'fictional-fixture',policyId:'fictional-ai-editorial-v1'}, {dryRun:false,resolutions,clock:()=>fixtureAt});
  const newsroom = new Newsroom(repository, {clock:()=>fixtureAt});
  await newsroom.create({id:'fictional-editorial-story',headline:'A fictional garden proposal is under review',summary:'A fictional proposal is being considered',topic:'fiction',geography:'Imaginary Town',eventAt:null,firstSeenAt:fixtureAt,updatedAt:fixtureAt,clusterId:'fictional-garden',sourceIds:sources,evidence:[
    {id:'claim-a',claim:'A fictional garden proposal is under review',support:[sources[0]],contradict:[sources[1]],verification:'VERIFIED',uncertainty:'The fictional proposal has not been adopted.',reviewerDecisions:[]},
    {id:'claim-b',claim:'A second fictional report questions the proposal timeline',support:[sources[1]],contradict:[],verification:'VERIFIED',uncertainty:'Timing remains uncertain.',reviewerDecisions:[]},
  ]}, 'fictional-editor');
  await newsroom.transition('fictional-editorial-story','CLUSTERED','fictional-editor');
  const story = await newsroom.transition('fictional-editorial-story','DRAFT','fictional-editor');
  return {story,sources,newsroom};
}
