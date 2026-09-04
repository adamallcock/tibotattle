---
title: Release 0.1.18 RC2 local build proof
date: 2026-09-04
type: plan
status: in-progress
---

# Release 0.1.18 RC2 local build proof

The owner approved combined RC2 allocation `1025.1` and the protected,
local-only R7 regeneration against private histories. Start from the integrated
release branch at `5ff2713a`. Preserve the earlier signed Intel build 1025 and
its source tag. Stable allocation 1026 remains unchanged.

- [x] Allocate RC2 and prove `1025 < 1025.1 < 1026`; update current build guidance.
- [ ] Freeze the reviewed workload source in a local commit. Verify exact
  pinned runtimes and safe receipt destinations before generation.
- [ ] Regenerate all ten R7 receipts using the preregistered interval and
  owner-authorized private inputs. Do not edit workload code or run competing
  heavy builds while measurement is active. Inspect full exit and summary.
- [ ] Validate the complete receipts under both pinned runtimes, including
  deterministic comparisons, privacy flags, preservation and decision states.
- [ ] Build and inspect both architecture artifacts; run the retained native
  gate, isolated lifecycle checks and the broad root suite on final source.
- [ ] Record exact source, artifact digests, test results and remaining gates;
  commit local evidence after review.

Use the [R7 runbook](../runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md)
and [macOS release runbook](../runbooks/macos-stable-release-runbook.md).
Raw histories stay local and never become fixtures or committed output.
Only generated, closed aggregate receipts are candidates for Git.

This turn does not authorize production signing, Apple notarization, system
installation, real Keychain mutation, hosted writes, tag creation, publication,
or supported physical Intel claims. Existing `release_open` export-ceiling
decisions are not generic macOS release blockers; preserve their semantics.

The owner-supplied Intel handoff confirms the complete Intel implementation is
already integrated. Its historical build-1025 notes remain unchanged. A new
annotated RC2 source tag will be needed on the final clean combined source
before a signed candidate can be prepared; local build proof does not substitute
for that source-freeze gate. No physical Intel feedback or confirmed tester
upload result is available.
