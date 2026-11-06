import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/newsroom/store.ts';
import { AccessControl } from '../src/security/service.ts';
import { seedSecurityFixture, securityAt } from '../fixtures/security-fiction.ts';
import type { TrustedSessionVerifier } from '../src/security/types.ts';
async function fixture(run:(repository:JsonRepository)=>Promise<void>){const directory=await mkdtemp(join(tmpdir(),'dayline-security-boundary-'));try{await run(new JsonRepository(join(directory,'synthetic.json')));}finally{await rm(directory,{recursive:true,force:true});}}

test('identity administration binds the same verified principal through the actual commit guard',async()=>fixture(async repository=>{
  const {verifier,accounts,access}=await seedSecurityFixture(repository);
  const second=await access.createIdentity(accounts.admin.credential,{subject:randomUUID(),roles:['ADMINISTRATOR']});
  const secondClaims={...accounts.admin.claims,subject:second.provider.subject,sessionId:randomUUID()};const secondToken=verifier.issue(secondClaims);await access.registerSession(secondToken);
  let calls=0;const switching:TrustedSessionVerifier={issuer:verifier.issuer,audience:verifier.audience,maxSessionMs:verifier.maxSessionMs,verify:()=>verifier.verify(++calls===1?accounts.admin.credential:secondToken)};
  const control=new AccessControl(repository,{verifier:switching,clock:()=>securityAt});const before=await repository.read();
  await assert.rejects(control.setRoles(accounts.admin.credential,accounts.reporter.identity.id,1,['EDITOR']),/PERMISSION_DENIED/);
  const after=await repository.read();assert.deepEqual(after.identities,before.identities);assert.deepEqual(after.authenticatedActions,before.authenticatedActions);
}));

test('session registration cannot switch an identity or registered session between verification stages',async()=>fixture(async repository=>{
  const {verifier,accounts}=await seedSecurityFixture(repository);
  for(const switchAt of [2,3]){
    const proposedClaims={...accounts.reporter.claims,sessionId:randomUUID()};const proposedToken=verifier.issue(proposedClaims);let calls=0;
    const switching:TrustedSessionVerifier={issuer:verifier.issuer,audience:verifier.audience,maxSessionMs:verifier.maxSessionMs,verify:()=>verifier.verify(++calls<switchAt?proposedToken:accounts.editor.credential)};
    const control=new AccessControl(repository,{verifier:switching,clock:()=>securityAt});const before=await repository.read();
    await assert.rejects(control.registerSession(proposedToken),/INVALID_SESSION/);
    assert.deepEqual((await repository.read()).sessions,before.sessions);
  }
}));
