import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { seedSecurityFixture, securityAt } from '../fixtures/security-fiction.ts';
import { JsonRepository } from '../src/newsroom/store.ts';
import { AccessControl } from '../src/security/service.ts';
import { AssignedResourcePolicy } from '../src/security/resources.ts';
import { startInternalEditorialHTTP, validateInternalRequest, type InternalEditorialHTTP, type InternalEditorialHTTPOptions } from '../src/security/http.ts';

type Fixture = Awaited<ReturnType<typeof seedSecurityFixture>>;
async function fixture(run: (server: InternalEditorialHTTP, fixture: Fixture, repository: JsonRepository, clock: { now: string }, options: InternalEditorialHTTPOptions) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dayline-http-security-'));
  let server: InternalEditorialHTTP | null = null;
  try {
    const repository = new JsonRepository(join(directory, 'fictional.json'));
    const seeded = await seedSecurityFixture(repository), clock = { now: securityAt };
    const access = new AccessControl(repository, { verifier: seeded.verifier, clock: () => clock.now });
    const options: InternalEditorialHTTPOptions = { enabled: true, mode: 'development', repository, access, policy: new AssignedResourcePolicy([]) };
    server = await startInternalEditorialHTTP(options); assert.ok(server);
    await run(server, seeded, repository, clock, options);
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
}
function req(server: InternalEditorialHTTP, path: string, token?: string, options: { method?: string; headers?: OutgoingHttpHeaders; body?: string } = {}) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; text: string; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: OutgoingHttpHeaders = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(options.body) } : {}), ...options.headers };
    const request = httpRequest(server.origin + path, { method: options.method ?? 'GET', headers, agent: false }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode!, headers: response.headers, text, body: text ? JSON.parse(text) : {} }); });
    }); request.on('error', reject); request.end(options.body);
  });
}
function raw(server: InternalEditorialHTTP, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(server.origin), socket = connect(Number(url.port), '127.0.0.1'); let value = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('test client deadline')));
    socket.on('connect', () => socket.write(payload)); socket.on('data', chunk => { value += chunk.toString(); }); socket.on('end', () => resolve(value)); socket.on('error', reject);
  });
}

test('internal HTTP is disabled by default without allocating or requiring dependencies', async () => {
  assert.equal(await startInternalEditorialHTTP({} as InternalEditorialHTTPOptions), null);
  assert.equal(await startInternalEditorialHTTP({ enabled: false } as InternalEditorialHTTPOptions), null);
});
test('enabled internal HTTP rejects nondevelopment mode and production runtime', async () => {
  await assert.rejects(startInternalEditorialHTTP({ enabled: true, mode: 'production' } as InternalEditorialHTTPOptions), /INTERNAL_LISTENER_DISABLED/);
  await assert.rejects(startInternalEditorialHTTP({ enabled: true, mode: 'test' } as InternalEditorialHTTPOptions), /INTERNAL_LISTENER_DISABLED/);
  const prior = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try { await assert.rejects(startInternalEditorialHTTP({ enabled: true, mode: 'development' } as InternalEditorialHTTPOptions), /INTERNAL_LISTENER_DISABLED/); }
  finally { if (prior === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prior; }
});
test('internal HTTP rejects missing policy and invalid ports before listening', async () => {
  for (const port of [-1, 65536, 1.5]) await assert.rejects(startInternalEditorialHTTP({ enabled: true, mode: 'development', port } as InternalEditorialHTTPOptions), /INVALID_INTERNAL_CONFIGURATION/);
});
test('peer guard rejects nonloopback addresses even with valid Host', () => {
  for (const address of ['10.0.0.1', '192.168.1.2', '::1', undefined]) {
    assert.throws(() => validateInternalRequest({ socket: { remoteAddress: address }, headers: { host: '127.0.0.1:4000' }, rawHeaders: ['Host', '127.0.0.1:4000'], url: '/internal/principal' } as Pick<IncomingMessage, 'socket' | 'headers' | 'rawHeaders' | 'url'>, 4000), /FORBIDDEN/);
  }
});
test('principal endpoint uses header credentials and returns only safe current identity permissions', async () => fixture(async (server, f) => {
  assert.equal(new URL(server.origin).hostname, '127.0.0.1');
  const r = await req(server, '/internal/principal', f.accounts.reporter.credential);
  assert.equal(r.status, 200); assert.equal(r.body.id, f.accounts.reporter.identity.id); assert.deepEqual(r.body.roles, ['REPORTER']);
  assert.deepEqual(Object.keys(r.body).sort(), ['id', 'permissions', 'roles']);
  assert.equal(r.headers['cache-control'], 'no-store, max-age=0'); assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(String(r.headers['x-request-id']), /^[a-f0-9-]{36}$/); assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.equal(r.text.includes(f.accounts.reporter.credential), false); assert.equal(r.text.includes(f.accounts.reporter.claims.sessionId), false);
}));
test('missing malformed unsigned and tampered credentials fail generically without reflection', async () => fixture(async (server, f) => {
  for (const token of [undefined, 'plain-password', 'abc.def.', f.accounts.reporter.credential.slice(0, -4) + 'zzzz']) {
    const r = await req(server, '/internal/principal', token); assert.equal(r.status, 401); assert.equal(r.body.error, 'UNAUTHENTICATED');
    if (token) assert.equal(r.text.includes(token), false);
  }
}));
test('wrong issuer audience and unregistered session credentials fail closed across HTTP', async () => fixture(async (server, f) => {
  for (const patch of [{ issuer: 'urn:wrong-provider' }, { audience: 'wrong-audience' }, { sessionId: randomUUID() }]) {
    const token = f.verifier.issue({ ...f.accounts.reporter.claims, ...patch });
    const r = await req(server, '/internal/principal', token); assert.equal(r.status, 401); assert.equal(r.text.includes(token), false);
  }
}));
test('HTTP rejects future expired disabled and rotated identities', async () => fixture(async (server, f, repository, clock) => {
  clock.now = '2026-06-01T11:59:59.000Z'; assert.equal((await req(server, '/internal/principal', f.accounts.reporter.credential)).status, 401);
  clock.now = f.accounts.reporter.claims.expiresAt; assert.equal((await req(server, '/internal/principal', f.accounts.reporter.credential)).status, 401);
  clock.now = securityAt;
  await repository.transact(state => { state.identities.find(row => row.id === f.accounts.reporter.identity.id)!.status = 'DISABLED'; });
  assert.equal((await req(server, '/internal/principal', f.accounts.reporter.credential)).status, 401);
  await repository.transact(state => { const identity = state.identities.find(row => row.id === f.accounts.reporter.identity.id)!; identity.status = 'ACTIVE'; identity.credentialVersion++; });
  assert.equal((await req(server, '/internal/principal', f.accounts.reporter.credential)).status, 401);
}));
test('Host Origin CORS cookie and forwarded-header restrictions reject browser and proxy ambiguity', async () => fixture(async (server, f) => {
  const token = f.accounts.reporter.credential;
  for (const headers of [{ Host: 'evil.test' }, { Host: 'localhost:' + new URL(server.origin).port }, { Origin: 'https://evil.test' }, { Origin: 'null' }, { Cookie: 'session=fictional-secret' }, { Forwarded: 'host=evil.test' }, { 'X-Forwarded-For': '127.0.0.1' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Access-Control-Request-Method': 'POST' }]) {
    const r = await req(server, '/internal/principal', token, { headers }); assert.equal(r.status, 403); assert.equal(r.headers['access-control-allow-origin'], undefined); assert.equal(r.text.includes('fictional-secret'), false);
  }
  assert.equal((await req(server, '/internal/principal', token, { headers: { Origin: server.origin, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
}));
test('query credentials and unknown login administration publishing routes are absent', async () => fixture(async (server, f) => {
  const token = f.accounts.admin.credential;
  const queried = await req(server, '/internal/principal?token=' + token, token); assert.equal(queried.status, 400); assert.equal(queried.text.includes(token), false);
  for (const path of ['/internal/login', '/internal/token', '/internal/session/register', '/internal/admin', '/internal/publish', '/api/editorial', '/auth']) assert.equal((await req(server, path, token)).status, 404);
}));
test('unsupported methods and content types fail before mutation', async () => fixture(async (server, f) => {
  const token = f.accounts.reporter.credential;
  for (const method of ['PUT', 'POST', 'OPTIONS', 'DELETE']) assert.equal((await req(server, '/internal/principal', token, { method })).status, 405);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/json; charset=utf-8']) assert.equal((await req(server, '/internal/session/revoke', token, { method: 'POST', headers: { 'Content-Type': type }, body: '{}' })).status, 415);
}));
test('malformed oversized prototype-bearing and authority-bearing JSON is safely rejected', async () => fixture(async (server, f) => {
  const token = f.accounts.reporter.credential;
  for (const body of ['{"', '{"__proto__":{"roles":["ADMINISTRATOR"]}}', '{"roles":["ADMINISTRATOR"]}', '[1]', 'null']) {
    const r = await req(server, '/internal/session/revoke', token, { method: 'POST', body }); assert.equal(r.status, 400); assert.equal(r.body.error, 'INVALID_REQUEST');
  }
  assert.equal((await req(server, '/internal/session/revoke', token, { method: 'POST', body: ' '.repeat(16385) })).status, 413);
  assert.equal((await req(server, '/internal/principal', token)).status, 200);
}));
test('self-revocation persists and replay cannot use header credentials again', async () => fixture(async (server, f, repository) => {
  const token = f.accounts.reporter.credential;
  const r = await req(server, '/internal/session/revoke', token, { method: 'POST', body: '{}' }); assert.equal(r.status, 200); assert.deepEqual(r.body, { revoked: true });
  assert.equal((await req(server, '/internal/principal', token)).status, 401);
  assert.equal((await repository.read()).sessions.find(row => row.id === f.accounts.reporter.claims.sessionId)!.revokedAt, securityAt);
}));
test('reporter cannot inspect scheduler and forged object identifiers cannot grant authority', async () => fixture(async (server, f) => {
  assert.equal((await req(server, '/internal/schedules', f.accounts.reporter.credential)).status, 403);
  const r = await req(server, '/internal/stories/unknown-story/approve', f.accounts.admin.credential, { method: 'POST', body: '{"version":1}' }); assert.equal(r.status, 403);
  assert.equal((await req(server, '/internal/stories/unknown-story/approve', f.accounts.managing.credential, { method: 'POST', body: '{"version":1}' })).status, 403);
}));
test('duplicate authorization and over-limit raw headers cannot be silently collapsed', async () => fixture(async (server, f) => {
  const host = new URL(server.origin).host;
  const duplicate = await raw(server, `GET /internal/principal HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${f.accounts.reporter.credential}\r\nAuthorization: Bearer ${f.accounts.admin.credential}\r\n\r\n`);
  assert.match(duplicate, /HTTP\/1.1 400/);
  const many = await raw(server, `GET /internal/principal HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${f.accounts.reporter.credential}\r\n${Array.from({ length: 49 }, (_, i) => `X-Fiction-${i}: value\r\n`).join('')}Cookie: leaked-credential\r\n\r\n`);
  // Node may reject over-limit raw headers before the application guard runs.
  assert.match(many, /HTTP\/1.1 (400|431)/); assert.equal(many.includes('leaked-credential'), false);
}));
test('partial request bodies hit the one-second receive deadline without revoking sessions', async () => fixture(async (server, f) => {
  const host = new URL(server.origin).host;
  const reply = await raw(server, `POST /internal/session/revoke HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${f.accounts.reporter.credential}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{`);
  assert.match(reply, /HTTP\/1.1 408/); assert.equal((await req(server, '/internal/principal', f.accounts.reporter.credential)).status, 200);
}));
test('correlation IDs are fresh and caller values do not reach response metadata', async () => fixture(async (server, f) => {
  const a = await req(server, '/internal/principal', f.accounts.reporter.credential, { headers: { 'X-Request-ID': 'fictional-credential-value' } });
  const b = await req(server, '/internal/principal', f.accounts.reporter.credential);
  assert.notEqual(a.headers['x-request-id'], b.headers['x-request-id']); assert.equal(JSON.stringify(a).includes('fictional-credential-value'), false);
}));

test('listener rejects a mismatched access-control repository before binding any endpoint', async () => fixture(async (_server, f, repository, _clock, options) => {
  const otherRepository = new JsonRepository(repository.file + '.different');
  await assert.rejects(startInternalEditorialHTTP({ ...options, repository: otherRepository }), /INVALID_INTERNAL_CONFIGURATION/);
  const otherAccess = new AccessControl(otherRepository, { verifier: f.verifier, clock: () => securityAt });
  await assert.rejects(startInternalEditorialHTTP({ ...options, access: otherAccess }), /INVALID_INTERNAL_CONFIGURATION/);
}));
