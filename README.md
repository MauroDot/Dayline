# Dayline

**A clearer view of today.**

An evidence-first daily news and economic intelligence platform by MauroDot.

## Status
**Foundation 001 — active, initial runnable application committed.** The GitHub branch provides a new responsive shell, Node 22 TypeScript server, official data adapters, mocked integration tests, and GitHub Actions CI. This is **not yet a faithful import of the separately hosted original design**. Official upstream API responses have not yet been verified in a live environment. News automation, AI narration and payments are not implemented.

- [Project charter](docs/PROJECT_CHARTER.md)
- [Architecture proposal](docs/ARCHITECTURE.md)
- [MVP roadmap and acceptance checklist](docs/ROADMAP.md)
- [Open draft PR #1](https://github.com/MauroDot/Dayline/pull/1)

## Local development
Requires Node.js **22.16.0 or later** (native experimental TypeScript type stripping). No third-party packages are required for this foundation shell.

```bash
npm run check
npm start
```

Open http://localhost:3000. Public page and server routes:
- `GET /` — foundation UI
- `GET /api/health` — readiness probe
- `GET /api/debt` — last available Treasury Debt to the Penny report
- `GET /api/weather?city=Tulsa` — NWS point forecast for an allowlisted city

A production-ready NWS User-Agent must be configured using `NWS_USER_AGENT` with identifying contact information. When official sources fail, the interface shows an unavailable message; the server uses cached valid records only within its configured staleness window. The cache is process-local, suitable for MVP testing but not a distributed deployment.

## Product vision
A concise, trustworthy daily briefing covering U.S. and world news, weather, national debt and market context, with source transparency, corrections and synthetic narration. Main coverage and the standard audio briefing remain free.

**Dayline Plus** is a provisional $2.99/month tier for voice choice and listening convenience. OpenAI narration and Stripe billing must be added and approved in controlled milestones; no live billing or paid API traffic is enabled here.

## Design reference
Private hosted visual prototype (separate codebase; not automatically synchronized):
https://dayline-daily-tom.wintry-olm-1143.chatgpt.site

## Development policy
- Work on feature branches and require explicit authorization before merging to `main`.
- Do not publish unreviewed AI-generated articles.
- Never commit API secrets or transmit secret keys to the browser.
- Preserve source timestamps and clearly distinguish official, stale, sample and unavailable states.
- Run CI plus live integration, browser and user acceptance tests before declaring milestone completion.

## Remaining Foundation 001 work
1. Retrieve/import approved hosted design source/assets or recreate to documented visual parity with rights review.
2. Add formal TypeScript typechecking, dependencies as needed, deployment packaging and reproducible browser tests.
3. Confirm NWS and Treasury upstream compatibility in a controlled live environment, including official API rate rules.
4. Record user acceptance and explicit promotion approval before merging.
