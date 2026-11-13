import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSecurityFixture, securityAt } from '../fixtures/security-fiction.ts';
import { seedSourceQueueFixture } from '../fixtures/source-queue-fiction.ts';
import { sourceId } from '../src/ingestion/ingest.ts';
import type { State } from '../src/newsroom/model.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { AccessControl } from '../src/security/service.ts';
import { AuthenticatedSourceQueue } from '../src/security/source.ts';
import { AssignedResourcePolicy, type ResourcePolicy } from '../src/security/resources.ts';
import { SecurityError } from '../src/security/verifier.ts';
import { SourceQueueError } from '../src/source-queue/service.ts';
import type { SourceQueuePage } from '../src/source-queue/types.ts';

const privateValue = 'FICTIONAL_PRIVATE_SOURCE_RACE_903f';
const originalId = sourceId('https://source-queue.example.test/original');
const copyId = sourceId('https://source-queue.example.test/copy');
const newId = sourceId('https://source-queue.example.test/new');
type SecurityFixture = Awaited<ReturnType<typeof seedSecurityFixture>>;
type Fixture = { repository: JsonRepository; security: SecurityFixture; time: { now: string }; access: AccessControl };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Pause exactly one completed asynchronous snapshot, before the final guarded read. */
class PausedSnapshotRepository extends JsonRepository {
  readonly reached = deferred();
  readonly released = deferred();
  private paused = false;
  arm(): void { this.paused = true; }
  override async read(): Promise<State> {
    const snapshot = await super.read();
    if (this.paused) {
      this.paused = false;
      this.reached.resolve();
      await this.released.promise;
    }
    return snapshot;
  }
}

/** Pause after the initial authority is captured, without holding the write lock. */
class PausedFinalReadRepository extends JsonRepository {
  readonly reached = deferred();
  readonly released = deferred();
  private paused = false;
  arm(): void { this.paused = true; }
  override async readGuarded<T>(read: (state: State) => T): Promise<T> {
    if (this.paused) {
      this.paused = false;
      this.reached.resolve();
      await this.released.promise;
    }
    return super.readGuarded(read);
  }
}

async function fixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-authenticated-source-race-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const security = await seedSecurityFixture(repository);
    await seedSourceQueueFixture(repository);
    const time = { now: securityAt };
    const access = new AccessControl(repository, { verifier: security.verifier, clock: () => time.now });
    await run({ repository, security, time, access });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function grants(f: Fixture, ids: readonly string[] = [originalId, copyId]): AssignedResourcePolicy {
  return new AssignedResourcePolicy(ids.map(id => ({ identityId: f.security.accounts.editor.identity.id,
    permission: 'SOURCE_READ', kind: 'SOURCE', id })));
}

function queue(f: Fixture, policy: ResourcePolicy, repository = f.repository): AuthenticatedSourceQueue {
  const access = new AccessControl(repository, { verifier: f.security.verifier, clock: () => f.time.now });
  return new AuthenticatedSourceQueue(repository, access, { resourcePolicy: policy });
}

function securityError(code: string): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof SecurityError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.doesNotMatch(JSON.stringify(error), /FICTIONAL_PRIVATE|fictional\.json|dayline-authenticated-source-race/);
    return true;
  };
}

function staleCursor(error: unknown): boolean {
  assert.ok(error instanceof SourceQueueError);
  assert.equal(error.code, 'STALE_CURSOR');
  assert.equal(error.message, 'STALE_CURSOR');
  assert.doesNotMatch(JSON.stringify(error), /FICTIONAL_PRIVATE|source-queue\.example/);
  return true;
}

function withheld(page: SourceQueuePage): void {
  assert.equal(page.entries.length, 1);
  const entry = page.entries[0];
  assert.equal(entry.publisher, null);
  assert.equal(entry.canonicalUrl, null);
  assert.equal(entry.publishedAt, null);
  assert.equal(entry.retrievedAt, null);
  assert.equal(entry.relationship, null);
  assert.equal(entry.sourceEligible, false);
  assert.equal(entry.canAdvance, false);
}

const identityChanges: Array<[string, string, (f: Fixture) => Promise<unknown>]> = [
  ['credential rotation', 'INVALID_SESSION', f => f.access.rotateCredentials(f.security.accounts.admin.credential, f.security.accounts.editor.identity.id, 1)],
];

for (const [name, code, change] of identityChanges) {
  test(`in-flight ${name} commits before final authorization and discloses no candidate`, async () => fixture(async f => {
    const paused = new PausedSnapshotRepository(f.repository.file);
    const facade = queue(f, grants(f), paused);
    let disclosures = 0;
    paused.arm();
    const pending = facade.withPage(f.security.accounts.editor.credential, undefined, () => { disclosures++; });
    const denied = assert.rejects(pending, securityError(code));
    await paused.reached.promise;
    try { await change(f); } finally { paused.released.resolve(); }
    await denied;
    assert.equal(disclosures, 0);
  }));
}

test('an in-flight assignment replacement denies the complete page, including candidates already checked', async () => fixture(async f => {
  let current = grants(f);
  const dynamic: ResourcePolicy = {
    sourceReadRevision: () => current.sourceReadRevision(),
    authorize: (...args) => current.authorize(...args),
  };
  const paused = new PausedFinalReadRepository(f.repository.file);
  const facade = queue(f, dynamic, paused);
  const initial = await facade.read(f.security.accounts.editor.credential, { limit: 1 });
  assert.ok(initial.nextCursor);
  paused.arm();
  let disclosures = 0;
  const pending = facade.withPage(f.security.accounts.editor.credential, undefined, () => { disclosures++; });
  const denied = assert.rejects(pending, securityError('PERMISSION_DENIED'));
  await paused.reached.promise;
  current = grants(f, [originalId]);
  paused.released.resolve();
  await denied;
  assert.equal(disclosures, 0);
  await assert.rejects(facade.read(f.security.accounts.editor.credential, { limit: 1, cursor: initial.nextCursor! }), staleCursor);
}));

test('revoking then restoring identical source assignments gives a new epoch and rejects old cursors', async () => fixture(async f => {
  let current = grants(f);
  const dynamic: ResourcePolicy = {
    sourceReadRevision: () => current.sourceReadRevision(),
    authorize: (...args) => current.authorize(...args),
  };
  const facade = queue(f, dynamic);
  const first = await facade.read(f.security.accounts.editor.credential, { limit: 1 });
  assert.ok(first.nextCursor);
  const originalRevision = current.sourceReadRevision();
  current = grants(f, []);
  await assert.rejects(facade.read(f.security.accounts.editor.credential), securityError('PERMISSION_DENIED'));
  current = grants(f);
  assert.notEqual(current.sourceReadRevision(), originalRevision);
  await assert.rejects(facade.read(f.security.accounts.editor.credential, { limit: 1, cursor: first.nextCursor! }), staleCursor);
  assert.equal((await facade.read(f.security.accounts.editor.credential)).entries.length, 2);
}));

test('revocation and restoration during a read cannot reuse its original assignment epoch', async () => fixture(async f => {
  let current = grants(f);
  const dynamic: ResourcePolicy = {
    sourceReadRevision: () => current.sourceReadRevision(),
    authorize: (...args) => current.authorize(...args),
  };
  const paused = new PausedFinalReadRepository(f.repository.file);
  paused.arm();
  let disclosures = 0;
  const pending = queue(f, dynamic, paused).withPage(f.security.accounts.editor.credential, undefined, () => { disclosures++; });
  const denied = assert.rejects(pending, securityError('PERMISSION_DENIED'));
  await paused.reached.promise;
  current = grants(f, []);
  current = grants(f);
  paused.released.resolve();
  await denied;
  assert.equal(disclosures, 0);
}));

test('a source cursor cannot move between two registered sessions of the same identity', async () => fixture(async f => {
  const facade = queue(f, grants(f));
  const first = await facade.read(f.security.accounts.editor.credential, { limit: 1 });
  assert.ok(first.nextCursor);
  const secondCredential = f.security.verifier.issue({ ...f.security.accounts.editor.claims, sessionId: randomUUID() });
  await f.access.registerSession(secondCredential);
  await assert.rejects(facade.read(secondCredential, { limit: 1, cursor: first.nextCursor! }), staleCursor);
  assert.equal((await facade.read(secondCredential, { limit: 1 })).entries.length, 1);
}));

test('even an allowed role revision invalidates a previously issued source cursor', async () => fixture(async f => {
  const facade = queue(f, grants(f));
  const first = await facade.read(f.security.accounts.editor.credential, { limit: 1 });
  assert.ok(first.nextCursor);
  await f.access.setRoles(f.security.accounts.admin.credential, f.security.accounts.editor.identity.id, 1, ['MANAGING_EDITOR']);
  await assert.rejects(facade.read(f.security.accounts.editor.credential, { limit: 1, cursor: first.nextCursor! }), staleCursor);
  assert.equal((await facade.read(f.security.accounts.editor.credential)).entries.length, 2);
}));

test('concurrent source metadata changes are projected from the final coherent snapshot', async () => fixture(async f => {
  const paused = new PausedSnapshotRepository(f.repository.file);
  const facade = queue(f, grants(f, [originalId]), paused);
  paused.arm();
  const pending = facade.read(f.security.accounts.editor.credential);
  await paused.reached.promise;
  try {
    await f.repository.transact(state => {
      state.managedSources.find(row => row.sourceId === originalId)!.providerMetadata.publisher = 'Fictional Updated Gazette';
      state.sources.find(row => row.id === originalId)!.publisher = 'Fictional Updated Gazette';
    });
  } finally { paused.released.resolve(); }
  const page = await pending;
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].publisher, 'Fictional Updated Gazette');
  assert.equal(page.entries[0].sourceEligible, true);
  assert.doesNotMatch(JSON.stringify(page), /Fictional Original Gazette/);
}));

for (const stateChange of ['rights revocation', 'deletion'] as const) {
  test(`in-flight ${stateChange} withholds the earlier retained metadata`, async () => fixture(async f => {
    const paused = new PausedSnapshotRepository(f.repository.file);
    const facade = queue(f, grants(f, [originalId]), paused);
    paused.arm();
    const pending = facade.read(f.security.accounts.editor.credential);
    await paused.reached.promise;
    try {
      await f.repository.transact(state => {
        if (stateChange === 'deletion') {
          state.deletions.push({ sourceId: originalId, at: securityAt, expiresAt: '2026-06-02T12:00:00.000Z', reason: privateValue });
        } else {
          const record = state.managedSources.find(row => row.sourceId === originalId)!;
          record.policy.id = 'fictional-revoked-v1';
          record.policy.evidenceReference = 'fictional-fixture-only:fictional-revoked-v1';
          state.sources.find(row => row.id === originalId)!.rights = JSON.stringify(record.policy);
        }
      });
    } finally { paused.released.resolve(); }
    const page = await pending;
    withheld(page);
    assert.equal(page.entries[0].blockedReason, stateChange === 'deletion' ? 'SOURCE_DELETED' : 'POLICY_REVOKED');
    assert.doesNotMatch(JSON.stringify(page), /FICTIONAL_PRIVATE|Fictional Original Gazette|source-queue\.example/);
  }));
}

test('a relevant retention update committed during cursor use rejects before disclosure', async () => fixture(async f => {
  const paused = new PausedSnapshotRepository(f.repository.file);
  const facade = queue(f, grants(f), paused);
  const first = await facade.read(f.security.accounts.editor.credential, { limit: 1 });
  assert.ok(first.nextCursor);
  paused.arm();
  let disclosures = 0;
  const pending = facade.withPage(f.security.accounts.editor.credential, { limit: 1, cursor: first.nextCursor! }, () => { disclosures++; });
  const denied = assert.rejects(pending, staleCursor);
  await paused.reached.promise;
  try {
    await f.repository.transact(state => {
      state.managedSources.find(row => row.sourceId === originalId)!.deleteAt = '2026-06-01T12:01:00.000Z';
    });
  } finally { paused.released.resolve(); }
  await denied;
  assert.equal(disclosures, 0);
}));

test('hidden source updates and private audit additions do not invalidate an authorized cursor', async () => fixture(async f => {
  const facade = queue(f, grants(f));
  const first = await facade.read(f.security.accounts.editor.credential, { limit: 1 });
  assert.ok(first.nextCursor);
  const expected = await facade.read(f.security.accounts.editor.credential, { limit: 1, cursor: first.nextCursor! });
  await f.repository.transact(state => {
    const hidden = state.quarantine.find(row => row.sourceId === newId)!;
    hidden.providerMetadata.publisher = hidden.metadata.publisher = privateValue;
    state.provenanceDecisions.filter(row => row.sourceId === originalId).forEach(row => {
      row.actorAssertion = privateValue;
      row.evidenceReferences = [privateValue];
      row.reason = privateValue;
    });
    Object.assign(state.managedSources.find(row => row.sourceId === originalId)!, { rawProviderPayload: privateValue, privateNotes: privateValue });
  });
  const actual = await facade.read(f.security.accounts.editor.credential, { limit: 1, cursor: first.nextCursor! });
  assert.deepEqual(actual, expected);
  assert.doesNotMatch(JSON.stringify(actual), /FICTIONAL_PRIVATE|rawProviderPayload|privateNotes|evidenceReferences/);
}));

test('invalid, asynchronous and missing policy epochs fail closed before any callback', async () => {
  for (const revision of [undefined, null, '', 'f'.repeat(63), 'F'.repeat(64), true, Promise.resolve('f'.repeat(64))]) {
    await fixture(async f => {
      const assigned = grants(f);
      const policy = { authorize: assigned.authorize.bind(assigned), ...(revision === undefined ? {} : { sourceReadRevision: () => revision }) } as unknown as ResourcePolicy;
      let disclosures = 0;
      await assert.rejects(async () => queue(f, policy).withPage(f.security.accounts.editor.credential, undefined, () => { disclosures++; }), securityError('PERMISSION_DENIED'));
      assert.equal(disclosures, 0);
    });
  }
});

test('an asynchronous decision for one candidate denies the whole page without exposing the others', async () => fixture(async f => {
  const assigned = grants(f);
  const policy: ResourcePolicy = {
    sourceReadRevision: () => assigned.sourceReadRevision(),
    authorize(principal, permission, targets, state) {
      if (targets.some(target => target.id === copyId)) return Promise.reject(Error(privateValue)) as unknown as void;
      assigned.authorize(principal, permission, targets, state);
    },
  };
  let disclosures = 0;
  await assert.rejects(queue(f, policy).withPage(f.security.accounts.editor.credential, undefined, () => { disclosures++; }), securityError('PERMISSION_DENIED'));
  assert.equal(disclosures, 0);
}));

test('raw policy failures and hostile error fields become fixed authorization failures', async () => fixture(async f => {
  const assigned = grants(f);
  let touched = 0;
  const hostile = Object.create(null) as { code?: unknown; message?: unknown };
  Object.defineProperties(hostile, {
    code: { get() { touched++; throw Error(privateValue); } },
    message: { get() { touched++; throw Error(privateValue); } },
  });
  for (const error of [Error(privateValue), hostile]) {
    const policy: ResourcePolicy = { sourceReadRevision: () => assigned.sourceReadRevision(), authorize() { throw error; } };
    let disclosures = 0;
    await assert.rejects(queue(f, policy).withPage(f.security.accounts.editor.credential, undefined, () => { disclosures++; }), securityError('PERMISSION_DENIED'));
    assert.equal(disclosures, 0);
  }
  assert.equal(touched, 0);
}));

test('safe policy error categories are reconstructed without private diagnostics or extra fields', async () => fixture(async f => {
  const assigned = grants(f);
  const failure = Object.assign(new SecurityError('SESSION_REVOKED'), { message: privateValue, cause: privateValue, privateNotes: privateValue });
  const policy: ResourcePolicy = { sourceReadRevision: () => assigned.sourceReadRevision(), authorize() { throw failure; } };
  let disclosures = 0;
  await assert.rejects(queue(f, policy).withPage(f.security.accounts.editor.credential, undefined, () => { disclosures++; }), error => {
    securityError('SESSION_REVOKED')(error);
    assert.notEqual(error, failure);
    assert.equal(Object.hasOwn(error as object, 'cause'), false);
    assert.equal(Object.hasOwn(error as object, 'privateNotes'), false);
    return true;
  });
  assert.equal(disclosures, 0);
}));

test('snapshot and final guarded storage failures reveal no path or partially prepared page', async () => fixture(async f => {
  class FailedSnapshot extends JsonRepository {
    override async read(): Promise<State> { throw Object.assign(Error(privateValue), { path: this.file, cause: privateValue }); }
  }
  class FailedFinalRead extends JsonRepository {
    override async readGuarded<T>(_read: (state: State) => T): Promise<T> { throw Object.assign(Error(privateValue), { path: this.file, cause: privateValue }); }
  }
  for (const repository of [new FailedSnapshot(f.repository.file), new FailedFinalRead(f.repository.file)]) {
    let disclosures = 0;
    await assert.rejects(queue(f, grants(f), repository).withPage(f.security.accounts.editor.credential, undefined, () => { disclosures++; }), securityError('STORAGE_UNAVAILABLE'));
    assert.equal(disclosures, 0);
  }
}));

test('policy observations and disclosed DTOs cannot rewrite repository records or later pages', async () => fixture(async f => {
  const assigned = grants(f, [originalId]);
  const observed: State[] = [];
  const policy: ResourcePolicy = {
    sourceReadRevision: () => assigned.sourceReadRevision(),
    authorize(principal, permission, targets, state) {
      assigned.authorize(principal, permission, targets, state);
      observed.push(state as State);
      for (const mutate of [
        () => { (principal as { identityId: string }).identityId = privateValue; },
        () => { (targets as unknown as { id: string }[])[0].id = privateValue; },
        () => { (state as State).managedSources.find(row => row.sourceId === originalId)!.providerMetadata.publisher = privateValue; },
        () => { (state as State).sources.find(row => row.id === originalId)!.publisher = privateValue; },
        () => { (state as State).identities.length = 0; },
      ]) assert.throws(mutate, TypeError);
    },
  };
  const before = await readFile(f.repository.file, 'utf8');
  const facade = queue(f, policy);
  await facade.withPage(f.security.accounts.editor.credential, undefined, (page, assertCurrent) => {
    assert.equal(page.entries[0].publisher, 'Fictional Original Gazette');
    for (const state of observed) assert.throws(() => { state.managedSources.length = 0; }, TypeError);
    assertCurrent();
    assert.equal(page.entries[0].publisher, 'Fictional Original Gazette');
    page.entries[0].publisher = privateValue;
    page.entries.length = 0;
  });
  assert.equal(await readFile(f.repository.file, 'utf8'), before);
  assert.equal((await facade.read(f.security.accounts.editor.credential)).entries[0].publisher, 'Fictional Original Gazette');
}));

test('source reads and source-read denials write no audit records or session refreshes', async () => fixture(async f => {
  const facade = queue(f, grants(f));
  const before = await readFile(f.repository.file, 'utf8');
  await facade.read(f.security.accounts.editor.credential);
  await facade.withPage(f.security.accounts.editor.credential, undefined, (_page, assertCurrent) => { assertCurrent(); });
  await assert.rejects(facade.read(f.security.accounts.admin.credential), securityError('PERMISSION_DENIED'));
  f.time.now = f.security.accounts.editor.claims.expiresAt;
  await assert.rejects(facade.read(f.security.accounts.editor.credential), securityError('SESSION_EXPIRED'));
  assert.equal(await readFile(f.repository.file, 'utf8'), before);
}));

test('synchronous disclosure runs under the repository lock and a queued update commits afterward', async () => fixture(async f => {
  const facade = queue(f, grants(f, [originalId]));
  let mutation: Promise<void> | undefined;
  let disclosed = '';
  await facade.withPage(f.security.accounts.editor.credential, undefined, (page, assertCurrent) => {
    assert.equal(existsSync(f.repository.file + '.lock'), true);
    const serialized = JSON.stringify(page);
    assertCurrent();
    disclosed = serialized;
    mutation = f.repository.transact(state => {
      state.managedSources.find(row => row.sourceId === originalId)!.providerMetadata.publisher = 'Fictional Later Gazette';
      state.sources.find(row => row.id === originalId)!.publisher = 'Fictional Later Gazette';
    });
  });
  assert.ok(mutation);
  await mutation;
  assert.match(disclosed, /Fictional Original Gazette/);
  assert.equal((await facade.read(f.security.accounts.editor.credential)).entries[0].publisher, 'Fictional Later Gazette');
}));

for (const change of ['policy replacement', 'session expiry'] as const) {
  test(`the post-serialization guard detects ${change} before the synchronous sink receives bytes`, async () => fixture(async f => {
    let current = grants(f);
    const dynamic: ResourcePolicy = {
      sourceReadRevision: () => current.sourceReadRevision(),
      authorize: (...args) => current.authorize(...args),
    };
    let sink = '';
    await assert.rejects(queue(f, dynamic).withPage(f.security.accounts.editor.credential, undefined, (page, assertCurrent) => {
      const serialized = JSON.stringify(page);
      if (change === 'policy replacement') current = grants(f, []);
      else f.time.now = f.security.accounts.editor.claims.expiresAt;
      assertCurrent();
      sink = serialized;
    }), securityError(change === 'policy replacement' ? 'PERMISSION_DENIED' : 'SESSION_EXPIRED'));
    assert.equal(sink, '');
  }));
}

test('retention expiry after serialization prevents a stale retained page from reaching the sink', async () => fixture(async f => {
  const expiresAt = '2026-06-01T12:01:00.000Z';
  await f.repository.transact(state => { state.managedSources.find(row => row.sourceId === originalId)!.deleteAt = expiresAt; });
  let sink = '';
  await assert.rejects(queue(f, grants(f, [originalId])).withPage(f.security.accounts.editor.credential, undefined, (page, assertCurrent) => {
    assert.equal(page.entries[0].publisher, 'Fictional Original Gazette');
    const serialized = JSON.stringify(page);
    f.time.now = expiresAt;
    assertCurrent();
    sink = serialized;
  }), securityError('STALE_TARGET'));
  assert.equal(sink, '');
}));

test('retention expiry during the final recompute serialization blocks disclosure while the session remains valid', async () => fixture(async f => {
  const expiresAt = '2026-06-01T12:00:10.000Z';
  await f.repository.transact(state => { state.managedSources.find(row => row.sourceId === originalId)!.deleteAt = expiresAt; });
  f.time.now = '2026-06-01T12:00:09.999Z';
  assert.ok(Date.parse(f.security.accounts.editor.claims.expiresAt) > Date.parse(expiresAt));
  let crossedDeadline = false;
  let sink = '';
  await assert.rejects(queue(f, grants(f, [originalId])).withPage(f.security.accounts.editor.credential, undefined, (page, assertCurrent) => {
    assert.equal(page.entries[0].publisher, 'Fictional Original Gazette');
    const preparedBody = JSON.stringify(page);
    const stringify = JSON.stringify;
    try {
      JSON.stringify = ((value: unknown, ...args: unknown[]) => {
        const rendered = Reflect.apply(stringify, JSON, [value, ...args]) as string | undefined;
        // Only the fresh queue page inside assertCurrent crosses the clock boundary.
        if (!crossedDeadline && value !== page && value !== null && typeof value === 'object'
          && Object.hasOwn(value, 'entries') && Object.hasOwn(value, 'nextCursor') && Object.hasOwn(value, 'view')) {
          crossedDeadline = true;
          f.time.now = expiresAt;
        }
        return rendered;
      }) as typeof JSON.stringify;
      assertCurrent();
      sink = preparedBody;
    } finally { JSON.stringify = stringify; }
  }), securityError('STALE_TARGET'));
  assert.equal(crossedDeadline, true);
  assert.equal(sink, '');
}));

test('a declared asynchronous disclosure callback is rejected before it can escape the lock', async () => fixture(async f => {
  let called = false;
  await assert.rejects(queue(f, grants(f)).withPage(f.security.accounts.editor.credential, undefined, async () => {
    called = true;
    await Promise.resolve();
  }), securityError('DOMAIN_REJECTED'));
  assert.equal(called, false);
}));
