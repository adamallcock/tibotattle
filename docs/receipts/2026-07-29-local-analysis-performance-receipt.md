---
title: Local Analysis Performance Receipt
date: 2026-07-29
type: receipt
status: completed
---

# Local Analysis Performance Receipt

## Fixed workload

- Node: 26.2.0
- End instant: `2026-07-29T23:42:36.215Z`
- Window: 31 days
- Selected source count: 1,997
- Scheduled source bytes: approximately 30.39 GB
- Workers: 10, each capped at 96 MB old generation, 16 MB young
  generation, 16 MB code range, and 2 MB stack
- Filesystem cache: ordinary local operating-system state; not a claimed
  physical cold-disk benchmark

## Virgin results

Each run used a distinct empty owner-only state directory.

| Run | Analysis wall | Process wall | Peak RSS | Index wall | Index size |
|---|---:|---:|---:|---:|---:|
| 1 | 18.838 s | 18.89 s | 1,396,834,304 B | 17.299 s | 173,318,144 B |
| 2 | 18.735 s | 18.79 s | 1,385,922,560 B | 17.211 s | 172,277,760 B |
| 3 | 19.318 s | 19.38 s | 1,399,078,912 B | 17.800 s | 171,696,128 B |

Median process wall time was **18.89 seconds**. Maximum observed peak RSS was
**1.399 GB**, below the original **1.45 GB** baseline.

## Functional parity receipt

All three final runs produced:

- usage events: 212,033;
- total tokens: 42,788,683,650;
- API-price-equivalent: 30,095.801013 USD;
- weekly calibration: `estimated`;
- fork replay events excluded: 1,137,727;
- unattributed fork replay events excluded: 53;
- duplicate snapshots excluded: 5,688; and
- missing lineage parents: 0.

The focused golden fixture also compares indexed usage and quota facts directly
with the legacy lineage-aware scanner, verifies that an unchanged refresh reads
zero source bytes, verifies that an append reads only the new complete suffix,
and searches the SQLite bytes for private session/path canaries.

## Incremental and cached evidence

- Golden-fixture no-change refresh: zero source bytes.
- Golden-fixture append: only the appended complete-line suffix.
- Live active-tail refresh immediately after an earlier update: 4,662 source
  bytes, 630 ms total; the active Codex rollout was still being appended.
- Valid JSON accounting cache read: 8.40 ms.
- Missing JSON cache recovered from the committed index projection: 7.93 ms.
- Unchanged 393 MB collector ledger projection: 652.1 ms initial build,
  13.84 ms cached relaunch, 133.3 MB process peak.
- Headed browser projection from the earlier audit remained about 71 ms and was
  not a qualifying hot path.

## Validation

- Architecture boundary check: passed.
- Affected-path suite: 117 passed, 0 failed.
- Full serial repository suite: 1,135 passed, 2 failed out of 1,137.

The two full-suite failures are the source-provenance checks for the ten
preexisting R7 release-evidence receipts. Those receipts describe an earlier
159-file dirty-tree closure; the current whole-repository R7 closure contains
167 files. The supported dual-runtime regeneration was attempted without
publishing partial output, but its long real-history process was externally
signaled twice before atomic commit. The receipts were deliberately left stale
rather than relabeled without remeasurement. This exception is outside the
local-analysis functional pathway; all other repository tests passed.

## Reproduction

Use a new empty state directory for every virgin run:

```bash
state_dir="$(mktemp -d /tmp/usage-monitor-benchmark.XXXXXX)"
/usr/bin/time -lp node scripts/benchmark-local-analysis-pipeline.mjs \
  --codex-home /path/to/.codex \
  --state "$state_dir" \
  --end-at 2026-07-29T23:42:36.215Z \
  --workers 10
```

The benchmark emits only closed counts, timings, byte totals, versions, and
privacy flags. It does not emit source paths, filenames, identifiers, or raw
records.
