# DL-007A-W1 Windows fixture preload validation

Local test-harness remediation on 2026-11-13. Authorization covers a narrow descendant local commit only, with no push, PR update, merge or Render operation.

## Baseline and protected state

Workspace: `/workspace/Dayline-dl007a`. Branch: `feature/dl-007a-editorial-source-queue`. Exact starting commit: **`b081b9f3a60d83d52d480a28c9b90c4c17469a98`**. Repository origin is `https://github.com/MauroDot/Dayline.git`. The index and working tree were clean before edits.

All sixteen protected worktrees matched `/tmp/dayline-007a-protected-baseline.json`: branches, HEADs, porcelain status, binary index/worktree diffs, tracked inventory and tracked file-content hashes. The original checkout retains its fifteen staged files. No protected checkout, branch or index was modified. No reset, stash, clean, amend or history rewrite was used.

The final SHA is recorded in the completion handoff and `git log -1 --format=%H -- docs/DL-007A-W1_VALIDATION.md`. This report belongs to the same implementation commit; fresh post-commit artifact manifests record its exact commit/tree and clean provenance without a self-referential SHA inside this file.

## Owner-reported Windows failure

On Windows PowerShell 5.1 with Node.js 22.16.0, the owner reported **772 total tests: 765 passed, one failed, six skipped**. The failed case was:

`isolated fixture CLI is deterministic, explicitly fictional, makes no fetch calls and removes temporary repositories`

in `tests/source-queue-fixture.test.ts`. Its error was `ERR_UNSUPPORTED_ESM_URL_SCHEME`.

The test supplied the native absolute preload filename directly to Node's `--import` option. That option resolves a module specifier; a Windows `C:` prefix is interpreted as an unsupported URL scheme. Native filesystem paths remain appropriate for the runner entry argument and filesystem operations. Only the module-specifier argument needs conversion.

## Narrow correction and regression coverage

The test now imports `pathToFileURL` from `node:url` and passes **`pathToFileURL(guard).href`** to `--import`. This uses the executing platform's native path handling and correct URL escaping; no manual drive-prefix conversion or string concatenation is used.

The existing two-process regression now creates an actual preload named `forbid network #100% café.mjs`, exercising spaces, URL fragment/percent characters and Unicode. Each process must create its own `preload-loaded-0` or `preload-loaded-1` marker, proving that both real preloads executed. The original fetch override still writes a network-attempt probe and throws; the probe must remain absent during both CLI runs. Deterministic output comparison, fictional labels, private-field restrictions and repository-cleanup assertions remain intact. No test was removed or skipped.

Child-only `TMPDIR`, `TEMP` and `TMP` now point to the same isolated runtime directory in both subprocess cases. Windows chooses `TEMP`/`TMP` for `os.tmpdir()`; setting only `TMPDIR` could leave the cleanup assertion observing a different empty directory. The parent environment is unchanged. Guard/probe files stay outside that runtime directory and the enclosing fixture is still removed in `finally`.

The related-code search (`rg -n -- '--import|pathToFileURL' tests scripts package.json`) found only this direct-path `--import` call. Existing dynamic imports in `tests/helpers/public-process-child.ts` and artifact runtime tests already use `pathToFileURL`; no other test suites or helpers were changed.

Exactly two files change:

| File | Purpose |
| --- | --- |
| `tests/source-queue-fixture.test.ts` | Portable preload file URL, real encoded-filename regression, per-process load proof and child-only cross-platform temp isolation. |
| `docs/DL-007A-W1_VALIDATION.md` | Windows failure, remediation, actual validation and acceptance limits. |

No application code, fixture business data, source-queue logic, public-reader asset/module, rights registry, authentication, provider permission, dependency, lockfile, packaging rule or LF policy changes.

## Executed validation

| Check | Actual result |
| --- | --- |
| Locked installation / versions | `npm ci` passed with the same three pinned development packages. Node.js **22.16.0**, npm **11.9.0**, TypeScript **5.9.3**; no dependency or lockfile change. |
| Static TypeScript | `npm run typecheck` passed; strict ES2022 settings unchanged. |
| Focused fixture file | **6/6 passed**, zero failures/skips/cancellations, 2.649 seconds. The exact formerly failing case passed, including both preload markers, absent network probe, output equality and cleanup assertions. |
| Full check | `npm run check` passed: TypeScript, JavaScript syntax and **772/772** backend/domain/security tests; **zero failures, skips or cancellations**, 48.308 seconds. Existing test count preserved. |
| Chromium | **27/27 passed**, zero failures/skips, 60.122 seconds; existing keyboard/reflow and targeted axe regressions passed. No application/browser files changed. |
| Build / inspection / reproducibility | Both new precommit artifacts built and inspected successfully. All twelve files including manifests were byte-identical, **73,344 bytes** each; eleven runtime/package hashes match the retained DL-007A clean build. |
| Staging/production smoke | Exact Node22.16; staging SIGTERM and production SIGINT passed. Health 200, initially unknown readiness 503, non-root/read-only execution, public-route isolation and bounded shutdown; **zero upstream requests**. |
| Whitespace / scope | `git diff --check` passed. Only the fixture test and this report change. |

Commands executed with exact Node22 selected:

```bash
npm ci
npm run typecheck
node --experimental-strip-types --test tests/source-queue-fixture.test.ts
npm run check
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v
npm run build:public -- --output dist/public-reader-w1-precommit
npm run build:public -- --output dist/public-reader-w1-precommit-repro
npm run inspect:public -- dist/public-reader-w1-precommit
npm run inspect:public -- dist/public-reader-w1-precommit-repro
npm run smoke:public -- dist/public-reader-w1-precommit
git diff --check
```

The expected Node experimental type-stripping warning was emitted. The managed command sandbox has known Node-child/localhost restrictions, so complete subprocess and browser suites used the approved outer execution path. Proxy trust and destination policy were unchanged. No existing tests were weakened, removed or skipped; Linux continued to execute strict POSIX/link cases. No GitHub Actions run was triggered or verified.

Session evidence: `/tmp/dayline-007a-w1-install.log`, `...-focused.log`, `...-validation.log`, `...-browser.log`, `...-artifacts.log`, `...-repro-evidence.json` and `...-smoke.log`, with shared prefix `dayline-007a-w1`. Temporary evidence may not survive environment replacement; this report preserves the measured precommit outcomes.

## Artifact provenance and unchanged runtime

Preserve all existing DL-007A builds. New W1 precommit builds use `dist/public-reader-w1-precommit` and `dist/public-reader-w1-precommit-repro`. Development artifacts truthfully record dirty provenance against the starting commit and are not release candidates. Both actual precommit manifests record commit `b081b9f3a60d83d52d480a28c9b90c4c17469a98`, tree `fcc1ffa4fe7bf8a28952610d26944adebe6fda7c`, `sourceDirty: true` and Node.js 22.16.0 metadata.

The required unchanged public-runtime content digest is:

```text
f2742749da68a8035cdb9780e35586cc6b664d95d60e3091b52e4aa9ef922e29
```

After the local commit, build into fresh `dist/public-reader-w1-committed` and `dist/public-reader-w1-committed-repro` paths, inspect/compare them and repeat staging/production smoke. The completion handoff and `/tmp/dayline-007a-w1-final-evidence.json` record actual clean source commit/tree, twelve-file inventory, runtime/package hashes, digest and smoke results. Prior artifacts are not overwritten. Manifest provenance changes with commit/dirty state; the eleven runtime/package file hashes must remain unchanged.

## Windows reacceptance and operational limits

The current execution environment is Linux. Encoded native filenames, actual preload execution and all assertions are tested here; this does not independently execute Windows drive-letter resolution or establish physical Windows acceptance.

After a separately authorized handoff, rerun this exact reviewed commit on Windows PowerShell 5.1 using side-by-side Node.js 22.16.0 and the existing runtime-selection instructions in [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md#windows-local-acceptance). Preserve existing worktrees, owner Git settings and artifacts. Run locked installation, typechecking, the focused fixture file and full suite; verify that the formerly failing case runs and passes with its network guard, deterministic output and cleanup assertions. Record actual pass/fail/skip counts and reasons; do not count the historical six capability skips as passes or assume the new Windows result.

Use fresh artifact paths for two builds, inspection and staging/production smoke, confirm clean exact-commit provenance and the unchanged digest, and record applicable browser/physical acceptance separately. Do not activate live providers or fetch official data merely to validate this harness. No physical Windows, native zoom, assistive-technology or live Treasury/NWS acceptance is claimed here.

No GitHub remote operation, push, PR update, merge, Render request/deployment/configuration/billing action, real-provider permission, production publishing or paid-service activation occurred. Stop after the local commit for review; a push requires separate authorization.
