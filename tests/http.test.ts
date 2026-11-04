import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
let child: ChildProcess;
let base: string;
before(async () => {
  const socket = net.createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw Error('No port');
  base = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve, reject) => socket.close(err => err ? reject(err) : resolve()));
  child = spawn(process.execPath, ['--experimental-strip-types', 'server.ts'], { env: { ...process.env, PORT: String(address.port) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Server did not start');
});
after(() => child?.kill());
test('health and security headers', async () => {
  const r = await fetch(base + '/api/health');
  assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});
test('static allowlist and content security policy', async () => {
  const r = await fetch(base + '/'); assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.match(await r.text(), /dayline/i);
  for (const path of ['/server.ts', '/.env', '/missing', '/%2e%2e/server.ts']) assert.equal((await fetch(base + path)).status, 404);
  for (const path of ['/style.css', '/app.js', '/stories.js']) assert.equal((await fetch(base + path)).status, 200);
});
test('invalid inputs and methods', async () => {
  assert.equal((await fetch(base + '/api/weather?city=constructor')).status, 400);
  assert.equal((await fetch(base + '/api/unknown')).status, 404);
  assert.equal((await fetch(base + '/api/health', { method: 'POST' })).status, 405);
});

test('HTTP cache coalesces loads, serves stale data, and expires without fabrication', async () => {
  const { createServer } = await import('../server.ts');
  let now = 100000, calls = 0, fail = false;
  const fetcher = (async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return new Response(JSON.stringify(fail ? {} : { data: [{record_date:'2026-11-03',tot_pub_debt_out_amt:'3.00',debt_held_public_amt:'2.00',intragov_hold_amt:'1.00'}] }), {status: fail ? 400 : 200});
  }) as typeof fetch;
  const server = createServer({fetcher, now: () => now});
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No port');
  const endpoint = `http://127.0.0.1:${address.port}/api/debt`;
  try {
    const responses = await Promise.all(Array.from({length: 8}, () => fetch(endpoint)));
    const bodies = await Promise.all(responses.map(r => r.json()));
    assert.equal(calls, 1); assert.ok(responses.every(r => r.status === 200));
    assert.equal(bodies[0].data.asOf, '2026-11-03'); assert.ok(bodies[0].data.fetchedAt); assert.equal(bodies[0].stale, false);
    now += 3600001; fail = true;
    const stale = await fetch(endpoint); const body = await stale.json();
    assert.equal(stale.status, 200); assert.equal(body.stale, true); assert.equal(body.data.total, '3.00');
    now += 86400000;
    const expired = await fetch(endpoint); const failure = await expired.json();
    assert.equal(expired.status, 503); assert.equal(failure.data, undefined); assert.equal(failure.error, 'Official debt data currently unavailable');
  } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
});

test('HTTP unavailable sources return errors without invented values', async () => {
  const { createServer } = await import('../server.ts');
  const old = process.env.NWS_USER_AGENT; process.env.NWS_USER_AGENT = 'Dayline test (test@dayline.invalid)';
  const fetcher = (async () => new Response('{}', {status:400})) as typeof fetch;
  const server = createServer({fetcher});
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No port');
  try {
    for (const path of ['/api/debt', '/api/weather?city=Tulsa']) {
      const r: Response = await fetch(`http://127.0.0.1:${address.port}${path}`); const body = await r.json();
      assert.equal(r.status, 503); assert.equal(body.data, undefined); assert.ok(body.error);
    }
    process.env.NWS_USER_AGENT = 'placeholder@example.com';
    const r = await fetch(`http://127.0.0.1:${address.port}/api/weather?city=Tulsa`);
    assert.equal(r.status, 503); assert.match((await r.json()).error, /NWS_USER_AGENT/);
  } finally {
    if (old === undefined) delete process.env.NWS_USER_AGENT; else process.env.NWS_USER_AGENT = old;
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
