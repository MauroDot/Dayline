import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPackagedRuntimeVersion, readPublicProvenance, safePublicLog, startPublicRuntime } from '../src/public/main.ts';
import { attachPublicLifecycle } from '../src/public/lifecycle.ts';
import { spawnPublicProcess } from './helpers/public-process.ts';

const contact = 'Dayline/0.1 (synthetic runtime test; runtime@dayline.test)';
async function port(): Promise<number> {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address(); assert.ok(value && typeof value !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return value.port;
}
async function launch(controlled = false) {
  const bindPort = await port();
  const running = spawnPublicProcess({ entryPoint: resolve('src/public/main.ts'), controlled,
    environment: { ...process.env, NODE_ENV: 'staging', HOST: '127.0.0.1', PORT: String(bindPort), NWS_USER_AGENT: contact, SHUTDOWN_TIMEOUT_MS: '1000' },
  });
  let exited = false; void running.exited.then(() => { exited = true; }, () => { exited = true; });
  const base = `http://127.0.0.1:${bindPort}`;
  try {
    for (let tries = 0; tries < 100; tries++) {
      if (exited) throw Error('PUBLIC_CHILD_STARTUP_FAILED');
      try { const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) }); await response.arrayBuffer(); if (response.status === 200) return { ...running, base }; } catch {}
      await new Promise(done => setTimeout(done, 20));
    }
    throw Error('PUBLIC_CHILD_STARTUP_TIMEOUT');
  } catch (error) { await running.cleanup(); throw error; }
}
test('startup and failure log sanitizer never serializes supplied secrets headers URLs or stack traces', () => {
  const value = safePublicLog({ event: 'public_started', requestId: '00000000-0000-0000-0000-000000000001', mode: 'staging', host: '127.0.0.1', port: 3000,
    revision: 'a'.repeat(40), sourceDirty: false, authorization: 'Bearer private-test-token', userAgent: contact, stack: 'private-stack', error: Error('private-error'), url: 'https://private.test/?token=secret' });
  assert.deepEqual(Object.keys(value).sort(), ['event', 'host', 'mode', 'port', 'requestId', 'revision', 'sourceDirty']);
  assert.doesNotMatch(JSON.stringify(value), /private|runtime@|Bearer|token|secret|stack/);
  assert.deepEqual(safePublicLog({ event: 'secret-event', code: 'secret-code', revision: '/private/path', port: -1 }), { event: 'request_failure' });
});
test('packaged deployments require the exact pinned runtime rather than accepting a newer major version', () => {
  assert.doesNotThrow(() => assertPackagedRuntimeVersion('22.16.0'));
  for (const version of ['22.15.0', '22.16.1', '24.22.1', '', 'private-runtime-value']) {
    assert.throws(() => assertPackagedRuntimeVersion(version), error => error instanceof Error && error.message === 'UNSUPPORTED_PUBLIC_RUNTIME');
  }
});
test('generated runtime packages require intact provenance instead of falling back after manifest removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dayline-runtime-provenance-'));
  const url = pathToFileURL(root + '/');
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dayline-public-reader', type: 'module' }));
    await assert.rejects(readPublicProvenance(url), { message: 'INVALID_PUBLIC_ARTIFACT' });
    await writeFile(join(root, 'public-manifest.json'), JSON.stringify({ provenance: { commit: 'private-invalid-metadata' } }));
    await assert.rejects(readPublicProvenance(url), { message: 'INVALID_PUBLIC_ARTIFACT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('only the recognized source package may report unpackaged provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dayline-source-provenance-'));
  const url = pathToFileURL(root + '/');
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dayline' }));
    assert.deepEqual(await readPublicProvenance(url), { revision: 'unpackaged' });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'unknown-package' }));
    await assert.rejects(readPublicProvenance(url), { message: 'INVALID_PUBLIC_ARTIFACT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('invalid production startup fails before listening and emits one fixed sanitized failure category', () => {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', 'src/public/main.ts'], {
    env: { ...process.env, NODE_ENV: 'production', NWS_USER_AGENT: 'private-startup-secret', PORT: '3000' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 1); const event = child.stderr.split('\n').find(line => line.startsWith('{')); assert.ok(event);
  assert.equal(JSON.parse(event).event, 'public_start_failed'); assert.equal(JSON.parse(event).code, 'INVALID_NWS_IDENTIFICATION');
  assert.doesNotMatch(child.stdout + child.stderr, /private-startup-secret|public_started/);
});
test('staging startup rejects fixture activation rather than falling back to a development server', () => {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', 'src/public/main.ts'], {
    env: { ...process.env, NODE_ENV: 'staging', NWS_USER_AGENT: contact, DAYLINE_DEV_EDITION: 'fictional' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 1); assert.match(child.stderr, /DEVELOPMENT_CONFIGURATION_FORBIDDEN/); assert.doesNotMatch(child.stdout, /public_started/);
});
test('public runtime starts independently and distinguishes health from unknown upstream readiness without network calls', async () => {
  let calls = 0; const logs: Record<string, unknown>[] = [];
  const runtime = await startPublicRuntime({ environment: { NODE_ENV: 'staging', HOST: '127.0.0.1', PORT: String(await port()), NWS_USER_AGENT: contact },
    fetcher: (async () => { calls++; throw Error('private-upstream-error'); }) as typeof fetch, log: event => logs.push(event) });
  const base = `http://127.0.0.1:${runtime.config.port}`;
  try {
    const health = await fetch(base + '/api/health'); assert.equal(health.status, 200); await health.arrayBuffer();
    const ready = await fetch(base + '/api/ready'); assert.equal(ready.status, 503); assert.equal((await ready.json()).ready, false);
    assert.equal(calls, 0); assert.equal(logs[0].event, 'public_started'); assert.doesNotMatch(JSON.stringify(logs), /runtime@dayline|private-upstream/);
    for (const path of ['/dev/edition', '/internal/principal', '/src/security/http.ts']) { const response = await fetch(base + path); assert.equal(response.status, 404); await response.arrayBuffer(); }
  } finally { await runtime.close(); }
  assert.equal(logs.at(-1)!.event, 'public_stopped'); await assert.rejects(fetch(base + '/api/health'));
});
test('late listener failures are logged as fixed safe categories without raw exception details', async () => {
  const logs: Record<string, unknown>[] = [];
  const runtime = await startPublicRuntime({ environment: { PORT: String(await port()) }, log: event => logs.push(event) });
  try {
    runtime.server.emit('error', Error('private-listener-path and credential'));
    assert.equal(logs.at(-1)!.event, 'request_failure'); assert.equal(logs.at(-1)!.code, 'INTERNAL');
    assert.doesNotMatch(JSON.stringify(logs), /private-listener|credential|stack/);
  } finally { await runtime.close(); }
});
const windowsSignalReason = 'Windows child.kill does not deliver POSIX signals; controlled IPC shutdown is verified separately';
for (const signal of ['SIGTERM', 'SIGINT'] as const) test(`public CLI handles ${signal} with structured bounded clean shutdown`, {
  skip: process.platform === 'win32' ? windowsSignalReason : false,
}, async () => {
  const running = await launch();
  try {
    const ready = await fetch(running.base + '/api/ready'); assert.equal(ready.status, 503); await ready.arrayBuffer();
    running.child.kill(signal); assert.deepEqual(await running.waitForExit(), { code: 0, signal: null });
    assert.match(running.output(), /"event":"public_started"/); assert.match(running.output(), /"event":"public_stopped"/);
    assert.doesNotMatch(running.output(), /runtime@dayline|Bearer/);
  } finally { await running.cleanup(); }
});
test('controlled child shutdown stops accepting requests and bounds accepted connections', async () => {
  const running = await launch(true);
  const socket = net.connect(Number(new URL(running.base).port), '127.0.0.1');
  socket.on('error', () => {});
  try {
    await once(socket, 'connect');
    socket.write('GET / HTTP/1.1\r\nHost: local\r\n');
    const socketClosed = new Promise<void>(done => socket.once('close', () => done()));
    const started = Date.now();
    await running.requestShutdown();
    // The acknowledgement is sent after server.close() stops listening, while accepted work is still bounded.
    assert.equal(running.child.exitCode, null);
    await assert.rejects(fetch(running.base + '/api/health', { signal: AbortSignal.timeout(500) }));
    assert.deepEqual(await running.waitForExit(), { code: 0, signal: null });
    await socketClosed;
    assert.ok(Date.now() - started < 4000);
    assert.match(running.output(), /"event":"public_shutdown_forced"/);
    assert.match(running.output(), /"event":"public_stopped"/);
    assert.doesNotMatch(running.output(), /runtime@dayline|Bearer/);
  } finally { socket.destroy(); await running.cleanup(); }
});
test('controlled test child closes its listener and exits nonzero when its parent IPC channel is lost', async () => {
  const running = await launch(true);
  try {
    running.child.disconnect();
    assert.deepEqual(await running.waitForExit(), { code: 1, signal: null });
    await assert.rejects(fetch(running.base + '/api/health', { signal: AbortSignal.timeout(500) }));
    assert.match(running.output(), /"event":"public_stopped"/);
  } finally { await running.cleanup(); }
});
test('lifecycle bounds shutdown for a partially received request and closes accepted sockets', async () => {
  const server = http.createServer((_req, _res) => {}), events: string[] = [];
  const lifecycle = attachPublicLifecycle(server, { shutdownTimeoutMs: 100, log: value => events.push(value.event) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const socket = net.connect(address.port, '127.0.0.1'); socket.on('error', () => {}); await once(socket, 'connect'); socket.write('GET / HTTP/1.1\r\nHost: local\r\n');
  const started = Date.now(); await lifecycle.close(); assert.ok(Date.now() - started < 2000); assert.equal(server.listening, false);
  assert.ok(events.includes('public_shutdown_forced')); assert.equal(events.at(-1), 'public_stopped');
  socket.destroy(); await lifecycle.close();
});
