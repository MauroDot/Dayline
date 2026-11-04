import test from "node:test";
import assert from "node:assert/strict";
import { getDebt, getWeather } from "../src/official-data.ts";
import { createCache } from "../src/cache.ts";
process.env.NWS_USER_AGENT = "DaylineTest/1.0 (test@dayline.invalid)";
const response = (data: unknown, status = 200) => ({ ok: status === 200, status, json: async () => data }) as Response;
const fake = (body: unknown) => (async () => response(body)) as typeof fetch;
test("treasury parses official record and components", async () => {
  const result = await getDebt(fake({ data: [{ record_date: "2026-11-03", tot_pub_debt_out_amt: "300.00", debt_held_public_amt: "220.00", intragov_hold_amt: "80.00" }] }));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { asOf: "2026-11-03", total: "300.00", heldByPublic: "220.00", intragovernmental: "80.00" });
});
test("treasury rejects inconsistent records", async () => {
  const result = await getDebt(fake({ data: [{ record_date: "2026-11-03", tot_pub_debt_out_amt: "300.00", debt_held_public_amt: "220.00", intragov_hold_amt: "70.00" }] }));
  assert.equal(result.ok, false);
});
test("treasury rejects missing records", async () => assert.equal((await getDebt(fake({ data: [] }))).ok, false));
test("weather rejects unsupported cities before network access", async () => {
  const result = await getWeather("NotACity", (() => { throw Error("Unexpected network request"); }) as typeof fetch);
  assert.equal(result.ok, false);
});
test("weather parses NWS point and forecast", async () => {
  const fetcher = (async (url: string) => response(url.includes("/points/") ? { properties: { forecast: "https://api.weather.gov/gridpoints/TSA/1,1/forecast" } } : { properties: { updated: "2026-11-04T12:00:00Z", periods: [{ name: "Today", temperature: 20, temperatureUnit: "C", detailedForecast: "Clear skies", windSpeed: "5 mph" }] } })) as typeof fetch;
  const result = await getWeather("Tulsa", fetcher);
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.value.temperatureF, 68); assert.equal(result.value.description, "Clear skies"); }
});
test("weather rejects untrusted forecast URL", async () => assert.equal((await getWeather("Tulsa", fake({ properties: { forecast: "https://evil.example/" } }))).ok, false));
test("cache deduplicates concurrent loads", async () => {
  const cached = createCache<number>(1000);
  let calls = 0;
  const load = async () => { calls++; return 42; };
  const results = await Promise.all([cached(load, 10000), cached(load, 10000)]);
  assert.equal(calls, 1);
  assert.equal(results[0].data, 42);
});
test("cache returns stale previous value on source failure", async () => {
  const cached = createCache<number>(1000, 5000);
  await cached(async () => 10, 10000);
  const next = await cached(async () => { throw Error("upstream"); }, 11500);
  assert.equal(next.stale, true);
  assert.equal(next.data, 10);
});
test("cache fails closed when stale allowance expires", async () => {
  const cached = createCache<number>(1000, 2000);
  await cached(async () => 10, 10000);
  await assert.rejects(cached(async () => { throw Error("upstream"); }, 13000));
});
test("debt uses exact cents for large amounts and tolerance", async () => {
  const record = (total: string) => fake({data:[{record_date:'2026-11-03',tot_pub_debt_out_amt:total,debt_held_public_amt:'900719925474099312345.01',intragov_hold_amt:'0.02'}]});
  assert.equal((await getDebt(record('900719925474099312345.08'))).ok, true);
  assert.equal((await getDebt(record('900719925474099312345.09'))).ok, false);
  assert.equal((await getDebt(record('1.001'))).ok, false);
  assert.equal((await getDebt(record('-1.00'))).ok, false);
});
test('transient HTTP errors retry, permanent errors do not', async () => {
  let calls = 0;
  const transient = (async () => { calls++; return response({}, 503); }) as typeof fetch;
  const result = await getDebt(transient); assert.equal(result.ok, false); assert.equal(calls, 3);
  calls = 0;
  const permanent = (async () => { calls++; return response({}, 400); }) as typeof fetch;
  await getDebt(permanent); assert.equal(calls, 1);
});
test('weather requires identifying contact and never calls upstream without it', async () => {
  const old = process.env.NWS_USER_AGENT; delete process.env.NWS_USER_AGENT;
  try { const result = await getWeather('Tulsa', (() => { throw Error('unexpected'); }) as typeof fetch); assert.equal(result.ok, false); if (!result.ok) assert.match(result.error, /NWS_USER_AGENT/); }
  finally { process.env.NWS_USER_AGENT = old; }
});
test('cache retains source timestamp and fresh value until expiry', async () => {
  const cache = createCache<{sourceUpdatedAt:string}>(1000);
  const first = await cache(async () => ({sourceUpdatedAt:'2026-11-04T12:00:00Z'}), 10000);
  const second = await cache(async () => { throw Error('unexpected'); }, 10999);
  assert.equal(second.cachedAt, first.cachedAt); assert.equal(second.data.sourceUpdatedAt, '2026-11-04T12:00:00Z'); assert.equal(second.stale, false);
});
test('zero and cent values preserve official reporting date', async () => {
  for (const [total, held, intra] of [['0','0.00','0'], ['0.03','0.01','0.02']]) {
    const result = await getDebt(fake({data:[{record_date:'2026-01-02',tot_pub_debt_out_amt:total,debt_held_public_amt:held,intragov_hold_amt:intra}]}));
    assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.asOf, '2026-01-02');
  }
});
test('missing fields and invalid monetary formats fail closed', async () => {
  for (const value of [undefined, '', '1.', '.01', '1e3', 'NaN', '1.001', '-1']) {
    const result = await getDebt(fake({data:[{record_date:'2026-01-02',tot_pub_debt_out_amt:value,debt_held_public_amt:'0',intragov_hold_amt:'0'}]}));
    assert.equal(result.ok, false);
  }
});
test('transient errors recover within retry limit', async () => {
  let calls = 0;
  const fetcher = (async () => ++calls < 3 ? response({}, 503) : response({data:[{record_date:'2026-01-02',tot_pub_debt_out_amt:'0',debt_held_public_amt:'0',intragov_hold_amt:'0'}]})) as typeof fetch;
  assert.equal((await getDebt(fetcher)).ok, true); assert.equal(calls, 3);
});
test('timeout failures are bounded and sanitized', async () => {
  let calls = 0;
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => AbortSignal.abort(new DOMException('private upstream details', 'TimeoutError'));
  try {
    const fetcher = (async (_url, options) => { calls++; assert.ok(options?.signal?.aborted); throw options.signal.reason; }) as typeof fetch;
    const result = await getDebt(fetcher); assert.equal(calls, 3); assert.equal(result.ok, false);
    if (!result.ok) { assert.match(result.error, /timed out/); assert.doesNotMatch(result.error, /private/); }
  } finally { AbortSignal.timeout = originalTimeout; }
});
test('NWS HTTP failures and malformed payloads return errors', async () => {
  for (const fetcher of [(async () => response({}, 400)) as typeof fetch, fake({properties:{forecast:'https://api.weather.gov/gridpoints/X/1,1/forecast'}})]) {
    const result = await getWeather('Tulsa', fetcher); assert.equal(result.ok, false);
  }
});
