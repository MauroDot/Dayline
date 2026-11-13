import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicServer, type SafePublicEvent } from '../src/public/reader.ts';
import { parsePublicConfiguration } from '../src/public/config.ts';

async function fixture(fetcher: typeof fetch, run: (origin: string, logs: SafePublicEvent[]) => Promise<void>, now = () => Date.now()) {
  const logs: SafePublicEvent[] = [];
  const server = createPublicServer({ config: parsePublicConfiguration({ NODE_ENV: 'staging',
    NWS_USER_AGENT: 'Dayline synthetic categories (fixture@dayline.test)', UPSTREAM_TIMEOUT_MS: '100' }),
    fetcher, now, log: event => logs.push(event) });
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`, logs); }
  finally { await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); }
}
function safe(logs: SafePublicEvent[], code: string, source = 'treasury') {
  assert.ok(logs.some(row => row.event === 'upstream_failure' && row.code === code && row.source === source));
  for (const row of logs) {
    assert.deepEqual(Object.keys(row).sort(), ['code', 'event', 'requestId', 'source']);
    assert.match(row.requestId, /^[a-f0-9-]{36}$/);
  }
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|fixture@|https?:\/\/|private/);
}

test('official HTTP rejection has a fixed category without logging upstream status text or bodies', async () => {
  await fixture(async () => new Response('PRIVATE_BODY_SECRET', { status: 400 }), async (origin, logs) => {
    const response = await fetch(origin + '/api/debt'); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Official debt data currently unavailable' });
    safe(logs, 'UPSTREAM_HTTP');
  });
});

test('official schema failures are distinct from application failures and return no fabricated debt', async () => {
  await fixture(async () => Response.json({ data: [{ record_date: '2026-11-03', tot_pub_debt_out_amt: 'PRIVATE_SCHEMA_SECRET' }] }), async (origin, logs) => {
    const response = await fetch(origin + '/api/debt'); assert.equal(response.status, 503);
    assert.equal((await response.json()).data, undefined); safe(logs, 'UPSTREAM_RESPONSE_INVALID');
    const ready = await fetch(origin + '/api/ready'); assert.equal(ready.status, 503); await ready.arrayBuffer();
    const health = await fetch(origin + '/api/health'); assert.equal(health.status, 200); await health.arrayBuffer();
  });
});

test('combined network or timeout failures retain an honest generic request-failure category', async () => {
  let attempts = 0;
  await fixture(async () => { attempts++; throw Error('https://private.test/?token=PRIVATE_FETCH_SECRET'); }, async (origin, logs) => {
    const response = await fetch(origin + '/api/debt'); assert.equal(response.status, 503); await response.arrayBuffer();
    assert.equal(attempts, 3); safe(logs, 'UPSTREAM_REQUEST_FAILED');
    assert.equal(logs.some(row => row.code === 'TIMEOUT'), false);
  });
});

test('NWS schema failures preserve the cached official timestamp while reporting stale readiness and a safe category', async () => {
  let time = 1_000_000, failed = false;
  const fetcher: typeof fetch = async input => String(input).includes('/points/')
    ? Response.json({ properties: { forecast: 'https://api.weather.gov/gridpoints/TEST/1,1/forecast' } })
    : Response.json({ properties: { updated: '2026-11-03T12:00:00Z', periods: [{ name: 'Fictional period',
      detailedForecast: failed ? { token: 'PRIVATE_FORECAST_SECRET' } : 'Synthetic forecast for a deterministic test',
      temperature: 72, temperatureUnit: 'F', windSpeed: '5 mph' }] } });
  await fixture(fetcher, async (origin, logs) => {
    const initial = await fetch(origin + '/api/weather?city=Tulsa'); const first = await initial.json();
    assert.equal(initial.status, 200); assert.equal(first.stale, false);
    time += 30 * 60 * 1000 + 1; failed = true;
    const response = await fetch(origin + '/api/weather?city=Tulsa'); const stale = await response.json();
    assert.equal(response.status, 200); assert.equal(stale.stale, true); assert.deepEqual(stale.data, first.data);
    assert.equal(stale.data.sourceUpdatedAt, '2026-11-03T12:00:00Z');
    safe(logs, 'UPSTREAM_RESPONSE_INVALID', 'nws');
    const ready = await fetch(origin + '/api/ready'); assert.equal(ready.status, 503); await ready.arrayBuffer();
  }, () => time);
});
