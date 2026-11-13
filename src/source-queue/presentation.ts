import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSourceQueueFixture, sourceQueueFixtureAt } from '../../fixtures/source-queue-fiction.ts';
import { JsonRepository } from '../newsroom/store.ts';
import { SourceQueue } from './service.ts';
import { sourceQueueBlockedReasons, sourceQueueViews, type SourceQueueEntry, type SourceQueueQuery } from './types.ts';
import type { SourceQueueDisplay, SourceQueueDisplaySource } from './presentation-types.ts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => typeof key === 'string')
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value'));
}
function array(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  const length = descriptors.length?.value;
  return Number.isSafeInteger(length) && length >= 0 && Reflect.ownKeys(descriptors).length === length + 1
    && Reflect.ownKeys(descriptors).every(key => typeof key === 'string' && Object.hasOwn(descriptors[key], 'value')
      && (key === 'length' || (/^(0|[1-9]\d*)$/.test(key) && Number(key) < length && descriptors[key].enumerable === true)));
}
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const reference = (value: unknown): value is string => typeof value === 'string' && /^candidate-[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const cursor = (value: unknown): value is string | null => value === null || (text(value, 1024) && /^[A-Za-z0-9_-]+$/.test(value));
function safeURL(value: unknown): value is string | null {
  if (value === null) return true;
  if (!text(value, 2048)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname.endsWith('.test') && !url.username && !url.password && !url.search && !url.hash && url.href === value; }
  catch { return false; }
}
function member<T extends string>(value: unknown, choices: readonly T[]): value is T { return typeof value === 'string' && choices.includes(value as T); }

/** Inspect data descriptors first, then create a fresh allowlisted metadata projection. */
export function sanitizeSourceQueueDisplay(value: unknown): SourceQueueDisplay | null {
  try {
    if (!record(value) || value.fictional !== true || value.developmentOnly !== true || value.publiclyPublished !== false
      || !date(value.asOf) || value.asOf !== sourceQueueFixtureAt || !Number.isSafeInteger(value.validForMs)
      || (value.validForMs as number) < 1 || (value.validForMs as number) > 15000
      || !member(value.view, sourceQueueViews) || !Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 50
      || !cursor(value.nextCursor) || typeof value.retentionReviewRequired !== 'boolean'
      || !array(value.entries) || value.entries.length > (value.limit as number)) return null;
    const seen = new Set<string>();
    const entries: SourceQueueEntry[] = value.entries.map(input => {
      if (!record(input) || !reference(input.candidateRef) || seen.has(input.candidateRef)
        || !(input.publisher === null || text(input.publisher, 256)) || !safeURL(input.canonicalUrl)
        || !(input.publishedAt === null || date(input.publishedAt)) || !(input.retrievedAt === null || date(input.retrievedAt))
        || !member(input.provenance, ['PRIMARY','ORIGINAL','SECONDARY','SYNDICATED','UNKNOWN','DISPUTED'])
        || !member(input.provenanceStatus, ['RESOLVED','UNRESOLVED','DISPUTED'])
        || !member(input.rightsStatus, ['ACTIVE','MISSING','EXPIRED','REVOKED','SUPERSEDED','UNKNOWN'])
        || !member(input.retentionStatus, ['RETAINED','EXPIRED','DELETED','REVIEW_REQUIRED'])
        || !member(input.quarantineStatus, ['QUARANTINED','NOT_QUARANTINED','WITHHELD'])
        || typeof input.sourceEligible !== 'boolean' || input.canAdvance !== false
        || !(input.blockedReason === null || member(input.blockedReason, sourceQueueBlockedReasons))) throw Error('Invalid fictional metadata');
      const metadataFields = [input.publisher,input.canonicalUrl,input.publishedAt,input.retrievedAt];
      const withheld = metadataFields.every(item => item === null);
      if (withheld !== (input.quarantineStatus === 'WITHHELD')) throw Error('Invalid quarantine metadata');
      if (!withheld && (metadataFields.some(item => item === null) || input.rightsStatus !== 'ACTIVE' || !['RETAINED','REVIEW_REQUIRED'].includes(input.retentionStatus))) throw Error('Invalid metadata authority');
      if (['MALFORMED_RECORD','MISSING_RIGHTS','SOURCE_REMOVED'].includes(input.blockedReason as string) && !withheld) throw Error('Invalid marker metadata');
      if (input.sourceEligible && (withheld || input.quarantineStatus !== 'NOT_QUARANTINED' || input.rightsStatus !== 'ACTIVE' || input.retentionStatus !== 'RETAINED' || input.provenanceStatus !== 'RESOLVED' || ['UNKNOWN','DISPUTED'].includes(input.provenance) || input.blockedReason !== null || value.retentionReviewRequired)) throw Error('Invalid eligibility');
      if (!input.sourceEligible && input.blockedReason === null) throw Error('Missing restriction');
      if (['EXPIRED','DELETED'].includes(input.retentionStatus) && [input.publisher,input.canonicalUrl,input.publishedAt,input.retrievedAt].some(item => item !== null)) throw Error('Retained deleted metadata');
      let relationship: SourceQueueEntry['relationship'] = null;
      if (input.relationship !== null) {
        if (withheld || !record(input.relationship) || input.relationship.kind !== 'SYNDICATED' || !reference(input.relationship.originRef) || input.relationship.originRef === input.candidateRef || input.provenance !== 'SYNDICATED') throw Error('Invalid relationship');
        relationship = { kind: 'SYNDICATED', originRef: input.relationship.originRef };
      }
      seen.add(input.candidateRef);
      return { candidateRef: input.candidateRef, publisher: input.publisher, canonicalUrl: input.canonicalUrl,
        publishedAt: input.publishedAt, retrievedAt: input.retrievedAt, provenance: input.provenance,
        provenanceStatus: input.provenanceStatus, rightsStatus: input.rightsStatus, retentionStatus: input.retentionStatus, quarantineStatus: input.quarantineStatus,
        relationship, sourceEligible: input.sourceEligible, canAdvance: false, blockedReason: input.blockedReason };
    });
    return { fictional: true, developmentOnly: true, publiclyPublished: false, asOf: value.asOf,
      validForMs: value.validForMs as number, entries, nextCursor: value.nextCursor, view: value.view,
      limit: value.limit as number, retentionReviewRequired: value.retentionReviewRequired };
  } catch { return null; }
}

/** No caller repository, filesystem path, credentials or live provider can be supplied. */
export function createFictionalSourceQueueDisplaySource(): SourceQueueDisplaySource {
  let initialized: Promise<{ directory: string; queue: SourceQueue }> | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const reads = new Set<Promise<SourceQueueDisplay | null>>();
  async function initialize() {
    const directory = await mkdtemp(join(tmpdir(), 'dayline-fictional-source-queue-'));
    try {
      if (disposed) throw Error('Disposed');
      const repository = new JsonRepository(join(directory, 'fictional.json'));
      await seedSourceQueueFixture(repository, sourceQueueFixtureAt);
      if (disposed) throw Error('Disposed');
      return { directory, queue: new SourceQueue(repository, { clock: () => sourceQueueFixtureAt }) };
    } catch { await rm(directory, { recursive: true, force: true }); throw Error('Fictional source queue unavailable'); }
  }
  return {
    async read(query?: SourceQueueQuery) {
      if (disposed) return null;
      initialized ??= initialize();
      const pending = (async () => {
        try {
          const runtime = await initialized;
          if (disposed || !runtime) return null;
          const page = await runtime.queue.read(query);
          if (disposed) return null;
          return sanitizeSourceQueueDisplay({ ...page, fictional: true, developmentOnly: true,
            publiclyPublished: false, asOf: sourceQueueFixtureAt, validForMs: 15000 });
        } catch { return null; }
      })();
      reads.add(pending);
      try { return await pending; } finally { reads.delete(pending); }
    },
    dispose() {
      disposal ??= (async () => {
        disposed = true;
        await Promise.allSettled([...reads]);
        if (initialized) { const runtime = await initialized.catch(() => null); if (runtime) await rm(runtime.directory, { recursive: true, force: true }); }
      })();
      return disposal;
    },
  };
}
