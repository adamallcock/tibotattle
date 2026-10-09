---
title: Platform support and qualification
date: 2026-10-09
type: reference
status: maintained
---

# Platform support and qualification

The released Electron application is **0.1.28** across macOS Apple silicon,
macOS Intel, Windows x64 and Linux x64. See [current status](../current-status.md)
for the source, updater, Homebrew and hosted boundaries, and the
[public release manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.28/release-manifest.json)
for exact artifact hashes and recorded assurances.

## Status matrix

| Platform | Current distribution | Proven final-artifact boundary | Acceptance limits |
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

Both Mac installers use bundle version `1036` and build number
`2026100901`. The signed [Apple silicon clean-install](https://github.com/adamallcock/tibotattle/actions/runs/37881967388)
and [Intel clean-install](https://github.com/adamallcock/tibotattle/actions/runs/37882729563)
runs passed. The native Sparkle 0.1.18-to-0.1.28 upgrade passed through the
production feeds on [Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/37931481287)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/37932090365).
These journeys exercised the updater, relaunch and migration; preserved rows,
preferences, salt and opt-out; and passed restart without duplicates while
leaving the native source untouched and stopping owned processes. Neither used
a feed override, a runner-copied candidate or an existing-credential fixture.

All four Electron stable feeds and both native Sparkle feeds advertise 0.1.28
with exact public readback. Production Electron 0.1.26-to-0.1.28 updates passed
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
passed all four jobs. The exact cask readback resolves 0.1.28 with the published
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
