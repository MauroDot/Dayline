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
