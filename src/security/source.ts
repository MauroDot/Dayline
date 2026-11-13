/** Authenticated, read-only source metadata. No editorial mutation or publication operation. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { State } from '../newsroom/model.ts';
import { JsonRepository } from '../newsroom/store.ts';
import { projectSourceQueue, sourceCandidateIds, sourceQueueValidUntil, SourceQueueError } from '../source-queue/service.ts';
import type { SourceQueuePage, SourceQueueQuery } from '../source-queue/types.ts';
import type { AccessControl } from './service.ts';
import type { Principal } from './types.ts';
import type { SecurityCode } from './types.ts';
import type { ResourcePolicy } from './resources.ts';
import { SecurityError, sessionTimestamp } from './verifier.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const responseLimit = 262_144;
interface Scope { revision: string; sourceIds: string[]; context: string }
interface Authority { principal: Principal; snapshot: Readonly<State>; scope: Scope }
type Disclosure = (page: SourceQueuePage, assertCurrent: () => void) => void;

function querySnapshot(query: SourceQueueQuery | undefined): SourceQueueQuery | undefined {
  if (query === undefined) return undefined;
  if (!query || typeof query !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(query))
    || Reflect.ownKeys(query).some(key => typeof key !== 'string' || !['view', 'limit', 'cursor'].includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(query)).some(row => !row.enumerable || !Object.hasOwn(row, 'value'))) throw new SourceQueueError('INVALID_QUERY');
  return Object.freeze({ ...query });
}
/** Read-only policy callbacks share one frozen copy instead of cloning the repository per source. */
function immutableSnapshot(state: State): Readonly<State> {
  const copy = structuredClone(state);
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!Object.hasOwn(descriptor, 'value')) throw new SecurityError('PERMISSION_DENIED');
      freeze(descriptor.value);
    }
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}
function policyRevision(policy: ResourcePolicy): string {
  if (!policy || typeof policy.authorize !== 'function' || typeof policy.sourceReadRevision !== 'function') throw new SecurityError('PERMISSION_DENIED');
  const revision: unknown = policy.sourceReadRevision();
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
    if (revision && typeof revision === 'object') void Promise.resolve(revision).catch(() => undefined);
    throw new SecurityError('PERMISSION_DENIED');
  }
  return revision;
}
function scope(policy: ResourcePolicy, principal: Principal, state: Readonly<State>): Scope {
  try {
    const revision = policyRevision(policy);
    const actor = Object.freeze({ ...principal });
    const sourceIds: string[] = [];
    for (const id of sourceCandidateIds(state as State).sort()) {
      let decision: unknown;
      try { decision = policy.authorize(actor, 'SOURCE_READ', Object.freeze([Object.freeze({ kind: 'SOURCE' as const, id })]), state); }
      catch (error) {
        // Only an explicit resource denial hides a candidate. Broken policies deny the entire request.
        if (error instanceof SecurityError && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'PERMISSION_DENIED') continue;
        if (error instanceof SecurityError) throw error;
        throw new SecurityError('PERMISSION_DENIED');
      }
      if (decision !== undefined) {
        void Promise.resolve(decision).catch(() => undefined);
        throw new SecurityError('PERMISSION_DENIED');
      }
      sourceIds.push(id);
    }
    if (revision !== policyRevision(policy) || sourceIds.length === 0) throw new SecurityError('PERMISSION_DENIED');
    const context = hash(JSON.stringify([principal.identityId, principal.identityRevision, principal.sessionId, principal.sessionRef, revision, sourceIds]));
    return { revision, sourceIds, context };
  } catch (error) {
    if (error instanceof SecurityError || error instanceof SourceQueueError) throw error;
    throw new SecurityError('PERMISSION_DENIED');
  }
}

/** Current registered sessions, role permission and exact SOURCE assignments are all required. */
export class AuthenticatedSourceQueue {
  private readonly repository: JsonRepository;
  private readonly access: AccessControl;
  private readonly policy: ResourcePolicy;
  constructor(repository: JsonRepository, access: AccessControl, options: { resourcePolicy: ResourcePolicy }) {
    if (!repository || !access || typeof repository.file !== 'string' || resolve(repository.file) !== access.repositoryFile) throw new SecurityError('STORAGE_UNAVAILABLE');
    if (!options || !options.resourcePolicy || typeof options.resourcePolicy.authorize !== 'function'
      || typeof options.resourcePolicy.sourceReadRevision !== 'function') throw new SecurityError('PERMISSION_DENIED');
    this.repository = repository; this.access = access; this.policy = options.resourcePolicy;
  }
  private authority(state: State, credential: unknown): Authority {
    const principal = this.access.authorizeInState(state, credential, 'SOURCE_READ', this.access.now());
    const snapshot = immutableSnapshot(state);
    return { principal, snapshot, scope: scope(this.policy, principal, snapshot) };
  }
  private assertCurrent(state: State, credential: unknown, expected: Authority, query: SourceQueueQuery | undefined, serialized: string): void {
    const principal = this.access.authorizeInState(state, credential, 'SOURCE_READ', this.access.now());
    if (principal.identityId !== expected.principal.identityId || principal.identityRevision !== expected.principal.identityRevision
      || principal.sessionId !== expected.principal.sessionId || principal.sessionRef !== expected.principal.sessionRef) throw new SecurityError('PERMISSION_DENIED');
    if (scope(this.policy, principal, expected.snapshot).context !== expected.scope.context) throw new SecurityError('PERMISSION_DENIED');
    // Rights and retention can expire without a repository write, including while serializing the response.
    const at = this.access.now();
    this.access.authorizeInState(state, credential, 'SOURCE_READ', at);
    const readScope = { sourceIds: expected.scope.sourceIds, authorizationContext: expected.scope.context };
    const validUntil = sourceQueueValidUntil(state, at, readScope);
    const current = projectSourceQueue(state, at, query, readScope);
    if (JSON.stringify(current) !== serialized) throw new SecurityError('STALE_TARGET');
    const final = this.access.authorizeInState(state, credential, 'SOURCE_READ', this.access.now());
    if (final.identityId !== principal.identityId || final.identityRevision !== principal.identityRevision
      || final.sessionId !== principal.sessionId || final.sessionRef !== principal.sessionRef
      || policyRevision(this.policy) !== expected.scope.revision) throw new SecurityError('PERMISSION_DENIED');
    // A serialization or trusted-verifier hook can cross a temporal boundary after projection.
    // Check the next authoritative transition without repeating the projection or rejecting ordinary clock progress.
    const disclosureTime = sessionTimestamp(this.access.now());
    const session = state.sessions.find(row => row.id === final.sessionId)!;
    if (disclosureTime >= sessionTimestamp(session.expiresAt)) throw new SecurityError('SESSION_EXPIRED');
    if (disclosureTime < sessionTimestamp(at) || (validUntil !== null && disclosureTime >= validUntil)) throw new SecurityError('STALE_TARGET');
  }
  async read(credential: unknown, query?: SourceQueueQuery): Promise<SourceQueuePage> {
    let result: SourceQueuePage | undefined;
    await this.withPage(credential, query, page => { result = page; });
    if (!result) throw new SecurityError('STORAGE_UNAVAILABLE');
    return result;
  }
  /** The trusted synchronous callback is the disclosure boundary; HTTP sends while the repository lock is held. */
  async withPage(credential: unknown, query: SourceQueueQuery | undefined, disclose: Disclosure): Promise<void> {
    try {
      if (typeof disclose !== 'function' || disclose.constructor.name === 'AsyncFunction') throw new SecurityError('DOMAIN_REJECTED');
      query = querySnapshot(query);
      // No data is disclosed from this preliminary snapshot. Concurrent revocation can commit before the final lock.
      const initial = this.authority(await this.repository.read(), credential);
      await this.repository.readGuarded(state => {
        const final = this.authority(state, credential);
        if (initial.scope.context !== final.scope.context) throw new SecurityError('PERMISSION_DENIED');
        const page = projectSourceQueue(state, this.access.now(), query, { sourceIds: final.scope.sourceIds, authorizationContext: final.scope.context });
        // Complete bounded serialization before the final clock/session/policy gate.
        const serialized = JSON.stringify(page);
        if (Buffer.byteLength(serialized, 'utf8') > responseLimit) throw new SecurityError('STORAGE_UNAVAILABLE');
        const assertCurrent = () => this.assertCurrent(state, credential, final, query, serialized);
        assertCurrent();
        const decision: unknown = disclose(page, assertCurrent);
        if (decision !== undefined) {
          void Promise.resolve(decision).catch(() => undefined);
          throw new SecurityError('DOMAIN_REJECTED');
        }
      });
    } catch (error) {
      // Fresh fixed errors discard supplied messages, causes, private fields and inherited/accessor codes.
      const code: unknown = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
      if (error instanceof SecurityError && typeof code === 'string') throw new SecurityError(code as SecurityCode);
      if (error instanceof SourceQueueError && (code === 'INVALID_QUERY' || code === 'STALE_CURSOR' || code === 'UNAVAILABLE')) throw new SourceQueueError(code);
      throw new SecurityError('STORAGE_UNAVAILABLE');
    }
  }
}
