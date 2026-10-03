/**
 * Infrastructure desired state for the Google Cloud service (OPS-2,
 * re-scoped for the fast path).
 *
 * Decision: scripted gcloud over a checked-in desired state, not Terraform.
 * The repository already proves Google Cloud resources with pinned targets,
 * argv-only gcloud calls and content-free receipts (gcp-test-bucket-history,
 * gcp-fastpath-test-deploy, OPS-1 gcp-backup-horizon); this follows that
 * pattern instead of adding a provider toolchain, a remote state file that
 * would hold resource attributes outside review, and a planner whose default
 * answer to drift is destroy-and-recreate. Here the live estate is the only
 * state: readback reads it with describe, get-iam-policy and list calls, the
 * plan is a canonical, digest-bound list of create and update commands, and
 * apply runs only that list under --authorize=<planDigest>. Nothing in this
 * tooling deletes, replaces a policy or edits bucket metadata or bucket IAM.
 *
 * The desired state is COMMITTED to the repository (owner decision
 * 2026-10-02): one file per environment under cloud-run/infra/
 * (COMMITTED_DESIRED_STATE_FILES), with a JSON Schema beside them for
 * editors and review. The files hold non-secret identifiers only; a secret
 * is named by its Secret Manager secret and a pinned version number, never
 * a value, and the validator refuses anything that looks like secret
 * material. The staging file describes a plane inside the shared GCP test
 * project (projectTenancy 'shared': co-tenant resources are neither managed
 * nor removed, and project-wide logging settings are left alone). The
 * production file names the dedicated project tibotattle-prod (OWN-5, filled
 * by PROD-PREP under owner decisions round 13); the validator still refuses
 * any file whose project, project number, region or bucket location is an
 * explicit null placeholder (DESIRED_STATE_PLACEHOLDER_UNFILLED).
 *
 * Topology: one Cloud SQL PostgreSQL 17 ENTERPRISE instance, zonal, with no
 * replica, no high availability and no deletion-ledger instance (append-only
 * decision record 2026-09-26, D2 and D4). Hostnames stay at the Cloudflare
 * edge (D5): the origin is the IAM-private Cloud Run service rendered from
 * EP-7's template, invoked only by the edge-invoker account and the
 * read-only verifier (OD-CR-7), whose ID tokens the operator mints through a
 * roles/iam.serviceAccountTokenCreator grant on the verifier alone. The fast
 * path renders exactly three Cloud Run Jobs (JOB_NAMES): the OPS-10 production
 * migration, the analytics-refresh job, in the production refresh-job
 * contract (ANALYTICS_REFRESH_JOB_CONTRACT, the dense task profile until
 * MEAS-3), and the MP-2-lite maintenance job (MAINTENANCE_JOB_CONTRACT, D-OPS4).
 * Two jobs have a Cloud Scheduler trigger. The analytics-refresh cadence is
 * the owner's (decision D3; there is no default). The maintenance cadence is
 * the Worker cron's, every minute, and the validator pins it
 * (PINNED_SCHEDULER_CADENCES): a slower trigger leaves /api/ready not_ready.
 * Every trigger's state is closed: created and paused in one apply, and
 * resumed only explicitly (OPS-3). The OPS-4 probe jobs (cloud-run/
 * ops-probe-contract.mjs OPS_PROBE_JOBS), restore-verify, ledger and
 * Worker-era analytics jobs are not rendered.
 *
 * This module is pure: it validates a desired-state object and renders the
 * resource specifications from it. It reads only repository files (the
 * committed desired states, the EP-7 templates, analytics-refresh.mjs and the
 * GCS store sources it parses for the custom role), never a live resource,
 * never the process environment and never a secret value. The repository
 * also ships a synthetic fixture (fixtures/gcp-ops-infra/), whose project
 * marker apply and rolloutTarget refuse.
 *
 * Every refusal throws an Error whose message and `code` are the same named
 * constant (a code may carry a ':<path>' suffix naming the setting).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/canonical-json.ts";
import { CLOUD_RUN_IAM_TEST_TARGET } from "../cloud-run/cloud-run-iam-test-target.mjs";
import { FASTPATH_TEST_CLOUD_TARGET } from "../cloud-run/origin-fastpath-mode.mjs";
import {
  EDGE_ONLY_SECRET_NAMES,
  OPTIONAL_SECRET_NAMES,
  PRODUCTION_POOL_CONNECTIONS_PER_INSTANCE,
  PRODUCTION_RESOURCE_FINGERPRINT,
  PRODUCTION_RESOURCE_MARKER,
  REQUIRED_SECRET_NAMES,
  RETIRED_SOCIAL_SIGN_IN_SECRET_NAMES,
  STAGING_ADMISSION_MODES,
  STAGING_PROVIDED_VAR_NAMES,
  STAGING_RESOURCE_MARKER,
} from "../cloud-run/postgres-production-configuration.mjs";
import { desiredBackupConfiguration } from "../cloud-run/ops-backup-horizon.mjs";
import {
  POSTGRES_MAINTENANCE_JOB_ENTRY,
  POSTGRES_MAINTENANCE_JOB_FORBIDDEN_PREFIXES,
  POSTGRES_MAINTENANCE_JOB_FORBIDDEN_VARIABLES,
  POSTGRES_MAINTENANCE_JOB_POOL_MAX,
  POSTGRES_MAINTENANCE_JOB_PROFILES,
  POSTGRES_MAINTENANCE_JOB_SCHEDULE,
} from "../cloud-run/postgres-maintenance-job-contract.mjs";
import { PRODUCTION_MIGRATION_JOB } from "../cloud-run/postgres-production-migrations.mjs";
import {
  FASTPATH_MIGRATIONS_JOB,
  FASTPATH_MIGRATION_TARGETS,
  GRAPH_BENCHMARK_MIGRATIONS_JOB,
  GRAPH_BENCHMARK_MIGRATION_TARGETS,
  TEST_MIGRATIONS_IAM_USER,
  TEST_MIGRATIONS_JOB,
  TEST_MIGRATIONS_PROJECT,
  TEST_MIGRATIONS_RUNTIME_IAM_USER,
  TEST_MIGRATIONS_SERVICE_ACCOUNT,
} from "../cloud-run/test-migrations.mjs";
import { GCP_PRIVATE_TEST_TARGET } from "./gcp-test-project.mjs";
import { GCP_TEST_BUCKET_HISTORY_TARGET } from "./gcp-test-bucket-history.mjs";
import { FASTPATH_TEST } from "./gcp-fastpath-test-deploy.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const GCP_OPS_INFRA_DESIRED_STATE_SCHEMA = "tibotattle-gcp-ops-infra-desired-state-v2";
export const GCP_OPS_INFRA_ENVIRONMENTS = Object.freeze(["production", "staging"]);

/**
 * The committed desired state of each environment, relative to apps/worker.
 * These files are the only desired states an apply, a bucket birth or an
 * OPS-10 rollout target reads (owner decision 2026-10-02: commit it to the
 * repository; non-secret identifiers only).
 */
export const COMMITTED_DESIRED_STATE_FILES = Object.freeze({
  production: "cloud-run/infra/production.desired-state.json",
  staging: "cloud-run/infra/staging.desired-state.json",
});
/** The JSON Schema of the committed files (editor and review aid; this validator is authoritative). */
export const DESIRED_STATE_JSON_SCHEMA_FILE = "cloud-run/infra/desired-state.schema.json";

/**
 * Settings a committed file may leave as explicit null placeholders until the
 * owner assigns them (OWN-5 for production). The validator refuses any of
 * them while null (DESIRED_STATE_PLACEHOLDER_UNFILLED:<path>), so a file with
 * a placeholder can be reviewed but never planned, applied or rolled out.
 */
export const OWNER_PLACEHOLDER_PATHS = Object.freeze(["project", "projectNumber", "region", "bucket.location"]);

/**
 * How the plane shares its GCP project. 'dedicated': the project holds this
 * plane only, so any other Cloud SQL instance, Cloud Run service or job, or
 * scheduler trigger is drift (a delete apply refuses), and the project-wide
 * logging posture is managed. 'shared' (staging in the GCP test project):
 * co-tenant resources are not read into the plan and never removed, and
 * project-wide settings (the _Default log sink and bucket, Data Access audit
 * logs) are left alone. Production is always dedicated.
 */
export const PROJECT_TENANCIES = Object.freeze(["dedicated", "shared"]);

/** The fast-path Cloud Run Jobs, and nothing else (OPS-3-lite). */
export const JOB_NAMES = Object.freeze(["production-migrate", "analytics-refresh", "maintenance"]);
/** Jobs a Cloud Scheduler trigger runs. production-migrate is manual (OPS-10). */
export const SCHEDULED_JOB_NAMES = Object.freeze(["analytics-refresh", "maintenance"]);
/**
 * Triggers whose cadence is not the owner's to choose, by job. The maintenance
 * pass reconciles at most 100 quarantine registrations per execution, the
 * Worker's batch, so the trigger must run every minute, the cron of every
 * d43c8f92 Worker environment: a slower trigger, or a sustained due rate above
 * 100 a minute, leaves /api/ready not_ready and lets pending_objects grow. The
 * value is the job's own contract constant
 * (postgres-maintenance-job-contract.mjs). The validator refuses any other
 * schedule, and a null one, for these (SCHEDULER_CADENCE_MISMATCH:<job>).
 */
export const PINNED_SCHEDULER_CADENCES = Object.freeze({
  maintenance: POSTGRES_MAINTENANCE_JOB_SCHEDULE,
});
/**
 * The trigger states a desired state may name. Apply creates a trigger and
 * pauses it in the same apply, whatever its desired state, and binds the
 * scheduler account's run.jobsExecutor only after that pause, so a trigger
 * whose pause failed cannot start the job. PAUSED until OPS-3 resumes the
 * trigger; ENABLED records that it has. Apply never resumes: it pauses a live
 * trigger that runs while PAUSED is desired, and leaves a resume to OPS-3.
 */
export const SCHEDULER_TRIGGER_STATES = Object.freeze(["PAUSED", "ENABLED"]);

/**
 * The paused-too-long signal (owner decision 2026-10-02: alert when the
 * trigger stays paused for more than a few hours; proposed 6 h). The
 * scheduler probe (gcp-infra.mjs scheduler-probe) reports
 * SCHEDULER_TRIGGER_PAUSED_TOO_LONG when a trigger whose desired state is
 * ENABLED is live PAUSED and neither a user change nor an attempt is newer
 * than this threshold. The probe is the signal only: the alert also needs a
 * periodic runner and a notification target (E-OPS5), which are not built.
 */
export const SCHEDULER_PAUSE_ALERT_THRESHOLD_HOURS = 6;

/**
 * Jobs whose create, and whose trigger's create, OPS-2 defers, with the
 * reason. None today: the analytics-refresh deferral was lifted when the
 * production refresh-job contract (ANALYTICS_REFRESH_JOB_CONTRACT) was
 * defined. The mechanism stays for a job whose entry cannot yet run.
 */
export const DEFERRED_JOBS = Object.freeze({});

/**
 * Jobs OPS-2 cannot render in an environment, with the reason: the job is not
 * created there, is not in the rollout target, and its trigger is not created.
 * None today: the staging maintenance job's entry
 * (STAGING_MAINTENANCE_JOB_ENVIRONMENT_UNAVAILABLE) was lifted when its
 * render began to read the staging plane's own values from the stagingOrigin
 * block, as the staging service does (STAGING-MAINT-RENDER;
 * STAGING_JOB_DEFINITIONS). The mechanism stays for a job an environment
 * cannot have.
 */
export const JOB_ENVIRONMENT_UNAVAILABLE = Object.freeze({});

/**
 * Services OPS-2 cannot render yet, by environment, with the reason. None
 * today: production renders from EP-7's template and staging from its own
 * staging template (STG-PREP; SERVICE_TEMPLATE_FILES). The mechanism stays
 * for an environment whose template is withdrawn.
 */
export const SERVICE_TEMPLATE_UNAVAILABLE = Object.freeze({});

/**
 * The Google and Apple sign-in secrets owner round 12 (2026-10-02) retired
 * at the switch, with no port. ROUTES-R12 removed them from CR-3
 * (RETIRED_SOCIAL_SIGN_IN_SECRET_NAMES), so they are no secret of either
 * plane: a desired state that still names one is refused as
 * SECRET_UNKNOWN:<name>, no template references them, and OPS-2 never makes
 * a container for them. The staging plane's earlier inert copies stay in
 * the test project's Secret Manager, unreferenced, until an owner decides to
 * remove them; nothing here deletes them.
 */
export const RETIRED_PRODUCTION_SECRET_NAMES = RETIRED_SOCIAL_SIGN_IN_SECRET_NAMES;

/**
 * CR-3 optional secrets that nothing on the production estate reads, so a
 * production desired state may leave them out, and the committed file does.
 * DISTRIBUTION_GITHUB_API_TOKEN: the origin's admin distribution view reads
 * the stored GitHub snapshot through a fetcher that refuses every request
 * (src/postgres-admin-distribution.ts), the service's Worker env never
 * carries the token (cloud-run/server.mjs), and no production job syncs
 * GitHub: the D-OPS4 maintenance job's profile accepts the token as optional,
 * but its lifecycle pass (src/postgres-lifecycle-pass.ts) never reads it.
 * Leaving the container out keeps the credential out of one more store. The
 * service and the maintenance job render without the entry, as for an
 * unpinned optional version. A later reader adds the container back with a
 * desired-state change.
 */
export const UNREAD_PRODUCTION_SECRET_NAMES = Object.freeze(["DISTRIBUTION_GITHUB_API_TOKEN"]);

/** Every CR-3 secret a production desired state may leave out. */
export const PRODUCTION_OMITTABLE_SECRET_NAMES = Object.freeze([...UNREAD_PRODUCTION_SECRET_NAMES]);

export const SERVICE_ACCOUNT_ROLES = Object.freeze([
  "runtime", "migrator", "scheduler", "builder", "edgeInvoker", "verifier",
]);

/**
 * The project roles each account holds, exactly. The runtime and migrator
 * connect to Cloud SQL as IAM database users; the builder writes Cloud Build
 * logs (CLOUD_LOGGING_ONLY). The scheduler holds only roles/run.jobsExecutor on
 * the analytics-refresh job, and the edge invoker and verifier hold only
 * roles/run.invoker on the service (EP-7's IAM template): no project role.
 * Resource-level grants are rendered separately (RESOURCE_GRANTS below).
 */
export const PROJECT_ROLE_POLICY = Object.freeze({
  runtime: Object.freeze(["roles/cloudsql.client", "roles/cloudsql.instanceUser"]),
  migrator: Object.freeze(["roles/cloudsql.client", "roles/cloudsql.instanceUser"]),
  scheduler: Object.freeze([]),
  builder: Object.freeze(["roles/logging.logWriter"]),
  edgeInvoker: Object.freeze([]),
  verifier: Object.freeze([]),
});
/** Basic (primitive) roles: refused for every account. */
export const PRIMITIVE_ROLES = Object.freeze([
  "roles/owner", "roles/editor", "roles/viewer", "roles/browser",
]);

/** The runtime account's production bucket access (edge live-check defect 3). */
export const QUARANTINE_STORE_ROLE_ID = "tibotattleQuarantineStore";
export const QUARANTINE_STORE_ROLE_TITLE = "TiboTattle quarantine object store";
export const QUARANTINE_STORE_ROLE_DESCRIPTION =
  "The GCS calls of the origin's quarantine object store, on the production bucket only";
export const QUARANTINE_STORE_CONDITION_TITLE = "tibotattle-quarantine-bucket";

export const SECRET_ACCESSOR_ROLE = "roles/secretmanager.secretAccessor";
export const ARTIFACT_WRITER_ROLE = "roles/artifactregistry.writer";
export const RUN_INVOKER_ROLE = "roles/run.invoker";
export const JOBS_EXECUTOR_ROLE = "roles/run.jobsExecutor";
/** The operator's grant on the verifier account alone (OD-CR-7): mint its ID tokens. */
export const TOKEN_CREATOR_ROLE = "roles/iam.serviceAccountTokenCreator";

/** Fixed Cloud SQL posture (decision D4); the desired state cannot override it. */
export const CLOUD_SQL_POSTURE = Object.freeze({
  databaseVersion: "POSTGRES_17",
  edition: "ENTERPRISE",
  availabilityType: "ZONAL",
  dataDiskType: "PD_SSD",
  storageAutoResize: true,
  deletionProtectionEnabled: true,
  // The runtime's Cloud SQL connector (cloud-run/cloud-sql.mjs) dials the
  // instance's public address with ipType PUBLIC and IAM authentication, so
  // the address is kept but reachable only through a connector: connector
  // enforcement REQUIRED and no authorized networks. A private-IP-only
  // instance needs a runtime change (ipType PRIVATE plus VPC egress) first.
  ipv4Enabled: true,
  authorizedNetworks: Object.freeze([]),
  connectorEnforcement: "REQUIRED",
  queryInsightsEnabled: false,
});

/** Cloud SQL logging posture: content-free and quiet, plus IAM authentication. */
export const CLOUD_SQL_LOGGING_FLAGS = Object.freeze({
  "cloudsql.iam_authentication": "on",
  log_error_verbosity: "terse",
  log_parameter_max_length: "0",
  log_parameter_max_length_on_error: "0",
  log_min_error_statement: "panic",
  log_statement: "none",
  log_min_duration_statement: "-1",
  log_lock_waits: "off",
  log_temp_files: "-1",
});

/** Connection-budget terms beyond the service pools. */
export const SUPERUSER_RESERVED_CONNECTIONS = 3;
export const CONNECTION_HEADROOM = 10;

/** Bucket posture, as gcp-test-bucket-history.mjs creates a proof bucket. */
export const BUCKET_POSTURE = Object.freeze({
  storageClass: "STANDARD",
  uniformBucketLevelAccess: true,
  publicAccessPrevention: "enforced",
  softDeleteRetentionDurationSeconds: "0",
  versioningEnabled: false,
  lifecycleRules: 0,
  retentionPolicy: false,
});

/** Logging: drop Cloud Run request logs, keep 30 days, no Data Access logs. */
export const LOGGING_POSTURE = Object.freeze({
  exclusionName: "tibotattle-run-requests",
  exclusionFilter: 'LOG_ID("run.googleapis.com/requests")',
  retentionDays: 30,
  dataAccessAuditOffServices: Object.freeze(["cloudsql.googleapis.com", "storage.googleapis.com"]),
});

/**
 * The analytics-refresh task profile. The default production profile is the
 * dense measurement profile (gcp-fastpath-test-deploy.mjs
 * REFRESH_JOB_PROFILES.dense: 4 vCPU, 16 GiB, a 12288 MiB heap, a 10752 MiB
 * per-owner memory budget, a 4 h task timeout) until the largest real owner
 * is measured on Cloud Run (MEAS-3). That budget is the one the memory model
 * says admits the largest real owner even when every record falls in the
 * analysis days, and the heap holds it beside analytics-refresh.mjs's
 * reserves (256 MiB, 4 KiB per default read-chunk occurrence) and its
 * minimum output budget; a run reclaims for its output account the part of
 * the budget its largest admitted owner leaves. Owners are computed inline
 * (workers 1): K-PAR's compute Workers stay out of this profile until MEAS-3
 * measures a Worker's heap peak on real owners (analytics-refresh.mjs
 * ANALYTICS_REFRESH_PRODUCTION_JOB; the test-deploy profile `dense-workers`
 * measures them). The manifest check holds this profile equal to the
 * measurement profile and the render equal to analytics-refresh.mjs
 * ANALYTICS_REFRESH_PRODUCTION_JOB (args, CPU, memory, heap, workers, task
 * timeout, retries, tasks and env), and proves the budget and the task memory
 * against that module's exported bounds.
 */
export const ANALYTICS_REFRESH_TASK_PROFILE = Object.freeze({
  name: "dense",
  cpu: "4",
  memory: "16Gi",
  heapMiB: 12_288,
  memoryBudgetMiB: 10_752,
  workers: 1,
  timeoutSeconds: 14_400,
});

/**
 * The production refresh-job contract (C-REFRESH implements it; OPS-2
 * renders it). Invocation: node --max-old-space-size=<heap>
 * dist/analytics-refresh.mjs --mode=full (and --workers=<n> only for a profile
 * with compute Workers), with no --schema and no --now; the real clock is used. Configuration comes from exactly the closed env below.
 * DEPLOYMENT_SOURCE_COMMIT is deployment provenance, not configuration: OPS-2
 * renders it and OPS-10's roll moves it on every job. ANALYTICS_V2_TEST_CLOCK
 * and every test or rehearsal setting are refused under production or
 * staging, so a render never carries one.
 */
export const ANALYTICS_REFRESH_JOB_CONTRACT = Object.freeze({
  entry: "dist/analytics-refresh.mjs",
  mode: "--mode=full",
  configurationEnv: Object.freeze([
    "ANALYTICS_REFRESH_TARGET", "PRIMARY_INSTANCE_CONNECTION_NAME", "PRIMARY_DATABASE", "PRIMARY_SCHEMA",
    "POSTGRES_IAM_USER", "ANALYTICS_V2_MEMORY_BUDGET_MIB",
  ]),
  provenanceEnv: Object.freeze(["DEPLOYMENT_SOURCE_COMMIT"]),
  refusedArguments: Object.freeze(["--schema", "--now"]),
  refusedEnv: Object.freeze(["ANALYTICS_V2_TEST_CLOCK", "POSTGRES_TEST_HTTP_MODE", "PG_TEST_SOCKET", "PG_TEST_HOST",
    "PG_TEST_PORT", "PG_TEST_USER", "PG_TEST_DATABASE", "PG_TEST_PASSWORD"]),
});

/**
 * The maintenance job's contract (D-OPS4; C-MAINT implements it in
 * cloud-run/postgres-maintenance-job.mjs, whose constants are imported, not
 * restated). Invocation: node dist/postgres-maintenance-job.mjs
 * --profile=maintenance-job, as the runtime account, with one primary pool
 * of POSTGRES_MAINTENANCE_JOB_POOL_MAX. The job refuses HOST_MODE, K_SERVICE,
 * every PG_TEST_ variable and every POSTGRES_MAINTENANCE_JOB_ tunable, so a
 * render carries none of them, and reads CLOUD_RUN_JOB from Cloud Run. Its
 * configuration is exactly the maintenance-job profile of CR-3's
 * readProductionConfiguration: the plane variables below, the OD-2 quarantine
 * bucket birth proof (the same closed record the service renders), the
 * POSTGRES_SCHEDULED_MAINTENANCE_ENABLED switch, and the profile's secrets by
 * Secret Manager reference at a pinned version (IDENTITY_LINK_SECRET required,
 * DISTRIBUTION_GITHUB_API_TOKEN optional and omitted when no version is
 * pinned). The 300 s task timeout holds one pass of 100 object reconciliations
 * with room for slow provider calls; a longer one would only delay the
 * next minute's executions, which skip while a pass holds the maintenance lock.
 * There are no retries (one attempt): the next minute is the retry.
 */
export const MAINTENANCE_JOB_CONTRACT = Object.freeze({
  entry: `dist/${POSTGRES_MAINTENANCE_JOB_ENTRY}.mjs`,
  profile: POSTGRES_MAINTENANCE_JOB_PROFILES[0],
  taskTimeoutSeconds: 300,
  cpu: "1",
  memory: "512Mi",
  poolMax: POSTGRES_MAINTENANCE_JOB_POOL_MAX,
  schedule: POSTGRES_MAINTENANCE_JOB_SCHEDULE,
  configurationEnv: Object.freeze([
    "TELEMETRY_STORAGE_NAMESPACE", "PRIMARY_INSTANCE_CONNECTION_NAME", "PRIMARY_DATABASE", "PRIMARY_SCHEMA",
    "POSTGRES_IAM_USER", "GCS_BUCKET_NAME", "GCS_QUARANTINE_BUCKET_HISTORY_PROOF",
    "POSTGRES_SCHEDULED_MAINTENANCE_ENABLED",
  ]),
  provenanceEnv: Object.freeze(["DEPLOYMENT_SOURCE_COMMIT"]),
  secrets: Object.freeze(["IDENTITY_LINK_SECRET", "DISTRIBUTION_GITHUB_API_TOKEN"]),
  // STAGING-MAINT-RENDER: the staging plane runs CR-3's staging-maintenance-job
  // profile. It reads the plane's own origins and identity values
  // (STAGING_PROVIDED_VAR_NAMES and ADMIN_HOST_ORIGIN = admin.<public host>),
  // which the staging service renders from the stagingOrigin block and the
  // inert identity-provider identifiers, and only that profile's secret.
  stagingProfile: POSTGRES_MAINTENANCE_JOB_PROFILES[1],
  stagingPlaneEnv: Object.freeze(["PUBLIC_ORIGIN", "ADMIN_HOST_ORIGIN",
    ...STAGING_PROVIDED_VAR_NAMES.filter((name) => name !== "PUBLIC_ORIGIN")]),
  stagingSecrets: Object.freeze(["IDENTITY_LINK_SECRET"]),
  refusedVariables: Object.freeze(Object.keys(POSTGRES_MAINTENANCE_JOB_FORBIDDEN_VARIABLES)),
  refusedPrefixes: Object.freeze(Object.keys(POSTGRES_MAINTENANCE_JOB_FORBIDDEN_PREFIXES)),
});

/** Cloud Run Job definitions for the fast path (rendered only; OPS-3-lite). */
export const JOB_DEFINITIONS = Object.freeze({
  // OPS-10's PRODUCTION_MIGRATION_JOB (cloud-run/postgres-production-
  // migrations.mjs) is the single source: its build-output entry, migrator
  // account, task timeout and the env keys its
  // validateProductionMigrationEnvironment reads (Cloud Run supplies
  // CLOUD_RUN_*). renderJob's one task, one attempt and no retries match it;
  // the manifest check runs that validator on this render.
  "production-migrate": Object.freeze({
    account: PRODUCTION_MIGRATION_JOB.serviceAccount,
    args: Object.freeze([PRODUCTION_MIGRATION_JOB.entry]),
    timeoutSeconds: PRODUCTION_MIGRATION_JOB.taskTimeoutSeconds,
    cpu: "1",
    memory: "512Mi",
    env: PRODUCTION_MIGRATION_JOB.env,
  }),
  // cloud-run/analytics-refresh.mjs: one full recompute (the only mode), in
  // the production refresh-job contract and the dense task profile.
  "analytics-refresh": Object.freeze({
    account: "runtime",
    args: Object.freeze([`--max-old-space-size=${ANALYTICS_REFRESH_TASK_PROFILE.heapMiB}`,
      ANALYTICS_REFRESH_JOB_CONTRACT.entry, ANALYTICS_REFRESH_JOB_CONTRACT.mode,
      ...(ANALYTICS_REFRESH_TASK_PROFILE.workers > 1 ? [`--workers=${ANALYTICS_REFRESH_TASK_PROFILE.workers}`] : [])]),
    timeoutSeconds: ANALYTICS_REFRESH_TASK_PROFILE.timeoutSeconds,
    cpu: ANALYTICS_REFRESH_TASK_PROFILE.cpu,
    memory: ANALYTICS_REFRESH_TASK_PROFILE.memory,
    env: Object.freeze([...ANALYTICS_REFRESH_JOB_CONTRACT.configurationEnv,
      ...ANALYTICS_REFRESH_JOB_CONTRACT.provenanceEnv]),
  }),
  // cloud-run/postgres-maintenance-job.mjs: one MP-2-lite lifecycle pass per
  // execution, the maintenance-job profile (MAINTENANCE_JOB_CONTRACT).
  maintenance: Object.freeze({
    account: "runtime",
    args: Object.freeze([MAINTENANCE_JOB_CONTRACT.entry, `--profile=${MAINTENANCE_JOB_CONTRACT.profile}`]),
    timeoutSeconds: MAINTENANCE_JOB_CONTRACT.taskTimeoutSeconds,
    cpu: MAINTENANCE_JOB_CONTRACT.cpu,
    memory: MAINTENANCE_JOB_CONTRACT.memory,
    env: Object.freeze([...MAINTENANCE_JOB_CONTRACT.configurationEnv, ...MAINTENANCE_JOB_CONTRACT.provenanceEnv]),
    secrets: MAINTENANCE_JOB_CONTRACT.secrets,
  }),
});

/**
 * A job's staging-plane definition where it differs from JOB_DEFINITIONS
 * (jobDefinition). The maintenance job runs the staging-maintenance-job
 * profile, with the plane's own values after its configuration and only that
 * profile's secret (STAGING-MAINT-RENDER).
 */
export const STAGING_JOB_DEFINITIONS = Object.freeze({
  maintenance: Object.freeze({
    ...JOB_DEFINITIONS.maintenance,
    args: Object.freeze([MAINTENANCE_JOB_CONTRACT.entry, `--profile=${MAINTENANCE_JOB_CONTRACT.stagingProfile}`]),
    env: Object.freeze([...MAINTENANCE_JOB_CONTRACT.configurationEnv, ...MAINTENANCE_JOB_CONTRACT.stagingPlaneEnv,
      ...MAINTENANCE_JOB_CONTRACT.provenanceEnv]),
    secrets: MAINTENANCE_JOB_CONTRACT.stagingSecrets,
  }),
});

/** The definition a desired state's environment renders for `job`. */
export function jobDefinition(desired, job) {
  if (!JOB_NAMES.includes(job)) fail("JOB_NAME_UNKNOWN");
  if (desired.environment === "staging" && Object.hasOwn(STAGING_JOB_DEFINITIONS, job)) {
    return STAGING_JOB_DEFINITIONS[job];
  }
  return JOB_DEFINITIONS[job];
}

export const SCHEDULER_TIME_ZONE = "Etc/UTC";
export const SCHEDULER_OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** The project marker apply refuses: the shipped fixture is synthetic. */
export const SYNTHETIC_PROJECT_MARKER = "synthetic";

/** Each environment's service template, relative to apps/worker (EP-7's, and STG-PREP's staging one). */
export const SERVICE_TEMPLATE_FILES = Object.freeze({
  production: "cloud-run/production-service.template.yaml",
  staging: "cloud-run/staging-service.template.yaml",
});
const SERVICE_TEMPLATE_PATH = resolve(WORKER_ROOT, SERVICE_TEMPLATE_FILES.production);
const IAM_TEMPLATE_PATH = resolve(WORKER_ROOT, "cloud-run/production-edge-iam.template.json");
/** The GCS store entry module; its relative imports are followed. */
export const GCS_STORE_ENTRY = "src/gcs-quarantine-object-store.ts";
const ANALYTICS_REFRESH_SOURCE = "cloud-run/analytics-refresh.mjs";

// ---------------------------------------------------------------------------
// Grammars

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const PROJECT_NUMBER = /^[1-9][0-9]{5,19}$/u;
const REGION = /^[a-z]+-[a-z]+[0-9]{1,2}$/u;
const RESOURCE_NAME = /^[a-z](?:[a-z0-9-]{0,47}[a-z0-9])?$/u;
const ACCOUNT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const CLOUD_SQL_INSTANCE_ID = /^[a-z](?:[a-z0-9-]{0,96}[a-z0-9])?$/u;
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const BUCKET_NAME = /^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/u;
const REPOSITORY_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const IMAGE_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const CUSTOM_TIER = /^db-custom-([1-9][0-9]?)-([1-9][0-9]{2,6})$/u;
const START_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const GENERATION = /^[1-9][0-9]{0,18}$/u;
const SECRET_VERSION = /^[1-9][0-9]{0,9}$/u;
const AUDIENCE = /^[!-~](?:[ -~]{0,254}[!-~])?$/u;
const NAMESPACE = /^[A-Za-z0-9._:-]{1,256}$/u;
const IMAGE_DIGEST = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/u;
const PERMISSION = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+){2}$/u;
/** A Secret Manager secret id. */
const SECRET_ID = /^[A-Za-z0-9_-]{1,255}$/u;
/**
 * The plane's own Secret Manager ids, closed per plane so that a pasted
 * secret value (hex, lowercase base64url, a short token) never passes as an
 * id. Production names a secret by the variable name EP-7's template uses, or
 * by a `tibotattle-` id of lowercase words; staging, which shares its
 * project, by a `tibotattle-staging-` id of lowercase words.
 */
export const PLANE_SECRET_ID = /^tibotattle-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const STAGING_SECRET_ID = /^tibotattle-staging-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/** An IAM principal that may mint the verifier's tokens: a user, a group or a service account. */
const TOKEN_CREATOR_MEMBER = /^(?:user|group|serviceAccount):[A-Za-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/u;
const MAX_TOKEN_CREATORS = 4;
const MAX_GENERATION = 9_223_372_036_854_775_807n;

export class GcpOpsInfraError extends Error {
  constructor(code) {
    super(code);
    this.name = "GcpOpsInfraError";
    this.code = code;
  }
}

export function fail(code) {
  throw new GcpOpsInfraError(code);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function markerPattern(marker) {
  return new RegExp(`(?:^|[^a-z0-9])${marker}(?:[^a-z0-9]|$)`, "iu");
}
const STAGING_MARKER = markerPattern(STAGING_RESOURCE_MARKER);
const PRODUCTION_MARKER = markerPattern(PRODUCTION_RESOURCE_MARKER);
const SYNTHETIC_MARKER = markerPattern(SYNTHETIC_PROJECT_MARKER);
const LEDGER_TOKEN = markerPattern("ledger");

/** True when the desired state names the shipped synthetic fixture's project. */
export function isSyntheticProject(project) {
  return typeof project === "string" && SYNTHETIC_MARKER.test(project);
}

// ---------------------------------------------------------------------------
// Test-estate identities: no production name may equal one.

function collectStrings(value, into, { skipKeys = [] } = {}) {
  if (typeof value === "string") {
    into.add(value);
    if (/^[a-z][a-z0-9-]*:[a-z]+-[a-z]+[0-9]+:[a-z][a-z0-9-]*$/u.test(value)) {
      const [project, , instance] = value.split(":");
      into.add(project);
      into.add(instance);
    }
    if (value.endsWith(".iam.gserviceaccount.com")) into.add(value.split("@")[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, into, { skipKeys });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (!skipKeys.includes(key)) collectStrings(entry, into, { skipKeys });
    }
  }
}

/**
 * Every name the test estate uses: the retired A2 test deployment and its
 * migrate Job (OD-6; their resources remain until OA-4), the graph-benchmark
 * and fast-path migration targets, the IAM test host identities, the
 * fast-path deploy and the bucket-history tool. Locations, listen addresses
 * and ports are not identities.
 */
function testTargetNames() {
  const names = new Set();
  const skipKeys = ["region", "location", "listenHost", "port", "projectNumber", "edgeGetPaths",
    "originLoopbackPort", "edgeIngressPort", "labels", "seededSchemaPrefix", "bucketPrefix"];
  for (const source of [
    GCP_PRIVATE_TEST_TARGET,
    GRAPH_BENCHMARK_MIGRATION_TARGETS,
    FASTPATH_MIGRATION_TARGETS,
    [TEST_MIGRATIONS_JOB, GRAPH_BENCHMARK_MIGRATIONS_JOB, FASTPATH_MIGRATIONS_JOB, TEST_MIGRATIONS_PROJECT,
      TEST_MIGRATIONS_SERVICE_ACCOUNT, TEST_MIGRATIONS_IAM_USER, TEST_MIGRATIONS_RUNTIME_IAM_USER],
    CLOUD_RUN_IAM_TEST_TARGET,
    FASTPATH_TEST_CLOUD_TARGET,
    GCP_TEST_BUCKET_HISTORY_TARGET,
    FASTPATH_TEST,
  ]) {
    collectStrings(source, names, { skipKeys });
  }
  return names;
}
export const TEST_TARGET_NAMES = Object.freeze([...testTargetNames()].sort());
const TEST_TARGET_NAME_SET = new Set(TEST_TARGET_NAMES);
/** Name prefixes only the test estate uses. */
export const TEST_TARGET_PREFIXES = Object.freeze([
  FASTPATH_TEST_CLOUD_TARGET.seededSchemaPrefix,
  GCP_TEST_BUCKET_HISTORY_TARGET.bucketPrefix,
  "tibotattle-test-",
  "tibotattle-fastpath-test-",
]);

// ---------------------------------------------------------------------------
// The GCS store's calls, parsed from source (the custom role's permissions).

/**
 * Each (method, path) a GCS store module may request, and the one IAM
 * permission it needs. Anything else is refused: a new call must be reviewed
 * here before the role can grant it.
 */
const GCS_OPERATION_PERMISSIONS = Object.freeze({
  "POST /upload/storage/v1/b/{}/o": "storage.objects.create",
  "GET /storage/v1/b/{}/o/{}": "storage.objects.get",
  "DELETE /storage/v1/b/{}/o/{}": "storage.objects.delete",
  "GET /storage/v1/b/{}/o": "storage.objects.list",
  "GET /storage/v1/b/{}": "storage.buckets.get",
});

function moduleHelpers(source) {
  const helpers = new Map();
  for (const match of source.matchAll(
    /function ([A-Za-z0-9_]+)\([^)]*\): string \{\s*return `([^`]*)`;\s*\}/gu,
  )) {
    helpers.set(match[1], match[2]);
  }
  return helpers;
}

/** Reads one balanced argument starting at `start` (just after an open paren). */
function firstArgument(source, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === "\\") { index += 1; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") { quote = character; continue; }
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") {
      if (depth === 0) return source.slice(start, index).trim();
      depth -= 1;
    }
    if (character === "," && depth === 0) return source.slice(start, index).trim();
  }
  return fail("GCS_STORE_SOURCE_UNPARSEABLE");
}

function normalizedPath(expression, helpers) {
  const template = /^`([^`]*)`$/u.exec(expression);
  let text;
  if (template !== null) {
    text = template[1];
  } else {
    const call = /^([A-Za-z0-9_]+)\(/u.exec(expression);
    if (call === null || !helpers.has(call[1])) fail("GCS_STORE_URL_UNRESOLVED");
    text = helpers.get(call[1]);
  }
  return text.replace(/\$\{[^}]*\}/gu, "{}");
}

/** The (method, path) pairs one module's request sites issue. */
function moduleOperations(source) {
  const helpers = moduleHelpers(source);
  const operations = [];
  const fixedUrlCalls = [...source.matchAll(/\bfixedUrl\(/gu)]
    .filter((match) => !source.slice(Math.max(0, match.index - 9), match.index).endsWith("function "));
  let resolvedFixedUrls = 0;
  for (const match of source.matchAll(/this\.request\(/gu)) {
    const argument = firstArgument(source, match.index + match[0].length);
    let urlExpression;
    if (argument.startsWith("fixedUrl(")) {
      urlExpression = firstArgument(source, match.index + match[0].length + "fixedUrl(".length);
    } else if (argument === "url") {
      const before = source.slice(0, match.index);
      const assignment = before.lastIndexOf("const url = fixedUrl(");
      if (assignment < 0) fail("GCS_STORE_URL_UNRESOLVED");
      urlExpression = firstArgument(source, assignment + "const url = fixedUrl(".length);
    } else {
      fail("GCS_STORE_URL_UNRESOLVED");
    }
    resolvedFixedUrls += 1;
    const method = /method:\s*"([A-Z]+)"/u.exec(source.slice(match.index, match.index + 400));
    if (method === null) fail("GCS_STORE_METHOD_UNRESOLVED");
    operations.push(`${method[1]} ${normalizedPath(urlExpression, helpers)}`);
  }
  if (fixedUrlCalls.length !== resolvedFixedUrls) fail("GCS_STORE_URL_UNACCOUNTED");
  // The only network path is the module's own request(): one fetchImpl call
  // and the default fetch parameter, and nothing that bypasses them.
  const fetchCalls = [...source.matchAll(/\bfetch\(/gu)].length;
  const fetchImplCalls = [...source.matchAll(/this\.fetchImpl\(/gu)].length;
  if (operations.length > 0 && (fetchCalls !== 1 || fetchImplCalls !== 1)) {
    fail("GCS_STORE_FETCH_UNACCOUNTED");
  }
  if (operations.length === 0 && fetchCalls + fetchImplCalls > 0) fail("GCS_STORE_FETCH_UNACCOUNTED");
  return operations;
}

function defaultReadSource(relativePath) {
  return readFileSync(resolve(WORKER_ROOT, relativePath), "utf8");
}

/**
 * The permissions the runtime's GCS quarantine store needs, parsed from its
 * source and from every module it imports by relative path (the erasure
 * delete primitive among them). storage.buckets.get is always included.
 */
export function deriveQuarantineStorePermissions({ readSource = defaultReadSource } = {}) {
  const visited = new Set();
  const operations = new Set();
  const queue = [GCS_STORE_ENTRY];
  while (queue.length > 0) {
    const path = queue.shift();
    if (visited.has(path)) continue;
    if (visited.size >= 16) fail("GCS_STORE_IMPORTS_UNBOUNDED");
    visited.add(path);
    const source = readSource(path);
    if (typeof source !== "string") fail("GCS_STORE_SOURCE_UNREADABLE");
    for (const operation of moduleOperations(source)) operations.add(operation);
    for (const imported of source.matchAll(/^import\s+(?:type\s+)?[\s\S]*?from\s+"(\.\/[a-z0-9-]+)";/gmu)) {
      queue.push(`src/${imported[1].slice(2)}.ts`);
    }
  }
  if (!visited.has("src/gcs-erasure-object-store.ts")) fail("GCS_STORE_DELETE_PRIMITIVE_MISSING");
  const permissions = new Set(["storage.buckets.get"]);
  for (const operation of operations) {
    const permission = GCS_OPERATION_PERMISSIONS[operation];
    if (permission === undefined) fail("GCS_STORE_OPERATION_UNMAPPED");
    permissions.add(permission);
  }
  return Object.freeze([...permissions].sort());
}

/** analytics-refresh.mjs's own pool maximum, read from its source. */
export function analyticsRefreshPoolMax({ readSource = defaultReadSource } = {}) {
  const matches = [...readSource(ANALYTICS_REFRESH_SOURCE).matchAll(/^const POOL_MAX = ([1-9][0-9]?);$/gmu)];
  if (matches.length !== 1) fail("ANALYTICS_REFRESH_POOL_MAX_UNRESOLVED");
  return Number(matches[0][1]);
}

// ---------------------------------------------------------------------------
// Desired-state validation

/**
 * The closed key set of every object in a desired state, by kind. The
 * validator enforces exactly these sets, and the manifest check holds the
 * committed JSON Schema to them, so the two cannot drift. The keyed maps
 * (serviceAccounts, secrets, jobs, scheduler) are closed over
 * SERVICE_ACCOUNT_ROLES, CR-3's secret names, JOB_NAMES and
 * SCHEDULED_JOB_NAMES.
 */
export const DESIRED_STATE_SHAPE = Object.freeze({
  desiredState: Object.freeze([
    "schemaVersion", "environment", "projectTenancy", "project", "projectNumber", "region", "artifactRegistry",
    "serviceAccounts", "customRole", "secrets", "cloudSql", "bucket", "service", "jobs", "scheduler",
    "stagingOrigin",
  ]),
  artifactRegistry: Object.freeze(["repository", "imageName"]),
  serviceAccount: Object.freeze(["accountId", "projectRoles"]),
  verifier: Object.freeze(["accountId", "projectRoles", "tokenCreators"]),
  customRole: Object.freeze(["id", "permissions"]),
  secret: Object.freeze(["secretName", "version"]),
  cloudSql: Object.freeze(["instance", "tier", "storageSizeGb", "backupStartTime", "maxConnections", "database",
    "schema"]),
  bucket: Object.freeze(["name", "location", "proof"]),
  bucketProof: Object.freeze(["bucketGeneration", "bucketMetageneration"]),
  service: Object.freeze(["name", "maxInstances", "rolloutOverlapInstances", "audience", "telemetryStorageNamespace"]),
  job: Object.freeze(["name", "maxConnections"]),
  trigger: Object.freeze(["name", "schedule", "state"]),
  // STG-PREP: the staging service's own non-secret settings; null in production.
  stagingOrigin: Object.freeze(["publicOrigin", "accessTeamDomain", "accessAud", "accessAdminEmail",
    "identityLinkSecretVersion", "admissionMode"]),
});

function closedKeys(value, keys, path) {
  if (!isRecord(value)) fail(`DESIRED_STATE_SHAPE_INVALID:${path}`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`DESIRED_STATE_KEY_UNKNOWN:${path}.${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`DESIRED_STATE_KEY_MISSING:${path}.${key}`);
  }
}

function text(value, pattern, path) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`DESIRED_STATE_VALUE_INVALID:${path}`);
  return value;
}

function integer(value, minimum, maximum, path) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`DESIRED_STATE_VALUE_INVALID:${path}`);
  }
  return value;
}

function generation(value, path) {
  text(value, GENERATION, path);
  if (BigInt(value) > MAX_GENERATION) fail(`DESIRED_STATE_VALUE_INVALID:${path}`);
  return value;
}

/** Refuses any deletion-ledger or history-proof setting anywhere, before shape checks. */
function refuseLedger(value, path = "desiredState") {
  if (typeof value === "string") {
    if (LEDGER_TOKEN.test(value) || /^LEDGER_/u.test(value)) fail(`DESIRED_STATE_LEDGER_FORBIDDEN:${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => refuseLedger(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (/ledger/iu.test(key) || key === "GCS_ERASURE_BUCKET_HISTORY_PROOF" || key === "historyProof") {
        fail(`DESIRED_STATE_LEDGER_FORBIDDEN:${path}.${key}`);
      }
      refuseLedger(entry, `${path}.${key}`);
    }
  }
}

/**
 * Keys that would hold a secret value, a key or a credential. The desired
 * state names Secret Manager secrets and pinned version numbers only, so
 * none of these may appear at any depth.
 */
export const SECRET_VALUE_KEYS = Object.freeze([
  "value", "secretValue", "data", "payload", "plaintext", "password", "passphrase", "privateKey", "private_key",
  "clientSecret", "client_secret", "token", "accessToken", "refreshToken", "apiKey", "key", "keyJson",
  "credentials", "jwk", "d",
]);

/** Strings that look like secret material rather than an identifier. */
function looksLikeSecret(value) {
  if (value.length > 256) return true;
  if (/-----BEGIN [A-Z ]+-----|"(?:kty|private_key|client_secret|refresh_token)"/u.test(value)) return true;
  if (/AIza[0-9A-Za-z_-]{35}|ya29\.|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|xox[abpr]-|sk-[A-Za-z0-9]{16,}/u.test(value)) {
    return true;
  }
  // A long token of mixed case and digits is a credential, not a resource name.
  return /^[A-Za-z0-9+/_=-]{32,}$/u.test(value) && /[A-Z]/u.test(value) && /[a-z]/u.test(value)
    && /[0-9]/u.test(value);
}

/**
 * Refuses secret material anywhere in a desired state, before any shape
 * check: a secret-valued key, or a string that looks like a key, a token or
 * a JWK. Committed files hold non-secret identifiers only.
 */
function refuseSecretMaterial(value, path = "desiredState") {
  if (typeof value === "string") {
    if (looksLikeSecret(value)) fail(`DESIRED_STATE_SECRET_VALUE_FORBIDDEN:${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => refuseSecretMaterial(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_VALUE_KEYS.includes(key)) fail(`DESIRED_STATE_SECRET_VALUE_FORBIDDEN:${path}.${key}`);
      refuseSecretMaterial(entry, `${path}.${key}`);
    }
  }
}

/** The owner-assigned placeholders still null, in OWNER_PLACEHOLDER_PATHS order. */
export function unfilledPlaceholders(input) {
  if (!isRecord(input)) return Object.freeze([]);
  return Object.freeze(OWNER_PLACEHOLDER_PATHS.filter((path) => {
    const [head, tail] = path.split(".");
    const holder = tail === undefined ? input : input[head];
    return isRecord(holder) && Object.hasOwn(holder, tail ?? head) && holder[tail ?? head] === null;
  }));
}

function tokenCreators(value, path) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOKEN_CREATORS
      || value.some((member) => typeof member !== "string" || !TOKEN_CREATOR_MEMBER.test(member))
      || new Set(value).size !== value.length) {
    fail(`DESIRED_STATE_VALUE_INVALID:${path}`);
  }
  return Object.freeze([...value].sort());
}

function serviceAccount(value, role, path) {
  closedKeys(value, role === "verifier" ? DESIRED_STATE_SHAPE.verifier : DESIRED_STATE_SHAPE.serviceAccount, path);
  const accountId = text(value.accountId, ACCOUNT_ID, `${path}.accountId`);
  if (!Array.isArray(value.projectRoles) || value.projectRoles.some((roleName) => typeof roleName !== "string")) {
    fail(`DESIRED_STATE_VALUE_INVALID:${path}.projectRoles`);
  }
  const roles = [...value.projectRoles];
  if (roles.some((roleName) => PRIMITIVE_ROLES.includes(roleName))) fail(`IAM_PRIMITIVE_ROLE_FORBIDDEN:${role}`);
  if ((role === "edgeInvoker" || role === "verifier") && roles.length !== 0) {
    fail(`EDGE_INVOKER_PROJECT_ROLE_FORBIDDEN:${role}`);
  }
  if (new Set(roles).size !== roles.length
      || [...roles].sort().join() !== [...PROJECT_ROLE_POLICY[role]].sort().join()) {
    fail(`IAM_PROJECT_ROLES_MISMATCH:${role}`);
  }
  const account = { accountId, projectRoles: Object.freeze([...PROJECT_ROLE_POLICY[role]]) };
  if (role === "verifier") account.tokenCreators = tokenCreators(value.tokenCreators, `${path}.tokenCreators`);
  return account;
}

/** Five-field cron, minutes to day of week, with lists, ranges and steps. */
function validCron(value) {
  if (typeof value !== "string" || value.length > 120) return false;
  const fields = value.split(" ");
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  if (fields.length !== 5) return false;
  return fields.every((field, index) => field.split(",").every((part) => {
    const [range, step, extra] = part.split("/");
    if (extra !== undefined || (step !== undefined && !/^[1-9][0-9]?$/u.test(step))) return false;
    if (range === "*") return true;
    const [low, high, more] = range.split("-");
    const [minimum, maximum] = bounds[index];
    const number = (item) => (/^(?:0|[1-9][0-9]?)$/u.test(item) ? Number(item) : Number.NaN);
    const start = number(low);
    const end = high === undefined ? start : number(high);
    return more === undefined && Number.isInteger(start) && Number.isInteger(end)
      && start >= minimum && end <= maximum && start <= end;
  }));
}

function nameChecks(names, environment) {
  for (const [path, name] of names) {
    if (TEST_TARGET_NAME_SET.has(name) || TEST_TARGET_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      fail(`DESIRED_STATE_TEST_TARGET_NAME:${path}`);
    }
    if (name.includes("-rehearsal-") || name.includes("_rehearsal_")) fail(`DESIRED_STATE_REHEARSAL_NAME:${path}`);
  }
  for (const [path, name] of names.filter(([path]) => path.startsWith("plane:"))) {
    const label = path.slice("plane:".length);
    // OPS-10's rollout-target rule: no plane resource carries a 'test' or
    // 'rehearsal' token at all.
    const tokens = name.toLowerCase().split(/[^a-z0-9]+/u);
    if (tokens.includes("test")) fail(`DESIRED_STATE_TEST_TOKEN_NAME:${label}`);
    if (tokens.includes("rehearsal")) fail(`DESIRED_STATE_REHEARSAL_NAME:${path}`);
    if (environment === "production" && STAGING_MARKER.test(name)) {
      fail(`DESIRED_STATE_STAGING_NAME_FORBIDDEN:${label}`);
    }
    if (environment === "staging") {
      if (PRODUCTION_MARKER.test(name)) fail(`DESIRED_STATE_PRODUCTION_NAME_FORBIDDEN:${label}`);
      if (!STAGING_MARKER.test(name)) fail(`DESIRED_STATE_STAGING_MARKER_MISSING:${label}`);
    }
  }
}

/**
 * The connection budget on the one Cloud SQL instance:
 * (maxInstances + rolloutOverlapInstances) x per-instance pools + jobBudget
 * + migration + 3 superuser-reserved + 10 headroom <= max_connections.
 */
export function connectionBudget({ service, jobs, cloudSql }) {
  const perInstance = PRODUCTION_POOL_CONNECTIONS_PER_INSTANCE.primary;
  if (Object.keys(PRODUCTION_POOL_CONNECTIONS_PER_INSTANCE).join() !== "primary"
      || !Number.isSafeInteger(perInstance) || perInstance < 1) {
    fail("CONNECTION_BUDGET_POOLS_NOT_SINGLE_INSTANCE");
  }
  const instances = service.maxInstances + service.rolloutOverlapInstances;
  const serviceConnections = instances * perInstance;
  const jobBudget = SCHEDULED_JOB_NAMES.reduce((sum, name) => sum + jobs[name].maxConnections, 0);
  const migration = jobs["production-migrate"].maxConnections;
  const total = serviceConnections + jobBudget + migration + SUPERUSER_RESERVED_CONNECTIONS + CONNECTION_HEADROOM;
  return Object.freeze({
    perInstance,
    instances,
    serviceConnections,
    jobBudget,
    migration,
    superuserReserved: SUPERUSER_RESERVED_CONNECTIONS,
    headroom: CONNECTION_HEADROOM,
    total,
    maxConnections: cloudSql.maxConnections,
    fits: total <= cloudSql.maxConnections,
  });
}

/**
 * Validates a desired-state object and returns it frozen, normalized and with
 * its derived identities (emails, IAM users, connection names). `readSource`
 * reads repository files relative to apps/worker (the GCS store modules and
 * analytics-refresh.mjs), injectable for doctored-source checks.
 */
export function validateDesiredState(input, { readSource = defaultReadSource } = {}) {
  if (!isRecord(input)) fail("DESIRED_STATE_SHAPE_INVALID:desiredState");
  refuseLedger(input);
  refuseSecretMaterial(input);
  // Specific refusals before the generic closed-key rule.
  if (Array.isArray(input.cloudSql)) {
    fail(input.cloudSql.length > 1 ? "CLOUD_SQL_SECOND_INSTANCE_FORBIDDEN" : "DESIRED_STATE_SHAPE_INVALID:cloudSql");
  }
  if (isRecord(input.cloudSql)) {
    for (const key of ["replicas", "readReplicas", "replica", "failoverReplica", "secondaryInstance",
      "instances", "availabilityType", "highAvailability"]) {
      if (Object.hasOwn(input.cloudSql, key)) fail("CLOUD_SQL_SECOND_INSTANCE_FORBIDDEN");
    }
  }
  if (isRecord(input.bucket)) {
    for (const key of ["lifecycle", "lifecycleRules", "lifecycleRule"]) {
      if (Object.hasOwn(input.bucket, key)) fail("BUCKET_LIFECYCLE_FORBIDDEN");
    }
  }
  if (isRecord(input.secrets)) {
    for (const name of Object.keys(input.secrets)) {
      if (EDGE_ONLY_SECRET_NAMES.includes(name) || /^EDGE_PROOF_/u.test(name) || /^SPARKLE_/u.test(name)) {
        fail(`SECRET_EDGE_ONLY_FORBIDDEN:${name}`);
      }
    }
  }
  closedKeys(input, DESIRED_STATE_SHAPE.desiredState, "desiredState");
  if (input.schemaVersion !== GCP_OPS_INFRA_DESIRED_STATE_SCHEMA) fail("DESIRED_STATE_SCHEMA_INVALID");
  if (!GCP_OPS_INFRA_ENVIRONMENTS.includes(input.environment)) {
    fail("DESIRED_STATE_VALUE_INVALID:desiredState.environment");
  }
  const environment = input.environment;
  // An owner placeholder is reviewable but never usable (OWN-5).
  const unfilled = unfilledPlaceholders(input);
  if (unfilled.length > 0) fail(`DESIRED_STATE_PLACEHOLDER_UNFILLED:${unfilled[0]}`);
  if (!PROJECT_TENANCIES.includes(input.projectTenancy)) fail("DESIRED_STATE_VALUE_INVALID:desiredState.projectTenancy");
  const projectTenancy = input.projectTenancy;
  if (environment === "production" && projectTenancy !== "dedicated") fail("PROJECT_TENANCY_SHARED_FORBIDDEN:production");
  const project = text(input.project, PROJECT_ID, "desiredState.project");
  const projectNumber = text(input.projectNumber, PROJECT_NUMBER, "desiredState.projectNumber");
  const region = text(input.region, REGION, "desiredState.region");

  closedKeys(input.artifactRegistry, DESIRED_STATE_SHAPE.artifactRegistry, "artifactRegistry");
  const artifactRegistry = {
    repository: text(input.artifactRegistry.repository, REPOSITORY_NAME, "artifactRegistry.repository"),
    imageName: text(input.artifactRegistry.imageName, IMAGE_NAME, "artifactRegistry.imageName"),
  };
  artifactRegistry.imageRepository =
    `${region}-docker.pkg.dev/${project}/${artifactRegistry.repository}/${artifactRegistry.imageName}`;

  closedKeys(input.serviceAccounts, SERVICE_ACCOUNT_ROLES, "serviceAccounts");
  const serviceAccounts = {};
  for (const role of SERVICE_ACCOUNT_ROLES) {
    const value = input.serviceAccounts[role];
    if (role === "verifier" && value === null) {
      serviceAccounts[role] = null;
      continue;
    }
    const account = serviceAccount(value, role, `serviceAccounts.${role}`);
    const email = `${account.accountId}@${project}.iam.gserviceaccount.com`;
    serviceAccounts[role] = { ...account, email, member: `serviceAccount:${email}` };
  }
  const accountIds = Object.values(serviceAccounts).filter(Boolean).map((account) => account.accountId);
  if (new Set(accountIds).size !== accountIds.length) fail("SERVICE_ACCOUNTS_NOT_DISTINCT");
  // The operator mints the verifier's tokens; no account of the plane may.
  const managedMembers = Object.values(serviceAccounts).filter(Boolean).map((account) => account.member);
  if ((serviceAccounts.verifier?.tokenCreators ?? []).some((member) => managedMembers.includes(member))) {
    fail("VERIFIER_TOKEN_CREATOR_MANAGED_ACCOUNT_FORBIDDEN");
  }

  closedKeys(input.customRole, DESIRED_STATE_SHAPE.customRole, "customRole");
  if (input.customRole.id !== QUARANTINE_STORE_ROLE_ID) fail("CUSTOM_ROLE_ID_INVALID");
  if (!Array.isArray(input.customRole.permissions)
      || input.customRole.permissions.some((permission) => typeof permission !== "string"
        || !PERMISSION.test(permission))) {
    fail("DESIRED_STATE_VALUE_INVALID:customRole.permissions");
  }
  const parsedPermissions = deriveQuarantineStorePermissions({ readSource });
  const declared = [...input.customRole.permissions];
  if (new Set(declared).size !== declared.length || [...declared].sort().join() !== parsedPermissions.join()) {
    fail("CUSTOM_ROLE_PERMISSIONS_MISMATCH");
  }
  const customRole = {
    id: QUARANTINE_STORE_ROLE_ID,
    name: `projects/${project}/roles/${QUARANTINE_STORE_ROLE_ID}`,
    permissions: parsedPermissions,
  };

  // Secret Manager secrets: exactly CR-3's required and optional names (less,
  // in production, the unread one), each named by its Secret
  // Manager secret id, in its plane's form, and a pinned version number.
  if (!isRecord(input.secrets)) fail("DESIRED_STATE_SHAPE_INVALID:secrets");
  const secretNames = [...REQUIRED_SECRET_NAMES, ...OPTIONAL_SECRET_NAMES];
  for (const name of Object.keys(input.secrets)) {
    if (!secretNames.includes(name)) fail(`SECRET_UNKNOWN:${name}`);
  }
  // Production may leave out an unread secret; every other name is required.
  const omittableSecretNames = environment === "production" ? PRODUCTION_OMITTABLE_SECRET_NAMES : [];
  const secrets = {};
  for (const name of secretNames) {
    if (!Object.hasOwn(input.secrets, name) && omittableSecretNames.includes(name)) continue;
    if (!Object.hasOwn(input.secrets, name)) fail(`SECRET_CONTAINER_MISSING:${name}`);
    closedKeys(input.secrets[name], DESIRED_STATE_SHAPE.secret, `secrets.${name}`);
    const secretName = text(input.secrets[name].secretName, SECRET_ID, `secrets.${name}.secretName`);
    if (!(environment === "production" ? secretName === name || PLANE_SECRET_ID.test(secretName)
      : STAGING_SECRET_ID.test(secretName))) {
      fail(`SECRET_ID_FORM_INVALID:secrets.${name}.secretName`);
    }
    const version = input.secrets[name].version;
    if (version !== null) text(version, SECRET_VERSION, `secrets.${name}.version`);
    secrets[name] = { secretName, version, required: REQUIRED_SECRET_NAMES.includes(name) };
  }
  const secretIds = Object.values(secrets).map((secret) => secret.secretName);
  if (new Set(secretIds).size !== secretIds.length) fail("SECRET_NAMES_NOT_DISTINCT");

  closedKeys(input.cloudSql, DESIRED_STATE_SHAPE.cloudSql, "cloudSql");
  const cloudSql = {
    instance: text(input.cloudSql.instance, CLOUD_SQL_INSTANCE_ID, "cloudSql.instance"),
    tier: text(input.cloudSql.tier, CUSTOM_TIER, "cloudSql.tier"),
    storageSizeGb: integer(input.cloudSql.storageSizeGb, 10, 65_536, "cloudSql.storageSizeGb"),
    backupStartTime: text(input.cloudSql.backupStartTime, START_TIME, "cloudSql.backupStartTime"),
    maxConnections: integer(input.cloudSql.maxConnections, 25, 10_000, "cloudSql.maxConnections"),
    database: text(input.cloudSql.database, DATABASE_NAME, "cloudSql.database"),
    schema: text(input.cloudSql.schema, SCHEMA_NAME, "cloudSql.schema"),
  };
  if (cloudSql.schema === "public" || cloudSql.schema === "information_schema" || cloudSql.schema.startsWith("pg_")) {
    fail("DESIRED_STATE_VALUE_INVALID:cloudSql.schema");
  }
  cloudSql.connectionName = `${project}:${region}:${cloudSql.instance}`;

  closedKeys(input.bucket, DESIRED_STATE_SHAPE.bucket, "bucket");
  const bucket = {
    name: text(input.bucket.name, BUCKET_NAME, "bucket.name"),
    location: text(input.bucket.location, /^[A-Z]+-[A-Z]+[0-9]{1,2}$/u, "bucket.location"),
    proof: null,
  };
  if (bucket.location !== region.toUpperCase()) fail("BUCKET_LOCATION_NOT_REGION");
  if (input.bucket.proof !== null) {
    closedKeys(input.bucket.proof, DESIRED_STATE_SHAPE.bucketProof, "bucket.proof");
    bucket.proof = {
      bucketGeneration: generation(input.bucket.proof.bucketGeneration, "bucket.proof.bucketGeneration"),
      bucketMetageneration: generation(input.bucket.proof.bucketMetageneration, "bucket.proof.bucketMetageneration"),
    };
  }

  closedKeys(input.service, DESIRED_STATE_SHAPE.service, "service");
  const service = {
    name: text(input.service.name, RESOURCE_NAME, "service.name"),
    maxInstances: integer(input.service.maxInstances, 1, 100, "service.maxInstances"),
    rolloutOverlapInstances: integer(input.service.rolloutOverlapInstances, 1, 100, "service.rolloutOverlapInstances"),
    audience: text(input.service.audience, AUDIENCE, "service.audience"),
    // null until assigned: it must equal the namespace the imported data
    // carries, so the service cannot render without it.
    telemetryStorageNamespace: input.service.telemetryStorageNamespace === null ? null
      : text(input.service.telemetryStorageNamespace, NAMESPACE, "service.telemetryStorageNamespace"),
  };
  if (/["'\\$]/u.test(service.audience)) fail("DESIRED_STATE_VALUE_INVALID:service.audience");
  if (service.rolloutOverlapInstances > service.maxInstances) {
    fail("DESIRED_STATE_VALUE_INVALID:service.rolloutOverlapInstances");
  }
  service.host = `${service.name}-${projectNumber}.${region}.run.app`;

  if (!isRecord(input.jobs) || Object.keys(input.jobs).sort().join() !== [...JOB_NAMES].sort().join()) {
    fail("JOB_NAMES_MISMATCH");
  }
  const jobs = {};
  for (const job of JOB_NAMES) {
    closedKeys(input.jobs[job], DESIRED_STATE_SHAPE.job, `jobs.${job}`);
    jobs[job] = {
      name: text(input.jobs[job].name, RESOURCE_NAME, `jobs.${job}.name`),
      maxConnections: integer(input.jobs[job].maxConnections, 1, 50, `jobs.${job}.maxConnections`),
    };
  }
  if (jobs["analytics-refresh"].maxConnections < analyticsRefreshPoolMax({ readSource })) {
    fail("JOB_POOL_MAX_UNDERDECLARED:analytics-refresh");
  }
  if (jobs["production-migrate"].maxConnections < PRODUCTION_MIGRATION_JOB.pools.primary) {
    fail("JOB_POOL_MAX_UNDERDECLARED:production-migrate");
  }
  if (jobs.maintenance.maxConnections < MAINTENANCE_JOB_CONTRACT.poolMax) {
    fail("JOB_POOL_MAX_UNDERDECLARED:maintenance");
  }

  if (!isRecord(input.scheduler)
      || Object.keys(input.scheduler).sort().join() !== [...SCHEDULED_JOB_NAMES].sort().join()) {
    fail("SCHEDULER_JOBS_MISMATCH");
  }
  const scheduler = {};
  for (const job of SCHEDULED_JOB_NAMES) {
    closedKeys(input.scheduler[job], DESIRED_STATE_SHAPE.trigger, `scheduler.${job}`);
    const schedule = input.scheduler[job].schedule;
    // No default cadence: null means not yet decided (D3), and nothing is created.
    if (schedule !== null && !validCron(schedule)) fail(`SCHEDULER_CADENCE_INVALID:${job}`);
    // A cadence the job's own contract fixes is not the desired state's to
    // choose, and is never "not yet decided" (null).
    if (Object.hasOwn(PINNED_SCHEDULER_CADENCES, job) && schedule !== PINNED_SCHEDULER_CADENCES[job]) {
      fail(`SCHEDULER_CADENCE_MISMATCH:${job}`);
    }
    const state = input.scheduler[job].state;
    if (!SCHEDULER_TRIGGER_STATES.includes(state)) fail(`DESIRED_STATE_VALUE_INVALID:scheduler.${job}.state`);
    // A trigger with no cadence has never been resumed (OPS-3 resumes only a
    // trigger that exists), so it can only be desired PAUSED.
    if (schedule === null && state !== "PAUSED") fail(`SCHEDULER_STATE_INVALID:${job}`);
    scheduler[job] = {
      name: text(input.scheduler[job].name, RESOURCE_NAME, `scheduler.${job}.name`),
      schedule,
      state,
    };
  }

  const runtimeIamUser = serviceAccounts.runtime.email.slice(0, -".gserviceaccount.com".length);
  const migratorIamUser = serviceAccounts.migrator.email.slice(0, -".gserviceaccount.com".length);

  const names = [
    // A shared plane lives in a test-estate project by design; every
    // resource it names must still be its own.
    ...(projectTenancy === "shared" ? [] : [["project", project]]),
    ["artifactRegistry.repository", artifactRegistry.repository],
    ["artifactRegistry.imageRepository", artifactRegistry.imageRepository],
    ["cloudSql.database", cloudSql.database],
    ["cloudSql.schema", cloudSql.schema],
    ["service.audience", service.audience],
    ...(service.telemetryStorageNamespace === null ? []
      : [["service.telemetryStorageNamespace", service.telemetryStorageNamespace]]),
    ...Object.entries(serviceAccounts).filter(([, account]) => account !== null)
      .flatMap(([role, account]) => [[`serviceAccounts.${role}.accountId`, account.accountId],
        [`serviceAccounts.${role}.email`, account.email]]),
    ["iamUser.runtime", runtimeIamUser],
    ["iamUser.migrator", migratorIamUser],
    ["plane:cloudSql.instance", cloudSql.instance],
    ["plane:bucket.name", bucket.name],
    // OPS-10 also requires the plane marker on the image repository and the
    // builder and verifier accounts it reads from rolloutTarget.
    ["plane:artifactRegistry.imageRepository", artifactRegistry.imageRepository],
    ["plane:serviceAccounts.builder.accountId", serviceAccounts.builder.accountId],
    ...(serviceAccounts.verifier === null ? []
      : [["plane:serviceAccounts.verifier.accountId", serviceAccounts.verifier.accountId]]),
    ["plane:service.name", service.name],
    ...JOB_NAMES.map((job) => [`plane:jobs.${job}.name`, jobs[job].name]),
    ...SCHEDULED_JOB_NAMES.map((job) => [`plane:scheduler.${job}.name`, scheduler[job].name]),
    // Secret Manager ids are project-wide: each one is the plane's own.
    ...Object.keys(secrets).map((name) => [`plane:secrets.${name}.secretName`, secrets[name].secretName]),
    ["cloudSql.connectionName", cloudSql.connectionName],
  ];
  nameChecks(names, environment);
  // OPS-10's job-context rule: the production migration job's name carries
  // the 'migrate' token (a 'test' token is refused above), or its entry
  // refuses to run.
  if (!jobs["production-migrate"].name.split("-").includes("migrate")) {
    fail("JOB_NAME_INVALID:jobs.production-migrate.name");
  }
  const resourceNames = [service.name, ...JOB_NAMES.map((job) => jobs[job].name)];
  if (new Set(resourceNames).size !== resourceNames.length) fail("CLOUD_RUN_NAMES_NOT_DISTINCT");
  // STG-PREP: the staging service's settings (null in production).
  const stagingOrigin = validateStagingOrigin(input.stagingOrigin, environment);

  const desired = {
    schemaVersion: GCP_OPS_INFRA_DESIRED_STATE_SCHEMA,
    environment,
    projectTenancy,
    project,
    projectNumber,
    region,
    synthetic: isSyntheticProject(project),
    artifactRegistry,
    serviceAccounts,
    customRole,
    secrets,
    cloudSql: { ...cloudSql, runtimeIamUser, migratorIamUser },
    bucket,
    service,
    jobs,
    scheduler,
    stagingOrigin,
  };
  const budget = connectionBudget(desired);
  if (!budget.fits) fail("CONNECTION_BUDGET_EXCEEDED");
  desired.connectionBudget = budget;
  return deepFreeze(desired);
}

export function sha256Hex(textValue) {
  return createHash("sha256").update(textValue, "utf8").digest("hex");
}

/** sha256 of the canonical JSON of a validated desired state. */
export function desiredStateDigest(desired) {
  return sha256Hex(canonicalJson(desired));
}

// ---------------------------------------------------------------------------
// Rendering: the IAM-private service from EP-7's template.

const YAML_UNSUPPORTED = /[^\n -~]/u;
const YAML_KEY = /^[A-Za-z][A-Za-z0-9._/-]*$/u;
const YAML_PLAIN = /^[A-Za-z][A-Za-z0-9._/-]*$/u;
const YAML_INTEGER = /^(?:0|[1-9][0-9]{0,8})$/u;
const YAML_AMBIGUOUS =
  /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|null|Null|NULL|True|TRUE|False|FALSE|true|false)$/u;

/**
 * The strict YAML subset of the EP-7 service template (block mappings and
 * sequences, single-quoted strings, identifier and integer plain scalars,
 * true, comments). Anything else is refused. The EP-7 check holds the
 * reference parser and compares this renderer's output with its own.
 */
export function parseTemplateYaml(source) {
  if (YAML_UNSUPPORTED.test(source)) fail("SERVICE_TEMPLATE_UNSUPPORTED");
  const lines = [];
  for (const raw of source.split("\n")) {
    const line = raw.replace(/ +$/u, "");
    if (line === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    lines.push({ indent, content: line.slice(indent) });
  }
  let index = 0;
  const scalar = (raw) => {
    if (raw.startsWith("'")) {
      let value = "";
      let position = 1;
      for (;;) {
        if (position >= raw.length) fail("SERVICE_TEMPLATE_UNSUPPORTED");
        if (raw[position] === "'") {
          if (raw[position + 1] === "'") { value += "'"; position += 2; continue; }
          position += 1;
          break;
        }
        value += raw[position];
        position += 1;
      }
      if (raw.slice(position) !== "" && !/^ +#/u.test(raw.slice(position))) fail("SERVICE_TEMPLATE_UNSUPPORTED");
      return value;
    }
    const plain = raw.replace(/ +#.*$/u, "");
    if (YAML_INTEGER.test(plain)) return Number(plain);
    if (plain === "true") return true;
    if (YAML_AMBIGUOUS.test(plain) || !YAML_PLAIN.test(plain)) fail("SERVICE_TEMPLATE_UNSUPPORTED");
    return plain;
  };
  const node = (indent) => (lines[index].content.startsWith("- ") || lines[index].content === "-"
    ? sequence(indent) : mapping(indent));
  const nested = (indent) => {
    if (index >= lines.length || lines[index].indent <= indent) fail("SERVICE_TEMPLATE_UNSUPPORTED");
    return node(lines[index].indent);
  };
  function mapping(indent) {
    const result = {};
    while (index < lines.length && lines[index].indent >= indent) {
      const line = lines[index];
      if (line.indent > indent || line.content.startsWith("-")) fail("SERVICE_TEMPLATE_UNSUPPORTED");
      const match = /^([^\s:]+):(?: +(.*))?$/u.exec(line.content);
      if (match === null || !YAML_KEY.test(match[1]) || YAML_AMBIGUOUS.test(match[1])
          || Object.hasOwn(result, match[1])) {
        fail("SERVICE_TEMPLATE_UNSUPPORTED");
      }
      index += 1;
      const rest = match[2] ?? "";
      result[match[1]] = rest === "" ? nested(indent) : scalar(rest);
    }
    return result;
  }
  function sequence(indent) {
    const items = [];
    while (index < lines.length && lines[index].indent >= indent) {
      const line = lines[index];
      if (line.indent > indent || !line.content.startsWith("- ")) fail("SERVICE_TEMPLATE_UNSUPPORTED");
      const rest = line.content.slice(2);
      if (/^[^\s:'"]+:(?: |$)/u.test(rest)) {
        lines[index] = { indent: indent + 2, content: rest };
        items.push(mapping(indent + 2));
      } else {
        index += 1;
        items.push(scalar(rest));
      }
    }
    return items;
  }
  if (lines.length === 0) fail("SERVICE_TEMPLATE_UNSUPPORTED");
  const value = node(0);
  if (index !== lines.length) fail("SERVICE_TEMPLATE_UNSUPPORTED");
  return value;
}

const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/gu;

function substituteStrings(value, values, used) {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (_, name) => {
      if (!Object.hasOwn(values, name)) fail(`SERVICE_RENDER_UNRESOLVED:${name}`);
      used.add(name);
      return values[name];
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substituteStrings(entry, values, used));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value)
      .map(([key, entry]) => [key, substituteStrings(entry, values, used)]));
  }
  return value;
}

function bucketProofValues(bucket) {
  if (bucket.proof === null) fail("SERVICE_RENDER_BUCKET_PROOF_UNPINNED");
  return {
    GCS_BUCKET_GENERATION: bucket.proof.bucketGeneration,
    GCS_BUCKET_METAGENERATION: bucket.proof.bucketMetageneration,
  };
}

/** The placeholder values for a desired state and the image it runs. */
export function serviceTemplateValues(desired, { imageDigest, sourceCommit }) {
  if (typeof imageDigest !== "string" || !IMAGE_DIGEST.test(imageDigest)) fail("SERVICE_RENDER_IMAGE_INVALID");
  if (typeof sourceCommit !== "string" || !SOURCE_COMMIT.test(sourceCommit)) {
    fail("SERVICE_RENDER_SOURCE_COMMIT_INVALID");
  }
  const values = {
    PROJECT: desired.project,
    REGION: desired.region,
    SERVICE: desired.service.name,
    RUNTIME_SA: desired.serviceAccounts.runtime.email,
    IMAGE_REPOSITORY: desired.artifactRegistry.imageRepository,
    IMAGE_DIGEST: imageDigest,
    SOURCE_COMMIT: sourceCommit,
    SERVICE_HOST: desired.service.host,
    AUDIENCE: desired.service.audience,
    EDGE_INVOKER_SA: desired.serviceAccounts.edgeInvoker.email,
    VERIFIER_SA: desired.serviceAccounts.verifier?.email ?? "",
    MAX_INSTANCES: String(desired.service.maxInstances),
    TELEMETRY_STORAGE_NAMESPACE: desired.service.telemetryStorageNamespace,
    PRIMARY_INSTANCE_CONNECTION_NAME: desired.cloudSql.connectionName,
    PRIMARY_DATABASE: desired.cloudSql.database,
    PRIMARY_SCHEMA: desired.cloudSql.schema,
    POSTGRES_IAM_USER: desired.cloudSql.runtimeIamUser,
    GCS_BUCKET_NAME: desired.bucket.name,
    // OD-2: the quarantine bucket's birth proof, as pinned from the OPS-2
    // bucket-birth receipt. An unborn bucket has no proof to render.
    ...bucketProofValues(desired.bucket),
  };
  for (const [name, secret] of Object.entries(desired.secrets)) {
    if (secret.version === null && secret.required) fail(`SECRET_VERSION_UNPINNED:${name}`);
    values[`SECRET_VERSION_${name}`] = secret.version ?? "";
  }
  // An optional secret the plane leaves out renders as an unpinned one: its entry is omitted.
  for (const name of OPTIONAL_SECRET_NAMES) {
    if (!Object.hasOwn(desired.secrets, name)) values[`SECRET_VERSION_${name}`] = "";
  }
  // STG-PREP: the staging template's own placeholders.
  return desired.environment === "staging" ? { ...values, ...stagingServiceTemplateValues(desired) } : values;
}

function readTemplate(path, readTemplateFile) {
  return readTemplateFile === undefined ? readFileSync(path, "utf8") : readTemplateFile(path);
}

function serviceTemplatePath(environment) {
  if (!Object.hasOwn(SERVICE_TEMPLATE_FILES, environment)) fail("GCP_INFRA_ENVIRONMENT_INVALID");
  return resolve(WORKER_ROOT, SERVICE_TEMPLATE_FILES[environment]);
}

/**
 * Renders EP-7's service template from a placeholder map (the same input the
 * EP-7 reference renderer takes) and returns the Knative Service object. An
 * optional secret whose version renders empty is omitted. Values must be
 * printable ASCII without a quote, dollar or backslash; the result must keep
 * the reviewed invariants (IAM-private, audience-bound, digest-pinned, no
 * deletion-ledger setting, CR-3 secrets only by secretKeyRef).
 */
export function renderServiceTemplateValues(values, { templateText, environment = "production" } = {}) {
  const template = parseTemplateYaml(templateText ?? readTemplate(serviceTemplatePath(environment)));
  const names = new Set();
  JSON.stringify(template).replace(PLACEHOLDER, (_, name) => names.add(name));
  for (const name of Object.keys(values)) {
    if (!names.has(name)) fail(`SERVICE_RENDER_UNUSED:${name}`);
    const value = values[name];
    if (typeof value !== "string" || /[^ -~]|['"$\\]/u.test(value)) fail(`SERVICE_RENDER_UNSAFE:${name}`);
  }
  const used = new Set();
  const service = substituteStrings(template, values, used);
  const optional = new Set(OPTIONAL_SECRET_NAMES);
  const container = service?.spec?.template?.spec?.containers?.[0];
  if (!isRecord(container) || !Array.isArray(container.env)) fail("SERVICE_TEMPLATE_SHAPE_INVALID");
  container.env = container.env.filter((entry) => !optional.has(entry.name)
    || entry.valueFrom?.secretKeyRef?.key !== "");
  assertServiceInvariants(service);
  // STG-PREP: each plane renders only from its own template.
  assertPlaneServiceInvariants(service, environment);
  return deepFreeze(service);
}

/**
 * Why the desired service's template cannot be rendered for any image, or
 * null: the environment has no service template (SERVICE_TEMPLATE_UNAVAILABLE),
 * the telemetry storage namespace is unassigned, a staging setting the
 * staging template needs is not yet there (stagingServiceBlocker).
 */
export function serviceTemplateBlocker(desired) {
  if (Object.hasOwn(SERVICE_TEMPLATE_UNAVAILABLE, desired.environment)) {
    return SERVICE_TEMPLATE_UNAVAILABLE[desired.environment];
  }
  if (desired.service.telemetryStorageNamespace === null) return "TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED";
  if (desired.environment === "staging") return stagingServiceBlocker(desired);
  return null;
}

/**
 * Why OPS-2 must not create or update the desired service yet, or null: its
 * template cannot render (serviceTemplateBlocker), or the origin image cannot
 * serve the environment's composition yet (SERVICE_COMPOSITION_PENDING).
 */
export function serviceRenderBlocker(desired) {
  return serviceTemplateBlocker(desired) ?? SERVICE_COMPOSITION_PENDING[desired.environment] ?? null;
}

/**
 * Points each secretKeyRef of a rendered service at the desired state's
 * Secret Manager secret for that variable (EP-7's template names the
 * variable; the secret id is the desired state's), and checks the result:
 * every reference is the mapped secret at a pinned version.
 */
function withSecretNames(service, secrets) {
  const container = service.spec.template.spec.containers[0];
  const env = container.env.map((entry) => {
    if (entry.valueFrom?.secretKeyRef === undefined) return entry;
    const secret = secrets[entry.name];
    if (secret === undefined) fail("SERVICE_RENDER_INVARIANT_BROKEN");
    return { ...entry, valueFrom: { secretKeyRef: { ...entry.valueFrom.secretKeyRef, name: secret.secretName } } };
  });
  const renamed = structuredClone(service);
  renamed.spec.template.spec.containers[0].env = env;
  for (const entry of env) {
    const reference = entry.valueFrom?.secretKeyRef;
    if (reference !== undefined && (reference.name !== secrets[entry.name].secretName
        || reference.key !== secrets[entry.name].version)) {
      fail("SERVICE_RENDER_INVARIANT_BROKEN");
    }
  }
  return deepFreeze(renamed);
}

/** Renders the desired service for an image (live or bootstrap). */
export function renderService(desired, image, options = {}) {
  const blocker = serviceTemplateBlocker(desired);
  if (blocker !== null) fail(blocker);
  return withSecretNames(renderServiceTemplateValues(serviceTemplateValues(desired, image),
    { ...options, environment: desired.environment }), desired.secrets);
}

/**
 * OD-2: exactly one plain GCS_QUARANTINE_BUCKET_HISTORY_PROOF whose closed
 * proof record names the rendered GCS_BUCKET_NAME with soft delete "0".
 */
function quarantineProofMatchesBucket(env) {
  const proofs = env.filter((entry) => entry.name === "GCS_QUARANTINE_BUCKET_HISTORY_PROOF");
  const bucket = env.find((entry) => entry.name === "GCS_BUCKET_NAME")?.value;
  if (proofs.length !== 1 || typeof proofs[0].value !== "string" || proofs[0].valueFrom !== undefined) return false;
  let proof;
  try { proof = JSON.parse(proofs[0].value); } catch { return false; }
  return isRecord(proof)
    && Object.keys(proof).join(",") === "bucket,bucketGeneration,bucketMetageneration,softDeleteRetentionDurationSeconds"
    && proof.bucket === bucket && GENERATION.test(proof.bucketGeneration)
    && GENERATION.test(proof.bucketMetageneration) && proof.softDeleteRetentionDurationSeconds === "0";
}

function assertServiceInvariants(service) {
  const annotations = service?.metadata?.annotations ?? {};
  const revision = service?.spec?.template?.spec ?? {};
  const container = revision.containers?.[0] ?? {};
  const env = Array.isArray(container.env) ? container.env : [];
  let audiences;
  try { audiences = JSON.parse(annotations["run.googleapis.com/custom-audiences"]); } catch { audiences = null; }
  const audience = env.find((entry) => entry.name === "EDGE_ORIGIN_AUDIENCE")?.value;
  const secretNames = new Set([...REQUIRED_SECRET_NAMES, ...OPTIONAL_SECRET_NAMES]);
  const problems = [
    service?.apiVersion !== "serving.knative.dev/v1" || service?.kind !== "Service",
    annotations["run.googleapis.com/ingress"] !== "all",
    annotations["run.googleapis.com/invoker-iam-disabled"] !== "false",
    !Array.isArray(audiences) || audiences.length !== 1 || audiences[0] !== audience,
    typeof container.image !== "string" || !/^[a-z0-9.-]+\/[^@:\s]+@sha256:[a-f0-9]{64}$/u.test(container.image),
    (revision.containers ?? []).length !== 1,
    env.some((entry) => /^LEDGER_|^GCS_ERASURE_BUCKET_HISTORY_PROOF$|^EDGE_PROOF_|^SPARKLE_/u.test(entry.name)
      || EDGE_ONLY_SECRET_NAMES.includes(entry.name)),
    !quarantineProofMatchesBucket(env),
    env.some((entry) => (entry.valueFrom !== undefined) !== secretNames.has(entry.name)),
    env.some((entry) => entry.valueFrom !== undefined
      && (entry.valueFrom.secretKeyRef?.name !== entry.name || !SECRET_VERSION.test(entry.valueFrom.secretKeyRef.key))),
    REQUIRED_SECRET_NAMES.some((name) => !env.some((entry) => entry.name === name)),
    /allUsers|allAuthenticatedUsers/u.test(JSON.stringify(service)),
  ];
  if (problems.some(Boolean)) fail("SERVICE_RENDER_INVARIANT_BROKEN");
}

/**
 * The service's invoker policy from EP-7's IAM template: roles/run.invoker for
 * the edge invoker and, when present, the verifier; no project role for
 * either. Rendered by substitution, then checked closed.
 */
export function renderEdgeIamPolicy(desired, { templateText } = {}) {
  const raw = templateText ?? readTemplate(IAM_TEMPLATE_PATH);
  let template;
  try { template = JSON.parse(raw); } catch { fail("IAM_TEMPLATE_INVALID"); }
  const binding = template?.servicePolicy?.bindings;
  if (template?.schema !== "tibotattle-production-edge-iam-template-v1" || !Array.isArray(binding)
      || binding.length !== 1 || binding[0].role !== RUN_INVOKER_ROLE
      || JSON.stringify(binding[0].members) !== JSON.stringify(["serviceAccount:${EDGE_INVOKER_SA}"])
      || JSON.stringify(binding[0].optionalMembers ?? []) !== JSON.stringify(["serviceAccount:${VERIFIER_SA}"])
      || !isRecord(template.projectRoles)
      || Object.values(template.projectRoles).some((roles) => !Array.isArray(roles) || roles.length !== 0)) {
    fail("IAM_TEMPLATE_INVALID");
  }
  const invoker = desired.serviceAccounts.edgeInvoker.member;
  const verifier = desired.serviceAccounts.verifier?.member ?? null;
  return deepFreeze({
    bindings: [{ role: RUN_INVOKER_ROLE, members: verifier === null ? [invoker] : [invoker, verifier] }],
    projectRoles: Object.fromEntries((verifier === null ? [invoker] : [invoker, verifier]).map((member) => [member, []])),
  });
}

// ---------------------------------------------------------------------------
// Rendering: jobs, scheduler, Cloud SQL, conditional bucket grant.

/**
 * The JSON text of the quarantine bucket's birth proof the maintenance job's
 * configuration parses (OD-2): the service template's own closed four-key
 * record for GCS_BUCKET_NAME. An unborn bucket has no proof to render.
 */
function bucketProofJson(desired) {
  if (desired.bucket.proof === null) fail("JOB_RENDER_BUCKET_PROOF_UNPINNED");
  return JSON.stringify({
    bucket: desired.bucket.name,
    bucketGeneration: desired.bucket.proof.bucketGeneration,
    bucketMetageneration: desired.bucket.proof.bucketMetageneration,
    softDeleteRetentionDurationSeconds: "0",
  });
}

/**
 * Why a job cannot be rendered for this environment, or null: the job does not
 * exist there (JOB_ENVIRONMENT_UNAVAILABLE), it reads the telemetry storage
 * namespace and the desired state has not assigned it yet (it must equal the
 * namespace the imported data carries, as for the service), or it reads the
 * staging plane's own values and the stagingOrigin block or its Access AUD is
 * not there yet (stagingOriginBlocker, the codes the staging service defers
 * with).
 */
export function jobRenderBlocker(desired, job) {
  if (!JOB_NAMES.includes(job)) fail("JOB_NAME_UNKNOWN");
  const unavailable = JOB_ENVIRONMENT_UNAVAILABLE[job];
  if (unavailable !== undefined && Object.hasOwn(unavailable, desired.environment)) {
    return unavailable[desired.environment];
  }
  const definition = jobDefinition(desired, job);
  if (definition.env.includes("TELEMETRY_STORAGE_NAMESPACE")
      && desired.service.telemetryStorageNamespace === null) {
    return "TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED";
  }
  if (definition.env.includes("PUBLIC_ORIGIN")) return stagingOriginBlocker(desired);
  return null;
}

/** One job's plain env as name/value pairs, in definition order. */
function jobEnv(desired, job, sourceCommit) {
  // Thunks: a value is computed only for a job that names it, so one that
  // cannot be computed (an unpinned proof) never blocks another job's render.
  const values = {
    ANALYTICS_REFRESH_TARGET: () => desired.environment,
    ANALYTICS_V2_MEMORY_BUDGET_MIB: () => String(ANALYTICS_REFRESH_TASK_PROFILE.memoryBudgetMiB),
    MIGRATION_ENVIRONMENT: () => desired.environment,
    GOOGLE_CLOUD_PROJECT: () => desired.project,
    PRODUCTION_MIGRATOR_SERVICE_ACCOUNT: () => desired.serviceAccounts.migrator.email,
    // The environment's configured primary: the migration job's target is
    // that instance itself (a scratch rehearsal instance is never rendered).
    ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME: () => desired.cloudSql.connectionName,
    PRIMARY_INSTANCE_CONNECTION_NAME: () => desired.cloudSql.connectionName,
    PRIMARY_DATABASE: () => desired.cloudSql.database,
    PRIMARY_SCHEMA: () => desired.cloudSql.schema,
    POSTGRES_IAM_USER: () => desired.cloudSql.runtimeIamUser,
    POSTGRES_MIGRATOR_IAM_USER: () => desired.cloudSql.migratorIamUser,
    POSTGRES_RUNTIME_IAM_USER: () => desired.cloudSql.runtimeIamUser,
    DEPLOYMENT_SOURCE_COMMIT: () => sourceCommit,
    TELEMETRY_STORAGE_NAMESPACE: () => desired.service.telemetryStorageNamespace,
    GCS_BUCKET_NAME: () => desired.bucket.name,
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: () => bucketProofJson(desired),
    POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: () => "enabled",
    // The staging plane's own values, from the stagingOrigin block and the
    // inert identity-provider identifiers, exactly as the staging service
    // renders them (stagingServiceTemplateValues and its template).
    PUBLIC_ORIGIN: () => desired.stagingOrigin.publicOrigin,
    ADMIN_HOST_ORIGIN: () => desired.stagingOrigin.adminOrigin,
    ACCESS_TEAM_DOMAIN: () => desired.stagingOrigin.accessTeamDomain,
    ACCESS_AUD: () => desired.stagingOrigin.accessAud,
    ACCESS_ADMIN_EMAIL: () => desired.stagingOrigin.accessAdminEmail,
    IDENTITY_LINK_SECRET_VERSION: () => desired.stagingOrigin.identityLinkSecretVersion,
    GOOGLE_OIDC_CLIENT_ID: () => STAGING_INERT_IDENTITY_PROVIDER_VARS.GOOGLE_OIDC_CLIENT_ID,
    APPLE_SERVICES_ID: () => STAGING_INERT_IDENTITY_PROVIDER_VARS.APPLE_SERVICES_ID,
    APPLE_KEY_ID: () => STAGING_INERT_IDENTITY_PROVIDER_VARS.APPLE_KEY_ID,
    APPLE_TEAM_ID: () => STAGING_INERT_IDENTITY_PROVIDER_VARS.APPLE_TEAM_ID,
  };
  return jobDefinition(desired, job).env.map((name) => {
    if (!Object.hasOwn(values, name)) fail(`JOB_RENDER_ENV_UNRESOLVED:${name}`);
    return { name, value: values[name]() };
  });
}

/**
 * The secrets a job reads that the desired state carries: the job definition's
 * list, less an unread optional secret a production file leaves out
 * (UNREAD_PRODUCTION_SECRET_NAMES; the maintenance job's
 * DISTRIBUTION_GITHUB_API_TOKEN). Any other absent name is refused
 * (JOB_RENDER_SECRET_UNKNOWN).
 */
export function jobSecretNames(desired, job) {
  return (jobDefinition(desired, job).secrets ?? []).filter((name) => {
    if (Object.hasOwn(desired.secrets, name)) return true;
    if (desired.environment === "production" && UNREAD_PRODUCTION_SECRET_NAMES.includes(name)) return false;
    return fail(`JOB_RENDER_SECRET_UNKNOWN:${name}`);
  });
}

/**
 * One job's secret env: each secret by Secret Manager reference at its pinned
 * version, as the service renders them. A required secret with no pinned
 * version cannot be rendered; an optional one is omitted, as is an unread one
 * a production file leaves out (jobSecretNames).
 */
function jobSecretEnv(desired, job) {
  return jobSecretNames(desired, job).flatMap((name) => {
    const secret = desired.secrets[name];
    if (secret.version === null) {
      if (secret.required) fail(`SECRET_VERSION_UNPINNED:${name}`);
      return [];
    }
    return [{ name, valueFrom: { secretKeyRef: { name: secret.secretName, key: secret.version } } }];
  });
}

/** A Cloud Run Job (run.googleapis.com/v1) for `gcloud run jobs replace`. */
export function renderJob(desired, job, { imageDigest, sourceCommit }) {
  if (!JOB_NAMES.includes(job)) fail("JOB_NAME_UNKNOWN");
  if (typeof imageDigest !== "string" || !IMAGE_DIGEST.test(imageDigest)) fail("JOB_RENDER_IMAGE_INVALID");
  if (typeof sourceCommit !== "string" || !SOURCE_COMMIT.test(sourceCommit)) fail("JOB_RENDER_SOURCE_COMMIT_INVALID");
  const blocker = jobRenderBlocker(desired, job);
  if (blocker !== null) fail(blocker);
  const definition = jobDefinition(desired, job);
  return deepFreeze({
    apiVersion: "run.googleapis.com/v1",
    kind: "Job",
    metadata: {
      name: desired.jobs[job].name,
      namespace: desired.project,
      labels: { "cloud.googleapis.com/location": desired.region },
    },
    spec: {
      template: {
        spec: {
          parallelism: 1,
          taskCount: 1,
          template: {
            spec: {
              maxRetries: 0,
              timeoutSeconds: String(definition.timeoutSeconds),
              serviceAccountName: desired.serviceAccounts[definition.account].email,
              containers: [{
                image: `${desired.artifactRegistry.imageRepository}@sha256:${imageDigest}`,
                command: ["node"],
                args: [...definition.args],
                env: [...jobEnv(desired, job, sourceCommit), ...jobSecretEnv(desired, job)],
                resources: { limits: { cpu: definition.cpu, memory: definition.memory } },
              }],
            },
          },
        },
      },
    },
  });
}

/** The Cloud Run Admin v2 jobs:run URI a scheduler trigger posts to. */
export function jobRunUri(desired, job) {
  return `https://run.googleapis.com/v2/projects/${desired.project}/locations/${desired.region}/jobs/${
    desired.jobs[job].name}:run`;
}

/** The scheduler trigger flags (shared by create and update). */
export function schedulerFlags(desired, job) {
  const trigger = desired.scheduler[job];
  if (trigger.schedule === null) fail("SCHEDULER_CADENCE_UNSET");
  return Object.freeze([
    `--project=${desired.project}`,
    `--location=${desired.region}`,
    `--schedule=${trigger.schedule}`,
    `--time-zone=${SCHEDULER_TIME_ZONE}`,
    `--uri=${jobRunUri(desired, job)}`,
    "--http-method=POST",
    `--oauth-service-account-email=${desired.serviceAccounts.scheduler.email}`,
    `--oauth-token-scope=${SCHEDULER_OAUTH_SCOPE}`,
    "--max-retry-attempts=0",
  ]);
}

/** Every database flag, sorted by name, max_connections included. */
export function databaseFlags(desired) {
  return Object.freeze(Object.entries({
    ...CLOUD_SQL_LOGGING_FLAGS,
    max_connections: String(desired.cloudSql.maxConnections),
  }).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => Object.freeze({ name, value })));
}

export function databaseFlagsArgument(desired) {
  return `--database-flags=${databaseFlags(desired).map(({ name, value }) => `${name}=${value}`).join(",")}`;
}

/** OPS-1's backup flags and the settings readback expects. */
export function backupConfiguration(desired) {
  return desiredBackupConfiguration({ region: desired.region, backupStartTime: desired.cloudSql.backupStartTime });
}

/** `gcloud sql instances create` arguments for the one instance. */
export function cloudSqlCreateArgs(desired) {
  const backup = backupConfiguration(desired);
  return Object.freeze([
    "sql", "instances", "create", desired.cloudSql.instance,
    `--project=${desired.project}`,
    `--region=${desired.region}`,
    `--database-version=${CLOUD_SQL_POSTURE.databaseVersion}`,
    `--edition=${CLOUD_SQL_POSTURE.edition}`,
    `--tier=${desired.cloudSql.tier}`,
    `--availability-type=${CLOUD_SQL_POSTURE.availabilityType}`,
    "--storage-type=SSD",
    `--storage-size=${desired.cloudSql.storageSizeGb}GB`,
    "--storage-auto-increase",
    "--deletion-protection",
    "--assign-ip",
    `--connector-enforcement=${CLOUD_SQL_POSTURE.connectorEnforcement}`,
    "--no-insights-config-query-insights-enabled",
    ...backup.flags,
    ...backup.finalBackupFlags,
    databaseFlagsArgument(desired),
  ]);
}

/** The conditional project binding: the custom role on the production bucket only. */
export function quarantineStoreCondition(desired) {
  const bucket = desired.bucket.name;
  return Object.freeze({
    title: QUARANTINE_STORE_CONDITION_TITLE,
    expression: `(resource.type == "storage.googleapis.com/Bucket" && resource.name == "projects/_/buckets/${
      bucket}") || (resource.type == "storage.googleapis.com/Object" && resource.name.startsWith(`
      + `"projects/_/buckets/${bucket}/objects/"))`,
  });
}

/**
 * Every project binding the managed accounts hold: each account's project
 * roles (unconditional) and the runtime's conditional custom role.
 */
export function desiredProjectBindings(desired) {
  const bindings = [];
  for (const role of SERVICE_ACCOUNT_ROLES) {
    const account = desired.serviceAccounts[role];
    if (account === null) continue;
    for (const projectRole of account.projectRoles) {
      bindings.push({ member: account.member, role: projectRole, condition: null });
    }
  }
  bindings.push({
    member: desired.serviceAccounts.runtime.member,
    role: desired.customRole.name,
    condition: quarantineStoreCondition(desired),
  });
  return deepFreeze(bindings);
}

/** The bucket posture as a JSON API insert body (bucket-birth). */
export function bucketInsertBody(desired) {
  return deepFreeze({
    name: desired.bucket.name,
    location: desired.bucket.location,
    storageClass: BUCKET_POSTURE.storageClass,
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true },
      publicAccessPrevention: BUCKET_POSTURE.publicAccessPrevention,
    },
    softDeletePolicy: { retentionDurationSeconds: BUCKET_POSTURE.softDeleteRetentionDurationSeconds },
    versioning: { enabled: false },
  });
}

/** Reads and validates a desired-state JSON file. */
export function readDesiredStateFile(path, { readFile = (target) => readFileSync(target, "utf8"), readSource } = {}) {
  let parsed;
  try { parsed = JSON.parse(readFile(path)); } catch { fail("DESIRED_STATE_UNREADABLE"); }
  return validateDesiredState(parsed, readSource === undefined ? {} : { readSource });
}

/** The absolute path of an environment's committed desired-state file. */
export function committedDesiredStatePath(environment) {
  if (!GCP_OPS_INFRA_ENVIRONMENTS.includes(environment)) fail("GCP_INFRA_ENVIRONMENT_INVALID");
  return resolve(WORKER_ROOT, COMMITTED_DESIRED_STATE_FILES[environment]);
}

/**
 * The committed-file policy on top of the validator: a committed desired
 * state is never synthetic and always names the verifier (OD-CR-7), so OPS-10
 * and the read-only verifier smoke have an account to read through.
 */
export function assertCommittedDesiredState(desired) {
  if (desired.synthetic) fail("COMMITTED_DESIRED_STATE_SYNTHETIC");
  if (desired.serviceAccounts.verifier === null) fail("COMMITTED_DESIRED_STATE_VERIFIER_REQUIRED");
  return desired;
}

/**
 * An environment's committed desired state, validated, describing that
 * environment and meeting the committed-file policy. A file with an unfilled
 * owner placeholder refuses DESIRED_STATE_PLACEHOLDER_UNFILLED.
 */
export function loadCommittedDesiredState(environment, { readFile, readSource } = {}) {
  const desired = readDesiredStateFile(committedDesiredStatePath(environment), {
    ...(readFile === undefined ? {} : { readFile }),
    ...(readSource === undefined ? {} : { readSource }),
  });
  return assertCommittedDesiredState(requireEnvironment(desired, environment));
}

/** A validated desired state that must describe `environment`. */
export function requireEnvironment(desired, environment) {
  if (!GCP_OPS_INFRA_ENVIRONMENTS.includes(environment)) fail("GCP_INFRA_ENVIRONMENT_INVALID");
  if (desired.environment !== environment) fail("GCP_INFRA_ENVIRONMENT_MISMATCH");
  return desired;
}

/**
 * The Cloud Run Jobs OPS-2 deploys: JOB_NAMES less the deferred ones and, for
 * a desired state, the jobs its environment cannot have
 * (JOB_ENVIRONMENT_UNAVAILABLE).
 */
export function deployedJobNames(desired = null) {
  return Object.freeze(JOB_NAMES.filter((job) => !Object.hasOwn(DEFERRED_JOBS, job)
    && (desired === null || JOB_ENVIRONMENT_UNAVAILABLE[job]?.[desired.environment] === undefined)));
}

/** The keys of OPS-10's closed RolloutTarget (scripts/gcp-production-rollout.mjs). */
export const ROLLOUT_TARGET_KEYS = Object.freeze([
  "environment", "project", "region", "service", "migrationJob", "jobNames", "primaryInstance",
  "imageRepository", "builderServiceAccount", "verifierServiceAccount", "originAudience", "maintenanceJob",
]);

/**
 * The JOB_NAMES key of the MP-2-lite maintenance Job (C-MAINT's
 * dist/postgres-maintenance-job.mjs, added to JOB_NAMES by D-OPS4). A
 * RolloutTarget names it only when the environment deploys it
 * (deployedJobNames(desired)). Both planes deploy it: staging renders the
 * staging-maintenance-job profile from its stagingOrigin block
 * (STAGING-MAINT-RENDER). A target whose environment could not have it
 * (JOB_ENVIRONMENT_UNAVAILABLE) would carry null, and OPS-10's roll refuses
 * the origin-verifier path there (ROLLOUT_MAINTENANCE_JOB_REQUIRED), because
 * only a lifecycle pass makes a new origin's /api/ready read ready (D-CRB).
 */
export const MAINTENANCE_JOB_KEY = "maintenance";

/**
 * OPS-10's RolloutTarget for a validated desired state: the service, the
 * deployed jobs (a deferred job does not exist, so the rollout never moves
 * it), the one primary instance, the image repository, the builder, and the
 * EP-6 verifier path roll reads /api/health through while the edge is not in
 * gcp mode: the verifier account and the origin's ID-token audience. A
 * rollout needs the verifier and the operator's token-creator grant on it, so
 * a desired state without either is refused (ROLLOUT_TARGET_VERIFIER_REQUIRED,
 * ROLLOUT_TARGET_VERIFIER_TOKEN_CREATOR_UNASSIGNED).
 */
export function rolloutTargetFromDesiredState(desired) {
  if (desired.synthetic) fail("ROLLOUT_TARGET_SYNTHETIC_REFUSED");
  if (desired.serviceAccounts.verifier === null) fail("ROLLOUT_TARGET_VERIFIER_REQUIRED");
  if (desired.serviceAccounts.verifier.tokenCreators === null) fail("ROLLOUT_TARGET_VERIFIER_TOKEN_CREATOR_UNASSIGNED");
  // One list for both keys: the maintenance Job is the target's only when
  // this environment deploys it, so it is always one of jobNames.
  const deployed = deployedJobNames(desired);
  return deepFreeze({
    environment: desired.environment,
    project: desired.project,
    region: desired.region,
    service: desired.service.name,
    migrationJob: desired.jobs["production-migrate"].name,
    jobNames: deployed.map((job) => desired.jobs[job].name),
    primaryInstance: desired.cloudSql.instance,
    imageRepository: desired.artifactRegistry.imageRepository,
    builderServiceAccount: desired.serviceAccounts.builder.email,
    verifierServiceAccount: desired.serviceAccounts.verifier.email,
    originAudience: desired.service.audience,
    maintenanceJob: deployed.includes(MAINTENANCE_JOB_KEY) ? desired.jobs[MAINTENANCE_JOB_KEY].name : null,
  });
}

/**
 * OPS-10's entry point: the environment's RolloutTarget, from its committed
 * desired state (loadCommittedDesiredState). There is no other source.
 */
export function rolloutTarget(environment, { readFile, readSource } = {}) {
  return rolloutTargetFromDesiredState(loadCommittedDesiredState(environment, { readFile, readSource }));
}

// ---------------------------------------------------------------------------
// STG-PREP: the staging service (OD-CR-8 HOST_MODE=staging, OD-2 proof).
//
// Kept in its own section so the D-OPS4 (maintenance job and probes) and
// C-SIMP (OD-2 in EP-7 and CR-3) merges touch nothing here. The staging
// service renders from cloud-run/staging-service.template.yaml with the
// committed desired state's stagingOrigin block, the pinned secret versions
// and the pinned bucket-birth proof.

/**
 * Services whose template renders but whose origin image cannot serve the
 * environment's composition yet, by environment, with the reason. OPS-2
 * defers their create and update (serviceRenderBlocker), so an apply never
 * replaces a service with a revision that cannot start; renderService still
 * renders them for review. None today: D-CRB (CR-6/CR-7 phase B) composes
 * HOST_MODE production and staging in cloud-run/server.mjs, so the staging
 * entry (STAGING_HOST_COMPOSITION_PENDING) was removed when D-CRB and
 * STG-PREP met on the fast-path final line. The mechanism stays for a plane
 * whose composition is withdrawn.
 */
export const SERVICE_COMPOSITION_PENDING = Object.freeze({});

/**
 * The inert synthetic identity-provider identifier the staging template
 * carries literally (CR-3's staging plane still requires the public Google
 * client id). It names no registered Google client. Round 12 retired Google
 * and Apple sign-in, so the plane mounts no sign-in secret and carries no
 * Apple setting at all.
 */
export const STAGING_INERT_IDENTITY_PROVIDER_VARS = Object.freeze({
  GOOGLE_OIDC_CLIENT_ID: "000000000000-tibotattlestaginginert.apps.googleusercontent.com",
});

/** Every env name the staging service carries, in template order (the optional token may be omitted). */
export const STAGING_SERVICE_ENV_NAMES = Object.freeze([
  "HOST", "HOST_MODE", "HOST_ORIGIN", "PUBLIC_ORIGIN", "ADMIN_HOST_ORIGIN", "DEPLOYMENT_SOURCE_COMMIT",
  "EDGE_ORIGIN_MODE", "EDGE_ORIGIN_AUDIENCE", "EDGE_INVOKER_SERVICE_ACCOUNT", "EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS",
  "TELEMETRY_STORAGE_NAMESPACE", "STAGING_ADMISSION_MODE", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ACCESS_ADMIN_EMAIL",
  "IDENTITY_LINK_SECRET_VERSION", "GOOGLE_OIDC_CLIENT_ID",
  "PRIMARY_INSTANCE_CONNECTION_NAME", "PRIMARY_DATABASE", "PRIMARY_SCHEMA", "POSTGRES_IAM_USER", "GCS_BUCKET_NAME",
  "GCS_QUARANTINE_BUCKET_HISTORY_PROOF", ...REQUIRED_SECRET_NAMES, ...OPTIONAL_SECRET_NAMES,
]);
/** OD-2: the quarantine bucket's birth proof setting (C-SIMP re-admits it in CR-3 and EP-7). */
export const QUARANTINE_BUCKET_HISTORY_PROOF_ENV = "GCS_QUARANTINE_BUCKET_HISTORY_PROOF";
const QUARANTINE_PROOF_KEYS = "bucket,bucketGeneration,bucketMetageneration,softDeleteRetentionDurationSeconds";
export const STAGING_ADMIN_HOST_PREFIX = "admin.";

const ACCESS_AUD_PATTERN = /^[a-f0-9]{64}$/u;
const ACCESS_TEAM_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u;
const ADMIN_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,187}[a-z0-9])?\.[a-z]{2,}$/u;
const IDENTITY_LINK_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DNS_HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function productionFingerprintValues() {
  const values = new Set();
  for (const value of Object.values(PRODUCTION_RESOURCE_FINGERPRINT)) {
    for (const item of Array.isArray(value) ? value : [value]) values.add(item);
  }
  return values;
}
const PRODUCTION_FINGERPRINT = productionFingerprintValues();

/** A canonical https origin of the staging edge's public host, or null. */
function stagingPublicOrigin(value) {
  if (typeof value !== "string" || value.length > 256) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.origin !== value || url.port !== "" || url.username !== ""
      || !DNS_HOST_PATTERN.test(url.hostname) || url.hostname.startsWith(STAGING_ADMIN_HOST_PREFIX)
      || url.hostname.endsWith(".run.app")) {
    return null;
  }
  return url;
}

function stagingOriginField(value, pattern, path) {
  if (typeof value !== "string" || !pattern.test(value) || /["'$\\]/u.test(value)) {
    fail(`DESIRED_STATE_VALUE_INVALID:stagingOrigin.${path}`);
  }
  if (PRODUCTION_FINGERPRINT.has(value)) fail(`STAGING_ORIGIN_PRODUCTION_VALUE_FORBIDDEN:stagingOrigin.${path}`);
  return value;
}

/**
 * The staging service's own non-secret settings. Production carries null
 * (STAGING_ORIGIN_FORBIDDEN:production otherwise). Staging may carry null
 * until they are chosen, which only defers its service
 * (STAGING_ORIGIN_UNASSIGNED); accessAud may be null until the owner creates
 * the staging admin Access application (staging edge plan phase C). Every
 * value is closed to CR-3's grammar for its variable and never a production
 * value: the public origin is the staging edge's https origin, carrying the
 * staging token, never a run.app or admin host.
 */
export function validateStagingOrigin(value, environment) {
  if (environment !== "staging") {
    if (value !== null) fail(`STAGING_ORIGIN_FORBIDDEN:${environment}`);
    return null;
  }
  if (value === null) return null;
  closedKeys(value, DESIRED_STATE_SHAPE.stagingOrigin, "stagingOrigin");
  const url = stagingPublicOrigin(value.publicOrigin);
  if (url === null) fail("DESIRED_STATE_VALUE_INVALID:stagingOrigin.publicOrigin");
  if (PRODUCTION_FINGERPRINT.has(url.origin) || PRODUCTION_FINGERPRINT.has(url.hostname)
      || PRODUCTION_MARKER.test(url.hostname)) {
    fail("STAGING_ORIGIN_PRODUCTION_VALUE_FORBIDDEN:stagingOrigin.publicOrigin");
  }
  if (!STAGING_MARKER.test(url.hostname)) fail("DESIRED_STATE_STAGING_MARKER_MISSING:stagingOrigin.publicOrigin");
  const identityLinkSecretVersion = stagingOriginField(value.identityLinkSecretVersion, IDENTITY_LINK_VERSION_PATTERN,
    "identityLinkSecretVersion");
  if (!STAGING_MARKER.test(identityLinkSecretVersion)) {
    fail("DESIRED_STATE_STAGING_MARKER_MISSING:stagingOrigin.identityLinkSecretVersion");
  }
  if (!Object.hasOwn(STAGING_ADMISSION_MODES, value.admissionMode)) {
    fail("DESIRED_STATE_VALUE_INVALID:stagingOrigin.admissionMode");
  }
  return Object.freeze({
    publicOrigin: url.origin,
    adminOrigin: `https://${STAGING_ADMIN_HOST_PREFIX}${url.hostname}`,
    accessTeamDomain: stagingOriginField(value.accessTeamDomain, ACCESS_TEAM_DOMAIN_PATTERN, "accessTeamDomain"),
    accessAud: value.accessAud === null ? null : stagingOriginField(value.accessAud, ACCESS_AUD_PATTERN, "accessAud"),
    accessAdminEmail: stagingOriginField(value.accessAdminEmail, ADMIN_EMAIL_PATTERN, "accessAdminEmail"),
    identityLinkSecretVersion,
    admissionMode: value.admissionMode,
  });
}

/**
 * Why the staging template cannot render yet, or null: no stagingOrigin
 * block, no Access AUD, or no pinned bucket-birth proof (OD-2: the service
 * reads the proof, so an unborn bucket has nothing to render; the code is
 * C-SIMP's).
 */
export function stagingServiceBlocker(desired) {
  return stagingOriginBlocker(desired)
    ?? (desired.bucket.proof === null ? "SERVICE_RENDER_BUCKET_PROOF_UNPINNED" : null);
}

/**
 * Why the staging plane's own values cannot render yet, or null: no
 * stagingOrigin block, or no Access AUD. The staging service and the staging
 * maintenance job both read them, and both defer with these codes.
 */
export function stagingOriginBlocker(desired) {
  if (desired.stagingOrigin === null) return "STAGING_ORIGIN_UNASSIGNED";
  if (desired.stagingOrigin.accessAud === null) return "STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud";
  return null;
}

/** The staging template's own placeholder values (the EP-7 ones come from serviceTemplateValues). */
export function stagingServiceTemplateValues(desired) {
  if (desired.environment !== "staging") fail("STAGING_ORIGIN_FORBIDDEN:production");
  const blocker = stagingServiceBlocker(desired);
  if (blocker !== null) fail(blocker);
  const origin = desired.stagingOrigin;
  return {
    PUBLIC_ORIGIN: origin.publicOrigin,
    ADMIN_HOST_ORIGIN: origin.adminOrigin,
    ACCESS_TEAM_DOMAIN: origin.accessTeamDomain,
    ACCESS_AUD: origin.accessAud,
    ACCESS_ADMIN_EMAIL: origin.accessAdminEmail,
    IDENTITY_LINK_SECRET_VERSION: origin.identityLinkSecretVersion,
    STAGING_ADMISSION_MODE: origin.admissionMode,
    GCS_BUCKET_GENERATION: desired.bucket.proof.bucketGeneration,
    GCS_BUCKET_METAGENERATION: desired.bucket.proof.bucketMetageneration,
  };
}

/** OD-2: exactly one plain proof whose closed record names the rendered bucket with soft delete "0". */
function quarantineProofNamesBucket(env) {
  const proofs = env.filter((entry) => entry.name === QUARANTINE_BUCKET_HISTORY_PROOF_ENV);
  const bucket = env.find((entry) => entry.name === "GCS_BUCKET_NAME")?.value;
  if (proofs.length !== 1 || typeof proofs[0].value !== "string" || proofs[0].valueFrom !== undefined) return false;
  let proof;
  try { proof = JSON.parse(proofs[0].value); } catch { return false; }
  return isRecord(proof) && Object.keys(proof).join(",") === QUARANTINE_PROOF_KEYS
    && typeof bucket === "string" && proof.bucket === bucket
    && typeof proof.bucketGeneration === "string" && GENERATION.test(proof.bucketGeneration)
    && typeof proof.bucketMetageneration === "string" && GENERATION.test(proof.bucketMetageneration)
    && proof.softDeleteRetentionDurationSeconds === "0";
}

/**
 * Each plane renders only from its own template. Production: HOST_MODE
 * production and no staging admission setting. Staging: exactly the staging
 * env names, HOST_MODE staging, scale to zero, a staging public origin and
 * its derived admin origin, CR-3's admission modes, the inert identity
 * identifiers, the OD-2 proof for the rendered bucket, and no production
 * value anywhere.
 */
function assertPlaneServiceInvariants(service, environment) {
  const container = service.spec.template.spec.containers[0];
  const plain = new Map(container.env.filter((entry) => entry.valueFrom === undefined)
    .map((entry) => [entry.name, entry.value]));
  const hostMode = plain.get("HOST_MODE");
  if (environment !== "staging") {
    if (hostMode !== "production" || plain.has("STAGING_ADMISSION_MODE")) fail("SERVICE_RENDER_INVARIANT_BROKEN");
    return;
  }
  const names = container.env.map((entry) => entry.name);
  const required = STAGING_SERVICE_ENV_NAMES.filter((name) => !OPTIONAL_SECRET_NAMES.includes(name));
  const publicOrigin = stagingPublicOrigin(plain.get("PUBLIC_ORIGIN"));
  const annotations = service.spec.template.metadata?.annotations ?? {};
  const problems = [
    new Set(names).size !== names.length,
    names.some((name) => !STAGING_SERVICE_ENV_NAMES.includes(name)),
    required.some((name) => !names.includes(name)),
    hostMode !== "staging",
    annotations["autoscaling.knative.dev/minScale"] !== "0",
    !/^[1-9][0-9]?$/u.test(annotations["autoscaling.knative.dev/maxScale"] ?? ""),
    publicOrigin === null || !STAGING_MARKER.test(publicOrigin.hostname),
    publicOrigin !== null && plain.get("ADMIN_HOST_ORIGIN") !== `https://${STAGING_ADMIN_HOST_PREFIX}${publicOrigin.hostname}`,
    !Object.hasOwn(STAGING_ADMISSION_MODES, plain.get("STAGING_ADMISSION_MODE") ?? ""),
    !ACCESS_AUD_PATTERN.test(plain.get("ACCESS_AUD") ?? ""),
    Object.entries(STAGING_INERT_IDENTITY_PROVIDER_VARS).some(([name, value]) => plain.get(name) !== value),
    !quarantineProofNamesBucket(container.env),
    STAGING_PROVIDED_VAR_NAMES.some((name) => !plain.has(name)),
    [...plain.values()].some((value) => PRODUCTION_FINGERPRINT.has(value)),
    publicOrigin !== null && (PRODUCTION_FINGERPRINT.has(publicOrigin.hostname)
      || PRODUCTION_MARKER.test(publicOrigin.hostname)),
  ];
  if (problems.some(Boolean)) fail("SERVICE_RENDER_INVARIANT_BROKEN");
}
