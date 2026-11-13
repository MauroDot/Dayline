/** Read-only runtime graph. No editorial services, identity code or development fixture imports. */
import http from 'node:http';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createCache } from '../cache.ts';
import { availableCities, getDebt, getWeather, validNwsUserAgent, type FetchLike } from '../official-data.ts';
import type { PublicConfiguration } from './config.ts';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const assets = { 'index.html': 'text/html', 'style.css': 'text/css', 'app.js': 'text/javascript', 'stories.js': 'text/javascript' } as const;
const debtTTL = 60 * 60 * 1000, weatherTTL = 30 * 60 * 1000;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin' };
export interface SafePublicEvent { event: 'upstream_failure' | 'request_failure' | 'capacity_rejected'; requestId: string; source?: 'treasury' | 'nws'; code: 'UNAVAILABLE' | 'TIMEOUT' | 'INTERNAL' | 'CAPACITY' }
export interface PublicServerOptions {
  config: PublicConfiguration;
  fetcher?: FetchLike;
  now?: () => number;
  staticRoot?: string;
  log?: (event: SafePublicEvent) => void;
  /** Trusted development composition only; never included by the packaged public entry point. */
  developmentHandler?: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean>;
  /** Legacy development composition may observe its mutable environment; deployment uses the fixed config. */
  nwsUserAgent?: () => string | undefined;
}
type Observation = { state: 'fresh' | 'stale' | 'unavailable'; expiresAt: number };

export function createPublicServer(options: PublicServerOptions): http.Server {
  const config = options.config, root = options.staticRoot ?? defaultRoot;
  const debtCache = createCache( debtTTL );
  const weatherCaches = new Map(availableCities.map(city => [city, createCache(weatherTTL)]));
  let debt: Observation | undefined;
  const weather = new Map<string, Observation>();
  let concurrent = 0;
  const now = options.now ?? Date.now;
  const log = (event: SafePublicEvent) => { try { options.log?.(event); } catch { /* Logging cannot change an HTTP outcome. */ } };
  const available = async (asset: string) => { const name = path.join(root, asset); const stat = await lstat(name); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('STATIC_UNAVAILABLE'); return readFile(name); };
  const stateOf = (value: Observation | undefined): string => !value ? 'unknown' : value.state === 'fresh' && now() >= value.expiresAt ? 'expired' : value.state;
  const server = http.createServer({ maxHeaderSize: 16_384, requestTimeout: config.requestTimeoutMs,
    headersTimeout: config.headersTimeoutMs, connectionsCheckingInterval: 1000 }, (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-ID', requestId);
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    const json = (status: number, value: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value));
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); res.setHeader('Connection', 'close'); json(405, {error: 'Method not allowed'}); return; }
    if (typeof req.url !== 'string' || req.url.length > 2048 || !req.url.startsWith('/') || req.url.startsWith('//') || /[%\\]/.test(req.url.split('?')[0])) { json(404, {error: 'Not found'}); return; }
    let url: URL;
    try { url = new URL(req.url, 'http://reader.invalid'); } catch { json(404, {error: 'Not found'}); return; }
    // Liveness stays cheap and independent of slow upstream work; readiness still uses admission limits.
    if (url.pathname === '/api/health') { json(200, {ok: true, service: 'dayline', mode: 'foundation'}); return; }
    if (concurrent >= config.maxConcurrentRequests) {
      res.setHeader('Retry-After', '1'); res.setHeader('Connection', 'close');
      log({event: 'capacity_rejected', requestId, code: 'CAPACITY'});
      json(503, {error: 'Service temporarily busy'}); return;
    }
    concurrent++;
    let deadline = false;
    let source: 'treasury' | 'nws' | undefined;
    let city: string | undefined;
    const timer = setTimeout(() => {
      deadline = true;
      if (source === 'treasury') debt = {state: 'unavailable', expiresAt: 0};
      if (source === 'nws' && city) weather.set(city, {state: 'unavailable', expiresAt: 0});
      log({event: 'request_failure', requestId, source, code: 'TIMEOUT'});
      json(503, {error: source === 'treasury' ? 'Official debt data currently unavailable' : source === 'nws' ? 'Official weather data currently unavailable' : 'Service temporarily unavailable'});
    }, config.requestTimeoutMs);
    void (async () => {
      try {
        if (config.mode === 'development' && options.developmentHandler && await options.developmentHandler(req, res, url)) return;
        if (url.pathname === '/api/ready') {
          let files = true;
          try { await Promise.all(Object.keys(assets).map(asset => available(asset))); } catch { files = false; }
          const debtState = stateOf(debt), sampled = [...weather.values()].map(stateOf);
          const weatherState = sampled.length === 0 ? 'unknown' : sampled.every(value => value === 'fresh') ? 'fresh' : 'unavailable';
          const ready = files && debtState === 'fresh' && weatherState === 'fresh';
          json(ready ? 200 : 503, {ready, service: 'dayline', semantics: 'observed-official-data', checks: {assets: files, treasury: debtState, nws: weatherState}}); return;
        }
        if (url.pathname === '/api/debt') {
          source = 'treasury';
          try {
            const result = await debtCache(async () => {
              const value = await getDebt(options.fetcher, {timeoutMs: config.upstreamTimeoutMs});
              if (!value.ok) throw Error('UNAVAILABLE');
              return {...value.value, fetchedAt: value.fetchedAt};
            }, now());
            if (deadline) return;
            debt = {state: result.stale ? 'stale' : 'fresh', expiresAt: Date.parse(result.cachedAt) + debtTTL};
            if (result.stale) log({event: 'upstream_failure', requestId, source, code: 'UNAVAILABLE'});
            json(200, {source: 'U.S. Treasury Fiscal Data', ...result});
          } catch {
            debt = {state: 'unavailable', expiresAt: 0};
            log({event: 'upstream_failure', requestId, source, code: 'UNAVAILABLE'});
            json(503, {error: 'Official debt data currently unavailable'});
          }
          return;
        }
        if (url.pathname === '/api/weather') {
          const requested = url.searchParams.get('city') || 'Tulsa';
          const cached = weatherCaches.get(requested);
          if (!cached) { json(400, {error: 'Unsupported location', cities: availableCities}); return; }
          city = requested; source = 'nws';
          const ua = options.nwsUserAgent ? options.nwsUserAgent() : config.nwsUserAgent;
          if (!validNwsUserAgent(ua)) {
            weather.set(city, {state: 'unavailable', expiresAt: 0});
            json(503, {error: 'NWS_USER_AGENT must identify the application and include a real contact email'}); return;
          }
          try {
            const result = await cached(async () => {
              const value = await getWeather(requested, options.fetcher, {timeoutMs: config.upstreamTimeoutMs, userAgent: ua});
              if (!value.ok) throw Error('UNAVAILABLE');
              return {...value.value, fetchedAt: value.fetchedAt};
            }, now());
            if (deadline) return;
            weather.set(city, {state: result.stale ? 'stale' : 'fresh', expiresAt: Date.parse(result.cachedAt) + weatherTTL});
            if (result.stale) log({event: 'upstream_failure', requestId, source, code: 'UNAVAILABLE'});
            json(200, {source: 'National Weather Service', ...result});
          } catch {
            weather.set(city, {state: 'unavailable', expiresAt: 0});
            log({event: 'upstream_failure', requestId, source, code: 'UNAVAILABLE'});
            json(503, {error: 'Official weather data currently unavailable'});
          }
          return;
        }
        if (url.pathname.startsWith('/api/')) { json(404, {error: 'Unknown endpoint'}); return; }
        const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!Object.hasOwn(assets, asset)) { json(404, {error: 'Not found'}); return; }
        const body = await available(asset);
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, {'Content-Type': assets[asset as keyof typeof assets] + '; charset=utf-8', 'Cache-Control': 'no-cache, max-age=0'});
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch {
        log({event: 'request_failure', requestId, code: 'INTERNAL'});
        json(500, {error: 'Internal error'});
      } finally { clearTimeout(timer); concurrent--; }
    })();
  });
  server.maxHeadersCount = 64;
  server.maxConnections = config.maxConnections;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  server.on('checkContinue', (_req, res) => { res.writeHead(405, {...headers, Allow: 'GET, HEAD'}); res.end(); });
  server.on('checkExpectation', (_req, res) => { res.writeHead(405, {...headers, Allow: 'GET, HEAD'}); res.end(); });
  server.on('upgrade', (_req, socket) => socket.destroy());
  return server;
}
