/** Local fictional fixture runner. No network or production path is accepted. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../newsroom/store.ts';
import { Newsroom } from '../newsroom/service.ts';
import { ingestArticles } from './ingest.ts';
import { articles, policy } from '../../fixtures/fictional-news.ts';
async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => a !== '--write-fixture') || args.length > 1) throw Error('Only --write-fixture is supported');
  const dryRun = !args.includes('--write-fixture');
  const dir = await mkdtemp(join(tmpdir(), 'dayline-fictional-ingestion-'));
  try {
    const newsroom = new Newsroom(new JsonRepository(join(dir, 'fictional.json')));
    const outcomes: { index: number; outcome: string }[] = [];
    const counts = await ingestArticles(newsroom, articles, policy, { dryRun, onOutcome: (index, outcome) => outcomes.push({index, outcome}) });
    console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'temporary-fixture-write', fictional: true, ...counts, outcomes }));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
main().catch(() => { console.error('Fixture ingestion failed'); process.exitCode = 1; });
