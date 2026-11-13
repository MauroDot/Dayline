import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { seedSourceQueueFixture, sourceQueueFixtureAt } from '../fixtures/source-queue-fiction.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { SourceQueue } from '../src/source-queue/service.ts';
import type { SourceQueueEntry, SourceQueuePage } from '../src/source-queue/types.ts';

const run = promisify(execFile);
const runner = fileURLToPath(new URL('../src/source-queue/runner.ts', import.meta.url));
const clock = () => sourceQueueFixtureAt;
const url = (name: string) => `https://source-queue.example.test/${name}`;

async function withRepository(action: (repository: JsonRepository) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-queue-fixture-test-'));
  try { await action(new JsonRepository(join(directory, 'fictional.json'))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function withheld(entry: SourceQueueEntry): void {
  assert.equal(entry.publisher, null);
  assert.equal(entry.canonicalUrl, null);
  assert.equal(entry.publishedAt, null);
  assert.equal(entry.retrievedAt, null);
  assert.equal(entry.relationship, null);
  assert.equal(entry.sourceEligible, false);
  assert.equal(entry.canAdvance, false);
}

test('fictional source queue demonstrates new, eligible, disputed, syndicated, expired, revoked and blocked records', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw Error('Network is forbidden in the fictional fixture'); });
  await withRepository(async repository => {
    assert.deepEqual(await seedSourceQueueFixture(repository), { duplicateDiscoveries: 1 });
    const entries = (await new SourceQueue(repository, { clock }).read({ limit: 50 })).entries;
    assert.equal(entries.length, 7);
    const fresh = entries.find(entry => entry.canonicalUrl === url('new'))!;
    assert.equal(fresh.provenance, 'UNKNOWN');
    assert.equal(fresh.provenanceStatus, 'UNRESOLVED');
    assert.equal(fresh.blockedReason, 'PROVENANCE_UNRESOLVED');
    const original = entries.find(entry => entry.canonicalUrl === url('original'))!;
    assert.equal(original.sourceEligible, true);
    assert.equal(original.provenanceStatus, 'RESOLVED');
    assert.equal(original.rightsStatus, 'ACTIVE');
    const disputed = entries.find(entry => entry.canonicalUrl === url('disputed'))!;
    assert.equal(disputed.provenanceStatus, 'DISPUTED');
    assert.equal(disputed.blockedReason, 'PROVENANCE_DISPUTED');
    const copy = entries.find(entry => entry.canonicalUrl === url('copy'))!;
    assert.equal(copy.provenance, 'SYNDICATED');
    assert.deepEqual(copy.relationship, { kind: 'SYNDICATED', originRef: original.candidateRef });
    assert.equal(copy.sourceEligible, true);
    const expired = entries.find(entry => entry.retentionStatus === 'EXPIRED')!;
    assert.equal(expired.blockedReason, 'RETENTION_EXPIRED'); withheld(expired);
    const revoked = entries.find(entry => entry.rightsStatus === 'REVOKED')!;
    assert.equal(revoked.blockedReason, 'POLICY_REVOKED'); withheld(revoked);
    const blocked = entries.find(entry => entry.rightsStatus === 'MISSING')!;
    assert.equal(blocked.blockedReason, 'MISSING_RIGHTS'); withheld(blocked);
    assert.ok(entries.every(entry => /^candidate-[a-f0-9]{64}$/.test(entry.candidateRef) && entry.canAdvance === false));
    assert.ok(entries.every(entry => entry.publisher === null || entry.publisher.startsWith('Fictional ')));
    assert.ok(entries.every(entry => entry.canonicalUrl === null || new URL(entry.canonicalUrl).hostname.endsWith('.test')));
    assert.equal(requests, 0);
  });
});

test('fixture organization preserves syndication and never creates editorial approval or publication', async () => {
  await withRepository(async repository => {
    await seedSourceQueueFixture(repository);
    const queue = new SourceQueue(repository, { clock });
    assert.equal((await queue.read({ view: 'UNRESOLVED' })).entries.length, 2);
    assert.equal((await queue.read({ view: 'ELIGIBLE' })).entries.length, 2);
    assert.equal((await queue.read({ view: 'RELATED' })).entries.length, 1);
    assert.equal((await queue.read({ view: 'BLOCKED' })).entries.length, 5);
    const withdrawn = (await queue.read({ view: 'WITHDRAWN' })).entries;
    assert.ok(withdrawn.some(entry => entry.blockedReason === 'RETENTION_EXPIRED'));
    assert.ok(withdrawn.some(entry => entry.blockedReason === 'POLICY_REVOKED'));
    const state = await repository.read();
    for (const key of ['revisions', 'approvals', 'drafts', 'draftReviews', 'editions', 'editionReviews', 'schedules', 'preparationRuns', 'identities', 'sessions', 'authenticatedActions'] as const) {
      assert.deepEqual(state[key], [], key);
    }
    assert.ok(state.managedSources.every(record => record.policy.publicRedistribution === false && record.policy.aiSummarization === false && record.policy.aiNarration === false));
    assert.ok(state.audit.every(event => !/APPROVED|PUBLISHED/.test(event.action)));
  });
});

test('repeated fixture discoveries count actual duplicates and preserve retrieval, retention and provenance history', async () => {
  await withRepository(async repository => {
    const queue = new SourceQueue(repository, { clock });
    await seedSourceQueueFixture(repository);
    const before = await repository.read();
    const firstPage = await queue.read({ limit: 50 });
    const storedBeforeRead = await readFile(repository.file, 'utf8');
    assert.deepEqual(await queue.read({ limit: 50 }), firstPage);
    assert.equal(await readFile(repository.file, 'utf8'), storedBeforeRead);
    assert.deepEqual(await seedSourceQueueFixture(repository), { duplicateDiscoveries: 6 });
    const after = await repository.read();
    for (const key of ['sources', 'managedSources', 'quarantine', 'provenanceDecisions'] as const) assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(await queue.read({ limit: 50 }), firstPage);
    const duplicateAudits = after.audit.filter(event => event.action === 'INGESTION_DUPLICATE');
    assert.equal(duplicateAudits.length, 7);
    assert.ok(duplicateAudits.every(event => event.subjectId === undefined));
  });
});

test('fictional seeding validates its historical clock before writing repository state', async () => {
  await withRepository(async repository => {
    for (const at of ['invalid', '2025-06-01T12:00:00.000Z', '2026-01-01T12:00:00.000Z', '2027-06-01T12:00:00.000Z']) {
      await assert.rejects(seedSourceQueueFixture(repository, at));
      await assert.rejects(readFile(repository.file), { code: 'ENOENT' });
    }
  });
});

test('isolated fixture CLI is deterministic, explicitly fictional, makes no fetch calls and removes temporary repositories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-queue-runner-test-'));
  try {
    const runtime = join(directory, 'runtime'); await mkdir(runtime);
    const guard = join(directory, 'forbid-network.mjs');
    const probe = join(directory, 'network-called');
    await writeFile(guard, "import {writeFileSync} from 'node:fs'; globalThis.fetch = () => { writeFileSync(process.env.DAYLINE_FIXTURE_NETWORK_PROBE, 'called'); throw Error('No fixture network'); };\n");
    const results: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const { stdout } = await run(process.execPath, ['--experimental-strip-types', '--import', guard, runner], {
        env: { ...process.env, TMPDIR: runtime, DAYLINE_FIXTURE_NETWORK_PROBE: probe }, maxBuffer: 1024 * 1024,
      });
      const output = JSON.parse(stdout) as { fictional: boolean; developmentOnly: boolean; asOf: string; duplicateDiscoveries: number; page: SourceQueuePage };
      assert.deepEqual(Object.keys(output).sort(), ['asOf', 'developmentOnly', 'duplicateDiscoveries', 'fictional', 'page']);
      assert.equal(output.fictional, true); assert.equal(output.developmentOnly, true);
      assert.equal(output.asOf, sourceQueueFixtureAt); assert.equal(output.duplicateDiscoveries, 1);
      assert.equal(output.page.entries.length, 7);
      assert.ok(output.page.entries.every(entry => entry.canAdvance === false));
      assert.doesNotMatch(stdout, /actorAssertion|evidenceReferences|providerMetadata|fictional-source-reviewer|fictional\.json|fictional-metadata-v1|fictional test fixture only/);
      assert.deepEqual(await readdir(runtime), []);
      await assert.rejects(readFile(probe), { code: 'ENOENT' });
      results.push(output);
    }
    assert.deepEqual(results[0], results[1]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fixture CLI rejects paths, live modes and every other command-line argument before creating state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-queue-runner-args-'));
  try {
    const runtime = join(directory, 'runtime'); await mkdir(runtime);
    const callerFile = join(directory, 'caller-repository.json');
    for (const args of [['--repository', callerFile], ['--live'], ['--write-fixture'], ['--help'], ['']]) {
      await assert.rejects(run(process.execPath, ['--experimental-strip-types', runner, ...args], {
        env: { ...process.env, TMPDIR: runtime }, maxBuffer: 1024 * 1024,
      }), error => {
        const failure = error as Error & { code: number; stdout: string; stderr: string };
        assert.equal(failure.code, 1); assert.equal(failure.stdout, '');
        assert.match(failure.stderr, /Fictional source queue demonstration failed/);
        assert.doesNotMatch(failure.stderr, /caller-repository/);
        return true;
      });
      assert.deepEqual(await readdir(runtime), []);
      await assert.rejects(readFile(callerFile), { code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
