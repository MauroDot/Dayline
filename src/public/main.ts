import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { FetchLike } from '../official-data.ts';
import { parsePublicConfiguration, PublicConfigurationError } from './config.ts';
import { createPublicServer, type SafePublicEvent } from './reader.ts';
import { attachPublicLifecycle, type LifecycleEvent } from './lifecycle.ts';

const events = new Set(['public_started', 'public_start_failed', 'public_stopping', 'public_stopped', 'public_shutdown_forced', 'public_shutdown_failed', 'upstream_failure', 'request_failure', 'capacity_rejected']);
const codes = new Set(['INVALID_ENVIRONMENT','INVALID_PORT','INVALID_BIND_ADDRESS','INVALID_NWS_IDENTIFICATION','INVALID_PUBLIC_BASE_URL','DEVELOPMENT_CONFIGURATION_FORBIDDEN','INVALID_TIMEOUT','INVALID_CAPACITY','PUBLIC_START_FAILED','INVALID_PUBLIC_ARTIFACT','UNSUPPORTED_PUBLIC_RUNTIME','SHUTDOWN_TIMEOUT','SHUTDOWN_FAILED','UNAVAILABLE','TIMEOUT','INTERNAL','CAPACITY']);
type LogInput = Record<string, unknown> | SafePublicEvent | LifecycleEvent;
/** Fixed-schema local logs. Incoming headers, URLs, environment values and raw exceptions are absent. */
export function safePublicLog(input: LogInput): Record<string, unknown> {
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = { event: typeof value.event === 'string' && events.has(value.event) ? value.event : 'request_failure' };
  if (typeof value.requestId === 'string' && /^[a-f0-9-]{36}$/.test(value.requestId)) output.requestId = value.requestId;
  if (typeof value.code === 'string' && codes.has(value.code)) output.code = value.code;
  if (value.source === 'treasury' || value.source === 'nws') output.source = value.source;
  if (['development', 'staging', 'production'].includes(String(value.mode))) output.mode = value.mode;
  if (['127.0.0.1', '::1', '0.0.0.0'].includes(String(value.host))) output.host = value.host;
  if (Number.isSafeInteger(value.port) && (value.port as number) >= 1 && (value.port as number) <= 65535) output.port = value.port;
  if (typeof value.revision === 'string' && (value.revision === 'unpackaged' || /^[a-f0-9]{40}$/.test(value.revision))) output.revision = value.revision;
  if (typeof value.sourceDirty === 'boolean') output.sourceDirty = value.sourceDirty;
  return output;
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
  const log = (event: LogInput) => { const safe = safePublicLog(event); try { if (options.log) options.log(safe); else process.stdout.write(JSON.stringify(safe) + '\n'); } catch { /* Logs are best effort, not an audit guarantee. */ } };
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
