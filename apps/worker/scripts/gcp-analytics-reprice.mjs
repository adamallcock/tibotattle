#!/usr/bin/env node

/**
 * OPS-REPRICE: the typed operator verb that runs the saved-cohort reprice
 * Job (cloud-run/analytics-reprice.mjs, bundled as dist/analytics-reprice.mjs)
 * in staging or production and reads its closed receipt back.
 *
 *   --mode=plan     --authorize=reprice-plan:<env>:<commit>
 *                   Executes the Job once with --mode=plan and the bounds,
 *                   waits, reads the 'analytics-reprice-receipt-v1' receipt
 *                   from that execution's log, validates it with the CLI's
 *                   own validator and writes a digest-bound plan receipt.
 *   --mode=execute  --authorize=reprice-execute:<env>:<planSha256>
 *                   Requires that plan receipt (same environment, Job, image,
 *                   commit, kernel and bounds, uncapped, non-empty, under 24 h
 *                   old) and the reviewed --expected-plan-sha256 and a fresh
 *                   operator-chosen --run-id, then executes the Job once with
 *                   --mode=execute, waits and validates the execution
 *                   receipt the same way.
 *
 * Both modes take --environment, --commit (the deployed source commit the
 * Job must report), --expected-kernel (a kernel id registered in this
 * checkout's kernel-registry.json; the receipt must name it), the three
 * bounds and the inclusive day range, and --receipt-out (a new absolute
 * path; the receipt is written owner-only). Without --execute nothing runs:
 * the verb validates its inputs offline (the committed desired state, the
 * kernel registry, the plan receipt and the CLI's own argument parser) and
 * prints the exact gcloud argv it would run. A supplied --authorize must match
 * in a dry run too; --execute requires it.
 *
 * With --execute, under the environment's deployment coordination lock
 * (scripts/production-deployment-lock.mjs, as OPS-10's mutating verbs):
 *   1. describe the reprice Job: one container whose image is the plane's
 *      repository at a sha256 digest, whose DEPLOYMENT_SOURCE_COMMIT is
 *      --commit and whose own args name only the entry;
 *   2. refuse while any execution of the reprice, refresh (shared advisory
 *      lock) or migration Job has no terminal evidence;
 *   3. `gcloud run jobs execute --async --args=...` with the entry and the
 *      CLI's explicit arguments, then poll the execution to completion;
 *   4. read exactly one receipt line for that execution from Cloud Logging
 *      (bounded retries for ingestion delay) and validate it.
 *
 * Infrastructure apply and Job execution are owner-only protected steps
 * (docs/runbooks/2026-10-09-historical-spend-repricing.md). The verb never
 * retries an execution, never mints a run id and never deletes anything.
 * Commands are argv arrays through an injected runner, never a shell. Output
 * and errors are content-free: names, digests, commits, counts and closed codes.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANALYTICS_REPRICE_LIMITS,
  ANALYTICS_REPRICE_RECEIPT_VERSION,
  parseAnalyticsRepriceArguments,
  validateAnalyticsRepriceResult,
} from "../cloud-run/analytics-reprice.mjs";
import { executionIsTerminal, spawnRunner } from "./gcp-production-rollout.mjs";
import { createEnvironmentDeploymentLock, deploymentLockRef } from "./production-deployment-lock.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const WORKER_ROOT = resolve(dirname(SCRIPT_FILE), "..");
export const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");

export const REPRICE_MODES = Object.freeze(["plan", "execute"]);
export const REPRICE_ENVIRONMENTS = Object.freeze(["production", "staging"]);
export const REPRICE_RECEIPT_SCHEMA = "tibotattle-gcp-analytics-reprice-v1";
export const REPRICE_RECEIPT_KEYS = Object.freeze([
  "schema", "mode", "outcome", "environment", "project", "region", "job", "execution", "commit", "imageDigest",
  "kernel", "bounds", "planSha256", "runId", "result", "failure", "completedAt", "digestSha256",
]);
export const REPRICE_TARGET_KEYS = Object.freeze([
  "environment", "project", "region", "job", "refreshJob", "migrationJob", "imageRepository", "entry",
]);
export const REPRICE_ENTRY = "dist/analytics-reprice.mjs";
export const KERNEL_REGISTRY_PATH = "src/analytics-v2/kernel-registry.json";
export const PLAN_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/** Poll the execution every 15 s for at most the Job's 3,600 s task timeout plus five minutes. */
export const EXECUTION_POLL_INTERVAL_MS = 15_000;
export const EXECUTION_POLL_LIMIT = 260;
/** Cloud Logging ingestion is not instantaneous: read again, boundedly, while no receipt line is present. */
export const RECEIPT_READ_INTERVAL_MS = 10_000;
export const RECEIPT_READ_ATTEMPTS = 6;

const FLAGS = Object.freeze({
  plan: Object.freeze({
    required: ["--environment", "--mode", "--commit", "--expected-kernel", "--from-day", "--through-day",
      "--max-days", "--max-members", "--max-input-bytes", "--receipt-out"],
    optional: ["--authorize"],
  }),
  execute: Object.freeze({
    required: ["--environment", "--mode", "--commit", "--expected-kernel", "--from-day", "--through-day",
      "--max-days", "--max-members", "--max-input-bytes", "--receipt-out", "--plan-receipt",
      "--expected-plan-sha256", "--run-id"],
    optional: ["--authorize"],
  }),
});
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KERNEL_ID = /^[1-9][0-9]{0,5}$/u;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const REGION = /^[a-z]+-[a-z]+[0-9]{1,2}$/u;
const CLOUD_RUN_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const EXECUTION = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const REPOSITORY = /^([a-z]+-[a-z]+[0-9]{1,2})-docker\.pkg\.dev\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/[a-z][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9._-]{0,127}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const JOB_CODE = /^(?:ANALYTICS_V2_[A-Z0-9_]+|CLOUD_SQL_[A-Z0-9_]+|POSTGRES_[A-Z0-9_]+)$/u;
const JOB_PHASES = Object.freeze(["configuration", "modules", "connection", "plan", "execute", "receipt", "cleanup"]);
const SAFE_CODE = /^(?:REPRICE_[A-Z0-9_]+|PRODUCTION_COORDINATION_[A-Z_]+|STAGING_COORDINATION_[A-Z_]+|DEPLOYMENT_COORDINATION_[A-Z_]+)$/u;
const MAX_RECEIPT_BYTES = 1024 * 1024;

export class RepriceError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "RepriceError";
    this.code = code;
    if (details.jobCode !== undefined) this.jobCode = details.jobCode;
    if (details.jobPhase !== undefined) this.jobPhase = details.jobPhase;
  }
}

function fail(code, details) {
  throw new RepriceError(code, details);
}

/** The printed error: a closed code, and for a refused Job its own closed code and phase. */
export function safeRepriceError(error) {
  const code = typeof error?.code === "string" && SAFE_CODE.test(error.code) ? error.code : "REPRICE_FAILED";
  return {
    status: "error",
    code,
    ...(typeof error?.jobCode === "string" && JOB_CODE.test(error.jobCode) ? { jobCode: error.jobCode } : {}),
    ...(JOB_PHASES.includes(error?.jobPhase) ? { jobPhase: error.jobPhase } : {}),
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function parseJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    return fail(code);
  }
}

// ---------------------------------------------------------------------------
// Arguments

function readFlags(argv) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== "string")) fail("REPRICE_ARGUMENT_INVALID");
  const values = new Map();
  let execute = false;
  for (const argument of argv) {
    if (argument === "--execute") {
      if (execute) fail("REPRICE_ARGUMENT_INVALID");
      execute = true;
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator > 2 && argument.startsWith("--") ? argument.slice(0, separator) : null;
    const value = name === null ? "" : argument.slice(separator + 1);
    if (name === null || value.length === 0 || values.has(name) || /[\0\r\n]/u.test(value)) {
      fail("REPRICE_ARGUMENT_INVALID");
    }
    values.set(name, value);
  }
  const mode = values.get("--mode");
  if (!REPRICE_MODES.includes(mode)) fail("REPRICE_MODE_INVALID");
  const { required, optional } = FLAGS[mode];
  for (const name of values.keys()) {
    if (!required.includes(name) && !optional.includes(name)) fail("REPRICE_ARGUMENT_INVALID");
  }
  if (!required.every((name) => values.has(name))) fail("REPRICE_ARGUMENT_MISSING");
  return { values, execute, mode };
}

/**
 * The arguments the reprice CLI receives, in its own grammar: the entry
 * first, then --mode, the day range and every bound, and for execute the run
 * id and plan hash. The CLI's own parser accepts them here, offline, under a
 * production-shaped target (which refuses --schema and --now), before any
 * remote call. gcloud's --args list is comma-separated, so none may hold one.
 */
export function repriceJobArguments({ mode, bounds, runId = null, expectedPlanSha256 = null }) {
  const cli = [
    `--mode=${mode}`, `--from-day=${bounds.fromDay}`, `--through-day=${bounds.throughDay}`,
    `--max-days=${bounds.maxDays}`, `--max-members=${bounds.maxMembers}`, `--max-input-bytes=${bounds.maxInputBytes}`,
    ...(mode === "execute" ? [`--run-id=${runId}`, `--expected-plan-sha256=${expectedPlanSha256}`] : []),
  ];
  try {
    parseAnalyticsRepriceArguments(cli, { ANALYTICS_REFRESH_TARGET: "production", PRIMARY_SCHEMA: "primary" });
  } catch {
    fail("REPRICE_JOB_ARGUMENTS_INVALID");
  }
  const args = [REPRICE_ENTRY, ...cli];
  if (args.some((argument) => argument.includes(",") || /\s/u.test(argument))) fail("REPRICE_JOB_ARGUMENTS_INVALID");
  return Object.freeze(args);
}

function positive(text, maximum, code) {
  if (typeof text !== "string" || !/^[1-9][0-9]*$/u.test(text) || !Number.isSafeInteger(Number(text))
      || Number(text) > maximum) {
    fail(code);
  }
  return Number(text);
}

function calendarDay(text) {
  return typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(text)
    && Number.isFinite(Date.parse(`${text}T00:00:00Z`))
    && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
}

/**
 * Parse the verb's arguments. --mode=execute needs every plan binding;
 * --execute needs --authorize=reprice-<mode>:<environment>:<commit or plan
 * hash>, and a supplied authorization must match in a dry run too.
 */
export function parseRepriceArguments(argv) {
  const { values, execute, mode } = readFlags(argv);
  const environment = values.get("--environment");
  if (!REPRICE_ENVIRONMENTS.includes(environment)) fail("REPRICE_ENVIRONMENT_INVALID");
  const commit = values.get("--commit");
  if (!COMMIT.test(commit)) fail("REPRICE_COMMIT_INVALID");
  if (!KERNEL_ID.test(values.get("--expected-kernel"))) fail("REPRICE_KERNEL_INVALID");
  const expectedKernel = Number(values.get("--expected-kernel"));
  const fromDay = values.get("--from-day");
  const throughDay = values.get("--through-day");
  if (!calendarDay(fromDay) || !calendarDay(throughDay) || fromDay > throughDay) fail("REPRICE_BOUNDS_INVALID");
  const bounds = Object.freeze({
    fromDay,
    throughDay,
    maxDays: positive(values.get("--max-days"), ANALYTICS_REPRICE_LIMITS.days, "REPRICE_BOUNDS_INVALID"),
    maxMembers: positive(values.get("--max-members"), ANALYTICS_REPRICE_LIMITS.members, "REPRICE_BOUNDS_INVALID"),
    maxInputBytes: positive(values.get("--max-input-bytes"), ANALYTICS_REPRICE_LIMITS.inputBytes, "REPRICE_BOUNDS_INVALID"),
  });
  for (const name of ["--receipt-out", "--plan-receipt"]) {
    if (values.has(name) && !isAbsolute(values.get(name))) fail("REPRICE_PATH_INVALID");
  }
  const expectedPlanSha256 = values.get("--expected-plan-sha256") ?? null;
  if (expectedPlanSha256 !== null && !SHA256.test(expectedPlanSha256)) fail("REPRICE_PLAN_DIGEST_INVALID");
  const runId = values.get("--run-id") ?? null;
  if (runId !== null && !UUID.test(runId)) fail("REPRICE_RUN_ID_INVALID");
  const authorize = values.get("--authorize") ?? null;
  const expected = `reprice-${mode}:${environment}:${mode === "plan" ? commit : expectedPlanSha256}`;
  if (authorize !== null && authorize !== expected) fail("REPRICE_AUTHORIZATION_MISMATCH");
  if (execute && authorize === null) fail("REPRICE_AUTHORIZATION_REQUIRED");
  const parsed = {
    mode, environment, commit, expectedKernel, bounds, execute,
    receiptOut: values.get("--receipt-out"),
    planReceipt: values.get("--plan-receipt") ?? null,
    expectedPlanSha256,
    runId,
  };
  // The CLI's own grammar, before anything else is read.
  repriceJobArguments(parsed);
  return deepFreeze(parsed);
}

// ---------------------------------------------------------------------------
// Target and kernel

/** Validate the manifest's closed reprice target (scripts/gcp-ops-infra-manifest.mjs analyticsRepriceTarget). */
export function validateRepriceTarget(target, environment) {
  if (!hasExactKeys(target, REPRICE_TARGET_KEYS) || target.environment !== environment
      || !PROJECT.test(target.project ?? "") || !REGION.test(target.region ?? "")
      || ![target.job, target.refreshJob, target.migrationJob].every((name) => typeof name === "string"
        && CLOUD_RUN_NAME.test(name))
      || new Set([target.job, target.refreshJob, target.migrationJob]).size !== 3
      || target.entry !== REPRICE_ENTRY) {
    fail("REPRICE_TARGET_INVALID");
  }
  const repository = REPOSITORY.exec(target.imageRepository ?? "");
  if (repository === null || repository[1] !== target.region || repository[2] !== target.project) {
    fail("REPRICE_TARGET_INVALID");
  }
  const staging = [target.job, target.refreshJob, target.migrationJob]
    .map((name) => name.split("-").includes("staging"));
  if (environment === "staging" ? staging.some((marker) => !marker) : staging.some(Boolean)) {
    fail("REPRICE_TARGET_PLANE_MISMATCH");
  }
  return deepFreeze(structuredClone(target));
}

/** The default target source: the OPS-2 manifest's committed desired state, and no other. */
export async function loadRepriceTargetFromInfraManifest(environment) {
  let manifest;
  try {
    manifest = await import("./gcp-ops-infra-manifest.mjs");
  } catch {
    fail("REPRICE_INFRA_MANIFEST_UNAVAILABLE");
  }
  if (typeof manifest?.analyticsRepriceTarget !== "function") fail("REPRICE_INFRA_MANIFEST_UNAVAILABLE");
  return manifest.analyticsRepriceTarget(environment);
}

/** The registered kernel entry for `kernelId` in this checkout's kernel registry. */
export function registeredKernel(registry, kernelId) {
  const kernels = isRecord(registry) && Array.isArray(registry.kernels) ? registry.kernels : null;
  if (kernels === null) fail("REPRICE_KERNEL_REGISTRY_INVALID");
  const matches = kernels.filter((entry) => entry?.kernelId === kernelId);
  if (matches.length !== 1) fail("REPRICE_KERNEL_UNREGISTERED");
  if (!SHA256.test(matches[0].priceRegistrySha256 ?? "")) fail("REPRICE_KERNEL_REGISTRY_INVALID");
  return Object.freeze({ kernelId, priceRegistrySha256: matches[0].priceRegistrySha256 });
}

async function defaultReadKernelRegistry() {
  try {
    return JSON.parse(await readFile(resolve(WORKER_ROOT, KERNEL_REGISTRY_PATH), "utf8"));
  } catch {
    return fail("REPRICE_KERNEL_REGISTRY_INVALID");
  }
}

// ---------------------------------------------------------------------------
// Receipts

/**
 * Validate the CLI's closed outer receipt for one execution and return it.
 * An ok receipt must be the requested mode on this environment's target, on
 * the wall clock, under the expected kernel, and its result must pass the
 * CLI's own validateAnalyticsRepriceResult with this verb's bounds, the
 * registered price registry of the expected kernel and, for execute, the
 * reviewed plan hash. A failed receipt yields only its closed code and phase.
 */
export function validateJobReceipt(receipt, { mode, environment, bounds, kernel, expectedPlanSha256 = null,
  manifestVersion = null }) {
  if (!isRecord(receipt) || receipt.schemaVersion !== ANALYTICS_REPRICE_RECEIPT_VERSION) fail("REPRICE_RECEIPT_INVALID");
  if (receipt.status === "failed") {
    const keys = Object.hasOwn(receipt, "phase") ? ["schemaVersion", "status", "code", "phase"]
      : ["schemaVersion", "status", "code"];
    if (!hasExactKeys(receipt, keys) || typeof receipt.code !== "string" || !JOB_CODE.test(receipt.code)
        || (Object.hasOwn(receipt, "phase") && !JOB_PHASES.includes(receipt.phase))) {
      fail("REPRICE_RECEIPT_INVALID");
    }
    return deepFreeze({ status: "failed", code: receipt.code, phase: receipt.phase ?? null });
  }
  if (!hasExactKeys(receipt, ["schemaVersion", "status", "mode", "target", "now", "clock", "kernel", "result"])
      || receipt.status !== "ok" || receipt.mode !== mode || receipt.target !== environment
      || receipt.clock !== "wall" || typeof receipt.now !== "string" || !ISO_INSTANT.test(receipt.now)
      || !Number.isFinite(Date.parse(receipt.now))
      || !hasExactKeys(receipt.kernel, ["kernelId", "manifestVersion"])
      || !Number.isSafeInteger(receipt.kernel.kernelId) || !Number.isSafeInteger(receipt.kernel.manifestVersion)
      || receipt.kernel.manifestVersion < 1) {
    fail("REPRICE_RECEIPT_INVALID");
  }
  if (receipt.kernel.kernelId !== kernel.kernelId) fail("REPRICE_KERNEL_UNEXPECTED");
  if (manifestVersion !== null && receipt.kernel.manifestVersion !== manifestVersion) fail("REPRICE_KERNEL_UNEXPECTED");
  const pricingMethodVersion = mode === "plan" ? receipt.result?.target?.pricingMethodVersion : null;
  if (mode === "plan" && (typeof pricingMethodVersion !== "string" || !TOKEN.test(pricingMethodVersion))) {
    fail("REPRICE_RECEIPT_INVALID");
  }
  let result;
  try {
    result = validateAnalyticsRepriceResult(receipt.result, {
      mode,
      bounds,
      stamp: { kernel: { kernelId: kernel.kernelId, priceRegistrySha256: kernel.priceRegistrySha256 },
        manifestVersion: receipt.kernel.manifestVersion },
      pricingMethodVersion,
      expectedPlanSha256,
    });
  } catch {
    fail("REPRICE_RECEIPT_INVALID");
  }
  if (mode === "plan" && result.target.kernelId !== kernel.kernelId) fail("REPRICE_KERNEL_UNEXPECTED");
  return deepFreeze({ status: "ok", now: receipt.now, kernel: { ...receipt.kernel }, result });
}

function receiptBody(receipt) {
  const { digestSha256: _ignored, ...body } = receipt;
  return body;
}

/** Seal a verb receipt: its digest is the sha256 of the canonical JSON of every other field. */
export function sealRepriceReceipt(body) {
  return deepFreeze({ ...body, digestSha256: sha256(canonicalJson(body)) });
}

/**
 * Verify a verb receipt: closed keys, schema, digest and internal
 * consistency; an ok receipt's result passes the CLI's validator again
 * against its own bounds, kernel and the registered price registry.
 */
export function verifyRepriceReceipt(receipt, { registry }) {
  const ok = hasExactKeys(receipt, REPRICE_RECEIPT_KEYS)
    && receipt.schema === REPRICE_RECEIPT_SCHEMA
    && REPRICE_MODES.includes(receipt.mode)
    && ["ok", "failed"].includes(receipt.outcome)
    && REPRICE_ENVIRONMENTS.includes(receipt.environment)
    && PROJECT.test(receipt.project ?? "") && REGION.test(receipt.region ?? "")
    && CLOUD_RUN_NAME.test(receipt.job ?? "") && EXECUTION.test(receipt.execution ?? "")
    && COMMIT.test(receipt.commit ?? "") && IMAGE_DIGEST.test(receipt.imageDigest ?? "")
    && isRecord(receipt.bounds)
    && (receipt.mode === "plan" ? receipt.runId === null : UUID.test(receipt.runId ?? ""))
    && typeof receipt.completedAt === "string" && ISO_INSTANT.test(receipt.completedAt)
    && receipt.digestSha256 === sha256(canonicalJson(receiptBody(receipt)));
  if (!ok) fail("REPRICE_RECEIPT_FILE_INVALID");
  if (receipt.outcome === "failed") {
    if (receipt.result !== null || receipt.kernel !== null
        || !hasExactKeys(receipt.failure, ["code", "phase"]) || !JOB_CODE.test(receipt.failure.code ?? "")
        || !(receipt.failure.phase === null || JOB_PHASES.includes(receipt.failure.phase))) {
      fail("REPRICE_RECEIPT_FILE_INVALID");
    }
    return deepFreeze(structuredClone(receipt));
  }
  if (receipt.failure !== null || !hasExactKeys(receipt.kernel, ["kernelId", "manifestVersion"])) {
    fail("REPRICE_RECEIPT_FILE_INVALID");
  }
  const kernel = registeredKernel(registry, receipt.kernel.kernelId);
  let result;
  try {
    result = validateAnalyticsRepriceResult(receipt.result, {
      mode: receipt.mode,
      bounds: receipt.bounds,
      stamp: { kernel, manifestVersion: receipt.kernel.manifestVersion },
      pricingMethodVersion: receipt.mode === "plan" ? receipt.result?.target?.pricingMethodVersion : null,
      expectedPlanSha256: receipt.planSha256,
    });
  } catch {
    fail("REPRICE_RECEIPT_FILE_INVALID");
  }
  if (result.planSha256 !== receipt.planSha256) fail("REPRICE_RECEIPT_FILE_INVALID");
  return deepFreeze(structuredClone(receipt));
}

async function readPlanReceipt(path, registry) {
  const stat = await lstat(path).catch(() => null);
  if (stat === null) fail("REPRICE_PLAN_RECEIPT_REQUIRED");
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_RECEIPT_BYTES) {
    fail("REPRICE_RECEIPT_FILE_INVALID");
  }
  return verifyRepriceReceipt(parseJson(await readFile(path, "utf8"), "REPRICE_RECEIPT_FILE_INVALID"), { registry });
}

/**
 * The plan an execution must match: an ok plan receipt for the same
 * environment, project, Job, commit, kernel and bounds, whose hash is the
 * reviewed --expected-plan-sha256, uncapped (the CLI refuses a capped plan),
 * non-empty and under PLAN_RECEIPT_MAX_AGE_MS old.
 */
export function assertMatchingPlan(plan, { args, target, nowMs }) {
  if (plan.mode !== "plan" || plan.outcome !== "ok") fail("REPRICE_PLAN_RECEIPT_MISMATCH");
  if (plan.environment !== args.environment || plan.project !== target.project || plan.region !== target.region
      || plan.job !== target.job || plan.commit !== args.commit) {
    fail("REPRICE_PLAN_RECEIPT_MISMATCH");
  }
  if (plan.kernel.kernelId !== args.expectedKernel) fail("REPRICE_KERNEL_UNEXPECTED");
  if (canonicalJson(plan.bounds) !== canonicalJson(args.bounds)) fail("REPRICE_PLAN_BOUNDS_MISMATCH");
  if (plan.planSha256 !== args.expectedPlanSha256) fail("REPRICE_PLAN_DIGEST_MISMATCH");
  if (Object.values(plan.result.caps).some(Boolean)) fail("REPRICE_PLAN_CAPPED");
  if (plan.result.counts.heads === 0) fail("REPRICE_PLAN_EMPTY");
  const age = nowMs - Date.parse(plan.completedAt);
  if (!Number.isFinite(age) || age < -5 * 60 * 1_000 || age > PLAN_RECEIPT_MAX_AGE_MS) fail("REPRICE_PLAN_RECEIPT_STALE");
  return plan;
}

async function writeNewReceipt(path, receipt) {
  if ((await lstat(path).catch(() => null)) !== null) fail("REPRICE_RECEIPT_EXISTS");
  try {
    await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    fail("REPRICE_RECEIPT_WRITE_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Commands (argv only)

const scope = (target) => [`--project=${target.project}`, `--region=${target.region}`];

export const REPRICE_ARGV = Object.freeze({
  jobDescribe: (target) => ["gcloud", "run", "jobs", "describe", target.job, ...scope(target), "--format=json"],
  executionsList: (target, job) => ["gcloud", "run", "jobs", "executions", "list", `--job=${job}`, ...scope(target),
    "--format=json"],
  /** One execution with the CLI's explicit arguments; the Job's own args name only the entry. */
  jobExecute: (target, args) => ["gcloud", "run", "jobs", "execute", target.job, `--args=${args.join(",")}`,
    "--async", ...scope(target), "--format=json"],
  executionDescribe: (target, execution) => ["gcloud", "run", "jobs", "executions", "describe", execution,
    ...scope(target), "--format=json"],
  receiptLog: (target, execution) => ["gcloud", "logging", "read",
    `resource.type="cloud_run_job" AND resource.labels.job_name="${target.job}"`
      + ` AND labels."run.googleapis.com/execution_name"="${execution}"`
      + ` AND jsonPayload.schemaVersion="${ANALYTICS_REPRICE_RECEIPT_VERSION}"`,
    `--project=${target.project}`, "--format=json", "--limit=10", "--freshness=1d"],
});

function runChecked(context, argv, code) {
  if (argv.some((part) => typeof part !== "string" || /[\0\r\n]/u.test(part))) fail("REPRICE_ARGV_INVALID");
  if (argv[0] === "gcloud" && argv.some((part) => /^(?:delete|remove-iam-policy-binding|update|replace|deploy)$/u
    .test(part))) {
    fail("REPRICE_COMMAND_REFUSED");
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

// ---------------------------------------------------------------------------
// Readback

function container(resource) {
  const containers = resource?.spec?.template?.spec?.template?.spec?.containers;
  return Array.isArray(containers) && containers.length === 1 && isRecord(containers[0]) ? containers[0] : null;
}

/** The live Job's image digest, after checking it is the reviewed render at --commit. */
export function liveJobImage(resource, target, commit) {
  const entry = container(resource);
  if (entry === null || resource?.metadata?.name !== target.job) fail("REPRICE_JOB_UNRECOGNIZED");
  const prefix = `${target.imageRepository}@`;
  const digest = typeof entry.image === "string" && entry.image.startsWith(prefix) ? entry.image.slice(prefix.length) : null;
  if (digest === null || !IMAGE_DIGEST.test(digest)) fail("REPRICE_JOB_IMAGE_UNRECOGNIZED");
  const commits = (Array.isArray(entry.env) ? entry.env : []).filter((variable) => variable?.name === "DEPLOYMENT_SOURCE_COMMIT");
  if (commits.length !== 1 || commits[0].value !== commit) fail("REPRICE_JOB_COMMIT_MISMATCH");
  if (!Array.isArray(entry.args) || entry.args.length !== 1 || entry.args[0] !== target.entry) {
    fail("REPRICE_JOB_UNRECOGNIZED");
  }
  return digest;
}

function assertNothingRunning(context, target) {
  for (const job of [target.job, target.refreshJob, target.migrationJob]) {
    const executions = parseJson(runChecked(context, REPRICE_ARGV.executionsList(target, job),
      "REPRICE_EXECUTIONS_READBACK_FAILED"), "REPRICE_EXECUTIONS_READBACK_FAILED");
    if (!Array.isArray(executions)) fail("REPRICE_EXECUTIONS_READBACK_FAILED");
    if (executions.some((execution) => !executionIsTerminal(execution))) fail("REPRICE_OVERLAP_REFUSED");
  }
}

function executionName(resource, target) {
  const name = resource?.metadata?.name;
  if (typeof name !== "string" || !EXECUTION.test(name) || !name.startsWith(`${target.job}-`)) {
    fail("REPRICE_EXECUTION_UNRECOGNIZED");
  }
  return name;
}

/** Poll one execution to terminal evidence; succeeded or failed, exactly one task. */
async function awaitExecution(context, target, name) {
  for (let attempt = 0; attempt < EXECUTION_POLL_LIMIT; attempt += 1) {
    const resource = parseJson(runChecked(context, REPRICE_ARGV.executionDescribe(target, name),
      "REPRICE_EXECUTION_READBACK_FAILED"), "REPRICE_EXECUTION_READBACK_FAILED");
    if (executionName(resource, target) !== name) fail("REPRICE_EXECUTION_UNRECOGNIZED");
    if (executionIsTerminal(resource)) {
      const succeeded = resource.status.succeededCount ?? 0;
      const failed = resource.status.failedCount ?? 0;
      if (succeeded === 1 && failed === 0) return "succeeded";
      if (succeeded === 0 && failed === 1) return "failed";
      fail("REPRICE_EXECUTION_OUTCOME_UNKNOWN");
    }
    await context.sleep(EXECUTION_POLL_INTERVAL_MS);
  }
  return fail("REPRICE_EXECUTION_TIMEOUT");
}

/** Exactly one receipt line for this execution, read again boundedly while none has been ingested. */
async function readJobReceipt(context, target, name) {
  for (let attempt = 0; attempt < RECEIPT_READ_ATTEMPTS; attempt += 1) {
    const entries = parseJson(runChecked(context, REPRICE_ARGV.receiptLog(target, name),
      "REPRICE_RECEIPT_UNAVAILABLE"), "REPRICE_RECEIPT_UNAVAILABLE");
    if (!Array.isArray(entries)) fail("REPRICE_RECEIPT_UNAVAILABLE");
    const receipts = entries.filter((entry) => entry?.jsonPayload?.schemaVersion === ANALYTICS_REPRICE_RECEIPT_VERSION
      && entry?.labels?.["run.googleapis.com/execution_name"] === name
      && entry?.resource?.labels?.job_name === target.job);
    if (receipts.length > 1) fail("REPRICE_RECEIPT_AMBIGUOUS");
    if (receipts.length === 1) return receipts[0].jsonPayload;
    await context.sleep(RECEIPT_READ_INTERVAL_MS);
  }
  return fail("REPRICE_RECEIPT_UNAVAILABLE");
}

// ---------------------------------------------------------------------------
// Lock

async function underLock(context, environment, commit, operation) {
  const ref = deploymentLockRef(environment);
  const lock = context.lockFactory({ environment, ref, repositoryRoot: REPOSITORY_ROOT });
  if (lock?.ref !== ref) fail("REPRICE_LOCK_REF_MISMATCH");
  // Reprice deploys nothing: the source commit stays the deployed one.
  const owner = await lock.createOwner({ id: context.uuid(), sourceCommit: commit, previousSourceCommit: commit });
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
// Verb

function summary(receipt) {
  return deepFreeze({
    status: receipt.outcome === "ok" ? "ok" : "job-refused",
    mode: receipt.mode,
    environment: receipt.environment,
    job: receipt.job,
    execution: receipt.execution,
    commit: receipt.commit,
    imageDigest: receipt.imageDigest,
    kernel: receipt.kernel,
    planSha256: receipt.planSha256,
    runId: receipt.runId,
    ...(receipt.result === null ? {} : receipt.mode === "plan"
      ? { counts: receipt.result.counts, caps: receipt.result.caps,
        executable: !Object.values(receipt.result.caps).some(Boolean) && receipt.result.counts.heads > 0 }
      : { counts: receipt.result.counts, refusals: receipt.result.refusals, replayed: receipt.result.replayed }),
    receiptDigestSha256: receipt.digestSha256,
  });
}

/**
 * Run the verb. `dependencies`: run (sync argv runner), loadTarget,
 * readKernelRegistry, lockFactory, now, uuid, sleep and commands. Every
 * default touches only this checkout until --execute.
 */
export async function runAnalyticsRepriceVerb(argv, dependencies = {}) {
  const args = parseRepriceArguments(argv);
  const context = {
    run: dependencies.run ?? spawnRunner,
    lockFactory: dependencies.lockFactory ?? createEnvironmentDeploymentLock,
    now: dependencies.now ?? Date.now,
    uuid: dependencies.uuid ?? randomUUID,
    sleep: dependencies.sleep ?? ((ms) => new Promise((done) => { setTimeout(done, ms); })),
    commands: dependencies.commands ?? [],
    lockEvents: dependencies.lockEvents ?? [],
  };
  if (!args.execute) {
    // A dry run makes no call at all: it prints the argv --execute would run.
    context.run = () => fail("REPRICE_DRY_RUN_COMMAND_REFUSED");
  }
  let target;
  try {
    target = await (dependencies.loadTarget ?? loadRepriceTargetFromInfraManifest)(args.environment);
  } catch (error) {
    if (error instanceof RepriceError) throw error;
    fail("REPRICE_INFRA_MANIFEST_UNAVAILABLE");
  }
  target = validateRepriceTarget(target, args.environment);
  const registry = await (dependencies.readKernelRegistry ?? defaultReadKernelRegistry)();
  const kernel = registeredKernel(registry, args.expectedKernel);
  const plan = args.mode === "execute" ? await readPlanReceipt(args.planReceipt, registry) : null;
  if (plan !== null) assertMatchingPlan(plan, { args, target, nowMs: context.now() });
  if ((await lstat(args.receiptOut).catch(() => null)) !== null) fail("REPRICE_RECEIPT_EXISTS");
  const jobArgs = repriceJobArguments(args);
  if (!args.execute) {
    return deepFreeze({
      status: "dry-run",
      mode: args.mode,
      environment: args.environment,
      job: target.job,
      commit: args.commit,
      kernel: { kernelId: kernel.kernelId },
      bounds: args.bounds,
      ...(plan === null ? {} : { planSha256: plan.planSha256, imageDigest: plan.imageDigest, runId: args.runId }),
      lockRef: deploymentLockRef(args.environment),
      steps: [
        REPRICE_ARGV.jobDescribe(target),
        ...[target.job, target.refreshJob, target.migrationJob].map((job) => REPRICE_ARGV.executionsList(target, job)),
        REPRICE_ARGV.jobExecute(target, jobArgs),
        REPRICE_ARGV.executionDescribe(target, "<execution>"),
        REPRICE_ARGV.receiptLog(target, "<execution>"),
      ].map((step) => ({ argv: step })),
    });
  }
  return underLock(context, args.environment, args.commit, async (assertOwned) => {
    const imageDigest = liveJobImage(parseJson(runChecked(context, REPRICE_ARGV.jobDescribe(target),
      "REPRICE_JOB_DESCRIBE_FAILED"), "REPRICE_JOB_DESCRIBE_FAILED"), target, args.commit);
    // The execution runs the image and kernel the plan ran: a roll in between makes the plan stale.
    if (plan !== null && plan.imageDigest !== imageDigest) fail("REPRICE_PLAN_IMAGE_MISMATCH");
    assertNothingRunning(context, target);
    assertOwned();
    const started = parseJson(runChecked(context, REPRICE_ARGV.jobExecute(target, jobArgs), "REPRICE_EXECUTION_FAILED"),
      "REPRICE_EXECUTION_FAILED");
    const execution = executionName(started, target);
    const outcome = await awaitExecution(context, target, execution);
    const receipt = validateJobReceipt(await readJobReceipt(context, target, execution), {
      mode: args.mode, environment: args.environment, bounds: args.bounds, kernel,
      expectedPlanSha256: args.expectedPlanSha256, manifestVersion: plan?.kernel.manifestVersion ?? null,
    });
    if ((outcome === "succeeded") !== (receipt.status === "ok")) fail("REPRICE_RECEIPT_INVALID");
    const sealed = sealRepriceReceipt({
      schema: REPRICE_RECEIPT_SCHEMA,
      mode: args.mode,
      outcome: receipt.status,
      environment: args.environment,
      project: target.project,
      region: target.region,
      job: target.job,
      execution,
      commit: args.commit,
      imageDigest,
      kernel: receipt.status === "ok" ? receipt.kernel : null,
      bounds: args.bounds,
      planSha256: receipt.status === "ok" ? receipt.result.planSha256 : args.expectedPlanSha256,
      runId: args.runId,
      result: receipt.status === "ok" ? receipt.result : null,
      failure: receipt.status === "ok" ? null : { code: receipt.code, phase: receipt.phase },
      completedAt: new Date(context.now()).toISOString(),
    });
    verifyRepriceReceipt(sealed, { registry });
    await writeNewReceipt(args.receiptOut, sealed);
    if (receipt.status !== "ok") fail("REPRICE_JOB_REFUSED", { jobCode: receipt.code, jobPhase: receipt.phase ?? undefined });
    return summary(sealed);
  });
}

/** The command line: the result as JSON on stdout, or a closed error on stderr, and the exit status. */
export async function runAnalyticsRepriceCli(argv, dependencies = {}, io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}) {
  try {
    const result = await runAnalyticsRepriceVerb(argv, dependencies);
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${JSON.stringify(safeRepriceError(error))}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_FILE) {
  runAnalyticsRepriceCli(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  });
}
