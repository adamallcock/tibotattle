#!/usr/bin/env node

// OPS-10 rollout CLI (gcp-production-rollout.mjs) against an injected,
// recording runner: no gcloud, node or git process ever starts here, and the
// production lock is a fake. Every resource name, commit, digest and receipt
// is synthetic.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  imageReference,
  parseRolloutArguments,
  PRE_MIGRATION_BACKUPS,
  ROLLOUT_ARGV,
  ROLLOUT_EDGE_LIVE_SCHEMA,
  ROLLOUT_MIGRATE_RECEIPT_SCHEMA,
  runRollout,
  safeRolloutErrorCode,
  validateRolloutTarget,
  verifyMigrateReceipt,
} from "./gcp-production-rollout.mjs";

const COMMIT = "1".repeat(40);
const OTHER_COMMIT = "2".repeat(40);
const EDGE_COMMIT = "3".repeat(40);
const DIGEST = `sha256:${"d".repeat(64)}`;
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const PROJECT = "w2-opsdb-prod-synth";
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
});
const IMAGE = `${TARGET.imageRepository}@${DIGEST}`;
const CONTRACT_PATH = "apps/worker/src/edge-origin-contract.ts";

const base = await readPostgresMigrations({ role: "primary" });
const RESIDUE_SQL = "SELECT 1;\n";
const MIGRATIONS = Object.freeze([...base, Object.freeze({
  role: "primary",
  version: base.length + 1,
  name: `${String(base.length + 1).padStart(4, "0")}_simp_append_only_residue.sql`,
  bytes: Buffer.byteLength(RESIDUE_SQL),
  sha256: createHash("sha256").update(RESIDUE_SQL).digest("hex"),
  sql: RESIDUE_SQL,
})]);

const isCode = (code) => (error) => error?.code === code;

/** The 'tibotattle-gcp-migration-v1' receipt the Job would log for this rollout. */
function jobReceipt(overrides = {}) {
  const body = {
    schema: "tibotattle-gcp-migration-v1",
    status: "ok",
    environment: "production",
    job: TARGET.migrationJob,
    sourceCommit: COMMIT,
    target: {
      kind: "environment",
      instanceConnectionName: `${PROJECT}:us-east1:${TARGET.primaryInstance}`,
      database: "tibotattle",
      schema: "tibotattle",
    },
    migrations: {
      role: "primary",
      count: MIGRATIONS.length,
      latest: { version: MIGRATIONS.length, name: MIGRATIONS.at(-1).name, sha256: MIGRATIONS.at(-1).sha256 },
      manifestSha256: primaryManifestSha256(MIGRATIONS),
      historySha256: "e".repeat(64),
      contractReviewed: 12,
      simpResidue: MIGRATIONS.at(-1).name,
    },
    roles: { migrator: `tibotattle-migrator@${PROJECT}.iam`, runtime: `tibotattle-runtime@${PROJECT}.iam` },
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

function serviceResource(image, commit) {
  return {
    apiVersion: "serving.knative.dev/v1",
    kind: "Service",
    spec: { template: { spec: { containers: [{ image, env: [{ name: "DEPLOYMENT_SOURCE_COMMIT", value: commit }] }] } } },
    status: {
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

/**
 * A recording runner over a fake estate. `fail` names a step that answers
 * non-zero; `blobs` maps `<commit>:<path>` to a git blob id.
 */
function fakeEstate({
  dirty = false,
  head = COMMIT,
  infraClean = true,
  fail = null,
  blobs = { [`${COMMIT}:${CONTRACT_PATH}`]: "a".repeat(40), [`${EDGE_COMMIT}:${CONTRACT_PATH}`]: "a".repeat(40) },
  receipt = jobReceipt(),
  executionStatus = { succeededCount: 1 },
  staleReadback = false,
} = {}) {
  const calls = [];
  const state = {
    service: serviceResource(`${TARGET.imageRepository}@sha256:${"0".repeat(64)}`, OTHER_COMMIT),
    jobs: Object.fromEntries(TARGET.jobNames.map((job) => [job, jobResource(`${TARGET.imageRepository}@sha256:${"0".repeat(64)}`,
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
      if (step === "sql backups list") return ok(JSON.stringify(state.backups));
      if (step === "sql backups create") {
        const description = args.find((arg) => arg.startsWith("--description=")).slice("--description=".length);
        state.backups.push({
          kind: "sql#backupRun", id: String(1_700_000_000_000 + state.backups.length), instance: TARGET.primaryInstance,
          type: "ON_DEMAND", status: "SUCCESSFUL", location: TARGET.region,
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
          labels: { "run.googleapis.com/execution_name": `${TARGET.migrationJob}-x7k2p` } }]));
      }
      if (step === "run services update") {
        const image = args.find((arg) => arg.startsWith("--image=")).slice("--image=".length);
        const commit = args.find((arg) => arg.startsWith("--update-env-vars=")).split("=").at(-1);
        state.service = serviceResource(image, staleReadback ? OTHER_COMMIT : commit);
        return ok("");
      }
      if (step === "run services describe") return ok(JSON.stringify(state.service));
      if (step === "run jobs describe") return ok(JSON.stringify(state.jobs[args[3]]));
    }
    throw new Error(`unexpected command ${argv.slice(0, 4).join(" ")}`);
  };
  return { run, calls, state };
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

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "w2-opsdb-rollout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audit = join(directory, "audit.json");
  await writeFile(audit, JSON.stringify({
    environment: "production", project: PROJECT, roles: { primary: { instance: TARGET.primaryInstance } },
    verdict: "ok", generatedAt: new Date(NOW - 60_000).toISOString(), digest: "a".repeat(64),
  }));
  return { directory, audit, migrateReceipt: join(directory, "migrate.json"), edgeLive: join(directory, "edge.json") };
}

function dependencies(estate, lock, overrides = {}) {
  return {
    run: estate.run,
    loadTarget: async (environment) => ({ ...TARGET, environment }),
    lockFactory: lock.factory,
    now: () => NOW,
    uuid: () => "00000000-0000-4000-8000-000000000001",
    verifyBackupAudit: (raw) => raw,
    readPrimaryMigrations: async () => MIGRATIONS,
    ...overrides,
  };
}

const migrateArgv = (paths, extra = []) => ["migrate", "--environment=production", `--commit=${COMMIT}`, `--digest=${DIGEST}`,
  `--backup-audit=${paths.audit}`, `--migrate-receipt=${paths.migrateReceipt}`, ...extra];
const rollArgv = (paths, extra = []) => ["roll", "--environment=production", `--commit=${COMMIT}`, `--digest=${DIGEST}`,
  `--backup-audit=${paths.audit}`, `--migrate-receipt=${paths.migrateReceipt}`, `--edge-live=${paths.edgeLive}`, ...extra];
const executeMigrate = (paths) => migrateArgv(paths, [`--authorize=migrate:production:${DIGEST}`, "--execute"]);
const executeRoll = (paths) => rollArgv(paths, [`--authorize=roll:production:${DIGEST}`, "--execute"]);

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
const capture = (snapshot) => JSON.stringify({ schema: ROLLOUT_EDGE_LIVE_SCHEMA, snapshot,
  deployment: { versions: [{ version_id: snapshot.versionId, percentage: 100 }] } });

async function migrated(t, { edge = gcpLive } = {}) {
  const paths = await workspace(t);
  const estate = fakeEstate();
  const lock = fakeLock();
  await runRollout(executeMigrate(paths), dependencies(estate, lock));
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
  for (const [overrides, code] of [
    [{ extra: "x" }, "ROLLOUT_TARGET_INVALID"],
    [{ environment: "staging" }, "ROLLOUT_TARGET_INVALID"],
    [{ jobNames: ["tibotattle-maintenance"] }, "ROLLOUT_TARGET_INVALID"],
    [{ jobNames: [...TARGET.jobNames, TARGET.migrationJob] }, "ROLLOUT_TARGET_INVALID"],
    [{ imageRepository: `us-west1-docker.pkg.dev/${PROJECT}/tibotattle/origin` }, "ROLLOUT_TARGET_INVALID"],
    [{ imageRepository: "us-east1-docker.pkg.dev/other-project-x/tibotattle/origin" }, "ROLLOUT_TARGET_INVALID"],
    [{ service: "tibotattle-test-app" }, "ROLLOUT_TARGET_TEST_FORBIDDEN"],
    [{ primaryInstance: "tibotattle-test-primary-20260922" }, "ROLLOUT_TARGET_TEST_FORBIDDEN"],
    [{ primaryInstance: "tibotattle-primary-rehearsal-0a1b2c3d" }, "ROLLOUT_TARGET_TEST_FORBIDDEN"],
    [{ builderServiceAccount: `tibotattle-test-builder@${PROJECT}.iam.gserviceaccount.com` }, "ROLLOUT_TARGET_TEST_FORBIDDEN"],
    [{ service: "tibotattle-staging-origin" }, "ROLLOUT_TARGET_PLANE_MISMATCH"],
  ]) {
    assert.throws(() => validateRolloutTarget({ ...TARGET, ...overrides }, "production"), isCode(code), JSON.stringify(overrides));
  }
  assert.throws(() => validateRolloutTarget({ ...TARGET, environment: "staging" }, "staging"),
    isCode("ROLLOUT_TARGET_PLANE_MISMATCH"), "a staging target names every resource with the staging token");
});

test("a dry run validates and prints argv only: no gcloud, no node, no lock", async (t) => {
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
  assert.ok(firstBackup >= 0 && firstBackup < execute, "backups precede the execution");
  assert.deepEqual(steps.find((argv) => argv[3] === "update"), ROLLOUT_ARGV.jobUpdate(TARGET, TARGET.migrationJob, IMAGE, COMMIT));
  for (const argv of steps) {
    assert.equal(argv.some((part) => /^(?:delete|rm|sh|bash|-c)$/u.test(part)), false, argv.join(" "));
  }
  const build = await runRollout(["build", "--environment=production", `--commit=${COMMIT}`], dependencies(estate, lock));
  assert.deepEqual(build.steps.at(-1).argv.slice(0, 3), ["gcloud", "builds", "submit"]);
  assert.deepEqual(estate.calls, []);
  const preflight = await runRollout(["preflight", "--environment=production", `--commit=${COMMIT}`,
    `--backup-audit=${paths.audit}`], dependencies(estate, lock));
  assert.deepEqual(preflight.steps.map(({ argv }) => argv), [ROLLOUT_ARGV.gitStatus(), ROLLOUT_ARGV.gitHead(),
    ["node", "scripts/gcp-infra.mjs", "readback", "--require-clean", "--environment=production"]]);
  assert.deepEqual(estate.calls, []);
  const refused = await runRollout(migrateArgv(paths), dependencies(estate, lock, { run: () => assert.fail("never") }));
  assert.equal(refused.status, "dry-run");
});

test("migrate: preflight, two labelled pre-migration backups, then the job update and execution, under the lock", async (t) => {
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
  assert.ok(index("node scripts/gcp-infra.mjs readback --require-clean") < creates[0][1]);
  assert.ok(creates[1][1] < index(`gcloud run jobs update ${TARGET.migrationJob}`));
  assert.ok(index(`gcloud run jobs update ${TARGET.migrationJob}`) < index(`gcloud run jobs execute ${TARGET.migrationJob}`));
  assert.ok(index(`gcloud run jobs execute`) < index("gcloud logging read"));
  assert.deepEqual(lock.events, ["acquire", "assert", "release"]);
  assert.deepEqual(lock.records, [{ id: "00000000-0000-4000-8000-000000000001", sourceCommit: COMMIT, previousSourceCommit: OTHER_COMMIT }]);
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
    [{ readPrimaryMigrations: async () => base }, "PRODUCTION_SIMP_RESIDUE_MISSING"],
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

test("migrate releases the lock on every failure after acquiring it, and runs nothing past the failure", async (t) => {
  const paths = await workspace(t);
  for (const [estateOptions, code, setup] of [
    [{ infraClean: false }, "ROLLOUT_INFRA_NOT_CLEAN"],
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
    await assert.rejects(stat(paths.migrateReceipt), undefined, "no migrate receipt after a failure");
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

test("roll moves the service and every manifest job to one digest and commit, reads them back, under the lock", async (t) => {
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
  const lastCall = estate.calls.at(-1).join(" ");
  assert.equal(lastCall, "node scripts/gcp-infra.mjs readback --require-clean --environment=production",
    "the infrastructure readback closes the roll");
  assert.deepEqual(lock.events, ["acquire", "assert", "release"]);
  assert.equal(receipt.image, IMAGE);
  assert.deepEqual(receipt.jobs, TARGET.jobNames);
  assert.deepEqual(receipt.edge, { mode: "gcp", edgeCommit: EDGE_COMMIT, contractBlob: "a".repeat(40) });
  assert.equal(receipt.secondsSinceMigrate, 120);
  assert.equal(imageReference(TARGET, DIGEST), IMAGE);
  assert.equal(estate.calls.some((argv) => argv.includes("delete")), false, "no deletes");
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
  // A worker- or fenced-mode edge does not proxy to this origin, so the
  // contract does not bind yet; its mode is recorded.
  for (const [edge, mode] of [[workerLive, "worker"], [fencedLive, "fenced"]]) {
    await writeFile(paths.edgeLive, capture(edge));
    const estate = fakeEstate({ blobs: {} });
    const receipt = await runRollout(executeRoll(paths), dependencies(estate, fakeLock()));
    assert.equal(receipt.edge.mode, mode);
  }
  // A gcp snapshot that does not verify as gcp (split deployment) is refused.
  await writeFile(paths.edgeLive, JSON.stringify({ schema: ROLLOUT_EDGE_LIVE_SCHEMA, snapshot: gcpLive,
    deployment: { versions: [{ version_id: gcpLive.versionId, percentage: 50 }, { version_id: versionId(1), percentage: 50 }] } }));
  await assert.rejects(runRollout(executeRoll(paths), dependencies(fakeEstate(), fakeLock())), isCode("ROLLOUT_EDGE_LIVE_UNVERIFIED"));
  await writeFile(paths.edgeLive, JSON.stringify({ schema: "other", snapshot: gcpLive, deployment: {} }));
  await assert.rejects(runRollout(executeRoll(paths), dependencies(fakeEstate(), fakeLock())), isCode("ROLLOUT_EDGE_LIVE_INVALID"));
});

test("roll releases the lock on failure, and a readback mismatch fails closed", async (t) => {
  const paths = await migrated(t);
  for (const [estateOptions, code] of [
    [{ fail: "run services update" }, "ROLLOUT_SERVICE_UPDATE_FAILED"],
    [{ fail: `run jobs update ${TARGET.jobNames[1]}` }, "ROLLOUT_JOB_UPDATE_FAILED"],
    [{ staleReadback: true }, "ROLLOUT_READBACK_MISMATCH"],
    [{ infraClean: false }, "ROLLOUT_INFRA_NOT_CLEAN"],
  ]) {
    const estate = fakeEstate(estateOptions);
    const lock = fakeLock();
    await assert.rejects(runRollout(executeRoll(paths), dependencies(estate, lock)), isCode(code), code);
    assert.deepEqual(lock.events.filter((event) => event !== "assert"), ["acquire", "release"], code);
  }
});

test("build renders the production config, submits the audited context and qualifies the build's provenance", async (t) => {
  const estate = fakeEstate();
  const lock = fakeLock();
  const directory = await mkdtemp(join(tmpdir(), "w2-opsdb-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const builderImage = /- name: (gcr\.io\/cloud-builders\/docker@sha256:[0-9a-f]{64})/u
    .exec(await readFile(new URL("../cloud-run/cloudbuild.production.yaml", import.meta.url), "utf8"))[1];
  const tag = `${TARGET.imageRepository}:source-${COMMIT}`;
  const build = {
    id: "00000000-0000-4000-8000-0000000000b1", status: "SUCCESS",
    serviceAccount: `projects/${PROJECT}/serviceAccounts/${TARGET.builderServiceAccount}`,
    options: { sourceProvenanceHash: ["SHA256"], requestedVerifyOption: "VERIFIED" },
    steps: [{ name: builderImage, status: "SUCCESS" }],
    images: [tag],
    results: { images: [{ name: tag, digest: DIGEST }] },
  };
  let rendered = null;
  const run = (argv) => {
    if (argv[0] === "node" && argv[1] === "scripts/cloud-run-build-context.mjs") {
      estate.calls.push(argv);
      return { status: 0, stdout: "{}" };
    }
    if (argv.slice(0, 3).join(" ") === "gcloud builds submit") {
      estate.calls.push(argv);
      rendered = readFileSync(argv.find((arg) => arg.startsWith("--config=")).slice("--config=".length), "utf8");
      return { status: 0, stdout: JSON.stringify(build) };
    }
    return estate.run(argv);
  };
  const receipt = await runRollout(["build", "--environment=production", `--commit=${COMMIT}`,
    `--authorize=build:production:${COMMIT}`, "--execute"], dependencies(estate, lock, { run, tmpdir: () => directory }));
  assert.deepEqual({ digest: receipt.digest, image: receipt.image, buildId: receipt.buildId },
    { digest: DIGEST, image: IMAGE, buildId: build.id });
  assert.match(rendered, new RegExp(`serviceAccount: projects/${PROJECT}/serviceAccounts/${TARGET.builderServiceAccount}`, "u"));
  assert.match(rendered, new RegExp(`_IMAGE: ${TARGET.imageRepository}:source-${COMMIT}`, "u"));
  assert.doesNotMatch(rendered, /\$\{(?!_IMAGE\})/u, "every placeholder but the Cloud Build substitution is rendered");
  assert.deepEqual(lock.events, ["acquire", "assert", "release"]);
  for (const bad of [{ ...build, status: "FAILURE" }, { ...build, options: { sourceProvenanceHash: ["SHA256"] } },
    { ...build, steps: [{ name: "gcr.io/cloud-builders/docker:latest", status: "SUCCESS" }] },
    { ...build, results: { images: [{ name: `${TARGET.imageRepository}:other`, digest: DIGEST }] } }]) {
    const badLock = fakeLock();
    const badRun = (argv) => argv.slice(0, 3).join(" ") === "gcloud builds submit"
      ? { status: 0, stdout: JSON.stringify(bad) } : run(argv);
    await assert.rejects(runRollout(["build", "--environment=production", `--commit=${COMMIT}`,
      `--authorize=build:production:${COMMIT}`, "--execute"], dependencies(estate, badLock, { run: badRun, tmpdir: () => directory })),
    isCode("ROLLOUT_BUILD_PROVENANCE_UNQUALIFIED"));
    assert.deepEqual(badLock.events.filter((event) => event !== "assert"), ["acquire", "release"]);
  }
});

test("without the infrastructure manifest every verb fails closed, and error codes stay content-free", async () => {
  await assert.rejects(runRollout(["preflight", "--environment=production", `--commit=${COMMIT}`,
    "--backup-audit=/synthetic/audit.json"], { run: () => assert.fail("never") }), isCode("ROLLOUT_INFRA_MANIFEST_UNAVAILABLE"));
  assert.equal(safeRolloutErrorCode({ code: "EDGE_CONTRACT_DRIFT" }), "EDGE_CONTRACT_DRIFT");
  assert.equal(safeRolloutErrorCode({ code: "PRODUCTION_COORDINATION_BUSY" }), "PRODUCTION_COORDINATION_BUSY");
  assert.equal(safeRolloutErrorCode(new Error("gcloud: permission denied on tibotattle-primary")), "ROLLOUT_FAILED");
  assert.equal(safeRolloutErrorCode({ code: "ENOENT" }), "ROLLOUT_FAILED");
});

test("preflight executes read-only: clean tree, infrastructure readback and a fresh, non-breach backup audit", async (t) => {
  const paths = await workspace(t);
  const estate = fakeEstate();
  const lock = fakeLock();
  const result = await runRollout(["preflight", "--environment=production", `--commit=${COMMIT}`,
    `--backup-audit=${paths.audit}`, "--execute"], dependencies(estate, lock));
  assert.equal(result.status, "ok");
  assert.equal(result.backupAudit.verdict, "ok");
  assert.deepEqual(lock.events, [], "preflight changes nothing and takes no lock");
  assert.deepEqual(estate.calls.map((argv) => argv[0]), ["git", "git", "node"]);
});
