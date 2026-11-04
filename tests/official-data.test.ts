import test from "node:test";
import assert from "node:assert/strict";
import { getDebt, getWeather } from "../src/official-data.ts";
import { createCache } from "../src/cache.ts";
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
