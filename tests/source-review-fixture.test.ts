import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seedSourceReviewFixture, sourceReviewFixtureAt } from '../fixtures/source-review-fiction.ts';
import { eligibleSource } from '../src/ingestion/eligibility.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { AuthenticatedEditorial } from '../src/security/editorial.ts';
import { SecurityError } from '../src/security/verifier.ts';
import type { SecurityCode } from '../src/security/types.ts';

const run = promisify(execFile);
const runner = fileURLToPath(new URL('../src/security/source-review-runner.ts', import.meta.url));
const editorialKeys = ['revisions', 'approvals', 'drafts', 'draftReviews', 'editions', 'editionReviews', 'schedules', 'preparationRuns'] as const;
const summaryKeys = ['blocked', 'independentlyResolved', 'pendingProposal', 'reviewAllowed', 'reviewRevision', 'revision', 'status'];

function denied(code: SecurityCode) {
  return (error: unknown) => {
    assert.ok(error instanceof SecurityError); assert.equal(error.code, code); assert.equal(error.message, code); return true;
  };
}
async function fixture(action: (repository: JsonRepository, seeded: Awaited<ReturnType<typeof seedSourceReviewFixture>>) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-review-fixture-test-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    await action(repository, await seedSourceReviewFixture(repository));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('fictional review fixture seeds existing records and two independent managing reviewers without review actions or fetch', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('No fixture network'); });
  await fixture(async (repository, c) => {
    const state = await repository.read();
    assert.notEqual(c.accounts.managing.identity.id, c.accounts.confirming.identity.id);
    assert.notEqual(c.accounts.managing.claims.sessionId, c.accounts.confirming.claims.sessionId);
    assert.deepEqual(c.accounts.confirming.identity.roles, ['MANAGING_EDITOR']);
    assert.ok(state.sessions.some(row => row.userId === c.accounts.confirming.identity.id));
    assert.ok(state.quarantine.some(row => row.sourceId === c.sourceIds.pending));
    assert.ok(!state.sources.some(row => row.id === c.sourceIds.pending));
    assert.deepEqual(state.sourceReviews ?? [], []);
    assert.deepEqual(state.authenticatedActions, []);
    const view = await c.sourceReview.inspect(c.accounts.managing.credential, c.sourceIds.pending);
    assert.deepEqual(Object.keys(view).sort(), summaryKeys);
    assert.equal(view.status, 'UNREVIEWED'); assert.equal(view.reviewRevision, 0);
    assert.match(view.revision, /^[a-f0-9]{64}$/); assert.equal(view.independentlyResolved, false);
    assert.doesNotMatch(JSON.stringify(view), /sourceId|evidence|actor|reviewer|session|credential|publisher|https:/);
    assert.equal(calls, 0);
  });
});

test('fictional recommendation has no eligibility effect and only separate authenticated confirmation promotes retained metadata', async () => {
  await fixture(async (repository, c) => {
    const before = await repository.read(), retained = before.quarantine.find(row => row.sourceId === c.sourceIds.pending)!;
    const initial = await c.sourceReview.inspect(c.accounts.managing.credential, c.sourceIds.pending);
    const begun = await c.sourceReview.begin(c.accounts.managing.credential, c.sourceIds.pending,
      { revision: initial.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: [c.sourceIds.original] });
    const proposed = await c.sourceReview.propose(c.accounts.managing.credential, c.sourceIds.pending,
      { revision: begun.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.original], classification: 'ORIGINAL', originId: null });
    assert.equal(proposed.status, 'PROPOSED'); assert.equal(proposed.pendingProposal, true);
    const recommendationState = await repository.read();
    assert.ok(!recommendationState.sources.some(row => row.id === c.sourceIds.pending));
    assert.deepEqual(recommendationState.quarantine, before.quarantine);
    assert.deepEqual(recommendationState.provenanceDecisions, before.provenanceDecisions);
    await assert.rejects(c.sourceReview.confirm(c.accounts.managing.credential, c.sourceIds.pending,
      { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.original] }), denied('PERMISSION_DENIED'));
    assert.deepEqual(await repository.read(), recommendationState);
    const confirmed = await c.sourceReview.confirm(c.accounts.confirming.credential, c.sourceIds.pending,
      { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.original] });
    assert.equal(confirmed.status, 'RESOLVED'); assert.equal(confirmed.pendingProposal, false); assert.equal(confirmed.independentlyResolved, true);
    const after = await repository.read(), source = after.sources.find(row => row.id === c.sourceIds.pending)!;
    const managed = after.managedSources.find(row => row.sourceId === c.sourceIds.pending)!;
    assert.equal(source.type, 'ORIGINAL'); assert.equal(eligibleSource(after, source, sourceReviewFixtureAt), true);
    assert.equal(after.quarantine.some(row => row.sourceId === c.sourceIds.pending), false);
    const { metadata: _metadata, ...originalRetained } = retained;
    assert.deepEqual(managed, originalRetained);
    assert.equal(after.provenanceDecisions.filter(row => row.sourceId === c.sourceIds.pending).length, 1);
    assert.deepEqual(Object.keys(confirmed).sort(), summaryKeys);
    for (const key of editorialKeys) assert.deepEqual(after[key], before[key], key);
  });
});

test('fictional source-review grants do not override reporter, editor confirmation or administrator role boundaries', async () => {
  await fixture(async (repository, c) => {
    for (const account of [c.accounts.reporter, c.accounts.admin]) {
      await assert.rejects(c.sourceReview.inspect(account.credential, c.sourceIds.pending), denied('PERMISSION_DENIED'));
    }
    const view = await c.sourceReview.inspect(c.accounts.editor.credential, c.sourceIds.pending);
    const begun = await c.sourceReview.begin(c.accounts.editor.credential, c.sourceIds.pending,
      { revision: view.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: [c.sourceIds.original] });
    const proposed = await c.sourceReview.propose(c.accounts.editor.credential, c.sourceIds.pending,
      { revision: begun.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.original], classification: 'SECONDARY', originId: null });
    const before = await repository.read();
    await assert.rejects(c.sourceReview.confirm(c.accounts.editor.credential, c.sourceIds.pending,
      { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.original] }), denied('PERMISSION_DENIED'));
    assert.deepEqual(await repository.read(), before);
  });
});

test('independently confirmed fictional disputed provenance remains quarantined and blocked', async () => {
  await fixture(async (repository, c) => {
    const initial = await c.sourceReview.inspect(c.accounts.managing.credential, c.sourceIds.disputed);
    const begun = await c.sourceReview.begin(c.accounts.managing.credential, c.sourceIds.disputed,
      { revision: initial.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: [c.sourceIds.original] });
    const proposed = await c.sourceReview.propose(c.accounts.managing.credential, c.sourceIds.disputed,
      { revision: begun.revision, reasonCode: 'CONTRADICTORY_EVIDENCE', evidenceReferences: [c.sourceIds.original], classification: 'DISPUTED', originId: null });
    const confirmed = await c.sourceReview.confirm(c.accounts.confirming.credential, c.sourceIds.disputed,
      { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.original] });
    assert.equal(confirmed.status, 'DISPUTED'); assert.equal(confirmed.blocked, true); assert.equal(confirmed.independentlyResolved, false);
    const state = await repository.read();
    assert.ok(state.quarantine.some(row => row.sourceId === c.sourceIds.disputed));
    assert.ok(!state.sources.some(row => row.id === c.sourceIds.disputed));
    const page = await c.sourceQueue.read(c.accounts.editor.credential, { limit: 50 });
    const disputed = page.entries.find(row => row.canonicalUrl === 'https://source-queue.example.test/disputed');
    assert.ok(disputed); assert.equal(disputed.sourceEligible, false); assert.equal(disputed.canAdvance, false);
    assert.doesNotMatch(JSON.stringify(page), /actorId|proposedBy|actorAssertion|evidenceReferences|sessionId|credential|sourceFingerprint/);
  });
});

test('revoked fictional reviewer cannot continue a pending workflow or create a successful action receipt', async () => {
  await fixture(async (repository, c) => {
    const initial = await c.sourceReview.inspect(c.accounts.managing.credential, c.sourceIds.pending);
    const begun = await c.sourceReview.begin(c.accounts.managing.credential, c.sourceIds.pending,
      { revision: initial.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences: [c.sourceIds.original] });
    await c.access.invalidateSession(c.accounts.managing.credential);
    const before = await repository.read();
    await assert.rejects(c.sourceReview.propose(c.accounts.managing.credential, c.sourceIds.pending,
      { revision: begun.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.original], classification: 'ORIGINAL', originId: null }), denied('SESSION_REVOKED'));
    assert.deepEqual(await repository.read(), before);
  });
});

test('fictional source-review interface cannot approve stories, ready editions or publish', async () => {
  await fixture(async (repository, c) => {
    for (const method of ['approveStory', 'reviewStory', 'assembleEdition', 'reviewEdition', 'publish']) assert.equal(method in c.sourceReview, false);
    const before = await repository.read(), editorial = new AuthenticatedEditorial(repository, c.access, { resourcePolicy: c.resourcePolicy });
    for (const account of Object.values(c.accounts)) {
      await assert.rejects(editorial.approveStory(account.credential, 'fictional-unassigned-story', 1), denied('PERMISSION_DENIED'));
    }
    const after = await repository.read();
    for (const key of editorialKeys) assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(after.authenticatedActions, before.authenticatedActions);
  });
});

test('isolated source-review CLI is deterministic, explicitly fictional, network-blocked and cleans temporary repositories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-review-runner-test-'));
  try {
    const runtime = join(directory, 'runtime'); await mkdir(runtime);
    const guard = join(directory, 'forbid network #100% café.mjs'), probe = join(directory, 'network-called');
    await writeFile(guard, "import {writeFileSync} from 'node:fs'; writeFileSync(process.env.DAYLINE_FIXTURE_PRELOAD_PROBE, 'loaded'); globalThis.fetch = () => { writeFileSync(process.env.DAYLINE_FIXTURE_NETWORK_PROBE, 'called'); throw Error('No fixture network'); };\n");
    const expected = { fictional: true, developmentOnly: true, asOf: sourceReviewFixtureAt,
      provenanceWorkflow: { initial: 'UNREVIEWED', entered: 'UNDER_REVIEW', proposed: 'PROPOSED', eligibleBeforeConfirmation: false,
        selfConfirmation: { denied: true, code: 'PERMISSION_DENIED' }, independentConfirmation: 'RESOLVED', eligibleAfterConfirmation: true },
      disputedSource: { status: 'DISPUTED', eligible: false }, revokedReviewer: { denied: true, code: 'SESSION_REVOKED' }, rightsAndRetentionUnchanged: true,
      editorialAuthority: { canApproveStory: false, canReadyEdition: false, canPublish: false, editorialStateUnchanged: true } };
    const outputs: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const loaded = join(directory, `preload-loaded-${attempt}`);
      const { stdout } = await run(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(guard).href, runner], {
        env: { ...process.env, TMPDIR: runtime, TEMP: runtime, TMP: runtime,
          DAYLINE_FIXTURE_PRELOAD_PROBE: loaded, DAYLINE_FIXTURE_NETWORK_PROBE: probe }, maxBuffer: 1024 * 1024,
      });
      const value: unknown = JSON.parse(stdout); assert.deepEqual(value, expected); outputs.push(value);
      assert.doesNotMatch(stdout, /credential|identityId|actorId|reviewerId|sessionId|sessionRef|proposedBy|evidenceReferences|sourceId|sourceFingerprint|revision|cursor|authorizationContext|fictional\.json|https?:|url-[a-f0-9]{64}/i);
      assert.equal(await readFile(loaded, 'utf8'), 'loaded'); await assert.rejects(readFile(probe), { code: 'ENOENT' });
      assert.deepEqual(await readdir(runtime), []);
    }
    assert.deepEqual(outputs[0], outputs[1]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fictional source-review CLI rejects caller paths, live modes and arguments without state and sanitizes setup failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-review-runner-args-'));
  try {
    const runtime = join(directory, 'runtime'); await mkdir(runtime);
    const callerFile = join(directory, 'private-caller-repository.json');
    for (const args of [['--repository', callerFile], ['--live'], ['--help'], ['']]) {
      await assert.rejects(run(process.execPath, ['--experimental-strip-types', runner, ...args], {
        env: { ...process.env, TMPDIR: runtime, TEMP: runtime, TMP: runtime }, maxBuffer: 1024 * 1024,
      }), error => {
        const failure = error as Error & { code: number; stdout: string; stderr: string };
        assert.equal(failure.code, 1); assert.equal(failure.stdout, ''); assert.match(failure.stderr, /Fictional source review demonstration failed/);
        assert.doesNotMatch(failure.stderr, /private-caller-repository|fictional\.json/); return true;
      });
      assert.deepEqual(await readdir(runtime), []); await assert.rejects(readFile(callerFile), { code: 'ENOENT' });
    }
    const blocked = join(directory, 'private-unusable-temp'); await writeFile(blocked, 'not a directory');
    await assert.rejects(run(process.execPath, ['--experimental-strip-types', runner], {
      env: { ...process.env, TMPDIR: blocked, TEMP: blocked, TMP: blocked }, maxBuffer: 1024 * 1024,
    }), error => {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1); assert.equal(failure.stdout, ''); assert.match(failure.stderr, /Fictional source review demonstration failed/);
      assert.doesNotMatch(failure.stderr, /private-unusable-temp|ENOTDIR|mkdtemp/); return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
