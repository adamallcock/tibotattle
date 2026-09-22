---
title: Current product and release status
date: 2026-09-22
type: status
status: current
source_commit: c93a5a513890be5d4db97de5bcc9a684cbb91f18
observation_date: 2026-09-22
---

# Current product and release status

[TiboTattle 0.1.23](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.23)
is the public Electron release for macOS Apple silicon, macOS Intel, Windows
x64 and Linux x64. Preparation of 0.1.24 is in progress. Source, published
assets, installed behavior, update feeds and hosted service observations remain
separate evidence; recheck the relevant boundary before an operational decision.

## Current release and hosted boundary

This snapshot records source `c93a5a513890be5d4db97de5bcc9a684cbb91f18` on
2026-09-22. Published 0.1.23 artifacts are bound to immutable source
`dd4ca80510ddf0834baa55294ce1b2487cd473b7`. Later Windows Model performance,
refresh recovery and desktop changes do not retroactively change those artifacts.
The 0.1.23 source includes agent protocol v1; installed compatibility still
requires its actual protocol handshake.

The public [Worker health endpoint](https://tibotattle.com/api/health) returned
`ok` with deployment source `c93a5a513890be5d4db97de5bcc9a684cbb91f18` at this
observation. The admin deployment is complete. This observation does not
establish telemetry v1.2 activation or authorize replay of applied migrations.
Required v1.2 work and the Standard/Fast performance correction must be integrated
and qualified before freezing 0.1.24. The independent GCP/PostgreSQL experiment
is outside the desktop release scope.

## Published Electron release

The public release was published at **2026-09-14 16:12:59 UTC** and contains
20 assets. Its [canonical manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.23/release-manifest.json)
binds all four installers to source
`dd4ca80510ddf0834baa55294ce1b2487cd473b7`; its freshly downloaded SHA-256 is
`30c90c7b13fc7e6d15772ae0e9b00438c181b252de4dc84e461e6957e116eda2`.
The Mac bundle version is `1030`, separate from build provenance `2026091401`.

| Published target | Final-artifact evidence recorded by the manifest | Remaining boundary |
|---|---|---|
| macOS 14+ Apple silicon | Clean-install smoke, Developer ID signing, hardened runtime, notarization, stapling and Gatekeeper | Exact installed credential and updater scenarios need their own receipts; source tests do not qualify them |
| macOS 14+ Intel | Separate native trust and clean-install smoke for the Intel artifact | A later source or artifact needs fresh qualification |
| Windows x64 | Authenticode signing, timestamp and clean-install smoke | Model performance is not in the published installer; its successor source qualification is separate |
| Linux x64 AppImage | Exact artifact integrity; `cleanInstallSmokePassed: false`; no native signing scheme | The release-specific acceptance records unperformed physical AppImage launcher, desktop and predecessor-update tests |

All four Electron stable feeds currently advertise 0.1.23 and their downloaded
bytes match the updater metadata digests in that manifest. Both native Sparkle
appcasts advertise 0.1.23 / 1030. Feed readback proves current discovery metadata;
it does not prove a new installed upgrade journey. The manifest explicitly
records null SBOM and provenance fields; do not claim build attestations.

## Hosted contribution and public sample

Local analysis remains independent of hosted availability. Accountless sharing
and source eligibility follow the maintained
[sharing policy](./decisions/2026-09-04-accountless-sharing-policy.md) and
[public-source decision](./decisions/2026-09-11-public-contribution-sources.md).
An installation/provider-account source is not a verified person or globally
unique account. A healthy Worker is not proof of complete public calculations.

Do not replay historical migrations, infer v1.2 readiness from v1.1 source tests,
or substitute a source merge for a production migration or activation receipt.
Use [production operations](./runbooks/production-operations.md) for current
inventory, guarded deployment and recovery.

## Historical native and recovery evidence

[Native 0.1.18](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.18)
remains an immutable predecessor at source
`55c813a1bf7e67c00e47410b760104c0d9fbc0ea`, bundle `1026`. Earlier release
qualification and owner waivers retain their named source and artifact scope;
they do not qualify 0.1.24 or permit unexpected Keychain prompts, data loss or
weakened updater integrity.

## Maintaining this snapshot

Update this authority from verified source, final manifests, live readback and
installed receipts. Keep unavailable evidence explicit. The
[platform authority](./reference/platform-support.md),
[artifact verification guide](./verify-release.md) and
[publication runbook](./runbooks/2026-08-18-cross-platform-release-publication.md)
define the retained support and release boundaries.
