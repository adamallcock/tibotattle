---
title: Auto-review separate allowance for the next client
date: 2026-10-07
type: plan
status: in-progress
---

Implement the owner's October 7 request for auto-review usage from October 6,
2026 onward to appear in the existing separate-allowance category and show $0
against the main allowance. The owner has resumed the client release and explicitly
included these auto-review changes in the replacement candidate. The October 7
pause below is historical. No hosted deployment or provider migration belongs
to this local classification change.

## Contract and evidence

- Identify auto-review only from the exact pair in a session metadata header:
  `thread_source: guardian_review` and `source.subagent.other: guardian`.
  Carry only the closed local `threadSource: auto_review` classification.
- Apply the rule to each usage event at or after `2026-10-06T00:00:00.000Z`,
  following the repository's existing inclusive UTC policy convention. The
  owner supplied a date, not a provider timezone or rollout instant; this is
  an explicit product convention. Session creation and ingestion dates do not
  determine the treatment.
- Preserve earlier usage, unrelated usage, unknown metadata, raw tokens,
  occurrence identity and API-price evidence. The new $0 is a main-allowance
  display, not an invented zero API price.
- Reuse the existing separate-allowance aggregation/display path. Keep Spark
  identified as its own pool and preserve its own quota/timeline series;
  auto-review must not be attributed to Spark's measured allowance.
- Reparse present historical sources through a new parser version, preserving
  replay and absent-source provenance. Invalidate derived accounting caches.
  Advance the unified compatibility fence so an older reader/writer cannot
  silently reinterpret the new semantic state.

## Ownership and validation

The ingestion worker owns source classification, parser/compatibility versions,
passive checkpoint refresh and their focused regression tests. The projection
worker owns companion, replay-cache, archive and window reporting plus their
focused tests. The UI worker owns the shared allowance policy and browser
presentation; the root owns this plan, maintained documentation and integration
checks. All work is isolated from existing dirty
checkouts and the frozen release candidate.

Test the exact date boundary, offset-equivalent timestamps, sessions spanning
it, missing/conflicting markers, model-only non-exemption, mixed-period rows,
token/API-price conservation, replay/restart and unchanged Spark behavior.
Inspect the rendered usage table through the local companion, and run relevant
source, local, UI, architecture and documentation checks. Tests use synthetic
fixtures; any real-source visual check is separately bounded and local.

## Candidate and release handoff

Base: `297b12ef4b29135e37310481d675f0bb4303f817`, isolated branch
`codex/autoreview-separate-allowance`. The frozen 0.1.27 artifacts do not contain
this feature. Their prior signatures and qualification receipts cannot qualify
new bytes. The replacement is 0.1.28, build 2026100901, with macOS bundle
version 1036. A new candidate build and all native/hosted release gates remain
outstanding. The replacement also includes the reviewed
sharing-startup retry fix and build dependency remediation. Do not rewrite the
existing tag; all four shared Electron targets must be rebuilt and qualified.

Implementation, validation and rendered evidence will be recorded here as each
step completes.


## Active checkpoint — October 9, 2026 UTC

The owner explicitly included auto-review in the replacement client release.
The source slices are complete: ingestion 375 tests (plus the final 18-test
archive refusal rerun), projection 163, caller compatibility 140, companion
projection 66, and browser 1,003 passed without skips. Archive upgrades now
retain absent-source facts; passive replay retains occurrence identity across
classification changes. Both reproduced failures have passing regressions.

The complete companion gate exposed an attribution reader that still admitted
only physical format 11. It now requires the current format 12 and rejects both
older and future formats. All 83 focused attribution/contribution/privacy tests
and the complete 407-test companion suite pass. Independent source review found
no correctness, privacy, migration or data-loss issue in the final diff.

Root inspected the synthetic companion in English, Simplified Chinese and
Spanish, including independent row expansion, keyboard controls, explanatory
tooltips and the scrollable narrow table. The primary fixture remains $12.89
and 2,600,000 tokens; three auto-review rows display $0.00* and Spark withholds
the comparison. This is source/browser evidence, not installed qualification.

Documentation, preflight and architecture checks pass. The R7 freshness gate
correctly reports stale workload-source digests. Regenerate all ten receipts
once on the final integrated source and dependency closure, then run the broad
root gate. Fresh four-platform artifacts, signatures, native upgrade checks,
installed behavior and publication remain required.

## Historical paused checkpoint — October 7, 2026

At this checkpoint all feature and release work was paused, pending a new owner
instruction. The active checkpoint above supersedes that pause.
Changes remain uncommitted on the isolated feature branch; existing dirty
checkouts, the frozen candidate and failed qualification evidence are preserved.

Completed checks before the pause:

- Shared policy and browser normalization/presentation tests: 207 passed.
- Projection worker reports 46 focused tests passed, covering the event cutoff,
  preserved token/API-price evidence, distinct model rows, replay persistence,
  archive rebuild, calibration and unchanged Spark behavior.
- Ingestion worker reports focused classification, passive header refresh,
  compatibility fences, parser variants, archive reclassification and source
  preservation checks passed. These are scoped results, not a completed gate.
- The ingestion worker canceled its own aggregate test session 8397 with Ctrl-C
  during `test/passive-collector.test.js`. It exited 1 due to interruption;
  no failure was reported before cancellation. It has no complete suite result.

Outstanding at the October 7 pause:

1. Review and integrate the worker changes; complete the inline-fork checkpoint
   test and remaining owning tests.
2. Update the local companion cold-refresh selector/tests to parser v20 and
   predecessors v10–v19. Reconcile the documentation index and recovery runbook
   with compatibility version 12 and parser v20.
3. Verify generated mirrors and run the appropriate source, local, browser,
   architecture and documentation gates. Perform the rendered table inspection;
   it has not been done.
4. Review the complete change before any commit, integration or candidate build.
   Source edits and focused tests do not qualify a released client.

The frozen release remains at `5a3c34fd5dd7cc5cbb52a8179c99ee8f828f2be4`;
the separate Linux qualification checkout remains at
`90ba94d1e0b5120fe1ee7256e722cfc1c01862bb`. Neither includes this feature.
The requirement to publish macOS ARM, macOS Intel, Linux and Windows together
is unchanged. No additional test or qualification run was started to close
this checkpoint.
