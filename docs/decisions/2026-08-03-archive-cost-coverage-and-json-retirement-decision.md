---
title: Archive Cost Coverage and JSON Retirement Decision
date: 2026-08-03
type: decision-record
status: complete
---

# Archive cost coverage and JSON retirement decision

## Decision

Local historical cost indexing is an owner-only SQLite process, separate from
the responsive foreground collector. It is coverage-aware and resumable: the
only stable archive states exposed to the product are **complete** and
**partial**; **scanning** is an active refresh state. The current cost display
continues to identify its bounded 31-day cache. This implementation is a
coverage gate before a future all-history aggregate, and it must never call an
incomplete archive prefix an all-time total.

The operating envelope is intentionally explicit:

| Bound | Value | Purpose |
| --- | ---: | --- |
| First scheduled source parse | 128 MiB | Publishes useful durable progress promptly. |
| Later scheduled source-parse budget | 1.5 GiB | Lets a genuinely incremental pass catch up efficiently. |
| Directory entries discovered | 500,000 | Prevents unbounded recursive traversal. |
| Rollout files selected | 125,000 | Prevents unbounded source/fact growth in one refresh. |
| Archive pass wall time | 5 minutes | Preserves a cancellable interactive operation. |
| Durable commit slice | at most 128 MiB | Makes completed prefixes survive timeout or interruption. |
| Free-space reservation | existing index + pass budget + 128 MiB | Ensures a staged next SQLite generation is not begun without conservative local disk headroom. |

An archive pass stores HMAC-scoped source identities, complete-line offsets,
compact usage/quota facts, and content-free coverage metadata. It does not
store source paths, filenames, raw session identifiers, prompts, responses, or
raw JSON. On cancellation, timeout, or discovery-cap exhaustion the index is
marked partial; a later pass resumes from committed offsets. A cap is a
truthful partial-coverage result, not permission to extrapolate an all-history
cost.

Before an archive pass creates its staged SQLite generation, it checks the
filesystem's available blocks against the existing generation, the selected
parse budget, and a 128 MiB reserve. Insufficient space becomes fixed
`archive_disk_space`; unmeasurable storage becomes
`archive_storage_unavailable`. If there is enough room for a tiny marker it is
persisted for the next resume; if not, the active refresh still returns partial
rather than claiming any all-history result.

The parse budget counts scheduled JSONL source chunks. Small source-identity
and lineage preflight reads are separate; finalized JSONL files take a
one-byte terminal-newline check and the five-minute deadline is the outer
backstop for the whole operation. It is therefore not presented as a strict
OS-level total-read meter.

## Why discovery limits are raised but other foreground bounds remain

The foreground collector now shares the 500,000-entry / 125,000-rollout-file
discovery limits. Otherwise its old 20,000 / 5,000 guard could reject a
refresh before the qualifying archive index got a chance to run. The foreground
collector still keeps separate recent-window byte, record-batch, line-size, and
checkpoint bounds, but its records, source-tail/deduplication cursors, current
quota observations, diagnostics, accounting projection, and instance lock now
share one transactional SQLite database. The archive index has a different
bounded SQLite data model, durable intra-pass commits, and a visible partial
state.

Removing caps altogether is not acceptable: a malformed, unexpectedly large,
or highly nested Codex tree could turn one dashboard refresh into unbounded
directory traversal, source reads, temporary SQLite work, and recovery time.
The new values are deliberately generous, not a claim that all local histories
can be read without a resource boundary.

## JSON and SQLite retirement decision

The application-owned collector state is now fully retired from JSON/JSONL.
`local-collector-state-v1.sqlite` is the one source of truth for collector
records, checkpoints/cursors, dedupe keys, app-server quota observations,
diagnostics, the replay-safe accounting cache, and the single-instance lock.
Each record batch and its updated checkpoint commit in one SQLite transaction.

At first normal read or write, the migration resolves an old prepared journal,
streams the owner-only legacy JSONL ledger, compares canonical record digest,
count, checkpoint, and accounting-cache parity, and persists a
`parity_verified` receipt in SQLite before deleting anything. Cleanup is exact
to the six remaining managed basenames after journal recovery (ledger,
projection, checkpoint, lock, and two accounting caches), and resumable: an
interruption after the receipt completes cleanup on the next startup without
rereading a partly deleted ledger. A live legacy JSON lock blocks migration;
a verified stale lock is removed only after the parity receipt exists. A
mismatch, unsafe file, malformed journal, or failed import leaves legacy files
in place and fails closed.

Migration itself is serialized by a short-lived owner-only lease that is taken
before the normal collector instance lock. Concurrent startup waits for that
lease rather than competing for the SQLite writer during import. A legacy JSONL
row must be a valid object and fit the 16 MiB row ceiling; malformed, oversized,
or over-budget legacy ledgers are retained for repair and never silently
retired. `complete` is written only after every managed legacy candidate is
absent. A dry run remains `parity_verified`, and a current-format complete
receipt fails closed if a named legacy artifact reappears.

Raw Codex rollout JSONL remains intentionally untouched because it is external
input owned by Codex, not app-managed state. The CLI may still accept an
explicit `--collector-file` as a supplemental external input, but normal local
collection, dashboard reads, and replay-safe accounting no longer write or
read managed JSON state. The retired `--checkpoint-file` and `--lock-file`
collector flags are rejected; `--state-file` selects the one SQLite database.

Normal CLI crosscheck and quality reporting stream rows from SQLite rather than
loading the collector ledger as one JavaScript array. Exact rollout-staleness
percentiles are ordered by SQLite. `collector-state-status` provides a
content-free size/range diagnostic, while `plan-collector-retention --before
ISO_TIMESTAMP` returns an immutable candidate count/byte/digest plan. Neither
command archives, compacts, or deletes data: an opt-in archival and
receipt-backed removal workflow remains a future lifecycle change.

## Verification

The implementation is covered by focused archive resume/privacy, disk-headroom,
analysis-index partial-marker, discovery-cap, SQLite collector
atomicity/lease/parity/interrupted-cleanup/malformed-ledger, streaming-report,
retention-plan, local refresh/data, server integration, and browser-client
normalization tests. A release should additionally exercise a capped discovery
corpus, an interrupted multi-slice archive run, and a disk-pressure pass on a
representative local history.
