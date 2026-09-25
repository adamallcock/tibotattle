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
These identities matter because the proposal's included baseline file differs
from the current publisher. No proposed source or indexes were deployed to GCP
or merged into this integration branch by this review.

**Decision:** Do not replace the module wholesale. Port the pricing cursor first
as a small patch, preserving the current eligibility helper. It captured
essentially all of the measured 10,000- and 50,000-event gain without the
proposal's temporary tables or materialized aggregate. The full replacement
removes a current checked-out-client safety fix. The bundle's own mocked tests
did not establish SQL correctness or speed; the real PostgreSQL comparison and
remaining hosted gates are recorded below.

## Why the proposal could help

The current `priceDailySpend()` reissues the owner, active-chunk, winning-device
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
| Source selection | The v1 social-only simplification is algebraically sound under the current query: accountless eligibility requires a v1.1 domain head, while v1 selection excludes any such head. The v1.1 grant/domain joins and all-stream device ranking are retained by inspection. Real database tests remain necessary for mixed owner and device cases. |
| Capacity and cleanup | The proposal stages at most 30,001 active chunks and rejects the 30,001st before ranking or record work. Its temporary tables use `ON COMMIT DROP`, with one table dropped earlier; the existing mutation helper pins one connection and rolls back failures. The role's TEMP privilege and cleanup still need hosted qualification. PostgreSQL does not auto-analyze temporary tables, so the explicit `ANALYZE` is justified for the proposed plan. |
| Pricing records | The cursor retains the ordering, timestamp conversion, pricer and BigInt accumulation. A final fetch detects one extra row for nonzero workloads, including an exact batch multiple. The zero-event return follows the declared-count comparison; selected v1 chunks require a positive count and v1.1 chunks declare 1–200 rows. This is not a per-chunk child-count proof. |
| Journal fence | Two ordered top-one lookups retain the original latest and terminal sequence validations, locks and final terminal guard. The all-event lookup can use the existing `(source_id, sequence)` primary key. The terminal lookup may scan many nonterminal entries without a matching partial index; this needs a history-heavy plan. |
| Near-cap risk | The metrics CTE materializes one row per selected analytical record for both aggregates. A 30,000-chunk envelope with up to 200 declared records per chunk can imply millions of rows; physical child count is not fully bounded by that declaration. PostgreSQL will not use a parallel plan for a `DECLARE` cursor, and materialization can spill. Test the small Cloud SQL tier before relying on a near-cap improvement. |

The original bundle reported 41 mocked tests and a strict check against
handwritten type stubs, but explicitly reported no PostgreSQL execution or
project-module typecheck. Its harness does not run unchanged with this checkout's
TypeScript 7 toolchain. The current Worker's own typecheck passed before the
proposal was applied; that does not validate the proposed replacement.

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

## Local A/B measurement

The comparison uses real PostgreSQL 17.11 with a fresh schema for each run of
the current publisher and a candidate that preserves the current eligibility
helper while testing the proposed publication path. Each paired case uses the
same synthetic, content-free source and compares the complete serialized
publication payload and SHA-256 digest. Runs alternate current-first and
candidate-first order. One pool connection was checked out and released per
publication; maximum observed active connections were one. The sample is
local; it is not a Cloud SQL timing, production traffic sample, or Cloudflare
comparison. PostgreSQL ran in a dedicated local Colima container with 128 MiB
shared buffers, 4 MiB `work_mem`, and at most two parallel workers per gather.
Each schema applied the 38 primary migrations present in the pinned source.
Seeding and migration were outside the timer. The complete publisher call,
including checkout, transaction, SQL, pricing, payload hash and commit, was
inside it.

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
2. Port the pricing cursor alone first. Preserve its bounded 1,000-row fetch,
   deterministic order and extra-row exhaustion check. Add current-project
   typecheck and real PostgreSQL regression coverage for direct-client
   eligibility, mixed v1/v1.1 owners and grants, ties, capacity boundaries,
   rollback cleanup and concurrent source changes.
3. Only add temporary chunk staging, a materialized metrics CTE or new indexes
   if a direct three-way trial and `EXPLAIN (ANALYZE, BUFFERS)` on representative
   days show material improvement over cursor-only. Qualify the selected patch
   separately on the small Cloud SQL test tier. Do not infer a hosted or 10×
   speedup from local synthetic timings.

PostgreSQL's [temporary-table](https://www.postgresql.org/docs/17/sql-createtable.html)
and [parallel-query](https://www.postgresql.org/docs/17/when-can-parallel-query-be-used.html)
references describe the transaction cleanup, manual analysis and cursor
parallelism tradeoffs behind these gates.
