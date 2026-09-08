---
title: Agent release tooling implementation and follow-on plans
date: 2026-09-08
type: plan
status: recommendations-1-3-implemented
---

# Scope

Implement recommendations 1–3 from the
[investigation](../research/2026-09-08-agent-release-process-improvements.md):
read-only doctor/status, shared deployment protection and resumable native
finalization. Plan, but do not implement, recommendations 4–5. This work does
not authorize signing, notarization, production writes or publication.

## Implementation boundary

- Use one isolated source branch and preserve existing release checks.
- Doctor/status performs no writes, installs, credential access or implicit
  remote calls. Unknown/manual/remote proof remains explicitly unverified.
- Deployment ownership uses one remote Git reference with atomic expected-value
  updates, not a machine-local or expiring lock. Interrupted mutation keeps
  ownership until explicit reconciliation. Every supported production caller
  must participate and supply its reviewed predecessor source.
- Native resume uses private durable phase receipts, exact input/output hashes,
  an OS-released local mutex and existing artifact validators. Unknown Apple
  submission outcomes must never cause blind resubmission.
- Validate synthetic interruption, competing ownership, stale source, tampering,
  no-op inspection, and final-file/manifest recovery before broad owning gates.

## Progress

- [x] Read scoped guidance and identify supported entrypoints.
- [x] Implement doctor/status and tests.
- [x] Implement shared deployment coordination, outcomes and recovery tests.
- [x] Implement native phase resume and tests.
- [x] Update maintained operational documentation.
- [x] Write reviewable plans for recommendations 4–5.
- [x] Run owning checks and review the integrated diff.

Recommendations 1–3 are implemented locally; no external publication occurred.
The [validation record](../reviews/2026-09-08-agent-release-tooling-validation.md)
separates passing recovery/native/Worker checks from the pre-existing R7
receipt mismatch. Recommendations 4–5 below remain planned, retaining this
document as their implementation boundary.

## Follow-on 4: publication reconciliation

Planned only. Build a manifest-driven, read-only-default reconciler for GitHub,
both Sparkle feeds, tap and website. Reuse the existing updater CAS publisher,
public provenance and architecture-aware cask updater. Bind state to source,
tag object, channel, build and final artifact digests; keep publication authority
separate from the record. Verify draft bytes before immutable publication and
public bytes afterward. Partial success is explicit, complete reruns write
nothing, and same-version/different-byte conflicts stop. Acceptance includes
lost publish responses, one-feed failure, stale Intel metadata, conflicting
owners and old cached website assets. Depends on the operation/status and
ownership contracts implemented here; no new signing implementation.

## Follow-on 5: earlier qualification and evidence reuse

Planned only. Add bounded source-format and predecessor-upgrade admission
before expensive R7 and signing. Rehearse migrations from the actual deployed
prefix using synthetic populated data with realistic cardinality/skew, remote
syntax checks in a separately approved disposable environment, preservation
assertions and resource ceilings. Cache only completed proofs keyed to their
full input/runtime/validator/environment contract. Review narrower R7 reachability
with independent coverage for subprocess and dynamic inputs; require a deliberate
schema transition. Extend owning test lanes only with complete dependency
coverage, keeping unknown-path fallback and a final integrated candidate gate.
Measure phase/retry/invalidation costs; do not assume signing, physical hardware
or current remote truth can be cached as timeless evidence. Acceptance includes
paginated reset semantics, future-parent attribution, interrupted upgrades,
changed runtime/import/schema invalidation, tampered receipts and unchanged
hosted/docs changes avoiding unrelated analytical work. R7 calculation resume
and single-notarization experiments remain separately scoped later work.
