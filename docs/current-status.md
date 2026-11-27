---
title: Current product and release status
date: 2026-11-27
type: status
status: current
source_commit: 44aa65f1eb4799e8bd5302180a8757c4eb149d95
observation_date: 2026-11-27
---

# Current product and release status

TiboTattle 0.1.30 was published on November 21, 2026 at **20:44:46 UTC** for
macOS Apple silicon, macOS Intel, Windows x64 and Linux x86_64. It was the latest
GitHub release at readback.
[Published release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.30) ·
[Release notes](../release-notes/0.1.30.md) ·
[Platform qualification](./reference/platform-support.md#status-matrix)

## 0.1.31 source candidate

The candidate includes durable recovery after interrupted incremental local
history refreshes. When saved inputs still match, **Update local usage** resumes
saved work. The dashboard continues to show the last completed history until
the refresh succeeds. [Candidate notes](../release-notes/0.1.31.md) ·
[Recovery guidance](./runbooks/unified-index-recovery.md) ·
[Merged change](https://github.com/adamallcock/tibotattle/pull/323)

The candidate is allocated packaging build `2026112701` and macOS bundle
version `1039`. Final artifacts, installed upgrades, and publication await
qualification for 0.1.31. [Platform qualification](./reference/platform-support.md)

## 0.1.30 release record

The immutable GitHub release binds all four installers to application source
`0bb1fa31932a56adeb54d8abbb17118d2e1d434f` and packaging build `2026112101`.
Public verification matched all 20 assets. The release manifest has SHA-256
`55e976ef04b8193530d6a33580b16ae0cf1f35ac12bb643054dfbbe9965d6cfe`.
[Versioned release manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.30/release-manifest.json)

All four stable Electron feeds and both native Sparkle feeds passed public
readback at **20:57:35 UTC**, including the exact downloadable objects. Both
Mac architectures passed production native Sparkle upgrades from 0.1.18 and
production Electron updates from 0.1.29.
[Publication and six feed readbacks](./receipts/2026-11-21-v0-1-30-release-publication.md) ·
[Installed Mac updater runs](./reference/platform-support.md#0130-artifact-qualification)

The Homebrew cask readback matched both published Mac DMG hashes. Native
cask audit, install and uninstall passed on both architectures.
[Homebrew workflow](https://github.com/adamallcock/homebrew-tap/actions/runs/44948865676) ·
[Verified cask revision](https://github.com/adamallcock/homebrew-tap/blob/6e490e8129ff2ec396d329f0eccdd864a45f50c2/Casks/tibotattle.rb)

The public website deployed from `523621293197eedf931e3495df9c80d9eef75209`.
Readback at **21:05:55 UTC** verified the live manifest, the 38 generated site
files and all four 0.1.30 installer links. Desktop, 360 px mobile and Spanish
rendering were checked. The release left the sampled public spend rows
unchanged, with the published-data refresh deferred.
[Website](https://tibotattle.com/) ·
[Website deployment review](https://github.com/adamallcock/tibotattle/pull/319) ·
[Website readback](./receipts/2026-11-21-v0-1-30-release-publication.md#website-downloads)

## October 9 release record for 0.1.28

[TiboTattle 0.1.28](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.28)
was published for macOS Apple silicon, macOS Intel, Windows x64 and Linux x64.
The installers, all six stable updater feeds,
Homebrew cask and website downloads were published and verified that day. Both native
Sparkle production upgrades passed. Electron 0.1.26-to-0.1.28 production
updates also passed on both Mac architectures with discoverable Codex logs.
Qualification is platform-specific; the
[platform authority](./reference/platform-support.md) names the limits.

The release includes GPT-6.1 Sol, Ultrafast, Pro 10× and Pro Max 25× support,
explicit auto-review allowance separation, sharing-startup retry and build
dependency remediation. Auto-review classification applies to explicitly
identified usage from October 6, 2026 UTC; token and API-price evidence remain.
The optional Codex dashboard reader is deferred. Version 0.1.27 was tagged and
signed but never published; 0.1.28 carries its client changes forward from the
last public 0.1.26 release. See the [release notes](../release-notes/0.1.28.md).

### Signed release

The immutable GitHub release was published on **2026-10-09 at 12:19:26 UTC**.
Its 20 assets and [canonical release manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.28/release-manifest.json)
were read back and hash-verified. GitHub latest resolved to 0.1.28 on October 9.
The manifest SHA-256 is
`459b89538461b4249dc38e9bbcb5f7c6eb8f49b202856f3cc4f1db8a57650f89`;
all four installers bind to tagged source
`bf84bc6c04372bb2cee64ef4a4f29981432fc3eb`, merged to main in
[PR #281](https://github.com/adamallcock/tibotattle/pull/281).
The Mac bundle version is `1036`, distinct from build number `2026100901`.
The manifest leaves SBOM and provenance fields null.

| Published target | Exact final-artifact evidence | Remaining boundary |
|---|---|---|
| macOS 14+ Apple silicon | Developer ID signed, hardened, notarized, stapled and Gatekeeper-verified DMG; [clean install](https://github.com/adamallcock/tibotattle/actions/runs/37881967388), [credential upgrade](https://github.com/adamallcock/tibotattle/actions/runs/37882400348) and [production Sparkle upgrade](https://github.com/adamallcock/tibotattle/actions/runs/37931481287) passed; [production Electron upgrade with discoverable Codex logs](https://github.com/adamallcock/tibotattle/actions/runs/37942774119) passed | See the retained-history limitation below; full credential-failure matrix is not qualified |
| macOS 14+ Intel | Separate signed, notarized and stapled DMG; [clean install](https://github.com/adamallcock/tibotattle/actions/runs/37882729563) and [production Sparkle upgrade](https://github.com/adamallcock/tibotattle/actions/runs/37932090365) passed; [production Electron upgrade with discoverable Codex logs](https://github.com/adamallcock/tibotattle/actions/runs/37949180932) passed | See the retained-history limitation below; existing-credential upgrade was not exercised on Intel; full failure matrix is not qualified |
| Windows x64 | Authenticode signed and timestamped installer; [fresh-VM installer upgrade from 0.1.26](https://github.com/adamallcock/tibotattle/actions/runs/37880387839) passed | Automatic updater was not exercised; this journey does not requalify credential persistence, hosted enrollment or notification delivery |
| Linux x64 AppImage | Exact artifact integrity and [native x64 Xvfb/FUSE lifecycle](https://github.com/adamallcock/tibotattle/actions/runs/37879713389) passed, including clean install and isolated update from 0.1.26 | Physical desktop behavior and production-feed installed updating remain unqualified; no native-signing claim |

The signed Apple silicon existing-Keychain-credential run qualified its
0.1.20-to-0.1.28 modern, invalid and locked fixtures. It preserved credential
items, values and access controls, and verified synthetic historical Sol repair
from parser 18 to 20 without changing tokens or duplicating replayed usage.
This is local installed evidence, not a hosted historical correction result or
the complete credential-failure matrix.

All four stable Electron feeds advertised 0.1.28 on October 9. Their fourteen immutable and feed objects passed public readback at **12:26:55 UTC**. Both native Sparkle
feeds and their DMGs passed public readback by **12:29:31 UTC**. The native
Sparkle 0.1.18-to-0.1.28 journeys then passed through both production feeds,
including update, relaunch, migration, retained rows, preferences, salt, opt-out
and restart without duplicates. Neither used a feed override or a runner-copied
candidate; these journeys did not include an existing-credential fixture.

The production Electron 0.1.26-to-0.1.28 updates passed on
[Apple silicon](https://github.com/adamallcock/tibotattle/actions/runs/37942774119)
and [Intel](https://github.com/adamallcock/tibotattle/actions/runs/37949180932),
using authentic predecessor fixtures with discoverable Codex logs. Both
installed and relaunched the exact released app automatically, observed the
predecessor exit naturally, preserved rows, preferences, salt and opt-out, and
passed restart without duplicates and cleanup. Neither used a feed override,
a runner-copied candidate or an existing-credential fixture.

The [earlier failed attempts](./reference/platform-support.md#macos) remain
separate evidence. Baseline and process-observation failures left continuity
unqualified; other runs timed out after installation and relaunch. The earlier
R2 failures' exact cause remains unproven. Those failed receipts do not establish
data loss.

Source review of released 0.1.28 identifies a separate retained-history
limitation. When a 0.1.26 format-11 index remains but no Codex rollout files
survive, ordinary Refresh, startup refresh and automatic cadence do not start
its migration. The current reader rejects that old index, leaving its unified
history projection unavailable; cached summaries may remain. This is not proof
of deleted rows. The passed journeys with discoverable logs do not resolve
this case.

The [Homebrew update](https://github.com/adamallcock/homebrew-tap/actions/runs/37930525017)
passed all four jobs. The exact 0.1.28 cask readback matched the published Mac
DMG hashes. Feed metadata, installed updater runs and cask resolution remain
distinct evidence.

### Hosted and website observations on October 9

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

The website update changed installer discovery only. The verified GCP origin was at
source `dec6d4f3f3f29921eefec3b2d44da525411141d5`, image SHA-256
`1b5ddeebe8fa4bd4adcfefa4c204728619fd0a016a5132411ed279835c2359d3`.
The public readback showed October 5 and the older Pro 20×-equivalent
reference, with repricing pending at that observation. Full historical activation, repricing and
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
