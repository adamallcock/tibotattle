---
title: Graph acquisition throughput
date: 2026-09-17
type: plan
status: proposal
---

## Status and claim boundary

Proposal, not implemented; no product code changed. Source claims are from the
checkout at `claude/analytics-last-good-recovery-20260916`; volume claims are
counts and aggregates from read-only `SELECT` against production ingestion and
analytics D1 on 2026-09-17. Claims marked *measured* are D1 statement timings
observed today; the end-to-end hour figures are derived arithmetic, not a rehearsed
backfill. Nothing here authorizes a deploy, a migration or a version bump.

## Measured baseline (production, 2026-09-17)

100-day window (`observed_day >= 20612`), `typed_telemetry_records`:

| | quota rows | usage rows | owners | owner-days with quota |
|---|---|---|---|---|
| format 11 (v1.1) | 1,254,226 | 1,020,831 | 5 | 213 |
| format 10 (v1) | 1,820,873 | 1,647,664 | 16 | 762 |

Top three owners by window rows: 2,221,354 (v1.1; 1,221,945 quota + 999,398 usage,
active 101 days), 1,516,604 (v1), 642,636 (v1). **One v1.1 owner holds 97% of all
v1.1 quota rows.** Distinct `(owner, day, dimensions, slot, raw resets_at_ms,
used_percent)` tuples: 119,615 (v1.1), 242,765 (v1) — 10.5x / 7.5x below raw rows
before any clustering or spacing.

Graph corpus: `analytics_community_graph_results` holds 13 days (2026-09-05..09-17),
246 owner-day results; 9 model publications; in-flight `analytics_history_checkpoint_*`
holds 173 heads, 37 stages, 748 parts, 82 MB. Target is
`ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS` = 70, so 56 days remain.

*Measured D1 throughput:* `MIN/MAX/COUNT` over 2,566,133 rows took 19.6 s; a
two-table join aggregate reading 11,893,880 rows took 12.5–24.6 s. Roughly
0.5–1.0 M row-reads/s, and a statement can run at least 24 s.

## Why the graph is slow

`advanceV11QuotaAcquisition` (`apps/worker/src/quota-analysis-v11-reader.ts:615`)
resets its cursor at each sub-phase boundary (`:802`, `:808`, `:815`), so `plan`,
`clusters`, `fitability` and `endpoints` each walk the owner's whole window: for the
top owner `ceil(1,221,945/4096)` = 299 pages x 4 = **1,196 statements per model-day**,
plus 201 usage pages (`advanceV11UsageReduction`, one statement per 5,000-row page,
all aggregation in JS). `modelHistoryWindow(day)` is the 100 days ending at `day`
(`model-history-window.ts:17`), so 69 model-days re-read almost the same rows. The v1
path mirrors this in `quota-analysis-v1-reader.ts`.

Checkpointing dominates. A claim takes 32 pages
(`STORAGE_GRAPH_V11_CHECKPOINT_PAGES_PER_CLAIM`), then promotes a successor costing
up to 37 + 7 x 32 = 261 statements (`storage-community-graph.ts:76`, `:83`). The top
owner needs ~40 claims per model-day, so ~10,000 checkpoint statements against 1,196
page reads. At ~900 statements/invocation, one invocation/minute and a ~400 ms
clamped round trip, the lane sustains ~10,000 statements/hour; 56 days x ~25,000
= **~140 hours**, consistent with the observed ~148 h projection.

The daily series avoids this because its reusable prepared-day layer
(`analytics_v11_reusable_values`, `analytics_v11_value_pages`) has a `value_key` that
deliberately excludes `generation_id`, `event_digest` and `input_revision`
(`v11-daily-projection.ts:129`), so an unchanged day manifest is folded once.
`analytics_community_graph_results` is a per-owner *result* cache, not a reusable
input.

---

## Phase A — prepared per-day graph projection

### The artifact, and why it is sufficient

Per `(owner, UTC day)` store a content-free aggregate with four components:

1. **Plan anchors** — the day's `V11PlanAnchor` run boundaries exactly as the `plan`
   sub-phase emits them, equal-time ties included. Run endpoints, not rows.
2. **Reset hulls** — per day-local plan signature, single-linkage hulls of
   `resets_at_ms` at `poolToleranceMs` (3 h), as `QuotaResetClusterEntry`.
3. **Fit fragments** — per `(day-local plan signature, raw resets_at_ms)`: `minimum`,
   `maximum`, and the *numerically smallest* up to
   `QUOTA_CALIBRATION_POLICY.minimumBoundaries` distinct `used_percent` values.
4. **Run endpoints** — per `(day-local plan signature, slot, raw resets_at_ms)`, rows
   surviving equal-value run collapse, each with `sourceRowId`, `observedAtMs`,
   `usedPercent` and what `acquiredRow` needs. **No 10-minute spacing.**

Usage reuses the existing fragment shape (`prepareUsagePage`,
`prepared-v1-day.ts:94`): per 2-hour bin (`MODEL_COMPOSITION_POLICY.grainMs`) per
provider, per-model integer-nanodollar cells with the overflow flag. `grainMs`
divides a UTC day exactly, so no bin straddles a boundary.

### Composability, and where it is not exact

- **Hulls compose exactly.** `addQuotaReset` (`quota-endpoint-collapse.ts:73`) tests
  a new instant against a hull's `[min - tol, max + tol]`, not its members, and
  merges every hull it touches. Single-linkage in one dimension is maximal runs of
  sorted points with gaps <= tol, so merging two days' hull sets to a fixpoint on
  `H2.min - H1.max <= tol` yields the same partition as inserting every point. Needs
  a new interval-vs-interval `mergeQuotaResetHulls`; only point-vs-interval exists.
- **The representative is not day-local.** It is the *final* pool maximum
  (`quotaResetRepresentativeMs`), so the artifact keys by the **raw** reset instant
  and the fold resolves the representative after the 100 hulls merge.
- **Fit fragments compose exactly** if the stored value set is canonical. The only
  consumer is `quotaFragmentEligible` (`values.length >= minimumBoundaries` and
  `maximum - minimum >= minimumDisplayedSpanPp`). If every day stores
  `min(N, its distinct count)` values, either some day saturates at N or every day
  stores its full distinct set and the union is exact. Switching the in-memory array
  from arrival order to the N smallest changes nothing observable.
- **Eras are not day-local, but era boundaries are.** `buildPlanAttributionIndex`
  sets every `lowerBoundMs`/`upperBoundMs` to an observed instant
  (`packages/quota-analysis/src/plan-attribution.js:232-246`), and a boundary occurs
  only where the plan signature changes or an equal-time conflict does. **So the
  smallest sound unit is: per day, per day-local plan signature, with runs split at
  every signature change and equal-time conflict instant** — exactly the rule
  `prepareQuotaPage` already uses (`prepared-v1-day.ts:39`, "can only retain a
  superset of its inputs"). The fold then assigns `eraKey` per endpoint from the
  window-wide index. Nothing is lost.
- **Spacing does not compose and must stay in the fold.** `offer()` is a greedy over
  `keptAtMs`/`keptValues` across the whole window per key. The fold feeds the day
  artifacts, in day order, through the unmodified `collapseQuotaEndpoint` /
  `finishQuotaEndpoints`. Because a day's retained set is a superset of the true run
  endpoints and preserves `(sourceRowId, observedAtMs, usedPercent)` and order,
  re-running the same kernel is byte-identical: an interior row of a constant run is
  exactly what run collapse discards, and component 3 already carries its value.
- **One residual inexactness:** `addQuotaReset`'s `QUOTA_RESET_CLUSTER_LIMIT` (4,096)
  refusal is order-sensitive on *intermediate* hull counts, and folding hulls
  day-by-day coarsens the direct insertion order, so a corpus that transiently
  exceeded 4,096 could refuse differently. Measured raw reset instants are ~20k per
  owner over 100 days, clustering at 3 h to far fewer pools, so this is theoretical —
  but it is the one place the fold is not provably identical, and the oracle must
  include a fixture near the bound.

### Storage and migration

New `apps/worker/analytics-migrations/0019_graph_day_projection.sql`, following the
0004/0013 shape rather than inventing one:

- `analytics_graph_day_values` — the 0004 identity columns (`source_id`,
  `source_layout`, `source_namespace`, `owner_digest`, `device_id`, `manifest_id`,
  `manifest_digest`, `day`) plus `acquisition_version`, with `record_count`,
  `values_digest`, `values_json`; `STRICT, WITHOUT ROWID`, immutable trigger.
- `analytics_graph_day_pages` — 256 KiB `length(CAST(values_json AS BLOB))` CHECK and
  a completeness trigger mirroring `analytics_v11_summary_pages_complete`.
- `analytics_graph_day_references` and `analytics_graph_projection_work` — the 0004
  reference and work shapes verbatim, with the same retained/cascade triggers.

Sizing: 975 quota owner-days plus comparable usage owner-days; the dominant owner
carries ~1,150 endpoint tuples/day, ~170 KB/day at ~150 bytes/tuple. Order 200 MB for
the whole window, dominated by one owner. Well inside D1.

### Build, invalidation, retirement

Build with the existing catchup machinery: ≤200 records per revision, up to
`MAX_PHYSICAL_PAGE_GROUP` = 5 full pages per batch, 3 statements each. Add a third
lane beside `runDailyLane` / `runGraphLane` (`storage-analytics-runtime.ts:360-418`)
with its own admission floor, a carve-out in the `dailyAllowance` arithmetic at
`:361` and a slot in the minute alternation at `:241`. **Starvation guard: it must
never run in a graph-only long pass (`minute % 10 === 0`) and must cap its allowance
so the graph lane keeps its 550-statement floor.**

Invalidation is by digest, not delete: `value_key` covers `manifest_digest`, `day`
and `acquisition_version`, so a changed day manifest or a method bump simply misses
and the orphan is retired. Erasure reuses `storage-erasure.ts:118`
(`phase='retiring'`) and **must add both new payload tables to the `payloadAbsence`
list at `:54-55`**. Retirement reuses `retireV11DailyProjectionPage`'s bounded
page-delete driver.

### Identity consequences

`storageGraphDependencyDigest` (`storage-community-graph.ts:181`) folds
`STORAGE_GRAPH_METHOD` plus, for v1.1,
`V11_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION` =
`V11_PLAN_ATTRIBUTION_ADAPTER_VERSION:V11_QUOTA_ACQUISITION_VERSION`
(`quota-analysis-v11.ts:62`). **If the fold is byte-identical, adopt it with no
version change at all** — the precedent is explicit:
`STORAGE_GRAPH_DIRECT_HISTORY_READER_REVISION` is "deliberately absent from
result/checkpoint identities" (`storage-community-graph.ts:46-49`).

The acquisition *checkpoint* format does change. Bump only
`STORAGE_GRAPH_V11_CHECKPOINT_METHOD` (`-3` -> `-4`) and register it in
`STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS`. Cost: the 748 in-flight parts / 82 MB are
abandoned; the 13 completed days and 9 publications survive. That is the documented
purpose of that separate namespace.

### Files, tests, rollout

Change: `storage-v11-history.ts`, `storage-v1-history.ts` (fold prepared days);
`quota-analysis-v11-reader.ts`, `quota-analysis-v1-reader.ts` (accept a prepared
source in place of a page reader; canonical fit-value subset);
`quota-endpoint-collapse.ts` (`mergeQuotaResetHulls`); new
`graph-day-projection.ts` + `graph-day-projection-values.ts`;
`storage-analytics-runtime.ts` (lane); `storage-erasure.ts` (absence list);
`storage-community-graph.ts` (checkpoint method); the new migration.

Tests: (1) **parity oracle** — over ≥200 randomized dense and jittery fixtures,
`canonicalJson(V11CompletedQuotaAcquisition)` from the paged path must equal the
folded path byte for byte; (2) hull-merge associativity under random day partitions;
(3) refusal parity at `V11_PLAN_ANCHOR_LIMIT`, `maxQuotaRows` and
`QUOTA_RESET_CLUSTER_LIMIT`, including the order-sensitive cluster case; (4) an era
boundary mid-day; (5) an equal-value run spanning midnight; (6) migration
forward-only plus erasure absence.

Rollout: migration; build behind a flag while the current path still serves; run the
oracle against the 13 computed days; then switch the fold on, at the start of a long
pass since `-3` checkpoints are abandoned.

**Estimated speedup.** Build: (1,254,226 + 1,820,873)/4096 ≈ 751 quota pages +
2,668,495/5000 ≈ 534 usage pages + ~3 statements per owner-day ≈ **4,200 statements,
once**. Fold: ~100 summary-page statements per model-day (the top owner's 100 days
are ~17 MB at 256 KiB/page ≈ 70 statements) x 56 days ≈ 5,600. Total ≈ 10,000
statements plus ~1.1 GB of payload read, against ~1.4 M statements today:
**140 h -> 3–8 h, roughly 20x**, with payload read and JS fold CPU unmeasured.

---

## Phase B — push the collapse into SQL

### Shape

Two bounded aggregate passes per owner instead of four page scans:

- **Pass 1 (hulls + fit fragments).** `WITH page AS MATERIALIZED (...)` driven by
  `typed_telemetry_records INDEXED BY typed_telemetry_owner_time` over a keyset
  range, joined to `typed_telemetry_quota` / `_dimensions` / `_attributions`, with
  `SUM(CASE WHEN resets_at_ms - LAG(resets_at_ms) OVER w > 10800000 THEN 1 ELSE 0 END)
  OVER w` assigning cluster ids; returns per cluster `MIN/MAX(resets_at_ms)` and per
  `(signature, raw reset)` `MIN`, `MAX` and a capped `COUNT(DISTINCT used_percent)`.
  The Worker merges hulls across chunks.
- **Pass 2 (run endpoints).** The legacy `QUOTA_DOWNSAMPLE_SQL` predicate
  (`quota-analysis-v1.ts:1148-1166`) — keep a row when `prev_up IS NULL OR next_up IS
  NULL OR used_percent <> prev_up OR used_percent <> next_up` — over the same
  partition.

**Spacing, the representative and the held extremes stay in the Worker.** They depend
on the settled pool and on a greedy over `keptAtMs`/`keptValues` that SQL cannot
express without a recursive CTE; the in-Worker finish is cheap over ~1,150
endpoints/day.

### Chunking and budget

These statements are unindexed at the group keys: `typed_telemetry_quota` has only
its `record_id` PK, and the `typed_v1_quota_reset` partial index covers format 10
only (measured: 0 of 1,254,226 v1.1 quota rows carry `analysis_owner_id`). Every row
costs PK lookups into quota, dimensions and attributions plus the `active` join chain
— 5–8 row-reads per source row. The top owner's 1,221,945 rows -> ~7 M row-reads ->
**~8–14 s per full-window statement** at the measured 0.5–1.0 M reads/s: one
statement inside a 55 s pass with no margin. So chunk by week on the
`(observed_at_ms, source_row_id)` keyset: 15 chunks, ~81 k rows, ~0.5–1 s each.
Checkpoint each chunk as an **aggregate** — merged hulls, merged fit fragments, open
run state — never a raw stream. Per owner per model-day: 15 x 2 = **30 statements
versus 1,196**, with a checkpoint of kilobytes rather than megabytes.

Memory: a chunk returns a few thousand aggregate rows; state is the hull set
(≤4,096), fit fragments (≤`PLAN_ATTRIBUTION_POLICY.maxEras`) and open runs. Budget:
30 x 21 owners = 630 statements — inside the 900 meter but *not* inside 55 s at
~0.75 s each, so B needs the long graph-only pass or finer chunks.

### Parity, and the identity landmine

Same parity oracle as A, plus a differential test running the SQL path and the JS
kernel over identical fixtures covering: equal-value runs crossing chunk boundaries;
a pool whose hull spans two chunks; `used_percent` ties at a chunk edge; the
`not_testable` refusals; and REAL-vs-number equality on `used_percent` — SQLite
`REAL` comparison must match JS `===` and `COUNT(DISTINCT)` over REAL must match
`Set` semantics, a genuine divergence risk.

**The landmine:** `V1_QUOTA_ACQUISITION_VERSION` folds into
`V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION` -> `COMMUNITY_ATTRIBUTION_METHOD_VERSION`
-> both `V1_FIT_CACHE_KEY_SUFFIX` and `COMPOSITION_CACHE_KEY_SUFFIX` ->
`communityAnalysisCacheVersion()` -> **`STORAGE_GRAPH_METHOD`**. Bumping it wipes
every published day for every source — the same failure mode as today's
`STORAGE_GRAPH_METHOD` change, reachable from a v1-only reader edit.
`V11_QUOTA_ACQUISITION_VERSION` by contrast sits only in the per-owner dependency
digest, so a v1.1-only change costs only v1.1 owners. **Separable fix, worth landing before either phase: move
`V1_QUOTA_ACQUISITION_VERSION` out of `COMMUNITY_ATTRIBUTION_METHOD_VERSION` and into
`storageGraphDependencyDigest`'s v1 branch, mirroring v1.1.**

**Estimated speedup.** 30 statements x 21 owners x 56 days = 35,280 statements, but
at ~0.75 s of D1 time each that is ~7.4 h of D1 time; at ~55 usable seconds per
minute the wall clock is **~10–12 h**, i.e. ~12x. B alone is therefore *worse than A
alone* and much harder to prove.

---

## Recommendation

**Build A. Do not build B as a throughput measure.** A is ~20x, reuses an existing
understood layer and needs no result-digest change. B is ~12x, needs a parity proof
over unindexed SQL, and its v1 half sits next to a global digest that wipes the
corpus if touched carelessly.

Sequence: (1) move `V1_QUOTA_ACQUISITION_VERSION` into the per-source dependency
digest; (2) Phase A, bumping only `STORAGE_GRAPH_V11_CHECKPOINT_METHOD`; (3) keep B's
pass-1 aggregate in reserve as the natural *builder* for A's projection — one SQL
pass per day instead of paging a day's rows, where a chunk covers one day and cannot
time out.

Production interaction: the 13 completed days and 9 publications stay valid under A
and must be re-verified by the oracle, not recomputed. The 82 MB of in-flight
checkpoint parts are abandoned by the checkpoint-method bump — unfinished work, not
corpus. Switch at the start of a `minute % 10 === 0` long pass.

## Top risks

1. **A silent non-identical fold.** Mitigation: the byte-for-byte oracle is the gate,
   not a smoke test; ship behind a flag and diff against the 13 existing days first.
   If parity cannot be shown, bump `V11_QUOTA_ACQUISITION_VERSION` (v1.1 owners
   recompute; v1 and v0.2 survive) rather than ship an unproven identity.
2. **Cluster-limit refusal order-sensitivity**, the one known inexactness.
   Mitigation: fold hulls strictly in day order; fixture at the bound; if it cannot
   be made exact, refuse only when the *final* count exceeds the limit.
3. **Erasure regression.** The two new payload tables must join the `payloadAbsence`
   list or erasure completes while graph payload survives — a privacy failure, not a
   performance one. Mitigation: a negative test that erasure refuses to complete with
   a prepared graph day present.

## Not determined; needs measurement

- The v1 reader's page size and sub-phase count — the v1.1 reader was verified;
  `quota-analysis-v1-reader.ts` is assumed to mirror it.
- D1's per-statement ceiling. A 24.6 s statement succeeded today; the limit is
  unknown and B's chunk sizing depends on it.
- The plan SQLite chooses for B's aggregate — no `EXPLAIN` evidence in this tree;
  measure against a copy, never production.
- Post-clustering pool counts per era (raw reset instants were measured, not pools).
- JS fold CPU and payload-read time per model-day: the dominant unmodelled terms in
  A's 3–8 h estimate.
- The 541-page figure for the top owner. The page SQL in this checkout filters
  `r.stream = 2`, giving 299 quota pages for its 1,221,945 quota rows; 541 corresponds
  to its 2,221,354 rows across both streams. Confirm which the deployed reader does.
