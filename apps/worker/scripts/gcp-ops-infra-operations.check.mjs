/**
 * Offline check of OPS-2 readback, plan and apply against a synthetic,
 * in-memory gcloud (fixtures/gcp-ops-infra/fake-gcloud.mjs). Every call goes
 * through the injected runner and is recorded; the checks assert that
 * readback and plan issue read shapes only, that nothing mutating runs
 * without a matching --authorize, and that apply refuses deletes,
 * destructive changes, bucket metadata changes and a stale or unpinned
 * bucket proof. Trigger state and its create-then-pause order, disabled
 * accounts, non-GA roles, the verifier's token-creator grant, a shared
 * project's co-tenants, the scheduler probe and OPS-10's clean verdict are
 * covered too. PATH is blanked, so no real gcloud can run.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/canonical-json.ts";
import * as manifest from "./gcp-ops-infra-manifest.mjs";
import * as operations from "./gcp-ops-infra-operations.mjs";
import {
  bornBucket,
  createFakeGcloud,
  emptyWorld,
  memoryWriter,
  withSecretValues,
} from "./fixtures/gcp-ops-infra/fake-gcloud.mjs";
import { unpinnedStagingText } from "./fixtures/gcp-ops-infra/staging-unpinned.mjs";

process.env.PATH = "/nonexistent-gcloud-guard";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(SCRIPTS_ROOT, "fixtures/gcp-ops-infra/desired-state.synthetic.json"), "utf8"));
const BOOTSTRAP = Object.freeze({ imageDigest: "c".repeat(64), sourceCommit: "d".repeat(40) });
const LIVE_IMAGE = Object.freeze({ imageDigest: "e".repeat(64), sourceCommit: "f".repeat(40) });
// An unmarked copy for apply paths: still synthetic, content-free and only
// ever run against the in-memory gcloud.
const APPLY_PROJECT = "example-ops-prod1";
// Explicitly no job deferred (the default since the refresh-job contract
// lifted the analytics-refresh deferral).
const UNDEFERRED = Object.freeze({ jobDeferrals: Object.freeze({}) });
const CADENCE = (value) => { value.scheduler["analytics-refresh"].schedule = "15 3 * * *"; };
const TRIGGER = "synthetic-analytics-refresh-trigger";
const MAINTENANCE_TRIGGER = "synthetic-maintenance-trigger";

function desiredState({ synthetic = true, mutate = () => {} } = {}) {
  let value = structuredClone(FIXTURE);
  if (!synthetic) value = JSON.parse(JSON.stringify(value).replaceAll("synthetic-ops-project", APPLY_PROJECT));
  mutate(value);
  return manifest.validateDesiredState(value);
}

/** A project with only the born bucket and the owner's secret values. */
function bornWorld(desired, { secrets = true } = {}) {
  const world = emptyWorld();
  if (secrets) {
    withSecretValues(world, {
      project: desired.project,
      region: desired.region,
      names: Object.keys(desired.secrets).filter((name) => desired.secrets[name].version !== null),
    });
  }
  world.buckets.push(bornBucket({ name: desired.bucket.name, location: desired.bucket.location }));
  return world;
}

function fake(desired, world, options = {}) {
  const writer = memoryWriter();
  const gcloud = createFakeGcloud(world, { files: writer.files, project: desired.project, region: desired.region, ...options });
  return { ...gcloud, writer };
}

function plan(desired, runner, options = {}) {
  return operations.planInfrastructure(desired, operations.readbackInfrastructure(desired, { runner }), options);
}

/** A world in which apply has already converged the estate. */
function convergedWorld(desired, options = {}) {
  const world = bornWorld(desired);
  const gcloud = fake(desired, world);
  const first = plan(desired, gcloud.runner, { bootstrap: LIVE_IMAGE, ...options });
  operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: first.planDigest, bootstrap: LIVE_IMAGE,
    createSpecWriter: () => gcloud.writer.create(), ...options });
  return world;
}

function trigger(world) {
  return world.schedulerJobs.find((job) => job.name.endsWith(`/${TRIGGER}`));
}

function maintenanceTrigger(world) {
  return world.schedulerJobs.find((job) => job.name.endsWith(`/${MAINTENANCE_TRIGGER}`));
}

function kinds(calls) {
  return calls.map((argv) => operations.classifyGcloudCommand(argv));
}

function ops(result, predicate = () => true) {
  return result.operations.filter(predicate);
}

test("readback issues only describe, get-iam-policy and list calls, never a secret read", () => {
  const desired = desiredState();
  // An empty project with only the born bucket, and a fully converged one.
  for (const [target, world] of [[desired, bornWorld(desired)],
    [desiredState({ synthetic: false }), convergedWorld(desiredState({ synthetic: false }))]]) {
    const runner = fake(target, world);
    const readback = operations.readbackInfrastructure(target, { runner: runner.runner });
    assert.equal(readback.schema, "tibotattle-gcp-ops-infra-readback-v1");
    assert.ok(runner.calls.length >= 13);
    for (const argv of runner.calls) {
      assert.equal(operations.classifyGcloudCommand(argv), "read", argv.join(" "));
      assert.ok(argv.includes("--format=json"), argv.join(" "));
      assert.equal(argv.filter((arg) => arg === `--project=${target.project}`).length, 1, argv.join(" "));
      assert.match(argv[0] + argv[1], /^[a-z-]+$/u);
      const verb = argv.find((arg, index) => index > 0 && ["describe", "list", "get-iam-policy"].includes(arg));
      assert.ok(verb !== undefined, argv.join(" "));
    }
    const joined = runner.calls.map((argv) => argv.join(" ")).join("\n");
    assert.equal(joined.includes("secrets versions access"), false);
    assert.equal(/\baccess\b/u.test(joined), false);
    assert.doesNotMatch(JSON.stringify(readback), /MARKER|BEGIN PRIVATE KEY/u);
  }
});

test("the guard refuses unknown, deleting and secret-reading shapes, and mutations outside apply", () => {
  const calls = [];
  const runner = (argv) => { calls.push(argv); return { status: 0, stdout: "[]" }; };
  const read = operations.guardedGcloud(runner, { mode: "read", project: "example-ops-prod1" });
  const apply = operations.guardedGcloud(runner, { mode: "apply", project: "example-ops-prod1" });
  for (const argv of [
    ["secrets", "versions", "access", "1", "--secret=IDENTITY_LINK_SECRET", "--project=example-ops-prod1"],
    ["sql", "instances", "delete", "x", "--project=example-ops-prod1"],
    ["projects", "set-iam-policy", "example-ops-prod1", "/x", "--project=example-ops-prod1"],
    ["projects", "remove-iam-policy-binding", "example-ops-prod1", "--project=example-ops-prod1"],
    ["storage", "buckets", "update", "gs://x", "--project=example-ops-prod1"],
    ["storage", "buckets", "create", "gs://x", "--project=example-ops-prod1"],
    ["storage", "buckets", "add-iam-policy-binding", "gs://x", "--project=example-ops-prod1"],
    ["run", "services", "delete", "x", "--project=example-ops-prod1"],
    ["run", "jobs", "execute", "x", "--project=example-ops-prod1"],
    ["scheduler", "jobs", "resume", "x", "--project=example-ops-prod1"],
    ["auth", "print-access-token", "--project=example-ops-prod1"],
  ]) {
    for (const call of [read, apply]) {
      assert.throws(() => call([...argv, "--format=json"]), { code: "GCLOUD_COMMAND_FORBIDDEN" }, argv.join(" "));
    }
  }
  assert.throws(() => read(["sql", "instances", "create", "x", "--project=example-ops-prod1"]),
    { code: "GCLOUD_MUTATION_UNAUTHORIZED" });
  assert.throws(() => read(["sql", "instances", "list", "--format=json"]), { code: "GCLOUD_PROJECT_FLAG_INVALID" });
  assert.throws(() => read(["sql", "instances", "list", "--project=other-project", "--format=json"]),
    { code: "GCLOUD_PROJECT_FLAG_INVALID" });
  assert.throws(() => read(["sql", "instances", "list", "--project=example-ops-prod1"]),
    { code: "GCLOUD_READ_FORMAT_REQUIRED" });
  assert.equal(calls.length, 0);
  // Every mutating shape is a create, update, bind or pause; none deletes,
  // and none enables or resumes what someone disabled or paused.
  for (const shape of operations.MUTATING_COMMANDS) {
    assert.doesNotMatch(shape,
      /delete|remove|set-iam-policy|access|destroy|disable|enable|execute|resume|storage buckets/u, shape);
  }
  for (const shape of operations.READ_COMMANDS) assert.match(shape, /(?:list|describe|get-iam-policy)$/u, shape);
  // A failed call is a named code that never echoes gcloud output.
  const failing = operations.guardedGcloud(() => ({ status: 1, stdout: "MARKER-5e1f", stderr: "MARKER-5e1f" }),
    { mode: "read", project: "example-ops-prod1" });
  assert.throws(() => failing(["sql", "instances", "list", "--project=example-ops-prod1", "--format=json"]),
    (error) => error.code === "GCLOUD_CALL_FAILED:sql-instances-list" && !error.message.includes("MARKER"));
  // The default runner cannot find a real gcloud here: PATH is blanked.
  const guarded = operations.guardedGcloud(operations.defaultGcloudRunner, { mode: "read", project: "example-ops-prod1" });
  assert.throws(() => guarded(["sql", "instances", "list", "--project=example-ops-prod1", "--format=json"]),
    { code: "GCLOUD_CALL_FAILED:sql-instances-list" });
});

test("the plan is deterministic: two runs and a reordered estate give one planDigest", () => {
  const desired = desiredState();
  const first = plan(desired, fake(desired, bornWorld(desired)).runner, { bootstrap: BOOTSTRAP });
  const second = plan(desired, fake(desired, bornWorld(desired)).runner, { bootstrap: BOOTSTRAP });
  assert.equal(first.planDigest, second.planDigest);
  assert.deepEqual(first, second);
  assert.match(first.planDigest, /^[a-f0-9]{64}$/u);
  assert.equal(first.planDigest, operations.planDigestOf(first));
  const reversed = (value) => (Array.isArray(value) ? value.map(reversed)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reversed(value[key])])) : value);
  const reordered = plan(desired, fake(desired, reversed(bornWorld(desired))).runner, { bootstrap: BOOTSTRAP });
  assert.equal(reordered.planDigest, first.planDigest);
  // A different desired state or bootstrap image is a different plan.
  assert.notEqual(plan(desired, fake(desired, bornWorld(desired)).runner,
    { bootstrap: { ...BOOTSTRAP, sourceCommit: "a".repeat(40) } }).planDigest, first.planDigest);
});

test("the plan for the synthetic fixture holds the whole estate and no bucket change", () => {
  const desired = desiredState();
  const result = plan(desired, fake(desired, bornWorld(desired)).runner, { bootstrap: BOOTSTRAP });
  assert.equal(result.schema, "tibotattle-gcp-ops-infra-plan-v1");
  assert.equal(result.synthetic, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.findings, []);
  // The fixture's three jobs and the maintenance trigger (created, paused, then
  // granted) add four; the refresh trigger's create and the scheduler's
  // executor grant on the refresh job wait for the owner's cadence.
  assert.deepEqual(result.summary, { executable: 38, deferred: 2, refused: 0 });
  const byId = new Map(result.operations.map((entry) => [entry.id, entry]));
  // The operator's token-creator grant on the verifier account alone.
  assert.deepEqual(byId.get("verifier-iam:bind:roles/iam.serviceAccountTokenCreator|group:synthetic-operators@example.com|")
    .argv, ["iam", "service-accounts", "add-iam-policy-binding", desired.serviceAccounts.verifier.email,
    "--project=synthetic-ops-project", "--member=group:synthetic-operators@example.com",
    "--role=roles/iam.serviceAccountTokenCreator"]);
  // The logging exclusion, the one instance with every SQL flag, and its users.
  assert.deepEqual(byId.get("logging-exclusion:create").argv, ["logging", "sinks", "update", "_Default",
    "--project=synthetic-ops-project",
    "--add-exclusion=name=tibotattle-run-requests,filter=LOG_ID(\"run.googleapis.com/requests\")"]);
  assert.deepEqual(byId.get("cloud-sql:create").argv, [...manifest.cloudSqlCreateArgs(desired)]);
  assert.equal(ops(result, (entry) => entry.argv.slice(0, 3).join(" ") === "sql instances create").length, 1);
  assert.equal(ops(result, (entry) => /^cloud-sql:(?!create)/u.test(entry.id)).length, 0);
  for (const flag of manifest.databaseFlags(desired)) {
    assert.ok(byId.get("cloud-sql:create").argv.at(-1).includes(`${flag.name}=${flag.value}`), flag.name);
  }
  // PostgreSQL IAM users are the email without ".gserviceaccount.com".
  assert.deepEqual(byId.get("cloud-sql-user:create:runtime").argv, ["sql", "users", "create",
    desired.cloudSql.runtimeIamUser, "--instance=synthetic-primary", "--project=synthetic-ops-project",
    "--type=cloud_iam_service_account"]);
  assert.equal(byId.get("cloud-sql-user:create:runtime").argv.some((arg) => arg.endsWith(".gserviceaccount.com")), false);
  assert.equal(byId.get("cloud-sql-user:create:migrator").argv[3], desired.cloudSql.migratorIamUser);
  assert.ok(byId.has("cloud-sql-user:create:migrator"));
  // The conditional custom role, with exactly the parsed permissions.
  assert.ok(byId.get("custom-role:create").argv.includes(`--permissions=${desired.customRole.permissions.join(",")}`));
  const conditional = ops(result, (entry) => entry.id.startsWith("project-iam:bind:projects/synthetic-ops-project/roles/"));
  assert.equal(conditional.length, 1);
  assert.ok(conditional[0].argv.includes(`--condition=expression=${manifest.quarantineStoreCondition(desired).expression},`
    + "title=tibotattle-quarantine-bucket"));
  // The IAM-private service and its invoker bindings, rendered from EP-7.
  const service = JSON.parse(byId.get("run-service:create").file.content);
  assert.equal(service.metadata.annotations["run.googleapis.com/invoker-iam-disabled"], "false");
  assert.equal(service.spec.template.spec.containers[0].image,
    `${desired.artifactRegistry.imageRepository}@sha256:${BOOTSTRAP.imageDigest}`);
  assert.deepEqual(ops(result, (entry) => entry.id.startsWith("run-service-iam:bind:")).map((entry) => entry.argv.at(-1)),
    ["--role=roles/run.invoker", "--role=roles/run.invoker"]);
  // Exactly the three fast-path jobs, all created; only the refresh trigger
  // waits, for the owner's cadence, and with it the scheduler's executor grant
  // on the refresh job. The maintenance trigger has its own: every minute.
  assert.deepEqual(ops(result, (entry) => entry.id.startsWith("run-job:")).map((entry) => entry.id),
    ["run-job:create:production-migrate", "run-job:create:analytics-refresh", "run-job:create:maintenance"]);
  const maintenance = JSON.parse(byId.get("run-job:create:maintenance").file.content);
  assert.deepEqual(maintenance.spec.template.spec.template.spec.containers[0].args,
    ["dist/postgres-maintenance-job.mjs", "--profile=maintenance-job"]);
  assert.deepEqual(maintenance.spec.template.spec.template.spec.containers[0].env
    .filter((entry) => entry.valueFrom !== undefined).map((entry) => [entry.name, entry.valueFrom.secretKeyRef]),
  [["IDENTITY_LINK_SECRET", { name: "IDENTITY_LINK_SECRET", key: "1" }]]);
  assert.equal(maintenance.spec.template.spec.template.spec.serviceAccountName, desired.serviceAccounts.runtime.email);
  assert.deepEqual(byId.get("scheduler:create:maintenance").argv, ["scheduler", "jobs", "create", "http",
    "synthetic-maintenance-trigger", ...manifest.schedulerFlags(desired, "maintenance")]);
  assert.ok(byId.get("scheduler:create:maintenance").argv.includes("--schedule=* * * * *"));
  assert.equal(byId.get("scheduler:create:maintenance").deferred, undefined);
  assert.deepEqual(byId.get("scheduler:pause:maintenance").argv, ["scheduler", "jobs", "pause",
    "synthetic-maintenance-trigger", "--project=synthetic-ops-project", "--location=us-east1"]);
  assert.deepEqual(byId.get(`run-job-iam:maintenance:bind:roles/run.jobsExecutor|${desired.serviceAccounts.scheduler.member}|`).argv,
    ["run", "jobs", "add-iam-policy-binding", "synthetic-maintenance", "--project=synthetic-ops-project",
      "--region=us-east1", `--member=${desired.serviceAccounts.scheduler.member}`, "--role=roles/run.jobsExecutor"]);
  const refresh = JSON.parse(byId.get("run-job:create:analytics-refresh").file.content);
  assert.deepEqual(refresh.spec.template.spec.template.spec.containers[0].args,
    ["--max-old-space-size=12288", "dist/analytics-refresh.mjs", "--mode=full"]);
  assert.deepEqual(ops(result, (entry) => entry.deferred !== undefined).map((entry) => [entry.id, entry.deferred]), [
    ["scheduler:create:analytics-refresh", "SCHEDULER_CADENCE_UNSET"],
    [EXECUTOR(desired), "SCHEDULER_CADENCE_UNSET"],
  ]);
  // No bucket update, no bucket IAM operation, no delete.
  for (const entry of result.operations) {
    assert.equal(entry.argv.includes("buckets") && entry.argv[0] === "storage", false, entry.id);
    assert.doesNotMatch(entry.argv.join(" "), /gs:\/\//u, entry.id);
    assert.ok(operations.EXECUTABLE_ACTIONS.includes(entry.action), entry.id);
    assert.doesNotMatch(entry.argv.join(" "), /LEDGER|HISTORY_PROOF/u, entry.id);
  }
  // The edge invoker and verifier get run.invoker on the service and nothing in the project.
  for (const account of ["edgeInvoker", "verifier"]) {
    assert.equal(ops(result, (entry) => entry.id.startsWith("project-iam:")
      && entry.argv.includes(`--member=${desired.serviceAccounts[account].member}`)).length, 0, account);
  }
});

test("apply refuses the synthetic fixture, a missing authorization and an unpinned proof before any call", () => {
  const synthetic = desiredState();
  const gcloud = fake(synthetic, bornWorld(synthetic));
  const digest = plan(synthetic, gcloud.runner, { bootstrap: BOOTSTRAP }).planDigest;
  gcloud.calls.length = 0;
  assert.throws(() => operations.applyInfrastructure(synthetic, { runner: gcloud.runner, authorize: digest,
    bootstrap: BOOTSTRAP }), { code: "APPLY_SYNTHETIC_TARGET_REFUSED" });
  const desired = desiredState({ synthetic: false });
  for (const [authorize, code] of [[undefined, "APPLY_AUTHORIZATION_REQUIRED"], [null, "APPLY_AUTHORIZATION_REQUIRED"],
    ["plan", "APPLY_AUTHORIZATION_INVALID"], ["A".repeat(64), "APPLY_AUTHORIZATION_INVALID"]]) {
    assert.throws(() => operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize }), { code });
  }
  const unpinned = desiredState({ synthetic: false, mutate: (value) => { value.bucket.proof = null; } });
  assert.throws(() => operations.applyInfrastructure(unpinned, { runner: gcloud.runner, authorize: digest }),
    { code: "APPLY_BUCKET_PROOF_UNPINNED" });
  assert.equal(gcloud.calls.length, 0);
  // Readback reports the unpinned proof; the plan blocks on it.
  const unpinnedPlan = plan(unpinned, fake(unpinned, bornWorld(unpinned)).runner, { bootstrap: BOOTSTRAP });
  assert.deepEqual(unpinnedPlan.findings, ["BUCKET_PROOF_UNPINNED"]);
  assert.deepEqual(unpinnedPlan.blockers, ["BUCKET_PROOF_UNPINNED"]);
});

test("apply refuses a stale planDigest with read calls only", () => {
  const desired = desiredState({ synthetic: false });
  const world = bornWorld(desired);
  const gcloud = fake(desired, world);
  const stale = plan(desired, gcloud.runner, { bootstrap: BOOTSTRAP }).planDigest;
  world.serviceAccounts.push({ email: desired.serviceAccounts.builder.email, disabled: false });
  gcloud.calls.length = 0;
  assert.throws(() => operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: stale,
    bootstrap: BOOTSTRAP, createSpecWriter: () => gcloud.writer.create() }), { code: "APPLY_PLAN_DIGEST_MISMATCH" });
  assert.ok(gcloud.calls.length > 0);
  assert.deepEqual([...new Set(kinds(gcloud.calls))], ["read"]);
  assert.equal(gcloud.writer.closed, 0);
});

/** Plans a doctored live estate, then applies with that plan's own digest. */
function refusedApply(mutateWorld, code, { mutateDesired, options = {} } = {}) {
  const desired = desiredState({ synthetic: false, mutate: mutateDesired });
  const world = convergedWorld(desired, options);
  mutateWorld(world, desired);
  const gcloud = fake(desired, world);
  const result = plan(desired, gcloud.runner, options);
  gcloud.calls.length = 0;
  assert.throws(() => operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: result.planDigest,
    createSpecWriter: () => gcloud.writer.create(), ...options }), { code }, code);
  assert.deepEqual([...new Set(kinds(gcloud.calls))], ["read"], code);
  return result;
}

test("apply refuses any plan that holds a delete", () => {
  const instance = (world) => world.sqlInstances[0];
  const cases = [
    // A second Cloud SQL instance (decision D4).
    (world) => { world.sqlInstances.push({ ...structuredClone(instance(world)), name: "example-second-instance" }); },
    // A read replica is an instance too.
    (world) => { world.sqlInstances.push({ ...structuredClone(instance(world)), name: "example-replica",
      instanceType: "READ_REPLICA_INSTANCE" }); },
    // A public invoker on the IAM-private service.
    (world, desired) => { world.servicePolicies[desired.service.name].bindings.push({ role: "roles/run.invoker",
      members: ["allUsers"] }); },
    // A project role for the edge invoker.
    (world, desired) => { world.projectPolicy.bindings.push({ role: "roles/viewer",
      members: [desired.serviceAccounts.edgeInvoker.member] }); },
    // An extra project role for the runtime.
    (world, desired) => { world.projectPolicy.bindings.push({ role: "roles/storage.admin",
      members: [desired.serviceAccounts.runtime.member] }); },
    // A job outside the fast path.
    (world, desired) => { world.jobs.push({ ...structuredClone(world.jobs[0]),
      metadata: { name: "example-analytics-delivery" } }); void desired; },
    // A scheduler trigger while the owner's cadence is unset.
    (world, desired) => { world.schedulerJobs.push({
      name: `projects/${desired.project}/locations/${desired.region}/jobs/${desired.scheduler["analytics-refresh"].name}`,
      schedule: "0 * * * *", timeZone: "Etc/UTC", state: "ENABLED", httpTarget: {} }); },
  ];
  for (const mutate of cases) {
    const result = refusedApply(mutate, "APPLY_DELETE_REFUSED");
    assert.ok(result.operations.some((entry) => entry.action === "delete"));
    assert.equal(result.summary.executable, 0);
  }
});

test("apply refuses destructive changes", () => {
  const cases = [
    (world) => { world.sqlInstances[0].databaseVersion = "POSTGRES_16"; },
    (world) => { world.sqlInstances[0].settings.edition = "ENTERPRISE_PLUS"; },
    (world) => { world.sqlInstances[0].settings.ipConfiguration.authorizedNetworks = [{ value: "192.0.2.0/24" }]; },
    (world) => { world.sqlInstances[0].settings.backupConfiguration.backupRetentionSettings.retainedBackups = 60; },
    (world) => { world.roles[0].includedPermissions.push("storage.buckets.update"); },
    (world) => { world.projectPolicy.auditConfigs = [{ service: "storage.googleapis.com",
      auditLogConfigs: [{ logType: "DATA_READ" }] }]; },
    (world) => { world.logBucket.retentionDays = 400; },
    (world) => { world.secrets[0].replication = { automatic: {} }; },
    (world) => { world.repositories[0].format = "MAVEN"; },
  ];
  for (const mutate of cases) {
    const result = refusedApply(mutate, "APPLY_DESTRUCTIVE_CHANGE_REFUSED");
    assert.ok(result.operations.some((entry) => entry.action === "destructive"));
  }
});

test("apply refuses bucket metadata changes and a stale or public bucket, and never touches bucket IAM", () => {
  for (const mutate of [
    (world) => { world.buckets[0].softDeletePolicy = { retentionDurationSeconds: "604800" }; },
    (world) => { world.buckets[0].lifecycle = { rule: [{ action: { type: "Delete" } }] }; },
    (world) => { world.buckets[0].versioning = { enabled: true }; },
    (world) => { world.buckets[0].iamConfiguration.publicAccessPrevention = "inherited"; },
  ]) {
    const result = refusedApply(mutate, "BUCKET_METADATA_UPDATE_REFUSED");
    const updates = ops(result, (entry) => entry.action === "bucket-update");
    assert.equal(updates.length, 1);
  }
  const stale = refusedApply((world) => { world.buckets[0].metageneration = "2"; }, "BUCKET_PROOF_STALE");
  assert.deepEqual(stale.findings, ["BUCKET_PROOF_STALE"]);
  refusedApply((world) => { world.buckets[0].generation = "1700000000000002"; }, "BUCKET_PROOF_STALE");
  const exposed = refusedApply((world, desired) => {
    world.bucketPolicies[desired.bucket.name] = { bindings: [{ role: "roles/storage.objectViewer", members: ["allUsers"] }] };
  }, "APPLY_BLOCKED");
  assert.deepEqual(exposed.blockers, ["BUCKET_POLICY_PUBLIC_MEMBER"]);
  const absent = refusedApply((world) => { world.buckets.length = 0; }, "APPLY_BLOCKED");
  assert.deepEqual(absent.blockers, ["BUCKET_ABSENT"]);
  refusedApply((world) => { world.roles[0].deleted = true; }, "APPLY_BLOCKED");
});

test("apply runs only the authorized plan, mutating only after its reads, and converges", () => {
  const desired = desiredState({ synthetic: false, mutate: CADENCE });
  const world = bornWorld(desired);
  const gcloud = fake(desired, world);
  const result = plan(desired, gcloud.runner, { bootstrap: BOOTSTRAP, ...UNDEFERRED });
  assert.deepEqual(result.summary, { executable: 41, deferred: 0, refused: 0 });
  gcloud.calls.length = 0;
  const receipt = operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: result.planDigest,
    bootstrap: BOOTSTRAP, createSpecWriter: () => gcloud.writer.create(), ...UNDEFERRED });
  assert.equal(receipt.schema, "tibotattle-gcp-ops-infra-apply-v1");
  assert.equal(receipt.outcomes.length, result.operations.length);
  assert.ok(receipt.outcomes.every((entry) => entry.outcome === "applied"));
  assert.deepEqual(receipt.remaining, { planDigest: receipt.remaining.planDigest, executable: 0, deferred: 0, refused: 0 });
  assert.equal(gcloud.writer.closed, 1);
  const sequence = kinds(gcloud.calls);
  const firstMutation = sequence.indexOf("mutate");
  const lastMutation = sequence.lastIndexOf("mutate");
  assert.ok(firstMutation > 0 && sequence.slice(0, firstMutation).every((kind) => kind === "read"));
  assert.equal(sequence.filter((kind) => kind === "mutate").length, 41);
  assert.ok(sequence.slice(lastMutation + 1).every((kind) => kind === "read"));
  // Both triggers were created and then paused; apply never resumes either.
  assert.equal(trigger(world).state, "PAUSED");
  assert.equal(maintenanceTrigger(world).state, "PAUSED");
  assert.equal(maintenanceTrigger(world).schedule, "* * * * *");
  assert.equal(gcloud.calls.some((argv) => argv.includes("resume")), false);
  // A second apply of the now-empty plan changes nothing.
  gcloud.calls.length = 0;
  const empty = plan(desired, gcloud.runner, UNDEFERRED);
  assert.equal(empty.summary.executable, 0);
  assert.deepEqual(empty.findings, []);
  operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: empty.planDigest,
    createSpecWriter: () => gcloud.writer.create(), ...UNDEFERRED });
  assert.equal(kinds(gcloud.calls).includes("mutate"), false);
});

test("by default the analytics-refresh job deploys, and its trigger is created and paused before it may run the job", () => {
  const desired = desiredState({ synthetic: false, mutate: CADENCE });
  const world = bornWorld(desired);
  const gcloud = fake(desired, world);
  const result = plan(desired, gcloud.runner, { bootstrap: BOOTSTRAP });
  assert.deepEqual(result.summary, { executable: 41, deferred: 0, refused: 0 });
  // Create, then pause at once, then (only then) the scheduler's run.jobsExecutor, for each trigger in turn.
  const executor = `run-job-iam:analytics-refresh:bind:roles/run.jobsExecutor|${desired.serviceAccounts.scheduler.member}|`;
  const maintenanceExecutor = `run-job-iam:maintenance:bind:roles/run.jobsExecutor|${desired.serviceAccounts.scheduler.member}|`;
  assert.deepEqual(result.operations.slice(-6).map((entry) => entry.id), [
    "scheduler:create:analytics-refresh", "scheduler:pause:analytics-refresh", executor,
    "scheduler:create:maintenance", "scheduler:pause:maintenance", maintenanceExecutor]);
  const receipt = operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: result.planDigest,
    bootstrap: BOOTSTRAP, createSpecWriter: () => gcloud.writer.create() });
  assert.deepEqual({ ...receipt.remaining, planDigest: null }, { planDigest: null, executable: 0, deferred: 0, refused: 0 });
  assert.deepEqual(world.jobs.map((job) => job.metadata.name),
    ["synthetic-production-migrate", "synthetic-analytics-refresh", "synthetic-maintenance"]);
  assert.equal(trigger(world).state, "PAUSED");
  assert.equal(maintenanceTrigger(world).state, "PAUSED");
  const after = plan(desired, gcloud.runner);
  assert.deepEqual({ ...operations.infrastructureCleanliness(after) }, { clean: true, reasons: [] });
  // Nothing left to create: a bootstrap image would be unused, so it is refused.
  assert.throws(() => plan(desired, gcloud.runner, { bootstrap: BOOTSTRAP }), { code: "BOOTSTRAP_IMAGE_UNUSED" });
  // The deferral mechanism stays, closed, for a job whose entry cannot yet run; such a deferral is never clean.
  const deferred = plan(desired, fake(desired, bornWorld(desired)).runner,
    { bootstrap: BOOTSTRAP, jobDeferrals: { "analytics-refresh": "SYNTHETIC_ENTRY_UNAVAILABLE" } });
  assert.deepEqual(ops(deferred, (entry) => entry.deferred !== undefined).map((entry) => entry.deferred),
    Array(3).fill("SYNTHETIC_ENTRY_UNAVAILABLE"));
  assert.ok(operations.infrastructureCleanliness(deferred).reasons
    .includes("DEFERRED:run-job:create:analytics-refresh:SYNTHETIC_ENTRY_UNAVAILABLE"));
  assert.throws(() => plan(desired, gcloud.runner, { jobDeferrals: { "analytics-delivery": "X" } }),
    { code: "JOB_DEFERRALS_INVALID" });
  assert.throws(() => plan(desired, gcloud.runner, { jobDeferrals: { "analytics-refresh": "lower case" } }),
    { code: "JOB_DEFERRALS_INVALID" });
});

test("a trigger whose pause failed after its create is paused by the next plan, not reported converged", () => {
  const desired = desiredState({ synthetic: false, mutate: CADENCE });
  const world = bornWorld(desired);
  const failing = fake(desired, world, { failWhen: (argv) => argv.slice(0, 3).join(" ") === "scheduler jobs pause" });
  const first = plan(desired, failing.runner, { bootstrap: BOOTSTRAP, ...UNDEFERRED });
  assert.throws(() => operations.applyInfrastructure(desired, { runner: failing.runner, authorize: first.planDigest,
    bootstrap: BOOTSTRAP, createSpecWriter: () => failing.writer.create(), ...UNDEFERRED }),
  (error) => error.code === "APPLY_OPERATION_FAILED" && error.operation === "scheduler:pause:analytics-refresh");
  // Cloud Scheduler created the trigger ENABLED, and the pause never ran; nor
  // did the scheduler's run.jobsExecutor, so the running trigger cannot start the job.
  assert.equal(trigger(world).state, "ENABLED");
  assert.equal(JSON.stringify(world.jobPolicies["synthetic-analytics-refresh"]).includes("roles/run.jobsExecutor"), false);
  const gcloud = fake(desired, world);
  const readback = operations.readbackInfrastructure(desired, { runner: gcloud.runner });
  assert.deepEqual(readback.findings, ["SCHEDULER_TRIGGER_ENABLED:analytics-refresh"]);
  const replan = operations.planInfrastructure(desired, readback, UNDEFERRED);
  // The maintenance job was created before the scheduler section failed; its own trigger was never reached.
  assert.deepEqual(replan.operations.map((entry) => [entry.id, entry.action, entry.argv.slice(0, 4).join(" ")]),
    [["scheduler:pause:analytics-refresh", "update", `scheduler jobs pause ${TRIGGER}`],
      [`run-job-iam:analytics-refresh:bind:roles/run.jobsExecutor|${desired.serviceAccounts.scheduler.member}|`, "bind",
        "run jobs add-iam-policy-binding synthetic-analytics-refresh"],
      ["scheduler:create:maintenance", "create", "scheduler jobs create http"],
      ["scheduler:pause:maintenance", "update", `scheduler jobs pause ${MAINTENANCE_TRIGGER}`],
      [`run-job-iam:maintenance:bind:roles/run.jobsExecutor|${desired.serviceAccounts.scheduler.member}|`, "bind",
        "run jobs add-iam-policy-binding synthetic-maintenance"]]);
  assert.deepEqual(replan.summary, { executable: 5, deferred: 0, refused: 0 });
  assert.equal(operations.infrastructureCleanliness(replan).clean, false);
  operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: replan.planDigest,
    createSpecWriter: () => gcloud.writer.create(), ...UNDEFERRED });
  assert.equal(trigger(world).state, "PAUSED");
  const settled = plan(desired, gcloud.runner, UNDEFERRED);
  assert.deepEqual([settled.findings, settled.operations], [[], []]);
  // A process killed between the two calls ends in the same state and the same recovery.
  const killed = convergedWorld(desired, UNDEFERRED);
  trigger(killed).state = "ENABLED";
  assert.deepEqual(plan(desired, fake(desired, killed).runner, UNDEFERRED).operations.map((entry) => entry.id),
    ["scheduler:pause:analytics-refresh"]);
});

test("the scheduler's executor grant follows its trigger: withheld while the cadence is unset, and a live grant blocks the create", () => {
  const JOB_POLICY = "synthetic-analytics-refresh";
  const granted = (world) => JSON.stringify(world.jobPolicies[JOB_POLICY] ?? {}).includes("roles/run.jobsExecutor");
  const unset = desiredState({ synthetic: false });
  const scheduled = desiredState({ synthetic: false, mutate: CADENCE });
  const world = bornWorld(unset);
  const apply = (desired, gcloud, result, options = {}) => operations.applyInfrastructure(desired, { runner: gcloud.runner,
    authorize: result.planDigest, createSpecWriter: () => gcloud.writer.create(), ...UNDEFERRED, ...options });
  const create = "scheduler:create:analytics-refresh";
  const pause = "scheduler:pause:analytics-refresh";

  // No cadence: the jobs are created, but no trigger and no grant, so nothing can start the job.
  const gcloud = fake(unset, world);
  const first = plan(unset, gcloud.runner, { bootstrap: BOOTSTRAP, ...UNDEFERRED });
  assert.deepEqual(ops(first, (entry) => entry.deferred !== undefined).map((entry) => [entry.id, entry.deferred]),
    [[create, "SCHEDULER_CADENCE_UNSET"], [EXECUTOR(unset), "SCHEDULER_CADENCE_UNSET"]]);
  apply(unset, gcloud, first, { bootstrap: BOOTSTRAP });
  assert.deepEqual([granted(world), world.schedulerJobs.length, world.jobs.length], [false, 0, 2]);
  assert.equal(operations.infrastructureCleanliness(plan(unset, gcloud.runner, UNDEFERRED)).clean, true);

  // The owner commits a cadence: the next plan creates, pauses, and only then grants.
  const later = plan(scheduled, fake(scheduled, world).runner, UNDEFERRED);
  assert.deepEqual([later.blockers, later.operations.map((entry) => entry.id)], [[], [create, pause, EXECUTOR(scheduled)]]);
  // A pause that fails leaves an ENABLED trigger the account cannot yet use to start the job.
  const failing = fake(scheduled, world, { failWhen: (argv) => argv.slice(0, 3).join(" ") === "scheduler jobs pause" });
  assert.throws(() => apply(scheduled, failing, later), (error) => error.code === "APPLY_OPERATION_FAILED"
    && error.operation === pause);
  assert.deepEqual([trigger(world).state, granted(world)], ["ENABLED", false]);
  // The next plan pauses it and only then grants, and then the estate has converged.
  const repair = fake(scheduled, world);
  const replan = plan(scheduled, repair.runner, UNDEFERRED);
  assert.deepEqual(replan.operations.map((entry) => entry.id), [pause, EXECUTOR(scheduled)]);
  apply(scheduled, repair, replan);
  assert.deepEqual([trigger(world).state, granted(world)], ["PAUSED", true]);
  assert.deepEqual(plan(scheduled, repair.runner, UNDEFERRED).operations, []);

  // A grant that is already live when a create is planned (the trigger was removed by hand, or the
  // estate was bound before it) would let the ENABLED trigger start the job before its pause: the
  // plan blocks, and apply, which never removes a grant, refuses it without a single mutation.
  world.schedulerJobs = [];
  const blockedGcloud = fake(scheduled, world);
  const blocked = plan(scheduled, blockedGcloud.runner, UNDEFERRED);
  assert.deepEqual(blocked.blockers, ["SCHEDULER_CREATE_EXECUTOR_BOUND:analytics-refresh"]);
  assert.deepEqual(blocked.operations.map((entry) => entry.id), [create, pause]);
  assert.deepEqual([...operations.infrastructureCleanliness(blocked).reasons], [
    "BLOCKER:SCHEDULER_CREATE_EXECUTOR_BOUND:analytics-refresh", `EXECUTABLE:${create}`, `EXECUTABLE:${pause}`]);
  blockedGcloud.calls.length = 0;
  assert.throws(() => apply(scheduled, blockedGcloud, blocked), { code: "APPLY_BLOCKED" });
  assert.equal(kinds(blockedGcloud.calls).includes("mutate"), false);
  assert.equal(world.schedulerJobs.length, 0);
  // The owner removes the grant by hand; the next plan clears the block and restores the order.
  world.jobPolicies[JOB_POLICY] = {};
  const cleared = plan(scheduled, fake(scheduled, world).runner, UNDEFERRED);
  assert.deepEqual([cleared.blockers, cleared.operations.map((entry) => entry.id)],
    [[], [create, pause, EXECUTOR(scheduled)]]);
  apply(scheduled, fake(scheduled, world), cleared);
  assert.deepEqual([trigger(world).state, granted(world)], ["PAUSED", true]);
  // A live trigger with its grant is the converged estate, not a create, so it blocks nothing.
  const live = plan(scheduled, fake(scheduled, world).runner, UNDEFERRED);
  assert.deepEqual([live.blockers, live.operations], [[], []]);
});

test("the trigger's desired state is honoured without ever resuming, and an unknown live state blocks", () => {
  const paused = desiredState({ synthetic: false, mutate: CADENCE });
  const resumed = desiredState({ synthetic: false, mutate: (value) => {
    CADENCE(value);
    value.scheduler["analytics-refresh"].state = "ENABLED";
  } });
  const world = convergedWorld(paused, UNDEFERRED);
  assert.equal(trigger(world).state, "PAUSED");
  // OPS-3 has not resumed it yet: the resume is deferred to OPS-3, never run.
  const gcloud = fake(resumed, world);
  const waiting = plan(resumed, gcloud.runner, UNDEFERRED);
  assert.deepEqual(waiting.findings, []);
  assert.deepEqual(waiting.operations.map((entry) => [entry.id, entry.deferred]),
    [["scheduler:resume:analytics-refresh", "SCHEDULER_TRIGGER_RESUME_PENDING"]]);
  assert.equal(operations.infrastructureCleanliness(waiting).clean, true);
  gcloud.calls.length = 0;
  const receipt = operations.applyInfrastructure(resumed, { runner: gcloud.runner, authorize: waiting.planDigest,
    createSpecWriter: () => gcloud.writer.create(), ...UNDEFERRED });
  assert.deepEqual(receipt.outcomes, [{ id: "scheduler:resume:analytics-refresh", outcome: "deferred",
    reason: "SCHEDULER_TRIGGER_RESUME_PENDING" }]);
  assert.equal(kinds(gcloud.calls).includes("mutate"), false);
  assert.equal(trigger(world).state, "PAUSED");
  // Once OPS-3 resumes it, a desired ENABLED trigger is left running.
  trigger(world).state = "ENABLED";
  const running = plan(resumed, fake(resumed, world).runner, UNDEFERRED);
  assert.deepEqual([running.findings, running.operations], [[], []]);
  // A live state that is neither ENABLED nor PAUSED is the owner's to resolve.
  for (const state of ["DISABLED", "UPDATE_FAILED", "MARKER-STATE", undefined]) {
    const result = refusedApply((doctored) => {
      if (state === undefined) delete trigger(doctored).state;
      else trigger(doctored).state = state;
    }, "APPLY_BLOCKED", { mutateDesired: CADENCE, options: UNDEFERRED });
    assert.deepEqual(result.blockers, ["SCHEDULER_TRIGGER_STATE_UNRECOGNIZED:analytics-refresh"], String(state));
    assert.deepEqual(result.findings, ["SCHEDULER_TRIGGER_STATE_UNRECOGNIZED:analytics-refresh"], String(state));
    assert.doesNotMatch(JSON.stringify(result), /MARKER/u);
  }
});

test("a disabled managed account or a non-GA custom role blocks apply and is never re-enabled", () => {
  for (const [mutate, code] of [
    [(world, desired) => {
      world.serviceAccounts.find((account) => account.email === desired.serviceAccounts.edgeInvoker.email).disabled = true;
    }, "SERVICE_ACCOUNT_DISABLED:edgeInvoker"],
    [(world, desired) => {
      world.serviceAccounts.find((account) => account.email === desired.serviceAccounts.verifier.email).disabled = true;
    }, "SERVICE_ACCOUNT_DISABLED:verifier"],
    [(world) => { world.roles[0].stage = "DISABLED"; }, "CUSTOM_ROLE_DISABLED"],
    [(world) => { world.roles[0].stage = "BETA"; }, "CUSTOM_ROLE_STAGE_NOT_GA"],
    [(world) => { world.roles[0].stage = "DEPRECATED"; }, "CUSTOM_ROLE_STAGE_NOT_GA"],
    [(world) => { world.roles[0].stage = "MARKER-STAGE"; }, "CUSTOM_ROLE_STAGE_NOT_GA"],
  ]) {
    const result = refusedApply(mutate, "APPLY_BLOCKED");
    assert.deepEqual(result.blockers, [code], code);
    assert.deepEqual(result.findings, [code], code);
    assert.equal(result.summary.executable, 0, code);
    assert.equal(result.operations.some((entry) => entry.argv.includes("enable")
      || entry.argv.some((arg) => arg.startsWith("--stage"))), false, code);
    assert.doesNotMatch(JSON.stringify(result), /MARKER/u, code);
  }
  // Bundled with unrelated drift, the disabled account still refuses the whole plan.
  const bundled = refusedApply((world, desired) => {
    world.serviceAccounts.find((account) => account.email === desired.serviceAccounts.edgeInvoker.email).disabled = true;
    world.logBucket.retentionDays = 7;
  }, "APPLY_BLOCKED");
  assert.deepEqual(ops(bundled, (entry) => entry.deferred === undefined).map((entry) => entry.id),
    ["logging-bucket:update"]);
});

test("OPS-10's clean verdict needs no finding, blocker, executable, refused or unexpected deferred operation", () => {
  assert.deepEqual([...operations.CLEAN_DEFERRALS], ["SCHEDULER_CADENCE_UNSET", "SCHEDULER_TRIGGER_RESUME_PENDING"]);
  const desired = desiredState({ synthetic: false });
  const world = convergedWorld(desired);
  const converged = plan(desired, fake(desired, world).runner);
  assert.deepEqual(converged.summary, { executable: 0, deferred: 2, refused: 0 });
  assert.deepEqual({ ...operations.infrastructureCleanliness(converged) }, { clean: true, reasons: [] });
  // The cutover's stricter form (readback --require-cadence) refuses exactly the unset cadence's two deferrals.
  assert.deepEqual({ ...operations.infrastructureCleanliness(converged, { requireCadence: true }) }, { clean: false,
    reasons: ["DEFERRED:scheduler:create:analytics-refresh:SCHEDULER_CADENCE_UNSET",
      `DEFERRED:${EXECUTOR(desired)}:SCHEDULER_CADENCE_UNSET`] });
  assert.throws(() => operations.infrastructureCleanliness(converged, { requireCadence: "yes" }),
    { code: "CLEANLINESS_OPTIONS_INVALID" });
  // A committed cadence, with its trigger created paused, is clean in both forms.
  const scheduled = desiredState({ synthetic: false, mutate: CADENCE });
  const settled = plan(scheduled, fake(scheduled, convergedWorld(scheduled, UNDEFERRED)).runner, UNDEFERRED);
  for (const requireCadence of [false, true]) {
    assert.deepEqual({ ...operations.infrastructureCleanliness(settled, { requireCadence }) },
      { clean: true, reasons: [] }, String(requireCadence));
  }
  const verdict = (mutate) => {
    const copy = structuredClone(world);
    mutate(copy);
    return operations.infrastructureCleanliness(plan(desired, fake(desired, copy).runner));
  };
  assert.deepEqual({ ...verdict((copy) => { copy.buckets[0].metageneration = "2"; }) },
    { clean: false, reasons: ["FINDING:BUCKET_PROOF_STALE"] });
  assert.deepEqual([...verdict((copy) => { copy.sink.exclusions[0].disabled = true; }).reasons],
    ["EXECUTABLE:logging-exclusion:update"]);
  assert.deepEqual([...verdict((copy) => { copy.logBucket.retentionDays = 400; }).reasons],
    ["REFUSED:logging-bucket:destructive"]);
  assert.deepEqual([...verdict((copy) => { copy.roles[0].stage = "DISABLED"; }).reasons],
    ["FINDING:CUSTOM_ROLE_DISABLED", "BLOCKER:CUSTOM_ROLE_DISABLED"]);
  assert.deepEqual([...verdict((copy) => { copy.services[0].spec.template.spec.containers[0].image = "example.invalid/x"; })
    .reasons], ["DEFERRED:run-service:update:SERVICE_LIVE_IMAGE_UNRECOGNIZED"]);
  // An empty project is far from clean, and an unpinned proof never is.
  assert.equal(operations.infrastructureCleanliness(plan(desired, fake(desired, bornWorld(desired)).runner)).clean, false);
  const unpinned = desiredState({ synthetic: false, mutate: (value) => { value.bucket.proof = null; } });
  assert.deepEqual([...operations.infrastructureCleanliness(plan(unpinned, fake(unpinned, world).runner)).reasons],
    ["FINDING:BUCKET_PROOF_UNPINNED", "BLOCKER:BUCKET_PROOF_UNPINNED",
      // OD-2: the service and the maintenance job render the pinned proof, so each defers without one.
      "DEFERRED:run-service:update:BUCKET_PROOF_UNPINNED",
      "DEFERRED:run-job:update:maintenance:BUCKET_PROOF_UNPINNED"]);
});

test("apply never changes a live image or source commit, and refuses an unneeded bootstrap image", () => {
  const desired = desiredState({ synthetic: false });
  const world = convergedWorld(desired);
  const live = (name) => world.services.find((service) => service.metadata.name === name);
  assert.ok(live(desired.service.name).spec.template.spec.containers[0].image.endsWith(LIVE_IMAGE.imageDigest));
  // Nothing to create: a bootstrap image would be a silent rollout, so it is refused.
  assert.throws(() => plan(desired, fake(desired, world).runner, { bootstrap: BOOTSTRAP }), { code: "BOOTSTRAP_IMAGE_UNUSED" });
  assert.throws(() => operations.applyInfrastructure(desired, { runner: fake(desired, world).runner,
    authorize: "0".repeat(64), bootstrap: BOOTSTRAP }), { code: "BOOTSTRAP_IMAGE_UNUSED" });
  // Drift the service and a job: the updates carry the live image and commit.
  const scaled = desiredState({ synthetic: false, mutate: (value) => {
    value.service.maxInstances = 3;
    value.service.rolloutOverlapInstances = 3;
  } });
  world.jobs.find((job) => job.metadata.name === "synthetic-production-migrate").spec.template.spec.template.spec
    .maxRetries = 3;
  const gcloud = fake(scaled, world);
  const result = plan(scaled, gcloud.runner);
  const update = result.operations.find((entry) => entry.id === "run-service:update");
  const spec = JSON.parse(update.file.content);
  const container = spec.spec.template.spec.containers[0];
  assert.equal(container.image, `${scaled.artifactRegistry.imageRepository}@sha256:${LIVE_IMAGE.imageDigest}`);
  assert.equal(container.env.find((entry) => entry.name === "DEPLOYMENT_SOURCE_COMMIT").value, LIVE_IMAGE.sourceCommit);
  assert.equal(spec.spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"], "3");
  const job = JSON.parse(result.operations.find((entry) => entry.id === "run-job:update:production-migrate").file.content);
  assert.ok(job.spec.template.spec.template.spec.containers[0].image.endsWith(LIVE_IMAGE.imageDigest));
  operations.applyInfrastructure(scaled, { runner: gcloud.runner, authorize: result.planDigest,
    createSpecWriter: () => gcloud.writer.create() });
  assert.ok(live(scaled.service.name).spec.template.spec.containers[0].image.endsWith(LIVE_IMAGE.imageDigest));
  // A live image apply cannot recognize defers the update instead of guessing.
  live(scaled.service.name).spec.template.spec.containers[0].image = "example.invalid/other:latest";
  const unrecognized = plan(desiredState({ synthetic: false, mutate: (value) => {
    value.service.maxInstances = 2;
    value.service.rolloutOverlapInstances = 2;
  } }), fake(scaled, world).runner);
  assert.equal(unrecognized.operations.find((entry) => entry.id === "run-service:update").deferred,
    "SERVICE_LIVE_IMAGE_UNRECOGNIZED");
});

test("first creates wait for a bootstrap image and the owner's pinned, enabled secret versions", () => {
  const desired = desiredState({ synthetic: false });
  const noImage = plan(desired, fake(desired, bornWorld(desired)).runner);
  // The service, its two invoker binds and the three jobs wait for an image; the
  // refresh trigger for its cadence, and the scheduler's grant for each scheduled job
  // (the maintenance trigger itself is created, paused, with no image to wait for).
  assert.deepEqual(noImage.operations.filter((entry) => entry.deferred !== undefined).map((entry) => entry.deferred),
    [...Array(6).fill("BOOTSTRAP_IMAGE_REQUIRED"), "SCHEDULER_CADENCE_UNSET", "BOOTSTRAP_IMAGE_REQUIRED",
      "BOOTSTRAP_IMAGE_REQUIRED"]);
  assert.equal(operations.infrastructureCleanliness(noImage).clean, false);
  const noValues = plan(desired, fake(desired, bornWorld(desired, { secrets: false })).runner, { bootstrap: BOOTSTRAP });
  assert.equal(noValues.operations.find((entry) => entry.id === "run-service:create").deferred,
    "SECRET_VERSION_UNAVAILABLE:IDENTITY_LINK_SECRET");
  assert.ok(noValues.operations.some((entry) => entry.id === "secret:create:IDENTITY_LINK_SECRET"));
  const unpinned = desiredState({ synthetic: false, mutate: (value) => { value.secrets.APPLE_PRIVATE_KEY.version = null; } });
  assert.equal(plan(unpinned, fake(unpinned, bornWorld(unpinned)).runner, { bootstrap: BOOTSTRAP })
    .operations.find((entry) => entry.id === "run-service:create").deferred, "SECRET_VERSION_UNPINNED:APPLE_PRIVATE_KEY");
  const disabled = bornWorld(desired);
  disabled.secretVersions.GOOGLE_OIDC_CLIENT_SECRET[0].state = "DISABLED";
  assert.equal(plan(desired, fake(desired, disabled).runner, { bootstrap: BOOTSTRAP })
    .operations.find((entry) => entry.id === "run-service:create").deferred,
  "SECRET_VERSION_UNAVAILABLE:GOOGLE_OIDC_CLIENT_SECRET");
  assert.throws(() => operations.normalizeBootstrap({ imageDigest: "latest", sourceCommit: "d".repeat(40) }),
    { code: "BOOTSTRAP_IMAGE_INVALID" });
});

test("idempotent updates: drift is set back without recreating anything", () => {
  const desired = desiredState({ synthetic: false, mutate: CADENCE });
  const world = convergedWorld(desiredState({ synthetic: false }), UNDEFERRED);
  world.sqlInstances[0].settings.insightsConfig = { queryInsightsEnabled: true };
  world.sqlInstances[0].settings.databaseFlags.push({ name: "log_connections", value: "on" });
  world.sqlInstances[0].settings.tier = "db-custom-1-3840";
  world.repositories[0].dockerConfig.immutableTags = false;
  world.sink.exclusions[0].disabled = true;
  world.logBucket.retentionDays = 7;
  world.roles[0].includedPermissions = world.roles[0].includedPermissions.filter((p) => p !== "storage.objects.list");
  world.sqlInstances[0].settings.dataDiskSizeGb = "80";
  const gcloud = fake(desired, world);
  const result = plan(desired, gcloud.runner, UNDEFERRED);
  assert.deepEqual(result.summary.refused, 0);
  const ids = result.operations.map((entry) => entry.id);
  assert.deepEqual(result.operations.find((entry) => entry.id === "custom-role:update").argv.slice(5),
    ["--add-permissions=storage.objects.list"]);
  for (const id of ["custom-role:update", "artifact-registry:update",
    "cloud-sql:update", "logging-exclusion:update", "logging-bucket:update", "scheduler:create:analytics-refresh",
    "scheduler:pause:analytics-refresh"]) {
    assert.ok(ids.includes(id), id);
  }
  const patch = result.operations.find((entry) => entry.id === "cloud-sql:update");
  assert.equal(patch.reason, "tier,queryInsightsEnabled,databaseFlags");
  assert.ok(patch.argv.includes("--tier=db-custom-2-8192"));
  // A larger disk (auto-increase) is accepted, never shrunk.
  assert.equal(patch.argv.some((arg) => arg.startsWith("--storage-size")), false);
  assert.equal(ids.some((id) => id.endsWith(":create") && /^(?:cloud-sql|run-service|run-job|secret|custom-role)/u.test(id)),
    false);
  operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: result.planDigest,
    createSpecWriter: () => gcloud.writer.create(), ...UNDEFERRED });
  assert.equal(plan(desired, gcloud.runner, UNDEFERRED).summary.executable, 0);
  // A changed cadence is an update; the paused state is left alone.
  const recadenced = desiredState({ synthetic: false, mutate: (value) => {
    value.scheduler["analytics-refresh"].schedule = "45 4 * * *";
  } });
  const again = plan(recadenced, fake(recadenced, world).runner, UNDEFERRED);
  assert.deepEqual(again.operations.map((entry) => entry.id), ["scheduler:update:analytics-refresh"]);
  // A drifted trigger that is also running is paused first, then updated.
  trigger(world).state = "ENABLED";
  assert.deepEqual(plan(recadenced, fake(recadenced, world).runner, UNDEFERRED).operations.map((entry) => entry.id),
    ["scheduler:pause:analytics-refresh", "scheduler:update:analytics-refresh"]);
});

test("a rerun with the instance present creates missing IAM users by their PostgreSQL names, never the full email", () => {
  // The rerun after a first apply that stopped at cloud-sql-user:create: the
  // managed instance and database exist, and neither IAM user does.
  const desired = desiredState({ synthetic: false });
  const instance = desired.cloudSql.instance;
  const world = convergedWorld(desired, UNDEFERRED);
  world.sqlUsers[instance] = world.sqlUsers[instance].filter((user) => user.type !== "CLOUD_IAM_SERVICE_ACCOUNT");
  assert.deepEqual(world.sqlInstances.map((entry) => entry.name), [instance]);
  assert.ok(world.sqlDatabases[instance].some((database) => database.name === desired.cloudSql.database));
  const gcloud = fake(desired, world);
  const users = [["runtime", desired.cloudSql.runtimeIamUser], ["migrator", desired.cloudSql.migratorIamUser]];
  const createArgv = (iamUser) => ["sql", "users", "create", iamUser, `--instance=${instance}`,
    `--project=${desired.project}`, "--type=cloud_iam_service_account"];
  const result = plan(desired, gcloud.runner, UNDEFERRED);
  assert.deepEqual([result.summary.refused, result.findings, result.blockers], [0, [], []]);
  const executable = ops(result, (entry) => entry.deferred === undefined);
  assert.deepEqual(executable.map((entry) => [entry.id, entry.argv]),
    users.map(([role, iamUser]) => [`cloud-sql-user:create:${role}`, createArgv(iamUser)]));
  for (const [role, iamUser] of users) {
    assert.notEqual(iamUser, desired.serviceAccounts[role].email, role);
    assert.equal(desired.serviceAccounts[role].email.endsWith(".gserviceaccount.com"), true, role);
  }
  for (const entry of executable) {
    assert.equal(entry.argv.some((arg) => arg.endsWith(".gserviceaccount.com")), false, entry.id);
  }
  operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: result.planDigest,
    createSpecWriter: () => gcloud.writer.create(), ...UNDEFERRED });
  assert.equal(plan(desired, gcloud.runner, UNDEFERRED).summary.executable, 0);
  // A first apply that made only the runtime user: the rerun creates only the migrator.
  world.sqlUsers[instance] = world.sqlUsers[instance].filter((user) => user.name !== desired.cloudSql.migratorIamUser);
  assert.deepEqual(ops(plan(desired, fake(desired, world).runner, UNDEFERRED), (entry) => entry.deferred === undefined)
    .map((entry) => [entry.id, entry.argv]), [["cloud-sql-user:create:migrator", createArgv(desired.cloudSql.migratorIamUser)]]);
});

test("a failed operation stops apply, journals what ran and closes the spec writer", () => {
  const desired = desiredState({ synthetic: false });
  const gcloud = fake(desired, bornWorld(desired), { failWhen: (argv) => argv[0] === "secrets" && argv[1] === "create" });
  const result = plan(desired, gcloud.runner, { bootstrap: BOOTSTRAP });
  let thrown;
  try {
    operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: result.planDigest, bootstrap: BOOTSTRAP,
      createSpecWriter: () => gcloud.writer.create() });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, "APPLY_OPERATION_FAILED");
  assert.equal(thrown.operation, "secret:create:DISTRIBUTION_GITHUB_API_TOKEN");
  assert.equal(thrown.cause, "GCLOUD_CALL_FAILED:secrets-create");
  assert.deepEqual(thrown.outcomes.at(-1), { id: "secret:create:DISTRIBUTION_GITHUB_API_TOKEN", outcome: "failed" });
  assert.ok(thrown.outcomes.slice(0, -1).every((entry) => entry.outcome === "applied"));
  assert.equal(JSON.stringify(thrown.outcomes).includes("MARKER"), false);
  assert.equal(gcloud.writer.closed, 1);
});

test("the module issues gcloud only as an argv array, with no shell and no delete", () => {
  const source = readFileSync(join(SCRIPTS_ROOT, "gcp-ops-infra-operations.mjs"), "utf8");
  assert.doesNotMatch(source, /\bexecSync\b|\bexec\(|\bexecFile|shell:\s*true|["'`](?:sh|bash|zsh)["'`]/u);
  assert.equal([...source.matchAll(/spawnSync\(/gu)].length, 1);
  assert.match(source, /spawnSync\("gcloud", argv, \{/u);
  assert.doesNotMatch(source, /versions", "access|"access"/u);
});

// ---------------------------------------------------------------------------
// The trigger state model, the verifier's grant, shared projects and the probe

const EXECUTOR = (desired) => `run-job-iam:analytics-refresh:bind:roles/run.jobsExecutor|${
  desired.serviceAccounts.scheduler.member}|`;
const MAINTENANCE_EXECUTOR = (desired) => `run-job-iam:maintenance:bind:roles/run.jobsExecutor|${
  desired.serviceAccounts.scheduler.member}|`;

test("a trigger is never left unpaused at creation, even when its desired state is ENABLED", () => {
  // A desired ENABLED trigger that does not exist yet is still created and
  // paused; the resume waits for OPS-3 like any other.
  const enabled = desiredState({ synthetic: false, mutate: (value) => {
    CADENCE(value);
    value.scheduler["analytics-refresh"].state = "ENABLED";
  } });
  const world = bornWorld(enabled);
  const gcloud = fake(enabled, world);
  const first = plan(enabled, gcloud.runner, { bootstrap: BOOTSTRAP });
  assert.deepEqual(first.operations.slice(-6).map((entry) => entry.id), [
    "scheduler:create:analytics-refresh", "scheduler:pause:analytics-refresh", EXECUTOR(enabled),
    "scheduler:create:maintenance", "scheduler:pause:maintenance", MAINTENANCE_EXECUTOR(enabled)]);
  operations.applyInfrastructure(enabled, { runner: gcloud.runner, authorize: first.planDigest, bootstrap: BOOTSTRAP,
    createSpecWriter: () => gcloud.writer.create() });
  assert.equal(trigger(world).state, "PAUSED");
  assert.equal(maintenanceTrigger(world).state, "PAUSED");
  assert.equal(gcloud.calls.some((argv) => argv.includes("resume")), false);
  assert.deepEqual(plan(enabled, gcloud.runner).operations.map((entry) => [entry.id, entry.deferred]),
    [["scheduler:resume:analytics-refresh", "SCHEDULER_TRIGGER_RESUME_PENDING"]]);
  // The invariant itself refuses a create without its immediate pause, a
  // deferred pause, or a scheduler grant ahead of the pause.
  const create = { id: "scheduler:create:analytics-refresh", action: "create", argv: [] };
  const pause = { id: "scheduler:pause:analytics-refresh", action: "update", argv: [] };
  const bind = { id: EXECUTOR(enabled), action: "bind", argv: [] };
  const other = { id: "logging-bucket:update", action: "update", argv: [] };
  for (const sequence of [[create], [create, other, pause], [create, { ...pause, deferred: "X" }], [bind, create, pause],
    [pause, create]]) {
    assert.throws(() => operations.assertTriggersCreatedPaused(sequence), { code: "SCHEDULER_CREATE_NOT_PAUSED" },
      sequence.map((entry) => entry.id).join(","));
  }
  assert.equal(operations.assertTriggersCreatedPaused([create, pause, bind]).length, 3);
  assert.equal(operations.assertTriggersCreatedPaused([{ ...create, deferred: "SCHEDULER_CADENCE_UNSET" }, bind]).length, 2);
});

test("the verifier's token-creator grant waits for the operator, and its own policy names no other impersonator", () => {
  // Unassigned: a deferral that keeps the estate unclean.
  const unassigned = desiredState({ synthetic: false, mutate: (value) => { value.serviceAccounts.verifier.tokenCreators = null; } });
  const world = convergedWorld(unassigned);
  const waiting = plan(unassigned, fake(unassigned, world).runner);
  assert.deepEqual(waiting.operations.map((entry) => [entry.id, entry.deferred]),
    [["verifier-iam:token-creator", "VERIFIER_TOKEN_CREATOR_UNASSIGNED"], ["scheduler:create:analytics-refresh",
      "SCHEDULER_CADENCE_UNSET"], [EXECUTOR(unassigned), "SCHEDULER_CADENCE_UNSET"]]);
  assert.deepEqual([...operations.infrastructureCleanliness(waiting).reasons],
    ["DEFERRED:verifier-iam:token-creator:VERIFIER_TOKEN_CREATOR_UNASSIGNED"]);
  // Assigned: one bind on the verifier account, read back from its own policy, then converged.
  const assigned = desiredState({ synthetic: false, mutate: (value) => {
    value.serviceAccounts.verifier.tokenCreators = ["user:operator@example.com"];
  } });
  const gcloud = fake(assigned, world);
  const grant = plan(assigned, gcloud.runner);
  assert.deepEqual(grant.operations.filter((entry) => entry.deferred === undefined).map((entry) => entry.argv), [[
    "iam", "service-accounts", "add-iam-policy-binding", assigned.serviceAccounts.verifier.email,
    `--project=${APPLY_PROJECT}`, "--member=user:operator@example.com", "--role=roles/iam.serviceAccountTokenCreator"]]);
  operations.applyInfrastructure(assigned, { runner: gcloud.runner, authorize: grant.planDigest,
    createSpecWriter: () => gcloud.writer.create() });
  assert.deepEqual(world.serviceAccountPolicies[assigned.serviceAccounts.verifier.email].bindings,
    [{ role: "roles/iam.serviceAccountTokenCreator", members: ["user:operator@example.com"] }]);
  assert.equal(operations.infrastructureCleanliness(plan(assigned, gcloud.runner)).clean, true);
  assert.ok(gcloud.calls.some((argv) => argv.slice(0, 3).join(" ") === "iam service-accounts get-iam-policy"
    && argv[3] === assigned.serviceAccounts.verifier.email));
  // The boundary of this check (receipt, Not covered): an impersonation role
  // held on the project policy by a principal the plane does not manage is
  // not read, so it neither appears in the readback nor keeps the estate
  // unclean.
  world.projectPolicy.bindings.push({ role: "roles/iam.serviceAccountTokenCreator", members: ["user:someone@example.com"] });
  const inherited = plan(assigned, gcloud.runner);
  assert.equal(operations.infrastructureCleanliness(inherited).clean, true);
  assert.equal(JSON.stringify(inherited).includes("someone@example.com"), false);
  world.projectPolicy.bindings.pop();
  // A hand-made impersonation grant on the verifier's own policy that the
  // desired state does not name, or a public member there, is a delete apply
  // refuses.
  for (const [role, member] of [["roles/iam.serviceAccountTokenCreator", "user:someone@example.com"],
    ["roles/iam.serviceAccountOpenIdTokenCreator", "user:someone@example.com"],
    ["roles/iam.serviceAccountUser", "group:others@example.com"], ["roles/iam.serviceAccountTokenCreator", "allUsers"]]) {
    const result = refusedApply((doctored, desired) => {
      doctored.serviceAccountPolicies[desired.serviceAccounts.verifier.email] = { bindings: [
        { role: "roles/iam.serviceAccountTokenCreator", members: ["group:synthetic-operators@example.com"] },
        { role, members: [member] }] };
    }, "APPLY_DELETE_REFUSED");
    assert.ok(result.operations.some((entry) => entry.id === `verifier-iam:delete:${role}|${member}|`), member);
    if (member === "allUsers") assert.ok(result.findings.includes("VERIFIER_POLICY_PUBLIC_MEMBER"));
  }
  // Without a verifier there is no grant to make.
  const none = desiredState({ synthetic: false, mutate: (value) => { value.serviceAccounts.verifier = null; } });
  assert.equal(plan(none, fake(none, bornWorld(none)).runner, { bootstrap: BOOTSTRAP }).operations
    .some((entry) => entry.id.startsWith("verifier-iam:")), false);
});

/** The GCP test project's own resources, as a shared plane's co-tenants. */
function withCoTenants(world, { project, region }) {
  world.serviceAccounts.push({ email: `tibotattle-test-runtime@${project}.iam.gserviceaccount.com`, disabled: false });
  world.sqlInstances.push({ name: "tibotattle-test-primary-20260922", instanceType: "CLOUD_SQL_INSTANCE", settings: {} });
  world.services.push({ metadata: { name: "tibotattle-test-app" }, spec: { template: { spec: { containers: [{}] } } } });
  world.services.push({ metadata: { name: "tibotattle-test-oauth-gateway" }, spec: { template: { spec: { containers: [{}] } } } });
  world.jobs.push({ metadata: { name: "tibotattle-test-database-migrate" }, spec: {} });
  world.schedulerJobs.push({ name: `projects/${project}/locations/${region}/jobs/tibotattle-test-nightly`, state: "ENABLED",
    schedule: "0 1 * * *", httpTarget: { uri: `https://run.googleapis.com/v2/projects/${project}/locations/${region}/jobs/x:run` } });
  world.secrets.push({ name: "projects/1/secrets/tibotattle-test-rate-limit-secret-20260922",
    replication: { userManaged: { replicas: [{ location: region }] } } });
  world.projectPolicy.auditConfigs = [{ service: "storage.googleapis.com", auditLogConfigs: [{ logType: "DATA_READ" }] }];
  world.logBucket.retentionDays = 400;
  return world;
}

/** A staging plane in a shared project: every plane name carries the staging marker. */
function sharedStaging(value) {
  value.environment = "staging";
  value.projectTenancy = "shared";
  value.artifactRegistry.repository = "synthetic-staging-images";
  value.serviceAccounts.builder.accountId = "synthetic-staging-builder";
  value.serviceAccounts.verifier.accountId = "synthetic-staging-verifier";
  value.cloudSql.instance = "synthetic-staging-primary";
  value.bucket.name = "synthetic-staging-quarantine";
  value.service.name = "synthetic-staging-origin";
  value.jobs["production-migrate"].name = "synthetic-staging-migrate";
  value.jobs["analytics-refresh"].name = "synthetic-staging-refresh";
  value.jobs.maintenance.name = "synthetic-staging-maintenance";
  value.scheduler["analytics-refresh"].name = "synthetic-staging-trigger";
  value.scheduler.maintenance.name = "synthetic-staging-maintenance-trigger";
  for (const [name, secret] of Object.entries(value.secrets)) {
    secret.secretName = `tibotattle-staging-${name.toLowerCase().replaceAll("_", "-")}`;
  }
}

test("a shared project's co-tenants and project-wide settings are never read into the plan or changed", () => {
  const shared = desiredState({ synthetic: false, mutate: sharedStaging });
  const world = withCoTenants(bornWorld(shared), shared);
  const before = structuredClone({ sqlInstances: world.sqlInstances, services: world.services, jobs: world.jobs,
    schedulerJobs: world.schedulerJobs, logBucket: world.logBucket, sink: world.sink, auditConfigs: world.projectPolicy.auditConfigs });
  const gcloud = fake(shared, world);
  const readback = operations.readbackInfrastructure(shared, { runner: gcloud.runner });
  assert.equal(readback.projectTenancy, "shared");
  assert.deepEqual([readback.observed.cloudSql.instanceNames, readback.observed.service.names, readback.observed.jobs.names,
    readback.observed.scheduler.names], [[], [], [], []]);
  assert.deepEqual([readback.observed.logging, readback.observed.dataAccessAudit], [null, null]);
  assert.deepEqual(readback.findings, []);
  assert.equal(gcloud.calls.some((argv) => argv[0] === "logging"), false, "project-wide logging is not even read");
  assert.doesNotMatch(JSON.stringify(readback), /tibotattle-test/u);
  const result = plan(shared, gcloud.runner, { bootstrap: BOOTSTRAP });
  assert.equal(result.summary.refused, 0);
  assert.equal(result.operations.some((entry) => /^(?:logging|audit-config)/u.test(entry.id)), false);
  assert.doesNotMatch(JSON.stringify(result.operations), /tibotattle-test/u);
  operations.applyInfrastructure(shared, { runner: gcloud.runner, authorize: result.planDigest, bootstrap: BOOTSTRAP,
    createSpecWriter: () => gcloud.writer.create() });
  // The plane converged as far as it can (its service waits for its
  // stagingOrigin settings, STG-PREP); its co-tenants and the project-wide
  // settings are exactly as they were.
  assert.deepEqual([...operations.infrastructureCleanliness(plan(shared, gcloud.runner)).reasons], [
    "DEFERRED:run-service:create:STAGING_ORIGIN_UNASSIGNED",
    `DEFERRED:run-service-iam:bind:roles/run.invoker|${shared.serviceAccounts.edgeInvoker.member}|:STAGING_ORIGIN_UNASSIGNED`,
    `DEFERRED:run-service-iam:bind:roles/run.invoker|${shared.serviceAccounts.verifier.member}|:STAGING_ORIGIN_UNASSIGNED`,
    // The maintenance job, its trigger and the scheduler's grant wait for the same staging values (never created, never clean).
    "DEFERRED:run-job:create:maintenance:STAGING_MAINTENANCE_JOB_ENVIRONMENT_UNAVAILABLE",
    "DEFERRED:scheduler:create:maintenance:STAGING_MAINTENANCE_JOB_ENVIRONMENT_UNAVAILABLE",
    `DEFERRED:run-job-iam:maintenance:bind:roles/run.jobsExecutor|${shared.serviceAccounts.scheduler.member}|:STAGING_MAINTENANCE_JOB_ENVIRONMENT_UNAVAILABLE`,
  ]);
  assert.deepEqual(world.jobs.filter((job) => /staging/u.test(job.metadata.name)).map((job) => job.metadata.name),
    ["synthetic-staging-migrate", "synthetic-staging-refresh"], "no staging maintenance job exists");
  assert.equal(world.schedulerJobs.some((job) => job.name.endsWith("synthetic-staging-maintenance-trigger")), false);
  for (const [key, value] of Object.entries(before)) {
    const now = key === "auditConfigs" ? world.projectPolicy.auditConfigs
      : key === "sqlInstances" || key === "services" || key === "jobs" || key === "schedulerJobs"
        ? world[key].filter((entry) => /tibotattle-test/u.test(entry.name ?? entry.metadata?.name)) : world[key];
    assert.deepEqual(now, key === "sqlInstances" || key === "services" || key === "jobs" || key === "schedulerJobs"
      ? value.filter((entry) => /tibotattle-test/u.test(entry.name ?? entry.metadata?.name)) : value, key);
  }
  assert.equal(gcloud.calls.some((argv) => operations.classifyGcloudCommand(argv) === "mutate"
    && argv.some((arg) => /tibotattle-test/u.test(arg))), false);
  // The same co-tenants in a dedicated project are drift: deletes and
  // destructive changes that apply refuses.
  const dedicated = desiredState({ synthetic: false });
  const drift = plan(dedicated, fake(dedicated, withCoTenants(convergedWorld(dedicated), dedicated)).runner);
  assert.ok(drift.findings.includes("CLOUD_SQL_SECOND_INSTANCE"));
  assert.ok(drift.findings.includes("DATA_ACCESS_AUDIT_ENABLED"));
  for (const id of ["cloud-sql:delete:tibotattle-test-primary-20260922", "run-service:delete:tibotattle-test-app",
    "run-job:delete:tibotattle-test-database-migrate", "scheduler:delete:tibotattle-test-nightly",
    "logging-bucket:destructive", "audit-config:destructive"]) {
    assert.ok(drift.operations.some((entry) => entry.id === id), id);
  }
});

test("the committed staging desired state plans only its own new resources in the shared test project", () => {
  // The committed file as it reads before its pins (STG-PREP): the first plan.
  manifest.loadCommittedDesiredState("staging");
  const desired = manifest.assertCommittedDesiredState(manifest.validateDesiredState(JSON.parse(unpinnedStagingText())));
  const world = withCoTenants(emptyWorld(), desired);
  const gcloud = fake(desired, world);
  const result = plan(desired, gcloud.runner, { bootstrap: BOOTSTRAP });
  assert.equal(result.environment, "staging");
  assert.equal(result.summary.refused, 0);
  assert.deepEqual(result.findings, ["BUCKET_ABSENT", "BUCKET_PROOF_UNPINNED"]);
  assert.deepEqual(result.blockers, ["BUCKET_ABSENT", "BUCKET_PROOF_UNPINNED"]);
  assert.doesNotMatch(JSON.stringify(result.operations), /tibotattle-test|_Default/u);
  // Everything it would create is the staging plane's; the service waits for
  // its Access AUD, the verifier grant for the operator, the trigger for the cadence.
  for (const entry of result.operations.filter((operation) => operation.deferred === undefined)) {
    const named = entry.file === undefined ? entry.argv : [...entry.argv, entry.file.content];
    assert.ok(named.some((arg) => /staging/u.test(arg)) || entry.id === "custom-role:create", entry.id);
  }
  const deferrals = new Set(ops(result, (entry) => entry.deferred !== undefined).map((entry) => entry.deferred));
  // The verifier operator was named on 2026-10-02, so its grant is no longer deferred.
  assert.deepEqual([...deferrals].sort(), ["SCHEDULER_CADENCE_UNSET", "STAGING_MAINTENANCE_JOB_ENVIRONMENT_UNAVAILABLE",
    "STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud"]);
  // The staging maintenance job, its trigger and the scheduler's grant are deferred, never created.
  assert.deepEqual(ops(result, (entry) => /maintenance/u.test(entry.id)).map((entry) => [entry.id, entry.deferred]), [
    ["run-job:create:maintenance", "STAGING_MAINTENANCE_JOB_ENVIRONMENT_UNAVAILABLE"],
    ["scheduler:create:maintenance", "STAGING_MAINTENANCE_JOB_ENVIRONMENT_UNAVAILABLE"],
    [`run-job-iam:maintenance:bind:roles/run.jobsExecutor|${desired.serviceAccounts.scheduler.member}|`,
      "STAGING_MAINTENANCE_JOB_ENVIRONMENT_UNAVAILABLE"],
  ]);
  assert.ok(ops(result, (entry) => entry.id === "secret:create:IDENTITY_LINK_SECRET")[0].argv
    .includes("tibotattle-staging-identity-link-secret"));
  // Apply refuses it until the bucket is born and its proof is committed.
  assert.throws(() => operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: result.planDigest,
    bootstrap: BOOTSTRAP }), { code: "APPLY_BUCKET_PROOF_UNPINNED" });
});

// ---------------------------------------------------------------------------
// D-OPS4: the maintenance job and its every-minute trigger

test("the maintenance job is created from the contract, its trigger is created paused at the pinned cadence, and apply converges without a resume", () => {
  const desired = desiredState({ synthetic: false });
  const world = bornWorld(desired);
  const gcloud = fake(desired, world);
  const result = plan(desired, gcloud.runner, { bootstrap: BOOTSTRAP });
  const ids = result.operations.map((entry) => entry.id);
  const at = (id) => ids.indexOf(id);
  const executor = MAINTENANCE_EXECUTOR(desired);
  // The job exists before its trigger, the trigger is paused at once, and only then may the scheduler run the job.
  assert.ok(at("run-job:create:maintenance") >= 0);
  assert.ok(at("run-job:create:maintenance") < at("scheduler:create:maintenance"));
  assert.equal(at("scheduler:pause:maintenance"), at("scheduler:create:maintenance") + 1);
  assert.ok(at(executor) > at("scheduler:pause:maintenance"));
  assert.ok(ops(result, (entry) => /maintenance/u.test(entry.id)).every((entry) => entry.deferred === undefined));
  const created = ops(result, (entry) => entry.id === "scheduler:create:maintenance")[0].argv;
  assert.ok(created.includes("--schedule=* * * * *"));
  assert.ok(created.includes("--max-retry-attempts=0"));
  assert.ok(created.includes("--time-zone=Etc/UTC"));
  assert.ok(created.includes(`--uri=https://run.googleapis.com/v2/projects/${desired.project}/locations/us-east1/jobs/synthetic-maintenance:run`));
  operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: result.planDigest, bootstrap: BOOTSTRAP,
    createSpecWriter: () => gcloud.writer.create() });
  const live = world.jobs.find((job) => job.metadata.name === "synthetic-maintenance");
  assert.deepEqual(live.spec.template.spec.template.spec.containers[0].args,
    ["dist/postgres-maintenance-job.mjs", "--profile=maintenance-job"]);
  assert.equal(live.spec.template.spec.template.spec.serviceAccountName, desired.serviceAccounts.runtime.email);
  assert.equal(maintenanceTrigger(world).state, "PAUSED");
  assert.equal(maintenanceTrigger(world).schedule, "* * * * *");
  assert.equal(gcloud.calls.some((argv) => argv.includes("resume")), false);
  assert.equal(JSON.stringify(world.jobPolicies["synthetic-maintenance"]).includes(desired.serviceAccounts.scheduler.member), true);
  // Converged: nothing left, clean for OPS-10 (the paused trigger is committed PAUSED).
  const after = plan(desired, gcloud.runner);
  assert.deepEqual([after.findings, after.operations.filter((entry) => entry.deferred === undefined)], [[], []]);
  assert.equal(operations.infrastructureCleanliness(after).clean, true);
  // The committed ENABLED state waits for OPS-3's resume and stays clean, like the refresh trigger's.
  const resumed = desiredState({ synthetic: false, mutate: (value) => { value.scheduler.maintenance.state = "ENABLED"; } });
  const waiting = plan(resumed, fake(resumed, world).runner);
  assert.deepEqual(waiting.operations.map((entry) => [entry.id, entry.deferred]),
    [["scheduler:create:analytics-refresh", "SCHEDULER_CADENCE_UNSET"], ["scheduler:resume:maintenance", "SCHEDULER_TRIGGER_RESUME_PENDING"]]);
  assert.equal(operations.infrastructureCleanliness(waiting).clean, true);
  maintenanceTrigger(world).state = "ENABLED";
  assert.deepEqual(plan(resumed, fake(resumed, world).runner).operations.map((entry) => entry.id), ["scheduler:create:analytics-refresh"]);
});

test("a maintenance trigger whose pause failed is paused by the next plan, and could not have started the job meanwhile", () => {
  const desired = desiredState({ synthetic: false });
  const world = bornWorld(desired);
  const failing = fake(desired, world, { failWhen: (argv) => argv.slice(0, 3).join(" ") === "scheduler jobs pause"
    && argv.includes(MAINTENANCE_TRIGGER) });
  const first = plan(desired, failing.runner, { bootstrap: BOOTSTRAP });
  assert.throws(() => operations.applyInfrastructure(desired, { runner: failing.runner, authorize: first.planDigest,
    bootstrap: BOOTSTRAP, createSpecWriter: () => failing.writer.create() }),
  (error) => error.code === "APPLY_OPERATION_FAILED" && error.operation === "scheduler:pause:maintenance");
  // Created ENABLED by Cloud Scheduler; the grant that would let it run the job was never made.
  assert.equal(maintenanceTrigger(world).state, "ENABLED");
  assert.equal(JSON.stringify(world.jobPolicies["synthetic-maintenance"] ?? {}).includes("roles/run.jobsExecutor"), false);
  const gcloud = fake(desired, world);
  const readback = operations.readbackInfrastructure(desired, { runner: gcloud.runner });
  assert.deepEqual(readback.findings, ["SCHEDULER_TRIGGER_ENABLED:maintenance"]);
  const replan = operations.planInfrastructure(desired, readback);
  assert.deepEqual(replan.operations.filter((entry) => entry.deferred === undefined).map((entry) => entry.id),
    ["scheduler:pause:maintenance", MAINTENANCE_EXECUTOR(desired)]);
  assert.equal(operations.infrastructureCleanliness(replan).clean, false);
  operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: replan.planDigest,
    createSpecWriter: () => gcloud.writer.create() });
  assert.equal(maintenanceTrigger(world).state, "PAUSED");
  const settled = plan(desired, gcloud.runner);
  assert.deepEqual([settled.findings, settled.operations.filter((entry) => entry.deferred === undefined)], [[], []]);
});

test("the maintenance job and its trigger wait for what only the desired state and the estate can supply", () => {
  const fixtureProject = (mutate) => desiredState({ synthetic: false, mutate });
  const waitingFor = (result) => ops(result, (entry) => /maintenance/u.test(entry.id)).map((entry) => [entry.id, entry.deferred]);
  const trigger3 = (desired, reason) => [
    ["run-job:create:maintenance", reason],
    ["scheduler:create:maintenance", reason],
    [MAINTENANCE_EXECUTOR(desired), reason],
  ];
  for (const [mutate, reason] of [
    [(value) => { value.secrets.IDENTITY_LINK_SECRET.version = null; }, "SECRET_VERSION_UNPINNED:IDENTITY_LINK_SECRET"],
    [(value) => { value.service.telemetryStorageNamespace = null; }, "TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED"],
  ]) {
    const desired = fixtureProject(mutate);
    const result = plan(desired, fake(desired, bornWorld(desired)).runner, { bootstrap: BOOTSTRAP });
    // The job, its trigger and its grant wait for the same input: no trigger is made for a job that does not exist.
    assert.deepEqual(waitingFor(result), trigger3(desired, reason), reason);
    // Every other job still renders and is created.
    assert.deepEqual(ops(result, (entry) => entry.id.startsWith("run-job:")).map((entry) => [entry.id, entry.deferred]),
      [["run-job:create:production-migrate", undefined], ["run-job:create:analytics-refresh", undefined],
        ["run-job:create:maintenance", reason]]);
    assert.ok(operations.infrastructureCleanliness(result).reasons.includes(`DEFERRED:run-job:create:maintenance:${reason}`));
    assert.equal(ops(result, (entry) => entry.id === "scheduler:pause:maintenance").length, 0);
  }
  // A pinned version the estate does not hold (disabled, or never added) defers it too.
  const desired = fixtureProject(() => {});
  const disabled = bornWorld(desired);
  disabled.secretVersions.IDENTITY_LINK_SECRET[0].state = "DISABLED";
  const result = plan(desired, fake(desired, disabled).runner, { bootstrap: BOOTSTRAP });
  assert.deepEqual(waitingFor(result), trigger3(desired, "SECRET_VERSION_UNAVAILABLE:IDENTITY_LINK_SECRET"));
  // An unborn bucket proof: the plan blocks and the job waits, like the service.
  const unpinned = fixtureProject((value) => { value.bucket.proof = null; });
  const blocked = plan(unpinned, fake(unpinned, bornWorld(unpinned)).runner, { bootstrap: BOOTSTRAP });
  assert.deepEqual(blocked.blockers, ["BUCKET_PROOF_UNPINNED"]);
  assert.deepEqual(waitingFor(blocked), trigger3(unpinned, "BUCKET_PROOF_UNPINNED"));
  // A live job whose secret later becomes unavailable is kept as it is: the update is deferred, never a delete or a recreate.
  const live = convergedWorld(desired);
  live.secretVersions.IDENTITY_LINK_SECRET[0].state = "DISABLED";
  const later = plan(desired, fake(desired, live).runner);
  assert.deepEqual(later.operations.filter((entry) => /maintenance/u.test(entry.id)).map((entry) => [entry.id, entry.deferred]),
    [["run-job:update:maintenance", "SECRET_VERSION_UNAVAILABLE:IDENTITY_LINK_SECRET"]]);
  assert.equal(later.operations.some((entry) => entry.action === "delete" || entry.action === "destructive"), false);
  assert.equal(operations.infrastructureCleanliness(later).clean, false);
  // The other two jobs never read these inputs, so they are never deferred by them.
  for (const job of ["production-migrate", "analytics-refresh"]) {
    assert.equal(ops(result, (entry) => entry.id === `run-job:create:${job}`)[0].deferred, undefined, job);
  }
});

test("a drifted maintenance job or trigger is set back, apply keeps the live image and commit, and a running trigger is paused", () => {
  const desired = desiredState({ synthetic: false });
  const world = convergedWorld(desired, UNDEFERRED);
  const liveJob = () => world.jobs.find((job) => job.metadata.name === "synthetic-maintenance");
  assert.ok(liveJob().spec.template.spec.template.spec.containers[0].image.endsWith(LIVE_IMAGE.imageDigest));
  liveJob().spec.template.spec.template.spec.timeoutSeconds = "900";
  maintenanceTrigger(world).schedule = "*/5 * * * *";
  const gcloud = fake(desired, world);
  const result = plan(desired, gcloud.runner, UNDEFERRED);
  // (The refresh trigger still waits for the owner's cadence, a deferral that is not drift.)
  const executable = result.operations.filter((entry) => entry.deferred === undefined);
  assert.deepEqual(executable.map((entry) => entry.id), ["run-job:update:maintenance", "scheduler:update:maintenance"]);
  const update = JSON.parse(executable[0].file.content);
  const container = update.spec.template.spec.template.spec.containers[0];
  assert.equal(update.spec.template.spec.template.spec.timeoutSeconds, "300");
  assert.equal(container.image, `${desired.artifactRegistry.imageRepository}@sha256:${LIVE_IMAGE.imageDigest}`);
  assert.equal(container.env.find((entry) => entry.name === "DEPLOYMENT_SOURCE_COMMIT").value, LIVE_IMAGE.sourceCommit);
  assert.ok(executable[1].argv.includes("--schedule=* * * * *"));
  operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: result.planDigest,
    createSpecWriter: () => gcloud.writer.create(), ...UNDEFERRED });
  assert.equal(maintenanceTrigger(world).schedule, "* * * * *");
  assert.equal(plan(desired, gcloud.runner, UNDEFERRED).summary.executable, 0);
  // A drifted env value (the proof of another bucket) is set back too; a different secret version likewise.
  const env = liveJob().spec.template.spec.template.spec.containers[0].env;
  env.find((entry) => entry.name === "GCS_BUCKET_NAME").value = "synthetic-other-bucket";
  env.find((entry) => entry.name === "IDENTITY_LINK_SECRET").valueFrom.secretKeyRef.key = "7";
  assert.deepEqual(plan(desired, fake(desired, world).runner, UNDEFERRED).operations
    .filter((entry) => entry.deferred === undefined).map((entry) => entry.id), ["run-job:update:maintenance"]);
  // A trigger left running while PAUSED is committed is a finding, and the next plan pauses it.
  const dedicated = convergedWorld(desired, UNDEFERRED);
  maintenanceTrigger(dedicated).state = "ENABLED";
  const readback = operations.readbackInfrastructure(desired, { runner: fake(desired, dedicated).runner });
  assert.deepEqual(readback.findings, ["SCHEDULER_TRIGGER_ENABLED:maintenance"]);
  assert.deepEqual(operations.planInfrastructure(desired, readback, UNDEFERRED).operations
    .filter((entry) => entry.deferred === undefined).map((entry) => entry.id), ["scheduler:pause:maintenance"]);
  // A live state the model does not know blocks, naming the job.
  maintenanceTrigger(dedicated).state = "DISABLED";
  const blocked = operations.planInfrastructure(desired, operations.readbackInfrastructure(desired, { runner: fake(desired, dedicated).runner }), UNDEFERRED);
  assert.deepEqual(blocked.blockers, ["SCHEDULER_TRIGGER_STATE_UNRECOGNIZED:maintenance"]);
});

test("the maintenance trigger is never created ahead of its job, resumed by apply or left without its pause", () => {
  // A trigger with the cadence the contract pins is created paused; the executor grant follows the pause.
  const desired = desiredState({ synthetic: false });
  const first = plan(desired, fake(desired, bornWorld(desired)).runner, { bootstrap: BOOTSTRAP });
  const sequence = first.operations.filter((entry) => /maintenance/u.test(entry.id)).map((entry) => entry.id);
  assert.deepEqual(sequence, ["run-job:create:maintenance", "scheduler:create:maintenance", "scheduler:pause:maintenance",
    MAINTENANCE_EXECUTOR(desired)]);
  // The invariant refuses the maintenance trigger's create without its pause, as for the refresh trigger.
  const create = { id: "scheduler:create:maintenance", action: "create", argv: [] };
  const pause = { id: "scheduler:pause:maintenance", action: "update", argv: [] };
  const bind = { id: MAINTENANCE_EXECUTOR(desired), action: "bind", argv: [] };
  for (const bad of [[create], [create, { id: "logging-bucket:update", action: "update", argv: [] }, pause],
    [bind, create, pause], [create, { ...pause, deferred: "X" }]]) {
    assert.throws(() => operations.assertTriggersCreatedPaused(bad), { code: "SCHEDULER_CREATE_NOT_PAUSED" });
  }
  assert.equal(operations.assertTriggersCreatedPaused([create, pause, bind]).length, 3);
  // No mutating command shape resumes anything (OPS-3 owns that), whichever trigger.
  assert.equal(operations.MUTATING_COMMANDS.some((shape) => /resume/u.test(shape)), false);
});

test("secrets are read, created and granted by their Secret Manager ids", () => {
  const desired = desiredState({ synthetic: false, mutate: (value) => {
    for (const [name, secret] of Object.entries(value.secrets)) secret.secretName = `tibotattle-${name.toLowerCase().replaceAll("_", "-")}`;
  } });
  const world = bornWorld(desired, { secrets: false });
  withSecretValues(world, { project: desired.project, region: desired.region,
    names: Object.values(desired.secrets).filter((secret) => secret.version !== null).map((secret) => secret.secretName) });
  const gcloud = fake(desired, world);
  const result = plan(desired, gcloud.runner, { bootstrap: BOOTSTRAP });
  assert.deepEqual(ops(result, (entry) => entry.id.startsWith("secret:create:")).map((entry) => entry.argv[2]),
    ["tibotattle-distribution-github-api-token"]);
  assert.ok(ops(result, (entry) => entry.id.startsWith("secret-iam:IDENTITY_LINK_SECRET:"))[0].argv
    .includes("tibotattle-identity-link-secret"));
  const service = JSON.parse(ops(result, (entry) => entry.id === "run-service:create")[0].file.content);
  assert.deepEqual(service.spec.template.spec.containers[0].env.find((entry) => entry.name === "IDENTITY_LINK_SECRET")
    .valueFrom.secretKeyRef, { name: "tibotattle-identity-link-secret", key: "1" });
  operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: result.planDigest, bootstrap: BOOTSTRAP,
    createSpecWriter: () => gcloud.writer.create() });
  assert.equal(operations.infrastructureCleanliness(plan(desired, gcloud.runner)).clean, true);
});

test("the scheduler probe raises the paused-too-long signal only for a resumed trigger left paused", () => {
  assert.equal(manifest.SCHEDULER_PAUSE_ALERT_THRESHOLD_HOURS, 6);
  const nowMs = Date.parse("2026-10-02T12:00:00Z");
  const verdict = (desiredState, live, thresholdHours) => operations.schedulerPauseVerdict({ desiredState, live, nowMs,
    ...(thresholdHours === undefined ? {} : { thresholdHours }) });
  const paused = (userUpdateTime, lastAttemptTime) => ({ state: "PAUSED", ...(userUpdateTime ? { userUpdateTime } : {}),
    ...(lastAttemptTime ? { lastAttemptTime } : {}) });
  const cases = [
    ["ENABLED", { state: "ENABLED" }, "running", false, null],
    ["PAUSED", paused("2026-09-01T00:00:00Z"), "paused_as_desired", false, null],
    ["ENABLED", paused("2026-10-02T06:00:01Z"), "paused_within_threshold", false, 359],
    ["ENABLED", paused("2026-10-02T06:00:00Z"), "paused_too_long", true, 360],
    // The newer of the last user change and the last attempt bounds the quiet time.
    ["ENABLED", paused("2026-10-01T00:00:00Z", "2026-10-02T11:00:00.123456Z"), "paused_within_threshold", false, 59],
    ["ENABLED", paused("2026-10-01T00:00:00+02:00"), "paused_too_long", true, 2280],
    // Missing, malformed or future evidence is never read as "recent".
    ["ENABLED", paused(), "paused_evidence_unavailable", true, null],
    ["ENABLED", paused("yesterday"), "paused_evidence_unavailable", true, null],
    ["ENABLED", paused("2026-10-03T00:00:00Z"), "paused_evidence_unavailable", true, null],
    ["ENABLED", null, "absent", true, null],
    ["PAUSED", null, "absent_not_created", false, null],
    ["ENABLED", { state: "DISABLED" }, "state_unrecognized", true, null],
    ["PAUSED", { state: "MARKER-STATE" }, "state_unrecognized", true, null],
  ];
  for (const [desiredState, live, expected, alert, quietMinutes] of cases) {
    const result = verdict(desiredState, live);
    assert.deepEqual([result.verdict, result.alert, result.quietMinutes], [expected, alert, quietMinutes],
      `${desiredState} ${JSON.stringify(live)}`);
    assert.doesNotMatch(JSON.stringify(result), /MARKER/u);
  }
  assert.equal(verdict("ENABLED", paused("2026-10-02T10:00:00Z"), 1).verdict, "paused_too_long");
  for (const [desiredState, thresholdHours] of [["paused", 6], ["ENABLED", 0], ["ENABLED", 169], ["ENABLED", 1.5]]) {
    assert.throws(() => verdict(desiredState, null, thresholdHours), { code: "SCHEDULER_PROBE_INPUT_INVALID" });
  }
  assert.ok(cases.every(([, , expected]) => operations.SCHEDULER_PROBE_VERDICTS.includes(expected)));

  // The probe makes one read call and reports per managed trigger.
  const resumed = desiredState({ synthetic: false, mutate: (value) => {
    CADENCE(value);
    value.scheduler["analytics-refresh"].state = "ENABLED";
  } });
  const world = convergedWorld(resumed);
  trigger(world).userUpdateTime = "2026-10-02T01:00:00Z";
  const gcloud = fake(resumed, world);
  const probe = operations.probeScheduler(resumed, { runner: gcloud.runner, now: () => nowMs });
  assert.deepEqual(gcloud.calls, [["scheduler", "jobs", "list", `--project=${APPLY_PROJECT}`, "--location=us-east1",
    "--format=json"]]);
  assert.deepEqual(probe, {
    schema: "tibotattle-gcp-ops-infra-scheduler-probe-v1", environment: "production", project: APPLY_PROJECT,
    checkedAt: "2026-10-02T12:00:00.000Z", thresholdHours: 6,
    triggers: [{ job: "analytics-refresh", name: TRIGGER, desiredState: "ENABLED", liveState: "PAUSED", quietMinutes: 660,
      verdict: "paused_too_long", alert: true },
    { job: "maintenance", name: MAINTENANCE_TRIGGER, desiredState: "PAUSED", liveState: "PAUSED", quietMinutes: null,
      verdict: "paused_as_desired", alert: false }],
    alert: true, signal: "SCHEDULER_TRIGGER_PAUSED_TOO_LONG",
  });
  // The maintenance trigger is probed like any other: committed ENABLED, left paused past the threshold, it alerts.
  const maintenanceResumed = desiredState({ synthetic: false, mutate: (value) => { value.scheduler.maintenance.state = "ENABLED"; } });
  const maintenanceWorld = convergedWorld(maintenanceResumed);
  maintenanceTrigger(maintenanceWorld).userUpdateTime = "2026-10-02T01:00:00Z";
  const quiet = operations.probeScheduler(maintenanceResumed, { runner: fake(maintenanceResumed, maintenanceWorld).runner, now: () => nowMs });
  assert.deepEqual(quiet.triggers.map((entry) => [entry.job, entry.verdict, entry.alert]),
    [["analytics-refresh", "absent_not_created", false], ["maintenance", "paused_too_long", true]]);
  assert.equal(quiet.signal, "SCHEDULER_TRIGGER_PAUSED_TOO_LONG");
  maintenanceTrigger(maintenanceWorld).state = "ENABLED";
  assert.equal(operations.probeScheduler(maintenanceResumed, { runner: fake(maintenanceResumed, maintenanceWorld).runner,
    now: () => nowMs }).alert, false);
  trigger(world).state = "ENABLED";
  const running = operations.probeScheduler(resumed, { runner: fake(resumed, world).runner, now: () => nowMs });
  assert.deepEqual([running.alert, running.signal, running.triggers[0].verdict], [false, null, "running"]);
  // Before OPS-3 resumes it, a paused trigger is paused by design.
  const prelaunch = desiredState({ synthetic: false, mutate: CADENCE });
  trigger(world).state = "PAUSED";
  assert.equal(operations.probeScheduler(prelaunch, { runner: fake(prelaunch, world).runner, now: () => nowMs }).alert, false);
});

// ---------------------------------------------------------------------------
// OPS-3 pause-all and resume-all (D-OPS3)

const RESUMED = (value) => { CADENCE(value); value.scheduler["analytics-refresh"].state = "ENABLED"; };

/** A converged dedicated project whose managed trigger OPS-3 resumed, plus hand-made triggers. */
function resumedWorld(desired) {
  const world = convergedWorld(desired);
  trigger(world).state = "ENABLED";
  const runUri = (job) => `https://run.googleapis.com/v2/projects/${desired.project}/locations/${desired.region}/jobs/${job}:run`;
  world.schedulerJobs.push(
    { name: `projects/${desired.project}/locations/${desired.region}/jobs/synthetic-hand-made-trigger`, state: "ENABLED",
      schedule: "0 * * * *", httpTarget: { uri: runUri("synthetic-production-migrate") } },
    { name: `projects/${desired.project}/locations/${desired.region}/jobs/synthetic-webhook-trigger`, state: "ENABLED",
      schedule: "0 * * * *", httpTarget: { uri: "https://hooks.example.invalid/synthetic" } },
    { name: `projects/${desired.project}/locations/${desired.region}/jobs/synthetic-deliberately-paused`, state: "PAUSED",
      schedule: "0 * * * *", httpTarget: { uri: runUri("synthetic-analytics-refresh") } },
  );
  return world;
}

async function receiptDirectory(t) {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(join(tmpdir(), "ops3-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** OPS-10's ROLLOUT_JOBS_NOT_PAUSED rule over a world, with the rollout's own classifier. */
async function rolloutGateHolds(world) {
  const { scheduledRunJob } = await import("./gcp-scheduler-run-target.mjs");
  return world.schedulerJobs.filter((entry) => scheduledRunJob(entry) !== null).every(({ state }) => state === "PAUSED");
}

test("pause-all is a read-only dry run whose plan pauses every plane trigger and opens OPS-10's gate", async () => {
  const desired = desiredState({ synthetic: false, mutate: RESUMED });
  const world = resumedWorld(desired);
  const gcloud = fake(desired, world);
  const first = operations.planPauseAll(desired, { runner: gcloud.runner });
  assert.deepEqual(gcloud.calls, [["scheduler", "jobs", "list", `--project=${APPLY_PROJECT}`, "--location=us-east1",
    "--format=json"]]);
  assert.equal(first.schema, operations.GCP_OPS_PAUSE_ALL_PLAN_SCHEMA);
  assert.deepEqual(first.triggers.map(({ name, action, runJob }) => [name, action, runJob]), [
    [TRIGGER, "pause", "synthetic-analytics-refresh"],
    ["synthetic-deliberately-paused", "none", "synthetic-analytics-refresh"],
    ["synthetic-hand-made-trigger", "pause", "synthetic-production-migrate"],
    ["synthetic-webhook-trigger", "pause", null],
  ]);
  assert.deepEqual([first.blockers, first.foreignBlocking, first.rolloutGateAfter.satisfied], [[], [], true]);
  assert.equal(await rolloutGateHolds(world), false, "the gate is shut before pause-all");
  // Deterministic: the same estate in another order gives the same digest.
  world.schedulerJobs.reverse();
  assert.equal(operations.planPauseAll(desired, { runner: fake(desired, world).runner }).planDigest, first.planDigest);
});

test("pause-all applies only under its digest, pauses only, writes the receipt, and the rollout gate then holds",
  async (t) => {
    const directory = await receiptDirectory(t);
    const desired = desiredState({ synthetic: false, mutate: RESUMED });
    const world = resumedWorld(desired);
    const gcloud = fake(desired, world);
    const plan = operations.planPauseAll(desired, { runner: gcloud.runner });
    const receiptPath = join(directory, "pause-all.json");
    // Refusals before any mutation.
    for (const [options, code] of [
      [{ authorize: undefined }, "PAUSE_ALL_AUTHORIZATION_REQUIRED"],
      [{ authorize: "not-a-digest" }, "PAUSE_ALL_AUTHORIZATION_INVALID"],
      [{ authorize: "0".repeat(64) }, "PAUSE_ALL_PLAN_DIGEST_MISMATCH"],
      [{ authorize: plan.planDigest, receiptPath: "relative.json" }, "PAUSE_ALL_RECEIPT_PATH_REQUIRED"],
    ]) {
      await assert.rejects(operations.applyPauseAll(desired, { runner: gcloud.runner, receiptPath, ...options }), { code });
    }
    await assert.rejects(operations.applyPauseAll(desiredState({ mutate: RESUMED }), { runner: gcloud.runner,
      authorize: plan.planDigest, receiptPath }), { code: "PAUSE_ALL_SYNTHETIC_TARGET_REFUSED" });
    assert.equal(kinds(gcloud.calls).every((kind) => kind === "read"), true, "nothing mutated by a refusal");
    const callsBefore = gcloud.calls.length;
    const receipt = await operations.applyPauseAll(desired, { runner: gcloud.runner, authorize: plan.planDigest,
      receiptPath, now: () => Date.parse("2026-10-02T12:00:00Z") });
    const mutations = gcloud.calls.slice(callsBefore).filter((argv) => operations.classifyGcloudCommand(argv) !== "read");
    assert.deepEqual(mutations.map((argv) => argv.slice(0, 4).join(" ")), [`scheduler jobs pause ${TRIGGER}`,
      "scheduler jobs pause synthetic-hand-made-trigger", "scheduler jobs pause synthetic-webhook-trigger"]);
    assert.equal(world.schedulerJobs.every(({ state }) => state === "PAUSED"), true);
    assert.equal(await rolloutGateHolds(world), true, "ROLLOUT_JOBS_NOT_PAUSED is now satisfiable");
    assert.deepEqual([receipt.status, receipt.paused, receipt.alreadyPaused, receipt.failed, receipt.rolloutGate.satisfied],
      ["complete", [TRIGGER, "synthetic-hand-made-trigger", "synthetic-webhook-trigger"],
        ["synthetic-deliberately-paused"], null, true]);
    assert.equal(receipt.pausedAt, "2026-10-02T12:00:00.000Z");
    const written = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.deepEqual(written, JSON.parse(JSON.stringify(receipt)));
    assert.deepEqual(operations.verifyPauseAllReceipt(written, desired, { nowMs: Date.parse("2026-10-02T12:30:00Z") }),
      written);
    // Each plane trigger's read-back evidence is recorded for resume-all.
    assert.deepEqual(written.triggers.find(({ name }) => name === TRIGGER),
      { name: TRIGGER, state: "PAUSED", userUpdateTime: "2026-10-02T00:00:00Z", lastAttemptTime: null });
    const { statSync } = await import("node:fs");
    assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
    // OPS-10's clean verdict is unchanged for the managed trigger: paused while
    // committed ENABLED is OPS-3's deferred resume. (The hand-made triggers are
    // drift in a dedicated project either way.)
    assert.deepEqual([...operations.infrastructureCleanliness(plan2(desired, world)).reasons], [
      "REFUSED:scheduler:delete:synthetic-deliberately-paused", "REFUSED:scheduler:delete:synthetic-hand-made-trigger",
      "REFUSED:scheduler:delete:synthetic-webhook-trigger"]);
    // A receipt is never overwritten.
    const again = operations.planPauseAll(desired, { runner: fake(desired, world).runner });
    await assert.rejects(operations.applyPauseAll(desired, { runner: fake(desired, world).runner,
      authorize: again.planDigest, receiptPath }), { code: "OPS_RECEIPT_PATH_UNAVAILABLE" });
  });

function plan2(desired, world) {
  return plan(desired, fake(desired, world).runner);
}

test("a failed pause leaves an incomplete receipt naming what was paused, and resume-all resumes only that", async (t) => {
  const directory = await receiptDirectory(t);
  const desired = desiredState({ synthetic: false, mutate: RESUMED });
  const world = resumedWorld(desired);
  const failing = fake(desired, world, { failWhen: (argv) => argv.slice(0, 4).join(" ")
    === "scheduler jobs pause synthetic-hand-made-trigger" });
  const plan = operations.planPauseAll(desired, { runner: failing.runner });
  const receiptPath = join(directory, "pause-all.json");
  const error = await operations.applyPauseAll(desired, { runner: failing.runner, authorize: plan.planDigest, receiptPath })
    .then(() => null, (caught) => caught);
  assert.equal(error?.code, "PAUSE_ALL_INCOMPLETE");
  const written = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.deepEqual([written.status, written.paused, written.failed, written.rolloutGate.satisfied],
    ["incomplete", [TRIGGER], "synthetic-hand-made-trigger", false]);
  assert.doesNotMatch(JSON.stringify(written), /MARKER/u);
  // The managed trigger paused by this run is resumed; nothing else is.
  const resume = operations.planResumeAll(desired, { runner: fake(desired, world).runner, pauseReceipt: written });
  assert.deepEqual(resume.resume, [TRIGGER]);
});

test("resume-all resumes only committed-ENABLED managed triggers that pause-all or the operator paused", async (t) => {
  const directory = await receiptDirectory(t);
  const desired = desiredState({ synthetic: false, mutate: RESUMED });
  const world = resumedWorld(desired);
  const pausePlan = operations.planPauseAll(desired, { runner: fake(desired, world).runner });
  const pausedAt = () => Date.parse("2026-10-02T12:00:00Z");
  const now = () => Date.parse("2026-10-02T13:00:00Z");
  const receipt = await operations.applyPauseAll(desired, { runner: fake(desired, world).runner,
    authorize: pausePlan.planDigest, receiptPath: join(directory, "pause.json"), now: pausedAt });
  const gcloud = fake(desired, world);
  const plan = operations.planResumeAll(desired, { runner: gcloud.runner, pauseReceipt: receipt, now });
  assert.equal(kinds(gcloud.calls).every((kind) => kind === "read"), true, "the resume plan is a dry run");
  assert.deepEqual(plan.resume, [TRIGGER], "hand-made triggers are never resumed");
  assert.deepEqual(plan.triggers, [{ job: "analytics-refresh", name: TRIGGER, committedState: "ENABLED",
    liveState: "PAUSED", action: "resume" }]);
  for (const [options, code] of [
    [{ authorize: undefined }, "RESUME_ALL_AUTHORIZATION_REQUIRED"],
    [{ authorize: "0".repeat(64) }, "RESUME_ALL_PLAN_DIGEST_MISMATCH"],
  ]) {
    assert.throws(() => operations.applyResumeAll(desired, { runner: gcloud.runner, pauseReceipt: receipt, now, ...options }),
      { code });
  }
  assert.throws(() => operations.applyResumeAll(desiredState({ mutate: RESUMED }), { runner: gcloud.runner,
    pauseReceipt: receipt, authorize: plan.planDigest, now }), { code: "RESUME_ALL_SYNTHETIC_TARGET_REFUSED" });
  const before = gcloud.calls.length;
  const done = operations.applyResumeAll(desired, { runner: gcloud.runner, pauseReceipt: receipt,
    authorize: plan.planDigest, now });
  assert.deepEqual(gcloud.calls.slice(before).filter((argv) => operations.classifyGcloudCommand(argv) !== "read"),
    [["scheduler", "jobs", "resume", TRIGGER, `--project=${APPLY_PROJECT}`, "--location=us-east1"]]);
  assert.deepEqual([done.schema, done.outcomes], [operations.GCP_OPS_RESUME_ALL_RECEIPT_SCHEMA,
    [{ name: TRIGGER, outcome: "resumed" }]]);
  assert.equal(trigger(world).state, "ENABLED");
  for (const name of ["synthetic-hand-made-trigger", "synthetic-webhook-trigger", "synthetic-deliberately-paused"]) {
    assert.equal(world.schedulerJobs.find((entry) => entry.name.endsWith(`/${name}`)).state, "PAUSED", name);
  }
  // Applied again, there is nothing left to resume.
  assert.deepEqual(operations.planResumeAll(desired, { runner: fake(desired, world).runner, pauseReceipt: receipt, now })
    .resume, []);
});

test("resume-all never resumes a trigger committed PAUSED, or one paused by someone else, and --only is exact", async (t) => {
  const directory = await receiptDirectory(t);
  // Committed PAUSED (before OPS-3's first resume): pause-all still pauses, resume-all never resumes.
  const prelaunch = desiredState({ synthetic: false, mutate: CADENCE });
  const world = convergedWorld(prelaunch);
  trigger(world).state = "ENABLED"; // someone resumed it by hand
  const pausePlan = operations.planPauseAll(prelaunch, { runner: fake(prelaunch, world).runner });
  const receipt = await operations.applyPauseAll(prelaunch, { runner: fake(prelaunch, world).runner,
    authorize: pausePlan.planDigest, receiptPath: join(directory, "pause.json") });
  assert.deepEqual(receipt.paused, [TRIGGER]);
  const committedPaused = operations.planResumeAll(prelaunch, { runner: fake(prelaunch, world).runner, pauseReceipt: receipt });
  assert.deepEqual([committedPaused.resume, committedPaused.triggers[0].reason], [[], "COMMITTED_STATE_PAUSED"]);
  assert.throws(() => operations.planResumeAll(prelaunch, { runner: fake(prelaunch, world).runner, only: [TRIGGER] }),
    { code: "RESUME_ALL_ONLY_INELIGIBLE" });
  // Committed ENABLED but paused before pause-all ran: not this receipt's to resume.
  const resumed = desiredState({ synthetic: false, mutate: RESUMED });
  const quiet = fake(resumed, world).runner;
  const emptyReceipt = await (async () => {
    const plan = operations.planPauseAll(resumed, { runner: quiet });
    return operations.applyPauseAll(resumed, { runner: quiet, authorize: plan.planDigest,
      receiptPath: join(directory, "pause-again.json") });
  })();
  assert.deepEqual([emptyReceipt.paused, emptyReceipt.alreadyPaused], [[], [TRIGGER]]);
  const deliberate = operations.planResumeAll(resumed, { runner: quiet, pauseReceipt: emptyReceipt });
  assert.deepEqual([deliberate.resume, deliberate.triggers[0].reason], [[], "NOT_PAUSED_BY_PAUSE_ALL"]);
  // The operator may name it: --only asserts they paused it.
  assert.deepEqual(operations.planResumeAll(resumed, { runner: quiet, only: [TRIGGER] }).resume, [TRIGGER]);
  for (const [source, code] of [
    [{}, "RESUME_ALL_SOURCE_REQUIRED"],
    [{ only: [] }, "RESUME_ALL_ONLY_INVALID"],
    [{ only: ["synthetic-hand-made-trigger"] }, "RESUME_ALL_ONLY_INVALID"],
    [{ only: [TRIGGER, TRIGGER] }, "RESUME_ALL_ONLY_INVALID"],
    [{ pauseReceipt: { ...emptyReceipt, paused: [TRIGGER] } }, "PAUSE_ALL_RECEIPT_INVALID"],
    [{ pauseReceipt: { ...emptyReceipt, project: "example-ops-other" } }, "PAUSE_ALL_RECEIPT_INVALID"],
    [{ pauseReceipt: { ...emptyReceipt, extra: true } }, "PAUSE_ALL_RECEIPT_INVALID"],
  ]) {
    assert.throws(() => operations.planResumeAll(resumed, { runner: quiet, ...source }), { code }, code);
  }
  // A live state the plan does not recognize blocks resume-all.
  trigger(world).state = "UPDATE_FAILED";
  const blocked = operations.planResumeAll(resumed, { runner: fake(resumed, world).runner, pauseReceipt: emptyReceipt });
  assert.deepEqual(blocked.blockers, [`TRIGGER_STATE_UNRECOGNIZED:${TRIGGER}`]);
  assert.throws(() => operations.applyResumeAll(resumed, { runner: fake(resumed, world).runner, pauseReceipt: emptyReceipt,
    authorize: blocked.planDigest }), { code: "RESUME_ALL_BLOCKED" });
  assert.ok(operations.planPauseAll(resumed, { runner: fake(resumed, world).runner }).blockers
    .includes(`TRIGGER_STATE_UNRECOGNIZED:${TRIGGER}`));
});

/** A receipt edited and then re-digested, as a hand-forged or stale file would be. */
function redigested(receipt, edit) {
  const copy = structuredClone(receipt);
  edit(copy);
  delete copy.digest;
  return { ...copy, digest: manifest.sha256Hex(canonicalJson(copy)) };
}

test("resume-all refuses an old receipt and skips a trigger changed after pause-all, even under a valid receipt",
  async (t) => {
    const directory = await receiptDirectory(t);
    const desired = desiredState({ synthetic: false, mutate: RESUMED });
    const world = resumedWorld(desired);
    let tick = 0;
    const clock = () => `2026-10-02T12:${String(tick++).padStart(2, "0")}:00Z`;
    const pausedAtMs = Date.parse("2026-10-02T12:30:00Z");
    const pausePlan = operations.planPauseAll(desired, { runner: fake(desired, world, { clock }).runner });
    const receipt = await operations.applyPauseAll(desired, { runner: fake(desired, world, { clock }).runner,
      authorize: pausePlan.planDigest, receiptPath: join(directory, "pause.json"), now: () => pausedAtMs });
    const at = (iso) => () => Date.parse(iso);
    const planAt = (now, pauseReceipt = receipt) => operations.planResumeAll(desired,
      { runner: fake(desired, world, { clock }).runner, pauseReceipt, now });
    assert.deepEqual(planAt(at("2026-10-03T12:30:00Z")).resume, [TRIGGER], "exactly 24 h old is still current");
    // Age: a receipt older than 24 h, or dated ahead of now, is refused before any read.
    assert.equal(operations.PAUSE_ALL_RECEIPT_MAX_AGE_HOURS, 24);
    assert.throws(() => planAt(at("2026-10-03T12:30:01Z")), { code: "PAUSE_ALL_RECEIPT_STALE" });
    const august = redigested(receipt, (copy) => { copy.pausedAt = "2026-08-01T00:00:00.000Z"; });
    assert.throws(() => planAt(at("2026-10-02T13:00:00Z"), august), { code: "PAUSE_ALL_RECEIPT_STALE" });
    assert.throws(() => operations.applyResumeAll(desired, { runner: fake(desired, world, { clock }).runner,
      pauseReceipt: august, authorize: "0".repeat(64), now: at("2026-10-02T13:00:00Z") }), { code: "PAUSE_ALL_RECEIPT_STALE" });
    const ahead = redigested(receipt, (copy) => { copy.pausedAt = "2026-10-02T13:06:00.000Z"; });
    assert.throws(() => planAt(at("2026-10-02T13:00:00Z"), ahead), { code: "PAUSE_ALL_RECEIPT_INVALID" });
    // The read-back evidence is closed and digested.
    for (const edit of [
      (copy) => { copy.triggers[0].extra = true; },
      (copy) => { copy.triggers[0].userUpdateTime = "yesterday"; },
      (copy) => { copy.triggers.push(copy.triggers[0]); },
      (copy) => { copy.triggers = "none"; },
    ]) {
      assert.throws(() => planAt(at("2026-10-02T13:00:00Z"), redigested(receipt, edit)),
        { code: "PAUSE_ALL_RECEIPT_INVALID" });
    }
    // No read-back for the trigger (the readback after the pauses failed): not resumed from the receipt.
    const unread = redigested(receipt, (copy) => { copy.triggers = null; });
    const missing = planAt(at("2026-10-02T13:00:00Z"), unread);
    assert.deepEqual([missing.resume, missing.triggers[0].reason], [[], "PAUSE_ALL_READBACK_MISSING"]);
    // Someone resumed it and paused it again on purpose after pause-all.
    const now = at("2026-10-02T13:00:00Z");
    assert.deepEqual(planAt(now).resume, [TRIGGER]);
    const recorded = receipt.triggers.find(({ name }) => name === TRIGGER);
    const call = fake(desired, world, { clock }).runner;
    for (const verb of ["resume", "pause"]) {
      assert.equal(call(["scheduler", "jobs", verb, TRIGGER, `--project=${desired.project}`, "--location=us-east1"]).status, 0);
    }
    assert.equal(trigger(world).state, "PAUSED");
    assert.notEqual(trigger(world).userUpdateTime, recorded.userUpdateTime);
    const repaused = planAt(now);
    assert.deepEqual([repaused.resume, repaused.triggers[0].reason], [[], "CHANGED_AFTER_PAUSE_ALL"]);
    const none = operations.applyResumeAll(desired, { runner: fake(desired, world, { clock }).runner,
      pauseReceipt: receipt, authorize: repaused.planDigest, now });
    assert.deepEqual(none.outcomes, []);
    assert.equal(trigger(world).state, "PAUSED", "a deliberately re-paused trigger stays paused");
    // A trigger that ran after pause-all was resumed in between, even if its userUpdateTime did not move.
    trigger(world).userUpdateTime = recorded.userUpdateTime;
    trigger(world).lastAttemptTime = "2026-10-02T12:45:00Z";
    assert.deepEqual(planAt(now).triggers[0].reason, "CHANGED_AFTER_PAUSE_ALL");
    // --only stays the operator's explicit path for both.
    assert.deepEqual(operations.planResumeAll(desired, { runner: fake(desired, world).runner, only: [TRIGGER] }).resume,
      [TRIGGER]);
    assert.ok(operations.RESUME_SKIP_REASONS.includes("CHANGED_AFTER_PAUSE_ALL")
      && operations.RESUME_SKIP_REASONS.includes("PAUSE_ALL_READBACK_MISSING"));
  });

test("in a shared project pause-all touches only the plane, and names a co-tenant trigger that keeps the gate shut",
  async (t) => {
    const directory = await receiptDirectory(t);
    const shared = desiredState({ synthetic: false, mutate: (value) => { sharedStaging(value); CADENCE(value); } });
    const world = withCoTenants(bornWorld(shared), shared);
    const runUri = (job) => `https://run.googleapis.com/v2/projects/${shared.project}/locations/${shared.region}/jobs/${job}:run`;
    world.schedulerJobs.push(
      { name: `projects/${shared.project}/locations/${shared.region}/jobs/synthetic-staging-trigger`, state: "ENABLED",
        httpTarget: { uri: runUri("synthetic-staging-refresh") } },
      { name: `projects/${shared.project}/locations/${shared.region}/jobs/synthetic-staging-hand-made`, state: "ENABLED",
        httpTarget: { uri: runUri("synthetic-staging-migrate") } },
    );
    const plan = operations.planPauseAll(shared, { runner: fake(shared, world).runner });
    assert.deepEqual(plan.triggers.map(({ name }) => name), ["synthetic-staging-hand-made", "synthetic-staging-trigger"]);
    assert.deepEqual(plan.foreignBlocking, [{ name: "tibotattle-test-nightly", state: "ENABLED" }]);
    assert.deepEqual([plan.rolloutGateAfter.satisfied, plan.rolloutGateAfter.reasons],
      [false, ["TRIGGER_NOT_PAUSED:tibotattle-test-nightly"]]);
    const gcloud = fake(shared, world);
    const receipt = await operations.applyPauseAll(shared, { runner: gcloud.runner, authorize: plan.planDigest,
      receiptPath: join(directory, "pause.json") });
    assert.deepEqual(receipt.paused, ["synthetic-staging-hand-made", "synthetic-staging-trigger"]);
    assert.equal(gcloud.calls.some((argv) => argv.includes("tibotattle-test-nightly")), false, "a co-tenant is never touched");
    assert.equal(world.schedulerJobs.find((entry) => entry.name.endsWith("/tibotattle-test-nightly")).state, "ENABLED");
    assert.equal(receipt.rolloutGate.satisfied, false);
  });

test("the pause and resume guards issue only their own shape, and apply and read never know resume", () => {
  const calls = [];
  const runner = (argv) => { calls.push(argv); return { status: 0, stdout: "[]" }; };
  const project = "--project=example-ops-prod1";
  const pause = operations.guardedGcloud(runner, { mode: "pause", project: "example-ops-prod1" });
  const resume = operations.guardedGcloud(runner, { mode: "resume", project: "example-ops-prod1" });
  const apply = operations.guardedGcloud(runner, { mode: "apply", project: "example-ops-prod1" });
  const read = operations.guardedGcloud(runner, { mode: "read", project: "example-ops-prod1" });
  assert.throws(() => pause(["sql", "instances", "create", "x", project]), { code: "GCLOUD_MUTATION_UNAUTHORIZED" });
  assert.throws(() => pause(["scheduler", "jobs", "update", "http", "x", project]), { code: "GCLOUD_MUTATION_UNAUTHORIZED" });
  assert.throws(() => pause(["scheduler", "jobs", "resume", "x", project]), { code: "GCLOUD_COMMAND_FORBIDDEN" });
  assert.throws(() => resume(["scheduler", "jobs", "pause", "x", project]), { code: "GCLOUD_MUTATION_UNAUTHORIZED" });
  assert.throws(() => resume(["run", "jobs", "replace", "x", project]), { code: "GCLOUD_MUTATION_UNAUTHORIZED" });
  for (const call of [apply, read]) {
    assert.throws(() => call(["scheduler", "jobs", "resume", "x", project]), { code: "GCLOUD_COMMAND_FORBIDDEN" });
  }
  assert.throws(() => operations.guardedGcloud(runner, { mode: "admin", project: "example-ops-prod1" }),
    { code: "GCLOUD_GUARD_MODE_INVALID" });
  assert.equal(calls.length, 0);
  assert.equal(pause(["scheduler", "jobs", "pause", "x", project, "--location=us-east1"]), null);
  assert.equal(resume(["scheduler", "jobs", "resume", "x", project, "--location=us-east1"]), null);
  assert.equal(calls.length, 2);
  assert.deepEqual(operations.RESUME_COMMANDS, ["scheduler jobs resume"]);
  assert.equal(operations.MUTATING_COMMANDS.includes(operations.PAUSE_COMMAND), true);
});
