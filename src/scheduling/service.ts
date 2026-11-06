import { createHash, randomUUID } from 'node:crypto';
import { JsonRepository } from '../newsroom/store.ts';
import type { State } from '../newsroom/model.ts';
import type { PlacementInput } from '../editions/types.ts';
import { createEditionInState, EditionError } from '../editions/service.ts';
import { invalidateEditions } from '../editions/lifecycle.ts';
import { timestamp } from '../ingestion/metadata.ts';
import { validateDefinition, nextOccurrence, latestOccurrence } from './calendar.ts';
import type { PreparationRun, PreparationSchedule, ScheduleDefinition, FailureCode } from './types.ts';

export class SchedulerError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name='SchedulerError'; this.code=code; }
}
const pending = (run: PreparationRun) => ['SCHEDULED','CLAIMED','PREPARING'].includes(run.status) || (run.status==='FAILED' && run.nextRetryAt!==null);
function schedule(state: State, id: string): PreparationSchedule {
  const value=state.schedules.find(row=>row.id===id); if(!value) throw new SchedulerError('SCHEDULE_NOT_FOUND'); return value;
}
function run(state: State, id: string): PreparationRun {
  const value=state.preparationRuns.find(row=>row.id===id); if(!value) throw new SchedulerError('RUN_NOT_FOUND'); return value;
}
function audit(state: State, action: string, at: string, scheduleId: string, preparationRunId?: string): void {
  state.audit.push({id:randomUUID(),storyId:null,action,actor:'scheduler-service',at,version:null,scheduleId,...(preparationRunId?{preparationRunId}:{})});
}
function release(value: PreparationRun, at: string, failure: FailureCode | null): void {
  value.updatedAt=at; value.failure=failure; value.claimId=null; value.leaseUntil=null; value.nextRetryAt=null;
}
function requireClaim(value: PreparationRun, claimId: string, at: string): void {
  if (!['CLAIMED','PREPARING'].includes(value.status) || !claimId || value.claimId!==claimId) throw new SchedulerError('STALE_OR_INVALID_CLAIM');
  if (!value.leaseUntil || timestamp(value.leaseUntil)<=timestamp(at)) throw new SchedulerError('CLAIM_EXPIRED');
}
function failAttempt(value: PreparationRun, at: string, failure: 'INTERRUPTED' | 'TRANSIENT_FAILURE'): void {
  value.status='FAILED'; release(value,at,value.attempts>=value.maxAttempts?'RETRY_EXHAUSTED':failure);
  if(value.attempts<value.maxAttempts) value.nextRetryAt=new Date(timestamp(at)+value.retryDelayMs).toISOString();
}
function evaluateState(state: State, at: string) {
  for(const value of state.schedules) {
    if(!value.enabled) continue;
    const first=value.nextOccurrence;
    if(first && timestamp(first.at)<=timestamp(at)) {
      const occurrence=latestOccurrence(value,at);
      if(occurrence && timestamp(occurrence.at)>=timestamp(first.at) && !state.preparationRuns.some(row=>row.occurrence.key===occurrence.key)) {
        if(state.preparationRuns.length>=4096) throw new SchedulerError('RUN_CAPACITY_REACHED');
        const missed=timestamp(at)-timestamp(occurrence.at)>value.catchUpWindowMs;
        const id='run-'+createHash('sha256').update(occurrence.key).digest('hex');
        const prepared:PreparationRun={id,scheduleId:value.id,occurrence,status:missed?'NEEDS_ATTENTION':'SCHEDULED',attempts:0,
          maxAttempts:value.maxAttempts,retryDelayMs:value.retryDelayMs,claimId:null,leaseUntil:null,nextRetryAt:null,editionId:null,editionRevision:null,
          failure:missed?'MISSED_WINDOW':null,missedSince:timestamp(first.at)<timestamp(occurrence.at)?first.at:null,createdAt:at,updatedAt:at};
        state.preparationRuns.push(prepared); audit(state,missed?'PREPARATION_MISSED':'PREPARATION_SCHEDULED',at,value.id,id);
      }
      value.nextOccurrence=nextOccurrence(value,at);
    }
    value.lastEvaluatedAt=at; value.updatedAt=at;
  }
  return {schedules:state.schedules,runs:state.preparationRuns};
}

/** Explicit single-host development operations. No timers, providers, review or publishing APIs. */
export class SchedulerService {
  private readonly repository: JsonRepository;
  private readonly clock:()=>string;
  private readonly leaseMs:number;
  constructor(repository:JsonRepository,options:{clock?:()=>string;leaseMs?:number}={}) {
    this.repository=repository; this.clock=options.clock??(()=>new Date().toISOString()); this.leaseMs=options.leaseMs??30000;
    if(!Number.isSafeInteger(this.leaseMs)||this.leaseMs<1000||this.leaseMs>300000) throw new SchedulerError('INVALID_LEASE');
  }
  private now():string{try{return new Date(timestamp(this.clock())).toISOString();}catch{throw new SchedulerError('INVALID_CLOCK');}}
  private async safely<T>(work:()=>Promise<T>):Promise<T>{try{return await work();}catch(error){if(error instanceof SchedulerError)throw error;throw new SchedulerError('SCHEDULER_STORAGE_UNAVAILABLE');}}
  private reconcile(state:State,at:string):void {
    if([...state.schedules,...state.preparationRuns].some(row=>timestamp(row.updatedAt)>timestamp(at))) throw new SchedulerError('CLOCK_MOVED_BACKWARDS');
    invalidateEditions(state,at);
  }
  private async change<T>(apply:(state:State,at:string)=>T):Promise<T> {
    return this.safely(async()=>{
    const result=await this.repository.transact(state=>{
      const at=this.now(); this.reconcile(state,at);
      const candidate=structuredClone(state);
      try { const value=apply(candidate,at); Object.assign(state,candidate); return {value}; }
      catch(error) {return {error:error instanceof SchedulerError?error.code:'SCHEDULING_ACTION_FAILED'};}
    });
    if('error' in result) throw new SchedulerError(result.error??'SCHEDULING_ACTION_FAILED');
    return result.value as T;
    });
  }
  async create(definition:ScheduleDefinition):Promise<PreparationSchedule> {
    return this.change((state,at)=>{
      if(state.schedules.length>=32) throw new SchedulerError('SCHEDULE_CAPACITY_REACHED');
      const config=validateDefinition(definition);
      const value:PreparationSchedule={id:randomUUID(),...config,createdAt:at,updatedAt:at,lastEvaluatedAt:null,nextOccurrence:null};
      if(value.enabled) value.nextOccurrence=nextOccurrence(value,at,true);
      state.schedules.push(value); audit(state,'SCHEDULE_CREATED',at,value.id); return value;
    });
  }
  async evaluate(options:{dryRun?:boolean}={}):Promise<{schedules:PreparationSchedule[];runs:PreparationRun[]}> {
    if(!options || typeof options!=='object' || Object.keys(options).some(key=>key!=='dryRun') || (options.dryRun!==undefined&&typeof options.dryRun!=='boolean')) throw new SchedulerError('INVALID_EVALUATION_OPTIONS');
    if(options.dryRun!==false) return this.safely(async()=>{const state=structuredClone(await this.repository.read()); const at=this.now(); this.reconcile(state,at); return structuredClone(evaluateState(state,at));});
    return this.change(evaluateState);
  }
  async pause(id:string):Promise<PreparationSchedule> {
    return this.change((state,at)=>{
      const value=schedule(state,id); value.enabled=false; value.nextOccurrence=null; value.updatedAt=at;
      for(const item of state.preparationRuns.filter(row=>row.scheduleId===id&&pending(row))) {
        item.status='CANCELLED';release(item,at,'PAUSED');audit(state,'PREPARATION_CANCELLED',at,id,item.id);
      }
      audit(state,'SCHEDULE_PAUSED',at,id);return value;
    });
  }
  async resume(id:string):Promise<PreparationSchedule> {
    return this.change((state,at)=>{
      const value=schedule(state,id);
      if(!value.enabled) {value.enabled=true;value.nextOccurrence=nextOccurrence(value,at);value.updatedAt=at;audit(state,'SCHEDULE_RESUMED',at,id);}
      return value;
    });
  }
  async cancel(id:string):Promise<PreparationRun> {
    return this.change((state,at)=>{
      const value=run(state,id);if(!pending(value)) throw new SchedulerError('RUN_NOT_PENDING');
      value.status='CANCELLED';release(value,at,'CANCELLED');audit(state,'PREPARATION_CANCELLED',at,value.scheduleId,id);return value;
    });
  }
  async claim(id:string):Promise<PreparationRun> {
    return this.change((state,at)=>{
      const value=run(state,id),config=schedule(state,value.scheduleId);
      if(!config.enabled) throw new SchedulerError('SCHEDULE_PAUSED');
      if(value.status!=='SCHEDULED' && !(value.status==='FAILED'&&value.nextRetryAt&&timestamp(value.nextRetryAt)<=timestamp(at))) throw new SchedulerError('RUN_NOT_CLAIMABLE');
      if(value.attempts>=value.maxAttempts) throw new SchedulerError('RETRY_EXHAUSTED');
      if(timestamp(value.occurrence.at)>timestamp(at)) throw new SchedulerError('OCCURRENCE_NOT_DUE');
      if(timestamp(at)-timestamp(value.occurrence.at)>config.catchUpWindowMs) {
        value.status='NEEDS_ATTENTION';release(value,at,'MISSED_WINDOW');audit(state,'PREPARATION_MISSED',at,value.scheduleId,id);return value;
      }
      value.status='CLAIMED';value.attempts++;value.claimId=randomUUID();value.leaseUntil=new Date(timestamp(at)+this.leaseMs).toISOString();value.nextRetryAt=null;value.failure=null;value.updatedAt=at;
      audit(state,'PREPARATION_CLAIMED',at,value.scheduleId,id);return value;
    });
  }
  async begin(id:string,claimId:string):Promise<PreparationRun> {
    return this.change((state,at)=>{
      const value=run(state,id);requireClaim(value,claimId,at);
      if(value.status!=='CLAIMED') throw new SchedulerError('INVALID_RUN_TRANSITION');
      value.status='PREPARING';value.updatedAt=at;audit(state,'PREPARATION_STARTED',at,value.scheduleId,id);return value;
    });
  }
  async prepare(id:string,claimId:string,placements:PlacementInput[]=[]):Promise<PreparationRun> {
    return this.change((state,at)=>{
      let value=run(state,id);requireClaim(value,claimId,at);
      if(value.status!=='PREPARING') throw new SchedulerError('INVALID_RUN_TRANSITION');
      if(!schedule(state,value.scheduleId).enabled) throw new SchedulerError('SCHEDULE_PAUSED');
      let failure:FailureCode|null=state.retentionReviewRequired?'RETENTION_HOLD':null;
      if(!failure) {
        const staged=structuredClone(state);
        try {
          const edition=createEditionInState(staged,{date:value.occurrence.date,timezone:value.occurrence.timezone,placements},at);
          Object.assign(state,staged);value=run(state,id);value.editionId=edition.id;value.editionRevision=edition.revision;
        } catch(error) {failure=error instanceof EditionError&&error.code==='EDITION_DATE_ALREADY_EXISTS'?'EDITION_CONFLICT':'INELIGIBLE_CONTENT';}
      }
      value.status=failure?'NEEDS_ATTENTION':'PREPARED';release(value,at,failure);
      audit(state,failure?'PREPARATION_NEEDS_ATTENTION':'PREPARATION_PREPARED',at,value.scheduleId,id);return value;
    });
  }
  async fail(id:string,claimId:string):Promise<PreparationRun> {
    return this.change((state,at)=>{const value=run(state,id);requireClaim(value,claimId,at);failAttempt(value,at,'TRANSIENT_FAILURE');audit(state,'PREPARATION_FAILED',at,value.scheduleId,id);return value;});
  }
  async recover():Promise<PreparationRun[]> {
    return this.change((state,at)=>{
      const recovered:PreparationRun[]=[];
      for(const value of state.preparationRuns) if(['CLAIMED','PREPARING'].includes(value.status)&&value.leaseUntil&&timestamp(value.leaseUntil)<=timestamp(at)) {
        if(!schedule(state,value.scheduleId).enabled) {value.status='CANCELLED';release(value,at,'PAUSED');}
        else failAttempt(value,at,'INTERRUPTED');
        audit(state,'PREPARATION_RECOVERED',at,value.scheduleId,value.id);recovered.push(value);
      }
      return recovered;
    });
  }
  async execute(id:string,placements:PlacementInput[]=[]):Promise<PreparationRun> {
    const claimed=await this.claim(id);
    if(claimed.status!=='CLAIMED'||!claimed.claimId) return claimed;
    await this.begin(id,claimed.claimId);return this.prepare(id,claimed.claimId,placements);
  }
  async snapshot():Promise<{schedules:PreparationSchedule[];runs:PreparationRun[]}> {return this.change(state=>({schedules:state.schedules,runs:state.preparationRuns}));}
}
