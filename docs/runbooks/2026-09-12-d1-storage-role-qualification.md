---
title: Local analytics and control schema qualification
date: 2026-09-12
type: runbook
status: local-implementation-only
---

This procedure supplies the analytics and control schema evidence consumed by
the [typed storage operator](2026-09-11-d1-storage-operator.md). It creates only
fresh synthetic local D1 databases. It does not restore ingestion, qualify the
independent deletion ledger, create remote resources, or authorize activation.

## Rehearsal and qualification

Run from `apps/worker` with the repository's Node runtime and locked Worker
dependencies. Each output directory must be new and its parent must exist.
Keep outputs and validation logs in a private ignored directory or outside the
checkout; the tool never writes qualification files into the source migrations.

An unfinished checkout can produce explicitly unqualified schema evidence:

```sh
node scripts/d1-storage-qualify-role.mjs \
  --worker-root . \
  --directory /absolute/private/analytics-rehearsal \
  --role analytics \
  --allow-unfrozen
```

For qualification, first freeze the reviewed source and run `npm run check`
from `apps/worker`. Preserve stdout and stderr separately and record the actual
exit status and start/completion times. The explicit owning-gate receipt has
exactly this shape; placeholders are not valid evidence:

```json
{
  "schema": "d1-storage-owning-gate-v1",
  "sourceCommit": "<40-character source commit>",
  "command": "npm run check",
  "workingDirectory": "apps/worker",
  "roles": ["analytics", "control"],
  "exitCode": 0,
  "startedAt": "<actual UTC ISO timestamp with milliseconds>",
  "completedAt": "<actual UTC ISO timestamp with milliseconds>",
  "stdoutSha256": "<SHA-256 of the exact stdout file bytes>",
  "stderrSha256": "<SHA-256 of the exact stderr file bytes>"
}
```

Hash the exact receipt file bytes as well. A receipt cannot be inferred from a
previous green run, a partial suite, or successful empty-schema creation.

```sh
node scripts/d1-storage-qualify-role.mjs \
  --worker-root . \
  --directory /absolute/private/analytics-qualified \
  --role analytics \
  --qualify \
  --gate-receipt /absolute/private/owning-gate.json \
  --gate-receipt-sha256 <exact-receipt-sha256> \
  --gate-stdout /absolute/private/owning-gate.stdout.log \
  --gate-stderr /absolute/private/owning-gate.stderr.log
```

Run the same command with `--role control` and a distinct output directory for
the routing catalog. Only these two roles are admitted. Qualification requires
clean source before and after execution, matching emitter/source bytes, the
exact source-bound gate receipt, and verified log bytes. Dirty qualification,
remote options, existing output directories and changed inputs are refused.

## Evidence and handoff

Every ordered role migration runs once as a native D1 batch. The tool retains
an intent before submission and a result containing the actual before/after
`sqlite_schema` digests, SQL SHA-256, statement count and foreign-key check.
Failures retain the local database and receipts, without automatic retry.

The output's `worker/analytics-migrations` or `worker/routing-migrations`
contains exact SQL, `qualification.json`, `qualification-evidence.json`, and
the verified gate receipt/logs. The final schema inventory and per-step evidence
remain in the enclosing private output. Retain that complete output. Qualified
manifests are checked by the maintained `loadStorageQualification` parser;
unqualified rehearsal manifests are rejected by that parser.

For a combined operator mirror, copy these role directories unchanged alongside
the separately qualified ingestion restore base and all six original ingestion
role input directories. Use the returned qualification hashes in the reviewed
plan. The schema evidence always states `runtimeReady: false`: owning-suite and
schema results do not replace restored-data, authority, deletion-ledger,
capacity, independent-analytics or remote activation qualification.
