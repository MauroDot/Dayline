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
