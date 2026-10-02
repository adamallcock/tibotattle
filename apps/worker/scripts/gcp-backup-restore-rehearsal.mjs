#!/usr/bin/env node

/**
 * Backup-restore rehearsal for the Cloud SQL primary (E-OPS7).
 *
 *   node scripts/gcp-backup-restore-rehearsal.mjs rehearse --environment=staging
 *        --path=pitr --point-in-time=<RFC 3339 UTC>|after-preflight
 *        [--rehearsal-id=<8 [a-z0-9]>] [--sample-rows=<1..1000>] [--dry-run]
 *   node scripts/gcp-backup-restore-rehearsal.mjs rehearse --environment=staging
 *        --path=backup --backup-id=<backup run id> --rehearsal-id=<id> ...
 *   ... rehearse ... --apply --authorize=<the dry run's authorization>
 *        [--receipt-out=<absolute path>]
 *   node scripts/gcp-backup-restore-rehearsal.mjs cleanup --environment=staging
 *        --path=pitr|backup --rehearsal-id=<id> [--adopt-unlabelled]
 *        [--apply --authorize=...]
 *
 * It restores the environment's primary (the committed desired state's
 * `cloudSql.instance`) into ONE new scratch instance, verifies the copy against
 * the source, and deletes the scratch instance:
 *
 * - Path `pitr`: `gcloud sql instances clone <source> <scratch>
 *   --point-in-time=<t>`, then labels the clone. `after-preflight` makes the
 *   tool choose <t> a minute after its first read of the source and wait until
 *   <t> is a minute in the past, so its own source reads cover the recovery
 *   point (see the verdict below).
 * - Path `backup`: `gcloud sql instances create <scratch>` (the plane's fixed
 *   posture, no deletion protection, no automated backups, labelled), then
 *   `gcloud sql backups restore <id> --restore-instance=<scratch>
 *   --backup-instance=<source>`.
 * - Every mutation is submitted with `--async`, and this tool polls
 *   `gcloud sql operations describe` up to an explicit bound per step
 *   (OPERATION_WAIT_BOUNDS_MS). gcloud's own blocking wait stops after 600 s
 *   for clone, restore, patch and delete while the operation carries on, so it
 *   is never relied on.
 * - The scratch id is `<source>-rehearsal-<id>` (path `backup` appends `b`),
 *   the SCRATCH_INSTANCE_PATTERN that OPS-10's migration job accepts as a
 *   scratch target.
 * - Verification, all read-only (BEGIN ISOLATION LEVEL REPEATABLE READ READ
 *   ONLY, and a session that defaults to read-only): the migration history
 *   (`_tibotattle_migration_history`) of source and scratch is identical and is
 *   compared with this checkout's primary manifest; schema digests (columns,
 *   indexes, constraints, functions) are equal; every table's exact row count is
 *   equal; and for every table, a keyed digest of the first and last N rows by
 *   primary key (by the row's text for a table without one) is equal. The digest key is random per run and held in
 *   memory only, so no row digest is ever printed: the receipt says `equal` or
 *   `differs`.
 * - Verdict. The source is read before the restore and again after the
 *   scratch verification, each time with a write watermark (the schema's
 *   cumulative insert, update and delete counters, the statistics reset time
 *   and the server start time). A source that moved in between, by data or by
 *   watermark, makes the comparison `inconclusive`. A scratch that differs from
 *   the source is `failed` only when the source is shown unchanged since the
 *   recovery point: the point in time is after the first source read
 *   (`after-preflight`) and the source did not move. Otherwise a difference
 *   may be a write after the recovery point, so it is `inconclusive` with
 *   RESTORE_SOURCE_UNCHANGED_SINCE_RECOVERY_POINT_UNPROVEN. The backup path
 *   can never show that (its backup predates the run), so a difference there
 *   is always `inconclusive`. Equality is `passed` on either path.
 * - Timing: each mutation's wall time to its operation's end, and time to
 *   ready (from the first mutation until the scratch is RUNNABLE and a
 *   database session opens).
 * - The do-not-restore reapply step is an INJECTED interface
 *   (`doNotRestore.reapply(target)`), with no default list: custody of the list
 *   is open (OA-9, decided after cutover). The CLI injects none, so its receipt
 *   always reads `uploadsMayReopen: false` with
 *   `DO_NOT_RESTORE_STEP_NOT_PROVIDED`. `uploadsMayReopen` is true only when the
 *   verification passed, the migration history equals the image tail, and the
 *   step returned a well-formed `done` result.
 * - Teardown, armed only by this run's own create or clone (see Ownership): wait
 *   (bounded, SCRATCH_SETTLE_BOUND_MS) until the scratch is out of
 *   PENDING_CREATE or maintenance and no operation on it is running, patch it
 *   (no deletion protection, no final backup, no retain-on-delete), read it back,
 *   refuse to delete if any of those is still on (a final backup would keep a
 *   restorable copy), delete it, and read back that it and any final backup of
 *   it are gone. A scratch still busy at the bound is left for `cleanup`.
 *
 * Safety:
 * - Dry run is the default and makes no call: it prints the exact plan and the
 *   exact `--authorize` value (`restore-rehearsal:<env>:<scratch>:<plan digest>`).
 * - Only staging is rehearsed. Production needs its committed desired state
 *   filled (the loader refuses DESIRED_STATE_PLACEHOLDER_UNFILLED until OWN-5)
 *   AND `--production`; even then it only prints the plan (`plan_only`) and
 *   refuses `--apply` and `cleanup`. Every other environment is refused.
 * - The source is only read. Every gcloud call passes a closed guard: a fixed
 *   set of command shapes, exactly one `--project`, `--async` on every mutation
 *   and on no read, operations described only when a mutation of this run
 *   returned them, and every mutation names the scratch instance as its target
 *   (the source appears only as a clone or backup source). The scratch instance
 *   is the only thing this tool creates or deletes; it never deletes a backup.
 * - Ownership. The scratch must not exist at preflight. Cloud SQL refuses a
 *   create or clone whose name exists, so an ACCEPTED create or clone, with an
 *   operation that did not fail, proves the scratch is this run's, and only
 *   then is teardown armed. A refused or failed submission (another run took
 *   the name, or gcloud failed after sending), a failed operation, or an
 *   unreadable operation never deletes anything: the receipt reports whether
 *   an instance carries the name, and `cleanup` decides. `cleanup` deletes
 *   only a scratch carrying this tool's labels for the same rehearsal id, or,
 *   for the PITR path only, with `--adopt-unlabelled` and its own
 *   authorization, an unlabelled one (a clone whose label step never ran).
 * - Output is content-free: names, counts, timings, booleans and codes. gcloud's
 *   stderr is discarded; errors are named codes.
 *
 * Database sessions (default `connect`): the Cloud SQL Node connector with IAM
 * database authentication as the plane's migrator account, impersonated by the
 * operator's gcloud identity (the operator needs
 * roles/iam.serviceAccountTokenCreator on that account). The token stays in
 * this process. Tests inject `connect` and a fake gcloud runner.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  CLOUD_SQL_POSTURE,
  GcpOpsInfraError,
  TEST_TARGET_NAMES,
  TEST_TARGET_PREFIXES,
  databaseFlagsArgument,
  deepFreeze,
  fail,
  loadCommittedDesiredState,
} from "./gcp-ops-infra-manifest.mjs";
import {
  SCRATCH_INSTANCE_PATTERN,
  compareHistoryToManifest,
} from "../cloud-run/postgres-production-migrations.mjs";
import { readPostgresMigrations } from "./postgres-migrations.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const RESTORE_REHEARSAL_RECEIPT_SCHEMA = "tibotattle-gcp-backup-restore-rehearsal-v1";
export const RESTORE_REHEARSAL_PATHS = Object.freeze(["pitr", "backup"]);
/** Environments this tool accepts; production only plans. */
export const RESTORE_REHEARSAL_ENVIRONMENTS = Object.freeze(["staging", "production"]);
export const REHEARSAL_ID_PATTERN = /^[a-z0-9]{8}$/u;
export const DEFAULT_SAMPLE_ROWS = 64;
export const MAX_SAMPLE_ROWS = 1_000;
export const MAX_TABLES = 1_000;
export const HISTORY_TABLE = "_tibotattle_migration_history";
export const REHEARSAL_LABELS = Object.freeze({ purpose: "tibotattle-purpose", id: "tibotattle-rehearsal" });
export const REHEARSAL_LABEL_PURPOSE = "restore-rehearsal";
export const EXIT_CODES = Object.freeze({
  /** Verified, the do-not-restore step done, at the image tail, scratch deleted. */
  uploadsMayReopen: 0,
  /** Verified and scratch deleted, but uploads may not reopen (`uploadsBlockedBy`). */
  uploadsBlocked: 2,
  /** Verification failed or inconclusive; scratch deleted. */
  verificationFailed: 3,
});

/** gcloud command shapes this tool may issue, and nothing else. */
export const RESTORE_REHEARSAL_COMMANDS = Object.freeze({
  "sql instances describe": "read",
  "sql instances list": "read",
  "sql backups describe": "read",
  "sql backups list": "read",
  "sql operations describe": "read",
  "sql operations list": "read",
  "sql instances clone": "mutate",
  "sql instances create": "mutate",
  "sql backups restore": "mutate",
  "sql instances patch": "mutate",
  "sql instances delete": "mutate",
});

/** `--point-in-time` value that makes the tool choose a point after its first source read. */
export const POINT_IN_TIME_AFTER_PREFLIGHT = "after-preflight";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long this tool waits for each step's operation. gcloud never waits
 * (`--async`): its own wait stops at 600 s for clone, restore, patch and delete
 * while the operation carries on server side.
 */
export const OPERATION_WAIT_BOUNDS_MS = Object.freeze({
  clone: 6 * HOUR_MS,
  label: 30 * MINUTE_MS,
  create: HOUR_MS,
  restore: 6 * HOUR_MS,
  disarm: 30 * MINUTE_MS,
  delete: HOUR_MS,
});
/** How long teardown and cleanup wait for a busy scratch to settle before patching it. */
export const SCRATCH_SETTLE_BOUND_MS = HOUR_MS;

const PITR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const BACKUP_ID = /^[1-9][0-9]{0,24}$/u;
const OPERATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAMPLE_ROWS = /^[1-9][0-9]{0,3}$/u;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const ROW_COUNT = /^(?:0|[1-9][0-9]{0,18})$/u;
const DIGEST_SHORT = 16;
const MAX_SCRATCH_NAME = 84;
const GCLOUD_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const GCLOUD_READ_TIMEOUT_MS = 2 * MINUTE_MS;
/** Kill timer for submitting one `--async` mutation; the operation itself is polled. */
const GCLOUD_SUBMIT_TIMEOUT_MS = 10 * MINUTE_MS;
const OPERATION_POLL_INITIAL_MS = 5_000;
const OPERATION_POLL_CEILING_MS = MINUTE_MS;
/** Instance states in which a patch or delete is not refused for a running operation. */
const SETTLED_STATES = Object.freeze(["RUNNABLE", "FAILED", "SUSPENDED"]);
const READY_POLL_ATTEMPTS = 90;
const READY_POLL_INTERVAL_MS = 10_000;
const PITR_MIN_AGE_MS = MINUTE_MS;
const PITR_RETENTION_MARGIN_MS = 15 * MINUTE_MS;
/** `after-preflight` puts the point in time this long after the first source read (clock skew). */
const AFTER_PREFLIGHT_MARGIN_MS = MINUTE_MS;
/**
 * PostgreSQL publishes a backend's cumulative statistics within
 * PGSTAT_MAX_INTERVAL (60 s); the closing source read waits this long after
 * the point in time so a write before it shows in the watermark.
 */
const STATS_FLUSH_MARGIN_MS = 2 * MINUTE_MS;
const SLEEP_UNTIL_ATTEMPTS = 100;
const TOKEN_LIFETIME_MS = 45 * MINUTE_MS;

/** Tokens of a resource name, for the plane-marker rules. */
function tokens(value) {
  return String(value).toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Targets

/** True when a name is, or starts like, a test-estate resource. */
export function isTestEstateName(value) {
  return typeof value === "string"
    && (TEST_TARGET_NAMES.includes(value) || TEST_TARGET_PREFIXES.some((prefix) => value.startsWith(prefix)));
}

/** `<source>-rehearsal-<id>`, with `b` for the backup path. */
export function scratchInstanceName(source, rehearsalId, path) {
  if (!RESTORE_REHEARSAL_PATHS.includes(path)) fail("RESTORE_REHEARSAL_PATH_INVALID");
  if (typeof rehearsalId !== "string" || !REHEARSAL_ID_PATTERN.test(rehearsalId)) {
    fail("RESTORE_REHEARSAL_ID_INVALID");
  }
  return `${source}-rehearsal-${rehearsalId}${path === "backup" ? "b" : ""}`;
}

/**
 * The validated source and scratch for a desired state: the environment's own
 * primary, never a test-estate, synthetic or rehearsal name, and a scratch
 * carrying the same plane marker. Production is accepted here only so its plan
 * can be printed; the caller refuses to apply it.
 */
export function rehearsalTarget(desired, { environment, rehearsalId, path }) {
  if (!RESTORE_REHEARSAL_ENVIRONMENTS.includes(environment)) fail("RESTORE_REHEARSAL_ENVIRONMENT_REFUSED");
  if (desired === null || typeof desired !== "object" || desired.environment !== environment) {
    fail("RESTORE_REHEARSAL_ENVIRONMENT_MISMATCH");
  }
  if (desired.synthetic === true) fail("RESTORE_REHEARSAL_SYNTHETIC_TARGET_REFUSED");
  const { project, region } = desired;
  const source = desired.cloudSql?.instance;
  const database = desired.cloudSql?.database;
  const schema = desired.cloudSql?.schema;
  if (typeof project !== "string" || typeof region !== "string" || typeof source !== "string"
      || typeof database !== "string" || !IDENTIFIER.test(database)
      || typeof schema !== "string" || !IDENTIFIER.test(schema)) {
    fail("RESTORE_REHEARSAL_DESIRED_STATE_INVALID");
  }
  // Staging shares the test project, so the project itself is not a test-estate
  // marker; the instance, database and schema must not be test-estate names.
  for (const value of [source, database, schema]) {
    if (isTestEstateName(value)) fail("RESTORE_REHEARSAL_TEST_ESTATE_REFUSED");
  }
  const sourceTokens = tokens(source);
  if (SCRATCH_INSTANCE_PATTERN.test(source) || sourceTokens.includes("rehearsal")) {
    fail("RESTORE_REHEARSAL_SOURCE_REFUSED");
  }
  if (environment === "staging"
    ? !sourceTokens.includes("staging") || sourceTokens.includes("production") || sourceTokens.includes("prod")
    : sourceTokens.includes("staging")) {
    fail("RESTORE_REHEARSAL_SOURCE_REFUSED");
  }
  const scratch = scratchInstanceName(source, rehearsalId, path);
  const scratchTokens = tokens(scratch);
  if (scratch.length > MAX_SCRATCH_NAME || !SCRATCH_INSTANCE_PATTERN.test(scratch) || scratch === source
      || isTestEstateName(scratch)
      || (environment === "staging"
        ? !scratchTokens.includes("staging") || scratchTokens.includes("production") || scratchTokens.includes("prod")
        : scratchTokens.includes("staging"))) {
    fail("RESTORE_REHEARSAL_SCRATCH_REFUSED");
  }
  const migrator = desired.serviceAccounts?.migrator?.accountId;
  if (typeof migrator !== "string" || isTestEstateName(migrator)) fail("RESTORE_REHEARSAL_DESIRED_STATE_INVALID");
  return deepFreeze({
    environment,
    project,
    region,
    source,
    scratch,
    database,
    schema,
    sourceConnectionName: `${project}:${region}:${source}`,
    scratchConnectionName: `${project}:${region}:${scratch}`,
    identity: {
      serviceAccount: `${migrator}@${project}.iam.gserviceaccount.com`,
      iamUser: `${migrator}@${project}.iam`,
    },
  });
}

// ---------------------------------------------------------------------------
// Plan

function labelsArgument(rehearsalId) {
  return `${REHEARSAL_LABELS.purpose}=${REHEARSAL_LABEL_PURPOSE},${REHEARSAL_LABELS.id}=${rehearsalId}`;
}

/**
 * The exact argv of every call, for the dry run and the apply alike. Every
 * mutation is `--async`: it returns the operation, which is then polled.
 */
export function rehearsalArgv(target) {
  const project = `--project=${target.project}`;
  return Object.freeze({
    describe: (name) => ["sql", "instances", "describe", name, project, "--format=json"],
    listScratch: () => ["sql", "instances", "list", project, `--filter=name=${target.scratch}`, "--format=json"],
    describeBackup: (backupId) => ["sql", "backups", "describe", backupId, `--instance=${target.source}`, project,
      "--format=json"],
    listScratchBackups: () => ["sql", "backups", "list", project, `--filter=instance=${target.scratch}`,
      "--format=json"],
    describeOperation: (operation) => ["sql", "operations", "describe", operation, project, "--format=json"],
    listScratchOperations: () => ["sql", "operations", "list", `--instance=${target.scratch}`, project,
      "--format=json"],
    clone: (pointInTime) => ["sql", "instances", "clone", target.source, target.scratch, project,
      `--point-in-time=${pointInTime}`, "--async", "--quiet", "--format=json"],
    label: (rehearsalId) => ["sql", "instances", "patch", target.scratch, project,
      `--update-labels=${labelsArgument(rehearsalId)}`, "--async", "--quiet", "--format=json"],
    create: (desired, rehearsalId) => ["sql", "instances", "create", target.scratch, project,
      `--region=${target.region}`,
      `--database-version=${CLOUD_SQL_POSTURE.databaseVersion}`,
      `--edition=${CLOUD_SQL_POSTURE.edition}`,
      `--tier=${desired.cloudSql.tier}`,
      `--availability-type=${CLOUD_SQL_POSTURE.availabilityType}`,
      "--storage-type=SSD",
      `--storage-size=${desired.cloudSql.storageSizeGb}GB`,
      "--no-deletion-protection",
      "--assign-ip",
      `--connector-enforcement=${CLOUD_SQL_POSTURE.connectorEnforcement}`,
      "--no-backup",
      databaseFlagsArgument(desired),
      `--labels=${labelsArgument(rehearsalId)}`,
      "--async", "--quiet", "--format=json"],
    restore: (backupId) => ["sql", "backups", "restore", backupId, `--restore-instance=${target.scratch}`,
      `--backup-instance=${target.source}`, project, "--async", "--quiet", "--format=json"],
    disarm: () => ["sql", "instances", "patch", target.scratch, project, "--no-deletion-protection",
      "--no-final-backup", "--no-retain-backups-on-delete", "--async", "--quiet", "--format=json"],
    delete: () => ["sql", "instances", "delete", target.scratch, project, "--async", "--quiet", "--format=json"],
  });
}

function validatePointInTime(value, nowMs) {
  if (value === POINT_IN_TIME_AFTER_PREFLIGHT) return value;
  if (typeof value !== "string" || !PITR_TIME.test(value) || !Number.isFinite(Date.parse(value))) {
    fail("RESTORE_REHEARSAL_POINT_IN_TIME_INVALID");
  }
  if (nowMs !== undefined && !(Date.parse(value) <= nowMs - PITR_MIN_AGE_MS)) {
    fail("RESTORE_REHEARSAL_POINT_IN_TIME_NOT_PAST");
  }
  return value;
}

/** A closed rehearsal request: { environment, path, pointInTime|backupId, rehearsalId, sampleRows }. */
export function validateRehearsalRequest(request = {}, { nowMs } = {}) {
  const { environment, path } = request;
  if (!RESTORE_REHEARSAL_ENVIRONMENTS.includes(environment)) fail("RESTORE_REHEARSAL_ENVIRONMENT_REFUSED");
  if (!RESTORE_REHEARSAL_PATHS.includes(path)) fail("RESTORE_REHEARSAL_PATH_INVALID");
  if (typeof request.rehearsalId !== "string" || !REHEARSAL_ID_PATTERN.test(request.rehearsalId)) {
    fail("RESTORE_REHEARSAL_ID_INVALID");
  }
  const sampleRows = request.sampleRows ?? DEFAULT_SAMPLE_ROWS;
  if (!Number.isSafeInteger(sampleRows) || sampleRows < 1 || sampleRows > MAX_SAMPLE_ROWS) {
    fail("RESTORE_REHEARSAL_SAMPLE_ROWS_INVALID");
  }
  if (path === "pitr") {
    if (request.backupId !== undefined && request.backupId !== null) fail("RESTORE_REHEARSAL_ARGUMENT_INVALID");
    return deepFreeze({ environment, path, rehearsalId: request.rehearsalId, sampleRows,
      pointInTime: validatePointInTime(request.pointInTime, nowMs), backupId: null });
  }
  if (request.pointInTime !== undefined && request.pointInTime !== null) fail("RESTORE_REHEARSAL_ARGUMENT_INVALID");
  if (typeof request.backupId !== "string" || !BACKUP_ID.test(request.backupId)) {
    fail("RESTORE_REHEARSAL_BACKUP_ID_INVALID");
  }
  return deepFreeze({ environment, path, rehearsalId: request.rehearsalId, sampleRows,
    pointInTime: null, backupId: request.backupId });
}

/**
 * The rehearsal plan: target, every call's argv, and its digest. The
 * authorization binds the environment, the scratch name and that digest, so a
 * changed plan needs a new authorization.
 */
export function planRestoreRehearsal(desired, requestInput, { nowMs } = {}) {
  const request = validateRehearsalRequest(requestInput, { nowMs });
  const target = rehearsalTarget(desired, request);
  const argv = rehearsalArgv(target);
  const restore = request.path === "pitr"
    ? [{ step: "clone", argv: argv.clone(request.pointInTime) }, { step: "label", argv: argv.label(request.rehearsalId) }]
    : [{ step: "create", argv: argv.create(desired, request.rehearsalId) },
      { step: "restore", argv: argv.restore(request.backupId) }];
  const body = {
    schema: RESTORE_REHEARSAL_RECEIPT_SCHEMA,
    environment: target.environment,
    project: target.project,
    region: target.region,
    source: target.source,
    scratch: target.scratch,
    database: target.database,
    schemaName: target.schema,
    path: request.path,
    pointInTime: request.pointInTime,
    backupId: request.backupId,
    sampleRows: request.sampleRows,
    databaseIdentity: target.identity.iamUser,
    reads: [
      argv.describe(target.source),
      argv.listScratch(),
      ...(request.path === "backup" ? [argv.describeBackup(request.backupId)] : []),
      argv.describe(target.scratch),
      argv.describeOperation("{operation returned by each mutation}"),
      argv.listScratchOperations(),
      argv.listScratchBackups(),
    ],
    mutations: [...restore, { step: "disarm", argv: argv.disarm() }, { step: "delete", argv: argv.delete() }],
    operationWaitBoundsMs: OPERATION_WAIT_BOUNDS_MS,
    scratchSettleBoundMs: SCRATCH_SETTLE_BOUND_MS,
  };
  const planDigest = digest(body);
  return deepFreeze({
    ...body,
    planDigest,
    authorization: `restore-rehearsal:${target.environment}:${target.scratch}:${planDigest.slice(0, DIGEST_SHORT)}`,
    target,
    request,
  });
}

/** The exact cleanup authorization for one scratch instance. */
export function cleanupAuthorization(target) {
  return `restore-rehearsal-cleanup:${target.environment}:${target.scratch}`;
}

/** The exact authorization to adopt and delete an UNLABELLED PITR scratch (a clone whose label step never ran). */
export function adoptCleanupAuthorization(target) {
  return `restore-rehearsal-cleanup-adopt-unlabelled:${target.environment}:${target.scratch}`;
}

// ---------------------------------------------------------------------------
// gcloud

/** The default runner: argv only, no shell, stdout captured, stderr discarded. */
export function defaultRehearsalRunner(argv, { timeoutMs = GCLOUD_READ_TIMEOUT_MS } = {}) {
  const result = spawnSync("gcloud", argv, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: GCLOUD_MAX_BUFFER_BYTES,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, error: result.error };
}

function commandShape(argv) {
  const shape = argv.slice(0, 3).join(" ");
  return Object.hasOwn(RESTORE_REHEARSAL_COMMANDS, shape) ? shape : null;
}

function positionals(argv) {
  return argv.slice(3).filter((arg) => !arg.startsWith("-"));
}

function flagValue(argv, name) {
  const matches = argv.filter((arg) => arg.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}

/**
 * The guarded gcloud call. Reads may name the source or the scratch; every
 * mutation targets the scratch alone, and the source appears only as the
 * clone source or the backup's instance. Every mutation is `--async` and no
 * read is; an operation may be described only when a mutation through this
 * guard returned it. Failures name the shape only.
 *
 * A mutation returns `{ accepted: true, operation }`: exit status 0 means the
 * API accepted the request (`operation` is null when its name was unreadable).
 * A refused or failed submission throws GCLOUD_CALL_FAILED.
 */
export function guardedRehearsalGcloud(runner, target) {
  if (typeof runner !== "function") fail("GCLOUD_RUNNER_INVALID");
  const { project, source, scratch } = target;
  const knownOperations = new Set();
  return function call(argv) {
    if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) fail("GCLOUD_COMMAND_FORBIDDEN");
    const shape = commandShape(argv);
    if (shape === null) fail("GCLOUD_COMMAND_FORBIDDEN");
    const kind = RESTORE_REHEARSAL_COMMANDS[shape];
    if (argv.filter((arg) => arg.startsWith("--project=")).length !== 1 || !argv.includes(`--project=${project}`)) {
      fail("GCLOUD_PROJECT_FLAG_INVALID");
    }
    if (!argv.includes("--format=json")) fail("GCLOUD_FORMAT_REQUIRED");
    if (argv.some((arg) => arg.startsWith("--async=") || arg === "--enable-final-backup"
        || arg.startsWith("--impersonate-service-account") || arg.startsWith("--account")
        || arg === "--log-http")) {
      fail("GCLOUD_FLAG_FORBIDDEN");
    }
    const asyncFlags = argv.filter((arg) => arg === "--async").length;
    if (kind === "read" && asyncFlags !== 0) fail("GCLOUD_FLAG_FORBIDDEN");
    if (kind === "mutate" && asyncFlags !== 1) fail("GCLOUD_ASYNC_REQUIRED");
    const names = positionals(argv);
    const code = shape.replaceAll(" ", "-");
    if (shape === "sql instances describe") {
      if (names.length !== 1 || (names[0] !== source && names[0] !== scratch)) fail("GCLOUD_TARGET_FORBIDDEN");
    } else if (shape === "sql instances list") {
      if (names.length !== 0 || flagValue(argv, "--filter") !== `name=${scratch}`) fail("GCLOUD_TARGET_FORBIDDEN");
    } else if (shape === "sql backups describe") {
      if (names.length !== 1 || !BACKUP_ID.test(names[0]) || flagValue(argv, "--instance") !== source) {
        fail("GCLOUD_TARGET_FORBIDDEN");
      }
    } else if (shape === "sql backups list") {
      if (names.length !== 0 || flagValue(argv, "--filter") !== `instance=${scratch}`
          || argv.some((arg) => arg.startsWith("--instance"))) {
        fail("GCLOUD_TARGET_FORBIDDEN");
      }
    } else if (shape === "sql operations describe") {
      if (names.length !== 1 || !OPERATION_NAME.test(names[0]) || !knownOperations.has(names[0])) {
        fail("GCLOUD_TARGET_FORBIDDEN");
      }
    } else if (shape === "sql operations list") {
      if (names.length !== 0 || flagValue(argv, "--instance") !== scratch
          || argv.some((arg) => arg.startsWith("--filter"))) {
        fail("GCLOUD_TARGET_FORBIDDEN");
      }
    } else if (shape === "sql instances clone") {
      if (names.length !== 2 || names[0] !== source || names[1] !== scratch
          || !PITR_TIME.test(flagValue(argv, "--point-in-time") ?? "")) {
        fail("GCLOUD_TARGET_FORBIDDEN");
      }
    } else if (shape === "sql backups restore") {
      if (names.length !== 1 || !BACKUP_ID.test(names[0]) || flagValue(argv, "--restore-instance") !== scratch
          || flagValue(argv, "--backup-instance") !== source) {
        fail("GCLOUD_TARGET_FORBIDDEN");
      }
    } else if (names.length !== 1 || names[0] !== scratch) {
      // create, patch and delete: the scratch, and only the scratch.
      fail("GCLOUD_TARGET_FORBIDDEN");
    }
    if (kind === "mutate" && (scratch === source || !SCRATCH_INSTANCE_PATTERN.test(scratch) || !argv.includes("--quiet"))) {
      fail("GCLOUD_TARGET_FORBIDDEN");
    }
    let result;
    try {
      result = runner([...argv], { timeoutMs: kind === "mutate" ? GCLOUD_SUBMIT_TIMEOUT_MS : GCLOUD_READ_TIMEOUT_MS });
    } catch {
      fail(`GCLOUD_CALL_FAILED:${code}`);
    }
    if (result === null || typeof result !== "object" || result.status !== 0
        || (result.error !== undefined && result.error !== null)) {
      fail(`GCLOUD_CALL_FAILED:${code}`);
    }
    if (kind === "mutate") {
      // Accepted. Never throw from here on: the caller must learn that the
      // request went through even when the operation name is unreadable.
      let operation = null;
      try {
        const parsed = JSON.parse(typeof result.stdout === "string" ? result.stdout : "");
        if (isRecord(parsed) && typeof parsed.name === "string" && OPERATION_NAME.test(parsed.name)) {
          operation = parsed.name;
        }
      } catch {
        operation = null;
      }
      if (operation !== null) knownOperations.add(operation);
      return Object.freeze({ accepted: true, operation });
    }
    if (typeof result.stdout !== "string") fail(`GCLOUD_OUTPUT_INVALID:${code}`);
    try {
      return JSON.parse(result.stdout.trim() === "" ? (shape.endsWith("list") ? "[]" : "null") : result.stdout);
    } catch {
      return fail(`GCLOUD_OUTPUT_INVALID:${code}`);
    }
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Content-free facts of a describe, after checking it names `name` in the plane's region. */
function instanceFacts(described, { name, project, region }, code) {
  if (!isRecord(described) || described.name !== name || !isRecord(described.settings)
      || (described.project !== undefined && described.project !== project)
      || (described.region !== undefined && described.region !== region)) {
    fail(code);
  }
  const settings = described.settings;
  const backup = isRecord(settings.backupConfiguration) ? settings.backupConfiguration : {};
  const labels = isRecord(settings.userLabels) ? settings.userLabels : {};
  return deepFreeze({
    state: typeof described.state === "string" ? described.state : null,
    databaseVersion: typeof described.databaseVersion === "string" ? described.databaseVersion : null,
    tier: typeof settings.tier === "string" ? settings.tier : null,
    dataDiskSizeGb: typeof settings.dataDiskSizeGb === "string" || typeof settings.dataDiskSizeGb === "number"
      ? Number(settings.dataDiskSizeGb) : null,
    deletionProtectionEnabled: settings.deletionProtectionEnabled === true,
    finalBackupEnabled: isRecord(settings.finalBackupConfig) && settings.finalBackupConfig.enabled === true,
    retainBackupsOnDelete: settings.retainBackupsOnDelete === true,
    backupsEnabled: backup.enabled === true,
    pointInTimeRecoveryEnabled: backup.pointInTimeRecoveryEnabled === true,
    transactionLogRetentionDays: Number.isSafeInteger(backup.transactionLogRetentionDays)
      ? backup.transactionLogRetentionDays : null,
    authorizedNetworks: Array.isArray(settings.ipConfiguration?.authorizedNetworks)
      ? settings.ipConfiguration.authorizedNetworks.length : 0,
    labels: Object.fromEntries(Object.entries(labels)
      .filter(([key]) => Object.values(REHEARSAL_LABELS).includes(key))),
  });
}

function scratchListed(listed, scratch) {
  if (!Array.isArray(listed)) fail("GCLOUD_OUTPUT_INVALID:sql-instances-list");
  return listed.some((entry) => entry?.name === scratch);
}

// ---------------------------------------------------------------------------
// Read-only database fingerprint

const SESSION_SETTINGS = Object.freeze([
  "SET LOCAL statement_timeout = '120s'",
  "SET LOCAL lock_timeout = '5s'",
  "SET LOCAL idle_in_transaction_session_timeout = '300s'",
  "SET LOCAL TimeZone = 'UTC'",
  "SET LOCAL DateStyle = 'ISO, YMD'",
  "SET LOCAL IntervalStyle = 'postgres'",
  "SET LOCAL extra_float_digits = 3",
  "SET LOCAL bytea_output = 'hex'",
]);

function quote(identifier) {
  if (typeof identifier !== "string" || !IDENTIFIER.test(identifier)) fail("RESTORE_REHEARSAL_IDENTIFIER_UNSUPPORTED");
  return `"${identifier}"`;
}

const DIGEST_OF_LINES = "encode(sha256(convert_to(coalesce(string_agg(line, E'\\n' ORDER BY line), ''), 'UTF8')), 'hex')";

/** Schema-shape queries: each returns one row { entries, digest } over the schema's own definitions. */
const SHAPE_QUERIES = Object.freeze({
  columns: `SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':'
      || coalesce(column_default, '') AS line
    FROM information_schema.columns WHERE table_schema = $1`,
  indexes: "SELECT tablename || '.' || indexname || ':' || indexdef AS line FROM pg_indexes WHERE schemaname = $1",
  constraints: `SELECT conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid) AS line
    FROM pg_constraint WHERE connamespace = to_regnamespace($1)`,
  functions: `SELECT proname || '(' || pg_get_function_identity_arguments(oid) || '):'
      || encode(sha256(convert_to(coalesce(prosrc, ''), 'UTF8')), 'hex') AS line
    FROM pg_proc WHERE pronamespace = to_regnamespace($1)`,
});

export const FINGERPRINT_QUERIES = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  end: "ROLLBACK",
  identity: "/* rehearsal:identity */ SELECT current_database() AS database, "
    + "current_setting('transaction_read_only') AS read_only, "
    + "current_setting('server_version_num') AS server_version_num",
  /**
   * A write watermark: the schema's cumulative per-table insert, update and
   * delete counters (with each table's oid), the database's statistics reset
   * time and the server's start time, as one digest. Reads do not move it; any
   * row write, statistics reset or restart does.
   */
  watermark: "/* rehearsal:watermark */ SELECT count(*)::int AS tables, encode(sha256(convert_to("
    + "coalesce(string_agg(s.relid::text || ':' || s.n_tup_ins::text || ':' || s.n_tup_upd::text || ':' "
    + "|| s.n_tup_del::text, E'\\n' ORDER BY s.relid), '') || '|' || coalesce((SELECT d.stats_reset::text "
    + "FROM pg_stat_database AS d WHERE d.datname = current_database()), '') || '|' "
    + "|| pg_postmaster_start_time()::text, 'UTF8')), 'hex') AS digest "
    + "FROM pg_stat_user_tables AS s WHERE s.schemaname = $1",
  presence: "/* rehearsal:presence */ SELECT to_regnamespace($1) IS NOT NULL AS schema_present, "
    + "to_regclass($2) IS NOT NULL AS history_present",
  history: (schema) => `/* rehearsal:history */ SELECT version, name, checksum_sha256 FROM ${quote(schema)}.`
    + `${quote(HISTORY_TABLE)} ORDER BY version`,
  shape: (category) => `/* rehearsal:shape:${category} */ SELECT count(*)::int AS entries, ${DIGEST_OF_LINES} AS digest `
    + `FROM (${SHAPE_QUERIES[category]}) AS shape`,
  tables: "/* rehearsal:tables */ SELECT c.relname::text AS table_name, "
    + "(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM pg_index i "
    + "CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) "
    + "JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum "
    + "WHERE i.indrelid = c.oid AND i.indisprimary) AS primary_key "
    + "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
    + "WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY c.relname",
  count: (schema, table) => `/* rehearsal:count */ SELECT count(*)::text AS row_count FROM ${quote(schema)}.${quote(table)}`,
  /**
   * A keyed digest of the first (head) or last (tail) `$2` rows, ordered by
   * the primary key, or by the whole row's text when the table has none.
   */
  sample: (schema, table, primaryKey, direction) => {
    const way = direction === "head" ? "ASC" : "DESC";
    const order = primaryKey === null ? `ROW(x.*)::text ${way}`
      : primaryKey.map((column) => `x.${quote(column)} ${way}`).join(", ");
    return `/* rehearsal:sample:${direction} */ SELECT count(*)::int AS sampled, `
      + "encode(sha256(convert_to($1::text || coalesce(string_agg(r.line, E'\\n' ORDER BY r.ord), ''), 'UTF8')), 'hex') "
      + `AS digest FROM (SELECT ROW(x.*)::text AS line, row_number() OVER (ORDER BY ${order}) AS ord `
      + `FROM ${quote(schema)}.${quote(table)} AS x ORDER BY ${order} LIMIT $2) AS r`;
  },
});

function rows(result, code) {
  if (!isRecord(result) || !Array.isArray(result.rows)) fail(code);
  return result.rows;
}

function oneRow(result, code) {
  const list = rows(result, code);
  if (list.length !== 1 || !isRecord(list[0])) fail(code);
  return list[0];
}

/**
 * A read-only fingerprint of one database: one REPEATABLE READ READ ONLY
 * transaction, always rolled back. `key` keys the row-sample digests; those
 * digests stay inside the returned object and are only ever compared.
 */
export async function fingerprintDatabase(pool, { database, schema, sampleRows, key, onSession = () => {} }) {
  if (typeof key !== "string" || !SHA256_HEX.test(key)) fail("RESTORE_REHEARSAL_SAMPLE_KEY_INVALID");
  const code = "RESTORE_REHEARSAL_DATABASE_READ_FAILED";
  let client;
  let open = false;
  let discard = false;
  try {
    client = await pool.connect();
    onSession();
    await client.query(FINGERPRINT_QUERIES.begin);
    open = true;
    for (const statement of SESSION_SETTINGS) await client.query(statement);
    const identity = oneRow(await client.query(FINGERPRINT_QUERIES.identity), code);
    if (identity.database !== database) fail("RESTORE_REHEARSAL_DATABASE_MISMATCH");
    if (identity.read_only !== "on") fail("RESTORE_REHEARSAL_SESSION_NOT_READ_ONLY");
    const watermark = oneRow(await client.query(FINGERPRINT_QUERIES.watermark, [schema]), code);
    if (!Number.isSafeInteger(watermark.tables) || typeof watermark.digest !== "string"
        || !SHA256_HEX.test(watermark.digest)) {
      fail(code);
    }
    const presence = oneRow(await client.query(FINGERPRINT_QUERIES.presence,
      [schema, `${quote(schema)}.${quote(HISTORY_TABLE)}`]), code);
    if (presence.schema_present !== true) fail("RESTORE_REHEARSAL_SCHEMA_ABSENT");
    const history = presence.history_present === true
      ? rows(await client.query(FINGERPRINT_QUERIES.history(schema)), code).map((row) => ({
        version: Number(row.version), name: row.name, checksum_sha256: row.checksum_sha256,
      }))
      : null;
    const shape = {};
    for (const category of Object.keys(SHAPE_QUERIES)) {
      const row = oneRow(await client.query(FINGERPRINT_QUERIES.shape(category), [schema]), code);
      if (!Number.isSafeInteger(row.entries) || typeof row.digest !== "string" || !SHA256_HEX.test(row.digest)) fail(code);
      shape[category] = { entries: row.entries, digest: row.digest };
    }
    const listed = rows(await client.query(FINGERPRINT_QUERIES.tables, [schema]), code);
    if (listed.length > MAX_TABLES) fail("RESTORE_REHEARSAL_TABLE_LIMIT_EXCEEDED");
    const tables = [];
    for (const entry of listed) {
      const name = entry?.table_name;
      if (typeof name !== "string") fail(code);
      const primaryKey = Array.isArray(entry.primary_key) && entry.primary_key.length > 0 ? entry.primary_key : null;
      if (!IDENTIFIER.test(name) || (primaryKey !== null && primaryKey.some((column) => !IDENTIFIER.test(column)))) {
        tables.push({ name: IDENTIFIER.test(name) ? name : null, status: "unsupported-identifier" });
        continue;
      }
      const counted = oneRow(await client.query(FINGERPRINT_QUERIES.count(schema, name)), code).row_count;
      if (typeof counted !== "string" || !ROW_COUNT.test(counted)) fail(code);
      const table = { name, rows: counted, primaryKey, order: primaryKey === null ? "row-text" : "primary-key",
        head: null, tail: null, status: "ok" };
      for (const direction of ["head", "tail"]) {
        const sample = oneRow(await client.query(FINGERPRINT_QUERIES.sample(schema, name, primaryKey, direction),
          [key, sampleRows]), code);
        if (!Number.isSafeInteger(sample.sampled) || typeof sample.digest !== "string" || !SHA256_HEX.test(sample.digest)) {
          fail(code);
        }
        table[direction] = { sampled: sample.sampled, digest: sample.digest };
      }
      tables.push(table);
    }
    await client.query(FINGERPRINT_QUERIES.end);
    open = false;
    return deepFreeze({ serverVersionNum: String(identity.server_version_num),
      writeWatermark: { tables: watermark.tables, digest: watermark.digest }, history, shape, tables });
  } catch (error) {
    discard = true;
    if (open) {
      try { await client.query(FINGERPRINT_QUERIES.end); } catch { /* the session is discarded below */ }
    }
    if (error instanceof GcpOpsInfraError) throw error;
    fail(code);
  } finally {
    if (client !== undefined) {
      try { client.release(discard); } catch { /* nothing to recover */ }
    }
  }
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Source versus scratch. `sourceStable` is whether the source read the same
 * before and after, data and write watermark; without it nothing passes.
 * `recoveryPointCovered` is whether the recovery point is after the first
 * source read began. Only with both is the source shown unchanged since the
 * recovery point, and only then is a difference the restore's (`failed`);
 * otherwise it may be a write after the recovery point (`inconclusive`). The
 * result is content-free: no row digest leaves this function.
 */
export function compareFingerprints({ sourceBefore, sourceAfter, scratch, recoveryPointCovered = false }) {
  const sourceStable = sameValue(sourceBefore, sourceAfter);
  const sourceUnchangedSinceRecoveryPoint = recoveryPointCovered === true && sourceStable;
  const source = sourceAfter;
  const historyEqual = source.history !== null && sameValue(source.history, scratch.history);
  const shape = Object.fromEntries(Object.keys(SHAPE_QUERIES).map((category) => [category, {
    entries: { source: source.shape[category].entries, scratch: scratch.shape[category].entries },
    equal: sameValue(source.shape[category], scratch.shape[category]),
  }]));
  const scratchByName = new Map(scratch.tables.filter((table) => table.name !== null).map((table) => [table.name, table]));
  const sourceNames = new Set(source.tables.filter((table) => table.name !== null).map((table) => table.name));
  const tables = [];
  let failed = !historyEqual || Object.values(shape).some((entry) => !entry.equal);
  let incomplete = false;
  for (const table of source.tables) {
    if (table.status === "unsupported-identifier") {
      tables.push({ table: table.name, status: "unsupported-identifier" });
      incomplete = true;
      continue;
    }
    const copy = scratchByName.get(table.name);
    if (copy === undefined) {
      tables.push({ table: table.name, status: "missing-in-scratch" });
      failed = true;
      continue;
    }
    if (copy.status !== "ok") {
      tables.push({ table: table.name, status: copy.status });
      incomplete = true;
      continue;
    }
    const rowsEqual = copy.rows === table.rows;
    const sample = sameValue([table.primaryKey, table.order, table.head, table.tail],
      [copy.primaryKey, copy.order, copy.head, copy.tail]) ? "equal" : "differs";
    if (!rowsEqual || sample === "differs") failed = true;
    tables.push({
      table: table.name,
      rows: { source: table.rows, scratch: copy.rows },
      rowsEqual,
      sample,
      sampleOrder: table.order,
      sampledRows: table.head.sampled + table.tail.sampled,
    });
  }
  for (const table of scratch.tables) {
    if (table.name === null) {
      incomplete = true;
    } else if (!sourceNames.has(table.name)) {
      tables.push({ table: table.name, status: "extra-in-scratch" });
      failed = true;
    }
  }
  // A difference is the restore's only while the source is shown unchanged
  // from the recovery point to the closing read.
  let verdict = "passed";
  let code = null;
  if (!sourceStable) {
    verdict = "inconclusive";
    code = "RESTORE_SOURCE_MOVED_DURING_RUN";
  } else if (failed && !sourceUnchangedSinceRecoveryPoint) {
    verdict = "inconclusive";
    code = "RESTORE_SOURCE_UNCHANGED_SINCE_RECOVERY_POINT_UNPROVEN";
  } else if (failed) {
    verdict = "failed";
    code = "RESTORE_SCRATCH_DIFFERS_FROM_SOURCE";
  } else if (incomplete) {
    verdict = "inconclusive";
    code = "RESTORE_VERIFICATION_INCOMPLETE";
  }
  return deepFreeze({
    verdict,
    code,
    differs: failed,
    sourceStable,
    sourceUnchangedSinceRecoveryPoint,
    migrationHistory: {
      equal: historyEqual,
      source: source.history === null ? null : source.history.length,
      scratch: scratch.history === null ? null : scratch.history.length,
    },
    schemaShape: shape,
    serverVersionEqual: source.serverVersionNum === scratch.serverVersionNum,
    tables,
  });
}

/** The scratch history against this checkout's primary manifest: equal, behind, newer or diverged. */
export function manifestRelation(history, migrations) {
  if (history === null) return deepFreeze({ relation: "history-absent", applied: null, pending: null });
  try {
    const { applied, pending } = compareHistoryToManifest(history, migrations);
    return deepFreeze({ relation: pending === 0 ? "equal" : "behind", applied, pending });
  } catch (error) {
    if (error?.code === "MIGRATION_STATE_NEWER_THAN_IMAGE") {
      return deepFreeze({ relation: "newer-than-image", applied: history.length, pending: null });
    }
    return deepFreeze({ relation: "diverged", applied: null, pending: null });
  }
}

// ---------------------------------------------------------------------------
// The do-not-restore step (injected; no default list)

const DO_NOT_RESTORE_RESULT_KEYS = Object.freeze(["entries", "listSha256", "matched", "purged", "status"]);

/**
 * Validates what an injected do-not-restore step returned. Only an exact
 * `{ status: "done", listSha256, entries, matched, purged }` with
 * purged === matched <= entries counts as done; anything else is not done.
 */
export function doNotRestoreOutcome(result) {
  if (!isRecord(result) || Object.keys(result).sort().join() !== DO_NOT_RESTORE_RESULT_KEYS.join()
      || result.status !== "done" || typeof result.listSha256 !== "string" || !SHA256_HEX.test(result.listSha256)
      || ![result.entries, result.matched, result.purged].every((value) => Number.isSafeInteger(value) && value >= 0)
      || result.purged !== result.matched || result.matched > result.entries) {
    return deepFreeze({ status: "not-done", code: "DO_NOT_RESTORE_RESULT_INVALID" });
  }
  return deepFreeze({ status: "done", listSha256: result.listSha256, entries: result.entries,
    matched: result.matched, purged: result.purged });
}

// ---------------------------------------------------------------------------
// Default database connection (operator workstation)

/**
 * Opens a one-connection pool on `connectionName` through the Cloud SQL
 * connector, IAM database authentication as the impersonated migrator. Every
 * session defaults to read-only; fingerprint transactions are READ ONLY too.
 */
export async function openCloudSqlReadOnlyPool({ connectionName, database, identity, project }, { spawn = spawnSync } = {}) {
  const cloudRunRequire = createRequire(join(WORKER_ROOT, "cloud-run/package.json"));
  const { Connector } = await import(pathToFileURL(cloudRunRequire.resolve("@google-cloud/cloud-sql-connector")).href);
  const { OAuth2Client } = cloudRunRequire("google-auth-library");
  const pg = cloudRunRequire("pg");
  const mint = () => {
    const minted = spawn("gcloud", ["auth", "print-access-token",
      `--impersonate-service-account=${identity.serviceAccount}`, `--project=${project}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024, timeout: GCLOUD_READ_TIMEOUT_MS });
    const token = minted?.status === 0 ? String(minted.stdout).trim() : "";
    if (token.length === 0 || token.length > 16 * 1024 || !/^[\x21-\x7e]+$/u.test(token)) {
      fail("RESTORE_REHEARSAL_IMPERSONATION_FAILED");
    }
    return { access_token: token, expiry_date: Date.now() + TOKEN_LIFETIME_MS };
  };
  const auth = new OAuth2Client();
  auth.setCredentials(mint());
  auth.refreshHandler = async () => mint();
  const connector = new Connector({ auth });
  let pool;
  try {
    const options = await connector.getOptions({ instanceConnectionName: connectionName, authType: "IAM", ipType: "PUBLIC" });
    pool = new pg.Pool({
      ...options,
      user: identity.iamUser,
      database,
      max: 1,
      connectionTimeoutMillis: 30_000,
      idleTimeoutMillis: 30_000,
      application_name: "tibotattle-restore-rehearsal",
      options: "-c default_transaction_read_only=on",
    });
    pool.on("error", () => {});
  } catch {
    await pool?.end().catch(() => {});
    connector.close();
    fail("RESTORE_REHEARSAL_CONNECTION_FAILED");
  }
  return Object.freeze({
    pool,
    async close() {
      await pool.end().catch(() => {});
      connector.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Rehearsal

function rehearsalError(code, receipt) {
  return Object.assign(new GcpOpsInfraError(code), { receipt: deepFreeze(receipt) });
}

async function withPool(connect, spec, use) {
  let handle;
  try {
    handle = await connect(spec);
  } catch (error) {
    if (error instanceof GcpOpsInfraError) throw error;
    fail("RESTORE_REHEARSAL_CONNECTION_FAILED");
  }
  try {
    return await use(handle.pool);
  } finally {
    await handle.close?.();
  }
}

/** RFC 3339 UTC at a whole second, rounded up. */
function wholeSecondTime(ms) {
  return new Date(Math.ceil(ms / 1_000) * 1_000).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/** Sleeps until `targetMs` by the injected clock; a clock that never gets there is refused. */
async function sleepUntil(targetMs, { now, sleep }) {
  for (let attempt = 0; attempt < SLEEP_UNTIL_ATTEMPTS; attempt += 1) {
    const remaining = targetMs - now();
    if (remaining <= 0) return;
    await sleep(remaining);
  }
  if (now() < targetMs) fail("RESTORE_REHEARSAL_CLOCK_STALLED");
}

/** One operation's state: done (with or without an error) or not yet. */
function operationState(call, argv, operation) {
  const described = call(argv.describeOperation(operation));
  if (!isRecord(described) || described.name !== operation) fail("GCLOUD_OUTPUT_INVALID:sql-operations-describe");
  return {
    done: described.status === "DONE",
    errored: isRecord(described.error) && Array.isArray(described.error.errors) && described.error.errors.length > 0,
  };
}

/**
 * Polls one submitted operation until it is DONE, within the step's bound
 * (OPERATION_WAIT_BOUNDS_MS). `pending` holds every operation of this run not
 * yet seen DONE, so teardown can wait for it before patching.
 */
async function waitForOperation(call, argv, submitted, { step, pending, now, sleep }) {
  if (submitted.operation === null) fail(`RESTORE_REHEARSAL_OPERATION_UNKNOWN:${step}`);
  pending.add(submitted.operation);
  const started = now();
  let interval = OPERATION_POLL_INITIAL_MS;
  for (;;) {
    const { done, errored } = operationState(call, argv, submitted.operation);
    if (done) {
      pending.delete(submitted.operation);
      if (errored) fail(`RESTORE_REHEARSAL_OPERATION_FAILED:${step}`);
      return;
    }
    if (now() - started >= OPERATION_WAIT_BOUNDS_MS[step]) fail(`RESTORE_REHEARSAL_OPERATION_TIMEOUT:${step}`);
    await sleep(interval);
    interval = Math.min(interval * 2, OPERATION_POLL_CEILING_MS);
  }
}

/** Whose a scratch is, by its labels: this rehearsal's, unlabelled, or foreign. */
function scratchOwnership(described, rehearsalId) {
  const labels = isRecord(described?.settings?.userLabels) ? described.settings.userLabels : {};
  const purpose = labels[REHEARSAL_LABELS.purpose];
  const id = labels[REHEARSAL_LABELS.id];
  if (purpose === REHEARSAL_LABEL_PURPOSE && id === rehearsalId) return "labelled";
  if (purpose === undefined && id === undefined) return "unlabelled";
  return "foreign";
}

/**
 * What each teardown mode deletes. `run`: this run's accepted create or clone
 * proved the scratch is its own (a PITR clone is unlabelled until its label
 * step). `labelled`: cleanup. `adopt-unlabelled`: cleanup of a PITR clone whose
 * label step never ran, with its own authorization.
 */
const TEARDOWN_OWNERSHIP = Object.freeze({
  run: Object.freeze(["labelled", "unlabelled"]),
  labelled: Object.freeze(["labelled"]),
  "adopt-unlabelled": Object.freeze(["labelled", "unlabelled"]),
});

function checkOwnership(described, target, rehearsalId, mode) {
  if (!isRecord(described) || described.name !== target.scratch) fail("RESTORE_REHEARSAL_SCRATCH_DESCRIBE_INVALID");
  const ownership = scratchOwnership(described, rehearsalId);
  if (!TEARDOWN_OWNERSHIP[mode].includes(ownership)) fail("RESTORE_REHEARSAL_SCRATCH_NOT_OWNED");
  return ownership;
}

/**
 * Waits, within SCRATCH_SETTLE_BOUND_MS, until the scratch can be patched: gone
 * (returns null), or in a settled state with no operation of this run still
 * pending and none listed on it as unfinished. Cloud SQL refuses a patch while
 * another operation runs, so teardown never tries one earlier.
 */
async function settleScratch(call, target, argv, { pending, now, sleep }) {
  const started = now();
  let interval = OPERATION_POLL_INITIAL_MS;
  for (;;) {
    if (!scratchListed(call(argv.listScratch()), target.scratch)) return null;
    const described = call(argv.describe(target.scratch));
    if (!isRecord(described) || described.name !== target.scratch) fail("RESTORE_REHEARSAL_SCRATCH_DESCRIBE_INVALID");
    let busy = !SETTLED_STATES.includes(described.state);
    for (const operation of [...pending]) {
      if (operationState(call, argv, operation).done) pending.delete(operation);
      else busy = true;
    }
    const operations = call(argv.listScratchOperations());
    if (!Array.isArray(operations)) fail("GCLOUD_OUTPUT_INVALID:sql-operations-list");
    if (operations.some((entry) => !isRecord(entry) || entry.status !== "DONE")) busy = true;
    if (!busy) return described;
    if (now() - started >= SCRATCH_SETTLE_BOUND_MS) fail("RESTORE_REHEARSAL_SCRATCH_BUSY");
    await sleep(interval);
    interval = Math.min(interval * 2, OPERATION_POLL_CEILING_MS);
  }
}

/**
 * Checks ownership, waits for the scratch to settle, patches it so that
 * deleting it keeps nothing, reads that back, deletes it, and reads back that
 * it and any final backup of it are gone. `ownership` is a TEARDOWN_OWNERSHIP
 * mode; a scratch that mode does not cover is refused before any wait or
 * mutation.
 */
async function teardownScratch(call, target, argv, { rehearsalId, ownership: mode, pending = new Set(), now, sleep,
  steps }) {
  const started = now();
  const absent = () => {
    steps.push({ step: "teardown", outcome: "already-absent" });
    return { scratchDeleted: true, alreadyAbsent: true, ownership: null, finalBackups: "not-checked",
      ms: now() - started };
  };
  if (!scratchListed(call(argv.listScratch()), target.scratch)) return absent();
  checkOwnership(call(argv.describe(target.scratch)), target, rehearsalId, mode);
  const settleStarted = now();
  const settled = await settleScratch(call, target, argv, { pending, now, sleep });
  if (settled === null) return absent();
  const ownership = checkOwnership(settled, target, rehearsalId, mode);
  steps.push({ step: "settle", outcome: "done", ms: now() - settleStarted });
  const disarmStarted = now();
  await waitForOperation(call, argv, call(argv.disarm()), { step: "disarm", pending, now, sleep });
  steps.push({ step: "disarm", outcome: "done", ms: now() - disarmStarted });
  const facts = instanceFacts(call(argv.describe(target.scratch)), { name: target.scratch, project: target.project,
    region: target.region }, "RESTORE_REHEARSAL_SCRATCH_DESCRIBE_INVALID");
  if (facts.deletionProtectionEnabled || facts.finalBackupEnabled || facts.retainBackupsOnDelete) {
    fail("RESTORE_REHEARSAL_TEARDOWN_SETTINGS_UNSAFE");
  }
  const deleteStarted = now();
  await waitForOperation(call, argv, call(argv.delete()), { step: "delete", pending, now, sleep });
  steps.push({ step: "delete", outcome: "done", ms: now() - deleteStarted });
  if (scratchListed(call(argv.listScratch()), target.scratch)) fail("RESTORE_REHEARSAL_SCRATCH_STILL_PRESENT");
  let finalBackups = "unavailable";
  try {
    const backups = call(argv.listScratchBackups());
    if (Array.isArray(backups)) {
      finalBackups = backups.some((entry) => isRecord(entry) && entry.instance === target.scratch) ? "found" : "none-found";
    }
  } catch {
    finalBackups = "unavailable";
  }
  if (finalBackups === "found") fail("RESTORE_REHEARSAL_SCRATCH_BACKUP_REMAINS");
  return { scratchDeleted: true, alreadyAbsent: false, ownership, finalBackups, ms: now() - started };
}

const STEP_TIMINGS = Object.freeze({ clone: "cloneMs", label: "labelMs", create: "createMs", restore: "restoreBackupMs" });

/**
 * Runs an authorized staging rehearsal. Reads first (refusing before any
 * mutation), then restores, verifies, runs the injected do-not-restore step,
 * and tears the scratch down once this run's create or clone was accepted.
 * Returns the content-free receipt; a failure carries the receipt so far.
 */
export async function runRestoreRehearsal(desired, requestInput, {
  authorize,
  runner = defaultRehearsalRunner,
  connect = (spec) => openCloudSqlReadOnlyPool(spec),
  doNotRestore = null,
  readMigrations = () => readPostgresMigrations({ role: "primary" }),
  now = Date.now,
  sleep = (ms) => new Promise((wake) => setTimeout(wake, ms)),
  randomKey = () => randomBytes(32).toString("hex"),
} = {}) {
  const startedAt = now();
  const plan = planRestoreRehearsal(desired, requestInput, { nowMs: startedAt });
  const { target, request } = plan;
  if (target.environment !== "staging") fail("RESTORE_REHEARSAL_PRODUCTION_PLAN_ONLY");
  if (authorize !== plan.authorization) fail("RESTORE_REHEARSAL_AUTHORIZATION_MISMATCH");
  if (doNotRestore !== null && typeof doNotRestore?.reapply !== "function") fail("RESTORE_REHEARSAL_DO_NOT_RESTORE_INVALID");
  const migrations = await readMigrations();
  const call = guardedRehearsalGcloud(runner, target);
  const argv = rehearsalArgv(target);
  const key = randomKey();
  const sourceSpec = { role: "source", connectionName: target.sourceConnectionName, database: target.database,
    identity: target.identity, project: target.project };
  const scratchSpec = { ...sourceSpec, role: "scratch", connectionName: target.scratchConnectionName };
  const fingerprint = (spec, onSession) => withPool(connect, spec, (pool) => fingerprintDatabase(pool, {
    database: target.database, schema: target.schema, sampleRows: request.sampleRows, key, onSession }));
  const afterPreflight = request.pointInTime === POINT_IN_TIME_AFTER_PREFLIGHT;

  // 1. Preflight: reads only. Nothing exists to clean up if any of this fails.
  const source = instanceFacts(call(argv.describe(target.source)), { name: target.source, project: target.project,
    region: target.region }, "RESTORE_REHEARSAL_SOURCE_DESCRIBE_INVALID");
  if (source.state !== "RUNNABLE") fail("RESTORE_REHEARSAL_SOURCE_NOT_RUNNABLE");
  if (source.databaseVersion !== CLOUD_SQL_POSTURE.databaseVersion) fail("RESTORE_REHEARSAL_SOURCE_VERSION_UNEXPECTED");
  if (scratchListed(call(argv.listScratch()), target.scratch)) fail("RESTORE_REHEARSAL_SCRATCH_EXISTS");
  let backupPoint = null;
  if (request.path === "pitr") {
    if (!source.pointInTimeRecoveryEnabled || source.transactionLogRetentionDays === null) {
      fail("RESTORE_REHEARSAL_SOURCE_PITR_DISABLED");
    }
    const earliest = startedAt - source.transactionLogRetentionDays * DAY_MS + PITR_RETENTION_MARGIN_MS;
    if (!afterPreflight && Date.parse(request.pointInTime) < earliest) {
      fail("RESTORE_REHEARSAL_POINT_IN_TIME_OUTSIDE_RETENTION");
    }
  } else {
    const backup = call(argv.describeBackup(request.backupId));
    if (!isRecord(backup) || String(backup.id) !== request.backupId || backup.instance !== target.source) {
      fail("RESTORE_REHEARSAL_BACKUP_INVALID");
    }
    if (backup.status !== "SUCCESSFUL") fail("RESTORE_REHEARSAL_BACKUP_NOT_SUCCESSFUL");
    if (source.dataDiskSizeGb !== null && source.dataDiskSizeGb > desired.cloudSql.storageSizeGb) {
      fail("RESTORE_REHEARSAL_SOURCE_DISK_EXCEEDS_PLAN");
    }
    backupPoint = {
      backupType: typeof backup.type === "string" ? backup.type : null,
      windowStartTime: typeof backup.windowStartTime === "string" ? backup.windowStartTime : null,
      endTime: typeof backup.endTime === "string" ? backup.endTime : null,
    };
  }
  const sourceBefore = await fingerprint(sourceSpec);
  const sourceBeforeEnd = now();
  if (sourceBefore.history === null) fail("RESTORE_REHEARSAL_SOURCE_HISTORY_ABSENT");
  // The recovery point is covered by this run's source reads only when it is
  // after the first one (with a clock-skew margin): then a source unchanged
  // from that read to the closing read was unchanged since the recovery point.
  // A backup always predates the run.
  let pointInTime = null;
  let recoveryPoint;
  if (request.path === "pitr") {
    pointInTime = afterPreflight ? wholeSecondTime(sourceBeforeEnd + AFTER_PREFLIGHT_MARGIN_MS) : request.pointInTime;
    recoveryPoint = {
      kind: "point-in-time",
      mode: afterPreflight ? POINT_IN_TIME_AFTER_PREFLIGHT : "explicit",
      at: pointInTime,
      coveredBySourceReads: Date.parse(pointInTime) >= sourceBeforeEnd + AFTER_PREFLIGHT_MARGIN_MS,
    };
  } else {
    recoveryPoint = { kind: "backup", ...backupPoint, coveredBySourceReads: false };
  }

  // 2. Restore into the scratch, verify, run the do-not-restore step.
  const steps = [];
  const timings = { pointInTimeWaitMs: null, restoreMs: null, cloneMs: null, labelMs: null, createMs: null,
    restoreBackupMs: null, readyMs: null, verifyMs: null, teardownMs: null, totalMs: null };
  const receipt = {
    schema: RESTORE_REHEARSAL_RECEIPT_SCHEMA,
    status: "running",
    environment: target.environment,
    project: target.project,
    region: target.region,
    source: target.source,
    scratch: target.scratch,
    path: request.path,
    planDigest: plan.planDigest,
    authorization: plan.authorization,
    recoveryPoint,
    sourceSettings: { tier: source.tier, databaseVersion: source.databaseVersion,
      pointInTimeRecoveryEnabled: source.pointInTimeRecoveryEnabled,
      transactionLogRetentionDays: source.transactionLogRetentionDays },
    steps,
    timings,
    scratchSettings: null,
    verification: null,
    manifest: null,
    doNotRestore: null,
    uploadsMayReopen: false,
    uploadsBlockedBy: [],
    teardown: null,
  };
  const pending = new Set();
  // Armed only by an accepted create or clone whose operation did not fail:
  // Cloud SQL refuses a name that exists, so that scratch is this run's.
  let teardownArmed = false;
  // A create or clone that was refused, failed, or returned no operation:
  // whatever carries the name is not provably this run's.
  let creationUnproven = false;
  let failure = null;
  try {
    if (pointInTime !== null) {
      // Cloud SQL clones only to a point at least a minute in the past.
      const waitStarted = now();
      await sleepUntil(Date.parse(pointInTime) + PITR_MIN_AGE_MS, { now, sleep });
      timings.pointInTimeWaitMs = now() - waitStarted;
    }
    const restoreSteps = request.path === "pitr"
      ? [{ step: "clone", argv: argv.clone(pointInTime), creates: true },
        { step: "label", argv: argv.label(request.rehearsalId), creates: false }]
      : [{ step: "create", argv: argv.create(desired, request.rehearsalId), creates: true },
        { step: "restore", argv: argv.restore(request.backupId), creates: false }];
    const mutationStarted = now();
    for (const { step, argv: stepArgv, creates } of restoreSteps) {
      const stepStarted = now();
      let submitted;
      try {
        submitted = call(stepArgv);
      } catch (error) {
        if (creates) creationUnproven = true;
        throw error;
      }
      if (creates) {
        if (submitted.operation === null) {
          creationUnproven = true;
          fail(`RESTORE_REHEARSAL_OPERATION_UNKNOWN:${step}`);
        }
        teardownArmed = true;
      }
      try {
        await waitForOperation(call, argv, submitted, { step, pending, now, sleep });
      } catch (error) {
        if (creates && error?.code === `RESTORE_REHEARSAL_OPERATION_FAILED:${step}`) {
          teardownArmed = false;
          creationUnproven = true;
        }
        throw error;
      }
      const ms = now() - stepStarted;
      steps.push({ step, outcome: "done", ms });
      timings[STEP_TIMINGS[step]] = ms;
    }
    timings.restoreMs = now() - mutationStarted;
    let facts = null;
    for (let attempt = 0; attempt < READY_POLL_ATTEMPTS; attempt += 1) {
      facts = instanceFacts(call(argv.describe(target.scratch)), { name: target.scratch, project: target.project,
        region: target.region }, "RESTORE_REHEARSAL_SCRATCH_DESCRIBE_INVALID");
      if (facts.state === "RUNNABLE") break;
      await sleep(READY_POLL_INTERVAL_MS);
    }
    if (facts?.state !== "RUNNABLE") fail("RESTORE_REHEARSAL_SCRATCH_NOT_READY");
    if (facts.labels[REHEARSAL_LABELS.id] !== request.rehearsalId) fail("RESTORE_REHEARSAL_SCRATCH_LABELS_MISSING");
    receipt.scratchSettings = { state: facts.state, databaseVersion: facts.databaseVersion, tier: facts.tier,
      authorizedNetworks: facts.authorizedNetworks, labelled: true };
    const verifyStarted = now();
    // Ready: the scratch is RUNNABLE and a database session opened on it.
    const scratch = await fingerprint(scratchSpec, () => { timings.readyMs = now() - mutationStarted; });
    // A write committed before the point in time has reached the statistics.
    if (pointInTime !== null) await sleepUntil(Date.parse(pointInTime) + STATS_FLUSH_MARGIN_MS, { now, sleep });
    const sourceAfter = await fingerprint(sourceSpec);
    timings.verifyMs = now() - verifyStarted;
    receipt.verification = compareFingerprints({ sourceBefore, sourceAfter, scratch,
      recoveryPointCovered: recoveryPoint.coveredBySourceReads });
    receipt.manifest = manifestRelation(scratch.history, migrations);
    if (receipt.verification.verdict !== "passed") {
      receipt.doNotRestore = { status: "skipped", code: "RESTORE_VERIFICATION_NOT_PASSED" };
    } else if (doNotRestore === null) {
      receipt.doNotRestore = { status: "not-provided", code: "DO_NOT_RESTORE_STEP_NOT_PROVIDED" };
    } else {
      try {
        receipt.doNotRestore = doNotRestoreOutcome(await doNotRestore.reapply(deepFreeze({
          environment: target.environment,
          project: target.project,
          region: target.region,
          instance: target.scratch,
          connectionName: target.scratchConnectionName,
          database: target.database,
          schema: target.schema,
        })));
      } catch {
        receipt.doNotRestore = { status: "failed", code: "DO_NOT_RESTORE_STEP_FAILED" };
      }
    }
  } catch (error) {
    failure = error instanceof GcpOpsInfraError ? error.code : "RESTORE_REHEARSAL_FAILED";
  }

  // 3. Teardown, only of a scratch this run provably made.
  if (teardownArmed) {
    try {
      receipt.teardown = { armed: true, ...await teardownScratch(call, target, argv, {
        rehearsalId: request.rehearsalId, ownership: "run", pending, now, sleep, steps }) };
      timings.teardownMs = receipt.teardown.ms;
    } catch (error) {
      const code = error instanceof GcpOpsInfraError ? error.code : "RESTORE_REHEARSAL_TEARDOWN_FAILED";
      // A remaining backup is found only after the delete succeeded.
      receipt.teardown = { armed: true, scratchDeleted: code === "RESTORE_REHEARSAL_SCRATCH_BACKUP_REMAINS", code };
      failure ??= code;
    }
  } else if (creationUnproven) {
    // Another run may hold the name, or gcloud failed after sending: report
    // whether an instance carries the name, and never touch it.
    let scratchPresent = null;
    try {
      scratchPresent = scratchListed(call(argv.listScratch()), target.scratch);
    } catch {
      scratchPresent = null;
    }
    receipt.teardown = { armed: false, scratchPresent };
    if (scratchPresent !== false) {
      receipt.teardown.code = scratchPresent === true ? "RESTORE_REHEARSAL_SCRATCH_OWNERSHIP_UNPROVEN"
        : "RESTORE_REHEARSAL_SCRATCH_PRESENCE_UNKNOWN";
    }
  }
  timings.totalMs = now() - startedAt;

  const blockedBy = [];
  if (receipt.verification?.verdict !== "passed") blockedBy.push("RESTORE_VERIFICATION_NOT_PASSED");
  if (receipt.manifest?.relation === "behind") blockedBy.push("RESTORE_MIGRATION_BEHIND");
  else if (receipt.manifest !== null && receipt.manifest.relation !== "equal") blockedBy.push("RESTORE_MIGRATION_STATE_INVALID");
  if (receipt.doNotRestore?.status !== "done") {
    blockedBy.push(receipt.doNotRestore?.status === "not-provided" ? "DO_NOT_RESTORE_STEP_NOT_PROVIDED"
      : "DO_NOT_RESTORE_STEP_NOT_DONE");
  }
  receipt.uploadsBlockedBy = blockedBy;
  // The only place uploadsMayReopen can become true.
  receipt.uploadsMayReopen = failure === null && blockedBy.length === 0 && receipt.doNotRestore?.status === "done"
    && receipt.verification?.verdict === "passed" && receipt.manifest?.relation === "equal";
  if (failure !== null) {
    receipt.status = "failed";
    receipt.code = failure;
    throw rehearsalError(failure, receipt);
  }
  receipt.status = receipt.verification.verdict === "passed" ? "verified" : `verification_${receipt.verification.verdict}`;
  return deepFreeze(receipt);
}

/** Exit code for a completed rehearsal receipt. */
export function rehearsalExitCode(receipt) {
  if (receipt.verification?.verdict !== "passed") return EXIT_CODES.verificationFailed;
  return receipt.uploadsMayReopen === true ? EXIT_CODES.uploadsMayReopen : EXIT_CODES.uploadsBlocked;
}

/**
 * Deletes one scratch left by an interrupted run: one carrying this
 * rehearsal's labels, or with `adoptUnlabelled` (PITR path only, its own
 * authorization) one with no rehearsal labels at all, a clone whose label step
 * never ran. Waits for it to settle first, within SCRATCH_SETTLE_BOUND_MS.
 */
export async function cleanupRehearsalScratch(desired, { environment, path, rehearsalId, authorize,
  adoptUnlabelled = false, runner = defaultRehearsalRunner, now = Date.now,
  sleep = (ms) => new Promise((wake) => setTimeout(wake, ms)) } = {}) {
  if (environment !== "staging") fail("RESTORE_REHEARSAL_PRODUCTION_PLAN_ONLY");
  if (typeof adoptUnlabelled !== "boolean") fail("RESTORE_REHEARSAL_ARGUMENT_INVALID");
  const target = rehearsalTarget(desired, { environment, rehearsalId, path });
  if (adoptUnlabelled && path !== "pitr") fail("RESTORE_REHEARSAL_ADOPT_PATH_REFUSED");
  const expected = adoptUnlabelled ? adoptCleanupAuthorization(target) : cleanupAuthorization(target);
  if (authorize !== expected) fail("RESTORE_REHEARSAL_AUTHORIZATION_MISMATCH");
  const mode = adoptUnlabelled ? "adopt-unlabelled" : "labelled";
  const steps = [];
  const teardown = await teardownScratch(guardedRehearsalGcloud(runner, target), target, rehearsalArgv(target),
    { rehearsalId, ownership: mode, now, sleep, steps });
  return deepFreeze({ schema: RESTORE_REHEARSAL_RECEIPT_SCHEMA, status: "cleaned", environment, scratch: target.scratch,
    mode, steps, teardown });
}

// ---------------------------------------------------------------------------
// Receipt file

/** Reserves the receipt file before any mutation: exclusive, owner-only, never through a symlink. */
export async function reserveRehearsalReceipt(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("RESTORE_REHEARSAL_RECEIPT_PATH_INVALID");
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  } catch {
    fail("RESTORE_REHEARSAL_RECEIPT_PATH_UNAVAILABLE");
  }
  let settled = false;
  return Object.freeze({
    async write(receipt) {
      if (settled) fail("RESTORE_REHEARSAL_RECEIPT_WRITE_FAILED");
      settled = true;
      try {
        await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
      } catch {
        try { await handle.close(); } catch { /* keep the original outcome */ }
        fail("RESTORE_REHEARSAL_RECEIPT_WRITE_FAILED");
      }
    },
    async release() {
      if (settled) return;
      settled = true;
      try { await handle.close(); } catch { /* keep the original outcome */ }
      try { await unlink(path); } catch { /* only this run's own file */ }
    },
  });
}

// ---------------------------------------------------------------------------
// CLI

const COMMANDS = Object.freeze({
  rehearse: Object.freeze({
    flags: ["--environment", "--path", "--point-in-time", "--backup-id", "--rehearsal-id", "--sample-rows",
      "--authorize", "--receipt-out"],
    booleans: ["--apply", "--dry-run", "--production"],
  }),
  cleanup: Object.freeze({
    flags: ["--environment", "--path", "--rehearsal-id", "--authorize"],
    booleans: ["--apply", "--dry-run", "--production", "--adopt-unlabelled"],
  }),
});

/** Closed argument parsing; refusals that need no desired state happen here. */
export function parseRehearsalArgs(argv) {
  if (!Array.isArray(argv) || !Object.hasOwn(COMMANDS, argv[0])) fail("RESTORE_REHEARSAL_COMMAND_INVALID");
  const command = argv[0];
  const { flags, booleans } = COMMANDS[command];
  const values = new Map();
  for (const argument of argv.slice(1)) {
    if (typeof argument !== "string") fail("RESTORE_REHEARSAL_ARGUMENT_INVALID");
    if (booleans.includes(argument)) {
      if (values.has(argument)) fail("RESTORE_REHEARSAL_ARGUMENT_INVALID");
      values.set(argument, true);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    const value = separator < 0 ? "" : argument.slice(separator + 1);
    if (!flags.includes(name) || value.length === 0 || values.has(name)) fail("RESTORE_REHEARSAL_ARGUMENT_INVALID");
    values.set(name, value);
  }
  const environment = values.get("--environment");
  if (!RESTORE_REHEARSAL_ENVIRONMENTS.includes(environment)) fail("RESTORE_REHEARSAL_ENVIRONMENT_REFUSED");
  const production = values.get("--production") === true;
  if (environment === "production" && !production) fail("RESTORE_REHEARSAL_PRODUCTION_FLAG_REQUIRED");
  if (environment !== "production" && production) fail("RESTORE_REHEARSAL_ARGUMENT_INVALID");
  const apply = values.get("--apply") === true;
  if (apply && values.get("--dry-run") === true) fail("RESTORE_REHEARSAL_ARGUMENT_INVALID");
  if (environment === "production" && (apply || command === "cleanup" || values.has("--authorize"))) {
    fail("RESTORE_REHEARSAL_PRODUCTION_PLAN_ONLY");
  }
  if (apply !== values.has("--authorize")) fail("RESTORE_REHEARSAL_AUTHORIZATION_REQUIRED");
  const path = values.get("--path");
  if (!RESTORE_REHEARSAL_PATHS.includes(path)) fail("RESTORE_REHEARSAL_PATH_INVALID");
  const rehearsalId = values.get("--rehearsal-id") ?? null;
  if (rehearsalId !== null && !REHEARSAL_ID_PATTERN.test(rehearsalId)) fail("RESTORE_REHEARSAL_ID_INVALID");
  if ((apply || command === "cleanup") && rehearsalId === null) fail("RESTORE_REHEARSAL_ID_INVALID");
  if (command === "cleanup") {
    const adoptUnlabelled = values.get("--adopt-unlabelled") === true;
    if (adoptUnlabelled && path !== "pitr") fail("RESTORE_REHEARSAL_ADOPT_PATH_REFUSED");
    return deepFreeze({ command, environment, path, rehearsalId, apply, adoptUnlabelled,
      authorize: values.get("--authorize") ?? null });
  }
  const pointInTime = values.get("--point-in-time") ?? null;
  const backupId = values.get("--backup-id") ?? null;
  if (path === "pitr" ? pointInTime === null || backupId !== null : backupId === null || pointInTime !== null) {
    fail("RESTORE_REHEARSAL_ARGUMENT_INVALID");
  }
  const sampleRowsText = values.get("--sample-rows");
  if (sampleRowsText !== undefined && !SAMPLE_ROWS.test(sampleRowsText)) fail("RESTORE_REHEARSAL_SAMPLE_ROWS_INVALID");
  const receiptOut = values.get("--receipt-out") ?? null;
  if (!apply && receiptOut !== null) fail("RESTORE_REHEARSAL_ARGUMENT_INVALID");
  if (receiptOut !== null && !isAbsolute(receiptOut)) fail("RESTORE_REHEARSAL_RECEIPT_PATH_INVALID");
  return deepFreeze({
    command,
    environment,
    production,
    apply,
    authorize: values.get("--authorize") ?? null,
    request: {
      environment,
      path,
      pointInTime,
      backupId,
      rehearsalId,
      sampleRows: sampleRowsText === undefined ? DEFAULT_SAMPLE_ROWS : Number(sampleRowsText),
    },
    receiptOut: receiptOut === null ? null : resolve(receiptOut),
  });
}

function dryRunDocument(plan, { generatedId }) {
  const { target: _target, request: _request, ...body } = plan;
  return deepFreeze({
    ...body,
    status: plan.environment === "staging" ? "dry_run" : "plan_only",
    authorization: plan.environment === "staging" ? plan.authorization : null,
    rehearsalIdGenerated: generatedId,
    // Only then can a scratch that differs be `failed` rather than `inconclusive`.
    recoveryPointCoveredBySourceReads: plan.path === "pitr" && plan.pointInTime === POINT_IN_TIME_AFTER_PREFLIGHT,
    doNotRestore: { status: "not-provided", code: "DO_NOT_RESTORE_STEP_NOT_PROVIDED",
      note: "No default list: custody of the do-not-restore list is decided after cutover (OA-9)." },
    uploadsMayReopen: false,
  });
}

/** CLI entry; returns the exit code. */
export async function main(argv = process.argv.slice(2), {
  runner = defaultRehearsalRunner,
  connect,
  loadDesired = (environment) => loadCommittedDesiredState(environment),
  reserveReceipt = reserveRehearsalReceipt,
  now = Date.now,
  sleep,
  randomId = () => randomBytes(5).readUIntBE(0, 5).toString(36).padStart(8, "0").slice(-8),
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  const print = (value) => stdout(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const config = parseRehearsalArgs(argv);
    const desired = loadDesired(config.environment);
    if (config.command === "cleanup") {
      const target = rehearsalTarget(desired, config);
      if (!config.apply) {
        const argvFor = rehearsalArgv(target);
        print({ schema: RESTORE_REHEARSAL_RECEIPT_SCHEMA, status: "dry_run", command: "cleanup",
          environment: target.environment, scratch: target.scratch,
          mode: config.adoptUnlabelled ? "adopt-unlabelled" : "labelled",
          deletes: config.adoptUnlabelled
            ? "the scratch if it carries no rehearsal labels or this rehearsal's labels"
            : "the scratch only if it carries this rehearsal's labels",
          authorization: config.adoptUnlabelled ? adoptCleanupAuthorization(target) : cleanupAuthorization(target),
          settleBoundMs: SCRATCH_SETTLE_BOUND_MS,
          calls: [argvFor.listScratch(), argvFor.describe(target.scratch), argvFor.listScratchOperations(),
            argvFor.disarm(), argvFor.describeOperation("{operation}"), argvFor.describe(target.scratch),
            argvFor.delete(), argvFor.describeOperation("{operation}"), argvFor.listScratch(),
            argvFor.listScratchBackups()] });
        return 0;
      }
      print(await cleanupRehearsalScratch(desired, { ...config, runner, now,
        ...(sleep === undefined ? {} : { sleep }) }));
      return 0;
    }
    if (!config.apply) {
      const generatedId = config.request.rehearsalId === null;
      const request = generatedId ? { ...config.request, rehearsalId: randomId() } : config.request;
      print(dryRunDocument(planRestoreRehearsal(desired, request, { nowMs: now() }), { generatedId }));
      return 0;
    }
    const plan = planRestoreRehearsal(desired, config.request, { nowMs: now() });
    if (config.authorize !== plan.authorization) fail("RESTORE_REHEARSAL_AUTHORIZATION_MISMATCH");
    const reservation = config.receiptOut === null ? null : await reserveReceipt(config.receiptOut);
    let receipt;
    try {
      receipt = await runRestoreRehearsal(desired, config.request, {
        authorize: config.authorize, runner, now,
        ...(connect === undefined ? {} : { connect }),
        ...(sleep === undefined ? {} : { sleep }),
      });
    } catch (error) {
      if (error?.receipt !== undefined && reservation !== null) {
        try { await reservation.write(error.receipt); } catch { /* the error below still reports */ }
      } else {
        await reservation?.release();
      }
      throw error;
    }
    if (reservation !== null) await reservation.write(receipt);
    print(receipt);
    return rehearsalExitCode(receipt);
  } catch (error) {
    const code = error instanceof GcpOpsInfraError ? error.code : "RESTORE_REHEARSAL_FAILED";
    stderr(`${JSON.stringify({ status: "error", code, ...(error?.receipt === undefined ? {} : { receipt: error.receipt }) })}\n`);
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
