import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { seedSecurityFixture } from '../fixtures/security-fiction.ts';
import { ingestArticles, sourceId } from '../src/ingestion/ingest.ts';
import type { ProviderArticle } from '../src/ingestion/types.ts';
import type { ResolutionInput } from '../src/ingestion/records.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import type { State } from '../src/newsroom/model.ts';
import { AccessControl } from '../src/security/service.ts';
import { AuthenticatedSourceQueue } from '../src/security/source.ts';
import { AssignedResourcePolicy, type ResourceAssignment, type ResourcePolicy } from '../src/security/resources.ts';
import { SecurityError } from '../src/security/verifier.ts';
import { SourceQueueError } from '../src/source-queue/service.ts';
import type { SourceQueuePage, SourceQueueQuery } from '../src/source-queue/types.ts';

const at = '2026-06-01T12:00:00.000Z';
const context = { providerId: 'fictional-fixture', policyId: 'fictional-metadata-v1' };
const article = (name: string, changes: Partial<ProviderArticle> = {}): ProviderArticle => ({
  providerId: context.providerId, publisher: `Fictional ${name}`, url: `https://source-auth.example.test/${name}`,
  publishedAt: '2026-06-01T09:00:00.000Z', retrievedAt: at,
  provenance: { type: 'ORIGINAL', originId: null }, ...changes,
});
const resolution = (value: ProviderArticle): ResolutionInput => ({ sourceId: sourceId(value.url), classification: value.provenance.type,
  originId: value.provenance.originId, actorAssertion: 'PRIVATE_SOURCE_REVIEWER', at,
  evidenceReferences: ['PRIVATE_SOURCE_EVIDENCE'], reason: 'PRIVATE_SOURCE_REASON' });
type IdentityFixture = Awaited<ReturnType<typeof seedSecurityFixture>>;
interface Fixture {
  repository: JsonRepository;
  identities: IdentityFixture;
  access: AccessControl;
  clock: { now: string };
  articles: ProviderArticle[];
  policy(ids?: string[], identityId?: string): AssignedResourcePolicy;
  queue(policy?: ResourcePolicy, repository?: JsonRepository): AuthenticatedSourceQueue;
}
async function fixture(run: (value: Fixture) => Promise<void>, names = ['assigned-a', 'assigned-b', 'private-c']): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-auth-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const identities = await seedSecurityFixture(repository, at);
    const clock = { now: at };
    const access = new AccessControl(repository, { verifier: identities.verifier, clock: () => clock.now });
    const articles = names.map(name => article(name));
    const result = await ingestArticles(repository, articles, context, { dryRun: false, clock: () => at,
      resolutions: articles.map(resolution), maxArticles: 100 });
    assert.equal(result.failed, 0); assert.equal(result.rejected, 0);
    const policy = (ids = articles.map(value => sourceId(value.url)), identityId = identities.accounts.editor.identity.id) =>
      new AssignedResourcePolicy(ids.map(id => ({ identityId, permission: 'SOURCE_READ', kind: 'SOURCE', id })));
    const value: Fixture = { repository, identities, access, clock, articles, policy,
      queue(resourcePolicy = policy(), sourceRepository = repository) {
        return new AuthenticatedSourceQueue(sourceRepository, new AccessControl(sourceRepository,
          { verifier: identities.verifier, clock: () => clock.now }), { resourcePolicy });
      } };
    await run(value);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const errorCode = (expected: string) => (error: unknown) => (error instanceof SecurityError || error instanceof SourceQueueError)
  && error.code === expected && error.message === expected;
async function denied(queue: AuthenticatedSourceQueue, credential: unknown, expected: string, query?: SourceQueueQuery): Promise<void> {
  let disclosures = 0;
  await assert.rejects(queue.withPage(credential, query, () => { disclosures++; }), errorCode(expected));
  assert.equal(disclosures, 0, 'a denied request must disclose no page');
}
function ref(id: string): string { return `candidate-${createHash('sha256').update(id).digest('hex')}`; }

test('source access requires the role permission and an exact source assignment while preserving repository bytes', async () => fixture(async f => {
  const id = sourceId(f.articles[0].url), credential = f.identities.accounts.editor.credential;
  const before = await readFile(f.repository.file, 'utf8');
  const page = await f.queue(f.policy([id])).read(credential);
  assert.deepEqual(page.entries.map(entry => entry.canonicalUrl), [f.articles[0].url]);
  assert.equal(page.entries[0].candidateRef, ref(id)); assert.equal(page.entries[0].canAdvance, false);
  assert.equal(page.nextCursor, null); assert.equal(await readFile(f.repository.file, 'utf8'), before);
  assert.deepEqual(Object.keys(page).sort(), ['entries', 'limit', 'nextCursor', 'retentionReviewRequired', 'view']);
  assert.deepEqual(Object.keys(page.entries[0]).sort(), ['blockedReason', 'canAdvance', 'candidateRef', 'canonicalUrl', 'provenance',
    'provenanceStatus', 'publishedAt', 'publisher', 'quarantineStatus', 'relationship', 'retentionStatus', 'retrievedAt', 'rightsStatus', 'sourceEligible']);
}));

for (const credential of [undefined, null, '', 'invalid-secret', 'a.b.c']) test(`source read rejects missing or invalid credential ${String(credential)}`, async () => fixture(async f => {
  await denied(f.queue(), credential, 'INVALID_CREDENTIAL');
}));

test('a signed credential without a registered session cannot read assigned metadata', async () => fixture(async f => {
  const claims = { ...f.identities.accounts.editor.claims, sessionId: 'unregistered-source-session' };
  await denied(f.queue(), f.identities.verifier.issue(claims), 'INVALID_SESSION');
}));

test('source reads enforce the exact session expiry boundary', async () => fixture(async f => {
  f.clock.now = f.identities.accounts.editor.claims.expiresAt;
  await denied(f.queue(), f.identities.accounts.editor.credential, 'SESSION_EXPIRED');
}));

test('durably revoked sessions immediately lose source-read access', async () => fixture(async f => {
  const account = f.identities.accounts.editor;
  await f.access.invalidateSession(account.credential);
  await denied(f.queue(), account.credential, 'SESSION_REVOKED');
}));

test('a disabled identity cannot use its previously registered source session', async () => fixture(async f => {
  const account = f.identities.accounts.editor;
  await f.access.setStatus(f.identities.accounts.admin.credential, account.identity.id, 1, 'DISABLED');
  await denied(f.queue(), account.credential, 'IDENTITY_DISABLED');
}));

test('demotion removes source-read permission without reissuing the credential', async () => fixture(async f => {
  const account = f.identities.accounts.editor;
  await f.access.setRoles(f.identities.accounts.admin.credential, account.identity.id, 1, ['REPORTER']);
  await denied(f.queue(), account.credential, 'PERMISSION_DENIED');
}));

for (const role of ['reporter', 'admin'] as const) test(`${role} receives no automatic SOURCE_READ grant even with an exact SOURCE assignment`, async () => fixture(async f => {
  const account = f.identities.accounts[role];
  await denied(f.queue(f.policy(undefined, account.identity.id)), account.credential, 'PERMISSION_DENIED');
}));

test('a managing editor can read only explicitly assigned source metadata', async () => fixture(async f => {
  const account = f.identities.accounts.managing;
  const page = await f.queue(f.policy([sourceId(f.articles[0].url)], account.identity.id)).read(account.credential);
  assert.deepEqual(page.entries.map(entry => entry.canonicalUrl), [f.articles[0].url]);
}));

test('an editorial role without an exact source assignment is denied', async () => fixture(async f => {
  await denied(f.queue(new AssignedResourcePolicy([])), f.identities.accounts.editor.credential, 'PERMISSION_DENIED');
}));

test('assignments for a different identity, permission, kind or candidate hash cannot authorize the source', async () => fixture(async f => {
  const id = sourceId(f.articles[0].url), identityId = f.identities.accounts.editor.identity.id;
  const rows: ResourceAssignment[] = [
    { identityId: f.identities.accounts.managing.identity.id, permission: 'SOURCE_READ', kind: 'SOURCE', id },
    { identityId, permission: 'STORY_REVIEW', kind: 'SOURCE', id },
    { identityId, permission: 'SOURCE_READ', kind: 'STORY', id },
    { identityId, permission: 'SOURCE_READ', kind: 'SOURCE', id: ref(id) },
  ];
  for (const row of rows) await denied(f.queue(new AssignedResourcePolicy([row])), f.identities.accounts.editor.credential, 'PERMISSION_DENIED');
}));

test('mixed authorization is applied before pagination without private counts, references or cursor state', async () => fixture(async f => {
  const allowed = f.articles.slice(0, 2), privateArticle = f.articles[2];
  const queue = f.queue(f.policy(allowed.map(value => sourceId(value.url))));
  const first = await queue.read(f.identities.accounts.editor.credential, { limit: 1 });
  assert.equal(first.entries.length, 1); assert.ok(first.nextCursor);
  const second = await queue.read(f.identities.accounts.editor.credential, { limit: 1, cursor: first.nextCursor! });
  assert.equal(second.entries.length, 1); assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.entries, ...second.entries].map(entry => entry.canonicalUrl).sort(), allowed.map(value => value.url).sort());
  const visible = JSON.stringify([first, second, Buffer.from(first.nextCursor!, 'base64url').toString('utf8')]);
  for (const hidden of [privateArticle.url, privateArticle.publisher, sourceId(privateArticle.url), ref(sourceId(privateArticle.url))]) assert.equal(visible.includes(hidden), false);
  assert.equal('total' in first, false); assert.equal('count' in first, false);
}));

test('an unrelated private source update cannot reveal itself through the authorized cursor', async () => fixture(async f => {
  const queue = f.queue(f.policy(f.articles.slice(0, 2).map(value => sourceId(value.url))));
  const first = await queue.read(f.identities.accounts.editor.credential, { limit: 1 });
  await f.repository.transact(state => {
    const id = sourceId(f.articles[2].url);
    state.managedSources.find(row => row.sourceId === id)!.providerMetadata.publisher = 'PRIVATE_CHANGED_PUBLISHER';
    state.sources.find(row => row.id === id)!.publisher = 'PRIVATE_CHANGED_PUBLISHER';
  });
  const next = await queue.read(f.identities.accounts.editor.credential, { limit: 1, cursor: first.nextCursor! });
  assert.equal(next.entries.length, 1); assert.equal(next.nextCursor, null);
}));

test('cursor reuse by another registered session is rejected even for the same identity and grants', async () => fixture(async f => {
  const queue = f.queue(), account = f.identities.accounts.editor;
  const first = await queue.read(account.credential, { limit: 1 });
  const token = f.identities.verifier.issue({ ...account.claims, sessionId: 'source-second-registered-session' });
  await f.access.registerSession(token);
  await denied(queue, token, 'STALE_CURSOR', { limit: 1, cursor: first.nextCursor! });
}));

test('identity role revision invalidates a cursor even when an editorial read role remains', async () => fixture(async f => {
  const queue = f.queue(), account = f.identities.accounts.editor;
  const first = await queue.read(account.credential, { limit: 1 });
  await f.access.setRoles(f.identities.accounts.admin.credential, account.identity.id, 1, ['MANAGING_EDITOR']);
  await denied(queue, account.credential, 'STALE_CURSOR', { limit: 1, cursor: first.nextCursor! });
}));

test('policy replacement invalidates old cursors after revoke and regrant of the same source assignments', async () => fixture(async f => {
  let current = f.policy();
  const policy: ResourcePolicy = { authorize: (...args) => current.authorize(...args), sourceReadRevision: () => current.sourceReadRevision() };
  const queue = f.queue(policy), credential = f.identities.accounts.editor.credential;
  const first = await queue.read(credential, { limit: 1 });
  current = new AssignedResourcePolicy([]);
  await denied(queue, credential, 'PERMISSION_DENIED');
  current = f.policy();
  await denied(queue, credential, 'STALE_CURSOR', { limit: 1, cursor: first.nextCursor! });
}));

test('an effective source-assignment change invalidates an old authorized page', async () => fixture(async f => {
  let current = f.policy();
  const queue = f.queue({ authorize: (...args) => current.authorize(...args), sourceReadRevision: () => current.sourceReadRevision() });
  const credential = f.identities.accounts.editor.credential, first = await queue.read(credential, { limit: 1 });
  current = f.policy(f.articles.slice(1).map(value => sourceId(value.url)));
  await denied(queue, credential, 'STALE_CURSOR', { limit: 1, cursor: first.nextCursor! });
}));

test('a relevant source update invalidates pagination and does not return a partial page', async () => fixture(async f => {
  const queue = f.queue(), credential = f.identities.accounts.editor.credential;
  const first = await queue.read(credential, { limit: 1 });
  await f.repository.transact(state => { state.sources[0].publisher = 'Fictional updated'; state.managedSources[0].providerMetadata.publisher = 'Fictional updated'; });
  await denied(queue, credential, 'STALE_CURSOR', { limit: 1, cursor: first.nextCursor! });
}));

test('rights revocation invalidates old pages and withholds all revoked source metadata', async () => fixture(async f => {
  const queue = f.queue(), credential = f.identities.accounts.editor.credential;
  const first = await queue.read(credential, { limit: 1 });
  const id = sourceId(f.articles[0].url);
  await f.repository.transact(state => {
    const record = state.managedSources.find(row => row.sourceId === id)!;
    record.policy.id = 'fictional-revoked-v1'; record.policy.evidenceReference = 'fictional-fixture-only:fictional-revoked-v1';
    state.sources.find(row => row.id === id)!.rights = JSON.stringify(record.policy);
  });
  await denied(queue, credential, 'STALE_CURSOR', { limit: 1, cursor: first.nextCursor! });
  const entry = (await queue.read(credential)).entries.find(row => row.candidateRef === ref(id))!;
  assert.equal(entry.rightsStatus, 'REVOKED'); assert.equal(entry.publisher, null); assert.equal(entry.canonicalUrl, null);
  assert.equal(entry.relationship, null); assert.equal(entry.sourceEligible, false);
}));

test('current source rights expiry remains authoritative while the registered session is still valid', async () => fixture(async f => {
  const account = f.identities.accounts.editor;
  f.clock.now = '2026-12-31T23:59:00.000Z';
  const token = f.identities.verifier.issue({ ...account.claims, sessionId: 'source-rights-expiry-session',
    authenticatedAt: f.clock.now, notBefore: f.clock.now, expiresAt: '2027-01-01T00:14:00.000Z' });
  await f.access.registerSession(token);
  const queue = f.queue();
  assert.ok((await queue.read(token)).entries.every(entry => entry.rightsStatus === 'ACTIVE'));
  f.clock.now = '2027-01-01T00:00:00.000Z';
  const page = await queue.read(token);
  assert.ok(page.entries.every(entry => entry.rightsStatus === 'EXPIRED' && entry.publisher === null
    && entry.canonicalUrl === null && entry.relationship === null && entry.sourceEligible === false));
}));

test('quarantined source reads preserve provenance and retention restrictions without granting advancement', async () => fixture(async f => {
  const value = article('quarantined', { provenance: { type: 'UNKNOWN', originId: null } });
  await ingestArticles(f.repository, [value], context, { dryRun: false, clock: () => at });
  const page = await f.queue(f.policy([sourceId(value.url)])).read(f.identities.accounts.editor.credential);
  assert.equal(page.entries.length, 1); assert.equal(page.entries[0].quarantineStatus, 'QUARANTINED');
  assert.equal(page.entries[0].provenanceStatus, 'UNRESOLVED'); assert.equal(page.entries[0].sourceEligible, false);
  assert.equal(page.entries[0].canAdvance, false); assert.equal(page.entries[0].blockedReason, 'PROVENANCE_UNRESOLVED');
}));

test('deleted assigned sources return only a minimal authoritative deletion marker', async () => fixture(async f => {
  const id = sourceId(f.articles[0].url);
  await f.repository.transact(state => {
    state.sources = state.sources.filter(row => row.id !== id); state.managedSources = state.managedSources.filter(row => row.sourceId !== id);
    state.provenanceDecisions = state.provenanceDecisions.filter(row => row.sourceId !== id);
    state.deletions.push({ sourceId: id, at, reason: 'PRIVATE_DELETION_REASON', expiresAt: '2026-06-02T12:00:00.000Z' });
  });
  const entry = (await f.queue(f.policy([id])).read(f.identities.accounts.editor.credential)).entries[0];
  assert.equal(entry.retentionStatus, 'DELETED'); assert.equal(entry.publisher, null); assert.equal(entry.canonicalUrl, null);
  assert.equal(entry.publishedAt, null); assert.equal(entry.retrievedAt, null); assert.equal(entry.relationship, null);
  assert.doesNotMatch(JSON.stringify(entry), /PRIVATE_DELETION_REASON|source-auth\.example|Fictional assigned-a/);
}));

test('a syndicated source cannot reference an inaccessible origin in entries or RELATED pagination', async () => fixture(async f => {
  const value = article('syndicated', { provenance: { type: 'SYNDICATED', originId: sourceId(f.articles[0].url) } });
  await ingestArticles(f.repository, [value], context, { dryRun: false, clock: () => at, resolutions: [resolution(value)] });
  const queue = f.queue(f.policy([sourceId(value.url)])), credential = f.identities.accounts.editor.credential;
  const page = await queue.read(credential);
  assert.equal(page.entries.length, 1); assert.equal(page.entries[0].relationship, null);
  assert.equal(JSON.stringify(page).includes(ref(sourceId(f.articles[0].url))), false);
  const related = await queue.read(credential, { view: 'RELATED', limit: 1 });
  assert.deepEqual(related.entries, []); assert.equal(related.nextCursor, null);
}));

class PausedRepository extends JsonRepository {
  armed = true;
  reached!: () => void;
  release!: () => void;
  readonly waiting = new Promise<void>(resolve => { this.reached = resolve; });
  readonly gate = new Promise<void>(resolve => { this.release = resolve; });
  override async read(): Promise<State> {
    const state = await super.read();
    if (this.armed) { this.armed = false; this.reached(); await this.gate; }
    return state;
  }
}

for (const change of ['revoke', 'disable', 'demote'] as const) test(`${change} committed during an in-flight source read prevents every disclosure`, async () => fixture(async f => {
  const repository = new PausedRepository(f.repository.file), queue = f.queue(f.policy(), repository);
  let disclosed = false;
  const pending = queue.withPage(f.identities.accounts.editor.credential, undefined, () => { disclosed = true; });
  await repository.waiting;
  const account = f.identities.accounts.editor;
  if (change === 'revoke') await f.access.invalidateSession(account.credential);
  else if (change === 'disable') await f.access.setStatus(f.identities.accounts.admin.credential, account.identity.id, 1, 'DISABLED');
  else await f.access.setRoles(f.identities.accounts.admin.credential, account.identity.id, 1, ['REPORTER']);
  repository.release();
  await assert.rejects(pending, errorCode(change === 'revoke' ? 'SESSION_REVOKED' : change === 'disable' ? 'IDENTITY_DISABLED' : 'PERMISSION_DENIED'));
  assert.equal(disclosed, false);
}));

test('resource-policy revocation during an in-flight read prevents metadata disclosure', async () => fixture(async f => {
  let current = f.policy();
  const repository = new PausedRepository(f.repository.file);
  const queue = f.queue({ authorize: (...args) => current.authorize(...args), sourceReadRevision: () => current.sourceReadRevision() }, repository);
  let disclosed = false;
  const pending = queue.withPage(f.identities.accounts.editor.credential, undefined, () => { disclosed = true; });
  await repository.waiting; current = new AssignedResourcePolicy([]); repository.release();
  await assert.rejects(pending, errorCode('PERMISSION_DENIED')); assert.equal(disclosed, false);
}));

test('concurrent source deletion cannot disclose metadata captured by the initial snapshot', async () => fixture(async f => {
  const id = sourceId(f.articles[0].url), repository = new PausedRepository(f.repository.file);
  const queue = f.queue(f.policy([id]), repository);
  const pending = queue.read(f.identities.accounts.editor.credential);
  await repository.waiting;
  await f.repository.transact(state => {
    state.sources = state.sources.filter(row => row.id !== id); state.managedSources = state.managedSources.filter(row => row.sourceId !== id);
    state.provenanceDecisions = state.provenanceDecisions.filter(row => row.sourceId !== id);
    state.deletions.push({ sourceId: id, at, reason: 'PRIVATE_INFLIGHT_DELETION', expiresAt: '2026-06-02T12:00:00.000Z' });
  });
  repository.release();
  const page = await pending;
  assert.equal(page.entries[0].retentionStatus, 'DELETED'); assert.equal(page.entries[0].canonicalUrl, null);
  assert.equal(page.entries[0].publisher, null); assert.doesNotMatch(JSON.stringify(page), /PRIVATE_INFLIGHT_DELETION|Fictional assigned-a/);
}));

test('session expiry between snapshot collection and disclosure rejects the complete response', async () => fixture(async f => {
  const repository = new PausedRepository(f.repository.file), queue = f.queue(f.policy(), repository);
  let disclosed = false;
  const pending = queue.withPage(f.identities.accounts.editor.credential, undefined, () => { disclosed = true; });
  await repository.waiting; f.clock.now = f.identities.accounts.editor.claims.expiresAt; repository.release();
  await assert.rejects(pending, errorCode('SESSION_EXPIRED')); assert.equal(disclosed, false);
}));

test('source policy requires a trusted stable revision contract and rejects nonvoid, async or exceptional decisions', async () => fixture(async f => {
  const revision = () => 'a'.repeat(64), credential = f.identities.accounts.editor.credential;
  const policies: ResourcePolicy[] = [
    { authorize() {} },
    { authorize() {}, sourceReadRevision: () => 'invalid-private-epoch' },
    { authorize: (() => true) as ResourcePolicy['authorize'], sourceReadRevision: revision },
    { authorize: (async () => undefined) as ResourcePolicy['authorize'], sourceReadRevision: revision },
    { authorize() { throw Error('PRIVATE_POLICY_STORAGE_DETAIL'); }, sourceReadRevision: revision },
  ];
  for (const policy of policies) {
    let disclosed = false;
    await assert.rejects(async () => f.queue(policy).withPage(credential, undefined, () => { disclosed = true; }),
      (error: unknown) => error instanceof SecurityError && !error.message.includes('PRIVATE'));
    assert.equal(disclosed, false);
  }
}));

test('policy instability during exact-resource checks fails the whole read', async () => fixture(async f => {
  let version = 0;
  const queue = f.queue({ authorize() { version++; }, sourceReadRevision: () => createHash('sha256').update(String(version)).digest('hex') });
  await denied(queue, f.identities.accounts.editor.credential, 'PERMISSION_DENIED');
}));

test('storage read failures are sanitized and invoke no disclosure callback', async () => fixture(async f => {
  class FailedRepository extends JsonRepository { override async read(): Promise<State> { throw Error('PRIVATE_FILE_/secret/source.json'); } }
  await denied(f.queue(f.policy(), new FailedRepository(f.repository.file)), f.identities.accounts.editor.credential, 'STORAGE_UNAVAILABLE');
}));

test('corrupt repository bytes produce a fixed failure without reflecting stored content', async () => fixture(async f => {
  await writeFile(f.repository.file, '{"PRIVATE_CORRUPT_SOURCE":', 'utf8');
  await denied(f.queue(), f.identities.accounts.editor.credential, 'STORAGE_UNAVAILABLE');
}));

for (const category of ['security', 'queue'] as const) test(`a storage-supplied ${category} error is rebuilt without its private message, cause or fields`, async () => fixture(async f => {
  const supplied = category === 'security' ? new SecurityError('STORAGE_UNAVAILABLE') : new SourceQueueError('UNAVAILABLE');
  Object.assign(supplied, { message: 'PRIVATE_STORAGE_ERROR_MESSAGE', cause: Error('PRIVATE_STORAGE_CAUSE'),
    providerResponse: { password: 'PRIVATE_STORAGE_PAYLOAD' } });
  class FailedRepository extends JsonRepository { override async read(): Promise<State> { throw supplied; } }
  const queue = f.queue(f.policy(), new FailedRepository(f.repository.file));
  let disclosed = false;
  await assert.rejects(queue.withPage(f.identities.accounts.editor.credential, undefined, () => { disclosed = true; }), (error: unknown) => {
    assert.notEqual(error, supplied);
    assert.ok(category === 'security' ? error instanceof SecurityError : error instanceof SourceQueueError);
    assert.equal((error as Error).message, category === 'security' ? 'STORAGE_UNAVAILABLE' : 'UNAVAILABLE');
    assert.equal(Object.hasOwn(error as object, 'cause'), false);
    assert.equal(Object.hasOwn(error as object, 'providerResponse'), false);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_/);
    return true;
  });
  assert.equal(disclosed, false);
}));

test('storage-supplied accessor error codes are never evaluated or forwarded', async () => fixture(async f => {
  let getters = 0;
  const supplied = new SecurityError('PERMISSION_DENIED');
  Object.defineProperty(supplied, 'code', { configurable: true, get() { getters++; return 'PRIVATE_ERROR_CODE'; } });
  class FailedRepository extends JsonRepository { override async read(): Promise<State> { throw supplied; } }
  await denied(f.queue(f.policy(), new FailedRepository(f.repository.file)), f.identities.accounts.editor.credential, 'STORAGE_UNAVAILABLE');
  assert.equal(getters, 0);
}));

test('source assignments reject prototypes, sparse arrays and accessors before evaluating supplied getters', () => {
  let getters = 0;
  const row: ResourceAssignment = { identityId: 'editor-source-fixture', permission: 'SOURCE_READ', kind: 'SOURCE', id: 'source-fixture' };
  const accessorRow = Object.defineProperty({ ...row }, 'id', { enumerable: true, get() { getters++; return row.id; } });
  const accessorArray = Object.defineProperty([], '0', { enumerable: true, get() { getters++; return row; } });
  const inheritedArray = Object.setPrototypeOf([row], Object.create(Array.prototype));
  const inheritedRow = Object.assign(Object.create({ allowAll: true }), row);
  const symbolArray = Object.assign([row], { [Symbol('private-authority')]: true });
  const symbolRow = { ...row, [Symbol('private-authority')]: true };
  const hiddenRow = Object.defineProperty({ ...row }, 'id', { value: row.id, enumerable: false });
  for (const value of [[accessorRow], accessorArray, Array(1), inheritedArray, [inheritedRow], symbolArray, [symbolRow], [hiddenRow]]) {
    assert.throws(() => new AssignedResourcePolicy(value as ResourceAssignment[]), errorCode('PERMISSION_DENIED'));
  }
  assert.equal(getters, 0);
});

test('malformed and prototype-bearing source requests cannot supply their own policy, paths or targets', async () => fixture(async f => {
  const queue = f.queue(), credential = f.identities.accounts.editor.credential;
  let getterCalls = 0;
  const getter = Object.defineProperty({}, 'view', { enumerable: true, get() { getterCalls++; return 'RECENT'; } });
  const inputs: unknown[] = [null, [], { limit: 0 }, { limit: 51 }, { view: 'PRIVATE' }, { cursor: '../secret' },
    { repository: '/private' }, { sourceIds: [sourceId(f.articles[2].url)] }, { authorizationContext: 'caller' },
    { policy: { allow: true } }, Object.create({ view: 'RECENT' }), getter, JSON.parse('{"__proto__":{"allow":true}}')];
  for (const input of inputs) await denied(queue, credential, 'INVALID_QUERY', input as SourceQueueQuery);
  assert.equal(getterCalls, 0);
}));

test('private injected repository fields never enter source responses or cursor payloads', async () => fixture(async f => {
  await f.repository.transact(state => {
    Object.assign(state.sources[0], { privateNotes: 'PRIVATE_SOURCE_NOTES', apiKey: 'PRIVATE_API_KEY' });
    Object.assign(state.managedSources[0], { rawProviderPayload: { articleBody: 'PRIVATE_PROVIDER_BODY' } });
    Object.assign(state.provenanceDecisions[0], { privateAudit: 'PRIVATE_AUDIT_DETAIL' });
  });
  const page = await f.queue().read(f.identities.accounts.editor.credential, { limit: 1 });
  const serialized = JSON.stringify([page, page.nextCursor && Buffer.from(page.nextCursor, 'base64url').toString('utf8')]);
  assert.doesNotMatch(serialized, /PRIVATE_|rawProviderPayload|apiKey|actorAssertion|evidenceReferences|privateNotes|articleBody/);
}));

test('unsafe stored source URLs remain withheld by the authoritative queue projection', async () => fixture(async f => {
  const id = sourceId(f.articles[0].url);
  await f.repository.transact(state => {
    state.managedSources.find(row => row.sourceId === id)!.providerMetadata.url = 'http://credential:PRIVATE_PASSWORD@127.0.0.1/private';
  });
  const page = await f.queue(f.policy([id])).read(f.identities.accounts.editor.credential);
  assert.equal(page.entries[0].canonicalUrl, null); assert.equal(page.entries[0].publisher, null);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE_PASSWORD|credential|127\.0\.0\.1/);
}));

test('the source facade exposes no approve, advance, mutate or publish operation', async () => fixture(async f => {
  const queue = f.queue();
  for (const key of ['approve', 'advance', 'publish', 'edit', 'resolve', 'createStory']) assert.equal(key in queue, false);
  const before = await readFile(f.repository.file, 'utf8');
  await queue.withPage(f.identities.accounts.editor.credential, undefined, page => { assert.ok(page.entries.every(entry => entry.canAdvance === false)); });
  assert.equal(await readFile(f.repository.file, 'utf8'), before);
}));
