/** Source-only development composition. The deployable artifact uses src/public/main.ts. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFictionalDisplaySource, sanitizeEditionDisplay } from './src/editions/presentation.ts';
import type { EditionDisplaySource } from './src/editions/presentation-types.ts';
import type { FetchLike } from './src/official-data.ts';
import { createPublicServer } from './src/public/reader.ts';
import { parsePublicConfiguration, PublicConfigurationError, type PublicConfiguration } from './src/public/config.ts';
import { attachPublicLifecycle } from './src/public/lifecycle.ts';
import { createFictionalSourceQueueDisplaySource, sanitizeSourceQueueDisplay } from './src/source-queue/presentation.ts';
import type { SourceQueueDisplaySource } from './src/source-queue/presentation-types.ts';
import { sourceQueueViews, type SourceQueueQuery, type SourceQueueView } from './src/source-queue/types.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
export const developmentEditionEnabled = () => process.env.NODE_ENV === 'development' && process.env.DAYLINE_DEV_EDITION === 'fictional';
export const developmentSourceQueueEnabled = () => process.env.NODE_ENV === 'development' && process.env.DAYLINE_DEV_SOURCE_QUEUE === 'fictional';
function localSourceQueueRequest(req: http.IncomingMessage): boolean {
  if (!developmentSourceQueueEnabled() || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') || req.rawHeaders.length > 96) return false;
  const counts = new Map<string, number>();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index].toLowerCase(); counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (['host','origin','sec-fetch-site','authorization','cookie'].some(name => (counts.get(name) ?? 0) > 1)
    || Object.keys(req.headers).some(name => ['authorization','cookie','forwarded','transfer-encoding','expect','upgrade'].includes(name) || name.startsWith('x-forwarded-') || name.startsWith('access-control-request-'))) return false;
  const host = req.headers.host;
  if (typeof host !== 'string' || !['localhost','127.0.0.1','[::1]'].some(name => host === `${name}:${req.socket.localPort}`)) return false;
  return (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
    && (req.headers['sec-fetch-site'] === undefined || ['same-origin','none'].includes(String(req.headers['sec-fetch-site'])));
}
function sourceQueueQuery(url: URL): SourceQueueQuery | null {
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => !['view','limit','cursor'].includes(key)) || new Set(keys).size !== keys.length) return null;
  const view = url.searchParams.get('view') ?? 'RECENT';
  const limit = url.searchParams.get('limit') ?? '6';
  const cursor = url.searchParams.get('cursor');
  if (!sourceQueueViews.includes(view as SourceQueueView) || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50
    || (cursor !== null && (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)))) return null;
  return { view: view as SourceQueueView, limit: Number(limit), ...(cursor === null ? {} : { cursor }) };
}
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
export function createServer(options: { fetcher?: FetchLike; now?: () => number; editionSource?: EditionDisplaySource; sourceQueueSource?: SourceQueueDisplaySource; config?: PublicConfiguration } = {}) {
  // Preserve the existing trusted test-composition API; actual CLI/deployment startup validates its environment first.
  const defaults = parsePublicConfiguration({NODE_ENV: 'development'});
  const configuredMode = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? process.env.NODE_ENV : 'development';
  const config = options.config ?? Object.freeze({...defaults, mode: configuredMode});
  const editionSource = options.editionSource ?? createFictionalDisplaySource();
  // Trusted composition seam for deterministic tests; the CLI can only create an isolated fictional source.
  const sourceQueueSource = options.sourceQueueSource ?? createFictionalSourceQueueDisplaySource();
  const server = createPublicServer({config, fetcher: options.fetcher, now: options.now, nwsUserAgent: () => process.env.NWS_USER_AGENT,
    developmentHandler: async (req, res, url) => {
      if (url.pathname === '/dev/source-queue' || url.pathname.startsWith('/dev/source-queue/')) {
        const send = (status: number, body: unknown) => { res.writeHead(status, {...editionHeaders, 'Content-Type':'application/json; charset=utf-8'}); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body)); };
        if (!localSourceQueueRequest(req)) { send(404, {error:'Not found'}); return true; }
        if (url.pathname === '/dev/source-queue/preview') {
          const query = sourceQueueQuery(url);
          if (!query) { send(400, {error:'Invalid fictional queue query'}); return true; }
          try {
            const view = sanitizeSourceQueueDisplay(await sourceQueueSource.read(query));
            if (!view || view.view !== query.view || view.limit !== query.limit) { send(503, {error:'Fictional source queue currently unavailable'}); return true; }
            send(200, view);
          } catch { send(503, {error:'Fictional source queue currently unavailable'}); }
          return true;
        }
        const assets: Record<string,string> = {'/dev/source-queue':'source-queue.html', '/dev/source-queue/source-queue.css':'source-queue.css', '/dev/source-queue/source-queue.js':'source-queue.js'};
        const asset = assets[url.pathname];
        if (!asset || url.search) { send(404, {error:'Not found'}); return true; }
        try {
          const body = await readFile(path.join(root, asset));
          const type = asset.endsWith('.html') ? 'text/html' : asset.endsWith('.css') ? 'text/css' : 'text/javascript';
          res.writeHead(200, {...editionHeaders, 'Content-Type':type + '; charset=utf-8'});
          res.end(req.method === 'HEAD' ? undefined : body);
        } catch { send(503, {error:'Fictional source queue currently unavailable'}); }
        return true;
      }
      if (url.pathname !== '/dev/edition' && !url.pathname.startsWith('/dev/edition/')) return false;
      const send = (status: number, body: unknown) => { res.writeHead(status, {...editionHeaders, 'Content-Type':'application/json; charset=utf-8'}); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body)); };
      if (!localEditionRequest(req) || url.search) { send(404, {error:'Not found'}); return true; }
      if (url.pathname === '/dev/edition/preview') {
        try {
          const view = sanitizeEditionDisplay(await editionSource.read());
          if (!view || view.fictional !== true || view.developmentOnly !== true || view.publiclyPublished !== false
            || view.status === 'INVALIDATED' || !Number.isFinite(view.validForMs) || view.validForMs <= 0 || view.validForMs > 15000) { send(503, {error:'Fictional edition currently unavailable'}); return true; }
          send(200, view);
        } catch { send(503, {error:'Fictional edition currently unavailable'}); }
        return true;
      }
      const assets: Record<string,string> = {'/dev/edition':'edition.html', '/dev/edition/edition.css':'edition.css', '/dev/edition/edition.js':'edition.js'};
      const asset = assets[url.pathname];
      if (!asset) { send(404, {error:'Not found'}); return true; }
      const body = await readFile(path.join(root, asset));
      const type = asset.endsWith('.html') ? 'text/html' : asset.endsWith('.css') ? 'text/css' : 'text/javascript';
      res.writeHead(200, {...editionHeaders, 'Content-Type':type + '; charset=utf-8'});
      res.end(req.method === 'HEAD' ? undefined : body); return true;
    },
  });
  server.once('close', () => { void editionSource.dispose().catch(() => {}); });
  server.once('close', () => { void sourceQueueSource.dispose().catch(() => {}); });
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = parsePublicConfiguration();
    const server = createServer({config});
    const lifecycle = attachPublicLifecycle(server, {shutdownTimeoutMs: config.shutdownTimeoutMs,
      log: event => console.log(JSON.stringify(event)), onStopped: code => process.exit(code)});
    lifecycle.installSignals();
    server.once('error', () => { console.error(JSON.stringify({event:'public_startup_failed', code:'STARTUP_FAILED'})); process.exit(1); });
    server.listen(config.port, config.host, () => console.log(JSON.stringify({event:'public_started', mode:config.mode, host:config.host, port:config.port})));
  } catch (error) {
    console.error(JSON.stringify({event:'public_startup_failed', code:error instanceof PublicConfigurationError ? error.code : 'STARTUP_FAILED'}));
    process.exitCode = 1;
  }
}
