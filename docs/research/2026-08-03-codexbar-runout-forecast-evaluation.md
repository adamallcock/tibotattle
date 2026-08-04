---
title: CodexBar Weekly Allowance Run-out Forecast Evaluation
date: 2026-08-03
type: research
status: completed
---

# CodexBar Weekly Allowance Run-out Forecast Evaluation

## Decision

**Build a thin, evidence-gated local forecast in TiboTattle; do not fork or
repackage CodexBar.**

The visual feature is straightforward.  A trustworthy numerical probability is
not.  TiboTattle already retains much of the needed local quota and reset
history, but a forecast must be strictly account-scoped, tied to comparable
weekly reset windows, and backtested before it says "80% risk".

For an immediate personal status-bar answer, use CodexBar.  For a
privacy-preserving TiboTattle feature with provenance and a user-facing
explanation, implement the bounded version described below.

## Implementation outcome — 2026-08-03

**Tier 1 is now implemented.** It is intentionally narrower than the later
historical-curve proposal in this report:

- It requires at least two fresh, pseudonymous account-scoped app-server
  observations on the exact same current weekly reset/slot/plan track.
- It computes the median adjacent increase in provider-reported percentage
  points per hour, then exposes either an ETA before reset or the restrained
  result that the allowance should last to reset.
- It withholds the card for an unattributed account, another source type,
  stale current observation, reset mismatch, backwards movement, ambiguity,
  implausible pace, or insufficient observations.
- The dashboard receives a fixed public DTO with no account key, raw quota
  record, API-cost estimate, token claim, or probability. The macOS app hosts
  this same local dashboard surface.

The forecast is collected with the normal local refresh path and uses the
collector ledger rather than the older `historical_unattributed` cache
timeline. The replay-safe cache has an additional account-scoped projection
for sources that can supply that scope, but the ordinary indexed Codex log
scanner cannot, so it is not used to fill a gap with guessed identity.

The visible copy is deliberately modest: “At this pace: reaches weekly
allowance …” or “At the recent pace, the weekly allowance should last to
reset.” It does not claim run-out risk. Numeric probability, historical
curves, and P20/P50/P80 ranges remain future work subject to the validation
gates below.

## What the CodexBar feature actually predicts

The screenshot combines three different concepts:

- **remaining allowance**: the provider-reported percentage remaining in the
  current weekly window;
- **pace deficit/surplus**: actual use minus expected use at this point in the
  window (linear pacing, or a learned historical weekly curve); and
- **run-out forecast**: an estimate of whether observed historical demand,
  shifted to start at today's quota position, crosses 100% before reset.

This is an allowance-availability forecast, not a measurement of raw tokens.
That distinction matters: the plan limit is an opaque, changing agentic usage
pool, while local API-price-equivalent token accounting is only a proxy.

## Verified CodexBar implementation

The upstream source inspected on 2026-08-03 was commit
[`94efcfdf`](https://github.com/steipete/CodexBar/tree/94efcfdf4a4be495ddc80ad5193d4e488df06450).

Its generic pace calculation in
[`UsagePace.swift`](https://github.com/steipete/CodexBar/blob/94efcfdf4a4be495ddc80ad5193d4e488df06450/Sources/CodexBarCore/UsagePace.swift)
uses the elapsed fraction of the reset window (or a configured workday schedule)
as expected consumption.  It derives a current-rate ETA from remaining percent
divided by observed percent-per-hour.  The generic calculation has no
probability.

The Codex-specific historical model in
[`HistoricalUsagePace.swift`](https://github.com/steipete/CodexBar/blob/94efcfdf4a4be495ddc80ad5193d4e488df06450/Sources/CodexBar/HistoricalUsagePace.swift)
does the following:

1. Requires at least three completed weekly curves; it withholds explicit risk
   text until five complete weeks are available.
2. Normalizes a week into 169 points, applies exponential recency weighting
   (`exp(-ageWeeks / 3)`), and blends its weighted median curve toward a linear
   baseline as evidence grows.
3. Treats each earlier week as a counterfactual demand scenario.  It shifts the
   curve by the difference between current actual use and that curve's use at
   the same normalized time, then checks whether it reaches 100% before reset.
4. Smooths the weighted fraction of scenarios that cross the limit using
   `(runOutMass + 0.5) / (totalWeight + 1)`, and reports a weighted-median
   crossing time for the run-out cases.

The displayed percentage is rounded to the nearest five percent in
[`UsagePaceText.swift`](https://github.com/steipete/CodexBar/blob/94efcfdf4a4be495ddc80ad5193d4e488df06450/Sources/CodexBar/UsagePaceText.swift).
Thus a label such as "approximately 80% run-out risk" is a smoothed historical
scenario share, not a probability supplied by OpenAI.

CodexBar samples local usage periodically and can optionally backfill history
from the ChatGPT usage dashboard.  That backfill infers a quota percentage
curve from dashboard credits and the current observed percentage.  It is a
useful bootstrap, but it is a modelling assumption rather than historical
provider quota telemetry.  Its Codex provider routes and data sources are
documented in [`docs/providers.md`](https://github.com/steipete/CodexBar/blob/94efcfdf4a4be495ddc80ad5193d4e488df06450/docs/providers.md).

## What is good about it, and what is not established

| Aspect | Assessment |
|---|---|
| Reset-aware pacing and current-rate ETA | Useful and mechanically sound as a local indication. |
| Account-scoped retained history | Essential; CodexBar explicitly protects account separation. |
| Workday override | Good product control when habitual timing is known to differ from a smooth week. |
| Minimum-history gates | Sensible restraint: three weeks for directional output and five for a numeric label. |
| "80% risk" calibration | **Not established.** Source tests cover calculations, data isolation, and text rendering; no source-visible held-out calibration, Brier score, interval coverage, or probability-reliability result was found. |
| Dashboard-history backfill | Helpful but fragile if plan, model mix, fast mode, rate card, or shared usage changes. |

The most important conclusion is that the number can be decision-useful without
being a defensible likelihood.  Four or five historical weeks are too few to
support the ordinary interpretation of an 80% probability.  TiboTattle should
call an early version a **historical run-out heuristic**, or present a range,
until it has replay evidence that its probabilities are calibrated.

## Fit with the current TiboTattle codebase

| Needed capability | Existing TiboTattle substrate | Remaining work |
|---|---|---|
| Live weekly percent and reset timestamp | `src/providers/codex/app-server.js` reads the Codex app-server rate-limit and account snapshots. | Choose and expose one canonical weekly track. |
| Retained quota observations | `src/replay-safe-accounting-cache.js` records projected weekly quota snapshots and reset history. | Reject stale, mixed, and incompatible samples for forecasting. |
| Track / reset validity | `packages/quota-analysis` has account-track, limit, duration, reset-key, and policy-epoch evidence checks. | Feed the predictor only one exact account/plan/limit/policy track. |
| Local usage context | Current replay/cache logic has cost and gradient calibration. | Do not translate API-price-equivalent cost directly into subscription allowance; learn from observed percentage movement instead. |
| Presentation surfaces | Web dashboard and macOS shell already display quota state and refresh locally. | Add one DTO and an intentionally qualified card/menu summary. |

The main implementation trap is present in the existing cache: its historical
weekly quota projection is marked `historical_unattributed`.  That data must
not be combined across accounts to produce a forecast, especially where the
user switches between account tabs.  A forecast should require the same
`accountTrackId`, provider, plan variant, limit ID, window duration,
policy epoch, and reset family for every training observation.

## Recommended product boundary

Use the provider-reported current state plus strictly local, account-scoped
quota observations.  Do not require browser cookies or the ChatGPT dashboard
in version one.

```text
current canonical weekly snapshot
  + comparable account-scoped quota snapshots
  + completed prior reset windows
          |
          v
quota forecast in packages/quota-analysis
          |
          v
dashboard DTO and macOS summary
```

Predict in **percentage points per hour**, rather than converting tokens or
API-priced dollars into an allowance.  Start with a robust recent-rate
baseline plus matching points from prior normalized reset curves.  Condition
each prior curve on today's actual percentage, then produce a P20/P50/P80
time-to-limit range.  A numeric run-out probability is allowed only after its
historical replay has passed the acceptance criteria below.

Recommended initial copy:

> Likely to reach the weekly allowance between Tuesday and Wednesday, based on
> 8 comparable local windows. Current state is provider-reported; the forecast
> is local and not an official limit prediction.

Avoid calling it a "token forecast."  "Weekly allowance run-out forecast" or
"availability forecast" is clearer and does not overstate what the data means.

## Scope and effort

| Level | Deliverable | Engineering effort | Evidence requirement |
|---|---|---:|---|
| 1. Pace only | Current rate, reset-aware ETA, and a range; no probability. | 1–2 days | A clean canonical live snapshot and several recent intervals. |
| 2. CodexBar-like heuristic | Account-scoped historical curves, scenario ETA, qualitative risk; numeric risk only after five comparable windows. | 3–5 days | At least 3 completed windows for directional output, 5 for a labelled heuristic. |
| 3. Calibrated forecast | P20/P50/P80 intervals, numeric risk, data-quality explanation, and replay report. | 7–12 engineering days, plus 5–12 weeks of passive history if not already present | At least 8–12 comparable windows and successful held-out replay. |

These are implementation estimates, not a promise that enough historical data
already exists.  Tier 2 is not greenfield because the quota capture, replay,
and validity substrate are already present.  Tier 3 is mostly an evidence and
data-maturity problem rather than a difficult algorithm problem.

## Validation gates before a numeric risk label

For each completed reset window, replay the application state at several
earlier cutoffs.  Fit only on reset windows strictly before the cutoff, then
compare its prediction with what actually happened before reset.

Do not show a probability unless all of the following hold:

- at least 8 comparable held-out windows (more is better);
- no account, plan, policy-epoch, duration, or reset-family mismatch;
- stale/ambiguous/backwards quota snapshots excluded;
- forecast interval coverage is reported for P20/P50/P80; and
- Brier score and calibration buckets are retained alongside the feature
  receipt, with an explicit fallback to qualitative language if they fail.

Suppress or downgrade the forecast when shared product usage, credit purchase,
fast-mode changes, plan changes, or a new rate-limit policy make previous
weeks non-comparable.  OpenAI's current guidance says Codex availability varies
with task size, complexity, and execution context, and applicable products can
share the same agentic usage pool; no local predictor can guarantee the actual
exhaustion time in that setting.

## Licensing and implementation choice

CodexBar is MIT licensed, so copying portions is legally possible with the
required notice.  It is nevertheless the wrong engineering choice here: it is
a larger Swift multi-provider application with a different data model and
optional browser-cookie acquisition.  Reimplement the small, documented idea
in TiboTattle's existing JavaScript quota-analysis layer, preserving
TiboTattle's local provenance and validation rules.  The upstream license is
available at [`LICENSE`](https://github.com/steipete/CodexBar/blob/94efcfdf4a4be495ddc80ad5193d4e488df06450/LICENSE).

## Evaluation limits

Upstream source and focused tests were inspected. A requested SwiftPM test
filter expands into the full macOS application build, so it was not run to
completion during the evaluation; this report makes no claim that the upstream
test suite passed locally. The subsequent TiboTattle Tier-1 implementation was
tested with its focused engine, cache, local-companion, browser-data-boundary,
and rendered-dashboard checks.

## Primary sources

- CodexBar historical pace implementation, commit `94efcfdf`:
  <https://github.com/steipete/CodexBar/blob/94efcfdf4a4be495ddc80ad5193d4e488df06450/Sources/CodexBar/HistoricalUsagePace.swift>
- CodexBar generic pace implementation, commit `94efcfdf`:
  <https://github.com/steipete/CodexBar/blob/94efcfdf4a4be495ddc80ad5193d4e488df06450/Sources/CodexBarCore/UsagePace.swift>
- CodexBar provider documentation, commit `94efcfdf`:
  <https://github.com/steipete/CodexBar/blob/94efcfdf4a4be495ddc80ad5193d4e488df06450/docs/providers.md>
- OpenAI, "Using Codex with your ChatGPT plan":
  <https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan>
