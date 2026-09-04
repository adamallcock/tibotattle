---
title: Release 0.1.18 RC2 local build proof
date: 2026-09-04
type: plan
status: complete
---

# Release 0.1.18 RC2 local build proof

The owner approved combined RC2 allocation `1025.1` and the protected,
local-only R7 regeneration against private histories. Work began from the
integrated release branch at `5ff2713a`. Preserve the earlier signed Intel build 1025 and
its source tag. Stable allocation 1026 remains unchanged.

The owner subsequently authorized the paginated export compatibility fix.
Implement the currently observed reset subset: paginated metadata must have an
absent/null physical history base and an explicit valid start ordinal zero.
Logical parent links do not imply inline replay. Preserve legacy inline-fork
semantics and add a physical, pseudonymous occurrence discriminator for
paginated generations while retaining logical session scope. Bind creation,
frozen-bundle verification and resume to the same semantics; reject old
workspace compatibility before mutation. Keep the existing source-plan and
parser-state schemas, with forward adapter/checkpoint-scan version changes.
Actual physical-prefix continuations remain explicitly unsupported; malformed
base metadata must never be normalized into a supported reset.

- [x] Implement reset acceptance, frozen metadata/ancestry validation, physical
  occurrence identity and forward compatibility fencing.
- [x] Prove direct/checkpoint parity, independent usage/tool counts, same-thread
  generation identity, true close/reopen, compressed sources, legacy forks,
  malformed input and unsupported physical-base refusals using synthetic data.
- [x] Freeze final reviewed source; regenerate full R7 evidence under the
  existing owner authorization, then rerun final root and architecture builds.
- [x] Update current status and retain exact final qualification evidence.

The implementation also fixes exact copied-tool replay in the direct scanner
and selects the explicit resolved parent rather than relying on physical-file
order. A frozen export keeps its digest-bound parent if the live selected head
changes. Verification authenticates source bytes and validates the committed
graph; mutable discovery hints are not historical selection proof. Focused
integration, ancestry and constrained-heap tests pass; the local synthetic
resource preflight passes 62/62.

Implementation is frozen at `b5fc39bf8e6976e7fbe96883bfe1ea33f7cea0bb`;
the complete source-and-receipt snapshot is
`ef2d26ac78e75d9c9a1245d539d3ffd8c8c3476b`. Full R7 regeneration completed
all ten validated receipts, with freshness and exact decision reconstruction
passing on both pinned runtimes. Optimized ARM and Intel development builds
pass all twelve isolated smokes. Final root validation has 3,815 passes, zero
failures and 17 Windows-only skips; the retained macOS suite passes 108/108
with no skips. The [final qualification review](../reviews/2026-09-04-paginated-export-qualification.md)
records source identities, exact artifact digests, aggregate evidence and
remaining release boundaries. This plan is complete for local qualification,
not signing or publication.

The earlier [build-proof review](../reviews/2026-09-04-release-0-1-18-rc2-build-proof.md)
remains historical: its source `e0f35518` passed development artifact checks
but refused paginated history and retained two stale-R7 failures. That attempt
changed no receipts. The subsequent approved reset implementation and complete
fresh evidence supersede the blocker; prior artifacts do not qualify new code.

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
