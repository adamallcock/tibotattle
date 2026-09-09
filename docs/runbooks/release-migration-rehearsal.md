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

## Explicit local 5 GiB stress profile

For the exact primary 0056 / deletion-ledger 0002 prefix, an optional local-only
profile measures storage, rollback recovery and whole migration transaction time:

```sh
node apps/worker/scripts/rehearse-release-migrations.mjs local \
  --prefix /private/tmp/reviewed-migration-prefix.json \
  --profile production-scale-5gib
```

The profile pins the reviewed 0057–0059 source hashes and rejects dimension or
limit overrides. Standard defaults and the one-million-record/1 GiB database
input guards remain unchanged. The profile uses the same valid 1,000-account,
100,000-record-per-table fixture, then updates only synthetic `record_json`
values in 200-row prepared-update blocks until the primary reaches at least
5 GiB (at most 64 MiB overshoot). Padding is applied in ascending record-ID order
to both retained telemetry tables. The receipt records padded and unpadded row
counts and bytes. This is a **synthetic legacy/v1-heavy storage stress fixture**,
not an observed or representative production distribution.

The preservation baseline is taken after padding. Original-column hashes stream
rows rather than retaining the corpus in memory. Exact migration SQL, foreign
keys, ledger append, interruption rollback and forward transaction boundaries
stay unchanged. SQL duration and whole transaction duration are recorded
separately from full preservation/integrity checks. Per-statement timings and
index/page-category measurements are explicitly not collected.

Admission requires at least 22 GiB available on the canonical scratch filesystem.
The isolated run has a 600-second deadline, 10,000,000,000-byte primary page
ceiling, 512 MiB deletion-database ceiling, 20 GiB total scratch ceiling and
2 GiB free-space reserve. SQLite uses a 32 MiB page cache, DELETE journals and
in-memory temporary structures. The external observer samples combined parent
and child RSS (2 GiB ceiling), all owned scratch files including journals, and
free space every 250 ms. These are sampled bounds; short transient peaks between
samples are not proven absent. Missing disk observations fail closed. A bounded
phase record identifies the migration and interrupted/forward pass when a
resource failure occurs; closed failure receipts retain observed peak metrics.
Only confirmed process termination permits deleting the owned scratch directory.
No remote calls or production data are used, and ordinary regression tests do
not run this multi-gigabyte workload.

A locally fast transaction does **not** qualify the hosted operation. D1 limits
the entire API query batch to 30 seconds and explicitly advises batching large
modifications; unchanged 0058 also failed the separately tested asynchronous
import route. Local evidence informs storage/recovery design and cannot replace
a supported, qualified hosted migration path. See
[Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Single-attempt production migration proposal

This is a prepared operation, **not authorization to execute it**. It uses the
normal atomic migration route, with no index wrapper, asynchronous import,
phased evacuation, table overlays or invocation registry. A failure is a possible
outcome, not evidence that the actual production distribution matches the local
padding-heavy stress fixture. Cloudflare documents rollback of a failed
migration while earlier successful migrations remain applied; client transport
failure is not proof of rollback. See [Wrangler migrations](https://developers.cloudflare.com/d1/wrangler-commands/).

The approval must explicitly cover: the existing **production primary** D1;
one attempt at the exact reviewed primary 0057, 0058 and 0059 migrations; temporary
revision-checked pause of all four collection stages; read-only bookmarks,
ledger/schema/health reconciliation; and conditional restoration of the captured
controls after an operator-reviewed known outcome, within the same eventual
user authorization. No second user approval is required when those approved
conditions are met. The deletion ledger receives
**no migration or write**. Its bookmark is read for recovery context. This scope
excludes deployment, accountless-mode activation, key changes, canary uploads,
index changes, retry, restore, deletion, new resources and release publication.
Approving containment alone does not authorize restoring collection.

### Prepare and admit, without mutations

Run commands sequentially from `apps/worker` in the exact reviewed checkout.
Create a new owner-only evidence directory; `OP_DIR` below means that actual
absolute directory, not a reused receipt directory. Enable shell no-clobber
output and retain all output privately. Record the checkout commit, pinned
Wrangler version and SQL hashes. Do not use a freshly downloaded CLI.

```sh
umask 077
set -C
OP_DIR=$(mktemp -d /private/tmp/tibotattle-production-atomic-XXXXXX)
git rev-parse HEAD > "$OP_DIR/source-commit.txt"
./node_modules/.bin/wrangler --version > "$OP_DIR/wrangler-version.txt"
shasum -a 256 migrations/0057_accountless_enrollment_ledger.sql migrations/0058_accountless_upload_ownership.sql migrations/0059_accountless_upload_renewal.sql > "$OP_DIR/pending-sha256.txt"
node scripts/rehearse-release-migrations.mjs observe-prefix --environment production > "$OP_DIR/prefix-before.json"
./node_modules/.bin/wrangler d1 info USAGE_MONITOR_DB --env production --json > "$OP_DIR/primary-info.json"
./node_modules/.bin/wrangler d1 info DELETION_LEDGER --env production --json > "$OP_DIR/ledger-info.json"
./node_modules/.bin/wrangler d1 execute USAGE_MONITOR_DB --env production --remote --command "SELECT schema_version,control_state,revision,enrollment_enabled,upload_registration_enabled,processing_enabled,publication_enabled,reason_code FROM collection_controls WHERE singleton=1; SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name;" --json > "$OP_DIR/preflight-schema-controls.json"
```

Require configured/live production UUID agreement and separation from staging;
primary prefix 0001–0056 and deletion prefix 0001–0002; the three hashes in the
[activation proposal](../plans/2026-09-09-production-accountless-activation-proposal.md#observed-migration-admission-and-local-result);
no additional pending migration, pre-existing 0058 save table, unknown schema,
active owner erasure/restore fence or competing operator migration. Retain the
current healthy service/storage/lifecycle readback. No live telemetry rows or
full-database export are needed for this admission. The following prepared SQL
admits only the already observed revision 1/all-enabled/initial state. Any drift
stops preparation for a revised exact operation; do not substitute a new
revision silently.

**Bounded deployed-source compatibility admission passed (2026-09-09):**
exact Worker `32cd6317622c9aef9b7bf015b376b4cdb93c91fc` passed nine local
function/SQL cases at each primary prefix 0056, 0057, 0058 and 0059, with the
independent deletion-ledger schema at 0002. The private receipt and reproducible
fixture are in `production-activation-preparation-20260909/deployed-prefix-compatibility-01/`
under the existing release evidence root. `provenance.json` verifies all 50
bundled Worker/workspace-package source inputs against that commit; runtime
package pins are jsonc-parser 3.3.1 and runcost 0.2.1.

These calls exercise social enrollment/identity reattachment, device pairing
and authentication, upload ownership and consumed-authorization replay refusal,
accepted contribution insertion and receipt replay, retained v1 personal
statistics, collection-control refusals/restoration, and device lifecycle
maintenance. Health coverage is its exact primary/deletion-ledger SQL shapes.
The fixture uses a local SQLite D1 adapter and Node constant-time comparison;
it does not qualify full HTTP health, OAuth, R2, Durable Objects, concurrency,
provider query limits or every old runtime path. Refresh the deployed source
identity before admitting the operation; drift invalidates this binding.
Keep accountless modes disabled while this old Worker remains deployed: its
social-only readers/lifecycle functions do not establish compatibility with
new accountless owners. All canonical old table/view/index names and social
ownership semantics must remain intact; do not substitute phased evacuation
or read-through views for the proposed atomic migration.

### Approved pause, then fresh recovery bookmarks

The production runbook permits owner-run revision-checked D1 controls. Do not
repurpose the local-only `collection-control.mjs`. Prepare the following exact
SQL in the new private `pause.sql` file, then invoke it only after approval:

```sql
UPDATE collection_controls
SET enrollment_enabled=0, upload_registration_enabled=0,
    processing_enabled=0, publication_enabled=0,
    control_state='contained', reason_code='maintenance', revision=2,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1 AND revision=1 AND control_state='operational'
  AND reason_code='initial' AND enrollment_enabled=1
  AND upload_registration_enabled=1 AND processing_enabled=1
  AND publication_enabled=1;
SELECT changes() AS changed, control_state,reason_code,revision,
       enrollment_enabled,upload_registration_enabled,processing_enabled,publication_enabled
FROM collection_controls WHERE singleton=1;
```

```sh
./node_modules/.bin/wrangler d1 execute USAGE_MONITOR_DB --env production --remote --command "$(cat "$OP_DIR/pause.sql")" --json > "$OP_DIR/pause-result.json" 2> "$OP_DIR/pause-stderr-private.txt"
./node_modules/.bin/wrangler d1 time-travel info USAGE_MONITOR_DB --env production --json > "$OP_DIR/primary-paused-bookmark.json"
./node_modules/.bin/wrangler d1 time-travel info DELETION_LEDGER --env production --json > "$OP_DIR/ledger-bookmark.json"
```

Require a successful terminal pause result, `changed=1`, revision 2, maintenance
reason, contained state and all four flags0 before reading bookmarks or doing
anything dependent. Ambiguous pause outcome requires read-only reconciliation.
These controls reduce new contribution work; they **do not prove old HTTP,
OAuth or lifecycle invocations drained**. Atomic migration keeps partial table
states uncommitted, which is the reason this proposal avoids the phased-read
hazard. A bookmark is not an atomic lease across databases and does not protect
against unrelated later legitimate writes. It is not permission to rewind them.

### Exactly one normal migration invocation

Recheck the admitted source and pending set immediately before executing. The
pinned normal migration command sends each unchanged migration and its ledger
append in one `/query` batch. It applies 0057, then 0058, then 0059 sequentially;
these are **three transactions**, not one transaction across the set.

```sh
./node_modules/.bin/wrangler d1 migrations apply USAGE_MONITOR_DB --env production --remote > "$OP_DIR/migrations-stdout-private.txt" 2> "$OP_DIR/migrations-stderr-private.txt"
MIGRATION_EXIT_STATUS=$?
printf '%s\n' "$MIGRATION_EXIT_STATUS" > "$OP_DIR/migrations-exit-status.txt"
```

Record the actual process exit status separately, including on failure. Do not
chain deployment/restoration commands to its exit code. Never use `--file` for
this operation: that selects the different asynchronous import route. Do not
retry the invocation, add indexes around it, or insert ledger rows separately.
Expect temporarily unavailable requests; D1's 30-second API limit covers the
whole batch, and large work can cause database resets. These limits make failure
plausible, not a reason to conceal or automatically retry it.

### Reconcile the outcome before proceeding

Use separate maintained read-only calls after the process settles:

```sh
node scripts/rehearse-release-migrations.mjs observe-prefix --environment production > "$OP_DIR/prefix-after.json"
./node_modules/.bin/wrangler d1 execute USAGE_MONITOR_DB --env production --remote --command "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name; SELECT control_state,reason_code,revision,enrollment_enabled,upload_registration_enabled,processing_enabled,publication_enabled FROM collection_controls WHERE singleton=1;" --json > "$OP_DIR/schema-controls-after.json"
./node_modules/.bin/wrangler d1 info USAGE_MONITOR_DB --env production --json > "$OP_DIR/primary-info-after.json"
```

- **Known complete success:** primary ledger ends at 0059, deletion ledger remains
  exactly 0002, schema matches the rehearsed final schema, no 0058 save tables
  remain, controls stay at the owned paused revision, and service/storage checks
  pass. Only then consider control restoration under the same approved scope. No
  accountless deployment or client canary is implied.
- **Known server-side migration failure:** reconcile to the last successful
  whole migration: 0056 if 0057 failed, 0057 if 0058 failed, or 0058 if 0059 failed.
  Require the corresponding exact schema and no partial 0058 save tables. Retain
  the error and halted prefix; do not call this whole-operation rollback. Check
  compatibility of the still-running code before deciding whether collection
  can resume. Full row hashes/integrity checks are not claimed by schema-only
  readback; additional validation must remain bounded and separately identified.
- **Unknown transport outcome or unavailable database:** keep collection paused,
  retain every receipt, and use only bounded read-only reconciliation. A client
  timeout/reset, nonzero CLI exit, or stale ledger read alone is not termination
  or rollback proof. If final prefix/schema cannot be established, stop and seek
  provider reconciliation. There is no normal-query import bookmark to poll.
- **Unexpected prefix/schema/control drift:** stop. Do not repair ledgers, drop
  temporary tables, rerun migrations or restore a bookmark to manufacture the
  expected result.

A destructive Time Travel restore needs a separate concrete approval and must
preserve/replay the newest independent deletion ledger. Never restore that
ledger or recover R2 objects implicitly. See [Time Travel recovery](https://developers.cloudflare.com/d1/reference/time-travel/).

Conditional collection restoration is a separate operator decision after the
known-outcome checks above, included in the same eventual approval for this
operation. It does not require a second user approval when its conditions hold. Prepare this
exact `restore-controls.sql`:

```sql
UPDATE collection_controls
SET enrollment_enabled=1, upload_registration_enabled=1,
    processing_enabled=1, publication_enabled=1,
    control_state='operational', reason_code='initial', revision=3,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1 AND revision=2 AND control_state='contained'
  AND reason_code='maintenance' AND enrollment_enabled=0
  AND upload_registration_enabled=0 AND processing_enabled=0
  AND publication_enabled=0;
SELECT changes() AS changed, control_state,reason_code,revision,
       enrollment_enabled,upload_registration_enabled,processing_enabled,publication_enabled
FROM collection_controls WHERE singleton=1;
```

```sh
./node_modules/.bin/wrangler d1 execute USAGE_MONITOR_DB --env production --remote --command "$(cat "$OP_DIR/restore-controls.sql")" --json > "$OP_DIR/restore-controls-result.json" 2> "$OP_DIR/restore-controls-stderr-private.txt"
```

Require `changed=1` plus exact revision 3/all-enabled/operational readback.
If revision or state changed, do not overwrite it. No automatic restoration on
error, timeout or successful CLI exit is authorized by this runbook.

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
`recoveryDirectory` in the closed error receipt. A bounded `last-command-private.json`
retains the exact failed call's phase, status/signal/error code and captured output;
it never captures the process environment. Keep that receipt private.
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
