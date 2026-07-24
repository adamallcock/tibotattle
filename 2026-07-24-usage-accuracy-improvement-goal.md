---
title: Usage Prediction Accuracy Improvement Goal
date: 2026-07-24
type: plan
status: complete
---

# Usage Prediction Accuracy Improvement Goal

## Objective

Comprehensively improve the local-only usage monitor so API-price-equivalent accounting predicts the provider-displayed Codex seven-day quota as accurately and honestly as the available evidence permits.

The project must continue using Standard OpenAI API pricing as its stable workload normalization. It must not substitute the Codex subscription rate card, claim that an API-price-equivalent value is a provider cash allowance, or introduce multi-user/external log collection.

## Frozen baseline

- 14 qualifying reset windows.
- $1,878.75 median API-price-equivalent seven-day value.
- 2.16 displayed percentage-point pooled same-reset chronological holdout MAE.
- 3.95-point no-look-ahead prior-reset MAE.
- July 3 and July 16 are the first high-error audit targets.
- The existing conservative non-identifiability report remains intact.

## Workstreams

### 1. Online within-reset calibration

- Use prior completed resets only as the initial estimate.
- Refit after candidate evidence checkpoints: at least eight transitions and 5, 10, 15, and 20 displayed percentage points.
- Score each checkpoint only on later observations.
- Select the earliest checkpoint that materially improves prediction.
- Emit an explicit `not_yet_calibrated` state when the current reset lacks evidence.

### 2. Accounting-regime detection

- Test, but do not assume, a July 9, 2026 boundary.
- Compare robust rolling-window and persistence/change-point rules.
- Prevent older regimes, banked resets, moving-limit families, account/plan changes, slot renames, and policy epochs from contaminating the current forecast.
- Require persistent evidence before declaring a changed accounting regime.

### 3. High-error reset audits

- Audit July 3 and July 16 first.
- Inspect pseudonymous account/plan evidence, Standard/Fast state, model and token-component mix, scheduled tasks, subagents, tools, snapshot gaps/age, reset behavior, and plausible missing Work/Workspace Agent/Excel/Codex Cloud/image-generation activity. Ordinary Chat is excluded and Spark is separate under the subsequently verified provider policy.
- Quantify each reset's contribution to aggregate error.
- Add exclusions or model features only for verified, repeatable mechanisms.

### 4. Prospective coverage

- Support continuous privacy-minimized collection during study periods.
- Refresh account/plan scope at startup and immediately after account switches.
- Preserve exact model, speed, reset identity, provider snapshot time, and snapshot age.
- Add low-cardinality activity markers that distinguish excluded ordinary Chat from included Work, Workspace Agents, Excel, Codex Cloud/other-device, Work Voice task activity, image generation, separate-limit Spark, quiet periods, and controlled experiments.
- Never retain prompts, responses, filenames, URLs, credentials, raw emails, or provider account identifiers.

### 5. Display-lag candidates

- Compare no delay, one event, 5 seconds, 30 seconds, and 60 seconds.
- Use the same chronological holdout rule across eligible resets.
- Adopt a lag model only when it improves prediction, not merely internal interval consistency.

### 6. Controlled experiments

- Run only when quota headroom, quiet-period, contamination, and cost gates pass.
- Compare matched Standard and Fast workloads across relevant models.
- Compare cached and uncached input, input-heavy and output/reasoning-heavy workloads, and selected tool-heavy/tool-light cases.
- Require before/after provider snapshots, complete local receipts, fixed abort limits, and preserved unsuccessful attempts.

### 7. Constrained accounting models

- Begin with a small non-negative regularized model over cached input, uncached input, output/reasoning, model family, and captured Fast state.
- Keep Standard API-priced dollars visible as the stable comparison series.
- Use nested chronological validation or untouched future resets.
- Reject models whose gains are only in-sample or concentrated in one reset.

### 8. Forecast selection

- Compare prior-reset window lengths, recency weighting, regime-specific priors, account/plan partitions, and current-reset updates.
- Report incremental MAE, signed bias, sample coverage, stability, and protected-slice regressions against the simple Standard API baseline.

### 9. Provider-side crosschecks

- Retain app-server quota percentages, reset metadata, and snapshot age.
- Compare official account daily totals and visible Work/Codex analytics where available.
- Price hosted tools only from exact provider-reported billable units.
- Keep shared/account-level aggregates unallocated without a defensible join.

### 10. Product and reporting surface

- Add the selected model and calibration state to the CLI and deterministic owner-only artifacts.
- Provide a plain-language view showing the best current seven-day value, expected prediction error, whether the current reset has calibrated, and why confidence is high or low.
- Keep pairwise mechanics and technical uncertainty available in the audit layer rather than the default explanation.
- Update README, coverage gaps, tests, technical report, and source notes.

## Prospective acceptance targets

- Same-reset later-period MAE below 1.5 displayed percentage points.
- Prior/regime forecast MAE below 2.5 points.
- Absolute signed bias below 0.5 points.
- At least 90% prospective account, speed, and provider-snapshot-age coverage during study periods.
- Stable performance across at least three newly completed qualifying reset windows.
- No material protected-slice regression versus Standard API cost.

These are acceptance goals, not promises. They may expose an irreducible provider-observability floor.

## Validation and stopping rule

Completion requires independent calculation checks, synthetic regression tests, no-look-ahead tests, account/plan/reset isolation, privacy scans, the full test suite, and desktop/mobile report verification.

If the thresholds cannot be reached, the project must document:

- the empirical accuracy floor;
- which residuals remain unobservable locally;
- the smallest honest prediction interval;
- which proposed features or experiments failed to improve untouched data; and
- why further local-only work is unlikely to provide material accuracy gains.

The goal is complete only when the feasible implementation, experiments, artifacts, tests, and validated report are finished, or an evidence-backed stop decision satisfies this rule.

## Completion

Completed under the evidence-backed accuracy-floor stopping rule. The implementation and frozen results are in `weekly-calibration-v0.2`; the requirement-by-requirement decision is [Usage Prediction Accuracy Floor Decision](./2026-07-24-usage-accuracy-floor-decision.md).

The historical targets remain unmet, so no extra component, lag, regime, or early-reset correction is shipped. The independent verifier passes 467 checks, the full suite passes 171 tests, and the portable technical report passes source interaction plus 1440 px and 390 px browser verification.
