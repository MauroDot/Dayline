import type { Provider, ProviderConfig, DiscoveryRequest } from './types.ts';
export class ProviderError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ATTEMPT_ERRORS = ['NETWORK_OR_TIMEOUT', 'UNAUTHORIZED', 'FORBIDDEN', 'RATE_LIMITED', 'UPSTREAM_UNAVAILABLE', 'HTTP_ERROR', 'MALFORMED_RESPONSE', 'RESPONSE_LIMIT_EXCEEDED'];

/** Bound the entire attempt, including transports or body readers that ignore abort. */
async function requestArticles(transport: typeof fetch, url: URL, limit: number, timeoutMs: number): Promise<unknown[]> {
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled: ReadableStreamDefaultReader<Uint8Array> | ReadableStream<Uint8Array> | undefined;
  const cancelBody = () => {
    try {
      const target = reader ?? response?.body;
      if (!target || target === cancelled) return;
      cancelled = target;
      // Cleanup must not extend the attempt when a transport ignores cancellation.
      void Promise.resolve(target.cancel()).catch(() => {});
    } catch { /* Cleanup failures must not disclose provider data. */ }
  };
  const checkDeadline = () => {
    if (controller.signal.aborted || performance.now() >= deadline) throw new ProviderError('NETWORK_OR_TIMEOUT');
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      cancelBody();
      reject(new ProviderError('NETWORK_OR_TIMEOUT'));
    }, timeoutMs);
  });
  const operation = (async () => {
    let complete = false;
    try {
      try { response = await transport(url, { signal: controller.signal, redirect: 'error' }); }
      catch { throw new ProviderError('NETWORK_OR_TIMEOUT'); }
      checkDeadline();
      let status: number;
      let ok: boolean;
      try { status = response.status; ok = response.ok; }
      catch { throw new ProviderError('MALFORMED_RESPONSE'); }
      if (status === 401) throw new ProviderError('UNAUTHORIZED');
      if (status === 403) throw new ProviderError('FORBIDDEN');
      if (status === 429) throw new ProviderError('RATE_LIMITED');
      if (!ok) throw new ProviderError(status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'HTTP_ERROR');
      let contentLength: string | null;
      try { contentLength = response.headers.get('content-length'); }
      catch { throw new ProviderError('MALFORMED_RESPONSE'); }
      if (contentLength !== null && /^\d+$/.test(contentLength.trim()) && Number(contentLength) > MAX_RESPONSE_BYTES) throw new ProviderError('RESPONSE_LIMIT_EXCEEDED');
      try { reader = response.body?.getReader(); }
      catch { throw new ProviderError('MALFORMED_RESPONSE'); }
      if (!reader) throw new ProviderError('MALFORMED_RESPONSE');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      let text = '';
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch { checkDeadline(); throw new ProviderError('MALFORMED_RESPONSE'); }
        checkDeadline();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) throw new ProviderError('MALFORMED_RESPONSE');
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new ProviderError('RESPONSE_LIMIT_EXCEEDED');
        try { text += decoder.decode(chunk.value, { stream: true }); }
        catch { throw new ProviderError('MALFORMED_RESPONSE'); }
      }
      let body: unknown;
      try { text += decoder.decode(); body = JSON.parse(text); }
      catch { throw new ProviderError('MALFORMED_RESPONSE'); }
      checkDeadline();
      if (!body || typeof body !== 'object' || !Array.isArray((body as {articles?: unknown}).articles)) throw new ProviderError('MALFORMED_RESPONSE');
      const articles = (body as {articles: unknown[]}).articles;
      if (articles.length > limit) throw new ProviderError('RESPONSE_LIMIT_EXCEEDED');
      complete = true;
      return articles;
    } finally {
      if (!complete) cancelBody();
      try { reader?.releaseLock(); } catch { /* A noncooperative reader may still have a pending read. */ }
    }
  })();
  let complete = false;
  try {
    const articles = await Promise.race([operation, timeout]);
    complete = true;
    return articles;
  } finally {
    clearTimeout(timer);
    if (!complete) { controller.abort(); cancelBody(); }
  }
}
/** Explicit opt-in and injected transport; no scheduler or live runner is supplied. */
export class GNewsProvider implements Provider {
  readonly config: ProviderConfig = Object.freeze({ name: 'GNews', maxArticles: 10, maxPage: 5, timeoutMs: 8000, maxAttempts: 3 });
  private readonly apiKey: string;
  private readonly enabled: boolean;
  private readonly transport: typeof fetch;
  constructor(options: { apiKey?: string; enabled?: boolean; transport?: typeof fetch } = {}) {
    this.apiKey = options.apiKey ?? ''; this.enabled = options.enabled === true; this.transport = options.transport ?? fetch;
  }
  async discover(request: DiscoveryRequest): Promise<unknown[]> {
    if (!this.enabled) throw new ProviderError('PROVIDER_DISABLED');
    if (!this.apiKey.trim()) throw new ProviderError('MISSING_CREDENTIAL');
    if (typeof request.query !== 'string' || !request.query.trim() || request.query.length > 200 || !Number.isInteger(request.page) || request.page < 1 || request.page > this.config.maxPage || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > this.config.maxArticles) throw new ProviderError('INVALID_REQUEST');
    const url = new URL('https://gnews.io/api/v4/search');
    url.searchParams.set('q', request.query); url.searchParams.set('page', String(request.page)); url.searchParams.set('max', String(request.limit)); url.searchParams.set('apikey', this.apiKey);
    for (let i = 0; i < this.config.maxAttempts; i++) {
      try { return await requestArticles(this.transport, url, request.limit, this.config.timeoutMs); }
      catch (error) {
        let code = 'MALFORMED_RESPONSE';
        try { if (error instanceof ProviderError && ATTEMPT_ERRORS.includes(error.code)) code = error.code; } catch { /* Untrusted exceptions remain fixed errors. */ }
        if (!['NETWORK_OR_TIMEOUT', 'UPSTREAM_UNAVAILABLE'].includes(code) || i + 1 === this.config.maxAttempts) throw new ProviderError(code);
        await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
      }
    }
    throw new ProviderError('UPSTREAM_UNAVAILABLE');
  }
}
/** Discard provider content, descriptions, titles and image URLs; provenance is unresolved. */
export function normalizeGNews(value: unknown, retrievedAt: string): import('./types.ts').ProviderArticle {
  if (!value || typeof value !== 'object') throw Error('Invalid article');
  const item = value as {url?: unknown; publishedAt?: unknown; source?: {name?: unknown}};
  if (typeof item.url !== 'string' || typeof item.publishedAt !== 'string' || typeof item.source?.name !== 'string' || !item.source.name.trim()) throw Error('Incomplete article metadata');
  return { providerId: 'gnews', url: item.url, publisher: item.source.name, publishedAt: item.publishedAt, retrievedAt, provenance: { type: 'UNKNOWN', originId: null } };
}
