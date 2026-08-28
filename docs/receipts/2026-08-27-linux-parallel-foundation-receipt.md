---
title: Linux parallel foundation verification receipt
date: 2026-08-27
type: receipt
status: foundation-complete-r7-evidence-blocked
---

# Linux parallel foundation verification receipt

## Claim boundary

Four Linux-owned foundations are implemented and remain dormant: a hardened
ARM64 Electron source smoke, a Linux x64 Secret Service backend and isolated
qualification harness, deterministic XDG state/desktop owners, and a native
AMD64 development workflow. Production composition still selects only the
existing macOS and Windows owners. No Linux package, installed application,
support claim, release, workflow run, upload, push, or publication is evidenced
by this receipt.

The ARM64 result below is exact-revision source-container evidence. It does not
qualify Linux x64, a real desktop session, the maintainer's keyring, an
AppImage, installation, upgrade, rollback, uninstall, signing, or release
trust.

## Revision and environment

- Base revision: `1a953486da85062861581473eb28114a89771136`.
- Foundation source revision:
  `1e84f14d35c1785c7000dcfc86681d9a18e50d04`.
- Task branch: `codex/linux-parallel-foundation-20260827`.
- Colima was repaired and running through macOS Virtualization.Framework with
  an `aarch64` VM, Docker runtime, and `virtiofs` mounts.
- Docker client/server: `29.5.0` / `29.2.1`; server platform:
  `linux/arm64`.
- No branch was pushed or merged and no workflow was dispatched.

## Completed foundations

### ARM64 source GUI smoke

- The builder refuses a dirty tree and binds the exact 40-character Git
  revision to the OCI image label and runtime environment.
- The smoke seeds a synthetic production-validated returning-user receipt,
  selects only the validated loopback dashboard target, bounds CDP and JSON
  input, records exact `/proc` descendant identities, and proves those
  descendants are gone after the gated quit.
- The final image is
  `sha256:1ecc1f49104fd191031fa78eda54a02dea6a073f71feb3603a0f54d97476451d`.
  Its platform is `linux/arm64`; both its OCI revision label and runtime
  revision are `1e84f14d35c1785c7000dcfc86681d9a18e50d04`.
- The final `--network none` run passed against Chrome `150.0.7871.129`,
  reached a validated loopback dashboard, observed nine descendants at
  readiness, reloaded the renderer, proved loopback-only runtime interfaces,
  and exited cleanly. Window minimize/restore was unavailable and is reported
  as false rather than inferred.
- Startup refresh ended in the explicitly allowlisted content-free degraded
  state `codex_rollout_lineage_invalid`. The dashboard, process, network, and
  clean-quit gates still passed.

### Linux credentials

- The dormant loader pins `@github/keytar` `7.10.6` at the exact
  `linux-x64` prebuild, 109,664 bytes, SHA-256
  `e7894a1e1001764de29ff08d3dae418ccbaaf78889c5673d367e05df1682fc7c`.
- The backend owns exactly four cross-platform capabilities and implements
  read, create-if-missing, exact replace, and exact delete with mandatory
  readback, constant-time comparison, buffer clearing, and fixed content-free
  errors.
- The default mutation lease is deliberately process-local. An injectable
  native seam exists, but `crossProcessSafe`, `crashRecoveryComplete`, and
  `productionSafe` remain false until a reviewed native primitive is
  qualified.
- The native helper requires Linux x64, an exact container marker, separate
  owner-only tmpfs home/runtime roots, an isolated D-Bus session, bounded
  output/deadlines, exact process identities, TERM-to-KILL cleanup, and proof
  that every owned process exited.
- Stock keytar does not expose stable locale-independent libsecret error codes.
  Production locked/denied/unavailable classification therefore remains a
  blocker; localized message parsing was not introduced.

### AMD64 development lane

- A separate digest-pinned AMD64 Dockerfile, clean-tree revision-binding
  builder, network-isolated smoke commands, and manual Ubuntu 24.04 workflow
  are present.
- The workflow pins its actions, asserts native `x86_64`, separates warm and
  `--no-cache` builds, and emits development-only content-free receipts.
- The workflow is unrun and unpublished. A local QEMU diagnostic stopped in
  Node/libuv `uv__io_poll` with exit 134 during dependency installation; it is
  recorded only as an emulation limitation and is not native AMD64 evidence or
  a product failure.

### XDG state and desktop owners

- Deterministic XDG roots, owner/mode/identity validation, current state-path
  inventory, SQLite sidecar inventory, and composition-time identity
  revalidation are implemented but unreachable from production composition.
- Dormant tray/capability and per-user autostart contracts fail closed on
  malformed, symlinked, hard-linked, replaced, or permissive paths.
- Node path APIs cannot bind the final autostart mutation syscall against a
  same-UID replacement race. Production autostart remains closed pending a
  reviewed native conditional-mutation primitive.

## Validation ledger

| Lane | Result |
|---|---|
| Linux foundation suite | 92 tests: 91 passed, 0 failed, 1 explicit native-Linux-x64 skip |
| Electron suite | 300 passed, 0 failed |
| Architecture | 440 production files, 1,704 imports, 0 approved debt edges |
| Tool inventory | Complete: 108 records, 109 executable paths, 67 aliases |
| Documentation and diff | Links normalized; `git diff --check` passed |
| Exact ARM64 build and GUI smoke | Passed from revision `1e84f14d`; network disabled at execution |
| Full root suite | 3,755 tests: 3,685 passed, 2 failed, 68 explicit skips |
| Independent audits | No Critical, High, or Medium code-quality, performance, completeness, test, or documentation findings |

The two full-suite failures are only the protected R7 current-workload and
dependent-decision receipt assertions described below. No Linux-foundation,
Electron, macOS, or Windows regression failed in that run.

## Protected R7 evidence blocker

The source additions correctly invalidate the ten retained R7 release-evidence
receipts. Regeneration was attempted twice with the exact Node 24.14.0 and
26.2.0 runtimes and the fixed retained interval. Both attempts completed the
six synthetic/materialized phases, then failed closed during the
real-local-history source scan with `source_integrity`.

A content-free local diagnosis isolated
`export_source_codex_rollout_content_invalid`: source ordinal 0 contains a
duplicate `session_meta` record at line 1,932. The existing parser contract
intentionally rejects duplicate session metadata, including identical
duplicates. The pre-existing private history was not deleted, rewritten,
relabeled, or copied into a sanitized authority; the parser and receipt tests
were not weakened; and hand-edited receipts were not substituted. Failed
regeneration preserved the prior receipts and cleaned its temporary controls.

Resolving this gate requires a separately authorized, preserve-first recovery
decision for private local history. Until then, the foundation implementation
is complete but the repository-wide protected R7 evidence gate remains red.

## Remaining Linux production gates

- Native AMD64 warm and clean workflow receipts, including the disposable
  Secret Service lifecycle.
- A stable libsecret failure classifier and crash-safe cross-process credential
  mutation lease.
- Point-of-I/O XDG ownership, migration, crash, and retention qualification.
- A native identity-bound autostart mutation primitive.
- Real X11 and Wayland tray/window/session qualification.
- Linux runtime staging, AppImage construction and verification, installed
  lifecycle, upgrade/rollback/uninstall, signing/evidence policy, and release
  publication.

These are production-integration stages, not omissions hidden by this
foundation receipt.
