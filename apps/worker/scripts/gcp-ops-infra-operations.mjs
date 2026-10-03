/**
 * Readback, plan and apply for the production infrastructure (OPS-2).
 *
 *   readbackInfrastructure(desired, { runner }) -> content-free live snapshot
 *   planInfrastructure(desired, readback, { bootstrap }) -> deterministic plan
 *   applyInfrastructure(desired, { runner, authorize, bootstrap }) -> receipt
 *
 * Every gcloud call goes through an injected runner(argv) and a guard that
 * accepts only a closed set of command shapes. Readback issues describe,
 * get-iam-policy and list calls only, each with --project and --format=json;
 * it never reads a secret value (`secrets versions access` is not a shape the
 * guard knows). Apply is the only mode that may issue a mutating command, and
 * only after it has re-read the estate, recomputed the plan and matched its
 * planDigest to --authorize.
 *
 * The plan holds create, update and bind operations, which apply runs, and
 * refused operations, which apply never runs: a delete (anything live that the
 * desired state does not describe, such as a second Cloud SQL instance or an
 * extra IAM member), a destructive change (an immutable setting, a narrowed
 * permission set, a shorter retention, a policy replacement) and any bucket
 * metadata update. A plan that holds any of them refuses as a whole
 * (APPLY_DELETE_REFUSED, APPLY_DESTRUCTIVE_CHANGE_REFUSED,
 * BUCKET_METADATA_UPDATE_REFUSED). The only bucket operations apply may run
 * are the build-source bucket's (BUILD-SOURCE, below). An operation
 * whose inputs are not yet available (an image for a first create, a pinned
 * secret version, an owner-supplied scheduler cadence, a job DEFERRED_JOBS
 * names) is listed as deferred and skipped.
 *
 * A state someone set by hand is never undone by apply: a disabled managed
 * service account (SERVICE_ACCOUNT_DISABLED:<role>), or a custom role whose
 * stage is not GA (CUSTOM_ROLE_DISABLED, CUSTOM_ROLE_STAGE_NOT_GA), is a
 * finding and a blocker that refuses the whole plan until the owner decides.
 *
 * Scheduler trigger state is part of the desired state (PAUSED until OPS-3
 * resumes it). A plan creates a trigger and pauses it immediately, and binds
 * the scheduler account's run.jobsExecutor on the job only after that pause
 * (assertTriggersCreatedPaused refuses any other order), so a trigger whose
 * pause failed is ENABLED but cannot start the job. That holds only while the
 * account holds no grant on the job when the create runs. While the committed
 * schedule is null the grant is withheld (deferred as SCHEDULER_CADENCE_UNSET
 * with the trigger), so the plan that follows a committed cadence finds none;
 * a grant already live when a create is planned blocks the plan
 * (SCHEDULER_CREATE_EXECUTOR_BOUND:<job>) until the owner removes it, because
 * apply never removes one. Readback reads the state;
 * a trigger that runs while PAUSED is desired is a
 * SCHEDULER_TRIGGER_ENABLED:<job> finding, and the plan pauses it, so a
 * create whose pause failed is paused by the next apply rather than reported
 * as converged (meanwhile OPS-10's require-clean preflight refuses the
 * estate). Apply never resumes: a paused trigger whose desired state is
 * ENABLED is a deferred resume (SCHEDULER_TRIGGER_RESUME_PENDING) for OPS-3.
 * A state readback does not recognize is a blocker. probeScheduler is the
 * paused-too-long signal: a resumed trigger left PAUSED past the threshold.
 *
 * A job that reads configuration only the desired state can supply (the
 * maintenance job: the telemetry namespace, the quarantine bucket's birth
 * proof, and secrets at pinned versions) is deferred like the service until
 * each exists (jobInputDeferral), and its trigger is not created while it is
 * (the trigger would only name a job that does not exist). A job its
 * environment cannot have (JOB_ENVIRONMENT_UNAVAILABLE) is never created.
 *
 * The verifier account carries the operator's
 * roles/iam.serviceAccountTokenCreator grant (OD-CR-7), read with
 * `iam service-accounts get-iam-policy` and bound with
 * `iam service-accounts add-iam-policy-binding`. Until the desired state
 * names the operator the grant is a deferral that keeps the estate unclean,
 * and any grant of an impersonation role on the verifier account's own
 * policy that it does not name is a delete apply refuses. Grants that reach
 * the verifier from above it are not read: an impersonation role held on the
 * project policy (readback keeps only the plane's own and public members
 * there), on a folder or the organization, or through a basic or custom role.
 *
 * In a shared project (projectTenancy 'shared', the staging plane in the GCP
 * test project) readback keeps only the plane's own instances, services,
 * jobs and triggers, so co-tenant resources are never planned for deletion,
 * and it neither reads nor plans the project-wide logging and Data Access
 * audit settings.
 *
 * infrastructureCleanliness(plan) is OPS-10's `readback --require-clean`
 * verdict: clean only with no finding, no blocker, nothing executable, nothing
 * refused, and no deferral outside CLEAN_DEFERRALS. An unset cadence is a
 * clean deferral for the rollout, which must run before the cadence can be
 * measured; `--require-cadence` (requireCadence) is the cutover's stricter
 * form, which refuses it.
 *
 * BUILD-SOURCE (gcp-build-source-bucket.mjs): the project's default Cloud
 * Build bucket, `<project>_cloudbuild` (desired.buildSource.bucket), holds one
 * managed binding, roles/storage.objectViewer for the plane's builder, on the
 * bucket's own policy (never a project role). Readback reads it from the same
 * bucket listing and keeps the policy's builder, objectViewer and public
 * bindings; its drift list names a missing reader binding, any other role for
 * the builder (BUILDER_ROLE_BROADER), a conditional reader binding and
 * another member on the reader role (READER_EXTRA_MEMBER). The plan binds a
 * missing reader binding and refuses (delete) every other builder, reader or
 * public binding; drift other than a missing binding is also the finding
 * BUILD_SOURCE_BUCKET_IAM_DRIFT, and a public member the finding and blocker
 * BUILD_SOURCE_BUCKET_POLICY_PUBLIC_MEMBER. Drift covers the builder and the
 * reader role only: another member holding some other role on the bucket is
 * outside it (an owner decision to widen). A listed bucket of another
 * project number is BUILD_SOURCE_BUCKET_FOREIGN and is never bound on; that
 * check is defensive, since a live project listing names only the project's
 * own buckets. A name another project holds therefore reads back absent, and
 * its create fails at apply (APPLY_OPERATION_FAILED), stopping the pass there;
 * OPS-10's describe precheck is the check that can see it. An
 * absent bucket is the finding BUILD_SOURCE_BUCKET_ABSENT: the plan creates it
 * (buildSourceBucketCreateArgs: the plane's region, uniform bucket-level
 * access, public access prevention enforced) and defers the binding with that
 * code, so the next pass binds only on a bucket readback has shown to be the
 * project's own. The guard admits `storage buckets create` and `storage
 * buckets add-iam-policy-binding` (BUILD_SOURCE_BUCKET_COMMANDS) only in apply
 * mode and only for gs://<that bucket>, and a plan that would mutate any other
 * bucket refuses (PLAN_BUCKET_MUTATION_UNSCOPED). An existing build-source
 * bucket's metadata is reported, never planned or changed.
 *
 * The quarantine bucket is born only by gcp-ops-bucket-birth.mjs. Apply refuses until the
 * desired state pins that birth proof (APPLY_BUCKET_PROOF_UNPINNED), and
 * readback reports BUCKET_PROOF_STALE when the live generation or
 * metageneration has moved from it.
 *
 * On an existing service or job, the image digest and DEPLOYMENT_SOURCE_COMMIT
 * are taken from the live resource, so apply never changes what runs; only the
 * OPS-10 rollout moves them. A first create takes them from an explicit
 * bootstrap image, which is refused when nothing needs it.
 */

import { spawnSync } from "node:child_process";
import { constants as fsConstants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  ARTIFACT_WRITER_ROLE,
  BUCKET_POSTURE,
  CLOUD_SQL_POSTURE,
  DEFERRED_JOBS,
  JOBS_EXECUTOR_ROLE,
  JOB_NAMES,
  LOGGING_POSTURE,
  QUARANTINE_STORE_ROLE_DESCRIPTION,
  QUARANTINE_STORE_ROLE_TITLE,
  RUN_INVOKER_ROLE,
  SCHEDULED_JOB_NAMES,
  SCHEDULER_OAUTH_SCOPE,
  SCHEDULER_TIME_ZONE,
  SCHEDULER_TRIGGER_STATES,
  SCHEDULER_PAUSE_ALERT_THRESHOLD_HOURS,
  SECRET_ACCESSOR_ROLE,
  SERVICE_ACCOUNT_ROLES,
  TOKEN_CREATOR_ROLE,
  backupConfiguration,
  buildSourceBucketCreateArgs,
  buildSourceReaderBinding,
  cloudSqlCreateArgs,
  databaseFlags,
  databaseFlagsArgument,
  deepFreeze,
  desiredProjectBindings,
  desiredStateDigest,
  fail,
  jobDefinition,
  jobRenderBlocker,
  jobRunUri,
  jobSecretNames,
  renderEdgeIamPolicy,
  renderJob,
  renderService,
  schedulerFlags,
  serviceRenderBlocker,
  sha256Hex,
} from "./gcp-ops-infra-manifest.mjs";
import { scheduledRunJob } from "./gcp-scheduler-run-target.mjs";
import { BUILD_SOURCE_BUCKET_ABSENT, BUILD_SOURCE_READER_ROLE } from "./gcp-build-source-bucket.mjs";

export const GCP_OPS_INFRA_READBACK_SCHEMA = "tibotattle-gcp-ops-infra-readback-v1";
export const GCP_OPS_INFRA_PLAN_SCHEMA = "tibotattle-gcp-ops-infra-plan-v1";
export const GCP_OPS_INFRA_APPLY_SCHEMA = "tibotattle-gcp-ops-infra-apply-v1";

/** gcloud command shapes readback may issue (always with --format=json). */
export const READ_COMMANDS = Object.freeze([
  "iam service-accounts list",
  "iam service-accounts get-iam-policy",
  "iam roles list",
  "iam roles describe",
  "projects get-iam-policy",
  "artifacts repositories list",
  "artifacts repositories get-iam-policy",
  "secrets list",
  "secrets get-iam-policy",
  "secrets versions list",
  "sql instances list",
  "sql databases list",
  "sql users list",
  "storage buckets list",
  "storage buckets get-iam-policy",
  "run services list",
  "run services get-iam-policy",
  "run jobs list",
  "run jobs get-iam-policy",
  "scheduler jobs list",
  "logging sinks describe",
  "logging buckets describe",
]);
/** gcloud command shapes only an authorized apply may issue. None deletes. */
export const MUTATING_COMMANDS = Object.freeze([
  "iam service-accounts create",
  "iam service-accounts add-iam-policy-binding",
  "iam roles create",
  "iam roles update",
  "projects add-iam-policy-binding",
  "artifacts repositories create",
  "artifacts repositories update",
  "artifacts repositories add-iam-policy-binding",
  "secrets create",
  "secrets add-iam-policy-binding",
  "sql instances create",
  "sql instances patch",
  "sql databases create",
  "sql users create",
  "run services replace",
  "run services add-iam-policy-binding",
  "run jobs replace",
  "run jobs add-iam-policy-binding",
  "scheduler jobs create http",
  "scheduler jobs update http",
  "scheduler jobs pause",
  "logging sinks update",
  "logging buckets update",
]);
/**
 * The build-source bucket's create and the builder's read binding on it
 * (BUILD-SOURCE). They classify as "mutate", but the guard admits them only
 * in apply mode, only with the plane's build-source bucket named to it, and
 * only when the command's one positional URL is exactly gs://<that bucket>
 * (GCLOUD_COMMAND_FORBIDDEN otherwise), so no apply can create or bind on any
 * other bucket, the quarantine bucket included.
 */
export const BUILD_SOURCE_BUCKET_COMMANDS = Object.freeze([
  "storage buckets create",
  "storage buckets add-iam-policy-binding",
]);
/**
 * The one gcloud shape OPS-3's resume-all may issue, and only in "resume"
 * mode: apply and pause-all never know it (GCLOUD_COMMAND_FORBIDDEN).
 */
export const RESUME_COMMANDS = Object.freeze(["scheduler jobs resume"]);
/** The one mutating shape OPS-3's pause-all may issue ("pause" mode). */
export const PAUSE_COMMAND = "scheduler jobs pause";
/** Operation actions apply runs; every other action refuses the plan. */
export const EXECUTABLE_ACTIONS = Object.freeze(["create", "update", "bind"]);
export const REFUSED_ACTIONS = Object.freeze(["delete", "destructive", "bucket-update"]);
/** Cloud Scheduler job states readback reports; anything else is UNRECOGNIZED. */
export const SCHEDULER_LIVE_STATES = Object.freeze(["ENABLED", "PAUSED", "DISABLED", "UPDATE_FAILED"]);
/** IAM custom role stages readback reports; anything else is UNRECOGNIZED. */
export const CUSTOM_ROLE_STAGES = Object.freeze(["ALPHA", "BETA", "GA", "DEPRECATED", "DISABLED", "EAP"]);
/** The deferred resume of a paused trigger whose desired state is ENABLED (OPS-3 resumes). */
export const SCHEDULER_RESUME_DEFERRAL = "SCHEDULER_TRIGGER_RESUME_PENDING";
/** The operator's token-creator grant while the desired state names no operator (not clean). */
export const VERIFIER_TOKEN_CREATOR_DEFERRAL = "VERIFIER_TOKEN_CREATOR_UNASSIGNED";
/**
 * A trigger's create, and the scheduler account's executor grant on its job,
 * while the committed schedule is null (decision D3: no default cadence).
 */
export const SCHEDULER_CADENCE_DEFERRAL = "SCHEDULER_CADENCE_UNSET";
/**
 * Deferrals that leave the estate clean for OPS-10: an owner decision not yet
 * made (the D3 cadence), a job DEFERRED_JOBS names, and a resume OPS-3 owns.
 * The cadence is clean for the rollout only: the production-scale measurement
 * that decides it needs the rolled image, so a cutover gate asks for it with
 * infrastructureCleanliness(plan, { requireCadence: true }).
 * Every other deferral (a bootstrap image, a secret version, an unrecognized
 * live image, the verifier's unnamed operator, a service template or
 * telemetry namespace not yet available) means the estate is not yet what
 * the desired state describes.
 */
export const CLEAN_DEFERRALS = Object.freeze([
  SCHEDULER_CADENCE_DEFERRAL,
  SCHEDULER_RESUME_DEFERRAL,
  ...new Set(Object.values(DEFERRED_JOBS)),
]);

const FILE_PLACEHOLDER = "${FILE}";
const GCLOUD_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;
const IMAGE_DIGEST = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/u;
const BUILD_SOURCE_BUCKET = /^[a-z][a-z0-9-]{4,28}[a-z0-9]_cloudbuild$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positionalPath(argv) {
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) break;
    positional.push(arg);
  }
  return positional.join(" ");
}

function matchesShape(path, shape) {
  return path === shape || path.startsWith(`${shape} `);
}

/**
 * "read", "mutate", "resume" or null for one argv (without the gcloud binary).
 * A build-source bucket shape classifies as "mutate"; the guard scopes it.
 */
export function classifyGcloudCommand(argv) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) return null;
  const path = positionalPath(argv);
  if (MUTATING_COMMANDS.some((shape) => matchesShape(path, shape))) return "mutate";
  if (BUILD_SOURCE_BUCKET_COMMANDS.some((shape) => matchesShape(path, shape))) return "mutate";
  if (READ_COMMANDS.some((shape) => matchesShape(path, shape))) return "read";
  if (RESUME_COMMANDS.some((shape) => matchesShape(path, shape))) return "resume";
  return null;
}

function isBuildSourceCommand(argv) {
  return BUILD_SOURCE_BUCKET_COMMANDS.some((shape) => matchesShape(positionalPath(argv), shape));
}

/** True when a build-source shape names exactly gs://<bucket> as its one positional URL. */
function scopedToBuildSource(argv, bucket) {
  const positional = positionalPath(argv).split(" ");
  return typeof bucket === "string" && BUILD_SOURCE_BUCKET.test(bucket) && isBuildSourceCommand(argv)
    && positional.length === 4 && positional[3] === `gs://${bucket}`;
}

/** The default runner: spawnSync with an argv array and no shell. */
export function defaultGcloudRunner(argv) {
  const result = spawnSync("gcloud", argv, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GCLOUD_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, error: result.error };
}

/**
 * Wraps a runner with the command guard. `mode` is "read", "apply", "pause"
 * or "resume": mutating shapes are refused unless the mode is "apply", except
 * that "pause" (OPS-3 pause-all) may issue exactly PAUSE_COMMAND; the resume
 * shape exists only in "resume" mode (OPS-3 resume-all), which issues nothing
 * else that mutates. A build-source bucket shape (BUILD_SOURCE_BUCKET_COMMANDS)
 * exists only in "apply" mode with `buildSourceBucket` named (the project's
 * own <project>_cloudbuild), and only for gs://<buildSourceBucket>. Unknown
 * shapes are always refused. Failures never echo gcloud output.
 */
export function guardedGcloud(runner, { mode, project, buildSourceBucket = null }) {
  if (typeof runner !== "function") fail("GCLOUD_RUNNER_INVALID");
  if (!["read", "apply", "pause", "resume"].includes(mode)) fail("GCLOUD_GUARD_MODE_INVALID");
  if (buildSourceBucket !== null && (mode !== "apply" || typeof buildSourceBucket !== "string"
      || buildSourceBucket !== `${project}_cloudbuild` || !BUILD_SOURCE_BUCKET.test(buildSourceBucket))) {
    fail("GCLOUD_GUARD_BUCKET_INVALID");
  }
  return function call(argv) {
    const kind = classifyGcloudCommand(argv);
    if (kind === null || (kind === "resume" && mode !== "resume")) fail("GCLOUD_COMMAND_FORBIDDEN");
    if (isBuildSourceCommand(argv) && !scopedToBuildSource(argv, buildSourceBucket)) fail("GCLOUD_COMMAND_FORBIDDEN");
    if (kind === "mutate" && !(mode === "apply"
      || (mode === "pause" && matchesShape(positionalPath(argv), PAUSE_COMMAND)))) {
      fail("GCLOUD_MUTATION_UNAUTHORIZED");
    }
    if (argv.filter((arg) => arg === `--project=${project}`).length !== 1
        || argv.some((arg) => arg.startsWith("--project=") && arg !== `--project=${project}`)) {
      fail("GCLOUD_PROJECT_FLAG_INVALID");
    }
    if (kind === "read" && !argv.includes("--format=json")) fail("GCLOUD_READ_FORMAT_REQUIRED");
    let result;
    try {
      result = runner([...argv]);
    } catch {
      fail(`GCLOUD_CALL_FAILED:${commandPath(argv)}`);
    }
    if (!isRecord(result) || result.status !== 0 || (result.error !== undefined && result.error !== null)) {
      fail(`GCLOUD_CALL_FAILED:${commandPath(argv)}`);
    }
    if (kind === "mutate" || kind === "resume") return null;
    if (typeof result.stdout !== "string") fail(`GCLOUD_OUTPUT_INVALID:${commandPath(argv)}`);
    try {
      return JSON.parse(result.stdout === "" ? "[]" : result.stdout);
    } catch {
      return fail(`GCLOUD_OUTPUT_INVALID:${commandPath(argv)}`);
    }
  };
}

function commandPath(argv) {
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith("-") || positional.length >= 4) break;
    if (/^[a-z][a-z-]*$/u.test(arg)) positional.push(arg);
    else break;
  }
  return positional.join("-");
}

function outputInvalid(what) {
  return fail(`GCLOUD_OUTPUT_INVALID:${what}`);
}

function array(value, what) {
  if (!Array.isArray(value)) outputInvalid(what);
  return value;
}

function tail(name) {
  return typeof name === "string" ? name.slice(name.lastIndexOf("/") + 1) : null;
}

function policyBindings(policy, what) {
  if (!isRecord(policy)) outputInvalid(what);
  const bindings = policy.bindings === undefined ? [] : array(policy.bindings, what);
  return bindings.flatMap((binding) => {
    if (!isRecord(binding) || typeof binding.role !== "string") outputInvalid(what);
    const members = array(binding.members ?? [], what);
    const condition = binding.condition === undefined || binding.condition === null ? null : {
      title: binding.condition.title ?? null,
      expression: binding.condition.expression ?? null,
    };
    return members.map((member) => {
      if (typeof member !== "string") outputInvalid(what);
      return { role: binding.role, member, condition };
    });
  }).sort(compareBinding);
}

function compareBinding(left, right) {
  return canonicalJson(left) < canonicalJson(right) ? -1 : canonicalJson(left) > canonicalJson(right) ? 1 : 0;
}

function sameCondition(left, right) {
  if (left === null || right === null) return left === right;
  return left.title === right.title && left.expression === right.expression;
}

function isPublicMember(member) {
  return member === "allUsers" || member === "allAuthenticatedUsers";
}

// ---------------------------------------------------------------------------
// Readback

function envMap(env) {
  return (Array.isArray(env) ? env : []).map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string") return { name: null };
    const secret = entry.valueFrom?.secretKeyRef;
    return isRecord(secret)
      ? { name: entry.name, secret: { name: secret.name ?? null, key: String(secret.key ?? "") } }
      : { name: entry.name, value: entry.value ?? "" };
  }).sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

/**
 * BUILD-SOURCE drift of the build-source bucket's builder, reader and public
 * bindings against the one desired binding, sorted and de-duplicated:
 * READER_BINDING_MISSING (no unconditional reader binding for the builder),
 * READER_BINDING_CONDITIONAL (a conditional one), BUILDER_ROLE_BROADER (the
 * builder holds any other role on the bucket), READER_EXTRA_MEMBER (any other
 * member holds the reader role; a public member is reported separately).
 */
function buildSourceDrift(desired, bindings) {
  const builder = desired.serviceAccounts.builder.member;
  const drift = new Set();
  if (!bindings.some((binding) => binding.member === builder && binding.role === BUILD_SOURCE_READER_ROLE
      && binding.condition === null)) {
    drift.add("READER_BINDING_MISSING");
  }
  for (const binding of bindings) {
    if (binding.member === builder && binding.role !== BUILD_SOURCE_READER_ROLE) drift.add("BUILDER_ROLE_BROADER");
    else if (binding.member === builder && binding.condition !== null) drift.add("READER_BINDING_CONDITIONAL");
    else if (binding.member !== builder && !isPublicMember(binding.member)) drift.add("READER_EXTRA_MEMBER");
  }
  return [...drift].sort();
}

/** The managed fields of a Knative Service, live or rendered. */
export function serviceView(service) {
  const annotations = service?.metadata?.annotations ?? {};
  const template = service?.spec?.template ?? {};
  const scaling = template.metadata?.annotations ?? {};
  const revision = template.spec ?? {};
  const containers = Array.isArray(revision.containers) ? revision.containers : [];
  const container = containers[0] ?? {};
  let audiences = null;
  try { audiences = JSON.parse(annotations["run.googleapis.com/custom-audiences"] ?? "null"); } catch { audiences = null; }
  return {
    name: service?.metadata?.name ?? null,
    ingress: annotations["run.googleapis.com/ingress"] ?? null,
    invokerIamDisabled: annotations["run.googleapis.com/invoker-iam-disabled"] ?? "false",
    customAudiences: audiences,
    minScale: scaling["autoscaling.knative.dev/minScale"] ?? null,
    maxScale: scaling["autoscaling.knative.dev/maxScale"] ?? null,
    serviceAccountName: revision.serviceAccountName ?? null,
    containerConcurrency: Number(revision.containerConcurrency ?? Number.NaN),
    timeoutSeconds: Number(revision.timeoutSeconds ?? Number.NaN),
    containerCount: containers.length,
    image: container.image ?? null,
    ports: (Array.isArray(container.ports) ? container.ports : [])
      .map((port) => ({ name: port?.name ?? null, containerPort: Number(port?.containerPort) })),
    env: envMap(container.env),
    traffic: (Array.isArray(service?.spec?.traffic) ? service.spec.traffic : [])
      .map((entry) => ({ percent: Number(entry?.percent), latestRevision: entry?.latestRevision === true })),
  };
}

/** The managed fields of a Cloud Run Job, live or rendered. */
export function jobView(job) {
  const execution = job?.spec?.template?.spec ?? {};
  const task = execution.template?.spec ?? {};
  const containers = Array.isArray(task.containers) ? task.containers : [];
  const container = containers[0] ?? {};
  return {
    name: job?.metadata?.name ?? null,
    parallelism: Number(execution.parallelism ?? 1),
    taskCount: Number(execution.taskCount ?? 1),
    maxRetries: Number(task.maxRetries ?? 3),
    timeoutSeconds: String(task.timeoutSeconds ?? ""),
    serviceAccountName: task.serviceAccountName ?? null,
    containerCount: containers.length,
    image: container.image ?? null,
    command: Array.isArray(container.command) ? [...container.command] : [],
    args: Array.isArray(container.args) ? [...container.args] : [],
    env: envMap(container.env),
    cpu: String(container.resources?.limits?.cpu ?? ""),
    memory: String(container.resources?.limits?.memory ?? ""),
  };
}

/** The image digest and source commit a live service or job runs, when recognizable. */
function liveImage(desired, view) {
  const prefix = `${desired.artifactRegistry.imageRepository}@sha256:`;
  const digest = typeof view.image === "string" && view.image.startsWith(prefix)
    ? view.image.slice(prefix.length) : null;
  const commit = view.env.find((entry) => entry.name === "DEPLOYMENT_SOURCE_COMMIT")?.value ?? null;
  return {
    imageDigest: digest !== null && IMAGE_DIGEST.test(digest) ? digest : null,
    sourceCommit: typeof commit === "string" && SOURCE_COMMIT.test(commit) ? commit : null,
  };
}

function sqlInstanceView(instance) {
  const settings = instance?.settings ?? {};
  const backup = settings.backupConfiguration ?? {};
  return {
    name: instance?.name ?? null,
    instanceType: instance?.instanceType ?? "CLOUD_SQL_INSTANCE",
    region: instance?.region ?? null,
    databaseVersion: instance?.databaseVersion ?? null,
    edition: settings.edition ?? null,
    tier: settings.tier ?? null,
    availabilityType: settings.availabilityType ?? null,
    dataDiskType: settings.dataDiskType ?? null,
    dataDiskSizeGb: Number(settings.dataDiskSizeGb ?? Number.NaN),
    storageAutoResize: settings.storageAutoResize === true,
    deletionProtectionEnabled: settings.deletionProtectionEnabled === true,
    ipv4Enabled: settings.ipConfiguration?.ipv4Enabled === true,
    authorizedNetworks: Array.isArray(settings.ipConfiguration?.authorizedNetworks)
      ? settings.ipConfiguration.authorizedNetworks.length : 0,
    connectorEnforcement: settings.connectorEnforcement ?? "NOT_REQUIRED",
    queryInsightsEnabled: settings.insightsConfig?.queryInsightsEnabled === true,
    databaseFlags: (Array.isArray(settings.databaseFlags) ? settings.databaseFlags : [])
      .map((flag) => ({ name: flag?.name ?? null, value: String(flag?.value ?? "") }))
      .sort((left, right) => String(left.name).localeCompare(String(right.name))),
    backup: {
      enabled: backup.enabled === true,
      startTime: backup.startTime ?? null,
      location: backup.location ?? null,
      pointInTimeRecoveryEnabled: backup.pointInTimeRecoveryEnabled === true,
      transactionLogRetentionDays: Number(backup.transactionLogRetentionDays ?? Number.NaN),
      retentionUnit: backup.backupRetentionSettings?.retentionUnit ?? null,
      retainedBackups: Number(backup.backupRetentionSettings?.retainedBackups ?? Number.NaN),
      finalBackupEnabled: settings.finalBackupConfig?.enabled === true,
      finalBackupRetentionDays: Number(settings.finalBackupConfig?.retentionDays ?? Number.NaN),
      retainBackupsOnDelete: settings.retainBackupsOnDelete === true,
    },
  };
}

function bucketView(bucket) {
  return {
    name: bucket?.name ?? null,
    location: bucket?.location ?? null,
    storageClass: bucket?.storageClass ?? null,
    uniformBucketLevelAccess: bucket?.iamConfiguration?.uniformBucketLevelAccess?.enabled === true,
    publicAccessPrevention: bucket?.iamConfiguration?.publicAccessPrevention ?? null,
    // Cloud Storage omits the policy when soft delete is disabled.
    softDeleteRetentionDurationSeconds: String(bucket?.softDeletePolicy?.retentionDurationSeconds ?? "0"),
    versioningEnabled: bucket?.versioning?.enabled === true,
    lifecycleRules: Array.isArray(bucket?.lifecycle?.rule) ? bucket.lifecycle.rule.length : 0,
    retentionPolicy: bucket?.retentionPolicy !== undefined,
    generation: typeof bucket?.generation === "string" ? bucket.generation : String(bucket?.generation ?? ""),
    metageneration: typeof bucket?.metageneration === "string"
      ? bucket.metageneration : String(bucket?.metageneration ?? ""),
  };
}

function schedulerView(job) {
  const target = job?.httpTarget ?? {};
  return {
    name: tail(job?.name),
    schedule: job?.schedule ?? null,
    timeZone: job?.timeZone ?? null,
    uri: target.uri ?? null,
    httpMethod: target.httpMethod ?? null,
    serviceAccountEmail: target.oauthToken?.serviceAccountEmail ?? null,
    scope: target.oauthToken?.scope ?? null,
    retryCount: Number(job?.retryConfig?.retryCount ?? 0),
    overrides: target.body !== undefined || target.headers !== undefined,
  };
}

/**
 * Roles on the verifier account that let a principal act as it or mint its
 * tokens. Every binding of one on the verifier account's own policy is
 * managed: the committed tokenCreators are the whole set there, so a
 * hand-made grant on that policy is a delete apply refuses. The same roles
 * held on the project, a folder or the organization are not read.
 */
export const VERIFIER_IMPERSONATION_ROLES = Object.freeze([
  TOKEN_CREATOR_ROLE, "roles/iam.serviceAccountOpenIdTokenCreator", "roles/iam.serviceAccountUser",
]);

/**
 * Reads the live estate. Only describe, get-iam-policy and list calls are
 * made, each through the guard in read mode; the result holds no secret value
 * and no payload, only the managed fields of each resource. In a shared
 * project, co-tenant resources are not read into the result and project-wide
 * logging settings are not read at all.
 */
export function readbackInfrastructure(desired, { runner = defaultGcloudRunner } = {}) {
  const call = guardedGcloud(runner, { mode: "read", project: desired.project });
  const project = `--project=${desired.project}`;
  const region = desired.region;
  const json = "--format=json";
  const dedicated = desired.projectTenancy === "dedicated";
  // In a dedicated project every name is the plane's concern; in a shared
  // one only the plane's own names are.
  const planeNames = (names, managed) => (dedicated ? names : names.filter((name) => managed.includes(name)));
  const managedMembers = new Set(SERVICE_ACCOUNT_ROLES
    .map((role) => desired.serviceAccounts[role]?.member).filter(Boolean));
  const managedBindings = (policy, what) => policyBindings(policy, what)
    .filter((binding) => managedMembers.has(binding.member) || isPublicMember(binding.member));

  const accounts = array(call(["iam", "service-accounts", "list", project, json]), "service-accounts");
  const serviceAccounts = {};
  for (const role of SERVICE_ACCOUNT_ROLES) {
    const account = desired.serviceAccounts[role];
    if (account === null) continue;
    const live = accounts.find((entry) => isRecord(entry) && entry.email === account.email);
    serviceAccounts[role] = live === undefined ? null : { disabled: live.disabled === true };
  }

  // The operator's token-creator grant lives on the verifier account itself.
  const verifier = desired.serviceAccounts.verifier;
  let verifierPolicy = null;
  if (verifier !== null && serviceAccounts.verifier !== null) {
    const creators = new Set(verifier.tokenCreators ?? []);
    verifierPolicy = policyBindings(call(["iam", "service-accounts", "get-iam-policy", verifier.email, project, json]),
      "verifier-policy").filter((binding) => VERIFIER_IMPERSONATION_ROLES.includes(binding.role)
      || managedMembers.has(binding.member) || creators.has(binding.member) || isPublicMember(binding.member));
  }

  const roles = array(call(["iam", "roles", "list", project, "--show-deleted", json]), "roles");
  const roleEntry = roles.find((entry) => isRecord(entry) && entry.name === desired.customRole.name);
  let customRole = null;
  if (roleEntry !== undefined) {
    const described = call(["iam", "roles", "describe", desired.customRole.id, project, json]);
    if (!isRecord(described)) outputInvalid("roles-describe");
    customRole = {
      deleted: described.deleted === true,
      stage: CUSTOM_ROLE_STAGES.includes(described.stage) ? described.stage : "UNRECOGNIZED",
      permissions: array(described.includedPermissions ?? [], "roles-describe").map(String).sort(),
    };
  }

  const projectPolicy = call(["projects", "get-iam-policy", desired.project, project, json]);
  const auditConfigs = Array.isArray(projectPolicy?.auditConfigs) ? projectPolicy.auditConfigs : [];
  // Project-wide: managed only in a dedicated project.
  const dataAccessAudit = !dedicated ? null : auditConfigs
    .filter((config) => isRecord(config)
      && ["allServices", ...LOGGING_POSTURE.dataAccessAuditOffServices].includes(config.service))
    .flatMap((config) => (Array.isArray(config.auditLogConfigs) ? config.auditLogConfigs : [])
      .filter((entry) => entry?.logType === "DATA_READ" || entry?.logType === "DATA_WRITE")
      .map((entry) => `${config.service}:${entry.logType}`))
    .sort();

  const repositories = array(call(["artifacts", "repositories", "list", project, `--location=${region}`, json]),
    "repositories");
  const repositoryEntry = repositories.find((entry) => isRecord(entry)
    && tail(entry.name) === desired.artifactRegistry.repository);
  let repository = null;
  if (repositoryEntry !== undefined) {
    repository = {
      format: repositoryEntry.format ?? null,
      immutableTags: repositoryEntry.dockerConfig?.immutableTags === true,
      bindings: managedBindings(call(["artifacts", "repositories", "get-iam-policy",
        desired.artifactRegistry.repository, project, `--location=${region}`, json]), "repository-policy"),
    };
  }

  const secretList = array(call(["secrets", "list", project, json]), "secrets");
  const secrets = {};
  for (const [name, { secretName }] of Object.entries(desired.secrets)) {
    const entry = secretList.find((secret) => isRecord(secret) && tail(secret.name) === secretName);
    if (entry === undefined) {
      secrets[name] = null;
      continue;
    }
    const replicas = entry.replication?.userManaged?.replicas;
    const versions = array(call(["secrets", "versions", "list", secretName, project, json]), "secret-versions");
    secrets[name] = {
      replication: Array.isArray(replicas)
        ? `user-managed:${replicas.map((replica) => replica?.location).sort().join(",")}`
        : isRecord(entry.replication?.automatic) ? "automatic" : "unknown",
      versions: Object.fromEntries(versions.filter(isRecord)
        .map((version) => [tail(version.name), version.state ?? "UNKNOWN"])
        .sort(([left], [right]) => left.localeCompare(right))),
      bindings: managedBindings(call(["secrets", "get-iam-policy", secretName, project, json]), "secret-policy"),
    };
  }

  const instances = array(call(["sql", "instances", "list", project, json]), "sql-instances");
  const instanceNames = planeNames(instances.map((instance) => instance?.name)
    .filter((name) => typeof name === "string").sort(), [desired.cloudSql.instance]);
  const instanceEntry = instances.find((instance) => instance?.name === desired.cloudSql.instance);
  let cloudSql = null;
  if (instanceEntry !== undefined) {
    const databases = array(call(["sql", "databases", "list", `--instance=${desired.cloudSql.instance}`,
      project, json]), "sql-databases");
    const users = array(call(["sql", "users", "list", `--instance=${desired.cloudSql.instance}`, project, json]),
      "sql-users");
    cloudSql = {
      instance: sqlInstanceView(instanceEntry),
      databases: databases.map((database) => database?.name).filter((name) => typeof name === "string").sort(),
      users: users.filter(isRecord).map((user) => ({ name: user.name ?? null, type: user.type ?? null }))
        .sort((left, right) => String(left.name).localeCompare(String(right.name))),
    };
  }

  const buckets = array(call(["storage", "buckets", "list", project, "--raw", json]), "buckets");
  const bucketEntry = buckets.find((bucket) => isRecord(bucket) && bucket.name === desired.bucket.name);
  let bucket = null;
  if (bucketEntry !== undefined) {
    const policy = call(["storage", "buckets", "get-iam-policy", `gs://${desired.bucket.name}`, project, json]);
    bucket = {
      ...bucketView(bucketEntry),
      publicMember: policyBindings(policy, "bucket-policy").some((binding) => isPublicMember(binding.member)),
    };
  }

  // BUILD-SOURCE: the project's default Cloud Build bucket, from the same listing.
  const buildSourceEntry = buckets.find((entry) => isRecord(entry) && entry.name === desired.buildSource.bucket);
  let buildSource = null;
  if (buildSourceEntry !== undefined) {
    const owned = String(buildSourceEntry.projectNumber ?? "") === desired.projectNumber;
    buildSource = {
      owned,
      location: buildSourceEntry.location ?? null,
      uniformBucketLevelAccess: buildSourceEntry.iamConfiguration?.uniformBucketLevelAccess?.enabled === true,
      publicAccessPrevention: buildSourceEntry.iamConfiguration?.publicAccessPrevention ?? null,
      bindings: null,
      publicMember: null,
      drift: null,
    };
    // Another project's bucket is never read further or bound on.
    if (owned) {
      const all = policyBindings(call(["storage", "buckets", "get-iam-policy", `gs://${desired.buildSource.bucket}`,
        project, json]), "build-source-bucket-policy");
      buildSource.bindings = all.filter((binding) => binding.member === desired.serviceAccounts.builder.member
        || binding.role === BUILD_SOURCE_READER_ROLE || isPublicMember(binding.member));
      buildSource.publicMember = all.some((binding) => isPublicMember(binding.member));
      buildSource.drift = buildSourceDrift(desired, buildSource.bindings);
    }
  }

  let logging = null;
  if (dedicated) {
    const sink = call(["logging", "sinks", "describe", "_Default", project, json]);
    if (!isRecord(sink)) outputInvalid("logging-sink");
    const exclusion = (Array.isArray(sink.exclusions) ? sink.exclusions : [])
      .find((entry) => entry?.name === LOGGING_POSTURE.exclusionName);
    const logBucket = call(["logging", "buckets", "describe", "_Default", "--location=global", project, json]);
    if (!isRecord(logBucket)) outputInvalid("logging-bucket");
    logging = {
      exclusion: exclusion === undefined ? null : { filter: exclusion.filter ?? null, disabled: exclusion.disabled === true },
      retentionDays: Number(logBucket.retentionDays ?? 30),
    };
  }

  const services = array(call(["run", "services", "list", project, `--region=${region}`, json]), "run-services");
  const serviceNames = planeNames(services.map((entry) => entry?.metadata?.name)
    .filter((name) => typeof name === "string").sort(), [desired.service.name]);
  const serviceEntry = services.find((entry) => entry?.metadata?.name === desired.service.name);
  let service = null;
  if (serviceEntry !== undefined) {
    const view = serviceView(serviceEntry);
    service = {
      view,
      ...liveImage(desired, view),
      bindings: policyBindings(call(["run", "services", "get-iam-policy", desired.service.name, project,
        `--region=${region}`, json]), "service-policy"),
    };
  }

  const jobList = array(call(["run", "jobs", "list", project, `--region=${region}`, json]), "run-jobs");
  const jobNames = planeNames(jobList.map((entry) => entry?.metadata?.name)
    .filter((name) => typeof name === "string").sort(), JOB_NAMES.map((job) => desired.jobs[job].name));
  const jobs = {};
  for (const job of JOB_NAMES) {
    const entry = jobList.find((item) => item?.metadata?.name === desired.jobs[job].name);
    if (entry === undefined) {
      jobs[job] = null;
      continue;
    }
    const view = jobView(entry);
    jobs[job] = {
      view,
      ...liveImage(desired, view),
      bindings: policyBindings(call(["run", "jobs", "get-iam-policy", desired.jobs[job].name, project,
        `--region=${region}`, json]), "job-policy"),
    };
  }

  const triggers = array(call(["scheduler", "jobs", "list", project, `--location=${region}`, json]), "scheduler-jobs");
  const triggerNames = planeNames(triggers.map((entry) => tail(entry?.name))
    .filter((name) => typeof name === "string").sort(), SCHEDULED_JOB_NAMES.map((job) => desired.scheduler[job].name));
  const scheduler = {};
  for (const job of SCHEDULED_JOB_NAMES) {
    const entry = triggers.find((item) => tail(item?.name) === desired.scheduler[job].name);
    scheduler[job] = entry === undefined ? null : {
      ...schedulerView(entry),
      state: SCHEDULER_LIVE_STATES.includes(entry.state) ? entry.state : "UNRECOGNIZED",
    };
  }

  const findings = [];
  if (bucket === null) findings.push("BUCKET_ABSENT");
  if (desired.bucket.proof === null) findings.push("BUCKET_PROOF_UNPINNED");
  if (bucket !== null && desired.bucket.proof !== null
      && (bucket.generation !== desired.bucket.proof.bucketGeneration
        || bucket.metageneration !== desired.bucket.proof.bucketMetageneration)) {
    findings.push("BUCKET_PROOF_STALE");
  }
  if (bucket?.publicMember === true) findings.push("BUCKET_POLICY_PUBLIC_MEMBER");
  if (buildSource === null) findings.push(BUILD_SOURCE_BUCKET_ABSENT);
  else if (!buildSource.owned) findings.push("BUILD_SOURCE_BUCKET_FOREIGN");
  if (buildSource?.publicMember === true) findings.push("BUILD_SOURCE_BUCKET_POLICY_PUBLIC_MEMBER");
  if (buildSource?.drift?.some((entry) => entry !== "READER_BINDING_MISSING")) findings.push("BUILD_SOURCE_BUCKET_IAM_DRIFT");
  if (customRole?.deleted === true) findings.push("CUSTOM_ROLE_DELETED");
  if (customRole !== null && customRole.deleted !== true && customRole.stage !== "GA") {
    findings.push(customRole.stage === "DISABLED" ? "CUSTOM_ROLE_DISABLED" : "CUSTOM_ROLE_STAGE_NOT_GA");
  }
  for (const role of SERVICE_ACCOUNT_ROLES) {
    if (serviceAccounts[role]?.disabled === true) findings.push(`SERVICE_ACCOUNT_DISABLED:${role}`);
  }
  for (const job of SCHEDULED_JOB_NAMES) {
    const state = scheduler[job]?.state;
    if (state === undefined || state === null) continue;
    if (state === "ENABLED" && desired.scheduler[job].state === "PAUSED") {
      findings.push(`SCHEDULER_TRIGGER_ENABLED:${job}`);
    } else if (!SCHEDULER_TRIGGER_STATES.includes(state)) {
      findings.push(`SCHEDULER_TRIGGER_STATE_UNRECOGNIZED:${job}`);
    }
  }
  if (instanceNames.some((name) => name !== desired.cloudSql.instance)) findings.push("CLOUD_SQL_SECOND_INSTANCE");
  if (dataAccessAudit !== null && dataAccessAudit.length > 0) findings.push("DATA_ACCESS_AUDIT_ENABLED");
  if (verifierPolicy?.some((binding) => isPublicMember(binding.member))) findings.push("VERIFIER_POLICY_PUBLIC_MEMBER");

  return deepFreeze({
    schema: GCP_OPS_INFRA_READBACK_SCHEMA,
    project: desired.project,
    region,
    projectTenancy: desired.projectTenancy,
    observed: {
      serviceAccounts,
      verifierPolicy,
      customRole,
      projectBindings: managedBindings(projectPolicy, "project-policy"),
      dataAccessAudit,
      repository,
      secrets,
      cloudSql: { instanceNames, managed: cloudSql },
      bucket,
      buildSource,
      logging,
      service: { names: serviceNames, managed: service },
      jobs: { names: jobNames, managed: jobs },
      scheduler: { names: triggerNames, managed: scheduler },
    },
    findings: findings.sort(),
  });
}

// ---------------------------------------------------------------------------
// Plan

function operation(id, action, argv, extra = {}) {
  return { id, action, argv: [...argv], ...extra };
}

function fileOperation(id, action, argv, kind, content) {
  const text = `${JSON.stringify(content, null, 2)}\n`;
  return operation(id, action, argv, { file: { kind, sha256: sha256Hex(text), content: text } });
}

function bindingId(binding) {
  return `${binding.role}|${binding.member}|${binding.condition?.title ?? ""}`;
}

function conditionFlag(condition) {
  return condition === null ? "--condition=None"
    : `--condition=expression=${condition.expression},title=${condition.title}`;
}

/**
 * Bind every desired binding that is missing and delete (refused) every live
 * binding of a managed or public member that is not desired.
 */
function bindingOperations(family, desiredBindings, liveBindings, addArgv, removeArgv) {
  const operations = [];
  for (const binding of desiredBindings) {
    if (!liveBindings.some((live) => live.role === binding.role && live.member === binding.member
        && sameCondition(live.condition, binding.condition))) {
      operations.push(operation(`${family}:bind:${bindingId(binding)}`, "bind", addArgv(binding)));
    }
  }
  for (const live of liveBindings) {
    if (!desiredBindings.some((binding) => binding.role === live.role && binding.member === live.member
        && sameCondition(live.condition, binding.condition))) {
      operations.push(operation(`${family}:delete:${bindingId(live)}`, "delete", removeArgv(live)));
    }
  }
  return operations;
}

function serviceAccountOperations(desired, observed, blockers) {
  const operations = [];
  for (const role of SERVICE_ACCOUNT_ROLES) {
    const account = desired.serviceAccounts[role];
    if (account === null) continue;
    const live = observed.serviceAccounts[role];
    if (live === null) {
      operations.push(operation(`service-account:create:${role}`, "create", [
        "iam", "service-accounts", "create", account.accountId, `--project=${desired.project}`,
        `--display-name=TiboTattle ${role}`,
      ]));
    } else if (live.disabled) {
      // A disabled account was disabled on purpose (for example, to contain a
      // leaked edge-invoker key). Re-enabling it is the owner's decision.
      blockers.push(`SERVICE_ACCOUNT_DISABLED:${role}`);
    }
  }
  return operations;
}

/**
 * The operator's roles/iam.serviceAccountTokenCreator grant on the verifier
 * account (OD-CR-7), and no other impersonation grant on that account's own
 * policy. Deferred until the desired state names the operator; a live
 * impersonation grant on that policy the desired state does not name is a
 * delete apply refuses. Inherited grants (project, folder, organization) are
 * outside this check.
 */
function verifierIamOperations(desired, observed) {
  const verifier = desired.serviceAccounts.verifier;
  if (verifier === null) return [];
  const project = `--project=${desired.project}`;
  const add = (binding) => ["iam", "service-accounts", "add-iam-policy-binding", verifier.email, project,
    `--member=${binding.member}`, `--role=${binding.role}`];
  const remove = (binding) => ["iam", "service-accounts", "remove-iam-policy-binding", verifier.email, project,
    `--member=${binding.member}`, `--role=${binding.role}`];
  const live = observed.verifierPolicy;
  if (verifier.tokenCreators === null) {
    return [
      operation("verifier-iam:token-creator", "bind", ["iam", "service-accounts", "add-iam-policy-binding",
        verifier.email, project, `--role=${TOKEN_CREATOR_ROLE}`], { deferred: VERIFIER_TOKEN_CREATOR_DEFERRAL }),
      ...(live === null ? [] : bindingOperations("verifier-iam", [], live, add, remove)),
    ];
  }
  const desiredBindings = verifier.tokenCreators.map((member) => ({ role: TOKEN_CREATOR_ROLE, member, condition: null }));
  // An account this plan creates has no policy yet: bind after its create.
  if (live === null) {
    return desiredBindings.map((binding) => operation(`verifier-iam:bind:${bindingId(binding)}`, "bind", add(binding)));
  }
  return bindingOperations("verifier-iam", desiredBindings, live, add, remove);
}

function customRoleOperations(desired, observed, blockers) {
  const role = desired.customRole;
  const live = observed.customRole;
  const project = `--project=${desired.project}`;
  if (live === null) {
    return [operation("custom-role:create", "create", [
      "iam", "roles", "create", role.id, project, `--title=${QUARANTINE_STORE_ROLE_TITLE}`,
      `--description=${QUARANTINE_STORE_ROLE_DESCRIPTION}`, `--permissions=${role.permissions.join(",")}`,
      "--stage=GA",
    ])];
  }
  if (live.deleted) {
    blockers.push("CUSTOM_ROLE_DELETED");
    return [];
  }
  // Apply creates the role at GA and never changes a stage: any other stage
  // was set by hand (DISABLED withdraws the grant) and is the owner's call.
  if (live.stage !== "GA") blockers.push(live.stage === "DISABLED" ? "CUSTOM_ROLE_DISABLED" : "CUSTOM_ROLE_STAGE_NOT_GA");
  const operations = [];
  const missing = role.permissions.filter((permission) => !live.permissions.includes(permission));
  const extra = live.permissions.filter((permission) => !role.permissions.includes(permission));
  if (missing.length > 0) {
    operations.push(operation("custom-role:update", "update", [
      "iam", "roles", "update", role.id, project, `--add-permissions=${missing.join(",")}`,
    ]));
  }
  if (extra.length > 0) {
    // Narrowing a live role removes access: never done by apply.
    operations.push(operation("custom-role:destructive", "destructive", [
      "iam", "roles", "update", role.id, project, `--remove-permissions=${extra.join(",")}`,
    ]));
  }
  return operations;
}

function projectIamOperations(desired, observed) {
  const project = desired.project;
  const operations = bindingOperations("project-iam", desiredProjectBindings(desired), observed.projectBindings,
    (binding) => ["projects", "add-iam-policy-binding", project, `--project=${project}`,
      `--member=${binding.member}`, `--role=${binding.role}`, conditionFlag(binding.condition)],
    (binding) => ["projects", "remove-iam-policy-binding", project, `--project=${project}`,
      `--member=${binding.member}`, `--role=${binding.role}`, conditionFlag(binding.condition)]);
  if (observed.dataAccessAudit !== null && observed.dataAccessAudit.length > 0) {
    // Turning Data Access logs off needs a whole-policy replacement, which
    // this tooling never issues; the owner changes the audit config by hand.
    operations.push(operation("audit-config:destructive", "destructive", [
      "projects", "set-iam-policy", project, FILE_PLACEHOLDER, `--project=${project}`,
    ], { reason: observed.dataAccessAudit.join(",") }));
  }
  return operations;
}

function repositoryOperations(desired, observed) {
  const project = `--project=${desired.project}`;
  const location = `--location=${desired.region}`;
  const name = desired.artifactRegistry.repository;
  const live = observed.repository;
  const builderBinding = { role: ARTIFACT_WRITER_ROLE, member: desired.serviceAccounts.builder.member, condition: null };
  const operations = [];
  if (live === null) {
    operations.push(operation("artifact-registry:create", "create", [
      "artifacts", "repositories", "create", name, project, location, "--repository-format=docker",
      "--immutable-tags",
    ]));
    operations.push(operation(`artifact-registry-iam:bind:${bindingId(builderBinding)}`, "bind", [
      "artifacts", "repositories", "add-iam-policy-binding", name, project, location,
      `--member=${builderBinding.member}`, `--role=${builderBinding.role}`,
    ]));
    return operations;
  }
  if (live.format !== "DOCKER") {
    operations.push(operation("artifact-registry:destructive", "destructive", [
      "artifacts", "repositories", "delete", name, project, location,
    ], { reason: "format" }));
  } else if (!live.immutableTags) {
    operations.push(operation("artifact-registry:update", "update", [
      "artifacts", "repositories", "update", name, project, location, "--immutable-tags",
    ]));
  }
  operations.push(...bindingOperations("artifact-registry-iam", [builderBinding], live.bindings,
    (binding) => ["artifacts", "repositories", "add-iam-policy-binding", name, project, location,
      `--member=${binding.member}`, `--role=${binding.role}`],
    (binding) => ["artifacts", "repositories", "remove-iam-policy-binding", name, project, location,
      `--member=${binding.member}`, `--role=${binding.role}`]));
  return operations;
}

function secretOperations(desired, observed) {
  const project = `--project=${desired.project}`;
  const operations = [];
  const accessor = { role: SECRET_ACCESSOR_ROLE, member: desired.serviceAccounts.runtime.member, condition: null };
  // Operation ids name the variable; every argv names its Secret Manager id.
  for (const [name, { secretName }] of Object.entries(desired.secrets)) {
    const live = observed.secrets[name];
    const add = (binding) => ["secrets", "add-iam-policy-binding", secretName, project,
      `--member=${binding.member}`, `--role=${binding.role}`];
    if (live === null) {
      operations.push(operation(`secret:create:${name}`, "create", [
        "secrets", "create", secretName, project, "--replication-policy=user-managed", `--locations=${desired.region}`,
      ]));
      operations.push(operation(`secret-iam:${name}:bind:${bindingId(accessor)}`, "bind", add(accessor)));
      continue;
    }
    if (live.replication !== `user-managed:${desired.region}`) {
      operations.push(operation(`secret:destructive:${name}`, "destructive", [
        "secrets", "delete", secretName, project,
      ], { reason: "replication" }));
    }
    operations.push(...bindingOperations(`secret-iam:${name}`, [accessor], live.bindings, add,
      (binding) => ["secrets", "remove-iam-policy-binding", secretName, project,
        `--member=${binding.member}`, `--role=${binding.role}`]));
  }
  return operations;
}

/** Fields that drift on the instance: [field, desired, live, kind] with kind update or destructive. */
function sqlInstanceDrift(desired, live) {
  const backup = backupConfiguration(desired).expectedSettings;
  const expectedFlags = databaseFlags(desired).map(({ name, value }) => ({ name, value }));
  const drift = [];
  const check = (field, wanted, actual, kind) => {
    if (canonicalJson(wanted) !== canonicalJson(actual)) drift.push({ field, kind });
  };
  check("instanceType", "CLOUD_SQL_INSTANCE", live.instanceType, "destructive");
  check("region", desired.region, live.region, "destructive");
  check("databaseVersion", CLOUD_SQL_POSTURE.databaseVersion, live.databaseVersion, "destructive");
  check("edition", CLOUD_SQL_POSTURE.edition, live.edition, "destructive");
  check("dataDiskType", CLOUD_SQL_POSTURE.dataDiskType, live.dataDiskType, "destructive");
  check("tier", desired.cloudSql.tier, live.tier, "update");
  check("availabilityType", CLOUD_SQL_POSTURE.availabilityType, live.availabilityType, "update");
  // Storage only grows (auto-increase); a larger live disk is accepted.
  if (!(live.dataDiskSizeGb >= desired.cloudSql.storageSizeGb)) drift.push({ field: "dataDiskSizeGb", kind: "update" });
  check("storageAutoResize", true, live.storageAutoResize, "update");
  check("deletionProtectionEnabled", true, live.deletionProtectionEnabled, "update");
  check("ipv4Enabled", CLOUD_SQL_POSTURE.ipv4Enabled, live.ipv4Enabled, "update");
  // Clearing an authorized network removes an access path: by hand only.
  check("authorizedNetworks", 0, live.authorizedNetworks, "destructive");
  check("connectorEnforcement", CLOUD_SQL_POSTURE.connectorEnforcement, live.connectorEnforcement, "update");
  check("queryInsightsEnabled", CLOUD_SQL_POSTURE.queryInsightsEnabled, live.queryInsightsEnabled, "update");
  check("databaseFlags", expectedFlags, live.databaseFlags, "update");
  const config = backup.backupConfiguration;
  const liveBackup = live.backup;
  // Lowering a retention deletes copies already kept: by hand only.
  const retention = (field, wanted, actual) => {
    if (wanted === actual) return;
    drift.push({ field, kind: Number.isFinite(actual) && actual > wanted ? "destructive" : "update" });
  };
  retention("retainedBackups", config.backupRetentionSettings.retainedBackups, liveBackup.retainedBackups);
  retention("transactionLogRetentionDays", config.transactionLogRetentionDays, liveBackup.transactionLogRetentionDays);
  check("backup", {
    enabled: config.enabled,
    startTime: config.startTime,
    location: config.location,
    pointInTimeRecoveryEnabled: config.pointInTimeRecoveryEnabled,
    retentionUnit: config.backupRetentionSettings.retentionUnit,
    finalBackupEnabled: backup.finalBackupConfig.enabled,
    finalBackupRetentionDays: backup.finalBackupConfig.retentionDays,
    retainBackupsOnDelete: backup.retainBackupsOnDelete,
  }, {
    enabled: liveBackup.enabled,
    startTime: liveBackup.startTime,
    location: liveBackup.location,
    pointInTimeRecoveryEnabled: liveBackup.pointInTimeRecoveryEnabled,
    retentionUnit: liveBackup.retentionUnit,
    finalBackupEnabled: liveBackup.finalBackupEnabled,
    finalBackupRetentionDays: liveBackup.finalBackupRetentionDays,
    retainBackupsOnDelete: liveBackup.retainBackupsOnDelete,
  }, "update");
  return drift;
}

function sqlPatchFlags(desired, fields) {
  const backup = backupConfiguration(desired);
  const flags = [];
  const has = (field) => fields.includes(field);
  if (has("tier")) flags.push(`--tier=${desired.cloudSql.tier}`);
  if (has("availabilityType")) flags.push(`--availability-type=${CLOUD_SQL_POSTURE.availabilityType}`);
  if (has("dataDiskSizeGb")) flags.push(`--storage-size=${desired.cloudSql.storageSizeGb}GB`);
  if (has("storageAutoResize")) flags.push("--storage-auto-increase");
  if (has("deletionProtectionEnabled")) flags.push("--deletion-protection");
  if (has("ipv4Enabled")) flags.push("--assign-ip");
  if (has("connectorEnforcement")) flags.push(`--connector-enforcement=${CLOUD_SQL_POSTURE.connectorEnforcement}`);
  if (has("queryInsightsEnabled")) flags.push("--no-insights-config-query-insights-enabled");
  if (has("databaseFlags")) flags.push(databaseFlagsArgument(desired));
  if (has("backup") || has("retainedBackups") || has("transactionLogRetentionDays")) {
    flags.push(...backup.flags, ...backup.finalBackupFlags);
  }
  return flags;
}

function cloudSqlOperations(desired, observed) {
  const project = `--project=${desired.project}`;
  const instance = desired.cloudSql.instance;
  const operations = [];
  for (const name of observed.cloudSql.instanceNames) {
    // One instance only (D4): any other instance is a delete apply refuses.
    if (name !== instance) {
      operations.push(operation(`cloud-sql:delete:${name}`, "delete", ["sql", "instances", "delete", name, project]));
    }
  }
  const managed = observed.cloudSql.managed;
  const users = [
    ["runtime", desired.serviceAccounts.runtime.email, desired.cloudSql.runtimeIamUser],
    ["migrator", desired.serviceAccounts.migrator.email, desired.cloudSql.migratorIamUser],
  ];
  if (managed === null) {
    operations.push(operation("cloud-sql:create", "create", cloudSqlCreateArgs(desired)));
    operations.push(operation("cloud-sql-database:create", "create", [
      "sql", "databases", "create", desired.cloudSql.database, `--instance=${instance}`, project,
    ]));
    // A PostgreSQL IAM service-account user is named by the account email
    // WITHOUT ".gserviceaccount.com" (e.g. runtime@project.iam); Cloud SQL
    // refuses the full email.
    for (const [role, , iamUser] of users) {
      operations.push(operation(`cloud-sql-user:create:${role}`, "create", [
        "sql", "users", "create", iamUser, `--instance=${instance}`, project, "--type=cloud_iam_service_account",
      ]));
    }
    return operations;
  }
  const drift = sqlInstanceDrift(desired, managed.instance);
  const destructive = drift.filter((entry) => entry.kind === "destructive").map((entry) => entry.field);
  const updates = drift.filter((entry) => entry.kind === "update").map((entry) => entry.field);
  if (destructive.length > 0) {
    operations.push(operation("cloud-sql:destructive", "destructive", ["sql", "instances", "patch", instance, project],
      { reason: destructive.join(",") }));
  }
  if (updates.length > 0) {
    operations.push(operation("cloud-sql:update", "update", [
      "sql", "instances", "patch", instance, project, ...sqlPatchFlags(desired, updates), "--quiet",
    ], { reason: updates.join(",") }));
  }
  if (!managed.databases.includes(desired.cloudSql.database)) {
    operations.push(operation("cloud-sql-database:create", "create", [
      "sql", "databases", "create", desired.cloudSql.database, `--instance=${instance}`, project,
    ]));
  }
  for (const [role, email, iamUser] of users) {
    const live = managed.users.find((user) => user.name === iamUser || user.name === email);
    if (live === undefined) {
      operations.push(operation(`cloud-sql-user:create:${role}`, "create", [
        "sql", "users", "create", iamUser, `--instance=${instance}`, project, "--type=cloud_iam_service_account",
      ]));
    } else if (live.type !== "CLOUD_IAM_SERVICE_ACCOUNT") {
      operations.push(operation(`cloud-sql-user:destructive:${role}`, "destructive", [
        "sql", "users", "delete", iamUser, `--instance=${instance}`, project,
      ], { reason: "type" }));
    }
  }
  return operations;
}

function bucketOperations(desired, observed, blockers) {
  const live = observed.bucket;
  if (live === null) {
    blockers.push("BUCKET_ABSENT");
    return [];
  }
  if (live.publicMember) blockers.push("BUCKET_POLICY_PUBLIC_MEMBER");
  const drift = [];
  if (live.location !== desired.bucket.location) drift.push("location");
  for (const field of ["storageClass", "uniformBucketLevelAccess", "publicAccessPrevention",
    "softDeleteRetentionDurationSeconds", "versioningEnabled", "lifecycleRules", "retentionPolicy"]) {
    if (live[field] !== BUCKET_POSTURE[field]) drift.push(field);
  }
  if (drift.length === 0) return [];
  // The bucket is never updated by this tooling (its birth proof would go stale).
  return [operation("bucket:bucket-update", "bucket-update", [
    "storage", "buckets", "update", `gs://${desired.bucket.name}`, `--project=${desired.project}`,
  ], { reason: drift.join(",") })];
}

/**
 * BUILD-SOURCE: the builder's roles/storage.objectViewer binding on the
 * project's default Cloud Build bucket. An absent bucket is created
 * (buildSourceBucketCreateArgs) and its binding deferred
 * (BUILD_SOURCE_BUCKET_ABSENT) until a readback has listed it as the
 * project's own; another project's bucket blocks and is never bound on. On a
 * live bucket a missing binding is bound, and every other builder, reader or
 * public binding is a refused delete; a public member also blocks. The
 * bucket's metadata is never planned.
 */
function buildSourceOperations(desired, observed, blockers) {
  const url = `gs://${desired.buildSource.bucket}`;
  const project = `--project=${desired.project}`;
  const reader = buildSourceReaderBinding(desired);
  const add = (binding) => ["storage", "buckets", "add-iam-policy-binding", url, project,
    `--member=${binding.member}`, `--role=${binding.role}`];
  const remove = (binding) => ["storage", "buckets", "remove-iam-policy-binding", url, project,
    `--member=${binding.member}`, `--role=${binding.role}`];
  const live = observed.buildSource;
  if (live === null) {
    return [
      operation("build-source-bucket:create", "create", buildSourceBucketCreateArgs(desired)),
      operation(`build-source-bucket-iam:bind:${bindingId(reader)}`, "bind", add(reader),
        { deferred: BUILD_SOURCE_BUCKET_ABSENT }),
    ];
  }
  if (!live.owned) {
    blockers.push("BUILD_SOURCE_BUCKET_FOREIGN");
    return [];
  }
  if (live.publicMember) blockers.push("BUILD_SOURCE_BUCKET_POLICY_PUBLIC_MEMBER");
  return bindingOperations("build-source-bucket-iam", [reader], live.bindings, add, remove);
}

/**
 * Refuses a plan whose executable operations would mutate a bucket other than
 * the build-source bucket, or that bucket through any shape but its create
 * and its binding (PLAN_BUCKET_MUTATION_UNSCOPED). The guard holds the same
 * scope again on every call apply makes.
 */
export function assertBucketMutationsScoped(desired, operations) {
  for (const entry of operations) {
    if (entry.deferred !== undefined || !EXECUTABLE_ACTIONS.includes(entry.action)) continue;
    if (!positionalPath(entry.argv).startsWith("storage ")) continue;
    if (!scopedToBuildSource(entry.argv, desired.buildSource.bucket)) fail("PLAN_BUCKET_MUTATION_UNSCOPED");
  }
  return operations;
}

function loggingOperations(desired, observed) {
  // Project-wide settings: a shared project's are not this plane's to change.
  if (observed.logging === null) return [];
  const project = `--project=${desired.project}`;
  const operations = [];
  const exclusion = observed.logging.exclusion;
  const setting = `name=${LOGGING_POSTURE.exclusionName},filter=${LOGGING_POSTURE.exclusionFilter}`;
  if (exclusion === null) {
    operations.push(operation("logging-exclusion:create", "create", [
      "logging", "sinks", "update", "_Default", project, `--add-exclusion=${setting}`,
    ]));
  } else if (exclusion.filter !== LOGGING_POSTURE.exclusionFilter || exclusion.disabled) {
    operations.push(operation("logging-exclusion:update", "update", [
      "logging", "sinks", "update", "_Default", project, `--update-exclusion=${setting},disabled=false`,
    ]));
  }
  const days = observed.logging.retentionDays;
  if (days !== LOGGING_POSTURE.retentionDays) {
    const argv = ["logging", "buckets", "update", "_Default", "--location=global", project,
      `--retention-days=${LOGGING_POSTURE.retentionDays}`];
    // A shorter retention deletes stored logs: by hand only.
    operations.push(days > LOGGING_POSTURE.retentionDays
      ? operation("logging-bucket:destructive", "destructive", argv)
      : operation("logging-bucket:update", "update", argv));
  }
  return operations;
}

/** Why a service or job cannot be rendered yet, or null. */
function serviceDeferral(desired, observed) {
  // OD-2: the service renders the bucket's pinned birth proof
  // (GCS_QUARANTINE_BUCKET_HISTORY_PROOF), so an unborn or unpinned bucket
  // defers it; the plan also blocks on BUCKET_PROOF_UNPINNED.
  if (desired.bucket.proof === null) return "BUCKET_PROOF_UNPINNED";
  for (const [name, secret] of Object.entries(desired.secrets)) {
    if (secret.version === null) {
      if (secret.required) return `SECRET_VERSION_UNPINNED:${name}`;
      continue;
    }
    if (observed.secrets[name]?.versions?.[secret.version] !== "ENABLED") return `SECRET_VERSION_UNAVAILABLE:${name}`;
  }
  return null;
}

/**
 * Why a job cannot be rendered yet from what the desired state and the estate
 * hold, or null: its environment cannot have it, a namespace or the staging
 * plane's own values are unassigned (jobRenderBlocker), the bucket birth proof it reads is unpinned, or a secret
 * it reads has no pinned version or a version that is not enabled. A job that
 * reads none of these is never deferred here.
 */
function jobInputDeferral(desired, observed, job) {
  const blocker = jobRenderBlocker(desired, job);
  if (blocker !== null) return blocker;
  const definition = jobDefinition(desired, job);
  if (definition.env.includes("GCS_QUARANTINE_BUCKET_HISTORY_PROOF") && desired.bucket.proof === null) {
    return "BUCKET_PROOF_UNPINNED";
  }
  for (const name of jobSecretNames(desired, job)) {
    const secret = desired.secrets[name];
    if (secret.version === null) {
      if (secret.required) return `SECRET_VERSION_UNPINNED:${name}`;
      continue;
    }
    if (observed.secrets[name]?.versions?.[secret.version] !== "ENABLED") return `SECRET_VERSION_UNAVAILABLE:${name}`;
  }
  return null;
}

function runImage(live, bootstrap, label) {
  if (live === null) return bootstrap === null ? { deferred: "BOOTSTRAP_IMAGE_REQUIRED" } : { image: bootstrap };
  if (live.imageDigest === null) return { deferred: `${label}_LIVE_IMAGE_UNRECOGNIZED` };
  if (live.sourceCommit === null) return { deferred: `${label}_LIVE_SOURCE_COMMIT_UNRECOGNIZED` };
  return { image: { imageDigest: live.imageDigest, sourceCommit: live.sourceCommit } };
}

function serviceOperations(desired, observed, bootstrap, usage) {
  const project = `--project=${desired.project}`;
  const region = `--region=${desired.region}`;
  const operations = [];
  for (const name of observed.service.names) {
    if (name !== desired.service.name) {
      operations.push(operation(`run-service:delete:${name}`, "delete", ["run", "services", "delete", name, project, region]));
    }
  }
  const live = observed.service.managed;
  const replaceArgv = ["run", "services", "replace", FILE_PLACEHOLDER, project, region];
  const image = runImage(live, bootstrap, "SERVICE");
  const deferral = serviceRenderBlocker(desired) ?? image.deferred ?? serviceDeferral(desired, observed);
  if (live === null) usage.bootstrap = true;
  if (deferral !== null) {
    if (live === null) operations.push(operation("run-service:create", "create", replaceArgv, { deferred: deferral }));
    else operations.push(operation("run-service:update", "update", replaceArgv, { deferred: deferral }));
  } else {
    const rendered = renderService(desired, image.image);
    if (live === null) {
      operations.push(fileOperation("run-service:create", "create", replaceArgv, "service", rendered));
    } else if (canonicalJson(serviceView(rendered)) !== canonicalJson(live.view)) {
      operations.push(fileOperation("run-service:update", "update", replaceArgv, "service", rendered));
    }
  }
  const policy = renderEdgeIamPolicy(desired);
  const desiredBindings = policy.bindings.flatMap((binding) => binding.members
    .map((member) => ({ role: binding.role, member, condition: null })));
  const add = (binding) => ["run", "services", "add-iam-policy-binding", desired.service.name, project, region,
    `--member=${binding.member}`, `--role=${binding.role}`];
  if (live === null) {
    for (const binding of desiredBindings) {
      operations.push(operation(`run-service-iam:bind:${bindingId(binding)}`, "bind", add(binding),
        deferral === null ? {} : { deferred: deferral }));
    }
  } else {
    operations.push(...bindingOperations("run-service-iam", desiredBindings, live.bindings, add,
      (binding) => ["run", "services", "remove-iam-policy-binding", desired.service.name, project, region,
        `--member=${binding.member}`, `--role=${binding.role}`]));
  }
  // The edge invoker and verifier hold no project role (EP-7's IAM
  // template): desiredProjectBindings gives them none, so any live project
  // binding of theirs is already a refused delete in the project-iam family.
  for (const member of Object.keys(policy.projectRoles)) {
    if (desiredProjectBindings(desired).some((binding) => binding.member === member)) {
      fail("EDGE_INVOKER_PROJECT_ROLE_FORBIDDEN");
    }
  }
  return operations;
}

/**
 * The Cloud Run Jobs, and their IAM. A scheduled job's run.jobsExecutor
 * binds for the scheduler account are returned apart (executorBinds), for
 * the scheduler family to issue after its trigger's create and pause.
 */
function jobOperations(desired, observed, bootstrap, usage, jobDeferrals, executorBinds) {
  const project = `--project=${desired.project}`;
  const region = `--region=${desired.region}`;
  const operations = [];
  const managedNames = JOB_NAMES.map((job) => desired.jobs[job].name);
  for (const name of observed.jobs.names) {
    if (!managedNames.includes(name)) {
      operations.push(operation(`run-job:delete:${name}`, "delete", ["run", "jobs", "delete", name, project, region]));
    }
  }
  for (const job of JOB_NAMES) {
    const live = observed.jobs.managed[job];
    const replaceArgv = ["run", "jobs", "replace", FILE_PLACEHOLDER, project, region];
    // A deferred job is never created (DEFERRED_JOBS); one that already exists
    // is kept as it is, like any managed job.
    const jobDeferral = live === null ? jobDeferrals[job] : undefined;
    const image = jobDeferral === undefined ? runImage(live, bootstrap, "JOB") : { deferred: jobDeferral };
    if (live === null && jobDeferral === undefined) usage.bootstrap = true;
    // Inputs the desired state or the estate does not hold yet (jobInputDeferral)
    // defer the create or update, like the service's own. A job its environment
    // cannot have (or whose namespace is unassigned) never asks for an image.
    const inputs = jobDeferral === undefined ? jobInputDeferral(desired, observed, job) : null;
    const blocked = inputs !== null && jobRenderBlocker(desired, job) === inputs ? inputs : null;
    const deferral = blocked ?? image.deferred ?? inputs ?? null;
    if (deferral !== null) {
      operations.push(operation(`run-job:${live === null ? "create" : "update"}:${job}`,
        live === null ? "create" : "update", replaceArgv, { deferred: deferral }));
    } else {
      const rendered = renderJob(desired, job, image.image);
      if (live === null) {
        operations.push(fileOperation(`run-job:create:${job}`, "create", replaceArgv, "job", rendered));
      } else if (canonicalJson(jobView(rendered)) !== canonicalJson(live.view)) {
        operations.push(fileOperation(`run-job:update:${job}`, "update", replaceArgv, "job", rendered));
      }
    }
    const desiredBindings = SCHEDULED_JOB_NAMES.includes(job)
      ? [{ role: JOBS_EXECUTOR_ROLE, member: desired.serviceAccounts.scheduler.member, condition: null }]
      : [];
    const add = (binding) => ["run", "jobs", "add-iam-policy-binding", desired.jobs[job].name, project, region,
      `--member=${binding.member}`, `--role=${binding.role}`];
    const iam = live === null
      ? desiredBindings.map((binding) => operation(`run-job-iam:${job}:bind:${bindingId(binding)}`, "bind", add(binding),
        deferral === null ? {} : { deferred: deferral }))
      : bindingOperations(`run-job-iam:${job}`, desiredBindings, live.bindings, add,
        (binding) => ["run", "jobs", "remove-iam-policy-binding", desired.jobs[job].name, project, region,
          `--member=${binding.member}`, `--role=${binding.role}`]);
    if (SCHEDULED_JOB_NAMES.includes(job)) {
      // With no committed cadence no trigger is created, so nothing needs the
      // grant yet. Withholding it keeps the scheduler account unable to run
      // the job until the plan that creates and pauses the trigger, whose
      // grant follows the pause. A grant that is already live is left alone
      // and blocks that create (triggerOperations).
      const withheld = desired.scheduler[job].schedule === null ? { deferred: SCHEDULER_CADENCE_DEFERRAL } : {};
      executorBinds[job] = iam.filter((entry) => entry.action === "bind").map((entry) => ({ ...withheld, ...entry }));
      operations.push(...iam.filter((entry) => entry.action !== "bind"));
    } else {
      operations.push(...iam);
    }
  }
  return operations;
}

/**
 * The trigger holds: for each job that is not live yet, why its trigger is not
 * created either. A registry deferral (DEFERRED_JOBS) and a job input
 * deferral hold it; a missing bootstrap image does not (the trigger is created
 * paused and cannot start a job it has no executor binding on).
 */
function triggerHolds(desired, observed, jobDeferrals) {
  const holds = {};
  for (const job of SCHEDULED_JOB_NAMES) {
    if (observed.jobs.managed[job] !== null) continue;
    const reason = jobDeferrals[job] ?? jobInputDeferral(desired, observed, job);
    if (reason !== null) holds[job] = reason;
  }
  return holds;
}

function schedulerOperations(desired, observed, blockers, holds, executorBinds) {
  const project = `--project=${desired.project}`;
  const location = `--location=${desired.region}`;
  const operations = [];
  const managedNames = SCHEDULED_JOB_NAMES.map((job) => desired.scheduler[job].name);
  for (const name of observed.scheduler.names) {
    if (!managedNames.includes(name)) {
      operations.push(operation(`scheduler:delete:${name}`, "delete", ["scheduler", "jobs", "delete", name, project, location]));
    }
  }
  for (const job of SCHEDULED_JOB_NAMES) {
    operations.push(...triggerOperations(desired, observed, blockers, holds, job));
    // Only now may the scheduler account run the job: a trigger whose pause
    // failed above is ENABLED but cannot start it.
    operations.push(...(executorBinds[job] ?? []));
  }
  return operations;
}

/** One trigger's operations: create then pause, pause, deferred resume or update. */
function triggerOperations(desired, observed, blockers, holds, job) {
  const project = `--project=${desired.project}`;
  const location = `--location=${desired.region}`;
  const trigger = desired.scheduler[job];
  const live = observed.scheduler.managed[job];
  if (trigger.schedule === null) {
    // No cadence until the owner supplies one (decision D3): nothing is
    // created, and a live trigger is drift that only the owner removes.
    return [live === null
      ? operation(`scheduler:create:${job}`, "create", ["scheduler", "jobs", "create", "http", trigger.name, project,
        location], { deferred: SCHEDULER_CADENCE_DEFERRAL })
      : operation(`scheduler:delete:${trigger.name}`, "delete", ["scheduler", "jobs", "delete", trigger.name, project,
        location])];
  }
  const flags = schedulerFlags(desired, job);
  const pause = operation(`scheduler:pause:${job}`, "update",
    ["scheduler", "jobs", "pause", trigger.name, project, location]);
  if (live === null) {
    if (holds[job] !== undefined) {
      // No trigger for a job that is not created.
      return [operation(`scheduler:create:${job}`, "create",
        ["scheduler", "jobs", "create", "http", trigger.name, ...flags], { deferred: holds[job] })];
    }
    // Cloud Scheduler creates a trigger ENABLED; apply pauses it at once,
    // whatever the desired state, and never resumes it (OPS-3 does). Should
    // the pause fail, readback sees the ENABLED trigger and the next plan
    // pauses it again; meanwhile it cannot start the job, because the
    // scheduler account's run.jobsExecutor is bound only after this pause.
    // That holds only while the account holds no grant on the job yet: with
    // one already live (an estate bound before its trigger existed, or a
    // trigger removed by hand) the create blocks the plan until the owner
    // removes the grant, and the next plan grants it again after the pause.
    const granted = observed.jobs.managed[job]?.bindings
      .some((binding) => binding.member === desired.serviceAccounts.scheduler.member) ?? false;
    if (granted) blockers.push(`SCHEDULER_CREATE_EXECUTOR_BOUND:${job}`);
    return [operation(`scheduler:create:${job}`, "create",
      ["scheduler", "jobs", "create", "http", trigger.name, ...flags]), pause];
  }
  const operations = [];
  if (!SCHEDULER_TRIGGER_STATES.includes(live.state)) {
    // DISABLED (by the system), UPDATE_FAILED or unknown: by hand only.
    blockers.push(`SCHEDULER_TRIGGER_STATE_UNRECOGNIZED:${job}`);
  } else if (live.state === "ENABLED" && trigger.state === "PAUSED") {
    operations.push(pause);
  } else if (live.state === "PAUSED" && trigger.state === "ENABLED") {
    operations.push(operation(`scheduler:resume:${job}`, "update",
      ["scheduler", "jobs", "resume", trigger.name, project, location], { deferred: SCHEDULER_RESUME_DEFERRAL }));
  }
  const wanted = {
    name: trigger.name,
    schedule: trigger.schedule,
    timeZone: SCHEDULER_TIME_ZONE,
    uri: jobRunUri(desired, job),
    httpMethod: "POST",
    serviceAccountEmail: desired.serviceAccounts.scheduler.email,
    scope: SCHEDULER_OAUTH_SCOPE,
    retryCount: 0,
    overrides: false,
  };
  const { state: _state, ...view } = live;
  if (canonicalJson(wanted) !== canonicalJson(view)) {
    operations.push(operation(`scheduler:update:${job}`, "update",
      ["scheduler", "jobs", "update", "http", trigger.name, ...flags]));
  }
  return operations;
}

/**
 * The trigger state model as a plan invariant: every executable trigger
 * create is immediately followed by that trigger's executable pause, and no
 * run.jobsExecutor bind for a scheduled job precedes it. Anything else is
 * refused (SCHEDULER_CREATE_NOT_PAUSED) before a plan is returned.
 */
export function assertTriggersCreatedPaused(operations) {
  operations.forEach((entry, index) => {
    if (entry.deferred !== undefined || !/^scheduler:create:/u.test(entry.id)) return;
    const job = entry.id.slice("scheduler:create:".length);
    const next = operations[index + 1];
    if (next?.id !== `scheduler:pause:${job}` || next.deferred !== undefined) fail("SCHEDULER_CREATE_NOT_PAUSED");
    if (operations.slice(0, index).some((earlier) => earlier.deferred === undefined
        && earlier.id.startsWith(`run-job-iam:${job}:bind:`))) {
      fail("SCHEDULER_CREATE_NOT_PAUSED");
    }
  });
  return operations;
}

/** The bootstrap image for first creates: both fields, or neither. */
export function normalizeBootstrap(bootstrap) {
  if (bootstrap === undefined || bootstrap === null) return null;
  if (!isRecord(bootstrap) || Object.keys(bootstrap).sort().join() !== "imageDigest,sourceCommit"
      || !IMAGE_DIGEST.test(bootstrap.imageDigest ?? "") || !SOURCE_COMMIT.test(bootstrap.sourceCommit ?? "")) {
    fail("BOOTSTRAP_IMAGE_INVALID");
  }
  return Object.freeze({ imageDigest: bootstrap.imageDigest, sourceCommit: bootstrap.sourceCommit });
}

/**
 * The job deferrals a plan applies: DEFERRED_JOBS unless a check passes its
 * own map (only to exercise the path that applies once a deferral is lifted).
 */
export function normalizeJobDeferrals(jobDeferrals) {
  if (jobDeferrals === undefined) return DEFERRED_JOBS;
  if (jobDeferrals === null || typeof jobDeferrals !== "object" || Array.isArray(jobDeferrals)
      || Object.entries(jobDeferrals).some(([job, reason]) => !JOB_NAMES.includes(job)
        || typeof reason !== "string" || !/^[A-Z][A-Z0-9_]{0,95}$/u.test(reason))) {
    fail("JOB_DEFERRALS_INVALID");
  }
  return Object.freeze({ ...jobDeferrals });
}

/**
 * OPS-10's `readback --require-clean` verdict on a plan: clean only when it
 * holds no finding, no blocker, no executable or refused operation, and no
 * deferral outside CLEAN_DEFERRALS. Reasons are closed codes and operation ids.
 * With requireCadence (`--require-cadence`, the cutover's scheduler gate) the
 * unset cadence is no longer a clean deferral: a committed cadence, and the
 * trigger created paused under it, are what the estate must hold.
 */
export function infrastructureCleanliness(plan, { requireCadence = false } = {}) {
  if (typeof requireCadence !== "boolean") fail("CLEANLINESS_OPTIONS_INVALID");
  const clean = (deferral) => CLEAN_DEFERRALS.includes(deferral)
    && !(requireCadence && deferral === SCHEDULER_CADENCE_DEFERRAL);
  const reasons = [
    ...plan.findings.map((finding) => `FINDING:${finding}`),
    ...plan.blockers.map((blocker) => `BLOCKER:${blocker}`),
    ...plan.operations.flatMap((entry) => {
      if (REFUSED_ACTIONS.includes(entry.action)) return [`REFUSED:${entry.id}`];
      if (entry.deferred === undefined) return [`EXECUTABLE:${entry.id}`];
      return clean(entry.deferred) ? [] : [`DEFERRED:${entry.id}:${entry.deferred}`];
    }),
  ];
  return deepFreeze({ clean: reasons.length === 0, reasons });
}

/** sha256 of the canonical JSON of a plan without its digest. */
export function planDigestOf(plan) {
  const { planDigest: _ignored, ...body } = plan;
  return sha256Hex(canonicalJson(body));
}

/**
 * The deterministic plan for a desired state and a readback. The same inputs
 * always give the same operations, in the same order, and the same planDigest.
 */
export function planInfrastructure(desired, readback, { bootstrap: rawBootstrap, jobDeferrals: rawDeferrals } = {}) {
  if (readback?.schema !== "tibotattle-gcp-ops-infra-readback-v1" || readback.project !== desired.project) {
    fail("PLAN_READBACK_INVALID");
  }
  const bootstrap = normalizeBootstrap(rawBootstrap);
  const jobDeferrals = normalizeJobDeferrals(rawDeferrals);
  const observed = readback.observed;
  const blockers = [];
  const usage = { bootstrap: false };
  const executorBinds = {};
  const operations = [
    ...serviceAccountOperations(desired, observed, blockers),
    ...verifierIamOperations(desired, observed),
    ...customRoleOperations(desired, observed, blockers),
    ...projectIamOperations(desired, observed),
    ...repositoryOperations(desired, observed),
    ...secretOperations(desired, observed),
    ...cloudSqlOperations(desired, observed),
    ...bucketOperations(desired, observed, blockers),
    ...buildSourceOperations(desired, observed, blockers),
    ...loggingOperations(desired, observed),
    ...serviceOperations(desired, observed, bootstrap, usage),
    ...jobOperations(desired, observed, bootstrap, usage, jobDeferrals, executorBinds),
    ...schedulerOperations(desired, observed, blockers, triggerHolds(desired, observed, jobDeferrals), executorBinds),
  ];
  assertTriggersCreatedPaused(operations);
  assertBucketMutationsScoped(desired, operations);
  if (bootstrap !== null && !usage.bootstrap) fail("BOOTSTRAP_IMAGE_UNUSED");
  if (desired.bucket.proof === null) blockers.push("BUCKET_PROOF_UNPINNED");
  const ids = operations.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) fail("PLAN_OPERATION_DUPLICATED");
  for (const entry of operations) {
    if (![...EXECUTABLE_ACTIONS, ...REFUSED_ACTIONS].includes(entry.action)) fail("PLAN_ACTION_INVALID");
    if (EXECUTABLE_ACTIONS.includes(entry.action) && entry.deferred === undefined
        && classifyGcloudCommand(entry.argv) !== "mutate") {
      fail("PLAN_COMMAND_UNSANCTIONED");
    }
  }
  const plan = {
    schema: GCP_OPS_INFRA_PLAN_SCHEMA,
    environment: desired.environment,
    project: desired.project,
    region: desired.region,
    synthetic: desired.synthetic,
    desiredStateDigest: desiredStateDigest(desired),
    bootstrap,
    connectionBudget: desired.connectionBudget,
    findings: [...readback.findings],
    blockers: [...new Set(blockers)].sort(),
    operations,
    summary: {
      executable: operations.filter((entry) => EXECUTABLE_ACTIONS.includes(entry.action)
        && entry.deferred === undefined).length,
      deferred: operations.filter((entry) => entry.deferred !== undefined).length,
      refused: operations.filter((entry) => REFUSED_ACTIONS.includes(entry.action)).length,
    },
  };
  return deepFreeze({ ...plan, planDigest: planDigestOf(plan) });
}

// ---------------------------------------------------------------------------
// Apply

function defaultWriteSpec() {
  const directory = mkdtempSync(join(tmpdir(), "gcp-ops-infra-"));
  return {
    write(name, content) {
      const path = join(directory, name);
      writeFileSync(path, content, { mode: 0o600, flag: "wx" });
      return path;
    },
    close() { rmSync(directory, { recursive: true, force: true }); },
  };
}

/**
 * Re-reads the estate, recomputes the plan and runs its executable operations
 * only when its planDigest equals `authorize` and it holds nothing refused.
 * Returns a content-free receipt with each operation's outcome and the plan
 * computed from a fresh readback afterwards.
 */
export function applyInfrastructure(desired, {
  runner = defaultGcloudRunner,
  authorize,
  bootstrap,
  jobDeferrals,
  createSpecWriter = defaultWriteSpec,
} = {}) {
  if (desired.synthetic) fail("APPLY_SYNTHETIC_TARGET_REFUSED");
  if (authorize === undefined || authorize === null) fail("APPLY_AUTHORIZATION_REQUIRED");
  if (typeof authorize !== "string" || !DIGEST.test(authorize)) fail("APPLY_AUTHORIZATION_INVALID");
  if (desired.bucket.proof === null) fail("APPLY_BUCKET_PROOF_UNPINNED");
  const plan = planInfrastructure(desired, readbackInfrastructure(desired, { runner }), { bootstrap, jobDeferrals });
  if (plan.planDigest !== authorize) fail("APPLY_PLAN_DIGEST_MISMATCH");
  if (plan.findings.includes("BUCKET_PROOF_STALE")) fail("BUCKET_PROOF_STALE");
  if (plan.operations.some((entry) => entry.action === "delete")) fail("APPLY_DELETE_REFUSED");
  if (plan.operations.some((entry) => entry.action === "destructive")) fail("APPLY_DESTRUCTIVE_CHANGE_REFUSED");
  if (plan.operations.some((entry) => entry.action === "bucket-update")) fail("BUCKET_METADATA_UPDATE_REFUSED");
  if (plan.blockers.length > 0) fail("APPLY_BLOCKED");

  const call = guardedGcloud(runner, { mode: "apply", project: desired.project,
    buildSourceBucket: desired.buildSource.bucket });
  const outcomes = [];
  const writer = createSpecWriter();
  try {
    for (const entry of plan.operations) {
      if (entry.deferred !== undefined) {
        outcomes.push({ id: entry.id, outcome: "deferred", reason: entry.deferred });
        continue;
      }
      let argv = entry.argv;
      if (entry.file !== undefined) {
        const path = writer.write(`${entry.file.kind}-${entry.file.sha256.slice(0, 16)}.json`, entry.file.content);
        argv = argv.map((arg) => (arg === FILE_PLACEHOLDER ? path : arg));
      }
      if (argv.includes(FILE_PLACEHOLDER)) fail("APPLY_FILE_UNRESOLVED");
      try {
        call(argv);
      } catch (error) {
        outcomes.push({ id: entry.id, outcome: "failed" });
        throw Object.assign(new Error("APPLY_OPERATION_FAILED"), {
          code: "APPLY_OPERATION_FAILED",
          operation: entry.id,
          cause: error?.code,
          outcomes: deepFreeze([...outcomes]),
        });
      }
      outcomes.push({ id: entry.id, outcome: "applied" });
    }
  } finally {
    writer.close();
  }
  // Rollout state is never changed: a fresh plan shows what remains. The
  // bootstrap image is passed on only while something still needs it.
  const afterReadback = readbackInfrastructure(desired, { runner });
  let after;
  try {
    after = planInfrastructure(desired, afterReadback, { bootstrap, jobDeferrals });
  } catch (error) {
    if (error?.code !== "BOOTSTRAP_IMAGE_UNUSED") throw error;
    after = planInfrastructure(desired, afterReadback, { jobDeferrals });
  }
  return deepFreeze({
    schema: GCP_OPS_INFRA_APPLY_SCHEMA,
    project: desired.project,
    planDigest: plan.planDigest,
    outcomes,
    remaining: {
      planDigest: after.planDigest,
      executable: after.summary.executable,
      deferred: after.summary.deferred,
      refused: after.summary.refused,
    },
  });
}

// ---------------------------------------------------------------------------
// Scheduler probe: the paused-too-long signal

export const GCP_OPS_INFRA_SCHEDULER_PROBE_SCHEMA = "tibotattle-gcp-ops-infra-scheduler-probe-v1";
/** The probe's verdicts; those in SCHEDULER_PROBE_ALERTS raise the signal. */
export const SCHEDULER_PROBE_VERDICTS = Object.freeze([
  "running", "paused_as_desired", "paused_within_threshold", "paused_too_long", "paused_evidence_unavailable",
  "absent", "absent_not_created", "state_unrecognized",
]);
export const SCHEDULER_PROBE_ALERTS = Object.freeze([
  "paused_too_long", "paused_evidence_unavailable", "absent", "state_unrecognized",
]);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function instantMs(value) {
  if (typeof value !== "string" || !RFC3339.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One trigger's verdict. A trigger whose desired state is ENABLED (OPS-3 has
 * resumed it) and that is live PAUSED raises the signal once neither a user
 * change (pause, resume or update) nor an attempt is newer than the
 * threshold; with no usable timestamp it raises paused_evidence_unavailable
 * rather than guessing. A trigger desired PAUSED (before OPS-3 resumes it)
 * is paused by design. `live` is the Cloud Scheduler job, or null.
 */
export function schedulerPauseVerdict({ desiredState, live, nowMs,
  thresholdHours = SCHEDULER_PAUSE_ALERT_THRESHOLD_HOURS }) {
  if (!SCHEDULER_TRIGGER_STATES.includes(desiredState) || !Number.isSafeInteger(nowMs) || nowMs < 0
      || !Number.isSafeInteger(thresholdHours) || thresholdHours < 1 || thresholdHours > 168) {
    fail("SCHEDULER_PROBE_INPUT_INVALID");
  }
  const result = (liveState, verdict, quietMinutes = null) => Object.freeze({
    liveState, quietMinutes, verdict, alert: SCHEDULER_PROBE_ALERTS.includes(verdict),
  });
  if (live === null || live === undefined) return result(null, desiredState === "ENABLED" ? "absent" : "absent_not_created");
  const state = SCHEDULER_LIVE_STATES.includes(live.state) ? live.state : "UNRECOGNIZED";
  if (state === "ENABLED") return result(state, "running");
  if (state !== "PAUSED") return result(state, "state_unrecognized");
  if (desiredState === "PAUSED") return result(state, "paused_as_desired");
  const instants = [live.userUpdateTime, live.lastAttemptTime].map(instantMs).filter((ms) => ms !== null);
  const latest = instants.length === 0 ? null : Math.max(...instants);
  if (latest === null || latest > nowMs) return result(state, "paused_evidence_unavailable");
  const quietMinutes = Math.floor((nowMs - latest) / 60_000);
  return result(state, quietMinutes >= thresholdHours * 60 ? "paused_too_long" : "paused_within_threshold", quietMinutes);
}

/**
 * The scheduler probe: one read call (the location's scheduler jobs, through
 * the read guard) and a content-free verdict per managed trigger. `alert` is
 * true when any trigger raises the signal; the CLI then exits 2, so any
 * periodic runner can alert on the exit code.
 */
export function probeScheduler(desired, { runner = defaultGcloudRunner, now = () => Date.now(),
  thresholdHours = SCHEDULER_PAUSE_ALERT_THRESHOLD_HOURS } = {}) {
  const call = guardedGcloud(runner, { mode: "read", project: desired.project });
  const triggers = array(call(["scheduler", "jobs", "list", `--project=${desired.project}`,
    `--location=${desired.region}`, "--format=json"]), "scheduler-jobs");
  const nowMs = now();
  const results = SCHEDULED_JOB_NAMES.map((job) => {
    const name = desired.scheduler[job].name;
    const live = triggers.find((entry) => isRecord(entry) && tail(entry.name) === name) ?? null;
    return Object.freeze({ job, name, desiredState: desired.scheduler[job].state,
      ...schedulerPauseVerdict({ desiredState: desired.scheduler[job].state, live, nowMs, thresholdHours }) });
  });
  return deepFreeze({
    schema: GCP_OPS_INFRA_SCHEDULER_PROBE_SCHEMA,
    environment: desired.environment,
    project: desired.project,
    checkedAt: new Date(nowMs).toISOString(),
    thresholdHours,
    triggers: results,
    alert: results.some((entry) => entry.alert),
    signal: results.some((entry) => entry.verdict === "paused_too_long") ? "SCHEDULER_TRIGGER_PAUSED_TOO_LONG" : null,
  });
}

// ---------------------------------------------------------------------------
// OPS-3: pause-all and resume-all (D-OPS3)
//
// pause-all pauses every trigger of the plane, so OPS-10's
// ROLLOUT_JOBS_NOT_PAUSED gate (every Cloud Scheduler trigger in the region
// that runs a Cloud Run job is PAUSED, classified by
// gcp-scheduler-run-target.mjs as the rollout classifies it) can be met, and
// records which triggers it paused in a receipt, with each plane trigger's
// userUpdateTime and lastAttemptTime read back after the pauses. resume-all
// resumes only a managed trigger whose committed state is ENABLED, that is
// live PAUSED, and that either the operator names with --only (asserting
// that they paused it) or a pause-all receipt names as paused by that run,
// where the receipt is under PAUSE_ALL_RECEIPT_MAX_AGE_HOURS old and the
// trigger's live userUpdateTime and lastAttemptTime still equal the ones it
// recorded. A trigger someone paused on purpose stays paused, including one
// resumed and paused again (or one that ran) after pause-all
// (CHANGED_AFTER_PAUSE_ALL), and nothing committed PAUSED is ever resumed.
//
// The plane: in a dedicated project every trigger of the region; in a shared
// project (staging in the GCP test project) only the plane's managed triggers
// and any trigger that runs one of the plane's jobs. A co-tenant trigger is
// never paused or resumed; one that runs a Cloud Run job and is not PAUSED is
// a gate reason (the rollout reads it too), reported, never touched.
//
// Both are dry runs unless applied with the digest of the plan they print
// (--authorize); an applied run re-reads the region, re-plans, refuses a
// different digest or any blocker, then issues only `scheduler jobs pause`
// (pause-all) or `scheduler jobs resume` (resume-all) through the guard.

export const GCP_OPS_PAUSE_ALL_PLAN_SCHEMA = "tibotattle-gcp-ops-pause-all-plan-v1";
export const GCP_OPS_PAUSE_ALL_RECEIPT_SCHEMA = "tibotattle-gcp-ops-pause-all-receipt-v1";
export const GCP_OPS_RESUME_ALL_PLAN_SCHEMA = "tibotattle-gcp-ops-resume-all-plan-v1";
export const GCP_OPS_RESUME_ALL_RECEIPT_SCHEMA = "tibotattle-gcp-ops-resume-all-receipt-v1";
/** Why resume-all leaves a trigger as it is (closed). */
export const RESUME_SKIP_REASONS = Object.freeze([
  "STATE_UNRECOGNIZED", "COMMITTED_STATE_PAUSED", "TRIGGER_ABSENT", "ALREADY_ENABLED", "NOT_PAUSED_BY_PAUSE_ALL",
  "PAUSE_ALL_READBACK_MISSING", "CHANGED_AFTER_PAUSE_ALL", "NOT_SELECTED",
]);
/**
 * A pause-all receipt older than this is refused (PAUSE_ALL_RECEIPT_STALE);
 * the operator names the triggers with --only instead. A pausedAt more than
 * PAUSE_ALL_RECEIPT_CLOCK_SKEW_MINUTES ahead of now is invalid.
 */
export const PAUSE_ALL_RECEIPT_MAX_AGE_HOURS = 24;
export const PAUSE_ALL_RECEIPT_CLOCK_SKEW_MINUTES = 5;
const PAUSE_RECEIPT_KEYS = Object.freeze([
  "schema", "environment", "project", "region", "planDigest", "status", "pausedAt", "paused", "alreadyPaused",
  "failed", "triggers", "rolloutGate", "digest",
]);
const PAUSE_RECEIPT_TRIGGER_KEYS = Object.freeze(["name", "state", "userUpdateTime", "lastAttemptTime"]);
const PAUSE_RECEIPT_MAX_BYTES = 256 * 1024;
const TRIGGER_NAME = /^[A-Za-z0-9_-]{1,500}$/u;

function sortedNames(names) {
  return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** An RFC 3339 instant exactly as Cloud Scheduler gave it, or null when absent or malformed. */
function instantText(value) {
  return instantMs(value) === null ? null : value;
}

/**
 * The region's triggers as content-free views: name, live state, the Cloud
 * Run job each runs, and its userUpdateTime and lastAttemptTime (the
 * evidence resume-all compares with a pause-all receipt).
 */
function readTriggers(call, desired) {
  const entries = array(call(["scheduler", "jobs", "list", `--project=${desired.project}`,
    `--location=${desired.region}`, "--format=json"]), "scheduler-jobs");
  return entries.map((entry) => {
    const name = tail(entry?.name);
    if (typeof name !== "string" || !TRIGGER_NAME.test(name)) outputInvalid("scheduler-jobs");
    return Object.freeze({
      name,
      state: SCHEDULER_LIVE_STATES.includes(entry.state) ? entry.state : "UNRECOGNIZED",
      runJob: scheduledRunJob(entry),
      userUpdateTime: instantText(entry.userUpdateTime),
      lastAttemptTime: instantText(entry.lastAttemptTime),
    });
  }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function managedTriggers(desired) {
  return SCHEDULED_JOB_NAMES.map((job) => ({ job, ...desired.scheduler[job] }));
}

/** Whether a trigger belongs to the plane (see the section comment). */
function inPlane(desired, trigger) {
  if (desired.projectTenancy === "dedicated") return true;
  return managedTriggers(desired).some(({ name }) => name === trigger.name)
    || JOB_NAMES.some((job) => desired.jobs[job].name === trigger.runJob);
}

/**
 * OPS-10's gate over a set of trigger views: satisfied when every trigger
 * that runs a Cloud Run job is PAUSED (the rollout's rule, over the same
 * classifier). Running executions are the rollout's own second condition.
 */
export function rolloutTriggerGate(triggers) {
  const reasons = triggers.filter(({ runJob, state }) => runJob !== null && state !== "PAUSED")
    .map(({ name }) => `TRIGGER_NOT_PAUSED:${name}`);
  return deepFreeze({ satisfied: reasons.length === 0, reasons });
}

function digestOf(body) {
  return sha256Hex(canonicalJson(body));
}

/** The pause-all plan for a set of trigger views (pure; the digest covers everything but itself). */
export function pauseAllPlan(desired, triggers) {
  const plane = triggers.filter((trigger) => inPlane(desired, trigger));
  const foreign = triggers.filter((trigger) => !inPlane(desired, trigger));
  const blockers = plane.filter(({ state }) => !["ENABLED", "PAUSED"].includes(state))
    .map(({ name }) => `TRIGGER_STATE_UNRECOGNIZED:${name}`);
  const after = triggers.map((trigger) => (inPlane(desired, trigger) && trigger.state === "ENABLED"
    ? { ...trigger, state: "PAUSED" } : trigger));
  const gate = rolloutTriggerGate(after);
  const body = {
    schema: GCP_OPS_PAUSE_ALL_PLAN_SCHEMA,
    environment: desired.environment,
    project: desired.project,
    region: desired.region,
    triggers: plane.map(({ name, state, runJob }) => ({ name, state, runJob,
      action: state === "ENABLED" ? "pause" : "none" })),
    // A co-tenant trigger is named only when it keeps the rollout gate shut.
    foreignBlocking: foreign.filter(({ runJob, state }) => runJob !== null && state !== "PAUSED")
      .map(({ name, state }) => ({ name, state })),
    blockers,
    rolloutGateAfter: gate,
  };
  return deepFreeze({ ...body, planDigest: digestOf(body) });
}

/** Reads the region and plans pause-all; read calls only. */
export function planPauseAll(desired, { runner = defaultGcloudRunner } = {}) {
  return pauseAllPlan(desired, readTriggers(guardedGcloud(runner, { mode: "read", project: desired.project }), desired));
}

/**
 * Reserve a receipt file before anything changes: created exclusively,
 * owner-only, never through a symlink. Returns { write(value), release() }.
 */
export async function reserveOpsReceipt(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("OPS_RECEIPT_PATH_INVALID");
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | fsConstants.O_NOFOLLOW, 0o600);
  } catch {
    fail("OPS_RECEIPT_PATH_UNAVAILABLE");
  }
  let settled = false;
  return Object.freeze({
    async write(value) {
      if (settled) fail("OPS_RECEIPT_WRITE_FAILED");
      settled = true;
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
      } catch {
        try { await handle.close(); } catch { /* keep the original outcome */ }
        fail("OPS_RECEIPT_WRITE_FAILED");
      }
    },
    async release() {
      if (settled) return;
      settled = true;
      try { await handle.close(); } catch { /* only this run's own file */ }
      try { await unlink(path); } catch { /* only this run's own file */ }
    },
  });
}

function applyPreconditions(desired, authorize, code) {
  if (desired.synthetic) fail(`${code}_SYNTHETIC_TARGET_REFUSED`);
  if (authorize === undefined || authorize === null) fail(`${code}_AUTHORIZATION_REQUIRED`);
  if (typeof authorize !== "string" || !DIGEST.test(authorize)) fail(`${code}_AUTHORIZATION_INVALID`);
}

/**
 * pause-all, applied: re-read, re-plan, refuse a different digest or any
 * blocker, reserve the receipt, pause each ENABLED plane trigger in name
 * order, read back, and write the receipt. The receipt is written whatever
 * happens after the first pause (status "incomplete" with the trigger that
 * failed), so resume-all can resume what was paused; a run that ends with
 * a plane trigger not PAUSED fails PAUSE_ALL_INCOMPLETE after writing it.
 */
export async function applyPauseAll(desired, {
  runner = defaultGcloudRunner,
  authorize,
  receiptPath,
  now = () => Date.now(),
  reserveReceipt = reserveOpsReceipt,
} = {}) {
  applyPreconditions(desired, authorize, "PAUSE_ALL");
  if (typeof receiptPath !== "string" || !isAbsolute(receiptPath)) fail("PAUSE_ALL_RECEIPT_PATH_REQUIRED");
  const plan = planPauseAll(desired, { runner });
  if (plan.planDigest !== authorize) fail("PAUSE_ALL_PLAN_DIGEST_MISMATCH");
  if (plan.blockers.length > 0) fail("PAUSE_ALL_BLOCKED");
  const reservation = await reserveReceipt(receiptPath);
  const call = guardedGcloud(runner, { mode: "pause", project: desired.project });
  const paused = [];
  let failed = null;
  for (const trigger of plan.triggers.filter(({ action }) => action === "pause")) {
    try {
      call([...PAUSE_COMMAND.split(" "), trigger.name, `--project=${desired.project}`, `--location=${desired.region}`]);
      paused.push(trigger.name);
    } catch {
      failed = trigger.name;
      break;
    }
  }
  let after;
  try {
    after = readTriggers(guardedGcloud(runner, { mode: "read", project: desired.project }), desired);
  } catch {
    after = null;
  }
  const planeAfter = after === null ? null : after.filter((trigger) => inPlane(desired, trigger));
  const complete = failed === null && planeAfter !== null && planeAfter.every(({ state }) => state === "PAUSED");
  const body = {
    schema: GCP_OPS_PAUSE_ALL_RECEIPT_SCHEMA,
    environment: desired.environment,
    project: desired.project,
    region: desired.region,
    planDigest: plan.planDigest,
    status: complete ? "complete" : "incomplete",
    pausedAt: new Date(now()).toISOString(),
    paused: sortedNames(paused),
    alreadyPaused: sortedNames(plan.triggers.filter(({ state }) => state === "PAUSED").map(({ name }) => name)),
    failed,
    triggers: planeAfter === null ? null : planeAfter.map(({ name, state, userUpdateTime, lastAttemptTime }) => ({
      name, state, userUpdateTime, lastAttemptTime })),
    rolloutGate: after === null ? null : rolloutTriggerGate(after),
  };
  const receipt = deepFreeze({ ...body, digest: digestOf(body) });
  await reservation.write(receipt);
  if (!complete) {
    throw Object.assign(new Error("PAUSE_ALL_INCOMPLETE"), { code: "PAUSE_ALL_INCOMPLETE", receipt });
  }
  return receipt;
}

function receiptTriggerValid(entry) {
  return isRecord(entry) && Object.keys(entry).length === PAUSE_RECEIPT_TRIGGER_KEYS.length
    && PAUSE_RECEIPT_TRIGGER_KEYS.every((key) => Object.hasOwn(entry, key))
    && typeof entry.name === "string" && TRIGGER_NAME.test(entry.name)
    && (SCHEDULER_LIVE_STATES.includes(entry.state) || entry.state === "UNRECOGNIZED")
    && [entry.userUpdateTime, entry.lastAttemptTime].every((value) => value === null || instantText(value) === value);
}

/**
 * A pause-all receipt for this plane: structurally valid (closed keys, its
 * read-back triggers included), self-digested, and recent. A receipt whose
 * pausedAt is more than PAUSE_ALL_RECEIPT_MAX_AGE_HOURS before `nowMs` is
 * PAUSE_ALL_RECEIPT_STALE; one dated in the future is invalid.
 */
export function verifyPauseAllReceipt(receipt, desired, { nowMs = Date.now() } = {}) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("PAUSE_ALL_RECEIPT_CLOCK_INVALID");
  const ok = isRecord(receipt) && Object.keys(receipt).length === PAUSE_RECEIPT_KEYS.length
    && PAUSE_RECEIPT_KEYS.every((key) => Object.hasOwn(receipt, key))
    && receipt.schema === GCP_OPS_PAUSE_ALL_RECEIPT_SCHEMA
    && receipt.environment === desired.environment && receipt.project === desired.project
    && receipt.region === desired.region && DIGEST.test(receipt.planDigest ?? "")
    && ["complete", "incomplete"].includes(receipt.status)
    && typeof receipt.pausedAt === "string" && Number.isFinite(Date.parse(receipt.pausedAt))
    && [receipt.paused, receipt.alreadyPaused].every((names) => Array.isArray(names)
      && names.every((name) => typeof name === "string" && TRIGGER_NAME.test(name))
      && new Set(names).size === names.length)
    && (receipt.failed === null || (typeof receipt.failed === "string" && TRIGGER_NAME.test(receipt.failed)))
    && (receipt.triggers === null || (Array.isArray(receipt.triggers) && receipt.triggers.every(receiptTriggerValid)
      && new Set(receipt.triggers.map(({ name }) => name)).size === receipt.triggers.length))
    && receipt.digest === digestOf(Object.fromEntries(PAUSE_RECEIPT_KEYS.filter((key) => key !== "digest")
      .map((key) => [key, receipt[key]])));
  if (!ok) fail("PAUSE_ALL_RECEIPT_INVALID");
  const pausedAtMs = Date.parse(receipt.pausedAt);
  if (pausedAtMs > nowMs + PAUSE_ALL_RECEIPT_CLOCK_SKEW_MINUTES * 60_000) fail("PAUSE_ALL_RECEIPT_INVALID");
  if (nowMs - pausedAtMs > PAUSE_ALL_RECEIPT_MAX_AGE_HOURS * 3_600_000) fail("PAUSE_ALL_RECEIPT_STALE");
  return deepFreeze(structuredClone(receipt));
}

/**
 * The resume-all plan (pure). `pauseReceipt` is a verified pause-all receipt
 * or null; `only` the operator's ordered trigger names or null. One of them
 * is required. With `only`, exactly those triggers are resumed, in that
 * order, and each must be eligible (committed ENABLED, live PAUSED or already
 * ENABLED); without it, the receipt's paused triggers that are eligible, in
 * name order. A receipt-sourced trigger is resumed only while its live
 * userUpdateTime and lastAttemptTime equal those the receipt read back after
 * the pauses: a trigger resumed and paused again, updated, or run since then
 * is CHANGED_AFTER_PAUSE_ALL, and one the receipt has no read-back for is
 * PAUSE_ALL_READBACK_MISSING (the operator may still name it with --only).
 */
export function resumeAllPlan(desired, triggers, { pauseReceipt = null, only = null } = {}) {
  if (pauseReceipt === null && only === null) fail("RESUME_ALL_SOURCE_REQUIRED");
  const managed = managedTriggers(desired);
  if (only !== null && (!Array.isArray(only) || only.length === 0 || new Set(only).size !== only.length
      || only.some((name) => !managed.some((entry) => entry.name === name)))) {
    fail("RESUME_ALL_ONLY_INVALID");
  }
  const pausedByPauseAll = new Set(pauseReceipt?.paused ?? []);
  const blockers = [];
  const decisions = managed.map(({ job, name, state: committed }) => {
    const live = triggers.find((entry) => entry.name === name) ?? null;
    const decide = (action, reason = null) => ({ job, name, committedState: committed, liveState: live?.state ?? null,
      action, ...(reason === null ? {} : { reason }) });
    if (live !== null && !["ENABLED", "PAUSED"].includes(live.state)) {
      blockers.push(`TRIGGER_STATE_UNRECOGNIZED:${name}`);
      return decide("none", "STATE_UNRECOGNIZED");
    }
    if (committed !== "ENABLED") return decide("none", "COMMITTED_STATE_PAUSED");
    if (live === null) return decide("none", "TRIGGER_ABSENT");
    if (live.state === "ENABLED") return decide("none", "ALREADY_ENABLED");
    if (only !== null) return only.includes(name) ? decide("resume") : decide("none", "NOT_SELECTED");
    if (!pausedByPauseAll.has(name)) return decide("none", "NOT_PAUSED_BY_PAUSE_ALL");
    const recorded = pauseReceipt.triggers?.find((entry) => entry.name === name) ?? null;
    if (recorded === null || recorded.state !== "PAUSED") return decide("none", "PAUSE_ALL_READBACK_MISSING");
    if (recorded.userUpdateTime !== live.userUpdateTime || recorded.lastAttemptTime !== live.lastAttemptTime) {
      return decide("none", "CHANGED_AFTER_PAUSE_ALL");
    }
    return decide("resume");
  });
  if (only !== null) {
    for (const name of only) {
      const decision = decisions.find((entry) => entry.name === name);
      if (decision.action !== "resume" && decision.reason !== "ALREADY_ENABLED") {
        fail("RESUME_ALL_ONLY_INELIGIBLE");
      }
    }
  }
  const order = only ?? sortedNames(decisions.map(({ name }) => name));
  const resume = order.filter((name) => decisions.find((entry) => entry.name === name)?.action === "resume");
  const body = {
    schema: GCP_OPS_RESUME_ALL_PLAN_SCHEMA,
    environment: desired.environment,
    project: desired.project,
    region: desired.region,
    source: { pauseReceiptDigest: pauseReceipt?.digest ?? null, only },
    triggers: decisions,
    resume,
    blockers: sortedNames(new Set(blockers)),
  };
  return deepFreeze({ ...body, planDigest: digestOf(body) });
}

/** Reads the region and plans resume-all; read calls only. */
export function planResumeAll(desired, { runner = defaultGcloudRunner, pauseReceipt = null, only = null,
  now = () => Date.now() } = {}) {
  const receipt = pauseReceipt === null ? null : verifyPauseAllReceipt(pauseReceipt, desired, { nowMs: now() });
  const triggers = readTriggers(guardedGcloud(runner, { mode: "read", project: desired.project }), desired);
  return resumeAllPlan(desired, triggers, { pauseReceipt: receipt, only });
}

/**
 * resume-all, applied: re-read, re-plan, refuse a different digest or any
 * blocker, resume each planned trigger in plan order, read back, and return a
 * content-free receipt. A failed resume stops the run (RESUME_ALL_OPERATION_FAILED
 * with the outcomes so far); a trigger not ENABLED afterwards is RESUME_ALL_INCOMPLETE.
 */
export function applyResumeAll(desired, {
  runner = defaultGcloudRunner,
  authorize,
  pauseReceipt = null,
  only = null,
  now = () => Date.now(),
} = {}) {
  applyPreconditions(desired, authorize, "RESUME_ALL");
  const plan = planResumeAll(desired, { runner, pauseReceipt, only, now });
  if (plan.planDigest !== authorize) fail("RESUME_ALL_PLAN_DIGEST_MISMATCH");
  if (plan.blockers.length > 0) fail("RESUME_ALL_BLOCKED");
  const call = guardedGcloud(runner, { mode: "resume", project: desired.project });
  const outcomes = [];
  for (const name of plan.resume) {
    try {
      call([...RESUME_COMMANDS[0].split(" "), name, `--project=${desired.project}`, `--location=${desired.region}`]);
    } catch {
      outcomes.push({ name, outcome: "failed" });
      throw Object.assign(new Error("RESUME_ALL_OPERATION_FAILED"), {
        code: "RESUME_ALL_OPERATION_FAILED", operation: name, outcomes: deepFreeze([...outcomes]),
      });
    }
    outcomes.push({ name, outcome: "resumed" });
  }
  const after = readTriggers(guardedGcloud(runner, { mode: "read", project: desired.project }), desired);
  if (plan.resume.some((name) => after.find((entry) => entry.name === name)?.state !== "ENABLED")) {
    fail("RESUME_ALL_INCOMPLETE");
  }
  const body = {
    schema: GCP_OPS_RESUME_ALL_RECEIPT_SCHEMA,
    environment: desired.environment,
    project: desired.project,
    region: desired.region,
    planDigest: plan.planDigest,
    resumedAt: new Date(now()).toISOString(),
    outcomes,
  };
  return deepFreeze({ ...body, digest: digestOf(body) });
}
