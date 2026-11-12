# Dayline — Development retention policy

This document describes the local retention controls introduced by DL-003B-R2 and extended to editorial proposals by DL-003C. It is not a provider license, production deletion guarantee or legal determination. Only fictional `.test` metadata is permitted by the current registry. Real feeds, production publishing and paid services remain blocked.

## Confirmed R1 gaps and existing safeguards

R1 reproduction confirmed that deleting a source without a permitted identity marker allowed the same URL to be imported again with a refreshed retrieval time under an active approved policy. A policy-unknown snapshot or `minimalAudit: false` record could reach that condition. Policies permitting a marker blocked that restoration, but their markers had no expiry.

R1 metadata cleanup also left copied prose, claims, source IDs and reviewer labels in story revisions, approvals and editorial audits. The correction-to-draft path could copy that retained history. New approval/publication using missing or ineligible sources was already blocked; R2 does not claim that this existing check was absent. R2 adds historical redaction and blocks restoration without retaining an indefinite identifying blocklist.

## Captured rights and deadlines

Ingestion retains the exact centrally registered policy snapshot. It does not accept caller-supplied rights or silently upgrade an old snapshot to a newer grant. Metadata retention starts at the earlier of ingestion and original retrieval and ends no later than policy expiry. Promotion from quarantine or delayed ingestion cannot restart that period. Invalid retention dates and unknown, expired, revoked or superseded policies make managed metadata eligible for cleanup. Resolved managed syndicated copies cannot outlive a removed original.

Audit permission is separate from metadata permission. A policy allowing minimal audit must supply a finite positive integer `auditRetentionDays`; the fictional fixture policies use one day. The explicitly approved `fictional-no-audit-v1` policy uses `minimalAudit: false` and zero audit days. Missing audit terms are unknown rights, not permission to keep a marker.

| Record | Applied cleanup behavior |
| --- | --- |
| Managed sources and quarantine | Remove expired or ineligible metadata, policy snapshots and dependent managed syndicated copies. |
| Linked provenance and ingestion audits | Remove provider metadata, evidence references, asserted actor information and source-linked ingestion details. |
| Permitted deletion markers | Keep only the opaque source identity, cleanup time/reason and `expiresAt`, with the minimal service audit event. Identity hashes remain linkable and are not treated as anonymous data. |
| Expired, invalid or deadline-less markers | Purge the marker and linked audit identity on cleanup. Do not renew its deadline or infer a new audit grant. |
| Identifying audit orphans | Replace events whose source identity has no governing managed metadata, quarantine or unexpired marker with non-identifying procedural stubs, and require retention review. |
| Affected editorial history | Replace every version and linked approval/audit details with the procedural stubs described below. |
| Generated editorial proposals | Invalidate ineligible proposals, remove their payload and source/story/policy links, and redact linked review actor assertions. |
| Unrelated lawful history | Leave unchanged by this cleanup. |

The first permitted marker deadline is calculated from cleanup time plus the captured audit period. Repeated cleanup does not extend an existing deadline. If no audit retention is permitted, no identifying deletion marker is retained.

Rejected and duplicate ingestion attempts keep per-attempt counts and atomic outcome events, without retaining their source IDs or hashes. An attempt with no newly retained source does not establish an independent license lifetime for its identity. Cleanup also handles identifying outcome events from earlier implementations; it does not infer retention permission from the event's existence.

## Repository retention-review hold

Applying metadata deletion sets schema-7 `retentionReviewRequired` to true. Prior deletion markers, identifying audit orphans or redaction of orphan historical references also require the hold. This repository-wide boolean contains no source ID, URL, digest, publisher or reviewer identity. It remains after finite markers disappear and blocks all provider ingestion, legacy fixture ingestion, provenance resolution, proposal generation/use and new approval/publication. Sources cannot count as eligible evidence while the repository is held.

There is no application API, CLI flag or automated policy upgrade that clears the hold. A separately designed human and legal review process is required before resuming a repository with deletion history. Changing the file or using a fresh repository is not a reviewed recovery or rights procedure; the prototype cannot enforce deletion history across those boundaries.

A new empty schema-7 repository starts without the hold. Reading schema 1 or 2 converts its state to schema 7 in memory with the hold true because earlier deletion history cannot be proved complete; schema 3/4/5/6 preserves its existing hold value. Missing proposal, edition, scheduling and security collections are added empty, without granting approval. Reading alone does not rewrite the file; the next successful transaction persists schema 7. Migration preserves records for inspection rather than retroactively approving their rights. Cleanup can then redact orphan source references left by earlier cleanup even when no managed metadata candidate remains.

## Editorial history redaction

Any reference to a removed source in any story version marks the whole story as affected. This includes both supporting and contradictory evidence references. Before audit identities are scrubbed, cleanup also follows audit subject-to-story links when revision references are gone. Later versions remain affected even if they dropped the explicit source reference, because they may have copied earlier prose.

Cleanup rebuilds affected revisions from an explicit field whitelist. It removes the original story identity, headline, topic, summary, geography, event time, cluster, claims, evidence, source IDs and additional copied fields. A fresh random story ID consistently links that story's versions and minimized approvals/audits; no old-to-new map or source-derived story digest is retained. Version numbers, statuses, redaction flags, placeholder text and permitted procedural timing/event information remain. Linked reviewer and audit actor labels are replaced, and audit event IDs are regenerated. Only minimized procedural history is preserved; the stubs do not preserve source-linked licensed prose or original asserted identities.

Redacted stories cannot be edited, transitioned, approved or published, including through the correction-to-draft path. Their procedural approval records do not authorize reuse. Ordinary editorial work on unrelated records remains subject to the repository-wide approval/publication hold.

## Generated proposal retention

Editorial proposals expire no later than their captured source-retention and policy deadlines. Story edits/transitions, service snapshots/reviews and applied retention cleanup recheck their eligibility. Invalidation removes generated text, source/story links, policy references and other payload; only the proposal ID, invalidated state/time and generic reason remain. Related review records retain procedural versions/states and a safe timestamp, with story revision cleared and actor assertions replaced by a placeholder. No raw prompt or rejected model output is stored. The [AI editorial design](AI_EDITORIAL_DESIGN.md) describes the fictional-only rights and review boundary. These local checks have no background expiry scheduler and do not erase external copies.

## Internal edition retention

Every retained edition revision is revalidated against its exact current newsroom-approved story revision, evidence, managed source metadata and captured excerpt/internal-analysis permissions. Story changes, snapshots, edits, reviews and applied retention cleanup trigger this check. Ineligible revisions become minimal invalidated markers: licensed headlines, summaries, uncertainties, attribution URLs, source/story references and suggestions are removed. Linked edition-review assertions are scrubbed. The repository retention-review hold invalidates edition snapshots and blocks readiness; rebuilding an invalidated edition requires fresh eligible placements and starts again at assembly. No edition state authorizes public publication. These local checks have no expiry scheduler and cannot erase external copies. See [edition design](EDITION_DESIGN.md).

## Manual fixture commands

```bash
npm run retention:fixture
npm run retention:fixture -- --apply-fixture
```

The default command seeds a temporary fictional repository and previews metadata candidates without applying cleanup. The second applies cleanup only to that temporary fixture. Both use a fixed fictional clock, make no network requests, accept no user repository path or live mode, and remove their temporary directory afterwards. The library entry point is `cleanupRetention(repository, at, dryRun = true)`; its clock is a trusted composition/test input, not a grant of rights or identity.

Dry-run metadata counts do not represent a full inventory of historical redactions or marker expiry. Applying cleanup may scrub orphan history or expire markers even when no metadata candidates are reported. The [R2 validation report](DL-003B-R2_VALIDATION.md) records executed checks and reproduction evidence; the [R1 report](DL-003B-R1_VALIDATION.md) describes the earlier implementation.

## Limits and production requirements

Cleanup atomically replaces the current single-host JSON state under a local lock. It is logical removal, not secure filesystem erasure, a transactional production database, tamper-proof auditing or authenticated authorization. It does not erase prior files, backups, snapshots, logs, fresh repositories or external copies. Prose without recorded source linkage cannot be reliably discovered by this implementation.

Before real-provider use, review contracts and the retention of derived content, procedural timing, identity markers and reviewer data. Production work must cover all storage copies, restoration and disaster recovery, authorized deletion review, secure identities, operational monitoring and durable transactions. No retention cleanup or fixture result establishes permission for public publication or unattended operation.

## Preparation scheduling records

Schedules and preparation runs retain procedural identifiers and timestamps, not story selections, headlines, source identifiers or licensed payload. Explicit preparation validates transient selected placements through the existing edition domain. A repository retention-review hold blocks even empty preparation. Each prepared run references its exact edition revision; edition invalidation reconciles that run to `NEEDS_ATTENTION` with a generic reason in the same transaction. No scheduler action clears a retention hold, restores content or grants editorial approval.

## Authentication metadata and action receipts

Schema 7 stores opaque identities and registered-session metadata without signed credentials, verifier keys, passwords or provider secrets. Bounded security events contain fixed categories/codes and opaque actor/session references, not source prose or resource identifiers. Authenticated action receipts separately bind current verified identity to exact domain resources/revisions; they do not upgrade legacy unauthenticated assertions or grant content rights. Receipts for redacted story history, invalidated draft/edition revisions and removed/ineligible procedures are pruned through existing lifecycle hooks. Audit and receipt collections are each capped at 512 records and seven days; identity/session records have a separate operational lifecycle.

Initial authentication/permission denials leave editorial content unchanged. After valid authorization, a domain rejection may still commit known safe retention scrubbing; the final authorization guard covers that scrub and rolls back it as well if the session becomes invalid before commit. Metadata pruning is logical removal, not secure erasure or a production audit guarantee. See [security design](SECURITY_DESIGN.md).
