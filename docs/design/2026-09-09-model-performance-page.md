---
title: Model performance page
date: 2026-09-09
type: spec
status: implemented-locally
---

## Purpose and placement

Add **Model performance** beside Trends and Usage and costs in the app navigation.
The page answers: how quickly do my models generate output, how long do I wait
for the first token, and how much evidence supports that picture?

This page is implemented locally on the timing branch, building on experiment
`7416b912`. It includes a separate, lazily started timing worker. The installed
app and published releases have not changed.
Initial provider scope is Codex. Other providers should appear only when their
measurements have a defined, supported contract.

Selected direction: the refined layered-percentile design approved on 2026-09-11.
It keeps the focused-model layout, existing 7-day/30-day/All-time filter and
narrow app viewport while making distribution summaries the chart's primary
visual hierarchy.

## Page hierarchy

| Position | Content | Main interaction |
|---|---|---|
| Header | Model performance; “Speed and responsiveness in your local sessions.”; last updated | Use existing app refresh/status controls |
| Period filter | Standard 7 days / 30 days / All time segmented control | One selection applies to both metrics and all counts |
| Model selection | Compact horizontal model names, with one selected | Switch the focused model without another vertical navigation rail |
| Output speed | Full-width trend, tokens/s; “Higher is faster” | Shared date cursor and selected model |
| First-token latency | Full-width aligned trend, seconds; “Lower is faster” | Same model, period and cursor |
| Coverage and explanation | Concise coverage summary; expandable “About these measurements” | Explain missing measurements and inspect method details |

Use a single scrolling page, with the model selection and first chart visible near
the top at desktop sizes. Reuse the surrounding app shell. In native delivery,
show only the page content beneath the native navigation, without a second sidebar.

## Filters and comparison

Preserve the user's last standard period selection. Use exactly the existing
**7 days / 30 days / All time** controls; first use selects All time.
Remove the custom date picker, reasoning-effort selector, 90-day preset and
separate zoom toolbar. This is a display window:
changing it must never rescan or discard the retained history. Both chart axes
use the same selected interval; empty stretches stay visibly empty.

Focus one model at a time. At the constrained width, replace the reference image's
secondary vertical model list with compact horizontal model tabs or a dropdown
when they do not fit. Model color stays stable across metrics and filtering.
Include models with TTFT but unavailable TPS; show the available metric rather
than excluding the model. Start with the last selected supported model, otherwise prefer a current model
with retained observations. The data includes all reasoning efforts; explain workload mix
inside the collapsed methodology, without exposing an effort filter.

Reserve the main width for the two charts and compact selected-model coverage.
Defer the wide multi-model comparison table and comparison mode. Do not create
an overall TPS average across models or declare a universal winner.

Each statistic is a median of eligible per-turn observations in the selection.
Show “—” for an unavailable metric. Speed includes reasoning tokens. A completed
turn contributes only the tokens and duration of its covered responses.

## Trends and variance

Use two vertically aligned charts for the selected model rather than miniature
panels. Show a subtle P10–P90 outer band, a stronger P25–P75 inner band and a
dark P50 median curve. These are empirical percentiles of eligible turns, not a
confidence interval or full probability density. The legend explicitly names
both percentile spans and the median, and moves below the title on narrow views.
Each chart subtitle carries its own coverage: output-speed turns on the speed
card, and first-token turns plus timed responses on the latency card. Do not
repeat those figures in a separate coverage strip.

Keep extreme observations in the calculations. The five-percentile view reduces
the visual influence of extremes without deleting data or classifying it as a
retry. Raw-turn drilldown is deferred. Any future individual-turn view may use
an explicitly labelled logarithmic scale. Never silently clip observations or
change scales.

Use daily bins through 366 days and weekly bins for longer All-time spans.
Label the interval and apply it consistently across models. Both All-time axes
begin at the selected model's earliest measured bin; 7/30-day axes retain their
whole selected calendar window. All boundaries are UTC. Require five observations per
method/model/bin for percentile bands. Sparse medians use hollow markers. Solid
segments connect adjacent measured bins; dashed, lower-emphasis median segments
connect later observed bins across missing dates so a sparse series remains
traceable. Percentile bands stop at missing dates. Never bridge between methods.

Y axes begin at zero and use rounded 1/2/5 increments, with enough decimal
precision for subsecond data. X ticks follow UTC days, Monday weeks, first/15th
month boundaries, or regular months/years according to the visible span.
Inspect any position in the plot by sweeping horizontally: the cursor snaps to
the calendar bin and both charts show that exact interval. Missing bins explicitly
report no measurements. Larger highlighted points and compact floating tooltips
replace point-only hover text. Keyboard users enter each chart once, move through
observed dates with arrows/Home/End, and dismiss inspection with Escape.


Combine every compatible TPS observation into one distribution per model and
time bin. Logging-format and timestamp-reconstruction details remain internal
implementation provenance: do not encode them as different shapes or expose them
in headings, labels, tooltips, accessible descriptions, or explanations. Use
circles throughout; a filled circle has enough observations for percentile bands,
while a hollow circle is a sparse median-only bin.
Do not imply that a logging-format transition is a model-speed change.
Do not describe newer logs as inherently more accurate. Both TPS methods are
estimates. Method distinctions apply only to TPS, not recorded TTFT.

The hover/focus readout shows the date interval, model, metric, P10, P25, P50,
P75, P90 and eligible turns. Do not fabricate per-bin counts. For example, use
“23 measured turns,” not “n = 23.” TTFT gets its own eligible-turn count; the
cursor must not imply paired observations when populations differ. The tooltip
anchors to the selected point, prefers the space above it and flips to the
opposite horizontal side of the cursor. It flips below only when the viewport
cannot fit it above, so it does not obscure the values it explains. Output-speed
display values use whole tokens per second; latency retains the precision needed
for subsecond data. The charts support keyboard focus and expose each plotted
point through an accessible description; do not duplicate the same aggregates
in a measurement table.

## Coverage is part of the measurement

Always show compact coverage in the chart subtitles, not only inside a tooltip.
For the current GPT-5.6 Sol all-history snapshot, compact examples are:

> tokens/s · Higher is faster · 284 of 2,078 turns measured
>
> seconds · Lower is faster · 1,724 of 2,078 turns measured · 12,463 timed responses

The explanation defines output speed and first-token latency, identifies medians,
variation and missing timing, and states that these are personal observations
rather than benchmarks. Provider-log formats and reconstruction mechanisms do
not belong in this user-facing explanation.

Distinguish retained history, the chosen display interval, and the actual measured
period when they differ. Show missing evidence as unavailable, not zero. Unknown
model attribution belongs in a coverage count, not an invented model category in
the comparative chart. Counts reflect the same filters as the plotted values.

## Loading, sparse data and accessibility

- Load saved aggregates immediately. A quiet “Updating…” status can accompany
  background indexing while the existing chart remains visible.
- If timing is unavailable, keep the page accessible and explain the state;
  failure must not block allowance or cost accounting.
- If TTFT is available but TPS is not, render TTFT and explain the missing starts
  in the speed panel. Avoid a page-wide empty state.
- If no timing is collected yet, explain what future compatible sessions can
  provide; offer the existing local-analysis action if appropriate.
- Use percentile labels, marker shapes and text alongside color, visible focus,
  sufficiently large targets, reduced-motion behavior and accessible point descriptions.
- Model tabs and the selected-model heading reuse the shared readable names,
  palette and decorative model icons used by the usage tables and other model surfaces.
- In narrow windows, stack the comparison information and charts; keep units,
  method distinctions and coverage visible without horizontal page scrolling.

## Visual direction and implementation boundary

Reuse the [existing design tokens](../../apps/web/public/styles.css): cream paper,
warm raised surfaces, dark ink, green controls, native system type and restrained
separators. Use established chart accent tokens with tested contrast. Let spacing
and typography establish hierarchy; keep technical explanations below the charts.

Initial delivery needs one page, the standard period filter, a model selector, two linked charts
and coverage details. Defer rankings, speed alerts, benchmark claims, project
filters and raw-turn drilldowns until their semantics and underlying data exist.

The view reads compact local aggregates from a fixed loopback route. Filter changes query cached timing
state; they do not parse rollouts or make external network requests. Keep ingestion,
sidecar compatibility and accounting-isolation qualification as separate gates
from approving this page design. The experimental historical backfill is not a
startup requirement for the product.
