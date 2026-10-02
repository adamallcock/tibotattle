---
title: GCP ops probes
date: 2026-10-02
type: runbook
status: draft
---

# GCP ops probes

> **Draft. Not operational.** The OPS-4 probe jobs exist as code and as local
> dry-run evidence. They are not in the committed desired state, no image
> containing them has been built in Cloud Build, and nothing has run against
> Cloud SQL, the Cloud SQL Admin API or Cloud Logging in any project. Nothing
> here authorizes a deploy, a grant or a schedule. Tooling markers are defined
> in [GCP cutover window](./gcp-cutover-window.md#tooling-markers).

Related: the [infrastructure desired state](../../apps/worker/cloud-run/infra/README.md),
[GCP brake and incidents](./gcp-brake-and-incidents.md) and
[GCP scheduler resume](./gcp-scheduler-resume.md).

## What exists

| Job | Command (image) | Cadence | Identity | State |
|---|---|---|---|---|
| Runtime liveness probe | `node dist/ops-runtime-probe-job.mjs` (add `--probe=log-redaction` for the redaction marker) | every 5 minutes, 120 s timeout | the runtime account, one read-only primary connection | `built` (local dry run and PostgreSQL 17 spec); not registered |
| Backup-audit probe | `node dist/ops-backup-audit-job.mjs` | hourly at minute 17, 120 s timeout | an `opsBackupAudit` account with exactly `cloudsql.instances.get` and `cloudsql.backupRuns.list`; no database connection | `built` (local dry run); not registered, and the account does not exist (`owner`) |

The contract is `cloud-run/ops-probe-contract.mjs` (`OPS_PROBE_JOBS`). Both jobs
refuse `HOST_MODE`, `K_SERVICE`, `PG_TEST_*`, any other `OPS_PROBE_*` variable
and any credential-named variable. They take no secret.

## Reading a line

Each job writes one JSON line per signal: `schema` (`tibotattle-ops-probe-v1`),
`job`, `probe`, `state` (`ok` or `unavailable`) and, for `ok`, a `value`.
Missing evidence is never `0`: an `unavailable` line carries no value, only a
closed `reason` (and, for a database error, the two-character SQLSTATE class).
A line never carries query text, a database error message, a row value, an
application name, an address or a credential. A failed run writes
`{schema, job, status: "failed", code}` to stderr and no signal lines.

| Reason | Meaning |
|---|---|
| `NO_DATA` | The relation exists and holds nothing to measure yet |
| `RELATION_ABSENT` | The table or column is not in this schema |
| `PRIVILEGE_MISSING` | The role may not read the source (see the session signals below) |
| `STATEMENT_TIMEOUT`, `LOCK_TIMEOUT` | The read exceeded 2000 ms or waited more than 500 ms for a lock |
| `QUERY_FAILED` | Any other database error; read the class |
| `UNEXPECTED_RESULT`, `VALUE_OUT_OF_RANGE` | The source answered something the probe will not interpret, such as a cursor ahead of its journal |
| `DEADLINE_EXCEEDED` | The 100 s run deadline passed before this signal |
| `FETCH_FAILED`, `FETCH_TIMEOUT`, `HTTP_STATUS`, `RESPONSE_INVALID`, `PAGE_LIMIT`, `EVIDENCE_UNREADABLE` | The Cloud SQL Admin API read failed, timed out, answered a non-2xx status or an unreadable body, paged past 20 pages, or the evidence could not be judged with certainty |

The signals are the age of the last completed maintenance pass and the last
complete analytics refresh run, the age in days of the newest published
community day, the age of the newest ready v1.2 manifest, the one global
ingestion journal's head sequence and age, the lag to the analytics cursor, the
pending journal rows (counted up to 10001, with `capped` set at that bound) and
the age of the oldest undelivered row, the database size, transaction-id and
multixact age and the cumulative deadlock and conflict counts, and per
application class (origin, analytics, maintenance, migration, probe, other) the
sessions waiting on a lock and the oldest open transaction, plus the
idle-in-transaction count. The counters are cumulative since the statistics
reset; the probe keeps no state, so a consumer differences two lines. There is
no ledger, tombstone, replay or erasure-job signal: the append-only line has
none.

The backup audit writes the OPS-1 verdict as a level (0 ok, 1 warn, 2 breach)
with its closed codes, whether point-in-time recovery is on, and the age of the
newest successful automated backup. A fetch failure is `unavailable`, never ok
and never a breach. A restorable copy older than 365 days is level 2.

## Open decisions (owner)

- **Session signals need a role decision.** `pg_stat_activity` hides other
  roles' sessions from a role that is not a member of `pg_read_all_stats`, so
  under the runtime role the three session signals read `PRIVILEGE_MISSING`.
  Granting that membership to the runtime role would also let the origin's
  credentials read other sessions' query text, which the probe never selects.
  Nothing in this change grants it.
- **The `opsBackupAudit` account** and its two permissions, and registering the
  jobs (an image roll, two triggers created paused, the connection budget).
- **Alerts** on these lines wait for the monitoring bundle (E-OPS5) and the
  owner's notification channel.

## Log-redaction proof

`--probe=log-redaction` inserts one fresh random marker twice into a temp
table, so PostgreSQL raises a unique violation (23505), and rolls back. With the
posture OPS-2 renders (`log_error_verbosity=terse`, no statement and no
parameters in the log) the error line must not carry the key. The proof, run by
hand once registered:

1. Run the job with `--probe=log-redaction` and read the `log_redaction_marker`
   line: `value` 1 means the violation occurred as expected, and `marker` is the
   token to search for. The `log_redaction_posture` line is 1 when the five
   logging settings still hold.
2. Search the Cloud SQL logs (`resource.type="cloudsql_database"`) for the
   marker. The expected result is no match. A match means a log line carried
   row content and the logging posture is not holding: treat it as a privacy
   incident and stop uploads before anything else.

This proves the posture on one error class, not that no other log can carry
content.

## Evidence boundary

The probe SQL ran on a local PostgreSQL 17.10 database with synthetic rows,
and the audit ran against a fake fetch. Cloud SQL's `pg_stat_activity` and
`pg_stat_database` behaviour, the Admin API's real response shapes (the OPS-1
policy fails closed on anything it does not recognize, which would read level
2) and the real logs are unqualified until the first owner-run execution.
