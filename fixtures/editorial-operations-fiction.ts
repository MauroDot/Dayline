/** Trusted disposable acceptance harness. All content, accounts and rights are fictional. */
import { mkdtemp, rm, access as fileAccess } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonRepository } from '../src/newsroom/store.ts';
import { Newsroom } from '../src/newsroom/service.ts';
import { EditionService } from '../src/editions/service.ts';
import { ingestArticles, sourceId } from '../src/ingestion/ingest.ts';
import { AccessControl } from '../src/security/service.ts';
import { AssignedResourcePolicy, type ResourceAssignment, type ResourcePolicy } from '../src/security/resources.ts';
import { AuthenticatedSourceQueue } from '../src/security/source.ts';
import { AuthenticatedSourceReview } from '../src/security/source-review.ts';
import { AuthenticatedSourceHandoff } from '../src/security/source-handoff.ts';
import { AuthenticatedEditorial } from '../src/security/editorial.ts';
import { startInternalEditorialHTTP } from '../src/security/http.ts';
import { seedEditorialWorkflowFixture, editorialWorkflowAt } from './editorial-workflow-fiction.ts';

export const operationsRoles = ['editor', 'managing', 'confirming', 'reporter', 'admin'] as const;
export type OperationsRole = typeof operationsRoles[number];
export const operationsLabels: Record<OperationsRole, string> = {
  editor: 'Editor', managing: 'Managing editor', confirming: 'Independent managing editor',
  reporter: 'Reporter', admin: 'Administrator',
};
export const existingOperationsStoryId = 'fictional-operations-existing';

/** No request or production process may supply assignments, clocks or repositories to this fixture. */
export async function seedEditorialOperationsFixture(repository: JsonRepository) {
  const seeded = await seedEditorialWorkflowFixture(repository);
  // Additional explicitly assigned fictional records exercise real bounded pagination.
  const additionalArticles = ['garden', 'library', 'park'].map(name => ({ providerId: 'fictional-fixture',
    url: `https://editorial-operations.example.test/${name}`, publisher: `Fictional operations ${name} report`,
    publishedAt: editorialWorkflowAt, retrievedAt: editorialWorkflowAt,
    provenance: { type: 'ORIGINAL' as const, originId: null } }));
  await ingestArticles(repository, additionalArticles, { providerId: 'fictional-fixture', policyId: 'fictional-ai-editorial-v1' },
    { dryRun: false, clock: () => editorialWorkflowAt,
      resolutions: additionalArticles.map(article => ({ sourceId: sourceId(article.url), classification: 'ORIGINAL', originId: null,
        actorAssertion: 'fictional-operations-bootstrap', at: editorialWorkflowAt,
        evidenceReferences: ['fictional-proof:invented-record'], reason: 'Invented original provenance evidence' })) });
  const sourceIds = { ...seeded.sourceIds, alternate: sourceId(additionalArticles[0].url) };
  let at = editorialWorkflowAt;
  const clock = {
    now: () => at,
    advance(ms: number) {
      if (!Number.isSafeInteger(ms) || ms < 0 || ms > 86_400_000) throw Error('Invalid fictional clock');
      at = new Date(Date.parse(at) + ms).toISOString();
      return at;
    },
  };
  const access = new AccessControl(repository, { verifier: seeded.verifier, clock: clock.now });
  let assignments = structuredClone(seeded.assignments);
  for (const account of Object.values(seeded.accounts)) for (const article of additionalArticles) {
    for (const permission of ['SOURCE_READ', 'SOURCE_REVIEW', 'SOURCE_RESOLVE', 'SOURCE_HOLD', 'SOURCE_RELEASE'] as const) {
      assignments.push({ identityId: account.identity.id, kind: 'SOURCE', id: sourceId(article.url), permission });
    }
  }
  let assigned = new AssignedResourcePolicy(assignments);
  const policy: ResourcePolicy = {
    authorize: (...args) => assigned.authorize(...args),
    sourceReadRevision: () => assigned.sourceReadRevision(),
  };
  function replaceAssignments(rows: readonly ResourceAssignment[]) {
    const next = new AssignedResourcePolicy(rows);
    assignments = structuredClone([...rows]); assigned = next;
  }
  const sourceQueue = new AuthenticatedSourceQueue(repository, access, { resourcePolicy: policy });
  const sourceReview = new AuthenticatedSourceReview(repository, access, { resourcePolicy: policy });
  const sourceHandoff = new AuthenticatedSourceHandoff(repository, access, { resourcePolicy: policy });
  const editorial = new AuthenticatedEditorial(repository, access, { resourcePolicy: policy });
  async function resolve(source: 'pending' | 'disputed' | 'alternate') {
    const id = sourceIds[source], evidenceReferences = [seeded.sourceIds.proof];
    const initial = await sourceReview.inspect(seeded.accounts.managing.credential, id);
    const begun = await sourceReview.begin(seeded.accounts.managing.credential, id,
      { revision: initial.revision, reasonCode: 'INITIAL_REVIEW', evidenceReferences });
    const proposed = await sourceReview.propose(seeded.accounts.managing.credential, id,
      { revision: begun.revision, reasonCode: source === 'disputed' ? 'CONTRADICTORY_EVIDENCE' : 'EVIDENCE_SUPPORTED',
        evidenceReferences, classification: source === 'disputed' ? 'DISPUTED' : source === 'alternate' ? 'ORIGINAL' : 'SECONDARY', originId: null });
    return sourceReview.confirm(seeded.accounts.confirming.credential, id,
      { revision: proposed.revision, reasonCode: 'EVIDENCE_SUPPORTED', evidenceReferences });
  }
  // A separate trusted seed demonstrates existing visible state without consuming the human creation ID.
  const newsroom = new Newsroom(repository, { clock: clock.now });
  await newsroom.create({ ...structuredClone(seeded.humanStory), id: existingOperationsStoryId,
    headline: 'A clearly fictional existing garden story', summary: 'Invented seed content for viewing existing editorial state.',
    sourceIds: [seeded.sourceIds.proof], evidence: seeded.humanStory.evidence.map(row => ({ ...structuredClone(row),
      support: [seeded.sourceIds.proof] })) }, 'fictional-operations-bootstrap');
  let existingStory;
  for (const status of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW', 'APPROVED'] as const) {
    existingStory = await newsroom.transition(existingOperationsStoryId, status, 'fictional-operations-bootstrap');
  }
  if (!existingStory) throw Error('Fictional state unavailable');
  const existingEdition = await new EditionService(repository, { clock: clock.now }).create({
    date: '2026-06-02', timezone: 'UTC', placements: [{ storyId: existingOperationsStoryId,
      storyVersion: existingStory.version, section: 'TOP_STORIES', featured: true }],
  }, 'fictional-operations-bootstrap');
  for (const account of Object.values(seeded.accounts)) {
    for (const permission of ['STORY_EDIT', 'STORY_REVIEW', 'STORY_APPROVE', 'EDITION_ASSEMBLE', 'EDITION_REVIEW', 'EDITION_READY'] as const) {
      assignments.push({ identityId: account.identity.id, kind: 'STORY', id: existingOperationsStoryId, permission });
    }
    for (const permission of ['EDITION_ASSEMBLE', 'EDITION_REVIEW', 'EDITION_READY'] as const) {
      assignments.push({ identityId: account.identity.id, kind: 'EDITION', id: existingEdition.id, permission });
    }
  }
  replaceAssignments(assignments);
  await resolve('disputed');
  await resolve('alternate');
  async function hold(source: 'pending' | 'proof' | 'disputed', release = false) {
    const id = seeded.sourceIds[source];
    const current = await sourceReview.inspect(seeded.accounts.managing.credential, id);
    const input = { revision: current.revision, reasonCode: release ? 'HOLD_RELEASED' : 'REVIEW_HOLD',
      evidenceReferences: [seeded.sourceIds.proof] };
    return release ? sourceReview.release(seeded.accounts.managing.credential, id, input)
      : sourceReview.hold(seeded.accounts.managing.credential, id, input);
  }
  return { ...seeded, repository, sourceIds, access, clock, policy, resourcePolicy: policy, sourceQueue, sourceReview, sourceHandoff, editorial,
    existingStoryId: existingOperationsStoryId, existingEditionId: existingEdition.id,
    humanStory: structuredClone(seeded.humanStory), storyTemplate: structuredClone(seeded.humanStory),
    getAssignments: () => structuredClone(assignments), replaceAssignments, resolvePending: () => resolve('pending'),
    resolveDisputed: () => resolve('disputed'), hold,
    clearAssignments(role: OperationsRole) { replaceAssignments(assignments.filter(row => row.identityId !== seeded.accounts[role].identity.id)); },
    revoke: (role: OperationsRole) => access.invalidateSession(seeded.accounts[role].credential),
    expire: (source: 'pending' | 'proof' | 'disputed') => repository.transact(state => {
      const row = [...state.managedSources, ...state.quarantine].find(row => row.sourceId === seeded.sourceIds[source]);
      if (!row) throw Error('Fictional state unavailable'); row.deleteAt = clock.now();
    }),
  };
}

/** Owns only a newly created temporary fictional repository; never accepts an external path. */
export async function createFictionalOperationsEnvironment() {
  if (['staging', 'production'].includes(process.env.NODE_ENV ?? '')) throw Error('Fictional operations unavailable');
  const directory = await mkdtemp(join(tmpdir(), 'dayline-fictional-operations-'));
  let server: Awaited<ReturnType<typeof startInternalEditorialHTTP>> = null;
  let closed = false;
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const fixture = await seedEditorialOperationsFixture(repository);
    server = await startInternalEditorialHTTP({ enabled: true, mode: 'development', operationsUI: true,
      repository, access: fixture.access, policy: fixture.policy });
    if (!server) throw Error('Fictional listener unavailable');
    const origin = server.origin;
    return { directory, repository, fixture, origin,
      /** This private bootstrap must travel over an anonymous pipe only, never normal logs. */
      bootstrap: () => ({ type: 'bootstrap', fictional: true, developmentOnly: true, origin, asOf: fixture.clock.now(),
        accounts: Object.fromEntries(operationsRoles.map(role => [role,
          { label: operationsLabels[role], credential: fixture.accounts[role].credential }])),
        sourceIds: fixture.sourceIds, storyId: fixture.humanStory.id,
        existingStoryId: fixture.existingStoryId, existingEditionId: fixture.existingEditionId }),
      async close() {
        if (!closed) { closed = true; try { await server?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
        try { await fileAccess(directory); return false; } catch { return true; }
      },
    };
  } catch {
    try { await server?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    throw Error('Fictional operations unavailable');
  }
}
