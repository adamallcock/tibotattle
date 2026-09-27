---
title: Platform support and qualification
date: 2026-09-27
type: reference
status: maintained
---

# Platform support and qualification

The released Electron application is **0.1.26** across macOS Apple silicon,
macOS Intel, Windows x64 and Linux x64. See [current status](../current-status.md)
for the source, updater, Homebrew and hosted boundaries, and the
[public release manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.26/release-manifest.json)
for exact artifact hashes and recorded assurances.

## Status matrix

| Platform | Current distribution | Proven final-artifact boundary | Acceptance limits |
|---|---|---|---|
| macOS 14+ arm64 | Supported; 0.1.26 DMG | Developer ID signing, notarization, stapling, Gatekeeper, clean-install smoke, production Sparkle transition and installed Electron updater on the exact signed candidate | Existing-credential continuity passed its named older-app scenarios; full failure matrix remains unqualified |
| macOS 14+ x86_64 | Supported; separate 0.1.26 Intel DMG | Separate native trust, clean-install, production Sparkle transition and installed Electron updater | Existing-credential upgrade was not exercised on Intel; full failure matrix remains unqualified |
| Windows x64 | Released; 0.1.26 signed installer | Authenticode signature, timestamp and hosted installed journey on the exact candidate | Existing-install updater replacement and every physical desktop integration are not qualified |
| Linux x86_64 | Released; 0.1.26 AppImage | Exact artifact integrity and hosted extracted-app startup, refresh, credential-service, settings, opt-out and cold restart | Physical desktop launch, AppImage/FUSE mounting and replacement were not tested; the owner accepted publication with `cleanInstallSmokePassed: false` |

The 2026-09-27 Linux owner acceptance applies to the exact published AppImage
and its listed missing observations. It is not a passing physical install test.
Windows ARM, Linux ARM64 and unlisted operating-system or package variants are
not covered. Shared application source does not make platform-specific trust,
credential or installed-lifecycle evidence interchangeable.

## Evidence ladder

Keep these boundaries separate for every release:

1. Source and automated contracts: selectors, schemas, bounded processing,
   filesystem and credential protection, and negative behavior.
2. Final artifact: exact source/build identity, architecture, checksum and the
   selected platform's trust policy.
3. Installed lifecycle: fresh launch, retained-data upgrade, local processing,
   preferences, opt-out and restart on the named operating system.
4. Updaters and desktop integration: replacement, relaunch, tray,
   notifications and login behavior where tested.
5. Publication: immutable installers, checksums, manifest, stable updater
   metadata, native transition feeds, website and distribution guidance agree.

An explicit owner acceptance identifies missing observations; it does not
convert source tests, a container run, metadata or a prior release into a
passed installed test. It never waives data preservation, credential protection
or updater integrity.

## macOS

Both Mac installers use bundle version `1034` and build number
`2026092701`. The signed [Apple silicon clean-install](https://github.com/adamallcock/tibotattle/actions/runs/36349376027)
and [Intel clean-install](https://github.com/adamallcock/tibotattle/actions/runs/36349377398)
runs passed. The native Sparkle-to-Electron upgrade passed against the
production feeds on [Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/36350924405)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/36350929763).
The separate Electron 0.1.20-to-0.1.26 updater passed on
[Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/36351718654)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/36351723582);
those receipts verified retained rows, settings, salt, opt-out and restart.

The signed Apple silicon existing-Keychain-credential upgrade cases passed from
[0.1.24](https://github.com/adamallcock/tibotattle/actions/runs/36349405714)
and [0.1.20](https://github.com/adamallcock/tibotattle/actions/runs/36349407322)
with modern, invalid and locked fixtures. The complete credential failure
matrix is still unqualified. Unexpected automatic Keychain prompts remain a
release blocker; do not weaken credential protection to avoid them. Use the
[Mac release runbook](../runbooks/macos-stable-release-runbook.md) for the exact
migration and updater contracts.

The [Homebrew cask workflow](https://github.com/adamallcock/homebrew-tap/actions/runs/36351745490)
passed and the first-party cask resolves 0.1.26 with the exact published arm64
and x64 DMG hashes. Cask resolution is separate from an installed upgrade.

## Windows

The 0.1.26 installer is signed and timestamped. Its
[hosted installed journey](https://github.com/adamallcock/tibotattle/actions/runs/36347063769)
qualifies the exact signed candidate. It does not establish every existing
installation's updater replacement, retained credentials or physical desktop
notification behavior. Do not promote earlier unsigned or source-only Windows
tests into final-artifact evidence.

## Linux

The released x86_64 AppImage has no native signing claim. The
[hosted extracted-app run](https://github.com/adamallcock/tibotattle/actions/runs/36347037857)
passed startup, refresh, credential-service, settings, opt-out and cold restart
against the final artifact. It did not mount the AppImage through FUSE, launch
it on a physical desktop or replace 0.1.24. The
[manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.26/release-manifest.json)
keeps `cleanInstallSmokePassed: false` and records the owner's explicit
acceptance of those limits. No update or desktop-integration claim follows from
the extracted runtime result.

## Maintenance rule

Update this declaration from exact release evidence and explicit acceptance.
Do not infer current support from an open pull request, development build,
screenshot or old receipt. A future release needs its own frozen source,
artifacts and qualification.
