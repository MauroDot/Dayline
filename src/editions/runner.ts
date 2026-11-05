/** Isolated temporary fictional fixture only; no live provider, path, or public output mode. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedEditionFixture, editionAt } from '../../fixtures/edition-fiction.ts';
import { JsonRepository } from '../newsroom/store.ts';
import { EditionService } from './service.ts';
import { previewEdition } from './preview.ts';

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw Error('Only the isolated fictional edition fixture is supported');
  const directory = await mkdtemp(join(tmpdir(), 'dayline-fictional-edition-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const fixture = await seedEditionFixture(repository);
    const service = new EditionService(repository, { clock: () => editionAt });
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES', featured: true },
    ] }, 'fictional-edition-editor');
    console.log(JSON.stringify(await previewEdition(service, edition.id)));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch(() => { console.error('Fictional edition preview failed'); process.exitCode = 1; });
