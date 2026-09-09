---
title: Hosted refresh performance investigation
date: 2026-09-07
type: research
status: complete
source_commit: a4b6cbb4a236654ccc3f1c06c674481936057a2e
---

# Outcome and claim boundary

The refresh system is replay-safe and resumable, but **not sufficiently
incremental or continuously available**. The main defects are ordinary
corrections deleting the published graph, participant-wide revisions restarting
unaffected historical work, and repeated acquisition/pricing of overlapping
windows. Increasing parallelism or replacing the numerical solver is not the
best first response.

This is a completed investigation and a proposed implementation sequence,
**not an implemented fix or deployment receipt**. Production remained on
`a4b6cbb4a236654ccc3f1c06c674481936057a2e`, Worker version
`700aec28-e2a3-4aff-9e25-24c20b076d78`. Checkout `1b44f9ea` adds only the
[preceding deployment receipt](../receipts/2026-09-07-historical-model-progress.md).
The recommendations below do not supersede the
[production runbook](../runbooks/production-operations.md).

Scope: hosted ingestion, source selection, acquisition/checkpoints, pricing,
model-history reconstruction, scheduling, publication and public/admin reads.
No desktop rebuild, production write, migration, forced maintenance, real-account
experiment or live load test was performed. Production observations were bounded
metadata reads and observation of naturally scheduled work. Local probes used
synthetic content-free fixtures.

## Live incident, recovery and recurrence

All times below are UTC on 2026-09-07.

- At **23:21:32**, the stored allowance preview was physically absent. The public
  response reported `updating`. The mutation epoch was 2738 and the hard graph
  invalidation floor was 2707. This was not a browser cache merely hiding data.
- A new snapshot was naturally published at **23:21:43**, with source epoch 2738.
- At **23:28:43**, a fresh public API request returned `published` / `ready`:
  aggregate 69 points and plans 207 points, both starting June 30; models 30
  points starting August 31. These are chart-model data checks, not a new rendered
  browser qualification. Recovery does not remove the recurring invalidation bug.
- At **23:36:08**, the final supported public API request again returned
  `updating`, with zero chart points for all three allowance views. Availability
  regressed within eight minutes of the preceding successful check. The database
  was not queried again for this second event, so its precise invalidating
  transaction is not established. This is the latest live observation in this
  report; do not describe the graphs as restored at handoff.
- A bounded sample of the latest 128 v1 chunk journal rows contained 54
  higher-revision chunks, consistent with the normal-correction deletion path
  below. There is no retained reason record that conclusively attributes epoch
  2707 to one particular transaction. The deletion path is established by source;
  attribution of this exact event remains an inference.
- Historical publication is progressing slowly, not entirely motionless:
  August 31 completed at **22:58:21** and entered the preview at **22:58:43**.
  The latest-day model cards need not change when an older date is added.

## Hot Path Assessment

The expensive path is background processing, not chart rendering:

1. An accepted source change updates analytical revisions and publication state.
2. The scheduler checks current accounts, queued daily totals and missing model
   dates, under one maintenance lease and a shared resource budget.
3. Each changed account/date acquires quota evidence in three physical passes,
   saving resumable checkpoints after source pages.
4. Finishing scans and prices usage, builds observations, runs the shared model
   estimator, then stores a compact terminal result.
5. Complete-cohort, source-fenced publication replaces the shared graph snapshot.
   Public requests read published data; they do not run historical fits.

Per-record acquisition/pricing and per-page checkpoint work deserve most
optimization attention. The estimator is small in the measured synthetic cases.

## Critical Performance Issues

### H1 — Ordinary correction is treated as graph withdrawal

The previous preservation migration covers a narrow append case, not routine
revision replacement. The actual correction transaction first updates the old
chunk's `superseded_at`, then inserts the replacement. The UPDATE increments the
mutation epoch without an append marker, raising the hard invalidation floor and
deleting the entire preview. The replacement INSERT also fails the `revision = 1`
preservation condition. Widening only the INSERT exception would not fix this.

Source: [supersession transaction](../../apps/worker/src/telemetry-v1-repository.ts)
at lines 295–303; [update fencing](../../apps/worker/migrations/0043_analytical_input_fencing.sql)
at line 45; [preservation triggers](../../apps/worker/migrations/0049_preserve_published_graph.sql)
at lines 18–28 and 44–57.

| Accepted event | Current behavior | Required distinction |
|---|---|---|
| Exact request/content replay | No analytical mutation | Keep; schedule no new calculation |
| New pure-v1 single-device chunk | Preserve published preview | Rebuild only affected dependencies |
| Consecutive revision correction | Delete entire preview | Mark affected work dirty; preserve authorized publication |
| Another device present that day | Delete entire preview | Re-evaluate elected day; distinguish analytical change from revocation |
| Withdrawal, erasure, prohibited publication | Delete affected published information | Keep immediate hard invalidation |

The second-device condition can also catch session-only contributions that
cannot replace an existing analytical winner. A safe correction implementation
needs an explicit transaction-bound transition covering both supersession and
insertion, validated against the route's existing consent, identity, digest and
consecutive-revision checks. Do not broadly exempt UPDATE/DELETE, lower the hard
floor, or resurrect a previously discarded snapshot of unknown validity.

### H2 — Historical dependency identity includes unrelated revisions

Every active v1 chunk increments a participant-wide analytical revision.
`loadV1SourcePin` hashes that revision even when its chunk vector is bounded to
a closed historical window. Historical result admission independently requires
revision equality. Checkpoint identity mismatch disposes obsolete work and
restarts acquisition. An unrelated later upload can therefore invalidate both
completed reusable results and unfinished progress.

Source: [source pin](../../apps/worker/src/telemetry-v1-source-selection.ts)
at lines 140–178; [result admission](../../apps/worker/src/community-model-history.ts)
at line 61; [restart path](../../apps/worker/src/community-analysis-runner.ts)
at lines 182–192. The published-day invalidation in
[0048](../../apps/worker/migrations/0048_community_model_history.sql) is more
date-specific than the per-account work/result identities.

The synthetic probe used 61 quota observations and 120 priced usage records.
It instrumented actual D1 statements inside acquisition, excluding initial
fixture setup and source-pin discovery. Each tested acquisition completed in
one local invocation:

| Operation | Statements | Plan pages | Fit/endpoint pages | Write statements |
|---|---:|---:|---:|---:|
| First acquisition for August 31 | 18 | 1 | 2 | 7 |
| Reload same completed acquisition head | 10 | 0 | 0 | 0 |
| Acquire adjacent August 30, same fixture evidence | 30 | 1 | 2 | 14 |
| August 30 again after September 7 append | 29 | 1 | 2 | 14 |

After the September 7 append, selected historical winners and acquired evidence
were exactly equal, but the fingerprint and input revision changed. All three
raw acquisition passes ran again. These are measured local statement counts,
not a production latency estimate. Reloading an acquisition head is also not
the cheaper current-account terminal-cache fast path described below.

### H3 — Adjacent dates repeatedly acquire and price the same source

The historical range contains 100 preceding UTC dates plus the target date:
101 inclusive dates. Sixty-nine consecutive historical targets can therefore
request roughly **6,969 source-days**, although their union contains only
**169 source-days**. This is an idealized read-amplification comparison, not a
claimed 41-fold production speedup. Late corrections, sparsity, topology and
already-cached results alter real cost.

Each account/date has plan, fitability and endpoint passes. Physical pages are
limited to 1,024 rows before residual winner/limit filtering. Many duplicate
labels, short-window observations and losing-device rows still cost reads.

At **23:16:58**, the remaining August 30 account was in the plan phase at progress
revision 464, retaining about 80 KB of plan payload. Under the normal full-page
transition this corresponds to approximately **475,136 physical rows already
consumed**; that is an inference from checkpoint semantics, not a live raw-table
count. The model solver had not started. The other 14 accounts had completed
acquisition; their persisted endpoint parts totaled about 11.4 MB. Persisted bytes
are not a measurement of peak Worker memory.

Finishing then rereads and reprices up to one million winning usage records in
5,000-row pages. In the small probe, two finishes without a reusable terminal
result each executed seven statements, including two usage queries, and
produced exactly equal results. The production terminal-result cache normally
avoids this; unnecessary invalidation forfeits that benefit.

Source: [historical window](../../apps/worker/src/model-history-window.ts),
[indexed quota pages](../../apps/worker/src/quota-fit-projection.ts) at line 120,
[acquisition reader](../../apps/worker/src/quota-analysis-v1-reader.ts) at line 560,
and [usage/pricing finisher](../../apps/worker/src/quota-analysis-v1.ts) at lines
836, 1124 and 1701.

### H4 — Temporary read failure can masquerade as authoritative invalidation

This is a separate availability vulnerability, not the explanation for the
physically deleted snapshot observed above.

- The public daily reader catches an optional-preview read failure and retries
  daily activity without the preview. A successful response can then say
  `updating`, which the browser treats as grounds to clear the allowance graph.
- The admin preview uses the same unavailable code for a storage error and a
  confirmed missing/invalidated cache. The frontend clears it.
- Admin growth history expires after two hours, and the browser clears retained
  data on every failed reload. A successful overview refresh also resets history
  before loading its replacement.
- The admin request helper has no deadline. A hung overview can hold the loading
  flag and prevent subsequent refreshes and auxiliary graph requests.
- Exact model-catalog/label matching can reject an otherwise analytically valid
  publication after a display-only catalog deployment.

Source: [public read fallback](../../apps/worker/src/community-daily-aggregates.ts)
at line 798; [admin preview](../../apps/worker/src/admin-community-allowance.ts)
at lines 215 and 846; [growth expiry](../../apps/worker/src/admin-metrics-history.ts)
at line 623; [admin loaders](../../apps/web/public/admin.js) at lines 630, 1132,
2987 and 3130. Some existing tests intentionally enforce clearing on the old
unavailable contract: implementation must deliberately change that contract,
not merely weaken assertions.

## Optimization Opportunities

### M1 — Idle detection still does unnecessary background work

The daily rebuild path acquires the complete current fit cohort before checking
its queue. Normal passes also compare the published horizon and scan spend
metadata across the displayed year. Current-cache warming walks the participant
census, and preview/daily publication can independently read the same cohort.
An unchanged preview rebuilds after 55 minutes even without a relevant source
change. A malformed newly stored historical date can repeatedly cause fruitless
refresh attempts.

Use transactional, coalescing dirty work keyed by affected participant/day and
target dependency version. Check that queue before reading fit blobs or source
vectors. Retain a slower, bounded reconciliation sweep as a correctness backstop.
Calendar rollover, missing results and applicable pricing/method changes remain
legitimate triggers; a replay or unrelated metadata change should not be one.

Source: [daily rebuild ordering](../../apps/worker/src/community-daily-aggregates.ts)
at lines 574–625 and [preview refresh](../../apps/worker/src/admin-community-allowance.ts).
The broad v1.1 activation and legacy-authority paths also need range-aware work;
this investigation does not justify treating cutover as an ordinary v1 append.

### M2 — Per-page state reconstruction and durable writes amplify small reads

Each physical page rebuilds maps/plan attribution state, validates components,
and serializes/frames/hashes retained checkpoint data. Delta storage avoids
rewriting every unchanged part, but does not avoid traversing and hashing them.
A one-part change normally adds part insertion, obsolete-part deletion and head
update to the source read.

Invocation-scoped acquisition state and immutable verified checkpoint frames
can remove repeated allocation/hashing. Larger logical page batches may reduce
round trips, but require explicit checkpoint replay-version compatibility.
The previously deferred future-tail reader is **not deployed** and would not
address this incident's plan-phase bottleneck.

### M3 — Finishing is not resumable and admission does not bound its duration

The 407-query finish reservation is a worst-case admission allowance, not 407
queries executed by every fit. Usage/pricing/fit completion is not checkpointed
like quota acquisition; an interrupted finish repeats work. An already-admitted
finish can also continue beyond the optional admission deadline.

One naturally observed pass at **23:19:23** consumed 853 total statements and
40.086 seconds by the end of current reconstruction; the subsequent history
phase received no queries because its deadline had passed. This single sample
does not prove failure of the three-minute priority rotation. It does show why
adding attempts or increasing caps cannot eliminate repeated work.

## Allocation Patterns and Memory Safety

No memory leak was established. Source pages, persisted frames, result sizes and
queries are bounded, but bounds do not imply low memory amplification. Retained
arrays, reconstructed maps, canonical JSON strings, encoded byte buffers and
hashing can coexist during page commits. The 11.4 MB persisted endpoint total
above must not be described as a measured heap allocation.

No production heap or Workerd CPU profile was collected. Before a new data path
ships, profile peak memory and allocation on dense synthetic accounts, including
at least 500,000 quota rows and the existing one-million-usage-row bound. Keep
unknown pricing, poison/overflow state and refusal results explicit.

### Local CPU measurements: preserve the existing estimator first

Node.js 26.2.0 synthetic measurements, excluding D1 and network latency:

| Operation | Median elapsed time |
|---|---:|
| Full model fit plus chronological split halves, 1,212 bins / 2 input models | 1.89 ms |
| Same / 8 input models | 6.45 ms |
| Same / 24 input models | 38.74 ms |
| Same / 33 input models | 51.26 ms |
| Existing server pricing adapter, 10,000 records | 182 ms |
| Existing server pricing adapter, 100,000 records | 1,784 ms |

Solver timings use five warmed runs; pricing timings use three. These fixtures
are not production-equivalent throughput measurements, but support prioritizing
source reuse and pricing reuse over replacing the millisecond-scale estimator.

The solver probe calls the installed public `calibrateCompositionCapacities`
entrypoint. It constructs 1,212 consecutive two-hour bins from May 1 with a
seed-739391 linear-congruential generator (multiplier 1664525, increment
1013904223, unsigned 32-bit state). Per-model costs are 0.01–1.00; percentage
delta is the sum of `cost * 100 / (1000 + modelIndex * 173)`. Input model counts
are 2, 8, 24 and 33; unchanged share selection determines fitted columns.

The pricing probe bundles `priceChunkUsageRecord` in memory using the installed
esbuild, Node ESM and `mainFields: ["module", "main"]`. After 1,000 warmups it
repeatedly parses/prices a synthetic August 1 Codex GPT-5.6 Sol subscription,
priority/fast record with 1,000 uncached input, 9,000 cached input, 1,000 text
output and zero cache-write/reasoning tokens. Both measured sizes return fully
priced results. The initial UMD-resolution attempt failed before measurement;
bundling is excluded from the reported timings.

## Strengths to preserve

- Exact-envelope and same-identity/content replay return before v1 insertion.
  v1.1 also avoids identical domain replay and unchanged day-vector activation.
- The unchanged pure-v1 current-account terminal-cache path uses one indexed
  probe per account. Its existing test expects five unchanged accounts to take
  six statements; changing one rebuilds only that account. This is effective
  **account-level** reuse, not incremental work within a changed account.
- One owned maintenance lease, one actual 900-query meter, a 40-second optional
  admission deadline and reserved finalization budget prevent unbounded fan-out.
  Required lifecycle work runs before optional graphs. Priority rotates among
  preview, current calculation and history every three minutes.
- Acquisition is restartable, source-fenced and journaled. Publication checks
  complete cohorts, current source/authority and the active lease; retries cannot
  double-apply results. Same-date final historical revalidation fixes a previous
  publication delay without relaxing completeness.
- Public refresh is single-flight, timed out, visibility-aware and backoff-bounded.
  Public graph reads do not synchronously acquire raw evidence or fit models.

Source: [replay checks](../../apps/worker/src/index.ts) at lines 2295–2353,
[unchanged domain](../../apps/worker/src/telemetry-v11-domain.ts) at lines 232–260,
[current-cache regression](../../apps/worker/test/community-analysis-warmer.spec.ts)
at line 161, and [scheduler](../../apps/worker/src/index.ts) at lines 4000–4098.

## Recommended implementation sequence

### 1. Make published availability independent of rebuilding

Keep a validated, authorized published generation while relevant new work is
dirty or building. Replace it atomically only when the successor is complete.
No new “last good” label is required; preserve its actual observation dates.

Represent publication validity separately from calculation freshness. A graph
can be ready, dirty and building simultaneously. Distinguish confirmed hard
invalidation from a temporary storage-read failure. Give admin overview, growth
and allowance reads independent bounded, single-flight lanes.

Privacy withdrawal, erasure, ownership/consent revocation and prohibited
publication still invalidate affected generations immediately. An empty initial
dataset or corrupt/unverifiable publication cannot honestly promise a number.
“Always have an answer” means ordinary work/failure must not erase authorized
answers already computed; it cannot mean retaining revoked data or inventing it.

Implement correction preservation explicitly inside the validated supersession
transaction, not by bypassing generic mutation triggers. Preserve exact
dependency/authority checks at promotion. D1 batches provide transactional
rollback for failed sequences. [D1 batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

### 2. Separate dependency identity from concurrency fences

Keep monotonic participant/global revisions as write, deletion and publication
guards. Give each historical window its own exact dependency fingerprint:
selected source vector/election, authority, time bounds and calculation method.

As a first smaller change, when the participant revision changes, recompute that
bounded dependency fingerprint once. If it is unchanged, atomically rebind the
terminal result/checkpoint to the new guard without reacquiring evidence.
Removing the revision from one hash alone is insufficient: census joins,
checkpoint source guards and checkpoint identity hashes also enforce it.
Rebinding must reject changed dependencies, authority, method/window, erasure
and any raced revision/lease transition.

Then use per-day dependency versions and a coalescing change journal to avoid
repeated vector scans. Scope queued targets to actual affected date windows;
keep a bounded periodic reconciliation sweep for lost-work detection.

### 3. Prepare exact source days once and reuse them across windows

Start with server-priced usage summaries keyed by participant, elected source
day and pricing method. Persist all relevant two-hour UTC bins, including
provider/model integer nanodollars, valid/unpriced/dropped counts, poison and
overflow state, and necessary occurrence ordering. Do not retain only bins that
match today's quota observations: a later quota contribution can make another
bin usable.

Follow with lossless quota/plan summaries that preserve equal-time conflicts,
unknown labels, run boundaries, reset relationships and ordering. For each
target day, combine its needed summaries and rebuild the window-specific quota
topology, then run the unchanged estimator. For initial backfill, prepare the
union of source days once rather than rescanning every overlapping window.

Do not initially cache fitted capacities, average cohort medians, or substitute
normal-equation sufficient statistics. Transitive reset clustering, plan-era
conflicts, rolling-window boundaries, 3% model selection, alternating split-half
assignment and floating-point accumulation order can change acceptance. Exact
ordered evidence reuse is safer and targets the larger measured costs.

Any changed physical pagination/checkpoint protocol needs versioned readers
before new writers. An existing staged step must regenerate the same physical
page; equivalent eventual results are not sufficient. Rollback readers must
understand both policies until in-flight work has drained.

### 4. Optimize scheduling after unnecessary work is removed

Prefer cheap dirty detection, bounded batches, shared immutable inputs and
prompt publication of completed generations. Keep interactive reads outside
the calculation queue. Do not launch multiple full-history scans against the
same database as the first speedup: each D1 database processes queries serially;
extra concurrent load can queue and overload it. [D1 limits and concurrency](https://developers.cloudflare.com/d1/platform/limits/)

After measuring the new input-reuse path, bounded independent CPU work or
partitioned preparation may help. It must retain one coherent query budget,
backpressure and fenced writes. Sharding or new queue infrastructure is a later
decision requiring evidence, not a prerequisite for graph recovery.

### 5. Expose useful progress in admin

Show requested dependency version, prepared version and published generation
separately. Include last successful publication, the reason work was triggered,
historical target date, resolved/required accounts, current phase, pages/rows
processed, reused versus rebuilt partitions, restart reason, queries/bytes,
lease age and last progress time. Public data needs no private identifiers.

Calculate an ETA only from measured remaining work and recent throughput, with
uncertainty. A flat headline is not evidence of no historical progress; a
completed work head is not proof that its generation has been published.

## Acceptance gates

These are proposed gates, not claims that the current implementation passes:

1. **Continuity:** ordinary append, real supersession, queued work, age and
   display-only catalog updates preserve identical authorized published bytes
   until atomic replacement. Test both supersession phases and rollback.
2. **Hard invalidation:** withdrawal/erasure/policy invalidation wins against
   concurrent correction, rebind and late publication; no stale generation is
   resurrected. Temporary read errors remain distinguishable.
3. **No-op refresh:** zero raw telemetry reads, pricing calls, solver calls and
   graph publications in an unchanged calculation pass. Dirty detection has a
   fixed metadata bound independent of historical volume; required lifecycle
   maintenance is measured separately.
4. **Unrelated change:** out-of-window append preserves completed results and
   unfinished checkpoint progress. Duplicate ingestion produces no new dirty
   work. One changed day invalidates only its true dependency range.
5. **Exactness:** equal acquisition, accepted/refused fits, counts, integer costs
   and rounded public results across historical dates. Include page ties,
   selected-device changes, late correction, reset-cluster bridging, unknown
   pricing, poisoned bins, overflow and inclusive date boundaries.
6. **Recovery:** crash/retry coverage for old/new writing, verification, promotion
   and cleanup states. A superseded job cannot overwrite a newer publication.
   Interrupting finish must not force repeat pricing of unchanged prepared days.
7. **Resource evidence:** Workerd dense-fixture measurements for rows, SQL time,
   round trips, writes, CPU, peak memory and total backfill completion. No claimed
   speedup or ETA until measured; preserve existing query and resource limits.
8. **Serving proof:** public and authenticated admin rendering remain populated
   during normal refresh and temporary read failures, then show the exact new
   generation. Hung overview requests cannot block independent graphs.
9. **Deployment separation:** test source, rehearsed migrations, protocol upgrade,
   production deployment and rendered live behavior remain separate gates. This
   investigation alone authorizes none of those outcomes.

## Validation and remaining limits

- Primary local run: **93 existing Worker tests plus one synthetic investigation
  probe passed** across current-cache warming, preservation and scheduled
  recovery. The annotated probe rerun passed and provided the statement counts.
- Independent read-only reviews ran **105 Worker tests**, **48 acquisition/finish
  tests**, and **51 browser-contract tests**, all passing. These sets overlap;
  their counts must not be added into a unique-suite total.
- Documentation governance, whitespace/root hygiene and the **20 preflight
  tests passed**. The temporary measurement probe was removed from the product
  test tree and retained outside the checkout for reproduction. The only
  repository change from this investigation is this research record.
- Existing green tests prove current contracts, including some unwanted blanking
  behavior. They are not proof of the proposed replacement design.
- Initial local runtime binding failed under restricted loopback permissions;
  the permitted local rerun passed. A diagnostic request with an extra unsupported
  query parameter returned 400; the supported date-only public request returned
  ready. Neither is evidence of a new production defect.
- There was no rendered browser requalification, live heap profile, full dense
  Workerd benchmark, production load test or unique attribution of the hard
  invalidation transaction in this investigation.

Repeat the retained Worker suites from `apps/worker` (the synthetic instrumented
probe is separate from these existing regressions):

```sh
npm exec -- vitest run test/community-analysis-warmer.spec.ts test/community-daily-endpoint.spec.ts test/graph-preservation.spec.ts test/community-graph-cache-recovery.spec.ts test/admin-metrics-history.spec.ts test/scheduled-analysis-recovery.spec.ts test/quota-analysis-v1-reader.spec.ts test/quota-analysis-v1-shared-finish.spec.ts test/model-history-acquisition.spec.ts test/community-analysis-runner.spec.ts
```

Repeat browser contracts from the repository root:

```sh
node --test apps/web/test/community-refresh.test.mjs apps/web/test/admin-site.test.mjs apps/web/test/admin-growth.test.mjs apps/web/test/public-allowance-views.test.mjs
```

## Summary

Severity counts for the grouped findings above: **Critical 0, High 4, Medium 3,
Low 0**. High severity here denotes recurring graph loss or substantial avoidable
reconstruction, not evidence of data corruption or a security incident.

The first release should preserve authorized publications and stop unrelated
historical restarts. The next should reuse exact daily source summaries. Retain
the shared estimator and existing safety fences; measure before adding parallel
database work. The performance/Workers review guidance informed this ordering:
remove repeated hot-path I/O and allocation while preserving bounded recovery
and exact results.
