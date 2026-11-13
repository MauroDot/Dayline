# DL-006B-R2-W2 cross-platform artifact validation

Local implementation and validation on 2026-11-13. Authorization covers a descendant local commit on the existing feature branch only. No GitHub push, PR update or hosted action is authorized.

## Baseline and preflight

Workspace: `/workspace/Dayline-dl006b-r2`. Branch: `feature/dl-006b-r2-staging-reliability`. Exact starting HEAD: **`72c9492cac999942f81fe3a191308988568cc583`**, with a clean index and working tree before edits. Fetch/push origin is `https://github.com/MauroDot/Dayline.git`.

A read-only `git ls-remote` independently verified remote `main` at `eb574d0d153ffe2fc1f9b818634f379b2e46d444`, the remote feature branch at the exact starting HEAD, and `refs/pull/16/head` at that same HEAD. This verifies PR #16's Git revision without claiming API verification of its open/draft state. No remote reference was modified. The default command sandbox could not reach its inherited proxy; the approved outer execution path used the same Git destination with proxy/CA trust and destination policy retained.

All sixteen worktrees were inventoried. The fifteen other worktrees were compared with their retained protected-state record: branch, HEAD, porcelain status, binary staged/unstaged diffs, tracked inventory and file hashes match. The original `/workspace/Dayline` retains its fifteen staged files. No reset, stash, clean, renormalization or protected-file rewrite was used. Session preflight record: `/tmp/dayline-006b-r2-w2-preflight.json`; retained protection baseline: `/tmp/dayline-006b-r2-protected-baseline.json`.

The final commit is identified in the completion handoff and by `git log -1 --format=%H -- docs/DL-006B-R2-W2_VALIDATION.md`. This report belongs to that commit; its SHA cannot be embedded in its own contents. Fresh post-commit artifact manifests and the final evidence record contain the exact new commit/tree and clean provenance.

## Root cause and original evidence

At the identical original R2 commit, Linux recorded **672 passes, zero failures/skips**, 18 Chromium passes and this artifact content digest:

```text
f2742749da68a8035cdb9780e35586cc6b664d95d60e3091b52e4aa9ef922e29
```

The owner separately reported actual Windows Node.js 22.16.0 results: **666 passes, six platform-capability skips, zero failures**, passing staging/production smoke and clean source provenance. Its digest was:

```text
769dec2220371dd9e3263f4f2b907d6e774f333424f5d22e1abf80d67d6627de
```

Windows had `core.autocrlf=true` and `i/lf w/crlf attr/` for `public/app.js`, `src/official-data.ts`, `src/public/main.ts` and `src/public/reader.ts`. No repository `.gitattributes` existed. The builder copied and hashed raw working-tree bytes; Git can normalize CRLF during status comparison and still report clean provenance. Therefore the same Git blobs could produce different artifact bytes. This is a confirmed mechanism consistent with the supplied Windows evidence; the original Windows artifact was not independently inspected or reconstructed here.

## Narrow correction and effective policy

The repository now contains exactly these `.gitattributes` rules:

```gitattributes
# Public artifact text inputs must have identical checkout bytes on every platform.
# Keep these explicit paths aligned with scripts/inspect-public.ts; no binary rules.
/.gitattributes text eol=lf
/package.json text eol=lf
/src/cache.ts text eol=lf
/src/official-data.ts text eol=lf
/src/public/config.ts text eol=lf
/src/public/lifecycle.ts text eol=lf
/src/public/main.ts text eol=lf
/src/public/reader.ts text eol=lf
/public/index.html text eol=lf
/public/style.css text eol=lf
/public/app.js text eol=lf
/public/stories.js text eol=lf
```

These pin all eleven actual source inputs: ten copied runtime/assets including lifecycle, plus the source package metadata. The policy file pins itself. Generated package/manifest JSON already use canonical LF serialization. There are no broad extension/binary rules, global/system Git changes or owner `core.autocrlf` changes. Existing indexed source blobs were already LF; no renormalization or unrelated file rewrite was needed.

Actual `git check-attr text eol` reports `text: set`, `eol: lf` for every input. `git ls-files --eol` reports `i/lf w/lf attr/text eol=lf`. Future allowlist changes must explicitly update and test the policy.

The builder checks literal carriage-return bytes in every copied input and raw source `package.json` before creating output. Independent inspection applies the same fixed `PUBLIC_LINE_ENDING_INVALID` rejection to hashed artifact entries. Bytes are rejected, never normalized; valid hashes do not excuse a consistently rehashed non-LF artifact. Ordinary hash mismatch, exact inventory, import closure, secret screening and safe CLI errors remain enforced. Existing output paths are preserved.

No deployed runtime or browser asset changes were necessary. Node.js 22.16.0, twelve physical files, eleven hashed entries, no runtime dependencies, public routes, health/readiness, exact Treasury accounting/timestamps, NWS attribution, logging and bounded retry/admission behavior remain unchanged. The policy, tests and build tooling are excluded from the artifact.

## Deterministic cross-configuration test design

The regression fixture uses real artifact source inputs and the actual repository policy in isolated temporary Git repositories. Fresh checkouts explicitly select `core.autocrlf=false` and `true` before checkout. An un-attributed text control must remain LF in the former and actually convert to CRLF in the latter, proving that the Linux Git conversion path ran. Both checkouts must retain LF in every protected input, report effective attributes and clean Git status, and produce identical complete twelve-file artifacts, manifests, runtime/package hashes, commit/tree and content digests.

Negative cases cover absent policy, CR injection despite normalized-clean Git status, all source inputs including package metadata, dirty and committed semantic LF changes, rehashed CRLF artifact content, ordinary tampering, excluded files, and incorrect release SHA/digest. In the normalized-clean case, adding only the injected file inside the disposable fixture refreshes Git's index stat information while preserving its exact HEAD LF blob and an empty staged diff; the working bytes demonstrably remain CRLF. This prevents a false assumption that every direct byte injection immediately appears clean. Configuration is confined to disposable repositories/processes; no system/global configuration or protected checkout is changed. These are real Git checkout-conversion tests on Linux, not an independently executed Windows run.

## Validation results

| Check | Actual result |
| --- | --- |
| Toolchain / locked install | Exact Node.js **22.16.0**, npm **11.9.0**, TypeScript **5.9.3**; `npm ci` passed with the same three development packages. No package/lockfile/dependency changes. |
| Full check | `npm run check` passed: TypeScript, public JavaScript syntax and **679/679** backend/domain/security tests; **zero failures, skips or cancellations**, 31.201 seconds. |
| New EOL integration cases | **7/7 passed**, included within 679; accepted 672-case baseline preserved. Fresh true/false conversion, both negative controls, all eleven normalized-clean source injections and all eleven rehashed artifact cases executed. |
| Chromium | **18/18 passed**, 27.672 seconds. Targeted axe found zero violations in tested states; responsive/reflow coverage passed. Native zoom and physical Windows remain unverified. |
| Actual repeated builds | Both precommit artifacts built/inspected successfully and were byte-identical across all twelve files including manifests, **73,344 bytes** each; pinned Node metadata and unchanged Linux digest. |
| Staging/production smoke | Exact Node 22.16.0; staging SIGTERM and production SIGINT passed, health 200, unknown readiness 503, route isolation passed, non-root/read-only execution, bounded shutdown and **zero upstream requests**. |
| Offline gate | The actual dirty precommit artifact returned exit 1 with `STAGING_SOURCE_NOT_CLEAN`. Clean candidates and incorrect SHA/digest, tampering and excluded contents were exercised in the passing integration suite. Fresh real committed-candidate checks follow the local commit and are recorded in the handoff. |
| Git policy / whitespace | Every input has effective `text: set`, `eol: lf`, and actual LF bytes; `git diff --check` passed. |

Commands actually executed with exact Node 22 selected:

```bash
npm ci
npm run check
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v
npm run build:public -- --output dist/public-reader-w2-precommit
npm run inspect:public -- dist/public-reader-w2-precommit
npm run build:public -- --output dist/public-reader-w2-precommit-repro
npm run inspect:public -- dist/public-reader-w2-precommit-repro
npm run smoke:public -- dist/public-reader-w2-precommit
node --experimental-strip-types scripts/check-staging-release.ts --checklist /tmp/dayline-006b-r2-w2-dirty-checklist.json
git diff --check
```

The offline checker command's exit 1 is the expected dirty-candidate rejection, not a failed validation. Both complete precommit directories were independently compared byte-for-byte. An initial targeted test run had one fixture-assumption failure (6/7): direct CRLF injection appeared dirty until the disposable index stat information was refreshed. The fixture now proves unchanged HEAD/index content, retained CRLF bytes and genuinely clean status before testing rejection; the corrected targeted run and full final suite passed without weakening production checks.

The expected experimental Node type-stripping warning was emitted. Linux ran the strict POSIX signal/link cases with zero skipped tests. Existing Windows capability-aware accounting and controlled-close helpers are unchanged; the historical six Windows skips are not counted as passes or claimed as a new run. The approved outer execution path was needed for localhost socket/browser testing, without changing destination policy.

Session evidence includes `/tmp/dayline-006b-r2-w2-install.log`, `...-validation.log`, `...-browser.log`, `...-precommit-artifact.log`, `...-repro.log`, `...-precommit-repro.json`, `...-smoke.log` and `...-dirty-check.log`, with the shared prefix `dayline-006b-r2-w2`. Post-commit `/tmp/dayline-006b-r2-w2-final-evidence.json` records actual clean-build source identities, full file hashes, configuration controls and offline check results. Temporary evidence may not survive replacement; this report preserves the measured precommit outcomes.

## Artifact identity and preservation

The inspected W2 precommit artifact at `dist/public-reader-w2-precommit` truthfully records starting commit `72c9492cac999942f81fe3a191308988568cc583`, tree `b07d1feafdf28db91f9bd4ca60140c4f87849686`, `sourceDirty: true`, Node.js 22.16.0 metadata and twelve files. Its content digest remains **`f2742749da68a8035cdb9780e35586cc6b664d95d60e3091b52e4aa9ef922e29`**. No runtime/package byte changed; this matches the Linux R2 artifact rather than the CRLF Windows artifact. No expected digest is hardcoded into test behavior to make a check pass.

Preserve that development build and all earlier artifacts. After the local commit, build the exact new revision from two fresh temporary checkouts with `core.autocrlf=false` and `true` into `dist/public-reader-w2-clean-lf` and `dist/public-reader-w2-clean-autocrlf`, inspect and compare all files, smoke-test staging and production and run the offline checker with the actual new SHA/digest. The completion handoff and `/tmp/dayline-006b-r2-w2-final-evidence.json` record both clean artifact identities and every runtime/package hash. Manifest provenance changes with the new commit/dirty state; runtime content hashes remain unchanged. The checker must explicitly leave hosted verification and deployment/rollback authority false.

Runtime/package hashes verified in the W2 precommit artifact (expected unchanged in the clean builds):

| Artifact entry | Bytes | SHA-256 |
| --- | ---: | --- |
| `package.json` | 227 | `1fa06b03973f3fc86327959ec45a3bd6d225e0229e221c166e50b8f5f61b8ecb` |
| `public/app.js` | 6399 | `d6e166cdc07c59883d8ea7e45074886a401bb566eb9250a880fae71abffa5a36` |
| `public/index.html` | 8694 | `cf4b126cfae462ef343d04abbd4195a01e5e1897f7e42817a0c9b7e2b5ee29d5` |
| `public/stories.js` | 2482 | `ce30f7b509fa0a82b8084541fe80fa23f6895bf15b47ead9f0f4739eb1f804b4` |
| `public/style.css` | 13794 | `fe9498c652b967f2e5be4cbde92d6d4ccc5872b2e0f8d5f9fcdf8c61f05d298a` |
| `src/cache.ts` | 962 | `d7eddddbdf35de85b97fb4d168a11902671da39a98b8bc32755239e1696da2b6` |
| `src/official-data.ts` | 10533 | `86eeb0b7711905c1885cb74460e0bd0ce10de789e76e58701d2fcbf0cd349fec` |
| `src/public/config.ts` | 4459 | `08e2c68e9d4e3d2118a57b58ee13be280777e3cc744be14e2b7ecc00cccb403f` |
| `src/public/lifecycle.ts` | 2649 | `30a872bcec1ccdfeffc554b639179367c8c031c4e2e150fe64bfae86fb3cd3a3` |
| `src/public/main.ts` | 10009 | `6dda4fa62ade909766e5ee8c1c24231060e5e913f42d1feac78931ac9a60910a` |
| `src/public/reader.ts` | 11216 | `f69c0389ab7d0664de007d99f3c80ca964ed49faa9715040011c2142f70cfac9` |

## Exact changed-file inventory

| File | Purpose |
| --- | --- |
| `.gitattributes` | Explicit LF checkout rules for public artifact inputs and the policy itself. |
| `scripts/build-public.ts` | Reject non-LF source bytes before output creation, without normalization. |
| `scripts/inspect-public.ts` | Shared fixed-error LF guard and independent artifact enforcement. |
| `tests/public-artifact-eol.test.ts` | Isolated Git checkout, provenance, integrity and release regressions. |
| `README.md` | LF contract and Windows reacceptance links. |
| `docs/DEPLOYMENT_RUNBOOK.md` | Effective policy and preserved-checkout Windows procedure. |
| `docs/DL-006B-R2-W2_VALIDATION.md` | This evidence and limitation report. |

## Windows reacceptance and remaining limits

Follow [W2 cross-platform artifact reacceptance](DEPLOYMENT_RUNBOOK.md#w2-cross-platform-artifact-reacceptance) only after a separately authorized handoff. Preserve the owner's original checkout/configuration/artifacts. Use a fresh isolated Windows checkout of the exact reviewed W2 commit and side-by-side Node.js 22.16.0. Record `core.autocrlf` without changing it, verify every input's effective attributes and LF bytes, run locked/type/backend/browser checks with honest pass/skip totals, then build two new artifacts. Inspect/smoke both, compare all hashes and the reviewed digest, verify clean exact-commit/tree provenance and run the offline release checker. Stop on discrepancies rather than normalize files or substitute an expected digest.

Physical Windows execution, native zoom and assistive-technology acceptance remain separate. The owner's historical R2 acceptance remains accepted; Linux simulations do not establish W2 physical acceptance. Actual hosted Treasury/NWS checks need separate live-data authorization and a privately configured compliant contact. There were no hosted/live source requests in W2. Production security, rights, identity/storage, scheduling/publication and operational safeguards remain outstanding.

PR #16 and the hosted Render service were not modified. No GitHub push/PR mutation, merge, history rewrite, tag, release, deployment, hosting/environment/DNS/TLS/billing change, live polling, paid service, real publishing, identity-provider or payment activation occurred. Stop after the local commit for review.
