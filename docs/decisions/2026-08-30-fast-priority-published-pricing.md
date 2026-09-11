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
   API price ratio for the exact registry model and its reviewed aliases,
   derived from the shipped registry at load and proven uniform across every
   token component, context band, and dated price epoch before use
   (`deriveFastModePriorityRatiosFromRegistry`). A shared name prefix is not
   evidence that a model has a Priority card: Pro variants and unknown suffixes
   must not inherit another model's rate. This supersedes
   the vendor's credit-rate statement recorded 2026-08-01, which claimed 2.5x
   for GPT-5.6 where the published Priority price is 2x Standard.
2. **Equivalence, not exact-card selection.** Because the published Priority
   rows are exact uniform multiples of Standard, multiplying the
   Standard-priced amount by the verified model ratio equals pricing the same
   tokens on the Priority card wherever one exists. The event's time and input
   context must admit that card; model identity alone does not establish a
   matching historical or long-context price. Models, contexts, and epochs
   without a published Priority row stay priced at the disclosed assumed 2x
   instead of being presented as published pricing or falling out as unpriced.
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
5. **Server and community fit follow the same basis.** Worker pricing v0.4
   multiplies the Standard-counterfactual cost by the same ratio for
   `chatgpt_subscription` events with `speedMode: "fast"`
   (`subscription_speed_priority_price_ratio`), the v1 fit adapter inherits it
   (`v1-fit-6`), and the fit cache key now includes the server pricing method
   version so future pricing-semantics changes self-invalidate.

## Consequences

- The speed-priced metric replaces the "quota-weighted" labels; the persisted
  field keys keep the legacy `quotaWeighted` spelling as the wire contract.
- The local allowance basis moved to
  `codex_primary:speed_priced_api_equivalent:v3:priority_card_ratio_2026_08_30`,
  with the `:event_time:observed_declared_scenario` suffix. The replay-safe
  accounting cache format is `local-replay-safe-accounting-v0.13`. Closed
  model-crossing keys and price provenance move together; old family-bucket
  results cannot be reused as the corrected exact-model results. This is
  derived-cache invalidation, not a change to physical unified-index schema 11.
- The development-only historical side-chat backcast does not observe the
  missing events' input context. Its nested contract advances to
  `development-side-chat-historical-gap-v0.3` and labels its assumed 2x
  conversion `assumed_missing_event_context`; a model-only capability lookup
  cannot turn that hypothetical estimate into published event-time pricing.
- Stored v0.2-era `server_cost_nanousd` rows keep their Standard-counterfactual
  values; the community corpus is v1 (priced at read), so the published band
  moves to the speed-priced basis wholesale, but personal stats for any
  remaining v0.2 rows retain their frozen values.
- Empirical checkpoint owed (not a gate): reconcile the declared Fast window
  of 2026-08-05 18:25-23:21Z on GPT-5.6 against observed quota drawdown. The
  residual-inference bands keep 2x and 2.5x disjoint. Other registry ratios can
  have overlapping tolerance bands; those observations remain ambiguous rather
  than being assigned a unique speed. No residual inference changes pricing.

## Evidence

- Owner-supplied captures of the official pricing page (Standard, Batch, and
  Fast tabs, 2026-08-30 review; registry v0.5, extended to v0.6 the same day when the Standard and Flex tab captures arrived) including the GPT-5.6 Sol
  repricing effective 2026-08-21 and the first Priority long-context rows.
- First-party Codex model pages for gpt-5.3-codex, gpt-5.2-codex,
  gpt-5.1-codex, gpt-5.1-codex-mini, and gpt-5-codex.
- Owner-stated gpt-5.1-codex Priority rates (2.5/0.25/20 - exactly 2x its
  Standard row).
