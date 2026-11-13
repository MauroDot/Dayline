import test from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createEditorialHttpFixture } from '../fixtures/editorial-http-fiction.ts';
import { editorialAt } from '../fixtures/editorial-fiction.ts';
import { startInternalEditorialHTTP } from '../src/security/http.ts';
import { AccessControl } from '../src/security/service.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { runRevision, scheduleRevision } from '../src/security/resources.ts';
import type { State } from '../src/newsroom/model.ts';
import { createServer } from '../server.ts';

type Fixture = Awaited<ReturnType<typeof createEditorialHttpFixture>>;
type Running = NonNullable<Awaited<ReturnType<typeof startInternalEditorialHTTP>>>;
type Reply = { status: number; body: Record<string, unknown>; text: string; headers: IncomingHttpHeaders };
type Clock = { now: string };
type Context = { fixture: Fixture; server: Running; time: Clock };
function jsonObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function call(origin: string, path: string, credential: string, body?: unknown): Promise<Reply> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(origin + path, { method: data === undefined ? 'GET' : 'POST', headers: {
      authorization: `Bearer ${credential}`, ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
    } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => { try { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode!, body: jsonObject(text), text, headers: response.headers }); } catch (error) { reject(error); } });
      response.once('error', reject);
    });
    req.once('error', reject); req.end(data);
  });
}
function succeeded(reply: Reply): Record<string, unknown> { assert.ok(reply.status >= 200 && reply.status < 300, `HTTP ${reply.status}: ${reply.text}`); return reply.body; }
function editorial(state: State) { const { identities: _i, sessions: _s, securityAudit: _a, ...content } = state; return content; }
async function denied(context: Context, path: string, credential: string, body?: unknown): Promise<Reply> {
  const before = editorial(await context.fixture.repository.read());
  const reply = await call(context.server.origin, path, credential, body);
  assert.ok(reply.status >= 400, `Unexpected success: ${reply.text}`);
  assert.deepEqual(editorial(await context.fixture.repository.read()), before);
  assert.equal(reply.text.includes(credential), false);
  return reply;
}
async function withHTTP(run: (context: Context) => Promise<void>, configure?: (fixture: Fixture, time: Clock) => { repository: JsonRepository; access: AccessControl }): Promise<void> {
  const time = { now: editorialAt };
  const fixture = await createEditorialHttpFixture({ enabled: true, mode: 'development', clock: () => time.now });
  let server: Running | null = null;
  try {
    const dependencies = configure?.(fixture, time) ?? fixture;
    server = await startInternalEditorialHTTP({ enabled: true, mode: 'development', repository: dependencies.repository, access: dependencies.access, policy: fixture.policy });
    assert.ok(server);
    await run({ fixture, server, time });
  } finally { if (server) await server.close(); await fixture.dispose(); }
}

test('internal HTTP returns the current principal and permissions without session or provider credentials', async () => withHTTP(async ({ fixture, server }) => {
  const reply = await call(server.origin, '/internal/principal', fixture.accounts.editor.credential);
  const value = succeeded(reply);
  assert.equal(value.id, fixture.accounts.editor.identity.id);
  assert.deepEqual(value.roles, ['EDITOR']);
  assert.ok(Array.isArray(value.permissions) && value.permissions.includes('STORY_REVIEW'));
  assert.equal(reply.text.includes(fixture.accounts.editor.credential), false);
  assert.equal(reply.text.includes(fixture.accounts.editor.claims.sessionId), false);
  assert.equal(reply.text.includes(fixture.accounts.editor.identity.provider.subject), false);
}));

test('HTTP reporter preparation editor review and managing approval append exact authenticated story receipts', async () => withHTTP(async ({ fixture, server }) => {
  const { reporter, editor, managing } = fixture.accounts;
  let row = succeeded(await call(server.origin, '/internal/stories', reporter.credential, fixture.stories.proposed));
  assert.equal(row.status, 'INGESTED'); assert.equal(row.version, 1);
  const id = fixture.stories.proposed.id;
  row = succeeded(await call(server.origin, `/internal/stories/${id}/edit`, reporter.credential, { version: row.version, patch: { summary: 'A revised fictional summary for this local test.' } }));
  for (const status of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW']) {
    row = succeeded(await call(server.origin, `/internal/stories/${id}/review`, editor.credential, { version: row.version, status }));
    assert.equal(row.status, status);
  }
  row = succeeded(await call(server.origin, `/internal/stories/${id}/approve`, managing.credential, { version: row.version }));
  assert.equal(row.status, 'APPROVED');
  const state = await fixture.repository.read();
  const receipts = state.authenticatedActions.filter(action => action.resourceId === id);
  assert.equal(receipts.length, 6);
  assert.ok(receipts.some(action => action.actorId === reporter.identity.id && action.permission === 'STORY_CREATE' && action.resourceVersion === 1));
  assert.ok(receipts.some(action => action.actorId === managing.identity.id && action.permission === 'STORY_APPROVE' && action.resourceVersion === row.version));
  assert.equal(state.revisions.some(story => story.status === 'PUBLISHED'), false);
}));

test('HTTP role separation denies reporter review and editor or administrator approval', async () => withHTTP(async context => {
  const { fixture } = context, story = fixture.stories.review;
  await denied(context, `/internal/stories/${story.id}/review`, fixture.accounts.reporter.credential, { version: story.version, status: 'ON_HOLD' });
  for (const account of [fixture.accounts.editor, fixture.accounts.admin]) {
    const response = await denied(context, `/internal/stories/${story.id}/approve`, account.credential, { version: story.version });
    assert.equal(response.status, 403);
  }
}));

test('HTTP story targeting rejects stale revisions and assigned-role access to an unassigned resource', async () => withHTTP(async context => {
  const { fixture } = context;
  await denied(context, `/internal/stories/${fixture.stories.review.id}/approve`, fixture.accounts.managing.credential, { version: fixture.stories.review.version - 1 });
  const response = await denied(context, `/internal/stories/${fixture.stories.unassigned.id}/edit`, fixture.accounts.reporter.credential, { version: fixture.stories.unassigned.version, patch: { headline: 'Substituted fictional target' } });
  assert.equal(response.status, 403);
}));

test('HTTP creation does not infer assignments for arbitrary caller-chosen story identifiers', async () => withHTTP(async context => {
  await denied(context, '/internal/stories', context.fixture.accounts.reporter.credential,
    { ...context.fixture.stories.proposed, id: 'fictional-unassigned-new-story' });
}));

test('HTTP edition assembly retains exact approved story eligibility and separately assigned edition review', async () => withHTTP(async ({ fixture, server }) => {
  const assembled = succeeded(await call(server.origin, '/internal/editions', fixture.accounts.reporter.credential, fixture.editionInput));
  assert.equal(assembled.status, 'ASSEMBLING');
  let reviewed = succeeded(await call(server.origin, `/internal/editions/${fixture.edition.id}/review`, fixture.accounts.editor.credential, { revision: fixture.edition.revision, status: 'NEEDS_REVIEW' }));
  reviewed = succeeded(await call(server.origin, `/internal/editions/${fixture.edition.id}/review`, fixture.accounts.managing.credential, { revision: reviewed.revision, status: 'READY_FOR_APPROVAL' }));
  assert.equal(reviewed.status, 'READY_FOR_APPROVAL');
  const state = await fixture.repository.read();
  assert.ok(state.editionReviews.every(review => review.unauthenticated === true));
  assert.ok(state.authenticatedActions.some(action => action.permission === 'EDITION_READY' && action.resourceId === fixture.edition.id && action.resourceVersion === reviewed.revision));
}));

test('HTTP edition placement substitution and unassigned allocation slots cannot widen access', async () => withHTTP(async context => {
  const { fixture } = context;
  const substituted = { ...fixture.editionInput, placements: [{ storyId: fixture.stories.unassigned.id, storyVersion: fixture.stories.unassigned.version, section: 'TOP_STORIES' }] };
  await denied(context, '/internal/editions', fixture.accounts.reporter.credential, substituted);
  await denied(context, '/internal/editions', fixture.accounts.reporter.credential, { ...fixture.editionInput, date: '2026-06-15' });
  await denied(context, `/internal/editions/${fixture.edition.id}/review`, fixture.accounts.editor.credential, { revision: fixture.edition.revision + 1, status: 'NEEDS_REVIEW' });
}));

test('HTTP rejects stale and ineligible placement revisions without inventing content or clearing retention holds', async () => withHTTP(async context => {
  const { fixture } = context;
  await denied(context, '/internal/editions', fixture.accounts.reporter.credential, {
    ...fixture.editionInput, placements: fixture.editionInput.placements.map(placement => ({ ...placement, storyVersion: placement.storyVersion - 1 })),
  });
  await fixture.repository.transact(state => { state.retentionReviewRequired = true; });
  const reply = await call(context.server.origin, '/internal/editions', fixture.accounts.reporter.credential, fixture.editionInput);
  assert.ok(reply.status >= 400);
  const after = await fixture.repository.read();
  assert.equal(after.retentionReviewRequired, true);
  assert.equal(after.editions.some(edition => edition.date === fixture.editionInput.date), false);
}));

test('HTTP schedule status is scoped and controlled claim then pause preserves absence of publication', async () => withHTTP(async ({ fixture, server }) => {
  const status = succeeded(await call(server.origin, '/internal/schedules', fixture.accounts.managing.credential));
  assert.ok(Array.isArray(status.schedules) && status.schedules.some(schedule => schedule.id === fixture.schedule.id));
  assert.ok(Array.isArray(status.runs) && status.runs.some(run => run.id === fixture.run.id));
  const claimed = succeeded(await call(server.origin, `/internal/runs/${fixture.run.id}/claim`, fixture.accounts.editor.credential, { revision: runRevision(fixture.run) }));
  assert.equal(claimed.status, 'CLAIMED');
  const paused = succeeded(await call(server.origin, `/internal/schedules/${fixture.schedule.id}/pause`, fixture.accounts.admin.credential, { revision: scheduleRevision(fixture.schedule) }));
  assert.equal(paused.enabled, false);
  const after = await fixture.repository.read();
  assert.equal(after.preparationRuns.find(run => run.id === fixture.run.id)?.status, 'CANCELLED');
  assert.equal(after.revisions.some(story => story.status === 'PUBLISHED'), false);
}));

test('HTTP scheduler mutation requires exact current fingerprints and independent resource grants', async () => withHTTP(async context => {
  const { fixture } = context;
  await denied(context, `/internal/runs/${fixture.run.id}/claim`, fixture.accounts.editor.credential, { revision: '0'.repeat(64) });
  await denied(context, `/internal/schedules/${fixture.schedule.id}/pause`, fixture.accounts.managing.credential, { revision: '0'.repeat(64) });
  await denied(context, `/internal/runs/${randomUUID()}/claim`, fixture.accounts.editor.credential, { revision: runRevision(fixture.run) });
  await denied(context, '/internal/schedules', fixture.accounts.reporter.credential);
}));

test('HTTP self-revocation invalidates credential replay without an unauthenticated session-creation path', async () => withHTTP(async context => {
  const token = context.fixture.accounts.reporter.credential;
  succeeded(await call(context.server.origin, '/internal/session/revoke', token, {}));
  assert.equal((await denied(context, '/internal/principal', token)).status, 401);
  assert.equal((await denied(context, '/internal/session/revoke', token, {})).status, 401);
}));

test('HTTP signed but unregistered sessions and unknown identity issuer or audience fail closed', async () => withHTTP(async context => {
  const { fixture } = context;
  for (const patch of [{ sessionId: randomUUID() }, { subject: randomUUID() }, { issuer: 'urn:fictional:wrong' }, { audience: 'fictional-wrong-audience' }]) {
    const token = fixture.verifier.issue({ ...fixture.accounts.managing.claims, ...patch });
    const reply = await denied(context, `/internal/stories/${fixture.stories.review.id}/approve`, token, { version: fixture.stories.review.version });
    assert.equal(reply.status, 401);
  }
}));

test('HTTP revalidates current roles even when the credential was issued before demotion', async () => withHTTP(async context => {
  const { fixture, server } = context;
  await fixture.access.setRoles(fixture.accounts.admin.credential, fixture.accounts.managing.identity.id, 1, ['EDITOR']);
  const current = succeeded(await call(server.origin, '/internal/principal', fixture.accounts.managing.credential));
  assert.deepEqual(current.roles, ['EDITOR']);
  await denied(context, `/internal/stories/${fixture.stories.review.id}/approve`, fixture.accounts.managing.credential, { version: fixture.stories.review.version });
}));

for (const action of ['disable', 'rotate', 'revoke'] as const) test(`HTTP ${action} rejects an already registered managing-editor credential`, async () => withHTTP(async context => {
  const { fixture } = context, account = fixture.accounts.managing;
  if (action === 'disable') await fixture.access.setStatus(fixture.accounts.admin.credential, account.identity.id, 1, 'DISABLED');
  if (action === 'rotate') await fixture.access.rotateCredentials(fixture.accounts.admin.credential, account.identity.id, 1);
  if (action === 'revoke') await fixture.access.revokeSession(fixture.accounts.admin.credential, account.claims.sessionId);
  const reply = await denied(context, `/internal/stories/${fixture.stories.review.id}/approve`, account.credential, { version: fixture.stories.review.version });
  assert.equal(reply.status, 401);
}));

test('HTTP session expiry is enforced at the exact lifetime boundary', async () => withHTTP(async context => {
  context.time.now = context.fixture.accounts.managing.claims.expiresAt;
  const reply = await denied(context, `/internal/stories/${context.fixture.stories.review.id}/approve`, context.fixture.accounts.managing.credential, { version: context.fixture.stories.review.version });
  assert.equal(reply.status, 401);
}));

test('revocation while an HTTP body is in flight prevents its later editorial commit', async () => withHTTP(async context => {
  const { fixture, server } = context, account = fixture.accounts.managing;
  const data = JSON.stringify({ version: fixture.stories.review.version });
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  let finish!: () => void;
  const reply = new Promise<Reply>((resolve, reject) => {
    const req = request(`${server.origin}/internal/stories/${fixture.stories.review.id}/approve`, { method: 'POST', headers: {
      authorization: `Bearer ${account.credential}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
    } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => { try { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode!, text, body: jsonObject(text), headers: response.headers }); } catch (error) { reject(error); } });
      response.once('error', reject);
    });
    req.once('error', reject);
    req.write(data.slice(0, 1), begin);
    finish = () => req.end(data.slice(1));
  });
  await started;
  await fixture.access.revokeSession(fixture.accounts.admin.credential, account.claims.sessionId);
  const before = editorial(await fixture.repository.read());
  finish();
  assert.equal((await reply).status, 401);
  assert.deepEqual(editorial(await fixture.repository.read()), before);
}));

test('HTTP expiry after file sync rolls back story mutation and successful action receipts', async () => {
  let arm = false;
  await withHTTP(async context => {
    arm = true;
    const response = await denied(context, `/internal/stories/${context.fixture.stories.review.id}/approve`, context.fixture.accounts.managing.credential, { version: context.fixture.stories.review.version });
    assert.equal(response.status, 401);
  }, (fixture, time) => {
    const repository = new JsonRepository(fixture.repository.file, { beforeCommit: () => { if (arm) time.now = fixture.accounts.managing.claims.expiresAt; } });
    return { repository, access: new AccessControl(repository, { verifier: fixture.verifier, clock: () => time.now }) };
  });
});

test('HTTP storage commit failure creates neither editorial changes nor false success receipts or private errors', async () => {
  await withHTTP(async context => {
    const response = await denied(context, `/internal/stories/${context.fixture.stories.review.id}/approve`, context.fixture.accounts.managing.credential, { version: context.fixture.stories.review.version });
    assert.equal(response.status, 503);
    assert.equal(response.text.includes('synthetic-private-storage-detail'), false);
  }, (fixture, time) => {
    const repository = new JsonRepository(fixture.repository.file, { beforeCommit: () => { throw Error('synthetic-private-storage-detail'); } });
    return { repository, access: new AccessControl(repository, { verifier: fixture.verifier, clock: () => time.now }) };
  });
});

test('HTTP has no credential minting identity-admin legacy mutation or public publishing route', async () => withHTTP(async context => {
  for (const path of ['/internal/login', '/internal/token', '/internal/session/register', '/internal/identities', '/internal/admin', '/internal/publish', '/api/admin', '/api/editorial', '/internal/legacy/transition']) {
    const reply = await denied(context, path, context.fixture.accounts.admin.credential, {});
    assert.equal(reply.status, 404);
  }
  await denied(context, `/internal/stories/${context.fixture.stories.review.id}/review`, context.fixture.accounts.managing.credential, { version: context.fixture.stories.review.version, status: 'PUBLISHED' });
}));

test('an accepted HTTP self-revocation fences an older transaction while durable revocation waits for its lock', async () => {
  let reached!: () => void, release!: () => void, revoking!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const revokedStarted = new Promise<void>(resolve => { revoking = resolve; });
  class PausedRepository extends JsonRepository {
    reads = 0;
    transactions = 0;
    override async read(): Promise<State> {
      const state = await super.read();
      if (++this.reads === 2) { reached(); await gate; }
      return state;
    }
    override async transactGuarded<T>(change: (state: State) => T, guard: (state: State) => void): Promise<T> {
      if (++this.transactions === 2) revoking();
      return super.transactGuarded(change, guard);
    }
  }
  await withHTTP(async context => {
    const { fixture, server } = context, token = fixture.accounts.managing.credential;
    const before = editorial(await fixture.repository.read());
    const approval = call(server.origin, `/internal/stories/${fixture.stories.review.id}/approve`, token, { version: fixture.stories.review.version });
    await waiting;
    const revocation = call(server.origin, '/internal/session/revoke', token, {});
    await revokedStarted;
    release();
    assert.equal((await approval).status, 401);
    succeeded(await revocation);
    assert.deepEqual(editorial(await fixture.repository.read()), before);
    assert.ok((await fixture.repository.read()).sessions.find(session => session.id === fixture.accounts.managing.claims.sessionId)?.revokedAt);
    assert.equal((await call(server.origin, '/internal/principal', token)).status, 401);
  }, (fixture, time) => {
    const repository = new PausedRepository(fixture.repository.file);
    return { repository, access: new AccessControl(repository, { verifier: fixture.provider, clock: () => time.now }) };
  });
});

test('HTTP trusted verifier revocation at the final commit check rolls back already staged editorial success', async () => {
  let revoked = false;
  await withHTTP(async context => {
    const reply = await denied(context, `/internal/stories/${context.fixture.stories.review.id}/approve`, context.fixture.accounts.managing.credential, { version: context.fixture.stories.review.version });
    assert.equal(reply.status, 401);
    assert.equal(reply.text.includes('fictional-provider-revocation-detail'), false);
    assert.equal(revoked, true);
  }, (fixture, time) => {
    const repository = new JsonRepository(fixture.repository.file, { beforeCommit: () => { revoked = true; } });
    const verifier = { issuer: fixture.provider.issuer, audience: fixture.provider.audience, maxSessionMs: fixture.provider.maxSessionMs,
      verify(credential: unknown) { if (revoked) throw Error('fictional-provider-revocation-detail'); return fixture.provider.verify(credential); } };
    return { repository, access: new AccessControl(repository, { verifier, clock: () => time.now }) };
  });
});

test('a role change committed after HTTP authentication but before the mutation lock denies the requested approval', async () => {
  let reached!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  class QueuedRepository extends JsonRepository {
    transactions = 0;
    override async transactGuarded<T>(change: (state: State) => T, guard: (state: State) => void): Promise<T> {
      if (++this.transactions === 1) { reached(); await gate; }
      return super.transactGuarded(change, guard);
    }
  }
  await withHTTP(async context => {
    const { fixture, server } = context;
    const pending = call(server.origin, `/internal/stories/${fixture.stories.review.id}/approve`, fixture.accounts.managing.credential, { version: fixture.stories.review.version });
    await waiting;
    await fixture.access.setRoles(fixture.accounts.admin.credential, fixture.accounts.managing.identity.id, 1, ['EDITOR']);
    const before = editorial(await fixture.repository.read());
    release();
    assert.equal((await pending).status, 403);
    assert.deepEqual(editorial(await fixture.repository.read()), before);
  }, (fixture, time) => {
    const repository = new QueuedRepository(fixture.repository.file);
    return { repository, access: new AccessControl(repository, { verifier: fixture.provider, clock: () => time.now }) };
  });
});

test('HTTP caller role principal and status assertions cannot become creation or edit authority', async () => withHTTP(async context => {
  const { fixture } = context;
  for (const fields of [{ roles: ['ADMINISTRATOR'] }, { principal: fixture.accounts.managing.identity.id }, { status: 'APPROVED', version: 9 }]) {
    await denied(context, '/internal/stories', fixture.accounts.reporter.credential, { ...fixture.stories.proposed, ...fields });
  }
  await denied(context, `/internal/stories/${fixture.stories.review.id}/edit`, fixture.accounts.reporter.credential,
    { version: fixture.stories.review.version, patch: { status: 'APPROVED' } });
}));

test('public reader listener never acquires internal authenticated mutation routes or accepts their bearer credentials', async () => withHTTP(async ({ fixture }) => {
  const publicServer = createServer({ fetcher: async () => { throw Error('Unexpected external request in local isolation test'); } });
  await new Promise<void>(resolve => publicServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = publicServer.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const before = await fixture.repository.read();
    for (const path of ['/internal/principal', '/internal/stories', '/internal/session/revoke', '/internal/schedules', '/api/auth/login', '/api/admin']) {
      assert.equal((await call(origin, path, fixture.accounts.admin.credential)).status, 404);
      assert.equal((await call(origin, path, fixture.accounts.admin.credential, {})).status, 405);
    }
    assert.equal((await call(origin, '/api/health', fixture.accounts.admin.credential)).status, 200);
    assert.deepEqual(await fixture.repository.read(), before);
  } finally { await new Promise<void>((resolve, reject) => publicServer.close(error => error ? reject(error) : resolve())); }
}));
