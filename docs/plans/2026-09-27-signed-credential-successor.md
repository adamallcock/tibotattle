---
title: Signed client successor after Mac credential qualification
date: 2026-09-27
type: plan
status: in-progress
---

# Signed client successor

## Current boundary

The `v0.1.25` annotated source tag is frozen at
`fec5b6039ea9efbc7948f0785bb40240cd0748ea`. Mac arm64/x64, Windows x64,
and Linux x64 artifacts were built and staged from that source. There is no
public `v0.1.25` GitHub Release, stable feed activation, or website publication.
The owner declined release with the then-unqualified Mac credential test and
has not accepted the subsequently observed locked-Keychain misclassification.
Keep those exact artifacts and the tag unchanged while this hold applies.

The signed 0.1.25 ARM app preserved three synthetic modern Keychain items,
including values, item references, and ACLs, through installed replacement of
both [0.1.24](https://github.com/adamallcock/tibotattle/actions/runs/36336889828)
and [0.1.20](https://github.com/adamallcock/tibotattle/actions/runs/36337130831),
refresh, restarts, and sharing-setting checks. Invalid-credential Retry/Quit
also passed. The locked scenario failed: the app showed
`SECURE_STORAGE_DENIED` where the maintained test expects
`SECURE_STORAGE_LOCKED`. These are scoped ARM journeys, not complete credential
failure-matrix or release qualifications. The owner's accepted missing physical
Linux install evidence applies only to the exact 0.1.25 AppImage.

A separate local synthetic Keychain probe confirmed macOS returned
`errSecAuthFailed` for a locked item's secret read while a metadata-only query
could identify its owning Keychain. Commit `39a59190` uses that evidence to
classify a unique, in-scope locked modern item without a prompt or secret read.
It passed the macOS source gate and preflight. It is not in the sealed 0.1.25
artifacts and has no signed installed-app proof yet.

## Proposed release path

Prepare a new 0.1.26 source and artifact set, with a separately reviewed Mac
stable bundle allocation after 0.1.25's `1033`. This version choice and
allocation remain proposals until the owner responds. The local patch is
committed; automatic approval review rejected a GitHub branch push because
local file approval did not explicitly authorize a remote write. Remote push
and draft PR require explicit approval.

1. Review and merge the Keychain classification patch. Keep the signed
   credential runner separate from the product source; preserve exact
   predecessor and candidate artifact pins.
2. If 0.1.26 is selected, update root/workspace versions, telemetry schema and
   generated outputs, Mac allocation, release notes and changelog. Recheck R7
   receipt freshness through its protected workflow and run the source, Worker,
   architecture, contract, documentation and release gates.
3. Build, sign, notarize and verify new Mac arm64/x64 and Windows x64 artifacts;
   build and verify the Linux x64 AppImage. Bind each to one frozen source tag,
   build number, checksums and final receipts. The 0.1.25 proofs cannot be
   relabeled for the successor.
4. Run exact signed Mac clean-profile and installed-upgrade journeys, including
   the locked and invalid Keychain scenarios, on the replacement candidate.
   Qualify the separate Windows, Linux, native Sparkle, and Electron updater
   paths and record any unperformed physical or denial/cancellation evidence
   explicitly.
5. Only after the release manifest admits the new exact artifacts, reconcile
   the draft GitHub release, stable feeds, Homebrew and website in the order in
   the [cross-platform runbook](../runbooks/2026-08-18-cross-platform-release-publication.md)
   and [Mac runbook](../runbooks/macos-stable-release-runbook.md). Verify live
   downloads and production update behavior after activation.
