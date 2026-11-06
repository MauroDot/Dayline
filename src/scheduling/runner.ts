/** A bounded, isolated fictional fixture. No existing repository or live mode is accepted. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedEditionFixture } from '../../fixtures/edition-fiction.ts';
import { JsonRepository } from '../newsroom/store.ts';
import { SchedulerService } from './service.ts';
import type { PreparationRun } from './types.ts';

const createdAt = '2026-06-01T11:59:00.000Z';
const dueAt = '2026-06-01T12:00:00.000Z';
function inspection(run: PreparationRun) {
  return { date: run.occurrence.date, timezone: run.occurrence.timezone, localTime: run.occurrence.localTime,
    dueAt: run.occurrence.at, status: run.status, attempts: run.attempts, maxAttempts: run.maxAttempts,
    failure: run.failure, missedSince: run.missedSince, editionRevision: run.editionRevision };
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || arguments_.some(value => value !== '--apply-fixture')) throw Error('Unsupported fixture arguments');
  const apply = arguments_.length === 1;
  const directory = await mkdtemp(join(tmpdir(), 'dayline-fictional-schedule-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const fixture = await seedEditionFixture(repository, createdAt);
    let now = createdAt;
    const service = new SchedulerService(repository, { clock: () => now });
    const schedule = await service.create({ name: 'Fictional noon preparation', timezone: 'UTC', localTime: '12:00', weekdays: [0,1,2,3,4,5,6], enabled: true });
    now = dueAt;
    const evaluated = await service.evaluate({ dryRun: !apply });
    const planned = evaluated.runs.find(run => run.scheduleId === schedule.id);
    if (!planned) throw Error('Missing fictional preparation');
    let observed = planned;
    if (apply) {
      const claimed = await service.claim(planned.id);
      if (!claimed.claimId) throw Error('Missing fixture claim');
      await service.begin(claimed.id, claimed.claimId);
      observed = await service.prepare(claimed.id, claimed.claimId, [
        { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES', featured: true },
      ]);
    }
    const snapshot = await service.snapshot();
    const state = await repository.read();
    console.log(JSON.stringify({ fictional: true, developmentOnly: true, publiclyPublished: false,
      mode: apply ? 'temporary-fixture-apply' : 'dry-run', clock: dueAt,
      schedule: { name: schedule.name, timezone: schedule.timezone, localTime: schedule.localTime },
      run: inspection(observed), persistedRuns: snapshot.runs.length, editions: state.editions.length }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch(() => { console.error('Fictional scheduling fixture failed'); process.exitCode = 1; });
