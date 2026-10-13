---
title: GCP origin rollout
date: 2026-10-02
type: runbook
status: draft
---

# GCP origin rollout

> **Draft. Not operational.** This draft covers moving the Google Cloud origin
> to a new image: preflight, build, then migrate and roll (OPS-10), with the
> accepted write outage on each migration and an explicit scheduler pause and
> resume around it. The OPS-10 verbs exist on the line as dry-run-capable
> tooling, tested locally with synthetic data and never run against a live
> project. The scheduler pause and resume tooling does not exist yet, so those
> steps are manual. Nothing here authorizes a build, a migration, a roll, a
> scheduler change or an edge deploy; each is a separate owner-authorized
> operation. Tooling markers (`built`, `in build`, `not built`, `owner`) are
> defined in [GCP cutover window](./gcp-cutover-window.md#tooling-markers).

The origin is one Cloud Run service plus its Cloud Run Jobs, on one image
digest and one source commit, over one Cloud SQL PostgreSQL 17 instance. A
rollout moves all of them together, after the schema is at the new tail.

Related: [GCP cutover window](./gcp-cutover-window.md) (the origin is
pre-staged by this runbook before the window),
[GCP scheduler resume](./gcp-scheduler-resume.md),
[GCP brake and incidents](./gcp-brake-and-incidents.md), and the
[infrastructure desired state](../../apps/worker/cloud-run/infra/README.md).

## Status and claim boundary

- **Basis.** The fast-path line `claude/gcp-fastpath-final` at `c80f99b9` and
  the owner decisions of 2026-10-02. The authority for flags and refusal codes
  is [`gcp-production-rollout.mjs`](../../apps/worker/scripts/gcp-production-rollout.mjs)
  on the line that carries the rollout; take exact flags from it.
- **Verified from source.** The four verbs, their authorization tokens, their
  receipts and clocks, the quiescence rule, the contract-blob rule and the
  served-commit check.
- **Not verified.** No live `gcloud` output has been parsed (the first
  owner-run OPS-2 readback is open). Migration durations, the length of the
  write outage and the image build time are unmeasured.
- **Decisions encoded.**
  - Accept a short write outage on each migration. The write-path storage-gate
    time-to-live is 0. Revisit after the cutover.
  - One pre-migration backup plus point-in-time recovery. The code still takes
    two until the backup-count item lands (see [open gaps](#open-gaps)).
  - The scheduler is resumed only explicitly. The rollout never pauses or
    resumes a trigger.
  - The desired state is committed to the repository: non-secret identifiers
    only, secrets named by their Secret Manager id.
  - Forward only. There is no schema downgrade and no image rollback after a
    migration has applied.

## The accepted write outage

`migrate` applies the schema to the single instance while the previous revision
keeps serving. The only receipt fence the host has today requires the migration
history to equal its image's manifest exactly. So from the moment `migrate`
applies its first migration until `roll` moves the service, the previous
revision answers its storage-gated routes with 503. Reviewed expand-only
classification (the `CONTRACT_MIGRATIONS` review) covers the SQL the previous
revision issues, not that fence. The owner accepted the short outage on each
migration and will revisit it after the cutover. The roll receipt records
`secondsSinceMigrate`, the length of the window.

What follows from the decision:

- Run `roll` immediately after `migrate`. The window is the gap between them.
- Do not brake for an ordinary migration. Clients that get a 503 retry.
- Tell the owner before a migration, not after. Do not run one during the
  cutover window or while a refresh is expected to finish.
- A migration that changes the edge-origin contract has no in-place path; see
  [contract changes](#contract-changes).

## Preconditions

| Gate | Source | Must be true |
|---|---|---|
| Clean checkout | `preflight` | The working tree is clean and `HEAD` equals `--commit` (`ROLLOUT_TREE_DIRTY`, `ROLLOUT_COMMIT_NOT_CHECKED_OUT`) |
| Local gates green | Operator | `npm run gcp:production-tooling:local-check` from `apps/worker` passes on the commit, with the local PostgreSQL 17 cluster |
| Estate clean | `preflight` | `node scripts/gcp-infra.mjs readback --require-clean --environment=<env>` exits 0. A paused trigger whose committed state is `ENABLED` is a clean deferral, and so is an unset refresh cadence (the rollout comes before the measurement that decides it); the cutover's scheduler gate adds `--require-cadence` ([cutover window](./gcp-cutover-window.md)) |
| Backup audit | Operator | A receipt from `node scripts/gcp-backup-horizon.mjs audit` is at most 6 hours old and is not a breach (exit 3 blocks) |
| Identity-link rotation (production) | Operator | `node scripts/gcp-identity-link-pin-check.mjs --environment=production --pin-file=<sealed D1 pin> --rotation-file=<identity-rotation.json>` reads `match` for the `IDENTITY_LINK_SECRET` version the desired state pins (`docs/runbooks/gcp-production-apply.md`, step 10): the D1 pin is the round-16 rotation's source and the mounted value its target under `production-v2`. Procedural: `preflight` does not run it. Without `--rotation-file`, a rotated mount never reads `match` against the D1 pin (exit 2) |
| Schema reviewed | `migrate` | The migrations are expand-compatible or reviewed in `CONTRACT_MIGRATIONS`, and the append-only residue migration is present (`PRODUCTION_SIMP_RESIDUE_MISSING` until it lands) |
| Jobs quiescent | `migrate`, `roll` | Every Cloud Scheduler trigger of a Cloud Run job in the location is paused, and nothing is running (`ROLLOUT_JOBS_NOT_PAUSED`, `ROLLOUT_JOBS_RUNNING`) |
| Lifecycle pass | `roll` | Whenever the live edge is not in `gcp` mode, `roll` checks the served commit through the verifier path, which needs `/api/ready` to read `ready`, and readiness needs a completed maintenance pass under 2 hours old. `roll` runs that pass itself: one execution of the target's maintenance job after it moves and reads back the service and jobs and before it checks the served commit (`ROLLOUT_MAINTENANCE_PASS_FAILED` unless exactly one execution succeeds; D-CRB). A target without a maintenance job (staging, which cannot deploy it yet) is refused before any write outside `gcp` mode (`ROLLOUT_MAINTENANCE_JOB_REQUIRED`). This covers every pre-switch rollout, the pre-staging one included, and every rollout while the edge is braked to `fenced` |
| Reprice Job present | `preflight` | The reprice Job (`jobs.analytics-reprice`) is in the committed desired state and the rollout target, so the clean-estate readback refuses until an owner-applied OPS-2 plan has created it with a bootstrap image that carries `dist/analytics-reprice.mjs` ([infrastructure README](../../apps/worker/cloud-run/infra/README.md#reprice-job-ops-reprice)). Create it before the first migrate or roll from a commit that declares it |
| Edge capture | `roll` | A verified capture of the live edge, at most 15 minutes old, for this environment |
| Contract blob | `roll` | If the live edge is in gcp mode, `apps/worker/src/edge-origin-contract.ts` has the same Git blob at `--commit` and at the live edge's commit (`EDGE_CONTRACT_DRIFT`), and the edge points at this service |
| Lock | Every mutating verb | The environment's own coordination lock is free. Production takes the shared production deployment lock, `refs/heads/codex/production-deployment-lock`; staging takes only `refs/heads/codex/staging-deployment-lock` and never the production lock (owner decision 2026-10-02, round 9). The mapping is closed, and a dry run prints the exact ref as `lockRef` |
| Authorization | Owner | Authorized in chat for this verb, this environment and this digest or commit |

The Jobs gate recognizes a single explicit Cloud Run `Completed=True` or
`Completed=False` condition as terminal; the latter is a failed execution, not
success. A pre-start failure may omit the optional completion timestamp.
Unknown, absent, malformed or contradictory terminal evidence keeps the gate
closed, as does a nonzero or unrecognized running-task count. See the
[Cloud Run execution contract](https://docs.cloud.google.com/run/docs/reference/rest/v1/namespaces.executions).

Staging notes. The staging plane lives in the shared test project, and the
rollout's quiescence check counts every job trigger in the location, so a
running test-estate trigger there refuses a staging migrate or roll. For the
dress rehearsal on production data, use a disposable database on the primary
instance. A disposable second Cloud SQL instance in the production project
makes the readback report `CLOUD_SQL_SECOND_INSTANCE`, plans a delete that
apply refuses, and keeps the estate unclean until it is deleted.

## Sequence

All commands run from `apps/worker`. Dry runs (no `--execute`) validate inputs
and print the argv; they run no `gcloud` and make no request.

1. **Choose and gate the commit.** Record the commit and run the local gates.
   `built`.
2. **Capture the inputs.**
   - The backup audit receipt:
     `node scripts/gcp-backup-horizon.mjs audit --environment=<env> --project=<project> --primary-instance=<instance>`,
     saved to an owner-private file. `built`.
   - The live edge capture, schema `tibotattle-edge-live-capture-v1`, at most
     15 minutes before `roll`. `capture-edge` writes it, read-only against
     Cloudflare (no lock, no `gcloud`, no write), with `CLOUDFLARE_API_TOKEN`
     in the environment as for the production deploy:

     ```bash
     node scripts/gcp-production-rollout.mjs capture-edge --environment=<env> \
       --inventory=<absolute path of the owner-private Cloudflare inventory> --inventory-sha256=<its sha256> \
       --output=<absolute new path outside the checkout> --execute
     ```

     The inventory is the private file the production deploy takes
     (`--inventory`, `--inventory-sha256`); it supplies the account id and must
     be of this environment's edge Worker. That Worker is `app-usagemonitor`
     on EP-9's three domains for production. For staging it is the
     staging-edge Worker `app-usagemonitor-staging-edge` on
     `staging.tibotattle.com` and `admin.staging.tibotattle.com`, never
     `wrangler.jsonc`'s workers.dev `env.staging`. The command verifies the
     capture exactly as `roll` will and writes nothing unless it verifies. It
     then writes the file once, mode 0600. It refuses an existing path or a
     symlink, and a parent directory that is inside any git checkout (a
     directory from it up to `/` holds a `.git` entry, which covers this
     checkout, the main checkout, other worktrees and `.git` itself) or that
     another user could write to (it must be the owner's and not group- or
     world-writable, unless it is a root-owned sticky directory such as
     `/tmp`). Once the file is open it checks the path again, so a parent
     swapped during the reads is refused. It prints only the mode, the
     edge commit, the capture time and the file's sha256. The file holds the
     account id and the Worker's binding values: keep it owner-private and
     never commit it. Without `--execute` it checks the arguments, the output
     path and the inventory, and makes no request. `built`: tested locally
     with a fake provider, never run against Cloudflare.
3. **Preflight, read-only.**

   ```bash
   node scripts/gcp-production-rollout.mjs preflight --environment=<env> --commit=<40-hex commit> \
     --backup-audit=<absolute path to the audit receipt> --execute
   ```

   It checks the tree, the infrastructure readback, the backup audit and the
   scheduled-jobs readback, and reports quiescent or not. `built`.
4. **Build.** `--authorize=build:<env>:<commit>`. Renders the production Cloud
   Build config, archives the audited source, submits it, and qualifies the
   result against the archive's own sha256, the build's identity, its steps and
   the image digest. Record the digest. The production Cloud Build is a
   protected operation. `owner`, `built`.

   The source is staged explicitly in the project's default Cloud Build
   bucket (BUILD-SOURCE, owner decision round 19), with
   `--gcs-source-staging-dir=gs://<project>_cloudbuild/source`. That is
   `tibotattle_cloudbuild` for staging and `tibotattle-prod_cloudbuild` for
   production, and the dry run prints it as `buildSource`. The builder reads
   the source through the one OPS-2 binding on that bucket,
   `roles/storage.objectViewer`; it holds no project storage role. Before the
   lock, `build` reads the bucket and its policy. It refuses with:

   - `ROLLOUT_BUILD_SOURCE_BUCKET_UNAVAILABLE` when the bucket is absent;
   - `ROLLOUT_BUILD_SOURCE_BUCKET_FOREIGN` when the bucket's project number is
     not the target's;
   - `ROLLOUT_BUILD_SOURCE_BUCKET_UNQUALIFIED` when there is no unconditional
     builder read or there is a public member.

   gcloud does not make these checks for an explicit staging directory. What
   to do depends on the refusal:

   - `UNAVAILABLE`, or `UNQUALIFIED` because the builder's binding is
     missing: plan and apply OPS-2 (it creates an absent bucket, then binds in
     the next pass), then retry. If OPS-2's `build-source-bucket:create` then
     fails, another project holds the name: stop and escalate to the owner.
   - `FOREIGN`, or `UNQUALIFIED` because the bucket has a public member: stop
     and escalate to the owner. OPS-2 cannot clear either: it binds nothing on
     a foreign bucket, and a public member blocks its apply
     (`BUILD_SOURCE_BUCKET_POLICY_PUBLIC_MEMBER`).

   The build is qualified only if its storage source is in that bucket under
   `source/`.

   Its options must be exactly the reviewed set: `CLOUD_LOGGING_ONLY` logging,
   `SHA256` source provenance and `VERIFIED`, plus, when Cloud Build reads them
   back, an empty `pool` and `workerRelease: legacy`. `legacy` (Docker Engine
   20.10, Debian 11) is Cloud Build's default worker host until 2027-03-28,
   when the default becomes the `regular`
   [release channel](https://docs.cloud.google.com/build/docs/release-channels).
   Any other worker release or option key fails `build` with
   `ROLLOUT_BUILD_PROVENANCE_UNQUALIFIED` after the image is pushed, and no
   digest is reported. Treat that image as unqualified until the new release
   or option is reviewed in `assessProductionBuild`.

   ```bash
   node scripts/gcp-production-rollout.mjs build --environment=<env> --commit=<commit> \
     --authorize=build:<env>:<commit> --execute
   ```

5. **Dry-run migrate and roll.** The same commands as steps 7 and 8 without
   `--execute`, with the digest. Read the printed argv.
6. **Record, pause and drain the triggers.** Pause the
   triggers of this plane's Cloud Run jobs, then wait for running executions to
   finish. Do not cancel a running refresh as part of this procedure; if one
   runs long, the owner decides whether to wait or to defer the rollout. The
   tooling is `not built` (OPS-3 `pause-all`); until it exists the owner does it
   by hand, each an authorized GCP write.

   - **Before pausing anything, record** for every trigger: its name, its live
     state (`gcloud scheduler jobs describe`), and its committed state in the
     environment's desired-state file. This record, not the roll receipt,
     decides what is resumed in steps 9 and 11.
   - Pause each trigger that is in this plane's desired state:

     ```bash
     gcloud scheduler jobs pause <trigger name> --location=<region> --project=<project>
     ```

   - The quiescence check counts every Cloud Scheduler trigger of any Cloud Run
     job in the location, not only this plane's. In the shared staging project
     that includes another estate's triggers. This procedure never pauses or
     resumes a trigger outside this plane's desired state: if one is not
     paused, `preflight` reports the estate as not quiescent and `migrate` and
     `roll` refuse `ROLLOUT_JOBS_NOT_PAUSED`, and the owner settles it with
     that estate's owner before going on.
   - Run `preflight` again and confirm it reports quiescent.
   - No maintenance pass by hand is needed for the roll: `roll` moves the
     maintenance job's image with the other jobs and then runs one pass itself,
     before its served-commit check (step 8). The maintenance job is `built`
     (C-MAINT) and is in the production rollout target and desired state
     (D-OPS4). A pass skips with `MIGRATION_IN_PROGRESS` while a migration runs.

   Record the paused list and the time in UTC. If the pause outlasts the
   scheduler probe's 6 hour threshold for a trigger whose committed state is
   `ENABLED`, the probe signals; that is expected, not an incident, as long as
   the resume is on the plan.
7. **Migrate.** `--authorize=migrate:<env>:<digest>`.

   ```bash
   node scripts/gcp-production-rollout.mjs migrate --environment=<env> --commit=<commit> --digest=<sha256:digest> \
     --backup-audit=<absolute path> --migrate-receipt=<new absolute path> \
     --authorize=migrate:<env>:<digest> --execute
   ```

   It runs preflight, requires quiescence, takes the pre-migration on-demand
   backup or backups (labelled with an expiry), reads the jobs again right
   before the DDL, moves the migration job to the digest and commit, executes
   it, reads its `tibotattle-gcp-migration-v1` receipt back from the
   execution's log, verifies it against the local manifest and writes the
   migrate receipt to a new file. The outage window opens here. `built`.
8. **Roll, immediately.** `--authorize=roll:<env>:<digest>`.

   ```bash
   node scripts/gcp-production-rollout.mjs roll --environment=<env> --commit=<commit> --digest=<sha256:digest> \
     --backup-audit=<absolute path> --migrate-receipt=<the receipt migrate wrote> \
     --edge-live=<absolute path of the edge capture> \
     --authorize=roll:<env>:<digest> --execute
   ```

   It requires a matching migrate receipt (at most 24 hours old), checks the
   edge capture's age and identity, re-checks quiescence, moves the service and every job in the
   infrastructure manifest to one digest and commit, and reads each back. It
   then runs one execution of the target's maintenance job (the lifecycle pass
   the new origin's `/api/ready` reads) and checks the served commit: public
   `GET /api/health` when the live edge
   is in gcp mode, otherwise the verifier path (`GET /api/health` and
   `GET /api/ready` as the verifier account). It prints the roll receipt,
   including `secondsSinceMigrate` and `pausedTriggers`. Keep it. The outage
   window closes here. `pausedTriggers` is every Cloud Run job trigger in the
   location that was paused at the roll: committed-`PAUSED` triggers, triggers
   held for an incident, and other estates' triggers all appear in it. It is a
   list to check your record against, not a list to resume. `built`.
9. **Check the result.** `node scripts/gcp-infra.mjs readback --require-clean --environment=<env>`
   exits 0. The roll receipt's served commit equals `--commit`. In `gcp` mode
   the served-commit check reads only public health (status `ok` and the
   commit), not `/api/ready`; readiness still goes stale 2 hours after the last
   pass (the roll's own pass, when the target has a maintenance job), so
   resume the maintenance trigger within that window, here and before step 10,
   under the same rules as step 11: it is in this plane's committed desired
   state with state `ENABLED`, and your step 6 record shows it live `ENABLED`
   before the pause. Do not hold it for the reprice, which can outlast the
   window.
10. **Reprice under the new kernel, before the analytics-refresh trigger
    resumes.** Required
    whenever the rolled commit's analytics kernel differs from the previous
    one (compare the `kernel.kernelId` that `node cloud-run/build.mjs --check`
    prints at each commit, or the last entry of
    `src/analytics-v2/kernel-registry.json`). Until a reprice runs under the
    new kernel, the equivalences the previous kernel stamped stay hidden.
    Skip this step only when the kernel did not change. The verb is
    `gcp:analytics:reprice` (`scripts/gcp-analytics-reprice.mjs`), and the
    procedure, bounds and refusal codes are in
    [Bounded historical spend repricing](./2026-10-09-historical-spend-repricing.md#production-carrier).
    In short, from a clean checkout at `--commit`:

    ```bash
    npm run gcp:analytics:reprice -- --environment=<env> --mode=plan --commit=<commit> \
      --expected-kernel=<new kernel id> --from-day=<first day> --through-day=<last day> \
      --max-days=32 --max-members=1000 --max-input-bytes=16777216 \
      --receipt-out=<new absolute path> --authorize=reprice-plan:<env>:<commit> --execute
    npm run gcp:analytics:reprice -- --environment=<env> --mode=execute --commit=<commit> \
      --expected-kernel=<new kernel id> --from-day=<first day> --through-day=<last day> \
      --max-days=32 --max-members=1000 --max-input-bytes=16777216 \
      --plan-receipt=<the plan receipt> --expected-plan-sha256=<its planSha256> --run-id=<fresh UUID> \
      --receipt-out=<new absolute path> --authorize=reprice-execute:<env>:<planSha256> --execute
    ```

    Only the analytics-refresh trigger is held for this step. It is still
    paused here, so no refresh can start, and the verb refuses while a
    refresh, reprice or migration execution is running. The maintenance
    trigger is not held: step 9 resumed it, because readiness goes stale 2
    hours after the last pass and this step can take longer (each plan and
    execute is one Job execution of up to 3,600 s, the verb polls for up to
    3,900 s, and the procedure repeats per 32-day window). The verb does not
    check maintenance executions, and the maintenance pass takes its own
    advisory lock, not the refresh lock, so a pass may run alongside a
    reprice. Each
    `--execute` is a separate `owner` operation: an execution of a production
    Job. The reprice Job must exist first: it is part of the committed desired
    state and is created by an owner-applied OPS-2 plan (see the
    [infrastructure README](../../apps/worker/cloud-run/infra/README.md#reprice-job-ops-reprice)).
    `built` (OPS-REPRICE); tested offline only, never run against a project.
11. **Resume the remaining triggers, explicitly and in order,** under
    [GCP scheduler resume](./gcp-scheduler-resume.md#resume-after-a-rollout).
    Resume only a trigger that is in this plane's committed desired state with
    state `ENABLED` and that your step 6 record shows live `ENABLED` before the
    pause. The maintenance trigger was resumed in step 9; the analytics-refresh
    trigger resumes only after step 10 finished or was skipped, and not over an
    unresolved `REPRICE_*` execute refusal. Never resume a trigger because it
    appears in `pausedTriggers`. The rollout never resumes a trigger. `not built` (OPS-3 `resume-all`).
12. **Close out.** Record UTC times, the commit, the digest, the receipts'
    digests (the reprice receipts' `digestSha256` included), the outage window, the observed health, the paused and resumed
    triggers and any refusal, following
    [closeout evidence](./production-operations.md#closeout-evidence). Keep
    private identifiers out.

## When something fails

| Code | Meaning | Action |
|---|---|---|
| `ROLLOUT_JOBS_NOT_PAUSED`, `ROLLOUT_JOBS_RUNNING` | A trigger is not paused or an execution is running | Pause, wait, run `preflight`. Never bypass |
| `ROLLOUT_BACKUP_AUDIT_STALE`, `ROLLOUT_BACKUP_AUDIT_BREACH` | The audit is older than 6 hours, or the backup horizon is in breach | Take a fresh audit. A breach is an incident for the owner; do not migrate over it |
| `ROLLOUT_INFRA_NOT_CLEAN`, `ROLLOUT_INFRA_READBACK_INVALID`, `ROLLOUT_INFRA_MANIFEST_UNAVAILABLE` | The estate is unclean, or the committed desired state still has an owner placeholder, an unpinned secret version, an unnamed verifier operator or no verifier | Read the readback's findings and fix the desired state or the estate. Apply never deletes |
| `PRODUCTION_SIMP_RESIDUE_MISSING`, `PRODUCTION_MIGRATION_CONTRACT_UNREVIEWED` | A migration is not reviewed for the previous revision, or the residue migration is absent | Fix the checkout; do not edit the review map to pass |
| `MIGRATION_STATE_NEWER_THAN_IMAGE`, `MIGRATION_HISTORY_DIVERGED` | The database is ahead of the image, or its history is not a prefix of the manifest | Stop, with no writes made. Diagnose; never relabel a history or delete a ledger row |
| `POSTGRES_MIGRATION_CONFLICT` | A lifecycle pass holds the migration fence | Nothing was applied. Wait for the pass and rerun |
| `ROLLOUT_MIGRATE_RECEIPT_STALE`, `ROLLOUT_MIGRATE_RECEIPT_MISMATCH` | The receipt is older than 24 hours, or is for another commit, digest or job | Rerun `migrate` for the exact digest to get a fresh receipt. This is a no-op for an applied schema |
| `ROLLOUT_EDGE_LIVE_STALE`, `ROLLOUT_EDGE_LIVE_UNVERIFIED` | The edge capture is older than 15 minutes or fails verification | Capture again |
| `ROLLOUT_EDGE_CAPTURE_*`, `PRODUCTION_LIVE_*` from `capture-edge` | The output path exists or is a symlink, its parent is inside a git checkout (`ROLLOUT_EDGE_CAPTURE_OUTPUT_IN_REPOSITORY`) or writable by another user (`ROLLOUT_EDGE_CAPTURE_OUTPUT_UNSAFE`), or the path changed during the reads (`ROLLOUT_EDGE_CAPTURE_OUTPUT_CHANGED`); the inventory is missing, changed or of another Worker; or the read-only Cloudflare reads were refused (`PRODUCTION_LIVE_CREDENTIAL_REQUIRED`: no token). A `ROLLOUT_EDGE_LIVE_*` code means the live edge itself does not verify | Nothing was written. Fix the input and capture again. Do not roll over an edge that does not verify |
| `EDGE_CONTRACT_DRIFT`, `ROLLOUT_EDGE_ORIGIN_MISMATCH` | The contract blob differs from the live gcp edge's, or the edge points at another service | Do not roll. See [contract changes](#contract-changes) |
| `ROLLOUT_MAINTENANCE_JOB_REQUIRED` | The edge is not in `gcp` mode and the target names no maintenance job (staging today) | Nothing was written. The verifier path cannot pass without a lifecycle pass; give the plane its maintenance job first |
| `ROLLOUT_MAINTENANCE_PASS_FAILED` | The roll's maintenance execution did not succeed exactly once. This runs after the service and every job moved, so the roll has already happened and left no receipt | Read the execution's closed log lines, fix the cause, then run `roll` again for the same digest with a new edge capture. If the image is wrong, treat the roll as incomplete and fix forward |
| `ROLLOUT_PUBLIC_HEALTH_COMMIT_MISMATCH`, `ROLLOUT_ORIGIN_COMMIT_MISMATCH`, `EDGE_ORIGIN_VERIFIER_*` | The served commit is not the rolled commit, or the verifier path failed. `EDGE_ORIGIN_VERIFIER_NOT_READY` means `/api/ready` did not read `ready` even after the roll's own pass: read its checks (the lifecycle, retention and reconciliation rows the pass writes). This check runs after the service and every job moved, so the roll has already happened and left no receipt | Fix the cause, then run `roll` again for the same digest. The rerun needs a new edge capture from `capture-edge` (the first is likely past 15 minutes). If the commit is wrong, treat the roll as incomplete and fix forward |
| `PRODUCTION_COORDINATION_*` | The shared deployment lock is held | A retained lock is a stop. Do not retry with raw tools; follow the typed reconciliation in [Production service operations](./production-operations.md#guarded-deployment-wrapper) |
| `STAGING_COORDINATION_*` | The staging deployment lock is held, or its state is uncertain | A retained staging lock is a stop. Do not delete or move `refs/heads/codex/staging-deployment-lock` by hand; report the owner commit to the owner. The production lock is not involved |
| `ROLLOUT_LOCK_REF_MISMATCH`, `DEPLOYMENT_COORDINATION_*` | The lock offered for this environment is not its own ref, or the environment is not in the closed mapping | Stop. Nothing was pushed. Fix the checkout; never point one environment at another's lock |
| `REPRICE_*` (step 10) | The reprice verb refused, before or after its one execution | See the refusal table in [Bounded historical spend repricing](./2026-10-09-historical-spend-repricing.md#refusals). Do not resume the analytics-refresh trigger over an unresolved execute refusal; the roll itself stands. The maintenance trigger is not held (step 9) |

After a failure between `migrate` and a successful `roll`, the previous
revision is still refusing its storage-gated routes. The priority is a
successful roll of an image that matches the migrated schema, then, if needed,
a further fix as a new commit. Do not move the service back to an older image:
its exact-history receipt fence refuses a schema that has moved on. To recover
an interrupted `migrate`, rerun it for the same digest: the runner is
forward-only, and the job's PostgreSQL spec shows that a rerun over an applied
history is a no-op with an identical receipt.

## Contract changes

If a change alters `apps/worker/src/edge-origin-contract.ts`, the edge and the
origin must carry the same blob, and the edge decision defines no in-place
upgrade. While the edge is in gcp mode the roll refuses `EDGE_CONTRACT_DRIFT`.
The path is the brake: gcp to fenced, roll the origin, then a typed gcp deploy
from an edge commit with the same blob. The forwarded routes are unavailable for
that window; see [GCP brake and incidents](./gcp-brake-and-incidents.md#fix-forward).
Before the switch, the same comparison is made by hand against the edge-port
commit.

## Staging proof

Before the first production rollout, the owner runs this sequence once on the
staging plane with synthetic data: a full `migrate` and `roll` of a new
digest. The staging load test (OPS-11) was removed by the owner on
2026-10-02 (round 11); the live checks it carried that do not need load are
part of this proof. Each is an owner-authorized staging operation, and each
is `owner`:

1. **Maintenance pass.** Run one maintenance pass live and confirm it
   completes and `/api/ready` reads `ready` afterwards (C-MAINT).
2. **Advisory-lock fence.** Confirm the maintenance pass and the migration
   job take the Cloud SQL advisory lock through the IAM connector, not only
   on a local socket.
3. **A migration meeting a running pass.** Start `migrate` while a pass is
   running. The migration job must refuse `POSTGRES_MIGRATION_CONFLICT`
   (read from the job's log, because `migrate` reports any failed job as
   `ROLLOUT_MIGRATION_FAILED`), then rerun cleanly once the pass has ended.

No load is generated, and no capacity or latency figure comes out of this
proof. The quiescence and fresh-pass preconditions above apply unchanged.

## First rollout

The first production rollout pre-stages the origin (checklist PROD-3):

1. The owner applies the OPS-2 plan, whose digest authorizes the apply. It
   creates the instance, the service with a bootstrap image, the jobs, the
   secret containers and the paused triggers, and never deletes.
2. The owner populates the secrets, pins their versions in the committed
   desired state, commits the bucket-birth proof, and names the verifier's
   operator. The estate reads clean only after all of these.
3. Run this sequence once. There are no triggers to pause, and `migrate` and
   `roll` accept an estate with none.
4. A freshly migrated, empty origin reads `not_ready` until its first
   maintenance pass, and the verifier path inside `roll` requires `/api/ready`
   to read `ready`. `roll` runs that first pass itself, with the new image,
   after the service and jobs move and before its served-commit check (D-CRB),
   so no pass is needed between `migrate` and `roll`. Locally, the PostgreSQL
   production-host spec shows the verifier refused on a fresh schema and
   passing after one lifecycle pass (run in process, not through the job);
   no project has run the roll's pass.

## Migration 0079 (community model speed)

This section adds the steps specific to the community model speed rollout to
the general [sequence](#sequence). It follows the owner decisions of
2026-10-10 ([community model speed](../decisions/2026-10-10-community-model-speed.md#google-cloud-origin-implementation)),
including decision 10: nothing here starts until the v1.2 activation-timeout
fix is live and verified. Every step marked `owner` is a protected operation
that needs its own authorization. The migration number is provisional: the
integrator renumbers `0079_performance_telemetry.sql`, with its pin set, if the
live primary head already holds 0079 or higher, and the steps below then apply
to the new number.

What the migration does to the rollout:

- **Expand-only.** Every relation and function is new, so the migrate step's
  classifier finds no contract operation and `CONTRACT_MIGRATIONS` gains no
  entry. The previous revision issues no SQL against the new tables.
- **Locks.** The new foreign keys take `SHARE ROW EXCLUSIVE` on
  `participants`, `device_credentials`, `accountless_enrollment_ledger` and
  `analytics_v2_kernels` for the migration transaction, within the runner's
  5-second lock timeout. Apply it with every trigger paused and no execution
  running, as `migrate` already requires (`ROLLOUT_JOBS_NOT_PAUSED`,
  `ROLLOUT_JOBS_RUNNING`). A lock timeout rolls the migration back; rerun it.
- **Exact-receipt write outage.** From the first applied statement until
  `roll` moves the service, the previous revision's receipt no longer matches
  its manifest, so it answers its storage-gated routes with
  `503 BACKEND_STORAGE_UNAVAILABLE` ([the accepted write outage](#the-accepted-write-outage)).
  That includes every upload route, not only performance. Run `roll`
  immediately.
- **Edge mode.** The production hostnames reach this origin only while the
  live edge is in `gcp` mode. In `worker` mode the Worker answers every
  request in steps 5, 7 and 8 itself, and in `fenced` mode they answer
  `503 MUTATION_BARRIER_ACTIVE`, so those checks and the activation wait for
  `gcp` mode.

Owner order, after the general preconditions:

1. **Kernel registry order.** `owner`. The live registry must already hold
   the v1.2 activation-timeout kernel (kernel 15 in the live order), and the
   allowance kernel 16 if it lands first. The integration branch merges the
   activation-timeout head and appends the performance stage's entry as
   `max(live) + 1`, which is kernel 16 on that base; if another kernel lands
   in production first, the entry is dropped and re-appended after it, with
   its `REGISTRY_PINS` line. `node cloud-run/build.mjs --check` must resolve
   the commit's closure to that entry before the build
   (`CLOUD_RUN_BUILD_KERNEL_UNREGISTERED` otherwise).
2. **Build, migrate and roll** the integration commit through steps 4 to 9 of
   the [sequence](#sequence). `owner`. Keep the migrate receipt: its
   `migrations.historySha256` is the deployment digest the activation request
   names.
3. **Resume the triggers** under steps 10 and 11 of the sequence. `owner`.
   The maintenance trigger must resume within the 2-hour readiness window
   that step 9 describes.

   **Reprice under the new kernel: blocked, outside this window.** `owner`,
   `not built`. The public read accepts a stored price equivalence only for
   the serving kernel (`reprice-read.ts` matches `kernel_id` to the bundled
   target), so equivalences stamped under the previous kernel stop applying
   at the roll. A day that relies on one then has its historical spend block
   withheld, never rewritten. Days already priced at the current registry are
   not affected.
   No record shows that the reprice lane has ever executed in production; if
   it has not, the roll hides nothing. There is no production carrier:
   - the image contains `dist/analytics-reprice.mjs`, but the rendered Cloud
     Run Jobs are only `production-migrate`, `analytics-refresh` and
     `maintenance` (`JOB_NAMES` in `scripts/gcp-ops-infra-manifest.mjs`);
   - no reviewed tool executes the CLI in production or reads its
     `analytics-reprice-receipt-v1` line, which carries the plan digest, back
     from the execution log;
   - [historical spend repricing](./2026-10-09-historical-spend-repricing.md)
     is not live-qualified, and its templates submit no Job.

   Do not improvise a carrier, for example by overriding the refresh Job's
   arguments. Once a carrier is reviewed, the run count follows from the
   plans, not from this runbook. Each plan selects at most 32 stale-price
   heads (`--max-days`), 1,000 members and 16 MiB of input, and execution
   refuses a capped plan. So more heads take several consecutive
   date-partitioned rounds of plan, review and execute, each with a fresh
   `--run-id`. Execution takes the shared refresh transaction lock and
   refuses busy input, so it needs no trigger pause. Resume the triggers
   without waiting for it, and run it outside a scheduled refresh.
4. **Monitoring policy apply.** `owner`. The rendered policies changed: the
   performance capability and report paths joined the paths never excluded
   from the origin 5xx ratio, and the retired consent route is the only
   performance path still excluded. The public model-performance read and
   the admin intake view are counted too, and are pinned never excluded (a
   guard on the exclusion table that changes no rendered policy).
   Re-plan and apply under a fresh plan digest
   ([monitoring](../../apps/worker/cloud-run/infra/monitoring.md#protected-monitoring-apply)).
5. **Read-only checks before the edge deploy.** While the runtime is staged,
   only the paths the live edge already forwards can be checked:
   - `/api/ready` reads `ready`;
   - authenticated grants, capability polls and report uploads from installed
     clients answer `403 TELEMETRY_TRANSPORT_BLOCKED`, never a 5xx.

   Do not expect the admin view or the public read yet. The live edge's route
   registry has neither new path, so until step 6 it answers both itself with
   `404 NOT_FOUND` and never forwards them to the origin.
6. **Edge deploy** from the edge-port line: the two new routes, the admin
   section and the website reader, as two typed deploys (kept-site code, then
   the web-only site change), because a single changed-site deploy of that
   candidate is outside the web-only closure
   ([production edge modes](./production-edge-modes.md#community-model-speed-routes-2026-10-10)).
   `owner`. The intake routes need no edge change. Run this deploy only after
   the roll and step 5. Before any write, a gcp-mode deploy reads the
   origin's served commit through the verifier and refuses
   `EDGE_ORIGIN_COMMIT_MISMATCH` unless it equals `--origin-commit`, so both
   typed deploys pass the rolled commit. The verifier also needs
   `/api/ready` to read `ready`, which a maintenance pass under 2 hours old
   provides. Steps 7 and 8 need both the roll and this deploy.
7. **Read-only verification through the edge.** While the runtime is staged:
   - `GET /api/v1/admin/performance-intake` on the admin host answers 200 with
     runtime `staged` at revision 1, the rolled `sourceCommit`, and a
     `historySha256` equal to the migrate receipt's;
   - every `GET /api/v1/community/model-performance` slot answers
     `404 COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED` with `no-store`;
   - the step 5 refusals show up as refusal counters in the admin view.
8. **Owner activation**, only through
   [the activation runbook](./2026-09-22-telemetry-runtime-activation.md#google-cloud-origin-performance-activation),
   and only after step 7 passes. `owner`. There is no admin UI control.
9. **First reports and publication.** Reports arrive as released clients
   (0.1.24–0.1.28) restart and re-grant. The first publication comes at the
   next analytics refresh after a report with an included record exists. A
   new report or replacement for a day outside the server's UTC window, from
   10 days before today through tomorrow, is refused
   `409 TELEMETRY_RECORD_INVALID` and counted as a refusal; that is expected
   for a device with a skewed clock
   ([decision](../decisions/2026-10-10-community-model-speed.md#google-cloud-origin-implementation)).

There is no client release step. The owner decided on 2026-10-12 against a new
client for community model speed, and the planned 0.1.29 is withdrawn
([no new client amendment](../decisions/2026-10-10-community-model-speed.md#no-new-client-amendment-2026-10-12)).
Every report uses `…2026-09-21.1` or `…2026-09-29.1` with v1 buckets and
arrives through a v1 grant. Speeds of 120 tokens/second or more are published
as unresolved samples with wide bounds. Dictionary `…2026-10-10.1` and grant
v2 stay accepted but unused: a `…2026-10-10.1` dictionary or a
`client_declared` grant basis in the admin view comes from an unreleased
client build.

During the staged window, each refused capability poll upserts one refusal
counter row. Local measurement at concurrency 24 and 64 on the production pool
sizes counted every refusal, with refused polls at about twice read latency
(p50 35–99 ms). Only a locked or unavailable counter table adds up to 1 second
of tail latency per refusal. This is not a probe signal and needs no brake.

### Refresh with future-dated v1.2 events

The analytics-refresh Job tolerates v1.2 events and chunk days later than its
clock. v1.2 admission has no server-clock bound: it only requires each event to
fall on its manifest's UTC day. The refresh then completes, and its receipt
lists any future queued days as published, because the plan runs through
`max(queued days, today)`. The performance stage is not affected: it excludes
report days after yesterday and counts them as `deferredFutureDays`.

A refresh that fails with `{"code":"ANALYTICS_V2_SOURCE_UNAVAILABLE","phase":"read"}`
over v1.2 owners is therefore not a clock problem. First check that
`telemetry_usage_correction_runtime` holds its id=1 row. The effective reader
(`occurrence-source.ts` `readOwnerScope`, mirroring d43c8f92) refuses every
v1.2 owner without it. Production always has the row: the cutover's
usage-correction stage requires exactly one, and a trigger makes it immutable.
A schema built from migrations alone, such as a test seed, lacks it and must
insert it before running the refresh.

## Open gaps

| Gap | State |
|---|---|
| Scheduler pause-all and resume-all, with explicit authorization and an ordered list | `not built` (D-OPS3). Every roll refuses while a trigger is unpaused. Requirement: `resume-all` takes its list from this plane's committed desired state (state `ENABLED`) intersected with the live state recorded before the pause, and never from the roll receipt's `pausedTriggers` or from another estate's triggers |
| Live edge capture writer | `built` (`capture-edge`). Tested locally with a fake provider; never run against Cloudflare |
| Pre-migration backup count | The code takes two (`PRE_MIGRATION_BACKUPS`); the owner decided one plus point-in-time recovery. The change and its tests are `not built` (backup-count item) |
| Pre-migration backup expiry | The code labels them to expire in 30 days. The privacy disclosure drafted for the cutover says pre-change backups are kept at most 90 days. Reconcile before either is published |
| First-roll ready path | `built` (D-CRB): `roll` runs one maintenance job execution before its served-commit check. Local proof only; not run in any project. Staging has no maintenance job yet, so its origin-verifier roll is refused before any write |
| Contract-blob check on every origin deploy | The roll checks it only while the edge is in gcp mode. The all-modes check is `not built` (D-BLOB) |
| Maintenance job in the rollout target | `built` (D-OPS4). The production target's jobs are the migration job, the refresh job and the maintenance job, and the staging target omits the maintenance job until its staging template exists. Both targets' jobs also include the reprice job (OPS-REPRICE). Not applied or rolled in any project |
| First live readback of the OPS-2 estate | Open (OPS2-READ) |
| Staging migrate-and-roll proof, with its live sub-checks | Open (see [staging proof](#staging-proof)) |
| Reprice Job and verb (step 10) | `built` (OPS-REPRICE): the Job is in both desired states and the rollout target, and the verb is tested offline with a stubbed `gcloud`. Not applied, executed or log-parsed in any project. The first live run is staging, owner-authorized |
| Migration 0079 rollout | Source and local PostgreSQL proof only. Not built, migrated, rolled or activated in any project |

## Evidence boundary

This is a draft runbook, not a deployment receipt. A local check proves its
checkout, command and time. Source merge, CI, image build, migration, roll,
edge deploy and public deployment are separate gates, and this document proves
none of them.
