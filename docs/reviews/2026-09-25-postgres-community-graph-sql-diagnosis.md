---
title: PostgreSQL community graph SQL diagnosis
date: 2026-09-25
type: review
status: supporting-evidence
---

# PostgreSQL community graph SQL diagnosis

This is point-in-time evidence for the synthetic 100,000-member graph benchmark.
It is a query diagnosis, not a capacity promise, a cutover decision, or proof of
a hosted speedup. The local plans use PostgreSQL 17; the hosted timing receipt is
from the isolated GCP test Job `tibotattle-public-graph-benchmark-lxwpq`.

## Matched hosted run

The hosted `100k-batched` run matched the existing read-indexed workload, source,
and output digests:

| Digest | SHA-256 |
|---|---|
| Workload | `7b3199c3da470fd8c55806f275f4f3094cb5be4fff7158aa1d07bcfc7a27f5fc` |
| Source | `c90d7927e4444ccb53db17822d5c11fa42adfd933854fbc50123a70cc9dde934` |
| Output | `4025b72539599beb754fb0b3a476203d05b2c0ff07fb824f9287656b40f7b10f` |

The Job took 283.973 seconds overall, with 183.658 seconds in publication and
50.498 seconds in readback. It made 325 SQL calls over one checked-out database
connection and reported 157 MB peak RSS. Compared with the earlier matched
read-indexed run (285.425 seconds, 864 calls), this changed total elapsed time
by only 1.452 seconds. That small difference is not evidence of a meaningful
hosted speedup.

| Hosted SQL category | Calls | Cumulative time |
|---|---:|---:|
| Publication member writes | 25 | 56.78 s |
| Result-page proof/capacity apply | 98 | 60.02 s |
| Owner-result page reads | 98 | 30.98 s |
| Publication member readback | 25 | 40.26 s |

The categories account for query time, not a causal breakdown of Cloud SQL,
network transfer, Node parsing, or application round trips. The result-page
receipt estimates about 113 MB read across 98 sequential calls, roughly 316 ms
per call. The available receipt does not separate server execution from driver,
network, and serialization time.

## Local PostgreSQL 17 plans

`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` ran against the local synthetic
100,000-member profile. DML probes ran inside savepoints and were rolled back;
the full benchmark then ran normally and matched the same digests.

| Statement | Plan and measured work |
|---|---|
| Owner-result page read | 1,024 rows in 5.6 ms. It reads the C-collated temp-member index in owner order and performs 1,025 indexed lookups using `analytics_owner_results_publication`; about 4,959 shared hits and 166 shared reads. No sort or full result-table scan. |
| Result-page apply | 1,024 proof updates and capacity inserts in 10.5 ms. The member-table update accounts for about 9.4 ms, with roughly 18,004 local-buffer hits, 885 reads, 994 dirtied blocks, and 113 written blocks. The capacity insert takes about 0.9 ms. |
| Publication member write | 4,000 rows in 91.5 ms. The target `ModifyTable` node accounts for about 89.3 ms, with 45,449 shared hits, 391 reads, 384 dirtied blocks, and 638 written blocks. |
| Member readback page | 4,096 rows in 12.5 ms through the publication primary-key index and indexed owner, link, and participant lookups. No sort or full-table hash join. |

These local timings are not comparable capacity measurements for the hosted
Cloud SQL tier. They show that the local plans use the intended indexes and do
real row/index and temporary-table work. The hosted statements take much longer
per page, but the plans and minute-level monitoring do not identify which
hosted service boundary contributes that difference.

## Tested hypothesis and outcome

The local apply plan showed repeated updates to the large temporary member table.
A source-only experiment replaced those updates with inserts into a separate
temporary proof table, joined at final receipt and member insertion. It kept the
100,000-member output digest, but the single local run increased publication
time from 9.009 to 9.619 seconds and result-page apply time from 1.018 to 1.267
seconds. This is not a demonstrated improvement, so the experiment is not
accepted as an optimization. Its worktree changes are uncommitted and excluded
from any build or hosted benchmark.

The hosted owner-result read and proof/apply stages do include 98 serial page
calls. Reducing calls could remove some round-trip overhead, but each page is
bounded by both row count and payload bytes. The Worker currently validates each
stored payload hash, complete composition, method, freshness, and authority
fields before writing proof and normalized capacities. A single all-cohort
statement would either accumulate an unbounded application-side result or move
those checks into SQL, where matching the current closed validation and
canonical output has not been demonstrated. The already bounded page apply
combines proof and capacity writes in one call. The earlier unpaged 100,000-row
publication statement exceeded the hosted 120-second statement timeout.

## Next bounded research

Use a fresh isolated 100,000-member schema to split query execution from transfer
and application time for the result read/apply path, using Query Insights or a
content-free phase-timed hosted runner. Then test one bounded candidate at a
time—such as a modest member-batch adjustment—against repeated local PG17 runs
with exact digest, rollback, replay, page-size, and memory checks. Do not replace
the Node validation path with SQL unless a separate differential test proves
equivalent payload, authority, privacy, and output semantics.
