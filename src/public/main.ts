import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { FetchLike } from '../official-data.ts';
import { parsePublicConfiguration, PublicConfigurationError } from './config.ts';
import { createPublicServer, type SafePublicEvent } from './reader.ts';
import { attachPublicLifecycle, type LifecycleEvent } from './lifecycle.ts';

const lifecycleEvents = new Set(['public_started', 'public_start_failed', 'public_stopping', 'public_stopped', 'public_shutdown_forced', 'public_shutdown_failed']);
const events = new Set([...lifecycleEvents, 'upstream_failure', 'request_failure', 'capacity_rejected', 'operational_logs_suppressed']);
const codes = new Set(['INVALID_ENVIRONMENT','INVALID_PORT','INVALID_BIND_ADDRESS','INVALID_NWS_IDENTIFICATION','INVALID_PUBLIC_BASE_URL','DEVELOPMENT_CONFIGURATION_FORBIDDEN','INVALID_TIMEOUT','INVALID_CAPACITY','PUBLIC_START_FAILED','INVALID_PUBLIC_ARTIFACT','UNSUPPORTED_PUBLIC_RUNTIME','SHUTDOWN_TIMEOUT','SHUTDOWN_FAILED','UNAVAILABLE','TIMEOUT','INTERNAL','CAPACITY','UPSTREAM_HTTP','UPSTREAM_RESPONSE_INVALID','UPSTREAM_REQUEST_FAILED']);
const maximumSuppressed = 1_000_000;
type LogInput = Record<string, unknown> | SafePublicEvent | LifecycleEvent;
/** Fixed-schema local logs. Incoming headers, URLs, environment values and raw exceptions are absent. */
export function safePublicLog(input: LogInput): Record<string, unknown> {
  try {
    // Read data properties only. A logger must not evaluate an exception's getter or coercion hook.
    const descriptors = input && typeof input === 'object' ? Object.getOwnPropertyDescriptors(input) : {};
    const own = (key: string): unknown => descriptors[key] && Object.hasOwn(descriptors[key], 'value') ? descriptors[key].value : undefined;
    const event = own('event'), requestId = own('requestId'), code = own('code'), source = own('source');
    const mode = own('mode'), host = own('host'), port = own('port'), revision = own('revision'), sourceDirty = own('sourceDirty');
    const output: Record<string, unknown> = { event: typeof event === 'string' && events.has(event) ? event : 'request_failure' };
    if (typeof requestId === 'string' && /^[a-f0-9-]{36}$/.test(requestId)) output.requestId = requestId;
    if (typeof code === 'string' && codes.has(code)) output.code = code;
    if (source === 'treasury' || source === 'nws') output.source = source;
    if (typeof mode === 'string' && ['development', 'staging', 'production'].includes(mode)) output.mode = mode;
    if (typeof host === 'string' && ['127.0.0.1', '::1', '0.0.0.0'].includes(host)) output.host = host;
    if (Number.isSafeInteger(port) && (port as number) >= 1 && (port as number) <= 65535) output.port = port;
    if (typeof revision === 'string' && (revision === 'unpackaged' || /^[a-f0-9]{40}$/.test(revision))) output.revision = revision;
    if (typeof sourceDirty === 'boolean') output.sourceDirty = sourceDirty;
    if (output.event === 'operational_logs_suppressed') {
      output.code = 'LOG_LIMIT';
      const suppressed = own('suppressed');
      if (Number.isSafeInteger(suppressed) && (suppressed as number) > 0 && (suppressed as number) <= maximumSuppressed) output.suppressed = suppressed;
    }
    return output;
  } catch { return { event: 'request_failure' }; }
}

export interface PublicOperationalLogOptions {
  sink?: (event: Record<string, unknown>) => unknown;
  now?: () => number;
  maxEventsPerWindow?: number;
  windowMs?: number;
}
/** A fixed-rate local log, not an audit trail or outbound telemetry client. */
export function createPublicOperationalLogger(options: PublicOperationalLogOptions = {}): (event: LogInput) => void {
  const limit = options.maxEventsPerWindow ?? 100, windowMs = options.windowMs ?? 60_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 3_600_000) throw Error('INVALID_LOG_CONFIGURATION');
  const now = options.now ?? (() => performance.now());
  const sink = options.sink ?? (event => {
    // Respect stdout backpressure instead of building an application-side output queue.
    if (!process.stdout.destroyed && !process.stdout.writableNeedDrain) process.stdout.write(JSON.stringify(event) + '\n');
  });
  let windowStarted: number | undefined, emitted = 0, suppressed = 0;
  const emittedLifecycle = new Set<string>(); // At most the six fixed lifecycle event names.
  const emit = (event: Record<string, unknown>) => {
    try {
      // Custom test/operator sinks are trusted, but rejected async work must not escape as an unhandled error.
      void Promise.resolve(sink(event)).catch(() => undefined);
    } catch { /* Local logs remain best effort and cannot change HTTP/shutdown outcomes. */ }
  };
  return input => {
    const safe = safePublicLog(input), event = safe.event as string;
    if (lifecycleEvents.has(event)) {
      if (!emittedLifecycle.has(event)) { emittedLifecycle.add(event); emit(safe); }
      return;
    }
    let at: number | undefined;
    try { const value = now(); if (Number.isFinite(value) && value >= 0) at = value; } catch {}
    // Invalid or backwards clocks never replenish the budget. No timer or unbounded category map is created.
    if (windowStarted === undefined) windowStarted = at ?? 0;
    if (at !== undefined && at - windowStarted >= windowMs) {
      windowStarted = at; emitted = 0;
      if (suppressed > 0) {
        emit(safePublicLog({ event: 'operational_logs_suppressed', suppressed }));
        emitted++; suppressed = 0;
      }
    }
    if (emitted >= limit) { suppressed = Math.min(suppressed + 1, maximumSuppressed); return; }
    emitted++; emit(safe);
  };
}
/** Packaged deployments use the exact runtime recorded by the artifact; source development is separate. */
export function assertPackagedRuntimeVersion(version = process.versions.node): void {
  if (version !== '22.16.0') throw Error('UNSUPPORTED_PUBLIC_RUNTIME');
}
/** Artifact identity is explicit: a generated runtime package cannot silently become source development. */
export async function readPublicProvenance(root = new URL('../../', import.meta.url)): Promise<{ revision: string; sourceDirty?: boolean }> {
  let packaged: boolean;
  try {
    const bytes = await readFile(new URL('package.json', root));
    if (bytes.length > 65536) throw Error();
    const packageMetadata = JSON.parse(bytes.toString('utf8'));
    if (!['dayline', 'dayline-public-reader'].includes(packageMetadata?.name)) throw Error();
    packaged = packageMetadata.name === 'dayline-public-reader';
  } catch { throw Error('INVALID_PUBLIC_ARTIFACT'); }
  let body: Buffer;
  try { body = await readFile(new URL('public-manifest.json', root)); }
  catch (error) { if (!packaged && (error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 'unpackaged' }; throw Error('INVALID_PUBLIC_ARTIFACT'); }
  try {
    if (body.length > 65536) throw Error();
    const manifest = JSON.parse(body.toString('utf8'));
    if (manifest.schema !== 1 || manifest.artifact !== 'dayline-public-reader'
      || manifest.runtime?.node !== '22.16.0' || manifest.runtime?.entry !== 'src/public/main.ts'
      || !/^[a-f0-9]{40}$/.test(manifest.provenance?.commit ?? '') || typeof manifest.provenance.sourceDirty !== 'boolean') throw Error();
    assertPackagedRuntimeVersion();
    return { revision: manifest.provenance.commit, sourceDirty: manifest.provenance.sourceDirty };
  } catch (error) { if (error instanceof Error && error.message === 'UNSUPPORTED_PUBLIC_RUNTIME') throw error; throw Error('INVALID_PUBLIC_ARTIFACT'); }
}
export interface StartPublicRuntimeOptions {
  environment?: NodeJS.ProcessEnv;
  fetcher?: FetchLike;
  now?: () => number;
  staticRoot?: string;
  log?: (event: Record<string, unknown>) => void;
}
/** Starts only the allowlisted reader core. Importing this module never binds a listener. */
export async function startPublicRuntime(options: StartPublicRuntimeOptions = {}) {
  const config = parsePublicConfiguration(options.environment ?? process.env);
  const metadata = await readPublicProvenance();
  const log = createPublicOperationalLogger({ sink: options.log, now: options.now });
  const server = createPublicServer({ config, fetcher: options.fetcher, now: options.now, staticRoot: options.staticRoot, log });
  const lifecycle = attachPublicLifecycle(server, { shutdownTimeoutMs: config.shutdownTimeoutMs, log });
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(config.port, config.host, () => { server.off('error', fail); done(); });
    });
  } catch { await lifecycle.close(); throw Error('PUBLIC_START_FAILED'); }
  // Late listener errors must not fall through to Node's raw exception/stack printer.
  server.on('error', () => log({ event: 'request_failure', requestId: randomUUID(), code: 'INTERNAL' }));
  log({ event: 'public_started', requestId: randomUUID(), mode: config.mode, host: config.host, port: config.port, ...metadata });
  return { server, config, close: lifecycle.close, installSignals: lifecycle.installSignals };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const runtime = await startPublicRuntime();
    // An HTTP close drains accepted sockets; process exit also bounds residual upstream retry handles.
    const stop = () => { void runtime.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch (error) {
    const code = error instanceof PublicConfigurationError ? error.code
      : error instanceof Error && ['INVALID_PUBLIC_ARTIFACT', 'UNSUPPORTED_PUBLIC_RUNTIME'].includes(error.message) ? error.message : 'PUBLIC_START_FAILED';
    process.stderr.write(JSON.stringify(safePublicLog({ event: 'public_start_failed', requestId: randomUUID(), code })) + '\n');
    process.exitCode = 1;
  }
}
