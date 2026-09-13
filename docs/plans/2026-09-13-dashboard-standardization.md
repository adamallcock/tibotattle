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

Implemented and visually inspected source
`a0d9a097aaf94abc3011cfb0168326da4a2e9848`, unsigned development ASAR
`4eb165ac739eca90d54f2c1f13882d28ed57f1fd17a4accc274dfbea1cd567ab`.
750 web tests and documentation governance pass. Packaged real-data captures at
1180px and 960px confirm aligned value, progress and footer rows within each
card row, no card or document horizontal overflow, and the explicit stale
observation label without a repeated generic banner. Evidence is retained in
`.release-build/freshness-layout.json` and the matching private screenshots.
The full runner still encounters its existing `usage_invalid` accounting-parity
gate; this is visual qualification, not full accounting-parity qualification.

## Chart anatomy follow-up

Bring allowance and model-performance cards onto the shared chart anatomy.
Legends should occupy a separate row below heading/controls, including the
usage timeline. Keep plot interactions and uncertainty semantics unchanged.
Use amber for incomplete coverage, reserving error styling for failed actions.
Acceptance: consistent title scale/padding, readable controls and legends at
1180px and 960px, preserved model tooltip and keyboard tests, and a fresh
unsigned packaged visual inspection.

The shared chart anatomy is implemented, including legends below the controls
and consistent 24px padding / 23.2px heading scale in the reviewed desktop
layouts. The usage heading no longer repeats the reporting period, preventing
the internal All-range day sentinel from appearing as a duration.
750 web tests pass, including existing chart tooltip and keyboard checks.
Two exact-class checks were reconciled with the shared aliases without removing
their original structural expectations.

Final unsigned candidate source:
`51508dbce6dc83885fe72cb4feeed4a34a74fb42`; ASAR:
`4e4e1b2a5230b7c487191a27c9faad251f236922beb19ce956a7585ab406a33d`.
Rendered Allowance, Trends and Model performance are reviewed at 1180px and
960px; `.release-build/charts-layout.json` records card alignment and overflow
checks. Full accounting-parity qualification remains an independent gate.

## Compact performance evidence follow-up

Remove duplicate page-local reporting context when the app header owns it.
Keep update/progress and retry/cancel actions together. Coverage counts remain
visible beside their chart, with partial coverage in amber. A secondary update
timestamp remains available while progress or errors occupy the status line.
Standalone reporting retains its own range. Validate retained-data progress,
empty/error controls and a real packaged performance view before handoff.

Validated with 751 passing web tests and passing documentation governance.
The retained-results failure/retry test verifies coverage, secondary timestamp,
and recovery without duplicate ready timestamps. Shared mode omits its local
period row while standalone mode retains it.

Unsigned source `44aff8e6b861f227f0f71eca75243d4f77d13ac4`, ASAR
`d8602d0d70b61f5d90de70bf541b1ab27dfacc239e9cb70b1c922e765abb9a97`,
was visually reviewed with real aggregate data at 1180px and 960px. Both show
one secondary timestamp during collection, zero duplicate period rows, two
chart coverage summaries, and no horizontal overflow. Private evidence:
`.release-build/evidence-layout.json` and the matching performance screenshots.
This visual qualification does not resolve the existing full accounting-parity
gate.

## Projects and threads context follow-up

Use one responsive toolbar for grouping, search, sort/model/scope and refresh.
Place progress/cancel together; omit the duplicate global reporting row and
repeat observation caption. Preserve observation and coverage in quiet inline
metadata. Available reports with no rows show a true empty/search-empty state
without empty result tables or summary cards; unavailable reports retain their
own status. Validate query interactions and packaged controls at two widths.

752 web tests pass, including no-match search and restoring results after
clearing search, along with existing snapshot/filter/expansion interactions.
Documentation governance passes. Final unsigned source
`81dc10df91046779a83d4cc0289822058b83568c` has ASAR
`1ccb8cde50f5a8685faf55c67f50dc641a319ae8376c25187d3f1badc86a7aac`.
Packaged report controls were reviewed at 1180px and 960px while preparing a
real report, with no toolbar/document overflow. Search and selects are 44px
high; sort/model/refresh wrap together. Captures deliberately end above private
report rows. Evidence: `.release-build/projects-layout.json` and matching
control screenshots. Empty/restore behavior is tested with synthetic data;
this check does not qualify the populated real report or resolve the existing
full accounting-parity gate.

## Data-table presentation follow-up

Apply shared data-table typography and numeric alignment to Model usage and
Projects/threads. Make overflow regions keyboard focusable and label model
columns explicitly, including the two different share columns. Expanded/focused
rows retain a quiet context cue; unavailable monetary cells remain text, with
muted treatment distinct from a real zero. Keep existing row/expansion and
pricing semantics. Validate interaction tests and real packaged model-table
layout at two desktop widths.

752 web tests and documentation governance pass. Unsigned source
`cbb48a603b514368224762b91857f6d3203aab06` has ASAR
`951d0e240a9fa5e8c3fd9fbe33360df86903875f918025d57c7c67adbc81bd97`.
The packaged Model usage table was visually reviewed with real aggregate data
at 1180px and 960px: six scoped column headings, right-aligned numeric cells,
a focusable overflow region, and four visible components in an expanded row.
Neither width has document overflow; at 960px the table retains intentional
horizontal scrolling inside its card. Keyboard focus was verified; arrow-key
scrolling was not separately exercised. Private evidence:
`.release-build/tables-layout.json`, `.release-build/model-table-1180.png`,
and `.release-build/model-table-960.png`. Projects/threads share the source
styles and test coverage; this pass visually qualified only Model usage.
The full real-history runner still reports `parity / usage_invalid`; this
visual qualification does not close that independent gate.

## Empty-state recovery follow-up

Reuse the shared state container for chart placeholders, with explicit empty
versus unavailable styling on Usage and Trends. Preserve reason-specific copy
and chart availability decisions. Announce placeholder text as status. Add a
localized Clear search action to a no-match Projects/threads result, using the
existing search lifecycle and restoring focus to its input. Validate recovery
with synthetic data, then inspect the fresh packaged renderer.

752 web tests pass, including clicking Clear search to restore populated
results. Documentation governance passes. Preflight remains blocked by the
pre-existing tracked root `design-qa.md` allowlist issue.
Unsigned source `b04cde12f287899147c291b6965f8561f5b806c2`, ASAR
`011089d0b2fdcbe586e5a6cca81952725691b347a85608ce7fda8075193c35bb`,
was launched with the isolated real-history profile. The loaded Usage page
has all five shared status placeholders; unavailable appearance was not
triggered by that real dataset. A clearly labeled synthetic search-empty view
inside the packaged renderer was visually inspected at 1180px and 960px.
Both widths show the recovery action without horizontal overflow. Clicking it
clears the input, restores focus, and removes the now-inapplicable action.
Evidence: `.release-build/states-real-layout.json`,
`.release-build/states-layout.json`, and matching `search-empty` screenshots.
This does not qualify a real private report or the separate accounting-parity
gate.

## Model filter identity

Use shared display names, SVG icons, and presentation ordering in the Projects
model filter, with All models first and exact observed IDs retained. Enhance
the native select with customizable-select rendering in Electron; browsers
without that capability retain their native text select. Verify selection,
keyboard/dismiss behavior, and open-menu rendering in the packaged app.

753 web tests pass, including shared model ordering, decorative SVG semantics,
unknown IDs, and exact alias selection through a report refresh. Documentation
checks pass. Final unsigned source
`378d25c4d643856bbb9b53e38834fa7e46765f68` has ASAR
`86946bc3bc8caeff4af1809f6c0a318c22dd6fbe1df23d86f1d4ed7c26664d2c`.
The packaged renderer was reviewed at 1180px and 960px with a labeled synthetic
model list in the isolated QA profile. All eight model icons and the intended
order render; base models precede their variants, and unknown IDs sort last.
Keyboard selection chooses Astra and renders its selected icon. Escape and an
outside click close the menu. Evidence: `.release-build/picker-layout.json`
and matching `model-picker` screenshots. The review does not qualify private
report contents or close the separate accounting-parity gate.

## Model picker visual refinement

Give each shared model icon a tinted tile, including All models in the closed
picker. Increase menu width and row spacing, move the selection checkmark to
the right, and preserve a distinct selected background and keyboard focus.
Build the icon-bearing options during initial loading as well as after reports
and locale changes; localization must not replace an option with plain text.

753 web tests and documentation checks pass. The model-filter regression also
verifies that locale refresh preserves icon-bearing options and selection.
Unsigned source `d7e50c31cc9d6e7b08fb4b96b20e1e8bfd310c76`, ASAR
`1e42e9305f2090ffb937abc715fde458a7bd8c86f2edc70c6fd9bcf6b10e738d`,
was reviewed in the packaged renderer at 1180px and 960px with the labeled
synthetic model list. All nine options have icons, including All models; the
selected Astra icon, keyboard selection, Escape, and outside dismissal pass.
Evidence: `.release-build/picker-polished-layout.json`, the corresponding
`model-picker-polished` captures, and `.release-build/model-picker-detail.png`.
The independent accounting-parity gate remains outside this visual proof.
