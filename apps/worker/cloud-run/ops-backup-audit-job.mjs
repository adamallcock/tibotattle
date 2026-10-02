#!/usr/bin/env node

/**
 * ops-backup-audit-job: the OPS-4 backup-audit probe, a Cloud Run Job (build
 * entry "ops-backup-audit-job" -> dist/ops-backup-audit-job.mjs).
 *
 * One execution reads the one Cloud SQL instance's settings and backup runs
 * from the Cloud SQL Admin API and judges them with the OPS-1 horizon policy
 * (cloud-run/ops-backup-horizon.mjs assessBackupRuns). It writes one line per
 * signal (cloud-run/ops-probe-contract.mjs OPS_PROBES):
 *
 *   backup_audit_level                0 ok, 1 warn, 2 breach (OPS-1's verdict),
 *                                     with the closed OPS-1 codes
 *   backup_pitr_enabled               1 when point-in-time recovery is on
 *   backup_last_automated_age_hours   age of the newest successful automated
 *                                     backup (stale after 36 h: AUTOMATED_BACKUP_STALE)
 *
 * It holds no database connection and reads no row. It needs exactly two
 * Cloud SQL Admin permissions on the instance, cloudsql.instances.get and
 * cloudsql.backupRuns.list (OPS_PROBE_JOBS), for an identity of its own that
 * is not the runtime's. Reads are bounded: 10 s per request, 100 runs a
 * page, at most 20 pages.
 *
 * Fail closed, never green on silence. Any fetch failure (a network error, a
 * timeout, a non-2xx status, a body that is not the expected JSON, or paging
 * past the bound) makes backup_audit_level unavailable with a closed reason;
 * the audit never reads an unreadable list as "no backups" and never as ok.
 * What the OPS-1 policy cannot read with certainty is already a breach there
 * (BACKUP_SETTINGS_UNRECOGNIZED), which is level 2. A 366-day-old restorable
 * copy is BACKUP_OLDER_THAN_HORIZON, level 2.
 *
 * The audit's scope is OPS-1's: the one instance's backup runs
 * (BACKUP_HORIZON_COVERAGE), never project-level backups. The response
 * bodies, backup descriptions and ids never reach the output: a line holds a
 * level, an integer, a boolean flag and closed codes.
 *
 * Arguments (closed): none, or --help alone.
 *
 * Environment (closed; cloud-run/ops-probe-contract.mjs readOpsProbeEnvironment):
 *   CLOUD_RUN_JOB, DEPLOYMENT_SOURCE_COMMIT, OPS_PROBE_TARGET,
 *   PRIMARY_INSTANCE_CONNECTION_NAME. Refused: HOST_MODE, K_SERVICE,
 *   PG_TEST_*, any other OPS_PROBE_* variable, any credential-named variable
 *   and any database setting (PRIMARY_DATABASE, PRIMARY_SCHEMA,
 *   POSTGRES_IAM_USER).
 *
 * Output: one JSON line per signal on stdout. Exit 0 once the audit ran,
 * whatever the signals' state (an unobtainable credential is a failed fetch,
 * so all three are unavailable); 1 for a configuration failure (one
 * {schema, job, status:"failed", code} line on stderr); 2 for usage.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGoogleAccessTokenProvider } from "./cloud-sql.mjs";
import { BACKUP_HORIZON_CODES, assessBackupRuns } from "./ops-backup-horizon.mjs";
import {
  OPS_BACKUP_AUDIT_LEVELS,
  OPS_PROBE_JOBS,
  OPS_PROBE_SCHEMA,
  buildOpsProbeLine,
  buildOpsProbeUnavailable,
  readOpsProbeEnvironment,
  safeOpsProbeCode,
  serializeOpsProbeLine,
} from "./ops-probe-contract.mjs";

export const OPS_BACKUP_AUDIT_JOB = "ops-backup-audit";
export const OPS_BACKUP_AUDIT_ENTRY = OPS_PROBE_JOBS[OPS_BACKUP_AUDIT_JOB].entry;
export const OPS_BACKUP_AUDIT_ADMIN_ORIGIN = "https://sqladmin.googleapis.com";
/** Runs asked for per page; the audit pages until nextPageToken is absent. */
export const OPS_BACKUP_AUDIT_PAGE_SIZE = 100;

const HTTP_TIMEOUT_MS = OPS_PROBE_JOBS[OPS_BACKUP_AUDIT_JOB].httpTimeoutMilliseconds;
const MAX_PAGES = OPS_PROBE_JOBS[OPS_BACKUP_AUDIT_JOB].maxPages;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const PAGE_TOKEN = /^[A-Za-z0-9_=+./-]{1,2048}$/u;
const AUDIT_PROBES = Object.freeze(["backup_audit_level", "backup_pitr_enabled", "backup_last_automated_age_hours"]);

export const OPS_BACKUP_AUDIT_USAGE = `Usage: node ops-backup-audit-job.mjs

Audit the one Cloud SQL instance's backups against the OPS-1 horizon policy
through the Cloud SQL Admin API and write one JSON line per signal. Cloud Run
Jobs only, hourly. Exits 0 (the audit ran), 1 (configuration failure) or 2
(usage).

  --help  print this text
`;

function fail(code, extra = {}) {
  throw Object.assign(new Error(code), { code, ...extra });
}

/** A coded read failure the audit turns into an unavailable signal. */
class AdminReadError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "AdminReadError";
    this.reason = reason;
  }
}

/** Parse the closed argument list: none, or --help alone. */
export function parseOpsBackupAuditArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    fail("OPS_BACKUP_AUDIT_ARGUMENTS_INVALID", { usage: true });
  }
  if (argv.length === 0) return Object.freeze({ help: false });
  if (argv.length === 1 && argv[0] === "--help") return Object.freeze({ help: true });
  return fail("OPS_BACKUP_AUDIT_ARGUMENTS_INVALID", { usage: true });
}

function instanceUrl(configuration, suffix = "", query = "") {
  return `${OPS_BACKUP_AUDIT_ADMIN_ORIGIN}/v1/projects/${configuration.project}/instances/${configuration.instance}${suffix}${query}`;
}

/**
 * One bounded GET of the Cloud SQL Admin API as parsed JSON. Redirects are
 * refused, the request has its own timeout, and nothing of the response body
 * or of an error message is ever kept: a failure is only a closed reason.
 */
async function adminGet(url, { accessToken, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AdminReadError(error?.name === "TimeoutError" || error?.name === "AbortError"
      ? "FETCH_TIMEOUT" : "FETCH_FAILED");
  }
  if (response === null || typeof response !== "object" || typeof response.status !== "number") {
    throw new AdminReadError("FETCH_FAILED");
  }
  if (response.status < 200 || response.status > 299) throw new AdminReadError("HTTP_STATUS");
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new AdminReadError(error?.name === "TimeoutError" || error?.name === "AbortError"
      ? "FETCH_TIMEOUT" : "FETCH_FAILED");
  }
  if (typeof text !== "string" || text.length > MAX_BODY_BYTES) throw new AdminReadError("RESPONSE_INVALID");
  try {
    return JSON.parse(text);
  } catch {
    throw new AdminReadError("RESPONSE_INVALID");
  }
}

/** The instance, as the Admin API describes it. */
export async function fetchInstance(configuration, deps) {
  const body = await adminGet(instanceUrl(configuration), deps);
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new AdminReadError("RESPONSE_INVALID");
  return body;
}

/** Every backup run of the instance, paged and bounded. */
export async function fetchBackupRuns(configuration, deps) {
  const runs = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = `?maxResults=${OPS_BACKUP_AUDIT_PAGE_SIZE}${pageToken === null ? "" : `&pageToken=${encodeURIComponent(pageToken)}`}`;
    const body = await adminGet(instanceUrl(configuration, "/backupRuns", query), deps);
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new AdminReadError("RESPONSE_INVALID");
    if (body.items !== undefined) {
      if (!Array.isArray(body.items) || body.items.length > OPS_BACKUP_AUDIT_PAGE_SIZE) {
        throw new AdminReadError("RESPONSE_INVALID");
      }
      runs.push(...body.items);
    }
    if (body.nextPageToken === undefined || body.nextPageToken === "") return runs;
    if (typeof body.nextPageToken !== "string" || !PAGE_TOKEN.test(body.nextPageToken)) {
      throw new AdminReadError("RESPONSE_INVALID");
    }
    pageToken = body.nextPageToken;
  }
  throw new AdminReadError("PAGE_LIMIT");
}

function unavailableAll(reason) {
  return AUDIT_PROBES.map((probe) => buildOpsProbeUnavailable(probe, { reason }));
}

/** Point-in-time recovery from the describe object alone: only `true` proves it on. */
function pitrLine(describe) {
  const config = describe?.settings?.backupConfiguration;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return buildOpsProbeUnavailable("backup_pitr_enabled", { reason: "EVIDENCE_UNREADABLE" });
  }
  const flag = config.pointInTimeRecoveryEnabled;
  // The Admin API always serialises true; an absent value proves only "not true".
  if (flag === true) return buildOpsProbeLine({ probe: "backup_pitr_enabled", state: "ok", value: 1 });
  if (flag === false || flag === undefined) return buildOpsProbeLine({ probe: "backup_pitr_enabled", state: "ok", value: 0 });
  return buildOpsProbeUnavailable("backup_pitr_enabled", { reason: "EVIDENCE_UNREADABLE" });
}

/**
 * The three signals for one instance's describe object and backup runs, both
 * already read. Pure: no network. `describe` or `runs` null means that read
 * failed, with `failure` its closed reason.
 */
export function auditBackupEvidence({ configuration, nowMs, describe, runs, describeFailure = null, runsFailure = null }) {
  if (describe === null) return Object.freeze(unavailableAll(describeFailure ?? "FETCH_FAILED"));
  const pitr = pitrLine(describe);
  if (runs === null) {
    // Without the run list the level and the freshness are unknown; PITR is
    // a setting and stands on its own.
    return Object.freeze([
      buildOpsProbeUnavailable("backup_audit_level", { reason: runsFailure ?? "FETCH_FAILED" }),
      pitr,
      buildOpsProbeUnavailable("backup_last_automated_age_hours", { reason: runsFailure ?? "FETCH_FAILED" }),
    ]);
  }
  const receipt = assessBackupRuns({
    environment: configuration.target,
    nowMs,
    project: configuration.project,
    region: configuration.region,
    instances: [{ role: "primary", instance: configuration.instance, settings: describe, backupRuns: runs }],
  });
  const role = receipt.roles.primary;
  // OPS-1's closed code list is the only free-form-looking text in a line.
  const codes = receipt.codes.filter((code) => BACKUP_HORIZON_CODES.includes(code));
  const level = buildOpsProbeLine({
    probe: "backup_audit_level", state: "ok", value: OPS_BACKUP_AUDIT_LEVELS[receipt.verdict], codes,
  });
  let freshness;
  if (role.onDemand === null) {
    // Run evidence the policy could not read: its ages are null, not 0.
    freshness = buildOpsProbeUnavailable("backup_last_automated_age_hours", { reason: "EVIDENCE_UNREADABLE" });
  } else if (role.lastSuccessfulAutomatedAgeHours === null) {
    freshness = buildOpsProbeUnavailable("backup_last_automated_age_hours", { reason: "NO_DATA" });
  } else {
    freshness = buildOpsProbeLine({
      probe: "backup_last_automated_age_hours", state: "ok", value: role.lastSuccessfulAutomatedAgeHours,
    });
  }
  return Object.freeze([level, pitr, freshness]);
}

/** A closed code for stderr. */
export function safeOpsBackupAuditCode(error) {
  return safeOpsProbeCode(error, "OPS_BACKUP_AUDIT_FAILED");
}

/**
 * Run the audit. Dependencies are injectable for local qualification:
 * createAccessTokenProvider() and fetchImpl(url, init). Returns
 * { status: 'help' } or { lines, exitCode }; configuration and usage
 * refusals throw a coded Error.
 */
export async function runOpsBackupAudit({
  argv = process.argv.slice(2),
  env = process.env,
  dependencies = {},
  now = Date.now,
} = {}) {
  const args = parseOpsBackupAuditArguments(argv);
  if (args.help) return Object.freeze({ status: "help" });
  const configuration = readOpsProbeEnvironment(env, OPS_BACKUP_AUDIT_JOB);
  // A credential that cannot be had is a failed fetch, not a silent pass: the
  // three signals are then unavailable (FETCH_FAILED) and the run still exits 0.
  let accessToken = null;
  try {
    const accessTokenProvider = await (dependencies.createAccessTokenProvider ?? createGoogleAccessTokenProvider)();
    const token = await accessTokenProvider();
    if (typeof token === "string" && token.length > 0) accessToken = token;
  } catch {
    accessToken = null;
  }
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  let describe = null;
  let describeFailure = accessToken === null ? "FETCH_FAILED" : null;
  let runs = null;
  let runsFailure = null;
  if (accessToken !== null) {
    const deps = { accessToken, fetchImpl };
    try {
      describe = await fetchInstance(configuration, deps);
    } catch (error) {
      describeFailure = error instanceof AdminReadError ? error.reason : "FETCH_FAILED";
    }
    if (describe !== null) {
      try {
        runs = await fetchBackupRuns(configuration, deps);
      } catch (error) {
        runsFailure = error instanceof AdminReadError ? error.reason : "FETCH_FAILED";
      }
    }
  }
  const lines = auditBackupEvidence({ configuration, nowMs: now(), describe, runs, describeFailure, runsFailure });
  return Object.freeze({ lines, exitCode: 0 });
}

async function main() {
  try {
    const result = await runOpsBackupAudit();
    if (result.status === "help") {
      process.stdout.write(OPS_BACKUP_AUDIT_USAGE);
      return;
    }
    process.stdout.write(`${result.lines.map(serializeOpsProbeLine).join("\n")}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema: OPS_PROBE_SCHEMA,
      job: OPS_BACKUP_AUDIT_JOB,
      status: "failed",
      code: safeOpsBackupAuditCode(error),
    })}\n`);
    process.exitCode = error?.usage === true ? 2 : 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
