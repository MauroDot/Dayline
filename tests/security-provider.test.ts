import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { access } from 'node:fs/promises';
import { configureIdentityVerifier, productionProviderVerifier } from '../src/security/provider.ts';
import { SyntheticSessionVerifier, SecurityError } from '../src/security/verifier.ts';
import type { VerifiedSessionClaims } from '../src/security/types.ts';
import { createEditorialHttpFixture } from '../fixtures/editorial-http-fiction.ts';

const at = '2026-06-01T12:00:00.000Z';
function configuration(verifier = new SyntheticSessionVerifier()) {
  return { enabled: true as const, mode: 'development' as const, provider: 'synthetic' as const, verifier };
}
function safe(error: unknown): boolean {
  return error instanceof SecurityError && ['INVALID_CREDENTIAL', 'PERMISSION_DENIED'].includes(error.code)
    && error.message === error.code;
}
function claims(verifier: SyntheticSessionVerifier): VerifiedSessionClaims {
  return { issuer: verifier.issuer, audience: verifier.audience, subject: 'subject_fixture_one', sessionId: 'session_fixture_one',
    keyId: 'synthetic-local-v1', credentialVersion: 1, authenticatedAt: at, notBefore: at,
    expiresAt: '2026-06-01T12:15:00.000Z' };
}

test('provider configuration is explicit, verification-only and disabled by default', () => {
  assert.throws(() => configureIdentityVerifier(), safe);
  assert.throws(() => configureIdentityVerifier({}), safe);
  const raw = new SyntheticSessionVerifier(), provider = configureIdentityVerifier(configuration(raw));
  assert.equal(Object.isFrozen(provider), true);
  assert.deepEqual(Object.keys(provider).sort(), ['audience', 'issuer', 'maxSessionMs', 'verify']);
  assert.deepEqual(provider.verify(raw.issue(claims(raw))), claims(raw));
});

test('unknown providers, injected verifier objects and subclasses are rejected without invoking caller code', () => {
  let invoked = false;
  const injected = { issuer: 'urn:dayline:synthetic', audience: 'dayline-editorial-fixture', maxSessionMs: 900_000,
    verify() { invoked = true; return {}; } };
  class UntrustedSubclass extends SyntheticSessionVerifier { override verify(): VerifiedSessionClaims { invoked = true; throw Error('private-provider-details'); } }
  const forged = Object.freeze(Object.assign(Object.create(SyntheticSessionVerifier.prototype), injected));
  const samples: unknown[] = [
    { ...configuration(), enabled: false }, { ...configuration(), mode: 'production' },
    { ...configuration(), provider: 'oidc' }, { ...configuration(), verifier: injected },
    { ...configuration(), verifier: new UntrustedSubclass() },
    { ...configuration(), verifier: forged },
    { ...configuration(), jwksUrl: 'https://untrusted.example.test/keys' },
  ];
  for (const value of samples) assert.throws(() => configureIdentityVerifier(value), safe);
  assert.equal(invoked, false);
});

test('provider configuration does not evaluate getter-based configuration or expose raw errors', () => {
  let invoked = false;
  const value = configuration();
  Object.defineProperty(value, 'verifier', { enumerable: true, get() { invoked = true; throw Error('sensitive-provider-secret'); } });
  assert.throws(() => configureIdentityVerifier(value), safe);
  assert.equal(invoked, false);
});

test('production provider boundary fails closed and production mode disables synthetic configuration', () => {
  assert.throws(productionProviderVerifier, safe);
  const old = process.env.NODE_ENV;
  try { process.env.NODE_ENV = 'production'; assert.throws(() => configureIdentityVerifier(configuration()), safe); }
  finally { if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old; }
});

test('configured verifier rejects wrong issuer audience key identity and tampered credentials', () => {
  const raw = new SyntheticSessionVerifier(), provider = configureIdentityVerifier(configuration(raw));
  for (const patch of [{ issuer: 'urn:untrusted:issuer' }, { audience: 'untrusted-audience' }, { keyId: 'wrong-key' }]) {
    assert.throws(() => provider.verify(raw.issue({ ...claims(raw), ...patch })), safe);
  }
  const token = raw.issue(claims(raw));
  assert.throws(() => provider.verify(token.slice(0, -3) + 'bad'), safe);
  assert.throws(() => provider.verify({ credential: token, roles: ['ADMINISTRATOR'] }), safe);
});

test('algorithm and arbitrary remote-key header fields are denied even with a valid fixture HMAC', () => {
  const key = Buffer.alloc(32, 0x29); // Public synthetic material used only for this rejection test.
  const raw = new SyntheticSessionVerifier({ key }), provider = configureIdentityVerifier(configuration(raw));
  for (const extra of [{ alg: 'none' }, { alg: 'RS256' }, { jku: 'https://untrusted.example.test/keys' }, { x5u: 'https://untrusted.example.test/cert' }]) {
    const first = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'synthetic-local-v1', ...extra })).toString('base64url');
    const second = Buffer.from(JSON.stringify(claims(raw))).toString('base64url');
    const signature = createHmac('sha256', key).update(`${first}.${second}`).digest('base64url');
    assert.throws(() => provider.verify(`${first}.${second}.${signature}`), safe);
  }
});

test('development harness requires an explicit opt-in and cannot start in production', async () => {
  await assert.rejects(createEditorialHttpFixture(), safe);
  await assert.rejects(createEditorialHttpFixture({ enabled: true, mode: 'test' }), safe);
  const old = process.env.NODE_ENV;
  try { process.env.NODE_ENV = 'production'; await assert.rejects(createEditorialHttpFixture({ enabled: true, mode: 'development' }), safe); }
  finally { if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old; }
});

test('temporary harness stores only synthetic metadata and disposes its temporary repository', async () => {
  const fixture = await createEditorialHttpFixture({ enabled: true, mode: 'development' });
  try {
    const state = await fixture.repository.read(), serialized = JSON.stringify(state);
    assert.equal(state.identities.length, 4); assert.equal(state.sessions.length, 4);
    for (const value of Object.values(fixture.accounts)) assert.equal(serialized.includes(value.credential), false);
    assert.equal(fixture.stories.review.status, 'NEEDS_REVIEW'); assert.equal(fixture.stories.approved.status, 'APPROVED');
    assert.equal(fixture.run.status, 'SCHEDULED'); assert.equal(fixture.edition.status, 'ASSEMBLING');
    assert.equal(state.revisions.some(story => story.status === 'PUBLISHED'), false);
  } finally { await fixture.dispose(); }
  await assert.rejects(access(fixture.directory));
});

test('independent harnesses use distinct signing keys and cannot verify one another credentials', async () => {
  const first = await createEditorialHttpFixture({ enabled: true, mode: 'development' });
  const second = await createEditorialHttpFixture({ enabled: true, mode: 'development' });
  try {
    assert.throws(() => first.provider.verify(second.accounts.editor.credential), safe);
    assert.throws(() => second.provider.verify(first.accounts.editor.credential), safe);
    assert.notEqual(first.repository.file, second.repository.file);
  } finally { await first.dispose(); await second.dispose(); }
});

test('default fixture time advances monotonically and consumes the bounded synthetic session lifetime', async () => {
  const fixture = await createEditorialHttpFixture({ enabled: true, mode: 'development' });
  try {
    const before = Date.parse(fixture.access.now());
    const expires = Date.parse(fixture.accounts.reporter.claims.expiresAt);
    await new Promise(resolve => setTimeout(resolve, 25));
    const after = Date.parse(fixture.access.now());
    assert.ok(after > before, 'default fixture clock must advance without an injected clock');
    assert.ok(expires - after < expires - before, 'remaining session lifetime must decrease');
    assert.equal(expires - Date.parse(fixture.accounts.reporter.claims.authenticatedAt), fixture.verifier.maxSessionMs);
  } finally { await fixture.dispose(); }
});

test('registered synthetic identity still requires current roles session expiry and credential version', async () => {
  const time = { now: at };
  const fixture = await createEditorialHttpFixture({ enabled: true, mode: 'development', clock: () => time.now });
  try {
    const value = fixture.accounts.managing, state = await fixture.repository.read();
    assert.equal(fixture.access.authorizeInState(state, value.credential, 'STORY_APPROVE', time.now).identityId, value.identity.id);
    const identity = state.identities.find(row => row.id === value.identity.id)!;
    identity.roles = ['REPORTER'];
    assert.throws(() => fixture.access.authorizeInState(state, value.credential, 'STORY_APPROVE', time.now), safe);
    identity.roles = ['MANAGING_EDITOR']; identity.credentialVersion++;
    assert.throws(() => fixture.access.authorizeInState(state, value.credential, null, time.now), { code: 'INVALID_SESSION' });
    identity.credentialVersion--;
    time.now = value.claims.expiresAt;
    assert.throws(() => fixture.access.authorizeInState(state, value.credential, null, time.now), { code: 'SESSION_EXPIRED' });
  } finally { await fixture.dispose(); }
});
