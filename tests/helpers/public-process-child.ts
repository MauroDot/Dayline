/** Parent-only IPC acceptance worker. Never copied into the deployable artifact. */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { startPublicRuntime } from '../../src/public/main.ts';

type Runtime = Awaited<ReturnType<typeof startPublicRuntime>>;
let runtime: Runtime | undefined;
let stopping = false, disconnected = false;
function send(type: 'shutdown_started' | 'shutdown_complete'): Promise<void> {
  return new Promise((done, fail) => {
    if (!process.connected || !process.send) { fail(Error('PUBLIC_TEST_PARENT_DISCONNECTED')); return; }
    process.send({ type }, error => error ? fail(Error('PUBLIC_TEST_CONTROL_FAILED')) : done());
  });
}
async function shutdown(requested: boolean): Promise<void> {
  if (stopping || !runtime) return;
  stopping = true;
  try {
    const closed = runtime.close();
    void closed.catch(() => undefined); // Preserve rejection for await below without an early raw rejection report.
    // Node server.close() stops admission synchronously; report that fact before waiting for accepted sockets.
    if (runtime.server.listening) throw Error('PUBLIC_TEST_ADMISSION_STILL_OPEN');
    if (requested) await send('shutdown_started');
    await closed;
    if (requested) await send('shutdown_complete');
    process.exit(requested ? 0 : 1);
  } catch {
    try { await runtime.close(); } catch {}
    process.stderr.write('{"event":"public_test_failed","code":"PUBLIC_TEST_SHUTDOWN_FAILED"}\n');
    process.exit(1);
  }
}
process.once('disconnect', () => { disconnected = true; void shutdown(false); });
process.on('message', message => {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).length !== 1 || (message as { type?: unknown }).type !== 'shutdown') {
    disconnected = true;
    process.stderr.write('{"event":"public_test_failed","code":"PUBLIC_TEST_CONTROL_INVALID"}\n');
    void shutdown(false); return;
  }
  void shutdown(true);
});
try {
  if (!process.send || !process.connected || !process.argv[2] || process.argv.length !== 3) throw Error();
  const module = await import(pathToFileURL(resolve(process.argv[2])).href) as { startPublicRuntime?: typeof startPublicRuntime };
  if (typeof module.startPublicRuntime !== 'function') throw Error();
  runtime = await module.startPublicRuntime();
  if (disconnected || !process.connected) await shutdown(false);
} catch {
  process.stderr.write('{"event":"public_test_failed","code":"PUBLIC_TEST_START_FAILED"}\n');
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
