---
title: Admin reconstruction visibility and useful-work scheduling
date: 2026-09-06
type: plan
status: completed
---

# Outcome and scope

Show the hosted calculation and publication backlog within the admin allowance
graph, including when its preview is unavailable. Preserve the distinction
between acquired account checkpoints, cached calculation results and published
daily estimates. No desktop, installer, R7 or private local-history work.

# Work and acceptance

1. Add bounded, owner-only, failure-isolated reconstruction metadata to the
   existing overview. Read only derived operational tables and project closed
   aggregate fields; no account IDs, raw telemetry or calculation on refresh.
2. Render lookup progress, calculation phases, source-changed work, maintenance
   state, publication backlog, priced-day coverage and freshness beside the
   admin graph. Missing and stale data remain explicit; no estimated finish time.
3. Improve the existing fair scheduler so already-current accounts do not consume
   its four useful-work slots. Preserve the same invocation query/time budgets,
   maintenance lease, source guards and accounting semantics.
4. Validate the API, privacy/failure boundaries, scheduler fairness/resource
   limits and browser states before the scoped Worker deployment gate.

# Parallel-day decision

Daily summaries are independent only after their source/cache prerequisites are
ready. Current historical publication waits for the complete current account
cohort. Merely running more day workers does not remove that upstream gate and
would multiply pressure on the same database and Worker memory. Evaluate
decoupled spend publication separately; do not silently weaken allowance
coverage or increase production concurrency as part of a progress display.

# Evidence boundary

The last live check at 20:34 UTC found 13 complete acquisition heads and two in
the plan phase, 238 queued daily rebuilds and only one newly priced published
day. Those are a diagnostic snapshot, not a forecast. Implementation,
validation and deployment results will be recorded here as they are verified.

# Implementation and verification

The optional overview projection and graph-side panel are implemented. A bounded
physical checkpoint/cache census precedes account joins. Daily price coverage
probes at most 32 physical revisions per day and reports diagnostics unavailable
if a published revision might be hidden beyond that bound. Source/window/method
changes are distinguished from current checkpoint acquisition. Diagnostics are
read-only and cannot take the rest of Operations down on failure.

Focused Worker validation passes 54 tests across progress, scheduling and admin
access, including the authenticated route's unavailable-diagnostics fallback.
The complete browser suite passes 518 tests, including stale refresh,
missing/invalid diagnostics, paused mode, bounded counts and unavailable preview.
Synthetic desktop and 390px browser inspection passed with the panel visible
despite the unavailable allowance preview. Independent SQL query-plan review
confirmed bounded pages before joins and indexed, capped daily probes. The
architecture gate caught a dependency cycle when composing diagnostics inside
the generic operations reader; composition now belongs to the existing route
entrypoint, and architecture/type checks pass without policy exceptions.

The complete hosted gate passes: 759 Worker tests in 58 files, 198 Worker script
tests, package-copy and endpoint guards, generated types/assets, TypeScript,
default/staging dry deployments and production dry bundle. Documentation,
20 preflight tests and architecture checks pass. No skipped browser/Worker tests.

# Live verification

At 21:11 UTC on 2026-09-06 the normal guarded production deployment returned
`PRODUCTION_DEPLOYED` for exact source
`daa82a939020cb74ad5054c4ee7e6091019502be`. It found no unapplied migrations;
pre/post health checks and the public-only surface check passed. Independent
cache-busted health returned `ok` with the exact source commit. No migration,
consent, activation, resource-limit or desktop-artifact changes were made.

Authenticated Chrome rendering shows the new panel alongside an unavailable
allowance preview: record lookup complete; 13 of 15 tracked account checkpoints
acquired; one preparing and one scanning; 2,345 current-run checkpoint steps;
266 queued days; 317 published days in the displayed year, of which one has
possibly partial price data. The latest cache timestamp is explicitly qualified
as potentially outdated. The panel is readable at the real desktop viewport.
These are observations at 21:11 UTC, not a completion forecast or a claim that
the allowance graph has recovered.

A subsequent content-free database read showed both unfinished jobs in scanning
and a natural maintenance run recorded at `2026-09-06T21:11:18.000Z`. No manual
maintenance, lease override or checkpoint reset was used for verification.

The useful-work scheduler remains sequential: current cache checks consume the
same statement budget but not the four unfinished-analysis slots. Tests prove
unfinished work behind 13 current accounts is reached, the four-attempt ceiling
and rotating fairness remain, and spent budgets do not create work. No ETA or
parallel-day throughput claim is made.
