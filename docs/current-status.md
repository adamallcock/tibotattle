---
title: Current product and release status
date: 2026-08-31
type: status
status: current
source_commit: 3b0f2d23775c0ca1f092fe3eb48f0c3166c8461a
observation_date: 2026-08-31
---

# Current product and release status

This page is the maintained starting point for “what is current?” It separates
the checked-out source, the public service, published artifacts, and platform
support because those are independent facts. Re-check the named source before
using this page for a later release or operational decision.

## Snapshot identity

| Boundary | Verified state |
|---|---|
| Documentation/source review | Release-preparation base `origin/main` commit `3b0f2d23775c0ca1f092fe3eb48f0c3166c8461a`, reviewed 2026-08-31; final source freeze is pending |
| Installed internal dogfood | Signed and notarized RC4 source `735a59ce2ec01df0e381fb1aa878c5c7a39edcd8`, build `1023.2`, installed 2026-08-31; excludes PR #94 and is not current main or stable |
| Public service | Read-only `GET https://tibotattle.com/api/health`, HTTP 200, deployment source `304f3d736b6f9451d32a616bf3046ea628e828a3`, observed 2026-08-31 |
| Public updater | Read-only `GET https://updates.tibotattle.com/appcast.xml`, observed 2026-08-27 |
| Published release | GitHub release API for `adamallcock/tibotattle`, observed 2026-08-27 |

This is a snapshot, not an automatic monitor. A newer commit, deployment, feed,
or release makes the corresponding row stale without changing the other rows.

## Source tree

The reviewed source implements a local-first macOS product, a loopback local
analysis service, the public website and optional hosted contribution service,
and release tooling. The maintained architecture, interface, privacy, schema,
and command contracts are indexed in [the documentation index](./README.md).

The source tree at the reviewed commit is ahead of the live Worker reported
below. Source merge therefore does not prove public deployment.

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

At the observation time, `/api/health` returned HTTP 200 and deployment source
commit `304f3d736b6f9451d32a616bf3046ea628e828a3`. That deployment predates PR
#94's device-continuity protocol. It can treat replay of one pairing identifier
idempotently, but does not establish the fresh-pairing recovery protocol needed
for an already registered local device.

The live Worker commit is behind this document's reviewed source commit. Do not
describe PR #89 or PR #94 Worker behavior as deployed until the live health
identity advances and the affected migration and route are checked directly.
Read-only production migration-ledger inspection was unavailable to the current
operator credentials, so remote migration state remains unknown rather than
assumed current.

## Published macOS release and updater

The latest public GitHub release was immutable stable release `v0.1.16`,
published 2026-08-21. It includes the Apple-silicon DMG, appcast, release
manifest, checksums, and verification guide. The public appcast returned HTTP
200 and advertised the same `0.1.16` arm64 DMG with macOS 14.0 as the minimum.

These observations prove public availability of the named release endpoints.
They do not re-run code signing, notarization, Gatekeeper, clean-install, or
update-install qualification. Use [verify-release.md](./verify-release.md) for
artifact verification and the retained release receipts for their exact
point-in-time evidence only.

## Platform support

- **Supported:** macOS 14 or later on Apple silicon, through the published
  `v0.1.16` stable artifact described above.
- **Not supported:** Windows and Linux. Source, contract, or simulated lanes do
  not establish an installed, signed, updateable product on those platforms.
The complete qualification matrix and rules for changing these claims are in
[platform-support.md](./reference/platform-support.md).

## Known boundaries

- The checked-out source contains unreleased changes after `v0.1.16`; the
  [changelog](../CHANGELOG.md) records them without claiming they shipped.
- The installed RC4 proves only frozen source `735a59ce`, build `1023.2`. It
  excludes PR #94. The integrated RC5 allocation is `1023.3`, but no signed,
  notarized, or installed RC5 artifact is established by this snapshot.
- The current RC5 R7 workload-source closure has fresh protected dual-runtime
  receipts for 359 files / workload SHA-256
  `4c3058b3453bda2696e946952d18e81310f26eb0187074d410c730e44162f1d6`.
  Both decisions remain honestly `release_open`; a later workload change would
  make these receipts historical again. Native UI and build-allocation files are
  outside that R7 closure and require their separate macOS source, smoke,
  signed-artifact, and installed-artifact gates.
- The public service and release feed are remote state. Their health and
  availability can change after this snapshot.
- Public health is not proof that every admin, identity, contribution, deletion,
  or updater path works end to end.
- Before RC5 dogfood sign-off or 0.1.17 stable qualification, PR #94 still needs
  the fixed real-corpus before/after coverage, diagnostic-distribution, and
  resource review. Current APIs cannot emit the complete named fit-rejection
  reconciliation, so that gate remains open rather than inferred green. The
  exact integrated native artifact must also pass signing, notarization,
  state-preserving installation, updater, and physical native checks. Pairing
  continuity needs compatible hosted Worker migrations/deployment before the
  repaired desktop flow can be validated end to end.
- An owner-only fixed-window attempt on 2026-08-31 failed closed before comparison:
  the strict pre-PR scan reported `codex_rollout_content_invalid`. The supported
  resource benchmark independently stopped at `benchmark_cold_rebuild_incomplete`
  on both exact PR #94 revisions. No empirical comparison receipt was produced,
  no source was excluded, and this remains an open RC5/stable gate.

## How to refresh this page

Update each row from its own source of truth: exact Git commit, read-only public
health response, public appcast bytes, and the GitHub release API. Record the
observation date, preserve any disagreement, and never infer deployment or
platform support from source alone. If the page cannot be refreshed in the same
change as a material claim, narrow or remove the claim instead of carrying it
forward.
