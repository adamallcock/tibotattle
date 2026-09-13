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

## Compact header follow-up

User review requested fixed left brand alignment, a compact header reporting
control, dates available on demand, removal of the scope sentence, and compact
successful setup. Implemented these with full accessible period labels and a
keyboard-operable date disclosure. Header controls wrap at narrow widths; setup
errors and bounded continuation remain expanded. Ready setup no longer expands
solely because collection is running. Expanded setup checks align at the top.

The 745 browser tests pass. Corrected two stale source-extraction tests to target
their owning function/section after the reporting control moved. Documentation
and i18n mirror checks pass. Browser inspection covered compact controls and
keyboard date disclosure at narrow width (391 CSS pixels; the popup remained
inside the viewport). Packaged development source
`906eb385c0060ad693dd58e7fe4fb42f0c931594` passed artifact verification; ASAR digest
`ffd1439436dd4907fe36ab92b0d3da11448760130f82a68cf0feeecb85671f38`.
Synthetic packaged inspection confirmed 24px brand inset, header-owned reporting
controls, collapsed ready setup and no horizontal overflow at 1180 CSS pixels.
Seven-page captures and layout evidence are under
`.release-build/compact-synthetic-*`. Startup chrome/data-flow passed; full smoke
still failed `usage_parity_invalid`. Automatic approval review rejected a new
real-history screenshot capture for lack of capture-specific authorization; no
real-history capture ran for this revision. The synthetic fallback was approved.
No system installation or publication occurred.

## Header density and setup layout refinement

The user authorized real-history screenshots for this follow-up. Reduced the
header wrapping breakpoint to 1000px and made refresh progress shrink with the
window. Share and Settings use 36px icon buttons with accessible localized names
and tooltips. Setup now has a neutral Local setup heading and a separate Ready
label; its summary/checks use two columns and the note/actions span both columns.
All 746 browser tests passed after correcting the browser locale catalog to
expose the new setup labels. Final development source is
`7efee1413fa9395e1053fdb8a1a4cd46c945771b`; verified ASAR digest is
`5caf2abb4e03f218a35985aa060c128bc201c2aa761115623e6eda888e5f1718`.
Authorized real-history screenshots at 1180px, 1050px and 900px confirmed correct
setup labels, compact icon buttons, one header row at 1180px and 1050px, wrapping
at 900px, and no horizontal overflow. Setup was checked collapsed and expanded.
Captures and content-free layout measurements are `.release-build/refined-header-*`.
The real-history snapshot QA retains the existing accounting-parity gate; these
screenshots qualify this visual refinement, not full release readiness.

## Narrow navigation and progress counters

Corrected horizontal navigation links inheriting sidebar width: 100%, delayed
sidebar collapse to 900px, and delayed header wrapping to 760px. Intermediate
widths compact the brand and redundant state pill. Progress count and timer
use intrinsic non-clipping tracks; only the phase label can truncate. Quota
headline type scales with card width to avoid premature word wrapping.
Validation includes active refresh counters and responsive packaged screenshots.

Packaged source `28fb656f127effe3a1cdf993528bf6cf2fe68c60` verified with ASAR
SHA-256 `9f063cfd4550c58765e11896fa87d57910de758df8e807f1d6b558b1ddfbba64`.
Authorized active real-history screenshots at 1240, 1024, 900, 800, 640 and 390px
showed correct navigation widths and no page overflow. The captured early
refresh counter was 0/0; a separate explicitly synthetic rendered stress check
used 99999/99999 and 123:45, proving both fields visible and untruncated at all
six widths. Evidence is `.release-build/narrow-active-*` and
`.release-build/narrow-counter-stress.json`. These visual checks do not replace
the pre-existing full accounting-parity qualification gate.

## Date popup dismissal and window minimum

Date details now dismiss on outside pointer interaction and Escape, returning
keyboard focus when appropriate. The Electron dashboard minimum width is 960px,
capped to the display work area so smaller displays remain usable. Settings and
tray window constraints remain independent. Removed the previously rejected
scope sentence from the remaining Model performance and Projects evidence rows.

747 web tests and 79 Electron shell tests passed, including default 960px and
small-display 800px window constraints. Packaged source
`31aea2226af765c1c5fedf1521e8dd27fbe18576` verified with ASAR digest
`cd350566712c400e330ba7fdf131e46bb8b54c1ce2fcaca582d267b6ffc9cd45`.
Real packaged pointer and keyboard input confirmed open-to-closed transitions
for both outside-click and Escape (`.release-build/popup-min-layout.json`).
The debugging endpoint did not support the native-window resize command;
minimum-width enforcement has constructor tests, not a live resize receipt.
The existing full accounting-parity gate remains separate.

## Freshness and allowance card follow-up

Acceptance: observation recency remains independent of accounting readiness and
running jobs; stale cards carry a text qualifier; missing percentages never
produce an apparent zero progress bar. Allowance cards share title, source,
value, progress and footer alignment while retaining separate Spark limits and
existing ordering. Validate freshness edge cases, the web suite and a fresh
unsigned package at representative widths. Full accounting parity remains an
independent gate.
