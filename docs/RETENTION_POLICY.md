# Dayline — Development retention policy

This document describes the local DL-003B-R2 prototype. It is not a provider license, production deletion guarantee or legal determination. Only fictional `.test` metadata is permitted by the current registry. Real feeds, production publishing and paid services remain blocked.

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
| Unrelated lawful history | Leave unchanged by this cleanup. |

The first permitted marker deadline is calculated from cleanup time plus the captured audit period. Repeated cleanup does not extend an existing deadline. If no audit retention is permitted, no identifying deletion marker is retained.

Rejected and duplicate ingestion attempts keep per-attempt counts and atomic outcome events, without retaining their source IDs or hashes. An attempt with no newly retained source does not establish an independent license lifetime for its identity. Cleanup also handles identifying outcome events from earlier implementations; it does not infer retention permission from the event's existence.

## Repository retention-review hold

Applying metadata deletion sets schema-3 `retentionReviewRequired` to true. Prior deletion markers, identifying audit orphans or redaction of orphan historical references also require the hold. This repository-wide boolean contains no source ID, URL, digest, publisher or reviewer identity. It remains after finite markers disappear and blocks all provider ingestion, legacy fixture ingestion, provenance resolution and new approval/publication. Sources cannot count as eligible evidence while the repository is held.

There is no application API, CLI flag or automated policy upgrade that clears the hold. A separately designed human and legal review process is required before resuming a repository with deletion history. Changing the file or using a fresh repository is not a reviewed recovery or rights procedure; the prototype cannot enforce deletion history across those boundaries.

A new empty schema-3 repository starts without the hold. Reading schema 1 or 2 converts its state to schema 3 in memory with the hold true because earlier deletion history cannot be proved complete. Reading alone does not rewrite the file; the next successful transaction persists schema 3. Migration preserves records for inspection rather than retroactively approving their rights. Cleanup can then redact orphan source references left by earlier cleanup even when no managed metadata candidate remains.

## Editorial history redaction

Any reference to a removed source in any story version marks the whole story as affected. This includes both supporting and contradictory evidence references. Before audit identities are scrubbed, cleanup also follows audit subject-to-story links when revision references are gone. Later versions remain affected even if they dropped the explicit source reference, because they may have copied earlier prose.

Cleanup rebuilds affected revisions from an explicit field whitelist. It removes the original story identity, headline, topic, summary, geography, event time, cluster, claims, evidence, source IDs and additional copied fields. A fresh random story ID consistently links that story's versions and minimized approvals/audits; no old-to-new map or source-derived story digest is retained. Version numbers, statuses, redaction flags, placeholder text and permitted procedural timing/event information remain. Linked reviewer and audit actor labels are replaced, and audit event IDs are regenerated. Only minimized procedural history is preserved; the stubs do not preserve source-linked licensed prose or original asserted identities.

Redacted stories cannot be edited, transitioned, approved or published, including through the correction-to-draft path. Their procedural approval records do not authorize reuse. Ordinary editorial work on unrelated records remains subject to the repository-wide approval/publication hold.

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
