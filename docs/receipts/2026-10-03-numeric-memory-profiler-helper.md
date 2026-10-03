---
title: Numeric memory profiler helper
date: 2026-10-03
type: receipt
status: local-synthetic-helper-verified
---

This is helper-only evidence on base `551ba102cf5eeead9a5b64f78aace660a68fcd25`, using Node.js 26.2.0. Integration, full-workload profiling, PostgreSQL, provider data, production telemetry, deployment and performance qualification remain outside this receipt.

`apps/worker/cloud-run/analytics-refresh-memory-profile.mjs` exports `startNumericMemory`. Disabled returns null without sampling, timers or observers. Enabled returns synchronous `sample(phaseId)` and `finish()`, which returns a closed numeric diagnostic receipt without writing files. Numeric isolate IDs and fixed main/worker roles carry no account identity. The integration owner supplies explicit opt-in and shared artifact budgeting.

Default history holds 64 samples (hard maximum 128), with 64 KiB maximum serialized output per isolate. History keeps the start and recent observations and reserves an end row; peaks and last observations continue after history saturation. The receipt marks truncated history, gaps, missing/invalid values and incomplete temporal coverage. Fixed phases are start, timer, asynchronously delivered GC, pre-persist, end and checkpoint. Timers cannot observe synchronous compute peaks; GC observations occur after asynchronous delivery and cannot recover the pre-GC peak. Main RSS is process-wide; worker RSS is omitted. The sample at observed maximum process RSS retains its contemporaneous local heap fields. Numeric epoch start plus isolate elapsed time permits approximate cross-isolate alignment; sample age/skew and missing busy-worker observations still require separate integration evidence. Phase IDs are sampling reasons, not compute work-phase identity. Independent maxima are never additive.

Heap used/total, external, arrayBuffers, V8 physical/used heap and malloced/peak-malloced categories are numeric counters. arrayBuffers is explicitly a subset of external. Fixed V8 heap-space categories expose size, used, available and physical bytes. These categories do not provide an exact RSS decomposition, retained-object attribution or allocated-byte total.

Source correlation candidates already exist: `analytics-refresh-worker.mjs` records serialized input and output bounds and bytes around serialization/deserialization; `analytics-refresh-pool.mjs` owns admitted worker heap/overhead reservations and block transfer/result reservations. These logical budget quantities differ from physical resident bytes. Existing worker model checkpoints and pre-persist integration can correlate sampled heap changes with phases. The pool's `memoRebuildMs` remains null; numeric memo live bytes cannot be inferred from WeakMap contents or budget formulas.

Validation: `node apps/worker/cloud-run/analytics-refresh-memory-profile.check.mjs` passed. Injected checks cover zero disabled hooks, sustained observations after history saturation, finite/nonnegative normalization, worker RSS omission, main RSS scope, GC delivery, byte cap, sanitized unknown space omission, immutable repeated finish and content-free error counts. No heavy corpus was run.
