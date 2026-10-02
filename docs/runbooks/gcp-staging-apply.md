---
title: GCP staging plane apply
date: 2026-10-02
type: runbook
status: draft
---

# GCP staging plane apply

> **Draft, for one operator: Claude's main session.** It applies the staging
> plane that `apps/worker/cloud-run/infra/staging.desired-state.json`
> describes, in the shared GCP test project `tibotattle`, under the owner's
> 2026-10-02 authorization ("Staging plane in the GCP test project
> `tibotattle`: APPROVED ... new staging-named resources only, including
> their IAM bindings"). It never touches production, Cloudflare,
> `tibotattle-test-app` or the OAuth gateway. Every value is synthetic.
> Prepared by stream STG-PREP; nothing here has been run against a live
> project. The first live run is the qualification.

## Scope and claim boundary

This runbook covers, in order: the read-only plan, the synthetic secrets,
pinning their versions, the bucket birth and its proof, committing the
pins and the receipt, the first OPS-2 apply, and readback. It then lists
the gated tail (the bootstrap image, the jobs, the service, migrate and roll)
with the gate that holds each one. A gated step is not part of the approved
work until its gate is cleared.

What the tooling guarantees, from code and offline checks
(`npm --prefix apps/worker run gcp:ops:infra:check`):

- `scripts/gcp-staging-secrets.mjs` refuses every id that is not
  `tibotattle-staging-*`, makes each value in process, passes it to
  `gcloud secrets versions add --data-file=-` on stdin only, and prints
  secret ids and version numbers only. Google, Apple and GitHub-token
  secrets are inert synthetic values.
- `scripts/gcp-staging-bucket-birth.mjs` makes the one OPS-2 bucket insert,
  writes the receipt to `apps/worker/cloud-run/infra/staging.bucket-birth.receipt.json`
  and pins its proof into the staging desired state.
- `scripts/gcp-infra.mjs apply` runs only the create, update and bind
  operations of the exact plan you authorize. It never deletes.

What it does not prove: that gcloud's live output parses as the fake does
(OPS2-READ), that the shared project has no co-tenant using a staging name
or the project-wide custom role id, or that a staging service starts (it
cannot until D-CRB).

## Before you start

Run everything from `apps/worker` of a clean checkout of
`claude/gcp-fastpath-final` that contains the STG-PREP merge. `SCRATCH` is
your session scratchpad (outside the repository). Never put a secret value
in a command, a file or a message.

```bash
cd "$FINAL_CHECKOUT/apps/worker"
git status --porcelain                    # expect: nothing
git log -1 --format=%H                    # record it: this is <commit>
gcloud config get-value account           # record it: the operator account
npm run gcp:ops:infra:check               # expect: every test passes, 0 fail
```

Stop if the tree is dirty, the gate fails, or gcloud has no active account.

## 1. Plan (read-only)

```bash
node scripts/gcp-infra.mjs plan --environment=staging > "$SCRATCH/staging-plan-0.json"; echo "exit=$?"
```

Expected: `exit=2` (blockers). In the JSON: `"environment": "staging"`,
`"project": "tibotattle"`, `summary.refused` 0, `findings` and `blockers`
both exactly `["BUCKET_ABSENT", "BUCKET_PROOF_UNPINNED"]`. Executable
operations create the six `tibotattle-staging-*` service accounts and their
project roles, the custom role, the `tibotattle-staging-images` repository,
seven `tibotattle-staging-*` secrets and their accessor bindings, and the
`tibotattle-staging-primary` instance, database and IAM users. Deferred:
the service (`STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud`), both jobs
(`BOOTSTRAP_IMAGE_REQUIRED`), the trigger (`SCHEDULER_CADENCE_UNSET`) and
the verifier grant (`VERIFIER_TOKEN_CREATOR_UNASSIGNED`).

Stop, and do not continue, if any of these holds:

- exit 1, or `summary.refused` above 0 (a delete, destructive change or
  bucket update);
- any operation argv names `tibotattle-test`, the OAuth gateway, `_Default`
  or a resource without `staging` in its name, other than the custom role;
- the custom role is planned as anything but `custom-role:create`. Its id
  `tibotattleQuarantineStore` is project-wide and not staging-named: an
  update or destructive entry means a co-tenant already owns that id. Ask
  the owner before going on;
- a finding other than the two above (for example `SERVICE_ACCOUNT_DISABLED`,
  `CUSTOM_ROLE_*`, `BUCKET_PROOF_STALE`), or any live staging resource you
  did not create.

## 2. Synthetic secrets

Dry run first. It makes no call.

```bash
node scripts/gcp-staging-secrets.mjs --environment=staging --dry-run
```

Expected: exit 0, `"status": "dry_run"`, `"authorization":
"staging-secrets:tibotattle:adf926e2663c3a85"` (a digest of the committed
variable-to-id map; it changes only if the ids change), `generationSelfTest`
`{ "valuesGenerated": 7, "valuesChecked": 7, "valuesKept": 0 }`, and seven
`tibotattle-staging-*` ids with their value kinds. No value appears.

Then apply, with the authorization the dry run printed:

```bash
node scripts/gcp-staging-secrets.mjs --environment=staging --apply \
  --authorize=staging-secrets:tibotattle:adf926e2663c3a85 \
  --write-pins --report-out="$SCRATCH/staging-secrets-report.json"; echo "exit=$?"
```

Expected: exit 0, `"status": "provisioned"`, seven entries each with
`"container": "created"`, `"outcome": "added"`, `"version": "1"`, and
`pinned.changed: true` with all seven variables at `"1"`.

Stop conditions:

- Any entry reads `already_provisioned` on this first run: someone else made
  that `tibotattle-staging-*` secret. Do not pin it; ask the owner.
- `STAGING_ENVELOPE_PAIR_PARTIAL` or `STAGING_SECRET_VERSIONS_UNUSABLE:<VAR>`:
  stop and ask. Never disable, destroy or delete a version by hand.
- Exit 1 with `outcomes` in the error: some versions were added. Read the
  code; when the cause is fixed, rerun the same command. A rerun skips every
  secret that already has an ENABLED version and pins it.
- `STAGING_SECRETS_AUTHORIZATION_MISMATCH`: the ids changed; rerun the dry
  run and review why.

## 3. Review the version pins

```bash
git diff -- cloud-run/infra/staging.desired-state.json
```

Expected: exactly seven changed lines, each `"version": null` becoming
`"version": "1"`. Stop on any other change.

## 4. Bucket birth and its proof

Dry run first. It makes no call.

```bash
node scripts/gcp-staging-bucket-birth.mjs --environment=staging
```

Expected: exit 0, `"status": "dry_run"`, `"authorization":
"bucket-birth:tibotattle:tibotattle-staging-quarantine"`, the insert body
(`US-EAST1`, `STANDARD`, uniform access, public access prevention enforced,
soft delete `"0"`, no versioning), `"receiptFile":
"cloud-run/infra/staging.bucket-birth.receipt.json"` and `"proofPinned": false`.

```bash
node scripts/gcp-staging-bucket-birth.mjs --environment=staging --apply \
  --authorize=bucket-birth:tibotattle:tibotattle-staging-quarantine; echo "exit=$?"
node scripts/gcp-staging-bucket-birth.mjs --environment=staging --verify
```

Expected: exit 0, `"status": "created_and_pinned"`, a `proof` with a decimal
`bucketGeneration` and `"bucketMetageneration": "1"`; the receipt file now
exists; `--verify` prints `"status": "verified"` with the same proof.

Stop conditions:

- `BUCKET_BIRTH_BUCKET_EXISTS`: the bucket already exists. Never adopt it;
  ask the owner.
- `BUCKET_BIRTH_RECEIPT_PATH_UNAVAILABLE`: a receipt file is already there;
  nothing was inserted. Find out why before anything else.
- stderr with `"bucketInserted": true, "receiptWritten": true`: the bucket
  and receipt exist, only the pin failed. Fix the cause, then run
  `node scripts/gcp-staging-bucket-birth.mjs --environment=staging --pin-only`.
- stdout `"status": "created_receipt_unwritten"`: the bucket exists and the
  receipt is only on stdout. Save that `receipt` object, unchanged, as
  `cloud-run/infra/staging.bucket-birth.receipt.json`, then run `--pin-only`
  (it verifies the receipt before pinning). Never rerun `--apply`.

## 5. Commit the pins and the proof

```bash
git diff --stat
npm run gcp:ops:infra:check
git add cloud-run/infra/staging.desired-state.json cloud-run/infra/staging.bucket-birth.receipt.json
git commit -m "chore(gcp): pin the staging secret versions and bucket-birth proof"
```

Expected: the diff is the seven version lines, the one `proof` line and the
new receipt file; the gate passes (its checks accept both the unpinned and
the pinned file and hold the proof to the receipt). Do not push; apply reads
the committed file locally (`GCP_INFRA_COMMITTED_DESIRED_STATE_REQUIRED`).

## 6. Apply, pass 1 (no image)

```bash
node scripts/gcp-infra.mjs plan --environment=staging > "$SCRATCH/staging-plan-1.json"; echo "exit=$?"
node -e 'const p=require(process.argv[1]);console.log(p.planDigest, JSON.stringify(p.summary), JSON.stringify(p.findings), JSON.stringify(p.blockers))' "$SCRATCH/staging-plan-1.json"
node scripts/gcp-infra.mjs apply --environment=staging --authorize=<planDigest> > "$SCRATCH/staging-apply-1.json"; echo "exit=$?"
```

Expected plan: exit 0, no findings or blockers, `summary.refused` 0. With
the secrets and bucket already made, about 26 executable operations
(accounts, roles, repository, accessor bindings, Cloud SQL) and 8 deferred
(the service and its two invoker bindings on
`STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud`, both jobs and the
scheduler's executor binding on `BOOTSTRAP_IMAGE_REQUIRED`, the trigger on
`SCHEDULER_CADENCE_UNSET`, the verifier grant on
`VERIFIER_TOKEN_CREATOR_UNASSIGNED`). The in-memory rehearsal of exactly
this pass is the last test of `scripts/gcp-ops-infra-staging-service.check.mjs`.

Expected apply: exit 0 and an apply receipt listing each operation's
outcome. Cloud SQL creation takes several minutes.

Stop conditions: every plan stop condition of step 1; apply exit 1 (its
stderr lists the operations that ran; re-plan, read the readback, and only
then decide whether a fresh plan and apply is safe); `APPLY_PLAN_DIGEST_MISMATCH`
(the estate moved between plan and apply: re-plan, re-read, re-authorize).

## 7. Readback

```bash
node scripts/gcp-infra.mjs readback --environment=staging > "$SCRATCH/staging-readback-1.json"; echo "exit=$?"
node scripts/gcp-infra.mjs readback --environment=staging --require-clean > "$SCRATCH/staging-clean-1.json"; echo "exit=$?"
```

Expected: the first exits 0 with no finding. The second exits 2 with
`"clean": false`, and its reasons are only the deferrals listed in step 6.
This is the first owner-run readback of the test project (OPS2-READ): check
that the service-account policy, the scheduler listing and the custom role
parsed, and keep the files as evidence (they are content-free).

Approved work ends here unless the gates below are cleared.

## The gated tail

Each step below needs its gate first. Commands are those on the final line
at STG-PREP's base; take exact flags from the line you run.

| Step | Gate |
|---|---|
| Name the verifier's operator: set `serviceAccounts.verifier.tokenCreators` to `["user:<operator account>"]` in the staging file, commit, plan and apply (one `iam service-accounts add-iam-policy-binding` on the staging verifier) | The owner names the operator (the README lists it as an owner value). OPS-10 refuses every staging verb until it is set (`ROLLOUT_TARGET_VERIFIER_TOKEN_CREATOR_UNASSIGNED`) |
| Set `stagingOrigin.accessAud` to the staging admin Access application's AUD tag, commit | The owner creates that Access application (staging edge plan, phase C). Until then the service stays deferred |
| Bootstrap image: `node scripts/gcp-production-rollout.mjs build --environment=staging --commit=<commit> --authorize=build:staging:<commit> --execute` | The verifier operator above, and **explicit owner authorization for a push**: every OPS-10 mutating verb takes the shared production coordination lock by pushing `refs/heads/codex/production-deployment-lock` to GitHub (`scripts/production-deployment-lock.mjs`). Without it, stop |
| Apply, pass 2: `plan --environment=staging --bootstrap-image-digest=<digest> --bootstrap-source-commit=<commit>`, then `apply` with the same bootstrap flags and the new plan digest. Creates both jobs and the executor binding | The image. The scheduler trigger stays absent until the owner sets the cadence (D3) |
| The service | D-CRB must land the staging host composition: the server reads no `HOST_MODE` yet, so OPS-2 defers the service (`STAGING_HOST_COMPOSITION_PENDING`). The D-CRB merge removes that entry from `SERVICE_COMPOSITION_PENDING` together with its check; then pass 2 also creates the service |
| Backup audit: `node scripts/gcp-backup-horizon.mjs audit --environment=staging --project=tibotattle --primary-instance=tibotattle-staging-primary --region=us-east1` | Read-only; exit 0 or 2 is usable, 3 is a breach |
| Migrate: `node scripts/gcp-production-rollout.mjs migrate --environment=staging --commit=<commit> --digest=<digest> --backup-audit=<file> --migrate-receipt=<new file> --authorize=migrate:staging:<digest> --execute` | A clean readback (needs the service, so D-CRB, and the operator), the lock push authorization, and quiescence: OPS-10 counts every Cloud Run job trigger in `us-east1`, so a running test-estate trigger refuses it |
| Roll: `gcp-production-rollout.mjs roll ... --edge-live=<capture>` | A migrate receipt and a fresh `tibotattle-edge-live-capture-v1` capture of the tracked `env.staging` Worker. No repository command writes that capture yet, and the tracked staging Worker is the old workers.dev one, not the planned staging edge |

## If something must be undone

The tooling never deletes. Removing a staging resource is a separate,
explicit decision: list exact targets, check they are staging-named and
were made by this run, and ask the owner first. Cloud SQL has deletion
protection on. A secret version is never destroyed to "retry"; a rerun adds
only what is missing.
