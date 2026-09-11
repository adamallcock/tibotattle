---
title: Current product and release status
date: 2026-09-11
type: status
status: current
source_commit: a651ea130dd1460e4443a037c4434f57b911fec4
observation_date: 2026-09-11
---

# Current product and release status

Electron 0.1.21 is released for macOS Apple silicon, macOS Intel, Windows x64
and Linux x86_64. GitHub, Homebrew, the website, both native Sparkle feeds and
all four Electron feeds are verified. Native 0.1.18 can update through its
normal Check for Updates control; manual backup-folder choreography is no
longer the update path.

This is the maintained status snapshot. Source, signed artifacts, deployed
service, actual installed updates and owner acceptance remain separate claims.
Recheck the relevant live surface before a later operational decision. The
[release closure plan](./plans/2026-09-11-electron-upgrade-release-closure.md)
retains recovery details and failed-run provenance.

## Published release and delivery

[TiboTattle 0.1.21](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.21)
is public and immutable. Application source is
`a651ea130dd1460e4443a037c4434f57b911fec4`, provenance build `2026091107`,
Mac bundle version `1028`. Annotated tag object
`bdeb3770c065e2c4c2901a8ddae909a1c15550b5` points to that source. Later
release-tooling and website commits do not alter these application bytes.

| Boundary | Verified observation on 2026-09-11 |
| --- | --- |
| GitHub | All 20 public assets freshly downloaded and checked against frozen hashes and immutable release/asset attestations |
| macOS trust | Both apps and final DMGs Developer ID signed, notarized and stapled; exact architecture and Gatekeeper checks passed |
| Native update feeds | Apple silicon and Intel each advertise 0.1.21 / 1028 with their own verified signed enclosure |
| Electron update feeds | All four stable feeds and their exact artifacts passed fresh public readback after activation |
| Homebrew | [PR4](https://github.com/adamallcock/homebrew-tap/pull/4) merged after both native architecture audit/install/uninstall jobs passed; main cask and workflow bytes verified |
| Website | [tibotattle.com](https://tibotattle.com/) serves source `9accd6f08a8bc519868f24a970b619e5e0e2a5f0`; all 24 public files match the prepared bytes |
| Website interactions | All four immutable GitHub download links, actual checksum copies, three languages, desktop/mobile, community rendering and social metadata checked |
| Operational closure | Original publication coordinator completed with every surface matching, no further publications attempted and its owner released; website and Electron feed journals are also verified and released |

Manual website downloads use GitHub release URLs. Updater URLs remain on the
update origin because they serve each application's automatic update mechanism.
Only the Mac artifacts claim Apple signing and notarization; Windows uses its
own signing and Linux its declared integrity/distribution evidence.

The manifest leaves optional SBOM and source-to-binary provenance fields null.
GitHub immutable-release attestations do not substitute for SLSA build
provenance. See [release verification](./verify-release.md) for independent
checks. Published 0.1.18 and 0.1.20 artifacts and tags remain unchanged.

## Actual installed Mac update evidence

| Normal production update | Apple silicon | Intel |
| --- | --- | --- |
| Native 0.1.18 to Electron 0.1.21 | [34568465222](https://github.com/adamallcock/tibotattle/actions/runs/34568465222) passed | [34569099253](https://github.com/adamallcock/tibotattle/actions/runs/34569099253) passed |
| Electron 0.1.20 to 0.1.21 | [34568883471](https://github.com/adamallcock/tibotattle/actions/runs/34568883471) passed | [34568884736](https://github.com/adamallcock/tibotattle/actions/runs/34568884736) passed |

Each unchanged signed predecessor used its bundled production feed. The updater
installed and relaunched the exact successor; the runner did not copy it or
override the feed. Retained rows, identity salt, settings, opt-out, duplicate-free
restart and owned-process cleanup passed. These disposable fixtures contained
no existing contribution credential, so they do not claim credential migration.

Separate signed empty-profile installs passed on both Macs before publication,
including automatic-sharing defaults, Settings interaction and persistent
opt-out. These are not additional live upload rehearsals.

## Hosted migration and automatic contribution evidence

The approved production migration and activation completed on **2026-09-10**.
Retained final-contract evidence verifies the canonical `0057`–`0059` transition
and restoration of the retained records. One timed-out batch was
independently reconciled as committed and counted once. Final cleanup reports
zero owned temporary objects, no in-flight step and the coordination lock
released. The earlier failed/restored-prefix attempt remains retained history;
it is not the final outcome and must not be replayed.

The v1.1 staged-to-accepted transition passed exact readback. Accountless
enrollment and ownership activation were deployed at source
`f496494ca317f60d92c73aa7d16b786fdb702cda`, with that deployment verified and
released. The later website source above preserves the enabled production
settings; staging remains disabled. The application qualification checkout is
not itself evidence of the deployed Worker configuration. Do not redeploy a
stale configuration over the activated production settings.

The signed **0.1.19 Apple silicon** production canary completed on
2026-09-10 in [run 34523883586](https://github.com/adamallcock/tibotattle/actions/runs/34523883586).
It verified automatic encrypted upload, installation-credential reuse across
controlled restart, persistent opt-out and usage/quota linkage. The scoped
server proof contained two usage and two quota records, with no bad links or
duplicate groups. Owner erasure removed all scoped records and authority;
revocation, deletion tombstone and separate object cleanup were verified.

| Retained private receipt | SHA-256 |
| --- | --- |
| Final migration phase state | `5cccf9652d773480e7b77cf4090c3d5b7783f5fc86cb1202c2f012d9d4e8b6a4` |
| Restoration audit | `a1d1dfd7986488c71b9a3e988e00cf5510aa034692d3211223ffc87aac79fb81` |
| Final migration/schema/control contract | `822f54aec2905b58ae48e1bf77a9fb52a1842efe809fd1a7b9deddd934cdd3cd` |
| v1.1 acceptance readback | `869d5c2f7f30dab2197461f22b3d2f0f0b65a7f593de78a421424e5c1bdb2a6b` |
| Signed 0.1.19 canary completion and erasure | `e0ec0e6fad72e3e2123c4048bb28ffe4486f4696246734649974cd47bfb681dd` |

Those receipt hashes and their linked evidence were rechecked on 2026-09-11.
No migration or live upload was repeated for this status update. The canary is
one synthetic installation with unchanged-input restart; it does not prove
packet-loss retries, global duplicate suppression, every operating system or a
new 0.1.21 upload. Accountless contributions remain excluded from public
community figures. Public-sample activation is a separate decision.

Fresh Electron installations share automatically under the
[accepted policy](./decisions/2026-09-04-accountless-sharing-policy.md).
Existing undecided users receive three notices; an explicit decision cancels
remaining notices. Opt-out persists and no social sign-in is required.

## Platform support and acceptance limits

- **macOS 14+ Apple silicon and Intel:** released signed/notarized artifacts;
  exact production updater journeys above passed independently. Physical Intel
  acceptance remains owner supplied, separate from hosted Intel execution.
- **Windows x64:** signed, timestamped NSIS installer and feed released.
  [34561980268](https://github.com/adamallcock/tibotattle/actions/runs/34561980268)
  passed installed processing, restart and uninstall for the 0.1.21 candidate.
  Update replacement and notification appearance remain owner acceptance;
  this latest journey did not retest credential persistence.
- **Linux x86_64:** AppImage and feed released.
  [34561981708](https://github.com/adamallcock/tibotattle/actions/runs/34561981708)
  passed 0.1.21 packaging. Earlier packaged startup, credential and restart
  evidence retains its original scope. Physical desktop/update acceptance is
  owner supplied, not a new executed qualification result.

The owner's current acceptance is separate from the historical
[0.1.18-only waiver](./decisions/2026-09-05-release-0-1-18-manual-qualification-waiver.md).
Neither converts missing tests into passes. Data preservation, exact artifact
identity and native trust remain required. The
[platform support authority](./reference/platform-support.md) defines the
continuing evidence requirements.

The live website retains previously reported narrow-screen header clipping and
an optional provider beacon blocked by the existing content security policy.
Download controls and the stated release journeys passed; those small website
follow-ups did not change signed artifacts or justify relaxing the policy.

## Maintaining this snapshot

Use exact source, signed artifacts, retained receipts, fresh public readback and
rendered observations for later updates. Current health alone does not establish
migration preservation, contribution scheduling or physical desktop behavior.
The [documentation index](./README.md) identifies operational authorities;
historical receipts retain the claims and dates they originally recorded.
