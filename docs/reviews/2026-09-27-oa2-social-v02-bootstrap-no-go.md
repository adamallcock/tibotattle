---
title: OA-2 social v0.2 bootstrap receipt no-go
date: 2026-09-27
type: review
status: snapshot
---

# OA-2 social v0.2 bootstrap receipt no-go

**Status: no-go for a 0053-only parity fix.** This source review covers commit
`677d44f07bb826e5e581c6018dfe78ea8c77eaf9`; it does not inspect a live D1 or
PostgreSQL deployment.

Staged PostgreSQL migration 0053 counts missing v1, v1.1, and v1.2 source
receipts, then seeds `completed = 1` when that count is zero ([0053:51–108](../../apps/worker/postgres/staged-migrations/primary/0053_community_publication_authority.sql)). It explicitly excludes legacy v0.x owners. The existing PG17 test inserts accepted social v0.2 history before 0053 and then asserts completion as an “empty” journal-producing schema ([fixture:203–218](../../apps/worker/postgres-test/postgres-wave1-authority-migrations.spec.mjs), [assertion:278–280](../../apps/worker/postgres-test/postgres-wave1-authority-migrations.spec.mjs)). Its green result does not qualify v0.2 bootstrap safety.

D1's authority-restore walk identifies accepted v0.2 evidence and invokes
`bootstrapLegacyStorageOwner` ([walk:76–105](../../apps/worker/src/authority-restore-bootstrap.ts)). That path accepts the owner only when
`storage_legacy_event_sources` has a receipt for the current
`community_analytical_input_versions.revision`, joined to an active owner link
and the public-source view's `device_id IS NULL` branch, with an accepted v0.2
contribution still present ([receipt check:7–17](../../apps/worker/src/legacy-storage-journal.ts), [social view branch:491–493](../../apps/worker/postgres/migrations/primary/0046_owner_journal_authority.sql)). The D1 bridge receipt records the event digest, participant, owner digest, input revision, and change kind ([bridge schema and producer:4–34](../../apps/worker/ingestion-bridge-migrations/0002_legacy_fit_authority.sql)).

The PostgreSQL primary chain has no `storage_legacy_event_sources` equivalent
(the migration loader reads the full numbered primary source set
[loader:56–105](../../apps/worker/cloud-run/postgres-migrations.mjs); a search
of `apps/worker/postgres` returned no definition or reference). Its generic
`storage_ingestion_changes` and
`analytics_applied_events` rows carry journal tuples but no participant,
input-revision, or v0.2 source-family key ([base journal schema:161–191](../../apps/worker/postgres/migrations/primary/0007_analytics_lifecycle.sql)). Migration 0038 marks older tuples unqualified when their exact D1 tuple cannot be reconstructed ([0038:1–52](../../apps/worker/postgres/migrations/primary/0038_analytics_event_tuple_versions.sql)); the 0046 producer's generic event digest does not add the missing receipt mapping ([producer:761–818](../../apps/worker/postgres/migrations/primary/0046_owner_journal_authority.sql)). A generic `source-updated` row, accepted header, or current input version therefore cannot prove that a journal event is the receipt for this participant's current v0.2 source revision; no relation binds that owner and revision to the v0.2 family.

No predicate was added: synthesizing a receipt or treating the missing mapping
as complete would overstate source evidence. The blocker is a source-contract
gap: PostgreSQL needs a transferred, source-backed legacy receipt tied to the
current input revision and owner before 0053 can count eligible social v0.2
sources exactly. Accountless v0.x-only evidence remains outside the five-branch
public-source view; retained accountless v1.1/v1.2 branches remain governed by
their existing exact receipt checks.
