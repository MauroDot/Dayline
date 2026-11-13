import { validNwsUserAgent } from '../official-data.ts';

export type PublicMode = 'development' | 'staging' | 'production';
export interface PublicConfiguration {
  readonly mode: PublicMode;
  readonly port: number;
  readonly host: '127.0.0.1' | '::1' | '0.0.0.0';
  readonly nwsUserAgent: string | undefined;
  readonly upstreamTimeoutMs: number;
  readonly publicBaseUrl: string | null;
  readonly requestTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly maxConnections: number;
  readonly maxConcurrentRequests: number;
}
export type ConfigurationCode = 'INVALID_ENVIRONMENT' | 'INVALID_PORT' | 'INVALID_BIND_ADDRESS'
  | 'INVALID_NWS_IDENTIFICATION' | 'INVALID_PUBLIC_BASE_URL' | 'DEVELOPMENT_CONFIGURATION_FORBIDDEN'
  | 'INVALID_TIMEOUT' | 'INVALID_CAPACITY';
export class PublicConfigurationError extends Error {
  readonly code: ConfigurationCode;
  constructor(code: ConfigurationCode) { super(code); this.name = 'PublicConfigurationError'; this.code = code; }
}
function integer(value: string | undefined, fallback: number, min: number, max: number, code: ConfigurationCode): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new PublicConfigurationError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new PublicConfigurationError(code);
  return parsed;
}
/** Trusted process environment only; errors contain fixed codes, never supplied values. */
export function parsePublicConfiguration(environment: NodeJS.ProcessEnv = process.env): PublicConfiguration {
  const mode = environment.NODE_ENV ?? 'development';
  if (!['development', 'staging', 'production'].includes(mode)) throw new PublicConfigurationError('INVALID_ENVIRONMENT');
  const host = environment.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host) || (mode === 'development' && host === '0.0.0.0')) throw new PublicConfigurationError('INVALID_BIND_ADDRESS');
  if (mode !== 'development' && Object.entries(environment).some(([key, value]) => value !== undefined && value !== ''
    && (/^DAYLINE_(?:DEV|INTERNAL|EDITORIAL|SYNTHETIC|TEST|AUTH)(?:_|$)/.test(key)
      || ['SYNTHETIC_PROVIDER', 'TEST_BEARER_TOKEN', 'IDENTITY_PROVIDER'].includes(key)))) {
    throw new PublicConfigurationError('DEVELOPMENT_CONFIGURATION_FORBIDDEN');
  }
  const nwsUserAgent = environment.NWS_USER_AGENT?.trim();
  if ((nwsUserAgent !== undefined || mode !== 'development')
    && (!nwsUserAgent || nwsUserAgent.length > 256 || !validNwsUserAgent(nwsUserAgent)
      || !/^[A-Za-z][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)?(?:\s|\()/.test(nwsUserAgent))) {
    throw new PublicConfigurationError('INVALID_NWS_IDENTIFICATION');
  }
  let publicBaseUrl: string | null = null;
  if (environment.PUBLIC_BASE_URL !== undefined) {
    try {
      const url = new URL(environment.PUBLIC_BASE_URL);
      if (!['http:', 'https:'].includes(url.protocol) || (mode !== 'development' && url.protocol !== 'https:')
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || !url.hostname || environment.PUBLIC_BASE_URL.trim() !== environment.PUBLIC_BASE_URL) throw new Error();
      publicBaseUrl = url.origin;
    } catch { throw new PublicConfigurationError('INVALID_PUBLIC_BASE_URL'); }
  }
  const config: PublicConfiguration = {
    mode: mode as PublicMode, host: host as PublicConfiguration['host'],
    port: integer(environment.PORT, 3000, 1, 65535, 'INVALID_PORT'), nwsUserAgent,
    upstreamTimeoutMs: integer(environment.UPSTREAM_TIMEOUT_MS, 8000, 100, 10000, 'INVALID_TIMEOUT'),
    publicBaseUrl,
    requestTimeoutMs: integer(environment.REQUEST_TIMEOUT_MS, 15000, 1000, 60000, 'INVALID_TIMEOUT'),
    headersTimeoutMs: integer(environment.HEADERS_TIMEOUT_MS, 10000, 1000, 30000, 'INVALID_TIMEOUT'),
    shutdownTimeoutMs: integer(environment.SHUTDOWN_TIMEOUT_MS, 5000, 100, 30000, 'INVALID_TIMEOUT'),
    maxConnections: integer(environment.MAX_CONNECTIONS, 128, 1, 1024, 'INVALID_CAPACITY'),
    maxConcurrentRequests: integer(environment.MAX_CONCURRENT_REQUESTS, 32, 1, 128, 'INVALID_CAPACITY'),
  };
  if (config.headersTimeoutMs > config.requestTimeoutMs) throw new PublicConfigurationError('INVALID_TIMEOUT');
  if (config.maxConcurrentRequests > config.maxConnections) throw new PublicConfigurationError('INVALID_CAPACITY');
  return Object.freeze(config);
}
