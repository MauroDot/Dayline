# Dayline

**A clearer view of today.**

An evidence-first daily news and economic intelligence platform by MauroDot.

## Status
**Foundation 001 — active, initial runnable application committed.** The GitHub branch provides a new responsive shell, Node 22 TypeScript server, official data adapters, mocked integration tests, and GitHub Actions CI. This is **not yet a faithful import of the separately hosted original design**. Windows 11 physical acceptance previously passed for the homepage, Treasury, NWS, startup and nine tests; this does not establish design parity. Live news automation, AI narration and payments are not implemented.

- [Project charter](docs/PROJECT_CHARTER.md)
- [Architecture proposal](docs/ARCHITECTURE.md)
- [MVP roadmap and acceptance checklist](docs/ROADMAP.md)
- [Open draft PR #1](https://github.com/MauroDot/Dayline/pull/1)

## Local development
Requires Node.js **22.16.0 or later** (native experimental TypeScript type stripping) and npm **10 or later**; CI uses Node 22.16.0 and its bundled npm. Install pinned development dependencies with npm ci; TypeScript and Node type definitions are development-only dependencies.

```bash
npm ci
npm run check
# Set NWS_USER_AGENT to an identifying application name and real contact email.
npm start
```

Open http://localhost:3000. Public page and server routes:
- `GET /` — foundation UI
- `GET /api/health` — readiness probe
- `GET /api/debt` — last available Treasury Debt to the Penny report
- `GET /api/weather?city=Tulsa` — NWS point forecast for an allowlisted city

Set `NWS_USER_AGENT` in the process environment to an identifying application name and real contact email. Weather requests return 503 without it; do not commit private contact details. When official sources fail, the interface shows an unavailable message; the server uses cached valid records only within its configured staleness window. Debt stays fresh for one hour and weather for 30 minutes; failed refreshes can use data up to 24 hours old with a stale flag. Each upstream attempt has an eight-second timeout, with at most three attempts for network errors, HTTP 429 and HTTP 5xx. The cache is process-local, suitable for MVP testing but not a distributed deployment. Revalidate live Treasury and NWS responses with an appropriate contact before release.

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
2. Add deployment packaging and reproducible browser tests.
3. Continue monitoring live NWS and Treasury compatibility and official API rate rules.
4. Record user acceptance and explicit promotion approval before merging.

## DL-001C interface preview

The edition uses fictional demonstration stories, labeled throughout; links provide general background, not evidence of those examples. Market prices and audio are unavailable. Official debt and weather continue to use the existing server adapters. The interface is a recreation informed by the documented design direction; the separate hosted prototype was not available for a parity comparison. Browser checks can be run with `python -m unittest discover -s tests/browser -v` when Python Playwright and Chromium are installed (set `CHROMIUM_PATH` if needed).

## Windows development

Install Node.js 22.16.0 or later and npm 10 or later, then in PowerShell from the checkout run `npm.cmd ci` and `npm.cmd run check`. Set a real identifying NWS contact for the current shell with `$env:NWS_USER_AGENT = 'Dayline/0.1 (contact@your-domain)'`, then start with `npm.cmd start`. Replace the example with your own contact; do not commit it. `.env.example` documents variables but is not automatically loaded. `PORT` is optional and defaults to 3000. For browser tests install Python, Playwright and a compatible Chromium; set `CHROMIUM_PATH` to its executable if it is not `/usr/bin/chromium`. Run `python -m unittest discover -s tests/browser -v`.

Treasury Fiscal Data and the National Weather Service are the current official sources. Treasury's reporting date and the retrieval time are separate; NWS source update times are shown when supplied. The cache is in memory and resets when the server stops. Live data requires network access and an identifying NWS user agent; no market feed, audio, billing, or publishing is active. Demonstration stories are fictional and general reference links do not substantiate them. A focused automated accessibility audit cannot replace assistive-technology testing. The reference prototype was inaccessible through the configured network proxy, so exact visual parity is unverified.

## Foundation acceptance and recovery

- [ ] Recheck desktop and mobile layouts, keyboard access, contrast, screen readers, and 200% zoom on target devices.
- [ ] Run automated checks and physically verify Windows startup, Treasury data and NWS weather with a valid contact.
- [ ] Compare the authorized prototype, document differences, and obtain owner acceptance.
- [ ] Confirm rights, corrections, editorial approval, security, and operational controls before any public deployment.

Foundation review is not production readiness. Future paid services require separately approved cost limits, quotas and alerts; no paid API is enabled here. Never publish unreviewed generated news or commit credentials. To recover locally, stop the server, check `git status`, preserve uncommitted work, and start from a separately reviewed known-good commit in a new checkout or worktree. Do not reset a checkout containing unreviewed work. Public rollback and deployment procedures remain to be designed and approved.

## Internal newsroom prototype

DL-003A adds local TypeScript domain services under `src/newsroom`; the website and HTTP API expose no newsroom or publication endpoints. Tests under `tests/newsroom.test.ts` use explicitly fictional sources and events. Run `npm ci` and `npm run check` for typechecking, newsroom tests and existing backend/HTTP checks; browser prerequisites and commands are above. See the architecture notes for source provenance, editorial transitions, repository limitations and the production authorization block. No real news feed, real AI request or public publishing is enabled.

## Fictional ingestion fixture

`npm run ingest:fixture` runs a bounded dry run using fictional data; `npm run ingest:fixture -- --write-fixture` exercises writes in a temporary repository that is removed afterwards. Neither command makes network requests. Fixture clocks are fixed for repeatable development checks; they are trusted test seams, not a way to grant rights or authenticate a reviewer.

Ingestion resolves a provider ID and policy ID against a private, frozen registry. Only `fictional-fixture` has policies; every real provider, including GNews, is denied. An API key or caller-supplied permission object cannot grant ingestion rights. Provider titles, text and images are discarded. Unknown or disputed provenance remains in metadata-only quarantine when its policy permits that retention; otherwise it is discarded. Creating an eligible source requires an explicit recorded provenance decision, supporting references and an actor assertion. Those assertions do not authenticate the actor or verify the article's claims.

Managed metadata retains the exact policy snapshot and deletion deadline captured at ingestion. Retention starts at the earlier of ingestion and the original retrieval time, capped by policy expiry; delayed ingestion cannot restart it. Manual retention cleanup defaults to a dry run and removes expired or ineligible managed metadata, linked ingestion provenance/audit details and dependent syndicated sources. Permitted deletion markers have a finite audit deadline; expired or deadline-less markers and their linked audits are purged without renewal. Rejected/duplicate attempt events retain no source identity, and cleanup replaces older identifying audit orphans with non-identifying procedural stubs.

DL-003B-R2 addresses two confirmed R1 gaps: refreshed metadata could restore a deleted URL when no marker was permitted, and copied story/evidence text survived metadata deletion. Cleanup now places the repository under a non-identifying retention-review hold and redacts every version of affected stories, including linked reviewer/audit identities. The hold blocks ingestion, provenance resolution and new approval/publication; redacted stories cannot be edited or transitioned. There is no application API to clear the hold. R1 already blocked new approval/publication using missing or ineligible evidence; R2 adds history removal and prevents metadata restoration after identity markers expire.

`npm run retention:fixture` seeds a temporary fictional repository and previews cleanup without applying its deletions. `npm run retention:fixture -- --apply-fixture` applies cleanup to that temporary fixture. Both remove their temporary directory afterwards, accept no existing repository path or live mode, and make no network requests. Direct newsroom ingestion is also restricted to explicitly labeled fictional `.test` sources; provider-managed imports must use the registry workflow.

The GNews adapter remains disabled by default with no live CLI. Real-provider licensing, authenticated production authorization, external-copy retention controls, transactional production storage and public publication remain blocked. Cleanup covers the current JSON repository, not secure erasure, backups, fresh repositories, external copies or unlinked prose. See [retention policy](docs/RETENTION_POLICY.md), [provider evaluation](docs/NEWS_PROVIDER_EVALUATION.md) and [architecture notes](docs/ARCHITECTURE.md).

## Mock editorial proposals

DL-003C adds an internal, deterministic mock drafting workflow under `src/editorial`. It extracts structured proposals from explicitly fictional, rights-authorized stored evidence. There is no drafting HTTP endpoint, live AI adapter, API key, model SDK or paid request. `npm run check` runs static checking and the deterministic backend/domain tests; browser regression commands and prerequisites are above.

Drafts preserve exact evidence claims, supporting and contradicting references, and uncertainties. Strict validation rejects invented citations, changed figures/dates and quotations; it does not establish that an existing evidence claim is true. Pattern-based language flags are advisory review suggestions, not truth or neutrality scores. Source text and model responses are untrusted, and heuristic injection checks do not establish complete immunity.

Generation requires the current story revision, evidence marked `VERIFIED`, eligible managed metadata and an exact active policy snapshot permitting excerpts, internal analysis and AI summarization. Only a fictional test policy grants those permissions. Draft review records explicitly unauthenticated actor assertions; `READY_FOR_APPROVAL` does not approve a newsroom story, verify a source or authorize publication. Story changes, expired/revoked rights and retention cleanup invalidate affected proposals and remove their payload and review identities. Input/output, attempts, concurrency, proposal count, timeout, cancellation and estimated-cost limits bound local mock runs. See [AI editorial design](docs/AI_EDITORIAL_DESIGN.md) for the contracts and production blockers, and the [DL-003C validation report](docs/DL-003C_VALIDATION.md) for executed local checks.
