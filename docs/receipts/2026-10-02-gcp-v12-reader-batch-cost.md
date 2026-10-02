---
title: GCP PostgreSQL v1.2 effective reader, cost per page and batch
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP PostgreSQL v1.2 effective reader, cost per page and batch

This is a 2026-10-02 receipt (runs from 02:50 to 04:20 EDT) for branch
`claude/gcp-fp-v12-reader`, built on `6e78d64f` (the dense-owner parity
line). It records **local, synthetic** evidence only: one macOS arm64
workstation (Apple M5 Max, 18 cores, 128 GiB), the local fan-out cluster
(`PostgreSQL 17.10 on x86_64-apple-darwin24.6.0`) on its private Unix socket,
and the importers and harnesses under Node.js 26.2.0. Every corpus is the
content-free synthetic corpus of the d43c8f92 production-code oracles.
Nothing was pushed or deployed. No GCP or Cloudflare resource and no
production data was read or written. The kept dense and Q-1 databases were
only read. Another agent's dense rehearsal and test runs shared the cluster
during most measurements (load average about 7), so the timings are
indicative and the before and after runs are not paired. This receipt does
not qualify a Cloud Run image, Cloud SQL, the GCP seed or the cutover on real
volumes, or a real owner.

It addresses finding 2 of the
[dense-owner parity receipt](./2026-10-01-gcp-dense-owner-parity.md): T-2's
effective-reader verification was quadratic in owner size.

## What changed

`apps/worker/src/postgres-typed-v12-effective-reader.ts` is the GCP-only
PostgreSQL v1.2 effective reader (blob `ec58bebf` before this change). Its
API, its JavaScript validation and refusals, and the rows, order,
multiplicity and grouping of all four reads stay the same. Only its four SQL
statements change. The reader serves:

- `cloud-run/server.mjs` (the runtime record page);
- `src/postgres-typed-legacy-effective-reader.ts`;
- `cloud-run/synthetic-v12-smoke.mjs`;
- the graph benchmark;
- T-2 (`scripts/postgres-v12-transfer.mjs`, `verifyEffectiveReader`).

A permanent PostgreSQL case is registered in `postgres:domain:check`:
`postgres-test/typed-v12-effective-reader-scope.spec.mjs`, with the fixture
`postgres-test/fixtures/typed-v12-effective-scope.mjs`. The change touches no
migration or index, no vendored file, no analytics-v2 source or spec, and no
gcp-fastpath script.

## Diagnosis

Each statement was run under `EXPLAIN (ANALYZE, BUFFERS)` on the kept dense
import (`tibotattle_dense_parity`, 364,111 v1.2 records, statistics from
autovacuum). The owner was the dense owner: 294,198 usage, 62,100 quota and
4,164 session records over 170 days. Its busiest day, 2026-09-29, holds
33,673 usage records in 169 chunks. The table gives execution time and shared
buffers before and after:

| Statement | Before | After | What the cost followed before |
|---|---:|---:|---|
| Days, one 101-day window (T-2's window) | 582 ms, 202,118 buffers | 6.0 ms, 2,532 | Every record of the owner in the window: 232,152 joined rows, then `DISTINCT` |
| Candidate page, first page of the busiest day | 249 ms, 298,810 | 1.0 ms, 879 | Every record of the day, grouped again for each page. Each chunk's record probe was ANDed with a whole-day index scan (169 × 33,673 entries) |
| Candidate page, page 82 of that day | 248 ms, 298,807 | 3.4 ms, 2,877 | As above |
| Occurrence expansion, 200 ids | 2,842 ms, 223,476 | 25.5 ms, 22,149 | Every usage record of the owner: 294,198 rows, with 58,819,500 joined rows rejected |
| Runtime record page, first page of the busiest day | 242 ms, 305,242 | 1.5 ms, 2,113 | Every record of the day, as for the candidate page |
| Runtime record page, page 82 | 174 ms, 208,039 | 3.9 ms, 4,511 | As above |

The cause is the one `c0600bc2` fixed in the analytics-v2 occurrence source:

- No index leads with `occurrence_id`.
- The planner's estimate of the chunk-completeness chain (the correlated
  `record_count` check and the participant joins) collapses to one row.

So the planner drove each statement from the participant's generation
through every chunk and record. It also ANDed each chunk's record probe with
a whole-manifest `(manifest_id, stream)` index scan. As a result:

- the expansion and the days enumeration followed the owner;
- the candidate and record pages followed the day, which made a dense day's
  paging quadratic in the day;
- T-2's walk, an expansion batch for every 200 occurrences, was quadratic in
  the owner.

## The rewrite

Every statement now fences the predicates that do not involve the chunk or
the record as a `MATERIALIZED` scope of manifests. Those predicates are the
head generation, the domain day, the ready manifest, the retained
authorization and the participant. The scope has one row per manifest,
carrying the participant, device and day that the chunk predicates compare
with.

A record is selected exactly when both hold:

- its manifest is in scope;
- its own chunk satisfies the chunk predicates against that manifest: the same
  participant, device, day and stream, and a `record_count` equal to its
  stored rows.

The manifest join already equates the generation's participant and device
with the manifest's, so the old join factors this way. Each statement then
works as follows:

- **Record page.** Each scoped manifest contributes its first `limit + 1`
  records after the cursor, read from its `(manifest_id, stream,
  observed_at_ms)` index with an incremental sort on the occurrence text.
  Each record is checked against its own chunk in a per-record `LATERAL`
  fenced by `OFFSET 0`. The overall first `limit + 1` lie in the union, which
  is ordered and cut exactly as before.
- **Candidate page.** An occurrence's candidate time is its earliest selected
  record of the day. A selected record is its occurrence's earliest exactly
  when no selected record with the same id is earlier. One probe of the scope
  on `(manifest_id, stream, occurrence_id)` checks that. Those earliest
  records after the cursor, in page order, are the candidates. An id is
  unique within a manifest's stream, so each manifest's first `limit + 1`
  are distinct candidates and the union holds the overall first `limit + 1`.
- **Occurrence expansion.** This uses `c0600bc2`'s pattern. Each scoped
  manifest (one per head day) is probed once on `(manifest_id, stream,
  occurrence_id)` for the batch's ids, fenced by `OFFSET 0`. Each match is
  then checked against its chunk. The grouping is unchanged: `min(id)` per
  device, id, time and digest.
- **Days.** For each scoped day, the manifest's chunks are reached on
  `manifest_id` alone and each chunk's records on `chunk_id` alone. Each scan
  is fenced by `OFFSET 0`, so no other predicate is pushed into it. The probe
  stops at the first complete chunk of the stream that holds a record of
  that stream. An `ORDER BY ... LIMIT 1` inside `EXISTS` was tried first and
  reverted: PostgreSQL drops both clauses from an `EXISTS`, so it does not
  fence the scan.

Every statement already deduplicated what it selected (`DISTINCT`,
`GROUP BY` or the `min(id)` group), so the multiplicity of the old joins never
reached a result.

The candidate page used to group by occurrence text; the new statement groups
by stored id. The two agree because the text is the codec's canonical
decoding of the stored id: `decodeTypedTelemetryId` refuses alternate byte
spellings, so distinct stored ids have distinct texts. A state holding two
stored spellings of one id lies outside the codec and would page differently.
The record page and the expansion refuse such a row either way.

The JavaScript side, including every refusal, is unchanged. The statements
keep the 10 s statement timeout. The old shape grew with the day, so a day far
denser than any measured here could reach that timeout and be refused as
unavailable. The rewrite's cost does not grow with the day. That is a change
in cost, not in what is selected.

## Equality

### A/B of the committed and rewritten readers

A harness loaded both readers (`ec58bebf` and the rewrite) through Vite and
called them side by side, read-only. It compared every result or refusal
with `isDeepStrictEqual`: the records (including `recordJson`,
`sourceRecordJson` and `sourceRecordKey`), the cursors and `available`.

| Schema | Comparisons | Mismatches | Refusals compared |
|---|---:|---:|---:|
| Q-1, imported into `v12r_q1` by the rehearsal's importer chain (4 participants, one with 3,649 v1.2 records over 170 days) | 2,242 | 0 | 69 |
| Dense, the kept schema (5 participants, 2 with v1.2 records, 364,111 records) | 7,816 | 0 | 85 |
| The regression fixture with its negative states (below), built into `v12r_q1.v12r_scope` | 378 | 0 | 54 |

The comparisons covered every participant, one participant that does not
exist, and every stream:

- **Days.** The full day span, with two days either side, in 101-day
  windows. Also two shifted windows, single-day windows and two refused
  windows.
- **Pages.** Every day's candidate pages and record pages at limit 200,
  walked to the end along the committed reader's cursor. On the dense schema
  that is 2,623 candidate pages and 2,623 record pages, each set holding all
  364,111 records. Limits 1, 7 and 100 were also run on the busiest and first
  days.
- **Cursors.** Cursors inside a same-instant tie, before it and after it,
  plus refused cursors and limits.
- **Occurrence batches.** The 200-id batches of every day: all of them on
  Q-1 and the fixture. On the dense schema, all of the small owner's and all
  of the dense owner's quota and session batches, plus 152 of its 1,549 usage
  batches, spread over its days and including the busiest day's first and
  last. That is 1,208 batches and 98,694 rows in all.
- **Mixed batches.** A mixed-day batch with duplicates and an absent id, and
  every owner's ids requested as every other owner and stream.
- **Refused batches.** 201 ids, an empty batch, an invalid id and an invalid
  participant.

### T-2's own verification

`verifyEffectiveReader` checks the reader against the sealed source SQLite
(`cb04f411…`, the dense oracle's), independently of the A/B. The committed
function was run from an untracked copy of the script that exports it. With
either reader it returned `verified: true` for 2 participants, 1,020
day-streams, and 364,111 occurrences and records. Both readers produced the
same verification digest, `759b9ea3…`. T-2's opt-in Q-1 dump case
(`postgres-v12-transfer.spec.mjs` with `POSTGRES_V12_TRANSFER_Q1_DUMP`) also
passes with the rewrite.

## Regression case

`typed-v12-effective-reader-scope.spec.mjs` (5 tests) seeds one migrated
schema through the live guards of the primary chain. For each of the five
filters, the fixture stores records that only that filter excludes:

| Filter | Excluded variant |
|---|---|
| Ready manifest | papa's staged day D2 (`STAGED`) |
| Complete chunk | A D1 usage chunk that declares one record more than it holds (`INCOMPLETE`), and D3's only quota chunk, which is incomplete in the same way |
| Participant | quebec's D0 day, quebec's `QUEBEC_ONLY`, and quebec's earlier record of papa's id `A` |
| Retained authorization | romeo, whose owner link is withdrawn |
| Head generation | papa's earlier generation: `OLD_ONLY`, an earlier variant of `SHARED`, and day D4 |

The expectations are derived from the fixture's definitions, not from a
read. They cover:

- days;
- candidate pages, including a same-instant tie split across pages, and two
  quota id encodings whose text order and byte order differ;
- record pages with their storage keys;
- the expansion: a two-day occurrence's two variants, with foreign and
  ineligible variants excluded.

The mutation check ran the spec once per mutant:

- Both readers unchanged, the committed one and the rewrite: 5 of 5 pass.
- Any one filter removed from either reader: 4 of the 5 tests fail, one for
  each of the four reads (10 mutants).
- Any one filter removed from one statement of the committed reader, where
  each statement has its own copy: exactly that statement's test fails
  (20 mutants). In the rewrite the filters are shared by all four statements.

`npm run postgres:domain:check` runs the case in its node:test list.
`ci-postgres-suite --plan` routes it to the SOCKET profile.

## Measurement (Node.js 26.2.0)

### T-2's reader verification

This is `verifyEffectiveReader` on the kept dense schema, with each reader
call timed.

| | Committed reader | Rewrite |
|---|---:|---:|
| Wall | 2,953.5 s | 98.7 s |
| Days (12 calls) | 0.65 s, max 287 ms | 0.11 s, max 24 ms |
| Candidate pages (2,605 calls) | 111.7 s, max 653 ms | 20.3 s, max 102 ms |
| Expansion batches (2,605 calls) | 2,836.1 s, mean 1.09 s, max 2.43 s | 72.2 s, mean 27.7 ms, max 74 ms |

The earlier receipts measured 2,895 to 3,379 s for this verification. Three
more runs of the rewrite:

- **Quieter machine.** An earlier run, whose candidate-page, expansion and
  record-page statements match the final ones, took 72.9 s.
- **Fresh import.** The rehearsal's whole importer chain, run into
  `v12r_dense` from the dense oracle's pinned dump, gave a T-2 phase
  (transfer plus verification) of 144.0 s. The dense-owner parity receipt
  recorded 3,007 s and 2,904 s for the same phase. The phase ran alongside
  the dense A/B and other gates; autovacuum analyzed the tables during the
  import.
- **No planner statistics.** The same import with its `pg_statistic` rows
  deleted, `reltuples` reset and autovacuum off for the schema took 148.1 s.
  Every statement still read only its page or batch: at most 18,574 buffers
  for the 200-id expansion and 9,319 for a record page.

### Runtime record page, dense owner

Times are per `readPostgresTelemetryV12EffectivePage` call at limit 200,
including JavaScript decoding and the SHA-256 check of every record.

| Day | Committed reader | Rewrite |
|---|---:|---:|
| 2026-09-29 (33,673 records, 169 pages) | 45.1 s, mean 267 ms, max 467 ms | 4.4 s, mean 25.8 ms, max 41.3 ms |
| 2026-06-15 (1,200 records, 6 pages) | 197 ms, mean 32.8 ms | 137 ms, mean 22.9 ms |
| All 2,623 pages of the A/B (both owners, every stream) | 128.6 s, max 514 ms | 56.7 s, max 187 ms |

### Expansion against owner size

Each row is 200 ids against 170 head days; the rewrite's figure is the
median of 7 runs.

| Request | Committed reader | Rewrite |
|---|---:|---:|
| Dense owner (294,198 usage), 200 ids of one day | 2,096 ms | 45.6 ms |
| Dense owner, 200 ids over 100 days | 2,061 ms | 45.4 ms |
| Small owner (2,293 usage), 200 ids over 100 days | 49.7 ms | 27.2 ms |

The dense owner has 128 times the small owner's records but costs 1.7 times
as much: the expansion now follows the batch and the number of head days.

## Gates

| Gate | Result |
|---|---|
| `tsc --noEmit` (apps/worker) | exit 0 |
| The new spec alone (`PG_TEST_SOCKET`) | 5/5 |
| `postgres:domain:check`, vitest half (`PG_TEST_SOCKET`, `PG_TEST_TCP_HOST`) | 12 files, 76/76 |
| `postgres:domain:check`, node:test half | 342 tests: 340 pass, 0 fail, 2 skipped. The skips are ledger-authority, which needs `PG_TEST_HOST`, and T-2's opt-in Q-1 dump case, run separately above and passing |
| `typed-v12-normalized.spec.mjs` (`PG_TEST_HOST` profile) | **Fails at the base too, identically with either reader.** Its fixture participant has no `consent_version`, so admission refuses with `TELEMETRY_REQUIRED` before any read. In a scratch copy with that one value set, every reader assertion passes with both readers. The test then fails with both at its erasure step, where the 0035 guard raises `telemetry_v12_ready_source_retained` |
| `cloud-run/host.check.mjs` (`PG_TEST_SOCKET`) | 22 tests. The v1.2 effective-page assertions passed in every run. One later assertion is flaky with both readers: the concurrent accountless v1.2 grant step returned one 503. It failed in 4 of 5 runs with the rewrite and 1 of 3 with the committed reader, and passed 22/22 in one run with each |
| `npm run scripts:check` | exit 0, 967/967 |
| `ci-postgres-suite --plan` | **exit 1 at the base too.** Its one failure is `PROFILE_ROUTING_AMBIGUOUS` for `postgres-ingestion-journal-transfer.spec.mjs` (unresolved `PG_TEST_TCP_HOST`, since `6850ba06`), identical at `6e78d64f`. The plan differs from the base only by the new spec, routed SOCKET |
| `npm run architecture:check` (root) | passed (919 production files, 3,911 imports) |
| `npm run test:preflight` (root) | passed |

Not run: Docker, root `npm test` and `npm run check`, the Worker's full
`check` and default Vitest suite, the cloud-run `npm run check` build, and
anything on GCP or Cloudflare.

## Findings and limits

1. **The expansion still probes every head day.** Each batch makes one
   indexed probe per current-head manifest: about 25 ms of execution at 170
   days. That cost grows with retained head days, not with records. An index
   leading with `occurrence_id`, or a day argument in the expansion API,
   would make it follow the batch alone. Removing the quadratic cost needed
   neither, so no migration was added. Either is a schema or API decision.
2. **The plans rest on planner choices.** They were checked with autovacuum
   statistics on the kept schema and with all statistics deleted on a copy.
   Both stayed bounded by the page and the batch.
3. **Two guards cannot be reached under the current keys.** The candidate
   page's earliest-record check and the per-manifest union matter only when a
   participant's day has more than one scoped manifest. The current keys
   forbid that: one head per participant, and one domain day per generation
   and day. Both guards are kept so that equality does not rest on those
   keys, but no fixture can exercise them.
4. **Out of scope and unchanged:**
   - the largest real owner (about 7 times the dense owner), Cloud SQL and
     Cloud Run, none of which was measured;
   - production's D1 reader (the Worker), which has the same shape;
   - the legacy v1/v1.1 expansion (finding 3 of the dense-owner parity
     receipt).
5. **Gate failures that predate this branch** are listed under Gates: the
   suite plan's routing ambiguity, the stale normalized spec, and the host
   check's flaky concurrent grant. None was changed here.

Scratch databases `v12r_q1` and `v12r_dense` and their work files were
removed after the runs.
