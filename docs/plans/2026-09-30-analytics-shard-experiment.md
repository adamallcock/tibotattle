---
title: Analytics physical sharding experiment
date: 2026-09-30
type: plan
status: in-progress
---

# Analytics physical sharding experiment

## Status and boundary

The physical shadow experiment is complete. The owner approved a comparison after D1 refused the populated
9.81-million-record index build with `SQLITE_NOMEM`. This experiment compares
one database with four databases using **synthetic record headers only**.
It does not admit live uploads, compute application outputs, move production
records, change service bindings or publish results.

The broader migration checklist remains in the
[analytics redesign plan](2026-09-28-analytics-redesign.md). The production
operations runbook remains the authority for production changes.

## Findings that determine the experiment

- Compact allocation metadata accounts for 9,811,828 retained v1/v1.1 records,
  57 physical devices and 54 physical typed owners. The largest physical group
  has 2,521,345 records. These are retained allocations, not effective public
  counts; v1.2 and correction archives are outside this census.
- A continuity mapping check leaves **51,562 records** without a mapping in the
  checked metadata. Their authority must be reconciled before real migration.
  Missing mapping does not establish erasure, eligibility or redundant copies.
  A follow-up aggregate at 22:13 UTC identifies all of them as v1.1 allocations
  in four physical groups with memberships and active participants, but without
  a public-source entry or current v1.1 head. Preserve them as retained evidence
  outside the currently published source set; qualify their placement and later
  admission without inventing a current public owner link.
- Deduplication and correction variants must remain together across formats.
  Device IDs alone are insufficient. Use stable continuity metadata for
  placement while allowing independent day/range computation jobs.
- The synthetic profile reproduces the measured total, group count and largest
  weight. Remaining group weights use an explicit synthetic distribution.
  Its balance is not a measurement of production hash placement.

## Experiment implementation

The standalone operational tools under `apps/worker/scripts/` are not imported
by the application. Local mode uses five distinct native workerd instances and
loopback transports. Online mode is explicit and accepts an exact plan digest;
it creates five uniquely named private D1 databases in the existing account.
The plan pins tool sources, account, resource names, dataset and a 24-hour
mutation window. It has no deployment, source-import or deletion mode.
Private operation journals can live under the ignored Worker `.wrangler`
directory, with owner-only permissions, to survive temporary-directory cleanup.

There are 256 stable virtual buckets, packed by synthetic weight into four
targets. The baseline holds every group. The direct owner/occurrence index is
created while each target is empty. Generated record headers use a 42-byte
occurrence key, matching the observed maximum used for capacity qualification.

Loading uses at most 10,000 rows per native transaction. A checked prior cursor,
row insert, checkpoint advance and guard cleanup commit together. A lost write
response is resolved from durable state without blindly repeating a batch.
An interrupted resource creation is reconciliation-only. Foreign names, schema,
routing or source pins stop work. Lost measurements stay explicitly incomplete.

Before online loading, an intentionally refused native batch must prove that
an earlier statement was rolled back. Per-database exact counts and identifier
sums seal the generated dataset. The comparison checks identical query results
for bounded occurrence lookups and range reads at concurrency **1/2/4**. Both
layouts run at the same client concurrency, with warm-up, three trials and
alternating execution order. Record database time, rows read/written and wall
time separately. REST latency is included in online wall time; no Worker
scheduler, application reducer or publisher is included.

A second workload scans the entire synthetic index using four partition
queries, each bounded to three million headers. Both layouts perform the same
four queries and return the same counts and identifier sum: **four aggregate
rows, not the headers themselves**. This reduces REST overhead relative to many
short queries. It excludes record transfer into a worker, payload decoding,
feature preparation, fitting and publication. The short queries also return
counts and checksums rather than record payloads.

## Running checklist to production migration

- [x] Read-only size/skew census without scanning the large record table.
- [x] Check correction/continuity routing and identify incomplete mappings.
- [x] Implement closed synthetic-only plans, index-before-load, bounded
  resumable seeding and exact physical query comparison.
- [x] Pass 23 focused operational/native D1 tests, including rollback,
  unapplied/lost writes, create reconciliation, resource drift and concurrency.
- [x] Complete the local experiment at full observed cardinality.
- [x] Provision and seal one online baseline plus four synthetic shards.
- [x] Measure online physical queries at concurrency 1/2/4; retain actual
  storage sizes, SQL work, wall time and failure evidence.
- [x] Choose the next local slice: qualify one rebuilt source database with
  indexes installed before loading; resume dependency summaries and shared
  preparation/date reuse. Keep parallel calculation as a later experiment.
- [ ] Reconcile unmapped records and all-format placement; qualify a real-source
  resumable shadow seeder with authority, erasure and correction fences.
- [ ] Compare every analytical output family, late correction, replay,
  interruption and erasure against the existing pipeline.
- [ ] Measure full preparation, calculation, adoption and publication throughput;
  qualify analytics-target coordination and publisher capacity.
- [ ] Implement the descriptive pipeline admin view requested by the owner.
- [ ] Prepare exact shadow cutover, rollback and final owning validation.
- [ ] Obtain approval for the concrete production cutover and qualify it live.

## Local measured results

The full native local run loaded **9,811,828 baseline records and 9,811,828
sharded records**, with all indexes created before loading. Synthetic shard
loads: 2,521,345 / 2,414,275 / 2,414,351 / 2,461,857.

The table reports the retained local repetition completed at 22:44 UTC. Its
[full numerical receipt](../receipts/2026-09-30-analytics-shards-local.json)
is separate from the initial exploratory run reported earlier in the redesign
checklist; results from those runs are not averaged together.

| Warm workload | Concurrency | One DB wall time | Four DB wall time | Observed ratio |
|---|---:|---:|---:|---:|
| Occurrence lookups | 1 | 21.63 ms | 27.34 ms | 0.79x |
| Occurrence lookups | 2 | 20.96 ms | 15.57 ms | 1.35x |
| Occurrence lookups | 4 | 20.67 ms | 9.51 ms | 2.17x |
| Range reads | 1 | 35.90 ms | 41.70 ms | 0.86x |
| Range reads | 2 | 34.98 ms | 21.06 ms | 1.66x |
| Range reads | 4 | 32.64 ms | 15.04 ms | 2.17x |

All compared queries returned exact expected counts and identifier sums.
Occurrence queries read 41,472 rows in either layout; range queries read
540,054. The comparison queries wrote zero rows. These very short local
measurements are exploratory. They do not establish Cloudflare throughput or
the original 10x whole-pipeline target.

## Online results and next step

The Cloudflare seed completed at 22:53 UTC. Five indexed databases are sealed:
9,811,828 records in the baseline and the same total across four shards. Final
allocated storage is 1,268,297,728 bytes in the baseline and 1,268,383,744 bytes
across the shards. This qualifies the empty-index-then-load strategy for the
synthetic header schema at this cardinality, including native batch rollback.
It does not qualify cloning the full production role or its admission writers.

The original loader was interrupted after 5,815,348 baseline records. Its
temporary local operation files subsequently disappeared. A read-only recovery
matched the unique five-resource group, creation window, exact schemas and
native dataset/checkpoint hashes. A successor private journal binds those exact
existing databases and retains the reconciliation evidence. Loading resumed
without reseeding the committed prefix. The
[seed receipt](../receipts/2026-09-30-analytics-shards-seed.json) marks the baseline
measurement incomplete; its partial time and costs are not presented as a full
baseline/shard loading comparison.

Three warm trials, alternating layout order, completed at 23:02 UTC. Ratios
compare layouts at the same client concurrency. All results have exact
count/checksum parity and zero query writes.

| Online workload | Concurrency | One DB median | Four DB median | Observed ratio |
|---|---:|---:|---:|---:|
| 54 occurrence lookups | 4 | 4.339 s | 4.538 s | 0.96x |
| 54 bounded range reads | 4 | 4.321 s | 4.602 s | 0.94x |
| Indexed count/checksum scan over 9.81 million headers | 1 | 2.081 s | 2.766 s | 0.75x |
| Indexed count/checksum scan over 9.81 million headers | 2 | 1.570 s | 1.953 s | 0.80x |
| Indexed count/checksum scan over 9.81 million headers | 4 | 1.276 s | 0.822 s | **1.55x** |

The [short-query receipt](../receipts/2026-09-30-analytics-shards-online.json) and
[whole-history receipt](../receipts/2026-09-30-analytics-shards-full-read.json)
retain every trial, SQL duration and row counts. The raw receipt's legacy
`whole-synthetic-header-acquisition` label describes this aggregate scan, not
header transfer. Its recorded source hash and measurements are preserved;
future tool output uses the more precise count-scan label. At concurrency four,
the full scan reads about 9.81 million rows in either layout and consumes about
0.983 seconds of cumulative SQL time in the baseline versus 1.428 seconds
across shards. Four databases overlap independent SQL work; they do not reduce
the total work. Short-query wall time is dominated by REST requests. Worker
binding latency and application CPU remain unmeasured here.

**Recommendation:** qualify a single source-store rebuild with all required
indexes created before loading. Preserve complete schemas, dictionaries,
admission state, corrections, staged evidence and erasure safeguards. This
addresses the populated-index memory refusal with one authority boundary.
Then resume maintained dependency summaries and durable shared preparation/date
reuse, where the earlier local evidence showed much larger reductions in work.
Measure full pipeline throughput before expanding source storage to four
databases. The observed 1.55x aggregate-scan gain does not establish the 10x
target or real-record acquisition throughput.

At 22:55 UTC, all four production Worker versions matched the previously
reconciled `d43c8f92` deployments. This experiment deployed no application Worker,
changed no production binding and moved no real production records. The five
synthetic databases remain available for bounded follow-up qualification;
cleanup and production cutover require their own exact approved operations.

Cloudflare documents that each D1 database executes queries serially, so
independent databases can increase physical parallelism. Work must still be
divisible and final publication bounded. See
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and the
[parameterized database query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/).
