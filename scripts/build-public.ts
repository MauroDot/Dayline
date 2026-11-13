/** Reproducible allowlisted directory build. No network, dependency install or image publication. */
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactError, canonicalJSON, inspectPublicArtifact, manifestName, optionalPublicFiles, publicPackage,
  regularBytes, rejectEmbeddedCredentials, requiredPublicFiles, sha256, verifyPublicModuleGraph, type PublicManifest } from './inspect-public.ts';

export interface PublicBuildOptions { sourceRoot?: string; outputRoot?: string }
function git(root: string, ...args: string[]): string {
  try { return execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new ArtifactError('PUBLIC_PROVENANCE_INVALID'); }
}
async function exists(name: string): Promise<boolean> {
  try { await lstat(name); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function safeDestination(source: string, output: string): Promise<void> {
  if (output === source || source.startsWith(output + path.sep)) throw new ArtifactError('PUBLIC_OUTPUT_UNSAFE');
  if (output.startsWith(source + path.sep) && !output.startsWith(path.join(source, 'dist') + path.sep)) throw new ArtifactError('PUBLIC_OUTPUT_UNSAFE');
  // No existing directory is removed or overwritten, even one left by an earlier build.
  if (await exists(output)) throw new ArtifactError('PUBLIC_OUTPUT_EXISTS');
  let current = path.dirname(output);
  for (;;) {
    if (await exists(current)) {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ArtifactError('PUBLIC_OUTPUT_UNSAFE');
    }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}

export async function buildPublicArtifact(options: PublicBuildOptions = {}): Promise<PublicManifest> {
  const source = path.resolve(options.sourceRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const output = path.resolve(options.outputRoot ?? path.join(source, 'dist/public-reader'));
  await safeDestination(source, output);
  if (path.resolve(git(source, 'rev-parse', '--show-toplevel')) !== source) throw new ArtifactError('PUBLIC_PROVENANCE_INVALID');
  const commit = git(source, 'rev-parse', 'HEAD'), tree = git(source, 'rev-parse', 'HEAD^{tree}');
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree)) throw new ArtifactError('PUBLIC_PROVENANCE_INVALID');
  const sourceDirty = git(source, 'status', '--porcelain=v1').length !== 0;
  const files = new Map<string, Buffer>();
  for (const name of requiredPublicFiles) files.set(name, await regularBytes(source, name));
  for (const name of optionalPublicFiles) if (await exists(path.join(source, name))) files.set(name, await regularBytes(source, name));
  for (const bytes of files.values()) rejectEmbeddedCredentials(bytes);
  verifyPublicModuleGraph(files);
  let pkg: unknown;
  try { pkg = JSON.parse((await regularBytes(source, 'package.json')).toString('utf8')); } catch { throw new ArtifactError('PUBLIC_PACKAGE_INVALID'); }
  if (pkg === null || typeof pkg !== 'object' || typeof (pkg as { version?: unknown }).version !== 'string') throw new ArtifactError('PUBLIC_PACKAGE_INVALID');
  files.set('package.json', Buffer.from(publicPackage((pkg as { version: string }).version)));
  const entries = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, { sha256: sha256(bytes), bytes: bytes.byteLength }]));
  const manifest: PublicManifest = { schema: 1, artifact: 'dayline-public-reader', runtime: { node: '22.16.0', entry: 'src/public/main.ts' },
    provenance: { commit, tree, sourceDirty }, files: entries, contentDigest: sha256(canonicalJSON(entries)) };
  // Validate all inputs and provenance before the first output write.
  await mkdir(output, { recursive: true, mode: 0o755 });
  for (const [name, bytes] of files) {
    await mkdir(path.dirname(path.join(output, name)), { recursive: true, mode: 0o755 });
    await writeFile(path.join(output, name), bytes, { flag: 'wx', mode: 0o644 });
  }
  await writeFile(path.join(output, manifestName), canonicalJSON(manifest), { flag: 'wx', mode: 0o644 });
  await inspectPublicArtifact(output);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let outputRoot: string | undefined;
    if (process.argv.length !== 2) {
      if (process.argv.length !== 4 || process.argv[2] !== '--output' || !process.argv[3]) throw new ArtifactError('PUBLIC_ARGUMENT_INVALID');
      outputRoot = path.resolve(process.argv[3]);
    }
    const manifest = await buildPublicArtifact({ outputRoot });
    console.log(JSON.stringify({ ok: true, artifact: manifest.artifact, commit: manifest.provenance.commit,
      sourceDirty: manifest.provenance.sourceDirty, files: Object.keys(manifest.files).length, contentDigest: manifest.contentDigest }));
  } catch { console.error(JSON.stringify({ ok: false, error: 'PUBLIC_BUILD_FAILED' })); process.exitCode = 1; }
}
