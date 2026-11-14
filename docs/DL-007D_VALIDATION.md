# DL-007D editorial workflow integration validation

Local implementation and validation dated **2026-11-13 (America/Chicago)**. Authorization covers one isolated worktree, local validation and one local commit. No GitHub write, PR, merge, Render operation, deployment, live provider or production activation is included.

## Baseline and preservation

- Repository/origin: `MauroDot/Dayline`, `https://github.com/MauroDot/Dayline.git`.
- Workspace: `/workspace/Dayline-dl007d`.
- Branch: `feature/dl-007d-editorial-workflow-integration`.
- Exact starting commit and verified remote main: `5b3c958ca09bf2966b1a528f394f323f50614290`.
- Starting tree: `83ebc6cf21d446127b45205dc5761d8f059b4dca`; clean index/worktree before edits.
- Exact Node.js **22.16.0**, npm **11.9.0**, TypeScript **5.9.3**, pinned `@types/node` **22.19.15**. `npm ci` installed the same three development packages; no dependency or lockfile change.

The actual protected count was **nineteen**, not eighteen. Every pre-existing worktree was recorded in `/tmp/dayline-007d-protected-baseline.json` and compared with the previous protection record, including the completed DL-007C worktree. Branches, HEADs, porcelain status, binary staged/unstaged diff hashes, tracked inventory and tracked file hashes matched. The original `/workspace/Dayline` retains its fifteen staged files. Existing files, branches, indexes and artifacts are preserved. The new branch/destination were unused; no reset, stash, clean, amend, rebase or force operation was used.

Only read-only remote main inspection and the required baseline fetch occurred. No remote write, PR operation, merge or hosting request occurred. The local final SHA is recorded in the completion handoff and `git log -1 --format=%H -- docs/DL-007D_VALIDATION.md`. This report belongs to that commit; clean artifact manifests independently record its exact SHA/tree without a self-referential hash here.

## Integrated workflow and existing authority

The path is **discovery/quarantine → authenticated inspection → provenance recommendation → independent confirmation → exact eligible source selection → human-authored story preparation (INGESTED) → separate editorial review/approval → edition assembly (ASSEMBLING)**. Readiness remains a separate operation; no stage publishes or activates scheduling. Recommendations alone cannot establish source eligibility.

No permission, role matrix or ownership rule changes. The handoff expresses its authority using existing permissions:

| Stage | Required authority and exact assignments |
| --- | --- |
| Source inspection/selection | Current `SOURCE_READ` role and SOURCE assignment for every selected source and complete proof/origin graph. |
| Provenance review/confirmation | Existing `SOURCE_REVIEW`/`SOURCE_RESOLVE`, read graph and independent authenticated reviewer identity. |
| Story preparation | `SOURCE_READ` graph plus `STORY_CREATE` on the exact preassigned new story ID. |
| Bound story editing/review/approval | Existing `STORY_EDIT`/`STORY_REVIEW`/`STORY_APPROVE` on that story/current version, plus complete source reads. |
| Bound edition assembly | `EDITION_ASSEMBLE` on the exact canonical date/timezone allocation and placed stories/current versions, plus complete source reads. |
| Bound edition review/readiness | Existing `EDITION_REVIEW`/`EDITION_READY` on the edition and contained stories, plus complete source reads. |

EDITOR/MANAGING_EDITOR can satisfy the read/create role conjunction but still need every exact grant. REPORTER and ADMINISTRATOR receive no new source/creation/approval rights; explicit multiple roles retain the existing union. Source selection or successful creation confers no later story/edition ownership or permission.

## Handoff and continuity contract

`AuthenticatedSourceHandoff.inspect`/`withSelection` accept 1–8 unique managed source IDs. Authorized selections return only `{id, revision}` with opaque 64-hex source-state tokens. The complete transitive proof/origin graph is capped at 64; authenticated downstream operations also cap their aggregate graph at 64. All selected sources must have current independently confirmed DL-007C RESOLVED provenance, matching retained authenticated proposal/confirmation receipts, active captured licensed-excerpt/internal-analysis/minimal-audit rights and finite retention. Quarantine, dispute, holds, deletion, revoked/superseded/expired grants and inaccessible or invalid proof deny.

Receipt capacity/retention loss fails closed; history labels cannot replace authenticated receipts or silently recreate them. Historical reviewer roles need not remain current. Trusted eligible VERIFIED originals can bootstrap provenance proof without an infinite chain of confirmations. Metadata-only grants cannot be upgraded through this workflow; the fictional integration grant is captured at initial ingestion.

`prepare(credential, {sources, story})` validates exact selections and separately supplied human content. Story fields are id, headline, topic, summary, geography, eventAt, firstSeenAt, updatedAt, clusterId, evidence and sourceIds. Evidence is bounded, unique, explicitly VERIFIED human claims with nonempty support, uncertainty and empty reviewerDecisions. Every selected source must be used, all references must be selected, and duplicate/substituted/contradictory reference sets are rejected. No text, evidence, reviewer assertion, source fact-verification label or approval is generated. VERIFIED human input remains an assertion under the existing model, not independent truth certification; DL-007C provenance confirmation does not turn `Source.verification` into VERIFIED.

The facade reuses **`Newsroom.create` and the existing repository transaction**, producing one INGESTED/version-1 story, ordinary audit and successful STORY_CREATE receipt. It adds a strict optional schema-7 `Story.sourceHandoff` containing trusted preparedAt, selected tokens and complete dependency tokens. There is no second source/story database. Older unbound files remain readable without a manufactured binding. Inputs cannot supply, remove or replace the binding, actor, permission, policy, status/version or trusted timestamps.

Current registered sessions/roles, exact source/story assignments, policy epoch, every source/proof revision, rights, provenance and retention are checked under the writer lock and again at commit after the replacement is prepared. Expiry, revocation, assignment changes, stale/concurrent actions or storage faults leave no partial story or unauthorized success receipt. Only the human content is copied; rights, source timestamps and deletion deadlines remain unchanged.

Bound edits/progression/approval, existing draft contexts and edition placements validate the immutable binding. Authenticated downstream commands additionally recheck current source reads and their original action grants at entry/commit. Relevant source/proof/review changes invalidate old bindings even after a hold is released. A fresh explicitly authorized preparation is required; there is no silent rebind. Edition/draft expiry is capped by the earliest dependency deadline, including undisplayed provenance proof, without adding its identity or attribution to response data.

Existing authenticated legacy creation, editing and downstream progression cannot use DL-007C review-managed sources through an unbound story. Historical unbound fixtures and direct trusted legacy services remain compatible development paths, without retroactive authentication. These are documented production limitations, not alternative production entry points.

## Private transport and retention

Only the existing opt-in development-only loopback listener adds POST `/internal/source-handoff/inspect` with `{sourceIds}` and POST `/internal/source-handoff/prepare` with `{sources, story}`. Current peer/Host/Origin/CORS/header/cookie/bearer restrictions, exact JSON content type and length, 16,384-byte body bound and one-second body deadline remain. Inputs stay in bounded bodies, never URL/query/path selectors. Inspect returns selections; prepare returns only `{id, version, status:"INGESTED"}`. No story text, binding, proof list, private audit, reviewer identity or credential is returned. Fixed 400/401/403/409/503 failures and no-store responses remain.

Final selection/receipt disclosure uses fresh state under the repository lock and synchronous final serialization/authorization/time checks. A mutation may commit before a later response is denied/disconnected; that response does not establish rollback. Trusted authorized tooling must inspect current state before retry, and duplicate story IDs prevent silent reapplication. Already submitted bytes cannot be recalled. There is no new public login, status, ownership, administration or publication endpoint.

Retention redaction follows all historical binding dependencies as well as direct story/evidence references. Missing/orphan proof is included even when no expired metadata candidate or source-linked audit remains. Existing whitelist redaction removes affected prose, original identities, evidence, bindings and fingerprints across every version; existing lifecycle hooks invalidate derived drafts/editions and prune receipts. Global retention holds remain authoritative. Cleanup is explicit logical deletion, not secure erasure, a background deletion service or enforcement across backups/external copies/unlinked prose.

## Exact changed-file inventory

| Files | Purpose |
| --- | --- |
| `src/source-handoff/types.ts`, `src/source-handoff/domain.ts` | Strict selection/human-story/binding types, receipt-backed eligibility, exact fingerprints and bounded continuity/deadline helpers. |
| `src/security/source-handoff.ts` | Composite existing read/create authority, atomic adapter over Newsroom.create, guarded selections and minimal receipt disclosure. |
| `src/security/editorial.ts` | Bound downstream read/action checks, legacy C-source bypass prevention and final authorization/revision/guard checks. |
| `src/security/retention.ts` | Prune STORY receipts when current source bindings cease to be valid. |
| `src/security/http.ts` | Two bounded private POST routes and delegation of source policy epoch for bound existing operations. |
| `src/newsroom/model.ts`, `src/newsroom/store.ts`, `src/newsroom/service.ts` | Optional strict immutable schema-7 binding and domain create/edit/progression continuity. |
| `src/editions/eligibility.ts`, `src/editorial/lifecycle.ts` | Bound eligibility and hidden-proof deadline caps for editions and existing draft contexts. |
| `src/ingestion/history.ts`, `src/ingestion/retention.ts` | Dependency-aware historical/orphan redaction through existing cleanup. |
| `fixtures/editorial-workflow-fiction.ts`, `src/security/editorial-workflow-runner.ts` | Isolated licensed-fictional source, synthetic identities and deterministic integration demonstration. |
| `package.json` | Add only `editorial-workflow:fixture`; dependencies unchanged. |
| `tests/source-handoff-domain.test.ts` | 26 domain/storage/continuity/rights/retention cases. |
| `tests/security-source-handoff.test.ts` | 56 service/permission/evidence/independent-provenance/downstream cases. |
| `tests/security-source-handoff-races.test.ts` | 23 concurrency, commit-time, revocation, serialization and fault cases. |
| `tests/security-source-handoff-http.test.ts` | 27 actual private HTTP cases, including separate approval/assembly and no implicit ownership. |
| `tests/editorial-workflow-fixture.test.ts` | 8 deterministic fixture, network-blocking subprocess and cleanup cases. |
| `tests/editorial-workflow-continuity.test.ts` | 4 authenticated whole-flow, orphan-proof, hidden-proof TTL and post-expiry approval regressions. |
| `tests/source-access-isolation.test.ts` | Extend both existing actual public-artifact/runtime tests with handoff route/module isolation. |
| `README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY_DESIGN.md`, `docs/RETENTION_POLICY.md`, `docs/ROADMAP.md`, `docs/EDITORIAL_WORKFLOW_DESIGN.md`, `docs/DL-007D_VALIDATION.md` | Contracts, permissions, limits, executed evidence and pending acceptance. |

Exactly **30 files** change. Twenty-nine existing boundary files match their baseline bytes, including public runtime/assets, official-data/cache modules, policy registry, underlying resolver, permission matrix/resources, LF rules, CI and artifact tooling. Package.json differs only by the private fixture script. No dependency, lockfile, public route, design, provider grant or deployment configuration changed.

## Executed validation

| Check | Actual result |
| --- | --- |
| Locked installation and versions | PASS, exact versions above; same three pinned development packages. |
| Full final check | `npm run check` passed strict TypeScript, four browser JS syntax checks and **1,189/1,189** backend/domain/security tests, **zero failures/skips/cancellations**, 59.957 seconds. Includes all 1,045 baseline tests plus 144 new cases. |
| Consolidated targeted run | **146/146** passed, zero failures/skips/cancellations, 27.510 seconds: all 144 new cases plus the two expanded existing isolation tests. This overlaps the full suite. |
| Chromium | **27/27** passed, zero failures/skips, 44.633 seconds; existing responsive/keyboard/reflow/targeted axe regressions passed. |
| Deterministic actual CLI | PASS; output below. Real two-process tests verify portable encoded-filename preload execution, absent network probe, output equality and temporary-state cleanup. |
| Artifact builds/inspection | Two precommit builds inspected; all twelve files byte-identical, 73,344 bytes each, eleven runtime/package hashes equal retained clean DL-007C. |
| Staging/production smoke | PASS with exact Node22, non-root/read-only artifact, health 200, initial unknown readiness 503, route isolation and bounded SIGTERM/SIGINT shutdown; zero upstream requests. |
| Existing source-server boot | Health, homepage and stylesheet each 200 on loopback; shutdown passed; no upstream requests. |
| LF/whitespace/scope | PASS; all changed files LF, common secret-pattern scan zero; no generated artifacts/unrelated files or dependency changes in the reviewed scope. |
| Protection | Nineteen protected worktrees match saved branch/HEAD/status/diff/inventory/file bytes; original fifteen staged files retained. Rechecked before commit and at final handoff. |

Representative commands executed with exact Node22 selected on PATH:

```bash
npm ci
npm run typecheck
npm run check
node --experimental-strip-types --test tests/source-handoff-domain.test.ts tests/security-source-handoff.test.ts tests/security-source-handoff-races.test.ts tests/security-source-handoff-http.test.ts tests/editorial-workflow-fixture.test.ts tests/editorial-workflow-continuity.test.ts tests/source-access-isolation.test.ts
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v
npm run editorial-workflow:fixture
npm run build:public
npm run build:public -- --output dist/public-reader-repro
npm run inspect:public
npm run inspect:public -- dist/public-reader-repro
npm run smoke:public
git diff --check
```

All source, identity, security and negative-path evidence is fictional/offline with controlled clocks, deterministic doubles and isolated repositories/listeners. Coverage includes exact source/proof/story/edition grants, all role/current credential states, missing independent receipts, unverified/inaccessible syndicated origins, duplicate/substituted sources, explicit human evidence, recommendation-only denial, concurrent changes and lock waits, commit-time expiry/revocation/policy epochs, rollback, downstream stale-state rejection, orphan/expired-content redaction and public isolation. Failed operations create no unauthorized success or partial story; established retention pruning may remove previously invalid receipts.

Independent review found and verified a bound additional-guard return-contract correction; async/non-void guards fail closed. New harness issues involving lock-release timing, JSON property order and a TypeScript helper inference were corrected while retaining substantive assertions. No existing test was weakened, removed or skipped. Expected Node experimental type-stripping warnings remain. Complete socket/subprocess/browser tests used the approved operational outer executor where the inner sandbox restricts localhost/Node children, preserving proxy trust and network policy.

## Actual fictional demonstration output

```json
{"fictional":true,"developmentOnly":true,"asOf":"2026-06-01T12:00:00.000Z","discovery":{"quarantined":true,"authenticatedInspection":"UNREVIEWED"},"provenance":{"proposed":"PROPOSED","proposalPreparation":{"denied":true,"code":"DOMAIN_REJECTED"},"selfConfirmation":{"denied":true,"code":"PERMISSION_DENIED"},"independentConfirmation":"RESOLVED"},"storyPreparation":{"status":"INGESTED","suppliedHumanContentPreserved":true,"automaticallyApproved":false},"editorialReview":{"approvalRequiredSeparateAction":true,"statusAfterExplicitApproval":"APPROVED"},"edition":{"status":"ASSEMBLING","ready":false,"published":false},"disputedSource":{"status":"DISPUTED","preparation":{"denied":true,"code":"DOMAIN_REJECTED"}},"substitution":{"denied":true,"code":"PERMISSION_DENIED"},"revokedAuthor":{"denied":true,"code":"SESSION_REVOKED"},"expiredPreparation":{"denied":true,"code":"DOMAIN_REJECTED"},"rightsAndRetentionUnchanged":true,"productionAuthority":{"publicPublication":false,"schedulingActivated":false}}
```

The fixture uses a labeled historical UTC clock and synthetic identities; it is not live-news, current-rights or actual-fact evidence. Temporary session logs under `/tmp/dayline-007d-` include `check-final.log`, `targeted-final.log`, `browser.log`, `fixture.log`, `artifacts.log`, `repro-evidence.json`, `smoke-precommit.log`, `startup.json` and agent-targeted logs. They may not survive environment replacement; this report preserves measured precommit results and reproducible commands.

## Clean artifact handoff and pending acceptance

Required unchanged public content digest:

```text
f2742749da68a8035cdb9780e35586cc6b664d95d60e3091b52e4aa9ef922e29
```

Precommit artifacts truthfully identify the starting commit/tree and sourceDirty:true. After the local commit, fresh `dist/public-reader-committed` and `dist/public-reader-committed-repro` builds must be inspected/compared with exact final SHA/tree and sourceDirty:false. Repeat staging/production smoke and offline `check:staging-release` against both. The final completion handoff and `/tmp/dayline-007d-final-evidence.json` record actual clean manifests, unchanged eleven hashes/digest, byte reproducibility, smoke and offline outcomes. Existing artifacts are not overwritten.

Offline checklist values use the known local baseline as an operator-supplied previous identity and autoDeploy:false solely for local validation. They do not contact Render, verify its settings/previous hosted version, establish live acceptance, authorize deployment or permit automatic rollback. Hosted/settings verification and deployment authority remain false; separate manual authorization is required.

This Linux execution does not establish Windows physical acceptance, native 200%/400% zoom, assistive-technology behavior, formal accessibility certification or live Treasury/NWS acceptance. Windows must record its actual outcomes/capability skips separately; official live checks need compliant identifying configuration and separate execution. Homepage and official-data code remain unchanged.

Production remains blocked on real identity trust/bootstrap/keys, reviewed object/tenant assignments, exclusive authenticated entry points, durable transactions, operational clocks/audit/retention, provider licensing and independent security review. Trusted raw repository/legacy services/files, malicious composition, external/distributed identity changes and multi-host writers remain outside these local guards. Cleanup cannot erase backups/external copies/unlinked prose. Historical Foundation development acceptance is not reversed by these production requirements.

No push, PR, merge, Render/hosting/billing change, deployment, live news ingestion, real identity activation, paid AI/audio, unattended scheduling, payment or public publication occurred. Stop after the local commit and clean handoff; GitHub promotion requires separate authorization.
