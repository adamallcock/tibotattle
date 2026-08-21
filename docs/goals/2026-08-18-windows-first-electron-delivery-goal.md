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

## Progress checkpoint: 2026-08-21

- The integration branch has been rebased on `origin/main` at
  `49965f401131f938b188f6067164ff0ade6a56ff` (version `0.1.15`). The native
  publication repair is committed at `bb4dda4`, and the bounded diagnostic is
  committed at `ccbda4e`.
- A bounded phase diagnostic proved that Windows SQLite publication failed in
  `publish_stage_preflight`. The repair now opens the existing staging database
  with the `GENERIC_WRITE` access required by `FlushFileBuffers`, while keeping
  `WRITE_DAC` limited to create-new paths.
- Local preflight passed. The current local portable lane passes 1,212 tests:
  1,169 passed, 43 expected non-Windows skips, and 0 failures.
- Exact Windows run `32450640613` passed the repaired native filesystem
  diagnostic in both warm and clean jobs, then deterministically failed to exit
  the monolithic portable lane before the 45-minute job guard. Cleanup and the
  clean-checkout gate passed in both jobs. Because the portable output was
  buffered, cancellation did not reveal the responsible test file.
- A bounded, content-free per-file diagnostic now runs the exact portable
  manifest before the unchanged authoritative lane. It has a 60-second
  per-file limit, a five-minute total limit, fixed repository-relative failure
  metadata, and owned process-tree cleanup. Its own functional tests are part
  of the portable manifest.
- Exact Windows run `32454949390` proved the diagnostic boundary in both warm
  and clean jobs. Each job passed native build and the repaired filesystem
  diagnostic, then reported the same ordinary failure at ordinal 18,
  `test/fast-mode-accounting.test.js`, in less than 300 milliseconds. The job
  cleanup and clean-checkout gates passed.
- The ordinal-18 failure was a real mixed-fixture boundary: owner-only state
  controller tests used the POSIX path-only fixture that production Windows
  correctly rejects without a branded protected-state store. That file is now
  an explicit Windows deferral; the dedicated native Windows protected-state
  qualification remains in force.
- The per-file diagnostic now continues after ordinary nonzero test exits and
  reports at most 64 fixed manifest-derived failure records. Spawn, signal,
  per-file timeout, unproven process-tree termination, and global timeout paths
  still fail immediately. The current 101-file Windows manifest completes
  locally through the simulated selection seam.
- The dependent Windows Electron artifact/runtime, NSIS, and R7 receipt gates
  remain unaccepted. `productionSafe` remains false; no Windows or Linux
  support claim, version bump, release, publication, or signing action is
  authorized by this goal.
- The concrete blocker is one more exact native Windows run to enumerate any
  remaining ordinary portability failures or identify the original non-exiting
  process. No production promotion should occur until that run advances to the
  unchanged authoritative portable lane.

### Ordered next steps from this checkpoint

1. Commit and push the reviewed diagnostic aggregation and explicit mixed-file
   deferral, then dispatch that exact revision to the warm-and-clean Windows
   qualification workflow.
2. Accept one bounded result: either the per-file diagnostic completes and the
   authoritative lane advances, it returns the complete bounded set of ordinary
   portability failures, or it stops at the first timeout/termination status.
   Do not repeat one-file-at-a-time workflow runs.
3. Accept the Windows native/security boundary only when warm and clean jobs
   pass the authoritative portable lane, content-free native qualification,
   cleanup, and clean-checkout gates on one exact revision.
4. Then prove the existing Windows Electron directory artifact and runtime
   smoke, add the separately bounded unsigned NSIS artifact gate, and only
   after final source freeze regenerate the ten R7 receipts. Preserve the
   native macOS app and keep every production selector closed throughout.

## Progress checkpoint: 2026-08-19

- The secure shared Electron shell, companion supervision, platform gate,
  deterministic runtime staging, Windows x64 directory packaging workflow,
  and content-free runtime smoke are implemented. The Windows smoke covers
  dashboard readiness, a CDP-proven renderer reload, tray/window lifecycle,
  single-instance rejection, credential probe plus deterministic
  create/read/delete, relaunch persistence, descendant monitoring, and clean
  quit.
- Windows remains deliberately qualification-only. The packaged development
  context requires the exact `TiboTattle Dev` brand, real packaged resource
  root, canonical runtime inventory and payload digest, complete file-byte
  revalidation, the reviewed native sidecar, and the pinned Windows Keytar
  digest. Copied contexts, reader injection, launcher path/supervisor
  overrides, central origins, development identity, and provider paths outside
  disposable `TEMP` are rejected. Every existing Windows path component is
  inspected through the native adapter and reparse points are refused.
  `productionSafe` and every production selector remain false.
- The exact native Windows security qualification set contains 31 reviewed
  files. Its parent runner has a bounded timeout, bounded content capture,
  Windows process-tree termination, fixed content-free status codes, and a
  fail-closed termination result. Native Windows x64 has not run this revision,
  so the remaining reparse, Credential Manager, native addon, and process-tree
  claims are not yet proven.
- The frozen local source passed the combined Electron/qualification/server
  suite with 128 of 128 tests, architecture with 395 production files and zero
  debt edges, tool inventory with 83 records and 85 executable paths, preflight,
  and workflow lint. The authoritative portable lane passed 1,142 tests:
  1,100 passed, zero failed, and 42 expected native-platform skips.
- Ten R7 source-bound receipts were regenerated once after source freeze and
  independently revalidated under pinned Node 24.14.0 and Node 26.2.0. They
  cover 351 source files with SHA-256
  `8700d636a4a38d00b02203f8523d2968db7cf56d3e579c15988d956b1c486dcd`.
- The unsigned macOS arm64 Electron stage contains 431 reviewed files and was
  rebuilt with Electron 43.2.0. The packaged application launched against a
  disposable synthetic home, rendered the loopback dashboard, reloaded the
  renderer, exposed the supervised descendant tree, and quit cleanly. The
  existing native macOS application remains unchanged.
- The pinned Debian/Xvfb Linux Electron image was rebuilt from the frozen
  source and passed with `--network none`: dashboard ready, renderer reload,
  eight supervised descendants at readiness, clean quit, and no retained
  container. This is a shared-shell development proof, not a Linux support or
  packaging claim.
- No version bump, push, workflow dispatch, signing, publication, deployment,
  native macOS replacement, Windows support claim, or Linux support claim has
  occurred.

### Immediate ordered work

1. Commit the reviewed local slices while preserving the unrelated untracked
   `reports/` directory, then record the exact source revision.
2. Obtain explicit authorization to push that revision and dispatch the manual
   Windows warm/clean workflow. Do not dispatch a different revision.
3. Accept Stage 4 only if native Windows x64 returns zero skips and proves the
   addon, Credential Manager lifecycle, packaged renderer/tray/single-instance
   behavior, relaunch persistence, process-tree cleanup, and content-free
   receipt. Use at most one focused repair pass for a concrete native failure.
4. After native launch qualification, implement and qualify the Windows
   installer, upgrade, rollback, uninstall/data-retention, and signing/
   provenance boundary without publishing.
5. Extend Linux into a declared distro, credential-store, desktop-manager tray,
   autostart, packaging, and installed-app matrix only after the Windows shell
   contract is stable.

## Historical progress checkpoint: 2026-08-18

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
  excluding ignored release/repro caches and local reports. A second pinned
  Debian/Xvfb lane now launches the real Electron shell, reaches the loopback
  dashboard, reloads it, invokes the same main-process shutdown path as tray
  Quit, exits zero, and leaves no companion descendant. This proves the
  portable shared core and source Electron GUI on Linux; it does not qualify a
  Linux package, credentials, desktop-manager tray, autostart, updater, or
  installation.
- Contribution-device renewal state, automatic and incremental contribution
  settings, Fast-mode preference, and the Codex speed-baseline ledger now have
  explicit branded Windows protected-store routes. Their Windows branches
  reject forged stores, path escapes, platform downgrade, ordinary storage
  injection, and Node filesystem fallback. The companion-wide automatic-
  contribution lifetime lock still fails closed on Windows until its native
  kernel-backed lease is integrated.
- Unified-index rebuild and incremental publication now have a repository-
  owned native create/streaming-clone/atomic-publish boundary. The native
  operations remain pinned to the protected root and expected file identities,
  reject reparse points, hard links, unexpected SQLite sidecars, and root
  replacement, and clean unpublished stages after failures. Rebuild and ingest
  no longer select Node copy, rename, or unlink on Windows. The staging safety
  flag remains false pending native Windows compilation and qualification.
- Anthropic's documented Windows Claude Code defaults are now understood:
  `%USERPROFILE%\\.claude\\settings.json` and
  `%USERPROFILE%\\.claude\\projects\\`, with `CLAUDE_CONFIG_DIR` relocating
  the complete Claude Code root. This does not establish a Windows equivalent
  of the macOS-only Claude Desktop `plan-usage-history.json` source; that lane
  must remain unavailable until a real Windows installation supplies path and
  schema evidence. The existing `/bin/sh` status-line replay is also still a
  separate Windows process-contract blocker.
- Production readiness, authenticated binding provenance, production signing,
  installer/updater qualification, and the native Windows x64 warm-and-clean
  run remain gates. Windows support is not claimed, Linux compatibility is not
  claimed, and no version bump, publication, or replacement of the native
  macOS client has occurred.

### Historical ordered work (superseded by the 2026-08-19 checkpoint)

1. Finish the fixed Windows state composition: add a caller-unnameable native
   companion lifetime mutex, pass the protected store into automatic,
   incremental, Fast-mode, and speed-baseline controllers, and implement the
   prepared-contribution artifact boundary. Exit when settings, locks,
   artifacts, and cleanup use one branded composition without silently
   reverting to portable storage.
2. Finish the documented Claude Code root composition and replace the POSIX `/bin/sh`
   callback command path with a Windows-safe process contract. Exit with
   install, uninstall, interruption recovery, and no-fallback coverage.
   Keep the undocumented Windows Claude Desktop quota source unavailable until
   native installation evidence establishes its location and schema.
3. Run native Windows qualification for the protected-child, credential,
   SQLite lease/session/staging, and companion-mutex primitives on the exact
   revision. Exit with zero skips and fixed aggregate evidence, or keep the
   corresponding readiness flags false and name the exact failing primitive.
   This requires separate authorization to push and dispatch the manual
   workflow.
4. Compose readiness only from the authenticated binding, qualified native
   store/session, and one shared branded capability set. Exit when negative
   forgery/copy tests and positive composition tests agree; do not mint
   readiness locally while native proof is absent.
5. Dispatch the packaged Electron Windows x64 workflow on the exact revision
   after the production persistence boundary is complete, and qualify
   warm and clean app launch, companion lifecycle, dashboard, and shutdown.
   Exit with zero unexplained skips and no orphan; no macOS or simulated
   `win32` run can substitute for this evidence.
6. Qualify the Windows installer, upgrade, rollback, uninstall, and
   credential-retention behavior only after the native launch gate passes.
7. Extend the now-executable Linux GUI lane into an explicit distro,
   credential, tray/autostart, packaging, and installed-app matrix only after
   the Windows shared-shell contract is stable; this does not yet claim Linux
   support.

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
