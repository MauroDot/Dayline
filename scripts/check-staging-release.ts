/** Offline operator checks only. This tool never contacts, deploys or rolls back a hosted service. */
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPublicArtifact } from './inspect-public.ts';

export type StagingReleaseCode = 'STAGING_ARGUMENT_INVALID' | 'STAGING_CHECKLIST_INVALID'
  | 'STAGING_ORIGIN_INVALID' | 'STAGING_AUTO_DEPLOY_NOT_DISABLED' | 'STAGING_PREVIOUS_IDENTITY_INVALID'
  | 'STAGING_ARTIFACT_INVALID' | 'STAGING_SOURCE_NOT_CLEAN' | 'STAGING_COMMIT_MISMATCH' | 'STAGING_DIGEST_MISMATCH';
export class StagingReleaseError extends Error {
  readonly code: StagingReleaseCode;
  constructor(code: StagingReleaseCode) { super(code); this.code = code; }
}
export interface StagingReleaseChecklist {
  artifactRoot: string;
  expectedCommit: string;
  expectedDigest: string;
  stagingUrl: string;
  previous: { commit: string; contentDigest: string };
  /** Operator acknowledgement, not a query or modification of the hosting service. */
  autoDeploy: false;
}
const commitPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
function invalid(code: StagingReleaseCode): never { throw new StagingReleaseError(code); }
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === keys.length
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
}
function localPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && value.trim() === value
    && !/[\x00-\x1f]/.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^[/\\]{2}/.test(value);
}
function stagingOrigin(value: unknown): void {
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value || /[\x00-\x20\\]/.test(value)) invalid('STAGING_ORIGIN_INVALID');
  try {
    const origin = new URL(value);
    if (origin.protocol !== 'https:' || !origin.hostname || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash || origin.href !== origin.origin + '/') throw Error();
  } catch { invalid('STAGING_ORIGIN_INVALID'); }
}

/**
 * Confirms local artifact identity and checklist syntax. Passing does not grant
 * deployment authority or verify hosting settings, live acceptance or a rollback target.
 */
export async function checkStagingRelease(input: unknown) {
  if (!record(input, ['artifactRoot', 'expectedCommit', 'expectedDigest', 'stagingUrl', 'previous', 'autoDeploy'])
    || !localPath(input.artifactRoot) || typeof input.expectedCommit !== 'string' || !commitPattern.test(input.expectedCommit)
    || typeof input.expectedDigest !== 'string' || !digestPattern.test(input.expectedDigest)) invalid('STAGING_CHECKLIST_INVALID');
  stagingOrigin(input.stagingUrl);
  if (input.autoDeploy !== false) invalid('STAGING_AUTO_DEPLOY_NOT_DISABLED');
  if (!record(input.previous, ['commit', 'contentDigest']) || typeof input.previous.commit !== 'string'
    || !commitPattern.test(input.previous.commit) || typeof input.previous.contentDigest !== 'string'
    || !digestPattern.test(input.previous.contentDigest)) invalid('STAGING_PREVIOUS_IDENTITY_INVALID');
  // Snapshot validated scalar fields before asynchronous inspection; caller mutation cannot
  // replace checked identities or inject unvalidated text into the safe result afterwards.
  const artifactRoot = input.artifactRoot, expectedCommit = input.expectedCommit, expectedDigest = input.expectedDigest;
  const previous = { commit: input.previous.commit, contentDigest: input.previous.contentDigest };
  let manifest: Awaited<ReturnType<typeof inspectPublicArtifact>>;
  try {
    manifest = await inspectPublicArtifact(path.resolve(artifactRoot));
    // The general builder permits a minimal test fixture; a staging candidate must have the full contract.
    if (Object.keys(manifest.files).length !== 11 || !Object.hasOwn(manifest.files, 'src/public/lifecycle.ts')) throw Error();
  } catch { return invalid('STAGING_ARTIFACT_INVALID'); }
  if (manifest.provenance.sourceDirty) invalid('STAGING_SOURCE_NOT_CLEAN');
  if (manifest.provenance.commit !== expectedCommit) invalid('STAGING_COMMIT_MISMATCH');
  if (manifest.contentDigest !== expectedDigest) invalid('STAGING_DIGEST_MISMATCH');
  return {
    schema: 1 as const,
    event: 'staging_release_check' as const,
    offlineChecksPassed: true as const,
    candidate: { commit: manifest.provenance.commit, tree: manifest.provenance.tree, contentDigest: manifest.contentDigest,
      runtimeRequirement: manifest.runtime.node, physicalFiles: 12 as const },
    previous,
    previousIdentitySource: 'operator-supplied' as const,
    previousArtifactVerified: false as const,
    stagingHttpsOriginValidated: true as const,
    autoDeployDisabledAcknowledged: true as const,
    renderSettingsVerified: false as const,
    hostedAcceptanceVerified: false as const,
    hostedChecksPerformed: false as const,
    externalDeploymentAuthorized: false as const,
    manualAuthorizationRequired: true as const,
    automaticRollbackAllowed: false as const,
  };
}

/** Bounded local JSON input. No environment secrets or remote configuration are read. */
export async function readStagingChecklist(filename: string): Promise<unknown> {
  if (!localPath(filename)) invalid('STAGING_ARGUMENT_INVALID');
  try {
    const source = path.resolve(filename), info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw Error();
    const handle = await open(source, 'r');
    try {
      const bytes = Buffer.alloc(65537); let used = 0;
      while (used < bytes.length) {
        const result = await handle.read(bytes, used, bytes.length - used, used);
        if (result.bytesRead === 0) break;
        used += result.bytesRead;
      }
      if (used > 65536) throw Error();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used));
      return JSON.parse(text);
    } finally { await handle.close(); }
  } catch { return invalid('STAGING_CHECKLIST_INVALID'); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--checklist') invalid('STAGING_ARGUMENT_INVALID');
    console.log(JSON.stringify(await checkStagingRelease(await readStagingChecklist(process.argv[3]))));
  } catch (error) {
    console.error(JSON.stringify({ event: 'staging_release_check_failed', code: error instanceof StagingReleaseError ? error.code : 'STAGING_CHECKLIST_INVALID' }));
    process.exitCode = 1;
  }
}
