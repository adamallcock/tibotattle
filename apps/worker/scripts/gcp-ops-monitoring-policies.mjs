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
 *                                  10 min, with at least 5 net 5xx answers in
 *                                  the window, both counts net of the
 *                                  deliberate unported answers: each an exact
 *                                  route path plus its code
 *                                  (ORIGIN_5XX_EXCLUSIONS), counted from the
 *                                  origin's request log line (W3-CRA/CR-6),
 *                                  never a code alone. It reads only what
 *                                  reaches Cloud Run: an answer the edge makes
 *                                  itself is outside its inputs.
 *   refresh-lock-held      ticket  any analytics-refresh receipt with state
 *                                  LOCK_HELD in the last hour.
 *   refresh-not-completed  page    no analytics-refresh receipt with state
 *                                  complete within cadence + slack: a lost
 *                                  lock exits 0, so a succeeded execution is
 *                                  not evidence of a run.
 *   refresh-output-headroom ticket a completed analytics-refresh receipt
 *                                  whose memory.accountMiB exceeds 80 % of
 *                                  its memory.effectiveOutputBudgetMiB within
 *                                  cadence + slack, or any failure line with
 *                                  code ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED in
 *                                  the last hour (that run published nothing;
 *                                  refresh-not-completed pages for it).
 *   scheduler-quiet        ticket  no Cloud Scheduler attempt of a trigger
 *                                  committed ENABLED within max(6 h, cadence
 *                                  + slack): the paused-too-long signal.
 *                                  Cloud Scheduler has no paused-state metric;
 *                                  a PAUSED trigger makes no attempt. This is
 *                                  a log-absence proxy, so the effective delay
 *                                  is the larger of the two: about 25 h for a
 *                                  daily trigger. DECIDED: the owner accepted
 *                                  that delay for a daily trigger, with no
 *                                  probe job (round 11, 2026-10-02). One
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
 *   edge-health            page    an unauthenticated uptime check of the
 *                                  plane's public /api/health, through the
 *                                  Cloudflare edge, must get 200 with status
 *                                  ok. In gcp mode the origin answers it, so
 *                                  an edge-to-origin outage (503
 *                                  EDGE_ORIGIN_UNAVAILABLE), which Cloud Run
 *                                  never sees, fails the check.
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
 * PUBLIC_ORIGIN_UNASSIGNED, NOTIFICATION_CHANNEL_UNASSIGNED), so applying it
 * could never page on a signal nothing emits. Absence and ratio conditions
 * use Cloud Monitoring's PromQL conditions; the PromQL names of log-based
 * metrics (logging_googleapis_com:user_<name>), how increase() extrapolates
 * them, and the shape of Cloud Scheduler's attempt log are assumptions to
 * confirm at the first readback against the test project, as OPS-2's
 * readback was.
 */

import { canonicalJson } from "../src/canonical-json.ts";
import { WORKER_ROUTE_POLICY, matchWorkerRoute } from "../src/route-registry.ts";
import { PRODUCTION_PUBLIC_ORIGIN } from "../cloud-run/postgres-production-configuration.mjs";
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
  "origin-5xx-ratio", "refresh-lock-held", "refresh-not-completed", "refresh-output-headroom", "scheduler-quiet",
  "origin-lock", "edge-health",
  "sql-cpu", "sql-memory", "sql-disk", "sql-connections", "unseen-tokens", "unseen-tokens-silent",
]);
export const MONITORING_DEFERRALS = Object.freeze([
  "NOTIFICATION_CHANNEL_UNASSIGNED", "SCHEDULER_CADENCE_UNSET", "SCHEDULER_CADENCE_UNSUPPORTED",
  "TRIGGER_COMMITTED_PAUSED", "PRODUCER_NOT_IN_MANIFEST", "PUBLIC_ORIGIN_UNASSIGNED",
]);

/** The origin's request log line (W3-CRA cloud-run/postgres-host-dispatch.mjs ORIGIN_REQUEST_LOG_FIELDS, 3024a521). */
export const ORIGIN_REQUEST_LOG_CONTRACT = Object.freeze({
  fields: Object.freeze(["level", "severity", "event", "requestId", "method", "routeClass", "code", "status"]),
  events: Object.freeze(["request_failed", "request_pending", "request_unavailable"]),
  notPorted: Object.freeze({ status: 503, code: "POSTGRES_ROUTE_NOT_PORTED" }),
});
/** cloud-run/analytics-refresh.mjs ANALYTICS_REFRESH_RECEIPT_VERSION. */
export const ANALYTICS_REFRESH_RECEIPT_VERSION = "analytics-refresh-receipt-v1";
/**
 * The refresh's output-headroom figures (C-REFRESH). A completed run's stdout
 * receipt (status "ok") carries memory.accountMiB (the output account, MiB
 * rounded up) and memory.effectiveOutputBudgetMiB (the budget after the
 * per-owner reclaim, MiB rounded down); either is null when the run held no
 * account. A refused run's stderr line carries code
 * ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED (src/analytics-v2/compute.ts) and
 * outputAccount {accountMiB, outputBudgetMiB}. The check pins these names to
 * cloud-run/analytics-refresh.mjs.
 */
export const REFRESH_OUTPUT_HEADROOM_CONTRACT = Object.freeze({
  okStatus: "ok",
  accountField: "jsonPayload.memory.accountMiB",
  budgetField: "jsonPayload.memory.effectiveOutputBudgetMiB",
  exceededCode: "ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED",
});
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
/**
 * The edge-health check: an unauthenticated GET of the plane's public
 * /api/health, through the Cloudflare edge, must answer exactly 200 with
 * status ok. The Worker answers it in worker mode, barrier health in fenced
 * mode and the Cloud Run origin in gcp mode (thin edge decision, section 11),
 * so in gcp mode it fails on the edge's own 503 EDGE_ORIGIN_UNAVAILABLE or
 * EDGE_NOT_CONFIGURED, which never reach Cloud Run.
 */
export const EDGE_HEALTH_ACCEPTED_STATUSES = Object.freeze([200]);
export const EDGE_HEALTH_OK_TEXT = '"status":"ok"';

/**
 * The deliberate unported answers origin-5xx-ratio leaves out, each by an
 * exact WORKER_ROUTE_POLICY pathname plus its status and code, never by a
 * code alone. The origin's request log line carries no path: it carries
 * routeClass, which matchWorkerRoute binds one-to-one to an exact pathname
 * (routeClass is the route id), so each entry renders as that routeClass
 * together with its code. Cloud Run's own request log carries the status but
 * not the body's code, and its URL (httpRequest) is outside the privacy
 * contract.
 * - round 12 (2026-10-02): the native social chain (Google, Apple, legacy
 *   /api/v1/enroll), security reset, and the performance device and consent
 *   routes are retired;
 * - OD-CR-2 (round 1): participant export is retired;
 * - C-ADMIN: an admin task with no PostgreSQL port answers 503
 *   POSTGRES_ROUTE_NOT_PORTED on the admin action route.
 * v0.x uploads (retired in round 12) answer d43c8f92's definite 403
 * TELEMETRY_TRANSPORT_BLOCKED since round 19 (a retired v0.1 or v0.2
 * envelope on /api/v1/contributions, a retired format on
 * /api/v1/device/upload-authorizations; RETIRED_FORMAT_ANSWER in
 * cloud-run/upload-authorization-formats.mjs), a 4xx this alert never
 * counts. Both paths stay never excluded (ORIGIN_5XX_NEVER_EXCLUDED_PATHS):
 * they are shared with every live v1 upload, and an exclusion keys only on
 * routeClass, status and code, never on the schema version, so excluding
 * either would hide a live upload's 5xx.
 * The accountless performance authorization is not excluded either: round
 * 19 has it answer production's sequence (a 4xx, or the Worker's own
 * configuration, containment, storage or admission 503) and then the
 * definite 403 TELEMETRY_TRANSPORT_BLOCKED, never the unported 503, so a 5xx
 * from it counts like any live route's.
 */
export const ORIGIN_5XX_EXCLUSIONS = Object.freeze([
  ["/api/v1/enroll", "round-12"],
  ["/api/v1/identity/google/start", "round-12"],
  ["/api/v1/identity/google/callback", "round-12"],
  ["/api/v1/identity/google/result", "round-12"],
  ["/api/v1/identity/apple/start", "round-12"],
  ["/api/v1/identity/apple/callback", "round-12"],
  ["/api/v1/identity/apple/result", "round-12"],
  ["/api/v1/me/security-reset", "round-12"],
  ["/api/v1/device/telemetry/performance/capabilities", "round-12"],
  ["/api/v1/me/device-telemetry-performance-consents", "round-12"],
  ["/api/v1/device/telemetry/performance/reports", "round-12"],
  ["/api/v1/me/export", "od-cr-2"],
  ["/api/v1/admin/action", "c-admin"],
].map(([path, decision]) => Object.freeze({
  path,
  status: ORIGIN_REQUEST_LOG_CONTRACT.notPorted.status,
  code: ORIGIN_REQUEST_LOG_CONTRACT.notPorted.code,
  decision,
})));
/** The only codes an exclusion may name. */
export const ORIGIN_5XX_EXCLUDABLE_CODES = Object.freeze([ORIGIN_REQUEST_LOG_CONTRACT.notPorted.code]);
/**
 * Codes an exclusion may never name; the refusal is a guard only. The
 * loopback test dispatcher's refusal is never a deliberate answer, and counts
 * as a 5xx if a deployed origin ever gives it. The edge's own
 * EDGE_ORIGIN_UNAVAILABLE is made at the Cloudflare edge and never reaches
 * Cloud Run, so it is outside origin-5xx-ratio's inputs altogether:
 * edge-health watches that path.
 */
export const ORIGIN_5XX_NEVER_EXCLUDED_CODES = Object.freeze([
  "POSTGRES_TEST_ROUTE_UNSUPPORTED",
  "EDGE_ORIGIN_UNAVAILABLE",
]);
/**
 * Exact paths that are never excluded, whatever the code: the two live
 * upload routes v0.x shares (a v0.x upload answers a 4xx since round 19, and
 * any 5xx on these paths stays counted), the accountless performance
 * authorization (production's answer sequence, never the unported 503;
 * round 19), and the renew and disconnect routes round 12 keeps.
 */
export const ORIGIN_5XX_NEVER_EXCLUDED_PATHS = Object.freeze([
  "/api/v1/contributions",
  "/api/v1/device/upload-authorizations",
  "/api/v1/accountless/telemetry-performance-authorization",
  "/api/v1/device/credential/renew",
  "/api/v1/device/disconnect",
]);
const ROUTE_CLASS = /^[a-z][a-z0-9_]*$/u;
const EXCLUSION_KEYS = Object.freeze(["code", "decision", "path", "status"]);

/**
 * Validate an exclusion table: each entry names an exact WORKER_ROUTE_POLICY
 * pathname, a 5xx status and an excludable code (with that code's own
 * status), once. Returns the entries with their routeClass; throws
 * MONITORING_5XX_EXCLUSION_* otherwise.
 */
export function originFiveXxExclusions(entries) {
  if (!Array.isArray(entries)) fail("MONITORING_5XX_EXCLUSION_INVALID");
  const seen = new Set();
  return Object.freeze(entries.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)
        || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(EXCLUSION_KEYS)
        || typeof entry.decision !== "string" || entry.decision.length === 0) {
      fail("MONITORING_5XX_EXCLUSION_INVALID");
    }
    const { path, status, code } = entry;
    if (typeof path !== "string" || path.length === 0) fail("MONITORING_5XX_EXCLUSION_INVALID");
    if (ORIGIN_5XX_NEVER_EXCLUDED_CODES.includes(code) || !ORIGIN_5XX_EXCLUDABLE_CODES.includes(code)) {
      fail("MONITORING_5XX_EXCLUSION_CODE_FORBIDDEN");
    }
    if (status !== ORIGIN_REQUEST_LOG_CONTRACT.notPorted.status) fail("MONITORING_5XX_EXCLUSION_INVALID");
    if (ORIGIN_5XX_NEVER_EXCLUDED_PATHS.includes(path)) fail("MONITORING_5XX_EXCLUSION_PATH_FORBIDDEN");
    const route = matchWorkerRoute(path);
    if (route.kind !== "exact" || !WORKER_ROUTE_POLICY.some((definition) => definition.pathname === path)
        || !ROUTE_CLASS.test(route.routeClass)) {
      fail("MONITORING_5XX_EXCLUSION_PATH_NOT_EXACT");
    }
    const key = `${route.routeClass}\u0000${code}`;
    if (seen.has(key)) fail("MONITORING_5XX_EXCLUSION_DUPLICATE");
    seen.add(key);
    return Object.freeze({ path, routeClass: route.routeClass, status, code });
  }));
}

export const MONITORING_THRESHOLDS = Object.freeze({
  originFiveXxRatio: 0.02,
  originFiveXxWindowMinutes: 10,
  /**
   * The window must also hold at least this many net 5xx answers. One error
   * never pages: increase() extrapolates a count to the window's edges (about
   * 1.1 times with 60 s samples, more for a sparse series), and 5 leaves a
   * wide margin. Below 250 requests per window (5 / 0.02) this count binds,
   * so a window whose requests all fail pages once it holds 5 of them,
   * whatever its volume; from 250 requests the 2 % share binds. A starting
   * value, like round 9's thresholds: tune after a week of real traffic.
   */
  originFiveXxMinimumErrors: 5,
  cadenceSlackMinutes: 60,
  schedulerQuietMinimumHours: SCHEDULER_PAUSE_ALERT_THRESHOLD_HOURS,
  sqlCpuUtilization: 0.8,
  sqlMemoryUtilization: 0.9,
  sqlDiskUtilization: 0.8,
  sqlConnectionShare: 0.8,
  sqlWindowMinutes: 10,
  /** Starting value, like round 9's 80 % resource alerts; tune after a week of real runs. */
  refreshOutputHeadroomShare: 0.8,
  refreshOutputExceededWindowMinutes: 60,
  unseenProbeSilentHours: 26,
  uptimePeriodSeconds: 300,
});

/**
 * origin-5xx-ratio's one PromQL query, for a service and the PromQL name of
 * its origin-request-failure metric:
 *
 *   ((errors / requests) > ratio) and on() (errors >= minimum errors)
 *
 * errors and requests are Cloud Run's 5xx and all-request counts over the
 * window, each net of the same exclusion term: one selector per (status,
 * code) pinned to its exact routeClasses, or 0 while the origin logs none.
 * The renderer and the scanner both build it here, so a rendered query that
 * differs from it in any part is refused.
 */
export function originFiveXxQuery(service, requestFailureMetric) {
  const t = MONITORING_THRESHOLDS;
  const window = `${t.originFiveXxWindowMinutes}m`;
  const groups = new Map();
  for (const { routeClass, status, code } of originFiveXxExclusions(ORIGIN_5XX_EXCLUSIONS)) {
    const key = `${status} ${code}`;
    if (!groups.has(key)) groups.set(key, { status, code, routeClasses: [] });
    groups.get(key).routeClasses.push(routeClass);
  }
  const excluded = [...groups.values()].map(({ status, code, routeClasses }) =>
    `(sum(increase(${requestFailureMetric}{monitored_resource="cloud_run_revision",`
    + `service_name=${quote(service)},routeClass=~${quote(routeClasses.join("|"))},status="${status}",`
    + `code=${quote(code)}}[${window}])) or vector(0))`).join(" + ");
  const requests = (extra = "") => `sum(increase(run_googleapis_com:request_count{monitored_resource=`
    + `"cloud_run_revision",service_name=${quote(service)}${extra}}[${window}]))`;
  const errors = `(${requests(',response_code_class="5xx"')} - (${excluded}))`;
  const counted = `(${requests()} - (${excluded}))`;
  return `((${errors} / ${counted}) > ${t.originFiveXxRatio})`
    + ` and on() (${errors} >= ${t.originFiveXxMinimumErrors})`;
}

/** origin-5xx-ratio's conditions: the one query, held for the whole window. */
export function originFiveXxConditions(service, requestFailureMetric) {
  return [promCondition("origin 5xx ratio", originFiveXxQuery(service, requestFailureMetric),
    { duration: `${MONITORING_THRESHOLDS.originFiveXxWindowMinutes * 60}s` })];
}

/**
 * The host of the plane's public edge origin, which edge-health probes:
 * production's public origin, or the staging edge's (stagingOrigin), or null
 * while a staging plane has none.
 */
export function publicEdgeHost(desired) {
  const origin = desired.environment === "production" ? PRODUCTION_PUBLIC_ORIGIN
    : desired.stagingOrigin?.publicOrigin;
  return typeof origin === "string" ? new URL(origin).host : null;
}

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
  "jsonPayload.memory.accountMiB",
  "jsonPayload.memory.effectiveOutputBudgetMiB",
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

/**
 * A DELTA distribution of one numeric, content-free receipt field. Exponential
 * buckets (scale 1 MiB, growth 1.25, 48 finite) cover 1 MiB to about 45 GiB.
 */
function distributionMetric(desired, id, { description, filter, valueField }) {
  return {
    kind: "log-metric",
    id,
    name: monitoringName(desired, id),
    body: {
      name: monitoringName(desired, id),
      description,
      filter,
      metricDescriptor: { metricKind: "DELTA", valueType: "DISTRIBUTION", unit: "MiBy", labels: [] },
      labelExtractors: {},
      valueExtractor: `EXTRACT(${valueField})`,
      bucketOptions: { exponentialBuckets: { numFiniteBuckets: 48, growthFactor: 1.25, scale: 1 } },
    },
  };
}

/** An unauthenticated GET of https://<host>/api/health that accepts exactly these statuses and this text. */
function uptimeCheck(desired, id, { host, accepted, content }) {
  return {
    kind: "uptime-check",
    id,
    name: displayName(desired, id),
    body: {
      displayName: displayName(desired, id),
      monitoredResource: { type: "uptime_url", labels: { project_id: desired.project, host } },
      userLabels: { "managed-by": "tibotattle-ops-5", environment: desired.environment },
      disabled: false,
      httpCheck: {
        requestMethod: "GET",
        path: "/api/health",
        port: 443,
        useSsl: true,
        validateSsl: true,
        acceptedResponseStatusCodes: accepted.map((statusValue) => ({ statusValue })),
      },
      contentMatchers: [{ content, matcher: "CONTAINS_STRING" }],
      period: `${MONITORING_THRESHOLDS.uptimePeriodSeconds}s`,
      timeout: "10s",
    },
  };
}

/** An uptime check failing from more than one checker location for 10 minutes. */
function uptimeFailingCondition(displayName_, host) {
  return {
    displayName: displayName_,
    conditionThreshold: {
      // The check id is assigned at create; the host names this plane's check.
      filter: `metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url"`
        + ` AND resource.label.host=${quote(host)}`,
      comparison: "COMPARISON_GT",
      thresholdValue: 1,
      duration: "600s",
      aggregations: [{ alignmentPeriod: "1200s", perSeriesAligner: "ALIGN_NEXT_OLDER",
        crossSeriesReducer: "REDUCE_COUNT_FALSE", groupByFields: ["resource.label.host"] }],
      trigger: { count: 1 },
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
      enabled: true,
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
    ...["account", "budget"].map((part) => distributionMetric(desired, `analytics-refresh-output-${part}`, {
      description: part === "account"
        ? "Completed analytics-refresh receipts: the output account in MiB (memory.accountMiB)."
        : "Completed analytics-refresh receipts: the effective output budget in MiB (memory.effectiveOutputBudgetMiB).",
      filter: [`resource.type="cloud_run_job"`, `resource.labels.job_name=${quote(refreshJob)}`,
        `jsonPayload.schemaVersion=${quote(ANALYTICS_REFRESH_RECEIPT_VERSION)}`,
        `jsonPayload.status=${quote(REFRESH_OUTPUT_HEADROOM_CONTRACT.okStatus)}`].join(" AND "),
      valueField: REFRESH_OUTPUT_HEADROOM_CONTRACT[`${part}Field`],
    })),
  ];
  const metricName = (id) => promName(monitoringName(desired, id));

  const edgeHost = publicEdgeHost(desired);
  const uptimeChecks = [
    uptimeCheck(desired, "origin-lock", { host: desired.service.host, accepted: ORIGIN_LOCK_ACCEPTED_STATUSES,
      content: GOOGLE_FRONT_END_403_TEXT }),
    ...(edgeHost === null ? [] : [uptimeCheck(desired, "edge-health", { host: edgeHost,
      accepted: EDGE_HEALTH_ACCEPTED_STATUSES, content: EDGE_HEALTH_OK_TEXT })]),
  ];

  const policies = [];
  const add = (id, options, deferred = null, deferredConditions = []) => {
    const policy = alertPolicy(desired, id, { ...options, notificationChannel });
    const reason = deferred ?? (notificationChannel === null ? "NOTIFICATION_CHANNEL_UNASSIGNED" : null);
    policies.push({ ...policy, ...(reason === null ? {} : { deferred: reason }),
      ...(deferredConditions.length === 0 ? {} : { deferredConditions }) });
  };

  add("origin-5xx-ratio", {
    severity: "page",
    summary: `Origin 5xx share over ${t.originFiveXxRatio * 100} % for ${t.originFiveXxWindowMinutes} min, with at `
      + `least ${t.originFiveXxMinimumErrors} net 5xx answers in the window, net of the deliberate unported answers `
      + "(exact route plus code). An answer the edge makes itself never reaches Cloud Run: see edge-health.",
    conditions: originFiveXxConditions(service, metricName("origin-request-failure")),
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
  const refreshWindow = windowText((refreshCadence.gapMinutes ?? 0) + t.cadenceSlackMinutes);
  const refreshSum = (part) => `${metricName(`analytics-refresh-output-${part}`)}_sum{monitored_resource=`
    + `"cloud_run_job",job_name=${quote(refreshJob)}}`;
  add("refresh-output-headroom", {
    severity: "ticket",
    summary: `An analytics-refresh run used over ${t.refreshOutputHeadroomShare * 100} % of its effective output `
      + "budget, or refused with ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED and published nothing.",
    conditions: [
      promCondition("refresh output account near budget",
        `sum(increase(${refreshSum("account")}[${refreshWindow}])) / sum(increase(${refreshSum("budget")}`
        + `[${refreshWindow}])) > ${t.refreshOutputHeadroomShare}`),
      promCondition("refresh output budget exceeded",
        `sum(increase(${metricName("analytics-refresh-outcome")}{monitored_resource="cloud_run_job",`
        + `job_name=${quote(refreshJob)},code=${quote(REFRESH_OUTPUT_HEADROOM_CONTRACT.exceededCode)}}`
        + `[${windowText(t.refreshOutputExceededWindowMinutes)}])) > 0`),
    ],
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
    conditions: [uptimeFailingCondition("origin-lock uptime check failing", desired.service.host)],
  });
  add("edge-health", {
    severity: "page",
    summary: "Public /api/health through the Cloudflare edge did not answer 200 with status ok. In gcp mode the "
      + "origin answers it, so an edge-to-origin outage (503 EDGE_ORIGIN_UNAVAILABLE), which never reaches Cloud "
      + "Run, pages here.",
    conditions: edgeHost === null ? [] : [uptimeFailingCondition("edge-health uptime check failing", edgeHost)],
  }, edgeHost === null ? "PUBLIC_ORIGIN_UNASSIGNED" : null);
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
    uptimeChecks,
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

/** The matcher shape of an exclusion selector: label and operator, in order. */
const FIVE_XX_EXCLUSION_SELECTOR = Object.freeze([
  ["monitored_resource", "="], ["service_name", "="], ["routeClass", "=~"], ["status", "="], ["code", "="],
]);

/** A selector's `label op "value"` matchers, or null when one does not parse. */
function selectorMatchers(selector) {
  const matchers = [];
  for (const part of selector.split(",")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*"([^"]*)"\s*$/u.exec(part);
    if (match === null) return null;
    matchers.push(match.slice(1));
  }
  return matchers;
}

/**
 * origin-5xx-ratio stays exact and whole:
 * - no never-excluded code appears (MONITORING_5XX_EXCLUSION_CODE_FORBIDDEN);
 * - every selector that names a code also names routeClasses, with code=
 *   (MONITORING_5XX_EXCLUSION_CODE_ALONE);
 * - every such selector, and every selector of the origin request metric, has
 *   exactly the matchers monitored_resource=, service_name=, routeClass=~,
 *   status= and code=, in that order (MONITORING_5XX_EXCLUSION_SELECTOR_INVALID),
 *   and each routeClass it names is listed with that status and code
 *   (MONITORING_5XX_EXCLUSION_NOT_LISTED);
 * - the policy's conditions are exactly originFiveXxConditions for the
 *   service the origin request metric reads: the same operators, threshold,
 *   minimum error count, window, duration and exclusion term
 *   (MONITORING_5XX_QUERY_NOT_CANONICAL).
 */
function scanFiveXxPolicy(policy, rendered) {
  const metric = rendered.metrics.find(({ id }) => id === "origin-request-failure");
  if (metric === undefined) fail("MONITORING_5XX_QUERY_NOT_CANONICAL");
  const requestFailure = promName(metric.name);
  const allowed = new Set(originFiveXxExclusions(ORIGIN_5XX_EXCLUSIONS)
    .map(({ routeClass, status, code }) => `${routeClass} ${status} ${code}`));
  const queries = policy.body.conditions.map((condition) => condition.conditionPrometheusQueryLanguage?.query);
  for (const query of queries) {
    if (typeof query !== "string") fail("MONITORING_5XX_QUERY_NOT_CANONICAL");
    for (const code of ORIGIN_5XX_NEVER_EXCLUDED_CODES) {
      if (query.includes(code)) fail("MONITORING_5XX_EXCLUSION_CODE_FORBIDDEN");
    }
    for (const [, name, selector] of query.matchAll(/([A-Za-z_:][A-Za-z0-9_:]*)\s*\{([^}]*)\}/gu)) {
      const matchers = selectorMatchers(selector);
      const code = matchers?.find(([label]) => label === "code");
      if (name !== requestFailure && code === undefined && !/(?:^|,)\s*code\s*[=!]/u.test(selector)) continue;
      if (matchers === null) fail("MONITORING_5XX_EXCLUSION_SELECTOR_INVALID");
      if (code !== undefined && (code[1] !== "=" || !matchers.some(([label]) => label === "routeClass"))) {
        fail("MONITORING_5XX_EXCLUSION_CODE_ALONE");
      }
      if (name !== requestFailure || JSON.stringify(matchers.map(([label, operator]) => [label, operator]))
          !== JSON.stringify(FIVE_XX_EXCLUSION_SELECTOR)) {
        fail("MONITORING_5XX_EXCLUSION_SELECTOR_INVALID");
      }
      const [, , [, , routeClasses], [, , status], [, , codeValue]] = matchers;
      for (const routeClass of routeClasses.split("|")) {
        if (!allowed.has(`${routeClass} ${status} ${codeValue}`)) fail("MONITORING_5XX_EXCLUSION_NOT_LISTED");
      }
    }
  }
  // The service is the one the origin request metric reads, so the query cannot move to another.
  const service = /(?:^| AND )resource\.labels\.service_name="([^"]*)"(?: AND |$)/u.exec(metric.body.filter)?.[1];
  if (service === undefined
      || canonicalJson(policy.body.conditions) !== canonicalJson(originFiveXxConditions(service, requestFailure))) {
    fail("MONITORING_5XX_QUERY_NOT_CANONICAL");
  }
}

/** What each uptime check must accept, the text it must find, and whether it probes run.app. */
const UPTIME_CHECK_CONTRACTS = Object.freeze({
  "origin-lock": Object.freeze({ accepted: ORIGIN_LOCK_ACCEPTED_STATUSES, content: GOOGLE_FRONT_END_403_TEXT,
    runApp: true, code: "MONITORING_ORIGIN_LOCK_INVALID" }),
  "edge-health": Object.freeze({ accepted: EDGE_HEALTH_ACCEPTED_STATUSES, content: EDGE_HEALTH_OK_TEXT,
    runApp: false, code: "MONITORING_EDGE_HEALTH_INVALID" }),
});

/**
 * Throws MONITORING_FIELD_FORBIDDEN or MONITORING_*_NOT_ALLOWLISTED unless
 * every log filter, label extractor and value extractor reads only
 * ALLOWED_LOG_FIELDS and every PromQL query matches only ALLOWED_QUERY_LABELS;
 * MONITORING_5XX_* unless origin-5xx-ratio is exactly the contract's
 * (scanFiveXxPolicy); and MONITORING_*_INVALID unless each uptime check is an
 * unauthenticated GET of /api/health accepting exactly its contract's statuses
 * and text, origin-lock on run.app and edge-health never on it.
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
    if (metric.body.valueExtractor !== undefined) {
      const match = /^EXTRACT\((.+)\)$/u.exec(metric.body.valueExtractor);
      if (match === null) fail(`MONITORING_EXTRACTOR_INVALID:${metric.id}:value`);
      scanFilter(match[1], `${metric.id}:value`);
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
  const fiveXx = rendered.policies.filter(({ id }) => id === "origin-5xx-ratio");
  if (fiveXx.length !== 1) fail("MONITORING_5XX_QUERY_NOT_CANONICAL");
  scanFiveXxPolicy(fiveXx[0], rendered);
  const checks = new Set();
  for (const check of rendered.uptimeChecks) {
    const contract = Object.hasOwn(UPTIME_CHECK_CONTRACTS, check.id) ? UPTIME_CHECK_CONTRACTS[check.id] : null;
    if (contract === null || checks.has(check.id)) fail("MONITORING_UPTIME_CHECK_INVALID");
    checks.add(check.id);
    const { httpCheck, monitoredResource, contentMatchers } = check.body;
    const accepted = httpCheck.acceptedResponseStatusCodes.map(({ statusValue }) => statusValue);
    const host = monitoredResource?.labels?.host;
    if (JSON.stringify(accepted) !== JSON.stringify(contract.accepted)
        || httpCheck.headers !== undefined || httpCheck.authInfo !== undefined
        || httpCheck.requestMethod !== "GET" || httpCheck.path !== "/api/health"
        || typeof host !== "string" || host.endsWith(".run.app") !== contract.runApp
        || JSON.stringify(contentMatchers)
          !== JSON.stringify([{ content: contract.content, matcher: "CONTAINS_STRING" }])) {
      fail(contract.code);
    }
  }
  return true;
}
