import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPublicServer, type PublicServerOptions, type SafePublicEvent } from '../src/public/reader.ts';
import { parsePublicConfiguration } from '../src/public/config.ts';
const config = () => parsePublicConfiguration({NODE_ENV:'staging', NWS_USER_AGENT:'Dayline test (test@dayline.invalid)'});
const debtValue = {data:[{record_date:'2026-11-03',tot_pub_debt_out_amt:'3.00',debt_held_public_amt:'2.00',intragov_hold_amt:'1.00'}]};
const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = String(input);
  if (url.includes('fiscaldata')) return Response.json(debtValue);
  if (url.includes('/points/')) return Response.json({properties:{forecast:'https://api.weather.gov/gridpoints/TSA/1,1/forecast'}});
  return Response.json({properties:{updated:'2026-11-03T12:00:00Z',periods:[{name:'Today',detailedForecast:'Fictional test forecast',temperature:72,temperatureUnit:'F',windSpeed:'5 mph'}]}});
}) as typeof fetch;
async function fixture(run: (origin: string) => Promise<void>, options: Partial<PublicServerOptions> = {}) {
  const server = createPublicServer({config:config(), fetcher:fakeFetch,...options});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address(); if(!address||typeof address==='string')throw Error('No address');
  try {await run(`http://127.0.0.1:${address.port}`);} finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
async function ready(origin:string) { const response=await fetch(origin+'/api/ready');return {status:response.status,body:await response.json()}; }
async function populate(origin:string) {assert.equal((await fetch(origin+'/api/debt')).status,200);assert.equal((await fetch(origin+'/api/weather?city=Tulsa')).status,200);}

test('public health does not assert upstream readiness and probes trigger no official requests',async()=>{
 let calls=0;await fixture(async origin=>{
  const health=await fetch(origin+'/api/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
  const state=await ready(origin);assert.equal(state.status,503);assert.equal(state.body.ready,false);assert.deepEqual(state.body.checks,{assets:true,treasury:'unknown',nws:'unknown'});
  assert.equal(calls,0);
 },{fetcher:async()=>{calls++;throw Error('Unexpected upstream');}});
});

test('readiness becomes ready only from real adapter successes and preserves official timestamps',async()=>fixture(async origin=>{
 const debt=await fetch(origin+'/api/debt');const body=await debt.json();assert.equal(body.source,'U.S. Treasury Fiscal Data');assert.equal(body.data.asOf,'2026-11-03');assert.equal(body.data.total,'3.00');assert.ok(body.data.fetchedAt);assert.equal(body.stale,false);
 assert.equal((await ready(origin)).status,503);
 const weather=await fetch(origin+'/api/weather?city=Tulsa');const forecast=await weather.json();assert.equal(forecast.source,'National Weather Service');assert.equal(forecast.data.sourceUpdatedAt,'2026-11-03T12:00:00Z');
 const state=await ready(origin);assert.equal(state.status,200);assert.equal(state.body.ready,true);assert.equal(state.body.semantics,'observed-official-data');
}));

test('readiness expires observed data without causing expensive refresh probes',async()=>{
 let now=100000,calls=0;await fixture(async origin=>{
  await populate(origin);assert.equal((await ready(origin)).status,200);const loaded=calls;
  now+=30*60*1000;assert.equal((await ready(origin)).status,503);assert.equal(calls,loaded);
  assert.equal((await fetch(origin+'/api/weather?city=Tulsa')).status,200);assert.equal((await ready(origin)).status,200);
  now+=60*60*1000;assert.equal((await ready(origin)).status,503);
 },{now:()=>now,fetcher:(async(...args:Parameters<typeof fetch>)=>{calls++;return fakeFetch(...args);}) as typeof fetch});
});

test('a failed observed weather location cannot be hidden by another successful city',async()=>{
 let failChicago=false;await fixture(async origin=>{
  await populate(origin);assert.equal((await ready(origin)).status,200);failChicago=true;
  assert.equal((await fetch(origin+'/api/weather?city=Chicago')).status,503);assert.equal((await ready(origin)).status,503);
  assert.equal((await fetch(origin+'/api/weather?city=Tulsa')).status,200);assert.equal((await ready(origin)).status,503);
  failChicago=false;assert.equal((await fetch(origin+'/api/weather?city=Chicago')).status,200);assert.equal((await ready(origin)).status,200);
 },{fetcher:(async(input,...rest)=>String(input).includes('41.878')&&failChicago?new Response('{}',{status:400}):fakeFetch(input,...rest)) as typeof fetch});
});

test('stale successful cache responses preserve data but fail deployment readiness',async()=>{
 let now=100000,fail=false;await fixture(async origin=>{
  await populate(origin);assert.equal((await ready(origin)).status,200);now+=3600001;fail=true;
  const response=await fetch(origin+'/api/debt');const body=await response.json();assert.equal(response.status,200);assert.equal(body.stale,true);assert.equal(body.data.total,'3.00');assert.equal((await ready(origin)).status,503);
  now+=86400000;const expired=await fetch(origin+'/api/debt');assert.equal(expired.status,503);assert.equal((await expired.json()).data,undefined);
 },{now:()=>now,fetcher:(async(...args:Parameters<typeof fetch>)=>fail?new Response('{}',{status:400}):fakeFetch(...args)) as typeof fetch});
});

test('upstream failures return unavailable states without fabricated figures or provider errors',async()=>{
 const logs:SafePublicEvent[]=[];await fixture(async origin=>{
  for(const path of ['/api/debt','/api/weather?city=Tulsa']){const response=await fetch(origin+path);assert.equal(response.status,503);const text=await response.text();assert.equal(text.includes('PRIVATE_PROVIDER_TOKEN'),false);assert.equal(JSON.parse(text).data,undefined);}
  assert.equal((await ready(origin)).status,503);assert.equal((await fetch(origin+'/api/health')).status,200);
  assert.equal(JSON.stringify(logs).includes('PRIVATE_PROVIDER_TOKEN'),false);assert.ok(logs.some(row=>row.event==='upstream_failure'));
 },{fetcher:async()=>{throw Error('PRIVATE_PROVIDER_TOKEN');},config:{...config(),upstreamTimeoutMs:100},log:event=>logs.push(event)});
});

test('all public JSON and static responses carry safe headers without reflecting credentials',async()=>fixture(async origin=>{
 for(const path of ['/','/style.css','/api/health','/api/ready','/missing']){
  const response=await fetch(origin+path,{headers:{authorization:'Bearer PRIVATE_HEADER', 'x-request-id':'PRIVATE_HEADER'}});
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');assert.match(response.headers.get('content-security-policy')??'',/frame-ancestors 'none'/);
  assert.match(response.headers.get('x-request-id')??'',/^[0-9a-f-]{36}$/);assert.equal((await response.text()).includes('PRIVATE_HEADER'),false);assert.equal([...response.headers.values()].join().includes('PRIVATE_HEADER'),false);
 }
}));

test('content types cache policies HEAD and Allow headers are correct',async()=>fixture(async origin=>{
 for(const [path,type] of [['/','text/html'],['/style.css','text/css'],['/app.js','text/javascript'],['/stories.js','text/javascript']]){const response=await fetch(origin+path);assert.equal(response.status,200);assert.match(response.headers.get('content-type')??'',new RegExp('^'+type));assert.equal(response.headers.get('cache-control'),'no-cache, max-age=0');}
 for(const path of ['/api/health','/api/ready','/api/unknown']){const response=await fetch(origin+path,{method:'HEAD'});assert.equal(await response.text(),'');assert.equal(response.headers.get('cache-control'),'no-store');}
 const method=await fetch(origin+'/api/debt',{method:'POST'});assert.equal(method.status,405);assert.equal(method.headers.get('allow'),'GET, HEAD');
}));

test('staging public reader cannot expose development private identity or local database routes',async()=>fixture(async origin=>{
 for(const path of ['/dev/edition','/dev/edition/preview','/dev/edition/edition.js','/internal/principal','/internal/stories','/api/auth/login','/api/admin','/api/schedules','/server.ts','/.env','/.git/config','/src/security/http.ts','/fixtures/security-fiction.ts','/newsroom.json','/build/manifest.json']){
  assert.equal((await fetch(origin+path)).status,404,path);assert.equal((await fetch(origin+path,{method:'POST'})).status,405,path);
 }
}));

test('development hook cannot activate in a staging or production reader',async()=>{
 for(const mode of ['staging','production'] as const){let invoked=false;await fixture(async origin=>{assert.equal((await fetch(origin+'/dev/edition')).status,404);assert.equal(invoked,false);},{config:{...config(),mode},developmentHandler:async()=>{invoked=true;return true;}});}
});

test('unsupported locations cannot expand cache state or invoke an upstream request',async()=>{
 let calls=0;await fixture(async origin=>{for(const city of ['constructor','__proto__','unknown'])assert.equal((await fetch(origin+'/api/weather?city='+city)).status,400);assert.equal(calls,0);assert.equal((await ready(origin)).body.checks.nws,'unknown');},{fetcher:async()=>{calls++;throw Error();}});
});

test('missing configured NWS identification does not fall back to ambient process credentials',async()=>{
 const previous=process.env.NWS_USER_AGENT;process.env.NWS_USER_AGENT='Dayline test (test@dayline.invalid)';
 try {let calls=0;await fixture(async origin=>{const response=await fetch(origin+'/api/weather');assert.equal(response.status,503);assert.match((await response.json()).error,/NWS_USER_AGENT/);assert.equal(calls,0);},{config:{...config(),nwsUserAgent:undefined},fetcher:async()=>{calls++;throw Error();}});}finally{if(previous===undefined)delete process.env.NWS_USER_AGENT;else process.env.NWS_USER_AGENT=previous;}
});

test('a fixed set of cached endpoints coalesces concurrent official loads',async()=>{
 let calls=0;await fixture(async origin=>{const results=await Promise.all(Array.from({length:8},()=>fetch(origin+'/api/debt')));assert.ok(results.every(response=>response.status===200));assert.equal(calls,1);},{fetcher:(async(...args:Parameters<typeof fetch>)=>{calls++;await new Promise(resolve=>setTimeout(resolve,20));return fakeFetch(...args);}) as typeof fetch});
});

test('concurrency exhaustion rejects excess work without a second upstream request',async()=>{
 let entered!:()=>void,release!:()=>void,calls=0;const started=new Promise<void>(resolve=>entered=resolve);const wait=new Promise<void>(resolve=>release=resolve);
 await fixture(async origin=>{const first=fetch(origin+'/api/debt');await started;assert.equal((await fetch(origin+'/api/health')).status,200);const excess=await fetch(origin+'/api/debt');assert.equal(excess.status,503);assert.equal((await ready(origin)).status,503);assert.equal(excess.headers.get('retry-after'),'1');assert.equal(calls,1);release();assert.equal((await first).status,200);},{config:{...config(),maxConcurrentRequests:1},fetcher:(async(...args:Parameters<typeof fetch>)=>{calls++;entered();await wait;return fakeFetch(...args);}) as typeof fetch});
});

test('request response deadline is bounded without leaked source errors or false readiness',async()=>{
 await fixture(async origin=>{const start=Date.now();const response=await fetch(origin+'/api/debt');assert.equal(response.status,503);assert.ok(Date.now()-start<1000);assert.equal((await ready(origin)).status,503);},{config:{...config(),requestTimeoutMs:50,headersTimeoutMs:50,upstreamTimeoutMs:100},fetcher:async()=>new Promise<Response>(()=>{})});
});

test('missing or symlinked static assets fail safely and make application readiness fail',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dayline-static-'));
 try {await writeFile(join(directory,'private.txt'),'PRIVATE_FILESYSTEM_TOKEN');await symlink(join(directory,'private.txt'),join(directory,'app.js'));
  await fixture(async origin=>{const response=await fetch(origin+'/app.js');assert.equal(response.status,500);const body=await response.text();assert.equal(body.includes(directory),false);assert.equal(body.includes('PRIVATE_FILESYSTEM_TOKEN'),false);assert.equal((await ready(origin)).body.checks.assets,false);assert.equal((await fetch(origin+'/api/health')).status,200);},{staticRoot:directory});
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a malformed encoded static path never reaches filesystem data',async()=>fixture(async origin=>{
 const port=Number(new URL(origin).port);
 const status=await new Promise<number>((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path:'/%2e%2e/.env'},response=>{response.resume();response.once('end',()=>resolve(response.statusCode!));});req.once('error',reject);req.end();});
 assert.equal(status,404);
}));


test('a late successful upstream load cannot erase a timed-out response until a new successful request',async()=>{
 let now=100000,delay=false,release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);
 await fixture(async origin=>{
  await populate(origin);assert.equal((await ready(origin)).status,200);now+=3600001;delay=true;
  const response=await fetch(origin+'/api/debt');assert.equal(response.status,503);release();await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal((await ready(origin)).status,503);
  assert.equal((await fetch(origin+'/api/debt')).status,200);
  assert.equal((await fetch(origin+'/api/weather?city=Tulsa')).status,200);assert.equal((await ready(origin)).status,200);
 },{now:()=>now,config:{...config(),requestTimeoutMs:50,headersTimeoutMs:50,upstreamTimeoutMs:100},fetcher:(async(...args:Parameters<typeof fetch>)=>{if(delay&&String(args[0]).includes('fiscaldata'))await wait;return fakeFetch(...args);}) as typeof fetch});
});
