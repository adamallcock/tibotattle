---
title: Batched analytics dependency experiment
date: 2026-09-28
type: receipt
status: verified-local
---

# Batched analytics dependency experiment

This local follow-up to the [shared-input experiment](./2026-09-28-shared-analytics-benchmark.md)
batches the dependency checks that dominated correction work. It uses synthetic
admitted data and the existing analytical kernels. Production scheduling,
publication and live throughput are outside this measurement. The
[production runbook](../runbooks/production-operations.md) remains the operational
authority. Source and local regression checks passed; release asset staging
remains blocked by the checkout's existing uncommitted work.

## Implemented change

The [dependency reader](../../apps/worker/src/storage-effective-history.ts)
can now acquire occurrence links for up to 16 selected days in one statement.
Every selected occurrence and outside link retains its target day through the
SQL joins and grouping. A second day in the same batch is still outside the
first day's dependency. Removing that internal tag before existing dependency
assembly produces the same per-day digest as the singleton reader.

Complete-chunk proofs, retained-source eligibility, owner/namespace scoping,
correction frontiers and optional session inclusion remain in the shared SQL.
The reader serializes concurrent calls and retains one link block at a time.
An aggregate above 30,000 rows or 4 MiB of serialized links falls back to the
existing per-day query. Invalid target tags and provider failures remain errors;
they are not treated as overflow. Cancellation is checked before and after the
statement. These output limits do not bound intermediate SQL work or interrupt
an executing D1 statement.

Production callers retain the per-day default. Only the local
[shared-input cache](../../apps/worker/src/analytics-shared-input.ts) opts into
batching by default. Its `dependencyMode` option permits a paired comparison.
The cache's features, private pins, authority checks and retained-state limits
are unchanged. No schema, public route or scheduling change is included.

## Paired comparison

The [benchmark](../../apps/worker/test/analytics-shared-benchmark.spec.ts) now
emits `shared-analytics-benchmark-v2`. Each phase runs the current reference,
the previous shared per-day path and the batched shared path. Each shared cache
independently retains its state through cold, adjacent-date, correction and
unchanged-replay phases. Both shared variants must have identical complete
outputs, private pins, day-reuse counts and retained-state measurements.

The reference comparison still includes exact daily activity/API value,
selected current scalar fits, historical model results and cache contributions.
Only the reference model's separately validated private `inputFingerprint` is
excluded; every analytical field remains in the comparison. Both shared model
fingerprints must also match each other. Every requested model is READY, with
positive daily, session, scalar and cache evidence.

The full fixture has 130 input days, 30 model dates and 986 effective occurrences.
The small fixture has 14 calendar days and two model dates, requiring 102 input
days to cover lookback. These are sparse fixtures, not volume stress tests.

### Full shared-input workload

| Phase | Per-day statements | Batched statements | Per-day rows read | Batched rows read | Per-day / batched local elapsed ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold preparation and first date | 1,273 | 1,152 | 857,421 | 518,104 | 2,678 / 1,198 |
| Remaining 29 distinct dates | 9 | 9 | 36 | 36 | 180 / 170 |
| One-day correction, all 30 dates | 185 | 64 | 614,462 | 108,617 | 1,809 / 428 |
| Unchanged replay, all 30 dates | 9 | 9 | 36 | 36 | 171 / 169 |

Correction uses **65.4% fewer statements and 82.3% fewer rows read**. Cold
preparation uses **9.5% fewer statements and 39.6% fewer rows read**. Recorded
elapsed improvements are 4.2 times for correction and 2.2 times cold. Local
timings are indicative: execution order is fixed and no remote latency or
production concurrency is measured.

The targeted occurrence-link phase falls from **130 statements to nine** in
both cold and corrected workloads. Cold link rows fall from 406,779 to 67,462;
corrected link rows from 585,842 to 79,997. Local D1 statement duration for these
links falls from 1,536 to 119 ms cold and from 1,552 to 170 ms corrected. Total
candidate D1 duration falls from 2,054 to 636 ms cold and 1,564 to 192 ms corrected.

Both variants prepare 130 days cold, prepare one and reuse 129 after correction,
and reuse all 130 on adjacent dates and replay. The corrected output includes
30 READY model dates, five selected scalar fits, one session fact, and 51 cache
groups with 566 adjacencies. Batched retained state is identical: 1,922,109
serialized bytes after correction, with a maximum serialized working measurement
of 1,967,787 bytes. This measurement excludes dependency-query temporaries and
is not peak JavaScript heap.

The small workload also improves: cold statements fall 385 to 291 and rows
139,421 to 89,164; correction falls 157 to 63 statements and 114,731 to 38,155
rows. Local elapsed time falls 1,463 to 337 ms cold and 1,257 to 133 ms corrected.
Warm/replay remain nine statements and 36 rows for both variants.

### Relationship to the current graph pipeline

For the initial 30 model dates plus current scalar fits, the same-run current
graph performs 6,243 source statements and reads 7,377,965 source rows. The
batched shared path serving all four families performs 1,161 source statements
and reads 518,140 rows. That is 81.4% fewer source statements and 93.0% fewer
source rows, a 14.2-fold reduction in row reads on this fixture.

The current graph additionally executes 4,724 target statements and writes
2,190 rows; the shared variants persist no results. The daily and cache
reference paths are independent uncached correctness references, not current
warm publication costs. Thus these figures establish input-work savings and
local parity, not a whole-production speed multiplier or a complete durable
replacement's cost. The cleanest incremental comparison is the paired shared
table above because both sides have the same persistence boundary.

## Reproduction and evidence

From `apps/worker/`, using new output filenames:

```sh
npm run analytics:shared:benchmark -- --output /tmp/batched-analytics-small.json
npm run analytics:shared:benchmark -- --full --output /tmp/batched-analytics-full.json
```

The runner checks installed workspace copies and fingerprints source, tests,
scripts, migrations and configuration before and after. It refuses to overwrite
a report or save one if the test, metadata or fingerprint checks fail. Reports
contain aggregate counters and output hashes without records, SQL or identifiers.

The [small report](./2026-09-28-batched-analytics-dependencies-small.json) was
recorded at 16:23:14 UTC on September 28, 2026. The
[full report](./2026-09-28-batched-analytics-dependencies-full.json) was recorded
at 16:24:34 UTC. Both use Node.js `v26.2.0` and the same 637-file Worker input
fingerprint:
`06220f7ba202c157a49adb2e7956e3bf9c230abef1bdc8ddbffbfe311509895f`.
The base commit is `d4c1f19228da8da3fec2e638052184f961b66795`, with existing
optimization work and these changes in the working tree; the commit alone does
not identify the measured source. The full report's SHA-256 is
`764e22efe84c40a3774c653baa6841ac649a29cf68c221d5b540e6f5b32105f7`.

All measured statements have valid D1 rows-read, rows-written and duration
metadata, with zero failed statements and zero measurement failures. CPU and
peak heap remain unavailable. Batch wall allocation is labeled separately from
independently measured statement-call time.

## Validation and remaining work

- Dependency regressions: 36/36 across the existing and new batched specs.
  Cases include all three source families, correction-only links, encoded ID
  distinctions, missing completeness proofs, owner isolation, sessions, empty
  days, accepted cross-day correction, absent v1.2 schema, 101-day out-of-order
  concurrent reads, row/byte overflow, invalid tags and cancellation.
- Shared-input, reducer and default-fixture regressions: 18/18.
- Benchmark runner script checks: 2/2; small and full benchmark suites: 6/6 each.
- The complete Worker regression suite passed **2,255/2,255 tests across 177
  files**, in 1,040.85 seconds. The preceding workspace-copy, endpoint,
  generated-type, TypeScript and operations-script checks also passed.
- `npm run product:worker:check` then stopped at `production:stage-assets`,
  which requires a clean committed release tree. The existing dirty checkout
  was preserved. Wrangler dry deployment and staging checks were not reached;
  the umbrella command therefore exited with status 1. This is not a complete
  release qualification.
- Architecture checks passed for 660 production files and 2,745 imports, with
  no approved dependency debt. Documentation governance passed for 282 Markdown
  files; preflight passed all 20 tests. Whitespace checks passed.

The batching experiment meets its acceptance gate. The next slice is bounded,
resumable date-block work with durable prepared inputs and fenced completion.
The cold local batch still executes 1,152 statements, exceeding the existing
950-statement invocation allowance. It cannot be installed as one scheduled
pass. Durable writes, retry recovery, source-change/erasure invalidation and
publication must be measured before a production canary.
