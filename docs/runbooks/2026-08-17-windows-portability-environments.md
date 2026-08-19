---
title: Windows portability qualification environments
date: 2026-08-18
type: runbook
status: qualified-and-restorable
---

# Windows portability qualification environments

This runbook restores the four-day Windows-readiness test environments. It is
not a Windows installation or release runbook. All commands use synthetic
fixtures; none should be pointed at a real Codex or Claude home.

## Recorded environment

| Lane | Recorded implementation |
|---|---|
| macOS host | macOS 26.5.2 arm64, Node v26.2.0, pnpm 11.9.0 |
| Linux | Colima/Docker arm64; `node:26.2.0-bookworm-slim` pinned by OCI digest; Corepack 0.34.0; pnpm 11.9.0 |
| Native Windows | Microsoft Windows Server 2025 x64; runner image `windows-2025-vs2026` version `20260810.198.2`; Node 26.2.0; Corepack 0.34.0; pnpm 11.9.0 |
| Local Windows development | UTM 4.7.5 installed at `/Applications/UTM.app`; no Windows guest installed |

The Linux lane is useful portability evidence but cannot establish Windows
filesystem, process, ACL, or Credential Manager behavior. The GitHub-hosted
Windows x64 lane is authoritative for this milestone.

## macOS host lane

From a clean or isolated checkout:

```bash
pnpm install --frozen-lockfile
pnpm test:portable
pnpm test:macos:source
```

The portable command runs only files listed in
[`scripts/portable-test-manifest.mjs`](../../scripts/portable-test-manifest.mjs).
Changing scope requires review of the manifest and the Windows compatibility
ledger.

## Linux container lane

Build the image and run it without network access:

```bash
pnpm container:portable:build
pnpm container:portable:test
```

The build requires network access to retrieve the pinned base image and locked
dependencies. The test container runs with `--network none` and `--init`.
`--init` supplies normal container process reaping; the companion's own
watchdog must still terminate it after its configured parent disappears.

To recover the environment, reinstall Docker Desktop or Colima, start the
daemon, and rerun the two commands. The Dockerfile is the environment
definition; no long-lived container state is required.

### Linux Electron GUI smoke

Build the pinned Debian-based Electron image, then run the GUI smoke with no
network access:

```bash
pnpm container:electron-linux:build
pnpm container:electron-linux:test
```

The image uses Debian Bookworm arm64, Node 26.2.0, pnpm 11.9.0, Electron
43.2.0, and Xvfb with TCP listening disabled. The build needs network access
for the pinned base image, locked dependencies, and Electron runtime; the
test command uses `--network none`, `--init`, and synthetic disposable
`HOME`, `CODEX_HOME`, Claude configuration, and state directories. The
package script also supplies `--cap-add=SYS_ADMIN`, a disposable test-only
allowance needed by Chromium's sandbox namespace under the default Colima
seccomp profile; it does not grant the image network access or persist any
state.

The smoke proves source Electron on Linux can launch the real dashboard and
companion, observe the loopback health endpoint, reload the renderer, and
invoke the exact gated main-process `requestQuit()` path via `SIGUSR2`, ending
with Electron exit code 0 and no remaining companion descendant. It is
development smoke evidence only. It does not qualify a Linux package,
installer, signer, updater, credential backend, desktop-manager integration,
cross-distro behavior, or Windows filesystem/ACL/Credential Manager/SQLite
support. Never point this lane at a real user home or credential store.

## Native Windows x64 lane

The workflow is manual-only so an unreviewed branch cannot consume runner time
or become support evidence automatically. One dispatch runs the fixed warm and
clean dependency-store matrix against the same exact revision:

```bash
gh workflow run windows-portability.yml \
  --repo adamallcock/tibotattle \
  --ref codex/windows-security-credentials
```

For each run, preserve the run URL, commit SHA, `ImageOS`, `ImageVersion`,
architecture, Node and pnpm versions, test counts, skips, binding SHA-256, and
credential cleanup result. Any failure or unexplained skip keeps the milestone
open. The clean matrix job intentionally skips only the pnpm store cache; the
hosted runner itself is still a Microsoft-provided runner image.

The latest completed qualification is
[run 32085366833](https://github.com/adamallcock/tibotattle/actions/runs/32085366833):
restored/primed-store job `95556686783` and clean-store job `95556687033` both
passed on revision `b8811349b5b38df0319684ebc0b4377f9d404c94`.

## Local UTM lane

UTM 4.7.5 and `utmctl` are installed. A guest was deliberately not downloaded:
the host had about 31 GiB free after UTM installation, and the milestone does
not authorize buying Windows or consuming that remaining disk with an
unreviewed VM image.

If interactive local Windows debugging is later required:

1. Free and verify sufficient host disk space.
2. Obtain Windows 11 ARM installation media and any required activation through
   an authorized Microsoft route.
3. Create a UTM Apple Virtualization Windows 11 ARM guest and install the UTM
   guest tools.
4. Record the UTM version, guest Windows build, architecture, virtualization
   backend, Node and pnpm versions, and whether any x64 component is emulated.
5. Use only a synthetic repository checkout and disposable credentials.

This guest is a developer convenience. Windows-on-ARM or x64 emulation does
not satisfy the native Windows x64 acceptance gate.

## Cleanup and restoration

- Portable tests create temporary directories under the host or guest temp
  root and assert their removal.
- The Credential Manager probe uses a random service/account pair and confirms
  deletion before reporting success.
- Containers are removed automatically by `docker run --rm`.
- UTM can be removed later with `brew uninstall --cask utm`, but removal is not
  part of this milestone and may leave separately created guests intact.
- Do not delete the task worktree or branch until the receipt is reviewed and
  the maintainer decides whether to integrate the change.
