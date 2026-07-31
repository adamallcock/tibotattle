---
title: Local Analysis Performance and Persistent Index Plan
date: 2026-07-29
type: plan
status: completed
---

# Local Analysis Performance and Persistent Index Plan

## Outcome and stop condition

The local-analysis pipeline must preserve the current replay-safe accounting,
quota, calibration, and dashboard behavior while making a virgin analysis of
the same local corpus complete in **15–20 seconds**.

The performance program stops only when all of these conditions are met:

- a virgin run starts with no Usage Monitor accounting index, derived cache, or
  dashboard projection;
- the source corpus and fixed analysis interval are the same as the baseline;
- the median of three measured virgin runs is at most 20 seconds, with every
  run reported rather than only the fastest;
- replay exclusion, cumulative-token differencing, model/tier attribution,
  component pricing, quota matching, weekly calibration, and dashboard
  projections are equivalent to the existing implementation;
- incremental refresh does not scan unchanged source bodies;
- cached relaunch does not parse the append-only collector ledger;
- peak resident memory is lower than the measured 1.45 GB baseline, with a
  target below 512 MB;
- raw prompts, responses, commands, paths, filenames, repository names,
  account identifiers, and source session identifiers never enter the index;
  and
- interrupted builds retain the prior valid generation and can resume without
  double counting.

“Virgin” describes application state, not an artificial operating-system
cache purge. The benchmark report must state whether source bytes were warm or
cold in the filesystem cache and must not claim physical cold-disk behavior
without measuring it.

## Measured baseline

The 2026-07-29 fixed-window profile used Node 26.2.0 and a local Codex corpus of
3,036 JSONL files totaling about 40 GB:

| Path | Measured wall time | Peak RSS / retained size | Important evidence |
|---|---:|---:|---|
| Virgin 31-day replay-safe accounting | 177.79 s | 1.45 GB RSS | 170.07 s, or 95.65%, was source scan and projection |
| 7-day bounded collector backfill | 132.64 s cumulative | 876.95 MB ledger | 11 bounded invocations to ingest 736,507 records |
| Transition derivation | 6.17–6.69 s | Included above | Quota matching added about 0.52 s |
| Current invalid-cache relaunch | 5.32 s mean | 411 MB ledger reparsed | Current cache failed validation |
| Valid-cache relaunch | 0.66 s mean | 411 MB ledger reparsed | Usage summary was skipped, but projection still parsed every row |
| Snapshot without ledger projection | 14–17 ms | Small | Establishes the cached-backend lower bound |
| Headed browser projection | 71 ms mean | 1.18 MB decoded | No browser task at or above 50 ms |

Discovery, final JSON serialization, and browser rendering are not primary
virgin-build bottlenecks. Source-body parsing, repeated scans, retained
transition inputs, and unnecessary relaunch ledger projection are.

## Ranked implementation findings

### Rank 1 — Persistent incremental file and accounting index

Build an owner-only, local, transactional index that records source identity,
safe cursors, compact accounting facts, and derived rollups. A refresh reads
only appended or invalidated source regions. This is the enabling
architectural change for the 15–20 second target and for consistently fast
future refreshes.

### Rank 2 — Serve the last valid generation and coalesce refresh

Startup and explicit refresh return the newest valid dashboard generation
immediately. At most one accounting update runs in the background. Multiple
refresh requests join that update rather than launching duplicate scans. A
failed update preserves the prior valid generation and exposes a fixed,
content-free diagnostic.

### Rank 3 — One source pass with streaming derivation

Eliminate the separate per-file tier-timeline pass and the later full parse.
Update model/tier state, cumulative snapshots, replay attribution, compact
events, quota matches, and rollups from one ordered stream. Retain bounded
state keyed by privacy-scoped identifiers, not arrays of all raw usage and
quota inputs.

### Rank 4 — Non-blocking invalid-cache migration

Schema or validation failure marks an old generation unusable without forcing
the foreground launch to parse the collector ledger or rebuild 31 days.
Startup serves the newest earlier valid generation when one exists, or a
bounded “analysis building” projection when it does not, while regeneration
runs through the single-flight updater.

### Rank 5 — Persist the dashboard projection

Store the closed browser-facing overview, periods, timeline, quota timeline,
weekly calibration, freshness, and diagnostics with the committed index
generation. Cached relaunch reads this small projection directly and never
replays the collector JSONL.

## Persistent index design boundary

### Trust and ownership boundary

- The index lives only under the owner-only Usage Monitor state directory.
- The database file, write-ahead log, shared-memory file, lock, and exported
  projection use owner-only permissions.
- The browser cannot supply a source root, path, cursor, SQL fragment, or
  arbitrary filter.
- No index table stores a raw source path, filename, line, JSON payload,
  prompt, response, command, tool argument, URL, repository, account identity,
  or unscoped source/session identifier.
- Source and lineage identifiers are fixed-length HMAC values under a local
  secret. A database copied without that secret cannot be joined to Codex
  source identities.
- The index is never uploaded or included in contribution preparation.

### Source identity and cursor

Each discovered source is represented by:

- an HMAC-scoped stable source key;
- filesystem device/inode and birth time when available;
- last observed size and modification time;
- a bounded prefix/source-identity digest;
- last committed complete-line byte offset;
- a bounded trailing-fragment digest and length;
- first and last retained event times;
- HMAC-scoped lineage parent/root keys;
- the latest cumulative token components, model, service tier, and speed state;
- generation first seen, last checked, and invalidated generation; and
- a state enum: active, archived alias, missing, replaced, truncated, invalid,
  or complete.

Paths are used only transiently during discovery and scanning. They are never
bound into persistent SQL values or error messages.

### Content-free facts

The durable fact stream contains only values needed to reproduce current
output:

- event time bucket and deterministic content-free event digest;
- HMAC-scoped source/root/parent keys;
- model family and normalized model identifier from the closed allowlist;
- Standard/Fast speed and API service tier enums;
- direct/subagent and replay-excluded lineage enums;
- input, cache-read, cache-write, output, reasoning, and total-token deltas;
- price-registry lookup key and pricing coverage enum;
- bounded API-price-equivalent component costs;
- weekly quota slot, used percent, reset epoch, duration, plan enum, and
  historical-unattributed marker; and
- source-generation and derivation-version provenance.

The index keeps compact facts independently from priced rollups so a price
registry change can reprice retained facts without rereading raw JSONL.

### Derived state

The committed generation includes:

- 15-minute usage and component rollups;
- daily, 24-hour, 7-day, 30-day, and covered-window rollups;
- bounded quota timeline buckets;
- replay-safe transition and weekly-calibration inputs/state;
- the closed dashboard projection;
- public content-free diagnostics; and
- source, parser, price-registry, schema, and projection versions.

No derived row becomes visible until the generation commit succeeds.

### Ordering, invalidation, and crash safety

- Discover and group lineage before applying child deltas.
- A parent replacement, truncation, identity change, or earlier-byte mutation
  invalidates that source and every indexed descendant.
- An archive move with matching identity becomes an alias and does not replay
  facts.
- Appends begin from the last committed complete-line offset. Partial trailing
  lines remain uncommitted.
- Source metadata is checked again before committing. A changed source is
  retried in the next generation rather than mixed into the current one.
- Updates run in one writer transaction. Readers use the prior committed
  generation until the new generation and dashboard projection are complete.
- Startup checks database integrity and version compatibility. Corrupt or
  incompatible state is quarantined by fixed error code and rebuilt without
  deleting raw sources or the last separately valid projection.
- Cancellation or process death rolls back the uncommitted generation.

### Bounded memory and backpressure

- Read source bytes in bounded chunks and split only complete JSONL records.
- Project an accepted source record immediately into closed scalar fields.
- Write compact facts in bounded transactions; do not retain the 31-day event
  set or collector ledger in memory.
- Transition derivation consumes ordered fact batches and persists its bounded
  continuation state between batches.
- Dashboard rollups are updated per fact or per bounded batch.
- Writer backlog applies backpressure to source readers.
- Memory and work ceilings remain fail-closed and emit fixed diagnostics.

### Compatibility and rollout

- The existing JSON accounting cache remains a read-only compatibility input
  during migration, never the system of record.
- A virgin build writes a new index generation and then atomically publishes
  its closed dashboard projection.
- Existing collector checkpoints remain valid until indexed collection proves
  parity; migration does not rewrite their source cursors.
- The current full scanner stays available behind an explicit verification
  path until golden-corpus and real-corpus parity are demonstrated.
- Rollback selects the last compatible committed generation. It never attempts
  to reconstruct private source references from hashed index values.

## Package decision criteria

Candidate packages or platform facilities will be measured and checked for:

1. throughput on representative JSONL lines and transactional fact writes;
2. bounded-memory streaming and backpressure;
3. deterministic ordering and integer correctness;
4. crash recovery, WAL behavior, and corruption handling;
5. Node 24 and Node 26/macOS arm64 support;
6. native-binary, ABI, signing, notarization, and supply-chain cost;
7. maintenance activity, license, and primary-source documentation; and
8. whether the dependency materially improves measured wall time over Node
   built-ins.

No package will be added for a speculative parsing micro-optimization. The
selection must beat the built-in baseline on the actual hot path or remove
substantial implementation and correctness risk.

## Benchmark matrix

| Scenario | Required measurement |
|---|---|
| Virgin | Empty Usage Monitor index/cache/projection; same corpus and interval |
| Incremental no-change | Existing index; no source-body append |
| Incremental typical | Existing index; representative complete appended lines |
| Replacement/truncation | Parent and descendant invalidation plus parity rebuild |
| Cached relaunch | Valid committed generation; no collector/source body scan |
| Invalid cache/index | Foreground response plus one coalesced background rebuild |
| Cancellation/crash | Prior generation remains readable; resumed output has no duplicates |

Each run records wall time by stage, bytes read, records parsed/accepted,
transactions, event-loop delay where relevant, peak RSS, final artifact sizes,
versions, and output digests. Performance claims require functionality digests
or field-level parity, not only faster completion.

## Completion

The stop condition was reached on 2026-07-29. The final capped 10-worker
configuration completed three virgin runs in 18.89, 18.79, and 19.38 seconds
(18.89-second median) while preserving the fixed-window accounting receipt.
Peak RSS was 1.386–1.399 GB, below the 1.45 GB original baseline. The durable
index was 172–173 MB.

The implemented boundary uses:

- source-affine worker shards with explicit V8 heap limits and bounded 4 MB
  reads;
- owner-only HMAC source keys and boundary proofs, with no durable paths,
  filenames, raw identifiers, or JSON;
- exact compact per-source cumulative snapshot sets and diagnostic timestamp
  streams instead of per-event B-tree rows;
- append-only source cursors, exact per-generation lineage recomputation after
  replacement or truncation, integrity validation, file synchronization, and
  atomic generation replacement;
- one-pass tier/model/token/quota extraction and exact tuple replay matching;
- fused virgin derivation and dashboard projection, avoiding a second
  626,000-row database pass;
- a committed replay-safe projection used when the JSON compatibility cache is
  missing or malformed; and
- a content-free collector dashboard projection that reduced an unchanged
  393 MB ledger relaunch from 652 ms to 13.8 ms in the measured clone.

The 512 MB RSS value remains a future architectural target, not a condition
claimed by this implementation. Reaching it would require moving transition
state and more derivation into resumable on-disk batches; that change is not
justified after meeting the requested wall-time band and lowering the original
memory baseline.

See the
[performance receipt](../receipts/2026-07-29-local-analysis-performance-receipt.md)
and
[package evaluation](../research/2026-07-29-local-analysis-package-evaluation.md)
for the measured evidence and dependency decision.
