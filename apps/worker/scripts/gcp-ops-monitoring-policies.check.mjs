/**
 * Offline check of OPS-5 monitoring as code (gcp-ops-monitoring-policies.mjs):
 * the rendered set for the committed staging plane and synthetic variants,
 * the privacy scanner (every rendered filter passes, forbidden and unlisted
 * fields fail), the origin-lock check (exactly 403, Google's text, no
 * credentials), the 5xx ratio's request floor and its exact route-plus-code
 * exclusions (never a code alone, never the live or 4xx routes), cadence-derived
 * windows and the closed deferrals and runbook anchors. No call is made.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as manifest from "./gcp-ops-infra-manifest.mjs";
import * as monitoring from "./gcp-ops-monitoring-policies.mjs";
import { WORKER_ROUTE_POLICY, matchWorkerRoute } from "../src/route-registry.ts";

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
    "tibotattle_staging_unseen_token_probe", "tibotattle_staging_analytics_refresh_output_account",
    "tibotattle_staging_analytics_refresh_output_budget"]);
  assert.equal(rendered.notificationChannel, "unassigned");
  assert.deepEqual(Object.fromEntries(rendered.policies.map(({ id, deferred }) => [id, deferred])), {
    "origin-5xx-ratio": "NOTIFICATION_CHANNEL_UNASSIGNED",
    "refresh-lock-held": "NOTIFICATION_CHANNEL_UNASSIGNED",
    "refresh-not-completed": "SCHEDULER_CADENCE_UNSET",
    "refresh-output-headroom": "SCHEDULER_CADENCE_UNSET",
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
    ["refresh-not-completed", "refresh-output-headroom", "scheduler-quiet", "unseen-tokens", "unseen-tokens-silent"]);
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
    [(copy) => { copy.metrics[4].body.valueExtractor = "EXTRACT(jsonPayload.requestId)"; }, /^MONITORING_FIELD_FORBIDDEN:/u],
    [(copy) => { copy.metrics[4].body.valueExtractor = "EXTRACT(jsonPayload.memory.peakRssMiB)"; },
      /^MONITORING_FIELD_NOT_ALLOWLISTED:/u],
    [(copy) => { copy.metrics[5].body.valueExtractor = "jsonPayload.memory.accountMiB"; }, /^MONITORING_EXTRACTOR_INVALID:/u],
    [(copy) => { copy.metrics[5].body.valueExtractor = "EXTRACT(httpRequest.latency)"; }, /^MONITORING_FIELD_FORBIDDEN:/u],
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

test("the 5xx ratio: over 2 % for 10 minutes, at least 50 requests, net of exact route-plus-code exclusions", () => {
  const rendered = monitoring.renderMonitoring(STAGING);
  const promql = query(rendered, "origin-5xx-ratio");
  const service = `service_name="${STAGING.service.name}"`;
  const requests = (extra = "") => `sum(increase(run_googleapis_com:request_count{monitored_resource="cloud_run_revision",`
    + `${service}${extra}}[10m]))`;
  const routeClasses = monitoring.ORIGIN_5XX_EXCLUSIONS.map(({ path }) => matchWorkerRoute(path).routeClass);
  const excluded = "(sum(increase(logging_googleapis_com:user_tibotattle_staging_origin_request_failure{"
    + `monitored_resource="cloud_run_revision",${service},routeClass=~"${routeClasses.join("|")}",status="503",`
    + 'code="POSTGRES_ROUTE_NOT_PORTED"}[10m])) or vector(0))';
  const counted = `(${requests()} - (${excluded}))`;
  assert.equal(promql, `((${requests(',response_code_class="5xx"')} - (${excluded})) / ${counted} > 0.02)`
    + ` and on() (${counted} >= 50)`);
  assert.equal(policy(rendered, "origin-5xx-ratio").body.conditions[0].conditionPrometheusQueryLanguage.duration, "600s");
  assert.equal(policy(rendered, "origin-5xx-ratio").severity, "page");
  // The origin request metric reads the closed line and its closed events only.
  const [requestLines] = rendered.metrics;
  assert.deepEqual(Object.keys(requestLines.body.labelExtractors), ["routeClass", "status", "code"]);
  assert.match(requestLines.body.filter, /jsonPayload\.event=\("request_failed" OR "request_pending" OR "request_unavailable"\)/u);
  assert.deepEqual(monitoring.ORIGIN_REQUEST_LOG_CONTRACT.notPorted, { status: 503, code: "POSTGRES_ROUTE_NOT_PORTED" });
});

test("the request floor is the smallest count at which one error cannot page, from production's volume", () => {
  const { originFiveXxRatio: ratio, originFiveXxMinimumRequests: floor } = monitoring.MONITORING_THRESHOLDS;
  assert.equal(floor, Math.ceil(1 / ratio));
  // Every eligible window: one error is at most 2 %, and the comparison is strict.
  for (let requests = floor; requests <= floor * 20; requests += 1) assert.equal(1 / requests > ratio, false, requests);
  // One error under the floor would have paged without it.
  assert.equal(1 / (floor - 1) > ratio, true);
  // OWN-2-GQL (2026-10-02): 132,945 requests in 30 days on the queried routes,
  // a mean of about 31 per 10-minute window, so the floor sits just above it.
  const meanPerWindow = 132_945 / (30 * 24 * 6);
  assert.ok(meanPerWindow > 30 && meanPerWindow < floor, String(meanPerWindow));
});

test("5xx exclusions name round 12's retired routes and the deliberate unported answers by exact path", () => {
  const exclusions = monitoring.originFiveXxExclusions(monitoring.ORIGIN_5XX_EXCLUSIONS);
  assert.deepEqual(exclusions.map(({ routeClass }) => routeClass), [
    "enroll", "identity_google_start", "identity_google_callback", "identity_google_result",
    "identity_apple_start", "identity_apple_callback", "identity_apple_result", "security_reset",
    "telemetry_performance_capabilities", "telemetry_performance_consent", "telemetry_performance_reports",
    "participant_export", "admin_action",
  ]);
  for (const entry of exclusions) {
    assert.equal(WORKER_ROUTE_POLICY.find(({ pathname }) => pathname === entry.path)?.id, entry.routeClass);
    assert.deepEqual([entry.status, entry.code], [503, "POSTGRES_ROUTE_NOT_PORTED"]);
  }
  const paths = monitoring.ORIGIN_5XX_EXCLUSIONS.map(({ path }) => path);
  // Kept and live routes are never excluded: v0.x shares the live upload
  // route, the accountless performance authorization answers a definite 4xx,
  // and round 12 keeps renew and disconnect.
  for (const kept of monitoring.ORIGIN_5XX_NEVER_EXCLUDED_PATHS) assert.equal(paths.includes(kept), false, kept);
  for (const kept of ["/api/v1/contributions", "/api/v1/accountless/telemetry-performance-authorization",
    "/api/v1/device/credential/renew", "/api/v1/device/disconnect"]) {
    assert.ok(monitoring.ORIGIN_5XX_NEVER_EXCLUDED_PATHS.includes(kept), kept);
  }
  assert.deepEqual([...monitoring.ORIGIN_5XX_NEVER_EXCLUDED_CODES], ["POSTGRES_TEST_ROUTE_UNSUPPORTED",
    "EDGE_ORIGIN_UNAVAILABLE"]);
});

test("5xx exclusions refuse a code alone, an inexact path, a kept route and the never-excluded codes", () => {
  const base = { path: "/api/v1/identity/google/start", status: 503, code: "POSTGRES_ROUTE_NOT_PORTED", decision: "t" };
  for (const [entries, code] of [
    [[{ status: 503, code: "POSTGRES_ROUTE_NOT_PORTED", decision: "t" }], "MONITORING_5XX_EXCLUSION_INVALID"],
    [[{ ...base, path: "" }], "MONITORING_5XX_EXCLUSION_INVALID"],
    [[{ ...base, path: "/api/v1/identity/google" }], "MONITORING_5XX_EXCLUSION_PATH_NOT_EXACT"],
    [[{ ...base, path: "/api/v1/identity/google/start/" }], "MONITORING_5XX_EXCLUSION_PATH_NOT_EXACT"],
    [[{ ...base, path: "/api/v1/identity/google/start?x=1" }], "MONITORING_5XX_EXCLUSION_PATH_NOT_EXACT"],
    [[{ ...base, path: "/api/v1/identity/*" }], "MONITORING_5XX_EXCLUSION_PATH_NOT_EXACT"],
    [[{ ...base, path: "/index.html" }], "MONITORING_5XX_EXCLUSION_PATH_NOT_EXACT"],
    [[{ ...base, path: "/api/v1/contributions" }], "MONITORING_5XX_EXCLUSION_PATH_FORBIDDEN"],
    [[{ ...base, path: "/api/v1/accountless/telemetry-performance-authorization" }],
      "MONITORING_5XX_EXCLUSION_PATH_FORBIDDEN"],
    [[{ ...base, path: "/api/v1/device/credential/renew" }], "MONITORING_5XX_EXCLUSION_PATH_FORBIDDEN"],
    [[{ ...base, path: "/api/v1/device/disconnect" }], "MONITORING_5XX_EXCLUSION_PATH_FORBIDDEN"],
    [[{ ...base, code: "POSTGRES_TEST_ROUTE_UNSUPPORTED" }], "MONITORING_5XX_EXCLUSION_CODE_FORBIDDEN"],
    [[{ ...base, code: "EDGE_ORIGIN_UNAVAILABLE" }], "MONITORING_5XX_EXCLUSION_CODE_FORBIDDEN"],
    [[{ ...base, code: "INTERNAL_ERROR" }], "MONITORING_5XX_EXCLUSION_CODE_FORBIDDEN"],
    [[{ ...base, code: undefined }], "MONITORING_5XX_EXCLUSION_CODE_FORBIDDEN"],
    [[{ ...base, status: 500 }], "MONITORING_5XX_EXCLUSION_INVALID"],
    [[{ ...base, status: "503" }], "MONITORING_5XX_EXCLUSION_INVALID"],
    [[{ ...base, routeClass: "identity_google_start" }], "MONITORING_5XX_EXCLUSION_INVALID"],
    [[{ ...base, decision: "" }], "MONITORING_5XX_EXCLUSION_INVALID"],
    [[base, { ...base, decision: "again" }], "MONITORING_5XX_EXCLUSION_DUPLICATE"],
    [[null], "MONITORING_5XX_EXCLUSION_INVALID"],
    [{}, "MONITORING_5XX_EXCLUSION_INVALID"],
  ]) {
    assert.throws(() => monitoring.originFiveXxExclusions(entries), { code }, `${JSON.stringify(entries)} -> ${code}`);
  }
});

test("the scanner refuses a rendered 5xx query that drops the floor or excludes by code alone", () => {
  const rendered = monitoring.renderMonitoring(STAGING);
  const index = rendered.policies.findIndex(({ id }) => id === "origin-5xx-ratio");
  const tampered = (edit) => {
    const copy = structuredClone(rendered);
    const condition = copy.policies[index].body.conditions[0].conditionPrometheusQueryLanguage;
    condition.query = edit(condition.query);
    return () => monitoring.scanMonitoringPrivacy(copy);
  };
  for (const [edit, code] of [
    [(promql) => promql.replaceAll(/routeClass=~"[^"]*",/gu, ""), "MONITORING_5XX_EXCLUSION_CODE_ALONE"],
    [(promql) => promql.replaceAll('code="POSTGRES_ROUTE_NOT_PORTED"', 'code=~"POSTGRES_ROUTE_NOT_PORTED"'),
      "MONITORING_5XX_EXCLUSION_CODE_ALONE"],
    [(promql) => promql.replaceAll('routeClass=~"enroll|', 'routeClass=~"contributions|enroll|'),
      "MONITORING_5XX_EXCLUSION_NOT_LISTED"],
    [(promql) => promql.replaceAll('routeClass=~"enroll|', 'routeClass=~".*|'), "MONITORING_5XX_EXCLUSION_NOT_LISTED"],
    [(promql) => promql.replaceAll("POSTGRES_ROUTE_NOT_PORTED", "POSTGRES_TEST_ROUTE_UNSUPPORTED"),
      "MONITORING_5XX_EXCLUSION_CODE_FORBIDDEN"],
    [(promql) => promql.replaceAll("POSTGRES_ROUTE_NOT_PORTED", "EDGE_ORIGIN_UNAVAILABLE"),
      "MONITORING_5XX_EXCLUSION_CODE_FORBIDDEN"],
    [(promql) => promql.slice(0, promql.indexOf(" and on() (")), "MONITORING_5XX_MINIMUM_REQUESTS_MISSING"],
    [(promql) => promql.replace(/>= 50\)$/u, ">= 1)"), "MONITORING_5XX_MINIMUM_REQUESTS_MISSING"],
  ]) {
    assert.throws(tampered(edit), { code }, code);
  }
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

test("refresh-output-headroom: the receipt's account against its effective budget, and any budget refusal", async () => {
  const contract = monitoring.REFRESH_OUTPUT_HEADROOM_CONTRACT;
  const daily = monitoring.renderMonitoring(resumed("15 3 * * *"), { notificationChannel: CHANNEL });
  const headroom = policy(daily, "refresh-output-headroom");
  assert.equal(headroom.severity, "ticket");
  assert.equal(headroom.deferred, undefined);
  assert.equal(headroom.body.conditions.length, 2);
  const job = 'job_name="tibotattle-staging-analytics-refresh"';
  const metric = (part) => `logging_googleapis_com:user_tibotattle_staging_analytics_refresh_output_${part}_sum`
    + `{monitored_resource="cloud_run_job",${job}}`;
  assert.equal(query(daily, "refresh-output-headroom", 0),
    `sum(increase(${metric("account")}[25h])) / sum(increase(${metric("budget")}[25h])) > 0.8`);
  assert.equal(query(daily, "refresh-output-headroom", 1), "sum(increase(logging_googleapis_com:user_"
    + `tibotattle_staging_analytics_refresh_outcome{monitored_resource="cloud_run_job",${job},`
    + 'code="ANALYTICS_V2_OUTPUT_BUDGET_EXCEEDED"}[1h])) > 0');
  assert.match(query(monitoring.renderMonitoring(resumed("*/30 * * * *")), "refresh-output-headroom", 0), /\[90m\]\)\) > 0\.8$/u);
  // It waits with the refresh trigger, like refresh-not-completed.
  assert.equal(policy(monitoring.renderMonitoring(STAGING), "refresh-output-headroom").deferred, "SCHEDULER_CADENCE_UNSET");
  const paused = staging((value) => { value.scheduler["analytics-refresh"].schedule = "15 3 * * *"; });
  assert.equal(policy(monitoring.renderMonitoring(paused), "refresh-output-headroom").deferred, "TRIGGER_COMMITTED_PAUSED");

  // The two distribution metrics read only completed receipts, one numeric field each.
  const [account, budget] = daily.metrics.slice(4);
  assert.deepEqual([account.body.valueExtractor, budget.body.valueExtractor],
    ["EXTRACT(jsonPayload.memory.accountMiB)", "EXTRACT(jsonPayload.memory.effectiveOutputBudgetMiB)"]);
  for (const entry of [account, budget]) {
    assert.deepEqual(entry.body.metricDescriptor, { metricKind: "DELTA", valueType: "DISTRIBUTION", unit: "MiBy", labels: [] });
    assert.deepEqual(entry.body.labelExtractors, {});
  }
  const receipt = { resource: { type: "cloud_run_job", labels: { job_name: "tibotattle-staging-analytics-refresh" } },
    jsonPayload: { schemaVersion: "analytics-refresh-receipt-v1", status: "ok", state: "complete",
      memory: { outputBudgetMiB: 10752, effectiveOutputBudgetMiB: 11000, accountMiB: 24 } } };
  const refused = { ...receipt, jsonPayload: { schemaVersion: "analytics-refresh-receipt-v1", status: "failed",
    code: contract.exceededCode, phase: "compute", outputAccount: { accountMiB: 71, outputBudgetMiB: 70 } } };
  assert.equal(filterMatches(account.body.filter, receipt), true);
  assert.equal(filterMatches(budget.body.filter, receipt), true);
  assert.equal(filterMatches(account.body.filter, refused), false, "a failure line feeds no headroom sample");
  assert.equal(filterMatches(account.body.filter, { ...receipt,
    resource: { type: "cloud_run_job", labels: { job_name: "other-job" } } }), false);
  // The refusal is counted by the refresh outcome metric's code label.
  const [, outcome] = daily.metrics;
  assert.equal(filterMatches(outcome.body.filter, refused), true);
  assert.equal(outcome.body.labelExtractors.code, "EXTRACT(jsonPayload.code)");

  // The names are the refresh's own (C-REFRESH): pinned to its source.
  const refreshSource = readFileSync(join(WORKER_ROOT, "cloud-run/analytics-refresh.mjs"), "utf8");
  for (const fragment of ["effectiveOutputBudgetMiB: Number.isSafeInteger(recorded?.account?.outputBudgetBytes)",
    "accountMiB: Number.isSafeInteger(recorded?.account?.accountBytes)",
    "memory: memorySummary(resources, outputs.resources", 'status: "ok",',
    `if (error?.code === "${contract.exceededCode}"`, 'status: "failed",',
    "code: safeCode(error, \"ANALYTICS_V2_REFRESH_FAILED\"),"]) {
    assert.ok(refreshSource.includes(fragment), fragment);
  }
  const compute = readFileSync(join(WORKER_ROOT, "src/analytics-v2/compute.ts"), "utf8");
  assert.ok(compute.includes(`readonly code = "${contract.exceededCode}" as const;`));
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

test("scheduler-quiet defers per trigger: one deferred trigger never silences another's condition", () => {
  const live = { job: "analytics-refresh", cadence: { gapMinutes: 1440 } };
  const paused = { job: "synthetic-probe", cadence: { deferred: "TRIGGER_COMMITTED_PAUSED" } };
  const unset = { job: "synthetic-maintenance", cadence: { deferred: "SCHEDULER_CADENCE_UNSET" } };
  assert.deepEqual(monitoring.schedulerQuietConditions([live, paused, unset]), { conditions: [live], deferred: null,
    deferredConditions: [{ job: "synthetic-probe", deferred: "TRIGGER_COMMITTED_PAUSED" },
      { job: "synthetic-maintenance", deferred: "SCHEDULER_CADENCE_UNSET" }] });
  assert.deepEqual(monitoring.schedulerQuietConditions([paused, live]).conditions, [live]);
  assert.deepEqual(monitoring.schedulerQuietConditions([live]), { conditions: [live], deferred: null, deferredConditions: [] });
  assert.deepEqual(monitoring.schedulerQuietConditions([unset, paused]), { conditions: [unset, paused],
    deferred: "SCHEDULER_CADENCE_UNSET", deferredConditions: [] });
  assert.throws(() => monitoring.schedulerQuietConditions([]), { code: "MONITORING_POLICY_INVALID" });
  // The committed plane: one trigger, no cadence yet, so the whole policy waits.
  const rendered = monitoring.renderMonitoring(STAGING);
  assert.deepEqual([policy(rendered, "scheduler-quiet").deferred, "deferredConditions" in policy(rendered, "scheduler-quiet")],
    ["SCHEDULER_CADENCE_UNSET", false]);
  assert.equal(policy(monitoring.renderMonitoring(resumed("15 3 * * *")), "scheduler-quiet").deferredConditions, undefined);
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

/**
 * A log entry against a rendered filter, for the subset this module renders:
 * `field="value"` and `field=("a" OR "b")` clauses joined by AND.
 */
function filterMatches(filter, entry) {
  return filter.split(" AND ").every((clause) => {
    const match = /^([A-Za-z_.@"]+)=(?:"([^"]*)"|\(((?:"[^"]*"(?: OR )?)+)\))$/u.exec(clause);
    assert.ok(match, `unsupported clause ${clause}`);
    const value = match[1].split(".").reduce((node, key) => node?.[key.replaceAll('"', "")], entry);
    const allowed = match[2] !== undefined ? [match[2]] : [...match[3].matchAll(/"([^"]*)"/gu)].map(([, text]) => text);
    return typeof value === "string" && allowed.includes(value);
  });
}

test("K-DETECT alerts key on the probe's own schema and verdict, and wait for its job", async () => {
  const probe = await import("../cloud-run/unseen-token-probe.mjs");
  assert.equal(monitoring.UNSEEN_TOKEN_PROBE_SCHEMA, probe.UNSEEN_TOKEN_PROBE_SCHEMA);
  assert.deepEqual([...monitoring.UNSEEN_TOKEN_PROBE_VERDICTS], [...probe.UNSEEN_TOKEN_PROBE_VERDICTS]);
  const rendered = monitoring.renderMonitoring(STAGING);
  assert.match(rendered.metrics[3].body.filter, /jsonPayload\.schema="tibotattle-unseen-token-probe-v1"/u);
  assert.match(rendered.metrics[3].body.filter, /jsonPayload\.verdict=\("clear" OR "unseen"\)$/u);
  assert.match(query(rendered, "unseen-tokens"), /verdict="unseen"\}\[1d\]\)\) > 0$/u);
  assert.match(query(rendered, "unseen-tokens-silent"), /\[26h\]\)$/u);
  assert.equal(manifest.JOB_NAMES.includes(monitoring.UNSEEN_TOKEN_PROBE_JOB), false, "D-OPS4 adds the probe job");
  assert.equal(policy(rendered, "unseen-tokens").deferred, "PRODUCER_NOT_IN_MANIFEST:unseen-token-probe");
});

test("a K-DETECT probe that only fails is silence: its failure line never feeds the metric", async () => {
  const probe = await import("../cloud-run/unseen-token-probe.mjs");
  const { spawnSync } = await import("node:child_process");
  const [, , , metric] = monitoring.renderMonitoring(STAGING).metrics;
  // Cloud Run parses a JSON line on stdout or stderr into jsonPayload.
  const asEntry = (line) => ({ resource: { type: "cloud_run_job" }, jsonPayload: JSON.parse(line) });
  const failed = spawnSync(process.execPath, [join(WORKER_ROOT, "cloud-run/unseen-token-probe.mjs"),
    "--schema=synthetic_schema"], { encoding: "utf8", env: { PATH: "" }, timeout: 30_000 });
  assert.equal(failed.status, 1);
  const failure = asEntry(failed.stderr.trim());
  assert.deepEqual([failure.jsonPayload.schema, failure.jsonPayload.status], [probe.UNSEEN_TOKEN_PROBE_SCHEMA, "failed"]);
  assert.equal(filterMatches(metric.body.filter, failure), false, "a failure line is not a report");
  // Without the verdict clause the same line would have kept the silent alert quiet.
  assert.equal(filterMatches(metric.body.filter.replace(/ AND jsonPayload\.verdict=\([^)]*\)$/u, ""), failure), true);
  for (const rows of [[], [{ dimension: "model", token: "synthetic-unseen-model", records: 1 }]]) {
    const report = asEntry(JSON.stringify(probe.unseenTokenReport(rows, { day: "2026-10-01" })));
    assert.equal(filterMatches(metric.body.filter, report), true, report.jsonPayload.verdict);
    assert.equal(filterMatches(metric.body.filter, { ...report, resource: { type: "cloud_run_revision" } }), false);
  }
  // The silent condition reads that metric alone, so a failure-only day is absent.
  const silent = query(monitoring.renderMonitoring(STAGING), "unseen-tokens-silent");
  assert.equal(silent, `absent_over_time(logging_googleapis_com:user_${metric.name}{monitored_resource="cloud_run_job"}[26h])`);
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
  // Round 11: the scheduler proxy's delay is decided, not an open trade-off.
  assert.match(runbook, /\*\*Decided \(owner, round 11, 2026-10-02\): about 25 hours for a daily\s+trigger\.\*\*/u);
  assert.equal(/Open owner item \(OWN-5\)|The owner has two options/u.test(runbook), false);
  const source = readFileSync(join(SCRIPTS_ROOT, "gcp-ops-monitoring-policies.mjs"), "utf8");
  assert.match(source, /DECIDED: the owner accepted\s+\*\s+that delay for a daily trigger/u);
});

test("the origin request contract mirrors the origin's own log line where that module exists", async (t) => {
  // Skipped only while the module is absent from this line. It is read as
  // text: its imports resolve only under the bundler, and a failed import
  // must not read as a skip.
  const hostPath = join(WORKER_ROOT, "cloud-run", "postgres-host-dispatch.mjs");
  if (!existsSync(hostPath)) {
    t.skip("cloud-run/postgres-host-dispatch.mjs (W3-CRA, D-CRB) is not on this line yet");
    return;
  }
  const source = readFileSync(hostPath, "utf8");
  const frozenList = (name) => {
    const match = new RegExp(`export const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\);`, "u").exec(source);
    assert.ok(match, name);
    return [...match[1].matchAll(/"([^"]+)"/gu)].map(([, value]) => value);
  };
  assert.deepEqual(frozenList("ORIGIN_REQUEST_LOG_FIELDS"), [...monitoring.ORIGIN_REQUEST_LOG_CONTRACT.fields]);
  assert.deepEqual(frozenList("ORIGIN_REQUEST_LOG_EVENTS"), [...monitoring.ORIGIN_REQUEST_LOG_CONTRACT.events]);
  const notPorted = /export const ORIGIN_ROUTE_NOT_PORTED = Object\.freeze\(\{\s*status: (\d+),\s*code: "([A-Z_]+)",\s*\}\);/u
    .exec(source);
  assert.ok(notPorted, "ORIGIN_ROUTE_NOT_PORTED");
  assert.deepEqual({ status: Number(notPorted[1]), code: notPorted[2] }, { ...monitoring.ORIGIN_REQUEST_LOG_CONTRACT.notPorted });
  // Every excluded route is one the origin deliberately leaves unported (or
  // the admin action route, whose unported tasks answer the same code); the
  // accountless performance authorization is the one unported route left in.
  const registry = await import("../cloud-run/postgres-production-registry.mjs");
  const excluded = monitoring.originFiveXxExclusions(monitoring.ORIGIN_5XX_EXCLUSIONS).map(({ routeClass }) => routeClass);
  for (const routeClass of excluded) {
    assert.ok(routeClass === "admin_action" ? registry.ADMIN_HOST_ROUTE_IDS.includes(routeClass)
      : registry.OD_CR_2_UNPORTED_ROUTE_IDS.includes(routeClass), routeClass);
  }
  assert.deepEqual(registry.OD_CR_2_UNPORTED_ROUTE_IDS.filter((id) => !excluded.includes(id)),
    ["accountless_telemetry_performance_authorization"]);
});
