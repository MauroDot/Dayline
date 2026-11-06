# DL-004C local validation

Executed 2026-11-06 (America/Chicago) in `/workspace/Dayline-dl004c`, branch `feature/dl-004c-controlled-edition-scheduling`, starting at verified remote-main commit `9b9b2785d34ec6df3ab8c234dd83a8f5707d3676`. The resulting local commit SHA is recorded in the handoff and `git log -1`. Authorization covers isolated local implementation, automated validation and a local commit; it does not authorize a push or production scheduling.

## Architecture and boundaries

`src/scheduling` contains typed schedules/occurrences/preparation runs, deterministic calendar calculation, explicit service operations, eligibility reconciliation and an isolated fictional CLI. No scheduler is instantiated by the HTTP server, and no background process, timer, cron job, queue consumer or scheduling endpoint is added. The homepage, official-data adapters, edition presentation assets/routes and GitHub workflow are unchanged.

Schedules are immutable definitions except for pause/resume. They require a name, canonical explicit IANA timezone, minute-precision local `HH:mm` and nonempty selected weekdays (`0` Sunday to `6` Saturday). Daily schedules explicitly select all seven days. New schedules default to disabled. Invalid/extra authority fields, ambiguous offset/abbreviation inputs and malformed configuration are rejected. Named IANA zones with valid hyphens, signs and digits are supported after Intl validation.

State schema 6 adds schedules and preparation runs. Schemas 1–5 migrate in memory without rewriting on read, preserving historical records, restrictions, retention holds, proposals, editions and review history. Existing conservative schema-1/2 holds remain. Structured audit events use dedicated schedule/run IDs, never ingestion's source `subjectId`. The existing local lock, synchronized temporary file, deterministic serialization and atomic rename coordinate cooperating writers; this is not a distributed database or authenticated production audit.

## Calendar, DST and missed-run policy

- Occurrences are calculated from local calendar dates, not fixed 24-hour UTC increments. Searches inspect at most 16 local dates; candidate UTC offsets around each date are validated against exact Intl wall-clock fields.
- A nonexistent spring-forward local time is **skipped for that local date**. It is not silently moved forward.
- A repeated fall-back local time uses the **earliest matching UTC instant only**. A schedule/date has one stable occurrence key, so the second fold cannot create another run.
- Evaluation defaults to **dry run**. Explicit `evaluate({dryRun:false})` commits at most the latest due occurrence per enabled schedule. It does not claim or prepare work.
- Older unevaluated backlog is coalesced into `missedSince`, retaining the earliest skipped cursor without an unbounded backfill loop. If the latest due occurrence is older than the catch-up window, its record becomes `NEEDS_ATTENTION/MISSED_WINDOW`.
- The catch-up window defaults to **15 minutes**, bounded **1 second–24 hours**. It is an admission window, checked during evaluation and claim. A timely claim may finish later while its lease remains valid and fresh rights checks pass.
- Pause cancels scheduled/claimed/preparing/retryable failed work, fencing its old holders. Terminal retry exhaustion and prepared results are preserved. Resume calculates the next strictly future occurrence and does not replay the paused interval.

The timezone database is the installed Node/ICU data, not a bundled independent timezone database. Production timezone-update policy remains separate work.

## Claims, retries and preparation

The normal path is `SCHEDULED -> CLAIMED -> PREPARING -> PREPARED`. A random internal claim ID fences the current lease holder; it is not a reviewer identity or production publishing credential. The default lease is **30 seconds**, bounded **1 second–5 minutes**. Claiming consumes one attempt. Stale, cancelled, expired or superseded claim IDs cannot begin, prepare or fail work. Checks read the clock after acquiring the repository lock, and backwards scheduler clock movement fails closed.

Failures use safe enumerated codes. A transient failure or explicitly recovered expired claim becomes `FAILED` with a delayed retry, unless attempts are exhausted. Attempts are bounded to **1–3**, with default **3**; retry delay defaults to **60 seconds**, bounded **1 second–1 hour**. Exhaustion remains terminal `FAILED/RETRY_EXHAUSTED`, with no retry timestamp. Pause/cancel does not erase that outcome. Recovery and retry require another explicit invocation; there is no sleeping worker or retry timer. The repository itself still requires manual inspection of stale filesystem locks after a process crash.

Preparation takes an explicit ordered placement list at invocation time. The schedule/run never stores that list, story/source IDs, headlines, evidence text or licensed payload. A shared existing edition-assembly helper validates exact latest newsroom approval, evidence, rights and retention in the same atomic transaction that records the preparation result. It creates a new edition only in `ASSEMBLING`. Empty preparation is allowed; it cannot invent a story or bypass the normal edition review gate. A retention-review hold blocks even empty preparation.

Existing date/timezone editions are never overwritten: a manual or earlier edition causes `NEEDS_ATTENTION/EDITION_CONFLICT`. Ineligible, stale, redacted, quarantined or expired content causes `NEEDS_ATTENTION` without a partial edition. Prepared runs bind the exact resulting edition revision; later invalidation reconciles them to `NEEDS_ATTENTION/INELIGIBLE_CONTENT` alongside existing edition/retention cleanup. Scheduler actions never write newsroom approvals or edition reviews and cannot grant `READY_FOR_APPROVAL`, approval or publication.

## Executed checks

| Check | Actual result |
| --- | --- |
| Locked install | `npm ci` passed; 3 existing development packages installed. No dependency or lockfile changes. |
| Runtime | Node **22.16.0**, npm **11.9.0**. |
| TypeScript | **5.9.3**, `tsc --noEmit` passed through `npm run check`. |
| Public JavaScript syntax | Existing `app.js`, `stories.js` and `edition.js` checks passed. |
| Backend/domain/security suite | **380 passed, 0 failed, 0 skipped, 0 cancelled**. Existing 304 plus 76 added tests. |
| Chromium regression suite | **18 passed**, unchanged suite; final run **18.925 seconds**. |
| Existing targeted axe audit | Zero violations in the tested loaded, empty and unavailable edition states. This is not formal accessibility certification. |
| Fictional scheduler CLI | Both documented dry-run and temporary apply commands passed on Node 22.16.0. |
| Server startup and exposure smoke | All 9 expected HTTP outcomes passed; local server shut down normally. |
| Whitespace | `git diff --check` passed. |
| Protected worktrees | All 11 match recorded branch/HEAD/status, staged/unstaged diffs, tracked paths and file hashes; original checkout retains its same 15 staged files. |
| Change review | Approved scheduling, migration, edition integration, tests and documentation only; no unexpected dependencies or credential-pattern findings. |

New coverage: **19 calendar**, **29 service/CLI**, **14 rights/retention**, **8 storage**, **4 lock/error-boundary** and **2 additional migration** tests. Existing schema expectations/legacy fixture omissions were adjusted to schema 6 while preserving safety assertions.

Cases include spring/fall Chicago DST, Lord Howe half-hour shifts, Kathmandu offsets, Apia's skipped date, weekdays and calendar boundaries; repeated/concurrent evaluation and claims; concurrent preparation; stale fencing; interrupted leases; retry exhaustion; pause/resume/cancel; missed backlog; manual-edition conflict; empty content; stale/expired/quarantined/redacted sources and holds; read-only migration/dry run; atomic claim/edition/cleanup rollback; safe error messages; and no automatic editorial authority.

Development review found a valid-IANA-name restriction and a terminal-failure-history edge; both were corrected with tests. Additional boundary checks prove that a lease or content rights expiring during a lock wait cannot commit preparation. Storage and malformed-file errors are sanitized without disclosing raw private details. The final exact-Node-22 suite passed after these changes; no known failures were omitted.

## CLI evidence and reproduction

```bash
npm ci
npm run check
npm run typecheck
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v
npm run schedule:fixture
npm run schedule:fixture -- --apply-fixture
git diff --check
```

The CLI accepts no existing repository path, arbitrary schedule selector or live mode. It seeds only a new temporary fictional baseline and removes the directory afterwards. Default dry-run evaluation does not commit runs or editions to that baseline; fixture seeding itself is a temporary setup operation. Applying requires the explicit `--apply-fixture` flag and affects only that temporary repository. Outputs omit claim IDs, source/story payload and reviewer assertions.

| Mode | Observed result |
| --- | --- |
| Default dry run | One predicted `SCHEDULED` run; **0 persisted runs, 0 editions**. |
| `--apply-fixture` | **1 PREPARED run, attempt 1 of 3, 1 ASSEMBLING edition at revision 1**; no publication. |

The CLI fixture uses an explicit fictional UTC-noon schedule and fixed June 2026 timestamps. These are test assertions, not live news evidence. Real application schedules require their own explicit timezone; the existing reader view retains America/Chicago dates.

Exact runtime commands used:

```bash
npx --yes --package=node@22.16.0 -c 'node --version && npm --version && npm ci && npm run check'
npx --yes --package=node@22.16.0 -c 'PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v'
npx --yes --package=node@22.16.0 -c 'npm run schedule:fixture --silent && npm run schedule:fixture --silent -- --apply-fixture'
```

Browser prerequisites remain Python Playwright, Chromium and the local axe bundle described in README/DL-004B validation. No live Treasury, NWS or news-provider request was made for this milestone. Existing mocked official-data contracts and browser states passed. Automated CSS 200%/400% enlargement and equivalent reflow passed again; native browser zoom, Windows physical and assistive-technology acceptance remain separate checks and do not reverse the owner's historical Foundation acceptance.

Session logs: `/tmp/dayline-004c-final-check.log`, `/tmp/dayline-004c-browser.log`, `/tmp/dayline-004c-fixture.log`. These temporary artifacts may not survive environment replacement; the committed tests reproduce the checks.

## Startup smoke

In production mode, with the fictional-view flag also set to verify its production override:

| Request | HTTP |
| --- | --- |
| `/api/health` | 200 |
| `/` | 200 |
| `/style.css` | 200 |
| `/api/schedules` | 404 |
| `/api/preparation` | 404 |
| `/dev/schedules` | 404 |
| `/dev/scheduling` | 404 |
| `/src/scheduling/service.ts` | 404 |
| `/dev/edition` | 404 |

## Complete changed-file inventory

| File | Purpose |
| --- | --- |
| `README.md` | Explicit local scheduling/fixture commands. |
| `docs/AI_EDITORIAL_DESIGN.md` | Current schema consistency. |
| `docs/ARCHITECTURE.md` | Preparation coordination and schema-6 migration. |
| `docs/EDITION_DESIGN.md` | Exact scheduling, DST, catch-up and lifecycle policies. |
| `docs/RETENTION_POLICY.md` | Procedural scheduling records and invalidation integration. |
| `docs/ROADMAP.md` | Completed local work and remaining production operations. |
| `docs/DL-004C_VALIDATION.md` | This validation report. |
| `package.json` | One-shot `schedule:fixture` script. |
| `src/scheduling/types.ts` | Typed schedule, occurrence, run and failure records. |
| `src/scheduling/calendar.ts` | Strict definitions and local-calendar/DST calculations. |
| `src/scheduling/service.ts` | Explicit evaluation, claims, retries, recovery and preparation. |
| `src/scheduling/lifecycle.ts` | Exact-edition preparation invalidation. |
| `src/scheduling/runner.ts` | Isolated fictional dry-run/apply CLI. |
| `src/editions/service.ts` | Shared atomic assembly helper; existing API preserved. |
| `src/editions/lifecycle.ts` | Preparation reconciliation in existing invalidation transaction. |
| `src/newsroom/model.ts` | Schema-6 collections and structured audit references. |
| `src/newsroom/store.ts` | Migration and strict scheduling persistence invariants. |
| `tests/scheduling-calendar.test.ts` | Calendar/DST/config validation. |
| `tests/scheduling-service.test.ts` | Service, concurrency, retry, cancellation and CLI. |
| `tests/scheduling-retention.test.ts` | Rights/hold/cleanup and authority boundaries. |
| `tests/scheduling-storage.test.ts` | Record consistency, caps, binding and rollback. |
| `tests/scheduling-boundary.test.ts` | Post-lock expiry and sanitized errors. |
| `tests/repository-migration.test.ts` | Schema-5 migration plus preserved legacy checks. |
| `tests/edition-storage.test.ts` | Updated current-schema assertions and legacy fixture fields. |

## Remaining blockers and operational limits

No locally available automated validation blocker remains. This is trusted single-host development coordination, not production scheduling infrastructure. Production requires authenticated operators and authorization, durable transactional storage/idempotency, multi-host coordination if needed, trusted time/timezone-update policy, monitoring/alerts, operational recovery and separately reviewed publishing permissions. JSON lock recovery after crashes and capacity management remain manual; history is not silently purged to make room.

Real-provider licensing/derived-content rights, cross-system retention/deletion and hold-release controls, production security review and any future paid-provider cost safeguards remain separate blocked work. Source/approval assertions are not authenticated identities, local deletion is not secure erasure, and preparation is not editorial approval. No scheduling action clears a retention hold or restores redacted material.

All remote operations were limited to authorized Git reference reads/fetch. Main and protected worktrees were preserved. No push, PR, merge, reset, stash, tag, release, deployment, real scheduling activation, live news ingestion, paid AI call, generated anchor audio, publication, notification or Stripe operation occurred. Stop after the authorized clean local commit for review.
