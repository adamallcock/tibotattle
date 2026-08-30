---
title: Fast Mode Is Priority - Price Everything at Published Speed-Mode Rates
date: 2026-08-30
type: decision-record
status: complete
---

# Fast Mode Is Priority - Price Everything at Published Speed-Mode Rates

## Decision

Codex Fast mode is the API's Priority processing tier: the toggle writes
`service_tier: "priority"`, and the official pricing page labels the Priority
tier's tab "Fast mode". The monitor therefore prices every increment at the
published API rate for its effective speed mode, end to end:

1. **Multiplier source.** The Fast weighting is the published Priority/Standard
   API price ratio per model family - 2x for GPT-5.6 and GPT-5.4, 2.5x for
   GPT-5.5 - derived from the shipped price registry at load and proven
   uniform across every token component, context band, and dated price epoch
   before use (`deriveFastModePriorityRatiosFromRegistry`). This supersedes
   the vendor's credit-rate statement recorded 2026-08-01, which claimed 2.5x
   for GPT-5.6 where the published Priority price is 2x Standard.
2. **Equivalence, not exact-card selection.** Because the published Priority
   rows are exact uniform multiples of Standard, multiplying the
   Standard-priced amount by the family ratio equals pricing the same tokens
   on the Priority card wherever one exists - including the GPT-5.6
   long-context band - while models and epochs without a published Priority
   row stay priced (at the disclosed assumed 2x) instead of falling out as
   unpriced and poisoning fit resets.
3. **No fail-closed for Fast on unlisted models.** Fast usage on a model with
   no published Priority rate is included at an assumed 2x and reported
   separately (`assumedRatioStandardApiPriceEquivalentUsd`,
   `subscription_speed_assumed_priority_ratio`), never excluded and never a
   silent 1x.
4. **Attribution stays evidence-first, with no dashboard preference.** The
   speed mode is Codex's own control. Resolution is observed tier events, then
   timestamped `service_tier` configuration readings (valid from when they
   were read until superseded), then Standard as a visible assumption. The
   owner-stated dashboard preference - whose UI had already been removed on
   2026-08-02 - is deleted end to end (module, endpoint, storage, i18n), and
   the unresolved-as-Fast sensitivity scenario replaces `mixed_unknown`.
5. **Server and community fit follow the same basis.** Worker pricing v0.3
   multiplies the Standard-counterfactual cost by the same ratio for
   `chatgpt_subscription` events with `speedMode: "fast"`
   (`subscription_speed_priority_price_ratio`), the v1 fit adapter inherits it
   (`v1-fit-6`), and the fit cache key now includes the server pricing method
   version so future pricing-semantics changes self-invalidate.

## Consequences

- The speed-priced metric replaces the "quota-weighted" labels; the persisted
  field keys keep the legacy `quotaWeighted` spelling as the wire contract.
- The local allowance basis moved to
  `codex_primary:speed_priced_api_equivalent:v2:priority_price_ratio_2026_08_30`,
  which rebuilds the replay-safe accounting cache.
- Stored v0.2-era `server_cost_nanousd` rows keep their Standard-counterfactual
  values; the community corpus is v1 (priced at read), so the published band
  moves to the speed-priced basis wholesale, but personal stats for any
  remaining v0.2 rows retain their frozen values.
- Empirical checkpoint owed (not a gate): reconcile the declared Fast window
  of 2026-08-05 18:25-23:21Z on GPT-5.6 against observed quota drawdown. The
  residual-inference bands keep 2x and 2.5x disjoint, so if the meter actually
  drains at the superseded 2.5x credit rate the data will say so.

## Evidence

- Owner-supplied captures of the official pricing page (Standard, Batch, and
  Fast tabs, 2026-08-30 review; registry v0.5) including the GPT-5.6 Sol
  repricing effective 2026-08-21 and the first Priority long-context rows.
- First-party Codex model pages for gpt-5.3-codex, gpt-5.2-codex,
  gpt-5.1-codex, gpt-5.1-codex-mini, and gpt-5-codex.
- Owner-stated gpt-5.1-codex Priority rates (2.5/0.25/20 - exactly 2x its
  Standard row).
