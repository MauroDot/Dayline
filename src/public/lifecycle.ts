import type { Server } from 'node:http';
import type { Socket } from 'node:net';

export interface LifecycleEvent { event: 'public_stopping' | 'public_stopped' | 'public_shutdown_forced' | 'public_shutdown_failed'; code?: 'SHUTDOWN_TIMEOUT' | 'SHUTDOWN_FAILED' }
export interface PublicLifecycleOptions {
  shutdownTimeoutMs: number;
  log?: (event: LifecycleEvent) => void;
  onStopped?: (code: 0 | 1) => void;
}
/** Attach before listening so every accepted socket participates in bounded shutdown. */
export function attachPublicLifecycle(server: Server, options: PublicLifecycleOptions) {
  if (!Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs < 100 || options.shutdownTimeoutMs > 30000) throw Error('INVALID_SHUTDOWN_CONFIGURATION');
  const sockets = new Set<Socket>();
  const connection = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  server.on('connection', connection);
  const log = (event: LifecycleEvent) => { try { options.log?.(event); } catch { /* Logging cannot prevent shutdown. */ } };
  let stopping: Promise<void> | undefined;
  let removeSignals: (() => void) | undefined;
  const close = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = new Promise<void>((resolve, reject) => {
      log({ event: 'public_stopping' });
      let done = false;
      const finish = (error?: Error) => {
        if (done) return; done = true; clearTimeout(timer); removeSignals?.(); server.off('connection', connection);
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          log({ event: 'public_shutdown_failed', code: 'SHUTDOWN_FAILED' }); reject(Error('PUBLIC_SHUTDOWN_FAILED'));
        } else { log({ event: 'public_stopped' }); resolve(); }
      };
      const timer = setTimeout(() => {
        log({ event: 'public_shutdown_forced', code: 'SHUTDOWN_TIMEOUT' });
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        finish();
      }, options.shutdownTimeoutMs);
      server.close(error => finish(error));
      server.closeIdleConnections();
    });
    return stopping;
  };
  const installSignals = (): (() => void) => {
    if (removeSignals) return removeSignals;
    const signal = () => { void close().then(() => options.onStopped?.(0), () => options.onStopped?.(1)); };
    process.on('SIGTERM', signal); process.on('SIGINT', signal);
    removeSignals = () => { process.off('SIGTERM', signal); process.off('SIGINT', signal); removeSignals = undefined; };
    return removeSignals;
  };
  return { close, installSignals };
}
