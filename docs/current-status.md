---
title: Current product and release status
date: 2026-10-09
type: status
status: current
source_commit: bf84bc6c04372bb2cee64ef4a4f29981432fc3eb
observation_date: 2026-10-09
---

# Current product and release status

[TiboTattle 0.1.28](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.28)
is the published shared Electron release for macOS Apple silicon, macOS Intel,
Windows x64 and Linux x64. The installers, all six stable updater feeds,
Homebrew cask and website downloads have been published and verified. Both native
Sparkle production upgrades passed; the two Electron 0.1.26-to-0.1.28 installed
updater checks remain pending. Qualification is platform-specific; the
[platform authority](./reference/platform-support.md) names the limits.

The release includes GPT-6.1 Sol, Ultrafast, Pro 10× and Pro Max 25× support,
explicit auto-review allowance separation, sharing-startup retry and build
dependency remediation. Auto-review classification applies to explicitly
identified usage from October 6, 2026 UTC; token and API-price evidence remain.
The optional Codex dashboard reader is deferred. Version 0.1.27 was tagged and
signed but never published; 0.1.28 carries its client changes forward from the
last public 0.1.26 release. See the [release notes](../release-notes/0.1.28.md).

## Signed release

The immutable GitHub release was published on **2026-10-09 at 12:19:26 UTC**.
Its 20 assets and [canonical release manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.28/release-manifest.json)
were read back and hash-verified; GitHub latest resolves to this release.
The manifest SHA-256 is
`459b89538461b4249dc38e9bbcb5f7c6eb8f49b202856f3cc4f1db8a57650f89`;
all four installers bind to tagged source
`bf84bc6c04372bb2cee64ef4a4f29981432fc3eb`, merged to main in
[PR #281](https://github.com/adamallcock/tibotattle/pull/281).
The Mac bundle version is `1036`, distinct from build number `2026100901`.
The manifest leaves SBOM and provenance fields null.

| Published target | Exact final-artifact evidence | Remaining boundary |
|---|---|---|
| macOS 14+ Apple silicon | Developer ID signed, hardened, notarized, stapled and Gatekeeper-verified DMG; [clean install](https://github.com/adamallcock/tibotattle/actions/runs/37881967388), [credential upgrade](https://github.com/adamallcock/tibotattle/actions/runs/37882400348) and [production Sparkle upgrade](https://github.com/adamallcock/tibotattle/actions/runs/37931481287) passed | Electron 0.1.26 installed updater check is pending; full credential-failure matrix is not qualified |
| macOS 14+ Intel | Separate signed, notarized and stapled DMG; [clean install](https://github.com/adamallcock/tibotattle/actions/runs/37882729563) and [production Sparkle upgrade](https://github.com/adamallcock/tibotattle/actions/runs/37932090365) passed | Electron 0.1.26 installed updater check is pending; existing-credential upgrade was not exercised on Intel; full failure matrix is not qualified |
| Windows x64 | Authenticode signed and timestamped installer; [fresh-VM installer upgrade from 0.1.26](https://github.com/adamallcock/tibotattle/actions/runs/37880387839) passed | Automatic updater was not exercised; this journey does not requalify credential persistence, hosted enrollment or notification delivery |
| Linux x64 AppImage | Exact artifact integrity and [native x64 Xvfb/FUSE lifecycle](https://github.com/adamallcock/tibotattle/actions/runs/37879713389) passed, including clean install and isolated update from 0.1.26 | Physical desktop behavior and production-feed installed updating remain unqualified; no native-signing claim |

The signed Apple silicon existing-Keychain-credential run qualified its
0.1.20-to-0.1.28 modern, invalid and locked fixtures. It preserved credential
items, values and access controls, and verified synthetic historical Sol repair
from parser 18 to 20 without changing tokens or duplicating replayed usage.
This is local installed evidence, not a hosted historical correction result or
the complete credential-failure matrix.

All four stable Electron feeds advertise 0.1.28; their fourteen immutable and
feed objects passed public readback at **12:26:55 UTC**. Both native Sparkle
feeds and their DMGs passed public readback by **12:29:31 UTC**. The native
Sparkle 0.1.18-to-0.1.28 journeys then passed through both production feeds,
including update, relaunch, migration, retained rows, preferences, salt, opt-out
and restart without duplicates. Neither used a feed override or a runner-copied
candidate; these journeys did not include an existing-credential fixture.

The first production Electron 0.1.26-to-0.1.28 attempts on
[Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/37931476122)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/37931485225)
stopped at the predecessor baseline before invoking an updater action. A
deterministic runner fixture mismatch is being repaired. These results leave
that installed qualification pending; they do not establish a released-app
defect. The [Homebrew update](https://github.com/adamallcock/homebrew-tap/actions/runs/37930525017)
passed all four jobs and its exact 0.1.28 cask readback matches the published Mac
DMG hashes. Feed metadata, installed updater runs and cask resolution remain
distinct evidence.

## Hosted and website boundary

The owner-installed 0.1.28 app completed its local refresh and displayed Sol 6.1
and separate auto-review allowance correctly. Ordinary sharing received accepted
upload chunks. These observations do not establish completion of the retained
backlog, full hosted activation, public graph recalculation, or a complete
unknown-to-Sol historical correction transition.

The [public website](https://tibotattle.com/) deployment completed at
**2026-10-09 12:42:44 UTC** from source
`24411d5c318e593bfe4c0f8b2066cb6a9a313002`. Its
[site manifest](https://tibotattle.com/release-site-manifest.json) has SHA-256
`f92d441537ad52365dcf4dbe3e0ea271b331a19f4c50f26de61cecefd2d2c86c`,
independently read back at 12:47:23 UTC. All four download targets resolve to
0.1.28. Desktop and Spanish 390 px rendering were inspected, the Windows selector
was verified, and Open Graph and Twitter use the same crawler-accessible
1200×630 PNG with successful image readback.

The website update changed installer discovery only. The GCP origin remains at
source `dec6d4f3f3f29921eefec3b2d44da525411141d5`, image SHA-256
`1b5ddeebe8fa4bd4adcfefa4c204728619fd0a016a5132411ed279835c2359d3`.
The public graph still reports October 5 and the older Pro 20×-equivalent
reference, with repricing pending. Full historical activation, repricing and
public-reference migration remain separately owned server work. The client
release does not establish deployment of every cross-surface product change.

Local analysis remains independent of hosted availability. Sharing and public
source eligibility follow the maintained
[sharing policy](./decisions/2026-09-04-accountless-sharing-policy.md) and
[public-source decision](./decisions/2026-09-11-public-contribution-sources.md).
An installation or provider-account source is not a verified person. A healthy
service or an accepted upload chunk is not proof of complete public calculations.

## Maintaining this snapshot

Update this authority from exact source, final manifests, installed receipts
and live readback. Do not turn an accepted missing test, an updater feed or a
source merge into a stronger claim. Use the
[platform authority](./reference/platform-support.md),
[artifact verification guide](./verify-release.md) and
[publication runbook](./runbooks/2026-08-18-cross-platform-release-publication.md)
for the continuing boundaries.
