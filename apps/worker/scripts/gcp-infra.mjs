#!/usr/bin/env node

/**
 * Operator CLI for the GCP infrastructure (OPS-2).
 *
 *   Every command takes --environment=<production|staging>, which reads that
 *   environment's COMMITTED desired state (cloud-run/infra/<env>.desired-
 *   state.json) under the committed-file policy. render, readback, plan and
 *   scheduler-probe also accept --desired-state=<abs path> for a draft or the
 *   synthetic fixture; with both, the file must describe that environment.
 *   apply and an applying bucket-birth take --environment only: a real
 *   change is made only from the committed desired state.
 *
 *   render       --desired-state=<abs path> [--bootstrap-image-digest=<hex>
 *                --bootstrap-source-commit=<hex>]
 *     The rendered estate; no gcloud call.
 *   scheduler-probe --environment=<env>
 *     The paused-too-long signal: one read of the location's scheduler jobs
 *     and a content-free verdict per managed trigger; exit 2 when a resumed
 *     trigger has stayed PAUSED past the threshold (6 h), or when its state
 *     or the evidence for it is missing or unrecognized.
 *   readback     --desired-state=<abs path> [--require-clean]
 *     The live estate through describe, get-iam-policy and list calls only.
 *     With --require-clean (OPS-10's preflight), the readback, its plan's
 *     digest and summary, and a clean verdict; exit 0 only when clean.
 *   plan         --desired-state=<abs path> [--bootstrap-image-digest --bootstrap-source-commit]
 *     Readback plus the deterministic plan and its planDigest. This is the
 *     dry run; nothing changes.
 *   apply        --environment=<env> --authorize=<planDigest>
 *                [--bootstrap-image-digest --bootstrap-source-commit]
 *     Re-reads, re-plans, and runs only the create, update and bind
 *     operations of a plan whose digest equals --authorize. It never deletes,
 *     never changes a running image or source commit, never edits bucket
 *     metadata or bucket IAM, and refuses the synthetic fixture.
 *   pause-all    --environment=<env> [--apply --authorize=<planDigest> --receipt-out=<abs path>]
 *     OPS-3. Dry run by default: one read of the region's scheduler jobs and
 *     the plan (every plane trigger, its action, co-tenant triggers that keep
 *     OPS-10's ROLLOUT_JOBS_NOT_PAUSED gate shut, and that gate after the
 *     pauses). With --apply: re-plan, refuse a different digest or a blocker,
 *     reserve the receipt file, pause each ENABLED plane trigger, read back,
 *     and write the receipt resume-all reads.
 *   resume-all   --environment=<env> (--pause-receipt=<abs path> | --only=<name>[,<name>...])
 *                [--apply --authorize=<planDigest>]
 *     OPS-3. Resumes only managed triggers whose committed state is ENABLED,
 *     live PAUSED, and paused by that pause-all run (its receipt, under 24 h
 *     old, with the trigger unchanged since) or named by the operator with
 *     --only, in that order. Dry run by default.
 *   bucket-birth --environment=<env> [--apply
 *                --authorize=bucket-birth:<project>:<bucket> --receipt-out=<abs path>]
 *     Dry run by default; with --apply, one bucket insert that refuses an
 *     existing bucket, and a proof receipt the owner pins in the desired state.
 *     The --receipt-out file is reserved before the insert; should writing
 *     it fail afterwards, the receipt is printed on stdout instead.
 *
 * Output is one content-free JSON document on stdout. Exit 0 on success, 2
 * when a plan or readback holds refused operations, blockers or findings that
 * apply would refuse (or, with --require-clean, when the estate is not
 * clean, or when the scheduler probe raises its signal), and 1 on any error, reported as {"status":"error", "code":...} on
 * stderr without echoing gcloud output. A failure after a bucket insert adds
 * "bucketInserted": true. Every gcloud call is an
 * argv array through the guarded runner; no shell is used.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
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
  loadCommittedDesiredState,
  readDesiredStateFile,
  renderEdgeIamPolicy,
  renderJob,
  renderService,
  requireEnvironment,
  schedulerFlags,
  serviceRenderBlocker,
  TOKEN_CREATOR_ROLE,
} from "./gcp-ops-infra-manifest.mjs";
import {
  applyInfrastructure,
  applyPauseAll,
  applyResumeAll,
  defaultGcloudRunner,
  infrastructureCleanliness,
  normalizeBootstrap,
  planInfrastructure,
  planPauseAll,
  planResumeAll,
  probeScheduler,
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
  "scheduler-probe": Object.freeze([...SOURCE]),
  "pause-all": Object.freeze([...SOURCE, "--authorize", "--receipt-out", "--apply"]),
  "resume-all": Object.freeze([...SOURCE, "--authorize", "--pause-receipt", "--only", "--apply"]),
});
const OPS3_COMMANDS = Object.freeze(["pause-all", "resume-all"]);
const PAUSE_RECEIPT_MAX_BYTES = 256 * 1024;
const TRIGGER_LIST = /^[A-Za-z0-9_-]{1,500}(?:,[A-Za-z0-9_-]{1,500})*$/u;
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
  if (receiptPath !== null && !isAbsolute(receiptPath)) {
    fail(command === "bucket-birth" ? "BUCKET_BIRTH_RECEIPT_PATH_INVALID" : "OPS_RECEIPT_PATH_INVALID");
  }
  if (OPS3_COMMANDS.includes(command)) {
    if (apply !== values.has("--authorize")) fail("OPS3_AUTHORIZATION_MISMATCH");
    if (command === "pause-all" && apply !== (receiptPath !== null)) fail("PAUSE_ALL_RECEIPT_PATH_REQUIRED");
    if (command === "resume-all" && !values.has("--pause-receipt") && !values.has("--only")) {
      fail("RESUME_ALL_SOURCE_REQUIRED");
    }
  }
  const pauseReceiptPath = values.get("--pause-receipt") ?? null;
  if (pauseReceiptPath !== null && !isAbsolute(pauseReceiptPath)) fail("PAUSE_ALL_RECEIPT_PATH_INVALID");
  const onlyValue = values.get("--only") ?? null;
  if (onlyValue !== null && !TRIGGER_LIST.test(onlyValue)) fail("RESUME_ALL_ONLY_INVALID");
  // A real change is made only from the committed desired state.
  if ((command === "apply" || ((command === "bucket-birth" || OPS3_COMMANDS.includes(command)) && apply))
      && (desiredStatePath !== undefined || environment === null)) {
    fail("GCP_INFRA_COMMITTED_DESIRED_STATE_REQUIRED");
  }
  return Object.freeze({
    command,
    desiredStatePath: desiredStatePath === undefined ? null : resolve(desiredStatePath),
    environment,
    bootstrap,
    authorize: values.get("--authorize") ?? null,
    apply,
    requireClean: values.get("--require-clean") === true,
    receiptPath: receiptPath === null ? null : resolve(receiptPath),
    pauseReceiptPath: pauseReceiptPath === null ? null : resolve(pauseReceiptPath),
    only: onlyValue === null ? null : Object.freeze(onlyValue.split(",")),
  });
}

/** A pause-all receipt file: a regular, single-link file of bounded JSON (verified by resume-all). */
export function readPauseReceiptFile(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return fail("PAUSE_ALL_RECEIPT_REQUIRED");
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > PAUSE_RECEIPT_MAX_BYTES) fail("PAUSE_ALL_RECEIPT_INVALID");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fail("PAUSE_ALL_RECEIPT_INVALID");
  }
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
    verifierIam: desired.serviceAccounts.verifier === null ? null
      : desired.serviceAccounts.verifier.tokenCreators === null ? { unavailable: "VERIFIER_TOKEN_CREATOR_UNASSIGNED" }
        : { account: desired.serviceAccounts.verifier.email, role: TOKEN_CREATOR_ROLE,
          members: desired.serviceAccounts.verifier.tokenCreators },
    service: serviceRenderBlocker(desired) !== null ? { unavailable: serviceRenderBlocker(desired) }
      : image === null ? { unavailable: "BOOTSTRAP_IMAGE_REQUIRED" } : attempt(() => renderService(desired, image)),
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
  now,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  const print = (value) => stdout(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const config = parseGcpInfraArgs(argv);
    const sources = {
      ...(readFile === undefined ? {} : { readFile }),
      ...(readSource === undefined ? {} : { readSource }),
    };
    let desired;
    if (config.desiredStatePath === null) {
      desired = loadCommittedDesiredState(config.environment, sources);
    } else {
      const loaded = readDesiredStateFile(config.desiredStatePath, sources);
      desired = config.environment === null ? loaded : requireEnvironment(loaded, config.environment);
    }
    if (config.command === "scheduler-probe") {
      const probe = probeScheduler(desired, { runner, ...(now === undefined ? {} : { now }) });
      print(probe);
      return probe.alert ? 2 : 0;
    }
    if (config.command === "pause-all") {
      if (!config.apply) {
        const plan = planPauseAll(desired, { runner });
        print(plan);
        return plan.blockers.length > 0 || !plan.rolloutGateAfter.satisfied ? 2 : 0;
      }
      print(await applyPauseAll(desired, {
        runner,
        authorize: config.authorize,
        receiptPath: config.receiptPath,
        ...(now === undefined ? {} : { now }),
        ...(reserveReceipt === undefined ? {} : { reserveReceipt }),
      }));
      return 0;
    }
    if (config.command === "resume-all") {
      const source = {
        pauseReceipt: config.pauseReceiptPath === null ? null : readPauseReceiptFile(config.pauseReceiptPath),
        only: config.only,
      };
      if (!config.apply) {
        const plan = planResumeAll(desired, { runner, ...source, ...(now === undefined ? {} : { now }) });
        print(plan);
        return plan.blockers.length > 0 ? 2 : 0;
      }
      print(applyResumeAll(desired, { runner, authorize: config.authorize, ...source,
        ...(now === undefined ? {} : { now }) }));
      return 0;
    }
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
    if (error?.code === "PAUSE_ALL_INCOMPLETE" && error.receipt !== undefined) {
      // The receipt was written; it is printed too, content-free, so the
      // operator sees what was paused.
      print({ status: "incomplete", receipt: error.receipt });
      stderr(`${JSON.stringify({ status: "error", code: error.code })}\n`);
      return 1;
    }
    if (error?.code === "RESUME_ALL_OPERATION_FAILED" && Array.isArray(error.outcomes)) {
      stderr(`${JSON.stringify({ status: "error", code: error.code, operation: error.operation,
        outcomes: error.outcomes })}\n`);
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
