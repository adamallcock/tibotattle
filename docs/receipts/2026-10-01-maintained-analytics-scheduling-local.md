---
title: Maintained analytics negative scheduling and complete query measurement
date: 2026-10-01
type: review
status: local-component-qualified
---

# Result and boundary

The locally integrated publisher and cache negative hints passed 23 focused
Worker tests on October 1, 2026. TypeScript and all 11 benchmark-launcher checks
passed. These are component checks. The combined candidate remains uncommitted;
comparison16 is running at this checkpoint. The latest completed whole comparison
is [comparison15](./2026-10-01-maintained-analytics-post-group-pair.md), whose
required tenfold work/cost target failed. No online resource was inspected or
changed by this checkpoint.

## Publication scheduling

[Publication-only composition](../../apps/worker/src/storage-analytics-runtime.ts)
reads a fresh target-settled hint before starting public-output attempts. A
negative result applies for one invocation. That invocation still performs its
ordinary bounded work, erasure check, and permitted retirement pages, then
returns deferred/source_prefix_pending. It does not assert completion. A fresh
subsequent invocation probes again, including when a producer settled during the
previous hint.

Positive and uncertain cases retain the full source/closure, authority, clock,
lease, CAS and final-readback checks. The shortcut leaves the original query
floor and respects cancellation/deadline before starting further retirement
pages. A deterministic deadline-crossing regression proves deferred/deadline and
no newly started post-deadline page. The new reason is restricted to the
publication pass type; it does not broaden persisted catch-up states.

## Cache scheduling

[The cache work stage](../../apps/worker/src/storage-analytics-cache-work.ts)
retains its ordinary fair claim and current partition read. Its
[negative hint](../../apps/worker/src/storage-canonical-cache-pairs.ts) applies
only when a current, live-leased, at-most16-fact usage leaf has every exact
physical slot prepared and the first bounded global repair page is blocked by
another unprepared leaf. A positive hint defers cache_repairs_pending before
repeating the full source proof. It proves neither freshness nor completion.

The original source proof, materializer and completion CAS remain on all
uncertain/unprepared paths. The hint checks the original required cache tables
and triggers freshly. Its two range probes explicitly pin the reviewed slots
partition and fact logical-key indexes. Missing tables, columns or indexes make
the hint false. Actual index drop/restore and trigger-loss controls passed.

This bounds the new hint against a silent whole-table fallback scan; it does not
qualify physical work within a dense logical key. The unchanged ordinary repair
query may scan broadly after its index is lost. The focused two-leaf case uses
synthetic legacy-selected canonical facts and an explicit current callback;
it is not an accepted-source/full-work-stage performance qualification. A prior
prototype target-only comparison measured16 statements/615 reads for an old
retry versus13/613 for the hint plus partition read. That different source pin
excluded avoided source-proof work and is not a whole-system speedup.

## Complete performance measurement

The optional [profile observation boundary](../../apps/worker/test/helpers/analytics-profile.ts)
feeds a bounded [complete performance histogram](../../apps/worker/test/helpers/analytics-performance-histogram.ts).
It records every metered operation/side/family/normalized-query shape and requested
first/all/run/raw/batch method, including ledger work, failures and every write.
Only hashes and aggregate resource counters enter reports; SQL remains ephemeral,
and binds, result values and errors are excluded. The4096-shape inventory keeps
unknown observations, metadata failures, overflow and observer errors explicit.
Every cost bucket and total must reconcile to the existing owning profile.

A separate256-entry histogram aggregates every actual role invocation and its
closed outcome/claim/publication classes. Its costs cover the whole invocation;
it does not assign all publication-role cost to a prepass. Unknown or missing
outcomes remain gaps. Both histograms keep noRescanQualified false. Executed
source/view lineage, full physical-scan proof, exact CPU, true peak heap, physical
bytes and full monetary cost remain separate open requirements.

P11's unchanged Slice A files passed37 Node/fake-D1 tests at their recorded pin.
The launcher now pins both the new helper and its focused spec, in addition to
its existing migration/harness and bundle provenance. Strict output, clock,
mutation and resource validators are unchanged. Existing per-lane output limits
remain in force. Product diagnostic timing samples still retain their original
four-event cap; an all-attempt product timing redesign was not adopted.

## Evidence

- Worker command: `vitest run test/storage-canonical-cache-pairs.spec.ts test/storage-canonical-publication-scheduling.spec.ts`;23/23,12.51seconds.
- TypeScript: `tsc --noEmit --pretty false`;exit0.
- Launcher: `node --test scripts/benchmark-analytics-whole-workload.check.mjs`;11/11.
- Component logs and exact pins: `/private/tmp/p0-scheduling-histogram-integration-pins-20261001.json`.
- Comparison16: same ten-source-day/one-requested-date optimized native
  cold/warm/no_op diagnostic, independent actual role stores, real950 cap,
  original400 preparation bound and strict complete-output/timestamp equality.
  Its result is pending here; later receipts must not be attributed to this one.

### Local input SHA-256

| Worker-relative input | SHA-256 |
|---|---|
| `src/storage-analytics-runtime.ts` | `1ad19723c7f61fed09e2972fde6c3ec3ad9f3e1f3d44f5d35412f52fa8d24d70` |
| `src/storage-analytics-cache-work.ts` | `e9b8f16eebb62d7ebc9940cbe3a66a25a8c68c3b9d48572800259e43c991c044` |
| `src/storage-canonical-cache-pairs.ts` | `5b1483ed66b992819b85d58350952dcdc06c963ff3d9d02cbdefaab13ea8e8bf` |
| `test/storage-canonical-publication-scheduling.spec.ts` | `d702cba3be45cd594ad871bd5f227883b9ae5f66a9be6f2146841e58a236209a` |
| `test/storage-canonical-cache-pairs.spec.ts` | `62de112a6f2f6f9b13d8fa2b623a64a5171c9811f5928d32ea332fe09ce163a3` |
| `test/storage-analytics-publication-admission.spec.ts` | `20ee7f96f481b18d688f2568a81e5fb3182d72d487f925156f3771a2dc7b47dd` |
| `test/helpers/analytics-profile.ts` | `28745bceb75c38f15d490926dc748170fb3c5b2dde568ee722d6f2052e125c89` |
| `test/helpers/analytics-performance-histogram.ts` | `ad34866cc9fe15c2d1cb55b53a3f30ab756fc703637cf57c359b9b8e1c08d973` |
| `test/helpers/analytics-whole-workload.ts` | `f77501f0e9a8955151053fa19e5bf3ba5b1c691438689f333097de4925af207e` |
| `test/analytics-whole-workload.spec.ts` | `88b699ab9e442020e24bca0830c9cff191952690485743f7a9db4e1e9836d7be` |
| `test/analytics-performance-histogram.spec.ts` | `cb1e23e2dc5f62387c9fd05cc1a43c1e9f4f21cbabac47fd67b23bcabdd88b13` |
| `scripts/benchmark-analytics-whole-workload.mjs` | `4c56667d48895bdee3600a19f2e33e6a7ed3106a84da83487c8fef39d567a74d` |

## Remaining integration checklist

- [x] Small exact complete-output parity at the completed comparison15 pin.
- [x] Original-leaf feature/activity composition and focused fair-prefix/race checks.
- [x] Fresh negative publication/cache hints, index-loss/deadline controls and type check.
- [x] Complete bounded query/write measurement with exact owning-profile reconciliation tests.
- [ ] Measure the combined changes and resolve dominant cold fanout/repeated work.
- [ ] Genuine append and every required mutation, clock, repricing, interruption and erasure case.
- [ ] Full466-day corpus,1/30/365 requests, dense/skewed groups, retirement and execution-degree proof.
- [ ] At least10× whole repeated-history measured work/cost against optimized native.
- [ ] Freeze, independent review, one owning Worker gate and latest populated restore rehearsal.
- [ ] Exact separately authorized isolated online proposal, migration and live qualification.

The rejected mutation-clock validator proposal still awaits the pending human
answer. Its existing strict assertions and files remain unchanged. None of the
component results substitutes for a core row or the H04/H06/H07 boundaries in
[the owner plan](../plans/2026-09-28-analytics-redesign.md).
