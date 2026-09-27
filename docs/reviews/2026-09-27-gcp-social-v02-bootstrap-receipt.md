---
title: GCP social v0.2 bootstrap receipt review
date: 2026-09-27
type: review
status: snapshot
---

# GCP social v0.2 bootstrap receipt review

**Status:** staged PostgreSQL DDL and synthetic PG17 coverage only. This is not
a source import, completed analytics fit, deployment, or cutover qualification.

The D1 receipt contract is defined in
[`0002_legacy_fit_authority.sql`](../../apps/worker/ingestion-bridge-migrations/0002_legacy_fit_authority.sql):
`storage_legacy_event_sources` retains the exact
`(event_digest, owner_digest, participant_id, input_revision, change_kind)`
tuple, allows only `owner-active` or `source-updated`, and is unique by
participant/input revision. D1's
[`bootstrapLegacyStorageOwner`](../../apps/worker/src/legacy-storage-journal.ts)
requires an active owner link, a current analytical input revision, an eligible
social public-source row, and an accepted v0.2 contribution.

Staged PostgreSQL `0053` counted pending v1, v1.1, and v1.2 receipts but did not
count this legacy family. An eligible social v0.2 owner could therefore be
present before `0053` seeded `community_public_source_bootstrap` as completed.
Staged `0094` adds a D1-shaped immutable receipt relation, counts eligible
social v0.2 owners as pending until an exact current-revision tuple matches the
same active owner link, and repairs an already-completed singleton to pending.
A missing analytical input-version row also remains pending. The migration
does not fabricate or backfill source receipts.

The PostgreSQL tuple table validates the D1-shaped fields and owner-link
identity, but it has no journal-provenance foreign key and does not establish
source authenticity by itself. Its rows are trusted only after a sealed D1
receipt import with exact readback. The synthetic PG17 test inserts a tuple
directly to exercise the SQL gate; it does not prove that tuple came from D1.
Receipt deletion follows D1's stricter terminal rule: PostgreSQL requires the
current source's retained `storage_owner_revisions.state='erased'` head. The
older `storage_owner_erasure_receipts` row alone is insufficient. The current
PG social eraser may therefore be blocked from deleting these receipts until
its terminal owner-journal path is repaired; that dependency is not solved by
0094.

## Remaining promotion blocker

The PostgreSQL live legacy-v0.2 path still has no ongoing bridge that emits and
retains these exact source receipts as accepted inputs or analytical revisions
change. `0053`'s completion function is monotonic once complete, so `0094`'s
repair covers the migration-time cohort only. A later accepted v0.2 write or
input revision must not be assumed covered by this DDL. Promotion requires a
separately reviewed bridge/source-transfer path that carries the D1 tuple and
keeps new eligible evidence behind the correct pending/receipt gate. This
review does not claim that path exists or that any source data was imported.

## Local evidence

[`postgres-social-v02-bootstrap-receipt.spec.mjs`](../../apps/worker/postgres-test/postgres-social-v02-bootstrap-receipt.spec.mjs)
reproduces the premature `0053` completion on PostgreSQL 17, verifies `0094`
repairs it, checks missing and stale revision refusals, and permits completion
only after the exact current tuple and owner link are present. The fixture is
synthetic and uses the private local PostgreSQL Unix socket.
