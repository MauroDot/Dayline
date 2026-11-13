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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
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
export function createServer(options: { fetcher?: FetchLike; now?: () => number; editionSource?: EditionDisplaySource; config?: PublicConfiguration } = {}) {
  // Preserve the existing trusted test-composition API; actual CLI/deployment startup validates its environment first.
  const defaults = parsePublicConfiguration({NODE_ENV: 'development'});
  const configuredMode = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? process.env.NODE_ENV : 'development';
  const config = options.config ?? Object.freeze({...defaults, mode: configuredMode});
  const editionSource = options.editionSource ?? createFictionalDisplaySource();
  const server = createPublicServer({config, fetcher: options.fetcher, now: options.now, nwsUserAgent: () => process.env.NWS_USER_AGENT,
    developmentHandler: async (req, res, url) => {
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
