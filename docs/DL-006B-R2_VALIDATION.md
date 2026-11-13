# DL-006B-R2 local validation

Executed 2026-11-13. Authorization covers isolated implementation, deterministic tests, documentation and one local commit. This is local evidence, not hosted acceptance or production readiness.

## Baseline, final identity and preservation

Repository: `https://github.com/MauroDot/Dayline.git`. A remote query and non-force fetch verified `main` at **`eb574d0d153ffe2fc1f9b818634f379b2e46d444`**. The proposed branch and directory were unused. Created `/workspace/Dayline-dl006b-r2`, branch `feature/dl-006b-r2-staging-reliability`, at that exact baseline with a clean index and tree.

The final SHA is recorded in the completion handoff and can be obtained with `git log -1 --format=%H -- docs/DL-006B-R2_VALIDATION.md`; this report belongs to that implementation commit. The clean post-commit artifact separately records its exact source commit/tree. This avoids putting a self-referential commit hash inside its own contents.

All fifteen existing worktrees were inventoried before implementation. The original `/workspace/Dayline` remains on `work` at `0821402ec6cf8ec96b3bbbb8ce441e8c30b504be`, with its fifteen staged files protected. The fourteen other prior worktrees were clean at their recorded commits, including the W1 checkout at `fd5a646ce82cb3cff9cd69ccb6508e32109871e4`. Comparison covers branch, HEAD, porcelain status, staged/unstaged binary diff hashes, tracked inventory and tracked file-content hashes. Session baseline: `/tmp/dayline-006b-r2-protected-baseline.json`. No reset, stash, clean, overwrite or branch deletion was used.

## Hosted evidence and access limits

The owner supplied the following baseline; these are not independently verified provider settings:

| Item | Owner-reported value |
| --- | --- |
| HTTPS staging origin | `https://dayline-xd4l.onrender.com` |
| Render service | `srv-dbrl9h0u01pc73drftg0` |
| Plan | Free |
| Deployed source | `eb574d0d153ffe2fc1f9b818634f379b2e46d444` |
| Auto-deploy | Disabled |

No connected Render account tool was available. One read-only `/api/health` attempt was blocked before reaching the application: the ordinary command sandbox could not reach its managed proxy; the approved outer execution path received **CONNECT 403 Forbidden**, with curl HTTP status **000** for the target. This is a proxy restriction, not an observed application health failure. Current Render configuration, deployed bytes, actual application HTTP status and hosted source timestamps remain unverified. The restriction was not bypassed. No repeated hosted polling or live Treasury/NWS requests were performed.

## Runtime and health behavior

Only `src/public/main.ts` and `src/public/reader.ts` change deployed runtime behavior. The reader now classifies its existing fixed adapter errors into safe operational categories; the runtime now bounds structured log emission. There are no new routes, runtime modules, dependencies, outbound telemetry clients, upstream requests or retry settings. Reader assets, homepage decisions, adapters, cache implementation, configuration and lifecycle implementation are unchanged.

| Condition | Required behavior, covered locally |
| --- | --- |
| Cold process or replacement after host sleep | Health 200 when reachable; empty caches and readiness 503, without source probes. |
| Legitimate successful ordinary API observations | Readiness 200 only while Treasury and all observed NWS cities meet existing freshness requirements. |
| Failed refresh with permitted cached data | Serve authentic cached payload with `stale: true` and original source/retrieval timestamps; readiness 503. |
| Expired stale allowance or no valid record | Explicit unavailable response; no invented debt or forecast. |
| Later successful ordinary read | Refresh real observation state and permit readiness recovery; no fabricated priming. |
| Request/capacity saturation | Bounded admission, honest 503; process liveness remains separate from expensive work. |
| Pending upstream work at shutdown | Bounded graceful close and socket cleanup; replacement process has independent empty state. |

Readiness does not trigger upstream requests. It requires readable assets, Treasury within one hour and at least one sampled NWS city within 30 minutes; every sampled city must remain fresh. Existing stale eligibility is bounded to 24 hours. A failed secondary city therefore prevents readiness even when another city is fresh. An HTTP deadline or late upstream success does not silently restore fresh readiness; a later successful public read is needed.

The existing HTTP response deadline is 15 seconds by default. Underlying bounded upstream work can settle later while retaining its admission slot. Existing three-attempt, per-attempt/body timeout and retry limits are retained. Worst-case sequential NWS work can exceed the HTTP deadline; this is documented in the runbook rather than disguised as a completed response or new request budget.

## Treasury and NWS findings

Existing exact-cent Treasury reconciliation, decimal/schema validation, official record dates, NWS identifying configuration, forecast attribution/timestamps, bounded body size/timeouts/retries and shared cache loads remain intact. Deterministic tests exercise successful retries, exhaustion, malformed responses, outage, stale expiry, cold restart and later recovery. Concurrent clients share the bounded source load rather than multiplying retry budgets.

All upstream responses used in tests are synthetic. Synthetic dates and forecasts are test inputs, not evidence from Treasury or NWS. Missing/invalid identification remains a configuration failure. Actual compliant live regression and source timestamp capture require separate authorization and a real NWS contact entered privately; none was supplied, printed or committed for this task.

## Bounded operational logs

`safePublicLog` reads only own data properties, never getter/coercion values, and emits an explicit fixed schema. It excludes raw errors, URLs, provider bodies, headers, bearer credentials and private contacts. Request IDs remain generated by the process. Added categories:

- `UPSTREAM_HTTP`: the adapter's fixed HTTP rejection category, without reflecting status text or body.
- `UPSTREAM_RESPONSE_INVALID`: schema/reconciliation/forecast validation failure.
- `UPSTREAM_REQUEST_FAILED`: the adapter's combined network/timeout category; logs do not claim to distinguish causes that the adapter did not distinguish.

Routine records share one global per-process budget: **100 emissions per 60,000 ms** by default, independent of source or request ID. Suppression uses one counter capped at 1,000,000. On a later event in a new window, one fixed `operational_logs_suppressed` / `LOG_LIMIT` summary consumes routine budget. There is no timer, growing category map, retained event queue or outbound delivery.

The six fixed lifecycle event kinds each have a separate one-per-instance allowance, so a failure flood does not consume startup/stop visibility. Monotonic timing is the default; invalid/backwards readings do not replenish allowance. Stdout backpressure and throwing/rejecting sinks are contained. Transport remains best effort: dropped records are not guaranteed delivery, a durable audit or tamper-proof evidence. Restarts reset these in-memory limits; multi-instance quotas are not coordinated. Tests cover floods, refill, clock anomalies, cold replacement, getter safety, sink failure and actual listener-error floods.

## Artifact and release checks

The directory artifact still has exactly **twelve physical files**, including eleven manifest-hashed runtime/package entries and the manifest. Inspection verifies the existing import closure and package/runtime contract. No editorial/authentication/scheduler service, repository/database, credential fixture, test harness, development edition route, AI execution or payment code was added to the artifact. There are no runtime npm dependencies. No Docker image, registry publication or container acceptance is claimed.

Two actual precommit builds were byte-identical across all twelve files, including manifests, totaling **73,344 bytes**. Both truthfully recorded dirty-source provenance against the starting commit and are not release candidates. Their runtime content digest is:

```text
f2742749da68a8035cdb9780e35586cc6b664d95d60e3091b52e4aa9ef922e29
```

The offline checker correctly rejected that actual dirty candidate with `STAGING_SOURCE_NOT_CLEAN` and exit 1. After the local commit, the completion handoff records a fresh inspected/smoked artifact at `dist/public-reader-committed`, its clean source SHA/tree and the positive offline check. The earlier builds are preserved. Provenance intentionally changes when dirty state/commit changes; the runtime content digest must remain the same. The artifact builder never overwrites an existing directory.

`npm run check:staging-release -- --checklist PATH` checks an explicit commit/digest, full clean artifact, Node.js 22.16.0 metadata, HTTPS origin syntax, `autoDeploy: false` acknowledgement and a previous-version identity. CLI JSON input is bounded to 64 KiB, local regular-file input; errors use fixed categories. Validated scalar inputs are snapshotted before asynchronous inspection. The tool performs no network or provider calls, writes no settings and grants no authority.

A successful result explicitly reports `previousArtifactVerified: false`, `renderSettingsVerified: false`, `hostedAcceptanceVerified: false`, `hostedChecksPerformed: false`, `externalDeploymentAuthorized: false` and `automaticRollbackAllowed: false`. The previous commit/digest are operator-supplied identities, not proof of an actual known-good deployment. The local baseline digest used in the example check comes from retained artifact evidence, not an independently authenticated Render artifact. An offline pass cannot substitute for provider/host acceptance.

## Executed validation

| Check | Actual result |
| --- | --- |
| Versions | Node.js **22.16.0**, npm **11.9.0**, TypeScript **5.9.3**, existing pinned `@types/node` **22.19.15**. Default system Node 24 was not used for release checks. |
| Locked installation | `npm ci` passed; three existing development packages; no dependency or lockfile changes. |
| Full local/CI-equivalent check | `npm run check` passed: `tsc --noEmit`, public JavaScript syntax checks and **672/672** backend/domain/security tests, **0 failures, 0 skips, 0 cancellations**, 38.192 seconds. |
| New cases | **36** added to the accepted 636-case baseline: **10** observability, **7** resilience, **4** safe source categories, **15** offline release checks. These are included in 672, not additional totals. |
| Browser regression | **18/18 Chromium tests passed**, 39.170 seconds. Targeted axe checks reported zero violations in tested loaded/empty/unavailable states; responsive 390/768/1440/1920 coverage and enlargement/reflow checks passed. |
| Repeatable builds | Both twelve-file builds byte-identical; manifest, file hashes and digest inspection passed. |
| Packaged startup/shutdown | Staging/SIGTERM and production/SIGINT smoke passed on exact Node 22.16.0 as non-root with temporary read-only artifact permissions; health 200, initially unknown readiness 503, route isolation passed, **zero upstream requests**, bounded shutdown passed. |
| Offline release failure gate | Actual dirty precommit artifact rejected with fixed `STAGING_SOURCE_NOT_CLEAN`; deterministic tests also cover tampering, wrong identities, missing contract files, invalid settings and safe CLI errors. |
| Safe configuration and isolation | Existing configuration, static-file, private-route, wrong-runtime, import/package, Linux symlink and lifecycle tests remained passing in the full suite. |
| Whitespace and scope | `git diff --check` passed; no reader assets, lockfile, CI deployment policy or Windows W1 helper changes. |

Commands actually executed with Node 22 selected:

```bash
npm ci
npm run check
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v
npm run build:public
npm run build:public -- --output dist/public-reader-repro
npm run inspect:public
npm run inspect:public -- dist/public-reader-repro
npm run smoke:public
git diff --check
```

The expected Node 22 experimental type-stripping warning was emitted. There were no final skipped tests. Strict POSIX signal/link cases executed on Linux; the existing Windows capability-aware skip accounting and controlled-close path remain unchanged. No physical Windows execution, native browser zoom, assistive-technology acceptance or formal WCAG certification is claimed. Historical owner acceptance is preserved and is not relabeled as a new R2 run.

Default sandbox limitations required the approved outer execution path for managed-proxy and local socket/browser operations. Proxy/CA trust and destination restrictions remained enforced. GitHub Actions was not triggered or remotely verified because no push is authorized. CI configuration is unchanged.

Session logs: `/tmp/dayline-006b-r2-install.log`, `/tmp/dayline-006b-r2-validation.log`, `/tmp/dayline-006b-r2-browser.log`, `/tmp/dayline-006b-r2-artifact-evidence.json`, `/tmp/dayline-006b-r2-dirty-check.log`. Targeted logs cover observability, resilience, failure categories and release checks. Post-commit artifact and gate results are recorded in the final handoff. Temporary logs may not survive environment replacement; this committed report preserves actual precommit results.

## Complete changed-file inventory

| File | Purpose |
| --- | --- |
| `README.md` | Local release-check command, bounded observability and hosted evidence limits. |
| `docs/ARCHITECTURE.md` | Runtime logging and offline operator-tool boundary. |
| `docs/DEPLOYMENT_RUNBOOK.md` | Owner-reported staging, Free sleep/resource limits, manual release/rollback and live-check gates. |
| `docs/SECURITY_DESIGN.md` | Bounded sanitized visibility and limits of release acknowledgements. |
| `docs/DL-006B-R2_VALIDATION.md` | This evidence, inventory and limitation report. |
| `package.json` | Offline `check:staging-release` script only; no dependencies added. |
| `scripts/check-staging-release.ts` | Bounded offline candidate identity/checklist validation. |
| `src/public/main.ts` | Fixed-schema, rate-bounded best-effort operational logger. |
| `src/public/reader.ts` | Safe categories for existing fixed official-adapter failures. |
| `tests/public-failure-categories.test.ts` | Four deterministic HTTP/schema/network/stale log checks. |
| `tests/public-observability.test.ts` | Ten bounded logging and sanitization checks. |
| `tests/public-resilience.test.ts` | Seven stateful restart/outage/concurrency/shutdown checks. |
| `tests/staging-release.test.ts` | Fifteen offline identity, integrity, mutation and CLI checks. |

## Release, recovery and remaining risk

Follow [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md) for any future separately authorized handoff. Review the exact commit and clean artifact/digest; verify actual provider runtime, Free plan, disabled auto-deploy and HTTPS configuration through approved owner access; identify a genuinely known-good previous deployment/artifact; then require explicit manual deployment authorization. R2 performs none of those provider changes. Manual health/route checks and separately authorized, finite compliant live source observations remain acceptance evidence to collect after a future trigger.

A sleeping Free instance, initial readiness 503, temporary government outage or proxy denial alone does not justify rollback. Use finite owner-agreed observation windows and sanitized existing provider evidence. Confirm an application regression before a separately authorized manual rollback; preserve identities and acceptance evidence, then inspect health, route isolation, empty-cache readiness and authorized source recovery again. There is no automatic rollback, keep-awake task, restart storm, ongoing monitoring or polling job.

Outstanding staging work includes independent provider/deployed-artifact verification, an owner-verified previous deployment identity, hosted cold-start/recovery acceptance, real Treasury/NWS regression and R2 physical Windows/browser/assistive-technology review. Free-plan limits and sleeping behavior preclude any availability guarantee. Resource/log/cache budgets are per-process, logs are lossy under pressure, and process restart discards observations.

Production remains blocked on authenticated editorial entry points and identity policy, transactional durable storage and operational recovery, licensed real content/AI rights, retention controls, independent security/accessibility review, deployment/publishing authorization and production safeguards. Public publishing, scheduling, real identity providers, paid AI/audio, payments and real news ingestion remain disabled. No production readiness or security/accessibility certification is asserted.

No GitHub push, PR operation, merge, Render deployment/rollback/service mutation, plan/billing/environment/DNS/TLS change, external telemetry, live polling or production activation occurred. Stop after the local commit and review; remote promotion requires separate authorization.
