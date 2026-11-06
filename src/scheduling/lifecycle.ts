import type { State } from '../newsroom/model.ts';
import { timestamp } from '../ingestion/metadata.ts';
import type { PreparationRun } from './types.ts';

/** A preparation result never remains ready after its exact edition loses eligibility. */
export function reconcilePreparedRuns(state: State, at: string): number {
  const updatedAt = new Date(timestamp(at)).toISOString();
  let changed = 0;
  state.preparationRuns = state.preparationRuns.map(run => {
    if (run.status !== 'PREPARED') return run;
    const edition = state.editions.find(row => row.id === run.editionId && row.revision === run.editionRevision);
    if (edition && edition.status !== 'INVALIDATED') return run;
    changed++;
    const occurrence = run.occurrence;
    // Keep procedural bookkeeping only; do not copy hidden prose or linkages.
    const reconciled: PreparationRun = { id: run.id, scheduleId: run.scheduleId,
      occurrence: { key: occurrence.key, date: occurrence.date, timezone: occurrence.timezone,
        localTime: occurrence.localTime, at: occurrence.at },
      status: 'NEEDS_ATTENTION', attempts: run.attempts, maxAttempts: run.maxAttempts,
      retryDelayMs: run.retryDelayMs, claimId: null, leaseUntil: null, nextRetryAt: null,
      editionId: run.editionId, editionRevision: run.editionRevision,
      failure: 'INELIGIBLE_CONTENT', missedSince: run.missedSince, createdAt: run.createdAt, updatedAt };
    return reconciled;
  });
  return changed;
}
