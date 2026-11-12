import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SecurityCode, TrustedSessionVerifier, VerifiedSessionClaims } from './types.ts';

const codes: readonly SecurityCode[] = ['SUCCESS', 'INVALID_CREDENTIAL', 'INVALID_SESSION', 'SESSION_EXPIRED', 'SESSION_FUTURE',
  'SESSION_REVOKED', 'IDENTITY_DISABLED', 'PERMISSION_DENIED', 'STALE_TARGET', 'DOMAIN_REJECTED', 'STORAGE_UNAVAILABLE'];
export class SecurityError extends Error {
  readonly code: SecurityCode;
  constructor(code: SecurityCode) {
    const safe = typeof code === 'string' && codes.includes(code) ? code : 'INVALID_CREDENTIAL';
    super(safe); this.name = 'SecurityError'; this.code = safe;
  }
}

const claimKeys = ['issuer', 'audience', 'subject', 'sessionId', 'keyId', 'credentialVersion', 'authenticatedAt', 'notBefore', 'expiresAt'];
export function opaque(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value);
}
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === keys.length
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => descriptor.enumerable && 'value' in descriptor);
}
export function sessionTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new SecurityError('INVALID_SESSION');
  const parsed = Date.parse(value);
  const expected = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== expected) throw new SecurityError('INVALID_SESSION');
  return parsed;
}
function claimsShape(value: unknown): value is VerifiedSessionClaims {
  if (!record(value, claimKeys) || typeof value.issuer !== 'string' || !value.issuer.trim() || value.issuer.length > 256
    || typeof value.audience !== 'string' || !value.audience.trim() || value.audience.length > 128
    || !opaque(value.subject) || !opaque(value.sessionId)
    || typeof value.keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.keyId)
    || !Number.isSafeInteger(value.credentialVersion) || (value.credentialVersion as number) < 1) return false;
  sessionTimestamp(value.authenticatedAt); sessionTimestamp(value.notBefore); sessionTimestamp(value.expiresAt);
  return true;
}
function decode(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new SecurityError('INVALID_CREDENTIAL');
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) throw new SecurityError('INVALID_CREDENTIAL');
  return decoded;
}
function json(segment: string): unknown {
  const bytes = decode(segment), text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new SecurityError('INVALID_CREDENTIAL');
  const value: unknown = JSON.parse(text);
  // Synthetic credentials have one unambiguous canonical JSON representation;
  // duplicate keys, lossy UTF-8 and alternate numeric encodings are rejected.
  if (JSON.stringify(value) !== text) throw new SecurityError('INVALID_CREDENTIAL');
  return value;
}

/** Local synthetic verifier only. It has no environment, persistence or provider adapter. */
export class SyntheticSessionVerifier implements TrustedSessionVerifier {
  readonly issuer = 'urn:dayline:synthetic';
  readonly audience = 'dayline-editorial-fixture';
  readonly maxSessionMs: number;
  readonly #key: Buffer;
  readonly #keyId: string;
  constructor(options: { key?: Uint8Array; keyId?: string; maxSessionMs?: number } = {}) {
    try {
      if (!options || typeof options !== 'object' || Array.isArray(options)
        || Reflect.ownKeys(options).some(key => typeof key !== 'string' || !['key', 'keyId', 'maxSessionMs'].includes(key))
        || Object.values(Object.getOwnPropertyDescriptors(options)).some(descriptor => !('value' in descriptor))) throw new Error();
      const key = options.key ?? randomBytes(32), keyId = options.keyId ?? 'synthetic-local-v1', maximum = options.maxSessionMs ?? 900_000;
      if (!(key instanceof Uint8Array) || key.byteLength !== 32 || typeof keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(keyId)
        || !Number.isSafeInteger(maximum) || maximum < 1000 || maximum > 3_600_000) throw new Error();
      this.#key = Buffer.from(key); this.#keyId = keyId; this.maxSessionMs = maximum;
      Object.freeze(this);
    } catch { throw new SecurityError('INVALID_CREDENTIAL'); }
  }

  /** Fixture composition only; wrong issuer/audience can be signed to test denial. */
  issue(claims: VerifiedSessionClaims): string {
    try {
      if (!claimsShape(claims)) throw new Error();
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: this.#keyId })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signature = createHmac('sha256', this.#key).update(`${header}.${payload}`).digest('base64url');
      return `${header}.${payload}.${signature}`;
    } catch { throw new SecurityError('INVALID_CREDENTIAL'); }
  }

  verify(credential: unknown): VerifiedSessionClaims {
    try {
      if (typeof credential !== 'string' || credential.length > 8192) throw new Error();
      const segments = credential.split('.'); if (segments.length !== 3) throw new Error();
      const [headerText, payloadText, signatureText] = segments;
      const signature = decode(signatureText);
      const expected = createHmac('sha256', this.#key).update(`${headerText}.${payloadText}`).digest();
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error();
      const header: unknown = json(headerText);
      if (!record(header, ['alg', 'typ', 'kid']) || header.alg !== 'HS256' || header.typ !== 'JWT' || header.kid !== this.#keyId) throw new Error();
      const claims: unknown = json(payloadText);
      if (!claimsShape(claims) || claims.issuer !== this.issuer || claims.audience !== this.audience || claims.keyId !== this.#keyId) throw new Error();
      return { ...claims };
    } catch { throw new SecurityError('INVALID_CREDENTIAL'); }
  }
}

/** Pure registration/authorization check; this function creates no persisted session. */
export function validateClaims(claims: VerifiedSessionClaims, verifier: TrustedSessionVerifier, at: string): VerifiedSessionClaims {
  try {
    if (!claimsShape(claims) || claims.issuer !== verifier.issuer || claims.audience !== verifier.audience
      || !Number.isSafeInteger(verifier.maxSessionMs) || verifier.maxSessionMs < 1000 || verifier.maxSessionMs > 3_600_000) throw new SecurityError('INVALID_SESSION');
    const now = sessionTimestamp(at), authenticated = sessionTimestamp(claims.authenticatedAt), notBefore = sessionTimestamp(claims.notBefore), expires = sessionTimestamp(claims.expiresAt);
    if (authenticated > notBefore || notBefore >= expires || expires - authenticated > verifier.maxSessionMs) throw new SecurityError('INVALID_SESSION');
    if (authenticated > now || notBefore > now) throw new SecurityError('SESSION_FUTURE');
    if (now >= expires) throw new SecurityError('SESSION_EXPIRED');
    return { ...claims };
  } catch (error) {
    const code = error instanceof SecurityError ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    if (typeof code === 'string' && ['INVALID_SESSION', 'SESSION_FUTURE', 'SESSION_EXPIRED'].includes(code)) throw new SecurityError(code as SecurityCode);
    throw new SecurityError('INVALID_SESSION');
  }
}
