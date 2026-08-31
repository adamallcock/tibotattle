---
title: Linux Electron readiness and support plan
date: 2026-08-21
type: goal
status: dormant-foundation-implemented
parent: 2026-08-18-windows-first-electron-delivery-goal.md
---

# Linux Electron readiness and support plan

## Purpose and boundary

This is the implementation plan for the Linux stage of the
[Windows-first Electron delivery goal](./2026-08-18-windows-first-electron-delivery-goal.md).
Production integration starts only after the shared Electron/core boundary is
stable and the Windows-first dependency has either passed its native gates or
has a named, fail-closed external blocker. Additive Linux-owned foundations may
be developed in parallel while they remain unreachable from production
composition. This does not reorder the Windows work, replace the existing
native macOS client, or turn a Linux container smoke into a support claim.

The first Linux distribution subject is deliberately narrow: native Linux
x86_64, initially qualified on a declared Ubuntu/Debian matrix, with one
unpublished AppImage candidate. ARM64 Linux, additional distributions, DEB/RPM
packages, Flatpak, Snap, managed repositories, and an official Linux release
are separate follow-on subjects. This follows the accepted
[cross-platform release-trust decision](../decisions/2026-08-18-cross-platform-release-trust.md),
which selects a native x86_64 AppImage before adding managed channels.

The plan is development and qualification work only. It authorizes no version
bump, signing-key use, release upload, package repository publication, service
deployment, credential migration on a real machine, or change to the native
macOS launcher/updater. Unit tests use synthetic homes, session data, and
injected credentials. Native credential execution must independently prove the
reviewed disposable container, tmpfs home/runtime roots, and isolated D-Bus
session before it can touch the four fixed capability tuples.

## Current status — 2026-08-30

Four dormant foundations now exist: the hardened ARM64 Electron source smoke,
an exact `linux-x64` Secret Service binding/backend and isolated qualification
helper, deterministic XDG state/desktop owners, and a manually dispatched
native AMD64 development workflow. None is wired into production selectors,
runtime staging, or Electron lifecycle composition. The native AMD64 workflow
has not run, and no desktop-manager, AppImage, installed lifecycle, upgrade,
rollback, uninstall, or support evidence exists. Linux L1–L7 acceptance gates
therefore remain closed. The exact-revision local result and its protected R7
blocker are recorded in the
[Linux public integration receipt](../receipts/2026-08-30-linux-public-integration-receipt.md).
[PR #82](https://github.com/adamallcock/tibotattle/pull/82) ports the Linux work
onto the already-public Electron base for `codex/linux-integration`, without
publishing intervening local Electron/macOS work or changing `main` or the
Windows branches. The August 27 receipt remains a historical record of the
original local revision.

## Current state: evidence and non-claims

The following is the source boundary inspected while preparing this plan
(`0.1.16`). The exact revision belongs in each qualification receipt rather
than in this self-changing plan. This document must not be read as evidence
that any future Linux stage has passed.

| Area | What exists and is evidenced | What remains unproven |
| --- | --- | --- |
| Electron shell | [`apps/electron/main.js`](../../apps/electron/main.js) composes the companion supervisor, platform gate, and desktop lifecycle. [`apps/electron/preload.cjs`](../../apps/electron/preload.cjs) exposes a frozen allowlisted v1 bridge; it exposes no filesystem or generic/unrestricted IPC bridge. [`apps/electron/loopback-policy.js`](../../apps/electron/loopback-policy.js) confines navigation, requests, webviews, and windows to the exact loopback companion origin. | No Linux support claim, installed-app proof, Linux production credential path, or Linux package has been accepted. |
| Window, tray, and process lifecycle | [`apps/electron/desktop-lifecycle.js`](../../apps/electron/desktop-lifecycle.js) implements single-instance locking, activation, hide-on-close, tray show/hide/toggle/retry/quit, one automatic companion retry, and serialized shutdown. [`apps/electron/companion-supervisor.js`](../../apps/electron/companion-supervisor.js) allowlists child environment variables, uses an ephemeral companion port, and bounds startup/shutdown. | The current real Linux smoke does not inspect an actual desktop-manager tray or autostart entry. Its tray/window substitute is CDP minimize/restore, and Electron 43 may not expose those CDP methods in the page endpoint. |
| Linux source GUI smoke | [`containers/electron-linux/Dockerfile`](../../containers/electron-linux/Dockerfile) pins the arm64 Node Bookworm base digest and exact tool versions, installs Electron/Xvfb, and [`scripts/smoke-electron-linux.mjs`](../../scripts/smoke-electron-linux.mjs) launches the real dashboard, checks loopback origin and health, observes HTTP(S)/WebSocket requests across a renderer reload, captures exact descendant process identities, and requests the gated main-process quit. The builder refuses a dirty Git tree, bakes the exact source revision into the image, and the smoke emits that revision. The clean image `sha256:f6b3a32d01f7781214898d3900fa8949ba8692cdf0ae2df7dbdefd15f107ff12` and its network-disabled run are bound to source revision `5764d5f555460db2164e9fb9662dd87c6b106268`; the run recorded nine descendants at readiness, loopback-only runtime interfaces, renderer reload, exact descendant cleanup, and clean quit. | This is a source-checkout Linux arm64 development proof only. Debian APT indexes and exact-version npm/Electron downloads remain mutable online build inputs, so it is not a reproducible production artifact. It does not prove x86_64, a Linux credential store, a desktop-manager tray, autostart, packaging, installation, upgrade, rollback, uninstall, or a release trust root. CDP minimize/restore was unavailable in the exact-revision run. |
| Linux paths and state | [`src/platform/linux-xdg-paths.js`](../../src/platform/linux-xdg-paths.js) resolves and revalidates owner-only XDG identities. [`src/platform/linux-state-composition.js`](../../src/platform/linux-state-composition.js) inventories the current companion state paths and SQLite sidecars under one dormant state owner. | Production composition is unchanged. Point-of-I/O descriptor ownership, mutation/crash tests, migration, and installed retention evidence remain L2 gates. |
| Credentials | [`src/platform/linux-secret-service-binding.js`](../../src/platform/linux-secret-service-binding.js) pins `@github/keytar` 7.10.6 `linux-x64` at 109,664 bytes and SHA-256 `e7894a1e1001764de29ff08d3dae418ccbaaf78889c5673d367e05df1682fc7c`. [`src/platform/linux-secret-service.js`](../../src/platform/linux-secret-service.js) owns the four fixed capabilities with readback and content-free errors; [`scripts/qualify-linux-secret-service.mjs`](../../scripts/qualify-linux-secret-service.mjs) requires a reviewed-container marker and separate tmpfs home/runtime roots. [`scripts/run-linux-secret-service-qualification.mjs`](../../scripts/run-linux-secret-service-qualification.mjs) owns the disposable D-Bus/keyring process identities, terminates them, and withholds a receipt unless cleanup is proven. | Production selectors still accept only the existing macOS/Windows owners. The default lease is process-local, crash recovery is incomplete, stock keytar cannot provide locale-independent locked/denied classification, and the native D-Bus/keyring lifecycle has not run on native x86_64. |
| Packaging | [`apps/electron/electron-builder.config.cjs`](../../apps/electron/electron-builder.config.cjs) has development `darwin` and `win32` directory targets. [`scripts/build-electron-app.mjs`](../../scripts/build-electron-app.mjs) and [`scripts/build-electron-runtime.mjs`](../../scripts/build-electron-runtime.mjs) make the reviewed runtime closure and target-specific native payload explicit. | There is no Linux builder target, Linux icon/desktop metadata, AppImage verifier, x86_64 ELF check, Linux native-binding artifact rule, detached-evidence policy, or installed-app harness. |
| CI | [`linux-portability.yml`](../../.github/workflows/linux-portability.yml) is a manual, immutable-action Ubuntu 24.04 development workflow. Its warm row primes and rebuilds from one runner-local Docker cache; its clean row uses `--no-cache`. Both run the native AMD64 image, network-isolated GUI smoke, and supervised disposable Secret Service job. | The workflow source is published in the Linux integration PR but has not been dispatched. It produces source-container evidence only and is not authoritative for AppImage, installed behavior, support, or release publication. |
| macOS preservation | The native Swift client and its build/release paths remain under [`apps/macos`](../../apps/macos) and are not part of the Electron Linux work. The existing native macOS shell is retained while Electron remains a shared development shell. | A Linux implementation must not modify, replace, or infer readiness from the native macOS login-item, Keychain broker, updater, or release path. |

When the local Docker daemon is stopped, start Colima, rebuild the pinned image,
and rerun the network-isolated container; an existing image or a prior ARM64
run is never silently treated as x86_64 evidence.

## Declared qualification matrix

The matrix is a support decision, not merely a list of machines that happen to
run Electron.

| Subject | Role | Required desktop/session | Status and permitted claim |
| --- | --- | --- | --- |
| macOS arm64 host + Colima/Docker arm64 | Fast development and portable/shared-shell regression | Xvfb for the current source smoke; no real Linux desktop claim | Current arm64 source-container evidence only. It may prove source portability and catch regressions, never Linux support. |
| Debian Bookworm x86_64 | First native Linux CI/build baseline | X11/Xvfb plus a disposable D-Bus Secret Service session | Required before accepting the first x86_64 artifact. Baseline evidence, not yet a distro-wide support claim. |
| Ubuntu 24.04 LTS x86_64 | Initial user-facing support target | X11 and Wayland, real session bus, desktop/status-notifier host | Required for the initial Linux support claim and installed lifecycle. No claim until every gate in this document passes. |
| Debian Bookworm x86_64 Wayland | Compatibility expansion within the initial target | Headless Weston or an equivalent isolated Wayland compositor, D-Bus session | Required before saying the AppImage is desktop-environment independent. A failure may narrow the declared support matrix, but cannot be hidden. |
| Fedora or another RPM distribution | Later compatibility subject | Declared only by a separate owner decision | Not in the first Linux release gate. Do not infer it from Debian/Ubuntu success. |
| Linux ARM64 | Later architecture subject | Native ARM64 runner or device | Current Colima arm64 proof does not qualify an ARM64 package or release. |

The initial support claim, if earned, must name the exact Linux architecture,
distribution floor, desktop/session combinations, artifact format, credential
store requirement, and limitations. “Works on Linux” is not an acceptable
receipt or website claim.

## Non-negotiable architecture decisions

1. Keep the shared Electron shell thin. The renderer remains the existing
   loopback dashboard; the companion remains the process that reads local
   sources. Do not copy accounting logic into Electron and do not add a broad
   renderer IPC or filesystem API.
2. Keep the native macOS client independent. No Linux change may alter the
   Swift AppKit/SwiftUI shell, `SMAppService` login-item behavior, Keychain
   broker, Sparkle path, or macOS release packaging.
3. Add a Linux platform owner instead of widening the macOS Keychain module or
   the Windows native adapter. A Linux credential module should load the exact
   `linux-x64` keytar binding from the reviewed staged artifact, verify its
   digest/provenance, and use Secret Service/libsecret. It must fail closed if
   no user session bus and Secret Service collection are available; it must
   never silently write a plaintext secret file.
4. Use the existing POSIX owner-only primitives as building blocks, but prove
   the complete Linux state contract. `O_NOFOLLOW`, UID/mode checks, hard-link
   checks, opened-handle identity, bounded reads, atomic publication, and
   directory durability each need a Linux test. A path-only check is not an
   adequate replacement for the Windows handle contract or a Linux race test.
5. Keep autostart explicit and per-user. The recommended Linux mechanism is an
   XDG user autostart desktop entry under `$XDG_CONFIG_HOME/autostart` (or
   `~/.config/autostart`) written atomically only after the user opts in. Do
   not install a system service, privileged helper, daemon, or hidden process;
   do not use autostart as a credential or state transport. The entry must
   contain only a reviewed absolute executable and fixed flags, never a secret,
   user path, session content, or arbitrary inherited environment.
6. Qualify both X11 and Wayland before broadening the claim. Electron's
   `Tray` abstraction depends on the desktop/status-notifier implementation;
   an Xvfb window smoke alone cannot prove tray behavior. If a desktop cannot
   provide a stable status-notifier contract, record the limitation and either
   narrow the support matrix or provide a visibly supported fallback, rather
   than claiming tray support from a mock.
7. Start distribution with one native x86_64 AppImage candidate. AppImage is a
   direct artifact, not a distro trust root. Detached signature/checksum,
   update/no-update semantics, and any managed repository are separate release
   decisions. Do not publish a loose DEB/RPM/Flatpak/Snap merely because
   electron-builder can produce one.

## Staged implementation sequence

Each stage has one primary Luna implementation pass and one focused repair
pass for unambiguous failures. After the repair pass, the owner records the
exact failing predicate, runner, command, and next decision. No stage may be
kept green by skipping the failing platform, weakening a privacy check, or
falling back to plaintext credentials. A later stage may prepare fixtures and
documentation, but it may not promote an unmet earlier gate.

### L0 — Freeze the shared boundary and evidence vocabulary

**Owner:** primary agent, with a Luna architecture/audit pass.

**Work:**

- Confirm the Windows-first shared shell is stable enough to extend. Preserve
  the exact Electron entrypoint, companion ready-line, loopback origin policy,
  preload marker, single-instance behavior, retry policy, and quit semantics.
- Define a Linux qualification-mode context separate from Windows production
  readiness. It must identify platform, architecture, source revision, target
  distribution, desktop protocol, credential-store mode, artifact digest, and
  whether the run is source, unpacked, or installed.
- Extend the test manifest/tool inventory/architecture checks only as needed;
  do not make Linux-only code reachable from the native macOS product path.
- Decide and record the first supported matrix before implementation: Debian
  Bookworm x86_64 CI baseline and Ubuntu 24.04 x86_64 X11/Wayland target.

**Exit criteria:**

- The matrix, evidence schema, and support/non-support wording are reviewed.
- Existing macOS native and Electron development tests remain green.
- The current arm64 container smoke remains classified as source GUI evidence,
  not support evidence.
- No Linux selector or production credential flag is enabled by this stage.

### L1 — Linux Secret Service credential backend

**Owner:** one Luna implementation worker for `src/platform/linux-*`
credential ownership and its focused tests; primary agent owns selector
integration and review.

**Work:**

- Add a Linux-specific loader for the reviewed staged keytar binding. The first
  target is `@github/keytar/prebuilds/linux-x64/keytar.node`; do not use
  keytar's unrestricted dynamic package search as the artifact authority.
  Record byte count and SHA-256 in a Linux manifest and revalidate the staged
  file immediately before loading.
- Define a fixed capability map matching the existing export identity, account
  observation, Claude callback/session pseudonym, and contribution-device
  capabilities. Use fixed service/account names and content-free error codes.
- Implement `read`, `createIfMissing`, `replaceExact`, and `deleteExact` with
  readback and constant-time comparison, clearing secret buffers in every
  success and failure path. Preserve caller-held leases and conflict results.
- Require a real user D-Bus session and Secret Service collection. Distinguish
  missing, locked, denied, unavailable, malformed, and readback-mismatch
  outcomes without printing D-Bus names, account identifiers, paths, or
  secret-shaped data. No environment-variable or owner-file fallback is a
  production selector; explicit development overrides remain visibly
  development-only.
- Add a reviewed interprocess mutation lease. Prefer a native/OS primitive
  with documented ownership and close semantics (for example, a bounded
  `flock(2)`/`fcntl` lease or an equivalent already-approved primitive). An
  `O_EXCL` lockfile without stale-owner and crash semantics is not sufficient.
- Qualify the exact x86_64 binding and runtime dependencies in the packaged
  closure. The currently observed digest is a candidate until the staged
  artifact and lockfile verification agree.

**Focused tests:**

- Use `dbus-run-session` and a disposable Secret Service implementation or an
  ephemeral unlocked gnome-keyring collection. Use one random service/account
  tuple per test and confirm deletion. Never inspect the maintainer's session
  bus or keyring.
- Cover create/read/replace/delete, missing and locked stores, malformed
  returned values, concurrent replace/delete conflicts, process restart,
  abrupt owner death, readback mismatch, binding-byte mutation, wrong
  architecture, and absent session bus.
- Assert that all receipts and diagnostics remain content-free and that no
  plaintext state file is created when Secret Service is unavailable.

**Exit criteria:**

- The exact Linux x86_64 binding passes the digest/provenance gate and loads
  only from the reviewed staged path.
- Every fixed capability passes create/read/replace/delete/readback,
  conflict, concurrency, restart, and cleanup tests in an isolated D-Bus
  session.
- Missing/locked/denied Secret Service fails closed with fixed diagnostics;
  no production selector silently selects an owner-file or environment
  secret.
- macOS still selects its existing Keychain backend and Windows still selects
  its existing qualification/production boundary; no cross-platform module
  has been widened accidentally.

### L2 — Linux filesystem and state composition

**Owner:** one Luna implementation worker for Linux/POSIX state adapters and
focused tests; primary agent owns composition-root integration.

**Work:**

- Make the default root and override policy explicit: state under
  `$XDG_STATE_HOME/app-usagemonitor` (default `~/.local/state/app-usagemonitor`),
  configuration under `$XDG_CONFIG_HOME`, cache under `$XDG_CACHE_HOME`, and
  runtime locks under `$XDG_RUNTIME_DIR` only when the session supplies one.
  Retain `CODEX_HOME` and `CLAUDE_CONFIG_DIR` as explicit source inputs.
- Route participant identity, account observation, callback state, contribution
  binding, collector state, unified index, prepared artifacts, review pairs,
  metadata bundles, and deletion/discard controls through named Linux owner
  boundaries. Do not assume that an existing `process.platform !== "win32"`
  branch proves the whole composition.
- Validate every existing component of a state root as a directory owned by the
  current UID with safe modes; reject symlinks, unexpected mounts/aliases,
  hard-linked sensitive files, group/world writable ancestors, and path
  replacement during an operation. Use opened descriptors/handles and compare
  device/inode (or the strongest available Linux identity) before and after
  byte capture.
- Qualify atomic create/replace/delete with flush and reopen. Cover SQLite
  database, rollback journal, WAL, and SHM sidecars as one state unit; reject
  sidecar placement outside the approved root and remove only owned temporary
  stages. Do not repair a Windows-only SQLite failure here or reuse a Windows
  readiness flag to claim Linux safety.
- Define migration and retention markers for the existing owner-file identity
  and any future Secret Service migration. A failed migration must leave the
  old valid state intact and must not delete a credential or secret as a
  cleanup shortcut.

**Exit criteria:**

- Fresh Linux x86_64 state roots pass ownership, mode, ancestor, symlink,
  hard-link, replacement-race, no-clobber, bounded-read, flush/reopen, and
  cleanup tests.
- All state consumers used by the Electron companion select the Linux
  boundaries explicitly; there is no ordinary Node filesystem fallback hidden
  behind a production selector.
- SQLite sidecars and leases pass normal, concurrent, crash/reopen, and
  interrupted-publication tests with no orphaned stage or sensitive residue.
- Upgrade-retention tests prove user state and Secret Service credentials are
  preserved across an application replacement; explicit purge is separate.

### L3 — Real Linux desktop lifecycle: tray, window, and autostart

**Owner:** one Luna desktop-integration worker for Linux-specific Electron
desktop code and harnesses; primary agent reviews the shared lifecycle diff.

**Work:**

- Keep the existing `desktop-lifecycle.js` contract as the shared baseline.
  Add only the Linux-specific icon/status-notifier and desktop integration
  boundary needed to make actual tray behavior observable; do not put a Linux
  branch into the preload or renderer.
- Ship a reviewed Linux tray icon in the runtime closure. Test real tray
  construction, context menu, show/hide/toggle, Retry, close-to-tray, activate,
  secondary-instance focus, and Quit. A blank `nativeImage.createEmpty()` or
  a mocked `Tray` is not sufficient for the Linux desktop gate.
- Run an X11 harness with Xvfb and a status-notifier host, and a Wayland
  harness with a disposable compositor/session. Record whether the host uses
  StatusNotifierItem, legacy tray, or no tray; no tray-host result may be
  converted into a pass by ignoring it.
- Implement per-user XDG autostart only after explicit user opt-in. Write a
  fixed, atomic `.desktop` entry under `$XDG_CONFIG_HOME/autostart` (default
  `~/.config/autostart`), use a reviewed absolute executable and flags, and
  expose enable/disable status without exposing the path or environment in
  diagnostics. Do not install a system-wide unit or privileged helper.
- Treat the current dormant Node owner as contract/test scaffolding only. Its
  path-based final `rename` and `unlink` calls cannot condition mutation on the
  inode that was inspected against a same-UID replacement race. Production
  activation requires a reviewed native conditional-mutation primitive before
  claiming atomic or removable autostart behavior.
- Test autostart disabled, enabled, malformed-entry recovery, executable
  replacement, explicit disable, uninstall cleanup, and relaunch with no
  duplicate companion. Autostart must not run in CI unless the test explicitly
  opts in with a disposable XDG config root.

**Exit criteria:**

- Ubuntu 24.04 x86_64 X11 and Wayland runs prove tray/menu/window lifecycle,
  single-instance handling, companion retry, clean quit, and no orphan.
- Debian Bookworm x86_64 baseline either passes the same contract or is named
  as a support limitation with the exact desktop protocol and failed
  predicate.
- Autostart is opt-in, per-user, atomic, content-free, removable, and leaves
  no hidden process or privileged service. Existing macOS login-item behavior
  is unchanged.

### L4 — Unpublished Linux x86_64 AppImage artifact

**Owner:** one Luna packaging worker for Linux builder/config/verifier tests;
primary agent owns artifact subject, release evidence, and publication boundary.

**Work:**

- Extend the development builder with a Linux x86_64 `AppImage` target only
  after L1–L3. Add reviewed Linux icon/desktop metadata, stable application
  identity, and the exact Linux runtime closure. Do not include Windows native
  modules, macOS-only assets, test fixtures, credentials, reports, or source
  checkout paths.
- Build from a clean staged tree with Electron 43.2.0 and electron-builder
  26.15.7 pinned by the lockfile. Include the exact Linux keytar binding and
  verify that the binding is the one exercised by the credential tests.
- Add a verifier that checks AppImage type/ELF header and x86_64 machine,
  executable permissions, archive/ASAR closure, no unexpected links or extra
  files, runtime dependency declarations, desktop metadata, and content-free
  manifest digests. The verifier must reject a copied or post-build-mutated
  binding.
- Keep the artifact unpublished and distinguish an AppImage file digest from
  any future detached signature or repository metadata. Choose the native
  Linux signing/evidence mechanism in a separate owner decision before any
  production key is used.

**Exit criteria:**

- A clean native Linux x86_64 build produces one reproducible, unpublished
  AppImage candidate with exact source, runtime, native-binding, byte-count,
  and SHA-256 evidence.
- The verifier rejects architecture mismatch, missing/extra closure files,
  symlink/path traversal, altered native bytes, embedded secrets, and
  post-manifest mutation.
- The candidate runs from a disposable directory on both declared target
  distributions, subject to the L5 installed/runtime gates.

### L5 — GUI and installed-app qualification

**Owner:** one Luna qualification worker for the Linux artifact harness and
receipts; primary agent owns final acceptance.

**GUI behavior required on native Ubuntu 24.04 x86_64 (X11 and Wayland):**

1. launch the exact AppImage candidate without a terminal or arbitrary shell
   environment;
2. create exactly one private companion on an ephemeral loopback port;
3. render the real dashboard and complete a synthetic-data refresh;
4. reload the renderer and keep the companion alive;
5. show/hide/toggle the real tray and reopen after window close;
6. reject a second instance and focus the existing primary window;
7. exercise Retry after a bounded companion failure;
8. quit through the real tray/main-process path and leave no descendant;
9. relaunch with expected state and credential retention; and
10. emit only fixed, content-free diagnostics.

The existing [`scripts/smoke-electron-linux.mjs`](../../scripts/smoke-electron-linux.mjs)
should remain the fast source smoke. Add a separate artifact/installed smoke
or an explicit artifact mode so a source checkout cannot accidentally satisfy
the installed-app gate. CDP is useful for renderer readiness and reload but
is not a substitute for tray or desktop-manager evidence.

**Exit criteria:**

- The full behavior list passes on both Ubuntu desktop protocols and the
  declared Debian baseline, with exact artifact digest and runner identity.
- The synthetic fixture root, D-Bus collection, autostart entry, child
  processes, sockets, and temporary AppImage extraction directory are gone at
  the end of each run.
- Diagnostics and receipts contain no user paths, account names, service
  names, D-Bus object paths, session content, credential values, or arbitrary
  child output.

### L6 — Upgrade, rollback, uninstall, and retention policy

**Owner:** primary agent with Luna test/audit pass; policy decisions require
the owner before implementation.

**Required policy:**

- An ordinary upgrade replaces only the application artifact and reviewed
  desktop/autostart entries. It preserves `$XDG_STATE_HOME/app-usagemonitor`,
  source configuration, and application-owned Secret Service capabilities.
- A failed N→N+1 update keeps the last known-good version selected and leaves
  user state untouched. The new version becomes current only after artifact
  verification and the full bounded launch smoke pass.
- Rollback is an explicit pointer/selection operation to the prior verified
  artifact, not an arbitrary executable path. Retain only the policy-approved
  number of prior artifacts and never delete the currently active one.
- Ordinary uninstall removes application files and the app-owned desktop and
  autostart entries but preserves user state and credentials. An explicit,
  separately confirmed purge may remove only the fixed application-owned
  capability tuples and state root after a content-free deletion receipt.
- No uninstall script may scan or delete a broad `$HOME`, generic keyring,
  arbitrary XDG directory, or another application's state.

**Exit criteria:**

- Fresh install, launch, N→N+1 upgrade, failed-update rollback, restart,
  ordinary uninstall, reinstall, and explicit purge all pass in disposable
  homes on the declared matrix.
- State and credentials survive ordinary upgrade/uninstall exactly as policy
  states; explicit purge is bounded and confirmed; no other keyring item or
  user directory is touched.
- The retention/rollback receipt binds each operation to the exact artifact
  digest and records only fixed status values.

### L7 — Protected Linux CI and release-readiness handoff

**Owner:** primary agent; Luna audit worker reviews workflow and evidence
boundaries.

**Work:**

- Add a manual or protected Linux x86_64 workflow on a pinned `ubuntu-24.04`
  runner with `contents: read`, immutable action revisions, exact source
  revision checking, locked Node/Corepack/pnpm versions, and warm/clean
  dependency-store jobs. Add a Debian Bookworm x86_64 container or VM job for
  the baseline; do not treat the existing arm64 Colima image as a replacement.
- Separate dependency-fetch/build from network-isolated verification. After
  installation, run GUI, credential, package, and lifecycle tests with no
  network access wherever the runner permits. Use `dbus-run-session`, an
  ephemeral Secret Service, Xvfb/status-notifier host, and headless Wayland
  only inside disposable test roots.
- Retain one content-free qualification receipt per matrix subject. It must
  include source revision, runner/image, Node/pnpm/Electron/builder versions,
  architecture, desktop protocol, artifact digest, native binding digest,
  pass/fail/skip counts, and exact fixed blocker codes. It must not include
  user paths, D-Bus paths, credentials, source content, or arbitrary logs.
- Keep publication, detached signature, repository upload, update feed, and
  website availability as later owner-authorized steps. A green CI job is not
  a release until final bytes and native Linux trust evidence are separately
  verified.

**Exit criteria:**

- Warm and clean Linux x86_64 runs pass the portable, credential, filesystem,
  GUI, package, installed lifecycle, and privacy gates on one exact revision.
- Debian and Ubuntu matrix results are independently visible; no expected
  skip hides a missing desktop or credential capability.
- The final unpublished receipt names every unmet external signing or
  distribution dependency. If one cannot be exercised, the Linux support
  claim remains closed and the blocker is recorded once rather than retried
  indefinitely.

## Executable environment commands

These commands distinguish what is executable today from commands that become
available after the corresponding Linux stages add their named scripts.

### macOS arm64: current source/shared-shell smoke

Colima is the local Linux container runtime. On Apple Silicon, its default
architecture is arm64; this is useful for the existing source smoke but does
not qualify the planned x86_64 artifact.

```bash
colima start --cpu 4 --memory 8 --disk 40
docker info --format 'server={{.ServerVersion}} os={{.OperatingSystem}} arch={{.Architecture}}'
pnpm install --frozen-lockfile
pnpm container:electron-linux:build
pnpm container:electron-linux:test
```

The image builder requires a clean Git tree and bakes `git rev-parse HEAD` into
the OCI revision label and smoke environment. Commit the reviewed task branch
before running these commands; do not relabel a dirty image as exact-revision
evidence.

The existing package scripts expand to a digest-pinned arm64 base plus
exact-version/frozen-lock build followed by
`docker run --rm --init --cap-add=SYS_ADMIN --network none`; no network or
state persists in the test container. APT indexes and online package/artifact
downloads are mutable and make this a restorable development environment, not
a byte-reproducible artifact. Stop the daemon when the local test window is
over if disk/memory pressure matters:

```bash
colima stop
```

### Native Linux x86_64: required next environment

The smoke deliberately verifies that only loopback interfaces exist. Running
it directly in an ordinary host network namespace therefore fails closed even
if an environment variable claims otherwise. The repository now exposes
separate digest-pinned AMD64 build, GUI-smoke, and credential commands plus the
manual `linux-portability.yml` workflow. That workflow asserts a native
`x86_64` host and Docker daemon before accepting evidence and labels every
receipt development-only. It has not run on this branch, so it is executable
scaffolding rather than native evidence. Apple-Silicon/QEMU results remain
debugging signals only and cannot satisfy the matrix.

### Native Linux: credential foundation and future desktop gates

Build the AMD64 development image, then run the credential helper only through
the reviewed networkless container command. The helper independently requires
the baked root-owned marker plus separate tmpfs home/runtime mount identities;
the environment marker is not isolation authority:

```bash
pnpm container:electron-linux:build:amd64
pnpm container:electron-linux:test:credentials:amd64
```

The X11/Wayland desktop commands remain future L3 interfaces:

```bash

dbus-run-session -- xvfb-run --auto-servernum \
  --server-args='-screen 0 1280x900x24 -nolisten tcp' \
  pnpm test:linux:desktop -- --protocol=x11

dbus-run-session -- weston --backend=headless-backend.so --socket=wayland-tibo \
  --idle-time=0 &
WAYLAND_DISPLAY=wayland-tibo \
  XDG_RUNTIME_DIR="$RUNNER_TEMP/tibotattle-linux-runtime" \
  pnpm test:linux:desktop -- --protocol=wayland
```

The desktop commands are required interfaces to add, not claims that those
scripts exist. The workflow must own compositor and keyring process cleanup
and fail if those processes survive. The native credential command is also
still unqualified until its warm and clean receipts exist.

### Future native Linux x86_64 package/lifecycle gate

Once L4–L6 implement the artifact harness, the authoritative shape is:

```bash
pnpm build:electron:linux:x64
pnpm verify:electron:linux:x64 --artifact <absolute-unpublished-appimage>
dbus-run-session -- xvfb-run --auto-servernum \
  --server-args='-screen 0 1280x900x24 -nolisten tcp' \
  pnpm smoke:electron:linux -- --artifact <absolute-unpublished-appimage> --protocol=x11
```

The package/lifecycle names above are planned command contracts. Until they are
implemented and their receipts are reviewed, only an actually executed
`container:electron-linux:*` source-container command may be reported, with its
architecture and development-only scope stated explicitly.

## Ownership and integration boundaries

- The primary agent owns stage ordering, shared-shell architecture, source
  revision selection, cross-platform evidence, workflow integration, branch
  hygiene, destructive cleanup, and every external publication/signing
  boundary.
- A Luna credential worker may modify only the Linux credential owner and its
  focused tests/fixtures. It may not edit the macOS Keychain module, Windows
  native adapter, production signing workflow, or package version.
- A Luna filesystem/state worker may modify only Linux/POSIX platform owners
  and their tests. It may not alter Windows readiness flags or bypass a
  Windows failure.
- A Luna desktop worker may modify Linux Electron desktop assets, tray/
  autostart integration, and desktop harness tests. It may not change the
  preload privilege boundary or native macOS lifecycle.
- A Luna packaging/CI worker may modify Linux builder/verifier files and a
  Linux workflow in an isolated branch. It may not publish an AppImage,
  create a repository, use a production signing key, or update the website.
- The primary agent integrates one worker pass at a time, runs the focused
  repair pass only for a named failure, then records an owner decision. No
  worker may loop on a failing platform by adding skips or changing the claim
  boundary.

## Final Linux readiness checklist

Linux remains closed until every required item below has authoritative
evidence on the declared matrix:

- [ ] x86_64 distribution and desktop/session matrix is explicit.
- [ ] Secret Service/libsecret binding, digest/provenance, capability map,
  lease, readback, conflict, lock, restart, and cleanup gates pass.
- [ ] State roots, XDG overrides, source roots, SQLite sidecars, leases,
  atomic replacement, ownership, mode, symlink, hard-link, and race gates pass.
- [ ] Real X11 and Wayland tray/window/single-instance/retry/quit behavior
  passes; limitations are declared rather than mocked away.
- [ ] XDG autostart is explicit opt-in, per-user, atomic, removable, and
  content-free.
- [ ] Native x86_64 AppImage closure, ELF architecture, icon/desktop metadata,
  binding, digest, and mutation checks pass.
- [ ] Installed launch, dashboard readiness, synthetic refresh, relaunch,
  clean quit, no orphan, and diagnostics gates pass.
- [ ] Upgrade, failed-update rollback, ordinary uninstall, reinstall, state/
  credential retention, and explicit purge gates pass.
- [ ] Warm/clean protected CI runs pass on one exact revision with no
  unexplained skips, and receipts are content-free.
- [ ] Native Linux signing/detached evidence and distribution controls are
  separately decided and verified before any publication claim.

Until then, the permitted statement is: “TiboTattle has a network-isolated
Linux Electron source smoke plus dormant Linux credential, XDG state/desktop,
and native-AMD64 CI foundations that are not wired into production.” The
prohibited statements are “TiboTattle supports Linux,” “the arm64 container or
an emulated AMD64 run qualifies Linux x86_64,” and “an unsigned or loose
AppImage is an official Linux release.”
