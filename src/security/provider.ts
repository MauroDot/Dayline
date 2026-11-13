import type { TrustedSessionVerifier } from './types.ts';
import { SecurityError, SyntheticSessionVerifier } from './verifier.ts';

const verifySynthetic = SyntheticSessionVerifier.prototype.verify;

/** Configuration supplied by trusted composition code, never by an HTTP request or token. */
export interface DevelopmentIdentityConfiguration {
  enabled: true;
  mode: 'development';
  provider: 'synthetic';
  verifier: SyntheticSessionVerifier;
}

/** Explicitly disabled seam for a future reviewed real-provider implementation. */
export function productionProviderVerifier(): never {
  throw new SecurityError('PERMISSION_DENIED');
}

/** The provider-independent result is verification-only; no signing or remote-key lookup API. */
export function configureIdentityVerifier(configuration: unknown = undefined): TrustedSessionVerifier {
  try {
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(configuration))
      || Reflect.ownKeys(configuration).length !== 4
      || Reflect.ownKeys(configuration).some(key => typeof key !== 'string' || !['enabled', 'mode', 'provider', 'verifier'].includes(key))
      || Object.values(Object.getOwnPropertyDescriptors(configuration)).some(value => !value.enumerable || !Object.hasOwn(value, 'value')))
      throw new Error();
    const value = configuration as DevelopmentIdentityConfiguration;
    if (value.enabled !== true || value.mode !== 'development' || value.provider !== 'synthetic'
      || process.env.NODE_ENV === 'production'
      || !(value.verifier instanceof SyntheticSessionVerifier)
      || Object.getPrototypeOf(value.verifier) !== SyntheticSessionVerifier.prototype
      || Reflect.ownKeys(value.verifier).sort().join(',') !== 'audience,issuer,maxSessionMs'
      || !Object.isFrozen(value.verifier)) throw new Error();
    const verifier = value.verifier;
    return Object.freeze({ issuer: verifier.issuer, audience: verifier.audience, maxSessionMs: verifier.maxSessionMs,
      verify(credential: unknown) {
        // Use the concrete implementation with its private key fields, never an injected own method.
        try { return verifySynthetic.call(verifier, credential); }
        catch { throw new SecurityError('INVALID_CREDENTIAL'); }
      },
    });
  } catch { throw new SecurityError('INVALID_CREDENTIAL'); }
}
