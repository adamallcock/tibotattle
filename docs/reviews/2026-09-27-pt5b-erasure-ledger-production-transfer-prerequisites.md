---
title: PT-5b erasure-ledger production transfer prerequisites
date: 2026-09-27
type: review
status: snapshot
---

# PT-5b erasure-ledger production transfer prerequisites

**Status:** source-only review of `codex/gcp-ledger-production-transfer` at
`bcb79cb31e385bdcfe30eb232d9da69d1f68e11b`, dated 2026-09-27. No Cloudflare,
GCP, or production PostgreSQL resource was inspected or changed.

## Decision

**Do not add a production importer yet.** The existing transfer proves integrity
of a caller-supplied SQLite file and exact PostgreSQL row parity, but the current
source contract does not prove that the file is a consistent export captured
under a drained D1 writer fence. The repository has no production erasure-ledger
export-and-seal caller. The PT-1 target handle also does not bind its supplied
pools to the registered GCP project and Cloud SQL instance. These are required
inputs to an exact production stage, so adding a wrapper would promote
unproven source and target custody.

The existing importer remains limited to disposable schemas and its fixed GCP
test target. Its result explicitly reports `productionStageRegistered: false`
(`apps/worker/scripts/postgres-erasure-ledger-transfer.mjs:1063-1066`). No
production stage receipt, source fence, or live transfer is claimed here.

## Evidence and boundary

- `createSealedSqliteErasureLedgerSource` hashes a local, read-only SQLite file,
  validates the expected three-table layout, and rechecks the file hash and
  stat while serving pages. Its snapshot contains only the artifact hash; it
  does not carry a D1 fence, drain receipt, source generation, or seal manifest
  (`apps/worker/scripts/postgres-erasure-ledger-transfer.mjs:382-436`). The
  source checks and PG17 fixture construct this file locally from the ledger
  migrations and synthetic rows (`apps/worker/scripts/postgres-erasure-ledger-transfer.check.mjs:40-76`;
  `apps/worker/postgres-test/erasure-ledger-transfer.spec.mjs:41-76`).
- The importer scans all three tables, checks bounded pages and source stability,
  reconciles staged and operational row counts and digests, and refuses drift
  (`apps/worker/scripts/postgres-erasure-ledger-transfer.mjs:498-527,1023-1043`).
  This is strong file-to-destination parity evidence, not proof of how the file
  was captured from D1.
- The named mode is hard-coded to the GCP **test** target; the public default
  forces disposable mode. `sourceSealManifestSha256` is checked only for
  64-hex shape in the named-test path and is recorded as a value, without
  comparison to the source snapshot or PT-1 run seal
  (`apps/worker/scripts/postgres-erasure-ledger-transfer.mjs:11-22,989-1001,1075-1103`).
- PT-1 exposes the ledger schema and database through an opaque handle and
  wraps transactions with the registered schema-owner role
  (`apps/worker/scripts/postgres-transfer-target.mjs:889-929,776-814`). Its
  stage receipt is control metadata, while the module requires independent
  source import/readback proof before flip readiness (`:23-27,2077-2084`).
  The current importer accepts a raw pool and does not register that PT-1 stage.
- The PT-1 review identifies the target-custody gap: the registered project and
  instance are stored, but `openProductionTransferTarget` does not verify that
  the supplied pools connect to them. A production pool factory must bind and
  prove those identities before this handle is used
  (`docs/reviews/2026-09-27-pt1-production-transfer-controls.md`, “Decision”).
- The ledger 0007 migration mirrors PT-1 run controls and expressly provides
  no source-import or readback attestation
  (`apps/worker/postgres/staged-migrations/ledger/0007_production_transfer_control.sql:1-11`).
  The older handover review likewise records the consistent D1 snapshot/export
  fence as missing and the ledger transfer as rehearsed only into disposable
  and test schemas (`docs/reviews/2026-09-25-gcp-handover-readiness.md:122-126`).

## Required implementation sequence

1. **Own the source capture contract.** Add a production exporter that runs
   after the applicable D1 write controls are acquired and drains are proven.
   It must export the three erasure-ledger tables from one consistent source
   snapshot and produce a sealed manifest binding the source identity and
   migration tail, fence/drain evidence, artifact SHA-256, and each table's
   complete row count and digest. Verify the source fence remains valid through
   capture; a local file hash alone is insufficient.
2. **Bind the production target.** Provide an owner-reviewed pool factory that
   proves the Cloud SQL project, instance, database, schema, PostgreSQL 17
   version, IAM login, and schema-owner role against the registered PT-1
   contract. Open the PT-1 handle with the same sealed manifest identity. Do not
   accept a caller-supplied digest based on shape alone.
3. **Add a separate opt-in production path.** Keep the disposable and named-test
   entrypoints fail-closed. Use the PT-1 handle's transaction path for ledger
   writes; bind the erasure-ledger stage receipt and per-table source/readback
   receipts to the same PT-1 run and seal. Completion requires all three full
   source and destination counts/digests to match, zero unfinished cursors, and
   stable retry after a committed page. Errors and logs must remain content-free.
4. **Prove it on synthetic PostgreSQL 17.** Cover missing or invalid fence proof,
   wrong target identity/contract, changed source during transfer, omitted,
   extra, or altered rows, crash and retry after a page commit, already-exact
   target retry, existing-target drift refusal, and the exact PT-1 stage receipt.
   Assert no raw ledger identifiers appear in logs or errors. Keep synthetic
   tests separate from any production invocation.
5. **Keep activation separate.** Only an owner-run, explicitly authorized
   production operation may consume a real sealed export. Its result must be
   reviewed for reconciliation and recovery before any later cutover decision.
   This review authorizes no export, production database access, migration,
   or write.
