---
title: "Why the Worker analytics rebuild is slow"
date: 2026-09-15
type: research
status: investigation
---

# Why the Worker analytics rebuild is slow

The immediate problem is excessive repeated database work around very small
amounts of useful processing. One historical contribution contains **2.12 million
records**, but the current calculation saves progress after approximately **200
records**. Each step performs roughly **60 database statements** and takes about
**4.2 seconds**, including database waits. That turns a finite rebuild into hours
of work.

This is an engineering limitation of our current processing path. The evidence
does not establish that Cloudflare is incapable of handling the workload, or
that purchasing more CPU would solve it. We need fewer database round trips and
more useful work per admitted transaction.

## Scope and status

This is a point-in-time investigation, with production measurements through
**September 15, 2026, 08:35 UTC**. Deployed analytics recovery source:
`79048a39a7e2f4f8f1e5d948b4de4b0365308f4a`. Later improvements described below
are proposals or work in progress, not claims about deployed behavior.

The original data migration is complete. Enrollment and uploads are operational,
and the website and update feeds have been published for 0.1.23. The unfinished
part is historical analytics catch-up and restoration of the public graph.
The ordinary analytics schedule is deliberately paused while the temporary
recovery worker processes the same ordered source history. Upload processing
continues separately.

This document is supporting evidence, not an operational runbook. The
[documentation index](../README.md),
[system architecture](../reference/system-architecture.md), and
[schema lifecycle](../reference/schema-contracts.md) remain the maintained
entrypoints. Production changes still require exact source, checkpoint and
deployment verification.

## What each Worker and database is doing

| Component | Purpose | Relevance to this incident |
|---|---|---|
| Main hosted service and upload processing | Enroll installations, accept contributions, serve website and Admin | Currently operational; uploads do not wait for historical graph calculations |
| Ingestion D1 | Retain accepted telemetry and the ordered change journal | Source of truth for this rebuild; original retained data is preserved |
| Temporary Queue recovery worker | Replay the journal and build analytical values | Current slow path; one active consumer follows one ordered cursor |
| Analytics D1 | Store repeatable values, checkpoints and publication state | Separate from ingestion; rebuilding calculations no longer fills the upload database |
| Deletion ledger | Coordinate authoritative erasure and safe replay | Checked during processing; it cannot be omitted to increase speed |
| Ordinary analytics worker | Maintain calculations and published community results | Resumes after catch-up and explicit public-mode activation |

Moving analytics to its own database reduces the impact of a failed calculation.
It does not itself make an individual calculation faster. Similarly, sharding
ingestion provides capacity and independent work across installations; it does
not automatically parallelize this single large contribution.

## What we measured

| Measurement | Result | Evidence boundary |
|---|---:|---|
| Records in the large v1.1 contribution | 2,122,823 | Read-only aggregate of accepted source chunk counts |
| Historical days represented | 122 | Exact generation membership |
| Required physical calculation steps | 10,680 | Sum of `floor(records_in_day / 200) + 1` over the accepted days |
| Progress at 08:35 UTC | 201,317 records; 1,016 steps | Durable recovery receipts; the contribution is still building |
| Earlier implementation | 6,103.6 ms and 85 queries per step | 172 production steps on source `18b38f1d` |
| Deployed improvement | 4,228.1 ms and 60.1 queries per step | 585 production steps on source `79048a3` |
| Elapsed cadence after deployment | Approximately 4.68 seconds per step | Time between first and last receipt in the 585-step sample |
| Measured processing-rate improvement | Approximately 44% | Ratio of recorded step durations; not a complete rebuild benchmark |

The newer sample spans roughly 46 minutes. It confirms a sustained improvement,
but not completion. Partial final pages explain why records per step are not
always exactly 200. A day with an exact multiple of 200 records currently needs
an additional empty read to establish completion.

At the 08:35 checkpoint, 9,664 of these physical steps remained. At 4.68 seconds
per step, that is approximately **12.6 hours for this contribution alone** if the
implementation and cadence do not change. This is a calculation from observed
processing speed, not a planned verification delay or a full-service completion
promise. Later journal events and publication still require processing.

SQL statements and database calls are different quantities. A local structural
probe of the ordinary path reduced binding calls from 55 to 43 by batching
reads, without reducing its 58 SQL statements. That fixture has a different
cursor state from production; its counts must not be substituted for the live
60-query measurement. Nor does a local benchmark prove cloud latency.

## Why it is slow

### 1. Small pages pay substantial fixed overhead

For each small page, the code validates runtime and storage contracts, reads the
ordered cursor, proves the prior receipt and next event, checks the contributing
owner and erasure state, resolves immutable generation membership, reads the
records, folds values, rechecks the source, and saves a checkpoint. Retirement
and Admin maintenance add further work.

These checks have valid purposes. The problem is that several layers repeat
the same admission work within one step. Before the deployed repair, the Queue
path also repeatedly checked whether this already-known v1.1 work belonged to
the older v1 format.

### 2. Sequential database calls accumulate elapsed time

Many individual queries are small, but a long sequence of awaited calls pays
database and transport overhead repeatedly. The source review and measured
improvement after batching support this as a significant contributor.

We have **not** measured a complete per-query production latency profile or a
CPU-versus-I/O breakdown. It would be inaccurate to label all 4.2 seconds as SQL
execution time, network latency, or CPU use. Recorded step duration includes
waiting. Cloudflare also distinguishes elapsed wall time from active CPU time.
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/#wall-time-limits-by-invocation-type)

Cloudflare's D1 batch API explicitly reduces round trips by sending several
prepared statements together. Statements remain ordered, and a failure rolls
back the batch. A batch operates on one database binding; it is not a transaction
across ingestion, analytics and the deletion ledger.
[D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

### 3. This contribution is building the first reusable cache

The earlier v1-format projection does not already contain these exact v1.1 daily
values. This first generation must scan its records and produce reusable pages.

A later generation can reuse a day only when its full identity matches:
source, storage namespace/layout, owner, device, immutable manifest ID and digest,
date, calculation schema, pricing method and registry. Matching dates alone are
insufficient. A changed manifest or calculation method can require recomputation.

This means normal unchanged-history updates should be cheaper, but that is a
conditional property of the implementation. We still need a production
measurement of reuse after this first cache is complete.

### 4. The ordered event cursor hides substantial internal progress

The global journal cursor advances only after every day in this contribution is
complete, or an authoritative terminal event discards it. Thousands of successful
page checkpoints can therefore occur while the displayed event cursor does not
move.

Earlier estimates based on remaining journal events missed this nested work.
Monitoring must show records, physical page revisions, completed days and the
age of the last successful receipt, as well as the outer cursor.

### 5. The recovery path favors bounded, recoverable units

The deployed catch-up handler allows up to three work units per delivery, a
20-second application deadline, an 840-query processing budget, and a
10,000-unit run cap. The run cap requires a fresh, verified continuation if
reached; it must not silently abandon unfinished work.

The 20-second bound is our application setting. Cloudflare documents a
15-minute maximum wall time for Queue consumers. Increasing our bound can reduce
delivery overhead, but does not remove the expensive checks repeated inside each
unit. In the earlier production sample, about 93.5% of the measured receipt span
was already spent inside recorded work. Queue dispatch was the smaller share.
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/#wall-time-limits-by-invocation-type)

The physical 200-record size is embedded in page indexes, completeness triggers
and reuse validation. Simply increasing that constant would break the retained
format. We should retain those pages and improve how we process them.

## Fixes and next options

| Change | Status at this snapshot | Benefit or limitation |
|---|---|---|
| Separate ingestion and analytics storage | Deployed | Restores isolation so graph rebuilding does not prevent uploads |
| Queue-driven resumable catch-up | Deployed | Continues work independently of the ordinary scheduled pass |
| Resume known partial work without repeating older-format detection | Deployed in `79048a3` | Part of the measured reduction from 85 to about 60 queries |
| Batch independent source and typed-record reads | Deployed in `79048a3` | Fewer database round trips; combined live improvement about 44% |
| Consolidate repeated ordinary v1.1 admission | Implementation and independent review in progress | Source audit identified about 19 potentially removable queries; live benefit is not yet measured |
| Process a bounded group of existing physical pages together | Design under review | Larger opportunity to share fixed overhead without changing the retained 200-record format |
| Increase Queue concurrency | Deferred for this cursor | Extra consumers can contend for the same ordered work rather than divide it safely |
| Change Worker placement | Not a direct Queue fix | Documented placement applies to fetch handlers, so a placement flag alone does not relocate this Queue execution path |
| Move analytics compute to GCP | Longer-term option | Evaluate if bounded batching still cannot meet recovery and ongoing throughput needs; moving platforms alone does not remove repeated calls |

The deployed source passed 107 focused tests, then the full Worker gate:
121 test files, 1,460 tests, and production/staging dry builds. Its live code
digest was verified before the retained Queue message resumed. This establishes
the repair's qualification; it does not establish graph recovery completion.

For the next admission repair, a saved Queue receipt remains only a routing hint.
The worker must still verify current authority. The final source and owner check
after reading records remains immediately before saving calculated values.

A promising subsequent design groups at most five existing 200-record pages
from one immutable day. Each page keeps its own values, digest, revision and
checkpoint; their ordered writes share one database transaction. This requires
bounded reads and memory, reserved query/time headroom, a final source check,
and exact recovery of all page receipts after a lost response. It must stop at
a day or generation boundary. It is **not implemented or qualified at this
snapshot**, and no speedup is claimed for it.

Cloudflare documents ordered transactional batches, while individual statement
limits still apply. D1 is also single-threaded per database: adding concurrent
callers does not make one database execute its queries in parallel.
[D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

Both Smart Placement and explicit placement currently document fetch-handler
scope. A different execution architecture would need its own design and
measurement; it is not a configuration-only remedy for this Queue consumer.
[Worker placement](https://developers.cloudflare.com/workers/configuration/placement/)

## What we need before calling this resolved

1. Measure useful records per elapsed second after each deployed repair, using
   only receipts from that version. Keep pauses and mixed-version samples separate.
2. Finish the first-generation cache, then measure a later generation's actual
   reuse rate and changed-day processing cost.
3. Prove that sustained processing exceeds incoming work, with capacity reserved
   for another large installation or a required cache rebuild.
4. Keep authoritative source/owner checks, opt-outs, erasure, exact accounting,
   atomic checkpoints and replay recovery intact through failure tests.
5. Once the source journal is caught up, activate ordinary public analytics,
   observe a successful scheduled run, and verify the rendered public graph.

For ongoing operations, monitor both storage and processing capacity. The
9 GB per-database operating budget addresses storage headroom. Separately alert
on the oldest unprocessed contribution, remaining physical pages, processing
rate, last successful checkpoint and time since publication. A database can have
ample free space while its analytical backlog grows.

## Evidence and implementation pointers

The measurements above are aggregate-only. No participant identifiers, record
payloads, credentials or private session content are included.

| Evidence | Identity |
|---|---|
| Earlier deployed recovery source | `18b38f1d2ed707d5e8ab6795ef6ec833b988bc13` |
| Measured deployed repair source | `79048a39a7e2f4f8f1e5d948b4de4b0365308f4a` |
| Live repair bundle SHA-256 | `6f79ac7703f43e14d4b8e4ebacc82782f10668f9d62bd77ea31bb6e093773d69` |
| Full Worker qualification receipt SHA-256 | `241a10833225c670e4af79fef84620a112e529b685dfea7a4237646f8de361a2` |
| Initial batching and hint review | [PR #157](https://github.com/adamallcock/tibotattle/pull/157) |

Source references should be read at the deployed revision above when reproducing
this snapshot; the checkout may contain later work:

- [Catch-up handler](../../apps/worker/src/storage-analytics-catchup-worker.ts):
  Queue work units, budgets, receipts and partial-work hint.
- [Analytics runtime](../../apps/worker/src/storage-analytics-runtime.ts):
  ordinary dispatch, repeated admission and maintenance.
- [Daily v1.1 projection](../../apps/worker/src/v11-daily-projection.ts):
  200-record pages, immutable-day reuse, final source proof and saved steps.
- [Typed record reader](../../apps/worker/src/typed-v11-record-reader.ts):
  membership validation and bounded compatibility reads.
- [Page schema and triggers](../../apps/worker/analytics-migrations/0013_v11_daily_value_pages.sql):
  retained page-size and completeness contracts.
- [Source journal proof](../../apps/worker/src/v11-storage-journal.ts):
  current generation and terminal-owner handling.
