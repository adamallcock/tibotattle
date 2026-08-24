---
title: Electron desktop parity plan
date: 2026-08-22
type: plan
status: active
---

# Electron desktop parity plan

## Outcome

Turn the existing secure Electron development shell into a complete, usable
desktop client that reaches behavioral parity with the shipping TiboTattle
macOS application wherever the operating system offers an equivalent
capability. The first physical acceptance artifact is an unsigned macOS
Electron application for hands-on product feedback. Native Windows x64 is the
authoritative acceptance platform for Windows filesystem, credential,
autostart, notification, installer, and signing behavior. Linux follows after
the shared shell contract is stable.

The native macOS application remains the shipping macOS client throughout this
work. This plan does not authorize a version bump, production signing,
publication, updater-feed change, release, service deployment, production
selector, or replacement of the native client.

## Starting evidence and source boundary

- This isolated integration is based exactly on `origin/main` revision
  `8687cbb9ce0cdad63893b726381e40a73099f09b`. It is the current integration
  candidate for the Electron parity, Windows qualification, and signed-finalizer
  changes; it has not yet been freshly packaged or natively Windows-qualified
  as one exact candidate. No local-versus-remote `main` divergence is part of
  this plan.
- The exact Windows development-qualified candidate is the separate revision
  `b37bd4918f75995130f8a4ed6b123e61e48f9179`, validated by run
  `32678463671`. Its receipts and payload evidence belong only to that exact
  revision and must not be attributed to the current `origin/main` integration
  until a fresh qualification run passes.
- The exact macOS M0 product-feedback handoff was built from
  `e66591c4bc275f2a3060c8b073bb32500fa3931d`; its payload and physical evidence
  remain valid as a separate handoff. This plan does not treat that artifact as
  proof of the current integration's bytes or of Windows support.
- The application/package version remains `0.1.16` throughout this integration.
  A version bump, release publication, updater-feed change, or replacement of
  the native macOS client is outside this plan.
- The packaged Electron application already proves secure BrowserWindow
  defaults, companion startup, loopback-only navigation, close-to-tray,
  single-instance handling, clean shutdown, and dashboard rendering on macOS.
- The visible dashboard regression was caused by Electron stamping the
  AppKit-only `native-dashboard` marker. Electron now uses its own marker and
  mounts its frozen preload bridge independently of DOM-listener ordering.
- The existing web renderer already implements the five dashboard destinations
  and real companion-backed refresh/data interactions. It is reused, not
  rewritten.

## Progress snapshot — 2026-08-23

- The exact macOS M0 handoff is source-, package-, and physical-acceptance
  complete. Electron has its own visible dashboard marker and restores the
  localized top bar, five-item sidebar, state controls, and navigation without
  changing the native macOS layout. Direct packaged-app inspection confirmed
  all five routes, exactly one active page, inert inactive pages, real rendered
  data, and no renderer exceptions.
- P0.1 is implemented in the current integration and physically proven by the
  separate M0 handoff. A fresh current-integration package remains required
  before this plan attributes that evidence to `8687cbb9`-based bytes.
- P0.2 is complete for the development shell: the renderer receives an exact
  frozen v1 bridge, main-process sender and frame checks, fixed actions,
  loopback-only navigation, sandboxing, and protected desktop settings. Codex
  source paths remain main-process-only; Settings receives only the closed
  semantic state `default` or `custom`.
- P0.3 is functionally complete for the development build: General,
  Notifications, and About are reachable from the dashboard and macOS
  application menu; language, Codex source, cadence, and autostart round-trip;
  unavailable alert delivery and updates are stated explicitly rather than
  simulated. The exact M0 handoff confirmed a persistent visible Settings
  window, all three tabs, distinct notification capability and OS-permission
  copy, close/reopen, preservation of the selected section, and status-item
  hide/restore with one companion and clean Quit.
- P0.4 source integration is complete. Companion startup has a visible bounded
  recovery surface with Retry, Settings, and Quit; stale origins are destroyed;
  explicit quit owns child shutdown; and the localized tray projects fixed
  fresh/analyzing/stale/unavailable states plus bounded allowance evidence.
- First-run disclosure, protected acknowledgement, localized copy, deep-link
  intake, external hosted-sign-in handoff, notification policy, and owned
  share-card download/reveal behavior are integrated. Downloads are
  single-flight and completion-gated; their renderer pending state has a fixed
  recovery deadline.
- Electron now starts one guarded foreground refresh after the first dashboard
  read. The return-visit scheduler stands down for that document while the main
  process retains the recurring cadence. The exact M0 macOS package has a
  durable disposable-profile receipt proving one, and only one, startup POST; a
  changed refresh id; terminal `succeeded`; and rendered local data without a
  manual Analyze click. Windows and Linux smoke observers bind the request and
  terminal receipt to the exact validated loopback origin and active main-frame
  loader, reject stale or duplicate receipts, and fail closed across reload
  boundaries. This receipt is not current-integration qualification.
- Share now routes to the actual owning `#weekly` page, then focuses and scrolls
  the real `#share-panel`. Direct Computer Use inspection recorded that panel as
  the focused accessibility element and showed the complete image plus Save and
  Copy controls in the viewport. Native Swift's historical `#overview` route is
  not used as the Electron acceptance oracle.
- The earlier focused validation recorded 215 passing
  Windows-production/signing tests plus five expected native-Windows skips
  (220 total). The prior `220/220` shorthand incorrectly counted skips as
  passes. These are retired historical counts from a pre-current-integration
  snapshot, not a current qualification receipt, and must not be used for
  acceptance. They were a pre-freeze snapshot of this integration, not evidence
  from a distinct pre-integration branch. The final staged integration candidate
  has since recorded 223 passing production/signing contracts with six explicit
  native-platform skips, plus 665 passing Electron/web contracts with two
  explicit platform skips. Architecture (422 production files and 1,634
  imports with zero approved debt), root hygiene, the 102-record tool inventory,
  documentation links, workflow YAML, and staged-diff validation also pass on
  that same candidate. These focused source results are not a substitute for
  the fresh native Windows warm/clean qualification receipt. The exact packaged
  macOS app separately
  passes content-free end-to-end smoke and repeated physical status-item
  lifecycle.
- The verified macOS M0 payload digest is
  `200d8d7bb70efd5d3b12b7a13a3974869a9ffdeafebe3e78a52698504f9bcf20`
  across 464 files and 8,131,793 bytes. The stable handoff is
  `.release-build/electron-user-test/200d8d7bb70e/`; its zip SHA-256 is
  `6f635d5a206559001ce3858756dfe19266c1fad994fd39c66100d6f6b8a25dac`.
  Both the copied application and a fresh zip extraction passed the artifact
  verifier. It remains an unsigned development artifact and carries no
  release, signing, updater, or Windows-support claim.
- Independent focused review of the Electron slice found no reportable finding.
  A same-user download-destination link race remains a defense-in-depth
  Windows-native qualification item, not a validated privilege or
  confidentiality boundary under the current threat model.
- The owned-download item stays open until one of two explicit outcomes is
  recorded: (a) a Windows-native writer/reparse/race qualification proves the
  destination is safely bound at creation and the post-write receipt is safe,
  or (b) Adam explicitly accepts the current same-user TOCTOU residual as
  defense-in-depth. Post-write verification alone does not close this item;
  no Windows-support or release claim may count it as passed before one of
  those outcomes.
- One bounded availability trade-off remains recorded: if a response body
  ignores both abort and cancellation forever, status polling fails closed to
  `unavailable` without accumulating readers, but normal polling does not
  recover until the process restarts. This does not freeze the shell.
- The exact Windows development qualification is complete only for
  `b37bd4918f75995130f8a4ed6b123e61e48f9179` in run `32678463671`: 232/232
  security qualification tests passed in warm and clean lanes with no skips or
  failures, and every runtime check is true, including launch, dashboard,
  refresh, tray/window lifecycle, single-instance rejection, clean quit, no
  orphans, protected-state persistence, Credential Manager persistence, and
  relaunch. The canonical receipts are explicitly `qualification_only` with
  `productionReadiness: not_claimed`. This evidence must not be reused as a
  verdict for the current `origin/main` integration.
- The clean qualified Windows payload digest for that exact b37 candidate is
  `7d6854448d1ecc289ed86aaea461fd050eb40b336bed43737b48e933e27348a8` across
  466 staged/artifact files and 8,616,547 bytes. Its verified physical handoff
  is `.release-build/electron-user-test/7d6854448d1e/`, with unsigned zip
  SHA-256 `cb32976841b003ed813275193f01a1d175c8c1192a30af95bf70f2a82d00a06c`.
- The current integration includes the signed-finalizer workflow and its
  bounded preparation, provenance, certificate-subject, native-presign, and
  receipt gates. The workflow has not been run for production signing and no
  production credential has been used. Before an authorized signing run, it
  still requires the approved `AZURE_CODE_SIGNING_SUBJECT_SHA256`, a
  main-only deployment branch policy for the protected GitHub environment, and
  explicit authorization for the first production-signing attempt. The design
  retains a documented job-wide GitHub OIDC residual: the protected signing job
  has `id-token: write` during checkout/build, so this is not claimed as a
  strict no-OIDC-before-packaging boundary.
- P1 is not complete. Production Windows notification identity remains
  intentionally disabled, and a fresh current-integration Windows warm/clean
  run must prove autostart, notifications, source change, owned downloads,
  installer, signing, upgrade/uninstall policy, and clean lifecycle on one
  exact candidate. Packaged Linux GUI qualification remains deferred until
  that shared boundary is stable.
- The frozen unrestricted current-integration repository suite passes every test
  outside `test/r7-generated-release-evidence.test.js`. Its two retained R7
  release receipts correctly fail because their workload code digest and file
  count predate this expanded executable source graph. Regenerating frozen R7
  release evidence is a separate release-evidence operation, not part of this
  integration. The separate local-review runtime gate also exposes a retained
  artifact-closure gap: the staged source graph imports
  `@app-usagemonitor/telemetry-contract`, but the offline artifact does not copy
  that package. These remain explicit follow-ups; no parity or release/security
  gate is weakened to hide them.
- The two formerly open physical M0 observations are closed only for the exact
  `e66591c4` macOS handoff: its disposable-profile receipt proves exactly one
  startup POST and its status-item test proves hide/restore, one companion, and
  clean Quit. Those observations are not current-integration qualification.

## Definition of parity

Parity means that a user can complete the same supported task with equivalent
feedback and safety. It does not require identical widgets or unsupported
claims. Platform-specific gaps must be visible and truthful: for example, a
development build may show updates as unavailable; it must not imitate a
working production updater.

Compiled but unreachable native macOS diagnostics and data-reset controls are
not silently added to scope. Re-exposing them requires a separate product and
security decision.

## Ordered implementation slices

### P0.1 — Visible dashboard shell

**Work**

- Give Electron its own `electron-dashboard` marker and reserve
  `native-dashboard` for the AppKit host.
- Restore the localized top bar, language selector, state/refresh controls,
  and five-item sidebar.
- Preserve hash navigation, selected state, inert pages, focus movement, and
  ARIA current-page semantics.
- Add packaged renderer assertions on Linux and Windows so hidden chrome cannot
  regress unnoticed.

**Exit criteria**

- A packaged macOS Electron build visibly exposes Overview, Allowance, Trends,
  Usage and costs, and Community without DevTools.
- All five destinations are keyboard and pointer reachable; exactly one page
  is active and inactive pages are inert.
- Analyze, Cancel, state, and language controls are present and use the real
  local renderer behavior.
- The native macOS host still receives its AppKit-specific layout unchanged.

### P0.2 — Narrow desktop bridge and security policy

**Work**

- Add a versioned, frozen preload API over exact IPC channels.
- Allow only typed operations needed by visible desktop features: read the
  capability/settings snapshot, open Settings, choose or reset the Codex
  source, set an allowlisted language/refresh interval/notification threshold,
  set autostart, open an enumerated system-settings destination, open an
  enumerated project link, request refresh, reveal an owned completed download,
  and query/check updater state.
- Reject unknown channels, extra keys, wrong types, unsupported enum values,
  untrusted frames, arbitrary URLs, arbitrary paths, filesystem primitives,
  processes, and generic send/invoke capabilities.
- Keep sandboxing, context isolation, Node-disabled rendering, loopback-only
  network requests, and permission denial in force.

**Exit criteria**

- Contract tests prove the exact exposed API surface is frozen and all malformed
  or broadened requests fail closed.
- The renderer never receives a filesystem path from the folder picker beyond
  a display-safe, explicitly approved summary.
- Remote content cannot call the bridge and remote origins never load inside
  the desktop window.
- Existing Electron security and package-layout tests remain green.

### P0.3 — Settings, menus, and About

**Work**

- Add an accessible three-tab Settings window:
  - General: System/English/Simplified Chinese/Spanish, Codex source
    choose/default, 1/5/15/30-minute refresh interval, and real autostart state.
  - Notifications: explicit opt-in, Off/90%/80%+90% thresholds, real permission
    state, and OS settings action.
  - About: icon, package version/build, truthful updater capability/state, and
    fixed Website/GitHub/X destinations.
- Add application menus and shortcuts for About, Settings, Copy, Select All,
  Refresh Usage, window restoration, and Quit.
- Make Settings values round-trip through a main-process controller. Windows
  writes must use the qualified owner-only state boundary; no renderer-writable
  ad hoc JSON store is permitted.
- A Codex source change must validate the selected directory and restart the
  companion through the existing bounded lifecycle before reporting success.

**Exit criteria**

- Every visible settings control reads, writes, reloads, and reports failure
  truthfully; unsupported capabilities are explained rather than silently
  ignored.
- Settings is reachable from the dashboard, application menu, and tray.
- Standard shortcuts work while either dashboard or Settings has focus.
- A source change either completes a controlled companion restart and dashboard
  reload or leaves the previous working configuration intact.

### P0.4 — Recoverable lifecycle and rich tray

**Work**

- Replace quit-on-startup-failure behavior with a visible loading/recovery
  surface containing Retry, Settings, and Quit.
- Share a single desktop-action controller between application menu, tray,
  recovery UI, and Settings.
- Upgrade the tray to show a reviewed icon, truthful fresh/analyzing/stale/
  unavailable state, allowance summary when fresh evidence exists, and Open,
  Analyze/Retry, Settings, About, and Quit actions.
- Keep close-to-tray, second-instance activation, bounded automatic recovery,
  explicit quit, and no-orphan guarantees.

**Exit criteria**

- A deliberately failed companion start can recover without restarting the app.
- Closing and restoring from the tray works; explicit Quit stops the companion
  and leaves no descendants.
- Tray/main/recovery surfaces do not disagree about refresh state.
- Second-instance launch focuses the existing window and never starts another
  companion.

### P1 — Platform adapters and production-capability parity

**Work**

- Autostart adapters with real enabled/disabled/requires-attention states.
- Notification delivery using the native evidence policy: explicit consent,
  fresh direct evidence, threshold crossing, reset precedence, one alert per
  refresh, and duplicate suppression.
- Strict `usagemonitor://open` handling and safe external-browser handoff for
  hosted sign-in completion.
- Owned download completion/reveal behavior.
- A signed-release updater adapter after Windows installer/signing policy is
  accepted; development artifacts continue to report updater unavailable.
- Complete localization, keyboard traversal, visible focus, screen-reader
  labels, and established state persistence.

**Exit criteria**

- Every adapter has deterministic policy tests and native-OS acceptance tests.
- Windows warm and clean lanes prove protected settings persistence,
  Credential Manager, source change/relaunch, autostart, notifications,
  process-tree lifecycle, installer behavior, and signing on one exact revision.
- Linux claims remain limited to what its native Secret Service, filesystem,
  XDG/autostart, notification, and AppImage qualification actually proves.

## Validation matrix

| Validation | macOS development host | Linux container/Xvfb | Native Windows x64 |
| --- | --- | --- | --- |
| Unit and contract tests | Required | Required | Required |
| Renderer DOM, navigation, ARIA | Packaged app + visual QA | CDP smoke | CDP smoke |
| Menu, Settings, tray/window lifecycle | Packaged app | Desktop smoke | Warm and clean smoke |
| Companion refresh/restart and no orphan | Packaged app | Desktop smoke | Warm and clean smoke |
| Protected settings and credentials | macOS development boundary only | Deferred to Linux native lane | Authoritative |
| Autostart and notifications | Functional development check | Native Linux lane later | Authoritative |
| Installer, signing, updater | Not claimed | Not claimed in initial lane | Separate production gates |

## First physical handoff

The first user-test handoff is complete only when an unsigned macOS Electron
application is rebuilt from the parity branch, passes package verification and
clean lifecycle smoke, is visually inspected, and includes:

1. visible top bar and five-item sidebar;
2. working navigation and Analyze/Cancel controls;
3. reachable General, Notifications, and About Settings tabs;
4. working application-menu and tray entry points; and
5. truthful unavailable states for production-only capabilities.

That artifact is a product-feedback build, not release or Windows-support
evidence.

The current `200d8d7bb70e` handoff satisfies all five items. Its exact package
receipt proves startup/data, Share, and Settings paths; repeated physical
status-item cycles prove hide, foreground restoration, one companion, and clean
Quit. M0 is complete within the explicitly unsigned development-only boundary.

## Stop conditions

- Stop a failing repair loop after one localized implementation attempt and one
  focused verification retry; record the exact failing boundary before
  changing architecture.
- Do not weaken security, qualification, package-manifest, or release gates to
  make the prototype appear complete.
- Do not silently rebase or replace the current `origin/main` integration while
  a qualification run depends on an exact candidate. Requalify any changed
  revision from its own packaged bytes and receipt; do not splice evidence from
  the b37 candidate or the separate macOS handoff into current-integration
  claims.
- Do not claim full Windows or Linux support from a macOS Electron build.
