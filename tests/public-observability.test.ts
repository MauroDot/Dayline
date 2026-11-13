import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { createPublicOperationalLogger, safePublicLog, startPublicRuntime } from '../src/public/main.ts';

const requestId = '00000000-0000-0000-0000-000000000001';
const failure = { event: 'upstream_failure', source: 'nws', code: 'UPSTREAM_REQUEST_FAILED', requestId };

test('routine operational failures have one global finite budget across sources and correlation identifiers', () => {
  const output: Record<string, unknown>[] = [];
  const log = createPublicOperationalLogger({ sink: event => output.push(event), now: () => 100 });
  for (let index = 0; index < 1000; index++) {
    log({ ...failure, source: index % 2 ? 'nws' : 'treasury', requestId: `${String(index).padStart(8, '0')}-0000-0000-0000-000000000001` });
  }
  assert.equal(output.length, 100);
  assert.ok(output.every(event => event.event === 'upstream_failure'));
  assert.ok(output.every(event => !Object.hasOwn(event, 'suppressed')));
});

test('a later window records a bounded suppression summary without starting a logging timer', () => {
  const output: Record<string, unknown>[] = [];
  let now = 0;
  const log = createPublicOperationalLogger({ sink: event => output.push(event), now: () => now, maxEventsPerWindow: 3, windowMs: 1000 });
  for (let index = 0; index < 8; index++) log(failure);
  assert.equal(output.length, 3);
  now = 999; log(failure); assert.equal(output.length, 3);
  now = 1000; log(failure);
  assert.deepEqual(output[3], { event: 'operational_logs_suppressed', code: 'LOG_LIMIT', suppressed: 6 });
  assert.deepEqual(output[4], failure);
  log(failure); log(failure);
  assert.equal(output.length, 6); // Summary and two samples share the new three-record budget.
  now = 2000; log(failure);
  assert.deepEqual(output[6], { event: 'operational_logs_suppressed', code: 'LOG_LIMIT', suppressed: 1 });
});

test('shutdown and startup events remain visible during an outage but each lifecycle category emits only once', () => {
  const output: Record<string, unknown>[] = [];
  const log = createPublicOperationalLogger({ sink: event => output.push(event), now: () => 0, maxEventsPerWindow: 1 });
  for (let index = 0; index < 100; index++) log(failure);
  const critical = ['public_started', 'public_start_failed', 'public_stopping', 'public_stopped', 'public_shutdown_forced', 'public_shutdown_failed'];
  for (let index = 0; index < 50; index++) for (const event of critical) log({ event, code: 'SHUTDOWN_FAILED' });
  assert.equal(output.length, 7);
  assert.deepEqual(output.slice(1).map(event => event.event), critical);
});

test('invalid throwing and backwards clocks cannot replenish an exhausted failure budget', () => {
  const output: Record<string, unknown>[] = [];
  let now = 1000, throws = false;
  const log = createPublicOperationalLogger({ sink: event => output.push(event), now: () => { if (throws) throw Error('private clock'); return now; }, maxEventsPerWindow: 2, windowMs: 1000 });
  log(failure); log(failure);
  for (const value of [500, -1, NaN, Infinity]) { now = value; log(failure); }
  throws = true; log(failure); throws = false;
  assert.equal(output.length, 2);
  now = 1999; log(failure); assert.equal(output.length, 2);
  now = 2000; log(failure);
  assert.deepEqual(output[2], { event: 'operational_logs_suppressed', code: 'LOG_LIMIT', suppressed: 6 });
  assert.equal(output.length, 4);
});

test('separate runtime logger instances start with independent cold-process budgets', () => {
  const first: Record<string, unknown>[] = [], second: Record<string, unknown>[] = [];
  const one = createPublicOperationalLogger({ sink: event => first.push(event), now: () => 0, maxEventsPerWindow: 1 });
  const two = createPublicOperationalLogger({ sink: event => second.push(event), now: () => 0, maxEventsPerWindow: 1 });
  one(failure); one(failure); two(failure);
  assert.equal(first.length, 1); assert.equal(second.length, 1);
});

test('sanitization precedes the sink and exposes only fixed source-failure categories and correlation IDs', () => {
  const output: Record<string, unknown>[] = [];
  const log = createPublicOperationalLogger({ sink: event => output.push(event), now: () => 0 });
  for (const code of ['UPSTREAM_HTTP', 'UPSTREAM_RESPONSE_INVALID', 'UPSTREAM_REQUEST_FAILED']) {
    log({ ...failure, code, url: 'https://private.test/?bearer=secret', authorization: 'Bearer private-token',
      userAgent: 'private-contact@dayline.test', error: Error('raw government response'), payload: 'untrusted body' });
  }
  assert.deepEqual(output.map(event => event.code), ['UPSTREAM_HTTP', 'UPSTREAM_RESPONSE_INVALID', 'UPSTREAM_REQUEST_FAILED']);
  assert.ok(output.every(event => event.requestId === requestId));
  assert.doesNotMatch(JSON.stringify(output), /private|Bearer|raw government|untrusted|https:/);
  assert.deepEqual(safePublicLog({ event: 'operational_logs_suppressed', suppressed: Number.MAX_SAFE_INTEGER, token: 'secret' }),
    { event: 'operational_logs_suppressed', code: 'LOG_LIMIT' });
});

test('untrusted getters and coercion hooks are not evaluated by operational log sanitization', () => {
  let invoked = false;
  const value = Object.defineProperty({ event: 'request_failure', mode: { toString() { invoked = true; throw Error('private mode'); } } },
    'code', { get() { invoked = true; throw Error('private error'); } });
  assert.deepEqual(safePublicLog(value), { event: 'request_failure' });
  assert.equal(invoked, false);
  const hostile = new Proxy({}, { ownKeys() { throw Error('private proxy detail'); } });
  assert.deepEqual(safePublicLog(hostile), { event: 'request_failure' });
});

test('throwing and asynchronously rejected sinks cannot change request or lifecycle outcomes', async () => {
  const throwing = createPublicOperationalLogger({ sink: () => { throw Error('private sink'); } });
  assert.doesNotThrow(() => throwing(failure));
  assert.doesNotThrow(() => throwing({ event: 'public_stopped' }));
  const rejecting = createPublicOperationalLogger({ sink: async () => { throw Error('private asynchronous sink'); } });
  rejecting(failure); rejecting({ event: 'public_stopped' });
  await setImmediate(); // The test runner would detect an unhandled rejection.
});

test('logger configuration rejects unbounded or invalid budgets with fixed errors', () => {
  for (const maxEventsPerWindow of [0, -1, NaN, Infinity, 1.5, 1001]) {
    assert.throws(() => createPublicOperationalLogger({ maxEventsPerWindow }), { message: 'INVALID_LOG_CONFIGURATION' });
  }
  for (const windowMs of [0, -1, NaN, Infinity, 1.5, 3_600_001]) {
    assert.throws(() => createPublicOperationalLogger({ windowMs }), { message: 'INVALID_LOG_CONFIGURATION' });
  }
});

test('a real reader keeps liveness and stopped evidence during a bounded listener-error flood', async () => {
  const reserved = net.createServer();
  await new Promise<void>(done => reserved.listen(0, '127.0.0.1', done));
  const address = reserved.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, fail) => reserved.close(error => error ? fail(error) : done()));
  const output: Record<string, unknown>[] = [];
  const runtime = await startPublicRuntime({ environment: { NODE_ENV: 'staging', HOST: '127.0.0.1', PORT: String(address.port),
    NWS_USER_AGENT: 'Dayline synthetic test (no live requests; log@dayline.test)' }, now: () => 0, log: event => output.push(event) });
  try {
    for (let index = 0; index < 500; index++) runtime.server.emit('error', Error('private listener token and path'));
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(response.status, 200); await response.arrayBuffer();
    assert.equal(output.filter(event => event.event === 'request_failure').length, 100);
    assert.equal(output[0].event, 'public_started');
    assert.doesNotMatch(JSON.stringify(output), /private|log@dayline/);
  } finally { await runtime.close(); }
  assert.deepEqual(output.slice(-2).map(event => event.event), ['public_stopping', 'public_stopped']);
  assert.equal(output.length, 103);
});
