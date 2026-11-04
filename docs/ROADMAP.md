# Dayline — Controlled MVP Roadmap

## DL-001 — Foundation
- [x] Private repository established: MauroDot/Dayline.
- [x] Foundation branch created.
- [x] Product charter, architecture proposal, and milestone acceptance requirements prepared.
- [ ] Export/import the full approved hosted prototype source and visual assets (not yet available in this repository).
- [ ] Choose and pin the actual production framework and dependencies.
- [ ] Add build, lint, typecheck, unit test and GitHub Actions workflows after source import.
- [ ] Verify functional parity against the approved preview, including small-screen behavior.
- [ ] Record checks and user acceptance; promote only with explicit authorization.

## DL-002 — Official data integrations
- [ ] Treasury Debt to the Penny ingestion, as-of timestamps, component consistency checks.
- [ ] NWS point forecast/observation ingestion, location selection and attribution.
- [ ] Server-side caching, error retries, stale fallback and clear freshness labels.
- [ ] Contract tests, observability and acceptance checks; no fabricated data.

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
