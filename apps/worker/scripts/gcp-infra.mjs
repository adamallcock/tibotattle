#!/usr/bin/env node

/**
 * Operator CLI for the production infrastructure (OPS-2).
 *
 *   Every command takes --desired-state=<abs path>, or --environment=<env>
 *   alone, which reads the path from that environment's variable
 *   (GCP_INFRA_DESIRED_STATE_PRODUCTION or GCP_INFRA_DESIRED_STATE_STAGING).
 *   With both, the file must describe that environment.
 *
 *   render       --desired-state=<abs path> [--bootstrap-image-digest=<hex>
 *                --bootstrap-source-commit=<hex>]
 *     The rendered estate; no gcloud call.
 *   readback     --desired-state=<abs path> [--require-clean]
 *     The live estate through describe, get-iam-policy and list calls only.
 *     With --require-clean (OPS-10's preflight), the readback, its plan's
 *     digest and summary, and a clean verdict; exit 0 only when clean.
 *   plan         --desired-state=<abs path> [--bootstrap-image-digest --bootstrap-source-commit]
 *     Readback plus the deterministic plan and its planDigest. This is the
 *     dry run; nothing changes.
 *   apply        --desired-state=<abs path> --authorize=<planDigest>
 *                [--bootstrap-image-digest --bootstrap-source-commit]
 *     Re-reads, re-plans, and runs only the create, update and bind
 *     operations of a plan whose digest equals --authorize. It never deletes,
 *     never changes a running image or source commit, never edits bucket
 *     metadata or bucket IAM, and refuses the synthetic fixture.
 *   bucket-birth --desired-state=<abs path> [--apply
 *                --authorize=bucket-birth:<project>:<bucket> --receipt-out=<abs path>]
 *     Dry run by default; with --apply, one bucket insert that refuses an
 *     existing bucket, and a proof receipt the owner pins in the desired state.
 *     The --receipt-out file is reserved before the insert; should writing
 *     it fail afterwards, the receipt is printed on stdout instead.
 *
 * Output is one content-free JSON document on stdout. Exit 0 on success, 2
 * when a plan or readback holds refused operations, blockers or findings that
 * apply would refuse (or, with --require-clean, when the estate is not
 * clean), and 1 on any error, reported as {"status":"error", "code":...} on
 * stderr without echoing gcloud output. A failure after a bucket insert adds
 * "bucketInserted": true. Every gcloud call is an
 * argv array through the guarded runner; no shell is used.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFERRED_JOBS,
  GCP_OPS_INFRA_ENVIRONMENTS,
  GcpOpsInfraError,
  JOB_NAMES,
  SCHEDULED_JOB_NAMES,
  bucketInsertBody,
  cloudSqlCreateArgs,
  databaseFlags,
  desiredProjectBindings,
  desiredStateDigest,
  desiredStatePathFor,
  readDesiredStateFile,
  renderEdgeIamPolicy,
  renderJob,
  renderService,
  requireEnvironment,
  schedulerFlags,
} from "./gcp-ops-infra-manifest.mjs";
import {
  applyInfrastructure,
  defaultGcloudRunner,
  infrastructureCleanliness,
  normalizeBootstrap,
  planInfrastructure,
  readbackInfrastructure,
} from "./gcp-ops-infra-operations.mjs";
import { runBucketBirth } from "./gcp-ops-bucket-birth.mjs";

export const GCP_OPS_INFRA_RENDER_SCHEMA = "tibotattle-gcp-ops-infra-render-v1";
export const GCP_OPS_INFRA_CLEAN_SCHEMA = "tibotattle-gcp-ops-infra-clean-v1";

const SOURCE = Object.freeze(["--desired-state", "--environment"]);
const COMMANDS = Object.freeze({
  render: Object.freeze([...SOURCE, "--bootstrap-image-digest", "--bootstrap-source-commit"]),
  readback: Object.freeze([...SOURCE, "--require-clean"]),
  plan: Object.freeze([...SOURCE, "--bootstrap-image-digest", "--bootstrap-source-commit"]),
  apply: Object.freeze([...SOURCE, "--authorize", "--bootstrap-image-digest", "--bootstrap-source-commit"]),
  "bucket-birth": Object.freeze([...SOURCE, "--authorize", "--receipt-out", "--apply"]),
});
const BOOLEAN_FLAGS = Object.freeze(["--apply", "--require-clean"]);

function fail(code) {
  throw new GcpOpsInfraError(code);
}

/** Closed argument parsing; returns the frozen command configuration. */
export function parseGcpInfraArgs(argv) {
  if (!Array.isArray(argv) || !Object.hasOwn(COMMANDS, argv[0])) fail("GCP_INFRA_COMMAND_INVALID");
  const command = argv[0];
  const allowed = COMMANDS[command];
  const values = new Map();
  for (const argument of argv.slice(1)) {
    if (typeof argument !== "string") fail("GCP_INFRA_ARGUMENT_INVALID");
    if (BOOLEAN_FLAGS.includes(argument)) {
      if (!allowed.includes(argument) || values.has(argument)) fail("GCP_INFRA_ARGUMENT_INVALID");
      values.set(argument, true);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    const value = separator < 0 ? "" : argument.slice(separator + 1);
    if (!argument.startsWith("--") || separator < 3 || !allowed.includes(name)
        || BOOLEAN_FLAGS.includes(name) || value.length === 0 || values.has(name)) {
      fail("GCP_INFRA_ARGUMENT_INVALID");
    }
    values.set(name, value);
  }
  const desiredStatePath = values.get("--desired-state");
  const environment = values.get("--environment") ?? null;
  if (desiredStatePath === undefined && environment === null) fail("GCP_INFRA_ARGUMENT_MISSING");
  if (desiredStatePath !== undefined && !isAbsolute(desiredStatePath)) fail("GCP_INFRA_DESIRED_STATE_PATH_INVALID");
  if (environment !== null && !GCP_OPS_INFRA_ENVIRONMENTS.includes(environment)) fail("GCP_INFRA_ENVIRONMENT_INVALID");
  const image = values.get("--bootstrap-image-digest");
  const commit = values.get("--bootstrap-source-commit");
  if ((image === undefined) !== (commit === undefined)) fail("BOOTSTRAP_IMAGE_INVALID");
  const bootstrap = image === undefined ? null : normalizeBootstrap({ imageDigest: image, sourceCommit: commit });
  const apply = values.get("--apply") === true;
  if (command === "apply" && !values.has("--authorize")) fail("APPLY_AUTHORIZATION_REQUIRED");
  if (command === "bucket-birth" && apply !== values.has("--authorize")) fail("BUCKET_BIRTH_AUTHORIZATION_MISMATCH");
  if (command === "bucket-birth" && !apply && values.has("--receipt-out")) fail("GCP_INFRA_ARGUMENT_INVALID");
  const receiptPath = values.get("--receipt-out") ?? null;
  if (receiptPath !== null && !isAbsolute(receiptPath)) fail("BUCKET_BIRTH_RECEIPT_PATH_INVALID");
  return Object.freeze({
    command,
    desiredStatePath: desiredStatePath === undefined ? null : resolve(desiredStatePath),
    environment,
    bootstrap,
    authorize: values.get("--authorize") ?? null,
    apply,
    requireClean: values.get("--require-clean") === true,
    receiptPath: receiptPath === null ? null : resolve(receiptPath),
  });
}

function attempt(render) {
  try {
    return render();
  } catch (error) {
    if (error instanceof GcpOpsInfraError) return { unavailable: error.code };
    throw error;
  }
}

/** Everything the desired state renders to, without any call. */
export function renderInfrastructure(desired, { bootstrap = null } = {}) {
  const image = bootstrap ?? null;
  return {
    schema: GCP_OPS_INFRA_RENDER_SCHEMA,
    environment: desired.environment,
    project: desired.project,
    region: desired.region,
    synthetic: desired.synthetic,
    desiredStateDigest: desiredStateDigest(desired),
    connectionBudget: desired.connectionBudget,
    customRole: desired.customRole,
    projectBindings: desiredProjectBindings(desired),
    cloudSql: { createArgs: cloudSqlCreateArgs(desired), databaseFlags: databaseFlags(desired) },
    bucket: bucketInsertBody(desired),
    serviceIam: renderEdgeIamPolicy(desired),
    service: image === null ? { unavailable: "BOOTSTRAP_IMAGE_REQUIRED" } : attempt(() => renderService(desired, image)),
    jobs: Object.fromEntries(JOB_NAMES.map((job) => [job, Object.hasOwn(DEFERRED_JOBS, job)
      ? { unavailable: DEFERRED_JOBS[job] }
      : image === null ? { unavailable: "BOOTSTRAP_IMAGE_REQUIRED" } : attempt(() => renderJob(desired, job, image))])),
    scheduler: Object.fromEntries(SCHEDULED_JOB_NAMES.map((job) => [job,
      desired.scheduler[job].schedule !== null && Object.hasOwn(DEFERRED_JOBS, job)
        ? { unavailable: DEFERRED_JOBS[job] } : attempt(() => schedulerFlags(desired, job))])),
  };
}

function needsAttention(plan) {
  return plan.blockers.length > 0 || plan.summary.refused > 0 || plan.findings.includes("BUCKET_PROOF_STALE");
}

/** CLI entry; returns the process exit code. */
export async function main(argv = process.argv.slice(2), {
  runner = defaultGcloudRunner,
  fetchImpl = globalThis.fetch,
  readFile,
  readSource,
  createSpecWriter,
  reserveReceipt,
  env = process.env,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  const print = (value) => stdout(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const config = parseGcpInfraArgs(argv);
    const loaded = readDesiredStateFile(config.desiredStatePath ?? desiredStatePathFor(config.environment, env), {
      ...(readFile === undefined ? {} : { readFile }),
      ...(readSource === undefined ? {} : { readSource }),
    });
    const desired = config.environment === null ? loaded : requireEnvironment(loaded, config.environment);
    if (config.command === "render") {
      print(renderInfrastructure(desired, { bootstrap: config.bootstrap }));
      return 0;
    }
    if (config.command === "readback") {
      const readback = readbackInfrastructure(desired, { runner });
      if (config.requireClean) {
        const plan = planInfrastructure(desired, readback);
        const verdict = infrastructureCleanliness(plan);
        print({
          schema: GCP_OPS_INFRA_CLEAN_SCHEMA,
          environment: desired.environment,
          project: desired.project,
          clean: verdict.clean,
          reasons: verdict.reasons,
          planDigest: plan.planDigest,
          summary: plan.summary,
          readback,
        });
        return verdict.clean ? 0 : 2;
      }
      print(readback);
      return readback.findings.some((finding) => finding !== "BUCKET_PROOF_UNPINNED") ? 2 : 0;
    }
    if (config.command === "plan") {
      const plan = planInfrastructure(desired, readbackInfrastructure(desired, { runner }),
        config.bootstrap === null ? {} : { bootstrap: config.bootstrap });
      print(plan);
      return needsAttention(plan) ? 2 : 0;
    }
    if (config.command === "apply") {
      print(applyInfrastructure(desired, {
        runner,
        authorize: config.authorize,
        ...(config.bootstrap === null ? {} : { bootstrap: config.bootstrap }),
        ...(createSpecWriter === undefined ? {} : { createSpecWriter }),
      }));
      return 0;
    }
    print(await runBucketBirth(desired, {
      apply: config.apply,
      authorize: config.authorize ?? undefined,
      receiptPath: config.receiptPath,
      runner,
      fetchImpl,
      ...(reserveReceipt === undefined ? {} : { reserveReceipt }),
    }));
    return 0;
  } catch (error) {
    if (error instanceof GcpOpsInfraError && error.bucketInserted === true) {
      // The bucket exists now, and a rerun refuses it: never lose the proof.
      // The receipt is content-free; it goes to stdout when its file failed.
      if (error.code === "BUCKET_BIRTH_RECEIPT_WRITE_FAILED" && error.receipt !== undefined) {
        print({ status: "created_receipt_unwritten", receipt: error.receipt });
      }
      stderr(`${JSON.stringify({ status: "error", code: error.code, bucketInserted: true })}\n`);
      return 1;
    }
    if (error?.code === "APPLY_OPERATION_FAILED" && Array.isArray(error.outcomes)) {
      // Which operations ran before the failure: ids and outcomes only.
      stderr(`${JSON.stringify({ status: "error", code: error.code, operation: error.operation,
        outcomes: error.outcomes })}\n`);
      return 1;
    }
    const code = error instanceof GcpOpsInfraError ? error.code : "GCP_INFRA_FAILED";
    stderr(`${JSON.stringify({ status: "error", code })}\n`);
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
