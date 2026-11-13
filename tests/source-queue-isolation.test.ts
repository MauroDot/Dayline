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
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listed(root, name)); else files.push(name);
  }
  return files.sort();
}

test('actual public artifact excludes the entire discovery queue and its private development interface', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dayline-queue-isolation-'));
  try {
    const output = path.join(directory, 'artifact');
    const manifest = await buildPublicArtifact({ sourceRoot: project, outputRoot: output });
    const files = await listed(output);
    assert.deepEqual(files, [...requiredPublicFiles, ...optionalPublicFiles, 'package.json', manifestName].sort());
    assert.equal(files.length, 12);
    assert.equal(Object.keys(manifest.files).length, 11);
    assert.equal(files.some(name => /source-queue|fixtures|tests|\.gitattributes|server\.ts/.test(name)), false);
    assert.deepEqual(await inspectPublicArtifact(output), manifest);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public staging and production never expose discovery queue routes or fetch providers', async () => {
  for (const mode of ['staging', 'production']) {
    let requests = 0;
    const config = parsePublicConfiguration({ NODE_ENV: mode, NWS_USER_AGENT: 'FictionalIsolation/1.0 (fixture@isolation.test)' });
    const server = createPublicServer({ config, fetcher: async () => { requests++; throw Error('No live requests authorized'); } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (const route of ['/dev/source-queue', '/dev/source-queue/preview?view=RECENT',
        '/dev/source-queue/source-queue.js', '/source-queue.html', '/source-queue.css', '/source-queue.js',
        '/src/source-queue/service.ts', '/fixtures/source-queue-fiction.ts', '/api/source-queue']) {
        for (const method of ['GET', 'HEAD']) {
          const response = await fetch(base + route, { method });
          assert.equal(response.status, 404, `${mode} ${method} ${route}`);
          await response.arrayBuffer();
        }
      }
      const mutation = await fetch(base + '/dev/source-queue', { method: 'POST' });
      assert.equal(mutation.status, 405); await mutation.arrayBuffer();
      const health = await fetch(base + '/api/health'); assert.equal(health.status, 200); await health.arrayBuffer();
      const ready = await fetch(base + '/api/ready'); assert.equal(ready.status, 503); await ready.arrayBuffer();
      assert.equal(requests, 0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
});

test('packaged configuration rejects the fictional source queue activation flag outside development', () => {
  for (const mode of ['staging', 'production']) {
    assert.throws(() => parsePublicConfiguration({ NODE_ENV: mode, DAYLINE_DEV_SOURCE_QUEUE: 'fictional',
      NWS_USER_AGENT: 'FictionalIsolation/1.0 (fixture@isolation.test)' }), /DEVELOPMENT_CONFIGURATION_FORBIDDEN/);
  }
});
