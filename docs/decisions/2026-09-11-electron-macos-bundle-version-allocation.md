---
title: Electron macOS bundle version allocation
date: 2026-09-11
type: decision-record
status: accepted-source-contract
---

# Electron macOS bundle version allocation

Stable Electron 0.1.21 uses the explicit signed Mac allocation `1028` in
`config/macos-bundle-version-plan.cjs`. Both Mac architectures share it.
`CFBundleShortVersionString` remains `0.1.21`; the timestamp `buildNumber`
continues to identify the exact source candidate and artifact receipts.
The allocation itself is not signing, installation, or update evidence.

The native 0.1.18 predecessor uses `1026`, so Sparkle can order the new
bundle above it without relaxing Apple's version grammar or the Worker
validator. The held timestamp-based 0.1.21 installers must be rebuilt after
source integration. Previously frozen 0.1.19/0.1.20 artifacts and named private
rehearsal receipts retain explicit compatibility handling; they are not
allocations for future stable Mac releases. An unallocated future stable
release fails packaging.

## Two update entry points

Electron 0.1.20 has a larger timestamp `CFBundleVersion`, but its installed
updater selects releases by marketing semantic version. The locally pinned
`electron-updater` 6.8.9 `AppUpdater.isUpdateAvailable` compares `app.version`
with feed `version`; the regression executes this method for 0.1.20→0.1.21.
Its `MacUpdater` serves a URL-only loopback response to the default native
updater mode after choosing the candidate.

[Electron 43.2.0's dependency lock](https://github.com/electron/electron/blob/v43.2.0/DEPS)
pins Squirrel.Mac commit `0e5d146ba13101a1302d59ea6e6e0b3cace4ae38`.
[Electron's native adapter](https://github.com/electron/electron/blob/v43.2.0/shell/browser/auto_updater_mac.mm)
selects its default release-server mode for this call.
That mode's [download preparation](https://github.com/Squirrel/Squirrel.Mac/blob/0e5d146ba13101a1302d59ea6e6e0b3cace4ae38/Squirrel/SQRLUpdater.m)
and [installer verification](https://github.com/Squirrel/Squirrel.Mac/blob/0e5d146ba13101a1302d59ea6e6e0b3cace4ae38/Squirrel/SQRLInstaller.m)
verify the signed replacement without ordering `CFBundleVersion`.
Electron's applied [optional downgrade guard](https://github.com/electron/electron/blob/v43.2.0/patches/squirrel.mac/feat_add_ability_to_prevent_version_downgrades.patch)
uses `CFBundleShortVersionString`, not the build number. The other pinned
Squirrel patches introduce no build-number comparison.

This supports the source-level expectation that Electron 0.1.20→0.1.21
accepts the corrected allocation. Actual signed replacement remains required,
as does native 0.1.18→Electron through its real Sparkle Check for Updates flow.

## Verification contract

Signed artifact and installed-app inspectors call
`assertProductionElectronMacOSBundleMetadata` with actual plist values and
independently bound target, semantic version, and provenance build number.
The validator rejects a missing value, stale marketing version, wrong
allocation, or timestamp substituted for `1028`. Final updater metadata must
still bind the exact final signed ZIP/DMG bytes; this change does not weaken
that separate check or publish any artifact.
