#!/usr/bin/env node

/**
 * Operator CLI for monitoring and alerting as code (OPS-5, E-OPS5): render,
 * readback and plan for the metrics, uptime checks and policies, and the one
 * email notification channel (OWN-5c). The only write is notification-channel
 * creating that channel under its plan digest; nothing here changes or
 * deletes a monitoring resource, and applying the policies is a later,
 * separately authorized stream.
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

export const GCP_MONITORING_READBACK_SCHEMA = "tibotattle-gcp-monitoring-readback-v1";
export const GCP_MONITORING_PLAN_SCHEMA = "tibotattle-gcp-monitoring-plan-v1";
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
  return Object.freeze({
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
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GCLOUD_MAX_BUFFER_BYTES, windowsHide: true,
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
    const deferred = {
      ...(entry.deferred === undefined ? {} : { deferred: entry.deferred }),
      ...(entry.deferredConditions === undefined ? {} : { deferredConditions: entry.deferredConditions }),
    };
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
