---
title: Milestone 3 Passive Local Collector Decision
date: 2026-07-23
type: decision-record
status: accepted
---

# Milestone 3 Passive Local Collector Decision

## Decision

**Proceed** to Milestone 4, the controlled micro-workload harness.

Foreground behavior is proven for a bounded local smoke. Persistent installation remains out of scope and was not performed.

## Implemented collector modes

### Run once

- Discovers active and archived rollout JSONL read-only.
- On first non-backfill start, seeds active model/cumulative state from a bounded tail and checkpoints existing files at EOF.
- Reads only complete new lines from byte offsets; a partial final line stays unread until completed.
- Detects truncation, replacement/new files, and archive movement.
- Deduplicates active/archive copies and privacy-sanitized event identities.
- Refreshes `account/rateLimits/read` only when the latest quota observation is stale, absent, or the caller explicitly sets a zero threshold.
- Atomically flushes owner-only event and checkpoint files before releasing its lock.

### Foreground

- Holds one Codex app-server process/connection.
- Consumes `account/rateLimits/updated` when emitted.
- Watches active and archive directories and uses a 60-second reconciliation interval by default.
- Reconnects with exponential backoff capped at 30 seconds.
- Forces a read-only rate-limit refresh after reconnect.
- Exits cleanly on an abort signal, `SIGINT`, or `SIGTERM` and removes its lock.

No collector path invokes a model-turn, thread, prompt, or response method.

## Source and staleness model

Every effective record carries observation time, receipt time, non-negative staleness, and one source:

- `rollout_token_count`;
- `rollout_tool_call` with only an aggregate tool class;
- `app_server_notification`;
- `app_server_read`.

Clock reversal is clamped to zero staleness. A reset change observed after offline time is retained as a separate reset identity.

## Restart and error behavior

- Checkpoints contain byte offsets, previous cumulative token counters, current model, filesystem inode/birth-time cursor keys, hashes of sanitized events, last quota time, and aggregate diagnostics.
- Checkpoints do not contain rollout paths, filenames, session IDs, prompts, responses, tool names/arguments, or account identifiers.
- A normal restart produces no duplicate effective records.
- Lock contention fails safely; a lock owned by a confirmed-dead PID is recoverable.
- Error codes distinguish app-server absence, authentication failure, malformed output, request failure/timeout, and temporary disconnect without saving stderr.

## Tests

Collector tests cover:

- restart from checkpoint without duplicates;
- first-start EOF model/cumulative seeding;
- a partial final line completed later;
- truncation;
- archive movement;
- active/archive duplicates;
- clock reversal and reset change while offline;
- duplicate notifications;
- authentication failure with checkpoint preservation;
- lock contention and stale recovery;
- disconnect, reconnect, forced refresh, duplicate notification suppression, and clean abort.

The complete current Node suite passes: 37 tests, zero failures, zero skips.

## Live gate

- Initial `run-once` checkpointed 2,349 existing rollouts at EOF and made one stale/absent read-only refresh.
- The refresh captured the canonical weekly `codex` window at 98% and the separate named `codex_bengalfox` weekly window at 0%; the buckets were not pooled.
- Subsequent refresh-disabled runs tailed real rollout token/tool records from saved offsets.
- A three-second foreground smoke captured two real rollout records and one app-server read, then exited cleanly with no reconnect.
- A five-second foreground resource smoke at the default 60-second reconciliation cadence exited cleanly. It used 0.12 seconds user CPU and 0.07 seconds system CPU over 5.04 seconds wall time; maximum resident set size was 77,578,240 bytes. The active Codex work generated records during the smoke, so it was not a stationary no-event interval.
- A follow-up five-second stationary smoke used an empty watched rollout tree with the real app-server connection. It wrote zero rollout records and one initial read, performed one initial ingestion, two checkpoint writes, zero watcher events, and zero reconciliation cycles at the 60-second cadence. It used 0.07 seconds user CPU and 0.04 seconds system CPU over 5.03 seconds wall time; maximum resident set size was 70,909,952 bytes. The two owner-only output files were 739 and 621 bytes, and the lock was removed.
- Both event and checkpoint files are mode `0600`; the lock was absent after shutdown.
- Codex `config.toml` and `auth.json` modification times and sizes were unchanged across an additional collector run.
- Privacy searches found no local path, rollout/lineage field, call ID, arguments, working directory, prompt/response field, or account/user/device identifier in the event or checkpoint artifacts.

## Live correction note

The first smoke started before active-file model seeding was implemented, so 22 append-only usage records were labeled `unknown`. The parser was then fixed and tested; subsequent live records were attributed to Sol or Terra. The early records were not rewritten.

**Correction addendum:** the original forward-looking proposal to put these records in the Milestone 7 observation ledger is superseded. A forensic review found that the 22 records total 3,714,307 tokens (77,749 uncached input, 3,614,208 cache-read input, 18,571 text output, and 3,779 reasoning output) and are consumed by none of the canonical report, transition, inference, contamination, experiment, tool, or observation-correction paths. Their privacy-minimized records lack a defensible source linkage for model re-attribution. They remain immutable operational provenance rather than receiving a semantically invalid observation correction. If collector events become an analytical input later, they require a separate event-disposition ledger keyed to privacy-safe source evidence.

## Gate consequence

Milestone 4 may use run-once before/after captures and explicit controlled-state labels. It must dry-run and enforce stop budgets before any live workload, and it must not install the foreground collector persistently without a separate user request.
