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

## DL-003 — News rights and editorial review
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
