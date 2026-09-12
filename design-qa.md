# Model performance percentile charts — design QA

## Evidence

- Source visual truth: `/Users/adamallcock/.codex/generated_images/01a092ce-c3bb-7e41-881d-c57e5100d3a0/exec-0714278c-8c23-44ef-a09e-3653cecd70dc.png`
- Reported hover-state source: `/var/folders/tv/4fwgy5qn2j3789gfz33ps_xr0000gn/T/codex-clipboard-6dc540ef-6f26-4ecc-85f4-0781ccf82ffc.png`
- Final implementation captures: `/private/tmp/tibotattle-performance-tooltip-left.jpg` and `/private/tmp/tibotattle-performance-tooltip-right.jpg`
- Final combined comparison: `/private/tmp/tibotattle-tooltip-design-compare-final.jpg`
- Earlier comparison: `/private/tmp/tibotattle-percentile-design-compare.png`
- Source dimensions: original visual 1,487 × 1,058 pixels; reported hover screenshot 3,824 × 2,366 pixels.
- Implementation dimensions: 607 × 741 pixels at a 607 × 741 CSS viewport and device scale factor 1.
- Normalization: the reported browser region was cropped to 1,675 × 1,950 pixels and proportionally resized to 607 pixels wide beside the native implementation capture. The comparison focuses on the two chart cards because the selected visual was a direction for those charts inside the existing TiboTattle page, not a replacement for the surrounding product shell.
- State: Model performance, GPT-5.6 Sol, All time, daily UTC bins, pointer-selected intervals on both the left and right halves with linked tooltips visible.

## Findings

No actionable P0, P1 or P2 differences remain.

- Fonts and typography: the implementation retains TiboTattle's existing sans and display treatments while matching the target hierarchy: strong chart titles, quiet units, compact legends, prominent median values and smaller percentile details. Labels remain readable without collisions.
- Spacing and layout rhythm: both charts use aligned white cards, a consistent plot frame, reserved right-side endpoint-label space and a responsive stacked heading at narrow widths. The tooltip no longer compresses percentile values.
- Colors and visual tokens: the implementation maps the selected design's layered tonal treatment to the shared Sol orange used by the repository's other model surfaces. The P10–P90 band is lighter than P25–P75, with the P50 line strongest.
- Image quality and asset fidelity: the design contains no raster imagery, logos or non-standard icons inside the chart treatment. The visualization is correctly implemented as data-driven SVG rather than a raster approximation; no image assets were required.
- Copy and content: legends and tooltips explicitly identify P10, P25, P50, P75 and P90. Output-speed values use whole tokens per second. Each metric subtitle now carries its own coverage, and the redundant coverage strip is absent.
- Interaction and accessibility: pointer inspection links both charts; tooltips prefer the space above the selected point and flip to the opposite horizontal side of the cursor; keyboard-focusable observations retain accessible descriptions containing all available percentiles; sparse bins explain why percentiles are unavailable; missing dates remain visibly dashed rather than silently interpolated.
- Responsiveness: the chart cards and legends were inspected at the 607-pixel preview width. Below 480 pixels the tooltip becomes an in-flow panel beneath the SVG rather than obscuring a narrow chart.

## Comparison history

### Pass 1 — blocked

- P2: the first implementation omitted direct endpoint percentile labels, making the distribution less explicit than the selected design.
- P2: the first tooltip packed too much information into one compressed line.
- Fixes: reserved plot space for collision-managed P90/P75/P50/P25/P10 endpoint labels; changed the tooltip to a vertically aligned percentile grid; made the median the tooltip's primary value.

### Pass 2 — passed

- Post-fix evidence: `/private/tmp/tibotattle-percentile-design-compare-final.jpg` shows the selected design and latest implementation together.
- The implementation now preserves the target's central visual idea while improving scanability: nested percentile ribbons, explicit boundary labels, a continuous median across sparse dates, dashed missing-date bridges and detailed linked inspection.

### Pass 3 — blocked after user review

- P1: the fixed tooltip position covered the selected data and clipped at the card edge.
- P2: speed retained unnecessary decimal places.
- P2: coverage was repeated in a separate strip instead of living with the relevant metric.
- P2: the model surface used short names, bespoke colors and no shared iconography.
- Fixes: anchored the tooltip to the selected point, added viewport-aware above/below placement and opposite-side horizontal flipping; rounded speed display values; moved coverage into metric subtitles; reused `formatModelName`, `modelUsagePresentation` and `modelThemeIcon`.

### Pass 4 — passed

- Post-fix evidence: `/private/tmp/tibotattle-tooltip-design-compare-final.jpg` shows the reported and refined hover states together.
- The selected point, cursor and endpoint labels remain visible while the tooltip occupies the opposite side above the point. Both left- and right-side captures confirm the flip.

## Primary interactions and diagnostics

- Selected a date in Output speed and confirmed the linked First-token latency chart moved to the same UTC interval.
- Selected dates on both halves of the chart and confirmed both tooltips reverse horizontally and prefer the space above their selected point.
- Confirmed the tooltip reports P90, P75, P25, P10, the P50 median and measured-turn count without duplicating P50 as a secondary row.
- Confirmed Output speed rounds its median and percentiles to whole tokens per second while latency retains tenths.
- Confirmed the shared GPT-5.6 Sol name, sun icon and Sol color render in both the model tab and selected-model heading.
- Confirmed sparse observations retain a hollow point and an accessible minimum-sample explanation.
- Browser console errors checked: none.

## Follow-up polish

- No remaining P3 item is required for this iteration.

final result: passed
