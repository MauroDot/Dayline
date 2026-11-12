# Dayline — Internal editorial access-control design

DL-005A is an isolated authentication/authorization foundation for synthetic development identities. It adds no real identity provider, public login/admin route, production account, provider configuration or publication permission. Existing homepage, official-data and fictional reader routes retain their behavior. The owner-confirmed historical Foundation 001 development acceptance remains intact; this work does not establish production readiness.

## Trust and stored identity metadata

`TrustedSessionVerifier` is an injected synchronous trust boundary with a fixed issuer, audience and maximum session lifetime. It must validate credential authenticity before returning typed claims. The supplied `SyntheticSessionVerifier` is only a local fixture implementation: strict HS256/HMAC-SHA256 signed credentials, a private 32-byte key held in memory, pinned header/key identity and bounded input. It has no environment/provider adapter or persisted secret. The synthetic compact format is not a production JWT/OIDC implementation. Tests may inject a fixed synthetic key; no real credentials are used.

The repository stores opaque identity IDs, active/disabled status, explicitly assigned roles, provider issuer/subject references, identity revision and credential-version/rotation metadata. Registered sessions store claims metadata and an opaque audit reference, not the signed credential, signature, password, bearer secret or verifier key. Knowing or supplying a user ID is not proof of authentication.

The verifier's default maximum lifetime is 15 minutes, configurable from one second to one hour. Validation enforces issuer/audience, authentication time, not-before, expiry and lifetime without inferring roles from credential text. Future or expired sessions fail closed. Unsigned, tampered, malformed or mismatched credentials cannot become principals. Each protected action also requires an existing matching session, current active identity, nonrevoked session and current credential version.

## Synthetic bootstrap and identity lifecycle

There is no unauthenticated first-administrator registration or production bootstrap/recovery API. `fixtures/security-fiction.ts` explicitly seeds invented identity metadata directly into an isolated temporary repository, then registers a signed synthetic session through the verifier boundary. This fixture composition is trusted test setup, not an account-creation or authentication route.

Internal session registration accepts only an already known issuer/subject and does not self-register identities or assign roles. Operational identity creation, role changes, status changes, credential rotation and administrative session revocation require a current `IDENTITY_ADMIN` authorization. A valid session may also invalidate itself without that administration permission. These operations use the same JSON lock as protected editorial actions. Local storage permits at most 128 identity records and 512 registered sessions; expired sessions are pruned during relevant security operations.

Authorization reads current role/status/session records on every action. Identity administration changes also check the expected identity revision, rejecting stale metadata edits. A role removed before an action's serialized authorization point cannot be recovered from stale credential claims. Disabled identities and revoked sessions are denied. Credential-version rotation immediately invalidates older credential versions; replacement credentials must satisfy the updated registration/version/timing rules. Revocation prevents later use of that registered credential/session, without rewriting the history of actions already validly committed.

## Explicit permission matrix

Permissions from multiple explicitly assigned roles form their union. There is no implicit administrator-to-editor inheritance. `ADMINISTRATOR` alone can manage access and schedules but cannot review or approve editorial content. Assigning another role is an explicit administration action; it is not a permission supplied by a request or object ID.

| Permission | REPORTER | EDITOR | MANAGING_EDITOR | ADMINISTRATOR |
| --- | :---: | :---: | :---: | :---: |
| `STORY_CREATE` | Yes | Yes | Yes | — |
| `STORY_EDIT` | Yes | Yes | Yes | — |
| `STORY_REVIEW` | — | Yes | Yes | — |
| `STORY_APPROVE` | — | — | Yes | — |
| `DRAFT_REVIEW` | — | Yes | Yes | — |
| `DRAFT_READY` | — | — | Yes | — |
| `EDITION_ASSEMBLE` | Yes | Yes | Yes | — |
| `EDITION_REVIEW` | — | Yes | Yes | — |
| `EDITION_READY` | — | — | Yes | — |
| `SCHEDULE_CONFIGURE` | — | — | Yes | Yes |
| `SCHEDULE_EXECUTE` | — | Yes | Yes | Yes |
| `IDENTITY_ADMIN` | — | — | — | Yes |

Unknown permissions and insufficient current roles deny by default. Final story approval, draft readiness and edition readiness use their own permissions rather than a broad review permission. No role has a publishing/distribution permission and no authenticated facade method publishes. Source verification, licensed-content eligibility and existing domain revision/state rules are independent of role membership and still apply. Roles apply within this trusted development workspace; production tenant membership and object-ownership policy are not implemented.

| Authenticated command family | Required permission |
| --- | --- |
| Create / edit story | `STORY_CREATE` / `STORY_EDIT` |
| Nonfinal story review | `STORY_REVIEW`; cannot select `APPROVED` or `PUBLISHED`. |
| Approve exact story revision | `STORY_APPROVE` |
| Draft review / ready-for-approval review | `DRAFT_REVIEW` / `DRAFT_READY` |
| Assemble / edit edition | `EDITION_ASSEMBLE` |
| Edition review / ready-for-approval review | `EDITION_REVIEW` / `EDITION_READY` |
| Create / pause / resume schedule | `SCHEDULE_CONFIGURE` |
| Evaluate / claim / begin / prepare / fail / recover runs | `SCHEDULE_EXECUTE` |

Commands select their permission internally; a request does not provide a permission override. Resource IDs identify targets, not actors or authority. The facade and `AccessControl` must refer to the same resolved repository path. All commands still require the corresponding valid domain transition and current expected revision where applicable.

## Protected mutation boundary

`AuthenticatedEditorial` is an internal opt-in facade over existing newsroom, draft review, edition and scheduler operations. It does not expose a server endpoint. Its guarded repository adapter keeps authorization at the actual mutation boundary:

1. Acquire the existing single-host repository lock and read current state/time.
2. Verify the credential and registered session; check current identity status, credential version, roles and the exact required permission.
3. Run the existing domain operation, including expected resource revision, state, rights and retention checks.
4. Attach a separate successful-action receipt and bounded safe audit metadata to the candidate state.
5. Sync the complete replacement file, then revalidate the credential/current permission at the precommit guard before atomic rename.

Role/status/revocation changes serialize through the same lock. An allowed action serialized before a revocation may commit; subsequent actions must use the updated policy. Expiry or revocation detected by the in-lock or precommit check aborts the editorial mutation. Authorization denials leave editorial payload unchanged; sanitized security failure metadata may be recorded separately. A storage failure cannot commit a success receipt without its protected mutation. After initial authorization succeeds, known safe lifecycle invalidations persist even if the requested domain action is rejected. The precommit guard also covers that scrub, so a final authentication failure rolls back editorial changes; initial authentication/permission denials never trigger domain invalidation.

This is a local authorization decision boundary, not a distributed transaction with a real identity provider. A future provider's remote revocation, asynchronous verification, key lifecycle, clock policy and storage trust need a production design and review. The supplied synchronous fixture verifier does not establish those guarantees.

## Authenticated receipts and legacy assertions

Existing direct services continue to support isolated fictional fixtures with caller-supplied actor labels. Historical newsroom approvals, draft/edition reviews and audit labels are not authenticated merely because an ID looks opaque. Migration adds no receipts and relabels no prior action.

A successful resource mutation stores a separate `AuthenticatedAction`: opaque actor ID, identity revision, session audit reference, exact permission, resource kind/ID, resulting resource revision where applicable and timestamp. A bulk operation with no affected resource may record only its safe security event. The receipt distinguishes the new verified synthetic-session path from a legacy assertion. It is not a new rights grant, truth finding, source verification or public publishing token. Existing draft/edition review records may retain their legacy unauthenticated shape; authentication evidence is the separate matching receipt, not a retroactively changed flag.

The facade is opt-in. Trusted code can still instantiate a direct legacy service or modify a JSON repository, so these paths are not a production-wide enforcement boundary. Production mutation entry points would need exclusive, reviewed routing through trusted authorization, real identities and durable storage before exposure.

## Audit and retention

Security events use fixed categories and codes for authentication outcomes, authorization denials, role/status changes, credential rotation, session revocation and protected actions. They retain opaque actor/session/subject references and permission metadata, without raw credentials, provider secrets, source prose, prompts or unbounded exception text. Opaque references minimize exposure but do not establish anonymity.

`securityAudit` and `authenticatedActions` are each capped at 512 records and a seven-day lifetime; pruning occurs during relevant local operations, without a background erasure service. Lifecycle/retention pruning also removes receipts for redacted stories, invalidated drafts/edition revisions, missing resources and failed/cancelled/attention-required runs. It does not create an independent lifetime for licensed source content. Identity/session metadata has its own operational lifecycle and is not covered by a claim that all identity records disappear after seven days.

These bounds intentionally limit historical security evidence; the log is neither complete forever nor tamper-proof. Trusted filesystem/code access can rewrite JSON, and local replacement does not securely erase backups, snapshots or external copies. Existing retention-review holds and content-rights restrictions still apply. Production identity/audit privacy, retention, incident recovery and access policy require separate review.

## Schema migration and isolation

Schema 7 adds `identities`, `sessions`, `securityAudit` and `authenticatedActions`. Reading schemas 1–6 migrates in memory while preserving existing stories, approvals, drafts, editions, schedules and audits. Schema 1/2 keeps the conservative retention hold; schemas 3–6 preserve their existing hold. Reading does not rewrite the file; a successful transaction persists schema 7. New security collections start empty, with no invented identity or authenticated interpretation of legacy assertions.

There are no public authentication, identity-management, editorial mutation or scheduler-control routes. No browser credential store, real provider integration, automatic scheduler, news feed, model/audio request, Stripe action or public publication is activated.

## Validation and production requirements

```bash
npm ci
npm run check
npm run typecheck
python -m unittest discover -s tests/browser -v
git diff --check
```

Use only synthetic fixture identities/credentials and the deterministic tests. There is no production login URL or account-creation command. The [DL-005A validation report](DL-005A_VALIDATION.md) records executed checks; mock credentials do not prove real-provider compatibility, actual reviewer identity or production authorization security.

Remaining work includes a reviewed identity-provider trust contract and verification/revocation design, secure production bootstrap/recovery and key management, authenticated mutation entry points, durable transactional persistence, operational clock/audit/retention policy, monitoring and independent security review. Editorial licensing, public release and unattended publishing also remain separately blocked. No production service or real account is enabled by this milestone.
