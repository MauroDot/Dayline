import { mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyState, type State } from './model.ts';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: RecordValue, keys: string[]): boolean => keys.every(key => typeof value[key] === 'string');
const stringArray = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string');
const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const positiveInteger = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const optionalRedaction = (row: RecordValue): boolean => !Object.hasOwn(row, 'retentionRedacted') || row.retentionRedacted === true;
const rows = (value: unknown, valid: (row: RecordValue) => boolean): boolean => Array.isArray(value) && value.every(row => record(row) && valid(row));
const verified = (value: unknown): boolean => typeof value === 'string' && ['UNVERIFIED', 'VERIFIED', 'DISPUTED'].includes(value);
const source = (row: RecordValue): boolean => strings(row, ['id', 'publisher', 'url', 'canonicalUrl', 'type', 'publishedAt', 'retrievedAt', 'originId', 'rights']) && ['PRIMARY', 'ORIGINAL', 'SYNDICATED', 'SECONDARY'].includes(row.type as string) && verified(row.verification);
const evidence = (row: RecordValue): boolean => strings(row, ['id', 'claim', 'uncertainty']) && verified(row.verification) && ['support', 'contradict', 'reviewerDecisions'].every(key => stringArray(row[key]));
const revision = (row: RecordValue): boolean => strings(row, ['id', 'headline', 'topic', 'summary', 'geography', 'firstSeenAt', 'updatedAt', 'status']) && ['INGESTED', 'CLUSTERED', 'DRAFT', 'NEEDS_REVIEW', 'APPROVED', 'PUBLISHED', 'REJECTED', 'ON_HOLD', 'CORRECTION_REQUIRED'].includes(row.status as string) && nullableString(row.eventAt) && nullableString(row.clusterId) && positiveInteger(row.version) && stringArray(row.sourceIds) && rows(row.evidence, evidence) && optionalRedaction(row);
const approval = (row: RecordValue): boolean => strings(row, ['storyId', 'reviewer', 'at']) && positiveInteger(row.version) && optionalRedaction(row);
const audit = (row: RecordValue): boolean => strings(row, ['id', 'action', 'actor', 'at']) && nullableString(row.storyId) && (row.version === null || positiveInteger(row.version)) && (row.subjectId === undefined || typeof row.subjectId === 'string');
const baseArrays = (value: RecordValue): boolean => rows(value.sources, source) && rows(value.revisions, revision) && rows(value.approvals, approval) && rows(value.audit, audit);

// Storage validates record shapes; rights and provenance decisions remain the service's responsibility.
function policy(row: RecordValue): boolean {
  const flags = ['discoveryMetadata', 'licensedExcerpt', 'licensedFullText', 'media', 'internalAnalysis', 'publicRedistribution', 'aiSummarization', 'aiNarration', 'deletionRequired', 'quarantineMetadata', 'minimalAudit'];
  return strings(row, ['id', 'providerId', 'reviewStatus', 'effectiveAt', 'expiresAt', 'evidenceReference']) && positiveInteger(row.version) && positiveInteger(row.retentionDays) && (!Object.hasOwn(row, 'auditRetentionDays') || (typeof row.auditRetentionDays === 'number' && Number.isSafeInteger(row.auditRetentionDays) && row.auditRetentionDays >= 0)) && flags.every(key => typeof row[key] === 'boolean') && ['APPROVED', 'REVOKED', 'SUPERSEDED', 'PENDING'].includes(row.reviewStatus as string);
}
function managedSource(row: RecordValue): boolean {
  return strings(row, ['sourceId', 'providerId', 'retainedAt', 'deleteAt']) && record(row.policy) && policy(row.policy) && record(row.providerMetadata) && strings(row.providerMetadata, ['url', 'publisher', 'publishedAt', 'retrievedAt']) && record(row.providerProvenance) && typeof row.providerProvenance.type === 'string' && ['PRIMARY', 'ORIGINAL', 'SECONDARY', 'SYNDICATED', 'UNKNOWN', 'DISPUTED'].includes(row.providerProvenance.type) && (row.providerProvenance.type === 'SYNDICATED' ? typeof row.providerProvenance.originId === 'string' : row.providerProvenance.originId === null);
}
const quarantinedSource = (row: RecordValue): boolean => managedSource(row) && record(row.metadata) && strings(row.metadata, ['url', 'publisher', 'publishedAt', 'retrievedAt']);
const provenanceDecision = (row: RecordValue): boolean => strings(row, ['id', 'sourceId', 'classification', 'actorAssertion', 'at', 'reason']) && ['PRIMARY', 'ORIGINAL', 'SECONDARY', 'SYNDICATED', 'UNKNOWN', 'DISPUTED'].includes(row.classification as string) && nullableString(row.originId) && stringArray(row.evidenceReferences);
const deletion = (row: RecordValue): boolean => strings(row, ['sourceId', 'at', 'reason']) && (!Object.hasOwn(row, 'expiresAt') || typeof row.expiresAt === 'string');

function stateFromJSON(value: unknown): State {
  if (!record(value) || !baseArrays(value)) throw Error('Invalid repository format');
  if (value.schema === 1) {
    if (['managedSources', 'quarantine', 'provenanceDecisions', 'deletions', 'retentionReviewRequired'].some(key => Object.hasOwn(value, key))) throw Error('Invalid repository format');
    // Legacy assertions remain history, never an implicit rights or provenance approval.
    return { ...emptyState(), retentionReviewRequired: true, sources: value.sources, revisions: value.revisions, approvals: value.approvals, audit: value.audit } as State;
  }
  if (![2, 3].includes(value.schema as number) || !rows(value.managedSources, managedSource) || !rows(value.quarantine, quarantinedSource) || !rows(value.provenanceDecisions, provenanceDecision) || !rows(value.deletions, deletion)) throw Error('Invalid repository format');
  if (value.schema === 2) {
    if (Object.hasOwn(value, 'retentionReviewRequired')) throw Error('Invalid repository format');
    // Earlier deletion may have erased all linkage; require an explicit retention review.
    return { ...value, schema: 3, retentionReviewRequired: true } as unknown as State;
  }
  if (typeof value.retentionReviewRequired !== 'boolean') throw Error('Invalid repository format');
  return value as unknown as State;
}

export interface RepositoryOptions {
  /** Test seam: called after syncing the complete replacement, before its atomic rename. */
  beforeCommit?: () => void;
}

/** Local single-host storage. Atomic replacement plus exclusive lock; not a production database. */
export class JsonRepository {
  readonly file: string;
  private readonly beforeCommit: (() => void) | undefined;
  constructor(file: string, options: RepositoryOptions = {}) { this.file = file; this.beforeCommit = options.beforeCommit; }
  async read(): Promise<State> {
    try {
      return structuredClone(stateFromJSON(JSON.parse(await readFile(this.file, 'utf8'))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
  }
  async transact<T>(change: (state: State) => T): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true });
    const lock = this.file + '.lock';
    let locked = false;
    for (let i = 0; i < 200; i++) {
      try { await mkdir(lock); locked = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    if (!locked) throw Error('Repository is locked; inspect before recovery');
    const temp = join(dirname(this.file), `.${basename(this.file)}.${randomUUID()}.tmp`);
    try {
      const state = await this.read();
      const result = change(state);
      // A result that cannot be returned must fail before any data is committed.
      const clonedResult = structuredClone(result);
      if (state.schema !== 3) throw Error('Invalid repository format');
      stateFromJSON(state);
      const serialized = JSON.stringify(state);
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
      this.beforeCommit?.();
      await rename(temp, this.file);
      return clonedResult;
    } finally {
      // Preserve the transaction error, or its committed success, if cleanup fails.
      // A warning leaves an operational signal to inspect the local lock/temp files.
      const cleanup = await Promise.allSettled([rm(temp, { force: true }), rm(lock, { recursive: true, force: true })]);
      if (cleanup.some(result => result.status === 'rejected')) process.emitWarning('Repository cleanup failed; inspect local lock and temporary files', { code: 'DAYLINE_REPOSITORY_CLEANUP' });
    }
  }
}
