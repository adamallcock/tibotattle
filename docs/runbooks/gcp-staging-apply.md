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
pins and the receipt, the owner's confirmation of the project-wide custom
role, the first OPS-2 apply, and readback. It then lists the gated tail (the
bootstrap image, the jobs, the service, migrate and roll) with the gate that
holds each one, and the backup-restore rehearsal. A gated step is not part of
the approved work until its gate is cleared.

What the tooling guarantees, from code and offline checks
(`npm --prefix apps/worker run gcp:ops:infra:check`):

- `scripts/gcp-staging-secrets.mjs` refuses every id that is not
  `tibotattle-staging-*`, makes each value in process, passes it to
  `gcloud secrets versions add --data-file=-` on stdin only, and prints
  secret ids and version numbers only. Every gcloud call it makes carries
  `--no-log-http`, which outranks `core/log_http` in the gcloud config and
  `CLOUDSDK_CORE_LOG_HTTP`, so gcloud never writes a request body (the
  value) to its log files under `~/.config/gcloud/logs`. Google, Apple and
  GitHub-token secrets are inert synthetic values. The envelope key pair is
  provisioned as one unit, and a run that fails part-way can be rerun with
  the same command.
- `scripts/gcp-staging-bucket-birth.mjs` makes the one OPS-2 bucket insert,
  writes the receipt to `apps/worker/cloud-run/infra/staging.bucket-birth.receipt.json`
  and pins its proof into the staging desired state.
- `scripts/gcp-infra.mjs apply` runs only the create, update and bind
  operations of the exact plan you authorize. It never deletes.

What it does not prove: that gcloud's live output parses as the fake does
(OPS2-READ), that the shared project has no co-tenant using a staging name
or the project-wide custom role id, or that a staging service starts (D-CRB
composes `HOST_MODE=staging`, but no staging revision has run). The `--no-log-http` behaviour was read from the local
Google Cloud SDK 569.0.0 source, not observed in a live run.

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
gcloud config get-value core/log_http     # expect: False, or (unset)
npm run gcp:ops:infra:check               # expect: every test passes, 0 fail
```

Stop if the tree is dirty, the gate fails, gcloud has no active account, or
`core/log_http` prints `True`. In that last case, ask the owner to turn the
property off (`gcloud config unset core/log_http`). The secrets tool turns
HTTP logging off for each of its own calls regardless, but other commands
in this runbook would still log their HTTP traffic.

Step 6 needs the owner's explicit confirmation of the project-wide custom
role. To avoid stopping mid-run, you may ask for it now, with the step 1
plan in hand.

## 1. Plan (read-only)

```bash
node scripts/gcp-infra.mjs plan --environment=staging > "$SCRATCH/staging-plan-0.json"; echo "exit=$?"
```

Expected: `exit=2` (blockers). In the JSON: `"environment": "staging"`,
`"project": "tibotattle"`, `summary.refused` 0, `findings` and `blockers`
both exactly `["BUCKET_ABSENT", "BUCKET_PROOF_UNPINNED"]`. Executable
operations create the six `tibotattle-staging-*` service accounts and their
project roles, the custom role, the `tibotattle-staging-images` repository,
seven `tibotattle-staging-*` secrets and their accessor bindings, the
`tibotattle-staging-primary` instance, database and IAM users, and the
verifier grant. The verifier grant is one `iam service-accounts
add-iam-policy-binding` of `roles/iam.serviceAccountTokenCreator` on
`tibotattle-staging-verifier` for the operator that
`serviceAccounts.verifier.tokenCreators` names. The owner named that operator
in round 9, and `d86f9155` committed it. Deferred: the service and its two
invoker bindings (`SERVICE_RENDER_BUCKET_PROOF_UNPINNED`; the owner's Access
AUD is committed), the three jobs and the scheduler's executor bindings
(`BOOTSTRAP_IMAGE_REQUIRED`), the refresh trigger (`SCHEDULER_CADENCE_UNSET`)
and the maintenance trigger (`BUCKET_PROOF_UNPINNED`). The verifier grant is
not deferred.

Stop, and do not continue, if any of these holds:

- exit 1, or `summary.refused` above 0 (a delete, destructive change or
  bucket update);
- any operation argv names `tibotattle-test`, the OAuth gateway, `_Default`
  or a resource without `staging` in its name, other than the custom role;
- the custom role is planned as anything but `custom-role:create`. Its id
  `tibotattleQuarantineStore` is project-wide and not staging-named: an
  update or destructive entry means a co-tenant already owns that id. Ask
  the owner before going on. A plain create is expected here, but it still
  needs the owner's confirmation before the first apply (step 6);
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

Expected: exit 0, `"status": "provisioned"`, `"envelopePairReissued": false`,
seven entries each with `"container": "created"`, `"outcome": "added"`,
`"version": "1"`, and `pinned.changed: true` with all seven variables at `"1"`.

Stop conditions:

- Any entry reads `already_provisioned` on this first run: someone else made
  that `tibotattle-staging-*` secret. Do not pin it; ask the owner.
- `STAGING_ENVELOPE_PAIR_PARTIAL` (the envelope pair needs reissuing, but a
  key is already pinned) or `STAGING_SECRET_VERSIONS_UNUSABLE:<VAR>` (every
  version of a secret is disabled or destroyed): someone changed the state by
  hand. Stop and ask. Never disable, destroy or delete a version by hand.
- `STAGING_SECRETS_REPORT_PATH_UNAVAILABLE`: nothing was called. The
  `--report-out` path already exists (a finished run's report, or the empty
  reservation of a run that was killed). Rerun with a fresh path.
- `STAGING_SECRETS_AUTHORIZATION_MISMATCH`: the ids changed; rerun the dry
  run and review why.

Exit 1 with `outcomes` in the error means some containers or versions were
made. The report file was released, so the rerun can use the same path.
Pins are written only after all seven secrets are provisioned. Read the code
and fix the cause, then rerun the same command, with the same
`--report-out`. The rerun skips every secret that already has an ENABLED
version, and a pin already in place is left as it is. On the rerun:

- `already_provisioned` is expected for the secrets that the failed run
  reported as `added`. The failed run may also have reported an add as
  `pending` when gcloud timed out after Secret Manager kept the version.
  That entry can also read `already_provisioned`. Any other
  `already_provisioned` is a stop, as above.
- The envelope pair is one unit. Suppose the failed run did not add
  `ENVELOPE_PRIVATE_JWK`, but Secret Manager kept a version of
  `ENVELOPE_PUBLIC_JWK`: reported as `added`, or as `pending` after a
  timeout. Then the rerun prints `"envelopePairReissued": true`. It adds a
  version of a fresh pair to both keys, so `ENVELOPE_PUBLIC_JWK` is pinned
  at `"2"` (or higher) and `ENVELOPE_PRIVATE_JWK` at `"1"`. The public
  version from the failed run stays ENABLED but unpinned. Nothing reads it;
  leave it alone. `envelopePairReissued: true` in any other situation is a
  stop.

## 3. Review the version pins

```bash
git diff -- cloud-run/infra/staging.desired-state.json
```

Expected: exactly seven changed lines, each `"version": null` becoming
the version the step 2 report pinned: `"1"` for all seven on a clean run,
and a higher `ENVELOPE_PUBLIC_JWK` version after a reissue. Stop on any
other change.

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

After the insert, stderr always carries `"bucketInserted": true` with
`receiptWritten` and `receiptPrinted`, which say where the proof is. Never
rerun `--apply` in any of these cases:

- `"receiptWritten": true`: the bucket and receipt exist, and only the pin
  failed. Fix the cause, then run
  `node scripts/gcp-staging-bucket-birth.mjs --environment=staging --pin-only`.
- `"receiptPrinted": true`, with stdout `"status": "created_receipt_unwritten"`:
  the bucket exists and the receipt is only on stdout. Save that `receipt`
  object, unchanged, as `cloud-run/infra/staging.bucket-birth.receipt.json`,
  then run `--pin-only`, which verifies the receipt before pinning.
- `"receiptWritten": false, "receiptPrinted": false`, and nothing on stdout:
  the bucket was born, but no receipt exists. Examples are
  `BUCKET_BIRTH_READBACK_MISSING`, `BUCKET_BIRTH_RESPONSE_INVALID` and
  `BUCKET_BIRTH_READBACK_MISMATCH`. A mismatch also carries
  `differingFields`: the names, never the values, of the snapshot fields
  that differ, or `readbackMetagenerationNotOne` when both responses agree
  on a metageneration other than `"1"`. The
  proof cannot be recovered with this tooling: `--pin-only` refuses with
  `STAGING_BUCKET_BIRTH_RECEIPT_MISSING`. **Stop and ask the owner.** Never
  write a receipt by hand and never adopt the bucket.

Any other error, without `bucketInserted`, means that no insert is known to
have succeeded, and the receipt reservation was released. Fix the cause and
rerun `--apply`. If the insert request timed out (`BUCKET_BIRTH_REQUEST_FAILED`),
the bucket may still have been made. The rerun's listing then refuses with
`BUCKET_BIRTH_BUCKET_EXISTS`, which is the first stop above.

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

## 6. Owner confirmation: the project-wide custom role

**Stop here unless the owner has confirmed this in chat.** The approval
covers "new staging-named resources only, including their IAM bindings". The
first apply also creates the custom role `tibotattleQuarantineStore`
(`custom-role:create`). The role is project-wide in the shared project, and
C-INFRA pins its id (`QUARANTINE_STORE_ROLE_ID`), so it cannot carry a
staging name. OPS-2 applies the authorized plan whole, so the role cannot be
left out of that plan. Ask the owner, naming the role id, its project
(`tibotattle`) and its five `storage.*` permissions. Continue only on an
explicit yes. Record the confirmation, with the time, in the session notes.

If the owner declines, or wants a staging-named role instead, the approved
work ends at step 5. A staging-named role is a C-INFRA change (a
per-environment role id), not a step of this runbook.

## 7. Apply, pass 1 (no image)

```bash
node scripts/gcp-infra.mjs plan --environment=staging > "$SCRATCH/staging-plan-1.json"; echo "exit=$?"
node -e 'const p=require(process.argv[1]);console.log(p.planDigest, JSON.stringify(p.summary), JSON.stringify(p.findings), JSON.stringify(p.blockers))' "$SCRATCH/staging-plan-1.json"
node scripts/gcp-infra.mjs apply --environment=staging --authorize=<planDigest> > "$SCRATCH/staging-apply-1.json"; echo "exit=$?"
```

Before you authorize: step 6's confirmation is recorded, and the plan's
only non-staging-named entry is `custom-role:create` for
`tibotattleQuarantineStore`.

Expected plan: exit 0, no findings or blockers, `summary.refused` 0. With
the secrets and bucket already made, the first plan has 27 executable
operations and 9 deferred (round 12 retired the Google and Apple sign-in
secrets from CR-3, and with them their two accessor bindings).

- Executable: the accounts, roles, repository, accessor bindings, Cloud SQL,
  the verifier grant from step 1, and the maintenance trigger's create and
  pause (D-OPS4: apply creates a trigger and pauses it in the same apply).
- Deferred: the service and its two invoker bindings, the three jobs, and
  the scheduler's executor bindings on both jobs, all on
  `BOOTSTRAP_IMAGE_REQUIRED`; the refresh trigger on
  `SCHEDULER_CADENCE_UNSET`.

The staging maintenance job renders the `staging-maintenance-job` profile
from the `stagingOrigin` block, as the service does (STAGING-MAINT-RENDER),
so it is no longer an environment deferral. The in-memory rehearsal of this
pass is the last test of `scripts/gcp-ops-infra-staging-service.check.mjs`:
its pass 2 creates the service and its two invoker bindings, the three jobs
and the scheduler's executor binding on the maintenance job, and the plan
after it is clean.

A rerun after a partial pass 1 plans only what is still missing. Cloud SQL
IAM users are created under their PostgreSQL user names, for example
`tibotattle-staging-runtime@tibotattle.iam`. Cloud SQL refuses the full
`.gserviceaccount.com` email. If any `cloud-sql-user:create` argv ends with
`.gserviceaccount.com`, stop: that checkout lacks `73b38784`.

Expected apply: exit 0 and an apply receipt listing each operation's
outcome. Cloud SQL creation takes several minutes.

Stop conditions: every plan stop condition of step 1; apply exit 1 (its
stderr lists the operations that ran; re-plan, read the readback, and only
then decide whether a fresh plan and apply is safe); `APPLY_PLAN_DIGEST_MISMATCH`
(the estate moved between plan and apply: re-plan, re-read, re-authorize).

## 8. Readback

```bash
node scripts/gcp-infra.mjs readback --environment=staging > "$SCRATCH/staging-readback-1.json"; echo "exit=$?"
node scripts/gcp-infra.mjs readback --environment=staging --require-clean > "$SCRATCH/staging-clean-1.json"; echo "exit=$?"
```

Expected: the first exits 0 with no finding. After pass 1 alone, the second
exits 2 with `"clean": false`; its reasons are the service, job and
executor-binding deferrals listed in step 7. After pass 2 (the gated tail)
it exits 0 with `"clean": true`: the refresh trigger's and its grant's
`SCHEDULER_CADENCE_UNSET` is a clean deferral (`CLEAN_DEFERRALS`), so it is
not a reason.
This is the first owner-run readback of the test project (OPS2-READ): check
that the service-account policy, the scheduler listing and the custom role
parsed, and keep the files as evidence (they are content-free).

Approved work ends here unless the gates below are cleared.

## The gated tail

Each step below needs its gate first. Commands are those on the final line
at STG-PREP's base; take exact flags from the line you run.

| Step | Gate |
|---|---|
| Done: name the verifier's operator in `serviceAccounts.verifier.tokenCreators` | Cleared. The owner named the operator in round 9 ("Staging verifier operator"), and `d86f9155` committed it to the staging file. The grant is now an executable operation in steps 1 and 7, not a deferral. With the operator named, OPS-10 accepts the committed staging rollout target, so `ROLLOUT_TARGET_VERIFIER_TOKEN_CREATOR_UNASSIGNED` no longer applies (`17f3a78e`) |
| Done: set `stagingOrigin.accessAud` to the staging admin Access application's AUD tag, commit | Cleared. The owner created the Access application on `admin.staging.tibotattle.com` (Google IdP, an allow policy for the owner's email only) and supplied its AUD tag on 2026-10-03; it is committed in the staging file (it is not a secret). The service and the maintenance job now wait only for the image |
| Bootstrap image: `node scripts/gcp-production-rollout.mjs build --environment=staging --commit=<commit> --authorize=build:staging:<commit> --execute` | The verifier grant applied in pass 1 (step 7), and the staging lock. Every OPS-10 mutating verb (`build`, `migrate`, `roll`) for staging takes the staging coordination lock by pushing `refs/heads/codex/staging-deployment-lock` to GitHub, and never takes or reads the production lock `refs/heads/codex/production-deployment-lock` (`scripts/production-deployment-lock.mjs`, closed mapping `DEPLOYMENT_LOCK_REFS`). The owner authorized pushes of that one staging ref on 2026-10-02 (round 9, "Deploy lock"); no other push is authorized. First run the same command without `--authorize` and `--execute`: stop unless its `lockRef` reads exactly `refs/heads/codex/staging-deployment-lock`. A dry run with no `lockRef` comes from a checkout without STG-LOCK, which would take the production lock: stop. A held or uncertain staging lock (`STAGING_COORDINATION_*`) is a stop; so is `ROLLOUT_LOCK_REF_MISMATCH` or `DEPLOYMENT_COORDINATION_*` |
| Apply, pass 2: `plan --environment=staging --bootstrap-image-digest=<digest> --bootstrap-source-commit=<commit>`, then `apply` with the same bootstrap flags and the new plan digest. Creates the service and its invoker bindings, the migration, refresh and maintenance jobs, and the scheduler's executor grant on the maintenance job (its trigger was created and paused in pass 1) | The image. The refresh trigger stays absent until the owner sets the cadence (D3), and the scheduler account's `roles/run.jobsExecutor` grant on the refresh job waits with it (`SCHEDULER_CADENCE_UNSET`). The maintenance trigger stays PAUSED: apply never resumes a trigger |
| The service | Cleared for its composition: D-CRB composes `HOST_MODE=staging`, and the `STAGING_HOST_COMPOSITION_PENDING` gate was removed with its check when D-CRB and STG-PREP met on the fast-path final line. The service waits only for the image |
| The staging maintenance job | Cleared offline (STAGING-MAINT-RENDER). The render reads the `stagingOrigin` block and the inert identity identifiers, as the service does, and runs `--profile=staging-maintenance-job` with only `IDENTITY_LINK_SECRET`; CR-3's staging-maintenance-job profile accepts the render in `gcp-ops-infra-staging-service.check.mjs`. The staging rollout target now names the job, so OPS-10's origin-verifier roll can run its lifecycle pass. No live staging job has run yet |
| Backup audit: `node scripts/gcp-backup-horizon.mjs audit --environment=staging --project=tibotattle --primary-instance=tibotattle-staging-primary --region=us-east1` | Read-only; exit 0 or 2 is usable, 3 is a breach |
| Migrate: `node scripts/gcp-production-rollout.mjs migrate --environment=staging --commit=<commit> --digest=<digest> --backup-audit=<file> --migrate-receipt=<new file> --authorize=migrate:staging:<digest> --execute` | A clean readback (needs pass 2: the service, the verifier grant and the staging maintenance job), the staging lock as for the bootstrap image (the dry run's `lockRef` is `refs/heads/codex/staging-deployment-lock`), and quiescence: OPS-10 counts every Cloud Run job trigger in `us-east1`, so a running test-estate trigger refuses it |
| Roll: `gcp-production-rollout.mjs capture-edge --environment=staging --inventory=<file> --inventory-sha256=<sha256> --output=<new file> --execute`, then within 15 minutes `gcp-production-rollout.mjs roll ... --edge-live=<that file>` | A migrate receipt and a fresh capture of the staging edge Worker `app-usagemonitor-staging-edge` on `staging.tibotattle.com` and `admin.staging.tibotattle.com` (pinned in the rollout; `wrangler.jsonc`'s workers.dev `env.staging` is no longer the staging edge). The inventory is the staging-edge driver's private inventory of that Worker, and `CLOUDFLARE_API_TOKEN` is set. `capture-edge` is built and tested locally only; it has not read the live staging edge. In `gcp` mode the roll also requires the edge's `EDGE_UPSTREAM_ORIGIN` to equal the service's `HOST_ORIGIN`, which is the service's own `run.app` origin, not `https://staging.tibotattle.com` (the service's `PUBLIC_ORIGIN`) |

## Backup-restore rehearsal (E-OPS7)

`scripts/gcp-backup-restore-rehearsal.mjs` restores the staging primary
`tibotattle-staging-primary` into ONE new scratch instance, verifies the copy
and deletes the scratch. It is built and checked offline only (fake gcloud,
fake database); nothing here has run against a live instance. The first live
run is its qualification.

**Authorization.** The rehearsal creates and then deletes
`tibotattle-staging-primary-rehearsal-<id>` (`...-<id>b` for the backup path).
The owner's staging approval covers new staging-named resources, but deleting
one is a separate decision ([below](#if-something-must-be-undone)). Before
`--apply`, ask the owner to approve the create-and-delete of that one scratch
instance, naming the path and the recovery point.

**What it does.** Two paths:

- `--path=pitr`: `gcloud sql instances clone` at `--point-in-time`, then a
  label patch (`tibotattle-purpose=restore-rehearsal`,
  `tibotattle-rehearsal=<id>`). `--point-in-time=after-preflight` makes the
  tool choose the point itself, a minute after its first read of the source,
  and wait until that point is a minute old before cloning.
- `--path=backup`: `gcloud sql instances create` (the plane's posture, no
  deletion protection, no automated backups, labelled), then
  `gcloud sql backups restore <id> --restore-instance=<scratch>
  --backup-instance=tibotattle-staging-primary`.

Every mutation is submitted with `--async`, and the tool polls
`gcloud sql operations describe` until the operation is `DONE`, up to an
explicit bound per step: clone and restore 6 hours, create and delete 1 hour,
each patch 30 minutes. It never relies on gcloud's own wait. In SDK 569.0.0
that wait gives up after 600 seconds for clone, restore, patch and delete,
while the operation carries on.

It then waits for `RUNNABLE` and opens read-only sessions on the scratch and
the source (`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, in sessions that
default to read-only). It compares:

- the migration history;
- the schema shape (columns, indexes, constraints, functions);
- every table's exact row count;
- a keyed digest of the first and last N rows of every table, by primary key,
  or by row text when a table has none.

The digest key is random per run and never printed, so the receipt says only
`equal` or `differs`.

**The verdict.** The source is read before the restore and again after the
scratch is verified. Each read includes a write watermark: the schema's
cumulative insert, update and delete counters, the statistics reset time and
the server start time. Reads do not move it; any row write does.

| Verdict | When | `verification.code` |
|---|---|---|
| `passed` | Scratch equals source, source unchanged during the run | `null` |
| `inconclusive` | The source moved during the run, by data or by watermark | `RESTORE_SOURCE_MOVED_DURING_RUN` |
| `inconclusive` | Scratch differs, but the source is not shown unchanged since the recovery point, so the difference may be a write after it | `RESTORE_SOURCE_UNCHANGED_SINCE_RECOVERY_POINT_UNPROVEN` |
| `failed` | Scratch differs, and the source is shown unchanged since the recovery point | `RESTORE_SCRATCH_DIFFERS_FROM_SOURCE` |
| `inconclusive` | A table could not be compared safely | `RESTORE_VERIFICATION_INCOMPLETE` |

The source is shown unchanged since the recovery point only with
`--point-in-time=after-preflight`: the point is after the first source read,
and the closing read, taken at least two minutes after the point so recent
writes have reached the statistics, matches it. The backup path can never show
it, because the backup predates the run. There, and with an explicit point in
time, any staging write after the recovery point makes the scratch differ, and
the verdict is `inconclusive`, never `failed`. The watermark covers row writes,
not schema changes, so no migration may run during a rehearsal.

**Ownership and teardown.** The scratch name must be free at preflight. Cloud
SQL refuses a create or clone whose name exists, so an accepted create or clone
proves the scratch is this run's. Only then is teardown armed. If the create or
clone is refused, fails, or returns no operation, the tool deletes nothing. It
reports `teardown.armed: false` and `teardown.scratchPresent`. Another run may
hold the name, or gcloud may have failed after sending.

An armed teardown first waits, for up to 1 hour, until the scratch is out of
`PENDING_CREATE` or maintenance and no operation on it is unfinished, because
Cloud SQL refuses a patch while another operation runs. A clone that outlasted
its bound is waited out here. It then patches the scratch to no deletion
protection, no final backup and no retain-on-delete, and reads that back. If
any of the three is still on, it refuses to delete, because a final backup
would keep a restorable copy. Otherwise it deletes the scratch and checks that
no instance or backup of it is left. A scratch still busy after an hour is
left, with `RESTORE_REHEARSAL_SCRATCH_BUSY`, for cleanup.

The source is only read. The gcloud guard allows a closed set of command
shapes. Every mutation is `--async` and names the scratch as its target; the
source appears only as the clone source or the backup's instance. An operation
may be described only after a mutation of this run returned it, and operations
may be listed only for the scratch.

**The do-not-restore step.** The reapply step is an injected interface with no
default list, because custody of the list is open (OA-9, decided after
cutover). The CLI injects none, so every CLI receipt reads
`"uploadsMayReopen": false` with `DO_NOT_RESTORE_STEP_NOT_PROVIDED` in
`uploadsBlockedBy`. That is the expected result, not a failure. A receipt reads
`true` only when the verification passed, the history equals this checkout's
manifest, and an injected step returned an exact `done` result.

**Preconditions.**

- The gate passes: `npm run gcp:ops:infra:check`.
- The staging database holds the migrated schema `tibotattle_staging` with its
  `_tibotattle_migration_history`. If it does not, preflight refuses with
  `RESTORE_REHEARSAL_SCHEMA_ABSENT` or `RESTORE_REHEARSAL_SOURCE_HISTORY_ABSENT`
  before creating anything.
- The operator can mint tokens for `tibotattle-staging-migrator`
  (`roles/iam.serviceAccountTokenCreator` on that account). The desired state
  grants that role on the verifier account only. Check it with a read
  (`gcloud iam service-accounts get-iam-policy`). If the grant is missing, ask
  the owner: adding it is an IAM change outside the committed desired state.
- Nothing writes to staging during the run, and no migration runs (the
  scheduler trigger paused, admission closed). `sql instances describe` does
  not report a last-write time, so prefer `--point-in-time=after-preflight`,
  which needs no such time. For the backup path, staging must also have had no
  writes since the backup's `endTime`, and the tool cannot check that: a
  difference there reads `inconclusive`.

**Commands** (from `apps/worker`; `SCRATCH` is the session scratchpad):

```bash
node scripts/gcp-backup-restore-rehearsal.mjs rehearse --environment=staging \
  --path=pitr --point-in-time=after-preflight
```

The dry run makes no call. It prints the exact calls, the operation bounds,
the `scratch` name and the `authorization`, and `"rehearsalIdGenerated": true`
when it chose the id. Rerun it with `--rehearsal-id=<that id>` and the same
flags, check that the authorization is unchanged, then apply:

```bash
node scripts/gcp-backup-restore-rehearsal.mjs rehearse --environment=staging \
  --path=pitr --point-in-time=after-preflight --rehearsal-id=<id> --apply \
  --authorize=<the dry run's authorization> \
  --receipt-out="$SCRATCH/restore-rehearsal-<id>.json"; echo "exit=$?"
```

An explicit `--point-in-time=<RFC 3339 UTC, at least 1 minute ago, within 7
days>` also works, but then a difference reads `inconclusive`. For the backup
path, take a backup run id from
`gcloud sql backups list --instance=tibotattle-staging-primary --project=tibotattle --format=json`
(read-only), and pass `--path=backup --backup-id=<id>` in place of the point
in time.

| Exit | Meaning |
|---|---|
| 0 | Verified, at the image tail, the injected step done, scratch deleted. The CLI cannot reach it until OA-9 |
| 2 | Verified and scratch deleted; uploads may not reopen (`uploadsBlockedBy`). Expected: `DO_NOT_RESTORE_STEP_NOT_PROVIDED`, plus `RESTORE_MIGRATION_BEHIND` if staging is behind this checkout |
| 3 | Verification `failed` or `inconclusive`; scratch deleted. Read `verification.code`, `verification.tables` and `recoveryPoint.coveredBySourceReads` |
| 1 | Refused or failed. Read `code`, and `receipt.teardown` when present |

Keep the receipt; it is content-free (names, counts, timings, booleans). The
timings are `pointInTimeWaitMs`, `cloneMs` and `labelMs` (or `createMs` and
`restoreBackupMs`), each to its operation's end; `readyMs` (first mutation to a
database session on the scratch); `verifyMs`; `teardownMs`; and `totalMs`.

**Stop conditions.**

- `RESTORE_REHEARSAL_SCRATCH_EXISTS`: that scratch name is taken. Pick a new
  id; never reuse an instance.
- Exit 1 with `receipt.teardown.armed: false` and `scratchPresent: true`
  (`RESTORE_REHEARSAL_SCRATCH_OWNERSHIP_UNPROVEN`): the create or clone was
  not accepted, or its operation failed, yet an instance carries the name. The
  tool did not touch it. Another rehearsal may hold it; check that none is
  running before any cleanup. `scratchPresent: null` means the listing could
  not be read: list it by hand, read-only.
- Exit 1 with `receipt.teardown.armed: true` and `scratchDeleted: false`: the
  scratch still exists. `RESTORE_REHEARSAL_SCRATCH_BUSY` means an operation on
  it was still running after the settle bound. `RESTORE_REHEARSAL_TEARDOWN_SETTINGS_UNSAFE`
  means its deletion protection or final backup did not turn off, so the tool
  did not delete it. Never delete it by hand with a final backup. Run the
  cleanup dry run, then the cleanup with its authorization:

  ```bash
  node scripts/gcp-backup-restore-rehearsal.mjs cleanup --environment=staging --path=pitr --rehearsal-id=<id>
  node scripts/gcp-backup-restore-rehearsal.mjs cleanup --environment=staging --path=pitr --rehearsal-id=<id> \
    --apply --authorize=restore-rehearsal-cleanup:staging:tibotattle-staging-primary-rehearsal-<id>
  ```

  Cleanup deletes only an instance labelled for that rehearsal id; otherwise it
  refuses with `RESTORE_REHEARSAL_SCRATCH_NOT_OWNED`, before waiting or
  mutating. Like the run, it waits up to an hour for the scratch to settle
  before patching it; `RESTORE_REHEARSAL_SCRATCH_BUSY` means rerun it later.
- A PITR clone whose label step never ran (its clone outlasted the bound, or
  its submission failed after sending) carries no rehearsal labels, so plain
  cleanup refuses it. If the receipt shows the clone was this rehearsal's
  (`steps` has no `label`, or the teardown code above), and no other
  rehearsal with this id is running, adopt it with its own authorization:

  ```bash
  node scripts/gcp-backup-restore-rehearsal.mjs cleanup --environment=staging --path=pitr --rehearsal-id=<id> --adopt-unlabelled
  node scripts/gcp-backup-restore-rehearsal.mjs cleanup --environment=staging --path=pitr --rehearsal-id=<id> \
    --adopt-unlabelled --apply \
    --authorize=restore-rehearsal-cleanup-adopt-unlabelled:staging:tibotattle-staging-primary-rehearsal-<id>
  ```

  Adoption deletes the exact scratch name only when it carries no rehearsal
  labels or this rehearsal's. It refuses any other rehearsal labels, and it
  refuses the backup path, whose scratch is labelled when created. If it
  refuses, stop and ask the owner.
- `RESTORE_REHEARSAL_SCRATCH_BACKUP_REMAINS`: a backup of the deleted scratch
  is listed. The tool never deletes backups; ask the owner.
- `teardown.finalBackups: "unavailable"`: the backup listing could not be
  read. Check it by hand, read-only, before calling the run clean.

Production is refused. `--environment=production` needs `--production` and a
filled production desired state (OWN-5), and even then it only prints a
`plan_only` document with no authorization. The production dress rehearsal is
a separate, owner-authorized step.

## If something must be undone

The plane tooling never deletes, except that the restore rehearsal deletes the
scratch instance it created (and nothing else). Removing a staging resource is a separate,
explicit decision: list exact targets, check they are staging-named and
were made by this run, and ask the owner first. Cloud SQL has deletion
protection on. A secret version is never destroyed to "retry"; a rerun adds
only what is missing.
