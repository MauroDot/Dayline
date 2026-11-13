/** Test/acceptance tooling only. This module is excluded from the public runtime artifact. */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface PublicProcessExit { code: number | null; signal: NodeJS.Signals | null }
export interface PublicProcessOptions {
  executable?: string;
  entryPoint: string;
  cwd?: string;
  environment: NodeJS.ProcessEnv;
  /** Explicit parent-only IPC worker; never a deployed listener or HTTP control route. */
  controlled?: boolean;
}
export interface TrackedPublicProcess {
  child: ChildProcess;
  exited: Promise<PublicProcessExit>;
  output(): string;
  errors(): string;
  waitForExit(timeoutMs?: number): Promise<PublicProcessExit>;
  requestShutdown(timeoutMs?: number): Promise<void>;
  cleanup(timeoutMs?: number): Promise<void>;
}

function duration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30_000) throw Error('PUBLIC_CHILD_INVALID_TIMEOUT');
  return value;
}
async function within<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error(code)), duration(timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}

/** Observe at spawn time: Windows termination may set signalCode while exitCode remains null. */
export function trackPublicProcess(child: ChildProcess): TrackedPublicProcess {
  let finished = false;
  let stdout = '', stderr = '', bytes = 0, outputExceeded = false;
  let resolveExit!: (exit: PublicProcessExit) => void;
  let rejectExit!: (error: Error) => void;
  let resolveTermination!: () => void;
  let resolveClose!: () => void;
  const termination = new Promise<void>(done => { resolveTermination = done; });
  const closed = new Promise<void>(done => { resolveClose = done; });
  const exited = new Promise<PublicProcessExit>((done, fail) => { resolveExit = done; rejectExit = fail; });
  // A child may fail before the caller reaches its first await; consume only the unhandled-rejection warning.
  void exited.catch(() => undefined);
  const drained = () => {
    // Explicit parent IPC disconnect can suppress ChildProcess's final close event on Node 22.
    // Observed process termination plus ended/destroyed stdio and a closed IPC channel is sufficient.
    if (finished && !child.connected && (!child.stdout || child.stdout.readableEnded || child.stdout.destroyed)
      && (!child.stderr || child.stderr.readableEnded || child.stderr.destroyed)) resolveClose();
  };
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finished) return; finished = true; resolveTermination(); resolveExit({ code, signal }); drained();
  };
  child.once('exit', finish);
  // Spawn errors may have no exit event; close still establishes that no child is left running.
  child.once('close', (code, signal) => { finish(code, signal); resolveClose(); });
  child.on('error', () => { if (!finished) rejectExit(Error('PUBLIC_CHILD_START_FAILED')); });
  child.stdout?.once('end', drained); child.stdout?.once('close', drained);
  child.stderr?.once('end', drained); child.stderr?.once('close', drained);
  child.once('disconnect', drained);
  if (child.exitCode !== null || child.signalCode !== null) {
    finish(child.exitCode, child.signalCode);
  }
  const capture = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
    const text = chunk.toString(); bytes += Buffer.byteLength(text);
    if (bytes > 65_536) {
      outputExceeded = true;
      if (!finished) { try { child.kill('SIGKILL'); } catch {} }
      return;
    }
    if (stream === 'stdout') stdout += text; else stderr += text;
  };
  child.stdout?.on('data', chunk => capture('stdout', chunk));
  child.stderr?.on('data', chunk => capture('stderr', chunk));

  async function cleanup(timeoutMs = 1500): Promise<void> {
    duration(timeoutMs);
    if (!finished && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { throw Error('PUBLIC_CHILD_CLEANUP_FAILED'); }
    }
    try { await within(termination.then(() => closed), timeoutMs, 'PUBLIC_CHILD_CLEANUP_FAILED'); }
    catch { throw Error('PUBLIC_CHILD_CLEANUP_FAILED'); }
  }
  return {
    child, exited, output: () => stdout, errors: () => stderr,
    async waitForExit(timeoutMs = 4000) {
      try {
        return await within(exited.then(async result => {
          await closed;
          if (outputExceeded) throw Error('PUBLIC_CHILD_OUTPUT_LIMIT');
          return result;
        }), timeoutMs, 'PUBLIC_CHILD_STOP_TIMEOUT');
      }
      catch (error) {
        // Force-clean only a timed-out test child, then preserve the genuine test failure.
        if (error instanceof Error && error.message === 'PUBLIC_CHILD_STOP_TIMEOUT') await cleanup();
        throw error;
      }
    },
    async requestShutdown(timeoutMs = 4000) {
      duration(timeoutMs);
      if (finished || !child.connected || typeof child.send !== 'function') throw Error('PUBLIC_CHILD_CONTROL_UNAVAILABLE');
      let message!: (value: unknown) => void;
      const acknowledged = new Promise<void>((done, fail) => {
        message = value => {
          if (value !== null && typeof value === 'object' && !Array.isArray(value)
            && Object.keys(value).length === 1 && (value as { type?: unknown }).type === 'shutdown_started') done();
        };
        child.on('message', message);
        // IPC delivery and exit notification can reach the parent in either order, particularly
        // on Windows. A normal exit must not discard an already queued acknowledgement. The
        // exact message remains mandatory until the bounded deadline; spawn errors fail now.
        void exited.catch(() => fail(Error('PUBLIC_CHILD_CONTROL_FAILED')));
        child.send!({ type: 'shutdown' }, error => { if (error) fail(Error('PUBLIC_CHILD_CONTROL_FAILED')); });
      });
      try { await within(acknowledged, timeoutMs, 'PUBLIC_CHILD_CONTROL_TIMEOUT'); }
      finally { child.off('message', message); }
    },
    cleanup,
  };
}

export function spawnPublicProcess(options: PublicProcessOptions): TrackedPublicProcess {
  const entryPoint = resolve(options.entryPoint);
  const args = options.controlled
    ? ['--experimental-strip-types', fileURLToPath(new URL('./public-process-child.ts', import.meta.url)), entryPoint]
    : ['--experimental-strip-types', entryPoint];
  const child = spawn(options.executable ?? process.execPath, args, {
    cwd: options.cwd, env: options.environment,
    stdio: options.controlled ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  return trackPublicProcess(child);
}
