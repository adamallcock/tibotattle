---
title: Compact local inference timing experiment
date: 2026-09-09
type: plan
status: implemented-local-experiment
---

## Scope and decision

Implement an opt-in local research tool against raw Codex rollouts at source
revision `77317f9f03079356b44f172dd1d6adbd93427127`. Its separate SQLite sidecar
never opens the accounting database for writing and is not loaded by the app.
Production integration and migration remain a subsequent gate.

## Measurement contract

- Estimated TPS: sum response output tokens divided by sum reconstructed response
  seconds within a completed turn. Output already includes reasoning tokens.
- Each response starts at its earliest completed Reasoning/AgentMessage item's
  recorded start, and ends at the corresponding token_usage_record timestamp.
  Associate in log order within the same turn, rejecting overlapping intervals.
  Tool execution gaps between responses are excluded. This is a client timing
  proxy, not first-to-last-token server decode speed.
- Recorded turn TTFT: task_complete.time_to_first_token_ms, once per turn.
  It is not per-request TTFT and may include provider-specific hidden reasoning
  behavior. Missing evidence stays NULL, never zero.
- Require unique response IDs and reconciliation with final turn token totals;
  any missing window makes full-turn TPS unavailable. Reject inherited/forked
  histories and conflicting attribution. Keep quality/coverage counts.
- Model panels show median per-turn TPS and recorded TTFT by completion date,
  with percentile bands, sample counts and effort context. Sparse bins use hollow
  points; missing bins break lines. The original scatter view remains available.
  Exclude automatic-review/unknown models.
  Produce local PNG/SVG plus content-free scalar data; inspect the rendered plot.

## Cost and persistence design

1. Reuse the bounded rollout reader: 64 KiB line cap, 256 KiB read buffer,
   byte-level rejection before JSON parsing. Never retain item content.
2. Fold response windows in memory into ONE row per completed turn: keyed digest,
   completion time, model/effort enums, token numerator, duration denominator,
   TTFT, response counts, quality flags. No per-token/per-item/per-tool tables.
   Target under 256 bytes per completed turn at useful scale, measured including
   indexes. Keep numerator and denominator, never average already-rounded TPS.
3. Store resumable byte cursor and bounded content-free pending state per source
   in the same transaction as new turn rows. HMAC local IDs with a sidecar-only
   random key; do not retain raw paths/IDs. Deduplicate logical turns globally.
4. Skip unchanged files. Read append-only tails; detect replacement/truncation
   and refuse continuation. Check bounded prefix/tail fingerprints on appends.
   Bound each scan by bytes, elapsed time, active turns and response IDs.
5. SQLite version/application ID checks precede writes. Owner-only directory and
   files, small cache, short lock timeout, transaction rollback on cancellation or
   failure. Errors are fixed categories. Last committed data remains readable.
6. The prototype duplicates only diagnostic token integers, not accounting
   events. Its totals must never feed charges or hosted contribution. Before
   production, join accepted accounting occurrence IDs or prove exact parity
   through the existing normalizer; do not promote raw usage to billing truth.

## Production follow-on (not part of this local experiment)

Use an optional observer in the existing single read pass and an independently
versioned local sidecar. Run after accounting commits, under a small background
budget. Missing/locked/corrupt timing state disables timing only. No network
payload/schema changes. Rehearse additive migration and old-writer refusal on a
copy; no eager historical backfill at startup. Reuse accepted lineage, identity
and correction rules before enabling copied/forked or compressed sources.

Before enabling this in the app, benchmark integrated accounting with timing
disabled and enabled against the exact same immutable corpus. Require exact
accounting parity and at most 10% added p95 foreground refresh latency; otherwise
keep timing in a separate background worker. Aim for at most 100 ms of background
work per scheduling slice, with explicit yielding and no mandatory catch-up on
startup. These are proposed acceptance thresholds, not achieved production claims.

## Acceptance and evidence

- Synthetic two 100-token/1-second responses separated by a 200-second tool wait
  yield 100 TPS, not 200/202 TPS.
- Cover missing timing, reasoning inclusion, duplicate/conflicting response IDs,
  malformed/oversized records, missing TTFT, model changes and reconciliation.
- Cover incremental/restart equality, partial trailing line, rollback/cancellation,
  replacement/truncation, incompatible schema, lock contention and path refusal.
- Run real recent rollouts, record coverage and cold/warm time, bytes read, peak
  memory and database size. Compare timing pass with a reader-only baseline.
- Run focused tests, architecture, docs, inventory and preflight checks. Record
  exact local results here; do not infer installed-app or release readiness.

## Implemented local interfaces

- [Runner](../../tools/reports/inference-timing/run.mjs): explicit source root,
  output directory, start date, file/byte/time budgets; optional reader-only baseline.
- [Parser](../../tools/reports/inference-timing/parser.mjs): bounded same-turn
  reconstruction, response reconciliation, model/effort allowlists and quality flags.
- [Sidecar](../../tools/reports/inference-timing/store.mjs): atomic checkpoints,
  immutable valid measurements, conflict invalidation and resumable oversized-line
  skipping. No production module imports these experimental tools.
- [Plot renderer](../../tools/reports/inference-timing/plot.py): local Matplotlib
  PNG/SVG and per-model scalar summary. Median trends use linear axes; the
  optional scatter view uses a symlog TTFT axis, including recorded zeros.
  Panels explicitly indicate when the sample has no supported measurements.
- [Focused tests](../../test/inference-timing-experiment.test.js): synthetic
  structural fixtures only, including the 200-second tool wait example.

Run with Node 22.13+ after the repository's normal dependency installation:

```sh
node tools/reports/inference-timing/run.mjs \
  --root "$HOME/.codex/sessions/2026/09" --since 2026-09-07 \
  --output "$PWD/.usage-monitor/inference-timing" \
  --max-files 200 --max-bytes 4294967296 --max-seconds 60
```

Use a canonical absolute output path without symlink components. The runner creates a private experiment directory and refuses an
unrecognized database. Repeat the same command to refresh; add `--baseline` for
the bounded reader-only comparison. Each run creates a separate JSON receipt.
`scanBytes` counts attempted scan ranges, including rolled-back ranges, rather
than physical disk reads; bounded fingerprint reads are additional. Runtime
limits are checked between chunks, not a hard real-time deadline.

Render a receipt using a local environment containing Matplotlib (qualified here
with Python 3.14 and Matplotlib 3.11.1):

```sh
python tools/reports/inference-timing/plot.py \
  --input .usage-monitor/inference-timing/measurements-TIMESTAMP.json \
  --output .usage-monitor/inference-timing/tps-ttft-by-model --since 2026-09-07
```

## Local evidence, 2026-09-09

The completed experiment selected the 200 most recently modified eligible source
files from the local September corpus. Discovery found 420 candidates; the
selection date applies to source modification time, while the plot separately
filters turn completion time to September 7 onward. The sources were live during
measurement, so these are local observations, not a controlled performance study.

| Measurement | Observed result |
|---|---:|
| Fresh sidecar, final qualification run | 4,584 ms, 3,278,323,544 scan bytes |
| Reader-only baseline, following run | 409 ms, 3,030,437,183 scan bytes |
| Existing accounting extractor, no DB writes | 1,434 ms, 3,031,025,586 source bytes |
| Incremental refresh | 93 ms, 191/200 unchanged, 1,031,030 scan bytes |
| Fresh sidecar size | 454,656 bytes for 1,568 completed turns |
| Fresh timing process peak RSS | 108 MiB |
| Approximate turn rows plus time index, earlier comparable sample | 183 bytes/turn |

The full sidecar includes per-source cursors/pending state and SQLite page
overhead, approximately 290 bytes per turn in the fresh sample. The 256-byte
target is met for turn facts plus their index, but not for the entire small
database. Fixed per-source state amortizes with more turns; this is not a proven
million-turn size projection. The scanner uses a 2 MiB SQLite cache and a
256 MiB database page ceiling; hitting a limit rolls back the affected chunk.

Cold timings across development runs varied from about 4.3 to 28.8 seconds.
Chunk-boundary rereads explain some extra scan bytes. Timing reconstruction plus
persistence is materially more expensive than the existing extractor alone;
the experiment proves feasibility and a cheap incremental path, not negligible
production overhead. The installed accounting app/database was not modified.

The rendered snapshot contains 1,530 completed turns in the plot date range;
244 have one of the plotted model labels. There are 45 fully supported TPS points
and 236 positive recorded TTFT points. Unknown/other model turns (including
unrecognized automatic-review labels) are omitted. Missing timestamps,
unreadable timing records, inconsistent boundaries and reconciliation failures
remain unavailable, rather than being converted into guessed speeds.

| Model | TPS points | Weighted estimated TPS | TTFT points | Median recorded TTFT |
|---|---:|---:|---:|---:|
| Luna | 13 | 52.33 | 46 | 4.25 s |
| Terra | 22 | 49.58 | 145 | 4.79 s |
| Astra | 10 | 31.65 | 45 | 6.39 s |
| Sol | 0 | unavailable | 0 | unavailable |

These cohorts differ in reasoning effort and workload. They do not establish a
provider-wide model ranking. Eighteen focused tests pass, including actual
database close/reopen recovery, lock contention, cancellation, conflicting
copies, oversized-line continuation and the 100-TPS synthetic example.
Architecture, documentation, tool inventory and preflight checks pass. PNG/SVG
layout was inspected after correcting footer overlap and plot padding.

Remaining production gates: exact accepted-accounting/lineage parity, integrated
latency profiling, background scheduling, source correction/deletion semantics,
cross-platform filesystem qualification, compressed-source support, and any
installed-app additive migration. A full-prefix rewrite that preserves file
identity and evades the bounded prefix/tail fingerprints is outside this local
experiment's source-integrity guarantee; production must reuse the index's
stronger source/lineage admission rules.

## Expanded scan and robust trends, 2026-09-09 follow-up

The earlier 191/200 skip count means unchanged sources were not re-read; their
stored observations remained in the chart and aggregates. It is an incremental
I/O saving, not an exclusion of those sources from statistics.

Expanded selection: all eligible uncompressed JSONL files under sessions and
archived_sessions with modification time on or after August 10. The bounded file
limit is now 5,000 (default still 50); each invocation retains the 8 GiB byte
ceiling. Four resumed passes scanned 4,768 distinct source paths, approximately
26 GB of source data. Live creation/appends mean directory counts can change
between passes. Every pass completed without source failures; the first two
stopped at the byte budget and resumed from committed checkpoints.

The combined sidecar contains 20,209 completed-turn rows in 6,156,288 bytes
(5.87 MiB). The August 10–September 9 chart window contains 19,988 turns;
1,925 have one of the four displayed model labels. Unknown/other-model turns
remain excluded from per-model claims. The plotted data has 114 supported TPS
observations and 1,689 recorded TTFT observations. TTFT is available back to
August 10; supported TPS starts September 3 (September 4 for Astra). Reading older
files cannot recover timestamps absent from their recorded evidence.

The renderer defaults to daily median plus P25–P75, the middle 50% of observations.
`--band p10-p90` provides the middle 80%; `--style scatter` shows individual
observations. `--bin-hours` accepts 6, 12, 24, 48 or 168. All valid observations
enter quantile calculations, including extreme values. These are spread bands,
not confidence intervals or an error filter. No winsorization, deletion or
retry inference is applied. A band/line requires at least five observations;
sparser bins appear as hollow median points. Metrics use their actual supported
date ranges, labelled separately, with a shared range across models per row.

The wider P10–P90 view retains a very broad Sol range on August 22. The IQR view
is easier to read while still showing elevated daily medians around August 22–24
in several model cohorts. Workload and effort mix could explain some change;
these data do not establish a cause.

| Model | TPS sample | Median estimated TPS | TTFT sample | Median recorded TTFT | TTFT above 30 s |
|---|---:|---:|---:|---:|---:|
| Luna | 28 | 54.11 | 333 | 4.85 s | 11 |
| Terra | 35 | 51.34 | 488 | 4.96 s | 15 |
| Astra | 47 | 29.15 | 213 | 5.47 s | 8 |
| Sol | 4 | 32.84 | 655 | 7.56 s | 35 |

These TPS values are medians of per-turn rates, unlike the weighted TPS values
in the initial receipt above. Sol's four TPS observations do not support a trend.

Metadata-only outlier inspection reviewed the ten longest known-model TTFTs from
the original sidecar across six sources, reading 1.13 GB. No explicit retry,
reconnect or error event types appeared, and no completion error was set. This
does not exclude provider retries: eight turns included oversized records and
rollouts need not expose provider-internal attempts. The longest observations
included Astra TTFT 152.6 s with first reasoning starting at 143.1 s, and Terra
TTFT 108.1 s with reasoning starting at 106.7 s. Another Terra turn began reasoning
at 1.47 s but recorded TTFT at 37.35 s, close to its first message. Retain the
recorded metric and avoid labelling its tail as an error without independent
evidence. This inspection is not a review of every expanded-history outlier.

Validation adds four Python statistical tests for quantile/outlier behavior,
median-of-rates semantics, missing-day gaps, unknown measurements and recorded
zero TTFT, plus a Node test for the expanded file ceiling. Run Python checks in
the plotting environment with `python test/inference-timing-plot.test.py`.
Nineteen Node tests and four Python tests pass; main and companion PNGs are
visually inspected. The production accounting code and database are unchanged.
