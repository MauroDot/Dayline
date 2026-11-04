import { createHash } from 'node:crypto';
import { canonicalURL, validateSource, type Source } from '../newsroom/model.ts';
import { Newsroom } from '../newsroom/service.ts';
import { validatePolicy, type ProviderArticle, type RightsPolicy } from './types.ts';
export type Counts = { processed: number; duplicate: number; rejected: number; failed: number };
export function sourceId(url: string): string { return 'url-' + createHash('sha256').update(canonicalURL(url)).digest('hex'); }
function toSource(article: ProviderArticle, policy: RightsPolicy): Omit<Source, 'canonicalUrl'> {
  if (!article || typeof article !== 'object' || typeof article.url !== 'string' || typeof article.publisher !== 'string' || !article.publisher.trim() || typeof article.publishedAt !== 'string' || typeof article.retrievedAt !== 'string' || !article.provenance || typeof article.provenance !== 'object') throw Error('Malformed metadata');
  const url = new URL(article.url);
  if ([...url.searchParams.keys()].some(k => /^(api_?key|token|access_token|key|secret|password)$/i.test(k))) throw Error('Sensitive URL parameter');
  const canonical = canonicalURL(article.url); const id = sourceId(canonical);
  const provenance = article.provenance;
  if (!['PRIMARY', 'ORIGINAL', 'SECONDARY', 'SYNDICATED'].includes(provenance.type)) throw Error('Unresolved provenance');
  if (provenance.type !== 'SYNDICATED' && provenance.originId !== null) throw Error('Invalid provenance');
  if (provenance.type === 'SYNDICATED' && (typeof provenance.originId !== 'string' || !provenance.originId.trim())) throw Error('Unknown origin');
  const source: Source = { id, publisher: article.publisher, url: canonical, canonicalUrl: canonical, type: provenance.type as Source['type'], publishedAt: article.publishedAt, retrievedAt: article.retrievedAt, originId: provenance.type === 'SYNDICATED' ? provenance.originId as string : id, rights: JSON.stringify(policy), verification: 'UNVERIFIED' };
  validateSource(source); const { canonicalUrl: _, ...result } = source; return result;
}
/** Each outcome is auditable on writes; dry runs never modify repository state. */
export async function ingestArticles(newsroom: Newsroom, articles: ProviderArticle[], policy: RightsPolicy, options: { dryRun?: boolean; maxArticles?: number; onOutcome?: (index: number, outcome: keyof Counts) => void } = {}): Promise<Counts> {
  validatePolicy(policy);
  const max = options.maxArticles ?? 10;
  if (!Number.isInteger(max) || max < 1 || max > 100 || articles.length > max) throw Error('Article count exceeds limit');
  const dryRun = options.dryRun !== false; const state = await newsroom.snapshot();
  const seen = new Set(state.sources.map(s => s.canonicalUrl)); const originalIds = new Set(state.sources.filter(s => s.type !== 'SYNDICATED').map(s => s.id));
  const result: Counts = { processed: 0, duplicate: 0, rejected: 0, failed: 0 };
  for (const [index, article] of articles.entries()) {
    let outcome: keyof Counts;
    try {
      const item = toSource(article, policy); const canonical = canonicalURL(item.url);
      if (seen.has(canonical)) outcome = 'duplicate';
      else if (item.type === 'SYNDICATED' && !originalIds.has(item.originId)) outcome = 'rejected';
      else {
        if (!dryRun) await newsroom.ingest(item, 'development-ingestion');
        seen.add(canonical); if (item.type !== 'SYNDICATED') originalIds.add(item.id);
        outcome = 'processed';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'Duplicate source') outcome = 'duplicate';
      else if (/^(Malformed metadata|Sensitive URL parameter|Unresolved provenance|Invalid provenance|Unknown origin|Invalid source|Missing source|Invalid URL|Invalid canonical|Original source|Syndication)/.test(message)) outcome = 'rejected';
      else outcome = 'failed';
    }
    if (!dryRun) await newsroom.recordIngestionOutcome(outcome.toUpperCase() as 'PROCESSED' | 'DUPLICATE' | 'REJECTED' | 'FAILED', 'development-ingestion');
    result[outcome]++;
    options.onOutcome?.(index, outcome);
  }
  return result;
}
