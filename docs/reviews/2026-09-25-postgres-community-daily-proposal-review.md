---
title: PostgreSQL community-daily optimization proposal review
date: 2026-09-25
type: review
status: reviewed
---

# PostgreSQL community-daily optimization proposal review

## Scope and decision boundary

This is a source and local PostgreSQL 17 review of a user-supplied replacement
for `apps/worker/src/postgres-community-daily-publisher.ts`. The reviewed
checkout was `23e06b4346b6dd8383bf017b31ab8878a4d519c4`; the current
publisher file had SHA-256
`3241f9f58384536f2f291bfefb67aacde2dda21f745437339c714e4aac96dce0`.
The proposed replacement had SHA-256
`eb96aafcb2f233093af302a030d4ad3f6d7cea9d4111b40753fa486e07682d5e`.
The measured full candidate retained the current eligibility helper and
therefore had SHA-256
`822d19356c2d408b48fb05bc7981a203c62f65d7cd9588a04cff98a8a752a568`.
The measured cursor-only variant had SHA-256
`bda3bcd78bb2a32e03560689f5a3da0a81d2617a6006608bde093ead891b51df`.
These identities refer to isolated review and benchmark variants. The
proposal's included baseline predates the current publisher and must not be
copied wholesale. Since the review, the cursor-only pricing change was
integrated as commit `498c61c11d1bf5ed8c7090651bf5c41665025d87`, based on
`ad03eaed33fb094b028d11b19851f128816e5374`. This preserved the later
accountless-history-retention source-selection change. The integrated publisher
has SHA-256
`3a13b916cb940599c3c8e07d84d619f4f0c5b1970fcf620eac437d7c05b7f433`.
The ZIP's full publisher replacement and suggested indexes were not merged or
deployed to GCP.

**Decision:** Do not replace the module wholesale. Integrate only the pricing
cursor, preserving the current eligibility helper and all other aggregation
behavior. The isolated cursor-only variant captured essentially all of the
measured 10,000- and 50,000-event gain without temporary tables or a
materialized aggregate. The full replacement removes a current
checked-out-client safety fix. The bundle's mocked tests did not establish SQL
correctness or speed; the real PostgreSQL comparison and remaining hosted gates
are recorded below.

## Why the proposal could help

Before the cursor patch, `priceDailySpend()` reissued the owner, active-chunk, winning-device
and record CTE for every 1,000-row page. Spend pricing is permitted for up to
200,000 usage events, so a large day can issue 200 such source-selection
statements. A CTE shares work within a statement, not across those successive
queries. The proposal stages narrow active/winning chunk metadata once, uses
one materialized metrics projection for totals and model cells, and prices raw
records through one transaction-scoped cursor. The cursor still fetches bounded
1,000-row batches; the optimization is about avoiding repeated selection work.
PostgreSQL documents both CTE materialization and transaction-scoped cursor
behavior in its [WITH](https://www.postgresql.org/docs/17/queries-with.html)
and [DECLARE](https://www.postgresql.org/docs/17/sql-declare.html) references.

## Correctness assessment

| Finding | Evidence and effect |
| --- | --- |
| Current helper lost | The proposed `readPostgresCommunityDailyDaySourceEligibility()` treats any object with `connect()` as a pool. A checked-out `pg` client also has `connect()`; the current helper checks `release()` first and normalizes direct-client errors. The existing PostgreSQL integration test passes a checked-out client. Copying the replacement breaks that path. |
| Source selection | The v1 social-only simplification is algebraically sound under the current query: accountless eligibility requires a v1.1 domain head, while v1 selection excludes any such head. The v1.1 grant/domain joins and all-stream device ranking are retained by inspection. The cursor regression suite covers mixed v1.0/v1.1 social owners; the retained accountless-history tests separately cover opt-out eligibility and missing-marker refusal, not mixed accountless publication output. |
| Capacity and cleanup | The proposal stages at most 30,001 active chunks and rejects the 30,001st before ranking or record work. Its temporary tables use `ON COMMIT DROP`, with one table dropped earlier; the existing mutation helper pins one connection and rolls back failures. The role's TEMP privilege and cleanup still need hosted qualification. PostgreSQL does not auto-analyze temporary tables, so the explicit `ANALYZE` is justified for the proposed plan. |
| Pricing records | The cursor retains the ordering, timestamp conversion, pricer and BigInt accumulation. A final fetch detects one extra row for nonzero workloads, including an exact batch multiple. The zero-event return follows the declared-count comparison; selected v1 chunks require a positive count and v1.1 chunks declare 1–200 rows. This is not a per-chunk child-count proof. |
| Journal fence | Two ordered top-one lookups retain the original latest and terminal sequence validations, locks and final terminal guard. The all-event lookup can use the existing `(source_id, sequence)` primary key. The terminal lookup may scan many nonterminal entries without a matching partial index; this needs a history-heavy plan. |
| Near-cap risk | The metrics CTE materializes one row per selected analytical record for both aggregates. A 30,000-chunk envelope with up to 200 declared records per chunk can imply millions of rows; physical child count is not fully bounded by that declaration. PostgreSQL will not use a parallel plan for a `DECLARE` cursor, and materialization can spill. Test the small Cloud SQL tier before relying on a near-cap improvement. |

The original bundle reported 41 mocked tests and a strict check against
handwritten type stubs, but explicitly reported no PostgreSQL execution or
project-module typecheck. Its harness does not run unchanged with this checkout's
TypeScript 7 toolchain. The current Worker's own typecheck passed before the
proposal was applied; that does not validate the proposed replacement. The
narrow cursor-only integration is validated separately below.

## Subsequent implementation qualification

The cursor-only change was ported to the current publisher without replacing
its eligibility/error-normalization helpers or the later accountless-retention
CTE. Commit `498c61c1` changes only the publisher pricing function and its
focused test. The integrated publisher file SHA-256 is recorded above.

On that commit, `npm run typecheck` passed. The focused real PostgreSQL test
command passed **14/14 tests** on local PostgreSQL 17.11:

```sh
env PG_TEST_HOST=127.0.0.1 PG_TEST_PORT=55441 PG_TEST_USER=postgres PG_TEST_DATABASE=postgres \
  npm exec -- vitest run postgres-test/postgres-community-daily-publisher.spec.mjs \
  --config vitest.postgres.config.ts --reporter=dot
```

The tests include the existing migration-0041 accountless-retention cases,
exact publication digests for 0, 1, 999, 1,000, and 1,001 v1 events, mixed
500-v1/500-v1.1 output parity, one checked-out client, source immutability, and
rollback/cursor cleanup when fetched rows are missing or extra. PostgreSQL was
a disposable local Colima instance reached through the explicitly configured
loopback endpoint. This is local source qualification only; it says nothing
about GCP, Cloud SQL, hosted latency, or production capacity.

## Matched current-revision A/B

The primary performance comparison is between the exact parent of the cursor
commit, `ad03eaed33fb094b028d11b19851f128816e5374`, and cursor commit
`498c61c11d1bf5ed8c7090651bf5c41665025d87`. Their publisher source SHA-256
values are `c9c3351e740136e97ecf6715a78335ce33334bc85f5c3ab4a167a5d3dabc1fc8`
(baseline) and
`3a13b916cb940599c3c8e07d84d619f4f0c5b1970fcf620eac437d7c05b7f433`
(cursor). The parent and cursor revisions share all other source and migrations;
the publisher change is confined to spend pricing. Both sides applied all 41
primary migrations, including `0041_accountless_history_retention.sql`.

This used an isolated scratch harness adapted from the earlier benchmark
fixture; its SHA-256 was
`29a218eb11bd8591be7e731c28448c56f8c3490b062208ed6a9dea2a7ae27d2e`. For each
pair, separate schemas were seeded with the same synthetic social v1 workload.
Migrations and seeding were outside the timer; the complete publication call,
including connection checkout, transaction, SQL, pricing, payload hash and
commit, was timed. Run order alternated baseline-first and cursor-first. Three
pairs ran per size on PostgreSQL 17.11 in a local Colima container
(aarch64; `shared_buffers=128MB`, `work_mem=4MB`,
`max_parallel_workers_per_gather=2`).

| Events | Pair | Order | Baseline (ms) | Cursor-only (ms) |
| ---: | ---: | --- | ---: | ---: |
| 10,000 | 1 | Baseline first | 889.624 | 513.150 |
| 10,000 | 2 | Cursor first | 845.741 | 471.593 |
| 10,000 | 3 | Baseline first | 890.274 | 465.641 |
| 50,000 | 1 | Baseline first | 5,931.633 | 1,684.215 |
| 50,000 | 2 | Cursor first | 5,771.042 | 1,855.923 |
| 50,000 | 3 | Baseline first | 6,283.590 | 1,781.639 |

At 10,000 events, the median was 889.624 ms baseline and 471.593 ms
cursor-only (1.89×), with ranges of 845.741–890.274 ms and 465.641–513.150
ms. At 50,000 events, the median was 5,931.633 ms and 1,781.639 ms (3.33×),
with ranges of 5,771.042–6,283.590 ms and 1,684.215–1,855.923 ms. Every pair
had identical serialized payloads and digests: `4cf22b854014e4988e46c98beaaec80b0f635962f3b1316dc4c330a2b58c01d5`
at 10,000 and
`b06e9384f9a2790e5a865784c1ec968435fb399a0f6243e8e4724a09e2c366c3` at
50,000. Each publication checked out and released one client.

At 10,000 events, total SQL statements rose from 23 to 26 while repeated
source-selection CTE statements fell from 14 to 4. At 50,000, total statements
rose from 63 to 66 while those CTE executions fell from 54 to 4. The cursor
added three round trips while removing repeated source-selection work. These
measurements support that mechanism for this synthetic workload; they do not
identify a hosted bottleneck or establish a Cloudflare/GCP comparison.

The scaled fixtures used social v1 records only. The current SQL included the
migration-0041 retained-history branch, and separate correctness tests exercised
accountless opt-out retention and exact-marker refusal. Scaled active-accountless
and retained-opt-out publications were not measured. The benchmark harness and
logs are scratch-only evidence, not a maintained test or hosted receipt.

## Index assessment

The proposal's SQL file prints candidate index definitions and does not create
them. The ingestion journal already has `(source_id, sequence)` as a primary key,
v1 records already have a `chunk_row_id` index, and the published daily table
already has a source/day/revision access path. Those suggestions should not be
added again. A terminal-only partial journal index and a day-first active-v1
chunk index are plausible only after plans show the relevant scan and enough
selectivity to offset write/storage cost. The v1.1 chunk and record join
candidates are likely low-value under existing unique keys and per-chunk bounds.
PostgreSQL's [partial-index](https://www.postgresql.org/docs/17/indexes-partial.html)
and [multicolumn-index](https://www.postgresql.org/docs/17/indexes-multicolumn.html)
guidance explain why predicate match and column order matter.

## Earlier local A/B measurement (38 migrations)

This earlier study is preserved as background. It used an isolated publisher
snapshot with 38 primary migrations and is superseded as the current-revision
performance comparison by the 41-migration parent-versus-cursor A/B above.

The comparison used real PostgreSQL 17.11 with a fresh schema for each run of
the current publisher and a candidate that preserved the eligibility helper
while testing the proposed publication path. Each pair used the same synthetic,
content-free source and compared the complete serialized publication payload
and SHA-256 digest. Runs alternated current-first and candidate-first order. One
pool connection was checked out and released per publication; maximum observed
active connections were one. The sample was local; it was not a Cloud SQL
timing, production traffic sample, or Cloudflare comparison. PostgreSQL ran in
a dedicated local Colima container with 128 MiB shared buffers, 4 MiB
`work_mem`, and at most two parallel workers per gather. Each schema applied
the 38 primary migrations in that pinned source. Seeding and migration were
outside the timer. The complete publisher call, including checkout,
transaction, SQL, pricing, payload hash and commit, was inside it.

| Selected v1 usage events | Pairs | Current median full publication | Proposed median | Ratio | Payload |
| ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 5 | 18.64 ms | 12.53 ms | 1.49× | Equal in every pair |
| 1 | 5 | 23.81 ms | 14.86 ms | 1.60× | Equal in every pair |
| 1,000 | 5 | 58.24 ms | 52.90 ms | 1.10× | Equal in every pair |
| 10,000 | 5 | 488.16 ms | 338.79 ms | 1.44× | Equal in every pair |
| 50,000 | 3 | 4,268.89 ms | 1,552.63 ms | 2.75× | Equal in every pair |
| 500 v1 + 500 active v1.1 | 5 | 68.07 ms | 53.94 ms | 1.26× | Equal in every pair |

At 10,000 events, the current range was 458.35–598.52 ms and the candidate
range was 320.31–435.75 ms. At 50,000, the current range was 4,207.32–4,418.49
ms and the candidate range was 1,511.05–1,646.17 ms. The 1,000-event ranges
overlap (53.37–70.18 versus 49.36–58.02 ms); that small-case gain is not a
strong result. The 50,000-event fixture contained one social owner/device and
250 chunks of 200 records. At that size, database query time fell from about
3.0–3.1 s to about 0.34 s, consistent with eliminating repeated source CTE
work. The local raw logs and harness remain in the isolated benchmark
workspace; they are not a hosted performance receipt.

The mixed-format fixture used normal pending-object admission and source
activation before setting each v1.1 domain head; no immutability trigger was
disabled. It used separate social owners/devices for 500 v1 and 500 active
v1.1 events. The current range was 65.01–83.26 ms and the candidate range was
52.87–56.26 ms, with exact payload equality in all five pairs. This covers one
mixed selection path, not the full owner/grant/revocation matrix.

A cursor-only variant changed just the spend-pricing pagination in the current
publisher. It retained separate totals/cells queries and did not create a
temporary table. Its own balanced A/B run produced equal payloads:

| Usage events | Pairs | Current median | Cursor-only median | Full candidate median in separate run |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | 5 | 463.06 ms | 340.68 ms | 338.79 ms |
| 50,000 | 3 | 4,300.50 ms | 1,568.02 ms | 1,552.63 ms |

The full candidate was only 0.6% and 1.0% faster than cursor-only at these
sizes across separate balanced sessions; that difference is noise without a
direct three-way trial. At 50,000 events, the current source CTE executes 54
times and cursor-only executes it four times. Cursor-only adds three SQL round
trips relative to current; the full candidate adds seven. Connection count
stayed at one for every measured publication. The result identifies repeated
source-query work, not excess connections, as the measured local bottleneck.

The journal was empty in these fixtures. No `EXPLAIN (ANALYZE, BUFFERS)` or
temporary-file spill measurement was collected. Hosted Cloud SQL timing,
multi-owner skew, high model cardinality, accountless authorization and
terminal-history access remain open. These results are not a Cloudflare/GCP
comparison or a 10× cutover claim.

## Disposition and open gates

1. Preserve the current pool/client dispatch and error normalization. Do not
   apply the ZIP's replacement or its index list verbatim.
2. The cursor-only pricing change is integrated in commit `498c61c1` and passed
   Worker typecheck plus 14/14 focused PostgreSQL 17.11 tests. Keep its bounded
   1,000-row fetch, deterministic ordering, and extra-row exhaustion check.
   This qualification is local and synthetic.
3. Only add temporary chunk staging, a materialized metrics CTE or new indexes
   if a direct three-way trial and `EXPLAIN (ANALYZE, BUFFERS)` on representative
   days show material improvement over cursor-only. Qualify the selected patch
   separately on the small Cloud SQL test tier. Do not infer hosted capacity,
   Cloudflare/GCP parity or a 10× speedup from local synthetic timings.

PostgreSQL's [temporary-table](https://www.postgresql.org/docs/17/sql-createtable.html)
and [parallel-query](https://www.postgresql.org/docs/17/when-can-parallel-query-be-used.html)
references describe the transaction cleanup, manual analysis and cursor
parallelism tradeoffs behind these gates.
