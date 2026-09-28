---
title: GCP daily authority shard contention snapshot
date: 2026-09-28
type: review
status: snapshot
---

# GCP daily authority shard contention snapshot

## Result and boundary

The staged PostgreSQL daily-source fence now uses 128 transaction-hash shards
instead of one globally contended generation row. The publisher captures the
summed generation in its REPEATABLE READ snapshot, computes the result and
inserts an uncommitted immutable revision, then locks and checks every shard
with `FOR SHARE NOWAIT` immediately before commit. PG17 tests cover committed
and in-flight source changes, a writer arriving after the final locks, and the
publisher's own aggregate insert. v1.2 typed records remain excluded from daily
totals.

Migration `0095_community_daily_v12_authority_generation.sql` remains staged;
it is not in the canonical migration sequence. This source-level change and
its local benchmark do not qualify Cloud SQL, migration promotion, runtime
deployment, or v1.2 publication.

## Fence behavior

Each covered BEFORE STATEMENT trigger hashes `txid_current()` to one of 128
shards and increments that shard's monotonic revision before source DML. All
covered statements in one transaction choose the same shard. The shard table
cannot accept extra rows or ordinary DELETE/TRUNCATE; the publisher fails
closed unless its snapshot contains exactly the expected shard inventory.
There is no backfill: existing daily revisions keep a null generation and
cannot qualify for `unchanged`.

Source reads do not hold generation-row locks. A source transaction committed
after the publisher snapshot makes the final `FOR SHARE NOWAIT` fail with a
repeatable-read serialization conflict. If the writer is still in flight, the
lock attempt fails promptly and the daily transaction is rolled back. If a
writer starts after the publisher takes all shard locks, its BEFORE STATEMENT
trigger waits before it can change a source row; the publisher has already
inserted its daily row, so only final transaction commit remains. The PG17 race
spec proves both directions. It also verifies the aggregate INSERT does not
advance a covered source generation.

The publisher's earlier source SELECTs retain PostgreSQL relation-level
ACCESS SHARE locks until transaction end. A concurrent TRUNCATE therefore
queues on the source relation, then reaches its existing refusal trigger after
the publisher commits. The PG17 test verifies this ordering and that TRUNCATE
does not complete. This privileged operation can briefly queue; it is separate
from the ordinary DML fence.

## Upload write-path impact

The typed v1.2 upload path in
[`postgres-typed-v12-admission.ts`](../../apps/worker/src/postgres-typed-v12-admission.ts)
has at least five covered statement triggers for an ordinary usage chunk:
chunk, dictionary, attribution, typed record, and typed usage. Completing a
manifest adds its ready-state update; quota and session chunks use their own
typed child statement, and session records may also write tool counts. Each
covered statement increments the transaction's same shard, so a completing
usage chunk normally causes six shard-row updates. This is additional row
version/WAL work, but transactions no longer serialize against a single
generation row. It is not one update per transaction.

The focused test runs an eight-statement superset across covered v1.2 relations
inside one transaction and verifies all eight increments land on one shard.
Its predicates match no rows, so it tests the generation trigger and lock path
without constructing synthetic source records.

## Local PG17 benchmark

On 2026-09-28, a disposable schema on the local PostgreSQL test cluster ran
400 upload-shaped transactions per case: 20 clients, 20 transactions each,
eight covered v1.2-shaped DML statements per transaction, 20 ms of simulated
work, and `synchronous_commit=on`. Statements used `WHERE false`: this isolates
the statement-trigger and generation-row contention, but omits source-row
inserts, indexes, validation, payload encoding, and object-store work. The
publisher case ran the actual daily publisher repeatedly against empty
synthetic v1/v1.1 source tables while those transactions ran. The baseline
used the singleton behavior (all generation trigger updates target one row);
the candidate used the staged 128-shard hash function. The baseline ran first,
then the candidate, against the same idle server and schema.

| Fence | Workload | Transactions/s | p50 transaction | p95 transaction | Worst transaction |
|---|---|---:|---:|---:|---:|
| Singleton | Upload-shaped only | 43.16 | 258.9 ms | 1,190.4 ms | 2,265.9 ms |
| Singleton | With publisher retries | 44.34 | 269.3 ms | 1,125.1 ms | 2,089.3 ms |
| 128 shards | Upload-shaped only | 717.36 | 22.6 ms | 44.7 ms | 68.7 ms |
| 128 shards | With publisher retries | 703.08 | 22.7 ms | 44.1 ms | 69.3 ms |

The local proxy exceeds the 50 transactions/s comparison threshold by about
14× with the sharded fence. Under continuous concurrent source churn, every
publisher attempt in this short run failed closed (`conflict`: 81 singleton,
5 sharded). After uploads stopped, a daily publish succeeded for both fences.
The candidate therefore preserves source-writer throughput in this test, but
the publisher needs a quiet/retry window to commit; publication success under
continuous ingestion was not demonstrated.

The server reported PostgreSQL 17.10, `max_connections=500`, and
`shared_buffers=512MB`; the host was macOS arm64 with 18 logical CPUs and 128
GiB RAM. The PostgreSQL build identified itself as `x86_64-apple-darwin`; this
is a local synthetic cluster, not a Cloud SQL profile. No remote resource was
read or changed in this benchmark.

## Validation and remaining gates

The focused source spec passes 38/38 against PostgreSQL 17.10. It includes
idempotent daily revisions, exact closed shard membership, eight same-shard
statement increments, committed-after-snapshot serialization refusal,
in-flight-writer `NOWAIT` refusal, source mutation after final locks, owner
erasure ordering, expiry-window refusal, TRUNCATE refusal, and stable aggregate
generation across the publisher's own insert. Worker typecheck passed.

The design remains staged pending independent correctness and performance
review. The local proxy does not qualify production row-insert costs, actual
upload volume, Cloud SQL lock/WAL/vacuum behavior, a hosted 50/s target, or
successful daily publication while uploads remain continuous. Keep v1.2 out of
published totals and require a hosted-equivalent synthetic qualification and a
separately observed quiescent publication window before promoting migration
0095 or activating a reader.

The authority inventory and earlier fence evidence are retained in the
[2026-09-27 generation-fence snapshot](2026-09-27-gcp-v12-daily-generation-fence-snapshot.md).
