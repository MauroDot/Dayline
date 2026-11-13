/** Isolated fictional development demonstration. No caller path or live mode. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSourceQueueFixture, sourceQueueFixtureAt } from '../../fixtures/source-queue-fiction.ts';
import { JsonRepository } from '../newsroom/store.ts';
import { SourceQueue } from './service.ts';

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw Error('Only the isolated fictional source queue fixture is supported');
  const directory = await mkdtemp(join(tmpdir(), 'dayline-fictional-source-queue-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const fixture = await seedSourceQueueFixture(repository);
    const queue = new SourceQueue(repository, { clock: () => sourceQueueFixtureAt });
    const page = await queue.read({ view: 'RECENT', limit: 50 });
    console.log(JSON.stringify({ fictional: true, developmentOnly: true, asOf: sourceQueueFixtureAt,
      duplicateDiscoveries: fixture.duplicateDiscoveries, page }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

main().catch(() => { console.error('Fictional source queue demonstration failed'); process.exitCode = 1; });
