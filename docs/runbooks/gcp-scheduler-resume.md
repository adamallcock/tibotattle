---
title: GCP scheduler resume
date: 2026-10-02
type: runbook
status: draft
---

# GCP scheduler resume

> **Draft. Not operational.** This draft covers pausing and explicitly
> resuming the Cloud Scheduler triggers that start the origin's Cloud Run Jobs:
> the analytics-refresh job and the maintenance job (its trigger is in the
> committed desired state, D-OPS4). The rule is that a trigger is created
> paused and is resumed only by an explicit, owner-authorized act.
> Infrastructure apply never resumes one, and neither does a rollout. The
> tooling that pauses and resumes triggers (OPS-3 `pause-all` and `resume-all`)
> does not exist yet, so those steps are manual `gcloud` writes. Nothing here authorizes a scheduler change. Tooling
> markers (`built`, `in build`, `not built`, `owner`) are defined in
> [GCP cutover window](./gcp-cutover-window.md#tooling-markers).

Related: [GCP cutover window](./gcp-cutover-window.md) (first resumes in H.4 and
H.8), [GCP origin rollout](./gcp-rollout.md) (pause before and resume after each
roll), [GCP brake and incidents](./gcp-brake-and-incidents.md), and the
[infrastructure desired state](../../apps/worker/cloud-run/infra/README.md).

## Status and claim boundary

- **Basis.** The fast-path line `claude/gcp-fastpath-final` at `c80f99b9`, whose
  OPS-2 estate tooling is merged, and the owner decisions of 2026-10-02.
- **Verified from source.** The desired-state trigger model, what apply creates
  and pauses, the readback deferral, the paused-too-long probe and its
  verdicts, and the rollout's quiescence refusals.
- **Not verified.** No live `gcloud` output has been parsed. In particular, the
  probe assumes that pausing a trigger updates its `userUpdateTime`; the first
  owner-run readback must confirm that after a real pause. The refresh
  cadence and the measured run time of the production-scale refresh are
  undecided. The maintenance trigger's cadence is not: it is every minute,
  pinned to the job's contract (D-OPS4).
- **Decisions encoded.**
  - Explicit resume only. Apply never resumes a trigger.
  - There is no default cadence. A trigger whose committed `schedule` is `null`
    is not created.
  - Alert if a trigger stays paused for more than a few hours. The proposed
    threshold is 6 hours, and the owner has not confirmed it.
  - Once the owner resumes a trigger, the owner commits its state as `ENABLED`.

## What exists

| Piece | State |
|---|---|
| Triggers in the committed desired state | `built`: one per scheduled job, `analytics-refresh` (the owner's cadence, `null` until decided) and `maintenance` (every minute, pinned, D-OPS4). The migration job is manual and has no trigger |
| Apply creates a trigger and pauses it in the same apply, then grants the scheduler account `roles/run.jobsExecutor` on the job | `built`. A trigger whose pause failed cannot start the job: apply stops at the failed pause before the grant, a job's grant is withheld while its cadence is unset, and a grant already live blocks the create (`SCHEDULER_CREATE_EXECUTOR_BOUND:<job>`) |
| `gcp-infra.mjs readback --require-clean --require-cadence` refuses an unset cadence | `built`. The cutover's scheduler gate; the rollout's `--require-clean` still accepts it, because the cadence is measured on the rolled image |
| Apply never resumes. It pauses a live trigger that runs while `PAUSED` is committed | `built` |
| Readback treats a paused trigger with committed `ENABLED` as the deferral `SCHEDULER_TRIGGER_RESUME_PENDING`, which keeps the estate clean | `built` |
| `node scripts/gcp-infra.mjs scheduler-probe --environment=<env>`: one read of the location's scheduler jobs and a content-free verdict per trigger; exit 2 on an alert | `built` |
| The maintenance job (`node dist/postgres-maintenance-job.mjs --profile=maintenance-job`) | `built`, with its trigger and job definition in the committed desired state (D-OPS4), created paused. Its staging counterpart waits for the staging service template. Nothing is applied in any project |
| OPS-3 `pause-all` and `resume-all` with an ordered list and explicit authorization | `not built` (D-OPS3) |
| A periodic runner and notification target for the probe, and the other monitoring | `not built` (E-OPS5; the alerting channel and billing account are owner inputs) |

## Trigger states

A trigger has a committed state (`PAUSED` or `ENABLED`, in the desired-state
file) and a live state (`ENABLED`, `PAUSED`, `DISABLED`, `UPDATE_FAILED`, or
absent).

| Committed | Live | Meaning | Readback and probe |
|---|---|---|---|
| `PAUSED` | `PAUSED` | As created; never resumed | Clean. `paused_as_desired` |
| `PAUSED` | `ENABLED` | Resumed, but not yet committed | A later apply re-pauses it. Commit `ENABLED` at once |
| `ENABLED` | `ENABLED` | Running | `running` |
| `ENABLED` | `PAUSED` | Deliberately paused for a rollout or an incident, or a resume that failed | Clean, as a deferral. The probe says `paused_within_threshold`, then `paused_too_long` (alert, exit 2) once neither a user change nor an attempt is newer than 6 hours. `paused_evidence_unavailable` (alert) when no usable timestamp exists |
| `ENABLED` | absent | The trigger is missing | `absent` (alert) |
| any | `DISABLED`, `UPDATE_FAILED` or unrecognized | Not a state this runbook manages | `state_unrecognized` (alert). Stop and diagnose |
| `PAUSED` | absent | Not created, usually because the cadence is unset | `absent_not_created` |

## Pause

Use it before a rollout ([GCP origin rollout](./gcp-rollout.md)), before an
operation that must not race a job, or to stop a job that is causing harm.

1. **Authorize.** The owner authorizes each pause in chat.
2. **Record**, for every trigger you will pause: its name, its live state
   (`gcloud scheduler jobs describe`), its committed state in the environment's
   desired-state file, the time in UTC and the reason. Pause only triggers in
   this plane's desired state. A resume after a rollout is decided from this
   record, so it must exist before the first pause.
3. **Pause each trigger** in the order the plan names. `not built` (OPS-3);
   until it exists:

   ```bash
   gcloud scheduler jobs pause <trigger name> --location=<region> --project=<project>
   ```

4. **Drain.** Wait for running executions of the job to finish:
   `gcloud run jobs executions list --job=<job> --region=<region> --project=<project>`.
   Do not cancel a running refresh as part of this procedure. The refresh job
   takes a database advisory lock and writes in one transaction, so a run
   already in flight finishes or fails as a unit; if it runs for a long time,
   the owner decides whether to wait or to defer. The dense refresh measured 66
   minutes on a test seed; the production figure is unmeasured.
5. **Confirm quiescence.** The rollout's `preflight` reports every trigger as
   paused and nothing running. For a pause outside a rollout, use the same read.
6. **Start a clock.** If the trigger's committed state is `ENABLED`, the probe
   signals after 6 hours. Plan the resume inside that.

Pausing the maintenance trigger has a second consequence: origin readiness goes
stale 2 hours after the last pass, so `/api/ready` reads `not_ready`. For a long
pause, run a pass by hand before anything that needs readiness, such as the
rollout's served-commit check before the switch.

## Resume

### Preconditions

All of these, for every trigger:

- The origin is healthy at the intended commit: public `GET /api/health` is
  status `ok` with that commit (or, before the switch, the verifier smoke reads
  ready), and the roll receipt's served commit equals it.
- `node scripts/gcp-infra.mjs readback --require-clean --environment=<env>`
  exits 0. No migration is running.
- Nothing is running for that job. A manual run holds the job's lock, and a
  scheduled run that starts meanwhile exits 0 with `LOCK_HELD` and writes
  nothing.
- The committed `schedule` is the intended cadence. There is no default, and
  the cadence comes from the refresh measurements, not from convenience.
- Alerts for the job are live, or the owner has accepted their absence for this
  resume and recorded it. `not built` (E-OPS5).

Per job:

- **Maintenance.** Run one pass by hand first and confirm its receipt, so the
  first scheduled pass starts from a fresh lifecycle state. The pass skips with
  `MIGRATION_IN_PROGRESS` while a migration runs, and a held lock returns
  `MAINTENANCE_IN_PROGRESS` with no write. Each pass first runs one bounded
  page of the expired sign-in handoff, sign-in window and device-lifecycle
  purges (MAINT-PURGE), before it writes the lifecycle row, as the Worker
  does. A pass that fails in a purge writes neither readiness row, so
  `/api/ready` reads what it read before. A `partial` receipt is a backlog
  that later passes drain: `QUARANTINE_RECONCILIATION_BACKLOG` leaves
  `/api/ready` not_ready, `MAINTENANCE_PURGE_BACKLOG` does not.
- **Analytics-refresh.** On the first resume after the cutover, a manual run has
  completed and the first Google Cloud publication is confirmed
  ([cutover window, H.8](./gcp-cutover-window.md#h8-analytics-cold-build)). On
  a later resume, the last completed run is newer than the last input change.
  A receipt with state `LOCK_HELD` is not a completed run.

### Order

Proposed, pending the ordered-list tooling: the maintenance trigger first, then
the analytics-refresh trigger. Readiness is the origin's public health signal
and is cheap to restore; the refresh is the heaviest job and should start only
once the origin is confirmed healthy.

### Steps

1. **Authorize** each resume in chat.
2. **Resume.** `not built` (OPS-3 `resume-all --only=<ordered list>`); until it
   exists:

   ```bash
   gcloud scheduler jobs resume <trigger name> --location=<region> --project=<project>
   gcloud scheduler jobs describe <trigger name> --location=<region> --project=<project> --format=json
   ```

   Read the live state back from the describe output and confirm `ENABLED`.
3. **Commit the state.** Immediately set the job's `scheduler.<job>.state` to
   `ENABLED` in the committed desired state, and commit it (the owner's
   commit). Do not run `gcp-infra.mjs apply` between the resume and this
   commit: apply would pause a live trigger whose committed state is `PAUSED`.
4. **Check the estate.** `gcp-infra.mjs readback --require-clean` exits 0, and
   `gcp-infra.mjs scheduler-probe` exits 0 with the trigger `running`.
5. **Watch the first scheduled execution** succeed. For the refresh, read its
   receipt line and confirm a completed run, not `LOCK_HELD`. For maintenance,
   confirm readiness is fresh.
6. **Record** the resumed triggers, the time in UTC, the commit that carries the
   committed state and the first execution's outcome.

## Resume after a rollout

The roll receipt's `pausedTriggers` is not a resume list. It names every Cloud
Run job trigger in the location that was paused at the roll, whoever owns it
and whatever its committed state. It includes a trigger that was committed
`PAUSED` and never resumed (the analytics-refresh trigger before its cold
build, for example), a trigger the owner paused for an incident, and, in the
shared staging project, another estate's triggers.

Resume a trigger after a rollout only when all of these hold:

- It is in this plane's committed desired state, not another estate's.
- Its committed state is `ENABLED`.
- Your record from the pause step shows it was live `ENABLED` immediately before
  the rollout paused it, and no incident hold applies.

Then use the steps above, after the roll receipt and its post-roll checks. For
such a trigger the committed state is already `ENABLED`, so step 3 changes
nothing. Use `pausedTriggers` only to check that nothing in it surprises you:
a trigger that is paused and not in your record, or committed `PAUSED`, stays
paused. A committed-`PAUSED` trigger is resumed only by its own first-resume
step (for the refresh, [H.8](./gcp-cutover-window.md#h8-analytics-cold-build)).
The rollout itself never resumes, and this procedure never touches another
estate's triggers.

## Resume after an incident or the brake

The brake (gcp to fenced) does not pause any trigger, and a resume is not part
of leaving the brake. Decide separately:

- If a job caused the incident, keep its trigger paused until the cause is
  fixed and verified on the deployed image, then resume under this runbook.
- If the brake was for an edge or origin fault unrelated to the jobs, the
  triggers can keep running; with no forwarded writes, the refresh finds
  little to do.
- After a database restore into a new instance, keep triggers paused until the
  restore's gates pass and the do-not-restore list has been reapplied
  ([GCP brake and incidents](./gcp-brake-and-incidents.md#database-or-data-loss)).

## Checking for a trigger stuck paused

Until a periodic runner and a notification target exist, run the probe by hand
after every pause, before and after each rollout, and during the observation
period of the cutover:

```bash
node scripts/gcp-infra.mjs scheduler-probe --environment=<env>
```

It prints one verdict per managed trigger and exits 2 when any raises an alert
(`paused_too_long`, `paused_evidence_unavailable`, `absent`, `state_unrecognized`).
It is a read-only call. It is a signal, not an alert: nothing runs it
periodically and it notifies no one.

## Open gaps

| Gap | State |
|---|---|
| OPS-3 `pause-all` and `resume-all`, ordered, with explicit authorization | `not built` (D-OPS3). Requirement: `resume-all` resumes only triggers in this plane's committed desired state with state `ENABLED` that were live `ENABLED` before the pause, never the roll receipt's `pausedTriggers` and never another estate's triggers |
| The maintenance job and its trigger in the desired state, with a cadence | `built` (D-OPS4): job `maintenance`, trigger `scheduler.maintenance`, `* * * * *`, committed `PAUSED`. Open: the first apply, and the resume (OPS-3) |
| The refresh cadence | Decided after the production-scale measurement (owner decisions round 15, C3). Production commits `schedule: null`, so pass 1 of the production apply creates no trigger (`SCHEDULER_CADENCE_UNSET`) and plans no pause. When the owner supplies the cadence it is committed, and a later plan creates the trigger `PAUSED` under its own digest (`docs/runbooks/gcp-production-apply.md`). A full-recompute run is about 50 min against a 14,400 s timeout, and the advisory lock refuses an overlapping run. Staging has none. No default |
| Confirmation that a pause updates `userUpdateTime` | Open (OPS2-READ). Pause a staging trigger and read it back before the 6 hour threshold is relied on |
| Periodic probe runner and notification target; alert on a refresh that exits 0 as `LOCK_HELD` or has no completed run | `not built` (E-OPS5) |
| Owner confirmation of the 6 hour threshold | Open |

## Evidence boundary

This is a draft runbook, not a deployment receipt. The scheduler probe, a
readback and a local check each prove only the read they name. Pausing,
resuming, rollout, edge switch and public deployment are separate gates, and
this document proves none of them.
