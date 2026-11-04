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

The JSON repository serializes cooperating single-host writers with an exclusive lock directory and replaces a synced temporary file via rename. Snapshots are copies, and service operations only append audit and revision records. This is not tamper-proof storage: trusted code or filesystem access can rewrite files; there is no authenticated identity, authorization, inter-host locking, directory fsync guarantee, transactional database, automatic stale-lock recovery or production audit protection. After a crash, inspect any lock or temporary file before manual recovery. Reviewer strings are assertions, not secure identities. Internal status transitions do not publish articles to readers. Production authorization and unattended publication remain blocked until authenticated identity, permissions, durable transactional storage and operational safeguards are separately implemented and reviewed.

## DL-003B provider boundary

`src/ingestion` separates provider request limits and metadata from newsroom records. GNews uses its documented v4 search response shape, is disabled unless explicitly enabled with a server-side key, and has bounded request size, pages, retries and timeouts. Its normalizer discards titles, descriptions, full text and images and marks provenance unknown; such items are rejected until independently classified. No live-provider runner exists. Never log the credential-bearing request URL.

Rights are explicit and default-deny: a complete policy must authorize discovery metadata before ingestion. Excerpts, full text and media are never persisted by this milestone even if a policy permits them. Analysis, redistribution, AI summary and narration permissions are recorded as policy metadata but are not implemented or granted by an API response. Retention and deletion obligations are recorded, not automatically enforced; do not use this prototype for real provider data until an approved policy and deletion workflow exist. GNews sources require verified provenance review; callers must not classify unknown syndication as independent.

The fixture-only runner defaults to a dry run, reports counts and safe item indexes, and optionally writes only to a temporary fictional repository that is deleted afterwards. The integration stores metadata only, deduplicates canonical URLs, records outcomes in the local audit log, and does not create or approve stories. Existing JSON storage, authentication and publication restrictions continue to apply. See `docs/NEWS_PROVIDER_EVALUATION.md` before considering any provider.
