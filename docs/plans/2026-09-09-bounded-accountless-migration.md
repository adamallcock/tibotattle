---
title: Bounded accountless migration from production prefix 0057
date: 2026-09-09
type: plan
status: in-progress
---

# Decision and boundary

Move the bulky records in bounded transactions, then apply unchanged migration
0058 with only an admitted, small reference dataset remaining. Prefer the
`retainObjectReferences` mode: move 41 tables while keeping 11 upload-reference
journals and their foreign-key ancestors available to older requests. This avoids
false orphan decisions while records are temporarily moved. The original
52-table mode remains a preservation oracle; it is not the preferred production
procedure because it temporarily hides those references.

Production remains at primary prefix 0057 and deletion-ledger prefix 0002 after
one approved ordinary migration attempt hit Cloudflare CPU/reset code 7429.
The [activation proposal](./2026-09-09-production-accountless-activation-proposal.md)
owns that operational outcome. No second populated attempt, production fence,
accountless activation or public release has occurred. This plan authorizes no
remote operation.

# Evidence held

- **Signed fresh-install contributions:** the actual introduction, default-on
  enrollment/upload, credential reuse after restart and persistent opt-out pass
  in the isolated staging journey. The
  [release plan](./2026-09-05-electron-release-readiness.md) identifies its signed
  artifact and server-side ownership/deduplication evidence.
- **Hosted database feasibility:** committed source `79d6bb19` passed all 108
  disposable checks in 130,990 ms. The manifest digest is
  `85f5e72d90b49204641081de17efacda49d7f0a9f8f358221a72c543efb68a57`.
  Canonical 0058/0059, 1 MiB movement, late rollback, stale replay, exact rowids
  and old-writer refusal passed. Cleanup verified exact database absence.
  The first run had stopped before SQL dispatch at migration 0015 because of
  CLI parsing of its leading comment; its receipts were preserved and its
  disposable database was separately approved for deletion/recreation.
- **Local preservation:** the original 52-table mode preserves all original
  values, hidden rowids and AUTOINCREMENT high-water marks, including integers
  above JavaScript's safe range. Four real local D1 tests cover atomic movement,
  rollback and replay; six Worker tests cover HTTP/admin/cron and SQL barriers.
- **Reference continuity:** the 41-table mode passes local canonical 0057→0059
  integration with all 11 retained tables populated. An independent WAL reader
  checks the v1/legacy/v11 joined lookups and four R2-key journals across every
  batch and phase commit. Original column values, moved rowids, sequences,
  foreign keys and final canonical schema match. Retained tables have TEXT
  primary keys and no AUTOINCREMENT; their unexposed hidden rowids may change
  under the ordinary canonical rebuild. No source consumer of those hidden
  rowids was found. This narrower identity boundary is explicit.
- **Storage protection:** the approved disposable R2 test preserved original
  bytes for both existing and new objects under the exact lock. Overwrites
  returned error `10069`; delete commands returned success but readbacks showed
  retention. After unlocking, the same delete commands removed both objects,
  and object/bucket absence was verified. The initial misleading CLI receipt
  and reconciliation are retained. This tests the REST/CLI path, not Worker
  bindings, multipart or old-invocation termination.
- **Worker regression:** all 999 tests in 79 files passed on the integrated
  movement/operator/launcher changes before the final focused refinements.
  Final committed source `53dcf8ed` passes all 38 focused migration, operator,
  launcher and transport checks, TypeScript, and both clean-tree production and
  staging dry runs. Documentation/preflight checks pass. No deployment occurred.

None of these results measures sustained production throughput or admits the
remaining reference tables for a hosted canonical transaction.

# Implemented tools

The movement core exposes pure setup, batch and transition plans. Local wrappers
execute those same plans. Source hashes pin canonical 0058/0059; the full
90-object replay manifest is also pinned, so missing, duplicated or altered
triggers/views are refused before a transition is planned.

The phase operator requires exact operation permission and an exact persisted
starting checkpoint. It copies, compares, deletes and advances its journal in
one atomic transaction. It checks full readbacks, bounds rows/bytes/SQL/time,
reduces oversized batches locally before dispatch, and never retries an
uncertain write. Production metadata must be admitted before using these helpers.

A pinned Wrangler launcher loads private hash-checked SQL through a Node preload
and preserves the normal `--command` query path. It avoids OS argument-size
limits without using Wrangler's bulk-import `--file` path. Actual local D1 tests
cover queries above 150 KiB and late-failure rollback. The original 120 KiB
hosted qualification runner is unchanged. The injected transport pins the runtime
and target configuration, validates every response, removes successful temporary
queries and retains one failed operation for reconciliation. These components
are not yet a complete admitted production coordinator.

# Production sequence to finish

1. **Admit exact source, target and limits.** Recheck prefix 0057/0002, canonical
   schema, empty accountless ledger, operation ownership, source hashes and the
   41/11 foreign-key partition. Bound the residual 11 tables by rows and logical
   bytes; qualify a representative residual fixture on hosted D1. Read-only
   bounded production probes return aggregates only. Missing SQLite statistics
   are not treated as zero. Rowid-span upper bounds are not exact row counts,
   and logical bytes exclude indexes/free pages.
2. **Fence writes and preserve references.** Deploy the temporary dynamic
   HTTP/admin/cron gate and install database mutation guards under one owned
   operation. Keep the independent deletion ledger unchanged. Preserve the 11
   journals throughout every externally visible state; the guards reject old
   repair writes even when their reads can still see references. R2 protection
   is a separate, explicitly scoped operation if retained in the final plan.
3. **Move 41 tables in bounded batches.** Prepare empty private staging tables
   and move children first with exact copy/compare/delete/CAS. Preserve rowids
   used by record views and all required sequence high-water marks. Record a
   total time budget and minimum sustained progress; stop between committed
   batches if the measured pace cannot meet that budget. No full-table scans or
   full integrity checks belong in the movement loop.
4. **Apply canonical 0058 once.** Require all 41 moved sources empty and the
   remaining 11 tables within their admitted bounds. Their canonical snapshots,
   cascades and restoration occur inside the same atomic normal query, so
   outside readers see their references before or after the transaction.
   Append the migration ledger and restore mutation guards in that transaction.
5. **Restore and finalize.** Restore moved rows parents first under the fence,
   with per-batch verification and preserved identities. Reinstate the exact
   canonical replay objects; apply unchanged 0059 and its ledger append only
   while the newly introduced accountless ledger remains empty. Drop only empty
   owned staging tables and verify canonical schema, ledgers and checkpoint.
6. **Activate and canary separately.** Reopen through a revision-checked decision,
   enable the approved accountless service modes, and run the signed synthetic
   enrollment/upload/ownership/opt-out canary. Protected release qualification
   and app/feed publication remain separate gates.

# Stop conditions

An unknown transport result, checkpoint drift, changed source/schema, nonempty
moved source, oversized residual dataset, excessive batch cost, insufficient
space or failed reference-continuity check stops execution. Retain the owned
fence and exact evidence for reconciliation; do not automatically retry, restore,
reopen traffic or switch databases. If the admitted residual transition cannot
fit hosted limits, review that specific remaining table work before choosing a
replacement-database migration. Do not rebuild a general orchestration system.
