# DL-004A local validation

Executed 2026-11-05 in `/workspace/Dayline-dl004a`, branch `feature/dl-004a-daily-edition-assembly`, starting at `6a6e15dafa03c94e716ceb2db95abcfb44b0be3c` (verified remote main). This report records pre-commit validation of the implementation. The resulting local commit SHA is available in the handoff and `git log -1`; no remote promotion is authorized.

## Implemented boundary

Internal, fictional-only editions capture a date/canonical timezone, exact story revision, eight ordered sections, manually ordered placements, optional single Top Stories feature, source attribution/provenance, evidence references and uncertainty, policy digests, expiry, review revisions and procedural audit. No source article bodies are fetched or duplicated. There are no edition HTTP routes, public homepage changes, scheduling, publication or paid integrations.

Eligibility requires the latest newsroom `APPROVED` revision and its matching unredacted approval. AI-proposal readiness alone does not qualify. Every evidence item must be verified and supported; every source, including a syndicated origin, requires eligible managed fictional metadata and an exact active excerpt/internal-analysis grant. Disputed sources, quarantine, expiry, redaction and retention holds block placement. Syndicated copies share an origin count; this is not proof of independent confirmation or factual truth.

The review path is `ASSEMBLING -> NEEDS_REVIEW -> READY_FOR_APPROVAL`, with revision requests, holds, rejection and invalidation. Reviews are exact-revision, unauthenticated assertions. Editing resets assembly. There is no edition `PUBLISHED` state or publication authority. All historical snapshots are revalidated and affected licensed payload/linkages are scrubbed; review assertions are redacted. Explicit fresh reassembly can repair an invalidated edition, while rejection remains closed. A repository hold cannot be cleared by the edition workflow.

Schema 5 migrates schemas 1–4 in memory without rewriting on read or granting permissions, preserves existing records/holds, and adds edition/review arrays. Local transactions use the existing lock, synced temporary file and atomic rename; object-key serialization is deterministic and array order is preserved. All service eligibility clocks are read after lock acquisition. Newsroom mutation timestamps now consistently use one validated injected clock for the revision, approval, invalidation and audit.

See [edition design](EDITION_DESIGN.md) for exact transitions, limits, rights and preview contracts.

## Executed checks

| Check | Actual result |
| --- | --- |
| Locked installation | `npm ci` passed; 3 existing development packages installed; no dependency or lockfile changes. Repeated under the exact CI Node runtime. |
| Runtime | Node.js **22.16.0**, npm **11.9.0**; exact Node version verified with the test command. |
| TypeScript | **5.9.3**; `npm run typecheck` / `tsc --noEmit` passed within `npm run check`. |
| Public script syntax | Existing `app.js` and `stories.js` syntax checks passed within `npm run check`. |
| Full backend/domain suite | **282 passed, 0 failed, 0 skipped, 0 cancelled**. Existing baseline 204 plus 78 added tests. |
| Chromium regressions | **7 passed**, unchanged baseline suite; Python 3.12.14, Chromium 155.0.8059.79, with Node 22.16.0 used by the launched server. |
| CLI startup/static/security smoke | 9 HTTP outcomes matched expectations; security headers verified, server terminated cleanly. |
| Fictional fixture command | `npm run edition:fixture --silent` passed on Node 22.16.0: 2026-06-01, ASSEMBLING, 8 sections, 1 placement, 3 advisory cues; explicitly fictional/development-only/unpublished. |
| Whitespace | `git diff --check` passed. |
| Change review | Approved implementation/docs/tests only; credential-pattern scan found no matches; no unexpected dependencies. |
| Protected checkouts | All 9 matched recorded branch, HEAD, porcelain status, staged/unstaged diff hashes and tracked file hashes. Original checkout still has its same 15 staged files. |

New test coverage comprises 19 eligibility/advisory, 17 preview/fixture, 15 retention/lifecycle, 18 service/concurrency and 7 edition-storage tests, plus 2 additional migration tests. Prior migration expectations changed only to the new current schema while retaining their safety assertions. Tests cover unapproved/AI-only-reviewed/stale stories, expiry/revocation, direct and syndicated-origin disputes, quarantine, redaction, holds, duplicates, order, lifecycle denial, stale reviews, concurrency, atomic rollback, old-schema migration, deterministic serialization, all eight advisory codes, post-lock expiry and payload scrubbing across history.

The first development runs exposed a wall-clock/injected-clock mismatch and a noncanonical test fixture. These were corrected without removing the approval timestamp or section safeguards. A later clock-rollback regression also passed in the final 282-test run. Sandboxed child-process checks initially encountered `EPERM`; the completed validation ran with authorized local execution permissions. No network policy was bypassed.

The unchanged Chromium suite covers story navigation/attribution, focus restoration, mobile-menu Escape support, unavailable official-data/feature states, weather city selection, large debt/timestamps, and responsive widths 390, 768, 1440 and 1920 plus a reduced 320-pixel viewport. The large-debt check is a 200%-equivalent layout test, not physical browser zoom or assistive-technology acceptance. Official responses are mocked; their figures are test fixtures, not live evidence.

## Local startup evidence

| Request | HTTP status |
| --- | --- |
| `/api/health` | 200; `ok: true` |
| `/` | 200 |
| `/style.css` | 200 |
| `/app.js` | 200 |
| `/stories.js` | 200 |
| `/src/editions/service.ts` | 404 |
| `/api/editions` | 404 |
| `/api/editorial` | 404 |
| `/.env` | 404 |

`X-Content-Type-Options: nosniff` was present on every smoke response; homepage CSP includes `frame-ancestors 'none'`. Existing HTTP tests additionally exercise official upstream failures, timeouts/retries, cache behavior and static restrictions. `server.ts`, `public/`, CI workflow and dependency lockfile are unchanged.

## Reproduction

Use Node 22.16.0 and npm 10 or later, with Python Playwright and Chromium available for browser tests:

```bash
npm ci
npm run check
npm run typecheck
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v
npm run edition:fixture --silent
git diff --check
```

The exact-runtime command used here was:

```bash
npx --yes --package=node@22.16.0 -c 'node --version && npm --version && npm ci && npm run check'
npx --yes --package=node@22.16.0 -c 'PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v'
```

Session evidence is stored outside the repository at `/tmp/dayline-004a-final-check.log`, `/tmp/dayline-004a-browser.log`, `/tmp/dayline-004a-preview.json` and `/tmp/dayline-004a-protected-final.json`. These temporary files are not required to run the committed tests and may not survive environment replacement.

## Changed-file inventory

| File | Purpose |
| --- | --- |
| `README.md` | Internal edition usage and eligibility. |
| `docs/AI_EDITORIAL_DESIGN.md` | Current schema consistency. |
| `docs/ARCHITECTURE.md` | Edition, migration and timestamp design. |
| `docs/RETENTION_POLICY.md` | Edition history scrubbing and schema consistency. |
| `docs/ROADMAP.md` | Completed local foundation work and remaining operations. |
| `docs/EDITION_DESIGN.md` | Full edition contracts, transitions and limitations. |
| `docs/DL-004A_VALIDATION.md` | This executed validation report. |
| `package.json` | Fictional edition preview script only. |
| `fixtures/edition-fiction.ts` | Reviewed fictional source/story fixture. |
| `src/editions/types.ts` | Edition, placement, source, evidence and review types. |
| `src/editions/eligibility.ts` | Exact reviewed story/source/rights checks. |
| `src/editions/advisory.ts` | Eight presentation review cues. |
| `src/editions/lifecycle.ts` | Historical invalidation and scrubbing. |
| `src/editions/service.ts` | Date-scoped assembly, editing, review and concurrency. |
| `src/editions/preview.ts` | Deterministic fictional JSON preview. |
| `src/editions/runner.ts` | Temporary fixture CLI with no live/path mode. |
| `src/ingestion/retention.ts` | Atomic edition invalidation hook. |
| `src/newsroom/model.ts` | Schema-5 edition collections. |
| `src/newsroom/service.ts` | Invalidation hooks and consistent transaction timestamps. |
| `src/newsroom/store.ts` | Migration, strict edition shapes, deterministic serialization. |
| `tests/edition-eligibility.test.ts` | Eligibility and advisory checks. |
| `tests/edition-preview.test.ts` | Preview and isolated fixture checks. |
| `tests/edition-retention.test.ts` | Lifecycle, cleanup and timestamp regressions. |
| `tests/edition-service.test.ts` | Assembly, review, races and rollback. |
| `tests/edition-storage.test.ts` | Stored shapes, serialization and failure atomicity. |
| `tests/repository-migration.test.ts` | Preserved legacy checks plus schema-4 migration coverage. |

## Remaining acceptance and operational limits

No locally available validation blocker remains. Live Treasury/NWS requests were not performed for this milestone; current upstream compatibility remains pending and requires appropriate NWS identification. Previously accepted Windows behavior is preserved by unchanged public code and passing mocked/browser regressions, but no new Windows physical acceptance is claimed. Physical browser zoom, assistive technology and exact approved-prototype parity remain separate acceptance work. Foundation 001 is not declared complete.

Authenticated reviewers/authorization, real-provider and derived-content rights, production transactional storage/quotas, independent editorial/security evaluation, retention controls across backups and other copies, monitoring/recovery and an approved hold-release procedure remain production blockers. No expiry scheduler is supplied: service operations and manual cleanup enforce local eligibility, not autonomous deletion across systems. Local JSON deletion is not secure erasure.

Remote operations were limited to authorized read-only Git reference inspection/fetch. Main and all protected worktree files/indexes/branches were preserved. No push, PR, merge, rebase, reset, tag, release, deployment, paid API call, live news ingestion, Stripe operation or news publication was performed. Stop after the authorized local commit for owner review.
