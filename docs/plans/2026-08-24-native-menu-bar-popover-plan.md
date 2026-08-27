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
2. Is the observed weekly allowance trend under, near, or over the sustainable
   pace needed to reach the current reset?
3. What did locally observed usage look like over the last 7 or 30 calendar
   days?

Right-click keeps the existing native actions menu. The regular TiboTattle
window remains the full-detail surface.

## Locked product boundaries

- No reset-credit availability, expiry, redemption, purchase, or related
  controls.
- No account email, account selector, plan badge, provider account identifier,
  or sign-in credential handling.
- No new persistence, export field, community field, log field, or background
  process. The popover reads the existing loopback overview plus one narrow
  read-only `/api/local/weekly-pace-outlook` projection through the existing
  ephemeral no-cookie, no-cache reader. That route re-projects the retained
  strict forecast against request time without rerunning accounting or cloning
  and serializing the full weekly analysis.
- Ordinary quota-window reset times remain visible only while their own
  observation is current. These are allowance-window facts, not reset credits.
- Cost is always labelled API-price equivalent and never subscription billing.
- Missing, stale, retained-but-not-authoritative, or partially priced evidence
  is named as such. It is never rendered as an authoritative zero.

## Interaction and visual contract

- Left-click toggles one transient `NSPopover`; right-click or Control-click
  opens the existing native `NSMenu`.
- Fixed 400 pt width, content-driven height, and no scroll view. Deterministic
  captures measure the rendered content rather than imposing a runtime height.
- Header: product mark/name, freshness text, and native more-actions button.
- Allowance: exactly two fresh-only tracks—the five-hour window and the
  seven-day window—with reset times when observed. There is no generic credit,
  balance, or reset-credit row.
- Weekly pace: the companion's existing multi-observation forecast produces a
  closed, privacy-safe outlook with `Under`, `Near`, `Over`, or `Well over
  sustainable pace`, plus the precomputed portion of time to reset that the
  allowance should cover. One compatible observation renders `Collecting
  pace`; native code never invents a trend. A recent-active-use marker appears
  only when the shared projection says that rate would exhaust materially
  sooner than the headline trend.
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
- The weekly pace outlook reuses `quota-pace-forecast-v0.2` through the
  companion-side `local-weekly-pace-outlook-v0.1` presentation projection.
  Sustainable-pace standing, critical state, covered/dry hours, spare percent,
  projected exhaustion, and track geometry are computed once in shared
  JavaScript and consumed by both web and native surfaces. Swift performs exact
  schema validation and binds the result to the live weekly lane's reset and
  remaining percentage; it does not maintain a competing forecast formula.
  Both overview and forecast selection prefer a present `primary` weekly slot
  and use `secondary` only as the deterministic fallback, so transitional
  dual-slot payloads cannot hide an otherwise valid outlook.
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
2. Add the AppKit popover view controller and custom allowance, pace, and
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
  weekly-pace value. An invalid, unavailable, mismatched, expired, or
  out-of-order pace response hides only that section and cannot blank valid
  allowance or accounting evidence.
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
  dismissal/focus behavior, pure freshness/projection boundary decisions, and
  action ownership. Source contracts cover the sequenced overview/outlook poll
  and stale-response guards; this does not claim wall-clock scheduler or
  operating-system mouse-injection coverage.

## Final validation receipt

- Focused macOS source lane: 50 passed and three artifact-only tests skipped;
  the separate localization command passed all six tests.
- Reproducible packaged-app test: passed under macOS `caffeinate`, including
  exact-lane selection, per-lane freshness, malformed input, DST, overlap,
  coverage, pricing, routing, Escape, projection expiry, and refresh states.
- Deterministic visual smoke: passed 15 content-driven PNGs covering 7d/30d,
  light/dark, English/Spanish/Simplified Chinese, collecting/under/on/over/
  critical pace, partial pricing, fully unpriced, and unavailable states.
- Current-code compatibility: all 75 unified-index tests, 52 companion/outlook
  boundary tests, 33 browser/pace tests, and three real child-process tests
  passed. The process lane includes a restart from an exact populated
  production-era v9 schema into authoritative v11 without losing its owner,
  events, or token totals.
- The repository-wide run reached 3,619 tests (3,543 passed, 60 skipped, 16
  failed). Its failures were outside this feature: missing optional build
  dependencies in the isolated worktree, existing localization/source-receipt
  drift, and sandboxed packaging/loopback constraints. The relevant lanes above
  were rerun green after the final fixes. A redundant full DMG/updater rerun was
  stopped after the reproducible packaged-app path passed; this is not a
  release or publication receipt.
