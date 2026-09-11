---
title: Platform support and qualification
date: 2026-09-07
type: reference
status: maintained
---

# Platform support and qualification

This is the authority for public operating-system support claims. It defines
what must be proven before a platform moves from source work to supported use.
Electron 0.1.21 is released for macOS 14+ on Apple silicon and Intel, Windows
x64, and Linux x86_64. The [current status matrix](../current-status.md) records
the exact release, artifact identities, production updater results and retained
acceptance limits. Public installers, feeds, website and Homebrew are separate
verified surfaces; their publication does not turn an owner-accepted desktop
check into an executed test.

## Status matrix

| Platform | Source and contract | Native/physical qualification | Install, trust, update, release | Public status |
|---|---|---|---|---|
| macOS 14+ arm64 | Released Electron shell and native migration bridge | Exact signed installed-app and retained-data checks passed | Stable 0.1.21 / 1028 signed and notarized; native 0.1.18 and Electron 0.1.20 production updates passed | **Supported** |
| macOS 14+ x86_64 | Separate thin Intel Electron artifact and migration bridge | Exact native hosted Intel installed-app checks passed; physical Intel acceptance is owner-supplied | Stable 0.1.21 / 1028 signed and notarized; native 0.1.18 and Electron 0.1.20 production updates passed independently | **Supported with recorded owner acceptance** |
| Windows x64 | Released Electron shell and native filesystem/credential adapter | Signed 0.1.21 installed processing passed; retain the exact credential and lifecycle receipt boundaries | Signed, timestamped NSIS installer and Electron feed published; update replacement and notification appearance remain owner acceptance | **Supported with recorded owner acceptance** |
| Linux x86_64 | Released Electron AppImage and Secret Service credential composition | 0.1.21 packaging passed; prior packaged startup, credential and cold-restart evidence retained; desktop acceptance is owner-supplied | AppImage, checksums and Electron feed published; physical desktop/update behavior is not promoted to executed proof | **Supported with recorded owner acceptance** |

## Evidence ladder

A platform support claim requires every applicable gate below. Evidence at one
level never substitutes for a later level. Any release-specific owner acceptance
must name the unperformed observation in the current status record; it is not a
passing test or a standing exception. The historical
[0.1.18 waiver](../decisions/2026-09-05-release-0-1-18-manual-qualification-waiver.md)
remains limited to that release.

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
The legacy native Apple silicon builder accepts an explicit Intel runtime and target.
Packaging and update contracts identify Intel independently; every artifact must
pass its own native trust and update gates. The website's separate macOS
Intel tab now resolves the validated 0.1.21 Intel artifact. Source implementation
alone does not establish a supported download. See the
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
This historical unsigned receipt is not the qualification for the signed 0.1.21 installer.

The released 0.1.21 NSIS installer is signed and timestamped, and installed
processing passed on Windows x64. The native security adapter remains
fail-closed. Update replacement and notification appearance retain the owner's
acceptance boundary; do not infer either from packaging or a synthetic
credential fixture. See [current status](../current-status.md) for the exact
signed release and installed receipts.

## Linux

Linux container checks validate only the contracts they execute. On 2026-09-09,
source `dcf2d6ca` passed the real packaged normal-app journey with isolated
Secret Service, unavailable-service handling, a cold process restart retaining
settings and opt-out, and owned-session cleanup in
[run 34337369739](https://github.com/adamallcock/tibotattle/actions/runs/34337369739).
That proves the named container journey; it does not establish a user's desktop
session, distribution trust, tray/notification/login integration, upgrade or
uninstall. The released 0.1.21 x86_64 AppImage passed packaging and uses the
recorded owner acceptance for desktop behavior; that acceptance does not turn
this earlier container receipt into a physical desktop or production update
test. See [current status](../current-status.md) for the exact artifact and
remaining limits. ARM64 Linux remains an independent, unreleased matrix entry.

## Maintenance rule

Never use a plan, open pull request, source directory, simulated test, one-off
screenshot, or stale receipt as a support claim. When evidence expires or a
platform lane is retired, narrow the claim and git-remove obsolete instructions
in the same change. Git history is the archive.
