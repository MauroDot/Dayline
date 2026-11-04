import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCache } from "./src/cache.ts";
import { availableCities, getDebt, getWeather } from "./src/official-data.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public");
const port = Number(process.env.PORT || 3000);
const debtCache = createCache(60 * 60 * 1000);
const weatherCaches = new Map(availableCities.map(city => [city, createCache(30 * 60 * 1000)]));
const json = (res: http.ServerResponse, status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(data)); };
const types: Record<string,string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/api/health") return json(res, 200, { ok: true, service: "dayline", mode: "foundation" });
    if (url.pathname === "/api/debt") {
      try {
        const result = await debtCache(async () => {
          const data = await getDebt();
          if (!data.ok) throw Error(data.error);
          return data.value;
        });
        return json(res, 200, { source: "U.S. Treasury Fiscal Data", ...result });
      } catch { return json(res, 503, { error: "Official debt data currently unavailable" }); }
    }
    if (url.pathname === "/api/weather") {
      const city = url.searchParams.get("city") || "Tulsa";
      const cached = weatherCaches.get(city);
      if (!cached) return json(res, 400, { error: "Unsupported location", cities: availableCities });
      try {
        const result = await cached(async () => {
          const data = await getWeather(city);
          if (!data.ok) throw Error(data.error);
          return data.value;
        });
        return json(res, 200, { source: "National Weather Service", ...result });
      } catch { return json(res, 503, { error: "Official weather data currently unavailable" }); }
    }
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "Unknown endpoint" });
    const asset = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!["index.html", "style.css", "app.js"].includes(asset)) return json(res, 404, { error: "Not found" });
    const body = await readFile(path.join(root, asset));
    res.writeHead(200, { "Content-Type": types[path.extname(asset)] + "; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    return res.end(req.method === "HEAD" ? undefined : body);
  } catch { return json(res, 500, { error: "Internal error" }); }
});
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error("Invalid PORT");
server.listen(port, () => console.log("Dayline at http://localhost:" + port));
