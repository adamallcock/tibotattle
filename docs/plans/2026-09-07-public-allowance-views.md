---
title: Public allowance graph views
date: 2026-09-07
type: plan
status: validating-before-deployment
---

# Public allowance graph views

Implement the requested Aggregate, By plan, and By model controls on the public
allowance graph, starting from the qualified model-history source at `97c6ff28`.
Keep the separate daily activity chart, all-token totals, API-equivalent spend,
download links, and private admin controls unchanged.

## Acceptance boundary

- Reuse existing allowance calculations and reviewed identities; no browser-side
  pricing or quota fitting. Clearly label the Pro 20x-equivalent reference basis.
- Publish a closed, bounded aggregate-only projection. Check the maintained
  publication policy before exposing plan/model estimates; no admin coverage,
  participant identifiers, operational diagnostics, or private endpoint access.
- Preserve date cutoffs, model identification gates, missing-day gaps, freshness,
  withdrawal and source-epoch fences. Do not carry a current model fit backwards.
- Maintain range and selected-view state, keyboard access, localization, and
  narrow-screen readability. Give unavailable and sparse views truthful labels.
- Verify contract/negative tests, Worker and web gates, public asset isolation,
  and rendered behavior. Source, local preview, and production remain separate.

## Work

1. Confirm source and publication policy; inspect public/admin chart reuse.
2. Add the public data projection and tabbed presentation with focused tests.
3. Update maintained contract documentation and generated mirrors as applicable.
4. Validate and prepare the guarded website deployment; report any remaining
   authorization or live verification gate without changing release artifacts.

## Decisions and evidence

- Isolated branch `codex/public-allowance-views`; previous history source is clean
  and retained. No production changes performed for this feature yet.
- The daily policy explicitly permits small samples without a minimum cohort
  (`community-daily-aggregates.ts`), but the new plan/model projections expose
  more granular estimates. Existing privacy disclosures also contain conflicting
  older weekly-threshold wording. This must be reconciled before publication.
- The safety review rejected both the initial cache-read integration and the
  proposed public projection pending explicit approval for aggregate dollar
  estimates and participant/fit counts, including single-account estimates.
  Neither rejected patch was applied before the user resolved that decision.
- The user explicitly answered **Yes** to publishing plan/model dollar estimates
  and supporting sample counts even for one account, without publishing
  identifiers. This resolves the safety review's material privacy decision.
  Publish only the closed projection after validation and disclosure updates;
  private admin diagnostics remain excluded. No minimum-cohort waiver is
  inferred for other contracts, and contribution consent/v1.1 remain unchanged.
- Implemented: synchronized view controls, localized comparison/disclosure copy,
  multi-series geometry with shared axes and gaps, cards, keyboard tooltips,
  responsive styles, and the closed public API/client projection. Missing,
  stale or invalid optional data preserves the aggregate/activity response.
- The cache and requested published range/readiness use one two-statement
  transaction. Preview bytes appear once, capped at 256 KiB, with current source
  epoch/method and two-hour freshness checks. Only requested, published, closed
  UTC dates can appear. No request-time analysis or database writes were added.
- A generated identity-only module supplies reviewed model labels. Public
  assets still exclude the full telemetry/admin mirror. The local static and
  client-export allowlists include the shared module so their imports stay
  complete; published desktop installers are unchanged.

## Chart contract

Question: how does a full Pro 20x-equivalent week compare across the aggregate,
personal-plan groups and identified models over time? The existing site's SVG
renderer remains the delivery surface, with a shared date axis and zero-based
USD axis for all three views. Daily medians use trailing-30-day reset fits;
model history is independently reconstructed and never carried backward.
Published model/plan history is bounded to closed dates in the 70-day cached
window. Sparse results show dated cards/dots and gaps, not fabricated trends.
Stable category colors match line/dot/legend marks; labels and keyboard/touch
tooltips identify individual series without relying on color alone.

## Test run report

Scope: public Worker read boundary, shared web module graph and website UI.
No migrations, contribution consent, v1.1 activation, or release artifact changes.

| Suite | Tests | Result |
| --- | ---: | --- |
| Full web suite (`product:ui:test`) | 530 | Passed |
| Public release-site, preview, serving and client-export boundary | 40 | Passed with loopback access |
| Documentation/root preflight | 20 plus static checks | Passed |
| Focused public graph/site tests | 54 | Passed |
| Focused Worker cache/projection/endpoint | 35 | Passed |

The first full root run had 3,919 tests: 3,892 passed, six failed and 21 existing
platform/environment skips. Four failures identified missing model-module
allowlist entries and stale exact asset-count assertions; these were corrected
and the affected boundary suite passed. The other two are retained R7 receipt
provenance failures, reproduced independently on unchanged base `97c6ff28`.
No R7 receipts were rewritten or tests weakened. The full root recheck and full
Worker qualification remain in progress.

Read-only review caught and corrected palette specificity, view-specific chart
accessibility descriptions, empty-view dialog focus retention, and the model
empty-state explanation. Fixtures are synthetic public wire data, never a
production feed. Existing sealed weekly contract checks remain unchanged.

Native in-app browser checks exercised Aggregate / By plan / By model, matched
legend/line colors, same-day keyboard navigation, plausible plan bands and model
gaps, independent All/30d state, expanded dialog selection and return focus,
narrow-screen wrapping, and Spanish selection preservation. No console errors
were observed. The disposable preview is prominently marked synthetic.

## Remaining deployment checks

Finish the full local gates, build the exact source-closed public assets with
unchanged verified 0.1.18 ARM/Intel artifacts, and use the guarded production
deployment wrapper. Verify live source identity, public/private isolation,
three controls, actual data availability/gaps, downloads and social metadata.
Production last verified source is `0207a3c1`; the existing allowance history
rebuild is separate from publishing this UI. Do not claim a populated live
model series from synthetic tests or a successful deployment alone.
