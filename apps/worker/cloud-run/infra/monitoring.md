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

Log-based metric filters and label extractors may read only the closed
fields in `ALLOWED_LOG_FIELDS`:

- the resource type, service name, job name and scheduler job id;
- the origin request line's `event`, `routeClass`, `status` and `code`;
- the analytics-refresh receipt's `schemaVersion`, `state` and `code`;
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

## scheduler-quiet

**Ticket.** This is the paused-too-long signal. A trigger committed `ENABLED`
made no attempt within the larger of 6 hours (the manifest's
`SCHEDULER_PAUSE_ALERT_THRESHOLD_HOURS`) and its cadence plus slack. Cloud
Scheduler has no paused-state metric, but a paused trigger makes no
attempts. Confirm with
`node scripts/gcp-infra.mjs scheduler-probe --environment=<env>` (exit 2 when
paused too long). If OPS-3 `pause-all` paused it for a rollout, finish the
rollout and run `resume-all` with that pause-all receipt.

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
name. The probe line lists them in plain text, because the owner says these
names are not confidential. This feeds the add-model scaffold (K-SCAFFOLD)
and the catalog manifest.

## unseen-tokens-silent

**Ticket.** The K-DETECT probe has logged nothing for 26 hours. Check its
job and trigger.
