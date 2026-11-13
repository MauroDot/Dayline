import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { seedSourceAccessFixture } from '../fixtures/source-access-fiction.ts';
import { sourceQueueFixtureAt } from '../fixtures/source-queue-fiction.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { AuthenticatedEditorial } from '../src/security/editorial.ts';
import { AssignedResourcePolicy } from '../src/security/resources.ts';
import { AuthenticatedSourceQueue } from '../src/security/source.ts';
import { SecurityError } from '../src/security/verifier.ts';
import type { SecurityCode } from '../src/security/types.ts';
import type { SourceQueueEntry } from '../src/source-queue/types.ts';

const run = promisify(execFile);
const runner = fileURLToPath(new URL('../src/security/source-runner.ts', import.meta.url));
const editorialKeys = ['revisions', 'approvals', 'drafts', 'draftReviews', 'editions', 'editionReviews', 'schedules', 'preparationRuns'] as const;
const metadataKeys = ['blockedReason', 'canAdvance', 'candidateRef', 'canonicalUrl', 'provenance', 'provenanceStatus',
  'publishedAt', 'publisher', 'quarantineStatus', 'relationship', 'retentionStatus', 'retrievedAt', 'rightsStatus', 'sourceEligible'];

async function withRepository(action: (repository: JsonRepository) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-access-fixture-test-'));
  try { await action(new JsonRepository(join(directory, 'fictional.json'))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function denied(code: SecurityCode) {
  return (error: unknown) => {
    assert.ok(error instanceof SecurityError);
    assert.equal(error.code, code); assert.equal(error.message, code);
    return true;
  };
}

test('fictional authenticated source fixture grants only the assigned original and never fetches', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw Error('Network is forbidden in the fictional fixture'); });
  await withRepository(async repository => {
    const { accounts, sourceQueue, sourceIds, duplicateDiscoveries } = await seedSourceAccessFixture(repository);
    assert.equal(duplicateDiscoveries, 1);
    const page = await sourceQueue.read(accounts.editor.credential, { limit: 50 });
    assert.equal(page.entries.length, 1); assert.equal(page.nextCursor, null);
    const entry = page.entries[0];
    assert.deepEqual(Object.keys(entry).sort(), metadataKeys);
    assert.equal(entry.canonicalUrl, 'https://source-queue.example.test/original');
    assert.equal(entry.publisher, 'Fictional Original Gazette'); assert.equal(entry.relationship, null);
    assert.equal(entry.sourceEligible, true); assert.equal(entry.canAdvance, false);
    assert.match(entry.candidateRef, /^candidate-[a-f0-9]{64}$/);
    for (const id of Object.values(sourceIds)) assert.ok(!JSON.stringify(page).includes(id));
    assert.doesNotMatch(JSON.stringify(page), /Fictional Syndication|Fictional New|fictional-source-reviewer|actorAssertion|evidenceReferences|providerMetadata/);
    assert.equal(requests, 0);
  });
});

test('editorial role without assignment and administrator with assignment are both denied', async () => {
  await withRepository(async repository => {
    const { accounts, sourceQueue } = await seedSourceAccessFixture(repository);
    await assert.rejects(sourceQueue.read(accounts.managing.credential), denied('PERMISSION_DENIED'));
    await assert.rejects(sourceQueue.read(accounts.admin.credential), denied('PERMISSION_DENIED'));
    await assert.rejects(sourceQueue.read(accounts.reporter.credential), denied('PERMISSION_DENIED'));
  });
});

test('a fictional syndicated assignment does not expose an inaccessible origin relationship', async () => {
  await withRepository(async repository => {
    const { accounts, access, sourceIds } = await seedSourceAccessFixture(repository);
    const resourcePolicy = new AssignedResourcePolicy([
      { identityId: accounts.editor.identity.id, permission: 'SOURCE_READ', kind: 'SOURCE', id: sourceIds.copy },
    ]);
    const page = await new AuthenticatedSourceQueue(repository, access, { resourcePolicy }).read(accounts.editor.credential);
    assert.equal(page.entries.length, 1); assert.equal(page.nextCursor, null);
    assert.equal(page.entries[0].canonicalUrl, 'https://source-queue.example.test/copy');
    assert.equal(page.entries[0].provenance, 'SYNDICATED'); assert.equal(page.entries[0].relationship, null);
    assert.doesNotMatch(JSON.stringify(page), /Fictional Original Gazette|https:\/\/source-queue\.example\.test\/original/);
  });
});

test('source-only assignments cannot approve or advance and preserve all editorial and publication arrays', async () => {
  await withRepository(async repository => {
    const { accounts, access, resourcePolicy, sourceQueue } = await seedSourceAccessFixture(repository);
    const before = await repository.read();
    const editorial = new AuthenticatedEditorial(repository, access, { resourcePolicy });
    for (const account of Object.values(accounts)) {
      await assert.rejects(editorial.approveStory(account.credential, 'fictional-unassigned-story', 1), denied('PERMISSION_DENIED'));
      await assert.rejects(editorial.reviewStory(account.credential, 'fictional-unassigned-story', 1, 'DRAFT'), denied('PERMISSION_DENIED'));
    }
    assert.ok((await sourceQueue.read(accounts.editor.credential)).entries.every(entry => entry.canAdvance === false));
    for (const method of ['approveStory', 'reviewStory', 'publish']) assert.equal(method in sourceQueue, false);
    const after = await repository.read();
    for (const key of editorialKeys) { assert.deepEqual(before[key], []); assert.deepEqual(after[key], before[key], key); }
    assert.deepEqual(after.authenticatedActions, before.authenticatedActions);
    assert.ok(after.audit.every(event => !/APPROVED|PUBLISHED/.test(event.action)));
    for (const key of ['sources', 'managedSources', 'quarantine', 'provenanceDecisions'] as const) assert.deepEqual(after[key], before[key], key);
  });
});

test('awaited invalidation immediately denies the previously authorized fictional editor', async () => {
  await withRepository(async repository => {
    const { accounts, access, sourceQueue } = await seedSourceAccessFixture(repository);
    assert.equal((await sourceQueue.read(accounts.editor.credential)).entries.length, 1);
    await access.invalidateSession(accounts.editor.credential);
    await assert.rejects(sourceQueue.read(accounts.editor.credential), denied('SESSION_REVOKED'));
  });
});

test('fictional authenticated source read sanitizes private repository failures', async t => {
  await withRepository(async repository => {
    const { accounts, sourceQueue } = await seedSourceAccessFixture(repository);
    t.mock.method(repository, 'read', async () => { throw Error('private/path/fictional.json https://private.example.test/original credential-secret'); });
    await assert.rejects(sourceQueue.read(accounts.editor.credential), error => {
      assert.ok(denied('STORAGE_UNAVAILABLE')(error));
      assert.doesNotMatch(JSON.stringify(error), /private|credential-secret|fictional\.json/);
      return true;
    });
  });
});

test('isolated authenticated fixture CLI is deterministic, removes state and rejects network access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-access-runner-test-'));
  try {
    const runtime = join(directory, 'runtime'); await mkdir(runtime);
    const guard = join(directory, 'forbid network #100% café.mjs');
    const probe = join(directory, 'network-called');
    await writeFile(guard, "import {writeFileSync} from 'node:fs'; writeFileSync(process.env.DAYLINE_FIXTURE_PRELOAD_PROBE, 'loaded'); globalThis.fetch = () => { writeFileSync(process.env.DAYLINE_FIXTURE_NETWORK_PROBE, 'called'); throw Error('No fixture network'); };\n");
    const results: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const loaded = join(directory, `preload-loaded-${attempt}`);
      const { stdout } = await run(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(guard).href, runner], {
        env: { ...process.env, TMPDIR: runtime, TEMP: runtime, TMP: runtime,
          DAYLINE_FIXTURE_NETWORK_PROBE: probe, DAYLINE_FIXTURE_PRELOAD_PROBE: loaded }, maxBuffer: 1024 * 1024,
      });
      const output = JSON.parse(stdout) as { fictional: boolean; developmentOnly: boolean; asOf: string;
        authorizedEditorial: { entries: SourceQueueEntry[] }; unauthorizedEditorial: unknown; administrator: unknown;
        revokedEditorial: unknown; sourceReadOnly: unknown };
      assert.deepEqual(Object.keys(output).sort(), ['administrator', 'asOf', 'authorizedEditorial', 'developmentOnly', 'fictional', 'revokedEditorial', 'sourceReadOnly', 'unauthorizedEditorial']);
      assert.equal(output.fictional, true); assert.equal(output.developmentOnly, true); assert.equal(output.asOf, sourceQueueFixtureAt);
      assert.deepEqual(Object.keys(output.authorizedEditorial), ['entries']);
      assert.equal(output.authorizedEditorial.entries.length, 1);
      assert.deepEqual(Object.keys(output.authorizedEditorial.entries[0]).sort(), metadataKeys);
      assert.equal(output.authorizedEditorial.entries[0].canonicalUrl, 'https://source-queue.example.test/original');
      assert.equal(output.authorizedEditorial.entries[0].canAdvance, false);
      assert.deepEqual(output.unauthorizedEditorial, { denied: true, code: 'PERMISSION_DENIED' });
      assert.deepEqual(output.administrator, { denied: true, code: 'PERMISSION_DENIED' });
      assert.deepEqual(output.revokedEditorial, { denied: true, code: 'SESSION_REVOKED' });
      assert.deepEqual(output.sourceReadOnly, { canApprove: false, canAdvance: false, canPublish: false, editorialStateUnchanged: true });
      assert.doesNotMatch(stdout, /actorAssertion|evidenceReferences|providerMetadata|fictional-source-reviewer|fictional\.json|fictional-metadata-v1|credential|sessionRef|sessionId|keyId|nextCursor|identityId|sourceId|authorizationContext|Fictional Syndication|Fictional New/);
      assert.equal(await readFile(loaded, 'utf8'), 'loaded'); assert.deepEqual(await readdir(runtime), []);
      await assert.rejects(readFile(probe), { code: 'ENOENT' }); results.push(output);
    }
    assert.deepEqual(results[0], results[1]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('authenticated fixture CLI rejects paths and live modes before creating state and sanitizes failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-source-access-runner-args-'));
  try {
    const runtime = join(directory, 'runtime'); await mkdir(runtime);
    const callerFile = join(directory, 'caller-repository.json');
    for (const args of [['--repository', callerFile], ['--live'], ['--help'], ['']]) {
      await assert.rejects(run(process.execPath, ['--experimental-strip-types', runner, ...args], {
        env: { ...process.env, TMPDIR: runtime, TEMP: runtime, TMP: runtime }, maxBuffer: 1024 * 1024,
      }), error => {
        const failure = error as Error & { code: number; stdout: string; stderr: string };
        assert.equal(failure.code, 1); assert.equal(failure.stdout, '');
        assert.match(failure.stderr, /Fictional source access demonstration failed/);
        assert.doesNotMatch(failure.stderr, /caller-repository|fictional\.json/); return true;
      });
      assert.deepEqual(await readdir(runtime), []); await assert.rejects(readFile(callerFile), { code: 'ENOENT' });
    }
    // A failed temporary-directory allocation must expose the same fixed message.
    const blockedTemp = join(directory, 'private-unusable-temp'); await writeFile(blockedTemp, 'not a directory');
    await assert.rejects(run(process.execPath, ['--experimental-strip-types', runner], {
      env: { ...process.env, TMPDIR: blockedTemp, TEMP: blockedTemp, TMP: blockedTemp }, maxBuffer: 1024 * 1024,
    }), error => {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1); assert.equal(failure.stdout, '');
      assert.match(failure.stderr, /Fictional source access demonstration failed/);
      assert.doesNotMatch(failure.stderr, /private-unusable-temp|ENOTDIR|mkdtemp/); return true;
    });
    assert.deepEqual(await readdir(runtime), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
