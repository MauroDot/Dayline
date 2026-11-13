import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicConfiguration, PublicConfigurationError } from '../src/public/config.ts';

const contact = 'Dayline/0.1 (synthetic configuration test; fixture@dayline.test)';
const staged = { NODE_ENV: 'staging', NWS_USER_AGENT: contact };
function denied(environment: NodeJS.ProcessEnv, code: string): void {
  assert.throws(() => parsePublicConfiguration(environment), error => error instanceof PublicConfigurationError && error.code === code && error.message === code);
}
test('public configuration defaults to development and loopback without activating a provider', () => {
  const value = parsePublicConfiguration({});
  assert.equal(value.mode, 'development'); assert.equal(value.host, '127.0.0.1'); assert.equal(value.port, 3000);
  assert.equal(value.nwsUserAgent, undefined); assert.equal(value.publicBaseUrl, null); assert.equal(Object.isFrozen(value), true);
});
test('staging and production are explicit and preserve the platform-provided port', () => {
  for (const mode of ['staging', 'production']) {
    const value = parsePublicConfiguration({ ...staged, NODE_ENV: mode, PORT: '8080', HOST: '0.0.0.0', PUBLIC_BASE_URL: 'https://reader.dayline.test' });
    assert.equal(value.mode, mode); assert.equal(value.port, 8080); assert.equal(value.host, '0.0.0.0'); assert.equal(value.publicBaseUrl, 'https://reader.dayline.test');
  }
});
test('unknown or blank public environments cannot silently become development', () => {
  for (const mode of ['', 'prod', 'test', 'PRODUCTION', ' production', 'development\n']) denied({ NODE_ENV: mode }, 'INVALID_ENVIRONMENT');
});
test('port validation rejects coercion overflow and unintended ephemeral ports', () => {
  for (const port of ['', '0', '65536', '-1', '3.5', '3e3', '03000', ' 3000', '3000junk', 'Infinity']) denied({ PORT: port }, 'INVALID_PORT');
  assert.equal(parsePublicConfiguration({ PORT: '65535' }).port, 65535);
});
test('public bind validation keeps developer startup on loopback unless deployment explicitly binds all interfaces', () => {
  for (const host of ['localhost', 'example.test', '192.168.1.2', '::', '', '127.0.0.1:3000', ' 127.0.0.1']) denied({ ...staged, HOST: host }, 'INVALID_BIND_ADDRESS');
  denied({ HOST: '0.0.0.0' }, 'INVALID_BIND_ADDRESS');
  assert.equal(parsePublicConfiguration({ HOST: '::1' }).host, '::1');
  assert.equal(parsePublicConfiguration(staged).host, '127.0.0.1');
});
test('staging and production require identifying NWS configuration without reflecting its value', () => {
  for (const userAgent of [undefined, '', 'fixture@dayline.test', 'Dayline/0.1', 'Dayline/0.1 (private@example.com)', 'Dayline/0.1 (private@dayline.test)\r\nSECRET', 'Dayline/0.1 (' + 'x'.repeat(260) + '@dayline.test)']) {
    denied({ NODE_ENV: 'production', NWS_USER_AGENT: userAgent }, 'INVALID_NWS_IDENTIFICATION');
  }
  assert.equal(parsePublicConfiguration(staged).nwsUserAgent, contact);
});
test('development tolerates absent weather configuration but rejects explicitly invalid configuration', () => {
  assert.equal(parsePublicConfiguration({}).nwsUserAgent, undefined);
  denied({ NWS_USER_AGENT: 'private@example.com' }, 'INVALID_NWS_IDENTIFICATION');
});
test('nondevelopment processes reject fixture synthetic identity and private listener configuration', () => {
  for (const key of ['DAYLINE_DEV_EDITION', 'DAYLINE_INTERNAL_HTTP', 'DAYLINE_EDITORIAL_HTTP', 'DAYLINE_SYNTHETIC_PROVIDER', 'DAYLINE_TEST_TOKEN', 'DAYLINE_AUTH_PROVIDER', 'SYNTHETIC_PROVIDER', 'TEST_BEARER_TOKEN', 'IDENTITY_PROVIDER']) {
    denied({ ...staged, [key]: 'private-token-never-reflected' }, 'DEVELOPMENT_CONFIGURATION_FORBIDDEN');
  }
  assert.equal(parsePublicConfiguration({ DAYLINE_DEV_EDITION: 'fictional' }).mode, 'development');
});
test('base URL is an explicit origin and cannot contain credentials paths query fragments or unsafe deployment schemes', () => {
  for (const url of ['', 'http://reader.dayline.test', 'ftp://reader.dayline.test', 'https://private:secret@reader.dayline.test', 'https://reader.dayline.test/internal', 'https://reader.dayline.test?token=secret', 'https://reader.dayline.test/#secret', ' https://reader.dayline.test']) {
    denied({ ...staged, PUBLIC_BASE_URL: url }, 'INVALID_PUBLIC_BASE_URL');
  }
  assert.equal(parsePublicConfiguration({ PUBLIC_BASE_URL: 'http://127.0.0.1:3000/' }).publicBaseUrl, 'http://127.0.0.1:3000');
});
test('upstream request header and shutdown deadlines have finite explicit bounds', () => {
  for (const key of ['UPSTREAM_TIMEOUT_MS', 'REQUEST_TIMEOUT_MS', 'HEADERS_TIMEOUT_MS', 'SHUTDOWN_TIMEOUT_MS']) {
    for (const value of ['0', '-1', 'Infinity', '1e3', '9999999999']) denied({ ...staged, [key]: value }, 'INVALID_TIMEOUT');
  }
  denied({ ...staged, REQUEST_TIMEOUT_MS: '1000', HEADERS_TIMEOUT_MS: '2000' }, 'INVALID_TIMEOUT');
  assert.equal(parsePublicConfiguration({ ...staged, UPSTREAM_TIMEOUT_MS: '100' }).upstreamTimeoutMs, 100);
});
test('capacity limits reject unbounded settings and concurrency beyond available connections', () => {
  for (const key of ['MAX_CONNECTIONS', 'MAX_CONCURRENT_REQUESTS']) for (const value of ['0', '-1', '9999', 'NaN']) denied({ ...staged, [key]: value }, 'INVALID_CAPACITY');
  denied({ ...staged, MAX_CONNECTIONS: '1', MAX_CONCURRENT_REQUESTS: '2' }, 'INVALID_CAPACITY');
  const value = parsePublicConfiguration({ ...staged, MAX_CONNECTIONS: '1', MAX_CONCURRENT_REQUESTS: '1' });
  assert.equal(value.maxConnections, 1); assert.equal(value.maxConcurrentRequests, 1);
});
