import test from 'node:test';
import assert from 'node:assert/strict';
import { getDebt, getWeather, validNwsUserAgent, type FetchLike } from '../src/official-data.ts';

const contact = 'Dayline deterministic test (fixture@dayline.invalid)';
const debt = { data: [{ record_date: '2026-11-03', tot_pub_debt_out_amt: '900719925474099312345.03', debt_held_public_amt: '900719925474099312345.01', intragov_hold_amt: '0.02' }] };
const points = { properties: { forecast: 'https://api.weather.gov/gridpoints/TSA/1,1/forecast' } };
const weather = { properties: { updated: '2026-11-03T12:00:00Z', periods: [{ name: 'Today', temperature: 12, temperatureUnit: 'C', detailedForecast: 'Fictional controlled forecast', windSpeed: '5 mph' }] } };
const response = (value: unknown, status = 200) => ({ ok: status === 200, status, json: async () => value }) as Response;

test('public adapters reject out-of-range timeout configuration before calling upstream', async () => {
  let calls = 0;
  const fetcher: FetchLike = async () => { calls++; return response(debt); };
  for (const timeoutMs of [0, 99, 10001, 100.5, NaN, Infinity]) {
    const result = await getDebt(fetcher, { timeoutMs });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, 'Invalid upstream timeout');
    assert.equal((await getWeather('Tulsa', fetcher, { timeoutMs, userAgent: contact })).ok, false);
  }
  assert.equal(calls, 0);
});

test('public debt adapter keeps exact cents and official date with explicit timeout', async () => {
  const result = await getDebt(async (_url, options) => {
    assert.ok(options?.signal);
    assert.equal(options.redirect, 'error');
    return response(debt);
  }, { timeoutMs: 100 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.total, '900719925474099312345.03');
    assert.equal(result.value.asOf, '2026-11-03');
    assert.equal(Number.isFinite(Date.parse(result.fetchedAt)), true);
  }
});

test('public timeout rejects noncooperative fetch promises after only three attempts', async () => {
  let calls = 0;
  const result = await getDebt((async () => { calls++; return new Promise<Response>(() => {}); }) as FetchLike, { timeoutMs: 100 });
  assert.equal(calls, 3);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'Upstream request failed or timed out');
  assert.equal('value' in result, false);
});

test('public timeout also covers response JSON bodies that never settle', async () => {
  let calls = 0;
  const result = await getDebt(async () => {
    calls++;
    return { ok: true, status: 200, json: () => new Promise(() => {}) } as unknown as Response;
  }, { timeoutMs: 100 });
  assert.equal(calls, 3);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'Upstream request failed or timed out');
});

test('bounded retries recover after a timed-out JSON body without returning the failed body', async () => {
  let calls = 0;
  const result = await getDebt(async () => ++calls === 1
    ? { ok: true, status: 200, json: () => new Promise(() => {}) } as unknown as Response
    : response(debt), { timeoutMs: 100 });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test('upstream exception text cannot impersonate an adapter HTTP error or leak private details', async () => {
  let calls = 0;
  const result = await getDebt(async () => { calls++; throw Error('Upstream HTTP 500 private-provider-credential'); }, { timeoutMs: 100 });
  assert.equal(calls, 3);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'Upstream request failed or timed out');
});

test('configured NWS identification is used for both requests and preserves official update time', async () => {
  const observed: string[] = [];
  const fetcher: FetchLike = async (input, options) => {
    observed.push(new Headers(options?.headers).get('user-agent') ?? '');
    return response(String(input).includes('/points/') ? points : weather);
  };
  const result = await getWeather('Tulsa', fetcher, { timeoutMs: 100, userAgent: contact });
  assert.deepEqual(observed, [contact, contact]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.sourceUpdatedAt, '2026-11-03T12:00:00Z');
    assert.equal(result.value.temperatureF, 53.6);
  }
});

test('explicitly missing or invalid NWS identification never falls back to ambient contact', async () => {
  const previous = process.env.NWS_USER_AGENT;
  process.env.NWS_USER_AGENT = contact;
  let calls = 0;
  try {
    for (const userAgent of [undefined, '', 'private-contact@example.com', 'Dayline\r\nInjected: value']) {
      const result = await getWeather('Tulsa', async () => { calls++; return response(points); }, { userAgent });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, 'NWS_USER_AGENT must identify the application and include a real contact email');
    }
    assert.equal(calls, 0);
  } finally { if (previous === undefined) delete process.env.NWS_USER_AGENT; else process.env.NWS_USER_AGENT = previous; }
});

test('NWS forecast requests reject foreign hosts credentials ports fragments and insecure protocols', async () => {
  for (const forecast of ['https://api.weather.gov.attacker.test/forecast', 'https://user:secret@api.weather.gov/forecast', 'https://api.weather.gov:9443/forecast', 'http://api.weather.gov/forecast', 'https://api.weather.gov/forecast#private', '//api.weather.gov/forecast', 'not a URL']) {
    let calls = 0;
    const result = await getWeather('Tulsa', async () => { calls++; return response({ properties: { forecast } }); }, { userAgent: contact, timeoutMs: 100 });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, 'Unexpected NWS forecast URL');
  }
});

test('NWS malformed or timed-out forecast bodies return no fabricated forecast', async () => {
  let calls = 0;
  const result = await getWeather('Tulsa', async input => {
    calls++;
    return String(input).includes('/points/') ? response(points)
      : { ok: true, status: 200, json: () => new Promise(() => {}) } as unknown as Response;
  }, { userAgent: contact, timeoutMs: 100 });
  assert.equal(calls, 4);
  assert.equal(result.ok, false);
  assert.equal('value' in result, false);
});

test('NWS identification has a finite header limit and rejects controls', () => {
  assert.equal(validNwsUserAgent(contact), true);
  assert.equal(validNwsUserAgent('x'.repeat(513) + contact), false);
  assert.equal(validNwsUserAgent(contact + '\n'), true); // Outer whitespace is intentionally trimmed.
  assert.equal(validNwsUserAgent('Dayline\nfixture@dayline.invalid'), false);
});

test('upstream response Content-Length above one MiB is rejected and cancelled before reading', async () => {
  let calls = 0, cancelled = 0;
  const result = await getDebt(async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { headers: { 'content-length': String(1024 * 1024 + 1) } });
  }, { timeoutMs: 100 });
  assert.equal(result.ok, false); assert.equal('value' in result, false);
  assert.equal(calls, 3); assert.equal(cancelled, 3);
});

test('chunked upstream data cannot exceed one MiB and overflowing streams are cancelled', async () => {
  let calls = 0, cancelled = 0;
  const result = await getDebt(async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(600_000)); controller.enqueue(new Uint8Array(600_000)); },
      cancel() { cancelled++; },
    }));
  }, { timeoutMs: 100 });
  assert.equal(result.ok, false); assert.equal('value' in result, false);
  assert.equal(calls, 3); assert.equal(cancelled, 3);
});

test('json-only controlled doubles obey the response cap in UTF-8 bytes', async () => {
  let calls = 0;
  const result = await getDebt(async () => { calls++; return response({ ...debt, padding: '€'.repeat(400_000) }); }, { timeoutMs: 100 });
  assert.equal(result.ok, false); assert.equal('value' in result, false); assert.equal(calls, 3);
});

test('upstream body deadlines cancel stalled real response streams within the retry bound', async () => {
  let calls = 0, cancelled = 0;
  const result = await getDebt(async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }));
  }, { timeoutMs: 100 });
  assert.equal(result.ok, false); assert.equal(calls, 3); assert.equal(cancelled, 3);
  if (!result.ok) assert.equal(result.error, 'Upstream request failed or timed out');
});

test('Treasury requires an array, a real calendar date and bounded decimal strings', async () => {
  const base = debt.data[0];
  for (const value of [
    { data: { 0: base } }, { data: [{ ...base, record_date: '2026-02-30' }] },
    { data: [{ ...base, record_date: '2026-13-01' }] }, { data: [{ ...base, record_date: 20261103 }] },
    { data: [{ ...base, tot_pub_debt_out_amt: '9'.repeat(129) }] },
  ]) {
    const result = await getDebt(async () => response(value), { timeoutMs: 100 });
    assert.equal(result.ok, false); assert.equal('value' in result, false);
  }
  const valid = await getDebt(async () => new Response(JSON.stringify(debt)), { timeoutMs: 100 });
  assert.equal(valid.ok, true); if (valid.ok) assert.equal(valid.value.asOf, '2026-11-03');
});

test('NWS rejects malformed or excessive text and timestamps without coercing invented forecasts', async () => {
  const period = weather.properties.periods[0];
  const bad = [
    { ...weather.properties, periods: { 0: period } },
    { ...weather.properties, periods: [{ ...period, name: { private: 'not text' } }] },
    { ...weather.properties, periods: [{ ...period, name: 'x'.repeat(257) }] },
    { ...weather.properties, periods: [{ ...period, detailedForecast: [] }] },
    { ...weather.properties, periods: [{ ...period, detailedForecast: 'x'.repeat(65537) }] },
    { ...weather.properties, periods: [{ ...period, windSpeed: 42 }] },
    { ...weather.properties, periods: [{ ...period, windSpeed: 'x'.repeat(257) }] },
    { ...weather.properties, updated: '2026-02-30T12:00:00Z' },
    { ...weather.properties, updated: '2026-11-03T24:00:00Z' },
    { ...weather.properties, updated: null }, { ...weather.properties, updated: 1 },
  ];
  for (const properties of bad) {
    const result = await getWeather('Tulsa', async input => response(String(input).includes('/points/') ? points : { properties }), { userAgent: contact, timeoutMs: 100 });
    assert.equal(result.ok, false); assert.equal('value' in result, false);
  }
  for (const updated of [undefined, '2026-11-03T12:00:00+00:00']) {
    const result = await getWeather('Tulsa', async input => new Response(JSON.stringify(String(input).includes('/points/') ? points : { properties: { periods: [period], updated } })), { userAgent: contact, timeoutMs: 100 });
    assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.sourceUpdatedAt, updated ?? null);
  }
});
