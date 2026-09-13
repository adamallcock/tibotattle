---
title: Shared reporting periods and dashboard components
date: 2026-09-13
type: plan
status: in-progress
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
- Packaged Electron rendering is the remaining validation gate at this point.
