#!/usr/bin/env node

/**
 * Operator CLI for the Google Cloud backup-horizon policy (OPS-1). The
 * service runs on one Cloud SQL instance with no deletion ledger (decisions
 * D2 and D4), so every command names that one instance, role 'primary'; a
 * ledger instance or role is refused.
 *
 *   audit --environment=production|staging --project=<id>
 *         --primary-instance=<name> [--region=<r>]
 *     Read-only: `gcloud sql instances describe` and `gcloud sql backups list`
 *     for the instance. Prints the 'tibotattle-backup-horizon-audit-v2'
 *     receipt; exits 0 ok, 2 warn, 3 breach, 1 error. The receipt covers the
 *     instance's backup runs only (its `coverage` field), not project-level
 *     backups that outlive a deleted instance.
 *
 *   create-on-demand --environment --project --instance=<name>
 *         --instance-role=primary --purpose=<enum> --expires-in-days=<1..90>
 *         --region=<r> --authorize=create-on-demand:<environment>:primary
 *     The only sanctioned way to take an on-demand backup: labelled
 *     'tibotattle-expires-on=YYYY-MM-DD;purpose=<enum>', stored in exactly
 *     --region (never the default multi-region), synchronous (never --async),
 *     then read back from the backup list.
 *
 *   prune --environment --receipt=<absolute path> --authorize=<receipt digest>
 *     Deletes at most 10 ON_DEMAND backups that an audit receipt younger than
 *     24 h reported due, overdue or critical, after re-listing live backups
 *     and aborting before the first deletion on any mismatch.
 *
 * Every gcloud call goes through spawnSync with an argv array and no shell.
 * Output is content-free JSON; errors are named codes and never echo gcloud
 * output. Test-estate targets are always refused: there is no test
 * environment value.
 */

import { spawnSync } from "node:child_process";
import { constants as fsConstants, realpathSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKUP_HORIZON_ENVIRONMENTS,
  BACKUP_HORIZON_ROLES,
  BackupHorizonError,
  CLOUD_SQL_INSTANCE_ID_PATTERN,
  GCP_PROJECT_ID_PATTERN,
  GCP_REGION_PATTERN,
  ON_DEMAND_MAX_DAYS,
  ON_DEMAND_PURPOSES,
  PRUNABLE_ON_DEMAND_STATUSES,
  assessBackupRuns,
  classifyBackupRun,
  compareOnDemandEntries,
  formatOnDemandDescription,
  normalizeBackupRunId,
  onDemandExpiresOn,
  verifyBackupHorizonReceipt,
} from "../cloud-run/ops-backup-horizon.mjs";
import STAGING_DESIRED_STATE from "../cloud-run/infra/staging.desired-state.json" with { type: "json" };
import { GCP_PRIVATE_TEST_TARGET } from "./gcp-test-project.mjs";

export const BACKUP_ON_DEMAND_RECEIPT_SCHEMA = "tibotattle-backup-on-demand-v1";
export const BACKUP_PRUNE_JOURNAL_SCHEMA = "tibotattle-backup-horizon-prune-v1";
export const PRUNE_MAX_DELETIONS_PER_RUN = 10;
export const PRUNE_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/**
 * Restated from scripts/gcp-test-database.mjs rather than imported from it;
 * gcp-backup-horizon.check.mjs pins the two literals together.
 * Names must additionally be bare Cloud SQL instance ids.
 */
export const INSTANCE_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/u;
export const AUDIT_EXIT_CODES = Object.freeze({ ok: 0, warn: 2, breach: 3 });

const DAY_MS = 24 * 60 * 60 * 1_000;
const FUTURE_RECEIPT_TOLERANCE_MS = 5 * 60 * 1_000;
const GCLOUD_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;
const EXPIRES_IN_DAYS = /^[1-9][0-9]{0,2}$/u;
const LIVE_PRUNABLE_RUN_STATUSES = new Set(["SUCCESSFUL", "DELETION_FAILED"]);

const COMMANDS = Object.freeze({
  audit: Object.freeze({
    required: ["--environment", "--project", "--primary-instance"],
    optional: ["--region"],
  }),
  "create-on-demand": Object.freeze({
    required: [
      "--environment",
      "--project",
      "--instance",
      "--instance-role",
      "--purpose",
      "--expires-in-days",
      "--region",
      "--authorize",
    ],
    optional: [],
  }),
  prune: Object.freeze({
    required: ["--environment", "--receipt", "--authorize"],
    optional: [],
  }),
});

function fail(code) {
  throw new BackupHorizonError(code);
}

/** Every string value of the fixed test target, plus each segment of its connection names. */
function collectTestTargetValues() {
  const values = new Set();
  for (const [field, value] of Object.entries(GCP_PRIVATE_TEST_TARGET)) {
    if (typeof value !== "string") continue;
    values.add(value);
    if (field.endsWith("ConnectionName")) {
      for (const segment of value.split(":")) values.add(segment);
    }
  }
  return values;
}

const TEST_TARGET_VALUES = collectTestTargetValues();

/** True when a project or instance value names the private test estate. */
export function isTestTargetValue(value) {
  return TEST_TARGET_VALUES.has(value) || (typeof value === "string" && value.startsWith("tibotattle-test-"));
}

function validateEnvironment(value) {
  if (!BACKUP_HORIZON_ENVIRONMENTS.includes(value)) fail("BACKUP_HORIZON_ENVIRONMENT_INVALID");
  return value;
}

function validateProject(value, exactStagingTarget = false) {
  if (typeof value !== "string" || (isTestTargetValue(value)
      && !(exactStagingTarget && value === STAGING_DESIRED_STATE.project))) fail("BACKUP_HORIZON_TEST_TARGET_REFUSED");
  if (!GCP_PROJECT_ID_PATTERN.test(value)) fail("BACKUP_HORIZON_PROJECT_INVALID");
  return value;
}

function validateInstance(value) {
  if (typeof value !== "string" || isTestTargetValue(value)) fail("BACKUP_HORIZON_TEST_TARGET_REFUSED");
  if (!INSTANCE_PATTERN.test(value) || !CLOUD_SQL_INSTANCE_ID_PATTERN.test(value)) {
    fail("BACKUP_HORIZON_INSTANCE_INVALID");
  }
  return value;
}

// The staging/test project is shared; only the committed staging primary is
// admitted in that project. Check the whole tuple at every exported boundary.
function validateTargetIdentity(environment, project, instance) {
  environment = validateEnvironment(environment);
  const exactStagingTarget = environment === "staging"
    && project === STAGING_DESIRED_STATE.project
    && instance === STAGING_DESIRED_STATE.cloudSql.instance;
  project = validateProject(project, exactStagingTarget);
  instance = validateInstance(instance);
  if ((environment === "staging" && !exactStagingTarget)
      || (environment === "production" && instance.split("-").includes("staging"))) {
    fail("BACKUP_HORIZON_TARGET_MISMATCH");
  }
  return { environment, project, instance };
}

function validateRegion(value) {
  if (value === null) return null;
  return validateRequiredRegion(value);
}

function validateRequiredRegion(value) {
  if (typeof value !== "string" || !GCP_REGION_PATTERN.test(value)) fail("BACKUP_HORIZON_REGION_INVALID");
  return value;
}

function validateRole(value) {
  if (!BACKUP_HORIZON_ROLES.includes(value)) fail("BACKUP_HORIZON_ROLE_INVALID");
  return value;
}

function validatePurpose(value) {
  if (!ON_DEMAND_PURPOSES.includes(value)) fail("BACKUP_ON_DEMAND_PURPOSE_INVALID");
  return value;
}

function validateExpiresInDays(value) {
  const days = typeof value === "string" && EXPIRES_IN_DAYS.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(days) || days < 1 || days > ON_DEMAND_MAX_DAYS) {
    fail("BACKUP_ON_DEMAND_EXPIRY_INVALID");
  }
  return days;
}

function readFlags(argv, { required, optional }) {
  const allowed = new Set([...required, ...optional]);
  const values = new Map();
  for (const argument of argv) {
    const separator = typeof argument === "string" ? argument.indexOf("=") : -1;
    if (separator < 3 || !argument.startsWith("--")) fail("BACKUP_HORIZON_ARGUMENT_INVALID");
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (!allowed.has(name) || value.length === 0 || values.has(name)) fail("BACKUP_HORIZON_ARGUMENT_INVALID");
    values.set(name, value);
  }
  if (!required.every((name) => values.has(name))) fail("BACKUP_HORIZON_ARGUMENT_MISSING");
  return values;
}

/**
 * Validate a create-on-demand request (CLI or OPS-10 reuse) without the CLI
 * authorization token. The region is required: without --location gcloud
 * stores the copy in the closest multi-region, which the audit reports as
 * BACKUP_LOCATION_MISMATCH.
 */
export function validateCreateOnDemandRequest(request = {}) {
  return Object.freeze({
    ...validateTargetIdentity(request.environment, request.project, request.instance),
    instanceRole: validateRole(request.instanceRole),
    purpose: validatePurpose(request.purpose),
    expiresInDays: validateExpiresInDays(request.expiresInDays),
    region: validateRequiredRegion(request.region),
  });
}

export function parseBackupHorizonArgs(argv) {
  if (!Array.isArray(argv) || !Object.hasOwn(COMMANDS, argv[0])) fail("BACKUP_HORIZON_COMMAND_INVALID");
  const command = argv[0];
  const values = readFlags(argv.slice(1), COMMANDS[command]);
  const environment = validateEnvironment(values.get("--environment"));
  if (command === "audit") {
    const target = validateTargetIdentity(environment, values.get("--project"), values.get("--primary-instance"));
    return Object.freeze({
      command,
      environment,
      project: target.project,
      primaryInstance: target.instance,
      region: validateRegion(values.get("--region") ?? null),
    });
  }
  if (command === "create-on-demand") {
    const request = validateCreateOnDemandRequest({
      environment,
      project: values.get("--project"),
      instance: values.get("--instance"),
      instanceRole: values.get("--instance-role"),
      purpose: values.get("--purpose"),
      expiresInDays: values.get("--expires-in-days"),
      region: values.get("--region"),
    });
    if (values.get("--authorize") !== `create-on-demand:${environment}:${request.instanceRole}`) {
      fail("BACKUP_ON_DEMAND_AUTHORIZATION_MISMATCH");
    }
    return Object.freeze({ command, ...request });
  }
  const receiptPath = values.get("--receipt");
  const authorize = values.get("--authorize");
  if (!isAbsolute(receiptPath)) fail("PRUNE_RECEIPT_PATH_INVALID");
  if (!DIGEST.test(authorize)) fail("PRUNE_AUTHORIZATION_INVALID");
  return Object.freeze({ command, environment, receiptPath: resolve(receiptPath), authorize });
}

function runGcloud(spawn, args, failureCode) {
  let result;
  try {
    result = spawn("gcloud", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GCLOUD_MAX_BUFFER_BYTES,
      windowsHide: true,
    });
  } catch {
    fail(failureCode);
  }
  if (result === null || typeof result !== "object"
      || (result.error !== undefined && result.error !== null)
      || result.status !== 0 || typeof result.stdout !== "string") {
    fail(failureCode);
  }
  return result.stdout;
}

function gcloudJson(spawn, args, failureCode, invalidCode) {
  const stdout = runGcloud(spawn, args, failureCode);
  try {
    return JSON.parse(stdout);
  } catch {
    return fail(invalidCode);
  }
}

function describeInstanceArgs(project, instance) {
  return ["sql", "instances", "describe", instance, `--project=${project}`, "--format=json"];
}

function listBackupsArgs(project, instance) {
  return ["sql", "backups", "list", `--instance=${instance}`, `--project=${project}`, "--format=json"];
}

function listBackupRuns(spawn, project, instance) {
  const runs = gcloudJson(spawn, listBackupsArgs(project, instance),
    "BACKUP_HORIZON_LIST_FAILED", "BACKUP_HORIZON_LIST_INVALID");
  if (!Array.isArray(runs)) fail("BACKUP_HORIZON_LIST_INVALID");
  return runs;
}

/** Read-only audit of the one instance; returns the frozen receipt. */
export function runBackupHorizonAudit(config, { spawn = spawnSync, now = Date.now } = {}) {
  const target = validateTargetIdentity(config.environment, config.project, config.primaryInstance);
  config = { ...config, environment: target.environment, project: target.project,
    primaryInstance: target.instance, region: validateRegion(config.region ?? null) };
  const instances = [];
  for (const [role, instance] of [["primary", config.primaryInstance]]) {
    const settings = gcloudJson(spawn, describeInstanceArgs(config.project, instance),
      "BACKUP_HORIZON_DESCRIBE_FAILED", "BACKUP_HORIZON_DESCRIBE_INVALID");
    const backupRuns = gcloudJson(spawn, listBackupsArgs(config.project, instance),
      "BACKUP_HORIZON_LIST_FAILED", "BACKUP_HORIZON_LIST_INVALID");
    instances.push({ role, instance, settings, backupRuns });
  }
  return assessBackupRuns({
    environment: config.environment,
    nowMs: now(),
    project: config.project,
    region: config.region,
    instances,
  });
}

/**
 * Take one labelled on-demand backup and read it back. Exported for the OPS-10
 * rollout, which holds its own authorization; the CLI additionally requires
 * --authorize=create-on-demand:<environment>:<role>.
 */
export function createOnDemandBackup({ spawn = spawnSync, now = Date.now } = {}, args = {}) {
  const request = validateCreateOnDemandRequest(args);
  const { project, instance } = request;
  const expiresOn = onDemandExpiresOn(now(), request.expiresInDays);
  const description = formatOnDemandDescription({ expiresOn, purpose: request.purpose });
  const existingIds = new Set(listBackupRuns(spawn, project, instance)
    .map((run) => normalizeBackupRunId(run?.id))
    .filter((id) => id !== null));
  runGcloud(spawn, [
    "sql", "backups", "create",
    `--instance=${instance}`,
    `--project=${project}`,
    `--description=${description}`,
    `--location=${request.region}`,
  ], "BACKUP_ON_DEMAND_CREATE_FAILED");
  const created = listBackupRuns(spawn, project, instance).filter((run) => run !== null
    && typeof run === "object"
    && run.type === "ON_DEMAND"
    && run.description === description
    && !existingIds.has(normalizeBackupRunId(run.id)));
  if (created.length === 0) fail("BACKUP_ON_DEMAND_READBACK_MISSING");
  if (created.length > 1) fail("BACKUP_ON_DEMAND_READBACK_AMBIGUOUS");
  const readback = classifyBackupRun(created[0], { instance, nowMs: now() });
  if (!readback.recognized || readback.status !== "SUCCESSFUL"
      || readback.location !== request.region
      || readback.label?.expiresOn !== expiresOn || readback.label?.purpose !== request.purpose) {
    fail("BACKUP_ON_DEMAND_READBACK_INVALID");
  }
  return Object.freeze({
    schema: BACKUP_ON_DEMAND_RECEIPT_SCHEMA,
    environment: request.environment,
    project,
    instance,
    role: request.instanceRole,
    purpose: request.purpose,
    expiresOn,
    id: readback.id,
    windowStartTime: readback.windowStartTime,
    outcome: "created",
  });
}

async function readExactBytes(handle, size) {
  const bytes = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) fail("PRUNE_RECEIPT_UNREADABLE");
  return bytes.subarray(0, size);
}

/** Bounded, no-follow read of an audit receipt file; returns the parsed JSON. */
export async function readBackupHorizonReceiptFile(receiptPath) {
  if (typeof receiptPath !== "string" || !isAbsolute(receiptPath)) fail("PRUNE_RECEIPT_PATH_INVALID");
  let handle;
  let text;
  try {
    const pathStat = await lstat(receiptPath);
    if (!pathStat.isFile() || pathStat.nlink !== 1 || pathStat.size < 1 || pathStat.size > MAX_RECEIPT_BYTES) {
      fail("PRUNE_RECEIPT_UNREADABLE");
    }
    handle = await open(receiptPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino
        || openedStat.size !== pathStat.size) {
      fail("PRUNE_RECEIPT_UNREADABLE");
    }
    const bytes = await readExactBytes(handle, openedStat.size);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof BackupHorizonError) throw error;
    fail("PRUNE_RECEIPT_UNREADABLE");
  } finally {
    await handle?.close().catch(() => {});
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail("BACKUP_HORIZON_RECEIPT_INVALID");
  }
}

/**
 * Receipt-bound prune. Verifies the receipt (closed schema, digest, age,
 * environment, authorization), re-lists every affected instance and checks
 * every candidate before the first deletion, then deletes at most
 * PRUNE_MAX_DELETIONS_PER_RUN, oldest first, journaling each outcome.
 */
export async function pruneOnDemandBackups(config, {
  spawn = spawnSync,
  now = Date.now,
  readReceipt = readBackupHorizonReceiptFile,
  writeLine = () => {},
} = {}) {
  const receipt = verifyBackupHorizonReceipt(await readReceipt(config.receiptPath));
  if (receipt.digest !== config.authorize) fail("PRUNE_AUTHORIZATION_MISMATCH");
  if (receipt.environment !== config.environment) fail("PRUNE_ENVIRONMENT_MISMATCH");
  const nowMs = now();
  const generatedMs = Date.parse(receipt.generatedAt);
  if (!(nowMs - generatedMs < PRUNE_RECEIPT_MAX_AGE_MS) || generatedMs - nowMs > FUTURE_RECEIPT_TOLERANCE_MS) {
    fail("PRUNE_RECEIPT_STALE");
  }
  const target = validateTargetIdentity(receipt.environment, receipt.project, receipt.roles.primary.instance);
  const project = target.project;
  const candidates = [];
  for (const role of BACKUP_HORIZON_ROLES) {
    const instance = validateInstance(receipt.roles[role].instance);
    // A role whose run evidence was unavailable (null) has nothing the receipt can authorize.
    for (const entry of receipt.roles[role].onDemand ?? []) {
      if (PRUNABLE_ON_DEMAND_STATUSES.includes(entry.status)) candidates.push({ role, instance, entry });
    }
  }

  const liveByRole = new Map();
  for (const { role, instance } of candidates) {
    if (liveByRole.has(role)) continue;
    const byId = new Map();
    for (const run of listBackupRuns(spawn, project, instance)) {
      const id = normalizeBackupRunId(run?.id);
      if (id === null || byId.has(id)) fail("PRUNE_LIVE_LIST_UNRECOGNIZED");
      byId.set(id, run);
    }
    liveByRole.set(role, byId);
  }
  const verified = candidates.map(({ role, instance, entry }) => {
    const run = liveByRole.get(role).get(entry.id);
    const live = run === undefined ? null : classifyBackupRun(run, { instance, nowMs });
    if (live === null || !live.recognized
        || live.id !== entry.id
        || live.type !== "ON_DEMAND"
        || live.windowStartTime !== entry.windowStartTime
        || !LIVE_PRUNABLE_RUN_STATUSES.has(live.status)
        || !PRUNABLE_ON_DEMAND_STATUSES.includes(live.onDemandStatus)) {
      fail("PRUNE_TARGET_MISMATCH");
    }
    return { role, instance, id: entry.id, windowStartTime: entry.windowStartTime, ageMs: live.ageMs };
  });
  verified.sort((left, right) => compareOnDemandEntries(left, right)
    || BACKUP_HORIZON_ROLES.indexOf(left.role) - BACKUP_HORIZON_ROLES.indexOf(right.role));

  const targets = verified.slice(0, PRUNE_MAX_DELETIONS_PER_RUN);
  let deleted = 0;
  for (const target of targets) {
    const line = {
      schema: BACKUP_PRUNE_JOURNAL_SCHEMA,
      event: "delete",
      role: target.role,
      id: target.id,
      ageDays: Math.floor(target.ageMs / DAY_MS),
    };
    try {
      runGcloud(spawn, [
        "sql", "backups", "delete", target.id,
        `--instance=${target.instance}`,
        `--project=${project}`,
        "--quiet",
      ], "PRUNE_DELETE_FAILED");
    } catch (error) {
      writeLine(Object.freeze({ ...line, outcome: "failed" }));
      throw error;
    }
    deleted += 1;
    writeLine(Object.freeze({ ...line, outcome: "deleted" }));
  }
  return Object.freeze({
    schema: BACKUP_PRUNE_JOURNAL_SCHEMA,
    event: "summary",
    environment: receipt.environment,
    receiptDigest: receipt.digest,
    candidates: verified.length,
    deleted,
    deferred: verified.length - deleted,
  });
}

/** CLI entry; returns the process exit code. */
export async function main(argv = process.argv.slice(2), {
  spawn = spawnSync,
  now = Date.now,
  readReceipt = readBackupHorizonReceiptFile,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  try {
    const config = parseBackupHorizonArgs(argv);
    if (config.command === "audit") {
      const receipt = runBackupHorizonAudit(config, { spawn, now });
      stdout(`${JSON.stringify(receipt, null, 2)}\n`);
      return AUDIT_EXIT_CODES[receipt.verdict];
    }
    if (config.command === "create-on-demand") {
      stdout(`${JSON.stringify(createOnDemandBackup({ spawn, now }, config), null, 2)}\n`);
      return 0;
    }
    const summary = await pruneOnDemandBackups(config, {
      spawn,
      now,
      readReceipt,
      writeLine: (line) => stdout(`${JSON.stringify(line)}\n`),
    });
    stdout(`${JSON.stringify(summary)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof BackupHorizonError ? error.code : "BACKUP_HORIZON_FAILED";
    stderr(`${JSON.stringify({ status: "error", code })}\n`);
    return 1;
  }
}

/**
 * Node resolves symlinks in the entry module's URL but not in argv[1], so both
 * sides are compared by real path; otherwise a run through a symlinked path
 * (for example /tmp on macOS) would skip main() and exit 0, the audit's "ok".
 */
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
