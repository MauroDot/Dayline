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

The service permits INGESTED → CLUSTERED → DRAFT → NEEDS_REVIEW → APPROVED → PUBLISHED, with explicit hold and rejection transitions and PUBLISHED → CORRECTION_REQUIRED → DRAFT for corrections. Rejected stories cannot silently resume. Approval requires supported, verified claims and records a reviewer label and exact revision; changing an approved story returns it to draft. Each change appends a revision and audit event. Claim verification requires at least one associated supporting source; reviewers remain responsible for assessing source trust and contradictions.

The JSON repository serializes cooperating single-host writers with an exclusive lock directory and replaces a synced temporary file via rename. Snapshots are copies. Editorial operations append revisions and audit records; retention cleanup may remove linked ingestion audit details as described below. This is not tamper-proof storage: trusted code or filesystem access can rewrite files; there is no authenticated identity, authorization, inter-host locking, directory fsync guarantee, transactional database, automatic stale-lock recovery or production audit protection. After a crash, inspect any lock or temporary file before manual recovery. Reviewer strings are assertions, not secure identities. Internal status transitions do not publish articles to readers. Production authorization and unattended publication remain blocked until authenticated identity, permissions, durable transactional storage and operational safeguards are separately implemented and reviewed.

## DL-003B provider boundary

`src/ingestion` separates provider request limits and metadata from newsroom records. GNews uses its documented v4 search response shape, is disabled unless explicitly enabled with a server-side key, and has bounded request size, pages, retries and timeouts. Its normalizer discards titles, descriptions, full text and images and marks provenance unknown. No live-provider runner exists, and the ingestion registry denies GNews regardless of adapter configuration. Never log the credential-bearing request URL.

### DL-003B-R1 policy and provenance controls

`ingestArticles` receives a `JsonRepository`, provider articles and `{ providerId, policyId }`; caller-provided policies and permission overrides are rejected. The private, frozen registry contains only `fictional-fixture` policies. Resolution requires an approved, complete policy with an evidence reference, version, effective date and expiry. Missing, unapproved, expired, revoked, superseded or mismatched policies deny ingestion. No real provider has an approved policy. Excerpts, full text and media are never persisted by this integration, and fixture permission fields authorize no real analysis, redistribution or AI service.

Every retained item captures the exact policy snapshot, retention time and deletion deadline. Retention is measured from the earlier of ingestion and original retrieval, capped by policy expiry; delayed ingestion cannot reset it. Revalidation compares the snapshot with its registered version; a later policy cannot expand existing permissions or extend retention. Fixed clocks and repository fault hooks exist for trusted tests and fixture composition, not request-supplied authorization.

Unknown or disputed provenance is retained only in metadata-only quarantine if the governing policy explicitly permits it; otherwise the item is discarded. Even provider-declared provenance requires an explicit recorded decision before an imported source becomes eligible. A decision includes classification, original-report identity when syndicated, actor assertion, timestamp, reason and evidence references. Contradictions with known provider provenance or prior resolved decisions are rejected. Syndication requires an identifiable, eligible primary or original report and shares its independence identity. Quarantine contributes neither independent-source counts nor approval evidence. Resolution keeps the original rights snapshot and retention deadline and creates an unverified source; it does not verify claims or authenticate a reviewer.

### Local transactions, migration and retention

Each ingested item uses one repository transaction for its source or quarantine record, provenance decision and outcome audit. Duplicate decisions are made under the same local lock. Dry runs apply the same decisions to an in-memory snapshot without writing. A failed storage transaction increments the failed count and commits neither a success record nor its outcome event. No network request runs under the repository lock. These local atomic replacements do not establish multi-host or production database guarantees.

Schema-1 repositories migrate to schema 2 in memory when read; reading alone does not rewrite the file. Existing sources, story revisions, approvals and audit records are preserved. Legacy internal source assertions are historical records, not retroactive registry approval. The next successful transaction writes schema 2 with the new managed-source, quarantine, provenance-decision and deletion-marker collections. Direct `Newsroom.ingest` is restricted to fictional `.test` sources with the exact rights label `fictional test fixture only` and IDs outside the provider-managed `url-` namespace. New provider imports use the registry and provenance controls above.

`cleanupRetention(repository, at, dryRun = true)` is a manual, deterministic operation. It selects expired metadata and records with invalid retention or inactive, revoked or superseded policies, including quarantined records and dependent managed syndicated copies. Applying cleanup removes those source/metadata records and linked provenance and ingestion audit details in one transaction. Only policy-permitted minimal deletion markers and service audit events remain; they contain an opaque source ID and deletion timing/reason, without provider metadata, evidence references or asserted reviewer identity. Story revisions and approvals remain as history. Missing or ineligible sources cannot contribute to independence counts or new approval/publication transitions.

Cleanup is logical deletion from the current JSON repository, not secure erasure or enforcement across backups, snapshots, external copies or retained editorial history. It has no scheduler. `npm run retention:fixture` seeds a temporary fictional repository and previews cleanup; `npm run retention:fixture -- --apply-fixture` applies cleanup only to that temporary fixture. Neither accepts an existing repository path or live mode. The ingestion fixture defaults to dry run, reports counts and safe item indexes, and supports temporary writes with `--write-fixture`. Both runners use a fixed fictional clock, remove their temporary directories, create no stories and make no network requests. Real contracts, authenticated identity and authorization, external retention controls, production transactions and public publication remain separate blocked requirements. See [provider evaluation](NEWS_PROVIDER_EVALUATION.md) before considering any provider.
