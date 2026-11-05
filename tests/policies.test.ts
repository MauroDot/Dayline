import test from 'node:test';
import assert from 'node:assert/strict';
import { getPolicy, policyStatus, type RegistryPolicy } from '../src/ingestion/policies.ts';

const provider = 'fictional-fixture';
const now = '2026-11-04T12:00:00.000Z';
const active = () => getPolicy(provider, 'fictional-metadata-v1', now);

test('registry resolves complete fictional metadata permissions with no real-provider rights', () => {
  const policy = active();
  assert.equal(policy.providerId, provider);
  assert.equal(policy.id, 'fictional-metadata-v1');
  assert.equal(policy.version, 1);
  assert.equal(policy.reviewStatus, 'APPROVED');
  assert.equal(policy.retentionDays, 1);
  assert.equal(policy.deletionRequired, true);
  assert.equal(policy.discoveryMetadata, true);
  assert.equal(policy.quarantineMetadata, true);
  assert.equal(policy.minimalAudit, true);
  assert.equal(policy.auditRetentionDays, 1);
  for (const field of ['licensedExcerpt', 'licensedFullText', 'media', 'internalAnalysis',
    'publicRedistribution', 'aiSummarization', 'aiNarration'] as const) assert.equal(policy[field], false);
  assert.match(policy.evidenceReference, /^fictional-fixture-only:/);
  assert.equal(policyStatus(policy, now), 'ACTIVE');
  assert.throws(() => getPolicy('gnews', policy.id, now), /registry policy/);
  assert.throws(() => getPolicy('unregistered-provider', policy.id, now), /registry policy/);
});

test('registry returns independent copies and cannot be changed through returned policy objects', () => {
  const first = active();
  const second = active();
  assert.notEqual(first, second);
  first.publicRedistribution = true;
  first.retentionDays = 3650;
  first.auditRetentionDays = 3650;
  first.providerId = 'gnews';
  assert.equal(policyStatus(first, now), 'UNKNOWN');
  assert.deepEqual(active(), second);
});

test('lookup rejects caller supplied policy objects and unknown identifiers', () => {
  const forged = { ...active(), publicRedistribution: true, aiNarration: true };
  assert.throws(() => getPolicy(provider, forged as unknown as string, now), /identifiers/);
  assert.throws(() => getPolicy(forged as unknown as string, 'fictional-metadata-v1', now), /identifiers/);
  assert.throws(() => getPolicy(provider, 'caller-authorized-policy', now), /registry policy/);
  assert.throws(() => getPolicy(provider, '__proto__', now), /registry policy/);
  assert.throws(() => getPolicy(provider, 'fictional-metadata-v1', 'invalid date'), /registry policy/);
});

test('approval lookup fails closed for expiry, revoked, superseded, pending, and missing evidence', () => {
  for (const id of ['fictional-expired-v1', 'fictional-revoked-v1', 'fictional-superseded-v1',
    'fictional-pending-v1', 'fictional-no-evidence-v1']) {
    assert.throws(() => getPolicy(provider, id, now), /registry policy/, id);
  }
});

test('policy approval is effective at its start and expires exactly at its boundary', () => {
  const start = '2026-01-01T00:00:00.000Z';
  const expiry = '2027-01-01T00:00:00.000Z';
  assert.throws(() => getPolicy(provider, 'fictional-metadata-v1', '2025-12-31T23:59:59.999Z'));
  assert.equal(policyStatus(getPolicy(provider, 'fictional-metadata-v1', start), start), 'ACTIVE');
  assert.equal(policyStatus(active(), '2026-12-31T23:59:59.999Z'), 'ACTIVE');
  assert.equal(policyStatus(active(), expiry), 'EXPIRED');
  assert.throws(() => getPolicy(provider, 'fictional-metadata-v1', expiry));
  const expired = getPolicy(provider, 'fictional-expired-v1', start);
  assert.equal(policyStatus(expired, now), 'EXPIRED');
});

test('current registry revocation and supersession are visible for matching snapshots', () => {
  const snapshot = active();
  for (const [id, status] of [
    ['fictional-revoked-v1', 'REVOKED'], ['fictional-superseded-v1', 'SUPERSEDED'],
  ] as const) {
    const captured = { ...snapshot, id, evidenceReference: `fictional-fixture-only:${id}` };
    assert.equal(policyStatus(captured, now), status);
    assert.throws(() => getPolicy(provider, id, now));
  }
});

test('modified snapshot versions, rights, evidence, and required fields fail closed', () => {
  const snapshot = active();
  const changes: Partial<RegistryPolicy>[] = [
    { version: 2 }, { publicRedistribution: true }, { aiSummarization: true },
    { quarantineMetadata: false }, { minimalAudit: false }, { discoveryMetadata: false },
    { retentionDays: 2 }, { retentionDays: Number.NaN }, { evidenceReference: '' },
    { evidenceReference: 'caller-provided-approval' }, { reviewStatus: 'PENDING' },
    { effectiveAt: '2025-01-01T00:00:00.000Z' }, { expiresAt: '2030-01-01T00:00:00.000Z' },
  ];
  for (const change of changes) assert.equal(policyStatus({ ...snapshot, ...change }, now), 'UNKNOWN');
  assert.equal(policyStatus(null as unknown as RegistryPolicy, now), 'UNKNOWN');
  assert.equal(policyStatus({} as RegistryPolicy, now), 'UNKNOWN');
  assert.equal(policyStatus(snapshot, 'invalid date'), 'UNKNOWN');
});

test('a newer fictional approval does not grant permissions retroactively to captured snapshots', () => {
  const original = active();
  const newer = getPolicy(provider, 'fictional-metadata-v2', now);
  assert.equal(newer.version, 2);
  assert.equal(newer.publicRedistribution, true);
  assert.equal(policyStatus(original, now), 'ACTIVE');
  assert.equal(original.version, 1);
  assert.equal(original.publicRedistribution, false);
  assert.equal(policyStatus({ ...original, id: newer.id, version: newer.version }, now), 'UNKNOWN');
});

test('the discard fixture explicitly prohibits retaining quarantine metadata', () => {
  const discard = getPolicy(provider, 'fictional-discard-v1', now);
  assert.equal(discard.quarantineMetadata, false);
  assert.equal(discard.minimalAudit, true);
  assert.equal(discard.auditRetentionDays, 1);
  assert.equal(discard.publicRedistribution, false);
  assert.equal(policyStatus(discard, now), 'ACTIVE');
});

test('audit retention is an explicit finite bounded grant that snapshots cannot extend', () => {
  const policy = active();
  assert.equal(policy.auditRetentionDays, 1);
  assert.equal(Number.isSafeInteger(policy.auditRetentionDays * 86400000), true);
  for (const auditRetentionDays of [0, -1, 0.5, 2, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.equal(policyStatus({ ...policy, auditRetentionDays }, now), 'UNKNOWN');
  }
  assert.equal(active().auditRetentionDays, 1);
});

test('the approved fictional no-audit fixture grants metadata retention without identifying audit retention', () => {
  const policy = getPolicy(provider, 'fictional-no-audit-v1', now);
  assert.equal(policy.reviewStatus, 'APPROVED');
  assert.equal(policy.providerId, provider);
  assert.equal(policy.quarantineMetadata, true);
  assert.equal(policy.minimalAudit, false);
  assert.equal(policy.auditRetentionDays, 0);
  assert.equal(policy.publicRedistribution, false);
  assert.equal(policyStatus(policy, now), 'ACTIVE');
  assert.equal(policyStatus({ ...policy, auditRetentionDays: 1 }, now), 'UNKNOWN');
  assert.equal(policyStatus({ ...policy, minimalAudit: true }, now), 'UNKNOWN');
  assert.throws(() => getPolicy('gnews', policy.id, now), /registry policy/);
});

test('historical snapshots without an audit retention grant fail closed rather than inheriting new rights', () => {
  const { auditRetentionDays: _, ...legacy } = active();
  assert.equal(policyStatus(legacy as RegistryPolicy, now), 'UNKNOWN');
  assert.equal(policyStatus({ ...active(), auditRetentionDays: undefined } as unknown as RegistryPolicy, now), 'UNKNOWN');
  assert.equal(policyStatus(active(), now), 'ACTIVE');
});
