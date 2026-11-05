import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRetention } from '../src/ingestion/retention.ts';
import { getPolicy, type RegistryPolicy } from '../src/ingestion/policies.ts';
import type { ManagedSource } from '../src/ingestion/records.ts';
import { emptyState, type Source, type State, type Story } from '../src/newsroom/model.ts';
import { JsonRepository } from '../src/newsroom/store.ts';

const retainedAt = '2026-01-01T00:00:00.000Z';
const deleteAt = '2026-01-02T00:00:00.000Z';
const policy = () => getPolicy('fictional-fixture', 'fictional-metadata-v1', retainedAt);
const id = (name: string) => `url-${createHash('sha256').update(name).digest('hex')}`;

function source(name = 'origin'): Source {
  return { id: id(name), publisher: `Fictional ${name}`, url: `https://fiction.example.test/${name}`,
    canonicalUrl: `https://fiction.example.test/${name}`, type: 'ORIGINAL', publishedAt: retainedAt,
    retrievedAt: retainedAt, originId: id(name), rights: 'Fictional fixture metadata only', verification: 'UNVERIFIED' };
}

function managed(name = 'origin', changes: Partial<ManagedSource> = {}): ManagedSource {
  const article = source(name);
  const capturedAt = changes.retainedAt ?? retainedAt;
  const record = { sourceId: article.id, providerId: 'fictional-fixture', policy: policy(), retainedAt, deleteAt,
    providerProvenance: { type: 'ORIGINAL' as const, originId: null },
    providerMetadata: { url: article.url, publisher: article.publisher, publishedAt: article.publishedAt, retrievedAt: capturedAt },
    ...changes };
  return record;
}

async function fixture(run: (repository: JsonRepository, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-retention-'));
  try { await run(new JsonRepository(join(directory, 'fictional.json')), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function seed(repository: JsonRepository, partial: Partial<State> = {}): Promise<void> {
  await repository.transact(state => { Object.assign(state, emptyState(), {
    sources: [source()], managedSources: [managed()], ...partial,
  }); });
}

test('retention dry run only reads and leaves even a missing repository absent', async () => {
  await fixture(async (repository, directory) => {
    assert.deepEqual(await cleanupRetention(repository, deleteAt), { candidates: 0, deleted: 0 });
    assert.deepEqual(await readdir(directory), []);
    await seed(repository);
    const before = await readFile(repository.file, 'utf8');
    assert.deepEqual(await cleanupRetention(repository, deleteAt), { candidates: 1, deleted: 0 });
    assert.equal(await readFile(repository.file, 'utf8'), before);
    assert.deepEqual(await readdir(directory), ['fictional.json']);
  });
});

test('retention rejects invalid or host-dependent cleanup dates before reading or writing', async () => {
  await fixture(async repository => {
    let reads = 0;
    repository.read = async () => { reads++; return emptyState(); };
    for (const at of ['', 'not-a-date', '2026-01-02', '2026-02-30T00:00:00Z', '2026-01-02T00:00:00']) {
      await assert.rejects(cleanupRetention(repository, at, false), /valid UTC ISO timestamp/);
    }
    assert.equal(reads, 0);
  });
});

test('retention expires at the exact deadline and repeated cleanup is idempotent', async () => {
  await fixture(async repository => {
    await seed(repository);
    assert.deepEqual(await cleanupRetention(repository, '2026-01-01T23:59:59.999Z'), { candidates: 0, deleted: 0 });
    assert.deepEqual(await cleanupRetention(repository, deleteAt, false), { candidates: 1, deleted: 1 });
    const state = await repository.read();
    assert.deepEqual(state.sources, []); assert.deepEqual(state.managedSources, []);
    assert.deepEqual(state.deletions, [{ sourceId: id('origin'), at: deleteAt, reason: 'RETENTION_EXPIRED', expiresAt: '2026-01-03T00:00:00.000Z' }]);
    assert.equal(state.audit.length, 1);
    assert.deepEqual(Object.keys(state.audit[0]).sort(), ['id', 'storyId', 'action', 'actor', 'at', 'version', 'subjectId'].sort());
    assert.equal(state.audit[0].action, 'RETENTION_DELETED');
    assert.equal(state.audit[0].subjectId, id('origin'));
    assert.deepEqual(await cleanupRetention(repository, deleteAt, false), { candidates: 0, deleted: 0 });
    assert.deepEqual(await repository.read(), state);
  });
});

test('a tampered deleteAt cannot extend the captured policy retention duration', async () => {
  await fixture(async repository => {
    await seed(repository, { managedSources: [managed('origin', { deleteAt: '2026-12-31T00:00:00Z' })] });
    assert.deepEqual(await cleanupRetention(repository, deleteAt, false), { candidates: 1, deleted: 1 });
  });
});

test('a later retainedAt cannot extend the original retrieval retention deadline', async () => {
  await fixture(async repository => {
    const original = managed();
    await seed(repository, { managedSources: [managed('origin', {
      retainedAt: '2026-01-01T12:00:00Z', deleteAt: '2026-01-02T12:00:00Z',
      providerMetadata: original.providerMetadata,
    })] });
    assert.deepEqual(await cleanupRetention(repository, deleteAt, false), { candidates: 1, deleted: 1 });
    assert.equal((await repository.read()).deletions[0].reason, 'RETENTION_EXPIRED');
  });
});

test('invalid retrieval timestamps and retrieval after retention capture fail closed', async () => {
  await fixture(async repository => {
    for (const retrievedAt of ['not-a-date', '2026-02-30T00:00:00Z', '2026-01-01T02:00:00Z']) {
      const original = managed();
      await seed(repository, { managedSources: [managed('origin', {
        providerMetadata: { ...original.providerMetadata, retrievedAt },
      })] });
      assert.deepEqual(await cleanupRetention(repository, '2026-01-01T01:00:00Z', false), { candidates: 1, deleted: 1 });
      assert.equal((await repository.read()).deletions[0].reason, 'INVALID_RETENTION');
    }
  });
});

test('the governing policy expiry ends retention even when the requested deadline is later', async () => {
  await fixture(async repository => {
    const historical = getPolicy('fictional-fixture', 'fictional-expired-v1', retainedAt);
    await seed(repository, { managedSources: [managed('origin', { policy: historical,
      retainedAt: '2026-01-01T12:00:00Z', deleteAt: '2026-01-03T00:00:00Z' })] });
    assert.deepEqual(await cleanupRetention(repository, deleteAt, false), { candidates: 1, deleted: 1 });
    assert.equal((await repository.read()).deletions[0].reason, 'POLICY_EXPIRED');
  });
});

test('revoked and superseded exact historical policy snapshots permit minimal deletion audit', async () => {
  await fixture(async repository => {
    for (const [policyId, expected] of [['fictional-revoked-v1', 'REVOKED'], ['fictional-superseded-v1', 'SUPERSEDED']] as const) {
      const historical: RegistryPolicy = { ...policy(), id: policyId, evidenceReference: `fictional-fixture-only:${policyId}` };
      await seed(repository, { managedSources: [managed('origin', { policy: historical })] });
      assert.deepEqual(await cleanupRetention(repository, '2026-01-01T01:00:00Z', false), { candidates: 1, deleted: 1 });
      assert.equal((await repository.read()).deletions[0].reason, `POLICY_${expected}`);
    }
  });
});

test('unknown policy snapshots cannot authorize residual identity even when minimalAudit is asserted', async () => {
  await fixture(async repository => {
    for (const unknown of [{ ...policy(), id: 'unregistered-policy' },
      { ...policy(), publicRedistribution: true }, { ...policy(), evidenceReference: '' }]) {
      assert.equal(unknown.minimalAudit, true);
      await seed(repository, { managedSources: [managed('origin', { policy: unknown })], audit: [{
        id: 'linked', storyId: null, action: 'INGESTION_ACCEPTED', actor: 'fictional assertion',
        at: retainedAt, version: null, subjectId: id('origin'),
      }] });
      assert.deepEqual(await cleanupRetention(repository, '2026-01-01T01:00:00Z', false), { candidates: 1, deleted: 1 });
      const state = await repository.read();
      assert.deepEqual(state.sources, []); assert.deepEqual(state.managedSources, []);
      assert.deepEqual(state.audit, []); assert.deepEqual(state.deletions, []);
      assert.doesNotMatch(JSON.stringify(state), new RegExp(id('origin')));
    }
  });
});

test('malformed stored retention dates fail closed instead of extending retention', async () => {
  await fixture(async repository => {
    for (const changes of [{ deleteAt: 'not-a-date' }, { retainedAt: '2026-02-30T00:00:00Z' },
      { policy: { ...policy(), expiresAt: 'not-a-date' } }]) {
      await seed(repository, { managedSources: [managed('origin', changes)] });
      assert.deepEqual(await cleanupRetention(repository, '2026-01-01T01:00:00Z', false), { candidates: 1, deleted: 1 });
      const state = await repository.read();
      if (changes.policy) assert.deepEqual(state.deletions, []);
      else assert.equal(state.deletions[0].reason, 'INVALID_RETENTION');
    }
  });
});

test('quarantined metadata is deleted with its policy snapshot and provider assertions', async () => {
  await fixture(async repository => {
    const article = source();
    await seed(repository, { sources: [], managedSources: [], quarantine: [{ ...managed(), metadata: {
      url: article.url, publisher: article.publisher, publishedAt: article.publishedAt, retrievedAt: article.retrievedAt,
    } }] });
    assert.deepEqual(await cleanupRetention(repository, deleteAt, false), { candidates: 1, deleted: 1 });
    const state = await repository.read();
    assert.deepEqual(state.quarantine, []);
    assert.doesNotMatch(JSON.stringify(state), /fiction\.example|Fictional origin|fictional-metadata-v1|providerProvenance/);
  });
});

test('linked provenance and actor assertions are removed while unrelated audit remains', async () => {
  await fixture(async repository => {
    const linked = { id: 'linked-audit', storyId: null, action: 'PROVENANCE_RESOLVED', actor: 'private-actor-assertion',
      at: retainedAt, version: null, subjectId: id('origin') };
    const unrelated = { ...linked, id: 'unrelated-audit', actor: 'unrelated actor', subjectId: id('unrelated') };
    const stillRetained = { ...source('unrelated'), retrievedAt: '2026-01-01T12:00:00Z' };
    const unrelatedGrant = managed('unrelated', { retainedAt: stillRetained.retrievedAt, deleteAt: '2026-01-02T12:00:00Z', providerMetadata: { url: stillRetained.url, publisher: stillRetained.publisher, publishedAt: stillRetained.publishedAt, retrievedAt: stillRetained.retrievedAt } });
    await seed(repository, { sources: [source(), stillRetained], managedSources: [managed(), unrelatedGrant], audit: [linked, unrelated], provenanceDecisions: [
      { id: 'decision-source', sourceId: id('origin'), classification: 'ORIGINAL', originId: null,
        actorAssertion: 'private-actor-assertion', at: retainedAt, evidenceReferences: ['private-evidence'], reason: 'private-reason' },
      { id: 'decision-origin', sourceId: id('copy'), classification: 'SYNDICATED', originId: id('origin'),
        actorAssertion: 'private-actor-assertion', at: retainedAt, evidenceReferences: ['private-evidence'], reason: 'private-reason' },
    ] });
    await cleanupRetention(repository, deleteAt, false);
    const state = await repository.read();
    assert.deepEqual(state.provenanceDecisions, []);
    assert.deepEqual(state.audit.find(event => event.id === 'unrelated-audit'), unrelated);
    assert.equal(state.audit.length, 2);
    assert.doesNotMatch(JSON.stringify(state), /private-actor-assertion|private-evidence|private-reason|Fictional origin|fiction\.example\.test\/origin/);
    assert.deepEqual(state.sources, [stillRetained]);
  });
});

test('a snapshot forbidding minimal audit leaves no tombstone or linked identity', async () => {
  await fixture(async repository => {
    await seed(repository, { managedSources: [managed('origin', { policy: { ...policy(), minimalAudit: false } })],
      audit: [{ id: 'linked', storyId: null, action: 'INGESTION_ACCEPTED', actor: 'fixture assertion', at: retainedAt, version: null, subjectId: id('origin') }] });
    assert.deepEqual(await cleanupRetention(repository, deleteAt, false), { candidates: 1, deleted: 1 });
    const state = await repository.read();
    assert.deepEqual(state.audit, []); assert.deepEqual(state.deletions, []);
    assert.doesNotMatch(JSON.stringify(state), new RegExp(id('origin')));
    assert.deepEqual(await cleanupRetention(repository, deleteAt, false), { candidates: 0, deleted: 0 });
  });
});

test('removing an origin cascades through managed syndicated copies without orphaned metadata', async () => {
  await fixture(async repository => {
    const origin = source();
    const copy = { ...source('copy'), type: 'SYNDICATED' as const, originId: origin.id };
    const later = { retainedAt: '2026-01-01T12:00:00Z', deleteAt: '2026-01-02T12:00:00Z' };
    await seed(repository, { sources: [origin, copy], managedSources: [managed(), managed('copy', {
      ...later, providerProvenance: { type: 'SYNDICATED', originId: origin.id },
    })] });
    assert.deepEqual(await cleanupRetention(repository, deleteAt, false), { candidates: 2, deleted: 2 });
    const state = await repository.read();
    assert.deepEqual(state.sources, []); assert.deepEqual(state.managedSources, []);
    assert.equal(state.deletions.find(marker => marker.sourceId === copy.id)?.reason, 'ORIGIN_REMOVED');
  });
});

test('provider syndication assertions do not override a resolved original during retention cleanup', async () => {
  await fixture(async repository => {
    const resolved = source('resolved-original');
    await seed(repository, { sources: [source(), resolved], managedSources: [managed(), managed('resolved-original', {
      retainedAt: '2026-01-01T12:00:00Z', deleteAt: '2026-01-02T12:00:00Z',
      providerProvenance: { type: 'SYNDICATED', originId: id('origin') },
    })] });
    assert.deepEqual(await cleanupRetention(repository, deleteAt, false), { candidates: 1, deleted: 1 });
    const state = await repository.read();
    assert.deepEqual(state.sources, [resolved]);
    assert.deepEqual(state.managedSources.map(record => record.sourceId), [resolved.id]);
  });
});

test('retention redacts source-linked history explicitly while preserving approval existence and unrelated sources', async () => {
  await fixture(async repository => {
    const revision: Story = { id: 'fictional-story', headline: 'Fictional fixture headline', topic: 'fixture', summary: 'Fictional summary',
      geography: 'fixture', eventAt: null, firstSeenAt: retainedAt, updatedAt: retainedAt, clusterId: null,
      evidence: [{ id: 'evidence', claim: 'Fictional claim', support: [id('origin')], contradict: [], verification: 'UNVERIFIED', uncertainty: 'fixture', reviewerDecisions: [] }],
      sourceIds: [id('origin')], status: 'APPROVED', version: 1 };
    const approval = { storyId: revision.id, version: 1, reviewer: 'fictional reviewer', at: retainedAt };
    const unrelated = source('unrelated');
    await seed(repository, { sources: [source(), unrelated], revisions: [revision], approvals: [approval] });
    await cleanupRetention(repository, deleteAt, false);
    const state = await repository.read();
    assert.equal(state.revisions.length, 1); assert.equal(state.approvals.length, 1);
    const retained = state.revisions[0], retainedApproval = state.approvals[0];
    assert.notEqual(retained.id, revision.id); assert.equal(retained.retentionRedacted, true);
    assert.equal(retained.status, revision.status); assert.equal(retained.version, revision.version);
    assert.deepEqual(retained.evidence, []); assert.deepEqual(retained.sourceIds, []);
    assert.equal(retainedApproval.storyId, retained.id); assert.equal(retainedApproval.version, approval.version);
    assert.equal(retainedApproval.retentionRedacted, true); assert.notEqual(retainedApproval.reviewer, approval.reviewer);
    assert.doesNotMatch(JSON.stringify(retained), /Fictional fixture headline|Fictional summary|Fictional claim/);
    assert.equal(state.retentionReviewRequired, true);
    assert.deepEqual(state.sources, [unrelated]);
  });
});

test('failed retention commit preserves metadata, audit, and deletion state atomically', async () => {
  await fixture(async repository => {
    await seed(repository, { audit: [{ id: 'original-audit', storyId: null, action: 'INGESTION_ACCEPTED',
      actor: 'fictional assertion', at: retainedAt, version: null, subjectId: id('origin') }] });
    const before = await readFile(repository.file, 'utf8');
    const failing = new JsonRepository(repository.file, { beforeCommit: () => { throw new Error('injected commit failure'); } });
    await assert.rejects(cleanupRetention(failing, deleteAt, false), /injected commit failure/);
    assert.equal(await readFile(repository.file, 'utf8'), before);
    assert.deepEqual(await cleanupRetention(repository, deleteAt, false), { candidates: 1, deleted: 1 });
  });
});
