---
title: Current product and release status
date: 2026-09-27
type: status
status: current
source_commit: 1114fff4843b81e08637f22ed79bcfda605319a8
observation_date: 2026-09-27
---

# Current product and release status

[TiboTattle 0.1.26](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.26)
is the published Electron release for macOS Apple silicon, macOS Intel, Windows
x64 and Linux x64. The installers, updater feeds, Homebrew cask and public
website have been published. Their qualification remains platform-specific;
the [platform authority](./reference/platform-support.md) names the limits.

## Signed release

The immutable GitHub release was published on **2026-09-27 at 21:02:49 UTC**.
Its 20 assets and [canonical release manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.26/release-manifest.json)
were read back and hash-verified. The manifest SHA-256 is
`be65a83f8c1f060b7c5cf6141b6332c02df730dc1a2aac696442e4e433c123cc`;
all four installers bind to tagged source
`acfc385c95b49b8e1040cedfa857659b49a61d8d`, merged to main in
[PR #238](https://github.com/adamallcock/tibotattle/pull/238).
The Mac bundle version is `1034`, distinct from build number `2026092701`.
The manifest leaves SBOM and provenance fields null.

| Published target | Exact final-artifact evidence | Remaining boundary |
|---|---|---|
| macOS 14+ Apple silicon | Developer ID signed, hardened, notarized, stapled and Gatekeeper-verified DMG; [clean install](https://github.com/adamallcock/tibotattle/actions/runs/36349376027) and [production Sparkle upgrade](https://github.com/adamallcock/tibotattle/actions/runs/36350924405) passed | Full credential-failure matrix is not qualified |
| macOS 14+ Intel | Separate signed, notarized and stapled DMG; [clean install](https://github.com/adamallcock/tibotattle/actions/runs/36349377398) and [production Sparkle upgrade](https://github.com/adamallcock/tibotattle/actions/runs/36350929763) passed | Existing-credential upgrade was not exercised on Intel; full failure matrix is not qualified |
| Windows x64 | Authenticode signed and timestamped installer; [hosted signed installed journey](https://github.com/adamallcock/tibotattle/actions/runs/36347063769) passed | Existing-install upgrade and every physical desktop integration are not qualified |
| Linux x64 AppImage | Exact published hash and [hosted extracted-app runtime](https://github.com/adamallcock/tibotattle/actions/runs/36347037857) passed | Physical desktop launch, AppImage/FUSE mounting and replacement were not tested; owner accepted publication with `cleanInstallSmokePassed: false` |

The signed Apple silicon existing-Keychain-credential upgrades passed from both
[0.1.24](https://github.com/adamallcock/tibotattle/actions/runs/36349405714)
and [0.1.20](https://github.com/adamallcock/tibotattle/actions/runs/36349407322),
including modern, invalid and locked cases in those runs. These receipts close
the earlier 0.1.25 credential-continuity gap for their named scenarios, not the
entire failure matrix. The separate production Electron updater also replaced
0.1.20 with 0.1.26 on
[Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/36351718654)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/36351723582),
preserving rows, settings, salt and opt-out through relaunch and restart.

All four stable Electron feeds and both native Sparkle feeds advertise 0.1.26
with exact public readback. The
[first-party Homebrew update](https://github.com/adamallcock/homebrew-tap/actions/runs/36351745490)
passed; its 0.1.26 cask hashes match the published Mac DMGs. Feed metadata,
installed updater runs and cask resolution are distinct evidence.

## Hosted and website boundary

The [public website](https://tibotattle.com/) serves the 0.1.26 four-platform
download page. Its [site manifest](https://tibotattle.com/release-site-manifest.json)
has SHA-256
`cb9b987f845963502031cafe9d97afae39e8f9b0ab9b4229e9ffcccba5bba549`.
Cache-busted public readback matched the generated homepage, docs, privacy,
share card, robots and sitemap; the share image is PNG at 1200×630. The rendered
page exposed each published installer and live community aggregates.

The production Worker health endpoint names web-only source
`19f2459754a4a5393d3ba0804e7b293dbe7924c8`, a descendant of the
previous deployed source `1fc2fe174daea7a728c638149c36eaccc78832a5`.
The guarded typed-storage website deploy preserved the live bindings and
qualified all three database roles. The 0.1.26 tag's separate analytics
migration `0027_admin_metrics_history_publications.sql` and its associated
Worker runtime changes are **not deployed**; they remain a separate reviewed
migration and deployment operation. Website publication does not prove hosted
runtime or schema activation.

Local analysis remains independent of hosted availability. Sharing and public
source eligibility follow the maintained
[sharing policy](./decisions/2026-09-04-accountless-sharing-policy.md) and
[public-source decision](./decisions/2026-09-11-public-contribution-sources.md).
An installation or provider-account source is not a verified person. A healthy
Worker is not proof of complete public calculations. The independent
GCP/PostgreSQL experiment is outside this release scope.

## Maintaining this snapshot

Update this authority from exact source, final manifests, installed receipts
and live readback. Do not turn an accepted missing test, an updater feed or a
source merge into a stronger claim. Use the
[platform authority](./reference/platform-support.md),
[artifact verification guide](./verify-release.md) and
[publication runbook](./runbooks/2026-08-18-cross-platform-release-publication.md)
for the continuing boundaries.
