import type { State } from '../newsroom/model.ts';
import { permissions, roles, type Permission, type Principal, type Role, type TrustedSessionVerifier } from './types.ts';
import { opaque, SecurityError, sessionTimestamp, validateClaims } from './verifier.ts';
export { SecurityError, validateClaims } from './verifier.ts';

const reporter: readonly Permission[] = ['STORY_CREATE', 'STORY_EDIT', 'EDITION_ASSEMBLE'];
const editor: readonly Permission[] = [...reporter, 'STORY_REVIEW', 'DRAFT_REVIEW', 'EDITION_REVIEW', 'SCHEDULE_EXECUTE'];
export const permissionMatrix: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  REPORTER: Object.freeze([...reporter]),
  EDITOR: Object.freeze([...editor]),
  MANAGING_EDITOR: Object.freeze([...editor, 'STORY_APPROVE', 'DRAFT_READY', 'EDITION_READY', 'SCHEDULE_CONFIGURE'] as Permission[]),
  ADMINISTRATOR: Object.freeze(['IDENTITY_ADMIN', 'SCHEDULE_CONFIGURE', 'SCHEDULE_EXECUTE'] as Permission[]),
});

/** Current identities and registered sessions, rather than credential role claims, govern access. */
export function authorize(state: State, credential: unknown, verifier: TrustedSessionVerifier, permission: Permission | null, at: string): Principal {
  let claims;
  try { claims = verifier.verify(credential); }
  catch { throw new SecurityError('INVALID_CREDENTIAL'); }
  claims = validateClaims(claims, verifier, at);
  try {
    const identities = state.identities.filter(identity => identity.provider.issuer === claims.issuer && identity.provider.subject === claims.subject);
    if (identities.length !== 1) throw new SecurityError('INVALID_SESSION');
    const identity = identities[0];
    if (identity.status === 'DISABLED') throw new SecurityError('IDENTITY_DISABLED');
    if (identity.status !== 'ACTIVE' || !opaque(identity.id) || !Number.isSafeInteger(identity.revision) || identity.revision < 1
      || identity.credentialVersion !== claims.credentialVersion || !Array.isArray(identity.roles)
      || identity.roles.some(role => !roles.includes(role)) || new Set(identity.roles).size !== identity.roles.length) throw new SecurityError('INVALID_SESSION');
    if (identity.credentialsRotatedAt !== null && sessionTimestamp(claims.authenticatedAt) < sessionTimestamp(identity.credentialsRotatedAt)) throw new SecurityError('INVALID_SESSION');
    const sessions = state.sessions.filter(session => session.id === claims.sessionId);
    if (sessions.length !== 1) throw new SecurityError('INVALID_SESSION');
    const session = sessions[0];
    if (session.userId !== identity.id || !opaque(session.auditRef)
      || session.issuer !== claims.issuer || session.audience !== claims.audience || session.keyId !== claims.keyId
      || session.credentialVersion !== claims.credentialVersion || session.authenticatedAt !== claims.authenticatedAt
      || session.notBefore !== claims.notBefore || session.expiresAt !== claims.expiresAt) throw new SecurityError('INVALID_SESSION');
    if (session.revokedAt !== null) throw new SecurityError('SESSION_REVOKED');
    if (permission !== null && (!permissions.includes(permission) || !identity.roles.some(role => permissionMatrix[role].includes(permission)))) throw new SecurityError('PERMISSION_DENIED');
    return { identityId: identity.id, identityRevision: identity.revision, sessionRef: session.auditRef, sessionId: session.id };
  } catch (error) {
    const code = error instanceof SecurityError ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    if (typeof code === 'string' && ['INVALID_SESSION', 'SESSION_REVOKED', 'IDENTITY_DISABLED', 'PERMISSION_DENIED'].includes(code)) throw new SecurityError(code as 'INVALID_SESSION' | 'SESSION_REVOKED' | 'IDENTITY_DISABLED' | 'PERMISSION_DENIED');
    throw new SecurityError('INVALID_SESSION');
  }
}
