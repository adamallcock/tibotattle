#!/usr/bin/env node

/**
 * OPS-10 production rollout for the GCP origin: preflight, build, migrate and
 * roll, each a separate verb with its own authorization.
 *
 *   preflight  read-only: a clean checkout at --commit, the infrastructure
 *              readback (`node scripts/gcp-infra.mjs readback --require-clean`)
 *              and an OPS-1 backup-horizon audit that is not in breach.
 *   build      --authorize=build:<env>:<commit>. Renders
 *              cloud-run/cloudbuild.production.yaml, stages the audited build
 *              context and submits it; prints the pushed image digest.
 *   migrate    --authorize=migrate:<env>:<digest>. Preflight, two labelled
 *              pre-migration on-demand backups of the primary instance, then
 *              the production migration Job moved to the digest and commit and
 *              executed, and its 'tibotattle-gcp-migration-v1' receipt read
 *              back from the execution's log and verified. Writes the migrate
 *              receipt that roll requires.
 *   roll       --authorize=roll:<env>:<digest>. Requires the matching migrate
 *              receipt. When the live edge runs in gcp mode (EP-9), refuses
 *              EDGE_CONTRACT_DRIFT unless src/edge-origin-contract.ts has the
 *              same blob at --commit and at the live edge's commit. Then the
 *              service and every Job of the infrastructure manifest move to
 *              one digest and commit, and both are read back.
 *
 * Every mutating verb runs under scripts/production-deployment-lock.mjs's
 * lock (shared with the Cloudflare production deploys), released on success
 * and on failure. Commands run through an injected runner as argv, never a
 * shell; no verb deletes anything. Without --execute a verb only validates
 * its inputs and prints the argv it would run: it runs no gcloud and no node,
 * only local read-only git where an input check needs it.
 *
 * The environment's resources come from the infrastructure manifest
 * (scripts/gcp-ops-infra-manifest.mjs, OPS-2): its rolloutTarget(environment)
 * returns the closed RolloutTarget below, whose jobNames are the manifest's
 * JOB_NAMES for that environment. Until that module exists every verb refuses
 * ROLLOUT_INFRA_MANIFEST_UNAVAILABLE.
 *
 * Output and errors are content-free: names, digests, commits and closed codes.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { liveEdgeMode, verifyEdgeModeLiveSnapshot } from "./edge-mode-configuration.mjs";
import { createOnDemandBackup } from "./gcp-backup-horizon.mjs";
import { GCP_PRIVATE_TEST_TARGET } from "./gcp-private-test-deploy.mjs";
import { EDGE_ORIGIN_CONTRACT_PATH } from "./production-edge-mode.mjs";
import { createProductionDeploymentLock } from "./production-deployment-lock.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const WORKER_ROOT = resolve(dirname(SCRIPT_FILE), "..");
export const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");

export const ROLLOUT_VERBS = Object.freeze(["preflight", "build", "migrate", "roll"]);
export const ROLLOUT_ENVIRONMENTS = Object.freeze(["production", "staging"]);
export const ROLLOUT_MIGRATE_RECEIPT_SCHEMA = "tibotattle-gcp-rollout-migrate-v1";
export const ROLLOUT_BUILD_RECEIPT_SCHEMA = "tibotattle-gcp-rollout-build-v1";
export const ROLLOUT_ROLL_RECEIPT_SCHEMA = "tibotattle-gcp-rollout-roll-v1";
export const ROLLOUT_EDGE_LIVE_SCHEMA = "tibotattle-edge-live-capture-v1";
/** Two labelled pre-migration on-demand backups of the primary instance (OPS-10). */
export const PRE_MIGRATION_BACKUPS = 2;
export const PRE_MIGRATION_BACKUP_EXPIRES_IN_DAYS = 30;
export const BACKUP_AUDIT_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
export const MIGRATE_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const BUILD_CONFIG_PATH = "cloud-run/cloudbuild.production.yaml";
export const INFRA_READBACK_ARGV = Object.freeze(["node", "scripts/gcp-infra.mjs", "readback", "--require-clean"]);
export const ROLLOUT_TARGET_KEYS = Object.freeze([
  "environment", "project", "region", "service", "migrationJob", "jobNames", "primaryInstance",
  "imageRepository", "builderServiceAccount",
]);

const FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const MAX_INPUT_BYTES = 1024 * 1024;
const COMMIT = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const REGION = /^[a-z]+-[a-z]+[0-9]{1,2}$/u;
const CLOUD_RUN_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const INSTANCE_ID = /^[a-z](?:[a-z0-9-]{0,96}[a-z0-9])?$/u;
const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u;
const REPOSITORY = /^([a-z]+-[a-z]+[0-9]{1,2})-docker\.pkg\.dev\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,127}$/u;
const EXECUTION = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const BACKUP_ID = /^[1-9][0-9]{0,18}$/u;
const SAFE_CODE = /^(?:ROLLOUT_[A-Z0-9_]+|EDGE_CONTRACT_DRIFT|PRODUCTION_SIMP_RESIDUE_MISSING|PRODUCTION_MIGRATION_CONTRACT_[A-Z_]+|POSTGRES_PRODUCTION_MIGRATIONS_RECEIPT_INVALID|BACKUP_[A-Z0-9_]+|PRODUCTION_COORDINATION_[A-Z_]+)$/u;

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

/**
 * Parse `<verb> --flag=value... [--execute]`. Mutating verbs need
 * --authorize=<verb>:<environment>:<commit or digest> to execute; a supplied
 * authorization must match in a dry run too.
 */
export function parseRolloutArguments(argv) {
  if (!Array.isArray(argv) || !ROLLOUT_VERBS.includes(argv[0])) fail("ROLLOUT_VERB_INVALID");
  const verb = argv[0];
  const { required, optional } = FLAGS[verb];
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
 * test-deployment or rehearsal resource.
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
      || !SERVICE_ACCOUNT.test(target.builderServiceAccount ?? "")) {
    fail("ROLLOUT_TARGET_INVALID");
  }
  const repository = REPOSITORY.exec(target.imageRepository ?? "");
  if (repository === null || repository[1] !== target.region || repository[2] !== target.project) {
    fail("ROLLOUT_TARGET_INVALID");
  }
  const named = [target.service, ...target.jobNames, target.primaryInstance, target.imageRepository,
    target.builderServiceAccount.split("@")[0]];
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

/** The default target source: the OPS-2 infrastructure manifest. */
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
  buildContext: (output) => ["node", "scripts/cloud-run-build-context.mjs", `--output=${output}`],
  buildSubmit: (target, context, config) => ["gcloud", "builds", "submit", context, `--config=${config}`,
    ...scope(target), "--format=json"],
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
  assertExpandCompatible(migrations);
  if (simpResidueMigration(migrations) === null) fail("PRODUCTION_SIMP_RESIDUE_MISSING");
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

function liveServiceCommit(context, target) {
  const stdout = runChecked(context, ROLLOUT_ARGV.serviceDescribe(target), "ROLLOUT_SERVICE_DESCRIBE_FAILED");
  const commit = sourceCommitOf(container(parseJson(stdout, "ROLLOUT_SERVICE_DESCRIBE_FAILED"), "service"));
  return commit !== null && COMMIT.test(commit) ? commit : null;
}

// ---------------------------------------------------------------------------
// Lock

async function underLock(context, record, operation) {
  const lock = context.lockFactory({ repositoryRoot: REPOSITORY_ROOT });
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

/**
 * EP-9: read the live edge mode from the captured typed snapshot. In gcp mode
 * the live snapshot must verify as gcp, and the edge/origin contract blob at
 * --commit must equal the one at the live edge's commit.
 */
async function checkEdgeContract(context, args) {
  const capture = await readBoundedJson(args.edgeLive, "ROLLOUT_EDGE_LIVE_INVALID", 4 * MAX_INPUT_BYTES);
  if (!hasExactKeys(capture, ["schema", "snapshot", "deployment"]) || capture.schema !== ROLLOUT_EDGE_LIVE_SCHEMA) {
    fail("ROLLOUT_EDGE_LIVE_INVALID");
  }
  let mode;
  try {
    mode = liveEdgeMode(capture.snapshot);
  } catch {
    fail("ROLLOUT_EDGE_LIVE_INVALID");
  }
  const edgeCommit = bindingText(capture.snapshot, "DEPLOYMENT_SOURCE_COMMIT");
  if (mode !== "gcp") {
    return Object.freeze({ mode: mode ?? "unset", edgeCommit, contractBlob: null });
  }
  if (edgeCommit === null || !COMMIT.test(edgeCommit)) fail("ROLLOUT_EDGE_LIVE_INVALID");
  const verified = verifyEdgeModeLiveSnapshot({
    snapshot: capture.snapshot, mode: "gcp", deployment: capture.deployment, sourceCommit: edgeCommit,
  });
  if (verified.ok !== true) fail("ROLLOUT_EDGE_LIVE_UNVERIFIED");
  const candidate = gitBlob(context, args.commit, EDGE_ORIGIN_CONTRACT_PATH);
  const live = gitBlob(context, edgeCommit, EDGE_ORIGIN_CONTRACT_PATH);
  if (candidate === null || live === null || candidate !== live) fail("EDGE_CONTRACT_DRIFT");
  return Object.freeze({ mode, edgeCommit, contractBlob: candidate });
}

// ---------------------------------------------------------------------------
// Verbs

function dryRunResult(args, target, steps) {
  return deepFreeze({
    status: "dry-run",
    verb: args.verb,
    environment: args.environment,
    commit: args.commit,
    ...(args.digest === null ? {} : { digest: args.digest }),
    service: target.service,
    steps: steps.map((argv) => ({ argv })),
  });
}

async function preflight(context, args, target) {
  checkCheckout(context, args.commit);
  const readback = checkInfraReadback(context, args.environment);
  const audit = await checkBackupAudit(context, args, target);
  return Object.freeze({ readbackSha256: readback, backupAudit: audit });
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

/** Production build provenance, mirroring the test build's assessment for the rendered production config. */
export function assessProductionBuild(build, { target, commit, builderImage }) {
  const tag = `${target.imageRepository}:source-${commit}`;
  const images = Array.isArray(build?.results?.images) ? build.results.images : [];
  const digest = images.length === 1 && images[0]?.name === tag && DIGEST.test(images[0]?.digest ?? "")
    ? images[0].digest : null;
  const steps = Array.isArray(build?.steps) ? build.steps : [];
  if (!isRecord(build) || build.status !== "SUCCESS"
      || build.serviceAccount !== `projects/${target.project}/serviceAccounts/${target.builderServiceAccount}`
      || canonicalJson(build.options?.sourceProvenanceHash) !== canonicalJson(["SHA256"])
      || build.options?.requestedVerifyOption !== "VERIFIED"
      || steps.length !== 1 || steps[0]?.name !== builderImage || steps[0]?.status !== "SUCCESS"
      || canonicalJson(build.images) !== canonicalJson([tag])
      || digest === null || typeof build.id !== "string" || build.id.length === 0) {
    fail("ROLLOUT_BUILD_PROVENANCE_UNQUALIFIED");
  }
  return Object.freeze({ digest, buildId: build.id });
}

async function build(context, args, target) {
  const configText = await readFile(join(WORKER_ROOT, BUILD_CONFIG_PATH), "utf8");
  const rendered = renderBuildConfig(configText, target, args.commit);
  const builderImage = builderImageOf(configText);
  if (!args.execute) {
    return dryRunResult(args, target, [
      ROLLOUT_ARGV.gitStatus(),
      ROLLOUT_ARGV.gitHead(),
      ROLLOUT_ARGV.buildContext("<build-dir>/context"),
      ROLLOUT_ARGV.buildSubmit(target, "<build-dir>/context", "<build-dir>/cloudbuild.production.rendered.yaml"),
    ]);
  }
  checkCheckout(context, args.commit);
  return underLock(context, { sourceCommit: args.commit, previousSourceCommit: args.commit }, async (assertOwned) => {
    const directory = await mkdtemp(join(context.tmpdir(), "tibotattle-production-build-"));
    try {
      const configPath = join(directory, "cloudbuild.production.rendered.yaml");
      await writeFile(configPath, rendered, { encoding: "utf8", flag: "wx", mode: 0o600 });
      runChecked(context, ROLLOUT_ARGV.buildContext(join(directory, "context")), "ROLLOUT_BUILD_CONTEXT_FAILED");
      assertOwned();
      const stdout = runChecked(context, ROLLOUT_ARGV.buildSubmit(target, join(directory, "context"), configPath),
        "ROLLOUT_BUILD_FAILED");
      const { digest, buildId } = assessProductionBuild(parseJson(stdout, "ROLLOUT_BUILD_FAILED"),
        { target, commit: args.commit, builderImage });
      return deepFreeze({
        schema: ROLLOUT_BUILD_RECEIPT_SCHEMA,
        environment: args.environment,
        commit: args.commit,
        digest,
        image: imageReference(target, digest),
        buildId,
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
      ROLLOUT_ARGV.gitStatus(),
      ROLLOUT_ARGV.gitHead(),
      ROLLOUT_ARGV.infraReadback(args.environment),
      ...Array.from({ length: PRE_MIGRATION_BACKUPS }, () => ROLLOUT_ARGV.backupCreate(target, description)),
      ROLLOUT_ARGV.jobUpdate(target, target.migrationJob, image, args.commit),
      ROLLOUT_ARGV.jobExecute(target, target.migrationJob),
      ROLLOUT_ARGV.migrationLog(target, target.migrationJob, "<execution>"),
    ]);
  }
  checkCheckout(context, args.commit);
  const previous = liveServiceCommit(context, target) ?? args.commit;
  return underLock(context, { sourceCommit: args.commit, previousSourceCommit: previous }, async (assertOwned) => {
    await preflight(context, args, target);
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
      ROLLOUT_ARGV.gitStatus(),
      ROLLOUT_ARGV.gitHead(),
      ROLLOUT_ARGV.infraReadback(args.environment),
      ROLLOUT_ARGV.serviceUpdate(target, image, args.commit),
      ...target.jobNames.map((job) => ROLLOUT_ARGV.jobUpdate(target, job, image, args.commit)),
      ROLLOUT_ARGV.serviceDescribe(target),
      ...target.jobNames.map((job) => ROLLOUT_ARGV.jobDescribe(target, job)),
      ROLLOUT_ARGV.infraReadback(args.environment),
    ]);
  }
  checkCheckout(context, args.commit);
  const previous = liveServiceCommit(context, target) ?? args.commit;
  return underLock(context, { sourceCommit: args.commit, previousSourceCommit: previous }, async (assertOwned) => {
    await preflight(context, args, target);
    assertOwned();
    runChecked(context, ROLLOUT_ARGV.serviceUpdate(target, image, args.commit), "ROLLOUT_SERVICE_UPDATE_FAILED");
    for (const job of target.jobNames) {
      runChecked(context, ROLLOUT_ARGV.jobUpdate(target, job, image, args.commit), "ROLLOUT_JOB_UPDATE_FAILED");
    }
    verifyDeployed(parseJson(runChecked(context, ROLLOUT_ARGV.serviceDescribe(target), "ROLLOUT_READBACK_FAILED"),
      "ROLLOUT_READBACK_FAILED"), "service", image, args.commit);
    for (const job of target.jobNames) {
      verifyDeployed(parseJson(runChecked(context, ROLLOUT_ARGV.jobDescribe(target, job), "ROLLOUT_READBACK_FAILED"),
        "ROLLOUT_READBACK_FAILED"), "job", image, args.commit);
    }
    const readback = checkInfraReadback(context, args.environment);
    const rolledAt = context.now();
    const body = {
      schema: ROLLOUT_ROLL_RECEIPT_SCHEMA,
      environment: args.environment,
      commit: args.commit,
      digest: args.digest,
      image,
      service: target.service,
      jobs: [...target.jobNames],
      previousSourceCommit: previous,
      migrateReceiptDigest: migrateReceipt.digestSha256,
      edge: { mode: edge.mode, edgeCommit: edge.edgeCommit, contractBlob: edge.contractBlob },
      infraReadbackSha256: readback,
      // The window in which the previous revision served the migrated schema.
      secondsSinceMigrate: Math.max(0, Math.round((rolledAt - Date.parse(migrateReceipt.completedAt)) / 1_000)),
      rolledAt: new Date(rolledAt).toISOString(),
    };
    return deepFreeze({ ...body, digest: rolloutReceiptDigest(body) });
  });
}

async function runPreflight(context, args, target) {
  if (!args.execute) {
    return dryRunResult(args, target, [
      ROLLOUT_ARGV.gitStatus(),
      ROLLOUT_ARGV.gitHead(),
      ROLLOUT_ARGV.infraReadback(args.environment),
    ]);
  }
  const result = await preflight(context, args, target);
  return deepFreeze({
    status: "ok",
    verb: "preflight",
    environment: args.environment,
    commit: args.commit,
    infraReadbackSha256: result.readbackSha256,
    backupAudit: result.backupAudit,
  });
}

/**
 * Run one verb. `dependencies`: run (sync argv runner), loadTarget,
 * lockFactory, now, uuid, tmpdir, verifyBackupAudit, createBackup,
 * readPrimaryMigrations. Every default touches only this checkout until
 * --execute.
 */
export async function runRollout(argv, dependencies = {}) {
  const args = parseRolloutArguments(argv);
  const context = {
    run: dependencies.run ?? spawnRunner,
    lockFactory: dependencies.lockFactory ?? createProductionDeploymentLock,
    now: dependencies.now ?? Date.now,
    uuid: dependencies.uuid ?? randomUUID,
    tmpdir: dependencies.tmpdir ?? tmpdir,
    verifyBackupAudit: dependencies.verifyBackupAudit,
    createBackup: dependencies.createBackup,
    readPrimaryMigrations: dependencies.readPrimaryMigrations,
    commands: dependencies.commands ?? [],
    lockEvents: dependencies.lockEvents ?? [],
  };
  if (!args.execute) {
    // A dry run may read local git only; it never runs gcloud or node.
    const run = context.run;
    context.run = (command) => {
      if (command[0] !== "git") fail("ROLLOUT_DRY_RUN_COMMAND_REFUSED");
      return run(command);
    };
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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_FILE) {
  try {
    console.log(JSON.stringify(await runRollout(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: "error", code: safeRolloutErrorCode(error) }));
    process.exitCode = 1;
  }
}
