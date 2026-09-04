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
- [ ] Freeze final reviewed source; regenerate full R7 evidence under the
  existing owner authorization, then rerun final root and architecture builds.
- [ ] Update current status and retain exact final qualification evidence.

The implementation also fixes exact copied-tool replay in the direct scanner
and selects the explicit resolved parent rather than relying on physical-file
order. A frozen export keeps its digest-bound parent if the live selected head
changes. Verification authenticates source bytes and validates the committed
graph; mutable discovery hints are not historical selection proof. Focused
integration, ancestry and constrained-heap tests pass; the local synthetic
resource preflight passes 62/62. Full R7 and final artifact proof remain pending.

The checklist below records the earlier build-proof attempt and its remaining
R7 work; prior artifact passes do not qualify the newly changed source.

- [x] Allocate RC2 and prove `1025 < 1025.1 < 1026`; update current build guidance.
- [x] Freeze the reviewed workload source in local commit `e0f35518`. Verify exact
  pinned runtimes and safe receipt destinations before generation.
- [ ] Regenerate all ten R7 receipts using the preregistered interval and
  owner-authorized private inputs. Do not edit workload code or run competing
  heavy builds while measurement is active. Inspect full exit and summary.
  **Blocked:** the full-workflow attempt passed all six runtime profiles but
  refused the real-history source plan with
  `export_source_codex_rollout_checkpoint_history_unsupported`. The selected
  corpus genuinely uses paginated history. No generated receipt changed, and
  transaction controls were cleaned up. Do not filter sources or bypass the
  guard; resumable export support needs a separate design and implementation
  decision (full ordinal-aware support versus a rigorously proved no-base
  reset subset).
- [ ] Validate the complete receipts under both pinned runtimes, including
  deterministic comparisons, privacy flags, preservation and decision states.
  No new complete set exists. Both runtime validators retain the two genuine
  source-provenance failures; all ten old receipts remain byte-identical.
- [x] Build and inspect both architecture artifacts; run the retained native
  gate, isolated lifecycle checks and the broad root suite on final source.
- [x] Record exact source, artifact digests, test results and remaining gates;
  commit local evidence after review.

The [build-proof review](../reviews/2026-09-04-release-0-1-18-rc2-build-proof.md)
records two optimized development artifacts, twelve isolated smoke passes,
108/108 retained macOS tests and the final root result (3,772 passes, two
stale-R7 failures, seventeen Windows-only skips). The approved reset design is
now implemented; this plan remains open for fresh R7 evidence and requalification
of the changed source, not signing or publication.

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
