---
title: Public homepage feature tour
date: 2026-09-15
type: plan
status: local-preview
---

# Public homepage feature tour

Scope: improve the public website in the current checkout. No publication,
installer change or app release is authorized by this work.

- Preserve the original headline and community hero. Below it, showcase
  the actual allowance tanks and forecast, using an optimized,
  silent app recording with a static poster and accessible playback control.
- Give history playback, cache continuity, allowance valuation, usage
  breakdowns, project attribution and sharing controls visible sections.
- Preserve verified download metadata, unavailable states, community charts,
  localization, keyboard access and reduced-motion behavior.
- Keep preview figures explicitly identified as examples. Exclude project
  names, thread titles and other private session content from public assets.
- Extend the public asset closure narrowly for reviewed local MP4 videos and
  poster references. Preserve rejection of local-dashboard assets.
- Validate media controls, release-site generation, browser layouts at desktop
  and mobile widths, and the owning UI/release-site test gates.

Use the supplied recordings for tanks/forecast and history. Use cropped,
content-free app views for cache and valuation; no private project table.

## Validation

- UI suite: 735 tests pass; release-site suite: 36 tests pass.
- Browser catalog regeneration/check and tracked whitespace checks pass.
- Rendered the revised desktop tour with the supplied app recordings. Narrow
  layout reports no horizontal overflow; mobile visual review remains limited
  by the browser screenshot emulation output.
- Preview: http://127.0.0.1:8801/?revision=features-below-community#features
  in generated-source-offline mode. Published installer metadata could not be
  loaded by the preview tool, so download/community unavailable states appear.
- Repository preflight is blocked by pre-existing untracked nested package
  links (`packages/accounting/accounting`); these were left untouched.
- No publication or installed-app changes were performed.

## Interactive showcase revision

Added a self-contained, explicitly illustrative tank with three pace controls,
fixed remaining level, changing flow/color/spill, and a motion pause. The actual
recording remains available in a disclosure. Added a contrasting history stage
and a closing download anchor. The existing hero and community view remain intact.

Validated the three-state control and pause with a focused interaction test;
all five feature tests pass, alongside the 735-test UI run and 36-test release
run. Browser inspection confirmed the high-pace state renders and responds.
Preview: http://127.0.0.1:8802/#features (offline source preview).

## Reuse correction

Removed the bespoke CSS tank. Imported `allowance-tank-renderer.js` and
`allowance-tanks.js` byte-for-byte from the clean allowance implementation
at commit 91943d63. The website calls `drawAllowanceTank` and the existing
`createTankMotion`; only illustrative inputs, controls and website lifecycle
remain in the feature module. This checkout predates the app integration, so
its unrelated dashboard implementation was not replaced.

Verified source equality with `cmp`, browser rendering at critical pace,
29 focused tests, 736 UI tests and 36 public-release tests.
Updated preview: http://127.0.0.1:8803/#features.

## Forecast demonstration

Added the app-style forecast beneath the shared tank, reusing the timeline
layout and motion rules. Example states update the badge, run-out duration,
reset duration and empty period together. Times expose fixed illustrative
timestamps on hover. The critical example has 33% remaining, 10x pace,
14 hours until depletion and 5 days 6 hours without allowance before reset.
Rendered and inspected the critical state in the browser.
Preview: http://127.0.0.1:8804/#features.

## Interactive week

Replaced the history recording with the app's unchanged `trends-horizon.js`
module and its existing sky/control styling. A website adapter supplies a
bounded synthetic week, chart axes and series models. The shared module owns
playback, scrubbing, linked readings, filled series and reset interactions.
Example figures are visibly labelled; no private activity is included.
Preview: http://127.0.0.1:8805/#week-demo.

## Interactive cache and model speeds

Replaced the cache screenshot with the app memory matrix and added the existing
model-performance component below it. Thin adapters provide deterministic,
content-free synthetic examples, visibly labelled as demonstrations rather than
measurements or benchmarks. Model selection, time-gap details, period controls
and distribution charts retain the app interactions. The original headline and
community area remain unchanged.

Validated 740 UI tests, 36 public-release tests, browser i18n generation and
whitespace checks. Browser inspection verified cache model filtering and gap
selection, plus model and seven-day selection in the speed panel.
Local preview: http://127.0.0.1:8806/?revision=shared-insights#cache-demo.
No public deployment performed.

## Compact feature layout — 2026-09-16

Scoped marketing CSS now places copy beside allowance, history and cache demos
on wide screens, reduces padding and tank dimensions, and displays speed and
latency cards side by side. Shared app renderers and data remain unchanged.
Measured desktop section heights fell from 1169/1185/1052/1663 pixels to
809/793/754/817 pixels respectively. Checked desktop screenshots and the
390px cache layout without horizontal overflow. UI 740/740 and public-release
36/36 tests pass; git diff whitespace check passes.
Preview: http://127.0.0.1:8807/?revision=compact#cache-demo.

## Natural illustrative histories — 2026-09-16

Replaced repeating example activity with varied work sessions, idle nights,
weekend lulls and a Thursday-morning reset. Speed examples now use uneven daily
sample counts, independent latency variation and changing distribution widths.
Sparse bins retain the app contract's absent percentiles. Period filters slice
one fixed history, verified by a regression test. Data remains synthetic and
labelled, with no private records or benchmark claims.
Browser-inspected both demos and exercised seven-day selection. UI 741/741,
public-release 36/36 and whitespace checks pass.
Preview: http://127.0.0.1:8808/?revision=natural-data#week-demo.
