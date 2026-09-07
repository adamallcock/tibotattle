---
title: Tray and menu bar customization
date: 2026-09-07
type: plan
status: in-progress
---

# Tray and menu bar customization

The owner authorized complete implementation of TRAY-01 through TRAY-12 on
2026-09-07. Native work is isolated on `codex/tray-customization` from
`11276bb84793b273276a3026029d3a8efb99467e`; Electron work is isolated on
`codex/electron-tray-customization` from `aead5d00`. The original phased backlog
below records the design rationale; this implementation covers the full accepted
set. Publication, installation and broader platform qualification remain separate.

## Evidence and starting point

- [Community PR #73](https://github.com/adamallcock/tibotattle/pull/73), inspected
  on 2026-09-07 at `57b04b7aadbda041c2642206b060ea3520e2b740`, remains open. It
  adds 5-hour, weekly, both and off modes in native macOS Settings, with local
  persistence and three localizations. Its single-window examples omit labels.
- The inspected native source at `ea4a4d41a107a38452a7417310a956a612df63f8`
  already checks freshness separately for each allowance window, retains valid
  values during analysis, and has a popup containing allowances, weekly pace
  and local usage history. These are contracts to preserve when adapting #73.
- The Electron workstream inspected at `a3458668af58e46931e2ccd5b90e01d7eb1c4871`
  has corresponding status, settings and popup modules. Its settings update
  allowlist has no tray-layout preference. Its source and QA records are not
  proof that these features are installed or supported on every platform.
- GitHub main was `11276bb84793b273276a3026029d3a8efb99467e` at this review.
  The source observations above are pinned snapshots; reconcile against the
  implementation branch before coding.

## Product decisions proposed

Treat the always-visible bar and the popup as separate surfaces. The bar answers
one quick question; the popup provides the detail the user chooses. Changing
presentation must not change collection, refresh frequency, contribution,
notification thresholds or the dashboard's selected period.

Use remaining allowance consistently in the first release. Label compact values
`5h` and `7d`; spell out “5-hour remaining” and “7-day remaining” in settings,
tooltips and accessible names. A 7-day provider window is not a calendar week.

Keep one tray icon. Do not rotate metrics automatically or change a selected
5-hour value into a 7-day value when evidence disappears. A stable choice is
more useful than a changing number whose meaning the user must rediscover.

## Core feature set: six features

| ID | Feature | User-facing behavior | Acceptance boundary |
|---|---|---|---|
| TRAY-01 | Bar presets | Choose 5-hour remaining, 7-day remaining, both, or icon only | `5h 63%`, `7d 94%`, `5h 63% · 7d 94%`, or the icon; one value per window |
| TRAY-02 | Icon appearance | Choose app icon or app icon with remaining-allowance meter | Meter follows the selected single window; both/icon-only modes use an explicit 5-hour/7-day meter choice |
| TRAY-03 | Popup sections | Show, hide and reorder Allowances, Weekly pace and Local usage | Up/down controls work with keyboard; hiding a section does not stop its underlying collection |
| TRAY-04 | Usage preferences | Remember the popup's 7-day/30-day history range; independently show its chart and totals | Range survives reopen/relaunch and does not change dashboard filters; keep at least chart or totals if Local usage is enabled |
| TRAY-05 | Preview and recovery | Open Customize from the popup's More menu or Settings; preview every change; restore defaults | One shared settings page, immediate application, save failure shown, undo the last customization, tray-only reset |
| TRAY-06 | Stable, accessible states | Preserve valid values and popup state through refreshes; explain missing data | No numeric flash to zero, ambiguous bare percentages, unexpected focus movement or lost section order |

New-install default: 7-day remaining, app icon with a 7-day meter, all three
popup sections in their existing order, 7-day local history with chart and
totals. This gives a compact long-window view; both percentages remain one click
away. Weekly pace appears only when qualified, except in customization preview,
where its empty-state example is available.

For upgrades, preserve an existing explicit choice. If no saved choice exists,
retain the prior automatic primary-window behavior until the user customizes it;
show that as “Current default” in Settings. Do not silently migrate users to the
community PR's 5-hour default. Restore defaults deliberately applies the new
default above. A legacy `off` setting maps to icon only with a plain app icon.

“Icon only” removes the text, not the app's access point. Keep lifecycle/error
indication, tooltip, popup, Settings and Quit available. Hiding all optional popup
sections leaves the header and actions, with a small Customize link. Status and
failure explanations are not hideable widgets.

## Next slice: additional information choices

| ID | Feature | Proposed scope | Why separate |
|---|---|---|---|
| TRAY-07 | Reset time and format | Optional reset time for one selected window, such as `5h resets 42m`; choose countdown or local clock time, shared with the popup | Needs width, timezone, sleep/wake and expired-reset handling; no per-second timer |
| TRAY-08 | Choose usage totals | Popup checkboxes for total tokens, API-equivalent cost and usage changes, each bound to the displayed history period | Cost requires partial-pricing disclosure; usage changes must not be labeled requests or messages |
| TRAY-09 | Cache summary | Optional popup summary of cache reuse for the selected history period, linking to Usage and costs | Must reuse the dashboard's denominator, coverage and scope; no second calculation path |
| TRAY-10 | Compact or detailed popup | Compact shows headline values; detailed adds charts, reset detail and evidence explanation | Requires accessibility and small-screen checks after section customization settles |
| TRAY-11 | Low-allowance emphasis | One optional toggle adds a quiet visual emphasis when a selected window reaches 10% remaining | Display-only, off by default; no new notifications, animations or rule editor |
| TRAY-12 | Two-meter icon exploration | Prototype a fixed top 5-hour / bottom 7-day meter as a space-saving alternative to two percentages | Adopt only if window identity and both states remain legible at actual tray sizes |

For TRAY-07, allow at most two compact fields from a fixed list. Reject duplicate
fields, keep order explicit, and show a width preview before selection. Prefer
an honest disabled combination to silently dropping a chosen field. Keep labels
and units intact at narrow widths. The initial four presets remain the easiest
entry point; no text-template editor is needed.

Keep predictions and costs out of the first compact bar. Weekly pace in the
popup may reuse an existing qualified outlook with its estimate label; it must
not create a new forecast from one observation. API equivalent is a reference
price estimate, not money charged to the user's subscription.

Defer used/remaining switching, per-account layouts, multiple tray icons,
automatic metric rotation, arbitrary scripts/templates and per-model live
allowance. They introduce ambiguity or additional authority and configuration
work without being necessary to deliver the core customization request.

## CodexBar screenshot follow-up

The owner supplied two CodexBar Menu Bar settings screenshots on 2026-09-07.
They show layout tokens, usage bars, pace, countdown and clock resets,
conditional layouts, inactive-display visibility, provider switching and
geometry controls. These establish visible choices, not the correctness of
their underlying calculations. The [CodexBar project](https://github.com/steipete/CodexBar)
also documents dynamic bar icons and reset countdowns.

The useful additions are a few fixed behaviors. Keep the advanced layout
construction machinery out of the TiboTattle settings flow.

| Idea | TiboTattle recommendation | Placement |
|---|---|---|
| Inactive-display visibility | Make the icon and text legible on secondary/inactive displays by default, following system appearance and contrast settings; add an override only if actual platform behavior needs one | Expand TRAY-06 acceptance, without another routine toggle |
| Resets in / reset at | One time-format choice: `in 42m` or `at 3:20 PM`; include weekday/date when needed and show the full local reset timestamp in detail | Extend TRAY-07; do not require users to assemble time tokens |
| Conditional emphasis | Offer “Emphasize low allowance” using the simple rule in TRAY-11; retain the same chosen metric and label | Later optional appearance control |
| Usage bar | Explore two fixed meters as an alternative for people short of menu-bar space | TRAY-12 prototype, not a commitment to ship |
| Pace and runs out | Keep the existing qualified weekly pace in the popup; a compact pace indicator can be revisited after comprehension testing | No new compact forecast or guaranteed exhaustion timestamp |
| Cost today / cost 30d | Already covered by selectable popup usage totals, except Today; add Today only with an explicit local-calendar-day data contract | Extend TRAY-08 only when that period is supported |
| Account/provider identity | Show a short user-chosen source label if multiple configured sources make the selected evidence ambiguous | Future source-selection work, not an always-visible email/account identifier |
| Auto / most-used selection | Defer: a smaller remaining percentage across different window durations is not proof of which limit will constrain the next task | Preserve explicit 5h/7d selection |
| Size, spacing, line breaks, condition builder, decorative animation | Use tested presets and system sizing | No per-pixel controls or layout language |

TRAY-11 is visual customization, separate from notification settings. Apply it
only to current evidence for selected windows; with both windows selected,
emphasize the exact low window, never substitute it for the other. Icon-only
mode uses the explicitly selected meter window. Enter emphasis at 10% remaining
or below and leave at 12% or above to avoid flicker near the boundary. Reset,
source change, stale evidence and unavailable evidence clear the low-allowance
state and render their own truthful status. Keep lifecycle/error indication
distinct. Add shape/text cues as well as color; never flash or change width.

TRAY-12 uses a fixed top/bottom order, explained by tooltip and the popup; an
unavailable lane is an outlined unknown state, not an empty 0% bar. Prototype
with synthetic 0%, 50%, 100%, one stale lane and both stale lanes at 1x/2x and
high contrast. If two readable meters cannot fit, retain the existing single
meter and labeled two-number preset. Do not solve legibility by adding size
and vertical-offset settings.

These additions do not expand the first 0.1.19 candidate beyond visibility and
accessibility acceptance. Reset formats follow TRAY-07; emphasis and two-meter
exploration remain later work. The recommendations are product judgments,
not an instruction to copy CodexBar's code or reproduce every option.

## Settings flow and preview examples

Settings uses the platform label “Menu bar” on macOS and “Tray” elsewhere.
Within it, group controls under **Beside the icon** and **When opened**. Place a
small preview next to the controls and a Restore defaults action at the bottom.
The popup's Customize action opens this exact page.

Use synthetic preview values, explicitly marked “Example”; do not fetch new
account data just to render Settings. Include a preview-state selector for
Current, Refreshing, Partly unavailable, Stale and Offline.

| Choice or state | Compact example | Popup behavior |
|---|---|---|
| Both, current | `5h 63% · 7d 94%` | Both allowances and their own reset times |
| Both, only 7-day current | `5h — · 7d 94%` | Explain the unavailable 5-hour value; retain the slot |
| Updating with current evidence | `5h 63% · 7d 94%` | Retain sections and values; show Updating separately |
| Stale | `5h — · 7d —` | Last observation may be shown as historical, never as current remaining |
| Current, genuinely exhausted | `5h 0% · 7d 94%` | Show a real zero and the verified reset time |
| Icon only | No text | All enabled sections remain available |

For a pinned window with no current evidence, neither the label nor the meter
may borrow another window's value. Deduplicate by the existing canonical lane
selector; unresolved conflicting candidates produce unavailable, not an average.
Per-window observation time and reset time govern expiry independently.

Retain valid numbers during a refresh only within their existing freshness
boundary. Cached historical totals may remain with their coverage and age while
the same source/account/period is updating. Clear scoped content on account or
source changes; an authoritative empty result replaces retained content.
Layout preference persistence is separate from evidence caching. Do not persist
live allowance numbers as settings or show them as current after relaunch.

## Platform behavior

macOS supports text beside the tray icon. Electron documents `Tray.setTitle` as
macOS-only; Windows and Linux need a different presentation of the same choices.
See the [Electron Tray API](https://www.electronjs.org/docs/latest/api/tray#traysettitletitle-options-macos).

On Windows, use the icon/meter, tooltip and popup for selected information. On
Linux, use the icon and supported menu/popup surface; tooltip and activation
behavior vary by desktop. Hide unsupported bar-text controls and explain where
the chosen information appears. If no tray host exists, retain all controls and
information in the app window. Do not synthesize unreadable two-number icons or
claim platform parity from packaging success.

Use template images on macOS, adequate scale variants on other platforms,
monospaced digits where available, and system appearance/high-contrast support.
Never rely on color alone. Accessible names must include product, window,
remaining/used meaning, status and freshness. Section reorder must preserve focus.

## Implementation sequence

1. **Preference and display contract.** Define a closed, versioned tray preference
   object: preset, icon mode, meter window, ordered enabled sections, history
   range and chart/totals visibility. Keep stable internal IDs and localized
   labels. Validate duplicates, unknown enums, missing fields and future schema
   versions; do not overwrite a future-version file with defaults. Legacy
   migration is idempotent, local and independent of usage-index migration.
2. **TRAY-01/02/05/06, candidate for 0.1.19.** Adapt the contributor's selection,
   persistence and localization ideas to the current native freshness selector.
   Keep compact title, action-menu header and accessible description independent.
   Wire Settings to the existing controller; update the compiled smoke receipt
   and its consuming test together. Preserve attribution if reusing the patch.
3. **TRAY-03/04, next implementation slice.** Add section composition and retained
   range to the existing popup. Use the same behavior fixtures in the Electron
   workstream. Do not build a second popup, settings store or collector.
4. **Electron integration.** Extend its settings schema, migration, persistence,
   preload/IPC allowlist and main-process status projection together. Keep native
   Swift as a platform adapter to the same specified behavior, checked with
   shared synthetic fixture cases. Prefer Electron for subsequent optional
   widgets; avoid multiplying new native-only features during convergence.
5. **TRAY-07 through TRAY-12.** Add each only after its data contract, rendering
   and platform acceptance checks pass. Release independently of the first slice.

Implementation entrypoints are native `MenuBarStatus.swift`,
`MenuBarPopover.swift`, Settings in `UsageMonitorApp.swift`, and localization;
Electron `desktop-contract.js`, `desktop-settings-store.js`,
`desktop-tray-status.js`, tray composition, settings and popup renderer modules.
Any new summary projection belongs behind the existing local/domain facade.
The tray consumes validated snapshots, not raw transcripts or renderer claims.

## Verification and completion criteria

- Behavioral fixtures cover every preset and icon combination, real 0/100%,
  one missing lane, duplicate/conflicting lanes, stale/reset expiry, refresh,
  offline/recovery, sleep/wake, clock changes and account/source switching.
- Persistence tests cover first install, current-default upgrade, all #73 legacy
  values, invalid/future schema, relaunch, save failure, undo and restore defaults.
- Popup checks cover empty/custom layouts, every section order, 7/30-day ranges,
  retained historical evidence, authoritative empty replacement and focus across
  background refresh. Hiding a widget does not alter its upstream computation.
- Native compiled smoke tests verify visible title, meter identity, menu header
  and accessible label; source text matching alone is insufficient. Electron
  checks include IPC validation, renderer composition and capability fallback.
- Inspect rendered Settings and popup on supported physical platforms, including
  light/dark/high-contrast, supported locales, scale factors, narrow/notched menu
  bars, inactive/secondary displays and keyboard/screen-reader use. Include
  threshold hysteresis, stale emphasis removal, timezone/DST changes and date
  labels for reset formats. Unit tests do not establish installed QA.
- Repeated unchanged polls reuse presentation state; customization does not add
  quota requests or reindexing. Countdown updates are at most once per minute
  plus lifecycle/reset events. Record idle behavior against the existing baseline.
- Update user help and localization alongside implementation. Source/CI,
  installed-app verification and release/update availability remain separate.

## Implementation verification

- [x] Shared cache-reuse display projection and malformed/empty/duplicate boundary tests.
- [ ] Native settings, persistence, bar and popup behavior with compiled smoke tests.
- [ ] Electron settings, IPC, persistence, bar and popup behavior with regressions.
- [ ] Source, documentation, localization and architecture checks.
- [ ] Fresh development packages and rendered customization checks.

No published release or installed stable app has been changed by this work.
