import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GNewsProvider, normalizeGNews } from '../src/ingestion/gnews.ts';
import { ingestArticles, sourceId } from '../src/ingestion/ingest.ts';
import { Newsroom } from '../src/newsroom/service.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { articles, context, fixtureAt, resolutions } from '../fixtures/fictional-news.ts';
import type { IngestionContext } from '../src/ingestion/ingest.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
const clock = () => fixtureAt;
const settings = { clock, resolutions };
const req = {query:'fiction', page:1, limit:3};
const make = (fn: typeof fetch) => new GNewsProvider({ enabled:true, apiKey:'fictional-test-key', transport:fn });
const resp = (status: number, json: unknown = {}) => new Response(JSON.stringify(json), {status});
test('provider is disabled by default and requires credentials and bounded requests', async () => {
  let calls = 0; const fake = (async () => { calls++; return resp(200, {articles:[]}); }) as typeof fetch;
  await assert.rejects(new GNewsProvider({transport:fake}).discover(req), /PROVIDER_DISABLED/);
  await assert.rejects(new GNewsProvider({enabled:true, transport:fake}).discover(req), /MISSING_CREDENTIAL/);
  await assert.rejects(make(fake).discover({...req, page:6}), /INVALID_REQUEST/);
  await assert.rejects(make(fake).discover({...req, limit:100}), /INVALID_REQUEST/); assert.equal(calls, 0);
});
test('HTTP credential and quota errors are sanitized and not retried', async () => {
  for (const [status, code] of [[401,'UNAUTHORIZED'],[403,'FORBIDDEN'],[429,'RATE_LIMITED']] as const) {
    let calls = 0; const p = make((async () => { calls++; return resp(status); }) as typeof fetch);
    await assert.rejects(p.discover(req), error => error instanceof Error && error.message === code && !error.message.includes('fictional-test-key')); assert.equal(calls, 1);
  }
});
test('transient responses recover and exhaustion is bounded', async () => {
  let calls = 0; const p = make((async () => ++calls < 3 ? resp(503) : resp(200,{articles:[{url:'https://fiction.example.test'}]})) as typeof fetch);
  assert.equal((await p.discover(req)).length, 1); assert.equal(calls, 3);
  calls = 0; await assert.rejects(make((async () => {calls++; return resp(503);}) as typeof fetch).discover(req), /UPSTREAM_UNAVAILABLE/); assert.equal(calls, 3);
});
test('timeouts are bounded and provider messages do not expose credentials', async () => {
  let calls=0; const p = make((async (_url, options) => { calls++; assert.ok(options?.signal); throw Error('fictional-test-key'); }) as typeof fetch);
  await assert.rejects(p.discover(req), error => error instanceof Error && error.message === 'NETWORK_OR_TIMEOUT'); assert.equal(calls, 3);
});
test('malformed provider payloads and excessive responses fail closed', async () => {
  await assert.rejects(make((async () => resp(200,{articles:'bad'})) as typeof fetch).discover(req), /MALFORMED_RESPONSE/);
  await assert.rejects(make((async () => new Response('{')) as typeof fetch).discover(req), /MALFORMED_RESPONSE/);
  await assert.rejects(make((async () => resp(200,{articles:[1,2,3,4]})) as typeof fetch).discover(req), /RESPONSE_LIMIT_EXCEEDED/);
  assert.throws(() => normalizeGNews({source:{name:'Fictional'}},'2026-01-02T00:00:00Z'));
});
test('normalization discards provider text and leaves unknown origins unresolved', () => {
  const result = normalizeGNews({url:'https://fiction.example.test/a',publishedAt:'2026-01-01T00:00:00Z',source:{name:'Fictional'},content:'PRIVATE TEXT', image:'https://fiction.example.test/image'}, '2026-01-02T00:00:00Z');
  assert.deepEqual(result.provenance, {type:'UNKNOWN', originId:null}); assert.doesNotMatch(JSON.stringify(result), /PRIVATE TEXT|image/);
});
test('fixture dry run is deterministic and does not write', async () => {
  const dir = await mkdtemp(join(tmpdir(),'dayline-ingest-')); try {
    const repo = new JsonRepository(join(dir,'fictional.json')); const newsroom = new Newsroom(repo, {clock});
    assert.deepEqual(await ingestArticles(repo,articles,context,settings), {processed:1, duplicate:1, rejected:0, quarantined:1, failed:0});
    assert.equal((await newsroom.snapshot()).audit.length, 0);
    await assert.rejects(ingestArticles(repo,articles,{...context,discoveryMetadata:true} as IngestionContext,settings), /caller policies/);
    await assert.rejects(ingestArticles(repo,articles,{...context,policyId:'fictional-expired-v1'},settings), /policy/);
    await assert.rejects(ingestArticles(repo,articles,context,{...settings,maxArticles:2}), /limit/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('write ingestion is idempotent, preserves syndication and audits outcomes', async () => {
  const dir = await mkdtemp(join(tmpdir(),'dayline-ingest-')); try {
    const repo = new JsonRepository(join(dir,'fictional.json')); const newsroom = new Newsroom(repo, {clock});
    const first = articles[0]; const copy: ProviderArticle = {...first,url:'https://fiction.example.test/copy',publisher:'Fictional Syndication',provenance:{type:'SYNDICATED',originId:sourceId(first.url)}};
    const input = [first, copy, articles[1], articles[2]];
    const copyResolution = {...resolutions[0], sourceId:sourceId(copy.url), classification:'SYNDICATED' as const, originId:sourceId(first.url)};
    const writeSettings = {...settings,dryRun:false,resolutions:[...resolutions,copyResolution]};
    assert.deepEqual(await ingestArticles(repo,input,context,writeSettings), {processed:2,duplicate:1,rejected:0,quarantined:1,failed:0});
    const state = await newsroom.snapshot(); assert.equal(state.sources.length,2); assert.equal(await newsroom.independentCount(state.sources.map(s=>s.id)),1);
    assert.equal(state.audit.filter(a=>a.action.startsWith('INGESTION_')).length,4);
    assert.equal(state.quarantine.length,1);
    assert.deepEqual(await ingestArticles(repo,input,context,writeSettings), {processed:0,duplicate:4,rejected:0,quarantined:0,failed:0});
    assert.equal(state.revisions.length,0);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('invalid timestamps, missing URLs and unknown syndication are rejected individually', async () => {
  const dir=await mkdtemp(join(tmpdir(),'dayline-ingest-')); try {
    const repo = new JsonRepository(join(dir,'fictional.json')); const newsroom = new Newsroom(repo, {clock});
    const unknownCopy = { ...resolutions[0], sourceId:sourceId('https://fiction.example.test/copy'), classification:'SYNDICATED' as const, originId:'missing' };
    const invalid = [{...articles[0],url:''},{...articles[0],publishedAt:'not a date'}, {...articles[0],url:'https://fiction.example.test/copy',provenance:{type:'SYNDICATED',originId:'missing'}}, articles[0]] as ProviderArticle[];
    assert.deepEqual(await ingestArticles(repo,invalid,context,{...settings,dryRun:false,resolutions:[...resolutions,unknownCopy]}), {processed:1,duplicate:0,rejected:3,quarantined:0,failed:0});
    assert.equal((await newsroom.snapshot()).sources.length,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('partial repository failures are counted and later items continue', async () => {
  const dir=await mkdtemp(join(tmpdir(),'dayline-ingest-')); try {
    let calls=0;
    const repo = new JsonRepository(join(dir,'fictional.json'), {beforeCommit:()=>{ if (++calls === 1) throw Error('internal storage failure'); }});
    const second = {...articles[0], url:'https://fiction.example.test/second'};
    const outcomes: string[] = [];
    const result = await ingestArticles(repo, [articles[0],second], context, {...settings,dryRun:false,resolutions:[...resolutions,{...resolutions[0],sourceId:sourceId(second.url)}],onOutcome:(i,o)=>outcomes.push(`${i}:${o}`)});
    assert.deepEqual(result,{processed:1,duplicate:0,rejected:0,quarantined:0,failed:1});
    assert.deepEqual(outcomes,['0:failed','1:processed']);
    const state = await repo.read();
    assert.equal(state.sources.length,1);
    assert.equal(state.audit.filter(a=>a.action==='INGESTION_PROCESSED').length,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
