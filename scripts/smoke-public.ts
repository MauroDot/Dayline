/** Local artifact smoke only: never requests an official-data upstream or deploys anything. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectPublicArtifact } from './inspect-public.ts';

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  return address.port;
}

export async function smokePublicArtifact(directory = resolve('dist/public-reader')) {
  const root = resolve(directory), before = await inspectPublicArtifact(root);
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
      const child = spawn(process.execPath, ['--experimental-strip-types', join(root, 'src/public/main.ts')], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
          PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
          NODE_ENV: mode, HOST: '127.0.0.1', PORT: String(port),
          NWS_USER_AGENT: 'Dayline synthetic smoke (no live requests; smoke@dayline.test)',
          PUBLIC_BASE_URL: 'https://dayline-staging.test', SHUTDOWN_TIMEOUT_MS: '1000',
        },
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
        child.once('error', fail); child.once('exit', (code, stoppedBy) => done({ code, signal: stoppedBy }));
      });
      void exited.catch(() => undefined);
      // Drain bounded operational output; never print a child's raw errors or environment.
      let outputBytes = 0;
      const drain = (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 65_536) child.kill('SIGKILL'); };
      child.stdout.on('data', drain); child.stderr.on('data', drain);
      try {
        let healthy = false;
        for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) {
          try { const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(500) }); await response.arrayBuffer(); if (response.status === 200) { healthy = true; break; } } catch {}
          await delay(100);
        }
        assert.ok(healthy, 'ARTIFACT_STARTUP_FAILED');
        for (const [path, method, expected] of [['/', 'GET', 200], ['/api/ready', 'GET', 503],
          ['/internal/principal', 'GET', 404], ['/internal/stories', 'POST', 405],
          ['/dev/edition', 'GET', 404], ['/.env', 'GET', 404], ['/src/security/http.ts', 'GET', 404]] as const) {
          const response = await fetch(origin + path, { method, headers: { Authorization: 'Bearer synthetic_smoke_sentinel' }, signal: AbortSignal.timeout(2000) });
          const text = await response.text();
          assert.equal(response.status, expected, 'ARTIFACT_ROUTE_ISOLATION_FAILED');
          assert.equal(text.includes('synthetic_smoke_sentinel'), false, 'CREDENTIAL_REFLECTION');
        }
        child.kill(signal);
        const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
        try { assert.deepEqual(await exited, { code: 0, signal: null }, 'ARTIFACT_SHUTDOWN_FAILED'); }
        finally { clearTimeout(deadline); }
        console.log(JSON.stringify({ event: 'public_artifact_smoke', mode, signal, health: 200, readiness: 503,
          upstreamRequests: 0, routeIsolation: 'passed', nonRoot, readonlyFilesystem: unix, shutdown: 'passed' }));
      } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited.catch(() => undefined); }
    }
    assert.deepEqual(await inspectPublicArtifact(root), before, 'ARTIFACT_CHANGED_DURING_RUNTIME');
  } finally {
    // Restore only this inspected generated artifact's original modes, even if smoke fails.
    for (const entry of modes) await chmod(entry.path, entry.mode);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await smokePublicArtifact(process.argv[2] ? resolve(process.argv[2]) : undefined);
}
