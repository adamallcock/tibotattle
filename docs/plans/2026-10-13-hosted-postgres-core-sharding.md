---
title: Hosted PostgreSQL CORE sharding proposal
date: 2026-10-13
type: plan
status: proposal
---

# Hosted PostgreSQL CORE sharding proposal

## Decision sought

Split the hosted PostgreSQL `CORE` producer into two deterministic, duration-
balanced shards while retaining the canonical 95-file suite, its default
serial execution, every existing test assertion and timeout, and the 45-minute
producer limit. This document is a proposal and contains no successful hosted
run or release qualification.

## Evidence

The last successful comparable run completed in about 43.1 minutes: roughly
32.0 minutes for standalone Node specs, 11.1 minutes for the PostgreSQL Vitest
registration group, and negligible time for the Node Vitest group. That left
less than two minutes under the 45-minute producer limit before setup and
runtime variance.

In the later attempt, the two Vitest groups completed in about 11.36 minutes.
The standalone Node pass reached 47 of 79 files and accumulated about 33.1
minutes before cancellation at about 44.5 minutes. No assertion failure was
reported in completed work. The in-flight file had no completed result, so its
outcome is unknown. The 32 unobserved files accounted for about 6.24 minutes
in the prior successful run; they are weighted at twice that prior duration
when balancing the proposal to allow for observed slowdown and uncertainty.

The deterministic longest-estimated-duration-first assignment gives each shard
about 31.1 minutes of scheduling weight. It uses current elapsed time for the
47 observed Node specs, twice the previous duration for each of the 32
unobserved specs, and 1.5 times the previous completed duration for the
PostgreSQL Vitest group (about 16.6 minutes). Add approximately one minute for
shard startup and the weighted estimate leaves roughly 12.9 minutes under the
existing producer limit. These weights are a scheduling heuristic, not a
hosted runtime guarantee.

## Proposed partition contract

The closed manifests assign exactly 54 canonical files to `CORE_A`, 40 to
`CORE_B`, and one to `EDGE_E2E`; together they cover all 95 canonical files.
The two CORE shards cover all 94 `SOCKET` and `HOST` files. Whole Vitest config groups
stay intact: one group is assigned to `CORE_A`, and the other is assigned to
`CORE_B`. Standalone Node files are balanced by longest estimated duration
first, with path ordering as a deterministic tie-breaker.

At execution, the runner must recompute the canonical plan and refuse a CORE
shard if the manifest overlaps, omits a file, includes an unknown file, or no
longer matches the canonical CORE inventory. It must refuse an EDGE inventory
that no longer contains exactly its reviewed file and any Vitest registration
group split across CORE shards. A future canonical inventory change therefore
requires an explicit manifest/cardinality update and a fresh duration review;
files are never silently redistributed. `--plan` and the no-flag invocation
continue to describe and execute the complete canonical suite serially.

Each hosted producer emits a content-free receipt. Aggregation must require
exactly one receipt from every partition and all producer jobs to succeed. It
must bind all receipts to the same selected source revision, provider run and
attempt, runtime provenance, plan digest, build-source digest, and generated
bundle paths, byte counts, and hashes. The plan digest covers the files and
their source digests; the existing build-source and bundle closure binds
transitive build inputs, including the kernel. No separate kernel receipt
field is proposed.

The aggregate must verify the exact disjoint union of 94 CORE and one EDGE
file, every registered test result, zero skips and environment gaps, and the
existing strict receipt contracts. It must not accept partial, duplicate,
cross-run, cross-attempt, cross-source, or cross-runtime evidence. No test,
assertion, timeout, or budget is removed or weakened.

## Validation and remaining gate

The proposal patch should first pass the runner's static full-plan and
per-partition checks, the runner's receipt and CLI contract tests, and the
hosted-workflow contract test. A hosted run is still required to establish
that both shards finish reliably within their unchanged 45-minute limits and
that the aggregate accepts their receipts. Until then, the full canonical
serial suite remains the only proven complete local behavior; sharding is not
production-qualified.
