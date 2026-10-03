#!/usr/bin/env node

// OPS-10 rollout CLI (gcp-production-rollout.mjs) against an injected,
// recording runner: no gcloud, node or git process ever starts here, and the
// production lock is a fake. Every resource name, commit, digest and receipt
// is synthetic.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import { unfilledProductionText } from "./fixtures/gcp-ops-infra/production-unfilled.mjs";
import { readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import {
  primaryManifestSha256,
  productionMigrationReceiptDigest,
} from "../cloud-run/postgres-production-migrations.mjs";
import {
  functionSignature,
  OPERATOR_ONLY_PRIMARY_FUNCTIONS,
  RUNTIME_PRIMARY_FUNCTIONS,
  runtimeGrantPolicyDigest,
} from "../cloud-run/postgres-runtime-grants.mjs";
import {
  applyEdgeModeSnapshotDelta,
  EDGE_MODE_PRODUCTION_DOMAINS,
  EDGE_MODE_PRODUCTION_WORKER_NAME,
  liveEdgeMode,
} from "./edge-mode-configuration.mjs";
import { createProductionLiveConfigSnapshot } from "./production-live-config.mjs";
import {
  createEnvironmentDeploymentLock,
  deploymentLockRef,
  PRODUCTION_LOCK_REF,
  STAGING_LOCK_REF,
} from "./production-deployment-lock.mjs";
import {
  assertOriginContractBlob,
  assessProductionBuild,
  EDGE_CAPTURE_MAX_AGE_MS,
  imageReference,
  loadRolloutTargetFromInfraManifest,
  parseRolloutArguments,
  PRE_MIGRATION_BACKUPS,
  readEdgeLiveCaptureFile,
  REPOSITORY_ROOT,
  ROLLOUT_ARGV,
  ROLLOUT_EDGE_CAPTURE_VERB,
  ROLLOUT_EDGE_LIVE_KEYS,
  ROLLOUT_EDGE_LIVE_SCHEMA,
  ROLLOUT_MIGRATE_RECEIPT_SCHEMA,
  ROLLOUT_STAGING_EDGE_IDENTITY,
  runRollout,
  runRolloutCli,
  safeRolloutErrorCode,
  trackedEdgeIdentity,
  validateRolloutTarget,
  validateStagingEdgeIdentity,
  verifyEdgeLiveCapture,
  verifyMigrateReceipt,
} from "./gcp-production-rollout.mjs";

const COMMIT = "1".repeat(40);
const OTHER_COMMIT = "2".repeat(40);
const EDGE_COMMIT = "3".repeat(40);
const DIGEST = `sha256:${"d".repeat(64)}`;
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const PROJECT = "w2-opsdb-prod-synth";
const SERVICE_URL = "https://tibotattle-origin-synthetic.a.run.app";
const ORIGIN_AUDIENCE = "https://synthetic-origin-audience.example";
const TARGET = Object.freeze({
  environment: "production",
  project: PROJECT,
  region: "us-east1",
  service: "tibotattle-origin",
  migrationJob: "tibotattle-production-migrate",
  jobNames: Object.freeze(["tibotattle-production-migrate", "tibotattle-analytics-refresh", "tibotattle-maintenance"]),
  primaryInstance: "tibotattle-primary",
  imageRepository: `us-east1-docker.pkg.dev/${PROJECT}/tibotattle/origin`,
  builderServiceAccount: `tibotattle-builder@${PROJECT}.iam.gserviceaccount.com`,
  verifierServiceAccount: `tibotattle-verifier@${PROJECT}.iam.gserviceaccount.com`,
  originAudience: ORIGIN_AUDIENCE,
  maintenanceJob: "tibotattle-maintenance",
});
const STAGING_PROJECT = "w2-opsdb-staging-synth";
// The staging target as OPS-2 derives it (rolloutTargetFromDesiredState):
// staging deploys its maintenance Job from its stagingOrigin block
// (STAGING-MAINT-RENDER), so the Job is in jobNames and is maintenanceJob.
const STAGING_TARGET = Object.freeze({
  environment: "staging",
  project: STAGING_PROJECT,
  region: "us-east1",
  service: "tibotattle-staging-origin",
  migrationJob: "tibotattle-staging-migrate",
  jobNames: Object.freeze(["tibotattle-staging-migrate", "tibotattle-staging-analytics",
    "tibotattle-staging-maintenance"]),
  primaryInstance: "tibotattle-staging-primary",
  imageRepository: `us-east1-docker.pkg.dev/${STAGING_PROJECT}/tibotattle-staging/origin`,
  builderServiceAccount: `tibotattle-staging-builder@${STAGING_PROJECT}.iam.gserviceaccount.com`,
  verifierServiceAccount: `tibotattle-staging-verifier@${STAGING_PROJECT}.iam.gserviceaccount.com`,
  originAudience: ORIGIN_AUDIENCE,
  maintenanceJob: "tibotattle-staging-maintenance",
});
// A target whose environment could not have the maintenance Job
// (JOB_ENVIRONMENT_UNAVAILABLE; none today): neither jobNames nor
// maintenanceJob names it, and the origin-verifier roll is refused.
const NO_MAINTENANCE_TARGET = Object.freeze({
  ...STAGING_TARGET,
  jobNames: Object.freeze(STAGING_TARGET.jobNames.filter((name) => name !== STAGING_TARGET.maintenanceJob)),
  maintenanceJob: null,
});
const IMAGE = `${TARGET.imageRepository}@${DIGEST}`;
const CONTRACT_PATH = "apps/worker/src/edge-origin-contract.ts";
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzeW50aGV0aWMiOnRydWV9.c3ludGhldGlj";

// The checkout's real manifest, which carries LEAD-SIMP's residue
// (0064_append_only_residue.sql, final name per OD-1) followed by the
// additive 0065 interim public read, D-PT4X's additive 0066 and 0067,
// D-OPS4's additive 0068 and K-CORE-A's run stamps 0069 (a reviewed contract
// migration). The "missing residue" case slices off the residue
// and everything after it rather than naming a file at a fixed number.
const MIGRATIONS = Object.freeze(await readPostgresMigrations({ role: "primary" }));
const RESIDUE = MIGRATIONS.find(({ name }) => name.endsWith("_append_only_residue.sql"));
const residueFree = Object.freeze(MIGRATIONS.slice(0, MIGRATIONS.indexOf(RESIDUE)));

const isCode = (code) => (error) => error?.code === code;

/** The 'tibotattle-gcp-migration-v1' receipt the Job would log for this rollout. */
function jobReceipt(overrides = {}, target = TARGET) {
  const body = {
    schema: "tibotattle-gcp-migration-v1",
    status: "ok",
    environment: target.environment,
    job: target.migrationJob,
    sourceCommit: COMMIT,
    target: {
      kind: "environment",
      instanceConnectionName: `${target.project}:us-east1:${target.primaryInstance}`,
      database: "tibotattle",
      schema: "tibotattle",
    },
    migrations: {
      role: "primary",
      count: MIGRATIONS.length,
      latest: { version: MIGRATIONS.length, name: MIGRATIONS.at(-1).name, sha256: MIGRATIONS.at(-1).sha256 },
      manifestSha256: primaryManifestSha256(MIGRATIONS),
      historySha256: "e".repeat(64),
      contractReviewed: 23,
      simpResidue: RESIDUE.name,
    },
    roles: { migrator: `tibotattle-migrator@${target.project}.iam`, runtime: `tibotattle-runtime@${target.project}.iam` },
    runtimeGrants: {
      policySha256: runtimeGrantPolicyDigest(),
      executableFunctions: RUNTIME_PRIMARY_FUNCTIONS.map(functionSignature),
      operatorOnlyClosed: OPERATOR_ONLY_PRIMARY_FUNCTIONS.map(functionSignature),
    },
    ledger: "not-migrated",
    ...overrides,
  };
  return { ...body, digest: productionMigrationReceiptDigest(body) };
}

function serviceResource(image, commit, { url = SERVICE_URL, env, hostOrigin = url } = {}) {
  return {
    apiVersion: "serving.knative.dev/v1",
    kind: "Service",
    metadata: { annotations: { "run.googleapis.com/urls": JSON.stringify([url]) } },
    spec: { template: { spec: { containers: [{ image,
      env: env ?? [{ name: "DEPLOYMENT_SOURCE_COMMIT", value: commit },
        // The CR-7 host's one accepted origin (OPS-2 renders it; roll checks it).
        ...(hostOrigin === null ? [] : [{ name: "HOST_ORIGIN", value: hostOrigin }])] }] } } },
    status: {
      url,
      latestReadyRevisionName: "tibotattle-origin-00002-abc",
      latestCreatedRevisionName: "tibotattle-origin-00002-abc",
      traffic: [{ revisionName: "tibotattle-origin-00002-abc", percent: 100, latestRevision: true }],
    },
  };
}

function jobResource(image, commit) {
  return {
    apiVersion: "run.googleapis.com/v1",
    kind: "Job",
    spec: { template: { spec: { template: { spec: { containers: [{ image, env: [
      { name: "DEPLOYMENT_SOURCE_COMMIT", value: commit },
    ] }] } } } } },
  };
}

/** One Cloud Scheduler trigger of a Cloud Run job (OPS-2's v2 run URI). */
function trigger(job, state = "PAUSED", target = TARGET) {
  return {
    name: `projects/${target.project}/locations/${target.region}/jobs/${job}-trigger`,
    state,
    httpTarget: { uri: `https://run.googleapis.com/v2/projects/${target.project}/locations/${target.region}/jobs/${job}:run`,
      httpMethod: "POST" },
  };
}

const completed = (job) => ({ metadata: { name: `${job}-done1` }, status: { completionTime: "2026-10-02T10:00:00Z",
  succeededCount: 1 } });

/**
 * A recording runner over a fake estate. `fail` names a step that answers
 * non-zero; `blobs` maps `<commit>:<path>` to a git blob id. `schedulers` and
 * `executions` answer the scheduled-jobs readback (a function receives the
 * readback count, so a test can change the answer between readbacks).
 */
function fakeEstate({
  target = TARGET,
  dirty = false,
  head = COMMIT,
  infraClean = true,
  fail = null,
  blobs = { [`${COMMIT}:${CONTRACT_PATH}`]: "a".repeat(40), [`${EDGE_COMMIT}:${CONTRACT_PATH}`]: "a".repeat(40) },
  receipt = jobReceipt({}, target),
  executionStatus = { succeededCount: 1 },
  staleReadback = false,
  liveEnv,
  serviceUrl = SERVICE_URL,
  schedulers = [trigger(target.jobNames[1], "PAUSED", target)],
  executions = (job) => [completed(job)],
  servedCommit = null,
} = {}) {
  const calls = [];
  const requests = [];
  let scheduledReads = 0;
  const state = {
    service: serviceResource(`${target.imageRepository}@sha256:${"0".repeat(64)}`, OTHER_COMMIT, { url: serviceUrl, env: liveEnv }),
    jobs: Object.fromEntries(target.jobNames.map((job) => [job, jobResource(`${target.imageRepository}@sha256:${"0".repeat(64)}`,
      OTHER_COMMIT)])),
    backups: [],
    executions: 0,
  };
  const ok = (stdout = "") => ({ status: 0, stdout });
  const run = (argv) => {
    calls.push(argv);
    const [command, ...args] = argv;
    const step = args.slice(0, 3).join(" ");
    if (fail !== null && argv.join(" ").includes(fail)) return { status: 1, stdout: "" };
    if (command === "git") {
      if (args[0] === "status") return ok(dirty ? " M apps/worker/src/index.ts\n" : "");
      if (args.join(" ") === "rev-parse --verify HEAD") return ok(`${head}\n`);
      if (args[0] === "rev-parse" && args[2] === "--quiet") {
        const blob = blobs[args[3]];
        return blob === undefined ? { status: 1, stdout: "" } : ok(`${blob}\n`);
      }
    }
    if (command === "node" && args[0] === "scripts/gcp-infra.mjs") {
      return infraClean ? ok(JSON.stringify({ status: "clean", synthetic: true })) : { status: 2, stdout: "{}" };
    }
    if (command === "gcloud") {
      if (step === "scheduler jobs list") {
        scheduledReads += 1;
        return ok(JSON.stringify(typeof schedulers === "function" ? schedulers(scheduledReads) : schedulers));
      }
      if (args.slice(0, 4).join(" ") === "run jobs executions list") {
        const job = args.find((arg) => arg.startsWith("--job=")).slice("--job=".length);
        return ok(JSON.stringify(executions(job, scheduledReads)));
      }
      if (args.slice(0, 2).join(" ") === "auth print-identity-token") return ok(`${TOKEN}\n`);
      if (step === "sql backups list") return ok(JSON.stringify(state.backups));
      if (step === "sql backups create") {
        const description = args.find((arg) => arg.startsWith("--description=")).slice("--description=".length);
        state.backups.push({
          kind: "sql#backupRun", id: String(1_700_000_000_000 + state.backups.length), instance: target.primaryInstance,
          type: "ON_DEMAND", status: "SUCCESSFUL", location: target.region,
          windowStartTime: new Date(NOW - 60_000).toISOString(), description,
        });
        return ok("");
      }
      if (step === "run jobs update") {
        const job = args[3];
        const image = args.find((arg) => arg.startsWith("--image=")).slice("--image=".length);
        const commit = args.find((arg) => arg.startsWith("--update-env-vars=")).split("=").at(-1);
        state.jobs[job] = jobResource(image, commit);
        return ok("");
      }
      if (step === "run jobs execute") {
        state.executions += 1;
        return ok(JSON.stringify({ metadata: { name: `${args[3]}-x7k2p` }, status: executionStatus }));
      }
      if (args[0] === "logging" && args[1] === "read") {
        return ok(JSON.stringify([{ jsonPayload: receipt,
          labels: { "run.googleapis.com/execution_name": `${target.migrationJob}-x7k2p` } }]));
      }
      if (step === "run services update") {
        const image = args.find((arg) => arg.startsWith("--image=")).slice("--image=".length);
        const commit = args.find((arg) => arg.startsWith("--update-env-vars=")).split("=").at(-1);
        state.service = serviceResource(image, staleReadback ? OTHER_COMMIT : commit, { url: serviceUrl });
        return ok("");
      }
      if (step === "run services describe") return ok(JSON.stringify(state.service));
      if (step === "run jobs describe") return ok(JSON.stringify(state.jobs[args[3]]));
    }
    throw new Error(`unexpected command ${argv.slice(0, 4).join(" ")}`);
  };
  /** The served /api/health and /api/ready: the live service's commit unless servedCommit overrides it. */
  const fetch = async (url, init) => {
    requests.push({ url, init });
    const commit = servedCommit ?? state.service.spec.template.spec.containers[0].env
      .find(({ name }) => name === "DEPLOYMENT_SOURCE_COMMIT")?.value;
    const path = new URL(url).pathname;
    const body = path === "/api/ready" ? { status: "ready" } : { status: "ok", deployment: { sourceCommit: commit } };
    return {
      url,
      status: 200,
      headers: new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
        "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-tibotattle-origin": "1" }),
      text: async () => JSON.stringify(body),
    };
  };
  return { run, fetch, calls, requests, state };
}

function fakeLock({ reportRef } = {}) {
  const events = [];
  let held = null;
  const records = [];
  const refs = [];
  return {
    events,
    records,
    refs,
    factory: (options) => {
      assert.deepEqual(Object.keys(options).sort(), ["environment", "ref", "repositoryRoot"]);
      const { environment, ref, repositoryRoot } = options;
      assert.equal(typeof repositoryRoot, "string");
      assert.equal(ref, deploymentLockRef(environment), "the rollout asks for its environment's own ref");
      refs.push(ref);
      return {
        ref: reportRef ?? ref,
        createOwner(record) {
          assert.deepEqual(Object.keys(record).sort(), ["id", "previousSourceCommit", "sourceCommit"]);
          records.push(record);
          return "f".repeat(40);
        },
        acquire(owner) {
          assert.equal(held, null, "the lock is free");
          held = owner;
          events.push("acquire");
        },
        assertOwned(owner) {
          assert.equal(held, owner);
          events.push("assert");
        },
        release(owner) {
          assert.equal(held, owner);
          held = null;
          events.push("release");
        },
        status: () => held,
      };
    },
  };
}

async function workspace(t, target = TARGET) {
  const directory = await mkdtemp(join(tmpdir(), "w2-opsdb-rollout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audit = join(directory, "audit.json");
  await writeFile(audit, JSON.stringify({
    environment: target.environment, project: target.project, roles: { primary: { instance: target.primaryInstance } },
    verdict: "ok", generatedAt: new Date(NOW - 60_000).toISOString(), digest: "a".repeat(64),
  }));
  return { directory, audit, migrateReceipt: join(directory, "migrate.json"), edgeLive: join(directory, "edge.json") };
}

function dependencies(estate, lock, overrides = {}) {
  return {
    run: estate.run,
    fetch: estate.fetch,
    loadTarget: async (environment) => (environment === "staging" ? STAGING_TARGET : TARGET),
    lockFactory: lock.factory,
    now: () => NOW,
    uuid: () => "00000000-0000-4000-8000-000000000001",
    verifyBackupAudit: (raw) => raw,
    readPrimaryMigrations: async () => MIGRATIONS,
    ...overrides,
  };
}

const migrateArgv = (paths, extra = [], environment = "production") => ["migrate", `--environment=${environment}`,
  `--commit=${COMMIT}`, `--digest=${DIGEST}`, `--backup-audit=${paths.audit}`, `--migrate-receipt=${paths.migrateReceipt}`,
  ...extra];
const rollArgv = (paths, extra = [], environment = "production") => ["roll", `--environment=${environment}`,
  `--commit=${COMMIT}`, `--digest=${DIGEST}`, `--backup-audit=${paths.audit}`, `--migrate-receipt=${paths.migrateReceipt}`,
  `--edge-live=${paths.edgeLive}`, ...extra];
const executeMigrate = (paths, environment = "production") => migrateArgv(paths,
  [`--authorize=migrate:${environment}:${DIGEST}`, "--execute"], environment);
const executeRoll = (paths, environment = "production") => rollArgv(paths,
  [`--authorize=roll:${environment}:${DIGEST}`, "--execute"], environment);

// ---------------------------------------------------------------------------
// Edge snapshots (EP-9 synthetic fixture, typed deltas)

const FIXTURE = JSON.parse(await readFile(new URL("./fixtures/edge-mode-live-snapshot.synthetic.json", import.meta.url), "utf8"));
const TRACKED = parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const GCP_PLAN = Object.freeze({
  upstreamOrigin: "https://tibotattle-origin-synthetic.a.run.app",
  originAudience: "https://synthetic-origin-audience.example",
  invokerServiceAccount: "edge-invoker@synthetic-project.iam.gserviceaccount.com",
  releaseGuardDatabase: Object.freeze({ id: "77777777-7777-4777-8777-777777777777", name: "synthetic-release-guard" }),
});

function inventoryOf(snapshot, overrides = {}) {
  const value = { ...snapshot, ...overrides };
  const bindings = value.bindings.map((binding) => binding.type === "d1" ? { ...binding, id: binding.database_id } : binding);
  return {
    accountId: value.accountId,
    workerName: value.workerName,
    version: { id: value.versionId, resources: { script_runtime: value.runtime, bindings } },
    settings: { ...value.settings, compatibility_date: value.runtime.compatibility_date,
      compatibility_flags: value.runtime.compatibility_flags, usage_model: value.runtime.usage_model,
      limits: value.runtime.limits, cache_options: value.runtime.cache_options, bindings },
    schedules: { schedules: value.crons.map((cron) => ({ cron })) },
    subdomain: value.subdomain,
    routes: value.routes,
    domains: value.domains,
    namespaces: value.namespaces,
  };
}
const resnapshot = (snapshot, overrides) => createProductionLiveConfigSnapshot(inventoryOf(snapshot, overrides));
const versionId = (index) => `0e000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
function deployed(expected, sourceCommit, id) {
  const withCommit = resnapshot(expected, { bindings: expected.bindings.map((binding) =>
    binding.name === "DEPLOYMENT_SOURCE_COMMIT" ? { ...binding, text: sourceCommit } : binding) });
  return resnapshot(withCommit, { versionId: id });
}
const workerLive = deployed(applyEdgeModeSnapshotDelta({ snapshot: FIXTURE, mode: "worker", trackedConfig: TRACKED }),
  EDGE_COMMIT, versionId(153));
const withSecrets = resnapshot(workerLive, { bindings: [...workerLive.bindings,
  { name: "EDGE_CLIENT_KEY_SECRET", type: "secret_text" }, { name: "EDGE_INVOKER_KEY_JSON", type: "secret_text" }] });
const fencedLive = deployed(applyEdgeModeSnapshotDelta({ snapshot: withSecrets, mode: "fenced", trackedConfig: TRACKED }),
  EDGE_COMMIT, versionId(154));
const gcpLive = deployed(applyEdgeModeSnapshotDelta({ snapshot: fencedLive, mode: "gcp", plan: GCP_PLAN, trackedConfig: TRACKED }),
  EDGE_COMMIT, versionId(155));
const preEdgeLive = deployed(FIXTURE, EDGE_COMMIT, versionId(152));
/** The staging edge Worker: its pinned name, its two staging custom domains and its public origin. */
const asStaging = (snapshot, identity = ROLLOUT_STAGING_EDGE_IDENTITY) => resnapshot(snapshot, {
  workerName: identity.workerName,
  domains: identity.domains.map((hostname) => ({ hostname })),
  namespaces: snapshot.namespaces.map((namespace) => ({ ...namespace, script: identity.workerName,
    name: `${identity.workerName}_${namespace.class}` })),
  bindings: snapshot.bindings.map((binding) => (binding.name === "PUBLIC_ORIGIN"
    ? { ...binding, text: identity.publicOrigin }
    : binding.name === "ENVIRONMENT" ? { ...binding, text: "staging" } : binding)),
});
const stagingGcpLive = asStaging(gcpLive);
const stagingWorkerLive = asStaging(workerLive);
const capture = (snapshot, { capturedAt = new Date(NOW).toISOString(), deployment } = {}) => JSON.stringify({
  schema: ROLLOUT_EDGE_LIVE_SCHEMA,
  capturedAt,
  snapshot,
  deployment: deployment ?? { versions: [{ version_id: snapshot.versionId, percentage: 100 }] },
});

async function migrated(t, { edge = gcpLive, target = TARGET } = {}) {
  const paths = await workspace(t, target);
  const estate = fakeEstate({ target });
  const lock = fakeLock();
  await runRollout(executeMigrate(paths, target.environment), dependencies(estate, lock));
  await writeFile(paths.edgeLive, capture(edge));
  return paths;
}

// ---------------------------------------------------------------------------

test("arguments: closed verbs and flags, absolute input paths, and an exact authorization to execute", () => {
  const paths = { audit: "/synthetic/audit.json", migrateReceipt: "/synthetic/migrate.json", edgeLive: "/synthetic/edge.json" };
  assert.equal(parseRolloutArguments(migrateArgv(paths)).execute, false);
  assert.equal(parseRolloutArguments(executeMigrate(paths)).execute, true);
  const cases = [
    [["deploy", "--environment=production"], "ROLLOUT_VERB_INVALID"],
    [migrateArgv(paths, ["--execute"]), "ROLLOUT_AUTHORIZATION_REQUIRED"],
    [migrateArgv(paths, [`--authorize=migrate:staging:${DIGEST}`]), "ROLLOUT_AUTHORIZATION_MISMATCH"],
    [migrateArgv(paths, [`--authorize=roll:production:${DIGEST}`, "--execute"]), "ROLLOUT_AUTHORIZATION_MISMATCH"],
    [migrateArgv(paths, [`--authorize=migrate:production:${COMMIT}`]), "ROLLOUT_AUTHORIZATION_MISMATCH"],
    [["build", "--environment=production", `--commit=${COMMIT}`, `--authorize=build:production:${OTHER_COMMIT}`],
      "ROLLOUT_AUTHORIZATION_MISMATCH"],
    [migrateArgv(paths).map((arg) => arg.startsWith("--digest=") ? "--digest=latest" : arg), "ROLLOUT_DIGEST_INVALID"],
    [migrateArgv(paths).map((arg) => arg.startsWith("--commit=") ? "--commit=HEAD" : arg), "ROLLOUT_COMMIT_INVALID"],
    [migrateArgv(paths).map((arg) => arg === "--environment=production" ? "--environment=test" : arg), "ROLLOUT_ENVIRONMENT_INVALID"],
    [migrateArgv(paths).map((arg) => arg.startsWith("--backup-audit=") ? "--backup-audit=audit.json" : arg), "ROLLOUT_PATH_INVALID"],
    [migrateArgv(paths).filter((arg) => !arg.startsWith("--migrate-receipt=")), "ROLLOUT_ARGUMENT_MISSING"],
    [migrateArgv(paths, ["--shell=bash"]), "ROLLOUT_ARGUMENT_INVALID"],
    [migrateArgv(paths, ["--execute", "--execute"]), "ROLLOUT_ARGUMENT_INVALID"],
    [rollArgv(paths).filter((arg) => !arg.startsWith("--edge-live=")), "ROLLOUT_ARGUMENT_MISSING"],
  ];
  for (const [argv, code] of cases) assert.throws(() => parseRolloutArguments(argv), isCode(code), argv.join(" "));
});

test("the target is closed and never a test, rehearsal or other-plane resource", () => {
  assert.deepEqual(validateRolloutTarget(TARGET, "production"), TARGET);
  assert.deepEqual(validateRolloutTarget(STAGING_TARGET, "staging"), STAGING_TARGET);
  assert.deepEqual(validateRolloutTarget({ ...TARGET, maintenanceJob: null }, "production"),
    { ...TARGET, maintenanceJob: null }, "a desired state without the maintenance Job yet (D-OPS4)");
  for (const [overrides, code] of [
    [{ extra: "x" }, "ROLLOUT_TARGET_INVALID"],
    [{ environment: "staging" }, "ROLLOUT_TARGET_INVALID"],
    [{ jobNames: ["tibotattle-maintenance"] }, "ROLLOUT_TARGET_INVALID"],
    [{ jobNames: [...TARGET.jobNames, TARGET.migrationJob] }, "ROLLOUT_TARGET_INVALID"],
    [{ imageRepository: `us-west1-docker.pkg.dev/${PROJECT}/tibotattle/origin` }, "ROLLOUT_TARGET_INVALID"],
    [{ imageRepository: "us-east1-docker.pkg.dev/other-project-x/tibotattle/origin" }, "ROLLOUT_TARGET_INVALID"],
    [{ verifierServiceAccount: "verifier@example.com" }, "ROLLOUT_TARGET_INVALID"],
    [{ verifierServiceAccount: TARGET.builderServiceAccount }, "ROLLOUT_TARGET_INVALID"],
    [{ originAudience: "" }, "ROLLOUT_TARGET_INVALID"],
    [{ originAudience: undefined }, "ROLLOUT_TARGET_INVALID"],
    // The maintenance Job is null or one of the rolled jobs, never the migration Job.
    [{ maintenanceJob: undefined }, "ROLLOUT_TARGET_INVALID"],
    [{ maintenanceJob: "tibotattle-other-maintenance" }, "ROLLOUT_TARGET_INVALID"],
    [{ maintenanceJob: TARGET.migrationJob }, "ROLLOUT_TARGET_INVALID"],
    [{ maintenanceJob: 1 }, "ROLLOUT_TARGET_INVALID"],
    [{ service: "tibotattle-test-app" }, "ROLLOUT_TARGET_TEST_FORBIDDEN"],
    [{ primaryInstance: "tibotattle-test-primary-20260922" }, "ROLLOUT_TARGET_TEST_FORBIDDEN"],
    [{ primaryInstance: "tibotattle-primary-rehearsal-0a1b2c3d" }, "ROLLOUT_TARGET_TEST_FORBIDDEN"],
    [{ builderServiceAccount: `tibotattle-test-builder@${PROJECT}.iam.gserviceaccount.com` }, "ROLLOUT_TARGET_TEST_FORBIDDEN"],
    [{ verifierServiceAccount: `tibotattle-test-verifier@${PROJECT}.iam.gserviceaccount.com` }, "ROLLOUT_TARGET_TEST_FORBIDDEN"],
    [{ service: "tibotattle-staging-origin" }, "ROLLOUT_TARGET_PLANE_MISMATCH"],
  ]) {
    assert.throws(() => validateRolloutTarget({ ...TARGET, ...overrides }, "production"), isCode(code), JSON.stringify(overrides));
  }
  assert.throws(() => validateRolloutTarget({ ...TARGET, environment: "staging" }, "staging"),
    isCode("ROLLOUT_TARGET_PLANE_MISMATCH"), "a staging target names every resource with the staging token");
});

test("the production edge identity comes from the tracked wrangler.jsonc and is EP-9's Worker and domains", async () => {
  const production = await trackedEdgeIdentity("production");
  assert.deepEqual(production, { workerName: "app-usagemonitor",
    domains: ["admin.tibotattle.com", "tibotattle.com", "www.tibotattle.com"], publicOrigin: "https://tibotattle.com" });
  for (const edit of [
    (config) => { config.env.production.name = "app-usagemonitor-other"; },
    (config) => { config.env.production.routes = config.env.production.routes.slice(1); },
    (config) => { config.env.production.vars.PUBLIC_ORIGIN = "https://tibotattle.com/"; },
    (config) => { delete config.env.production; },
  ]) {
    const config = structuredClone(TRACKED);
    edit(config);
    await assert.rejects(trackedEdgeIdentity("production", async () => config), isCode("ROLLOUT_EDGE_IDENTITY_UNRESOLVED"));
  }
  await assert.rejects(trackedEdgeIdentity("test", async () => TRACKED), isCode("ROLLOUT_EDGE_IDENTITY_UNRESOLVED"));
});

test("the staging edge identity is the pinned staging-edge Worker, never wrangler.jsonc's workers.dev env.staging", async () => {
  const pinned = { workerName: "app-usagemonitor-staging-edge",
    domains: ["admin.staging.tibotattle.com", "staging.tibotattle.com"], publicOrigin: "https://staging.tibotattle.com" };
  assert.deepEqual(await trackedEdgeIdentity("staging"), pinned);
  // The tracked config plays no part: neither its absence nor its env.staging changes staging's edge.
  assert.deepEqual(await trackedEdgeIdentity("staging", async () => { throw new Error("unread"); }), pinned);
  assert.notEqual(pinned.workerName, TRACKED.env.staging.name);
  assert.notEqual(pinned.publicOrigin, TRACKED.env.staging.vars.PUBLIC_ORIGIN);
  // The pin agrees with the committed staging desired state the staging service renders from:
  // its PUBLIC_ORIGIN and the ADMIN_HOST_ORIGIN derived from it.
  const desired = JSON.parse(await readFile(new URL("../cloud-run/infra/staging.desired-state.json", import.meta.url), "utf8"));
  const { validateStagingOrigin } = await import("./gcp-ops-infra-manifest.mjs");
  const stagingOrigin = validateStagingOrigin(desired.stagingOrigin, "staging");
  assert.equal(stagingOrigin.publicOrigin, pinned.publicOrigin);
  assert.deepEqual([new URL(stagingOrigin.adminOrigin).hostname, new URL(stagingOrigin.publicOrigin).hostname].sort(),
    pinned.domains);
  assert.deepEqual(validateStagingEdgeIdentity(ROLLOUT_STAGING_EDGE_IDENTITY), ROLLOUT_STAGING_EDGE_IDENTITY);
  for (const overrides of [
    { workerName: "app-usagemonitor" },
    { workerName: "app-usagemonitor-staging" },
    { workerName: "app-usagemonitor-edge" },
    { workerName: "App-Usagemonitor-Staging-Edge" },
    { domains: ["staging.tibotattle.com"] },
    { domains: ["admin.staging.tibotattle.com", "staging.tibotattle.com", "www.staging.tibotattle.com"] },
    { domains: ["staging.tibotattle.com", "admin.staging.tibotattle.com"] },
    { domains: ["admin.tibotattle.com", "tibotattle.com"], publicOrigin: "https://tibotattle.com" },
    { domains: ["admin.edge.tibotattle.com", "edge.tibotattle.com"], publicOrigin: "https://edge.tibotattle.com" },
    { publicOrigin: "https://staging.tibotattle.com/" },
    { publicOrigin: "http://staging.tibotattle.com" },
    { publicOrigin: "https://admin.staging.tibotattle.com" },
    { extra: true },
  ]) {
    assert.throws(() => validateStagingEdgeIdentity({ ...ROLLOUT_STAGING_EDGE_IDENTITY, ...overrides }),
      isCode("ROLLOUT_EDGE_IDENTITY_UNRESOLVED"), JSON.stringify(overrides));
  }
});

test("a staging capture of another Worker or another domain set is refused", async () => {
  const verify = (snapshot) => verifyEdgeLiveCapture(JSON.parse(capture(snapshot)), { environment: "staging", nowMs: NOW });
  assert.equal((await verify(stagingWorkerLive)).mode, "worker");
  assert.equal((await verify(stagingGcpLive)).publicOrigin, "https://staging.tibotattle.com");
  const retired = { workerName: TRACKED.env.staging.name, domains: [], publicOrigin: TRACKED.env.staging.vars.PUBLIC_ORIGIN };
  await assert.rejects(verify(asStaging(workerLive, retired)), isCode("ROLLOUT_EDGE_LIVE_TARGET_MISMATCH"),
    "the retired workers.dev staging Worker");
  await assert.rejects(verify(workerLive), isCode("ROLLOUT_EDGE_LIVE_TARGET_MISMATCH"), "the production Worker");
  for (const domains of [[], ["staging.tibotattle.com"], [...ROLLOUT_STAGING_EDGE_IDENTITY.domains, "www.staging.tibotattle.com"],
    ["admin.tibotattle.com", "tibotattle.com", "www.tibotattle.com"]]) {
    await assert.rejects(verify(asStaging(workerLive, { ...ROLLOUT_STAGING_EDGE_IDENTITY, domains })),
      isCode("ROLLOUT_EDGE_LIVE_UNVERIFIED"), domains.join(","));
  }
  await assert.rejects(verify(asStaging(workerLive, { ...ROLLOUT_STAGING_EDGE_IDENTITY,
    publicOrigin: TRACKED.env.staging.vars.PUBLIC_ORIGIN })), isCode("ROLLOUT_EDGE_LIVE_TARGET_MISMATCH"));
});

test("a dry run validates and prints argv only: no gcloud, no node, no request, no lock", async (t) => {
  const paths = await workspace(t);
  const estate = fakeEstate();
  const lock = fakeLock();
  const plan = await runRollout(migrateArgv(paths), dependencies(estate, lock));
  assert.equal(plan.status, "dry-run");
  assert.deepEqual(estate.calls, [], "the migrate dry run runs nothing");
  assert.deepEqual(lock.events, []);
  const steps = plan.steps.map(({ argv }) => argv);
  assert.equal(steps.filter((argv) => argv.slice(0, 4).join(" ") === "gcloud sql backups create").length, PRE_MIGRATION_BACKUPS);
  const firstBackup = steps.findIndex((argv) => argv.slice(0, 4).join(" ") === "gcloud sql backups create");
  const execute = steps.findIndex((argv) => argv.slice(0, 4).join(" ") === "gcloud run jobs execute");
  const schedulerReads = steps.map((argv, index) => [argv, index])
    .filter(([argv]) => argv.slice(0, 4).join(" ") === "gcloud scheduler jobs list").map(([, index]) => index);
  assert.ok(firstBackup >= 0 && firstBackup < execute, "backups precede the execution");
  assert.equal(schedulerReads.length, 2, "the scheduled jobs are read in preflight and again before the execution");
  assert.ok(schedulerReads[0] < firstBackup && schedulerReads[1] > firstBackup && schedulerReads[1] < execute);
  assert.deepEqual(steps.find((argv) => argv[3] === "update"), ROLLOUT_ARGV.jobUpdate(TARGET, TARGET.migrationJob, IMAGE, COMMIT));
  for (const argv of steps) {
    assert.equal(argv.some((part) => /^(?:delete|rm|sh|bash|-c)$/u.test(part)), false, argv.join(" "));
  }
  const build = await runRollout(["build", "--environment=production", `--commit=${COMMIT}`], dependencies(estate, lock));
  assert.deepEqual(build.steps.map(({ argv }) => argv.slice(0, 3)), [["git", "status", "--porcelain=v1"],
    ["git", "rev-parse", "--verify"], ["node", "scripts/cloud-run-build-archive.mjs", "--output=<build-dir>/source.tar.gz"],
    ["gcloud", "builds", "submit"]]);
  assert.equal(build.steps.at(-1).argv[3], "<build-dir>/source.tar.gz", "the archive file itself is submitted");
  assert.deepEqual(estate.calls, []);
  const preflight = await runRollout(["preflight", "--environment=production", `--commit=${COMMIT}`,
    `--backup-audit=${paths.audit}`], dependencies(estate, lock));
  assert.deepEqual(preflight.steps.map(({ argv }) => argv), [ROLLOUT_ARGV.gitStatus(), ROLLOUT_ARGV.gitHead(),
    ["node", "scripts/gcp-infra.mjs", "readback", "--require-clean", "--environment=production"],
    ["gcloud", "scheduler", "jobs", "list", `--project=${PROJECT}`, "--location=us-east1", "--format=json"],
    ...TARGET.jobNames.map((job) => ["gcloud", "run", "jobs", "executions", "list", `--job=${job}`, `--project=${PROJECT}`,
      "--region=us-east1", "--format=json"])]);
  assert.deepEqual(estate.calls, []);
  const refused = await runRollout(migrateArgv(paths), dependencies(estate, lock, { run: () => assert.fail("never") }));
  assert.equal(refused.status, "dry-run");
  // The roll dry run names its served-commit check and runs no request.
  const migratedPaths = await migrated(t, { edge: workerLive });
  const rollEstate = fakeEstate();
  const rollPlan = await runRollout(rollArgv(migratedPaths), dependencies(rollEstate, fakeLock(),
    { fetch: () => assert.fail("never") }));
  assert.deepEqual(rollPlan.servedCommitCheck, { path: "origin-verifier", paths: ["/api/health", "/api/ready"] });
  assert.deepEqual(rollPlan.steps.at(-1).argv, ROLLOUT_ARGV.identityToken(TARGET));
  assert.deepEqual(rollEstate.calls, [ROLLOUT_ARGV.gitBlob(COMMIT, CONTRACT_PATH), ROLLOUT_ARGV.gitBlob(EDGE_COMMIT, CONTRACT_PATH)],
    "the roll dry run runs only the two local contract blob reads (D-BLOB)");
  await writeFile(migratedPaths.edgeLive, capture(gcpLive));
  const gcpPlan = await runRollout(rollArgv(migratedPaths), dependencies(fakeEstate(), fakeLock()));
  assert.deepEqual(gcpPlan.servedCommitCheck, { path: "public-health", url: "https://tibotattle.com/api/health" });
});

test("migrate: preflight, quiescent jobs, one labelled pre-migration backup, then the job update and execution, under the lock",
  async (t) => {
    const paths = await workspace(t);
    const estate = fakeEstate();
    const lock = fakeLock();
    const receipt = await runRollout(executeMigrate(paths), dependencies(estate, lock));
    assert.deepEqual(lock.refs, [PRODUCTION_LOCK_REF], "production takes only the production lock");
    const calls = estate.calls.map((argv) => argv.join(" "));
    const index = (prefix) => calls.findIndex((call) => call.startsWith(prefix));
    const creates = calls.map((call, position) => [call, position]).filter(([call]) => call.startsWith("gcloud sql backups create"));
    assert.equal(PRE_MIGRATION_BACKUPS, 1, "one pre-migration backup, with point-in-time recovery");
    assert.equal(creates.length, PRE_MIGRATION_BACKUPS);
    for (const [call] of creates) {
      assert.match(call, /--description=tibotattle-expires-on=2026-11-01;purpose=pre-migration/u);
      assert.match(call, /--instance=tibotattle-primary /u);
      assert.match(call, /--location=us-east1/u);
    }
    assert.deepEqual(estate.calls.filter((argv) => argv.slice(0, 4).join(" ") === "gcloud sql backups create"),
      [ROLLOUT_ARGV.backupCreate(TARGET, "tibotattle-expires-on=2026-11-01;purpose=pre-migration")],
      "the dry-run argv is what createOnDemandBackup issues");
    const schedulerReads = calls.map((call, position) => [call, position])
      .filter(([call]) => call.startsWith("gcloud scheduler jobs list")).map(([, position]) => position);
    assert.equal(schedulerReads.length, 2);
    assert.ok(index("node scripts/gcp-infra.mjs readback --require-clean") < creates[0][1]);
    assert.ok(schedulerReads[0] < creates[0][1], "the jobs are quiescent before the first backup");
    assert.ok(creates.at(-1)[1] < schedulerReads[1] && schedulerReads[1] < index(`gcloud run jobs update ${TARGET.migrationJob}`),
      "and again after the backups, right before the DDL");
    assert.ok(index(`gcloud run jobs update ${TARGET.migrationJob}`) < index(`gcloud run jobs execute ${TARGET.migrationJob}`));
    assert.ok(index(`gcloud run jobs execute`) < index("gcloud logging read"));
    assert.deepEqual(lock.events, ["acquire", "assert", "release"]);
    assert.deepEqual(lock.records, [{ id: "00000000-0000-4000-8000-000000000001", sourceCommit: COMMIT,
      previousSourceCommit: OTHER_COMMIT }], "the lock records the live service's own commit");
    assert.equal(receipt.schema, ROLLOUT_MIGRATE_RECEIPT_SCHEMA);
    assert.equal(receipt.backups.length, 1);
    assert.equal(receipt.execution, `${TARGET.migrationJob}-x7k2p`);
    assert.equal(receipt.migrationReceiptDigest, jobReceipt().digest);
    const written = JSON.parse(await readFile(paths.migrateReceipt, "utf8"));
    assert.deepEqual(verifyMigrateReceipt(written), receipt);
    assert.equal((await stat(paths.migrateReceipt)).mode & 0o777, 0o600);
    await assert.rejects(runRollout(executeMigrate(paths), dependencies(fakeEstate(), fakeLock())),
      isCode("ROLLOUT_RECEIPT_EXISTS"), "a migrate receipt is never overwritten");
  });

test("migrate refuses before any backup or lock when the checkout lacks the SIMP residue or is not the commit", async (t) => {
  const paths = await workspace(t);
  for (const [setup, code] of [
    [{ readPrimaryMigrations: async () => residueFree }, "PRODUCTION_SIMP_RESIDUE_MISSING"],
    [{ readPrimaryMigrations: async () => [...MIGRATIONS.slice(0, -1), { ...MIGRATIONS.at(-1), sql: "DROP TABLE participants;\n",
      sha256: createHash("sha256").update("DROP TABLE participants;\n").digest("hex") }] },
    "PRODUCTION_MIGRATION_CONTRACT_UNREVIEWED"],
  ]) {
    const estate = fakeEstate();
    const lock = fakeLock();
    await assert.rejects(runRollout(executeMigrate(paths), dependencies(estate, lock, setup)), isCode(code));
    assert.deepEqual(estate.calls, []);
    assert.deepEqual(lock.events, []);
  }
  for (const [estateOptions, code] of [[{ dirty: true }, "ROLLOUT_TREE_DIRTY"], [{ head: OTHER_COMMIT }, "ROLLOUT_COMMIT_NOT_CHECKED_OUT"]]) {
    const estate = fakeEstate(estateOptions);
    const lock = fakeLock();
    await assert.rejects(runRollout(executeMigrate(paths), dependencies(estate, lock)), isCode(code));
    assert.equal(estate.calls.some(([command]) => command === "gcloud"), false);
    assert.deepEqual(lock.events, []);
  }
});

test("an unreadable live service commit is refused, never replaced by --commit", async (t) => {
  for (const liveEnv of [
    [],
    [{ name: "DEPLOYMENT_SOURCE_COMMIT", value: "main" }],
    [{ name: "DEPLOYMENT_SOURCE_COMMIT", value: OTHER_COMMIT }, { name: "DEPLOYMENT_SOURCE_COMMIT", value: OTHER_COMMIT }],
  ]) {
    const paths = await workspace(t);
    const estate = fakeEstate({ liveEnv });
    const lock = fakeLock();
    await assert.rejects(runRollout(executeMigrate(paths), dependencies(estate, lock)), isCode("ROLLOUT_LIVE_COMMIT_UNKNOWN"));
    assert.deepEqual([lock.events, lock.records], [[], []], "no lock record claims a predecessor");
    const rollPaths = await migrated(t, { edge: workerLive });
    const rollEstate = fakeEstate({ liveEnv });
    const rollLock = fakeLock();
    await assert.rejects(runRollout(executeRoll(rollPaths), dependencies(rollEstate, rollLock)),
      isCode("ROLLOUT_LIVE_COMMIT_UNKNOWN"));
    assert.deepEqual([rollLock.events, rollLock.records], [[], []]);
    assert.equal(rollEstate.calls.some((argv) => argv[3] === "update"), false);
  }
});

test("migrate releases the lock on every failure after acquiring it, and runs nothing past the failure", async (t) => {
  const paths = await workspace(t);
  const enabled = [trigger(TARGET.jobNames[1], "ENABLED")];
  const runningAnalytics = (job) => (job === TARGET.jobNames[1] ? [completed(job), { metadata: { name: `${job}-live1` },
    status: { startTime: "2026-10-02T11:59:00Z" } }] : [completed(job)]);
  for (const [estateOptions, code, setup] of [
    [{ infraClean: false }, "ROLLOUT_INFRA_NOT_CLEAN"],
    [{ schedulers: enabled }, "ROLLOUT_JOBS_NOT_PAUSED"],
    [{ schedulers: [{ ...trigger("unmanaged-job", "ENABLED"), httpTarget: { uri: "https://run.googleapis.com/v1/other" } }] },
      "ROLLOUT_JOBS_NOT_PAUSED"],
    [{ executions: runningAnalytics }, "ROLLOUT_JOBS_RUNNING"],
    // Resumed by someone while the backups ran: refused before the DDL.
    [{ schedulers: (read) => (read === 1 ? [trigger(TARGET.jobNames[1])] : enabled) }, "ROLLOUT_JOBS_NOT_PAUSED"],
    [{ fail: "scheduler jobs list" }, "ROLLOUT_SCHEDULED_JOBS_READBACK_FAILED"],
    [{ fail: "sql backups create" }, "BACKUP_ON_DEMAND_CREATE_FAILED"],
    [{ fail: "run jobs update" }, "ROLLOUT_JOB_UPDATE_FAILED"],
    [{ executionStatus: { succeededCount: 0, failedCount: 1 } }, "ROLLOUT_MIGRATION_FAILED"],
    [{ receipt: jobReceipt({ sourceCommit: OTHER_COMMIT }) }, "ROLLOUT_MIGRATION_RECEIPT_MISMATCH"],
    [{ receipt: jobReceipt({ target: { kind: "scratch", instanceConnectionName: `${PROJECT}:us-east1:tibotattle-primary-rehearsal-0a1b2c3d`,
      database: "tibotattle", schema: "tibotattle" } }) }, "ROLLOUT_MIGRATION_RECEIPT_MISMATCH"],
    [{ receipt: { ...jobReceipt(), digest: "0".repeat(64) } }, "POSTGRES_PRODUCTION_MIGRATIONS_RECEIPT_INVALID"],
    [{}, "ROLLOUT_BACKUP_AUDIT_BREACH", { verifyBackupAudit: (raw) => ({ ...raw, verdict: "breach" }) }],
    [{}, "ROLLOUT_BACKUP_AUDIT_STALE", { verifyBackupAudit: (raw) => ({ ...raw, generatedAt: "2026-10-01T00:00:00.000Z" }) }],
    [{}, "ROLLOUT_BACKUP_AUDIT_TARGET_MISMATCH", { verifyBackupAudit: (raw) => ({ ...raw, roles: { primary: { instance: "other" } } }) }],
    [{}, "ROLLOUT_BACKUP_AUDIT_INVALID", { verifyBackupAudit: undefined }],
  ]) {
    const estate = fakeEstate(estateOptions);
    const lock = fakeLock();
    await assert.rejects(runRollout(executeMigrate(paths), dependencies(estate, lock, setup ?? {})), isCode(code), code);
    assert.deepEqual(lock.events.filter((event) => event !== "assert"), ["acquire", "release"], code);
    const executed = estate.calls.some((argv) => argv.slice(0, 4).join(" ") === "gcloud run jobs execute");
    assert.equal(executed, ["ROLLOUT_MIGRATION_FAILED", "ROLLOUT_MIGRATION_RECEIPT_MISMATCH",
      "POSTGRES_PRODUCTION_MIGRATIONS_RECEIPT_INVALID"].includes(code), code);
    if (["ROLLOUT_JOBS_NOT_PAUSED", "ROLLOUT_JOBS_RUNNING"].includes(code)) {
      assert.equal(estate.calls.some((argv) => argv[3] === "update"), false, `${code}: no job moves`);
    }
    await assert.rejects(stat(paths.migrateReceipt), undefined, "no migrate receipt after a failure");
  }
  // Jobs that are not quiescent at preflight are refused before any backup is taken.
  for (const estateOptions of [{ schedulers: enabled }, { executions: runningAnalytics }]) {
    const estate = fakeEstate(estateOptions);
    await assert.rejects(runRollout(executeMigrate(paths), dependencies(estate, fakeLock())));
    assert.equal(estate.calls.some((argv) => argv.slice(0, 4).join(" ") === "gcloud sql backups create"), false);
  }
});

test("roll refuses without a matching migrate receipt, before any command or lock", async (t) => {
  const paths = await workspace(t);
  await writeFile(paths.edgeLive, capture(gcpLive));
  const estate = fakeEstate();
  const lock = fakeLock();
  await assert.rejects(runRollout(executeRoll(paths), dependencies(estate, lock)), isCode("ROLLOUT_MIGRATE_RECEIPT_REQUIRED"));
  const migratedPaths = await migrated(t);
  const receipt = JSON.parse(await readFile(migratedPaths.migrateReceipt, "utf8"));
  for (const [edit, code] of [
    [(value) => ({ ...value, digest: `sha256:${"e".repeat(64)}`, image: `${TARGET.imageRepository}@sha256:${"e".repeat(64)}` }),
      "ROLLOUT_MIGRATE_RECEIPT_INVALID"],
    [(value) => ({ ...value, commit: OTHER_COMMIT }), "ROLLOUT_MIGRATE_RECEIPT_INVALID"],
    [(value) => ({ ...value, backups: [] }), "ROLLOUT_MIGRATE_RECEIPT_INVALID"],
    [(value) => ({ ...value, backups: [...value.backups, { id: "1700000000000999", expiresOn: "2026-11-01" }] }),
      "ROLLOUT_MIGRATE_RECEIPT_INVALID"],
  ]) {
    await writeFile(migratedPaths.migrateReceipt, JSON.stringify(edit(receipt)));
    const rollEstate = fakeEstate();
    const rollLock = fakeLock();
    await assert.rejects(runRollout(executeRoll(migratedPaths), dependencies(rollEstate, rollLock)), isCode(code));
    assert.deepEqual([rollEstate.calls, rollLock.events], [[], []]);
  }
  const resign = (value) => {
    const { digestSha256: _ignored, ...body } = value;
    return { ...body, digestSha256: createHash("sha256").update(canonical(body)).digest("hex") };
  };
  for (const [edit, code, now] of [
    [(value) => resign({ ...value, commit: OTHER_COMMIT }), "ROLLOUT_MIGRATE_RECEIPT_MISMATCH"],
    [(value) => resign({ ...value, digest: `sha256:${"e".repeat(64)}`, image: `${TARGET.imageRepository}@sha256:${"e".repeat(64)}` }),
      "ROLLOUT_MIGRATE_RECEIPT_MISMATCH"],
    [(value) => resign({ ...value, environment: "staging" }), "ROLLOUT_MIGRATE_RECEIPT_MISMATCH"],
    [(value) => value, "ROLLOUT_MIGRATE_RECEIPT_STALE", NOW + 25 * 60 * 60 * 1_000],
  ]) {
    await writeFile(migratedPaths.migrateReceipt, JSON.stringify(edit(receipt)));
    const rollEstate = fakeEstate();
    const rollLock = fakeLock();
    await assert.rejects(runRollout(executeRoll(migratedPaths), dependencies(rollEstate, rollLock,
      now === undefined ? {} : { now: () => now })), isCode(code), code);
    assert.deepEqual([rollEstate.calls, rollLock.events], [[], []]);
  }
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

test("roll moves the service and every manifest job to one digest and commit, reads them back, and the public health serves it",
  async (t) => {
    const paths = await migrated(t);
    assert.equal(liveEdgeMode(gcpLive), "gcp");
    const estate = fakeEstate();
    const lock = fakeLock();
    const receipt = await runRollout(executeRoll(paths), dependencies(estate, lock, { now: () => NOW + 120_000 }));
    const updates = estate.calls.filter((argv) => argv[3] === "update");
    assert.deepEqual(updates, [
      ROLLOUT_ARGV.serviceUpdate(TARGET, IMAGE, COMMIT),
      ...TARGET.jobNames.map((job) => ROLLOUT_ARGV.jobUpdate(TARGET, job, IMAGE, COMMIT)),
    ]);
    assert.deepEqual(updates[0].slice(0, 7), ["gcloud", "run", "services", "update", TARGET.service, `--image=${IMAGE}`,
      `--update-env-vars=DEPLOYMENT_SOURCE_COMMIT=${COMMIT}`]);
    assert.equal(estate.state.service.spec.template.spec.containers[0].image, IMAGE);
    for (const job of TARGET.jobNames) {
      assert.deepEqual(estate.state.jobs[job].spec.template.spec.template.spec.containers[0].env,
        [{ name: "DEPLOYMENT_SOURCE_COMMIT", value: COMMIT }]);
    }
    const describes = estate.calls.filter((argv) => argv[3] === "describe").length;
    assert.equal(describes, 1 + 1 + TARGET.jobNames.length, "the baseline, then the service and every job read back");
    const firstUpdate = estate.calls.findIndex((argv) => argv[3] === "update");
    assert.ok(estate.calls.findIndex((argv) => argv.slice(0, 4).join(" ") === "gcloud scheduler jobs list") < firstUpdate,
      "the jobs are quiescent before anything moves");
    assert.deepEqual(estate.calls.slice(-2).map((argv) => argv.join(" ")), [
      "node scripts/gcp-infra.mjs readback --require-clean --environment=production",
      ROLLOUT_ARGV.jobExecute(TARGET, TARGET.maintenanceJob).join(" "),
    ], "the infrastructure readback, then one maintenance pass (the first-roll ready path), close the commands");
    assert.deepEqual(estate.requests.map(({ url, init }) => [url, init.method, init.credentials, init.redirect]),
      [["https://tibotattle.com/api/health", "GET", "omit", "error"]], "then the public health, through the gcp edge");
    assert.equal(estate.calls.some((argv) => argv.includes("print-identity-token")), false);
    assert.deepEqual(lock.events, ["acquire", "assert", "release"]);
    assert.equal(lock.records[0].previousSourceCommit, OTHER_COMMIT);
    assert.equal(receipt.image, IMAGE);
    assert.deepEqual(receipt.jobs, TARGET.jobNames);
    assert.equal(receipt.previousSourceCommit, OTHER_COMMIT);
    assert.deepEqual(receipt.edge, { mode: "gcp", edgeCommit: EDGE_COMMIT, contractBlob: "a".repeat(40),
      capturedAt: new Date(NOW).toISOString() });
    assert.deepEqual(receipt.servedCommit, { path: "public-health", origin: "https://tibotattle.com", sourceCommit: COMMIT });
    assert.deepEqual(receipt.pausedTriggers, [`${TARGET.jobNames[1]}-trigger`]);
    assert.equal(receipt.secondsSinceMigrate, 120);
    assert.equal(imageReference(TARGET, DIGEST), IMAGE);
    assert.equal(estate.calls.some((argv) => argv.includes("delete")), false, "no deletes");
  });

test("outside gcp mode the served commit is read through the EP-6 verifier path on the service's own origin", async (t) => {
  for (const [edge, mode] of [[preEdgeLive, "unset"], [workerLive, "worker"], [fencedLive, "fenced"]]) {
    const paths = await migrated(t, { edge });
    const estate = fakeEstate();
    const receipt = await runRollout(executeRoll(paths), dependencies(estate, fakeLock()));
    assert.equal(receipt.edge.mode, mode);
    assert.equal(receipt.edge.contractBlob, "a".repeat(40), "D-BLOB binds the origin to the live edge in every mode");
    assert.deepEqual(estate.calls.filter((argv) => argv.includes("print-identity-token")), [ROLLOUT_ARGV.identityToken(TARGET)]);
    assert.deepEqual(estate.requests.map(({ url }) => url), [`${SERVICE_URL}/api/health`, `${SERVICE_URL}/api/ready`]);
    assert.equal(estate.requests[0].init.headers["x-serverless-authorization"], `Bearer ${TOKEN}`);
    assert.deepEqual(receipt.servedCommit, { path: "origin-verifier", origin: SERVICE_URL, sourceCommit: COMMIT });
    assert.equal(JSON.stringify(receipt).includes(TOKEN), false, "the identity token never reaches the receipt");
  }
});

test("a staging roll verifies the staging-edge Worker in gcp mode against staging's own domains and public origin", async (t) => {
  const paths = await migrated(t, { target: STAGING_TARGET, edge: stagingGcpLive });
  const estate = fakeEstate({ target: STAGING_TARGET });
  const receipt = await runRollout(executeRoll(paths, "staging"), dependencies(estate, fakeLock()));
  assert.equal(receipt.environment, "staging");
  assert.deepEqual(estate.requests.map(({ url }) => url), ["https://staging.tibotattle.com/api/health"]);
  // A production capture is not this environment's edge.
  await writeFile(paths.edgeLive, capture(gcpLive));
  await assert.rejects(runRollout(executeRoll(paths, "staging"), dependencies(fakeEstate({ target: STAGING_TARGET }), fakeLock())),
    isCode("ROLLOUT_EDGE_LIVE_TARGET_MISMATCH"));
});

test("a target with no maintenance Job (D-OPS4) has its origin-verifier roll refused before any command or lock",
  async (t) => {
    assert.deepEqual(validateRolloutTarget(NO_MAINTENANCE_TARGET, "staging"), NO_MAINTENANCE_TARGET);
    assert.equal(NO_MAINTENANCE_TARGET.jobNames.includes("tibotattle-staging-maintenance"), false);
    // A target that names a maintenance Job outside its jobNames is the
    // merge hazard D-CRB closed: refused as invalid, never rolled.
    assert.throws(() => validateRolloutTarget({ ...NO_MAINTENANCE_TARGET, maintenanceJob: "tibotattle-staging-maintenance" },
      "staging"), isCode("ROLLOUT_TARGET_INVALID"));
    const paths = await migrated(t, { target: NO_MAINTENANCE_TARGET, edge: stagingGcpLive });
    await writeFile(paths.edgeLive, capture(stagingWorkerLive));
    const lock = fakeLock();
    const estate = fakeEstate({ target: NO_MAINTENANCE_TARGET });
    await assert.rejects(runRollout(executeRoll(paths, "staging"),
      dependencies(estate, lock, { loadTarget: async () => NO_MAINTENANCE_TARGET })),
      isCode("ROLLOUT_MAINTENANCE_JOB_REQUIRED"));
    assert.deepEqual(lock.events, []);
    assert.equal(estate.calls.some((argv) => argv[0] === "gcloud" && argv[3] !== "describe"), false);
    assert.deepEqual(estate.requests, []);
  });

test("D-BLOB: roll refuses EDGE_CONTRACT_DRIFT in every edge mode, and against a pre-edge Worker with no contract", async (t) => {
  for (const edge of [preEdgeLive, workerLive, fencedLive, gcpLive]) {
    const paths = await migrated(t, { edge });
    for (const blobs of [
      { [`${COMMIT}:${CONTRACT_PATH}`]: "a".repeat(40), [`${EDGE_COMMIT}:${CONTRACT_PATH}`]: "b".repeat(40) },
      // A pre-edge Worker's commit carries no contract file.
      { [`${COMMIT}:${CONTRACT_PATH}`]: "a".repeat(40) },
      // Nor may a candidate without one deploy against an edge that has one.
      { [`${EDGE_COMMIT}:${CONTRACT_PATH}`]: "a".repeat(40) },
      {},
    ]) {
      const estate = fakeEstate({ blobs });
      const lock = fakeLock();
      await assert.rejects(runRollout(executeRoll(paths), dependencies(estate, lock)), isCode("EDGE_CONTRACT_DRIFT"));
      assert.equal(estate.calls.every(([command]) => command === "git"), true, "only local blob reads ran");
      assert.deepEqual(lock.events, []);
      await assert.rejects(runRollout(rollArgv(paths), dependencies(fakeEstate({ blobs }), fakeLock())),
        isCode("EDGE_CONTRACT_DRIFT"), "the dry run refuses too");
    }
  }
  assert.throws(() => assertOriginContractBlob({ originCommit: COMMIT, edgeCommit: EDGE_COMMIT, readBlob: () => "x" }),
    isCode("EDGE_CONTRACT_DRIFT"), "a malformed blob id never matches");
  assert.throws(() => assertOriginContractBlob({ originCommit: "HEAD", edgeCommit: EDGE_COMMIT, readBlob: () => "a".repeat(40) }),
    isCode("EDGE_CONTRACT_DRIFT"), "only full commits are compared");
  assert.equal(assertOriginContractBlob({ originCommit: COMMIT, edgeCommit: EDGE_COMMIT, readBlob: () => "a".repeat(40) }),
    "a".repeat(40));
});

test("roll refuses EDGE_CONTRACT_DRIFT against a gcp-mode edge whose contract blob differs, before any command or lock", async (t) => {
  const paths = await migrated(t);
  for (const blobs of [
    { [`${COMMIT}:${CONTRACT_PATH}`]: "a".repeat(40), [`${EDGE_COMMIT}:${CONTRACT_PATH}`]: "b".repeat(40) },
    { [`${COMMIT}:${CONTRACT_PATH}`]: "a".repeat(40) },
  ]) {
    const estate = fakeEstate({ blobs });
    const lock = fakeLock();
    await assert.rejects(runRollout(executeRoll(paths), dependencies(estate, lock)), isCode("EDGE_CONTRACT_DRIFT"));
    assert.equal(estate.calls.every(([command]) => command === "git"), true, "only the two local blob reads ran");
    assert.deepEqual(lock.events, []);
    await assert.rejects(runRollout(rollArgv(paths), dependencies(fakeEstate({ blobs }), fakeLock())),
      isCode("EDGE_CONTRACT_DRIFT"), "the dry run refuses too");
  }
});

test("the edge capture must be fresh, of this environment's Worker, and verify for its own mode", async (t) => {
  const paths = await migrated(t);
  const refused = async (text, code) => {
    await writeFile(paths.edgeLive, text);
    const estate = fakeEstate();
    const lock = fakeLock();
    await assert.rejects(runRollout(executeRoll(paths), dependencies(estate, lock)), isCode(code), code);
    assert.deepEqual(lock.events, [], code);
    assert.equal(estate.calls.some(([command]) => command === "gcloud"), false, code);
  };
  const single = (snapshot) => ({ versions: [{ version_id: snapshot.versionId, percentage: 100 }] });
  const split = (snapshot) => ({ versions: [{ version_id: snapshot.versionId, percentage: 50 },
    { version_id: versionId(1), percentage: 50 }] });
  // A worker- or fenced-mode capture is verified too: an unverified deployment no longer passes.
  for (const edge of [workerLive, fencedLive, gcpLive, preEdgeLive]) {
    await refused(capture(edge, { deployment: {} }), "ROLLOUT_EDGE_LIVE_UNVERIFIED");
    await refused(capture(edge, { deployment: split(edge) }), "ROLLOUT_EDGE_LIVE_UNVERIFIED");
    await refused(capture(edge, { capturedAt: new Date(NOW - EDGE_CAPTURE_MAX_AGE_MS - 1_000).toISOString() }),
      "ROLLOUT_EDGE_LIVE_STALE");
  }
  await refused(capture(workerLive, { capturedAt: new Date(NOW + 10 * 60 * 1_000).toISOString() }), "ROLLOUT_EDGE_LIVE_STALE");
  await refused(capture(workerLive, { capturedAt: "2026-10-02 12:00" }), "ROLLOUT_EDGE_LIVE_INVALID");
  await refused(JSON.stringify({ schema: ROLLOUT_EDGE_LIVE_SCHEMA, snapshot: workerLive, deployment: single(workerLive) }),
    "ROLLOUT_EDGE_LIVE_INVALID");
  await refused(JSON.stringify({ ...JSON.parse(capture(gcpLive)), schema: "other" }), "ROLLOUT_EDGE_LIVE_INVALID");
  // Another environment's Worker, a moved domain or another public origin is not this edge.
  await refused(capture(stagingGcpLive), "ROLLOUT_EDGE_LIVE_TARGET_MISMATCH");
  const withoutAdmin = resnapshot(workerLive, { domains: workerLive.domains.filter(({ hostname }) => !hostname.startsWith("admin.")) });
  await refused(capture(withoutAdmin), "ROLLOUT_EDGE_LIVE_UNVERIFIED");
  await refused(capture(resnapshot(preEdgeLive, { domains: [] })), "ROLLOUT_EDGE_LIVE_UNVERIFIED");
  const otherOrigin = resnapshot(workerLive, { bindings: workerLive.bindings.map((binding) => (binding.name === "PUBLIC_ORIGIN"
    ? { ...binding, text: "https://www.tibotattle.com" } : binding)) });
  await refused(capture(otherOrigin), "ROLLOUT_EDGE_LIVE_TARGET_MISMATCH");
  const noCommit = resnapshot(workerLive, { bindings: workerLive.bindings.filter(({ name }) => name !== "DEPLOYMENT_SOURCE_COMMIT") });
  await refused(capture(noCommit), "ROLLOUT_EDGE_LIVE_INVALID");
});

test("a gcp-mode edge must forward to this service with the target's audience, checked before the lock", async (t) => {
  const paths = await migrated(t);
  for (const [estateOptions, overrides] of [
    [{ serviceUrl: "https://tibotattle-other-origin.a.run.app" }, {}],
    [{}, { loadTarget: async () => ({ ...TARGET, originAudience: "https://other-audience.example" }) }],
  ]) {
    const estate = fakeEstate(estateOptions);
    const lock = fakeLock();
    await assert.rejects(runRollout(executeRoll(paths), dependencies(estate, lock, overrides)),
      isCode("ROLLOUT_EDGE_ORIGIN_MISMATCH"));
    assert.deepEqual(lock.events, []);
    assert.equal(estate.calls.some((argv) => argv[3] === "update"), false);
  }
});

test("roll releases the lock on failure, and a readback or served-commit mismatch fails closed", async (t) => {
  const paths = await migrated(t);
  let reads = 0;
  // Fresh at the check before the lock and through preflight's audit, stale by the time the service would move.
  const staleUnderLock = () => (++reads <= 3 ? NOW : NOW + EDGE_CAPTURE_MAX_AGE_MS + 1_000);
  for (const [estateOptions, code, setup] of [
    [{ fail: "run services update" }, "ROLLOUT_SERVICE_UPDATE_FAILED"],
    [{ fail: `run jobs update ${TARGET.jobNames[1]}` }, "ROLLOUT_JOB_UPDATE_FAILED"],
    [{ staleReadback: true }, "ROLLOUT_READBACK_MISMATCH"],
    [{ infraClean: false }, "ROLLOUT_INFRA_NOT_CLEAN"],
    [{ schedulers: [trigger(TARGET.jobNames[1], "ENABLED")] }, "ROLLOUT_JOBS_NOT_PAUSED"],
    [{ executions: (job) => [{ metadata: { name: `${job}-live1` }, status: {} }] }, "ROLLOUT_JOBS_RUNNING"],
    [{}, "ROLLOUT_EDGE_LIVE_STALE", { now: staleUnderLock }],
    [{ servedCommit: OTHER_COMMIT }, "ROLLOUT_PUBLIC_HEALTH_COMMIT_MISMATCH"],
  ]) {
    const estate = fakeEstate(estateOptions);
    const lock = fakeLock();
    await assert.rejects(runRollout(executeRoll(paths), dependencies(estate, lock, setup ?? {})), isCode(code), code);
    assert.deepEqual(lock.events.filter((event) => event !== "assert"), ["acquire", "release"], code);
    if (["ROLLOUT_JOBS_NOT_PAUSED", "ROLLOUT_JOBS_RUNNING", "ROLLOUT_EDGE_LIVE_STALE"].includes(code)) {
      assert.equal(estate.calls.some((argv) => argv[3] === "update"), false, `${code}: nothing moves`);
    }
  }
  await writeFile(paths.edgeLive, capture(workerLive));
  for (const [estateOptions, code] of [
    [{ servedCommit: OTHER_COMMIT }, "ROLLOUT_ORIGIN_COMMIT_MISMATCH"],
    [{ fail: "print-identity-token" }, "EDGE_ORIGIN_IDENTITY_TOKEN_UNAVAILABLE"],
  ]) {
    const lock = fakeLock();
    await assert.rejects(runRollout(executeRoll(paths), dependencies(fakeEstate(estateOptions), lock)),
      isCode(code), code);
    assert.deepEqual(lock.events.filter((event) => event !== "assert"), ["acquire", "release"], code);
  }
});

test("the service's HOST_ORIGIN is its one run.app origin, and a gcp edge must forward to exactly it", async (t) => {
  const paths = await migrated(t);
  // HOST_ORIGIN absent, duplicated, another run.app origin or not run.app: refused before the lock.
  for (const liveEnv of [
    [{ name: "DEPLOYMENT_SOURCE_COMMIT", value: OTHER_COMMIT }],
    [{ name: "DEPLOYMENT_SOURCE_COMMIT", value: OTHER_COMMIT }, { name: "HOST_ORIGIN", value: SERVICE_URL },
      { name: "HOST_ORIGIN", value: SERVICE_URL }],
    [{ name: "DEPLOYMENT_SOURCE_COMMIT", value: OTHER_COMMIT },
      { name: "HOST_ORIGIN", value: "https://tibotattle-other-origin.a.run.app" }],
    [{ name: "DEPLOYMENT_SOURCE_COMMIT", value: OTHER_COMMIT }, { name: "HOST_ORIGIN", value: "https://tibotattle.com" }],
    [{ name: "DEPLOYMENT_SOURCE_COMMIT", value: OTHER_COMMIT }, { name: "HOST_ORIGIN", value: `${SERVICE_URL}/` }],
  ]) {
    const estate = fakeEstate({ liveEnv });
    const lock = fakeLock();
    await assert.rejects(runRollout(executeRoll(paths), dependencies(estate, lock)),
      isCode("ROLLOUT_SERVICE_HOST_ORIGIN_INVALID"), JSON.stringify(liveEnv.at(-1)));
    assert.deepEqual(lock.events, []);
    assert.equal(estate.calls.some((argv) => argv[3] === "update"), false);
  }
  // Both of Cloud Run's URL forms belong to the service, but the edge must
  // forward to the one the origin accepts (EDGE_UPSTREAM_ORIGIN === HOST_ORIGIN).
  const otherForm = "https://tibotattle-origin-synthetic-ue.a.run.app";
  const estate = fakeEstate();
  estate.state.service.metadata.annotations["run.googleapis.com/urls"] = JSON.stringify([SERVICE_URL, otherForm]);
  estate.state.service.spec.template.spec.containers[0].env = [
    { name: "DEPLOYMENT_SOURCE_COMMIT", value: OTHER_COMMIT }, { name: "HOST_ORIGIN", value: otherForm },
  ];
  const lock = fakeLock();
  await assert.rejects(runRollout(executeRoll(paths), dependencies(estate, lock)), isCode("ROLLOUT_EDGE_ORIGIN_MISMATCH"));
  assert.deepEqual(lock.events, []);
});

test("first roll: the maintenance pass runs before verification, and the verifier path needs a maintenance Job", async (t) => {
  // Outside gcp mode the EP-6 verifier needs /api/ready to read ready, which
  // only a lifecycle pass makes true: the pass runs between the readback and
  // the verifier's token. The estates carry matching contract blobs, which
  // D-BLOB requires in every edge mode.
  const paths = await migrated(t);
  await writeFile(paths.edgeLive, capture(workerLive));
  const estate = fakeEstate({});
  await runRollout(executeRoll(paths), dependencies(estate, fakeLock()));
  const joined = estate.calls.map((argv) => argv.join(" "));
  const pass = joined.indexOf(ROLLOUT_ARGV.jobExecute(TARGET, TARGET.maintenanceJob).join(" "));
  const token = joined.indexOf(ROLLOUT_ARGV.identityToken(TARGET).join(" "));
  const readback = joined.indexOf("node scripts/gcp-infra.mjs readback --require-clean --environment=production");
  assert.ok(readback >= 0 && readback < pass && pass < token, "readback, then the pass, then the verifier");
  assert.equal(joined.filter((line) => line.startsWith("gcloud run jobs execute")).length, 1);
  // Without a maintenance Job the origin-verifier path is refused before any command or lock.
  const noJob = { ...TARGET, maintenanceJob: null };
  const lock = fakeLock();
  const bare = fakeEstate({ target: noJob });
  await assert.rejects(runRollout(executeRoll(paths), dependencies(bare, lock, { loadTarget: async () => noJob })),
    isCode("ROLLOUT_MAINTENANCE_JOB_REQUIRED"));
  assert.deepEqual(lock.events, []);
  assert.equal(bare.calls.some((argv) => argv[0] === "gcloud" && argv[3] !== "describe"), false);
  // A failed pass fails the roll closed and releases the lock.
  const failed = fakeEstate({ fail: `run jobs execute ${TARGET.maintenanceJob}` });
  const failedLock = fakeLock();
  await assert.rejects(runRollout(executeRoll(paths), dependencies(failed, failedLock)),
    isCode("ROLLOUT_MAINTENANCE_PASS_FAILED"));
  assert.deepEqual(failedLock.events.filter((event) => event !== "assert"), ["acquire", "release"]);
  const unsucceeded = fakeEstate({ executionStatus: { succeededCount: 0, failedCount: 1 } });
  await assert.rejects(runRollout(executeRoll(paths), dependencies(unsucceeded, fakeLock())),
    isCode("ROLLOUT_MAINTENANCE_PASS_FAILED"));
  // In gcp mode the public health path needs no readiness, so a missing job
  // is reported by the dry run, never refused.
  await writeFile(paths.edgeLive, capture(gcpLive));
  const gcpEstate = fakeEstate({ target: noJob });
  await runRollout(executeRoll(paths), dependencies(gcpEstate, fakeLock(), { loadTarget: async () => noJob }));
  assert.equal(gcpEstate.calls.some((argv) => argv.join(" ").startsWith("gcloud run jobs execute")), false);
});

// ---------------------------------------------------------------------------
// Build

const BUILDER_IMAGE = /- name: (gcr\.io\/cloud-builders\/docker@sha256:[0-9a-f]{64})/u
  .exec(await readFile(new URL("../cloud-run/cloudbuild.production.yaml", import.meta.url), "utf8"))[1];
const BUILD_TAG = `${TARGET.imageRepository}:source-${COMMIT}`;
const ARCHIVE_BYTES = Buffer.from("synthetic source archive bytes\n");
const ARCHIVE_SHA256 = createHash("sha256").update(ARCHIVE_BYTES).digest("hex");
const SOURCE = Object.freeze({ bucket: `${PROJECT}_cloudbuild`, object: "source/1759406400.000000-0a1b2c3d.gz",
  generation: "1759406400000001" });

function cloudBuild(archiveSha256 = ARCHIVE_SHA256) {
  const id = "00000000-0000-4000-8000-0000000000b1";
  return {
    id,
    projectId: PROJECT,
    name: `projects/123456789012/locations/us-east1/builds/${id}`,
    status: "SUCCESS",
    serviceAccount: `projects/${PROJECT}/serviceAccounts/${TARGET.builderServiceAccount}`,
    options: { logging: "CLOUD_LOGGING_ONLY", sourceProvenanceHash: ["SHA256"], requestedVerifyOption: "VERIFIED" },
    steps: [{ name: BUILDER_IMAGE, args: ["build", "--file=apps/worker/cloud-run/Dockerfile", `--tag=${BUILD_TAG}`, "."],
      status: "SUCCESS" }],
    images: [BUILD_TAG],
    substitutions: { _IMAGE: BUILD_TAG },
    source: { storageSource: { ...SOURCE } },
    sourceProvenance: {
      resolvedStorageSource: { ...SOURCE },
      fileHashes: { [`gs://${SOURCE.bucket}/${SOURCE.object}#${SOURCE.generation}`]: {
        fileHash: [{ type: "SHA256", value: Buffer.from(archiveSha256, "hex").toString("base64") }],
      } },
    },
    results: {
      images: [{ name: BUILD_TAG, digest: DIGEST }],
      buildStepImages: [BUILDER_IMAGE.slice(BUILDER_IMAGE.indexOf("@") + 1)],
    },
  };
}

test("build writes the audited archive, submits that file and qualifies the build against the archive's own sha256",
  async (t) => {
    const estate = fakeEstate();
    const lock = fakeLock();
    const directory = await mkdtemp(join(tmpdir(), "w2-opsdb-build-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let rendered = null;
    let submitted = null;
    const runWith = (build, { archiveSha256 = ARCHIVE_SHA256 } = {}) => (argv) => {
      if (argv[0] === "node" && argv[1] === "scripts/cloud-run-build-archive.mjs") {
        estate.calls.push(argv);
        const output = argv[2].slice("--output=".length);
        writeFileSync(output, ARCHIVE_BYTES, { flag: "wx", mode: 0o600 });
        return { status: 0, stdout: JSON.stringify({ status: "ok", mode: "create", output, sourceArchiveSha256: archiveSha256,
          sourceContentDigest: "c".repeat(64) }) };
      }
      if (argv.slice(0, 3).join(" ") === "gcloud builds submit") {
        estate.calls.push(argv);
        submitted = readFileSync(argv[3]);
        rendered = readFileSync(argv.find((arg) => arg.startsWith("--config=")).slice("--config=".length), "utf8");
        return { status: 0, stdout: JSON.stringify(build) };
      }
      return estate.run(argv);
    };
    const buildArgv = ["build", "--environment=production", `--commit=${COMMIT}`, `--authorize=build:production:${COMMIT}`,
      "--execute"];
    const receipt = await runRollout(buildArgv, dependencies(estate, lock, { run: runWith(cloudBuild()), tmpdir: () => directory }));
    assert.deepEqual({ digest: receipt.digest, image: receipt.image, buildId: receipt.buildId,
      sourceArchiveSha256: receipt.sourceArchiveSha256, sourceGeneration: receipt.sourceGeneration },
    { digest: DIGEST, image: IMAGE, buildId: cloudBuild().id, sourceArchiveSha256: ARCHIVE_SHA256,
      sourceGeneration: SOURCE.generation });
    assert.deepEqual(submitted, ARCHIVE_BYTES, "the archive file itself is what gcloud uploads");
    assert.match(rendered, new RegExp(`serviceAccount: projects/${PROJECT}/serviceAccounts/${TARGET.builderServiceAccount}`, "u"));
    assert.match(rendered, new RegExp(`_IMAGE: ${TARGET.imageRepository}:source-${COMMIT}`, "u"));
    assert.doesNotMatch(rendered, /\$\{(?!_IMAGE\})/u, "every placeholder but the Cloud Build substitution is rendered");
    assert.deepEqual(lock.events, ["acquire", "assert", "release"]);
    const sourceUri = `gs://${SOURCE.bucket}/${SOURCE.object}#${SOURCE.generation}`;
    const edits = [
      (build) => { build.status = "FAILURE"; },
      (build) => { delete build.options.requestedVerifyOption; },
      (build) => { build.options.substitutionOption = "ALLOW_LOOSE"; },
      (build) => { build.id = "build-1"; },
      (build) => { build.projectId = "other-project-x"; },
      (build) => { build.name = build.name.replace("us-east1", "us-west1"); },
      (build) => { build.buildTriggerId = "trigger"; },
      (build) => { build.steps[0].name = "gcr.io/cloud-builders/docker:latest"; },
      (build) => { build.steps[0].args = ["build", "--tag=other", "."]; },
      (build) => { build.results.buildStepImages = [`sha256:${"9".repeat(64)}`]; },
      (build) => { build.results.images[0].name = `${TARGET.imageRepository}:other`; },
      (build) => { build.source.storageSource.generation = "1759406400000002"; },
      (build) => { build.sourceProvenance.resolvedStorageSource.object = "source/other.gz"; },
      (build) => { build.sourceProvenance.fileHashes[sourceUri].fileHash[0].value = Buffer.alloc(32).toString("base64"); },
      (build) => { build.sourceProvenance.fileHashes[`${sourceUri}x`] = build.sourceProvenance.fileHashes[sourceUri]; },
      (build) => { build.sourceProvenance.fileHashes[sourceUri].fileHash = [{ type: "MD5", value: "AAAAAAAAAAAAAAAAAAAAAA==" }]; },
      (build) => { delete build.sourceProvenance; },
    ];
    for (const edit of edits) {
      const bad = structuredClone(cloudBuild());
      edit(bad);
      const badLock = fakeLock();
      await assert.rejects(runRollout(buildArgv, dependencies(estate, badLock, { run: runWith(bad), tmpdir: () => directory })),
        isCode("ROLLOUT_BUILD_PROVENANCE_UNQUALIFIED"), edit.toString());
      assert.deepEqual(badLock.events.filter((event) => event !== "assert"), ["acquire", "release"]);
    }
    // The archive tool's receipt must name the bytes it wrote; nothing is submitted otherwise.
    submitted = null;
    await assert.rejects(runRollout(buildArgv, dependencies(estate, fakeLock(), {
      run: runWith(cloudBuild(), { archiveSha256: "e".repeat(64) }), tmpdir: () => directory })),
    isCode("ROLLOUT_BUILD_ARCHIVE_MISMATCH"));
    assert.equal(submitted, null);
    // Cloud Build readbacks also encode the hash as base64url.
    const urlSafe = structuredClone(cloudBuild());
    urlSafe.sourceProvenance.fileHashes[sourceUri].fileHash[0].value = Buffer.from(ARCHIVE_SHA256, "hex").toString("base64url");
    assert.equal(assessProductionBuild(urlSafe, { target: TARGET, commit: COMMIT, builderImage: BUILDER_IMAGE,
      archiveSha256: ARCHIVE_SHA256 }).digest, DIGEST);
  });

test("an incomplete committed desired state fails every verb closed, a complete one dry-runs without a call, and error codes stay content-free",
  async () => {
  // The default loader reaches the OPS-2 manifest's rolloutTarget, which reads
  // only the committed desired state. A manifest refusal (here OWN-5's
  // placeholders, unfilled) is reported as ROLLOUT_INFRA_MANIFEST_UNAVAILABLE
  // before anything runs.
  const unfilledText = unfilledProductionText();
  const unfilledLoader = async (environment) => (await import("./gcp-ops-infra-manifest.mjs"))
    .rolloutTarget(environment, { readFile: () => unfilledText });
  await assert.rejects(unfilledLoader("production"), isCode("DESIRED_STATE_PLACEHOLDER_UNFILLED:project"));
  await assert.rejects(runRollout(["preflight", "--environment=production", `--commit=${COMMIT}`,
    "--backup-audit=/synthetic/audit.json"], { run: () => assert.fail("never"), loadTarget: unfilledLoader }),
  isCode("ROLLOUT_INFRA_MANIFEST_UNAVAILABLE"));
  // PROD-PREP filled production (round 13): its committed target validates,
  // a dry run calls nothing, and a mutating verb names the production lock.
  const production = await loadRolloutTargetFromInfraManifest("production");
  assert.deepEqual(validateRolloutTarget(production, "production"), production);
  assert.deepEqual([production.project, production.region, production.service],
    ["tibotattle-prod", "us-east1", "tibotattle-origin"]);
  const productionBuild = await runRollout(["build", "--environment=production", `--commit=${COMMIT}`],
    { run: () => assert.fail("never"), fetch: () => assert.fail("never") });
  assert.deepEqual([productionBuild.status, productionBuild.environment, productionBuild.lockRef],
    ["dry-run", "production", "refs/heads/codex/production-deployment-lock"]);
  // Staging's verifier operator is named (owner decision, 2026-10-02 round
  // 9), so its committed state now yields a target that OPS-10 validates for
  // the staging plane. The manifest check holds the unassigned-operator
  // refusal (rolloutTargetFromDesiredState). A dry run still runs nothing.
  const staging = await loadRolloutTargetFromInfraManifest("staging");
  assert.deepEqual(validateRolloutTarget(staging, "staging"), staging);
  assert.match(staging.verifierServiceAccount, /^tibotattle-staging-verifier@/u);
  const dryRun = await runRollout(["preflight", "--environment=staging", `--commit=${COMMIT}`,
    "--backup-audit=/synthetic/audit.json"], { run: () => assert.fail("never"), fetch: () => assert.fail("never") });
  assert.equal(dryRun.status, "dry-run");
  assert.equal(dryRun.environment, "staging");
  assert.equal(dryRun.service, staging.service);
  assert.equal(safeRolloutErrorCode({ code: "EDGE_CONTRACT_DRIFT" }), "EDGE_CONTRACT_DRIFT");
  assert.equal(safeRolloutErrorCode({ code: "PRODUCTION_COORDINATION_BUSY" }), "PRODUCTION_COORDINATION_BUSY");
  assert.equal(safeRolloutErrorCode({ code: "EDGE_ORIGIN_VERIFIER_UNREACHABLE" }), "EDGE_ORIGIN_VERIFIER_UNREACHABLE");
  assert.equal(safeRolloutErrorCode(new Error("gcloud: permission denied on tibotattle-primary")), "ROLLOUT_FAILED");
  assert.equal(safeRolloutErrorCode({ code: "ENOENT" }), "ROLLOUT_FAILED");
});

test("preflight executes read-only: clean tree, infrastructure readback, a fresh non-breach audit and the scheduled jobs",
  async (t) => {
    const paths = await workspace(t);
    const estate = fakeEstate();
    const lock = fakeLock();
    const argv = ["preflight", "--environment=production", `--commit=${COMMIT}`, `--backup-audit=${paths.audit}`, "--execute"];
    const result = await runRollout(argv, dependencies(estate, lock));
    assert.equal(result.status, "ok");
    assert.equal(result.backupAudit.verdict, "ok");
    assert.deepEqual(result.scheduledJobs, { triggers: [{ name: `${TARGET.jobNames[1]}-trigger`, job: TARGET.jobNames[1],
      state: "PAUSED" }], running: [], quiescent: true });
    assert.deepEqual(lock.events, [], "preflight changes nothing and takes no lock");
    assert.deepEqual(estate.calls.map((call) => call.slice(0, 4).join(" ")), ["git status --porcelain=v1 --untracked-files=all",
      "git rev-parse --verify HEAD", "node scripts/gcp-infra.mjs readback --require-clean", "gcloud scheduler jobs list",
      ...TARGET.jobNames.map(() => "gcloud run jobs executions")]);
    // Preflight reports a live trigger and a running execution; only migrate and roll refuse them.
    const busy = await runRollout(argv, dependencies(fakeEstate({ schedulers: [trigger(TARGET.jobNames[1], "ENABLED")],
      executions: (job) => [{ metadata: { name: `${job}-live1` }, status: {} }] }), fakeLock()));
    assert.equal(busy.scheduledJobs.quiescent, false);
    assert.deepEqual(busy.scheduledJobs.running.map(({ job }) => job), TARGET.jobNames);
  });

// ---------------------------------------------------------------------------
// STG-LOCK (owner decision 2026-10-02, round 9): staging coordinates on its own
// ref and never on the production lock. Git is a fake here: no transport runs.

const APPROVED_REMOTE = "https://github.com/adamallcock/tibotattle.git";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** An in-memory git that models the remote refs the lock reads and pushes. */
function fakeGit() {
  const remoteRefs = new Map();
  const calls = [];
  const messages = new Map();
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const spawn = (command, args, options) => {
    assert.equal(command, "git");
    calls.push([...args]);
    const verb = args.find((arg) => !arg.startsWith("-") && !arg.includes("="));
    if (args.join(" ") === "remote get-url --push --all origin") return ok(`${APPROVED_REMOTE}\n`);
    if (verb === "ls-remote") {
      const ref = args.at(-1);
      return ok(remoteRefs.has(ref) ? `${remoteRefs.get(ref)}\t${ref}\n` : "");
    }
    if (verb === "hash-object") return ok(`${EMPTY_TREE}\n`);
    if (verb === "commit-tree") {
      const sha = createHash("sha1").update(options.input).digest("hex");
      messages.set(sha, options.input);
      return ok(`${sha}\n`);
    }
    if (verb === "push") {
      assert.equal(args.at(-2), APPROVED_REMOTE);
      const [source, ref] = args.at(-1).split(":");
      const lease = args.find((arg) => arg.startsWith("--force-with-lease="));
      assert.equal(lease, `--force-with-lease=${ref}:${source === "" ? remoteRefs.get(ref) : ""}`);
      if (source === "") remoteRefs.delete(ref);
      else remoteRefs.set(ref, source);
      return ok();
    }
    return assert.fail(`unexpected git ${args.join(" ")}`);
  };
  return { spawn, calls, messages, remoteRefs };
}

const gitLockFactory = (git) => (options) => createEnvironmentDeploymentLock({ ...options, spawn: git.spawn });
const pushedRefs = (git) => git.calls.filter((args) => args.includes("push")).map((args) => args.at(-1).split(":")[1]);

test("STG-LOCK: a dry run of each mutating verb prints its environment's exact lock ref; preflight takes no lock", async (t) => {
  for (const [target, ref] of [[TARGET, "refs/heads/codex/production-deployment-lock"],
    [STAGING_TARGET, "refs/heads/codex/staging-deployment-lock"]]) {
    const environment = target.environment;
    const paths = await workspace(t, target);
    const estate = fakeEstate({ target });
    const lock = fakeLock();
    const build = await runRollout(["build", `--environment=${environment}`, `--commit=${COMMIT}`], dependencies(estate, lock));
    assert.equal(build.lockRef, ref, environment);
    const migrate = await runRollout(migrateArgv(paths, [], environment), dependencies(estate, lock));
    assert.equal(migrate.lockRef, ref, environment);
    const preflight = await runRollout(["preflight", `--environment=${environment}`, `--commit=${COMMIT}`,
      `--backup-audit=${paths.audit}`], dependencies(estate, lock));
    assert.equal(Object.hasOwn(preflight, "lockRef"), false);
    assert.deepEqual([estate.calls, lock.events, lock.refs], [[], [], []], "a dry run takes no lock");
  }
  const migratedPaths = await migrated(t, { target: STAGING_TARGET, edge: stagingGcpLive });
  const roll = await runRollout(rollArgv(migratedPaths, [], "staging"),
    dependencies(fakeEstate({ target: STAGING_TARGET }), fakeLock()));
  assert.equal(roll.lockRef, STAGING_LOCK_REF);
});

test("STG-LOCK: staging migrate and roll push only refs/heads/codex/staging-deployment-lock, through the real lock over a fake git", async (t) => {
  const paths = await workspace(t, STAGING_TARGET);
  const git = fakeGit();
  const lockEvents = [];
  await runRollout(executeMigrate(paths, "staging"), dependencies(fakeEstate({ target: STAGING_TARGET }), fakeLock(),
    { lockFactory: gitLockFactory(git), lockEvents }));
  await writeFile(paths.edgeLive, capture(stagingGcpLive));
  const receipt = await runRollout(executeRoll(paths, "staging"), dependencies(fakeEstate({ target: STAGING_TARGET }), fakeLock(),
    { lockFactory: gitLockFactory(git), lockEvents }));
  assert.equal(receipt.environment, "staging");
  assert.deepEqual(lockEvents, ["acquired", "released", "acquired", "released"]);
  assert.deepEqual(pushedRefs(git), [STAGING_LOCK_REF, STAGING_LOCK_REF, STAGING_LOCK_REF, STAGING_LOCK_REF]);
  assert.equal(git.calls.some((args) => args.some((arg) => arg.includes("production-deployment-lock"))), false,
    "staging never reads or touches the production lock");
  assert.deepEqual(git.calls.filter((args) => args.includes("ls-remote")).map((args) => args.at(-1)).filter((ref) => ref !== STAGING_LOCK_REF), []);
  assert.equal(git.remoteRefs.size, 0, "the staging lock is released");
  for (const message of git.messages.values()) assert.equal(JSON.parse(message).schema, "staging-deployment-lock-v1");
});

test("STG-LOCK: production keeps the production ref and its schema-1 owner record, byte for byte", async (t) => {
  const paths = await workspace(t);
  const git = fakeGit();
  await runRollout(executeMigrate(paths), dependencies(fakeEstate(), fakeLock(), { lockFactory: gitLockFactory(git) }));
  assert.deepEqual(pushedRefs(git), [PRODUCTION_LOCK_REF, PRODUCTION_LOCK_REF]);
  assert.equal(git.calls.some((args) => args.some((arg) => arg.includes("staging-deployment-lock"))), false);
  assert.deepEqual([...git.messages.values()].map((message) => JSON.parse(message)), [{ schema: 1,
    id: "00000000-0000-4000-8000-000000000001", sourceCommit: COMMIT, previousSourceCommit: OTHER_COMMIT }]);
  const [owner] = git.messages.keys();
  const pushes = git.calls.filter((args) => args.includes("push"));
  assert.deepEqual(pushes, [
    ["-c", "push.followTags=false", "push", "--porcelain", `--force-with-lease=${PRODUCTION_LOCK_REF}:`, APPROVED_REMOTE,
      `${owner}:${PRODUCTION_LOCK_REF}`],
    ["-c", "push.followTags=false", "push", "--porcelain", `--force-with-lease=${PRODUCTION_LOCK_REF}:${owner}`, APPROVED_REMOTE,
      `:${PRODUCTION_LOCK_REF}`],
  ]);
});

test("STG-LOCK: a lock reporting another environment's ref is refused before any owner, command past the checkout, or push", async (t) => {
  for (const [target, wrongRef] of [[STAGING_TARGET, PRODUCTION_LOCK_REF], [TARGET, STAGING_LOCK_REF]]) {
    const paths = await workspace(t, target);
    const lock = fakeLock({ reportRef: wrongRef });
    await assert.rejects(runRollout(executeMigrate(paths, target.environment), dependencies(fakeEstate({ target }), lock)),
      isCode("ROLLOUT_LOCK_REF_MISMATCH"), target.environment);
    assert.deepEqual([lock.events, lock.records], [[], []], target.environment);
  }
  // The real factory refuses a crossed pair itself, with a content-free code.
  const git = fakeGit();
  for (const [environment, ref] of [["staging", PRODUCTION_LOCK_REF], ["production", STAGING_LOCK_REF]]) {
    assert.throws(() => gitLockFactory(git)({ environment, ref, repositoryRoot: "/unused" }),
      isCode("DEPLOYMENT_COORDINATION_REF_MISMATCH"));
  }
  assert.throws(() => gitLockFactory(git)({ environment: "test", ref: STAGING_LOCK_REF, repositoryRoot: "/unused" }),
    isCode("DEPLOYMENT_COORDINATION_ENVIRONMENT_INVALID"));
  assert.deepEqual(git.calls, [], "refused before Git access");
  assert.equal(safeRolloutErrorCode({ code: "DEPLOYMENT_COORDINATION_REF_MISMATCH" }), "DEPLOYMENT_COORDINATION_REF_MISMATCH");
  assert.equal(safeRolloutErrorCode({ code: "STAGING_COORDINATION_BUSY" }), "STAGING_COORDINATION_BUSY");
  // An unknown environment never reaches a lock: the argument parser refuses it first.
  assert.throws(() => parseRolloutArguments(["build", "--environment=test", `--commit=${COMMIT}`]), isCode("ROLLOUT_ENVIRONMENT_INVALID"));
});

test("the CLI entry finishes: no top-level await deadlocks the manifest's import cycle back to this module", () => {
  // gcp-ops-infra-manifest.mjs -> gcp-fastpath-test-deploy.mjs -> this module.
  // With a top-level await at the entry, Node exited 13 before any verb ran.
  for (const environment of ["staging", "production"]) {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "gcp-production-rollout.mjs"), "build",
      `--environment=${environment}`, `--commit=${COMMIT}`],
    { encoding: "utf8", env: { PATH: "/nonexistent-gcloud-guard" }, timeout: 60_000 });
    assert.equal(result.status, 0, `${environment}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/u);
    const output = JSON.parse(result.stdout);
    assert.deepEqual([output.status, output.verb, output.environment, output.lockRef],
      ["dry-run", "build", environment, `refs/heads/codex/${environment}-deployment-lock`]);
  }
});

// ---------------------------------------------------------------------------
// capture-edge: the writer of the capture roll reads. Fakes only: the
// provider factory, the inventory reader and the clock are injected, and no
// request, lock, gcloud or git process ever runs.

const ACCOUNT_ID = "0a".repeat(16);
const INVENTORY_SHA256 = "e".repeat(64);

/** A fresh capture workspace outside the repository, with a synthetic repository root beside it. */
async function captureWorkspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "edge-capture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, "repository");
  await mkdir(repository);
  return { directory, repository, output: join(directory, "out", "edge-live.json"),
    inventory: join(directory, "inventory.json") };
}

/** Dependencies for capture-edge: a provider over `snapshot`, and recorders proving no lock or command runs. */
function captureDependencies(space, snapshot, { identity, now = () => NOW, onCapture, inventory } = {}) {
  const calls = { provider: [], inventory: [], run: 0, lock: 0, fetch: 0 };
  return {
    calls,
    dependencies: {
      now,
      repositoryRoot: space.repository,
      readInventory: async (path, sha) => {
        calls.inventory.push([path, sha]);
        return inventory !== undefined ? inventory : { accountId: ACCOUNT_ID, workerName: identity ?? snapshot.workerName };
      },
      liveProviderFactory: (options) => {
        calls.provider.push(options);
        return {
          async capture() {
            await onCapture?.();
            return { ...inventoryOf(snapshot), accountId: options.accountId, capturedAt: "ignored" };
          },
        };
      },
      run: () => { calls.run += 1; throw new Error("no command"); },
      lockFactory: () => { calls.lock += 1; throw new Error("no lock"); },
      fetch: () => { calls.fetch += 1; throw new Error("no request"); },
      loadTarget: async () => { throw new Error("no target"); },
    },
  };
}

const captureArgv = (space, environment = "production", extra = ["--execute"]) => [ROLLOUT_EDGE_CAPTURE_VERB,
  `--environment=${environment}`, `--inventory=${space.inventory}`, `--inventory-sha256=${INVENTORY_SHA256}`,
  `--output=${space.output}`, ...extra];

/** The capture's snapshot as the provider inventory canonicalizes it (account id included). */
const asAccount = (snapshot) => resnapshot(snapshot, { accountId: ACCOUNT_ID });

async function absent(path) {
  return (await lstat(path).catch(() => null)) === null;
}

test("capture-edge writes exactly the capture roll reads, 0600, verified as roll verifies it, for both environments",
  async (t) => {
    for (const [environment, edge, target] of [
      ["production", gcpLive, TARGET], ["production", workerLive, TARGET], ["production", preEdgeLive, TARGET],
      ["staging", stagingGcpLive, STAGING_TARGET], ["staging", stagingWorkerLive, STAGING_TARGET],
    ]) {
      const space = await captureWorkspace(t);
      await mkdir(join(space.directory, "out"));
      let clock = NOW - 30_000;
      // The reads take a minute of the clock.
      const { calls, dependencies } = captureDependencies(space, edge,
        { now: () => (clock += 1_000), onCapture: () => { clock += 60_000; } });
      const result = await runRollout(captureArgv(space, environment), dependencies);
      const label = `${environment} ${liveEdgeMode(edge) ?? "unset"}`;
      assert.deepEqual(Object.keys(result), ["status", "verb", "environment", "mode", "edgeCommit", "capturedAt", "sha256"]);
      assert.deepEqual([result.status, result.verb, result.environment, result.mode, result.edgeCommit],
        ["ok", "capture-edge", environment, liveEdgeMode(edge) ?? "unset", EDGE_COMMIT], label);
      // The clock before the first read: not after the reads, nor after the self-check.
      assert.equal(result.capturedAt, new Date(NOW - 29_000).toISOString(), label);
      assert.deepEqual(calls.provider, [{ accountId: ACCOUNT_ID,
        workerName: environment === "production" ? "app-usagemonitor" : "app-usagemonitor-staging-edge" }], label);
      assert.deepEqual(calls.inventory, [[space.inventory, INVENTORY_SHA256]]);
      assert.deepEqual([calls.run, calls.lock, calls.fetch], [0, 0, 0], `${label}: no command, lock or request`);
      const bytes = await readFile(space.output);
      assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
      const info = await stat(space.output);
      assert.equal(info.mode & 0o777, 0o600, label);
      assert.equal(info.nlink, 1);
      const written = JSON.parse(bytes);
      assert.deepEqual(Object.keys(written), [...ROLLOUT_EDGE_LIVE_KEYS]);
      assert.equal(written.schema, ROLLOUT_EDGE_LIVE_SCHEMA);
      assert.equal(written.capturedAt, result.capturedAt);
      assert.deepEqual(written.snapshot, asAccount(edge));
      assert.deepEqual(written.deployment, { versions: [{ version_id: edge.versionId, percentage: 100 }] });
      // Roll reads it back through its own reader and verifier, and a roll dry run accepts it.
      const verified = await verifyEdgeLiveCapture(await readEdgeLiveCaptureFile(space.output),
        { environment, nowMs: NOW });
      assert.equal(verified.mode, result.mode);
      const paths = await migrated(t, { target, edge });
      await writeFile(paths.edgeLive, bytes);
      const plan = await runRollout(rollArgv(paths, [], environment), rollDependencies(target));
      assert.deepEqual(plan.edge, { mode: result.mode, edgeCommit: EDGE_COMMIT, capturedAt: result.capturedAt }, label);
    }
  });

/** A roll dry run's own dependencies (a fake estate with matching contract blobs). */
function rollDependencies(target) {
  return dependencies(fakeEstate({ target }), fakeLock());
}

test("capture-edge refuses an existing output, a symlink, or a path in the repository before any read", async (t) => {
  const space = await captureWorkspace(t);
  await mkdir(join(space.directory, "out"));
  const victim = join(space.directory, "victim.json");
  await writeFile(victim, "victim\n");
  const cases = [
    ["existing file", async () => writeFile(space.output, "kept\n"), "ROLLOUT_EDGE_CAPTURE_OUTPUT_EXISTS"],
    ["symlink to a file", async () => symlink(victim, space.output), "ROLLOUT_EDGE_CAPTURE_OUTPUT_EXISTS"],
    ["dangling symlink", async () => symlink(join(space.directory, "nowhere.json"), space.output),
      "ROLLOUT_EDGE_CAPTURE_OUTPUT_EXISTS"],
    ["existing directory", async () => mkdir(space.output), "ROLLOUT_EDGE_CAPTURE_OUTPUT_EXISTS"],
  ];
  for (const [label, arrange, code] of cases) {
    await rm(space.output, { recursive: true, force: true });
    await arrange();
    const before = await lstat(space.output);
    const { calls, dependencies } = captureDependencies(space, gcpLive);
    await assert.rejects(runRollout(captureArgv(space), dependencies), isCode(code), label);
    assert.deepEqual(calls.provider, [], `${label}: refused before any read`);
    assert.equal((await lstat(space.output)).mtimeMs, before.mtimeMs, label);
  }
  assert.equal(await readFile(victim, "utf8"), "victim\n", "a symlink's target is never written");
  await rm(space.output, { recursive: true, force: true });
  // Inside the repository: directly, through a symlinked parent, and the real checkout by default.
  await mkdir(join(space.repository, "evidence"));
  await symlink(join(space.repository, "evidence"), join(space.directory, "linked"));
  for (const output of [join(space.repository, "edge.json"), join(space.repository, "evidence", "edge.json"),
    join(space.directory, "linked", "edge.json")]) {
    const { calls, dependencies } = captureDependencies(space, gcpLive);
    await assert.rejects(runRollout(captureArgv({ ...space, output }), dependencies),
      isCode("ROLLOUT_EDGE_CAPTURE_OUTPUT_IN_REPOSITORY"), output);
    assert.deepEqual(calls.provider, []);
  }
  assert.deepEqual(await readdir(join(space.repository, "evidence")), []);
  const inCheckout = join(REPOSITORY_ROOT, "apps", "worker", `edge-capture-${process.pid}.json`);
  t.after(() => rm(inCheckout, { force: true }));
  const { dependencies: checkout } = captureDependencies(space, gcpLive);
  delete checkout.repositoryRoot;
  await assert.rejects(runRollout(captureArgv({ ...space, output: inCheckout }), checkout),
    isCode("ROLLOUT_EDGE_CAPTURE_OUTPUT_IN_REPOSITORY"));
  assert.equal(await absent(inCheckout), true);
  // A missing parent directory is refused too.
  const { dependencies: orphan } = captureDependencies(space, gcpLive);
  await assert.rejects(runRollout(captureArgv({ ...space, output: join(space.directory, "missing", "edge.json") }), orphan),
    isCode("ROLLOUT_EDGE_CAPTURE_OUTPUT_INVALID"));
});

test("capture-edge refuses an output in any git checkout: another checkout, a worktree, a .git directory", async (t) => {
  const space = await captureWorkspace(t);
  // A synthetic main checkout (a .git directory) and a linked worktree (a .git file) beside the repository root.
  const main = join(space.directory, "main");
  await mkdir(join(main, ".git", "objects"), { recursive: true });
  await mkdir(join(main, "evidence", "deep"), { recursive: true });
  const worktree = join(space.directory, "worktree");
  await mkdir(worktree);
  await writeFile(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "worktree")}\n`);
  await symlink(join(main, "evidence"), join(space.directory, "to-main"));
  for (const output of [join(main, "edge.json"), join(main, "evidence", "deep", "edge.json"),
    join(main, ".git", "edge.json"), join(main, ".git", "objects", "edge.json"), join(worktree, "edge.json"),
    join(space.directory, "to-main", "edge.json")]) {
    const { calls, dependencies } = captureDependencies(space, gcpLive);
    await assert.rejects(runRollout(captureArgv({ ...space, output }), dependencies),
      isCode("ROLLOUT_EDGE_CAPTURE_OUTPUT_IN_REPOSITORY"), output);
    await assert.rejects(runRollout(captureArgv({ ...space, output }, "production", []), dependencies),
      isCode("ROLLOUT_EDGE_CAPTURE_OUTPUT_IN_REPOSITORY"), `${output}: the dry run refuses it too`);
    assert.deepEqual(calls.provider, [], output);
    assert.equal(await absent(output), true, output);
  }
  // A directory beside them, with no .git above it, is accepted.
  await mkdir(join(space.directory, "out"));
  const { dependencies } = captureDependencies(space, gcpLive);
  assert.equal((await runRollout(captureArgv(space), dependencies)).status, "ok");
});

test("capture-edge refuses a parent another user could write to, as the reviewed private-output rule does",
  async (t) => {
    const space = await captureWorkspace(t);
    const out = join(space.directory, "out");
    await mkdir(out);
    t.after(() => chmod(out, 0o700).catch(() => {}));
    for (const mode of [0o777, 0o770, 0o703, 0o1777, 0o720]) {
      await chmod(out, mode);
      const { calls, dependencies } = captureDependencies(space, gcpLive);
      await assert.rejects(runRollout(captureArgv(space), dependencies), isCode("ROLLOUT_EDGE_CAPTURE_OUTPUT_UNSAFE"),
        mode.toString(8));
      assert.deepEqual(calls.provider, [], mode.toString(8));
      assert.equal(await absent(space.output), true, mode.toString(8));
    }
    await chmod(out, 0o755);
    const { dependencies } = captureDependencies(space, gcpLive);
    assert.equal((await runRollout(captureArgv(space), dependencies)).status, "ok");
    // A root-owned sticky directory (the system temporary directory) is accepted: a dry run, so nothing is written.
    const shared = await stat("/tmp").catch(() => null);
    if (shared !== null && shared.uid === 0 && (shared.mode & 0o1000) !== 0) {
      const output = join("/tmp", `edge-capture-${process.pid}-${Date.now()}.json`);
      const { calls, dependencies: dry } = captureDependencies(space, gcpLive);
      assert.equal((await runRollout(captureArgv({ ...space, output }, "production", []), dry)).status, "dry-run");
      assert.deepEqual(calls.provider, []);
      assert.equal(await absent(output), true);
    }
  });

test("capture-edge checks the output again once open: a parent swapped for a symlink during the reads is refused",
  async (t) => {
    const space = await captureWorkspace(t);
    const out = join(space.directory, "out");
    const elsewhere = join(space.directory, "elsewhere");
    await mkdir(join(space.repository, "evidence"));
    await mkdir(elsewhere);
    for (const [label, target] of [["into the repository", join(space.repository, "evidence")],
      ["to another directory", elsewhere]]) {
      await rm(out, { recursive: true, force: true });
      await rm(`${out}-away`, { recursive: true, force: true });
      await mkdir(out);
      const swap = async () => {
        await rename(out, `${out}-away`);
        await symlink(target, out);
      };
      const { dependencies } = captureDependencies(space, gcpLive, { onCapture: swap });
      await assert.rejects(runRollout(captureArgv(space), dependencies), isCode("ROLLOUT_EDGE_CAPTURE_OUTPUT_CHANGED"),
        label);
      assert.deepEqual(await readdir(target), [], `${label}: the created file is removed, nothing written through it`);
      assert.deepEqual(await readdir(`${out}-away`), [], label);
    }
  });

test("capture-edge writes with O_EXCL: a file or symlink that appears during the reads is never replaced or followed",
  async (t) => {
    const space = await captureWorkspace(t);
    await mkdir(join(space.directory, "out"));
    const victim = join(space.directory, "victim.json");
    await writeFile(victim, "victim\n");
    for (const [label, race, survived] of [
      ["file", () => writeFile(space.output, "racer\n"), async () => (await readFile(space.output, "utf8")) === "racer\n"],
      ["symlink", () => symlink(victim, space.output), async () => (await lstat(space.output)).isSymbolicLink()],
    ]) {
      await rm(space.output, { force: true });
      const { dependencies } = captureDependencies(space, gcpLive, { onCapture: race });
      await assert.rejects(runRollout(captureArgv(space), dependencies), isCode("ROLLOUT_EDGE_CAPTURE_OUTPUT_EXISTS"), label);
      assert.equal(await survived(), true, `${label}: the racer's entry is left as it was`);
      assert.equal(await readFile(victim, "utf8"), "victim\n", `${label}: nothing is written through it`);
    }
  });

test("capture-edge refuses a capture that does not verify, and writes nothing", async (t) => {
  const space = await captureWorkspace(t);
  await mkdir(join(space.directory, "out"));
  const withCron = resnapshot(gcpLive, { crons: ["*/5 * * * *"] });
  const cases = [
    // Production: a moved domain, another public origin, a gcp edge with a leftover cron.
    ["production", resnapshot(workerLive, { domains: workerLive.domains.slice(1) }), "ROLLOUT_EDGE_LIVE_UNVERIFIED"],
    ["production", resnapshot(workerLive, { bindings: workerLive.bindings.map((binding) => (binding.name === "PUBLIC_ORIGIN"
      ? { ...binding, text: "https://www.tibotattle.com" } : binding)) }), "ROLLOUT_EDGE_LIVE_TARGET_MISMATCH"],
    ["production", withCron, "ROLLOUT_EDGE_LIVE_UNVERIFIED"],
    ["production", resnapshot(workerLive, { bindings: workerLive.bindings.filter(({ name }) => name !== "DEPLOYMENT_SOURCE_COMMIT") }),
      "ROLLOUT_EDGE_LIVE_INVALID"],
    // Staging: the domain set or public origin drifted from the pinned staging edge.
    ["staging", asStaging(workerLive, { ...ROLLOUT_STAGING_EDGE_IDENTITY, domains: ["staging.tibotattle.com"] }),
      "ROLLOUT_EDGE_LIVE_UNVERIFIED"],
    ["staging", asStaging(workerLive, { ...ROLLOUT_STAGING_EDGE_IDENTITY, domains: [] }), "ROLLOUT_EDGE_LIVE_UNVERIFIED"],
    ["staging", asStaging(workerLive, { ...ROLLOUT_STAGING_EDGE_IDENTITY,
      publicOrigin: TRACKED.env.staging.vars.PUBLIC_ORIGIN }), "ROLLOUT_EDGE_LIVE_TARGET_MISMATCH"],
  ];
  for (const [environment, snapshot, code] of cases) {
    const { calls, dependencies } = captureDependencies(space, snapshot, {
      identity: environment === "production" ? "app-usagemonitor" : ROLLOUT_STAGING_EDGE_IDENTITY.workerName });
    await assert.rejects(runRollout(captureArgv(space, environment), dependencies), isCode(code), `${environment} ${code}`);
    assert.equal(calls.provider.length, 1);
    assert.equal(await absent(space.output), true, `${environment} ${code}: nothing written`);
  }
  // A provider answering for another Worker or account is refused before the snapshot is used.
  for (const answer of [{ workerName: "app-usagemonitor-staging" }, { accountId: "1b".repeat(16) }]) {
    const { dependencies } = captureDependencies(space, stagingWorkerLive, { identity: ROLLOUT_STAGING_EDGE_IDENTITY.workerName });
    const factory = dependencies.liveProviderFactory;
    dependencies.liveProviderFactory = (options) => ({
      capture: async () => ({ ...(await factory(options).capture()), ...answer }),
    });
    await assert.rejects(runRollout(captureArgv(space, "staging"), dependencies),
      isCode("ROLLOUT_EDGE_CAPTURE_TARGET_MISMATCH"), JSON.stringify(answer));
    assert.equal(await absent(space.output), true);
  }
});

test("capture-edge reads only the environment's pinned edge Worker: an inventory of another Worker is refused before any read",
  async (t) => {
    const space = await captureWorkspace(t);
    await mkdir(join(space.directory, "out"));
    // Production's pins are EP-9's, unchanged.
    assert.equal(EDGE_MODE_PRODUCTION_WORKER_NAME, "app-usagemonitor");
    assert.deepEqual([...EDGE_MODE_PRODUCTION_DOMAINS], ["admin.tibotattle.com", "tibotattle.com", "www.tibotattle.com"]);
    for (const [environment, workerName] of [
      ["staging", "app-usagemonitor-staging"], ["staging", "app-usagemonitor"],
      ["production", "app-usagemonitor-staging-edge"], ["production", "app-usagemonitor-synthetic"],
    ]) {
      const { calls, dependencies } = captureDependencies(space, gcpLive, { identity: workerName });
      await assert.rejects(runRollout(captureArgv(space, environment), dependencies),
        isCode("ROLLOUT_EDGE_CAPTURE_TARGET_MISMATCH"), `${environment} ${workerName}`);
      assert.deepEqual(calls.provider, []);
    }
    for (const inventory of [null, [], { workerName: "app-usagemonitor" }, { accountId: "A".repeat(32), workerName: "app-usagemonitor" }]) {
      const { calls, dependencies } = captureDependencies(space, gcpLive, { inventory });
      await assert.rejects(runRollout(captureArgv(space), dependencies), isCode("ROLLOUT_EDGE_CAPTURE_INVENTORY_INVALID"));
      assert.deepEqual(calls.provider, []);
    }
    assert.equal(await absent(space.output), true);
  });

test("capture-edge: closed arguments, a dry run that reads nothing remote, and the owner-private inventory reader",
  async (t) => {
    const space = await captureWorkspace(t);
    await mkdir(join(space.directory, "out"));
    const base = captureArgv(space, "production", []);
    for (const [argv, code] of [
      [base.filter((arg) => !arg.startsWith("--output=")), "ROLLOUT_ARGUMENT_MISSING"],
      [base.filter((arg) => !arg.startsWith("--inventory=")), "ROLLOUT_ARGUMENT_MISSING"],
      [base.map((arg) => (arg.startsWith("--output=") ? "--output=edge.json" : arg)), "ROLLOUT_PATH_INVALID"],
      [base.map((arg) => (arg.startsWith("--inventory=") ? "--inventory=inventory.json" : arg)), "ROLLOUT_PATH_INVALID"],
      [base.map((arg) => (arg.startsWith("--inventory-sha256=") ? "--inventory-sha256=abc" : arg)), "ROLLOUT_ARGUMENT_INVALID"],
      [base.map((arg) => (arg === "--environment=production" ? "--environment=test" : arg)), "ROLLOUT_ENVIRONMENT_INVALID"],
      [[...base, `--commit=${COMMIT}`], "ROLLOUT_ARGUMENT_INVALID"],
      [[...base, "--execute", "--execute"], "ROLLOUT_ARGUMENT_INVALID"],
    ]) {
      const { calls, dependencies } = captureDependencies(space, gcpLive);
      await assert.rejects(runRollout(argv, dependencies), isCode(code), argv.join(" "));
      assert.deepEqual([calls.provider.length, calls.inventory.length], [0, 0]);
    }
    const { calls, dependencies } = captureDependencies(space, gcpLive);
    assert.deepEqual(await runRollout(base, dependencies),
      { status: "dry-run", verb: "capture-edge", environment: "production", reads: "cloudflare-read-only" });
    assert.deepEqual([calls.provider.length, calls.inventory.length, calls.run, calls.lock, calls.fetch], [0, 1, 0, 0, 0]);
    assert.equal(await absent(space.output), true);
    // The default reader is the production deploy's owner-private inventory reader: 0600, matching sha256.
    const text = JSON.stringify({ accountId: ACCOUNT_ID, workerName: "app-usagemonitor" });
    await writeFile(space.inventory, text, { mode: 0o600 });
    const sha = createHash("sha256").update(text).digest("hex");
    const real = { repositoryRoot: space.repository };
    const argv = (hash) => base.map((arg) => (arg.startsWith("--inventory-sha256=") ? `--inventory-sha256=${hash}` : arg));
    assert.equal((await runRollout(argv(sha), real)).status, "dry-run");
    await assert.rejects(runRollout(argv(INVENTORY_SHA256), real), isCode("ROLLOUT_EDGE_CAPTURE_INVENTORY_INVALID"));
    await writeFile(join(space.directory, "open.json"), text, { mode: 0o644 });
    await assert.rejects(runRollout(argv(sha).map((arg) => (arg.startsWith("--inventory=")
      ? `--inventory=${join(space.directory, "open.json")}` : arg)), real), isCode("ROLLOUT_EDGE_CAPTURE_INVENTORY_INVALID"));
    await assert.rejects(runRollout(argv(sha).map((arg) => (arg.startsWith("--inventory=")
      ? `--inventory=${join(space.directory, "absent.json")}` : arg)), real), isCode("ROLLOUT_EDGE_CAPTURE_INVENTORY_REQUIRED"));
  });

test("capture-edge prints only a content-free summary: no account id, binding value, path or credential", async (t) => {
  const space = await captureWorkspace(t);
  await mkdir(join(space.directory, "out"));
  const printed = { stdout: [], stderr: [] };
  const io = { stdout: (text) => printed.stdout.push(text), stderr: (text) => printed.stderr.push(text) };
  const { dependencies } = captureDependencies(space, gcpLive);
  assert.equal(await runRolloutCli(captureArgv(space), dependencies, io), 0);
  assert.deepEqual(printed.stderr, []);
  const stdout = printed.stdout.join("");
  const summary = JSON.parse(stdout);
  assert.deepEqual(Object.keys(summary), ["status", "verb", "environment", "mode", "edgeCommit", "capturedAt", "sha256"]);
  assert.equal(stdout.includes(ACCOUNT_ID), false, "no account id");
  assert.equal(stdout.includes(space.directory), false, "no private path");
  const values = gcpLive.bindings.flatMap((binding) => [binding.text, binding.id, binding.database_id, binding.bucket_name,
    binding.namespace_id].filter((value) => typeof value === "string" && value.length >= 6
    // The summary's own fields: the edge commit, and an environment name an ENVIRONMENT var shares.
    && ![EDGE_COMMIT, summary.environment, summary.mode].includes(value)));
  assert.ok(values.length > 5, "the fixture carries binding values to look for");
  for (const value of values) assert.equal(stdout.includes(value), false, "no binding value");
  assert.equal(stdout.includes(GCP_PLAN.invokerServiceAccount), false);
  // A failure prints a closed code only, even when the underlying error carries the account id.
  for (const [error, code] of [
    [Object.assign(new Error(`read ${ACCOUNT_ID}`), { code: `X_${ACCOUNT_ID}` }), "ROLLOUT_EDGE_CAPTURE_READ_FAILED"],
    [Object.assign(new Error("PRODUCTION_LIVE_CREDENTIAL_REQUIRED"), { code: "PRODUCTION_LIVE_CREDENTIAL_REQUIRED" }),
      "PRODUCTION_LIVE_CREDENTIAL_REQUIRED"],
  ]) {
    const failing = { ...dependencies, liveProviderFactory: () => ({ capture: async () => { throw error; } }) };
    await rm(space.output, { force: true });
    printed.stdout.length = 0;
    printed.stderr.length = 0;
    assert.equal(await runRolloutCli(captureArgv(space), failing, io), 1);
    assert.deepEqual(printed.stdout, []);
    assert.deepEqual(JSON.parse(printed.stderr.join("")), { status: "error", code });
    assert.equal(printed.stderr.join("").includes(ACCOUNT_ID), false);
    assert.equal(await absent(space.output), true);
  }
});

test("capture-edge from the command line: a dry run over a real owner-private inventory, and no token means no read",
  async (t) => {
    const space = await captureWorkspace(t);
    await mkdir(join(space.directory, "out"));
    const text = JSON.stringify({ accountId: ACCOUNT_ID, workerName: "app-usagemonitor-staging-edge" });
    await writeFile(space.inventory, text, { mode: 0o600 });
    const sha = createHash("sha256").update(text).digest("hex");
    const argv = (extra) => [join(import.meta.dirname, "gcp-production-rollout.mjs"), ROLLOUT_EDGE_CAPTURE_VERB,
      "--environment=staging", `--inventory=${space.inventory}`, `--inventory-sha256=${sha}`, `--output=${space.output}`,
      ...extra];
    const dry = spawnSync(process.execPath, argv([]), { encoding: "utf8", env: { PATH: "/nonexistent" }, timeout: 60_000 });
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(JSON.parse(dry.stdout), { status: "dry-run", verb: "capture-edge", environment: "staging",
      reads: "cloudflare-read-only" });
    // Without CLOUDFLARE_API_TOKEN the reviewed provider refuses before any request.
    const refused = spawnSync(process.execPath, argv(["--execute"]), { encoding: "utf8", env: { PATH: "/nonexistent" },
      timeout: 60_000 });
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.deepEqual(JSON.parse(refused.stderr), { status: "error", code: "PRODUCTION_LIVE_CREDENTIAL_REQUIRED" });
    assert.equal(`${dry.stdout}${refused.stderr}`.includes(ACCOUNT_ID), false);
    assert.equal(await absent(space.output), true);
  });
