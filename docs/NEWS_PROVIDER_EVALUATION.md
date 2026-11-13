# News provider and licensing evaluation

This is a candidate inventory, not a licensing decision. No account, subscription, provider request, content redistribution, or AI use has been authorized. Prices and terms change; verify current plan details and contracts directly before any selection.

| Candidate | Official information and pricing | Open questions |
| --- | --- | --- |
| GNews | [Documentation](https://docs.gnews.io/) · [Pricing](https://gnews.io/pricing) | Development quota, permitted retention, display, commercial and AI rights require review. API text or images do not establish publisher rights. |
| NewsAPI | [Documentation](https://newsapi.org/docs) · [Pricing](https://newsapi.org/pricing) | Verify developer-plan restrictions and commercial production, display, retention and AI rights. |
| Guardian Open Platform | [Documentation](https://open-platform.theguardian.com/documentation/) · [Access and plans](https://open-platform.theguardian.com/access/) | Verify keys, attribution, content-field terms, commercial permission, media rights and AI restrictions. |
| Associated Press | [AP Newsroom](https://www.ap.org/solutions/platforms/ap-newsroom/) · [AP licensing](https://www.ap.org/solutions/content-production/) | Obtain current terms and pricing directly; confirm specific licensed content, distribution, storage and AI uses. |

These URLs are starting points, not evidence that Dayline holds rights. Ingestion must remain development-only until provider terms, publisher rights, retention/deletion duties, provenance and commercial usage are explicitly reviewed and approved. No provider is represented as approved.

## Current implementation boundary

The private policy registry approves only invented `fictional-fixture` metadata for development checks. It contains no GNews, NewsAPI, Guardian, AP or other real-provider grant. A server-side key, successful API response, caller-provided policy or actor assertion does not confer rights. Each accepted registry policy records its provider, version, review status, evidence reference, effective date, expiry, metadata retention, finite permitted audit retention and separate use permissions. Existing records retain their original snapshot and deadlines when policies change; old snapshots without audit terms are not granted new permissions.

Provider text and images are discarded. Unknown or disputed provenance can enter metadata-only quarantine only when the applicable policy permits it; otherwise the item is discarded. An explicit recorded provenance decision is required before imported metadata becomes an eligible source. Identifying a syndicated original prevents counting copies as independent, but neither classification nor an actor label proves ownership, editorial independence or secure reviewer identity.

Manual local cleanup removes expired or ineligible managed metadata and linked ingestion details, redacts every version of affected stories and linked approval/audit identities, and places the repository under a retention-review hold. Rejected/duplicate attempt events carry no source identity; older identifying audit orphans are scrubbed without inventing a retention grant. Policy-permitted minimal deletion identities expire; a non-identifying repository flag continues to block restoration, provenance resolution and new approval/publication after those identities are purged. Remaining procedural history does not preserve source-linked licensed prose. The application has no operation to clear that flag.

Cleanup does not provide secure erasure or deletion enforcement across backups, fresh repositories, external copies or unlinked prose. An actual contract must resolve retention of derived content, audit identity limits, reviewer information, external copies and any lawful release from a deletion hold. Authenticated authorization, production persistence and those safeguards remain prerequisites for real-provider use and public publication. See [retention policy](RETENTION_POLICY.md). No live provider or paid service is activated by this milestone.

## Future source-queue integration and licensing decision

DL-007A reads the existing managed-source/quarantine/provenance/retention records; it does not fetch news or bypass ingestion. A future approved provider would normalize only permitted candidate metadata into the existing bounded ingestion contract, validate canonical URLs and timestamps, resolve the exact server-controlled provider/policy identity, capture the original policy snapshot and finite retention deadline, deduplicate under the repository transaction and quarantine unresolved provenance where retention permits. The queue would then revalidate and project those records. Neither ingestion success nor an eligible queue row establishes truth, editorial approval or publication rights. Syndicated copies must retain verified origin relationships and cannot count as independent reporting.

The GNews adapter remains default-disabled, has no live CLI and cannot pass the fictional-only ingestion policy registry. Credentials remain server-only; never expose or log the credential-bearing provider URL. Its limits are ten articles per page, at most five pages, three attempts and bounded 100/200 ms retry backoff. DL-007A closes a response-body gap: each attempt has an eight-second deadline covering headers and body, and declared/streamed response bytes are capped at 1 MiB. Oversized, timed-out and discarded bodies receive best-effort cancellation; invalid UTF-8/JSON and transport failures use fixed safe errors. Deterministic fake transports exercise these limits without provider requests. A working API key is not permission to ingest, retain, display or derive content. DL-007A does not install keys, activate plans, request live data or add a real-provider policy.

Before selecting or enabling any prospective provider, record a separate reviewed decision with contract/version, licensor authority, covered publishers/content, territory, permitted audience, effective/expiry dates and evidence references. Resolve each item below explicitly; absent permission remains denied.

| Decision | Required evidence and constraint |
| --- | --- |
| Commercial use | Production/commercial plan and permitted business model, including any premium product restrictions. |
| Display | Exact allowed fields (metadata, headline, excerpt, full text, image), link obligations and public versus internal audiences. Metadata access alone grants no article display right. |
| Attribution | Required publisher/author/provider labels, links, notices and rules for modified or derived material. |
| Retention | Per-field storage/cache deadlines, policy expiry, original retrieval semantics and limits for audit identities, backups and browser copies. |
| Deletion | Withdrawal/revocation handling, deletion deadlines, downstream/external-copy duties and any legally reviewed audit or hold exception. |
| Derived summaries | Permission to create, store, edit and distribute summaries or other derived content, with correction and deletion obligations. |
| AI use | Separate rights for model input, internal analysis and summarization, vendor processing, model retention/training restrictions and output use. |
| Narration | Text-to-speech/audio derivation, synthetic-voice disclosure, audio storage/distribution and any additional territory or audience limits. |
| Syndication | Authority over syndicated content, original-report identification, secondary publisher rights and restrictions on redistribution; copies are not independent evidence. |

Operational approval additionally requires server-only credential storage/rotation and safe logging; quotas/cost controls and bounded response handling; explicit source-read object/tenant authorization and current-session checks; durable transactions; reviewed retention/deletion enforcement across all copies; and separately approved editorial/publication procedures. Current synthetic authentication has no source-read resource/permission and the source-queue page exposes only fictional scratch data. Do not route production sources through that page or treat its historical fixture clock as current eligibility.

No GNews, NewsAPI, Guardian, AP or other prospective provider is characterized as licensed or approved. A future registry entry must be based on an actual reviewed rights decision and must not upgrade snapshots already captured under older grants. See [queue architecture](ARCHITECTURE.md#dl-007a-read-only-editorial-source-queue), [security design](SECURITY_DESIGN.md#dl-007a-source-queue-boundary) and [DL-007A validation](DL-007A_VALIDATION.md).
