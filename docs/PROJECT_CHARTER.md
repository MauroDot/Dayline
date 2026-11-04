# Dayline — Project Charter

Status: Foundation 001 (pre-implementation)
Owner: MauroDot
Working name: Dayline
Tagline: A clearer view of today.

## Mission
Offer a concise, evidence-first daily briefing of United States and world news, with practical weather, market, and national-debt context. Build trust through source transparency, careful attribution, clear timestamps, and a correction process rather than claims of absolute neutrality.

## Confirmed product decisions
- Daily national and international news remains free.
- Weather, market orientation, national debt and a standard daily narrated briefing remain free.
- Dayline Plus is a **provisional** $2.99/month subscription offering narrator choice and audio convenience; price must pass measured cost validation.
- OpenAI API is the intended synthetic narration provider, subject to model support, voice licensing, quality, and cost validation.
- Stripe is the intended subscription processor; **test mode only** until separate approval to activate real payments.
- A recognizable fictional presenter may be used, with clear synthetic-media disclosure and vendor-permission review.
- Publish a curated edition at a proposed 06:00 America/Chicago, with distinct data refresh schedules.
- The current hosted visual demo is the design reference, **not proof of an operational publishing system**.

## Out of scope for Foundation 001
Live feeds, unattended publishing, creating real subscriptions, generating paid API traffic, public deployment, newsroom video, auto-posting unreviewed high-impact claims, and merging to main.

## Editorial guardrails
1. Attribute contested statements; distinguish facts, forecasts, commentary, and allegations.
2. Link to primary evidence or original reporting; track syndication to avoid false source independence.
3. Display published/updated timestamps, data-as-of dates, and correction history.
4. Hold high-risk or weakly corroborated stories for human review before publishing.
5. Never invent stories, prices, source links, observations, market data, or debt values.
6. Do not assume API access confers redistribution, image, or audio rights.
7. Disclose all synthetic voices and presenters.

## Change policy
Feature branch -> automated validation -> review/physical acceptance -> explicitly approved merge. No automatic main-branch promotion.
