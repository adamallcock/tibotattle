---
title: Platform support and qualification
date: 2026-09-07
type: reference
status: maintained
---

# Platform support and qualification

This is the authority for public operating-system support claims. It defines
what must be proven before a platform moves from source work to supported use.
macOS 14+ on Apple silicon and Intel is supported through the published 0.1.18
release. Intel support is covered by the narrow, owner-approved
[manual-qualification waiver](../decisions/2026-09-05-release-0-1-18-manual-qualification-waiver.md).
This support declaration does not assert that the missing physical/manual
tests passed. Windows and Linux remain unsupported; Electron is not a released
desktop surface.

The Electron source review and its unsigned development packages are a separate
development track. They do not qualify Electron on macOS, Windows or Linux, do
not extend this native macOS declaration, and do not activate accountless
enrollment or contribution.

## Status matrix

| Platform | Source and contract | Native/physical qualification | Install, trust, update, release | Public status |
|---|---|---|---|---|
| macOS 14+ arm64 | Implemented | Native macOS product and retained qualification paths; 0.1.18 disposable-profile/manual matrix explicitly waived, not passed | Stable 0.1.18 / 1026 published with exact final native trust, installed refresh/restart, signed update feed and public-delivery checks | **Supported** |
| macOS 14+ x86_64 | Explicit thin Intel build, native broker, packaging and isolated updater contracts | Cross-compilation and Rosetta checks; formal physical Intel/manual matrix explicitly waived for 0.1.18, not passed | Stable 0.1.18 / 1026 published with its own final native trust, independent signed update feed and public-delivery checks | **Supported under the release-specific waiver** |
| Windows x64 | Portable core and fail-closed native filesystem/credential adapter exist | Packaged normal startup, refresh, persisted settings and opt-out pass on native Windows CI; synthetic Credential Manager and unsigned NSIS lifecycle evidence is retained | Unsigned installer qualification exists; signed production installer, retained-data upgrade, updater and stable release remain open | **Unsupported** |
| Linux x86_64 | Portable/core and packaged native credential checks pass; an exact stable Linux/x64 source candidate may select the fixed credential composition, with mixed qualification/test lanes refused | Packaged startup, cold process restart with persisted settings/opt-out, disposable Secret Service and cleanup pass in Ubuntu container CI; physical desktop qualification remains open | No supported signed package/repository, clean install/uninstall receipt, updater boundary, or stable artifact | **Unsupported** |

“Unsupported” is not “known broken.” It means the repository does not hold the
complete, current evidence required to ask users to rely on that platform.

## Evidence ladder

A platform support claim requires every applicable gate below. Evidence at one
level never substitutes for a later level. The documented 0.1.18 exception
accepts only the absent manual/physical observations named in that release's
waiver. It is not a passing result or a standing exception to this ladder.

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

The public macOS lanes are Apple silicon and, from 0.1.18 publication, Intel,
both requiring macOS 14 or later. The current published stable artifacts are
identified in [current-status.md](../current-status.md); a planned publication
or source tag is not proof that an installer is available.
Follow the [canonical macOS release runbook](../runbooks/macos-stable-release-runbook.md)
and [cross-platform publication contract](../runbooks/2026-08-18-cross-platform-release-publication.md)
for a new release. A locally launched source build, unsigned development DMG,
or browser-rendered dashboard does not extend the support claim.

Intel's first release has separately identified final bytes and an independent
update feed. The owner accepted the unavailable physical Intel and formal
manual matrix for 0.1.18 only, with user-reported tester success explicitly
unverified by a retained receipt. Rosetta behavior alone is not qualification.
The pinned Apple silicon builder accepts an explicit Intel runtime and target.
Packaging and update contracts identify Intel independently; every artifact must
pass its own native trust and update gates. The website has a separate macOS
Intel tab that remains unavailable unless validated Intel release evidence is
supplied. Source implementation does not establish a supported download. See the
[native developer build](../../apps/macos/README.md#developer-build) and
[Intel release plan](../plans/2026-09-03-macos-intel-release.md).
The [signed combined RC3 candidates](../receipts/2026-09-04-macos-combined-rc3-signed-candidates.md)
record private artifact qualification, not final stable publication. The waiver
does not authorize relabeling those candidates as stable, fabricating a v2
manual receipt, ignoring data-loss or integrity failures, weakening native
signing/updater checks, or approving unexpected automatic Keychain prompts.
Future releases must apply their normal gates unless separately decided.

From 2026-09-07, the first-party Homebrew cask selects the matching Apple silicon
or Intel DMG with independent checksums. Both native hosted Mac lanes passed
[cask audit, installation, trust checks and uninstall](https://github.com/adamallcock/homebrew-tap/actions/runs/34141158444).
These distribution checks do not replace the waived 0.1.18 interactive runtime,
physical Intel, update or upload observations. See the
[Homebrew distribution contract](../decisions/2026-08-15-homebrew-distribution-and-macos-support.md).

## Windows

On 2026-09-09, source `dcf2d6ca` passed normal packaged UI/refresh/settings and
opt-out persistence, plus an unsigned NSIS install/two-launch/uninstall journey
in [run 34337369739](https://github.com/adamallcock/tibotattle/actions/runs/34337369739).
The installer receipt confirms a synthetic observation credential was read
across the two launches. It explicitly does not establish existing application
credential continuity or exhaustive descendant ownership after process exit.
Native signing, retained-data upgrade and desktop integration remain open.

The Windows native security adapter is deliberately fail-closed and remains a
readiness component. Source-level portability, a local Electron run, or an alpha
artifact may inform development but does not create a supported product. Before
changing the status, select one installer/package, qualify it on native Windows
x64, sign and timestamp final nested and outer subjects, prove upgrade/uninstall
and local-data behavior, define updates, publish immutable evidence, and repeat
the public-document sweep.

## Linux

Linux container checks validate only the contracts they execute. On 2026-09-09,
source `dcf2d6ca` passed the real packaged normal-app journey with isolated
Secret Service, unavailable-service handling, a cold process restart retaining
settings and opt-out, and owned-session cleanup in
[run 34337369739](https://github.com/adamallcock/tibotattle/actions/runs/34337369739).
That proves the named container journey; it does not establish a user's desktop
session, distribution trust, tray/notification/login integration, upgrade or
uninstall. Before changing support status, qualify the selected x86_64 artifact
and distribution path on a physical Linux desktop and satisfy the complete
evidence ladder. ARM64 Linux remains an independent matrix entry.

## Maintenance rule

Never use a plan, open pull request, source directory, simulated test, one-off
screenshot, or stale receipt as a support claim. When evidence expires or a
platform lane is retired, narrow the claim and git-remove obsolete instructions
in the same change. Git history is the archive.
