---
title: Electron and native macOS parity ledger
date: 2026-08-24
type: plan
status: active
---

# Electron and native macOS parity ledger

This ledger is the acceptance authority for the Electron parity work. A row is
`passed` only when one exact packaged revision has source, package, rendered,
interaction, and persistence evidence appropriate to the capability. Unit
tests or source presence alone are not sufficient.

The shipping native macOS application is the behavior reference. Electron may
use an equivalent web or operating-system control, but it may not silently
omit a supported task or present an unavailable capability as working.

## Current evidence

| Capability | Shared/native reference | Electron state | Acceptance evidence still required |
| --- | --- | --- | --- |
| Five dashboard pages | Native AppKit sidebar hosts the shared dashboard | Present in source and current staged package | Pointer and keyboard navigation through all five pages in the final package |
| Overview | Shared renderer and companion overview | Rendered from the exact package with real local setup evidence | Successful full refresh and retained data after relaunch |
| Allowance | Shared weekly estimate/history | Present; sparse when no completed unified index exists | Real or truthfully sparse result after the final full refresh |
| Trends | Shared timeline, residuals, divergence, and usage timeline | Present in source/package | Rendered chart/table controls and empty/error states in the final package |
| Usage and costs | Shared summary, token components, model rows, pricing, cache switch, cache-continuity raster/tables, and side-chat | Present in source/package; data-dependent modules were hidden after the Electron cold index timed out | Complete cold index; visible populated modules; period controls; cache modules; restart persistence |
| First Electron cold index | Native normally reuses its existing owner-only state | Electron accounting is off the companion HTTP thread; server/controller allow a 30-minute cold pass; nested batches and synchronous extraction have bounded cooperative checkpoints | Successful publication from the final package, measured duration, and retained data after relaunch |
| Refresh clock | Native toolbar keeps live progress | Renderer-owned wall clock and immutable 31-minute Electron operation deadline implemented; transient status starvation no longer triggers the browser's eight-failure cutoff | Final package continues counting through delayed status reads and catches up after sleep/background throttling |
| Cancel | Shared cancellation endpoint and controller | Cancel request has an eight-second confirmation deadline, polling stays authoritative, and fixed copy distinguishes timeout/already-finished/failure | Packaged request latency, `cancelling`, terminal state, actual worker cancellation latency, and retry |
| Community service | Native companion receives the reviewed production origin | Exact current packaged companion exposes enabled Google/Apple sign-in controls; the older user-tested package said no service | Final Electron main-process package proof and hosted-sign-in return without transmitting test data |
| Contribution lifecycle | Native Keychain broker plus shared review/sync/delete UI | Shared UI present; Electron uses keytar rather than the native broker | Pairing, approval, automatic sync, lapse/renewal, disconnect, deletion, and relaunch behavior |
| Share | Native toolbar routes to the shared card | Electron routes to `#weekly`; panel/canvas smoke exists | Save, completion event, reveal, copy, error recovery, and relaunch |
| Settings | Native General/Notifications/About plus diagnostics/data controls | Electron General/Notifications/About present | Every setting persists across close/reopen and quit/relaunch; missing appearance/data controls added |
| Appearance | Native System/Light/Dark | Fixed-enum main-owned setting implemented for dashboard and Settings, including live system-theme changes and migration from older settings | Physical package selection, close/reopen, quit/relaunch, and system-change proof |
| Sidebar | Native collapse, persistence, rescue, and View-menu toggle | Electron-only collapse/restore, focus rescue, persistence, and View-menu command implemented | Physical pointer/shortcut proof, close/reopen, and quit/relaunch |
| Application menu | Native app/edit/view/window commands | Basic Electron menu present | Command-by-command comparison and physical shortcut proof |
| macOS status item | Native bird/meter, live percentage, evidence rows, actions | Semantic status/percentage rows exist; Darwin tray generation now crops the app plate and extracts a template bird instead of shrinking the full squircle | Physical bird raster, live percentage, dynamic states, full menu, hide/restore, one companion, clean quit |
| Notifications | Native local notification coordinator | Policy exists; delivery intentionally unavailable without qualified app identity | Signed-platform identity, permission, threshold crossing, dedupe, reset precedence, and delivery |
| Updater | Native Sparkle check/download/install/relaunch | Development Electron build truthfully reports unavailable | Signed updater/feed policy, check/install/restart, rollback, and failure behavior |
| Diagnostics and data management | Native diagnostics, local reset, and credential repair | Missing from Electron desktop contract | Bounded main-process actions, confirmations, privacy-safe results, and destructive-operation tests |
| Deep links | Native `usagemonitor://open` | Parser/queue present | Installed-package primary/secondary-instance and hosted return proof |
| Login item | Native `SMAppService` | Electron packaged adapter present | Enable/disable/relaunch/login persistence on macOS and Windows |
| Lifecycle and recovery | Native close-to-status-item, recovery, and clean quit | Electron source/smoke paths present | Physical close/hide/restore, Settings focus, retry, single instance, relaunch, and no orphan |
| Windows | Native filesystem/Credential Manager qualification | Earlier exact revision qualified; current parity candidate is unqualified | Warm and clean receipts for the final parity SHA, then separately authorized signing/installer gates |
| Linux | No native macOS equivalent | Shared shell source exists | Native Secret Service, filesystem, tray, autostart, packaging, and installed-app qualification |

## Completion rule

Full parity is not complete until every applicable row above is `passed` on one
exact candidate. Production-only rows may be blocked by a separately authorized
signing or deployment operation, but they must remain visible and truthful in
the development build and may not be counted as passed from mocks or source
contracts.
