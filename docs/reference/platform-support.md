---
title: Platform support and qualification
date: 2026-09-13
type: reference
status: maintained
---

# Platform support and qualification

The released Electron application is **0.1.22** across four distribution
targets: macOS Apple silicon, macOS Intel, Windows x64 and Linux x64. See
[current status](../current-status.md) for exact source, release and hosted
boundaries, and the [public release manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.22/release-manifest.json)
for the final artifact assurances.

## Status matrix

| Platform | Current distribution | Proven final-artifact boundary | Acceptance limits |
|---|---|---|---|
| macOS 14+ arm64 | Supported; 0.1.22 DMG | Developer ID signing, notarization/stapling, Gatekeeper and clean-install smoke for the exact artifact | Retained native/Electron upgrade receipts apply to 0.1.21, not 0.1.22 |
| macOS 14+ x86_64 | Supported; separate 0.1.22 Intel DMG | Separate native trust and clean-install smoke for the exact artifact | Remaining physical/manual Intel observations explicitly accepted by the owner, not recorded as passed |
| Windows x64 | Released; 0.1.22 signed installer | Authenticode signing, timestamp and clean-install smoke for the exact artifact | Remaining physical desktop/update/notification acceptance explicitly accepted by the owner; credential persistence and hosted enrollment were not requalified by that journey |
| Linux x86_64 | Released; 0.1.22 AppImage | Exact artifact integrity; updater metadata bound to the AppImage | Owner accepted remaining physical desktop/lifecycle qualification; manifest clean-install assurance remains false and native trust scheme is none |

These owner decisions apply to the named Electron release workstream. They do
not fabricate physical test results or declare other platforms supported.
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
`1029`. Their signed clean-install evidence is linked from
[current status](../current-status.md#published-electron-release). Retained
production-upgrade receipts qualify 0.1.21 and are not reused for 0.1.22.
The incoming native Sparkle transition and the outgoing Electron updater are
separate paths. Installing the current app transfers compatible retained local
state; users should not need to preserve an old app bundle manually.

The owner accepted the remaining physical/manual Intel observations in this
workstream. The older [0.1.18 waiver](../decisions/2026-09-05-release-0-1-18-manual-qualification-waiver.md)
is historical and is not the authority for this newer acceptance. Neither
acceptance permits unexpected automatic Keychain prompts or loss of retained
history. Use the [Mac release runbook](../runbooks/macos-stable-release-runbook.md)
and [cross-platform publication contract](../runbooks/2026-08-18-cross-platform-release-publication.md)
for subsequent versions.

## Windows

The public 0.1.22 installer is signed and timestamped. Its clean-install
normal journey confirms installation, normal local processing, uninstall and
owned cleanup. Earlier synthetic credential and portability tests remain
useful within their recorded scope; they do not establish continuity of an
existing user's credentials in a later installer. Physical update replacement
and notification appearance remain accepted user-testing limits.

The 0.1.22 **model-performance page is unavailable on Windows**. That is a
released-feature boundary, not a statement that the normal Windows application
or local usage processing is unavailable. The successor source enables the
protected timing reader. Exact-head clean and warm native Windows qualification
and the unsigned packaged Electron normal journey passed for source
`f2e12fd0ffd717a2e4e22ac5e2774bb0a232b3df` before
[PR #199](https://github.com/adamallcock/tibotattle/pull/199) merged. The
[Windows model-performance plan](../plans/2026-09-13-windows-model-performance.md)
records that source qualification. A signed final installer, installed/update
lifecycle evidence and publication remain separate gates for the next release;
the source result does not change the published 0.1.22 artifact.

## Linux

The released package is the x86_64 AppImage, with no added repository/package
signing claim. Its final integrity and updater metadata are recorded; the
canonical manifest leaves `cleanInstallSmokePassed` false. Earlier isolated
Secret Service, packaged refresh and cold-restart tests do not prove every
physical desktop session, tray, notification, login or lifecycle behavior.
The owner accepted these remaining desktop observations rather than blocking
this release on unavailable hardware tests.

## Maintenance rule

Update this declaration from exact release evidence and explicit acceptance.
Do not infer current support from an open pull request, development build,
screenshot or old receipt. Every future release requires its own frozen source,
artifacts and qualification; current 0.1.22 publication does not satisfy them.
