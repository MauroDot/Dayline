/** Private anonymous-pipe acceptance control, never an HTTP/bootstrap endpoint or general CLI. */
import { createInterface } from 'node:readline';
import { fstatSync } from 'node:fs';
import { createFictionalOperationsEnvironment, operationsRoles, type OperationsRole } from '../../fixtures/editorial-operations-fiction.ts';

type Environment = Awaited<ReturnType<typeof createFictionalOperationsEnvironment>>;
let environment: Environment | undefined;
let starting: Promise<Environment> | undefined;
let disposal: Promise<boolean> | undefined;
function reply(value: unknown) { process.stdout.write(JSON.stringify(value) + '\n'); }
async function dispose() {
  disposal ??= (async () => {
    try { environment ??= await starting; } catch { return true; }
    return environment ? environment.close() : true;
  })();
  return disposal;
}
const role = (value: unknown): value is OperationsRole => operationsRoles.includes(value as OperationsRole);
const source = (value: unknown): value is 'pending' | 'proof' | 'disputed' => ['pending', 'proof', 'disputed'].includes(value as string);
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.sort().join(',');
}

async function main() {
  const anonymousChannel = (fd: number) => { const info = fstatSync(fd); return info.isFIFO() || info.isSocket(); };
  if (process.argv.length !== 2 || process.stdin.isTTY || process.stdout.isTTY
    || !anonymousChannel(0) || !anonymousChannel(1)) throw Error('Private pipe required');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const timeout = setTimeout(() => { input.close(); process.stdin.destroy(); }, 10_000);
  let started = false;
  try {
    for await (const line of input) {
      if (line.length > 4096) throw Error('Invalid private command');
      let message: unknown;
      try { message = JSON.parse(line); } catch { throw Error('Invalid private command'); }
      if (!started) {
        clearTimeout(timeout);
        if (!exact(message, ['command']) || message.command !== 'start-fictional-acceptance') throw Error('Private handshake required');
        starting = createFictionalOperationsEnvironment();
        environment = await starting; started = true;
        if (disposal) { await disposal; break; }
        // Credential disclosure is limited to this explicit private, non-TTY, anonymous-pipe handshake.
        reply(environment.bootstrap()); continue;
      }
      try {
        if (!environment || !message || typeof message !== 'object') throw Error();
        const c = environment.fixture;
        if (exact(message, ['command']) && message.command === 'dispose') {
          const cleanupRemoved = await dispose(); reply({ ok: true, cleanupRemoved }); break;
        } else if (exact(message, ['command', 'role']) && role(message.role)) {
          if (message.command === 'revoke') await c.revoke(message.role);
          else if (message.command === 'clearAssignments') c.clearAssignments(message.role);
          else throw Error();
        } else if (exact(message, ['command', 'source']) && source(message.source)) {
          if (message.command === 'resolve' && message.source === 'pending') await c.resolvePending();
          else if (message.command === 'resolve' && message.source === 'disputed') await c.resolveDisputed();
          else if (message.command === 'hold') await c.hold(message.source);
          else if (message.command === 'release') await c.hold(message.source, true);
          else if (message.command === 'expire') await c.expire(message.source);
          else throw Error();
        } else if (exact(message, ['command', 'ms']) && message.command === 'advanceClock' && typeof message.ms === 'number') {
          c.clock.advance(message.ms);
        } else throw Error();
        reply({ ok: true, asOf: c.clock.now() });
      } catch { reply({ ok: false, error: 'FICTIONAL_CONTROL_REJECTED' }); }
    }
    if (!started) throw Error('Private handshake required');
  } finally {
    clearTimeout(timeout); input.close(); await dispose();
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void dispose().finally(() => process.exit(0));
});
main().catch(async () => {
  await dispose(); process.stderr.write('Fictional operations acceptance bridge unavailable\n'); process.exitCode = 1;
});
