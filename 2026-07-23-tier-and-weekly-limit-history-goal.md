---
title: Tier-Aware Capture and Weekly-Limit History Goal
date: 2026-07-23
type: plan
status: complete
---

# Tier-Aware Capture and Weekly-Limit History Goal

## Goal

Extend the local-only usage monitor so delivery tier is observable without changing the requested Standard OpenAI API-price baseline, then determine whether the retained local evidence supports a ballpark weekly allowance or a change in that allowance over time.

The work must distinguish three different quantities:

1. **Standard API-price equivalent:** the counterfactual dollar value of observed token components at Standard API prices.
2. **Observed delivery mode:** the provider/client tier actually requested or reported, when locally observable.
3. **Subscription-weighted sensitivity:** an explicitly labelled quota-burn sensitivity using documented Codex Fast multipliers; it is not API cost and is never substituted for the Standard API-price ledger.

## Tier taxonomy

Tier capture must be extensible rather than assuming today's values are exhaustive.

| Field | Canonical values | Meaning |
| --- | --- | --- |
| `billingSurface` | `chatgpt_subscription`, `openai_api`, `unknown` | Selects whether Codex credit multipliers or API service-tier prices could apply. |
| `codexSpeedMode` | `standard`, `fast`, `unknown`, `other` | ChatGPT-authenticated Codex speed mode. |
| `apiServiceTier` | `standard`, `priority`, `flex`, `batch`, `unknown`, `other` | OpenAI API processing/pricing tier. |
| `providerTierRaw` | provider string or `null` | Preserves a future provider value without silently mapping it to a known tier. |
| `tierSource` | `app_server_effective`, `turn_override`, `app_log`, `config`, `experiment_manifest`, `unobserved` | Records how the value was obtained. |
| `tierObservedAt` | timestamp or `null` | Supports staleness and precedence checks. |

`default` normalizes to subscription Standard. On the current local app-server protocol, raw `priority` is displayed as Fast; it therefore maps to `codexSpeedMode: fast` only when `billingSurface` is `chatgpt_subscription`. On `openai_api`, `priority`, `flex`, and `batch` map only to `apiServiceTier`. Unknown provider values map to `other` while retaining `providerTierRaw`.

## Implementation work

1. Parse privacy-safe `thread_settings_applied.service_tier` events from retained rollout logs without retaining log bodies, request content, thread IDs, or client message IDs. The general app log database was rejected as a source because its tier-bearing entries were too sparse and opaque.
2. Support the installed app-server protocol's effective tier values as persisted by `thread_settings_applied`; the account rate-limit endpoint itself does not expose a tier.
3. Track timestamped tier state in memory within each rollout solely for joining to usage, then discard rollout/thread identity before persistence.
4. Add tier provenance to capture, transition, experiment, and collector records without rewriting retained observations.
5. Preserve the Standard API-price ledger as the primary cost series.
6. Add a separate documented subscription multiplier series:
   - GPT-5.6/GPT-5.5 Fast: `2.5`;
   - GPT-5.4 Fast: `2.0`;
   - Standard: `1.0`;
   - unsupported/unknown model or speed: `null`.
7. Preserve API Standard/Priority/Flex/Batch as an independent taxonomy. Keep non-Standard API-tier pricing unavailable until an API-billed event actually supplies both billing surface and tier; never infer API Priority from Codex Fast.
8. Keep already processed historical events `unknown` unless a timestamped local tier event can be joined defensibly.

## Historical-change diagnostic

### Question

Did the effective weekly allowance change across retained reset windows, and how wide is the narrowest defensible ballpark under Standard API-price and tier-sensitivity assumptions?

### Population and grain

- Provider: OpenAI Codex subscription usage only.
- Grain: one canonical weekly reset identity, with adjacent quota snapshots inside that reset.
- Required joins: replay-safe token deltas, model attribution, Standard API-price components, tier state/provenance, integer quota percentage, and contamination state.
- Exclusions: resets with incomplete pricing, reset overlap, mixed limit IDs, insufficient percentage span, or unrecoverable fork replay.

### Comparisons

1. Reset-to-reset capacity diagnostics using the same estimator and price-card version.
2. Early versus late retained windows.
3. Standard-only versus Fast-sensitivity views for rows whose mode is unknown.
4. Model/cache/reasoning mix versus within-window slope changes.
5. Candidate change points compared with logging, pricing, model, and plan changes.

### Required outputs

- exact feasible interval when one exists;
- robust descriptive slope and uncertainty when exact constraints conflict;
- pairwise reset ratios with sample size and percentage span;
- holdout error and residual distribution;
- result classification: `stable`, `changed`, `suggestive`, or `not_testable`;
- a ballpark only if its uncertainty and sensitivity range are narrow enough to be decision-useful;
- an explicit explanation when a numerical ballpark would be false precision.

## Acceptance gates

- Tier tests cover Standard, Fast, Priority, Flex, Batch, clear, omission, future/other values, staleness, and precedence.
- No persisted tier artifact contains thread/session/request identifiers or log bodies.
- Existing Standard API-price totals remain unchanged for the frozen fixed window.
- Historical diagnostics are reproducible from exact dated inputs.
- Published changes, local observations, third-party estimates, and inference are labelled separately.
- The final report explains both the strongest possible ballpark and why it is or is not trustworthy.

## Deliverables

- Tier-aware implementation and regression tests.
- Versioned historical-change dataset and analysis receipt.
- Self-contained technical HTML report with exact source metadata and a concise Markdown decision record.

## Completion receipt

- Parser `0.3.2` prices 222,525 of 222,525 retained events over the fixed June 11–July 23 interval, including official Standard API-price supplements for GPT-5.4, GPT-5.4 mini, and GPT-5.5.
- 1,743 Standard/default and 89 Fast/priority setting events are normalized without retaining identifiers.
- Historical attribution selects the nearest setting at or before each usage timestamp, so an out-of-order future setting cannot label earlier usage. Passive collection preserves omission/clear semantics, and direct captures expose only aggregate all-Standard/all-Fast attribution; mixed or incomplete coverage remains unknown.
- Fourteen weekly reset groups pass the descriptive transition/span/pair-width screen; all 4,177 transitions remain control-state `unknown`.
- The all-reset descriptive median is `$1,890.63`; recent conditional tier sensitivity is `$1,892.15–$2,327.06`.
- Standard-only early-versus-late medians decline 12.04%, but tier sensitivity permits a late/early ratio from `0.3567` to `1.0939`; change direction is therefore not identified.
- Reset-to-reset ratios and early/late model/cache/reasoning mix are retained descriptively. Exact feasible intervals, holdout error, residuals, and a change-point test are explicitly unavailable because every transition is uncontrolled and missing shared-pool usage is unbounded.
- The final verdict is `not_testable`, with a conditional ballpark retained only as an assumption-bound diagnostic. The full suite passes 106 tests, all JavaScript syntax checks pass, and the portable report passes desktop/mobile/source-dialog verification.
