---
title: Windows-first Electron desktop delivery
date: 2026-08-18
type: goal
status: active
---

# Windows-first Electron desktop delivery

## Outcome

Deliver a verified, unpublished Windows x64 development application that uses a
small Electron shell around TiboTattle's existing local companion and web
dashboard. Preserve the current native macOS application throughout the work
and leave a stable shared-shell boundary for later Linux implementation.

This goal starts from local `main`. It does not authorize a version bump,
production signing, a public artifact, a GitHub release, an appcast change, a
Homebrew update, a service deployment, replacement of the native macOS client,
or a Linux-support claim.

## Progress checkpoint: 2026-08-18

- Stage 1 is complete: the current-main portable lane and real companion smoke
  passed, and the documentation scanner now ignores only reviewed runtime and
  dependency directories.
- The local Stage 2 safety pass is complete and fail-closed. Windows adapters
  are centrally branded, and forged or copied objects cannot promote
  production. The contribution-device binding metadata path now uses the
  branded boundary for validation, creation, identity-bound reads, deletion,
  and legacy migration. This is a negative safety guarantee, not proof that all
  Windows credential state is positively qualified.
- The native protected-child boundary now opens children relative to an
  identity-checked protected root, rejects ambiguous relative names, bounds
  reads before allocation and rechecks size after reading, and performs every
  fallible replacement check before the atomic rename. Protected deletion
  revalidates the opened final path before disposition. The runtime loader and
  packaged-artifact verifier also require exact agreement between native
  claims and approved policy.
- `WindowsProtectedStateStore` now routes inspect, read, create, replace,
  delete, pending cleanup, and operation leases through those native
  root-identity-bound child methods with a one-MiB ceiling. It deliberately
  continues to report `productionSafe: false`, `rootBindingSafe: false`, and
  `nativeReadBounded: false` until the native Windows matrix proves the
  implementation. Stale crash recovery is still unavailable because the
  current lease contract has no authenticated age/heartbeat primitive.
- A production-qualified `WindowsSqliteStateSession` is still required for
  the collector, unified-index, Claude quota, and contribution-queue SQLite
  paths. Direct
  renewal and prepared-artifact paths still need to be wired through the
  protected store rather than falling back to ordinary Node filesystem access.
- The qualification-only SQLite foundation now exists. The native addon can
  pin an identity-checked root, database, and persistent rollback journal and
  serialize sessions across processes with an owner-only kernel mutex. The
  lease now also creates owner-only, exclusive, delete-on-close reservations
  for the derived WAL/SHM names for its complete lifetime. The JS session
  configures and reads back `PERSIST`, `FULL`, `MEMORY`, and zero-mmap policy,
  denies ATTACH/DETACH and protected PRAGMA mutations, hides the raw SQLite
  control surface, revalidates database and journal identities after opening,
  and closes SQLite before releasing the lease. `sqliteStateLeaseSafe` remains
  false until the real Windows matrix proves reservation behavior, transaction
  recovery, crash/reopen, and cleanup on the supported filesystem.
- The existing credential-operation audit now steps and verifies
  `journal_mode=PERSIST` and avoids conflicting Node filesystem syncs while
  its native guard is held. A failed SQLite close retains the guard and can be
  retried; a native guard-release failure remains permanently fail-closed.
- Claude callback lifecycle and settings state now have an explicit protected
  Windows composition with root matching, content-digest revalidation, and
  prepared-phase recovery tests. Actual Windows remains closed unless a
  branded readiness attestation and two fully qualified protected stores are
  supplied. The production runtime/CLI does not yet compose those stores and
  still builds a POSIX `/bin/sh` command, so this is plumbing rather than a
  Windows support claim.
- The latest integrated local contract run passed 102 runnable assertions with
  20 explicit native-Windows-only tests dormant on macOS. Architecture and
  preflight checks passed. The new Windows-only matrix covers the protected
  child lifecycle, bounded reads, root swaps, hostile paths, hard links,
  reparse points, and replacement cleanup, but it has not yet run on Windows.
- The secure shared Electron shell and deterministic runtime/app staging are
  implemented. Twenty-five focused shell, runtime-closure, and packaging tests
  pass, along with architecture and preflight checks.
- The unsigned macOS arm64 development bundle was rebuilt from the reviewed
  staging tree and verified at the artifact boundary: the stage and `app.asar`
  contain the same 416 files with no extras or omissions, and the only unpacked
  native payload is the Darwin arm64 Keytar binary.
- The packaged companion launched from inside `app.asar`, returned HTTP 200 on
  loopback, and released its port after termination. The complete app rendered
  the real local dashboard under disposable state, reloaded, stayed alive after
  window close, reopened on activation, and quit without an orphan.
- The preserved native macOS lane also remains green: its source suite passed
  44 tests with 3 expected source-only skips, and the native test-profile app
  built, launched, and completed its one smoke test with the development
  runtime deliberately disabled.
- The artifact verifier and Windows CI package-build gate are locally complete:
  their focused verifier, packaging, and governance checks pass locally. The
  native Windows workflow has not been dispatched, so there is no Windows
  workflow or runtime result to report.
- Stage 3 is locally complete. The Stage 4 package structure is ready, but its
  native launch gate remains blocked by the unfinished Stage 2 production
  persistence composition. Native Windows x64 remains the authority for the
  addon, credential integration, packaged-app lifecycle, and installer claims.
  No Windows runtime or launch claim has been made.
- The network-isolated Linux portable container now passes from the current
  tree. Its Docker context was reduced from about 3.7 GB to about 34 MB by
  excluding ignored release/repro caches and local reports. This proves the
  portable shared core and companion lane on Debian; it does not qualify a
  Linux Electron GUI, credentials, tray, autostart, package, or installation.
- Production readiness, authenticated binding provenance, production signing,
  installer/updater qualification, and the native Windows x64 warm-and-clean
  run remain gates. Windows support is not claimed, Linux compatibility is not
  claimed, and no version bump, publication, or replacement of the native
  macOS client has occurred.

### Immediate ordered work

1. Run the native Windows qualification for the implemented protected-child,
   credential-coordination, and SQLite lease/session primitives on the exact
   revision. The SQLite test exercises real `DatabaseSync`, durable policy,
   transactions, rollback, cross-process contention, abrupt termination,
   hot-journal recovery, close/reopen, and sidecar cleanup. Exit with zero
   skips and fixed aggregate evidence, or keep all readiness flags false and
   name the exact failing primitive. This requires separate authorization to
   push and dispatch the manual workflow.
2. Route collector, unified-index, Claude quota, and contribution-queue state
   through the qualified SQLite session. The unified-index staging/publication
   path additionally needs a native handle-bound atomic publication contract.
   Exit when Windows composition tests prove that none can fall back to
   ordinary Node/SQLite state.
3. Add an authenticated kernel-backed lease/age contract for crash recovery,
   or document a bounded startup-recovery design that remains fail-closed.
   Exit only after native contention, abandonment, stale-state, and exact
   release tests pass.
4. Finish contribution, renewal, and prepared-artifact wiring against the same
   protected boundaries. Exit when state, leases, and metadata use one branded
   composition without silently reverting to portable storage.
5. Finish Claude production composition and replace the POSIX `/bin/sh`
   callback command path with a Windows-safe process contract. Exit with
   install, uninstall, interruption recovery, and no-fallback coverage.
6. Compose readiness only from the authenticated binding, qualified native
   store/session, and one shared branded capability set. Exit when negative
   forgery/copy tests and positive composition tests agree; do not mint
   readiness locally while native proof is absent.
7. Dispatch the packaged Electron Windows x64 workflow on the exact revision
   after the production persistence boundary is complete, and qualify
   warm and clean app launch, companion lifecycle, dashboard, and shutdown.
   Exit with zero unexplained skips and no orphan; no macOS or simulated
   `win32` run can substitute for this evidence.
8. Qualify the Windows installer, upgrade, rollback, uninstall, and
   credential-retention behavior only after the native launch gate passes.
9. Prepare Linux only after the shared shell/core boundary is stable, with an
   explicit distro and GUI matrix; this does not claim Linux support.

## Delivery rules

- Complete the stages below in order. A later stage may be researched while an
  earlier one runs, but it may not be integrated in a way that hides or bypasses
  an unmet dependency.
- Use Luna workers for most bounded investigation, implementation, test, and
  audit slices. The primary agent owns architecture, file ownership, conflict
  avoidance, integration, destructive operations, external authority, and
  final acceptance.
- Give each stage one primary implementation pass and one focused repair pass
  for unambiguous failures. After that, record a concrete blocker and stop the
  dependent path instead of repeatedly weakening checks or cycling fixes.
- Treat macOS as the fast local Electron development loop and native Windows
  x64 as the authority for Windows security, packaging, installation, and
  lifecycle claims.
- Use only synthetic fixtures and disposable credentials in hosted or
  container qualification. Receipts remain content-free.

## Stage 1: trustworthy current-main baseline

### Work

- Restore the official portable preflight without deleting or ignoring real
  source problems.
- Make the real companion-process smoke launch, report ready, serve its private
  synthetic dashboard, and shut down without an orphan.
- Run the complete portable lane from a clean, documented environment.

### Exit criteria

- The official portable command runs to completion on current `main`.
- The companion-process smoke passes with spaces and Unicode in its synthetic
  paths, exposes no fixture content or path, and leaves no child process.
- Any environment-only prerequisite is encoded in the runbook or tooling so a
  clean rerun does not depend on private operator knowledge.

### Stop condition

After one repair pass, a remaining failure must be reduced to one named test,
command, root cause, and owner decision. Electron integration does not proceed
if the companion lifecycle itself remains unreliable.

## Stage 2: Windows production-security promotion

### Work

- Close the remaining handle identity and atomic replacement race.
- Move every credential-consumer state and lease path required by the Windows
  desktop slice onto the qualified filesystem boundary.
- Authenticate the native binding through a development-package provenance
  contract while retaining a stricter signing gate for release artifacts.
- Enable the four Windows capability selectors only through the shared
  readiness attestation.
- Run native adversarial filesystem and Credential Manager qualification.

### Exit criteria

- The production backend truthfully reports cross-process safety, durable
  audit, protected state paths, authenticated binding provenance, completed
  startup recovery, and production safety.
- Export identity, account observation, Claude callback, and contribution
  device selectors pass their complete Windows composition contracts.
- Native Windows x64 warm and clean jobs pass on the same exact revision with
  zero unexplained skips and a clean tracked checkout.
- If production signing is the only unmet dependency, the development artifact
  remains explicitly branded and fail-closed for release while using an exact,
  recorded development binding digest.

### Stop condition

Do not set a readiness flag merely to unblock Electron. An unresolved
filesystem race, ambiguous Credential Manager mutation, secret-bearing output,
or unauthenticated production binary blocks promotion.

## Stage 3: secure shared Electron shell

### Work

- Add a dedicated desktop package with an Electron main process, a minimal
  preload bridge, and the existing local dashboard as its renderer.
- Keep Node integration out of the renderer, enable context isolation and
  sandboxing where supported, deny unapproved navigation and permissions, and
  expose no general IPC or filesystem bridge.
- Supervise one companion child on loopback with an ephemeral port and private
  session authority.
- Implement window, tray, single-instance, activation, retry, graceful quit,
  and bounded orphan-recovery behavior.
- Keep the native macOS launcher, build, updater, and release paths unchanged.

### Exit criteria

- Automated contracts cover the preload surface, navigation policy, child
  lifecycle, single-instance handling, and shutdown.
- A locally packaged development `.app` launches on macOS, renders the real
  local dashboard, refreshes synthetic data, survives window close/reopen, and
  quits without an orphan.
- The existing macOS source and smoke lanes remain green.

### Stop condition

Do not ship a privileged renderer, load a remote dashboard, duplicate the
accounting engine, or replace the native Mac client to make the prototype work.

## Stage 4: working Windows x64 development artifact

### Work

- Build Electron and the reviewed native addon together on native Windows x64.
- Produce an unpacked development application and one explicit installer
  format.
- Automate installed or packaged application behavior using synthetic input.

### Exit criteria

On native Windows x64, the exact artifact must:

1. launch without a terminal;
2. start exactly one private companion;
3. render the local dashboard and complete a synthetic refresh;
4. use the qualified Credential Manager and protected state paths;
5. close and reopen its window from the tray;
6. reject a second application instance;
7. quit without an orphan;
8. relaunch with expected state and credential retention; and
9. emit only fixed, content-free diagnostics.

Both normal and clean dependency-store jobs must pass against the same source
revision and artifact manifest.

### Stop condition

A macOS Electron pass, Linux container pass, simulated `win32` branch, or
cross-compiled installer cannot replace native Windows x64 evidence.

## Stage 5: unpublished Windows release candidate

### Work

- Define the installer, Authenticode/provenance, update, upgrade, rollback,
  uninstall, credential-retention, and local-data-retention contracts.
- Rehearse clean install, N-to-N+1 upgrade, failed update recovery, uninstall,
  reinstall, and clean-profile launch.
- Produce a source- and artifact-bound readiness receipt.

### Exit criteria

- All locally controllable gates pass and the remaining production-signing or
  reputation requirements, if any, are explicitly external.
- The candidate is unpublished and cannot be confused with the supported
  native Mac release.
- The receipt names the exact revision, artifact digest, runner, runtime,
  installer, pass/fail/skip counts, and every remaining external blocker.

### Stop condition

Do not acquire certificates, sign with production credentials, publish an
installer, create a release, or update a feed without separate authorization.

## Stage 6: Linux preparation after shell stability

### Work

- Define Linux credential storage, filesystem safety, tray, autostart, Wayland
  and X11 behavior, packaging, and installed-app qualification.
- Add an executable Linux GUI test environment for the shared Electron shell.
- Reuse the proven shell/core boundary without weakening Windows or macOS
  contracts.

### Exit criteria

- Linux work has an ordered implementation plan, explicit distro/support
  matrix, and a repeatable GUI smoke environment.
- Shared shell tests run on Linux without claiming production credential,
  installer, tray, autostart, or support readiness.

### Stop condition

Do not claim Linux support until its native credential, filesystem, desktop,
package, install, upgrade, and uninstall gates pass on the declared matrix.

## Completion claim

The goal is complete only when TiboTattle has a qualified, unpublished Windows
x64 Electron development application, the existing native macOS product is
unchanged and green, the Windows release boundary is explicit, and Linux has a
repeatable next-stage environment and plan. Any external release or signing
action remains a separate owner-authorized goal.
