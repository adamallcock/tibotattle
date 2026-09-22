---
title: Electron start-at-login status and refresh
date: 2026-09-21
type: decision-record
status: accepted
---

# Electron start-at-login status and refresh

The Electron Settings switch presents observed platform state. Opening Settings,
completing a switch operation, and returning focus to Settings each trigger a
fresh read. The normal page has no manual refresh control; **Try again** appears
only when a status or settings read fails. A successful request is never treated
as proof that the operating system applied the requested state.

On macOS, Electron's [login-item API](https://www.electronjs.org/docs/latest/api/app)
reports enabled, not registered, approval required, or unavailable state for the
main app service. Apple silicon and Intel share this code path. Windows uses
Electron's startup registration and observed approval state. **Open Login Items
Settings** is available only where the app has a fixed macOS or Windows Settings
target.

On Linux, the app owns one exact per-user [XDG autostart desktop entry](https://specifications.freedesktop.org/autostart/0.5/).
Status reads do not create it. An explicit switch action may create the missing
XDG config directory and entry, or remove only the matching owned entry. A
malformed, unsafe, or unavailable entry never becomes a confident off state or
authorizes replacement. An AppImage uses its launch path; other packages use
their executable path. Linux has no universal system startup-settings target.

This is an unreleased source contract. Source tests, a disposable filesystem
round trip, and a macOS arm64 unsigned development-app render do not qualify a
signed Mac upgrade or an installed Windows/Linux login session. The Linux owner
still reports `productionSafe: false`; physical Linux launch, login, disable,
upgrade, and uninstall behavior must be qualified before a new release claims
that startup integration is verified.
