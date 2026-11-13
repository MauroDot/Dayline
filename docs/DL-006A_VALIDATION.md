# DL-006A local validation

Executed 2026-11-13 (America/Chicago). Authorization covers isolated implementation, local tests, documentation and a local commit only. No external release, image publication or public deployment was performed.

## Baseline and preservation

Repository origin was verified as `https://github.com/MauroDot/Dayline.git`. A read-only remote query and non-force fetch verified main at **`bcb0687deaadd7ddd406f62fab82279e8593a3a8`**. The feature branch and proposed directory were unused. Created `/workspace/Dayline-dl006a`, branch `feature/dl-006a-public-deployment-foundation`, at that exact commit and confirmed a clean index and tree before implementation.

All fourteen existing worktrees were inventoried and compared with the previous protected-state record. `/workspace/Dayline` retains its fifteen staged files, and the other thirteen prior worktrees were clean at their recorded commits. Branches, HEADs, porcelain status, staged/unstaged binary diffs, tracked inventory and file-content hashes were recorded in `/tmp/dayline-006a-protected-baseline.json` for final comparison. No reset, stash, clean, overwrite or branch deletion was used.

The final feature SHA is provided in the completion handoff and `git log -1`; this report is included in that commit. Generated artifact provenance records the exact build commit/tree and actual runtime file hashes.

## Build and runtime architecture

The supported release format is an allowlisted directory artifact at `dist/public-reader`, not a container image. It requires the externally provisioned, exact **Node.js 22.16.0** runtime and no application dependencies. The packaged process refuses another Node version. The directory was chosen to provide a hosting-neutral executable artifact without adding an image registry, container base-image supply chain or deployment provider.

```mermaid
flowchart LR
  Owner[Manual staging authorization] --> Host[Future TLS reverse proxy and non-root host]
  Host --> Reader[Packaged read-only public process]
  Reader --> Static[Four allowlisted reader assets]
  Reader --> Official[Bounded Treasury and NWS adapters]
  Reader --> Health[Independent health and observed-data readiness]
  Dev[Source-only development server] --> Fixture[Temporary fictional edition preview]
  Private[Editorial / identity / scheduler / fixture code] -. excluded .-> Reader
```

The source-only `server.ts` retains the synchronous `createServer` API and existing fictional preview for development compatibility. It is excluded from the artifact. The packaged `src/public/main.ts` imports only configuration, lifecycle and the pure reader core. No private editorial listener is mounted or packaged.

The artifact contains twelve files: `public-manifest.json`, generated minimal `package.json`, `src/public/{config,main,lifecycle,reader}.ts`, `src/cache.ts`, `src/official-data.ts`, and `public/{index.html,style.css,app.js,stories.js}`. It excludes `.git`, all environment files, local databases, tests, build scripts, development dependencies, edition assets, synthetic credentials, fixtures, authentication, newsroom and scheduler implementations.

Build and inspection enforce exact inventory, regular files without symlink traversal, canonical metadata, SHA-256 hashes and the complete TypeScript/JavaScript import closure. Runtime builtins are restricted to crypto, filesystem promises, HTTP, net, path and URL. Privileged module/process loaders, dynamic unknown imports, code generation, bare dependencies and credential patterns fail inspection. Existing output paths are rejected rather than overwritten. Two builds from identical inputs must be byte-identical.

Manifest provenance includes the Git commit and tree, dirty-source flag, pinned runtime, each file's size/hash and a content digest. A dirty build is development evidence, not a release candidate. Hashes are not a signature or proof of independent attestation. The runbook requires an inspected clean committed artifact and a separately authorized manual release gate.

## Configuration and HTTP boundaries

Typed configuration distinguishes development, staging and production; unknown/blank modes fail. Default binding is loopback, including on Windows. A platform port is accepted only as a strict integer from 1–65535. All-interface binding requires an explicit nondevelopment setting. Staging/production require identifying NWS configuration and reject development/private/synthetic activation variables. Optional public origin configuration excludes credentials, paths, queries and fragments and requires HTTPS outside development.

Configuration and listener failures produce fixed structured codes without environment values, NWS contact information, authorization headers, raw provider errors, stack traces or local paths. Request IDs are generated rather than accepted from callers. No real provider, credentials, external telemetry, paid service, payments, publishing or scheduling activation was introduced.

The pure reader permits GET/HEAD only. Static files are an exact four-file allowlist with content-type checks and symlink rejection. Security headers apply to normal and error responses; JSON is `no-store` and assets require revalidation. Internal/auth/editorial/scheduler/database/source paths remain unavailable. Staging and production do not invoke a development extension even if supplied programmatically.

There are four fixed weather cache slots plus one Treasury cache, with concurrent-load coalescing and bounded stale handling. Defaults are 128 connections, 32 expensive concurrent handlers, 15-second receive/response deadlines, 10-second header timeout and five-second shutdown grace; all configurable bounds are listed in the deployment runbook. Health bypasses expensive-work admission. Timed-out underlying official loads may finish within their bounded retry budget, retaining their admission slot until completion; a late load cannot erase an observed response timeout until a subsequent successful public request.

## Health, readiness and official data

`GET /api/health` is process liveness and remains 200 during upstream admission saturation. It does not assert official-data availability. `GET /api/ready` verifies application assets and observed fresh Treasury plus at least one sampled NWS location; all sampled locations must be fresh. Initial unknown, stale, expired or failed data returns 503. Readiness never triggers an upstream fetch and is not a real-time government-service probe.

After a separately authorized staging start, an operator must manually prime debt and one valid weather location with compliant real identification before using readiness to admit traffic. Liveness, not upstream readiness, drives process restart. Outages must not cause restart loops. Retry budgets, response deadlines, restart backoff and rollback are documented in [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md).

Treasury exact-cent reconciliation and official reporting dates are retained. Weather identification is passed explicitly from validated deployment configuration; legacy development calls retain their compatibility path. Official adapters validate responses, use bounded retries/timeouts and preserve unavailable/stale states without fabricated figures or forecasts. This validation uses deterministic synthetic responses only. No live Treasury, NWS or news-provider request was made.

## Executed validation

| Check | Actual result |
| --- | --- |
| Tool versions | Node.js **22.16.0**, npm **11.9.0**, TypeScript **5.9.3**. |
| Locked installation | `npm ci` passed; three existing development packages, no dependency/lockfile changes. |
| Full check | `npm run check` passed: TypeScript, public JavaScript syntax and **602/602 backend/domain/security tests**, zero failures/skips/cancellations; 32.391 seconds. |
| Accepted baseline | Existing **530** tests remain passing; **72** deployment tests added. |
| New test breakdown | 15 artifact, 22 configuration/runtime, 18 reader and 17 official-upstream cases. All included in 602. |
| Chromium | **18/18 passed**, 38.235 seconds; targeted axe loaded/empty/unavailable states had zero violations. |
| Reproducible build | Two actual twelve-file builds byte-identical, including their manifests; 69,046 bytes in the inspected precommit artifact. |
| Artifact inspection | Exact inventory, pinned runtime, hashes, source provenance, excluded files and restricted import closure passed. |
| Runtime smoke | Both staging/SIGTERM and production/SIGINT passed, non-root POSIX user and temporarily read-only artifact, zero upstream requests, unchanged artifact bytes. |
| Wrong runtime | Actual Node **24.22.1** startup rejected with exit 1 and fixed `UNSUPPORTED_PUBLIC_RUNTIME`, without reflecting identification. |
| Whitespace/scope | `git diff --check` passed. Twenty-four approved source/test/config/documentation files; no reader asset or dependency changes. |
| Protected state | All fourteen prior worktrees match branch, HEAD, status, index/worktree diffs, tracked inventory and content hashes; original fifteen staged files preserved. |

The runtime smoke verified homepage and health 200, readiness 503 for unobserved dependencies, internal GET 404, internal mutation POST 405, development preview 404, environment/source paths 404, no credential reflection and clean bounded signal exits. Reader tests separately verified readiness 200 only after deterministic official-adapter successes, failure/staleness/expiry 503, no readiness-generated upstream calls, liveness during capacity saturation, coalesced cache loads and late-result handling. These are deterministic fixture results, not live API evidence.

Additional coverage includes strict startup failures, malformed/missing artifact identity, exact Node pinning, safe logs, platform ports and bindings, disabled private/development activation, static methods/content types/headers, forced socket shutdown, safe existing-output preservation, symlink exclusion, byte/hash/import/package tampering and secret sentinels. Adapter tests cover bounded fetch/body deadlines, three-attempt exhaustion/recovery, 1 MiB response limits with cancellation, strict Treasury dates/decimal bounds, strict NWS text/timestamp schemas and no fabricated values. The existing exact-cent and reporting-date tests passed unchanged.

Final precommit artifact content digest:

```text
f9db920b1da1ef1ae65f1cd68d34eaf47b444729b5c3b04a4e1c6d91c2381b5a
```

The validation build honestly records `sourceDirty: true` against the verified starting commit; it is not represented as a clean release. After the local implementation commit, preserve that build and regenerate the default artifact from the clean committed source, then inspect/smoke it again. The completion handoff records that final commit and artifact provenance. This avoids a self-referential SHA in this committed report.

Node 22's experimental type-stripping warning is expected. Git required the approved outer execution path because the command sandbox could not connect to the managed proxy; TLS trust and destination policy were retained. There were no skipped final tests. An initial complete run passed 600 tests before the two final provenance-fallback regressions; the final run passed 602 after that fix. Docker CLI is present but no Docker/OCI image was built or tested; directory artifact execution is the explicitly supported alternative, and no container validation is claimed.

Logs: `/tmp/dayline-006a-install.log`, `/tmp/dayline-006a-final-validation.log`, `/tmp/dayline-006a-final-browser.log`, `/tmp/dayline-006a-repro.log`, `/tmp/dayline-006a-repro-evidence.json` and `/tmp/dayline-006a-runtime-negative.json`. Temporary session evidence may not survive replacement; this report preserves the actual outcomes. GitHub CI was updated but not run remotely in this local-only task.

## Complete changed-file inventory

| File | Purpose |
| --- | --- |
| `.env.example` | Safe public configuration examples without private contacts. |
| `.github/workflows/ci.yml` | Local artifact build, inspection and smoke gates; no deployment. |
| `README.md` | Public artifact commands, health/readiness and boundaries. |
| `docs/ARCHITECTURE.md` | Pure-reader runtime and release artifact separation. |
| `docs/DEPLOYMENT_RUNBOOK.md` | Configuration, staging authorization, restart, rollback and Windows procedure. |
| `docs/DL-006A_VALIDATION.md` | This executed evidence and limitation report. |
| `docs/ROADMAP.md` | DL-006A implementation, validation and launch blockers. |
| `docs/SECURITY_DESIGN.md` | Public packaging and trust boundary. |
| `package.json` | Build/inspect/start/smoke commands without new dependencies. |
| `scripts/build-public.ts` | Deterministic allowlisted directory builder. |
| `scripts/inspect-public.ts` | Hash, inventory, provenance and AST import inspection. |
| `scripts/smoke-public.ts` | Local non-root/read-only artifact and signal smoke. |
| `server.ts` | Source-only development composition retaining existing preview API. |
| `src/official-data.ts` | Bounded official fetch/body handling and response validation. |
| `src/public/config.ts` | Typed fail-closed process settings. |
| `src/public/lifecycle.ts` | Bounded connection draining and signal handling. |
| `src/public/main.ts` | Independent public entry, safe logs and artifact identity/runtime checks. |
| `src/public/reader.ts` | Restricted reader HTTP, cache/admission limits and readiness. |
| `tests/public-artifact.test.ts` | Determinism, exclusions, tampering and output preservation. |
| `tests/public-config.test.ts` | Environment, port, bind, identification and limit validation. |
| `tests/public-reader.test.ts` | Public headers/routes/readiness/cache and capacity behavior. |
| `tests/public-runtime.test.ts` | Startup, identity/provenance, safe failure and shutdown behavior. |
| `tests/public-upstream.test.ts` | Time/body limits, schemas, safe failures and official timestamps. |
| `tsconfig.json` | Include deployment build/inspection/smoke scripts in static checking. |

## Reproduction

Use Node.js 22.16.0 and the existing lockfile:

```bash
npm ci
npm run check
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v
npm run build:public
npm run inspect:public
npm run smoke:public
git diff --check
```

For another build, use a fresh output (`npm run build:public -- --output dist/public-reader-candidate`), then inspect and smoke that exact path. Builds refuse existing destinations. The smoke script starts staging and production children on loopback, uses only synthetic configuration, makes zero upstream requests and checks health/readiness, route isolation, unchanged artifact bytes and bounded SIGTERM/SIGINT exits. On POSIX it temporarily removes artifact write permissions and restores their original modes afterwards. This affects only the generated, inspected artifact; Windows mode bits are not claimed to enforce the same ACL boundary.

The updated GitHub workflow executes local build, inspection and smoke steps after tests. It has no image upload or deployment step. No GitHub CI run is claimed from this local-only task.

## Launch blockers and acceptance

No external staging service is deployed. Hosting selection, independently provisioned Node runtime, non-root service identity, read-only filesystem policy, TLS termination, outbound access, operational monitoring, edge capacity/rate limits, real NWS identifying contact and separately authorized release/rollback remain owner-controlled requirements. Artifact hashes are unsigned. Docker/OCI execution is not claimed; the directory artifact is the supported alternative validated here.

Windows physical acceptance, native 200%/400% zoom, assistive-technology testing and compliant live Treasury/NWS checks remain pending. Chromium tests and targeted axe results do not establish formal accessibility certification or Windows acceptance. Existing historical Foundation development acceptance remains intact.

Production editorial publishing still requires real identity verification, exclusive authorized mutation paths, production object policy, transactional persistence, licensing, cross-system retention and independent security review. Those services are excluded from this public artifact. No push, PR, merge, external deployment, image publication, production DNS/firewall change, live ingestion, real identity account, paid AI/audio or Stripe action was performed.

## DL-006A-W1 — Windows acceptance tooling remediation

This section records the subsequent controlled remediation on 2026-11-13 (America/Chicago). The preceding sections preserve the original DL-006A evidence. Starting workspace/branch remained `/workspace/Dayline-dl006a`, `feature/dl-006a-public-deployment-foundation`, with exact HEAD `d49ba4065e75ba0893be25b26b722f2581607c97`. Ordinary Git reads confirmed remote main `bcb0687deaadd7ddd406f62fab82279e8593a3a8`, the feature branch at the starting commit and `refs/pull/15/head` at that same commit. The owner identified PR #15 as a draft; Git verified its commit reference, without a PR API write. The source index/tree was clean before changes. All fourteen other worktrees were compared with saved branch/HEAD/status/diff/content-hash records, including the original fifteen staged files. No worktree reconstruction or branch replacement occurred.

### Windows evidence and root causes

The owner reported PowerShell 5.1 with initial Node 24.22.3. Four symbolic-link tests encountered `EPERM` during fixture setup, before the intended security assertions could run. Ordinary Windows processes can lack link-creation privileges. W1 treats this as an explicit prerequisite limitation rather than a passing rejection assertion. No privilege elevation, Developer Mode change or security-policy change is attempted.

The two signal tests assumed POSIX-style graceful signal delivery from `child.kill`. Pinned Node type documentation (`@types/node/child_process.d.ts`) states that Windows ignores the signal argument and terminates the process abruptly; this does not demonstrate JavaScript SIGTERM/SIGINT handling. The old waiter also subscribed after termination and checked only `exitCode`, permitting a missed event when an already terminated child had only `signalCode`. W1 observes termination at spawn, retains strict exit-status checks, drains stdio and bounds cleanup. Investigation additionally reproduced a Node 22 parent-IPC-disconnect case on Linux where termination/stdio drain occurred without the expected final close event. The helper now accepts observed termination plus fully drained stdio and closed IPC, or the actual close event. It does not infer process success from timeout or forced cleanup.

A further deterministic regression models exit notification arriving before a queued `shutdown_started` message. The exact acknowledgement remains mandatory within a deadline; normal exit cannot discard an already queued ACK, and no ACK still fails. A send callback proves a write, not that the receiving JavaScript event has already run. Nonzero exits and shutdown defects remain failures.

Original artifact smoke inherited the parent Node 24 executable, while the artifact deliberately requires exactly Node 22.16.0. The reader correctly rejected that runtime, but the old tool reported an ambiguous startup timeout. W1 probes the chosen executable before port allocation/startup, reports a fixed runtime category, and never silently falls back to another executable.

The owner also reported successful original Windows build/inspection with clean d49ba40 provenance and twelve physical files, staging startup with side-by-side Node 22.16.0, homepage rendering and eight manual browser checks including zoom, navigation, route isolation and Treasury/NWS inspection. Two original-commit GitHub workflows were reported passing. Those are owner-reported historical results, not Windows execution or newly run CI from this Linux task. The W1 commit still requires its own actual Windows acceptance.

### Capability and lifecycle policy

`tests/helpers/symlink-capability.ts` probes file and directory links separately using newly created harmless temporary targets. It verifies the resulting link and always disposes its own temporary fixture. Only creation-time Windows `EPERM`/`EACCES` can return an unavailable capability. POSIX errors, setup/verification/cleanup failures and other error codes remain failures. Exactly four security cases depend on links (three file links, one directory link); each reports its own skip reason if genuinely unavailable. Mixed cases were split so existing-output preservation, noncanonical/duplicate manifests and missing-static-asset assertions always execute independently. Skips are not passes. All four link checks ran on this Linux host.

POSIX retains the two real CLI SIGTERM/SIGINT cases and requires clean exit and structured stopped evidence. Those two cases explicitly skip on Windows with a POSIX-semantics explanation. Windows uses a parent-only IPC acceptance worker under `tests/helpers/public-process-child.ts`: it imports the actual selected public entry point, invokes its existing exported close operation, acknowledges only after HTTP admission stops, bounds accepted work/socket cleanup and exits with a checked status. No shutdown HTTP route, production source change or deployable administration seam was added. The IPC tests run on Linux too, but are not evidence of native Windows signal behavior. If Windows lacks both link capabilities, up to four link cases plus two POSIX-only cases may skip; record actual host totals. All independent checks and the controlled-close path must still run.

The process helper registers exit observation immediately, handles exit/signal state, waits for drained output, bounds acknowledgement/exit waits and reaps only children created by this harness. Early failure, missing ACK, output overflow, nonzero exit and unreaped cleanup remain test failures. Parent disconnection closes the worker's listener and exits nonzero. The helper and IPC worker are excluded from the artifact.

### Runtime selection and PowerShell

`smoke-public.ts` defaults to the current executable but first requires a successful `--version` probe returning exactly `v22.16.0`. An explicit `--node ABSOLUTE_NODE` selects a trusted side-by-side executable, validates the path/file and probes that executable. Paths with spaces use argument arrays without shell expansion. Missing/invalid paths, failed probes and mismatched versions produce fixed `SMOKE_RUNTIME_INVALID`, `SMOKE_RUNTIME_PROBE_FAILED` and `SMOKE_UNSUPPORTED_RUNTIME` categories, without printing paths or child errors. No Node installation or persistent PATH setting is modified. The deployed reader's own independent runtime pin and Node 24 rejection remain unchanged.

The runbook contains complete PowerShell 5.1 commands using `Join-Path $env:USERPROFILE 'Tools\node-v22.16.0-win-x64\node.exe'`, the selected installation's npm CLI and a process-local PATH saved/restored with `try/finally`. It checks each `$LASTEXITCODE`, uses fresh artifact outputs and invokes `scripts/smoke-public.ts $candidateA --node $node22`. No application code embeds the owner's username or private contact. See [Windows acceptance](DEPLOYMENT_RUNBOOK.md#windows-local-acceptance).

### Executed W1 validation

| Check | Actual Linux result |
| --- | --- |
| Versions/install | Node **22.16.0**, npm **11.9.0**; locked `npm ci` passed, three existing development packages, no dependency changes. |
| Full check | TypeScript and browser-script syntax passed; **636/636 backend/domain/security tests passed**, **0 failed, 0 skipped, 0 cancelled**, 22.516 seconds. |
| Coverage accounting | Original 602-test coverage preserved; +3 mixed-test splits, +8 symlink-helper cases, +13 process-helper cases, +2 controlled lifecycle cases, +8 smoke-selection cases = **34 additional cases**. |
| Browser | **18/18 Chromium tests passed**, 36.992 seconds, including existing targeted axe states with zero violations. |
| Symbolic links | All four strict rejection cases executed; no Linux capability skips. |
| Lifecycle | Strict POSIX SIGTERM/SIGINT, bounded partial-work close, parent-disconnect cleanup and deterministic exit/ACK ordering cases passed. |
| Literal glob | Exact Node 22 accepted an unexpanded `tests/smoke-*.test.ts` argument; eight selection cases passed, matching command-shell argument delivery. |
| Fresh artifacts | `dist/public-reader-w1-a` and `dist/public-reader-w1-b` built and inspected; all twelve physical files byte-identical between builds. |
| Boundary preservation | All eleven runtime/package file bytes and hashes match the original d49 artifact; no runtime npm dependencies, helper, fixture or private domain was added. |
| POSIX artifact smoke | Staging/SIGTERM and production/SIGINT passed as non-root with read-only artifact files, health 200, unknown readiness 503 and zero upstream requests. |
| Node 24 default | Actual Linux Node **24.22.1** parent failed before artifact startup with `SMOKE_UNSUPPORTED_RUNTIME`, exit 1, approximately 0.75 seconds. This is distinct from the owner's Windows 24.22.3 run. |
| Explicit runtime override | Actual Node 24 parent with explicit Node 22.16.0 child passed staging and production artifact smoke; selection was recorded as explicit. |
| Controlled artifact close | Three additional idle packaged-reader IPC trials passed on Linux; shutdown ACK, rejected post-shutdown admission and exit 0 verified. These are not native Windows runs. |
| Scope/whitespace | `git diff --check` passed; no production source, public asset, dependency, lockfile, CI, builder or inspector changes. |

The artifact content digest remains:

```text
f9db920b1da1ef1ae65f1cd68d34eaf47b444729b5c3b04a4e1c6d91c2381b5a
```

The precommit W1 builds honestly identify d49ba40 plus dirty-source status. After the local remediation commit, a fresh final artifact is built/inspected/smoked from the clean new SHA; only manifest provenance changes. The completion handoff records that SHA. Existing artifacts and validation results are retained rather than overwritten. Native type-stripping warnings are expected. The first complete W1 run passed 635 cases; the final 636-case run includes the additional queued-ACK regression. An intermediate focused helper run exposed the missing-close case, which was corrected and covered rather than hidden.

Evidence: `/tmp/dayline-006a-w1-install.log`, `-final-check.log`, `-browser.log`, `-validation.log`, `-symlink-tests.log`, `-process-ack.log`, `-smoke-tests.log`, `-literal-glob.log`, `-runtime-negative.json`, `-runtime-override.log`, `-artifact-evidence.json` and `-artifact-ipc.log` use the common `/tmp/dayline-006a-w1` prefix. Temporary evidence may not survive environment replacement; this report preserves executed outcomes.

### Complete W1 changed-file inventory

- `README.md`
- `docs/DEPLOYMENT_RUNBOOK.md`
- `docs/DL-006A_VALIDATION.md`
- `scripts/smoke-public.ts`
- `tests/public-artifact.test.ts`
- `tests/public-reader.test.ts`
- `tests/public-runtime.test.ts`
- `tests/helpers/symlink-capability.ts`
- `tests/helpers/public-process.ts`
- `tests/helpers/public-process-child.ts`
- `tests/public-process-helper.test.ts`
- `tests/smoke-public.test.ts`
- `tests/symlink-capability.test.ts`

### Remaining acceptance and operational boundary

No actual Windows W1 execution is claimed. Repeat the documented PowerShell procedure on the new reviewed commit: record Node/npm versions, all failures/skips with reasons, controlled-close results, both inspected/reproducible artifacts, sourceDirty false, runtime selection and relevant physical/browser acceptance. Windows symlink privileges and console/service-manager signal behavior remain host-specific; the IPC check does not claim POSIX parity. Preserve the prior owner-accepted observations as historical evidence while recording the new rerun separately.

The deployment artifact's twelve-file contract, runtime pin, import boundary, HTTP restrictions, official-data behavior and source code remain unchanged. No public administration or test-control route was introduced. No remote write, PR #15 update, deployment, image/release publication, DNS/TLS/firewall change, real authentication, scheduling, news publication, paid AI or payment activation occurred. W1 ends with a normal local child commit; d49ba40 is not amended or rewritten.
