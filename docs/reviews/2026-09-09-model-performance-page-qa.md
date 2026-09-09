---
title: Model performance local page QA
date: 2026-09-09
type: review
status: local-verified
---

## Scope and result

Local implementation on `codex/local-inference-timing`, based on `7416b912`.
The selected focused-model design is implemented in the existing app shell with
real copied timing data. Source and loopback UI are verified; this is not an
installed-app, signed artifact, Windows qualification or release claim.

Final result: passed.

## Visual evidence and comparison

Local ignored evidence directory: `.usage-monitor/performance-preview/`.
Source visual truth: `approved-design.png` (1227 × 1282 pixels).
Implementation: `desktop.jpg` (916 × 1093 exported pixels), captured at a measured 1230 × 1280 CSS viewport;
full-page capture includes the existing header/footer and scrolling content.
Narrow evidence: `narrow-details.jpg` (562 × 1489 exported pixels), measured 760 CSS pixels wide, with both
methodology and aggregate table expanded. Browser effective pixel ratio was 1.33; the browser tool downscaled captures;
comparisons use the CSS content proportions rather than raw pixel equality.

The approved source and full-page implementation were supplied together in one
comparison input. Both show Sol / All time in the light theme. The generated
reference contains illustrative data; implementation curves and missing ranges
come from real retained measurements. The isolated preview deliberately has no
accounting records, so other evidence-gated app destinations are hidden. This
existing shell behavior is not part of the performance-page design comparison.

Focused inspection used the actual 760-pixel rendered chart, labels, model tabs,
period controls and disclosures. Text and controls remained readable; no
horizontal document overflow occurred. Expanded table scroll is internal.

## Comparison iterations

1. Initial render exposed three P2 issues: inherited serif page heading; a global
   May start date wasted space for Sol; weekly bins obscured daily variation.
2. Applied native sans typography; aligned both All-time charts to the selected
   model's earliest observed metric bin; retained daily bins through 366 days.
   Recaptured the desktop and narrow view and compared against the reference.
3. Accessibility audit found refresh could remove focused headings/disclosures.
   Stable focus identities and early-return restoration now cover initial load,
   localization redraw and background updates; a DOM regression test verifies it.

No actionable P0/P1/P2 differences remain in the inspected views. Intentional
adaptations: reuse existing shell and type scale, compact filters and tabs,
real rather than illustrative curves, optional aggregate table, and separate
old/new speed lines without inventing continuity at the method transition.

## Required fidelity surfaces

- Typography: system sans title, compact section hierarchy, readable chart units,
  wrapped Spanish labels; brand mark comes from existing app assets.
- Spacing/layout: horizontal wrapping model tabs, two stacked cards, compact
  coverage, collapsed explanation, no second model rail or wide date toolbar.
- Colors/tokens: existing cream paper, white surfaces and green controls; stable
  blue Luna, amber Terra, rust Astra and olive Sol. Shape distinguishes methods.
- Assets: existing brand assets; chart marks are live data graphics, not raster
  approximations or images of charts. No generated data baked into the page.
- Copy/content: only standard 7/30/All-time periods, no reasoning-effort control;
  explicit estimates, different coverage populations, minimum-five spread and
  missing evidence. Counts match the filtered source projection.

## Interaction and evidence checks

- 7 days changes Sol to 39 speed / 40 TTFT / 55 retained turns and 1,428 timed
  responses; All time restores 284 / 1,724 / 2,078 and 12,463 responses.
- 30-day selection and keyboard ArrowLeft switch Sol to Astra correctly.
- GPT-5.5 remains selectable with 5,000 TTFT observations and an explicit missing
  speed state rather than a fabricated zero-speed curve.
- Spanish rendering at 760 CSS pixels remains within the viewport. Language
  preference and regional date/number formatting retain existing app semantics.
- About/table disclosures work; Sol's table contains 67 actual aggregate bins.
- Keyboard ArrowRight moves the linked readouts to the same September 4 bin
  while retaining the independent speed and TTFT values.
- Loading, unavailable response validation and focus restoration have focused
  regression coverage. Browser console had no warnings or errors in inspected
  states. Native sidebar and static runtime closure passed source tests.

## Validation and cost

- 42 promoted reconstruction/reader regressions pass.
- Five aggregation/controller tests pass, including a real worker reconstructing
  synthetic logs, restart reuse, failure isolation, coalescing and cancellation.
- Full local-companion suite: 320 passed.
- Full web UI suite: 600 passed; final result is retained in `ui-tests.log`.
- Native source lane: 98 passed, three artifact-only cases skipped.
- Native runtime closure, client export, static assets, navigation and localization
  focused checks passed. Architecture, API parity, i18n mirror, documentation and
  preflight gates passed on the locally edited source.

A 60-request cached loopback check over the real copied sidecar returned 25,438
bytes per all-history response: median 0.28 ms, p95 0.66 ms, maximum 15.40 ms.
This is a local warm-cache request measurement, not a controlled full-accounting
benchmark. The separate worker cannot add work to the accounting transaction;
concurrent OS I/O contention during cold backfill is still possible.

## Remaining qualification

Installed native rendering/build/signing and broader platform behavior are not
claimed. The preview uses a separate copy of the sidecar; the installed accounting
database was not modified. Cold historical scanning is deliberately incremental
and can take hours for tens of gigabytes; coverage remains marked as updating.
No release, installation or publication occurred.
