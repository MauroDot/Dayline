import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedEditionFixture } from '../../fixtures/edition-fiction.ts';
import { timestamp } from '../ingestion/metadata.ts';
import { JsonRepository } from '../newsroom/store.ts';
import { EditionService } from './service.ts';
import { previewEdition } from './preview.ts';
import type { EditionRevision } from './types.ts';
import { sectionIds, sectionLabels, type EditionStatus } from './types.ts';
import type { DisplaySource, EditionDisplay, EditionDisplaySource } from './presentation-types.ts';

function displaySource(source: { publisher: string; url: string }): DisplaySource {
  if (typeof source.publisher !== 'string' || !source.publisher.trim() || source.publisher.length > 256
    || typeof source.url !== 'string' || source.url.length > 2048) throw Error('Invalid fictional attribution');
  const url = new URL(source.url);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.test') || url.username || url.password
    || [...url.searchParams.keys()].some(key => /^(api_?key|token|access_token|key|secret|password)$/i.test(key))) throw Error('Invalid fictional attribution');
  return { publisher: source.publisher, url: source.url };
}

const displayStatuses: readonly EditionStatus[] = ['ASSEMBLING', 'NEEDS_REVIEW', 'READY_FOR_APPROVAL', 'REVISION_REQUESTED', 'ON_HOLD', 'REJECTED'];
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value'));
}
function plainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  const length = descriptors.length?.value;
  const keys = Reflect.ownKeys(descriptors);
  if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) return false;
  return keys.every(key => {
    if (typeof key !== 'string') return false;
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value')) return false;
    return key === 'length' || (/^(0|[1-9]\d*)$/.test(key) && Number(key) < length && descriptor.enumerable === true);
  });
}
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= limit;
}

/** Runtime boundary: return only reader fields, even if an injected source adds private data. */
export function sanitizeEditionDisplay(value: unknown): EditionDisplay | null {
  try {
    if (!record(value) || value.fictional !== true || value.developmentOnly !== true || value.publiclyPublished !== false
      || typeof value.status !== 'string' || !displayStatuses.includes(value.status as EditionStatus)
      || !text(value.date, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)
      || !Number.isFinite(Date.parse(value.date)) || new Date(value.date).toISOString().slice(0, 10) !== value.date
      || !text(value.timezone, 64) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
      || !text(value.reviewLabel, 256) || !Number.isSafeInteger(value.validForMs)
      || (value.validForMs as number) <= 0 || (value.validForMs as number) > 15_000
      || !plainArray(value.sections) || value.sections.length !== sectionIds.length) return null;
    new Intl.DateTimeFormat('en-US', { timeZone: value.timezone });
    let count = 0, featured = 0;
    const sources = (input: unknown, allowEmpty = false): DisplaySource[] => {
      if (!plainArray(input) || (!allowEmpty && input.length === 0) || input.length > 64) throw Error('Invalid display attribution');
      return input.map(source => {
        if (!record(source) || typeof source.publisher !== 'string' || typeof source.url !== 'string') throw Error('Invalid display attribution');
        return displaySource({ publisher: source.publisher, url: source.url });
      });
    };
    const sections: EditionDisplay['sections'] = value.sections.map((section: unknown, index: number) => {
      if (!record(section) || section.id !== sectionIds[index] || section.label !== sectionLabels[sectionIds[index]]
        || !plainArray(section.placements) || section.placements.length > 100) throw Error('Invalid display section');
      return { id: sectionIds[index], label: sectionLabels[sectionIds[index]], placements: section.placements.map((placement: unknown) => {
        if (++count > 100 || !record(placement) || !text(placement.headline, 512) || !text(placement.summary, 4096)
          || typeof placement.featured !== 'boolean' || !plainArray(placement.uncertainties) || placement.uncertainties.length > 16
          || !placement.uncertainties.every(item => text(item, 2048)) || !record(placement.counterevidence)
          || typeof placement.counterevidence.recorded !== 'boolean' || !text(placement.counterevidence.label, 256)) throw Error('Invalid display placement');
        if (placement.featured && (section.id !== 'TOP_STORIES' || ++featured > 1)) throw Error('Invalid display prominence');
        const attribution = sources(placement.sources);
        const counter = sources(placement.counterevidence.sources, true);
        if (placement.counterevidence.recorded !== (counter.length > 0)
          || counter.some(source => !attribution.some(known => known.publisher === source.publisher && known.url === source.url))) throw Error('Invalid display counterevidence');
        return { headline: placement.headline, summary: placement.summary, featured: placement.featured,
          sources: attribution, uncertainties: [...placement.uncertainties] as string[],
          counterevidence: { recorded: placement.counterevidence.recorded, label: placement.counterevidence.label, sources: counter } };
      }) };
    });
    if (!count) return null;
    return { fictional: true, developmentOnly: true, publiclyPublished: false,
      date: value.date, timezone: value.timezone, revision: value.revision as number,
      status: value.status as EditionStatus, reviewLabel: value.reviewLabel,
      validForMs: value.validForMs as number, sections };
  } catch { return null; }
}

/** A fresh domain snapshot precedes every response; no cached licensed payload is served. */
export async function displayForEdition(service: Pick<EditionService, 'snapshot'>, id: string, clock: () => string): Promise<EditionDisplay | null> {
  try {
    const capture: { edition?: EditionRevision } = {};
    const preview = await previewEdition({ snapshot: async editionId => {
      const edition = await service.snapshot(editionId);
      capture.edition = edition;
      return edition;
    } }, id);
    const edition = capture.edition;
    // Read time after the potentially queued repository transaction completes.
    const now = timestamp(clock());
    if (!edition || edition.status === 'INVALIDATED' || preview.status === 'INVALIDATED') return null;
    const placements = edition.sections.flatMap(section => section.placements);
    if (!placements.length) return null;
    const deadline = Math.min(...placements.map(placement => timestamp(placement.expiresAt)));
    if (!Number.isFinite(deadline) || deadline <= now) return null;
    const sections = preview.sections.map(section => ({ id: section.id, label: sectionLabels[section.id],
      placements: section.placements.map(placement => {
        const contradictoryIds = new Set(placement.evidence.flatMap(evidence => evidence.contradict));
        if ([...contradictoryIds].some(sourceId => !placement.sources.some(source => source.sourceId === sourceId))) throw Error('Missing fictional counterevidence');
        return { headline: placement.headline, summary: placement.summary, featured: placement.featured,
          sources: placement.sources.map(displaySource), uncertainties: [...placement.uncertainties],
          counterevidence: { recorded: placement.contradictionDisclosure.recorded, label: placement.contradictionDisclosure.label,
            sources: placement.sources.filter(source => contradictoryIds.has(source.sourceId)).map(displaySource) } };
      }) }));
    const display = sanitizeEditionDisplay({ fictional: true, developmentOnly: true, publiclyPublished: false, date: preview.date,
      timezone: preview.timezone, revision: preview.revision, status: preview.status,
      reviewLabel: preview.reviewLabel, validForMs: Math.min(15_000, deadline - now), sections });
    if (!display) return null;
    const completedAt = Math.max(now, timestamp(clock()));
    if (deadline <= completedAt) return null;
    display.validForMs = Math.min(15_000, deadline - completedAt);
    return display;
  } catch {
    // Errors and unavailable snapshots cannot expose repository paths or stale content.
    return null;
  }
}

interface FictionalRuntime { directory: string; service: EditionService; id: string }

/** Isolated known fixture only: no external repository, arbitrary ID, or live mode. */
export function createFictionalDisplaySource(options: { clock?: () => string } = {}): EditionDisplaySource {
  const clock = options.clock ?? (() => new Date().toISOString());
  let initialized: Promise<FictionalRuntime> | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const reads = new Set<Promise<EditionDisplay | null>>();

  async function initialize(): Promise<FictionalRuntime> {
    const at = new Date(timestamp(clock())).toISOString();
    const directory = await mkdtemp(join(tmpdir(), 'dayline-fictional-display-'));
    try {
      if (disposed) throw Error('Fictional display disposed');
      const repository = new JsonRepository(join(directory, 'fictional.json'));
      const fixture = await seedEditionFixture(repository, at);
      const service = new EditionService(repository, { clock });
      const timezone = 'America/Chicago';
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp(clock())));
      const datePart = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
      const date = `${datePart('year')}-${datePart('month')}-${datePart('day')}`;
      const edition = await service.create({ date, timezone, placements: [
        { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES', featured: true },
      ] }, 'fictional-edition-editor');
      if (disposed) throw Error('Fictional display disposed');
      return { directory, service, id: edition.id };
    } catch {
      await rm(directory, { recursive: true, force: true });
      throw Error('Fictional edition display unavailable');
    }
  }

  return {
    async read() {
      if (disposed) return null;
      initialized ??= initialize();
      const pending = (async () => {
        try {
          const runtime = await initialized;
          if (disposed || !runtime) return null;
          return await displayForEdition(runtime.service, runtime.id, clock);
        } catch { return null; }
      })();
      reads.add(pending);
      try { return await pending; } finally { reads.delete(pending); }
    },
    dispose() {
      disposal ??= (async () => {
        disposed = true;
        await Promise.allSettled([...reads]);
        if (initialized) {
          let runtime: FictionalRuntime;
          try { runtime = await initialized; } catch { return; }
          await rm(runtime.directory, { recursive: true, force: true });
        }
      })();
      return disposal;
    },
  };
}
