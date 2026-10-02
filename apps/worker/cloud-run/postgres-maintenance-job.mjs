#!/usr/bin/env node

/**
 * postgres-maintenance-job: the MP-2-lite maintenance Cloud Run Job (build
 * entry "postgres-maintenance-job" -> dist/postgres-maintenance-job.mjs).
 *
 * One execution runs one runPostgresLifecyclePass
 * (src/postgres-lifecycle-pass.ts) for the current one-minute cycle: the
 * lifecycle row, then one page of up to 100 quarantine registrations (the
 * Worker's batch), under the shared maintenance advisory lock and the primary
 * migration fence. That pass is what lets GET /api/ready on the origin read
 * 'ready' (owner decision OD-CR-4). It is a separate workload from the
 * request-serving origin: it has no HOST_MODE and serves nothing.
 *
 * Schedule (the D-OPS4 trigger contract): every minute,
 * POSTGRES_MAINTENANCE_JOB_SCHEDULE ('* * * * *'), the d43c8f92 Worker cron.
 * Throughput is then the Worker's: 100 due registrations per execution. Every
 * v1.0 and v1.1 upload leaves a registered pending object that only this pass
 * clears a safety window (24 h) later, so a slower trigger, or a sustained due
 * rate above 100 a minute, leaves /api/ready not_ready and lets the journal
 * grow. While a migration runs the pass is skipped; while a pass runs the
 * migration runner refuses POSTGRES_MIGRATION_CONFLICT (fail-closed,
 * retryable).
 *
 * Arguments (closed): --profile=maintenance-job | --profile=staging-maintenance-job
 * (required, no default), or --help. Anything else is a usage refusal.
 *
 * Environment (closed):
 *   - everything readProductionConfiguration(env, <profile>) requires, refuses
 *     and validates (postgres-production-configuration.mjs): CLOUD_RUN_JOB,
 *     DEPLOYMENT_SOURCE_COMMIT, TELEMETRY_STORAGE_NAMESPACE,
 *     PRIMARY_INSTANCE_CONNECTION_NAME, PRIMARY_DATABASE, PRIMARY_SCHEMA,
 *     POSTGRES_IAM_USER, GCS_BUCKET_NAME, POSTGRES_SCHEDULED_MAINTENANCE_ENABLED
 *     ('enabled', else the job stays dormant), the profile's secrets and, for
 *     the staging profile, the staging plane's origins and identity vars. The
 *     configuration refuses the test deployment's identities, retired ledger
 *     and erasure-proof settings and test seams;
 *   - GCS_QUARANTINE_BUCKET_HISTORY_PROOF (owner decision OD-2): the
 *     bucket-birth proof the GCS quarantine store needs for head() of a
 *     missing key and for delete(). The configuration parses it, once, as
 *     CR-3's resources.bucketHistoryProof: exactly the OPS-2 receipt's closed
 *     four-key proof record for GCS_BUCKET_NAME (no wrapper), with CR-3's
 *     codes (_MISSING when absent or empty, _INVALID otherwise, a bucket
 *     mismatch included). The job has no parser of its own;
 *   - refused here, even when empty: HOST_MODE and K_SERVICE (this is not the
 *     service), any PG_TEST_ variable (no local fallback endpoint) and any
 *     POSTGRES_MAINTENANCE_JOB_ variable (the job has no tunables).
 * The job reads no other variable. It reveals no secret: the profile's
 * secrets stay behind the configuration's opaque handles.
 *
 * Database: one Cloud SQL IAM pool on the primary instance with max 2
 * connections (the lock session plus one transaction). The pass refuses a
 * schema whose migration history is not exactly this image's manifest.
 *
 * Output: one content-free JSON receipt line on stdout, or one JSON error
 * line with a closed code on stderr. Exit 0 for complete, partial (a
 * reconciliation backlog above 100, drained by later executions) and skipped
 * (another maintenance run holds the lock, or a migration holds the fence);
 * 1 for refused, failure or configuration; 2 for a usage refusal.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { createGcsQuarantineObjectStore } from "../src/gcs-quarantine-object-store.ts";
import { runPostgresLifecyclePass } from "../src/postgres-lifecycle-pass.ts";
import { POSTGRES_RUNTIME_MIGRATIONS } from "../src/postgres-runtime-schema.ts";
import {
  closeCloudSqlResources,
  createGoogleAccessTokenProvider,
  createIamPool,
} from "./cloud-sql.mjs";
import { readProductionConfiguration } from "./postgres-production-configuration.mjs";

export const POSTGRES_MAINTENANCE_JOB_ENTRY = "postgres-maintenance-job";
export const POSTGRES_MAINTENANCE_JOB_RECEIPT_VERSION = "postgres-maintenance-job-v1";
export const POSTGRES_MAINTENANCE_JOB_PROFILES = Object.freeze(["maintenance-job", "staging-maintenance-job"]);
/** The lock session plus one transaction. */
export const POSTGRES_MAINTENANCE_JOB_POOL_MAX = 2;
/** Cycles are whole UTC minutes, the Worker cron's scheduledTime granularity. */
export const POSTGRES_MAINTENANCE_JOB_CYCLE_MILLISECONDS = 60_000;
export const POSTGRES_MAINTENANCE_JOB_APPLICATION_NAME = "tibotattle-maintenance-job";
/** The trigger schedule the D-OPS4 Scheduler must use: every minute, as the Worker cron. */
export const POSTGRES_MAINTENANCE_JOB_SCHEDULE = "* * * * *";
/** Variables the job refuses even when empty, and the code each gives. */
export const POSTGRES_MAINTENANCE_JOB_FORBIDDEN_VARIABLES = Object.freeze({
  HOST_MODE: "POSTGRES_MAINTENANCE_JOB_HOST_MODE_FORBIDDEN",
  K_SERVICE: "POSTGRES_MAINTENANCE_JOB_CONTEXT_INVALID",
});
export const POSTGRES_MAINTENANCE_JOB_FORBIDDEN_PREFIXES = Object.freeze({
  PG_TEST_: "POSTGRES_MAINTENANCE_JOB_LOCAL_ENDPOINT_FORBIDDEN",
  POSTGRES_MAINTENANCE_JOB_: "POSTGRES_MAINTENANCE_JOB_TUNABLE_FORBIDDEN",
});

export const POSTGRES_MAINTENANCE_JOB_USAGE = `Usage: node postgres-maintenance-job.mjs --profile=<maintenance-job|staging-maintenance-job>

Run one MP-2-lite lifecycle and quarantine-reconciliation pass for the current
one-minute cycle (up to 100 registrations). Cloud Run Jobs only, triggered
every minute (* * * * *). Exits 0 (complete, partial or skipped), 1 (refused,
failure or configuration) or 2 (usage refusal).

  --profile=<name>  maintenance-job or staging-maintenance-job (required)
  --help            print this text
`;

const FLAG = /^--([a-z][a-z-]*)=(.*)$/su;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const PASS_EXIT_CODES = Object.freeze({ complete: 0, partial: 0, skipped: 0, refused: 1, failure: 1 });
/** cloud-sql.mjs throws these constant messages without a `code`. */
const CLOUD_SQL_MESSAGES = new Set([
  "CLOUD_SQL_CONNECTOR_OPTIONS_FAILED",
  "CLOUD_SQL_CONNECTOR_CLOSE_FAILED",
  "POSTGRES_CONNECTION_FAILED",
  "POSTGRES_POOL_CLOSE_FAILED",
  "INSTANCE_CONNECTION_NAME_INVALID",
  "POSTGRES_DATABASE_INVALID",
  "POSTGRES_IAM_USER_MISSING",
  "POSTGRES_IAM_USER_INVALID",
  "GOOGLE_AUTH_CLIENT_FAILED",
]);

function fail(code, extra = {}) {
  throw Object.assign(new Error(code), { code, ...extra });
}

function usageFail(code) {
  fail(code, { usage: true });
}

/** Parse the closed argument list: exactly one --profile, or --help alone. */
export function parsePostgresMaintenanceJobArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    usageFail("POSTGRES_MAINTENANCE_JOB_ARGUMENTS_INVALID");
  }
  if (argv.includes("--help")) {
    if (argv.length !== 1) usageFail("POSTGRES_MAINTENANCE_JOB_ARGUMENTS_INVALID");
    return Object.freeze({ help: true, profile: null });
  }
  let profile = null;
  for (const value of argv) {
    const match = FLAG.exec(value);
    if (match === null || match[1] !== "profile" || profile !== null) {
      usageFail("POSTGRES_MAINTENANCE_JOB_ARGUMENTS_INVALID");
    }
    profile = match[2];
  }
  if (profile === null) usageFail("POSTGRES_MAINTENANCE_JOB_PROFILE_MISSING");
  if (!POSTGRES_MAINTENANCE_JOB_PROFILES.includes(profile)) {
    usageFail("POSTGRES_MAINTENANCE_JOB_PROFILE_INVALID");
  }
  return Object.freeze({ help: false, profile });
}

function has(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name);
}

/** The job's own refusals, checked before the shared production configuration. */
export function assertPostgresMaintenanceJobEnvironment(env) {
  if (env === null || typeof env !== "object") fail("POSTGRES_MAINTENANCE_JOB_ENVIRONMENT_INVALID");
  for (const [name, code] of Object.entries(POSTGRES_MAINTENANCE_JOB_FORBIDDEN_VARIABLES)) {
    if (has(env, name)) fail(code);
  }
  const names = Object.keys(env);
  for (const [prefix, code] of Object.entries(POSTGRES_MAINTENANCE_JOB_FORBIDDEN_PREFIXES)) {
    if (names.some((name) => name.startsWith(prefix))) fail(code);
  }
  if (typeof env.CLOUD_RUN_JOB !== "string" || env.CLOUD_RUN_JOB.length === 0) {
    fail("POSTGRES_MAINTENANCE_JOB_CONTEXT_INVALID");
  }
}

/**
 * Validate the whole environment for one profile and return the frozen
 * pieces the job composes from. Throws a coded Error; nothing is connected.
 */
export function readPostgresMaintenanceJobConfiguration(env, profile) {
  if (!POSTGRES_MAINTENANCE_JOB_PROFILES.includes(profile)) {
    usageFail("POSTGRES_MAINTENANCE_JOB_PROFILE_INVALID");
  }
  assertPostgresMaintenanceJobEnvironment(env);
  const configuration = readProductionConfiguration(env, profile);
  if (configuration.deployment.workload.kind !== "job"
      || configuration.jobSwitches.POSTGRES_SCHEDULED_MAINTENANCE_ENABLED !== "enabled") {
    fail("POSTGRES_MAINTENANCE_JOB_PROFILE_INVALID");
  }
  // OD-2: CR-3 parses the bucket-birth proof once (resources.bucketHistoryProof).
  const { primary, iamUser, bucket, bucketHistoryProof } = configuration.resources;
  if (bucketHistoryProof?.bucket !== bucket) fail("GCS_QUARANTINE_BUCKET_HISTORY_PROOF_INVALID");
  return Object.freeze({
    profile,
    plane: configuration.plane,
    primary,
    iamUser,
    bucket,
    historyProof: bucketHistoryProof,
  });
}

/** The cycle instant: the start of the UTC minute of `epoch`. */
export function postgresMaintenanceJobCycle(epoch) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) fail("POSTGRES_MAINTENANCE_JOB_CLOCK_INVALID");
  return epoch - (epoch % POSTGRES_MAINTENANCE_JOB_CYCLE_MILLISECONDS);
}

/**
 * A closed code for output: an uppercase constant `code`, or one of
 * cloud-sql.mjs's constant messages. Any other message never reaches output.
 */
export function safePostgresMaintenanceJobCode(error) {
  const code = error?.code;
  if (typeof code === "string" && SAFE_CODE.test(code)) return code;
  if (error instanceof Error && CLOUD_SQL_MESSAGES.has(error.message)) return error.message;
  return "POSTGRES_MAINTENANCE_JOB_FAILED";
}

/**
 * Run the job. Dependencies are injectable for local qualification:
 * createConnector(), createIamPool(options), createAccessTokenProvider() and
 * createObjectStore(bucket, accessToken, historyProof). Returns
 * { status: 'help' } or { receipt, exitCode }; configuration and usage
 * refusals throw a coded Error.
 */
export async function runPostgresMaintenanceJob({
  argv = process.argv.slice(2),
  env = process.env,
  dependencies = {},
  now = Date.now,
} = {}) {
  const args = parsePostgresMaintenanceJobArguments(argv);
  if (args.help) return Object.freeze({ status: "help" });
  const configuration = readPostgresMaintenanceJobConfiguration(env, args.profile);
  const cycleEpoch = postgresMaintenanceJobCycle(now());
  const connector = typeof dependencies.createConnector === "function"
    ? dependencies.createConnector()
    : new Connector();
  const pools = [];
  try {
    const pool = await (dependencies.createIamPool ?? createIamPool)({
      connector,
      instanceConnectionName: configuration.primary.instanceConnectionName,
      database: configuration.primary.database,
      user: configuration.iamUser,
      max: POSTGRES_MAINTENANCE_JOB_POOL_MAX,
      applicationName: POSTGRES_MAINTENANCE_JOB_APPLICATION_NAME,
    });
    pools.push(pool);
    const accessToken = await (dependencies.createAccessTokenProvider ?? createGoogleAccessTokenProvider)();
    const objectStore = typeof dependencies.createObjectStore === "function"
      ? dependencies.createObjectStore(configuration.bucket, accessToken, configuration.historyProof)
      : createGcsQuarantineObjectStore(
        configuration.bucket, accessToken, undefined, undefined, configuration.historyProof,
      );
    const pass = await runPostgresLifecyclePass({
      pool,
      objectStore,
      schema: { primarySchema: configuration.primary.schema },
      cycleEpoch,
      expectedPrimaryMigrations: POSTGRES_RUNTIME_MIGRATIONS.primary,
      clock: now,
    });
    const receipt = Object.freeze({
      schemaVersion: POSTGRES_MAINTENANCE_JOB_RECEIPT_VERSION,
      entry: POSTGRES_MAINTENANCE_JOB_ENTRY,
      profile: configuration.profile,
      status: pass.outcome,
      pass,
    });
    return Object.freeze({ receipt, exitCode: PASS_EXIT_CODES[pass.outcome] ?? 1 });
  } finally {
    await closeCloudSqlResources({ pools, connector });
  }
}

async function main() {
  try {
    const result = await runPostgresMaintenanceJob();
    if (result.status === "help") {
      process.stdout.write(POSTGRES_MAINTENANCE_JOB_USAGE);
      return;
    }
    process.stdout.write(`${JSON.stringify(result.receipt)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: POSTGRES_MAINTENANCE_JOB_RECEIPT_VERSION,
      entry: POSTGRES_MAINTENANCE_JOB_ENTRY,
      status: "failed",
      code: safePostgresMaintenanceJobCode(error),
    })}\n`);
    process.exitCode = error?.usage === true ? 2 : 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
