# Cache reuse outcome raster design QA

Date: 2026-08-23

## Comparison target

- Source visual truth: the user's Browser annotation and the matching nested
  source-state capture at
  `/private/tmp/cache-reuse-source-nested-701x737.jpg`.
- Final implementation:
  `/private/tmp/cache-reuse-implementation-standalone-701x737.jpg`.
- Side-by-side comparison:
  `/private/tmp/cache-reuse-placement-comparison-701x737.jpg`.
- Focused final placement:
  `/private/tmp/cache-reuse-standalone-with-evidence-disclosure-701x737.jpg`.
- Viewport: 701 × 737 CSS pixels at a reported device pixel ratio of 2.66.
- Source and implementation captures: 702 × 738 pixels each. The combined
  comparison is 1,404 × 738 pixels with no scaling between sides.
- State: Accounting, seven-day real-local-data view. The source chart is
  visible only because its parent disclosure is open; the implementation chart
  is a top-level section while the separate recent-evidence disclosure is
  closed. That disclosure-state difference is the requested product change.
- Data note: the paired captures use the same live values. The top refresh pill
  changed from Running to Fresh during capture and sits outside the component
  under review.

## Full-view comparison evidence

The chart's typography, metric cards, explanatory callout, raster geometry,
legend, axis, palette, and real-data values remain visually unchanged. The
implementation removes the disclosure's extra horizontal inset and lets the
chart read as a first-class accounting section. The chart is visible with the
recent-evidence disclosure closed.

The focused final capture shows the whole chart ending cleanly before a separate
"See recent large cache drops" disclosure. There is no longer an outer
"See cache reuse between turns" wrapper around the chart.

## Focused region comparison evidence

- The outcome section is a sibling before `#cache-continuity-details`, not a
  descendant of it.
- The recent-evidence disclosure contains the table and pagination only; it
  opens to ten current rows and closes independently of the chart.
- The three metric cards remain on one horizontal row at 701 pixels.
- The raster measures 632 client pixels and 632 scroll pixels; the page measures
  701 client pixels and 701 scroll pixels, so neither region horizontally
  overflows.
- Pointer selection still opens a floating numeric readout with the time range,
  checked follow-ups, both outcome counts and percentages, lost-reuse tokens,
  and Standard API equivalent.
- The 24-hour control updated the visible chart to 86.9% / 13.1% and $41.30;
  returning to seven days restored the selected seven-day state.

## Findings

No actionable P0, P1, or P2 findings remain.

## Required fidelity surfaces

- Fonts and typography: the existing serif display and sans UI stacks, optical
  weights, wrapping, and hierarchy are unchanged.
- Spacing and layout rhythm: the chart keeps its existing card padding and
  vertical rhythm. Removing the disclosure inset gives the standalone section
  the same width as adjacent accounting panels.
- Colors and visual tokens: existing green, rust, blue, surface, line, radius,
  and elevation tokens are unchanged.
- Image quality and asset fidelity: this view has no photographic or generated
  assets. The existing high-density canvas remains sharp at the live device
  ratio.
- Copy and content: the disclosure now truthfully describes its remaining
  content as recent large cache drops; the chart's accepted plain-language copy
  is preserved.
- Accessibility and behavior: the chart retains its labelled, focusable canvas
  and live readout. The evidence table remains a native disclosure with a clear
  summary. No render or error state appeared during reload, period changes,
  chart selection, or disclosure toggling.

## Comparison history

1. Earlier passes fixed chart overflow, axis alignment, readout placement,
   summary-card stacking, duplicated aggregate evidence, and the Standard-rate
   headline fallback.
2. This annotation pass found one hierarchy issue: the accepted chart was still
   owned by the recent-evidence disclosure.
3. The chart moved to its own always-visible section; the remaining disclosure
   was narrowed and relabelled.
4. The equal-size side-by-side comparison and direct browser measurements found
   no remaining P0, P1, or P2 issue.

## Implementation checklist

- [x] Moved the real-data chart out of the disclosure.
- [x] Kept the chart visible whenever valid continuity data exists.
- [x] Kept recent large-drop evidence collapsed separately.
- [x] Preserved chart visuals, interactions, period controls, and pagination.
- [x] Verified one-row cards and zero horizontal overflow at 701 × 737.

final result: passed
