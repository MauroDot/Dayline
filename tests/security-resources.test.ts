import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSecurityFixture, securityAt } from '../fixtures/security-fiction.ts';
import { seedEditorialFixture } from '../fixtures/editorial-fiction.ts';
import { seedEditionFixture } from '../fixtures/edition-fiction.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { AccessControl } from '../src/security/service.ts';
import { AuthenticatedEditorial } from '../src/security/editorial.ts';
import { AssignedResourcePolicy, editionSlot, scheduleRevision, runRevision, type ResourceAssignment, type ResourcePolicy } from '../src/security/resources.ts';
import { EditionService } from '../src/editions/service.ts';
import { SchedulerService } from '../src/scheduling/service.ts';
import { emptyState, type State } from '../src/newsroom/model.ts';
import type { Permission, Principal } from '../src/security/types.ts';
import { SecurityError } from '../src/security/verifier.ts';

type Fixture = Awaited<ReturnType<typeof seedSecurityFixture>>;
async function fixture(run: (repository: JsonRepository, identities: Fixture) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-object-policy-'));
  try { const repository = new JsonRepository(join(directory, 'fixture.json')); await run(repository, await seedSecurityFixture(repository)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function assignment(identityId: string, permission: Permission, kind: ResourceAssignment['kind'], id: string): ResourceAssignment {
  return { identityId, permission, kind, id };
}
function content(state: State) {
  const { securityAudit: _, identities: __, sessions: ___, ...editorial } = state;
  return editorial;
}
async function unchanged(repository: JsonRepository, work: () => Promise<unknown>, code = 'PERMISSION_DENIED') {
  const before = content(await repository.read());
  await assert.rejects(work(), (error: unknown) => error instanceof SecurityError && error.code === code);
  assert.deepEqual(content(await repository.read()), before);
}
async function reviewable(repository: JsonRepository) {
  const seed = await seedEditorialFixture(repository, securityAt);
  return seed.newsroom.transition(seed.story.id, 'NEEDS_REVIEW', 'fictional-review');
}

test('resource assignments reject wildcard and extra authority fields', () => {
  for (const row of [assignment('actor-one', 'STORY_EDIT', 'STORY', '*'),
    { ...assignment('actor-one', 'STORY_EDIT', 'STORY', 'story-one'), all: true }]) {
    assert.throws(() => new AssignedResourcePolicy([row]), SecurityError);
  }
});

test('resource assignments copy trusted input and require actor, permission, kind and every exact ID', () => {
  const grant = assignment('actor-one', 'STORY_EDIT', 'STORY', 'story-one');
  const rows = [grant]; const policy = new AssignedResourcePolicy(rows);
  rows.push(assignment('actor-two', 'STORY_EDIT', 'STORY', 'story-two'));
  Object.assign(grant, { id: 'story-two' });
  const principal: Principal = { identityId: 'actor-one', identityRevision: 1, sessionId: 'session-one', sessionRef: 'reference-one' };
  policy.authorize(principal, 'STORY_EDIT', [{ kind: 'STORY', id: 'story-one' }], emptyState());
  for (const [actor, permission, targets] of [
    ['actor-two', 'STORY_EDIT', [{ kind: 'STORY', id: 'story-one' }]],
    ['actor-one', 'STORY_APPROVE', [{ kind: 'STORY', id: 'story-one' }]],
    ['actor-one', 'STORY_EDIT', [{ kind: 'EDITION', id: 'story-one' }]],
    ['actor-one', 'STORY_EDIT', [{ kind: 'STORY', id: 'story-one' }, { kind: 'STORY', id: 'story-two' }]],
    ['actor-one', 'STORY_EDIT', []],
  ] as const) assert.throws(() => policy.authorize({ ...principal, identityId: actor }, permission, targets, emptyState()), SecurityError);
});

test('assigned story approval succeeds while a substituted resource with same role is denied', async () => fixture(async (repo, f) => {
  const story = await reviewable(repo), identity = f.accounts.managing;
  const policy = new AssignedResourcePolicy([assignment(identity.identity.id, 'STORY_APPROVE', 'STORY', story.id)]);
  const facade = new AuthenticatedEditorial(repo, f.access, { resourcePolicy: policy });
  await unchanged(repo, () => facade.approveStory(identity.credential, 'unassigned-story', story.version));
  const approved = await facade.approveStory(identity.credential, story.id, story.version);
  assert.equal(approved.status, 'APPROVED');
  assert.ok((await repo.read()).authenticatedActions.some(row => row.resourceId === story.id && row.permission === 'STORY_APPROVE'));
}));

test('an assigned administrator still cannot gain editorial approval through object policy', async () => fixture(async (repo, f) => {
  const story = await reviewable(repo), identity = f.accounts.admin;
  const facade = new AuthenticatedEditorial(repo, f.access, { resourcePolicy: new AssignedResourcePolicy([assignment(identity.identity.id, 'STORY_APPROVE', 'STORY', story.id)]) });
  await unchanged(repo, () => facade.approveStory(identity.credential, story.id, story.version));
}));

test('assigned resources still require exact current story revisions', async () => fixture(async (repo, f) => {
  const story = await reviewable(repo), identity = f.accounts.managing;
  const facade = new AuthenticatedEditorial(repo, f.access, { resourcePolicy: new AssignedResourcePolicy([assignment(identity.identity.id, 'STORY_APPROVE', 'STORY', story.id)]) });
  await unchanged(repo, () => facade.approveStory(identity.credential, story.id, story.version - 1), 'STALE_TARGET');
}));

test('resource-policy denial runs before retention can alter expired edition content', async () => fixture(async (repo, f) => {
  const seed = await seedEditionFixture(repo, securityAt);
  const edition = await new EditionService(repo, { clock: () => securityAt }).create({ date: '2026-06-01', timezone: 'UTC', placements: [{ storyId: seed.story.id, storyVersion: seed.story.version, section: 'TOP_STORIES' }] }, 'fictional-fixture');
  await repo.transact(state => { for (const source of state.managedSources) source.deleteAt = '2026-06-01T12:00:01.000Z'; });
  const access = new AccessControl(repo, { verifier: f.verifier, clock: () => '2026-06-01T12:00:02.000Z' });
  const facade = new AuthenticatedEditorial(repo, access, { resourcePolicy: new AssignedResourcePolicy([]) });
  await unchanged(repo, () => facade.reviewEdition(f.accounts.editor.credential, edition.id, edition.revision, 'NEEDS_REVIEW'));
}));

test('resource policy is rechecked after staging and denial rolls back approvals and receipts', async () => fixture(async (repo, f) => {
  const story = await reviewable(repo); let allowed = true; let calls = 0;
  const policy: ResourcePolicy = { authorize() { calls++; if (!allowed) throw new SecurityError('PERMISSION_DENIED'); } };
  const staged = new JsonRepository(repo.file, { beforeCommit: () => { allowed = false; } });
  const facade = new AuthenticatedEditorial(staged, new AccessControl(staged, { verifier: f.verifier, clock: () => securityAt }), { resourcePolicy: policy });
  await unchanged(repo, () => facade.approveStory(f.accounts.managing.credential, story.id, story.version));
  assert.equal(calls, 2);
}));

test('edition allocation requires exact canonical slot and every placement story grant', async () => fixture(async (repo, f) => {
  const seed = await seedEditionFixture(repo, securityAt), actor = f.accounts.reporter;
  const input = { date: '2026-06-01', timezone: 'UTC', placements: [{ storyId: seed.story.id, storyVersion: seed.story.version, section: 'TOP_STORIES' as const }] };
  const slot = assignment(actor.identity.id, 'EDITION_ASSEMBLE', 'EDITION', editionSlot(input.date, input.timezone));
  const missing = new AuthenticatedEditorial(repo, f.access, { resourcePolicy: new AssignedResourcePolicy([slot]) });
  await unchanged(repo, () => missing.assembleEdition(actor.credential, input));
  const assigned = new AuthenticatedEditorial(repo, f.access, { resourcePolicy: new AssignedResourcePolicy([slot, assignment(actor.identity.id, 'EDITION_ASSEMBLE', 'STORY', seed.story.id)]) });
  await unchanged(repo, () => assigned.assembleEdition(actor.credential, { ...input, date: '2026-06-02' }));
  assert.equal(editionSlot(input.date, 'Etc/UTC'), editionSlot(input.date, 'UTC'));
  assert.equal((await assigned.assembleEdition(actor.credential, input)).status, 'ASSEMBLING');
}));

test('new edition allocation grants no implicit review ownership', async () => fixture(async (repo, f) => {
  const actor = f.accounts.managing;
  const policy = new AssignedResourcePolicy([assignment(actor.identity.id, 'EDITION_ASSEMBLE', 'EDITION', editionSlot('2026-06-01', 'UTC'))]);
  const facade = new AuthenticatedEditorial(repo, f.access, { resourcePolicy: policy });
  const edition = await facade.assembleEdition(actor.credential, { date: '2026-06-01', timezone: 'UTC', placements: [] });
  await unchanged(repo, () => facade.reviewEdition(actor.credential, edition.id, edition.revision, 'ON_HOLD'));
}));

test('edition review checks contained story assignments as well as edition ID', async () => fixture(async (repo, f) => {
  const seed = await seedEditionFixture(repo, securityAt), actor = f.accounts.editor;
  const edition = await new EditionService(repo, { clock: () => securityAt }).create({ date: '2026-06-01', timezone: 'UTC', placements: [{ storyId: seed.story.id, storyVersion: seed.story.version, section: 'TOP_STORIES' }] }, 'fictional-fixture');
  const grant = assignment(actor.identity.id, 'EDITION_REVIEW', 'EDITION', edition.id);
  const missing = new AuthenticatedEditorial(repo, f.access, { resourcePolicy: new AssignedResourcePolicy([grant]) });
  await unchanged(repo, () => missing.reviewEdition(actor.credential, edition.id, edition.revision, 'NEEDS_REVIEW'));
  const scoped = new AuthenticatedEditorial(repo, f.access, { resourcePolicy: new AssignedResourcePolicy([grant, assignment(actor.identity.id, 'EDITION_REVIEW', 'STORY', seed.story.id)]) });
  assert.equal((await scoped.reviewEdition(actor.credential, edition.id, edition.revision, 'NEEDS_REVIEW')).status, 'NEEDS_REVIEW');
}));

test('schedule mutations bind exact state even when timestamps stay equal', async () => fixture(async (repo, f) => {
  const service = new SchedulerService(repo, { clock: () => securityAt });
  const schedule = await service.create({ name: 'Fictional object assignment', timezone: 'UTC', localTime: '12:01', weekdays: [0,1,2,3,4,5,6], enabled: true });
  const actor = f.accounts.admin;
  const facade = new AuthenticatedEditorial(repo, f.access, { resourcePolicy: new AssignedResourcePolicy([assignment(actor.identity.id, 'SCHEDULE_CONFIGURE', 'SCHEDULE', schedule.id)]) });
  const revision = scheduleRevision(schedule);
  assert.equal(scheduleRevision({ ...schedule }), revision);
  assert.notEqual(scheduleRevision({ ...schedule, enabled: false }), revision);
  await unchanged(repo, () => facade.pauseSchedule(actor.credential, schedule.id), 'STALE_TARGET');
  assert.equal((await facade.pauseSchedule(actor.credential, schedule.id, revision)).enabled, false);
  await unchanged(repo, () => facade.pauseSchedule(actor.credential, schedule.id, revision), 'STALE_TARGET');
}));

test('run claiming requires explicit assignment and exact run state', async () => fixture(async (repo, f) => {
  let now = securityAt;
  const service = new SchedulerService(repo, { clock: () => now });
  await service.create({ name: 'Fictional assigned execution', timezone: 'UTC', localTime: '12:01', weekdays: [0,1,2,3,4,5,6], enabled: true });
  now = '2026-06-01T12:01:00.000Z';
  const evaluated = await service.evaluate({ dryRun: false }), run = evaluated.runs[0], actor = f.accounts.editor;
  const access = new AccessControl(repo, { verifier: f.verifier, clock: () => now });
  const facade = new AuthenticatedEditorial(repo, access, { resourcePolicy: new AssignedResourcePolicy([assignment(actor.identity.id, 'SCHEDULE_EXECUTE', 'RUN', run.id)]) });
  await unchanged(repo, () => facade.claimRun(actor.credential, 'unassigned-run', runRevision(run)));
  await unchanged(repo, () => facade.claimRun(actor.credential, run.id), 'STALE_TARGET');
  assert.equal((await facade.claimRun(actor.credential, run.id, runRevision(run))).status, 'CLAIMED');
  await unchanged(repo, () => facade.claimRun(actor.credential, run.id, runRevision(run)), 'STALE_TARGET');
}));

test('scoped bulk scheduler operations without explicit per-object boundaries fail closed', async () => fixture(async (repo, f) => {
  const facade = new AuthenticatedEditorial(repo, f.access, { resourcePolicy: new AssignedResourcePolicy([]) });
  await unchanged(repo, () => facade.evaluateSchedules(f.accounts.editor.credential));
  await unchanged(repo, () => facade.recoverRuns(f.accounts.editor.credential));
}));


test('trusted policy observations receive copies and cannot rewrite transactional state or bound targets', async () => fixture(async (repo, f) => {
  const story = await reviewable(repo);
  const calls: string[] = [];
  const policy: ResourcePolicy = { authorize(_principal, _permission, targets, state) {
    calls.push(targets[0].id);
    (targets as unknown as { id: string }[])[0].id = 'substitution-attempt';
    (state as State).revisions.length = 0;
    (state as State).identities.length = 0;
  } };
  const facade = new AuthenticatedEditorial(repo, f.access, { resourcePolicy: policy });
  assert.equal((await facade.approveStory(f.accounts.managing.credential, story.id, story.version)).status, 'APPROVED');
  assert.deepEqual(calls, [story.id, story.id]);
  assert.equal((await repo.read()).identities.length, 4);
}));


test('asynchronous or returned policy decisions cannot authorize a protected mutation', async () => {
  for (const result of [false, true, null, 'allow', () => Promise.resolve(), () => Promise.reject(Error('fictional private policy diagnostic'))]) {
    await fixture(async (repo, f) => {
      const story = await reviewable(repo);
      const policy = { authorize: () => typeof result === 'function' ? result() : result } as unknown as ResourcePolicy;
      const facade = new AuthenticatedEditorial(repo, f.access, { resourcePolicy: policy });
      await unchanged(repo, () => facade.approveStory(f.accounts.managing.credential, story.id, story.version));
    });
  }
});

test('a returned commit-time policy decision rolls back the staged mutation and success receipt', async () => fixture(async (repo, f) => {
  const story = await reviewable(repo); let calls = 0;
  const policy = { authorize: () => ++calls === 1 ? undefined : Promise.resolve() } as unknown as ResourcePolicy;
  const facade = new AuthenticatedEditorial(repo, f.access, { resourcePolicy: policy });
  await unchanged(repo, () => facade.approveStory(f.accounts.managing.credential, story.id, story.version));
  assert.equal(calls, 2);
}));
