#!/usr/bin/env node

/**
 * Operator CLI for monitoring and alerting as code (OPS-5, E-OPS5): render,
 * readback and plan for the metrics, uptime checks and policies, and the one
 * email notification channel (OWN-5c). Metric/check/policy apply is dry by
 * default; exact --execute=true plus --authorize=<fresh planDigest> admits
 * eligible creates/updates only. Channel creation remains a separate command.
 * No deletes, implicit rollback, retries, cadence or probe producer changes.
 *
 *   render  (--environment=<production|staging> | --desired-state=<abs path>)
 *           [--notification-channel=projects/<project>/notificationChannels/<id>]
 *     The plane's log-based metrics, uptime checks and alert policies
 *     (gcp-ops-monitoring-policies.mjs), privacy-scanned; no call.
 *   readback (--environment | --desired-state)
 *     Three list calls (logging metrics, uptime checks, alert policies), each
 *     through a read-only guard with --project and --format=json, reduced to
 *     the managed fields of the plane's own resources.
 *   plan    (--environment | --desired-state) [--notification-channel=...]
 *     Readback plus the deterministic plan (create, update, unchanged,
 *     deferred, and live plane resources the render does not name, which an
 *     apply would refuse to delete) and its planDigest.
 *   apply   (--environment | --desired-state) [--notification-channel=...]
 *     Dry by default. Writes need --execute=true --authorize=<fresh planDigest>,
 *     committed desired state only; sequential readback-confirmed creates/updates.
 *   origin-lock-probe (--environment | --desired-state)
 *     One unauthenticated GET of https://<service host>/api/health. Exit 0
 *     only for exactly Google's front-end 403 (status 403, no origin marker
 *     header, Google's body text); the body is never printed.
 *   notification-channel (--environment | --desired-state)
 *           --email-file=<abs path> [--authorize=<planDigest>]
 *     OWN-5c (owner, round 11: alerts by email). Finds, or creates, the
 *     plane's ONE email notification channel, display name
 *     tibotattle[-staging]-alerts-email. The address is supplied at run time
 *     only, from a private file (a regular file outside the repository, not
 *     a symlink, mode 0600 or 0400, one address); there is no address
 *     argument, so it never reaches shell history. It is never written to
 *     stdout, stderr, the plan digest or a receipt; the output carries the
 *     channel's resource name only. gcloud logs every command's arguments
 *     to its own log files, so the channel calls run with gcloud's file
 *     logging (and HTTP logging) off: CHANNEL_GCLOUD_ENV. Without
 *     --authorize this is a dry run: one list call, then "found" (with the
 *     channel name) or "create" (with the planDigest). With
 *     --authorize=<that planDigest> it creates the channel, then reads it
 *     back. A channel of that name whose address or type differs, or more
 *     than one, is refused and never changed. Pass the printed name to
 *     render and plan as --notification-channel.
 *
 * The notification channel (OWN-5c) is an input to render and plan: it is
 * never written to their output, which says only "assigned" or "unassigned". Output is one
 * content-free JSON document on stdout; errors are {"status":"error","code"}
 * on stderr without gcloud output. Exit 0 on success, 2 when a plan holds a
 * refused delete or the origin is not locked, 1 on any error.
 */

import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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

export const GCP_MONITORING_READBACK_SCHEMA = "tibotattle-gcp-monitoring-readback-v2";
export const GCP_MONITORING_PLAN_SCHEMA = "tibotattle-gcp-monitoring-plan-v2";
export const GCP_MONITORING_ORIGIN_LOCK_SCHEMA = "tibotattle-gcp-monitoring-origin-lock-v1";
export const GCP_MONITORING_CHANNEL_SCHEMA = "tibotattle-gcp-monitoring-channel-v1";
/**
 * The only gcloud shapes notification-channel issues (Cloud Monitoring's
 * channel commands are in the beta track; the shapes are confirmed at the
 * first run against the test project, like the readback's).
 */
export const MONITORING_CHANNEL_COMMANDS = Object.freeze([
  "beta monitoring channels list",
  "beta monitoring channels create",
]);
/**
 * The environment overrides every notification-channel gcloud call runs
 * under. gcloud writes each command's parsed arguments to its own log files
 * ("Running [gcloud.…] with arguments: […]" at DEBUG, under
 * ~/.config/gcloud/logs) unless core/disable_file_logging is set, and the
 * create's --channel-labels carries the address, as does every list
 * response; HTTP logging (core/log_http) would copy those responses too. An
 * override wins over the operator's own gcloud configuration and environment.
 */
export const CHANNEL_GCLOUD_ENV = Object.freeze({
  CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "true",
  CLOUDSDK_CORE_LOG_HTTP: "false",
});
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EMAIL_FILE_MAX_BYTES = 512;
/** A conservative address shape: local@domain.tld, ASCII, at most 254 characters. */
const EMAIL_ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;
const CHANNEL_NAME = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/notificationChannels\/[0-9]{1,24}$/u;
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
  apply: Object.freeze([...SOURCE, "--notification-channel", "--execute", "--authorize"]),
  "origin-lock-probe": Object.freeze([...SOURCE]),
  "notification-channel": Object.freeze([...SOURCE, "--email-file", "--authorize"]),
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
  const emailFile = values.get("--email-file") ?? null;
  const authorize = values.get("--authorize") ?? null;
  if (argv[0] === "notification-channel") {
    if (emailFile === null) fail("GCP_MONITORING_EMAIL_FILE_REQUIRED");
    if (!isAbsolute(emailFile)) fail("GCP_MONITORING_EMAIL_FILE_PATH_INVALID");
    if (authorize !== null && !/^[0-9a-f]{64}$/u.test(authorize)) fail("GCP_MONITORING_AUTHORIZE_INVALID");
  }
  if (argv[0] === "apply") {
    if (values.has("--execute") && values.get("--execute") !== "true") fail("GCP_MONITORING_EXECUTE_INVALID");
    if (values.has("--execute") !== values.has("--authorize")) fail("MONITORING_EXECUTION_AUTHORIZATION_REQUIRED");
    if (authorize !== null && !/^[0-9a-f]{64}$/u.test(authorize)) fail("GCP_MONITORING_AUTHORIZE_INVALID");
  }
  return Object.freeze({
    ...(argv[0] === "apply" ? { execute: values.has("--execute") } : {}),
    command: argv[0],
    desiredStatePath: desiredStatePath === null ? null : resolve(desiredStatePath),
    environment,
    notificationChannel: values.get("--notification-channel") ?? null,
    emailFile: emailFile === null ? null : resolve(emailFile),
    authorize,
  });
}

// ---------------------------------------------------------------------------
// Readback

/**
 * The default runner: spawnSync with an argv array and no shell, under the
 * inherited environment plus `env` (whose entries win). `spawn` is for tests.
 */
export function defaultMonitoringRunner(argv, { env = {}, spawn = spawnSync } = {}) {
  const result = spawn("gcloud", argv, {
    timeout: 30_000, killSignal: "SIGKILL", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GCLOUD_MAX_BUFFER_BYTES, windowsHide: true,
    env: { ...process.env, ...env },
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
      result = runner([...argv], { env: { ...CHANNEL_GCLOUD_ENV } });
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
    description: metric?.description ?? null,
    disabled: metric?.disabled === true,
    metricKind: metric?.metricDescriptor?.metricKind ?? null,
    unit: metric?.metricDescriptor?.unit ?? null,
    labelValueTypes: (metric?.metricDescriptor?.labels ?? []).map((l) => ({ key: l.key, valueType: l.valueType ?? "STRING" })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    labelExtractors: isRecord(metric?.labelExtractors) ? metric.labelExtractors : {},
    labels: (Array.isArray(metric?.metricDescriptor?.labels) ? metric.metricDescriptor.labels : [])
      .map((label) => label?.key ?? null).sort(),
    valueType: metric?.metricDescriptor?.valueType ?? null,
    valueExtractor: typeof metric?.valueExtractor === "string" ? metric.valueExtractor : null,
    bucketOptions: isRecord(metric?.bucketOptions) ? metric.bucketOptions : null,
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
    documentationMimeType: policy?.documentation?.mimeType ?? null,
    userLabels: isRecord(policy?.userLabels) ? policy.userLabels : {},
    severity: policy?.severity ?? null,
    enabled: policy?.enabled !== false,
    alertStrategy: policy?.alertStrategy ?? null,
    channelsDigest: sha256Hex(canonicalJson(channels)),
  };
}

const KINDS = Object.freeze({ "log-metric": "metrics", "uptime-check": "uptimeChecks", "alert-policy": "policies" });
const VIEWS = Object.freeze({ "log-metric": metricView, "uptime-check": uptimeView, "alert-policy": policyView });
function resourceIdentity(kind, entry, project) {
  if (kind === "log-metric") {
    const name = entry?.name;
    if (typeof name !== "string") fail("MONITORING_RESOURCE_IDENTITY_INVALID");
    if (/^[a-z][a-z0-9_]{1,127}$/u.test(name)) return `projects/${project}/metrics/${name}`;
    if (new RegExp(`^projects/${project}/metrics/[a-z][a-z0-9_]{1,127}$`, "u").test(name)) return name;
  } else {
    const type = kind === "uptime-check" ? "uptimeCheckConfigs" : "alertPolicies";
    if (typeof entry?.name === "string" && new RegExp(`^projects/${project}/${type}/[A-Za-z0-9_-]{1,128}$`, "u").test(entry.name)) return entry.name;
  }
  fail("MONITORING_RESOURCE_IDENTITY_INVALID");
}
function managedResource(kind, entry, expected, desired) {
  if (!expected) return false;
  if (kind === "log-metric") return entry.description === expected.body.description;
  if (kind === "alert-policy") return entry.userLabels?.["managed-by"] === "tibotattle-ops-5"
    && entry.userLabels?.environment === desired.environment;
  return canonicalJson(entry.monitoredResource) === canonicalJson(expected.body.monitoredResource);
}
/** Three project-scoped lists. Identity, duplicate and ownership evidence participates in admission. */
export function readbackMonitoring(desired, { runner = defaultMonitoringRunner } = {}) {
  const call = guardedMonitoringGcloud(runner, desired.project), project = `--project=${desired.project}`;
  const expected = renderMonitoring(desired), bindings = {}, values = {};
  for (const [kind, command, separator] of [["log-metric", ["logging", "metrics", "list"], "_"],
    ["uptime-check", ["monitoring", "uptime", "list-configs"], "-"], ["alert-policy", ["monitoring", "policies", "list"], "-"]]) {
    const field = KINDS[kind], live = {}, identities = {}, own = new Map(expected[field].map((e) => [e.name, e]));
    for (const entry of call([...command, project, "--format=json"])) {
      const identity = resourceIdentity(kind, entry, desired.project);
      const name = kind === "log-metric" ? tail(entry.name) : entry.displayName;
      if (typeof name !== "string") fail("MONITORING_RESOURCE_IDENTITY_INVALID");
      if (!planeOwns(desired, name, separator)) continue;
      if (Object.hasOwn(live, name)) fail("MONITORING_RESOURCE_AMBIGUOUS");
      live[name] = VIEWS[kind](entry);
      const conditionNames = kind === "alert-policy" ? (entry.conditions ?? []).map((c) => ({ displayName: c.displayName, name: c.name ?? null })) : [];
      if (conditionNames.some((c) => typeof c.displayName !== "string" || typeof c.name !== "string" || !new RegExp(`^${identity}/conditions/[A-Za-z0-9_-]{1,128}$`, "u").test(c.name))
          || new Set(conditionNames.map((c) => c.displayName)).size !== conditionNames.length) fail("MONITORING_CONDITION_IDENTITY_INVALID");
      identities[name] = { resourceName: identity, managed: managedResource(kind, entry, own.get(name), desired),
        // No raw provider body/channel values leave the reader. The whole object binds unmanaged fields too.
        rawDigest: sha256Hex(canonicalJson(entry)), conditionNames };
    }
    const sorted = (v) => Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    values[field] = sorted(live); bindings[field] = sorted(identities);
  }
  return deepFreeze({ schema: GCP_MONITORING_READBACK_SCHEMA, environment: desired.environment, project: desired.project, ...values, bindings });
}

// ---------------------------------------------------------------------------
// Plan

function compare(kind, rendered, live, view, bindings) {
  return rendered.map((entry) => {
    const deferred = {
      ...(entry.deferred === undefined ? {} : { deferred: entry.deferred }),
      ...(entry.deferredConditions === undefined ? {} : { deferredConditions: entry.deferredConditions }),
    };
    const binding = bindings[entry.name];
    const proof = { bodyDigest: sha256Hex(canonicalJson(entry.body)), resourceName: binding?.resourceName ?? null, priorRawDigest: binding?.rawDigest ?? null };
    if (!Object.hasOwn(live, entry.name)) return { ...proof, id: `${kind}:create:${entry.id}`, kind, name: entry.name, action: "create", ...deferred };
    const same = canonicalJson(view(entry.body)) === canonicalJson(live[entry.name]);
    return { ...proof, ...(binding?.managed === true ? {} : { refused: "MONITORING_UNMANAGED_TARGET" }), id: `${kind}:${same ? "unchanged" : "update"}:${entry.id}`, kind, name: entry.name,
      action: same ? "unchanged" : "update", ...deferred };
  });
}

/** The deterministic plan for a render and a readback. */
export function planMonitoring(rendered, readback) {
  if (readback?.schema !== GCP_MONITORING_READBACK_SCHEMA || readback.project !== rendered.project || readback.environment !== rendered.environment || !isRecord(readback.bindings)) {
    fail("MONITORING_PLAN_READBACK_INVALID");
  }
  const operations = [
    ...compare("log-metric", rendered.metrics, readback.metrics, metricView, readback.bindings.metrics),
    ...compare("uptime-check", rendered.uptimeChecks, readback.uptimeChecks, uptimeView, readback.bindings.uptimeChecks),
    ...compare("alert-policy", rendered.policies, readback.policies, policyView, readback.bindings.policies),
  ];
  const named = new Set([...rendered.metrics, ...rendered.uptimeChecks, ...rendered.policies].map(({ name }) => name));
  for (const [kind, live] of [["log-metric", readback.metrics], ["uptime-check", readback.uptimeChecks],
    ["alert-policy", readback.policies]]) {
    for (const name of Object.keys(live).filter((entry) => !named.has(entry))) {
      operations.push({ id: `${kind}:delete:${name}`, kind, name, action: "delete", refused: "MONITORING_DELETE_REFUSED" });
    }
  }
  if (new Set(operations.map((o) => o.id)).size !== operations.length) fail("MONITORING_OPERATION_AMBIGUOUS");
  const body = {
    schema: GCP_MONITORING_PLAN_SCHEMA,
    environment: rendered.environment,
    project: rendered.project,
    desiredStateDigest: rendered.desiredStateDigest,
    renderedDigest: renderedDigest(rendered),
    readbackDigest: sha256Hex(canonicalJson(readback)),
    notificationChannel: rendered.notificationChannel,
    operations,
    summary: {
      create: operations.filter(({ action, deferred }) => action === "create" && deferred === undefined).length,
      update: operations.filter(({ action, deferred }) => action === "update" && deferred === undefined).length,
      unchanged: operations.filter(({ action }) => action === "unchanged").length,
      deferred: operations.filter(({ deferred }) => deferred !== undefined).length,
      refused: operations.filter(({ refused }) => refused !== undefined).length,
    },
    apply: "dry by default; eligible create/update only with --execute=true and exact --authorize",
  };
  return deepFreeze({ ...body, planDigest: sha256Hex(canonicalJson(body)) });
}

// ---------------------------------------------------------------------------
// Protected metric/check/policy create/update

const APPLY_SCHEMA = "tibotattle-gcp-monitoring-apply-v1";
const API_TIMEOUT_MS = 30_000;
const API_BODY_LIMIT = 2 * 1024 * 1024;
const digest = (value) => sha256Hex(canonicalJson(value));
function renderedEntry(rendered, operation) {
  const field = KINDS[operation?.kind];
  if (!field || !["create", "update"].includes(operation.action) || operation.deferred !== undefined || operation.refused !== undefined) {
    fail("MONITORING_OPERATION_FORBIDDEN");
  }
  const entries = rendered[field].filter((e) => e.name === operation.name && operation.id === `${e.kind}:${operation.action}:${e.id}`);
  if (entries.length !== 1 || entries[0].deferred !== undefined) fail("MONITORING_OPERATION_FORBIDDEN");
  return entries[0];
}
/** Only a canonical operation recomputed from this exact render/readback can become an API request. */
export function monitoringMutationRequest(rendered, readback, operation) {
  const fresh = planMonitoring(rendered, readback);
  if (fresh.summary.refused > 0) fail(fresh.operations.some((o) => o.action === "delete") ? "MONITORING_DELETE_REFUSED" : "MONITORING_UNMANAGED_TARGET");
  if (fresh.operations.filter((o) => canonicalJson(o) === canonicalJson(operation)).length !== 1) fail("MONITORING_OPERATION_FORBIDDEN");
  const entry = renderedEntry(rendered, operation), field = KINDS[operation.kind];
  const binding = readback.bindings[field][entry.name];
  if (operation.action === "update" && binding?.managed !== true) fail("MONITORING_UNMANAGED_TARGET");
  const body = structuredClone(entry.body), project = `projects/${rendered.project}`;
  let method, url;
  if (operation.kind === "log-metric") {
    if (body.name !== entry.name) fail("MONITORING_RESOURCE_IDENTITY_INVALID");
    method = operation.action === "create" ? "POST" : "PUT";
    url = `https://logging.googleapis.com/v2/${project}/metrics${operation.action === "create" ? "" : `/${entry.name}`}`;
  } else {
    const type = operation.kind === "uptime-check" ? "uptimeCheckConfigs" : "alertPolicies";
    method = operation.action === "create" ? "POST" : "PATCH";
    url = `https://monitoring.googleapis.com/v3/${project}/${type}`;
    if (operation.action === "update") {
      body.name = binding.resourceName;
      // Keep identities for surviving conditions; new condition names are assigned by Google.
      if (operation.kind === "alert-policy") {
        for (const condition of body.conditions) {
          const existing = binding.conditionNames.find((c) => c.displayName === condition.displayName);
          if (existing?.name) condition.name = existing.name;
        }
      }
      const fields = Object.keys(entry.body).sort().join(",");
      url = `https://monitoring.googleapis.com/v3/${binding.resourceName}?updateMask=${encodeURIComponent(fields)}`;
    }
  }
  if (operation.action === "update") {
    const identity = resourceIdentity(operation.kind, operation.kind === "log-metric" ? { name: entry.name } : body, rendered.project);
    if (identity !== binding.resourceName) fail("MONITORING_RESOURCE_IDENTITY_INVALID");
  }
  return deepFreeze({ method, url, body });
}

/** Bound to the admitted exact requests, no generic HTTP or caller-selected endpoint. */
function admittedMonitoringTransport(project, requests, { runner, fetchImpl = globalThis.fetch } = {}) {
  const allowed = new Set(requests.map(canonicalJson)); let token = null;
  return async (request) => {
    const key = canonicalJson(request);
    if (!allowed.delete(key)) fail("MONITORING_TRANSPORT_FORBIDDEN");
    if (token === null) {
      let result;
      try { result = runner(["auth", "print-access-token", `--project=${project}`, "--quiet"], { env: { ...CHANNEL_GCLOUD_ENV } }); } catch { fail("MONITORING_AUTH_FAILED"); }
      if (!isRecord(result) || result.status !== 0 || result.error || typeof result.stdout !== "string"
          || !/^[A-Za-z0-9._~-]{20,8192}$/u.test(result.stdout.trim())) fail("MONITORING_AUTH_FAILED");
      token = result.stdout.trim(); // memory only: never argv, disk, receipt, or error output
    }
    let response;
    try { response = await fetchImpl(request.url, { method: request.method, redirect: "error", credentials: "omit",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(request.body), signal: AbortSignal.timeout(API_TIMEOUT_MS) }); } catch { fail("MONITORING_API_FAILED"); }
    if (response.status < 200 || response.status >= 300) { try { await response.body?.cancel(); } catch { /* no response logging */ } fail("MONITORING_API_FAILED"); }
    let text = "", bytes = 0; const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      // Limit allocation while reading, not after response.text() has materialized it.
      for await (const chunk of response.body) {
        bytes += chunk.byteLength; if (bytes > API_BODY_LIMIT) fail("MONITORING_API_OUTPUT_INVALID");
        text += decoder.decode(chunk, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } catch { fail("MONITORING_API_OUTPUT_INVALID"); }
  };
}

function applyChannelBinding(desired, channel, runner) {
  if (channel === null) return null;
  const listed = guardedChannelGcloud(runner, desired.project)(["beta", "monitoring", "channels", "list", `--project=${desired.project}`, "--format=json"]);
  if (!Array.isArray(listed)) fail("MONITORING_APPLY_CHANNEL_UNCONFIRMED");
  const selected = listed.filter((c) => c?.name === channel);
  if (selected.length !== 1 || listed.filter((c) => c?.displayName === emailChannelDisplayName(desired)).length !== 1 || selected[0].type !== "email" || selected[0].enabled === false
      || selected[0].displayName !== emailChannelDisplayName(desired)) fail("MONITORING_APPLY_CHANNEL_UNCONFIRMED");
  return digest({ name: channel, type: selected[0].type, displayName: selected[0].displayName, enabled: true });
}

function assertOperationResult(rendered, operation, result, after) {
  const entry = renderedEntry(rendered, operation), field = KINDS[operation.kind];
  const identity = resourceIdentity(operation.kind, result, rendered.project);
  const expectedName = operation.kind === "log-metric" ? tail(result.name) : result.displayName;
  if (expectedName !== entry.name || after.bindings[field][entry.name]?.resourceName !== identity
      || after.bindings[field][entry.name]?.managed !== true
      || canonicalJson(VIEWS[operation.kind](result)) !== canonicalJson(VIEWS[operation.kind](entry.body))
      || canonicalJson(after[field][entry.name]) !== canonicalJson(VIEWS[operation.kind](entry.body))) fail("MONITORING_WRITE_UNCONFIRMED");
}

/** Fresh deterministic plan; writes require the digest and explicit execute, with no implicit retry/rollback. */
export async function applyMonitoring(desired, { notificationChannel = null, execute = false, authorize = null,
  runner = defaultMonitoringRunner, transport, fetchImpl = globalThis.fetch, reloadDesired,
  committedDesired = () => loadCommittedDesiredState(desired.environment) } = {}) {
  if (typeof execute !== "boolean" || execute !== (authorize !== null) || (authorize !== null && !/^[0-9a-f]{64}$/u.test(authorize))) {
    fail("MONITORING_EXECUTION_AUTHORIZATION_REQUIRED");
  }
  if (execute && digest(desired) !== digest(committedDesired())) fail("MONITORING_COMMITTED_DESIRED_STATE_REQUIRED");
  const rendered = renderMonitoring(desired, { notificationChannel });
  const initial = readbackMonitoring(desired, { runner }), plan = planMonitoring(rendered, initial);
  const candidates = plan.operations.filter((o) => ["create", "update"].includes(o.action) && o.deferred === undefined);
  const body = { schema: APPLY_SCHEMA, environment: desired.environment, project: desired.project, planDigest: plan.planDigest,
    desiredStateDigest: plan.desiredStateDigest, renderedDigest: plan.renderedDigest, readbackDigest: plan.readbackDigest,
    execute, applied: false, atomic: false, plan, completed: [], failed: null, unattempted: candidates.map((o) => o.id) };
  if (!execute) return deepFreeze({ ...body, status: "dry" });
  if (authorize !== plan.planDigest) fail("MONITORING_AUTHORIZATION_MISMATCH");
  if (plan.summary.refused > 0) fail(plan.operations.some((o) => o.action === "delete") ? "MONITORING_DELETE_REFUSED" : "MONITORING_UNMANAGED_TARGET");
  // Validate every eligible target before the first write; supplied/mutated operations never form authority.
  const channelBinding = applyChannelBinding(desired, notificationChannel, runner);
  const requests = candidates.map((o) => monitoringMutationRequest(rendered, initial, o));
  const call = transport ?? admittedMonitoringTransport(desired.project, requests, { runner, fetchImpl });
  if (typeof call !== "function") fail("MONITORING_TRANSPORT_INVALID");
  let expected = initial, completed = [], failed = null, stage = "precondition", attempted = false;
  for (let index = 0; index < candidates.length; index++) {
    const operation = candidates[index]; stage = "precondition"; attempted = false;
    try {
      if (digest(renderMonitoring((reloadDesired ?? committedDesired)(), { notificationChannel })) !== digest(rendered)) fail("MONITORING_DESIRED_STATE_DRIFT");
      if (applyChannelBinding(desired, notificationChannel, runner) !== channelBinding) fail("MONITORING_APPLY_CHANNEL_DRIFT");
      const current = readbackMonitoring(desired, { runner });
      if (digest(current) !== digest(expected)) fail("MONITORING_READBACK_DRIFT");
      // Rebuild from the current checked live state, not from a caller-supplied plan JSON.
      const request = monitoringMutationRequest(rendered, current, operation);
      if (canonicalJson(request) !== canonicalJson(requests[index])) fail("MONITORING_REQUEST_DRIFT");
      stage = "write"; attempted = true; const result = await call(request);
      stage = "readback"; const after = readbackMonitoring(desired, { runner });
      assertOperationResult(rendered, operation, result, after);
      // Only the admitted target may change between the pre/post snapshots.
      const isolated = structuredClone(after), field = KINDS[operation.kind];
      if (Object.hasOwn(current[field], operation.name)) {
        isolated[field][operation.name] = current[field][operation.name]; isolated.bindings[field][operation.name] = current.bindings[field][operation.name];
      } else { delete isolated[field][operation.name]; delete isolated.bindings[field][operation.name]; }
      if (digest(isolated) !== digest(current)) fail("MONITORING_READBACK_DRIFT");
      completed.push(operation.id); expected = after;
    } catch (error) {
      failed = { id: operation.id, stage, mutationAttempted: attempted,
        code: error instanceof GcpOpsInfraError ? error.code : "MONITORING_APPLY_FAILED" };
      break;
    }
  }
  let readback = null;
  try {
    const final = readbackMonitoring(desired, { runner });
    readback = { status: "ok", digest: digest(final), plan: planMonitoring(rendered, final) };
    if (failed === null && digest(final) !== digest(expected)) failed = { id: null, stage: "final-readback", mutationAttempted: false, code: "MONITORING_READBACK_DRIFT" };
  } catch { readback = { status: "unconfirmed" }; if (failed === null) failed = { id: null, stage: "final-readback", mutationAttempted: false, code: "MONITORING_FINAL_READBACK_FAILED" }; }
  return deepFreeze({ ...body, status: failed === null ? "applied" : "partial", applied: completed.length > 0,
    completed, failed, unattempted: candidates.filter((o) => !completed.includes(o.id) && o.id !== failed?.id).map((o) => o.id), readback,
    note: "No rollback or retry. Unknown write outcomes remain unconfirmed; inspect/re-plan fresh state before another admission." });
}

// ---------------------------------------------------------------------------
// Notification channel (OWN-5c)

/** The plane's one email channel: tibotattle-alerts-email or tibotattle-staging-alerts-email. */
export function emailChannelDisplayName(desired) {
  return `${desired.environment === "production" ? "tibotattle" : "tibotattle-staging"}-alerts-email`;
}

/** A syntactically plausible address, or a closed refusal that never carries the value. */
export function validateAlertEmail(value) {
  if (typeof value !== "string" || value.length > 254 || !EMAIL_ADDRESS.test(value)) fail("GCP_MONITORING_EMAIL_INVALID");
  return value;
}

function insideRepository(path) {
  const relation = relative(REPOSITORY_ROOT, path);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

/**
 * Reads the address from a private file: a regular file (not a symlink),
 * outside this repository, readable by its owner only (no group or other
 * bits), at most 512 bytes, holding one address and an optional newline.
 */
export function readAlertEmailFile(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("GCP_MONITORING_EMAIL_FILE_PATH_INVALID");
  let link;
  try {
    link = lstatSync(path);
  } catch {
    fail("GCP_MONITORING_EMAIL_FILE_UNREADABLE");
  }
  if (link.isSymbolicLink() || !link.isFile()) fail("GCP_MONITORING_EMAIL_FILE_UNSAFE");
  let real;
  try {
    real = realpathSync(path);
  } catch {
    fail("GCP_MONITORING_EMAIL_FILE_UNREADABLE");
  }
  let repository = REPOSITORY_ROOT;
  try {
    repository = realpathSync(REPOSITORY_ROOT);
  } catch {
    // The resolved root is compared below either way.
  }
  if (insideRepository(real) || insideRepository(resolve(path))
      || real === repository || real.startsWith(`${repository}${sep}`)) {
    fail("GCP_MONITORING_EMAIL_FILE_IN_REPOSITORY");
  }
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    fail("GCP_MONITORING_EMAIL_FILE_UNREADABLE");
  }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > EMAIL_FILE_MAX_BYTES
        || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      fail("GCP_MONITORING_EMAIL_FILE_UNSAFE");
    }
    const buffer = Buffer.alloc(EMAIL_FILE_MAX_BYTES + 1);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length > EMAIL_FILE_MAX_BYTES) fail("GCP_MONITORING_EMAIL_FILE_UNSAFE");
    const text = buffer.subarray(0, length).toString("utf8");
    buffer.fill(0);
    return validateAlertEmail(text.endsWith("\n") ? text.slice(0, -1) : text);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * A guard for notification-channel: only its two shapes, one --project,
 * --format=json, every call under CHANNEL_GCLOUD_ENV (no gcloud log file);
 * output never echoed.
 */
export function guardedChannelGcloud(runner, project, { allowCreate = false } = {}) {
  if (typeof runner !== "function") fail("GCLOUD_RUNNER_INVALID");
  return (argv) => {
    const shape = Array.isArray(argv) ? shapeOf(argv) : null;
    if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")
        || !MONITORING_CHANNEL_COMMANDS.includes(shape)
        || (shape === "beta monitoring channels create" && !allowCreate)) {
      fail("GCLOUD_COMMAND_FORBIDDEN");
    }
    if (argv.filter((arg) => arg.startsWith("--project=")).length !== 1 || !argv.includes(`--project=${project}`)) {
      fail("GCLOUD_PROJECT_FLAG_INVALID");
    }
    if (!argv.includes("--format=json")) fail("GCLOUD_READ_FORMAT_REQUIRED");
    const what = shape.replaceAll(" ", "-");
    let result;
    try {
      result = runner([...argv], { env: { ...CHANNEL_GCLOUD_ENV } });
    } catch {
      fail(`GCLOUD_CALL_FAILED:${what}`);
    }
    if (!isRecord(result) || result.status !== 0 || (result.error !== undefined && result.error !== null)
        || typeof result.stdout !== "string") {
      fail(`GCLOUD_CALL_FAILED:${what}`);
    }
    try {
      return JSON.parse(result.stdout === "" ? "[]" : result.stdout);
    } catch {
      return fail(`GCLOUD_OUTPUT_INVALID:${what}`);
    }
  };
}

/** The plane's channels of that display name, reduced to name, type and whether the address matches. */
function listPlaneEmailChannels(call, desired, address) {
  const listed = call(["beta", "monitoring", "channels", "list", `--project=${desired.project}`, "--format=json"]);
  if (!Array.isArray(listed)) fail("GCLOUD_OUTPUT_INVALID:beta-monitoring-channels-list");
  const displayName = emailChannelDisplayName(desired);
  return listed.filter((entry) => isRecord(entry) && entry.displayName === displayName).map((entry) => {
    const name = typeof entry.name === "string" ? entry.name : "";
    const match = CHANNEL_NAME.exec(name);
    if (match === null || match[1] !== desired.project) fail("MONITORING_CHANNEL_NAME_INVALID");
    const listedAddress = entry.labels?.email_address;
    return {
      name,
      type: entry.type ?? null,
      addressMatches: typeof listedAddress === "string" && listedAddress.toLowerCase() === address.toLowerCase(),
      enabled: entry.enabled !== false,
    };
  });
}

function channelVerdict(channels) {
  if (channels.length > 1) fail("MONITORING_CHANNEL_AMBIGUOUS");
  if (channels.length === 0) return null;
  const [channel] = channels;
  if (channel.type !== "email") fail("MONITORING_CHANNEL_TYPE_MISMATCH");
  if (!channel.addressMatches) fail("MONITORING_CHANNEL_ADDRESS_MISMATCH");
  if (!channel.enabled) fail("MONITORING_CHANNEL_DISABLED");
  return channel;
}

/**
 * Finds or (under --authorize) creates the plane's one email channel. The
 * address leaves this function only as the create's --channel-labels
 * argument to gcloud, which runs with its file logging off; the result and
 * the plan digest carry the channel name only. Outside this tool, the
 * address is necessarily visible in the gcloud process's argument list while
 * the create runs, is stored in the channel itself, and may appear in the
 * project's Admin Activity audit log entry for the create request.
 */
export function ensureEmailChannel(desired, { address, authorize = null, runner = defaultMonitoringRunner }) {
  validateAlertEmail(address);
  const displayName = emailChannelDisplayName(desired);
  const list = guardedChannelGcloud(runner, desired.project);
  const existing = channelVerdict(listPlaneEmailChannels(list, desired, address));
  const body = {
    schema: GCP_MONITORING_CHANNEL_SCHEMA,
    environment: desired.environment,
    project: desired.project,
    displayName,
    type: "email",
    action: existing === null ? "create" : "found",
    channel: existing?.name ?? null,
  };
  const planDigest = sha256Hex(canonicalJson(body));
  if (existing !== null || authorize === null) {
    return deepFreeze({ ...body, planDigest, applied: false });
  }
  if (authorize !== planDigest) fail("MONITORING_CHANNEL_AUTHORIZATION_MISMATCH");
  const create = guardedChannelGcloud(runner, desired.project, { allowCreate: true });
  const created = create(["beta", "monitoring", "channels", "create", `--project=${desired.project}`,
    `--display-name=${displayName}`, "--type=email", `--channel-labels=email_address=${address}`,
    `--user-labels=managed-by=tibotattle-ops-5,environment=${desired.environment}`,
    "--description=TiboTattle OPS-5 alerts (OWN-5c)", "--format=json"]);
  const name = isRecord(created) && typeof created.name === "string" ? created.name : "";
  const match = CHANNEL_NAME.exec(name);
  if (match === null || match[1] !== desired.project) fail("MONITORING_CHANNEL_CREATE_UNCONFIRMED");
  const readback = channelVerdict(listPlaneEmailChannels(list, desired, address));
  if (readback === null || readback.name !== name) fail("MONITORING_CHANNEL_CREATE_UNCONFIRMED");
  return deepFreeze({ ...body, action: "created", channel: name, planDigest, applied: true });
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
  readEmailFile = readAlertEmailFile,
  transport,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  const print = (value) => stdout(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const config = parseGcpMonitoringArgs(argv);
    if (config.command === "apply" && config.execute && config.desiredStatePath !== null) fail("MONITORING_COMMITTED_DESIRED_STATE_REQUIRED");
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
    if (config.command === "notification-channel") {
      const address = readEmailFile(config.emailFile);
      print(ensureEmailChannel(desired, { address, authorize: config.authorize, runner }));
      return 0;
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
    if (config.command === "apply") {
      const reloadDesired = () => config.desiredStatePath === null ? loadCommittedDesiredState(config.environment, sources)
        : (config.environment === null ? readDesiredStateFile(config.desiredStatePath, sources)
          : requireEnvironment(readDesiredStateFile(config.desiredStatePath, sources), config.environment));
      const result = await applyMonitoring(desired, { notificationChannel: config.notificationChannel, runner,
        execute: config.execute, authorize: config.authorize, reloadDesired, fetchImpl,
        committedDesired: () => loadCommittedDesiredState(desired.environment, sources),
        ...(transport === undefined ? {} : { transport }) });
      print(result); return result.status === "partial" || result.plan.summary.refused > 0 ? 2 : 0;
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
