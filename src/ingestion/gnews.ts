import type { Provider, ProviderConfig, DiscoveryRequest } from './types.ts';
export class ProviderError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
/** Explicit opt-in and injected transport; no scheduler or live runner is supplied. */
export class GNewsProvider implements Provider {
  readonly config: ProviderConfig = { name: 'GNews', maxArticles: 10, maxPage: 5, timeoutMs: 8000, maxAttempts: 3 };
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
      let response: Response;
      try { response = await this.transport(url, { signal: AbortSignal.timeout(this.config.timeoutMs), redirect: 'error' }); }
      catch { if (i + 1 === this.config.maxAttempts) throw new ProviderError('NETWORK_OR_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 100 * (i + 1))); continue; }
      if (response.status === 401) throw new ProviderError('UNAUTHORIZED');
      if (response.status === 403) throw new ProviderError('FORBIDDEN');
      if (response.status === 429) throw new ProviderError('RATE_LIMITED');
      if (response.status >= 500 && i + 1 < this.config.maxAttempts) { await new Promise(resolve => setTimeout(resolve, 100 * (i + 1))); continue; }
      if (!response.ok) throw new ProviderError(response.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'HTTP_ERROR');
      let body: unknown;
      try { body = await response.json(); } catch { throw new ProviderError('MALFORMED_RESPONSE'); }
      if (!body || typeof body !== 'object' || !Array.isArray((body as {articles?: unknown}).articles)) throw new ProviderError('MALFORMED_RESPONSE');
      const articles = (body as {articles: unknown[]}).articles;
      if (articles.length > request.limit) throw new ProviderError('RESPONSE_LIMIT_EXCEEDED');
      return articles;
    }
    throw new ProviderError('UPSTREAM_UNAVAILABLE');
  }
}
/** Discard provider content, descriptions, titles and image URLs; provenance is unresolved. */
export function normalizeGNews(value: unknown, retrievedAt: string): import('./types.ts').ProviderArticle {
  if (!value || typeof value !== 'object') throw Error('Invalid article');
  const item = value as {url?: unknown; publishedAt?: unknown; source?: {name?: unknown}};
  if (typeof item.url !== 'string' || typeof item.publishedAt !== 'string' || typeof item.source?.name !== 'string' || !item.source.name.trim()) throw Error('Incomplete article metadata');
  return { url: item.url, publisher: item.source.name, publishedAt: item.publishedAt, retrievedAt, provenance: { type: 'UNKNOWN', originId: null } };
}
