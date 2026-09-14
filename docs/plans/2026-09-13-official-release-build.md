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
protected release qualification. This checkpoint records unsigned build and
R7 evidence preparation through 2026-09-14; it does not qualify a production
installation, update or publication.

## Candidate identity and completed builds

- Marketing and shared contract package version: `0.1.23`.
- Both Mac architectures reserve stable `CFBundleVersion` `1030`, following
  `0.1.22` / `1029`. The
  [allocation decision](../decisions/2026-09-11-electron-macos-bundle-version-allocation.md)
  distinguishes bundle ordering from artifact provenance.
- Application source `1ca31a45753fae709cc30d6a91b599e96b0367ee` passed all six jobs
  in the [official development workflow](https://github.com/adamallcock/tibotattle/actions/runs/34801384672):
  Mac ARM, Mac Intel, Windows x64 and Linux x64 packages, Windows normal startup,
  and Windows NSIS installation, whole-app restart and uninstall.
- The same source passed all four
  [unsigned production-source jobs](https://github.com/adamallcock/tibotattle/actions/runs/34801385483)
  with build `2026091304`. Downloaded receipts and staged versions agree on the
  exact source, version, build and target set. This build is not an Apple bundle
  version and does not record signing or publication.
- The official Mac ARM DMG, ZIP, executable and extracted ASAR were independently
  checksum-verified. Native inspection with an isolated retained-data profile
  confirmed completed refresh, animated allowance overflow and the shared weekly
  pacing forecast. ASAR:
  `5c2968b13753fc2f199ac4e4addeedd195f0005b36da1b02a1668813578be980`.

## Source corrections and local validation

Windows qualification exposed fixture gaps in protected parents, source ownership
and task duration. The corrected fixtures preserve the native security assertions,
verify unchanged DACLs after ownership setup, isolate the PowerShell child module
environment and exercise the complete timing boundary. Darwin-only development
identity validation uses explicit POSIX semantics with invalid-path refusal tests.
The Worker copy-guard test includes the already-merged `reset-events.js`.

- Focused release/telemetry checks passed 50 tests; preflight passed 20; current
  synthetic admission passed 169 as `passed_not_reusable`; focused shell and
  credential checks passed 107. Worker package-copy guards, generated types and
  TypeScript checks pass.
- The broad root run passed 5,391 tests and skipped 48. Five files failed to load
  incomplete Worker dependencies; after the clean locked install, all 57 tests
  in those files passed. Its two remaining stale R7 provenance failures are
  resolved by the protected refresh below. This is focused follow-up evidence,
  not a claim that the entire root suite was rerun after receipt replacement.

## Authorized R7 refresh, 2026-09-14

The owner-approved [dual-runtime regeneration](../runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md)
completed in approximately 37 minutes with the exact pinned Node 24.14.0 and
26.2.0 binaries and the registered 31-day interval. The generator validated and
replaced all ten receipts, completed its journaled cleanup and emitted its final
success summary. Private history stayed local.

Both retained-data runs repeat deterministically within each runtime. The receipt
review preserves runtime identities, privacy and preservation fields, profile
names and decision states. Source/projection fingerprints, linked receipt hashes,
measurements and the retained input inventory were refreshed. Changed input
inventory and environment-sensitive measurements do not support attributing a
performance difference to this code change.

The two freshness/rebuild tests pass under Node 24.14.0. The focused Node 26.2.0
suite passes all 48 tests covering freshness, decision reconstruction, closed
schemas and regeneration recovery. Its native process-ownership tests require
process inspection outside the restricted execution sandbox.

R7 receipt freshness is separate from release approval: both decisions still
report `release_open`, all 19 resource ceilings remain unresolved, and supporting
receipts retain their existing `partial` outcomes. No promotion gate, assertion,
resource ceiling or receipt field was manually overridden.

The maintained normal Electron publication lane requires current receipt
provenance; it does not require changing this resource-ceiling decision to
`release_ready`. The generated-evidence tests explicitly retain `release_open`.
Native trust, installed behavior and publication remain separate release gates.

## Final installer qualification preparation, 2026-09-14

Commit `093b6248` removes historical candidate pins from Mac clean-install and
upgrade intake while retaining reviewed bundle allocations and exact native and
Electron predecessors. Windows retains its verified installed updater file
before uninstall. Linux binds the existing isolated runtime smoke to the final
AppImage's extracted application, preserving explicit launcher, physical desktop
and public-predecessor update limitations.

The focused Windows, Linux and Mac suites pass 25, 47 and 32 tests respectively;
release-trust checks pass 82. The full Worker suite passes 1,048 tests across 80
files. Its packaging dry run requires the final committed tree and remains to be
rerun after the freeze. The broad root run passes 5,461 tests, skips 48 and finds
two tool-inventory registration failures. The corrected canonical inventory and
all static callers now pass all six owning tests. A clean final-source rerun
remains part of the next gate. R7 freshness is unchanged by these tooling edits.

## Remaining release work

The owner authorized signing and public release on 2026-09-14, conditional on
readiness. Final production preparation uses provenance build `2026091401` and
the existing Mac allocation `1030`. The final notes and dated changelog are
prepared for the annotated `v0.1.23` source freeze.

1. Complete the broad source gates, freeze the exact annotated source tag and
   run the four final packaging/signing lanes. Signing
   preparation is private and does not itself exercise credentials or notarize.
2. Execute the new Mac clean-install and update journeys and the Windows/Linux
   final-package checks. Neither intake validation nor old receipts qualify the
   new signed bytes.
3. Review the resulting native trust and installed/update evidence before
   immutable publication, update feeds, Homebrew or website activation. Any
   remaining physical observations need an explicit, candidate-specific decision;
   preservation, credential protection and update integrity cannot be waived.

[Draft PR #140](https://github.com/adamallcock/tibotattle/pull/140) retains the
candidate and outstanding gates. Existing application packages remain bound to their recorded
`1ca31a45` source and cannot be relabeled as a later artifact build.

The consolidation exclusions remain those in the
[integration plan](./2026-09-13-release-integration.md): typed D1/sharding,
unfinished provider/credential experiments and the superseded inference UI do
not enter this candidate. Historical platform acceptances are not transferred
to new artifacts.
