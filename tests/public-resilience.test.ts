/** Deterministic hosted-operation scenarios. No request in this file contacts a government service. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicServer, type PublicServerOptions } from '../src/public/reader.ts';
import { parsePublicConfiguration } from '../src/public/config.ts';
import { attachPublicLifecycle } from '../src/public/lifecycle.ts';

const startingTime = Date.parse('2026-06-05T12:00:00Z');
const contact = 'Dayline deterministic resilience (fixture@dayline.test)';
const config = () => parsePublicConfiguration({ NODE_ENV: 'staging', NWS_USER_AGENT: contact });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(value: Promise<T>, timeout = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([value, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('RESILIENCE_TEST_DEADLINE')), timeout); })]); }
  finally { clearTimeout(timer); }
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
async function reply(origin: string, path: string) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: record(await response.json()), headers: response.headers };
}
async function ready(origin: string) { return reply(origin, '/api/ready'); }
async function started(options: Partial<PublicServerOptions> = {}) {
  const server = createPublicServer({ config: config(), ...options });
  const lifecycle = attachPublicLifecycle(server, { shutdownTimeoutMs: 100 });
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { server, origin: `http://127.0.0.1:${address.port}`, close: lifecycle.close };
}
function fixtureData(generation: number) {
  return {
    date: generation === 1 ? '2026-06-05' : '2026-06-06',
    updated: generation === 1 ? '2026-06-05T12:00:00Z' : '2026-06-06T12:00:00Z',
    debt: { data: [{ record_date: generation === 1 ? '2026-06-05' : '2026-06-06', tot_pub_debt_out_amt: `${generation * 3}.00`, debt_held_public_amt: `${generation * 2}.00`, intragov_hold_amt: `${generation}.00` }] },
    forecast: { properties: { updated: generation === 1 ? '2026-06-05T12:00:00Z' : '2026-06-06T12:00:00Z', periods: [{ name: 'Synthetic test period', detailedForecast: `Fictional resilience forecast ${generation}`, temperature: 60 + generation, temperatureUnit: 'F', windSpeed: '5 mph' }] } },
  };
}
function fixtureResponse(input: Parameters<typeof fetch>[0], generation = 1): Response {
  const url = String(input), data = fixtureData(generation);
  if (url.includes('api.fiscaldata.treasury.gov/')) return Response.json(data.debt);
  if (url.startsWith('https://api.weather.gov/points/')) return Response.json({ properties: { forecast: 'https://api.weather.gov/gridpoints/TSA/1,1/forecast' } });
  if (url === 'https://api.weather.gov/gridpoints/TSA/1,1/forecast') return Response.json(data.forecast);
  throw Error('UNEXPECTED_SYNTHETIC_UPSTREAM');
}
async function populate(origin: string) {
  assert.equal((await reply(origin, '/api/debt')).status, 200);
  assert.equal((await reply(origin, '/api/weather?city=Tulsa')).status, 200);
}

test('sleep-style replacement starts with independent empty caches and never reuses prior readiness', async () => {
  let now = startingTime, calls = 0;
  const fetcher: typeof fetch = async input => { calls++; return fixtureResponse(input); };
  const first = await started({ fetcher, now: () => now });
  try {
    await populate(first.origin); assert.equal((await ready(first.origin)).status, 200); assert.equal(calls, 3);
  } finally { await first.close(); }
  now += 5 * 60_000;
  const second = await started({ fetcher, now: () => now });
  try {
    for (let probe = 0; probe < 3; probe++) {
      assert.equal((await reply(second.origin, '/api/health')).status, 200);
      const observation = await ready(second.origin);
      assert.equal(observation.status, 503); assert.equal(observation.body.ready, false);
      assert.deepEqual(observation.body.checks, { assets: true, treasury: 'unknown', nws: 'unknown' });
    }
    assert.equal(calls, 3, 'health and readiness must not warm a restarted process');
    const debt = await reply(second.origin, '/api/debt');
    assert.equal(debt.status, 200); assert.equal(record(debt.body.data).asOf, fixtureData(1).date);
    assert.equal((await ready(second.origin)).status, 503);
    const weather = await reply(second.origin, '/api/weather?city=Tulsa');
    assert.equal(weather.status, 200); assert.equal(record(weather.body.data).sourceUpdatedAt, fixtureData(1).updated);
    assert.equal((await ready(second.origin)).status, 200); assert.equal(calls, 6);
  } finally { await second.close(); }
});

test('one warmed process remains honest across a prolonged outage, stale expiry and later new observations', async () => {
  let now = startingTime, generation = 1, outage = false, calls = 0;
  const fetcher: typeof fetch = async input => { calls++; return outage ? new Response('{}', { status: 400 }) : fixtureResponse(input, generation); };
  const instance = await started({ fetcher, now: () => now });
  try {
    await populate(instance.origin); assert.equal((await ready(instance.origin)).status, 200);
    outage = true; now += 60 * 60_000 + 1;
    const staleDebt = await reply(instance.origin, '/api/debt'), staleWeather = await reply(instance.origin, '/api/weather?city=Tulsa');
    for (const sample of [staleDebt, staleWeather]) { assert.equal(sample.status, 200); assert.equal(sample.body.stale, true); }
    assert.equal(record(staleDebt.body.data).total, '3.00');
    assert.equal(record(staleWeather.body.data).description, 'Fictional resilience forecast 1');
    assert.equal((await ready(instance.origin)).status, 503); assert.equal((await reply(instance.origin, '/api/health')).status, 200);
    const observedCalls = calls;
    for (let probe = 0; probe < 5; probe++) assert.equal((await ready(instance.origin)).status, 503);
    assert.equal(calls, observedCalls);
    now = startingTime + 25 * 60 * 60_000;
    for (const path of ['/api/debt', '/api/weather?city=Tulsa']) {
      const unavailable = await reply(instance.origin, path);
      assert.equal(unavailable.status, 503); assert.equal(unavailable.body.data, undefined); assert.equal(unavailable.body.stale, undefined);
    }
    generation = 2; outage = false;
    const newDebt = await reply(instance.origin, '/api/debt');
    assert.equal(newDebt.status, 200); assert.equal(newDebt.body.stale, false);
    assert.equal(record(newDebt.body.data).total, '6.00'); assert.equal(record(newDebt.body.data).asOf, fixtureData(2).date);
    assert.equal((await ready(instance.origin)).status, 503, 'weather is still unavailable despite recovered debt');
    const newWeather = await reply(instance.origin, '/api/weather?city=Tulsa');
    assert.equal(newWeather.status, 200); assert.equal(newWeather.body.stale, false);
    assert.equal(record(newWeather.body.data).sourceUpdatedAt, fixtureData(2).updated);
    assert.equal(record(newWeather.body.data).description, 'Fictional resilience forecast 2');
    assert.equal((await ready(instance.origin)).status, 200);
  } finally { await instance.close(); }
});

test('a failed secondary location remains an explicit readiness blocker until that location recovers', async () => {
  let failChicago = true, now = startingTime;
  const fetcher: typeof fetch = async input => String(input).includes('/points/41.878') && failChicago ? new Response('{}', { status: 400 }) : fixtureResponse(input);
  const instance = await started({ fetcher, now: () => now });
  try {
    await populate(instance.origin); assert.equal((await ready(instance.origin)).status, 200);
    assert.equal((await reply(instance.origin, '/api/weather?city=Chicago')).status, 503);
    for (const city of ['Tulsa', 'New York', 'Seattle']) assert.equal((await reply(instance.origin, '/api/weather?city=' + encodeURIComponent(city))).status, 200);
    assert.equal((await ready(instance.origin)).status, 503);
    failChicago = false;
    assert.equal((await reply(instance.origin, '/api/weather?city=Chicago')).status, 200);
    assert.equal((await ready(instance.origin)).status, 200);
    now += 30 * 60_000;
    assert.equal((await ready(instance.origin)).status, 503);
    await populate(instance.origin);
    assert.equal((await ready(instance.origin)).status, 503, 'unrefreshed sampled cities must not disappear');
    for (const city of ['Chicago', 'New York', 'Seattle']) assert.equal((await reply(instance.origin, '/api/weather?city=' + encodeURIComponent(city))).status, 200);
    assert.equal((await ready(instance.origin)).status, 200);
  } finally { await instance.close(); }
});

test('a concurrent NWS recovery wave shares one points request and one bounded forecast retry sequence', async () => {
  const clients = 12, received = deferred(), entered = deferred(), release = deferred();
  let requestCount = 0, pointsCalls = 0, forecastCalls = 0;
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url.includes('/points/')) { pointsCalls++; entered.resolve(); await release.promise; return fixtureResponse(input); }
    if (url.includes('/gridpoints/')) { forecastCalls++; if (forecastCalls < 3) return new Response('{}', { status: forecastCalls === 1 ? 429 : 503 }); }
    return fixtureResponse(input);
  };
  const instance = await started({ fetcher });
  instance.server.on('request', req => { if (req.url === '/api/weather?city=Tulsa' && ++requestCount === clients) received.resolve(); });
  const pending = Array.from({ length: clients }, () => reply(instance.origin, '/api/weather?city=Tulsa'));
  try {
    await bounded(entered.promise); await bounded(received.promise); release.resolve();
    const samples = await Promise.all(pending);
    assert.ok(samples.every(sample => sample.status === 200 && sample.body.stale === false));
    assert.equal(pointsCalls, 1); assert.equal(forecastCalls, 3);
    for (const sample of samples) assert.equal(record(sample.body.data).sourceUpdatedAt, fixtureData(1).updated);
    assert.equal((await ready(instance.origin)).status, 503, 'NWS alone does not fabricate Treasury readiness');
    assert.equal((await reply(instance.origin, '/api/debt')).status, 200);
    assert.equal((await ready(instance.origin)).status, 200);
  } finally { release.resolve(); await Promise.allSettled(pending); await instance.close(); }
});

test('concurrent retry exhaustion returns unavailable data once per shared load and can later recover', async () => {
  const clients = 10, received = deferred(), release = deferred();
  let calls = 0, requests = 0, outage = true;
  const fetcher: typeof fetch = async input => { calls++; if (outage) { if (calls === 1) await release.promise; return new Response('{}', { status: 503 }); } return fixtureResponse(input, 2); };
  const instance = await started({ fetcher });
  instance.server.on('request', req => { if (req.url === '/api/debt' && ++requests === clients) received.resolve(); });
  const pending = Array.from({ length: clients }, () => reply(instance.origin, '/api/debt'));
  try {
    await bounded(received.promise); release.resolve();
    const samples = await Promise.all(pending);
    assert.equal(calls, 3);
    for (const sample of samples) { assert.equal(sample.status, 503); assert.equal(sample.body.data, undefined); }
    assert.equal((await reply(instance.origin, '/api/health')).status, 200); assert.equal((await ready(instance.origin)).status, 503);
    outage = false;
    const recovered = await reply(instance.origin, '/api/debt');
    assert.equal(recovered.status, 200); assert.equal(record(recovered.body.data).asOf, fixtureData(2).date); assert.equal(calls, 4);
    assert.equal((await ready(instance.origin)).status, 503);
  } finally { release.resolve(); await Promise.allSettled(pending); await instance.close(); }
});

test('capacity held by a timed-out old observation cannot contaminate the next hosted instance', async () => {
  const entered = deferred(), release = deferred();
  let oldCalls = 0, newCalls = 0;
  const old = await started({ config: { ...config(), maxConcurrentRequests: 1, requestTimeoutMs: 50, headersTimeoutMs: 50 },
    fetcher: async input => { oldCalls++; entered.resolve(); await release.promise; return fixtureResponse(input); } });
  const pending = reply(old.origin, '/api/debt');
  let replacement: Awaited<ReturnType<typeof started>> | undefined;
  try {
    await bounded(entered.promise); assert.equal((await pending).status, 503);
    const rejected = await reply(old.origin, '/api/debt');
    assert.equal(rejected.status, 503); assert.equal(rejected.headers.get('retry-after'), '1'); assert.equal(oldCalls, 1);
    assert.equal((await reply(old.origin, '/api/health')).status, 200);
    replacement = await started({ fetcher: async input => { newCalls++; return fixtureResponse(input, 2); } });
    assert.equal((await ready(replacement.origin)).status, 503); assert.equal(newCalls, 0);
    await populate(replacement.origin); assert.equal((await ready(replacement.origin)).status, 200); assert.equal(newCalls, 3);
    release.resolve(); await delay(20);
    assert.equal((await ready(old.origin)).status, 503, 'late old-instance completion cannot clear its timed-out observation');
    assert.equal((await ready(replacement.origin)).status, 200);
  } finally { release.resolve(); await pending.catch(() => undefined); if (replacement) await replacement.close(); await old.close(); }
});

test('bounded shutdown releases client admission during pending source work and restart remains cold', async () => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const instance = await started({ fetcher: async input => { calls++; entered.resolve(); await release.promise; return fixtureResponse(input); } });
  const pending = fetch(instance.origin + '/api/debt').then(async value => { await value.arrayBuffer(); return value.status; }, () => 'closed' as const);
  let replacement: Awaited<ReturnType<typeof started>> | undefined;
  try {
    await bounded(entered.promise);
    const closing = instance.close();
    assert.equal(instance.server.listening, false);
    await assert.rejects(fetch(instance.origin + '/api/health', { signal: AbortSignal.timeout(500) }));
    await bounded(closing, 2000); assert.equal(await bounded(pending), 'closed'); assert.equal(calls, 1);
    release.resolve(); await delay(20);
    replacement = await started({ fetcher: async () => { calls++; throw Error('A probe must not trigger source work'); } });
    assert.equal((await reply(replacement.origin, '/api/health')).status, 200);
    const state = await ready(replacement.origin); assert.equal(state.status, 503);
    assert.deepEqual(state.body.checks, { assets: true, treasury: 'unknown', nws: 'unknown' });
    assert.equal(calls, 1);
  } finally { release.resolve(); await pending.catch(() => undefined); if (replacement) await replacement.close(); await instance.close(); }
});
