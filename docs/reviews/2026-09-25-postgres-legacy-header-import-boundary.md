---
title: PostgreSQL legacy header import boundary
date: 2026-09-25
type: review
status: supporting-evidence
---

# PostgreSQL legacy header import boundary

This review records the boundary of the synthetic, sealed-source rehearsal for
legacy v1 and v1.1 transport headers. It is supporting evidence for transfer
design; it does not authorize an application-reader cutover or represent a
production export.

## What the rehearsal proves

The admission transfer can read the three exact v1/v1.1 source header tables
from a sealed SQLite artifact, verify their source manifest and snapshot, and
copy them in bounded keyset pages into immutable tables in a disposable
PostgreSQL control schema. A separate immutable receipt binds the header
manifest and per-table counts to the target schema, source snapshot, and source
namespaces. Interruption after header pages commit but before receipt creation
can be resumed; replay is idempotent. The PG17 test confirms application
header tables remain empty and verifies that partial or absent source header
prerequisites fail closed.

The mirror does not create active-reader receipts, advance an analytics cursor,
activate owner state, publish data, or authorize erasure. It is not a production
import path.

## Why historical headers cannot be replayed through current application tables

The current SQLite migration chain treats header insertion as a present-time
authorized upload, not as a historical restore:

- `0058_accountless_upload_ownership.sql` requires v1 chunks to belong to an
  active participant and a matching upload authorization that is still
  `consuming`, has an unexpired lease, and has not expired. Its AFTER INSERT
  trigger consumes that authorization and records the inserted contribution
  (`telemetry_v1_chunks_require_active_participant`,
  `telemetry_v1_chunks_require_consuming_upload`, and
  `telemetry_v1_chunks_consume_device_upload`, around lines 1589–1679).
- V1 insertion also updates daily admission counts and can enqueue a public
  aggregate rebuild (`telemetry_v1_chunks_record_admission` and
  `telemetry_v1_chunks_enqueue_daily_rebuild`, around lines 1619–1658).
- A v1.1 manifest must be newly staged under currently active device and
  participant authority, an accepted transport format/floor, current consent
  or active accountless enrollment/owner/grant, and no accepted legacy v0.2
  contribution. It must have a valid chunk count and fit the manifest quota
  (`telemetry_v11_manifest_admission`, around lines 2052–2097).
- A v1.1 chunk must match a currently staged manifest, its exact JSON
  chunk ID/digest/count, accepted format/floor, current owner and device
  authority, a currently consuming, unexpired authorization with the matching
  envelope digest, and the no-v0.2 condition (`telemetry_v11_chunk_admission`,
  around lines 2099–2147). Its AFTER INSERT trigger consumes that authorization
  and updates admission counts (around lines 1392–1407).
- A manifest can only become ready from `staged` after all expected chunks and
  their raw record counts have arrived (`telemetry_v11_manifest_ready`, around
  lines 1559–1567). A header-only historical import cannot prove that condition
  when raw record bodies are intentionally absent.

Recreating old active authorizations, setting replication-role bypasses, or
silently disabling these guards would turn historical evidence into new upload
authority or cause upload side effects. The rehearsal does none of those.

## Smallest production-safe path to review

Keep the tested control-schema mirror as the sealed-source verification step.
If the application reader needs historical transport headers, add a separate,
forward-only historical-header archive in the application schema. Its rows
should retain exact source tuple values and reference the matching participant
and device so existing erasure cascades can remove them. The archive must not
pretend that a historical authorization is still usable.

Promotion from the sealed mirror should be an explicit migration-owned
operation, gated by an immutable permit for one exact artifact: source snapshot
identity and digest, source manifest digest, target schema, v1/v1.1 namespaces,
per-table digests and counts. The operation should copy only the archive rows,
verify row-for-row equality and record a durable promotion receipt. It should
not modify upload authorization, consent, participant/device status, cursors,
owner state, reader activation, or publication state. The existing live-upload
triggers should remain enabled and unchanged.

Then update the legacy proof/admission readers to consult the historical archive
for evidence that may predate the PostgreSQL target. Keep live ingestion in the
current application tables, and keep reader activation behind its existing
independent qualification gates. This archive-and-reader design is a proposal;
it has not been implemented or qualified. Before choosing it, verify every
header consumer and erasure path, especially guards that currently join the
physical application header tables.

## Evidence and remaining limits

The focused PostgreSQL 17 test exercises exact v1 and v1.1 header tuples,
interruption/resumption, immutable receipt and row behavior, idempotent replay,
and fail-closed incomplete-source cases. It proves the isolated mirror only.
The complete target application state remains unrepresentable by this step:
historical headers are absent from application tables, raw v1/v1.1 event JSON
and R2 objects are not imported, and there is no application-reader activation.
No production D1 export, GCP resource, or remote write is involved.
