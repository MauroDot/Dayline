import { createHash, randomUUID } from 'node:crypto';
import type { JsonRepository } from '../newsroom/store.ts';
import type { State } from '../newsroom/model.ts';
import type { ManagedSource } from './records.ts';
import { policyStatus } from './policies.ts';

const day = 86_400_000;

/** Require a real UTC calendar timestamp, rather than a host-dependent local date. */
function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const expected = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  return new Date(parsed).toISOString() === expected ? parsed : undefined;
}

interface Candidate { reason: string; minimalAudit: boolean }

function expiryReason(record: ManagedSource, at: string, now: number): string | undefined {
  const retained = timestamp(record.retainedAt);
  const retrieved = timestamp(record.providerMetadata?.retrievedAt);
  const requested = timestamp(record.deleteAt);
  const expiry = timestamp(record.policy?.expiresAt);
  const days = record.policy?.retentionDays;
  if (retained === undefined || retrieved === undefined || requested === undefined || expiry === undefined
    || retrieved > retained
    || !Number.isSafeInteger(days) || days <= 0
    || !Number.isSafeInteger(retained + days * day)
    || !Number.isSafeInteger(retrieved + days * day)
    || record.providerId !== record.policy?.providerId) return 'INVALID_RETENTION';
  const status = policyStatus(record.policy, at);
  if (status !== 'ACTIVE') return `POLICY_${status}`;
  // Neither a modified deleteAt nor a policy lifetime can extend the captured
  // retention grant or the original retrieval deadline. The most restrictive
  // deadline governs, including when quarantined metadata is later promoted.
  if (now >= Math.min(requested, retained + days * day, retrieved + days * day, expiry)) return 'RETENTION_EXPIRED';
  return undefined;
}

function candidates(state: State, at: string, now: number): Map<string, Candidate> {
  const records = [...state.managedSources, ...state.quarantine];
  const result = new Map<string, Candidate>();
  const eligibleAudit = (id: string) => records.filter(record => record.sourceId === id)
    .every(record => record.policy?.minimalAudit === true && policyStatus(record.policy, at) !== 'UNKNOWN');
  for (const record of records) {
    const reason = expiryReason(record, at, now);
    if (reason && !result.has(record.sourceId)) {
      result.set(record.sourceId, { reason, minimalAudit: eligibleAudit(record.sourceId) });
    }
  }
  // A managed syndicated copy cannot outlive a removed origin. Iterate to also
  // handle historical chains; this never creates or rewrites editorial history.
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (result.has(record.sourceId)) continue;
      const source = state.sources.find(entry => entry.id === record.sourceId);
      // Provider provenance is an assertion, so only the newsroom's resolved
      // classification can establish the dependency that triggers a cascade.
      const origin = source?.type === 'SYNDICATED' ? source.originId : null;
      if (origin && result.has(origin)) {
        result.set(record.sourceId, { reason: 'ORIGIN_REMOVED', minimalAudit: eligibleAudit(record.sourceId) });
        changed = true;
      }
    }
  }
  return result;
}

function opaqueIdentity(sourceId: string): string {
  return /^url-[a-f0-9]{64}$/.test(sourceId) ? sourceId
    : `url-${createHash('sha256').update(sourceId).digest('hex')}`;
}

/**
 * Manual, deterministic local retention cleanup. Dry runs only read. Real runs
 * commit metadata removal and permitted minimal audit in one transaction.
 * This is logical deletion from this JSON repository, not secure erasure of
 * filesystems, backups, snapshots, or immutable editorial revision history.
 */
export async function cleanupRetention(repository: JsonRepository, at: string, dryRun = true): Promise<{ candidates: number; deleted: number }> {
  const now = timestamp(at);
  if (now === undefined) throw new Error('Retention cleanup requires a valid UTC ISO timestamp');
  if (dryRun) return { candidates: candidates(await repository.read(), at, now).size, deleted: 0 };
  return repository.transact(state => {
    const selected = candidates(state, at, now);
    if (selected.size === 0) return { candidates: 0, deleted: 0 };
    state.sources = state.sources.filter(source => !selected.has(source.id));
    state.managedSources = state.managedSources.filter(record => !selected.has(record.sourceId));
    state.quarantine = state.quarantine.filter(record => !selected.has(record.sourceId));
    state.provenanceDecisions = state.provenanceDecisions.filter(decision => !selected.has(decision.sourceId)
      && !(decision.originId && selected.has(decision.originId)));
    state.audit = state.audit.filter(event => !event.subjectId || !selected.has(event.subjectId));
    state.deletions = state.deletions.filter(marker => !selected.has(marker.sourceId));
    for (const [sourceId, candidate] of selected) {
      // No identity, provenance, URL, publisher, evidence, or asserted actor is
      // retained when the captured policy does not permit minimal audit.
      if (!candidate.minimalAudit) continue;
      const subjectId = opaqueIdentity(sourceId);
      state.audit.push({ id: randomUUID(), storyId: null, action: 'RETENTION_DELETED',
        actor: 'retention-service', at, version: null, subjectId });
      state.deletions.push({ sourceId: subjectId, at, reason: candidate.reason });
    }
    return { candidates: selected.size, deleted: selected.size };
  });
}
