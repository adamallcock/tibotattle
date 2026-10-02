/**
 * Offline check of the OPS-5 monitoring CLI (scripts/gcp-monitoring.mjs):
 * closed arguments, render with no call and no channel value in the output,
 * readback through three guarded list calls, a deterministic plan that never
 * applies and refuses deletes, a shared project's co-tenants left out, and
 * the origin-lock probe accepting exactly Google's 403. The runner and fetch
 * are synthetic; PATH is blanked, so no real gcloud can run.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { committedDesiredStatePath, loadCommittedDesiredState } from "./gcp-ops-infra-manifest.mjs";
import {
  guardedMonitoringGcloud,
  main,
  MONITORING_READ_COMMANDS,
  parseGcpMonitoringArgs,
  planMonitoring,
  probeOriginLock,
  readbackMonitoring,
} from "./gcp-monitoring.mjs";
import { renderMonitoring } from "./gcp-ops-monitoring-policies.mjs";

process.env.PATH = "/nonexistent-gcloud-guard";

const STAGING = loadCommittedDesiredState("staging");
const PROJECT = STAGING.project;
const CHANNEL = `projects/${PROJECT}/notificationChannels/1234567890`;
const GOOGLE_403 = "<html><title>403 Forbidden</title><h1>Error: Forbidden</h1><h2>Your client does not have permission"
  + " to get URL <code>/api/health</code> from this server.</h2></html>";

/** A synthetic project's monitoring lists; `calls` records every argv. */
function fakeMonitoring({ metrics = [], uptime = [], policies = [], fail = null } = {}) {
  const calls = [];
  const runner = (argv) => {
    calls.push(argv);
    const shape = argv.slice(0, 3).join(" ");
    if (fail === shape) return { status: 1, stdout: "MARKER-5e1f" };
    if (shape === "logging metrics list") return { status: 0, stdout: JSON.stringify(metrics) };
    if (shape === "monitoring uptime list-configs") return { status: 0, stdout: JSON.stringify(uptime) };
    if (shape === "monitoring policies list") return { status: 0, stdout: JSON.stringify(policies) };
    return { status: 2, stdout: "" };
  };
  return { runner, calls };
}

/** The live shape of an estate whose resources are exactly a render (as the API would list them). */
function liveFrom(rendered) {
  return {
    metrics: rendered.metrics.map(({ body }) => ({ ...body, name: body.name, createTime: "2026-10-02T00:00:00Z" })),
    uptime: rendered.uptimeChecks.map(({ body }, index) => ({ ...body,
      name: `projects/${PROJECT}/uptimeCheckConfigs/synthetic-${index}`, checkerType: "STATIC_IP_CHECKERS" })),
    policies: rendered.policies.map(({ body }, index) => ({ ...body, name: `projects/${PROJECT}/alertPolicies/${index}`,
      conditions: body.conditions.map((condition, position) => ({ ...condition,
        name: `projects/${PROJECT}/alertPolicies/${index}/conditions/${position}` })),
      enabled: true })),
  };
}

async function run(argv, { runner = fakeMonitoring().runner, fetchImpl } = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, { runner, ...(fetchImpl === undefined ? {} : { fetchImpl }),
    now: () => Date.parse("2026-10-02T12:00:00Z"), stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
  return { code, out: out.join(""), err: err.join("") };
}

test("arguments are closed", () => {
  assert.deepEqual(parseGcpMonitoringArgs(["plan", "--environment=staging", `--notification-channel=${CHANNEL}`]), {
    command: "plan", desiredStatePath: null, environment: "staging", notificationChannel: CHANNEL });
  for (const [argv, code] of [
    [[], "GCP_MONITORING_COMMAND_INVALID"],
    [["apply", "--environment=staging"], "GCP_MONITORING_COMMAND_INVALID"],
    [["delete", "--environment=staging"], "GCP_MONITORING_COMMAND_INVALID"],
    [["plan"], "GCP_MONITORING_ARGUMENT_MISSING"],
    [["plan", "--environment=test"], "GCP_MONITORING_ENVIRONMENT_INVALID"],
    [["plan", "--desired-state=relative.json"], "GCP_MONITORING_DESIRED_STATE_PATH_INVALID"],
    [["plan", "--environment=staging", "--environment=staging"], "GCP_MONITORING_ARGUMENT_INVALID"],
    [["plan", "--environment=staging", "--authorize=x"], "GCP_MONITORING_ARGUMENT_INVALID"],
    [["readback", "--environment=staging", `--notification-channel=${CHANNEL}`], "GCP_MONITORING_ARGUMENT_INVALID"],
    [["origin-lock-probe", "--environment=staging", "--apply"], "GCP_MONITORING_ARGUMENT_INVALID"],
    [["render", "--environment="], "GCP_MONITORING_ARGUMENT_INVALID"],
  ]) {
    assert.throws(() => parseGcpMonitoringArgs(argv), { code }, argv.join(" "));
  }
});

test("render makes no call and never prints the notification channel", async () => {
  const fake = fakeMonitoring();
  const result = await run(["render", "--environment=staging", `--notification-channel=${CHANNEL}`], { runner: fake.runner });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(fake.calls, []);
  assert.equal(result.out.includes("1234567890"), false);
  const rendered = JSON.parse(result.out);
  assert.equal(rendered.notificationChannel, "assigned");
  assert.ok(rendered.policies.every(({ body }) => body.notificationChannels.every((value) => value === "<assigned>")));
  const bad = await run(["render", "--environment=staging", "--notification-channel=projects/other-proj1/notificationChannels/1"]);
  assert.deepEqual([bad.code, JSON.parse(bad.err)], [1, { status: "error", code: "MONITORING_NOTIFICATION_CHANNEL_INVALID" }]);
});

test("readback issues three guarded list calls and keeps only the plane's own resources", () => {
  const rendered = renderMonitoring(STAGING);
  const live = liveFrom(rendered);
  // A shared project: a co-tenant's metric and policy are never read into the result.
  live.metrics.push({ name: "tibotattle_test_requests", filter: 'textPayload:"x"' });
  live.policies.push({ name: `projects/${PROJECT}/alertPolicies/99`, displayName: "tibotattle-test-app-errors", conditions: [] });
  const fake = fakeMonitoring(live);
  const readback = readbackMonitoring(STAGING, { runner: fake.runner });
  assert.deepEqual(fake.calls.map((argv) => argv.slice(0, 3).join(" ")), [...MONITORING_READ_COMMANDS]);
  for (const argv of fake.calls) {
    assert.ok(argv.includes(`--project=${PROJECT}`) && argv.includes("--format=json"));
  }
  assert.equal(JSON.stringify(readback).includes("tibotattle-test"), false);
  assert.equal(JSON.stringify(readback).includes("tibotattle_test"), false);
  assert.deepEqual(Object.keys(readback.metrics), rendered.metrics.map(({ name }) => name).sort());
  // The guard refuses anything else, and never echoes gcloud output.
  const guard = guardedMonitoringGcloud(fake.runner, PROJECT);
  for (const [argv, code] of [
    [["monitoring", "policies", "create", `--project=${PROJECT}`, "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["monitoring", "policies", "delete", "x", `--project=${PROJECT}`, "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["logging", "metrics", "create", "x", `--project=${PROJECT}`, "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["logging", "read", `--project=${PROJECT}`, "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["monitoring", "policies", "list", "--project=other-project", "--format=json"], "GCLOUD_PROJECT_FLAG_INVALID"],
    [["monitoring", "policies", "list", `--project=${PROJECT}`, "--project=x", "--format=json"], "GCLOUD_PROJECT_FLAG_INVALID"],
    [["monitoring", "policies", "list", `--project=${PROJECT}`], "GCLOUD_READ_FORMAT_REQUIRED"],
  ]) {
    assert.throws(() => guard(argv), { code }, argv.join(" "));
  }
  const failing = fakeMonitoring({ fail: "monitoring policies list" });
  assert.throws(() => readbackMonitoring(STAGING, { runner: failing.runner }),
    (error) => error.code === "GCLOUD_CALL_FAILED:monitoring-policies-list" && !error.message.includes("MARKER"));
});

test("the plan is deterministic, never applies, defers what waits and refuses deletes", async () => {
  // An empty project: everything is a create; the policies wait for the channel or their signal.
  const empty = JSON.parse((await run(["plan", "--environment=staging"])).out);
  assert.deepEqual(empty.summary, { create: 5, update: 0, unchanged: 0, deferred: 11, refused: 0 });
  assert.match(empty.apply, /^not available/u);
  assert.equal(empty.notificationChannel, "unassigned");
  const again = JSON.parse((await run(["plan", "--environment=staging"])).out);
  assert.equal(again.planDigest, empty.planDigest);
  // A converged estate is unchanged; a drifted filter is an update; a stray plane policy is a refused delete.
  const rendered = renderMonitoring(STAGING, { notificationChannel: CHANNEL });
  const live = liveFrom(rendered);
  const converged = planMonitoring(rendered, readbackMonitoring(STAGING, { runner: fakeMonitoring(live).runner }));
  assert.equal(converged.summary.unchanged, 16);
  assert.deepEqual([converged.summary.create, converged.summary.update, converged.summary.refused], [0, 0, 0]);
  live.metrics[0].filter += ' AND jsonPayload.code="X"';
  live.policies.push({ name: `projects/${PROJECT}/alertPolicies/77`, displayName: "tibotattle-staging-stray", conditions: [] });
  const fake = fakeMonitoring(live);
  const drifted = await run(["plan", "--environment=staging", `--notification-channel=${CHANNEL}`], { runner: fake.runner });
  assert.equal(drifted.code, 2, "a refused delete exits 2");
  const plan = JSON.parse(drifted.out);
  assert.ok(plan.operations.some(({ id }) => id === "log-metric:update:origin-request-failure"));
  assert.deepEqual(plan.operations.filter(({ action }) => action === "delete"), [{ id: "alert-policy:delete:tibotattle-staging-stray",
    kind: "alert-policy", name: "tibotattle-staging-stray", action: "delete", refused: "MONITORING_DELETE_REFUSED" }]);
  assert.equal(drifted.out.includes("1234567890"), false, "the channel value never reaches the plan");
  assert.ok(fake.calls.every((argv) => MONITORING_READ_COMMANDS.includes(argv.slice(0, 3).join(" "))));
  // A channel change is an update, detected by digest only.
  const otherChannel = planMonitoring(renderMonitoring(STAGING, {
    notificationChannel: `projects/${PROJECT}/notificationChannels/42` }),
  readbackMonitoring(STAGING, { runner: fakeMonitoring(liveFrom(rendered)).runner }));
  assert.equal(otherChannel.operations.filter(({ action }) => action === "update").length, 11);
  assert.throws(() => planMonitoring(rendered, { schema: "other" }), { code: "MONITORING_PLAN_READBACK_INVALID" });
});

test("production waits for its owner placeholders", async () => {
  assert.match(committedDesiredStatePath("production"), /production\.desired-state\.json$/u);
  const result = await run(["render", "--environment=production"]);
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.err).code, /^DESIRED_STATE_PLACEHOLDER_UNFILLED/u);
});

test("the origin-lock probe accepts exactly Google's front-end 403 and never prints the body", async () => {
  const respond = (status, body, headers = {}) => async (url, init) => {
    assert.equal(url, `https://${STAGING.service.host}/api/health`);
    assert.deepEqual([init.method, init.redirect, init.credentials, init.headers], ["GET", "manual", "omit", undefined]);
    return { status, headers: new Headers(headers), text: async () => body };
  };
  const locked = await probeOriginLock(STAGING, { fetchImpl: respond(403, GOOGLE_403, { "content-type": "text/html" }) });
  assert.deepEqual([locked.verdict, locked.status, locked.googleFrontEnd, locked.originMarker], ["locked", 403, true, false]);
  for (const [fetchImpl, verdict] of [
    [respond(200, '{"status":"ok"}', { "x-tibotattle-origin": "1" }), "open"],
    [respond(403, '{"error":{"code":"FORBIDDEN"}}', { "x-tibotattle-origin": "1" }), "open"],
    [respond(403, GOOGLE_403, { "x-tibotattle-origin": "1" }), "open"],
    [respond(403, "Forbidden"), "unexpected"],
    [respond(401, GOOGLE_403), "unexpected"],
    [respond(302, ""), "open"],
    [respond(503, "Service Unavailable"), "unexpected"],
    [respond(403, `${GOOGLE_403}${"x".repeat(70 * 1024)}`), "unexpected"],
    [async () => { throw new Error("synthetic network failure"); }, "unreachable"],
  ]) {
    assert.equal((await probeOriginLock(STAGING, { fetchImpl })).verdict, verdict);
  }
  const ok = await run(["origin-lock-probe", "--environment=staging"], { fetchImpl: respond(403, GOOGLE_403) });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out.includes("Your client"), false, "the body is never printed");
  const open = await run(["origin-lock-probe", "--environment=staging"], { fetchImpl: respond(200, "{}") });
  assert.equal(open.code, 2);
});
