/**
 * The constants of the MP-2-lite maintenance Job's contract
 * (postgres-maintenance-job.mjs), in a leaf module so that tooling which only
 * needs the contract (OPS-2's job definition and its checks) imports them
 * without loading the job's database, object-store and lifecycle-pass
 * modules. The job imports and re-exports every name here, so
 * postgres-maintenance-job.mjs stays the public entry and this file stays the
 * single source.
 *
 * No imports, no process, filesystem or network access.
 */

export const POSTGRES_MAINTENANCE_JOB_ENTRY = "postgres-maintenance-job";
export const POSTGRES_MAINTENANCE_JOB_PROFILES = Object.freeze(["maintenance-job", "staging-maintenance-job"]);
/** The lock session plus one transaction. */
export const POSTGRES_MAINTENANCE_JOB_POOL_MAX = 2;
/** Cycles are whole UTC minutes, the Worker cron's scheduledTime granularity. */
export const POSTGRES_MAINTENANCE_JOB_CYCLE_MILLISECONDS = 60_000;
export const POSTGRES_MAINTENANCE_JOB_APPLICATION_NAME = "tibotattle-maintenance-job";
/** GCP cost-control cadence: one bounded pass every five minutes; Worker cron is separate. */
export const POSTGRES_MAINTENANCE_JOB_SCHEDULE = "*/5 * * * *";
/** Variables the job refuses even when empty, and the code each gives. */
export const POSTGRES_MAINTENANCE_JOB_FORBIDDEN_VARIABLES = Object.freeze({
  HOST_MODE: "POSTGRES_MAINTENANCE_JOB_HOST_MODE_FORBIDDEN",
  K_SERVICE: "POSTGRES_MAINTENANCE_JOB_CONTEXT_INVALID",
});
export const POSTGRES_MAINTENANCE_JOB_FORBIDDEN_PREFIXES = Object.freeze({
  PG_TEST_: "POSTGRES_MAINTENANCE_JOB_LOCAL_ENDPOINT_FORBIDDEN",
  POSTGRES_MAINTENANCE_JOB_: "POSTGRES_MAINTENANCE_JOB_TUNABLE_FORBIDDEN",
});
