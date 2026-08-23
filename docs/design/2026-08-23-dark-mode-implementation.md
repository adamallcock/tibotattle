---
title: Forest Ink dark mode implementation
date: 2026-08-23
type: decision-record
status: implemented
---

# Forest Ink dark mode implementation

## Decision

Implement the selected Forest Ink direction as an explicit native-app
appearance, with **System**, **Light**, and **Dark** choices. System is the
default. The hosted public dashboard remains light unless a trusted native
host sets the document theme.

Selected visual reference:
`/Users/adamallcock/.codex/generated_images/01a02a7e-c752-7372-9a03-d31f0c75156b/exec-bbc7e489-fa82-40c9-a211-588d765f5c37.png`

## Palette

| Role | Value |
| --- | --- |
| Page | `#141A17` |
| Primary card | `#1B2521` |
| Raised control | `#24322C` |
| Primary text | `#F5F1E8` |
| Secondary text | `#BEC5BD` |
| Action accent | `#76AA9C` |
| Allowance feature band | `#2D7466` |
| Chart median | `#99C5BA` |
| Observed and informational | `#7D9EB8` |
| Warning | `#C5A46A` |
| Error | `#BD735F` |

## Implementation boundary

- Preserve every existing page, route, data contract, and component structure.
- Add a small semantic token split for inverted actions and feature surfaces.
- Apply the balanced allowance hero treatment: green metric band over a quiet
  dark explanation surface.
- Change the accounting information card to a quiet surface with a blue rail.
- Set the theme at WKWebView document start to prevent a light flash.
- Keep AppKit chrome and the embedded report on the same resolved appearance.
- Keep exported share-card artwork light and preference-independent in this
  release so a portable artifact does not vary by the viewer's local setting.

## Activation contract

The native host owns `window.__TIBOTATTLE_APPEARANCE__` and
`html[data-theme]`. Only `light` and `dark` are accepted resolved values. A
live `tibotattle:appearance-override` event updates the open dashboard without
reloading it or disturbing in-memory contribution and chart state.

Explicit Light and Dark choices resolve deterministically and do not depend on
AppKit update timing. System alone reads `NSApp.effectiveAppearance`, maps it
through AppKit's Aqua/Dark Aqua match, and resynchronizes the open report when
the report pane's effective appearance changes or the app becomes active.

## Verification gate

The work is complete only after focused web and native tests pass, every real
dashboard route is visually inspected in the rendered app, and the comparison
against the selected reference is recorded in the durable
[`Forest Ink dark mode verification`](../qa/2026-08-23-forest-ink-dark-mode.md)
receipt with `final result: passed`.
