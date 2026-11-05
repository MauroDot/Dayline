# DL-003B-R2 local validation and findings

Workspace: `/workspace/Dayline-dl003b-r2`

Branch: `feature/dl-003b-r2-retention-integrity`

Starting commit: `2710ca25062b651950b66488ab48fc7550355dfc`

## Confirmed behavior before corrections

Investigations ran against the unchanged R1 implementation using fictional temporary repositories before source edits. No provider requests were made.

- R1's registered audit-marker policy blocked repeated ingestion while its marker was present, including attempts under the alternate approved fictional policy.
- An UNKNOWN policy snapshot was deleted with no permitted residual identity. Replaying refreshed metadata for the same canonical URL under either approved policy then restored one source. R1 had no genuinely approved no-audit policy; the initial false-audit reproduction deliberately used an UNKNOWN seeded snapshot. R2 adds a legitimate fictional no-audit policy to test that requirement directly.
- Expired, revoked and superseded policy contexts were already denied. These checks were preserved.
- A source-linked history reproduction retained 18 story revisions and three approvals after metadata cleanup; copied prose, claims, source references and actor assertions remained in repository reads and on disk. Missing-source publication was already blocked, but correction-to-draft could append copied content. These are distinct from a new-publication bypass.
- Review also found identifying rejected-attempt audit hashes without retained source records or a governing cleanup deadline. A known source-to-story audit link could outlive explicit revision references.

## Corrections and safety boundaries

Any applied metadata deletion now leaves only a non-identifying repository retention-review hold as the durable replay safeguard. There is no application operation to clear it. The hold blocks all provider and legacy ingress, provenance resolution, source eligibility and new approval/publication. It remains after finite permitted markers expire, avoiding an unlimited source-identifying blocklist. This is an explicit development block pending external authorization, not a complete cross-system deletion solution.

Captured policies include finite audit retention terms. One-day permitted deletion markers and linked identifying audit entries expire; no-audit or unknown policies retain no source identity. Rejected and duplicate outcomes retain counts and non-identifying audit events. Cleanup scrubs legacy orphan subject logs and follows both evidence/source references and recorded source-to-story audit links.

Every affected story version is replaced by an explicitly redacted procedural stub under a fresh non-source-derived identity. Version/status history and the existence of approvals remain, with reviewer assertions, prose, evidence and source identities removed. Related audits are minimized. Unrelated, still-governed history remains intact. Redacted records cannot be edited, transitioned, approved or published. Identified orphan references from older cleanup are handled even when no source metadata candidate remains.

Schemas 1 and 2 migrate in memory to schema 3 with the review hold set, since earlier deletion evidence cannot be proved complete. Reads do not rewrite repository bytes. Missing legacy audit terms do not receive new permissions. Cleanup, redaction and hold changes commit atomically under the existing repository lock; injected failures preserve the original bytes and permit safe retry.

## Executed validation

- `npm ci`: passed; no dependency additions.
- Unmodified R1 baseline: 100 tests passed before corrections.
- Final Node 22.16.0 `npm run check`: 134 tests passed, zero failed, cancelled or skipped. TypeScript and browser JavaScript syntax checks passed.
- `PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v`: all seven Chromium tests passed.
- Final `git diff --check`: passed.
- Fictional ingestion dry-run: processed 1, duplicate 1, quarantined 1, rejected 0, failed 0.
- Fictional retention dry-run: candidates 2, deleted 0, review hold false. Temporary apply mode: candidates 2, deleted 2, review hold true.
- Exact hashes/status comparison: all seven protected worktrees matched their preflight states, including the original checkout's 15 staged files.

The prior baseline test count is preserved; existing expectations now require finite marker expiry and explicit redaction instead of retaining source-linked prose. The unrelated-audit fixture now includes a still-governed source, preserving its original intent rather than treating an orphan identity as authorized.

## Remaining limitations

This prototype is development-only and fictional-only. A fresh independent repository, an external copy, or deliberate file modification can discard the local hold; external authenticated authorization and restoration/deletion coordination are not implemented. Prose with no recorded source or audit linkage cannot reliably be classified. Human legal review must determine conflicting requirements for derived content, reviewer information and correction history before production. No secure erasure, backup/log deletion, tamper-proof auditing, production database, real-provider licensing or public publishing is claimed. No GitHub push, PR modification, merge, deployment, real ingestion, paid service or news publication was performed.

## Changed-file inventory

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/DL-003B-R2_VALIDATION.md`
- `docs/NEWS_PROVIDER_EVALUATION.md`
- `docs/RETENTION_POLICY.md`
- `docs/ROADMAP.md`
- `src/ingestion/cleanup-runner.ts`
- `src/ingestion/eligibility.ts`
- `src/ingestion/history.ts`
- `src/ingestion/ingest.ts`
- `src/ingestion/policies.ts`
- `src/ingestion/records.ts`
- `src/ingestion/retention.ts`
- `src/newsroom/model.ts`
- `src/newsroom/service.ts`
- `src/newsroom/store.ts`
- `tests/audit-retention.test.ts`
- `tests/history-retention.test.ts`
- `tests/ingestion-integrity.test.ts`
- `tests/policies.test.ts`
- `tests/reingestion-retention.test.ts`
- `tests/repository-migration.test.ts`
- `tests/retention.test.ts`
