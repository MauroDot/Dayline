import { resolve } from 'node:path';
import { JsonRepository } from '../newsroom/store.ts';
import { Newsroom } from '../newsroom/service.ts';
import type { State, Story } from '../newsroom/model.ts';
import { EditorialService } from '../editorial/service.ts';
import { invalidateDrafts } from '../editorial/lifecycle.ts';
import type { DraftStatus } from '../editorial/types.ts';
import { EditionService } from '../editions/service.ts';
import { invalidateEditions } from '../editions/lifecycle.ts';
import type { EditionStatus, PlacementInput } from '../editions/types.ts';
import { SchedulerService } from '../scheduling/service.ts';
import type { ScheduleDefinition } from '../scheduling/types.ts';
import type { AccessControl } from './service.ts';
import type { Permission, Principal, ResourceKind, SecurityCode } from './types.ts';
import { SecurityError } from './verifier.ts';
import { assertResourcePolicy, editionSlot, scheduleRevision, runRevision, type ResourcePolicy, type ResourceTarget } from './resources.ts';
import { assertStorySourceHandoff, sourceHandoffValidUntil, storySourceHandoffTargets, SourceHandoffError } from '../source-handoff/domain.ts';
import { sourceReviewRevision } from '../source-review/domain.ts';
import { sessionTimestamp } from './verifier.ts';

interface Resource { kind: ResourceKind; id: string; version: number | null }
interface Operation {
  permission: Permission;
  targets?: (state: State) => ResourceTarget[];
  scopeCheck?: (state: State) => void;
  check?: (state: State) => void;
  resources: (result: unknown) => Resource[];
  /** Integrated stories additionally require exact current SOURCE_READ authority. */
  sourceStories?: (state: State) => Story[];
}
type Result<T> = { value: T } | { denied: SecurityCode };

function code(error: unknown, fallback: SecurityCode): SecurityCode {
  const value: unknown = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  if (error instanceof SourceHandoffError && typeof value === 'string') return value === 'STALE_SOURCE' ? 'STALE_TARGET' : 'DOMAIN_REJECTED';
  return error instanceof SecurityError && typeof value === 'string' ? new SecurityError(value as SecurityCode).code : fallback;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function payload(value: unknown): unknown {
  if (!object(value)) return value;
  if (value.error !== undefined) {
    throw new SecurityError(typeof value.error === 'string' && /STALE|REVISION_MISMATCH/.test(value.error) ? 'STALE_TARGET' : 'DOMAIN_REJECTED');
  }
  if (Object.hasOwn(value, 'proposal')) return value.proposal;
  return Object.hasOwn(value, 'value') ? value.value : value;
}
function target(kind: ResourceKind): (result: unknown) => Resource[] {
  return result => {
    const value = payload(result);
    if (!object(value) || typeof value.id !== 'string') throw new SecurityError('DOMAIN_REJECTED');
    const version = kind === 'STORY' || kind === 'DRAFT' ? value.version : kind === 'EDITION' ? value.revision : null;
    if (version !== null && (!Number.isSafeInteger(version) || (version as number) < 1)) throw new SecurityError('DOMAIN_REJECTED');
    return [{ kind, id: value.id, version: version as number | null }];
  };
}
function expected(kind: 'STORY' | 'DRAFT' | 'EDITION', id: string, version: number, allowInvalidated = false): (state: State) => void {
  return state => {
    if (typeof id !== 'string' || !id.trim() || !Number.isSafeInteger(version) || version < 1) throw new SecurityError('STALE_TARGET');
    const row = kind === 'STORY' ? state.revisions.filter(story => story.id === id).at(-1)
      : kind === 'DRAFT' ? state.drafts.find(draft => draft.id === id)
        : state.editions.filter(edition => edition.id === id).at(-1);
    if (!row || (!allowInvalidated && 'status' in row && row.status === 'INVALIDATED')) throw new SecurityError('DOMAIN_REJECTED');
    const actual = 'revision' in row ? row.revision : 'version' in row ? row.version : undefined;
    if (actual !== version) throw new SecurityError('STALE_TARGET');
  };
}

function exactInput(value: unknown, keys: string[]): value is Record<string, unknown> {
  return object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === keys.length
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every(key => key === 'length' || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value'))
    && value.every(item => typeof item === 'string');
}
function validateStoryInput(input: unknown): void {
  if (!exactInput(input, ['id', 'headline', 'topic', 'summary', 'geography', 'eventAt', 'firstSeenAt', 'updatedAt', 'clusterId', 'evidence', 'sourceIds'])
    || !strings(input.sourceIds) || !Array.isArray(input.evidence)) throw new SecurityError('DOMAIN_REJECTED');
  const entries = input.evidence;
  if (Object.getPrototypeOf(entries) !== Array.prototype || Reflect.ownKeys(entries).length !== entries.length + 1
    || !Reflect.ownKeys(entries).every(key => key === 'length' || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < entries.length))
    || !Object.values(Object.getOwnPropertyDescriptors(entries)).every(descriptor => Object.hasOwn(descriptor, 'value'))
    || !entries.every(evidence => exactInput(evidence, ['id', 'claim', 'support', 'contradict', 'verification', 'uncertainty', 'reviewerDecisions'])
      && strings(evidence.support) && strings(evidence.contradict) && strings(evidence.reviewerDecisions))) throw new SecurityError('DOMAIN_REJECTED');
}

function placementTargets(placements: PlacementInput[]): ResourceTarget[] {
  if (!Array.isArray(placements) || placements.length > 100 || placements.some(row => !row || typeof row.storyId !== 'string')) throw new SecurityError('DOMAIN_REJECTED');
  return placements.map(row => ({ kind: 'STORY', id: row.storyId }));
}
function editionTargets(state: State, id: string): ResourceTarget[] {
  const edition = state.editions.filter(row => row.id === id).at(-1);
  return [{ kind: 'EDITION', id }, ...(edition && edition.status !== 'INVALIDATED'
    ? edition.sections.flatMap(section => section.placements.map(row => ({ kind: 'STORY' as const, id: row.storyId }))) : [])];
}

function latestStories(state: State, ids: readonly string[]): Story[] {
  return [...new Set(ids)].flatMap(id => { const row = state.revisions.filter(story => story.id === id).at(-1); return row ? [row] : []; });
}
function editionStories(state: State, id: string): Story[] {
  const edition = state.editions.filter(row => row.id === id).at(-1);
  return edition && edition.status !== 'INVALIDATED' ? latestStories(state, edition.sections.flatMap(section => section.placements.map(row => row.storyId))) : [];
}
function sourceEpoch(policy: ResourcePolicy): string {
  try {
    if (typeof policy.sourceReadRevision !== 'function') throw Error();
    const value: unknown = policy.sourceReadRevision();
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
      if (value && (typeof value === 'object' || typeof value === 'function')) void Promise.resolve(value).catch(() => undefined);
      throw Error();
    }
    return value;
  } catch { throw new SecurityError('PERMISSION_DENIED'); }
}
/** New C-reviewed sources cannot use older unbound creation/edit paths as a handoff bypass. */
function prohibitUnboundReviewedSources(state: State, ids: readonly string[]): void {
  if (ids.some(id => state.sourceReviews?.some(review => review.sourceId === id)
    || (state.retentionReviewRequired && state.managedSources.some(source => source.sourceId === id)))) throw new SecurityError('DOMAIN_REJECTED');
}

/** Private repository adapter: legacy domain callbacks never receive an unauthenticated transaction. */
class GuardedRepository extends JsonRepository {
  failure: SecurityCode | null = null;
  private readonly base: JsonRepository;
  private readonly access: AccessControl;
  private readonly credential: unknown;
  private readonly operation: Operation;
  private readonly resourcePolicy?: ResourcePolicy;
  constructor(base: JsonRepository, access: AccessControl, credential: unknown, operation: Operation, resourcePolicy?: ResourcePolicy) {
    super(base.file); this.base = base; this.access = access; this.credential = credential; this.operation = operation; this.resourcePolicy = resourcePolicy;
  }
  override async read(): Promise<State> { throw new SecurityError('DOMAIN_REJECTED'); }
  override async transact<T>(change: (state: State) => T): Promise<T> {
    return this.protectedTransaction(change);
  }
  private async protectedTransaction<T>(change: (state: State) => T, additionalGuard?: (state: State) => void): Promise<T> {
    const permission = this.operation.permission;
    let principal: Principal | null = null;
    let commitAuthorized = false;
    let boundTargets: ResourceTarget[] = [];
    let sourceStories: Story[] = [], sourceIds: string[] = [], sourcePolicyEpoch: string | null = null;
    let sourceRevisions = new Map<string, string>();
    let sourceCheckedAt = '', sourceCutoff: number | null = null;
    let result: Result<T>;
    try {
      result = await this.base.transactGuarded(state => {
        const at = this.access.now();
        try {
          principal = this.access.authorizeInState(state, this.credential, permission, at);
          if (this.resourcePolicy) {
            if (!this.operation.targets) throw new SecurityError('PERMISSION_DENIED');
            boundTargets = structuredClone(this.operation.targets(state));
            assertResourcePolicy(this.resourcePolicy, principal, permission, boundTargets, state);
            this.operation.scopeCheck?.(state);
          }
          const participatingStories = this.operation.sourceStories?.(state) ?? [];
          for (const story of participatingStories) if (!Object.hasOwn(story, 'sourceHandoff')) prohibitUnboundReviewedSources(state, story.sourceIds);
          sourceStories = participatingStories.filter(story => Object.hasOwn(story, 'sourceHandoff')).map(story => structuredClone(story));
          if (sourceStories.length) {
            if (!this.resourcePolicy) throw new SecurityError('PERMISSION_DENIED');
            sourcePolicyEpoch = sourceEpoch(this.resourcePolicy);
            const reader = this.access.authorizeInState(state, this.credential, 'SOURCE_READ', at);
            if (reader.identityId !== principal.identityId || reader.identityRevision !== principal.identityRevision
              || reader.sessionId !== principal.sessionId || reader.sessionRef !== principal.sessionRef) throw new SecurityError('PERMISSION_DENIED');
            for (const story of sourceStories) assertStorySourceHandoff(state, story, at);
            sourceIds = [...new Set(sourceStories.flatMap(story => storySourceHandoffTargets(state, story)))].sort();
            if (!sourceIds.length || sourceIds.length > 64) throw new SecurityError('PERMISSION_DENIED');
            assertResourcePolicy(this.resourcePolicy, reader, 'SOURCE_READ', sourceIds.map(id => ({ kind: 'SOURCE', id })), state);
            if (sourceEpoch(this.resourcePolicy) !== sourcePolicyEpoch) throw new SecurityError('PERMISSION_DENIED');
            sourceRevisions = new Map(sourceIds.map(id => [id, sourceReviewRevision(state, id)]));
            sourceCheckedAt = at;
            const cutoffs = sourceStories.map(story => sourceHandoffValidUntil(state, story.sourceHandoff!.selected.map(source => source.id), at)).filter((value): value is number => value !== null);
            sourceCutoff = cutoffs.length ? Math.min(...cutoffs) : null;
          }
          // Only authenticated callers may trigger these known retention scrubs.
          // Keep them even when the requested domain mutation is rejected.
          commitAuthorized = true;
          invalidateDrafts(state, at);
          invalidateEditions(state, at);
          this.operation.check?.(state);
          const candidate = structuredClone(state);
          const value = change(candidate);
          const resources = this.operation.resources(value);
          for (const resource of resources) this.access.action(candidate, principal, permission, resource.kind, resource.id, resource.version, at);
          if (!resources.length) this.access.record(candidate, { category: 'PROTECTED_ACTION', code: 'SUCCESS', userRef: principal.identityId,
            sessionRef: principal.sessionRef, subjectRef: null, permission }, at);
          Object.assign(state, candidate);
          return { value };
        } catch (error) {
          const denied = code(error, 'DOMAIN_REJECTED');
          this.access.record(state, { category: ['INVALID_CREDENTIAL', 'INVALID_SESSION', 'SESSION_EXPIRED', 'SESSION_FUTURE', 'SESSION_REVOKED'].includes(denied) ? 'AUTH_FAILURE' : 'AUTHZ_DENIED',
            code: denied, userRef: principal?.identityId ?? null, sessionRef: principal?.sessionRef ?? null, subjectRef: null, permission }, at);
          return { denied };
        }
      }, state => {
        if (!commitAuthorized || !principal) return;
        const final = this.access.authorizeInState(state, this.credential, permission, this.access.now());
        if (final.identityId !== principal.identityId || final.identityRevision !== principal.identityRevision
          || final.sessionRef !== principal.sessionRef || final.sessionId !== principal.sessionId) throw new SecurityError('PERMISSION_DENIED');
        if (this.resourcePolicy) assertResourcePolicy(this.resourcePolicy, final, permission, boundTargets, state);
        if (sourceStories.length) {
          if (!this.resourcePolicy || sourcePolicyEpoch === null) throw new SecurityError('PERMISSION_DENIED');
          const at = this.access.now(), reader = this.access.authorizeInState(state, this.credential, 'SOURCE_READ', at);
          if (reader.identityId !== principal.identityId || reader.identityRevision !== principal.identityRevision
            || reader.sessionId !== principal.sessionId || reader.sessionRef !== principal.sessionRef) throw new SecurityError('PERMISSION_DENIED');
          const ids = [...new Set(sourceStories.flatMap(story => storySourceHandoffTargets(state, story)))].sort();
          if (JSON.stringify(ids) !== JSON.stringify(sourceIds)) throw new SecurityError('STALE_TARGET');
          assertResourcePolicy(this.resourcePolicy, reader, 'SOURCE_READ', ids.map(id => ({ kind: 'SOURCE', id })), state);
          for (const story of sourceStories) assertStorySourceHandoff(state, story, at);
          for (const id of ids) if (sourceReviewRevision(state, id) !== sourceRevisions.get(id)) throw new SecurityError('STALE_TARGET');
          if (additionalGuard) {
            const decision: unknown = additionalGuard(state);
            if (decision !== undefined) { void Promise.resolve(decision).catch(() => undefined); throw new SecurityError('DOMAIN_REJECTED'); }
          }
          const current = this.access.authorizeInState(state, this.credential, permission, this.access.now());
          const currentReader = this.access.authorizeInState(state, this.credential, 'SOURCE_READ', this.access.now());
          if (current.identityId !== principal.identityId || current.identityRevision !== principal.identityRevision
            || current.sessionId !== principal.sessionId || current.sessionRef !== principal.sessionRef
            || currentReader.identityId !== principal.identityId || currentReader.identityRevision !== principal.identityRevision
            || currentReader.sessionId !== principal.sessionId || currentReader.sessionRef !== principal.sessionRef
            || sourceEpoch(this.resourcePolicy) !== sourcePolicyEpoch) throw new SecurityError('PERMISSION_DENIED');
          const now = sessionTimestamp(this.access.now()), session = state.sessions.find(row => row.id === principal!.sessionId);
          if (!session || now >= sessionTimestamp(session.expiresAt)) throw new SecurityError('SESSION_EXPIRED');
          if (now < sessionTimestamp(sourceCheckedAt) || (sourceCutoff !== null && now >= sourceCutoff)) throw new SecurityError('STALE_TARGET');
          return;
        }
        return additionalGuard?.(state);
      });
    } catch (error) {
      this.failure = code(error, 'STORAGE_UNAVAILABLE');
      try { await this.access.recordFailure(error, principal, permission); } catch {}
      throw new SecurityError(this.failure);
    }
    if ('denied' in result) { this.failure = result.denied; throw new SecurityError(result.denied); }
    return result.value;
  }
  override async transactGuarded<T>(change: (state: State) => T, guard: (state: State) => void): Promise<T> {
    return this.protectedTransaction(change, guard);
  }
}

/** Internal authenticated commands. This facade has no publishing or public HTTP operation. */
export class AuthenticatedEditorial {
  private readonly repository: JsonRepository;
  private readonly access: AccessControl;
  private readonly resourcePolicy?: ResourcePolicy;
  constructor(repository: JsonRepository, access: AccessControl, options: { resourcePolicy?: ResourcePolicy } = {}) {
    if (resolve(repository.file) !== access.repositoryFile) throw new SecurityError('STORAGE_UNAVAILABLE');
    if (Object.hasOwn(options, 'resourcePolicy') && (!options.resourcePolicy || typeof options.resourcePolicy.authorize !== 'function')) throw new SecurityError('PERMISSION_DENIED');
    this.repository = repository; this.access = access; this.resourcePolicy = options.resourcePolicy;
  }
  private protected(credential: unknown, operation: Operation): GuardedRepository {
    return new GuardedRepository(this.repository, this.access, credential, operation, this.resourcePolicy);
  }
  private clock = () => this.access.now();
  private input<T>(value: T): T { return this.resourcePolicy ? structuredClone(value) : value; }

  async createStory(credential: unknown, story: Omit<Story, 'status' | 'version'>) {
    story = this.input(story);
    return new Newsroom(this.protected(credential, { permission: 'STORY_CREATE', targets: () => [{ kind: 'STORY', id: story.id }], check: state => { validateStoryInput(story); prohibitUnboundReviewedSources(state, story.sourceIds); }, resources: target('STORY') }), { clock: this.clock }).create(story, 'authenticated-action');
  }
  async editStory(credential: unknown, id: string, version: number, patch: Parameters<Newsroom['edit']>[1]) {
    patch = this.input(patch);
    const check = expected('STORY', id, version);
    return new Newsroom(this.protected(credential, { permission: 'STORY_EDIT', targets: () => [{ kind: 'STORY', id }], check: state => {
      check(state); const prior = latestStories(state, [id])[0];
      if (!prior?.sourceHandoff) prohibitUnboundReviewedSources(state, patch.sourceIds ?? prior.sourceIds);
    }, sourceStories: state => latestStories(state, [id]), resources: target('STORY') }), { clock: this.clock }).edit(id, patch, 'authenticated-action');
  }
  async approveStory(credential: unknown, id: string, version: number) {
    return new Newsroom(this.protected(credential, { permission: 'STORY_APPROVE', targets: () => [{ kind: 'STORY', id }], check: expected('STORY', id, version), sourceStories: state => latestStories(state, [id]), resources: target('STORY') }), { clock: this.clock }).transition(id, 'APPROVED', 'authenticated-action');
  }
  async reviewStory(credential: unknown, id: string, version: number, next: Story['status']) {
    const check = expected('STORY', id, version);
    return new Newsroom(this.protected(credential, { permission: 'STORY_REVIEW', targets: () => [{ kind: 'STORY', id }], check: state => {
      check(state);
      if (!['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW', 'ON_HOLD', 'REJECTED', 'CORRECTION_REQUIRED'].includes(next)) throw new SecurityError('DOMAIN_REJECTED');
    }, sourceStories: state => latestStories(state, [id]), resources: target('STORY') }), { clock: this.clock }).transition(id, next, 'authenticated-action');
  }
  async reviewDraft(credential: unknown, id: string, version: number, next: DraftStatus) {
    const permission = next === 'READY_FOR_APPROVAL' ? 'DRAFT_READY' : 'DRAFT_REVIEW';
    return new EditorialService(this.protected(credential, { permission, targets: () => [{ kind: 'DRAFT', id }], check: expected('DRAFT', id, version), sourceStories: state => {
      const draft = state.drafts.find(row => row.id === id); return draft && draft.status !== 'INVALIDATED' ? latestStories(state, [draft.storyId]) : [];
    }, resources: target('DRAFT') }), { clock: this.clock }).review(id, version, next, 'authenticated-action');
  }
  async assembleEdition(credential: unknown, input: Parameters<EditionService['create']>[0]) {
    input = this.input(input);
    return new EditionService(this.protected(credential, { permission: 'EDITION_ASSEMBLE', targets: () => [{ kind: 'EDITION', id: editionSlot(input.date, input.timezone) }, ...placementTargets(input.placements)], sourceStories: state => latestStories(state, input.placements.map(row => row.storyId)), resources: target('EDITION') }), { clock: this.clock }).create(input, 'authenticated-action');
  }
  async editEdition(credential: unknown, id: string, revision: number, placements: PlacementInput[]) {
    placements = this.input(placements);
    return new EditionService(this.protected(credential, { permission: 'EDITION_ASSEMBLE', targets: () => [{ kind: 'EDITION', id }, ...placementTargets(placements)], check: expected('EDITION', id, revision, true), sourceStories: state => [...editionStories(state, id), ...latestStories(state, placements.map(row => row.storyId))], resources: target('EDITION') }), { clock: this.clock }).edit(id, revision, placements, 'authenticated-action');
  }
  async reviewEdition(credential: unknown, id: string, revision: number, next: EditionStatus) {
    const permission = next === 'READY_FOR_APPROVAL' ? 'EDITION_READY' : 'EDITION_REVIEW';
    return new EditionService(this.protected(credential, { permission, targets: state => editionTargets(state, id), check: expected('EDITION', id, revision), sourceStories: state => editionStories(state, id), resources: target('EDITION') }), { clock: this.clock }).review(id, revision, next, 'authenticated-action');
  }
  private async scheduler<T>(credential: unknown, permission: Permission, resources: Operation['resources'], work: (service: SchedulerService) => Promise<T>, scope?: Pick<Operation, 'targets' | 'scopeCheck' | 'sourceStories'>): Promise<T> {
    const repository = this.protected(credential, { permission, resources, ...scope });
    try { return await work(new SchedulerService(repository, { clock: this.clock })); }
    catch { throw new SecurityError(repository.failure ?? 'DOMAIN_REJECTED'); }
  }
  async createSchedule(credential: unknown, definition: ScheduleDefinition) {
    return this.scheduler(credential, 'SCHEDULE_CONFIGURE', target('SCHEDULE'), service => service.create(definition));
  }
  async pauseSchedule(credential: unknown, id: string, revision?: string) {
    return this.scheduler(credential, 'SCHEDULE_CONFIGURE', target('SCHEDULE'), service => service.pause(id), {
      targets: () => [{ kind: 'SCHEDULE', id }], scopeCheck: state => {
        const schedule = state.schedules.find(row => row.id === id);
        if (!schedule || revision !== scheduleRevision(schedule)) throw new SecurityError('STALE_TARGET');
      },
    });
  }
  async resumeSchedule(credential: unknown, id: string) { return this.scheduler(credential, 'SCHEDULE_CONFIGURE', target('SCHEDULE'), service => service.resume(id)); }
  async claimRun(credential: unknown, id: string, revision?: string) {
    return this.scheduler(credential, 'SCHEDULE_EXECUTE', target('RUN'), service => service.claim(id), {
      targets: () => [{ kind: 'RUN', id }], scopeCheck: state => {
        const run = state.preparationRuns.find(row => row.id === id);
        if (!run || revision !== runRevision(run)) throw new SecurityError('STALE_TARGET');
      },
    });
  }
  async beginRun(credential: unknown, id: string, claimId: string) { return this.scheduler(credential, 'SCHEDULE_EXECUTE', target('RUN'), service => service.begin(id, claimId)); }
  async prepareRun(credential: unknown, id: string, claimId: string, placements: PlacementInput[] = []) { return this.scheduler(credential, 'SCHEDULE_EXECUTE', target('RUN'), service => service.prepare(id, claimId, placements), { sourceStories: state => latestStories(state, placements.map(row => row.storyId)) }); }
  async failRun(credential: unknown, id: string, claimId: string) { return this.scheduler(credential, 'SCHEDULE_EXECUTE', target('RUN'), service => service.fail(id, claimId)); }
  async recoverRuns(credential: unknown) {
    return this.scheduler(credential, 'SCHEDULE_EXECUTE', result => {
      const rows = payload(result);
      if (!Array.isArray(rows)) throw new SecurityError('DOMAIN_REJECTED');
      return rows.flatMap(row => target('RUN')(row));
    }, service => service.recover());
  }
  async evaluateSchedules(credential: unknown) {
    return this.scheduler(credential, 'SCHEDULE_EXECUTE', result => {
      const value = payload(result);
      if (!object(value) || !Array.isArray(value.schedules)) throw new SecurityError('DOMAIN_REJECTED');
      return value.schedules.flatMap(row => target('SCHEDULE')(row));
    }, service => service.evaluate({ dryRun: false }));
  }
}
