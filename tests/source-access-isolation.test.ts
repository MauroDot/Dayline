import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { buildPublicArtifact } from '../scripts/build-public.ts';
import { inspectPublicArtifact, manifestName, optionalPublicFiles, requiredPublicFiles } from '../scripts/inspect-public.ts';
import { createPublicServer } from '../src/public/reader.ts';
import { parsePublicConfiguration } from '../src/public/config.ts';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function listed(root: string, prefix = ''): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...await listed(root, name)); else names.push(name);
  }
  return names.sort();
}

test('authenticated source access and synthetic credentials remain outside the actual public artifact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dayline-source-access-isolation-'));
  try {
    const artifact = path.join(directory, 'artifact');
    const manifest = await buildPublicArtifact({ sourceRoot: project, outputRoot: artifact });
    const files = await listed(artifact);
    assert.deepEqual(files, [...requiredPublicFiles, ...optionalPublicFiles, 'package.json', manifestName].sort());
    assert.equal(files.length, 12);
    assert.equal(Object.keys(manifest.files).length, 11);
    assert.equal(files.some(name => /security|source-queue|source-access|fixtures|tests|\.gitattributes/.test(name)), false);
    assert.deepEqual(await inspectPublicArtifact(artifact), manifest);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public runtime never mounts authenticated source reads or administrative mutation routes', async () => {
  for (const mode of ['staging', 'production']) {
    let upstream = 0;
    const config = parsePublicConfiguration({ NODE_ENV: mode, NWS_USER_AGENT: 'FictionalIsolation/1.0 (fixture@isolation.test)' });
    const server = createPublicServer({ config, fetcher: async () => { upstream++; throw Error('No upstream calls authorized'); } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (const route of ['/internal/source-queue', '/internal/source-queue?view=RECENT&limit=1',
        '/internal/source-queue/approve', '/internal/source-queue/grant', '/api/source-access',
        '/src/security/source.ts', '/fixtures/source-access-fiction.ts']) {
        for (const method of ['GET', 'HEAD']) {
          const response = await fetch(base + route, { method, headers: { Authorization: 'Bearer fictional-isolation-sentinel' } });
          assert.equal(response.status, 404, `${mode} ${method} ${route}`);
          assert.equal((await response.text()).includes('fictional-isolation-sentinel'), false);
        }
      }
      const mutation = await fetch(base + '/internal/source-queue', { method: 'POST' });
      assert.equal(mutation.status, 405); await mutation.arrayBuffer();
      const health = await fetch(base + '/api/health'); assert.equal(health.status, 200); await health.arrayBuffer();
      const ready = await fetch(base + '/api/ready'); assert.equal(ready.status, 503); await ready.arrayBuffer();
      assert.equal(upstream, 0);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
});
