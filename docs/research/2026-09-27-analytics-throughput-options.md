---
title: Options for tenfold analytics throughput
date: 2026-09-27
type: research
status: production-canary-verified
---

# Options for tenfold analytics throughput

Effective quota-day reuse is implemented and locally qualified. The final
synthetic recovery comparison shows about 10.4 times fewer statements for warm
calculations and 77.3% fewer across three calculations including preparation
and completed-checkpoint cleanup.
Migration 0028 was applied and the first production candidate was tested, then
rolled back after older cleanup code retired its new checkpoint method. The
single-Worker compatibility repair uses the original recognized methods with
an isolated storage dependency digest. The repair is active at 100% as of
2026-09-28 02:52:43 UTC. Its qualification and live recovery are
recorded in the [production receipt](../receipts/2026-09-27-effective-quota-day-production.md).
The synthetic query savings are not a measured production speedup.
The repaired checkpoint survived cleanup and crossed a calculation-phase
boundary. Its first long pass exposed an overlapping-writer inefficiency:
verified advancement by another writer still stops the graph lane as a failure.
A bounded retry classification passed all 2,075 Worker tests and is active as
source `42e649333dcc04050214841089736692ac36d87b`, verified at 03:30:20 UTC.
The subsequent canary covered 14 ordinary runs and one long run: no reported
failures or exceptions, two completed graph results and three handled checkpoint
advances. The long run handled contention and continued to 844 statements before
its budget guard stopped it. Cache coverage remained one effective day, so
complete-window warm throughput is still unmeasured; the rebuild remains active.

The strongest candidate is reusable effective-history input preparation plus
bounded parallel calculation jobs. Read replicas can support that design by
offloading input reads. Increasing the number of copies of the current scheduler
alone is unlikely to produce proportional gains.

The options below are an assessment, not a production throughput claim.
Baseline source was reviewed at `d4c1f192`; its relevant pipeline modules matched the
last recorded analytics deployment source `31a32281`. Production observations
in the baseline assessment come from the September 27 receipts, ending at
23:21 UTC. The linked production receipt separately records the later deployment
and recovery observations. The maintained operational
authority is [Production service operations](../runbooks/production-operations.md).

## Baseline: where the system spends work

This table describes the reviewed baseline, before the experiments below.

| Finding | Evidence and implication |
|---|---|
| Daily publication and the prepared graph-day builder already have separate Workers. | [Publication entrypoint](../../apps/worker/src/storage-publication-worker.ts) and [builder entrypoint](../../apps/worker/src/graph-day-projection-worker.ts). Separating these again would add no new capacity. |
| Delivery, graph calculations and retirement still share the analytics Worker. | [Analytics schedule](../../apps/worker/src/storage-analytics-worker.ts). An ordinary pass has 55 seconds; every tenth minute has an eight-minute window, within a shared 950-statement meter. |
| Effective-history acquisition reads at most 200 occurrences per page and saves after each page. | [Effective reader](../../apps/worker/src/storage-effective-history.ts) and `computeEffective` in the [graph kernel](../../apps/worker/src/storage-community-graph.ts). Each page pays source checks, decoding and durable checkpoint overhead. |
| Quota acquisition revisits the same history in four phases. | [Acquisition kernel](../../apps/worker/src/quota-analysis-v11-reader.ts): plan, clusters, fitability and endpoints reset the cursor. Usage then has its own pass. Adjacent model days have overlapping roughly 100-day windows. |
| The effective-history path does not consume the existing prepared graph days. | Its entrypoint has no prepared-day input; the prepared path is in [v1.1 history](../../apps/worker/src/storage-v11-history.ts). The [builder](../../apps/worker/src/graph-day-projection.ts) supports the older v1.1 layouts. The effective model path already avoids scalar fit reduction, so that optimization is not new work. |
| Historical graph selection concentrates work on the newest unfinished day. | [Graph work selector](../../apps/worker/src/storage-community-graph-work.ts). One expensive remaining owner can limit useful concurrency even when many older days remain. The v1.1 selection lease is conditional and does not cover effective owners; checkpoint head comparison still protects their saves. |
| The reviewed pipeline does not start D1 Sessions. | The only `withSession` occurrence under Worker source is the budget adapter forwarding method. Enabling replication alone would not change these callers' read routing. |

The [repair record](../plans/2026-09-27-analytics-pipeline-stall.md) observed two
effective-history owners among 52 eligible owners, a long graph pass ending on
query budget, and an idle prepared-day builder with 1,995 days already built.
The [later deployment receipt](../receipts/2026-09-27-analytics-query-budget-deployment.md)
records continuing graph and daily progress after the 950 cap, without a measured
speedup. These observations motivate the investigation; they do not establish
the present fraction of time spent reading, writing, computing or waiting.

## Alternatives

| Option | How it could help | Main constraint | Priority |
|---|---|---|---|
| Prepare effective owner/day inputs once and reuse them | Avoid repeated correction reconciliation, decoding and raw scans across phases, metrics and overlapping result days | Must preserve effective-source precedence, corrections, conflicts, ordering, exact pricing and invalidation | First substantial change |
| Amortize page and checkpoint overhead | Process a bounded group of pages before promoting one successor; reuse validated immutable metadata within the group | Deterministic restart, memory limits, final source checks and sufficient save time remain required | First measured experiment |
| Dispatch independent jobs through Queues | Give each owner/day calculation its own invocation budget; continue work as soon as capacity is available | Requires explicit job ownership and bounded concurrency; the database can still saturate | Pair with preparation |
| Add D1 replica reads | Spread stable input reads across additional database instances and reduce pressure on the primary | Sessions integration and consistency fences; writes still go to the primary | Supporting experiment |
| Put immutable prepared inputs or large checkpoint payloads in R2 | Replace many SQL part reads/writes with object transfers, retaining compact D1 manifests | No cross-store transaction; conditional manifest promotion, orphan recovery and erasure coverage need design | If checkpoint storage remains dominant |
| Shard D1 data across independent databases | Increase primary read/write capacity through separate execution queues | Cross-shard aggregation, control state and erasure; an owner-only split leaves a dominant owner on one shard | If the primary is demonstrably saturated |
| Run analytics in a separate batch service | Load a pinned input set once and calculate many result days with parallel tasks and larger working memory | Data synchronization, deployment, operating cost and output qualification | Strategic alternative for sustained heavy rebuilds |

The priorities are engineering judgments, not measured speedup estimates.
Earlier acquisition plans contain historical projections; those figures are
not performance evidence for the effective-history path reviewed here.

## Replica design

D1 replicas can increase read throughput. Cloudflare creates regional replicas
automatically; this is not an operator-selected pool of ten interchangeable
database servers. All writes still reach the primary.
[D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
and [replica locations](https://developers.cloudflare.com/d1/configuration/data-location/).

Readers must use D1 Sessions. A bookmark establishes a minimum database version;
it does not freeze an immutable snapshot or synchronize different databases.
[D1 Sessions API](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession).

The proposed split is replica-eligible reads of pinned input data, with fresh
primary checks for owner eligibility, corrections, deletion/containment and
final publication. Those checks must reject a result invalidated during its
calculation. Blindly routing the existing before/after authority checks to an
unconstrained replica could make both checks observe obsolete authority.

Measure actual routing with `served_by_primary` and `served_by_region`; many
concurrent jobs do not guarantee that reads spread across replicas. Replication
also does not increase the per-invocation D1 allowance. Each database instance
processes queries serially; replicas provide additional independent readers.
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Work that can be split

The natural job identities include source revision and method, not just dates:

- **Prepare effective input:** owner plus source day plus exact dependency
  identity. Different days of one heavy owner can run concurrently. Store exact
  mergeable summaries where proven; retain ordered sufficient evidence where
  cross-day clustering or endpoint spacing prevents a simple daily subtotal.
- **Calculate graph result:** owner plus result day plus metric plus dependency
  identity. Separate current-result priority from historical backfill and admit
  a bounded window of historical days, rather than only the newest unfinished
  cohort. Reuse the prepared inputs across these jobs.
- **Fold daily contribution:** owner plus day plus dependency identity. The
  existing daily cache is already keyed this way, but its selector does not
  distribute jobs. A final publication step waits for the complete valid cohort.
- **Maintain storage:** bounded retirement and orphan cleanup can have their
  own schedule after their ordering with active jobs and erasure is verified.

Keep the ordered delivery cursor coordinated. Give each mutable checkpoint one
active writer, with durable leases, revision checks, idempotent retries and
recovery after a killed invocation. Do not parallelize sequential quota phases
by merging arbitrary partial fits: the kernel has cross-day ordering and
clustering semantics that need an equivalence proof.

Queues can run many instances of one deployed consumer; a separate script per
job is unnecessary. Start experiments at concurrency 1, 2, 4 and 8, stopping
when completed throughput ceases to improve or database latency/errors rise.
Use one bounded expensive job per invocation initially, with a durable job
registry so lost, expired or duplicate queue messages do not lose work.
[Queue concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)
and [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).

```mermaid
flowchart LR
  A[Ordered delivery] --> B[Revisioned job dispatcher]
  B --> C[Parallel effective-day preparation]
  C --> D[Reusable immutable inputs]
  D --> E[Parallel graph result jobs]
  D --> F[Parallel daily owner folds]
  E --> G[Validate complete cohort]
  F --> G
  G --> H[Atomic public publication]
```

This is a proposed arrangement. Graph and daily summaries can share admitted
input acquisition where valid, but their output schemas and reduction semantics
remain distinct. Final publication is coordinated per output day; it need not
serialize every independent day in the system.

R2 offers strong consistency for direct object operations, which is useful for
immutable artifacts, but this does not supply a transaction spanning D1 and R2.
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).
A separate batch service, such as Cloud Run Jobs, supports task parallelism;
it could serve analytics while the public service stays on Cloudflare. It only
helps the database bottleneck if inputs are loaded efficiently or served from
a suitable analytics store. Merely moving the same small remote queries to
another compute platform preserves that work.
[Cloud Run Jobs](https://docs.cloud.google.com/run/docs/create-jobs).
Existing GCP implementation or cutover readiness was not assessed here.

## What would demonstrate tenfold improvement

Use one fixed, representative corpus containing a dominant owner, many small
owners, overlapping historical windows and corrections. Compare end-to-end
time to the same valid published outputs, including initial preparation cost.
Report steady incremental updates separately from a complete rebuild.

Measure source and target query counts, rows read/written, database duration,
binding-call elapsed time, checkpoint bytes, CPU time, queue delay, retries,
unique completed results, publication freshness and total cost. Count actual
durable outputs; extra attempts or checkpoint parts are not throughput.

Run equivalence and restart checks for corrections, cross-day links, duplicate
delivery, source changes, erasure, partial saves and expired leases. A candidate
must preserve exact analytical results and fail-closed refusals. Concurrent
analytics must also preserve upload and public-read service health.

The first experiment should compare effective acquisition with one-page saves
against bounded page groups, then prepared effective-day reuse. Test concurrency
after identifying which database and operation still dominates. This makes each
additional worker useful and gives replicas a measured purpose.

A tenfold target cannot be promised from replica count: if 20% of elapsed work
remains serial and unchanged, unlimited parallelism alone is capped at 5x.
Reducing repeated work can change that bound. Preparation plus parallel jobs
is therefore the recommended route to test; database sharding or a separate
analytics service follows if the measured primary capacity remains insufficient.

## First implementation experiment

The owner delegated implementation direction on September 27. Begin with the
effective-history checkpoint overhead, then use those measurements to prioritize
prepared effective-day inputs. Local qualification consists of:

1. Measure source and analytics statements for the unchanged effective model
   path against synthetic quota and usage history.
2. Group bounded deterministic acquisition pages between durable promotions,
   preserving the existing correction reader and result identities.
3. Compare exact results and query cost; exercise low budgets, deadlines,
   interrupted saves, concurrent promotion and authority changes.
4. Run the focused graph/checkpoint tests and the complete Worker gate. Record
   limitations separately from passing checks.

No production throughput improvement is established by this local experiment.
The following section records the separate effective-day storage increment;
concurrent dispatch remains future work.

### Local result

The candidate groups up to four effective-reader pages per checkpoint and
stops at quota phase boundaries. It keeps every page's source and owner fences,
the 950-statement cap, analytical identities and checkpoint encoding. It does
not add persistent effective-day reuse. The internal `effectiveCheckpointPages`
option accepts only one or four pages, allowing an exact comparison against
the preceding one-page strategy on the same source dependency.

Both strategies ran against the same disposable Miniflare databases and pinned
model result, including cold checkpoint initialization, checkpoint reloads,
source checks and final result publication. The corpus has five source days,
61 or 6,001 legacy quota observations and 120 legacy usage events, with effective
correction processing active. Fixture creation and scope capture are excluded
from the counts. Each compute invocation was capped at 950 statements.

| Corpus | Strategy | Source statements | Analytics statements | Total statements | Invocations |
|---|---|---:|---:|---:|---:|
| 61 quota observations | One page | 357 | 263 | 620 | 1 |
| 61 quota observations | Four pages | 309 | 96 | 405 | 1 |
| 6,001 quota observations | One page | 1,845 | 1,357 | 3,202 | 5 |
| 6,001 quota observations | Four pages | 1,560 | 365 | 1,925 | 3 |

Exact complete analytical results matched in both comparisons. The larger case
uses 39.9% fewer total statements and 73.1% fewer analytics statements, with
five invocations reduced to three. These are synthetic statement counts, not
measured production wall-clock improvements. A mixed v1/v1.1 integration case
also covers both graph metrics; this corpus is not representative proof of
every v1.2 layout, retained correction density or large checkpoint size.

Regression checks cover work-deadline cuts of small and multi-batch checkpoints,
a 250-statement budget, resumption
from the old one-page strategy, partially staged successor parts, a committed
save whose response is lost, failure of a subsequent source page, concurrent
writers, and owner revision/authority changes within a group. Initial failures
in the new fault-injection tests came from counting both candidate and variant
queries as pages; the observer was narrowed to candidate-page reads without
changing the assertions.

Local qualification on the patch based on `d4c1f192`:

- `npm run product:worker:check` passed the package, endpoint, generated-type,
  TypeScript and script checks, then all 160 Vitest files and 2,011 tests.
  The combined command stopped afterward at `production:stage-assets`, which
  requires a clean, committed release tree. The website/staging deployment
  checks therefore remain unqualified; this is not an all-green release gate.
- A separate `wrangler deploy --config wrangler.analytics.example.jsonc
  --dry-run` built the analytics bundle with the unbound example configuration.
  This proves local bundling, not production configuration or activation.
- `npm run docs:check`, `npm run test:preflight` (20 tests) and
  `git diff --check` passed.

At the checkpoint-grouping measurement, `apps/worker/src/storage-community-graph.ts` had
SHA-256 `f51f0cf63dac54ba7c3a02e0ed7fd27c38f2ce636f31a2b681b5f032fcb566d1`.

The next increment selected was effective owner/day preparation. It needs
an exact dependency key covering corrections and cross-day source variants,
with parity against the existing reader for adjacent result days and both
metrics. This experiment establishes a smaller query-saving change independently
of that persistent-cache contract. Nothing from this experiment is deployed.

For the day-reuse experiment, count cold preparation cost as well as warm
calculations of adjacent days. Require exact fits/model parity, reuse across
unrelated later uploads, invalidation for corrections and linked variants on
other days, refusal after owner erasure or authority changes, and invalidation
when a summary's pricing or reduction method changes. Reuse must never turn
missing or conflicting source evidence into a completed answer.

## Effective quota-day reuse: implementation and qualification

The next increment prepares quota inputs during the existing first source scan,
then reuses complete days for both metrics and overlapping result windows.
Usage continues through the existing effective reader. This preserves scalar
fits and the streamed usage refusal boundaries while measuring quota reuse
independently.

- Add an explicit effective layout to the existing immutable prepared-day
  store. Keys use the correction-aware day dependency, including linked source
  variants and sessions, rather than the owner-wide revision.
- Retain bounded, content-free quota preparation inputs in the existing
  checkpoint while a day spans multiple pages. Oversized preparation falls
  back to the maintained paged calculation.
- Count all admitted quota rows before filtering, and rebase cached endpoint
  IDs across the selected days. Require complete coverage and conservatively
  fall back at the existing reset-cluster bound.
- Verify migration preservation and pre-migration fallback, interrupted/retried
  preparation, fits/model parity, correction and authority invalidation,
  erasure, and cold/warm actual statement counts.

This increment requires a forward analytics migration before activation.
Local source qualification, migration rehearsal, and production deployment
remain separate gates.

The implementation uses the existing `GRAPH_DAY_PROJECTION_FOLD` switch and
checks the migration capability before staging any effective day. Its new
checkpoint namespace can adopt paged work; disabling the switch preserves the
old reader namespace. Per-day preparation retains at most 12,800 rows or 4 MiB.
The whole-window loader rejects encoded payload above 8 MiB and raw reset
fragments above 4,096 before reading source dependencies. It batches manifest
reads, verifies all source dependencies before decoding any cached payload,
and reserves enough queries for a cache miss to advance the pager.

Review identified two additional lifecycle requirements, now implemented:

- A late cache miss selects deterministic one-page checkpoint groups. A
  successor larger than 30 parts can then stage and resume instead of repeatedly
  discarding the same partial four-page group.
- Effective prepared inputs age out at the oldest reachable graph input day,
  derived from the existing 70-day result horizon and 100-day model lookback.
  The 170 inclusive input days preserve every scheduled window without retaining
  obsolete derived days indefinitely. Source and daily data are untouched.

The 101-day resource regression uses actual D1 statement metering. A warm load
uses 711 statements with 239 remaining. Replacing only the final day causes a
miss after 609 statements, leaving 341 and decoding no cached payload. Keeping
both the old and rebuilt final-day heads still loads the exact new dependency
in 711 statements. Oversized memory or reset-fragment metadata selects the
paged path before any source dependency or cached payload decoding.

Initial dense-fixture measurements before the compatibility recovery (6,001 quota observations over five days,
120 usage events, 950-statement cap) show exact fits/model parity. Counts include
source validation, checkpoint reads/writes, preparation and result publication:

| Calculation | Paged, grouped checkpoints | Effective quota-day reuse | Source / analytics statements | Compute invocations |
| --- | ---: | ---: | ---: | ---: |
| First model calculation, including preparation | 1,925 | 935 | 698 / 237 | 3 → 2 |
| Fits over the same inputs | 1,926 | 179 | 142 / 37 | 3 → 1 |
| Model for the adjacent result day | 1,925 | 178 | 142 / 36 | 3 → 1 |

Both warm calculations read zero quota source pages; each paged baseline reads
124 and the cold prepared calculation reads 44. Warm calculations use about
10.8 times fewer statements, and cold preparation uses 51.4% fewer. Across all
three calculations, including preparation, the count falls from 5,776 to 1,292
(77.6% fewer). The existing 950-statement invocation cap is unchanged.

These are synthetic statement counts, not production speed or completion
estimates. The whole workflow still includes daily publication, usage reduction
and scheduling. The corpus establishes exact output parity and removal of
repeated quota scans; a production sample must establish elapsed throughput.

### Initial source qualification

Qualification completed on September 27 local time (September 28 UTC), on the
patch based on `d4c1f192`:

- The complete Worker command passed workspace-package, endpoint,
  generated-type, TypeScript and script checks. Its full Vitest run exercised
  162 files and 2,055 tests: 2,054 passed and one exact checkpoint-registry
  expectation still listed only the old formats. The expectation was updated
  to include the two new effective quota-day formats, retaining exact equality;
  all 11 tests in that file then passed. No runtime change followed the full
  suite, and the suite was not repeated after this assertion-only correction.
- The final dense-fixture benchmark passed independently with the counters
  recorded above. The 101-day budget tests, correction/authority invalidation,
  old-checkpoint adoption, large checkpoint saves, erasure and migration
  preservation also passed in the full run.
- Architecture boundaries, documentation governance, preflight (20 tests),
  TypeScript and diff checks passed. The analytics example dry build passed.
- The separate generic website `deploy:dry` command stopped at its required
  clean, committed release-tree check. Website/staging asset deployment gates
  remain unqualified; the combined Worker command is not reported all-green.

A separate analytics candidate was prepared on the last recorded deployment
source `31a32281c1224b63de45b55b14e44b66357ce321`, saved as local commit
`10ce797d317c0aea7787331daa8dee4accb75306` on
`codex/analytics-pipeline-repair`. At this initial qualification checkpoint it
had not been pushed or activated; the later online test and rollback are
recorded in the linked production receipt.
Its eight changed/new runtime
modules and migration are byte-identical to the qualified source. Unrelated
website/client changes and the newer admin-metrics publication implementation
were not copied. TypeScript, the exact local schema-generation assertion and
all 19 migration/store tests passed on this baseline, including the upgrade
without analytics migration 0027. Its analytics-only dry build used the
disabled, unbound example configuration; live bindings are not qualified by it.

Artifact identities:

- Analytics migration 0028 SHA-256:
  `7b83ecee7ad08506c636598b3e6ddb11894066dcc706474f8013bb8ea65a5b90`.
- Runtime/migration patch against the deployed baseline SHA-256:
  `8089e33e2804c5f40c772371e1a481c8a1f920b09d74008fa550c184017bca91`.
- Analytics JavaScript from that baseline plus the patch SHA-256:
  `6645fb2d85bac7ba3be6dc74bea2697c8a31518dc1d114df16185cd00634303a`.

The initial production plan was to recheck the active version, bindings, fold switch
and analytics schema, apply only migration 0028, then deploy the analytics
candidate. It keeps the 950 cap and delivery catch-up disabled. Migration and
activation require explicit production authorization. Observe natural scheduled
runs for completed results, publication freshness, source-page counts and
errors before assigning a live speedup. This local qualification does not
establish current production backlog counts or completion time. The initial
online test found a cross-Worker cleanup compatibility gap; the linked receipt
records its rollback and the recovery qualification separately. The final
recovery source is `93dcecea800ba630b4261f91ce5f1acaef7db300`; all 163 Worker
Vitest files and all 2,062 tests passed. The generic website dry-deployment
gate remained blocked by its clean-release-tree requirement. The separate
analytics candidate's production-config dry build and actual activation passed.
The recovery benchmark includes completed-checkpoint cleanup: 941 statements
for the cold model, 185 for warm fits, and 184 for the warm adjacent model.

## Next bounded experiments after recovery

The owner requested this follow-up after the completed canary. Implementation,
acceptance checks and new measurements are tracked in
[Effective cache throughput follow-up](../plans/2026-09-27-effective-cache-throughput.md).
The experiments below were the recommendation at the recovery checkpoint;
their implementation does not change the recorded production version above.

### Warm the work already in progress

The 03:19 UTC production sample had one effective prepared day. The busy
September 27 model job had been adopted after its plan phase, while another
adopted plan job began midway through a day. Complete cache coverage was still
missing. Those misses return before the repeated day-dependency queries, so
batching those queries cannot yet accelerate this workload.

First test optional quota-day preparation during later acquisition phases.
Those phases read the same unfiltered effective quota pages and rewind to the
first day. Start preparation only at a verified day boundary and publish it
only after authoritative end-of-day coverage. This could fill the days skipped
by adoption without starting an independent source scan. Keep preparation
bounded, avoid rewriting already-valid prepared days, and measure cold-query
and checkpoint costs as well as exact output parity.

This needs more than removing a phase condition: the checkpoint codec currently
permits pending preparation only in the plan phase. Qualify a new isolated
storage-format domain, retaining the recognized method names, and test adoption,
rollback, phase transitions, interrupted saves, corrections and erasure. It is
not part of the deployed quota-day or contention changes. A separate builder
would add source traversal, scheduling and authority coordination; evaluate it
only if preparation alongside existing reads cannot warm coverage efficiently.

### Batch validation after complete coverage is available

Batch the range-capable dependency header reads across requested days, while
keeping each day's cross-day occurrence-link query exact. The current loader
repeats six statements for every day. Five query families can potentially be
shared across a range and partitioned by their existing day fields, leaving
five shared statements plus one occurrence-link query per day.

For the already measured 101-day load, that suggests 711 statements could fall
to about 211 before implementation overhead. The corresponding admission
threshold would fall from 829 to about 329 remaining statements. These are
arithmetic projections, not measured results; the production recovery does
not include this optimization.

Require byte-identical canonical per-day dependencies and hashes, including
sessions, corrections, retained authorizations and links between two days
inside the requested window. Never derive those per-day links by splitting a
whole-window link set: that would omit internal cross-day conflicts. Bound
aggregate rows and bytes, preserve owner fences, and retain the existing pager
fallback plus checkpoint reserves. Re-run the late-day miss, retained-head,
oversized-window, erasure and complete-result benchmarks before considering
another production change.
