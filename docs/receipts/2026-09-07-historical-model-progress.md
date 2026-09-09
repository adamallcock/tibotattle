---
title: Historical model progress repair
date: 2026-09-07
type: receipt
status: verified-progress
source_commit: a4b6cbb4a236654ccc3f1c06c674481936057a2e
---

# Boundary

Deployed the hosted historical model scheduling/publication repair on the
incremental graph-cache branch, preserving published graphs, exact calculation
semantics, source fences, consent and lifecycle behavior. No desktop changes,
migrations or telemetry deletion. Current authority is
[current status](../current-status.md) and the
[production runbook](../runbooks/production-operations.md).

Production observation at 21:46 UTC: seven stored dates (September 1–7),
August 31 terminal results 7/15, acquisition complete 9/15; checkpoints advancing
but no older date published. History previously received only leftover budget.

## Implemented boundary

- Give history a fair first-use slot within the existing shared bounded scheduler;
  retain guaranteed opportunities for current reconstruction and publication.
- Remove avoidable historical completion/publication delays without clearing
  completed graphs or publishing partial cohorts.
- Inspect acquisition/finishing costs; optimize only with exact-result and
  interruption/replay evidence. Do not reduce quality thresholds or resource guards.
- Run focused runtime regressions, types and affected deployment checks.
- Verify source/deployment separately; production changes use the guarded path.
  Live acceptance requires older model dates or measurable durable progress,
  preserved current graphs, and healthy required maintenance.

## Progress

- Implemented fair three-slot scheduling, sixteen bounded account attempts,
  same-run complete-cohort revalidation and prompt atomic preview refresh.
- A tested indexed future-tail-skipping prototype was deferred: changing a
  physical page can conflict with pre-upgrade staged-page replay. Shipping this
  optimization requires an explicit compatible replay policy, not just an
  unchanged completed result. The deployment retains the original page reader
  and checkpoint format, with no schema changes.
- Exact final source passed the complete Worker check: 860 tests in 63 runtime
  suites, 207 operational/script tests, generated assets/types, TypeScript,
  workspace copy, and development/staging dry builds. The separate production
  dry build passed. Documentation/preflight (20 tests) and architecture checks
  also passed. Regressions include August 31 then August 30 publication, fair
  account rotation, same-run complete-cohort validation, stale-source rejection,
  prompt new-day preview refresh and existing-graph preservation.
- Independent review found no blocking publication/source-fence regression.
  A malformed stored new-day payload can trigger repeat bounded preview attempts,
  but cannot enter a published graph or erase the retained valid snapshot.

## Production evidence

- Normal guarded deployment succeeded at 22:24:14 UTC on 2026-09-07. Worker
  version `700aec28-e2a3-4aff-9e25-24c20b076d78` serves the exact source above.
  Pre/post health passed, the migration gate found no pending migrations, and
  public/admin separation passed. No emergency bypass or manual maintenance.
- At 22:25 UTC, independent public checks matched eleven deployed asset hashes,
  denied five private routes, and verified healthy database/deletion-ledger/
  restore state. Both 0.1.18 installers, Intel Homebrew guidance, social metadata
  and the 1200x630 PNG remain unchanged.
- Read-only natural-cron observation confirmed history's `before_analysis`
  priority slot and later leftover-budget slots. Account results for August 31
  advanced from 10 before deployment to 11, 12, then 14 at 22:31:22 UTC. At
  22:32:16 UTC one account remained in input acquisition, with 620 saved steps.
  At 22:34:46 UTC that same remaining phase had reached 911 saved steps; all
  fourteen completed results remained present. Required maintenance completed
  at 22:34:44 UTC with no failure code.
  Query counts stayed below the 900-statement invocation cap. The 40-second
  deadline gates admission; already-admitted work can finish after that deadline.
- Public and authenticated admin By model / All views render with existing
  estimates. The inspected admin page reported no current sampled service errors
  and no browser console warnings/errors. The existing public snapshot retains
  69 aggregate dates, 207 plan points and 26 model points, alongside 318 activity
  dates. Desktop layout was visually checked; no UI source changed and mobile
  layout was not requalified in this backend-only repair.

## Remaining claim boundary

At 22:34 UTC the seven stored model dates still start September 1; the public
view excludes today's September 7. Resumed progress is verified, but August 31
publication and a complete 70-day historical model backfill are not yet proved.
Unsupported/unstable dates remain absent, never zero or synthetic model history.
The deferred page-reader optimization is not part of the deployed source.
