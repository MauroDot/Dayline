import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/newsroom/store.ts';
import type { State } from '../src/newsroom/model.ts';
import { EditionService } from '../src/editions/service.ts';
import { sectionIds, type EditionStatus, type PlacementInput } from '../src/editions/types.ts';
import { seedEditionFixture, editionAt } from '../fixtures/edition-fiction.ts';
import { seedEditorialFixture } from '../fixtures/editorial-fiction.ts';
import { EditorialService } from '../src/editorial/service.ts';

const actor = 'fictional-edition-reviewer';
const clock = () => editionAt;
async function fixture(run: (repo: JsonRepository, service: EditionService) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-edition-service-'));
  try { const repo = new JsonRepository(join(directory,'fictional.json')); await run(repo, new EditionService(repo,{clock})); }
  finally { await rm(directory,{recursive:true,force:true}); }
}
const input = (story: {id:string;version:number}, section: PlacementInput['section'] = 'TOP_STORIES'): PlacementInput => ({storyId:story.id,storyVersion:story.version,section});
const scope = {date:'2026-06-01',timezone:'America/Chicago'};

test('edition creation captures exact approved revision and preserves all newsroom records', async () => fixture(async (repo,service) => {
  const {story} = await seedEditionFixture(repo); const before = await repo.read();
  const edition = await service.create({...scope,placements:[{...input(story),featured:true}]},actor);
  assert.equal(edition.status,'ASSEMBLING'); assert.equal(edition.revision,1);
  assert.deepEqual(edition.sections.map(s=>s.id),sectionIds);
  const placement=edition.sections[0].placements[0]; assert.equal(placement.storyVersion,story.version); assert.equal(placement.headline,story.headline);
  assert.equal(placement.summary,story.summary); assert.equal(placement.sources.length,2);
  assert.deepEqual(placement.evidence.map(e=>e.uncertainty),story.evidence.map(e=>e.uncertainty));
  const after=await repo.read(); assert.deepEqual(after.revisions,before.revisions); assert.deepEqual(after.approvals,before.approvals); assert.deepEqual(after.sources,before.sources);
  assert.ok(after.audit.some(a=>a.action==='EDITION_CREATED'));
}));

test('empty edition has every empty section and cannot enter readiness', async () => fixture(async (_repo,service) => {
  const e=await service.create({...scope,placements:[]},actor);
  assert.ok(e.sections.every(s=>s.placements.length===0));
  await assert.rejects(service.review(e.id,1,'NEEDS_REVIEW',actor),/READINESS_BLOCKED/);
}));

test('assembly preserves manual placement order within canonical section order', async () => fixture(async (repo,service) => {
  const {story,newsroom}=await seedEditionFixture(repo);
  const {status:_status,version:_version,...fields}=story;
  const otherId='second-fictional-edition-story';
  await newsroom.create({...fields,id:otherId},actor);
  for(const status of ['CLUSTERED','DRAFT','NEEDS_REVIEW','APPROVED'] as const) await newsroom.transition(otherId,status,actor);
  const other=(await repo.read()).revisions.filter(s=>s.id===otherId).at(-1)!;
  const e=await service.create({...scope,placements:[input(other,'SCIENCE'),input(story,'SCIENCE')]},actor);
  assert.deepEqual(e.sections.find(s=>s.id==='SCIENCE')!.placements.map(p=>p.storyId),[other.id,story.id]);
  assert.equal(e.sections[0].placements.length,0);
}));

test('duplicate stories across sections are denied without partial edition or success audit', async () => fixture(async(repo,service)=>{
  const {story}=await seedEditionFixture(repo);
  await assert.rejects(service.create({...scope,placements:[input(story),input(story,'WORLD')]},actor),/DUPLICATE_STORY/);
  const s=await repo.read(); assert.deepEqual(s.editions,[]); assert.equal(s.audit.some(a=>a.action==='EDITION_CREATED'),false);
}));

test('feature must be a single top story and unknown section is rejected', async()=>fixture(async(repo,service)=>{
  const {story}=await seedEditionFixture(repo);
  await assert.rejects(service.create({...scope,placements:[{...input(story,'WORLD'),featured:true}]},actor),/FEATURED/);
  await assert.rejects(service.create({...scope,placements:[{...input(story),section:'WEATHER' as PlacementInput['section']}]},actor),/INVALID_PLACEMENT/);
}));

test('stale and nonexistent story versions are denied', async()=>fixture(async(repo,service)=>{
  const {story}=await seedEditionFixture(repo);
  for(const version of [0,story.version-1,story.version+1]) await assert.rejects(service.create({...scope,placements:[{...input(story),storyVersion:version}]},actor));
  assert.deepEqual((await repo.read()).editions,[]);
}));

test('AI-ready proposal never substitutes for newsroom approval', async()=>fixture(async(repo,service)=>{
  const {story}=await seedEditorialFixture(repo); const ai=new EditorialService(repo,{clock});
  const draft=await ai.generate(story.id,story.version); await ai.review(draft.id,1,'NEEDS_REVIEW',actor); await ai.review(draft.id,2,'READY_FOR_APPROVAL',actor);
  await assert.rejects(service.create({...scope,placements:[input(story)]},actor),/INELIGIBLE/);
  assert.equal((await repo.read()).approvals.length,0);
}));

test('edition review is exact-revision, unauthenticated and grants no publishing state', async()=>fixture(async(repo,service)=>{
  const {story}=await seedEditionFixture(repo); const before=await repo.read();
  const e=await service.create({...scope,placements:[input(story)]},actor);
  await assert.rejects(service.review(e.id,1,'READY_FOR_APPROVAL',actor),/INVALID_EDITION_TRANSITION/);
  await service.review(e.id,1,'NEEDS_REVIEW',actor);
  await assert.rejects(service.review(e.id,1,'READY_FOR_APPROVAL',actor),/STALE_EDITION_REVISION/);
  const ready=await service.review(e.id,2,'READY_FOR_APPROVAL',actor); assert.equal(ready.revision,3);
  await assert.rejects(service.review(e.id,3,'PUBLISHED' as EditionStatus,actor),/INVALID_EDITION_TRANSITION/);
  const after=await repo.read(); assert.deepEqual(after.approvals,before.approvals); assert.deepEqual(after.revisions,before.revisions);
  assert.deepEqual(after.editionReviews.map(r=>[r.fromRevision,r.toRevision]),[[1,2],[2,3]]); assert.ok(after.editionReviews.every(r=>r.unauthenticated));
}));

test('review supports revision requests, holds and terminal rejection',async()=>fixture(async(repo,service)=>{
  const {story}=await seedEditionFixture(repo); const e=await service.create({...scope,placements:[input(story)]},actor);
  await service.review(e.id,1,'NEEDS_REVIEW',actor); await service.review(e.id,2,'REVISION_REQUESTED',actor);
  await service.review(e.id,3,'ON_HOLD',actor); await service.review(e.id,4,'NEEDS_REVIEW',actor);
  await service.review(e.id,5,'REJECTED',actor);
  await assert.rejects(service.review(e.id,6,'NEEDS_REVIEW',actor),/INVALID_EDITION_TRANSITION/);
  await assert.rejects(service.edit(e.id,6,[],actor),/EDITION_REJECTED/);
}));

test('editing readiness resets assembly and old review cannot approve new revision',async()=>fixture(async(repo,service)=>{
  const {story}=await seedEditionFixture(repo); const e=await service.create({...scope,placements:[input(story)]},actor);
  await service.review(e.id,1,'NEEDS_REVIEW',actor); await service.review(e.id,2,'READY_FOR_APPROVAL',actor);
  const edit=await service.edit(e.id,3,[input(story,'SCIENCE')],actor); assert.equal(edit.revision,4); assert.equal(edit.status,'ASSEMBLING');
  await assert.rejects(service.review(e.id,3,'READY_FOR_APPROVAL',actor),/STALE_EDITION_REVISION/);
  await assert.rejects(service.review(e.id,4,'READY_FOR_APPROVAL',actor),/INVALID_EDITION_TRANSITION/);
  assert.equal((await repo.read()).editionReviews.length,2);
}));

test('removing placements appends history and resets readiness',async()=>fixture(async(repo,service)=>{
  const {story}=await seedEditionFixture(repo); const e=await service.create({...scope,placements:[input(story)]},actor);
  const edit=await service.edit(e.id,1,[],actor); assert.ok(edit.sections.every(s=>!s.placements.length));
  const history=(await repo.read()).editions; assert.equal(history.length,2); assert.equal('sections' in history[0] && history[0].sections[0].placements.length,1);
}));

test('date scopes are unique across timezone aliases and independent across dates',async()=>fixture(async(_repo,service)=>{
  await service.create({date:scope.date,timezone:'UTC',placements:[]},actor);
  await assert.rejects(service.create({date:scope.date,timezone:'Etc/UTC',placements:[]},actor),/DATE_ALREADY_EXISTS/);
  const next=await service.create({date:'2026-06-02',timezone:'UTC',placements:[]},actor); assert.equal(next.date,'2026-06-02');
}));

test('invalid dates, timezone, reviewer assertions and caller publication keys are rejected',async()=>fixture(async(_repo,service)=>{
  for(const date of ['2026-02-30','not-a-date','2026-6-1']) await assert.rejects(service.create({...scope,date,placements:[]},actor));
  await assert.rejects(service.create({...scope,timezone:'Invalid/Timezone',placements:[]},actor));
  await assert.rejects(service.create({...scope,placements:[]},'private@example.test'),/INVALID_REVIEWER_ASSERTION/);
  await assert.rejects(service.create({...scope,placements:[],published:true} as Parameters<EditionService['create']>[0],actor),/INVALID_EDITION_INPUT/);
}));

test('concurrent edits serialize and only one exact-revision update succeeds',async()=>fixture(async(repo,service)=>{
  const {story}=await seedEditionFixture(repo); const e=await service.create({...scope,placements:[input(story)]},actor);
  const rival=new EditionService(new JsonRepository(repo.file),{clock});
  const results=await Promise.allSettled([service.edit(e.id,1,[input(story,'SCIENCE')],actor),rival.edit(e.id,1,[input(story,'HEALTH')],actor)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const state=await repo.read(); assert.equal(state.editions.length,2); assert.equal(state.audit.filter(a=>a.action==='EDITION_EDITED').length,1);
}));

test('failed atomic rename seam rolls back edition content, revision, review and audit',async()=>fixture(async(repo,service)=>{
  const {story}=await seedEditionFixture(repo); const e=await service.create({...scope,placements:[input(story)]},actor); const before=await readFile(repo.file,'utf8');
  const broken=new EditionService(new JsonRepository(repo.file,{beforeCommit:()=>{throw Error('controlled disk failure');}}),{clock});
  await assert.rejects(broken.review(e.id,1,'NEEDS_REVIEW',actor),/controlled disk failure/);
  assert.equal(await readFile(repo.file,'utf8'),before);
}));

class BoundaryRepository extends JsonRepository {
  private readonly boundary:()=>void;
  constructor(file:string,boundary:()=>void){super(file);this.boundary=boundary;}
  override async transact<T>(change:(state:State)=>T):Promise<T>{return super.transact(state=>{this.boundary();return change(state);});}
}

test('assembly rechecks source expiry after acquiring the local storage lock',async()=>fixture(async(repo)=>{
  const {story}=await seedEditionFixture(repo); let now=editionAt;
  const delayed=new EditionService(new BoundaryRepository(repo.file,()=>{now='2026-06-02T12:00:00.000Z';}),{clock:()=>now});
  await assert.rejects(delayed.create({...scope,placements:[input(story)]},actor),/INELIGIBLE/);
  assert.deepEqual((await repo.read()).editions,[]);
}));

test('denied expired review persists payload scrubbing after a lock wait',async()=>fixture(async(repo,service)=>{
  const {story}=await seedEditionFixture(repo); const e=await service.create({...scope,placements:[input(story)]},actor);
  await service.review(e.id,1,'NEEDS_REVIEW','sensitive-reviewer'); let now=editionAt;
  const delayed=new EditionService(new BoundaryRepository(repo.file,()=>{now='2026-06-02T12:00:00.000Z';}),{clock:()=>now});
  await assert.rejects(delayed.review(e.id,2,'READY_FOR_APPROVAL',actor),/EDITION_INVALIDATED/);
  const s=await repo.read(); assert.ok(s.editions.every(row=>row.status==='INVALIDATED'));
  assert.doesNotMatch(JSON.stringify({editions:s.editions,reviews:s.editionReviews}),/sensitive-reviewer|A fictional garden|snapshotDigest/);
}));

test('invalidated edition can be explicitly rebuilt without restoring old readiness',async()=>fixture(async(repo,service)=>{
  const {story,newsroom}=await seedEditionFixture(repo); const e=await service.create({...scope,placements:[input(story)]},actor);
  await newsroom.edit(story.id,{summary:'Changed fictional summary'},actor);
  assert.equal((await service.snapshot(e.id)).status,'INVALIDATED');
  await assert.rejects(service.edit(e.id,1,[input(story)],actor),/INELIGIBLE/);
  const rebuilt=await service.edit(e.id,1,[],actor); assert.equal(rebuilt.status,'ASSEMBLING'); assert.equal(rebuilt.revision,2);
}));
