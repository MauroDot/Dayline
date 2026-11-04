/** Official-source adapters. No sample measurements are returned as real data. */
export type FetchLike = typeof fetch;
export type FeedResult<T> = { ok: true; value: T; fetchedAt: string } | { ok: false; error: string; fetchedAt: string };
export type Debt = { asOf: string; total: string; heldByPublic: string; intragovernmental: string };
export type Weather = { location: string; period: string; description: string; temperatureF: number; wind: string; sourceUpdatedAt: string | null };

const treasury = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page%5Bsize%5D=1";
const cityCoords: Record<string, string> = { Tulsa: "36.154,-95.993", "New York": "40.713,-74.006", Chicago: "41.878,-87.630", Seattle: "47.606,-122.332" };
function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("Invalid monetary value");
  return value;
}
function cents(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
async function readJSON(url: string, fetcher: FetchLike, userAgent?: string): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(url, { headers: { Accept: "application/json", ...(userAgent ? { "User-Agent": userAgent } : {}) }, signal: AbortSignal.timeout(8000), redirect: "error" });
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < 2) { await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1))); continue; }
        throw new Error("Upstream HTTP " + response.status);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Upstream HTTP ")) throw error;
      if (attempt === 2) throw new Error("Upstream request failed or timed out");
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw new Error("Upstream request failed");
}
export async function getDebt(fetcher: FetchLike = fetch): Promise<FeedResult<Debt>> {
  const fetchedAt = new Date().toISOString();
  try {
    const payload = await readJSON(treasury, fetcher);
    const item = payload?.data?.[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item?.record_date ?? "")) throw new Error("Invalid report date");
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
  return !!ua && /^[\x20-\x7e]+$/.test(ua) && /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(ua) && !/example\.(com|org|net)/i.test(ua);
}
export async function getWeather(city: string, fetcher: FetchLike = fetch): Promise<FeedResult<Weather>> {
  const fetchedAt = new Date().toISOString();
  if (!Object.hasOwn(cityCoords, city)) return { ok: false, error: "Unsupported city", fetchedAt };
  const ua = process.env.NWS_USER_AGENT?.trim();
  if (!validNwsUserAgent(ua)) return { ok: false, error: "NWS_USER_AGENT must identify the application and include a real contact email", fetchedAt };
  try {
    const points = await readJSON("https://api.weather.gov/points/" + cityCoords[city], fetcher, ua);
    const forecastUrl: unknown = points?.properties?.forecast;
    if (typeof forecastUrl !== "string" || !forecastUrl.startsWith("https://api.weather.gov/")) throw new Error("Unexpected NWS forecast URL");
    const payload = await readJSON(forecastUrl, fetcher, ua);
    const period = payload?.properties?.periods?.[0];
    if (!period || !Number.isFinite(period.temperature) || !period.name || !period.detailedForecast) throw new Error("Incomplete NWS forecast");
    const tempF = period.temperatureUnit === "C" ? period.temperature * 9 / 5 + 32 : period.temperatureUnit === "F" ? period.temperature : NaN;
    if (!Number.isFinite(tempF)) throw new Error("Unsupported NWS temperature unit");
    return { ok: true, value: { location: city, period: String(period.name), description: String(period.detailedForecast), temperatureF: tempF, wind: String(period.windSpeed ?? ""), sourceUpdatedAt: payload?.properties?.updated ?? null }, fetchedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error && /^(Upstream HTTP \d+|Upstream request failed|Invalid |Debt component mismatch|Unexpected NWS|Incomplete NWS|Unsupported NWS)/.test(error.message) ? error.message : "Invalid upstream response", fetchedAt };
  }
}
