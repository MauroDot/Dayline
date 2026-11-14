/** Read-only, exact-resource projections for the isolated development operations interface. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { State, Story, Status } from '../newsroom/model.ts';
import { JsonRepository } from '../newsroom/store.ts';
import { eligibleSource } from '../ingestion/eligibility.ts';
import { retentionDeadline } from '../ingestion/metadata.ts';
import { policyStatus } from '../ingestion/policies.ts';
import { buildPlacement } from '../editions/eligibility.ts';
import type { EditionRevision, EditionStatus } from '../editions/types.ts';
import { assertStorySourceHandoff, inspectHandoffSelection, sourceHandoffValidUntil, storySourceHandoffTargets } from '../source-handoff/domain.ts';
import { sourceReviewDependencyIds, sourceReviewInspectionTargets, sourceReviewSummary, sourceReviewValidUntil } from '../source-review/domain.ts';
import { latestSourceReview, reviewSourceId, sourceReviewActions } from '../source-review/types.ts';
import type { SourceReviewAction } from '../source-review/types.ts';
import { projectSourceQueue, sourceCandidateIds, sourceQueueValidUntil, SourceQueueError } from '../source-queue/service.ts';
import type { SourceQueueEntry, SourceQueueQuery } from '../source-queue/types.ts';
import { permissionMatrix } from './policy.ts';
import type { ResourcePolicy, ResourceTarget } from './resources.ts';
import type { AccessControl } from './service.ts';
import { permissions, type Permission, type Principal, type SecurityCode } from './types.ts';
import { SecurityError, sessionTimestamp } from './verifier.ts';
import type { OperationsDisclosure, OperationsEdition, OperationsEditions, OperationsLease, OperationsOverview,
  OperationsSource, OperationsSourceDetail, OperationsSources, OperationsStories, OperationsStory } from './operations-types.ts';

const maximumResponse = 262_144;
const maximumLease = 1_500;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const candidateRef = (id: string): string => 'candidate-' + createHash('sha256').update(id).digest('hex');
function stableJSON(value: unknown): string {
  const ordered = (row: unknown): unknown => Array.isArray(row) ? row.map(ordered)
    : row !== null && typeof row === 'object' ? Object.fromEntries(Object.keys(row).sort().map(key => [key, ordered((row as Record<string, unknown>)[key])])) : row;
  return JSON.stringify(ordered(value));
}
interface Authority { principal: Principal; snapshot: Readonly<State>; revision: string; context: string }
interface Projection<T> { value: T; deadline: number | null }
type Project<T> = (state: State, authority: Authority, at: string) => Projection<T>;
type Scope = { sourceIds: string[]; authorizationContext: string };

function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!Object.hasOwn(descriptor, 'value')) throw new SecurityError('PERMISSION_DENIED');
      frozen(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}
function policyRevision(policy: ResourcePolicy): string {
  if (typeof policy.sourceReadRevision !== 'function') throw new SecurityError('PERMISSION_DENIED');
  const value: unknown = policy.sourceReadRevision();
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    if (value && typeof value === 'object') void Promise.resolve(value).catch(() => undefined);
    throw new SecurityError('PERMISSION_DENIED');
  }
  return value;
}
function safeError(error: unknown): never {
  const code: unknown = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  if (error instanceof SecurityError && typeof code === 'string') throw new SecurityError(code as SecurityCode);
  if (error instanceof SourceQueueError && (code === 'INVALID_QUERY' || code === 'STALE_CURSOR' || code === 'UNAVAILABLE')) throw new SourceQueueError(code);
  throw new SecurityError('STORAGE_UNAVAILABLE');
}
function querySnapshot(query: SourceQueueQuery | undefined): SourceQueueQuery | undefined {
  if (query === undefined) return undefined;
  if (!query || typeof query !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(query))
    || Reflect.ownKeys(query).some(key => typeof key !== 'string' || !['view', 'limit', 'cursor'].includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(query)).some(row => !row.enumerable || !Object.hasOwn(row, 'value'))) throw new SourceQueueError('INVALID_QUERY');
  return Object.freeze({ ...query });
}
const storyTransitions: Readonly<Record<Status, readonly Status[]>> = {
  INGESTED: ['CLUSTERED', 'ON_HOLD', 'REJECTED'], CLUSTERED: ['DRAFT', 'ON_HOLD', 'REJECTED'],
  DRAFT: ['NEEDS_REVIEW', 'ON_HOLD', 'REJECTED'], NEEDS_REVIEW: ['DRAFT', 'ON_HOLD', 'REJECTED'],
  APPROVED: ['DRAFT', 'ON_HOLD', 'REJECTED'], PUBLISHED: ['CORRECTION_REQUIRED'],
  CORRECTION_REQUIRED: ['DRAFT', 'ON_HOLD'], ON_HOLD: ['DRAFT', 'REJECTED'], REJECTED: [],
};
const editionTransitions: Readonly<Record<EditionStatus, readonly EditionStatus[]>> = {
  ASSEMBLING: ['NEEDS_REVIEW', 'ON_HOLD', 'REJECTED'],
  NEEDS_REVIEW: ['READY_FOR_APPROVAL', 'REVISION_REQUESTED', 'ON_HOLD', 'REJECTED'],
  READY_FOR_APPROVAL: ['REVISION_REQUESTED', 'ON_HOLD', 'REJECTED'],
  REVISION_REQUESTED: ['NEEDS_REVIEW', 'ON_HOLD', 'REJECTED'],
  ON_HOLD: ['NEEDS_REVIEW', 'REVISION_REQUESTED', 'REJECTED'], REJECTED: [], INVALIDATED: [],
};
const reviewPermission: Record<SourceReviewAction, Permission> = {
  begin: 'SOURCE_REVIEW', propose: 'SOURCE_REVIEW', confirm: 'SOURCE_RESOLVE', reject: 'SOURCE_RESOLVE',
  hold: 'SOURCE_HOLD', release: 'SOURCE_RELEASE', withdraw: 'SOURCE_REVIEW',
};

/** No audit, action receipt, grant, or domain record is created by any operation in this facade. */
export class AuthenticatedEditorialOperations {
  private readonly repository: JsonRepository;
  private readonly access: AccessControl;
  private readonly policy: ResourcePolicy;
  private readonly assertPrincipal: ((principal: Principal) => void) | undefined;
  constructor(repository: JsonRepository, access: AccessControl, options: { resourcePolicy: ResourcePolicy; assertPrincipal?: (principal: Principal) => void }) {
    if (!repository || !access || resolve(repository.file) !== access.repositoryFile) throw new SecurityError('STORAGE_UNAVAILABLE');
    if (!options?.resourcePolicy || typeof options.resourcePolicy.authorize !== 'function'
      || typeof options.resourcePolicy.sourceReadRevision !== 'function') throw new SecurityError('PERMISSION_DENIED');
    if (options.assertPrincipal !== undefined && typeof options.assertPrincipal !== 'function') throw new SecurityError('PERMISSION_DENIED');
    this.repository = repository; this.access = access; this.policy = options.resourcePolicy;
    this.assertPrincipal = options.assertPrincipal;
  }
  private authority(state: State, credential: unknown): Authority {
    const principal = this.access.authorizeInState(state, credential, null, this.access.now());
    const decision: unknown = this.assertPrincipal?.(frozen({ ...principal }));
    if (decision !== undefined) { void Promise.resolve(decision).catch(() => undefined); throw new SecurityError('PERMISSION_DENIED'); }
    const revision = policyRevision(this.policy);
    const context = hash([principal.identityId, principal.identityRevision, principal.sessionId, principal.sessionRef, revision]);
    return { principal, revision, context, snapshot: frozen(structuredClone(state)) };
  }
  private roleAllows(authority: Authority, permission: Permission): boolean {
    const identity = authority.snapshot.identities.find(row => row.id === authority.principal.identityId)!;
    return identity.roles.some(role => permissionMatrix[role].includes(permission));
  }
  /** Only an explicit synchronous resource denial filters a row. Every broken predicate denies the operation. */
  private allowed(authority: Authority, permission: Permission, targets: readonly ResourceTarget[]): boolean {
    if (!this.roleAllows(authority, permission)) return false;
    let decision: unknown;
    try { decision = this.policy.authorize(frozen({ ...authority.principal }), permission, frozen(structuredClone(targets)), authority.snapshot); }
    catch (error) {
      if (error instanceof SecurityError && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'PERMISSION_DENIED') return false;
      if (error instanceof SecurityError) throw error;
      throw new SecurityError('PERMISSION_DENIED');
    }
    if (decision !== undefined) { void Promise.resolve(decision).catch(() => undefined); throw new SecurityError('PERMISSION_DENIED'); }
    if (policyRevision(this.policy) !== authority.revision) throw new SecurityError('PERMISSION_DENIED');
    return true;
  }
  private readSources(authority: Authority, ids: readonly string[]): boolean {
    return ids.length > 0 && ids.length <= 64 && this.allowed(authority, 'SOURCE_READ', ids.map(id => ({ kind: 'SOURCE', id })));
  }
  private scope(state: State, authority: Authority): Scope {
    if (!this.roleAllows(authority, 'SOURCE_READ')) throw new SecurityError('PERMISSION_DENIED');
    const sourceIds = sourceCandidateIds(state).sort().filter(id => this.readSources(authority, [id]));
    if (!sourceIds.length) throw new SecurityError('PERMISSION_DENIED');
    return { sourceIds, authorizationContext: hash([authority.context, sourceIds]) };
  }
  private capabilities(state: State, authority: Authority, id: string, at: string): Pick<OperationsSource, 'proofEligible' | 'handoffEligible'> {
    let targets: string[];
    try { targets = sourceReviewInspectionTargets(state, id); } catch { return { proofEligible: false, handoffEligible: false }; }
    if (!this.readSources(authority, targets)) return { proofEligible: false, handoffEligible: false };
    const source = state.sources.find(row => row.id === id);
    const proofEligible = !!source && ['PRIMARY', 'ORIGINAL'].includes(source.type) && source.verification === 'VERIFIED'
      && state.managedSources.some(row => row.sourceId === id) && eligibleSource(state, source, at);
    let handoffEligible = false;
    try { inspectHandoffSelection(state, [id], at); handoffEligible = true; } catch {}
    return { proofEligible, handoffEligible };
  }
  private metadata(state: State, authority: Authority, id: string, at: string, scope: Scope): SourceQueueEntry {
    let cursor: string | undefined;
    for (let count = 0; count <= scope.sourceIds.length; count += 50) {
      const page = projectSourceQueue(state, at, { limit: 50, ...(cursor ? { cursor } : {}) }, scope);
      const found = page.entries.find(row => row.candidateRef === candidateRef(id));
      if (found) return found;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    throw new SecurityError('PERMISSION_DENIED');
  }
  private sourceGraph(state: State, story: Story): string[] {
    const historical = story.sourceHandoff?.dependencies.map(row => row.id) ?? [];
    return [...new Set([...sourceReviewDependencyIds(state, [...story.sourceIds, ...historical]), ...storySourceHandoffTargets(state, story)])].sort();
  }
  private storyCurrent(state: State, story: Story, at: string): boolean {
    try {
      if (story.retentionRedacted || state.retentionReviewRequired || !story.sourceIds.length) return false;
      assertStorySourceHandoff(state, story, at);
      for (const id of this.sourceGraph(state, story)) {
        const source = state.sources.find(row => row.id === id);
        if (!source || !eligibleSource(state, source, at)) return false;
        const record = state.managedSources.find(row => row.sourceId === id);
        if (record && (policyStatus(record.policy, at) !== 'ACTIVE' || !record.policy.licensedExcerpt || !record.policy.internalAnalysis)) return false;
      }
      return true;
    } catch { return false; }
  }
  private graphDeadline(state: State, ids: readonly string[], at: string): number | null {
    let result = Infinity;
    for (const id of ids) {
      if (reviewSourceId(id)) { const next = sourceReviewValidUntil(state, id, at); if (next !== null) result = Math.min(result, next); }
      for (const row of state.managedSources.filter(row => row.sourceId === id)) {
        for (const time of [retentionDeadline(row), Date.parse(row.policy.expiresAt)]) if (time > Date.parse(at)) result = Math.min(result, time);
      }
    }
    return Number.isFinite(result) ? result : null;
  }
  /** Complete serialization and every current-authority/time check happen under the same lock as mutations. */
  private async disclose<T extends object>(credential: unknown, project: Project<T>, callback: OperationsDisclosure<T & OperationsLease>): Promise<void> {
    try {
      if (typeof callback !== 'function' || callback.constructor.name === 'AsyncFunction') throw new SecurityError('DOMAIN_REJECTED');
      const initial = this.authority(await this.repository.read(), credential);
      await this.repository.readGuarded(state => {
        const authority = this.authority(state, credential);
        if (initial.context !== authority.context) throw new SecurityError('PERMISSION_DENIED');
        const asOf = this.access.now(), started = sessionTimestamp(asOf);
        const projection = project(state, authority, asOf);
        const session = state.sessions.find(row => row.id === authority.principal.sessionId)!;
        const deadline = Math.min(started + maximumLease, sessionTimestamp(session.expiresAt), projection.deadline ?? Infinity);
        if (deadline <= started) throw new SecurityError('STALE_TARGET');
        const value = frozen({ ...projection.value, asOf, validForMs: deadline - started });
        const serialized = JSON.stringify(projection.value);
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumResponse) throw new SecurityError('STORAGE_UNAVAILABLE');
        const assertCurrent = () => {
          const currentAuthority = this.authority(state, credential);
          if (currentAuthority.context !== authority.context) throw new SecurityError('PERMISSION_DENIED');
          const at = this.access.now();
          const projectedAt = sessionTimestamp(at);
          if (projectedAt < started || projectedAt >= deadline) throw new SecurityError('STALE_TARGET');
          if (JSON.stringify(project(state, currentAuthority, at).value) !== serialized) throw new SecurityError('STALE_TARGET');
          const final = this.authority(state, credential), time = sessionTimestamp(this.access.now());
          if (final.context !== authority.context) throw new SecurityError('PERMISSION_DENIED');
          if (time < projectedAt || time >= deadline) throw new SecurityError('STALE_TARGET');
          if (time >= sessionTimestamp(session.expiresAt)) throw new SecurityError('SESSION_EXPIRED');
        };
        assertCurrent();
        const decision: unknown = callback(value, assertCurrent);
        if (decision !== undefined) { void Promise.resolve(decision).catch(() => undefined); throw new SecurityError('DOMAIN_REJECTED'); }
      });
    } catch (error) { safeError(error); }
  }
  async withOverview(credential: unknown, callback: OperationsDisclosure<OperationsOverview>): Promise<void> {
    await this.disclose(credential, (_state, authority) => {
      const roles = [...authority.snapshot.identities.find(row => row.id === authority.principal.identityId)!.roles];
      return { value: { roles, permissions: permissions.filter(permission => roles.some(role => permissionMatrix[role].includes(permission))) }, deadline: null };
    }, callback);
  }
  async withSources(credential: unknown, query: SourceQueueQuery | undefined, callback: OperationsDisclosure<OperationsSources>): Promise<void> {
    try { query = querySnapshot(query); } catch (error) { safeError(error); }
    await this.disclose(credential, (state, authority, at) => {
      const scope = this.scope(state, authority), page = projectSourceQueue(state, at, query, scope);
      const ids = new Map(scope.sourceIds.map(id => [candidateRef(id), id]));
      const entries = page.entries.map(metadata => {
        const sourceId = ids.get(metadata.candidateRef)!;
        return { sourceId, metadata, ...this.capabilities(state, authority, sourceId, at) };
      });
      let deadline = sourceQueueValidUntil(state, at, scope) ?? Infinity;
      for (const row of entries) if (row.handoffEligible) {
        const cutoff = sourceHandoffValidUntil(state, [row.sourceId], at); if (cutoff !== null) deadline = Math.min(deadline, cutoff);
      }
      return { value: { page: { ...page, entries } }, deadline: Number.isFinite(deadline) ? deadline : null };
    }, callback);
  }
  async withSource(credential: unknown, sourceId: string, callback: OperationsDisclosure<OperationsSourceDetail>): Promise<void> {
    if (!reviewSourceId(sourceId)) throw new SecurityError('DOMAIN_REJECTED');
    await this.disclose(credential, (state, authority, at) => {
      const scope = this.scope(state, authority);
      if (!scope.sourceIds.includes(sourceId) || !this.readSources(authority, sourceReviewInspectionTargets(state, sourceId))) throw new SecurityError('PERMISSION_DENIED');
      const metadata = this.metadata(state, authority, sourceId, at, scope), review = sourceReviewSummary(state, sourceId, at);
      const last = latestSourceReview(state.sourceReviews, sourceId), pending = review.pendingProposal && review.reviewAllowed ? last?.proposal : null;
      const proposal = pending ? { classification: pending.classification, originId: pending.originId,
        evidenceReferences: [...pending.evidenceReferences], reasonCode: pending.reasonCode } : null;
      const lifecycle: Record<SourceReviewAction, boolean> = {
        begin: ['UNREVIEWED', 'REJECTED', 'DISPUTED'].includes(review.status), propose: review.status === 'UNDER_REVIEW',
        confirm: review.status === 'PROPOSED' && pending?.proposedBy !== authority.principal.identityId,
        reject: review.status === 'PROPOSED' && pending?.proposedBy !== authority.principal.identityId,
        hold: !['ON_HOLD', 'WITHDRAWN'].includes(review.status), release: review.status === 'ON_HOLD',
        withdraw: !['UNREVIEWED', 'WITHDRAWN'].includes(review.status),
      };
      const actions = Object.fromEntries(sourceReviewActions.map(action => [action, review.reviewAllowed && lifecycle[action]
        && this.allowed(authority, reviewPermission[action], [{ kind: 'SOURCE', id: sourceId }])])) as Record<SourceReviewAction, boolean>;
      const capabilities = this.capabilities(state, authority, sourceId, at);
      const deadline = Math.min(sourceReviewValidUntil(state, sourceId, at) ?? Infinity,
        capabilities.handoffEligible ? sourceHandoffValidUntil(state, [sourceId], at) ?? Infinity : Infinity);
      return { value: { sourceId, metadata, review, proposal, actions, ...capabilities },
        deadline: Number.isFinite(deadline) ? deadline : null };
    }, callback);
  }
  async withStories(credential: unknown, callback: OperationsDisclosure<OperationsStories>): Promise<void> {
    await this.disclose(credential, (state, authority, at) => {
      const latest = new Map<string, Story>(); for (const row of state.revisions) latest.set(row.id, row);
      const stories: OperationsStory[] = []; let deadline = Infinity;
      for (const row of [...latest.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        const action = (permission: Permission) => this.allowed(authority, permission, [{ kind: 'STORY', id: row.id }]);
        const edit = action('STORY_EDIT'), review = action('STORY_REVIEW'), approve = action('STORY_APPROVE');
        if (!edit && !review && !approve) continue;
        let graph: string[];
        try { graph = this.sourceGraph(state, row); } catch { continue; }
        if (!this.readSources(authority, graph)) continue;
        const current = this.storyCurrent(state, row, at);
        stories.push({ id: row.id, version: row.version, status: row.status, blocked: !current,
          headline: current ? row.headline : null, summary: current ? row.summary : null,
          sourceIds: current ? [...row.sourceIds] : [], evidence: current ? row.evidence.map(item => ({
            id: item.id, claim: item.claim, support: [...item.support], contradict: [...item.contradict],
            verification: item.verification, uncertainty: item.uncertainty })) : [],
          actions: { edit: current && edit && !['PUBLISHED', 'REJECTED', 'ON_HOLD'].includes(row.status),
            approve: current && approve && row.status === 'NEEDS_REVIEW' && row.evidence.length > 0
              && row.evidence.every(item => item.verification === 'VERIFIED' && item.support.length > 0),
            reviewStatuses: current && review ? storyTransitions[row.status].filter(status => status !== 'CLUSTERED' || !!row.clusterId) : [] } });
        const next = this.graphDeadline(state, graph, at); if (next !== null) deadline = Math.min(deadline, next);
        if (row.sourceHandoff) { const bound = sourceHandoffValidUntil(state, row.sourceIds, at); if (bound !== null) deadline = Math.min(deadline, bound); }
        if (stories.length === 10) break;
      }
      return { value: { stories }, deadline: Number.isFinite(deadline) ? deadline : null };
    }, callback);
  }
  async withEditions(credential: unknown, callback: OperationsDisclosure<OperationsEditions>): Promise<void> {
    await this.disclose(credential, (state, authority, at) => {
      const latest = new Map<string, EditionRevision>(); for (const row of state.editions) latest.set(row.id, row);
      const stories = new Map<string, Story>(); for (const row of state.revisions) stories.set(row.id, row);
      const editions: OperationsEdition[] = []; let deadline = Infinity;
      for (const row of [...latest.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        const placements = row.status === 'INVALIDATED' ? [] : row.sections.flatMap(section => section.placements);
        const targets: ResourceTarget[] = [{ kind: 'EDITION', id: row.id }, ...placements.map(item => ({ kind: 'STORY' as const, id: item.storyId }))];
        const grants = (['EDITION_ASSEMBLE', 'EDITION_REVIEW', 'EDITION_READY'] as const).filter(permission => this.allowed(authority, permission, targets));
        if (!grants.length) continue;
        let available = row.status !== 'INVALIDATED', visible = true, rowDeadline = Infinity;
        for (const placement of placements) {
          const story = stories.get(placement.storyId);
          let graph: string[];
          try {
            if (!story) { visible = false; break; }
            graph = sourceReviewDependencyIds(state, [...this.sourceGraph(state, story), ...placement.sources.flatMap(item => [item.sourceId, item.originId]),
              ...placement.evidence.flatMap(item => [...item.support, ...item.contradict])]);
          } catch { visible = false; break; }
          if (!this.readSources(authority, graph)) { visible = false; break; }
          if (!this.storyCurrent(state, story, at)) { visible = false; break; }
          try {
            const current = buildPlacement(state, placement.storyId, placement.storyVersion, placement.featured, at);
            if (stableJSON(current) !== stableJSON(placement)) available = false;
            rowDeadline = Math.min(rowDeadline, Date.parse(current.expiresAt));
          } catch { available = false; }
          const next = this.graphDeadline(state, graph, at); if (next !== null) rowDeadline = Math.min(rowDeadline, next);
        }
        if (!visible) continue;
        const reviewStatuses = available ? editionTransitions[row.status].filter(next => grants.includes(next === 'READY_FOR_APPROVAL' ? 'EDITION_READY' : 'EDITION_REVIEW')) : [];
        editions.push({ id: row.id, date: row.date, timezone: row.timezone, revision: row.revision, status: row.status,
          storyCount: placements.length, available, actions: { reviewStatuses: [...reviewStatuses] } });
        if (rowDeadline > Date.parse(at)) deadline = Math.min(deadline, rowDeadline);
        if (editions.length === 10) break;
      }
      return { value: { editions }, deadline: Number.isFinite(deadline) ? deadline : null };
    }, callback);
  }
}
