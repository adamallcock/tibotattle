---
title: Platform support and qualification
date: 2026-09-23
type: reference
status: maintained
---

# Platform support and qualification

The released Electron application is **0.1.24** across four distribution
targets: macOS Apple silicon, macOS Intel, Windows x64 and Linux x64. See
[current status](../current-status.md) for exact source, release and hosted
boundaries, and the [public release manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.24/release-manifest.json)
for the final artifact assurances.

## Status matrix

| Platform | Current distribution | Proven final-artifact boundary | Acceptance limits |
|---|---|---|---|
| macOS 14+ arm64 | Supported; 0.1.24 DMG | Developer ID signing, notarization/stapling, Gatekeeper and clean-install smoke for the exact artifact; native Sparkle transition passed | Existing-credential cases are unperformed and owner-accepted for this release; transition proof does not qualify them |
| macOS 14+ x86_64 | Supported; separate 0.1.24 Intel DMG | Separate native trust and clean-install smoke for the exact artifact; native Sparkle transition passed | Existing-credential cases are unperformed and owner-accepted; transition proof does not qualify them |
| Windows x64 | Released; 0.1.24 signed installer | Authenticode signing, timestamp and clean-install smoke for the exact artifact | Source and clean-install evidence do not establish existing-credential continuity or every physical update/desktop scenario |
| Linux x86_64 | Released; 0.1.24 AppImage | Exact artifact integrity; updater metadata bound to the AppImage | Physical FUSE/AppImage and existing-install coverage is unperformed and owner-accepted; manifest clean-install assurance remains false and native trust scheme is none |

The 2026-09-23 owner acceptance applies to the named unperformed macOS and Linux
coverage for 0.1.24. Earlier acceptances are not carried forward. None records
an unperformed test as passed or declares other platforms supported.
Windows ARM, Linux ARM64 and unlisted operating-system/package variants are not
covered. The four targets share an application source; they retain distinct
installer, trust, credential and desktop-integration evidence.

## Evidence ladder

Keep the following boundaries separate for every new release:

1. Source and automated contracts: selectors, schemas, bounded processing,
   filesystem/credential protection and negative behavior.
2. Final artifact: exact source/build identity, architecture, checksum and the
   selected platform's trust policy.
3. Installed lifecycle: fresh launch, retained-data upgrade, local processing,
   preferences, opt-out, restart and uninstall, with the actual tested scope.
4. Updates and desktop integration: replacement, tray, notifications and login
   behavior on the named operating system.
5. Publication: immutable installers, checksums, manifest, updater metadata,
   native transition feeds, website and distribution guidance agree.

An explicit owner acceptance must identify the remaining observations. It does
not convert source tests, a container run, metadata or a prior release into a
passed installed test. It never waives data preservation, exact artifact
binding, credential protection or update integrity.

## macOS

Both published Mac installers require macOS 14 or later and use bundle version
`1032`, with separate build provenance `2026092202`. Signed clean-install runs
passed for [Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/35794286643)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/35794288768).
The 0.1.24 native Sparkle-to-Electron transition also passed for
[Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/35794596134)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/35794598511).
These receipts qualify their exact scenarios, not every existing-credential case.
The [Homebrew publication workflow](https://github.com/adamallcock/homebrew-tap/actions/runs/35847887431)
also passed installer trust, audit, install and uninstall checks on both native
architectures for the published cask.
The incoming native Sparkle transition and the outgoing Electron updater are
separate paths. Installing the current app transfers compatible retained local
state; users should not need to preserve an old app bundle manually.

Existing-credential qualification cases remain unperformed and were explicitly
accepted for 0.1.24. This is unavailable test coverage, not proof that those
cases pass. The older [0.1.18 waiver](../decisions/2026-09-05-release-0-1-18-manual-qualification-waiver.md)
is historical. Acceptance does not permit unexpected automatic Keychain prompts,
weaken credential protection or waive data preservation and artifact authenticity.
Use the [Mac release runbook](../runbooks/macos-stable-release-runbook.md)
and [cross-platform publication contract](../runbooks/2026-08-18-cross-platform-release-publication.md)
for subsequent versions.

## Windows

The public 0.1.24 installer is signed and timestamped, and its manifest records
successful clean-install smoke. Earlier synthetic credential and portability
tests remain useful within their recorded scope; they do not establish continuity of an
existing user's credentials in a later installer. Physical update replacement
and notification appearance require their own exact installed evidence.

The 0.1.24 installer includes **Model performance on Windows x64**, using the
protected timing reader. Exact-head clean and warm native Windows qualification
and the unsigned packaged Electron normal journey passed for source
`f2e12fd0ffd717a2e4e22ac5e2774bb0a232b3df` before
[PR #199](https://github.com/adamallcock/tibotattle/pull/199) merged. The
[Windows model-performance plan](../plans/2026-09-13-windows-model-performance.md)
records that source qualification. The final 0.1.24 manifest separately records
the signed installer and clean-install assurance. These evidence scopes do not
establish every existing-install, update or credential scenario.

## Linux

The released package is the x86_64 AppImage, with no added repository/package
signing claim. Its final integrity and updater metadata are recorded; the
canonical manifest leaves `cleanInstallSmokePassed` false. Earlier isolated
Secret Service, packaged refresh and cold-restart tests do not prove every
physical desktop session, tray, notification, login or lifecycle behavior.
The owner explicitly accepted unperformed physical FUSE/AppImage and
existing-install coverage for 0.1.24. Those observations remain unperformed.

## Maintenance rule

Update this declaration from exact release evidence and explicit acceptance.
Do not infer current support from an open pull request, development build,
screenshot or old receipt. Every future release requires its own frozen source,
artifacts and qualification; current 0.1.24 publication does not satisfy them.
