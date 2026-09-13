---
title: Shared reporting periods and dashboard components
date: 2026-09-13
type: plan
status: implemented
---

## Accepted scope

Introduce one persistent reporting period above page headers: 24 hours, 7 days,
30 days and all available history. Relevant views use the same explicit time
bounds; current quota and Community preferences are unaffected. Keep the
allowance-window selector and chart-specific controls local. Missing periods or
coverage stay explicit; never silently substitute another period.

Standardize chart cards, filters/tabs, buttons/actions, technical disclosures,
loading/empty/error states, freshness/coverage, and number/date formatting using
existing public presentation primitives. Preserve locale, evidence, accounting,
privacy, cancellation and accessibility semantics.

## Ownership

Root owns global reporting state, toolbar, app integration and necessary local
query contracts. Luna max agents own formatters, shared visual rules/reference,
and model/project view integration plus shared state/metadata helpers and catalogs.

## Acceptance

- One reporting control, persistence and identical bounds across relevant pages.
- No active-filter fallback; stale/missing coverage and unavailable data explicit.
- Stable view selections, cancellation and exact-query caching.
- Focused behavior/contract checks, full affected surface tests and architecture
  checks for boundary changes; responsive and localized rendered review.
- Fresh unsigned Electron artifact and target rendering checked separately from
  browser/source tests. Record any remaining full-smoke or baseline gate issues.
- No publishing, deployment, system installation or live contribution changes.

## Source validation

Implemented the shared toolbar and exact reporting-window query contracts,
reusable formatters, view-state/evidence helpers, and scoped component styles.
Three Luna max agents completed the formatter, surface and presentation work.

- 745 browser tests and 358 local-service tests passed.
- 36 release-site tests and 65 macOS smoke/real-history contract tests passed.
- Focused projection, exact-window cache and missing-period tests passed.
- Architecture and documentation checks passed; the direct preflight lane
  passed. Aggregate preflight remains blocked by the pre-existing tracked root
  `design-qa.md` outside the root-layout policy.
- Browser review covered period persistence/navigation, missing-period clearing,
  labeled demo accounting, and narrow Spanish control wrapping. Regional date
  formatting remains independent of the selected translation language.
- Fresh unsigned Electron package verified from source
  `70a5a412066f0290b0130a2698bedda1c484c921`, ASAR SHA-256
  `8f4e7191c88faf8b2875c5dba36b93a7d8642747a11bc1b0be8e03c0902dca0c`.
  Inspected all seven packaged pages using the disposable synthetic smoke profile.
  Six reporting pages share the same header coordinates; Community omits the
  inapplicable reporting toolbar. All seven use the same 36px serif title style.
  Captures and content-free bounds are under `.release-build/standard-*.png`
  and `.release-build/standard-layout-evidence.json`.
- Desktop startup refresh, chrome and data-flow checks passed. Full smoke remains
  unqualified at `usage_parity_invalid`: the synthetic accounting projection was
  still unavailable. No assertion was relaxed; the complete receipt is
  `.release-build/standard-smoke.json`.
- After explicit user authorization, ran the same packaged app against real
  local history in a separate persistent QA profile. Refresh succeeded and
  loopback health/status probes stayed responsive. Inspected the rendered
  dashboard and checked all four selections across six navigation destinations:
  selected periods and displayed bounds stayed consistent; Community hid the
  toolbar. Content-free evidence is in
  `.release-build/standard-real-filter-evidence.json`.
- Corrected the QA timer reader to inspect the dedicated `m:ss` slot, retaining
  the four-advancing-samples requirement and rejection of invalid/stalled clocks.
  All 73 focused Electron smoke/real-history contract tests passed.
- Full real-history qualification remains unpassed at `usage_invalid`. A
  separate content-free diagnostic confirmed a visible accounting page, four
  populated token and cost rows, five populated model rows and explicit states
  for all three advanced modules. The failed condition was the visibility of
  `accounting-price-coverage`: the existing renderer hides this optional warning
  when no unpriced events are reported, while the QA gate requires it visible.
  Neither the product warning nor the parity assertion was changed. Receipts:
  `.release-build/standard-real-history-retry.json` and
  `.release-build/standard-real-usage-diagnostic.json`. Failure receipts reset
  some earlier-stage fields; they do not independently preserve all successful
  refresh observations. The isolated profile is retained; installed app state
  was not used as the QA destination.
- The broader macOS smoke lane additionally failed its native launcher layout
  subprocess check (`null` exit status). This is separate from the passing
  focused Electron contracts and does not qualify native rendering.
- No signing, publishing, updater qualification, or system installation occurred.
