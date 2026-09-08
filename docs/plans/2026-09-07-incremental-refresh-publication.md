---
title: Incremental graph refresh implementation and publication
date: 2026-09-07
type: plan
status: in-progress
source_commit: 1b44f9ea
---

# Scope and authorization

Implement the recommendations in the
[refresh investigation](../research/2026-09-07-refresh-performance-investigation.md)
and publish the hosted Worker/public/admin changes after validation. The owner
explicitly requested end-to-end implementation and publication. Necessary
forward migrations are in scope; telemetry deletion, consent changes, v1.1
activation, desktop releases and unreviewed resource-limit increases are not.

## Implementation workstreams

- [x] Preserve authorized published generations across accepted corrections;
  keep explicit hard withdrawal/erasure and atomic successor publication.
  Root owns migration 0050, ingestion transaction and serving contract changes.
- [x] Reuse historical work/results when their actual bounded dependencies are
  unchanged; coalesce date-scoped changes without weakening source/lease fences.
  Invalidation workstream owns migration 0051 and historical identity/admission.
- [x] Prepare exact daily usage and quota/plan inputs once; reuse them across
  overlapping windows, preserve unchanged solver results, and bound/restart all
  preparation. Core workstream owns migration 0052 and prepared-evidence modules.
- [x] Avoid raw work on unchanged refreshes; reduce per-page allocation and
  checkpoint work without changing legacy physical-page replay. Root integrates
  the runner, scheduler, migration 0053 completion receipts and staged upgrade
  policy with the core workstream.
- [x] Preserve frontend data on transient failure, isolate admin request lanes,
  remove age-only invalidation, and expose verified progress/restart/publication
  metadata. Frontend workstream owns web presentation; root owns Worker DTOs.
- [x] Update maintained docs and closed API/schema/generated consumers; preserve
  unrelated changes and immutable prior release/deployment evidence.

## Validation and publication gates

- [x] Focused replay, correction, no-op, out-of-window, erasure and race tests.
- [x] Exact raw/prepared calculation parity, old/new checkpoint replay, dense
  synthetic resource measurements and crash/restart qualification.
- [ ] Full Worker, UI, architecture, documentation and release-site gates.
- [x] Independent implementation review; resolve findings before publication.
- [ ] Clean reviewable source commits; dry deployment and migration rehearsal.
- [ ] Verify live source/schema and recovery position; apply only the reviewed
  forward migration set via the maintained production gate.
- [ ] Deploy through the guarded wrapper; verify health, exact source/assets,
  natural refresh progress and public/authenticated admin rendered behavior.
- [ ] Record source, migration, deployment, performance and live receipts
  separately. Do not claim historical backfill complete until observed complete.

## Current state

Implementation started from 1b44f9ea; only the preceding investigation record was
untracked. All implementation lanes and independent reviews are complete.
Focused integration, migration rehearsal and local HTTP acceptance have passed.
The complete Worker gate is being repeated after its final publication-result
fix; clean-source dry bundles and live publication remain pending. See the
[qualification record](../reviews/2026-09-07-incremental-refresh-qualification.md).
No production mutation has been made by this implementation yet.
