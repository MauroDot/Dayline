/** Official-source adapters. No sample measurements are returned as real data. */
export type FetchLike = typeof fetch;
export type FeedResult<T> = { ok: true; value: T; fetchedAt: string } | { ok: false; error: string; fetchedAt: string };
export type Debt = { asOf: string; total: string; heldByPublic: string; intragovernmental: string };
export type Weather = { location: string; period: string; description: string; temperatureF: number; wind: string; sourceUpdatedAt: string | null };

const treasury = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page%5Bsize%5D=1";
const cityCoords: Record<string, string> = { Tulsa: "36.154,-95.993", "New York": "40.713,-74.006", Chicago: "41.878,-87.630", Seattle: "47.606,-122.332" };
function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid monetary value");
  return value;
}
async function readJSON(url: string, fetcher: FetchLike, userAgent?: string): Promise<any> {
  const response = await fetcher(url, { headers: { Accept: "application/json", ...(userAgent ? { "User-Agent": userAgent } : {}) }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("Upstream HTTP " + response.status);
  return response.json();
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
    if (Math.abs(Number(total) - Number(heldByPublic) - Number(intragovernmental)) > 0.05) throw new Error("Debt component mismatch");
    return { ok: true, value: { asOf: item.record_date, total, heldByPublic, intragovernmental }, fetchedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown source failure", fetchedAt };
  }
}
export const availableCities = Object.keys(cityCoords);
export async function getWeather(city: string, fetcher: FetchLike = fetch): Promise<FeedResult<Weather>> {
  const fetchedAt = new Date().toISOString();
  if (!(city in cityCoords)) return { ok: false, error: "Unsupported city", fetchedAt };
  const ua = process.env.NWS_USER_AGENT || "Dayline MVP (contact: configure NWS_USER_AGENT)";
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
    return { ok: false, error: error instanceof Error ? error.message : "Unknown source failure", fetchedAt };
  }
}
