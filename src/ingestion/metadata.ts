import { createHash } from 'node:crypto';
import { canonicalURL } from '../newsroom/model.ts';
import type { ProviderArticle } from './types.ts';
import type { ManagedSource } from './records.ts';
import type { RegistryPolicy } from './policies.ts';
export function sourceId(url: string): string { return 'url-' + createHash('sha256').update(canonicalURL(url)).digest('hex'); }
export function timestamp(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw Error('Invalid timestamp');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) throw Error('Invalid timestamp');
  return time;
}
/** Allowlist fields: text, titles, images and arbitrary provider fields never enter storage. */
export function metadata(article: ProviderArticle, providerId: string): ProviderArticle {
  if (!article || typeof article !== 'object' || article.providerId !== providerId || typeof article.url !== 'string' || typeof article.publisher !== 'string' || !article.publisher.trim()) throw Error('Invalid provider metadata');
  const url = new URL(article.url); canonicalURL(article.url);
  if (!url.hostname.endsWith('.test') || !['http:', 'https:'].includes(url.protocol)) throw Error('Only fictional test URLs are permitted');
  if ([...url.searchParams.keys()].some(k => /^(api_?key|token|access_token|key|secret|password)$/i.test(k))) throw Error('Sensitive URL parameter');
  timestamp(article.publishedAt); timestamp(article.retrievedAt);
  const p = article.provenance;
  if (!p || !['PRIMARY','ORIGINAL','SECONDARY','SYNDICATED','UNKNOWN','DISPUTED'].includes(p.type)) throw Error('Invalid provenance');
  if (p.type === 'SYNDICATED' ? typeof p.originId !== 'string' || !p.originId.trim() : p.originId !== null) throw Error('Invalid provenance');
  return { providerId, url: article.url, publisher: article.publisher, publishedAt: article.publishedAt, retrievedAt: article.retrievedAt, provenance: { type: p.type, originId: p.originId } as ProviderArticle['provenance'] };
}
export function managed(article: ProviderArticle, policy: RegistryPolicy, at: string): ManagedSource {
  const { url, publisher, publishedAt, retrievedAt } = article;
  if (timestamp(retrievedAt) > timestamp(at)) throw Error('Future retrieval timestamp');
  return {
    sourceId: sourceId(url), providerId: article.providerId, policy: structuredClone(policy), retainedAt: at,
    deleteAt: new Date(Math.min(Math.min(timestamp(at), timestamp(retrievedAt)) + policy.retentionDays * 86400000, timestamp(policy.expiresAt))).toISOString(),
    providerMetadata: { url, publisher, publishedAt, retrievedAt }, providerProvenance: structuredClone(article.provenance),
  };
}
/** The most restrictive captured deadline governs every read, promotion and cleanup. */
export function retentionDeadline(record: ManagedSource): number {
  const retained = timestamp(record.retainedAt), retrieved = timestamp(record.providerMetadata.retrievedAt);
  if (retrieved > retained) throw Error('Future retrieval timestamp');
  return Math.min(timestamp(record.deleteAt), retained + record.policy.retentionDays * 86400000,
    retrieved + record.policy.retentionDays * 86400000, timestamp(record.policy.expiresAt));
}
