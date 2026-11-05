/** Manual fictional retention demonstration. No existing repository path or live mode is accepted. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRepository } from '../newsroom/store.ts';
import { ingestArticles } from './ingest.ts';
import { cleanupRetention } from './retention.ts';
import { articles, context, fixtureAt, resolutions } from '../../fixtures/fictional-news.ts';
async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(a => a !== '--apply-fixture')) throw Error('Only --apply-fixture is supported');
  const dryRun = !args.includes('--apply-fixture');
  const dir = await mkdtemp(join(tmpdir(), 'dayline-fictional-retention-'));
  try {
    const repo = new JsonRepository(join(dir, 'fictional.json'));
    await ingestArticles(repo, articles, context, { dryRun: false, resolutions, clock: () => fixtureAt });
    const cleanupAt = new Date(Date.parse(fixtureAt) + 86400000).toISOString();
    const result = await cleanupRetention(repo, cleanupAt, dryRun);
    console.log(JSON.stringify({ fictional: true, mode: dryRun ? 'dry-run' : 'temporary-fixture-cleanup', ...result, retentionReviewRequired: (await repo.read()).retentionReviewRequired }));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
main().catch(() => { console.error('Fictional retention cleanup failed'); process.exitCode = 1; });
