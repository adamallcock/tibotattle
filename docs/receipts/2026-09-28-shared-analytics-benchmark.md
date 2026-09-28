---
title: Shared analytics input experiment
date: 2026-09-28
type: receipt
status: verified-local
---

# Shared analytics input experiment

This receipt covers the first local implementation in the
[analytics redesign plan](../plans/2026-09-28-analytics-redesign.md), using only
synthetic admitted data. It implements shared input preparation and compares all
four analytical output families with existing kernels. It does not qualify
production throughput, durable jobs, public cohort assembly or publication.
The [production runbook](../runbooks/production-operations.md) remains the
operational authority. No deployment or remote mutation is part of this work.

## Implemented boundary

- The [input cache](../../apps/worker/src/analytics-shared-input.ts) acquires
  complete effective days across v1, v1.1 and v1.2. It preserves source authority,
  owner-scoped deduplication, exact day dependencies, explicit empty days and
  occurrence links from outside a day's range. A changed source rechecks day
  dependencies; only changed days are rebuilt. Unchanged replay checks authority
  without rereading raw history or day dependencies.
- The [reducers](../../apps/worker/src/analytics-shared-reducers.ts) share that
  acquisition across daily activity/API value, current scalar fits, historical
  model fits and cache continuity. Existing statistical and accounting kernels
  are reused. Model/quota preparation is reused across dates; current scalar
  reduction still parses and prices retained usage rows through its existing
  kernel. This is not yet a single decode/price pass for every consumer.
- A successor cache becomes reusable only after its final source check. Callers
  check authority again after computation. Cancellation, deadline, concurrent
  load, row/day/serialized-byte limits and source changes refuse incomplete
  work. Private rows and features remain in memory. No production entrypoint
  imports either module.
- The [fixture](../../apps/worker/test/fixtures/shared-analytics-corpus.ts) uses
  real local D1 admission and a legal v1.2 replacement activation. It includes
  equivalent evidence across versions, a duplicate ID in another owner scope,
  session facts on an otherwise empty day, quota windows, two-model usage and
  positive cache adjacency evidence.
- The [benchmark](../../apps/worker/test/analytics-shared-benchmark.spec.ts) and
  [runner](../../apps/worker/scripts/benchmark-shared-analytics.mjs) provide
  repeatable cold, adjacent-date, correction and unchanged-replay measurements.
  Reports contain aggregate counters and output digests, never SQL, bindings,
  source records or identities.

The cache defaults to 466 calendar days, 200,000 occurrences and 32 MiB of
serialized retained state. These are experiment limits, not measured peak heap
or a guarantee that the batch fits in one scheduled invocation. The current
graph reference retains its 950-statement invocation cap. The shared batch has
no durable resume or per-invocation scheduler yet. Its 1,273-statement cold
build exceeds that single-invocation cap and needs resumable chunks before
production integration.

## Workload and correctness

The full fixture has 130 calendar days and 30 historical model dates, with the
required 101-day lookback for every calculation. Its measured primary scope
contains 986 effective occurrences across the three streams; it is a sparse
history, not a large-volume stress test. Cold preparation loads the
complete input range and produces the first model/cache date plus current fits.
The warm phase produces the other 29 distinct model/cache dates. Correction
changes one historical day and recalculates all 30 dates; replay repeats that
completed corrected workload unchanged.

All compared daily values, current selected scalar fits and cache contributions
match exactly. Historical model results match in every analytical field. Only
their separately validated `inputFingerprint` metadata differs: the experiment
uses its own private dependency pin, not a production graph cache identity.
Every model date must be READY, with positive scalar fits, daily/session facts,
cache groups and adjacencies. Empty or uniformly refused results cannot pass.

The full run prepares 130 days cold, then zero on adjacent dates. Correction
prepares one day and reuses 129; its single source page contains one occurrence.
Replay reuses all 130 days. Warm and replay phases read zero raw pages and zero
day dependency vectors; their remaining nine statements are authority checks.

## Measurement boundary

The primary current-path comparison is graph scope capture and computation,
with prepared quota/usage caches enabled and durable checkpoints/results.
Daily and cache reference paths independently call their existing kernels over
effective pages, without publication caches. Their costs are useful correctness
reference costs, not a claim about current warm production publication.

The candidate's acquisition serves all four families, while the primary graph
reference includes only fits and model work. Candidate outputs remain in memory;
the graph reference persists results and checkpoints. This asymmetry is explicit:
the experiment proves reduced repeated acquisition and local analytical parity,
not a complete replacement's cost or a production speed multiplier.

Rows read are D1 execution counters, including repeated/index reads, not unique
events. Database duration comes from each statement's D1 metadata. Batch elapsed
wall time is allocated evenly among its statements for family reporting; those
family allocations are not independent latency measurements. Reference always
runs first, so local wall times include ordering and cache effects. CPU time,
peak heap and individual decode/price call counts are not available. Serialized
retained sizes are reported separately. Checkpoint bytes count submitted INSERT
payloads, including any idempotent retries, not unique durable bytes.
SQL query plans were not captured in this first experiment.

## Reproduction and evidence

From `apps/worker/`:

```sh
npm run analytics:shared:benchmark -- --output /tmp/shared-analytics-small.json
npm run analytics:shared:benchmark -- --full --output /tmp/shared-analytics-full.json
```

Use new output filenames; the runner refuses to replace existing reports. It
checks installed workspace package copies before and after, hashes Worker
source/tests/scripts/configuration/migrations, and refuses to save if inputs
change during the run. The base checkout is
`d4c1f19228da8da3fec2e638052184f961b66795`, with existing optimization changes
and this experiment in the working tree. The base commit alone does not identify
the measured source. Node.js is `v26.2.0`.

The final [full report](./2026-09-28-shared-analytics-benchmark-full.json) was
recorded at **16:09:57 UTC on September 28, 2026**; the
[small report](./2026-09-28-shared-analytics-benchmark-small.json) was recorded
at 16:08:25 UTC. Both cover the same 636-file Worker input fingerprint:
`d0051439ff52b5ef8db8973b0b9b46e657c789ef2a450cc5f59e4ca02e4c7439`.
The full report's SHA-256 is
`3e35a857c0e698438a70c9c6af700c140c610b62757627a8e743205b01154eee`.
Both reports include verified before/after digest receipts for the installed
accounting, telemetry-contract and quota-analysis package copies. All measured
statements have complete metadata; all profiles have zero measurement failures
and zero failed statements.

## Measured resources

This table compares the current graph's **source** queries with the shared
batch's source queries serving all four families. Target persistence work is
listed separately below.

| Phase | Current graph source statements | Shared source statements | Current graph source rows read | Shared source rows read | Days prepared / reused |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold preparation and first date | 2,301 | 1,273 | 917,750 | 857,421 | 130 / 0 |
| Next 29 dates | 3,942 | 9 | 6,460,210 | 36 | 0 / 130 |
| One-day correction, all 30 dates | 4,143 | 185 | 9,590,699 | 614,460 | 1 / 129 |
| Unchanged replay, all 30 dates | 465 | 9 | 234,992 | 36 | 0 / 130 |

Across the initial 30 dates, source statements fall from **6,243 to 1,282**
(79.5% fewer), and source rows read from **7,377,960 to 857,457** (88.4% fewer).
The current graph additionally executes 4,724 target statements. Including those,
the comparison is **10,967 to 1,282 statements**, or 88.3% fewer. The graph
reference writes 2,190 target rows and submits 17,438,791 checkpoint payload
bytes; the candidate writes no durable results. Those omitted persistence costs
must be measured when the production adapter exists.

Local D1 statement duration for the initial graph work totals 20,113 ms, versus
2,286 ms for shared acquisition and reductions. Indicative graph operation wall
time totals 23,406 ms, versus 3,206 ms for the shared batch. These timings carry
the ordering and persistence limitations above; they are not a production speed
forecast. The standalone cold comparison is slightly slower: 2,918 ms for graph
work versus 3,024 ms for shared all-family preparation and reductions.

The small fixture also exposes preparation cost: its uncached all-family
reference versus shared wall times are 1,146 versus 1,478 ms cold, and 1,151
versus 1,268 ms after correction. Fewer statements do not guarantee a faster
small cold workload. Repeated dates amortize preparation.

The full candidate retains 1,922,109 serialized bytes after correction, with a
maximum observed serialized working bound of 1,967,787 bytes. All 30 historical
model results are READY; the full corrected comparison includes five current
scalar fits, one session fact, and 51 cache groups containing 566 adjacencies.
These are per-scope analytical contributions, not public community totals.

## Validation

- Complete Worker regression run: **2,251/2,251 tests across 176 files passed**
  in 983.18 seconds. Workspace-copy, endpoint, generated-type, TypeScript and
  operations-script checks also passed.
- Focused input-cache tests: **7/7**; reducer tests: **8/8**; real-admission
  fixture tests: **3/3**; benchmark CLI checks: **2/2**.
- Final small and full benchmark commands: **6/6 tests passed in each**, with
  all four workload phases passing. The full benchmark test took 70.45 seconds.
- Final measurement-helper changes additionally pass TypeScript and are
  exercised by the small/full report runs. Invalid or incomplete metadata
  permanently invalidates a profile, even if a production fallback catches
  the first instrumentation exception. Batch elapsed time is labeled as an
  allocation when broken down by statement family.
- Architecture check passes: **660 production files, 2,745 imports, zero debt
  edges**. An existing type-only import cycle was removed by placing the
  `StorageEffectiveUsagePreparation` interface with the pure usage-day types;
  its runtime behavior did not change.
- Documentation governance passes; final root preflight passes **20/20 tests**
  with the saved reports and this receipt.

`npm run product:worker:check` exited 1 after the passing tests, at the website
asset staging step: `Production deployment requires a clean, committed release
tree`. This checkout contains earlier work and the new experiment. Nothing was
staged, discarded or committed to bypass that protection. The subsequent general
Wrangler dry deployment and staging checks were not reached. This is local
analytical qualification, not deployment readiness.

## Next recommendation

Optimize exact day-dependency acquisition before adding workers or changing
storage. Repeated occurrence-link queries take 1,699 of 2,286 D1 milliseconds
cold, and **1,590 of 1,601 milliseconds after correction**. The corrected
acquisition still executes 130 link queries and examines 585,842 rows to establish
that 129 days are unchanged. Batch or incrementally maintain those dependencies
while preserving each day's links to source variants outside its range. Simply
splitting a whole-window dependency result is unsafe.

Then add bounded durable date-block jobs and their guarded publication adapter,
and measure persistence, interruptions and concurrency on the same outputs. A
source-only reduction does not meet the plan's whole-work promotion gate.

## Remaining qualification

- Dense/skewed histories and many-owner concurrency are unmeasured. The other
  owner verifies scoped deduplication; it is outside the measured cohort.
- Source-fence, empty-day/cross-day invalidation and failure paths have focused
  tests; a real admitted correction moving an occurrence between days is still
  needed. The measured correction enriches one day in place.
- The standalone legacy v1 scalar adapter's open-ended dependency semantics are
  not qualified by this mixed effective-history experiment.
- The fixture's v1.1 domain must cover the current admission date. Its physical
  manifest shape can change on a future day; every paired run uses the same
  admitted inputs for both implementations.
- Production routes, storage schemas, scheduling and publication are unchanged.
  No public or installed-client behavior is claimed from these local tests.
