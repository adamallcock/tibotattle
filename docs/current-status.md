---
title: Current product and release status
date: 2026-08-27
type: status
status: current
source_commit: 52399658f28303f6af00259f921c2c46a881978f
observation_date: 2026-08-27
---

# Current product and release status

This page is the maintained starting point for “what is current?” It separates
the checked-out source, the public service, published artifacts, and platform
support because those are independent facts. Re-check the named source before
using this page for a later release or operational decision.

## Snapshot identity

| Boundary | Verified state |
|---|---|
| Documentation/source review | `origin/main` commit `52399658f28303f6af00259f921c2c46a881978f`, reviewed 2026-08-27 |
| Public service | Read-only `GET https://tibotattle.com/api/health`, observed 2026-08-27 |
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

### Source-only amendment, 2026-08-30

The [approved self-service deletion retirement](./decisions/2026-08-30-self-service-deletion-retirement.md)
retires `DELETE /api/v1/me` as `404 NOT_FOUND` without D1 access or participant
mutation. It replaces the app control with confirmed **Disconnect this Mac**,
preserving hosted/local history, and retains private owner erasure through
admin maintenance. The source health contract is `participantDeletion: false`
with `deletionSafeRestoreReplay: true`. No migration or retention change is
part of that retirement. This amendment does not refresh or supersede the
2026-08-27 live-service, installed-artifact, release, or updater observations
below; deployment and release remain separate unproven gates.

## Public service

At the observation time, `/api/health` returned `status: ok`, open enrollment,
operational collection controls, healthy D1/deletion-ledger/object-store checks,
and deployment source commit
`826b1b89cf86b436713b42bee2707be85c61b550`. It reported the v1.0 incremental
contribution contract as implementation-ready and externally authorized; the
v0.2 account-scoped contract remained implementation-disabled.

The live Worker commit is behind this document’s reviewed source commit. Do not
describe post-`826b1b89` source changes as deployed until the live health
identity advances and the affected route is checked directly.

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
- Protected R7 receipts are valid only for the exact source and environment
  named in each receipt. A changed workload source makes them historical until
  the protected dual-runtime workflow is deliberately regenerated.
- The public service and release feed are remote state. Their health and
  availability can change after this snapshot.
- Public health is not proof that every admin, identity, contribution, deletion,
  or updater path works end to end.

## How to refresh this page

Update each row from its own source of truth: exact Git commit, read-only public
health response, public appcast bytes, and the GitHub release API. Record the
observation date, preserve any disagreement, and never infer deployment or
platform support from source alone. If the page cannot be refreshed in the same
change as a material claim, narrow or remove the claim instead of carrying it
forward.
