import { createHash } from 'node:crypto';
import { canonicalURL, validateSource, type Source, type State } from '../newsroom/model.ts';
import type { JsonRepository } from '../newsroom/store.ts';
import { metadata, retentionDeadline, sourceId, timestamp } from '../ingestion/metadata.ts';
import { eligibleSource } from '../ingestion/eligibility.ts';
import { sourceReviewSummary, sourceReviewValidUntil } from '../source-review/domain.ts';
import { policyStatus, type RegistryPolicy } from '../ingestion/policies.ts';
import type { ManagedSource } from '../ingestion/records.ts';
import { sourceQueueViews, type SourceQueueEntry, type SourceQueuePage, type SourceQueueQuery, type SourceQueueView } from './types.ts';
export type { SourceQueueEntry, SourceQueuePage, SourceQueueQuery } from './types.ts';

export class SourceQueueError extends Error {
  readonly code: 'INVALID_QUERY' | 'STALE_CURSOR' | 'UNAVAILABLE';
  constructor(code: SourceQueueError['code']) { super(code); this.name = 'SourceQueueError'; this.code = code; }
}
type Row = Record<string, unknown>;
type Candidate = { id: string; records: Row[]; sources: Row[]; quarantined: boolean; deleted?: Row };
type Projected = { id: string; entry: SourceQueueEntry; order: number; origin: string | null };
/** Trusted internal scope produced by the authenticated facade, never query input. */
export interface SourceQueueScope { sourceIds: readonly string[]; authorizationContext: string }
const classifications = ['PRIMARY', 'ORIGINAL', 'SECONDARY', 'SYNDICATED', 'UNKNOWN', 'DISPUTED'];
const policyFields = ['id', 'providerId', 'version', 'reviewStatus', 'effectiveAt', 'expiresAt', 'evidenceReference',
  'discoveryMetadata', 'licensedExcerpt', 'licensedFullText', 'media', 'internalAnalysis', 'publicRedistribution',
  'aiSummarization', 'aiNarration', 'retentionDays', 'deletionRequired', 'quarantineMetadata', 'minimalAudit', 'auditRetentionDays'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const candidateRef = (id: string) => `candidate-${hash(id)}`;
function plain(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => typeof key === 'string')
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(d => d.enumerable && Object.hasOwn(d, 'value'));
}
function list(value: unknown, maximum = 10000): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum
    && Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every(key => key === 'length' || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(d => Object.hasOwn(d, 'value'));
}
const text = (value: unknown, maximum = 256): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
function normalizedQuery(input: unknown): { view: SourceQueueView; limit: number; cursor?: string } {
  if (input === undefined) return { view: 'RECENT', limit: 20 };
  if (!plain(input) || Object.keys(input).some(key => !['view', 'limit', 'cursor'].includes(key))
    || (Object.hasOwn(input, 'view') && !sourceQueueViews.includes(input.view as SourceQueueView))
    || (Object.hasOwn(input, 'limit') && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 50))
    || (Object.hasOwn(input, 'cursor') && (typeof input.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(input.cursor)))) throw new SourceQueueError('INVALID_QUERY');
  return { view: (Object.hasOwn(input, 'view') ? input.view : 'RECENT') as SourceQueueView,
    limit: (Object.hasOwn(input, 'limit') ? input.limit : 20) as number,
    ...(Object.hasOwn(input, 'cursor') ? { cursor: input.cursor as string } : {}) };
}
function marker(id: string): SourceQueueEntry {
  return { candidateRef: candidateRef(id), publisher: null, canonicalUrl: null, publishedAt: null, retrievedAt: null,
    provenance: 'UNKNOWN', provenanceStatus: 'UNRESOLVED', rightsStatus: 'UNKNOWN', retentionStatus: 'REVIEW_REQUIRED',
    quarantineStatus: 'WITHHELD',
    relationship: null, sourceEligible: false, canAdvance: false, blockedReason: 'MALFORMED_RECORD' };
}
function checkedTime(value: unknown): number { if (typeof value !== 'string') throw Error(); return timestamp(value); }
function validDecision(row: Row, now: number): boolean {
  try {
    return text(row.id) && text(row.sourceId) && classifications.includes(row.classification as string)
      && (row.classification === 'SYNDICATED' ? text(row.originId) : row.originId === null)
      && text(row.actorAssertion, 4096) && text(row.reason, 4096) && checkedTime(row.at) <= now
      && list(row.evidenceReferences, 100) && row.evidenceReferences.length > 0 && row.evidenceReferences.every(value => text(value, 4096));
  } catch { return false; }
}
function project(candidate: Candidate, decisions: Row[], now: number, at: string, hold: boolean): Projected {
  const { id } = candidate, entry = marker(id);
  const result: Projected = { id, entry, order: -Infinity, origin: null };
  if (candidate.deleted) {
    entry.retentionStatus = 'DELETED'; entry.blockedReason = 'SOURCE_DELETED';
    result.order = checkedTime(candidate.deleted.at); return result;
  }
  if (!candidate.records.length) { entry.rightsStatus = 'MISSING'; entry.blockedReason = 'MISSING_RIGHTS'; return result; }
  if (candidate.records.length !== 1 || candidate.sources.length > 1) return result;
  const record = candidate.records[0];
  try {
    if (!plain(record.policy) || !plain(record.providerMetadata) || !plain(record.providerProvenance)
      || !text(record.providerId) || !text(record.sourceId) || !text(record.providerMetadata.publisher, 200)
      || !text(record.providerMetadata.url, 2048) || record.providerId !== record.policy.providerId
      || (record.providerProvenance.type === 'SYNDICATED' && !text(record.providerProvenance.originId))
      || ['id', 'providerId', 'reviewStatus', 'effectiveAt', 'expiresAt', 'evidenceReference'].some(key => !text((record.policy as Row)[key], 4096))) return result;
    const policy = record.policy as unknown as RegistryPolicy;
    const status = policyStatus(policy, at);
    entry.rightsStatus = status;
    if (status !== 'ACTIVE') {
      entry.blockedReason = status === 'UNKNOWN' ? 'UNKNOWN_RIGHTS' : `POLICY_${status}`;
      return result;
    }
    const input = metadata({ providerId: record.providerId, url: record.providerMetadata.url, publisher: record.providerMetadata.publisher,
      publishedAt: record.providerMetadata.publishedAt, retrievedAt: record.providerMetadata.retrievedAt,
      provenance: { type: record.providerProvenance.type, originId: record.providerProvenance.originId } } as Parameters<typeof metadata>[0], record.providerId);
    if (new URL(canonicalURL(input.url)).search || sourceId(input.url) !== id || checkedTime(input.publishedAt) > checkedTime(input.retrievedAt)
      || checkedTime(record.retainedAt) > now) return result;
    const deadline = retentionDeadline(record as unknown as ManagedSource);
    if (!Number.isFinite(deadline)) return result;
    if (deadline <= now) { entry.retentionStatus = 'EXPIRED'; entry.blockedReason = 'RETENTION_EXPIRED'; return result; }
    if (candidate.quarantined) {
      if (candidate.sources.length || policy.quarantineMetadata !== true || !plain(record.metadata)
        || ['url', 'publisher', 'publishedAt', 'retrievedAt'].some(key => (record.metadata as Row)[key] !== (record.providerMetadata as Row)[key])) return result;
    } else if (!candidate.sources.length) { entry.blockedReason = 'SOURCE_REMOVED'; return result; }
    const relevant = decisions.filter(d => d.sourceId === id);
    if (relevant.some(d => !validDecision(d, now))) return result;
    const resolved = relevant.filter(d => !['UNKNOWN', 'DISPUTED'].includes(d.classification as string));
    let provenance = input.provenance.type;
    let provenanceStatus: SourceQueueEntry['provenanceStatus'] = provenance === 'DISPUTED' ? 'DISPUTED' : 'UNRESOLVED';
    if (!candidate.quarantined) {
      const raw = candidate.sources[0];
      if (!['id', 'publisher', 'url', 'canonicalUrl', 'publishedAt', 'retrievedAt', 'type', 'originId', 'rights', 'verification'].every(key => typeof raw[key] === 'string')) return result;
      if (!text(raw.id) || !text(raw.originId) || !text(raw.publisher, 200) || !text(raw.url, 2048)
        || !text(raw.canonicalUrl, 2048) || !text(raw.rights, 16384)) return result;
      const source: Source = { id: raw.id as string, publisher: raw.publisher as string, url: raw.url as string, canonicalUrl: raw.canonicalUrl as string,
        publishedAt: raw.publishedAt as string, retrievedAt: raw.retrievedAt as string, type: raw.type as Source['type'], originId: raw.originId as string,
        rights: raw.rights as string, verification: raw.verification as Source['verification'] };
      validateSource(source);
      if (source.id !== id || ['url', 'publisher', 'publishedAt', 'retrievedAt'].some(key => raw[key] !== (record.providerMetadata as Row)[key])
        || source.canonicalUrl !== canonicalURL(input.url) || !resolved.length
        || resolved.some(d => d.classification !== source.type || d.originId !== (source.type === 'SYNDICATED' ? source.originId : null))
        || (!['UNKNOWN', 'DISPUTED'].includes(input.provenance.type) && (input.provenance.type !== source.type
          || (source.type === 'SYNDICATED' && input.provenance.originId !== source.originId)))) return result;
      const rights: unknown = JSON.parse(source.rights);
      if (!plain(rights) || policyStatus(rights as unknown as RegistryPolicy, at) !== 'ACTIVE' || policyFields.some(key => rights[key] !== (record.policy as Row)[key])) return result;
      provenance = source.type; provenanceStatus = 'RESOLVED';
      const lastResolved = relevant.reduce((latest, d, index) => !['UNKNOWN', 'DISPUTED'].includes(d.classification as string) ? index : latest, -1);
      const latestResolutionAt = Math.max(...resolved.map(d => checkedTime(d.at)));
      const outstanding = relevant.filter((d, index) => ['UNKNOWN', 'DISPUTED'].includes(d.classification as string)
        && (index > lastResolved || checkedTime(d.at) > latestResolutionAt));
      if (source.verification === 'DISPUTED' || outstanding.some(d => d.classification === 'DISPUTED')) provenanceStatus = 'DISPUTED';
      else if (outstanding.length) provenanceStatus = 'UNRESOLVED';
      if (source.type === 'SYNDICATED') result.origin = source.originId;
    } else {
      if (resolved.length) return result;
      if (relevant.some(d => d.classification === 'DISPUTED')) { provenance = 'DISPUTED'; provenanceStatus = 'DISPUTED'; }
    }
    entry.publisher = input.publisher; entry.canonicalUrl = canonicalURL(input.url);
    entry.publishedAt = new Date(checkedTime(input.publishedAt)).toISOString(); entry.retrievedAt = new Date(checkedTime(input.retrievedAt)).toISOString();
    entry.provenance = provenance; entry.provenanceStatus = provenanceStatus;
    entry.retentionStatus = hold ? 'REVIEW_REQUIRED' : 'RETAINED';
    entry.quarantineStatus = candidate.quarantined ? 'QUARANTINED' : 'NOT_QUARANTINED';
    entry.blockedReason = hold ? 'RETENTION_REVIEW_REQUIRED' : provenanceStatus === 'DISPUTED' ? 'PROVENANCE_DISPUTED'
      : provenanceStatus === 'UNRESOLVED' ? 'PROVENANCE_UNRESOLVED' : null;
    entry.sourceEligible = entry.blockedReason === null && entry.quarantineStatus === 'NOT_QUARANTINED';
    result.order = checkedTime(input.retrievedAt);
    return result;
  } catch { return { id, entry: { ...marker(id), rightsStatus: entry.rightsStatus }, order: -Infinity, origin: null }; }
}
function candidateRecords(state: State): Map<string, Candidate> {
  if (!plain(state) || typeof state.retentionReviewRequired !== 'boolean') throw Error();
  for (const key of ['sources', 'managedSources', 'quarantine', 'provenanceDecisions', 'deletions'] as const) {
    if (!list(state[key]) || !state[key].every(plain)) throw Error();
  }
  const candidates = new Map<string, Candidate>();
  const get = (id: unknown) => {
    if (!text(id)) throw Error();
    if (!candidates.has(id)) candidates.set(id, { id, records: [], sources: [], quarantined: false });
    return candidates.get(id)!;
  };
  for (const record of state.managedSources as unknown as Row[]) get(record.sourceId).records.push(record);
  for (const record of state.quarantine as unknown as Row[]) { const item = get(record.sourceId); item.records.push(record); item.quarantined = true; }
  for (const source of state.sources as unknown as Row[]) get(source.id).sources.push(source);
  for (const deletion of state.deletions as unknown as Row[]) get(deletion.sourceId);
  if (candidates.size > 10000) throw Error();
  return candidates;
}

/** Exact repository identities for trusted resource-policy probes; no metadata projection. */
export function sourceCandidateIds(state: State): string[] {
  try { return [...candidateRecords(state).keys()].sort(); }
  catch { throw new SourceQueueError('UNAVAILABLE'); }
}

function projection(state: State, at: string, allowed?: ReadonlySet<string>): { rows: Projected[]; hold: boolean } {
  const candidates = candidateRecords(state);
  const now = timestamp(at);
  let hold = state.retentionReviewRequired;
  const suppressed = new Set<string>();
  for (const deletion of state.deletions as unknown as Row[]) {
    const candidate = candidates.get(deletion.sourceId as string)!;
    try {
      if (checkedTime(deletion.at) > now || checkedTime(deletion.expiresAt) <= now) { suppressed.add(candidate.id); hold = true; }
      else if (candidate.deleted) { suppressed.add(candidate.id); hold = true; }
      else candidate.deleted = deletion;
    } catch { suppressed.add(candidate.id); hold = true; }
  }
  const rows = [...candidates.values()].filter(c => !suppressed.has(c.id)).map(c => project(c, state.provenanceDecisions as unknown as Row[], now, at, hold));
  // This flag describes the existing newsroom metadata boundary, never a grant
  // for analysis, AI use, public display, narration, approval or publication.
  for (const row of rows) if (row.entry.sourceEligible) {
    const source = state.sources.find(source => source.id === row.id);
    try { if (!source || !eligibleSource(state, source, at)) { row.entry.sourceEligible = false; row.entry.blockedReason = 'ORIGIN_UNAVAILABLE'; } }
    catch { row.entry = { ...marker(row.id), blockedReason: 'MALFORMED_RECORD' }; }
  }
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const row of rows) if (row.origin) {
    const origin = byId.get(row.origin);
    if (origin?.entry.sourceEligible && ['PRIMARY', 'ORIGINAL'].includes(origin.entry.provenance)) row.entry.relationship = { kind: 'SYNDICATED', originRef: origin.entry.candidateRef };
    else if (!hold) row.entry = { ...marker(row.id), rightsStatus: row.entry.rightsStatus, blockedReason: 'ORIGIN_UNAVAILABLE' };
    else { row.entry.sourceEligible = false; row.entry.blockedReason ??= 'ORIGIN_UNAVAILABLE'; }
  }
  const visible = allowed ? rows.filter(row => allowed.has(row.id)) : rows;
  // Origin validity still uses authoritative repository records. Its identity
  // requires a separate read assignment before it may enter the visible view.
  if (allowed) for (const row of visible) if (row.origin && !allowed.has(row.origin)) row.entry.relationship = null;
  // Only the authenticated scoped view receives review metadata. Private history,
  // evidence and reviewer identities never enter the DTO or its cursor fingerprint.
  if (allowed) for (const row of visible) if (state.sourceReviews?.some(review => review.sourceId === row.id)) {
    const review = sourceReviewSummary(state, row.id, at);
    row.entry.review = { status: review.status, revision: review.reviewRevision, blocked: review.blocked,
      proposalPending: review.pendingProposal, independentlyResolved: review.independentlyResolved, reviewAllowed: review.reviewAllowed };
    if (review.status === 'ON_HOLD') { row.entry.sourceEligible = false; row.entry.blockedReason = 'SOURCE_REVIEW_HOLD'; }
  }
  return { rows: visible, hold };
}
function matches(entry: SourceQueueEntry, view: SourceQueueView): boolean {
  if (view === 'UNRESOLVED') return entry.canonicalUrl !== null && entry.provenanceStatus !== 'RESOLVED' && entry.rightsStatus === 'ACTIVE' && entry.retentionStatus !== 'EXPIRED';
  if (view === 'RELATED') return entry.relationship !== null;
  if (view === 'ELIGIBLE') return entry.sourceEligible;
  if (view === 'BLOCKED') return !entry.sourceEligible;
  if (view === 'WITHDRAWN') return ['EXPIRED', 'DELETED'].includes(entry.retentionStatus) || ['EXPIRED', 'REVOKED', 'SUPERSEDED', 'MISSING', 'UNKNOWN'].includes(entry.rightsStatus);
  return true;
}

function normalizedScope(scope: SourceQueueScope | undefined): { allowed: ReadonlySet<string>; context: string } | undefined {
  if (scope === undefined) return undefined;
  if (!plain(scope) || Object.keys(scope).sort().join(',') !== 'authorizationContext,sourceIds'
    || !list(scope.sourceIds) || !scope.sourceIds.every(id => text(id))
    || new Set(scope.sourceIds).size !== scope.sourceIds.length
    || typeof scope.authorizationContext !== 'string' || !/^[a-f0-9]{64}$/.test(scope.authorizationContext)) throw Error();
  return { allowed: new Set(scope.sourceIds as string[]), context: scope.authorizationContext };
}

/** Earliest future time that can change this authorized projection, including authoritative origin and global-hold dependencies. */
export function sourceQueueValidUntil(state: State, at: string, scope?: SourceQueueScope): number | null {
  try {
    const candidates = candidateRecords(state), authorized = normalizedScope(scope);
    const now = timestamp(at);
    let cutoff = Infinity;
    const considerNumber = (value: number) => { if (Number.isFinite(value) && value > now) cutoff = Math.min(cutoff, value); };
    const consider = (value: unknown, policyTime = false) => {
      if (typeof value !== 'string') return;
      try { considerNumber(policyTime ? Date.parse(value) : checkedTime(value)); } catch { /* A permanently malformed field has no clock transition. */ }
    };
    const links = new Map<string, Set<string>>();
    const link = (id: string, origin: unknown) => {
      if (!text(origin)) return;
      if (!links.has(id)) links.set(id, new Set());
      links.get(id)!.add(origin);
    };
    for (const candidate of candidates.values()) {
      for (const source of candidate.sources) if (source.type === 'SYNDICATED') link(candidate.id, source.originId);
      for (const record of candidate.records) if (plain(record.providerProvenance) && record.providerProvenance.type === 'SYNDICATED') link(candidate.id, record.providerProvenance.originId);
    }
    for (const decision of state.provenanceDecisions as unknown as Row[]) {
      if (text(decision.sourceId) && decision.classification === 'SYNDICATED') link(decision.sourceId, decision.originId);
    }
    const relevant = new Set(authorized?.allowed ?? candidates.keys()), pending = [...relevant];
    for (let index = 0; index < pending.length; index++) for (const origin of links.get(pending[index]) ?? []) {
      if (!relevant.has(origin)) { relevant.add(origin); pending.push(origin); }
    }
    const policyTimes = (value: unknown) => {
      if (plain(value)) { consider(value.effectiveAt, true); consider(value.expiresAt, true); }
    };
    for (const id of relevant) {
      const candidate = candidates.get(id);
      if (!candidate) continue;
      for (const source of candidate.sources) if (typeof source.rights === 'string') {
        try { policyTimes(JSON.parse(source.rights)); } catch { /* Malformed rights stay withheld. */ }
      }
      for (const record of candidate.records) {
        consider(record.retainedAt);
        policyTimes(record.policy);
        if (plain(record.policy) && plain(record.providerMetadata)
          && Number.isSafeInteger(record.policy.retentionDays) && (record.policy.retentionDays as number) > 0) {
          try { considerNumber(retentionDeadline(record as unknown as ManagedSource)); } catch { /* Malformed retention stays withheld. */ }
        }
      }
    }
    for (const decision of state.provenanceDecisions as unknown as Row[]) if (relevant.has(decision.sourceId as string)) consider(decision.at);
    if (authorized) for (const id of authorized.allowed) if (state.sourceReviews?.some(review => review.sourceId === id)) {
      const reviewCutoff = sourceReviewValidUntil(state, id, at);
      if (reviewCutoff !== null) considerNumber(reviewCutoff);
    }
    // Any deletion marker can establish the repository-wide retention review hold.
    for (const deletion of state.deletions as unknown as Row[]) { consider(deletion.at); consider(deletion.expiresAt); }
    return Number.isFinite(cutoff) ? cutoff : null;
  } catch { throw new SourceQueueError('UNAVAILABLE'); }
}

const metadataFields = ['url', 'publisher', 'publishedAt', 'retrievedAt'];
const sourceFields = ['id', 'publisher', 'url', 'canonicalUrl', 'publishedAt', 'retrievedAt', 'type', 'originId', 'verification'];
// Cursor state observes only named authoritative fields. Arbitrary provider
// additions, reviewer assertions and private audit fields never enter its hash.
function primitive(value: unknown): string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value)) ? value : null;
}
function fields(value: unknown, keys: readonly string[]): unknown {
  return plain(value) ? keys.map(key => [key, primitive(value[key])]) : null;
}
function rights(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try { return fields(JSON.parse(value), policyFields); } catch { return null; }
}
function authoritativeState(state: State, allowed: ReadonlySet<string>, at: string): unknown {
  const managed = (row: Row) => [fields(row, ['sourceId', 'providerId', 'retainedAt', 'deleteAt']),
    fields(row.providerMetadata, metadataFields), fields(row.providerProvenance, ['type', 'originId']), fields(row.policy, policyFields)];
  const now = timestamp(at);
  return [
    (state.sources as unknown as Row[]).filter(row => allowed.has(row.id as string)).map(row => [fields(row, sourceFields), rights(row.rights)]),
    (state.managedSources as unknown as Row[]).filter(row => allowed.has(row.sourceId as string)).map(managed),
    (state.quarantine as unknown as Row[]).filter(row => allowed.has(row.sourceId as string)).map(row => [managed(row), fields(row.metadata, metadataFields)]),
    (state.provenanceDecisions as unknown as Row[]).filter(row => allowed.has(row.sourceId as string))
      .map(row => [fields(row, ['sourceId', 'classification', 'originId', 'at']), validDecision(row, now)]),
    (state.deletions as unknown as Row[]).filter(row => allowed.has(row.sourceId as string)).map(row => fields(row, ['sourceId', 'at', 'expiresAt'])),
  ];
}

/** Internal synchronous projection; authentication and current-state fencing belong to its caller. */
export function projectSourceQueue(state: State, at: string, query?: SourceQueueQuery, scope?: SourceQueueScope): SourceQueuePage {
  let normalized;
  try { normalized = normalizedQuery(query); } catch { throw new SourceQueueError('INVALID_QUERY'); }
  try {
    const authorized = normalizedScope(scope);
    const { rows, hold } = projection(state, at, authorized?.allowed);
    rows.sort((a, b) => b.order - a.order || (a.entry.candidateRef < b.entry.candidateRef ? -1 : a.entry.candidateRef > b.entry.candidateRef ? 1 : 0));
    const entries = rows.map(row => row.entry).filter(entry => matches(entry, normalized.view));
    const fingerprint = hash(JSON.stringify([normalized.view, normalized.limit, hold, rows.map(row => row.entry),
      ...(authorized ? [authorized.context, [...authorized.allowed].sort(), authoritativeState(state, authorized.allowed, at)] : [])]));
    let offset = 0;
    if (normalized.cursor) {
      let cursor: unknown;
      try {
        const decoded = Buffer.from(normalized.cursor, 'base64url');
        if (decoded.toString('base64url') !== normalized.cursor) throw Error();
        cursor = JSON.parse(decoded.toString('utf8'));
        if (!plain(cursor) || Object.keys(cursor).sort().join(',') !== 'fingerprint,offset' || !/^[a-f0-9]{64}$/.test(cursor.fingerprint as string)
          || !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 1 || (cursor.offset as number) > 10000) throw Error();
      } catch { throw new SourceQueueError('INVALID_QUERY'); }
      if (cursor.fingerprint !== fingerprint || (cursor.offset as number) >= entries.length) throw new SourceQueueError('STALE_CURSOR');
      offset = cursor.offset as number;
    }
    const end = Math.min(offset + normalized.limit, entries.length);
    return { entries: entries.slice(offset, end), nextCursor: end < entries.length ? Buffer.from(JSON.stringify({ fingerprint, offset: end })).toString('base64url') : null,
      view: normalized.view, limit: normalized.limit, retentionReviewRequired: hold };
  } catch (error) {
    if (error instanceof SourceQueueError) throw error;
    throw new SourceQueueError('UNAVAILABLE');
  }
}

/** Read-only projection. Atomic repository snapshots remain the sole source of truth. */
export class SourceQueue {
  private readonly repository: JsonRepository;
  private readonly clock: () => string;
  constructor(repository: JsonRepository, options: { clock?: () => string } = {}) { this.repository = repository; this.clock = options.clock ?? (() => new Date().toISOString()); }
  async read(query?: SourceQueueQuery): Promise<SourceQueuePage> {
    let normalized;
    try { normalized = normalizedQuery(query); } catch { throw new SourceQueueError('INVALID_QUERY'); }
    try {
      const state = await this.repository.read();
      return projectSourceQueue(state, this.clock(), normalized);
    } catch (error) {
      if (error instanceof SourceQueueError) throw error;
      throw new SourceQueueError('UNAVAILABLE');
    }
  }
}
