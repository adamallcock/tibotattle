---
title: Optimized RC9 accounting comparison
date: 2026-09-03
type: receipt
status: complete
---

# Optimized RC9 accounting comparison

## Result and claim boundary

The isolated detailed-accounting child completed in a median **39.25 seconds**
instead of **321.86 seconds**: **8.2 times faster**, with identical complete
serialized cache bytes in all eight runs. This qualifies the named production
code on one immutable corpus snapshot, not end-to-end refresh latency, installed
native behavior, public-release readiness, or the separate PR #94 attribution
before/after gate. The earlier pre-RC9 performance receipt is a different source
comparison and remains historical evidence.

Measured revisions:

- Baseline: `a89eaa8bea1e2afe5aa3d137b8acdcd579257047`, the receipt-only
  descendant of pre-optimization RC9 `d362e168`.
- Candidate: `b06b5968ea3d2f17179a894c33a77926be86451f`, including the seven
  optimizations, bounded attribution precompute, hard archive guards, optional
  low-headroom fallback, and the single manual Refresh policy.
- Harness at the candidate revision: `scripts/benchmark-detailed-accounting.mjs`,
  emitting `detailed-accounting-child-benchmark-v1`; command exited zero.

## Controlled inputs and verification

An owner-only, read-only APFS clone of a preserved quiescent index was used;
neither the live app nor live state was changed. Both revisions were clean and
unchanged throughout the run. No concurrent tests, builds, R7 run, or TiboTattle
app were started by the coordinator. Other ordinary desktop applications
remained open; this is not a claim of laboratory-wide isolation.

- Runtime: Node `26.2.0`, macOS arm64; runtime SHA-256
  `b276251704734604aad4ab2dc4a07892565baea39400f6422abeb1fe39637440`.
- Input index: schema 11, generation 44, 1,508,540,416 bytes; SHA-256
  `e9f477efc2c1ea50360509fe70681c8bd04b7b4a5b16a56b5d2855f69628b6ce`.
- Counts: 7,708 indexed sources, 726,740 usage events, 954,391 quota
  occurrences, 903,427 tool facts; zero skipped sources and threads.
- Generic publication status remains `partial`, reason
  `tool_provenance_incomplete`. The unmodified production accounting reader
  accepts this tool-only coverage gap; no database field was relabeled.
- Pinned instant: `2026-09-02T00:00:00.000Z`; 365-day window, unified source,
  `legacy_zero` context behavior, no declared speed baselines.
- Production memory policy unchanged: 6,442,450,944-byte RSS ceiling and
  6,144 MiB V8 old-space limit. No limit was relaxed.
- Each side had one warm-up and three measured runs; measured pair order
  alternated. `/usr/bin/time -l` measured wall time, user/system CPU and true
  maximum RSS around the unmodified production child. Its stdin stayed open.
- Every run required a successful envelope, independent result-file hash and
  size, and validation by that revision's own cache validator. Final index
  identity/hash and source checks passed.
- All eight artifacts: 15,511,261 bytes, SHA-256
  `bb90b9835fb786fdf1592ee18c6d1bcd5b84084a1d9a962c23d036bf15c7f61a`.

## Raw measurements

RSS values are bytes, not phase-boundary samples. Run zero is the warm-up and
is excluded from the reported medians.

| Side | Run | Wall seconds | User CPU seconds | System CPU seconds | Peak RSS bytes |
|---|---:|---:|---:|---:|---:|
| Baseline | 0 | 325.33 | 312.60 | 20.57 | 1,872,527,360 |
| Candidate | 0 | 39.37 | 43.43 | 1.08 | 2,067,628,032 |
| Candidate | 1 | 39.44 | 43.46 | 1.08 | 1,991,376,896 |
| Baseline | 1 | 321.86 | 309.03 | 20.40 | 1,894,645,760 |
| Baseline | 2 | 323.79 | 310.21 | 20.77 | 2,000,814,080 |
| Candidate | 2 | 39.25 | 43.18 | 1.08 | 1,995,751,424 |
| Candidate | 3 | 39.16 | 43.07 | 1.06 | 2,007,121,920 |
| Baseline | 3 | 320.86 | 307.69 | 20.33 | 1,830,928,384 |

Measured median user CPU fell from 309.03 to 43.18 seconds; median system CPU
fell from 20.40 to 1.08 seconds. Median peak RSS increased from 1,894,645,760
to 1,995,751,424 bytes (101,105,664 bytes, about 5.3%). This is not a memory
reduction claim. The maximum across all eight runs was 2,067,628,032 bytes,
below the unchanged ceiling. Three measured runs provide a median and range,
not a percentile or a universal performance promise.

## Supplementary provenance review and harness limits

The v1 harness checks clean source and immutable input but did not automatically
bind ignored dependency links. During this comparison, a separate read-only
review resolved each production child's 164-file local import closure without
executing product modules. All 28 workspace edges resolved inside their own
revision. All 54 tracked files in accounting, quota-analysis, identity-core and
telemetry-contract matched HEAD and each other, as did eight imported schemas.

Both sides independently resolved AJV 8.20.0, runcost 0.2.1, fast-deep-equal
3.1.3, fast-uri 3.1.6, json-schema-traverse 1.0.0 and require-from-string 2.0.2,
consistent with their identical lockfiles. All 196 packaged JS/CJS/MJS/JSON
files (1,106,636 bytes per side) matched. This is supplementary point-in-time
verification, not continuous harness enforcement or registry-tarball
authentication. No dependency mismatch was found.

Review also found that v1's cancellation did not cover all hashing and final
receipt-publication phases. This successful run was not canceled. These tooling
safeguards are being corrected separately without changing the measured product
code; a later harness revision must not silently relabel this v1 measurement.
An earlier interrupted comparison was excluded entirely from these results.

Subsequent tooling follow-up on 2026-09-03: the v2 harness adds bounded
before/after dependency snapshots and cancellation-safe hashing/publication,
including confirmed direct-child closure after forced termination. Its focused
synthetic tests passed 18/18 and independent review found no remaining concrete
issue. This does not retroactively turn this completed v1 run into v2 evidence.

## Remaining gates

Complete optimized-source R7, final root/native/Worker checks, signed artifacts,
state-preserving replacement, and installed native inspection remain separate.
No end-to-end ingestion/publication latency, no-change/relaunch behavior, or
device-pairing result is inferred from the child timing. The formal PR #94
cross-revision attribution comparator remains **OPEN / NOT RUN**. Public
publication and updater changes still require the owner's later approval.
