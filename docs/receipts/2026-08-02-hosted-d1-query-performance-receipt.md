---
title: Hosted D1 Query Performance Receipt
date: 2026-08-02
type: receipt
status: completed
---

# Hosted D1 Query Performance Receipt

## Scope

This receipt closes the release-blocking read-time-counting defect identified
in `telemetry-repository.ts`. A contribution now stores
`accepted_record_count` at ingest from the actual `INSERT OR IGNORE` results;
`declared_record_count` remains the client-declared batch size. The Worker
computes server-pricing totals from the usage pricing results already in
memory. Migration `0018_contribution_accepted_record_count.sql` adds the
stored count, backfills existing contributions, and adds the
`origin_contribution_id` index for the bounded repair path and future joins.

The index is not the primary fix: normal dashboard reads no longer count
records at all.

## Fixture and method

- SQLite: `/usr/bin/sqlite3`, local SQLite 3.51.0.
- Schema: the repository migrations `0001` through `0017` for the before
  database; the same migration set plus `0018` for the after database.
- Data: one active participant, 100 valid telemetry contributions, and
  200,000 `usage` rows linked to the first contribution.
- Dashboard query: the old `LIMIT 100` correlated count and the new
  `SELECT c.*` bounded list, both forced to evaluate by summing the returned
  counts.
- Finalize query: the old four correlated pricing subqueries and the new
  constant-bound update using the Worker-computed totals.

The benchmark databases were disposable files under
`/tmp/app-usagemonitor-d1-bench.*`; no repository or live D1 state was used.

## Query plans

Before, finalize performed four correlated scans:

```text
SEARCH telemetry_contributions USING INDEX sqlite_autoindex_telemetry_contributions_1 (id=?)
CORRELATED SCALAR SUBQUERY 1 -> SEARCH telemetry_records USING INDEX telemetry_records_aggregate_time (record_kind=?)
CORRELATED SCALAR SUBQUERY 2 -> SEARCH telemetry_records USING INDEX telemetry_records_aggregate_time (record_kind=?)
CORRELATED SCALAR SUBQUERY 3 -> SEARCH telemetry_records USING INDEX telemetry_records_aggregate_time (record_kind=?)
CORRELATED SCALAR SUBQUERY 4 -> SEARCH telemetry_records USING INDEX telemetry_records_aggregate_time (record_kind=?)
```

After, finalize is one contribution-row lookup:

```text
SEARCH telemetry_contributions USING INDEX sqlite_autoindex_telemetry_contributions_1 (id=?)
```

Before, the dashboard carried one full scan per listed contribution:

```text
SEARCH c USING COVERING INDEX telemetry_contributions_participant_created (participant_id=?)
CORRELATED SCALAR SUBQUERY 1 -> SCAN r
```

After, it is only the participant history index:

```text
SEARCH telemetry_contributions USING INDEX telemetry_contributions_participant_created (participant_id=?)
```

## Measured wall time

Each statement was run three times against the same 200,000-row fixture.

| Path | Before | After | Result |
|---|---:|---:|---|
| Ingest finalize update | 94, 94, 96 ms | 1, <1, <1 ms | unbounded table reads removed |
| `/api/v1/me` contribution list | 1.225, 1.259, 1.249 s | 1, <1, <1 ms | 100 correlated scans removed |

The summed dashboard result was `200000` before and after. The replacement
finalize update left the accepted count at `200000`, matching the fixture's
actual stored row count.

## Correctness coverage

The Worker test suite now proves that:

- a normal contribution stores the count at ingest;
- a replay-overlap contribution can have `declared_record_count = 3` and
  `accepted_record_count = 1`, so the two values are not conflated;
- its stored server-priced usage count follows the records actually stored,
  including a batch that adds only a non-usage activity marker;
- the personal profile path does not prepare SQL containing
  `origin_contribution_id`;
- a contribution whose accounting write is interrupted is repaired on the
  next authenticated profile read; and
- the repair is guarded by `accepted_record_count IS NULL` and uses the new
  index-backed ownership predicate.

Validation on the current checkout:

- `npm --prefix apps/worker test`: **172 passed, 0 failed**;
- `npm run architecture:check`: passed, 283 production files, 1,049 imports,
  0 approved debt edges; and
- `git diff --check`: passed.

The benchmark is local SQLite evidence, not a claim of a specific Cloudflare
D1 latency. The important release property is the plan change: normal reads
and ingest finalization are now bounded by the contribution or upload batch,
not by the lifetime size of `telemetry_records`.
