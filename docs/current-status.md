---
title: Current product and release status
date: 2026-09-11
type: status
status: current
source_commit: 03d4217fe4d42d9d342b6ad34b73905c025b9ead
observation_date: 2026-09-11
---

# Current product and release status

This is the maintained starting point for “what is current?” Source, installed
applications, public downloads, update feeds and hosted service behavior are
independent observations. Re-check their own source of truth for a later
operational decision.

## Current release and hosted boundary

[Electron 0.1.21](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.21)
is the public stable release. On 2026-09-11 its GitHub release was verified as
neither draft nor prerelease, with 20 assets covering macOS Apple silicon,
macOS Intel, Windows x64 and Linux x64, including native Mac transition feeds.
This hosted-policy change does not rebuild or republish those installers.

Live production health on 2026-09-11 returned `ok` at source `03d4217f`;
the public daily API returned HTTP 200. Accountless enrollment and ownership
are enabled in that deployed source. The completed `0057`–`0059` migration
must not be repeated. The earlier synthetic staging-only
accountless `0046`–`0048` lineage remains retained evidence and requires a
separately approved replacement target. It must not be replayed, renamed in a
remote ledger, or treated as current.

The owner approved accountless inclusion in the current public community sample
on 2026-09-11. The [shared-source decision](./decisions/2026-09-11-public-contribution-sources.md)
tracks implementation and activation. Migration `0060` is applied and its 43
new/replaced objects were verified against exact local and remote SQL forms.
The guarded Worker/site deployment completed, both deployment and maintenance
ownership were released, and ordinary scheduled maintenance resumed. Collection
remains operational at revision 3. Current public figures now admit eligible
accountless v1.1 sources under the same existing analytical rules.

The policy change invalidated derived publications. Scheduled rebuilding has
prepared all 15 source members and published the first 48 daily rows; 271
retained days remained queued at that observation. Recent graphs still need
their corresponding days rebuilt. A real accountless source has not yet
appeared in the public figures. Local HTTP lifecycle tests prove
enrollment, accepted upload, replay, publication, renewal, withdrawal and erasure.
The service suite passed 1,026 tests; the populated migration rehearsal preserved
1,000 synthetic source chains and 100,000 records in each telemetry table.

An installed 0.1.21 diagnostic then found a separate desktop preparation defect:
history above one million quota observations hits a fixed acquisition limit
and retries without reaching upload. Enrollment and the versioned upload
authorization were valid. A bounded streaming reader repair is being integrated
with the requested Projects, model-performance and progress-layout changes in
a separate checkout based on the released 0.1.21 source. That app repair still
requires combined qualification, packaging and installed upload proof.

The earlier native facts below are carried forward from the 2026-09-05 release
record. This hosted-policy change did not rerun native source-to-artifact,
signing, notarization, Gatekeeper or installed-runtime qualification. Public
release/feed identity, generated assets, rendered privacy content and live
hosted health were checked separately for this deployment.

## Earlier native release (historical)

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

## Dated hosted evidence

The [thousand-contributor publication receipt](./receipts/2026-09-08-thousand-contributor-publication.md)
records a guarded deployment and rendered public/admin checks on 2026-09-08,
including the canonical `0054`–`0056` migration boundary. It is retained
point-in-time evidence, not a new observation made by this reconciliation.

The [incremental refresh publication receipt](./receipts/2026-09-08-incremental-refresh-publication.md)
records the earlier 2026-09-08 deployment and its `0050`–`0053` migration
boundary. The retained receipts describe that point in time; cache state,
backfill progress, and rendered behavior require a new live check.

## Retained hosted recovery boundary

The published 2026-09-05 release record states that approved forward migrations
`0042`–`0045` are applied. Exact migration prefix 45, complete schema and the
preservation reconciliation were verified without deleting telemetry, restoring
production, changing consent or activating v1.1 transport. Applied migration
files must not be rewritten.

[PR #105](https://github.com/adamallcock/tibotattle/pull/105) repaired the
authenticated admin module dependency and atomic weekly revision replacement.
Its merged source `26f372a7b3cb7dbf6885b8a75a0019d47d04c7ad` is the
then-schema-compatible code rollback target, with both 0.1.18 website downloads.
It is not a rollback target for the subsequently upgraded prepared-work protocol;
current recovery requires the compatibility checks in the operations runbook.
Public downloads and the optional hosted analyzer have separate gates.

Earlier recovery records, including [PR #106](https://github.com/adamallcock/tibotattle/pull/106),
remain dated evidence. They do not substitute for current public cache,
rendered-view, or scheduler verification.

Detailed recovery history remains in its dated receipts and decisions. It is
not current hosted evidence and does not authorize accountless activation,
remote migration, or a desktop release.

## Platform support and qualification limits

- **Supported:** macOS 14+ Apple silicon and Intel through the published 0.1.18
  artifacts and their independent update feeds.
- **Not released or supported:** Windows, Linux or Electron.
- The live first-party Homebrew cask was rechecked on 2026-09-08: version 0.1.18
  selects Apple silicon or Intel with each release's exact checksum. Both use
  `brew install --cask adamallcock/tap/tibotattle`.
  Both DMGs also remain available through the website and GitHub release.

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
