---
title: Web Report and Native Toolbar Boundary
date: 2026-08-03
type: decision-record
status: accepted
---

# Web report and native toolbar boundary

## Decision

Keep the existing embedded WebKit report as TiboTattle's primary dashboard.
Move only the unified native toolbar treatment into the normal AppKit window;
do not replace the report with the native-first SwiftUI dashboard or introduce
a second web renderer.

The existing AppKit sidebar remains with the report. Its former in-content
status and refresh header is removed so the window has one clear toolbar, not
two competing control rows. The normal macOS title bar and traffic-light
window controls remain the standard `NSWindow` behavior already used by the
launcher.

## Ownership

| Layer | Owns | Does not own |
| --- | --- | --- |
| Node loopback companion | Codex metadata parsing, local accounting, cache/index work, and the existing overview and refresh routes | Native layout or presentation state |
| WebKit report | Rich charts, tables, explanatory text, report navigation, and the existing local share card | Parsing, accounting, or process lifecycle |
| AppKit window and toolbar | Window lifecycle, standard Mac controls, local status, refresh trigger, share-card focus, and settings | A second data model, parser, report renderer, or sharing process |

The toolbar's **Refresh usage** action calls the existing foreground refresh
path. **Share** only focuses the already-rendered `#share-panel` in the local
report. Neither action starts a helper, creates a native sharing service, or
adds a native-to-JavaScript data capability.

## Process boundary

The regular UI lifecycle starts one private loopback Node companion while the
app is open. It remains the sole authority for local usage accounting. The
five-minute `DispatchWorkItem` cadence is scheduling inside the foreground app
process; it is not a persistent worker or an OS background process. Closing or
quitting the app cancels those work items and stops the companion.

This decision does not alter the separately confirmed Keychain-reset helper.
That helper can run only after its explicit diagnostic confirmation, after the
companion has stopped, and performs no usage parsing or accounting.

## Explicit non-goals

- Do not transfer the SwiftUI native-first dashboard, its sparse card layout,
  or a second report implementation.
- Do not add a LaunchAgent, daemon, login item, background URL session, or
  toolbar-owned child process.
- Do not add a new Node API, a separate accounting store, or duplicate
  refresh cadence.

## Acceptance checks

1. The window retains the standard titled, closable, miniaturizable, and
   resizable AppKit style while using a unified toolbar.
2. The report is still loaded from the existing loopback companion into
   `WKWebView` and remains the source of rich report content.
3. Refresh invokes the existing `refreshLocalUsage(automatic: false)` path;
   share focuses the existing local share card.
4. Source contracts reject toolbar code that constructs a companion, `Process`,
   `URLSession`, or `NSSharingService`.
