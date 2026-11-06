import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../src/newsroom/store.ts';
import { emptyState, type State } from '../src/newsroom/model.ts';
import type { IdentityRecord, SessionRecord, SecurityEvent, AuthenticatedAction } from '../src/security/types.ts';

const at = '2026-06-01T12:00:00.000Z';
const issuer = 'urn:dayline:synthetic';
function identity(): IdentityRecord {
  return { id: 'usr_fixture_0001', status: 'DISABLED', roles: [], provider: { issuer, subject: 'subject_fixture_0001' }, revision: 3, credentialVersion: 2, credentialsRotatedAt: at, createdAt: '2026-06-01T11:00:00.000Z', updatedAt: at };
}
function session(): SessionRecord {
  return { id: 'session_fixture_0001', auditRef: 'sref_fixture_0001', userId: identity().id, issuer, audience: 'dayline-editorial-fixture', keyId: 'synthetic-local-v1', credentialVersion: 1, authenticatedAt: '2026-06-01T11:30:00.000Z', notBefore: '2026-06-01T11:30:00.000Z', expiresAt: '2026-06-01T13:00:00.000Z', revokedAt: null };
}
function event(): SecurityEvent {
  return { id: 'evt_fixture_0001', at, category: 'PROTECTED_ACTION', code: 'SUCCESS', userRef: identity().id, sessionRef: session().auditRef, subjectRef: null, permission: 'STORY_EDIT' };
}
function action(): AuthenticatedAction {
  return { id: 'act_fixture_0001', actorId: identity().id, identityRevision: 1, sessionRef: session().auditRef, permission: 'STORY_EDIT', resourceKind: 'STORY', resourceId: 'legacy story: 42', resourceVersion: 3, at };
}
function state(): State {
  return { ...emptyState(), identities: [identity()], sessions: [session()], securityAudit: [event()], authenticatedActions: [action()] };
}
async function fixture(change: (repo: JsonRepository, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-security-storage-'));
  try { await change(new JsonRepository(join(directory, 'fictional.json')), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function rejected(repo: JsonRepository, directory: string, values: unknown[]) {
  for (const value of values) {
    const bytes = JSON.stringify(value);
    await writeFile(repo.file, bytes);
    await assert.rejects(repo.read(), /Invalid repository format/);
    await assert.rejects(repo.transact(() => undefined), /Invalid repository format/);
    assert.equal(await readFile(repo.file, 'utf8'), bytes);
    assert.deepEqual(await readdir(directory), ['fictional.json']);
  }
}
const withIdentity = (row: unknown): unknown => ({ ...emptyState(), identities: [row] });
const withSession = (row: unknown): unknown => ({ ...state(), sessions: [row] });

test('schema 7 preserves bounded historical security metadata without reviving roles or credential versions', async () => fixture(async repo => {
  const original = state(), bytes = JSON.stringify(original, null, 2) + '\n';
  await writeFile(repo.file, bytes);
  assert.deepEqual(await repo.read(), original);
  assert.equal(await readFile(repo.file, 'utf8'), bytes);
  await repo.transact(() => undefined);
  const saved = await repo.read();
  assert.deepEqual(saved, original);
  assert.equal(saved.identities[0].status, 'DISABLED');
  assert.deepEqual(saved.identities[0].roles, []);
  assert.equal(saved.sessions[0].credentialVersion, 1);
  assert.equal(saved.authenticatedActions[0].identityRevision, 1);
  assert.deepEqual(saved.approvals, []);
  assert.deepEqual(saved.editionReviews, []);
  const detached = await repo.read();
  detached.identities[0].roles.push('ADMINISTRATOR'); detached.sessions[0].revokedAt = at;
  assert.deepEqual(await repo.read(), original);
  // Historical opaque receipts need not retain a now-pruned session or actor record.
  const historical = { ...original, identities: [], sessions: [] };
  await writeFile(repo.file, JSON.stringify(historical));
  assert.deepEqual(await repo.read(), historical);
}));

test('identity records reject credentials, ambiguous provider subjects and invalid role or version metadata', async () => fixture(async (repo, directory) => {
  const row = identity();
  const invalid: unknown[] = [
    ...['short', 'name@example.test', 'x'.repeat(129), 'Bearer fixture'].map(id => ({ ...row, id })),
    { ...row, roles: ['PUBLISHER'] }, { ...row, roles: ['EDITOR', 'EDITOR'] }, { ...row, roles: 'ADMINISTRATOR' },
    { ...row, status: 'APPROVED' }, { ...row, revision: 0 }, { ...row, revision: 1.5 }, { ...row, credentialVersion: 0 },
    { ...row, createdAt: '2026-02-30T00:00:00Z' }, { ...row, credentialsRotatedAt: 'not-a-date' },
    { ...row, password: 'FICTIONAL_NOT_A_CREDENTIAL' }, { ...row, token: 'FICTIONAL_NOT_A_TOKEN' },
    { ...row, provider: { ...row.provider, secret: 'FICTIONAL_NOT_A_SECRET' } },
    ...['person@example.test', 'short', 'x'.repeat(129)].map(subject => ({ ...row, provider: { ...row.provider, subject } })),
    ...['https://user:fixture@auth.example.test/issuer', 'https://auth.example.test/?token=fixture', 'https://auth.example.test/#fixture', 'urn:dayline:synthetic?key=fixture', 'Bearer fixture'].map(issuer => ({ ...row, provider: { ...row.provider, issuer } }))
  ];
  await rejected(repo, directory, invalid.map(withIdentity));
  const independentProvider = { ...row, provider: { issuer: 'https://auth.example.test/issuer', subject: 'opaque_provider_subject' } };
  await writeFile(repo.file, JSON.stringify(withIdentity(independentProvider)));
  assert.deepEqual((await repo.read()).identities, [independentProvider]);
}));

test('session records contain metadata only and reject invalid validity windows or issuer/version mismatches', async () => fixture(async (repo, directory) => {
  const row = session();
  const invalid: unknown[] = [
    { ...row, credential: 'FICTIONAL_NOT_A_BEARER' }, { ...row, signature: 'FICTIONAL_NOT_A_SIGNATURE' }, { ...row, cookie: 'FICTIONAL_NOT_A_COOKIE' },
    { ...row, authenticatedAt: '2026-06-01T12:00:00Z', notBefore: '2026-06-01T11:30:00Z' }, { ...row, expiresAt: row.notBefore },
    { ...row, revokedAt: '2026-06-01T11:00:00Z' }, { ...row, expiresAt: '2026-02-30T12:00:00Z' },
    { ...row, auditRef: 'short' }, { ...row, keyId: 'x'.repeat(65) }, { ...row, audience: 'Bearer fixture' },
    { ...row, audience: 'https://aud.example.test/?secret=fixture' }, { ...row, issuer: 'urn:dayline:different' },
    { ...row, credentialVersion: 3 }
  ];
  await rejected(repo, directory, invalid.map(withSession));
}));

test('security events and authenticated actions accept only fixed metadata fields and known permissions', async () => fixture(async (repo, directory) => {
  const audit = event(), receipt = action();
  const invalid: unknown[] = [
    ...[{ ...audit, category: 'PUBLISHED' }, { ...audit, code: 'PRIVATE_PROVIDER_ERROR' }, { ...audit, permission: 'PUBLISH' }, { ...audit, userRef: 'person@example.test' }, { ...audit, subjectRef: 'private source prose' }, { ...audit, rawCredential: 'FICTIONAL_NOT_A_TOKEN' }, { ...audit, at: '2026-02-30T00:00:00Z' }].map(row => ({ ...state(), securityAudit: [row] })),
    ...[{ ...receipt, permission: 'PUBLISH' }, { ...receipt, resourceKind: 'NEWS_CONTENT' }, { ...receipt, resourceId: 'x'.repeat(257) }, { ...receipt, resourceId: ' ' }, { ...receipt, resourceVersion: 0 }, { ...receipt, resourceVersion: 1.5 }, { ...receipt, identityRevision: 4 }, { ...receipt, summary: 'Fictional prose must not enter security bookkeeping' }, { ...receipt, approved: true }].map(row => ({ ...state(), authenticatedActions: [row] }))
  ];
  await rejected(repo, directory, invalid);
}));

test('security identities, provider bindings, sessions and audit references stay unique and bounded', async () => fixture(async (repo, directory) => {
  const original = state(), user = identity(), login = session();
  const other = { ...user, id: 'usr_fixture_0002', provider: { ...user.provider, subject: 'subject_fixture_0002' } };
  await rejected(repo, directory, [
    { ...original, identities: [user, user] }, { ...original, identities: [user, { ...other, provider: user.provider }] },
    { ...original, sessions: [login, login] }, { ...original, sessions: [login, { ...login, id: 'session_fixture_0002' }] },
    { ...original, securityAudit: [event(), event()] }, { ...original, authenticatedActions: [action(), action()] },
    { ...original, identities: [user, other], authenticatedActions: [{ ...action(), actorId: other.id }] },
    { ...original, securityAudit: [{ ...event(), userRef: other.id }] },
    { ...emptyState(), identities: Array.from({ length: 129 }, (_, index) => ({ ...user, id: `usr_fixture_${index}`, provider: { issuer, subject: `subject_fixture_${index}` } })) },
    { ...original, sessions: Array.from({ length: 513 }, (_, index) => ({ ...login, id: `session_fixture_${index}`, auditRef: `sref_fixture_${index}` })) },
    { ...original, securityAudit: Array.from({ length: 513 }, (_, index) => ({ ...event(), id: `event_fixture_${index}` })) },
    { ...original, authenticatedActions: Array.from({ length: 513 }, (_, index) => ({ ...action(), id: `action_fixture_${index}` })) }
  ]);
}));

test('security guards reject hidden fields, sparse roles and accessors before evaluating them', async () => fixture(async (repo, directory) => {
  const bytes = JSON.stringify(emptyState()); await writeFile(repo.file, bytes);
  let evaluated = false;
  await assert.rejects(repo.transact(value => {
    const user = identity();
    Object.defineProperty(user.provider, 'subject', { enumerable: true, configurable: true, get: () => { evaluated = true; return 'subject_fixture_0001'; } });
    value.identities.push(user);
  }), /Invalid repository format/);
  assert.equal(evaluated, false);
  await assert.rejects(repo.transact(value => {
    const user = identity(); Object.defineProperty(user, 'privateKey', { value: 'FICTIONAL_NOT_A_KEY', enumerable: false }); value.identities.push(user);
  }), /Invalid repository format/);
  await assert.rejects(repo.transact(value => {
    const user = identity(); user.roles.length = 1; value.identities.push(user);
  }), /Invalid repository format/);
  assert.equal(await readFile(repo.file, 'utf8'), bytes);
  assert.deepEqual(await readdir(directory), ['fictional.json']);
}));

test('guarded transactions run the commit guard after synced staging and the global hook, before replacement', async () => fixture(async (repo, directory) => {
  const bytes = JSON.stringify(emptyState(), null, 2) + '\n'; await writeFile(repo.file, bytes);
  const order: string[] = [];
  const guarded = new JsonRepository(repo.file, { beforeCommit: () => {
    order.push('hook'); assert.equal(readFileSync(repo.file, 'utf8'), bytes);
    const temps = readdirSync(directory).filter(name => name.endsWith('.tmp')); assert.equal(temps.length, 1);
    assert.equal(JSON.parse(readFileSync(join(directory, temps[0]), 'utf8')).identities[0].id, identity().id);
  } });
  const result = await guarded.transactGuarded(value => { order.push('change'); value.identities.push(identity()); return value.identities[0]; }, candidate => {
    order.push('guard'); assert.equal(candidate.identities[0].id, identity().id); assert.equal(readFileSync(repo.file, 'utf8'), bytes);
  });
  assert.deepEqual(order, ['change', 'hook', 'guard']);
  assert.equal((await repo.read()).identities.length, 1);
  result.roles.push('ADMINISTRATOR'); assert.deepEqual((await repo.read()).identities[0].roles, []);
  assert.deepEqual(await readdir(directory), ['fictional.json']);
}));

test('authorization revoked by the global pre-commit hook rolls back all security and domain changes', async () => fixture(async (repo, directory) => {
  const { identities: _newIdentities, sessions: _newSessions, securityAudit: _newAudit, authenticatedActions: _newActions, ...legacy } = emptyState();
  const bytes = JSON.stringify({ ...legacy, schema: 6 }, null, 2) + '\n'; await writeFile(repo.file, bytes);
  const denied = new Error('Synthetic commit authorization denied');
  let authorized = true, hooks = 0, guards = 0;
  const guarded = new JsonRepository(repo.file, { beforeCommit: () => { if (++hooks === 1) authorized = false; } });
  const change = (value: State) => {
    const security = state(); value.identities = security.identities; value.sessions = security.sessions; value.securityAudit = security.securityAudit; value.authenticatedActions = security.authenticatedActions;
    value.audit.push({ id: 'fictional-domain-event', storyId: null, action: 'STORY_EDITED', actor: 'fixture', at, version: null });
    return value.identities[0];
  };
  const guard = () => { guards++; if (!authorized) throw denied; };
  await assert.rejects(guarded.transactGuarded(change, guard), error => error === denied);
  assert.equal(await readFile(repo.file, 'utf8'), bytes);
  assert.deepEqual((await repo.read()).identities, []); assert.deepEqual((await repo.read()).audit, []);
  assert.deepEqual(await readdir(directory), ['fictional.json']);
  authorized = true; await guarded.transactGuarded(change, guard);
  const saved = await repo.read();
  assert.equal(hooks, 2); assert.equal(guards, 2); assert.equal(saved.schema, 7);
  assert.equal(saved.identities.length, 1); assert.equal(saved.sessions.length, 1); assert.equal(saved.securityAudit.length, 1); assert.equal(saved.authenticatedActions.length, 1); assert.equal(saved.audit.length, 1);
  assert.deepEqual(await readdir(directory), ['fictional.json']);
}));

test('a global staging failure or uncloneable result cannot bypass or partially run the commit guard', async () => fixture(async (repo, directory) => {
  const bytes = JSON.stringify(emptyState()); await writeFile(repo.file, bytes);
  let guards = 0;
  const failing = new JsonRepository(repo.file, { beforeCommit: () => { throw Error('Synthetic staging failure'); } });
  await assert.rejects(failing.transactGuarded(value => { value.identities.push(identity()); }, () => { guards++; }), /Synthetic staging failure/);
  await assert.rejects(repo.transactGuarded(value => { value.identities.push(identity()); return () => 'Uncloneable fixture'; }, () => { guards++; }), { name: 'DataCloneError' });
  assert.equal(guards, 0); assert.equal(await readFile(repo.file, 'utf8'), bytes);
  assert.deepEqual(await readdir(directory), ['fictional.json']);
}));

test('missing, boolean-returning and async commit guards fail closed without leaking rejected promises', async () => fixture(async (repo, directory) => {
  const bytes = JSON.stringify(emptyState()); await writeFile(repo.file, bytes);
  const change = (value: State) => { value.identities.push(identity()); };
  await assert.rejects(repo.transactGuarded(change, undefined as unknown as () => void), /guard is required/);
  await assert.rejects(repo.transactGuarded(change, () => false), /guard must be synchronous/);
  await assert.rejects(repo.transactGuarded(change, async () => { throw Error('Synthetic async denial'); }), /guard must be synchronous/);
  await assert.rejects(repo.transactGuarded(change, async () => undefined), /guard must be synchronous/);
  assert.equal(await readFile(repo.file, 'utf8'), bytes);
  assert.deepEqual(await readdir(directory), ['fictional.json']);
  await repo.transactGuarded(change, () => undefined);
  assert.equal((await repo.read()).identities.length, 1);
}));
