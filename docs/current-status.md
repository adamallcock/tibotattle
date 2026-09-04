---
title: Current product and release status
date: 2026-09-04
type: status
status: current
source_commit: e0f35518d8e85fa35d40af54871f3013b13673fe
observation_date: 2026-09-04
---

# Current product and release status

This page is the maintained starting point for “what is current?” It separates
the checked-out source, the public service, published artifacts, and platform
support because those are independent facts. Re-check the named source before
using this page for a later release or operational decision.

## Snapshot identity

| Boundary | Verified state |
|---|---|
| Documentation/source review | Combined Astra/Intel candidate `0.1.18`, source `e0f35518d8e85fa35d40af54871f3013b13673fe`, based on requested `9e1c3333`; [RC2 build proof](./reviews/2026-09-04-release-0-1-18-rc2-build-proof.md) records allocation `1025.1`, optimized ARM/Intel development builds and twelve isolated smoke passes. Fresh R7 generation is blocked by paginated export checkpoints. No production-signed combined artifact or stable tag |
| Intel tester artifact | Inherited signed/notarized `0.1.18` build `1025` dogfood DMG from source `18c7065b`; [exact receipt](./receipts/2026-09-03-macos-intel-signed-candidate.md). Predates combined Astra changes; not physically Intel-qualified |
| Installed internal dogfood | Version `0.1.17`, RC9 build `1023.7`, source `394c8a03`; owner accepted the inspected apps on 2026-09-03. Plist version/build/minimum-OS were independently rechecked; this does not qualify every historical credential or clean-profile case |
| Public service | Health/readiness HTTP 200, enrollment and upload processing enabled; deployment source `b4c8f103bf697fb530434e6de196f2c187645661`, observed 2026-09-04 03:57 UTC (2026-09-03 locally) |
| Public updater | Stable `0.1.16`; read-only feed check recorded 2026-09-03 in the release plan |
| Published release | Immutable GitHub `v0.1.17`, published 2026-09-03 at 19:47:43 UTC; ARM DMG, appcast, manifest, checksums and verification guide; exact source tag commit `aa660b24a66196155ba59267ab832cc4ef6e1c7d` |

This is a snapshot, not an automatic monitor. A newer commit, deployment, feed,
or release makes the corresponding row stale without changing the other rows.

## Source tree

The reviewed source implements a local-first macOS product, a loopback local
analysis service, the public website and optional hosted contribution service,
and release tooling. The maintained architecture, interface, privacy, schema,
and command contracts are indexed in [the documentation index](./README.md).

The source snapshot and live Worker identity below are separate observations.
Source merge does not prove public deployment.

### Source-only amendments through 2026-08-31

The [approved self-service deletion retirement](./decisions/2026-08-30-self-service-deletion-retirement.md)
retires `DELETE /api/v1/me` as `404 NOT_FOUND` without D1 access or participant
mutation. It replaces the app control with confirmed **Disconnect this Mac**,
preserving hosted/local history, and retains private owner erasure through
admin maintenance. The source health contract is `participantDeletion: false`
with `deletionSafeRestoreReplay: true`. No migration or retention change is
part of that retirement. This amendment does not refresh or supersede the
independent live-service, installed-artifact, release, or updater observations
below; deployment and release remain separate gates.

[PR #89](https://github.com/adamallcock/tibotattle/pull/89) adds a hosted
admin-only per-model allowance series and **By model** view. Migration 0041,
Worker deployment, warming, and real cohort evidence remain separate; desktop
installation does not activate it.

[PR #94](https://github.com/adamallcock/tibotattle/pull/94) adds local plan-era
attribution plus a staged telemetry v1.1 transport and device-continuity repair.
Local estimates, history, ranges, forecasts, and share cards use one compatible
selected population; missing or conflicting identity remains unavailable.
Migrations 0042-0044, stronger-format hosted activation, and new explicit
consent are not supplied by installing the desktop app.

[PR #95](https://github.com/adamallcock/tibotattle/pull/95) makes compatible
Keychain migration bounded and non-interactive, with an explained approval
fallback available only through a deliberate Settings action. Automatic
security prompts are release-blocking.

[PR #96](https://github.com/adamallcock/tibotattle/pull/96) makes native startup
use the bounded primary projection and recover from readiness that arrives after
the initial wait without retaining a stale timeout page. These entries describe
merged source at the release-preparation base; they are not installed-artifact,
hosted-deployment, updater, or stable-release evidence.

## Public service

The earlier 2026-08-31 `/api/health` observation returned HTTP 200 and source
commit `304f3d736b6f9451d32a616bf3046ea628e828a3`. That deployment predates PR
#94's device-continuity protocol. It can treat replay of one pairing identifier
idempotently, but does not establish the fresh-pairing recovery protocol needed
for an already registered local device.

The Intel handoff recheck returned health/readiness HTTP 200, open enrollment,
enabled v1.0 uploads and deployment source
`b4c8f103bf697fb530434e6de196f2c187645661`. This supersedes the older identity
observation, but does not independently qualify PR #89/94 migrations, device
repair or optional v1.1 grants. Those routes and migrations require their own
evidence; no migration-ledger inspection or live account upload was performed.

## Published macOS release and updater

GitHub's release API confirmed immutable stable release `v0.1.17`, published
2026-09-03 at 19:47:43 UTC. Its exact source tag commit is
`aa660b24a66196155ba59267ab832cc4ef6e1c7d`; its five assets are the Apple silicon
DMG, appcast, release manifest, checksums and verification guide.

The earlier public appcast observation advertised `0.1.16`. A fresh read during
Intel implementation returned HTTP 403, as did the public health endpoint, so
this document does not claim current feed or service state from that attempt.
GitHub publication alone does not prove updater or website deployment.

These observations prove public availability of the named release endpoints.
They do not re-run code signing, notarization, Gatekeeper, clean-install, or
update-install qualification. Use [verify-release.md](./verify-release.md) for
artifact verification and the retained release receipts for their exact
point-in-time evidence only.

## Platform support

- **Supported:** macOS 14 or later on Apple silicon, through the published
  `v0.1.17` stable artifact described above.
- **Not supported:** Intel macOS, Windows and Linux. Source, contract, or simulated lanes do
  not establish an installed, signed, updateable product on those platforms.
The complete qualification matrix and rules for changing these claims are in
[platform-support.md](./reference/platform-support.md).

## Release qualification and known boundaries

- The [Intel implementation plan](./plans/2026-09-03-macos-intel-release.md)
  records separate thin builds, architecture-specific update/publication
  contracts and manifest-driven website availability. Native/Rosetta and Worker
  checks passed on that Intel branch. Its owner-authorized R7 regeneration refreshed all ten receipts;
  both pinned-runtime freshness checks pass. The final root run has 3,738 passes,
  zero failures and 17 existing conditional skips. The
  [Intel dogfood candidate](./receipts/2026-09-03-macos-intel-signed-candidate.md)
  passes signing/notarization and local artifact checks for source `18c7065b`.
  The combined Astra/Intel workload invalidates those inherited R7 receipts.
  The owner-authorized [RC2 proof](./reviews/2026-09-04-release-0-1-18-rc2-build-proof.md)
  passed optimized builds and isolated smokes on both architectures, but the
  fresh R7 attempt refused paginated Codex history in resumable export source
  planning. All ten previous receipts remain byte-identical and stale. RC2
  allocation is now `1025.1`, stable remains `1026`, and a newly signed combined
  candidate remains outstanding. Physical Intel,
  actual consented upload and installed update qualification remain separate
  gates. No public Intel release, feed or website was published.

- The [public-release plan](./plans/2026-09-03-public-0.1.17-release.md)
  tracks final build `1024`, exact signed-artifact and prior-stable replacement
  checks, immutable GitHub publication, Sparkle, and Homebrew independently.
  Source preparation and a dated changelog are not publication evidence.
- The accepted RC9 runtime has one manual Refresh for quota and detailed
  accounting, quick startup/automatic checks, at-most-hourly automatic detailed
  attempts, selected-plan Trends, retained authoritative snapshots, and the
  measured accounting optimization. The
  [performance receipt](./receipts/2026-09-03-optimized-rc9-accounting-comparison.md)
  measures the accounting child, not end-to-end refresh latency.
- PR #94's local qualification passed with the historical artifact refusal
  explicitly recorded; the final candidate passes its strict cache validator. The
  [local qualification receipt](./receipts/2026-09-03-pr94-account-plan-attribution-qualification.md)
  binds the exact before, after, and final revisions to one immutable admitted
  index. Its scope is accounting, attribution, calibration, and isolated-child
  resources; it does not prove raw ingestion, account-exact identity, hosted
  activation, or installed native lifecycle behavior.
- The earlier 2026-08-31 raw-source attempt failed closed at
  `codex_rollout_content_invalid` / `benchmark_cold_rebuild_incomplete` and
  produced no comparison receipt. Later admitted-index qualification does not
  relabel that attempt as passed or establish repair of its raw sources.
- Retained dual-runtime R7 receipts were regenerated on the earlier Intel tree,
  but fail freshness on the combined source snapshot above. The latest protected
  [R7 attempt](./reviews/2026-09-04-release-0-1-18-rc2-build-proof.md)
  completed six runtime profiles, then stopped at
  `export_source_codex_rollout_checkpoint_history_unsupported`. The current
  selected corpus genuinely declares paginated history; resumable export
  support needs a design and implementation decision before another
  complete [R7 run](./runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md).
  Do not narrow the corpus or bypass the guard to obtain a receipt. Earlier
  decisions remain
  `release_open` with unresolved export resource ceilings; that expected state
  is not a generic macOS release blocker. Receipt freshness is a separate gate,
  and neither inherited files nor new synthetic tests establish fresh evidence.
- Following the owner's 2026-09-03 confidence-based release direction, the full
  clean-profile/physical Login Item matrix is deferred for 0.1.17, not passed.
  The release still stops for data loss, invalid signatures or updater bytes,
  and unexpected Keychain prompts. Isolated-profile and fake-manager smokes
  do not establish the deferred manual evidence.
- Hosted migrations/deployment, plan-transport consent activation, and repaired
  device pairing remain separate. Website validator backport/deployment is
  separately held; publishing the desktop must not deploy current-main Worker
  code or mutate hosted data.
- Remote health and availability can change after this snapshot. Public health
  is not proof of every admin, identity, contribution, deletion, or updater path.

## How to refresh this page

Update each row from its own source of truth: exact Git commit, read-only public
health response, public appcast bytes, and the GitHub release API. Record the
observation date, preserve any disagreement, and never infer deployment or
platform support from source alone. If the page cannot be refreshed in the same
change as a material claim, narrow or remove the claim instead of carrying it
forward.
