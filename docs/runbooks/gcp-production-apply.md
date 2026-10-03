---
title: GCP production plane apply
date: 2026-10-02
type: runbook
status: draft
---

# GCP production plane apply

> **Draft, for one operator: Claude's main session, with the owner's approval
> for each mutating step.** It builds the production plane that
> `apps/worker/cloud-run/infra/production.desired-state.json` describes, in
> the dedicated project `tibotattle-prod` (number 874229235044, `us-east1`),
> under owner decisions round 13 ("Production infrastructure: start now ...
> with per-operation owner approval ... triggers created PAUSED, with no
> traffic"). Nothing here routes traffic, deploys a Worker, pushes a ref or
> changes anything on Cloudflare. Prepared by stream PROD-PREP; nothing here
> has run against `tibotattle-prod`. The first live run is the
> qualification.

## Scope and claim boundary

In order: read-only checks, API enablement, the bucket birth and its pinned
proof, OPS-2 pass 1 (accounts, grants, custom role, registry, secret
containers, Cloud SQL with its IAM users and the logging exclusion), readback,
the secrets, the pins, the identity-link rotation check and the production
alert channel. Pass 1 creates no scheduler trigger: the refresh cadence is
decided after the production-scale measurement (round 15, C3), so its create
is deferred until the owner commits one.
The gated tail (the bootstrap image, the jobs, the service, migrate and roll)
is listed with its gate and is not part of this approval.

What the offline checks prove (`npm run gcp:ops:infra:check`, including
`scripts/gcp-ops-infra-production.check.mjs` and
`scripts/gcp-identity-link-pin-check.check.mjs`): the committed file
validates as a dedicated production plane; against the synthetic gcloud, the
birth, pass 1, the pins and pass 2 converge; no operation names a left-out
secret (the Google and Apple secrets round 12 retired, or the unread GitHub
token), a staging resource or a test-estate resource; the Cloud SQL IAM users
go by their PostgreSQL names; the pin check computes the Worker's
identity-link fingerprint, holds a rotated mount to the round-16 rotation
document, and prints no content. They do not prove that live
gcloud output parses as the fake does, that the APIs below are the complete
set, or that the builder can read Cloud Build's source bucket.

## Approvals

**Granularity (round 15, C1).** The owner approved one approval per pass: one
`planDigest` over the listed operations (29 in pass 1). `apply` runs every
executable operation of an authorized plan under that digest, and a changed
estate changes the digest (`APPLY_PLAN_DIGEST_MISMATCH`). API enablement, the
bucket birth, the rate-limit secret and the alert channel are still approved
separately. A later pass (the bootstrap image, or the trigger once its cadence
is committed) is a new plan with a new digest and a new approval.

**Round 15 answers that shape step 5.**

1. Production verifier grant (C2): approved.
   `roles/iam.serviceAccountTokenCreator` for `user:adamallcock@gmail.com` on
   `tibotattle-verifier@tibotattle-prod.iam.gserviceaccount.com` (operation
   `verifier-iam:bind:roles/iam.serviceAccountTokenCreator|user:adamallcock@gmail.com|`).
   The verifier account's only other grant is `run.invoker` on the service.
2. Refresh cadence (C3): decided after the production-scale measurement.
   `scheduler.analytics-refresh.schedule` is committed `null` (state
   `PAUSED`), so pass 1 skips the scheduler operations: the trigger create is
   deferred (`SCHEDULER_CADENCE_UNSET`) and no pause is planned. When the owner
   supplies the cadence, it is committed and a later plan creates the trigger
   and pauses it at once under its own digest and approval. There is no
   default cadence.

**The approvals, in order.** Each is asked for in chat, and each runs only
after a clear yes:

| Approval | Step | What it changes |
|---|---|---|
| 1 | 2 | Enables the APIs (one `gcloud services enable` call; there is no authorization token) |
| 2 | 4 | Creates the bucket (`--authorize=bucket-birth:tibotattle-prod:tibotattle-quarantine`) |
| 3 | 5 | OPS-2 pass 1 (`--authorize=<planDigest>`): one approval over the 29 listed operations |
| 4 | 7 | Generates `POSTGRES_RATE_LIMIT_SECRET` version 1 straight into Secret Manager |
| 5 | 11 | Creates the production alert channel (`--authorize=<planDigest>`) |

The owner-held secret versions are added in step 7 (round 16: the owner
asked Claude to run those commands). Step 10 writes nothing, but it reads
the identity-link secret's value into a local process, so it also needs the
owner's OK (or the owner runs it).

## Before you start

From `apps/worker` of a clean checkout of the commit that carries this file.
`SCRATCH` is the session scratchpad. Never put a secret value in a command,
a file or a message.

```bash
git status --porcelain                    # expect: nothing
gcloud config get-value account           # the owner's account
gcloud config get-value core/log_http     # expect: False, or (unset)
npm run gcp:ops:infra:check               # expect: 0 fail
```

## 1. Read-only checks

```bash
gcloud projects describe tibotattle-prod --format="value(projectNumber,lifecycleState)"
gcloud billing projects describe tibotattle-prod --format="value(billingEnabled)"
gcloud services list --enabled --project=tibotattle-prod --format="value(config.name)" | sort
```

Expect `874229235044 ACTIVE` and `True`. Stop on anything else.

## 2. Enable the APIs (approval 1)

```bash
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com sqladmin.googleapis.com run.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com storage.googleapis.com logging.googleapis.com \
  monitoring.googleapis.com --project=tibotattle-prod
```

Then rerun the services list. Every name above should be enabled. Enabling an
API that is already on is a no-op. Google adds its own service agents; OPS-2
reads only the plane's members, so they are not drift.

## 3. Plan (read-only)

```bash
node scripts/gcp-infra.mjs plan --environment=production > "$SCRATCH/prod-plan-0.json"; echo "exit=$?"
```

Expect `exit=2`, `summary.refused` 0, `findings` and `blockers` both exactly
`["BUCKET_ABSENT", "BUCKET_PROOF_UNPINNED"]`, 29 executable and 10 deferred
operations. Stop on a refused operation, any other finding, or any live
plane resource you did not expect.

## 4. Bucket birth and its proof (approval 2)

```bash
node scripts/gcp-infra.mjs bucket-birth --environment=production
```

The dry run makes no call. Expect `"authorization":
"bucket-birth:tibotattle-prod:tibotattle-quarantine"` and the posture body
(`US-EAST1`, `STANDARD`, uniform access, public access prevention enforced,
soft delete `"0"`, no versioning). Then:

```bash
node scripts/gcp-infra.mjs bucket-birth --environment=production --apply \
  --authorize=bucket-birth:tibotattle-prod:tibotattle-quarantine \
  --receipt-out="$SCRATCH/production.bucket-birth.receipt.json"; echo "exit=$?"
```

Pin the proof from the receipt, then commit the pin and the receipt:

```bash
cp "$SCRATCH/production.bucket-birth.receipt.json" cloud-run/infra/production.bucket-birth.receipt.json
node -e '
const fs = require("fs");
const receipt = JSON.parse(fs.readFileSync("cloud-run/infra/production.bucket-birth.receipt.json", "utf8"));
const path = "cloud-run/infra/production.desired-state.json";
const text = fs.readFileSync(path, "utf8");
const { bucketGeneration, bucketMetageneration } = receipt.proof;
if (receipt.bucket !== "tibotattle-quarantine" || receipt.project !== "tibotattle-prod") throw new Error("RECEIPT_TARGET");
const next = text.replace("\"proof\": null",
  `"proof": { "bucketGeneration": "${bucketGeneration}", "bucketMetageneration": "${bucketMetageneration}" }`);
if (next === text) throw new Error("PROOF_ALREADY_PINNED");
fs.writeFileSync(path, next);'
git diff --stat && npm run gcp:ops:infra:check
git add cloud-run/infra/production.desired-state.json cloud-run/infra/production.bucket-birth.receipt.json
git commit -m "chore(gcp): pin the production bucket-birth proof"
```

The stop conditions are the staging runbook's step 4, read for production.
`BUCKET_BIRTH_BUCKET_EXISTS` means stop and ask. Never rerun `--apply` after
`bucketInserted: true`, and never write a receipt by hand. A wrong pin cannot
pass: the next plan reads it as `BUCKET_PROOF_STALE`, and apply refuses.

## 5. Apply, pass 1 (approval 3)

Only after the owner approves the operation list below (approval 3 in
[Approvals](#approvals)).

```bash
node scripts/gcp-infra.mjs plan --environment=production > "$SCRATCH/prod-plan-1.json"; echo "exit=$?"
node -e 'const p=require(process.argv[1]);console.log(p.planDigest, JSON.stringify(p.summary), JSON.stringify(p.findings), JSON.stringify(p.blockers));for(const o of p.operations)console.log(o.deferred?"DEFERRED":"RUN", o.id, o.deferred??"")' "$SCRATCH/prod-plan-1.json"
```

Expect exit 0, no findings or blockers, 29 executable, 10 deferred, 0 refused.
The owner approves this list and its `planDigest`:

- executable: six service accounts; the verifier's token-creator grant for
  the owner's account (C2); the custom
  role `tibotattleQuarantineStore`; six project bindings (Cloud SQL client
  and instance user for runtime and migrator, the builder's log writer, and
  the runtime's bucket-scoped custom role); the `tibotattle-images`
  repository and its builder writer binding; the four secret containers
  (`IDENTITY_LINK_SECRET`, `POSTGRES_RATE_LIMIT_SECRET`,
  `ENVELOPE_PUBLIC_JWK`, `ENVELOPE_PRIVATE_JWK`) and the runtime's accessor
  binding on each; the `tibotattle-primary` instance, its database and its
  two IAM users (`tibotattle-runtime@tibotattle-prod.iam`,
  `tibotattle-migrator@tibotattle-prod.iam`); the `_Default` sink's
  request-log exclusion;
- deferred: the service and its two invoker bindings
  (`TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED`), the migration and refresh jobs
  and the scheduler's executor binding on the refresh job
  (`BOOTSTRAP_IMAGE_REQUIRED`), D-OPS4's maintenance job, its every-minute
  trigger `tibotattle-maintenance-trigger` and the scheduler's executor
  binding on it (`TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED`: the job reads the
  namespace), and the trigger
  `tibotattle-analytics-refresh-trigger` (`SCHEDULER_CADENCE_UNSET`, C3). The
  trigger deferral is not a readiness reason for the rollout: `--require-clean`
  treats it as clean, because the measurement that decides the cadence needs
  the rolled image. It is one for the cutover, whose scheduler gate
  (`gcp-cutover-window.md`) runs `readback --require-clean --require-cadence`
  and refuses an unset cadence. Nothing else notices a cadence that was never
  committed: the refresh alerts wait on it too.

There is no container for `DISTRIBUTION_GITHUB_API_TOKEN`: nothing on the
production estate reads it (`UNREAD_PRODUCTION_SECRET_NAMES`), and the
service renders without it.

```bash
node scripts/gcp-infra.mjs apply --environment=production --authorize=<planDigest> > "$SCRATCH/prod-apply-1.json"; echo "exit=$?"
```

Expect exit 0 and `remaining` with 0 executable and 10 deferred. Cloud SQL
takes several minutes. No trigger exists, and the scheduler account has no
executor grant, so nothing can start a job. Stop on the staging runbook's
step 7 conditions.

## 6. Readback (read-only)

```bash
node scripts/gcp-infra.mjs readback --environment=production > "$SCRATCH/prod-readback-1.json"; echo "exit=$?"
node scripts/gcp-infra.mjs readback --environment=production --require-clean > "$SCRATCH/prod-clean-1.json"; echo "exit=$?"
gcloud scheduler jobs list --location=us-east1 --project=tibotattle-prod --format="value(name)"
```

Expect exit 0 with no finding, then exit 2 whose reasons are the six
non-clean deferrals of step 5 (the service, its two invoker bindings, both
jobs and the executor binding), and an empty scheduler list (the trigger waits
for the cadence). The readback is the post-apply proof of the logging
exclusion. Keep the files; they are content-free.

## 7. Secrets

OPS-2 made the four containers in step 5. Versions come from two places.

**Owner-held, carried over from Cloudflare, byte for byte.**
`ENVELOPE_PUBLIC_JWK` and `ENVELOPE_PRIVATE_JWK` are one pair with the same
`kid`. Do not add a `DISTRIBUTION_GITHUB_API_TOKEN`: production has no
container for it, and nothing on the production estate would read it.

```bash
<custody command that prints the exact value> | gcloud secrets versions add ENVELOPE_PUBLIC_JWK --project=tibotattle-prod --data-file=- --no-log-http
```

The same for the private half. Only the version numbers are reported.

**New random, generated straight into Secret Manager (approval 4; the main
session runs this, and nobody sees the value).** `IDENTITY_LINK_SECRET` is
newly generated (round 16): Cloudflare's value is lost, so it is not carried
over. The origin mounts it under the rotated label `production-v2`, and the
cutover moves the imported pin from `production-v1` to it under its own
token and receipt
([cutover window](./gcp-cutover-window.md#identity-link-rotation-round-16)).
That is safe because no kept route reads the pin: round 12 retires every
reader (`IDENTITY_LINK_CONSUMER_ROUTE_IDS`), and the host refuses to compose
under the rotated label if it would serve one. Step 10 checks that the
mounted version is the rotation's target. Its version 1 (32 random bytes,
base64url, no trailing newline) was generated on 2026-10-02 (round 16);
never add another to retry. `POSTGRES_RATE_LIMIT_SECRET` is
origin-only and new; CR-3 needs at least 32 bytes. The add is not
idempotent: a second run adds version 2. So first confirm that the secret
has no version yet:

```bash
gcloud secrets versions list POSTGRES_RATE_LIMIT_SECRET --project=tibotattle-prod --format="value(name,state)"
```

Expect no output. If anything is listed, stop and ask the owner. Then, once:

```bash
openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_' \
  | gcloud secrets versions add POSTGRES_RATE_LIMIT_SECRET --project=tibotattle-prod --data-file=- --no-log-http --format="value(name)"
```

It prints the new version's name. Never rerun it after that. Then read back
states only:

```bash
for name in IDENTITY_LINK_SECRET POSTGRES_RATE_LIMIT_SECRET ENVELOPE_PUBLIC_JWK ENVELOPE_PRIVATE_JWK; do
  gcloud secrets versions list "$name" --project=tibotattle-prod --format="value(name,state)"
done
```

Never disable, destroy or add a second version to "retry"; ask the owner.

## 8. The telemetry storage namespace (read-only, then a pin)

Continuity requires the production Worker's own `TELEMETRY_STORAGE_NAMESPACE`:
legacy and v1.1 admission refuse a namespace that differs from the imported
pinned state. The value is a live plain var no tracked file records. Read it
through the owner's Wrangler login:

```bash
npx wrangler deployments status --name app-usagemonitor --json > "$SCRATCH/prod-deployment.json"
VERSION=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=(d.versions??[]).filter((x)=>x.percentage===100);if(v.length!==1)throw new Error("NOT_ONE_FULL_VERSION");console.log(v[0].version_id)' "$SCRATCH/prod-deployment.json")
npx wrangler versions view "$VERSION" --name app-usagemonitor --json | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{const f=[];const w=(x)=>{if(Array.isArray(x))x.forEach(w);else if(x&&typeof x==="object"){if(x.name==="TELEMETRY_STORAGE_NAMESPACE")f.push(x);Object.values(x).forEach(w)}};w(JSON.parse(s));if(f.length!==1||f[0].type!=="plain_text"||!/^[A-Za-z0-9._:-]{1,256}$/.test(f[0].text))throw new Error("NAMESPACE_NOT_FOUND");console.log(f[0].text)})'
```

## 9. Pin the versions and the namespace, and commit

Set each pinned `version` to the number step 7 reported, and
`service.telemetryStorageNamespace` to step 8's value. Then:

```bash
npm run gcp:ops:infra:check
git add cloud-run/infra/production.desired-state.json
git commit -m "chore(gcp): pin the production secret versions and telemetry namespace"
node scripts/gcp-infra.mjs plan --environment=production > "$SCRATCH/prod-plan-2.json"; echo "exit=$?"
```

Expect exit 0 with 0 executable. The service, its bindings and the jobs now
wait on the bootstrap image only: ROUTES-R12 removed the retired Google and
Apple sign-in secrets from CR-3, so the committed secrets compose the service.

## 10. Identity-link rotation check (read-only; a gate before PROD-3)

This proves, before any migrate or roll, that the Secret Manager
`IDENTITY_LINK_SECRET` version the service will mount is the target of the
round-16 rotation: Cloudflare's D1 pin (label `production-v1`, the lost
secret's fingerprint) is the rotation's source, and the newly generated
mounted value is its target under `production-v2`. No kept route reads the
pin, so a wrong value would not show as a route error; this check is what
stops the cutover from moving the pin to bytes the service does not mount.
Nothing here writes anything.

First the two owner documents, which are not secret but are keyed digests,
so they stay in the owner directory:

1. The D1 pin, read-only through the owner's Wrangler login, into
   `<dir>/sealed-pin.json` (the pin never changes once set, so any time
   before the seal reads the value the seal carries). Use the cutover
   window's command
   ([identity-link rotation](./gcp-cutover-window.md#identity-link-rotation-round-16),
   step 1), which keeps the file private.
2. The rotation document `<dir>/identity-rotation.json`, which the owner's
   `identity-rotate-pin` writes from the mounted version and that pin (the
   same section, step 2).

Then the check (with the owner's OK, because it reads the value into a local
process, or the owner runs it):

```bash
node scripts/gcp-identity-link-pin-check.mjs --environment=production \
  --pin-file=<dir>/sealed-pin.json --rotation-file=<dir>/identity-rotation.json; echo "exit=$?"
```

It reads the version that step 9 pinned. To check a version before its pin
is committed, add `--version=<n>`. Both files are validated before any
gcloud call: the rotation must be the closed `tibotattle-identity-link-rotation-v1`
document naming exactly the retired consumer routes
(`PIN_CHECK_ROTATION_INVALID`), and its labels must move from
`production-v1` to `production-v2`
(`PRODUCTION_IDENTITY_LINK_ROTATION_LABELS`; `PIN_CHECK_ROTATION_LABELS_INVALID`).
It then makes one read-only
`gcloud secrets versions access ... --format=json --no-log-http` call and
prints only the secret id, the version, the rotation's two labels, `match`
or `mismatch`, and content-free reasons, never the value or a fingerprint.
Expect exit 0 and `"outcome": "match"`. Exit 2 is a mismatch:

| Reason | Meaning |
|---|---|
| `ROTATION_SOURCE_MISMATCH` | The D1 pin is not the rotation's `from`. Re-read the pin, recompute the rotation with `identity-rotate-pin`, and rerun |
| `ROTATION_SECRET_NAME_MISMATCH`, `ROTATION_SECRET_VERSION_MISMATCH` | The rotation's `to` names another secret id or version than the one the desired state mounts. Recompute it for the pinned version |
| `FINGERPRINT_MISMATCH` with `MATCHES_WITHOUT_TRAILING_NEWLINE` | The mounted version carries a trailing newline the rotation's `to` does not. Add a clean version, pin it, and recompute the rotation |
| `FINGERPRINT_MISMATCH` with `MATCHES_WITH_TRAILING_NEWLINE` | The other way round. Recompute the rotation from the mounted version |
| `FINGERPRINT_MISMATCH` alone | The mounted value is not the rotation's target. Stop and ask the owner |
| `KEY_VERSION_MISMATCH` | The rotation does not land on `production-v2`, the label the origin runs (`PRODUCTION_IDENTITY_LINK_SECRET_VERSION`). Stop and ask |
| `SECRET_TOO_SHORT` | Under 32 characters; the origin refuses it. Stop and ask |

Without `--rotation-file` the check compares the mount with the pin
directly, as it did for a carried-over value. Against the D1 pin a rotated
mount always reads `mismatch` with `KEY_VERSION_MISMATCH` and
`FINGERPRINT_MISMATCH` and exits 2, so that run never clears this gate.

Never destroy a superseded version to retry; only the pinned version is
mounted. Keep both files for PT-8 (`identity-pin.json` and the rotation's
`rotationSha256` go into `pt8-inputs.json`). Rerun this check before
PROD-3's migrate and roll whenever the pinned version changes.

## 11. The production alert channel (approval 5; OWN-5c)

Write the owner's address to a private file (mode 0600, outside the
repository), then:

```bash
node scripts/gcp-monitoring.mjs notification-channel --environment=production --email-file="$SCRATCH/alert-email.txt"
node scripts/gcp-monitoring.mjs notification-channel --environment=production --email-file="$SCRATCH/alert-email.txt" --authorize=<planDigest>
```

Applying the alert policies is a later, separately authorized step.

## The gated tail

| Step | Gate |
|---|---|
| Bootstrap image: `node scripts/gcp-production-rollout.mjs build --environment=production --commit=<commit>`, then the same with `--authorize=build:production:<commit> --execute` | OPS-10 takes the production lock by pushing `refs/heads/codex/production-deployment-lock`, the ref the Cloudflare production deploys share. No push of it is authorized yet: the owner must authorize that push, and the build, explicitly |
| Pass 2: `plan` and `apply --environment=production --bootstrap-image-digest=<digest> --bootstrap-source-commit=<commit>` | The image and the namespace pin (step 8). Creates the migration, refresh and maintenance jobs, then D-OPS4's maintenance trigger at its pinned `* * * * *` cadence: the trigger create, its pause, and only then the scheduler's executor grant on `tibotattle-maintenance`, the order the refresh trigger follows below. The trigger stays `PAUSED` until OPS-3 resumes it at cutover. It does not grant the scheduler account `roles/run.jobsExecutor` on the refresh job: that grant waits with the refresh trigger (`SCHEDULER_CADENCE_UNSET`), so nothing can start the refresh or migration job. A new plan digest, so a new per-pass approval (C1) |
| The service and its invoker bindings | Created in pass 2 with the jobs: ROUTES-R12 dropped `GOOGLE_OIDC_CLIENT_SECRET` and `APPLE_PRIVATE_KEY` from CR-3 and the service template. They need the namespace pin (step 8) and the bootstrap image |
| Migrate and roll (PROD-3) | `docs/runbooks/gcp-rollout.md`, with the image and the edge in place, and step 10 reading `match` for the pinned version |
| Create the trigger | After the production-scale measurement the owner supplies the refresh cadence (C3). Commit it as `scheduler.analytics-refresh.schedule`, then `plan` and `apply` under a new digest and a new per-pass approval. The plan is three operations in this order: the trigger create, its pause, and then the scheduler's executor grant. Cloud Scheduler creates the trigger `ENABLED`, but the account holds no grant until the pause has succeeded, and apply stops at a failed operation, so nothing can start the job in between. Check the result with `gcloud scheduler jobs describe tibotattle-analytics-refresh-trigger --location=us-east1 --project=tibotattle-prod --format="value(state)"`, which must read `PAUSED`. If the pause fails the trigger is `ENABLED` but the account holds no grant, so it cannot run the job; re-plan, and the repair plan pauses it and then grants. If the plan blocks on `SCHEDULER_CREATE_EXECUTOR_BOUND:analytics-refresh`, the account already holds a grant on the job (an earlier pass 2 that bound it, or a trigger removed by hand), and an `ENABLED` trigger created now could start the job before its pause: stop, and the owner removes `roles/run.jobsExecutor` for the scheduler account on `tibotattle-analytics-refresh` with an exact-target `gcloud run jobs remove-iam-policy-binding`, then re-plans. Apply never removes a grant |
| Resume the trigger | OPS-3 only, at cutover (`docs/runbooks/gcp-scheduler-resume.md`) |

## If something must be undone

The plane tooling never deletes. Removing a production resource is a
separate owner decision with exact targets. Cloud SQL has deletion
protection on. A secret version is never destroyed to retry.
