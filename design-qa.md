# Model performance percentile charts — design QA

## Evidence

- Source visual truth: `/Users/adamallcock/.codex/generated_images/01a092ce-c3bb-7e41-881d-c57e5100d3a0/exec-0714278c-8c23-44ef-a09e-3653cecd70dc.png`
- Final implementation capture: `/private/tmp/tibotattle-percentile-implementation-final-hover.jpg`
- Final combined comparison: `/private/tmp/tibotattle-percentile-design-compare-final.jpg`
- Earlier comparison: `/private/tmp/tibotattle-percentile-design-compare.png`
- Source dimensions: 1,487 × 1,058 pixels.
- Implementation dimensions: 1,046 × 741 pixels at a 1,046 × 741 CSS viewport and device scale factor 1.
- Normalization: the source was proportionally resized to 1,046 pixels wide for the combined comparison. The implementation was captured at native size. The final comparison focuses on the two chart cards because the selected visual was a direction for those charts inside the existing TiboTattle page, not a replacement for the surrounding product shell.
- State: Model performance, Sol, All time, daily UTC bins, pointer-selected interval with both linked tooltips visible.

## Findings

No actionable P0, P1 or P2 differences remain.

- Fonts and typography: the implementation retains TiboTattle's existing sans and display treatments while matching the target hierarchy: strong chart titles, quiet units, compact legends, prominent median values and smaller percentile details. Labels remain readable without collisions.
- Spacing and layout rhythm: both charts use aligned white cards, a consistent plot frame, reserved right-side endpoint-label space and a responsive stacked heading at narrow widths. The tooltip no longer compresses percentile values.
- Colors and visual tokens: the implementation deliberately maps the selected design's layered tonal treatment to the existing Sol olive token. The P10–P90 band is lighter than P25–P75, with the P50 line strongest. This is an intentional product-system adaptation, not unresolved drift.
- Image quality and asset fidelity: the design contains no raster imagery, logos or non-standard icons inside the chart treatment. The visualization is correctly implemented as data-driven SVG rather than a raster approximation; no image assets were required.
- Copy and content: legends and tooltips explicitly identify P10, P25, P50, P75 and P90. The user-facing copy avoids internal log-format provenance and describes missing-date bridges plainly.
- Interaction and accessibility: pointer inspection links both charts; keyboard-focusable observations retain accessible descriptions containing all available percentiles; sparse bins explain why percentiles are unavailable; missing dates remain visibly dashed rather than silently interpolated.
- Responsiveness: the chart cards and legends were inspected at the 1,046-pixel preview width. Existing narrow-width rules stack titles and legends and avoid horizontal page scrolling.

## Comparison history

### Pass 1 — blocked

- P2: the first implementation omitted direct endpoint percentile labels, making the distribution less explicit than the selected design.
- P2: the first tooltip packed too much information into one compressed line.
- Fixes: reserved plot space for collision-managed P90/P75/P50/P25/P10 endpoint labels; changed the tooltip to a vertically aligned percentile grid; made the median the tooltip's primary value.

### Pass 2 — passed

- Post-fix evidence: `/private/tmp/tibotattle-percentile-design-compare-final.jpg` shows the selected design and latest implementation together.
- The implementation now preserves the target's central visual idea while improving scanability: nested percentile ribbons, explicit boundary labels, a continuous median across sparse dates, dashed missing-date bridges and detailed linked inspection.

## Primary interactions and diagnostics

- Selected a date in Output speed and confirmed the linked First-token latency chart moved to the same UTC interval.
- Confirmed the tooltip reports P90, P75, P25, P10, the P50 median and measured-turn count without duplicating P50 as a secondary row.
- Confirmed sparse observations retain a hollow point and an accessible minimum-sample explanation.
- Browser console errors checked: none.

## Follow-up polish

- P3: a future iteration could add an optional compact data-coverage strip like the visual target, but the existing coverage summary already exposes the underlying counts and the user explicitly removed the redundant measurements table.

final result: passed
