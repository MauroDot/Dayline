/** Synthetic development source review. No story approval or publication operation. */
import { resolve } from 'node:path';
import type { State } from '../newsroom/model.ts';
import { JsonRepository } from '../newsroom/store.ts';
import {
  applySourceReview, assertSourceReviewCurrent, sourceReviewRevision, sourceReviewSummary,
  sourceReviewTargets, sourceReviewInspectionTargets, sourceReviewValidUntil, validateSourceReviewInput, SourceReviewError,
} from '../source-review/domain.ts';
import type { SourceReviewAction, SourceReviewInput, SourceReviewSummary } from '../source-review/types.ts';
import type { AccessControl } from './service.ts';
import type { ResourcePolicy } from './resources.ts';
import type { Permission, Principal, SecurityCode } from './types.ts';
import { SecurityError, sessionTimestamp } from './verifier.ts';

const permissionByAction: Readonly<Record<SourceReviewAction, Permission>> = Object.freeze({
  begin: 'SOURCE_REVIEW', propose: 'SOURCE_REVIEW', withdraw: 'SOURCE_REVIEW',
  confirm: 'SOURCE_RESOLVE', reject: 'SOURCE_RESOLVE', hold: 'SOURCE_HOLD', release: 'SOURCE_RELEASE',
});
const responseLimit = 16_384;
interface Authority { principal: Principal; epoch: string; ids: string[] }
type Disclosure = (summary: SourceReviewSummary, assertCurrent: () => void) => void;
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:@./+-]{0,255}$/.test(value)) throw new SecurityError('DOMAIN_REJECTED');
}
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
function policyAllows(policy: ResourcePolicy, principal: Principal, permission: Permission, ids: readonly string[], snapshot: Readonly<State>): void {
  try {
    const targets = Object.freeze(ids.map(value => Object.freeze({ kind: 'SOURCE' as const, id: value })));
    const decision: unknown = policy.authorize(Object.freeze({ ...principal }), permission, targets, snapshot);
    if (decision !== undefined) {
      void Promise.resolve(decision).catch(() => undefined);
      throw Error();
    }
  } catch (error) {
    const code: unknown = error instanceof SecurityError ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    if (typeof code === 'string') throw new SecurityError(code as SecurityCode);
    throw new SecurityError('PERMISSION_DENIED');
  }
}
function safe(error: unknown): SecurityError {
  const code: unknown = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  if (error instanceof SecurityError && typeof code === 'string') return new SecurityError(code as SecurityCode);
  if (error instanceof SourceReviewError) {
    if (code === 'STALE_REVISION') return new SecurityError('STALE_TARGET');
    if (code === 'SELF_CONFIRMATION') return new SecurityError('PERMISSION_DENIED');
    if (code === 'STORAGE_LIMIT') return new SecurityError('STORAGE_UNAVAILABLE');
    if (['INVALID_INPUT', 'INELIGIBLE_SOURCE', 'INVALID_TRANSITION', 'CONTRADICTORY_EVIDENCE'].includes(code as string)) return new SecurityError('DOMAIN_REJECTED');
  }
  return new SecurityError('STORAGE_UNAVAILABLE');
}

/** Exact assignments and current role/session checks are mandatory on every operation. */
export class AuthenticatedSourceReview {
  private readonly repository: JsonRepository;
  private readonly access: AccessControl;
  private readonly policy: ResourcePolicy;
  constructor(repository: JsonRepository, access: AccessControl, options: { resourcePolicy: ResourcePolicy }) {
    if (!repository || !access || typeof repository.file !== 'string' || resolve(repository.file) !== access.repositoryFile) throw new SecurityError('STORAGE_UNAVAILABLE');
    if (!options || !options.resourcePolicy || typeof options.resourcePolicy.authorize !== 'function'
      || typeof options.resourcePolicy.sourceReadRevision !== 'function') throw new SecurityError('PERMISSION_DENIED');
    this.repository = repository; this.access = access; this.policy = options.resourcePolicy;
  }
  private authority(state: State, credential: unknown, sourceId: string, permission: Permission, ids: readonly string[], at: string): Authority {
    const revision = epoch(this.policy);
    const principal = this.access.authorizeInState(state, credential, 'SOURCE_READ', at);
    if (permission !== 'SOURCE_READ') samePrincipal(this.access.authorizeInState(state, credential, permission, at), principal);
    const snapshot = frozenState(state);
    const exactIds = [...new Set([sourceId, ...ids])].sort();
    if (exactIds.length > 64) throw new SecurityError('DOMAIN_REJECTED');
    for (const value of exactIds) id(value);
    policyAllows(this.policy, principal, 'SOURCE_READ', exactIds, snapshot);
    if (permission !== 'SOURCE_READ') policyAllows(this.policy, principal, permission, [sourceId], snapshot);
    if (epoch(this.policy) !== revision) throw new SecurityError('PERMISSION_DENIED');
    return { principal, epoch: revision, ids: exactIds };
  }
  private match(actual: Authority, expected: Authority): void {
    samePrincipal(actual.principal, expected.principal);
    if (actual.epoch !== expected.epoch || JSON.stringify(actual.ids) !== JSON.stringify(expected.ids)) throw new SecurityError('PERMISSION_DENIED');
  }
  private finalTime(state: State, credential: unknown, authority: Authority, permission: Permission, at: string, validUntil: number | null): void {
    const final = this.access.authorizeInState(state, credential, 'SOURCE_READ', this.access.now());
    samePrincipal(final, authority.principal);
    if (permission !== 'SOURCE_READ') samePrincipal(this.access.authorizeInState(state, credential, permission, this.access.now()), authority.principal);
    if (epoch(this.policy) !== authority.epoch) throw new SecurityError('PERMISSION_DENIED');
    const now = sessionTimestamp(this.access.now());
    const session = state.sessions.find(row => row.id === authority.principal.sessionId);
    if (!session || now >= sessionTimestamp(session.expiresAt)) throw new SecurityError('SESSION_EXPIRED');
    if (now < sessionTimestamp(at) || (validUntil !== null && now >= validUntil)) throw new SecurityError('STALE_TARGET');
  }
  async inspect(credential: unknown, sourceId: string): Promise<SourceReviewSummary> {
    let result: SourceReviewSummary | undefined;
    await this.withSummary(credential, sourceId, summary => { result = summary; });
    if (!result) throw new SecurityError('STORAGE_UNAVAILABLE');
    return result;
  }
  /** Trusted synchronous disclosure: transport calls assertCurrent immediately before sending. */
  async withSummary(credential: unknown, sourceId: string, disclose: Disclosure): Promise<void> {
    try {
      id(sourceId);
      if (typeof disclose !== 'function' || disclose.constructor.name === 'AsyncFunction') throw new SecurityError('DOMAIN_REJECTED');
      const initialState = await this.repository.read();
      const initial = this.authority(initialState, credential, sourceId, 'SOURCE_READ', sourceReviewInspectionTargets(initialState, sourceId), this.access.now());
      await this.repository.readGuarded(state => {
        const authority = this.authority(state, credential, sourceId, 'SOURCE_READ', sourceReviewInspectionTargets(state, sourceId), this.access.now());
        this.match(authority, initial);
        const summary = sourceReviewSummary(state, sourceId, this.access.now());
        const serialized = JSON.stringify(summary);
        if (Buffer.byteLength(serialized, 'utf8') > responseLimit) throw new SecurityError('STORAGE_UNAVAILABLE');
        const assertCurrent = () => {
          const at = this.access.now();
          this.match(this.authority(state, credential, sourceId, 'SOURCE_READ', sourceReviewInspectionTargets(state, sourceId), at), authority);
          const validUntil = sourceReviewValidUntil(state, sourceId, at);
          if (JSON.stringify(sourceReviewSummary(state, sourceId, at)) !== serialized) throw new SecurityError('STALE_TARGET');
          // A serializer hook cannot replace the dependency graph or its grants before disclosure.
          this.match(this.authority(state, credential, sourceId, 'SOURCE_READ', sourceReviewInspectionTargets(state, sourceId), this.access.now()), authority);
          this.finalTime(state, credential, authority, 'SOURCE_READ', at, validUntil);
        };
        assertCurrent();
        const returned: unknown = disclose(summary, assertCurrent);
        if (returned !== undefined) {
          void Promise.resolve(returned).catch(() => undefined);
          throw new SecurityError('DOMAIN_REJECTED');
        }
      });
    } catch (error) { throw safe(error); }
  }
  private async mutate(credential: unknown, sourceId: string, action: SourceReviewAction, rawInput: unknown): Promise<SourceReviewSummary> {
    try {
      id(sourceId);
      const input: SourceReviewInput = validateSourceReviewInput(action, rawInput);
      const permission = permissionByAction[action];
      const initialState = await this.repository.read();
      const ids = sourceReviewTargets(initialState, sourceId, action, input);
      const initial = this.authority(initialState, credential, sourceId, permission, ids, this.access.now());
      let accepted: Authority | undefined, acceptedAt = '', cutoff: number | null = null;
      let acceptedRevisions = new Map<string, string>();
      return await this.repository.transactGuarded(state => {
        const at = this.access.now();
        const targets = sourceReviewTargets(state, sourceId, action, input);
        const authority = this.authority(state, credential, sourceId, permission, targets, at);
        this.match(authority, initial);
        assertSourceReviewCurrent(state, sourceId, at);
        for (const dependency of authority.ids) assertSourceReviewCurrent(state, dependency, at);
        const beforeCutoff = sourceReviewValidUntil(state, sourceId, at, authority.ids);
        const summary = applySourceReview(state, sourceId, action, input, authority.principal.identityId, at);
        this.access.action(state, authority.principal, permission, 'SOURCE', sourceId, summary.reviewRevision, at);
        const serialized = JSON.stringify(summary);
        if (Buffer.byteLength(serialized, 'utf8') > responseLimit) throw new SecurityError('STORAGE_UNAVAILABLE');
        const afterCutoff = sourceReviewValidUntil(state, sourceId, at, authority.ids);
        cutoff = beforeCutoff === null ? afterCutoff : afterCutoff === null ? beforeCutoff : Math.min(beforeCutoff, afterCutoff);
        accepted = authority; acceptedAt = at;
        acceptedRevisions = new Map(authority.ids.map(target => [target, sourceReviewRevision(state, target)]));
        return summary;
      }, state => {
        if (!accepted) throw new SecurityError('STORAGE_UNAVAILABLE');
        const at = this.access.now();
        const current = this.authority(state, credential, sourceId, permission, accepted.ids, at);
        this.match(current, accepted);
        assertSourceReviewCurrent(state, sourceId, at);
        for (const dependency of accepted.ids) {
          assertSourceReviewCurrent(state, dependency, at);
          if (sourceReviewRevision(state, dependency) !== acceptedRevisions.get(dependency)) throw new SecurityError('STALE_TARGET');
        }
        const currentCutoff = sourceReviewValidUntil(state, sourceId, at, accepted.ids);
        const validUntil = cutoff === null ? currentCutoff : currentCutoff === null ? cutoff : Math.min(cutoff, currentCutoff);
        this.finalTime(state, credential, accepted, permission, acceptedAt, validUntil);
      });
    } catch (error) { throw safe(error); }
  }
  begin(credential: unknown, sourceId: string, input: unknown): Promise<SourceReviewSummary> { return this.mutate(credential, sourceId, 'begin', input); }
  propose(credential: unknown, sourceId: string, input: unknown): Promise<SourceReviewSummary> { return this.mutate(credential, sourceId, 'propose', input); }
  confirm(credential: unknown, sourceId: string, input: unknown): Promise<SourceReviewSummary> { return this.mutate(credential, sourceId, 'confirm', input); }
  reject(credential: unknown, sourceId: string, input: unknown): Promise<SourceReviewSummary> { return this.mutate(credential, sourceId, 'reject', input); }
  hold(credential: unknown, sourceId: string, input: unknown): Promise<SourceReviewSummary> { return this.mutate(credential, sourceId, 'hold', input); }
  release(credential: unknown, sourceId: string, input: unknown): Promise<SourceReviewSummary> { return this.mutate(credential, sourceId, 'release', input); }
  withdraw(credential: unknown, sourceId: string, input: unknown): Promise<SourceReviewSummary> { return this.mutate(credential, sourceId, 'withdraw', input); }
}
