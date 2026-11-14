import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSecurityFixture } from '../fixtures/security-fiction.ts';
import { ingestArticles, sourceId } from '../src/ingestion/ingest.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import type { State } from '../src/newsroom/model.ts';
import { AccessControl } from '../src/security/service.ts';
import { AssignedResourcePolicy, type ResourceAssignment, type ResourcePolicy } from '../src/security/resources.ts';
import { AuthenticatedSourceReview } from '../src/security/source-review.ts';
import { SecurityError } from '../src/security/verifier.ts';
import type { Permission, TrustedSessionVerifier } from '../src/security/types.ts';

const at = '2026-06-01T12:00:00.000Z';
const privateValue = 'FICTIONAL_PRIVATE_REVIEW_RACE_30e7';
const sourcePermissions: Permission[] = ['SOURCE_READ', 'SOURCE_REVIEW', 'SOURCE_RESOLVE', 'SOURCE_HOLD', 'SOURCE_RELEASE'];
type SecurityFixture = Awaited<ReturnType<typeof seedSecurityFixture>>;
interface Fixture {
  repository: JsonRepository; security: SecurityFixture; access: AccessControl; verifier: TrustedSessionVerifier;
  clock: { now: string }; hooks: { beforeCommit?: () => void; rejectCredentials?: boolean };
  ids: { target: string; evidence: string }; grants: ResourceAssignment[];
  policy: { current: AssignedResourcePolicy }; resourcePolicy: ResourcePolicy;
  workflow(repository?: JsonRepository, policy?: ResourcePolicy): AuthenticatedSourceReview;
  secondManager: { identityId: string; credential: string };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
class PausedWriteRepository extends JsonRepository {
  readonly reached = deferred(); readonly released = deferred(); private armed = false;
  arm() { this.armed = true; }
  override async transactGuarded<T>(change: (state: State) => T, guard: (state: State) => void): Promise<T> {
    if (this.armed) { this.armed = false; this.reached.resolve(); await this.released.promise; }
    return super.transactGuarded(change, guard);
  }
}
class PausedFinalReadRepository extends JsonRepository {
  readonly reached = deferred(); readonly released = deferred(); private armed = false;
  arm() { this.armed = true; }
  override async readGuarded<T>(read: (state: State) => T): Promise<T> {
    if (this.armed) { this.armed = false; this.reached.resolve(); await this.released.promise; }
    return super.readGuarded(read);
  }
}
async function fixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-review-races-'));
  try {
    const hooks: Fixture['hooks'] = {}, clock = { now: at };
    const repository = new JsonRepository(join(directory, 'fictional.json'), { beforeCommit: () => hooks.beforeCommit?.() });
    const security = await seedSecurityFixture(repository, at);
    const verifier: TrustedSessionVerifier = { issuer: security.verifier.issuer, audience: security.verifier.audience,
      maxSessionMs: security.verifier.maxSessionMs, verify(value) {
        if (hooks.rejectCredentials) throw Error(privateValue); return security.verifier.verify(value);
      } };
    const access = new AccessControl(repository, { verifier, clock: () => clock.now });
    const target: ProviderArticle = { providerId: 'fictional-fixture', url: 'https://review-races.example.test/target', publisher: 'Fictional target',
      publishedAt: at, retrievedAt: at, provenance: { type: 'UNKNOWN', originId: null } };
    const evidence: ProviderArticle = { ...target, url: 'https://review-races.example.test/evidence', publisher: 'Fictional evidence', provenance: { type: 'ORIGINAL', originId: null } };
    const counts = await ingestArticles(repository, [target, evidence], { providerId: 'fictional-fixture', policyId: 'fictional-metadata-v1' },
      { dryRun: false, clock: () => at, resolutions: [{ sourceId: sourceId(evidence.url), classification: 'ORIGINAL', originId: null, at,
        actorAssertion: privateValue, reason: privateValue, evidenceReferences: [privateValue] }] });
    assert.equal(counts.processed, 1); assert.equal(counts.quarantined, 1); assert.equal(counts.failed, 0);
    await repository.transact(state => { state.sources.find(row => row.id === sourceId(evidence.url))!.verification = 'VERIFIED'; });
    const extra = structuredClone(security.accounts.managing.identity); extra.id = randomUUID(); extra.provider.subject = randomUUID();
    const claims = { ...security.accounts.managing.claims, subject: extra.provider.subject, sessionId: randomUUID() };
    const credential = security.verifier.issue(claims);
    await repository.transact(state => { state.identities.push(extra); }); await access.registerSession(credential);
    const ids = { target: sourceId(target.url), evidence: sourceId(evidence.url) };
    const grants: ResourceAssignment[] = [...Object.values(security.accounts).map(account => account.identity.id), extra.id]
      .flatMap(identityId => Object.values(ids).flatMap(id => sourcePermissions.map(permission => ({ identityId, permission, kind: 'SOURCE' as const, id }))));
    const policy = { current: new AssignedResourcePolicy(grants) };
    const resourcePolicy: ResourcePolicy = { sourceReadRevision: () => policy.current.sourceReadRevision(),
      authorize: (...args) => policy.current.authorize(...args) };
    await run({ repository, security, access, verifier, clock, hooks, ids, grants, policy, resourcePolicy,
      workflow(sourceRepository = repository, sourcePolicy = resourcePolicy) {
        return new AuthenticatedSourceReview(sourceRepository,
          new AccessControl(sourceRepository, { verifier, clock: () => clock.now }), { resourcePolicy: sourcePolicy });
      }, secondManager: { identityId: extra.id, credential } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function denied(expected: string) { return (error: unknown) => {
  assert.ok(error instanceof SecurityError); assert.equal(error.code, expected); assert.equal(error.message, expected);
  assert.doesNotMatch(JSON.stringify(error), /FICTIONAL_PRIVATE|review-races|fictional\.json|dayline-source-review/); return true;
}; }
async function beginInput(f: Fixture) {
  return { revision: (await f.workflow().inspect(f.security.accounts.editor.credential, f.ids.target)).revision,
    reasonCode: 'INITIAL_REVIEW' as const, evidenceReferences: [f.ids.evidence] };
}
async function propose(f: Fixture) {
  const workflow = f.workflow(), credential = f.security.accounts.editor.credential;
  await workflow.begin(credential, f.ids.target, await beginInput(f));
  const current = await workflow.inspect(credential, f.ids.target);
  return workflow.propose(credential, f.ids.target,
    { revision: current.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence], classification: 'ORIGINAL', originId: null });
}
function decision(f: Fixture, revision: string) { return { revision, reasonCode: 'EVIDENCE_SUPPORTED' as const, evidenceReferences: [f.ids.evidence] }; }
async function rollback(f: Fixture, run: () => Promise<unknown>, expected: string) {
  const before = await readFile(f.repository.file, 'utf8');
  await assert.rejects(run(), denied(expected));
  assert.equal(await readFile(f.repository.file, 'utf8'), before, 'failed guarded commit must preserve bytes and success receipts');
}

test('a post-sync storage fault atomically rolls back source promotion, review history and success receipts', async () => fixture(async f => {
  const proposed = await propose(f);
  f.hooks.beforeCommit = () => { throw Error(privateValue + ' private/path/fictional.json'); };
  await rollback(f, () => f.workflow().confirm(f.security.accounts.managing.credential, f.ids.target, decision(f, proposed.revision)), 'STORAGE_UNAVAILABLE');
}));

test('a session expiring after candidate serialization cannot commit a provenance decision', async () => fixture(async f => {
  const proposed = await propose(f);
  f.hooks.beforeCommit = () => { f.clock.now = f.security.accounts.managing.claims.expiresAt; };
  await rollback(f, () => f.workflow().confirm(f.security.accounts.managing.credential, f.ids.target, decision(f, proposed.revision)), 'SESSION_EXPIRED');
}));

test('a target retention deadline crossed after sync rolls back the entire confirmation', async () => fixture(async f => {
  await f.repository.transact(state => { state.quarantine.find(row => row.sourceId === f.ids.target)!.deleteAt = '2026-06-01T12:00:01.000Z'; });
  const proposed = await propose(f);
  f.hooks.beforeCommit = () => { f.clock.now = '2026-06-01T12:00:01.000Z'; };
  await rollback(f, () => f.workflow().confirm(f.security.accounts.managing.credential, f.ids.target, decision(f, proposed.revision)), 'DOMAIN_REJECTED');
}));

test('an evidence retention deadline crossed at commit cannot be used for an accepted resolution', async () => fixture(async f => {
  await f.repository.transact(state => { state.managedSources.find(row => row.sourceId === f.ids.evidence)!.deleteAt = '2026-06-01T12:00:01.000Z'; });
  const proposed = await propose(f);
  f.hooks.beforeCommit = () => { f.clock.now = '2026-06-01T12:00:01.000Z'; };
  await rollback(f, () => f.workflow().confirm(f.security.accounts.managing.credential, f.ids.target, decision(f, proposed.revision)), 'DOMAIN_REJECTED');
}));

test('a separate evidence-state change at commit invalidates the complete accepted-decision snapshot', async () => fixture(async f => {
  class ChangedEvidenceRepository extends JsonRepository {
    override async transactGuarded<T>(change: (state: State) => T, guard: (state: State) => void): Promise<T> {
      return super.transactGuarded(change, state => {
        state.sources.find(row => row.id === f.ids.evidence)!.verification = 'UNVERIFIED';
        guard(state);
      });
    }
  }
  const proposed = await propose(f);
  await rollback(f, () => f.workflow(new ChangedEvidenceRepository(f.repository.file)).confirm(
    f.security.accounts.managing.credential, f.ids.target, decision(f, proposed.revision)), 'STALE_TARGET');
}));

test('resource assignment removal at the commit boundary denies the complete mutation', async () => fixture(async f => {
  const valid = await beginInput(f);
  f.hooks.beforeCommit = () => { f.policy.current = new AssignedResourcePolicy([]); };
  await rollback(f, () => f.workflow().begin(f.security.accounts.editor.credential, f.ids.target, valid), 'PERMISSION_DENIED');
}));

test('replacing identical assignments at commit changes the epoch and prevents ABA authorization reuse', async () => fixture(async f => {
  const valid = await beginInput(f);
  f.hooks.beforeCommit = () => { f.policy.current = new AssignedResourcePolicy(f.grants); };
  await rollback(f, () => f.workflow().begin(f.security.accounts.editor.credential, f.ids.target, valid), 'PERMISSION_DENIED');
}));

test('a verifier revocation that wins the final commit check denies without storing a success receipt', async () => fixture(async f => {
  const valid = await beginInput(f);
  f.hooks.beforeCommit = () => { f.hooks.rejectCredentials = true; };
  await rollback(f, () => f.workflow().begin(f.security.accounts.editor.credential, f.ids.target, valid), 'INVALID_CREDENTIAL');
}));

test('clock rollback between the operation and commit is rejected rather than creating backdated history', async () => fixture(async f => {
  const valid = await beginInput(f);
  f.clock.now = '2026-06-01T12:00:01.000Z';
  f.hooks.beforeCommit = () => { f.clock.now = at; };
  await rollback(f, () => f.workflow().begin(f.security.accounts.editor.credential, f.ids.target, valid), 'STALE_TARGET');
}));

test('two independent confirmations of one exact proposal serialize to one success', async () => fixture(async f => {
  const proposed = await propose(f), input = decision(f, proposed.revision);
  const before = await f.repository.read();
  const results = await Promise.allSettled([
    f.workflow().confirm(f.security.accounts.managing.credential, f.ids.target, input),
    f.workflow().confirm(f.secondManager.credential, f.ids.target, input),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected')!; assert.equal(rejected.status, 'rejected');
  if (rejected.status === 'rejected') denied('STALE_TARGET')(rejected.reason);
  const after = await f.repository.read();
  assert.equal(after.provenanceDecisions.filter(row => row.sourceId === f.ids.target).length, 1);
  assert.equal(after.sources.filter(row => row.id === f.ids.target).length, 1);
  assert.equal(after.authenticatedActions.length, before.authenticatedActions.length + 1);
  assert.equal(after.sourceReviews!.length, before.sourceReviews!.length + 1);
}));

test('two simultaneous recommendations cannot overwrite each other at one exact revision', async () => fixture(async f => {
  const workflow = f.workflow(), credential = f.security.accounts.editor.credential;
  await workflow.begin(credential, f.ids.target, await beginInput(f));
  const current = await workflow.inspect(credential, f.ids.target);
  const proposal = { revision: current.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [f.ids.evidence], classification: 'ORIGINAL', originId: null };
  const before = await f.repository.read();
  const results = await Promise.allSettled([workflow.propose(credential, f.ids.target, proposal), workflow.propose(f.security.accounts.managing.credential, f.ids.target, proposal)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected')!;
  if (rejected.status === 'rejected') denied('STALE_TARGET')(rejected.reason);
  const after = await f.repository.read();
  assert.deepEqual(after.sources, before.sources); assert.deepEqual(after.quarantine, before.quarantine);
  assert.equal(after.sourceReviews!.length, before.sourceReviews!.length + 1);
}));

test('a durable session revocation committed before the pending write wins authorization', async () => fixture(async f => {
  const paused = new PausedWriteRepository(f.repository.file), workflow = f.workflow(paused), valid = await beginInput(f);
  paused.arm();
  const pending = workflow.begin(f.security.accounts.editor.credential, f.ids.target, valid);
  const rejected = assert.rejects(pending, denied('SESSION_REVOKED'));
  await paused.reached.promise;
  await f.access.invalidateSession(f.security.accounts.editor.credential);
  const afterRevocation = await readFile(f.repository.file, 'utf8');
  paused.released.resolve(); await rejected;
  assert.equal(await readFile(f.repository.file, 'utf8'), afterRevocation);
}));

for (const [name, code, change] of [
  ['identity disablement', 'IDENTITY_DISABLED', (f: Fixture) => f.access.setStatus(f.security.accounts.admin.credential, f.security.accounts.editor.identity.id, 1, 'DISABLED')],
  ['role demotion', 'PERMISSION_DENIED', (f: Fixture) => f.access.setRoles(f.security.accounts.admin.credential, f.security.accounts.editor.identity.id, 1, ['REPORTER'])],
  ['credential rotation', 'INVALID_SESSION', (f: Fixture) => f.access.rotateCredentials(f.security.accounts.admin.credential, f.security.accounts.editor.identity.id, 1)],
] as const) test(`in-flight ${name} committed before the guarded source write denies the stale actor`, async () => fixture(async f => {
  const paused = new PausedWriteRepository(f.repository.file), valid = await beginInput(f); paused.arm();
  const pending = f.workflow(paused).begin(f.security.accounts.editor.credential, f.ids.target, valid);
  const rejected = assert.rejects(pending, denied(code));
  await paused.reached.promise; await change(f);
  const afterChange = await readFile(f.repository.file, 'utf8');
  paused.released.resolve(); await rejected;
  assert.equal(await readFile(f.repository.file, 'utf8'), afterChange);
}));

test('a competing hold committed before confirmation makes the old proposal stale', async () => fixture(async f => {
  const proposed = await propose(f), paused = new PausedWriteRepository(f.repository.file); paused.arm();
  const pending = f.workflow(paused).confirm(f.security.accounts.managing.credential, f.ids.target, decision(f, proposed.revision));
  const rejected = assert.rejects(pending, denied('STALE_TARGET'));
  await paused.reached.promise;
  await f.workflow().hold(f.security.accounts.editor.credential, f.ids.target,
    { revision: proposed.revision, reasonCode: 'REVIEW_HOLD', evidenceReferences: [f.ids.evidence] });
  const afterHold = await readFile(f.repository.file, 'utf8');
  paused.released.resolve(); await rejected;
  assert.equal(await readFile(f.repository.file, 'utf8'), afterHold);
  assert.equal((await f.workflow().inspect(f.security.accounts.managing.credential, f.ids.target)).status, 'ON_HOLD');
}));

test('policy replacement while waiting for the write lock is not restored by identical grants', async () => fixture(async f => {
  const valid = await beginInput(f), paused = new PausedWriteRepository(f.repository.file); paused.arm();
  const pending = f.workflow(paused).begin(f.security.accounts.editor.credential, f.ids.target, valid);
  const rejected = assert.rejects(pending, denied('PERMISSION_DENIED'));
  await paused.reached.promise; f.policy.current = new AssignedResourcePolicy(f.grants);
  const before = await readFile(f.repository.file, 'utf8');
  paused.released.resolve(); await rejected;
  assert.equal(await readFile(f.repository.file, 'utf8'), before);
}));

test('in-flight inspection observes revocation before guarded disclosure and sends no status', async () => fixture(async f => {
  const paused = new PausedFinalReadRepository(f.repository.file); let disclosures = 0; paused.arm();
  const pending = f.workflow(paused).withSummary(f.security.accounts.editor.credential, f.ids.target, () => { disclosures++; });
  const rejected = assert.rejects(pending, denied('SESSION_REVOKED'));
  await paused.reached.promise; await f.access.invalidateSession(f.security.accounts.editor.credential);
  paused.released.resolve(); await rejected;
  assert.equal(disclosures, 0);
}));

test('policy replacement during final status serialization prevents any synchronous disclosure', async () => fixture(async f => {
  const stringify = JSON.stringify; let changed = false, disclosures = 0;
  JSON.stringify = function (value: unknown, ...args: unknown[]) {
    const result = Reflect.apply(stringify, JSON, [value, ...args]);
    if (!changed && value && typeof value === 'object' && Object.hasOwn(value, 'reviewAllowed') && Object.hasOwn(value, 'revision')) {
      changed = true; f.policy.current = new AssignedResourcePolicy([]);
    }
    return result;
  } as typeof JSON.stringify;
  try {
    await assert.rejects(f.workflow().withSummary(f.security.accounts.editor.credential, f.ids.target, () => { disclosures++; }), denied('PERMISSION_DENIED'));
    assert.equal(changed, true); assert.equal(disclosures, 0);
  } finally { JSON.stringify = stringify; }
}));

test('an accepted proof-source assignment revoked during final serialization prevents detailed disclosure', async () => fixture(async f => {
  const proposed = await propose(f);
  await f.workflow().confirm(f.security.accounts.managing.credential, f.ids.target, decision(f, proposed.revision));
  const before = await readFile(f.repository.file, 'utf8');
  const stringify = JSON.stringify; let summaries = 0, changed = false, disclosures = 0;
  JSON.stringify = function (value: unknown, ...args: unknown[]) {
    const result = Reflect.apply(stringify, JSON, [value, ...args]);
    if (value && typeof value === 'object' && Object.hasOwn(value, 'reviewAllowed')
      && Object.hasOwn(value, 'reviewRevision') && (value as { status?: unknown }).status === 'RESOLVED') {
      summaries++;
      if (summaries === 2) {
        changed = true;
        f.policy.current = new AssignedResourcePolicy(f.grants.filter(row => !(row.identityId === f.security.accounts.editor.identity.id
          && row.permission === 'SOURCE_READ' && row.id === f.ids.evidence)));
      }
    }
    return result;
  } as typeof JSON.stringify;
  try {
    await assert.rejects(f.workflow().withSummary(f.security.accounts.editor.credential, f.ids.target,
      () => { disclosures++; }), denied('PERMISSION_DENIED'));
    assert.equal(changed, true); assert.equal(disclosures, 0);
  } finally { JSON.stringify = stringify; }
  await assert.rejects(f.workflow().inspect(f.security.accounts.editor.credential, f.ids.target), denied('PERMISSION_DENIED'));
  assert.equal(await readFile(f.repository.file, 'utf8'), before);
}));

test('retention expiry crossed inside final recompute serialization discloses no earlier valid review summary', async () => fixture(async f => {
  const deadline = '2026-06-01T12:00:01.000Z';
  await f.repository.transact(state => { state.quarantine.find(row => row.sourceId === f.ids.target)!.deleteAt = deadline; });
  const stringify = JSON.stringify; let seen = 0, changed = false, disclosures = 0;
  JSON.stringify = function (value: unknown, ...args: unknown[]) {
    const result = Reflect.apply(stringify, JSON, [value, ...args]);
    if (value && typeof value === 'object' && Object.hasOwn(value, 'reviewAllowed') && Object.hasOwn(value, 'revision')) {
      seen++;
      if (seen === 2) { changed = true; f.clock.now = deadline; }
    }
    return result;
  } as typeof JSON.stringify;
  try {
    await assert.rejects(f.workflow().withSummary(f.security.accounts.editor.credential, f.ids.target, () => { disclosures++; }), denied('STALE_TARGET'));
    assert.equal(changed, true); assert.equal(disclosures, 0);
    assert.ok(Date.parse(f.clock.now) < Date.parse(f.security.accounts.editor.claims.expiresAt));
  } finally { JSON.stringify = stringify; }
}));

test('declared async disclosure callbacks are rejected before receiving review metadata', async () => fixture(async f => {
  let invoked = false;
  await assert.rejects(f.workflow().withSummary(f.security.accounts.editor.credential, f.ids.target,
    async () => { invoked = true; }), denied('DOMAIN_REJECTED'));
  assert.equal(invoked, false);
}));

test('trusted policy decisions cannot use asynchronous or non-void results as source authorization', async () => fixture(async f => {
  const valid = await beginInput(f);
  for (const authorize of [async () => undefined, () => true, () => Promise.reject(Error(privateValue))]) {
    const policy: ResourcePolicy = { sourceReadRevision: () => f.policy.current.sourceReadRevision(), authorize };
    await rollback(f, () => f.workflow(f.repository, policy).begin(f.security.accounts.editor.credential, f.ids.target, valid), 'PERMISSION_DENIED');
  }
}));

test('unavailable repository failures are reconstructed without private causes or supplied error fields', async () => fixture(async f => {
  class BrokenRepository extends JsonRepository {
    override async read(): Promise<State> { throw Object.assign(Error(privateValue), { cause: Error('private/path'), credential: privateValue }); }
  }
  let disclosures = 0;
  await assert.rejects(f.workflow(new BrokenRepository(f.repository.file)).withSummary(f.security.accounts.editor.credential, f.ids.target,
    () => { disclosures++; }), denied('STORAGE_UNAVAILABLE'));
  assert.equal(disclosures, 0);
}));
