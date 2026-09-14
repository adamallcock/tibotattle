---
title: Official 0.1.23 release build preparation
date: 2026-09-13
type: plan
status: qualification-in-progress
---

# Official 0.1.23 release build preparation

Prepare the successor to published 0.1.22 from consolidation PR #139, merged as
`a1e7c9f82e37c5d99a48e1117139b6b623833441`. The maintained process is the
[Electron publication runbook](../runbooks/2026-08-18-cross-platform-release-publication.md#normal-electron-stable-feed-preparation),
with [early admission](../runbooks/release-qualification-admission.md) before
protected release qualification. This plan records source and build preparation;
it is not an installed-update or publication receipt.

## Candidate identity

- Marketing and shared contract package version: `0.1.23`.
- Both Mac architectures reserve stable `CFBundleVersion` `1030`, following
  `0.1.22` / `1029`. The
  [existing allocation decision](../decisions/2026-09-11-electron-macos-bundle-version-allocation.md)
  still governs the distinction between bundle ordering and artifact provenance.
- Proposed source-preparation build number: `2026091301`, shared across all four
  targets. It is not an Apple bundle version or evidence of publication.
- Freeze the exact clean candidate commit before source preparation. Keep draft
  release notes under Unreleased until final source/tag preparation.

## Verified starting point

- Merged-main synthetic admission passed 169 tests. Its changed executable
  profile is reported as `passed_not_reusable`; the result cannot be reused as
  a reviewed cache receipt.
- Local merged-main packaging passed 92 contract tests, with two existing
  unavailable-environment skips. The official development packager produced a
  verified Mac ARM app, DMG and ZIP. The app ASAR is
  `15ea3eeddbf36f8692240bcf34c2e11b50c4619eb22ec505497ff31534ca49d2`.
- Native inspection with an isolated retained-data profile showed the allowance
  tanks, narrow five-hour tank, shared pacing forecast and removed observation
  labels. Forecast evidence was available; the history refresh was still running.
- [Official merged-main workflow](https://github.com/adamallcock/tibotattle/actions/runs/34798756100)
  passed Mac ARM, Mac Intel and Linux development packaging, plus the Windows
  normal app journey. Windows packaging failed two native fixture checks and
  therefore did not run its dependent NSIS installed lifecycle.
- The candidate corrects only those Windows fixtures: the audit guard receives
  its required two protected parents, and synthetic source files receive explicit
  current-user ownership with unchanged DACLs. Native security policy is unchanged.

## Remaining sequence

1. Verify synchronized versions, regenerated telemetry contracts, documentation,
   package consumers and the Windows fixture changes; commit the clean candidate.
2. Run the official four-target development qualification and unsigned production
   source preparation against that exact candidate. Retain target receipts and
   actual native results; Mac portable tests cannot qualify Windows behavior.
3. Refresh protected R7 receipts through the maintained dual-runtime process after
   source closure is settled. Existing source-provenance failures remain failures.
4. Prepare successor-specific Mac qualification intake. The current empty-profile
   runner binds 0.1.21, update/transition validators bind 0.1.22/1029, and the
   production canary retains older exact bytes. These cannot qualify 0.1.23 as-is.
5. Complete separately authorized platform signing/finalization and exact
   installed/update qualification before the four-target publication proposal,
   immutable release, update feeds, Homebrew or website activation.

The consolidation exclusions remain those in the
[integration plan](./2026-09-13-release-integration.md): typed D1/sharding,
unfinished provider/credential experiments and the superseded inference UI do
not enter this candidate. Historical receipts and platform acceptances are not
transferred to new artifacts.
