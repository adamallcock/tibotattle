---
title: Detailed accounting rebuild performance receipt
date: 2026-09-02
type: receipt
status: complete
---

# Detailed accounting rebuild performance receipt

## Claim boundary

This receipt records a source-level performance qualification of the explicit
detailed-accounting rebuild (the isolated accounting child that
`refreshReplaySafeAccountingCache` runs on a changed unified generation). It
proves only the named checkout, corpus snapshot, commands, and machine below.
It is not an installed-artifact, native, release, or R7 claim, and it makes
no support promise for other machines or corpora.

Every optimization commit was gated on exact equality of the serialized
cache artifact: the same pinned clock, the same immutable index snapshot,
and a byte-for-byte identical result file (SHA-256
`b1155dfcae4472e822128169a0575790bfcf2e6636e8641047d892646e730da3`,
12,123,277 bytes) before and after each commit. No accounting, attribution,
quota, calibration, or provenance field changed value.

## Qualified revisions

- Baseline: `35802d21ede67d362533f4e2be6b38041ece1cda` (PR #101), the source
  boundary named by the 2026-09-01 performance handoff.
- Candidate: the seven commits `af187429` through `634f15e8` on the task
  branch, each verified independently against the baseline digest:
  1. `af187429` calibration discovery page plan hint; orphan-form dimension
     integrity check.
  2. `23f8a6f9` per-consumer `usageAttribution` declaration; synchronous
     callback delivery with an event-loop yield every 2,048 rows.
  3. `e46b8729` integer nano-dollar exact-ledger lane folded to the decimal
     string ledger at finalize.
  4. `2957176b` per-retained-position attribution memo across the fit and
     the batched derivation, with the non-retained-row gate.
  5. `60791c9d` one-pass attribution precomputation (same-record plans,
     same-source predecessor, multi-source session set).
  6. `6d2d67c5` full-history period folded into the windowed read
     (`indexedHistory` consumer, per-window proofs, projection sharing).
  7. `634f15e8` canonical-instant shape fast path.

## Protocol

- Corpus: an APFS clone of a quiescent owner recovery snapshot of the
  unified index (generation 44; 726,740 usage events; 954,391 quota
  occurrences; 903,427 tool facts; 7,708 sources; 1.51 GB) in a fresh
  owner-only directory. The live application state was never read or
  written.
- Workload: the production child entry
  (`src/replay-safe-accounting-rebuild-child.js`) spawned exactly as the
  refresh wrapper spawns it, with a
  `replay-safe-accounting-rebuild-request-v1` request pinning
  `nowMs = 2026-09-02T00:00:00.000Z`, `windowDays = 365`, unified authority,
  `legacy_zero` context behavior, no declared speed baselines, and the 6 GiB
  ceiling. Each candidate ran from a `git archive` snapshot of its commit.
- Measurement: `/usr/bin/time -l` around the child (wall, user/system CPU,
  maximum resident set size); V8 `--cpu-prof` on separate profiled runs.
- Machine: Apple M5 Max, 18 cores, 128 GiB, Node 26.2.0, sequential runs on
  an otherwise idle desktop (other application sessions were open).
- Repetitions: one run per commit for the digest gate; three consecutive
  runs after one warm-up for the final candidate. Three runs give a median
  and range, not a percentile.

## Results (accounting child only)

| Revision | Wall | User CPU | System CPU | Peak RSS | Digest |
|---|---|---|---|---|---|
| baseline `35802d21` | 368.4 s | 339.6 s | 28.1 s | 1.84 GB | reference |
| 1. `af187429` | 347.6 s | 324.1 s | 20.2 s | 1.82 GB | identical |
| 2. `23f8a6f9` | 210.2 s | 198.6 s | 18.3 s | 1.76 GB | identical |
| 3. `e46b8729` | 191.5 s | 181.1 s | 18.2 s | 1.90 GB | identical |
| 4. `2957176b` | 100.4 s | 99.4 s | 6.9 s | 1.97 GB | identical |
| 5. `60791c9d` | 49.5 s | 53.6 s | 1.3 s | 1.91 GB | identical |
| 6. `6d2d67c5` | 44.2 s | 48.6 s | 1.4 s | 2.10 GB | identical |
| 7. `634f15e8` run 1 | 38.3 s | 42.1 s | 1.4 s | 2.25 GB | identical |
| 7. `634f15e8` run 2 | 38.3 s | 42.3 s | 1.3 s | 2.06 GB | identical |
| 7. `634f15e8` run 3 | 39.0 s | 42.7 s | 1.6 s | 1.94 GB | identical |

Final candidate: median 38.3 s, range 38.3-39.0 s, against the handoff's
target of at least 2x below the ~433 s reference and a stretch of 180 s.
Peak RSS stayed within the existing ceiling; the run-to-run RSS spread is
garbage-collection timing, not retained data.

## Where the baseline time went (profiled baseline, 352 s sampled)

- 228 s (65%): the attribution reader's per-row point queries, executed in
  all four usage passes although two of those passes never read the result.
- ~37 s: the calibration discovery statement, whose plan sorted the whole
  usage table in a temp b-tree for every 20,000-row page.
- ~19 s: decimal-string exact-ledger folding (`addUsdStrings`) per event and
  per priced component.
- ~9 s: the four-way dimension join count, run twice.
- SQLite scans themselves: under 3 s in total.

Remaining profile of the final candidate (39 s sampled): usage/quota row
materialization 4.6 s, calibration corpus open 2.3 s, corpus re-read streams
3.6 s, garbage collection 2.1 s, transition-miner decimal strings ~3 s,
model-family classification 1.4 s, calibration quantiles 1.2 s.

## Beyond the child

Measured on the same corpus but not changed by this work:

- The companion's full-history projection, recomputed in the resident
  process after every changed generation: 18.8 s and +1.17 GiB (usage scan
  with pricing ~2.3 s, tool-fact attestation walk with SHA-256 ~6 s, quota
  timelines ~1 s, projection assembly the rest).
- Incremental unified-index ingest of a large real append (185 sources
  rescanned, 2.7 GiB of new rollout bytes): 43.8 s, of which discovery ~17 s.
- Parent-side handling of the child's artifact (read, hash, parse, validate,
  size check, durable write, re-read): under 0.4 s in total.

## Validation

- Owning suites from the task worktree at `634f15e8`:
  `test/local-unified-accounting-source.test.js`,
  `test/replay-safe-accounting-cache.test.js`,
  `test/replay-safe-accounting-corpus-stream.test.js`: 112 passed, 0 failed.
- `npm run architecture:check`: passed.
- `npm test` from the worktree: 3,459 passed, 2 failed. Both failures are
  the retained R7 release-receipt revalidation tests, which detect that
  workload source changed; R7 regeneration is a protected coordinator step
  and was deliberately not run. No other suite failed.
- New structural tests count calls rather than time: attribution reads equal
  retained rows across the fit and the batched derivation; aggregate passes
  declare no attribution while the windowed-fallback pass requires it; the
  fused single read is byte-identical to the two-read build on a generation
  whose covered range reaches a year past the scan window; the one-pass
  attribution precomputation matches every point-query read across tied,
  reversed, multi-source, partially scanned, and dropped-source fixtures;
  the canonical-instant shape path matches the Date round trip over the
  whole calendar grid, the Date range edges, and randomized corruptions.

## Remaining risks and open items

- R7 receipts are stale until the coordinator regenerates them on frozen
  source.
- The task branch predates the 0.1.17 refresh-policy and mixed-plan
  corrections still under review on `codex/refresh-accounting-progress-rc9`;
  it must be rebased onto the coordinator's merged revision and the digest
  gate re-run there.
- Cancellation during a scan is now observed within one 2,048-row cadence
  instead of at the end of the stream; the RSS ceiling and fail-closed codes
  are unchanged, but an overflow during the fused read now trips the
  windowed pass's soft budget-miss code rather than the former history
  sub-build's hard archive code.
- The companion projection and the ingest step are now the larger share of
  a changed-generation refresh and were measured, not optimized.
- Progress reporting from the child (handoff section 7) was not changed.
