# GCP infrastructure desired state

These files are the committed desired state of the Google Cloud estate that
OPS-2 (`scripts/gcp-infra.mjs`) renders, reads back, plans and applies, and
that OPS-10 (`scripts/gcp-production-rollout.mjs`) reads its rollout target
from. They are the only desired states an apply, an applying bucket birth or
a rollout reads.

| File | Plane |
|---|---|
| `staging.desired-state.json` | Staging, in the shared GCP test project `tibotattle` (`projectTenancy: "shared"`), with new, staging-marked resources only. It is the synthetic plane for the staging migrate-and-roll proof, the staging edge's origin (OWN-7b) and migrate and roll drills. Production data and production secrets never enter it. |
| `production.desired-state.json` | Production, in the dedicated project `tibotattle-prod` (number 874229235044, `us-east1`), filled by PROD-PREP under owner decisions round 13. The apply steps, their approvals and the round 15 answers that shape them are in `docs/runbooks/gcp-production-apply.md`. |
| `desired-state.schema.json` | JSON Schema for editors and review, including which secrets staging must name. `scripts/gcp-ops-infra-manifest.mjs` `validateDesiredState` is authoritative. |
| `monitoring.md` | The runbook that the OPS-5 alert policies link to, one anchor per policy. The policies are derived from these desired states by `scripts/gcp-ops-monitoring-policies.mjs`. |

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
- The secrets round 12 retired with Google and Apple sign-in
  (`RETIRED_PRODUCTION_SECRET_NAMES`: `GOOGLE_OIDC_CLIENT_SECRET`,
  `APPLE_PRIVATE_KEY`) are no CR-3 secret since ROUTES-R12: neither plane's
  file may name them (`SECRET_UNKNOWN:<name>`), no service template
  references them, and CR-3 refuses them in a deployment's environment
  (`<NAME>_RETIRED`). The staging plane's earlier inert containers stay in
  the test project, unreferenced, until the owner removes them.
- Production may also leave out an optional CR-3 secret that nothing on the
  production estate reads (`UNREAD_PRODUCTION_SECRET_NAMES`:
  `DISTRIBUTION_GITHUB_API_TOKEN`), and the committed file does. The
  origin's admin distribution view reads the stored GitHub snapshot and makes
  no network request, the service's Worker env never carries the token, and
  no production job syncs GitHub (D-OPS4 is not built). The service renders
  without the entry. A future reader adds the container back with a
  desired-state change.
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
- **Staging waits for its environment.** The staging profile
  (`staging-maintenance-job`) also reads the staging plane's own origins and
  identity values. STG-PREP's `stagingOrigin` block and staging service
  template now carry them for the service, but the job render does not read
  them from there yet. Until it does, the staging job and trigger are never
  created
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

Each of these is `null` until the owner supplies it, except where the next
sections say Claude filled a production or staging value. While a value is `null`, the
estate does not read clean, or the resource that depends on it is not
created.

| Setting | Effect while `null` |
|---|---|
| `serviceAccounts.verifier.tokenCreators` | The operator's `roles/iam.serviceAccountTokenCreator` grant on the verifier (OD-CR-7) is deferred, and OPS-10 refuses the rollout target |
| `secrets.*.version` | The service is not rendered (`SECRET_VERSION_UNPINNED`) |
| `bucket.proof` | Apply refuses until the bucket-birth receipt's proof is committed; the staging service is not rendered (`SERVICE_RENDER_BUCKET_PROOF_UNPINNED`) |
| `service.telemetryStorageNamespace` | The service is not rendered; it must equal the namespace the imported data carries. Staging's value was chosen by Claude (see below) |
| `scheduler.analytics-refresh.schedule` | The trigger is not created (decision D3: no default cadence), and the scheduler account's executor grant on the job waits with it. Production stays `null` until the owner decides the cadence after the production-scale measurement (round 15, C3); pass 1 then defers the create as `SCHEDULER_CADENCE_UNSET` and plans no pause. `readback --require-clean` accepts that for the rollout; `--require-cadence` (the cutover gate) refuses it |
| `stagingOrigin.accessAud` (staging only) | The staging service is not rendered (`STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud`) until the owner creates the staging admin Access application |

### Production values PROD-PREP filled (owner decisions round 13)

| Setting | Committed value | Source |
|---|---|---|
| `project`, `projectNumber`, `region`, `bucket.location` | `tibotattle-prod`, `874229235044`, `us-east1`, `US-EAST1` | OWN-5 and round 13; the project number was read back by the main session |
| `serviceAccounts.verifier.tokenCreators` | the owner's Google account | Claude's proposal, mirroring staging, approved by the owner as a production grant in round 15 (C2; round 9 had approved it on the staging verifier only) |
| `secrets` | the four CR-3 secrets the production estate reads, named by their variable names | Round 12 retired Google and Apple sign-in, so their two secrets are left out, and nothing on the production estate reads `DISTRIBUTION_GITHUB_API_TOKEN`. `IDENTITY_LINK_SECRET` stays: the edge-admission replay keys its subjects with it, and the session ports, credential renew and the maintenance profile check the imported identity-link pin. `scripts/gcp-identity-link-pin-check.mjs` checks the version against that pin before PROD-3 |

`scheduler.analytics-refresh.schedule` stays `null` (round 15, C3): the owner
decides the refresh cadence after the production-scale measurement, so pass 1
defers the trigger create (`SCHEDULER_CADENCE_UNSET`) and plans no pause. When
the cadence is committed, a later plan creates the trigger and pauses it at
once. A full-recompute run is about 50 min against a 14,400 s timeout, and the
advisory lock refuses an overlapping run.

`service.telemetryStorageNamespace` stays `null`. Continuity requires the
production Worker's own `TELEMETRY_STORAGE_NAMESPACE` (legacy and v1.1
admission refuse a namespace that differs from the imported pinned state),
and that value is a live plain var no tracked file records. The main session
reads it back from the live Worker and pins it (the runbook's namespace step).
The secret versions and the bucket proof are pinned after the apply, as for
staging.

### Staging values Claude filled, confirmed by the owner

Stream STG-PREP (Claude, not the owner) committed these staging values so
that the staging service can render once the owner values above arrive. The
owner confirmed all six as committed on 2026-10-02 (owner decisions, round 9,
"Staging values"). Until D-CRB lands, OPS-2 defers the staging service in any
case.

| Setting | Committed value | Source |
|---|---|---|
| `service.telemetryStorageNamespace` | `tibotattle-staging-synthetic` | Claude's choice. Staging imports no data, so the rule that it equals the imported data's namespace holds trivially |
| `stagingOrigin.publicOrigin` | `https://staging.tibotattle.com` | Staging edge plan proposal D-S1 |
| `stagingOrigin.accessTeamDomain` | `tibotattle.cloudflareaccess.com` | Production's Access team (CR-3's production values); the staging edge plan (D-S3) proposes reusing it |
| `stagingOrigin.accessAdminEmail` | the owner's admin email | Production's Access admin email (CR-3's production values) |
| `stagingOrigin.identityLinkSecretVersion` | `staging-gcp-v1` | Claude's label for the staging identity-link secret; CR-3 refuses a production label |
| `stagingOrigin.admissionMode` | `closed` | CR-3's fail-closed staging mode; the other mode, `synthetic-rehearsal`, opens accountless admission |

## The staging service

Staging renders from its own template,
`../staging-service.template.yaml` (STG-PREP): EP-7's service with
`HOST_MODE=staging` (OD-CR-8), scale to zero and at most
`service.maxInstances`, the OD-2 quarantine bucket proof
(`GCS_QUARANTINE_BUCKET_HISTORY_PROOF`, from the pinned `bucket.proof`) and
inert synthetic Google and Apple identifiers. Its own non-secret settings
are the `stagingOrigin` block, which production must hold as `null`: the
staging edge's public origin (its admin origin is derived), the Access team
domain, AUD and admin email, the staging identity-link label and the
staging admission mode (`closed` or `synthetic-rehearsal`, as CR-3 defines
them).

D-CRB composes `HOST_MODE=staging` in `cloud-run/server.mjs`, so OPS-2 no
longer holds the service for its composition: the `STAGING_HOST_COMPOSITION_PENDING`
gate was removed, with its check, when D-CRB and STG-PREP met on the
fast-path final line. The staging service still waits for the owner's Access
AUD (`STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud`). The staging
maintenance job (D-OPS4) stays deferred
(`STAGING_MAINTENANCE_JOB_ENVIRONMENT_UNAVAILABLE`): its render does not
yet read the staging plane's own origins and identity values.

The staging secrets, bucket birth and apply follow
`docs/runbooks/gcp-staging-apply.md`, with
`scripts/gcp-staging-secrets.mjs` (synthetic values, piped to Secret Manager
on stdin) and `scripts/gcp-staging-bucket-birth.mjs` (birth, the committed
receipt `staging.bucket-birth.receipt.json` and its pinned proof).

## Scheduler trigger

Apply creates the analytics-refresh trigger and pauses it in the same apply,
and only then grants the scheduler account `roles/run.jobsExecutor` on the
job. Apply never resumes a trigger; OPS-3 does, and the owner then sets the
committed `state` to `ENABLED`.

That order keeps a trigger whose pause failed from starting the job only if
the account holds no grant when the create runs. So while the committed
`schedule` is `null`, apply withholds the grant too (deferred as
`SCHEDULER_CADENCE_UNSET`, with the trigger), and the plan that follows a
committed cadence creates the trigger, pauses it, and then grants. A grant
that is already live when a create is planned (a trigger removed by hand, or
an estate bound before its trigger existed) blocks the plan as
`SCHEDULER_CREATE_EXECUTOR_BOUND:<job>`; apply never removes a grant, so the
owner removes it first, with exact targets, and re-plans.

An unset cadence is a clean deferral for `readback --require-clean`, which is
the rollout's preflight: the production-scale measurement that decides the
cadence needs the rolled image. The cutover's scheduler gate is
`readback --require-clean --require-cadence`, which refuses it.

OPS-3 is `gcp-infra.mjs pause-all` and `resume-all`. Both are dry runs
unless run with `--apply --authorize=<planDigest>` from the committed desired
state.

- **pause-all** pauses every trigger in the plane: in a dedicated project,
  every trigger in the region; in a shared project, the plane's own triggers
  and any trigger that runs one of the plane's jobs. That satisfies OPS-10's
  `ROLLOUT_JOBS_NOT_PAUSED` gate, and both use the same classifier,
  `scripts/gcp-scheduler-run-target.mjs`. The plan names any co-tenant
  trigger that keeps that gate shut; pause-all never touches it. The receipt
  (`--receipt-out`, written even when a pause fails) records which triggers
  this run paused and which were already paused. It also records each plane
  trigger's `userUpdateTime` and `lastAttemptTime`, read back after the
  pauses.
- **resume-all** resumes a managed trigger only when its committed `state`
  is `ENABLED`, it is live `PAUSED`, and one of these holds:
  - the operator names it with `--only`;
  - the pause-all receipt (`--pause-receipt`) records it as paused by that
    run, the receipt is at most 24 hours old, and the trigger's live
    `userUpdateTime` and `lastAttemptTime` still equal the recorded ones.

  An older receipt is refused (`PAUSE_ALL_RECEIPT_STALE`). A trigger resumed
  and paused again, updated, or run since pause-all is skipped
  (`CHANGED_AFTER_PAUSE_ALL`), so a trigger someone paused on purpose stays
  paused. A trigger with no read-back in the receipt is skipped
  (`PAUSE_ALL_READBACK_MISSING`). In either case the operator may still
  name it with `--only`.

`node scripts/gcp-infra.mjs scheduler-probe --environment=<env>` is the
paused-too-long signal. It exits 2 when a trigger whose committed state is
`ENABLED` has been `PAUSED` for 6 hours or more, with no user change or
attempt in that time. OPS-5 renders the matching alert (`scheduler-quiet` in
`monitoring.md`): no Cloud Scheduler attempt within max(6 h, cadence plus
slack). That is about 25 hours for a daily trigger, so it is a proxy, not
the 6-hour signal. The owner accepted the 6-hour value in round 9 and, in
round 11, the proxy's delay for a daily trigger, with no scheduled probe
job (see `monitoring.md`). The alert is
not applied yet and waits for the cadence and the owner's notification
channel (OWN-5c). The probe also assumes that pausing a trigger updates its
`userUpdateTime`. The first owner-run readback against the test project has
to confirm that after a pause. resume-all does not rely on that assumption
alone: it also compares `lastAttemptTime`, and the receipt's age is bounded.
