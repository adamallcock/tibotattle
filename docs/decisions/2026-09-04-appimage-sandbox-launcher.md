---
title: Preserve sandboxing in Electron AppImage launchers
date: 2026-09-04
type: decision-record
status: accepted
---

# Preserve sandboxing in Electron AppImage launchers

The pinned `app-builder-lib` 26.15.7 generates an AppRun script that adds
`--no-sandbox` when `unshare -Ur true` fails. Its desktop-entry default also
adds that switch unless executable arguments are explicitly supplied. Neither
behavior is appropriate for TiboTattle's sandboxed renderer boundary.

Keep the existing builder and its checksum-verified runtime/tool downloads.
Set Linux executable arguments to an empty list and apply the
[minimal dependency patch](../../config/patches/app-builder-lib@26.15.7.patch)
through the frozen pnpm lockfile. The launcher passes ordinary arguments
unchanged, rejects sandbox-disabling arguments, and lets Chromium enforce its
normal namespace or setuid-helper requirements. A machine without usable
sandbox support must fix its platform configuration before running this app.

The [launcher regression](../../test/electron-appimage-launcher.test.js)
executes the actual installed dependency's generated Bash script against a
disposable executable with no `unshare` available. It proves argument
preservation and refusal before launch. The common development packager runs
this check before producing a Linux artifact. This is launcher evidence;
it does not qualify a particular Linux desktop or kernel.

Linux development distributions may be built on macOS using the pinned
builder's Darwin AppImage/archive tools and Linux x64 runtime/native bytes.
The receipt records the actual host and keeps `nativeHost: false` and
`runtimeExecuted: false`. The four-target workflow still builds Linux on its
native x64 runner. The patch affects packaging only and can be removed after
an upstream version preserves these semantics and passes the same regression.
