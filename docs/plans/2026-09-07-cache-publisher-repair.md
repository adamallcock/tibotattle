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

Alternate optional priority by UTC minute: publish the same validated, complete
cached cohort before account reconstruction on even minutes; reserve odd minutes
for reconstruction before preview publication. If an early preview is unavailable,
retry after reconstruction but before daily reconciliation. This prevents a large
cohort with a late missing input from repeatedly consuming reconstruction's
admission budget. Preserve lifecycle priority, the single invocation budget,
source-epoch fences, atomic writes and the existing 55-minute refresh interval.
Record content-free phase timings/counters so deadline deferrals are visible.

Local proof: the two regressions fail against the original ordering (expired
preview retained; no early/retry read), then all 11 scheduler tests pass with
the repair. All 68 cache, atomic publication, preview and account-warmer tests
pass. Full checks on `f934bee4` passed 804 Worker tests, 202 operations tests,
TypeScript, staging/default/production dry deployments, 20 preflight tests,
documentation and architecture checks. Independent review identified the
large-cohort admission risk; the follow-up preserves the original odd-minute
fixed setup receipt (49 statements, 46 primary and 3 ledger), keeps the unchanged
900-query ceiling, and covers both priority paths. Final qualification and
natural live recovery remain pending; no production repair is claimed yet.

`d46084ed` then passed all 805 Worker tests and guarded deployment. Natural
publication at 16:18:35 UTC refreshed the preview after 16,331ms and 27 phase
statements; independent public/admin response and rendered plan/model checks
passed. A concurrent Intel website deployment at `9ae9be5c` replaced that
scheduler afterward. Its two commits are now merged locally; coordination is
authorized and the next deployment must preserve both changes.

The independently checked admin growth-history cache also expired: generation
13:20:23 UTC, 227,912 bytes, latest gauge 13:20:22 UTC, HTTP 503. Its admission is
after the same exhausted deadline. Give gauge capture and history refresh an
early opportunity after the even-minute allowance preview, keep odd-minute
reconstruction intact, retain late fallback and attempt each cache at most once.
Preserve their existing shape validation, 55-minute cadence and two-hour limit.
Combined source qualification and natural metrics recovery remain open.

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
