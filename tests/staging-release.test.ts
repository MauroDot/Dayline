import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPublicArtifact } from '../scripts/build-public.ts';
import { canonicalJSON, requiredPublicFiles, sha256 } from '../scripts/inspect-public.ts';
import { checkStagingRelease, readStagingChecklist, StagingReleaseError, type StagingReleaseChecklist } from '../scripts/check-staging-release.ts';

async function fixture(run: (f: { directory: string; artifact: string; input: StagingReleaseChecklist }) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dayline-staging-release-'));
  const source = path.join(directory, 'source'), artifact = path.join(directory, 'artifact');
  try {
    await mkdir(source);
    for (const name of [...requiredPublicFiles, 'src/public/lifecycle.ts']) {
      await mkdir(path.dirname(path.join(source, name)), { recursive: true });
      await writeFile(path.join(source, name), name.endsWith('.html') ? '<!doctype html><title>Fictional fixture</title>\n'
        : name.endsWith('.css') ? 'body {color:black}\n' : 'export const fictional = true;\n');
    }
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'dayline', version: '0.1.0', type: 'module' }));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: source, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: 'pipe' });
    git('init', '-q'); git('add', '--', '.');
    git('-c', 'user.name=Fictional Release Test', '-c', 'user.email=fixture@release.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic offline release fixture');
    const manifest = await buildPublicArtifact({ sourceRoot: source, outputRoot: artifact });
    const input: StagingReleaseChecklist = { artifactRoot: artifact, expectedCommit: manifest.provenance.commit,
      expectedDigest: manifest.contentDigest, stagingUrl: 'https://fictional-staging.example.test',
      previous: { commit: 'a'.repeat(40), contentDigest: 'b'.repeat(64) }, autoDeploy: false };
    await run({ directory, artifact, input });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const code = (expected: string) => (error: unknown) => error instanceof StagingReleaseError && error.code === expected && error.message === expected;
async function manifestChange(artifact: string, change: (value: any) => void) {
  const name = path.join(artifact, 'public-manifest.json');
  const value = JSON.parse(await readFile(name, 'utf8')); change(value);
  await writeFile(name, canonicalJSON(value));
}

test('offline release checks bind clean artifact identity without granting deployment or rollback authority', async () => fixture(async ({ input }) => {
  const result = await checkStagingRelease(input);
  assert.equal(result.offlineChecksPassed, true); assert.equal(result.candidate.commit, input.expectedCommit);
  assert.equal(result.candidate.contentDigest, input.expectedDigest); assert.equal(result.candidate.runtimeRequirement, '22.16.0');
  assert.equal(result.candidate.physicalFiles, 12); assert.equal(result.manualAuthorizationRequired, true);
  for (const key of ['previousArtifactVerified', 'renderSettingsVerified', 'hostedAcceptanceVerified', 'hostedChecksPerformed', 'externalDeploymentAuthorized', 'automaticRollbackAllowed'] as const) assert.equal(result[key], false);
  assert.equal(result.previousIdentitySource, 'operator-supplied'); assert.deepEqual(result.previous, input.previous);
  const text = JSON.stringify(result); assert.equal(text.includes(input.artifactRoot), false); assert.equal(text.includes(input.stagingUrl), false);
}));

test('expected commit and content digest must match the inspected artifact exactly', async () => fixture(async ({ input }) => {
  await assert.rejects(checkStagingRelease({ ...input, expectedCommit: 'c'.repeat(40) }), code('STAGING_COMMIT_MISMATCH'));
  await assert.rejects(checkStagingRelease({ ...input, expectedDigest: 'd'.repeat(64) }), code('STAGING_DIGEST_MISMATCH'));
}));

test('validated checklist identities are snapshotted before asynchronous artifact reads', async () => fixture(async ({ input }) => {
  const previous = { ...input.previous }, commit = input.expectedCommit;
  const checking = checkStagingRelease(input);
  input.previous.commit = 'private-unvalidated-text'; input.previous.contentDigest = 'private-unvalidated-digest';
  input.expectedCommit = 'private-unvalidated-commit'; input.expectedDigest = 'private-unvalidated-digest';
  const result = await checking;
  assert.equal(result.candidate.commit, commit); assert.deepEqual(result.previous, previous);
  assert.doesNotMatch(JSON.stringify(result), /private-unvalidated/);
}));

test('dirty source provenance is never accepted as a staging release candidate', async () => fixture(async ({ input, artifact }) => {
  await manifestChange(artifact, value => { value.provenance.sourceDirty = true; });
  await assert.rejects(checkStagingRelease(input), code('STAGING_SOURCE_NOT_CLEAN'));
}));

test('a prior deployment identity is mandatory but remains an unverified operator record', async () => fixture(async ({ input }) => {
  for (const previous of [undefined, {}, { commit: 'main', contentDigest: input.expectedDigest },
    { commit: input.expectedCommit, contentDigest: 'latest' }, { ...input.previous, apiToken: 'private-secret' }]) {
    await assert.rejects(checkStagingRelease({ ...input, previous }), code('STAGING_PREVIOUS_IDENTITY_INVALID'));
  }
  const result = await checkStagingRelease({ ...input, previous: { commit: input.expectedCommit, contentDigest: input.expectedDigest } });
  assert.equal(result.previousArtifactVerified, false); assert.equal(result.automaticRollbackAllowed, false);
}));

test('auto-deploy must be explicitly acknowledged disabled and is not queried or changed', async () => fixture(async ({ input }) => {
  for (const autoDeploy of [true, 'false', null, undefined]) await assert.rejects(checkStagingRelease({ ...input, autoDeploy }), code('STAGING_AUTO_DEPLOY_NOT_DISABLED'));
  assert.equal((await checkStagingRelease(input)).renderSettingsVerified, false);
}));

test('staging target is an explicit HTTPS origin without credentials or route data', async () => fixture(async ({ input }) => {
  for (const stagingUrl of ['http://fictional.test', 'https://user:private-secret@fictional.test',
    'https://fictional.test/api/health', 'https://fictional.test/?token=private-secret', 'https://fictional.test/#private-secret',
    'file:///private/path', ' https://fictional.test', 'https://fictional.test\n', 'https://fictional.test/?', 'https://fictional.test/#', 'https:\\\\fictional.test']) {
    await assert.rejects(checkStagingRelease({ ...input, stagingUrl }), code('STAGING_ORIGIN_INVALID'));
  }
  assert.equal((await checkStagingRelease({ ...input, stagingUrl: 'https://different-owner-host.example.test/' })).stagingHttpsOriginValidated, true);
}));

test('checklist schema rejects extra fields getters and invalid expected identities', async () => fixture(async ({ input }) => {
  let invoked = false;
  const getter = { ...input }; Object.defineProperty(getter, 'expectedCommit', { enumerable: true, get() { invoked = true; throw Error('private-secret'); } });
  for (const value of [null, [], { ...input, credentials: 'private-secret' }, getter,
    { ...input, expectedCommit: 'HEAD' }, { ...input, expectedDigest: 'private-secret' }]) {
    await assert.rejects(checkStagingRelease(value), code('STAGING_CHECKLIST_INVALID'));
  }
  assert.equal(invoked, false);
}));

test('local artifact paths cannot become URLs or network shares and inspection rejects substituted directories', async () => fixture(async ({ input, directory }) => {
  for (const artifactRoot of ['https://private.test/artifact', 'file:///private/artifact', '//private-share/artifact', '\\\\private-share\\artifact', 'private\0path', '']) {
    await assert.rejects(checkStagingRelease({ ...input, artifactRoot }), code('STAGING_CHECKLIST_INVALID'));
  }
  await mkdir(path.join(directory, 'outside'));
  await assert.rejects(checkStagingRelease({ ...input, artifactRoot: path.join(directory, 'artifact', '..', 'outside') }), code('STAGING_ARTIFACT_INVALID'));
}));

test('artifact tampering and widened runtime contents remain inspection failures', async () => fixture(async ({ input, artifact }) => {
  await writeFile(path.join(artifact, 'public/app.js'), 'private-runtime-substitution');
  await assert.rejects(checkStagingRelease(input), code('STAGING_ARTIFACT_INVALID'));
}));

test('a rehashed reduced artifact cannot weaken the exact twelve-file staging contract', async () => fixture(async ({ input, artifact }) => {
  await rm(path.join(artifact, 'src/public/lifecycle.ts'));
  await manifestChange(artifact, value => { delete value.files['src/public/lifecycle.ts']; value.contentDigest = sha256(canonicalJSON(value.files)); });
  await assert.rejects(checkStagingRelease(input), code('STAGING_ARTIFACT_INVALID'));
}));

test('offline checks make no fetch calls and leave local artifacts unchanged', async () => fixture(async ({ input, artifact }) => {
  const before = await readFile(path.join(artifact, 'public-manifest.json'));
  const names = await readdir(artifact); let calls = 0; const prior = globalThis.fetch;
  try {
    globalThis.fetch = async () => { calls++; throw Error('No network is authorized'); };
    const result = await checkStagingRelease(input); assert.equal(result.hostedChecksPerformed, false);
  } finally { globalThis.fetch = prior; }
  assert.equal(calls, 0); assert.deepEqual(await readFile(path.join(artifact, 'public-manifest.json')), before);
  assert.deepEqual(await readdir(artifact), names);
}));

test('JSON checklists are bounded and parsed without leaking invalid contents', async () => fixture(async ({ directory, input }) => {
  const name = path.join(directory, 'checklist.json'); await writeFile(name, JSON.stringify(input));
  assert.deepEqual(await readStagingChecklist(name), input);
  await writeFile(name, 'private-secret-not-json'); await assert.rejects(readStagingChecklist(name), code('STAGING_CHECKLIST_INVALID'));
  await writeFile(name, ' '.repeat(65537)); await assert.rejects(readStagingChecklist(name), code('STAGING_CHECKLIST_INVALID'));
  await assert.rejects(readStagingChecklist('https://private.test/checklist'), code('STAGING_ARGUMENT_INVALID'));
}));

test('CLI success exposes only safe identities and explicit manual gates', async () => fixture(async ({ directory, input }) => {
  const name = path.join(directory, 'checklist.json'); await writeFile(name, JSON.stringify(input));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/check-staging-release.ts', '--checklist', name], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0);
  const body = JSON.parse(result.stdout.trim()); assert.equal(body.offlineChecksPassed, true); assert.equal(body.externalDeploymentAuthorized, false);
  assert.equal(result.stdout.includes(directory), false); assert.equal(result.stdout.includes(input.stagingUrl), false);
}));

test('CLI failures are nonzero sanitized JSON and never include private checklist values', async () => fixture(async ({ directory, input }) => {
  const name = path.join(directory, 'private-secret-checklist.json');
  await writeFile(name, JSON.stringify({ ...input, stagingUrl: 'https://private-user:private-secret@fictional.test' }));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/check-staging-release.ts', '--checklist', name], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 1);
  const line = result.stderr.split('\n').find(value => value.startsWith('{')); assert.ok(line);
  assert.deepEqual(JSON.parse(line), { event: 'staging_release_check_failed', code: 'STAGING_ORIGIN_INVALID' });
  assert.doesNotMatch(result.stdout + result.stderr, /private-user|private-secret|fictional\.test/);
  assert.equal(result.stderr.includes(directory), false);
}));
