import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { seedEditionFixture, editionAt } from '../fixtures/edition-fiction.ts';
import { EditionService } from '../src/editions/service.ts';
import { previewEdition } from '../src/editions/preview.ts';
import { sectionIds, sectionLabels } from '../src/editions/types.ts';
import { JsonRepository } from '../src/newsroom/store.ts';

const execute = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function withFixture(run: (repository: JsonRepository, fixture: Awaited<ReturnType<typeof seedEditionFixture>>, service: EditionService) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-edition-preview-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const fixture = await seedEditionFixture(repository);
    await run(repository, fixture, new EditionService(repository, { clock: () => editionAt }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function secondStory(fixture: Awaited<ReturnType<typeof seedEditionFixture>>) {
  const { version: _, status: __, ...input } = fixture.story;
  const id = 'fictional-second-edition-story';
  await fixture.newsroom.create({ ...input, id, headline: input.evidence[1].claim, summary: input.evidence[1].claim }, 'fictional-edition-editor');
  for (const status of ['CLUSTERED', 'DRAFT', 'NEEDS_REVIEW'] as const) await fixture.newsroom.transition(id, status, 'fictional-edition-editor');
  return fixture.newsroom.transition(id, 'APPROVED', 'fictional-edition-reviewer');
}

test('edition fixture uses actual exact-revision newsroom approval with fictional eligible sources', async () => {
  await withFixture(async (repository, fixture) => {
    const state = await repository.read();
    assert.equal(fixture.story.status, 'APPROVED');
    assert.equal(state.revisions.at(-1)?.version, fixture.story.version);
    assert.ok(state.approvals.some(approval => approval.storyId === fixture.story.id && approval.version === fixture.story.version));
    assert.equal(fixture.sources.length, 2);
    assert.ok(state.sources.every(source => new URL(source.url).hostname.endsWith('.test')));
    assert.equal(editionAt, '2026-06-01T12:00:00.000Z');
  });
});

test('preview repeats deterministically and is explicitly fictional, development-only and unpublished', async () => {
  await withFixture(async (repository, fixture, service) => {
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES', featured: true },
    ] }, 'fictional-edition-editor');
    const first = await previewEdition(service, edition.id);
    const second = await previewEdition(service, edition.id);
    assert.deepEqual(first, second);
    assert.equal(first.label, 'Fictional development edition preview');
    assert.equal(first.fictional, true);
    assert.equal(first.developmentOnly, true);
    assert.equal(first.publiclyPublished, false);
    assert.equal(first.date, '2026-06-01');
    assert.equal(first.timezone, 'UTC');
    assert.equal(first.revision, 1);
    assert.equal(first.status, 'ASSEMBLING');
    assert.match(first.reviewLabel, /human review/i);
    assert.equal((await repository.read()).revisions.at(-1)?.status, 'APPROVED');
  });
});

test('preview always renders the eight canonical sections and preserves empty sections', async () => {
  await withFixture(async (_repository, fixture, service) => {
    const other = await secondStory(fixture);
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: other.id, storyVersion: other.version, section: 'SCIENCE' },
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES' },
    ] }, 'fictional-edition-editor');
    const preview = await previewEdition(service, edition.id);
    assert.deepEqual(preview.sections.map(section => section.id), [...sectionIds]);
    assert.deepEqual(preview.sections.map(section => section.label), sectionIds.map(id => sectionLabels[id]));
    assert.equal(preview.sections.filter(section => section.placements.length === 0).length, 6);
    assert.equal(preview.sections[0].placements[0].storyId, fixture.story.id);
    assert.equal(preview.sections.find(section => section.id === 'SCIENCE')!.placements[0].storyId, other.id);
  });
});

test('placement order within a section follows the explicitly supplied editorial order', async () => {
  await withFixture(async (_repository, fixture, service) => {
    const other = await secondStory(fixture);
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: other.id, storyVersion: other.version, section: 'TOP_STORIES', featured: true },
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES' },
    ] }, 'fictional-edition-editor');
    const preview = await previewEdition(service, edition.id);
    assert.deepEqual(preview.sections[0].placements.map(placement => placement.storyId), [other.id, fixture.story.id]);
    assert.deepEqual(preview.sections[0].placements.map(placement => placement.featured), [true, false]);
  });
});

test('preview canonicalizes section display without sorting editorial placement order', async () => {
  await withFixture(async (_repository, fixture, service) => {
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'HEALTH' },
    ] }, 'fictional-edition-editor');
    const preview = await previewEdition({ snapshot: async () => ({ ...edition, sections: [...edition.sections].reverse() }) }, edition.id);
    assert.deepEqual(preview.sections.map(section => section.id), [...sectionIds]);
    assert.equal(preview.sections.at(-1)?.placements[0].storyId, fixture.story.id);
  });
});

test('source attribution, independent counts and evidence references survive preview rendering', async () => {
  await withFixture(async (repository, fixture, service) => {
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES' },
    ] }, 'fictional-edition-editor');
    const preview = await previewEdition(service, edition.id);
    const placement = preview.sections[0].placements[0];
    const sources = (await repository.read()).sources;
    assert.equal(placement.independentSourceCount, 2);
    assert.deepEqual(new Set(placement.sources.map(source => source.sourceId)), new Set(sources.map(source => source.id)));
    for (const actual of placement.sources) {
      const source = sources.find(source => source.id === actual.sourceId)!;
      assert.deepEqual(actual, { sourceId: source.id, originId: source.originId, publisher: source.publisher, url: source.url });
    }
    assert.deepEqual(placement.evidence, fixture.story.evidence.map(evidence => ({ id: evidence.id, support: evidence.support, contradict: evidence.contradict, uncertainty: evidence.uncertainty })));
    assert.ok(placement.sources.every(source => source.publisher.startsWith('Fictional ') && new URL(source.url).hostname.endsWith('.test')));
  });
});

test('preview preserves uncertainty and explicitly discloses selected counterevidence', async () => {
  await withFixture(async (_repository, fixture, service) => {
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES' },
    ] }, 'fictional-edition-editor');
    const placement = (await previewEdition(service, edition.id)).sections[0].placements[0];
    assert.deepEqual(placement.uncertainties, fixture.story.evidence.map(evidence => evidence.uncertainty));
    assert.equal(placement.contradictionDisclosure.recorded, true);
    assert.match(placement.contradictionDisclosure.label, /Counterevidence is recorded/);
    assert.deepEqual(placement.contradictionDisclosure.evidence, [{ evidenceId: 'claim-a', sourceIds: [fixture.sources[1]] }]);
  });
});

test('preview exposes stored advisory concerns for human review without changing edition status', async () => {
  await withFixture(async (_repository, fixture, service) => {
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES', featured: true },
    ] }, 'fictional-edition-editor');
    const preview = await previewEdition(service, edition.id);
    assert.ok('suggestions' in preview);
    assert.deepEqual(preview.suggestions, edition.suggestions);
    assert.ok(preview.suggestions.some(suggestion => suggestion.code === 'MISLEADING_PROMINENCE'));
    assert.ok(preview.suggestions.every(suggestion => suggestion.storyId === fixture.story.id && suggestion.message.length > 0));
    assert.equal(preview.status, 'ASSEMBLING');
    assert.equal(preview.publiclyPublished, false);
  });
});

test('an empty assembling edition displays empty sections without fabricated stories', async () => {
  await withFixture(async (_repository, _fixture, service) => {
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [] }, 'fictional-edition-editor');
    const preview = await previewEdition(service, edition.id);
    assert.equal(preview.status, 'ASSEMBLING');
    assert.equal(preview.sections.length, 8);
    assert.ok(preview.sections.every(section => section.placements.length === 0));
    assert.equal(JSON.stringify(preview).includes('fictional-editorial-story'), false);
  });
});

test('review labels track internal states without converting an approval proposal into publication', async () => {
  await withFixture(async (repository, fixture, service) => {
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES' },
    ] }, 'fictional-edition-editor');
    const needsReview = await service.review(edition.id, edition.revision, 'NEEDS_REVIEW', 'fictional-edition-reviewer');
    assert.equal((await previewEdition(service, edition.id)).reviewLabel, 'Human review is required.');
    await service.review(edition.id, needsReview.revision, 'READY_FOR_APPROVAL', 'fictional-edition-reviewer');
    const ready = await previewEdition(service, edition.id);
    assert.equal(ready.status, 'READY_FOR_APPROVAL');
    assert.equal(ready.revision, 3);
    assert.match(ready.reviewLabel, /unauthenticated/);
    assert.equal(ready.publiclyPublished, false);
    const state = await repository.read();
    assert.equal(state.revisions.at(-1)?.status, 'APPROVED');
    assert.ok(state.editionReviews.every(review => review.unauthenticated));
    assert.equal(state.audit.some(event => /PUBLISHED/.test(event.action)), false);
  });
});

test('only one Top Stories placement can be featured', async () => {
  await withFixture(async (_repository, fixture, service) => {
    const other = await secondStory(fixture);
    await assert.rejects(service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'SCIENCE', featured: true },
    ] }, 'fictional-edition-editor'), /INVALID_FEATURED_PLACEMENT/);
    await assert.rejects(service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES', featured: true },
      { storyId: other.id, storyVersion: other.version, section: 'TOP_STORIES', featured: true },
    ] }, 'fictional-edition-editor'), /INVALID_FEATURED_PLACEMENT/);
  });
});

test('preview obtains a fresh validated snapshot on every call', async () => {
  await withFixture(async (_repository, fixture, service) => {
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES' },
    ] }, 'fictional-edition-editor');
    let snapshots = 0;
    const observed = { snapshot: async (id: string) => { snapshots++; return service.snapshot(id); } };
    await previewEdition(observed, edition.id);
    await fixture.newsroom.edit(fixture.story.id, { summary: 'A revised fictional proposal remains under review' }, 'fictional-edition-editor');
    const invalid = await previewEdition(observed, edition.id);
    assert.equal(snapshots, 2);
    assert.equal(invalid.status, 'INVALIDATED');
    assert.deepEqual(invalid.sections, []);
    assert.equal(invalid.publiclyPublished, false);
  });
});

test('invalidated preview and persisted edition history retain no licensed story or source payload', async () => {
  await withFixture(async (repository, fixture, service) => {
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES' },
    ] }, 'fictional-edition-editor');
    await service.review(edition.id, edition.revision, 'NEEDS_REVIEW', 'fictional-edition-reviewer');
    await fixture.newsroom.edit(fixture.story.id, { summary: 'A changed fictional proposal' }, 'fictional-edition-editor');
    const preview = await previewEdition(service, edition.id);
    assert.equal(preview.status, 'INVALIDATED');
    assert.deepEqual(preview.sections, []);
    assert.equal('suggestions' in preview, false);
    assert.match(preview.reviewLabel, /Invalidated/);
    const history = (await repository.read()).editions.filter(row => row.id === edition.id);
    assert.ok(history.every(row => row.status === 'INVALIDATED'));
    const serialized = JSON.stringify({ preview, history });
    for (const value of [fixture.story.id, fixture.story.headline, fixture.story.summary, ...fixture.sources, 'editorial.example.test', 'Fictional first report']) {
      assert.equal(serialized.includes(value), false, `Invalidated payload must omit ${value}`);
    }
  });
});

test('source expiry invalidates a previously rendered edition before another preview is returned', async () => {
  await withFixture(async (repository, fixture) => {
    let now = editionAt;
    const service = new EditionService(repository, { clock: () => now });
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES' },
    ] }, 'fictional-edition-editor');
    assert.equal((await previewEdition(service, edition.id)).status, 'ASSEMBLING');
    now = edition.sections[0].placements[0].expiresAt;
    const expired = await previewEdition(service, edition.id);
    assert.equal(expired.status, 'INVALIDATED');
    assert.deepEqual(expired.sections, []);
  });
});

test('mutating preview objects cannot change persisted placements or future rendering', async () => {
  await withFixture(async (_repository, fixture, service) => {
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: fixture.story.id, storyVersion: fixture.story.version, section: 'TOP_STORIES' },
    ] }, 'fictional-edition-editor');
    const expected = await previewEdition(service, edition.id);
    const changed = await previewEdition(service, edition.id);
    changed.sections[0].placements[0].sources[0].publisher = 'caller-mutation';
    changed.sections[0].placements[0].evidence[0].contradict.push('caller-reference');
    changed.sections.reverse();
    assert.deepEqual(await previewEdition(service, edition.id), expected);
  });
});

test('fixture runner produces repeatable JSON and removes every temporary repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-runner-sandbox-'));
  try {
    const invoke = () => execute(process.execPath, ['--experimental-strip-types', 'src/editions/runner.ts'], { cwd: repositoryRoot, env: { ...process.env, TMPDIR: directory } });
    const first = await invoke(); const second = await invoke();
    assert.equal(first.stdout, second.stdout);
    const preview = JSON.parse(first.stdout);
    assert.equal(preview.fictional, true);
    assert.equal(preview.developmentOnly, true);
    assert.equal(preview.publiclyPublished, false);
    assert.equal(preview.sections.length, 8);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fixture runner rejects live and repository-path arguments before creating a temporary file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-runner-arguments-'));
  try {
    for (const argument of ['--live', '--repository=/workspace/Dayline', '--publish']) {
      await assert.rejects(execute(process.execPath, ['--experimental-strip-types', 'src/editions/runner.ts', argument], { cwd: repositoryRoot, env: { ...process.env, TMPDIR: directory } }));
      assert.deepEqual(await readdir(directory), []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
