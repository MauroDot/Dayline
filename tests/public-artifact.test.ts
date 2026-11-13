import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildPublicArtifact } from '../scripts/build-public.ts';
import { canonicalJSON, inspectPublicArtifact, manifestName, requiredPublicFiles, sha256, type PublicManifest } from '../scripts/inspect-public.ts';
import { symlinkCapability } from './helpers/symlink-capability.ts';

type Fixture = { directory: string; source: string; output: (name?: string) => string };
async function fixture(work: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'dayline-public-build-'));
  const source = path.join(directory, 'source');
  try {
    await mkdir(source);
    const contents: Record<string, string> = {
      'src/public/config.ts': 'export const mode = "production";\n',
      'src/public/main.ts': 'import { createPublicServer } from "./reader.ts";\nvoid createPublicServer;\n',
      'src/public/reader.ts': 'import { mode } from "./config.ts";\nimport { createServer } from "node:http";\nexport const createPublicServer = () => createServer((_req, res) => res.end(mode));\n',
      'src/cache.ts': 'export const cache = new Map();\n', 'src/official-data.ts': 'export const official = true;\n',
      'public/index.html': '<!doctype html><title>Dayline</title>\n', 'public/style.css': 'body { color: black; }\n',
      'public/app.js': 'console.log("reader");\n', 'public/stories.js': 'const fictional = true;\n',
      'package.json': '{"name":"dayline","version":"0.1.0","private":true,"type":"module"}\n',
    };
    for (const [name, text] of Object.entries(contents)) { await mkdir(path.dirname(path.join(source, name)), { recursive: true }); await writeFile(path.join(source, name), text); }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: source, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: 'pipe' });
    git('init', '-q'); git('add', '--', '.');
    git('-c', 'user.name=Fictional Test', '-c', 'user.email=fixture@fiction.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fictional artifact fixture');
    await work({ directory, source, output: (name = 'artifact') => path.join(directory, name) });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function listed(root: string, prefix = ''): Promise<string[]> {
  const all: string[] = [];
  for (const item of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) all.push(...await listed(root, name)); else all.push(name);
  }
  return all.sort();
}
async function rewriteManifest(root: string, work: (manifest: PublicManifest) => void): Promise<void> {
  const manifest: PublicManifest = JSON.parse(await readFile(path.join(root, manifestName), 'utf8'));
  work(manifest); manifest.contentDigest = sha256(canonicalJSON(manifest.files));
  await writeFile(path.join(root, manifestName), canonicalJSON(manifest));
}
async function changedFile(root: string, name: string, contents: string): Promise<void> {
  await writeFile(path.join(root, name), contents);
  await rewriteManifest(root, manifest => { manifest.files[name] = { sha256: sha256(contents), bytes: Buffer.byteLength(contents) }; });
}

test('public build is byte-deterministic and contains only pinned reader runtime files', async () => fixture(async f => {
  const a = f.output('one'), b = f.output('two');
  const first = await buildPublicArtifact({ sourceRoot: f.source, outputRoot: a });
  const second = await buildPublicArtifact({ sourceRoot: f.source, outputRoot: b });
  assert.deepEqual(first, second); assert.equal(first.provenance.sourceDirty, false);
  assert.match(first.provenance.commit, /^[a-f0-9]{40}$/);
  assert.deepEqual(await listed(a), [...requiredPublicFiles, 'package.json', manifestName].sort());
  for (const name of await listed(a)) assert.deepEqual(await readFile(path.join(a, name)), await readFile(path.join(b, name)));
  const pkg = JSON.parse(await readFile(path.join(a, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '22.16.0'); assert.equal(pkg.type, 'module');
  assert.equal(pkg.scripts.start, 'node --experimental-strip-types src/public/main.ts');
  assert.equal(pkg.dependencies, undefined); assert.equal(pkg.devDependencies, undefined);
  assert.deepEqual(await inspectPublicArtifact(a), first);
}));

test('dirty source builds identify the baseline commit plus actual uncommitted file hashes', async () => fixture(async f => {
  const text = 'export const mode = "staging";\n'; await writeFile(path.join(f.source, 'src/public/config.ts'), text);
  const manifest = await buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() });
  assert.equal(manifest.provenance.sourceDirty, true); assert.equal(manifest.files['src/public/config.ts'].sha256, sha256(text));
}));

test('allowlist excludes environment credentials databases privileged services fixtures and test artifacts', async () => fixture(async f => {
  const excluded = ['.env', '.env.production', 'local.json', 'node_modules/secret.js', 'src/security/http.ts', 'src/newsroom/store.ts', 'fixtures/security-fiction.ts', 'tests/private.test.ts', 'server.ts'];
  for (const name of excluded) { await mkdir(path.dirname(path.join(f.source, name)), { recursive: true }); await writeFile(path.join(f.source, name), 'PRIVATE_FIXTURE_SENTINEL'); }
  await buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() });
  const files = await listed(f.output()); assert.equal(files.some(name => excluded.includes(name)), false);
  for (const name of files) assert.equal((await readFile(path.join(f.output(), name), 'utf8')).includes('PRIVATE_FIXTURE_SENTINEL'), false);
}));

test('privileged static and type-only imports are rejected before any artifact output is written', async () => fixture(async f => {
  for (const contents of ['import "../security/http.ts";\n', 'export * from "../newsroom/store.ts";\n', 'export type Private = import("../security/types.ts").Principal;\n']) {
    await writeFile(path.join(f.source, 'src/public/main.ts'), contents);
    await assert.rejects(buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() }), /PUBLIC_DEPENDENCY_FORBIDDEN/);
    await assert.rejects(access(f.output()));
  }
}));

test('dynamic import bare dependencies and runtime code-generation escape paths fail closed', async () => fixture(async f => {
  for (const contents of ['const name = "../security/http.ts"; await import(name);\n', 'await import("../security/http.ts");\n', 'import "third-party-package";\n', 'require("../security/http.ts");\n', 'eval("import(unknown)");\n', 'new Function("return 1")();\n']) {
    await writeFile(path.join(f.source, 'src/public/main.ts'), contents);
    await assert.rejects(buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() }), /PUBLIC_DEPENDENCY_FORBIDDEN/);
    await assert.rejects(access(f.output()));
  }
}));

test('privileged builtin process and module loaders are excluded from the runtime dependency graph', async () => fixture(async f => {
  for (const name of ['node:child_process', 'node:module', 'node:vm', 'node:worker_threads']) {
    await writeFile(path.join(f.source, 'src/public/main.ts'), `import ${JSON.stringify(name)};\n`);
    await assert.rejects(buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() }), /PUBLIC_DEPENDENCY_FORBIDDEN/);
    await assert.rejects(access(f.output()));
  }
}));

test('source symlinks cannot pull private files into the runtime artifact', async context => {
  const capability = await symlinkCapability('file');
  if (!capability.supported) { context.skip(capability.reason); return; }
  await fixture(async f => {
    const original = path.join(f.source, 'src/public/config.ts'); await rm(original);
    const secret = path.join(f.directory, 'private.txt'); await writeFile(secret, 'PRIVATE_SENTINEL'); await symlink(secret, original, 'file');
    await assert.rejects(buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() }), /PUBLIC_PATH_INVALID/);
    await assert.rejects(access(f.output()));
  });
});

test('existing output source roots and ancestors preserve existing work', async () => fixture(async f => {
  const output = f.output(); await mkdir(output); await writeFile(path.join(output, 'sentinel'), 'KEEP');
  await assert.rejects(buildPublicArtifact({ sourceRoot: f.source, outputRoot: output }), /PUBLIC_OUTPUT_EXISTS/);
  assert.equal(await readFile(path.join(output, 'sentinel'), 'utf8'), 'KEEP');
  for (const candidate of [f.source, f.directory, path.join(f.source, 'src', 'generated')]) await assert.rejects(buildPublicArtifact({ sourceRoot: f.source, outputRoot: candidate }), /PUBLIC_OUTPUT_UNSAFE/);
}));

test('symlink destinations preserve existing work', async context => {
  const capability = await symlinkCapability('dir');
  if (!capability.supported) { context.skip(capability.reason); return; }
  await fixture(async f => {
    const target = path.join(f.directory, 'target'); await mkdir(target); await writeFile(path.join(target, 'sentinel'), 'KEEP');
    const linked = path.join(f.directory, 'linked'); await symlink(target, linked, 'dir');
    await assert.rejects(buildPublicArtifact({ sourceRoot: f.source, outputRoot: path.join(linked, 'new') }), /PUBLIC_OUTPUT_UNSAFE/);
    assert.deepEqual(await readdir(target), ['sentinel']);
  });
});

test('private-key and access-token patterns embedded in allowed source files block artifact creation', async () => fixture(async f => {
  for (const text of ['-----BEGIN PRIVATE KEY-----', 'ghp_' + 'a'.repeat(40), 'sk-proj-' + 'a'.repeat(40), 'AKIA' + 'A'.repeat(16)]) {
    await writeFile(path.join(f.source, 'public/app.js'), `const accidentallyCommitted = ${JSON.stringify(text)};\n`);
    await assert.rejects(buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() }), /PUBLIC_SECRET_FORBIDDEN/);
    await assert.rejects(access(f.output()));
  }
}));

test('artifact inspection rejects added excluded files and modified runtime bytes', async () => fixture(async f => {
  await buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() });
  await writeFile(path.join(f.output(), '.env'), 'PRIVATE'); await assert.rejects(inspectPublicArtifact(f.output()), /PUBLIC_INVENTORY_INVALID/);
  await rm(path.join(f.output(), '.env'));
  await writeFile(path.join(f.output(), 'public/app.js'), 'changed'); await assert.rejects(inspectPublicArtifact(f.output()), /PUBLIC_HASH_MISMATCH/);
}));

test('manifest cannot widen the artifact allowlist or weaken runtime metadata', async () => fixture(async f => {
  await buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() });
  await rewriteManifest(f.output(), manifest => { manifest.files['.env'] = { sha256: sha256('PRIVATE'), bytes: 7 }; });
  await assert.rejects(inspectPublicArtifact(f.output()), /PUBLIC_INVENTORY_INVALID/);
  await rm(f.output(), { recursive: true }); await buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() });
  const file = path.join(f.output(), manifestName); const parsed = JSON.parse(await readFile(file, 'utf8')); parsed.runtime.node = 'latest';
  await writeFile(file, canonicalJSON(parsed)); await assert.rejects(inspectPublicArtifact(f.output()), /PUBLIC_MANIFEST_INVALID/);
}));

test('inspection independently rejects rehashed dependency and secret payloads', async () => fixture(async f => {
  await buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() });
  await changedFile(f.output(), 'src/public/main.ts', 'import "../security/http.ts";\n');
  await assert.rejects(inspectPublicArtifact(f.output()), /PUBLIC_DEPENDENCY_FORBIDDEN/);
  await changedFile(f.output(), 'src/public/main.ts', 'export const main = true;\n');
  await changedFile(f.output(), 'public/app.js', `const key = ${JSON.stringify('ghp_' + 'a'.repeat(40))};\n`);
  await assert.rejects(inspectPublicArtifact(f.output()), /PUBLIC_SECRET_FORBIDDEN/);
}));

test('inspection rejects dependency-bearing runtime package even with recomputed hashes', async () => fixture(async f => {
  await buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() });
  const pkg = JSON.parse(await readFile(path.join(f.output(), 'package.json'), 'utf8')); pkg.dependencies = { unsafe: '*' };
  await changedFile(f.output(), 'package.json', canonicalJSON(pkg));
  await assert.rejects(inspectPublicArtifact(f.output()), /PUBLIC_PACKAGE_INVALID/);
}));

test('inspection rejects linked files', async context => {
  const capability = await symlinkCapability('file');
  if (!capability.supported) { context.skip(capability.reason); return; }
  await fixture(async f => {
    await buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() });
    const app = path.join(f.output(), 'public/app.js'); const saved = path.join(f.directory, 'app.js'); await writeFile(saved, await readFile(app)); await rm(app); await symlink(saved, app, 'file');
    await assert.rejects(inspectPublicArtifact(f.output()), /PUBLIC_PATH_INVALID/);
  });
});

test('inspection rejects noncanonical duplicate-key manifests', async () => fixture(async f => {
  await buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() });
  const manifest = path.join(f.output(), manifestName); const bytes = await readFile(manifest, 'utf8');
  await writeFile(manifest, bytes.replace('{\n', '{\n  "schema": 1,\n'));
  await assert.rejects(inspectPublicArtifact(f.output()), /PUBLIC_MANIFEST_INVALID/);
}));

test('build requires a valid source package and real local Git provenance without output side effects', async () => fixture(async f => {
  await writeFile(path.join(f.source, 'package.json'), '{"version":"not-a-version"}');
  await assert.rejects(buildPublicArtifact({ sourceRoot: f.source, outputRoot: f.output() }), /PUBLIC_PACKAGE_INVALID/);
  await assert.rejects(access(f.output()));
  const absent = path.join(f.directory, 'not-a-repository'); await mkdir(absent);
  await assert.rejects(buildPublicArtifact({ sourceRoot: absent, outputRoot: f.output() }), /PUBLIC_PROVENANCE_INVALID/);
  await assert.rejects(access(f.output()));
}));
