---
title: Community allowance band — diagnosis runbook
date: 2026-08-13
type: runbook
status: maintained
---

# Community allowance band: "it is null / not drawing"

Use this when the public community allowance band on
[tibotattle.com](https://tibotattle.com) shows no allowance (or a stale one) and
you need to find out why. The band is produced by the v1 fit analyzer in
`apps/worker/src/quota-analysis-v1.ts`, collected and cached in
`apps/worker/src/community-allowance.ts`, and published per day by
`apps/worker/src/community-daily-aggregates.ts`. Diagnose in the order below;
each step narrows to a different failure mode.

## 1. Read the endpoint on the custom domain

The band serves at:

```
https://tibotattle.com/api/v1/community/daily?from=YYYY-MM-DD&to=YYYY-MM-DD
```

- It is on the **custom domain only**. Production sets `workers_dev: false`, so
  the `*.workers.dev` URL returns 404 — do not diagnose against it.
- Parse `days[].payload.allowance` and read `fitCount` and `centralUsd`.
- The endpoint **rejects unknown query params**, so there is no cache-buster:
  `&cb=…` returns an error. To defeat the ~5-minute edge cache, **vary the date
  range** instead (shift `from`/`to` by a day).

`fitCount: 0` can mean no qualifying evidence. A missing allowance can instead
mean reconstruction is paused, incomplete or waiting for source-current caches;
check `allowanceState` and continue below. Never interpret unavailable as zero.

## 2. Inspect the fit cache — the key signal

```sql
SELECT COUNT(*), MAX(LENGTH(fits_json)), MAX(computed_at)
  FROM community_allowance_fit_cache;
```

Interpretation:

| Observation | Meaning |
| --- | --- |
| **No current row** for a participant | acquisition may be incomplete, budget-limited, source-stale or unavailable; inspect restart progress and logs before classifying it as an analyzer exception. |
| `fits_json` length **2** (`[]`) | a source-current, validated entry represents a completed analysis with no qualifying fits; the model result can independently be ready or analytically refused. |
| `fits_json` length **> 2** | validate the payload, source revision, fingerprint and method before treating the stored fits as current. |

Missing caches are a reason for the cache-only graph consumer to defer the
whole cohort, not permission to run a whole-corpus calculation in a request.

## 3. The cache short-circuits BEFORE the analyzer runs

The cache identity includes source kind, analytical input revision, analysis
start day, source fingerprint and `COMMUNITY_ATTRIBUTION_METHOD_VERSION`
(`community-allowance.ts`). The method includes the analytical adapters and
pricing policy. A valid cache hit skips acquisition and fitting; a malformed
entry is rejected even if its key matches.

A semantic analyzer change must update its reviewed method identity and tests.
Do not clear production caches as a shortcut or rewrite published evidence.
The scheduled warmer repairs invalid caches and promotes scalar/model results
atomically under source and maintenance-lease fences.

## 4. Other state to check

- `ALLOWANCE_RECONSTRUCTION_MODE` on the exact deployed source. `paused` is
  deliberate containment; `resumable` requires migrations `0046`–`0047`.
- `telemetry_v1_quota_fit_backfill` — finite historical high-water mark and
  progress. Readers must wait for its completion.
- `community_analysis_work` and `community_analysis_work_stage` — phase,
  progress revision and source-method identity. Inspect aggregate counts and
  bounds, not raw participant data or checkpoint payloads.
- `community_daily_aggregate_rebuilds` — the rebuild queue. Is anything queued
  or stuck?
- `community_snapshot_mutation_control` — the mutation epoch.
- Most-recent `community_daily_aggregates.released_at` — is anything actually
  republishing?

The drift reconciler `enqueueCommunityAllowanceDriftRebuilds`
(`community-daily-aggregates.ts`) recomputes the expected allowance for each
published day and enqueues **only** the days whose published value differs. If
nothing differs, nothing republishes — a correct fit set that never reaches a
changed day will not surface until a day's expected value moves.

The resumable scheduler budgets both D1 bindings together and runs essential
maintenance first. Its 40-second graph window begins after required work and
bounded weekly publication, without resetting the statement budget. Inspect
`scheduled_graph_admission` for preceding phase durations and the newly available
window. Check `BOUNDED_ANALYSIS_PROGRESS`, deferred reasons and `queriesUsed`
across natural scheduled invocations. Heavy required work can still consume
enough statements to defer a large checkpoint. Weekly build failures are isolated
and cannot abort graph admission; losing the outer maintenance lease still stops
the invocation. New activity-only days retain their queue entry for a later
complete allowance rebuild.

For a preview that is not advancing despite current account caches, inspect the natural
invocation's wall time and `admin_allowance_preview_cache` phase timing, not
only lifecycle `last_completed_at`. That stamp is written before optional
analytics. A three-minute rotation gives preview publication, current account
calculation, and historical reconstruction first use of the graph window in
turn. Incomplete preview inputs retry `after_analysis`; daily publication and
remaining historical work use the available budget. Refreshed rows and
deferrals log `queriesUsed`, `phaseQueries`, `elapsedMs` and
`deadlineRemainingMs`. An unchanged same-day preview is quiet; it no longer
rebuilds after an age threshold. Changed inputs or newly completed model dates
trigger publication. Migration 0050 preserves published snapshots during
validated appends and corrections, without changing their timestamps. Withdrawal,
erasure, policy changes and unrecognized direct mutations still invalidate them.

The separate admin growth-history cache has no age-only read limit.
Inspect `admin_metrics_history_cache.generated_at` and the latest
`admin_metric_snapshots.captured_at` independently of allowance availability.
Even-minute passes give these self-throttled caches an early opportunity after
allowance publication. `admin_metrics_snapshot` and `admin_metrics_history_cache`
log refresh/failure timing or `OWNER_METRICS_BUDGET_DEFERRED`; a current cache is
quiet. Their failure must not be reported as an allowance or database outage.

The independent owner-only `/api/v1/admin/reconstruction-progress` request
shows exact requested/prepared/published generations and historical progress.
A temporary storage failure preserves the last validated graph while this lane
can continue reporting. Confirmed invalidation or revoked owner access clears
the affected private data. Refresh requests never perform calculations. The
admin client uses the exact `detail=preparation` selector to add bounded saved
preparation counters; query-free clients retain the original response. Compare
those counters when an account count stays flat: reusable source preparation
can be advancing before the old physical-reader checkpoint resumes. Retained
source days are not the remaining historical-window denominator.

### Only one day in the admin "By model" chart

The original per-model view recorded forward daily snapshots, whereas the
plan view reconstructed its date range from scalar reset fits. Migration
`0048_community_model_history.sql` and `community-model-history.ts` add a
separate, low-priority historical model backfill. Source implementation is
not proof that the migration or Worker has been deployed.

- Each closed UTC day uses its own preceding 100-day acquisition horizon and
  only observations through that day. The NNLS identification gates, pricing,
  and Pro 20x normalization are unchanged. Today's fitted vector is never
  copied backward, and later Astra usage cannot create pre-Astra points.
- Up to 69 missing dates before today are reconstructed, newest first. A day
  publishes only after the complete bounded cohort resolves. Sparse, unstable,
  unsupported-source and incomplete evidence remains absent, never zero.
  Activated v1.1 and overlapping legacy quota sources are not backfilled by
  this v1-only lane; they are reported as unsupported, never downgraded.
- Inspect aggregate `scheduled_model_history` progress, not private payloads.
  `community_model_history_work`, its parts/stage tables, and
  `community_model_history_results` are isolated from current-analysis caches
  and checkpoints. They share the same actual query meter and defer behind
  essential maintenance, current estimates and normal graph publication.
- A non-null `community_model_composition_days.history_method_version` marks
  a retrospective reconstruction. Existing current-method forward snapshots
  are preserved. Late v1 corrections invalidate only reconstructed days whose
  input window includes the corrected date; source transitions and withdrawal
  invalidate affected reconstructed cohorts. Private derived work follows
  participant erasure. Bounded cleanup removes only obsolete derived results.
- Migration 0051 separates window dependencies from participant write revisions.
  Unrelated out-of-window uploads retain results and checkpoint parts after exact
  source revalidation. Migration 0052 prepares elected source days once for
  overlapping windows; raw and prepared in-flight pages retain separate replay
  policies. Migration 0053 skips completed unchanged current/daily lanes before
  raw reads. Preserve all generation, method and lease checks during diagnosis.
- The healthy preview stays available; new reconstructed points enter its
  normal atomic refresh, not necessarily the next browser refresh. No forced
  live replay or production cache clearing is part of local qualification.

Historical reconstruction uses currently retained corrected evidence and
surviving contributors, not an assertion of what the site displayed then.
Separately authorize migration `0048` and deployment, then verify natural
scheduled progress, the exact admin response and the rendered multi-day chart.

## 5. Confirm the participant is even selected

### Public Aggregate / By plan / By model views

The public chart uses only the daily API's optional closed
[`allowanceBreakdowns`](../reference/api-surface.md#public-allowance-breakdowns),
not an admin endpoint. View and date-range selection are client-side over that
one periodically refreshed read. All views share date and dollar axes; plan values are normalized to
Pro 20x and model values estimate a full weekly allowance on that model.

If activity works but a breakdown does not, check publication state and the
source-fenced preview cache first. Age alone no longer removes the graph. A
snapshot preceding the last hard invalidation, an invalid payload or unavailable
optional schema omits the breakdown
without failing activity. Only closed UTC dates present in the requested
published range may appear. An open-day admin point can therefore be absent
publicly. Model gaps remain gaps; do not copy today's vector backward or force
an interactive reconstruction to make a graph appear populated.

The v1.1 public graph projection includes the combined summary so all three
views advance atomically without substituting values into immutable daily
revisions. Visible pages refresh once a minute and preserve the display on
transient errors, but clear it for authoritative invalidation. New inputs should
not produce the global updating placeholder for validated corrections either;
only a confirmed hard-invalidating transition can revoke an authorized snapshot.

Sample counts may be one account and must remain visibly disclosed. No
account identifiers, private coverage diagnostics or plan-by-model cross-tabs
belong in this response. Check all three rendered views, their localized
disclosures, and the live revision separately from local tests.

The collector requires an active participant and the source selected by the
current source-precedence rules. Winning-device v1 history, retained accepted
legacy data and activated v1.1 have distinct policies. Missing source evidence
must not be replaced with a different transport's numerator. A legacy shard
can suppress model composition only when it overlaps the relevant domain.

## Deploy handoff (assistant ↔ owner)

The band fix lives in Worker code and D1 state. Follow the
[production operations runbook](./production-operations.md):

- The assistant can run **read-only** remote inspection —
  `npx wrangler d1 execute app-usagemonitor-production --remote --env production
  --json --command "SELECT …"` — and should use it to read the fit cache and
  aggregate state against real data.
- Production writes require explicit owner authorization for the exact
  outcome. Use `npm run production:deploy -- --confirm DEPLOY_PRODUCTION`,
  never raw deployment or a health-check bypass for normal resumption.
- **`wrangler deploy` does NOT apply D1 migrations.** Run
  `wrangler d1 migrations apply` separately. A code change that depends on a new
  migration must remain paused until the reviewed migration is applied and
  checked. Missing projection/checkpoint tables defer optional reconstruction;
  cache-only consumers do not recompute against raw history.
- A stale wrangler OAuth token yields D1 **write** `7403` while D1 **reads**
  still succeed. `wrangler login` refreshes it.

Validate, review recovery options, apply only the approved migration set and
deploy through normal guards. Verify exact source, natural scheduled progress,
current public/admin responses and the rendered graph separately. A successful
deployment or health response does not by itself prove graph recovery.

## See also

- D1 queries used during this diagnosis must respect the approximate 100-bind
  cap. Use `--command` for bounded SELECT-only inspection; remote `--file`
  uses the import path and does not return the selected diagnostic rows.
  Remote cost profiling reads `meta.rows_read` rather than
  inferring query cost from returned rows.
- Production deploy gate (migrations, not intake):
  [`the 2026-08-07 governance decision`](../governance/2026-08-07-production-deploy-migration-gate.md).
