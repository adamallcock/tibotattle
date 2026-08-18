---
title: Community allowance band — diagnosis runbook
date: 2026-08-13
type: runbook
status: operational
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

`fitCount: 0` or a missing allowance means the fit set is empty upstream — keep
going.

## 2. Inspect the fit cache — the key signal

```sql
SELECT COUNT(*), MAX(LENGTH(fits_json)), MAX(computed_at)
  FROM community_allowance_fit_cache;
```

Interpretation:

| Observation | Meaning |
| --- | --- |
| **No row** for a participant | the analyzer **threw**. The per-participant `try/catch` in `collectCommunityAllowanceFits` swallows the error and skips the cache write, so a throw looks like silence, not a crash. |
| `fits_json` length **2** (`[]`) | the analyzer **completed with zero fits** (ran fine, produced nothing qualifying). |
| `fits_json` length **> 2** | **real fits** are cached. |

A throw that leaves no row is the classic "band never drew" fingerprint: the
code path ran, caught, and moved on.

## 3. The cache short-circuits BEFORE the analyzer runs

The v1 fit cache key is **chunk-journal epoch + price-registry sha256 +
`FIT_ADAPTER_VERSION`** (`community-allowance.ts`). A cache hit skips the read +
reprice + fit entirely. That means **a stale or wrong cache entry hides a code
fix**: after deploying any analyzer-logic change, the new code returns the old
cached result until the key changes.

After deploying an analyzer change, do exactly one of:

- `DELETE FROM community_allowance_fit_cache;` (owner-run write), or
- bump `FIT_ADAPTER_VERSION` in `community-allowance.ts` (ships in the deploy;
  invalidates every key).

If you skip this, the band will not reflect your fix and you will chase a ghost.

## 4. Other state to check

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

## 5. Confirm the participant is even selected

The collector requires `participants.state = 'active'` and **non-superseded** v1
chunks. A participant that is inactive, or whose chunks are all superseded,
contributes no fit — this is by design, not a bug.

## Deploy handoff (assistant ↔ owner)

The band fix lives in worker code + D1 state, and production writes are
owner-run:

- The assistant can run **read-only** remote inspection —
  `npx wrangler d1 execute app-usagemonitor-production --remote --env production
  --json --command "SELECT …"` — and should use it to read the fit cache and
  aggregate state against real data.
- Production **writes** are the owner's: `wrangler deploy --env production`,
  `wrangler d1 migrations apply --remote`, and any `DELETE`/`UPDATE`. In this
  environment those are classifier-blocked for the assistant.
- **`wrangler deploy` does NOT apply D1 migrations.** Run
  `wrangler d1 migrations apply` separately. A code change that depends on a new
  migration (e.g. the fit cache table, migration 0035) will silently degrade
  until the migration is applied — `collectCommunityAllowanceFits` treats a
  missing cache table as a cache miss and recomputes fresh, so the band still
  works but without the cache.
- A stale wrangler OAuth token yields D1 **write** `7403` while D1 **reads**
  still succeed. `wrangler login` refreshes it.

Workflow: assistant validates + commits + pushes; owner runs the production
deploy, the migration apply, and (per step 3) the cache clear or version bump.

## See also

- D1 queries used during this diagnosis must respect the approximate 100-bind
  cap. Use `--file` for multi-statement input and `--command` for a bounded
  direct query; remote cost profiling reads `meta.rows_read` rather than
  inferring query cost from returned rows.
- Production deploy gate (migrations, not intake):
  [`the 2026-08-07 governance decision`](../governance/2026-08-07-production-deploy-migration-gate.md).
