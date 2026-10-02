# GCP origin monitoring and alerting

This is the runbook that every alert policy links to. Each policy's
documentation links to `#<policy id>` here. The policies are code in
`scripts/gcp-ops-monitoring-policies.mjs` (OPS-5, E-OPS5).
`scripts/gcp-monitoring.mjs` renders them, reads them back and plans them.

**Status (2026-10-02):** the policies have been rendered, planned and
tested offline only. Nothing has been created in any project, and no apply
command exists yet. The PromQL names of log-based metrics and the shape of
Cloud Scheduler's attempt log are assumptions until the first readback
against the test project. Until the owner supplies the notification channel
(OWN-5c), every alert policy is deferred with
`NOTIFICATION_CHANNEL_UNASSIGNED`.

## Commands

```sh
node scripts/gcp-monitoring.mjs render --environment=staging [--notification-channel=projects/<p>/notificationChannels/<n>]
node scripts/gcp-monitoring.mjs readback --environment=staging
node scripts/gcp-monitoring.mjs plan --environment=staging [--notification-channel=...]
node scripts/gcp-monitoring.mjs origin-lock-probe --environment=staging
```

- **render** makes no call.
- **readback** and **plan** issue three list calls only: logging metrics,
  uptime checks and alert policies.
- **origin-lock-probe** sends one unauthenticated request. The CLI never
  prints the channel's value.

## Privacy contract

Log-based metric filters, label extractors and value extractors may read
only the closed fields in `ALLOWED_LOG_FIELDS`:

- the resource type, service name, job name and scheduler job id;
- the origin request line's `event`, `routeClass`, `status` and `code`;
- the analytics-refresh receipt's `schemaVersion`, `state`, `status` and
  `code`, and two numbers from a completed receipt: `memory.accountMiB` and
  `memory.effectiveOutputBudgetMiB` (value extractors only, never labels);
- the K-DETECT probe's `schema` and `verdict`;
- Cloud Scheduler's entry type.

`scanMonitoringPrivacy` refuses every other field. It names the forbidden
ones explicitly: request ids, methods, URLs and paths, queries, addresses,
`httpRequest`, `textPayload`, `protoPayload` and trace fields. PromQL queries
may match only `ALLOWED_QUERY_LABELS`.

## Deferrals

A policy is rendered but deferred, with one closed reason, until its signal
exists:

| Deferral | Meaning |
|---|---|
| `NOTIFICATION_CHANNEL_UNASSIGNED` | OWN-5c: there is no notification channel yet |
| `SCHEDULER_CADENCE_UNSET` | The trigger has no committed cadence (decision D3) |
| `SCHEDULER_CADENCE_UNSUPPORTED` | The cadence fires fewer than twice in 400 days, so no absence window fits |
| `TRIGGER_COMMITTED_PAUSED` | The trigger is committed `PAUSED`, so no attempts or runs are expected |
| `PRODUCER_NOT_IN_MANIFEST:<job>` | No manifest job emits the signal yet (D-OPS4 adds the jobs and probes) |

A policy with one condition per trigger (scheduler-quiet) defers per
trigger instead. A trigger with no usable cadence, or one committed
`PAUSED`, drops only its own condition, and the policy lists it in
`deferredConditions` (the plan repeats that list). The policy waits as a
whole only when every trigger's condition does.

## origin-5xx-ratio

**Page.** For 10 minutes, Cloud Run's 5xx responses exceed 2 % of all
requests. The origin's own `503 POSTGRES_ROUTE_NOT_PORTED` answers are
subtracted first. Those are counted from its request log line, which is
contained by design until D-CRB ports the route.

1. Read the request log line's `routeClass` and `code` labels to find which
   route class fails.
2. A platform 5xx has no origin line. This is a cold start, an exhausted
   instance limit or a timeout: check the revision and its instance count.
3. Brake to fenced if the edge is in gcp mode and the cause is not quickly
   understood (OWN-10).

## refresh-lock-held

**Ticket.** An analytics-refresh run exited 0 with `LOCK_HELD`, so another
run held the refresh lock and this one wrote nothing. Repeated runs mean
either overlapping executions or a lock that was never released. Check for
an execution that is still running before changing the cadence.

## refresh-not-completed

**Page.** No analytics-refresh receipt with `state: complete` arrived within
the trigger's longest cadence gap plus 60 minutes. A run that lost the lock
also exits 0, so a succeeded execution does not count as a run. Check the
trigger first (scheduler-quiet), then the job's failure line (`code`), then
`LOCK_HELD`.

## refresh-output-headroom

**Ticket.** One policy, two conditions, read from what the refresh already
logs (C-REFRESH, `cloud-run/analytics-refresh.mjs`):

- **Near budget.** Over the trigger's longest cadence gap plus 60 minutes,
  the completed receipts' output account (`memory.accountMiB`) exceeds 80 %
  of their effective output budget (`memory.effectiveOutputBudgetMiB`, the
  budget after the per-owner reclaim). Two distribution log metrics carry
  the two numbers from receipts with `status: "ok"`; the condition divides
  their sums. With one run per window this is that run's share. 80 % is a
  starting value, like round 9's resource alerts; tune it after a week of
  real runs.
- **Exceeded.** A failure line with `code: ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED`
  in the last hour. That run refused mid-run and wrote nothing, so
  refresh-not-completed also pages once its window passes. The failure line
  carries `outputAccount` (`accountMiB`, `outputBudgetMiB`).

The policy waits with the refresh trigger: it is deferred whenever
refresh-not-completed is (no cadence, or committed `PAUSED`).

What to do: read the receipt's `memory` block (`accountMiB`,
`effectiveOutputBudgetMiB`, `largestOwnerOutputMiB`, `heldInputMiB`) and
`ownersComputed`. Growth with history or roster is expected: the C-REFRESH
receipt projects the dense profile's budget to hold its planning roster for
about 641 days. The remedies are incremental refresh (decision D3, revised)
or a larger task memory profile (OWN-5), not a smaller history.

## scheduler-quiet

**Ticket.** This is the paused-too-long signal. A trigger committed `ENABLED`
made no attempt within the larger of 6 hours (the manifest's
`SCHEDULER_PAUSE_ALERT_THRESHOLD_HOURS`) and its cadence plus slack. Cloud
Scheduler has no paused-state metric, but a paused trigger makes no
attempts. Confirm with
`node scripts/gcp-infra.mjs scheduler-probe --environment=<env>` (exit 2 when
paused too long). If OPS-3 `pause-all` paused it for a rollout, finish the
rollout and run `resume-all` with that pause-all receipt.

**Open owner item (OWN-5): the alert does not enforce 6 hours.** On
2026-10-02 (round 9, "Alert thresholds") the owner accepted "scheduler
paused > 6 h" as a starting value. This policy cannot alert at 6 hours for
a daily trigger:

- It is a log-absence proxy. It fires only after the larger of 6 hours and
  the cadence plus 60 minutes, which is about 25 hours for a daily trigger.
  The 6-hour floor binds only for a trigger that fires at least every 5
  hours.
- The exact 6-hour signal is the scheduler probe's
  `SCHEDULER_TRIGGER_PAUSED_TOO_LONG`. Only an operator runs the probe: no
  scheduled job runs it yet.
- Round 9 records only the 6-hour value. It does not acknowledge the
  proxy's delay.

The owner has two options:

- accept the roughly 25-hour proxy explicitly;
- ask for a periodic job that runs the probe and logs its verdict, with a
  log metric and an alert on it.

Until the owner chooses, a paused daily trigger alerts after about 25
hours, not 6. The operator's probe is the only 6-hour check.

## origin-lock

**Page.** An unauthenticated GET of the service's `run.app` `/api/health`
did not get exactly Google's front-end 403. The uptime check accepts only
status 403 with Google's body text. Any 2xx, a 403 from the application
(JSON with the origin marker) or any other status fails the check. This
means the service may be publicly invokable. Read its IAM policy
(`gcp-infra.mjs readback`) and remove any `allUsers` or
`allAuthenticatedUsers` member by hand. OPS-2 refuses to plan that
deletion. Then rerun `gcp-monitoring.mjs origin-lock-probe`.

## sql-cpu

**Ticket.** Cloud SQL CPU utilisation has been above 80 % for 10 minutes.
Check the analytics refresh and the maintenance pass before the request
path.

## sql-memory

**Ticket.** Cloud SQL memory utilisation has been above 90 % for 10 minutes.

## sql-disk

**Ticket.** Cloud SQL disk utilisation has been above 80 % for 10 minutes.
Storage auto-resize is on (`CLOUD_SQL_POSTURE`), and a resize can never be
reverted. Find what is growing before raising `storageSizeGb` in the desired
state.

## sql-connections

**Ticket.** PostgreSQL backends have been above 80 % of the committed
`max_connections` for 10 minutes. Compare them with the desired state's
connection budget, which covers service, job and rollout overlap.

## unseen-tokens

**Ticket.** The daily K-DETECT probe (`cloud-run/unseen-token-probe.mjs`)
found model, speed, tier or plan tokens that the bundled catalog does not
name. This feeds the add-model scaffold (K-SCAFFOLD) and the catalog
manifest.

- A token that fits the v1.x wire grammar (`[A-Za-z0-9._:-]`, 1 to 64
  characters; owner decision, round 7) is **unseen**.
- Any other token is **unrecognized**: for example an ARN with `/`, an email
  address, or a name over 64 characters. It is counted and never printed.
- **The probe line lists in-grammar unseen names** (`UNSEEN_TOKEN_LISTING`
  is `plain`; owner decision, round 11). Per dimension it lists at most 50
  unseen tokens (`UNSEEN_TOKEN_LIST_LIMIT`), most records first, each with
  its record count, and counts the rest in `unseenOverflow`. It also
  carries the number of distinct unseen tokens and their records, and the
  number of unrecognized ones. Out-of-grammar strings are only counted,
  never listed. Read the probe's own log line for the names: the log metric
  extracts only the verdict.
- These names are vocabulary, not account IDs (root `AGENTS.md`;
  [decision record](../../../../docs/decisions/2026-10-02-catalog-vocabulary-plain-text.md)).
  The probe still has no manifest job (D-OPS4), so the policy stays
  deferred with `PRODUCER_NOT_IN_MANIFEST:unseen-token-probe`.

## unseen-tokens-silent

**Ticket.** The K-DETECT probe has completed no report (verdict `clear` or
`unseen`) for 26 hours. The log metric counts only lines that carry a
verdict. A failed run writes a line with `status: "failed"` and a closed
`code`, but no verdict, so a probe that fails every day shows up here as
silence. Check the job's failure lines (`code`) first, then its trigger.
