#!/usr/bin/env node

// OPS-10 rollout CLI (gcp-production-rollout.mjs) against an injected,
// recording runner: no gcloud, node or git process ever starts here, and the
// production lock is a fake. Every resource name, commit, digest and receipt
// is synthetic.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
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
import { applyEdgeModeSnapshotDelta, liveEdgeMode } from "./edge-mode-configuration.mjs";
import { createProductionLiveConfigSnapshot } from "./production-live-config.mjs";
import {
  assessProductionBuild,
  EDGE_CAPTURE_MAX_AGE_MS,
  imageReference,
  loadRolloutTargetFromInfraManifest,
  parseRolloutArguments,
  PRE_MIGRATION_BACKUPS,
  ROLLOUT_ARGV,
  ROLLOUT_EDGE_LIVE_SCHEMA,
  ROLLOUT_MIGRATE_RECEIPT_SCHEMA,
  runRollout,
  safeRolloutErrorCode,
  trackedEdgeIdentity,
  validateRolloutTarget,
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
// staging cannot have the maintenance Job yet
// (STAGING_MAINTENANCE_JOB_ENVIRONMENT_UNAVAILABLE, D-OPS4), so it is in
// neither jobNames nor maintenanceJob.
const STAGING_TARGET = Object.freeze({
  environment: "staging",
  project: STAGING_PROJECT,
  region: "us-east1",
  service: "tibotattle-staging-origin",
  migrationJob: "tibotattle-staging-migrate",
  jobNames: Object.freeze(["tibotattle-staging-migrate", "tibotattle-staging-analytics"]),
  primaryInstance: "tibotattle-staging-primary",
  imageRepository: `us-east1-docker.pkg.dev/${STAGING_PROJECT}/tibotattle-staging/origin`,
  builderServiceAccount: `tibotattle-staging-builder@${STAGING_PROJECT}.iam.gserviceaccount.com`,
  verifierServiceAccount: `tibotattle-staging-verifier@${STAGING_PROJECT}.iam.gserviceaccount.com`,
  originAudience: ORIGIN_AUDIENCE,
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

function fakeLock() {
  const events = [];
  let held = null;
  const records = [];
  return {
    events,
    records,
    factory: ({ repositoryRoot }) => {
      assert.equal(typeof repositoryRoot, "string");
      return {
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
/** A staging Worker: its own name, no custom domain, its tracked PUBLIC_ORIGIN. */
const asStaging = (snapshot) => resnapshot(snapshot, {
  workerName: TRACKED.env.staging.name,
  domains: [],
  namespaces: snapshot.namespaces.map((namespace) => ({ ...namespace, script: TRACKED.env.staging.name,
    name: `${TRACKED.env.staging.name}_${namespace.class}` })),
  bindings: snapshot.bindings.map((binding) => (binding.name === "PUBLIC_ORIGIN"
    ? { ...binding, text: TRACKED.env.staging.vars.PUBLIC_ORIGIN }
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

test("the edge identity comes from the tracked wrangler.jsonc, and production is EP-9's Worker and domains", async () => {
  const production = await trackedEdgeIdentity("production");
  assert.deepEqual(production, { workerName: "app-usagemonitor",
    domains: ["admin.tibotattle.com", "tibotattle.com", "www.tibotattle.com"], publicOrigin: "https://tibotattle.com" });
  const staging = await trackedEdgeIdentity("staging");
  assert.deepEqual({ ...staging, publicOrigin: undefined },
    { workerName: TRACKED.env.staging.name, domains: [], publicOrigin: undefined }, "staging is a workers.dev-only Worker");
  assert.equal(staging.publicOrigin, TRACKED.env.staging.vars.PUBLIC_ORIGIN);
  for (const edit of [
    (config) => { config.env.production.name = "app-usagemonitor-other"; },
    (config) => { config.env.production.routes = config.env.production.routes.slice(1); },
    (config) => { config.env.production.vars.PUBLIC_ORIGIN = "https://tibotattle.com/"; },
    (config) => { delete config.env.staging; },
  ]) {
    const config = structuredClone(TRACKED);
    edit(config);
    await assert.rejects(trackedEdgeIdentity(config.env.staging === undefined ? "staging" : "production", async () => config),
      isCode("ROLLOUT_EDGE_IDENTITY_UNRESOLVED"));
  }
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
  assert.deepEqual(rollEstate.calls, []);
  await writeFile(migratedPaths.edgeLive, capture(gcpLive));
  const gcpPlan = await runRollout(rollArgv(migratedPaths), dependencies(fakeEstate(), fakeLock()));
  assert.deepEqual(gcpPlan.servedCommitCheck, { path: "public-health", url: "https://tibotattle.com/api/health" });
});

test("migrate: preflight, quiescent jobs, two labelled pre-migration backups, then the job update and execution, under the lock",
  async (t) => {
    const paths = await workspace(t);
    const estate = fakeEstate();
    const lock = fakeLock();
    const receipt = await runRollout(executeMigrate(paths), dependencies(estate, lock));
    const calls = estate.calls.map((argv) => argv.join(" "));
    const index = (prefix) => calls.findIndex((call) => call.startsWith(prefix));
    const creates = calls.map((call, position) => [call, position]).filter(([call]) => call.startsWith("gcloud sql backups create"));
    assert.equal(creates.length, 2, "two pre-migration backups");
    for (const [call] of creates) {
      assert.match(call, /--description=tibotattle-expires-on=2026-11-01;purpose=pre-migration/u);
      assert.match(call, /--instance=tibotattle-primary /u);
      assert.match(call, /--location=us-east1/u);
    }
    assert.deepEqual(estate.calls.filter((argv) => argv.slice(0, 4).join(" ") === "gcloud sql backups create"),
      [0, 1].map(() => ROLLOUT_ARGV.backupCreate(TARGET, "tibotattle-expires-on=2026-11-01;purpose=pre-migration")),
      "the dry-run argv is what createOnDemandBackup issues");
    const schedulerReads = calls.map((call, position) => [call, position])
      .filter(([call]) => call.startsWith("gcloud scheduler jobs list")).map(([, position]) => position);
    assert.equal(schedulerReads.length, 2);
    assert.ok(index("node scripts/gcp-infra.mjs readback --require-clean") < creates[0][1]);
    assert.ok(schedulerReads[0] < creates[0][1], "the jobs are quiescent before the first backup");
    assert.ok(creates[1][1] < schedulerReads[1] && schedulerReads[1] < index(`gcloud run jobs update ${TARGET.migrationJob}`),
      "and again after the backups, right before the DDL");
    assert.ok(index(`gcloud run jobs update ${TARGET.migrationJob}`) < index(`gcloud run jobs execute ${TARGET.migrationJob}`));
    assert.ok(index(`gcloud run jobs execute`) < index("gcloud logging read"));
    assert.deepEqual(lock.events, ["acquire", "assert", "release"]);
    assert.deepEqual(lock.records, [{ id: "00000000-0000-4000-8000-000000000001", sourceCommit: COMMIT,
      previousSourceCommit: OTHER_COMMIT }], "the lock records the live service's own commit");
    assert.equal(receipt.schema, ROLLOUT_MIGRATE_RECEIPT_SCHEMA);
    assert.equal(receipt.backups.length, 2);
    assert.notEqual(receipt.backups[0].id, receipt.backups[1].id);
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
    [(value) => ({ ...value, backups: value.backups.slice(0, 1) }), "ROLLOUT_MIGRATE_RECEIPT_INVALID"],
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
    const estate = fakeEstate({ blobs: {} });
    const receipt = await runRollout(executeRoll(paths), dependencies(estate, fakeLock()));
    assert.equal(receipt.edge.mode, mode);
    assert.equal(receipt.edge.contractBlob, null, "the contract does not bind an edge that does not forward");
    assert.deepEqual(estate.calls.filter((argv) => argv.includes("print-identity-token")), [ROLLOUT_ARGV.identityToken(TARGET)]);
    assert.deepEqual(estate.requests.map(({ url }) => url), [`${SERVICE_URL}/api/health`, `${SERVICE_URL}/api/ready`]);
    assert.equal(estate.requests[0].init.headers["x-serverless-authorization"], `Bearer ${TOKEN}`);
    assert.deepEqual(receipt.servedCommit, { path: "origin-verifier", origin: SERVICE_URL, sourceCommit: COMMIT });
    assert.equal(JSON.stringify(receipt).includes(TOKEN), false, "the identity token never reaches the receipt");
  }
});

test("a staging roll verifies a workers.dev-only gcp edge against staging's own domains and public origin", async (t) => {
  const paths = await migrated(t, { target: STAGING_TARGET, edge: stagingGcpLive });
  const estate = fakeEstate({ target: STAGING_TARGET });
  const receipt = await runRollout(executeRoll(paths, "staging"), dependencies(estate, fakeLock()));
  assert.equal(receipt.environment, "staging");
  assert.deepEqual(estate.requests.map(({ url }) => url), [`${TRACKED.env.staging.vars.PUBLIC_ORIGIN}/api/health`]);
  // A production capture is not this environment's edge.
  await writeFile(paths.edgeLive, capture(gcpLive));
  await assert.rejects(runRollout(executeRoll(paths, "staging"), dependencies(fakeEstate({ target: STAGING_TARGET }), fakeLock())),
    isCode("ROLLOUT_EDGE_LIVE_TARGET_MISMATCH"));
});

test("a staging target has no maintenance Job (D-OPS4), so its origin-verifier roll is refused before any command or lock",
  async (t) => {
    assert.deepEqual(validateRolloutTarget(STAGING_TARGET, "staging"), STAGING_TARGET);
    assert.equal(STAGING_TARGET.jobNames.includes("tibotattle-staging-maintenance"), false);
    // A staging target that names a maintenance Job outside its jobNames is
    // the merge hazard D-CRB closed: refused as invalid, never rolled.
    assert.throws(() => validateRolloutTarget({ ...STAGING_TARGET, maintenanceJob: "tibotattle-staging-maintenance" },
      "staging"), isCode("ROLLOUT_TARGET_INVALID"));
    const paths = await migrated(t, { target: STAGING_TARGET, edge: stagingGcpLive });
    await writeFile(paths.edgeLive, capture(stagingWorkerLive));
    const lock = fakeLock();
    const estate = fakeEstate({ blobs: {}, target: STAGING_TARGET });
    await assert.rejects(runRollout(executeRoll(paths, "staging"), dependencies(estate, lock)),
      isCode("ROLLOUT_MAINTENANCE_JOB_REQUIRED"));
    assert.deepEqual(lock.events, []);
    assert.equal(estate.calls.some((argv) => argv[0] === "gcloud" && argv[3] !== "describe"), false);
    assert.deepEqual(estate.requests, []);
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
    await assert.rejects(runRollout(executeRoll(paths), dependencies(fakeEstate({ blobs: {}, ...estateOptions }), lock)),
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
  // the verifier's token.
  const paths = await migrated(t);
  await writeFile(paths.edgeLive, capture(workerLive));
  const estate = fakeEstate({ blobs: {} });
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
  const bare = fakeEstate({ blobs: {}, target: noJob });
  await assert.rejects(runRollout(executeRoll(paths), dependencies(bare, lock, { loadTarget: async () => noJob })),
    isCode("ROLLOUT_MAINTENANCE_JOB_REQUIRED"));
  assert.deepEqual(lock.events, []);
  assert.equal(bare.calls.some((argv) => argv[0] === "gcloud" && argv[3] !== "describe"), false);
  // A failed pass fails the roll closed and releases the lock.
  const failed = fakeEstate({ blobs: {}, fail: `run jobs execute ${TARGET.maintenanceJob}` });
  const failedLock = fakeLock();
  await assert.rejects(runRollout(executeRoll(paths), dependencies(failed, failedLock)),
    isCode("ROLLOUT_MAINTENANCE_PASS_FAILED"));
  assert.deepEqual(failedLock.events.filter((event) => event !== "assert"), ["acquire", "release"]);
  const unsucceeded = fakeEstate({ blobs: {}, executionStatus: { succeededCount: 0, failedCount: 1 } });
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

test("until the committed desired states are complete every verb fails closed, and error codes stay content-free",
  async () => {
  // The default loader reaches the OPS-2 manifest's rolloutTarget, which reads
  // only the committed desired state: production waits for OWN-5's
  // placeholders and staging for the verifier's operator. The rollout reports
  // either as ROLLOUT_INFRA_MANIFEST_UNAVAILABLE before running anything.
  await assert.rejects(loadRolloutTargetFromInfraManifest("production"),
    isCode("DESIRED_STATE_PLACEHOLDER_UNFILLED:project"));
  await assert.rejects(loadRolloutTargetFromInfraManifest("staging"),
    isCode("ROLLOUT_TARGET_VERIFIER_TOKEN_CREATOR_UNASSIGNED"));
  for (const environment of ["production", "staging"]) {
    await assert.rejects(runRollout(["preflight", `--environment=${environment}`, `--commit=${COMMIT}`,
      "--backup-audit=/synthetic/audit.json"], { run: () => assert.fail("never") }),
    isCode("ROLLOUT_INFRA_MANIFEST_UNAVAILABLE"), environment);
  }
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
