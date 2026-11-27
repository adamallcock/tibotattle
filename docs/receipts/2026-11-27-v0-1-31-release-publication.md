---
title: TiboTattle 0.1.31 release publication receipt
date: 2026-11-27
type: receipt
status: verified
---

# TiboTattle 0.1.31 release publication receipt

This November 27, 2026 UTC snapshot records the four published installers,
stable updater feeds, Homebrew cask and website. The installed lifecycle records name
the tested hardware, predecessor and scope.
[Platform qualification](../reference/platform-support.md#0131-artifact-qualification)

## Immutable GitHub release

GitHub release `460079722` was published at **02:10:14 UTC**. Independent
readback at **02:10:54 UTC** confirmed that it was immutable and GitHub Latest
resolved to `v0.1.31`. The annotated tag object
`8646614ca9de67c9102a92a58b6cb25349b823ff` resolves to application source
`a8a650092ca371db9df54279b86c34b947636909`. Release source PR #325 merged at
`8e5ce77f6802b069cfefde46d80c8be73d5e0678` with the same Git tree.

GitHub release and per-asset attestation verification matched all 20 prepared
subjects. The manifest SHA-256 was
`b3cbec0c09dcb1920022f801dfb27d5d0b24f163489666433f844a983a6ee402`.
The per-installer source/build provenance and SBOM fields are null.
[Published release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.31) ·
[Manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.31/release-manifest.json) ·
[All-file checksums](https://github.com/adamallcock/tibotattle/releases/download/v0.1.31/SHA256SUMS-ALL-RELEASE-FILES)

Version 0.1.31 includes durable recovery for interrupted incremental history
refreshes, contributed by nexus382 in PR #323. PR #324 carries the previous
release's bounded public spend reader and signed catalog coverage into
main. The installed application and production analytics origin have
separate release records. [Recovery change](https://github.com/adamallcock/tibotattle/pull/323) ·
[Hosted source reconciliation](https://github.com/adamallcock/tibotattle/pull/324) ·
[Release source review](https://github.com/adamallcock/tibotattle/pull/325)

## Release qualification

The frozen source used packaging build `2026112701` and macOS bundle version
`1039`. The macOS-hosted root suite passed 6,329 tests with 47 skips. All 410
companion tests, 196 synthetic admission tests and 88 release trust tests
passed. Documentation, repository preflight and architecture checks passed.
The 31-day local history and synthetic R7 workloads regenerated ten validated
receipts across Node 24.14.0 and 26.2.0. The release decisions retain the same
19 unresolved export-resource bounds. [Node 24 release decision](../../generated/r7-release-decision-node24.14.0-v0.1.json) ·
[Node 26 release decision](../../generated/r7-release-decision-node26.2.0-v0.1.json)

Nine original prepublication platform archives matched the exact release
admission. The two Mac installers passed Developer ID signing, hardened
runtime, notarization, stapling and Gatekeeper checks. A separate synthetic
companion test ran digest-verified JavaScript from each signed Mac ASAR
under Node 26.2.0 on Apple silicon. After cancellation and companion restart,
each retry reused a saved group and produced the same usage facts as the
uninterrupted control. The installed Mac GUI and updater journeys are
documented independently. [Installed platform evidence and limits](../reference/platform-support.md#0131-artifact-qualification)

## Stable updater feeds

At **02:17:51 UTC**, public readback bound the four Electron metadata
files and their ten referenced objects to the exact released bytes and
verified their delivery headers. Both native Sparkle appcasts were
independently read back at **02:22 UTC**. The official XML responses matched
the frozen signed release assets. Appcast and DMG signatures verified for
Mac bundle version `1039`.

| Stable feed | Observed SHA-256 | Verified payload scope |
| --- | --- | --- |
| [Electron macOS Apple silicon](https://updates.tibotattle.com/electron/stable/darwin-arm64/latest-mac.yml) | `9e52bbe59f43495a9498f6dcfe0141a173b9dcbf06118f5070f1ee7277a878d0` | 4 exact download objects |
| [Electron macOS Intel](https://updates.tibotattle.com/electron/stable/darwin-x64/latest-mac.yml) | `1cc5d7ab3629e050c73849c3a8c08fd34da2222964ba838917168dfe839d489a` | 4 exact download objects |
| [Electron Windows x64](https://updates.tibotattle.com/electron/stable/win32-x64/latest.yml) | `4b837b912c5fe6558453adfad1cc1609ef75d88298e8f83aa82bca2dc28d7c85` | 1 exact download object |
| [Electron Linux x86_64](https://updates.tibotattle.com/electron/stable/linux-x64/latest-linux.yml) | `550fea55da41c3dc26c44d02a69e1ef7bb4f01512a8e69460c8f511ef13ffed8` | 1 exact download object |
| [Native Sparkle Apple silicon](https://updates.tibotattle.com/appcast.xml) | `1d21a046eb41ecf047ff34926123e3328426037f03f528db4f9804fdacd3c97c` | Signed DMG enclosure and exact released bytes |
| [Native Sparkle Intel](https://updates.tibotattle.com/intel/appcast.xml) | `ebf4bdae381f538bff55b90129e34eb32bfc3197b1887614b9faded52c593ea1` | Signed DMG enclosure and exact released bytes |

## Installed Mac updates

Production native Sparkle upgrades from 0.1.18 passed on both architectures.
Production Electron upgrades from 0.1.30 also passed. The Electron runs
indexed new synthetic activity through the normal dashboard refresh after
cold restart. A repeat refresh kept the generation and added no duplicates.
Both upgrade paths exercised the published feeds.
[Native Sparkle on Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/45927919205) ·
[Native Sparkle on Intel](https://github.com/adamallcock/tibotattle/actions/runs/45927985823) ·
[Electron on Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/45927636861) ·
[Electron on Intel](https://github.com/adamallcock/tibotattle/actions/runs/45927662967)

## Homebrew

The [tap workflow](https://github.com/adamallcock/homebrew-tap/actions/runs/45926966311)
verified the exact installers and passed cask audit, install and uninstall
natively on Apple silicon and Intel. Readback at **02:17:09 UTC** matched
[tap commit `1ef9d9a0c03b1661281f94ef2abe454ce7381acc`](https://github.com/adamallcock/homebrew-tap/blob/1ef9d9a0c03b1661281f94ef2abe454ce7381acc/Casks/tibotattle.rb),
cask blob `a4fe9f556b76fb1699655baf1df739e4afe2ef2c` and SHA-256
`aacaaa06feb735e256726b37b518a05f836b87d802fa7b5b1a117ab93c52dc1a`.
Both cask DMG hashes matched the published Mac installers.

## Website downloads

The typed website deployment used reviewed source
`91b819f5c3dc514d7a11f02b9b3d37e5eeca2af9`. Independent ingress readback at
**02:25:39 UTC** confirmed that edge version
`86cd8c41-76e9-4e1d-946c-a11a93c3428f` served 100% of traffic. It matched the
live release site manifest SHA-256
`68dd26217ccc832a4dabbc120dcfc3ab4ae3ec773f17e0acb9fd6a4feee59fbb`.
The website release receipt SHA-256 was
`6ca5fbd53f18c8f72c9afb37d0f53da3410056d6e4e5d466a66253975a126516`.
The typed deployment journal was verified and its lock released.
[Website source review](https://github.com/adamallcock/tibotattle/pull/326) ·
[Public site manifest](https://tibotattle.com/release-site-manifest.json)

Independent public readback at **02:26:10 UTC** matched all 38 generated
files and the byte lengths and SHA-256 digests of all four installer downloads.
Production Chrome checks at 1280 px and 390 px verified all four platform
tabs and the versioned verification guide. Cache-busted Twitterbot checks
verified the Open Graph and Twitter card metadata, the 1200×630 PNG and MIME
type, and crawler access. The `www` redirect returned HTTP 308.
[Public website](https://tibotattle.com/) ·
[Versioned verification guide](https://github.com/adamallcock/tibotattle/blob/v0.1.31/docs/verify-release.md)

Production routing and the configuration fingerprint were preserved. The
retained GCP origin responded healthy at source
`ba6398bbc4b1e1af7211cfd624e8219ff351034c`.
[Public health](https://tibotattle.com/api/health)
