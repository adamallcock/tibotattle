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
- Production never shares its project and never names a test-estate or
  staging resource. Staging names every plane resource with the `staging`
  token and never reuses a test-estate name.
- In a shared project, OPS-2 never plans co-tenant resources and never reads
  or changes the project-wide logging and Data Access audit settings.

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
committed `state` to `ENABLED`.

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
  this run paused and which were already paused.
- **resume-all** resumes a managed trigger only when its committed `state`
  is `ENABLED`, it is live `PAUSED`, and either the pause-all receipt
  (`--pause-receipt`) records it as paused by that run or the operator names
  it with `--only`. A trigger someone paused on purpose stays paused.

`node scripts/gcp-infra.mjs scheduler-probe --environment=<env>` is the
paused-too-long signal. It exits 2 when a trigger whose committed state is
`ENABLED` has been `PAUSED` for 6 hours or more, with no user change or
attempt in that time. OPS-5 renders the matching alert (`scheduler-quiet` in
`monitoring.md`): no Cloud Scheduler attempt within max(6 h, cadence plus
slack). The alert is not applied yet and waits for the cadence and the
owner's notification channel (OWN-5c). The probe also assumes that pausing a
trigger updates its `userUpdateTime`. The first owner-run readback against
the test project has to confirm that after a pause.
