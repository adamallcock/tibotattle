---
title: Current product and release status
date: 2026-09-02
type: status
status: current
source_commit: 35802d21ede67d362533f4e2be6b38041ece1cda
observation_date: 2026-09-02
---

# Current product and release status

This page is the maintained starting point for “what is current?” It separates
the checked-out source, the public service, published artifacts, and platform
support because those are independent facts. Re-check the named source before
using this page for a later release or operational decision.

## Snapshot identity

| Boundary | Verified state |
|---|---|
| Documentation/source review | Base `35802d21ede67d362533f4e2be6b38041ece1cda`, reviewed 2026-09-02; local RC9 corrections and build `1023.7` allocation are under validation, not frozen or artifact-qualified |
| Installed internal dogfood | App metadata observed 2026-09-02: version `0.1.17`, RC8 build `1023.6`. This read-only plist observation does not requalify its signature, source, or runtime. RC9 has not replaced it |
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
- Integrated RC5 source `ff506dc3`, build `1023.3`, was signed, notarized and
  installed on 2026-08-31. Its state-preserving replacement and first launch
  passed, but its real full-accounting refresh did not: a healthy v0.14 rebuild
  was terminated by the ordinary five-minute deadline. That evidence remains
  specific to RC5.
- RC6 source `e59115d41958f6b23496a65c9732a6a9944fdde0`, build `1023.4`,
  subsequently passed its source gates, protected R7, Developer ID signing,
  notarization, stapling, Gatekeeper, state-preserving replacement, and installed
  launch without an observed Keychain prompt. Its real refresh ran past five
  minutes and reached terminal success, proving the deadline correction. The
  installed result then exposed an inherited `recent_7d_indexing` legacy
  checkpoint suppressing otherwise-authoritative unified accounting. RC6 is
  therefore not the final dogfood handoff.
- RC7 source merge `87e07be350582713d815a21b4db470ed84aae037`, build
  `1023.5`, removed only that retired collector checkpoint and subsequently
  passed protected R7, the full source gate, Developer ID signing, notarization,
  stapling, Gatekeeper, state-preserving replacement, and installation. Its
  first installed refresh ingested unified-index generation 44, then correctly
  withheld advanced accounting when the strict v0.14 cache validator found
  inconsistent fit metadata. The fit correctly excluded an early
  diagnostic-only transition, but the projection copied that rejected row's
  eligibility onto the reset fitted from later eligible transitions.
- RC8 source retains the strict validator and projects reset fit metadata from
  the first eligible row. Its prior allocation was `1023.6`; the reviewed source
  base for this update is `35802d21ede67d362533f4e2be6b38041ece1cda`.
- RC9 reserves monotonic build `1023.7`, strictly after RC8 and before stable
  `1024`. Its source is under validation: ordinary refresh and startup collect
  quick quota/headline evidence; explicit detailed recalculation remains
  separate; automatic detailed attempts are at most hourly and count failed or
  interrupted requests. Native polling uses controller mode/start receipts and
  terminal-state fencing, so browser-started work shares the cadence and stale
  pre-start replies cannot settle a new request. Trends pairs the selected
  plan's fit with its source-bound usage, preserves established speed evidence
  with the reviewed Standard fallback, and keeps all-plan accounting separate.
  Authoritative dashboard snapshots use the current production shape so they
  can be retained across relaunch. These are source changes, not evidence of a
  built, installed, or passing RC9. Fresh exact-source R7, the complete source
  gate, signed/notarized/stapled artifact, state-preserving replacement,
  installed refresh, and physical native checks remain required.
- The RC7 R7 workload-source closure has protected dual-runtime receipts for
  359 files / workload SHA-256
  `ea504fde37402622239d5405aa74c264b98a111c8da5b4031a0977fa5bd80741`.
  Both decisions remain honestly `release_open`. Native UI and build-allocation
  files remain subject to their separate macOS source, smoke, signed-artifact,
  and installed-artifact gates.
- The public service and release feed are remote state. Their health and
  availability can change after this snapshot.
- Public health is not proof that every admin, identity, contribution, deletion,
  or updater path works end to end.
- PR #94's fixed-real-corpus before/after coverage, diagnostic-distribution, and
  resource comparator remains **OPEN / NOT RUN**. Current APIs cannot emit the
  complete named fit-rejection reconciliation, so R7 cannot be used as a
  substitute. An explicitly open-gate internal dogfood may proceed for testing,
  but this blocks stable and public 0.1.17 qualification until it is closed or
  deliberately resolved. The exact RC9 native artifact must separately pass
  signing, notarization, state-preserving installation, updater, and physical
  native checks. Pairing continuity needs compatible hosted Worker migrations
  and deployment before the repaired desktop flow can be validated end to end.
- An owner-only fixed-window attempt on 2026-08-31 failed closed before comparison:
  the strict pre-PR scan reported `codex_rollout_content_invalid`. The supported
  resource benchmark independently stopped at `benchmark_cold_rebuild_incomplete`
  on both exact PR #94 revisions. No empirical comparison receipt was produced,
  no source was excluded, and this does not constitute a run of the formal
  comparator. Its **OPEN / NOT RUN** state remains a stable/public gate.

## How to refresh this page

Update each row from its own source of truth: exact Git commit, read-only public
health response, public appcast bytes, and the GitHub release API. Record the
observation date, preserve any disagreement, and never infer deployment or
platform support from source alone. If the page cannot be refreshed in the same
change as a material claim, narrow or remove the claim instead of carrying it
forward.
