# DL-003C local validation

Workspace: `/workspace/Dayline-dl003c`

Branch: `feature/dl-003c-ai-editorial-workflow`

Starting commit: `ad9bb348efc6063383eed503a0d19d293c8ae94c`

## Implemented boundary

Only a deterministic offline mock is implemented. The provider interface separates fixed system instructions from untrusted evidence data and carries model/prompt versions, usage and estimated cost. No OpenAI SDK, API key, real AI request, live ingestion, public endpoint or publication action was introduced.

The draft service requires a current DRAFT/NEEDS_REVIEW story, verified evidence assertions with identifiable supporting sources, active exact policy snapshots and eligible managed fictional sources. The new fictional AI test policy explicitly permits excerpts, internal analysis and AI summarization; discovery or redistribution alone remains insufficient. Source verification and newsroom approval records are not changed by generation or review.

Validation treats mock/model output as untrusted. Every factual claim, citation, counterreference, headline and uncertainty must match the selected evidence. Narrative generation is deliberately extractive: factual sections copy claims, the summary joins them, and analysis is limited to a fixed human-review statement. Quotations and instruction-like source content are rejected. Unsupported numerical/date changes or invented citations fail closed. This proves structural grounding, not the truth of a supplied claim or complete prompt-injection immunity.

Nine advisory flag types cover loaded wording, unsupported causality, allegations, certainty, uncertainty, numbers, opinion, counterevidence and headline/body mismatch. Flags do not decide truth, grant rights or require equal weight for every position.

Proposal review states are distinct from story approval: GENERATED, NEEDS_REVIEW, REVISION_REQUESTED, READY_FOR_APPROVAL, ON_HOLD, REJECTED and INVALIDATED. Accepted reviews require an exact proposal version and current story revision; actor labels are explicitly unauthenticated. Proposal content is immutable; a new generation is a separate proposal. No review state authorizes publication or applies text to the newsroom story.

## Rights, retention and concurrency

Proposals capture story revision, source IDs, exact policy digests and the most restrictive source/policy deadline. Story changes, expired/revoked rights, quarantine, redaction or the retention-review hold invalidate proposals. Invalidation removes their payload, source/story linkages and linked reviewer assertions, leaving only minimized procedural markers. Repository cleanup and newsroom edits/transitions invoke this lifecycle; service reads/reviews reconcile it as well. Raw prompts and rejected model responses are not persisted.

Model execution occurs outside the JSON repository lock. Context, rights, cancellation and time are checked after lock acquisition before commit/review/read. A deterministic test reproduced a pre-lock clock race during implementation; four new regressions confirm expiration and cancellation cannot commit an active proposal or ready review while waiting for the lock.

Limits cover request/output bytes, proposals per runner, concurrency, attempts, cancellation and timeout, plus conservative permanent cost reservations per started attempt. Ignored cancellation retains the provider's active slot until the real promise settles. Usage and cost are fictional mock estimates, not vendor metering or billing controls. Counters are per runner instance and are not persistent cross-process quotas.

Schema 4 adds draft/review collections. Schema-3 reads preserve their prior retention-review flag; schemas 1/2 remain held for review. Old snapshots receive empty draft collections, never inferred AI permissions; reading does not rewrite files.

## Executed checks

- `npm ci`: passed with existing lockfile; no dependencies added.
- Node 22.16.0 `npm run check`: TypeScript, JavaScript syntax, and 204 tests passed; zero failed, cancelled or skipped. This preserves 134 regression tests and adds 70 targeted editorial/provider/lifecycle/migration/lock-boundary tests.
- `PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v`: all seven Chromium regressions passed, including server startup and existing UI/data states.
- `git diff --check`: passed.
- Protected-worktree comparison: all eight previous worktrees matched exact preflight HEADs, branches, statuses, staged/unstaged diff hashes and tracked-file hashes. The original 15 staged files are unchanged.

All new generation uses explicitly fictional evidence, local temporary repositories and mocked responses. No real network model calls, paid services or news publication were executed.

## Remaining production blockers

Authenticated identities, authorization, legally approved real-provider AI rights, production transactions/auditing, durable rate/cost quotas, vendor model evaluation, secure prompt handling and cross-system retention are not implemented. Pattern matching may miss injection or overflag benign text; extractive consistency is not independent fact checking. No complete neutrality, injection immunity, secure erasure or public production readiness claim is made. The R2 retention-review hold has no application clearance path.

## Changed-file inventory

- `README.md`
- `docs/AI_EDITORIAL_DESIGN.md`
- `docs/ARCHITECTURE.md`
- `docs/DL-003C_VALIDATION.md`
- `docs/RETENTION_POLICY.md`
- `docs/ROADMAP.md`
- `fixtures/editorial-fiction.ts`
- `src/editorial/lifecycle.ts`
- `src/editorial/provider.ts`
- `src/editorial/service.ts`
- `src/editorial/types.ts`
- `src/editorial/validation.ts`
- `src/ingestion/policies.ts`
- `src/ingestion/retention.ts`
- `src/newsroom/model.ts`
- `src/newsroom/service.ts`
- `src/newsroom/store.ts`
- `tests/editorial-lifecycle.test.ts`
- `tests/editorial-lock-boundary.test.ts`
- `tests/editorial-provider.test.ts`
- `tests/editorial-service.test.ts`
- `tests/editorial-validation.test.ts`
- `tests/repository-migration.test.ts`
