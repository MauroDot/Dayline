# Dayline — Controlled MVP Roadmap

## DL-001 — Foundation
- [x] Private repository established: MauroDot/Dayline.
- [x] Foundation branch and draft PR created.
- [x] Product charter, architecture proposal and milestones prepared.
- [x] New minimal responsive application shell, TypeScript HTTP server, official-source adapters and mocked tests committed.
- [x] GitHub Actions syntax checks, Node test suite and startup smoke test passed on initial implementation.
- [x] Owner confirmed Foundation 001 development acceptance and merge; historical Windows homepage/Treasury/NWS/startup acceptance remains recorded.
- [x] Automated browser regression baseline implemented in subsequent development milestones.
- [ ] Reverify exact prototype parity for changed views and record new physical/accessibility acceptance.
- [ ] Complete controlled deployment packaging/release documentation and current live Treasury/NWS regression checks before production use.

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

## DL-003C — AI-assisted editorial workflow
- [x] Provider-independent model contract and deterministic mock with local resource/cost limits; no real API calls.
- [x] Strict extractive, evidence-linked proposals with contradiction/uncertainty preservation and advisory language flags.
- [x] Revision-specific, explicitly unauthenticated draft review states; no automatic newsroom approval or publication.
- [x] Explicit fictional AI rights, source/policy expiry checks and invalidation integrated with story changes and retention cleanup.
- [x] DL-003C validation executed on Node 22.16.0: TypeScript and 204/204 backend/domain tests passed; Chromium 7/7 passed. See [validation report](DL-003C_VALIDATION.md).
- [ ] Select real permitted feeds and approve contracts, including AI/derived-content and retention rights.
- [ ] Implement authenticated production reviewers, authorization, durable transactions and approved publication operations.

## DL-004A — Daily edition assembly foundation
- [x] Typed, date/timezone-scoped fictional editions with canonical sections, stable placement order and duplicate prevention.
- [x] Exact approved newsroom revision/approval and managed-source rights/evidence eligibility requirements.
- [x] Revision-specific internal review, unauthenticated assertions and optimistic concurrency; no publication state.
- [x] Story/rights/retention invalidation and scrubbing of affected edition payload and review identities.
- [x] Internal fictional JSON preview; homepage and official-data panels remain separate.
- [x] DL-004A local validation on Node 22.16.0: TypeScript, 282/282 backend/domain tests and 7/7 Chromium regressions passed; see [validation report](DL-004A_VALIDATION.md).
- [ ] Complete physical acceptance and separately authorized production work.

## DL-004B — Fictional daily edition presentation
- [x] Dedicated responsive reader view for all eight sections, featured/ordered placements and explicit empty states.
- [x] Opt-in development/loopback route gates and temporary known-fictional repository; no arbitrary edition/repository selection.
- [x] Strict display DTO, fresh eligibility checks, short browser display lifetime and no persistent browser storage.
- [x] Attribution, uncertainty/counterevidence and status disclosures; plain coming-soon audio placeholder.
- [x] DL-004B local validation on Node 22.16.0: TypeScript, 304/304 backend/domain/security tests and 18/18 Chromium regressions passed; targeted axe checks found no violations. See [validation report](DL-004B_VALIDATION.md).
- [ ] Obtain new physical browser/assistive-technology acceptance and separately authorize any production work.

## DL-004C — Controlled local edition scheduling
- [x] Named-timezone daily/weekday calendar with explicit DST gap/fold policy and unique occurrence identity.
- [x] Disabled-by-default schedules, bounded latest-only catch-up, pause/resume and cancellation.
- [x] Atomic local claims, expiring fencing, bounded retry/recovery and sanitized run audit metadata.
- [x] New `ASSEMBLING` edition preparation through existing eligibility; preserve manual editions and editorial approval boundaries.
- [x] Temporary fictional dry-run/apply inspection with no background worker or public endpoint.
- [x] DL-004C local validation on Node 22.16.0: TypeScript, 380/380 backend/domain/security tests and 18/18 Chromium regressions passed; see [validation report](DL-004C_VALIDATION.md).

## DL-004 — Remaining edition operations
- [ ] Authenticated production review and explicitly authorized publication with durable storage.
- [ ] Separately authorized 06:00 America/Chicago production worker infrastructure, monitoring and recovery.
- [ ] Keep official-data refresh schedules independent from edition publication.
- [ ] Demonstrate idempotent publishing, recovery and graceful degraded operation before public release.

## DL-005A — Editorial authentication and access control foundation
- [x] Provider-independent trusted verifier boundary with synthetic signed credentials; no production identity provider or login route.
- [x] Explicit deny-by-default role/permission matrix separating access administration from editorial authority.
- [x] Current-session/identity checks, role revocation, credential-version rotation and bounded safe security metadata.
- [x] Guarded internal editorial adapters with action-time/precommit checks and separate revision-bound authenticated receipts.
- [x] Schema-7 migration preserves historical unauthenticated assertions and existing retention holds without backfill.
- [x] DL-005A local validation on Node 22.16.0: TypeScript, 459/459 backend/domain/security tests and 18/18 Chromium regressions passed; see [validation report](DL-005A_VALIDATION.md).
- [ ] Review real identity trust, production authorization/storage and operations before any live accounts or public administration.

## DL-005B — Isolated authenticated editorial HTTP integration

- [x] Dedicated development-only loopback listener with explicit opt-in, strict request origins/headers and header-based synthetic credentials.
- [x] Trusted synthetic verifier selection with a disabled production-provider boundary; no real identities or public credential minting.
- [x] Selected authenticated story/edition/scheduler entry points with explicit resource assignments and current revision checks.
- [x] Current-session/role/resource checks at mutation and commit boundaries; historical unauthenticated assertions preserved.
- [x] Legacy mutation-path inventory and production bypass limitations documented in [security design](SECURITY_DESIGN.md).
- [x] Local validation on Node 22.16.0: TypeScript, 530/530 backend/domain/security tests, 71/71 targeted security/HTTP tests and 18/18 Chromium regressions passed; startup/shutdown and route isolation passed. See [DL-005B validation](DL-005B_VALIDATION.md).
- [ ] Complete separate physical Windows, native browser zoom and assistive-technology acceptance.
- [ ] Review real identity trust, secure bootstrap/key management, exclusive production authorization, durable storage and independent security assessment before activation.

## Future voice and premium feasibility
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
