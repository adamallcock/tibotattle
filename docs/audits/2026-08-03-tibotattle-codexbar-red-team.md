---
title: TiboTattle Native Menu and CodexBar Red-Team Audit
date: 2026-08-03
type: review
status: open
---

# TiboTattle Native Menu and CodexBar Red-Team Audit

## Verdict

**Do not treat the current macOS client as release-ready.** The local measurement, privacy boundary, and regular-app architecture are good product foundations, but the primary menu-bar interaction has a real rendering defect and the native UI regression suite cannot detect it. The installed application also remains materially behind CodexBar in the narrow areas that matter for a menu-bar companion: immediate legibility, stable menu presentation, clear refresh state, and useful preferences.

This is not a recommendation to turn TiboTattle into a multi-provider credential collector. Its single-source, local-first boundary should remain.

## Evidence reviewed

- Repository checkout: `main` at `a8a8dd5`.
- Installed bundle: `/Applications/TiboTattle.app`.
- User-provided menu screenshot from 2026-08-03: blank header rows and separators followed by otherwise normal action rows.
- Live installed dashboard and Settings/About inspection using the macOS accessibility tree.
- Six independent read-only agent reviews: native-menu code, state handling, test coverage, source comparison, and product scope.
- CodexBar source pinned at [`e17b14d`](https://github.com/steipete/CodexBar/tree/e17b14d269ba0a247ee6b813e0029ccc5d8aef81), checked on 2026-08-03.

The focused `node --test test/macos-app-bundle.test.js` suite passed. That is not a contradiction: its menu test reads Swift source text rather than instantiating or opening an `NSMenu`.

## Findings

| Severity | Finding | Evidence | Required correction |
|---|---|---|---|
| High | **The menu summary and lane rows can render blank.** | `MenuBarSummaryView()` and `MenuBarQuotaLaneView()` are installed as `NSMenuItem.view` with their default zero frame, while the native text fallback is hidden. Internal Auto Layout constraints do not give the enclosing menu item a reliable size. This matches the observed empty header shell exactly. | Initially restore standard native `NSMenuItem` text rows, or give every custom view an explicit frame/intrinsic content size and retain a visible fallback. Add a real AppKit rendering test before retaining custom rows. |
| High | **A stale/restarted companion can leave an old allowance looking live.** | `companionStarting()` clears the URL but not the observed lanes/evidence; an overview read failure returns without re-evaluating freshness. Existing callbacks also only require a non-nil dashboard URL. | Version companion reads with a generation token; invalidate numeric evidence on start/restart/failure; re-evaluate expiry before every render; ignore superseded callbacks. |
| Medium | **The menu mutates while macOS is tracking it.** | `menuWillOpen` starts asynchronous reads, then callbacks add/remove lane rows while the menu is open. This can produce stale, flickering, or inconsistent menu content. | Render cached state synchronously; defer structural rebuilds until `menuDidClose`, or use a popover only if it earns the added complexity. |
| High | **Tests assert intentions, not the shipped native interaction.** | `test/macos-app-bundle.test.js` uses regex checks for strings, selectors, and source snippets. The `--smoke-test` exits before `NSApplication` and the status item are created. | Add a GUI-capable test mode with injected reader/clock/actions. Assert the menu's item sequence, non-zero custom-view sizes, titles, enabled state, shortcuts, stale/failure/restart behavior, and Settings/About/updater routes. |
| Medium | **The menu-bar icon is generic rather than recognisable.** | The status item deliberately uses `chart.bar.fill`. It is conventional but visually anonymous beside CodexBar. | Design a monochrome TiboTattle template meter: fresh remaining capacity, neutral unavailable/stale state, and a bounded analyzing state. Do not place the full colour app icon at 15 px. |
| Medium | **The menu communicates little beyond actions.** | Even if the custom rows render, the proposed menu is mostly disabled information followed by actions. There is no visible refresh progress, refresh reason, explicit manual shortcut, or display-density choice. | Use a compact, stable mini-dashboard: one primary lane, an optional second lane, last-observed wording, a single “Refresh now” action, Settings, and About. Add `⌘R`, `⌘,`, and `⌘Q`. |
| Medium | **Settings are native but too thin to own current behaviour.** | The live window has useful General and About panes, with working website/GitHub/X links, but no Menu Bar, Refresh, or Updates preferences. | Keep the removed no-op Privacy pane removed. Add three focused panes only when each has real controls: Menu Bar, Refresh, and Updates. |
| Medium | **The window mixes polished native chrome with a long web report.** | The live sidebar is a native split view, but Overview/Allowance/Trends remain routes in a WebKit report. This produces a conventional app shell around a scroll-heavy dashboard rather than clear native page ownership. | Keep complex report/chart content in WebKit temporarily, but make Overview a native, glanceable landing surface and give each sidebar item one bounded destination. Do not rewrite every chart before the menu is correct. |

## Why the visible menu fails

The failure is code-level, not a matter of data being stale. The default constructors at [MenuBarStatus.swift:664](../../apps/macos/Sources/MenuBarStatus.swift#L664) and [MenuBarStatus.swift:957](../../apps/macos/Sources/MenuBarStatus.swift#L957) create views with a zero frame. Those views are attached at [MenuBarStatus.swift:699](../../apps/macos/Sources/MenuBarStatus.swift#L699) and [MenuBarStatus.swift:963](../../apps/macos/Sources/MenuBarStatus.swift#L963), while `evidenceItem` is hidden. AppKit can then display the menu container and the action items but has no sized native content to paint for the header/lane rows.

The immediate repair should be conservative: use ordinary native menu rows first, then add custom cards only after an explicit-size AppKit test proves them in live, stale, starting, and failure states.

## CodexBar comparison: copy the interaction discipline, not the product scope

CodexBar has useful implementation patterns:

- a real meter renderer that dims stale state rather than pretending it is current;
- keyboard-accessible `Refresh`, `Settings`, and `Quit` actions;
- a pure adaptive refresh policy which varies cadence by interaction and power conditions;
- deliberate menu tracking, deferred open-menu refresh, and cached content;
- native preferences with discoverable categories.

Its MIT license permits reuse of substantial code if the license and copyright notice are retained. That does **not** make copying its brand, iconography, provider scrapers, browser-cookie acquisition, API-key storage, OAuth flows, or multi-account switching appropriate for TiboTattle.

TiboTattle should retain its regular foreground app, Dock presence, single-Codex-source model, loopback-only local companion, fresh-evidence rule, and explicit first analysis. It should borrow the native interaction bar, not CodexBar's credential surface area.

## Recommended repair order

1. **Repair the menu correctness first.** Replace/safely size the custom views, invalidate data on restart/read failure, stop asynchronous structural mutation during tracking, and create a real native-menu test harness.
2. **Make the status item legible.** Add the TiboTattle template meter and simple fresh/stale/analyzing states. Keep numeric evidence suppressed unless the companion calls it current.
3. **Make refresh unsurprising.** One manual refresh action with `⌘R`, a visible running state, plus a modest adaptive/on-open policy that does not inspect processes or raw files beyond the established local scan.
4. **Give settings real ownership.** Add Menu Bar, Refresh, and Updates panes only with concrete controls; retain General and About. The current About links are already present and should stay.
5. **Improve the primary window deliberately.** Make native Overview the short answer; keep long-form allowance/trend evidence in WebKit until a measured AppKit/SwiftUI migration provides a real benefit.

## Release gate

Do not ship another client build until item 1 is fixed and the installed bundle is manually opened through all four menu states: starting, live, stale, and unavailable. The test should capture the same states automatically thereafter.
