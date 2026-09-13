---
title: Current product and release status
date: 2026-09-13
type: status
status: current
source_commit: 95d85557411b9f6acc470a78f7a8fea5d53d0c3e
observation_date: 2026-09-13
---

# Current product and release status

[TiboTattle 0.1.22](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.22)
is the public Electron release for macOS Apple silicon, macOS Intel, Windows
x64 and Linux x64. Source, published assets, installed behavior, update feeds and hosted service
observations remain separate evidence; recheck the relevant boundary before a
new operational decision.

## Source boundary and reconciliation status

This status records application source revision `95d85557` on 2026-09-13. The
published 0.1.22 artifacts are instead bound to immutable source
`16a0d4dffad4b1213b28adaae139fc9ee6705837`. Current source includes the secure
startup diagnostics and the not-yet-released Codex plugin/agent interface; it
does not retroactively change those artifacts. The plugin requires installed
agent protocol v1 and therefore refuses 0.1.22; its first compatible public
release must be 0.1.23 or later and must pass its own release gates.

The hosted policy and publication tools use separate source boundaries. Do not
deploy the application checkout's Worker or infer a hosted migration from an
application merge.

## Published Electron release

The public release was published at **2026-09-11 17:25:49 UTC**. Refreshed
GitHub metadata confirms 20 assets and neither draft nor prerelease status.
The release is immutable. Its [canonical manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.22/release-manifest.json)
binds the four installers to source
`16a0d4dffad4b1213b28adaae139fc9ee6705837`; its SHA-256 is
`fb042e0d60dca1e468ec7480690cfc5396e5f9408541ee7e500c027fa0d67843`.
The Mac bundle version is `1029`, separate from build provenance `2026091108`.

| Published target | Retained final-artifact evidence | Remaining acceptance boundary |
|---|---|---|
| macOS 14+ Apple silicon | Clean-install smoke, Developer ID signing, hardened runtime, notarization, stapling and Gatekeeper checks passed | Later source and a future plugin-compatible release require their own qualification |
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
These 0.1.21 upgrade receipts do not prove a 0.1.22 upgrade or a Windows/Linux
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
queue remains empty. The 0.1.22 source includes the large-history preparation
and upload-resume corrections. Its release manifest proves the published
artifact boundary; it does not by itself prove a later live contribution canary.

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
