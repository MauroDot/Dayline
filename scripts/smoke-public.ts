/** Local artifact smoke only: never requests an official-data upstream or deploys anything. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, readdir, stat, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import path, { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectPublicArtifact } from './inspect-public.ts';
import { spawnPublicProcess } from '../tests/helpers/public-process.ts';

export type SmokeCode = 'SMOKE_RUNTIME_INVALID' | 'SMOKE_RUNTIME_PROBE_FAILED' | 'SMOKE_UNSUPPORTED_RUNTIME'
  | 'SMOKE_ARGUMENT_INVALID' | 'SMOKE_ARTIFACT_INVALID' | 'SMOKE_STARTUP_FAILED' | 'SMOKE_SHUTDOWN_FAILED' | 'SMOKE_VALIDATION_FAILED';
export class SmokeError extends Error {
  readonly code: SmokeCode;
  constructor(code: SmokeCode) { super(code); this.code = code; }
}
type RuntimeDependencies = {
  currentExecutable?: string; platform?: NodeJS.Platform;
  inspectExecutable?: (candidate: string) => Promise<string>;
  probe?: (executable: string) => Promise<string>;
};
async function probeVersion(executable: string): Promise<string> {
  return new Promise((done, fail) => execFile(executable, ['--version'], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 1024, windowsHide: true, shell: false,
  }, (error, stdout) => error ? fail(new SmokeError('SMOKE_RUNTIME_PROBE_FAILED')) : done(stdout.trim())));
}
/** Acceptance-tool configuration only; never used by the deployable public process. */
export async function selectSmokeRuntime(nodePath?: string, dependencies: RuntimeDependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const candidate = nodePath ?? dependencies.currentExecutable ?? process.execPath;
  if (typeof candidate !== 'string' || !paths.isAbsolute(candidate) || /[\x00-\x1f]/.test(candidate)
    || (nodePath !== undefined && !/^node(?:\.exe)?$/i.test(paths.basename(candidate)))) throw new SmokeError('SMOKE_RUNTIME_INVALID');
  let executable: string;
  try {
    executable = await (dependencies.inspectExecutable ?? (async value => {
      const actual = await realpath(value); if (!(await stat(actual)).isFile()) throw Error(); return actual;
    }))(candidate);
  } catch { throw new SmokeError('SMOKE_RUNTIME_INVALID'); }
  let version: string;
  try { version = (await (dependencies.probe ?? probeVersion)(executable)).trim(); }
  catch { throw new SmokeError('SMOKE_RUNTIME_PROBE_FAILED'); }
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new SmokeError('SMOKE_RUNTIME_PROBE_FAILED');
  if (version !== 'v22.16.0') throw new SmokeError('SMOKE_UNSUPPORTED_RUNTIME');
  return { executable, version: '22.16.0', selection: nodePath === undefined ? 'current' : 'explicit' } as const;
}
export function smokeShutdownStrategy(platform: NodeJS.Platform = process.platform): 'controlled-ipc' | 'posix-signals' {
  return platform === 'win32' ? 'controlled-ipc' : 'posix-signals';
}
export function parseSmokeArguments(args: string[]): { directory?: string; nodePath?: string } {
  let directory: string | undefined, nodePath: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--node') {
      if (nodePath !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new SmokeError('SMOKE_ARGUMENT_INVALID');
      nodePath = args[++index];
    } else if (value.startsWith('--') || directory !== undefined) throw new SmokeError('SMOKE_ARGUMENT_INVALID');
    else directory = value;
  }
  return { directory, nodePath };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  return address.port;
}

export async function smokePublicArtifact(directory = resolve('dist/public-reader'), options: { nodePath?: string } = {}) {
  // Fail before filesystem mode changes, port allocation or ambiguous startup polling.
  const runtime = await selectSmokeRuntime(options.nodePath);
  const root = resolve(directory);
  let before: Awaited<ReturnType<typeof inspectPublicArtifact>>;
  try { before = await inspectPublicArtifact(root); } catch { throw new SmokeError('SMOKE_ARTIFACT_INVALID'); }
  const modes: { path: string; mode: number }[] = [];
  const unix = process.platform !== 'win32';
  const nonRoot = typeof process.getuid === 'function' ? process.getuid() !== 0 : null;
  if (nonRoot === false) throw Error('SMOKE_REQUIRES_NON_ROOT_USER');
  async function readonly(path: string): Promise<void> {
    const info = await stat(path); modes.push({ path, mode: info.mode & 0o777 });
    if (info.isDirectory()) for (const entry of await readdir(path)) await readonly(join(path, entry));
    await chmod(path, info.isDirectory() ? 0o555 : 0o444);
  }
  try {
    if (unix) await readonly(root);
    for (const [mode, signal] of [['staging', 'SIGTERM'], ['production', 'SIGINT']] as const) {
      const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
      const controlled = smokeShutdownStrategy() === 'controlled-ipc';
      const running = spawnPublicProcess({ executable: runtime.executable, entryPoint: join(root, 'src/public/main.ts'),
        cwd: root, controlled, environment: {
          PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
          NODE_ENV: mode, HOST: '127.0.0.1', PORT: String(port),
          NWS_USER_AGENT: 'Dayline synthetic smoke (no live requests; smoke@dayline.test)',
          PUBLIC_BASE_URL: 'https://dayline-staging.test', SHUTDOWN_TIMEOUT_MS: '1000',
        },
      });
      try {
        let healthy = false;
        for (let attempt = 0; attempt < 50 && running.child.exitCode === null && running.child.signalCode === null; attempt++) {
          try { const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(500) }); await response.arrayBuffer(); if (response.status === 200) { healthy = true; break; } } catch {}
          await delay(100);
        }
        if (!healthy) throw new SmokeError('SMOKE_STARTUP_FAILED');
        for (const [path, method, expected] of [['/', 'GET', 200], ['/api/ready', 'GET', 503],
          ['/internal/principal', 'GET', 404], ['/internal/stories', 'POST', 405],
          ['/dev/edition', 'GET', 404], ['/.env', 'GET', 404], ['/src/security/http.ts', 'GET', 404],
          ['/internal/operations', 'GET', 404], ['/internal/operations/operations.js', 'GET', 404],
          ['/internal/operations/operations.css', 'HEAD', 404], ['/internal/operations/overview', 'POST', 405],
          ['/internal/operations/login', 'POST', 405]] as const) {
          const response = await fetch(origin + path, { method, headers: { Authorization: 'Bearer synthetic_smoke_sentinel' }, signal: AbortSignal.timeout(2000) });
          const text = await response.text();
          assert.equal(response.status, expected, 'ARTIFACT_ROUTE_ISOLATION_FAILED');
          assert.equal(text.includes('synthetic_smoke_sentinel'), false, 'CREDENTIAL_REFLECTION');
        }
        try {
          if (controlled) {
            await running.requestShutdown();
            await assert.rejects(fetch(origin + '/api/health', { signal: AbortSignal.timeout(500) }));
          } else if (!running.child.kill(signal)) throw Error();
          assert.deepEqual(await running.waitForExit(5000), { code: 0, signal: null });
        } catch { throw new SmokeError('SMOKE_SHUTDOWN_FAILED'); }
        console.log(JSON.stringify({ event: 'public_artifact_smoke', mode, signal: controlled ? null : signal,
          shutdownStrategy: smokeShutdownStrategy(), runtimeVersion: runtime.version, runtimeSelection: runtime.selection,
          health: 200, readiness: 503, upstreamRequests: 0, routeIsolation: 'passed', nonRoot, readonlyFilesystem: unix, shutdown: 'passed' }));
      } finally { await running.cleanup(); }
    }
    assert.deepEqual(await inspectPublicArtifact(root), before, 'ARTIFACT_CHANGED_DURING_RUNTIME');
  } finally {
    // Restore only this inspected generated artifact's original modes, even if smoke fails.
    for (const entry of modes) await chmod(entry.path, entry.mode);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseSmokeArguments(process.argv.slice(2));
    await smokePublicArtifact(args.directory ? resolve(args.directory) : undefined, { nodePath: args.nodePath });
  } catch (error) {
    console.error(JSON.stringify({ event: 'public_artifact_smoke_failed', code: error instanceof SmokeError ? error.code : 'SMOKE_VALIDATION_FAILED' }));
    process.exitCode = 1;
  }
}
