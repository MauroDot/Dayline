import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPublicArtifact } from '../scripts/build-public.ts';
import { canonicalJSON, inspectPublicArtifact, manifestName, optionalPublicFiles, requiredPublicFiles,
  sha256, type PublicManifest } from '../scripts/inspect-public.ts';
import { checkStagingRelease, type StagingReleaseChecklist } from '../scripts/check-staging-release.ts';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputs = [...requiredPublicFiles, ...optionalPublicFiles, 'package.json'];
const sentinel = 'checkout-conversion-control.txt';
type Git = (directory: string, ...args: string[]) => string;
type CheckoutFixture = {
  directory: string;
  seed: string;
  git: Git;
  clone: (name: string, autocrlf: boolean) => string;
  output: (name: string) => string;
};

/** Local Git checkouts exercise conversion on the executing OS; this is not Windows acceptance. */
async function fixture(run: (fixture: CheckoutFixture) => Promise<void>, withPolicy = true): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'dayline-checkout-eol-'));
  try {
    const seed = path.join(directory, 'seed');
    const emptyConfig = path.join(directory, 'empty-git-config');
    const emptyAttributes = path.join(directory, 'empty-global-attributes');
    const emptyHooks = path.join(directory, 'empty-hooks');
    await Promise.all([mkdir(seed), mkdir(emptyHooks), writeFile(emptyConfig, ''), writeFile(emptyAttributes, '')]);
    // Ignore external Git configuration, attributes, hooks and inherited repository selectors.
    // No original checkout, global configuration or environment variable is modified.
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig,
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' });
    const git: Git = (cwd, ...args) => execFileSync('git', ['-c', `core.attributesFile=${emptyAttributes}`,
      '-c', `core.hooksPath=${emptyHooks}`, '-c', 'core.fsmonitor=false', ...args],
    { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const name of inputs) {
      const bytes = await readFile(path.join(project, name));
      assert.equal(bytes.includes(0x0d), false, `fixture source must already be LF: ${name}`);
      await mkdir(path.dirname(path.join(seed, name)), { recursive: true });
      await writeFile(path.join(seed, name), bytes);
    }
    if (withPolicy) await writeFile(path.join(seed, '.gitattributes'), await readFile(path.join(project, '.gitattributes')));
    await writeFile(path.join(seed, sentinel), 'Fictional un-attributed checkout conversion control.\nSecond line.\n');
    git(seed, 'init', '-q', '--initial-branch=fixture');
    git(seed, 'config', '--local', 'core.autocrlf', 'false');
    git(seed, 'config', '--local', 'core.attributesFile', emptyAttributes);
    git(seed, 'config', '--local', 'core.hooksPath', emptyHooks);
    git(seed, 'add', '--', '.');
    commit(git, seed, 'Fictional canonical LF checkout fixture');
    const clone = (name: string, autocrlf: boolean): string => {
      const checkout = path.join(directory, name);
      // clone -c installs local configuration before its first checkout, including on Linux.
      git(directory, 'clone', '--quiet', '--no-hardlinks', '-c', `core.autocrlf=${autocrlf}`,
        '-c', 'core.safecrlf=false', '-c', `core.attributesFile=${emptyAttributes}`,
        '-c', `core.hooksPath=${emptyHooks}`, '-c', 'core.fsmonitor=false', seed, checkout);
      return checkout;
    };
    await run({ directory, seed, git, clone, output: name => path.join(directory, name) });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function commit(git: Git, directory: string, message: string): void {
  git(directory, '-c', 'user.name=Fictional EOL Test', '-c', 'user.email=fixture@eol.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
}
function clean(git: Git, directory: string): void { assert.equal(git(directory, 'status', '--porcelain=v1'), ''); }
function checklist(artifactRoot: string, manifest: PublicManifest): StagingReleaseChecklist {
  return { artifactRoot, expectedCommit: manifest.provenance.commit, expectedDigest: manifest.contentDigest,
    stagingUrl: 'https://fictional-staging.example.test', autoDeploy: false,
    previous: { commit: 'a'.repeat(40), contentDigest: 'b'.repeat(64) } };
}
function crlf(bytes: Buffer): Buffer {
  assert.equal(bytes.includes(0x0d), false);
  assert.equal(bytes.includes(0x0a), true, 'conversion control requires a newline');
  return Buffer.from(bytes.toString('utf8').replaceAll('\n', '\r\n'));
}
async function listed(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await listed(root, name)); else result.push(name);
  }
  return result.sort();
}
async function alterCache(source: string): Promise<void> {
  const filename = path.join(source, 'src/cache.ts'), before = await readFile(filename, 'utf8');
  // A real policy value changes; line endings are preserved rather than normalized.
  const after = before.replace('24 * 60 * 60 * 1000', '12 * 60 * 60 * 1000');
  assert.notEqual(after, before, 'fixture must change the stale-window policy');
  await writeFile(filename, after);
}

test('explicit repository attributes keep fresh autocrlf checkouts and full artifacts byte-identical', async () => fixture(async f => {
  const paths = [...inputs, '.gitattributes'];
  const policy = (await readFile(path.join(f.seed, '.gitattributes'), 'utf8')).split('\n')
    .filter(line => line && !line.startsWith('#')).map(line => line.trim().split(/\s+/));
  assert.deepEqual(policy.map(rule => rule[0]).sort(), paths.map(name => `/${name}`).sort());
  for (const rule of policy) assert.deepEqual(rule.slice(1), ['text', 'eol=lf']);
  const lf = f.clone('autocrlf-false', false), automatic = f.clone('autocrlf-true', true);
  const manifests: PublicManifest[] = [];
  for (const [index, source] of [lf, automatic].entries()) {
    const attributes = f.git(source, 'check-attr', '-z', 'text', 'eol', '--', ...paths).split('\0');
    assert.deepEqual(attributes, paths.flatMap(name => [name, 'text', 'set', name, 'eol', 'lf']).concat(''));
    for (const name of paths) {
      const bytes = await readFile(path.join(source, name));
      assert.equal(bytes.includes(0x0d), false, `${name} must have actual LF bytes`);
      assert.deepEqual(bytes, await readFile(path.join(f.seed, name)));
    }
    clean(f.git, source);
    const artifact = f.output(`artifact-${index}`);
    const manifest = await buildPublicArtifact({ sourceRoot: source, outputRoot: artifact });
    assert.equal(Object.keys(manifest.files).length, 11);
    assert.equal((await listed(artifact)).length, 12);
    assert.deepEqual(await listed(artifact), [...inputs, manifestName].sort());
    assert.equal(manifest.provenance.sourceDirty, false);
    assert.equal(manifest.provenance.commit, f.git(f.seed, 'rev-parse', 'HEAD').trim());
    assert.equal(manifest.provenance.tree, f.git(f.seed, 'rev-parse', 'HEAD^{tree}').trim());
    assert.deepEqual(await inspectPublicArtifact(artifact), manifest);
    assert.equal((await checkStagingRelease(checklist(artifact, manifest))).externalDeploymentAuthorized, false);
    manifests.push(manifest);
    clean(f.git, source);
  }
  // This un-attributed file proves autocrlf actually converted a fresh checkout on this OS.
  assert.equal((await readFile(path.join(lf, sentinel))).includes(0x0d), false);
  assert.equal((await readFile(path.join(automatic, sentinel))).includes(Buffer.from('\r\n')), true);
  assert.deepEqual(manifests[0], manifests[1]);
  for (const name of await listed(f.output('artifact-0'))) {
    assert.deepEqual(await readFile(path.join(f.output('artifact-0'), name)), await readFile(path.join(f.output('artifact-1'), name)));
  }
}));

test('negative control without repository attributes produces clean CRLF source and build rejection', async () => fixture(async f => {
  const source = f.clone('without-policy-autocrlf-true', true);
  for (const name of inputs) {
    assert.equal((await readFile(path.join(source, name))).includes(Buffer.from('\r\n')), true, name);
    assert.equal(f.git(source, 'check-attr', 'text', 'eol', '--', name), `${name}: text: unspecified\n${name}: eol: unspecified\n`);
  }
  clean(f.git, source);
  const before = await readFile(path.join(source, 'src/cache.ts')), output = f.output('rejected-no-policy');
  await assert.rejects(buildPublicArtifact({ sourceRoot: source, outputRoot: output }), /PUBLIC_LINE_ENDING_INVALID/);
  await assert.rejects(access(output), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(source, 'src/cache.ts')), before);
  clean(f.git, source);
}, false));

test('normalized-clean CRLF injection is rejected for every copied input and source package without rewriting', async () => fixture(async f => {
  const source = f.clone('normalized-clean', true);
  for (const [index, name] of inputs.entries()) {
    const filename = path.join(source, name), original = await readFile(filename), injected = crlf(original);
    await writeFile(filename, injected);
    // Refresh only this disposable index through Git's text conversion. The index blob
    // still equals HEAD while Git now records the noncanonical working bytes as clean.
    f.git(source, 'add', '--', name);
    assert.equal(f.git(source, 'rev-parse', `:${name}`), f.git(source, 'rev-parse', `HEAD:${name}`));
    assert.equal(f.git(source, 'diff', '--cached', '--name-only'), '');
    clean(f.git, source);
    const output = f.output(`rejected-injected-${index}`);
    await assert.rejects(buildPublicArtifact({ sourceRoot: source, outputRoot: output }), /PUBLIC_LINE_ENDING_INVALID/, name);
    await assert.rejects(access(output), { code: 'ENOENT' });
    assert.deepEqual(await readFile(filename), injected, 'failed builds must not normalize source bytes');
    await writeFile(filename, original);
    f.git(source, 'add', '--', name);
    clean(f.git, source);
  }
}));

test('semantic LF source edits are recorded as dirty and cannot pass offline release checks', async () => fixture(async f => {
  const source = f.clone('dirty-lf', true), baselineRoot = f.output('baseline');
  const baseline = await buildPublicArtifact({ sourceRoot: source, outputRoot: baselineRoot });
  await alterCache(source);
  const bytes = await readFile(path.join(source, 'src/cache.ts'));
  assert.equal(bytes.includes(0x0d), false);
  assert.match(f.git(source, 'status', '--porcelain=v1'), / M src\/cache\.ts/);
  const artifact = f.output('dirty-artifact'), changed = await buildPublicArtifact({ sourceRoot: source, outputRoot: artifact });
  assert.equal(changed.provenance.sourceDirty, true);
  assert.equal(changed.provenance.commit, baseline.provenance.commit);
  assert.equal(changed.provenance.tree, baseline.provenance.tree);
  assert.notEqual(changed.files['src/cache.ts'].sha256, baseline.files['src/cache.ts'].sha256);
  assert.notEqual(changed.contentDigest, baseline.contentDigest);
  assert.equal(changed.files['src/cache.ts'].sha256, sha256(bytes));
  await assert.rejects(checkStagingRelease(checklist(artifact, changed)), /STAGING_SOURCE_NOT_CLEAN/);
}));

test('committed semantic LF changes have distinct clean provenance and reject old release identities', async () => fixture(async f => {
  const source = f.clone('committed-lf', true);
  const baseline = await buildPublicArtifact({ sourceRoot: source, outputRoot: f.output('before-commit') });
  await alterCache(source);
  f.git(source, 'add', '--', 'src/cache.ts');
  commit(f.git, source, 'Fictional committed stale-window change');
  clean(f.git, source);
  const artifact = f.output('after-commit'), changed = await buildPublicArtifact({ sourceRoot: source, outputRoot: artifact });
  assert.equal(changed.provenance.sourceDirty, false);
  assert.notEqual(changed.provenance.commit, baseline.provenance.commit);
  assert.notEqual(changed.provenance.tree, baseline.provenance.tree);
  assert.notEqual(changed.files['src/cache.ts'].sha256, baseline.files['src/cache.ts'].sha256);
  assert.notEqual(changed.contentDigest, baseline.contentDigest);
  const input = checklist(artifact, changed);
  await assert.rejects(checkStagingRelease({ ...input, expectedCommit: baseline.provenance.commit }), /STAGING_COMMIT_MISMATCH/);
  await assert.rejects(checkStagingRelease({ ...input, expectedDigest: baseline.contentDigest }), /STAGING_DIGEST_MISMATCH/);
  assert.equal((await checkStagingRelease(input)).offlineChecksPassed, true);
  clean(f.git, source);
}));

test('artifact CRLF is rejected even when its hashes and digest have been recomputed', async () => fixture(async f => {
  const source = f.clone('artifact-crlf', false), artifact = f.output('artifact');
  const manifest = await buildPublicArtifact({ sourceRoot: source, outputRoot: artifact });
  for (const name of Object.keys(manifest.files)) {
    const filename = path.join(artifact, name), original = await readFile(filename), injected = crlf(original);
    await writeFile(filename, injected);
    const changed: PublicManifest = structuredClone(manifest);
    changed.files[name] = { sha256: sha256(injected), bytes: injected.byteLength };
    changed.contentDigest = sha256(canonicalJSON(changed.files));
    await writeFile(path.join(artifact, manifestName), canonicalJSON(changed));
    await assert.rejects(inspectPublicArtifact(artifact), /PUBLIC_LINE_ENDING_INVALID/, name);
    await assert.rejects(checkStagingRelease(checklist(artifact, changed)), /STAGING_ARTIFACT_INVALID/);
    assert.deepEqual(await readFile(filename), injected);
    await writeFile(filename, original);
    await writeFile(path.join(artifact, manifestName), canonicalJSON(manifest));
  }
  await writeFile(path.join(artifact, manifestName), crlf(Buffer.from(canonicalJSON(manifest))));
  await assert.rejects(inspectPublicArtifact(artifact), /PUBLIC_MANIFEST_INVALID/);
  clean(f.git, source);
}));

test('LF canonicalization preserves ordinary tamper and excluded-file rejection', async () => fixture(async f => {
  const source = f.clone('ordinary-tamper', false), artifact = f.output('artifact');
  const manifest = await buildPublicArtifact({ sourceRoot: source, outputRoot: artifact });
  const filename = path.join(artifact, 'public/app.js'), original = await readFile(filename);
  await writeFile(filename, Buffer.concat([original, Buffer.from('\nconsole.log("fictional tamper");\n')]));
  await assert.rejects(inspectPublicArtifact(artifact), /PUBLIC_HASH_MISMATCH/);
  await assert.rejects(checkStagingRelease(checklist(artifact, manifest)), /STAGING_ARTIFACT_INVALID/);
  await writeFile(filename, original);
  await writeFile(path.join(artifact, 'excluded-fixture.txt'), 'Fictional excluded file.\n');
  await assert.rejects(inspectPublicArtifact(artifact), /PUBLIC_INVENTORY_INVALID/);
  await assert.rejects(checkStagingRelease(checklist(artifact, manifest)), /STAGING_ARTIFACT_INVALID/);
  clean(f.git, source);
}));
