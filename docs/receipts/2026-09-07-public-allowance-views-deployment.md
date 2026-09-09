---
title: Public allowance graph views deployment
date: 2026-09-07
type: receipt
status: deployed-and-live-verified
---

# Public allowance graph views deployment

On 2026-09-07 the normal guarded production deployment published source
`a4f4da50edf35d29ef06bb2bd629e9dcd7c4a7f3`, based on model-history source
`97c6ff28`. Independent health and Chrome checks verified the live Aggregate,
By plan, and By model controls, real historical data, and Astra. This receipt
supersedes the completed feature plan. The separate daily activity chart,
all-token totals, API-equivalent spend, and both 0.1.18 downloads remain available.
It does not qualify a new desktop artifact or establish complete repricing.

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

## Decisions and evidence

- Isolated branch `codex/public-allowance-views`; previous history source is
  retained. The deployed feature is one reviewed commit; this later receipt
  records its qualification and live observations.
- The daily policy explicitly permits small samples without a minimum cohort
  (`community-daily-aggregates.ts`), but the new plan/model projections expose
  more granular estimates. Public and maintained privacy disclosures were
  reconciled before publication, distinguishing daily views from the separate
  sealed weekly contract.
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
| Full Worker runtime suite | 802 across 62 files | Passed |
| Worker deployment/operations script suite | 202 | Passed |
| Local companion serving | 58 | Passed |
| Full macOS app-bundle module suite | 74 | 73 passed; one existing framework-environment skip |
| Worker default/staging and production dry bundles | Three configurations | Passed |

The first full root run had 3,919 tests: 3,892 passed, six failed and 21 existing
platform/environment skips. Four failures identified missing model-module
allowlist entries and stale exact asset-count assertions; these were corrected
and the affected boundary suite passed. The other two are retained R7 receipt
provenance failures, reproduced independently on unchanged base `97c6ff28`.
The full root recheck passed 3,895 tests, with three failures and 21 existing
skips: the same two R7 failures and a second exact macOS file-inventory assertion
that needed the added module. That assertion was corrected, and the entire
74-test macOS module suite then passed apart from its existing framework skip.
The complete Worker check and production-specific dry bundle passed. No R7
receipts were rewritten or tests weakened. These pre-existing R7 failures remain
for future desktop qualification, not the maintained hosted deployment gate.

Read-only review caught and corrected palette specificity, view-specific chart
accessibility descriptions, empty-view dialog focus retention, and the model
empty-state explanation. Fixtures are synthetic public wire data, never a
production feed. Existing sealed weekly contract checks remain unchanged.

Native in-app browser checks exercised Aggregate / By plan / By model, matched
legend/line colors, same-day keyboard navigation, plausible plan bands and model
gaps, independent All/30d state, expanded dialog selection and return focus,
narrow-screen wrapping, and Spanish selection preservation. No console errors
were observed. The disposable preview is prominently marked synthetic.

## Production evidence

- Public asset build: 22 files; selected source closure has 16 entries and
  SHA-256 `039e3b1131b18b0c70579d907e7977b2c2ae8486d3cf094b40ec90339e4feb21`.
  Both existing 0.1.18 installers were reverified for bytes and native trust;
  their immutable release artifacts, tags and update feeds were not modified.
- The first deployment stopped before mutation when a read-only migration-ledger
  command failed. A direct read succeeded with all 48 expected primary entries
  and zero writes. Retrying the unchanged guarded wrapper returned
  `PRODUCTION_DEPLOYED`, no unapplied migrations, healthy pre/post checks and
  a public-only post-deployment surface. No guard or health exception was used.
- Independent health returned the exact deployed source above. Six served
  assets, including the generated model catalog and social image, matched the
  qualified local bytes. All six inline/dialog view buttons were present.
  Five private/admin paths returned 404 on the public host.
- The public response was `ready`; all 69 closed-date breakdown rows passed the
  production browser normalizer. The inspected cache was generated at
  `2026-09-07T13:05:41.000Z`. GPT-5.5 and the three GPT-5.6 models had five
  identified dates, September 2–6; Astra had two, September 5–6. Earlier missing
  model history remains gaps, not reconstructed from today's fit.
- Live Chrome rendered each view, matching model labels and plotted series,
  three plan cards with uncertainty bands, 30d/All switching, synchronized
  expanded/inline state, and focus returning to the expand button. An initial
  browser response still reflected the previous five-minute API cache;
  an uncached reload verified the newly published breakdowns. Normal browser
  caching was restored after QA, and no console warnings or errors were observed.
- Both macOS tabs visibly retained version 0.1.18 and their architecture-specific
  download URLs. Community activity retained all-token totals and explicitly
  partial API-equivalent spend: 318 shared days, 279 priced, displayed USD
  100,671.8. This is not proof of complete historical repricing.
- Open Graph/Twitter image references, crawler allowance, and the unchanged
  public PNG's MIME type and 1200×630 dimensions passed live checks. The retained
  dated social image was not regenerated or presented as a new estimate.

Local logs remain under the ignored `.release-build/` directory: the
`public-views-` UI, Worker, production-dry, build, production-deploy-retry, and
live-check logs separate local qualification from actual publication.
