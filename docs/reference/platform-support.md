---
title: Platform support and qualification
date: 2026-11-27
type: reference
status: maintained
---

# Platform support and qualification

[TiboTattle 0.1.30](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.30)
ships Electron installers for macOS Apple silicon, macOS Intel, Windows x64 and
Linux x86_64. [Current status](../current-status.md) ·
[0.1.30 artifact hashes and assurances](https://github.com/adamallcock/tibotattle/releases/download/v0.1.30/release-manifest.json)

## Status matrix

### 0.1.31 source candidate

Candidate 0.1.31 targets macOS 14+ on Apple silicon and Intel, Windows x64,
and Linux x86_64. The packaging build is `2026112701`, and both Mac
architectures share bundle version `1039`. Final artifact and installed
qualification for these targets are pending. [Candidate notes](../../release-notes/0.1.31.md)

### 0.1.30 artifact qualification

These runs qualified the exact 0.1.30 installers built from
`0bb1fa31932a56adeb54d8abbb17118d2e1d434f`. Both Mac installers used bundle
version `1038` and packaging build `2026112101`.

| Platform | Tested distribution | Proven final-artifact boundary | Qualification limits |
|---|---|---|---|
| macOS 14+ arm64 | 0.1.30 Apple silicon DMG | Developer ID signing, hardened runtime, notarization, stapling and Gatekeeper. [Clean install](https://github.com/adamallcock/tibotattle/actions/runs/44946175161), [existing Keychain fixture](https://github.com/adamallcock/tibotattle/actions/runs/44946174986) and [isolated native Sparkle upgrade](https://github.com/adamallcock/tibotattle/actions/runs/44946175344) passed. | Credential qualification covers the named Apple silicon fixtures. The prerelease Sparkle run used an isolated signed feed. |
| macOS 14+ x86_64 | 0.1.30 Intel DMG | Developer ID signing, hardened runtime, notarization, stapling and Gatekeeper. [Clean install](https://github.com/adamallcock/tibotattle/actions/runs/44946291329) and [isolated native Sparkle upgrade](https://github.com/adamallcock/tibotattle/actions/runs/44946291019) passed. | The prerelease Sparkle run used an isolated signed feed. Existing Keychain credential scenarios remain unqualified on Intel. |
| Windows x64 | 0.1.30 NSIS installer | [Authenticode signature, timestamp and clean install](https://github.com/adamallcock/tibotattle/actions/runs/44945169607) passed. [Signed 0.1.29 to 0.1.30 installer replacement](https://github.com/adamallcock/tibotattle/actions/runs/44946260235) retained synthetic history, projects, threads, settings and opt-out through cold restart. | The run used direct NSIS replacement. Automatic updater replacement, credential continuity, hosted enrollment and notifications remain unqualified by this run. |
| Linux x86_64 | 0.1.30 AppImage | [Final package and extracted runtime](https://github.com/adamallcock/tibotattle/actions/runs/44945169678) and [native Xvfb/FUSE lifecycle](https://github.com/adamallcock/tibotattle/actions/runs/44945652662) passed. The latter exercised clean install, isolated update from 0.1.29, cold restart, continuity and cleanup. | The lifecycle used a disposable Ubuntu runner and an isolated feed. Physical desktop behavior, production-feed installed updating and native signing remain outside this evidence. |

The installed production updater tests passed on both Mac architectures.
The native Sparkle path upgraded 0.1.18 to the published 0.1.30 app through the
retained native feeds on [Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/44948896128)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/44948895989).
The Electron path upgraded the exact public 0.1.29 predecessor to 0.1.30 through
the stable Electron feeds on [Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/44948563976)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/44948682354).
All four runs exercised the production feeds without a feed override.
[Public feed readback](../receipts/2026-11-21-v0-1-30-release-publication.md#stable-updater-feeds)

### October 9, 2026 qualification for 0.1.28

The following historical tests refer to the October 9 release and its exact
[0.1.28 artifacts](https://github.com/adamallcock/tibotattle/releases/download/v0.1.28/release-manifest.json).

| Platform | Tested distribution | Proven final-artifact boundary | Acceptance limits |
|---|---|---|---|
| macOS 14+ arm64 | Supported; 0.1.28 DMG | Developer ID signing, notarization, stapling, Gatekeeper, clean install, named existing-credential fixtures and production native Sparkle upgrade on the exact signed candidate; production Electron upgrade with discoverable Codex logs | See the retained-history limitation below; complete credential failure matrix remains unqualified |
| macOS 14+ x86_64 | Supported; separate 0.1.28 Intel DMG | Separate native trust, clean install and production native Sparkle upgrade; production Electron upgrade with discoverable Codex logs | See the retained-history limitation below; existing-credential upgrade was not exercised on Intel; full failure matrix remains unqualified |
| Windows x64 | Released; 0.1.28 signed installer | Authenticode signature, timestamp and fresh-VM installer replacement of 0.1.26, retaining synthetic history, settings and opt-out through cold restart | Automatic updater was not exercised; credential persistence, hosted enrollment and notification delivery are not qualified by this journey |
| Linux x86_64 | Released; 0.1.28 AppImage | Exact artifact integrity and native x64 Xvfb/FUSE clean install, isolated 0.1.26 update, sandbox, refresh, credentials, settings, opt-out, restart and cleanup | Physical desktop behavior and production-feed installed updating remain unqualified; no native-signing claim |

These receipts qualify the named final artifacts and bounded environments.
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

Both 0.1.28 Mac installers used bundle version `1036` and build number
`2026100901`. The signed [Apple silicon clean-install](https://github.com/adamallcock/tibotattle/actions/runs/37881967388)
and [Intel clean-install](https://github.com/adamallcock/tibotattle/actions/runs/37882729563)
runs passed. The native Sparkle 0.1.18-to-0.1.28 upgrade passed through the
production feeds on [Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/37931481287)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/37932090365).
These journeys exercised the updater, relaunch and migration; preserved rows,
preferences, salt and opt-out; and passed restart without duplicates while
leaving the native source untouched and stopping owned processes. Neither used
a feed override, a runner-copied candidate or an existing-credential fixture.

At publication, all four Electron stable feeds and both native Sparkle feeds
advertised 0.1.28 in public readback. Production Electron 0.1.26-to-0.1.28 updates passed
on [Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/37942774119)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/37949180932),
using authentic predecessor fixtures with discoverable Codex logs. Both
installed and relaunched the exact released app automatically, observed the
predecessor exit naturally, preserved rows, preferences, salt and opt-out, and
passed restart without duplicates and cleanup. Neither used a feed override,
a runner-copied candidate or an existing-credential fixture.

Earlier failed attempts remain distinct evidence:

- The initial [Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/37931476122)
  and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/37931485225)
  attempts stopped at the predecessor baseline before invoking an updater action.
- The R2 [Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/37935683930)
  and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/37935688350)
  attempts installed and relaunched 0.1.28 but failed before continuity
  qualification; their exact cause remains unproven.
- The R4 [Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/37939063066)
  and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/37939068480)
  runs verified automatic installation, exact released-app relaunch and cleanup,
  then failed at `successor_state_timeout` before continuity qualification.
- The [Intel R5 attempt](https://github.com/adamallcock/tibotattle/actions/runs/37942780042)
  stopped at `predecessor_process_identity`; the [Intel R6 attempt](https://github.com/adamallcock/tibotattle/actions/runs/37946253256)
  stopped after Install at `process_identity`. Both completed cleanup but did
  not qualify the successor or continuity. These observation failures do not
  establish an application-level upgrade failure.

The failed receipts do not identify lost rows or establish data loss; their
false continuity flags record incomplete qualification.

Released 0.1.28 also has a source-confirmed limitation when only a retained
0.1.26 format-11 index remains and no Codex rollout files survive. Ordinary
Refresh, startup refresh and automatic cadence do not trigger migration, and
the current reader rejects the old index. Its unified history projection is
therefore unavailable, although cached summaries may remain. No row deletion
has been proved. The passed journeys with discoverable logs do not close
this separate limitation.

The signed [Apple silicon existing-Keychain-credential run](https://github.com/adamallcock/tibotattle/actions/runs/37882400348)
passed 0.1.20-to-0.1.28 modern, invalid and locked fixtures, preserving items,
values and access controls. It also verified local synthetic historical Sol
repair through parser 20 with token and replay conservation. Intel existing
credentials and the complete credential failure matrix remain unqualified.
Unexpected automatic Keychain prompts remain a release blocker; do not weaken
credential protection to avoid them. Use the
[Mac release runbook](../runbooks/macos-stable-release-runbook.md) for the exact
migration and updater contracts.

The [Homebrew cask workflow](https://github.com/adamallcock/homebrew-tap/actions/runs/37930525017)
passed all four jobs. The cask readback resolved 0.1.28 with the published
arm64 and x64 DMG hashes. Cask resolution is separate from an installed upgrade.

## Windows

The 0.1.28 installer is signed and timestamped. Its
[fresh-VM installer-upgrade journey](https://github.com/adamallcock/tibotattle/actions/runs/37880387839)
installed the exact signed 0.1.26 predecessor, ran the exact 0.1.28 installer,
and preserved synthetic history, projects, threads, settings and durable opt-out
through the successor journey and cold restart. Uninstall and owned cleanup
passed. Automatic updater replacement was not exercised; this normal journey
does not requalify credential persistence, hosted enrollment or notification
delivery. Earlier unsigned or source-only Windows tests are not final-artifact
evidence.

## Linux

The released x86_64 AppImage has no native signing claim. The
[native x64 Xvfb/FUSE run](https://github.com/adamallcock/tibotattle/actions/runs/37879713389)
used the ordinary AppImage launcher and disposable Secret Service. It passed
clean install, local refresh, credential access, Chromium sandbox checks,
checksum-mismatch refusal, replacement of the exact public 0.1.26 predecessor,
automatic restart, settings and opt-out continuity, cold restart and owned cleanup.
The production feed URL was simulated locally with external networking disabled.
The [manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.28/release-manifest.json)
records `cleanInstallSmokePassed: true`; the original receipt retains
`physicalDesktop: not_qualified`. Neither this bounded result nor public feed
readback establishes production-feed installed updating or physical desktop
integration.

## Maintenance rule

Update this declaration from exact release evidence and explicit acceptance.
Do not infer current support from an open pull request, development build,
screenshot or old receipt. A future release needs its own frozen source,
artifacts and qualification.
