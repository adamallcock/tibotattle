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
maintenance first. Check `BOUNDED_ANALYSIS_PROGRESS`, deferred reasons and
`queriesUsed` across natural scheduled invocations. Heavy required work may
defer a large completed checkpoint before loading it. New activity-only days
retain their queue entry for a later complete allowance rebuild.

## 5. Confirm the participant is even selected

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
  cap. Use `--file` for multi-statement input and `--command` for a bounded
  direct query; remote cost profiling reads `meta.rows_read` rather than
  inferring query cost from returned rows.
- Production deploy gate (migrations, not intake):
  [`the 2026-08-07 governance decision`](../governance/2026-08-07-production-deploy-migration-gate.md).
