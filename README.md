# Dayline

**A clearer view of today.**

An evidence-first daily news and economic intelligence platform by MauroDot.

## Status
**Foundation 001 — in progress.** This GitHub repository currently contains the project charter and implementation plan. The existing hosted visual prototype has **not yet been imported**; live integrations, scheduled news automation, OpenAI narration, and paid subscriptions are **not active**.

- [Project charter](docs/PROJECT_CHARTER.md)
- [Architecture proposal](docs/ARCHITECTURE.md)
- [MVP roadmap and acceptance checklist](docs/ROADMAP.md)

## Product vision
A concise, trustworthy daily briefing covering U.S. and world news, weather, national debt and market context, with source transparency, corrections and synthetic narration. Main coverage and the standard audio briefing remain free.

**Dayline Plus** is a provisional $2.99/month tier for voice choice and listening convenience. Stripe integration is test-only until explicit approval. No live billing or API charges are enabled by this repository.

## Prototype
Private hosted design reference:
https://dayline-daily-tom.wintry-olm-1143.chatgpt.site

## Development policy
- Features are developed on branches and reviewed before merging to `main`.
- Do not publish articles from unverified AI output.
- Do not commit secrets or expose API credentials to the browser.
- Do not enable production payments or costly API operations without explicit approval.
- Preserve data-as-of timestamps and visibly distinguish sample data from real data.

## Current next steps
1. Import the approved prototype source and media with rights and dependency verification.
2. Establish pinned TypeScript framework, local build and test suite.
3. Connect official U.S. Treasury and NWS data in the DL-002 milestone.
