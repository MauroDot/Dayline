# DL-007B authenticated editorial source access validation

Local implementation and validation on 2026-11-13. Authorization covers an isolated feature worktree and one local commit. No GitHub promotion, hosting mutation or production activation is included.

## Baseline and preservation

- Repository: `MauroDot/Dayline`; origin `https://github.com/MauroDot/Dayline.git`.
- Workspace: `/workspace/Dayline-dl007b`.
- Branch: `feature/dl-007b-authenticated-source-access`.
- Exact starting and verified remote main: `52c4d82c29aee7af55bba050cf50e3bc96a12aed`.
- Starting tree: `a828e58ed20f6afae566f8089a4334a1a2e94425`; clean index/worktree before implementation.
- Runtime: exact Node.js **22.16.0**, npm **11.9.0**, TypeScript **5.9.3**, pinned `@types/node` **22.19.15**. No dependency or lockfile changes.

All seventeen pre-existing worktrees were inventoried and matched `/tmp/dayline-007b-protected-baseline.json`: branch, HEAD, porcelain status, binary staged/unstaged diff hashes, tracked inventory and tracked file bytes. The original `/workspace/Dayline` checkout retains its fifteen staged files. Existing DL-007A/W1 commits and generated artifacts are preserved. No reset, stash, clean, forced checkout or history rewrite was used.

Only read-only remote identification and a fetch of main were performed during preflight. The new branch/worktree was created without reusing existing work. There is no push, PR operation, merge, GitHub Actions trigger, Render request, deployment or paid-service action.

The final commit SHA is recorded in the completion handoff and is available through `git log -1 --format=%H -- docs/DL-007B_VALIDATION.md`. This document is part of that commit; clean post-commit artifact provenance records its exact SHA/tree without a self-referential commit hash here.

## Implemented boundary

`SOURCE_READ` is granted only to `EDITOR` and `MANAGING_EDITOR` roles, additionally requiring a current registered session and exact trusted `SOURCE` assignment for each stored source identity. `REPORTER` and `ADMINISTRATOR` roles alone cannot read sources; even an administrator with a SOURCE assignment fails the role requirement. Existing permissions are unchanged. Read permission grants no source editing, provenance resolution, editorial approval, advancement or publication authority.

`AuthenticatedSourceQueue` reuses the existing repository/projection, with no second database. Trusted SOURCE assignments use raw stored source IDs, never browser candidate references or request-supplied decisions. Authorized candidates are filtered before views, pagination and cursor generation. Inaccessible origin references are removed before related-view selection. Hidden candidates do not contribute counts, entries or unrelated cursor changes. Required origin eligibility and repository-wide retention holds remain authoritative.

The source policy must synchronously supply a 64-hex epoch. Immutable `AssignedResourcePolicy` replacements get fresh random epochs, including replacement with identical grants. Dynamic trusted composition must delegate both decisions and the current epoch; epoch reuse is outside the contract. Missing/invalid/async policy revisions, async/non-void decisions and unexpected policy failures deny the whole read. Explicit per-resource permission denial hides that candidate; no current granted candidate denies the request. Cursors bind identity/revision/session, policy epoch, effective grants, view/limit and named authoritative source/rights/provenance/retention state. They do not hash arbitrary private provider, reviewer or audit extras.

An initial asynchronous read discloses nothing. The final fresh snapshot and synchronous disclosure share the existing single-host repository mutation lock through `readGuarded`. Session, identity, role, credential version, scope and policy epoch are rechecked. HTTP serializes a bounded allowlisted page, calls the final assertion and submits it synchronously with no intervening await. Final time checks reject clock rollback, session expiry and the next authoritative rights/retention/provenance transition affecting granted candidates or required origins, plus deletion timing affecting the global hold. This prevents expiry crossed during serialization from disclosing stale metadata.

The guarantee linearizes at synchronous response submission. Cooperating writes committed first are observed; writes queued after acceptance may commit after disclosure. Already submitted bytes cannot be retracted. `read()` accepts at its guarded callback; transports needing the HTTP guarantee must use `withPage` and its final assertion. Callbacks/policies are trusted synchronous code, not a sandbox against malicious composition. Direct repository/legacy service/filesystem access remains a bypass if exposed incorrectly. No distributed revocation or production identity guarantee is claimed.

The existing explicitly enabled development-only loopback listener adds only `GET`/`HEAD /internal/source-queue`. Host/Origin/peer, framing, header and synthetic bearer checks remain in force. The public reader and separate fictional `/dev/source-queue` preview receive no privileged route. Query inputs are unique `view`, `limit` (1–50), and `cursor` (at most 1,024 characters); total URL/query limits are 2,048/1,536 characters. Encoded aliases, source IDs/URLs, credentials and repository paths are rejected. Responses are capped at 262,144 UTF-8 bytes and marked no-store; HEAD authenticates identically and returns no body. Fixed 400/401/403/409/503 categories reconstruct errors without private messages, causes or extra fields.

The metadata DTO excludes provider payloads, titles/text/media, underlying source IDs, reviewer assertions, policy payloads and private audit data. Rights, deletion, quarantine, provenance and retention restrictions remain enforced. Reads write no source, approval or audit records, renew no dates and expose no mutation or publishing operation; every entry has `canAdvance: false`.

## Changed files

| Files | Purpose |
| --- | --- |
| `src/security/types.ts`, `src/security/policy.ts` | Narrow permission/resource types and editorial-only role grant. |
| `src/security/resources.ts` | Exact SOURCE assignments, immutable policy epoch and defensive trusted configuration validation. |
| `src/security/source.ts` | Current-session authenticated facade, exact scope, guarded disclosure, temporal fence and safe errors. |
| `src/newsroom/store.ts` | Reuse mutation lock for fresh synchronous read/disclosure; recognize SOURCE in typed action validation. |
| `src/source-queue/service.ts` | Internal scoped projection, authorized cursor fingerprint and temporal dependency cutoff; legacy fictional projection preserved. |
| `src/security/http.ts` | Minimal read-only internal route, strict query/response limits and final disclosure assertion. |
| `fixtures/source-access-fiction.ts`, `src/security/source-runner.ts` | Disposable fictional/synthetic demonstration with safe deterministic output and cleanup. |
| `package.json` | Add only `source-access:fixture`; dependencies/runtime requirements unchanged. |
| `tests/security-policy.test.ts` | Extend exact matrix expectations for the new permission; existing assertions retained. |
| `tests/security-source.test.ts` | 46 source service/session/permission/resource/lifecycle cases. |
| `tests/security-source-races.test.ts` | 24 disclosure, concurrent update, session/policy and serialization cases. |
| `tests/security-source-http.test.ts` | 20 actual loopback HTTP authorization, request, limit, failure and disclosure cases. |
| `tests/source-queue-scope.test.ts` | 17 projection/cursor/hidden-origin/temporal dependency cases. |
| `tests/source-access-fixture.test.ts` | 8 deterministic fixture, network-blocking, isolation and read-only cases. |
| `tests/source-access-isolation.test.ts` | 2 actual public-artifact and staging/production route isolation cases. |
| `README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY_DESIGN.md`, `docs/NEWS_PROVIDER_EVALUATION.md`, `docs/ROADMAP.md` | Commands, precise development authorization/disclosure model, historical boundaries and remaining blockers. |
| `docs/DL-007B_VALIDATION.md` | This evidence and acceptance report. |

No public runtime module/asset, homepage, official-data/cache adapter, rights-policy registry, provider permission, LF policy, build/inspection/smoke/release-check tool or lockfile was changed. Package metadata differs only by the private fixture script; the artifact builder retains the same minimal package.

## Executed validation

| Check | Actual result |
| --- | --- |
| Locked installation | `npm ci` passed; same three pinned development packages. Exact versions above verified. |
| Full check | `npm run check` passed: strict TypeScript, four existing browser JavaScript syntax checks and **889/889 backend/domain/security tests**, **zero failures/skips/cancellations**, 40.674 seconds. This includes all 772 prior tests plus 117 new tests. |
| Consolidated new tests | Final six-file targeted command passed **117/117**, zero failures/skips/cancellations, 8.926 seconds; all new source service/race/HTTP/scope/fixture/isolation cases. |
| Source/race/scope tests | **87/87** passed (46 service, 24 race, 17 scoped projection); zero failures/skips/cancellations. |
| HTTP regressions | **64/64** passed (20 new source HTTP and 44 existing listener/integration cases); zero failures/skips/cancellations. These overlap the full suite. |
| Chromium | **27/27** passed, zero failures/skips, 40.810 seconds. Existing desktop/mobile, keyboard, reflow, source queue, edition and targeted axe regressions passed. |
| Fictional demonstration | Authorized editor received exactly one assigned metadata row; unassigned managing editor and assigned administrator denied; revoked editor denied; no approval/advancement/publication and editorial arrays unchanged. |
| Artifact build/inspection | Two precommit builds and inspections passed; all twelve files including manifests byte-identical, **73,344 bytes** each, eleven hashed runtime/package entries. |
| Staging/production smoke | Exact Node22.16, non-root/read-only artifact. Health 200, initial readiness 503, isolation passed, staging SIGTERM and production SIGINT shutdown passed; **zero upstream requests**. |
| Existing source server CI boot | Health, homepage and stylesheet each returned 200 on loopback; controlled shutdown passed; no official-data requests. |
| Scope/LF/whitespace | `git diff --check` passed. Twenty-three existing boundary files matched starting bytes; public text/package LF integrity passed. Only the private package script changes. |
| Protected worktrees | All seventeen matched original branch/commit/status/diff/inventory/content snapshots; original fifteen staged files retained. Rechecked before commit and at final handoff. |

Representative commands, with exact Node22 selected first on PATH:

```bash
npm ci
npm run typecheck
npm run check
node --experimental-strip-types --test tests/security-source.test.ts tests/security-source-races.test.ts tests/security-source-http.test.ts tests/source-queue-scope.test.ts tests/source-access-fixture.test.ts tests/source-access-isolation.test.ts
npm run source-access:fixture
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v
npm run build:public
npm run build:public -- --output dist/public-reader-repro
npm run inspect:public
npm run inspect:public -- dist/public-reader-repro
npm run smoke:public
git diff --check
```

Tests use controlled clocks, synthetic registered credentials, fictional records and deterministic upstream doubles, never live provider requests. Positive and negative cases cover missing/invalid/expired/revoked sessions; disabled/demoted identities and credential rotation; no grants/wrong source/admin; mixed visibility, hidden counts/links/cursors and stale authorization/source state; malformed queries/prototypes/URLs/private fields; rights expiry/revocation, quarantine/deletion/hold; competing repository writes and in-flight revocation/policy replacement; final response serialization and byte-identical repository reads. CLI subprocess tests use `pathToFileURL` for portable network-blocking preloads, encoded filenames and child-only TMPDIR/TEMP/TMP isolation.

During hardening, adversarial regressions exposed policy replacement during final serialization and retention expiry during final recompute serialization while a session remained valid. They failed against the earlier gate and passed after the epoch and temporal fences. The final HTTP case returns 409 without candidate metadata; a subsequent fresh read withholds the expired metadata. Those regressions remain enabled. No existing test was weakened, removed or skipped.

Expected Node experimental type-stripping warnings remain. The managed inner executor has Node-child/localhost restrictions, so complete subprocess/browser/socket checks used the approved outer executor with existing proxy/destination policy intact. Temporary logs use `/tmp/dayline-007b-` prefixes (`install.log`, `check.log`, `targeted.log`, `browser.log`, `fixture.log`, `artifacts.log`, `repro-evidence.json`, `smoke-precommit.log`, `startup.json`). They may not survive environment replacement; this report preserves measured precommit results.

## Public artifact identity and clean handoff

Required unchanged content digest:

```text
f2742749da68a8035cdb9780e35586cc6b664d95d60e3091b52e4aa9ef922e29
```

Both precommit manifests truthfully identify the starting commit/tree and `sourceDirty: true`; these development builds are not release candidates. The eleven runtime/package hashes and physical twelve-file boundary remain unchanged. Authentication, source queue, identities/credentials, fixtures, private pages and test tooling do not enter the artifact.

After this local commit, fresh `dist/public-reader-committed` and `dist/public-reader-committed-repro` builds must each be inspected, compared byte-for-byte, and identify this exact commit/tree with `sourceDirty: false`. Repeat local staging/production smoke and run `check:staging-release` against both clean artifacts. The final completion handoff and `/tmp/dayline-007b-final-evidence.json` record the actual SHA/tree, clean manifests, unchanged eleven hashes/digest, smoke outcomes and offline checks. No existing artifact is overwritten.

The offline checklist uses the known local baseline as an operator-supplied previous identity and `autoDeploy: false` as a local validation input. This does not confirm the actual hosting setting or previous hosted artifact. Passing validates only local artifact/checklist syntax; it does not inspect Render settings, confirm a hosted version, authorize deployment or establish a rollback target. Hosted checks/settings remain unverified, external deployment authority is false, automatic rollback is false and separate manual authorization is required.

## Remaining acceptance and production blockers

This environment is Linux. Exact Node22 and portable filename/subprocess tests ran here; Windows physical execution, native 200%/400% browser zoom, assistive technology and independent accessibility review remain pending. CSS/viewport reflow and targeted axe success are limited automated evidence, not WCAG certification. Live Treasury/NWS regression requires separate compliant requests and actual identifying configuration; no live-source evidence is fabricated or claimed here. The accepted homepage and official-data code are unchanged.

Production additionally requires real identity-provider trust/revocation, secure bootstrap/key management, exclusive guarded entry points, reviewed object/tenant assignments and lifecycle, durable transactional storage, operational clocks/audit/retention, independent security review and real-provider licensing. Trusted legacy calls/raw files and external copies/backups remain outside this local facade; deletion is not secure erasure. The only policy registry remains fictional/default-disabled for real ingestion. No source edit, provenance resolution, public publication, production scheduler, paid AI/audio, payment or real account is activated.

Stop after the local commit and clean validation handoff. GitHub promotion or hosting changes require separate authorization.
