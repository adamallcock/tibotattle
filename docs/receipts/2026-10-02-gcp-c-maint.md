---
title: GCP C-MAINT MP-2-lite lifecycle pass and maintenance job
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP C-MAINT MP-2-lite lifecycle pass and maintenance job

This is a 2026-10-02 receipt for stream C-MAINT on branch
`claude/gcp-fp-c-maint`, built on `afd865a0` (`claude/gcp-fastpath-final`)
in three commits: `27967f28` (code, checks and registrations), `5f1d75b3`
(the first version of this receipt) and the review-fix commit that carries
this revision (see "Review findings" below). It records **local, synthetic**
evidence only: one
macOS arm64 workstation, Node 22.16.0 (the image runtime) for the PostgreSQL
spec, the dist bundle and a second run of the job check, Node 26.2.0 for
repository tooling, and the local PostgreSQL 17.10 fan-out cluster (port
55433) over its private Unix socket and over loopback TCP. Nothing was built
in Cloud Build, deployed, migrated or read in any GCP or Cloudflare project.
No `gcloud`, `wrangler` or push ran and no request left the machine. Every
schema, key, object, secret and identifier in the evidence is synthetic.

The owner decision implemented is OD-CR-4 (option a): `/api/ready` on the
origin matches the Worker exactly, through an MP-2-lite lifecycle pass and a
maintenance job, and an empty origin reads not_ready until the first pass.
OD-4 (constants, not applicable) and OD-2 (the renamed quarantine proof) are
applied as answered in `owner-decisions-2026-10-02-answers.md`. No other
decision was taken.

## What changed

| Item | Change |
|---|---|
| `apps/worker/src/postgres-lifecycle-pass.ts` (new) | `runPostgresLifecyclePass`: the lifecycle and quarantine-reconciliation pass. |
| `apps/worker/cloud-run/postgres-maintenance-job.mjs` (new) | The Cloud Run Job entry, build entry `postgres-maintenance-job` → `dist/postgres-maintenance-job.mjs`. |
| `apps/worker/cloud-run/postgres-maintenance-job.check.mjs` (new) | 15 local checks: argument, environment and proof contract, cycle, composition with injected dependencies, option refusals, the migration-fence skip, vocabularies, the Worker batch and cron pins, and the dist bundle run as a child process. |
| `apps/worker/postgres-test/postgres-lifecycle-pass.spec.mjs` (new) | 9 PostgreSQL 17 specs. |
| `apps/worker/cloud-run/build.mjs`, `Dockerfile` | The entry, its `--check`/build output lists, and `test -s dist/postgres-maintenance-job.mjs`. |
| `apps/worker/scripts/cloud-run-build-context.mjs` | Allowlists the job, its check and `cloud-run/postgres-production-configuration.mjs`, which the job imports and the image context did not yet carry. Its import-closure check requires all three. |
| `apps/worker/cloud-run/package.json` | `maintenance:lifecycle-pass` script; the `check` gate syntax-checks the job and runs its check. |
| `apps/worker/package.json` | Registers the spec in `postgres:domain:check` (the CI planner routes it to the SOCKET profile). |

No migration, no DDL, and no edit to `server.mjs`, the dispatch, the
readiness DTO builders (W3-CRA), `postgres-maintenance.ts`, the reconciler,
the lifecycle readers or the production configuration.

## What the pass writes

It writes exactly the two primary 0049 singletons the readiness response
reads, with the d43c8f92 Worker's values (`runBackendLifecycle`, then
`reconcilePendingQuarantineObjects`, in the scheduled handler's order):

1. **Lifecycle**, in one transaction. `QUARANTINE_RETENTION_MILLISECONDS` is
   null, as in every shipped Worker configuration, so retention deletes
   nothing and is complete with a null cutoff. `retention_state` becomes
   `completed` with `last_started_at = maintenance_run_at = cycle`,
   `last_completed_at = clock`, `quarantine_objects_deleted = 0` and
   `quarantine_retention_complete = true`. `restore_replay_complete` and
   `restored_participants_suppressed` are never written; the UPDATE
   re-asserts `true` and `0` under the row lock. A non-null constant would
   refuse `LIFECYCLE_QUARANTINE_RETENTION_UNPORTED` instead of claiming
   completion.
2. **Reconciliation.** `quarantine_reconciliation_state` is taken `running`
   with a `pglp1:` lease, `maintenance_run_at = cycle` and
   `cutoff_at = cycle − 24 h` (the reconciler's safety window). One page of
   100 registrations, the d43c8f92 Worker's `QUARANTINE_RECONCILIATION_BATCH_SIZE`
   per one-minute cron and the reconciler's own upper bound, goes through the
   existing two-pass `reconcilePostgresPendingObjects`. A backlog of up to 100
   due registrations therefore completes in one pass, as it does in one
   Worker cron. The row is then `completed` with
   `reconciliation_complete = !hasMore && candidatesDeferred === 0`. Counters
   accumulate while a backlog is resumed (the previous run is incomplete and
   has a cutoff, the Worker's cursor rule) and restart at 0 otherwise. A
   provider or database failure records `failed` and
   `QUARANTINE_RECONCILIATION_FAILED` against the lease, as the Worker's
   `recordReconciliationFailure` does.

Readiness is then Worker-exact: ready only when the lifecycle is completed,
fresh (2 h) and both flags are true, and the reconciliation completed,
complete and on the same cycle marker.

Safety properties:

- **Lock.** A session-level `pg_try_advisory_lock` on
  `tibotattle/postgres-scheduled-maintenance/v1`, the domain the existing
  scheduled slice uses, so the two never reconcile at once. A held lock
  returns `skipped` / `MAINTENANCE_IN_PROGRESS` with no write. Holding it is
  what makes taking over a `running` row left by a killed pass safe.
- **Migration fence.** On the same session, after the maintenance lock, the
  pass takes `pg_try_advisory_lock_shared` on `tibotattle:primary:<schema>`,
  the key the primary migration runner (`cloud-run/postgres-migrations.mjs`)
  holds exclusively for a whole run, and which
  `postgres-community-daily-activation.mjs` already takes as its migration
  fence. While a migration runs, the pass returns `skipped` /
  `MIGRATION_IN_PROGRESS` with no write. While a pass runs, the runner
  refuses `POSTGRES_MIGRATION_CONFLICT` before it applies anything (the
  production migration Job passes that code through), and can be rerun. So the reviewed runner never commits a migration in the
  middle of a pass, including during the reconciler's own per-object
  transactions and object-store calls.
- **Receipt.** Every transaction this module opens (the lifecycle write, the
  lease, the completion and the failure record) first requires PostgreSQL 17
  and a migration history exactly equal to the caller's manifest (the job
  passes `POSTGRES_RUNTIME_MIGRATIONS.primary`). The reconciler's
  per-object transactions do not re-check it; the fence covers them. A
  schema change made outside the runner (out of contract) is caught at the
  pass's next own transaction, after the page in flight has finished its
  object work; the row is then left `running`, not written, and the next
  pass takes it over.
- **Idempotent per cycle.** A cycle already complete in both rows commits
  nothing; the spec proves both rows keep their `xmin`. A cycle older than
  either stored marker refuses `LIFECYCLE_CYCLE_REGRESSED`.
- **Refusals.** Inside the lifecycle transaction, a refusal rolls back and
  changes neither row: `LIFECYCLE_STATE_MISSING`,
  `LIFECYCLE_STATE_SHAPE_INVALID`, `LIFECYCLE_RESTORE_PIN_CONFLICT`,
  `LIFECYCLE_LEASE_CONFLICT` (a 0049 lease pair nothing on PostgreSQL
  writes), `LIFECYCLE_CYCLE_REGRESSED`, `POSTGRES_SCHEMA_RECEIPT_MISMATCH`,
  `POSTGRES_VERSION_UNSUPPORTED`, and `LIFECYCLE_STATE_CHECK_CONFLICT` for a
  SQLSTATE 23514 on the lifecycle write. The reconciliation lease is taken
  in a separate, later transaction. A refusal there (for example a CHECK
  violated only by the lease write) leaves the lifecycle row on the new
  cycle, already committed, and the reconciliation row unchanged; the result
  is `refused` with `changed: true` and `lifecycleWritten: true`, and
  readiness reads not_ready on the unmatched cycle, which is what the Worker
  reads when its reconciliation cannot start after `runBackendLifecycle`
  committed. A retry of the same cycle takes the lease only. After the lease
  is taken, a failure (a CHECK on the completion, a provider or database
  error) is recorded as `failed`, and a retry of the same cycle finishes it.
- **OD-4.** Every result carries `appendOnlyNotApplicable:
  { restoreReplayComplete: true, deletionTombstoneRetentionComplete: true,
  ownerErasureJobsComplete: true }`, constant and never measured. There is no
  `identityPurge` and no ledger key.
- **Content-free.** Results hold counts, booleans, the cycle instant and
  closed codes. Option errors throw `POSTGRES_LIFECYCLE_PASS_OPTIONS_INVALID`
  before any connection.

## The job contract (for D-OPS4)

- **Entry:** `node dist/postgres-maintenance-job.mjs --profile=maintenance-job`
  (production plane) or `--profile=staging-maintenance-job`. There is no
  default profile. `--help` alone prints usage. Any other argument is a usage
  refusal (exit 2).
- **Environment.** Everything `readProductionConfiguration(env, profile)`
  validates and refuses for the maintenance profiles: `CLOUD_RUN_JOB`,
  `DEPLOYMENT_SOURCE_COMMIT`, `TELEMETRY_STORAGE_NAMESPACE`,
  `PRIMARY_INSTANCE_CONNECTION_NAME`, `PRIMARY_DATABASE`, `PRIMARY_SCHEMA`,
  `POSTGRES_IAM_USER`, `GCS_BUCKET_NAME`,
  `POSTGRES_SCHEDULED_MAINTENANCE_ENABLED=enabled`, and the profile secrets
  (`IDENTITY_LINK_SECRET` required, plus `DISTRIBUTION_GITHUB_API_TOKEN`
  optional in production). Staging also needs its plane's origins and
  identity vars. Beyond that:
  - `GCS_QUARANTINE_BUCKET_HISTORY_PROOF` (OD-2) is required: the
    bucket-birth receipt's `proof` JSON, or the receipt carrying it. Its
    bucket must equal `GCS_BUCKET_NAME`.
    **Superseded by C-SIMP-RECON (2026-10-02):** the job no longer parses
    the proof. It takes CR-3's `resources.bucketHistoryProof`, which accepts
    only the closed four-key proof record (no receipt wrapper) and reports
    `_MISSING` or `_INVALID` (a bucket mismatch is `_INVALID`; the job's
    `_BUCKET_MISMATCH` code is gone). See
    [the C-SIMP-RECON receipt](2026-10-02-gcp-c-simp-recon.md).
  - The job refuses `HOST_MODE` and `K_SERVICE`, even when empty, and any
    `PG_TEST_*` or `POSTGRES_MAINTENANCE_JOB_*` variable.
  - The job reads no other variable and reveals no secret.
- **Resources.** One Cloud SQL IAM pool on the primary instance, `max` 2,
  `application_name` `tibotattle-maintenance-job`. It runs as the runtime
  identity, with the same database grants as the service: it UPDATEs the two
  singletons and `pending_objects`. It needs GCS object get and delete on the
  quarantine bucket.
- **Cycle.** The start of the UTC minute when the execution started, the
  Worker cron's scheduledTime granularity. A task retry within that minute is
  a no-op.
- **Output and exit.** One JSON line on stdout,
  `{schemaVersion: "postgres-maintenance-job-v1", entry, profile, status, pass}`.
  Exit 0 for complete, partial (a backlog above 100 that later executions
  drain) and skipped (`MAINTENANCE_IN_PROGRESS` or `MIGRATION_IN_PROGRESS`).
  Exit 1 for refused, failure or a configuration refusal, which writes one
  `{schemaVersion, entry, status: "failed", code}` line on stderr. Exit 2
  for usage.
- **Schedule and throughput.** The trigger must run **every minute**,
  `POSTGRES_MAINTENANCE_JOB_SCHEDULE = "* * * * *"`, the cron of every
  d43c8f92 Worker environment (the job check pins both). Each execution
  reconciles up to **100** due registrations, the Worker's batch, so the
  capacity is the Worker's: 100 a minute, 144,000 a day. Every v1.0 and v1.1
  upload leaves a `registered` pending object that only this pass clears,
  one safety window (24 h) later, so the due rate is the upload rate a day
  earlier. A slower trigger, or a sustained due rate above 100 a minute,
  leaves `/api/ready` not_ready and lets `pending_objects` grow, on GCP as
  on the Worker. Separately, `/api/ready` reads stale 2 hours after the last
  completed pass. The trigger follows the answered scheduler policy: resumed
  explicitly, and alerted when paused too long.
- **Migrations.** The rollout's `migrate` verb already requires every
  Scheduler trigger paused and no execution of a manifest Job running. The
  migration fence above holds independently of that readback, which today
  lists only `production-migrate` and `analytics-refresh` in `JOB_NAMES`.
  A migration attempted while a pass runs refuses
  `POSTGRES_MIGRATION_CONFLICT` and can be rerun.

## Gates

Each was run in `fp/C-MAINT`.

| Command | Result |
|---|---|
| `apps/worker`: `./node_modules/.bin/tsc --noEmit -p .` | pass (the new module is in the program) |
Results for the review-fix revision (run on the working tree that became
the review-fix commit):

| Command | Result |
|---|---|
| `apps/worker`: `./node_modules/.bin/tsc --noEmit -p .` | exit 0 |
| `apps/worker`: `node --test cloud-run/postgres-maintenance-job.check.mjs` (Node 26.2.0 and 22.16.0) | 15/15 each |
| `apps/worker`: `PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket PG_TEST_PORT=55433 node --test --test-concurrency=1 postgres-test/postgres-lifecycle-pass.spec.mjs` (Node 22.16.0) | 9/9 (PostgreSQL 17.10) |
| The same spec over loopback TCP (`PG_TEST_HOST=127.0.0.1 PG_TEST_PORT=55433`) | 9/9 |
| The same spec with W3-CRA's `src/postgres-readiness.ts` and `-contract.ts` (`3024a521`) copied in temporarily and then removed (never committed) | 9/9: every readiness body, including the job end-to-end spec's, equals `buildPostgresReadinessBody(…, {semantics: "worker-exact"})` |
| Mutation checks, each reverted (the source was compared byte-for-byte with its saved copy afterwards): page size 50; no receipt check in the failure record; no migration fence | each fails the spec it targets: both backlog specs; the fence spec (`failed` written instead of `running`); the fence spec |
| The new spec with `postgres-lifecycle-state.spec.mjs` and `postgres-maintenance.spec.mjs` (socket, Node 22.16.0) | 17/17 |
| `apps/worker/cloud-run`: `npm run check` (with the socket env) | exit 0. Includes `build.mjs --check`, the build, `cloud-run-build-context.mjs --check`, `host.check.mjs`, `postgres-production-migrations.check.mjs`, `gcp-production-rollout.check.mjs` and the job check. |
| `apps/worker`: `node --test scripts/ci-postgres-suite.check.mjs`; `node scripts/ci-postgres-suite.mjs --plan` | 43/43; the spec is planned in the SOCKET profile |
| The built `dist/postgres-maintenance-job.mjs` (Node 22.16.0): `--help`; `--profile=maintenance-job` with only `PATH` set; `--bogus` | exit 0 with usage (states 100 registrations and `* * * * *`); exit 1 `POSTGRES_MAINTENANCE_JOB_CONTEXT_INVALID`; exit 2 `POSTGRES_MAINTENANCE_JOB_ARGUMENTS_INVALID` |
| Root `npm run architecture:check` | pass |
| Root `npm run test:preflight` | pass, before the commit |

Results recorded for `27967f28` (before the review): the job check 13/13
on both runtimes; the spec 7/7 over the socket and over TCP; 6/6 with the
W3-CRA builder (before the seventh spec existed); 15/15 with the two sibling
specs; `npm run check` exit 0; `node --test` on
`postgres-production-migrations.check.mjs`,
`postgres-production-configuration.check.mjs`,
`d1-analytics-export-oracle.check.mjs`, both ledger checks, and
`scripts/{cloud-run-build-archive,cloud-run-production-configuration,cloud-run-source-build-submit,gcp-ops-infra-manifest,gcp-private-test-deploy,gcp-production-rollout}.check.mjs`
all pass (17, 25, 10, 17, 7, 2, 11, 3, 25, 21, 19); architecture:check
pass (928 production files, 0 debt edges); test:preflight pass.

Afterwards no `c_maint%` schema remained on the fan-out cluster. The spec
creates only `c_maint_lp_*` schemas and drops each one. It never touched
`tibotattle_dense_parity` or `tibotattle_q1_parity`.

### What the PostgreSQL specs prove

1. An empty, freshly migrated origin reads 503 not_ready (`never_run` and
   `never_run`, cycles unmatched). After one pass it reads 200 ready with the
   exact Worker body. A repeated pass for the same cycle returns
   `LIFECYCLE_CYCLE_ALREADY_COMPLETE`, and both rows keep their `xmin`. The
   next cycle moves both markers. Two hours on, the body reads `stale`.
2. Worker parity within the batch: 53 due registrations complete in one pass
   and read ready, as one Worker cron would; then exactly 100 newly due
   registrations also complete in one pass. A safety window after each grace
   started, each set is deleted in one pass, and the journal is empty.
3. Above the batch: 103 due registrations. The first pass starts grace on
   100 and reads not_ready (lifecycle ready, cycles matched, reconciliation
   incomplete). A retry of the same cycle finishes the last 3 with
   cumulative counters and reads ready. Two safety windows later the first
   pass deletes 100 and reads not_ready; the next minute's pass deletes the
   last 3 and reads ready. The counters restart at 0 for each new run.
4. A `running` row left by a killed pass is taken over with its counters. A
   provider delete failure records `failed`, keeps the deleting claim and
   reads not_ready. A later pass deletes the object and reads ready.
5. Each conflict inside the lifecycle transaction refuses with its code and
   writes nothing (both rows keep `xmin`, no object call, the journal count
   is unchanged): the restore pins (false; 2 suppressed), a foreign lease
   pair, a regressed cycle, an `infinity` instant, a deleted history row, a
   shorter or drifted expected manifest, and a missing singleton. A held
   maintenance lock skips. Once every conflict is removed, the same cycle
   completes.
6. CHECK violations at each stage. One violated by the lifecycle write
   refuses `LIFECYCLE_STATE_CHECK_CONFLICT` with no change. One violated
   only by the lease write (`state <> 'running'`) refuses with
   `changed: true`: the lifecycle row holds the new cycle (new `xmin`), the
   reconciliation row keeps its `xmin`, no object call is made, and
   readiness reads 503 with `maintenanceCycleMatched: false`; the retry
   takes the lease only and reads ready. One violated only by the completion
   records `failed`; the retry completes the reconciliation without
   rewriting the lifecycle row.
7. The migration fence. While a session holds the runner's own lock on
   `tibotattle:primary:<schema>`, the pass returns `skipped` /
   `MIGRATION_IN_PROGRESS` and both rows keep `xmin`. The real
   `applyPostgresMigrations`, started from inside the reconciliation page,
   refuses `POSTGRES_MIGRATION_CONFLICT`; the pass completes, and the runner
   succeeds once the pass is done. A history row deleted from inside the
   page (an out-of-contract change that bypasses the runner) lets that
   page's object delete finish, then refuses
   `POSTGRES_SCHEMA_RECEIPT_MISMATCH` at completion; the failure record
   writes nothing, so the row stays `running` with the pass's lease and
   reads not_ready. With the history restored, the next pass takes the row
   over and reads ready.
8. With the 0064 retention pins applied, the pass completes and both pinned
   columns stay `true` and `0`; direct violations fail with 23514. The pins
   are applied verbatim from `claude/gcp-fp-w3-simp` `3a93c7d1` section (4),
   or from the promoted file once one named `*_append_only_residue.sql` is in
   `postgres/migrations/primary`.
9. The job entry, run with a synthetic production environment and injected
   local pool, store and connector, completes against the image manifest,
   turns the origin ready, closes the pool and connector, and emits no
   secret or token.

The pass clients run in session time zone `Pacific/Kiritimati`.

## Not covered

- No Cloud Run, Cloud SQL, GCS or Scheduler execution; no IAM grant for the
  job identity; no live `/api/ready` read. Those are D-OPS4/OPS-2 and
  owner-run gates.
- No real GCS store: the specs use a synthetic in-memory store. The GCS
  adapter's history-proof behaviour is its own module's evidence.
- The origin does not yet serve `/api/ready`. RD-2 and its dispatcher are
  D-CRB (W3-CRA phase B). The readiness judgement here is a verbatim port
  of the d43c8f92 computation, cross-checked against W3-CRA's pure builder
  in all 9 specs. The live reader (receipt, typed pins, preflight) is
  untested here.
- The migration fence covers the reviewed runner
  (`applyPostgresMigrations`, the only code in `apps/worker` that writes
  the migration history; every migration tool here calls it). A
  schema change made by any other means, such as a manual `psql` session,
  is not fenced; spec 7 shows it is caught at the pass's next own
  transaction, after the page in flight.
- The fence was proved against the local runner and PostgreSQL 17 only.
  Cloud SQL advisory-lock behaviour under the IAM connector, and the
  production migration Job meeting a running pass, were not run.
- The pass does not include the scheduled slice's handoff, sign-in-window
  and device-lifecycle purges (`runPostgresScheduledMaintenance`). Those
  stay with LEAD-SIMP's post-SIMP rewrite and `server.mjs --scheduled`.
- The 0064 file itself was not applied. Only its section (4) pins were,
  inline. The full residue migration is C-SIMP's.
- No full `npm run product:worker:check`, Worker Vitest, or root `npm test`
  ran. This change adds no Worker route and touches no root product code.

## Review findings (2026-10-02)

A review of `5f1d75b3` raised four findings. Each was checked against the
code before any change.

1. **Medium, confirmed and fixed: readiness was not Worker-exact with a
   backlog.** The pass reconciled 50 registrations a run, while the
   d43c8f92 Worker reconciles `QUARANTINE_RECONCILIATION_BATCH_SIZE = 100`
   (`src/quarantine-reconciliation.ts`) once per one-minute cron
   (`src/index.ts` scheduled handler; `wrangler.jsonc` crons `* * * * *`).
   With 51 to 100 due registrations the Worker read ready after one cron and
   the pass read not_ready. The page is now 100. The job check pins it to
   the Worker's constant and the reconciler's upper bound, and pins the job
   schedule to the Worker's crons. The job contract now requires an
   every-minute trigger and states the throughput. Specs 2 and 3 replace the
   old spec 2: up to 100 completes in one pass; above 100 reads not_ready,
   then drains.
2. **Low, confirmed and fixed (documentation and test): the "refusals before
   the lease change nothing" claim was false for a refusal raised while the
   lease is taken.** The lifecycle transaction commits before the lease
   transaction. The transactions were kept separate on purpose: merging them
   would roll the lifecycle row back as well, and readiness could then read
   ready on the previous cycle for up to two hours while every pass is
   refused. The current order matches the Worker, which commits
   `runBackendLifecycle` before reconciliation starts, so readiness reads
   not_ready on the unmatched cycle. The module header and this receipt now
   state the behaviour exactly, and spec 6 covers that window.
3. **Low, confirmed and fixed: "every mutation transaction first proves the
   receipt" was overstated.** The failure record had no receipt check, and
   the reconciler's per-object transactions and object calls ran between the
   pass's checked transactions with no fence against the migration runner.
   The failure record now proves the receipt. The pass now also holds the
   runner's own lock key in shared mode for its whole duration, so the
   reviewed runner cannot commit mid-pass. This closes the window rather
   than only narrowing the claim, and the runner itself is unchanged. The
   claim is restated above with its remaining limit, and spec 7 covers it.
4. **Info: the reviewer's re-run gates held.** No change was needed. The
   W3-CRA builder cross-check the reviewer closed was repeated here on all 9
   specs.

## Observations for integration

- `postgres-quarantine-reconciliation.ts` checks `registered_at` through the
  pg driver's text parsing. That parsing needs `DateStyle` ISO: under
  `SQL, DMY` every candidate is deferred. Cloud SQL defaults to ISO. This is
  pre-existing and unchanged here; the spec keeps the session ISO and
  documents why.
- The maintenance profiles require `IDENTITY_LINK_SECRET`, but this pass
  never reads it. Whether to drop that requirement belongs to the profile's
  owners (CR-3 and SIMP). This stream did not change it.
- When CR-3 admits `GCS_QUARANTINE_BUCKET_HISTORY_PROOF` into
  `readProductionConfiguration` (D-CRB, OD-2), the job should take the proof
  from the configuration instead of reading it itself.
- D-OPS4/OPS-2: add the maintenance Job to the infrastructure manifest's
  `JOB_NAMES`, so the rollout's quiescence readback also lists its
  executions, and create its trigger on `* * * * *`.
- `server.mjs --scheduled` still reconciles pending objects under the same
  lock without writing either singleton. If one maintenance job is wanted,
  D-CRB can call the post-SIMP `runPostgresScheduledMaintenance` from this
  entry after the pass, sequentially; each call takes and releases the lock.
