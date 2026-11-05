# Dayline — Controlled MVP Roadmap

## DL-001 — Foundation
- [x] Private repository established: MauroDot/Dayline.
- [x] Foundation branch and draft PR created.
- [x] Product charter, architecture proposal and milestones prepared.
- [x] New minimal responsive application shell, TypeScript HTTP server, official-source adapters and mocked tests committed.
- [x] GitHub Actions syntax checks, Node test suite and startup smoke test passed on initial implementation.
- [ ] Import the approved hosted prototype source/assets or reach documented visual and behavioral parity.
- [ ] Add browser regression tests, controlled deployment packaging and release documentation.
- [ ] Verify upstream Treasury and NWS requests live with required configuration.
- [ ] User performs physical acceptance; explicit merge approval is required.

## DL-002 — Official data integrations
- [x] Treasury Debt to the Penny adapter and as-of / component consistency validation implemented.
- [x] NWS forecast adapter, location allowlist and attribution implemented.
- [x] Initial process-local TTL cache, stale-response labels and failure states implemented.
- [x] Unit tests using fake official-source responses.
- [ ] Validate real upstream responses, API rate limits and a compliant NWS User-Agent.
- [ ] Add observation stream and separate forecast/observation presentation.
- [ ] Add persistence, monitoring, timezone handling and operational tests.
- [x] Add bounded retries, exact-cent debt validation and stale-state tests.
- [ ] Live browser acceptance with no invented data.

## DL-003A — Internal newsroom foundation
- [x] Typed source, claim and story records with provenance and duplicate detection.
- [x] Internal revision-specific review transitions and local JSON persistence with fictional tests.
- [ ] Production identity, permissions, durable transactional storage and publishing remain blocked.

## DL-003B — Provider integration prototype
- [x] Default-disabled GNews adapter, fictional fixture runner, and rights-aware metadata boundary.
- [ ] Validate provider terms, provenance, retention and deletion before real data access.
- [ ] Secure authentication, durable storage and licensed publication remain blocked.

## DL-003B-R1 — Rights, provenance and retention hardening
- [x] Central, versioned fictional-only policy registry; deny caller permission overrides and all real providers.
- [x] Metadata quarantine and explicit provenance decisions; preserve captured rights and retention deadlines.
- [x] Atomic per-item ingestion outcomes, snapshot-only dry runs and schema-1 history migration.
- [x] Manual retention cleanup with policy-permitted minimal deletion records and source eligibility checks.
- [ ] Approve actual provider contracts and rights evidence before any real ingestion.
- [ ] Enforce retention across production storage, backups and external copies; local cleanup is not secure erasure.
- [ ] Add authenticated reviewers, authorization and production transactions before publication or unattended operation.

## DL-003B-R2 — Deletion integrity and historical redaction
- [x] Address confirmed restoration after marker-free deletion with a repository-wide retention-review hold.
- [x] Bound policy-permitted identity markers with finite audit retention; purge expired and deadline-less markers without renewal.
- [x] Omit identities from rejected/duplicate outcome events and scrub historical identifying audit orphans under the review hold.
- [x] Redact all versions of source-linked stories and linked approval/audit identities; block reuse of redacted history.
- [x] Migrate schema 1/2 read-only to schema 3 under a conservative review hold; preserve unrelated lawful history.
- [x] R2 validation executed on Node 22.16.0: TypeScript and 134/134 backend/domain tests passed; Chromium 7/7 passed. See [R2 validation report](DL-003B-R2_VALIDATION.md).
- [ ] Design a legally reviewed release-from-hold process and deletion enforcement across production copies before real-provider use.

## DL-003C — News rights, editorial review and publication
- [ ] Select permitted content feeds and negotiate needed usage rights.
- [ ] Deduplicate story clusters while retaining originating-report provenance.
- [ ] Evidence-linked drafts, human holds, corrections and full audit trail.

## DL-004 — Scheduled editions
- [ ] Versioned 06:00 America/Chicago edition, explicit review gate, monitoring and retries.
- [ ] Data refresh schedules independent from edition publication.
- [ ] Demonstrate idempotent publishing and graceful degraded operation.

## DL-005A — Voice and premium feasibility
- [ ] Verify current OpenAI speech endpoints, voices, model lifecycles and rates.
- [ ] Measure actual cost of short and long scripts with realistic pronunciation and retries.
- [ ] Produce disclosed synthetic audio using approved scripts; support transcript fallback.
- [ ] Cache one recording per edition/script-version/voice, not one per playback.
- [ ] Validate premium voice selection with test-only entitlements and quotas.
- [ ] Exercise Stripe test mode (Checkout, webhooks, cancellation, billing failure) without live customers.
- [ ] Check $2.99/month economics including Stripe Billing, tax, hosting, audio, storage, abuse and refunds.

## DL-006 — Launch readiness
- [ ] Editorial policy, rights review, accessibility, privacy and security checks.
- [ ] Operational rollback, budget thresholds, billing incident response.
- [ ] Explicit authorization for public release, production API usage and live payments.
