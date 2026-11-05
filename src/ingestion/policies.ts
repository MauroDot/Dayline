import type { RightsPolicy } from './types.ts';

export interface RegistryPolicy extends RightsPolicy {
  providerId: string;
  version: number;
  reviewStatus: 'APPROVED' | 'REVOKED' | 'SUPERSEDED' | 'PENDING';
  effectiveAt: string;
  expiresAt: string;
  evidenceReference: string;
  quarantineMetadata: boolean;
  minimalAudit: boolean;
  auditRetentionDays: number;
}

export type PolicyStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'SUPERSEDED' | 'UNKNOWN';

const booleanFields = Object.freeze([
  'discoveryMetadata', 'licensedExcerpt', 'licensedFullText', 'media', 'internalAnalysis',
  'publicRedistribution', 'aiSummarization', 'aiNarration', 'deletionRequired',
  'quarantineMetadata', 'minimalAudit',
] as const);

const snapshotFields = Object.freeze([
  'id', 'providerId', 'version', 'effectiveAt', 'expiresAt', 'evidenceReference',
  'retentionDays', 'auditRetentionDays', ...booleanFields,
] as const);

// These policies apply exclusively to invented fixture metadata. They document
// test permissions, not licenses or approval for a real news provider.
function fictionalPolicy(id: string, changes: Partial<RegistryPolicy> = {}): RegistryPolicy {
  return {
    id, providerId: 'fictional-fixture', version: 1, reviewStatus: 'APPROVED',
    effectiveAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
    evidenceReference: `fictional-fixture-only:${id}`,
    discoveryMetadata: true, licensedExcerpt: false, licensedFullText: false,
    media: false, internalAnalysis: false, publicRedistribution: false,
    aiSummarization: false, aiNarration: false, retentionDays: 1, deletionRequired: true,
    quarantineMetadata: true, minimalAudit: true, auditRetentionDays: 1,
    ...changes,
  };
}

// Every value is a primitive; freezing each record and the containing array
// deeply freezes the entire private registry. No caller can register policies.
const registry: readonly Readonly<RegistryPolicy>[] = Object.freeze([
  fictionalPolicy('fictional-metadata-v1'),
  fictionalPolicy('fictional-discard-v1', { quarantineMetadata: false }),
  fictionalPolicy('fictional-no-audit-v1', { minimalAudit: false, auditRetentionDays: 0 }),
  fictionalPolicy('fictional-expired-v1', { expiresAt: '2026-01-02T00:00:00.000Z' }),
  fictionalPolicy('fictional-revoked-v1', { reviewStatus: 'REVOKED' }),
  fictionalPolicy('fictional-superseded-v1', { reviewStatus: 'SUPERSEDED' }),
  fictionalPolicy('fictional-pending-v1', { reviewStatus: 'PENDING' }),
  fictionalPolicy('fictional-no-evidence-v1', { evidenceReference: '' }),
  fictionalPolicy('fictional-metadata-v2', { version: 2, publicRedistribution: true }),
].map(policy => Object.freeze(policy)));

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}

function complete(policy: RegistryPolicy): boolean {
  if (!policy || typeof policy !== 'object') return false;
  const effective = timestamp(policy.effectiveAt);
  const expiry = timestamp(policy.expiresAt);
  return typeof policy.id === 'string' && Boolean(policy.id.trim())
    && policy.providerId === 'fictional-fixture'
    && Number.isSafeInteger(policy.version) && policy.version > 0
    && ['APPROVED', 'REVOKED', 'SUPERSEDED', 'PENDING'].includes(policy.reviewStatus)
    && effective !== undefined && expiry !== undefined && effective < expiry
    && typeof policy.evidenceReference === 'string' && Boolean(policy.evidenceReference.trim())
    && Number.isSafeInteger(policy.retentionDays) && policy.retentionDays > 0
    && booleanFields.every(key => typeof policy[key] === 'boolean')
    && Number.isSafeInteger(policy.auditRetentionDays)
    && Number.isSafeInteger(policy.auditRetentionDays * 86400000)
    && (policy.minimalAudit ? policy.auditRetentionDays > 0 : policy.auditRetentionDays === 0)
    && policy.discoveryMetadata;
}

/** Resolve only centrally registered, currently approved fictional permissions. */
export function getPolicy(providerId: string, policyId: string, at: string): RegistryPolicy {
  if (typeof providerId !== 'string' || typeof policyId !== 'string') {
    throw new Error('Registered provider and policy identifiers are required');
  }
  const policy = registry.find(entry => entry.providerId === providerId && entry.id === policyId);
  if (!policy || policyStatus({ ...policy }, at) !== 'ACTIVE') {
    throw new Error('No active approved registry policy for this provider and policy');
  }
  return { ...policy };
}

/** Recheck an exact persisted snapshot without upgrading its captured rights. */
export function policyStatus(snapshot: RegistryPolicy, at: string): PolicyStatus {
  const now = timestamp(at);
  if (now === undefined || !complete(snapshot)) return 'UNKNOWN';
  const policy = registry.find(entry => entry.providerId === snapshot.providerId
    && entry.id === snapshot.id && entry.version === snapshot.version);
  if (!policy || !complete(policy)
    || snapshotFields.some(key => snapshot[key] !== policy[key])) return 'UNKNOWN';
  if (policy.reviewStatus === 'REVOKED') return 'REVOKED';
  if (policy.reviewStatus === 'SUPERSEDED') return 'SUPERSEDED';
  if (policy.reviewStatus !== 'APPROVED' || snapshot.reviewStatus !== 'APPROVED') return 'UNKNOWN';
  if (now < Date.parse(policy.effectiveAt)) return 'UNKNOWN';
  if (now >= Date.parse(policy.expiresAt)) return 'EXPIRED';
  return 'ACTIVE';
}
