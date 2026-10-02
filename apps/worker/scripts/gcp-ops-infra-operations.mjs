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
 * BUCKET_METADATA_UPDATE_REFUSED). No operation edits bucket IAM. An operation
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
 * resumes it). Readback reads it; a trigger that runs while PAUSED is desired
 * is a SCHEDULER_TRIGGER_ENABLED:<job> finding, and the plan pauses it, so a
 * create whose pause failed is paused by the next apply rather than reported
 * as converged (until then it runs, and OPS-10's require-clean preflight
 * refuses the estate). Apply never resumes: a paused trigger whose desired
 * state is ENABLED is a deferred resume (SCHEDULER_TRIGGER_RESUME_PENDING)
 * for OPS-3.
 * A state readback does not recognize is a blocker.
 *
 * infrastructureCleanliness(plan) is OPS-10's `readback --require-clean`
 * verdict: clean only with no finding, no blocker, nothing executable, nothing
 * refused, and no deferral outside CLEAN_DEFERRALS.
 *
 * The bucket is born only by gcp-ops-bucket-birth.mjs. Apply refuses until the
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  SECRET_ACCESSOR_ROLE,
  SERVICE_ACCOUNT_ROLES,
  backupConfiguration,
  cloudSqlCreateArgs,
  databaseFlags,
  databaseFlagsArgument,
  deepFreeze,
  desiredProjectBindings,
  desiredStateDigest,
  fail,
  jobRunUri,
  renderEdgeIamPolicy,
  renderJob,
  renderService,
  schedulerFlags,
  sha256Hex,
} from "./gcp-ops-infra-manifest.mjs";

export const GCP_OPS_INFRA_READBACK_SCHEMA = "tibotattle-gcp-ops-infra-readback-v1";
export const GCP_OPS_INFRA_PLAN_SCHEMA = "tibotattle-gcp-ops-infra-plan-v1";
export const GCP_OPS_INFRA_APPLY_SCHEMA = "tibotattle-gcp-ops-infra-apply-v1";

/** gcloud command shapes readback may issue (always with --format=json). */
export const READ_COMMANDS = Object.freeze([
  "iam service-accounts list",
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
/** Operation actions apply runs; every other action refuses the plan. */
export const EXECUTABLE_ACTIONS = Object.freeze(["create", "update", "bind"]);
export const REFUSED_ACTIONS = Object.freeze(["delete", "destructive", "bucket-update"]);
/** Cloud Scheduler job states readback reports; anything else is UNRECOGNIZED. */
export const SCHEDULER_LIVE_STATES = Object.freeze(["ENABLED", "PAUSED", "DISABLED", "UPDATE_FAILED"]);
/** IAM custom role stages readback reports; anything else is UNRECOGNIZED. */
export const CUSTOM_ROLE_STAGES = Object.freeze(["ALPHA", "BETA", "GA", "DEPRECATED", "DISABLED", "EAP"]);
/** The deferred resume of a paused trigger whose desired state is ENABLED (OPS-3 resumes). */
export const SCHEDULER_RESUME_DEFERRAL = "SCHEDULER_TRIGGER_RESUME_PENDING";
/**
 * Deferrals that leave the estate clean for OPS-10: an owner decision not yet
 * made (the D3 cadence), a job DEFERRED_JOBS names, and a resume OPS-3 owns.
 * Every other deferral (a bootstrap image, a secret version, an unrecognized
 * live image) means the estate is not yet what the desired state describes.
 */
export const CLEAN_DEFERRALS = Object.freeze([
  "SCHEDULER_CADENCE_UNSET",
  SCHEDULER_RESUME_DEFERRAL,
  ...new Set(Object.values(DEFERRED_JOBS)),
]);

const FILE_PLACEHOLDER = "${FILE}";
const GCLOUD_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;
const IMAGE_DIGEST = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** "read", "mutate" or null for one argv (without the gcloud binary). */
export function classifyGcloudCommand(argv) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) return null;
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) break;
    positional.push(arg);
  }
  const path = positional.join(" ");
  const matches = (shape) => path === shape || path.startsWith(`${shape} `);
  if (MUTATING_COMMANDS.some(matches)) return "mutate";
  if (READ_COMMANDS.some(matches)) return "read";
  return null;
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
 * Wraps a runner with the command guard. `mode` is "read" or "apply";
 * mutating shapes are refused unless the mode is "apply", and unknown shapes
 * are always refused. Failures never echo gcloud output.
 */
export function guardedGcloud(runner, { mode, project }) {
  if (typeof runner !== "function") fail("GCLOUD_RUNNER_INVALID");
  return function call(argv) {
    const kind = classifyGcloudCommand(argv);
    if (kind === null) fail("GCLOUD_COMMAND_FORBIDDEN");
    if (kind === "mutate" && mode !== "apply") fail("GCLOUD_MUTATION_UNAUTHORIZED");
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
    if (kind === "mutate") return null;
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
 * Reads the live estate. Only describe, get-iam-policy and list calls are
 * made, each through the guard in read mode; the result holds no secret value
 * and no payload, only the managed fields of each resource.
 */
export function readbackInfrastructure(desired, { runner = defaultGcloudRunner } = {}) {
  const call = guardedGcloud(runner, { mode: "read", project: desired.project });
  const project = `--project=${desired.project}`;
  const region = desired.region;
  const json = "--format=json";
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
  const dataAccessAudit = auditConfigs
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
  for (const name of Object.keys(desired.secrets)) {
    const entry = secretList.find((secret) => isRecord(secret) && tail(secret.name) === name);
    if (entry === undefined) {
      secrets[name] = null;
      continue;
    }
    const replicas = entry.replication?.userManaged?.replicas;
    const versions = array(call(["secrets", "versions", "list", name, project, json]), "secret-versions");
    secrets[name] = {
      replication: Array.isArray(replicas)
        ? `user-managed:${replicas.map((replica) => replica?.location).sort().join(",")}`
        : isRecord(entry.replication?.automatic) ? "automatic" : "unknown",
      versions: Object.fromEntries(versions.filter(isRecord)
        .map((version) => [tail(version.name), version.state ?? "UNKNOWN"])
        .sort(([left], [right]) => left.localeCompare(right))),
      bindings: managedBindings(call(["secrets", "get-iam-policy", name, project, json]), "secret-policy"),
    };
  }

  const instances = array(call(["sql", "instances", "list", project, json]), "sql-instances");
  const instanceNames = instances.map((instance) => instance?.name).filter((name) => typeof name === "string").sort();
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

  const sink = call(["logging", "sinks", "describe", "_Default", project, json]);
  if (!isRecord(sink)) outputInvalid("logging-sink");
  const exclusion = (Array.isArray(sink.exclusions) ? sink.exclusions : [])
    .find((entry) => entry?.name === LOGGING_POSTURE.exclusionName);
  const logBucket = call(["logging", "buckets", "describe", "_Default", "--location=global", project, json]);
  if (!isRecord(logBucket)) outputInvalid("logging-bucket");
  const logging = {
    exclusion: exclusion === undefined ? null : { filter: exclusion.filter ?? null, disabled: exclusion.disabled === true },
    retentionDays: Number(logBucket.retentionDays ?? 30),
  };

  const services = array(call(["run", "services", "list", project, `--region=${region}`, json]), "run-services");
  const serviceNames = services.map((entry) => entry?.metadata?.name).filter((name) => typeof name === "string").sort();
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
  const jobNames = jobList.map((entry) => entry?.metadata?.name).filter((name) => typeof name === "string").sort();
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
  const triggerNames = triggers.map((entry) => tail(entry?.name)).filter((name) => typeof name === "string").sort();
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
  if (dataAccessAudit.length > 0) findings.push("DATA_ACCESS_AUDIT_ENABLED");

  return deepFreeze({
    schema: GCP_OPS_INFRA_READBACK_SCHEMA,
    project: desired.project,
    region,
    observed: {
      serviceAccounts,
      customRole,
      projectBindings: managedBindings(projectPolicy, "project-policy"),
      dataAccessAudit,
      repository,
      secrets,
      cloudSql: { instanceNames, managed: cloudSql },
      bucket,
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
  if (observed.dataAccessAudit.length > 0) {
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
  for (const name of Object.keys(desired.secrets)) {
    const live = observed.secrets[name];
    const add = (binding) => ["secrets", "add-iam-policy-binding", name, project,
      `--member=${binding.member}`, `--role=${binding.role}`];
    if (live === null) {
      operations.push(operation(`secret:create:${name}`, "create", [
        "secrets", "create", name, project, "--replication-policy=user-managed", `--locations=${desired.region}`,
      ]));
      operations.push(operation(`secret-iam:${name}:bind:${bindingId(accessor)}`, "bind", add(accessor)));
      continue;
    }
    if (live.replication !== `user-managed:${desired.region}`) {
      operations.push(operation(`secret:destructive:${name}`, "destructive", [
        "secrets", "delete", name, project,
      ], { reason: "replication" }));
    }
    operations.push(...bindingOperations(`secret-iam:${name}`, [accessor], live.bindings, add,
      (binding) => ["secrets", "remove-iam-policy-binding", name, project,
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
    for (const [role, email] of users) {
      operations.push(operation(`cloud-sql-user:create:${role}`, "create", [
        "sql", "users", "create", email, `--instance=${instance}`, project, "--type=cloud_iam_service_account",
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
        "sql", "users", "create", email, `--instance=${instance}`, project, "--type=cloud_iam_service_account",
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

function loggingOperations(desired, observed) {
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
  for (const [name, secret] of Object.entries(desired.secrets)) {
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
  const deferral = image.deferred ?? serviceDeferral(desired, observed);
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

function jobOperations(desired, observed, bootstrap, usage, jobDeferrals) {
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
    if (image.deferred !== undefined) {
      operations.push(operation(`run-job:${live === null ? "create" : "update"}:${job}`,
        live === null ? "create" : "update", replaceArgv, { deferred: image.deferred }));
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
    if (live === null) {
      for (const binding of desiredBindings) {
        operations.push(operation(`run-job-iam:${job}:bind:${bindingId(binding)}`, "bind", add(binding),
          image.deferred === undefined ? {} : { deferred: image.deferred }));
      }
    } else {
      operations.push(...bindingOperations(`run-job-iam:${job}`, desiredBindings, live.bindings, add,
        (binding) => ["run", "jobs", "remove-iam-policy-binding", desired.jobs[job].name, project, region,
          `--member=${binding.member}`, `--role=${binding.role}`]));
    }
  }
  return operations;
}

function schedulerOperations(desired, observed, blockers, jobDeferrals) {
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
    const trigger = desired.scheduler[job];
    const live = observed.scheduler.managed[job];
    if (trigger.schedule === null) {
      // No cadence until the owner supplies one (decision D3): nothing is
      // created, and a live trigger is drift that only the owner removes.
      if (live === null) {
        operations.push(operation(`scheduler:create:${job}`, "create",
          ["scheduler", "jobs", "create", "http", trigger.name, project, location],
          { deferred: "SCHEDULER_CADENCE_UNSET" }));
      } else {
        operations.push(operation(`scheduler:delete:${trigger.name}`, "delete",
          ["scheduler", "jobs", "delete", trigger.name, project, location]));
      }
      continue;
    }
    const flags = schedulerFlags(desired, job);
    const pause = operation(`scheduler:pause:${job}`, "update",
      ["scheduler", "jobs", "pause", trigger.name, project, location]);
    if (live === null) {
      if (jobDeferrals[job] !== undefined && observed.jobs.managed[job] === null) {
        // No trigger for a job that is not created.
        operations.push(operation(`scheduler:create:${job}`, "create",
          ["scheduler", "jobs", "create", "http", trigger.name, ...flags], { deferred: jobDeferrals[job] }));
        continue;
      }
      // Cloud Scheduler creates a trigger ENABLED; apply pauses it at once and
      // never resumes it (OPS-3 does). Should the pause fail, readback sees the
      // ENABLED trigger and the next plan pauses it again.
      operations.push(operation(`scheduler:create:${job}`, "create",
        ["scheduler", "jobs", "create", "http", trigger.name, ...flags]));
      operations.push(pause);
      continue;
    }
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
  }
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
 */
export function infrastructureCleanliness(plan) {
  const reasons = [
    ...plan.findings.map((finding) => `FINDING:${finding}`),
    ...plan.blockers.map((blocker) => `BLOCKER:${blocker}`),
    ...plan.operations.flatMap((entry) => {
      if (REFUSED_ACTIONS.includes(entry.action)) return [`REFUSED:${entry.id}`];
      if (entry.deferred === undefined) return [`EXECUTABLE:${entry.id}`];
      return CLEAN_DEFERRALS.includes(entry.deferred) ? [] : [`DEFERRED:${entry.id}:${entry.deferred}`];
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
  const operations = [
    ...serviceAccountOperations(desired, observed, blockers),
    ...customRoleOperations(desired, observed, blockers),
    ...projectIamOperations(desired, observed),
    ...repositoryOperations(desired, observed),
    ...secretOperations(desired, observed),
    ...cloudSqlOperations(desired, observed),
    ...bucketOperations(desired, observed, blockers),
    ...loggingOperations(desired, observed),
    ...serviceOperations(desired, observed, bootstrap, usage),
    ...jobOperations(desired, observed, bootstrap, usage, jobDeferrals),
    ...schedulerOperations(desired, observed, blockers, jobDeferrals),
  ];
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

  const call = guardedGcloud(runner, { mode: "apply", project: desired.project });
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
