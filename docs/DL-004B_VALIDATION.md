# DL-004B local validation

Executed 2026-11-05 (America/Chicago) in `/workspace/Dayline-dl004b`, branch `feature/dl-004b-edition-presentation`, starting at verified remote-main commit `ac22a94ec4b0bdfe7f4f1c8c79a6931f9ae447eb`. The resulting local commit SHA is recorded in the handoff and `git log -1`. This milestone authorizes local implementation, testing and a local commit only.

## Reader view and boundary

`/dev/edition` presents the existing fictional daily-edition content with Dayline masthead, Chicago edition date/timezone, explicit fictional/development/unpublished labels, editorial status, all eight ordered sections, a featured story, ordered cards, source attribution, uncertainty and counterevidence. Empty sections contain no invented stories. The audio area says “Audio briefing — coming soon” and has no playback control, media or provider call.

The existing homepage assets, Treasury/NWS adapters, cache and default navigation are unchanged. The edition uses isolated HTML/CSS/JS and the existing DL-004A service/preview domain. The display DTO excludes internal edition/story/source/evidence IDs, policy snapshots, reviewer assertions and audit records. Revalidation occurs for every preview request; invalidation, expiry, quarantine, redaction and retention holds deny content. The server validates and recursively copies only allowed display fields, including rejecting custom-array prototypes, methods and accessor indices before iteration.

Both exact environment values are required:

```bash
NODE_ENV=development DAYLINE_DEV_EDITION=fictional npm start
```

The Node process does not automatically read `.env` files. The CLI binds to IPv4 loopback when this view is enabled. Every development request also requires a loopback socket and a local Host (`localhost`, `127.0.0.1` or `[::1]`); cross-site browser requests, query selectors and unknown paths are rejected. `NODE_ENV=production` disables the routes even with the fictional flag set. These gates are development isolation, not production authentication.

| Route | Purpose |
| --- | --- |
| `/dev/edition` | Fictional reader HTML. |
| `/dev/edition/edition.css` | Isolated stylesheet. |
| `/dev/edition/edition.js` | Safe DOM renderer and display-expiry handling. |
| `/dev/edition/preview` | Fresh display-only JSON. |

There are no edition selectors, arbitrary repository paths or approval/publication endpoints. Runtime bootstrap creates one temporary repository using the existing fictional statements, active registered rights, provenance and actual newsroom approval transitions. Runtime dates use America/Chicago; fixed offline fixture defaults remain unchanged. No captured rights are extended or rewritten. Inactive fictional policy makes the view unavailable. Graceful server close removes its temporary repository; crashes and external copies remain outside that cleanup guarantee.

Responses use `Cache-Control: no-store`, restrictive CSP, `nosniff`, no-referrer and same-origin resource policy. Attribution is restricted to safe HTTPS `.test` URLs; story text uses `textContent`, never trusted HTML. The browser uses no persistent content storage. A display lease is at most 15 seconds and cannot exceed the source deadline; elapsed request/render time is subtracted. Normal leases renew before expiry while preserving focus for unchanged content. Failure, expiry, hidden visibility and page exit clear content and metadata. Short near-expiry leases expire without rapid polling.

## Executed results

| Check | Actual outcome |
| --- | --- |
| Locked installation | `npm ci` passed; 3 existing development packages installed, with no dependency/lockfile changes. |
| CI runtime | Node **22.16.0**, npm **11.9.0**. |
| TypeScript | **5.9.3**, `tsc --noEmit` passed through `npm run check`. |
| Browser script syntax | Existing `app.js`/`stories.js` plus new `edition.js` passed. |
| Backend/domain/security tests | **304 passed, 0 failed, 0 skipped, 0 cancelled**; existing 282 plus 22 new tests. |
| Chromium regressions | **18 passed, 0 failed, 0 skipped**: 11 new edition tests plus the original 7 homepage regressions; final run 18.884 seconds. |
| Accessibility | axe-core **4.10.3** reported **0 violations** across the tested loaded, empty and unavailable states (WCAG 2 A/AA, 2.1 A/AA and 2.2 AA tagged rules). |
| CLI startup and isolation | 10 HTTP outcomes passed across production-disabled and explicitly enabled processes. Both terminated cleanly and removed isolated fixture files. |
| Whitespace | `git diff --check` passed. |
| Scope/dependencies/credentials | Approved presentation, fixture, test and documentation changes only; no new dependency or credential-pattern findings. |
| Protected worktrees | All 10 matched branch, HEAD, status, staged/unstaged diffs, tracked-path inventory and file hashes. Original checkout retained the same 15 staged files. |

New backend coverage consists of 14 projection/HTTP tests and 8 DTO/lifecycle boundary tests: current approved fixture projection; per-request freshness; expiry, retention holds and cleanup; post-snapshot expiry; short leases; lazy/concurrent initialization and disposal; exact environment/Host/peer/query/method gates; static restrictions; safe headers/HEAD; nested private-field stripping; malicious array/getter rejection; and the Chicago midnight date boundary. Existing tests were preserved without weakening their assertions.

The new browser suite checks rendering/featured placement, all sections and empty states, attribution/uncertainty/counterevidence, four responsive widths, keyboard skip/section navigation, reduced motion, XSS-resistant text and unsafe-link rejection, unavailable/invalidated/expired clearing, privacy/storage absence, unchanged-refresh focus preservation, and targeted accessibility states. The original seven homepage/official-panel tests remain unchanged.

During development the tests found a hostile-Host test-transport normalization issue, custom-array validator bypass, hidden navigation left after expiry and overflow at 400% CSS enlargement. The test transport was corrected to send the actual Host header; the data validator and presentation issues were fixed with regression assertions retained. Sandboxed loopback/browser execution initially returned `EPERM`; completed checks used authorized local execution permissions without altering network policy.

## Layout and accessibility evidence

Responsive checks passed at **390, 768, 1440 and 1920 pixels**. **200%/400% CSS enlargement** and **720/360-pixel equivalent reflow** passed with no horizontal overflow; enlarged masthead, story/context, navigation and footer were inspected. Native Chromium zoom could not be established in this automation environment: headless keyboard/native preferences did not change the layout viewport or DPR. These results therefore do not claim native browser zoom verification. Desktop/mobile and final 400%-CSS screenshots were visually reviewed.

The reader uses semantic heading/section order, named navigation, visible focus, skip-to-content, 44-pixel link/button targets, textual status labels and restrained green/cream/gold styling. Counterevidence and uncertainty are adjacent to the story; there are no third-party images, fonts or media requests.

Screenshots are generated by the committed tests at:

- `/tmp/dayline-004b-desktop.png`
- `/tmp/dayline-004b-mobile.png`
- `/tmp/dayline-004b-zoom400.png`

These session artifacts are not committed and can be regenerated. Automated accessibility checks are targeted evidence, not assistive-technology testing or a full accessibility certification.

## Startup smoke evidence

| Configuration/request | HTTP |
| --- | --- |
| Production + fictional flag: `/api/health` | 200 |
| Production + fictional flag: `/` | 200 |
| Production + fictional flag: `/style.css` | 200 |
| Production + fictional flag: `/dev/edition` | 404 |
| Production + fictional flag: `/dev/edition/preview` | 404 |
| Production + fictional flag: `/dev/edition/edition.js` | 404 |
| Explicit development: `/dev/edition` | 200 |
| Explicit development: `/dev/edition/edition.css` | 200 |
| Explicit development: `/dev/edition/edition.js` | 200 |
| Explicit development: `/dev/edition/preview` | 200 |

The positive display was fictional, unpublished, America/Chicago, and used only existing fixture content. No live Treasury, NWS or news-provider request was used as evidence; official-panel automated responses are test doubles.

## Reproduction

Prerequisites: Node 22.16.0+, npm 10+, Python Playwright and Chromium. Tested Python **3.12.14**, Playwright **1.62.0**, Chromium **155.0.8059.79**, axe-core **4.10.3**. The optional local axe bundle can be prepared with `npm install --prefix /tmp/dayline-axe --no-save axe-core@4.10.3`, or set `AXE_PATH` to a local `axe.min.js`. Set `CHROMIUM_PATH` if Chromium is not `/usr/bin/chromium`.

```bash
npm ci
npm run check
npm run typecheck
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v
git diff --check
NODE_ENV=development DAYLINE_DEV_EDITION=fictional npm start
# Open http://localhost:3000/dev/edition
```

Exact-runtime commands used here:

```bash
npx --yes --package=node@22.16.0 -c 'node --version && npm --version && npm ci && npm run check'
npx --yes --package=node@22.16.0 -c 'PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/browser -v'
```

The final suite logs are `/tmp/dayline-004b-final-check.log` and `/tmp/dayline-004b-browser.log`; locked-install evidence is `/tmp/dayline-004b-locked-check.log`. Temporary evidence may not survive environment replacement. No separate security script is claimed: HTTP/privacy/XSS/route-isolation checks are part of the actual backend and browser commands above. GitHub Actions itself was not run or inspected in this local-only milestone.

## Changed-file inventory

| File | Purpose |
| --- | --- |
| `.env.example` | Commented opt-in configuration. |
| `README.md` | Local usage, prerequisites and historical acceptance clarification. |
| `docs/ARCHITECTURE.md` | Safe reader projection and route isolation. |
| `docs/EDITION_DESIGN.md` | Presentation, lifecycle and browser lifetime contracts. |
| `docs/ROADMAP.md` | Local presentation work and outstanding acceptance. |
| `docs/DL-004B_VALIDATION.md` | This report. |
| `fixtures/editorial-fiction.ts` | Optional validated runtime timestamp; default fixture unchanged. |
| `fixtures/edition-fiction.ts` | Pass optional fixture timestamp through approval. |
| `package.json` | Include new browser script syntax in existing check command. |
| `server.ts` | Gated reader routes, safe responses and graceful cleanup. |
| `public/edition.html` | Semantic fictional edition page. |
| `public/edition.css` | Isolated responsive, zoom-aware newspaper design. |
| `public/edition.js` | Safe rendering, accessible navigation and expiry/focus handling. |
| `src/editions/presentation-types.ts` | Reader-only DTO contract. |
| `src/editions/presentation.ts` | Revalidated projection, sanitizer and temporary fixture lifecycle. |
| `tests/edition-presentation.test.ts` | Projection, HTTP, gating and official-contract regressions. |
| `tests/edition-display-boundary.test.ts` | DTO privacy, malicious arrays, disposal and timezone tests. |
| `tests/browser/test_edition.py` | Edition rendering, layout, keyboard, XSS, expiry and axe coverage. |

## Remaining acceptance and restrictions

No locally available automated validation blocker remains. Native/physical browser zoom, Windows physical acceptance and assistive-technology testing remain pending; CSS enlargement and equivalent reflow are the automated evidence available here.

Foundation 001's development milestone was previously accepted and merged, as confirmed by the owner. New production/accessibility or DL-004B physical acceptance requirements do not reverse that historical acceptance. Live Treasury/NWS regression checks, Windows physical testing, assistive technologies, real-provider/derived-content licensing, production authorization/storage and external-copy retention controls remain separate work. Local deletion and browser clearing are not secure erasure or instantaneous remote revocation.

Only authorized read-only remote reference inspection/fetch occurred. No pushes, PRs, merges, resets, tags, releases, deployments, paid AI calls, real news ingestion, voice generation, publication, scheduling or Stripe activity were performed. Stop after the authorized clean local commit for review.
