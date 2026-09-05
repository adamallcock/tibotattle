---
title: Electron and native 0.1.18 parity ledger
date: 2026-09-04
type: review
status: release-gated
---

# Electron and native 0.1.18 parity ledger

This is a source comparison for the native 0.1.18 baseline at revision
`3a785e6d` and the current Electron composition. It records implemented
behavior and deliberate gaps; it does not qualify a packaged, signed,
installed, or published application, and it does not establish real-corpus
coverage.

The Electron cold-start path is mode-aware in source (`1cfc6ba9`): a dashboard
whose launch snapshot still defers the unified projection starts one detailed
pass, while a validated available projection uses the cheaper quick pass.
Manual dashboard refresh remains detailed. The Windows launcher is a
development qualification entrypoint and does not change production support.

The open native PR review is bounded to source differences. PR #73
(`57b04b7a`, customizable menu-bar allowance display) is not part of the
`3a785e6d` native baseline, and its 5-hour/week/both/off menu-bar title
preference is not ported. Electron's 7-day, 30-day, and All dashboard controls
are a different surface and are not treated as an equivalent implementation.
PR #74's retained reconciliation is already in the current composition. PR
#91 is a research tool and PR #99 is dependency-only; neither adds a missing
native product control.

| Native 0.1.18 behavior and source | Electron current equivalent and source | Status | Next gate |
| --- | --- | --- | --- |
| Startup loads the dashboard and requests one quick foreground refresh in [`UsageMonitorApp.swift`](../../apps/macos/UsageMonitorApp.swift) (`dashboardWebViewLoaded`). | [`apps/web/public/app.js`](../../apps/web/public/app.js) gates startup on the Electron marker and local readiness, selects detailed for a deferred projection and quick for a trusted available projection, and settles the main-process lease. | Source-complete for the selected cold/warm modes; focused route tests pass. | Fresh packaged smoke must observe the expected POST and updated dashboard for the exact artifact. |
| Foreground cadence uses a persisted 60/300/900/1800-second interval and rate-limits automatic detailed accounting to one attempt per hour in [`UsageMonitorApp.swift`](../../apps/macos/UsageMonitorApp.swift) (`NativeRefreshIntervalPreference`, `NativeDetailedRefreshCadence`, `scheduleNativeRefresh`). | [`apps/electron/desktop-controller.js`](../../apps/electron/desktop-controller.js) owns the persisted timer and lease; its closed `automaticRefresh` command carries `quick` or `detailed`, uses a monotonic in-process hourly reservation plus a protected persisted attempt record, and pauses while the dashboard is hidden. Manual `refresh` remains detailed; browser return refresh remains quick. | Source-complete with cross-launch persistence wired in `7b384986`; cadence, controller and runtime tests passed 50/50, including restart and protected-backend behavior. | Run packaged timer smoke on each target before claiming installed cadence qualification. |
| Toolbar refresh explicitly requests detailed accounting in [`UsageMonitorApp.swift`](../../apps/macos/UsageMonitorApp.swift) (`refreshDashboardFromToolbar`). | The dashboard and setup refresh controls in [`apps/web/public/app.js`](../../apps/web/public/app.js) call the detailed route; Electron menu/tray actions use the separate manual `refresh` command. | Current for visible dashboard and menu/tray controls; focused tests prove automatic mode cannot change manual intent. | Verify menu/tray detailed refresh on each packaged target. |
| The menu-bar popover provides weekly pace and outlook from [`MenuBarPaceOutlook.swift`](../../apps/macos/Sources/MenuBarPaceOutlook.swift) and renders the control surface in [`MenuBarPopover.swift`](../../apps/macos/Sources/MenuBarPopover.swift). | Electron opens the same-origin [`electron-tray-popup.html`](../../apps/web/public/electron-tray-popup.html) from the tray through [`apps/electron/desktop-tray-popover.js`](../../apps/electron/desktop-tray-popover.js); its renderer consumes the companion's validated `paceOutlook` projection in [`electron-tray-popup.js`](../../apps/web/public/electron-tray-popup.js). Fixed `weekly` actions remain available through [`desktop-menu.js`](../../apps/electron/desktop-menu.js) and [`desktop-tray.js`](../../apps/electron/desktop-tray.js). | Source-complete for a shared visual popup with allowance lanes, weekly pace/outlook, and bounded action routing. The dedicated Swift presentation and Electron window geometry differ. | Run the packaged popup smoke on each target and retain the screenshot/target receipt. |
| Native menu-bar history shows 7-day and 30-day horizons and retained-history state in [`MenuBarPopupModel.swift`](../../apps/macos/Sources/MenuBarPopupModel.swift) and [`MenuBarPopover.swift`](../../apps/macos/Sources/MenuBarPopover.swift). | The Electron popup renders 7-day/30-day history, coverage, pricing, and retained-history disclosures from the normalized local DTO in [`electron-tray-popup.js`](../../apps/web/public/electron-tray-popup.js); dashboard weekly/timeline/Usage and Costs destinations remain available through [`desktop-shell.js`](../../apps/web/public/desktop-shell.js) and [`app.js`](../../apps/web/public/app.js). | Source-complete for the bounded shared projection; the popup uses local range controls and preserves unavailable/partial evidence states. | Verify the packaged popup's history and coverage states, then retain the rendered screenshot/receipt. |
| Native status and allowance rows are assembled by [`MenuBarStatus.swift`](../../apps/macos/Sources/MenuBarStatus.swift) and the popover. | Electron's tray reducer and menu actions in [`desktop-tray-status.js`](../../apps/electron/desktop-tray-status.js), [`desktop-tray.js`](../../apps/electron/desktop-tray.js), and [`desktop-menu.js`](../../apps/electron/desktop-menu.js) use fixed starting/analyzing/fresh/stale/unavailable states and route to the dashboard. | Source-complete for bounded status/actions; presentation differs. | Inspect each packaged target's tray/menu behavior and keep status claims tied to the companion receipt. |
| Native localization, appearance, refresh interval, login item, and updater settings are owned by [`UsageMonitorApp.swift`](../../apps/macos/UsageMonitorApp.swift), [`Localization.swift`](../../apps/macos/Sources/Localization.swift), and [`LoginItemManager.swift`](../../apps/macos/Sources/LoginItemManager.swift). | Electron settings are rendered by [`electron-settings.js`](../../apps/web/public/electron-settings.js) and backed by [`desktop-controller.js`](../../apps/electron/desktop-controller.js) and [`desktop-platform-services.js`](../../apps/electron/desktop-platform-services.js). | Current source equivalence for the exposed settings; platform qualification is separate. | Run rendered settings checks on each target and verify persistence in an isolated profile. |
| Native quota notifications require fresh provider evidence and use the bounded policy in [`QuotaNotifications.swift`](../../apps/macos/Sources/QuotaNotifications.swift). | Electron has a coordinator and settings surface in [`desktop-notification-coordinator.js`](../../apps/electron/desktop-notification-coordinator.js) and [`electron-settings.js`](../../apps/web/public/electron-settings.js). | Partial: the Electron adapter reports unavailable where notification identity/platform qualification is absent; no source change may turn that into readiness. | Qualify the platform notification adapter independently, or retain the explicit unavailable state. |
| Native keeps its Keychain broker and local app identity separate from the web dashboard in [`KeychainBroker.swift`](../../apps/macos/Sources/KeychainBroker.swift) and [`UsageMonitorApp.swift`](../../apps/macos/UsageMonitorApp.swift). | Electron uses its own credential/runtime seams in [`desktop-runtime.js`](../../apps/electron/desktop-runtime.js), [`preload.cjs`](../../apps/electron/preload.cjs), and platform services; it does not reuse the Swift broker. | Current as separate platform implementations. | Complete target-specific credential and packaged profile qualification; do not infer one platform's proof from the other. |
| Native app lifecycle is foreground-only and owns its embedded WebKit host, startup, refresh, and quit paths in [`UsageMonitorApp.swift`](../../apps/macos/UsageMonitorApp.swift). | Electron lifecycle, single-instance, companion supervision, tray, and bounded shutdown are owned by [`desktop-runtime.js`](../../apps/electron/desktop-runtime.js), [`companion-supervisor.js`](../../apps/electron/companion-supervisor.js), and [`desktop-controller.js`](../../apps/electron/desktop-controller.js). | Source-complete at the composition boundary. | Run fresh packaged launch, refresh, quit, and relaunch checks with a disposable profile; browser tests do not establish this gate. |
| Native Sparkle updater behavior is guarded by [`UsageMonitorApp.swift`](../../apps/macos/UsageMonitorApp.swift) (`AppUpdater`). | Electron development settings and platform services report updater availability according to the current qualified adapter; development candidates do not claim signed updater support. | Gap/qualified unavailable state by design. | Add a separately qualified Electron updater before any updater-support claim. |
| Native has no equivalent to the accepted accountless Electron transition policy in its 0.1.18 shell. | Electron sharing controls use the main-process preference bridge and show a truthful unavailable transport state; the Electron composition suppresses legacy sign-in controls. | Electron-specific current behavior; transport is unavailable in this tranche. | Keep policy and upload authority separate; qualify transport only after its own accountless authority exists. |
| Native packaging and distribution are governed by the macOS build and signing lanes. | Electron builder configuration targets `darwin-arm64`, `darwin-x64`, `win32-x64`, and `linux-x64`; the isolated Windows launcher `.mjs` and generated `.cmd` wrapper request the reviewed qualification marker and a `%LOCALAPPDATA%` profile. | Source/build plan present; no release or platform-support claim. | Build and inspect each exact artifact, then retain separate qualification, signing, publication, and support gates. |

## Focused evidence

### Page-by-page follow-up

The owner reproduced a native context menu stacked above the rich popup in
candidate `7bdd3f86`. The macOS tray now keeps its context menu detached and
presents it explicitly for secondary/Control-click; primary click toggles the
rich popup. A native menu presentation also hides any visible or loading popup.
The additional More button routes through the same closed action boundary.
Electron's [Tray API](https://www.electronjs.org/docs/latest/api/tray) distinguishes
native menu integration from click events; both paths need actual runtime QA.

Three independent Terra passes reviewed the five dashboard pages, all three
Settings tabs, sharing, and the native control inventory. The pre-fix packaged
app rendered coherent page layouts and basic controls with a disposable
synthetic profile. That fixture establishes sparse/empty chart states, not
real-corpus plotted-series equivalence or native AppKit pixel equivalence.
The review identified and repaired these source gaps:

| Surface | Correction | Required fresh-package check |
| --- | --- | --- |
| Dashboard toolbar | Restore the native-equivalent Share shortcut using the existing Allowance/card focus handler. | Click Share from another page; verify navigation, visible card, and app-owned focus. |
| Tray popup | Add native-equivalent More actions and keep the action menu mutually exclusive with the popup. | Primary, right and Control clicks; More; Escape/outside dismissal; repeat after status/language updates. |
| Settings confirmation | Successful preference saves use a success state; failures retain their error state and live announcement. | Save in a disposable profile and inspect text, color and persistence. |

Core General settings expose equivalent controls, while multi-root management
and accountless sharing are Electron additions. Notification and updater
controls retain explicit unavailable states where their adapters are not
qualified; visible controls do not establish native updater or delivery parity.
Native AppKit sidebar, toolbar, window chrome and popup styling differ from the
Electron web presentation. These are feature-level comparisons, not a claim
that the two applications look identical in every pixel.

The cold/warm route-mode regression is covered by
`node --test apps/web/test/refresh-policy.test.mjs` (12 passing tests at the
source snapshot containing `1cfc6ba9`). The browser startup extraction remains
covered by `node --test apps/web/test/lib.test.mjs`, and `node --check
apps/web/public/app.js` passes. The tray main-process boundary and geometry
are covered by `apps/electron/test/desktop-tray-popover-main.test.mjs`; the
focused Electron/runtime/menu batch passed 72 tests at the source snapshot
containing `d309c75d` and `be7b7e45`. These checks do not replace packaged
Electron rendering or target-specific qualification.
