---
title: Current product and release status
date: 2026-09-07
type: status
status: current
source_commit: 0207a3c1f728ae6682d4423cf31540f72cc4d19c
observation_date: 2026-09-07
---

# Current product and release status

This is the maintained starting point for “what is current?” Source, installed
applications, public downloads, update feeds and hosted service behavior are
independent observations. Re-check their own source of truth for a later
operational decision.

## Published release

[TiboTattle 0.1.18](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.18)
is public and immutable. Both macOS 14+ installers are stable build `1026`,
bound to annotated tag `v0.1.18` at exact source
`55c813a1bf7e67c00e47410b760104c0d9fbc0ea`.
[PR #104](https://github.com/adamallcock/tibotattle/pull/104) merged that source
normally; the release tag and public artifacts must not be rewritten.

| Distribution boundary | Verified on 2026-09-05 |
|---|---|
| GitHub release | All seven public assets independently re-downloaded and matched to the canonical manifest and checksums; immutable release and asset attestations verified |
| Apple silicon installer | 49,908,061 bytes; SHA-256 `2ea8eca02df7cc5210b6b6ce3d6e44016bffd9d081544a4efc6fa1afeeb0f1ae` |
| Intel installer | 52,128,441 bytes; SHA-256 `70630ba90e92a1cd8cb904e66e1aebe85b04e9d23a50bef7e4e41aca84c4d2f6` |
| Native trust | Both final artifacts pass their own Developer ID signing, Apple notarization/stapling, Gatekeeper, source/payload and architecture checks |
| Update feeds | [Apple silicon](https://updates.tibotattle.com/appcast.xml) and [Intel](https://updates.tibotattle.com/intel/appcast.xml) both publish 0.1.18 / 1026; independent signed-XML and streamed enclosure checksum checks passed at 19:38 UTC |
| Homebrew | Apple silicon cask updated to 0.1.18 with the exact ARM checksum; [update workflow](https://github.com/adamallcock/homebrew-tap/actions/runs/33973076582) succeeded and the live cask was checked |
| Website | [Both macOS tabs](https://tibotattle.com/#download) show 0.1.18 and their own correct public installer URL, minimum OS and architecture |
| Installed ARM application | Final stable 1026 passes installed-artifact validation, ordinary launch, detailed replay-safe accounting refresh and restart, with matching generation and zero fallback |

The manifest honestly leaves optional SBOM, source-to-binary provenance and
store fields unset. GitHub's immutable release/asset attestations are not
substitutes for SLSA build provenance. Follow
[verify-release.md](./verify-release.md) for independent artifact verification.

## Hosted service and current graph incident

All approved forward migrations `0042`–`0045` are applied. Exact migration
prefix 45, complete schema and the preservation reconciliation were verified
without deleting telemetry, restoring production, changing consent or
activating v1.1 transport. Applied migration files must not be rewritten.

[PR #105](https://github.com/adamallcock/tibotattle/pull/105) repaired the
authenticated admin module dependency and atomic weekly revision replacement.
Its merged source `26f372a7b3cb7dbf6885b8a75a0019d47d04c7ad` is the
schema-compatible code rollback target, with both 0.1.18 website downloads.
Public downloads and the optional hosted analyzer have separate gates.

[PR #106](https://github.com/adamallcock/tibotattle/pull/106) deployed quota
sampling source `39e35686480ec0c41a54f29ec42a469a80491fc5`. Its dense synthetic
memory checks passed, but production exposed quadratic work on sparse quota
partitions. Cloudflare reported database CPU exhaustion/reset (7429), and some
public data and health requests returned 503. The earlier memory failure is
not resolved by replacing it with this timeout.

At 15:48 UTC on 2026-09-06, source
`1a14a9efb443914b965a84dd1143b036178b10e0` deployed the narrowly scoped
allowance-reconstruction pause. Normal pre/post health and source checks
passed; the approved emergency health exception was not used. Natural
scheduled runs completed essential maintenance without exceptions, and the
authenticated Operations view recovered. The allowance graph remains a
separate, unfinished recovery gate.

The [restartable calculator replacement](./decisions/2026-09-06-hosted-calculator-recovery.md)
deployed as `91171029fb5a16255502b380677fac27df18a70a`, with exact source
confirmed at 19:00 UTC on 2026-09-06. Approved migrations `0046`–`0047` are
applied and verified; the normal guarded deployment passed with no health
exception. The lookup backfill has completed, and natural scheduled runs are
advancing restartable calculations without exceptions. The authenticated
Operations view loads. The main allowance graph remains unavailable while fresh
caches and historical publications rebuild: this is
verified deployment and progress, not completed graph recovery. See the
[deployment receipt](./receipts/2026-09-06-hosted-calculator-deployment.md).

The two root R7 evidence checks are stale after the shared-library change.
They remain open for future desktop qualification, not a requirement of the
maintained hosted deployment gate. The hosted repair neither reads private
local usage history nor rebuilds the published desktop app.

The requested [all-token detail and API-equivalent spend](./decisions/2026-09-06-community-detail-totals.md)
are deployed. Live Chrome rendering confirms the all-token activity chart and
replacement spend card. At 20:34 UTC on 2026-09-06, one published day had partial
price data (USD 114.9153), while 316 published days still lacked repriced totals;
the displayed partial amount is not the complete historical spend. Recovery preserves pricing and analytical
refusal rules, with no historical telemetry rewrite or statistical-policy change.

The scoped [admin progress and useful-work scheduling change](./plans/2026-09-06-admin-reconstruction-progress.md)
deployed as `daa82a939020cb74ad5054c4ee7e6091019502be`, independently confirmed
healthy at 21:11 UTC on 2026-09-06. The normal guarded deployment required no
migrations or health exception. Live authenticated Chrome shows calculation
phases and publication backlog even while the admin graph preview is unavailable:
13 of 15 tracked account checkpoints acquired, one account preparing, one
scanning, and 266 pending daily rebuilds. Current accounts no longer consume
unfinished-work slots; concurrency, query limits and calculation budgets are
unchanged. This closes progress visibility and useful-work scheduling, not the
separate graph-recovery gate.

The owner-approved [historical model reconstruction](./receipts/2026-09-07-model-allowance-history-deployment.md)
deployed as `0207a3c1f728ae6682d4423cf31540f72cc4d19c` at 00:08:54 UTC on
2026-09-07. Migration `0048` and the complete stored schema passed read-back;
both migration ledgers have no pending source migrations. The normal guarded
deployment and independent exact-source health checks passed, preserving source
telemetry, consent and transport activation. This supersedes the older source
observations above, not their point-in-time qualification boundaries.

Live authenticated Chrome renders the per-model chart and its retrospective
history explanation, including Astra's existing September 6 point. At the first
observation, no earlier historical points had been produced: low-priority
history selected September 5 but deferred behind current-day calculation. A
later scheduled run was canceled without a recorded exception. Its ordinary
maintenance lease expired and natural schedules resumed successfully; the
00:38 UTC read confirmed no held lease and 11 complete current-account heads,
with four still acquiring. No lease override was used. Historical checkpoint,
day-publication and rendered-series verification remain open.
The public all-token activity chart renders 317 days and labels USD 101,954.04
as the priced portion across 262 of them; the separate public allowance graph
still reports that merged history is updating.

The existing dated social preview was temporarily retained to prioritize the
verified 0.1.18 download rollout. Regenerate it from the recovered live estimate;
do not describe that retained image as a new release preview.

The admin per-model view supports the reviewed model catalog, including Astra
and older model families. Its live preview is available at the observation
above; that does not establish completed historical backfill. Contribution
consent and staged v1.1 activation remain
unchanged. The source health contract retains `participantDeletion: false`
and `deletionSafeRestoreReplay: true`; these flags do not prove every route.

## Platform support and qualification limits

- **Supported:** macOS 14+ Apple silicon and Intel through the published 0.1.18
  artifacts and their independent update feeds.
- **Not released or supported:** Windows, Linux or Electron.
- Homebrew support remains Apple silicon only; the Intel DMG is distributed
  directly through the website and GitHub release.

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

Private RC1, RC2 and RC3 candidates, the first pre-repair stable attempt, and
compatible application/state recovery pairs remain preserved historical
evidence. They are not the published stable bytes. Do not downgrade upgraded
state by replacing only its application with an older writer.

## Maintaining this snapshot

Update each boundary from exact source, artifact checks, read-only public
responses, signed feed bytes and actual rendered behavior. Preserve any
disagreement instead of inferring publication from a build, service recovery
from health, or physical qualification from a simulated lane. The
[documentation index](./README.md) and
[release execution plan](./plans/2026-09-05-public-0-1-18-release.md) retain the
implementation and historical qualification context.
