---
title: TiboTattle cross-surface localization system
date: 2026-08-03
type: decision-record
status: complete
---

# TiboTattle cross-surface localization system

## Decision

Ship three product languages now:

- `en-US` is the source and unconditional fallback.
- `zh-Hans` is Simplified Chinese, not a generic `zh` or Traditional-Chinese
  fallback.
- `es` is one Spanish catalog for the initial release.

The choice is a reach-based starting point, not a claim about TiboTattle's own
user telemetry. GitHub's 2024 Octoverse report identifies China as a major
developer population and calls out continued developer growth in several
Spanish-speaking Latin American countries and Spain. Instituto Cervantes'
2025 report records more than 630 million potential Spanish speakers. Apple
documents `zh-Hans` as the BCP 47 script tag for Simplified Chinese. These are
relevant global reach signals, not proof of demand from a particular customer
cohort.

- [GitHub Octoverse 2024](https://github.blog/news-insights/octoverse/octoverse-2024/)
- [Instituto Cervantes 2025 Spanish-language report](https://cvc.cervantes.es/lengua/anuario/anuario_25/moreno-alvarez/p01.htm)
- [Apple: choosing localization regions and scripts](https://developer.apple.com/documentation/xcode/choosing-localization-regions-and-scripts?language=objc)

## Architecture

### Native macOS shell

`apps/macos/Sources/Localization.swift` owns a closed `Key` inventory and a
small resolver. It reads `en.lproj`, `zh-Hans.lproj`, and `es.lproj` standard
`Localizable.strings` resources. The resolver checks a persisted explicit
choice first, otherwise examines `Locale.preferredLanguages`, and finally uses
English. It deliberately maps only `zh-Hans`, `zh-CN`, and `zh-SG` to the
Simplified Chinese catalog. `zh`, `zh-Hant`, and `zh-TW` fall back to English
until a matching catalog is shipped.

General settings shows a native language picker for **System**, English,
Simplified Chinese, and Spanish. The choice is stored under the product's
UserDefaults key `tibotattle.language-preference.v1`. Changing it rebuilds
native settings/menu labels using AppKit's natural text measurement, refreshes
the menu-bar labels, and notifies the already loaded dashboard. It never
reloads the dashboard merely to change copy.

First-run, recovery, download, data-management, Codex-folder, and destructive
identity-reset dialogs use the same closed native key inventory. Diagnostic
payload values themselves remain technical local evidence rather than
translated product copy.

### Local dashboard and public community site

`apps/web/public/localization.js` is a dependency-free ES module used by both
browser entry points. It provides:

- BCP 47 negotiation and the same safe Simplified-Chinese rule as native;
- a browser `localStorage` preference for the public site;
- a native-host handoff for the non-persistent local WebView;
- semantic messages (including a small `Intl.PluralRules` catalog) for
  generated browser copy and a bounded exact-text bridge for existing static
  HTML and explicitly registered product nodes;
- `documentElement.lang` and `documentElement.dir`; and
- language picker binding and `tibotattle:locale-change` events.

The `DashboardWebHost` injects a versioned handoff before page scripts run.
The only WebKit message it accepts is a main-frame object with exactly the
closed language-preference values. It contains no provider payload, account
data, or opaque sign-in proof. Native changes dispatch a local DOM event to
the existing document; the hosted-sign-in return remains its independent
`tibotattle:hosted-sign-in-return` event and is not replaced by a navigation.

### 2026-08-04 hardening update

Before every later local-dashboard navigation, `DashboardWebHost` removes and
reinstalls its two document-start scripts. That makes a newly loaded document
receive the current native preference while a live picker change continues to
use only the DOM event; it therefore cannot discard a page-local one-time
hosted-sign-in handoff.

Browser exact-text localization is now constrained to explicit
`data-i18n-legacy-root` regions beneath a `data-i18n-root`. Product-generated
legacy text must use `setLegacyText`; new generated copy uses a stable
`WEB_MESSAGES` or `WEB_PLURAL_MESSAGES` key. Any user, local-report, provider,
file, identity, JSON, SVG, or diagnostic value must use the raw-text helper or
live beneath `data-i18n-skip`. This means a raw value is never reinterpreted
as product copy merely because it happens to equal an English catalog entry.

The language picker has a polite status announcement for screen-reader users.
Tests exercise pseudo-localization for expansion and placeholder preservation;
pseudo-localization is a test fixture, never a selectable shipped language.
The shareable results card, its canvas accessibility transcript, and its
locale-formatted dates/numbers use the same semantic catalog. Its wrapping
falls back to grapheme segmentation for scripts without spaces, while its
fixed source-data allowlists continue to prevent provider/user labels from
reaching a share image.

The same hardening pass routes native launcher failures and recovery actions,
first-run updater disclosures, Codex-source summaries, menu-bar unavailable
states, and status-icon accessibility text through the closed AppKit key
inventory. A translated app can therefore recover or explain an unavailable
companion without falling back to a hidden English-only error branch.

### Formatting, safety, and RTL

Translation language and display formatting are independent. Native values use
`Locale.current`; browser values use `Intl` with the browser/system regional
locale (or the macOS `formatLocale` handoff). A Spanish or Chinese copy choice
therefore cannot alter event instants, time zones, quota arithmetic, pricing,
source provenance, notification eligibility, or provider data.

Browser localization writes only text nodes, `textContent`, and selected
attributes. It does not interpolate translated or untrusted values as HTML.
The CSS uses logical inline properties for the directional UI paths, and the
localizer is tested with an RTL direction fixture. No RTL-language catalog is
claimed or shipped in this release.

## Component decision

Do not add i18next or another runtime dependency. The app has a native AppKit
bundle plus ordinary static ES modules, only three initial locales, and no
server-rendered translation service. Apple `.lproj` resources and `Intl` are
already present and reduce both package and offline failure surface. The small
shared resolver is tested because it carries the policy that must agree across
the native and web boundaries. `packages/i18n` remains dependency-free and
provides the same catalog/negotiation primitives for non-DOM callers.

## Translation provenance and privacy boundary

The `zh-Hans` and `es` strings are machine-assisted initial translations
reviewed for key parity, placeholders, units, URLs, product names, folder
names, shortcut syntax, and the meaning of privacy/security claims. They are
not represented as human linguistic certification. Native and browser tests
make an omitted key or changed interpolation signature fail visibly, but a
native-speaking editorial pass is still required before making a quality or
legal-translation claim.

No local logs, provider content, account data, tokens, prompts, paths, or
credentials are sent to a translation API. Source code, raw provider output,
diagnostics, audit records, and user data remain out of localization scope.

## Contributor workflow

1. Add a stable semantic key to `TiboTattleLocalization.Key` for native copy,
   or `WEB_MESSAGES` for generated browser copy. Do not use translated prose
   as a program key.
2. Add every initial-locale value in the same patch. Preserve placeholders,
   URLs, product names, units, keyboard notation, and privacy/security meaning.
3. For a static HTML migration entry, add the original exact text to
   `LEGACY_TEXT_CATALOG`, place it inside an explicit legacy root, then prefer
   a semantic key for new DOM code. Do not register an untrusted value with
   that bridge; use `data-i18n-skip`/the raw-text helper instead.
4. Use `WEB_PLURAL_MESSAGES` and `Intl.PluralRules` for count-dependent copy;
   do not concatenate English singular/plural suffixes around a formatted
   value.
5. Run the localization parity tests, browser module-serving test, targeted
   web tests, and native typecheck/build checks.
6. Inspect English, Simplified Chinese, and Spanish at normal and narrow
   viewport widths. Check menu/dialog text expansion in a packaged build.

## Future locale checklist

- Establish a user-reach or customer-demand rationale; do not infer it from a
  broad language label alone.
- Add a distinct BCP 47 tag and decide whether its script/region can safely
  match an existing request. Never use a Traditional-Chinese request as a
  Simplified-Chinese fallback.
- Complete native resources, semantic browser messages, and reviewed static
  text in one change; update the manifest and tests.
- Add plural/select handling if the locale requires it rather than trying to
  force English singular rules through a single string.
- Add visual, VoiceOver, text-expansion, and direction QA. An RTL locale also
  needs a separate human-language review before it may be described as shipped.
- Recheck all privacy, deletion, background-process, and network claims
  against the actual product behavior.

## Release QA boundary

Automated checks cover catalog/key parity, placeholder parity, locale
negotiation, override persistence, native resource staging, WebKit handoff
shape and reload refresh, browser bundle inclusion, locale-aware
number/date/percent formatting, plural forms, raw-data boundaries, RTL
direction, pseudo-localized expansion, and text-only DOM updates. A signed,
freshly installed bundle is still required to validate macOS system-language
discovery, AppKit menu expansion, and VoiceOver on a clean profile. Before a
release claims translation quality, have native speakers review both catalogs,
especially privacy, deletion, security, and background-process copy.
