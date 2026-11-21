---
title: TiboTattle 0.1.30 release publication receipt
date: 2026-11-21
type: receipt
status: verified
---

# TiboTattle 0.1.30 release publication receipt

This November 21, 2026 snapshot records publication of the four installers,
six updater feeds, Homebrew cask and website. See the installed lifecycle
qualification and its limits in the [platform reference](../reference/platform-support.md#status-matrix).

## Immutable GitHub release

GitHub release `453968762` was published at **20:44:46 UTC**. Readback confirmed
that GitHub latest resolved to `v0.1.30`. The annotated tag object
`c05d736a9e5122eb8f5a9a8b424e38434b7c96be` resolves to application source
`0bb1fa31932a56adeb54d8abbb17118d2e1d434f`. The public release verification matched
all 20 assets against the prepared, checksummed bytes and verified GitHub's
release and asset attestations. The manifest SHA-256 was
`55e976ef04b8193530d6a33580b16ae0cf1f35ac12bb643054dfbbe9965d6cfe`.
[Published release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.30) ·
[Manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.30/release-manifest.json) ·
[All-file checksums](https://github.com/adamallcock/tibotattle/releases/download/v0.1.30/SHA256SUMS-ALL-RELEASE-FILES)

## Stable updater feeds

Readback at **20:57:35 UTC** verified all six feeds advertised 0.1.30.
Electron metadata and download hashes matched the released assets. Both
Sparkle appcast and DMG signatures verified for Mac bundle version `1038`.
The timestamp and digests pin the observed bytes for these mutable endpoints.

| Stable feed | Observed SHA-256 | Verified payload scope |
| --- | --- | --- |
| [Electron macOS Apple silicon](https://updates.tibotattle.com/electron/stable/darwin-arm64/latest-mac.yml) | `5340faced6300145c21057bc3c51691528ac922b3ccc39abef320b214efa3f14` | 4 exact download objects |
| [Electron macOS Intel](https://updates.tibotattle.com/electron/stable/darwin-x64/latest-mac.yml) | `ef770d3d79ff5fcb495914f936a6d60dd14ebebbddb8a171e229c8bad326447c` | 4 exact download objects |
| [Electron Windows x64](https://updates.tibotattle.com/electron/stable/win32-x64/latest.yml) | `9e7324ef3f46e46e2312252dc001277bf33c75f1527429f37027051caffc9329` | 1 exact download object |
| [Electron Linux x86_64](https://updates.tibotattle.com/electron/stable/linux-x64/latest-linux.yml) | `612925f135fd0605575f5e1d41d98a519b89ede0b8d93031136477ef0f00d616` | 1 exact download object |
| [Native Sparkle Apple silicon](https://updates.tibotattle.com/appcast.xml) | `b2e7fc7f980a01c5d7ea1531685b11391644cf6ec7fdc87438504ce28f7e5d58` | Signed DMG enclosure and exact released bytes |
| [Native Sparkle Intel](https://updates.tibotattle.com/intel/appcast.xml) | `e75bc9d2260d3415b3d1bb2b761a317551b3bbf204f56638855f0911a77df42c` | Signed DMG enclosure and exact released bytes |

## Homebrew

The [tap workflow](https://github.com/adamallcock/homebrew-tap/actions/runs/44948865676)
passed all four jobs, including native audit, install and uninstall on Apple
silicon and Intel. Readback of `main` at **21:04:18 UTC** matched
[the pinned cask revision](https://github.com/adamallcock/homebrew-tap/blob/6e490e8129ff2ec396d329f0eccdd864a45f50c2/Casks/tibotattle.rb).
The 0.1.30 cask SHA-256 was
`b9c944a5d3f84e87a53421800f2ea33cc9444e98a47dc860aa91f6673081524e`.
The cask's two DMG hashes matched the published Mac installers.

## Website downloads

The typed production deployment of website source
`523621293197eedf931e3495df9c80d9eef75209` verified with no pending migrations.
Its deployment receipt SHA-256 was
`1efdf0b883ad3faf5735d76f2c35693eca66e1bfba7fcff807f66df5b1f1b27d`.
[Website deployment review](https://github.com/adamallcock/tibotattle/pull/319)

Independent public readback at **21:05:55 UTC** matched the manifest and all
38 generated files. The manifest SHA-256 was
`164e90ce3ebc1333ef8041b3a7cc7b39d4d91df67a152b9d8f6a3228e8028557`.
All four installer URLs returned HTTP 200 and their release-manifest byte
lengths. Desktop, 360 px mobile and Spanish rendering were checked. The
1200×630 share PNG and crawler access also passed.
[Public website](https://tibotattle.com/) ·
[Public site manifest](https://tibotattle.com/release-site-manifest.json)

Public health served GCP origin source
`8fb6caeca3c29f8de9d6617d0fde544a861f6f8d`. Seven sampled previously published
API-equivalent spend rows matched their earlier values. The homepage allowance
chart continued to show its published Pro 20×-equivalent basis. The data
refresh was deferred. [Public health](https://tibotattle.com/api/health)
