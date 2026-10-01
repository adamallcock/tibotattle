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

---

## Addendum: the usage phase

Read-only investigation, 2026-09-17, checkout
`claude/analytics-last-good-recovery-20260916`. Source line numbers for
`graph-day-projection-values.ts` and `storage-v11-history.ts` are from the
working tree while Phase A is being written and will move. Volume claims are
aggregate `SELECT` against production ingestion and analytics D1 today; no owner
digest, participant identifier or payload content was read.

Phase A assumed the usage half could reuse `prepareUsagePage`'s 2-hour
`MODEL_COMPOSITION_POLICY.grainMs` fragments. **The assumption is half true, and
the half that fails is not the half the plan worried about.** Two of the five
v1.1 usage components are already exactly that shape. One of them —
`usageScalarBuckets` — is keyed on a quota grid that production shows is 1:1
with usage instants, so it does not compress at all, at any grain.

### Measured: the usage phase is now the binding cost

100-day window (`observed_day >= 20612`), `typed_telemetry_records`, `stream=1`:

| | usage rows | owner-days | usage pages at 5,000, paged per day | heaviest owner |
|---|---|---|---|---|
| format 11 (v1.1) | 1,020,831 | 213 | 366 | 254 pages / 999,398 rows / 101 days |
| format 10 (v1) | 1,647,664 | 762 | 919 | 186 pages / 675,619 rows / 102 days |

2,668,495 rows over 975 owner-days. The reducer pages **per day**
(`quota-analysis-v11.ts:1136-1140`), so the heaviest v1.1 owner costs 254 usage
pages per model-day, not the 201 the plan estimated.

In-flight `analytics_history_checkpoint_stages` joined to `_parts`, by
`json_extract(control_json,'$.phase')`:

| phase | stages | parts | payload bytes | max parts |
|---|---|---|---|---|
| `usage` | 33 | 791 | 88,754,312 | 59 |
| `acquisition` | 5 | 25 | 1,295,659 | 10 |

**98.6% of all in-flight checkpoint payload is the usage phase**, and a single
usage successor already frames 59 parts (~7.5 MB against the 8 MB
`MAX_V11_USAGE_CHECKPOINT_BYTES`, `quota-analysis-v11.ts:73`). Completed
`analytics_community_graph_results` for v1.1: 38 `model` (19 ready, 12
`multi_plan_window_unsupported`, 7 `supported_quota_track_unavailable`) against
**6 `fits`**.

Today's quota page is 16,384 (`a40ffb3b`) and the usage page is 5,000
(`typed-v11-analysis-reader.ts:9`), so per heavy v1.1 owner-day the split is
**300 quota pages against 254 usage pages**. The quota enlargement that shipped
today banked most of the quota win; that is precisely why usage now binds.

### 1. What the usage phase computes

One traversal, `advanceV11UsageReduction` (`quota-analysis-v11.ts:1102`),
serves **both** metrics; `advanceStorageV11Analysis` runs it for
`metric:'fits'` and `metric:'model'` alike (`storage-v11-history.ts:190`).
There is no model-only mode.

| # | component | key | inputs | composability |
|---|---|---|---|---|
| 1 | `usagePrevious` (`:857`) | `[provider, session_uuid]` | `row.session_uuid`, `observed_at`, `attribution.accountBasis` (`:993-998`) | **per-day + bounded carry** — the per-session tail `{time, scope}` |
| 2 | `usageHazards` (`:858`) | `all\|P`, `known\|P`, `unknown\|P`, `[P,scope]` | interval `[prior.time ?? end, end]` (`:1036-1042`) | **per-day + the same carry** — see below |
| 3 | `usageScalarBuckets` (`:859`) | `[provider, scope, eraKey, exact, anchor]` (`:1050`) | window-wide `eraKey` and window-wide quota grid (`:492`, `:1048`) | **genuinely window-scoped** |
| 4 | `usageModelCosts` (`:860`) | `[floor(end/grainMs)*grainMs, model]` (`:1088`) | 2-hour bin, priced model | **pure per-day aggregate** |
| 5 | `usagePoisoned` (`:861`) | 2-hour bin instant (`:1080`) | unpriced event | **pure per-day aggregate** |

Plus control counters (`usageEventCount`, `unpricedUsageEventCount`,
`attributionUnresolved`, three refusal slots).

**Hazards are a union, not a sequence.** `Hazards.add` (`:605`) merges only
against the bucket tail because usage arrives in end-time order, but
`overlaps` (`:620`) re-sorts and rebuilds prefix maxima at query time, so the
answer depends only on the *set* of intervals. Union is commutative and
associative, so hazards compose per day exactly. The one order-dependence is
`intervalCount` -> `exceeded` (`:617`).

**Why 3 is window-scoped, twice over.** `eraKey` embeds the era's first observed
instant (`packages/quota-analysis/src/plan-attribution.js:235-237`), so the
oldest era's key changes every time the 100-day window slides; and the first
era's `lowerBoundMs` is `null` only while the window stays single-plan
(`:239`, `:259-261`). Independently, `anchor = ceiling(grid.ordered, end)` over
every quota `observed_at` in the window (`:492`, `:1048`).

**4 and 5 are already gated to the easy case.** `usageReductionRuntime:1024`
refuses the model metric unless the window has exactly one era, one account and
one plan. In that case every event matches the same era, and the only remaining
per-event decision is `accountBreak`, which is the session carry.

### 2. Is a sufficient per-day usage artifact possible?

**For components 1, 2, 4 and 5: yes, cheaply, and byte-identically.** Carry-out
per day: the per-session `{time, scope}` tail (`usagePrevious` itself) and each
session's *first* event in the day held individually so the fold can form its
interval once carry-in is known. Everything else folds by union (2), integer sum
(4) and set union (5). Measured cost:

- distinct `(2-hour bin, model)` cells per owner-day: **9,338 across all 975
  owner-days** (2,428 v1.1 + 6,910 v1), mean 9-11, max 46. That is a **286-fold
  row reduction**.
- distinct sessions per owner-day: 25,688 total, mean 21-44, max 444 — far under
  `MAX_SESSIONS` = 100,000 (`:70`).

At ~150 B/cell and ~60 B/session that is **about 4 KB per owner-day**, ~10 KB at
the measured maximum, **~4 MB for the whole 975-owner-day corpus**. A heavy
owner's whole 100-day window fits in *one* 256 KiB page.

**For component 3: technically yes, practically no.** The sound unit is per day,
per `(provider, scope)`, per attribution signature
(`planBasis, planType, planEraId`), split at every quota instant where the
day-local plan signature changes or an equal-time conflict occurs — the same
rule `prepareQuotaPage` uses (`prepared-v1-day.ts:39`) — with a tail bucket for
events after the day's last quota instant, resolved against the next day's
first. Nothing is lost and the fold is byte-identical up to the refusal
thresholds. But it buys nothing, because:

- distinct quota instants per owner-day: 661,311 (v1.1), mean 3,104, max 21,652;
- distinct usage instants per owner-day: 661,474 (v1.1), mean 3,105, max 21,652.

**Quota and usage records share observation instants to within 0.03%.** So
`grid.exact.has(end)` is true for essentially every event, `anchor = end`, and
there is roughly **one scalar bucket per usage event**. The artifact would be
~340 KB per owner-day, ~330 MB for the corpus, ~30 MB for the heavy owner's
single window — the same order as the 8 MB checkpoint it replaces, times the
parts already framing it.

Residual inexactness, for every component: the refusal thresholds are
order-sensitive exactly as `QUOTA_RESET_CLUSTER_LIMIT` is —
`MAX_HAZARD_INTERVALS` (`:617`), `MAX_USAGE_BUCKETS` (`:71`), the 8 MB byte
limit (`:1160-1163`) and `MAX_WINDOWED_USAGE_ROWS` (`:1141`). Fold in strict day
order and fixture at each bound.

### 3. Can the existing v1.1 reusable day values serve instead?

**No, and the gap is one specific field.** `analytics_v11_reusable_values`
(`0004`) and `analytics_v11_value_pages` (`0013`) store
`V11DailyProjectionValues` (`v11-daily-projection-values.ts:22-29`): whole-day
`counts`, `tokens`, `pricing`, up to 200 `(provider, modelId)` cells and an
`omitted` subtotal. **There is no time dimension inside the day at all.**

Missing, in order of severity:

1. **The 2-hour bin.** Without it there are no `usageModelCosts` keys.
2. **Per-bin poisoning.** The daily values carry a day-level `unpriced` count per
   cell; `usagePoisoned` needs *which bin instants* an unpriced event landed in,
   because one unpriced event voids the whole bin (`:1080`). A day-level count
   cannot reconstruct that. This alone is fatal.
3. `firstObservedAt` / `firstOccurrenceId` per cell, which
   `V1PreparedUsageFragment.cells` carries.

Could the daily lane emit them without changing the daily series? The page fold
`mergeV11DailyProjectionValues` is already associative and pages are disjoint,
so a sibling `bins` array would fold correctly. But `values_json` is closed
(`validateV11DailyProjectionValues:81`), so adding it bumps
`V11_DAILY_VALUES_SCHEMA`; `schema_version` is inside `value_key`
(`v11-daily-projection.ts:129-135`), so **every reusable day value in the corpus
misses and the whole daily lane rebuilds**, and `0013`'s CHECK pins the literal
`'v11-daily-projection-values-v2'` so it needs a migration too. Cheaper to emit
a sibling artifact than to widen this one.

### 4. The v1 side — where this is already solved

**The v1 graph history path has no usage phase.**
`advanceStorageV1HistoricalAnalysis` (`storage-v1-history.ts:25`) goes
`acquisition` -> `finish`; only `advanceStorageV1CurrentFitAnalysis` (`:75`) has
a `'usage'` phase, and the graph lane calls the former
(`storage-community-graph.ts:662`). The usage read happens inside
`finishHistoricalModelCompositionV1` (`quota-analysis-v1.ts:667`), which passes
`scalarRequested = false` -> `scalarReason` is set at `:2547` -> **`useBins` is
enabled at `:2590`**, reading `community_prepared_usage_bins` at 256 fragments
per statement (`:2599`) instead of 5,000 events.

So v1 already does exactly what this addendum recommends for v1.1: it asks for
model composition only, and folds 2-hour prepared bins built by
`prepareUsagePage` (`prepared-v1-day.ts:94`) into
`community_prepared_usage_bins` (`prepared-v1-evidence.ts:18-19`).
`analytics_v1_chunk_values` (`0005`) is the v1 *daily* projection and has the
same no-time-grain problem as `0004`; it is not the relevant artifact.

The asymmetry is the whole finding: **v1 splits the scalar and model halves and
folds the model half; v1.1 fuses them into one reduction that always computes
all five components for both metrics.**

### 5. Revised speedup arithmetic

Group cost, from `storage-community-graph.ts:59-118`: 8 pages + 4 fences + 6
pre-checks + 37 first save = **55 statements per claim**, plus 32 per extra save
batch beyond 30 parts. Lane rate ~10,000 statements/hour (this plan's measured
baseline). Heaviest v1.1 owner; whole v1.1 lane is 5 owners.

| case | pages / heavy owner-day | v1.1 statements / model-day | 69 model-days |
|---|---|---|---|
| do nothing | 300 quota + 254 usage = **554** | ~2,200 quota + ~3,270 usage = **5,470** | **~38 h** |
| quota-only fold (Phase A today) | ~70 artifact + 254 usage = **324** | ~150 + ~3,270 = **3,420** | **~24 h (1.6x)** |
| quota + usage fold (model half) | ~70 + ~2 = **72** | ~150 + ~60 = **210** | **~1.5 h (26x)** |

Usage is **52% of the heavy owner's statements today** and ~96% of what
quota-only folding leaves behind. Phase A's "~20x" was computed against the
4,096-row quota page and against a whole-lane statement total this addendum does
not re-derive; on the v1.1 lane with today's 16,384-row page, **quota-only
folding is ~1.6x**. The v1 lane is unchanged in all three cases: it has no usage
phase and already folds bins.

### Recommendation

**Extend Phase A to cover usage — but only the model half, by giving the v1.1
reduction the model-only mode v1 already has.** Concretely: a `scalarRequested`
flag on `advanceV11UsageReduction` mirroring `quota-analysis-v1.ts:2547`, so
`metric:'model'` folds components 4 and 5 from the `usage` fragments the Phase A
artifact **already carries and does not use**
(`graph-day-projection-values.ts:148-153`; `foldV11QuotaAcquisition` consumes
only the quota components, and `storage-v11-history.ts:189-201` still pages
usage unchanged), plus the per-session carry. That is ~4 KB per owner-day, one
page per owner-window, and it recovers the full 26x.

**Do not fold `usageScalarBuckets`.** It is sound but pointless: production shows
one bucket per usage event. Leave `metric:'fits'` on the paged reduction — six
v1.1 `fits` results exist in the whole corpus — and treat its cost as a separate
question about whether that metric is affordable at all for a dense owner.

Do not reuse `analytics_v11_reusable_values`: per-bin poisoning is
unreconstructible from it, and widening it rebuilds the entire daily corpus.

### The single biggest unknown

Whether the heaviest v1.1 owner's scalar reduction is already destined to refuse
with `reduced_usage_limit_exceeded`. Its window implies roughly **640,000
distinct anchors** against `MAX_USAGE_BUCKETS` = 120,000 and an 8 MB checkpoint
cap that its 59-part successors are already near. If it is, the 33 in-flight
usage stages and 88.75 MB of parts are buying a refusal on one metric and a
2-hour-bin result on the other, and the fix is the model-only mode rather than
any fold. This is arithmetic, not observation: **no `fits` result for that owner
exists to confirm it.** Establish it before building anything — a single
instrumented replay of that owner's reduction against a copy settles it, and it
decides whether this is a throughput change or a refusal-boundary change.
