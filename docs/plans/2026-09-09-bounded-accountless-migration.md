---
title: Bounded accountless migration from production prefix 0057
date: 2026-09-09
type: plan
status: proposed
---

# Decision and boundary

Use the existing small evacuation proof as a feasibility result, not an executable production procedure. It can remove the data-dependent work that failed with Cloudflare CPU/reset code 7429: move rows in bounded transactions before running unchanged migration 0058 on empty tables. Do not build a general migration framework or retry the populated transaction.

Production is at primary prefix 0057 and deletion-ledger prefix 0002 after the separately approved failed attempt. The [activation proposal](./2026-09-09-production-accountless-activation-proposal.md) owns that operational outcome. This plan authorizes no remote work, data access, deployment or cleanup.

The retained `phased-small-proof-03` demonstrates 52-table preservation, foreign-key order and interruption rollback on a small synthetic fixture. It does not prove hosted execution, production capacity, maintenance isolation, or completion through 0059.

# Smallest proposed sequence

1. **Admit and fence.** Pin the deployed Worker, exact migration hashes, schema baseline and operation identifier. Confirm prefix 0057/0002, no unknown operation, and the newly introduced accountless ledger remains empty. Pause all database-backed reads and writes, scheduled/lifecycle work and admin mutations; wait for existing mutating invocations to finish. The four collection flags alone do not provide this fence. Keep the independent deletion ledger unchanged. A durable operation record must retain the fence through process interruption and migration-ledger advancement.
2. **Prepare empty staging tables.** Derive the exact 52-table set and foreign-key topology from the admitted schema. Refuse new dependencies, cycles or column drift. Create private operation-owned tables with explicit original columns and an indexed movement key; create indexes while these tables are empty. Capture required identity and high-water metadata, including externally exposed implicit rowids and `sqlite_sequence`. Do not use a full-table snapshot or export.
3. **Evacuate children first.** Each call selects a small indexed batch, copies it within D1, verifies copied values/counts, deletes exactly those original keys, and advances a compare-and-swap journal in the same transaction. Use one row only for the initial hosted cost probe, then adapt bounded batch sizes from measured cost; millions of single-row API calls are not the proposed execution strategy. Bound row count, admitted row size, statement count and request duration. Before admitting a run, record an explicit elapsed-time budget and minimum sustained rows/bytes per second; stop between committed batches if measured progress cannot meet that budget. Keep payloads inside D1; receipts contain only phase, revision and counts. A transport error means reconcile the same operation revision before any retry.
4. **Require empty source tables.** Use one indexed `SELECT 1 ... LIMIT 1` per table, not whole-table counts. Every descendant must be empty before dropping a parent. This is the decisive cascade guard.
5. **Apply unchanged 0058 once.** Send its original SQL and ordinary migration-ledger append together. Staging and the phase journal use distinct names from `_0058_save`. With all 52 sources empty, its snapshots, cascades, bulk deletes/inserts and index creation process no retained rows. Reconcile exact schema and ledger before continuing; prefix 0058 alone must not reopen traffic while restoration is incomplete.
6. **Restore parents first.** Temporarily remove only the reviewed admission/mutation triggers required for historical replay under the still-active fence. Keep indexes and foreign keys enabled. Copy back bounded batches with explicit columns and preserved row identities; delete their staging rows and advance the journal atomically. Maintain indexes incrementally during insertion rather than rebuilding them over populated tables. Finish each table only after its staging table is empty.
7. **Finalize 0058, then 0059.** Restore exact canonical triggers/views. Require per-batch preservation evidence and bounded final table/journal checks. Apply unchanged 0059 plus its ledger append once; its CHECK-bearing ALTER statements require a scan, so the empty accountless-ledger admission is essential. Reconcile canonical 0059 schema and unchanged deletion ledger. Drop only confirmed-empty owned staging tables, retain the operation receipt, and reopen via a separate revision-checked decision.

# CPU and storage review

There is no identified unavoidable populated-table rebuild in this sequence. Migration 0058 creates five explicit indexes: three on rebuilt participants/device credentials and two on new accountless tables. All are empty at that point. Root cascades see empty descendants. Clearing a source through indexed row deletes releases its table/index pages incrementally; dropping an already empty table is not a second retained-data scan. These are source/SQLite observations, not a hosted latency guarantee.

The current prototype **must not be scaled unchanged**. It runs full `PRAGMA foreign_key_check`, full-table UNION/sort hashes and full integrity checks repeatedly. Replace those with enforced foreign keys, atomic exact-row comparisons and bounded checks; any final exhaustive verification must have an explicitly paginated implementation. It also omits implicit rowids from its data snapshots. The schema exposes `telemetry_v11_records.rowid` through a view, so preserving only declared columns is insufficient evidence for that identity.

Read-only local query-plan inspection found no temporary sort in the prototype's primary-key ordered batch selection across all 52 tables. That does not validate every delete, cascade, CHECK expression or hosted write cost. Each restore insert still performs ordinary index/constraint work; a single largest valid row must fit the hosted CPU/request limit. Freed source pages may be reused, but staging indexes and partially occupied pages create overhead. No production peak-space claim follows from the local proof.

The maintenance barrier remains an implementation prerequisite: there is no existing all-path fence. It must cover `handleRequest` (including admin actions), `runScheduledMaintenance` (cron and direct owner calls), and in-flight R2 deletion. The upload path has a four-minute bound, but ordinary HTTP and maintenance have no shared drain protocol; merely waiting that interval does not establish quiescence. Establish and test this narrow barrier before admitting any evacuation.

# Small, decisive next qualification

Reuse the existing local proof and migration tooling; add no new service or general orchestration infrastructure. Before implementing orchestration, extend the local proof only enough to preserve rowids/high-water metadata, complete 0059, and remove full scans from its measured movement loop. Use small adversarial fixtures with sparse rowids, non-primary insertion order, composite keys and large valid records. Verify original rows, final canonical schema, interruption rollback and empty-table cascades against the ordinary canonical control.

Then seek approval for a tiny disposable hosted qualification: the exact empty-schema transition 0057→0058→0059, one bounded parent/child movement transaction with interruption/reconciliation, and one largest admitted synthetic row. Measure each transaction independently. A failure at one row or the empty canonical transition is a stop signal, not grounds to add another coordinator layer.

If that minimum hosted unit cannot run within D1 limits, use a separately reviewed replacement-database migration or retain the old application/service boundary. A replacement database still requires bounded import, exact schema/trigger ordering, deletion-ledger reconciliation, maintenance isolation and binding cutover; it is not a simple or cost-free fallback.
