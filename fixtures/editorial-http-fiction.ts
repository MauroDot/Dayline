/** Explicit temporary development harness; never invoked by the public server or a credential endpoint. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { JsonRepository } from '../src/newsroom/store.ts';
import type { Story } from '../src/newsroom/model.ts';
import { EditionService } from '../src/editions/service.ts';
import { SchedulerService } from '../src/scheduling/service.ts';
import { AccessControl } from '../src/security/service.ts';
import { configureIdentityVerifier } from '../src/security/provider.ts';
import { AssignedResourcePolicy, editionSlot, type ResourceAssignment } from '../src/security/resources.ts';
import { permissionMatrix } from '../src/security/policy.ts';
import { SecurityError, SyntheticSessionVerifier, sessionTimestamp } from '../src/security/verifier.ts';
import type { IdentityRecord, Role, VerifiedSessionClaims } from '../src/security/types.ts';
import { seedEditionFixture, editionAt } from './edition-fiction.ts';

export interface EditorialHttpFixtureOptions { enabled?: boolean; mode?: string; clock?: () => string }
export interface HttpFixtureAccount { identity: IdentityRecord; claims: VerifiedSessionClaims; credential: string }

export async function createEditorialHttpFixture(options: EditorialHttpFixtureOptions = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Reflect.ownKeys(options).some(key => typeof key !== 'string' || !['enabled', 'mode', 'clock'].includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(options)).some(value => !Object.hasOwn(value, 'value'))
    || options.enabled !== true || options.mode !== 'development' || process.env.NODE_ENV === 'production'
    || (options.clock !== undefined && typeof options.clock !== 'function')) throw new SecurityError('PERMISSION_DENIED');
  // Advance a fictional epoch with monotonic elapsed time so manual fixtures still expire.
  // Deterministic tests may explicitly inject their own clock.
  const started = performance.now();
  const clock = options.clock ?? (() => new Date(Date.parse(editionAt) + Math.floor(performance.now() - started)).toISOString());
  const at = new Date(sessionTimestamp(clock())).toISOString();
  const verifier = new SyntheticSessionVerifier({ keyId: 'http-fixture-key' }); // fresh private random key per harness
  const provider = configureIdentityVerifier({ enabled: true, mode: 'development', provider: 'synthetic', verifier });
  const directory = await mkdtemp(join(tmpdir(), 'dayline-editorial-http-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const access = new AccessControl(repository, { verifier: provider, clock });
    function account(role: Role): HttpFixtureAccount {
      const identity: IdentityRecord = { id: randomUUID(), status: 'ACTIVE', roles: [role],
        provider: { issuer: verifier.issuer, subject: randomUUID() }, revision: 1, credentialVersion: 1,
        credentialsRotatedAt: null, createdAt: at, updatedAt: at };
      const claims: VerifiedSessionClaims = { issuer: verifier.issuer, audience: verifier.audience,
        subject: identity.provider.subject, sessionId: randomUUID(), keyId: 'http-fixture-key', credentialVersion: 1,
        authenticatedAt: at, notBefore: at, expiresAt: new Date(Date.parse(at) + verifier.maxSessionMs).toISOString() };
      return { identity, claims, credential: verifier.issue(claims) };
    }
    const accounts = { reporter: account('REPORTER'), editor: account('EDITOR'), managing: account('MANAGING_EDITOR'), admin: account('ADMINISTRATOR') };
    // This trusted fixture bootstrap has no HTTP entry point and writes only into this new temporary repository.
    await repository.transact(state => { state.identities.push(...Object.values(accounts).map(value => structuredClone(value.identity))); });
    for (const value of Object.values(accounts)) await access.registerSession(value.credential);
    const minute = new Date(Math.floor(Date.parse(at) / 60_000) * 60_000).toISOString();
    const schedule = await new SchedulerService(repository, { clock: () => minute }).create({ name: 'Fictional HTTP preparation',
      timezone: 'UTC', localTime: at.slice(11,16), weekdays: [0,1,2,3,4,5,6], enabled: true });
    const scheduling = await new SchedulerService(repository, { clock }).evaluate({ dryRun: false });
    const run = scheduling.runs[0];
    if (!run) throw new SecurityError('DOMAIN_REJECTED');
    const seed = await seedEditionFixture(repository, at);
    const { status: _status, version: _version, ...template } = seed.story;
    const proposed: Omit<Story, 'status' | 'version'> = { ...structuredClone(template), id: 'fictional-http-proposed' };
    async function secondary(id: string, approve = false) {
      await seed.newsroom.create({ ...structuredClone(template), id }, 'fictional-http-bootstrap');
      await seed.newsroom.transition(id, 'CLUSTERED', 'fictional-http-bootstrap');
      await seed.newsroom.transition(id, 'DRAFT', 'fictional-http-bootstrap');
      const review = await seed.newsroom.transition(id, 'NEEDS_REVIEW', 'fictional-http-bootstrap');
      return approve ? seed.newsroom.transition(id, 'APPROVED', 'fictional-http-bootstrap') : review;
    }
    const review = await secondary('fictional-http-review');
    const unassigned = await secondary('fictional-http-unassigned', true);
    const stories = { approved: seed.story, review, unassigned, proposed };
    const date = at.slice(0,10);
    const nextDate = new Date(Date.parse(date) + 86_400_000).toISOString().slice(0,10);
    const placements = [{ storyId: seed.story.id, storyVersion: seed.story.version, section: 'TOP_STORIES' as const, featured: true }];
    const edition = await new EditionService(repository, { clock }).create({ date, timezone: 'UTC', placements }, 'fictional-http-bootstrap');
    const editionInput = { date: nextDate, timezone: 'UTC', placements: structuredClone(placements) };
    const assignments: ResourceAssignment[] = [];
    for (const value of Object.values(accounts)) {
      for (const permission of permissionMatrix[value.identity.roles[0]]) {
        if (permission.startsWith('STORY_') || permission.startsWith('EDITION_')) {
          for (const id of [stories.approved.id, stories.review.id, stories.proposed.id]) assignments.push({ identityId: value.identity.id, permission, kind: 'STORY', id });
        }
        if (permission.startsWith('EDITION_')) assignments.push({ identityId: value.identity.id, permission, kind: 'EDITION', id: edition.id });
        if (permission === 'EDITION_ASSEMBLE') assignments.push({ identityId: value.identity.id, permission, kind: 'EDITION', id: editionSlot(nextDate, 'UTC') });
        if (permission === 'SCHEDULE_CONFIGURE' || permission === 'SCHEDULE_EXECUTE') assignments.push({ identityId: value.identity.id, permission, kind: 'SCHEDULE', id: schedule.id });
        if (permission === 'SCHEDULE_EXECUTE') assignments.push({ identityId: value.identity.id, permission, kind: 'RUN', id: run.id });
      }
    }
    return { directory, repository, access, verifier, provider, accounts, policy: new AssignedResourcePolicy(assignments),
      stories, edition, editionInput, schedule: scheduling.schedules[0], run,
      async dispose() { await rm(directory, { recursive: true, force: true }); },
    };
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new SecurityError('DOMAIN_REJECTED');
  }
}
