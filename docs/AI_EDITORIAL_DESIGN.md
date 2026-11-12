# Dayline — Internal AI-assisted editorial design

DL-003C provides a development-only drafting proposal workflow using fictional stored evidence and a deterministic mock provider. It does not make real AI requests, ingest live news, authenticate reviewers or publish articles. No OpenAI adapter, model SDK, API key, billing or public drafting endpoint is supplied.

## Boundaries and stored contracts

The model/provider contract is independent of newsroom review. Requests identify a prompt-template version and carry fixed system instructions separately from an `untrustedData` evidence collection. Structured responses supply draft output and deterministic usage estimates. The only implementation is a mock; a future real adapter requires separate authorization, provider terms, authenticated access and production controls.

An active proposal records:

- Its own ID and review version, and the exact story ID/revision.
- Proposed headline, summary, fact/analysis/uncertainty sections and evidence-linked claims.
- Supporting and contradicting source references and explicit uncertainties.
- Captured source IDs and provider/policy IDs, versions and snapshot digests.
- Model identity/version, prompt-template version, generation time and expiry.
- Advisory language suggestions and usage/estimated-cost metadata.

Proposal content is immutable. A new generation creates a separate proposal; review changes its review version/state rather than rewriting factual content. Schema 4 introduced draft and draft-review collections; current schema 7 also stores editions, schedules and internal identity/session/security-receipt metadata without backfilling historical review authority. Reading schemas 3–6 preserves their retention-review flag; reading schema 1/2 retains the conservative review hold. Migration is in memory until a successful transaction writes the file.

## Eligibility and rights

Generation requires an existing current story revision in `DRAFT` or `NEEDS_REVIEW`, no retention-redacted history and no repository retention-review hold. At most 16 evidence entries may be selected. Evidence must already be marked `VERIFIED`, identify supporting sources, and reference eligible managed metadata. Supporting and contradicting references are checked against stored sources and their exact active policy snapshots. An evidence verification flag remains a prior local assertion; the drafting service does not determine truth or change `Source.verification`. Contradicting sources are not silently dropped because their own verification flag is disputed or unverified; they must still meet the managed rights/eligibility checks.

The captured policy must separately grant licensed excerpts, internal analysis and AI summarization. Discovery metadata or public redistribution permission alone is insufficient. Only the explicitly fictional `fictional-ai-editorial-v1` policy grants the required permissions; no real news provider is approved. Expired, revoked, superseded, unknown, quarantined or retention-ineligible records cannot authorize drafting. Raw provider titles, full text and images remain outside the ingestion contract.

## Strict evidence-grounded output

Both source text and model output are untrusted. Deterministic validation enforces the structured schema and rejects extra fields, malformed records and unmatched evidence/source IDs. Every selected evidence entry must appear exactly once as a factual claim with its exact supporting and contradicting source references, rather than inventing, omitting or paraphrasing facts. All nonempty supplied uncertainties must remain present.

The headline must be an exact evidence claim; the summary joins accepted claims. FACT sections reproduce evidence claims, UNCERTAINTY sections preserve the supplied uncertainty, and ANALYSIS is limited to a fixed sentence requiring human review. Quotations are disabled. Changed numbers or dates and fabricated citations cannot pass this extractive contract. These checks prevent unsupported output changes; they do not independently verify an original statistic, date, allegation or source assertion.

This conservative contract intentionally does not provide general article synthesis or open-ended analysis. A successful mock output is a proposal requiring review, not a verified report. It cannot update sources, approve a story or publish content.

## Advisory editorial analysis

The review helper returns named suggestions for these patterns:

| Suggestion | Review concern |
| --- | --- |
| `LOADED_LANGUAGE` | Loaded or inflammatory phrasing. |
| `UNSUPPORTED_CAUSALITY` | Causal wording that needs explicit evidence review. |
| `UNATTRIBUTED_ALLEGATION` | An allegation without clear attribution. |
| `MISLEADING_CERTAINTY` | Certainty beyond the evidence presented. |
| `MISSING_UNCERTAINTY` | Material supplied uncertainty omitted from the proposal. |
| `UNSUPPORTED_NUMBERS` | Numerical wording without matching grounded evidence. |
| `OPINION_AS_FACT` | Opinion presented as an established fact. |
| `MISSING_COUNTEREVIDENCE` | Stored contrary references omitted. |
| `HEADLINE_BODY_CONFLICT` | Headline/body wording requiring consistency review. |

These are transparent pattern suggestions, not automatic truth judgments or a neutrality score. Their absence proves neither accuracy nor neutrality. Review does not require equal weight for every position or suppression of well-supported findings because they are controversial. The strict output validator also rejects unsupported changes independently of the advisory checks.

## Proposal review states

| Current state | Allowed next states |
| --- | --- |
| `GENERATED` | `NEEDS_REVIEW`, `REJECTED`, `ON_HOLD` |
| `NEEDS_REVIEW` | `REVISION_REQUESTED`, `READY_FOR_APPROVAL`, `REJECTED`, `ON_HOLD` |
| `REVISION_REQUESTED` | `NEEDS_REVIEW`, `REJECTED`, `ON_HOLD` |
| `ON_HOLD` | `NEEDS_REVIEW`, `REJECTED` |
| `READY_FOR_APPROVAL` | `REVISION_REQUESTED`, `ON_HOLD`, `REJECTED` |
| `REJECTED` | None; terminal. |
| `INVALIDATED` | None; terminal. |

Invalidation is performed by lifecycle checks, not a reviewer privilege. Review requires the expected proposal version and revalidates its captured story revision against the current story; stale submissions fail. Each accepted decision records the prior/next states and versions, time and an actor assertion explicitly marked `unauthenticated: true`, with a procedural audit event. Actor labels must match the restricted identifier format; that validation is not a verified identity or authorization grant. Denied review attempts also receive a generic procedural audit event.

`READY_FOR_APPROVAL` does not map to a newsroom `APPROVED` or `PUBLISHED` transition. Existing revision-specific story approval and source/evidence rules still apply. Production approval still requires real verified reviewer identities, reviewed production permissions and operational safeguards beyond the synthetic foundation below.

DL-005A provides a separate opt-in facade for current synthetic-session authentication and role checks. Nonfinal draft review and `DRAFT_READY` use distinct permissions, with revision-bound authenticated receipts separate from the existing `unauthenticated: true` review records. Direct fixture paths and prior actor labels remain unauthenticated. This layer does not establish real reviewer identity, model truth or publication authority; see [security design](SECURITY_DESIGN.md).

## Invalidation and retention

Story edits or transitions invalidate existing proposals in their repository transaction. `EditorialService.snapshot()` and review operations also transact to recheck the current story revision, policy snapshots, source eligibility and expiry; unlike a plain repository read, the service snapshot may persist invalidation. There is no background expiration scheduler. Generated content expires no later than applicable source-retention and policy deadlines. A retention-review hold, redacted story or ineligible/quarantined source blocks generation and proposal use. Generation revalidates story/evidence/policies before committing the model result; model execution occurs outside the repository lock. Commit and review checks use a fresh timestamp after acquiring that lock, and generation rechecks cancellation there, so waiting for a lock cannot authorize an expired proposal commit/review or ignore cancellation received during the wait.

An invalidated record retains only its proposal ID, `INVALIDATED` state, invalidation time and generic reason. Generated output, source/story links and policy references are removed. Related review records retain procedural versions/states and a safe timestamp, with story revision cleared and the actor assertion replaced by `[invalidated]`. Retention cleanup invokes this scrubbing as part of its existing local removal/redaction transaction. It does not create an independent lifetime for generated text or review identities. Historical approval states do not permit restoration of scrubbed content.

The [development retention policy](RETENTION_POLICY.md) still governs repository-wide holds and finite identifying audit retention. Local JSON replacement is logical removal, not secure erasure across filesystems, backups, snapshots, external copies or unlinked prose.

## Injection and failure handling

Fixed editorial instructions are not assembled from evidence text. Source material stays in a separate untrusted request field, and output citations must match stored evidence. The implementation does not execute commands from source text or permit model output to alter rights or verification settings. A heuristic screen rejects recognized attempts to override instructions; strict schema/evidence checks provide additional boundaries. The screen can have false positives and miss novel wording. These controls do not establish complete prompt-injection immunity.

Provider errors are mapped to sanitized codes. Raw prompts, rejected model output, credentials and provider error bodies are not persisted as failure evidence. Only validated, rights-eligible generated output can become a stored proposal. No real internal secrets or provider credentials are supplied to the mock.

## Local resource and cost controls

The runner limits UTF-8 JSON request/output bytes, attempts, concurrent operations, generation submissions and estimated cost. A run is the lifetime of one `ModelRunner` instance; failed generation submissions consume their proposal slot once valid input is accepted.

| Limit | Default | Hard configuration ceiling |
| --- | --- | --- |
| Input bytes / output bytes | 16,384 each | 1,048,576 each |
| Generation submissions | 5 | 100 |
| Attempts per submission | 2 | 3 |
| Concurrent provider operations | 1 | 4 |
| Timeout per attempt | 1,000 ms | 10,000 ms |
| Estimated cost reservation per run | 1,000 micros | 1,000,000 micros |
| Estimated reservation per attempt | 10 micros | 1,000,000 micros |

Timeout and caller cancellation fail closed. Only explicit sanitized `TRANSIENT` errors are retried; malformed output, timeout, cancellation and disabled-provider errors are not. Each provider attempt reserves its configured estimate before execution, including retries; failure does not refund that reservation. Returned usage must fit the attempt estimate and byte-related bounds. The mock reports deterministic estimates from serialized bytes and an estimated cost of one micro; these values are not tokenization or billing records.

Cancellation sends an abort signal; it cannot forcibly terminate arbitrary provider code. A provider that ignores cancellation keeps its active slot until it settles, preventing timed-out work from accumulating through new requests. Creating another runner resets its local counters.

These are in-process development limits. They do not enforce cross-process quotas, authenticated account limits, provider invoices or a production spend ceiling. A future paid adapter needs explicit approval, durable quotas, rate limits, monitoring and operational controls before any request. No billing or paid AI traffic is active here.

## Validation and remaining work

```bash
npm ci
npm run check
npm run typecheck
python -m unittest discover -s tests/browser -v
git diff --check
```

`npm run check` includes TypeScript validation, public-script syntax checks and the deterministic backend/domain suite. Browser checks require Python Playwright and Chromium; see README for `CHROMIUM_PATH`. Final local validation on Node 22.16.0 passed TypeScript and 204/204 backend/domain tests with zero failures, cancellations or skips; Chromium passed 7/7. `npm ci` passed without added dependencies. The [DL-003C validation report](DL-003C_VALIDATION.md) records the complete evidence. Mock tests do not establish real-model accuracy, prompt-injection immunity, production licensing or paid-provider compatibility.

Remaining production work includes real-provider contracts and model terms, authenticated identity/authorization, legal review of generated-content retention, durable transactional storage, security review, monitoring, independently assessed editorial policy and explicit public-publication approval. No real model/news requests, public deployment, subscriptions or unattended publication are activated by this milestone.
