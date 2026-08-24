---
title: Windows portability qualification environments
date: 2026-08-17
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
| Native Windows plus WSL2 | Manual canary definition: `windows-2025`, disposable `Ubuntu-24.04` WSL2 installed by pinned `Vampire/setup-wsl` v7.0.0; no completed run is recorded yet |
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

### Opt-in Windows plus WSL2 multi-root canary

The same manual workflow contains a separate, default-off WSL2 job. Dispatch
it only for a reviewed immutable revision and opt in explicitly. The harness
also fails closed anywhere except a GitHub-hosted native Windows x64 runner, so
its destructive cleanup cannot unregister a local or self-hosted distribution:

```bash
gh workflow run windows-portability.yml \
  --repo adamallcock/tibotattle \
  --ref <reviewed-branch-or-sha> \
  -f wsl2_multi_root=true
```

The job installs locked workspace dependencies and a disposable
`Ubuntu-24.04` WSL2 distribution. Its synthetic fixture combines a Windows
primary `.codex` root with the explicit
`\\wsl$\Ubuntu-24.04\root\.codex` activity root. It verifies combined history,
the primary-versus-activity split, stopped-distribution partial coverage and
last-known-good retention, path-free public output, and recovery without
duplicate events or physical-owner rebinding. Every command and refresh has a
bounded timeout; the distribution is unregistered in an `always()` cleanup
step.

The legacy `\\wsl$` share is intentional for this canary. It must be absent
while the distribution is stopped; the job checks that the refresh does not
wake it. `\\wsl.localhost` is not used because its Windows 11 behavior cannot
establish the no-auto-start condition. A runner that activates the distribution
when the scanner touches `\\wsl$` fails qualification rather than masking the
behavior.

No WSL run receipt exists at the time of this edit. Passing this job would
qualify only the synthetic multi-root lifecycle on that exact runner and
revision. It would not qualify an installed Windows folder picker, Codex-root
DACL policy, reparse-point race safety, long-path behavior, signing, installer,
updater, or production Windows support.

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
- The opt-in WSL2 canary deletes its synthetic Windows state and always runs
  `wsl --unregister Ubuntu-24.04`; never point that job at a persistent or
  user-owned distribution.
- Containers are removed automatically by `docker run --rm`.
- UTM can be removed later with `brew uninstall --cask utm`, but removal is not
  part of this milestone and may leave separately created guests intact.
- Do not delete the task worktree or branch until the receipt is reviewed and
  the maintainer decides whether to integrate the change.
