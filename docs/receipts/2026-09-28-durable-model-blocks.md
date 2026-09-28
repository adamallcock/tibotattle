---
title: Durable model-date block experiment
date: 2026-09-28
type: receipt
status: verified-local
---

# Durable model-date block experiment

This extends the [shared-input design](../plans/2026-09-28-analytics-redesign.md)
with durable model-history jobs. The completed local benchmark includes source
reads, target reads/writes, interrupted invocations, checkpoint reloads and a
separate final visibility read. It uses synthetic admitted v1, v1.1 and v1.2
data. All 2,292 Worker regression tests passed at this checkpoint.

No production handler, scheduler or serving head imports the new runner. Migration
0030 has been rehearsed locally only. These results do not establish production
throughput, public publication latency, dense-workload capacity or whole-system
speedup. The [production runbook](../runbooks/production-operations.md) remains
the operational authority.

## Implemented path and granularity

| Artifact or step | Grain and operation |
| --- | --- |
| Job identity | Source namespace, eligibility/deduplication subject, exact owner revision/epoch, calculation policy, effective-reader runtime state and 1–32 consecutive output dates |
| Dependency selection | Resumable ordered prefix of exact day digests and quota/usage presence facts; the complete input range covers 101–132 UTC calendar days |
| Day acquisition | Existing version-neutral occurrence pages, at most 200 rows per page, reduced into one compact quota/usage day; cursor and reducer state survive process loss |
| Prepared inputs | Existing immutable quota-day and priced usage-day projections; unchanged exact day digests reuse stored inputs, with no raw source record JSON in the job |
| Empty inputs | Explicit false inventory facts recreate validated empty projections; an absent projection for a present stream is a cache miss, never evidence of zero |
| Model calculation | One 101-day window, then drop one old day and add one new day for each adjacent output; existing analytical methods and date-specific solves are retained |
| Durable result | Ordered private output prefix in the claimed checkpoint; consumers can read only a complete block under current source and target authority |

The implementation is in the [runner](../../apps/worker/src/analytics-model-block.ts),
[closed contract](../../apps/worker/src/analytics-model-block-contract.ts),
[job store](../../apps/worker/src/storage-analytics-model-block.ts) and
[migration](../../apps/worker/analytics-migrations/0030_analytics_model_blocks.sql).
The model job requires the effective source route to be enabled. Compatible v1,
v1.1 and v1.2 inputs then share that reader; owners still on native older graph
routes retain their existing source selection and attribution method.

### Bounds and recovery

- The outer invocation meter counts every actual source and target D1 statement,
  including each statement in a batch and failed attempts. Maximum 950; 128
  statements are reserved for save/readback/final authority checks.
- Default work deadline is 20 seconds, with 1.5 seconds reserved before saving.
  Local benchmark calls allow 60 seconds; they exercise the query cap rather
  than represent remote deadline performance.
- Checkpoints have a closed 10 MiB encoded limit, split into at most 81 UTF-8
  parts of 128 KiB. A save batch contains at most 83 statements.
- Claims expire and saves compare the token, revision and current target
  authority. A lost successful response resolves by reading back the exact
  successor. A failed batch leaves the prior complete checkpoint intact.
- The loaded rolling window is limited to 8 MiB serialized input. A prepared
  feature gets one payload read of at most 32 parts. Missing, oversized or
  unrepresentable optional inputs select the existing paged effective model
  calculation; they do not produce an invented analytical refusal.
- Only explicit source/owner/policy/runtime fences establish reuse. Unrelated
  uploads can advance global freshness without restarting this private job.
  Corrections or runtime changes affecting its identity invalidate old results.
- Target owner withdrawal, epoch change and erasure purge job heads and parts.
  The existing erasure receipt now requires physical absence of both tables.
  A source-side erasure also prevents reads before target delivery catches up.

Separate source and target databases still have no shared transaction. Source
authority is checked around work acceptance and complete reads; private model
completion does not authorize a public cohort aggregate.

The [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
reviewed on September 28 list 1,000 queries per paid Worker invocation and a
2,000,000-byte individual row/string limit. Batch members retain individual
query limits. These platform bounds do not prove remote latency or CPU capacity.

## Paired measurements

The [benchmark](../../apps/worker/test/analytics-model-block-benchmark.spec.ts)
runs the current per-date graph calculation and the candidate against separate,
initially empty analytics databases. The same admitted source is read by both.
Reference graph work uses its existing prepared folds and 950-statement limit.
Candidate work recreates the invocation from durable state each time. Fixture
admission, migration and initial runtime setup are excluded from both costs.

Every analytical result field must match. Each private model fingerprint is
validated against its own calculation identity before being excluded from the
cross-method comparison. Both paths produce READY results for every requested
date. The selected correction changes a source dependency and rebuilds one day;
these fixture model coefficients happen to remain unchanged. The test separately
requires a new identity, stale-result refusal and parity with fresh calculation.

### Full workload: 130 input days, 30 model dates

| Phase | Reference / candidate statements | Reference / candidate rows read | Reference / candidate rows written | Reference / candidate local elapsed ms |
| --- | ---: | ---: | ---: | ---: |
| Cold | 15,750 / 2,575 | 8,457,579 / 595,571 | 2,435 / 895 | 27,293 / 1,661 |
| Unchanged replay | 540 / 36 | 174,899 / 4,952 | 0 / 0 | 608 / 8 |
| One corrected day | 5,879 / 442 | 9,049,974 / 175,384 | 494 / 22 | 23,109 / 486 |

Cold work uses **6.1 times fewer statements and 14.2 times fewer rows read**.
Correction uses **13.3 times fewer statements and 51.6 times fewer rows read**.
Elapsed time improves 16.4 times cold and 47.5 times after correction in this
local run. Timings have fixed reference-first order and exclude remote latency,
production concurrency and scheduler delays; they are not deployment forecasts.

Cold candidate work uses four resumable invocations: **755, 794, 829 and 180
statements**, plus a separate 17-statement complete-read proof. It prepares 50
nonempty days and reconstructs 80 proven empty days. The third invocation saves
10 model outputs privately; the fourth completes the remaining 20. Correction
uses one 425-statement work invocation plus the read proof, prepares one day,
reuses 49 prepared days and reconstructs the same 80 empty days.

Checkpoint payload bytes submitted fall from 14,224,575 to 144,709 cold, and
from 8,707,505 to 45,848 after correction. These measure submitted checkpoint
payloads; prepared-day storage and all target operations are included in the
statement and rows-written totals. They are not total stored bytes or heap
measurements. D1 duration falls from 22,523 to 750 ms cold and from 20,792 to
167 ms after correction.

### Small workload: 14 populated-calendar span, two model dates

The full dependency horizon still includes 102 calendar days: ten nonempty
prepared days and 92 explicitly empty days.

| Phase | Reference / candidate statements | Reference / candidate rows read | Reference / candidate rows written | Reference / candidate local elapsed ms |
| --- | ---: | ---: | ---: | ---: |
| Cold | 1,032 / 568 | 136,021 / 103,375 | 338 / 184 | 955 / 385 |
| Unchanged replay | 36 / 36 | 4,039 / 4,952 | 0 / 0 | 33 / 7 |
| One corrected day | 307 / 201 | 80,767 / 48,901 | 48 / 22 | 481 / 182 |

Small unchanged replay does not save statements and reads more rows, reflecting
the additional job/schema authority checks and complete-read proof. The first
implementation also regressed cold statements by persisting empty lookback
days. Reusing authoritative empty-day facts removed that overhead before these
final measurements. Both workloads are sparse, not volume stress tests.

### Remaining measured cost

Prepared-day target access consumes 943 of 2,575 cold statements and 309 of 442
correction statements. Batched head/payload reads are a concrete next query-count
opportunity. Query count and database time are different: correction dependency
links use only nine statements but 134 of 167 measured D1 milliseconds. Preserve
both metrics when choosing the next optimization; extra concurrent callers alone
do not remove this repeated work.

## Evidence and reproduction

Reports recorded on September 28, 2026:

- [Small report](./2026-09-28-durable-model-blocks-small.json), 17:30:10 UTC.
- [Full report](./2026-09-28-durable-model-blocks-full.json), 17:31:07 UTC;
  SHA-256 `de99fdfb9ac308634b2da6f5f3889945c86e8eca6af75b3223b2181f63c78dd3`.

Both reports use Node.js 26.2.0, base commit
`d4c1f19228da8da3fec2e638052184f961b66795` plus the preserved working-tree changes,
and a 645-file Worker input fingerprint of
`67e2fd723b6e6d65e51a7a50363a26b3a006d000bbb48b1a42b1db22115fb903`.
The CLI verifies source/config/migration/test/script fingerprints and installed
workspace package copies before and after execution. It refuses incomplete D1
metadata, changed inputs, failed tests or overwriting an existing report.
Fresh runner calls reconstruct progress from D1; tests simulate interruption,
transaction failure and response loss. Actual isolate termination and remote
deadline pressure are not measured by this local benchmark.

Run from `apps/worker`, using a new output path:

```sh
npm run analytics:shared:benchmark -- --model-block --output /tmp/model-block-small.json
npm run analytics:shared:benchmark -- --model-block --full --output /tmp/model-block-full.json
```

## Validation and remaining gate

Focused contract, store, runner and benchmark validation passed 35/35 before
the final empty-input optimization; the runner and small benchmark then passed
3/3. The final small and full reproducible benchmarks both passed, and TypeScript
and architecture boundaries passed. Store coverage includes large multipart
saves, rollback, lost responses, claim expiry, illegal transitions, corruption,
pre-migration refusal and physical erasure of complete jobs. Erasure integration
passed 14/14, including refusal to issue a receipt while either payload table
still contains derived data.

The September 28 full Worker run passed **181 test files and 2,292 tests** in
1,129.15 seconds. Workspace-copy checks, deployment endpoint checks, generated
types, TypeScript and operations/script tests also passed. The migration
preflight expectation was updated from 29 to 30 analytics migrations; its 11
focused checks passed. Architecture and documentation checks and all 20 root
preflight tests passed.

The umbrella `pnpm run product:worker:check` then stopped at
`production:stage-assets`: its clean, committed release-tree requirement
rejected the preserved working-tree changes. No files were staged or discarded
to bypass that guard. Wrangler dry deployment and staging validation were not
reached; the full release gate is therefore incomplete.

Production migration, routing,
scheduler admission, public publication, dense-volume/CPU qualification and a
representative multi-contributor workload remain separate gates. Next, qualify
dense and sparse blocks under actual deadline pressure, then add bounded
scheduler/publication integration with private work isolated from public heads.
Durable scalar and cache-continuity reuse still require their own reviewed
representations; this receipt qualifies model history only.
