import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCache } from "./src/cache.ts";
import { createFictionalDisplaySource, sanitizeEditionDisplay } from "./src/editions/presentation.ts";
import type { EditionDisplaySource } from "./src/editions/presentation-types.ts";
import { availableCities, getDebt, getWeather, validNwsUserAgent, type FetchLike } from "./src/official-data.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public");
const port = Number(process.env.PORT || 3000);

const json = (res: http.ServerResponse, status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(data)); };
const types: Record<string,string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
export const developmentEditionEnabled = () => process.env.NODE_ENV === 'development' && process.env.DAYLINE_DEV_EDITION === 'fictional';
function localEditionRequest(req: http.IncomingMessage): boolean {
  if (!developmentEditionEnabled() || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return false;
  try {
    const host = new URL('http://' + (req.headers.host ?? ''));
    return ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) && !host.username && !host.password
      && host.pathname === '/' && !host.search && !host.hash && req.headers['sec-fetch-site'] !== 'cross-site';
  } catch { return false; }
}
const editionHeaders = { 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", 'Cross-Origin-Resource-Policy':'same-origin' };
export function createServer(options: { fetcher?: FetchLike; now?: () => number; editionSource?: EditionDisplaySource } = {}) {
const debtCache = createCache(60 * 60 * 1000);
const weatherCaches = new Map(availableCities.map(city => [city, createCache(30 * 60 * 1000)]));
const editionSource = options.editionSource ?? createFictionalDisplaySource();
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === '/dev/edition' || url.pathname.startsWith('/dev/edition/')) {
      const send = (status: number, body: unknown) => { res.writeHead(status, {...editionHeaders, 'Content-Type':'application/json; charset=utf-8'}); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body)); };
      if (!localEditionRequest(req) || url.search) return send(404, {error:'Not found'});
      if (url.pathname === '/dev/edition/preview') {
        try {
          const view = sanitizeEditionDisplay(await editionSource.read());
          if (!view || view.fictional !== true || view.developmentOnly !== true || view.publiclyPublished !== false
            || view.status === 'INVALIDATED' || !Number.isFinite(view.validForMs) || view.validForMs <= 0 || view.validForMs > 15000) return send(503, {error:'Fictional edition currently unavailable'});
          return send(200, view);
        } catch { return send(503, {error:'Fictional edition currently unavailable'}); }
      }
      const assets: Record<string,string> = {'/dev/edition':'edition.html', '/dev/edition/edition.css':'edition.css', '/dev/edition/edition.js':'edition.js'};
      const asset = assets[url.pathname];
      if (!asset) return send(404, {error:'Not found'});
      const body = await readFile(path.join(root, asset));
      res.writeHead(200, {...editionHeaders, 'Content-Type':types[path.extname(asset)] + '; charset=utf-8'});
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (url.pathname === "/api/health") return json(res, 200, { ok: true, service: "dayline", mode: "foundation" });
    if (url.pathname === "/api/debt") {
      try {
        const result = await debtCache(async () => {
          const data = await getDebt(options.fetcher);
          if (!data.ok) throw Error(data.error);
          return { ...data.value, fetchedAt: data.fetchedAt };
        }, options.now?.());
        return json(res, 200, { source: "U.S. Treasury Fiscal Data", ...result });
      } catch { return json(res, 503, { error: "Official debt data currently unavailable" }); }
    }
    if (url.pathname === "/api/weather") {
      const city = url.searchParams.get("city") || "Tulsa";
      const cached = weatherCaches.get(city);
      if (!cached) return json(res, 400, { error: "Unsupported location", cities: availableCities });
      if (!validNwsUserAgent(process.env.NWS_USER_AGENT)) return json(res, 503, { error: "NWS_USER_AGENT must identify the application and include a real contact email" });
      try {
        const result = await cached(async () => {
          const data = await getWeather(city, options.fetcher);
          if (!data.ok) throw Error(data.error);
          return { ...data.value, fetchedAt: data.fetchedAt };
        }, options.now?.());
        return json(res, 200, { source: "National Weather Service", ...result });
      } catch { return json(res, 503, { error: "Official weather data currently unavailable" }); }
    }
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "Unknown endpoint" });
    const asset = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!["index.html", "style.css", "app.js", "stories.js"].includes(asset)) return json(res, 404, { error: "Not found" });
    const body = await readFile(path.join(root, asset));
    res.writeHead(200, { "Content-Type": types[path.extname(asset)] + "; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    return res.end(req.method === "HEAD" ? undefined : body);
  } catch { return json(res, 500, { error: "Internal error" }); }
});
server.once('close', () => { void editionSource.dispose().catch(() => {}); });
return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error("Invalid PORT");
const server = createServer();
if (developmentEditionEnabled()) server.listen(port, '127.0.0.1', () => console.log("Dayline at http://localhost:" + port + " (fictional edition enabled)"));
else server.listen(port, () => console.log("Dayline at http://localhost:" + port));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
}
