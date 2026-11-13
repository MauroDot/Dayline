/** Test prerequisite only. This helper is never included in the public artifact. */
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type SymlinkKind = 'file' | 'dir';
export type SymlinkCapability = { supported: true } | { supported: false; reason: string };
export interface SymlinkProbeIO {
  mkdtemp(prefix: string): Promise<string>;
  mkdir(path: string): Promise<unknown>;
  writeFile(path: string, contents: string): Promise<unknown>;
  symlink(target: string, path: string, kind: SymlinkKind): Promise<unknown>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  rm(path: string, options: { recursive: true; force: true }): Promise<unknown>;
}
export interface SymlinkProbeOptions { platform?: NodeJS.Platform; io?: SymlinkProbeIO }
const nativeIO: SymlinkProbeIO = { lstat, mkdir, mkdtemp, rm, symlink, writeFile };

/**
 * Probe the exact link kind using only a harmless temporary target. Only an
 * explicit Windows privilege denial from link creation makes a check unavailable.
 * Filesystem/setup/verification/cleanup faults are test failures on every OS.
 */
export async function symlinkCapability(kind: SymlinkKind, options: SymlinkProbeOptions = {}): Promise<SymlinkCapability> {
  const io = options.io ?? nativeIO, platform = options.platform ?? process.platform;
  const directory = await io.mkdtemp(join(tmpdir(), 'dayline-symlink-capability-'));
  try {
    const target = join(directory, kind === 'dir' ? 'target-directory' : 'target.txt');
    const link = join(directory, 'probe-link');
    if (kind === 'dir') await io.mkdir(target);
    else await io.writeFile(target, 'Harmless symbolic-link capability fixture.');
    try { await io.symlink(target, link, kind); }
    catch (error) {
      const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
      if (platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
        return { supported: false, reason: `Windows ${kind} symbolic-link creation unavailable (${code}); prerequisite denied, security assertion not executed` };
      }
      throw error;
    }
    if (!(await io.lstat(link)).isSymbolicLink()) throw Error('SYMLINK_CAPABILITY_PROBE_INVALID_LINK');
    return { supported: true };
  } finally {
    // Both the target and link are inside this newly created directory. No external target is removed.
    await io.rm(directory, { recursive: true, force: true });
  }
}
