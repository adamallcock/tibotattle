---
title: G1 Disk-Backed Export-Set Verification Receipt
date: 2026-07-24
type: verification-receipt
status: verified-foundation
---

# G1 disk-backed export-set verification receipt

## Decision

The local-only disk-backed export-set foundation is implemented and verified as a reviewable checkpoint. It is not G1-R3 completion, not G1 completion, and not authorization to collect or upload user data.

The implementation keeps `transportReady: false`. No enrollment, uploader, network destination, server ingestion, shared storage, public aggregate, notification service, or background uploader was added.

## Implemented boundary

- A provider-neutral awaited safe-record adapter emits only schema-validated metadata records.
- Complete-line Codex source prefixes are hashed and bound into a private source plan. Prefixes are verified before reading and rehashed on the same file descriptor after parsing; post-plan appends are excluded.
- A post-read source-integrity failure permanently poisons the incomplete workspace; restoring the source bytes cannot resume or publish already-committed mutation-derived rows.
- A normalized privacy-safe activity-marker digest is bound to the workspace and changed resume input fails closed.
- Owner-only SQLite state stores safe records, diagnostics, source evidence, chunk state, and manifest state in bounded transactions under an exclusive recoverable lease.
- Deterministic total ordering, HMAC set/chunk identities, exact incremental canonical-byte accounting, greedy bounded chunks, receipt-first pair publication, and manifest-last completion produce restartable local sets.
- A standalone strict manifest contains no paths or filenames. A standalone verifier infers fixed names, verifies every bundle/receipt pair and shared contract, checks global order and pseudonymous ID uniqueness with a bounded temporary SQLite index, checks greedy boundaries and the chunk-independent logical digest, and removes its temporary index even when a resource limit fires.
- CLI creation, inspection, resume, and verification print only bounded content-free summaries.

## Automated evidence

- Full suite: 294 passed, 0 failed.
- Telemetry contract check: current, 149 reviewed fields, 9 focused schema/contract tests passed.
- Export-set regression coverage includes changed-marker resume rejection, source mutation/truncation/replacement/symlink and same-handle post-read mutation, workspace contention/dead-lock recovery, every controller and set-materializer failpoint, deterministic chunk-size invariance, manifest receipt tampering, manifest symlink refusal, cross-chunk duplicates/order, non-maximal chunks, forced verifier-index resource cleanup, and CLI create/resume/verify behavior.
- `git diff --check`: passed.

## Real local smoke

A fresh ignored local run covered 2026-07-24 23:00:00–23:24:52 UTC:

- six frozen source files and 151,010,466 prefix bytes;
- 222 usage records, 227 quota records, and zero activity markers;
- one 504,613-byte canonical bundle and a 5,057-byte complete-set manifest;
- a 741,376-byte SQLite workspace;
- independent `verify-export-set` verdict: passed;
- every workspace, chunk, receipt, and manifest file: owner-only mode `0600`; and
- repeated `--resume`: byte-identical published artifacts.

The smoke artifacts live only under ignored `.usage-monitor/` and `exports/` paths and were not transmitted.

## Independent audit disposition

Code-quality, performance, tests/docs, and plan-completeness subagents reviewed the diff. Their material findings drove marker-plan binding, post-read source verification and permanent workspace poisoning, precise recovery handling, pre-publication chunk limits, verifier runtime/RSS/record/temp-disk accounting and cleanup, linear exact chunk packing, full crash-failpoint tests, CLI subprocess coverage, and removal of foreground-test timer races.

The remaining high-risk items are acceptance blockers for G1-R3 rather than hidden claims of this checkpoint:

1. Global fork lineage, replay IDs, and tool-call state remain on the JavaScript heap. They need disk-backed or explicitly capped state before heavy-history acceptance.
2. Initial and resumed scans still make multiple full source passes. True per-source byte/line/parser/tier/cumulative-token/tool/fork checkpoints and cumulative cross-restart resource accounting remain required.
3. SQLite workspace disk enforcement is currently post-batch. A pre-commit database/journal/temp reservation or engine-level ceiling remains required.
4. Heavy-history and clean-runtime benchmarks, checked-in golden set hashes, disk-backed activity-marker ingestion, set-specific deletion/recovery, and remaining semantic tamper fixtures are open.

Later G1 work remains unchanged: canonical compression with independent expanded/decompression limits and bomb tests; crash-recoverable local deletion; pilot-derived limits; native platform secret stores and clean-machine validation; Claude parity; prospective account-scoped app-server quota records; minimization ablation; signed packaging/SBOM; and two local-only volunteer reviews. All ingestion, consent, encryption, validation/quarantine, private results, aggregation, publication, ongoing collection, deletion, and incident-response gates remain later and closed.
