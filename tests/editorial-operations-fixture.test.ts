import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seedEditorialOperationsFixture, operationsRoles } from '../fixtures/editorial-operations-fiction.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { SecurityError } from '../src/security/verifier.ts';

const run = promisify(execFile);
const runner = fileURLToPath(new URL('../src/security/operations-runner.ts', import.meta.url));
const bridge = fileURLToPath(new URL('./helpers/operations-browser-fixture.ts', import.meta.url));
async function withFixture(action: (fixture: Awaited<ReturnType<typeof seedEditorialOperationsFixture>>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-operations-fixture-test-'));
  try { await action(await seedEditorialOperationsFixture(new JsonRepository(join(directory, 'fictional.json')))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const denied = (code: string) => (error: unknown) => error instanceof SecurityError && error.code === code;

test('operations fixture is offline and begins with an unreviewed assigned source and a hidden unassigned source', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw Error('Fixture network forbidden'); });
  await withFixture(async c => {
    assert.deepEqual(Object.keys(c.accounts).sort(), [...operationsRoles].sort());
    const page = await c.sourceQueue.read(c.accounts.editor.credential, { limit: 50 });
    assert.equal(page.entries.length, 6);
    assert.equal(page.entries.some(row => row.canonicalUrl?.endsWith('/other')), false);
    assert.equal((await c.sourceReview.inspect(c.accounts.editor.credential, c.sourceIds.pending)).status, 'UNREVIEWED');
    assert.equal((await c.sourceReview.inspect(c.accounts.editor.credential, c.sourceIds.disputed)).status, 'DISPUTED');
    assert.equal(requests, 0);
  });
});

test('fixture seed keeps the human creation ID and June 1 assembly slot free while showing a separate nonpublished edition', async () => {
  await withFixture(async c => {
    const state = await c.repository.read();
    assert.equal(state.revisions.some(row => row.id === c.humanStory.id), false);
    assert.equal(state.editions.some(row => row.date === '2026-06-01'), false);
    assert.equal(state.revisions.filter(row => row.id === c.existingStoryId).at(-1)?.status, 'APPROVED');
    assert.equal(state.editions.find(row => row.id === c.existingEditionId)?.status, 'ASSEMBLING');
    assert.equal(state.revisions.some(row => row.status === 'PUBLISHED'), false);
    assert.equal(state.preparationRuns.length, 0);
    assert.equal(state.managedSources.every(row => !row.policy.publicRedistribution && !row.policy.aiNarration), true);
  });
});

test('fictional role profiles do not infer source-read or managing-editor authority', async () => {
  await withFixture(async c => {
    for (const role of ['reporter', 'admin'] as const) {
      await assert.rejects(c.sourceQueue.read(c.accounts[role].credential), denied('PERMISSION_DENIED'));
    }
    await c.resolvePending();
    await assert.rejects(c.sourceReview.confirm(c.accounts.editor.credential, c.sourceIds.pending,
      { revision: '0'.repeat(64), reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences: [c.sourceIds.proof] }), denied('PERMISSION_DENIED'));
  });
});

test('trusted fixture controls replace exact assignments, revoke current sessions and expire retained source state', async () => {
  await withFixture(async c => {
    const before = c.policy.sourceReadRevision!();
    c.clearAssignments('editor');
    assert.equal(c.policy.sourceReadRevision!() === before, false);
    await assert.rejects(c.sourceQueue.read(c.accounts.editor.credential), denied('PERMISSION_DENIED'));
    await c.revoke('managing');
    await assert.rejects(c.sourceQueue.read(c.accounts.managing.credential), denied('SESSION_REVOKED'));
    await c.expire('proof');
    const state = await c.repository.read();
    assert.equal(state.managedSources.find(row => row.sourceId === c.sourceIds.proof)?.deleteAt, c.clock.now());
    c.clock.advance(900_001);
    await assert.rejects(c.sourceQueue.read(c.accounts.confirming.credential), denied('SESSION_EXPIRED'));
  });
});

test('trusted hold and release use the existing authenticated source-review transitions', async () => {
  await withFixture(async c => {
    await c.resolvePending();
    assert.equal((await c.hold('pending')).status, 'ON_HOLD');
    await assert.rejects(c.sourceHandoff.inspect(c.accounts.editor.credential, [c.sourceIds.pending]));
    assert.equal((await c.hold('pending', true)).status, 'UNDER_REVIEW');
  });
});

test('offline operations demonstration is deterministic, contains no credentials and removes its temporary repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-operations-demo-test-'));
  try {
    const runtime = join(directory, 'runtime'); await mkdir(runtime);
    const guard = join(directory, 'forbid network #100% café.mjs'), probe = join(directory, 'network-called');
    await writeFile(guard, "import {writeFileSync} from 'node:fs'; globalThis.fetch=()=>{writeFileSync(process.env.DAYLINE_OPERATIONS_NETWORK_PROBE,'called');throw Error('No fixture network')};\n");
    const results: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const { stdout } = await run(process.execPath,
        ['--experimental-strip-types', '--import', pathToFileURL(guard).href, runner, '--fictional', '--demo'],
        { env: { ...process.env, TMPDIR: runtime, TEMP: runtime, TMP: runtime, DAYLINE_OPERATIONS_NETWORK_PROBE: probe } });
      const value = JSON.parse(stdout);
      assert.equal(value.fictional, true); assert.equal(value.pending, 'UNREVIEWED');
      assert.equal(value.recommendation, 'PROPOSED'); assert.equal(value.recommendationCannotPrepare, true);
      assert.equal(value.selfConfirmationDenied, true); assert.equal(value.independentConfirmation, 'RESOLVED');
      assert.equal(value.preparedStory, 'INGESTED'); assert.equal(value.separateExplicitApproval, 'APPROVED');
      assert.equal(value.edition, 'ASSEMBLING'); assert.equal(value.publicPublication, false);
      assert.equal(/credential|Bearer|sessionId|accounts|fixture-key|fictional\.json/.test(stdout), false);
      assert.deepEqual(await readdir(runtime), []); results.push(stdout);
    }
    assert.equal(results[0] === results[1], true);
    await assert.rejects(readFile(probe), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('operations runner rejects caller repositories and live modes before creating state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-operations-args-'));
  try {
    for (const args of [[], ['--repository', 'caller.json'], ['--live'], ['--fictional', '--repository', 'caller.json'], ['--demo']]) {
      await assert.rejects(run(process.execPath, ['--experimental-strip-types', runner, ...args],
        { env: { ...process.env, TMPDIR: directory, TEMP: directory, TMP: directory } }), error => {
        const result = error as { code: number; stdout: string; stderr: string };
        assert.equal(result.code, 1); assert.equal(result.stdout, '');
        assert.equal(result.stderr.includes('Fictional editorial operations unavailable'), true);
        return true;
      });
      assert.deepEqual(await readdir(directory), []);
    }
    for (const mode of ['staging', 'production']) {
      await assert.rejects(run(process.execPath, ['--experimental-strip-types', runner, '--fictional'],
        { env: { ...process.env, TMPDIR: directory, TEMP: directory, TMP: directory, NODE_ENV: mode } }), error => {
        const result = error as { code: number; stdout: string };
        assert.equal(result.code, 1); assert.equal(result.stdout, ''); return true;
      });
      assert.deepEqual(await readdir(directory), []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unavailable browser prerequisite fails safely and cleans the disposable fictional repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-operations-no-browser-'));
  try {
    for (const prerequisites of [
      { PYTHON: join(directory, 'missing interpreter') },
      { PYTHON: process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), CHROMIUM_PATH: join(directory, 'missing browser') },
    ]) {
      await assert.rejects(run(process.execPath, ['--experimental-strip-types', runner, '--fictional'],
        { env: { ...process.env, TMPDIR: directory, TEMP: directory, TMP: directory, ...prerequisites } }), error => {
        const result = error as { code: number; stdout: string; stderr: string };
        assert.equal(result.code, 1);
        assert.equal(/credential|Bearer|sessionId|accounts|fixture-key/.test(result.stdout + result.stderr), false);
        return true;
      });
      assert.deepEqual(await readdir(directory), []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private browser bridge requires its exact pipe handshake and cleans up after controlled acceptance', async () => {
  const child = spawn(process.execPath, ['--experimental-strip-types', bridge], { stdio: ['pipe', 'pipe', 'ignore'] });
  const input = createInterface({ input: child.stdout });
  const iterator = input[Symbol.asyncIterator]();
  const next = async (): Promise<Record<string, any>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const line = await Promise.race([iterator.next(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Private fixture response timed out')), 10_000);
      })]);
      if (line.done || line.value.length > 32768) throw Error('Private fixture response unavailable');
      try { return JSON.parse(line.value); } catch { throw Error('Private fixture response invalid'); }
    } finally { clearTimeout(timer); }
  };
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
  try {
    send({ command: 'start-fictional-acceptance' });
    const bootstrap = await next();
    assert.equal(bootstrap.type === 'bootstrap', true);
    assert.equal(operationsRoles.every(role => typeof bootstrap.accounts?.[role]?.credential === 'string'), true);
    assert.equal(new URL(bootstrap.origin).hostname, '127.0.0.1');
    send({ command: 'hold', source: 'pending' }); assert.equal((await next()).ok, true);
    send({ command: 'revoke', role: 'editor' }); assert.equal((await next()).ok, true);
    send({ command: 'arbitrary', repository: '/unavailable' }); assert.equal((await next()).ok, false);
    send({ command: 'dispose' });
    const disposed = await next(); assert.equal(disposed.ok, true); assert.equal(disposed.cleanupRemoved, true);
  } finally { child.stdin.end(); input.close(); child.kill(); }
  const invalid = spawn(process.execPath, ['--experimental-strip-types', bridge], { stdio: ['pipe', 'pipe', 'ignore'] });
  let output = ''; invalid.stdout.on('data', chunk => { output += String(chunk); });
  const exit = new Promise<number | null>(resolve => invalid.once('exit', resolve));
  invalid.stdin.end(JSON.stringify({ command: 'bootstrap' }) + '\n');
  assert.equal(await exit, 1); assert.equal(output, '');
});
