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
| Estate clean | `preflight` | `node scripts/gcp-infra.mjs readback --require-clean --environment=<env>` exits 0. A paused trigger whose committed state is `ENABLED` is a clean deferral |
| Backup audit | Operator | A receipt from `node scripts/gcp-backup-horizon.mjs audit` is at most 6 hours old and is not a breach (exit 3 blocks) |
| Identity-link continuity (production) | Operator | `node scripts/gcp-identity-link-pin-check.mjs --environment=production --pin-file=<pin>` reads `match` for the `IDENTITY_LINK_SECRET` version the desired state pins (`docs/runbooks/gcp-production-apply.md`, step 10). The origin never re-pins, so a mismatch would only show after the roll, as 503 `IDENTITY_CONFIGURATION_INVALID`. Procedural: `preflight` does not run it |
| Schema reviewed | `migrate` | The migrations are expand-compatible or reviewed in `CONTRACT_MIGRATIONS`, and the append-only residue migration is present (`PRODUCTION_SIMP_RESIDUE_MISSING` until it lands) |
| Jobs quiescent | `migrate`, `roll` | Every Cloud Scheduler trigger of a Cloud Run job in the location is paused, and nothing is running (`ROLLOUT_JOBS_NOT_PAUSED`, `ROLLOUT_JOBS_RUNNING`) |
| Fresh lifecycle pass | `roll` | Whenever the live edge is not in `gcp` mode, `roll` checks the served commit through the verifier path, which needs `/api/ready` to read `ready`. Readiness goes stale 2 hours after the last completed maintenance pass, and the maintenance trigger, once one exists, is paused for the rollout, so the last completed pass must be under 2 hours old when `roll` reaches that check (`EDGE_ORIGIN_VERIFIER_NOT_READY` otherwise). This covers every pre-switch rollout, the pre-staging one included, and every rollout while the edge is braked to `fenced` |
| Edge capture | `roll` | A verified capture of the live edge, at most 15 minutes old, for this environment |
| Contract blob | `roll` | If the live edge is in gcp mode, `apps/worker/src/edge-origin-contract.ts` has the same Git blob at `--commit` and at the live edge's commit (`EDGE_CONTRACT_DRIFT`), and the edge points at this service |
| Lock | Every mutating verb | The environment's own coordination lock is free. Production takes the shared production deployment lock, `refs/heads/codex/production-deployment-lock`; staging takes only `refs/heads/codex/staging-deployment-lock` and never the production lock (owner decision 2026-10-02, round 9). The mapping is closed, and a dry run prints the exact ref as `lockRef` |
| Authorization | Owner | Authorized in chat for this verb, this environment and this digest or commit |

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
     15 minutes before `roll`. No command in the repository writes this file;
     the roll consumes it. `not built`: `<command: edge live capture>`.
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

   ```bash
   node scripts/gcp-production-rollout.mjs build --environment=<env> --commit=<commit> \
     --authorize=build:<env>:<commit> --execute
   ```

5. **Dry-run migrate and roll.** The same commands as steps 7 and 8 without
   `--execute`, with the digest. Read the printed argv.
6. **Record, pause and drain the triggers, then run a pass.** Pause the
   triggers of this plane's Cloud Run jobs, then wait for running executions to
   finish. Do not cancel a running refresh as part of this procedure; if one
   runs long, the owner decides whether to wait or to defer the rollout. The
   tooling is `not built` (OPS-3 `pause-all`); until it exists the owner does it
   by hand, each an authorized GCP write.

   - **Before pausing anything, record** for every trigger: its name, its live
     state (`gcloud scheduler jobs describe`), and its committed state in the
     environment's desired-state file. This record, not the roll receipt,
     decides what is resumed in step 10.
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
   - **Run a maintenance pass by hand** if the last completed pass is not
     comfortably inside 2 hours of the expected `roll` time, and before
     `migrate` so the outage window does not grow. A pass skips with
     `MIGRATION_IN_PROGRESS` while a migration runs. If `migrate` runs long
     enough to push the last pass past 2 hours before `roll`, the pass must run
     again before `roll` and extends the outage window. The maintenance job is
     `built` (C-MAINT) but is not in the rollout target (D-OPS4), so how the pass
     is started by hand is an open item.

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
   then checks the served commit: public `GET /api/health` when the live edge
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
   pass, so run a pass by hand now if the pause was long.
10. **Resume the triggers, explicitly and in order,** under
    [GCP scheduler resume](./gcp-scheduler-resume.md#resume-after-a-rollout).
    Resume only a trigger that is in this plane's committed desired state with
    state `ENABLED` and that your step 6 record shows live `ENABLED` before the
    pause. Never resume a trigger because it appears in `pausedTriggers`. The
    rollout never resumes a trigger. `not built` (OPS-3 `resume-all`).
11. **Close out.** Record UTC times, the commit, the digest, the receipts'
    digests, the outage window, the observed health, the paused and resumed
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
| `EDGE_CONTRACT_DRIFT`, `ROLLOUT_EDGE_ORIGIN_MISMATCH` | The contract blob differs from the live gcp edge's, or the edge points at another service | Do not roll. See [contract changes](#contract-changes) |
| `ROLLOUT_PUBLIC_HEALTH_COMMIT_MISMATCH`, `ROLLOUT_ORIGIN_COMMIT_MISMATCH`, `EDGE_ORIGIN_VERIFIER_*` | The served commit is not the rolled commit, or the verifier path failed. `EDGE_ORIGIN_VERIFIER_NOT_READY` means `/api/ready` did not read `ready`, usually a stale lifecycle pass. This check runs after the service and every job moved, so the roll has already happened and left no receipt | Run a maintenance pass, then run `roll` again for the same digest. The rerun needs a new edge capture (the first is likely past 15 minutes, and no command writes one, see [open gaps](#open-gaps)). Avoid it by meeting the fresh-pass precondition first. If the commit is wrong, treat the roll as incomplete and fix forward |
| `PRODUCTION_COORDINATION_*` | The shared deployment lock is held | A retained lock is a stop. Do not retry with raw tools; follow the typed reconciliation in [Production service operations](./production-operations.md#guarded-deployment-wrapper) |
| `STAGING_COORDINATION_*` | The staging deployment lock is held, or its state is uncertain | A retained staging lock is a stop. Do not delete or move `refs/heads/codex/staging-deployment-lock` by hand; report the owner commit to the owner. The production lock is not involved |
| `ROLLOUT_LOCK_REF_MISMATCH`, `DEPLOYMENT_COORDINATION_*` | The lock offered for this environment is not its own ref, or the environment is not in the closed mapping | Stop. Nothing was pushed. Fix the checkout; never point one environment at another's lock |

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
   to read `ready`. A pass therefore has to complete after `migrate` and before
   `roll`: it cannot run between the roll and its check, because that check is
   part of `roll`. How that first pass is started before any maintenance job
   exists in the rollout target is the open first-roll item (D-CRB, D-OPS4).
   Until it is decided, expect the first roll's served-commit check to fail
   `EDGE_ORIGIN_VERIFIER_NOT_READY` after the service and jobs have moved.

## Open gaps

| Gap | State |
|---|---|
| Scheduler pause-all and resume-all, with explicit authorization and an ordered list | `not built` (D-OPS3). Every roll refuses while a trigger is unpaused. Requirement: `resume-all` takes its list from this plane's committed desired state (state `ENABLED`) intersected with the live state recorded before the pause, and never from the roll receipt's `pausedTriggers` or from another estate's triggers |
| Live edge capture writer | `not built`. The roll consumes the file; nothing writes it |
| Pre-migration backup count | The code takes two (`PRE_MIGRATION_BACKUPS`); the owner decided one plus point-in-time recovery. The change and its tests are `not built` (backup-count item) |
| Pre-migration backup expiry | The code labels them to expire in 30 days. The privacy disclosure drafted for the cutover says pre-change backups are kept at most 90 days. Reconcile before either is published |
| First-roll ready path | `not built` (D-CRB, D-OPS4): a pass must complete between `migrate` and `roll`, and nothing starts one yet |
| Contract-blob check on every origin deploy | The roll checks it only while the edge is in gcp mode. The all-modes check is `not built` (D-BLOB) |
| Maintenance job in the rollout target | `not built` (D-OPS4). The manifest's jobs are the migration job and the refresh job |
| First live readback of the OPS-2 estate | Open (OPS2-READ) |
| Staging load test with a migrate and roll under load | Open (OPS-11) |

## Evidence boundary

This is a draft runbook, not a deployment receipt. A local check proves its
checkout, command and time. Source merge, CI, image build, migration, roll,
edge deploy and public deployment are separate gates, and this document proves
none of them.
