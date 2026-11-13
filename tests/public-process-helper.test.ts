import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { trackPublicProcess } from './helpers/public-process.ts';

/** Deterministic child-state doubles, including Windows' signalCode-only termination. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid: number | undefined = 42;
  connected = false;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kills: NodeJS.Signals[] = [];
  reap = true;
  control: (() => void) | undefined;
  terminate(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code; this.signalCode = signal;
    this.emit('exit', code, signal); this.emit('close', code, signal);
  }
  kill(signal: NodeJS.Signals) { this.kills.push(signal); if (this.reap) this.terminate(null, signal); return true; }
  send(_message: unknown, callback: (error: Error | null) => void) { this.control?.(); callback(null); return true; }
  child(): ChildProcess { return this as unknown as ChildProcess; }
}

test('process tracking recognizes an already signal-terminated Windows-shaped child with null exitCode', async () => {
  const fake = new FakeChild(); fake.signalCode = 'SIGTERM';
  fake.stdout.destroy(); fake.stderr.destroy();
  const running = trackPublicProcess(fake.child());
  assert.deepEqual(await running.waitForExit(10), { code: null, signal: 'SIGTERM' });
  await running.cleanup(); assert.deepEqual(fake.kills, []);
});
test('waiting for child exit also waits for final stdout and the close event', async () => {
  const fake = new FakeChild(), running = trackPublicProcess(fake.child());
  fake.exitCode = 0; fake.emit('exit', 0, null);
  let stopped = false;
  const waiting = running.waitForExit(100).then(result => { stopped = true; return result; });
  await Promise.resolve(); assert.equal(stopped, false);
  fake.stdout.write('{"event":"public_stopped"}\n');
  fake.emit('close', 0, null);
  assert.deepEqual(await waiting, { code: 0, signal: null });
  assert.match(running.output(), /public_stopped/); await running.cleanup();
});
test('process tracking retains exit events that precede the later wait call', async () => {
  const fake = new FakeChild(), running = trackPublicProcess(fake.child());
  fake.terminate(0);
  assert.deepEqual(await running.waitForExit(10), { code: 0, signal: null });
  await running.cleanup(); assert.deepEqual(fake.kills, []);
});
test('an explicitly disconnected child is reaped after exit and drained stdio even without a close event', async () => {
  const fake = new FakeChild(); fake.connected = true;
  const running = trackPublicProcess(fake.child());
  fake.connected = false; fake.emit('disconnect');
  fake.stdout.destroy(); fake.stderr.destroy();
  fake.exitCode = 1; fake.emit('exit', 1, null);
  assert.deepEqual(await running.waitForExit(50), { code: 1, signal: null });
  await running.cleanup(); assert.deepEqual(fake.kills, []);
});
test('process tracking preserves a genuine nonzero child exit instead of reporting success', async () => {
  const fake = new FakeChild(), running = trackPublicProcess(fake.child());
  fake.terminate(9);
  assert.deepEqual(await running.waitForExit(10), { code: 9, signal: null });
  await running.cleanup();
});
test('spawn errors use a fixed safe failure and cleanup waits for the no-process close event', async () => {
  const fake = new FakeChild(); fake.pid = undefined;
  const running = trackPublicProcess(fake.child());
  fake.emit('error', Error('private executable path and credential'));
  await assert.rejects(running.waitForExit(10), { message: 'PUBLIC_CHILD_START_FAILED' });
  const cleaned = running.cleanup(50);
  setImmediate(() => fake.emit('close', -2, null));
  await cleaned; assert.deepEqual(fake.kills, []);
});
test('a timed-out process is forcibly reaped before the stop timeout remains a failure', async () => {
  const fake = new FakeChild(), running = trackPublicProcess(fake.child());
  await assert.rejects(running.waitForExit(5), { message: 'PUBLIC_CHILD_STOP_TIMEOUT' });
  assert.deepEqual(fake.kills, ['SIGKILL']);
  assert.deepEqual(await running.exited, { code: null, signal: 'SIGKILL' });
  await running.cleanup(); assert.equal(fake.kills.length, 1);
});
test('cleanup failure is explicit when a forced test child cannot be reaped', async () => {
  const fake = new FakeChild(); fake.reap = false;
  const running = trackPublicProcess(fake.child());
  try {
    await assert.rejects(running.cleanup(5), { message: 'PUBLIC_CHILD_CLEANUP_FAILED' });
    assert.deepEqual(fake.kills, ['SIGKILL']);
  } finally { fake.terminate(null, 'SIGKILL'); await running.cleanup(); }
});
test('controlled shutdown is unavailable without a parent IPC channel', async () => {
  const fake = new FakeChild(), running = trackPublicProcess(fake.child());
  await assert.rejects(running.requestShutdown(10), { message: 'PUBLIC_CHILD_CONTROL_UNAVAILABLE' });
  await running.cleanup();
});
test('controlled shutdown waits for the explicit admission-stopped acknowledgement', async () => {
  const fake = new FakeChild(); fake.connected = true;
  const running = trackPublicProcess(fake.child());
  fake.control = () => setImmediate(() => fake.emit('message', { type: 'shutdown_started' }));
  await running.requestShutdown(100);
  assert.equal(fake.exitCode, null); fake.terminate(0);
  assert.deepEqual(await running.waitForExit(10), { code: 0, signal: null });
  await running.cleanup();
});
test('a queued shutdown acknowledgement remains valid when the exit event is delivered first', async () => {
  const fake = new FakeChild(); fake.connected = true;
  const running = trackPublicProcess(fake.child());
  fake.control = () => {
    fake.terminate(0);
    setImmediate(() => fake.emit('message', { type: 'shutdown_started' }));
  };
  await running.requestShutdown(100);
  assert.deepEqual(await running.waitForExit(10), { code: 0, signal: null });
  await running.cleanup();
});
test('a child that exits without any shutdown acknowledgement still fails at the control deadline', async () => {
  const fake = new FakeChild(); fake.connected = true;
  const running = trackPublicProcess(fake.child());
  fake.control = () => fake.terminate(0);
  await assert.rejects(running.requestShutdown(10), { message: 'PUBLIC_CHILD_CONTROL_TIMEOUT' });
  await running.cleanup();
});
test('excessive child output is bounded and cannot become a successful lifecycle result', async () => {
  const fake = new FakeChild(), running = trackPublicProcess(fake.child());
  fake.stdout.write(Buffer.alloc(65_537, 65));
  await assert.rejects(running.waitForExit(10), { message: 'PUBLIC_CHILD_OUTPUT_LIMIT' });
  assert.ok(running.output().length <= 65_536); assert.deepEqual(fake.kills, ['SIGKILL']);
  await running.cleanup();
});
