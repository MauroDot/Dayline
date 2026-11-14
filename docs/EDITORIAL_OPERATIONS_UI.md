# Internal editorial operations interface

DL-007E is a development-only interface for the existing authenticated editorial workflow. It uses the schema-7 newsroom repository and existing resource policy, source-review, source-handoff, story and edition services. It does not grant publication authority or turn an accepted provenance recommendation into an approved story.

## Start the fictional local harness

Use Node.js **22.16.0**, a compatible npm version, Python with Playwright, a compatible Chromium executable and a graphical desktop session for the headed launcher. The automated acceptance suite uses headless Chromium; this cloud shell has no configured display server. The validation report records the actual npm version used. Install the pinned npm development dependencies before starting:

```bash
npm ci
npm run editorial-operations:dev
```

Set `PYTHON` to an interpreter path if needed; the default is `python3` on POSIX and `python` on Windows. Set `CHROMIUM_PATH` if Chromium is installed somewhere other than `/usr/bin/chromium` (including a Windows executable path). Python Playwright and the browser are existing development prerequisites, separate from the locked npm dependencies. The command starts its own disposable fictional repository, private development loopback listener and headed browser. It invokes `--fictional`, with no production repository or live-provider argument. Browser close or controlled shutdown stops its owned processes and removes its temporary repository; missing interpreter/browser fails safely with the same cleanup.

The fixture labels its fixed historical evaluation time. That clock keeps fictional rights and expiry cases reproducible; it does not establish current rights for real news or change government-data timestamps. Choose a synthetic role and explicitly connect. Fixture accounts are test identities, and switching role is a trusted local demonstration rather than authentication against a real identity provider. Refreshing starts disconnected and does not restore a draft.

The listener is separate from `npm start` and requires explicit development enablement plus `operationsUI: true`. Serving the static shell does not grant access to any record. There is no public login, credential bootstrap/minting endpoint or production listener. Never adapt the fictional harness by inserting real accounts, credentials or a production repository.

For an offline demonstration without a browser, run:

```bash
npm run editorial-operations:fixture
```

This invokes the same runner with `--fictional --demo`. It creates and removes its own temporary fictional repository, prints only allowlisted fictional workflow outcomes and starts no listener or provider request. It demonstrates recommendation insufficiency, self-confirmation denial, independent confirmation, explicit preparation, separate story approval and an edition remaining `ASSEMBLING`. No credentials or private repository data are printed.

## Credential handling

The trusted Node harness sends synthetic bootstrap to its Python browser child through an anonymous stdin pipe. The browser exposes a trusted local development binding, `daylineDevelopmentCredential(role)`, which the page calls only after explicit connection. Without that binding, a password field accepts an already issued synthetic development credential through a trusted out-of-band path and erases the field immediately on connection; it does not issue credentials. The selected bearer remains in the interface's closure memory and is attached only to the Authorization request header. Test controls also use private process pipes; they are not HTTP endpoints.

Do not put credentials in URLs, command arguments, environment variables, files, logs, screenshots, cookies, localStorage or sessionStorage. There is no persistent credential or draft recovery. Logout or authentication loss clears protected display state, source selections and authored text. Page lifecycle changes and short leases clear old projections; cancellation and request generations reject late replies from a previous connection. An authorized user may keep unsent prose in memory after a stale-action or forbidden-action error, but must inspect current state and select sources again before retrying.

The local automation and fixture bootstrap are trusted code. They do not sandbox a malicious local process or browser automation extension, and the fixture role chooser is not a production login design. Browser-launch failure must stop safely rather than print a token as a fallback.

## Workflow and authority

| Area | Intended use | Existing server boundary |
| --- | --- | --- |
| Overview | Inspect the current session's roles and named permissions. | Current-session authorization; no inaccessible resource summaries or hidden counts. |
| Sources | Filter/paginate assigned metadata, inspect provenance and choose sources explicitly. | Current `SOURCE_READ` and exact source assignments, including required proof/origin reads. |
| Provenance | Begin review, supply an evidence-backed proposal, independently confirm/reject, hold/release or withdraw when permitted. | Existing DL-007C action permission, current revision and evidence checks; proposer cannot confirm their own proposal. |
| Story preparation | Supply the intended story ID, prose, claims, evidence support, verification assertion and uncertainty. | Existing exact `STORY_CREATE`, full source reads and fresh independently confirmed eligible source binding. |
| Stories | Inspect current text and workflow states, then request a permitted review transition or separate approval. | Existing exact edit/review/approval grant, current source rights/binding and revision; creation grants no ownership. Text editing is not added by this interface. |
| Editions | Explicitly assemble one selected approved story and separately request a permitted edition review transition. | Existing exact edition permission and contained story/source access; assembly and readiness are separate. |

Server-derived capability flags decide which controls are offered, but a displayed control grants no authority. Unsupported operations remain read-only rather than gaining a new permission. Administrator status does not imply editorial approval, and reporter status does not imply source-read access. Each action is checked again on the server against current identity, session, role, exact resources, revision and rights/retention state.

Follow the explicit sequence: inspect assigned metadata, make a supported recommendation, obtain independent provenance confirmation, choose eligible sources and prepare a human-authored story. Recommendations alone cannot advance a source. Confirmation is a procedural decision, not a declaration that the evidence is true. Source selection creates no headline, claim, citation, evidence support or verification assertion; the operator supplies those inputs. Each selected source must be explicitly identified as support or counterevidence. The verification checkbox starts unchecked and must be deliberately checked to meet the existing handoff contract before submission. Marking evidence verified records a human assertion under the existing model, not automatic fact-checking.

Preparation creates an `INGESTED` story. Editing/review/approval and edition assembly/readiness retain their separate permissions and exact revisions. A new story does not inherit review authority from its creator; a new edition does not inherit readiness authority from its assembler. Consequential actions require a confirmation step. No operation publishes publicly or starts an unattended scheduler.

## Freshness and safe disclosure

The private static routes are GET/HEAD `/internal/operations`, `/internal/operations/operations.css` and `/internal/operations/operations.js`. They contain no privileged records or credential. Privileged strict JSON POST projections are `/internal/operations/overview`, `/sources`, `/source`, `/stories` and `/editions`. The source-list request accepts bounded existing view/pagination fields; single-source inspection takes its ID only in the JSON body. Credentials and identifiers are not URL selectors.

The server filters current authorization before paging, counting or projecting. A private operational source record may expose its assigned source ID because existing mutation bodies require it; the earlier minimal source-queue response remains unchanged. Pending proposal proof/origin references require current read grants on their full graph. Reviewer identities, raw provider data, internal notes/audits and inaccessible relationships are omitted.

Story visibility requires an existing exact edit/review/approval operation and current reads on all bound sources/dependencies; a creation grant alone is insufficient. Stale/expired bound content is withheld. An edition is omitted if its exact operation or a contained story/source grant is absent, rather than revealing an inaccessible member or count. Source selections and revision tokens cannot override those checks.

Projection responses carry `asOf` and a display lease no longer than 1,500 milliseconds, shortened by applicable source/session deadlines. The UI expires protected display and revalidates during active use. Current server authorization still applies at every read and commit. Already submitted bytes cannot be recalled, and this lease is not distributed instantaneous revocation. Hiding a tab, logging out or losing authentication clears protected display instead of preserving a browser copy.

On stale selection or action conflict, inspect again and select fresh source revisions; a hold release does not restore an old token or immutable story binding. A lost or denied response can follow an already committed mutation, so inspect the current revision before retrying. Preserve human-authored text only in the active authorized session, never as persistent browser storage.

## Accessibility and acceptance

Use labeled semantic controls, visible keyboard focus, text status/errors and predictable focus after refreshes or dialogs. State is not communicated by color alone. The interface distinguishes loading, empty, stale, denied and unavailable states. Responsive and CSS enlargement/reflow checks are local automated evidence; they do not establish native browser zoom or assistive-technology acceptance.

Run normal validation with `npm run check` and the existing Python browser test discovery after installing its prerequisites. See [DL-007E validation](DL-007E_VALIDATION.md) for the exact commands, executed results, platform skips, artifact hashes and any remaining local blocker. Do not infer passes from this guide.

Windows physical acceptance, native zoom at 200%/400%, assistive-technology review and separately compliant live Treasury/NWS regression remain pending unless the validation report records otherwise. No formal WCAG certification or production security readiness is claimed.

## Isolation and production limits

The UI assets live in `internal/operations/`, outside `public/`, and all private code, assets, harnesses and tests remain outside the twelve-file LF public-reader artifact. The homepage and official-data panels keep the existing public runtime. The public content digest remains the required regression baseline:

`f2742749da68a8035cdb9780e35586cc6b664d95d60e3091b52e4aa9ef922e29`

The UI adds no real provider, production account, paid AI request, audio generation, payment, live ingestion, public publishing, Render operation or deployment. Existing direct trusted legacy services remain development paths and a production bypass risk until exclusive authenticated entry points are reviewed. Real identity verification/bootstrap/key management, tenant/object assignment policy, transactional storage, operational monitoring, licensing, retention across backups/external copies and independent security review require separate work and authorization. Local redaction is not secure erasure of external copies.

See [architecture](ARCHITECTURE.md#dl-007e-internal-editorial-operations-interface), [security design](SECURITY_DESIGN.md#dl-007e-internal-operations-interface) and the existing [source-to-story contract](EDITORIAL_WORKFLOW_DESIGN.md) for the boundaries this interface reuses. The previously accepted Foundation 001 development milestone remains historical acceptance of that baseline; these remaining production and physical requirements do not reverse it.
