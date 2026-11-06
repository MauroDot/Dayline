import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFictionalDisplaySource, sanitizeEditionDisplay } from '../src/editions/presentation.ts';
import { editionAt } from '../fixtures/edition-fiction.ts';
import type { EditionDisplay } from '../src/editions/presentation-types.ts';

async function display():Promise<EditionDisplay> {
  const source=createFictionalDisplaySource({clock:()=>editionAt});
  try { const value=await source.read(); assert.ok(value); return value; }
  finally { await source.dispose(); }
}

test('reader DTO recursively omits reviewer assertions audit policies and internal linkage',async()=>{
  const value=await display(); const privateFields={actorAssertion:'PRIVATE_ASSERTION',audit:['PRIVATE_AUDIT'],sourceId:'PRIVATE_SOURCE',snapshotDigest:'PRIVATE_POLICY'};
  const contaminated={...value,...privateFields,sections:value.sections.map(s=>({...s,...privateFields,placements:s.placements.map(p=>({...p,...privateFields,sources:p.sources.map(a=>({...a,...privateFields})),counterevidence:{...p.counterevidence,...privateFields,sources:p.counterevidence.sources.map(a=>({...a,...privateFields}))}}))}))};
  const safe=sanitizeEditionDisplay(contaminated); assert.deepEqual(safe,value); assert.doesNotMatch(JSON.stringify(safe),/PRIVATE_/);
});

test('reader boundary rejects stale leases invalid states and non-fictional authority labels',async()=>{
  const value=await display();
  for(const changes of [{fictional:false},{developmentOnly:false},{publiclyPublished:true},{status:'INVALIDATED'},{status:'PUBLISHED'},
    ...[0,-1,15001,1.5,NaN,Infinity].map(validForMs=>({validForMs})),{date:'2026-02-30'},{timezone:'Invalid/Zone'}]) {
    assert.equal(sanitizeEditionDisplay({...value,...changes}),null,JSON.stringify(changes));
  }
});

test('reader boundary permits only safe fictional attribution and bounded canonical sections',async()=>{
  const value=await display();
  for(const url of ['javascript:alert(1)','data:text/html,unsafe','file:///private','https://news.example.com/article','https://fixture.test.evil.com/article','https://user:secret@fixture.test/article','https://fixture.test/?token=secret','http://fixture.test/article']){
    const altered=structuredClone(value); altered.sections[0].placements[0].sources[0].url=url;
    assert.equal(sanitizeEditionDisplay(altered),null,url);
  }
  assert.equal(sanitizeEditionDisplay({...value,sections:[...value.sections].reverse()}),null);
  const oversized=structuredClone(value); oversized.sections[0].placements[0].headline='x'.repeat(513); assert.equal(sanitizeEditionDisplay(oversized),null);
  const inconsistent=structuredClone(value); inconsistent.sections[0].placements[0].counterevidence.recorded=false; assert.equal(sanitizeEditionDisplay(inconsistent),null);
});

test('reader boundary never executes getter-based data while validating an untrusted result',async()=>{
  const value=await display(); let calls=0;
  const accessor={...value}; Object.defineProperty(accessor,'sections',{enumerable:true,get(){calls++;throw Error('PRIVATE_GETTER');}});
  assert.equal(sanitizeEditionDisplay(accessor),null); assert.equal(calls,0);
});

test('display fixture is lazy and a disposed source cannot bootstrap or serve any content',async()=>{
  let clockCalls=0; const source=createFictionalDisplaySource({clock:()=>{clockCalls++;return editionAt;}});
  assert.equal(clockCalls,0); await source.dispose(); assert.equal(await source.read(),null); assert.equal(clockCalls,0);
});

test('closing during lazy initialization cleans all temporary fixture files and prevents subsequent reads',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'dayline-display-close-test-')); const old=process.env.TMPDIR;
  process.env.TMPDIR=directory;
  try {
    const source=createFictionalDisplaySource({clock:()=>editionAt});
    const pending=source.read(); const closing=source.dispose();
    assert.equal(await pending,null); await closing; assert.equal(await source.read(),null);
    assert.deepEqual(await readdir(directory),[]);
  } finally {
    if(old===undefined)delete process.env.TMPDIR; else process.env.TMPDIR=old;
    await rm(directory,{recursive:true,force:true});
  }
});

test('runtime edition date follows America/Chicago rather than the host UTC calendar',async()=>{
  const source=createFictionalDisplaySource({clock:()=> '2026-06-01T00:30:00.000Z'});
  try { const value=await source.read(); assert.ok(value); assert.equal(value.timezone,'America/Chicago'); assert.equal(value.date,'2026-05-31'); }
  finally { await source.dispose(); }
});

test('reader DTO refuses array accessors prototypes and custom mapping without executing them',async()=>{
  const value=await display(); let executions=0;
  const accessor=structuredClone(value); Object.defineProperty(accessor.sections,'0',{enumerable:true,configurable:true,get(){executions++;return value.sections[0];}});
  assert.equal(sanitizeEditionDisplay(accessor),null); assert.equal(executions,0);
  const custom=structuredClone(value); Object.defineProperty(custom.sections,'map',{value(){executions++;return [{privateAudit:'PRIVATE_MAPPING'}];}});
  assert.equal(sanitizeEditionDisplay(custom),null); assert.equal(executions,0);
  const inherited=structuredClone(value); Object.setPrototypeOf(inherited.sections,Object.create(Array.prototype)); assert.equal(sanitizeEditionDisplay(inherited),null);
  const nested=structuredClone(value); Object.defineProperty(nested.sections[0].placements[0].sources,'0',{enumerable:true,configurable:true,get(){executions++;return value.sections[0].placements[0].sources[0];}});
  assert.equal(sanitizeEditionDisplay(nested),null); assert.equal(executions,0);
});
