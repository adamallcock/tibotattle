---
title: G1 Source Checkpoint Verification Receipt
date: 2026-07-24
type: verification-receipt
status: verified-slice
---

# G1 source checkpoint verification receipt

## Decision

The local Codex export path now has a verified disk-backed per-source checkpoint implementation. A committed batch atomically advances safe records, exact byte and physical-line cursors, closed parser state, safe tier rows, fork snapshots, open-task pseudonyms, reviewed diagnostics, and durable resource totals. A fresh process resumes parsing from the committed cursor rather than rebuilding committed parser state from byte zero.

This is a verified G1-R3 slice, not G1-R3 completion, G1 completion, or authorization to collect volunteer data. Telemetry v0.1 remains local-only and `transportReady: false`; there is still no enrollment, upload, network destination, or server ingestion path.

## Implemented boundary

- Workspace schema v0.2 is bound by application/user versions plus an exact SHA-256 of all non-internal SQLite schema definitions. Table, index, hidden/generated-column, trigger, view, foreign-key, and integrity tampering fails closed.
- Source-plan v2 binds parent/fork relationships as well as complete-line prefix identity. Parents run before children; cumulative-usage and copied-tool snapshots use domain-separated HMAC keys rather than raw provider identifiers.
- The tier prepass and record pass persist exact byte/line cursors. Tier-to-record transition proves that the tier pass reached the frozen prefix end, and record completion proves the final cursor reached the source prefix.
- Parser state is a closed, canonical shape containing only reviewed model declaration, cumulative usage/presence, fixed tier state, and coarse pending tool counts.
- Transactions accept at most 1,000 safe records and a bounded aggregate of index/task changes. Exact retry of the last committed batch is idempotent; stale or conflicting progress fails closed.
- Resource limits and absolute durable totals survive restart. SQLite page ceilings and conservative pre-commit reservations protect workspace growth; materialization enforces the persisted record, bundle, and workspace limits before publication, including the mandatory empty-set chunk.
- Source mutation, truncation, replacement, unsafe links/ownership, post-read mismatch, or unresolved resume identity poisons or rejects the workspace with content-free errors.
- The legacy scanner's copied-parent-tool double count is intentionally corrected: copied parent tools are excluded from the child's tool attribution just as copied cumulative usage is excluded. The behavior change is compatibility-bound and diagnostic-visible.

## Automated evidence

- Full serial repository suite: 327 passed, 0 failed.
- Telemetry generation and contract suite: current at 151 reviewed fields; 9 passed, 0 failed.
- Exact checkpoint/legacy parity covers recognized and invalid models, missing token components, out-of-order tiers, malformed input, quota-plus-usage lines, parent/child cumulative replay, tools, tasks, line batches of one and two, and multiple interruption positions.
- A literal logical-record SHA-256 golden is checked independently of current-run equality.
- A parent-driven `SIGKILL` after an acknowledged committed batch leaves an incomplete workspace that a separate process resumes to byte-identical control records and diagnostics without duplicate IDs.
- A 64 MiB old-space gate passes for 3,000 task/tool/usage cycles, 20,000 simultaneously open tasks at the default 8,192-line batch, and 10,000 inherited cumulative snapshots across a parent/child fork.
- Populated checkpoint databases, materialized bundles, receipts, manifests, process output, and errors are scanned for fixture canaries; none survive. Local-only source paths remain documented workspace evidence and are never materialized.
- Schema adversaries include an added ordinary column, added generated column, view, trigger, and same-name altered index.
- `git diff --check`: passed.

## Real local smoke

A fresh isolated run used one real 151,713,646-byte Codex rollout:

- source files: 1;
- safe records: 6,836 total (3,350 usage and 3,486 quota);
- complete workspace creation: 2.662 seconds;
- completed-workspace resume: 90 milliseconds;
- materialization: one local chunk;
- independent complete-set verifier verdict: passed;
- durable physical-line work: 14,594 across the tier and record passes plus discovery;
- durable expanded safe-record bytes: 6,332,212;
- observed peak RSS high water: 396,427,264 bytes; and
- conservative workspace high-water reservation: 19,918,904 bytes.

The isolated source matched the earlier legacy/checkpoint record-count comparison. All temporary source copies, workspaces, output chunks, and the earlier incomplete full-history smoke workspace were deleted after inspection; they were never transmitted.

## Independent audit disposition

Three focused subagent passes audited workspace correctness, scanner/resource behavior, and crash/test evidence. Their findings drove copied-tool replay handling, durable final invocation accounting, lineage digest binding, EOF transition proof, exact schema hashing, source poisoning, checkpoint scan compatibility, index/query fixes, transaction ceilings, real `SIGKILL` recovery, populated-state privacy scans, stronger default-batch heap cases, persisted materializer limits, and empty-set pre-publication enforcement.

The final workspace/materializer audit reported its blockers closed. The scanner audit confirmed the relevant snapshot and pending-source indexes are used and the 1,000-record boundary is preserved. No unresolved critical correctness defect is known in this slice.

## Explicit remaining blockers

This receipt deliberately does not claim the full heavy-history gate:

1. An earlier 1,404-source, approximately 21.7 GB smoke under an older 256-line checkpoint default ran for 240.84 seconds and then encountered `EBADF`. The exact failure was not reproduced on the isolated large source and has not been proven resolved across the full current history. A clean current-code multi-source benchmark remains required.
2. Resume still re-discovers and cryptographically verifies frozen source prefixes. Parsing resumes at the checkpoint, but source-integrity hashing still reads source bytes and its amplification must be measured on the full history.
3. Fresh-process crash coverage now proves a real record-batch kill, but the complete matrix still needs tier-only, tier-to-record, pending-model/tool/task, parent-child boundary, source-complete-before-finalize, activity-marker, and materializer transaction boundaries.
4. The heap gates cover substantial fixed scales, not a measured asymptotic slope or every configured maximum. Near-ceiling open-task, maximum relevant-line, deeper fork, and many-source cases remain.
5. Source-specific deletion/recovery, canonical compression and bomb limits, pilot-derived ceilings, native platform secret stores, Claude parity, prospective account-scoped quota evidence, signed clean-machine distribution, and two local-only volunteer reviews remain open before G1.
6. Every cloud and multi-user stage—consent, enrollment, encryption, ingestion, quarantine, canonical storage, personal results, disclosure-controlled aggregation, publication, ongoing collection, participant deletion, and incident operations—remains closed and pending.
