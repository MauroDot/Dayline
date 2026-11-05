# Dayline — Initial Architecture Proposal

Status: proposal, to be validated as part of Foundation 001.

## Suggested stack
- TypeScript web application, responsive accessible UI and progressive web app features.
- Server-side API and scheduled workers; no API secrets exposed to browsers.
- Postgres for source metadata, story evidence, editions, corrections, reader settings and entitlements.
- Object storage/CDN for pre-generated edition audio, artwork with verified rights, and approved media.
- Job queue with retries, idempotency keys, rate limits, audit events, and dead-letter handling.
- Stripe Checkout/Billing webhooks with server-verified entitlement changes.
- OpenAI speech integration via a narrowly scoped server adapter; pin only currently supported models after verification.

## Proposed pipeline
Approved/rights-cleared source ingestion -> deduplication and provenance -> evidence records -> AI draft -> verification and editorial holds -> approved edition snapshot -> web publication -> optional audio rendering -> cached audio delivery.

The edition script must be versioned and approved before any narrated asset is generated. Corrections must invalidate or replace affected narrated versions. No client-side key distribution and no per-play speech regeneration by default.

## Data integration contracts
- Treasury Debt to the Penny: report as-of date, total public debt outstanding, debt held by public, intragovernmental holdings; verify component arithmetic.
- NWS: forecast and observation as distinct datasets, station/source timestamp, geolocation selection and caching; alerts are a separate safety-sensitive stream.
- Markets: licensed display integration; do not scrape, rebroadcast, or imply real-time rights.
- News: licensed inputs and rights-aware original summaries, with explicit attribution and deep links.

Each panel must distinguish fetched_at from source_published_at / observation_time. Preserve last valid cache with stale indicators instead of fabricating new values.

## Threat and cost controls
- Environment-based secrets; least-privilege credentials.
- Request authentication, rate limiting, bot mitigation, data validation and output escaping.
- Subscription entitlements are granted only after verified Stripe server events.
- Cached shared speech assets for each approved edition/voice combination.
- User-requested individual-article audio requires per-account quotas and cost controls.
- API budget alerts plus application-enforced caps; never rely solely on budget notifications as a hard stop.
- Comprehensive logging without leaking secrets or unnecessary user data.

## Foundational verification
- Unit tests for formatting, stale-state rules, accounting invariants and tier entitlements.
- Integration tests with mocked NWS, Treasury, voice, and Stripe.
- Browser tests for mobile navigation, keyboard access, citation links, transcript fallback, and no cross-user account leakage.
- Explicit physical acceptance before merging.

## Foundation implementation notes

Treasury amounts are validated as decimal cents and reconciled with a five-cent tolerance using integer arithmetic. Official requests use an eight-second per-attempt timeout and at most three attempts for network failures, 429 and 5xx responses. NWS requires an identifying User-Agent with contact email. Process-local caches expose retrieval timestamps and stale flags; they do not survive restarts or coordinate across instances. No source failure generates substitute measurements.

## DL-003A internal newsroom

`src/newsroom` provides an internal domain service and a local JSON repository; it is not attached to HTTP or the homepage. Fixtures describe imaginary events only. Sources retain canonical URL, rights metadata, verification and original-report identity; tracking parameters and fragments are removed for duplicate detection. Syndicated copies require an existing non-syndicated original and share its independence identity. The count depends on accurate classification and does not prove editorial independence. Headline similarity returns candidates for human review and never merges stories.

The service permits INGESTED → CLUSTERED → DRAFT → NEEDS_REVIEW → APPROVED → PUBLISHED, with explicit hold and rejection transitions and PUBLISHED → CORRECTION_REQUIRED → DRAFT for corrections. Rejected stories cannot silently resume. Approval requires supported, verified claims and records a reviewer label and exact revision; changing an approved story returns it to draft. Ordinary editorial changes append a revision and audit event. Claim verification requires at least one associated supporting source; reviewers remain responsible for assessing source trust and contradictions. Retention-redacted stories cannot be edited or transitioned, and a repository retention-review hold blocks new approval/publication.

The JSON repository serializes cooperating single-host writers with an exclusive lock directory and replaces a synced temporary file via rename. Snapshots are copies. Retention cleanup explicitly replaces affected revisions and approval/audit details with minimized procedural stubs; complete history is not immutable. This is not tamper-proof storage: trusted code or filesystem access can rewrite files; there is no authenticated identity, authorization, inter-host locking, directory fsync guarantee, transactional database, automatic stale-lock recovery or production audit protection. After a crash, inspect any lock or temporary file before manual recovery. Reviewer strings are assertions, not secure identities. Internal status transitions do not publish articles to readers. Production authorization and unattended publication remain blocked until authenticated identity, permissions, durable transactional storage and operational safeguards are separately implemented and reviewed.

## DL-003B provider boundary

`src/ingestion` separates provider request limits and metadata from newsroom records. GNews uses its documented v4 search response shape, is disabled unless explicitly enabled with a server-side key, and has bounded request size, pages, retries and timeouts. Its normalizer discards titles, descriptions, full text and images and marks provenance unknown. No live-provider runner exists, and the ingestion registry denies GNews regardless of adapter configuration. Never log the credential-bearing request URL.

### DL-003B-R1 policy and provenance controls

`ingestArticles` receives a `JsonRepository`, provider articles and `{ providerId, policyId }`; caller-provided policies and permission overrides are rejected. The private, frozen registry contains only `fictional-fixture` policies. Resolution requires an approved, complete policy with an evidence reference, version, effective date and expiry. Missing, unapproved, expired, revoked, superseded or mismatched policies deny ingestion. No real provider has an approved policy. Excerpts, full text and media are never persisted by this integration, and fixture permission fields authorize no real analysis, redistribution or AI service.

Every retained item captures the exact policy snapshot, retention time and deletion deadline. Retention is measured from the earlier of ingestion and original retrieval, capped by policy expiry; delayed ingestion cannot reset it. Revalidation compares the snapshot with its registered version; a later policy cannot expand existing permissions or extend retention. Fixed clocks and repository fault hooks exist for trusted tests and fixture composition, not request-supplied authorization.

Unknown or disputed provenance is retained only in metadata-only quarantine if the governing policy explicitly permits it; otherwise the item is discarded. Even provider-declared provenance requires an explicit recorded decision before an imported source becomes eligible. A decision includes classification, original-report identity when syndicated, actor assertion, timestamp, reason and evidence references. Contradictions with known provider provenance or prior resolved decisions are rejected. Syndication requires an identifiable, eligible primary or original report and shares its independence identity. Quarantine contributes neither independent-source counts nor approval evidence. Resolution keeps the original rights snapshot and retention deadline and creates an unverified source; it does not verify claims or authenticate a reviewer.

### Local transactions, migration and retention

Each ingested item uses one repository transaction for its source or quarantine record, provenance decision and outcome audit. Duplicate decisions are made under the same local lock. Rejected and duplicate attempts still produce counts and atomic procedural outcome events, without a source ID/hash that would create a separate identifying retention obligation. Dry runs apply the same decisions to an in-memory snapshot without writing. A failed storage transaction increments the failed count and commits neither a success record nor its outcome event. No network request runs under the repository lock. These local atomic replacements do not establish multi-host or production database guarantees.

Schema-1, schema-2 and schema-3 repositories migrate to schema 4 in memory when read; reading alone does not rewrite the file. Schema 4 adds draft proposals and draft-review collections. Migration preserves existing records and the schema-3 retention-review flag; schema 1/2 starts under `retentionReviewRequired: true` because past removals cannot be established safely. A new empty schema-4 repository starts with the flag false. The next successful transaction writes schema 4. Legacy source assertions are historical records, not retroactive registry approval; policy snapshots missing the audit-retention grant are unknown rather than upgraded. Direct `Newsroom.ingest` remains restricted to fictional `.test` sources with the exact rights label `fictional test fixture only` and IDs outside the provider-managed `url-` namespace. New provider imports use the registry and provenance controls above. Both ingestion paths and provenance resolution are blocked while retention review is required.

`cleanupRetention(repository, at, dryRun = true)` is manual; a dry run only reads and previews metadata candidates. Applying cleanup removes expired or ineligible managed metadata, quarantine, dependent managed syndicated copies and linked ingestion details in one transaction. It also detects identifying audit subjects with no governing managed source, quarantine or unexpired marker. Those audit orphans trigger the review hold and are replaced with non-identifying procedural stubs. Before scrubbing audit links, cleanup follows subject-to-story links as well as revision/evidence references to redact known historical copies, even when no metadata candidate remains. Every affected story version is replaced using a field whitelist: prose, evidence, source IDs, geography, cluster identity and original story ID are removed. A fresh random story ID consistently links the minimized versions, approvals and procedural audit events; actor labels are redacted. Unrelated lawful history remains unchanged. Retained procedural stubs do not preserve licensed prose. Redacted stories cannot enter the correction-to-draft path or any other edit/transition.

Deletion markers are linkable source identities, so they may remain only when the captured policy permits minimal audit and supplies a finite positive `auditRetentionDays`. The fixture grant is one day; `fictional-no-audit-v1` permits no marker and uses zero. Markers carry `expiresAt`; expired, invalid or old deadline-less markers and their linked audits are purged without renewal. Missing audit terms do not authorize a new grant. Cleanup sets a repository-wide `retentionReviewRequired` boolean when data is removed or historical retention concerns are found. This flag stores no source identity and blocks provider/legacy ingestion, provenance resolution and new approval/publication after markers disappear. There is no application operation to clear it.

Cleanup is logical deletion from the current JSON repository, not secure erasure or enforcement across backups, snapshots, fresh repositories, external copies or unlinked prose. It has no scheduler or reviewed release-from-hold procedure. `npm run retention:fixture` seeds a temporary fictional repository and previews cleanup; `npm run retention:fixture -- --apply-fixture` applies cleanup only to that temporary fixture. Neither accepts an existing repository path or live mode. The ingestion fixture defaults to dry run, reports counts and safe item indexes, and supports temporary writes with `--write-fixture`. Both runners use a fixed fictional clock, remove their temporary directories, create no stories and make no network requests. Real contracts, authenticated identity and authorization, external retention controls, production transactions and public publication remain separate blocked requirements. See [retention policy](RETENTION_POLICY.md) and [provider evaluation](NEWS_PROVIDER_EVALUATION.md).

## DL-003C internal editorial proposals

`src/editorial` separates model execution, deterministic output validation, advisory language checks and proposal review. The only supplied provider is a deterministic mock. A model runner bounds input/output bytes, attempts, concurrent work, proposals per run and estimated cost, with timeout/cancellation and sanitized failures. Estimated attempt reservations are development accounting, not paid usage or production billing enforcement. No real provider SDK, credential or network request is enabled.

Generation consumes a current `DRAFT` or `NEEDS_REVIEW` story's fictional evidence marked `VERIFIED`, with identifiable support and eligible managed metadata. Every referenced source must have an exact active policy snapshot explicitly permitting licensed excerpts, internal analysis and AI summarization. The registry's `fictional-ai-editorial-v1` grant applies only to invented fixtures; discovery or redistribution permission alone cannot authorize this use. Source verification flags remain unchanged, and a verified evidence flag is not an independent truth finding by this service.

Fixed system instructions and the versioned prompt template are separate from untrusted evidence. Output must match a strict extractive schema: factual claims and citations reproduce stored evidence, contradictions and uncertainties remain, and fact/analysis/uncertainty sections are distinguished. Analysis is limited to a fixed human-review sentence; quotations and unsupported changes to numbers or dates are rejected. Pattern-based neutrality suggestions are transparent human-review aids, without autonomous truth scoring or equal-weight requirements. Injection screening is heuristic and cannot establish complete immunity.

A proposal captures its story revision, source IDs, policy snapshot digests, model/prompt versions, generation and expiry times, usage estimates and suggestions. Its content is immutable through the service; regeneration creates another proposal. Review checks the expected proposal version and current captured story revision, with restricted states and audited, explicitly unauthenticated actor assertions. `READY_FOR_APPROVAL` is a proposal state and does not invoke newsroom approval, source verification or publication. There is no public HTTP route for this workflow.

Story edits and transitions invalidate existing proposals; service snapshots/reviews transact to recheck revision, eligibility and expiry. Commit/review time is checked after acquiring the repository lock; generation also rechecks cancellation after a lock wait. Proposals expire no later than their source and policy deadlines; no background expiry scheduler is supplied. Quarantine, redacted history and the R2 retention-review hold block generation. Invalidation removes generated payload and source/story links and redacts review assertions; retention cleanup applies the same scrubbing alongside source/history removal. JSON storage and authenticated-production-authorization limitations remain unchanged. See [AI editorial design](AI_EDITORIAL_DESIGN.md) for the exact review transitions and resource boundaries.
