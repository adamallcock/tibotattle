---
title: Milestone 5 Shared-Pool Contamination Decision
date: 2026-07-23
type: decision-record
status: accepted
---

# Milestone 5 Shared-Pool Contamination Decision

## Decision

**Proceed, while retaining the overall `non_identifiable` verdict.**

The system now preserves every adjacent provider snapshot interval—including repeated percentages—then reports signed, interval-aware residuals without changing local API-priced cost or provider observations. Controlled, uncontrolled, and unknown intervals remain separate. Residual flags name competing explanations and never select “other device,” “missing logs,” “display delay,” model routing, or provider accounting as a detected cause.

The live dataset has no strict controlled reference intervals, so its provisional `$1,886.697180725` API-price-equivalent capacity statistic is used only for the declared 0.75x/1x/1.25x sensitivity view. It is not promoted into a quota-capacity claim.

## Source-data improvement

The M1 transition stream intentionally collapsed repeated integer percentages. That was correct for boundary inference but hid local cost accumulated while the display stayed unchanged. The miner now emits an additive compact `snapshotIntervals` stream before collapse while preserving the original `transitions` semantics used by M1 and M2.

On the fixed historical interval from `2026-07-21T17:06:03.000Z` through `2026-07-23T16:15:40.974Z`:

- 20,195/20,195 retained usage events were standard-API priced;
- 35,181 fork-replay events were excluded;
- 19,977 adjacent snapshot intervals were recovered;
- 19,693 had zero displayed movement;
- 195 had positive displayed movement;
- 89 had negative displayed movement;
- the original collapsed transition count remained 284.

Indexed cumulative-cost and tool-event bounds reduced the live remine from an interrupted quadratic path to 7.6 seconds. The compact additive interval schema reduced its derived artifact from about 70 MB to about 28 MB without removing any interval.

## Residual model

For each interval, the report retains:

- displayed before/after percentage and delta;
- standard-API-priced local cost and usage-event count;
- model mix, aggregate coverage state, concurrency evidence, pricing provenance, and reset classification;
- a predicted percentage delta conditional on the selected capacity assumption;
- an observed-delta interval representing the difference of two integer display bins;
- a signed residual interval and center;
- evidence flags and non-causal hypotheses.

The report includes separate views for control state, coverage, negative deltas, reset groups, unexplained movement, explained-movement measurability, capacity sensitivity, residual change points, structural model/pricing/plan/reset changes, stale-display catch-up episodes, and official daily-bucket anomaly signals.

Official daily buckets are never used as an interval denominator, correction, rescaling factor, or backfill. A synthetic invariance test proves that changing them affects only `dailyBucketSignals`, not interval rows or summary residual arithmetic.

## Synthetic validation

Fixtures cover:

- injected other-surface/device usage versus missing local events;
- a stale snapshot followed by a catch-up jump;
- plan, reset, model-mix, and price-card changes;
- a genuine residual/capacity change candidate;
- ordinary bounded noise that must not trigger a change point;
- strict separation of controlled, uncontrolled, and unknown views;
- a completed experiment with local cost and no displayed movement;
- deterministic serialization and stable-identifier redaction;
- daily-bucket invariance;
- repeated snapshot preservation in the transition miner.

All 58 repository tests pass with zero failures and zero skips. Syntax checks pass for every source module.

## Live report

The live report combines the 19,977 historical adjacent intervals with two append-only contaminated experiment intervals:

- overall verdict: `non_identifiable`;
- strict controlled reference: 0 intervals (8 required by policy);
- control state: 19,979 unknown, 0 controlled, 0 uncontrolled;
- window-interval API-priced sum: `$4,565.320761099985`; this is not unique spend because simultaneous limit windows can repeat the same local activity;
- positive local cost with zero displayed movement: 19,359 intervals;
- displayed movement without retained local cost: 19 intervals;
- negative displayed deltas: 89 intervals;
- large observation gaps: 27 intervals;
- residuals outside the integer-display interval under the provisional point sensitivity: 76 intervals, all with the local price proxy exceeding displayed movement;
- explained movement: not measurable because capacity/control remain non-identifiable; intervals not flagged unexplained are not relabelled explained;
- residual change-point test: not flagged (largest mean shift `0.011285117135` percentage points versus a `0.5`-point threshold);
- structural confounders: 6,489 model-mix changes, 45 reset boundaries, 12 plan/limit/window changes, and one price-card change;
- stale-display catch-up candidates: zero because historical provider snapshot age is unavailable rather than assumed stale;
- daily-bucket anomaly signals: two, both labelled lagging-only.

The two experiments each show API-priced local activity and zero displayed movement, but both remain unknown because another Sol rollout was present. They are not pooled into a controlled reference.

## Reproducibility, privacy, and storage

Two in-memory reruns were byte-identical and matched the saved artifact exactly. The current normalized report SHA-256 was checked during validation, and output files are mode `0600`.

The contamination artifact contains no prompts, responses, session IDs, working directories, repository paths, filenames, call IDs, tool arguments, or stable experiment IDs. It uses deterministic interval ordinals and safe aggregate classifications only.

Artifacts:

- `.usage-monitor/transitions-v0.3-m5.json` — additive compact adjacent-interval source; the original M1 artifact is untouched;
- `.usage-monitor/contamination-v0.3.json` — deterministic machine report;
- `.usage-monitor/2026-07-23-contamination-report.md` — concise human report.

The current parser pathway now writes `.usage-monitor/transitions-v0.3.1.json`, `.usage-monitor/inference-v0.3.1.json`, and `.usage-monitor/contamination-v0.3.1.json` by default, with matching versioned reports. This protects the frozen Milestone 1 file and includes the explicit explained-movement boundary. The packaged `contamination` script invokes this pathway directly.

## Interpretation boundary

The live residual distribution rejects a clean causal interpretation; it does not establish OpenAI's hidden allowance, prove another-device usage, or identify a model/tool multiplier. Milestone 6 may test tool mechanisms, but every paired probe must retain the Milestone 4 no-concurrency gate and can end `inconclusive` when a clean comparison is unavailable.
