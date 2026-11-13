import test from 'node:test';
import assert from 'node:assert/strict';
import { symlinkCapability, type SymlinkKind, type SymlinkProbeIO } from './helpers/symlink-capability.ts';

function failure(code: string) { return Object.assign(Error('private-fixture-path must not enter a skip reason'), { code }); }
function fixture(options: { linkError?: unknown; setupError?: unknown; verifyError?: unknown; cleanupError?: unknown; symbolic?: boolean } = {}) {
  const calls: { operation: string; path?: string; target?: string; kind?: SymlinkKind }[] = [];
  const io: SymlinkProbeIO = {
    async mkdtemp() { calls.push({ operation: 'mkdtemp' }); return '/isolated-probe'; },
    async mkdir(path) { calls.push({ operation: 'mkdir', path }); if (options.setupError) throw options.setupError; },
    async writeFile(path) { calls.push({ operation: 'writeFile', path }); if (options.setupError) throw options.setupError; },
    async symlink(target, path, kind) { calls.push({ operation: 'symlink', target, path, kind }); if (options.linkError) throw options.linkError; },
    async lstat(path) { calls.push({ operation: 'lstat', path }); if (options.verifyError) throw options.verifyError; return { isSymbolicLink: () => options.symbolic ?? true }; },
    async rm(path, config) { calls.push({ operation: 'rm', path }); assert.deepEqual(config, { recursive: true, force: true }); if (options.cleanupError) throw options.cleanupError; },
  };
  return { io, calls };
}

test('file capability probe uses an isolated harmless file and verifies the link before disposal', async () => {
  const f = fixture();
  assert.deepEqual(await symlinkCapability('file', { io: f.io, platform: 'linux' }), { supported: true });
  assert.deepEqual(f.calls.map(call => call.operation), ['mkdtemp', 'writeFile', 'symlink', 'lstat', 'rm']);
  const link = f.calls.find(call => call.operation === 'symlink')!;
  assert.equal(link.kind, 'file'); assert.ok(link.target?.endsWith('target.txt'));
  assert.equal(f.calls.at(-1)?.path, '/isolated-probe');
});

test('directory capability is checked independently using an explicit directory symbolic link', async () => {
  const f = fixture();
  assert.deepEqual(await symlinkCapability('dir', { io: f.io, platform: 'win32' }), { supported: true });
  assert.deepEqual(f.calls.map(call => call.operation), ['mkdtemp', 'mkdir', 'symlink', 'lstat', 'rm']);
  assert.equal(f.calls.find(call => call.operation === 'symlink')?.kind, 'dir');
});

test('only Windows link-creation privilege denials report unavailable prerequisites with a sanitized reason', async () => {
  for (const code of ['EPERM', 'EACCES']) {
    const f = fixture({ linkError: failure(code) });
    const result = await symlinkCapability('file', { io: f.io, platform: 'win32' });
    assert.equal(result.supported, false);
    if (!result.supported) {
      assert.match(result.reason, new RegExp(`Windows file.*${code}.*not executed`));
      assert.doesNotMatch(result.reason, /private-fixture|isolated-probe/);
    }
    assert.equal(f.calls.at(-1)?.operation, 'rm');
    assert.equal(f.calls.some(call => call.operation === 'lstat'), false);
  }
});

test('POSIX privilege errors remain failures rather than silently skipped security assertions', async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const error = failure('EPERM'), f = fixture({ linkError: error });
    await assert.rejects(symlinkCapability('file', { io: f.io, platform }), error);
    assert.equal(f.calls.at(-1)?.operation, 'rm');
  }
});

test('unexpected Windows link errors cannot be classified as missing privilege', async () => {
  for (const code of ['ENOENT', 'EIO', 'ENOTSUP', 'EINVAL']) {
    const error = failure(code), f = fixture({ linkError: error });
    await assert.rejects(symlinkCapability('dir', { io: f.io, platform: 'win32' }), error);
    assert.equal(f.calls.at(-1)?.operation, 'rm');
  }
});

test('Windows setup and verification errors cannot hide behind a privilege-related skip', async () => {
  for (const step of ['setupError', 'verifyError'] as const) {
    const error = failure('EACCES'), f = fixture({ [step]: error });
    await assert.rejects(symlinkCapability('file', { io: f.io, platform: 'win32' }), error);
    assert.equal(f.calls.at(-1)?.operation, 'rm');
  }
});

test('a probe that did not actually create a symbolic link fails validation and disposes its fixture', async () => {
  const f = fixture({ symbolic: false });
  await assert.rejects(symlinkCapability('file', { io: f.io, platform: 'win32' }), { message: 'SYMLINK_CAPABILITY_PROBE_INVALID_LINK' });
  assert.equal(f.calls.at(-1)?.operation, 'rm');
});

test('cleanup errors fail the capability check even after a genuine Windows privilege denial', async () => {
  const error = failure('EIO'), f = fixture({ linkError: failure('EPERM'), cleanupError: error });
  await assert.rejects(symlinkCapability('dir', { io: f.io, platform: 'win32' }), error);
});
