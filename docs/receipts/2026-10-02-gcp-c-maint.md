---
title: GCP C-MAINT MP-2-lite lifecycle pass and maintenance job
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP C-MAINT MP-2-lite lifecycle pass and maintenance job

This is a 2026-10-02 receipt for stream C-MAINT on branch
`claude/gcp-fp-c-maint`, built on `afd865a0` (`claude/gcp-fastpath-final`)
in two commits: `27967f28` (code, checks and registrations) and the commit
that adds this receipt. It records **local, synthetic** evidence only: one
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
| `apps/worker/cloud-run/postgres-maintenance-job.check.mjs` (new) | 13 local checks: argument, environment and proof contract, cycle, composition with injected dependencies, option refusals, vocabularies, and the dist bundle run as a child process. |
| `apps/worker/postgres-test/postgres-lifecycle-pass.spec.mjs` (new) | 7 PostgreSQL 17 specs. |
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
   50 registrations goes through the existing two-pass
   `reconcilePostgresPendingObjects`. The row is then `completed` with
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
- **Receipt.** Every mutation transaction first requires PostgreSQL 17 and a
  migration history exactly equal to the caller's manifest (the job passes
  `POSTGRES_RUNTIME_MIGRATIONS.primary`), so an older image never mutates
  newer state.
- **Idempotent per cycle.** A cycle already complete in both rows commits
  nothing; the spec proves both rows keep their `xmin`. A cycle older than
  either stored marker refuses `LIFECYCLE_CYCLE_REGRESSED`.
- **Refusals before the lease change nothing.** `LIFECYCLE_STATE_MISSING`,
  `LIFECYCLE_STATE_SHAPE_INVALID`, `LIFECYCLE_RESTORE_PIN_CONFLICT`,
  `LIFECYCLE_LEASE_CONFLICT` (a 0049 lease pair nothing on PostgreSQL
  writes), `POSTGRES_SCHEMA_RECEIPT_MISMATCH`, `POSTGRES_VERSION_UNSUPPORTED`,
  and `LIFECYCLE_STATE_CHECK_CONFLICT` for any SQLSTATE 23514. A CHECK
  violation after the lease is taken records the reconciliation failure, and
  a retry of the same cycle finishes it.
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
  Exit 0 for complete, partial (a backlog that later executions drain) and
  skipped. Exit 1 for refused, failure or a configuration refusal, which
  writes one `{schemaVersion, entry, status: "failed", code}` line on stderr.
  Exit 2 for usage.
- **Schedule.** The Worker runs every minute. `/api/ready` reads stale
  2 hours after the last completed pass, so the trigger interval must stay
  well inside that. The interval is D-OPS4's and OPS-2's to set; this stream
  chose none. The trigger follows the answered scheduler policy: resumed
  explicitly, and alerted when paused too long.

## Gates

Each was run in `fp/C-MAINT` at the code commit (the receipt commit adds
only this file), or on the working tree that became it.

| Command | Result |
|---|---|
| `apps/worker`: `./node_modules/.bin/tsc --noEmit -p .` | pass (the new module is in the program) |
| `apps/worker`: `node --test cloud-run/postgres-maintenance-job.check.mjs` (Node 26.2.0 and 22.16.0) | 13/13 each |
| `apps/worker`: `PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket PG_TEST_PORT=55433 node --test --test-concurrency=1 postgres-test/postgres-lifecycle-pass.spec.mjs` (Node 22.16.0) | 7/7 |
| The same spec over loopback TCP (`PG_TEST_HOST=127.0.0.1 PG_TEST_PORT=55433`) | 7/7 |
| The same spec with W3-CRA's `src/postgres-readiness.ts` and `-contract.ts` (`3024a521`) copied in temporarily and then removed (never committed) | 6/6 (before the seventh test was added): every readiness body equals `buildPostgresReadinessBody(…, {semantics: "worker-exact"})` |
| The new spec with `postgres-lifecycle-state.spec.mjs` and `postgres-maintenance.spec.mjs` (socket, Node 22.16.0) | 15/15 |
| `apps/worker/cloud-run`: `npm run check` (with the socket env) | exit 0. Includes `build.mjs --check`, the build, `cloud-run-build-context.mjs --check`, `host.check.mjs` and the job check. |
| `node --test` on `postgres-production-migrations.check.mjs`, `postgres-production-configuration.check.mjs`, `d1-analytics-export-oracle.check.mjs`, both ledger checks, and `scripts/{cloud-run-build-archive,cloud-run-production-configuration,cloud-run-source-build-submit,gcp-ops-infra-manifest,gcp-private-test-deploy,gcp-production-rollout}.check.mjs` | all pass (17, 25, 10, 17, 7, 2, 11, 3, 25, 21, 19) |
| `node --test scripts/ci-postgres-suite.check.mjs`; `node scripts/ci-postgres-suite.mjs --plan` | 43/43; the spec is planned in the SOCKET profile |
| `node dist/postgres-maintenance-job.mjs --help`, and the same entry with only `PATH` set (Node 22.16.0) | exit 0 with usage; exit 1 `POSTGRES_MAINTENANCE_JOB_CONTEXT_INVALID` |
| Root `npm run architecture:check` | pass (928 production files, 0 debt edges) |
| Root `npm run test:preflight` | pass, before each commit |

Afterwards no `c_maint%` schema remained on the fan-out cluster. The spec
creates only `c_maint_lp_*` schemas and drops each one. It never touched
`tibotattle_dense_parity` or `tibotattle_q1_parity`.

### What the PostgreSQL specs prove

1. An empty, freshly migrated origin reads 503 not_ready (`never_run` and
   `never_run`, cycles unmatched). After one pass it reads 200 ready with the
   exact Worker body. A repeated pass for the same cycle returns
   `LIFECYCLE_CYCLE_ALREADY_COMPLETE`, and both rows keep their `xmin`. The
   next cycle moves both markers. Two hours on, the body reads `stale`.
2. 53 due registrations: the first pass starts grace on 50 and reads
   not_ready (lifecycle ready, cycles matched, reconciliation incomplete). A
   retry of the same cycle finishes the last 3 with cumulative counters and
   reads ready. A full safety window later, two bounded passes delete all 53
   objects; the counters restart at 0 for the new run.
3. A `running` row left by a killed pass is taken over with its counters. A
   provider delete failure records `failed`, keeps the deleting claim and
   reads not_ready. A later pass deletes the object and reads ready.
4. Each pre-lease conflict refuses with its code and writes nothing (both
   rows keep `xmin`, no object call, the journal count is unchanged): the
   restore pins (false; 2 suppressed), a foreign lease pair, a regressed
   cycle, an `infinity` instant, a deleted history row, a shorter or drifted
   expected manifest, and a missing singleton. A held lock skips. Once every
   conflict is removed, the same cycle completes.
5. A synthetic `NOT VALID` CHECK violated by the lifecycle write refuses
   `LIFECYCLE_STATE_CHECK_CONFLICT` with no change. One violated only by the
   reconciliation completion records the failure. After the constraint is
   dropped, the retry completes the reconciliation without rewriting the
   lifecycle row.
6. With the 0064 retention pins applied, the pass completes and both pinned
   columns stay `true` and `0`; direct violations fail with 23514. The pins
   are applied verbatim from `claude/gcp-fp-w3-simp` `3a93c7d1` section (4),
   or from the promoted file once one named `*_append_only_residue.sql` is in
   `postgres/migrations/primary`.
7. The job entry, run with a synthetic production environment and injected
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
  of the d43c8f92 computation, cross-checked once against W3-CRA's pure
  builder. The live reader (receipt, typed pins, preflight) is untested
  here.
- The pass does not include the scheduled slice's handoff, sign-in-window
  and device-lifecycle purges (`runPostgresScheduledMaintenance`). Those
  stay with LEAD-SIMP's post-SIMP rewrite and `server.mjs --scheduled`.
- The 0064 file itself was not applied. Only its section (4) pins were,
  inline. The full residue migration is C-SIMP's.
- No full `npm run product:worker:check`, Worker Vitest, or root `npm test`
  ran. This change adds no Worker route and touches no root product code.

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
- `server.mjs --scheduled` still reconciles pending objects under the same
  lock without writing either singleton. If one maintenance job is wanted,
  D-CRB can call the post-SIMP `runPostgresScheduledMaintenance` from this
  entry after the pass, sequentially; each call takes and releases the lock.
