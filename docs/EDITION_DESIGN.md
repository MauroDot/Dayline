# Dayline — Internal daily edition design

DL-004A assembles manually selected, reviewed fictional stories into a structured daily edition for internal inspection. DL-004B adds a separately gated development reader view over a temporary known-fictional fixture. Neither milestone schedules, publishes or distributes real news, calls an AI provider, generates voice, or changes the public homepage defaults. There is no production edition administration endpoint or reviewer authorization.

## Domain and deterministic assembly

An edition has an ID, valid `YYYY-MM-DD` calendar date, timezone, revision, status and creation/update timestamps. The timezone is canonicalized through `Intl`; the date/canonical-timezone pair identifies one daily edition, including rejected or invalidated history. Edits create revisions of that identity rather than another edition for the same date. Each active revision contains eight canonical sections in this order:

| Section ID | Label |
| --- | --- |
| `TOP_STORIES` | Top Stories |
| `US` | U.S. |
| `WORLD` | World |
| `POLITICS_GOVERNMENT` | Politics & Government |
| `BUSINESS_MARKETS` | Business & Markets |
| `TECHNOLOGY` | Technology |
| `SCIENCE` | Science |
| `HEALTH` | Health |

Empty sections remain present and empty. Placements preserve explicit selection/order within each section; the service does not choose news, optimize engagement or apply political preferences. A story may appear only once across the whole edition. At most one placement may be featured, and only in Top Stories. Featured status is an explicit editorial selection, not automatic truth or importance scoring. An edition with no placements can be assembled, but cannot enter `NEEDS_REVIEW` or `READY_FOR_APPROVAL`. Local bounds allow at most 100 placements, 64 captured sources per placement and 16 evidence entries per story.

Each placement captures the exact story revision and its editorial headline/summary, evidence support/contradiction references and uncertainty, source attribution and original-report identity, policy snapshot references/digests, source expiry and an independent-origin count. The edition does not fetch or duplicate provider article bodies or invent a story for an empty section. Treasury debt and NWS weather remain separate official-data panels.

## Eligibility boundary

A placement is accepted only when:

- The requested story revision is the exact latest revision, in newsroom `APPROVED` state, with a matching revision-specific newsroom approval.
- The story is not retention-redacted and the repository is not under a retention-review hold.
- Required evidence is marked `VERIFIED`, has identifiable support and retains its supporting/contradicting source references.
- Referenced sources have eligible managed fictional `.test` records and exact active registered policy snapshots permitting licensed excerpts and internal analysis; no source or governing syndicated original is marked `DISPUTED`.
- Applicable source retention and policy deadlines have not passed, and sources are neither quarantined nor otherwise ineligible.

AI proposal `READY_FOR_APPROVAL` is insufficient: proposals and editions cannot approve their own newsroom stories. The current fixture uses an explicitly fictional policy with the required rights, but edition assembly does not require or infer AI summarization permission. No real provider has an approved grant. `Evidence.verification: VERIFIED` is required; `Source.verification: UNVERIFIED` alone does not prevent otherwise eligible placement or prove the evidence true. Disputed source metadata is rejected. Verification/reviewer labels remain prior local assertions rather than authenticated proof or a new determination of truth.

Syndicated copies retain their originating report identity. Independent-source counts deduplicate those identities, so several syndicated URLs do not become independent confirmations. This count depends on correct stored provenance and is not proof of editorial independence.

## Revision and review lifecycle

The main path is `ASSEMBLING → NEEDS_REVIEW → READY_FOR_APPROVAL`. There is no edition `PUBLISHED` state.

| Current state | Allowed review transitions |
| --- | --- |
| `ASSEMBLING` | `NEEDS_REVIEW`, `ON_HOLD`, `REJECTED` |
| `NEEDS_REVIEW` | `READY_FOR_APPROVAL`, `REVISION_REQUESTED`, `ON_HOLD`, `REJECTED` |
| `READY_FOR_APPROVAL` | `REVISION_REQUESTED`, `ON_HOLD`, `REJECTED` |
| `REVISION_REQUESTED` | `NEEDS_REVIEW`, `ON_HOLD`, `REJECTED` |
| `ON_HOLD` | `NEEDS_REVIEW`, `REVISION_REQUESTED`, `REJECTED` |
| `REJECTED` | None; it cannot be edited. |
| `INVALIDATED` | None; fresh content must be explicitly reassembled. |

Creation, content edits and accepted review decisions record edition revisions. Editing placements, order or featured selection resets readiness to `ASSEMBLING`; removing a placement cannot preserve an old readiness decision. Review records identify the prior/next edition revisions and states, timestamp and actor assertion with `unauthenticated: true`. The assertion is a restricted label, not authentication, authorization or production approval.

Mutations check an expected current revision. Cooperating concurrent writers serialize through the existing local JSON lock; once one edit commits, an operation expecting the old revision is stale. Eligibility uses a fresh timestamp after acquiring the lock, so waiting cannot preserve an expired placement or review decision. Each newsroom mutation also validates and captures its injected clock once under the lock for consistent revision, approval and audit timing. Edition updates, review records and procedural audit events commit atomically rather than leaving a partially updated edition after a storage failure. A denied action may still persist necessary invalidation and a generic denial audit, with no partial requested edit. These are single-host development guarantees, not multi-host transactions or production audit protection.

`READY_FOR_APPROVAL` means that an internal edition review step is ready for a separate authorization process. It grants no public publishing permission and does not alter source verification or bypass newsroom revision-specific approvals. No scheduling or publication method is implemented.

## Advisory presentation checks

Active edition revisions store named review suggestions for:

| Suggestion | Review concern |
| --- | --- |
| `UNSUPPORTED_HEADLINE` | Editorial headline support requires review. |
| `MISLEADING_PROMINENCE` | Featured placement may overstate the supporting evidence. |
| `MISSING_ATTRIBUTION` | Source attribution is absent or incomplete. |
| `MISSING_UNCERTAINTY` | Material evidence uncertainty is not represented in the summary. |
| `UNDISCLOSED_CONTRADICTIONS` | Conflicting evidence needs disclosure. |
| `SYNDICATED_REPETITION` | Repeated originating coverage may appear independent. |
| `HEADLINE_ARTICLE_CONFLICT` | Headline and article/evidence framing may conflict. |
| `OPINION_AS_FACT` | Opinion or evaluation may be presented as fact. |

These are transparent advisory checks, not political truth judgments, automatic story selection or a neutrality score. They do not require artificial equal weight for all positions or suppress well-supported controversial findings. No flag and an empty flag list both require contextual human judgment; neither establishes accuracy or neutrality.

## Rights, retention and invalidation

Snapshot references do not grant new rights. Current story revision, newsroom approval, source eligibility, policy snapshots and expiry must remain valid. Story edits/transitions, policy expiry/revocation, quarantine, redaction or a retention-review hold invalidate affected snapshots. Every stored revision is revalidated, not just the latest preview: copied headline/summary, attribution, evidence uncertainty and story/source/policy links are removed from each ineligible historical revision. Review actor assertions for an affected edition are redacted. A whitelist leaves the edition identity, date/timezone, revision and safe timing plus `INVALIDATED` state and a generic reason. This scrubbing is an explicit exception to ordinary append-only content revisions; unaffected lawful snapshots may remain.

An invalid edition cannot become ready again through review transitions or by replaying its old snapshot. It may be edited with a complete fresh placement list: every placement is revalidated and a new `ASSEMBLING` revision must pass review again. Rejected editions cannot be reopened. A repository retention-review hold still prevents eligible placements/readiness and cannot be cleared through this edit path.

Edition service reads/preview and mutations revalidate lifecycle state; plain JSON reads do not run a background cleanup. Applied retention cleanup uses the same transaction for source/history removal and edition invalidation. These checks do not enforce deletion across backups, snapshots, external copies or fresh repositories. JSON replacement is logical removal, not secure erasure. Existing retention-review holds have no application operation to clear them.

## Persistence and preview

Schema 5 adds edition revisions and edition-review collections. Reading schemas 1–4 migrates in memory without rewriting the file; existing sources, stories, approvals, audits and editorial proposals are preserved. Schema 1/2 remains held for retention review; schema 3/4 preserves its existing hold. The next successful transaction persists schema 5.

```bash
npm run edition:fixture
```

The command seeds a temporary fictional repository with a fixed fixture clock, prints JSON and removes its directory afterwards. It accepts no arguments, user repository path or live/public mode and makes no provider request.

The preview is labeled `fictional`, `developmentOnly` and `publiclyPublished: false`, with edition date/status, review label, canonical section order, placements, attribution, uncertainties, explicit counterevidence disclosure and stored advisory suggestions. It omits random edition IDs and wall-clock timestamps for repeatability; story/source references remain fictional fixture identifiers. Preview serialization is stable for the same stored revision. An invalidated preview contains its status/reason and no sections or copied payload. It does not expose raw reviewer assertions, render an administration page, publish an edition or replace the public design. Suggestions retain their codes and explanatory messages; they are not a political or truth score.

## Opt-in development reader view

Enable both settings in the server process:

```bash
NODE_ENV=development DAYLINE_DEV_EDITION=fictional npm start
```

Open `http://localhost:3000/dev/edition` locally. `.env.example` documents the values but is not automatically loaded. Production mode always disables this surface, even if the fictional toggle is set. The CLI fixture above remains a separate offline JSON command.

| Gated path | Purpose |
| --- | --- |
| `/dev/edition` | Fictional reader HTML. |
| `/dev/edition/edition.css` | Isolated presentation styles. |
| `/dev/edition/edition.js` | Read-only rendering and display-expiry handling. |
| `/dev/edition/preview` | Fresh, allowlisted fictional display DTO. |

Every path requires an enabled development process, loopback peer and an allowed local Host. Cross-site browser requests, query selectors and unknown paths are rejected. The surface has no arbitrary repository path, edition ID selector or approval/publication operation. Its assets are not added to the public static-file allowlist; the existing homepage and official-data endpoints retain their behavior.

The presentation source seeds a new temporary repository using the existing invented statements, managed policies, provenance and actual internal newsroom approval transitions. Runtime use supplies the current clock rather than backdating rights, with the edition date calculated in `America/Chicago` rather than from the UTC calendar date. Default deterministic fixture clocks/UTC metadata remain unchanged for offline tests/CLI. If the governing fictional policy is no longer active, the page cannot obtain eligible display content. No existing newsroom file or real provider is read. Normal server close removes the temporary fixture; this is not secure erasure or cleanup of crash leftovers.

## Display data and browser lifetime

Each request obtains a new edition-service snapshot and revalidates its current story/approval, rights and retention eligibility. An expired or invalidated edition yields no retained story text. The safe DTO contains only fictional/development/publication labels, edition date/timezone/revision/status/review label, canonical sections, headline/summary/featured flags, publisher URLs, uncertainties and counterevidence display fields. Attribution links must be HTTPS fictional `.test` URLs without embedded credentials or secret query parameters. It excludes internal edition/story/source/evidence IDs, origin/policy snapshots, reviewer assertions and private audit events.

The page preserves section/card order and a featured story without generating content for empty sections. It presents attribution, uncertainty and recorded counterevidence near the story. All content is clearly fictional. The separate audio area says “Audio briefing — coming soon”; it has no fake playback control or generated voice. The view uses semantic headings/landmarks, a skip link, keyboard section navigation, visible focus, responsive reflow, readable contrast, reduced-motion handling and textual status labels.

Story text is rendered as text, never trusted HTML. The page and responses use no-store and restrictive browser security headers. No local storage, session storage or other persistent browser story cache is used. A response permits display for at most 15 seconds, capped by the underlying source deadline. The client measures that interval from request dispatch, so transfer/validation time does not extend it; expired responses cannot render after a slow request. It clears content on expiry, fetch/validation failure, hidden visibility and page exit; fresh display requires a new valid response. This lease does not extend rights or provide instantaneous remote revocation of text already delivered.

The local-only gate is not authentication or production authorization. A previously delivered response can be copied outside the application, and browser timers are not secure erasure. The existing limitations around screenshots, backups, external copies, crash leftovers and filesystem access remain. No unauthenticated production administration, live news feed or public publication has been added.

## Validation and production requirements

```bash
npm ci
npm run check
npm run typecheck
python -m unittest discover -s tests/browser -v
git diff --check
```

`npm run check` includes TypeScript, public-script syntax and deterministic backend/domain checks. Browser checks require Python Playwright and Chromium; see README for `CHROMIUM_PATH`. The [DL-004B validation report](DL-004B_VALIDATION.md) records executed checks and remaining acceptance work. New viewport, keyboard, reduced-motion, contrast/audit and 200%/400% zoom coverage must be reported only when executed; automated checks do not replace physical browser zoom or assistive-technology acceptance.

The owner confirmed that Foundation 001's development milestone was accepted and merged previously. Remaining checks concern this new presentation and future production use; they do not reverse that historical acceptance. No new physical acceptance, exact prototype parity, live-source compatibility or production readiness is established by the fictional view alone.

Production work remains blocked pending authenticated reviewer identities and permissions, actual provider/derived-content contracts, durable transactional persistence, retention enforcement for all copies, operational monitoring/recovery, independent security/editorial review and explicit publication authorization. Scheduling, paid AI, narration, Stripe and public distribution are outside this milestone.
