/** Internal authentication metadata. Credentials and verifier secrets never belong in State. */
export const roles = ['REPORTER','EDITOR','MANAGING_EDITOR','ADMINISTRATOR'] as const;
export type Role = typeof roles[number];
export const permissions = ['STORY_CREATE','STORY_EDIT','STORY_REVIEW','STORY_APPROVE','DRAFT_REVIEW','DRAFT_READY','EDITION_ASSEMBLE','EDITION_REVIEW','EDITION_READY','SCHEDULE_CONFIGURE','SCHEDULE_EXECUTE','IDENTITY_ADMIN','SOURCE_READ','SOURCE_REVIEW','SOURCE_RESOLVE','SOURCE_HOLD','SOURCE_RELEASE'] as const;
export type Permission = typeof permissions[number];
export interface IdentityRecord { id:string; status:'ACTIVE'|'DISABLED'; roles:Role[]; provider:{issuer:string;subject:string}; revision:number; credentialVersion:number; credentialsRotatedAt:string|null; createdAt:string; updatedAt:string }
export interface VerifiedSessionClaims { issuer:string; audience:string; subject:string; sessionId:string; keyId:string; credentialVersion:number; authenticatedAt:string; notBefore:string; expiresAt:string }
export interface TrustedSessionVerifier { readonly issuer:string; readonly audience:string; readonly maxSessionMs:number; verify(credential:unknown):VerifiedSessionClaims }
export interface SessionRecord { id:string; auditRef:string; userId:string; issuer:string; audience:string; keyId:string; credentialVersion:number; authenticatedAt:string; notBefore:string; expiresAt:string; revokedAt:string|null }
export type SecurityCode = 'SUCCESS'|'INVALID_CREDENTIAL'|'INVALID_SESSION'|'SESSION_EXPIRED'|'SESSION_FUTURE'|'SESSION_REVOKED'|'IDENTITY_DISABLED'|'PERMISSION_DENIED'|'STALE_TARGET'|'DOMAIN_REJECTED'|'STORAGE_UNAVAILABLE';
export type SecurityCategory = 'AUTH_SUCCESS'|'AUTH_FAILURE'|'AUTHZ_DENIED'|'ROLE_CHANGED'|'SESSION_REVOKED'|'IDENTITY_STATUS_CHANGED'|'CREDENTIALS_ROTATED'|'PROTECTED_ACTION'|'IDENTITY_CREATED';
export interface SecurityEvent { id:string; at:string; category:SecurityCategory; code:SecurityCode; userRef:string|null; sessionRef:string|null; subjectRef:string|null; permission:Permission|null }
export type ResourceKind = 'STORY'|'DRAFT'|'EDITION'|'SCHEDULE'|'RUN'|'IDENTITY'|'SESSION'|'SOURCE';
export interface AuthenticatedAction { id:string; actorId:string; identityRevision:number; sessionRef:string; permission:Permission; resourceKind:ResourceKind; resourceId:string; resourceVersion:number|null; at:string }
export interface Principal { identityId:string; identityRevision:number; sessionRef:string; sessionId:string }
