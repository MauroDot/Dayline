import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSecurityFixture, securityAt } from '../fixtures/security-fiction.ts';
import { seedEditorialFixture } from '../fixtures/editorial-fiction.ts';
import { seedEditionFixture } from '../fixtures/edition-fiction.ts';
import { AccessControl } from '../src/security/service.ts';
import { AuthenticatedEditorial } from '../src/security/editorial.ts';
import { EditorialService } from '../src/editorial/service.ts';
import { EditionService } from '../src/editions/service.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import type { State, Story } from '../src/newsroom/model.ts';
import type { VerifiedSessionClaims } from '../src/security/types.ts';
import { createServer } from '../server.ts';

type SecurityFixture = Awaited<ReturnType<typeof seedSecurityFixture>>;
const plus = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();

async function withSecurity(run: (repository: JsonRepository, fixture: SecurityFixture, access: AccessControl, workflow: AuthenticatedEditorial, time: { now: string }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-security-integration-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const fixture = await seedSecurityFixture(repository);
    const time = { now: securityAt };
    const access = new AccessControl(repository, { verifier: fixture.verifier, clock: () => time.now });
    await run(repository, fixture, access, new AuthenticatedEditorial(repository, access), time);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function editorialState(state: State) {
  const { identities: _, sessions: __, securityAudit: ___, ...editorial } = state;
  return editorial;
}
async function denied(repository: JsonRepository, action: () => Promise<unknown>): Promise<void> {
  const before = editorialState(await repository.read());
  await assert.rejects(action());
  assert.deepEqual(editorialState(await repository.read()), before);
}
async function storyForReview(repository: JsonRepository) {
  const fixture = await seedEditorialFixture(repository, securityAt);
  const story = await fixture.newsroom.transition(fixture.story.id, 'NEEDS_REVIEW', 'fictional-fixture-editor');
  return { ...fixture, story };
}
function freshClaims(fixture: SecurityFixture, patch: Partial<VerifiedSessionClaims> = {}): VerifiedSessionClaims {
  return { ...fixture.accounts.managing.claims, sessionId: randomUUID(), ...patch };
}
async function shortenSourceDeadline(repository: JsonRepository, sourceIds: string[]): Promise<string> {
  const deadline = plus(securityAt, 30_000);
  await repository.transact(state => {
    for (const record of state.managedSources) if (sourceIds.includes(record.sourceId)) record.deleteAt = deadline;
  });
  return deadline;
}

test('synthetic accounts register opaque metadata without persisting credentials or the fixture key', async () => {
  await withSecurity(async (repository, fixture) => {
    const state = await repository.read();
    assert.equal(state.identities.length, 4); assert.equal(state.sessions.length, 4);
    assert.deepEqual(state.identities.map(identity => identity.roles), [['REPORTER'], ['EDITOR'], ['MANAGING_EDITOR'], ['ADMINISTRATOR']]);
    assert.ok(state.identities.every(identity => /^[a-f0-9-]{36}$/.test(identity.id) && /^[a-f0-9-]{36}$/.test(identity.provider.subject)));
    const serialized = JSON.stringify(state);
    for (const account of Object.values(fixture.accounts)) assert.equal(serialized.includes(account.credential), false);
    assert.equal(serialized.includes(Buffer.alloc(32, 7).toString('base64url')), false);
    assert.equal(serialized.includes('fixture-key'), true);
  });
});

test('a current managing-editor session approves the exact story revision with an authenticated receipt', async () => {
  await withSecurity(async (repository, fixture, _access, workflow) => {
    const source = await storyForReview(repository);
    const result = await workflow.approveStory(fixture.accounts.managing.credential, source.story.id, source.story.version);
    assert.equal(result.status, 'APPROVED'); assert.equal(result.version, source.story.version + 1);
    const state = await repository.read();
    assert.ok(state.approvals.some(approval => approval.storyId === result.id && approval.version === result.version));
    assert.ok(state.authenticatedActions.some(action => action.actorId === fixture.accounts.managing.identity.id
      && action.permission === 'STORY_APPROVE' && action.resourceId === result.id && action.resourceVersion === result.version));
  });
});

test('reporter editor and administrator sessions cannot approve stories or change editorial arrays', async () => {
  await withSecurity(async (repository, fixture, _access, workflow) => {
    const source = await storyForReview(repository);
    for (const account of [fixture.accounts.reporter, fixture.accounts.editor, fixture.accounts.admin]) {
      await denied(repository, () => workflow.approveStory(account.credential, source.story.id, source.story.version));
    }
    assert.equal((await repository.read()).approvals.length, 0);
  });
});

test('an authenticated story approval refuses a stale exact-version target', async () => {
  await withSecurity(async (repository, fixture, _access, workflow) => {
    const source = await storyForReview(repository);
    await denied(repository, () => workflow.approveStory(fixture.accounts.managing.credential, source.story.id, source.story.version - 1));
  });
});

test('reporter creation editor review stages and managing approval use protected exact-version commands', async () => {
  await withSecurity(async (repository, fixture, _access, workflow) => {
    const source = await seedEditorialFixture(repository, securityAt);
    const { status: _, version: __, ...template } = source.story;
    let story = await workflow.createStory(fixture.accounts.reporter.credential, { ...template, id: 'fictional-protected-workflow-story' });
    assert.equal(story.status, 'INGESTED');
    await denied(repository, () => workflow.reviewStory(fixture.accounts.reporter.credential, story.id, story.version, 'CLUSTERED'));
    for (const next of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW'] as const) story = await workflow.reviewStory(fixture.accounts.editor.credential, story.id, story.version, next);
    await denied(repository, () => workflow.reviewStory(fixture.accounts.editor.credential, story.id, story.version, 'APPROVED'));
    await denied(repository, () => workflow.reviewStory(fixture.accounts.managing.credential, story.id, story.version, 'APPROVED'));
    await denied(repository, () => workflow.reviewStory(fixture.accounts.managing.credential, story.id, story.version, 'PUBLISHED'));
    const approved = await workflow.approveStory(fixture.accounts.managing.credential, story.id, story.version);
    assert.equal(approved.status, 'APPROVED');
    const state = await repository.read();
    const actions = state.authenticatedActions.filter(action => action.resourceId === story.id);
    assert.ok(actions.some(action => action.actorId === fixture.accounts.reporter.identity.id && action.permission === 'STORY_CREATE' && action.resourceVersion === 1));
    assert.equal(actions.filter(action => action.actorId === fixture.accounts.editor.identity.id && action.permission === 'STORY_REVIEW').length, 3);
    assert.ok(actions.some(action => action.actorId === fixture.accounts.managing.identity.id && action.permission === 'STORY_APPROVE' && action.resourceVersion === approved.version));
    assert.equal(state.revisions.some(revision => revision.status === 'PUBLISHED'), false);
  });
});

test('protected story creation rejects password role and nested authority fields without retaining them', async () => {
  await withSecurity(async (repository, fixture, _access, workflow) => {
    const source = await seedEditorialFixture(repository, securityAt);
    const { status: _, version: __, ...template } = source.story;
    const extra = [{ password: 'fictional-password-must-not-persist' }, { roles: ['ADMINISTRATOR'] }, { status: 'APPROVED' }, { version: 99 }];
    for (const [index, fields] of extra.entries()) {
      const candidate = { ...template, id: `fictional-extra-fields-${index}`, ...fields };
      await denied(repository, () => workflow.createStory(fixture.accounts.reporter.credential, candidate as Omit<Story, 'status' | 'version'>));
    }
    const nested = { ...template, id: 'fictional-nested-authority', evidence: template.evidence.map(evidence => ({ ...evidence, authenticated: true })) };
    await denied(repository, () => workflow.createStory(fixture.accounts.reporter.credential, nested));
    assert.equal(JSON.stringify(await repository.read()).includes('fictional-password-must-not-persist'), false);
  });
});

test('caller role and principal assertions are not accepted as credentials', async () => {
  await withSecurity(async (repository, fixture, _access, workflow) => {
    const source = await storyForReview(repository);
    for (const forged of [{ roles: ['MANAGING_EDITOR'], credential: fixture.accounts.reporter.credential },
      { identityId: fixture.accounts.managing.identity.id, identityRevision: 1, sessionRef: 'caller-selected-ref', sessionId: fixture.accounts.managing.claims.sessionId },
      { ...fixture.accounts.managing.claims }]) {
      await denied(repository, () => workflow.approveStory(forged as unknown as string, source.story.id, source.story.version));
    }
  });
});

test('signed credentials require explicit registered sessions and a known provider identity', async () => {
  await withSecurity(async (repository, fixture, access, workflow) => {
    const source = await storyForReview(repository);
    const unregistered = fixture.verifier.issue(freshClaims(fixture));
    await denied(repository, () => workflow.approveStory(unregistered, source.story.id, source.story.version));
    const unknown = fixture.verifier.issue(freshClaims(fixture, { subject: randomUUID() }));
    const before = (await repository.read()).sessions;
    await assert.rejects(access.registerSession(unknown));
    assert.deepEqual((await repository.read()).sessions, before);
  });
});

test('a verifier revoked during registration cannot partially persist a new session', async () => {
  for (const failOn of [2, 3]) {
    await withSecurity(async (repository, fixture, _access, _workflow, time) => {
      const credential = fixture.verifier.issue(freshClaims(fixture));
      let calls = 0;
      const verifier = { issuer: fixture.verifier.issuer, audience: fixture.verifier.audience, maxSessionMs: fixture.verifier.maxSessionMs,
        verify(value: unknown) { if (++calls === failOn) throw Error('fictional private verifier diagnostic'); return fixture.verifier.verify(value); } };
      const before = await repository.read();
      const access = new AccessControl(repository, { verifier, clock: () => time.now });
      await assert.rejects(access.registerSession(credential), error => error instanceof Error && !error.message.includes('private verifier diagnostic'));
      const after = await repository.read();
      assert.deepEqual(after.sessions, before.sessions);
      assert.deepEqual(editorialState(after), editorialState(before));
      assert.equal(JSON.stringify(after).includes(credential), false);
      assert.ok(calls >= failOn);
    });
  }
});

test('wrong issuer or audience cannot create sessions or authorize an editorial action', async () => {
  await withSecurity(async (repository, fixture, access, workflow) => {
    const source = await storyForReview(repository);
    for (const patch of [{ issuer: 'urn:fictional:wrong-issuer' }, { audience: 'fictional-wrong-audience' }]) {
      const credential = fixture.verifier.issue(freshClaims(fixture, patch));
      await assert.rejects(access.registerSession(credential));
      await denied(repository, () => workflow.approveStory(credential, source.story.id, source.story.version));
    }
    assert.equal((await repository.read()).sessions.length, 4);
  });
});

test('session expiry at its exact boundary blocks approval without mutating editorial data', async () => {
  await withSecurity(async (repository, fixture, _access, workflow, time) => {
    const source = await storyForReview(repository);
    time.now = fixture.accounts.managing.claims.expiresAt;
    await denied(repository, () => workflow.approveStory(fixture.accounts.managing.credential, source.story.id, source.story.version));
  });
});

test('a signed future session is not registered or usable before its validity interval', async () => {
  await withSecurity(async (repository, fixture, access, workflow) => {
    const source = await storyForReview(repository);
    const credential = fixture.verifier.issue(freshClaims(fixture, { authenticatedAt: plus(securityAt, 1000), notBefore: plus(securityAt, 1000), expiresAt: plus(securityAt, 61_000) }));
    await assert.rejects(access.registerSession(credential));
    await denied(repository, () => workflow.approveStory(credential, source.story.id, source.story.version));
  });
});

test('disabling an identity takes effect for an already registered session', async () => {
  await withSecurity(async (repository, fixture, access, workflow) => {
    const source = await storyForReview(repository);
    await access.setStatus(fixture.accounts.admin.credential, fixture.accounts.managing.identity.id, 1, 'DISABLED');
    await denied(repository, () => workflow.approveStory(fixture.accounts.managing.credential, source.story.id, source.story.version));
  });
});

test('role demotion removes authority from existing sessions at action time', async () => {
  await withSecurity(async (repository, fixture, access, workflow) => {
    const source = await storyForReview(repository);
    await access.setRoles(fixture.accounts.admin.credential, fixture.accounts.managing.identity.id, 1, ['EDITOR']);
    await denied(repository, () => workflow.approveStory(fixture.accounts.managing.credential, source.story.id, source.story.version));
  });
});

test('role promotion is read from current identity metadata rather than frozen credential claims', async () => {
  await withSecurity(async (repository, fixture, access, workflow) => {
    const source = await storyForReview(repository);
    await access.setRoles(fixture.accounts.admin.credential, fixture.accounts.editor.identity.id, 1, ['MANAGING_EDITOR']);
    const approved = await workflow.approveStory(fixture.accounts.editor.credential, source.story.id, source.story.version);
    assert.equal(approved.status, 'APPROVED');
  });
});

test('credential rotation invalidates old sessions and requires a freshly registered version', async () => {
  await withSecurity(async (repository, fixture, access, workflow) => {
    const source = await storyForReview(repository);
    const rotated = await access.rotateCredentials(fixture.accounts.admin.credential, fixture.accounts.managing.identity.id, 1);
    await denied(repository, () => workflow.approveStory(fixture.accounts.managing.credential, source.story.id, source.story.version));
    const credential = fixture.verifier.issue(freshClaims(fixture, { credentialVersion: rotated.credentialVersion }));
    await access.registerSession(credential);
    assert.equal((await workflow.approveStory(credential, source.story.id, source.story.version)).status, 'APPROVED');
  });
});

test('administrator revocation and self invalidation revoke current session capabilities', async () => {
  for (const mode of ['administrator', 'self'] as const) {
    await withSecurity(async (repository, fixture, access, workflow) => {
      const source = await storyForReview(repository);
      if (mode === 'administrator') await access.revokeSession(fixture.accounts.admin.credential, fixture.accounts.managing.claims.sessionId);
      else await access.invalidateSession(fixture.accounts.managing.credential);
      await denied(repository, () => workflow.approveStory(fixture.accounts.managing.credential, source.story.id, source.story.version));
      const session = (await repository.read()).sessions.find(session => session.id === fixture.accounts.managing.claims.sessionId);
      assert.ok(session?.revokedAt);
    });
  }
});

test('re-registering a revoked signed session cannot resurrect editorial authority', async () => {
  await withSecurity(async (repository, fixture, access, workflow) => {
    const source = await storyForReview(repository);
    await access.revokeSession(fixture.accounts.admin.credential, fixture.accounts.managing.claims.sessionId);
    try { await access.registerSession(fixture.accounts.managing.credential); } catch { /* Rejection or a revoked record are both non-authorizing. */ }
    await denied(repository, () => workflow.approveStory(fixture.accounts.managing.credential, source.story.id, source.story.version));
    assert.ok((await repository.read()).sessions.find(session => session.id === fixture.accounts.managing.claims.sessionId)?.revokedAt);
  });
});

test('editorial roles cannot administer identities or revoke other users sessions', async () => {
  await withSecurity(async (repository, fixture, access) => {
    const before = await repository.read();
    for (const account of [fixture.accounts.reporter, fixture.accounts.editor, fixture.accounts.managing]) {
      await assert.rejects(access.setRoles(account.credential, fixture.accounts.editor.identity.id, 1, ['ADMINISTRATOR']));
      await assert.rejects(access.revokeSession(account.credential, fixture.accounts.admin.claims.sessionId));
    }
    const after = await repository.read();
    assert.deepEqual(after.identities, before.identities); assert.deepEqual(after.sessions, before.sessions);
    assert.deepEqual(editorialState(after), editorialState(before));
  });
});

test('concurrent identity edits accept one current revision and reject the stale competing revision', async () => {
  await withSecurity(async (repository, fixture, access) => {
    const results = await Promise.allSettled([
      access.setRoles(fixture.accounts.admin.credential, fixture.accounts.editor.identity.id, 1, ['REPORTER']),
      access.setRoles(fixture.accounts.admin.credential, fixture.accounts.editor.identity.id, 1, ['MANAGING_EDITOR']),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const identity = (await repository.read()).identities.find(identity => identity.id === fixture.accounts.editor.identity.id)!;
    assert.equal(identity.revision, 2);
    assert.ok(identity.roles.length === 1 && ['REPORTER', 'MANAGING_EDITOR'].includes(identity.roles[0]));
  });
});

test('queued approval reads role changes and session revocation before its protected transaction', { timeout: 5000 }, async () => {
  for (const mode of ['roles', 'session'] as const) {
    await withSecurity(async (repository, fixture, access, _workflow, time) => {
      const source = await storyForReview(repository);
      let release!: () => void; let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { entered = resolve; });
      class GatedRepository extends JsonRepository {
        override async transactGuarded<T>(change: (state: State) => T, guard: (state: State) => void): Promise<T> {
          entered(); await gate; return super.transactGuarded(change, guard);
        }
      }
      const gated = new GatedRepository(repository.file);
      const workflow = new AuthenticatedEditorial(gated, new AccessControl(gated, { verifier: fixture.verifier, clock: () => time.now }));
      const attempt = workflow.approveStory(fixture.accounts.managing.credential, source.story.id, source.story.version);
      try {
        await ready;
        if (mode === 'roles') await access.setRoles(fixture.accounts.admin.credential, fixture.accounts.managing.identity.id, 1, ['EDITOR']);
        else await access.revokeSession(fixture.accounts.admin.credential, fixture.accounts.managing.claims.sessionId);
        const before = editorialState(await repository.read());
        release(); await assert.rejects(attempt);
        assert.deepEqual(editorialState(await repository.read()), before);
      } finally { release(); }
    });
  }
});

test('expiry after filesystem staging is rechecked before an approval can commit', async () => {
  await withSecurity(async (repository, fixture, _access, _workflow, time) => {
    const source = await storyForReview(repository);
    let staged = false;
    const guardedRepository = new JsonRepository(repository.file, { beforeCommit: () => { staged = true; time.now = fixture.accounts.managing.claims.expiresAt; } });
    const access = new AccessControl(guardedRepository, { verifier: fixture.verifier, clock: () => time.now });
    const workflow = new AuthenticatedEditorial(guardedRepository, access);
    await denied(repository, () => workflow.approveStory(fixture.accounts.managing.credential, source.story.id, source.story.version));
    assert.equal(staged, true);
    assert.equal((await repository.read()).approvals.length, 0);
  });
});

test('storage failure cannot partially approve a story or leak the underlying exception', async () => {
  await withSecurity(async (repository, fixture, _access, _workflow, time) => {
    const source = await storyForReview(repository);
    const failing = new JsonRepository(repository.file, { beforeCommit: () => { throw Error('fictional private storage diagnostic'); } });
    const workflow = new AuthenticatedEditorial(failing, new AccessControl(failing, { verifier: fixture.verifier, clock: () => time.now }));
    const before = editorialState(await repository.read());
    await assert.rejects(workflow.approveStory(fixture.accounts.managing.credential, source.story.id, source.story.version), error => error instanceof Error && !error.message.includes('private storage diagnostic'));
    assert.deepEqual(editorialState(await repository.read()), before);
    assert.equal((await repository.read()).approvals.length, 0);
  });
});

test('draft review uses editor permission, managing-editor readiness and exact proposal versions', async () => {
  await withSecurity(async (repository, fixture, _access, workflow) => {
    const source = await seedEditorialFixture(repository, securityAt);
    const draft = await new EditorialService(repository, { clock: () => securityAt }).generate(source.story.id, source.story.version);
    const reviewed = await workflow.reviewDraft(fixture.accounts.editor.credential, draft.id, draft.version, 'NEEDS_REVIEW');
    assert.equal(reviewed.status, 'NEEDS_REVIEW');
    await denied(repository, () => workflow.reviewDraft(fixture.accounts.editor.credential, draft.id, reviewed.version, 'READY_FOR_APPROVAL'));
    await denied(repository, () => workflow.reviewDraft(fixture.accounts.managing.credential, draft.id, draft.version, 'READY_FOR_APPROVAL'));
    const ready = await workflow.reviewDraft(fixture.accounts.managing.credential, draft.id, reviewed.version, 'READY_FOR_APPROVAL');
    assert.equal(ready.status, 'READY_FOR_APPROVAL');
    assert.ok((await repository.read()).authenticatedActions.some(action => action.permission === 'DRAFT_READY' && action.resourceVersion === ready.version));
  });
});

test('an administrator identity does not inherit editorial draft review permission', async () => {
  await withSecurity(async (repository, fixture, _access, workflow) => {
    const source = await seedEditorialFixture(repository, securityAt);
    const draft = await new EditorialService(repository, { clock: () => securityAt }).generate(source.story.id, source.story.version);
    await denied(repository, () => workflow.reviewDraft(fixture.accounts.admin.credential, draft.id, draft.version, 'NEEDS_REVIEW'));
  });
});

test('authorized expired-draft review preserves lifecycle scrubbing when the requested review is rejected', async () => {
  await withSecurity(async (repository, fixture, _access, workflow, time) => {
    const source = await seedEditorialFixture(repository, securityAt);
    const deadline = await shortenSourceDeadline(repository, source.sources);
    const draft = await new EditorialService(repository, { clock: () => securityAt }).generate(source.story.id, source.story.version);
    assert.equal(draft.expiresAt, deadline);
    time.now = plus(deadline, 1000);
    await assert.rejects(workflow.reviewDraft(fixture.accounts.managing.credential, draft.id, draft.version, 'NEEDS_REVIEW'));
    const state = await repository.read();
    const invalid = state.drafts.find(value => value.id === draft.id)!;
    assert.equal(invalid.status, 'INVALIDATED');
    const serialized = JSON.stringify(invalid);
    for (const value of [draft.storyId, draft.output.headline, ...draft.sourceIds]) assert.equal(serialized.includes(value), false);
    assert.equal(state.authenticatedActions.length, 0);
  });
});

test('authorized expired-edition review scrubs every historical edition revision before rejecting', async () => {
  await withSecurity(async (repository, fixture, _access, workflow, time) => {
    const source = await seedEditionFixture(repository, securityAt);
    const deadline = await shortenSourceDeadline(repository, source.sources);
    const editions = new EditionService(repository, { clock: () => securityAt });
    const edition = await editions.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: source.story.id, storyVersion: source.story.version, section: 'TOP_STORIES' },
    ] }, 'fictional-fixture-editor');
    const reviewed = await editions.review(edition.id, edition.revision, 'NEEDS_REVIEW', 'fictional-fixture-editor');
    assert.equal(edition.sections[0].placements[0].expiresAt, deadline);
    time.now = plus(deadline, 1000);
    await assert.rejects(workflow.reviewEdition(fixture.accounts.managing.credential, edition.id, reviewed.revision, 'READY_FOR_APPROVAL'));
    const state = await repository.read();
    const history = state.editions.filter(value => value.id === edition.id);
    assert.equal(history.length, 2); assert.ok(history.every(value => value.status === 'INVALIDATED'));
    const serialized = JSON.stringify(history);
    for (const value of [source.story.id, source.story.headline, source.story.summary, ...source.sources]) assert.equal(serialized.includes(value), false);
    assert.equal(state.authenticatedActions.length, 0);
  });
});

test('initial permission denial cannot invoke draft or edition lifecycle mutations', async () => {
  for (const kind of ['draft', 'edition'] as const) {
    await withSecurity(async (repository, fixture, _access, workflow, time) => {
      const source = kind === 'draft' ? await seedEditorialFixture(repository, securityAt) : await seedEditionFixture(repository, securityAt);
      const deadline = await shortenSourceDeadline(repository, source.sources);
      if (kind === 'draft') {
        const draft = await new EditorialService(repository, { clock: () => securityAt }).generate(source.story.id, source.story.version);
        time.now = plus(deadline, 1000);
        await denied(repository, () => workflow.reviewDraft(fixture.accounts.admin.credential, draft.id, draft.version, 'NEEDS_REVIEW'));
      } else {
        const edition = await new EditionService(repository, { clock: () => securityAt }).create({ date: '2026-06-01', timezone: 'UTC', placements: [
          { storyId: source.story.id, storyVersion: source.story.version, section: 'TOP_STORIES' },
        ] }, 'fictional-fixture-editor');
        time.now = plus(deadline, 1000);
        await denied(repository, () => workflow.reviewEdition(fixture.accounts.admin.credential, edition.id, edition.revision, 'NEEDS_REVIEW'));
      }
    });
  }
});

test('the final session guard also rolls back lifecycle scrubbing when authority expires during staging', async () => {
  await withSecurity(async (repository, fixture, _access, _workflow, time) => {
    const source = await seedEditorialFixture(repository, securityAt);
    const deadline = await shortenSourceDeadline(repository, source.sources);
    const draft = await new EditorialService(repository, { clock: () => securityAt }).generate(source.story.id, source.story.version);
    time.now = plus(deadline, 1000);
    let staged = false;
    const guarded = new JsonRepository(repository.file, { beforeCommit: () => { staged = true; time.now = fixture.accounts.managing.claims.expiresAt; } });
    const workflow = new AuthenticatedEditorial(guarded, new AccessControl(guarded, { verifier: fixture.verifier, clock: () => time.now }));
    await denied(repository, () => workflow.reviewDraft(fixture.accounts.managing.credential, draft.id, draft.version, 'NEEDS_REVIEW'));
    assert.equal(staged, true);
    assert.equal((await repository.read()).drafts.find(value => value.id === draft.id)?.status, 'GENERATED');
  });
});

test('edition review and readiness preserve exact revisions and remain nonpublic', async () => {
  await withSecurity(async (repository, fixture, _access, workflow) => {
    const source = await seedEditionFixture(repository, securityAt);
    const edition = await new EditionService(repository, { clock: () => securityAt }).create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: source.story.id, storyVersion: source.story.version, section: 'TOP_STORIES' },
    ] }, 'fictional-fixture-editor');
    const reviewed = await workflow.reviewEdition(fixture.accounts.editor.credential, edition.id, edition.revision, 'NEEDS_REVIEW');
    assert.equal(reviewed.status, 'NEEDS_REVIEW');
    await denied(repository, () => workflow.reviewEdition(fixture.accounts.editor.credential, edition.id, reviewed.revision, 'READY_FOR_APPROVAL'));
    await denied(repository, () => workflow.reviewEdition(fixture.accounts.managing.credential, edition.id, edition.revision, 'READY_FOR_APPROVAL'));
    const ready = await workflow.reviewEdition(fixture.accounts.managing.credential, edition.id, reviewed.revision, 'READY_FOR_APPROVAL');
    assert.equal(ready.status, 'READY_FOR_APPROVAL');
    const state = await repository.read();
    assert.ok(state.authenticatedActions.some(action => action.permission === 'EDITION_READY' && action.resourceVersion === ready.revision));
    assert.equal(state.audit.some(event => /PUBLISHED/.test(event.action)), false);
  });
});

test('schedule configuration and execution use separate permissions and do not approve prepared editions', async () => {
  await withSecurity(async (repository, fixture, _access, workflow, time) => {
    const definition = { name: 'Fictional secured preparation', timezone: 'UTC', localTime: '12:01', weekdays: [0,1,2,3,4,5,6], enabled: true };
    await denied(repository, () => workflow.createSchedule(fixture.accounts.editor.credential, definition));
    await denied(repository, () => workflow.createSchedule(fixture.accounts.reporter.credential, definition));
    await workflow.createSchedule(fixture.accounts.managing.credential, definition);
    time.now = '2026-06-01T12:01:00.000Z';
    const evaluated = await workflow.evaluateSchedules(fixture.accounts.editor.credential);
    assert.equal(evaluated.runs.length, 1);
    const run = evaluated.runs[0];
    await denied(repository, () => workflow.claimRun(fixture.accounts.reporter.credential, run.id));
    const claimed = await workflow.claimRun(fixture.accounts.editor.credential, run.id); assert.ok(claimed.claimId);
    await workflow.beginRun(fixture.accounts.editor.credential, run.id, claimed.claimId);
    const prepared = await workflow.prepareRun(fixture.accounts.editor.credential, run.id, claimed.claimId);
    assert.equal(prepared.status, 'PREPARED');
    const state = await repository.read();
    assert.equal(state.editions.length, 1); assert.equal(state.editions[0].status, 'ASSEMBLING');
    assert.deepEqual(state.approvals, []); assert.deepEqual(state.editionReviews, []);
  });
});

test('security events contain bounded codes and opaque references instead of tokens or provider subjects', async () => {
  await withSecurity(async (repository, fixture, access) => {
    const marker = 'fictional-credential-payload-must-not-be-audit-data';
    await assert.rejects(access.registerSession(marker));
    const events = (await repository.read()).securityAudit;
    assert.ok(events.length > 0);
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes(marker), false);
    for (const account of Object.values(fixture.accounts)) {
      assert.equal(serialized.includes(account.credential), false);
      assert.equal(serialized.includes(account.identity.provider.subject), false);
    }
    for (const event of events) assert.deepEqual(Object.keys(event).sort(), ['id','at','category','code','userRef','sessionRef','subjectRef','permission'].sort());
  });
});

test('the actual HTTP server exposes no login identity administration or protected editorial endpoints', async () => {
  let upstream = 0;
  const server = createServer({ fetcher: (async () => { upstream++; throw Error('No upstream is permitted'); }) as typeof fetch });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ['/api/login', '/api/auth/session', '/api/admin/users', '/api/editorial/approve', '/api/schedules', '/dev/security', '/src/security/service.ts']) {
      assert.equal((await fetch(base + path)).status, 404, path);
      assert.equal((await fetch(base + path, { method: 'POST' })).status, 405, path);
    }
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal(upstream, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
