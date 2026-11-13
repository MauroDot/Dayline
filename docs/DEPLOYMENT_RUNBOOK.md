# Public-reader staging and recovery runbook

DL-006A prepares a hosting-neutral read-only public reader. This is a procedure for a future controlled staging release, not authorization to transfer an artifact, publish an image, configure hosting/DNS/firewalls or deploy. No hosting provider is selected. The current authorized work ends with local implementation, validation and a local commit.

## Runtime and trust boundary

```mermaid
flowchart LR
  Client[Reader] --> Proxy[Separately approved TLS reverse proxy]
  Proxy --> Reader[Public reader on explicit bind/port]
  Reader --> Assets[Allowlisted read-only assets]
  Reader --> Cache[Bounded process-local official-data cache]
  Cache --> Treasury[US Treasury]
  Cache --> NWS[NWS with identifying contact]
  Repo[Development checkout] --> Dev[Loopback-only fictional edition wrapper]
  Repo --> Private[Separate opt-in synthetic editorial listener]
```

The artifact entry point is `src/public/main.ts`. The development `server.ts` wrapper, fictional edition presentation and DL-005B listener are excluded. The public process has no newsroom database, credentials/session repository, editorial mutation service, scheduler, live ingestion, model/audio client or payment client. The only product content is the existing reader interface with clearly labeled fictional demonstration stories and unavailable market/audio placeholders, plus read-only official Treasury/NWS responses.

The deployment must use the inspected artifact, not the full repository checkout. Run it under a dedicated unprivileged operating-system account, with artifact files mounted or permissioned read-only. Grant only outbound official API access and the required listener access; no application database or writable data directory is needed. No package script provisions an operating-system account, production access policy, firewall rule or supervisor. The local smoke tool temporarily changes only its generated artifact files/directories to read-only modes for validation and restores their modes afterward; that does not provision a hosting account or Windows ACL policy. The hosting owner must enforce OS/container UID, filesystem, memory/CPU and network policy. A directory artifact is the supported release format in this milestone; no OCI build, image publication or container validation is claimed.

## Artifact inventory and provenance

`npm run build:public` produces a new `dist/public-reader` directory. The builder refuses to overwrite an existing output directory; preserve an existing inspected build and use a distinct output path for another candidate. The package contains only:

- `src/public/main.ts`, `config.ts`, `reader.ts` and lifecycle support.
- `src/cache.ts` and `src/official-data.ts`.
- `public/index.html`, `style.css`, `app.js` and `stories.js`.
- A generated minimal `package.json` with Node.js 22.16.0/runtime entry metadata.
- `public-manifest.json` with sorted file hashes/sizes, content digest and source commit/tree/dirty provenance.

There are no runtime npm dependencies. `.git`, environment files, credentials, local databases, test artifacts, development dependencies, internal domains, fixture code and development edition assets are absent. Inspection verifies the exact inventory, hashes and import closure; it is not a cryptographic signature, trusted build-service attestation or substitute for reviewing the source commit.

A development build may truthfully record `sourceDirty: true` while implementation is uncommitted. Do not release such a build. After the reviewed local commit is created, build again into a new directory, verify `sourceDirty: false`, confirm the manifest commit equals the reviewed release SHA, and inspect every file. File hashes identify the actual package bytes even when comparing development builds. Build twice from the same unchanged source state to verify deterministic output; changing the commit or dirty state intentionally changes provenance metadata.

## Configuration matrix

Configuration is read from the process environment; `.env.example` is documentation and is not loaded automatically. Unknown `NODE_ENV`, malformed numeric values and incompatible options fail startup with a safe fixed error category rather than falling back to development.

| Variable | Development default | Staging/production policy |
| --- | --- | --- |
| `NODE_ENV` | `development` when absent | Set exactly `staging` or `production`; no silent fallback. |
| `HOST` | `127.0.0.1` | Loopback remains default; `127.0.0.1`, `::1`, or explicitly selected `0.0.0.0`. Wildcard binding is unavailable in development. |
| `PORT` | `3000` | Strict decimal integer 1–65535; may come from the platform. |
| `NWS_USER_AGENT` | Optional; if supplied must be valid | Required identifying application/contact string, at most 256 characters. Enter the real contact privately in process/platform settings. |
| `PUBLIC_BASE_URL` | Optional origin; HTTP or HTTPS | Optional HTTPS origin only; no credentials, path, query or fragment. It does not authorize a proxy or alter request identity. |
| `UPSTREAM_TIMEOUT_MS` | `8000` | 100–10000 per attempt, including response JSON; at most three upstream attempts. |
| `REQUEST_TIMEOUT_MS` | `15000` | 1000–60000; both the Node incoming-request timer and the explicit HTTP response deadline. |
| `HEADERS_TIMEOUT_MS` | `10000` | Incoming-header timer, 1000–30000, no greater than request timeout. |
| `SHUTDOWN_TIMEOUT_MS` | `5000` | 100–30000 graceful-close deadline. |
| `MAX_CONNECTIONS` | `128` | 1–1024 open connections. |
| `MAX_CONCURRENT_REQUESTS` | `32` | 1–128 admitted requests, no greater than max connections. |

Staging/production reject nonempty `DAYLINE_DEV`, `DAYLINE_INTERNAL`, `DAYLINE_EDITORIAL`, `DAYLINE_SYNTHETIC`, `DAYLINE_TEST` and `DAYLINE_AUTH` settings, including their underscore-prefixed option families, plus `SYNTHETIC_PROVIDER`, `TEST_BEARER_TOKEN` and `IDENTITY_PROVIDER`. Do not copy an editorial test environment into this process. The deployed public package has no provider adapter or bearer/session configuration to enable. No production secret, private contact or token belongs in Git, manifest contents, browser assets, shell output or startup logs.

The default `HOST=127.0.0.1` avoids automatic developer-machine exposure. For an approved service behind a same-host proxy, keep loopback and proxy only the selected port. If a reviewed platform/container requires listening on all interfaces, explicitly select staging/production plus `HOST=0.0.0.0` and restrict access using that platform's policy. This document does not authorize doing so on Windows or opening any firewall port. TLS termination, certificate renewal, domain ownership and proxy timeouts require a separately reviewed host configuration. The application does not trust `Forwarded`/`X-Forwarded-*` headers for identity, privileged routing or scheme decisions.

## Health, readiness and official data

| Request | Meaning |
| --- | --- |
| `GET /api/health` | The HTTP process is alive; independent of upstream success. |
| `GET /api/ready` | Assets are readable and the process has observed fresh successful required official data. It performs no upstream probes. |
| `GET /api/debt` | Cached/read-only official Treasury report or explicit unavailable state. |
| `GET /api/weather?city=Tulsa` | Cached/read-only forecast for an allowlisted city or explicit unavailable state. |

Readiness starts at 503 after each restart. It needs readable reader assets, successful Treasury data within the one-hour freshness window, and at least one observed NWS city within its 30-minute window. Every city that has been observed must still have fresh successful data; an observed failure/stale city makes readiness 503 even if another city is fresh. Unrequested cities are unknown, not falsely reported live. Readiness uses observations from ordinary API requests and does not prove current network connectivity or run an automatic polling loop. Health can remain 200 while readiness is 503. A load balancer that sends traffic only after readiness must not leave a cold process permanently unobserved: after separately authorized staging startup, the operator makes one finite `/api/debt` read and one supported `/api/weather?city=Tulsa` read with compliant NWS identification configured, records their actual HTTP/source timestamps as live evidence, then evaluates readiness. This is manual priming, not a repeating probe or fabricated test data. Use `/api/health` for liveness/restart supervision so initial or upstream-related readiness failure does not cause a restart loop. Health bypasses expensive-request admission, while readiness can return 503 at that admission limit; both still depend on available connection capacity.

A failed refresh may serve the last valid record up to the existing 24-hour stale limit with `stale: true`, preserving source date/update time, retrieval/cache timestamps and attribution. That degraded response is useful to the reader but does not establish readiness. Once no permitted cached record remains, the API returns unavailable; no debt, weather or market value is fabricated. Each official request has bounded attempts/timeouts and safe errors. The explicit HTTP response deadline is `REQUEST_TIMEOUT_MS` (15 seconds by default): on expiry the response is 503 and the relevant observed source becomes unavailable. Underlying bounded upstream work may still settle afterward; its admission slot remains held until it settles, and a late outcome does not mark readiness fresh until a later successful public read. The underlying default retry budget is approximately 24.3 seconds for Treasury and 48.6 seconds for sequential NWS point/forecast reads; configured 10-second attempts allow approximately 60.6 seconds for the latter. Review proxy response timeouts against the HTTP deadline plus a small allowance, and resource/admission limits against the longer bounded upstream work. A restart clears all local caches/observations, which may temporarily reduce upstream sharing and readiness; multiple instances do not share cache or upstream quota state.

The process emits structured whitelisted startup/failure/stop metadata and generates request correlation IDs. It does not log NWS contact strings, bearer credentials, arbitrary request targets/headers or raw provider exceptions. Preserve sanitized local logs according to the future operator's reviewed retention policy. No remote telemetry or monitoring vendor is enabled.

## Local build and verification

Use exact Node.js 22.16.0 and the existing lockfile. Repository development tools are installed only for build/test; the generated runtime package needs no `npm install`. Packaged startup validates the manifest and refuses a runtime other than exact Node.js 22.16.0 with a fixed safe error. Unpackaged development compatibility is not a release-runtime guarantee.

```bash
npm ci
npm run check
npm run typecheck
python -m unittest discover -s tests/browser -v
npm run build:public
npm run inspect:public
npm run smoke:public
git diff --check
```

Use a clean new output location if `dist/public-reader` already exists; never overwrite a protected worktree or previous release. For example, with a previously unused candidate name:

```bash
npm run build:public -- --output dist/public-reader-next
npm run inspect:public -- dist/public-reader-next
npm run smoke:public -- dist/public-reader-next
```

The default inspect/smoke commands target the default artifact; pass the candidate path as shown when validating another candidate rather than substituting files into an earlier build. The browser suite requires the documented local Playwright/Chromium/axe prerequisites. CI verifies builds/tests and never deploys from `main`. The [DL-006A validation report](DL-006A_VALIDATION.md) records commands actually executed, artifact results, runtime versions and any tooling limitations; a runbook command alone is not evidence that a check passed.

From the inspected artifact directory, the explicit startup command is:

```bash
node --experimental-strip-types src/public/main.ts
```

Set staging/production variables privately before that command. A local development smoke can omit NWS identification and confirm unavailable weather/readiness behavior; it must not present missing-source readiness as success. For compliant live checks, provide the owner's actual identifying contact without printing it, request only one debt response and a single supported weather city, and record source timestamps/HTTP status separately from deterministic fixture results. Do not activate live news ingestion or use paid providers.

## Windows local acceptance

In a fresh development shell in the isolated reviewed checkout, use Node.js 22.16.0 and `npm.cmd ci`, `npm.cmd run check`, `npm.cmd run typecheck`, `npm.cmd run build:public`, `npm.cmd run inspect:public` and `npm.cmd run smoke:public`. Use the documented Python/Chromium setup for browser regression. Start the artifact in a separate terminal on default loopback and confirm the logged host/port without exposing contact configuration. `.env.example` does not load settings by itself.

Check homepage, safe static assets and the official panels; confirm `/api/health` is distinct from `/api/ready`. Test missing-source/stale behavior and record actual current official report/update timestamps only when compliant live network checks were performed. Confirm GET/HEAD support, 404 for `/internal/principal`, `/auth`, `/api/admin`, `/src/security/http.ts` and `/dev/edition`, and 405 for a POST to an editorial-looking path. Send Ctrl+C and confirm process exit and successful restart with readiness initially unknown again. Do not open a firewall port or activate the private editorial listener.

The development checkout's opt-in fictional edition view remains available only in its documented development mode; it is not part of the artifact. Separately record Windows physical, keyboard/assistive-technology and native 200%/400% browser zoom acceptance. Automated Chromium and targeted axe checks do not certify formal WCAG conformance or establish physical acceptance. Foundation 001's previously accepted development milestone remains historical acceptance.

## Prepared staging release gate — manual authorization required

Complete and review all items before any external operation:

- Identify the reviewed clean source commit and a verified deterministic artifact; retain manifest/content hashes outside the mutable runtime.
- Review the explicit artifact inventory/import boundary and ensure no environment file, credential, local repository, fixture or internal service is present.
- Pass the automated suites, artifact startup/shutdown/isolation checks and required physical/live acceptance; record any remaining blocker.
- Select and review hosting, exact Node runtime provisioning, non-root account, read-only files, resource limits, TLS/reverse-proxy rules, outbound official API access and private NWS contact injection.
- Review display/attribution/demonstration policy, source API terms, privacy/security/accessibility and relevant retention controls.
- Prepare the prior known-good version, operator ownership, rollback decision thresholds, log access and incident/restart procedure.
- Obtain explicit owner authorization for the exact external transfer/deployment and any DNS/firewall changes. No current task, Git commit, passing CI or merge implies this approval.

Only after that authorization, place the inspected candidate in a new immutable release/version directory using the selected platform's approved process. Verify hashes after transfer, start it under the unprivileged account on an explicitly restricted port, and smoke-test directly before proxy promotion. Confirm reader/static/API method rules, internal/development route absence, health/readiness semantics, graceful termination and compliant official-source behavior. Do not send real production credentials to any synthetic/editorial route. Promote through an atomic platform release switch only after the candidate's acceptance evidence is reviewed; retain the previous version and its configuration mapping.

## Restart, rollback and previous-version recovery

Use the future selected supervisor's bounded restart policy with backoff and an attempt ceiling; do not loop endlessly on invalid configuration or an upstream outage. Treat configuration failure as a release blocker. SIGTERM/SIGINT stops acceptance, drains admitted requests up to the configured deadline, then closes remaining sockets. Match the supervisor grace period to that deadline with a small allowance. Upstream-only failures should be diagnosed through readiness/source status rather than falsely marked healthy data or automatically triggering an uncontrolled restart storm.

Rollback triggers include wrong artifact/hash, unexpected public route or secret exposure, invalid configuration, startup/shutdown failure, reader regression or unaccepted source/readiness behavior. Stop admission to the candidate through the selected platform's controlled release switch. Restore the previous inspected version directory and its reviewed configuration atomically, start/check it under the same least-privilege policy, then verify health, source observations and route isolation before returning traffic. Restarting either version clears cache; a temporary 503 readiness state is expected until valid samples are observed. This reader stores no newsroom or payment data, so no application database rollback is part of this procedure.

If the previous runtime files are lost, obtain the previously reviewed commit in a separately authorized clean checkout/worktree, verify identity/commit and rebuild/inspect into a new output directory, comparing retained manifest/content hashes before promotion. Preserve failed candidate files and sanitized evidence; do not reset, stash, clean or overwrite a checkout with protected work. If an artifact/configuration mismatch cannot be explained, stop and seek review rather than silently substituting a new build. No recovery command in this document is executed by this milestone.

## Outstanding launch blockers

No external deployment, image registry upload, production DNS/firewall configuration, real identity provider, paid observability, live news ingestion, production scheduler, model/audio generation, publication or payment activation has been performed. A reviewed staging host/proxy/UID/resource policy, current source API compatibility/identification, accepted physical/accessibility checks, operational ownership and explicit release authorization remain necessary. Production editorial identity/authorization, licensing, durable storage and publication controls remain separately blocked; publishing the reader artifact would not complete them.
