---
title: Native menu-bar usage popover
date: 2026-08-24
type: plan
status: completed
---

# Native menu-bar usage popover

## Outcome

Replace the left-click status-item menu with a focused native AppKit popover
that answers three questions from current local evidence:

1. How much of each observed Codex allowance window remains?
2. Is weekly allowance use above, aligned with, or below elapsed-time share?
3. What did locally observed usage look like over the last 7 or 30 calendar
   days?

Right-click keeps the existing native actions menu. The regular TiboTattle
window remains the full-detail surface.

## Locked product boundaries

- No reset-credit availability, expiry, redemption, purchase, or related
  controls.
- No account email, account selector, plan badge, provider account identifier,
  or sign-in credential handling.
- No new endpoint, persistence, export field, community field, log field, or
  background process. The popover reads the existing loopback overview through
  the existing ephemeral no-cookie, no-cache reader.
- Ordinary quota-window reset times remain visible only while their own
  observation is current. These are allowance-window facts, not reset credits.
- Cost is always labelled API-price equivalent and never subscription billing.
- Missing, stale, retained-but-not-authoritative, or partially priced evidence
  is named as such. It is never rendered as an authoritative zero.

## Interaction and visual contract

- Left-click toggles one transient `NSPopover`; right-click or Control-click
  opens the existing native `NSMenu`.
- Fixed 400 pt width, content-driven height, no scroll view. The 640 pt height
  used by deterministic captures is a fixture size, not a runtime invariant.
- Header: product mark/name, freshness text, and native more-actions button.
- Allowance: exactly two fresh-only tracks—the five-hour window and the
  seven-day window—with reset times when observed. There is no generic credit,
  balance, or reset-credit row.
- Weekly position: two same-scale rows for `Elapsed` and `Used`, plus a textual
  `Below even pace`, `On even pace`, or `Above even pace` classification. This
  is explicitly a one-observation position comparison, not an exhaustion
  forecast.
- Local history: native 7d/30d segmented selector and daily local-calendar
  token bars. The selected period also shows its observed token total, event
  count, and API-price equivalent when pricing coverage supports that claim.
- Footer: `Open TiboTattle` and `Refresh`; the header more button exposes the
  full existing native actions menu.
- Use the existing brand palette and AppKit semantic colors, system typography,
  monospaced numeric labels, native focus rings, and SF Symbols.

## Evidence rules

- Quota and accounting have independent evidence gates and derive from one
  overview generation.
- A quota lane is numeric only when it is a normal Codex lane, has valid finite
  complementary percentages, has its own observation and reset timestamp, is
  inside the companion freshness window, and has not reset yet.
- Weekly position uses the lane's observed timestamp for both elapsed and used
  markers. Whole-percent classification allows only a one-point rounding band:
  differences at or below -2 are below, -1 through 1 are aligned, and at or
  above 2 are above.
- Accounting periods are the exact rolling `24h`, `7d`, and `30d` rows. The UI
  says `Last 24 hours`, never `Today`.
- Daily charts aggregate existing 15-minute buckets by local civil day using
  Calendar boundaries. Fully covered empty days are zero; days outside coverage
  or insufficient evidence are named gaps. Partially observed days are marked
  partial rather than implied complete. Token bars remain valid when prices are
  partial; dollar claims say that only a known subtotal is available, and are
  withheld when pricing coverage is missing.
- While refresh is running, still-fresh evidence remains visible with an
  updating state. Once freshness expires, values disappear atomically.

## Implementation slices

1. Add pure popup accounting and daily-history projections and fixtures.
2. Add the AppKit popover view controller and custom allowance, position, and
   chart views.
3. Route status-item clicks, synchronize the popover with the existing status
   snapshot, and preserve the native right-click menu and shortcuts.
4. Localize English, Spanish, and Simplified Chinese copy and accessibility.
5. Replace the menu-only compiled smoke with layout, state, data, and semantic
   routing receipts; update source-contract tests and native documentation.
   Routing tests exercise the pure left/right/Control-click decision and its
   compiled wiring, not synthetic operating-system mouse injection.
6. Render deterministic light and dark fixtures, compare them with the selected
   design reference, fix visible mismatches, then run focused and full macOS
   validation.

## Acceptance gate

- 7d renders seven daily positions and 30d renders thirty, preserving gaps.
- Selector, headline, chart, axis labels, tooltip/accessibility summary, and
  coverage copy update together.
- Stale/unavailable quota never exposes an old percentage, reset countdown, or
  weekly-position value.
- Unavailable accounting never appears as `$0.00`, `0 tokens`, or empty bars.
- No popup source, localized copy, accessibility label, fixture, or screenshot
  contains reset-credit availability/detail/expiry, purchase, or redemption
  behavior.
- Light and dark English, Spanish, and Simplified Chinese layouts have no
  clipping or overlap. High-contrast behavior stays on native semantic colors
  and controls rather than a synthetic appearance fixture; Reduce Motion and
  Reduce Transparency remain usable.
- Semantic routing tests cover left-click popover and right/Control-click menu
  intent. Packaged validation covers native wiring, `Command-R`, Escape,
  dismissal/focus behavior, polling, freshness expiry, and action ownership;
  it does not claim operating-system mouse-injection coverage.

## Final validation receipt

- Focused macOS source lane: passed, including all 46 active source tests and
  six localization tests; three artifact-only tests were intentionally skipped.
- Compiled menu-bar contract: passed exact-lane, per-lane freshness, malformed
  input, DST, overlap, coverage, pricing, routing, Escape, and refresh states.
- Deterministic visual smoke: passed 11 PNGs covering 7d/30d, light/dark,
  English/Spanish/Simplified Chinese, partial pricing, fully unpriced, and
  unavailable states.
- Full macOS lane: 57 passed, 0 failed, 0 cancelled, 0 skipped. The final run
  used macOS `caffeinate` after two earlier host-suspension clock jumps tripped
  packaging watchdogs; the same affected paths also passed focused warm runs.
