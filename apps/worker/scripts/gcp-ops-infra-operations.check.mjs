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
  assert.deepEqual(result.summary, { executable: 35, deferred: 1, refused: 0 });
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
  assert.deepEqual(byId.get("cloud-sql-user:create:runtime").argv, ["sql", "users", "create",
    desired.serviceAccounts.runtime.email, "--instance=synthetic-primary", "--project=synthetic-ops-project",
    "--type=cloud_iam_service_account"]);
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
  // Exactly the two fast-path jobs, both created; only the trigger waits,
  // for the owner's cadence.
  assert.deepEqual(ops(result, (entry) => entry.id.startsWith("run-job:")).map((entry) => entry.id),
    ["run-job:create:production-migrate", "run-job:create:analytics-refresh"]);
  const refresh = JSON.parse(byId.get("run-job:create:analytics-refresh").file.content);
  assert.deepEqual(refresh.spec.template.spec.template.spec.containers[0].args,
    ["--max-old-space-size=12288", "dist/analytics-refresh.mjs", "--mode=full"]);
  assert.deepEqual(ops(result, (entry) => entry.deferred !== undefined).map((entry) => [entry.id, entry.deferred]), [
    ["scheduler:create:analytics-refresh", "SCHEDULER_CADENCE_UNSET"],
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
  assert.deepEqual(result.summary, { executable: 37, deferred: 0, refused: 0 });
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
  assert.equal(sequence.filter((kind) => kind === "mutate").length, 37);
  assert.ok(sequence.slice(lastMutation + 1).every((kind) => kind === "read"));
  // The trigger was created and then paused; apply never resumes it.
  assert.equal(trigger(world).state, "PAUSED");
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
  assert.deepEqual(result.summary, { executable: 37, deferred: 0, refused: 0 });
  // Create, then pause at once, then (only then) the scheduler's run.jobsExecutor.
  const executor = `run-job-iam:analytics-refresh:bind:roles/run.jobsExecutor|${desired.serviceAccounts.scheduler.member}|`;
  assert.deepEqual(result.operations.slice(-3).map((entry) => entry.id),
    ["scheduler:create:analytics-refresh", "scheduler:pause:analytics-refresh", executor]);
  const receipt = operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: result.planDigest,
    bootstrap: BOOTSTRAP, createSpecWriter: () => gcloud.writer.create() });
  assert.deepEqual({ ...receipt.remaining, planDigest: null }, { planDigest: null, executable: 0, deferred: 0, refused: 0 });
  assert.deepEqual(world.jobs.map((job) => job.metadata.name), ["synthetic-production-migrate", "synthetic-analytics-refresh"]);
  assert.equal(trigger(world).state, "PAUSED");
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
  assert.deepEqual(replan.operations.map((entry) => [entry.id, entry.action, entry.argv.slice(0, 4).join(" ")]),
    [["scheduler:pause:analytics-refresh", "update", `scheduler jobs pause ${TRIGGER}`],
      [`run-job-iam:analytics-refresh:bind:roles/run.jobsExecutor|${desired.serviceAccounts.scheduler.member}|`, "bind",
        "run jobs add-iam-policy-binding synthetic-analytics-refresh"]]);
  assert.deepEqual(replan.summary, { executable: 2, deferred: 0, refused: 0 });
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
  assert.deepEqual(converged.summary, { executable: 0, deferred: 1, refused: 0 });
  assert.deepEqual({ ...operations.infrastructureCleanliness(converged) }, { clean: true, reasons: [] });
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
    ["FINDING:BUCKET_PROOF_UNPINNED", "BLOCKER:BUCKET_PROOF_UNPINNED"]);
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
  // The service, its two invoker binds and both jobs wait for an image; the
  // trigger for its cadence, and the scheduler's grant for its job.
  assert.deepEqual(noImage.operations.filter((entry) => entry.deferred !== undefined).map((entry) => entry.deferred),
    [...Array(5).fill("BOOTSTRAP_IMAGE_REQUIRED"), "SCHEDULER_CADENCE_UNSET", "BOOTSTRAP_IMAGE_REQUIRED"]);
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
  assert.deepEqual(first.operations.slice(-3).map((entry) => entry.id),
    ["scheduler:create:analytics-refresh", "scheduler:pause:analytics-refresh", EXECUTOR(enabled)]);
  operations.applyInfrastructure(enabled, { runner: gcloud.runner, authorize: first.planDigest, bootstrap: BOOTSTRAP,
    createSpecWriter: () => gcloud.writer.create() });
  assert.equal(trigger(world).state, "PAUSED");
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
      "SCHEDULER_CADENCE_UNSET"]]);
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
  value.scheduler["analytics-refresh"].name = "synthetic-staging-trigger";
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
  ]);
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
  assert.deepEqual([...deferrals].sort(), ["SCHEDULER_CADENCE_UNSET",
    "STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud", "VERIFIER_TOKEN_CREATOR_UNASSIGNED"]);
  assert.ok(ops(result, (entry) => entry.id === "secret:create:IDENTITY_LINK_SECRET")[0].argv
    .includes("tibotattle-staging-identity-link-secret"));
  // Apply refuses it until the bucket is born and its proof is committed.
  assert.throws(() => operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: result.planDigest,
    bootstrap: BOOTSTRAP }), { code: "APPLY_BUCKET_PROOF_UNPINNED" });
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
      verdict: "paused_too_long", alert: true }],
    alert: true, signal: "SCHEDULER_TRIGGER_PAUSED_TOO_LONG",
  });
  trigger(world).state = "ENABLED";
  const running = operations.probeScheduler(resumed, { runner: fake(resumed, world).runner, now: () => nowMs });
  assert.deepEqual([running.alert, running.signal, running.triggers[0].verdict], [false, null, "running"]);
  // Before OPS-3 resumes it, a paused trigger is paused by design.
  const prelaunch = desiredState({ synthetic: false, mutate: CADENCE });
  trigger(world).state = "PAUSED";
  assert.equal(operations.probeScheduler(prelaunch, { runner: fake(prelaunch, world).runner, now: () => nowMs }).alert, false);
});
