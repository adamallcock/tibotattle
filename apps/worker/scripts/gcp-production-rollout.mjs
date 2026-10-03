#!/usr/bin/env node

/**
 * OPS-10 production rollout for the GCP origin: preflight, build, migrate and
 * roll, each a separate verb with its own authorization.
 *
 *   preflight  read-only: a clean checkout at --commit, the infrastructure
 *              readback (`node scripts/gcp-infra.mjs readback --require-clean`),
 *              an OPS-1 backup-horizon audit that is not in breach, and the
 *              scheduled-jobs readback: every Cloud Scheduler trigger of a
 *              Cloud Run job in the region and every execution of a manifest
 *              Job, reported as quiescent or not.
 *   build      --authorize=build:<env>:<commit>. Renders
 *              cloud-run/cloudbuild.production.yaml, writes the audited source
 *              archive (scripts/cloud-run-build-archive.mjs, the archive the
 *              test builds use) and submits that file; the build is qualified
 *              against the archive's own sha256 (sourceProvenance.fileHashes),
 *              its identity, step, step image and image digest.
 *   migrate    --authorize=migrate:<env>:<digest>. Preflight; the jobs must be
 *              quiescent (OPS-3 pause-all done, nothing running); one labelled
 *              pre-migration on-demand backup of the primary instance (with
 *              point-in-time recovery, the owner's 2026-10-02 decision), then
 *              the production migration Job moved to the digest and commit and
 *              executed, and its 'tibotattle-gcp-migration-v1' receipt read
 *              back from the execution's log and verified. Writes the migrate
 *              receipt that roll requires.
 *   capture-edge  read-only against Cloudflare: writes the live edge capture
 *              roll reads (ROLLOUT_EDGE_LIVE_SCHEMA) for the environment's
 *              edge Worker to a new owner-private file outside the
 *              repository, after verifying it exactly as roll will. No lock,
 *              no gcloud, no git; --execute makes the reads.
 *   roll       --authorize=roll:<env>:<digest>. Requires the matching migrate
 *              receipt and a fresh, verified capture of the live edge for this
 *              environment (its own mode, Worker, domains, single deployment
 *              and source commit). In every edge mode (D-BLOB) it refuses
 *              EDGE_CONTRACT_DRIFT unless src/edge-origin-contract.ts has the
 *              same blob at --commit and at the live edge's commit, so a
 *              pre-edge Worker, which has no contract file, refuses the roll;
 *              in gcp mode (EP-9) it also requires the edge to point at this
 *              service. With the jobs quiescent, the service and every Job of
 *              the infrastructure
 *              manifest move to one digest and commit and are read back; then
 *              the public /api/health (gcp mode) or the EP-6 verifier path
 *              (every other mode) must report --commit. The rollout never
 *              resumes a paused trigger: OPS-3 resume-all follows the roll.
 *
 * Every mutating verb runs under its environment's coordination lock from
 * scripts/production-deployment-lock.mjs, released on success and on failure.
 * The mapping is closed (DEPLOYMENT_LOCK_REFS): production takes
 * refs/heads/codex/production-deployment-lock, shared with the Cloudflare
 * production deploys; staging takes its own
 * refs/heads/codex/staging-deployment-lock and never the production lock
 * (owner decision 2026-10-02, round 9). A dry run of a mutating verb prints
 * that exact ref as lockRef. Commands run through an injected runner as argv,
 * never a shell; no verb deletes anything. Without --execute a verb only validates
 * its inputs and prints the argv it would run: it runs no gcloud and no node,
 * makes no request, and runs only local read-only git where an input check
 * needs it.
 *
 * The environment's resources come from the infrastructure manifest
 * (scripts/gcp-ops-infra-manifest.mjs, OPS-2): its rolloutTarget(environment)
 * reads that environment's committed desired state
 * (cloud-run/infra/<env>.desired-state.json) and returns the closed
 * RolloutTarget below, whose jobNames are the manifest's JOB_NAMES for that
 * environment, less the jobs it defers. A missing module, or a manifest
 * refusal (an owner placeholder still unfilled, an unreadable, synthetic or
 * verifier-less desired state, or no operator named for the verifier's
 * token-creator grant), refuses every verb with
 * ROLLOUT_INFRA_MANIFEST_UNAVAILABLE.
 *
 * Output and errors are content-free: names, digests, commits and closed codes.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import {
  assertExpandCompatible,
  primaryManifestSha256,
  simpResidueMigration,
  verifyProductionMigrationReceipt,
  PRODUCTION_MIGRATION_RECEIPT_SCHEMA,
} from "../cloud-run/postgres-production-migrations.mjs";
import {
  formatOnDemandDescription,
  onDemandExpiresOn,
  verifyBackupHorizonReceipt,
} from "../cloud-run/ops-backup-horizon.mjs";
import { canonicalRunAppOrigin, isEdgeOriginAudience, isEdgeServiceAccountEmail } from "../src/edge-origin-contract.ts";
import {
  EDGE_MODE_GCP_VARS,
  EDGE_MODE_PRODUCTION_DOMAINS,
  EDGE_MODE_PRODUCTION_HOSTNAMES,
  EDGE_MODE_PRODUCTION_WORKER_NAME,
  liveEdgeMode,
  verifyEdgeModeLiveSnapshot,
} from "./edge-mode-configuration.mjs";
import { createOnDemandBackup } from "./gcp-backup-horizon.mjs";
import { scheduledRunJob } from "./gcp-scheduler-run-target.mjs";
import { GCP_PRIVATE_TEST_TARGET } from "./gcp-test-project.mjs";
import {
  createGcloudIdentityTokenSource,
  EDGE_ORIGIN_CONTRACT_PATH,
  verifyEdgeOriginBeforeGcp,
} from "./production-edge-mode.mjs";
import { createEnvironmentDeploymentLock, deploymentLockRef } from "./production-deployment-lock.mjs";
import { createProductionLiveConfigSnapshot } from "./production-live-config.mjs";
import { createProductionLiveProvider } from "./production-live-provider.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const WORKER_ROOT = resolve(dirname(SCRIPT_FILE), "..");
export const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");

export const ROLLOUT_VERBS = Object.freeze(["preflight", "build", "migrate", "roll"]);
export const ROLLOUT_ENVIRONMENTS = Object.freeze(["production", "staging"]);
export const ROLLOUT_MIGRATE_RECEIPT_SCHEMA = "tibotattle-gcp-rollout-migrate-v1";
export const ROLLOUT_BUILD_RECEIPT_SCHEMA = "tibotattle-gcp-rollout-build-v1";
export const ROLLOUT_ROLL_RECEIPT_SCHEMA = "tibotattle-gcp-rollout-roll-v1";
/**
 * The live edge capture roll reads: exactly {schema, capturedAt, snapshot,
 * deployment}, where snapshot is the typed production-live-config snapshot of
 * the environment's Worker (createProductionLiveConfigSnapshot over a
 * production-live-provider capture), deployment its active deployment
 * ({versions: [{version_id, percentage}]}) and capturedAt that capture's ISO
 * time. A capture older than EDGE_CAPTURE_MAX_AGE_MS is refused, before the
 * lock and again right before the service moves.
 */
export const ROLLOUT_EDGE_LIVE_SCHEMA = "tibotattle-edge-live-capture-v1";
export const ROLLOUT_EDGE_LIVE_KEYS = Object.freeze(["schema", "capturedAt", "snapshot", "deployment"]);
export const EDGE_CAPTURE_MAX_AGE_MS = 15 * 60 * 1_000;
/** The verb that writes that capture (read-only against Cloudflare; no lock, no gcloud). */
export const ROLLOUT_EDGE_CAPTURE_VERB = "capture-edge";
/**
 * The staging edge roll targets: the staging-edge Worker the edge-port line's
 * staging-edge driver deploys (scripts/staging-edge-deploy.mjs there), on its
 * two custom domains, serving the staging service's public origin. It is
 * pinned here as production's Worker and domains are pinned in
 * edge-mode-configuration.mjs, because no tracked file of this line declares
 * it: wrangler.jsonc env.staging is the retired workers.dev Worker
 * (app-usagemonitor-staging), which the staging-edge driver refuses to reuse,
 * and the committed staging desired state names the public origin but no
 * Worker. validateStagingEdgeIdentity refuses any other shape, and the
 * rollout check binds publicOrigin and the admin domain to the desired
 * state's stagingOrigin block.
 */
export const ROLLOUT_STAGING_EDGE_IDENTITY = Object.freeze({
  workerName: "app-usagemonitor-staging-edge",
  domains: Object.freeze(["admin.staging.tibotattle.com", "staging.tibotattle.com"]),
  publicOrigin: "https://staging.tibotattle.com",
});
/**
 * Labelled pre-migration on-demand backups of the primary instance (OPS-10):
 * one, alongside the instance's point-in-time recovery (owner decision
 * 2026-10-02, "Pre-migration backups").
 */
export const PRE_MIGRATION_BACKUPS = 1;
export const PRE_MIGRATION_BACKUP_EXPIRES_IN_DAYS = 30;
export const BACKUP_AUDIT_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
export const MIGRATE_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const BUILD_CONFIG_PATH = "cloud-run/cloudbuild.production.yaml";
/** The source archive's file name: gcloud submits a local .gz file as-is. */
export const BUILD_ARCHIVE_NAME = "source.tar.gz";
export const INFRA_READBACK_ARGV = Object.freeze(["node", "scripts/gcp-infra.mjs", "readback", "--require-clean"]);
export const ROLLOUT_TARGET_KEYS = Object.freeze([
  "environment", "project", "region", "service", "migrationJob", "jobNames", "primaryInstance",
  "imageRepository", "builderServiceAccount", "verifierServiceAccount", "originAudience", "maintenanceJob",
]);
/** The health body the public path and the EP-6 verifier path both read. */
export const HEALTH_PATH = "/api/health";
const HEALTH_MAX_BYTES = 64 * 1024;
const HEALTH_TIMEOUT_MS = 10_000;

const FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const COMMIT = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GENERATION = /^[1-9][0-9]{0,19}$/u;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/u;
const OBJECT_NAME = /^[A-Za-z0-9._/-]{1,1024}$/u;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const REGION = /^[a-z]+-[a-z]+[0-9]{1,2}$/u;
const CLOUD_RUN_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const INSTANCE_ID = /^[a-z](?:[a-z0-9-]{0,96}[a-z0-9])?$/u;
const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u;
const REPOSITORY = /^([a-z]+-[a-z]+[0-9]{1,2})-docker\.pkg\.dev\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,127}$/u;
const EXECUTION = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const BACKUP_ID = /^[1-9][0-9]{0,18}$/u;
const SAFE_CODE = /^(?:ROLLOUT_[A-Z0-9_]+|PRODUCTION_LIVE_[A-Z0-9_]+|EDGE_CONTRACT_DRIFT|PRODUCTION_SIMP_RESIDUE_MISSING|PRODUCTION_MIGRATION_CONTRACT_[A-Z_]+|POSTGRES_PRODUCTION_MIGRATIONS_RECEIPT_INVALID|BACKUP_[A-Z0-9_]+|PRODUCTION_COORDINATION_[A-Z_]+|STAGING_COORDINATION_[A-Z_]+|DEPLOYMENT_COORDINATION_[A-Z_]+|EDGE_ORIGIN_[A-Z_]+)$/u;

export class RolloutError extends Error {
  constructor(code) {
    super(code);
    this.name = "RolloutError";
    this.code = code;
  }
}

function fail(code) {
  throw new RolloutError(code);
}

export function safeRolloutErrorCode(error) {
  return typeof error?.code === "string" && SAFE_CODE.test(error.code) ? error.code : "ROLLOUT_FAILED";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function tokens(value) {
  return String(value).toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Arguments

const FLAGS = Object.freeze({
  preflight: Object.freeze({ required: ["--environment", "--commit", "--backup-audit"], optional: [] }),
  build: Object.freeze({ required: ["--environment", "--commit"], optional: ["--authorize"] }),
  migrate: Object.freeze({
    required: ["--environment", "--commit", "--digest", "--backup-audit", "--migrate-receipt"],
    optional: ["--authorize"],
  }),
  roll: Object.freeze({
    required: ["--environment", "--commit", "--digest", "--backup-audit", "--migrate-receipt", "--edge-live"],
    optional: ["--authorize"],
  }),
});

/** `--flag=value` pairs from a closed set, each at most once, and at most one --execute. */
function readFlags(argv, { required, optional }) {
  const allowed = new Set([...required, ...optional]);
  const values = new Map();
  let execute = false;
  for (const argument of argv.slice(1)) {
    if (argument === "--execute") {
      if (execute) fail("ROLLOUT_ARGUMENT_INVALID");
      execute = true;
      continue;
    }
    const separator = typeof argument === "string" ? argument.indexOf("=") : -1;
    const name = separator > 2 ? argument.slice(0, separator) : null;
    const value = separator > 2 ? argument.slice(separator + 1) : "";
    if (name === null || !allowed.has(name) || value.length === 0 || values.has(name)) fail("ROLLOUT_ARGUMENT_INVALID");
    values.set(name, value);
  }
  if (!required.every((name) => values.has(name))) fail("ROLLOUT_ARGUMENT_MISSING");
  return { values, execute };
}

/**
 * Parse `<verb> --flag=value... [--execute]`. Mutating verbs need
 * --authorize=<verb>:<environment>:<commit or digest> to execute; a supplied
 * authorization must match in a dry run too.
 */
export function parseRolloutArguments(argv) {
  if (!Array.isArray(argv) || !ROLLOUT_VERBS.includes(argv[0])) fail("ROLLOUT_VERB_INVALID");
  const verb = argv[0];
  const { values, execute } = readFlags(argv, FLAGS[verb]);
  const environment = values.get("--environment");
  if (!ROLLOUT_ENVIRONMENTS.includes(environment)) fail("ROLLOUT_ENVIRONMENT_INVALID");
  const commit = values.get("--commit");
  if (!COMMIT.test(commit)) fail("ROLLOUT_COMMIT_INVALID");
  const digest = values.get("--digest") ?? null;
  if (digest !== null && !DIGEST.test(digest)) fail("ROLLOUT_DIGEST_INVALID");
  for (const name of ["--backup-audit", "--migrate-receipt", "--edge-live"]) {
    if (values.has(name) && !isAbsolute(values.get(name))) fail("ROLLOUT_PATH_INVALID");
  }
  const authorize = values.get("--authorize") ?? null;
  if (verb !== "preflight") {
    const expected = `${verb}:${environment}:${verb === "build" ? commit : digest}`;
    if (authorize !== null && authorize !== expected) fail("ROLLOUT_AUTHORIZATION_MISMATCH");
    if (execute && authorize === null) fail("ROLLOUT_AUTHORIZATION_REQUIRED");
  }
  return deepFreeze({
    verb,
    environment,
    commit,
    digest,
    execute,
    backupAudit: values.get("--backup-audit") ?? null,
    migrateReceipt: values.get("--migrate-receipt") ?? null,
    edgeLive: values.get("--edge-live") ?? null,
  });
}

// ---------------------------------------------------------------------------
// Target

function testTargetValues() {
  const values = new Set();
  for (const [field, value] of Object.entries(GCP_PRIVATE_TEST_TARGET)) {
    if (typeof value !== "string" || field === "project" || field === "projectNumber" || field === "region") continue;
    values.add(value);
    if (field.endsWith("ConnectionName")) values.add(value.split(":").at(-1));
  }
  return values;
}
const TEST_TARGET_VALUES = testTargetValues();

/**
 * Validate the environment's RolloutTarget: closed keys, resource-name
 * patterns, the migration Job among jobNames, an Artifact Registry
 * repository in the target's project and region, plane markers, and no
 * test-deployment or rehearsal resource. verifierServiceAccount is an EP-6
 * verifier the operator can impersonate and originAudience the origin's
 * Google ID token audience; together they are the verifier path roll reads
 * /api/health through while the edge is not in gcp mode. maintenanceJob is
 * the MP-2-lite maintenance Job among jobNames (D-OPS4), or null while the
 * desired state has none: roll runs it before that verification (the
 * first-roll ready path, D-CRB).
 */
export function validateRolloutTarget(target, environment) {
  if (!hasExactKeys(target, ROLLOUT_TARGET_KEYS) || target.environment !== environment
      || !PROJECT.test(target.project ?? "") || !REGION.test(target.region ?? "")
      || !CLOUD_RUN_NAME.test(target.service ?? "") || !CLOUD_RUN_NAME.test(target.migrationJob ?? "")
      || !Array.isArray(target.jobNames) || target.jobNames.length === 0
      || target.jobNames.some((name) => typeof name !== "string" || !CLOUD_RUN_NAME.test(name))
      || new Set(target.jobNames).size !== target.jobNames.length
      || !target.jobNames.includes(target.migrationJob)
      || !INSTANCE_ID.test(target.primaryInstance ?? "")
      || !SERVICE_ACCOUNT.test(target.builderServiceAccount ?? "")
      || !isEdgeServiceAccountEmail(target.verifierServiceAccount)
      || target.verifierServiceAccount === target.builderServiceAccount
      || !isEdgeOriginAudience(target.originAudience)
      || (target.maintenanceJob !== null && (typeof target.maintenanceJob !== "string"
        || !target.jobNames.includes(target.maintenanceJob) || target.maintenanceJob === target.migrationJob))) {
    fail("ROLLOUT_TARGET_INVALID");
  }
  const repository = REPOSITORY.exec(target.imageRepository ?? "");
  if (repository === null || repository[1] !== target.region || repository[2] !== target.project) {
    fail("ROLLOUT_TARGET_INVALID");
  }
  const named = [target.service, ...target.jobNames, target.primaryInstance, target.imageRepository,
    target.builderServiceAccount.split("@")[0], target.verifierServiceAccount.split("@")[0]];
  if (named.some((value) => TEST_TARGET_VALUES.has(value) || tokens(value).includes("test")
      || tokens(value).includes("rehearsal"))) {
    fail("ROLLOUT_TARGET_TEST_FORBIDDEN");
  }
  const staging = named.map((value) => tokens(value).includes("staging"));
  if (environment === "staging" ? staging.some((marker) => !marker) : staging.some(Boolean)) {
    fail("ROLLOUT_TARGET_PLANE_MISMATCH");
  }
  return deepFreeze(structuredClone(target));
}

/** The default target source: the OPS-2 infrastructure manifest's committed desired state. */
export async function loadRolloutTargetFromInfraManifest(environment) {
  let manifest;
  try {
    manifest = await import("./gcp-ops-infra-manifest.mjs");
  } catch {
    fail("ROLLOUT_INFRA_MANIFEST_UNAVAILABLE");
  }
  if (typeof manifest?.rolloutTarget !== "function") fail("ROLLOUT_INFRA_MANIFEST_UNAVAILABLE");
  return manifest.rolloutTarget(environment);
}

// ---------------------------------------------------------------------------
// Commands (argv only)

const scope = (target) => [`--project=${target.project}`, `--region=${target.region}`];
export const imageReference = (target, digest) => `${target.imageRepository}@${digest}`;

export const ROLLOUT_ARGV = Object.freeze({
  gitStatus: () => ["git", "status", "--porcelain=v1", "--untracked-files=all"],
  gitHead: () => ["git", "rev-parse", "--verify", "HEAD"],
  gitBlob: (commit, path) => ["git", "rev-parse", "--verify", "--quiet", `${commit}:${path}`],
  infraReadback: (environment) => [...INFRA_READBACK_ARGV, `--environment=${environment}`],
  /** The audited context as the test builds archive it (cloud-run-build-archive.mjs). */
  buildArchive: (output) => ["node", "scripts/cloud-run-build-archive.mjs", `--output=${output}`],
  buildSubmit: (target, archive, config) => ["gcloud", "builds", "submit", archive, `--config=${config}`,
    ...scope(target), "--format=json"],
  schedulerList: (target) => ["gcloud", "scheduler", "jobs", "list", `--project=${target.project}`,
    `--location=${target.region}`, "--format=json"],
  executionsList: (target, job) => ["gcloud", "run", "jobs", "executions", "list", `--job=${job}`, ...scope(target),
    "--format=json"],
  /** As createGcloudIdentityTokenSource (scripts/production-edge-mode.mjs) issues it. */
  identityToken: (target) => ["gcloud", "auth", "print-identity-token",
    `--impersonate-service-account=${target.verifierServiceAccount}`, `--audiences=${target.originAudience}`,
    "--include-email"],
  jobUpdate: (target, job, image, commit) => ["gcloud", "run", "jobs", "update", job, `--image=${image}`,
    `--update-env-vars=DEPLOYMENT_SOURCE_COMMIT=${commit}`, ...scope(target), "--quiet"],
  jobExecute: (target, job) => ["gcloud", "run", "jobs", "execute", job, "--wait", ...scope(target), "--format=json"],
  migrationLog: (target, job, execution) => ["gcloud", "logging", "read",
    `resource.type="cloud_run_job" AND resource.labels.job_name="${job}"`
      + ` AND labels."run.googleapis.com/execution_name"="${execution}"`
      + ` AND jsonPayload.schema="${PRODUCTION_MIGRATION_RECEIPT_SCHEMA}"`,
    `--project=${target.project}`, "--format=json", "--limit=10", "--freshness=1d"],
  serviceUpdate: (target, image, commit) => ["gcloud", "run", "services", "update", target.service,
    `--image=${image}`, `--update-env-vars=DEPLOYMENT_SOURCE_COMMIT=${commit}`, ...scope(target), "--quiet"],
  serviceDescribe: (target) => ["gcloud", "run", "services", "describe", target.service, ...scope(target), "--format=json"],
  jobDescribe: (target, job) => ["gcloud", "run", "jobs", "describe", job, ...scope(target), "--format=json"],
  /** As createOnDemandBackup (scripts/gcp-backup-horizon.mjs) issues it. */
  backupCreate: (target, description) => ["gcloud", "sql", "backups", "create", `--instance=${target.primaryInstance}`,
    `--project=${target.project}`, `--description=${description}`, `--location=${target.region}`],
});

/** The default runner: argv through spawnSync, never a shell. */
export function spawnRunner(argv) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: WORKER_ROOT,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    timeout: 90 * 60 * 1_000,
    windowsHide: true,
  });
  return { status: result.error ? null : result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

function runChecked(context, argv, code) {
  if (argv.some((part) => typeof part !== "string" || /[\0\r\n]/u.test(part))) fail("ROLLOUT_ARGV_INVALID");
  if (argv[0] === "gcloud" && argv.some((part) => /^(?:delete|remove-iam-policy-binding)$/u.test(part))) {
    fail("ROLLOUT_DELETE_REFUSED");
  }
  context.commands.push(argv);
  let result;
  try {
    result = context.run(argv);
  } catch {
    fail(code);
  }
  if (result?.status !== 0 || typeof result.stdout !== "string") fail(code);
  return result.stdout;
}

function parseJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    return fail(code);
  }
}

// ---------------------------------------------------------------------------
// Local checks

function checkCheckout(context, commit) {
  if (runChecked(context, ROLLOUT_ARGV.gitStatus(), "ROLLOUT_GIT_FAILED").trim() !== "") fail("ROLLOUT_TREE_DIRTY");
  if (runChecked(context, ROLLOUT_ARGV.gitHead(), "ROLLOUT_GIT_FAILED").trim() !== commit) {
    fail("ROLLOUT_COMMIT_NOT_CHECKED_OUT");
  }
}

async function readBoundedJson(path, code, maxBytes = MAX_INPUT_BYTES) {
  const stat = await lstat(path).catch(() => null);
  if (stat === null) fail(code.replace(/_INVALID$/u, "_REQUIRED"));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) fail(code);
  return parseJson(await readFile(path, "utf8"), code);
}

/** The checkout's primary manifest: expand-compatible, and carrying the SIMP residue. */
async function checkMigrations(context) {
  const migrations = await (context.readPrimaryMigrations ?? (() => readPostgresMigrations({ role: "primary" })))();
  // The residue gate first (as the migration Job orders it): an image
  // without it is reported as such, although CONTRACT_MIGRATIONS, which
  // reviews the residue, would also call its manifest stale.
  if (simpResidueMigration(migrations) === null) fail("PRODUCTION_SIMP_RESIDUE_MISSING");
  assertExpandCompatible(migrations);
  return Object.freeze({ count: migrations.length, manifestSha256: primaryManifestSha256(migrations) });
}

async function checkBackupAudit(context, args, target) {
  const raw = await readBoundedJson(args.backupAudit, "ROLLOUT_BACKUP_AUDIT_INVALID");
  let receipt;
  try {
    receipt = (context.verifyBackupAudit ?? verifyBackupHorizonReceipt)(raw);
  } catch {
    fail("ROLLOUT_BACKUP_AUDIT_INVALID");
  }
  if (receipt.environment !== args.environment || receipt.project !== target.project
      || receipt.roles?.primary?.instance !== target.primaryInstance) {
    fail("ROLLOUT_BACKUP_AUDIT_TARGET_MISMATCH");
  }
  if (receipt.verdict === "breach") fail("ROLLOUT_BACKUP_AUDIT_BREACH");
  const generatedAt = Date.parse(receipt.generatedAt);
  const now = context.now();
  if (!Number.isFinite(generatedAt) || generatedAt > now + FUTURE_TOLERANCE_MS
      || now - generatedAt > BACKUP_AUDIT_MAX_AGE_MS) {
    fail("ROLLOUT_BACKUP_AUDIT_STALE");
  }
  return Object.freeze({ verdict: receipt.verdict, digest: receipt.digest });
}

function checkInfraReadback(context, environment) {
  const stdout = runChecked(context, ROLLOUT_ARGV.infraReadback(environment), "ROLLOUT_INFRA_NOT_CLEAN");
  if (!isRecord(parseJson(stdout, "ROLLOUT_INFRA_READBACK_INVALID"))) fail("ROLLOUT_INFRA_READBACK_INVALID");
  return sha256(stdout);
}

const SCHEDULER_NAME = /^[A-Za-z0-9_-]{1,500}$/u;

/**
 * The scheduled-jobs readback (read-only): every Cloud Scheduler trigger in
 * the target's location that runs a Cloud Run job, with its state, and the
 * executions of each manifest Job that have not completed. Quiescent means
 * every such trigger is PAUSED and nothing is running: OPS-3 pause-all has
 * run and the running executions have finished, so no Job touches the
 * database while it migrates or while its image moves.
 */
function readScheduledJobs(context, target) {
  const schedulers = parseJson(runChecked(context, ROLLOUT_ARGV.schedulerList(target),
    "ROLLOUT_SCHEDULED_JOBS_READBACK_FAILED"), "ROLLOUT_SCHEDULED_JOBS_READBACK_FAILED");
  if (!Array.isArray(schedulers)) fail("ROLLOUT_SCHEDULED_JOBS_READBACK_FAILED");
  const triggers = [];
  for (const entry of schedulers) {
    const job = scheduledRunJob(entry);
    if (job === null) continue;
    const name = typeof entry?.name === "string" ? entry.name.split("/").at(-1) : "";
    if (!SCHEDULER_NAME.test(name)) fail("ROLLOUT_SCHEDULED_JOBS_READBACK_FAILED");
    triggers.push(Object.freeze({ name, job, state: typeof entry.state === "string" ? entry.state : "UNKNOWN" }));
  }
  const running = [];
  for (const job of target.jobNames) {
    const executions = parseJson(runChecked(context, ROLLOUT_ARGV.executionsList(target, job),
      "ROLLOUT_SCHEDULED_JOBS_READBACK_FAILED"), "ROLLOUT_SCHEDULED_JOBS_READBACK_FAILED");
    if (!Array.isArray(executions)) fail("ROLLOUT_SCHEDULED_JOBS_READBACK_FAILED");
    // An execution without a completion time is pending or running.
    const open = executions.filter((execution) => typeof execution?.status?.completionTime !== "string").length;
    if (open > 0) running.push(Object.freeze({ job, executions: open }));
  }
  triggers.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return deepFreeze({
    triggers,
    running,
    quiescent: triggers.every(({ state }) => state === "PAUSED") && running.length === 0,
  });
}

/**
 * Refuse unless a scheduled-jobs readback is quiescent (the 2026-09-26 OPS-10
 * separation patch): migrate and roll execute only after every trigger is
 * paused (`gcp-infra.mjs pause-all`, OPS-3, which classifies triggers with
 * the same gcp-scheduler-run-target.mjs) and the running executions have
 * finished. The rollout never pauses or resumes a trigger itself.
 */
function assertQuiescent(readback) {
  if (readback.triggers.some(({ state }) => state !== "PAUSED")) fail("ROLLOUT_JOBS_NOT_PAUSED");
  if (readback.running.length > 0) fail("ROLLOUT_JOBS_RUNNING");
  return readback;
}

// ---------------------------------------------------------------------------
// Cloud Run readback

function container(resource, kind) {
  const spec = kind === "service" ? resource?.spec?.template?.spec : resource?.spec?.template?.spec?.template?.spec;
  const containers = spec?.containers;
  return Array.isArray(containers) && containers.length === 1 && isRecord(containers[0]) ? containers[0] : null;
}

function sourceCommitOf(entry) {
  const env = Array.isArray(entry?.env) ? entry.env : [];
  const matches = env.filter((variable) => variable?.name === "DEPLOYMENT_SOURCE_COMMIT");
  return matches.length === 1 && typeof matches[0].value === "string" ? matches[0].value : null;
}

function verifyDeployed(resource, kind, image, commit) {
  const entry = container(resource, kind);
  if (entry === null || entry.image !== image || sourceCommitOf(entry) !== commit) fail("ROLLOUT_READBACK_MISMATCH");
  if (kind === "service") {
    const status = resource.status;
    const traffic = Array.isArray(status?.traffic) ? status.traffic : [];
    if (typeof status?.latestReadyRevisionName !== "string"
        || status.latestReadyRevisionName !== status.latestCreatedRevisionName
        || traffic.length !== 1 || traffic[0]?.percent !== 100 || traffic[0]?.latestRevision !== true) {
      fail("ROLLOUT_READBACK_MISMATCH");
    }
  }
}

/** The service's run.app origins: status.url, status.address.url and the run.googleapis.com/urls annotation. */
function serviceOrigins(resource) {
  const candidates = [resource?.status?.url, resource?.status?.address?.url];
  const annotation = resource?.metadata?.annotations?.["run.googleapis.com/urls"];
  if (typeof annotation === "string") {
    try {
      const urls = JSON.parse(annotation);
      if (Array.isArray(urls)) candidates.push(...urls);
    } catch {
      // An unparsable annotation adds nothing.
    }
  }
  return [...new Set(candidates.map((value) => canonicalRunAppOrigin(value)).filter((value) => value !== null))];
}

/**
 * The service's HOST_ORIGIN: the one origin the CR-7 host accepts requests
 * for (its Node adapter answers any other Host with EP-6's 421). It must be
 * exactly one canonical run.app origin, and one of the service's own run.app
 * origins, else ROLLOUT_SERVICE_HOST_ORIGIN_INVALID: Cloud Run serves two URL
 * forms, and an edge or verifier aimed at the other one would only ever be
 * refused.
 */
function hostOriginOf(resource) {
  const env = container(resource, "service")?.env;
  const matches = (Array.isArray(env) ? env : []).filter((variable) => variable?.name === "HOST_ORIGIN");
  const value = matches.length === 1 && typeof matches[0].value === "string" ? matches[0].value : null;
  if (value === null || canonicalRunAppOrigin(value) !== value || !serviceOrigins(resource).includes(value)) {
    fail("ROLLOUT_SERVICE_HOST_ORIGIN_INVALID");
  }
  return value;
}

/**
 * The live service before a migrate or roll: its DEPLOYMENT_SOURCE_COMMIT,
 * run.app origins and HOST_ORIGIN. An absent, duplicated or malformed commit
 * is refused (ROLLOUT_LIVE_COMMIT_UNKNOWN) rather than replaced by --commit:
 * OPS-2 apply always renders the service with its bootstrap commit, so a
 * readable predecessor exists from the first rollout on.
 */
function liveService(context, target) {
  const stdout = runChecked(context, ROLLOUT_ARGV.serviceDescribe(target), "ROLLOUT_SERVICE_DESCRIBE_FAILED");
  const resource = parseJson(stdout, "ROLLOUT_SERVICE_DESCRIBE_FAILED");
  const commit = sourceCommitOf(container(resource, "service"));
  if (commit === null || !COMMIT.test(commit)) fail("ROLLOUT_LIVE_COMMIT_UNKNOWN");
  return Object.freeze({ commit, origins: Object.freeze(serviceOrigins(resource)), hostOrigin: hostOriginOf(resource) });
}

// ---------------------------------------------------------------------------
// Lock

// The environment's own ref only: the factory refuses any other pair, and a
// lock that reports another ref is refused before any owner is created.
async function underLock(context, environment, record, operation) {
  const ref = deploymentLockRef(environment);
  const lock = context.lockFactory({ environment, ref, repositoryRoot: REPOSITORY_ROOT });
  if (lock?.ref !== ref) fail("ROLLOUT_LOCK_REF_MISMATCH");
  const owner = await lock.createOwner({ id: context.uuid(), ...record });
  await lock.acquire(owner);
  context.lockEvents.push("acquired");
  try {
    return await operation(() => lock.assertOwned(owner));
  } finally {
    await lock.release(owner);
    context.lockEvents.push("released");
  }
}

// ---------------------------------------------------------------------------
// Receipts

export function rolloutReceiptDigest(receipt) {
  const { digest: _ignored, ...body } = receipt;
  return sha256(canonicalJson(body));
}

const MIGRATE_RECEIPT_KEYS = Object.freeze([
  "schema", "environment", "project", "commit", "digest", "image", "migrationJob", "execution", "backups",
  "migrationReceiptDigest", "manifestSha256", "migrationCount", "completedAt", "digestSha256",
]);

function migrateReceiptBody(receipt) {
  const { digestSha256: _ignored, ...body } = receipt;
  return body;
}

export function verifyMigrateReceipt(receipt) {
  const ok = hasExactKeys(receipt, MIGRATE_RECEIPT_KEYS)
    && receipt.schema === ROLLOUT_MIGRATE_RECEIPT_SCHEMA
    && ROLLOUT_ENVIRONMENTS.includes(receipt.environment)
    && PROJECT.test(receipt.project ?? "")
    && COMMIT.test(receipt.commit ?? "")
    && DIGEST.test(receipt.digest ?? "")
    && typeof receipt.image === "string" && receipt.image.endsWith(`@${receipt.digest}`)
    && CLOUD_RUN_NAME.test(receipt.migrationJob ?? "")
    && EXECUTION.test(receipt.execution ?? "")
    && Array.isArray(receipt.backups) && receipt.backups.length === PRE_MIGRATION_BACKUPS
    && receipt.backups.every((backup) => hasExactKeys(backup, ["id", "expiresOn"])
      && BACKUP_ID.test(backup.id) && /^\d{4}-\d{2}-\d{2}$/u.test(backup.expiresOn))
    && new Set(receipt.backups.map(({ id }) => id)).size === PRE_MIGRATION_BACKUPS
    && SHA256.test(receipt.migrationReceiptDigest ?? "")
    && SHA256.test(receipt.manifestSha256 ?? "")
    && Number.isSafeInteger(receipt.migrationCount) && receipt.migrationCount > 0
    && typeof receipt.completedAt === "string" && Number.isFinite(Date.parse(receipt.completedAt))
    && receipt.digestSha256 === sha256(canonicalJson(migrateReceiptBody(receipt)));
  if (!ok) fail("ROLLOUT_MIGRATE_RECEIPT_INVALID");
  return deepFreeze(structuredClone(receipt));
}

async function writeNewReceipt(path, receipt) {
  if ((await lstat(path).catch(() => null)) !== null) fail("ROLLOUT_RECEIPT_EXISTS");
  try {
    await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    fail("ROLLOUT_RECEIPT_WRITE_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Edge

function bindingText(snapshot, name) {
  const bindings = Array.isArray(snapshot?.bindings) ? snapshot.bindings : [];
  const matches = bindings.filter((binding) => binding?.name === name);
  return matches.length === 1 && matches[0].type === "plain_text" && typeof matches[0].text === "string"
    ? matches[0].text
    : null;
}

function gitBlob(context, commit, path) {
  const argv = ROLLOUT_ARGV.gitBlob(commit, path);
  context.commands.push(argv);
  let result;
  try {
    result = context.run(argv);
  } catch {
    return null;
  }
  const value = result?.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : "";
  return /^[0-9a-f]{40}$/u.test(value) ? value : null;
}

async function defaultReadTrackedConfig() {
  const errors = [];
  const config = parseJsonc(await readFile(join(WORKER_ROOT, "wrangler.jsonc"), "utf8"), errors);
  if (errors.length > 0) throw new Error("wrangler.jsonc");
  return config;
}

/**
 * A staging edge identity is closed: exactly {workerName, domains,
 * publicOrigin}; a lowercase Worker name carrying the staging token that is
 * neither production's Worker nor wrangler.jsonc's retired workers.dev
 * staging Worker; and exactly two custom domains, the public host and its
 * admin host, each with a staging label below the zone and none of them a
 * production hostname, with publicOrigin the public host's https origin.
 * Anything else is ROLLOUT_EDGE_IDENTITY_UNRESOLVED.
 */
export function validateStagingEdgeIdentity(identity) {
  const unresolved = () => fail("ROLLOUT_EDGE_IDENTITY_UNRESOLVED");
  if (!hasExactKeys(identity, ["workerName", "domains", "publicOrigin"])
      || typeof identity.workerName !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(identity.workerName)
      || !tokens(identity.workerName).includes("staging")
      || [EDGE_MODE_PRODUCTION_WORKER_NAME, "app-usagemonitor-staging"].includes(identity.workerName)
      || typeof identity.publicOrigin !== "string" || !Array.isArray(identity.domains)) {
    unresolved();
  }
  let origin;
  try {
    origin = new URL(identity.publicOrigin);
  } catch {
    unresolved();
  }
  const host = origin.hostname;
  const expected = [`admin.${host}`, host].sort();
  if (origin.protocol !== "https:" || origin.origin !== identity.publicOrigin
      || JSON.stringify(identity.domains) !== JSON.stringify(expected)
      || expected.some((domain) => EDGE_MODE_PRODUCTION_HOSTNAMES.includes(domain)
        || EDGE_MODE_PRODUCTION_DOMAINS.includes(domain)
        || !domain.split(".").slice(0, -2).includes("staging"))) {
    unresolved();
  }
  return identity;
}

/**
 * The environment's edge: the Worker name, its custom domains and
 * PUBLIC_ORIGIN. Production is as the tracked wrangler.jsonc declares it and
 * must be EP-9's production Worker and domains. Staging is the pinned
 * ROLLOUT_STAGING_EDGE_IDENTITY (the staging-edge Worker), never
 * wrangler.jsonc's env.staging.
 */
export async function trackedEdgeIdentity(environment, readTrackedConfig = defaultReadTrackedConfig) {
  if (environment === "staging") {
    const identity = validateStagingEdgeIdentity(ROLLOUT_STAGING_EDGE_IDENTITY);
    return deepFreeze({ workerName: identity.workerName, domains: [...identity.domains],
      publicOrigin: identity.publicOrigin });
  }
  let config;
  try {
    config = await readTrackedConfig();
  } catch {
    fail("ROLLOUT_EDGE_IDENTITY_UNRESOLVED");
  }
  const declared = config?.env?.[environment];
  const routes = declared?.routes ?? [];
  if (!ROLLOUT_ENVIRONMENTS.includes(environment) || !isRecord(declared) || typeof declared.name !== "string"
      || typeof declared.vars?.PUBLIC_ORIGIN !== "string" || !Array.isArray(routes)) {
    fail("ROLLOUT_EDGE_IDENTITY_UNRESOLVED");
  }
  const domains = routes.filter((route) => isRecord(route) && route.custom_domain === true)
    .map((route) => route.pattern);
  if (domains.some((domain) => typeof domain !== "string")) fail("ROLLOUT_EDGE_IDENTITY_UNRESOLVED");
  domains.sort();
  if (environment === "production" && (declared.name !== EDGE_MODE_PRODUCTION_WORKER_NAME
      || JSON.stringify(domains) !== JSON.stringify([...EDGE_MODE_PRODUCTION_DOMAINS].sort()))) {
    fail("ROLLOUT_EDGE_IDENTITY_UNRESOLVED");
  }
  let origin;
  try {
    origin = new URL(declared.vars.PUBLIC_ORIGIN);
  } catch {
    fail("ROLLOUT_EDGE_IDENTITY_UNRESOLVED");
  }
  if (origin.protocol !== "https:" || origin.origin !== declared.vars.PUBLIC_ORIGIN) {
    fail("ROLLOUT_EDGE_IDENTITY_UNRESOLVED");
  }
  return deepFreeze({ workerName: declared.name, domains, publicOrigin: declared.vars.PUBLIC_ORIGIN });
}

/**
 * A pre-edge Worker (no EDGE_UPSTREAM_MODE) has no EP-9 verifier mode, so its
 * capture is checked for the same identity facts: one active version at 100%
 * that is the snapshot's, the snapshot's source commit, and the expected
 * custom domains.
 */
function verifyPreEdgeCapture({ snapshot, deployment, sourceCommit, expectedDomains }) {
  const versions = isRecord(deployment) ? deployment.versions : null;
  if (!Array.isArray(versions) || versions.length !== 1 || !isRecord(versions[0])
      || versions[0].version_id !== snapshot.versionId || versions[0].percentage !== 100
      || snapshot.sourceCommit !== sourceCommit) {
    return false;
  }
  const domains = Array.isArray(snapshot.domains) ? snapshot.domains.map((domain) => domain?.hostname).sort() : null;
  return JSON.stringify(domains) === JSON.stringify(expectedDomains);
}

/** The owner-supplied live edge capture file: a regular, single-link file of at most 4 MiB of JSON. */
export function readEdgeLiveCaptureFile(path) {
  return readBoundedJson(path, "ROLLOUT_EDGE_LIVE_INVALID", EDGE_CAPTURE_MAX_BYTES);
}

/** A capture time is fresh when it is at most EDGE_CAPTURE_MAX_AGE_MS old and not in the future. */
export function assertEdgeCaptureFresh(nowMs, capturedAt) {
  if (capturedAt > nowMs + FUTURE_TOLERANCE_MS || nowMs - capturedAt > EDGE_CAPTURE_MAX_AGE_MS) {
    fail("ROLLOUT_EDGE_LIVE_STALE");
  }
}

/**
 * EP-9: verify a parsed live edge capture for an environment. The capture
 * must be fresh at `nowMs`, of the environment's Worker, and verify for its
 * own mode (verifyEdgeModeLiveSnapshot for worker, fenced and gcp with the
 * environment's domains; verifyPreEdgeCapture for a pre-edge Worker), with a
 * single active deployment and the snapshot's source commit, and serve the
 * environment's PUBLIC_ORIGIN. Returns the live mode ("unset" for a pre-edge
 * Worker), the edge's DEPLOYMENT_SOURCE_COMMIT and the capture time.
 */
export async function verifyEdgeLiveCapture(capture, { environment, nowMs, readTrackedConfig }) {
  if (!hasExactKeys(capture, ROLLOUT_EDGE_LIVE_KEYS) || capture.schema !== ROLLOUT_EDGE_LIVE_SCHEMA
      || typeof capture.capturedAt !== "string" || !ISO_INSTANT.test(capture.capturedAt)
      || !Number.isFinite(Date.parse(capture.capturedAt)) || !isRecord(capture.snapshot)) {
    fail("ROLLOUT_EDGE_LIVE_INVALID");
  }
  assertEdgeCaptureFresh(nowMs, Date.parse(capture.capturedAt));
  let mode;
  try {
    mode = liveEdgeMode(capture.snapshot);
  } catch {
    fail("ROLLOUT_EDGE_LIVE_INVALID");
  }
  const identity = await trackedEdgeIdentity(environment, readTrackedConfig);
  if (capture.snapshot.workerName !== identity.workerName) fail("ROLLOUT_EDGE_LIVE_TARGET_MISMATCH");
  const edgeCommit = bindingText(capture.snapshot, "DEPLOYMENT_SOURCE_COMMIT");
  if (edgeCommit === null || !COMMIT.test(edgeCommit)) fail("ROLLOUT_EDGE_LIVE_INVALID");
  const verified = mode === null
    ? verifyPreEdgeCapture({
      snapshot: capture.snapshot, deployment: capture.deployment, sourceCommit: edgeCommit,
      expectedDomains: identity.domains,
    })
    : verifyEdgeModeLiveSnapshot({
      snapshot: capture.snapshot, mode, deployment: capture.deployment, sourceCommit: edgeCommit,
      expectedDomains: identity.domains,
    }).ok === true;
  if (!verified) fail("ROLLOUT_EDGE_LIVE_UNVERIFIED");
  if (bindingText(capture.snapshot, "PUBLIC_ORIGIN") !== identity.publicOrigin) {
    fail("ROLLOUT_EDGE_LIVE_TARGET_MISMATCH");
  }
  return Object.freeze({
    mode: mode ?? "unset",
    edgeCommit,
    capturedAt: capture.capturedAt,
    publicOrigin: identity.publicOrigin,
    upstreamOrigin: mode === "gcp" ? bindingText(capture.snapshot, EDGE_MODE_GCP_VARS.upstreamOrigin) : null,
    originAudience: mode === "gcp" ? bindingText(capture.snapshot, EDGE_MODE_GCP_VARS.originAudience) : null,
  });
}

// ---------------------------------------------------------------------------
// Edge capture (capture-edge)

const CAPTURE_EDGE_FLAGS = Object.freeze({
  required: Object.freeze(["--environment", "--inventory", "--inventory-sha256", "--output"]),
  optional: Object.freeze([]),
});
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
/** readEdgeLiveCaptureFile's bound: a capture roll could not read is never written. */
const EDGE_CAPTURE_MAX_BYTES = 4 * MAX_INPUT_BYTES;

/**
 * Parse `capture-edge --environment=<env> --inventory=<file>
 * --inventory-sha256=<hex> --output=<new file> [--execute]`. The inventory is
 * the owner-private Cloudflare inventory production deploys and the
 * staging-edge driver already take (--inventory, --inventory-sha256): it
 * supplies the account id, and CLOUDFLARE_API_TOKEN the credential, exactly as
 * there. Both paths are absolute.
 */
export function parseCaptureEdgeArguments(argv) {
  if (!Array.isArray(argv) || argv[0] !== ROLLOUT_EDGE_CAPTURE_VERB) fail("ROLLOUT_VERB_INVALID");
  const { values, execute } = readFlags(argv, CAPTURE_EDGE_FLAGS);
  const environment = values.get("--environment");
  if (!ROLLOUT_ENVIRONMENTS.includes(environment)) fail("ROLLOUT_ENVIRONMENT_INVALID");
  if (!isAbsolute(values.get("--inventory")) || !isAbsolute(values.get("--output"))) fail("ROLLOUT_PATH_INVALID");
  if (!SHA256.test(values.get("--inventory-sha256"))) fail("ROLLOUT_ARGUMENT_INVALID");
  return deepFreeze({
    verb: ROLLOUT_EDGE_CAPTURE_VERB,
    environment,
    inventory: values.get("--inventory"),
    inventorySha256: values.get("--inventory-sha256"),
    output: resolve(values.get("--output")),
    execute,
  });
}

/**
 * The capture's destination: a path that does not exist (not even as a
 * symlink), whose parent is an existing directory outside every git checkout
 * and safe to hold an owner-only file (see captureParentSafe). Returns the
 * path under the parent's real path.
 */
async function captureOutputPath(output, repositoryRoot) {
  if ((await lstat(output).catch(() => null)) !== null) fail("ROLLOUT_EDGE_CAPTURE_OUTPUT_EXISTS");
  let parent;
  try {
    parent = await realpath(dirname(output));
  } catch {
    fail("ROLLOUT_EDGE_CAPTURE_OUTPUT_INVALID");
  }
  if (basename(output) === "") fail("ROLLOUT_EDGE_CAPTURE_OUTPUT_INVALID");
  await captureParentSafe(parent, repositoryRoot);
  return join(parent, basename(output));
}

/**
 * The checks on the capture's real parent directory, run before the reads and
 * again once the file is open:
 * - a directory outside this repository (compared on real paths,
 *   case-insensitively, so a symlinked or differently-cased parent cannot
 *   reach the checkout);
 * - outside every other git checkout too (the owner's main checkout, a
 *   sibling worktree, a `.git` directory): no directory from the parent up to
 *   `/` holds a `.git` entry, file or directory. A `.git` directory's own
 *   parent holds it, so a path inside one is refused as well. An entry that
 *   cannot be read is treated as present;
 * - the rule of production-reconcile.mjs createPrivateReconciliationOutputDirectory:
 *   owned by this user and not group- or world-writable, unless it is a
 *   root-owned sticky directory, so nobody else can later replace the capture.
 */
async function captureParentSafe(parent, repositoryRoot) {
  let info;
  let root;
  try {
    info = await lstat(parent);
    root = await realpath(repositoryRoot);
  } catch {
    fail("ROLLOUT_EDGE_CAPTURE_OUTPUT_INVALID");
  }
  if (!info.isDirectory()) fail("ROLLOUT_EDGE_CAPTURE_OUTPUT_INVALID");
  const folded = parent.toLowerCase();
  const rootFolded = root.toLowerCase();
  if (folded === rootFolded || folded.startsWith(rootFolded.endsWith(sep) ? rootFolded : `${rootFolded}${sep}`)) {
    fail("ROLLOUT_EDGE_CAPTURE_OUTPUT_IN_REPOSITORY");
  }
  for (let directory = parent; ; directory = dirname(directory)) {
    const marker = await lstat(join(directory, ".git")).then(() => true, (error) => error?.code !== "ENOENT");
    if (marker) fail("ROLLOUT_EDGE_CAPTURE_OUTPUT_IN_REPOSITORY");
    if (dirname(directory) === directory) break;
  }
  const uid = process.getuid?.();
  const rootOwnedSticky = info.uid === 0 && (info.mode & 0o1000) !== 0;
  if (!rootOwnedSticky && ((uid !== undefined && info.uid !== uid) || (info.mode & 0o022) !== 0)) {
    fail("ROLLOUT_EDGE_CAPTURE_OUTPUT_UNSAFE");
  }
}

/**
 * The production deploy's reader (production-reconcile.mjs): a regular,
 * single-link, owner-only file whose bytes match the given sha256.
 */
async function defaultReadCaptureInventory(path, expectedSha256) {
  if ((await lstat(path).catch(() => null)) === null) fail("ROLLOUT_EDGE_CAPTURE_INVENTORY_REQUIRED");
  const { readPrivateProductionInventory } = await import("./production-reconcile.mjs");
  return readPrivateProductionInventory(path, expectedSha256);
}

/** The account id from the owner-private inventory, which must be of the environment's edge Worker. */
async function captureAccountId(context, args, identity) {
  let inventory;
  try {
    inventory = await context.readInventory(args.inventory, args.inventorySha256);
  } catch (error) {
    fail(error?.code === "ROLLOUT_EDGE_CAPTURE_INVENTORY_REQUIRED" ? error.code : "ROLLOUT_EDGE_CAPTURE_INVENTORY_INVALID");
  }
  if (!isRecord(inventory) || typeof inventory.accountId !== "string" || !ACCOUNT_ID.test(inventory.accountId)) {
    fail("ROLLOUT_EDGE_CAPTURE_INVENTORY_INVALID");
  }
  if (inventory.workerName !== identity.workerName) fail("ROLLOUT_EDGE_CAPTURE_TARGET_MISMATCH");
  return inventory.accountId;
}

function liveReadCode(error) {
  return typeof error?.code === "string" && /^PRODUCTION_LIVE_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : "ROLLOUT_EDGE_CAPTURE_READ_FAILED";
}

/**
 * O_EXCL and O_NOFOLLOW at mode 0600: an existing path or a symlink is
 * refused, never followed or replaced. O_NOFOLLOW guards only the last
 * component, so before any byte is written the open file must still be the
 * entry at `path` on real paths (a parent swapped for a symlink during the
 * reads is caught) and the parent must pass captureParentSafe again. On a
 * failure the empty file this call created is removed, matched by device
 * and inode.
 */
async function writeCaptureExclusive(path, bytes, repositoryRoot) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    fail(error?.code === "EEXIST" || error?.code === "ELOOP"
      ? "ROLLOUT_EDGE_CAPTURE_OUTPUT_EXISTS" : "ROLLOUT_EDGE_CAPTURE_WRITE_FAILED");
  }
  let opened;
  try {
    opened = await handle.stat();
    const real = await realpath(path);
    const entry = await lstat(real);
    if (real !== path || !entry.isFile() || entry.dev !== opened.dev || entry.ino !== opened.ino) {
      fail("ROLLOUT_EDGE_CAPTURE_OUTPUT_CHANGED");
    }
    await captureParentSafe(dirname(real), repositoryRoot);
  } catch (error) {
    await handle.close().catch(() => {});
    await removeCreatedCapture(path, opened);
    fail(/^ROLLOUT_EDGE_CAPTURE_OUTPUT_[A-Z_]+$/u.test(error?.code ?? "") ? error.code
      : "ROLLOUT_EDGE_CAPTURE_OUTPUT_CHANGED");
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
  } catch {
    await handle.close().catch(() => {});
    await removeCreatedCapture(path, opened);
    fail("ROLLOUT_EDGE_CAPTURE_WRITE_FAILED");
  }
}

/** Unlink only the file this call created: the entry at `path` (or where it now resolves) with the open file's device and inode. */
async function removeCreatedCapture(path, opened) {
  if (opened === undefined) return;
  for (const candidate of [await realpath(path).catch(() => null), path]) {
    const entry = candidate === null ? null : await lstat(candidate).catch(() => null);
    if (entry?.isFile() && entry.dev === opened.dev && entry.ino === opened.ino) {
      await unlink(candidate).catch(() => {});
      return;
    }
  }
}

/**
 * capture-edge: read the environment's edge Worker through the reviewed
 * read-only provider (createProductionLiveProvider, which refuses a Worker
 * whose active deployment is not one version at 100% or changes during the
 * reads), canonicalize it (createProductionLiveConfigSnapshot), and write
 * {schema, capturedAt, snapshot, deployment}. capturedAt is the injected
 * clock before the first read, so freshness never overstates; deployment is
 * that single active version. The capture is verified with
 * verifyEdgeLiveCapture, as roll will read it, before anything is written,
 * and an unverified one is refused with nothing written. No lock, no gcloud,
 * no git. Without --execute it validates the arguments, the output path and
 * the inventory, and makes no request. The result is content-free: mode,
 * edge commit, capture time and the file's sha256.
 */
async function captureEdge(argv, dependencies) {
  const args = parseCaptureEdgeArguments(argv);
  const context = {
    now: dependencies.now ?? Date.now,
    readTrackedConfig: dependencies.readTrackedConfig ?? defaultReadTrackedConfig,
    readInventory: dependencies.readInventory ?? defaultReadCaptureInventory,
    liveProviderFactory: dependencies.liveProviderFactory ?? createProductionLiveProvider,
    repositoryRoot: dependencies.repositoryRoot ?? REPOSITORY_ROOT,
  };
  const identity = await trackedEdgeIdentity(args.environment, context.readTrackedConfig);
  const output = await captureOutputPath(args.output, context.repositoryRoot);
  const accountId = await captureAccountId(context, args, identity);
  if (!args.execute) {
    return deepFreeze({ status: "dry-run", verb: args.verb, environment: args.environment, reads: "cloudflare-read-only" });
  }
  const capturedAt = new Date(context.now()).toISOString();
  let inventory;
  try {
    inventory = await context.liveProviderFactory({ accountId, workerName: identity.workerName }).capture();
  } catch (error) {
    fail(liveReadCode(error));
  }
  if (!isRecord(inventory) || inventory.accountId !== accountId || inventory.workerName !== identity.workerName) {
    fail("ROLLOUT_EDGE_CAPTURE_TARGET_MISMATCH");
  }
  let snapshot;
  try {
    snapshot = createProductionLiveConfigSnapshot(inventory);
  } catch (error) {
    fail(liveReadCode(error));
  }
  const capture = {
    schema: ROLLOUT_EDGE_LIVE_SCHEMA,
    capturedAt,
    snapshot,
    deployment: { versions: [{ version_id: snapshot.versionId, percentage: 100 }] },
  };
  const edge = await verifyEdgeLiveCapture(capture, {
    environment: args.environment, nowMs: context.now(), readTrackedConfig: context.readTrackedConfig,
  });
  const bytes = Buffer.from(`${JSON.stringify(capture, null, 2)}\n`, "utf8");
  if (bytes.length > EDGE_CAPTURE_MAX_BYTES) fail("ROLLOUT_EDGE_CAPTURE_TOO_LARGE");
  await writeCaptureExclusive(output, bytes, context.repositoryRoot);
  return deepFreeze({
    status: "ok",
    verb: args.verb,
    environment: args.environment,
    mode: edge.mode,
    edgeCommit: edge.edgeCommit,
    capturedAt: edge.capturedAt,
    sha256: sha256(bytes),
  });
}

/**
 * D-BLOB (docs/runbooks/production-edge-modes.md, "Cloud Run deploys"): an
 * origin deploy refuses EDGE_CONTRACT_DRIFT unless
 * src/edge-origin-contract.ts has one and the same git blob at the deployed
 * origin commit and at the live edge's DEPLOYMENT_SOURCE_COMMIT, in every
 * edge mode. A pre-edge Worker carries no contract file, so an origin deploy
 * against it refuses: the edge port goes live (worker mode) first.
 * `readBlob(commit, path)` returns the 40-hex blob id or null; local git only.
 */
export function assertOriginContractBlob({ originCommit, edgeCommit, readBlob }) {
  if (typeof readBlob !== "function" || !COMMIT.test(originCommit ?? "") || !COMMIT.test(edgeCommit ?? "")) {
    fail("EDGE_CONTRACT_DRIFT");
  }
  const candidate = readBlob(originCommit, EDGE_ORIGIN_CONTRACT_PATH);
  const live = readBlob(edgeCommit, EDGE_ORIGIN_CONTRACT_PATH);
  if (typeof candidate !== "string" || !COMMIT.test(candidate) || candidate !== live) fail("EDGE_CONTRACT_DRIFT");
  return candidate;
}

/**
 * Read and verify the live edge capture for this roll (verifyEdgeLiveCapture),
 * then the contract blob at --commit against the live edge's commit
 * (assertOriginContractBlob) in every mode. In gcp mode the edge's upstream
 * origin and audience are returned for the service check.
 */
async function checkEdgeContract(context, args) {
  const capture = await readEdgeLiveCaptureFile(args.edgeLive);
  const edge = await verifyEdgeLiveCapture(capture, {
    environment: args.environment, nowMs: context.now(), readTrackedConfig: context.readTrackedConfig,
  });
  const contractBlob = assertOriginContractBlob({
    originCommit: args.commit,
    edgeCommit: edge.edgeCommit,
    readBlob: (commit, path) => gitBlob(context, commit, path),
  });
  return Object.freeze({ ...edge, contractBlob });
}

/**
 * In gcp mode the live edge must forward to this service, with the target's
 * audience, on exactly the service's HOST_ORIGIN: the edge's
 * EDGE_UPSTREAM_ORIGIN and the origin's HOST_ORIGIN must be byte-equal, or
 * every forward is a 421 (wave-3 host brief B7).
 */
function assertEdgeTargetsService(edge, service, target) {
  if (edge.mode !== "gcp") return;
  if (edge.upstreamOrigin === null || !service.origins.includes(edge.upstreamOrigin)
      || edge.upstreamOrigin !== service.hostOrigin
      || edge.originAudience !== target.originAudience) {
    fail("ROLLOUT_EDGE_ORIGIN_MISMATCH");
  }
}

/**
 * The first-roll ready path (D-CRB): the origin's /api/ready is Worker-exact
 * (OD-CR-4), so a database no MP-2-lite lifecycle pass has run against reads
 * not_ready, and the EP-6 verifier refuses it. Roll therefore runs one
 * maintenance Job execution, the pass itself, after the new image is rolled
 * and before it verifies. Exactly one succeeded execution of that job.
 */
function runMaintenancePass(context, target) {
  const execution = parseJson(runChecked(context, ROLLOUT_ARGV.jobExecute(target, target.maintenanceJob),
    "ROLLOUT_MAINTENANCE_PASS_FAILED"), "ROLLOUT_MAINTENANCE_PASS_FAILED");
  const executionName = execution?.metadata?.name;
  if (typeof executionName !== "string" || !EXECUTION.test(executionName)
      || !executionName.startsWith(`${target.maintenanceJob}-`)
      || execution?.status?.succeededCount !== 1 || (execution?.status?.failedCount ?? 0) !== 0) {
    fail("ROLLOUT_MAINTENANCE_PASS_FAILED");
  }
  return executionName;
}

async function boundedHealth(response) {
  if (typeof response?.text !== "function") return null;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > HEALTH_MAX_BYTES) return null;
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * After the roll: the public /api/health, which a gcp-mode edge forwards to
 * the origin, must answer 200 with status "ok" and deployment.sourceCommit
 * equal to --commit. Any other mode serves the Worker publicly, so the origin
 * is read through the EP-6 verifier path instead (verifyEdgeOriginBeforeGcp
 * with a verifier identity token for the target's audience, on the service's
 * own run.app origin), whose originCommit must equal --commit.
 */
async function verifyServedCommit(context, args, target, edge, service) {
  if (edge.mode === "gcp") {
    const url = new URL(HEALTH_PATH, edge.publicOrigin).href;
    let response;
    try {
      response = await context.fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
    } catch {
      fail("ROLLOUT_PUBLIC_HEALTH_UNREACHABLE");
    }
    const body = response?.url === url && response.status === 200 ? await boundedHealth(response) : null;
    if (body === null || body.status !== "ok") fail("ROLLOUT_PUBLIC_HEALTH_INVALID");
    if (body.deployment?.sourceCommit !== args.commit) fail("ROLLOUT_PUBLIC_HEALTH_COMMIT_MISMATCH");
    return Object.freeze({ path: "public-health", origin: edge.publicOrigin, sourceCommit: args.commit });
  }
  // The verifier reads the origin on its HOST_ORIGIN, the only Host it serves.
  const upstreamOrigin = service.hostOrigin ?? null;
  if (upstreamOrigin === null) fail("ROLLOUT_ORIGIN_URL_UNAVAILABLE");
  const obtainToken = createGcloudIdentityTokenSource({
    verifierAccount: target.verifierServiceAccount,
    audience: target.originAudience,
    execFile: (command, commandArgs) => {
      const argv = [command, ...commandArgs];
      context.commands.push(argv);
      const result = context.run(argv);
      if (result?.status !== 0 || typeof result.stdout !== "string") throw new Error("token");
      return result.stdout;
    },
  });
  let identityToken = await obtainToken();
  const verification = await verifyEdgeOriginBeforeGcp({ upstreamOrigin, identityToken, fetchImpl: context.fetch });
  identityToken = null;
  if (verification?.ok !== true) {
    fail(typeof verification?.code === "string" ? verification.code : "ROLLOUT_ORIGIN_VERIFIER_FAILED");
  }
  if (verification.originCommit !== args.commit) fail("ROLLOUT_ORIGIN_COMMIT_MISMATCH");
  return Object.freeze({ path: "origin-verifier", origin: upstreamOrigin, sourceCommit: args.commit });
}

// ---------------------------------------------------------------------------
// Verbs

function dryRunResult(args, target, steps, extra = {}) {
  return deepFreeze({
    status: "dry-run",
    verb: args.verb,
    environment: args.environment,
    commit: args.commit,
    ...(args.digest === null ? {} : { digest: args.digest }),
    service: target.service,
    // The exact coordination ref --execute would push; preflight takes no lock.
    ...(args.verb === "preflight" ? {} : { lockRef: deploymentLockRef(args.environment) }),
    steps: steps.map((argv) => ({ argv })),
    ...extra,
  });
}

async function preflight(context, args, target) {
  checkCheckout(context, args.commit);
  const readback = checkInfraReadback(context, args.environment);
  const audit = await checkBackupAudit(context, args, target);
  const scheduledJobs = readScheduledJobs(context, target);
  return Object.freeze({ readbackSha256: readback, backupAudit: audit, scheduledJobs });
}

/** The read-only scheduled-jobs readback argv, in the order preflight runs them. */
function scheduledJobsArgv(target) {
  return [ROLLOUT_ARGV.schedulerList(target), ...target.jobNames.map((job) => ROLLOUT_ARGV.executionsList(target, job))];
}

function preflightArgv(args, target) {
  return [ROLLOUT_ARGV.gitStatus(), ROLLOUT_ARGV.gitHead(), ROLLOUT_ARGV.infraReadback(args.environment),
    ...scheduledJobsArgv(target)];
}

function renderBuildConfig(text, target, commit) {
  const replacements = {
    "${PROJECT}": target.project,
    "${BUILDER_SA}": target.builderServiceAccount,
    "${IMAGE_REPOSITORY}": target.imageRepository,
    "${SOURCE_COMMIT}": commit,
  };
  let rendered = text;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!rendered.includes(placeholder)) fail("ROLLOUT_BUILD_CONFIG_UNEXPECTED");
    rendered = rendered.replaceAll(placeholder, value);
  }
  const remaining = [...rendered.matchAll(/\$\{([A-Za-z_]+)\}/gu)].map((match) => match[1]);
  if (remaining.some((name) => name !== "_IMAGE")) fail("ROLLOUT_BUILD_CONFIG_UNRENDERED");
  return rendered;
}

function builderImageOf(text) {
  const match = /^\s+- name: (gcr\.io\/cloud-builders\/docker@sha256:[0-9a-f]{64})$/mu.exec(text);
  if (match === null) fail("ROLLOUT_BUILD_CONFIG_UNEXPECTED");
  return match[1];
}

/** Build fields this submission never configures; any of them disqualifies the build. */
const BUILD_REFUSED_FIELDS = Object.freeze([
  "buildTriggerId", "secrets", "availableSecrets", "approval", "gitConfig", "dependencies",
]);
const BUILD_OPTION_KEYS = new Set(["logging", "sourceProvenanceHash", "requestedVerifyOption", "pool"]);

function stepImageDigest(value) {
  const match = typeof value === "string" ? /(?:@)?(sha256:[0-9a-f]{64})$/u.exec(value) : null;
  return match?.[1] ?? null;
}

/** The encodings Cloud Build readbacks use for a SHA256 file hash (base64, base64url, padded base64url). */
function archiveHashValues(archiveSha256) {
  const bytes = Buffer.from(archiveSha256, "hex");
  const base64 = bytes.toString("base64");
  return new Set([base64, bytes.toString("base64url"), base64.replaceAll("+", "-").replaceAll("/", "_")]);
}

/**
 * Production build provenance for the rendered production config, checked
 * as the test build's assessCloudBuildProvenance checks its own (that one is
 * bound to the test target): the build's identity (UUID id, projectId and
 * regional name), no trigger, secret, approval or dependency fields, status
 * SUCCESS under the builder service account, the reviewed options
 * (CLOUD_LOGGING_ONLY, sourceProvenanceHash [SHA256], VERIFIED), the single
 * pinned docker step with its exact arguments and the step image's resolved
 * digest, a storage source whose resolved generation equals it, and
 * sourceProvenance.fileHashes holding exactly that object's SHA256, which must
 * equal archiveSha256 (the archive this rollout wrote and submitted). Then the
 * one pushed image's tag and digest.
 */
export function assessProductionBuild(build, { target, commit, builderImage, archiveSha256 }) {
  const unqualified = () => fail("ROLLOUT_BUILD_PROVENANCE_UNQUALIFIED");
  if (!isRecord(build) || typeof archiveSha256 !== "string" || !SHA256.test(archiveSha256)) unqualified();
  const tag = `${target.imageRepository}:source-${commit}`;
  if (typeof build.id !== "string" || !BUILD_ID.test(build.id) || build.projectId !== target.project
      || typeof build.name !== "string"
      || !new RegExp(`^projects/(?:${target.project}|[0-9]{1,20})/locations/${target.region}/builds/${build.id}$`, "u")
        .test(build.name)
      || BUILD_REFUSED_FIELDS.some((field) => Object.hasOwn(build, field))
      || build.status !== "SUCCESS"
      || build.serviceAccount !== `projects/${target.project}/serviceAccounts/${target.builderServiceAccount}`) {
    unqualified();
  }
  const options = build.options;
  if (!isRecord(options) || Object.keys(options).some((key) => !BUILD_OPTION_KEYS.has(key))
      || options.logging !== "CLOUD_LOGGING_ONLY"
      || canonicalJson(options.sourceProvenanceHash) !== canonicalJson(["SHA256"])
      || options.requestedVerifyOption !== "VERIFIED"
      || (options.pool !== undefined && !hasExactKeys(options.pool, []))) {
    unqualified();
  }
  const steps = build.steps;
  const stepImages = build.results?.buildStepImages;
  if (!Array.isArray(steps) || steps.length !== 1 || !isRecord(steps[0]) || steps[0].name !== builderImage
      || canonicalJson(steps[0].args)
        !== canonicalJson(["build", "--file=apps/worker/cloud-run/Dockerfile", `--tag=${tag}`, "."])
      || steps[0].status !== "SUCCESS" || (steps[0].exitCode !== undefined && steps[0].exitCode !== 0)
      || !Array.isArray(stepImages) || stepImages.length !== 1
      || stepImageDigest(stepImages[0]) !== builderImage.slice(builderImage.indexOf("@") + 1)) {
    unqualified();
  }
  const source = build.source?.storageSource;
  const resolved = build.sourceProvenance?.resolvedStorageSource;
  if (!hasExactKeys(build.source, ["storageSource"]) || !hasExactKeys(source, ["bucket", "object", "generation"])
      || typeof source.bucket !== "string" || !BUCKET.test(source.bucket)
      || typeof source.object !== "string" || !OBJECT_NAME.test(source.object)
      || !GENERATION.test(String(source.generation))
      || !hasExactKeys(build.sourceProvenance, ["resolvedStorageSource", "fileHashes"])
      || !hasExactKeys(resolved, ["bucket", "object", "generation"])
      || resolved.bucket !== source.bucket || resolved.object !== source.object
      || String(resolved.generation) !== String(source.generation)) {
    unqualified();
  }
  const sourceUri = `gs://${source.bucket}/${source.object}#${String(source.generation)}`;
  const fileHashes = build.sourceProvenance.fileHashes;
  const hashes = isRecord(fileHashes) && hasExactKeys(fileHashes[sourceUri], ["fileHash"])
    ? fileHashes[sourceUri].fileHash : null;
  if (!isRecord(fileHashes) || Object.keys(fileHashes).length !== 1 || !Array.isArray(hashes) || hashes.length === 0
      || hashes.some((hash) => !hasExactKeys(hash, ["type", "value"]) || typeof hash.type !== "string"
        || typeof hash.value !== "string")
      || new Set(hashes.map((hash) => hash.type)).size !== hashes.length
      || !archiveHashValues(archiveSha256).has(hashes.find((hash) => hash.type === "SHA256")?.value)) {
    unqualified();
  }
  const images = Array.isArray(build.results?.images) ? build.results.images : [];
  const digest = images.length === 1 && images[0]?.name === tag && DIGEST.test(images[0]?.digest ?? "")
    ? images[0].digest : null;
  if (canonicalJson(build.images) !== canonicalJson([tag]) || digest === null) unqualified();
  return Object.freeze({ digest, buildId: build.id, sourceGeneration: String(source.generation) });
}

/** sha256 of the archive file the rollout submits: a regular, unlinked, bounded file. */
async function archiveSha256Of(path) {
  const stat = await lstat(path).catch(() => null);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.size === 0 || stat.size > MAX_ARCHIVE_BYTES) {
    fail("ROLLOUT_BUILD_ARCHIVE_FAILED");
  }
  return sha256(await readFile(path));
}

async function build(context, args, target) {
  const configText = await readFile(join(WORKER_ROOT, BUILD_CONFIG_PATH), "utf8");
  const rendered = renderBuildConfig(configText, target, args.commit);
  const builderImage = builderImageOf(configText);
  if (!args.execute) {
    return dryRunResult(args, target, [
      ROLLOUT_ARGV.gitStatus(),
      ROLLOUT_ARGV.gitHead(),
      ROLLOUT_ARGV.buildArchive(`<build-dir>/${BUILD_ARCHIVE_NAME}`),
      ROLLOUT_ARGV.buildSubmit(target, `<build-dir>/${BUILD_ARCHIVE_NAME}`,
        "<build-dir>/cloudbuild.production.rendered.yaml"),
    ]);
  }
  checkCheckout(context, args.commit);
  // A build replaces nothing that is deployed; its lock record names the commit it builds.
  return underLock(context, args.environment, { sourceCommit: args.commit, previousSourceCommit: args.commit }, async (assertOwned) => {
    const directory = await mkdtemp(join(context.tmpdir(), "tibotattle-production-build-"));
    try {
      const configPath = join(directory, "cloudbuild.production.rendered.yaml");
      const archivePath = join(directory, BUILD_ARCHIVE_NAME);
      await writeFile(configPath, rendered, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const archive = parseJson(runChecked(context, ROLLOUT_ARGV.buildArchive(archivePath),
        "ROLLOUT_BUILD_ARCHIVE_FAILED"), "ROLLOUT_BUILD_ARCHIVE_FAILED");
      if (archive?.status !== "ok" || archive.output !== archivePath
          || !SHA256.test(archive.sourceArchiveSha256 ?? "") || !SHA256.test(archive.sourceContentDigest ?? "")) {
        fail("ROLLOUT_BUILD_ARCHIVE_FAILED");
      }
      const archiveSha256 = await archiveSha256Of(archivePath);
      if (archiveSha256 !== archive.sourceArchiveSha256) fail("ROLLOUT_BUILD_ARCHIVE_MISMATCH");
      assertOwned();
      const stdout = runChecked(context, ROLLOUT_ARGV.buildSubmit(target, archivePath, configPath), "ROLLOUT_BUILD_FAILED");
      const { digest, buildId, sourceGeneration } = assessProductionBuild(parseJson(stdout, "ROLLOUT_BUILD_FAILED"),
        { target, commit: args.commit, builderImage, archiveSha256 });
      return deepFreeze({
        schema: ROLLOUT_BUILD_RECEIPT_SCHEMA,
        environment: args.environment,
        commit: args.commit,
        digest,
        image: imageReference(target, digest),
        buildId,
        sourceArchiveSha256: archiveSha256,
        sourceContentDigest: archive.sourceContentDigest,
        sourceGeneration,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

function backupSpawn(context) {
  return (command, args) => {
    const argv = [command, ...args];
    if (argv.some((part) => typeof part !== "string")) return { status: 1, stdout: "", error: new Error("argv") };
    context.commands.push(argv);
    try {
      const result = context.run(argv);
      return { status: result?.status ?? 1, stdout: result?.stdout ?? "", error: null };
    } catch {
      return { status: 1, stdout: "", error: new Error("runner") };
    }
  };
}

/** The OPS-1 label createOnDemandBackup gives a pre-migration backup taken now. */
function migrationDescription(context) {
  return formatOnDemandDescription({
    expiresOn: onDemandExpiresOn(context.now(), PRE_MIGRATION_BACKUP_EXPIRES_IN_DAYS),
    purpose: "pre-migration",
  });
}

function readMigrationReceipt(context, target, execution) {
  const stdout = runChecked(context, ROLLOUT_ARGV.migrationLog(target, target.migrationJob, execution),
    "ROLLOUT_MIGRATION_RECEIPT_UNAVAILABLE");
  const entries = parseJson(stdout, "ROLLOUT_MIGRATION_RECEIPT_UNAVAILABLE");
  const receipts = Array.isArray(entries)
    ? entries.filter((entry) => entry?.jsonPayload?.schema === PRODUCTION_MIGRATION_RECEIPT_SCHEMA
      && entry?.labels?.["run.googleapis.com/execution_name"] === execution)
    : [];
  if (receipts.length !== 1) fail("ROLLOUT_MIGRATION_RECEIPT_UNAVAILABLE");
  return verifyProductionMigrationReceipt(receipts[0].jsonPayload);
}

async function migrate(context, args, target) {
  const image = imageReference(target, args.digest);
  const local = await checkMigrations(context);
  if ((await lstat(args.migrateReceipt).catch(() => null)) !== null) fail("ROLLOUT_RECEIPT_EXISTS");
  const description = migrationDescription(context);
  if (!args.execute) {
    return dryRunResult(args, target, [
      ...preflightArgv(args, target),
      ...Array.from({ length: PRE_MIGRATION_BACKUPS }, () => ROLLOUT_ARGV.backupCreate(target, description)),
      ...scheduledJobsArgv(target),
      ROLLOUT_ARGV.jobUpdate(target, target.migrationJob, image, args.commit),
      ROLLOUT_ARGV.jobExecute(target, target.migrationJob),
      ROLLOUT_ARGV.migrationLog(target, target.migrationJob, "<execution>"),
    ]);
  }
  checkCheckout(context, args.commit);
  const live = liveService(context, target);
  return underLock(context, args.environment, { sourceCommit: args.commit, previousSourceCommit: live.commit }, async (assertOwned) => {
    assertQuiescent((await preflight(context, args, target)).scheduledJobs);
    const backups = [];
    for (let index = 0; index < PRE_MIGRATION_BACKUPS; index += 1) {
      const created = (context.createBackup ?? createOnDemandBackup)({ spawn: backupSpawn(context), now: context.now }, {
        environment: args.environment,
        project: target.project,
        instance: target.primaryInstance,
        instanceRole: "primary",
        purpose: "pre-migration",
        expiresInDays: PRE_MIGRATION_BACKUP_EXPIRES_IN_DAYS,
        region: target.region,
      });
      if (!BACKUP_ID.test(created?.id ?? "") || backups.some(({ id }) => id === created.id)) {
        fail("ROLLOUT_BACKUP_READBACK_INVALID");
      }
      backups.push({ id: created.id, expiresOn: created.expiresOn });
    }
    // The backups take minutes: read the jobs again right before the DDL.
    assertQuiescent(readScheduledJobs(context, target));
    assertOwned();
    runChecked(context, ROLLOUT_ARGV.jobUpdate(target, target.migrationJob, image, args.commit), "ROLLOUT_JOB_UPDATE_FAILED");
    const execution = parseJson(runChecked(context, ROLLOUT_ARGV.jobExecute(target, target.migrationJob),
      "ROLLOUT_MIGRATION_FAILED"), "ROLLOUT_MIGRATION_FAILED");
    const executionName = execution?.metadata?.name;
    if (typeof executionName !== "string" || !EXECUTION.test(executionName)
        || !executionName.startsWith(`${target.migrationJob}-`)
        || execution?.status?.succeededCount !== 1 || (execution?.status?.failedCount ?? 0) !== 0) {
      fail("ROLLOUT_MIGRATION_FAILED");
    }
    const receipt = readMigrationReceipt(context, target, executionName);
    if (receipt.environment !== args.environment || receipt.sourceCommit !== args.commit
        || receipt.job !== target.migrationJob || receipt.target.kind !== "environment"
        || receipt.target.instanceConnectionName !== `${target.project}:${target.region}:${target.primaryInstance}`
        || receipt.migrations.manifestSha256 !== local.manifestSha256
        || receipt.migrations.count !== local.count) {
      fail("ROLLOUT_MIGRATION_RECEIPT_MISMATCH");
    }
    const body = {
      schema: ROLLOUT_MIGRATE_RECEIPT_SCHEMA,
      environment: args.environment,
      project: target.project,
      commit: args.commit,
      digest: args.digest,
      image,
      migrationJob: target.migrationJob,
      execution: executionName,
      backups,
      migrationReceiptDigest: receipt.digest,
      manifestSha256: local.manifestSha256,
      migrationCount: local.count,
      completedAt: new Date(context.now()).toISOString(),
    };
    const migrateReceipt = deepFreeze({ ...body, digestSha256: sha256(canonicalJson(body)) });
    await writeNewReceipt(args.migrateReceipt, migrateReceipt);
    return migrateReceipt;
  });
}

async function requireMigrateReceipt(context, args, target) {
  const receipt = verifyMigrateReceipt(await readBoundedJson(args.migrateReceipt, "ROLLOUT_MIGRATE_RECEIPT_INVALID"));
  if (receipt.environment !== args.environment || receipt.project !== target.project
      || receipt.commit !== args.commit || receipt.digest !== args.digest
      || receipt.image !== imageReference(target, args.digest) || receipt.migrationJob !== target.migrationJob) {
    fail("ROLLOUT_MIGRATE_RECEIPT_MISMATCH");
  }
  const completedAt = Date.parse(receipt.completedAt);
  const now = context.now();
  if (completedAt > now + FUTURE_TOLERANCE_MS || now - completedAt > MIGRATE_RECEIPT_MAX_AGE_MS) {
    fail("ROLLOUT_MIGRATE_RECEIPT_STALE");
  }
  return receipt;
}

async function roll(context, args, target) {
  const image = imageReference(target, args.digest);
  const migrateReceipt = await requireMigrateReceipt(context, args, target);
  const edge = await checkEdgeContract(context, args);
  if (!args.execute) {
    return dryRunResult(args, target, [
      ...preflightArgv(args, target),
      ROLLOUT_ARGV.serviceDescribe(target),
      ROLLOUT_ARGV.serviceUpdate(target, image, args.commit),
      ...target.jobNames.map((job) => ROLLOUT_ARGV.jobUpdate(target, job, image, args.commit)),
      ROLLOUT_ARGV.serviceDescribe(target),
      ...target.jobNames.map((job) => ROLLOUT_ARGV.jobDescribe(target, job)),
      ROLLOUT_ARGV.infraReadback(args.environment),
      ...(target.maintenanceJob === null ? [] : [ROLLOUT_ARGV.jobExecute(target, target.maintenanceJob)]),
      ...(edge.mode === "gcp" ? [] : [ROLLOUT_ARGV.identityToken(target)]),
    ], {
      edge: { mode: edge.mode, edgeCommit: edge.edgeCommit, capturedAt: edge.capturedAt },
      maintenancePass: target.maintenanceJob === null
        ? (edge.mode === "gcp" ? "unavailable" : "required-unavailable")
        : "before-verification",
      servedCommitCheck: edge.mode === "gcp"
        ? { path: "public-health", url: new URL(HEALTH_PATH, edge.publicOrigin).href }
        : { path: "origin-verifier", paths: ["/api/health", "/api/ready"] },
    });
  }
  checkCheckout(context, args.commit);
  // The origin-verifier path needs /api/ready to read ready, which only a
  // lifecycle pass makes true: without a maintenance Job, refuse before any
  // write rather than roll an origin no verification can pass.
  if (edge.mode !== "gcp" && target.maintenanceJob === null) fail("ROLLOUT_MAINTENANCE_JOB_REQUIRED");
  const live = liveService(context, target);
  assertEdgeTargetsService(edge, live, target);
  return underLock(context, args.environment, { sourceCommit: args.commit, previousSourceCommit: live.commit }, async (assertOwned) => {
    const { scheduledJobs } = await preflight(context, args, target);
    assertQuiescent(scheduledJobs);
    assertEdgeCaptureFresh(context.now(), Date.parse(edge.capturedAt));
    assertOwned();
    runChecked(context, ROLLOUT_ARGV.serviceUpdate(target, image, args.commit), "ROLLOUT_SERVICE_UPDATE_FAILED");
    for (const job of target.jobNames) {
      runChecked(context, ROLLOUT_ARGV.jobUpdate(target, job, image, args.commit), "ROLLOUT_JOB_UPDATE_FAILED");
    }
    const service = parseJson(runChecked(context, ROLLOUT_ARGV.serviceDescribe(target), "ROLLOUT_READBACK_FAILED"),
      "ROLLOUT_READBACK_FAILED");
    verifyDeployed(service, "service", image, args.commit);
    for (const job of target.jobNames) {
      verifyDeployed(parseJson(runChecked(context, ROLLOUT_ARGV.jobDescribe(target, job), "ROLLOUT_READBACK_FAILED"),
        "ROLLOUT_READBACK_FAILED"), "job", image, args.commit);
    }
    const readback = checkInfraReadback(context, args.environment);
    const rolledService = { origins: serviceOrigins(service), hostOrigin: hostOriginOf(service) };
    assertEdgeTargetsService(edge, rolledService, target);
    if (target.maintenanceJob !== null) runMaintenancePass(context, target);
    const served = await verifyServedCommit(context, args, target, edge, rolledService);
    const rolledAt = context.now();
    const body = {
      schema: ROLLOUT_ROLL_RECEIPT_SCHEMA,
      environment: args.environment,
      commit: args.commit,
      digest: args.digest,
      image,
      service: target.service,
      jobs: [...target.jobNames],
      previousSourceCommit: live.commit,
      migrateReceiptDigest: migrateReceipt.digestSha256,
      edge: { mode: edge.mode, edgeCommit: edge.edgeCommit, contractBlob: edge.contractBlob, capturedAt: edge.capturedAt },
      infraReadbackSha256: readback,
      servedCommit: served,
      // OPS-3 resume-all resumes these after this receipt; the rollout never does.
      pausedTriggers: scheduledJobs.triggers.map(({ name }) => name),
      // The migrate-to-roll window: the previous revision ran against the
      // migrated schema. Behind an exact-history receipt fence (the only one
      // today) its storage-gated routes answered 503 for this long; see the
      // expand-compatibility note in cloud-run/postgres-production-migrations.mjs.
      secondsSinceMigrate: Math.max(0, Math.round((rolledAt - Date.parse(migrateReceipt.completedAt)) / 1_000)),
      rolledAt: new Date(rolledAt).toISOString(),
    };
    return deepFreeze({ ...body, digest: rolloutReceiptDigest(body) });
  });
}

async function runPreflight(context, args, target) {
  if (!args.execute) return dryRunResult(args, target, preflightArgv(args, target));
  const result = await preflight(context, args, target);
  return deepFreeze({
    status: "ok",
    verb: "preflight",
    environment: args.environment,
    commit: args.commit,
    infraReadbackSha256: result.readbackSha256,
    backupAudit: result.backupAudit,
    scheduledJobs: result.scheduledJobs,
  });
}

/**
 * Run one verb. `dependencies`: run (sync argv runner), loadTarget,
 * lockFactory, now, uuid, tmpdir, fetch, readTrackedConfig,
 * verifyBackupAudit, createBackup, readPrimaryMigrations; capture-edge reads
 * only now, readTrackedConfig, readInventory, liveProviderFactory and
 * repositoryRoot. Every default touches only this checkout until --execute.
 */
export async function runRollout(argv, dependencies = {}) {
  if (Array.isArray(argv) && argv[0] === ROLLOUT_EDGE_CAPTURE_VERB) return captureEdge(argv, dependencies);
  const args = parseRolloutArguments(argv);
  const context = {
    run: dependencies.run ?? spawnRunner,
    lockFactory: dependencies.lockFactory ?? createEnvironmentDeploymentLock,
    now: dependencies.now ?? Date.now,
    uuid: dependencies.uuid ?? randomUUID,
    tmpdir: dependencies.tmpdir ?? tmpdir,
    fetch: dependencies.fetch ?? ((...request) => globalThis.fetch(...request)),
    readTrackedConfig: dependencies.readTrackedConfig ?? defaultReadTrackedConfig,
    verifyBackupAudit: dependencies.verifyBackupAudit,
    createBackup: dependencies.createBackup,
    readPrimaryMigrations: dependencies.readPrimaryMigrations,
    commands: dependencies.commands ?? [],
    lockEvents: dependencies.lockEvents ?? [],
  };
  if (!args.execute) {
    // A dry run may read local git only; it never runs gcloud or node and makes no request.
    const run = context.run;
    context.run = (command) => {
      if (command[0] !== "git") fail("ROLLOUT_DRY_RUN_COMMAND_REFUSED");
      return run(command);
    };
    context.fetch = () => fail("ROLLOUT_DRY_RUN_COMMAND_REFUSED");
  }
  let target;
  try {
    target = await (dependencies.loadTarget ?? loadRolloutTargetFromInfraManifest)(args.environment);
  } catch (error) {
    if (error instanceof RolloutError) throw error;
    fail("ROLLOUT_INFRA_MANIFEST_UNAVAILABLE");
  }
  const validated = validateRolloutTarget(target, args.environment);
  if (args.verb === "preflight") return runPreflight(context, args, validated);
  if (args.verb === "build") return build(context, args, validated);
  if (args.verb === "migrate") return migrate(context, args, validated);
  return roll(context, args, validated);
}

// No top-level await: the default target loader imports the OPS-2 manifest,
// whose import graph (gcp-fastpath-test-deploy.mjs) imports this module back.
// Awaiting here would leave this module evaluating while that import waits for
// it, and Node would exit 13 ("unsettled top-level await") before any verb ran.
/**
 * The command line: the result as JSON on stdout, or a closed error code on
 * stderr, and the exit status. Nothing else is printed.
 */
export async function runRolloutCli(argv, dependencies = {}, io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}) {
  try {
    const result = await runRollout(argv, dependencies);
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${JSON.stringify({ status: "error", code: safeRolloutErrorCode(error) })}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_FILE) {
  runRolloutCli(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  });
}
