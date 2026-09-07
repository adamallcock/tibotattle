---
title: Historical model progress repair
date: 2026-09-07
type: plan
status: in-progress
---

# Boundary

Repair the hosted historical model bottleneck on the incremental graph-cache
branch, preserving published graphs, exact calculation semantics, source fences,
consent and lifecycle behavior. No desktop changes or telemetry deletion.

Production observation at 21:46 UTC: seven stored dates (September 1–7),
August 31 terminal results 7/15, acquisition complete 9/15; checkpoints advancing
but no older date published. Historical work currently receives leftover budget.

## Implementation and acceptance

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
- Added indexed historical future-tail skipping within a reset group. A
  synthetic interrupted/resumed fixture preserves exact evidence while reducing
  fit-page reads from 34 to 6; later reset groups remain included. This is not
  a production throughput benchmark. No schema or checkpoint-shape changes.
- Local integrated regression pass: 113 tests in six Worker runtime suites.
  Earlier full Worker pass: 860 tests in 63 suites, plus 207 script tests.
  Docs/preflight (20 tests), architecture and TypeScript passed. The composite
  check reached its expected clean-commit requirement before dry builds.
- Independent review found no blocking publication/source-fence regression.
  A malformed stored new-day payload can trigger repeat bounded preview attempts,
  but cannot enter a published graph or erase the retained valid snapshot.
- Production remains on the previous source. Final clean-source checks,
  guarded deployment and live historical advancement are still pending.
