---
title: Forest Ink dark mode verification
date: 2026-08-23
type: qa
status: passed
---

# Forest Ink dark mode verification

This receipt qualifies the Forest Ink implementation for source review. It is
not a signed-app, notarization, installation, release, or update-channel
receipt.

## Scope

- Review base: current `origin/main` as fetched on 2026-08-23.
- Branch delta: one Forest Ink feature commit plus one focused manual-reload
  correction, with no unrelated local-main commits.
- Browser state: real `apps/web/public` modules in the native-dashboard shell,
  using the repository's built-in and visibly labelled `demoDashboard()`
  fixture.
- Native state: freshly compiled development bundle with ad-hoc signing only.
- Appearance choices: System, Light, and Dark, with System as the invalid or
  unset preference fallback.

The public dashboard remains light unless the native host supplies the closed
`light` or `dark` appearance contract. The portable share-card artwork remains
light and preference-independent.

## Automated verification

| Gate | Result |
| --- | --- |
| `npm run product:ui:test` | 325 passed, 0 failed, 0 skipped |
| `node --test --test-concurrency=1 test/macos-app-bundle.test.js` | 51 passed, 0 failed, 1 skipped |
| `npm run product:macos:build` | Development bundle built successfully |
| `--native-appearance-settings-contract-smoke-test` | Passed; default, persistence, fallback, System resolution, and explicit overrides |
| `--native-settings-layout-smoke-test` | Passed; no page or control overflow |
| `--native-dashboard-layout-smoke-test` | Passed at 974 × 860 points |
| `npm run architecture:check` | Passed; 373 production files and 1,467 imports |
| `npm run docs:links:check` | Passed; documentation links normalized |
| `git diff --check origin/main...HEAD` | Passed |

The one native-suite skip is the existing preview-distribution test, which is
explicitly skipped when the pinned Sparkle framework has not been prepared in
the checkout. It does not skip the appearance implementation or development
bundle.

The first sandboxed native-suite attempt could not bind its loopback fixture
and could not observe one spawned-app termination. The required rerun outside
that sandbox passed both cases, including the signed-app watchdog and central
readiness relay.

### Development build receipt

- Payload SHA-256:
  `2fb6ae8a24eaa30682db1321148501c429216f10c942f163097dfa7b1c65cde7`
- Source SHA-256:
  `44f6028260747f3eb5ea3d96bf8ef3d86f0a2172653b75548b287f1315bb2794`
- Channel: development
- Signing: ad hoc only
- External distribution requested: false

## Structural and edge-case verification

- A missing or unrecognized persisted appearance resolves to System.
- System leaves `NSApp.appearance` unset so macOS remains the source of truth.
- Light and Dark resolve deterministically to AppKit Aqua and Dark Aqua and
  remain fixed even when given the opposite effective system appearance.
- The WKWebView document-start handoff accepts only `light` and `dark` before
  stylesheet paint, then retries the theme-color update at DOM readiness.
- A missing theme-color element and an invalid live event are safe no-ops.
- The open report receives a live event rather than reloading and losing page
  or chart state.
- Every live appearance update also refreshes the bounded document-start
  snapshot, so a later WebView context-menu Reload cannot replay the theme
  that was current when the host was first constructed.
- System appearance changes are relayed from the report pane while active and
  resynchronized when the app becomes active again.
- Native report paper, sidebar wash, and accent use the same resolved palette
  as the embedded report.
- Appearance labels are present in English, Spanish, and Simplified Chinese;
  the compiled development bundle validates the `.strings` files.

## Rendered verification

The final branch was reloaded in the Codex in-app browser at a 506 × 737 CSS-px
viewport with DPR 2.66. The rendered page reported:

- `html[data-theme="dark"]` and computed `color-scheme: dark`;
- page background `rgb(20, 26, 23)` (`#141A17`);
- allowance feature background `rgb(45, 116, 102)` (`#2D7466`);
- explanation text `rgb(190, 197, 189)` (`#BEC5BD`);
- the weekly route as the only visible dashboard section;
- a visible labelled-demo disclosure;
- zero horizontal overflow; and
- no captured browser warnings or errors.

The loaded page was then exercised through the same live event the native host
uses, without navigation or reload. Light changed `html[data-theme]`, computed
`color-scheme`, the page background, and the theme-color metadata to the light
values. An unsupported `sepia` value was ignored and left Light intact. Dark
restored all four dark values while the `#weekly` route and in-memory document
were preserved.

After the owner reported that WebKit's context-menu Reload could replay a
stale initial theme, the native host was corrected to refresh its
document-start snapshot whenever the resolved appearance changes. The rebuilt
source contract is covered by the native bundle suite. A separate full-page
browser reload preserved `html[data-theme="dark"]`, computed dark color scheme,
the `#weekly` route, the `#141A17` page background, and a clean console.

The earlier route pass covered Overview, Allowance, Trends, Usage and costs,
Community, and the information popover at 962, 700, and 390 CSS px. It found no
clipping, overlapping controls, or hidden content. The rebased feature applied
cleanly to current `origin/main`, and the fresh narrow rendered pass preserved
that responsive behavior.

Measured contrast ratios were 15.66:1 for primary text on the page, 10.01:1
for secondary text on the page, 5.47:1 for feature text, and 6.72:1 for dark
action ink. Informational, warning, and error copy measured 9.08:1, 8.44:1,
and 6.67:1 on primary cards.

## Local visual artifact hashes

Screenshots remain transient local QA artifacts, consistent with repository
policy. Their hashes make the reviewed captures identifiable without placing
generated images or demo output in source control.

| Capture | SHA-256 |
| --- | --- |
| Full reference comparison | `e3a0e16b7fd1e3610bd370dead8ceec7f2bc88640fb27ad05729c5d461d46aea` |
| Focused 700 px comparison | `fffb4e0b05ce140fb084b64d9f54c9a9b384f3eb0498f7301183ebd390fd9f9e` |
| Overview | `95143a8b6384f62ff9106bfc7c23fb87e9eb2f338b62ca51854062e884f15ae7` |
| Allowance | `189c6068c5f3bfac64248ff56685c40fee39dc2deae3b132a4da847fc84ed8c2` |
| Trends | `c73afd68a58e5337dadb1f03ee1a9097866622470666c40a7378cce25ee2d439` |
| Usage and costs | `ec1b106a0296cdcc379c0dd8114a6b7bb58639deddf7cbb3a700ceff4cd5b0e5` |
| Community | `72ecc5cce46dfd0e2613aa577c175f6e0045d0f7ce0c174b824b080efda25ca5` |
| Information popover | `fa98dff0215380b4811ccff25c5fa0cc26985450676b65516855009c7d34d1b5` |

## Remaining release boundary

The implementation is ready for team code and design review. A separately
installed, signed app should still exercise System → Light → Dark → System and
context-menu Reload after each choice on real user data before release. A
local interactive attempt was excluded from the receipt because another
development bundle owned the shared companion and an experimental future index
schema was present; neither was changed. No installed app, stable artifact,
notarized artifact, appcast, or public deployment was changed by this work.

final result: passed
