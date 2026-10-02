/**
 * Monitoring and alerting as code for the IAM-private origin (OPS-5, E-OPS5).
 *
 *   renderMonitoring(desired, { notificationChannel }) -> the closed set of
 *     log-based metrics, uptime checks and alert policies for one plane, each
 *     with its deferral (if any), as Cloud Logging / Cloud Monitoring API bodies.
 *   scanMonitoringPrivacy(rendered) -> throws unless every filter, label
 *     extractor and query reads only allowlisted, content-free fields.
 *
 * Everything is derived from the validated desired state (OPS-2,
 * cloud-run/infra/<env>.desired-state.json) and the manifest's constants: no
 * name, host, cadence or connection limit is restated here. The notification
 * channel is the owner's input (OWN-5c); until it is given every alert policy
 * is deferred (NOTIFICATION_CHANNEL_UNASSIGNED), and its value is carried
 * into the rendered bodies only, never into a plan summary or receipt.
 *
 * What is rendered (docs: cloud-run/infra/monitoring.md, one anchor each):
 *
 *   origin-5xx-ratio       page    Cloud Run 5xx over all requests > 2 % for
 *                                  10 min, less the origin's own 503
 *                                  POSTGRES_ROUTE_NOT_PORTED answers (counted
 *                                  from its request log line, W3-CRA/CR-6).
 *   refresh-lock-held      ticket  any analytics-refresh receipt with state
 *                                  LOCK_HELD in the last hour.
 *   refresh-not-completed  page    no analytics-refresh receipt with state
 *                                  complete within cadence + slack: a lost
 *                                  lock exits 0, so a succeeded execution is
 *                                  not evidence of a run.
 *   scheduler-quiet        ticket  no Cloud Scheduler attempt of a trigger
 *                                  committed ENABLED within max(6 h, cadence
 *                                  + slack): the paused-too-long signal.
 *                                  Cloud Scheduler has no paused-state metric;
 *                                  a PAUSED trigger makes no attempt. This is
 *                                  a log-absence proxy, so the effective delay
 *                                  is the larger of the two: about 25 h for a
 *                                  daily trigger, not the owner's "a few
 *                                  hours" (a trade-off for OWN-5). One
 *                                  condition per trigger; a trigger that has
 *                                  no cadence yet or is committed PAUSED drops
 *                                  only its own condition (deferredConditions).
 *                                  The operator's exact check stays
 *                                  `gcp-infra.mjs scheduler-probe`.
 *   origin-lock            page    an unauthenticated uptime check of the
 *                                  service's run.app /api/health must get
 *                                  Google's front-end 403 (status exactly
 *                                  403, Google's body text); anything else
 *                                  fails the check.
 *   sql-cpu, sql-memory,   ticket  Cloud SQL utilisation over its bound for
 *   sql-disk,                      10 min; connections over 80 % of the
 *   sql-connections                committed max_connections.
 *   unseen-tokens          ticket  K-DETECT: a daily unseen-token probe line
 *                                  (cloud-run/unseen-token-probe.mjs) with
 *                                  verdict "unseen".
 *   unseen-tokens-silent   ticket  no completed probe report for 26 h. The
 *                                  metric counts only lines with a verdict
 *                                  (clear or unseen), so a probe that fails
 *                                  every day is silent, not healthy.
 *
 * A policy whose producer or input does not exist yet is rendered and
 * deferred with a closed reason (SCHEDULER_CADENCE_UNSET,
 * SCHEDULER_CADENCE_UNSUPPORTED (fires fewer than twice in 400 days),
 * TRIGGER_COMMITTED_PAUSED, PRODUCER_NOT_IN_MANIFEST:<job>,
 * NOTIFICATION_CHANNEL_UNASSIGNED), so applying it could never page on a
 * signal nothing emits. Absence and ratio conditions use Cloud Monitoring's
 * PromQL conditions; the PromQL names of log-based metrics
 * (logging_googleapis_com:user_<name>) and of Cloud Scheduler's attempt log
 * shape are assumptions to confirm at the first readback against the test
 * project, as OPS-2's readback was.
 */

import { canonicalJson } from "../src/canonical-json.ts";
import {
  JOB_NAMES,
  SCHEDULED_JOB_NAMES,
  SCHEDULER_PAUSE_ALERT_THRESHOLD_HOURS,
  deepFreeze,
  desiredStateDigest,
  fail,
  sha256Hex,
} from "./gcp-ops-infra-manifest.mjs";

export const GCP_OPS_MONITORING_RENDER_SCHEMA = "tibotattle-gcp-ops-monitoring-render-v1";
export const ALERT_SEVERITIES = Object.freeze(["page", "ticket", "info"]);
/** AlertPolicy.severity for each of ours (the API has no "info"). */
const API_SEVERITY = Object.freeze({ page: "CRITICAL", ticket: "ERROR", info: "WARNING" });
/** The maintained document every policy links to, one anchor per policy. */
export const MONITORING_RUNBOOK = "apps/worker/cloud-run/infra/monitoring.md";
export const MONITORING_POLICY_IDS = Object.freeze([
  "origin-5xx-ratio", "refresh-lock-held", "refresh-not-completed", "scheduler-quiet", "origin-lock",
  "sql-cpu", "sql-memory", "sql-disk", "sql-connections", "unseen-tokens", "unseen-tokens-silent",
]);
export const MONITORING_DEFERRALS = Object.freeze([
  "NOTIFICATION_CHANNEL_UNASSIGNED", "SCHEDULER_CADENCE_UNSET", "SCHEDULER_CADENCE_UNSUPPORTED",
  "TRIGGER_COMMITTED_PAUSED", "PRODUCER_NOT_IN_MANIFEST",
]);

/** The origin's request log line (W3-CRA cloud-run/postgres-host-dispatch.mjs ORIGIN_REQUEST_LOG_FIELDS, 3024a521). */
export const ORIGIN_REQUEST_LOG_CONTRACT = Object.freeze({
  fields: Object.freeze(["level", "severity", "event", "requestId", "method", "routeClass", "code", "status"]),
  events: Object.freeze(["request_failed", "request_pending", "request_unavailable"]),
  notPorted: Object.freeze({ status: 503, code: "POSTGRES_ROUTE_NOT_PORTED" }),
});
/** cloud-run/analytics-refresh.mjs ANALYTICS_REFRESH_RECEIPT_VERSION. */
export const ANALYTICS_REFRESH_RECEIPT_VERSION = "analytics-refresh-receipt-v1";
/** cloud-run/unseen-token-probe.mjs UNSEEN_TOKEN_PROBE_SCHEMA and its verdicts, and the job D-OPS4 would run it as. */
export const UNSEEN_TOKEN_PROBE_SCHEMA = "tibotattle-unseen-token-probe-v1";
export const UNSEEN_TOKEN_PROBE_VERDICTS = Object.freeze(["clear", "unseen"]);
export const UNSEEN_TOKEN_PROBE_JOB = "unseen-token-probe";
/** Cloud Scheduler's attempt log entry (to confirm at the first readback). */
export const SCHEDULER_ATTEMPT_LOG_TYPE = "type.googleapis.com/google.cloud.scheduler.logging.AttemptStarted";
/** Google's front-end text on a 403 for a caller without run.invoker. */
export const GOOGLE_FRONT_END_403_TEXT = "Your client does not have permission";
/** The only status the origin-lock check accepts. */
export const ORIGIN_LOCK_ACCEPTED_STATUSES = Object.freeze([403]);

export const MONITORING_THRESHOLDS = Object.freeze({
  originFiveXxRatio: 0.02,
  originFiveXxWindowMinutes: 10,
  cadenceSlackMinutes: 60,
  schedulerQuietMinimumHours: SCHEDULER_PAUSE_ALERT_THRESHOLD_HOURS,
  sqlCpuUtilization: 0.8,
  sqlMemoryUtilization: 0.9,
  sqlDiskUtilization: 0.8,
  sqlConnectionShare: 0.8,
  sqlWindowMinutes: 10,
  unseenProbeSilentHours: 26,
  uptimePeriodSeconds: 300,
});

/**
 * The only log fields a rendered filter or label extractor may read. None
 * holds a request id, URL, query, header, address, identity or payload.
 */
export const ALLOWED_LOG_FIELDS = Object.freeze([
  "resource.type",
  "resource.labels.service_name",
  "resource.labels.job_name",
  "resource.labels.job_id",
  "logName",
  "jsonPayload.event",
  "jsonPayload.routeClass",
  "jsonPayload.status",
  "jsonPayload.code",
  "jsonPayload.schemaVersion",
  "jsonPayload.state",
  "jsonPayload.schema",
  "jsonPayload.verdict",
  'jsonPayload."@type"',
]);
/** Fields that must never appear in a filter, extractor or query (the scanner's negative list). */
export const FORBIDDEN_LOG_FIELDS = Object.freeze([
  "jsonPayload.requestId", "jsonPayload.method", "jsonPayload.message", "jsonPayload.url", "jsonPayload.path",
  "jsonPayload.query", "jsonPayload.ip", "jsonPayload.email", "jsonPayload.token", "jsonPayload.unseen",
  "httpRequest", "textPayload", "protoPayload", "labels", "trace", "spanId", "operation", "sourceLocation",
  "resource.labels.revision_name", "resource.labels.configuration_name",
]);
/** PromQL labels a rendered query may match on. */
export const ALLOWED_QUERY_LABELS = Object.freeze([
  "monitored_resource", "project_id", "location", "service_name", "job_name", "job_id", "response_code_class",
  "routeClass", "status", "code", "state", "verdict", "database_id",
]);

const FIELD_REFERENCE = /(?<![\w.])(?:jsonPayload(?:\.(?:"[^"]+"|[A-Za-z_@][\w@]*))+|httpRequest(?:\.[A-Za-z_]\w*)*|textPayload|protoPayload(?:\.[A-Za-z_]\w*)*|resource\.type|resource\.labels\.[A-Za-z_]\w*|labels(?:\.(?:"[^"]+"|[A-Za-z_]\w*))+|logName|trace|spanId|operation(?:\.[A-Za-z_]\w*)*|sourceLocation(?:\.[A-Za-z_]\w*)*)/gu;
const QUERY_LABEL = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:=~|!~|!=|=)\s*"/gu;
const NOTIFICATION_CHANNEL = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/notificationChannels\/[0-9]{1,24}$/u;

// ---------------------------------------------------------------------------
// Cadence

const CRON_BOUNDS = Object.freeze([[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]);

function cronField(field, [minimum, maximum]) {
  const values = new Set();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    const [low, high] = range === "*" ? [minimum, maximum] : range.split("-").map(Number);
    const end = range === "*" || high !== undefined ? (high ?? maximum) : (stepText === undefined ? low : maximum);
    for (let value = low; value <= end; value += step) values.add(value);
  }
  return { values, star: field === "*" };
}

/**
 * The longest gap, in minutes, between consecutive fire times of a 5-field
 * cron (the grammar OPS-2's validator accepts, in UTC), over a 400-day window
 * that holds every month length; null when it fires fewer than twice there.
 */
export function cronMaxGapMinutes(schedule) {
  if (typeof schedule !== "string") fail("MONITORING_CADENCE_INVALID");
  const fields = schedule.split(" ");
  if (fields.length !== 5) fail("MONITORING_CADENCE_INVALID");
  const [minutes, hours, days, months, weekdays] = fields.map((field, index) => cronField(field, CRON_BOUNDS[index]));
  const start = Date.UTC(2027, 0, 1);
  let previous = null;
  let gap = null;
  // Day by day, then the matching minutes of a matching day.
  for (let day = 0; day < 400; day += 1) {
    const date = new Date(start + day * 86_400_000);
    const dayOfMonth = days.values.has(date.getUTCDate());
    const dayOfWeek = weekdays.values.has(date.getUTCDay());
    // Standard cron: with both day fields restricted, either may match.
    const dayMatches = days.star || weekdays.star ? dayOfMonth && dayOfWeek : dayOfMonth || dayOfWeek;
    if (!months.values.has(date.getUTCMonth() + 1) || !dayMatches) continue;
    for (const hour of [...hours.values].sort((a, b) => a - b)) {
      for (const minute of [...minutes.values].sort((a, b) => a - b)) {
        const at = start + day * 86_400_000 + hour * 3_600_000 + minute * 60_000;
        if (previous !== null) gap = Math.max(gap ?? 0, (at - previous) / 60_000);
        previous = at;
      }
    }
  }
  return gap;
}

// ---------------------------------------------------------------------------
// Rendering

function planePrefix(desired) {
  return desired.environment === "production" ? "tibotattle" : "tibotattle_staging";
}

/** The plane's resource name for an id: tibotattle[_staging]_<id with underscores>. */
export function monitoringName(desired, id) {
  return `${planePrefix(desired)}_${id.replaceAll("-", "_")}`;
}

function displayName(desired, id) {
  return `${planePrefix(desired).replaceAll("_", "-")}-${id}`;
}

function quote(value) {
  if (typeof value !== "string" || /["\\\n]/u.test(value)) fail("MONITORING_VALUE_INVALID");
  return `"${value}"`;
}

function promName(metric) {
  return `logging_googleapis_com:user_${metric}`;
}

function logMetric(desired, id, { description, filter, labels }) {
  return {
    kind: "log-metric",
    id,
    name: monitoringName(desired, id),
    body: {
      name: monitoringName(desired, id),
      description,
      filter,
      metricDescriptor: {
        metricKind: "DELTA",
        valueType: "INT64",
        unit: "1",
        labels: labels.map(({ key }) => ({ key, valueType: "STRING" })),
      },
      labelExtractors: Object.fromEntries(labels.map(({ key, field }) => [key, `EXTRACT(${field})`])),
    },
  };
}

function alertPolicy(desired, id, { severity, summary, conditions, notificationChannel }) {
  if (!ALERT_SEVERITIES.includes(severity) || !MONITORING_POLICY_IDS.includes(id)) fail("MONITORING_POLICY_INVALID");
  return {
    kind: "alert-policy",
    id,
    severity,
    name: displayName(desired, id),
    body: {
      displayName: displayName(desired, id),
      documentation: {
        content: `${summary}\n\nRunbook: ${MONITORING_RUNBOOK}#${id}`,
        mimeType: "text/markdown",
      },
      userLabels: { "managed-by": "tibotattle-ops-5", severity, environment: desired.environment },
      severity: API_SEVERITY[severity],
      combiner: "OR",
      conditions,
      notificationChannels: notificationChannel === null ? [] : [notificationChannel],
      alertStrategy: { autoClose: "86400s" },
    },
  };
}

function promCondition(displayName_, query, { duration = "0s" } = {}) {
  return { displayName: displayName_, conditionPrometheusQueryLanguage: { query, duration, evaluationInterval: "60s" } };
}

function thresholdCondition(displayName_, { filter, threshold, minutes }) {
  return {
    displayName: displayName_,
    conditionThreshold: {
      filter,
      comparison: "COMPARISON_GT",
      thresholdValue: threshold,
      duration: `${minutes * 60}s`,
      aggregations: [{ alignmentPeriod: "60s", perSeriesAligner: "ALIGN_MEAN" }],
      trigger: { count: 1 },
    },
  };
}

function windowText(minutes) {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

function triggerCadence(desired, job) {
  const trigger = desired.scheduler[job];
  if (trigger.schedule === null) return { deferred: "SCHEDULER_CADENCE_UNSET" };
  if (trigger.state !== "ENABLED") return { deferred: "TRIGGER_COMMITTED_PAUSED" };
  const gap = cronMaxGapMinutes(trigger.schedule);
  if (gap === null) return { deferred: "SCHEDULER_CADENCE_UNSUPPORTED" };
  return { gapMinutes: gap };
}

/**
 * scheduler-quiet's conditions, one per trigger ([{ job, cadence }]). A
 * trigger with no usable cadence, or committed PAUSED, drops only its own
 * condition (listed in deferredConditions), so one deferred trigger never
 * silences another's. The policy is deferred, with the first trigger's
 * reason, only when every condition is.
 */
export function schedulerQuietConditions(quiet) {
  if (!Array.isArray(quiet) || quiet.length === 0) fail("MONITORING_POLICY_INVALID");
  const live = quiet.filter(({ cadence }) => cadence.deferred === undefined);
  if (live.length === 0) return { conditions: quiet, deferred: quiet[0].cadence.deferred, deferredConditions: [] };
  return {
    conditions: live,
    deferred: null,
    deferredConditions: quiet.filter(({ cadence }) => cadence.deferred !== undefined)
      .map(({ job, cadence }) => ({ job, deferred: cadence.deferred })),
  };
}

/**
 * The plane's monitoring resources. `notificationChannel` is the owner's
 * projects/<p>/notificationChannels/<n> (OWN-5c) or null. Deterministic.
 */
export function renderMonitoring(desired, { notificationChannel = null } = {}) {
  if (notificationChannel !== null && (typeof notificationChannel !== "string"
      || !NOTIFICATION_CHANNEL.test(notificationChannel)
      || notificationChannel.split("/")[1] !== desired.project)) {
    fail("MONITORING_NOTIFICATION_CHANNEL_INVALID");
  }
  const service = desired.service.name;
  const refreshJob = desired.jobs["analytics-refresh"].name;
  const t = MONITORING_THRESHOLDS;
  const origin = ORIGIN_REQUEST_LOG_CONTRACT;

  const metrics = [
    logMetric(desired, "origin-request-failure", {
      description: "Origin request log lines (closed fields: routeClass, status, code).",
      filter: [`resource.type="cloud_run_revision"`, `resource.labels.service_name=${quote(service)}`,
        `jsonPayload.event=(${origin.events.map(quote).join(" OR ")})`].join(" AND "),
      labels: [{ key: "routeClass", field: "jsonPayload.routeClass" }, { key: "status", field: "jsonPayload.status" },
        { key: "code", field: "jsonPayload.code" }],
    }),
    logMetric(desired, "analytics-refresh-outcome", {
      description: "analytics-refresh receipts and failures (closed fields: state, code).",
      filter: [`resource.type="cloud_run_job"`, `resource.labels.job_name=${quote(refreshJob)}`,
        `jsonPayload.schemaVersion=${quote(ANALYTICS_REFRESH_RECEIPT_VERSION)}`].join(" AND "),
      labels: [{ key: "state", field: "jsonPayload.state" }, { key: "code", field: "jsonPayload.code" }],
    }),
    logMetric(desired, "scheduler-attempt", {
      description: "Cloud Scheduler attempts of the plane's managed triggers.",
      filter: [`resource.type="cloud_scheduler_job"`,
        `resource.labels.job_id=(${SCHEDULED_JOB_NAMES.map((job) => quote(desired.scheduler[job].name)).join(" OR ")})`,
        `jsonPayload."@type"=${quote(SCHEDULER_ATTEMPT_LOG_TYPE)}`].join(" AND "),
      labels: [],
    }),
    logMetric(desired, "unseen-token-probe", {
      // Completed reports only: a failure line carries the schema but no
      // verdict, and must read as silence, not as a run.
      description: "K-DETECT unseen-token probe reports (closed field: verdict).",
      filter: [`resource.type="cloud_run_job"`, `jsonPayload.schema=${quote(UNSEEN_TOKEN_PROBE_SCHEMA)}`,
        `jsonPayload.verdict=(${UNSEEN_TOKEN_PROBE_VERDICTS.map(quote).join(" OR ")})`].join(" AND "),
      labels: [{ key: "verdict", field: "jsonPayload.verdict" }],
    }),
  ];
  const metricName = (id) => promName(monitoringName(desired, id));

  const uptime = {
    kind: "uptime-check",
    id: "origin-lock",
    name: displayName(desired, "origin-lock"),
    body: {
      displayName: displayName(desired, "origin-lock"),
      monitoredResource: { type: "uptime_url", labels: { project_id: desired.project, host: desired.service.host } },
      httpCheck: {
        requestMethod: "GET",
        path: "/api/health",
        port: 443,
        useSsl: true,
        validateSsl: true,
        acceptedResponseStatusCodes: ORIGIN_LOCK_ACCEPTED_STATUSES.map((statusValue) => ({ statusValue })),
      },
      contentMatchers: [{ content: GOOGLE_FRONT_END_403_TEXT, matcher: "CONTAINS_STRING" }],
      period: `${t.uptimePeriodSeconds}s`,
      timeout: "10s",
    },
  };

  const policies = [];
  const add = (id, options, deferred = null, deferredConditions = []) => {
    const policy = alertPolicy(desired, id, { ...options, notificationChannel });
    const reason = deferred ?? (notificationChannel === null ? "NOTIFICATION_CHANNEL_UNASSIGNED" : null);
    policies.push({ ...policy, ...(reason === null ? {} : { deferred: reason }),
      ...(deferredConditions.length === 0 ? {} : { deferredConditions }) });
  };

  const notPorted = `${metricName("origin-request-failure")}{monitored_resource="cloud_run_revision",`
    + `service_name=${quote(service)},status="${origin.notPorted.status}",code=${quote(origin.notPorted.code)}}`;
  const requests = (extra = "") => `run_googleapis_com:request_count{monitored_resource="cloud_run_revision",`
    + `service_name=${quote(service)}${extra}}`;
  const window = `${t.originFiveXxWindowMinutes}m`;
  add("origin-5xx-ratio", {
    severity: "page",
    summary: `Origin 5xx share over ${t.originFiveXxRatio * 100} % for ${t.originFiveXxWindowMinutes} min, `
      + "excluding 503 POSTGRES_ROUTE_NOT_PORTED.",
    conditions: [promCondition("origin 5xx ratio",
      `(sum(rate(${requests(',response_code_class="5xx"')}[${window}])) - (sum(rate(${notPorted}[${window}])) or vector(0)))`
      + ` / sum(rate(${requests()}[${window}])) > ${t.originFiveXxRatio}`, { duration: `${t.originFiveXxWindowMinutes * 60}s` })],
  });
  add("refresh-lock-held", {
    severity: "ticket",
    summary: "An analytics-refresh run found the refresh lock held (LOCK_HELD) and wrote nothing.",
    conditions: [promCondition("refresh LOCK_HELD",
      `sum(increase(${metricName("analytics-refresh-outcome")}{monitored_resource="cloud_run_job",`
      + `job_name=${quote(refreshJob)},state="LOCK_HELD"}[1h])) > 0`)],
  });
  const refreshCadence = triggerCadence(desired, "analytics-refresh");
  add("refresh-not-completed", {
    severity: "page",
    summary: "No analytics-refresh run completed within its cadence plus slack (a lost lock exits 0).",
    conditions: [promCondition("refresh completion absent",
      `absent_over_time(${metricName("analytics-refresh-outcome")}{monitored_resource="cloud_run_job",`
      + `job_name=${quote(refreshJob)},state="complete"}[${windowText((refreshCadence.gapMinutes ?? 0)
        + t.cadenceSlackMinutes)}])`)],
  }, refreshCadence.deferred ?? null);
  const quiet = schedulerQuietConditions(SCHEDULED_JOB_NAMES.map((job) => ({ job, cadence: triggerCadence(desired, job) })));
  add("scheduler-quiet", {
    severity: "ticket",
    summary: `A trigger committed ENABLED made no attempt within max(${t.schedulerQuietMinimumHours} h, cadence `
      + "plus slack): paused too long, or broken. Confirm with `gcp-infra.mjs scheduler-probe`.",
    conditions: quiet.conditions.map(({ job, cadence }) => promCondition(`${job} trigger quiet`,
      `absent_over_time(${metricName("scheduler-attempt")}{monitored_resource="cloud_scheduler_job",`
      + `job_id=${quote(desired.scheduler[job].name)}}[${windowText(Math.max(t.schedulerQuietMinimumHours * 60,
        (cadence.gapMinutes ?? 0) + t.cadenceSlackMinutes))}])`)),
  }, quiet.deferred, quiet.deferredConditions);
  add("origin-lock", {
    severity: "page",
    summary: "The run.app origin answered an unauthenticated request with something other than Google's 403.",
    conditions: [{
      displayName: "origin-lock uptime check failing",
      conditionThreshold: {
        // The check id is assigned at create; the host names this plane's check.
        filter: `metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url"`
          + ` AND resource.label.host=${quote(desired.service.host)}`,
        comparison: "COMPARISON_GT",
        thresholdValue: 1,
        duration: "600s",
        aggregations: [{ alignmentPeriod: "1200s", perSeriesAligner: "ALIGN_NEXT_OLDER",
          crossSeriesReducer: "REDUCE_COUNT_FALSE", groupByFields: ["resource.label.host"] }],
        trigger: { count: 1 },
      },
    }],
  });
  const database = `${desired.project}:${desired.cloudSql.instance}`;
  const sql = (metric) => `metric.type="cloudsql.googleapis.com/database/${metric}" AND resource.type="cloudsql_database"`
    + ` AND resource.label.database_id=${quote(database)}`;
  add("sql-cpu", { severity: "ticket", summary: "Cloud SQL CPU utilisation high.",
    conditions: [thresholdCondition("cpu", { filter: sql("cpu/utilization"), threshold: t.sqlCpuUtilization,
      minutes: t.sqlWindowMinutes })] });
  add("sql-memory", { severity: "ticket", summary: "Cloud SQL memory utilisation high.",
    conditions: [thresholdCondition("memory", { filter: sql("memory/utilization"), threshold: t.sqlMemoryUtilization,
      minutes: t.sqlWindowMinutes })] });
  add("sql-disk", { severity: "ticket", summary: "Cloud SQL disk utilisation high.",
    conditions: [thresholdCondition("disk", { filter: sql("disk/utilization"), threshold: t.sqlDiskUtilization,
      minutes: t.sqlWindowMinutes })] });
  add("sql-connections", { severity: "ticket",
    summary: `PostgreSQL backends over ${t.sqlConnectionShare * 100} % of max_connections `
      + `(${desired.cloudSql.maxConnections}).`,
    conditions: [thresholdCondition("connections", { filter: sql("postgresql/num_backends"),
      threshold: Math.floor(desired.cloudSql.maxConnections * t.sqlConnectionShare), minutes: t.sqlWindowMinutes })] });
  const probeProducer = JOB_NAMES.includes(UNSEEN_TOKEN_PROBE_JOB) ? null
    : `PRODUCER_NOT_IN_MANIFEST:${UNSEEN_TOKEN_PROBE_JOB}`;
  add("unseen-tokens", {
    severity: "ticket",
    summary: "The daily K-DETECT probe found model, speed, tier or plan tokens the bundled catalog does not name.",
    conditions: [promCondition("unseen tokens", `sum(increase(${metricName("unseen-token-probe")}`
      + `{monitored_resource="cloud_run_job",verdict="unseen"}[1d])) > 0`)],
  }, probeProducer);
  add("unseen-tokens-silent", {
    severity: "ticket",
    summary: `The K-DETECT probe completed no report (verdict clear or unseen) for ${t.unseenProbeSilentHours} h; `
      + "failed runs do not count.",
    conditions: [promCondition("unseen-token probe silent", `absent_over_time(${metricName("unseen-token-probe")}`
      + `{monitored_resource="cloud_run_job"}[${t.unseenProbeSilentHours}h])`)],
  }, probeProducer);

  const rendered = {
    schema: GCP_OPS_MONITORING_RENDER_SCHEMA,
    environment: desired.environment,
    project: desired.project,
    desiredStateDigest: desiredStateDigest(desired),
    notificationChannel: notificationChannel === null ? "unassigned" : "assigned",
    metrics,
    uptimeChecks: [uptime],
    policies,
  };
  scanMonitoringPrivacy(rendered);
  return deepFreeze(rendered);
}

/** sha256 of the canonical rendered set; the channel enters only as its hash. */
export function renderedDigest(rendered) {
  return sha256Hex(canonicalJson(rendered));
}

// ---------------------------------------------------------------------------
// Privacy scanner

function scanFilter(text, where) {
  for (const forbidden of FORBIDDEN_LOG_FIELDS) {
    const pattern = new RegExp(`(?<![\\w.])${forbidden.replaceAll(".", "\\.")}(?![\\w])`, "u");
    if (pattern.test(text)) fail(`MONITORING_FIELD_FORBIDDEN:${where}:${forbidden}`);
  }
  for (const [field] of text.matchAll(FIELD_REFERENCE)) {
    if (!ALLOWED_LOG_FIELDS.includes(field)) fail(`MONITORING_FIELD_NOT_ALLOWLISTED:${where}:${field}`);
  }
}

function scanQuery(text, where) {
  for (const [, label] of text.matchAll(QUERY_LABEL)) {
    if (!ALLOWED_QUERY_LABELS.includes(label)) fail(`MONITORING_QUERY_LABEL_NOT_ALLOWLISTED:${where}:${label}`);
  }
  for (const forbidden of ["requestId", "url", "path", "ip", "email", "token", "method"]) {
    if (new RegExp(`[{,]\\s*${forbidden}\\s*(?:=|!=|=~|!~)`, "u").test(text)) {
      fail(`MONITORING_FIELD_FORBIDDEN:${where}:${forbidden}`);
    }
  }
}

/**
 * Throws MONITORING_FIELD_FORBIDDEN or MONITORING_*_NOT_ALLOWLISTED unless
 * every log filter and label extractor reads only ALLOWED_LOG_FIELDS and
 * every PromQL query matches only ALLOWED_QUERY_LABELS.
 */
export function scanMonitoringPrivacy(rendered) {
  for (const metric of rendered.metrics) {
    scanFilter(metric.body.filter, metric.id);
    for (const [key, extractor] of Object.entries(metric.body.labelExtractors)) {
      const match = /^EXTRACT\((.+)\)$/u.exec(extractor);
      if (match === null) fail(`MONITORING_EXTRACTOR_INVALID:${metric.id}:${key}`);
      scanFilter(match[1], `${metric.id}:${key}`);
      if (!ALLOWED_LOG_FIELDS.includes(match[1])) fail(`MONITORING_FIELD_NOT_ALLOWLISTED:${metric.id}:${match[1]}`);
    }
  }
  for (const policy of rendered.policies) {
    for (const condition of policy.body.conditions) {
      if (condition.conditionPrometheusQueryLanguage !== undefined) {
        scanQuery(condition.conditionPrometheusQueryLanguage.query, policy.id);
      } else {
        scanFilter(condition.conditionThreshold.filter, policy.id);
      }
    }
  }
  for (const check of rendered.uptimeChecks) {
    const accepted = check.body.httpCheck.acceptedResponseStatusCodes.map(({ statusValue }) => statusValue);
    if (JSON.stringify(accepted) !== JSON.stringify(ORIGIN_LOCK_ACCEPTED_STATUSES)
        || check.body.httpCheck.headers !== undefined || check.body.httpCheck.authInfo !== undefined) {
      fail("MONITORING_ORIGIN_LOCK_INVALID");
    }
  }
  return true;
}
