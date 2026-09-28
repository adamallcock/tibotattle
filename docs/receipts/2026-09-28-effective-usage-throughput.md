---
title: Effective model usage cache qualification
date: 2026-09-28
type: receipt
status: deployed-initial-health-canary-complete
---

# Effective model usage cache qualification

The owner approved migration 0029 and source `23575017` for production.
Both are applied and independently verified. The initial health canary passed
18 natural scheduled runs. Production cache reuse and its speed benefit remain
unmeasured because those runs found no new graph work. The preceding production
source is `15a5907e`.
The [production runbook](../runbooks/production-operations.md) remains the
operational authority. The [plan](../plans/2026-09-27-effective-cache-throughput.md)
records earlier experiments and deferred enhancements.

## Candidate

- Source: `23575017c61d7b83093227d71e09096e50cf7bd1`, a clean local commit
  based on deployed source `15a5907ec784b1137242fd2d30cc7447a6010242`.
- Target Worker: `tibotattle-analytics-recovery-20260914`.
- Active version: `4514cd0c-fff8-47d3-a487-a7a291f0dbb5`, at 100% on
  September 28 at 13:48 UTC. Readback at 13:48:46 verified exact version
  resources, bindings, runtime, minute schedule, complete schema and ledger.
- Analytics bundle: 1,418,228 bytes; SHA-256
  `35e40cafc007b00319bb0660b6d4a1d6c7033903fe7b1130c49d20f3fe70ab16`.
- Required analytics migration: `0029_graph_day_effective_usage.sql`;
  SHA-256 `d2d25b2c7efec01b810efebc4120b5c4def03d577e7cb779d7f72088d65b3ebe`.
- Production compatibility adjustments and migration 0027's absence are
  preserved. No source branch push or merge has occurred.

## Changes

1. Prepare compact effective usage summaries once per complete day, then reuse
   them for model calculations with overlapping windows. Fits continues its
   scalar usage traversal.
2. Keep the current correction-aware effective reader, owner/erasure fences and
   price/method identity. Session openers and tails preserve account changes
   across page and day boundaries. Raw session IDs and usage records are not
   copied into prepared checkpoints.
3. Use checkpoint format 5 for model usage preparation, adopting format 4, 3,
   2 and original checkpoints without overwriting their heads. Retain the
   analytical fallback while constructing missing days independently.
4. Group up to four small 200-occurrence reading pages per checkpoint save.
   Completed days, folds, refusals and the first successor exceeding 30 parts
   end the group, so interrupted saves remain reproducible.
5. Preserve the 950-statement invocation cap, one-million-row work limit,
   4 MiB day bound, 8 MiB window bound and conservative 4,096-entry fold
   eligibility. A preparation limit selects the ordinary bounded calculation.

## Measured performance

The paired fixture contains 12,122 synthetic v1.2 usage events and 61 quota
observations over five days, including a session crossing midnight. It runs in
the isolated candidate with production's migration set plus proposed 0029.
Both paths include source scope capture, dependency validation, checkpoint work
and all compute invocations. The control disables only prepared usage.

| Measure | Paged control | Prepared usage |
| --- | ---: | ---: |
| First model statements | 1,399 | 1,634 |
| Adjacent model statements | 1,161 | 117 |
| Combined statements | 2,560 | 1,751 |
| Combined source rows read | 157,681,013 | 85,793,452 |
| Combined checkpoint payload bytes | 1,799,159 | 1,238,842 |
| Usage-page queries, first / adjacent | 65 / 65 | 65 / 0 |
| Compute invocations, first / adjacent | 2 / 2 | 3 / 1 |
| Highest statements in one invocation | 773 | 772 |

The warm model needs approximately 90% fewer statements. Including preparation,
the two jobs use 32% fewer statements and 46% fewer source rows read. These are
database execution counters, including repeated/index reads, not distinct input
event counts. Full analytical output is identical between the paired paths.

Preparation is a tradeoff: the first job uses 17% more statements and one extra
invocation. A smaller 1,322-event fixture in the main migration set costs 744
combined statements versus 684 for control, although its warm job falls from
230 to 117. The optimization benefits repeated work. Local timings and these
fixtures do not establish a ten-times production or whole-pipeline speedup.

A genuine second v1.2 generation changes September 3 in the synthetic fixture.
It creates one new usage summary, retains all four other day summaries byte
for byte, and produces the same corrected result as the paged control. It reads
13 usage pages rather than revisiting all five days.

## Validation

- Focused pure folding, cache/kernel, checkpoint/replay, compatibility and
  migration store tests: **74/74 passed**.
- Existing graph-history integration: **42/42 passed**.
- Production-schema paired 12,122-event profile and corrected-day parity:
  **passed**.
- TypeScript, documentation and preflight checks: **passed**.
- The first full Worker gate found a stale migration-count assertion. Both
  checkouts' exact expectations were updated for 0029; the dedicated script
  test passes in each. The full rerun passed **2,223/2,223 Worker tests across
  172 files**, together with workspace-copy, endpoint, generated-type,
  TypeScript and operations-script gates.
- The umbrella command then exited 1 at the general website asset stage:
  its generated public release manifest is absent from the isolated checkout.
  The later staging gate was not reached. This does not qualify website or
  staging deployment; the analytics artifact has no website-assets binding.
- Analytics-only Wrangler 4.114.0 dry build: **passed**. Its source, bundle,
  expected modules, 950 cap and production configuration are pinned. Existing
  bindings, runtime settings and schedule are preserved.

## Migration rehearsal and production boundary

The read-only production snapshot at September 28, 13:09 UTC verified source
`15a5907e` at 100%, 189 schema objects and all 27 migration hashes. The candidate
rehearsal reproduced that complete schema from canonical migrations, then
applied 0029 and its ledger entry together in a local transaction. The result
has 190 schema objects and zero foreign-key violations. Focused tests preserve
nonempty legacy payloads, nonzero quota metadata, page framing, immutable
guards, retirement fences and terminal owner erasure across the upgrade.

Migration and activation are separate production operations. The owner gave
the required explicit authorization under `apps/worker/AGENTS.md`. The operation
verified the exact predecessor, acquired the shared deployment lock and obtained
a D1 Time Travel recovery point before applying only 0029 and its ledger entry.
Migration verification completed at 13:46:20 UTC.
All 190 schema objects and the complete migration ledger match rehearsal, with
zero foreign-key violations. Before/after fingerprints match for all 2,067
prepared values and 8,358 payload pages, including existing quota metadata.
The recovery-point details remain private. Upload, activation and the initial
health canary are verified. No production performance claim is made from the
local benchmark.
Version `b38bdda0-0013-4d99-ad06-a414e90da3b2` / source `15a5907e` remains
the code rollback target, with the forward migration retained.

At the snapshot, 130 publication dates remained queued and 2,112 graph results
were stored; the latest model publication day was September 28. Four graphs
had completed in the preceding hour and none in the preceding ten minutes.
These are observations of the preceding deployment, not this candidate.

A later aggregate at 13:29 UTC recorded 127 queued dates and 2,113 stored graph
results. At 13:33 UTC there were no active effective job selections. Readback
at 13:34 UTC verified `15a5907e` still active at 100% and two stored effective
results for each of the model and fits metrics for September 28. Those jobs
completed on the preceding deployment.

The pre-activation sample at 13:47 UTC recorded 126 queued publication dates,
2,113 stored graph results and latest model publication day September 28.
No effective usage cache values existed before this activation.

## Initial production observations

Observed runs from 13:49:53 through 14:06:52 UTC all belong to version
`4514cd0c-fff8-47d3-a487-a7a291f0dbb5`: 16 ordinary runs and two longer
passes. All 18 have outcome `ok`, zero exceptions, zero lane failures and zero
graph failures. Each reports `idle` / `complete`; statement use ranges from
56 to 188, with the two longer passes using 110 and 98. No new graph result or
effective usage summary was built during this sample. This qualifies initial
scheduler health, not production execution or throughput of the new cache path.

The final 14:07:15 UTC readback independently verifies the exact active source
and version at 100%, full schema and migration ledger, bindings, runtime and
minute schedule. The exact owned deployment lock was released at 14:08:00 UTC.
Both observation processes stopped normally. No rollback was needed.

The September 28, 13:56 UTC aggregate verifies the deployed version and finds
stored model publications for all 70 dates from July 21 through September 28,
under one method. Today's stored results comprise 51 fits and 51 model results,
including two effective results for each metric. These completions predate this
activation. Stored publication presence alone does not validate every payload;
the scheduled Worker retains its ordinary authority and dependency checks.

There are no effective work selections. Sixteen retained v1.1 selections are
all older fits jobs dated September 22–27 and created before activation; four
still have a result matching the selected dependency. The scheduler selects
today's fits and historical models, so these retained older fits selections
are separate from its current work. No selections or checkpoints were manually
deleted or rewritten. This observation does not claim that all retained
selections have completed.

### Separate daily publication lane

The daily queue moved from 126 dates before activation to 125 by 14:05 UTC;
the oldest remaining date is May 27. The final 14:07 UTC aggregate still has
125 dates and 2,113 stored graph results. This deployment changed only the
analytics Worker; the daily publisher remains on source
`ba7f00b28a32cc839f420db32dec7009b31e884b`, version
`d1c3360a-1708-49bd-bb87-19bd3ea8a609`.

Three naturally scheduled publisher runs were observed separately. Each has
outcome `ok`, no exceptions, eight steps, 804 statements and a controlled
`query_budget` deferral. Each spends 56 statements on retirement sweeps that
report no work. Elapsed time ranges from 24.1 to 33.3 seconds. None reports a
new publication in those three runs; the queue reduction is an independent
storage observation, not an attributed log completion.

Bounded checkpoint readbacks from 14:05:45 to 14:07:15 confirm partial progress:
May 27's retained v1.1 owner folds increase from 18 of 19 complete to 19 of 19,
and their summed progress revisions rise from 58 to 78. Work also advances on
May 28. These are persisted intermediate folds, not proof that either date has
published. The remaining daily backlog is therefore a separate optimization
target; it is not evidence that the newly deployed graph cache is stalled.

## Later enhancements

Prioritize a paired profile of the daily publisher: completed-date cost,
owner-fold progress and repeated empty-sweep overhead, using its exact deployed
source as control. The new graph cache needs a naturally arriving effective
model job before production reuse can be measured. Profile the fits usage phase
separately when it is again material. Bounded Queue concurrency (option 3) and
D1 read replicas (option 4) remain deferred, with throughput and database
pressure measurements required before changing topology.
