# GCP infrastructure desired state

These files are the committed desired state of the Google Cloud estate that
OPS-2 (`scripts/gcp-infra.mjs`) renders, reads back, plans and applies, and
that OPS-10 (`scripts/gcp-production-rollout.mjs`) reads its rollout target
from. They are the only desired states an apply, an applying bucket birth or
a rollout reads.

| File | Plane |
|---|---|
| `staging.desired-state.json` | Staging, in the shared GCP test project `tibotattle` (`projectTenancy: "shared"`), with new, staging-marked resources only. It is the synthetic plane for the staging load test (OPS-11), the staging edge's origin (OWN-7b) and migrate and roll drills. Production data and production secrets never enter it. |
| `production.desired-state.json` | Production, in a dedicated project. Its project, project number, region and bucket location are `null` placeholders until the owner assigns them (OWN-5). |
| `desired-state.schema.json` | JSON Schema for editors and review. `scripts/gcp-ops-infra-manifest.mjs` `validateDesiredState` is authoritative. |

The dress rehearsal (REH-1) runs on production data inside the production
project, on a disposable database that is deleted afterwards (OWN-11).
Production data and secrets never enter the staging plane or its project.
Neither file describes the disposable database. While a disposable Cloud SQL
instance exists in the production project, production readback reports
`CLOUD_SQL_SECOND_INSTANCE` and plans its delete, which apply refuses, so the
production estate reads unclean until that instance is deleted.

## Rules

- Non-secret identifiers only. A secret is named by its Secret Manager secret
  id and a pinned version number; the validator refuses any secret-valued key
  and any string that looks like a key, a token or a JWK.
- Each secret id has its plane's form (`SECRET_ID_FORM_INVALID` otherwise),
  so a pasted value is never taken for an id. In production it is the
  variable name EP-7's template uses, or a `tibotattle-` id of lowercase
  words. In staging it is a `tibotattle-staging-` id of lowercase words.
- An owner placeholder (`null` at `project`, `projectNumber`, `region` or
  `bucket.location`) is refused with `DESIRED_STATE_PLACEHOLDER_UNFILLED`.
- Production never shares its project and never names a test-estate or
  staging resource. Staging names every plane resource with the `staging`
  token and never reuses a test-estate name.
- In a shared project, OPS-2 never plans co-tenant resources and never reads
  or changes the project-wide logging and Data Access audit settings.

## Maintenance job and its trigger (D-OPS4)

The desired state names three Cloud Run Jobs, and two have a Cloud Scheduler
trigger:

| Job | Trigger |
|---|---|
| `production-migrate` (OPS-10, manual) | none |
| `analytics-refresh` | `scheduler.analytics-refresh`: the owner's cadence (decision D3), `null` until decided |
| `maintenance` | `scheduler.maintenance`: **every minute, `* * * * *`**, pinned |

The maintenance job runs C-MAINT's MP-2-lite lifecycle pass
(`dist/postgres-maintenance-job.mjs --profile=maintenance-job`, built by the
same image) as the runtime account, with one primary pool of 2
(`jobs.maintenance.maxConnections`, at least the job's own
`POSTGRES_MAINTENANCE_JOB_POOL_MAX`). Each execution reconciles at most 100
due quarantine registrations, the d43c8f92 Worker's batch, so the trigger must
run every minute: a slower trigger, or a sustained due rate above 100 a minute,
leaves `/api/ready` not_ready and lets `pending_objects` grow. The validator
therefore pins the cadence to the job's contract constant
(`cloud-run/postgres-maintenance-job-contract.mjs`) and refuses any other
schedule, and `null`, as `SCHEDULER_CADENCE_MISMATCH:maintenance`.

- **Same trigger rules as the refresh trigger.** Apply creates the trigger and
  pauses it in the same apply, grants the scheduler account
  `roles/run.jobsExecutor` on the job only after that pause, and never resumes
  it. The committed `state` stays `PAUSED` until the owner resumes the trigger
  (OPS-3) and commits `ENABLED`. While paused, origin readiness goes stale 2
  hours after the last completed pass (`docs/runbooks/gcp-scheduler-resume.md`).
- **Job contract.** `MAINTENANCE_JOB_CONTRACT` in the manifest lists the
  closed env the render carries, built from the job's own contract leaf:
  the plane variables, `TELEMETRY_STORAGE_NAMESPACE`, the quarantine bucket's
  birth proof as `GCS_QUARANTINE_BUCKET_HISTORY_PROOF` (the closed record the
  service renders), `POSTGRES_SCHEDULED_MAINTENANCE_ENABLED=enabled` and
  `DEPLOYMENT_SOURCE_COMMIT`. It also lists the profile's secrets by Secret
  Manager reference at a pinned version: `IDENTITY_LINK_SECRET`, and
  `DISTRIBUTION_GITHUB_API_TOKEN` when a version is pinned. A render never
  carries `HOST_MODE`, `K_SERVICE`, a `PG_TEST_` variable or a
  `POSTGRES_MAINTENANCE_JOB_` tunable, which the job refuses, and Cloud Run
  supplies `CLOUD_RUN_JOB`. The manifest check feeds the render to CR-3's
  `maintenance-job` profile reader.
- **Waits for its inputs.** Like the service, the job is deferred, and its
  trigger is not created, until `service.telemetryStorageNamespace` is
  assigned, `bucket.proof` is pinned, and the required secret has a pinned,
  enabled version (`TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED`,
  `BUCKET_PROOF_UNPINNED`, `SECRET_VERSION_UNPINNED:<name>`,
  `SECRET_VERSION_UNAVAILABLE:<name>`). None of these is a clean deferral.
- **Staging waits for its template.** The staging profile
  (`staging-maintenance-job`) also reads the staging plane's own origins and
  identity values, which the desired state does not carry; they arrive with
  the staging service template (STG-PREP, D-CRB). Until then the staging job
  and trigger are never created
  (`STAGING_MAINTENANCE_JOB_ENVIRONMENT_UNAVAILABLE`, `JOB_ENVIRONMENT_UNAVAILABLE`)
  and the staging rollout target does not move the job.
- **The rollout moves it.** The production target lists the maintenance job,
  so OPS-10's roll updates its image and `DEPLOYMENT_SOURCE_COMMIT` with the
  other jobs, and its quiescence readback lists its executions.

The OPS-4 probe jobs (`cloud-run/ops-runtime-probe-job.mjs` and
`cloud-run/ops-backup-audit-job.mjs`, with their line contract
`cloud-run/ops-probe-contract.mjs`) are not in the desired state: the backup
audit needs a Google Cloud account of its own (`opsBackupAudit`, with exactly
`cloudsql.instances.get` and `cloudsql.backupRuns.list`), and the session
signals need a role decision, both for the owner. `OPS_PROBE_JOBS` is the job
contract a registration would render.

## Values that wait for the owner

Each of these is `null` until the owner supplies it. Each keeps the estate
from reading clean, or keeps the dependent resource from being created, until
then.

| Setting | Effect while `null` |
|---|---|
| `serviceAccounts.verifier.tokenCreators` | The operator's `roles/iam.serviceAccountTokenCreator` grant on the verifier (OD-CR-7) is deferred, and OPS-10 refuses the rollout target |
| `secrets.*.version` | The service is not rendered (`SECRET_VERSION_UNPINNED`) |
| `bucket.proof` | Apply refuses until the bucket-birth receipt's proof is committed |
| `service.telemetryStorageNamespace` | The service is not rendered; it must equal the namespace the imported data carries |
| `scheduler.analytics-refresh.schedule` | The trigger is not created (decision D3: no default cadence) |

The staging service also waits for a staging service template
(`STAGING_SERVICE_TEMPLATE_UNAVAILABLE`): EP-7's template is the production
profile.

## Scheduler trigger

Apply creates the analytics-refresh trigger and pauses it in the same apply,
and only then grants the scheduler account `roles/run.jobsExecutor` on the
job. Apply never resumes a trigger; OPS-3 does, and the owner then sets the
committed `state` to `ENABLED`. `node scripts/gcp-infra.mjs scheduler-probe
--environment=<env>` is the paused-too-long signal: it exits 2 when a trigger
whose committed state is `ENABLED` has been `PAUSED`, with no user change or
attempt, for 6 hours or more. It is a signal, not yet an alert: nothing runs
it on a schedule and it notifies no one until a periodic runner and a
notification target exist. It also assumes that pausing a trigger updates
its `userUpdateTime`; the first owner-run readback against the test project
has to confirm that after a pause.
