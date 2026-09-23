---
title: Current product and release status
date: 2026-09-23
type: status
status: current
source_commit: 7446d8515f9533c7b1a8fa40c9b059baba995de3
observation_date: 2026-09-23
---

# Current product and release status

[TiboTattle 0.1.24](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.24)
is the public Electron release for macOS Apple silicon, macOS Intel, Windows
x64 and Linux x64. Source, published assets, installed behavior, update feeds
and hosted service observations remain separate evidence; recheck the relevant
boundary before an operational decision.

## Current release and hosted boundary

This snapshot records the published 0.1.24 source
`b6fe68e4912bebbe6dcf7dc9fd43e877451dd133` on 2026-09-23. The release includes
Windows Model performance, GPT-6 Sol/Luna pricing and desktop refresh recovery.
It includes agent protocol v1; installed compatibility still requires its actual
protocol handshake.

The production Worker was verified at the release source after the typed-storage
migration, then at web-only descendant
`7446d8515f9533c7b1a8fa40c9b059baba995de3` after website publication at
**2026-09-23 10:33:58 UTC**. That descendant changes public documentation without
changing the Worker runtime implementation. Collection controls are operational
at revision 9, with enrollment,
upload registration, processing and publication enabled. Usage telemetry v1.2
is active at runtime revision 2. Performance telemetry remains staged at revision
1; local Model performance availability does not activate hosted performance
collection. These are separately verified cutover and activation observations,
not deductions from the [health endpoint](https://tibotattle.com/api/health).
The independent GCP/PostgreSQL experiment is outside this release scope.

## Published Electron release

The immutable public release was published at **2026-09-23 10:01:35 UTC** and
contains 20 assets. Its [canonical manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.24/release-manifest.json)
binds all four installers to source
`b6fe68e4912bebbe6dcf7dc9fd43e877451dd133`; its verified SHA-256 is
`639fa80d299b051639cda67a9318da93966b7d26d470e542fd43ca1cc6ebc205`.
The Mac bundle version is `1032`, separate from build provenance `2026092202`.

The 0.1.24 native Sparkle-to-Electron upgrade journeys passed for
[Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/35794596134)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/35794598511).
Those exact transition cases do not qualify the unperformed existing-credential
scenarios below.

| Published target | Final-artifact evidence recorded by the manifest | Remaining boundary |
|---|---|---|
| macOS 14+ Apple silicon | Clean-install smoke, Developer ID signing, hardened runtime, notarization, stapling and Gatekeeper | Existing-credential cases remain unperformed and owner-accepted for 0.1.24; clean-install evidence does not qualify them |
| macOS 14+ Intel | Separate native trust and clean-install smoke for the Intel artifact | Existing-credential cases remain unperformed and owner-accepted; platform-specific installed journeys retain their exact scope |
| Windows x64 | Authenticode signing, timestamp and clean-install smoke | The installer includes Model performance; existing-credential, update and desktop behavior require their own evidence |
| Linux x64 AppImage | Exact artifact integrity; `cleanInstallSmokePassed: false`; no native signing scheme | Physical FUSE/AppImage and existing-install coverage remains unperformed and owner-accepted for 0.1.24 |

All four Electron stable feeds advertise 0.1.24, with verified public readback
of all 14 publication objects. Both native Sparkle transition feeds advertise
0.1.24 / 1032, with exact public DMG and manifest bytes verified. Feed readback
proves discovery metadata; it does not prove an installed upgrade journey. The
manifest records null SBOM and provenance fields; do not claim build attestations.

The [Homebrew publication workflow](https://github.com/adamallcock/homebrew-tap/actions/runs/35847887431)
passed native Apple silicon and Intel installer trust, audit, install and
uninstall checks. The current cask was verified at tap commit
`5a2d8df766911a1791c36d836a72a0c6f2c1c5c4` against the exact release installers.
The [public website](https://tibotattle.com/) was also published and verified at
the web-only source above; its public-site manifest SHA-256 is
`afd4341b0688579bf2d4763792c22581626cb0a8039b2ee8f508a479e5864bbc`.
That site manifest is separate from the installer release manifest.

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
