---
title: Seven-Day Quota Calibration Goal
date: 2026-07-24
type: plan
status: complete
---

# Seven-Day Quota Calibration Goal

## Objective

Turn the retained local token ledger and provider-displayed seven-day percentage into two auditable outputs:

1. a cost-accounting model that minimizes error when predicting later displayed quota movement from earlier observations; and
2. a reset-by-reset series estimating the API-price-equivalent value of the displayed seven-day allowance.

The output is a local behavioral calibration, not a claim that OpenAI exposes or prices a cash-denominated subscription allowance.

## Work plan

1. Preserve Standard API pricing as the base ledger and compare four accounting bases: unweighted Standard API cost, captured-speed lower bound, captured-speed midpoint, and captured-speed upper bound.
2. Keep account, plan, provider, limit, and window identities in every result. Retain slot as observed metadata while allowing a clearly labelled continuity view across the historical secondary-to-primary slot rename.
3. Select only monotonic seven-day transitions with retained usage, complete elapsed-time coverage, and no pricing or attribution warning.
4. Collapse reset timestamps only within the existing two-second duplicate tolerance and never across account or plan partitions. Do not merge the moving/high-churn `codex_bengalfox` family into the fixed `codex` series.
5. For every reset and accounting basis, fit a robust cost-per-percentage gradient on the earlier 70% of unique displayed percentage boundaries and score it on the later 30%. Report holdout MAE and signed bias in percentage points.
6. Choose the preferred accounting basis by aggregate holdout error across qualifying resets. Do not choose a model from in-sample fit.
7. Refit each qualifying reset on its full observed span to produce its descriptive API-price-equivalent seven-day value and a central 80% pairwise-slope range.
8. Add a prospective-style check: predict each reset using the median value from the prior three qualifying resets in the same continuity track, then report the resulting movement error separately from the per-reset fit.
9. Publish a week/reset table with value, uncertainty, coverage, speed evidence, holdout error, and prior-week prediction error. Visualize the week-by-week value and observed-versus-predicted quota movement.
10. Preserve the measurement boundary: whole-percentage displays, provider lag, unobserved shared-surface activity, historical account ambiguity, and unknown speed state remain visible limitations.
11. Add a reusable CLI command, deterministic JSON/Markdown artifacts, tests for model selection and time-split validation, and a portable technical HTML report.
12. Validate the key calculations independently, run the full test suite, and verify the final report at desktop and narrow widths.

## Completion criteria

- The selected accounting basis has a saved out-of-sample score and is compared with the Standard API baseline.
- Each qualifying reset has an exact lookup row for its estimated seven-day API-price-equivalent value and uncertainty range.
- Prior-week predictions are kept distinct from per-reset descriptive fits.
- The report never labels the estimated value as an identified provider allowance or subscription cash value.
- Tests and the portable-report verifier pass.

## Completion receipt

- Selected accounting basis: captured-speed lower bound.
- Qualifying reset windows: 14.
- Median seven-day API-price-equivalent value: $1,878.75.
- Central 80% reset-to-reset range: $1,640.96–$2,280.38.
- Pooled chronological holdout MAE: 2.16 percentage points, versus 2.25 for unweighted Standard API cost.
- No-look-ahead prior-reset MAE: 3.95 percentage points across 750 boundaries in 12 resets.
- Validation: 164 tests passed; portable report passed desktop and narrow browser verification.
