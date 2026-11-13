/** Local artifact inspection. This is build tooling, never part of the deployed reader. */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

export const requiredPublicFiles = Object.freeze([
  'src/public/config.ts', 'src/public/main.ts', 'src/public/reader.ts',
  'src/cache.ts', 'src/official-data.ts',
  'public/index.html', 'public/style.css', 'public/app.js', 'public/stories.js',
]);
export const optionalPublicFiles = Object.freeze(['src/public/lifecycle.ts']);
export const manifestName = 'public-manifest.json';
export interface PublicManifest {
  schema: 1;
  artifact: 'dayline-public-reader';
  runtime: { node: '22.16.0'; entry: 'src/public/main.ts' };
  provenance: { commit: string; tree: string; sourceDirty: boolean };
  files: Record<string, { sha256: string; bytes: number }>;
  contentDigest: string;
}
export class ArtifactError extends Error {
  constructor(code: string) { super(code); this.name = 'ArtifactError'; }
}
export function sha256(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
/** The public allowlist is text only. Reject noncanonical checkout bytes; never rewrite them. */
export function rejectNonLFText(bytes: Buffer): void {
  if (bytes.includes(0x0d)) throw new ArtifactError('PUBLIC_LINE_ENDING_INVALID');
}
export function rejectEmbeddedCredentials(bytes: Buffer): void {
  const text = bytes.toString('utf8');
  if ([/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9_]{25,}|github_pat_[A-Za-z0-9_]{25,})\b/,
    /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{25,}\b/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/].some(pattern => pattern.test(text))) throw new ArtifactError('PUBLIC_SECRET_FORBIDDEN');
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered((value as Record<string, unknown>)[key])]));
  return value;
}
export function canonicalJSON(value: unknown): string { return JSON.stringify(ordered(value), null, 2) + '\n'; }
export function publicPackage(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new ArtifactError('PUBLIC_PACKAGE_INVALID');
  return canonicalJSON({ name: 'dayline-public-reader', private: true, version, type: 'module',
    engines: { node: '22.16.0' }, scripts: { start: 'node --experimental-strip-types src/public/main.ts' } });
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).sort().join(',') === keys.sort().join(','); }
const allowedSource = new Set([...requiredPublicFiles, ...optionalPublicFiles]);
const runtimeBuiltins = new Set(['node:crypto', 'node:fs/promises', 'node:http', 'node:net', 'node:path', 'node:url']);

/** Reject links in every component rather than trusting a final-file-only lstat. */
export async function regularBytes(root: string, relative: string): Promise<Buffer> {
  if (relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new ArtifactError('PUBLIC_PATH_INVALID');
  let current = root;
  if (!(await lstat(current)).isDirectory() || (await lstat(current)).isSymbolicLink()) throw new ArtifactError('PUBLIC_PATH_INVALID');
  const segments = relative.split('/');
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new ArtifactError('PUBLIC_PATH_INVALID');
  }
  return readFile(current);
}

/** Parse actual TypeScript/JavaScript imports, including dynamic and type-only imports. */
export function verifyPublicModuleGraph(files: ReadonlyMap<string, Buffer>): void {
  for (const [name, bytes] of files) {
    if (!name.endsWith('.ts') && !name.endsWith('.js')) continue;
    const source = ts.createSourceFile(name, bytes.toString('utf8'), ts.ScriptTarget.Latest, true,
      name.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    if ((source as ts.SourceFile & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length) throw new ArtifactError('PUBLIC_MODULE_INVALID');
    function dependency(specifier: string): void {
      if (runtimeBuiltins.has(specifier)) return;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new ArtifactError('PUBLIC_DEPENDENCY_FORBIDDEN');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
      if (!allowedSource.has(resolved) || !files.has(resolved)) throw new ArtifactError('PUBLIC_DEPENDENCY_FORBIDDEN');
    }
    function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) {
          if (!ts.isStringLiteral(node.moduleSpecifier)) throw new ArtifactError('PUBLIC_MODULE_INVALID');
          dependency(node.moduleSpecifier.text);
        }
      } else if (ts.isImportTypeNode(node)) {
        if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) throw new ArtifactError('PUBLIC_MODULE_INVALID');
        dependency(node.argument.literal.text);
      } else if (ts.isImportEqualsDeclaration(node)) throw new ArtifactError('PUBLIC_DEPENDENCY_FORBIDDEN');
      else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw new ArtifactError('PUBLIC_DEPENDENCY_FORBIDDEN');
          dependency(node.arguments[0].text);
        } else if (ts.isIdentifier(node.expression) && ['require', 'eval', 'Function'].includes(node.expression.text)) throw new ArtifactError('PUBLIC_DEPENDENCY_FORBIDDEN');
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') throw new ArtifactError('PUBLIC_DEPENDENCY_FORBIDDEN');
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}

async function inventory(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await lstat(path.join(root, name));
      if (stat.isSymbolicLink()) throw new ArtifactError('PUBLIC_PATH_INVALID');
      if (stat.isDirectory()) {
        if (!['src', 'src/public', 'public'].includes(name)) throw new ArtifactError('PUBLIC_INVENTORY_INVALID');
        await walk(name);
      } else if (stat.isFile()) result.push(name);
      else throw new ArtifactError('PUBLIC_PATH_INVALID');
    }
  }
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new ArtifactError('PUBLIC_PATH_INVALID');
  await walk(''); return result.sort();
}

export async function inspectPublicArtifact(root = path.resolve('dist/public-reader')): Promise<PublicManifest> {
  const manifestBytes = await regularBytes(root, manifestName);
  let value: unknown;
  try { value = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new ArtifactError('PUBLIC_MANIFEST_INVALID'); }
  if (!record(value) || !exact(value, ['schema', 'artifact', 'runtime', 'provenance', 'files', 'contentDigest'])
    || value.schema !== 1 || value.artifact !== 'dayline-public-reader'
    || !record(value.runtime) || !exact(value.runtime, ['node', 'entry']) || value.runtime.node !== '22.16.0' || value.runtime.entry !== 'src/public/main.ts'
    || !record(value.provenance) || !exact(value.provenance, ['commit', 'tree', 'sourceDirty'])
    || typeof value.provenance.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.provenance.commit)
    || typeof value.provenance.tree !== 'string' || !/^[a-f0-9]{40}$/.test(value.provenance.tree)
    || typeof value.provenance.sourceDirty !== 'boolean' || !record(value.files)
    || typeof value.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentDigest)
    || !Buffer.from(canonicalJSON(value)).equals(manifestBytes)) throw new ArtifactError('PUBLIC_MANIFEST_INVALID');
  const expected = Object.keys(value.files).sort();
  if (!requiredPublicFiles.every(name => expected.includes(name)) || !expected.includes('package.json')
    || expected.some(name => name !== 'package.json' && !allowedSource.has(name))) throw new ArtifactError('PUBLIC_INVENTORY_INVALID');
  const actual = await inventory(root);
  if (actual.join('\0') !== [...expected, manifestName].sort().join('\0')) throw new ArtifactError('PUBLIC_INVENTORY_INVALID');
  if (value.contentDigest !== sha256(canonicalJSON(value.files))) throw new ArtifactError('PUBLIC_MANIFEST_INVALID');
  const files = new Map<string, Buffer>();
  for (const name of expected) {
    const metadata = value.files[name];
    if (!record(metadata) || !exact(metadata, ['sha256', 'bytes']) || typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256)
      || !Number.isSafeInteger(metadata.bytes) || (metadata.bytes as number) < 0) throw new ArtifactError('PUBLIC_MANIFEST_INVALID');
    const bytes = await regularBytes(root, name);
    if (bytes.byteLength !== metadata.bytes || sha256(bytes) !== metadata.sha256) throw new ArtifactError('PUBLIC_HASH_MISMATCH');
    rejectNonLFText(bytes);
    rejectEmbeddedCredentials(bytes);
    files.set(name, bytes);
  }
  let pkg: unknown;
  try { pkg = JSON.parse(files.get('package.json')!.toString('utf8')); } catch { throw new ArtifactError('PUBLIC_PACKAGE_INVALID'); }
  if (!record(pkg) || typeof pkg.version !== 'string' || publicPackage(pkg.version) !== files.get('package.json')!.toString('utf8')) throw new ArtifactError('PUBLIC_PACKAGE_INVALID');
  verifyPublicModuleGraph(files);
  return value as unknown as PublicManifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new ArtifactError('PUBLIC_ARGUMENT_INVALID');
    const manifest = await inspectPublicArtifact(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
    console.log(JSON.stringify({ ok: true, artifact: manifest.artifact, commit: manifest.provenance.commit,
      sourceDirty: manifest.provenance.sourceDirty, files: Object.keys(manifest.files).length, contentDigest: manifest.contentDigest }));
  } catch { console.error(JSON.stringify({ ok: false, error: 'PUBLIC_ARTIFACT_INVALID' })); process.exitCode = 1; }
}
