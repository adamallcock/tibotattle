/**
 * Offline check of OPS-5 monitoring as code (gcp-ops-monitoring-policies.mjs):
 * the rendered set for the committed staging plane and synthetic variants,
 * the privacy scanner (every rendered filter passes, forbidden and unlisted
 * fields fail), the origin-lock check (exactly 403, Google's text, no
 * credentials), the 503 POSTGRES_ROUTE_NOT_PORTED exclusion, cadence-derived
 * windows and the closed deferrals and runbook anchors. No call is made.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as manifest from "./gcp-ops-infra-manifest.mjs";
import * as monitoring from "./gcp-ops-monitoring-policies.mjs";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = dirname(SCRIPTS_ROOT);
const REPOSITORY_ROOT = dirname(dirname(WORKER_ROOT));
const STAGING = manifest.loadCommittedDesiredState("staging");
const CHANNEL = `projects/${STAGING.project}/notificationChannels/1234567890`;

function staging(mutate) {
  const value = JSON.parse(readFileSync(manifest.committedDesiredStatePath("staging"), "utf8"));
  mutate(value);
  return manifest.validateDesiredState(value);
}

const resumed = (schedule) => staging((value) => {
  value.scheduler["analytics-refresh"].schedule = schedule;
  value.scheduler["analytics-refresh"].state = "ENABLED";
});

function policy(rendered, id) {
  return rendered.policies.find((entry) => entry.id === id);
}

function query(rendered, id, index = 0) {
  return policy(rendered, id).body.conditions[index].conditionPrometheusQueryLanguage.query;
}

const isCode = (pattern) => (error) => pattern.test(error?.code ?? "");

test("the committed staging plane renders the closed set, every policy deferred until its inputs exist", () => {
  const rendered = monitoring.renderMonitoring(STAGING);
  assert.equal(rendered.schema, monitoring.GCP_OPS_MONITORING_RENDER_SCHEMA);
  assert.deepEqual(rendered.policies.map(({ id }) => id), [...monitoring.MONITORING_POLICY_IDS]);
  assert.deepEqual(rendered.metrics.map(({ name }) => name), ["tibotattle_staging_origin_request_failure",
    "tibotattle_staging_analytics_refresh_outcome", "tibotattle_staging_scheduler_attempt",
    "tibotattle_staging_unseen_token_probe"]);
  assert.equal(rendered.notificationChannel, "unassigned");
  assert.deepEqual(Object.fromEntries(rendered.policies.map(({ id, deferred }) => [id, deferred])), {
    "origin-5xx-ratio": "NOTIFICATION_CHANNEL_UNASSIGNED",
    "refresh-lock-held": "NOTIFICATION_CHANNEL_UNASSIGNED",
    "refresh-not-completed": "SCHEDULER_CADENCE_UNSET",
    "scheduler-quiet": "SCHEDULER_CADENCE_UNSET",
    "origin-lock": "NOTIFICATION_CHANNEL_UNASSIGNED",
    "sql-cpu": "NOTIFICATION_CHANNEL_UNASSIGNED",
    "sql-memory": "NOTIFICATION_CHANNEL_UNASSIGNED",
    "sql-disk": "NOTIFICATION_CHANNEL_UNASSIGNED",
    "sql-connections": "NOTIFICATION_CHANNEL_UNASSIGNED",
    "unseen-tokens": "PRODUCER_NOT_IN_MANIFEST:unseen-token-probe",
    "unseen-tokens-silent": "PRODUCER_NOT_IN_MANIFEST:unseen-token-probe",
  });
  for (const entry of rendered.policies) {
    assert.ok(monitoring.MONITORING_DEFERRALS.includes(entry.deferred.split(":")[0]), entry.id);
    assert.deepEqual(entry.body.notificationChannels, []);
    assert.ok(monitoring.ALERT_SEVERITIES.includes(entry.body.userLabels.severity));
    assert.match(entry.body.displayName, /^tibotattle-staging-/u);
  }
  // With the owner's channel, only signals that do not exist yet stay deferred.
  const assigned = monitoring.renderMonitoring(STAGING, { notificationChannel: CHANNEL });
  assert.equal(assigned.notificationChannel, "assigned");
  assert.deepEqual(assigned.policies.filter(({ deferred }) => deferred !== undefined).map(({ id }) => id),
    ["refresh-not-completed", "scheduler-quiet", "unseen-tokens", "unseen-tokens-silent"]);
  assert.deepEqual(policy(assigned, "sql-cpu").body.notificationChannels, [CHANNEL]);
  // Deterministic.
  assert.deepEqual(monitoring.renderMonitoring(STAGING, { notificationChannel: CHANNEL }), assigned);
  assert.equal(monitoring.renderedDigest(assigned), monitoring.renderedDigest(
    monitoring.renderMonitoring(STAGING, { notificationChannel: CHANNEL })));
  assert.notEqual(monitoring.renderedDigest(assigned), monitoring.renderedDigest(monitoring.renderMonitoring(STAGING)));
  for (const channel of ["projects/other-project/notificationChannels/1", "notificationChannels/1", `${CHANNEL}/x`, 7]) {
    assert.throws(() => monitoring.renderMonitoring(STAGING, { notificationChannel: channel }),
      { code: "MONITORING_NOTIFICATION_CHANNEL_INVALID" }, String(channel));
  }
});

test("every rendered filter, extractor and query passes the privacy scanner, and forbidden fields fail", () => {
  const rendered = monitoring.renderMonitoring(resumed("15 3 * * *"), { notificationChannel: CHANNEL });
  assert.equal(monitoring.scanMonitoringPrivacy(rendered), true);
  const text = JSON.stringify(rendered);
  for (const forbidden of ["requestId", "httpRequest", "textPayload", "requestUrl", "remoteIp", "protoPayload"]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  for (const metric of rendered.metrics) {
    for (const extractor of Object.values(metric.body.labelExtractors)) {
      assert.ok(monitoring.ALLOWED_LOG_FIELDS.includes(/^EXTRACT\((.+)\)$/u.exec(extractor)[1]), extractor);
    }
  }
  const tampered = (edit) => {
    const copy = structuredClone(rendered);
    edit(copy);
    return () => monitoring.scanMonitoringPrivacy(copy);
  };
  for (const [edit, pattern] of [
    [(copy) => { copy.metrics[0].body.filter += ' AND jsonPayload.requestId="x"'; }, /^MONITORING_FIELD_FORBIDDEN:.*requestId$/u],
    [(copy) => { copy.metrics[0].body.labelExtractors.requestId = "EXTRACT(jsonPayload.requestId)"; },
      /^MONITORING_FIELD_FORBIDDEN:/u],
    [(copy) => { copy.metrics[0].body.labelExtractors.url = "EXTRACT(httpRequest.requestUrl)"; }, /^MONITORING_FIELD_FORBIDDEN:/u],
    [(copy) => { copy.metrics[1].body.filter += ' AND textPayload:"x"'; }, /^MONITORING_FIELD_FORBIDDEN:.*textPayload$/u],
    [(copy) => { copy.metrics[1].body.filter += ' AND labels.instanceId="x"'; }, /^MONITORING_FIELD_FORBIDDEN:/u],
    [(copy) => { copy.metrics[2].body.filter += ' AND jsonPayload.ownerId="x"'; }, /^MONITORING_FIELD_NOT_ALLOWLISTED:/u],
    [(copy) => { copy.metrics[3].body.labelExtractors.v = "jsonPayload.verdict"; }, /^MONITORING_EXTRACTOR_INVALID:/u],
    [(copy) => { copy.metrics[3].body.labelExtractors.v = "EXTRACT(jsonPayload.dimensions)"; },
      /^MONITORING_FIELD_NOT_ALLOWLISTED:/u],
    [(copy) => { copy.policies[0].body.conditions[0].conditionPrometheusQueryLanguage.query += ' and on() x{requestId="1"}'; },
      /^MONITORING_(?:FIELD_FORBIDDEN|QUERY_LABEL_NOT_ALLOWLISTED):/u],
    [(copy) => { copy.policies[1].body.conditions[0].conditionPrometheusQueryLanguage.query += ' and on() x{owner="1"}'; },
      /^MONITORING_QUERY_LABEL_NOT_ALLOWLISTED:/u],
  ]) {
    assert.throws(tampered(edit), isCode(pattern), String(pattern));
  }
  // The forbidden list is disjoint from the allowlist.
  for (const field of monitoring.FORBIDDEN_LOG_FIELDS) assert.equal(monitoring.ALLOWED_LOG_FIELDS.includes(field), false);
});

test("the origin-lock check accepts exactly Google's 403, unauthenticated, on the service's run.app host", () => {
  const rendered = monitoring.renderMonitoring(STAGING);
  const [check] = rendered.uptimeChecks;
  assert.deepEqual(check.body.monitoredResource, { type: "uptime_url",
    labels: { project_id: STAGING.project, host: STAGING.service.host } });
  assert.match(STAGING.service.host, /\.run\.app$/u);
  assert.deepEqual(check.body.httpCheck.acceptedResponseStatusCodes, [{ statusValue: 403 }]);
  assert.deepEqual(monitoring.ORIGIN_LOCK_ACCEPTED_STATUSES, [403]);
  assert.equal(check.body.httpCheck.path, "/api/health");
  assert.equal("authInfo" in check.body.httpCheck || "headers" in check.body.httpCheck, false);
  assert.deepEqual(check.body.contentMatchers, [{ content: monitoring.GOOGLE_FRONT_END_403_TEXT, matcher: "CONTAINS_STRING" }]);
  assert.match(policy(rendered, "origin-lock").body.conditions[0].conditionThreshold.filter,
    new RegExp(`resource\\.label\\.host="${STAGING.service.host.replaceAll(".", "\\.")}"`, "u"));
  for (const edit of [
    (copy) => { copy.uptimeChecks[0].body.httpCheck.acceptedResponseStatusCodes.push({ statusValue: 200 }); },
    (copy) => { copy.uptimeChecks[0].body.httpCheck.acceptedResponseStatusCodes = [{ statusValue: 401 }]; },
    (copy) => { copy.uptimeChecks[0].body.httpCheck.headers = { authorization: "Bearer x" }; },
    (copy) => { copy.uptimeChecks[0].body.httpCheck.authInfo = { username: "x" }; },
  ]) {
    const copy = structuredClone(rendered);
    edit(copy);
    assert.throws(() => monitoring.scanMonitoringPrivacy(copy), { code: "MONITORING_ORIGIN_LOCK_INVALID" });
  }
});

test("the 5xx ratio excludes only 503 POSTGRES_ROUTE_NOT_PORTED, over 2 % for 10 minutes", () => {
  const rendered = monitoring.renderMonitoring(STAGING);
  const promql = query(rendered, "origin-5xx-ratio");
  const service = `service_name="${STAGING.service.name}"`;
  assert.ok(promql.includes(`run_googleapis_com:request_count{monitored_resource="cloud_run_revision",${service},`
    + 'response_code_class="5xx"}[10m]'));
  assert.ok(promql.includes('status="503",code="POSTGRES_ROUTE_NOT_PORTED"}[10m])) or vector(0))'),
    "exactly the not-ported 503 lines are subtracted, and none subtracts zero");
  assert.ok(promql.endsWith(`/ sum(rate(run_googleapis_com:request_count{monitored_resource="cloud_run_revision",${service}}[10m])) > 0.02`));
  assert.equal(policy(rendered, "origin-5xx-ratio").body.conditions[0].conditionPrometheusQueryLanguage.duration, "600s");
  assert.equal(policy(rendered, "origin-5xx-ratio").severity, "page");
  // The origin request metric reads the closed line and its closed events only.
  const [requests] = rendered.metrics;
  assert.deepEqual(Object.keys(requests.body.labelExtractors), ["routeClass", "status", "code"]);
  assert.match(requests.body.filter, /jsonPayload\.event=\("request_failed" OR "request_pending" OR "request_unavailable"\)/u);
  assert.deepEqual(monitoring.ORIGIN_REQUEST_LOG_CONTRACT.notPorted, { status: 503, code: "POSTGRES_ROUTE_NOT_PORTED" });
});

test("refresh alerts: LOCK_HELD, and no completed run within cadence plus slack (a lost lock exits 0)", async () => {
  const daily = monitoring.renderMonitoring(resumed("15 3 * * *"));
  assert.equal(policy(daily, "refresh-not-completed").deferred, "NOTIFICATION_CHANNEL_UNASSIGNED");
  assert.match(query(daily, "refresh-not-completed"), /^absent_over_time\(.*job_name="tibotattle-staging-analytics-refresh",state="complete"\}\[25h\]\)$/u);
  assert.match(query(daily, "refresh-lock-held"), /state="LOCK_HELD"\}\[1h\]\)\) > 0$/u);
  assert.match(query(monitoring.renderMonitoring(resumed("*/30 * * * *")), "refresh-not-completed"), /\[90m\]\)$/u);
  // Committed PAUSED: no run is expected, so the absence alert is deferred.
  const paused = staging((value) => { value.scheduler["analytics-refresh"].schedule = "15 3 * * *"; });
  assert.equal(policy(monitoring.renderMonitoring(paused), "refresh-not-completed").deferred, "TRIGGER_COMMITTED_PAUSED");
  // The receipt schema is the refresh job's own.
  const refresh = await import("../cloud-run/analytics-refresh.mjs");
  assert.equal(monitoring.ANALYTICS_REFRESH_RECEIPT_VERSION, refresh.ANALYTICS_REFRESH_RECEIPT_VERSION);
});

test("the scheduler paused-too-long alert waits max(6 h, cadence plus slack) per committed-ENABLED trigger", () => {
  assert.equal(monitoring.MONITORING_THRESHOLDS.schedulerQuietMinimumHours, manifest.SCHEDULER_PAUSE_ALERT_THRESHOLD_HOURS);
  assert.equal(manifest.SCHEDULER_PAUSE_ALERT_THRESHOLD_HOURS, 6);
  for (const [schedule, window] of [["*/30 * * * *", "6h"], ["0 */6 * * *", "7h"], ["15 3 * * *", "25h"],
    ["30 2 * * 1-5", "73h"]]) {
    const rendered = monitoring.renderMonitoring(resumed(schedule));
    assert.match(query(rendered, "scheduler-quiet"),
      new RegExp(`job_id="tibotattle-staging-analytics-refresh-trigger"\\}\\[${window}\\]\\)$`, "u"), schedule);
  }
  assert.match(monitoring.renderMonitoring(STAGING).metrics[2].body.filter,
    /resource\.labels\.job_id=\("tibotattle-staging-analytics-refresh-trigger"\)/u);
  assert.equal(policy(monitoring.renderMonitoring(STAGING), "scheduler-quiet").deferred, "SCHEDULER_CADENCE_UNSET");
});

test("cron gaps follow the validator's grammar in UTC", () => {
  for (const [schedule, gap] of [["*/5 * * * *", 5], ["0 * * * *", 60], ["15 3 * * *", 1440], ["0 */6 * * *", 360],
    ["0 0 1 * *", 44640], ["30 2 * * 1-5", 4320], ["0 9,17 * * *", 960], ["5/15 * * * *", 15], ["0 0 29 2 *", null]]) {
    assert.equal(monitoring.cronMaxGapMinutes(schedule), gap, schedule);
  }
  assert.throws(() => monitoring.cronMaxGapMinutes("* * *"), { code: "MONITORING_CADENCE_INVALID" });
  assert.equal(policy(monitoring.renderMonitoring(resumed("0 0 29 2 *")), "scheduler-quiet").deferred,
    "SCHEDULER_CADENCE_UNSUPPORTED");
});

test("Cloud SQL alerts read the plane's instance, and connections follow the committed max_connections", () => {
  const rendered = monitoring.renderMonitoring(STAGING);
  const database = `database_id="${STAGING.project}:${STAGING.cloudSql.instance}"`;
  for (const [id, metric, threshold] of [["sql-cpu", "cpu/utilization", 0.8], ["sql-memory", "memory/utilization", 0.9],
    ["sql-disk", "disk/utilization", 0.8],
    ["sql-connections", "postgresql/num_backends", Math.floor(STAGING.cloudSql.maxConnections * 0.8)]]) {
    const condition = policy(rendered, id).body.conditions[0].conditionThreshold;
    assert.ok(condition.filter.includes(`cloudsql.googleapis.com/database/${metric}`), id);
    assert.ok(condition.filter.includes(`resource.label.${database}`), id);
    assert.equal(condition.thresholdValue, threshold, id);
    assert.equal(condition.duration, "600s", id);
  }
  assert.equal(policy(rendered, "sql-connections").body.conditions[0].conditionThreshold.thresholdValue, 80);
});

test("K-DETECT alerts key on the probe's own schema and verdict, and wait for its job", async () => {
  const probe = await import("../cloud-run/unseen-token-probe.mjs");
  assert.equal(monitoring.UNSEEN_TOKEN_PROBE_SCHEMA, probe.UNSEEN_TOKEN_PROBE_SCHEMA);
  const rendered = monitoring.renderMonitoring(STAGING);
  assert.match(rendered.metrics[3].body.filter, /jsonPayload\.schema="tibotattle-unseen-token-probe-v1"/u);
  assert.match(query(rendered, "unseen-tokens"), /verdict="unseen"\}\[1d\]\)\) > 0$/u);
  assert.match(query(rendered, "unseen-tokens-silent"), /\[26h\]\)$/u);
  assert.equal(manifest.JOB_NAMES.includes(monitoring.UNSEEN_TOKEN_PROBE_JOB), false, "D-OPS4 adds the probe job");
  assert.equal(policy(rendered, "unseen-tokens").deferred, "PRODUCER_NOT_IN_MANIFEST:unseen-token-probe");
});

test("every policy links to its own anchor in the maintained runbook", () => {
  const runbook = readFileSync(join(REPOSITORY_ROOT, monitoring.MONITORING_RUNBOOK), "utf8");
  const anchors = [...runbook.matchAll(/^## ([a-z0-9-]+)$/gmu)].map(([, anchor]) => anchor);
  const rendered = monitoring.renderMonitoring(STAGING);
  for (const entry of rendered.policies) {
    assert.ok(anchors.includes(entry.id), entry.id);
    assert.ok(entry.body.documentation.content.endsWith(`Runbook: ${monitoring.MONITORING_RUNBOOK}#${entry.id}`));
  }
  for (const deferral of monitoring.MONITORING_DEFERRALS) assert.ok(runbook.includes(`\`${deferral}`), deferral);
});

test("the origin request contract mirrors the origin's own log line where that module exists", async (t) => {
  let host;
  try {
    host = await import("../cloud-run/postgres-host-dispatch.mjs");
  } catch {
    t.skip("cloud-run/postgres-host-dispatch.mjs (W3-CRA, D-CRB) is not on this line yet");
    return;
  }
  assert.deepEqual([...host.ORIGIN_REQUEST_LOG_FIELDS], [...monitoring.ORIGIN_REQUEST_LOG_CONTRACT.fields]);
  assert.deepEqual([...host.ORIGIN_REQUEST_LOG_EVENTS], [...monitoring.ORIGIN_REQUEST_LOG_CONTRACT.events]);
  assert.deepEqual({ ...host.ORIGIN_ROUTE_NOT_PORTED }, { ...monitoring.ORIGIN_REQUEST_LOG_CONTRACT.notPorted });
});
