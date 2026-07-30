---
title: Simple Quota Gradient Source Notes
date: 2026-07-24
type: report
status: complete
---

# Simple Quota Gradient Source Notes

## Purpose

This is the supporting chart and metric map for the portable report `2026-07-24-simple-quota-gradient-report.html`. The report intentionally treats the simplest observable relationship as primary: Standard OpenAI API-priced local usage versus observed quota percentage consumption inside one reset identity.

## Source map

| Source | Role | Important fields |
|---|---|---|
| `.usage-monitor/transitions-simple-current-2026-07-24-v0.3.2.json` | Recent event/snapshot alignment through 2026-07-24 13:51:29 UTC | event time, reset identity, cumulative API-priced USD, quota used percent, component tokens, model/tier/tool evidence |
| `.usage-monitor/weekly-limit-simple-history-2026-07-24-v0.1.json` | Cross-reset slope history from the refreshed compact replay | median pairwise gradient, empirical pairwise p10–p90 envelope, eligible transitions, percentage span |
| `.usage-monitor/transitions-simple-history-2026-06-11-to-2026-07-24-v0.3.2.json` | Historical slot/window semantics | slot, window duration, first/last observation, transition count |
| `.usage-monitor/transitions-fast-diagnostic-2026-07-13-v0.3.2.json` | Targeted July 13 local replay | event time, Standard API-priced cost, quota snapshots, captured Standard/Fast state |
| `.usage-monitor/rolling-quota-history-2026-06-11-to-2026-07-24-v0.1.json` | Compact six-week rolling reconstruction from 218,627 weekly adjacent-snapshot intervals | trailing three-hour observed/cost-implied movement, exact UTC/Eastern endpoints, reset-specific gradient and quality |
| [Codex Resets](https://codex-resets.com/) and linked X posts | Approximate external reset-event calendar | announcement UTC, Eastern conversion, automatic versus banked classification, propagation language |
| OpenAI API pricing | Independent workload normalization | Standard input, cached-input, output, and model-specific prices |

## Chart contracts

### API-priced cost as quota is consumed

- Grain: observed quota transition within one exact weekly reset identity.
- X: quota percentage points consumed, rebased to zero.
- Y: cumulative Standard API-price-equivalent USD, rebased to zero.
- Series: observed quota and the selected reset's fitted median gradient.
- Decision: whether a locally priced workload tracks provider quota movement closely enough to estimate an empirical conversion gradient.

### Three-hour rolling quota movement

- Grain: exact hour endpoint, with a three-hour trailing window that never crosses a reset.
- X: ending UTC timestamp; tooltip and companion table expose the same endpoint in US Eastern time.
- Y: quota percentage points moved over the window.
- Series: observed quota movement and movement implied by rolling API-priced cost under the selected gradient.
- Decision: whether contemporaneous mismatches are large enough to investigate lag, shared-pool activity, speed tier, model, or tool mix.

### Six-week three-hour rolling history

- Analytical question: whether the observed-versus-cost-implied relationship shows recurring or regime-specific mismatches beyond the current reset.
- Family/type: highlighted multi-series time trend / native line chart.
- Grain and scope: hourly endpoints from 2026-06-13 through 2026-07-23 across 15 selected weekly reset identities and 218,627 scanned adjacent weekly snapshot intervals.
- Series: observed trailing three-hour quota movement and movement implied by Standard API-priced cost using that reset identity's own median pairwise gradient.
- Boundary treatment: explicit null breaks prevent lines from joining across reset identities; rolling windows never cross resets.
- Time readability: x-axis uses UTC chronology; tooltips include exact UTC and America/New_York endpoints, reset timestamp, fitted gradient, cost, and event count.
- Palette policy: hard two-root cap for observed versus expected, with reset breaks as non-color structure.
- Decision: preserve three hours for the stable historical view while using a shorter incident view to localize spikes.

### July 13 smoothing sensitivity and two-hour zoom

- Analytical question: whether shortening the three-hour window improves attribution of the July 13 Fast episode.
- Family/type: two-hour highlighted multi-series line plus an exact one-hour audit table and one-/two-/three-hour residual diagnostics.
- Comparison: observed movement versus raw Standard API-cost expectation and the expectation after applying captured Fast weighting.
- Result: Fast-weighted MAE is 2.74 pp at one hour, 2.03 pp at two hours, and 2.01 pp at three hours. The one-hour peak residual is 5.00 pp.
- Interpretation: the two-hour window retains nearly all three-hour stability while localizing the spike; one hour is more exposed to integer display lag.
- Palette policy: hard two-root cap plus neutral observed/reference styling; exact series names and tables provide non-color distinction.
- Decision: three-hour long history, two-hour incident zoom, one-hour audit detail.

### Three-hour rolling residual and AUC

- Grain: UTC hour, with the same overlapping three-hour trailing window.
- Residual: observed quota movement minus movement implied by Standard API-priced cost under the selected reset gradient.
- Signed AUC: trapezoidal integral of the residual in percentage-point hours; shows persistent direction of mismatch.
- Absolute AUC: trapezoidal integral of the absolute residual; shows total mismatch magnitude.
- Boundary: overlapping windows make both AUCs descriptive rather than additive usage attribution. Causal tests should use non-overlapping hourly or controlled event blocks.

### July 13 captured Fast comparison

- Fast segment: 2026-07-13 14:06:40–17:29:49 UTC (10:06:40 AM–1:29:49 PM EDT), 833 locally joined Fast events.
- Observed movement: weekly quota used 13% to 32%, or 19 percentage points.
- Standard API-priced workload: $39.998992, implying $210.52 per full quota if speed is ignored.
- Captured Fast sensitivity: 2.5× for `gpt-5.6-terra`, yielding $526.30 per full quota.
- Later reference: 2026-07-13 22:19:37–23:59:57 UTC, 362 Standard plus 71 unknown events, five quota points, and $538.01 per full quota.
- Decision: the Fast weighting reconciles the episode to within about 2.2% of the later local reference and is the leading explanation for the apparent AUC difference. This is not proof that the multiplier is stable across models or policy epochs.

The July 13 one-hour display jump from 17% to 29% lands in the hour ending 1 PM EDT even though the API-priced Fast workload is distributed across neighboring hours. This is why shortening the window does not by itself correct underestimation: speed weighting addresses the systematic conversion difference, while two-to-three-hour smoothing addresses timestamp/display lag.

### Slot/window semantics

- `primary` and `secondary` are positional provider keys, not stable quota meanings.
- `windowDurationMins=300` means five hours; `windowDurationMins=10080` means seven days.
- The retained history contains primary/300 and secondary/10080 before July 12, then primary/10080 after the five-hour series disappears.
- Decision: group by slot and duration, but label user-facing series by duration.

### Community reset calendar

- UTC is canonical; July is EDT (UTC−4) locally.
- Allow a ±2-hour matching window for propagation and regional/account rollout.
- Banked resets are user-applied credits, not automatic quota discontinuities.
- The July 13 banked-reset post was at 18:29:31 UTC (2:29:31 PM EDT), after the Fast run, and the local reset identity continued afterward.

### Gradient and pairwise p10–p90 envelope by reset

- Grain: quality-qualified reset identity.
- X: first observation time.
- Y: Standard API-price-equivalent USD per 100 quota percentage points.
- Series: median pairwise gradient, 10th percentile, and 90th percentile.
- Decision: whether the relationship changes across reset periods beyond within-series uncertainty.

The p10–p90 lines are an empirical disagreement envelope over dependent pairwise slopes. They are not confidence intervals, standard errors, or calibrated probability bounds for a hidden provider allowance.

## Interpretation boundary

The gradient is a descriptive conversion between two observed series. It is not an identified provider allowance because Standard API price is a counterfactual normalization and unobserved shared-pool usage can move the quota independently. Captured Codex Fast weighting is kept separate from API Priority/Flex pricing. Historical account labels are not needed for isolated reset series, but prospective pseudonyms remain a collision guard when accounts overlap with indistinguishable reset metadata. The brief Pro 5x episode still has no dates, so the July 13 plan variant cannot be resolved retrospectively.

## Reproduction

```bash
npm run build:rolling-history
npm run build:simple-report-data
node $HOME/.codex/plugins/cache/openai-curated-remote/data-analytics/0.2.8-13ceeea1f599/skills/build-report/scripts/deliver_portable_artifact.mjs \
  --input 2026-07-24-simple-quota-gradient-artifact.json \
  --output 2026-07-24-simple-quota-gradient-report.html
```
