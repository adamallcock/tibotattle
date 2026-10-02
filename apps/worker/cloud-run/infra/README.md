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

## Values that wait for the owner

Each of these is `null` until the owner supplies it, except where the next
section says Claude filled a staging value. While a value is `null`, the
estate does not read clean, or the resource that depends on it is not
created.

| Setting | Effect while `null` |
|---|---|
| `serviceAccounts.verifier.tokenCreators` | The operator's `roles/iam.serviceAccountTokenCreator` grant on the verifier (OD-CR-7) is deferred, and OPS-10 refuses the rollout target |
| `secrets.*.version` | The service is not rendered (`SECRET_VERSION_UNPINNED`) |
| `bucket.proof` | Apply refuses until the bucket-birth receipt's proof is committed; the staging service is not rendered (`SERVICE_RENDER_BUCKET_PROOF_UNPINNED`) |
| `service.telemetryStorageNamespace` | The service is not rendered; it must equal the namespace the imported data carries. Staging's value was chosen by Claude (see below) |
| `scheduler.analytics-refresh.schedule` | The trigger is not created (decision D3: no default cadence) |
| `stagingOrigin.accessAud` (staging only) | The staging service is not rendered (`STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud`) until the owner creates the staging admin Access application |

### Staging values Claude filled, for the owner to confirm

Stream STG-PREP (Claude, not the owner) committed these staging values so
that the staging service can render once the owner values above arrive. No
owner decision contradicts them, but the owner has not confirmed them either.
The owner confirms or replaces each one before the staging service first
renders. Until D-CRB lands, OPS-2 defers that service in any case.

| Setting | Committed value | Source |
|---|---|---|
| `service.telemetryStorageNamespace` | `tibotattle-staging-synthetic` | Claude's choice. Staging imports no data, so the rule that it equals the imported data's namespace holds trivially |
| `stagingOrigin.publicOrigin` | `https://staging.tibotattle.com` | Staging edge plan proposal D-S1, not yet confirmed by the owner |
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

OPS-2 still defers creating it (`STAGING_HOST_COMPOSITION_PENDING`) until
D-CRB lands the staging host composition: the server reads no `HOST_MODE`
yet. The D-CRB merge removes that gate together with its check.

The staging secrets, bucket birth and apply follow
`docs/runbooks/gcp-staging-apply.md`, with
`scripts/gcp-staging-secrets.mjs` (synthetic values, piped to Secret Manager
on stdin) and `scripts/gcp-staging-bucket-birth.mjs` (birth, the committed
receipt `staging.bucket-birth.receipt.json` and its pinned proof).

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
