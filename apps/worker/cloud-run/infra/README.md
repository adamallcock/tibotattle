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
the 6-hour signal. The owner accepted the 6-hour value in round 9, but has
not yet accepted the proxy's delay or asked for a scheduled probe (OWN-5,
open; see `monitoring.md`). The alert is
not applied yet and waits for the cadence and the owner's notification
channel (OWN-5c). The probe also assumes that pausing a trigger updates its
`userUpdateTime`. The first owner-run readback against the test project has
to confirm that after a pause. resume-all does not rely on that assumption
alone: it also compares `lastAttemptTime`, and the receipt's age is bounded.
