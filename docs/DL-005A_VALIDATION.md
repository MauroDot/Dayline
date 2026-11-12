# DL-005A local validation

Executed 2026-11-06 (America/Chicago) in `/workspace/Dayline-dl005a`, branch `feature/dl-005a-editorial-auth-foundation`, starting at verified remote-main commit `5849b76e901d74d035f4c59ba813238a520b29f2`. The resulting local commit SHA is recorded in the handoff and `git log -1`. Authorization covers isolated implementation, synthetic tests and a local commit only.

## Identity and session architecture

The provider-independent `TrustedSessionVerifier` is a synchronous trusted boundary. The supplied implementation is an explicitly synthetic local HMAC-SHA256 verifier with strict signed compact credentials, issuer/audience/key binding, canonical payload validation and constant-time signature comparison. It is not a production JWT/OIDC integration. A private signing key stays in memory; the fixed test key is public synthetic fixture material. No production identity provider, real editorial account, provider credential, login route or browser session is created.

Schema 7 stores identity status, assigned roles, opaque issuer/subject references, identity revision and credential-version/rotation metadata. Registered session rows contain bounded claims metadata and opaque audit references, not the raw signed credential, signature, password, bearer secret or signing key. A session ID alone grants no authority. Session registration requires an already known active identity and a valid trusted credential; it does not create accounts or accept role assertions.

There is no unauthenticated first-administrator API. The test fixture seeds invented identity metadata in temporary repositories before registering signed synthetic sessions. Internal identity creation, role/status changes, rotation and administrative session revocation require a current administrator. Self-session invalidation requires a valid authenticated session without granting administration rights.

Validation enforces issuer/audience, authentication/not-before/expiry timestamps and maximum lifetime. The default lifetime limit is 15 minutes, bounded from 1 second to 1 hour. Unknown/unregistered, unsigned, tampered, future, expired, revoked, disabled or rotated credentials fail closed. Current repository roles are read for every action; stale token assertions cannot restore removed permissions. The same verified identity/session is required throughout registration and administration, as well as editorial commit guards.

## Role-permission matrix

| Permission | REPORTER | EDITOR | MANAGING_EDITOR | ADMINISTRATOR |
| --- | :---: | :---: | :---: | :---: |
| Story creation | Yes | Yes | Yes | — |
| Story editing | Yes | Yes | Yes | — |
| Nonfinal story review | — | Yes | Yes | — |
| Story approval | — | — | Yes | — |
| Draft review | — | Yes | Yes | — |
| Draft ready-for-approval | — | — | Yes | — |
| Edition assembly/editing | Yes | Yes | Yes | — |
| Edition review | — | Yes | Yes | — |
| Edition ready-for-approval | — | — | Yes | — |
| Schedule configuration | — | — | Yes | Yes |
| Schedule execution | — | Yes | Yes | Yes |
| Identity administration | — | — | — | Yes |

Assigned roles form an explicit union. Administrator membership alone grants no editorial review/approval. An identity with no roles may authenticate or invalidate its own session but receives no protected permission. No permission or facade operation publishes. These roles govern a trusted development workspace, not a production tenant/object-ownership model.

## Protected operations and transaction boundary

`AuthenticatedEditorial` wraps existing story creation/editing/nonfinal review/approval, draft review, edition assembly/edit/review and scheduler configuration/execution. The command chooses its permission; callers supply neither role nor principal assertions. Expected story/draft/edition revisions are checked. The facade must use the same repository as its access-control service. Publication transitions are unavailable.

The restricted adapter acquires the current JSON lock before verifying identity/session/current permission. Successful protected mutations run on candidate state. `JsonRepository.transactGuarded` shares the existing transaction implementation, syncs the complete replacement, runs the global test/fault hook, then invokes a synchronous authorization guard immediately before atomic rename while holding the lock. Missing, returning or asynchronous commit guards are rejected. A guard failure rolls back content, receipts and success audit together.

Role changes and revocations serialize through the same lock: an action serialized before revocation may commit; subsequent actions see the updated policy. Post-lock and post-staging expiry/revocation checks fail closed. The actor, identity revision and session reference must remain bound to the same verified principal; a verifier cannot switch principals between checks to authorize a different action.

Initial authentication/permission failures leave editorial arrays unchanged. After valid authorization, known lifecycle invalidations can persist when the requested domain operation is rejected, preserving retention scrubbing. Final authorization failure rolls back those scrubs too. Failure metadata may be recorded separately after rollback; logging itself can fail during a storage outage and is not a durable external audit.

Direct legacy services remain available to trusted isolated development fixtures. They are not production-authorized entry points. Historical reviewer strings and `unauthenticated` flags are preserved; migration does not backfill or relabel them. New authenticated-action receipts separately bind the verified opaque actor/session/permission to the exact resulting resource revision. A generic legacy actor label is never authentication evidence.

## Audit, retention and storage

Security events use fixed categories/codes for authentication success/failure, denials, role/status changes, rotation, revocation and protected actions. They contain opaque references rather than credentials, provider secrets, personal contact details, source text or raw exceptions. Editorial receipts contain resource references only where necessary to bind the protected action, with no copied licensed content.

Security audit and receipt collections are each capped at 512 entries and seven days. Linked receipts are pruned when story history is redacted, drafts/edition revisions invalidate, or resources become ineligible. Initial authorization failure does not invoke editorial invalidation. Existing rights checks and repository retention holds remain authoritative. Metadata pruning is logical removal, not secure erasure.

Identity/session collections are limited to 128/512 records. Expired sessions are removed during relevant security operations; revoked but unexpired sessions remain available to reject replay. Role changes are immediate, credential rotation invalidates old versions, and historical security records do not authorize a future action.

Schemas 1–6 migrate in memory without rewriting on read. All existing editorial, edition, schedule, audit and retention history is preserved; new security collections start empty. Older conservative retention holds remain. The next successful transaction writes schema 7. JSON storage and its audit are not tamper-proof, multi-host transactions or protection against trusted code/filesystem access.

## Executed validation

| Check | Actual result |
| --- | --- |
| Locked dependencies | `npm ci` passed; 3 existing development packages installed. No package/lockfile/dependency changes. |
| Runtime | Node **22.16.0**, npm **11.9.0**. |
| TypeScript | **5.9.3**, `tsc --noEmit` passed through `npm run check`. |
| Public script syntax | Existing `app.js`, `stories.js` and `edition.js` checks passed. |
| Backend/domain/security | **459 passed, 0 failed, 0 skipped, 0 cancelled**; existing 380 plus 79 added tests. |
| Chromium regressions | **18 passed**, unchanged suite, **18.904 seconds**. |
| Existing targeted axe audit | Zero violations in tested loaded/empty/unavailable states; no formal WCAG certification claimed. |
| HTTP startup/isolation smoke | All 12 expected outcomes passed; server terminated normally. |
| Whitespace | `git diff --check` passed. |
| Protected checkouts | All 12 match branch, HEAD, status, staged/unstaged diffs, tracked inventory and file hashes. Original checkout retains its same 15 staged files. |
| Scope/credentials | Approved security/domain integration, tests and docs only; no unexpected dependencies or real-credential pattern findings. |

Added tests: **21 policy/verifier**, **33 integration**, **11 retention**, **10 storage/commit guard**, **2 principal-binding**, plus **2 additional migration** tests. Existing migration expectations and old-schema fixture field omissions were adapted without weakening their safety assertions.

Coverage includes valid identities, issuer/audience mismatch, unsigned/tampered credentials, exact metadata binding, future/expired sessions, unknown/revoked replay, disabled accounts, immediate role removal, empty roles, administrator separation, rotation, object/principal spoofing, concurrent queued permission/session changes, stale resource revisions, post-sync expiry rollback, no partial session registration, identity consistency across verification stages, denial immutability, safe audits, migration, retention and absence of public auth routes.

Review found and corrected an empty-role authentication distinction, a possible partial registration on re-verification failure, and a wrapper path that discarded required lifecycle scrubbing on authorized domain rejection. New regressions also cover maintaining the same verified principal across registration/admin commit stages. The final exact-Node-22 run passed after these changes; no known failures were omitted.

The public homepage, official-data adapters, server routes, presentation assets, package scripts and GitHub workflow are unchanged. No live Treasury/NWS or news-provider request was used as evidence. Existing mocked official-data contracts, keyboard/focus, privacy/XSS, responsive layout, CSS 200%/400% enlargement/equivalent reflow and targeted accessibility checks passed again. Native browser zoom, Windows physical and assistive-technology acceptance remain separate work.

## Startup and HTTP isolation evidence

Production mode was used, including the fictional-view flag to confirm production isolation:

| Request | HTTP |
| --- | --- |
| `/` | 200 |
| `/api/health` | 200 |
| `/auth` | 404 |
| `/api/auth/login` | 404 |
| `/api/login` | 404 |
| `/api/identity` | 404 |
| `/api/admin` | 404 |
| `/api/editorial` | 404 |
| `/api/schedules` | 404 |
| `/dev/auth` | 404 |
| `/src/security/service.ts` | 404 |
| `/dev/edition` | 404 |

## Reproduction

Use synthetic fixtures only. There is no production login URL, real account-creation command or identity-provider configuration.

```bash
npm ci
npm run check
npm run typecheck
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v
git diff --check
```

Exact-runtime commands used:

```bash
npx --yes --package=node@22.16.0 -c 'node --version && npm --version && npm ci && npm run check'
npx --yes --package=node@22.16.0 -c 'PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v'
```

The locked-install run passed 457 tests before the two final principal-binding regressions. The final `npm run check` passed all 459 tests on the same Node runtime and locked dependencies. Browser prerequisites remain those in README/DL-004B validation: Python Playwright, Chromium and the local axe bundle. Session logs are `/tmp/dayline-005a-locked-check.log`, `/tmp/dayline-005a-final-check.log`, `/tmp/dayline-005a-browser.log` and `/tmp/dayline-005a-boundary.log`; temporary logs may not survive replacement. GitHub CI was not run or inspected in this local-only task.

## Complete changed-file inventory

| File | Purpose |
| --- | --- |
| `README.md` | Internal access-control usage and isolation. |
| `docs/AI_EDITORIAL_DESIGN.md` | Current schema/authenticated draft-review boundary. |
| `docs/ARCHITECTURE.md` | Security architecture and schema-7 migration. |
| `docs/EDITION_DESIGN.md` | Protected edition/scheduler operations and receipts. |
| `docs/RETENTION_POLICY.md` | Security metadata and linked receipt pruning. |
| `docs/ROADMAP.md` | New auth milestone and separately pending voice work. |
| `docs/SECURITY_DESIGN.md` | Full role matrix, trust/transaction flow and limits. |
| `docs/DL-005A_VALIDATION.md` | This executed validation report. |
| `fixtures/security-fiction.ts` | Synthetic identities and ephemeral signed credentials. |
| `src/security/types.ts` | Identity/session/permission/event/receipt contracts. |
| `src/security/verifier.ts` | In-memory synthetic signed verifier and safe errors. |
| `src/security/policy.ts` | Current-state deny-by-default authorization. |
| `src/security/service.ts` | Internal session and identity lifecycle. |
| `src/security/editorial.ts` | Guarded authenticated domain facade. |
| `src/security/retention.ts` | Bounded security metadata and receipt pruning. |
| `src/editorial/lifecycle.ts` | Draft invalidation security-pruning hook. |
| `src/editions/lifecycle.ts` | Edition invalidation security-pruning hook. |
| `src/newsroom/model.ts` | Schema-7 security collections. |
| `src/newsroom/store.ts` | Strict metadata/migration and guarded commit support. |
| `tests/security-policy.test.ts` | Signature/session/role policy checks. |
| `tests/security-integration.test.ts` | Protected operations, races and HTTP isolation. |
| `tests/security-retention.test.ts` | Time/cap/link pruning and fresh edition reassembly. |
| `tests/security-storage.test.ts` | Security shapes, migration and commit guard rollback. |
| `tests/security-boundary.test.ts` | Identity/session consistency through verification. |
| `tests/repository-migration.test.ts` | Preserved history and schema-6 migration. |
| `tests/edition-storage.test.ts` | Current-schema expectations/legacy fixture adaptation. |
| `tests/scheduling-storage.test.ts` | Current-schema expectations/legacy fixture adaptation. |

## Remaining production requirements

No locally available automated validation blocker remains. The supplied verifier and fixture bootstrap are synthetic only. Production requires a reviewed real-provider trust/verification/revocation contract, durable identity/session storage, secure bootstrap/recovery and key management, exclusive authenticated mutation entry points, tenant/object policy, trusted time, monitoring, independent security review and operational incident/audit/retention controls. Cross-system provider revocation and storage transactions are not implemented by this synchronous local adapter.

Legacy direct services and trusted JSON/filesystem access can bypass the facade, so this is not a production-wide enforcement claim. JSON logs are bounded and mutable, not complete forever or tamper-proof. Real-provider licensing, public deployment/publishing controls, external-copy deletion and any future paid-service authorization remain separate blocked work. Historical Foundation development acceptance remains intact.

All remote operations were authorized Git reads/fetch only. Main and all protected worktrees were preserved. No push, PR, merge, reset, stash, tag, release, deployment, real identity provider/account, real credential, production scheduler, live news ingestion, paid AI call, anchor audio, public publication, notification or Stripe action was created or activated. Stop after the authorized clean local commit for review.
