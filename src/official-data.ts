/** Official-source adapters. No sample measurements are returned as real data. */
export type FetchLike = typeof fetch;
export type FeedResult<T> = { ok: true; value: T; fetchedAt: string } | { ok: false; error: string; fetchedAt: string };
export type Debt = { asOf: string; total: string; heldByPublic: string; intragovernmental: string };
export type Weather = { location: string; period: string; description: string; temperatureF: number; wind: string; sourceUpdatedAt: string | null };
/** Trusted public-process settings; an explicitly supplied userAgent never falls back to ambient configuration. */
export interface UpstreamOptions { timeoutMs?: number; userAgent?: string }

const treasury = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page%5Bsize%5D=1";
const cityCoords: Record<string, string> = { Tulsa: "36.154,-95.993", "New York": "40.713,-74.006", Chicago: "41.878,-87.630", Seattle: "47.606,-122.332" };
function decimal(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("Invalid monetary value");
  return value;
}
function cents(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
class UpstreamHTTPError extends Error {
  readonly status: number;
  constructor(status: number) { super("Upstream HTTP " + status); this.status = status; }
}
function timeoutSetting(options: UpstreamOptions): number {
  const timeout = options.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 10000) throw new Error("Invalid upstream timeout");
  return timeout;
}
const responseByteLimit = 1024 * 1024;
function cancel(body: ReadableStream<Uint8Array> | null | undefined): void {
  try { void body?.cancel().catch(() => {}); } catch {}
}
async function boundedJSON(response: Response, setCancel: (operation: (() => void) | undefined) => void): Promise<any> {
  const length = response.headers?.get('content-length');
  if (length !== undefined && length !== null && (!/^\d+$/.test(length) || Number(length) > responseByteLimit)) {
    cancel(response.body); throw new Error('Invalid upstream response size');
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0, complete = false;
    const stop = () => { try { void reader.cancel().catch(() => {}); } catch {} };
    setCancel(stop);
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) { complete = true; break; }
        size += chunk.value.byteLength;
        if (size > responseByteLimit) throw new Error('Invalid upstream response size');
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size); let position = 0;
      for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally { if (!complete) stop(); setCancel(undefined); reader.releaseLock(); }
  }
  // Compatibility for controlled json-only test doubles. Real Fetch responses use the bounded stream above.
  const value: unknown = await response.json();
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || serialized.length > responseByteLimit || Buffer.byteLength(serialized) > responseByteLimit) throw new Error('Invalid upstream response size');
  return value;
}
function reportDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
function sourceTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 35 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !reportDate(value.slice(0, 10)) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return false;
  return Number.isFinite(Date.parse(value));
}
const boundedText = (value: unknown, maximum: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum;
/** The explicit deadline also covers noncooperative fetch/body implementations used by controlled tests. */
async function requestJSON(url: string, fetcher: FetchLike, timeoutMs: number, userAgent?: string): Promise<any> {
  const signal = AbortSignal.timeout(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelBody: (() => void) | undefined;
  let expired = false;
  let onAbort = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = () => { expired = true; cancelBody?.(); reject(new Error("Upstream request failed or timed out")); };
    timer = setTimeout(onAbort, timeoutMs);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  const request = (async () => {
    const response = await fetcher(url, { headers: { Accept: "application/json", ...(userAgent ? { "User-Agent": userAgent } : {}) }, signal, redirect: "error" });
    if (expired) { cancel(response.body); throw new Error('Upstream request failed or timed out'); }
    if (!response.ok) { cancel(response.body); throw new UpstreamHTTPError(response.status); }
    return await boundedJSON(response, operation => { cancelBody = operation; });
  })();
  try { return await Promise.race([request, deadline]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
}
async function readJSON(url: string, fetcher: FetchLike, timeoutMs: number, userAgent?: string): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await requestJSON(url, fetcher, timeoutMs, userAgent);
    } catch (error) {
      if (error instanceof UpstreamHTTPError && !((error.status === 429 || error.status >= 500) && attempt < 2)) throw error;
      if (attempt === 2) throw new Error("Upstream request failed or timed out");
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw new Error("Upstream request failed");
}
export async function getDebt(fetcher: FetchLike = fetch, options: UpstreamOptions = {}): Promise<FeedResult<Debt>> {
  const fetchedAt = new Date().toISOString();
  try {
    const payload = await readJSON(treasury, fetcher, timeoutSetting(options));
    if (!Array.isArray(payload?.data)) throw new Error('Invalid Treasury response');
    const item = payload.data[0];
    if (!reportDate(item?.record_date)) throw new Error("Invalid report date");
    const total = decimal(item.tot_pub_debt_out_amt);
    const heldByPublic = decimal(item.debt_held_public_amt);
    const intragovernmental = decimal(item.intragov_hold_amt);
    // Tolerance accounts for independent currency decimal rounding in Treasury's source.
    if ((cents(total) - cents(heldByPublic) - cents(intragovernmental) < -5n) || (cents(total) - cents(heldByPublic) - cents(intragovernmental) > 5n)) throw new Error("Debt component mismatch");
    return { ok: true, value: { asOf: item.record_date, total, heldByPublic, intragovernmental }, fetchedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error && /^(Upstream HTTP \d+|Upstream request failed|Invalid |Debt component mismatch|Unexpected NWS|Incomplete NWS|Unsupported NWS)/.test(error.message) ? error.message : "Invalid upstream response", fetchedAt };
  }
}
export const availableCities = Object.keys(cityCoords);
export function validNwsUserAgent(value: string | undefined): boolean {
  const ua = value?.trim();
  return !!ua && ua.length <= 512 && /^[\x20-\x7e]+$/.test(ua) && /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(ua) && !/example\.(com|org|net)/i.test(ua);
}
export async function getWeather(city: string, fetcher: FetchLike = fetch, options: UpstreamOptions = {}): Promise<FeedResult<Weather>> {
  const fetchedAt = new Date().toISOString();
  if (!Object.hasOwn(cityCoords, city)) return { ok: false, error: "Unsupported city", fetchedAt };
  const ua = (Object.hasOwn(options, 'userAgent') ? options.userAgent : process.env.NWS_USER_AGENT)?.trim();
  if (!validNwsUserAgent(ua)) return { ok: false, error: "NWS_USER_AGENT must identify the application and include a real contact email", fetchedAt };
  try {
    const timeoutMs = timeoutSetting(options);
    const points = await readJSON("https://api.weather.gov/points/" + cityCoords[city], fetcher, timeoutMs, ua);
    const forecastUrl: unknown = points?.properties?.forecast;
    let trustedForecast = false;
    if (typeof forecastUrl === "string") {
      try { const url = new URL(forecastUrl); trustedForecast = url.protocol === 'https:' && url.hostname === 'api.weather.gov' && !url.username && !url.password && !url.port && !url.hash; } catch {}
    }
    if (!trustedForecast || typeof forecastUrl !== "string") throw new Error("Unexpected NWS forecast URL");
    const payload = await readJSON(forecastUrl, fetcher, timeoutMs, ua);
    const period = Array.isArray(payload?.properties?.periods) ? payload.properties.periods[0] : undefined;
    const updated: unknown = payload?.properties?.updated;
    if (!period || !Number.isFinite(period.temperature) || !boundedText(period.name, 256) || !boundedText(period.detailedForecast, 65536)
      || (period.windSpeed !== undefined && (typeof period.windSpeed !== 'string' || period.windSpeed.length > 256))
      || (updated !== undefined && !sourceTimestamp(updated))) throw new Error("Incomplete NWS forecast");
    const tempF = period.temperatureUnit === "C" ? period.temperature * 9 / 5 + 32 : period.temperatureUnit === "F" ? period.temperature : NaN;
    if (!Number.isFinite(tempF)) throw new Error("Unsupported NWS temperature unit");
    return { ok: true, value: { location: city, period: period.name, description: period.detailedForecast, temperatureF: tempF, wind: period.windSpeed ?? "", sourceUpdatedAt: updated as string | undefined ?? null }, fetchedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error && /^(Upstream HTTP \d+|Upstream request failed|Invalid |Debt component mismatch|Unexpected NWS|Incomplete NWS|Unsupported NWS)/.test(error.message) ? error.message : "Invalid upstream response", fetchedAt };
  }
}
