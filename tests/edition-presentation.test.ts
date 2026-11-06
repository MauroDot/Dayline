import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server.ts';
import { seedEditionFixture, editionAt } from '../fixtures/edition-fiction.ts';
import { EditionService } from '../src/editions/service.ts';
import { displayForEdition, createFictionalDisplaySource, sanitizeEditionDisplay } from '../src/editions/presentation.ts';
import type { EditionDisplay, EditionDisplaySource } from '../src/editions/presentation-types.ts';
import { cleanupRetention } from '../src/ingestion/retention.ts';
import { JsonRepository } from '../src/newsroom/store.ts';

const expiresAt = '2026-06-02T12:00:00.000Z';
const gate = { NODE_ENV: 'development', DAYLINE_DEV_EDITION: 'fictional' };
const devPaths = ['/dev/edition', '/dev/edition/edition.css', '/dev/edition/edition.js', '/dev/edition/preview'];

async function environment<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await run(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

async function fixture(run: (context: { repository: JsonRepository; service: EditionService; id: string; storyId: string; storyVersion: number;
  clock: () => string; advance: (at: string) => void; newsroom: Awaited<ReturnType<typeof seedEditionFixture>>['newsroom'] }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-display-tests-'));
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const seeded = await seedEditionFixture(repository);
    let now = editionAt;
    const clock = () => now;
    const service = new EditionService(repository, { clock });
    const edition = await service.create({ date: '2026-06-01', timezone: 'UTC', placements: [
      { storyId: seeded.story.id, storyVersion: seeded.story.version, section: 'TOP_STORIES', featured: true },
    ] }, 'fictional-display-editor');
    await run({ repository, service, id: edition.id, storyId: seeded.story.id, storyVersion: seeded.story.version,
      clock, advance: value => { now = value; }, newsroom: seeded.newsroom });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function withServer(options: Parameters<typeof createServer>[0], run: (request: (path: string, options?: RequestInit) => Promise<Response>, port: number) => Promise<void>): Promise<void> {
  const server = createServer(options);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing test listener');
  // Raw HTTP preserves adversarial Host headers instead of letting fetch replace
  // them with the connection authority before the gate can inspect them.
  const request = (path: string, options: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(options.headers).entries());
    headers.host ??= `localhost:${address.port}`;
    const outgoing = http.request({ hostname: '127.0.0.1', port: address.port, path, method: options.method ?? 'GET', headers }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.once('error', reject);
      incoming.once('end', () => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        resolve(new Response(options.method === 'HEAD' ? null : Buffer.concat(chunks),
          { status: incoming.statusCode, statusText: incoming.statusMessage, headers: responseHeaders }));
      });
    });
    outgoing.once('error', reject); outgoing.setTimeout(2000, () => outgoing.destroy(Error('Controlled HTTP test timeout')));
    outgoing.end();
  });
  try { await run(request, address.port); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

function source(read: EditionDisplaySource['read']): EditionDisplaySource { return { read, async dispose() {} }; }
function assertHeaders(response: Response): void {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const csp = response.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/); assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/); assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
}

function assertSafeDisplay(display: EditionDisplay): void {
  assert.deepEqual(Object.keys(display).sort(), ['fictional', 'developmentOnly', 'publiclyPublished', 'date', 'timezone', 'revision', 'status', 'reviewLabel', 'validForMs', 'sections'].sort());
  assert.equal(display.fictional, true); assert.equal(display.developmentOnly, true); assert.equal(display.publiclyPublished, false);
  assert.ok(Number.isSafeInteger(display.validForMs) && display.validForMs > 0 && display.validForMs <= 15000);
  for (const section of display.sections) {
    assert.deepEqual(Object.keys(section).sort(), ['id', 'label', 'placements'].sort());
    for (const placement of section.placements) {
      assert.deepEqual(Object.keys(placement).sort(), ['headline', 'summary', 'featured', 'sources', 'uncertainties', 'counterevidence'].sort());
      assert.deepEqual(Object.keys(placement.counterevidence).sort(), ['recorded', 'label', 'sources'].sort());
      for (const attribution of [...placement.sources, ...placement.counterevidence.sources]) {
        assert.deepEqual(Object.keys(attribution).sort(), ['publisher', 'url']);
        const url = new URL(attribution.url);
        assert.ok(url.hostname.endsWith('.test')); assert.equal(url.username, ''); assert.equal(url.password, '');
        assert.ok(['http:', 'https:'].includes(url.protocol));
      }
    }
  }
  assert.doesNotMatch(JSON.stringify(display), /url-[a-f0-9]{64}|snapshotDigest|actorAssertion|reviewer|policyId|policyVersion|fictional-ai-editorial-v1|fictional-editorial-story|fictional-display-editor/);
}

test('display projects the actual approved fixture with no internal IDs grants actors or audit fields', async () => {
  await fixture(async context => {
    const display = await displayForEdition(context.service, context.id, context.clock);
    assert.ok(display); assertSafeDisplay(display);
    const placement = display.sections.flatMap(section => section.placements)[0];
    assert.equal(placement.headline, 'A fictional garden proposal is under review');
    assert.equal(placement.summary, 'A fictional proposal is being considered');
    assert.equal(placement.counterevidence.recorded, true); assert.equal(placement.counterevidence.sources.length, 1);
    assert.equal(placement.sources.length, 2); assert.equal(placement.uncertainties.length, 2);
    assert.equal(JSON.stringify(display).includes(context.id), false);
    const persisted = await context.repository.read();
    assert.equal(persisted.revisions.at(-1)?.status, 'APPROVED');
    assert.equal(persisted.editions.at(-1)?.status, 'ASSEMBLING');
  });
});

test('every display read revalidates current edition and source state rather than reusing a projection', async () => {
  await fixture(async context => {
    let reads = 0;
    const snapshot = context.service.snapshot.bind(context.service);
    context.service.snapshot = async id => { reads++; return snapshot(id); };
    assert.ok(await displayForEdition(context.service, context.id, context.clock));
    assert.ok(await displayForEdition(context.service, context.id, context.clock));
    assert.equal(reads, 2);
    await context.newsroom.edit(context.storyId, { summary: 'Changed fictional presentation requires a new review.' }, 'fictional-editor');
    assert.equal(await displayForEdition(context.service, context.id, context.clock), null);
    assert.equal(reads, 3);
  });
});

test('rights expiry and applied cleanup invalidate display without retaining the copied presentation', async () => {
  await fixture(async context => {
    assert.ok(await displayForEdition(context.service, context.id, context.clock));
    context.advance(expiresAt);
    assert.equal(await displayForEdition(context.service, context.id, context.clock), null);
    await cleanupRetention(context.repository, expiresAt, false);
    const state = await context.repository.read();
    assert.equal(state.retentionReviewRequired, true);
    assert.equal(state.editions.at(-1)?.status, 'INVALIDATED');
    assert.equal(await displayForEdition(context.service, context.id, context.clock), null);
    assert.equal(JSON.stringify(state.editions).includes('A fictional garden proposal is under review'), false);
  });
});

test('retention review holds block otherwise unexpired display and short leases respect remaining source rights', async () => {
  await fixture(async context => {
    context.advance('2026-06-02T11:59:59.990Z');
    const short = await displayForEdition(context.service, context.id, context.clock);
    assert.ok(short); assert.ok(short.validForMs > 0 && short.validForMs <= 10);
    await context.repository.transact(state => { state.retentionReviewRequired = true; });
    assert.equal(await displayForEdition(context.service, context.id, context.clock), null);
  });
});

test('a snapshot that completes after source rights expire cannot produce a positive display lease', async () => {
  await fixture(async context => {
    const snapshot = context.service.snapshot.bind(context.service);
    context.service.snapshot = async id => { const edition = await snapshot(id); context.advance(expiresAt); return edition; };
    assert.equal(await displayForEdition(context.service, context.id, context.clock), null);
  });
});

test('lazy fictional display source coalesces initialization and stops serving after disposal', async () => {
  const display = createFictionalDisplaySource({ clock: () => editionAt });
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => display.read()));
    for (const result of results) { assert.ok(result); assertSafeDisplay(result); }
    assert.deepEqual(results[0], results[1]);
  } finally { await display.dispose(); }
  assert.equal(await display.read(), null);
});

test('display boundary strips unknown private fields and rejects unsafe attribution without publishing a partial projection', async () => {
  await fixture(async context => {
    const original = await displayForEdition(context.service, context.id, context.clock); assert.ok(original);
    const injected = structuredClone(original);
    Object.assign(injected, { repositoryPath: '/workspace/FICTIONAL_PRIVATE_PATH', audit: [{ actorAssertion: 'FICTIONAL_PRIVATE_ACTOR' }] });
    Object.assign(injected.sections[0].placements[0], { storyId: context.storyId, sourceIds: ['FICTIONAL_PRIVATE_SOURCE_ID'], policyId: 'FICTIONAL_PRIVATE_POLICY' });
    Object.assign(injected.sections[0].placements[0].sources[0], { sourceId: 'FICTIONAL_PRIVATE_SOURCE_ID', rights: 'FICTIONAL_PRIVATE_RIGHTS' });
    const sanitized = sanitizeEditionDisplay(injected); assert.ok(sanitized); assertSafeDisplay(sanitized);
    assert.doesNotMatch(JSON.stringify(sanitized), /FICTIONAL_PRIVATE|repositoryPath|sourceIds|rights/);
    for (const url of ['https://real.example.com/report', 'https://user:password@fiction.example.test/report', 'javascript:alert(1)',
      'https://fiction.example.test/report?api_key=FICTIONAL_PRIVATE_KEY']) {
      const unsafe: EditionDisplay = structuredClone(original); unsafe.sections[0].placements[0].sources[0].url = url;
      assert.equal(sanitizeEditionDisplay(unsafe), null);
    }
    assert.equal(JSON.stringify(original).includes('FICTIONAL_PRIVATE'), false);
  });
});

test('all development edition routes require exact environment opt-in even when a source seam is supplied', async () => {
  for (const values of [
    { NODE_ENV: 'production', DAYLINE_DEV_EDITION: 'fictional' },
    { NODE_ENV: undefined, DAYLINE_DEV_EDITION: 'fictional' },
    { NODE_ENV: 'test', DAYLINE_DEV_EDITION: 'fictional' },
    { NODE_ENV: 'development', DAYLINE_DEV_EDITION: undefined },
    { NODE_ENV: 'development', DAYLINE_DEV_EDITION: 'FICTIONAL' },
    { NODE_ENV: 'development', DAYLINE_DEV_EDITION: 'fictional ' },
    { NODE_ENV: 'development ', DAYLINE_DEV_EDITION: 'fictional' },
  ]) {
    await environment(values, async () => {
      let reads = 0;
      await withServer({ editionSource: source(async () => { reads++; throw Error('FICTIONAL_PRIVATE_GATE_DETAIL'); }) }, async request => {
        for (const path of devPaths) {
          const response = await request(path); assert.equal(response.status, 404, `${values.NODE_ENV}/${values.DAYLINE_DEV_EDITION}: ${path}`);
          assert.equal((await response.json()).error, 'Not found');
        }
      });
      assert.equal(reads, 0);
    });
  }
});

test('enabled edition HTML assets and preview use restrictive no-store headers with correct HEAD semantics', async () => {
  await environment(gate, async () => fixture(async context => {
    await withServer({ editionSource: source(() => displayForEdition(context.service, context.id, context.clock)) }, async request => {
      for (const path of devPaths) {
        const response = await request(path); assert.equal(response.status, 200, path); assertHeaders(response);
        if (path.endsWith('/preview')) assertSafeDisplay(await response.json());
        else assert.ok((await response.text()).length > 0);
        const head = await request(path, { method: 'HEAD' }); assert.equal(head.status, 200); assertHeaders(head); assert.equal(await head.text(), '');
      }
    });
  }));
});

test('hostnames query parameters unknown files and alternate routes cannot address an edition', async () => {
  await environment(gate, async () => fixture(async context => {
    let reads = 0;
    await withServer({ editionSource: source(async () => { reads++; return displayForEdition(context.service, context.id, context.clock); }) }, async (request, port) => {
      for (const host of [`203.0.113.10:${port}`, `example.test:${port}`, `localhost.example.test:${port}`, `localhost@evil.test:${port}`, `localhost:${port}.evil.test`]) {
        const response = await request('/dev/edition/preview', { headers: { Host: host } }); assert.equal(response.status, 404, host);
        assert.doesNotMatch(await response.text(), /garden proposal|FICTIONAL_PRIVATE/);
      }
      const crossSite = await request('/dev/edition/preview', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
      assert.equal(crossSite.status, 404); assert.equal((await crossSite.json()).error, 'Not found');
      for (const path of ['/dev/edition?editionId=arbitrary', '/dev/edition/preview?id=arbitrary', '/dev/edition/preview?path=/workspace/private.json',
        '/dev/edition/edition.css?cache=1', '/dev/edition/edition.js?callback=alert', '/dev/edition/', '/dev/edition/server.ts',
        '/dev/edition/presentation.ts', '/dev/edition/.env', '/dev/edition/%2e%2e/server.ts', '/dev/edition/preview/arbitrary']) {
        const response = await request(path); assert.equal(response.status, 404, path);
        assert.doesNotMatch(await response.text(), /garden proposal|workspace\/private/);
      }
      assert.equal(reads, 0);
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
        const response = await request('/dev/edition/preview', { headers: { Host: host } }); assert.equal(response.status, 200, host);
        assertSafeDisplay(await response.json());
      }
      assert.equal(reads, 3);
    });
  }));
});

test('non-loopback peers fail the gate even with localhost Host and enabled configuration', async () => {
  await environment(gate, async () => {
    let reads = 0;
    const server = createServer({ editionSource: source(async () => { reads++; return null; }) });
    const socket = new net.Socket();
    Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.10' });
    const incoming = new http.IncomingMessage(socket); incoming.method = 'GET'; incoming.url = '/dev/edition/preview'; incoming.headers.host = 'localhost';
    const outgoing = new http.ServerResponse(incoming);
    const body = await new Promise<string>(resolve => {
      outgoing.end = ((chunk?: unknown) => { resolve(chunk === undefined ? '' : String(chunk)); return outgoing; }) as typeof outgoing.end;
      server.emit('request', incoming, outgoing);
    });
    assert.equal(outgoing.statusCode, 404); assert.equal(JSON.parse(body).error, 'Not found'); assert.equal(reads, 0);
    socket.destroy();
  });
});

test('development routes reject writes and unavailable invalid or throwing sources disclose no payload', async () => {
  await environment(gate, async () => {
    for (const read of [async () => null, async () => { throw Error('FICTIONAL_PRIVATE_PROVIDER_DETAIL'); }]) {
      await withServer({ editionSource: source(read) }, async request => {
        const response = await request('/dev/edition/preview'); assert.equal(response.status, 503); assertHeaders(response);
        assert.deepEqual(await response.json(), { error: 'Fictional edition currently unavailable' });
        for (const method of ['POST', 'PUT', 'DELETE']) {
          const denied = await request('/dev/edition/preview', { method }); assert.equal(denied.status, 405);
          assert.doesNotMatch(await denied.text(), /FICTIONAL_PRIVATE|garden proposal/);
        }
      });
    }
    for (const invalid of [
      { fictional: false, developmentOnly: true, publiclyPublished: false, validForMs: 1000, status: 'ASSEMBLING' },
      { fictional: true, developmentOnly: false, publiclyPublished: false, validForMs: 1000, status: 'ASSEMBLING' },
      { fictional: true, developmentOnly: true, publiclyPublished: true, validForMs: 1000, status: 'ASSEMBLING' },
      { fictional: true, developmentOnly: true, publiclyPublished: false, validForMs: 1000, status: 'INVALIDATED' },
      { fictional: true, developmentOnly: true, publiclyPublished: false, validForMs: 15001, status: 'ASSEMBLING' },
    ]) {
      await withServer({ editionSource: source(async () => invalid as EditionDisplay) }, async request => {
        const response = await request('/dev/edition/preview'); assert.equal(response.status, 503); assertHeaders(response);
        assert.deepEqual(await response.json(), { error: 'Fictional edition currently unavailable' });
      });
    }
  });
});

test('HTTP projection defensively strips nested private fields supplied by a source seam', async () => {
  await environment(gate, async () => fixture(async context => {
    const display = await displayForEdition(context.service, context.id, context.clock); assert.ok(display);
    Object.assign(display, { sourceId: 'FICTIONAL_PRIVATE_HASH', actorAssertion: 'FICTIONAL_PRIVATE_ACTOR' });
    Object.assign(display.sections[0].placements[0], { storyId: context.storyId, policyId: 'FICTIONAL_PRIVATE_GRANT' });
    await withServer({ editionSource: source(async () => display) }, async request => {
      const response = await request('/dev/edition/preview'); assert.equal(response.status, 200); assertHeaders(response);
      const projected = await response.json(); assertSafeDisplay(projected);
      assert.doesNotMatch(JSON.stringify(projected), /FICTIONAL_PRIVATE/);
    });
  }));
});

test('homepage static allowlist and official-data endpoints keep their existing contracts', async () => {
  await environment({ ...gate, NWS_USER_AGENT: 'Dayline deterministic test (test@dayline.invalid)' }, async () => {
    const calls: string[] = [];
    const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input); calls.push(url);
      if (url.includes('fiscaldata.treasury.gov')) return new Response(JSON.stringify({ data: [{ record_date: '2026-06-01', tot_pub_debt_out_amt: '3.00', debt_held_public_amt: '2.00', intragov_hold_amt: '1.00' }] }));
      if (url.includes('/points/')) return new Response(JSON.stringify({ properties: { forecast: 'https://api.weather.gov/gridpoints/TSA/1,1/forecast' } }));
      return new Response(JSON.stringify({ properties: { updated: editionAt, periods: [{ name: 'Fictional test period', detailedForecast: 'Controlled forecast fixture.', temperature: 70, temperatureUnit: 'F', windSpeed: '5 mph' }] } }));
    }) as typeof fetch;
    await withServer({ fetcher }, async request => {
      const home = await request('/'); assert.equal(home.status, 200);
      assert.equal(await home.text(), await readFile(new URL('../public/index.html', import.meta.url), 'utf8'));
      assert.deepEqual(await (await request('/api/health')).json(), { ok: true, service: 'dayline', mode: 'foundation' });
      const debt = await request('/api/debt'), debtBody = await debt.json();
      assert.equal(debt.status, 200); assert.equal(debtBody.data.total, '3.00'); assert.equal(debtBody.data.asOf, '2026-06-01'); assert.equal(debtBody.stale, false);
      const weather = await request('/api/weather?city=Tulsa'), weatherBody = await weather.json();
      assert.equal(weather.status, 200); assert.equal(weatherBody.data.description, 'Controlled forecast fixture.'); assert.equal(weatherBody.data.sourceUpdatedAt, editionAt);
      for (const path of ['/server.ts', '/.env', '/src/editions/presentation.ts', '/edition.js']) assert.equal((await request(path)).status, 404);
      assert.equal(calls.length, 3);
    });
  });
});
