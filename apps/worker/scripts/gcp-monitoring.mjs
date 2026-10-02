#!/usr/bin/env node

/**
 * Operator CLI for monitoring and alerting as code (OPS-5, E-OPS5): render,
 * readback and plan only. Nothing here creates, changes or deletes a
 * monitoring resource; apply is a later, separately authorized stream.
 *
 *   render  (--environment=<production|staging> | --desired-state=<abs path>)
 *           [--notification-channel=projects/<project>/notificationChannels/<id>]
 *     The plane's log-based metrics, uptime check and alert policies
 *     (gcp-ops-monitoring-policies.mjs), privacy-scanned; no call.
 *   readback (--environment | --desired-state)
 *     Three list calls (logging metrics, uptime checks, alert policies), each
 *     through a read-only guard with --project and --format=json, reduced to
 *     the managed fields of the plane's own resources.
 *   plan    (--environment | --desired-state) [--notification-channel=...]
 *     Readback plus the deterministic plan (create, update, unchanged,
 *     deferred, and live plane resources the render does not name, which an
 *     apply would refuse to delete) and its planDigest.
 *   origin-lock-probe (--environment | --desired-state)
 *     One unauthenticated GET of https://<service host>/api/health. Exit 0
 *     only for exactly Google's front-end 403 (status 403, no origin marker
 *     header, Google's body text); the body is never printed.
 *
 * The notification channel (OWN-5c) is an input: it is never written to the
 * output, which says only "assigned" or "unassigned". Output is one
 * content-free JSON document on stdout; errors are {"status":"error","code"}
 * on stderr without gcloud output. Exit 0 on success, 2 when a plan holds a
 * refused delete or the origin is not locked, 1 on any error.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  GCP_OPS_INFRA_ENVIRONMENTS,
  GcpOpsInfraError,
  deepFreeze,
  fail,
  loadCommittedDesiredState,
  readDesiredStateFile,
  requireEnvironment,
  sha256Hex,
} from "./gcp-ops-infra-manifest.mjs";
import {
  GOOGLE_FRONT_END_403_TEXT,
  ORIGIN_LOCK_ACCEPTED_STATUSES,
  renderMonitoring,
  renderedDigest,
} from "./gcp-ops-monitoring-policies.mjs";

export const GCP_MONITORING_READBACK_SCHEMA = "tibotattle-gcp-monitoring-readback-v1";
export const GCP_MONITORING_PLAN_SCHEMA = "tibotattle-gcp-monitoring-plan-v1";
export const GCP_MONITORING_ORIGIN_LOCK_SCHEMA = "tibotattle-gcp-monitoring-origin-lock-v1";
/** The only gcloud shapes this CLI issues: list calls. */
export const MONITORING_READ_COMMANDS = Object.freeze([
  "logging metrics list",
  "monitoring uptime list-configs",
  "monitoring policies list",
]);
const ORIGIN_MARKER_HEADER = "x-tibotattle-origin";
const PROBE_BODY_MAX_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const GCLOUD_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const SOURCE = Object.freeze(["--desired-state", "--environment"]);
const COMMANDS = Object.freeze({
  render: Object.freeze([...SOURCE, "--notification-channel"]),
  readback: Object.freeze([...SOURCE]),
  plan: Object.freeze([...SOURCE, "--notification-channel"]),
  "origin-lock-probe": Object.freeze([...SOURCE]),
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Closed argument parsing. */
export function parseGcpMonitoringArgs(argv) {
  if (!Array.isArray(argv) || !Object.hasOwn(COMMANDS, argv[0])) fail("GCP_MONITORING_COMMAND_INVALID");
  const values = new Map();
  for (const argument of argv.slice(1)) {
    const separator = typeof argument === "string" ? argument.indexOf("=") : -1;
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (separator < 3 || !argument.startsWith("--") || !COMMANDS[argv[0]].includes(name)
        || argument.length === separator + 1 || values.has(name)) {
      fail("GCP_MONITORING_ARGUMENT_INVALID");
    }
    values.set(name, argument.slice(separator + 1));
  }
  const desiredStatePath = values.get("--desired-state") ?? null;
  const environment = values.get("--environment") ?? null;
  if (desiredStatePath === null && environment === null) fail("GCP_MONITORING_ARGUMENT_MISSING");
  if (desiredStatePath !== null && !isAbsolute(desiredStatePath)) fail("GCP_MONITORING_DESIRED_STATE_PATH_INVALID");
  if (environment !== null && !GCP_OPS_INFRA_ENVIRONMENTS.includes(environment)) fail("GCP_MONITORING_ENVIRONMENT_INVALID");
  return Object.freeze({
    command: argv[0],
    desiredStatePath: desiredStatePath === null ? null : resolve(desiredStatePath),
    environment,
    notificationChannel: values.get("--notification-channel") ?? null,
  });
}

// ---------------------------------------------------------------------------
// Readback

/** The default runner: spawnSync with an argv array and no shell. */
export function defaultMonitoringRunner(argv) {
  const result = spawnSync("gcloud", argv, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GCLOUD_MAX_BUFFER_BYTES, windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, error: result.error };
}

function shapeOf(argv) {
  const positional = [];
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.startsWith("-")) break;
    positional.push(arg);
  }
  return positional.join(" ");
}

/** A read-only guard: only MONITORING_READ_COMMANDS, one --project, --format=json; output never echoed. */
export function guardedMonitoringGcloud(runner, project) {
  if (typeof runner !== "function") fail("GCLOUD_RUNNER_INVALID");
  return (argv) => {
    if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")
        || !MONITORING_READ_COMMANDS.includes(shapeOf(argv))) {
      fail("GCLOUD_COMMAND_FORBIDDEN");
    }
    if (argv.filter((arg) => arg.startsWith("--project=")).length !== 1 || !argv.includes(`--project=${project}`)) {
      fail("GCLOUD_PROJECT_FLAG_INVALID");
    }
    if (!argv.includes("--format=json")) fail("GCLOUD_READ_FORMAT_REQUIRED");
    const what = shapeOf(argv).replaceAll(" ", "-");
    let result;
    try {
      result = runner([...argv]);
    } catch {
      fail(`GCLOUD_CALL_FAILED:${what}`);
    }
    if (!isRecord(result) || result.status !== 0 || (result.error !== undefined && result.error !== null)
        || typeof result.stdout !== "string") {
      fail(`GCLOUD_CALL_FAILED:${what}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout === "" ? "[]" : result.stdout);
    } catch {
      fail(`GCLOUD_OUTPUT_INVALID:${what}`);
    }
    if (!Array.isArray(parsed)) fail(`GCLOUD_OUTPUT_INVALID:${what}`);
    return parsed;
  };
}

function tail(name) {
  return typeof name === "string" ? name.slice(name.lastIndexOf("/") + 1) : null;
}

function planeOwns(desired, name, separator) {
  const prefix = desired.environment === "production" ? "tibotattle" : "tibotattle_staging";
  return desired.projectTenancy === "dedicated" || name.startsWith(`${prefix.replaceAll("_", separator)}${separator}`);
}

/** The managed fields of a log-based metric, live or rendered. */
export function metricView(metric) {
  return {
    filter: metric?.filter ?? null,
    labelExtractors: isRecord(metric?.labelExtractors) ? metric.labelExtractors : {},
    labels: (Array.isArray(metric?.metricDescriptor?.labels) ? metric.metricDescriptor.labels : [])
      .map((label) => label?.key ?? null).sort(),
  };
}

/** The managed fields of an uptime check, live or rendered. */
export function uptimeView(check) {
  const http = check?.httpCheck ?? {};
  return {
    monitoredResource: check?.monitoredResource ?? null,
    httpCheck: {
      requestMethod: http.requestMethod ?? null, path: http.path ?? null, port: Number(http.port ?? 0),
      useSsl: http.useSsl === true, validateSsl: http.validateSsl === true,
      acceptedResponseStatusCodes: (http.acceptedResponseStatusCodes ?? []).map((entry) => Number(entry?.statusValue)),
      authenticated: http.authInfo !== undefined || http.headers !== undefined,
    },
    contentMatchers: (check?.contentMatchers ?? []).map(({ content, matcher }) => ({ content, matcher })),
    period: check?.period ?? null,
    timeout: check?.timeout ?? null,
  };
}

/** The managed fields of an alert policy; channels compare by digest only. */
export function policyView(policy) {
  const channels = Array.isArray(policy?.notificationChannels) ? [...policy.notificationChannels].sort() : [];
  return {
    conditions: (Array.isArray(policy?.conditions) ? policy.conditions : []).map((condition) => {
      const { name: _name, ...rest } = isRecord(condition) ? condition : {};
      return rest;
    }),
    combiner: policy?.combiner ?? null,
    documentation: policy?.documentation?.content ?? null,
    userLabels: isRecord(policy?.userLabels) ? policy.userLabels : {},
    severity: policy?.severity ?? null,
    channelsDigest: sha256Hex(canonicalJson(channels)),
  };
}

/** Reads the plane's monitoring resources: three list calls, managed fields only. */
export function readbackMonitoring(desired, { runner = defaultMonitoringRunner } = {}) {
  const call = guardedMonitoringGcloud(runner, desired.project);
  const project = `--project=${desired.project}`;
  const metrics = call(["logging", "metrics", "list", project, "--format=json"])
    .filter((entry) => typeof entry?.name === "string" && planeOwns(desired, tail(entry.name), "_"));
  const uptime = call(["monitoring", "uptime", "list-configs", project, "--format=json"])
    .filter((entry) => typeof entry?.displayName === "string" && planeOwns(desired, entry.displayName, "-"));
  const policies = call(["monitoring", "policies", "list", project, "--format=json"])
    .filter((entry) => typeof entry?.displayName === "string" && planeOwns(desired, entry.displayName, "-"));
  const by = (entries, key, view) => Object.fromEntries(entries.map((entry) => [key(entry), view(entry)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  return deepFreeze({
    schema: GCP_MONITORING_READBACK_SCHEMA,
    environment: desired.environment,
    project: desired.project,
    metrics: by(metrics, (entry) => tail(entry.name), metricView),
    uptimeChecks: by(uptime, (entry) => entry.displayName, uptimeView),
    policies: by(policies, (entry) => entry.displayName, policyView),
  });
}

// ---------------------------------------------------------------------------
// Plan

function compare(kind, rendered, live, view) {
  return rendered.map((entry) => {
    const deferred = entry.deferred === undefined ? {} : { deferred: entry.deferred };
    if (!Object.hasOwn(live, entry.name)) return { id: `${kind}:create:${entry.id}`, kind, name: entry.name, action: "create", ...deferred };
    const same = canonicalJson(view(entry.body)) === canonicalJson(live[entry.name]);
    return { id: `${kind}:${same ? "unchanged" : "update"}:${entry.id}`, kind, name: entry.name,
      action: same ? "unchanged" : "update", ...deferred };
  });
}

/** The deterministic plan for a render and a readback. */
export function planMonitoring(rendered, readback) {
  if (readback?.schema !== GCP_MONITORING_READBACK_SCHEMA || readback.project !== rendered.project) {
    fail("MONITORING_PLAN_READBACK_INVALID");
  }
  const operations = [
    ...compare("log-metric", rendered.metrics, readback.metrics, metricView),
    ...compare("uptime-check", rendered.uptimeChecks, readback.uptimeChecks, uptimeView),
    ...compare("alert-policy", rendered.policies, readback.policies, policyView),
  ];
  const named = new Set([...rendered.metrics, ...rendered.uptimeChecks, ...rendered.policies].map(({ name }) => name));
  for (const [kind, live] of [["log-metric", readback.metrics], ["uptime-check", readback.uptimeChecks],
    ["alert-policy", readback.policies]]) {
    for (const name of Object.keys(live).filter((entry) => !named.has(entry))) {
      operations.push({ id: `${kind}:delete:${name}`, kind, name, action: "delete", refused: "MONITORING_DELETE_REFUSED" });
    }
  }
  const body = {
    schema: GCP_MONITORING_PLAN_SCHEMA,
    environment: rendered.environment,
    project: rendered.project,
    desiredStateDigest: rendered.desiredStateDigest,
    renderedDigest: renderedDigest(rendered),
    notificationChannel: rendered.notificationChannel,
    operations,
    summary: {
      create: operations.filter(({ action, deferred }) => action === "create" && deferred === undefined).length,
      update: operations.filter(({ action, deferred }) => action === "update" && deferred === undefined).length,
      unchanged: operations.filter(({ action }) => action === "unchanged").length,
      deferred: operations.filter(({ deferred }) => deferred !== undefined).length,
      refused: operations.filter(({ refused }) => refused !== undefined).length,
    },
    apply: "not available: E-OPS5 renders, reads back and plans only",
  };
  return deepFreeze({ ...body, planDigest: sha256Hex(canonicalJson(body)) });
}

// ---------------------------------------------------------------------------
// Origin lock

async function boundedText(response) {
  try {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") > PROBE_BODY_MAX_BYTES ? null : text;
  } catch {
    return null;
  }
}

/**
 * One unauthenticated GET of the service's run.app /api/health. "locked" only
 * for status exactly 403 with Google's front-end text and no origin marker
 * header: an origin that answered at all (any marker, any 2xx, a JSON 403)
 * or anything else is "open" or "unexpected". The body is never returned.
 */
export async function probeOriginLock(desired, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const url = `https://${desired.service.host}/api/health`;
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", redirect: "manual", credentials: "omit",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return deepFreeze({ schema: GCP_MONITORING_ORIGIN_LOCK_SCHEMA, environment: desired.environment,
      host: desired.service.host, checkedAt: new Date(now()).toISOString(), status: null, originMarker: false,
      googleFrontEnd: false, verdict: "unreachable" });
  }
  const status = Number(response.status);
  const originMarker = response.headers?.get?.(ORIGIN_MARKER_HEADER) !== null
    && response.headers?.get?.(ORIGIN_MARKER_HEADER) !== undefined;
  const text = await boundedText(response);
  const googleFrontEnd = text !== null && text.includes(GOOGLE_FRONT_END_403_TEXT);
  const verdict = ORIGIN_LOCK_ACCEPTED_STATUSES.includes(status) && !originMarker && googleFrontEnd ? "locked"
    : status >= 200 && status < 400 || originMarker ? "open" : "unexpected";
  return deepFreeze({ schema: GCP_MONITORING_ORIGIN_LOCK_SCHEMA, environment: desired.environment,
    host: desired.service.host, checkedAt: new Date(now()).toISOString(), status, originMarker, googleFrontEnd, verdict });
}

// ---------------------------------------------------------------------------
// CLI

/** CLI entry; returns the process exit code. */
export async function main(argv = process.argv.slice(2), {
  runner = defaultMonitoringRunner,
  fetchImpl = globalThis.fetch,
  readFile,
  readSource,
  now,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  const print = (value) => stdout(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const config = parseGcpMonitoringArgs(argv);
    const sources = { ...(readFile === undefined ? {} : { readFile }), ...(readSource === undefined ? {} : { readSource }) };
    let desired;
    if (config.desiredStatePath === null) {
      desired = loadCommittedDesiredState(config.environment, sources);
    } else {
      const loaded = readDesiredStateFile(config.desiredStatePath, sources);
      desired = config.environment === null ? loaded : requireEnvironment(loaded, config.environment);
    }
    if (config.command === "origin-lock-probe") {
      const result = await probeOriginLock(desired, { fetchImpl, ...(now === undefined ? {} : { now }) });
      print(result);
      return result.verdict === "locked" ? 0 : 2;
    }
    if (config.command === "readback") {
      print(readbackMonitoring(desired, { runner }));
      return 0;
    }
    const rendered = renderMonitoring(desired, { notificationChannel: config.notificationChannel });
    if (config.command === "render") {
      // The channel's value stays out of the output: the bodies carry it only for an apply.
      print({ ...rendered, policies: rendered.policies.map((policy) => ({ ...policy,
        body: { ...policy.body, notificationChannels: policy.body.notificationChannels.map(() => "<assigned>") } })) });
      return 0;
    }
    const plan = planMonitoring(rendered, readbackMonitoring(desired, { runner }));
    print(plan);
    return plan.summary.refused > 0 ? 2 : 0;
  } catch (error) {
    const code = error instanceof GcpOpsInfraError ? error.code : "GCP_MONITORING_FAILED";
    stderr(`${JSON.stringify({ status: "error", code })}\n`);
    return 1;
  }
}

/** Compares real paths, so a symlinked entry still runs main(). */
export function isCliEntry(argvPath, moduleUrl = import.meta.url) {
  if (typeof argvPath !== "string" || argvPath.length === 0) return false;
  try {
    return realpathSync(resolve(argvPath)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliEntry(process.argv[1])) {
  process.exitCode = await main();
}
