import test from 'node:test';
import assert from 'node:assert/strict';
import { GNewsProvider, ProviderError } from '../src/ingestion/gnews.ts';

const MAX_BYTES = 1024 * 1024;
const request = { query: 'fictional development candidates', page: 1, limit: 3 };
const privateMessage = 'fictional-private-key https://fiction.example.test/private?apikey=fictional-private-key BODY_PRIVATE';
const encode = (text: string) => new TextEncoder().encode(text);
const make = (transport: typeof fetch) => new GNewsProvider({ enabled: true, apiKey: 'fictional-private-key', transport });
const json = (value: unknown) => new Response(JSON.stringify(value));
const fixed = (code: string) => (error: unknown) => {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(String(error), /fictional-private-key|https:|BODY_PRIVATE/);
  return true;
};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const pending = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
function controlled(options: {
  chunks?: Uint8Array[];
  status?: number;
  contentLength?: string;
  read?: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel?: () => Promise<void>;
} = {}) {
  const state = { reads: 0, cancels: 0, releases: 0, acquired: 0 };
  const chunks = options.chunks ?? [encode('{"articles":[]}')];
  const cancel = () => { state.cancels++; return options.cancel?.() ?? Promise.resolve(); };
  const reader = {
    read: () => {
      const index = state.reads++;
      return options.read?.() ?? Promise.resolve(index < chunks.length ? { done: false as const, value: chunks[index] } : { done: true as const, value: undefined });
    },
    cancel,
    releaseLock: () => { state.releases++; }
  };
  const status = options.status ?? 200;
  const response = {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(options.contentLength === undefined ? {} : { 'content-length': options.contentLength }),
    body: { cancel, getReader: () => { state.acquired++; return reader; } }
  } as unknown as Response;
  return { response, state };
}

test('GNews bounds remain disabled by default with no transport call', async () => {
  let calls = 0;
  const transport = (async () => { calls++; throw Error(privateMessage); }) as typeof fetch;
  const provider = new GNewsProvider({ apiKey: 'fictional-private-key', transport });
  assert.deepEqual(provider.config, { name: 'GNews', maxArticles: 10, maxPage: 5, timeoutMs: 8000, maxAttempts: 3 });
  await assert.rejects(provider.discover(request), fixed('PROVIDER_DISABLED'));
  assert.equal(calls, 0);
});

test('configuration tampering cannot relax request bounds, deadlines or retry limits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const provider = make((async () => { calls++; throw Error(privateMessage); }) as typeof fetch);
  assert.equal(Object.isFrozen(provider.config), true);
  for (const [key, value] of [['maxArticles', 1000], ['maxPage', 1000], ['timeoutMs', 1000000], ['maxAttempts', 1000]] as const) {
    assert.equal(Reflect.set(provider.config, key, value), false);
  }
  assert.deepEqual(provider.config, { name: 'GNews', maxArticles: 10, maxPage: 5, timeoutMs: 8000, maxAttempts: 3 });
  await assert.rejects(provider.discover({ ...request, page: 6 }), fixed('INVALID_REQUEST'));
  await assert.rejects(provider.discover({ ...request, limit: 11 }), fixed('INVALID_REQUEST'));
  assert.equal(calls, 0);
  const result = assert.rejects(provider.discover(request), fixed('NETWORK_OR_TIMEOUT'));
  await flush(); t.mock.timers.tick(100); await flush(); t.mock.timers.tick(200);
  await result;
  assert.equal(calls, 3);
});

test('oversized Content-Length is rejected before any body read and is cancelled', async () => {
  const body = controlled({ contentLength: String(MAX_BYTES + 1), read: () => new Promise(() => {}) });
  let calls = 0;
  await assert.rejects(make((async () => { calls++; return body.response; }) as typeof fetch).discover(request), fixed('RESPONSE_LIMIT_EXCEEDED'));
  assert.equal(calls, 1);
  assert.deepEqual(body.state, { reads: 0, cancels: 1, releases: 0, acquired: 0 });
});

test('chunked bodies enforce the byte cap even with an understated Content-Length', async () => {
  for (const contentLength of [undefined, '1', 'invalid']) {
    const body = controlled({ contentLength, chunks: [new Uint8Array(MAX_BYTES), new Uint8Array(1)] });
    await assert.rejects(make((async () => body.response) as typeof fetch).discover(request), fixed('RESPONSE_LIMIT_EXCEEDED'));
    assert.deepEqual(body.state, { reads: 2, cancels: 1, releases: 1, acquired: 1 });
  }
});

test('a valid response exactly at the byte cap succeeds without fabrication', async () => {
  const prefix = '{"articles":[],"padding":"';
  const suffix = '"}';
  const payload = encode(prefix + 'x'.repeat(MAX_BYTES - encode(prefix + suffix).byteLength) + suffix);
  assert.equal(payload.byteLength, MAX_BYTES);
  const body = controlled({ contentLength: String(MAX_BYTES), chunks: [payload] });
  assert.deepEqual(await make((async () => body.response) as typeof fetch).discover(request), []);
  assert.deepEqual(body.state, { reads: 2, cancels: 0, releases: 1, acquired: 1 });
});

test('UTF-8 is decoded across chunk boundaries and actual article metadata is retained', async () => {
  const articles = [{ publisher: 'Fictional Café 🗞', url: 'https://fiction.example.test/item' }];
  const payload = encode(JSON.stringify({ articles }));
  const body = controlled({ chunks: Array.from(payload, byte => Uint8Array.of(byte)) });
  assert.deepEqual(await make((async () => body.response) as typeof fetch).discover(request), articles);
  assert.equal(body.state.cancels, 0);
  assert.equal(body.state.releases, 1);
});

test('invalid and truncated UTF-8 fail closed with fixed errors', async () => {
  for (const chunk of [Uint8Array.of(0xff), Uint8Array.of(0xe2, 0x82)]) {
    const body = controlled({ chunks: [encode('{"articles":[],"padding":"'), chunk] });
    await assert.rejects(make((async () => body.response) as typeof fetch).discover(request), fixed('MALFORMED_RESPONSE'));
    assert.equal(body.state.cancels, 1);
    assert.equal(body.state.releases, 1);
  }
});

test('malformed JSON, shapes, empty bodies and excess articles remain fixed failures', async () => {
  for (const payload of ['{', 'null', '[]', '{"articles":{}}', '{"articles":"BODY_PRIVATE"}']) {
    const body = controlled({ chunks: [encode(payload)] });
    await assert.rejects(make((async () => body.response) as typeof fetch).discover(request), fixed('MALFORMED_RESPONSE'));
    assert.equal(body.state.cancels, 1);
  }
  await assert.rejects(make((async () => new Response(null)) as typeof fetch).discover(request), fixed('MALFORMED_RESPONSE'));
  await assert.rejects(make((async () => json({ articles: [1, 2, 3, 4] })) as typeof fetch).discover(request), fixed('RESPONSE_LIMIT_EXCEEDED'));
});

test('body read and cancellation exceptions never disclose private messages or retry', async () => {
  for (const cancel of [() => Promise.reject(Error(privateMessage)), () => { throw Error(privateMessage); }]) {
    const body = controlled({ read: () => Promise.reject(Error(privateMessage)), cancel });
    let calls = 0;
    await assert.rejects(make((async () => { calls++; return body.response; }) as typeof fetch).discover(request), fixed('MALFORMED_RESPONSE'));
    assert.equal(calls, 1);
    assert.equal(body.state.cancels, 1);
    assert.equal(body.state.releases, 1);
  }
});

test('untrusted response accessors and error codes cannot disclose provider data', async () => {
  const unsafe = new ProviderError(privateMessage);
  const response = { get status() { throw unsafe; } } as unknown as Response;
  await assert.rejects(make((async () => response) as typeof fetch).discover(request), fixed('MALFORMED_RESPONSE'));
  const body = controlled({ read: async () => ({ get done() { throw unsafe; } }) as unknown as ReadableStreamReadResult<Uint8Array> });
  await assert.rejects(make((async () => body.response) as typeof fetch).discover(request), fixed('MALFORMED_RESPONSE'));
  assert.equal(body.state.cancels, 1);
});

test('terminal HTTP responses cancel unread bodies and preserve fixed error categories', async () => {
  for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED'], [400, 'HTTP_ERROR']] as const) {
    const body = controlled({ status, read: () => new Promise(() => {}), cancel: () => new Promise(() => {}) });
    let calls = 0;
    await assert.rejects(make((async () => { calls++; return body.response; }) as typeof fetch).discover(request), fixed(code));
    assert.equal(calls, 1);
    assert.deepEqual(body.state, { reads: 0, cancels: 1, releases: 0, acquired: 0 });
  }
});

test('retry responses are cancelled before bounded backoff and recover on attempt three', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bodies = [controlled({ status: 503 }), controlled({ status: 503 })];
  let calls = 0;
  const provider = make((async (_url, options) => {
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    const index = calls++;
    return bodies[index]?.response ?? json({ articles: [{ fictional: true }] });
  }) as typeof fetch);
  const result = provider.discover(request);
  await flush();
  assert.equal(calls, 1);
  assert.equal(bodies[0].state.cancels, 1);
  t.mock.timers.tick(99); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
  assert.equal(bodies[1].state.cancels, 1);
  t.mock.timers.tick(199); await flush(); assert.equal(calls, 2);
  t.mock.timers.tick(1);
  assert.deepEqual(await result, [{ fictional: true }]);
  assert.equal(calls, 3);
  for (const body of bodies) assert.equal(body.state.reads, 0);
});

test('upstream exhaustion cancels all three response bodies and returns no candidates', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bodies = Array.from({ length: 3 }, () => controlled({ status: 503 }));
  let calls = 0;
  const result = assert.rejects(make((async () => bodies[calls++].response) as typeof fetch).discover(request), fixed('UPSTREAM_UNAVAILABLE'));
  await flush(); t.mock.timers.tick(100); await flush(); t.mock.timers.tick(200);
  await result;
  assert.equal(calls, 3);
  for (const body of bodies) assert.deepEqual(body.state, { reads: 0, cancels: 1, releases: 0, acquired: 0 });
});

test('one attempt deadline covers both delayed fetch and a hung body before recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = pending<Response>();
  const body = controlled({ read: () => new Promise(() => {}), cancel: () => new Promise(() => {}) });
  const signals: AbortSignal[] = [];
  let calls = 0;
  const provider = make((async (_url, options) => { signals.push(options!.signal!); return ++calls === 1 ? first.promise : json({ articles: [] }); }) as typeof fetch);
  const result = provider.discover(request);
  t.mock.timers.tick(6000);
  first.resolve(body.response); await flush();
  assert.equal(body.state.reads, 1);
  t.mock.timers.tick(2000); await flush();
  assert.equal(signals[0].aborted, true);
  assert.equal(body.state.cancels, 1);
  t.mock.timers.tick(100);
  assert.deepEqual(await result, []);
  assert.equal(calls, 2);
});

test('timed out native streams are cancelled and their reader locks are released', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancels = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encode('{"articles":[')); },
    cancel() { cancels++; }
  }));
  let calls = 0;
  const provider = make((async () => ++calls === 1 ? response : json({ articles: [] })) as typeof fetch);
  const result = provider.discover(request);
  await flush();
  assert.equal(response.body!.locked, true);
  t.mock.timers.tick(8000); await flush();
  assert.equal(cancels, 1);
  assert.equal(response.body!.locked, false);
  t.mock.timers.tick(100);
  assert.deepEqual(await result, []);
  assert.equal(calls, 2);
});

test('noncooperative body reads and cancellation cannot exceed three timed attempts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bodies = Array.from({ length: 3 }, () => controlled({ read: () => new Promise(() => {}), cancel: () => new Promise(() => {}) }));
  const signals: AbortSignal[] = [];
  let calls = 0;
  const provider = make((async (_url, options) => { signals.push(options!.signal!); return bodies[calls++].response; }) as typeof fetch);
  const result = assert.rejects(provider.discover(request), fixed('NETWORK_OR_TIMEOUT'));
  await flush(); t.mock.timers.tick(8000); await flush();
  t.mock.timers.tick(100); await flush(); t.mock.timers.tick(8000); await flush();
  t.mock.timers.tick(200); await flush(); t.mock.timers.tick(8000);
  await result;
  assert.equal(calls, 3);
  assert.ok(signals.every(signal => signal.aborted));
  for (const body of bodies) { assert.equal(body.state.reads, 1); assert.equal(body.state.cancels, 1); }
});

test('noncooperative fetch is bounded and its late responses are cancelled unread', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const late = Array.from({ length: 3 }, () => pending<Response>());
  const bodies = Array.from({ length: 3 }, () => controlled());
  let calls = 0;
  const provider = make((async () => late[calls++].promise) as typeof fetch);
  const result = assert.rejects(provider.discover(request), fixed('NETWORK_OR_TIMEOUT'));
  t.mock.timers.tick(8000); await flush(); t.mock.timers.tick(100); await flush();
  t.mock.timers.tick(8000); await flush(); t.mock.timers.tick(200); await flush(); t.mock.timers.tick(8000);
  await result;
  assert.equal(calls, 3);
  late.forEach((item, index) => item.resolve(bodies[index].response));
  await flush();
  for (const body of bodies) assert.deepEqual(body.state, { reads: 0, cancels: 1, releases: 0, acquired: 0 });
});

test('transport rejection messages are sanitized and retry exhaustion is bounded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const provider = make((async () => { calls++; throw Error(privateMessage); }) as typeof fetch);
  const result = assert.rejects(provider.discover(request), fixed('NETWORK_OR_TIMEOUT'));
  await flush(); t.mock.timers.tick(100); await flush(); t.mock.timers.tick(200);
  await result;
  assert.equal(calls, 3);
});
