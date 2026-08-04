---
title: TiboTattle macOS localization foundation
date: 2026-08-03
type: decision-record
status: implemented-foundation
---

# TiboTattle macOS localization foundation

## Audit conclusion

The native launcher had no localization resource bundle or locale-aware
formatting boundary. The embedded dashboard currently owns its own English
copy and formatting helpers. CodexBar's useful pattern is its native
[`Localization.swift`](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBar/Localization.swift)
resolver over `.lproj` resources, system-language selection, and an explicit
English fallback; its [General language picker](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBar/PreferencesGeneralPane.swift)
is meaningful because it has shipped translated locales.

## Implemented boundary

- `apps/macos/Resources/en.lproj/Localizable.strings` is the English source
  catalog for stable `menu.*` and `settings.*` keys.
- `apps/macos/Sources/Localization.swift` follows `Locale.preferredLanguages`,
  falls back to `en.lproj`, and always formats with `Locale.current`.
- `localization/manifest.json` records the cross-surface table, fallback,
  supported locales, and the web-facing resource root.
- The macOS build copies native `.lproj` resources into the bundle and mirrors
  them under `Contents/Resources/app/localization/` for the embedded dashboard.
- `DashboardWebHost` injects `window.__TIBOTATTLE_LOCALIZATION__` at document
  start with the schema, fallback, preferred-language list, and
  `./localization` resource root. The dashboard does not switch languages yet;
  future web localization should consume this handoff and the same catalog.

There is deliberately no language picker yet. A picker would be misleading
while English is the only shipped translation. The app therefore remains on
macOS system language/region behavior by default, with English as the safe
translation fallback. General settings exposes this actual behavior as a
read-only `Language` / `System` row with the regional-format explanation; it
has no override action.

## Next locale gate

Before adding a picker, add one complete locale (recommended next: `de` or
`fr`, selected from measured user demand), translate the catalog and dashboard
surface together, add plural/date/number fixtures, and verify the packaged
native and WebKit resource paths. Only then should a persisted override be
introduced, with a restart or live-refresh policy chosen explicitly.
