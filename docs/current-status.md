---
title: Current product and release status
date: 2026-09-11
type: status
status: current
source_commit: c892542fb094669a4054d96a63321205811f22fc
observation_date: 2026-09-11
---

# Current product and release status

[TiboTattle 0.1.21](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.21)
is the public Electron release for macOS Apple silicon, macOS Intel, Windows
x64 and Linux x64. The combined 0.1.22 application is a pending candidate.
Source, published assets, installed behavior, update feeds and hosted service
observations remain separate evidence; recheck the relevant boundary before a
new operational decision.

## Source boundary and reconciliation status

This status records application source ancestor `c892542f` on 2026-09-11.
[PR #121](https://github.com/adamallcock/tibotattle/pull/121) integrates the
bounded contribution-history reader, upload-resume repair, Projects,
model-performance and progress-layout changes on the released 0.1.21 base.
The [0.1.22 integration plan](./plans/2026-09-11-electron-022-integration.md)
tracks remaining resource qualification, source freeze, signed artifacts,
actual contribution canary and publication. Baseline tests or earlier R7
receipts do not qualify the later correction. No 0.1.22 publication is claimed.

The hosted policy and publication tools use separate source boundaries. Do not
deploy the application checkout's Worker or infer a hosted migration from an
application merge.

## Published Electron release

The public release was published at **2026-09-11 05:40:14 UTC**. Refreshed
GitHub metadata confirms 20 assets and neither draft nor prerelease status.
Its [canonical manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.21/release-manifest.json)
binds the four installers to source
`a651ea130dd1460e4443a037c4434f57b911fec4`; its SHA-256 is
`b824befc95560c27e3a254527ebdb8b0f1d572dd9c20c6941bc14c62074869e1`.
The Mac bundle version is `1028`, separate from build provenance `2026091107`.

| Published target | Retained final-artifact evidence | Remaining acceptance boundary |
|---|---|---|
| macOS 14+ Apple silicon | Clean-install smoke, Developer ID signing, hardened runtime, notarization, stapling and Gatekeeper checks passed | New 0.1.22 bytes require their own qualification |
| macOS 14+ Intel | The same final trust and clean-install checks passed for the distinct Intel artifact | Owner accepted the remaining physical/manual Intel observations; that is not a new passed test |
| Windows x64 | Authenticode signing, timestamp and clean-install smoke passed for the published installer | Physical desktop notification/update acceptance remains owner-accepted; the signed normal journey did not requalify credential persistence or hosted enrollment |
| Linux x64 AppImage | Final artifact integrity verified; the manifest explicitly records `cleanInstallSmokePassed: false` and no native signing scheme | Released with explicit owner acceptance of remaining physical desktop/lifecycle observations; package evidence does not turn them into passed tests |

All four manifest entries bind their own Electron updater metadata. Actual
production Mac upgrade journeys passed for native 0.1.18 to Electron 0.1.21 on
[Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/34568465222)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/34569099253),
and for Electron 0.1.20 to 0.1.21 on
[Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/34568883471)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/34568884736).
These receipts do not prove an unexecuted 0.1.22 upgrade or a Windows/Linux
notification appearance. See the [platform authority](./reference/platform-support.md)
and [artifact verification guide](./verify-release.md).

## Hosted contribution and public sample

The separately deployed Worker/site source is `03d4217f`, as recorded by the
2026-09-11 hosted verification. Accountless enrollment and ownership are enabled.
The completed `0057`–`0059` production migration must not be repeated.
[PR #120](https://github.com/adamallcock/tibotattle/pull/120) records the separate
public-source policy and `0060` activation; its branch includes the hosted
policy decision and retained verification that are absent from this app branch.

Eligible accountless v1.1 sources now enter the shared public sample under the
existing suppression, replay, withdrawal and erasure rules. A source represents
an installation/provider-account track, not a verified person or a globally
unique account. Eligibility does not imply that an accountless source has
already appeared in published figures.

The recorded rebuild prepared 15 source members and published 319 daily rows,
with no retained days left in its rebuild queue; the September 5–11 public API
returned ready results. Those are dated observations, not a promise that the
queue remains empty. The large-history preparation defect found in an installed
0.1.21 app and its later upload-resume issue are desktop corrections in the
pending 0.1.22 candidate. Source tests and a healthy hosted service do not
substitute for its final signed-app contribution canary.

## Historical native and recovery evidence

[Native 0.1.18](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.18)
remains an immutable predecessor at source `55c813a1bf7e67c00e47410b760104c0d9fbc0ea`,
bundle `1026`. Its [signed RC3 candidates](./receipts/2026-09-04-macos-combined-rc3-signed-candidates.md),
[installed ARM receipt](./receipts/2026-09-05-macos-rc3-installed-runtime.md)
and [release-specific manual waiver](./decisions/2026-09-05-release-0-1-18-manual-qualification-waiver.md)
retain their historical scope; they are not the current Electron artifacts.
The [September 8 hosted publication receipt](./receipts/2026-09-08-thousand-contributor-publication.md)
similarly records an earlier migration boundary, not current activation.
Applied migrations and retained evidence must not be rewritten or replayed.

## Maintaining this snapshot

The [documentation index](./README.md) identifies maintained authorities.
Preserve exact source/artifact bindings, retained local data, durable opt-outs,
credential protections and update integrity. Owner acceptance of named manual
observations does not waive those engineering requirements or expand support
to other operating systems or architectures.
