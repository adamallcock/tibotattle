---
title: G1 Source Checkpoint Protocol Plan
date: 2026-07-24
type: plan
status: active
---

# G1 source checkpoint protocol plan

## Decision

Replace export-set replay-from-byte-zero with a strict source-ordered SQLite checkpoint protocol. A committed checkpoint is the atomic boundary for safe records, parser state, fork/replay state, tool attribution, diagnostics, and cumulative resource accounting. Resume starts at the stored next byte and physical line ordinal and may not reconstruct committed state by replaying earlier content.

This is a local-only G1-R3 change. It does not alter telemetry v0.1, enable transport, accept volunteer data, or weaken source-integrity verification.

## Current problem

The disk-backed export workspace stores final safe records, but the Codex scanner still:

- hashes and rereads every frozen prefix on resume;
- keeps event/tool dedupe and fork lineage in whole-run JavaScript collections;
- preloads a source tier timeline;
- keeps cumulative-token, model, pending-tool, and task state only in memory; and
- commits safe records without an atomic source cursor/parser checkpoint.

The RSS guard fails closed, but it does not make a 21.66 GB history tractable or a restart incremental.

## Protocol state

Every source-plan row gains a strict execution state:

| Field | Purpose | Privacy boundary |
|---|---|---|
| `phase` | `tier_scan`, `record_scan`, or `complete`; workspace poison is stored separately | Fixed enum |
| `nextByteOffset` | First unread byte in the frozen prefix | Local-only integer |
| `nextLineOrdinal` | One-based ordinal of the next physical JSONL line | Local-only integer |
| `currentModel` | Recognized model ID, opaque HMAC fingerprint, or missing | No raw unknown model |
| `previousTotals` | Last cumulative token counters and presence flags | Allowed usage metadata |
| `pendingToolCounts` | Fixed coarse tool-class counters awaiting the next usage event | No tool names/arguments |
| `resourceTotals` | Cumulative lines, bytes, records, expanded bytes, elapsed work, and peak RSS | Integer operational metadata |
| `checkpointDigest` | Digest of the canonical state and source identity | Integrity only |

Unbounded state is normalized into strict tables rather than JSON arrays:

- `source_tiers`: source ordinal, physical ordinal, timestamp, and fixed safe tier semantics;
- `fork_snapshots`: source ordinal plus secret-keyed cumulative-snapshot pseudonym;
- `open_tasks`: source ordinal plus secret-keyed task pseudonym;
- `dedupe_keys`: fixed kind plus secret-keyed/source-scoped occurrence key, retained only if still required after source-occurrence analysis; and
- `source_diagnostic_counts`: source ordinal, reviewed code, non-negative count.

Raw session IDs, parent IDs, tool names, turn IDs, model strings, paths, and source content never enter these tables. Source paths remain private workspace-only source-plan evidence under the existing contract.

## Atomic batch contract

`commitSourceBatch` accepts:

1. source key plus the expected prior checkpoint sequence, phase, byte offset, and physical line ordinal;
2. at most 1,000 validated safe-record envelopes;
3. the exact next byte offset and next physical line ordinal at a completed-line boundary;
4. the next strict parser state;
5. fork-snapshot inserts, open-task changes, and reviewed diagnostic deltas;
6. cumulative resource deltas; and
7. an optional source-complete transition.

One `BEGIN IMMEDIATE` transaction verifies the expected checkpoint, inserts all safe records and state mutations, advances the checkpoint, and commits. A crash leaves either the old checkpoint and zero new effects or the new checkpoint and all effects. Every batch also has a deterministic full-batch SHA-256: an exact retry of the most recently committed batch returns the already-committed checkpoint without applying effects twice, while any stale or conflicting retry fails closed.

The post-read same-descriptor prefix verification remains mandatory. Any integrity failure permanently poisons the workspace. Restoring the file cannot resume or publish it.

## Tier and fork preparation

Tier lookup must preserve current semantics, which select the latest setting by timestamp and physical ordinal rather than assuming file order. A bounded first pass stores only fixed safe tier rows and is source-integrity checked before `tier_ready`. Resume never repeats a completed tier pass.

Parents remain ordered before children. Each cumulative snapshot is converted immediately to a secret-keyed pseudonym and inserted on the child source. Fork replay membership is answered through the source-plan parent chain and disk-backed snapshot rows; the scanner never retains all ancestor keys in a JavaScript graph.

Copied parent tool-call records are handled the same way. The legacy safe scanner counted a copied parent tool again in the child even while suppressing the copied cumulative usage snapshot. The checkpoint scanner intentionally corrects that inconsistency by storing a secret-keyed tool snapshot and excluding an inherited copy from child tool counts. This behavior change is compatibility-bound by the checkpoint scan version, produces a reviewed diagnostic, and has a dedicated regression test; legacy byte parity is required everywhere except this explicitly approved correction.

## Parser loop

The bounded line reader will expose `{line, startByte, endByteExclusive, lineOrdinal}` and accept a verified `startByte`/`startLineOrdinal`. Oversized irrelevant lines still advance byte and physical-line cursors. Relevant or ambiguous oversized lines still fail closed.

At every completed line, the parser has a coherent checkpoint candidate. It commits when any of these is true:

- 1,000 safe records are pending;
- a bounded byte/line work interval is reached;
- the source ends; or
- an explicit failpoint requests a crash test.

No checkpoint may split the quota snapshots and usage event derived from one token-count line.

## Cumulative resources

The workspace stores monotonically increasing source and export totals. Resume initializes the resource guard from those totals rather than zero. Per-invocation wall duration remains separately observable, while the acceptance limit applies to declared cumulative work. Workspace/database/journal/temp growth must be reserved or engine-limited before commit rather than discovered only afterward.

## Implementation sequence

1. Add positioned bounded-line iteration and boundary invariance tests.
2. Version the workspace schema and add strict source checkpoint/tier/snapshot/task/resource tables.
3. Add atomic `commitSourceBatch`, expected-digest concurrency checks, poison handling, and failpoints.
4. Extract safe model, token-delta, tier, tool-count, and snapshot-key primitives without changing legacy scanner output.
5. Implement tier preparation and source-resumable Codex export parsing behind the existing safe-record adapter.
6. Remove export-path whole-run event/tool/fork sets and prove heap state is bounded by batch/fixed parser state.
7. Persist and enforce cumulative restart accounting plus pre-commit disk reservation.
8. Run equivalence, adversarial, heavy-history, clean-runtime, and golden-hash gates before declaring G1-R3 complete.

## Acceptance matrix

- Byte-for-byte logical-record and diagnostics equivalence with the current scanner on independently shaped fixtures, except for the approved copied-parent-tool correction above.
- Identical output across adversarial one- and two-line checkpoints, the default bounded line batch, and safe-record transaction boundaries up to exactly 1,000 records.
- Identical output after a crash at every line-derived output position and every transaction failpoint.
- Correct resume after context-model, tier-setting, cumulative-token, tool-only, task-open, quota-plus-usage, malformed, and oversized-irrelevant lines.
- Fork replay equivalence for parent, child, missing parent, excluded parent, and multi-generation lineage.
- Traversal-order and active/archive invariance; duplicate session identity remains fail closed.
- Source append exclusion and permanent poison on mutation, truncation, replacement, link, owner, or post-read integrity failure.
- No raw model, session, parent, task, tool, path, content, or account values in checkpoint tables, errors, CLI output, manifests, or receipts.
- Resource totals never decrease or reset across resume; limits fail before an ambiguous commit.
- Measured heap remains bounded as tool-only, snapshot-heavy, and fork-heavy fixture size grows.
- Full existing suite, telemetry contract check, focused code/performance/test/plan audits, clean-runtime smoke, and dated verification receipt pass.

## Explicit non-completion

This plan does not complete G1, ingestion, aggregation, or the end-to-end objective. Compression, deletion, native secrets, Claude parity, signed distribution, volunteer-local review, consent, encryption, server validation, private results, publication, ongoing upload, and incident operations remain separately gated.

## Verification status

The checkpoint candidate has passed its complete bounded 30-day local-history gate: 1,349 files, 21,558,342,764 source bytes, and 395,520 safe records. A failed attempt exposed descriptor-ownership/error-masking and broad activity-prefilter defects; the corrected scanner resumed the same committed workspace and completed. The marker correction is compatibility-bound as checkpoint scan v0.2 and legacy Codex scan v5, and exact structural/cross-chunk regressions protect the canonical compact JSONL assumption. The dated [verification receipt](../receipts/2026-07-24-g1-source-checkpoint-verification-receipt.md) contains the exact resource and recovery evidence. The remaining acceptance work is the broader failpoint/crash matrix, near-ceiling and asymptotic resource evidence, source-set deletion/recovery, compression/bomb bounds, and the other G1 boundaries listed above.
