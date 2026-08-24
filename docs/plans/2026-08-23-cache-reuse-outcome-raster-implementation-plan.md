---
title: Cache reuse outcome raster implementation
date: 2026-08-23
type: plan
status: implemented
---

# Cache reuse outcome raster implementation

## Goal

Replace the hard-to-scan time-band summary at the top of the cache-continuity
diagnostic with the selected real-data outcome raster. The visual answers one
plain question: for eligible follow-up turns with the same model and settings,
did the cache read retain more than half of the previous turn's cache read?

## Data contract

- Keep the existing material-drop, bounded lost-reuse, pricing, and allowance
  calculations unchanged.
- Add a separate ratio-based outcome partition for every eligible comparison:
  more than half versus half or less. Split the first outcome into matched or
  exceeded the previous cache read versus between half and the previous read.
- Publish ten fixed, half-open time buckets: under 1 minute, 1–2, 2–5, 5–10,
  10–30, 30–60 minutes, 1–6 hours, 6–24 hours, 1–3 days, and 3 days or more.
- Validate that both outcome lanes and all ten buckets sum exactly to the
  existing comparable-return total. No prompts, identifiers, paths, or exact
  event timestamps enter the projection.

## Product integration

- Use the dashboard's existing accounting period selector; do not introduce a
  second period control inside the chart.
- Present the chart as an always-visible accounting section when valid data is
  available. Keep only the recent large-drop evidence table in a separate,
  collapsed disclosure.
- Render a keyboard- and pointer-inspectable logarithmic time raster with a
  numeric readout, exact remainder mark, compact in-chart legend, and three
  summary cards: more than half, half or less, and estimated Standard API
  overhead from the detected large cache drops.
- Keep the recent-drop evidence table, but remove the duplicate aggregate
  wait-time table and its bridge paragraph because the chart readout now
  carries the same lost-reuse and Standard API evidence for each time range.
- Use plain-language copy in all supported locales. When Fast weighting cannot
  be resolved but the complete Standard-rate estimate exists, show that
  Standard estimate instead of a blank headline and label the fallback.
- Fail closed if methodology, partitions, bucket boundaries, or totals do not
  match the browser-owned contract.

## Verification

- Analyzer boundary, exact half-ratio, partition, projection, and privacy tests
  pass.
- Browser contract, DOM, three-locale copy, legacy fallback, and the complete
  326-test web UI suite pass after the redundant aggregate-table test was
  retired with its UI.
- Architecture, browser-catalog freshness, syntax, and diff checks pass.
- The local dashboard renders the selected design from the real unified index.
  The 7-day view showed 9,070 checked follow-ups; the existing 24-hour selector,
  pointer selection, and arrow-key selection all updated the numeric readout.
- The full changed-code lane was also run. Its feature-specific localization
  failure was fixed. Remaining failures are outside this change: the isolated
  checkout lacks the worker-only `jsonc-parser` dependency, managed sandboxing
  blocks socket and native-sandbox tests, and R7 release receipts require the
  separately authorized provenance-regeneration gate after source changes.

## Release boundary

This task changes source and validates the local development dashboard. A pull
request, merge, installed-app replacement, signed build, and public release are
separate gates and are not authorized by this implementation request.
