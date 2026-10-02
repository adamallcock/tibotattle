/**
 * Offline check of the OPS-5 monitoring CLI (scripts/gcp-monitoring.mjs):
 * closed arguments, render with no call and no channel value in the output,
 * readback through three guarded list calls, a deterministic plan that never
 * applies and refuses deletes, a shared project's co-tenants left out, and
 * the origin-lock probe accepting exactly Google's 403. The runner and fetch
 * are synthetic; PATH is blanked, so no real gcloud can run.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { committedDesiredStatePath, loadCommittedDesiredState } from "./gcp-ops-infra-manifest.mjs";
import {
  CHANNEL_GCLOUD_ENV,
  defaultMonitoringRunner,
  emailChannelDisplayName,
  ensureEmailChannel,
  guardedChannelGcloud,
  guardedMonitoringGcloud,
  main,
  MONITORING_CHANNEL_COMMANDS,
  readAlertEmailFile,
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
/** Obviously fake: the .invalid TLD never resolves (RFC 2606). */
const SYNTHETIC_EMAIL = "alerts@example.invalid";
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
    command: "plan", desiredStatePath: null, environment: "staging", notificationChannel: CHANNEL, emailFile: null,
    authorize: null });
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
    [["plan", "--environment=staging", `--email=${SYNTHETIC_EMAIL}`], "GCP_MONITORING_ARGUMENT_INVALID"],
    [["notification-channel", "--environment=staging"], "GCP_MONITORING_EMAIL_FILE_REQUIRED"],
    // There is no address argument: it would land in shell history and the process list.
    [["notification-channel", "--environment=staging", `--email=${SYNTHETIC_EMAIL}`], "GCP_MONITORING_ARGUMENT_INVALID"],
    [["notification-channel", "--environment=staging", `--email=${SYNTHETIC_EMAIL}`, "--email-file=/x"],
      "GCP_MONITORING_ARGUMENT_INVALID"],
    [["notification-channel", "--environment=staging", "--email-file=relative"], "GCP_MONITORING_EMAIL_FILE_PATH_INVALID"],
    [["notification-channel", "--environment=staging", "--email-file=/x", "--authorize=abc"],
      "GCP_MONITORING_AUTHORIZE_INVALID"],
    [["notification-channel", "--environment=staging", "--email-file=/x",
      `--notification-channel=${CHANNEL}`], "GCP_MONITORING_ARGUMENT_INVALID"],
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
  // Six metrics and two uptime checks (origin-lock, edge-health) are creates; the thirteen policies wait.
  assert.deepEqual(empty.summary, { create: 8, update: 0, unchanged: 0, deferred: 13, refused: 0 });
  assert.match(empty.apply, /^not available/u);
  assert.equal(empty.notificationChannel, "unassigned");
  const again = JSON.parse((await run(["plan", "--environment=staging"])).out);
  assert.equal(again.planDigest, empty.planDigest);
  // A converged estate is unchanged; a drifted filter is an update; a stray plane policy is a refused delete.
  const rendered = renderMonitoring(STAGING, { notificationChannel: CHANNEL });
  const live = liveFrom(rendered);
  const converged = planMonitoring(rendered, readbackMonitoring(STAGING, { runner: fakeMonitoring(live).runner }));
  assert.equal(converged.summary.unchanged, 21);
  assert.deepEqual([converged.summary.create, converged.summary.update, converged.summary.refused], [0, 0, 0]);
  live.metrics[0].filter += ' AND jsonPayload.code="X"';
  // A distribution metric that extracts another field, or buckets differently, is drift too.
  const account = live.metrics.find(({ name }) => name.endsWith("_analytics_refresh_output_account"));
  account.valueExtractor = "EXTRACT(jsonPayload.memory.effectiveOutputBudgetMiB)";
  const budget = live.metrics.find(({ name }) => name.endsWith("_analytics_refresh_output_budget"));
  budget.bucketOptions = { exponentialBuckets: { numFiniteBuckets: 10, growthFactor: 2, scale: 1 } };
  live.policies.push({ name: `projects/${PROJECT}/alertPolicies/77`, displayName: "tibotattle-staging-stray", conditions: [] });
  const fake = fakeMonitoring(live);
  const drifted = await run(["plan", "--environment=staging", `--notification-channel=${CHANNEL}`], { runner: fake.runner });
  assert.equal(drifted.code, 2, "a refused delete exits 2");
  const plan = JSON.parse(drifted.out);
  assert.ok(plan.operations.some(({ id }) => id === "log-metric:update:origin-request-failure"));
  assert.ok(plan.operations.some(({ id }) => id === "log-metric:update:analytics-refresh-output-account"));
  assert.ok(plan.operations.some(({ id }) => id === "log-metric:update:analytics-refresh-output-budget"));
  assert.deepEqual(plan.operations.filter(({ action }) => action === "delete"), [{ id: "alert-policy:delete:tibotattle-staging-stray",
    kind: "alert-policy", name: "tibotattle-staging-stray", action: "delete", refused: "MONITORING_DELETE_REFUSED" }]);
  assert.equal(drifted.out.includes("1234567890"), false, "the channel value never reaches the plan");
  assert.ok(fake.calls.every((argv) => MONITORING_READ_COMMANDS.includes(argv.slice(0, 3).join(" "))));
  // A channel change is an update, detected by digest only.
  const otherChannel = planMonitoring(renderMonitoring(STAGING, {
    notificationChannel: `projects/${PROJECT}/notificationChannels/42` }),
  readbackMonitoring(STAGING, { runner: fakeMonitoring(liveFrom(rendered)).runner }));
  assert.equal(otherChannel.operations.filter(({ action }) => action === "update").length, 13);
  assert.throws(() => planMonitoring(rendered, { schema: "other" }), { code: "MONITORING_PLAN_READBACK_INVALID" });
  // A policy that dropped a deferred trigger's condition says so in the plan.
  const dropped = structuredClone(rendered);
  dropped.policies.find(({ id }) => id === "scheduler-quiet").deferredConditions = [
    { job: "synthetic-probe", deferred: "TRIGGER_COMMITTED_PAUSED" }];
  const named = planMonitoring(dropped, readbackMonitoring(STAGING, { runner: fakeMonitoring(liveFrom(rendered)).runner }));
  assert.deepEqual(named.operations.find(({ id }) => id.endsWith(":scheduler-quiet")).deferredConditions,
    [{ job: "synthetic-probe", deferred: "TRIGGER_COMMITTED_PAUSED" }]);
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

/** A synthetic project's notification channels; create appends one and returns it. */
function fakeChannels(initial = [], { createName = `projects/${PROJECT}/notificationChannels/555`, failCreate = false } = {}) {
  const channels = structuredClone(initial);
  const calls = [];
  const options = [];
  const runner = (argv, runOptions) => {
    calls.push(argv);
    options.push(runOptions);
    const shape = argv.slice(0, 4).join(" ");
    if (shape === "beta monitoring channels list") return { status: 0, stdout: JSON.stringify(channels) };
    if (shape === "beta monitoring channels create") {
      if (failCreate) return { status: 1, stdout: SYNTHETIC_EMAIL };
      const label = argv.find((arg) => arg.startsWith("--channel-labels=email_address="));
      const created = { name: createName, type: "email", enabled: true,
        displayName: argv.find((arg) => arg.startsWith("--display-name=")).slice("--display-name=".length),
        labels: { email_address: label.slice("--channel-labels=email_address=".length) } };
      channels.push(created);
      return { status: 0, stdout: JSON.stringify(created) };
    }
    return { status: 2, stdout: "" };
  };
  return { runner, calls, options, channels };
}

function privateEmailFile(contents = `${SYNTHETIC_EMAIL}\n`, mode = 0o600) {
  const directory = mkdtempSync(join(tmpdir(), "own5c-channel-"));
  const path = join(directory, "alert-email");
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return { directory, path };
}

const noAddress = (text) => !text.includes(SYNTHETIC_EMAIL) && !text.includes("example.invalid");

test("notification-channel finds or creates the plane's one email channel, never printing the address", async () => {
  assert.deepEqual([...MONITORING_CHANNEL_COMMANDS], ["beta monitoring channels list", "beta monitoring channels create"]);
  assert.equal(emailChannelDisplayName(STAGING), "tibotattle-staging-alerts-email");
  const { directory, path } = privateEmailFile();
  try {
    // Dry run on an empty project: one list call, the create is planned under a digest.
    const fake = fakeChannels();
    const dry = await run(["notification-channel", "--environment=staging", `--email-file=${path}`], { runner: fake.runner });
    assert.equal(dry.code, 0, dry.err);
    const plan = JSON.parse(dry.out);
    assert.deepEqual([plan.action, plan.channel, plan.applied, plan.displayName, plan.type],
      ["create", null, false, "tibotattle-staging-alerts-email", "email"]);
    assert.match(plan.planDigest, /^[0-9a-f]{64}$/u);
    assert.deepEqual(fake.calls.map((argv) => argv.slice(0, 4).join(" ")), ["beta monitoring channels list"]);
    assert.ok(noAddress(dry.out + dry.err));
    // The digest is the same whatever the address: it never binds or leaks it.
    const otherFile = privateEmailFile("someone-else@example.invalid\n");
    try {
      const other = await run(["notification-channel", "--environment=staging", `--email-file=${otherFile.path}`],
        { runner: fakeChannels().runner });
      assert.equal(JSON.parse(other.out).planDigest, plan.planDigest);
    } finally {
      rmSync(otherFile.directory, { recursive: true, force: true });
    }
    // A wrong digest is refused before any create.
    const wrong = await run(["notification-channel", "--environment=staging", `--email-file=${path}`,
      `--authorize=${"0".repeat(64)}`], { runner: fake.runner });
    assert.deepEqual([wrong.code, JSON.parse(wrong.err).code], [1, "MONITORING_CHANNEL_AUTHORIZATION_MISMATCH"]);
    assert.equal(fake.calls.some((argv) => argv[3] === "create"), false);
    // Authorized: one create, then a read-back; the output is the channel name only.
    const applied = await run(["notification-channel", "--environment=staging", `--email-file=${path}`,
      `--authorize=${plan.planDigest}`], { runner: fake.runner });
    assert.equal(applied.code, 0, applied.err);
    const receipt = JSON.parse(applied.out);
    assert.deepEqual([receipt.action, receipt.channel, receipt.applied], ["created", `projects/${PROJECT}/notificationChannels/555`, true]);
    assert.ok(noAddress(applied.out + applied.err), "the receipt carries the channel name only");
    const create = fake.calls.find((argv) => argv[3] === "create");
    assert.ok(create.includes(`--project=${PROJECT}`) && create.includes("--type=email") && create.includes("--format=json"));
    assert.ok(create.includes(`--channel-labels=email_address=${SYNTHETIC_EMAIL}`), "the address goes only to gcloud");
    assert.equal(fake.calls.at(-1).slice(0, 4).join(" "), "beta monitoring channels list", "read back after create");
    // gcloud logs every command's arguments to its own files: every channel
    // call, the create above all, runs with file and HTTP logging off.
    assert.deepEqual({ ...CHANNEL_GCLOUD_ENV },
      { CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "true", CLOUDSDK_CORE_LOG_HTTP: "false" });
    assert.equal(fake.options.length, fake.calls.length);
    for (const runOptions of fake.options) {
      assert.deepEqual(runOptions, { env: { ...CHANNEL_GCLOUD_ENV } });
    }
    assert.equal(fake.options[fake.calls.indexOf(create)].env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING, "true");
    // Idempotent: a second run finds it, with or without the digest, and creates nothing.
    for (const extra of [[], [`--authorize=${plan.planDigest}`]]) {
      const before = fake.calls.length;
      const found = await run(["notification-channel", "--environment=staging", `--email-file=${path}`, ...extra],
        { runner: fake.runner });
      assert.equal(found.code, 0, found.err);
      assert.deepEqual([JSON.parse(found.out).action, JSON.parse(found.out).channel],
        ["found", `projects/${PROJECT}/notificationChannels/555`]);
      assert.equal(fake.calls.slice(before).some((argv) => argv[3] === "create"), false);
    }
    // The found channel feeds render and plan as --notification-channel.
    assert.equal(renderMonitoring(STAGING, { notificationChannel: receipt.channel }).notificationChannel, "assigned");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("notification-channel refuses an ambiguous, mismatched or unconfirmed channel and never changes one", () => {
  const displayName = "tibotattle-staging-alerts-email";
  const channel = (id, extra = {}) => ({ name: `projects/${PROJECT}/notificationChannels/${id}`, displayName,
    type: "email", enabled: true, labels: { email_address: SYNTHETIC_EMAIL }, ...extra });
  for (const [channels, code] of [
    [[channel(1), channel(2)], "MONITORING_CHANNEL_AMBIGUOUS"],
    [[channel(1, { labels: { email_address: "other@example.invalid" } })], "MONITORING_CHANNEL_ADDRESS_MISMATCH"],
    [[channel(1, { type: "sms" })], "MONITORING_CHANNEL_TYPE_MISMATCH"],
    [[channel(1, { enabled: false })], "MONITORING_CHANNEL_DISABLED"],
    [[channel(1, { name: "projects/other-project/notificationChannels/1" })], "MONITORING_CHANNEL_NAME_INVALID"],
  ]) {
    const fake = fakeChannels(channels);
    assert.throws(() => ensureEmailChannel(STAGING, { address: SYNTHETIC_EMAIL, runner: fake.runner }),
      (error) => error.code === code && noAddress(error.message), code);
    assert.equal(fake.calls.some((argv) => argv[3] === "create"), false);
  }
  // Case differences in the address still match; other planes' channels are ignored.
  const mixed = fakeChannels([channel(9, { labels: { email_address: "Alerts@Example.Invalid" } }),
    { ...channel(10), displayName: "tibotattle-alerts-email" }]);
  assert.equal(ensureEmailChannel(STAGING, { address: SYNTHETIC_EMAIL, runner: mixed.runner }).channel,
    `projects/${PROJECT}/notificationChannels/9`);
  // A create that fails, or that the read-back does not show, is unconfirmed; gcloud output is never echoed.
  const planDigest = ensureEmailChannel(STAGING, { address: SYNTHETIC_EMAIL, runner: fakeChannels().runner }).planDigest;
  assert.throws(() => ensureEmailChannel(STAGING, { address: SYNTHETIC_EMAIL, authorize: planDigest,
    runner: fakeChannels([], { failCreate: true }).runner }),
  (error) => error.code === "GCLOUD_CALL_FAILED:beta-monitoring-channels-create" && noAddress(error.message));
  assert.throws(() => ensureEmailChannel(STAGING, { address: SYNTHETIC_EMAIL, authorize: planDigest,
    runner: fakeChannels([], { createName: "projects/other-project/notificationChannels/5" }).runner }),
  { code: "MONITORING_CHANNEL_CREATE_UNCONFIRMED" });
  // The list-only guard never creates; every call is pinned to the plane's project and JSON.
  const guard = guardedChannelGcloud(fakeChannels().runner, PROJECT);
  for (const [argv, code] of [
    [["beta", "monitoring", "channels", "create", `--project=${PROJECT}`, "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["beta", "monitoring", "channels", "delete", `--project=${PROJECT}`, "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["beta", "monitoring", "channels", "update", `--project=${PROJECT}`, "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["beta", "monitoring", "channels", "list", "--project=other", "--format=json"], "GCLOUD_PROJECT_FLAG_INVALID"],
    [["beta", "monitoring", "channels", "list", `--project=${PROJECT}`], "GCLOUD_READ_FORMAT_REQUIRED"],
  ]) {
    assert.throws(() => guard(argv), { code }, argv.join(" "));
  }
  for (const address of ["", "not-an-address", "a@b", "spaces in@example.invalid", `${"a".repeat(250)}@example.invalid`,
    "x@example.invalid\nBcc: y@example.invalid"]) {
    assert.throws(() => ensureEmailChannel(STAGING, { address, runner: fakeChannels().runner }),
      { code: "GCP_MONITORING_EMAIL_INVALID" }, JSON.stringify(address));
  }
});

test("the address file must be private, regular, outside the repository and hold one address", async () => {
  const { directory, path } = privateEmailFile();
  try {
    assert.equal(readAlertEmailFile(path), SYNTHETIC_EMAIL);
    chmodSync(path, 0o644);
    assert.throws(() => readAlertEmailFile(path), { code: "GCP_MONITORING_EMAIL_FILE_UNSAFE" });
    chmodSync(path, 0o600);
    const link = join(directory, "link");
    symlinkSync(path, link);
    assert.throws(() => readAlertEmailFile(link), { code: "GCP_MONITORING_EMAIL_FILE_UNSAFE" });
    assert.throws(() => readAlertEmailFile(join(directory, "missing")), { code: "GCP_MONITORING_EMAIL_FILE_UNREADABLE" });
    assert.throws(() => readAlertEmailFile(directory), { code: "GCP_MONITORING_EMAIL_FILE_UNSAFE" });
    for (const contents of [`${SYNTHETIC_EMAIL}\n${SYNTHETIC_EMAIL}\n`, "", `${"x".repeat(600)}`, " alerts@example.invalid"]) {
      writeFileSync(path, contents);
      assert.throws(() => readAlertEmailFile(path), (error) => /^GCP_MONITORING_EMAIL_(?:INVALID|FILE_UNSAFE)$/u
        .test(error.code) && noAddress(error.message), JSON.stringify(contents.slice(0, 20)));
    }
    // A file inside the repository is refused, so the address cannot be committed by accident.
    const inside = join(dirname(fileURLToPath(import.meta.url)), "gcp-monitoring.check.mjs");
    assert.throws(() => readAlertEmailFile(inside), { code: "GCP_MONITORING_EMAIL_FILE_IN_REPOSITORY" });
    // The CLI's failure line is a closed code only.
    writeFileSync(path, "not-an-address\n");
    const refused = await run(["notification-channel", "--environment=staging", `--email-file=${path}`],
      { runner: fakeChannels().runner });
    assert.deepEqual([refused.code, JSON.parse(refused.err)], [1, { status: "error", code: "GCP_MONITORING_EMAIL_INVALID" }]);
    assert.equal(refused.out, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the default runner spawns gcloud under the inherited environment, with the channel overrides winning", () => {
  const spawned = [];
  const spawn = (command, argv, options) => {
    spawned.push({ command, argv, options });
    return { status: 0, stdout: "[]", error: undefined };
  };
  const saved = { file: process.env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING, http: process.env.CLOUDSDK_CORE_LOG_HTTP };
  try {
    // The operator's own environment asks for file and HTTP logging; the channel calls override it.
    process.env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING = "false";
    process.env.CLOUDSDK_CORE_LOG_HTTP = "true";
    const list = ["beta", "monitoring", "channels", "list", `--project=${PROJECT}`, "--format=json"];
    assert.deepEqual(guardedChannelGcloud((argv, options) => defaultMonitoringRunner(argv, { ...options, spawn }),
      PROJECT)(list), []);
    const [call] = spawned;
    assert.equal(call.command, "gcloud");
    assert.deepEqual(call.argv, list);
    assert.equal(call.options.env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING, "true");
    assert.equal(call.options.env.CLOUDSDK_CORE_LOG_HTTP, "false");
    assert.equal(call.options.env.PATH, process.env.PATH, "the rest of the environment is inherited");
    assert.equal(call.options.shell, undefined, "no shell");
    // The monitoring readback keeps the inherited environment unchanged.
    defaultMonitoringRunner(["logging", "metrics", "list"], { spawn });
    assert.equal(spawned[1].options.env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING, "false");
  } finally {
    for (const [name, value] of [["CLOUDSDK_CORE_DISABLE_FILE_LOGGING", saved.file], ["CLOUDSDK_CORE_LOG_HTTP", saved.http]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
