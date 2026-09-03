---
title: Platform support and qualification
date: 2026-08-27
type: reference
status: maintained
---

# Platform support and qualification

This is the authority for public operating-system support claims. It defines
what must be proven before a platform moves from source work to supported use.
The current result is intentionally narrow: macOS 14+ on Apple silicon is
supported; Intel macOS, Windows and Linux are not.

## Status matrix

| Platform | Source and contract | Native/physical qualification | Install, trust, update, release | Public status |
|---|---|---|---|---|
| macOS 14+ arm64 | Implemented | Native macOS product and retained qualification paths | Developer ID, notarization, Sparkle, stable DMG, and public `v0.1.16` release paths exist | **Supported** |
| macOS 14+ x86_64 | Experimental development/test builder and native broker selection | Cross-compilation and synthetic Rosetta probes; no physical Intel qualification | Development app only; no qualified Intel installer, signing/notarization receipt, or update feed | **Unsupported** |
| Windows x64 | Portable core and fail-closed native filesystem/credential adapter exist | Partial qualification evidence; not a standing release gate | No supported signed installer, clean install/upgrade/uninstall receipt, updater, or stable artifact | **Unsupported** |
| Linux x86_64 | Portable/core and container checks may run | Contract or container results are not physical desktop qualification | No supported signed package/repository, clean install/uninstall receipt, updater boundary, or stable artifact | **Unsupported** |

“Unsupported” is not “known broken.” It means the repository does not hold the
complete, current evidence required to ask users to rely on that platform.

## Evidence ladder

A platform support claim requires every applicable gate below. Evidence at one
level never substitutes for a later level.

1. **Source contract:** platform selectors, filesystem and credential rules,
   local-only networking, schemas, and negative behavior are explicit.
2. **Automated compatibility:** shared and platform-specific tests pass in the
   intended toolchain without bypasses.
3. **Native runtime:** the real application runs on physical or equivalently
   authoritative native hardware/OS; a browser or container is insufficient.
4. **Lifecycle:** clean install, first launch, upgrade with retained local data,
   relaunch, repair, uninstall, and documented residual-data behavior pass.
5. **Trust:** the final bytes use the platform’s native signing, timestamp,
   notarization/store/repository, and verification controls.
6. **Update:** the exact installed artifact follows a defined, tested update or
   explicitly no-update contract without weakening integrity.
7. **Publication:** immutable final bytes, checksums, manifest/evidence, user
   guidance, rollback boundary, and a public release channel agree.
8. **Support declaration:** README, website, release notes, issue templates,
   current status, and this matrix are updated in the same reviewed change.

## macOS

The supported public lane is macOS 14 or later on Apple silicon. The current
stable artifact is identified in [current-status.md](../current-status.md).
Follow the [canonical macOS release runbook](../runbooks/macos-stable-release-runbook.md)
and [cross-platform publication contract](../runbooks/2026-08-18-cross-platform-release-publication.md)
for a new release. A locally launched source build, unsigned development DMG,
or browser-rendered dashboard does not extend the support claim.

Intel macOS is not claimed. Adding it requires a separately identified final
artifact and the full ladder above; Rosetta behavior alone is not qualification.
The builder has an experimental, updater-disabled Intel development/test target
on the pinned Apple Silicon host. The website exposes a separate macOS Intel
tab with an unavailable state; neither is a supported download. See the
[native developer build](../../apps/macos/README.md#developer-build) and
[Intel release plan](../plans/2026-09-03-macos-intel-release.md).

## Windows

The Windows native security adapter is deliberately fail-closed and remains a
readiness component. Source-level portability, a local Electron run, or an alpha
artifact may inform development but does not create a supported product. Before
changing the status, select one installer/package, qualify it on native Windows
x64, sign and timestamp final nested and outer subjects, prove upgrade/uninstall
and local-data behavior, define updates, publish immutable evidence, and repeat
the public-document sweep.

## Linux

Linux container checks validate only the contracts they execute. They do not
prove a graphical desktop, native key storage, packaging, signing, distribution
repository, desktop integration, upgrade, or uninstall. Before changing the
status, qualify a selected native x86_64 artifact and distribution path on a
physical Linux desktop, then satisfy the complete evidence ladder. ARM64 Linux
is a later, independent matrix entry.

## Maintenance rule

Never use a plan, open pull request, source directory, simulated test, one-off
screenshot, or stale receipt as a support claim. When evidence expires or a
platform lane is retired, narrow the claim and git-remove obsolete instructions
in the same change. Git history is the archive.
