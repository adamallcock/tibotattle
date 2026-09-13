---
title: Trends visual design direction
date: 2026-09-13
type: research
status: accepted
---

# Trends visual design direction

Design rationale for the owner-approved integrated Horizon, accepted on
2026-09-13. The implementation reuses the existing chart engine and analysis,
with a brighter local-clock sky inside the allowance panel and all three
analytical views visible. Source and preview validation do not establish an
installed application or release. The user guide describes shipped behavior.

## Recommendation

Keep three visible sections with one selected time range and linked cursor:

1. **Allowance and activity:** observed remaining allowance above recorded
   activity, with separate units and classified reset events when available.
2. **Observed versus calculated depletion:** retain the three-hour rolling
   comparison as two directly labelled lines. Fill only their difference, then
   show its signed value in a shallow, zero-centred strip immediately below.
3. **Drift within each allowance cycle:** give cumulative drift its own plot,
   followed by the existing sustained-divergence periods and evidence inspection.

The first section explains what happened, the second compares the observation
with the estimate, and the third distinguishes a temporary disagreement from an
accumulating mismatch. Keep these sections visible. Only detailed fit assumptions
and exact evidence tables should require expansion.

## Research references and decisions

| Reference | Verified pattern | Decision for TiboTattle |
|---|---|---|
| [Apple Solar Dial](https://support.apple.com/guide/watch/faces-and-features-apde9218b440/watchos) | A 24-hour dial and a control for exploring solar events | Adapt the dedicated time-of-day instrument. Use one selected-day dial, not a dial for every day. |
| [Lumy](https://lumy.app/watch/) | Solar compass, event countdowns and time exploration | Adopt the precise ticks, restrained lighting and focused selected-time readout. Avoid turning every analytical chart into a decorative scene. |
| [Weathergraph](https://weathergraph.app/) | Multiple metrics share a timeline; sky and daylight are distinct visual information | Adopt coordinated time alignment. Reject a direct copy of the dense multicolour background because quota series already use colour to distinguish meanings. |
| [Apple chart guidance](https://developer.apple.com/design/human-interface-guidelines/charts) | Data hierarchy, summaries, whole-plot scrubbing and accessible interaction | Keep exact values and chart shape prominent; use motion to communicate a selection or range change. |
| [Grafana time-series guidance](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/time-series/) | Fill between series, annotations, shared time navigation | Adapt a difference area and event markers to make disagreement visible without mentally subtracting two lines. |
| [Apache ECharts features](https://echarts.apache.org/en/feature.html) and [D3 brushing](https://d3js.org/d3-brush) | Existing zoom, selection and interaction primitives | Reuse interaction machinery. Custom visual styling does not require inventing a new chart engine. |

The listed adaptations are design judgments, not claims that these products have
validated this particular quota-monitoring interface. Public reference images
for Weathergraph and Lumy were visually inspected.

## Day and night: three options

### A. Dedicated time-of-day control — considered

Put a compact luminous 24-hour dial beside the selected date and time. Scrubbing
any chart moves the dial marker and changes its local illumination; it never
changes the underlying data geometry. Precise ticks and soft depth provide the
material quality of the allowance tanks without requiring a large scene.

Below it, a narrow date strip selects the day or range. In seven- and thirty-day
views, keep the dial focused on the selected day. Avoid repeated moon/sun icons
and full-height striped backgrounds.

### B. Integrated day/night horizon — selected

The selected direction places a luminous sky in the first chart's header,
with the date, local time and replay controls integrated into that panel.
Bright blue daytime, warm evening and moonlit night track the selected time.
Sun and moon follow periodic coordinates without a reverse transition at
midnight. Data axes remain on a neutral surface.

### C. A time-of-day activity view

An optional day-by-hour heatmap answers when recorded work tends to happen.
Selection cross-highlights the other plots. This is useful as a later analysis
feature, not a substitute for chronological comparisons or a background texture.
Missing coverage must remain different from a measured zero.

Actual sunrise, sunset and twilight require a chosen location and date. Without
that context, label the instrument as local clock time and do not imply measured
solar events. Do not request location merely to decorate the page.

## Treatment of the two existing comparison graphs

### Three-hour rolling quota change versus cost-implied change

Use a solid observed line and a distinct calculated line on the same
percentage-point scale. Fill between them: warm colour for observed depletion
above the estimate, cool colour for below. Colour means signed difference, not
proof of waste, billing error or model quality. Direct labels and a common cursor
show both values and the difference for the same measured window.

A shallow signed difference strip below the plot makes short spikes easy to
locate. The selected three-hour window should be visible as a bracket on the
shared timeline. Missing brackets, exhausted pools, incompatible tracks and
unavailable pricing remain discontinuities with an evidence-state lane.

### Observed versus calculated movement

The previous renderer combined `residual` and `cumulativeResidual`. The design separates them:
keep the short-term difference beside the rolling comparison and give cumulative
drift its own chart. Retain existing reset/track anchors and saturation exclusions.
Do not sum overlapping rolling windows to manufacture a cumulative value. Keep
percentage points distinct from the separate signed-area metric in pp-hours.

A selected divergence period should focus every chart and open the existing
model/speed evidence. Reserve causal statements for evidence that supports them.

## Fidelity and interaction requirements

- Preserve the warm TiboTattle shell and use one consistent palette for data.
- Give the time control material depth; keep quantitative lines geometrically
  stable and immediately legible.
- Link hover, touch selection, keyboard navigation, range selection and replay.
- Use a single selection state so values, reset markers and detailed evidence
  never disagree about the active period.
- Animate selection and range changes. Idle effects must be subtle, stop offscreen,
  respect reduced motion and never imply an observation that was not recorded.
- Keep range-aware titles, exact timestamp inspection, shared freshness and
  readable labels at narrow widths.
- Validate dense real history, gaps, resets, exhaustion and absent classification
  before considering the visual design approved. A smooth synthetic example is
  insufficient.

## Implementation boundary

The [dashboard](../../apps/web/public/app.js) retains `liveTimelinePoints`,
`renderTimeline`, `residualRows` and `renderResiduals` as the calculation and
evidence owners. [Horizon presentation](../../apps/web/public/trends-horizon.js)
adds sky, cursor, replay, hourly readouts and geometry from those prepared values. No new
chart dependency or external request is required.

The [composition-aware expected-line contract](../design/composition-aware-expected-line.md)
remains authoritative for calibration and saturation semantics. Typed reset
classification is absent from the current companion payload; the presentation
must not fabricate scheduled or banked-reset labels. The allowance chart now
shows existing confirmed-drop decisions and recorded reset-boundary changes,
including boundary changes when pricing comparison is unavailable. Neighboring
events share a selectable numbered badge; the details retain their observed and
confirmation times. Existing evidence bands still identify excluded windows.

The selected-time header converts the existing rolling speed-priced total to an
hourly rate using its measured duration. Unknown pricing and stale samples stay
unavailable. Compact divergence rows lead with the signed peak gap, describe its direction
in plain language, and focus the shared chart viewport on selection. The
Models & speeds disclosure states its investigative purpose and provides an
explicit retry after failure. Speed names come from the keyed breakdown contract.
The exact-window table explains comparison quality in each row, states measured
spans, and distinguishes a valid comparison from agreement between the values.
Unknown quality is never labelled as matched. Detailed cost mix and signed-area
measurements remain behind disclosure.

The shared cursor, range, zoom and exact sample readouts use real prepared
series. Installation, signing, release and publication remain separate operations.
