import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { JsonRepository } from '../newsroom/store.ts';
import type { State } from '../newsroom/model.ts';
import { timestamp } from '../ingestion/metadata.ts';
import { authorize } from './policy.ts';
import { validateClaims, SecurityError } from './verifier.ts';
import { pruneSecurityState } from './retention.ts';
import { roles as knownRoles, type Role, type TrustedSessionVerifier, type Principal, type Permission,
  type IdentityRecord, type SessionRecord, type SecurityEvent, type SecurityCode, type ResourceKind, type AuthenticatedAction } from './types.ts';

const codes:readonly SecurityCode[]=['SUCCESS','INVALID_CREDENTIAL','INVALID_SESSION','SESSION_EXPIRED','SESSION_FUTURE','SESSION_REVOKED','IDENTITY_DISABLED','PERMISSION_DENIED','STALE_TARGET','DOMAIN_REJECTED','STORAGE_UNAVAILABLE'];
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value);
function roleList(value:Role[]):Role[]{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>4
    ||Reflect.ownKeys(value).length!==value.length+1
    ||Object.values(Object.getOwnPropertyDescriptors(value)).some(row=>!Object.hasOwn(row,'value'))
    ||Reflect.ownKeys(value).some(key=>key!=='length'&&(typeof key!=='string'||!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=value.length))
    ||value.some(role=>!knownRoles.includes(role))||new Set(value).size!==value.length)throw new SecurityError('DOMAIN_REJECTED');
  return knownRoles.filter(role=>value.includes(role));
}
function target(state:State,id:string,revision:number):IdentityRecord{
  const identity=state.identities.find(row=>row.id===id);
  if(!identity)throw new SecurityError('DOMAIN_REJECTED');
  if(identity.revision!==revision)throw new SecurityError('STALE_TARGET');return identity;
}

/** Trusted internal metadata administration; no login route, credential store or production provider. */
export class AccessControl {
  readonly repositoryFile:string;
  private readonly repository:JsonRepository;
  private readonly verifier:TrustedSessionVerifier;
  private readonly clock:()=>string;
  constructor(repository:JsonRepository,options:{verifier:TrustedSessionVerifier;clock?:()=>string}){
    this.repository=repository;this.repositoryFile=resolve(repository.file);this.verifier=options.verifier;this.clock=options.clock??(()=>new Date().toISOString());
  }
  now():string{try{return new Date(timestamp(this.clock())).toISOString();}catch{throw new SecurityError('INVALID_SESSION');}}
  authorizeInState(state:State,credential:unknown,permission:Permission|null,at:string):Principal{return authorize(state,credential,this.verifier,permission,at);}
  record(state:State,event:Omit<SecurityEvent,'id'|'at'>,at:string):void{
    state.securityAudit.push({id:'evt_'+randomUUID(),at,category:event.category,code:event.code,userRef:event.userRef,
      sessionRef:event.sessionRef,subjectRef:event.subjectRef,permission:event.permission});
    pruneSecurityState(state,at);
  }
  action(state:State,principal:Principal,permission:Permission,kind:ResourceKind,id:string,version:number|null,at:string):void{
    const action:AuthenticatedAction={id:'act_'+randomUUID(),actorId:principal.identityId,identityRevision:principal.identityRevision,
      sessionRef:principal.sessionRef,permission,resourceKind:kind,resourceId:id,resourceVersion:version,at};
    state.authenticatedActions.push(action);
    this.record(state,{category:'PROTECTED_ACTION',code:'SUCCESS',userRef:principal.identityId,sessionRef:principal.sessionRef,subjectRef:null,permission},at);
  }
  private code(error:unknown):SecurityCode{
    if(error&&typeof error==='object'&&Object.hasOwn(error,'code')){
      const descriptor=Object.getOwnPropertyDescriptor(error,'code');const code=descriptor?.value;
      if(typeof code==='string'&&codes.includes(code as SecurityCode))return code as SecurityCode;
    }
    return 'DOMAIN_REJECTED';
  }
  async recordFailure(error:unknown,principal:Principal|null,permission:Permission|null):Promise<void>{
    try{await this.repository.transact(state=>{const at=this.now(),code=this.code(error);
      this.record(state,{category:code==='PERMISSION_DENIED'?'AUTHZ_DENIED':'AUTH_FAILURE',code,
        userRef:principal?.identityId??null,sessionRef:principal?.sessionRef??null,subjectRef:null,permission},at);
    });}catch{/* Failure logging cannot expose raw errors or pretend the failed content committed. */}
  }
  private pruneSessions(state:State,at:string):void{
    state.sessions=state.sessions.filter(row=>timestamp(row.expiresAt)>timestamp(at));
    pruneSecurityState(state,at);
  }
  private async administration<T>(credential:unknown,work:(state:State,principal:Principal,at:string)=>T,permission:Permission|null='IDENTITY_ADMIN'):Promise<T>{
    let principal:Principal|null=null;let authority:State|undefined;let permitted=false;
    try{
      const result=await this.repository.transactGuarded(state=>{
        const at=this.now();this.pruneSessions(state,at);
        try{principal=this.authorizeInState(state,credential,permission,at);}catch(error){
          const code=this.code(error);this.record(state,{category:code==='PERMISSION_DENIED'?'AUTHZ_DENIED':'AUTH_FAILURE',code,userRef:null,sessionRef:null,subjectRef:null,permission},at);return{error:code};
        }
        authority=structuredClone(state);const candidate=structuredClone(state);
        try{const value=work(candidate,principal,at);Object.assign(state,candidate);permitted=true;return{value};}
        catch(error){const code=this.code(error);this.record(state,{category:'AUTHZ_DENIED',code,userRef:principal.identityId,sessionRef:principal.sessionRef,subjectRef:null,permission},at);return{error:code};}
      },()=>{if(permitted&&authority&&principal){
        const final=this.authorizeInState(authority,credential,permission,this.now());
        if(final.identityId!==principal.identityId||final.identityRevision!==principal.identityRevision||final.sessionRef!==principal.sessionRef||final.sessionId!==principal.sessionId)throw new SecurityError('PERMISSION_DENIED');
      }});
      if('error'in result)throw new SecurityError(result.error??'DOMAIN_REJECTED');return result.value as T;
    }catch(error){
      const safe=error instanceof SecurityError?error:new SecurityError('STORAGE_UNAVAILABLE');
      if(permitted)await this.recordFailure(safe,principal,permission);
      throw safe;
    }
  }
  async registerSession(credential:unknown):Promise<SessionRecord>{
    let principal:Principal|null=null;let accepted=false;
    try{
      const result=await this.repository.transactGuarded(state=>{
        const at=this.now();this.pruneSessions(state,at);
        const candidate=structuredClone(state);
        try{
          const claims=validateClaims(this.verifier.verify(credential),this.verifier,at);
          const identity=candidate.identities.find(row=>row.provider.issuer===claims.issuer&&row.provider.subject===claims.subject);
          if(!identity||identity.credentialVersion!==claims.credentialVersion)throw new SecurityError('INVALID_SESSION');
          if(identity.status!=='ACTIVE')throw new SecurityError('IDENTITY_DISABLED');
          let session=candidate.sessions.find(row=>row.id===claims.sessionId);
          if(!session){if(candidate.sessions.length>=512)throw new SecurityError('INVALID_SESSION');
            session={id:claims.sessionId,auditRef:'sref_'+randomUUID(),userId:identity.id,issuer:claims.issuer,audience:claims.audience,
              keyId:claims.keyId,credentialVersion:claims.credentialVersion,authenticatedAt:claims.authenticatedAt,notBefore:claims.notBefore,expiresAt:claims.expiresAt,revokedAt:null};
            candidate.sessions.push(session);
          }
          principal=this.authorizeInState(candidate,credential,null,at);
          if(principal.identityId!==identity.id||principal.sessionId!==session.id||principal.sessionRef!==session.auditRef)throw new SecurityError('INVALID_SESSION');
          this.record(candidate,{category:'AUTH_SUCCESS',code:'SUCCESS',userRef:principal.identityId,sessionRef:principal.sessionRef,subjectRef:null,permission:null},at);
          Object.assign(state,candidate);accepted=true;return{session};
        }catch(error){const code=this.code(error);this.record(state,{category:'AUTH_FAILURE',code,userRef:null,sessionRef:null,subjectRef:null,permission:null},at);return{error:code};}
      },state=>{if(accepted&&principal){
        const final=this.authorizeInState(state,credential,null,this.now());
        if(final.identityId!==principal.identityId||final.identityRevision!==principal.identityRevision||final.sessionRef!==principal.sessionRef||final.sessionId!==principal.sessionId)throw new SecurityError('INVALID_SESSION');
      }});
      if(!result.session)throw new SecurityError(result.error??'INVALID_SESSION');return result.session;
    }catch(error){const safe=error instanceof SecurityError?error:new SecurityError('STORAGE_UNAVAILABLE');if(accepted)await this.recordFailure(safe,principal,null);throw safe;}
  }
  async createIdentity(credential:unknown,input:{subject:string;roles:Role[]}):Promise<IdentityRecord>{
    return this.administration(credential,(state,principal,at)=>{
      if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['subject','roles'].includes(key))||!identifier(input.subject)||state.identities.length>=128
        ||state.identities.some(row=>row.provider.issuer===this.verifier.issuer&&row.provider.subject===input.subject))throw new SecurityError('DOMAIN_REJECTED');
      const identity:IdentityRecord={id:'usr_'+randomUUID(),status:'ACTIVE',roles:roleList(input.roles),provider:{issuer:this.verifier.issuer,subject:input.subject},revision:1,credentialVersion:1,credentialsRotatedAt:null,createdAt:at,updatedAt:at};
      state.identities.push(identity);this.action(state,principal,'IDENTITY_ADMIN','IDENTITY',identity.id,identity.revision,at);
      this.record(state,{category:'IDENTITY_CREATED',code:'SUCCESS',userRef:principal.identityId,sessionRef:principal.sessionRef,subjectRef:identity.id,permission:'IDENTITY_ADMIN'},at);return identity;
    });
  }
  async setRoles(credential:unknown,id:string,revision:number,roles:Role[]):Promise<IdentityRecord>{
    return this.administration(credential,(state,principal,at)=>{const identity=target(state,id,revision);identity.roles=roleList(roles);identity.revision++;identity.updatedAt=at;
      this.action(state,principal,'IDENTITY_ADMIN','IDENTITY',id,identity.revision,at);this.record(state,{category:'ROLE_CHANGED',code:'SUCCESS',userRef:principal.identityId,sessionRef:principal.sessionRef,subjectRef:id,permission:'IDENTITY_ADMIN'},at);return identity;});
  }
  async setStatus(credential:unknown,id:string,revision:number,status:'ACTIVE'|'DISABLED'):Promise<IdentityRecord>{
    return this.administration(credential,(state,principal,at)=>{const identity=target(state,id,revision);if(!['ACTIVE','DISABLED'].includes(status))throw new SecurityError('DOMAIN_REJECTED');
      identity.status=status;identity.revision++;identity.updatedAt=at;this.action(state,principal,'IDENTITY_ADMIN','IDENTITY',id,identity.revision,at);
      this.record(state,{category:'IDENTITY_STATUS_CHANGED',code:'SUCCESS',userRef:principal.identityId,sessionRef:principal.sessionRef,subjectRef:id,permission:'IDENTITY_ADMIN'},at);return identity;});
  }
  async rotateCredentials(credential:unknown,id:string,revision:number):Promise<IdentityRecord>{
    return this.administration(credential,(state,principal,at)=>{const identity=target(state,id,revision);identity.credentialVersion++;identity.revision++;identity.credentialsRotatedAt=at;identity.updatedAt=at;
      this.action(state,principal,'IDENTITY_ADMIN','IDENTITY',id,identity.revision,at);this.record(state,{category:'CREDENTIALS_ROTATED',code:'SUCCESS',userRef:principal.identityId,sessionRef:principal.sessionRef,subjectRef:id,permission:'IDENTITY_ADMIN'},at);return identity;});
  }
  async revokeSession(credential:unknown,id:string):Promise<SessionRecord>{
    return this.administration(credential,(state,principal,at)=>{const session=state.sessions.find(row=>row.id===id);if(!session)throw new SecurityError('INVALID_SESSION');
      session.revokedAt??=at;this.action(state,principal,'IDENTITY_ADMIN','SESSION',session.auditRef,null,at);this.record(state,{category:'SESSION_REVOKED',code:'SUCCESS',userRef:principal.identityId,sessionRef:principal.sessionRef,subjectRef:session.auditRef,permission:'IDENTITY_ADMIN'},at);return session;});
  }
  async invalidateSession(credential:unknown):Promise<SessionRecord>{
    return this.administration(credential,(state,principal,at)=>{const session=state.sessions.find(row=>row.id===principal.sessionId)!;session.revokedAt=at;
      this.record(state,{category:'SESSION_REVOKED',code:'SUCCESS',userRef:principal.identityId,sessionRef:principal.sessionRef,subjectRef:session.auditRef,permission:null},at);return session;},null);
  }
}
