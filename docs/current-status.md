---
title: Current product and release status
date: 2026-09-05
type: status
status: current
source_commit: 14e6a02c131936177cbb0acf1d801d3653658a1b
observation_date: 2026-09-05
---

# Current product and release status

This is the maintained starting point for “what is current?” Source, installed
applications, public downloads, update feeds and hosted service behavior are
independent observations. Re-check their own source of truth for a later
operational decision.

## Source boundaries for this snapshot

The `source_commit` above is the Electron source review base:
`14e6a02c131936177cbb0acf1d801d3653658a1b`. It is the current checkout's
development-source boundary, not the provenance of the published native
release. The native `v0.1.18` tag resolves to the distinct commit
`55c813a1bf7e67c00e47410b760104c0d9fbc0ea`. Those histories diverge at
`3a785e6d2c3421345151a32f07195ddaa6e9a614`; neither source is an ancestor of
the other.

Published-native facts below are carried forward from the 2026-09-05 release
record. This Electron source review did not rerun the native source-to-artifact,
signing, notarization/stapling, Gatekeeper, installed-runtime, update-feed or
public-site checks that produced that record.

## Published native release

[TiboTattle 0.1.18](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.18)
is public and immutable. Both macOS 14+ installers are stable build `1026`,
bound to annotated tag `v0.1.18` at exact source
`55c813a1bf7e67c00e47410b760104c0d9fbc0ea`.
[PR #104](https://github.com/adamallcock/tibotattle/pull/104) merged that source
normally; the release tag and public artifacts must not be rewritten.

| Distribution boundary | Verified on 2026-09-05 release record |
|---|---|
| GitHub release | All seven public assets independently re-downloaded and matched to the canonical manifest and checksums; immutable release and asset attestations verified |
| Apple silicon installer | 49,908,061 bytes; SHA-256 `2ea8eca02df7cc5210b6b6ce3d6e44016bffd9d081544a4efc6fa1afeeb0f1ae` |
| Intel installer | 52,128,441 bytes; SHA-256 `70630ba90e92a1cd8cb904e66e1aebe85b04e9d23a50bef7e4e41aca84c4d2f6` |
| Native trust | Both final artifacts pass their own Developer ID signing, Apple notarization/stapling, Gatekeeper, source/payload and architecture checks |
| Update feeds | [Apple silicon](https://updates.tibotattle.com/appcast.xml) and [Intel](https://updates.tibotattle.com/intel/appcast.xml) both publish 0.1.18 / 1026; independent signed-XML and streamed enclosure checksum checks passed at 19:38 UTC |
| Homebrew | Apple silicon cask updated to 0.1.18 with the exact ARM checksum; [update workflow](https://github.com/adamallcock/homebrew-tap/actions/runs/33973076582) succeeded and the live cask was checked |
| Website | [Both macOS tabs](https://tibotattle.com/#download) show 0.1.18 and their own correct public installer URL, minimum OS and architecture |
| Installed ARM application | Final stable 1026 passes installed-artifact validation, ordinary launch, detailed replay-safe accounting refresh and restart, with matching generation and zero fallback |

Homebrew update verified on **2026-09-07**: the
[dual-architecture cask](https://github.com/adamallcock/homebrew-tap/pull/2)
adds Intel with its independent published checksum. Both native Mac
[audit/install/uninstall lanes](https://github.com/adamallcock/homebrew-tap/actions/runs/34141158444)
passed. This supersedes the Apple-silicon-only Homebrew row in the dated
2026-09-05 release snapshot above; it does not change the desktop artifacts or
claim completion of the waived manual tests.

The manifest honestly leaves optional SBOM, source-to-binary provenance and
store fields unset. GitHub's immutable release/asset attestations are not
substitutes for SLSA build provenance. Follow
[verify-release.md](./verify-release.md) for independent artifact verification.
The private [RC3 signed-candidate](./receipts/2026-09-04-macos-combined-rc3-signed-candidates.md)
and [ARM installed-runtime](./receipts/2026-09-05-macos-rc3-installed-runtime.md)
receipts retain their own point-in-time scope; neither is relabeled as the
published stable artifact.

## Hosted service and accountless boundary

The published 2026-09-05 release record states that approved forward migrations
`0042`–`0045` are applied. Exact migration prefix 45, complete schema and the
preservation reconciliation were verified without deleting telemetry, restoring
production, changing consent or activating v1.1 transport. Applied migration
files must not be rewritten.

[PR #105](https://github.com/adamallcock/tibotattle/pull/105) repaired the
authenticated admin module dependency and atomic weekly revision replacement.
The website deployment is source
`26f372a7b3cb7dbf6885b8a75a0019d47d04c7ad`, whose tree matches that reviewed
repair. Public downloads and the optional hosted analyzer have separate gates.

That published record also retains the database memory-limit incident in quota
endpoint sampling. The website displays history-updating status instead of an
incomplete estimate. Recovery requires successful scheduled rebuilding, a
subsequent valid preview cache and a rendered live graph; health HTTP 200 alone
is not sufficient. This Electron review did not re-observe that hosted state.

The Electron checkout retains accountless source work, including local migration
`0046`, as an un-deployed prototype. It does not alter the deployed `0042`–`0045`
prefix, activate accountless enrollment or contribution, deploy the Worker, or
authorize a further `0047` migration. The [Electron readiness plan](./plans/2026-09-05-electron-release-readiness.md)
is development planning, not hosted or release evidence.

## Platform support and qualification limits

- **Supported:** macOS 14+ Apple silicon and Intel through the published 0.1.18
  artifacts and their independent update feeds.
- **Not released or supported:** Windows, Linux or Electron.
- Homebrew selects Apple silicon or Intel with the same install command; both
  DMGs also remain available through the website and GitHub release.

The owner explicitly accepted the unavailable disposable-profile/manual Login
Item matrix and formal physical Intel install/runtime/update/upload evidence
**for 0.1.18 only**. These observations are waived, not passed. User-reported
tester success is not a retained hardware-bound qualification receipt.
See the [release-specific decision](./decisions/2026-09-05-release-0-1-18-manual-qualification-waiver.md)
and [platform support authority](./reference/platform-support.md).

Data preservation, exact source/artifact binding, native trust, updater
integrity and unexpected automatic Keychain prompts were not waived.
Fresh R7 evidence and both pinned-runtime checks were retained; the existing
open resource decisions are not relabeled as `release_ready`. The supported
paginated-history reset subset is documented in the
[qualification review](./reviews/2026-09-04-paginated-export-qualification.md);
physical-base continuations remain refused.

The Electron development CI and unsigned development packages at the source
review base do not expand any native platform-support claim. Accountless sharing
remains source-only and is not activated in a released Electron or hosted
surface.

## Maintaining this snapshot

Update each boundary from exact source, artifact checks, read-only public
responses, signed feed bytes and actual rendered behavior. Preserve any
disagreement instead of inferring publication from a build, service recovery
from health, or physical qualification from a simulated lane. The
[documentation index](./README.md) names the maintained authorities; dated
plans and receipts retain only the scope they state.
