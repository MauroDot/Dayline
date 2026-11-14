import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seedEditorialWorkflowFixture, editorialWorkflowAt } from '../fixtures/editorial-workflow-fiction.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { AuthenticatedSourceHandoff } from '../src/security/source-handoff.ts';
import { AuthenticatedEditorial } from '../src/security/editorial.ts';
import { AccessControl } from '../src/security/service.ts';
import { AssignedResourcePolicy } from '../src/security/resources.ts';
import { SecurityError } from '../src/security/verifier.ts';
import type { SecurityCode } from '../src/security/types.ts';

const run = promisify(execFile);
const runner = fileURLToPath(new URL('../src/security/editorial-workflow-runner.ts', import.meta.url));
type Seed = Awaited<ReturnType<typeof seedEditorialWorkflowFixture>>;
function denied(code: SecurityCode) { return (error: unknown) => {
  assert.ok(error instanceof SecurityError); assert.equal(error.code, code); assert.equal(error.message, code); return true;
}; }
async function fixture(action: (repository: JsonRepository, seed: Seed) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-editorial-workflow-fixture-'));
  try { const repository = new JsonRepository(join(directory, 'fictional.json')); await action(repository, await seedEditorialWorkflowFixture(repository)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('offline editorial fixture discovers quarantined fictional sources under the original licensed grant without review or publication side effects', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('No fixture network'); });
  await fixture(async (repository, c) => {
    const state = await repository.read();
    assert.equal(c.discovery.processed, 1); assert.equal(c.discovery.quarantined, 3);
    assert.ok(state.quarantine.some(row => row.sourceId === c.sourceIds.pending));
    assert.ok(!state.sources.some(row => row.id === c.sourceIds.pending));
    assert.ok([...state.managedSources, ...state.quarantine].every(row => row.policy.id === 'fictional-ai-editorial-v1'
      && row.policy.licensedExcerpt && row.policy.internalAnalysis));
    assert.equal(state.sources.find(row => row.id === c.sourceIds.proof)!.verification, 'VERIFIED');
    assert.deepEqual(state.sourceReviews ?? [], []); assert.deepEqual(state.revisions, []);
    assert.deepEqual(state.approvals, []); assert.deepEqual(state.editions, []); assert.deepEqual(state.preparationRuns, []);
    assert.notEqual(c.accounts.managing.identity.id, c.accounts.confirming.identity.id);
    const queue = await c.sourceQueue.read(c.accounts.editor.credential, { limit: 50 });
    const candidate = queue.entries.find(row => row.canonicalUrl === 'https://editorial-workflow.example.test/pending')!;
    assert.equal(candidate.sourceEligible, false); assert.equal(candidate.quarantineStatus, 'QUARANTINED');
    assert.equal(queue.entries.some(row => row.canonicalUrl === 'https://editorial-workflow.example.test/other'), false);
    await assert.rejects(c.sourceHandoff.inspect(c.accounts.editor.credential, [c.sourceIds.pending]), denied('DOMAIN_REJECTED'));
    assert.equal(calls, 0);
  });
});

test('independent provenance confirmation permits preparation of supplied human content but approval and edition assembly remain separate explicit actions', async () => fixture(async (repository, c) => {
  const confirmed = await c.resolvePending(); assert.equal(confirmed.independentlyResolved, true);
  const selection = await c.sourceHandoff.inspect(c.accounts.editor.credential, [c.sourceIds.pending]);
  assert.equal(selection.length, 1); assert.equal(selection[0].id, c.sourceIds.pending); assert.match(selection[0].revision, /^[a-f0-9]{64}$/);
  const prepared = await c.sourceHandoff.prepare(c.accounts.editor.credential, { sources: selection, story: c.humanStory });
  assert.deepEqual(Object.keys(prepared).sort(), ['id', 'status', 'version']);
  assert.equal(prepared.status, 'INGESTED'); assert.equal(prepared.version, 1);
  const initial = await repository.read(), stored = initial.revisions[0];
  for (const field of ['headline', 'summary', 'topic', 'geography', 'evidence', 'sourceIds'] as const) assert.deepEqual(stored[field], c.humanStory[field]);
  assert.ok(stored.sourceHandoff); assert.equal(initial.sources.find(row => row.id === c.sourceIds.pending)!.verification, 'UNVERIFIED');
  assert.deepEqual(initial.approvals, []); assert.deepEqual(initial.editions, []);
  let version = prepared.version;
  for (const status of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW'] as const) version = (await c.editorial.reviewStory(c.accounts.editor.credential, prepared.id, version, status)).version;
  assert.deepEqual((await repository.read()).approvals, []);
  const approved = await c.editorial.approveStory(c.accounts.managing.credential, prepared.id, version);
  assert.equal(approved.status, 'APPROVED');
  const edition = await c.editorial.assembleEdition(c.accounts.editor.credential,
    { date: '2026-06-01', timezone: 'UTC', placements: [{ storyId: approved.id, storyVersion: approved.version, section: 'TOP_STORIES', featured: true }] });
  assert.equal(edition.status, 'ASSEMBLING');
  const final = await repository.read(); assert.equal(final.approvals.length, 1);
  assert.ok(final.revisions.every(row => row.status !== 'PUBLISHED')); assert.ok(final.editions.every(row => row.status !== 'READY_FOR_APPROVAL'));
  assert.deepEqual(final.preparationRuns, []);
}));

test('source selection and story creation do not allocate editing, approval or edition authority', async () => fixture(async (repository, c) => {
  await c.resolvePending();
  const actor = c.accounts.managing;
  const policy = new AssignedResourcePolicy(c.assignments.filter(row => row.identityId === actor.identity.id
    && ((row.kind === 'SOURCE' && row.permission === 'SOURCE_READ') || (row.kind === 'STORY' && row.id === c.humanStory.id && row.permission === 'STORY_CREATE'))));
  const handoff = new AuthenticatedSourceHandoff(repository, c.access, { resourcePolicy: policy });
  const sources = await handoff.inspect(actor.credential, [c.sourceIds.pending]);
  const prepared = await handoff.prepare(actor.credential, { sources, story: c.humanStory });
  const editorial = new AuthenticatedEditorial(repository, c.access, { resourcePolicy: policy });
  const before = await repository.read();
  await assert.rejects(editorial.editStory(actor.credential, prepared.id, prepared.version, { summary: 'Explicit fictional replacement.' }), denied('PERMISSION_DENIED'));
  await assert.rejects(editorial.approveStory(actor.credential, prepared.id, prepared.version), denied('PERMISSION_DENIED'));
  await assert.rejects(editorial.assembleEdition(actor.credential, { date: '2026-06-01', timezone: 'UTC', placements: [] }), denied('PERMISSION_DENIED'));
  const after = await repository.read(); assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.approvals, before.approvals); assert.deepEqual(after.editions, before.editions);
  assert.deepEqual(after.authenticatedActions, before.authenticatedActions);
}));

test('disputed sources and unassigned source substitutions remain blocked without a partial story or success receipt', async () => fixture(async (repository, c) => {
  await c.resolvePending(); const disputed = await c.resolveDisputed(); assert.equal(disputed.status, 'DISPUTED');
  await assert.rejects(c.sourceHandoff.inspect(c.accounts.editor.credential, [c.sourceIds.disputed]), denied('DOMAIN_REJECTED'));
  const source = (await c.sourceHandoff.inspect(c.accounts.editor.credential, [c.sourceIds.pending]))[0];
  const before = await repository.read();
  await assert.rejects(c.sourceHandoff.prepare(c.accounts.editor.credential, {
    sources: [{ id: c.sourceIds.other, revision: source.revision }],
    story: { ...structuredClone(c.humanStory), id: 'fictional-workflow-substitution', sourceIds: [c.sourceIds.other],
      evidence: c.humanStory.evidence.map(row => ({ ...structuredClone(row), support: [c.sourceIds.other] })) },
  }), denied('PERMISSION_DENIED'));
  const after = await repository.read(); assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.authenticatedActions, before.authenticatedActions); assert.deepEqual(after.approvals, []);
}));

test('revoked synthetic authors cannot continue source selection or prepare a story', async () => fixture(async (repository, c) => {
  await c.resolvePending(); const sources = await c.sourceHandoff.inspect(c.accounts.editor.credential, [c.sourceIds.pending]);
  await c.access.invalidateSession(c.accounts.editor.credential); const before = await repository.read();
  await assert.rejects(c.sourceHandoff.inspect(c.accounts.editor.credential, [c.sourceIds.pending]), denied('SESSION_REVOKED'));
  await assert.rejects(c.sourceHandoff.prepare(c.accounts.editor.credential, { sources, story: c.humanStory }), denied('SESSION_REVOKED'));
  const after = await repository.read(); assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.authenticatedActions, before.authenticatedActions);
}));

test('captured source expiry blocks further preparation while the registered synthetic session is still valid', async () => fixture(async (repository, c) => {
  const deadline = '2026-06-01T12:00:10.000Z', expiredAt = '2026-06-01T12:00:11.000Z';
  await repository.transact(state => { state.quarantine.find(row => row.sourceId === c.sourceIds.pending)!.deleteAt = deadline; });
  await c.resolvePending(); const sources = await c.sourceHandoff.inspect(c.accounts.managing.credential, [c.sourceIds.pending]);
  const before = await repository.read(), captured = before.managedSources.find(row => row.sourceId === c.sourceIds.pending)!;
  const access = new AccessControl(repository, { verifier: c.verifier, clock: () => expiredAt });
  assert.equal(access.authorizeInState(before, c.accounts.managing.credential, 'SOURCE_READ', expiredAt).identityId, c.accounts.managing.identity.id);
  const handoff = new AuthenticatedSourceHandoff(repository, access, { resourcePolicy: c.resourcePolicy });
  await assert.rejects(handoff.prepare(c.accounts.managing.credential, { sources, story: { ...structuredClone(c.humanStory), id: 'fictional-workflow-expired' } }), denied('DOMAIN_REJECTED'));
  const after = await repository.read(), retained = after.managedSources.find(row => row.sourceId === c.sourceIds.pending)!;
  assert.equal(retained.deleteAt, deadline); assert.deepEqual(retained.policy, captured.policy);
  assert.equal(after.revisions.length, 0); assert.deepEqual(after.authenticatedActions, before.authenticatedActions);
}));

test('isolated editorial workflow CLI is deterministic, fictional, network-blocked and cleans its temporary repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-workflow-runner-test-'));
  try {
    const runtime = join(directory, 'runtime'); await mkdir(runtime);
    const guard = join(directory, 'forbid network #100% café.mjs'), probe = join(directory, 'network-called');
    await writeFile(guard, "import {writeFileSync} from 'node:fs'; writeFileSync(process.env.DAYLINE_FIXTURE_PRELOAD_PROBE, 'loaded'); globalThis.fetch = () => { writeFileSync(process.env.DAYLINE_FIXTURE_NETWORK_PROBE, 'called'); throw Error('No fixture network'); };\n");
    const expected = { fictional: true, developmentOnly: true, asOf: editorialWorkflowAt,
      discovery: { quarantined: true, authenticatedInspection: 'UNREVIEWED' },
      provenance: { proposed: 'PROPOSED', proposalPreparation: { denied: true, code: 'DOMAIN_REJECTED' },
        selfConfirmation: { denied: true, code: 'PERMISSION_DENIED' }, independentConfirmation: 'RESOLVED' },
      storyPreparation: { status: 'INGESTED', suppliedHumanContentPreserved: true, automaticallyApproved: false },
      editorialReview: { approvalRequiredSeparateAction: true, statusAfterExplicitApproval: 'APPROVED' },
      edition: { status: 'ASSEMBLING', ready: false, published: false },
      disputedSource: { status: 'DISPUTED', preparation: { denied: true, code: 'DOMAIN_REJECTED' } },
      substitution: { denied: true, code: 'PERMISSION_DENIED' }, revokedAuthor: { denied: true, code: 'SESSION_REVOKED' },
      expiredPreparation: { denied: true, code: 'DOMAIN_REJECTED' }, rightsAndRetentionUnchanged: true,
      productionAuthority: { publicPublication: false, schedulingActivated: false } };
    const outputs: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const loaded = join(directory, `preload-loaded-${attempt}`);
      const { stdout } = await run(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(guard).href, runner], {
        env: { ...process.env, TMPDIR: runtime, TEMP: runtime, TMP: runtime,
          DAYLINE_FIXTURE_PRELOAD_PROBE: loaded, DAYLINE_FIXTURE_NETWORK_PROBE: probe }, maxBuffer: 1024 * 1024,
      });
      const output: unknown = JSON.parse(stdout); assert.deepEqual(output, expected); outputs.push(output);
      assert.doesNotMatch(stdout, /credential|identityId|actorId|reviewerId|sessionId|sessionRef|evidenceReferences|sourceIds|sourceFingerprint|revision|cursor|authorizationContext|fictional\.json|https?:|url-[a-f0-9]{64}/i);
      assert.equal(await readFile(loaded, 'utf8'), 'loaded'); await assert.rejects(readFile(probe), { code: 'ENOENT' });
      assert.deepEqual(await readdir(runtime), []);
    }
    assert.deepEqual(outputs[0], outputs[1]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fictional workflow CLI rejects caller paths and live modes before creating state and hides setup failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-workflow-runner-args-'));
  try {
    const runtime = join(directory, 'runtime'); await mkdir(runtime); const caller = join(directory, 'private-caller.json');
    for (const args of [['--repository', caller], ['--live'], ['--help'], ['']]) {
      await assert.rejects(run(process.execPath, ['--experimental-strip-types', runner, ...args], {
        env: { ...process.env, TMPDIR: runtime, TEMP: runtime, TMP: runtime }, maxBuffer: 1024 * 1024,
      }), error => {
        const value = error as Error & { code: number; stdout: string; stderr: string };
        assert.equal(value.code, 1); assert.equal(value.stdout, ''); assert.match(value.stderr, /Fictional editorial workflow demonstration failed/);
        assert.doesNotMatch(value.stderr, /private-caller\.json|fictional\.json/); return true;
      });
      assert.deepEqual(await readdir(runtime), []); await assert.rejects(readFile(caller), { code: 'ENOENT' });
    }
    const unusable = join(directory, 'private-unusable-temp'); await writeFile(unusable, 'not a directory');
    await assert.rejects(run(process.execPath, ['--experimental-strip-types', runner], {
      env: { ...process.env, TMPDIR: unusable, TEMP: unusable, TMP: unusable }, maxBuffer: 1024 * 1024,
    }), error => {
      const value = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(value.code, 1); assert.equal(value.stdout, ''); assert.match(value.stderr, /Fictional editorial workflow demonstration failed/);
      assert.doesNotMatch(value.stderr, /private-unusable-temp|ENOTDIR|mkdtemp/); return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
