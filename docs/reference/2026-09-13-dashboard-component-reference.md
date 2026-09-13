---
title: TiboTattle dashboard component reference
date: 2026-09-13
type: reference
status: proposed
---

# TiboTattle dashboard component reference

This reference names the shared visual contract for the local dashboard. The
page contract is scoped by `.dashboard-shell`, with the report toolbar scoped to the app header, so the public site can keep its own
page styling. Existing names remain supported as aliases while new markup can
use the clearer names below.

## Report context and controls

Place one `.reporting-period-toolbar` in the app header beside the brand.
Its `.segmented-control` (`#reporting-period-controls`) shows compact labels
`24hr`, `7d`, `30d`, and `All`, with full localized accessible names. The
selected choice uses `aria-pressed="true"`. The adjacent native disclosure
exposes `#reporting-period-range` through a click or keyboard activation;
its title also provides the exact dates on hover. Outside pointer interaction
and Escape dismiss it; Escape restores focus when focus was inside. At narrow widths the selector
wraps onto a second header row. Community hides the reporting control.

Page-local filters use the same `.segmented-control` and selected state. A
`.dashboard-filter-group` may pair a `.dashboard-filter-label` with a filter.
Filters are filled controls. A tablist uses `.dashboard-tabs` (or the existing
`.performance-models`) with child `[role="tab"]` elements and
`aria-selected="true"`; tabs use the baseline and underline treatment. Do not
represent tabs as period or filter pills.

Use `.dashboard-actions` (or `.dashboard-action-group`) for a wrapping group of
`.button` actions. Add `.dashboard-action-status` with `role="status"` when an
action has progress, retry, cancellation, or error feedback. Keep the status
text in the DOM while it is being updated so the live region does not move.

## Chart card anatomy

Use `.chart-card` for new cards; `.chart-panel` remains the existing alias. A
card should keep this order:

1. `.chart-card-header`, containing `.chart-card-title`,
   `.chart-card-description`, and, when needed, `.chart-card-controls`.
2. `.chart-card-legend`, after controls when a legend is present.
3. `.chart-card-body`, containing the chart or its state.

Existing `.chart-heading`, `.chart-control-stack`, `.legend`, and `.chart-shell`
map to the same roles. Allowance history and model-performance cards use these
shared classes. Legends are direct card children below the header, including
the usage timeline; they never compete with controls for header width.
Incomplete chart coverage uses amber and retains its full explanation.
Controls wrap at narrow widths and chart bodies retain
their overflow and pointer behavior.

## Loading, empty, and error states

Use one `.dashboard-state` in place of a data body. Add one state modifier or
`data-state` value: `loading`, `empty`, `error`, `partial`, `stale`,
`unavailable`, or `unknown`. Optional children are `.dashboard-state-icon`,
`.dashboard-state-copy`, `.dashboard-state-indicator`, and
`.dashboard-state-actions`. A loading state may animate its indicator; the
reduced-motion media query removes that animation. `.chart-empty` remains the
empty-state alias, `.performance-empty` is the model-performance alias, and
`.work-usage-empty` is the projects/threads alias. Status text in
`.work-usage-status` follows the same state colors.

State styling describes evidence availability and does not turn missing or
partial data into a number. Error and unavailable states should include a
plain-language explanation and, where useful, a retry action.

## Freshness, coverage, and technical detail

Use `.evidence-meta`, `.freshness-meta`, `.coverage-note`, `.dashboard-freshness`,
or `.dashboard-coverage` for quiet evidence metadata. Add `data-state="fresh"`,
`"stale"`, `"partial"`, `"error"`, or `"unavailable"` when the visual state
needs to be explicit. The existing `.series-coverage` and
`.timeline-confidence` notes retain their meanings and receive the same
surface rhythm. Keep measured/available counts and timestamps visible when
they explain coverage or freshness.

Long methodology, accounting, or provenance text belongs in
`.technical-disclosure` (or `.dashboard-disclosure`) with a direct child
`<summary>` and `.technical-disclosure-body` or `.dashboard-disclosure-body`.
Existing `.evidence-disclosure` and advanced disclosure names remain supported
for text-only details. The summary is keyboard reachable and its open state is
visible without relying on color alone.

All controls retain visible focus, at least the shared pointer target, readable
contrast in light and dark themes, and usable wrapping or horizontal scrolling
on narrow screens. These classes describe presentation and interaction; they
do not change the source, account scope, freshness, coverage, or uncertainty of
the underlying evidence.

## Observation freshness and allowance metrics

The Overview observation colour derives from its timestamp, age and freshness
threshold, independently of accounting readiness or a running refresh. Unknown
recency remains neutral. The header gives running work precedence while the
observation retains its own recency. Known old observations use a timestamp
label and card qualifiers without a repeated generic banner. Other stale
notices use a compact inline warning; accounting qualifications remain explicit.

Allowance cards align their title/source, value, progress and metadata rows
with a shared subgrid. Source chips sit below titles. Reset and observed times
share a bordered footer. Spark remains a separate blue limit and retains its
ordering. Stale cards include an Out of date label; unavailable percentages
have no progress bar. The percentage scale is consistent across pools.

## Compact model-performance context

Model performance uses the app header's reporting period in shared mode and
retains a local range only in standalone mode. Its status and cancel/retry
actions share one wrapping row. A progress/error status keeps a secondary
result timestamp; a ready status already contains that timestamp. Stale result
warnings remain explicit. Each chart's subtitle owns its measured/total count
and partial-coverage styling, without duplicate coverage cards above the tabs.

## Projects and threads controls and states

Grouping and search share a responsive toolbar with sort/model/scope and refresh.
Progress and cancellation use one action row. Observation and coverage stay in
inline metadata; the shared period is not repeated. Available empty reports
show an empty/search-empty state without a blank table or summary metrics.
Clearing search restores the report. Unavailable/expired reports retain their
separate recovery behavior and incomplete coverage remains explicit.

## Shared data tables

Model usage and project reports use `.dashboard-data-table` inside a labelled,
keyboard-focusable `.dashboard-table-scroll` region. Preserve native table-cell
layout and horizontal scrolling for wide data. Headers use sentence case;
numeric columns align right with tabular digits. Share figures and unavailable
money labels remain quieter than primary amounts, without changing their text.
Expanded/focused rows retain a background cue, and pagination may wrap without
truncating its status. Model share columns have distinct token/value labels for
assistive technology.

Chart placeholders use the shared state container and status semantics.
Unavailable Usage/Trends data uses a solid, neutral treatment; a period without
points keeps the dashed empty treatment and its existing explanation. Search
results with no matches offer Clear search, retain other filters, and return
focus to the search field while refreshing the result.

The Projects model filter reuses `model-visuals.js` ordering/icons and
`formatModelName`. All models precedes the observed model IDs; aliases remain
separate exact query values. Electron's customizable native select renders SVG
identities in options and the selected value. Other browsers retain a native
text select if customizable selects are unsupported.
