/**
 * Production infrastructure desired state for the Google Cloud service (OPS-2,
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
 * Topology: one Cloud SQL PostgreSQL 17 ENTERPRISE instance, zonal, with no
 * replica, no high availability and no deletion-ledger instance (append-only
 * decision record 2026-09-26, D2 and D4). Hostnames stay at the Cloudflare
 * edge (D5): the origin is the IAM-private Cloud Run service rendered from
 * EP-7's template, invoked only by the edge-invoker account (and an optional
 * verifier). The fast path renders exactly two Cloud Run Jobs (JOB_NAMES):
 * the OPS-10 production migration and the analytics-refresh job, whose
 * Cloud Scheduler cadence the owner supplies (decision D3; there is no
 * default) and whose trigger state is closed: PAUSED until OPS-3 resumes it.
 * The analytics-refresh job and trigger are deferred (DEFERRED_JOBS) while
 * cloud-run/analytics-refresh.mjs refuses every non-test target. Probe,
 * restore-verify, ledger and Worker-era analytics jobs are not rendered.
 *
 * This module is pure: it validates a desired-state object and renders the
 * resource specifications from it. It reads only repository files (the EP-7
 * templates and the GCS store sources it parses for the custom role), never a
 * live resource, and never a secret value. The one exception is
 * rolloutTarget(environment), OPS-10's entry point, which reads the path of
 * the environment's owner-held desired-state file from one named variable
 * (DESIRED_STATE_PATH_VARIABLES). The real production identifiers are
 * owner-held; the repository ships only a synthetic fixture
 * (fixtures/gcp-ops-infra/), whose project marker apply and rolloutTarget
 * refuse.
 *
 * Every refusal throws an Error whose message and `code` are the same named
 * constant (a code may carry a ':<path>' suffix naming the setting).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/canonical-json.ts";
import { CLOUD_RUN_IAM_TEST_TARGET } from "../cloud-run/postgres-test-dispatch.mjs";
import { FASTPATH_TEST_CLOUD_TARGET } from "../cloud-run/origin-fastpath-mode.mjs";
import {
  EDGE_ONLY_SECRET_NAMES,
  OPTIONAL_SECRET_NAMES,
  PRODUCTION_POOL_CONNECTIONS_PER_INSTANCE,
  PRODUCTION_RESOURCE_MARKER,
  REQUIRED_SECRET_NAMES,
  STAGING_RESOURCE_MARKER,
} from "../cloud-run/postgres-production-configuration.mjs";
import { desiredBackupConfiguration } from "../cloud-run/ops-backup-horizon.mjs";
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
  TEST_MIGRATIONS_TARGETS,
} from "../cloud-run/test-migrations.mjs";
import { GCP_PRIVATE_TEST_TARGET } from "./gcp-private-test-deploy.mjs";
import { GCP_TEST_BUCKET_HISTORY_TARGET } from "./gcp-test-bucket-history.mjs";
import { FASTPATH_TEST } from "./gcp-fastpath-test-deploy.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const GCP_OPS_INFRA_DESIRED_STATE_SCHEMA = "tibotattle-gcp-ops-infra-desired-state-v1";
export const GCP_OPS_INFRA_ENVIRONMENTS = Object.freeze(["production", "staging"]);

/** The fast-path Cloud Run Jobs, and nothing else (OPS-3-lite). */
export const JOB_NAMES = Object.freeze(["production-migrate", "analytics-refresh"]);
/** Jobs a Cloud Scheduler trigger runs. production-migrate is manual (OPS-10). */
export const SCHEDULED_JOB_NAMES = Object.freeze(["analytics-refresh"]);
/**
 * The trigger states a desired state may name. PAUSED until OPS-3 resumes the
 * trigger; ENABLED records that it has. Apply never resumes: it pauses a live
 * trigger that runs while PAUSED is desired, and leaves a resume to OPS-3.
 */
export const SCHEDULER_TRIGGER_STATES = Object.freeze(["PAUSED", "ENABLED"]);

/**
 * Jobs whose create, and whose trigger's create, OPS-2 defers, with the
 * reason. cloud-run/analytics-refresh.mjs resolves its database only to the
 * private test targets inside a Cloud Run Job and refuses everything else
 * with ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN, so a production or staging
 * analytics-refresh Job could never run. The manifest check pins that
 * refusal: once the entry gains a reviewed production target path, that
 * check fails, and this entry is removed with it.
 */
export const DEFERRED_JOBS = Object.freeze({
  "analytics-refresh": "ANALYTICS_REFRESH_PRODUCTION_TARGET_UNAVAILABLE",
});

/**
 * The variable naming each environment's owner-held desired-state file (an
 * absolute path outside the repository), read only by rolloutTarget and by
 * the CLI's --environment form.
 */
export const DESIRED_STATE_PATH_VARIABLES = Object.freeze({
  production: "GCP_INFRA_DESIRED_STATE_PRODUCTION",
  staging: "GCP_INFRA_DESIRED_STATE_STAGING",
});

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
  // cloud-run/analytics-refresh.mjs: one full recompute (the only mode).
  "analytics-refresh": Object.freeze({
    account: "runtime",
    args: Object.freeze(["dist/analytics-refresh.mjs", "--mode=full"]),
    timeoutSeconds: 3_600,
    cpu: "2",
    memory: "4Gi",
    env: Object.freeze([
      "PRIMARY_INSTANCE_CONNECTION_NAME", "PRIMARY_DATABASE", "PRIMARY_SCHEMA",
      "POSTGRES_IAM_USER", "DEPLOYMENT_SOURCE_COMMIT",
    ]),
  }),
});

export const SCHEDULER_TIME_ZONE = "Etc/UTC";
export const SCHEDULER_OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** The project marker apply refuses: the shipped fixture is synthetic. */
export const SYNTHETIC_PROJECT_MARKER = "synthetic";

const SERVICE_TEMPLATE_PATH = resolve(WORKER_ROOT, "cloud-run/production-service.template.yaml");
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
 * Every name the test estate uses: the private test deployment, the test,
 * graph-benchmark and fast-path migration targets, the IAM test host, the
 * fast-path deploy and the bucket-history tool. Locations, listen addresses
 * and ports are not identities.
 */
function testTargetNames() {
  const names = new Set();
  const skipKeys = ["region", "location", "listenHost", "port", "projectNumber", "edgeGetPaths",
    "originLoopbackPort", "edgeIngressPort", "labels", "seededSchemaPrefix", "bucketPrefix"];
  for (const source of [
    GCP_PRIVATE_TEST_TARGET,
    TEST_MIGRATIONS_TARGETS,
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

const DESIRED_KEYS = Object.freeze([
  "schemaVersion", "environment", "project", "projectNumber", "region", "artifactRegistry",
  "serviceAccounts", "customRole", "secrets", "cloudSql", "bucket", "service", "jobs", "scheduler",
]);

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

function serviceAccount(value, role, path) {
  closedKeys(value, ["accountId", "projectRoles"], path);
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
  return { accountId, projectRoles: Object.freeze([...PROJECT_ROLE_POLICY[role]]) };
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
  closedKeys(input, DESIRED_KEYS, "desiredState");
  if (input.schemaVersion !== GCP_OPS_INFRA_DESIRED_STATE_SCHEMA) fail("DESIRED_STATE_SCHEMA_INVALID");
  if (!GCP_OPS_INFRA_ENVIRONMENTS.includes(input.environment)) {
    fail("DESIRED_STATE_VALUE_INVALID:desiredState.environment");
  }
  const environment = input.environment;
  const project = text(input.project, PROJECT_ID, "desiredState.project");
  const projectNumber = text(input.projectNumber, PROJECT_NUMBER, "desiredState.projectNumber");
  const region = text(input.region, REGION, "desiredState.region");

  closedKeys(input.artifactRegistry, ["repository", "imageName"], "artifactRegistry");
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

  closedKeys(input.customRole, ["id", "permissions"], "customRole");
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

  // Secret Manager containers: exactly CR-3's required and optional names.
  if (!isRecord(input.secrets)) fail("DESIRED_STATE_SHAPE_INVALID:secrets");
  const secretNames = [...REQUIRED_SECRET_NAMES, ...OPTIONAL_SECRET_NAMES];
  for (const name of Object.keys(input.secrets)) {
    if (!secretNames.includes(name)) fail(`SECRET_UNKNOWN:${name}`);
  }
  const secrets = {};
  for (const name of secretNames) {
    if (!Object.hasOwn(input.secrets, name)) fail(`SECRET_CONTAINER_MISSING:${name}`);
    closedKeys(input.secrets[name], ["version"], `secrets.${name}`);
    const version = input.secrets[name].version;
    if (version !== null) text(version, SECRET_VERSION, `secrets.${name}.version`);
    secrets[name] = { version, required: REQUIRED_SECRET_NAMES.includes(name) };
  }

  closedKeys(input.cloudSql, ["instance", "tier", "storageSizeGb", "backupStartTime", "maxConnections",
    "database", "schema"], "cloudSql");
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

  closedKeys(input.bucket, ["name", "location", "proof"], "bucket");
  const bucket = {
    name: text(input.bucket.name, BUCKET_NAME, "bucket.name"),
    location: text(input.bucket.location, /^[A-Z]+-[A-Z]+[0-9]{1,2}$/u, "bucket.location"),
    proof: null,
  };
  if (bucket.location !== region.toUpperCase()) fail("BUCKET_LOCATION_NOT_REGION");
  if (input.bucket.proof !== null) {
    closedKeys(input.bucket.proof, ["bucketGeneration", "bucketMetageneration"], "bucket.proof");
    bucket.proof = {
      bucketGeneration: generation(input.bucket.proof.bucketGeneration, "bucket.proof.bucketGeneration"),
      bucketMetageneration: generation(input.bucket.proof.bucketMetageneration, "bucket.proof.bucketMetageneration"),
    };
  }

  closedKeys(input.service, ["name", "maxInstances", "rolloutOverlapInstances", "audience",
    "telemetryStorageNamespace"], "service");
  const service = {
    name: text(input.service.name, RESOURCE_NAME, "service.name"),
    maxInstances: integer(input.service.maxInstances, 1, 100, "service.maxInstances"),
    rolloutOverlapInstances: integer(input.service.rolloutOverlapInstances, 1, 100, "service.rolloutOverlapInstances"),
    audience: text(input.service.audience, AUDIENCE, "service.audience"),
    telemetryStorageNamespace: text(input.service.telemetryStorageNamespace, NAMESPACE,
      "service.telemetryStorageNamespace"),
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
    closedKeys(input.jobs[job], ["name", "maxConnections"], `jobs.${job}`);
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

  if (!isRecord(input.scheduler)
      || Object.keys(input.scheduler).sort().join() !== [...SCHEDULED_JOB_NAMES].sort().join()) {
    fail("SCHEDULER_JOBS_MISMATCH");
  }
  const scheduler = {};
  for (const job of SCHEDULED_JOB_NAMES) {
    closedKeys(input.scheduler[job], ["name", "schedule", "state"], `scheduler.${job}`);
    const schedule = input.scheduler[job].schedule;
    // No default cadence: null means not yet decided (D3), and nothing is created.
    if (schedule !== null && !validCron(schedule)) fail(`SCHEDULER_CADENCE_INVALID:${job}`);
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
    ["project", project],
    ["artifactRegistry.repository", artifactRegistry.repository],
    ["artifactRegistry.imageRepository", artifactRegistry.imageRepository],
    ["cloudSql.database", cloudSql.database],
    ["cloudSql.schema", cloudSql.schema],
    ["service.audience", service.audience],
    ["service.telemetryStorageNamespace", service.telemetryStorageNamespace],
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

  const desired = {
    schemaVersion: GCP_OPS_INFRA_DESIRED_STATE_SCHEMA,
    environment,
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
  };
  for (const [name, secret] of Object.entries(desired.secrets)) {
    if (secret.version === null && secret.required) fail(`SECRET_VERSION_UNPINNED:${name}`);
    values[`SECRET_VERSION_${name}`] = secret.version ?? "";
  }
  return values;
}

function readTemplate(path, readTemplateFile) {
  return readTemplateFile === undefined ? readFileSync(path, "utf8") : readTemplateFile(path);
}

/**
 * Renders EP-7's service template from a placeholder map (the same input the
 * EP-7 reference renderer takes) and returns the Knative Service object. An
 * optional secret whose version renders empty is omitted. Values must be
 * printable ASCII without a quote, dollar or backslash; the result must keep
 * the reviewed invariants (IAM-private, audience-bound, digest-pinned, no
 * deletion-ledger setting, CR-3 secrets only by secretKeyRef).
 */
export function renderServiceTemplateValues(values, { templateText } = {}) {
  const template = parseTemplateYaml(templateText ?? readTemplate(SERVICE_TEMPLATE_PATH));
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
  return deepFreeze(service);
}

/** Renders the desired service for an image (live or bootstrap). */
export function renderService(desired, image, options = {}) {
  return renderServiceTemplateValues(serviceTemplateValues(desired, image), options);
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

/** One job's env as name/value pairs, in definition order. */
function jobEnv(desired, job, sourceCommit) {
  const values = {
    MIGRATION_ENVIRONMENT: desired.environment,
    GOOGLE_CLOUD_PROJECT: desired.project,
    PRODUCTION_MIGRATOR_SERVICE_ACCOUNT: desired.serviceAccounts.migrator.email,
    // The environment's configured primary: the migration job's target is
    // that instance itself (a scratch rehearsal instance is never rendered).
    ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME: desired.cloudSql.connectionName,
    PRIMARY_INSTANCE_CONNECTION_NAME: desired.cloudSql.connectionName,
    PRIMARY_DATABASE: desired.cloudSql.database,
    PRIMARY_SCHEMA: desired.cloudSql.schema,
    POSTGRES_IAM_USER: desired.cloudSql.runtimeIamUser,
    POSTGRES_MIGRATOR_IAM_USER: desired.cloudSql.migratorIamUser,
    POSTGRES_RUNTIME_IAM_USER: desired.cloudSql.runtimeIamUser,
    DEPLOYMENT_SOURCE_COMMIT: sourceCommit,
  };
  return JOB_DEFINITIONS[job].env.map((name) => ({ name, value: values[name] }));
}

/** A Cloud Run Job (run.googleapis.com/v1) for `gcloud run jobs replace`. */
export function renderJob(desired, job, { imageDigest, sourceCommit }) {
  if (!JOB_NAMES.includes(job)) fail("JOB_NAME_UNKNOWN");
  if (typeof imageDigest !== "string" || !IMAGE_DIGEST.test(imageDigest)) fail("JOB_RENDER_IMAGE_INVALID");
  if (typeof sourceCommit !== "string" || !SOURCE_COMMIT.test(sourceCommit)) fail("JOB_RENDER_SOURCE_COMMIT_INVALID");
  const definition = JOB_DEFINITIONS[job];
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
                env: jobEnv(desired, job, sourceCommit),
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

/**
 * The absolute path of an environment's owner-held desired-state file, from
 * its DESIRED_STATE_PATH_VARIABLES entry in `env`.
 */
export function desiredStatePathFor(environment, env) {
  if (!GCP_OPS_INFRA_ENVIRONMENTS.includes(environment)) fail("GCP_INFRA_ENVIRONMENT_INVALID");
  const path = env !== null && typeof env === "object" ? env[DESIRED_STATE_PATH_VARIABLES[environment]] : undefined;
  if (typeof path !== "string" || path.length === 0) fail("GCP_INFRA_DESIRED_STATE_UNCONFIGURED");
  if (!isAbsolute(path)) fail("GCP_INFRA_DESIRED_STATE_PATH_INVALID");
  return path;
}

/** A validated desired state that must describe `environment`. */
export function requireEnvironment(desired, environment) {
  if (!GCP_OPS_INFRA_ENVIRONMENTS.includes(environment)) fail("GCP_INFRA_ENVIRONMENT_INVALID");
  if (desired.environment !== environment) fail("GCP_INFRA_ENVIRONMENT_MISMATCH");
  return desired;
}

/** The Cloud Run Jobs OPS-2 deploys: JOB_NAMES less the deferred ones. */
export function deployedJobNames() {
  return Object.freeze(JOB_NAMES.filter((job) => !Object.hasOwn(DEFERRED_JOBS, job)));
}

/** The keys of OPS-10's closed RolloutTarget (scripts/gcp-production-rollout.mjs). */
export const ROLLOUT_TARGET_KEYS = Object.freeze([
  "environment", "project", "region", "service", "migrationJob", "jobNames", "primaryInstance",
  "imageRepository", "builderServiceAccount", "verifierServiceAccount", "originAudience",
]);

/**
 * OPS-10's RolloutTarget for a validated desired state: the service, the
 * deployed jobs (a deferred job does not exist, so the rollout never moves
 * it), the one primary instance, the image repository, the builder, and the
 * EP-6 verifier path roll reads /api/health through while the edge is not in
 * gcp mode: the verifier account and the origin's ID-token audience. The
 * verifier is optional in the desired state, but a rollout needs it, so a
 * desired state without one is refused ROLLOUT_TARGET_VERIFIER_REQUIRED.
 */
export function rolloutTargetFromDesiredState(desired) {
  if (desired.synthetic) fail("ROLLOUT_TARGET_SYNTHETIC_REFUSED");
  if (desired.serviceAccounts.verifier === null) fail("ROLLOUT_TARGET_VERIFIER_REQUIRED");
  return deepFreeze({
    environment: desired.environment,
    project: desired.project,
    region: desired.region,
    service: desired.service.name,
    migrationJob: desired.jobs["production-migrate"].name,
    jobNames: deployedJobNames().map((job) => desired.jobs[job].name),
    primaryInstance: desired.cloudSql.instance,
    imageRepository: desired.artifactRegistry.imageRepository,
    builderServiceAccount: desired.serviceAccounts.builder.email,
    verifierServiceAccount: desired.serviceAccounts.verifier.email,
    originAudience: desired.service.audience,
  });
}

/**
 * OPS-10's entry point: the environment's RolloutTarget, from the owner-held
 * desired-state file its DESIRED_STATE_PATH_VARIABLES entry names. The file
 * must validate, describe that environment and not be synthetic.
 */
export function rolloutTarget(environment, { env = process.env, readFile, readSource } = {}) {
  const path = desiredStatePathFor(environment, env);
  const desired = readDesiredStateFile(path, {
    ...(readFile === undefined ? {} : { readFile }),
    ...(readSource === undefined ? {} : { readSource }),
  });
  return rolloutTargetFromDesiredState(requireEnvironment(desired, environment));
}
