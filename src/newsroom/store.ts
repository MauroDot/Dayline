import { mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyState, type State } from './model.ts';
import { sectionIds } from '../editions/types.ts';
import { occurrenceOn, validateDefinition } from '../scheduling/calendar.ts';
import type { PreparationSchedule, ScheduleDefinition } from '../scheduling/types.ts';
import { roles, permissions } from '../security/types.ts';
import { validSourceReviewHistory } from '../source-review/types.ts';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: RecordValue, keys: string[]): boolean => keys.every(key => typeof value[key] === 'string');
const stringArray = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string');
const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const positiveInteger = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 128;
const optionalRedaction = (row: RecordValue): boolean => !Object.hasOwn(row, 'retentionRedacted') || row.retentionRedacted === true;
const rows = (value: unknown, valid: (row: RecordValue) => boolean): value is RecordValue[] => Array.isArray(value) && value.every(row => record(row) && valid(row));
const verified = (value: unknown): boolean => typeof value === 'string' && ['UNVERIFIED', 'VERIFIED', 'DISPUTED'].includes(value);
const source = (row: RecordValue): boolean => strings(row, ['id', 'publisher', 'url', 'canonicalUrl', 'type', 'publishedAt', 'retrievedAt', 'originId', 'rights']) && ['PRIMARY', 'ORIGINAL', 'SYNDICATED', 'SECONDARY'].includes(row.type as string) && verified(row.verification);
const evidence = (row: RecordValue): boolean => strings(row, ['id', 'claim', 'uncertainty']) && verified(row.verification) && ['support', 'contradict', 'reviewerDecisions'].every(key => stringArray(row[key]));
const revision = (row: RecordValue): boolean => strings(row, ['id', 'headline', 'topic', 'summary', 'geography', 'firstSeenAt', 'updatedAt', 'status']) && ['INGESTED', 'CLUSTERED', 'DRAFT', 'NEEDS_REVIEW', 'APPROVED', 'PUBLISHED', 'REJECTED', 'ON_HOLD', 'CORRECTION_REQUIRED'].includes(row.status as string) && nullableString(row.eventAt) && nullableString(row.clusterId) && positiveInteger(row.version) && stringArray(row.sourceIds) && rows(row.evidence, evidence) && optionalRedaction(row);
const approval = (row: RecordValue): boolean => strings(row, ['storyId', 'reviewer', 'at']) && positiveInteger(row.version) && optionalRedaction(row);
const audit = (row: RecordValue): boolean => strings(row, ['id', 'action', 'actor', 'at']) && nullableString(row.storyId) && (row.version === null || positiveInteger(row.version)) && (row.subjectId === undefined || typeof row.subjectId === 'string') && ['scheduleId', 'preparationRunId'].every(key => !Object.hasOwn(row, key) || identifier(row[key]));
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

const draftStates = ['GENERATED', 'NEEDS_REVIEW', 'REVISION_REQUESTED', 'READY_FOR_APPROVAL', 'REJECTED', 'INVALIDATED', 'ON_HOLD'];
const draftState = (value: unknown): boolean => typeof value === 'string' && draftStates.includes(value);
const nonnegativeInteger = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const draftSection = (row: RecordValue): boolean => strings(row, ['kind', 'text']) && ['FACT', 'ANALYSIS', 'UNCERTAINTY'].includes(row.kind as string) && stringArray(row.evidenceIds);
const draftClaim = (row: RecordValue): boolean => strings(row, ['evidenceId', 'text']) && stringArray(row.supportingSourceIds) && stringArray(row.contradictingSourceIds);
const draftOutput = (row: RecordValue): boolean => strings(row, ['headline', 'summary']) && rows(row.sections, draftSection) && rows(row.claims, draftClaim) && stringArray(row.uncertainties);
const draftPolicy = (row: RecordValue): boolean => strings(row, ['sourceId', 'providerId', 'policyId', 'snapshotDigest']) && positiveInteger(row.policyVersion);
const draftSuggestion = (row: RecordValue): boolean => strings(row, ['code', 'message']) && ['LOADED_LANGUAGE', 'UNSUPPORTED_CAUSALITY', 'UNATTRIBUTED_ALLEGATION', 'MISLEADING_CERTAINTY', 'MISSING_UNCERTAINTY', 'UNSUPPORTED_NUMBERS', 'OPINION_AS_FACT', 'MISSING_COUNTEREVIDENCE', 'HEADLINE_BODY_CONFLICT'].includes(row.code as string);
const draftUsage = (row: RecordValue): boolean => ['inputTokens', 'outputTokens', 'estimatedCostMicros'].every(key => nonnegativeInteger(row[key]));
function draft(row: RecordValue): boolean {
  if (row.status === 'INVALIDATED') {
    // Invalid proposals may retain only this marker, never licensed payload or linkage.
    return strings(row, ['id', 'invalidatedAt']) && row.reason === 'STALE_OR_INELIGIBLE' && Object.keys(row).every(key => ['id', 'status', 'invalidatedAt', 'reason'].includes(key));
  }
  return strings(row, ['id', 'storyId', 'generatedAt', 'expiresAt', 'providerId', 'modelVersion']) && positiveInteger(row.storyVersion) && positiveInteger(row.version) && draftState(row.status) && row.promptTemplateVersion === 'dayline-editorial-v1' && stringArray(row.sourceIds) && rows(row.policies, draftPolicy) && record(row.output) && draftOutput(row.output) && rows(row.suggestions, draftSuggestion) && record(row.usage) && draftUsage(row.usage);
}
const draftReview = (row: RecordValue): boolean => strings(row, ['draftId', 'actorAssertion', 'at']) && positiveInteger(row.fromVersion) && positiveInteger(row.toVersion) && (row.storyVersion === null || positiveInteger(row.storyVersion)) && draftState(row.fromState) && draftState(row.toState) && row.unauthenticated === true;

const exactKeys = (row: RecordValue, keys: readonly string[]): boolean => Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
const uniqueStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => text(item)) && new Set(value).size === value.length;
function utcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  return new Date(time).toISOString() === value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
}
function editionDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && utcTimestamp(value + 'T00:00:00Z');
}
function timezone(value: unknown): value is string {
  if (!text(value, 128)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}
const editionStates = ['ASSEMBLING', 'NEEDS_REVIEW', 'READY_FOR_APPROVAL', 'REVISION_REQUESTED', 'ON_HOLD', 'REJECTED', 'INVALIDATED'];
const editionState = (value: unknown): boolean => typeof value === 'string' && editionStates.includes(value);
function editionSource(row: RecordValue): boolean {
  if (!exactKeys(row, ['sourceId', 'originId', 'publisher', 'url', 'providerId', 'policyId', 'policyVersion', 'snapshotDigest', 'expiresAt']) || !['sourceId', 'originId', 'publisher', 'providerId', 'policyId', 'snapshotDigest'].every(key => text(row[key])) || !positiveInteger(row.policyVersion) || !utcTimestamp(row.expiresAt) || !text(row.url)) return false;
  try { const url = new URL(row.url); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
const editionEvidence = (row: RecordValue): boolean => exactKeys(row, ['id', 'support', 'contradict', 'uncertainty']) && text(row.id) && uniqueStrings(row.support) && row.support.length > 0 && uniqueStrings(row.contradict) && typeof row.uncertainty === 'string' && row.uncertainty.length <= 2048;
function editionPlacement(row: RecordValue): boolean {
  if (!exactKeys(row, ['storyId', 'storyVersion', 'headline', 'summary', 'featured', 'sources', 'evidence', 'independentSourceCount', 'expiresAt']) || !text(row.storyId) || !positiveInteger(row.storyVersion) || !text(row.headline, 512) || !text(row.summary, 4096) || typeof row.featured !== 'boolean' || !utcTimestamp(row.expiresAt) || !rows(row.sources, editionSource) || row.sources.length < 1 || row.sources.length > 64 || !rows(row.evidence, editionEvidence) || row.evidence.length < 1 || row.evidence.length > 16 || !positiveInteger(row.independentSourceCount)) return false;
  const sources = row.sources as RecordValue[], evidence = row.evidence as RecordValue[];
  const ids = new Set(sources.map(source => source.sourceId));
  return ids.size === sources.length && new Set(evidence.map(item => item.id)).size === evidence.length && row.independentSourceCount === new Set(sources.map(source => source.originId)).size && evidence.every(item => [...item.support as string[], ...item.contradict as string[]].every(id => ids.has(id)));
}
const editionSection = (row: RecordValue): boolean => exactKeys(row, ['id', 'placements']) && typeof row.id === 'string' && (sectionIds as readonly string[]).includes(row.id) && rows(row.placements, editionPlacement);
const editionSuggestion = (row: RecordValue): boolean => exactKeys(row, ['code', 'storyId', 'message']) && text(row.storyId) && text(row.message) && typeof row.code === 'string' && ['UNSUPPORTED_HEADLINE', 'MISLEADING_PROMINENCE', 'MISSING_ATTRIBUTION', 'MISSING_UNCERTAINTY', 'UNDISCLOSED_CONTRADICTIONS', 'SYNDICATED_REPETITION', 'HEADLINE_ARTICLE_CONFLICT', 'OPINION_AS_FACT'].includes(row.code);
function edition(row: RecordValue): boolean {
  const baseKeys = ['id', 'date', 'timezone', 'revision', 'createdAt', 'updatedAt', 'status'];
  if (!text(row.id) || !editionDate(row.date) || !timezone(row.timezone) || !positiveInteger(row.revision) || !utcTimestamp(row.createdAt) || !utcTimestamp(row.updatedAt) || Date.parse(row.updatedAt) < Date.parse(row.createdAt)) return false;
  if (row.status === 'INVALIDATED') return exactKeys(row, [...baseKeys, 'reason']) && row.reason === 'STALE_OR_INELIGIBLE';
  if (!exactKeys(row, [...baseKeys, 'sections', 'suggestions']) || !editionState(row.status) || !rows(row.sections, editionSection) || row.sections.length !== sectionIds.length || !rows(row.suggestions, editionSuggestion)) return false;
  const sections = row.sections as RecordValue[];
  if (!sections.every((section, index) => section.id === sectionIds[index])) return false;
  const ids = new Set<string>();
  let featured = 0;
  for (const section of sections) {
    for (const placement of section.placements as RecordValue[]) {
      if (ids.has(placement.storyId as string)) return false;
      ids.add(placement.storyId as string);
      if (placement.featured && (section.id !== 'TOP_STORIES' || ++featured > 1)) return false;
    }
  }
  return (row.suggestions as RecordValue[]).every(suggestion => ids.has(suggestion.storyId as string));
}
const editionReview = (row: RecordValue): boolean => exactKeys(row, ['editionId', 'fromRevision', 'toRevision', 'fromState', 'toState', 'actorAssertion', 'unauthenticated', 'at']) && text(row.editionId) && positiveInteger(row.fromRevision) && positiveInteger(row.toRevision) && editionState(row.fromState) && editionState(row.toState) && text(row.actorAssertion) && row.unauthenticated === true && utcTimestamp(row.at);
function editionHistory(editions: RecordValue[], reviews: RecordValue[]): boolean {
  const latest = new Map<string, number>(), revisions = new Map<string, Set<number>>();
  for (const row of editions) {
    const id = row.id as string, revision = row.revision as number;
    if (revision <= (latest.get(id) ?? 0)) return false;
    latest.set(id, revision);
    if (!revisions.has(id)) revisions.set(id, new Set());
    revisions.get(id)!.add(revision);
  }
  return reviews.every(review => (review.toRevision as number) > (review.fromRevision as number)
    && revisions.get(review.editionId as string)?.has(review.fromRevision as number)
    && revisions.get(review.editionId as string)?.has(review.toRevision as number));
}

const definitionKeys = ['name', 'timezone', 'localTime', 'weekdays', 'enabled', 'maxAttempts', 'retryDelayMs', 'catchUpWindowMs'] as const;
function schedule(row: RecordValue): boolean {
  if (!exactKeys(row, ['id', ...definitionKeys, 'createdAt', 'updatedAt', 'lastEvaluatedAt', 'nextOccurrence']) || !identifier(row.id) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.id) || !utcTimestamp(row.createdAt) || !utcTimestamp(row.updatedAt) || Date.parse(row.updatedAt) < Date.parse(row.createdAt) || (row.lastEvaluatedAt !== null && !utcTimestamp(row.lastEvaluatedAt))) return false;
  try {
    const input = Object.fromEntries(definitionKeys.map(key => [key, row[key]]));
    const normalized = validateDefinition(input as unknown as ScheduleDefinition);
    if (definitionKeys.some(key => JSON.stringify(row[key]) !== JSON.stringify(normalized[key]))) return false;
    return row.nextOccurrence === null || (record(row.nextOccurrence) && occurrence(row.nextOccurrence, row));
  } catch { return false; }
}
function occurrence(row: RecordValue, owner: RecordValue): boolean {
  if (!exactKeys(row, ['key', 'date', 'timezone', 'localTime', 'at']) || !editionDate(row.date) || !utcTimestamp(row.at) || row.key !== `${owner.id}:${row.date}` || row.timezone !== owner.timezone || row.localTime !== owner.localTime) return false;
  try {
    const expected = occurrenceOn(owner as unknown as PreparationSchedule, row.date);
    return expected !== null && expected.key === row.key && expected.timezone === row.timezone && expected.localTime === row.localTime && Date.parse(expected.at) === Date.parse(row.at);
  } catch { return false; }
}
const failureCodes = ['MISSED_WINDOW', 'EDITION_CONFLICT', 'INELIGIBLE_CONTENT', 'RETENTION_HOLD', 'TRANSIENT_FAILURE', 'INTERRUPTED', 'RETRY_EXHAUSTED', 'PAUSED', 'CANCELLED'];
const runStates = ['SCHEDULED', 'CLAIMED', 'PREPARING', 'PREPARED', 'NEEDS_ATTENTION', 'FAILED', 'CANCELLED'];
function preparationRun(row: RecordValue): boolean {
  if (!exactKeys(row, ['id', 'scheduleId', 'occurrence', 'status', 'attempts', 'maxAttempts', 'retryDelayMs', 'claimId', 'leaseUntil', 'nextRetryAt', 'editionId', 'editionRevision', 'failure', 'missedSince', 'createdAt', 'updatedAt']) || !identifier(row.id) || !identifier(row.scheduleId) || !record(row.occurrence) || typeof row.status !== 'string' || !runStates.includes(row.status) || !nonnegativeInteger(row.attempts) || !positiveInteger(row.maxAttempts) || (row.maxAttempts as number) > 3 || (row.attempts as number) > (row.maxAttempts as number) || !positiveInteger(row.retryDelayMs) || (row.retryDelayMs as number) < 1000 || (row.retryDelayMs as number) > 3600000 || !utcTimestamp(row.createdAt) || !utcTimestamp(row.updatedAt) || Date.parse(row.updatedAt) < Date.parse(row.createdAt) || !['leaseUntil', 'nextRetryAt', 'missedSince'].every(key => row[key] === null || utcTimestamp(row[key])) || (row.failure !== null && (typeof row.failure !== 'string' || !failureCodes.includes(row.failure)))) return false;
  const hasEdition = row.editionId !== null;
  if ((hasEdition !== (row.editionRevision !== null)) || (hasEdition && (!identifier(row.editionId) || !positiveInteger(row.editionRevision)))) return false;
  if (['CLAIMED', 'PREPARING'].includes(row.status)) return identifier(row.claimId) && row.leaseUntil !== null && Date.parse(row.leaseUntil as string) > Date.parse(row.updatedAt) && (row.attempts as number) > 0 && row.nextRetryAt === null && row.failure === null && !hasEdition;
  if (row.claimId !== null || row.leaseUntil !== null) return false;
  if (row.status === 'FAILED') {
    return !hasEdition && (row.attempts as number) > 0 && ((row.attempts as number) === row.maxAttempts
      ? row.failure === 'RETRY_EXHAUSTED' && row.nextRetryAt === null
      : ['TRANSIENT_FAILURE', 'INTERRUPTED'].includes(row.failure as string) && row.nextRetryAt !== null);
  }
  if (row.nextRetryAt !== null) return false;
  if (row.status === 'SCHEDULED') return row.attempts === 0 && row.failure === null && !hasEdition;
  if (row.status === 'PREPARED') return (row.attempts as number) > 0 && row.failure === null && hasEdition;
  if (row.status === 'CANCELLED') return ['PAUSED', 'CANCELLED'].includes(row.failure as string) && !hasEdition;
  return ['MISSED_WINDOW', 'EDITION_CONFLICT', 'INELIGIBLE_CONTENT', 'RETENTION_HOLD'].includes(row.failure as string);
}
function schedulingHistory(schedules: RecordValue[], runs: RecordValue[], editions: RecordValue[]): boolean {
  if (schedules.length > 32 || runs.length > 4096) return false;
  const owners = new Map(schedules.map(row => [row.id as string, row]));
  if (owners.size !== schedules.length || new Set(runs.map(row => row.id)).size !== runs.length) return false;
  const keys = new Set<string>();
  for (const run of runs) {
    const owner = owners.get(run.scheduleId as string);
    if (!owner || !record(run.occurrence) || !occurrence(run.occurrence, owner) || run.maxAttempts !== owner.maxAttempts || run.retryDelayMs !== owner.retryDelayMs || keys.has(run.occurrence.key as string)) return false;
    keys.add(run.occurrence.key as string);
    if (run.status === 'PREPARED' && !editions.some(edition => edition.id === run.editionId && edition.revision === run.editionRevision && edition.status === 'ASSEMBLING' && edition.date === (run.occurrence as RecordValue).date && edition.timezone === owner.timezone)) return false;
  }
  return true;
}

function securityKeys(row: RecordValue, keys: readonly string[]): boolean {
  return [Object.prototype, null].includes(Object.getPrototypeOf(row)) && Reflect.ownKeys(row).length === keys.length
    && keys.every(key => Object.hasOwn(row, key))
    && Object.values(Object.getOwnPropertyDescriptors(row)).every(descriptor => descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
}
function securityList(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum
    && Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every(key => key === 'length' || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value'));
}
const securityOpaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value);
function issuerReference(value: unknown, maximum = 256): value is string {
  if (typeof value !== 'string' || value.length > maximum || /[\s?#]/.test(value)) return false;
  if (/^urn:[A-Za-z0-9][A-Za-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._~:/%-]*$/.test(value)) return true;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}
const audienceReference = (value: unknown): boolean => typeof value === 'string' && value.length <= 128 && (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) || issuerReference(value, 128));
function identityRecord(row: RecordValue): boolean {
  return securityKeys(row, ['id', 'status', 'roles', 'provider', 'revision', 'credentialVersion', 'credentialsRotatedAt', 'createdAt', 'updatedAt'])
    && securityOpaque(row.id) && ['ACTIVE', 'DISABLED'].includes(row.status as string)
    && securityList(row.roles, roles.length) && row.roles.every(role => typeof role === 'string' && (roles as readonly string[]).includes(role)) && new Set(row.roles).size === row.roles.length
    && record(row.provider) && securityKeys(row.provider, ['issuer', 'subject']) && issuerReference(row.provider.issuer) && securityOpaque(row.provider.subject)
    && positiveInteger(row.revision) && positiveInteger(row.credentialVersion)
    && utcTimestamp(row.createdAt) && utcTimestamp(row.updatedAt) && Date.parse(row.updatedAt) >= Date.parse(row.createdAt)
    && (row.credentialsRotatedAt === null || (utcTimestamp(row.credentialsRotatedAt) && Date.parse(row.credentialsRotatedAt) >= Date.parse(row.createdAt) && Date.parse(row.credentialsRotatedAt) <= Date.parse(row.updatedAt)));
}
function sessionRecord(row: RecordValue): boolean {
  return securityKeys(row, ['id', 'auditRef', 'userId', 'issuer', 'audience', 'keyId', 'credentialVersion', 'authenticatedAt', 'notBefore', 'expiresAt', 'revokedAt'])
    && ['id', 'auditRef', 'userId'].every(key => securityOpaque(row[key])) && typeof row.keyId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.keyId) && issuerReference(row.issuer) && audienceReference(row.audience) && positiveInteger(row.credentialVersion)
    && utcTimestamp(row.authenticatedAt) && utcTimestamp(row.notBefore) && utcTimestamp(row.expiresAt)
    && Date.parse(row.authenticatedAt) <= Date.parse(row.notBefore) && Date.parse(row.notBefore) < Date.parse(row.expiresAt)
    && (row.revokedAt === null || (utcTimestamp(row.revokedAt) && Date.parse(row.revokedAt) >= Date.parse(row.authenticatedAt)));
}
const securityCategories = ['AUTH_SUCCESS', 'AUTH_FAILURE', 'AUTHZ_DENIED', 'ROLE_CHANGED', 'SESSION_REVOKED', 'IDENTITY_STATUS_CHANGED', 'CREDENTIALS_ROTATED', 'PROTECTED_ACTION', 'IDENTITY_CREATED'];
const securityCodes = ['SUCCESS', 'INVALID_CREDENTIAL', 'INVALID_SESSION', 'SESSION_EXPIRED', 'SESSION_FUTURE', 'SESSION_REVOKED', 'IDENTITY_DISABLED', 'PERMISSION_DENIED', 'STALE_TARGET', 'DOMAIN_REJECTED', 'STORAGE_UNAVAILABLE'];
const permission = (value: unknown): boolean => typeof value === 'string' && (permissions as readonly string[]).includes(value);
function securityEvent(row: RecordValue): boolean {
  return securityKeys(row, ['id', 'at', 'category', 'code', 'userRef', 'sessionRef', 'subjectRef', 'permission'])
    && securityOpaque(row.id) && utcTimestamp(row.at) && securityCategories.includes(row.category as string) && securityCodes.includes(row.code as string)
    && ['userRef', 'sessionRef', 'subjectRef'].every(key => row[key] === null || securityOpaque(row[key])) && (row.permission === null || permission(row.permission));
}
function authenticatedAction(row: RecordValue): boolean {
  return securityKeys(row, ['id', 'actorId', 'identityRevision', 'sessionRef', 'permission', 'resourceKind', 'resourceId', 'resourceVersion', 'at'])
    && ['id', 'actorId', 'sessionRef'].every(key => securityOpaque(row[key])) && positiveInteger(row.identityRevision) && permission(row.permission)
    && ['STORY', 'DRAFT', 'EDITION', 'SCHEDULE', 'RUN', 'IDENTITY', 'SESSION', 'SOURCE'].includes(row.resourceKind as string) && text(row.resourceId, 256)
    && (row.resourceVersion === null || positiveInteger(row.resourceVersion)) && utcTimestamp(row.at);
}
function securityRows(value: unknown, maximum: number, valid: (row: RecordValue) => boolean): value is RecordValue[] {
  return securityList(value, maximum) && value.every(row => record(row) && valid(row));
}
function securityHistory(identities: RecordValue[], sessions: RecordValue[], events: RecordValue[], actions: RecordValue[]): boolean {
  if ([identities, sessions, events, actions].some(rows => new Set(rows.map(row => row.id)).size !== rows.length)) return false;
  if (new Set(identities.map(row => JSON.stringify([(row.provider as RecordValue).issuer, (row.provider as RecordValue).subject]))).size !== identities.length || new Set(sessions.map(row => row.auditRef)).size !== sessions.length) return false;
  const people = new Map(identities.map(row => [row.id, row])), references = new Map(sessions.map(row => [row.auditRef, row]));
  for (const session of sessions) {
    const owner = people.get(session.userId);
    if (owner && ((owner.provider as RecordValue).issuer !== session.issuer || (session.credentialVersion as number) > (owner.credentialVersion as number))) return false;
  }
  for (const event of events) {
    const session = references.get(event.sessionRef);
    if (session && event.userRef !== null && session.userId !== event.userRef) return false;
  }
  return actions.every(action => {
    const actor = people.get(action.actorId), session = references.get(action.sessionRef);
    return (!actor || (action.identityRevision as number) <= (actor.revision as number)) && (!session || session.userId === action.actorId);
  });
}

function orderedJSON(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedJSON);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, orderedJSON(value[key])]));
  return value;
}

function stateFromJSON(value: unknown): State {
  if (!record(value) || !baseArrays(value)) throw Error('Invalid repository format');
  if (Object.hasOwn(value, 'sourceReviews') && (value.schema !== 7 || !validSourceReviewHistory(value.sourceReviews))) throw Error('Invalid repository format');
  if (value.schema !== 7 && ['identities', 'sessions', 'securityAudit', 'authenticatedActions'].some(key => Object.hasOwn(value, key))) throw Error('Invalid repository format');
  if (![6, 7].includes(value.schema as number) && ['schedules', 'preparationRuns'].some(key => Object.hasOwn(value, key))) throw Error('Invalid repository format');
  if (![5, 6, 7].includes(value.schema as number) && ['editions', 'editionReviews'].some(key => Object.hasOwn(value, key))) throw Error('Invalid repository format');
  if (![4, 5, 6, 7].includes(value.schema as number) && ['drafts', 'draftReviews'].some(key => Object.hasOwn(value, key))) throw Error('Invalid repository format');
  if (value.schema === 1) {
    if (['managedSources', 'quarantine', 'provenanceDecisions', 'deletions', 'retentionReviewRequired'].some(key => Object.hasOwn(value, key))) throw Error('Invalid repository format');
    // Legacy assertions remain history, never an implicit rights or provenance approval.
    return { ...emptyState(), retentionReviewRequired: true, sources: value.sources, revisions: value.revisions, approvals: value.approvals, audit: value.audit } as State;
  }
  if (![2, 3, 4, 5, 6, 7].includes(value.schema as number) || !rows(value.managedSources, managedSource) || !rows(value.quarantine, quarantinedSource) || !rows(value.provenanceDecisions, provenanceDecision) || !rows(value.deletions, deletion)) throw Error('Invalid repository format');
  if (value.schema === 2) {
    if (Object.hasOwn(value, 'retentionReviewRequired')) throw Error('Invalid repository format');
    // Earlier deletion may have erased all linkage; require an explicit retention review.
    return { ...value, schema: 7, retentionReviewRequired: true, drafts: [], draftReviews: [], editions: [], editionReviews: [], schedules: [], preparationRuns: [], identities: [], sessions: [], securityAudit: [], authenticatedActions: [] } as unknown as State;
  }
  if (typeof value.retentionReviewRequired !== 'boolean') throw Error('Invalid repository format');
  if (value.schema === 3) return { ...value, schema: 7, drafts: [], draftReviews: [], editions: [], editionReviews: [], schedules: [], preparationRuns: [], identities: [], sessions: [], securityAudit: [], authenticatedActions: [] } as unknown as State;
  if (!rows(value.drafts, draft) || !rows(value.draftReviews, draftReview)) throw Error('Invalid repository format');
  if (value.schema === 4) return { ...value, schema: 7, editions: [], editionReviews: [], schedules: [], preparationRuns: [], identities: [], sessions: [], securityAudit: [], authenticatedActions: [] } as unknown as State;
  if (!rows(value.editions, edition) || !rows(value.editionReviews, editionReview) || !editionHistory(value.editions, value.editionReviews)) throw Error('Invalid repository format');
  if (value.schema === 5) return { ...value, schema: 7, schedules: [], preparationRuns: [], identities: [], sessions: [], securityAudit: [], authenticatedActions: [] } as unknown as State;
  if (!rows(value.schedules, schedule) || !rows(value.preparationRuns, preparationRun) || !schedulingHistory(value.schedules, value.preparationRuns, value.editions)) throw Error('Invalid repository format');
  if (value.schema === 6) return { ...value, schema: 7, identities: [], sessions: [], securityAudit: [], authenticatedActions: [] } as unknown as State;
  if (!securityRows(value.identities, 128, identityRecord) || !securityRows(value.sessions, 512, sessionRecord) || !securityRows(value.securityAudit, 512, securityEvent) || !securityRows(value.authenticatedActions, 512, authenticatedAction) || !securityHistory(value.identities, value.sessions, value.securityAudit, value.authenticatedActions)) throw Error('Invalid repository format');
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
  /** Fresh read and synchronous disclosure share the same lock as repository mutations. No records are written. */
  async readGuarded<T>(read: (state: State) => T): Promise<T> {
    if (typeof read !== 'function' || read.constructor.name === 'AsyncFunction') throw Error('Repository read guard must be synchronous');
    await mkdir(dirname(this.file), { recursive: true });
    const lock = await this.acquireLock();
    try {
      const result = read(await this.read());
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).catch(() => undefined);
        throw Error('Repository read guard must be synchronous');
      }
      return structuredClone(result);
    } finally {
      try { await rm(lock, { recursive: true, force: true }); }
      catch { process.emitWarning('Repository cleanup failed; inspect local lock and temporary files', { code: 'DAYLINE_REPOSITORY_CLEANUP' }); }
    }
  }
  async transact<T>(change: (state: State) => T): Promise<T> {
    return this.transactInternal(change);
  }
  /** The synchronous guard must throw on denial; it runs under the lock just before replacement. */
  async transactGuarded<T>(change: (state: State) => T, guard: (state: State) => void): Promise<T> {
    if (typeof guard !== 'function') throw Error('Repository commit guard is required');
    return this.transactInternal(change, guard);
  }
  private async acquireLock(): Promise<string> {
    const lock = this.file + '.lock';
    let locked = false;
    for (let i = 0; i < 200; i++) {
      try { await mkdir(lock); locked = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    if (!locked) throw Error('Repository is locked; inspect before recovery');
    return lock;
  }
  private async transactInternal<T>(change: (state: State) => T, guard?: (state: State) => void): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true });
    const lock = await this.acquireLock();
    const temp = join(dirname(this.file), `.${basename(this.file)}.${randomUUID()}.tmp`);
    try {
      const state = await this.read();
      const result = change(state);
      // A result that cannot be returned must fail before any data is committed.
      const clonedResult = structuredClone(result);
      if (state.schema !== 7) throw Error('Invalid repository format');
      stateFromJSON(state);
      const serialized = JSON.stringify(orderedJSON(state));
      // Validate the actual JSON representation as well as the in-memory state.
      stateFromJSON(JSON.parse(serialized));
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
      this.beforeCommit?.();
      if (guard) {
        const decision: unknown = guard(state);
        if (decision !== undefined) {
          // Consume a mistaken async guard's rejection without ever awaiting or committing it.
          void Promise.resolve(decision).catch(() => undefined);
          throw Error('Repository commit guard must be synchronous and return no value');
        }
      }
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
