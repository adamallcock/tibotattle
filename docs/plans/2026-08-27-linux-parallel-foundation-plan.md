---
title: Linux parallel foundation implementation plan
date: 2026-08-27
type: plan
status: foundation-complete-r7-evidence-blocked
base_revision: 49fc02766c4bb7434b62ccd378d21b2d4ebf5e71
original_base_revision: 1a953486da85062861581473eb28114a89771136
owners:
  - desktop
  - platform-security
  - local-companion
  - release-engineering
---

# Linux parallel foundation implementation plan

## Decision

Complete the Linux-owned work that can proceed without activating Linux in the
production composition root or weakening the macOS/Windows qualification
sequence. The original August 27 work occurred on
`codex/linux-parallel-foundation-20260827`, based on the local Electron revision
`1a953486da85062861581473eb28114a89771136`.

For the authorized public integration on August 30, only the Linux changes
and a focused Electron test synchronization fix were ported to
`codex/linux-foundation-public-20260830`, based on the already-public Electron
revision `49fc02766c4bb7434b62ccd378d21b2d4ebf5e71`. The destination is
`codex/linux-integration`, not `main` or a Windows branch. Ten intervening
unpublished Electron/macOS commits and their private-history review were
excluded; the original local branch remains preserved. The August 27 results
below are historical, not qualification of this reconstructed public branch.

This plan does not authorize a Linux support claim, AppImage publication,
production selector activation, signing, deployment, version change, or use of
the maintainer's real keyring. Credential unit tests use injected in-memory
bindings. The native helper is runnable only in the reviewed container with
OS-backed marker and tmpfs proofs; that D-Bus/keyring run remains unqualified
until the native AMD64 workflow produces its warm and clean receipts.

## Frozen contracts

1. The Electron entrypoint, preload privilege boundary, companion ready line,
   exact loopback origin, lifecycle commands, and clean-quit behavior remain
   shared-shell contracts. Linux source smoke may adapt its fixture and target
   discovery to those contracts but may not bypass first-run or renderer
   readiness.
2. Linux credential support is `linux/x64` only. It owns exactly the existing
   export identity, account observation, Claude session pseudonym, and
   contribution-device service/account pairs. The macOS-only app-broker
   generation is excluded.
3. The raw Linux credential manager exposes `read`, `createIfMissing`,
   `replaceExact`, and `deleteExact`. Mutations require a caller-held opaque
   lease, mandatory readback, constant-time comparison, and clearing of
   app-owned secret buffers. The default dormant backend serializes only
   inside one process; an injected reviewed native seam can add cross-process
   ownership, but remains non-production until durable crash recovery exists.
4. Credential errors and receipts are fixed and content-free. Localized
   libsecret/keytar messages are never parsed into production decisions; an
   injected reviewed classifier owns any locked/denied/unavailable distinction.
5. Linux state ownership resolves through XDG roots, with
   `$XDG_STATE_HOME/app-usagemonitor` (or the documented home fallback) as the
   future durable state owner. New adapters remain dormant until shared
   composition is reviewed.
6. Autostart is a dormant, opt-in per-user contract containing only a reviewed
   absolute executable plus fixed flags. Its Node implementation is explicitly
   not production-safe: path-based rename and removal cannot bind the final
   syscall to a previously inspected inode against a same-UID race. Production
   wiring waits for a reviewed Linux conditional-mutation primitive. It never
   transports state, credentials, inherited environment, or shell fragments.
7. The ARM64 Colima/Xvfb lane remains development-only source evidence. The
   AMD64 lane must run natively on a declared Ubuntu/Debian x86_64 runner and
   uses a separate reviewed image digest and tag. Both image builders require
   a clean Git tree, bake the exact 40-character source revision into the OCI
   label/runtime environment, and include it in each GUI-smoke receipt.
8. Evidence distinguishes source, unpacked, and installed subjects. No source
   or container result qualifies an AppImage, installed tray, Wayland session,
   credential retention, upgrade, rollback, uninstall, or release.

## Parallel workstreams

### P1 — Current ARM64 source-smoke repair

- Seed only a validated synthetic first-run receipt in the disposable Electron
  profile.
- Select the actual dashboard page by its validated loopback identity rather
  than accepting the first CDP page.
- Preserve startup refresh, reload, network-none, descendant, clean quit, and
  content-free failure contracts.
- Rebuild and run the clean exact-revision container under Colima; reject a
  dirty source tree or an image without the baked revision identity.

### P2 — Dormant Linux Secret Service backend

- Add an exact `linux-x64` keytar binding loader and manifest verifier.
- Add the fixed capability map and credential manager.
- Add an owner-bound process-local mutation lease, an injectable future native
  cross-process seam, and a fixed failure classifier seam.
- Add injected-binding unit/adversarial tests and a disposable native D-Bus
  qualification helper.
- Own the disposable `dbus-run-session` and keyring processes through a
  bounded in-container supervisor that binds `/proc` process identities,
  terminates its exact process group/daemons, and fails unless cleanup is
  proven before the container exits.
- Do not edit or enable production selectors or runtime staging.

### P3 — Native AMD64 source environment and CI

- Add a distinct digest-pinned AMD64 Dockerfile and image tag.
- Add explicit AMD64 build/test commands that preserve `--network none` for the
  execution phase.
- Add a manually dispatched, pinned-action Ubuntu 24.04 workflow with native
  architecture proof and development-only receipts.
- Make the warm row prime and then rebuild from the same runner-local Docker
  cache; make the clean row build once with `--no-cache`.
- Do not use QEMU results as native evidence.

### P4 — Dormant XDG state and desktop owners

- Add deterministic XDG config/state/cache/runtime root resolution.
- Add a Linux state ownership/inventory adapter with owner-only validation.
- Add a fail-closed XDG autostart contract and a dormant Linux desktop
  capability adapter/asset resolver. Keep mutation integration closed until a
  native identity-bound primitive replaces the experimental Node path owner.
- Add adversarial tests for traversal, symlinks, modes, ownership, observable
  races, malformed entries, and bounded helper-owned cleanup. Preserve the
  final-syscall same-UID race as an explicit native-integration blocker.
- Do not wire the modules into `main.js`, `desktop-runtime.js`,
  `desktop-lifecycle.js`, or production selectors in this stage.

## Shared integration boundary

The primary integrator may update shared package scripts, the platform barrel,
tool inventory, architecture checks, and documentation only after each
Linux-owned workstream passes its focused tests. Production selectors remain
unchanged. AppImage builder/runtime-manifest work remains gated behind native
L1–L3 qualification and a separately reviewed shared-shell checkpoint.

## Validation ladder

1. Focused unit and contract tests for each workstream.
2. Workflow-policy, tool-inventory, architecture, and documentation checks.
3. Fresh ARM64 Docker image build and network-isolated GUI smoke.
4. Full root test suite because the combined change exceeds twenty files.
5. Four-pass audit covering implementation completeness, code quality,
   performance, tests, and documentation.

Native AMD64, Secret Service, X11/Wayland desktop-manager, and installed
AppImage acceptance remain open when the required native environments are not
available. Those environmental gates must be reported explicitly rather than
converted into passing local evidence.

## Exit criteria

- All four parallel foundations are implemented with focused tests.
- The current ARM64 source smoke passes from the exact branch revision or has a
  fixed, content-free product blocker with no harness false-pass.
- The native AMD64 workflow is policy-valid and ready to produce evidence.
- No Linux production selector, shared runtime activation, AppImage target, or
  support/publication claim is enabled.
- Existing macOS/Windows code and qualification tests remain unchanged or pass
  their relevant regression suites.

## Result — 2026-08-27

All four dormant foundations and their focused tests are implemented. Colima
was repaired, and the final network-disabled ARM64 source GUI smoke passed from
exact revision `1e84f14d35c1785c7000dcfc86681d9a18e50d04` in image
`sha256:1ecc1f49104fd191031fa78eda54a02dea6a073f71feb3603a0f54d97476451d`.
The native AMD64 workflow remains unrun, and every production selector,
runtime-staging, AppImage, installed-lifecycle, and support gate remains
closed.

The full root suite passed 3,685 of 3,755 tests with 68 explicit skips. Its two
failures are the protected R7 receipts invalidated by the intended source
change. Two exact-runtime regeneration attempts failed closed on a pre-existing
duplicate `session_meta` record in private local history. No private history or
evidence contract was mutated to force that gate green. See the
[verification receipt](../receipts/2026-08-27-linux-parallel-foundation-receipt.md)
for the complete evidence and remaining production gates.

## Public integration — 2026-08-30

[PR #82](https://github.com/adamallcock/tibotattle/pull/82) targets only
`codex/linux-integration`. Fresh verification on implementation revision
`5764d5f555460db2164e9fb9662dd87c6b106268` passed the Linux foundation suite
(91 passed, one native-only skip), all 300 Electron tests, and the exact-revision
ARM64 network-disabled source GUI smoke. The full root suite recorded 3,666
passed, two protected stale-R7-receipt failures, and 68 skips out of 3,736 tests.
It is not a green repository-wide release gate.

The [public integration receipt](../receipts/2026-08-30-linux-public-integration-receipt.md)
records the public ancestry boundary, current image identity, fresh results,
and unchanged production blockers. No private-history recovery or receipt
regeneration was attempted during this integration.
