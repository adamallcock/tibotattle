---
title: GCP MODEL-BLOCKS implementation and qualification
date: 2026-10-03
type: plan
status: source-validated-qualification-pending
---

Base: `48c26716a478bf92a830c27ea9c8ab7a90a0d929`, the coordinator-approved FINAL,
REFRESH, corrected KPAR, SEMI and W1E fold. Source implementation only.

1. Factor pure prepare, cache, scalar and model block units; preserve inline
   emission order, per-date quota identity, timings, error precedence and exact
   output-budget crossing. Differential synthetic owner proof before dispatch.
2. Add no-wait block grants through the owner pool, direct MessageChannels,
   serialized-payload charging, deterministic ordered replay, cancellation/drain
   and whole-owner alone OOM retry. Keep heap model, owner admission and resource
   verdicts unchanged. Add minimal flags and rehearsal pass-through.
3. Run focused synthetic, pool protocol, clone/date independence and failure
   checks. Broaden relevant existing gates. Deliver a receipt with explicit
   pending PG17, Q-1, dense, s015, full and o01 measurement matrices.

MODEL-BLOCKS owns `units.ts`, `compute-owner.ts`, compute emission observer,
pool/Worker grant additions and model flag hunks. Other lanes own native path,
reader, telemetry binding and read-concurrency hunks. No main-checkout edits,
cloud writes, registry/pin finalization, or large imports/benchmarks.

Source proof and remaining scheduled measurements are recorded in
[the implementation receipt](../receipts/2026-10-03-gcp-perf-model-blocks.md).
Stage and dispatch checkpoints passed independent scoped review; consolidated
registration, complete gates and large-corpus memory/performance remain pending.
