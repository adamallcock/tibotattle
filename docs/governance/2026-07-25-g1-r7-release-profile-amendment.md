---
title: G1 R7 Release Profile Amendment
date: 2026-07-25
type: plan
status: complete
---

# G1 R7 Release Profile Amendment

> Implemented and verified by the [measured release verification receipt](../receipts/2026-07-25-g1-r7-measured-release-verification-receipt.md). The resulting [ceiling decision](../decisions/2026-07-25-g1-r7-release-ceiling-decision.md) remains open and promotes no candidate value.

## Purpose

This change record adds execution details that the original R7 preregistration deliberately left to implementation. It does not change the ceiling-selection rule, relax a stop condition, reinterpret the completed smoke receipts, or authorize network transport. The release profile remains blocked until the requirements below are implemented and verified.

## Profiles

R7 release evidence is a package of separate receipts, never one blended result:

1. `release_synthetic_semantics` covers every preregistered provider/account/window/lineage/fallback semantic case with generated content-free sources.
2. `release_synthetic_pressure` covers deterministic many-file, dense-record, long-line, chunk-pressure, manifest-growth, compressible, and incompressible structural shapes.
3. `release_materialized_boundaries` runs applicable actual producer and verifier pathways at an injected selected value and selected value plus one. Direct guard calls remain a separate `synthetic_counter` mode and cannot establish integrated enforcement.
4. `release_real_local_history` measures the current local 31-day Codex and Claude history from one frozen prefix plan without retaining a durable raw-log copy.
5. `release_decision` applies the already frozen lowest-safe-ceiling and 20% headroom rule to the preceding receipts.

No profile may substitute for another. In particular, scaled materialized byte cases and direct candidate-counter checks do not by themselves justify a GiB-scale candidate ceiling.

## Synthetic workload scales

The first executable release profile uses fixed tiers:

| Tier | Fixed target | Purpose |
|---|---:|---|
| Semantic sources | Minimum files needed for every named semantic case | Correctness and deduplication |
| Many-small-file pressure | 4,096 total source files | Directory/source planning and file-open pressure below the 5,000-file candidate stop |
| Dense safe records | 25,000 logical records | SQLite, ordering, hashing, and expanded-record pressure |
| Chunk pressure | 128-chunk target with a fixed records-per-chunk value derived before each seeded fixture run | Manifest and lifecycle pressure without approaching the 512-chunk hard stop |
| Material long line | 64 KiB and 64 KiB + 1 under an injected limit | Real bounded-line reader behavior without allocating a 16 MiB test line |
| Material decoded/encoded artifact | 8 MiB class | Compression/decompression/file enforcement with both compressible and seeded incompressible shapes |

All values are fixed before release-profile measurements. If the semantic fixture API requires a smaller representation for a case, the receipt records the actual fixed count and the case remains semantic rather than pressure evidence. If a pressure tier hits another resource first, the intended dimension is `not_identified`.

## Real local prefix freeze

The real-history run must not copy raw Codex or Claude records into a durable benchmark artifact.

1. Capture one internal start/end interval of at most 31 days. Exact user-activity times never enter the receipt.
2. Build each provider source plan once, including owner/type/link identity, exact complete-line prefix bytes, and prefix SHA-256.
3. Pass private source plans to isolated workers over bounded stdin, never command arguments, logs, receipts, or arbitrary errors.
4. Both lifecycle passes resolve and read exactly the same verified prefixes. Appends beyond a frozen prefix are ignored; any replacement or mutation inside the prefix fails with a fixed source-integrity code.
5. Do not persist raw lines, paths, filenames, provider IDs, pseudonyms, or row-level records outside the exact task-owned temporary lifecycle directories.
6. Delete or discard derived workspaces and output sets through their authenticated lifecycle APIs. Temporary benchmark cleanup additionally binds the task-root device/inode and an exact inventory.

A preliminary read-only sizing pass observed 1,445 Codex files / 22,316,482,369 bytes and 1,139 Claude files / 822,890,467 bytes for a current 31-day interval: 2,584 files / 23,139,372,836 bytes combined. This is a sizing observation only. It is excluded from ceiling selection and is not a performance, record-count, or completion result.

A later read-only frozen-bundle preflight, after all four plan types were integrated, observed 2,597 sources / 23,161,461,495 source bytes and an 18,176,990-byte canonical private plan. This exceeds the original 1 MiB default worker-input cap, so the real-history profile may opt into a separately bounded 32 MiB stdin class. Synthetic and smoke workers remain at the 1 MiB default. The private plan still travels only through a local pipe, never command arguments, durable files, logs, or receipts. This cap amendment was made before the real-history performance run and the sizing observation remains excluded from ceiling selection.

## Parent resource watchdog

Every isolated operation in a release profile must be monitored by the parent process:

- monotonic elapsed stop at the selected policy limit;
- child RSS sampling every 100 ms on macOS, plus a mandatory terminal `process.resourceUsage().maxRSS` lifetime high-water mark that the parent enforces even when sampling misses a peak; durable workspace RSS remains an additional diagnostic;
- bounded stdout and stderr of 256 KiB each;
- a 1 MiB default stdin cap, with an explicit 32 MiB maximum available only to the measured real-history private-plan worker;
- no inherited environment except fixed locale/time-zone values;
- fixed timeout, RSS, spawn, invalid-result, and output-overflow codes; and
- no command shell, interpolated path, arbitrary error, PID, host, or private sample series in the receipt.

All smoke and release workers use the same parent watchdog. A missing, invalid, or over-limit terminal lifetime RSS value fails closed; post-close in-flight samples are drained and the monotonic deadline is rechecked before completion can be accepted.

## Filesystem accounting

For each lifecycle stage, record aggregate task-owned filesystem bytes before, largest observed 100 ms sample, and after. The middle value is explicitly a sampled lower bound, not an enforced filesystem high-water claim; transient files can exist entirely between samples, so it cannot establish the 20% release-headroom gate. Sampling may walk only the exact task-owned temporary root, must coalesce overlapping ticks, must be bounded by the directory-entry policy, and must refuse unexpected links or root identity drift. Source logs are excluded from task-owned disk totals and represented only by non-linkable aggregate source counts and bytes.

## Machine and runtime comparison

- Node 24.14.0 remains the pinned candidate.
- Node 26.2.0 remains the compatibility cross-check.
- Record only `macos`, `arm64`, `apple_silicon`, and one fixed RAM bucket: `up_to_32_gib`, `33_to_64_gib`, `65_to_128_gib`, or `over_128_gib`.
- Exact runtime qualification is independently revalidated, but the receipts intentionally retain no host or paired-run identifier. Therefore the `exactRuntimePairs` promotion gate remains open even when both qualified receipts are present.
- One machine cannot establish a population percentile. Until another bounded machine class is measured, every retained ceiling is a single-machine decision with that limitation explicit.

## Additional stop rules

Stop and leave R7 open if:

- the frozen source plan cannot be reused without a raw durable copy;
- the parent cannot enforce RSS and elapsed stops with fixed diagnostics;
- a task-root replacement, symlink, hardlink, or inventory drift can reach cleanup;
- an actual producer/verifier case is mislabeled from a direct counter result;
- either exact runtime receipt is missing or not independently revalidatable; or
- a ceiling decision depends on the preliminary sizing observation rather than completed release evidence.

## Implemented outputs

The measured-release checkpoint added:

- a release fixture manifest and tests;
- a materialized-boundary receipt or explicit not-run rows;
- a parent-watchdog module and tests;
- frozen-plan injection and two-pass real-history execution;
- content-free runtime-specific machine receipts retained for revalidation;
- a bounded filesystem sampled-lower-bound method;
- dual-runtime full-suite and telemetry checks; and
- a dated per-dimension decision that either promotes, lowers, or explicitly leaves each ceiling unresolved.

Every listed output exists. The decision leaves all dimensions unresolved because the completed evidence also triggers the preregistered stop rules: literal candidate boundaries, measured absent-network evidence, an engineering rounding grid, and multi-machine evidence remain unavailable.
