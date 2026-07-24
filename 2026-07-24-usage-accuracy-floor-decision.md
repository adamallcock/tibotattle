---
title: Usage Prediction Accuracy Floor Decision
date: 2026-07-24
type: decision-record
status: complete
---

# Usage Prediction Accuracy Floor Decision

## Decision

Ship the local-only `weekly-calibration-v0.2` monitor as an explicitly uncertain behavioral calibration and stop adding historical correction parameters.

Use **$1,878.75 of Standard-API-price-equivalent work** as the current median value of 100% of the displayed Codex seven-day quota. Retain the captured-speed lower-bound ledger because it reduces same-reset held-out error from 2.25 to 2.16 displayed percentage points. Keep the rolling median of up to three completed resets as the live start-of-reset forecast.

Do not adopt any tested early in-reset update, short display-lag correction, July 9 epoch reset, persistent-shift forecast, or multi-component multiplier. Their untouched later-period evidence is worse, too small, or too contaminated.

This is not a provider cash allowance, invoice value, private rate card, or identified token cap.

## Reproduced baseline

The frozen 2026-07-24 input reproduces exactly:

| Measure | Reproduced value |
| --- | ---: |
| Qualifying reset values | 14 |
| Median seven-day API-price-equivalent value | $1,878.752157 |
| Selected same-reset holdout MAE | 2.160749 pp |
| Selected same-reset holdout bias | -1.745481 pp |
| Prior-reset forecast MAE | 3.953951 pp |
| Prior-reset forecast bias | -1.223901 pp |

The independent verifier recomputed these values and passed 467 consistency, no-look-ahead, checkpoint-ordering, and partition-isolation checks.

## Candidate decisions

### Early within-reset updates are rejected

Every candidate is fitted only from the prefix through its checkpoint and scored on later boundaries. The corrected online estimate can use only the early-to-full ratio from the prior three completed resets.

| Display checkpoint | Updated MAE | Comparable prior MAE | Relative improvement | Decision |
| ---: | ---: | ---: | ---: | --- |
| 5 pp | 11.74 pp | 3.91 pp | -200.2% | Reject |
| 10 pp | 8.57 pp | 3.92 pp | -118.3% | Reject |
| 15 pp | 5.22 pp | 4.24 pp | -23.2% | Reject |
| 20 pp | 6.60 pp | 4.35 pp | -51.6% | Reject |
| 30 pp | 5.99 pp | 4.01 pp | -49.4% | Reject |
| 40 pp | 5.83 pp | 3.50 pp | -66.4% | Reject |
| 50 pp | 5.61 pp | 3.54 pp | -58.5% | Reject |
| 60 pp | 3.59 pp | 3.06 pp | -17.4% | Reject |

The current state is therefore `prior_only_online_update_rejected`, never a falsely precise “calibrated” state.

### Short display lag is rejected

On the same 14 resets and 275 later-period boundaries, no delay scores 2.253 pp Standard-ledger MAE. One event and 5, 30, and 60 seconds score 2.423, 2.424, 2.425, and 2.424 pp. Lag envelopes reduce some contradictions in a boundary model, but they do not improve this prediction task.

### Forecast and regime rules remain conservative

On the ten resets forecastable by every candidate:

| Forecast rule | MAE | Bias | Decision |
| --- | ---: | ---: | --- |
| Rolling median of up to three prior resets | 3.726 pp | -0.512 pp | Select for the next reset |
| Recency-weighted mean, 0.5 decay | 3.534 pp | -0.710 pp | Reject: 5.1% gain is below 10% and bias worsens |
| Expanding median | 3.808 pp | -2.942 pp | Reject |
| Persistent 15% shift after two resets | 4.176 pp | +0.029 pp | Reject |
| Rolling median of two prior resets | 4.793 pp | -0.224 pp | Reject |
| Recency mean plus prior forecast-ratio correction | 5.534 pp | -0.532 pp | Reject |
| Rolling-three plus prior forecast-ratio correction | 6.709 pp | +0.128 pp | Reject |

Resetting forecast history at July 9 improves MAE by only 2.5% on six later resets and worsens absolute bias from 1.71 to 2.06 pp. It does not meet the 10% gain and non-worsening-bias rule, so July 9 remains a product/measurement hypothesis rather than an adopted accounting epoch.

## High-error reset audit

The reset first observed July 3 contributes 30.4% of all same-reset holdout absolute error. July 16 contributes another 16.0%; together they contribute 46.5%.

- July 3 has only 3.5% known speed in the transition evidence. Its full local-span rescan includes 15,675 priced events: 76.3% ordinary extension/IDE and 23.7% subagent. No scheduled-task surface is present.
- July 16 has 72.0% known speed in the transition evidence. Its full local-span rescan includes 18,387 priced events: 71.3% extension/IDE, 27.6% subagent, 0.9% scheduled task, and 0.2% CLI exec.
- Subagent and scheduled-task work is already present in Standard API-priced cost. Neither span exposes provider-billed hosted-tool units.
- Model, cached/uncached input, output/reasoning, tool class, and captured speed remain separable in the audit JSON. No stable omitted local task mechanism explains both outliers.
- ChatGPT Work, Workspace Agents, ChatGPT for Excel, Codex Cloud without a local rollout, other-device Codex, and image-generation activity remain retrospectively unbounded. Ordinary Chat and ordinary Chat Voice are excluded from this shared pool. Work Voice task activity is included, connected Voice time has a separate meter, and Spark has a separate demand-adjusted limit.

## Why the component model stops at the pre-fit gate

The requested candidate has at least five feature groups: cached input, uncached input, output/reasoning, model family, and captured Fast. The predeclared minimum is five independent reset values per feature group, or 25 reset values. Only 14 exist.

The two largest errors contribute 46.5% of the objective, historical account and snapshot-age coverage are both 0%, speed coverage is 38.4%, and no controlled experiment result exists. Under these conditions, a non-negative regularized fit could still produce coefficients, but untouched evidence could not distinguish a reusable provider mechanism from memorization of July 3 and July 16. The low-dimensional captured-speed alternative is retained because it has a real 4.1% chronological holdout gain; further component multipliers are rejected before fitting.

## Provider and experiment cross-checks

- Account-level local/provider daily-token ratios improve from 1.765 before July 9 to 0.901 for July 9–15 and 0.924 for July 16–24. This is useful corroboration of a measurement/account boundary, but the old local corpus is not account-matched and cannot identify a quota formula.
- Prospective same-account daily reconciliation is not yet observed.
- Thirteen controlled-workload attempts are preserved: nine preflight refusals, two dry runs, and two completions with explicit stops. Zero are controlled. The completed attempts had concurrent local activity and exceeded measured API-price budgets, so they cannot identify cache, effort, model, tool, or speed multipliers.
- App-server quota/reset metadata, official daily totals, visible Work/Codex analytics, and provider billable tool-unit handling remain separate cross-checks. Client tool calls are never converted into provider units without exact typed evidence.

## Accuracy floor and honest uncertainty

The historical local-only floor is currently:

- 2.16 pp MAE for a within-reset model trained on the earlier 70% and scored on the later 30%; and
- 3.95 pp MAE for a forecast made only from earlier completed resets.

The prior-reset forecast has an empirical 80th-percentile absolute error of **7.39 pp** and a 90th-percentile absolute error of **10.08 pp**. The smallest honest default uncertainty statement is therefore: “historically, four out of five individual predictions landed within about ±7.4 displayed points.” This is an empirical error envelope, not a confidence interval or guarantee.

The requested targets are not met: same-reset MAE is above 1.5, prior-reset MAE is above 2.5, absolute bias is above 0.5, historical account/snapshot-age coverage is 0%, speed coverage is 38.4%, and zero of three required new fully covered resets exist.

Further historical fitting is stopped because the remaining residual combines integer display censoring, provider update timing, missing included surfaces, unresolved accounts/plans, and contaminated experiments. Ordinary Chat is no longer an unidentified residual source. The remaining mechanisms are not recoverable from the frozen local corpus by adding parameters.

## Prospective learning trigger

The implementation now has the evidence needed for the next study rather than another retrospective refit:

- continuous owner-only collector and read-only app-server refresh;
- Keychain-HMAC account scope and dated plan timeline;
- exact speed/model/reset evidence when present and explicit unknowns otherwise;
- snapshot-age quality gates;
- low-cardinality `mark-activity` boundaries that distinguish excluded ordinary Chat from included Work, Workspace Agents, Excel, Codex Cloud/other-device, Work Voice task activity, and image generation while separating Spark; and
- abort-limited experiment manifests with quiet-period, headroom, before/after, cost, tool, and contamination gates.

Reopen model selection only after three new qualifying resets reach at least 90% account, speed, and snapshot-age coverage. Compare against the frozen v0.2 baseline without changing its historical receipt.

## Completion receipt

| Goal item | Evidence and decision |
| --- | --- |
| 1. Freeze baseline | Exact `baselineReceipt: reproduced`; July 3/16 contributions retained. |
| 2. Online estimator | 5–60 pp prefix-only checkpoints implemented; all rejected on later data; explicit prior-only state. |
| 3. Regime detection | July 9 fixed boundary and persistent 15%/two-reset rule tested chronologically; neither adopted. |
| 4. High-error audit | Exact reset error shares plus model/component/speed/tool and independent local-surface rescans; unobserved surfaces remain explicit. |
| 5. Prospective coverage | Collector/account/plan/speed/age support retained; privacy-safe activity marker command added. |
| 6. Lag models | No delay, one event, 5/30/60 seconds compared on identical holdouts; no delay selected. |
| 7. Controlled experiments | Existing bounded attempts audited; unsafe/contaminated outcomes preserved and not used. |
| 8. Constrained components | Pre-fit evidence gate rejects an underidentified five-group model; captured-speed low-dimensional alternative retained. |
| 9. Forecast selection | Rolling two/three, expanding, persistent regime, fixed July 9, and online candidates compared without future reset use. |
| 10. Provider cross-checks | App-server, daily totals, Work/Codex UI, and exact hosted-tool-unit boundary integrated. |
| 11. Product/reporting | v0.2 CLI/artifacts, `mark-activity`, README, gaps register, technical HTML, and plain-language Markdown updated. |
| 12. Validation | 171 tests pass; 467 independent checks pass; privacy scan is clean; HTML source interaction plus 1440 px and 390 px QA pass. |

The conservative non-identifiability result remains intact. This decision completes the feasible local-only historical program by documenting the accuracy floor and the exact prospective evidence that would justify reopening it.
