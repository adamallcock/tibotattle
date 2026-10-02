# GCP infrastructure desired state

These files are the committed desired state of the Google Cloud estate that
OPS-2 (`scripts/gcp-infra.mjs`) renders, reads back, plans and applies, and
that OPS-10 (`scripts/gcp-production-rollout.mjs`) reads its rollout target
from. They are the only desired states an apply, an applying bucket birth or
a rollout reads.

| File | Plane |
|---|---|
| `staging.desired-state.json` | Staging, in the shared GCP test project `tibotattle` (`projectTenancy: "shared"`). It hosts the dress rehearsal (REH-1) with new, staging-marked resources only. |
| `production.desired-state.json` | Production, in a dedicated project. Its project, project number, region and bucket location are `null` placeholders until the owner assigns them (OWN-5). |
| `desired-state.schema.json` | JSON Schema for editors and review. `scripts/gcp-ops-infra-manifest.mjs` `validateDesiredState` is authoritative. |

## Rules

- Non-secret identifiers only. A secret is named by its Secret Manager secret
  id and a pinned version number; the validator refuses any secret-valued key
  and any string that looks like a key, a token or a JWK.
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
committed `state` to `ENABLED`. `node scripts/gcp-infra.mjs scheduler-probe
--environment=<env>` is the paused-too-long signal: it exits 2 when a trigger
whose committed state is `ENABLED` has been `PAUSED`, with no user change or
attempt, for 6 hours or more.
