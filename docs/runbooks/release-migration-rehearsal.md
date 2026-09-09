---
title: Release migration admission and rehearsal
date: 2026-09-08
type: runbook
status: maintained
---

# Release migration admission and rehearsal

Run this early, before expensive analytical qualification or signing. It proves
the selected migration bytes can upgrade a populated synthetic predecessor; it
does not authorize migrations, prove current production state, or replace final
Worker qualification and production recovery checks.

## Observe the deployed prefix

From the repository root, the following operation only reads the migration
ledger names for both configured databases. It neither queries telemetry nor
changes remote state:

```sh
umask 077
node apps/worker/scripts/rehearse-release-migrations.mjs observe-prefix \
  --environment production > /private/tmp/reviewed-migration-prefix.json
```

`staging` is the other supported environment. Authentication remains with the
existing Wrangler credential mechanism. No credential value is printed. A
missing, malformed, reordered, unknown or gapped ledger refuses admission.

The output is a closed `release-migration-prefix-v1` document containing
`observedAt`, `environment`, and `migrations`. Both `USAGE_MONITOR_DB` and
`DELETION_LEDGER` are arrays of `{name, sha256}` objects in migration order.
Names come from the ledger; hashes come from the current reviewed source.
**D1's names-only ledger cannot attest the bytes originally applied.** Resolve
any historical source uncertainty using retained deployment evidence before
relying on it. The observation is a two-database snapshot, not an atomic remote
lease; final deployment must check the ledger again.

A maintainer can supply the same exact schema from separately reviewed evidence,
with `environment: "reviewed-snapshot"`. Local rehearsal always labels supplied
prefix freshness `supplied-snapshot-not-live`, including a recently observed file.
It never guesses the predecessor from the latest migration or release version.
The prefix file must be a regular, owner-only, single-link file. It is private
operational input, not a document to commit.

## Run the populated local gate

```sh
node apps/worker/scripts/rehearse-release-migrations.mjs local \
  --prefix /private/tmp/reviewed-migration-prefix.json \
  --accounts 1000 --events 100000
```

The default fixture is 1,000 synthetic accounts, 100,000 records in **each** of
the retained legacy and incremental telemetry tables, with observations spanning
336 days (not a claim that every day has records).
One account contributes half the records to exercise skew. Valid synthetic
session, pairing, device, upload, consent and chunk chains use the original
foreign keys and admission triggers. Tombstones and available identity cooldown
tables are populated too. No production rows, secrets or private session data
are copied.

The tool creates an owner-only temporary directory, applies both exact prefixes,
seeds the fixture, and checks each pending migration twice:

1. Execute the migration and ledger append inside an uncommitted transaction,
   close the actual SQLite connection, reopen it, and prove both rolled back.
2. Apply forward, commit, then prove retained row digests, foreign keys and
   database integrity still match. The final ledger must match the full reviewed
   inventory; replay has no pending migration and performs no writes.

Preservation hashes cover the predecessor's columns, allowing additive columns
without masking changes to existing data. Participant/consent, credentials,
telemetry, collection controls, retention state and deletion safety are checked
separately from disposable analytical caches. The fixture currently supports
primary prefixes beginning at migration 0031 and deletion-ledger prefixes
beginning at 0001. Earlier predecessors fail explicitly until a reviewed fixture
for their different transport contract is added.

The JSON result binds both migration inventories and the supplied prefix to
digests, records runtime identity, fixture dimensions, elapsed time, sampled
resident memory and database sizes. Defaults refuse a completed proof above
120 seconds, 512 MiB per database or 1 GiB sampled process memory. The API accepts
tighter ceilings; absolute input maxima are 1,000 accounts and one million
records per telemetry table. Seeding streams statements instead of constructing
an unbounded in-memory SQL document.

On macOS or Linux, the local CLI runs the exact current Node executable in an isolated process
group, passing the plan privately over standard input. An **external watchdog**
terminates the group at the wall-clock ceiling even if SQLite is blocked, and
samples its resident memory every 250 ms. Sustained inability to observe memory
fails closed (including a sandbox that denies process observation). Other
platforms refuse until equivalent process containment is implemented. A Node
heap limit and SQLite page-count ceiling add protection.
The page ceiling is reapplied on every reopened SQLite connection; it bounds
the database file, not the combined temporary database plus rollback-journal
disk footprint. Allow separate scratch-disk headroom for transactional journals.
Termination escalates from SIGTERM to SIGKILL, and completion is not reported
until the child closes. Captured output is bounded and never exposes raw errors.

Unknown termination returns `REHEARSAL_TERMINATION_UNCONFIRMED` and preserves
the temporary database for inspection; it does not delete a possibly live
process's state. The ordinary successful/confirmed-failed paths clean up only
their own temporary directory. The exported in-process API remains available
for unit tests, with between-statement checks; it is not the contained CLI gate.
These are **local resource admission measurements**, not Cloudflare memory-limit
or production-load certification. RSS limits are sampled, not a guarantee
against every transient allocation peak. Failed validation never emits a
completed receipt. The result always says `productionReadiness: false` and
`remoteSyntax: "not-exercised"`.

## Separately approved disposable remote syntax check

This mode **writes remote D1** and requires separate approval for the exact two
existing disposable databases. It does not create, delete, reset, or use the
production/staging resources. Do not invoke it merely because the local gate
passed or credentials are available.

Prepare an owner-only target JSON document with exactly:

```json
{
  "schemaVersion": 1,
  "purpose": "release-migration-rehearsal",
  "databases": {
    "USAGE_MONITOR_DB": {
      "database_name": "tibotattle-rehearsal-primary",
      "database_id": "11111111-1111-4111-8111-111111111111"
    },
    "DELETION_LEDGER": {
      "database_name": "tibotattle-rehearsal-ledger",
      "database_id": "22222222-2222-4222-8222-222222222222"
    }
  }
}
```

Those UUIDs are placeholders. Use only the separately approved disposable IDs.
The tool rejects every database ID/name in the normal configuration and all
configured environments, duplicate IDs, non-rehearsal names, and any occupied
database before the first mutation. It generates an isolated temporary Wrangler
configuration with just the approved pair, applies the predecessor, inserts a
small synthetic fixture (two accounts, 20 records per telemetry table), applies
the remaining migrations, then checks final ledgers and preserved counts.

```sh
node apps/worker/scripts/rehearse-release-migrations.mjs remote-syntax \
  --prefix /private/tmp/reviewed-migration-prefix.json \
  --target /private/tmp/approved-disposable-d1.json \
  --confirm APPLY_SYNTHETIC_MIGRATIONS_TO_DISPOSABLE_D1
```

This mode exercises Cloudflare's actual migration parser and transaction runner;
it is deliberately not a 1,000-account remote load test. Each subprocess has a
timeout and bounded captured output. Raw Wrangler errors are not propagated.
An uncertain mutation stops without retrying or cleanup of remote resources.
The targets remain for owner inspection, including on success. Do not blindly
retry: a rerun refuses occupied targets, and the owner must reconcile the exact
remote ledger before choosing separately approved fresh disposable resources.

### Exact 0058 asynchronous-import qualification

For the reviewed primary 0056 / deletion-ledger 0002 predecessor only, the same
fresh-pair admission supports one explicit transport variation:

```sh
node apps/worker/scripts/rehearse-release-migrations.mjs remote-syntax \
  --prefix /private/tmp/reviewed-migration-prefix.json \
  --target /private/tmp/approved-disposable-d1.json \
  --confirm APPLY_SYNTHETIC_MIGRATIONS_TO_DISPOSABLE_D1 \
  --import-migration 0058_accountless_upload_ownership.sql
```

No other migration name or predecessor is accepted by this option. The tool
applies the exact predecessor, seeds the existing two-account/20-record fixture,
applies 0057 normally, imports unchanged 0058 and its ledger append in **one**
file, then applies remaining migrations normally. It does not create or delete
remote resources. File imports may make the selected disposable database
unavailable while processing. They never target normal staging or production.

Import completion accepts only the pinned CLI's known upload progress followed
by one complete successful terminal result with a final bookmark. Partial,
malformed or unexplained output refuses qualification. Before/after hashes cover
original columns of retained synthetic rows, with 256-row per-table readback
ceilings; foreign keys and final ordered ledgers must pass. The receipt binds
0058's source and complete import-file hashes, provider duration and terminal
completion. This is small-fixture hosted proof, not production-size admission.

Any uncertain mutation stops. In this optional mode the tool retains its
owner-only temporary target configuration, SQL and fixture and reports its
`recoveryDirectory` in the closed error receipt. Keep that receipt private.
Reconcile provider terminal status and exact remote ledgers/schema before
choosing any retry or deletion. A client timeout is not cancellation; rerunning
the command refuses occupied targets. Do not delete the new databases while an
import outcome is unknown. Resource creation and eventual exact-ID deletion
must be included in the separately approved disposable operation.

Command syntax is based on the current [Cloudflare D1 Wrangler reference](https://developers.cloudflare.com/d1/wrangler-commands/).
The owning regression suite is:

```sh
node --test apps/worker/scripts/rehearse-release-migrations.check.mjs
```
