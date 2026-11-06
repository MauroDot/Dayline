import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/newsroom/store.ts';
import type { State } from '../src/newsroom/model.ts';
import { SchedulerService } from '../src/scheduling/service.ts';
import { seedEditionFixture, editionAt } from '../fixtures/edition-fiction.ts';
const definition={name:'Fictional boundary',timezone:'UTC',localTime:'11:59',weekdays:[0,1,2,3,4,5,6],enabled:true};
async function fixture(run:(repository:JsonRepository)=>Promise<void>){const directory=await mkdtemp(join(tmpdir(),'dayline-scheduling-boundary-'));try{await run(new JsonRepository(join(directory,'fictional.json')));}finally{await rm(directory,{recursive:true,force:true});}}
class BoundaryRepository extends JsonRepository {
  private readonly boundary:()=>void;
  constructor(file:string,boundary:()=>void){super(file);this.boundary=boundary;}
  override async transact<T>(change:(state:State)=>T):Promise<T>{return super.transact(state=>{this.boundary();return change(state);});}
}

test('preparation rights are checked after acquiring a delayed repository lock',async()=>fixture(async repository=>{
  const {story}=await seedEditionFixture(repository);let now='2026-06-02T11:58:00.000Z';
  const service=new SchedulerService(repository,{clock:()=>now,leaseMs:300000});
  await service.create(definition);now='2026-06-02T11:59:00.000Z';const planned=(await service.evaluate({dryRun:false})).runs[0];
  const claimed=await service.claim(planned.id);await service.begin(planned.id,claimed.claimId!);const before=await repository.read();
  const delayed=new SchedulerService(new BoundaryRepository(repository.file,()=>{now='2026-06-02T12:00:00.000Z';}),{clock:()=>now,leaseMs:300000});
  const result=await delayed.prepare(planned.id,claimed.claimId!,[{storyId:story.id,storyVersion:story.version,section:'TOP_STORIES'}]);
  assert.equal(result.status,'NEEDS_ATTENTION');assert.equal(result.failure,'INELIGIBLE_CONTENT');const after=await repository.read();
  assert.deepEqual(after.editions,[]);assert.deepEqual(after.revisions,before.revisions);assert.deepEqual(after.approvals,before.approvals);
}));

test('an expired preparation lease cannot commit after waiting for the repository lock',async()=>fixture(async repository=>{
  let now='2026-06-01T11:58:00.000Z';const service=new SchedulerService(repository,{clock:()=>now,leaseMs:1000});
  await service.create(definition);now='2026-06-01T11:59:00.000Z';const planned=(await service.evaluate({dryRun:false})).runs[0];
  const claimed=await service.claim(planned.id);await service.begin(planned.id,claimed.claimId!);
  const delayed=new SchedulerService(new BoundaryRepository(repository.file,()=>{now='2026-06-01T11:59:01.000Z';}),{clock:()=>now,leaseMs:1000});
  await assert.rejects(delayed.prepare(planned.id,claimed.claimId!),/CLAIM_EXPIRED/);
  const after=await repository.read();assert.deepEqual(after.editions,[]);assert.equal(after.preparationRuns[0].status,'PREPARING');
}));

test('scheduler storage and malformed-file errors cannot expose raw private details',async()=>fixture(async repository=>{
  const service=new SchedulerService(repository,{clock:()=>editionAt});await service.create(definition);const bytes=await readFile(repository.file,'utf8');
  const failing=new SchedulerService(new JsonRepository(repository.file,{beforeCommit:()=>{throw Error('PRIVATE_STORAGE_PATH_AND_CREDENTIAL');}}),{clock:()=>editionAt});
  await assert.rejects(failing.create({...definition,name:'Another fixture'}),error=>error instanceof Error&&error.message==='SCHEDULER_STORAGE_UNAVAILABLE');
  assert.equal(await readFile(repository.file,'utf8'),bytes);
  await writeFile(repository.file,'PRIVATE_MALFORMED_PAYLOAD');
  await assert.rejects(service.evaluate(),error=>error instanceof Error&&error.message==='SCHEDULER_STORAGE_UNAVAILABLE');
  assert.equal(await readFile(repository.file,'utf8'),'PRIVATE_MALFORMED_PAYLOAD');
}));

test('injected clock failures are sanitized before any scheduling mutation',async()=>fixture(async repository=>{
  const service=new SchedulerService(repository,{clock:()=>{throw Error('PRIVATE_CLOCK_DETAIL');}});
  await assert.rejects(service.create(definition),error=>error instanceof Error&&error.message==='INVALID_CLOCK');
  assert.deepEqual((await repository.read()).schedules,[]);
}));
