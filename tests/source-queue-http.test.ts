import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.ts';
import { parsePublicConfiguration } from '../src/public/config.ts';
import { createFictionalSourceQueueDisplaySource, sanitizeSourceQueueDisplay } from '../src/source-queue/presentation.ts';
import type { SourceQueueDisplay, SourceQueueDisplaySource } from '../src/source-queue/presentation-types.ts';
import { sourceQueueViews } from '../src/source-queue/types.ts';

const gate = { NODE_ENV: 'development', DAYLINE_DEV_SOURCE_QUEUE: 'fictional' };
const paths = ['/dev/source-queue', '/dev/source-queue/source-queue.css', '/dev/source-queue/source-queue.js', '/dev/source-queue/preview'];
async function environment(values: Record<string,string|undefined>, run: () => Promise<void>) {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key,value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { await run(); } finally { for (const [key,value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
async function withServer(options: Parameters<typeof createServer>[0], run: (request: (path: string, options?: {headers?:Record<string,string>;method?:string}) => Promise<Response>, port: number) => Promise<void>) {
  const server = createServer({...options, fetcher: async () => { throw Error('NETWORK_FORBIDDEN'); }});
  await new Promise<void>((resolve,reject) => { server.once('error', reject); server.listen(0,'127.0.0.1',resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing controlled listener');
  const request = (path: string, options: {headers?:Record<string,string>;method?:string} = {}) => new Promise<Response>((resolve,reject) => {
    const outgoing = http.request({hostname:'127.0.0.1',port:address.port,path,method:options.method ?? 'GET',headers:{host:`127.0.0.1:${address.port}`,...options.headers}}, incoming => {
      const chunks:Buffer[] = []; incoming.on('data',chunk => chunks.push(Buffer.from(chunk))); incoming.once('error',reject);
      incoming.once('end',() => resolve(new Response(options.method === 'HEAD' ? null : Buffer.concat(chunks),{status:incoming.statusCode,headers:incoming.headers as Record<string,string>})));
    });
    outgoing.once('error',reject); outgoing.setTimeout(3000,() => outgoing.destroy(Error('Controlled request timeout'))); outgoing.end();
  });
  try { await run(request,address.port); } finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
}
async function display(): Promise<SourceQueueDisplay> {
  const source = createFictionalSourceQueueDisplaySource();
  try { const value = await source.read({view:'RECENT',limit:6}); assert.ok(value); return value; } finally { await source.dispose(); }
}
function source(read: SourceQueueDisplaySource['read']): SourceQueueDisplaySource { return {read,async dispose(){}}; }

test('queue is opt-in development only and absent in staging production and unknown routes', async () => {
  for (const values of [{NODE_ENV:'development',DAYLINE_DEV_SOURCE_QUEUE:undefined},{NODE_ENV:'test',DAYLINE_DEV_SOURCE_QUEUE:'fictional'},{NODE_ENV:'production',DAYLINE_DEV_SOURCE_QUEUE:'fictional'},{NODE_ENV:'staging',DAYLINE_DEV_SOURCE_QUEUE:'fictional'}]) {
    await environment(values,async () => withServer({},async request => { for (const path of paths) assert.equal((await request(path)).status,404); }));
  }
  await environment(gate,async () => {
    for (const mode of ['staging','production'] as const) await withServer({config:{...parsePublicConfiguration({NODE_ENV:'development'}),mode}},async request => {
      for (const path of paths) assert.equal((await request(path)).status,404);
    });
    await withServer({},async request => { for (const path of ['/source-queue.html','/source-queue.js','/source-queue.css','/api/source-queue','/internal/source-queue','/dev/source-queue/private']) assert.equal((await request(path)).status,404); });
  });
});

test('gated assets and fresh fictional DTO have safe headers and cannot approve or publish', async () => {
  await environment(gate,async () => withServer({},async request => {
    for (const path of paths) {
      const response = await request(path); assert.equal(response.status,200,path);
      assert.equal(response.headers.get('cache-control'),'no-store'); assert.equal(response.headers.get('referrer-policy'),'no-referrer');
      assert.equal(response.headers.get('x-content-type-options'),'nosniff');
      assert.match(response.headers.get('content-security-policy') ?? '',/frame-ancestors 'none'/);
      assert.doesNotMatch(response.headers.get('content-security-policy') ?? '',/unsafe-inline|unsafe-eval/);
      const head = await request(path,{method:'HEAD'}); assert.equal(head.status,200); assert.equal(await head.text(),'');
    }
    const value = await (await request('/dev/source-queue/preview')).json() as SourceQueueDisplay;
    assert.equal(value.fictional,true); assert.equal(value.developmentOnly,true); assert.equal(value.publiclyPublished,false);
    assert.equal(value.asOf,'2026-06-01T12:00:00.000Z'); assert.equal(value.limit,6); assert.ok(value.entries.length > 0);
    assert.ok(value.entries.every(row => row.canAdvance === false));
    assert.ok(value.entries.some(row => row.quarantineStatus === 'QUARANTINED'));
    assert.ok(value.entries.some(row => row.quarantineStatus === 'NOT_QUARANTINED'));
    assert.ok(value.entries.some(row => row.quarantineStatus === 'WITHHELD'));
    assert.doesNotMatch(JSON.stringify(value),/actorAssertion|evidenceReference|apiKey|snapshotDigest|audit|licensedText|providerMetadata/);
    assert.equal((await request('/dev/source-queue/preview',{method:'POST'})).status,405);
    assert.equal((await request('/dev/source-queue/approve')).status,404);
  }));
});

test('queue rejects foreign origins authority tricks forwarding cookies and bearer credentials', async () => {
  await environment(gate,async () => withServer({},async (request,port) => {
    const invalidHeaders: Record<string,string>[] = [{host:'reader.example.test'},{host:`localhost:${port+1}`},{host:`user@localhost:${port}`},{host:`127.0.0.1:${port}/`},
      {origin:'https://foreign.test'},{origin:'null'},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'},
      {forwarded:'host=localhost'},{'x-forwarded-host':'localhost'},{cookie:'session=private'},{authorization:'Bearer private'},{'access-control-request-method':'GET'}];
    for (const headers of invalidHeaders) {
      assert.equal((await request('/dev/source-queue/preview',{headers})).status,404,JSON.stringify(headers));
    }
    assert.equal((await request('/dev/source-queue/preview',{headers:{host:`localhost:${port}`,origin:`http://localhost:${port}`,'sec-fetch-site':'same-origin'}})).status,200);
  }));
});

test('HTTP query supports stable bounded filters and cursor pages while rejecting invalid inputs', async () => {
  await environment(gate,async () => withServer({},async request => {
    for (const view of sourceQueueViews) {
      const response = await request('/dev/source-queue/preview?view='+view+'&limit=3'); assert.equal(response.status,200,view);
      const page = await response.json() as SourceQueueDisplay; assert.equal(page.view,view); assert.ok(page.entries.length <= 3);
    }
    const first = await (await request('/dev/source-queue/preview?view=RECENT&limit=3')).json() as SourceQueueDisplay;
    assert.ok(first.nextCursor);
    const second = await (await request('/dev/source-queue/preview?view=RECENT&limit=3&cursor='+first.nextCursor)).json() as SourceQueueDisplay;
    assert.ok(second.entries.every(row => !first.entries.some(previous => previous.candidateRef === row.candidateRef)));
    for (const query of ['view=PUBLIC','limit=0','limit=51','limit=-1','limit=1.5','limit=03','view=RECENT&view=ELIGIBLE','repository=/private','cursor=','cursor=%2Fprivate','cursor='+'a'.repeat(1025)]) assert.equal((await request('/dev/source-queue/preview?'+query)).status,400,query.slice(0,80));
    assert.equal((await request('/dev/source-queue?view=RECENT')).status,404);
  }));
});

test('DTO projection drops private fields recursively without executing getters or array accessors', async () => {
  const value = await display(); const privateData = {privateNotes:'PRIVATE_NOTE',apiKey:'PRIVATE_KEY',audit:['PRIVATE_AUDIT']};
  const dirty = {...value,...privateData,entries:value.entries.map(row => ({...row,...privateData,relationship:row.relationship ? {...row.relationship,...privateData} : null}))};
  assert.deepEqual(sanitizeSourceQueueDisplay(dirty),value); assert.doesNotMatch(JSON.stringify(sanitizeSourceQueueDisplay(dirty)),/PRIVATE_/);
  let calls = 0;
  const getter = {...value}; Object.defineProperty(getter,'entries',{enumerable:true,get(){calls++;return value.entries;}});
  assert.equal(sanitizeSourceQueueDisplay(getter),null); assert.equal(calls,0);
  const array = structuredClone(value); Object.defineProperty(array.entries,'0',{get(){calls++;return value.entries[0];},enumerable:true});
  assert.equal(sanitizeSourceQueueDisplay(array),null); assert.equal(calls,0);
});

test('DTO boundary rejects unsafe URLs invented status enums inconsistent authority and invalid leases', async () => {
  const value = await display();
  for (const change of [{fictional:false},{developmentOnly:false},{publiclyPublished:true},{asOf:'2026-11-13T00:00:00.000Z'},
    ...[0,-1,15001,NaN,Infinity,1.5].map(validForMs => ({validForMs}))]) assert.equal(sanitizeSourceQueueDisplay({...value,...change}),null);
  for (const changes of [{rightsStatus:'LICENSED'},{provenance:'TRUSTED'},{retentionStatus:'PUBLISHED'},{quarantineStatus:'RELEASED'},{canAdvance:true},{candidateRef:'private-id'},
    {publishedAt:'2026-02-30T12:00:00.000Z'},...['javascript:alert(1)','https://news.example.com/article','https://user:private@fixture.test/a','https://fixture.test/a?token=private','http://fixture.test/a'].map(canonicalUrl => ({canonicalUrl}))]) {
    const bad = structuredClone(value); Object.assign(bad.entries[0],changes); assert.equal(sanitizeSourceQueueDisplay(bad),null,JSON.stringify(changes));
  }
});

test('HTTP sanitization rejects unavailable malformed and private source failures with fixed messages', async () => {
  await environment(gate,async () => {
    const value = await display();
    for (const read of [async () => null, async () => {throw Error('/private/token=PRIVATE');},async () => ({...value,publiclyPublished:true} as unknown as SourceQueueDisplay)]) {
      await withServer({sourceQueueSource:source(read)},async request => {
        const response = await request('/dev/source-queue/preview'); assert.equal(response.status,503);
        assert.equal(await response.text(),JSON.stringify({error:'Fictional source queue currently unavailable'}));
      });
    }
  });
});

test('withheld rights and malformed markers cannot restore metadata through display injection', async () => {
  const value = await display(); const eligible = value.entries.find(row => row.sourceEligible); assert.ok(eligible);
  const altered: SourceQueueDisplay[] = [];
  for (const rightsStatus of ['EXPIRED','REVOKED','SUPERSEDED','MISSING','UNKNOWN'] as const) {
    const bad = {...structuredClone(value),entries:[{...eligible,sourceEligible:false,rightsStatus,blockedReason:'UNKNOWN_RIGHTS' as const}]};
    altered.push(bad);
  }
  for (const blockedReason of ['MALFORMED_RECORD','MISSING_RIGHTS','SOURCE_REMOVED'] as const) altered.push({...structuredClone(value),entries:[{...eligible,sourceEligible:false,blockedReason}]});
  for (const provenance of ['UNKNOWN','DISPUTED'] as const) altered.push({...structuredClone(value),entries:[{...eligible,provenance}]});
  for (const quarantineStatus of ['QUARANTINED','WITHHELD'] as const) altered.push({...structuredClone(value),entries:[{...eligible,quarantineStatus}]});
  const withheld = value.entries.find(row => row.quarantineStatus === 'WITHHELD'); assert.ok(withheld);
  altered.push({...structuredClone(value),entries:[{...withheld,quarantineStatus:'NOT_QUARANTINED'}]});
  const partial = {...structuredClone(value),entries:[{...eligible,publisher:null}]}; altered.push(partial);
  for (const bad of altered) {
    assert.equal(sanitizeSourceQueueDisplay(bad),null);
    await environment(gate,async () => withServer({sourceQueueSource:source(async () => bad)},async request => {
      const response = await request('/dev/source-queue/preview'); assert.equal(response.status,503); assert.doesNotMatch(await response.text(),/source-queue\.example\.test|candidate-/);
    }));
  }
});

test('fictional source is lazy and disposal during initialization removes all temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(),'dayline-queue-display-close-')); const old = process.env.TMPDIR; process.env.TMPDIR = directory;
  try {
    const unused = createFictionalSourceQueueDisplaySource(); await unused.dispose(); assert.equal(await unused.read(),null); assert.deepEqual(await readdir(directory),[]);
    const active = createFictionalSourceQueueDisplaySource(); const pending = active.read(); await active.dispose(); assert.equal(await pending,null); assert.equal(await active.read(),null); assert.deepEqual(await readdir(directory),[]);
  } finally { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old; await rm(directory,{recursive:true,force:true}); }
});
