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
> touches Cloudflare. Prepared by stream PROD-PREP; nothing here has run
> against `tibotattle-prod`. The first live run is the qualification.

## Scope and claim boundary

In order: read-only checks, API enablement, the bucket birth and its pinned
proof, OPS-2 pass 1 (accounts, grants, custom role, registry, secret
containers, Cloud SQL with its IAM users, the logging exclusion, and the
analytics-refresh trigger created and paused), readback, the secrets, the
pins, and the production alert channel. The gated tail (the bootstrap image,
the jobs, the service, migrate and roll) is listed with its gate and is not
part of this approval.

What the offline checks prove (`npm run gcp:ops:infra:check`, including
`scripts/gcp-ops-infra-production.check.mjs`): the committed file validates
as a dedicated production plane; against the synthetic gcloud, the birth,
pass 1, the pins and pass 2 converge; no operation names a retired Google or
Apple secret, a staging or a test-estate resource; the Cloud SQL IAM users go
by their PostgreSQL names. They do not prove that live gcloud output parses
as the fake does, that the APIs below are the complete set, or that the
builder can read Cloud Build's source bucket.

**Approval granularity.** Each mutating step below is one approval. OPS-2
applies an authorized plan whole: the pass 1 approval covers exactly the
operations its plan lists, under its `planDigest`, and a changed estate
changes the digest (`APPLY_PLAN_DIGEST_MISMATCH`). Show the owner the
operation list with the digest.

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
`["BUCKET_ABSENT", "BUCKET_PROOF_UNPINNED"]`, 33 executable and 6 deferred
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

```bash
node scripts/gcp-infra.mjs plan --environment=production > "$SCRATCH/prod-plan-1.json"; echo "exit=$?"
node -e 'const p=require(process.argv[1]);console.log(p.planDigest, JSON.stringify(p.summary), JSON.stringify(p.findings), JSON.stringify(p.blockers));for(const o of p.operations)console.log(o.deferred?"DEFERRED":"RUN", o.id, o.deferred??"")' "$SCRATCH/prod-plan-1.json"
```

Expect exit 0, no findings or blockers, 33 executable, 6 deferred, 0 refused.
The owner approves this list and its `planDigest`:

- executable: six service accounts; the verifier's token-creator grant for
  the owner's account; the custom role `tibotattleQuarantineStore`; six
  project bindings (Cloud SQL client and instance user for runtime and
  migrator, the builder's log writer, and the runtime's bucket-scoped custom
  role); the `tibotattle-images` repository and its builder writer binding;
  the five secret containers (`IDENTITY_LINK_SECRET`,
  `POSTGRES_RATE_LIMIT_SECRET`, `ENVELOPE_PUBLIC_JWK`, `ENVELOPE_PRIVATE_JWK`,
  `DISTRIBUTION_GITHUB_API_TOKEN`) and the runtime's accessor binding on
  each; the `tibotattle-primary` instance, its database and its two IAM users
  (`tibotattle-runtime@tibotattle-prod.iam`, `tibotattle-migrator@tibotattle-prod.iam`);
  the `_Default` sink's request-log exclusion; and the trigger
  `tibotattle-analytics-refresh-trigger`, created and paused at once;
- deferred: the service and its two invoker bindings
  (`TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED`), both jobs and the scheduler's
  executor binding (`BOOTSTRAP_IMAGE_REQUIRED`).

```bash
node scripts/gcp-infra.mjs apply --environment=production --authorize=<planDigest> > "$SCRATCH/prod-apply-1.json"; echo "exit=$?"
```

Expect exit 0 and `remaining` with 0 executable and 6 deferred. Cloud SQL
takes several minutes. The trigger cannot start anything: no job exists and
the scheduler account has no executor grant. Stop on the staging runbook's
step 7 conditions.

## 6. Readback (read-only)

```bash
node scripts/gcp-infra.mjs readback --environment=production > "$SCRATCH/prod-readback-1.json"; echo "exit=$?"
node scripts/gcp-infra.mjs readback --environment=production --require-clean > "$SCRATCH/prod-clean-1.json"; echo "exit=$?"
gcloud scheduler jobs describe tibotattle-analytics-refresh-trigger --location=us-east1 --project=tibotattle-prod --format="value(state)"
```

Expect exit 0 with no finding, then exit 2 whose reasons are the six
deferrals of step 5, and `PAUSED`. The readback is the post-apply proof of
the logging exclusion. Keep the files; they are content-free.

## 7. Secrets

OPS-2 made the five containers in step 5. Versions come from two places.

**Owner-held, carried over from Cloudflare, byte for byte (the owner runs
these).** `IDENTITY_LINK_SECRET` must be the production Worker's exact value:
the imported primary pins its keyed fingerprint under `production-v1`, and
the origin never re-pins (`assertExistingPostgresIdentityLinkPin`), so any
other value, a trailing newline included, fails the session ports with
`IDENTITY_CONFIGURATION_INVALID`. `ENVELOPE_PUBLIC_JWK` and
`ENVELOPE_PRIVATE_JWK` are one pair with the same `kid`.
`DISTRIBUTION_GITHUB_API_TOKEN` is optional: add it, or leave its version
unpinned and the service renders without it.

```bash
<custody command that prints the exact value> | gcloud secrets versions add IDENTITY_LINK_SECRET --project=tibotattle-prod --data-file=-
```

The same for each name. The owner reports only the version numbers.

**New random, generated straight into Secret Manager (the main session runs
this; nobody sees the value).** `POSTGRES_RATE_LIMIT_SECRET` is origin-only
and new; CR-3 needs at least 32 bytes.

```bash
openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_' \
  | gcloud secrets versions add POSTGRES_RATE_LIMIT_SECRET --project=tibotattle-prod --data-file=- --no-log-http --format="value(name)"
```

Then read back states only:

```bash
for name in IDENTITY_LINK_SECRET POSTGRES_RATE_LIMIT_SECRET ENVELOPE_PUBLIC_JWK ENVELOPE_PRIVATE_JWK DISTRIBUTION_GITHUB_API_TOKEN; do
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

Set each pinned `version` to the number step 7 reported (leave
`DISTRIBUTION_GITHUB_API_TOKEN` at `null` if the owner did not add it) and
`service.telemetryStorageNamespace` to step 8's value. Then:

```bash
npm run gcp:ops:infra:check
git add cloud-run/infra/production.desired-state.json
git commit -m "chore(gcp): pin the production secret versions and telemetry namespace"
node scripts/gcp-infra.mjs plan --environment=production > "$SCRATCH/prod-plan-2.json"; echo "exit=$?"
```

Expect exit 0 with 0 executable. The service and its bindings now wait on
`SERVICE_RETIRED_SECRET_STILL_REQUIRED:GOOGLE_OIDC_CLIENT_SECRET`, and the jobs
on the bootstrap image.

## 10. The production alert channel (approval 4; OWN-5c)

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
| Pass 2: `plan` and `apply --environment=production --bootstrap-image-digest=<digest> --bootstrap-source-commit=<commit>` | The image. Creates both jobs and the scheduler's executor binding; the trigger stays paused |
| The service and its invoker bindings | ROUTES-R12 drops `GOOGLE_OIDC_CLIENT_SECRET` and `APPLE_PRIVATE_KEY` from CR-3 and the service template; the deferral then clears itself. Also the namespace pin (step 8) |
| Migrate and roll (PROD-3) | `docs/runbooks/gcp-rollout.md`, with the image and the edge in place |
| Resume the trigger | OPS-3 only, at cutover (`docs/runbooks/gcp-scheduler-resume.md`) |

## If something must be undone

The plane tooling never deletes. Removing a production resource is a
separate owner decision with exact targets. Cloud SQL has deletion
protection on. A secret version is never destroyed to retry.
