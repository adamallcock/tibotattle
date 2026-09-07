---
title: Repair scheduled allowance cache publication
date: 2026-09-07
type: plan
status: validating
---

# Repair scheduled allowance cache publication

Owner authorized backend repair after the separately deployed plan-card/admin
presentation update. Base `f34cb6be`; deployed `df559970`. Preserve the
[earlier receipt](../receipts/2026-09-07-plan-values-admin-graph-parity.md),
telemetry, consent, freshness limits, calculation semantics and 0.1.18 artifacts.

Natural scheduled observation at 15:44:35 UTC: account checks completed after
33,591ms (143 statements), preview refused after 41,166ms, and invocation wall
time was 41,463ms. This crosses the existing 40-second optional-work deadline;
there was no historical-model stage. A separate metadata check confirmed zero
queued daily rebuilds. Lifecycle's 5.3-second completion stamp precedes optional
analytics and does not measure the whole invocation.

Publish the same validated, complete cached cohort before optional account
reconstruction. If unavailable, retry after reconstruction but before daily
reconciliation. Preserve lifecycle priority, the single invocation budget,
source-epoch fences, atomic writes and the existing 55-minute refresh interval.
Record content-free phase timings/counters so deadline deferrals are visible.

Local proof: the two regressions fail against the original ordering (expired
preview retained; no early/retry read), then all 11 scheduler tests pass with
the repair. All 68 cache, atomic publication, preview and account-warmer tests
pass. The new early incomplete-cohort check adds exactly four SELECTs to the
fixed setup receipt (53 total, 50 primary and 3 ledger); the unchanged 900-query
ceiling still admits the maximum completed checkpoint. TypeScript, 20 preflight
tests, documentation and architecture checks pass. Full Worker/deployment and
natural live recovery remain pending; no production repair is claimed yet.

- Isolate the publisher refusal after successful account-cache validation,
  using a local reproduction and bounded, content-free production observations.
  Prior observations establish expiry and publication failure, not root cause.
- Fix the smallest proven cause. Add regression coverage for successful
  publication plus budget, stale-source, partial-write and unavailable-input
  behavior wherever affected. Do not manually rewrite cache timestamps or
  force maintenance to conceal a scheduling fault.
- Run owning Worker checks, generated-source/type guards and release dry gates.
  Deploy through the guarded production wrapper, with no migrations unless
  a separate reviewed need and authorization are established.
- Observe natural publication, then independently verify healthy exact source,
  fresh public plan/model data, authenticated admin data and rendered graphs.
  Close the presentation's remaining live-data gate, record the result and
  retire this plan only when those checks pass.
