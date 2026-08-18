---
title: Local Analysis Index Retirement Plan
date: 2026-08-17
type: plan
status: implemented
---

# Local analysis index retirement plan

## Outcome

Make `local-unified-index-v1.sqlite` the only production fact index used for
Codex accounting, history, dashboard projections, and contribution
preparation. Keep the legacy analysis/archive code and files for one reversible
rollback window; do not delete them in this change.

The provider parser remains. This retires the duplicate durable index, not raw
Codex discovery and parsing used by other tools.

## Historical defect and current state

Before this work, passing `unifiedIndexFile` changed only the weekly calibration
corpus. The main accounting scan still constructed and refreshed
`local-analysis-index-v2.sqlite`, and foreground refresh also wrote
`local-archive-accounting-index-v1.sqlite`.

That wiring defect is resolved in the implementation. Unified mode uses the
generation-bound unified reader for recent accounting and history and does not
read or advance either legacy database. The composition-root default is now
`unified`; `USAGE_MONITOR_ACCOUNTING_SOURCE_MODE=legacy` is the explicit,
observable rollback selector. Neither mode silently falls back to the other.

## Decisions

1. Unified facts retain source-native `NULL` context evidence. The production
   compatibility adapter explicitly projects a missing total-input-context as
   legacy zero during the cutover. The raw receipt keeps absence and zero
   distinct so the compatibility behavior cannot hide a future correction.
2. Accounting authority is explicit: `unified` or `legacy`. There is no error
   fallback between them. Legacy is a reversible rollback selector.
3. A published unified generation is the publication unit. Rebuilds and
   increments are written to a staging database and atomically renamed over the
   live file only after integrity validation and fsync. Global `complete`
   still means every consumer fact is covered; a tool-only provenance gap is
   published as `partial`, while its independently complete usage/quota
   accounting remains eligible and tool totals are explicitly withheld.
4. The unified schema persists exact source-local ordering, source offsets,
   tier-observation time, source-scoped quota occurrences, source-scoped typed
   tool facts, and bounded diagnostics. Migrated historical rows retain honest
   `NULL` provenance; they do not receive fabricated values. A pre-tool source
   that already rotated away is marked as missing tool history: usage remains
   available, but the product never turns that gap into a zero tool count.
5. Replay-safe caches record their reader/schema/parser/contract/generation and
   compatibility tuple. Incomplete or mismatched coverage cannot be written or
   reused as current accounting.
6. Full-history accounting becomes a constant-memory aggregate in the same
   collector-state cache transaction as the recent periods. Unified mode does
   not read or advance the old archive database.
7. Old databases, secrets, readers, and tests remain on disk for rollback until
   a later deletion gate. This change performs no destructive cleanup.

## Required invariants

- Fork replay is excluded exactly once.
- Usage components, model identity, speed/tier, surface, agent scope, lineage,
  quota slot/duration/reset/plan/limit, event-time pricing, and stale-leading
  quota gating remain semantically equivalent.
- Global generation `complete` means the discovered source set and all admitted facts,
  diagnostics, and provenance belong to one validated published generation.
- Tool-only partial coverage cannot overstate a zero and cannot suppress
  independently complete usage/quota accounting.
- An abort, crash, parser change, active append, truncation, or callback failure
  leaves the prior published database and prior valid accounting cache intact.
- Readers never discover or open rollout JSONL.
- No path, filename, source content, prompt, reply, arbitrary error text, or
  raw identifier enters the new provenance, diagnostic, generation, or parity
  surfaces.
- A no-change accounting refresh reads zero rollout source-body bytes and does
  not touch either legacy index.

## Implementation sequence

### 1. Characterization

- Freeze a keyed, content-free usage/quota semantic receipt.
- Compare legacy and unified callbacks plus replay-safe projections.
- Preserve the known native mismatch: legacy emits context zero; unified stores
  context unavailable.

Status: complete in release-branch commit `dd82ef9` (patch-equivalent to the
original characterization commit `408a8c5`).

### 2. Unified publication contract

- Widen the schema additively with source provenance, quota occurrences,
  source diagnostics, generation membership, and coverage summaries.
- Bump parser/storage versions for new rows.
- Publish cold and incremental passes through staged atomic replacement.
- Leave migrated provenance gaps partial until a v8 source rebuild can heal
  them.

Status: implemented and focused-test complete. Incremental replacement now
deletes stale facts by source, preserves facts whose raw files merely rotate
away, rebuilds unattested migrations, and publishes indexed retained sources
in the new generation descriptor. Storage/parser v8 adds generation-bound
typed tool facts, deterministic fingerprints, migration-safe diagnostic
vocabulary widening, and honest rotated-source tool gaps.

### 3. Read-only accounting source

- Read one published generation only.
- Emit deterministic usage and admitted quota occurrences with exact
  provenance.
- Support `source_native` and explicit `legacy_zero` context behavior.
- Return a bounded generation/coverage/capability descriptor.
- Preserve only a closed allowlist of resource error codes; collapse all other
  callback failures to fixed content-free errors.

Status: implemented and focused-test complete. The adapter binds canonical
generation ID plus fingerprint before and after callbacks, supports explicit
context compatibility, and exposes only fixed error codes.

### 4. Cache and consumer cutover

- Remove replay accounting's hidden legacy scanner construction.
- Require explicit `unified` or `legacy` authority.
- Bind the cache to the completed unified generation and enforce returned
  coverage.
- Add full-history aggregate and coverage to the cache.
- In unified mode, stop normal analysis/archive writes and source history from
  the cache. Keep the legacy mode code path intact.

Status: implemented and focused-test complete. Direct cache builds fail closed
without an injected scanner or explicit mode; unified caches and history are
bound to both generation ID and fingerprint, require zero fallback use, and
withhold incomplete evidence.

### 5. Qualification

- Prove native and legacy-compatible context receipts separately.
- Cover equal-timestamp quota occurrences, fork replay, rotated sources,
  corruption, cold/incremental interruption, no-change mtime, generation
  mismatch, reader/writer overlap, and preservation of old DB files.
- Benchmark the real production path separately for cold rebuild, increment,
  no-change, cached read, and history projection. Report wall time, source
  bytes, callback/fact counts, peak RSS, database bytes, median, and p95.
- Run focused, affected, full, architecture, packaging, product-local, and
  macOS gates. Installed-app validation remains separate from source tests.

Status: cutover qualification is green on the synthetic production path and a
real production-default server refresh. The fixture covers
cold/no-change/append/relaunch, raw-source deletion, legacy-file non-touch,
cache/history generation invalidation, and exact `legacy_zero` parity. The
default flip has been exercised without setting the mode environment variable;
the old analysis and archive files remained absent. The retained R7 decisions
remain `release_open`; regenerating evidence does not promote a release. The
source cutover is implemented, but final-source R7 evidence remains an open
release/publishing gate as described below.

The first read-only real-corpus unified pilot completed over 51,140,189,911
source bytes in 2,145 sources and published 600,095 facts. Before the cold-path
fixes below, it measured a 39.0-minute cold rebuild, 1.52 GB peak RSS, a 221 MB
unified index, a 655 ms zero-byte no-change ingest with unchanged size/mtime, a
56 ms generation-bound cache read, about 20.1 seconds for a full
accounting/history cache rebuild, and about 4.8 seconds for the companion
snapshot. This receipt exposed a real cold-publication defect; it is retained
as the pre-fix baseline rather than presented as expected product performance.

The 39-minute cold build and the 20.1-second accounting rebuild are different
operations: the latter runs after a completed unified index already exists.
Steady-state no-change work therefore did not regress from 20 seconds to 39
minutes. The first-build/recovery path is nevertheless a release blocker. A
10-worker real-corpus experiment was stopped after a 24-minute lower bound
without publication. It disproved worker count as a complete explanation and
exposed an unbounded worker-message queue around the single SQLite writer, so
that configuration is not a production candidate and produced no qualifying
receipt.

The cold builder now defers its reader/proof secondary indexes until the
brand-new staged fact load is complete. Primary and unique constraints remain
active; the secondary indexes are created in fixed order before generation
finalization, integrity validation, fsync, and atomic publication. Existing and
incremental databases must already contain those indexes. Logical parity,
index presence, staged failure rollback, reader compatibility, qualification,
and benchmark-window contracts pass the latest focused regression (64/64).
The generation proof includes a required index on
`quota_occurrence(canonical_observation_id)`. Without that index, its
correlated quota-coverage anti-join was effectively quadratic. Planner coverage
proves the fixed query uses the index; writable migration repairs its absence
while read-only validation rejects an incomplete index set.

A finalized post-fix one-worker real-corpus pilot then completed successfully
with explicit `2025-08-02T00:00:00.000Z` through
`2026-08-02T00:00:00.000Z` bounds. Its 365-day live selection was larger than
the first pilot: 65,187,367,357 source bytes, 3,333 sources, 429,257 usage
events, 647,988 quota observations, 648,175 quota occurrences, and 1,077,245
indexed usage/quota facts. The cold rebuild took 45.486 seconds, about 51 times
faster than the pre-fix receipt; peak RSS was 2.393 GB, the published index was
387.3 MB, and total isolated state was 396.4 MB. Zero-byte no-change ingest
took 790 ms and preserved index size/mtime; a generation-bound cache read took
56 ms; full accounting/history cache builds took 29.9 and 32.3 seconds;
companion snapshots took 7.0 and 7.6 seconds. The whole qualification, which
intentionally repeats cache and companion validation, took 123.7 seconds.
Legacy paths remained absent and raw sources were read-only. An immediately
preceding post-fix run over the same counts completed cold construction in 57.9
seconds, providing a second consistent feasibility observation but not a
predeclared statistical run.

This fixes the observed catastrophic cold cost. The live-corpus receipts are
not a frozen same-corpus A/B or a three-run median/p95, so they must not be used
as a precise relative-speed claim. They are sufficient for the cutover's
feasibility gate: steady-state work is incremental, no-change reads zero source
bytes, and the recovery build completed in under a minute on a larger corpus.
The roughly 2.4 GB cold-build peak remains a documented recovery-path cost.

The retained legacy benchmark formatter and its callback-error classification
were repaired. A real legacy index rebuild completed over the same live source
family (3,333 sources, 65.2 GB, complete coverage, 408,142 usage events and
636,717 quota observations). A cold legacy accounting-cache rebuild then hit
the existing `accounting_transition_rss_limit_exceeded` guard, so there is no
valid cold end-to-end legacy timing claim. Rollback was instead proven from a
valid warm cache: explicit legacy mode reused the cache, invoked the archive
path only in legacy mode, served the companion, and left collector-state
size/mtime unchanged. This is a recovery proof, not a performance comparison.

Focused evidence recorded during implementation:

- Integrated cache/refresh/data/qualification regression passes, including the
  exact-decimal half-boundary cache regression and pre-write cache validation.
  The full local-product lane passes 214/214 with its
  required loopback permissions.
- Architecture boundaries, documentation links, tool inventory, package
  export checks, and diff preflight pass at the verified stopping point.
- Final-source R7 regeneration was attempted on exact Node 24.14.0 and Node
  26.2.0. Node 24 completed its real-history lifecycle, but the Node 26
  `source_scan` exceeded the preregistered 10-minute watchdog. Atomic recovery
  removed the staging generation and preserved the prior complete receipt set;
  those retained receipts are now stale against the final source-closure hash.
  The timeout was not relaxed. Fresh exact-runtime R7 receipts therefore remain
  an open release-evidence gate.
- The final permission-correct root `npm test` run completed 2,564 tests: 2,542
  passed, 17 were intentionally skipped, and five failed. Two failures are
  checkout setup boundaries because the worker workspace's `jsonc-parser`
  dependency is not installed; the cutover does not change the relevant
  package or tests. The other two R7 assertions correctly reject retained
  receipts whose exact source-closure hashes predate this cutover. The fifth
  failure was an unchanged legacy-report TOCTOU scheduling test; it passed in
  the preceding full run and again in an immediate focused 8/8 rerun. The
  local-product lane remains 214/214 and the macOS product lane remains 53/53.
- Real-corpus unified pilots: the pre-fix 39-minute receipt identified the
  unindexed proof defect; the finalized post-fix one-worker receipt completed
  the larger 365-day, 65.2 GB live selection in 45.5 seconds. Legacy production
  files were absent from isolated unified state and raw sources were not
  mutated. The unsafe
  pre-fix 10-worker follow-up was stopped at a 24-minute lower bound, and the
  current legacy cold cache still exceeds its existing transition RSS target.
  A three-run frozen-corpus unified/legacy median and p95 remain useful future
  characterization, not a precise claim made by this cutover; only 15 GB of
  disk headroom was available at qualification start, so six additional cold
  states were not created.
- The package allowlists now match the locked `fast-uri` 3.1.5 dependency.
  Packaging/export/review checks pass 17/17 and the permission-correct macOS
  product lane passes 53/53.
- The extracted local-review runtime smoke still fails to materialize the
  `@app-usagemonitor/telemetry-contract` workspace package. The same command
  fails identically on untouched `origin/main`; that inherited packaging fix
  is deliberately not folded into this source-only cutover.
- A production-default real refresh published generation 8 over the then-live
  118.7 GB / 4,566-source corpus. It served complete generation-bound history
  with zero fallback, no archive result, and no legacy files before or after.
  The dormant collector's rollout and tool row counts were unchanged; one live
  quota observation was added. A public-receipt double-projection bug found by
  this smoke was fixed so source count, source bytes, and covered timestamps
  remain lossless through the HTTP projection.

## Cutover and rollback

The composition root selects one authority. Unified-mode failure retains the
last valid generation-bound cache or shows insufficient evidence; it never
writes the old index as a fallback. Rollback explicitly selects `legacy`,
reenabling the old accounting/archive readers without changing the unified
database. Any rollback use is reported as a bounded mode receipt.

The current branch defaults to unified. The rollback selector, legacy readers,
tests, and dormant on-disk paths stay in place for the reversible release
window. This implementation does not install, publish, or delete the old files.

Do not remove old implementation or files until a later release has a durable
dominance receipt showing semantic parity, complete unified coverage, installed
refresh success, and acceptable production performance.
