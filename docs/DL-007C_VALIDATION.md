# DL-007C controlled source review validation

Local implementation and validation on 2026-11-14. Authorization covers an isolated worktree, deterministic validation and one local feature commit. No remote write, PR, merge, Render operation, deployment, live ingestion or production activation is included.

## Baseline and protected state

- Repository/origin: `MauroDot/Dayline`, `https://github.com/MauroDot/Dayline.git`.
- Workspace: `/workspace/Dayline-dl007c`.
- Branch: `feature/dl-007c-source-review-provenance`.
- Exact starting commit and verified remote main: `4a6538a316cb11a1d6eac3f40ab13c721d656e83`.
- Starting tree: `e50728634e6cbc2d89999b334e71e8daf5649c9c`; index/worktree clean before implementation.
- Exact Node.js **22.16.0**, npm **11.9.0**, TypeScript **5.9.3**, pinned `@types/node` **22.19.15**. `npm ci` installed the same three development packages; dependencies and lockfile are unchanged.

All eighteen pre-existing worktrees were recorded in `/tmp/dayline-007c-protected-baseline.json` and compared with the previous protection snapshot. Branches, HEADs, porcelain status, binary staged/unstaged diff hashes, tracked inventories and tracked file hashes matched. The original `/workspace/Dayline` retains its fifteen staged files. Existing DL-007B and earlier worktrees/artifacts are preserved. The new branch and destination were unused before creation. No reset, stash, clean, force operation or history rewrite was used.

Remote work was limited to read-only origin/main inspection and the required main fetch. No push, PR action, merge, hosting request, deployment, paid API or external provider call occurred in this task. The final commit is available through `git log -1 --format=%H -- docs/DL-007C_VALIDATION.md` and the completion handoff. This report is part of that commit; clean artifact manifests record its exact SHA/tree without a self-referential SHA here.

## Workflow and permission matrix

| Permission | Reporter | Editor | Managing editor | Administrator alone |
| --- | --- | --- | --- | --- |
| `SOURCE_READ` | No | Yes | Yes | No |
| `SOURCE_REVIEW` — begin/propose/withdraw | No | Yes | Yes | No |
| `SOURCE_RESOLVE` — confirm/reject | No | No | Yes | No |
| `SOURCE_HOLD` | No | Yes | Yes | No |
| `SOURCE_RELEASE` | No | No | Yes | No |

Role permission is insufficient without exact trusted SOURCE assignments. Mutations require both SOURCE_READ and the action permission for the target, plus SOURCE_READ on every bounded evidence/origin dependency. Detailed inspection of action revision tokens also requires read grants for its complete current dependency graph. The basic queue exposes smaller target-authorized status metadata without the action token or evidence identities. Administrators receive no inherited source authority; explicit multiple roles still use the existing union policy. Existing story, edition and publishing permissions are unchanged.

The normal path is `UNREVIEWED → UNDER_REVIEW → PROPOSED → RESOLVED`. Independently accepted UNKNOWN/DISPUTED recommendations remain DISPUTED and blocked. Explicit rejection, hold, release and withdrawal paths preserve existing classification meanings. Release returns ON_HOLD to UNDER_REVIEW without restoring a proposal; WITHDRAWN is terminal for this review workflow. Derived EXPIRED/WITHDRAWN flags describe currently ineligible review grants or removed records, not a fabricated source timestamp. The complete state table is in [SOURCE_REVIEW_DESIGN.md](SOURCE_REVIEW_DESIGN.md).

Recommendations make no source-eligibility change. Only separate authorized confirmation invokes the existing provenance resolver. The proposer cannot confirm or reject the same proposal, even through another session or after acquiring a different role: separation uses authenticated identity IDs, never caller labels. Confirmation/rejection bind the exact pending evidence set and revision. Source, policy, provenance, proof or access changes make stale work fail closed.

Evidence lists contain 1–16 unique retained source IDs. For proposal/confirmation, at least one distinct proof is required and every non-target proof must be a current eligible managed VERIFIED PRIMARY/ORIGINAL source. Self-reference alone, quarantine, secondary or unverified proof is insufficient. Syndication additionally requires the verified original in the evidence list and existing resolver linkage. These references and human decisions are procedural evidence, not automatic truth certification or permission to invent independent reporting.

Only registered fictional policy snapshots permit this implementation. Audited review requires explicit minimal-audit permission with a finite positive audit term on targets/dependencies. No-audit grants cannot authorize linked review history; existing metadata reads are unchanged. Confirmation preserves original provider metadata, captured policy, retention time and deleteAt. No input accepts actor assertions, trusted timestamps, replacement rights, deadlines or authority overrides.

## Transactions, visibility and retention

Optional strictly validated schema-7 `sourceReviews` records reuse the existing JSON repository. Older files without the collection remain valid and reads do not rewrite them. The limits are 512 review revisions overall, 64 per source and 64 distinct transitive dependencies. Exhaustion denies rather than silently discard required review history.

Each mutation authenticates current registered sessions/roles, verifies exact assignments, validates target/dependency state and revision, and constructs source resolution, history and SOURCE action receipts atomically through `transactGuarded`. The final guard checks principal, policy epoch, every bound dependency revision, current captured rights/retention, session expiry and clock rollback after the synced replacement has been prepared and before rename. Rejected or failed commits leave no partial action or successful receipt. Cooperating concurrent writers serialize on the existing lock; test hooks exercise changes at the commit boundary.

Inspection/disclosure uses `readGuarded` with fresh state and synchronous final authority/temporal assertions. Action tokens hash named authoritative state and scoped proof dependencies; arbitrary private provider/policy/reviewer fields and legacy free-text proof contents do not change them. Queue cursors include only authorized safe review status/counters/flags. Relevant review changes invalidate continuation; unrelated inaccessible history cannot alter entries or cursors. Supporting-source deadlines participate in the final queue disclosure fence.

The private listener adds only POST `/internal/source-review/{inspect,begin,propose,confirm,reject,hold,release,withdraw}`. Exact opt-in/development mode, loopback/peer, Host/Origin, header/CORS/cookie, bearer and framing restrictions remain. Strict bounded JSON carries source IDs in the body, never URLs or queries. The existing 16,384-byte/one-second body limits remain; safe summaries have a 16,384-byte facade bound within the listener's 262,144-byte response ceiling. No login, minting, public approval or publishing route is added. Errors use reconstructed fixed categories; private fields, credentials and source/evidence IDs do not enter errors or operational logs.

Mutation commitment and HTTP response delivery are distinct. After a successful mutation, fresh guarded inspection authorizes final summary disclosure. A later disconnect/revocation/disclosure denial cannot undo that accepted commit; clients must inspect current state before retrying. The old revision prevents duplicate application. This does not turn an accepted action into a rejected commit or authorize partial transactions.

Explicit holds, withdrawal, accepted blocking provenance and invalid supporting proof block eligibility. Existing draft/edition invalidation paths apply; review never changes story approval, edition readiness or public publication authority. Releasing a source hold cannot clear `retentionReviewRequired`.

Review histories and receipts have no independent source-retention lifetime. Cleanup removes whole historical review groups, actor/proof links, fingerprints, receipts and copied authenticated provenance-decision references when target/evidence/origin metadata becomes expired, revoked, deleted or ungoverned. Orphan legacy decision links are also removed. Finite deletion markers cannot leave an expired proof identity in another collection. Security receipt pruning checks historical dependency grants; the seven-day security cap cannot extend a shorter source deadline. Cleanup is manual, sets the non-identifying global retention hold when required, and is logical deletion rather than secure erasure or external-copy enforcement.

## Exact changed-file inventory

| Files | Purpose |
| --- | --- |
| `src/source-review/types.ts`, `src/source-review/domain.ts` | Strict bounded review history/inputs, state transitions, evidence validation, named revision fingerprints and safe summaries. |
| `src/newsroom/model.ts`, `src/newsroom/store.ts` | Optional backward-compatible schema-7 collection and strict storage validation. |
| `src/security/types.ts`, `src/security/policy.ts` | Separate source action permissions and exact editorial role grants. |
| `src/security/source-review.ts` | Current-session facade, complete dependency scope, independent decisions, atomic mutations and guarded inspection. |
| `src/security/retention.ts` | Valid SOURCE receipts with source/dependency grant and history bounds. |
| `src/security/http.ts` | Minimal private review routes, strict inputs and final guarded summary delivery. |
| `src/ingestion/eligibility.ts`, `src/ingestion/retention.ts` | Review/proof restrictions and complete historical/orphan reference cleanup. |
| `src/source-queue/types.ts`, `src/source-queue/service.ts` | Optional authorized review flags, cursor invalidation and dependency-expiry disclosure fence. |
| `fixtures/source-review-fiction.ts`, `src/security/source-review-runner.ts` | Isolated fictional/synthetic fixture and deterministic offline demonstration. |
| `package.json` | Add only `source-review:fixture`; dependencies and runtime requirements unchanged. |
| `tests/security-policy.test.ts` | Preserve exact matrix assertions with the four new permissions. |
| `tests/security-source-review.test.ts` | 52 service/session/role/assignment/independent-review cases. |
| `tests/security-source-review-races.test.ts` | 24 concurrent, commit-time, disclosure and storage-fault cases. |
| `tests/security-source-review-http.test.ts` | 22 actual loopback HTTP cases. |
| `tests/source-review-domain.test.ts` | 35 domain/storage/evidence/privacy/retention cases. |
| `tests/source-review-fixture.test.ts` | 8 deterministic CLI/network-blocking/isolation cases. |
| `tests/source-review-retention.test.ts` | 9 authenticated cleanup/storage and finite-marker regressions. |
| `tests/source-review-visibility.test.ts` | 6 queue scoping/cursor/status/expiry cases. |
| `tests/source-access-isolation.test.ts` | Extend both existing actual artifact/runtime isolation tests with all private review routes. |
| `README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY_DESIGN.md`, `docs/RETENTION_POLICY.md`, `docs/ROADMAP.md`, `docs/SOURCE_REVIEW_DESIGN.md`, `docs/DL-007C_VALIDATION.md` | Commands, workflow/security/lifecycle contracts, evidence and pending acceptance. |

Exactly **32 files** change. Public runtime/assets/homepage, official-data/cache adapters, policy registry, underlying provenance resolver, LF rules, CI workflow, build/inspection/smoke/release tools and dependency lock remain unchanged. Twenty-six existing boundary files match their starting bytes; package.json changes only by the private fixture command. Review code, identities, fixtures, private pages and test tools stay outside the public artifact.

## Actual validation

| Check | Actual result |
| --- | --- |
| Locked install/version check | PASS, exact versions above; same three pinned development packages. |
| Full final check | `npm run check`: strict TypeScript, four browser JS syntax checks and **1,045/1,045** backend/domain/security tests; **zero failures, skips or cancellations**, 45.338 seconds. Includes all 889 baseline tests plus 156 new cases. |
| Consolidated final targeted run | **158/158**, zero failures/skips/cancellations, 12.627 seconds: 156 new cases plus the two extended existing artifact-isolation tests. This overlaps the full suite. |
| Chromium | **27/27**, zero failures/skips, 44.349 seconds; existing responsive/keyboard/reflow/targeted axe regressions passed. |
| Actual fictional CLI | PASS; output below. Two-process tests confirm deterministic output, a loaded file-URL network guard, absent fetch probe and temporary-state cleanup. |
| Precommit artifact build/inspection | Two builds inspected, twelve byte-identical files each, 73,344 bytes, eleven unchanged runtime/package hashes matching retained clean DL-007B. |
| Staging/production artifact smoke | PASS under exact Node22, non-root/read-only artifact, health 200, initially unknown readiness 503, route isolation and bounded SIGTERM/SIGINT shutdown; zero upstream requests. |
| Source-server CI boot | Health, homepage and stylesheet each 200 on loopback; shutdown passed, no upstream requests. |
| Whitespace/LF/scope | PASS; no common secret-pattern findings or unrelated/generated files in the reviewed diff. No existing assertion was weakened or test removed/skipped. |
| Protected state | Eighteen protected worktrees match saved branch/HEAD/status/diff/inventory/content state; original fifteen staged files preserved. Rechecked before commit and at final handoff. |

Representative executed commands with exact Node22 selected on PATH:

```bash
npm ci
npm run typecheck
npm run check
node --experimental-strip-types --test tests/source-review-domain.test.ts tests/security-source-review.test.ts tests/security-source-review-races.test.ts tests/security-source-review-http.test.ts tests/source-review-fixture.test.ts tests/source-review-retention.test.ts tests/source-review-visibility.test.ts tests/source-access-isolation.test.ts
npm run source-review:fixture
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v
npm run build:public
npm run build:public -- --output dist/public-reader-repro
npm run inspect:public
npm run inspect:public -- dist/public-reader-repro
npm run smoke:public
git diff --check
```

All data/security evidence uses fictional records, synthetic registered identities, controlled clocks and deterministic doubles, never live provider requests. Tests cover all four roles, exact target/proof/origin assignments, identity-based self-approval denial across sessions/role changes, disabled/demoted/expired/revoked/rotated/unregistered sessions, stale/concurrent actions, rights and retention expiry, quarantine/deletion, revoked/superseded snapshots, contradictory classifications, unverified origins, holds/releases, forged/prototype inputs, commit-time revocation and rollback, cursor/privacy boundaries and public packaging.

Adversarial checks exposed and verified corrections for SOURCE receipts pruned immediately, revocation masked by a policy wrapper, stale supporting evidence, detailed-token dependency authority, private-only fingerprint inputs, and copied provenance proof IDs surviving retention cleanup. Final serialization expiry and finite-marker/orphan regressions remain enabled. The final complete suite was rerun after those corrections. Expected experimental type-stripping warnings remain. Complete socket/subprocess/browser checks used the approved outer executor where the inner sandbox restricts localhost/Node children; proxy trust and network policy were unchanged.

## Actual deterministic demonstration output

```json
{"fictional":true,"developmentOnly":true,"asOf":"2026-06-01T12:00:00.000Z","provenanceWorkflow":{"initial":"UNREVIEWED","entered":"UNDER_REVIEW","proposed":"PROPOSED","eligibleBeforeConfirmation":false,"selfConfirmation":{"denied":true,"code":"PERMISSION_DENIED"},"independentConfirmation":"RESOLVED","eligibleAfterConfirmation":true},"disputedSource":{"status":"DISPUTED","eligible":false},"revokedReviewer":{"denied":true,"code":"SESSION_REVOKED"},"rightsAndRetentionUnchanged":true,"editorialAuthority":{"canApproveStory":false,"canReadyEdition":false,"canPublish":false,"editorialStateUnchanged":true}}
```

The historical fixture clock is explicitly labeled and grants no current real-source rights. Actual runtime logs are retained under `/tmp/dayline-007c-` (`check-final.log`, `targeted-final.log`, `browser.log`, `fixture.log`, `artifacts.log`, `repro-evidence.json`, `smoke-precommit.log`, `startup.json`). They may not survive environment replacement; this document preserves measured precommit outcomes and reproducible commands.

## Public artifact and clean commit handoff

Required unchanged content digest:

```text
f2742749da68a8035cdb9780e35586cc6b664d95d60e3091b52e4aa9ef922e29
```

Precommit manifests truthfully record the starting commit/tree and sourceDirty:true and are not clean release candidates. After the local commit, fresh `dist/public-reader-committed` and `dist/public-reader-committed-repro` builds must be inspected/compared with exact final SHA/tree and sourceDirty:false. Repeat staging/production smoke and run offline `check:staging-release` against both. The completion handoff and `/tmp/dayline-007c-final-evidence.json` record actual clean provenance, hashes/digest, byte reproducibility, smoke and offline results without overwriting existing artifacts.

Offline checklist inputs use the known local baseline as a previous identity and autoDeploy:false solely for local validation. They do not verify the hosted previous artifact or actual Render setting. Passing checks do not contact hosting, establish live acceptance, authorize deployment or permit automatic rollback. Hosted/settings verification and deployment authority remain false; separate manual authorization is required.

## Remaining acceptance and production blockers

This Linux execution does not establish Windows physical acceptance, native 200%/400% browser zoom, assistive-technology behavior or formal accessibility certification. Portable file-URL/encoded-filename/temp-directory regressions ran here; Windows must record its actual results and capability skips separately. Live Treasury/NWS regression still requires separate compliant identification and execution; no live official-data result is claimed. The accepted homepage and official-source implementation remain unchanged.

Production requires real identity trust/revocation, secure bootstrap/keys, reviewed object/tenant assignments, exclusive guarded entry points, durable transactional storage, operational clock/audit/retention controls, provider licensing and independent security review. Synthetic sessions, trusted callback contracts and cooperating single-host locks cannot confine raw repository/legacy service/file access, external/distributed identity changes or malicious composition. Accepted commits precede later revocations; submitted bytes cannot be recalled. Cleanup cannot erase backups, external copies or unlinked prose. Historical Foundation development acceptance remains intact; these production requirements do not reverse it.

No remote write, PR, merge, Render operation, hosting/billing change, deployment, live provider, real identity, paid AI/audio, unattended scheduler, payment or public publishing was activated. Stop after the local commit and clean validation handoff; GitHub promotion requires separate authorization.
