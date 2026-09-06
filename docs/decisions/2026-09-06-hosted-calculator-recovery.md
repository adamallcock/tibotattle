---
title: Restartable hosted calculator recovery
date: 2026-09-06
type: decision-record
status: implementation-validation
---

# Decision

Replace the failing whole-corpus quota SQL path with bounded keyset reads,
restartable source-pinned acquisition, one shared usage/pricing pass and
cache-only graph publication. Keep existing calculation, pricing, source
precedence, evidence caps and refusal rules. This is an implementation decision,
not evidence that the replacement is deployed or the graphs have recovered.

The owner approved production migrations `0046`–`0047` and deployment only
after validation and recovery review. Telemetry, consent, retention, v1.1
activation, desktop 0.1.18 artifacts and published tags stay unchanged.

## Why this design

Shorter SQL alone did not resolve the incident. The whole-corpus index proposal
failed an enforced SQLite 128 MiB allocation test; a sparse-query rewrite also
exhausted production database CPU. The selected empty lookup plus bounded
backfill avoids a historical sort in the migration. Physical keyset limits
precede residual eligibility and winning-device filters, so losing rows and
equal-time ties cannot force a scan of an unbounded prefix.

Quota acquisition is restartable; it never publishes a partial fit. Its
content-addressed chunks and staged manifests preserve a verified source,
method, cutoff and fixed calculation clock across invocations. Corrections,
successor activation and source changes invalidate obsolete work; bounded
cleanup permits a fresh run without altering retained telemetry.

Scalar and per-model fitting share the admitted usage read and server-pricing
pass. Compact exact session state avoids duplicate strings and large object
graphs. All relevant reducer outputs must remain equivalent to the shared
calibration kernel; performance changes cannot turn partial or erroneous
results into empty successful caches.

An additive ordered-usage package entrypoint consumes completed model bins
without retaining a second whole-corpus map. The original array entrypoint,
floating-point addition order, model ordering and fitting policy remain
covered by equivalence tests. Exact interval unions replace per-bin enumeration
for safe integer time grids; other custom grids retain the original behavior.

## Publication and operational boundaries

- One 900-statement meter covers both primary and deletion-ledger bindings,
  including failed statements and batch members. No account receives a new
  invocation-wide allowance.
- Essential lifecycle and deletion-safe maintenance run before optional
  reconstruction. A bounded calculation failure cannot prevent publication
  of other already-complete evidence or new activity.
- A complete head reserves rehydration and finish work before loading its
  payload. Heavy essential maintenance can still defer it; the largest
  admitted head is not an eventual-completion promise under saturation.
- The optional wall-clock deadline is an admission check, not cancellation of
  an already admitted finish. A finish can outlast that deadline, remains
  bounded by its shared query reserve, and must pass the final source fence.
- Both analytical caches publish under one transaction, exact source and
  owned-lease fences. A final in-transaction assertion rolls back both if a
  fence fails between writes.
- Graph readers validate the full cohort and final mutation epoch. Missing,
  stale, malformed or over-budget data causes deferral, not raw-analysis
  fallback or a published prefix. The current census ceiling is 1,024
  physical participants; a larger cohort needs a separate bounded reducer.
- Activity-only recovery can publish previously unpublished days with all
  tokens and API-equivalent spend. It omits unavailable allowance data,
  retains the rebuild queue and does not overwrite existing allowance days.

## Qualification and recovery

Local evidence includes real migrated-D1 source/lease races, checkpoint
resume and supersession, atomic rollback, full-cohort cache validation and
positive fits/spend through the graph consumers. Memory qualification must
cover the combined Worker and high session/model/bin cardinality. Node heap
flags are not a Worker memory cap; the installed local runtime does not
enforce production's total-isolate limit, so observed heap/backing-store
measurements and their limitations must be recorded explicitly.

The shared-kernel change invalidates the retained source-bound R7 receipts.
Their protected local-history regeneration needs owner authorization and the
existing pinned-runtime workflow; routine tests cannot refresh or waive it.
No published 0.1.18 receipt, installer or release tag is changed by this repair.

Before applying the approved migrations, verify both migration ledgers,
database headroom and current recovery bookmarks. The migrations create
derived structures and do not rewrite source data. On failure, keep the
existing reconstruction pause; prefer a schema-compatible forward repair.
Do not restore production, rewrite an applied migration, discard telemetry or
bypass normal deployment health checks.

Use the [production runbook](../runbooks/production-operations.md), then verify
the exact deployed source, natural scheduled results, updated caches and
rendered public/admin graphs. The maintained
[status page](../current-status.md) records which of those gates actually passed.
