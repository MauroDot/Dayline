# Dayline

**A clearer view of today.**

An evidence-first daily news and economic intelligence platform by MauroDot.

## Status
**Foundation 001 — development milestone previously accepted and merged, as confirmed by the owner.** That historical baseline includes Windows 11 acceptance of the homepage, Treasury, NWS, startup and nine tests. New milestone regression checks and remaining production/accessibility work do not reverse that acceptance. Exact parity with the separately hosted prototype has not been reverified in this milestone. Live news automation, AI narration and payments are not implemented.

- [Project charter](docs/PROJECT_CHARTER.md)
- [Architecture proposal](docs/ARCHITECTURE.md)
- [MVP roadmap and acceptance checklist](docs/ROADMAP.md)
- [Foundation PR #1](https://github.com/MauroDot/Dayline/pull/1)

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
- `GET /api/health` — process health (independent of official-source availability)
- `GET /api/ready` — observed official-data readiness; returns 503 until fresh required samples exist
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

## Further regression and production work
1. Compare changed views against the approved reference when available and record any differences.
2. Maintain browser regressions and prepare separately approved deployment packaging.
3. Continue monitoring live NWS and Treasury compatibility and official API rate rules.
4. Record acceptance of new milestones and obtain explicit approval for future promotion.

## DL-001C interface preview

The edition uses fictional demonstration stories, labeled throughout; links provide general background, not evidence of those examples. Market prices and audio are unavailable. Official debt and weather continue to use the existing server adapters. The interface is a recreation informed by the documented design direction; the separate hosted prototype was not available for a parity comparison. Browser checks can be run with `python -m unittest discover -s tests/browser -v` when Python Playwright and Chromium are installed (set `CHROMIUM_PATH` if needed).

## Windows development

Source development supports Node.js 22.16.0 or later, but **DL-006A artifact acceptance requires exactly Node.js 22.16.0**. Keep an existing system Node 24 installation unchanged: use a side-by-side Node executable and the PowerShell 5.1 commands in [Windows local acceptance](docs/DEPLOYMENT_RUNBOOK.md#windows-local-acceptance). Those commands verify the executable, temporarily prepend its directory to the current process PATH so npm scripts and their children use it, and restore PATH afterward. Smoke also accepts an explicit `--node` absolute executable path; it probes the selected runtime before startup and never falls back to system Node.

Windows can deny temporary symlink creation without the relevant privilege. Tests probe file/directory capability and explicitly skip only the impossible link-dependent checks; output preservation, duplicate-key manifest and missing-asset assertions still run. Skips must be recorded separately from passes. POSIX CLI SIGTERM/SIGINT tests stay strict; Windows uses a test-only controlled IPC shutdown path and does not claim POSIX signal parity. Neither strategy changes the twelve-file artifact or exposes a shutdown HTTP route.

The owner reported a successful clean build/inspection and manual Node 22 staging launch at original commit `d49ba4065e75ba0893be25b26b722f2581607c97`, plus eight manual browser checks including zoom, navigation, route isolation and Treasury/NWS inspection. That evidence remains historical acceptance of that version. DL-006A-W1 must be rerun on actual Windows after its local remediation commit; Linux execution and simulated Windows helper tests do not establish that acceptance.

Set the identifying NWS contact privately for a manual live check; do not commit or echo it. `.env.example` documents variables but is not automatically loaded. `PORT` defaults to 3000 and the default bind remains loopback. Browser tests require Python, Playwright and compatible Chromium; set `CHROMIUM_PATH` when needed, then run `python -m unittest discover -s tests/browser -v`.

Treasury Fiscal Data and the National Weather Service are the current official sources. Treasury's reporting date and the retrieval time are separate; NWS source update times are shown when supplied. The cache is in memory and resets when the server stops. Live data requires network access and an identifying NWS user agent; no market feed, audio, billing, or publishing is active. Demonstration stories are fictional and general reference links do not substantiate them. A focused automated accessibility audit cannot replace assistive-technology testing. The reference prototype was inaccessible through the configured network proxy, so exact visual parity is unverified.

## Regression acceptance and recovery

Foundation 001 development acceptance and merge are historical facts confirmed by the owner. The owner-reported original DL-006A Windows checks are recorded above and in the runbook. The checklist concerns changed versions and future production use; W1 Linux checks do not claim a fresh Windows run or exact prototype parity.

- [ ] Recheck changed desktop/mobile layouts, keyboard access, contrast, assistive technology, and physical browser zoom on target devices.
- [ ] Run current automated checks and physically recheck Windows startup, Treasury data and NWS weather with a valid contact.
- [ ] Compare changed views against the authorized prototype where available and record new milestone acceptance.
- [ ] Confirm rights, corrections, editorial approval, security, and operational controls before any public deployment.

Production use still requires separately accepted rights, security, operational and accessibility checks. Future paid services require separately approved cost limits, quotas and alerts; no paid API is enabled here. Never publish unreviewed generated news or commit credentials. To recover locally, stop the server, check `git status`, preserve uncommitted work, and start from a separately reviewed known-good commit in a new checkout or worktree. Do not reset a checkout containing unreviewed work. The hosting-neutral staging and rollback procedure is prepared in [the deployment runbook](docs/DEPLOYMENT_RUNBOOK.md); executing an external release still requires separate manual authorization.

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

## Fictional daily edition preview

DL-004A adds internal daily edition assembly under `src/editions`. `npm run edition:fixture` prints a clearly fictional JSON preview with edition date/status, eight ordered sections, selected story revisions, attribution and evidence uncertainty. It does not replace the homepage or add an HTTP/admin endpoint. Empty sections remain empty; weather and Treasury continue as separate official-data panels.

Only the latest newsroom `APPROVED` story revision with a matching revision-specific approval and eligible managed fictional sources can be placed. Evidence must be `VERIFIED`; disputed source metadata, including a syndicated original, is rejected. An `UNVERIFIED` source flag alone is not proof of truth, and AI proposal readiness alone is insufficient. Placement copies the current editorial headline/summary and captures evidence, provenance, policy and retention references. Ordering and the optional featured story are explicit choices, with duplicate placements rejected.

Edition edits and review decisions append revisions; editing resets readiness to `ASSEMBLING`. Reviewer assertions remain unauthenticated, and no edition state grants publication permission. Story changes, ineligible rights or retention cleanup invalidate and scrub affected edition history, including copied payload and reviewer assertions. There is no scheduling, live ingestion, model request, voice generation, billing or public publication in this milestone. See [edition design](docs/EDITION_DESIGN.md) for eligibility, lifecycle and preview limitations.

## Development edition page

DL-004B adds an opt-in fictional reader view at http://localhost:3000/dev/edition. Start it locally with both exact settings:

```bash
NODE_ENV=development DAYLINE_DEV_EDITION=fictional npm start
```

PowerShell:

```powershell
$env:NODE_ENV = 'development'
$env:DAYLINE_DEV_EDITION = 'fictional'
npm.cmd start
```

The page, its CSS/JavaScript and its preview response are gated together. They are unavailable in production and require a loopback request with an allowed local Host. No arbitrary edition ID, repository path or query selector is accepted. The server creates an isolated temporary repository from the existing fictional fixture, using current runtime timestamps and the normal managed-rights/newsroom-approval rules; its edition date follows `America/Chicago`. It does not read an existing newsroom repository. A failed or expired fixture produces an unavailable state.

The view preserves the eight section order, featured placement, attribution, uncertainty/counterevidence disclosures and internal review label. It uses safe text rendering, responsive layouts, keyboard navigation, visible focus and reduced-motion styling. “Audio briefing — coming soon” is plain placeholder text. The existing homepage and official-data panels retain their defaults.

Each preview request revalidates edition eligibility and returns only allowlisted display fields, without internal IDs, policy grants, reviewer assertions or audits. Browser display lasts at most 15 seconds per response and is cleared on expiry, failure, page hiding or navigation; no browser storage is used. This is a local fictional presentation, not publication or a production administration interface. See [edition design](docs/EDITION_DESIGN.md) for route details and retention limits, and the [DL-004B validation report](docs/DL-004B_VALIDATION.md) for executed checks and remaining acceptance work.

## Local preparation scheduler

DL-004C adds explicitly invoked scheduling under `src/scheduling`. It computes local-calendar occurrences and coordinates preparation of a new `ASSEMBLING` edition. It starts no worker, interval timer or HTTP endpoint and grants no approval/publication authority. Inspect the isolated fictional fixture with:

```bash
npm run schedule:fixture
npm run schedule:fixture -- --apply-fixture
```

The default evaluates a temporary fixture in dry-run mode; the explicit apply flag exercises only that temporary fictional repository. Neither command accepts a production repository path or makes provider/model calls. Schedules default to disabled and use canonical IANA timezones, `HH:mm` local time and selected local weekdays (`0` Sunday through `6` Saturday). Spring-forward missing times are skipped; fall-back repeated times use the earlier instant once. Evaluation records only the latest due occurrence, marks coalesced older backlog and sends an occurrence outside its catch-up window to `NEEDS_ATTENTION`.

Manual claim/begin/prepare operations use bounded attempts and expiring, fenced local claims. Pause cancels pending work; resume starts with the next future occurrence rather than replaying the paused interval. Preparation receives an explicit ordered placement list, reuses edition eligibility and never overwrites an existing manual edition. Empty assembly is allowed, while retention review holds block preparation. Runs store coordination metadata and an edition revision link, not licensed story content. See [edition design](docs/EDITION_DESIGN.md) for exact DST, retry, recovery and production limitations, and the [DL-004C validation report](docs/DL-004C_VALIDATION.md) for executed local checks.

## Internal access-control foundation

DL-005A adds a provider-independent trusted session-verifier boundary and explicit role permissions for internal editorial operations. The supplied verifier signs only synthetic local fixture credentials with an in-memory HMAC key. No real identity provider, login page, authentication route, production account, credential configuration or publishing permission is enabled.

The opt-in `AuthenticatedEditorial` facade revalidates current identity/session/roles under the repository lock and again after the replacement file is synced, before its atomic rename. It records separate receipts binding an opaque verified actor to the exact resource revision. Existing direct fixture services and historical reviewer strings remain unauthenticated; they are not silently upgraded by the new layer. Administrator permissions manage access/schedules without automatically granting editorial approval.

The repository stores identity/session metadata, bounded security events and action receipts, never raw credentials or verifier secrets. Synthetic fixture setup and deterministic checks use the existing `npm run check`; there is no production bootstrap or public administration command. See [security design](docs/SECURITY_DESIGN.md) for the permission matrix, revocation/transaction boundaries and production blockers, and the [DL-005A validation report](docs/DL-005A_VALIDATION.md) for executed checks.

## Isolated authenticated HTTP development tests

DL-005B adds a dedicated loopback listener for synthetic editorial tests. It is disabled by default, requires explicit development opt-in and is not started by `npm start`. The public homepage, official-data endpoints and existing fictional reader route keep their behavior. The production identity-provider boundary remains disabled.

The private test client uses an Authorization bearer header; there are no login, token-minting, role-management or publishing endpoints. Each mutation passes through the authenticated facade with current roles, explicit resource assignments, expected revisions and a final commit guard. An administrator receives no automatic editorial approval permission. Existing direct fixture services remain trusted internal development code, not production authorization.

Use the deterministic security/HTTP tests through `npm run check`; they create and dispose temporary repositories/listeners and keep invented credentials in memory. Never paste a credential into a URL or print it for manual testing. See [security design](docs/SECURITY_DESIGN.md) for the trust diagram, endpoint policy, legacy bypass inventory and Windows acceptance instructions, and [DL-005B validation](docs/DL-005B_VALIDATION.md) for actual executed checks and remaining production requirements.


## Isolated public-reader release artifact

DL-006A prepares a hosting-neutral read-only runtime without activating external hosting. `npm run build:public` creates `dist/public-reader`; `npm run inspect:public` checks its inventory, hashes and import boundary. The artifact uses Node.js **22.16.0**, contains no runtime npm dependencies, and starts with `node --experimental-strip-types src/public/main.ts` from its own directory. Its manifest records source commit/tree, actual file hashes and whether the source checkout was dirty. A release candidate must be rebuilt from the clean reviewed commit and inspected before transfer. The builder refuses to overwrite an existing output directory.

The public entry point is separate from the development `server.ts` wrapper. Its package contains only public-reader modules, official-data/cache adapters, the four existing reader assets, minimal package metadata and the provenance manifest. It excludes the newsroom, editorial/security/scheduler services, development fixtures, development edition assets, tests, `.git`, local databases, environment files and development dependencies. There are no login, internal administration, editorial mutation or publishing routes. Existing fictional demonstration stories stay labeled; market and audio placeholders do not fabricate data.

Public startup validates development/staging/production configuration. The default bind is loopback; a platform listener must be selected explicitly. Staging/production require compliant NWS identification and reject development/synthetic activation flags. `/api/health` reports process health, while `/api/ready` uses only observed fresh Treasury/NWS outcomes and readable assets, performs no upstream probes and returns 503 for unknown, failed or stale required observations. A healthy process does not imply working upstream sources. Restarting clears the in-memory observations/cache and starts readiness at 503 again.

See [the deployment runbook](docs/DEPLOYMENT_RUNBOOK.md) for the configuration matrix, safe local/Windows checks, reverse-proxy and unprivileged-account requirements, staging authorization gate, rollback and recovery. [DL-006A validation](docs/DL-006A_VALIDATION.md) records actual local tests and artifact evidence. No image publication, public deployment, DNS/firewall change, identity-provider activation, news publishing, paid API or payment service is authorized by this milestone.
