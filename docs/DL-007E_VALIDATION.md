# DL-007E internal editorial operations validation

Local implementation dated **2026-11-14 (Etc/UTC)**. Authorization covers an isolated local implementation, fictional/offline validation and one local commit. No push, pull request, merge, hosting operation or deployment is authorized.

## Baseline and preservation

- Repository/origin: `MauroDot/Dayline`, `https://github.com/MauroDot/Dayline.git`.
- Workspace: `/workspace/Dayline-dl007e`.
- Branch: `feature/dl-007e-editorial-operations-ui`.
- Exact starting commit and independently verified remote main: `9e48f58d9734c5e54722331d0599c71194b5b236`.
- Starting tree: `8451f7a70b3ceb449c51a5483b71aa126a321c61`; clean index/worktree at creation.
- Exact Node.js **22.16.0**, npm **11.9.0**, TypeScript **5.9.3**, pinned `@types/node` **22.19.15**. Locked `npm ci` installed three existing development packages. No new dependency or lockfile change.

The actual protected count is **twenty** pre-existing worktrees, with twenty-one total after this isolated worktree was created. `/tmp/dayline-007e-protected-baseline.json` records each protected branch, HEAD, porcelain status, staged/unstaged binary diff hashes, tracked inventory and tracked file bytes. All twenty matched the prior protection record or the clean completed DL-007D baseline. The original `/workspace/Dayline` retains fifteen staged files. No reset, stash, clean, overwrite, amend, rebase or force operation was used.

Read-only remote main inspection and the required baseline fetch were performed. No remote write was performed. The final local SHA belongs to this report's commit and is supplied in the completion handoff; clean artifact manifests independently record the final SHA/tree without a self-referential commit hash here.

## Interface and authentication boundary

The interface is served only by the existing guarded internal loopback listener with **both** `enabled:true` and `operationsUI:true`, mode `development`, and a non-staging/non-production process environment. Its inert shell and two assets have an exact path allowlist. The public reader never mounts them. Existing loopback peer, exact Host/Origin, forbidden cookie/forwarding/CORS-preflight, body size/deadline, bearer verification and no-store checks remain authoritative. A restrictive CSP permits only the same-origin external scripts, styles and API connections.

| Private route | Purpose |
| --- | --- |
| GET/HEAD `/internal/operations` | Inert development shell; contains no privileged data or credentials. |
| GET/HEAD `/internal/operations/operations.css`, `/internal/operations/operations.js` | Exact allowlisted private assets; never arbitrary file resolution. |
| POST `/internal/operations/overview` | Current permitted roles and capabilities. |
| POST `/internal/operations/sources` | Existing filtered/paginated source queue, restricted before pagination. |
| POST `/internal/operations/source` | Exact permitted source/review summary and allowed action indicators. |
| POST `/internal/operations/stories` | Bounded exact-resource authorized story summaries. |
| POST `/internal/operations/editions` | Bounded exact-resource authorized edition summaries. |

Privileged projections use the same repository, AccessControl, registered sessions, current roles, ResourcePolicy assignments and source-policy epochs. They are not a second authorization service. Final disclosure occurs under guarded reads with fresh authorization, revision/time checks and short display leases. Role/capability labels do not grant resource authority. Source proof/origin graphs require their own exact read assignments. Story visibility requires an existing edit/review/approval assignment and complete source reads; creation alone grants no ownership. An edition is omitted unless the complete placement is readable with the corresponding existing authority. No hidden record totals or private audit/reviewer identities are returned.

The trusted fictional launcher transfers ephemeral synthetic credentials only through an anonymous subprocess pipe into Python/browser memory. A main-frame, exact-origin development binding supplies a selected synthetic profile only after an explicit Connect action. There is no HTTP login, token-minting or role-switching endpoint, real identity provider or production account. The interface never persists credentials in browser storage, cookies, URLs, history, screenshots or logs. Refresh starts disconnected. Protected views and authority are cleared on disconnect, rejected/revoked authentication and lease expiration; already submitted response bytes cannot be recalled. This is bounded development polling, not a distributed revocation guarantee.

## Reused workflows and supported operations

The interface connects existing authenticated source inspection and review, explicit recommendation, independent confirmation, rejection, holds, release and withdrawal. Existing server checks decide exact revision, evidence, rights, retention, assignment and separation of duties. A recommendation alone cannot make a source eligible. The UI action indicators are advisory; every mutation still uses the established C/D/editorial APIs and commit-time authorization.

Story preparation requires explicit eligible source selection and current trusted selection tokens, exact STORY_CREATE assignment and human-authored content/evidence. No generated claim, citation, verification, reviewer assertion, approval or publication is supplied. Unsent authored text survives authorized stale/denied action errors; credential loss clears protected state. Preparation yields only INGESTED. Separate review, managing-editor approval, assembly and readiness preserve existing roles and exact assignments. There is no publication action, automatic approval, scheduler or provider integration. Direct editing without a suitable interface remains an intentionally unsupported/read-only operation; existing trusted legacy development services remain production bypass risks.

## Reproducible startup

With exact Node 22.16.0 on PATH, Python Playwright, a local Chromium and a graphical desktop session for the headed launcher:

```bash
npm ci
npm run editorial-operations:dev
```

This launcher creates its own temporary fictional repository and guarded ephemeral loopback listener, opens the internal interface and supplies synthetic profiles through the trusted in-memory bridge. Closing the browser or interrupting the launcher cleans up its owned temporary resources. It does not use protected repositories or real accounts. For deterministic headless domain demonstration:

```bash
npm run editorial-operations:fixture
```

No external provider, live Treasury/NWS, paid AI, Render, production identity, scheduling, Stripe or publication request is made by these commands. Dependency/browser installation is a separate development prerequisite, not a credential fallback.

## Exact changed-file inventory

Exactly **23 files** change; no dependency or lockfile change.

| Files | Purpose |
| --- | --- |
| `internal/operations/index.html`, `internal/operations/operations.css`, `internal/operations/operations.js` | Separate semantic, responsive private interface; scoped workflow controls, explicit human input, ephemeral credentials, leases and race/focus handling. |
| `src/security/operations-types.ts`, `src/security/operations.ts` | Allowlisted guarded read projections over existing roles, grants, revisions, source rights and retention. |
| `src/security/http.ts` | Explicit UI opt-in, exact asset allowlist/CSP and five authenticated strict POST read adapters. |
| `fixtures/editorial-operations-fiction.ts` | Isolated fictional identities, assignments, sources, clock and nonpublished seed state. |
| `src/security/operations-runner.ts`, `scripts/operations-browser.py` | Offline demonstration and trusted headed private-pipe browser launcher with owned temporary cleanup. |
| `tests/helpers/operations-browser-fixture.ts` | Anonymous-pipe-only fictional acceptance controls; no HTTP bootstrap or controls. |
| `tests/security-operations-projection.test.ts` | Exact grants, complete proof graphs, field privacy, expiry, bounded responses and final authorization/clock/concurrency guards. |
| `tests/security-operations-http.test.ts` | Real private transport, parser/CSP/static boundaries, roles, cursor scope, final serialization and in-flight revocation. |
| `tests/editorial-operations-fixture.test.ts` | Fictional-only seed/CLI, deterministic network-blocked output, guarded private IPC and strict cleanup. |
| `tests/browser/test_operations.py` | Real Chromium whole workflows, denial/staleness/revocation/late replies, keyboard/reflow/axe and credential isolation. |
| `tests/source-access-isolation.test.ts`, `scripts/smoke-public.ts` | Extend actual public artifact and staging/production runtime isolation with operations assets/adapters. |
| `package.json` | Two private launcher/demo scripts and one additional browser JavaScript syntax check only. |
| `README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY_DESIGN.md`, `docs/ROADMAP.md`, `docs/EDITORIAL_OPERATIONS_UI.md`, `docs/DL-007E_VALIDATION.md` | Startup, trust/workflow contracts, limitations and executed evidence. |

The existing A–D domain and authorization services, permission matrix, resource policy, rights registry, repository schema, source/official-data/runtime/assets, CI and deployment configuration remain unchanged. Static asset visibility is not authentication; all privileged reads and every existing mutation still pass server authorization. No generated artifact, screenshot, credential, cache or unrelated file is included in the commit.

## Executed validation

| Check | Actual result |
| --- | --- |
| Locked installation and runtime | PASS: exact Node 22.16.0, npm 11.9.0, TypeScript 5.9.3; same three development packages, unchanged lockfile. |
| Complete `npm run check` | PASS: strict TypeScript, five browser-JS syntax checks and **1,293/1,293** backend/domain/security tests, zero failures/skips/cancellations, 70.585 seconds. Includes all 1,189 baseline tests plus 104 new cases. |
| Consolidated final targeted run | PASS: **106/106**, zero failures/skips/cancellations, 13.155 seconds: 54 projection, 41 HTTP, 9 fictional fixture and 2 expanded public-isolation tests. This overlaps the complete suite. |
| Chromium | **53/53 PASS**, zero failures/errors/skips, 86.619 seconds: 27 unchanged baseline regressions plus 26 new interface cases. Final code and fixture versions were frozen for the complete run. |
| Source-server startup | PASS: loopback health/homepage/stylesheet 200, operations shell 404, graceful shutdown, zero upstream requests. |
| Precommit public artifact | PASS: two builds and inspections; all 12 files byte-identical, 73,344 bytes each; 11 runtime/package hashes unchanged from retained clean DL-007D; required digest unchanged. |
| Precommit staging/production smoke | PASS: exact Node 22, non-root/read-only artifact, health 200, initial unknown readiness 503, private asset/API isolation and bounded SIGTERM/SIGINT shutdown; zero upstream requests. |
| Whitespace/scope/secrets | PASS: changed files LF/final newlines/no trailing spaces; common credential-pattern scan zero; reviewed 23-file scope, no dependency/lockfile/public-domain-policy/CI/deployment changes. |
| Protected state | Twenty protected worktrees matched saved branch/HEAD/status/binarydiff/inventory/file bytes at preflight, midvalidation and immediately before staging; the completion handoff records the final postcommit comparison. Original 15 staged files retained. |

Representative executed commands, with exact Node 22.16.0 selected on PATH:

```bash
npm ci
npm run typecheck
npm run check
node --experimental-strip-types --test tests/security-operations-projection.test.ts tests/security-operations-http.test.ts tests/editorial-operations-fixture.test.ts tests/source-access-isolation.test.ts
npm run editorial-operations:fixture
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v
npm run build:public
npm run build:public -- --output dist/public-reader-repro
npm run inspect:public
npm run inspect:public -- dist/public-reader-repro
npm run smoke:public
git diff --check
```

All security and negative-path evidence is fictional/offline, using controlled clocks, exact synthetic assignments, isolated repositories/listeners and deterministic doubles. No live API data is presented as test evidence. Coverage includes unassigned records, roles, revoked/expired sessions, proof/origin graphs, filtered pagination/cursors, pending proposal privacy, separation of duties, source/session/receipt expiry, bounded serialized responses, hostile policy/guard returns, policy changes, initial-read/lock/serialization revocation and clock rollback. Read projections create no domain record, audit or action receipt.

Independent review identified UI lease and stale-response races; fixes clear read projections before mutations and use credential generations, per-projection request counters and exact selected-set and refresh-cycle versions. Existing backend checks were retained. Fixture/test-harness corrections aligned assertions with existing domain transitions, exact async completion and literal source eligibility. In particular, a held source invalidates an older handoff selection with the existing HTTP 400 contract; stale-but-eligible revision conflicts remain HTTP 409. No existing test was removed, skipped or weakened, and no server API contract was changed to satisfy a browser assertion. Missing interpreter/browser and staging/production startup fail safely and clean owned temporary state.

Expected experimental type-stripping warnings remain. Socket/subprocess/browser tests use the operational outer executor where the inner sandbox restricts localhost or Node children; the managed network/proxy policy remains in force.

### Browser and accessibility evidence

The 26 new operations cases exercise the actual guarded listener and browser, not substituted domain results. They verify exact assigned sources and hidden unassigned identities/metadata/counts, filters/pagination, recommendation-only denial, self-confirmation denial, independent confirmation, explicit selected revisions, literal human prose/evidence and INGESTED-only preparation. Separate editor review, denied editor approval, managing-editor approval, explicit edition assembly and ASSEMBLING/nonpublished status pass. A new edition has no inferred ownership.

Disputed/held sources, earlier selection rejection, assignment loss, registered-session revocation, unauthorized reporter/admin requests, refresh/pagehide credential loss, missing trusted bridge, safe unavailable/recovery states and public/bootstrap isolation pass. Delayed callbacks cannot restore old source details after a filter, replace a newer selected set/token, erase a newer selection on an old failure, or resurrect protected data after disconnect. Mutations lasting beyond the 1,500ms display lease clear prior read models while preserving authorized human prose. Ordering-only cases use a controlled browser clock and explicitly awaited intercepted-request callbacks; real elapsed-time lease/revocation cases remain separate. Five fresh-fixture repetitions of the delayed-detail case and four related concurrency cases passed before the final complete run.

Keyboard skip/navigation/focus visibility, consequential native-dialog cancellation and reduced-motion behavior pass. New-interface reflow passes at **1,440, 768, 390 and 320px**, plus **200% CSS enlargement** and a **720px viewport equivalent**. Targeted axe checks report **zero violations** in the loaded human-form and administrator-denied states. The unchanged reader/edition/source-queue accessibility, focus and responsive regressions also pass. These checks do not establish native browser zoom, assistive-technology or formal WCAG acceptance.

Sanitized screenshots were captured only with the credential input empty: `/tmp/dayline-007e-operations-1440.png` (1440×7924) and `/tmp/dayline-007e-operations-390.png` (390×12435). The desktop capture was visually reviewed. They contain fictional authorized records, no bearer values or request headers, and are excluded from Git. Test contexts block every nonfixture-origin request; no trace, HAR or video captures credentials.

### Actual fictional demonstration output

The following is the actual safe CLI output. It uses a labeled historical UTC clock and fictional human claims, not current licensed sources or actual factual verification:

```json
{"fictional":true,"developmentOnly":true,"asOf":"2026-06-01T12:00:00.000Z","pending":"UNREVIEWED","recommendation":"PROPOSED","recommendationCannotPrepare":true,"selfConfirmationDenied":true,"independentConfirmation":"RESOLVED","preparedStory":"INGESTED","separateExplicitApproval":"APPROVED","edition":"ASSEMBLING","publicPublication":false,"productionIdentity":false,"providerCalls":0}
```

The harness has no display server in this cloud shell, so a successful manual headed-window launch is not claimed. Real headless Chromium exercises the same shell, trusted in-memory binding and HTTP workflow. Windows/headed desktop acceptance remains pending. Fixed safe failure and cleanup paths were executed for missing Python and missing Chromium. Temporary logs under `/tmp/dayline-007e-` retain actual TAP/browser/CLI/smoke evidence; they may not survive environment replacement. This committed report preserves measured local results and reproducible commands.

## Public artifact isolation

Required unchanged public content digest:

```text
f2742749da68a8035cdb9780e35586cc6b664d95d60e3091b52e4aa9ef922e29
```

The artifact allowlist contains eleven runtime/package files plus its provenance manifest. Internal operations assets, projection adapters, synthetic identity infrastructure, fixtures and browser harnesses must be absent. Actual staging/production routes reject private assets/read adapters and never reflect bearer sentinels. After the single local commit, fresh `dist/public-reader-committed` and `dist/public-reader-committed-repro` builds are inspected and compared across all twelve physical file hashes and against the retained DL-007D eleven-file runtime/package manifest. Both must identify the exact final SHA/tree and sourceDirty:false. Both repeat staging/production smoke and offline release checks. The completion handoff and `/tmp/dayline-007e-final-evidence.json` preserve the actual postcommit identities, all twelve hashes and outcomes without a self-referential SHA in this report. Local offline release checks do not contact Render, verify hosting settings, authorize deployment or establish live acceptance.

### Unchanged runtime/package SHA-256 values

| Artifact file | SHA-256 |
| --- | --- |
| `package.json` | `1fa06b03973f3fc86327959ec45a3bd6d225e0229e221c166e50b8f5f61b8ecb` |
| `public/app.js` | `d6e166cdc07c59883d8ea7e45074886a401bb566eb9250a880fae71abffa5a36` |
| `public/index.html` | `cf4b126cfae462ef343d04abbd4195a01e5e1897f7e42817a0c9b7e2b5ee29d5` |
| `public/stories.js` | `ce30f7b509fa0a82b8084541fe80fa23f6895bf15b47ead9f0f4739eb1f804b4` |
| `public/style.css` | `fe9498c652b967f2e5be4cbde92d6d4ccc5872b2e0f8d5f9fcdf8c61f05d298a` |
| `src/cache.ts` | `d7eddddbdf35de85b97fb4d168a11902671da39a98b8bc32755239e1696da2b6` |
| `src/official-data.ts` | `86eeb0b7711905c1885cb74460e0bd0ce10de789e76e58701d2fcbf0cd349fec` |
| `src/public/config.ts` | `08e2c68e9d4e3d2118a57b58ee13be280777e3cc744be14e2b7ecc00cccb403f` |
| `src/public/lifecycle.ts` | `30a872bcec1ccdfeffc554b639179367c8c031c4e2e150fe64bfae86fb3cd3a3` |
| `src/public/main.ts` | `6dda4fa62ade909766e5ee8c1c24231060e5e913f42d1feac78931ac9a60910a` |
| `src/public/reader.ts` | `f69c0389ab7d0664de007d99f3c80ca964ed49faa9715040011c2142f70cfac9` |

The provenance manifest is the twelfth physical file. Its postcommit hash necessarily records the new commit/tree; the clean two-build comparison and completion handoff record that hash separately.

## Remaining acceptance and production limitations

Windows physical acceptance, native browser zoom at 200% and 400%, assistive-technology testing and live Treasury/NWS regression remain separate acceptance gates. Automated Chromium CSS/reflow and targeted axe results cover tested states only and are not formal WCAG certification. Exact prototype parity and real operating-system/browser combinations are not established by this development interface.

Real identity-provider verification, secure bootstrap/key management, exclusive authenticated production entry points, reviewed object-level policy, durable transactional storage, monitoring, commercial provider rights, cross-system retention and independent security review remain production requirements. Logical local redaction is not secure erasure or deletion from backups/external copies. Public publication remains disabled. Foundation 001's historical development acceptance is preserved; this report makes no production-readiness claim.

Stop after the authorized local commit and clean validation handoff. GitHub promotion requires separate authorization.
