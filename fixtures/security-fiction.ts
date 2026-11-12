/** Synthetic local identities only. This public fixture key is never a production credential. */
import { randomUUID } from 'node:crypto';
import type { JsonRepository } from '../src/newsroom/store.ts';
import { AccessControl } from '../src/security/service.ts';
import { SyntheticSessionVerifier } from '../src/security/verifier.ts';
import type { IdentityRecord, Role, VerifiedSessionClaims } from '../src/security/types.ts';

export const securityAt = '2026-06-01T12:00:00.000Z';
export interface FictionalSecurityAccount { identity: IdentityRecord; claims: VerifiedSessionClaims; credential: string }

export async function seedSecurityFixture(repository: JsonRepository, at = securityAt) {
  const verifier = new SyntheticSessionVerifier({ key: Buffer.alloc(32, 7), keyId: 'fixture-key' });
  function account(role: Role): FictionalSecurityAccount {
    const identity: IdentityRecord = { id: randomUUID(), status: 'ACTIVE', roles: [role],
      provider: { issuer: verifier.issuer, subject: randomUUID() }, revision: 1, credentialVersion: 1,
      credentialsRotatedAt: null, createdAt: at, updatedAt: at };
    const claims: VerifiedSessionClaims = { issuer: verifier.issuer, audience: verifier.audience,
      subject: identity.provider.subject, sessionId: randomUUID(), keyId: 'fixture-key', credentialVersion: 1,
      authenticatedAt: at, notBefore: at, expiresAt: new Date(Date.parse(at) + verifier.maxSessionMs).toISOString() };
    return { identity, claims, credential: verifier.issue(claims) };
  }
  const accounts = { reporter: account('REPORTER'), editor: account('EDITOR'), managing: account('MANAGING_EDITOR'), admin: account('ADMINISTRATOR') };
  await repository.transact(state => { state.identities.push(...Object.values(accounts).map(account => structuredClone(account.identity))); });
  const access = new AccessControl(repository, { verifier, clock: () => at });
  for (const account of Object.values(accounts)) await access.registerSession(account.credential);
  return { verifier, accounts, access };
}
