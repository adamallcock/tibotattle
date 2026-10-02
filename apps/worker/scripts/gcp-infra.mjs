#!/usr/bin/env node

/**
 * Operator CLI for the production infrastructure (OPS-2).
 *
 *   render       --desired-state=<abs path> [--bootstrap-image-digest=<hex>
 *                --bootstrap-source-commit=<hex>]
 *     The rendered estate; no gcloud call.
 *   readback     --desired-state=<abs path>
 *     The live estate through describe, get-iam-policy and list calls only.
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
 *
 * Output is one content-free JSON document on stdout. Exit 0 on success, 2
 * when a plan or readback holds refused operations, blockers or findings that
 * apply would refuse, and 1 on any error, reported as {"status":"error",
 * "code":...} on stderr without echoing gcloud output. Every gcloud call is an
 * argv array through the guarded runner; no shell is used.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GcpOpsInfraError,
  JOB_NAMES,
  SCHEDULED_JOB_NAMES,
  bucketInsertBody,
  cloudSqlCreateArgs,
  databaseFlags,
  desiredProjectBindings,
  desiredStateDigest,
  readDesiredStateFile,
  renderEdgeIamPolicy,
  renderJob,
  renderService,
  schedulerFlags,
} from "./gcp-ops-infra-manifest.mjs";
import {
  applyInfrastructure,
  defaultGcloudRunner,
  normalizeBootstrap,
  planInfrastructure,
  readbackInfrastructure,
} from "./gcp-ops-infra-operations.mjs";
import { runBucketBirth } from "./gcp-ops-bucket-birth.mjs";

export const GCP_OPS_INFRA_RENDER_SCHEMA = "tibotattle-gcp-ops-infra-render-v1";

const COMMANDS = Object.freeze({
  render: Object.freeze(["--desired-state", "--bootstrap-image-digest", "--bootstrap-source-commit"]),
  readback: Object.freeze(["--desired-state"]),
  plan: Object.freeze(["--desired-state", "--bootstrap-image-digest", "--bootstrap-source-commit"]),
  apply: Object.freeze(["--desired-state", "--authorize", "--bootstrap-image-digest", "--bootstrap-source-commit"]),
  "bucket-birth": Object.freeze(["--desired-state", "--authorize", "--receipt-out", "--apply"]),
});
const BOOLEAN_FLAGS = Object.freeze(["--apply"]);

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
  if (desiredStatePath === undefined) fail("GCP_INFRA_ARGUMENT_MISSING");
  if (!isAbsolute(desiredStatePath)) fail("GCP_INFRA_DESIRED_STATE_PATH_INVALID");
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
    desiredStatePath: resolve(desiredStatePath),
    bootstrap,
    authorize: values.get("--authorize") ?? null,
    apply,
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
    jobs: Object.fromEntries(JOB_NAMES.map((job) => [job, image === null
      ? { unavailable: "BOOTSTRAP_IMAGE_REQUIRED" } : attempt(() => renderJob(desired, job, image))])),
    scheduler: Object.fromEntries(SCHEDULED_JOB_NAMES.map((job) => [job, attempt(() => schedulerFlags(desired, job))])),
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
  writeReceipt,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  try {
    const config = parseGcpInfraArgs(argv);
    const desired = readDesiredStateFile(config.desiredStatePath, {
      ...(readFile === undefined ? {} : { readFile }),
      ...(readSource === undefined ? {} : { readSource }),
    });
    const print = (value) => stdout(`${JSON.stringify(value, null, 2)}\n`);
    if (config.command === "render") {
      print(renderInfrastructure(desired, { bootstrap: config.bootstrap }));
      return 0;
    }
    if (config.command === "readback") {
      const readback = readbackInfrastructure(desired, { runner });
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
      ...(writeReceipt === undefined ? {} : { writeReceipt }),
    }));
    return 0;
  } catch (error) {
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
