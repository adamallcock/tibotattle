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

- The implementation starts from the exact Windows integration revision
  `5f188ac2195d3d9e79d4ed4110f8e3d8399721d9`.
- That line currently diverges substantially from `origin/main`; it must not be
  blindly rebased while parity implementation and qualification are in flight.
  Integration onto current main is a separate, evidence-led branch operation.
- The packaged Electron application already proves secure BrowserWindow
  defaults, companion startup, loopback-only navigation, close-to-tray,
  single-instance handling, clean shutdown, and dashboard rendering on macOS.
- The visible dashboard regression has a specific cause: Electron stamps the
  AppKit-only `native-dashboard` marker, so the web stylesheet hides the top
  bar, sidebar, refresh controls, and setup UI even though Electron supplies no
  native replacement.
- The existing web renderer already implements the five dashboard destinations
  and real companion-backed refresh/data interactions. It is reused, not
  rewritten.

## Progress snapshot — 2026-08-23

- P0.1 is source- and package-complete: Electron has its own visible dashboard
  marker and restores the localized top bar, five-item sidebar, state controls,
  and navigation without changing the native macOS layout. The final unsigned
  arm64 bundle is packaged and byte-verified; hands-on visual acceptance remains
  pending because the macOS host was locked when automation attempted to open
  the exact handoff copy.
- P0.2 is complete for the development shell: the renderer receives an exact
  frozen v1 bridge, main-process sender and frame checks, fixed actions,
  loopback-only navigation, sandboxing, and protected desktop settings. Codex
  source paths remain main-process-only; Settings receives only the closed
  semantic state `default` or `custom`.
- P0.3 is functionally complete for the development build: General,
  Notifications, and About are reachable from the dashboard, menu, and tray;
  language, Codex source, cadence, and autostart round-trip; unavailable alert
  delivery and updates are stated explicitly rather than simulated.
- P0.4 source integration is complete. Companion startup has a visible bounded
  recovery surface with Retry, Settings, and Quit; stale origins are destroyed;
  explicit quit owns child shutdown; and the localized tray projects fixed
  fresh/analyzing/stale/unavailable states plus bounded allowance evidence.
- First-run disclosure, protected acknowledgement, localized copy, deep-link
  intake, external hosted-sign-in handoff, notification policy, and owned
  share-card download/reveal behavior are integrated. Downloads are
  single-flight and completion-gated; their renderer pending state has a fixed
  recovery deadline.
- Final automated evidence is 231/231 Electron tests, 340/340 web UI tests, and
  the full portable lane at 1,903 passed, 50 explicitly native-only skipped,
  and zero failed. Architecture boundaries have zero approved debt, the tool
  inventory is complete, documentation links are normalized, and
  `git diff --check` is clean.
- The verified macOS payload digest is
  `18d9e24081997eea10183e5a0a3e87581bb4468c8dd3284851c673fc8d409daf`.
  The stable handoff contains the unsigned `.app` and an integrity-tested zip;
  it remains a development artifact and carries no release, signing, updater,
  or Windows-support claim.
- Independent security review found no reportable finding. A same-user
  download-destination link race remains a defense-in-depth Windows-native
  qualification item, not a validated privilege or confidentiality boundary
  under the current threat model.
- One bounded availability trade-off remains recorded: if a response body
  ignores both abort and cancellation forever, status polling fails closed to
  `unavailable` without accumulating readers, but normal polling does not
  recover until the process restarts. This does not freeze the shell.
- P1 is not complete. Production Windows notification identity remains
  intentionally disabled, and native Windows warm/clean acceptance must still
  prove autostart, notifications, source change, owned downloads, installer,
  signing, upgrade/uninstall policy, and clean lifecycle on one exact revision.
  Packaged Linux GUI qualification remains deferred until that shared boundary
  is stable.

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

## Stop conditions

- Stop a failing repair loop after one localized implementation attempt and one
  focused verification retry; record the exact failing boundary before
  changing architecture.
- Do not weaken security, qualification, package-manifest, or release gates to
  make the prototype appear complete.
- Do not rebase or rewrite the divergent integration history while other agents
  or qualification runs depend on it. Reconcile it in a dedicated worktree
  after the parity artifact is frozen.
- Do not claim full Windows or Linux support from a macOS Electron build.
