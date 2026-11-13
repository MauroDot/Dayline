import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { emptyState, type State } from '../src/newsroom/model.ts';
import { authorize, permissionMatrix } from '../src/security/policy.ts';
import { SecurityError, SyntheticSessionVerifier, validateClaims } from '../src/security/verifier.ts';
import { permissions, roles, type Permission, type Role, type SecurityCode, type VerifiedSessionClaims } from '../src/security/types.ts';

const key = Buffer.alloc(32, 0x5a); // Explicit deterministic fictional fixture key, never a provider credential.
const at = '2026-06-01T12:00:00.000Z';
const expires = '2026-06-01T12:15:00.000Z';
const identityId = 'usr_fixture_identity';
const subject = 'subject_fixture_one';
const sessionId = 'session_fixture_one';
const sessionRef = 'ref_fixture_session';
function fixture(role: Role = 'REPORTER') {
  const verifier = new SyntheticSessionVerifier({ key, keyId: 'fixture-key' });
  const claims: VerifiedSessionClaims = { issuer: verifier.issuer, audience: verifier.audience, subject, sessionId, keyId: 'fixture-key',
    credentialVersion: 1, authenticatedAt: at, notBefore: at, expiresAt: expires };
  const state = emptyState();
  state.identities.push({ id: identityId, status: 'ACTIVE', roles: [role], provider: { issuer: verifier.issuer, subject }, revision: 1,
    credentialVersion: 1, credentialsRotatedAt: null, createdAt: at, updatedAt: at });
  state.sessions.push({ id: sessionId, auditRef: sessionRef, userId: identityId, issuer: claims.issuer, audience: claims.audience,
    keyId: claims.keyId, credentialVersion: claims.credentialVersion, authenticatedAt: at, notBefore: at, expiresAt: expires, revokedAt: null });
  return { state, verifier, claims, credential: verifier.issue(claims) };
}
function code(expected: SecurityCode): (error: unknown) => boolean {
  return error => error instanceof SecurityError && error.code === expected && error.message === expected;
}
function signed(payload: unknown, header: unknown = { alg: 'HS256', typ: 'JWT', kid: 'fixture-key' }): string {
  const first = Buffer.from(JSON.stringify(header)).toString('base64url'), second = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${first}.${second}.${createHmac('sha256', key).update(`${first}.${second}`).digest('base64url')}`;
}
function denied(change: (state: State) => void, expected: SecurityCode = 'INVALID_SESSION') {
  const context = fixture(); change(context.state);
  assert.throws(() => authorize(context.state, context.credential, context.verifier, 'STORY_CREATE', at), code(expected));
}

test('synthetic credentials verify signed metadata and authorization returns only current principal references', () => {
  const context = fixture(), before = structuredClone(context.state);
  assert.deepEqual(context.verifier.verify(context.credential), context.claims);
  assert.deepEqual(authorize(context.state, context.credential, context.verifier, 'STORY_CREATE', at),
    { identityId, identityRevision: 1, sessionRef, sessionId });
  assert.deepEqual(authorize(context.state, context.credential, context.verifier, null, at),
    { identityId, identityRevision: 1, sessionRef, sessionId });
  assert.deepEqual(context.state, before);
  assert.equal(JSON.stringify(context.verifier).includes(key.toString('hex')), false);
  assert.equal(JSON.stringify(context.state).includes(context.credential), false);
});

test('permission matrix is immutable and exactly separates editorial approval from identity administration', () => {
  const expected: Record<Role, Permission[]> = {
    REPORTER: ['STORY_CREATE', 'STORY_EDIT', 'EDITION_ASSEMBLE'],
    EDITOR: ['STORY_CREATE', 'STORY_EDIT', 'EDITION_ASSEMBLE', 'STORY_REVIEW', 'DRAFT_REVIEW', 'EDITION_REVIEW', 'SCHEDULE_EXECUTE', 'SOURCE_READ'],
    MANAGING_EDITOR: ['STORY_CREATE', 'STORY_EDIT', 'EDITION_ASSEMBLE', 'STORY_REVIEW', 'DRAFT_REVIEW', 'EDITION_REVIEW', 'SCHEDULE_EXECUTE', 'SOURCE_READ', 'STORY_APPROVE', 'DRAFT_READY', 'EDITION_READY', 'SCHEDULE_CONFIGURE'],
    ADMINISTRATOR: ['IDENTITY_ADMIN', 'SCHEDULE_CONFIGURE', 'SCHEDULE_EXECUTE'],
  };
  for (const role of roles) {
    assert.deepEqual(permissionMatrix[role], expected[role]); assert.equal(Object.isFrozen(permissionMatrix[role]), true);
    const context = fixture(role);
    for (const permission of permissions) {
      if (expected[role].includes(permission)) assert.ok(authorize(context.state, context.credential, context.verifier, permission, at));
      else assert.throws(() => authorize(context.state, context.credential, context.verifier, permission, at), code('PERMISSION_DENIED'));
    }
  }
  assert.equal(Object.isFrozen(permissionMatrix), true);
});

test('current role removal is effective immediately without reissuing a signed credential', () => {
  const context = fixture('MANAGING_EDITOR');
  assert.ok(authorize(context.state, context.credential, context.verifier, 'STORY_APPROVE', at));
  context.state.identities[0].roles = ['REPORTER']; context.state.identities[0].revision++;
  assert.throws(() => authorize(context.state, context.credential, context.verifier, 'STORY_APPROVE', at), code('PERMISSION_DENIED'));
  assert.equal(authorize(context.state, context.credential, context.verifier, 'STORY_EDIT', at).identityRevision, 2);
});

test('disabled unknown duplicate or mismatched identities cannot authenticate', () => {
  denied(state => { state.identities[0].status = 'DISABLED'; }, 'IDENTITY_DISABLED');
  denied(state => { state.identities = []; });
  denied(state => { state.identities.push(structuredClone(state.identities[0])); });
  denied(state => { state.identities[0].provider.subject = 'different_fixture_subject'; });
  denied(state => { state.identities[0].provider.issuer = 'urn:fictional:other'; });
  denied(state => { state.identities[0].roles = ['ADMIN' as Role]; });
});

test('empty-role identities can authenticate but receive no protected permissions', () => {
  const context = fixture(); context.state.identities[0].roles = [];
  assert.deepEqual(authorize(context.state, context.credential, context.verifier, null, at),
    { identityId, identityRevision: 1, sessionRef, sessionId });
  for (const permission of permissions) assert.throws(() => authorize(context.state, context.credential, context.verifier, permission, at), code('PERMISSION_DENIED'));
});

test('credentials do not authorize an unknown or duplicate session even when their HMAC is valid', () => {
  denied(state => { state.sessions = []; });
  denied(state => { state.sessions.push(structuredClone(state.sessions[0])); });
  denied(state => { state.sessions[0].id = 'another_fixture_session'; });
  denied(state => { state.sessions[0].userId = 'usr_different_identity'; });
});

test('each persisted session field must match the verified credential exactly', () => {
  const changes: ((state: State) => void)[] = [
    state => { state.sessions[0].issuer = 'urn:fictional:other'; },
    state => { state.sessions[0].audience = 'other-fixture-audience'; },
    state => { state.sessions[0].keyId = 'other-key'; },
    state => { state.sessions[0].credentialVersion = 2; },
    state => { state.sessions[0].authenticatedAt = '2026-06-01T11:59:59.000Z'; },
    state => { state.sessions[0].notBefore = '2026-06-01T11:59:59.000Z'; },
    state => { state.sessions[0].expiresAt = '2026-06-01T12:14:59.000Z'; },
    state => { state.sessions[0].auditRef = 'https://fiction.example.test/private'; },
  ];
  for (const change of changes) denied(change);
});

test('revocation denies replay of a formerly valid session immediately', () => {
  const context = fixture();
  assert.ok(authorize(context.state, context.credential, context.verifier, 'STORY_CREATE', at));
  context.state.sessions[0].revokedAt = at;
  assert.throws(() => authorize(context.state, context.credential, context.verifier, 'STORY_CREATE', at), code('SESSION_REVOKED'));
  assert.throws(() => authorize(context.state, context.credential, context.verifier, null, at), code('SESSION_REVOKED'));
});

test('credential version and rotation timestamp invalidate old credentials regardless of their roles', () => {
  denied(state => { state.identities[0].credentialVersion = 2; });
  denied(state => { state.identities[0].credentialsRotatedAt = '2026-06-01T12:00:01.000Z'; });
  const context = fixture();
  context.state.identities[0].credentialsRotatedAt = at;
  assert.ok(authorize(context.state, context.credential, context.verifier, 'STORY_CREATE', at));
});

test('every authorization freshly verifies the credential and rechecks session expiry', () => {
  const context = fixture(); let calls = 0;
  const verifier = { issuer: context.verifier.issuer, audience: context.verifier.audience, maxSessionMs: context.verifier.maxSessionMs,
    verify(value: unknown) { calls++; return context.verifier.verify(value); } };
  authorize(context.state, context.credential, verifier, null, at);
  assert.throws(() => authorize(context.state, context.credential, verifier, null, expires), code('SESSION_EXPIRED'));
  assert.equal(calls, 2);
});

test('issuer and audience mismatches are denied even when signed by the trusted fixture key', () => {
  const context = fixture();
  for (const claims of [{ ...context.claims, issuer: 'urn:fictional:other' }, { ...context.claims, audience: 'other-fixture-audience' }]) {
    const token = context.verifier.issue(claims);
    assert.throws(() => context.verifier.verify(token), code('INVALID_CREDENTIAL'));
    assert.throws(() => validateClaims(claims, context.verifier, at), code('INVALID_SESSION'));
  }
});

test('future authentication not-before and exact expiry boundaries fail closed', () => {
  const context = fixture();
  assert.deepEqual(validateClaims(context.claims, context.verifier, at), context.claims);
  assert.ok(validateClaims(context.claims, context.verifier, '2026-06-01T12:14:59.999Z'));
  assert.throws(() => validateClaims(context.claims, context.verifier, expires), code('SESSION_EXPIRED'));
  assert.throws(() => validateClaims(context.claims, context.verifier, '2026-06-01T11:59:59.999Z'), code('SESSION_FUTURE'));
  assert.throws(() => validateClaims({ ...context.claims, notBefore: '2026-06-01T12:00:01.000Z' }, context.verifier, at), code('SESSION_FUTURE'));
});

test('maximum session duration and temporal ordering are bounded without inferred grants', () => {
  const context = fixture();
  for (const change of [
    { expiresAt: '2026-06-01T12:15:00.001Z' }, { notBefore: '2026-06-01T11:59:59.999Z' },
    { notBefore: expires }, { expiresAt: at }, { authenticatedAt: '2026-02-30T12:00:00.000Z' },
  ]) assert.throws(() => validateClaims({ ...context.claims, ...change }, context.verifier, at), code('INVALID_SESSION'));
  assert.throws(() => new SyntheticSessionVerifier({ maxSessionMs: 999 }), code('INVALID_CREDENTIAL'));
  assert.throws(() => new SyntheticSessionVerifier({ maxSessionMs: 3600001 }), code('INVALID_CREDENTIAL'));
  assert.equal(new SyntheticSessionVerifier({ maxSessionMs: 3600000 }).maxSessionMs, 3600000);
});

test('unsigned corrupted wrong-key or noncanonical compact credentials are rejected', () => {
  const context = fixture(), [header, payload, signature] = context.credential.split('.');
  const other = new SyntheticSessionVerifier({ key: Buffer.alloc(32, 0x2b), keyId: 'fixture-key' });
  const invalid = ['', 'not-a-token', `${header}.${payload}.`, `${header}.${payload}.${signature.slice(0, -1)}x`, `${header}=.${payload}.${signature}`,
    `${header}.${payload}.AA`, `${header}.${payload}.${signature}.extra`, other.issue(context.claims),
    `${header}.${Buffer.from(JSON.stringify({ ...context.claims, subject: 'tampered_fixture_subject' })).toString('base64url')}.${signature}`];
  for (const credential of invalid) assert.throws(() => context.verifier.verify(credential), code('INVALID_CREDENTIAL'));
});

test('signed duplicate JSON keys and lossy encodings are rejected as ambiguous synthetic credentials', () => {
  const context = fixture();
  const rawPayload = JSON.stringify(context.claims).replace('"credentialVersion":1', '"credentialVersion":0,"credentialVersion":1');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'fixture-key' })).toString('base64url');
  const payload = Buffer.from(rawPayload).toString('base64url');
  const signature = createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
  assert.throws(() => context.verifier.verify(`${header}.${payload}.${signature}`), code('INVALID_CREDENTIAL'));
  const duplicateHeader = Buffer.from('{"alg":"none","alg":"HS256","typ":"JWT","kid":"fixture-key"}').toString('base64url');
  const originalPayload = context.credential.split('.')[1];
  const signedHeader = createHmac('sha256', key).update(`${duplicateHeader}.${originalPayload}`).digest('base64url');
  assert.throws(() => context.verifier.verify(`${duplicateHeader}.${originalPayload}.${signedHeader}`), code('INVALID_CREDENTIAL'));
});

test('headers cannot select unsigned algorithms alternate keys or injected trust material', () => {
  const context = fixture();
  for (const header of [
    { alg: 'none', typ: 'JWT', kid: 'fixture-key' }, { alg: 'HS512', typ: 'JWT', kid: 'fixture-key' },
    { alg: 'HS256', typ: 'JWT', kid: 'other-key' }, { alg: 'HS256', typ: 'jwt', kid: 'fixture-key' },
    { alg: 'HS256', typ: 'JWT', kid: 'fixture-key', jwk: { roles: ['ADMINISTRATOR'] } },
  ]) assert.throws(() => context.verifier.verify(signed(context.claims, header)), code('INVALID_CREDENTIAL'));
  assert.throws(() => context.verifier.verify(signed({ ...context.claims, keyId: 'other-key' })), code('INVALID_CREDENTIAL'));
});

test('credential roles identity objects and malformed claims cannot elevate permissions', () => {
  const context = fixture();
  for (const payload of [
    { ...context.claims, roles: ['ADMINISTRATOR'] }, { ...context.claims, role: 'MANAGING_EDITOR' },
    { ...context.claims, identity: { id: identityId, roles: ['MANAGING_EDITOR'] } },
    { ...context.claims, subject: 'person@fiction.example.test' }, { ...context.claims, sessionId: 'https://fiction.example.test/session' },
    { ...context.claims, credentialVersion: 0 }, { ...context.claims, credentialVersion: 1.5 },
  ]) assert.throws(() => context.verifier.verify(signed(payload)), code('INVALID_CREDENTIAL'));
  assert.throws(() => context.verifier.issue({ ...context.claims, roles: ['ADMINISTRATOR'] } as VerifiedSessionClaims), code('INVALID_CREDENTIAL'));
});

test('credential input must be a compact string and cannot execute object coercion', () => {
  const context = fixture(); let coerced = false;
  const credential = { roles: ['ADMINISTRATOR'], toString() { coerced = true; return context.credential; } };
  for (const value of [credential, context.claims, null, undefined, Buffer.from(context.credential)]) {
    assert.throws(() => context.verifier.verify(value), code('INVALID_CREDENTIAL'));
    assert.throws(() => authorize(context.state, value, context.verifier, 'STORY_APPROVE', at), code('INVALID_CREDENTIAL'));
  }
  assert.equal(coerced, false);
});

test('unknown permission names never match inherited object properties', () => {
  const context = fixture('MANAGING_EDITOR');
  for (const permission of ['constructor', '__proto__', 'PUBLISH', 'IDENTITY_ADMIN_EXTRA', undefined]) {
    assert.throws(() => authorize(context.state, context.credential, context.verifier, permission as Permission, at), code('PERMISSION_DENIED'));
  }
});

test('verifier key bytes and returned claim copies cannot mutate later verification', () => {
  const fixtureKey = Buffer.alloc(32, 0x5a), context = fixture();
  const verifier = new SyntheticSessionVerifier({ key: fixtureKey, keyId: 'fixture-key' });
  const credential = verifier.issue(context.claims); fixtureKey.fill(0);
  const claims = verifier.verify(credential); claims.subject = 'changed_fixture_subject';
  assert.deepEqual(verifier.verify(credential), context.claims);
  assert.equal(Object.isFrozen(verifier), true);
  assert.throws(() => new SyntheticSessionVerifier({ key: Buffer.alloc(16) }), code('INVALID_CREDENTIAL'));
  assert.throws(() => new SyntheticSessionVerifier({ keyId: 'https://fixture.example.test/key' }), code('INVALID_CREDENTIAL'));
});

test('errors expose safe codes without credential strings provider details or raw exception causes', () => {
  const context = fixture();
  const throwing = { issuer: context.verifier.issuer, audience: context.verifier.audience, maxSessionMs: 900000,
    verify() { throw Error('FICTIONAL_PRIVATE_CREDENTIAL_DETAIL'); } };
  assert.throws(() => authorize(context.state, context.credential, throwing, null, at), error => {
    assert.ok(error instanceof SecurityError); assert.equal(error.code, 'INVALID_CREDENTIAL');
    assert.doesNotMatch(String(error), /FICTIONAL_PRIVATE|eyJ/); assert.equal(Object.hasOwn(error, 'cause'), false); return true;
  });
});
