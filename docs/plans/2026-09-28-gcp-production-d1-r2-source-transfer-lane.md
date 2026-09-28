---
title: GCP production D1 and R2 source transfer lane
date: 2026-09-28
type: plan
status: proposed
---

# GCP production D1 and R2 source transfer lane

**Status:** Proposed, blocked on a production-wide source fence, drain proof,
complete production exporter/importer, and cutover rollback design. This is a
plan for review. It authorizes no production export, source freeze, artifact
transfer, database write, migration, deploy, or traffic switch.

## Decision

Use a single, explicitly scheduled maintenance capture as the first full-source
transfer lane. The lane must fence all source writers, capture every in-scope
D1 and R2 source from the same frozen interval, import and reconcile an
isolated GCP target, and keep Cloudflare authoritative until a separate
cutover decision.

**This lane is not executable with current code. A brief write freeze is not
currently proven.** The existing collection controls cover four request
classes. The migration mutation barrier is disabled and specific to a temporary
accountless schema move; its own contract does not prove that requests admitted
by an older Worker have drained. Neither mechanism fences every D1 binding and
R2 mutation together. A complete freeze/drain mechanism and production transfer
path must be implemented and qualified before scheduling the window.

If the required full freeze cannot fit the owner-approved maintenance budget,
stop and build the online journal/change-capture design described in the
[source extraction review](../reviews/2026-09-27-gcp-live-d1-source-extraction.md).
Do not shorten the freeze by exporting a base copy and later treating it as
current: after Cloudflare writes resume, that copy is stale until a qualified
delta is applied.

## Expected service impact

Plan for hosted write and read failures while the source-wide gate is active.
The ingestion D1 export itself may block queries for the full export interval;
Cloudflare's guidance says a running export blocks other database requests.
Hosted ingestion, enrollment, sign-in, owner/admin actions, status checks, and
database-backed public reads can therefore fail or return the product's
service-unavailable response. The maintenance gate should return a static,
read-only maintenance response where possible. Local offline analysis remains
independent of this hosted window. Client retry behavior is not a substitute
for measuring and communicating the outage, and must not be assumed to avoid
lost or delayed submissions.

## Evidence and current code boundary

The 2026-09-27 metadata-only inventory observed separate ingestion, analytics,
and deletion-ledger D1 bindings, plus quarantine and release-update R2 buckets.
Its ingestion database observation was 6,675,173,376 bytes and 174 tables.
Those are dated metadata facts, not row counts or current source identity; the
binding map, table inventory, migration tails, size, and bucket dispositions
must be re-read immediately before any future window. See the
[production source inventory](../receipts/2026-09-27-cloudflare-production-source-schema-inventory.md).

- [Collection controls](../../apps/worker/src/collection-controls.ts) gate
  enrollment, upload registration, processing, and publication. The owner
  admin action writes these four flags with a revision check. The
  [collection-control CLI](../../apps/worker/scripts/collection-control.mjs)
  explicitly rejects `--remote`; it is not a production freeze command.
- The [migration mutation barrier](../../apps/worker/src/mutation-barrier.ts)
  is currently disabled, migration-specific, and limited to requests,
  scheduled maintenance, and triggers on its selected primary-D1 tables. Its
  contract says older admitted requests may still be in flight. It does not
  coordinate analytics D1, the deletion ledger, or R2.
- The [typed legacy importer](../../apps/worker/scripts/postgres-typed-legacy-transfer.mjs)
  accepts synthetic fixtures or branded, sealed SQLite rehearsal artifacts.
  Its file hash proves local byte stability, not remote D1 provenance or a
  cross-binding fence; it transfers one declared family and labels its result
  staged rehearsal evidence.
- The [erasure-ledger importer](../../apps/worker/scripts/postgres-erasure-ledger-transfer.mjs)
  is limited to disposable and named-test paths. The
  [PT-1 target review](../reviews/2026-09-27-pt1-production-transfer-controls.md)
  says the target controls are not wired to a production importer and the
  supplied pools are not yet bound to the registered GCP project and instance.
  The [PT-5b review](../reviews/2026-09-27-pt5b-erasure-ledger-production-transfer-prerequisites.md)
  identifies the missing source seal and production ledger readback.
- The current production operations runbook describes recovery and migration
  fences for their named operations. Those controls do not establish a
  general D1/R2 export freeze or a rollback of data already accepted by GCP.

Cloudflare currently documents that Time Travel cannot clone or fork a D1
database, and restore overwrites the source in place. A large D1 export may
make the database unavailable to serve queries; the import/export guide says a
running export blocks other database requests. The export must be polled
continuously and its download URL is available for one hour. These statements
are the reason a representative disposable export rehearsal and an accepted
service-impact window are prerequisites, not production experiments:
[Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/),
[D1 export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/),
[import and export guidance](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

R2 is strongly consistent per operation, including each list operation; this
does not make multiple pages, D1 references, the deletion ledger, and object
reads one atomic snapshot. Pin each listed object's ETag and version token,
use conditional reads, and hold object writers/deleters fenced through capture.
Do not rely on S3 bucket versioning: Cloudflare's compatibility table marks
GetBucketVersioning and PutBucketVersioning unsupported.
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[Workers API and conditional reads](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api).

## Required implementation contract

Before any production window, a reviewed source-freeze component must provide
all of these properties:

1. **One freeze identity.** Create a unique, monotonic operation/fence ID and
   bind its receipt to the exact serving Worker version, all active D1 binding
   identities, D1 migration tails, R2 bucket dispositions, and the GCP target
   contract. Keep real provider IDs in a restricted operation receipt, never in
   this plan or ordinary logs.
2. **Block new mutators.** Gate every public, owner/admin, scheduled, queue, and
   other background write path before it touches D1 or R2. Inventory the live
   deployment and code first so no writer is omitted. Preserve a small
   read-only health/maintenance response that reports the fence state without
   reading the source databases.
3. **Prove drain and fence stores.** Track and drain operations admitted before
   the gate, scheduled work, queue deliveries, and object writes. Add a
   fail-closed database fence for every writable table in each in-scope D1
   binding; verify the exact covered table set, block concurrent migrations,
   and restrict operator access that could remove or bypass the fence except
   through its matching recovery path. Separately stop and drain every R2
   writer and deleter. A UI pause, 503 response, deployment version, or
   collection-control revision alone is not drain proof.
4. **Make privacy work interruptible.** Owner erasure and other urgent privacy
   work take priority over transfer. If one begins or cannot be proven drained,
   invalidate the candidate capture, complete the privacy operation on the
   Cloudflare source, and restart capture from a new fence. Do not defer erasure
   behind a migration window or import an artifact that predates it.
5. **Seal source provenance.** A production exporter must attest the fence and
   drain receipt, exact source binding and migration identities, each D1 export
   bookmark, schema digest, artifact size and SHA-256, complete per-table
   counts/digests, and the full R2 inventory and object checksums. Bind converted
   SQLite files and target imports to the original export hashes. A caller-built
   descriptor or post-download hash alone is insufficient.
6. **Bind the destination.** A production importer must verify the actual GCP
   project, Cloud SQL instance, database, schema owner, PostgreSQL version,
   IAM identity, and exact migration receipts through the target connection.
   Use a dedicated non-serving target. Import the deletion ledger/tombstones
   before data that they suppress, then apply the reviewed per-table dependency
   order. Reject unmapped tables, columns, object references, or authority state.
7. **Recover the freeze.** Persist the pre-freeze control values and revision,
   fence identity, per-store transition receipts, and a tested exact resume
   procedure. A failure must leave Cloudflare authoritative and the target dark;
   recovery may clear only the matching operation's fence after readback proves
   every store is in a known state.

The [production source extraction review](../reviews/2026-09-27-gcp-live-d1-source-extraction.md)
and [sealed transfer reviews](../reviews/2026-09-27-gcp-primary-social-identity-transfer-slice.md)
remain the detailed family boundaries. They establish that the existing import
slices do not cover the full live schema or cross-store state.

## Rehearsal and window sizing

Use only disposable Cloudflare D1/R2 and synthetic rows/objects. Do not use a
schema-only export against a production D1: it invokes the export operation and
Cloudflare does not document an availability exemption for `no_data`.

The rehearsal must use the reviewed source schema and a volume representative
of the current metadata size, including the largest tables and expected object
count. Measure the complete fenced interval: fence and drain, each D1 export
and continuous polling, download, encryption/checksum verification, R2
inventory and copy, conversion, GCP import, full readback, and resume or
cutover preparation. Record export bytes separately from D1 file size; the
latter does not predict SQL export size. Include the importer’s private
SQLite snapshot and intermediate files when sizing encrypted temporary
storage. If the rehearsal is materially smaller or cannot complete below a
written owner-set maximum window, the result does not qualify a production
window.

Once a D1 export has started, do not stop polling to create an artificial
timeout: Cloudflare documents automatic cancellation when polling stops, not a
guaranteed immediate unblock. The rehearsed operator must continuously poll to
a terminal result and follow the exact tested error/recovery path. Do not start
unless the complete impact window and staffed recovery time are approved.

## Artifact custody

Treat each D1 export and R2 object as sensitive source data. Download the
short-lived Cloudflare URL over TLS directly to a dedicated, owner-controlled
encrypted staging volume in an approved region. If a private Cloud Storage
staging bucket is used, require uniform bucket-level access and public access
prevention; use the organization's approved CMEK or client-side envelope
encryption policy. Cloud Storage supports default encryption and CMEK, but the
project owner must choose the required key policy and retention before the
window ([encryption options](https://cloud.google.com/storage/docs/encryption),
[public access prevention](https://cloud.google.com/storage/docs/public-access-prevention)).
Do not use an ordinary developer workstation, sync folder, or shared bucket.
Keep the production SQLite conversion and the importer's private temporary
snapshot on encrypted storage too; size for the original export plus every
simultaneous intermediate and temporary copy. Store object keys and provider
identities only in the restricted encrypted transfer manifest, never in source
control or ordinary logs. Apply an owner-approved short retention, then verify
removal of each temporary copy and preserve only the content-free receipts.

## Future operator sequence

This is a gated sequence, not a set of currently executable production steps.
No production command is provided because the repository has no supported
production-wide freeze, exporter, or complete production importer.

### 1. Readiness review

- Re-read the active 100%-serving Worker version and enumerate every D1 and R2
  binding. Classify each bucket as transferred, retained in Cloudflare, or
  excluded by an explicit owner decision. The quarantine bucket and release
  distribution bucket have different product roles; do not silently combine
  or omit them.
- Refresh schema, migration, table, index/trigger, object-reference, deletion
  ledger, and authority inventories using metadata-only reads. Reconcile all
  tables to an explicit GCP disposition. Any unknown or unclassified source
  state is a stop.
- Confirm GCP source-route parity, privacy erasure, replay, staged importer,
  backup, and recovery gates. Confirm exact target identity from the target
  connection, not only a registered name. Synthetic/test health is not
  production source or rollback evidence.
- Confirm encrypted staging capacity and location, key custody, least-privilege
  access, object-generation conditions, receipt retention, and exact cleanup
  ownership. No SQL dump, SQLite conversion, raw R2 key, signed URL, credential,
  or participant detail belongs in source control or ordinary diagnostics.

### 2. Open the maintenance window and capture

- Record the exact pre-window Worker revision, collection-control flags/revision,
  scheduled-work state, source migration tails/bookmarks, and target backup
  identity in the restricted operation receipt.
- Activate the reviewed source-wide fence. Verify its fence ID and complete
  drain proof across all D1 bindings and R2. If any store is unknown, any old
  operation remains active, or any writer can bypass the fence, stop before
  export and restore the prior source state through the matching recovery path.
- While that same fence remains held, capture every in-scope D1 export and the
  analytics and deletion-ledger bindings, then capture and copy the R2
  inventory.
  Record each D1 `at_bookmark`; it is a per-database export watermark, not a
  cross-database snapshot token. Poll exports continuously to completion.
- Treat Cloudflare's one-hour signed download URL as a secret capability:
  download promptly over TLS into an owner-controlled encrypted, access-limited
  staging volume. Never print or persist the URL. Before any further copy,
  verify artifact byte count and SHA-256; record only content-free receipts.
- For each R2 page, retain the cursor and content-free tuple of object version,
  ETag, size, and checksum in the restricted manifest. Read each object
  conditionally against the captured ETag, recheck its version token after the
  copy, and verify the destination checksum. Re-list after copying and require
  exact inventory parity while all object mutation remains fenced.

### 3. Import and reconcile

- Convert each D1 export using the reviewed production conversion tool; seal
  every derived artifact to its source export hash. Do not point a rehearsal
  importer at a production export.
- Import the deletion ledger and erasure tombstones first. Import remaining
  D1 families in the explicit foreign-key/authority dependency order, then
  expose object references only after their exact objects are present.
- Read back every source and target table: schema/migration identity, row count,
  canonical digest, and unfinished cursor count. Require exact parity for every
  in-scope row family. Reconcile tombstone suppression, identity/authority
  state, all D1 object references, and R2 object count/size/checksums. Unknown,
  skipped, changed, or inaccessible rows/objects fail the transfer; do not
  convert them to zero or a warning-only state.
- Keep GCP non-serving and writes disabled during reconciliation. If the source
  fence is released before a later cutover, this target is only a point-in-time
  staging copy; a separately qualified final delta or complete recapture is
  required before it can serve.

### 4. Authority and rollback boundary

- **Before GCP accepts a write:** Cloudflare remains the sole authority.
  On failure, keep traffic on Cloudflare, discard or retain the encrypted
  candidate under the approved retention policy, and clear only the matching
  source fence after exact source health and pre-freeze settings are read back.
  Restore the prior collection-control vector; do not assume every flag was
  enabled before the window.
- **After GCP accepts its first write:** routing traffic back to Cloudflare
  would lose GCP-only writes. The reviewed code has no qualified reverse delta
  or dual-write lane. Keep GCP authoritative and use a forward repair unless a
  separately implemented and rehearsed reverse transfer exists. A Cloud Run
  revision rollback changes service routing/image state; it does not roll back
  PostgreSQL or reconcile data.
- A true cutover is a separate owner approval after source and target receipts,
  complete route/privacy/replay parity, recovery rehearsal, and an explicit
  accepted rollback window are reviewed. This plan grants no such approval.
  Do not use D1 Time Travel restore as a transfer rollback: it overwrites the
  source in place and cancels in-flight queries.

## Approval boundary

Three outcomes require separate, explicit owner authorization when their
readiness gates exist: (1) production source freeze/export and encrypted artifact
handling, with the expected Worker/API impact; (2) production GCP database and
object writes/import; and (3) traffic cutover plus any post-cutover rollback
policy. Approval of this plan or a disposable rehearsal does not authorize any
of them.

## Current stop condition

Do not schedule or execute the production window until the source-wide fence
and drain contract above is implemented, deployed proof exists for every active
binding and writer, the full capture/import duration fits an owner-approved
window, complete production provenance and readback receipts exist, and a
rollback path is accepted for the point at which GCP begins accepting writes.
