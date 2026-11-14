/** Authenticated, exact-source handoff into the existing newsroom service. No approval or publication authority. */
import { resolve } from 'node:path';
import { JsonRepository } from '../newsroom/store.ts';
import { Newsroom } from '../newsroom/service.ts';
import type { State, Story } from '../newsroom/model.ts';
import {
  assertStorySourceHandoff, buildSourceHandoff, inspectHandoffSelection, sourceHandoffTargets,
  sourceHandoffValidUntil, storySourceHandoffTargets, validateHandoffInput, validateHandoffSourceIds, SourceHandoffError,
} from '../source-handoff/domain.ts';
import type { SourceSelection, HumanStoryInput } from '../source-handoff/types.ts';
import { sourceReviewRevision } from '../source-review/domain.ts';
import type { AccessControl } from './service.ts';
import type { ResourcePolicy, ResourceTarget } from './resources.ts';
import type { Permission, Principal, SecurityCode } from './types.ts';
import { SecurityError, sessionTimestamp } from './verifier.ts';

export interface StoryPreparationReceipt { id: string; version: number; status: 'INGESTED' }
interface Authority { principal: Principal; epoch: string; ids: string[]; storyId?: string }
type Disclosure<T> = (value: T, assertCurrent: () => void) => void;
const responseLimit = 16_384;
function samePrincipal(actual: Principal, expected: Principal): void {
  if (actual.identityId !== expected.identityId || actual.identityRevision !== expected.identityRevision
    || actual.sessionId !== expected.sessionId || actual.sessionRef !== expected.sessionRef) throw new SecurityError('PERMISSION_DENIED');
}
function frozenState(state: State): Readonly<State> {
  const copy = structuredClone(state);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!Object.hasOwn(descriptor, 'value')) throw new SecurityError('PERMISSION_DENIED');
      freeze(descriptor.value);
    }
    Object.freeze(value);
  };
  freeze(copy); return copy;
}
function epoch(policy: ResourcePolicy): string {
  try {
    if (!policy || typeof policy.authorize !== 'function' || typeof policy.sourceReadRevision !== 'function') throw Error();
    const value: unknown = policy.sourceReadRevision();
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
      if (value && (typeof value === 'object' || typeof value === 'function')) void Promise.resolve(value).catch(() => undefined);
      throw Error();
    }
    return value;
  } catch { throw new SecurityError('PERMISSION_DENIED'); }
}
function policyAllows(policy: ResourcePolicy, principal: Principal, permission: Permission, targets: readonly ResourceTarget[], state: Readonly<State>): void {
  try {
    const copy = Object.freeze(targets.map(target => Object.freeze({ ...target })));
    const result: unknown = policy.authorize(Object.freeze({ ...principal }), permission, copy, state);
    if (result !== undefined) { void Promise.resolve(result).catch(() => undefined); throw new SecurityError('PERMISSION_DENIED'); }
  } catch (error) {
    const code: unknown = error instanceof SecurityError ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    throw new SecurityError(typeof code === 'string' ? code as SecurityCode : 'PERMISSION_DENIED');
  }
}
function safe(error: unknown): SecurityError {
  const code: unknown = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  if (error instanceof SecurityError && typeof code === 'string') return new SecurityError(code as SecurityCode);
  if (error instanceof SourceHandoffError) return new SecurityError(code === 'STALE_SOURCE' ? 'STALE_TARGET' : 'DOMAIN_REJECTED');
  return new SecurityError('STORAGE_UNAVAILABLE');
}
function serialized(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > responseLimit) throw new SecurityError('STORAGE_UNAVAILABLE');
  return text;
}
function synchronous(callback: unknown): asserts callback is (...args: never[]) => void {
  if (typeof callback !== 'function' || callback.constructor.name === 'AsyncFunction') throw new SecurityError('DOMAIN_REJECTED');
}

/** Composite SOURCE_READ + STORY_CREATE authority, without creating a new permission or owner. */
export class AuthenticatedSourceHandoff {
  private readonly repository: JsonRepository;
  private readonly access: AccessControl;
  private readonly policy: ResourcePolicy;
  constructor(repository: JsonRepository, access: AccessControl, options: { resourcePolicy: ResourcePolicy }) {
    if (!repository || !access || typeof repository.file !== 'string' || resolve(repository.file) !== access.repositoryFile) throw new SecurityError('STORAGE_UNAVAILABLE');
    if (!options?.resourcePolicy || typeof options.resourcePolicy.authorize !== 'function'
      || typeof options.resourcePolicy.sourceReadRevision !== 'function') throw new SecurityError('PERMISSION_DENIED');
    this.repository = repository; this.access = access; this.policy = options.resourcePolicy;
  }
  private authority(state: State, credential: unknown, ids: readonly string[], at: string, storyId?: string): Authority {
    const revision = epoch(this.policy);
    const principal = this.access.authorizeInState(state, credential, 'SOURCE_READ', at);
    if (storyId !== undefined) samePrincipal(this.access.authorizeInState(state, credential, 'STORY_CREATE', at), principal);
    const exactIds = [...new Set(ids)].sort();
    if (!exactIds.length || exactIds.length > 64 || exactIds.some(id => !/^url-[a-f0-9]{64}$/.test(id))) throw new SecurityError('DOMAIN_REJECTED');
    const snapshot = frozenState(state);
    policyAllows(this.policy, principal, 'SOURCE_READ', exactIds.map(id => ({ kind: 'SOURCE', id })), snapshot);
    if (storyId !== undefined) policyAllows(this.policy, principal, 'STORY_CREATE', [{ kind: 'STORY', id: storyId }], snapshot);
    if (revision !== epoch(this.policy)) throw new SecurityError('PERMISSION_DENIED');
    return { principal, epoch: revision, ids: exactIds, ...(storyId === undefined ? {} : { storyId }) };
  }
  private match(actual: Authority, expected: Authority): void {
    samePrincipal(actual.principal, expected.principal);
    if (actual.epoch !== expected.epoch || actual.storyId !== expected.storyId || JSON.stringify(actual.ids) !== JSON.stringify(expected.ids)) throw new SecurityError('PERMISSION_DENIED');
  }
  private finalTime(state: State, credential: unknown, accepted: Authority, at: string, validUntil: number | null): void {
    samePrincipal(this.access.authorizeInState(state, credential, 'SOURCE_READ', this.access.now()), accepted.principal);
    if (accepted.storyId !== undefined) samePrincipal(this.access.authorizeInState(state, credential, 'STORY_CREATE', this.access.now()), accepted.principal);
    if (epoch(this.policy) !== accepted.epoch) throw new SecurityError('PERMISSION_DENIED');
    const now = sessionTimestamp(this.access.now()), session = state.sessions.find(row => row.id === accepted.principal.sessionId);
    if (!session || now >= sessionTimestamp(session.expiresAt)) throw new SecurityError('SESSION_EXPIRED');
    if (now < sessionTimestamp(at) || (validUntil !== null && now >= validUntil)) throw new SecurityError('STALE_TARGET');
  }
  async inspect(credential: unknown, rawIds: unknown): Promise<SourceSelection[]> {
    let result: SourceSelection[] | undefined;
    await this.withSelection(credential, rawIds, value => { result = value; });
    if (!result) throw new SecurityError('STORAGE_UNAVAILABLE');
    return result;
  }
  async withSelection(credential: unknown, rawIds: unknown, disclose: Disclosure<SourceSelection[]>): Promise<void> {
    try {
      synchronous(disclose);
      const ids = validateHandoffSourceIds(rawIds);
      const initialState = await this.repository.read();
      const initial = this.authority(initialState, credential, sourceHandoffTargets(initialState, ids), this.access.now());
      await this.repository.readGuarded(state => {
        const authority = this.authority(state, credential, sourceHandoffTargets(state, ids), this.access.now()); this.match(authority, initial);
        const value = inspectHandoffSelection(state, ids, this.access.now()), text = serialized(value);
        const assertCurrent = () => {
          const at = this.access.now();
          this.match(this.authority(state, credential, sourceHandoffTargets(state, ids), at), authority);
          const cutoff = sourceHandoffValidUntil(state, ids, at);
          if (serialized(inspectHandoffSelection(state, ids, at)) !== text) throw new SecurityError('STALE_TARGET');
          this.match(this.authority(state, credential, sourceHandoffTargets(state, ids), this.access.now()), authority);
          this.finalTime(state, credential, authority, at, cutoff);
        };
        assertCurrent();
        const result: unknown = disclose(value, assertCurrent);
        if (result !== undefined) { void Promise.resolve(result).catch(() => undefined); throw new SecurityError('DOMAIN_REJECTED'); }
      });
    } catch (error) { throw safe(error); }
  }
  async prepare(credential: unknown, rawInput: unknown): Promise<StoryPreparationReceipt> {
    try {
      const input = validateHandoffInput(rawInput), ids = input.sources.map(source => source.id);
      const initialState = await this.repository.read();
      const initial = this.authority(initialState, credential, sourceHandoffTargets(initialState, ids), this.access.now(), input.story.id);
      // Newsroom.create reads this private snapshot only inside the guarded adapter.
      const story: HumanStoryInput & Partial<Pick<Story, 'sourceHandoff'>> = structuredClone(input.story);
      let accepted: Authority | undefined, acceptedAt = '', cutoff: number | null = null;
      let fingerprints = new Map<string, string>();
      const owner = this;
      class GuardedHandoffRepository extends JsonRepository {
        override async read(): Promise<State> { throw new SecurityError('DOMAIN_REJECTED'); }
        override async transact<T>(change: (state: State) => T): Promise<T> {
          return this.protectedTransaction(change);
        }
        override async transactGuarded<T>(change: (state: State) => T, guard: (state: State) => void): Promise<T> {
          return this.protectedTransaction(change, guard);
        }
        private async protectedTransaction<T>(change: (state: State) => T, additionalGuard?: (state: State) => void): Promise<T> {
          return owner.repository.transactGuarded(state => {
            const at = owner.access.now();
            const authority = owner.authority(state, credential, sourceHandoffTargets(state, ids), at, input.story.id); owner.match(authority, initial);
            if (state.revisions.some(row => row.id === input.story.id)) throw new SecurityError('DOMAIN_REJECTED');
            const binding = buildSourceHandoff(state, input.sources, at);
            Object.assign(story, { sourceHandoff: binding });
            const result = change(state);
            const prepared = state.revisions.filter(row => row.id === input.story.id).at(-1);
            if (!prepared || prepared.version !== 1 || prepared.status !== 'INGESTED') throw new SecurityError('DOMAIN_REJECTED');
            assertStorySourceHandoff(state, prepared, at);
            owner.access.action(state, authority.principal, 'STORY_CREATE', 'STORY', prepared.id, prepared.version, at);
            accepted = authority; acceptedAt = at; cutoff = sourceHandoffValidUntil(state, ids, at);
            fingerprints = new Map(authority.ids.map(id => [id, sourceReviewRevision(state, id)]));
            return result;
          }, state => {
            if (!accepted) throw new SecurityError('STORAGE_UNAVAILABLE');
            const at = owner.access.now();
            const current = owner.authority(state, credential, sourceHandoffTargets(state, ids), at, input.story.id); owner.match(current, accepted);
            const prepared = state.revisions.filter(row => row.id === input.story.id).at(-1);
            if (!prepared || prepared.version !== 1 || prepared.status !== 'INGESTED') throw new SecurityError('STALE_TARGET');
            assertStorySourceHandoff(state, prepared, at);
            for (const id of accepted.ids) if (sourceReviewRevision(state, id) !== fingerprints.get(id)) throw new SecurityError('STALE_TARGET');
            const currentCutoff = sourceHandoffValidUntil(state, ids, at);
            if (additionalGuard) {
              const decision: unknown = additionalGuard(state);
              if (decision !== undefined) { void Promise.resolve(decision).catch(() => undefined); throw new SecurityError('DOMAIN_REJECTED'); }
            }
            owner.finalTime(state, credential, accepted, acceptedAt, cutoff === null ? currentCutoff : currentCutoff === null ? cutoff : Math.min(cutoff, currentCutoff));
          });
        }
      }
      const result = await new Newsroom(new GuardedHandoffRepository(this.repository.file), { clock: () => this.access.now() }).create(story, 'authenticated-source-handoff');
      return { id: result.id, version: result.version, status: 'INGESTED' };
    } catch (error) { throw safe(error); }
  }
  /** Final response authorization after an accepted mutation; failure does not undo the commit. */
  async withPreparedStory(credential: unknown, storyId: string, version: number, disclose: Disclosure<StoryPreparationReceipt>): Promise<void> {
    try {
      synchronous(disclose);
      if (typeof storyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(storyId) || !Number.isSafeInteger(version) || version < 1) throw new SecurityError('DOMAIN_REJECTED');
      const currentStory = (state: State): Story => {
        const story = state.revisions.filter(row => row.id === storyId).at(-1);
        if (!story?.sourceHandoff || story.retentionRedacted || story.version !== version || story.status !== 'INGESTED') throw new SecurityError('STALE_TARGET');
        return story;
      };
      const initialState = await this.repository.read(), at = this.access.now();
      // Check target authority before examining its existence/status, including for direct trusted API callers.
      const expectedEpoch = epoch(this.policy);
      const writer = this.access.authorizeInState(initialState, credential, 'STORY_CREATE', at);
      samePrincipal(this.access.authorizeInState(initialState, credential, 'SOURCE_READ', at), writer);
      policyAllows(this.policy, writer, 'STORY_CREATE', [{ kind: 'STORY', id: storyId }], frozenState(initialState));
      if (epoch(this.policy) !== expectedEpoch) throw new SecurityError('PERMISSION_DENIED');
      const original = currentStory(initialState);
      const initial = this.authority(initialState, credential, storySourceHandoffTargets(initialState, original), this.access.now(), storyId);
      await this.repository.readGuarded(state => {
        const story = currentStory(state), ids = storySourceHandoffTargets(state, story);
        const authority = this.authority(state, credential, ids, this.access.now(), storyId); this.match(authority, initial);
        assertStorySourceHandoff(state, story, this.access.now());
        const receipt: StoryPreparationReceipt = { id: story.id, version: story.version, status: 'INGESTED' };
        const text = serialized(receipt);
        const assertCurrent = () => {
          const at = this.access.now(), row = currentStory(state), targets = storySourceHandoffTargets(state, row);
          this.match(this.authority(state, credential, targets, at, storyId), authority);
          assertStorySourceHandoff(state, row, at);
          const cutoff = sourceHandoffValidUntil(state, row.sourceHandoff!.selected.map(source => source.id), at);
          if (serialized({ id: row.id, version: row.version, status: row.status }) !== text) throw new SecurityError('STALE_TARGET');
          this.match(this.authority(state, credential, storySourceHandoffTargets(state, row), this.access.now(), storyId), authority);
          this.finalTime(state, credential, authority, at, cutoff);
        };
        assertCurrent();
        const result: unknown = disclose(receipt, assertCurrent);
        if (result !== undefined) { void Promise.resolve(result).catch(() => undefined); throw new SecurityError('DOMAIN_REJECTED'); }
      });
    } catch (error) { throw safe(error); }
  }
}
