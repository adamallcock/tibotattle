---
title: Seven-Day Quota Calibration Source Notes
date: 2026-07-24
type: research
status: complete
---

# Seven-Day Quota Calibration Source Notes

## Reporting job

- Question: how closely can locally calculated API-priced activity predict provider-displayed seven-day quota movement, and what reset-by-reset value does that imply?
- Audience: technical.
- Decision use: improve the local accounting model and monitor whether the apparent seven-day conversion changes over time.
- Scope: locally retained Codex transitions from June 11 through July 24, 2026; fixed `codex` 10,080-minute family only.
- Success criterion: chronological holdout scoring, a no-look-ahead prior-reset check, explicit negative-result retention for lag/regime/online candidates, exact reset rows, empirical forecast error, and no claim that the result is an identified provider cash allowance.

## Technical-report structure map

1. Title: `Calibrating the Seven-Day Codex Limit`.
2. Technical summary: direct value range, selected accounting basis, within-reset holdout, prior-reset validation, and the official included/excluded/separate meter boundary.
3. Key findings with visual evidence: reset value, measured versus calculated movement, candidate error comparison, forecast-rule validation, rejected online checkpoints, rejected delay corrections, provider epoch cross-checks, and reset error concentration.
4. Scope, data, and definitions: explicit pricing basis, observation grain, value definition, and error definitions.
5. Model and validation method: selection, quality gates, fit, and no-look-ahead procedure.
6. Limitations and robustness: integer display, lag, account ambiguity, missing surfaces, and descriptive uncertainty.
7. Recommended next steps: three fully covered prospective resets, controlled speed/cache tests, privacy-safe surface markers, and persistent monitoring.
8. Further questions: residual mechanisms and temporal change.

## Chart map

| Section | Question | Family and type | Fields | Supported claim | Palette policy |
| --- | --- | --- | --- | --- | --- |
| Reset value | How does the API-price-equivalent value vary across resets? | Trend, multi-series line | first observed time, value, pairwise p10/p90 | The series centers near $1.9k but varies materially by reset | Hard two-root cap plus neutral sensitivity lines |
| Calibration | Does calculated later movement follow measured later movement? | Comparison over ordered time, two-series line | reset time, observed movement, predicted movement | Selected cost accounting follows held-out movement within about two percentage points on average | Hard two-root cap with direct legend |
| Candidate comparison | Which accounting basis predicts best? | Comparison, sorted bar | accounting basis, pooled holdout MAE | Conservative captured-speed weighting narrowly beats unweighted Standard API cost | Single-root preferred |

The two line charts answer different questions—temporal value stability versus prediction agreement—and therefore remain separate. Exact tables are used for forecast candidates, checkpoint rejection, display lag, provider epochs, experiment outcomes, error concentration, reset values, and accounting candidates because those sections require precise lookup rather than another decorative chart.

## Data-quality checks

- Grain: one unique displayed percentage boundary inside one exact seven-day reset identity.
- Completeness: all retained candidate boundaries require finite cumulative Standard and selected cost; the Standard path is complete for all 14 reported resets.
- Validity: monotonic quota increase, positive retained usage, full elapsed local coverage, and no pricing or attribution warnings.
- Reset integrity: two-second near-duplicate suppression never crosses account or plan partitions; `codex_bengalfox` is excluded.
- Stability: at least eight points, at least five displayed percentage points, at least six train pairs, at least two holdout points, and pairwise p10–p90 width no greater than the median value.
- Time travel: model selection uses earlier-70% to later-30% splits; prior-reset forecasts require earlier resets to be completed before the current reset begins.
- Forecast selection: every historical prequential forecast chooses its rule using only earlier common scored resets; a future-reset mutation test proves an earlier prediction is unchanged.
- Online checkpoints: each fit uses only the prefix through its checkpoint and is scored only on later boundaries. A correction can use only the prior three completed reset ratios.
- Lag candidates: no delay, one event, 5 seconds, 30 seconds, and 60 seconds use identical reset eligibility and chronological holdout scoring.
- Known limitation: historical account scope is unattributed and missing included-surface usage is unbounded. Ordinary Chat and ordinary Chat Voice are excluded; image generation uses the included general limit; Spark is a separate limit.

## Calculation validation

- Candidate selection is based on chronological holdout, not in-sample fit.
- Full-reset values are calculated only after the accounting basis is selected.
- Pooled holdout MAE is recomputed from all held-out boundary residuals; median-reset MAE is retained separately.
- Prior-reset pooled MAE is recomputed from all no-look-ahead prediction points rather than averaging reset averages.
- Percent values remain percentage points in the analysis and are not passed to a fractional-percent renderer.

## Omitted views

- No confidence band is drawn because the pairwise p10/p90 slopes are dependent empirical sensitivity values, not inferential intervals.
- No calendar-week aggregation is imposed because more than one reset can begin within a week; exact reset rows are the honest grain.
- No account comparison is shown because historical rollout records are unattributed.
- No causal provider-policy claim is made from temporal movement.
- No multi-component multiplier model is fitted: 14 reset values are below the predeclared 25-reset minimum for five feature groups, the two largest errors contribute 46.5% of total error, account and snapshot-age coverage are zero historically, and there is no controlled experiment result.
- No early online correction is shipped because every 5–60 point candidate worsens comparable later prediction.

## Reproducibility

- Input transitions: `.usage-monitor/transitions-simple-history-2026-06-11-to-2026-07-24-v0.3.2.json`
- Calibration output: `.usage-monitor/weekly-calibration-v0.2.json`
- Human-readable calculation report: `.usage-monitor/2026-07-24-weekly-calibration-v0.2.md`
- Provider cross-check: `.usage-monitor/provider-crosscheck-v0.1.json`
- Experiment ledger: `.usage-monitor/experiment-results.jsonl`
- Activity-marker implementation: `src/activity-markers.js`
- High-error reset surface audit: `.usage-monitor/weekly-calibration-high-error-audit-v0.1.json`
- Independent verification receipt: `.usage-monitor/weekly-calibration-verification-v0.1.json`
- Accuracy-floor decision: `docs/decisions/2026-07-24-usage-accuracy-floor-decision.md`
- Provider coupling policy: `https://learn.chatgpt.com/docs/pricing` (checked July 24, 2026)
- Reviewed public API: `src/reporting/index.js`
- Tests: `test/weekly-calibration.test.js`
- Canonical report artifact: `.usage-monitor/legacy-reports/2026-07-24-weekly-7-day-calibration-artifact.json`
- Portable report: `.usage-monitor/legacy-reports/2026-07-24-weekly-7-day-calibration-report.html`

Final QA: 173 repository tests passed; 467 independent calibration checks passed; portable report source interaction and responsive checks passed at 1440 px and 390 px.
