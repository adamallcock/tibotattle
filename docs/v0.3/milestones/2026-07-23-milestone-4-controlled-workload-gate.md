---
title: Milestone 4 Controlled Micro-Workload Gate
date: 2026-07-23
type: decision-record
status: accepted
---

# Milestone 4 Controlled Micro-Workload Gate

## Decision

**Proceed, with no causal observation yet.**

The harness, manifests, pricing dry-runs, and synthetic live-path tests are ready. After the weekly reset, two real one-turn Terra pilots ran within quota, elapsed-time, tool, and Terra-specific API-price safety bounds, but a separate Sol rollout completed during each measured interval. Both results are correctly retained as `controlledState: unknown`; they are evidence that the live capture and contamination stops work, not causal pilots. Later retries and a bounded watcher detected the still-active competing task before launch and spent nothing.

The written acceptance gate requires a safe aligned live pilot, explicit separation of observation from causal interpretation, and no premature multiplier. Those conditions now pass. Milestone 5 may proceed specifically to model the observed shared-pool/local-concurrency contamination. A clean controlled pair remains required before any causal model, cache, reasoning, or tool-effect claim.

## Implemented harness

- Validates schema `0.3` manifests with safe experiment IDs and a registered stable workload implementation.
- Requires hypothesis, model, reasoning effort, context band, cache state, permitted aggregate tool class, projected disjoint token components, one-turn limit, elapsed/API-price/quota budgets, minimum quota headroom, before/after captures, and `concurrency: none`.
- Requires a 15-second quiet preflight for the small pair and 30 seconds for context-band probes. Recent retained usage refuses execution; a structurally open non-controller task modified within the last five minutes also refuses, preventing a long request from looking quiet merely because its terminal token record has not arrived.
- Restricts v0.3 to exactly one live turn, at most one displayed quota point, and at least five points of declared headroom. The initial pair requires ten.
- Uses standard OpenAI API pricing through RunCost and refuses any pricing warning or projected budget breach.
- Requires both a manifest declaring `live` and an explicit `--execute-live` CLI flag.
- Reads the canonical quota immediately before the quiet scan and workload spawn, timestamping the capture only after the read returns; unavailable or low-headroom windows are refused.
- Runs the stable workload in a temporary read-only sandbox, strips the controller thread identity from the child environment, discards stdout/stderr content, and never stores prompt, response, path, session ID, or tool arguments in the result.
- Reconstructs local API-priced usage between start/end, captures quota after, checks reset identity, and records postflight elapsed, measured cost, pricing-warning, and displayed-movement stops.
- Excludes exactly the in-memory controller session from quiet and measured scans without persisting its identifier. Excluded-parent cumulative snapshots are still parsed in lineage-only mode so fork replay remains deduplicated; descendants are not excluded.
- Counts distinct non-controller usage-bearing rollout files during the measured interval. Zero means the workload was not observed; more than one is concurrent local activity. Either prevents a controlled label.
- Retains only aggregate tool classes in normalized outputs and stops a no-tool pilot if any client-side tool class appears.
- Deletes only its own temporary workload directory after the child exits.

## Initial comparison pair

1. `terra-low-no-tool-uncached-v1`: Terra, low reasoning, no tools, uncached hypothesis.
2. `terra-low-no-tool-repeat-v1`: same bounded task/model/effort with repeat/cache-heavy expectation.

Additional dry-only manifests cover Terra high reasoning, Sol low, Luna low, a 260k-input below-band probe, and a 300k-input above-band probe. The tool pair remains deferred until Milestone 6 establishes which observable class, if any, maps cleanly to a billable server unit.

The workload content is registered in source and absent from both manifests and results.

## Dry-run results

- Uncached projection: `$0.08288` standard API-priced equivalent, no pricing warnings, within the `$0.10` manifest budget.
- Repeat/cache-heavy projection: `$0.01538`, no pricing warnings, within the same budget.
- Both ordinary dry-runs stopped at `live_execution_flag_required`, proving no implicit live execution.
- Terra high projected `$0.09632`, Sol low `$0.16576`, Luna low `$0.033152`, the 260k below-band probe `$0.65576`, and the 300k above-band probe `$1.50864`; all resolved without pricing warnings.

## Live results to date

The explicit live attempt for the uncached manifest performed only the read-only quota preflight:

- canonical limit: `codex`;
- slot/duration: primary, 10,080 minutes;
- used display: 99%;
- reset identity: `2026-07-28T17:06:03.000Z`;
- remaining displayed headroom: one point;
- required headroom: ten points;
- result: `preflight_refused` with `insufficient_quota_headroom`.
- a later retry from the active development task also recorded `recent_local_activity_detected`, proving the quiet-period gate independently refuses concurrent work.

No workload process was spawned and no experimental turn was billed.

After the reset, the canonical weekly display had 99 points of headroom and the live workload was allowed to run:

- interval: `2026-07-23T20:14:00.044Z` to `2026-07-23T20:14:08.646Z` (8.602 seconds);
- canonical display: 1% before and 1% after, with stable limit/reset identity;
- Terra workload component: 15,862 uncached input, 7,424 cache-read input, 8 text output, and 14 reasoning-output tokens;
- Terra standard-API-priced equivalent: `$0.041841`, with no pricing warnings or observed tools;
- contaminating Sol component: one distinct rollout, 144,576 tokens and `$0.081012` API-priced equivalent;
- aggregate result: `completed_with_stop`, `controlledState: unknown`, with `concurrent_local_usage_detected` and the aggregate measured-cost stop.

The preflight was then hardened to detect structurally open tasks before they emit a terminal token record. A subsequent explicit retry returned `preflight_refused` with `active_local_task_detected` and `recent_local_activity_detected`; no workload was spawned. A 30-second follow-up probe still found one active non-controller task and one recent Sol usage event. No causal quota claim is made from the contaminated run.

A second safe Terra workload ran from `2026-07-23T20:25:33.199Z` to `2026-07-23T20:25:38.893Z`. Its Terra component was `$0.041851` API-priced equivalent with no tools or pricing warnings; one separate Sol rollout contributed `$0.102917`. The display again remained 1% before and after, and the result remained `controlledState: unknown`. Structural comparison confirmed the Sol rollout was neither the controller session nor its child and had a different working-directory identity; no path or identifier was retained.

A final three-minute watcher required zero recent usage and zero structurally active non-controller tasks before launch. Across checks it observed zero to two recent usage events but always one active task, then exited `clean_window_timeout_no_workload`. This establishes that the remaining clean-pair gap is external state, not a missing safety control.

## Tests

Harness tests cover every checked-in manifest, manifest/budget validation, dry-run non-execution, low-headroom, recent-activity and already-active-task refusal, exact controller exclusion, retained child/sibling detection, fork-lineage preservation, child-environment isolation, a simulated successful before/after pilot, concurrency/tool invalidation, postflight measured-cost/reset stops, and unknown-model pricing refusal. The full current Node suite passes: 50 tests, zero failures, zero skips. Syntax checks pass for every source module.

## Privacy and permissions

The append-only experiment result file is mode `0600`. It contains manifest hashes, declared metadata, pricing provenance, sanitized quota windows, status/stops, and privacy booleans. Searches found no workload arithmetic constants, prompt/response content, session identifier, local path, rollout filename, call ID, arguments, or working directory. Field names such as `promptStored: false` are declarations, not content.

## Remaining evidence condition

Re-run the uncached manifest only when the live preflight reports no recent non-controller usage and no structurally active non-controller task. The provider snapshot must still show at least ten percentage points of headroom, stable reset identity, and no pricing warnings. Existing contaminated results remain append-only and must not be relabelled; the next clean result will be a separate record. This is required before a causal effect claim, but it no longer blocks implementing the Milestone 5 contamination model.
