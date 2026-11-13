import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseSmokeArguments, selectSmokeRuntime, SmokeError, smokeShutdownStrategy } from '../scripts/smoke-public.ts';

const safe = (code: string) => (error: unknown) => error instanceof SmokeError && error.code === code && error.message === code;
const inspectExecutable = async (value: string) => value;

test('smoke defaults to the current executable and probes the exact pinned runtime', async () => {
  const calls: string[] = [];
  const selected = await selectSmokeRuntime(undefined, { currentExecutable: '/trusted/node', platform: 'linux', inspectExecutable,
    probe: async value => { calls.push(value); return 'v22.16.0\n'; } });
  assert.deepEqual(selected, { executable: '/trusted/node', version: '22.16.0', selection: 'current' });
  assert.deepEqual(calls, ['/trusted/node']);
});

test('a mismatched default smoke runtime fails before artifact startup without falling back', async () => {
  let calls = 0;
  for (const version of ['v24.22.3', 'v22.16.1', 'v22.15.0']) {
    await assert.rejects(selectSmokeRuntime(undefined, { currentExecutable: '/system/node', platform: 'linux', inspectExecutable,
      probe: async value => { assert.equal(value, '/system/node'); calls++; return version; } }), safe('SMOKE_UNSUPPORTED_RUNTIME'));
  }
  assert.equal(calls, 3);
});

test('an explicit side-by-side Windows executable is kept as one argument with spaces', async () => {
  const nodePath = 'C:\\Tools With Spaces\\node-v22.16.0-win-x64\\node.exe';
  const selected = await selectSmokeRuntime(nodePath, { currentExecutable: 'C:\\System\\node.exe', platform: 'win32', inspectExecutable,
    probe: async value => { assert.equal(value, nodePath); return 'v22.16.0\r\n'; } });
  assert.equal(selected.executable, nodePath); assert.equal(selected.selection, 'explicit');
});

test('relative control-bearing and non-Node overrides fail before probing', async () => {
  let calls = 0;
  for (const value of ['node', '../node', '/trusted/other.exe', '/trusted/node\n', '/trusted/node\0']) {
    await assert.rejects(selectSmokeRuntime(value, { platform: 'linux', inspectExecutable, probe: async () => { calls++; return 'v22.16.0'; } }), safe('SMOKE_RUNTIME_INVALID'));
  }
  assert.equal(calls, 0);
});

test('runtime filesystem and probe failures expose fixed categories without paths or raw output', async () => {
  await assert.rejects(selectSmokeRuntime('/private/secret/node', { platform: 'linux', inspectExecutable: async () => { throw Error('/private/secret'); } }), safe('SMOKE_RUNTIME_INVALID'));
  await assert.rejects(selectSmokeRuntime('/trusted/node', { platform: 'linux', inspectExecutable, probe: async () => { throw Error('private provider credentials'); } }), safe('SMOKE_RUNTIME_PROBE_FAILED'));
  for (const output of ['', 'private-secret', 'v22.16.0\nprivate-secret']) {
    await assert.rejects(selectSmokeRuntime('/trusted/node', { platform: 'linux', inspectExecutable, probe: async () => output }), safe('SMOKE_RUNTIME_PROBE_FAILED'));
  }
});

test('smoke CLI accepts a single artifact path and an explicit runtime without shell expansion', () => {
  assert.deepEqual(parseSmokeArguments([]), { directory: undefined, nodePath: undefined });
  assert.deepEqual(parseSmokeArguments(['dist/public-reader', '--node', 'C:\\Tools With Spaces\\node.exe']),
    { directory: 'dist/public-reader', nodePath: 'C:\\Tools With Spaces\\node.exe' });
  assert.deepEqual(parseSmokeArguments(['--node', '/trusted/node']), { directory: undefined, nodePath: '/trusted/node' });
  for (const args of [['--node'], ['--node', '/a/node', '--node', '/b/node'], ['one', 'two'], ['--unknown'], ['--node', '--unknown']]) {
    assert.throws(() => parseSmokeArguments(args), safe('SMOKE_ARGUMENT_INVALID'));
  }
});

test('Windows smoke chooses controlled shutdown while POSIX retains real signal delivery', () => {
  assert.equal(smokeShutdownStrategy('win32'), 'controlled-ipc');
  assert.equal(smokeShutdownStrategy('linux'), 'posix-signals');
  assert.equal(smokeShutdownStrategy('darwin'), 'posix-signals');
});

test('smoke CLI runtime-path errors are nonzero sanitized JSON rather than startup timeouts', () => {
  const absent = path.resolve('nonexistent-private-runtime-location', process.platform === 'win32' ? 'node.exe' : 'node');
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/smoke-public.ts', '--node', absent],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 1);
  const line = result.stderr.split('\n').find(value => value.startsWith('{')); assert.ok(line);
  assert.deepEqual(JSON.parse(line), { event: 'public_artifact_smoke_failed', code: 'SMOKE_RUNTIME_INVALID' });
  assert.equal((result.stdout + result.stderr).includes(absent), false);
  assert.doesNotMatch(result.stdout + result.stderr, /ARTIFACT_STARTUP_FAILED|private-runtime-location/);
});
