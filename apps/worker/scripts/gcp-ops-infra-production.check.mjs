/**
 * PROD-PREP: the committed production desired state (owner decisions
 * 2026-10-02, round 13) rehearsed in memory against the synthetic gcloud,
 * from the shape it has before the main session pins anything: the bucket
 * birth, pass 1 (no image), the pins, and pass 2 (the bootstrap image). The
 * fake answers in Admin API shapes; it proves the plan and apply logic for a
 * dedicated production project, not that live gcloud parses the same way.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as manifest from "./gcp-ops-infra-manifest.mjs";
import * as operations from "./gcp-ops-infra-operations.mjs";
import { bornBucket, createFakeGcloud, emptyWorld, memoryWriter, withCloudBuildBucket }
  from "./fixtures/gcp-ops-infra/fake-gcloud.mjs";
import { unpinnedProductionText } from "./fixtures/gcp-ops-infra/production-unfilled.mjs";

process.env.PATH = "/nonexistent-gcloud-guard";

// Round 15 (C3): the committed file carries no refresh cadence. A test that needs a set one
// uses this synthetic value, which lives in the test only.
const SYNTHETIC_CADENCE = "40 6 * * 2";

const IMAGE = Object.freeze({ imageDigest: "c".repeat(64), sourceCommit: "d".repeat(40) });
const EXECUTOR = "run-job-iam:analytics-refresh:bind:roles/run.jobsExecutor|serviceAccount:"
  + "tibotattle-scheduler@tibotattle-prod.iam.gserviceaccount.com|";
const MAINTENANCE_EXECUTOR = "run-job-iam:maintenance:bind:roles/run.jobsExecutor|serviceAccount:"
  + "tibotattle-scheduler@tibotattle-prod.iam.gserviceaccount.com|";
// D-OPS4's maintenance job and its pinned every-minute trigger, committed PAUSED.
const MAINTENANCE_TRIGGER = "tibotattle-maintenance-trigger";
/** Whether the scheduler account holds run.jobsExecutor on the named job. */
const executorOn = (world, job) => JSON.stringify(world.jobPolicies[job] ?? {}).includes("roles/run.jobsExecutor");
const PROOF = Object.freeze({ bucketGeneration: "1790000000000001", bucketMetageneration: "1" });
const KEPT_SECRETS = Object.freeze(["IDENTITY_LINK_SECRET", "POSTGRES_RATE_LIMIT_SECRET", "ENVELOPE_PUBLIC_JWK",
  "ENVELOPE_PRIVATE_JWK"]);
// Round 12 retired the Google and Apple secrets; nothing on the production estate reads the GitHub token.
const LEFT_OUT = /GOOGLE_OIDC_CLIENT_SECRET|APPLE_PRIVATE_KEY|DISTRIBUTION_GITHUB_API_TOKEN/u;

/** The committed production file before the pins, then with the pins the main session makes. */
function production(pin = () => {}) {
  const value = JSON.parse(unpinnedProductionText());
  pin(value);
  return manifest.assertCommittedDesiredState(manifest.validateDesiredState(value));
}

const deferred = (plan) => plan.operations.filter((entry) => entry.deferred !== undefined)
  .map((entry) => `${entry.id}:${entry.deferred}`);
const executable = (plan) => plan.operations.filter((entry) => entry.deferred === undefined).map((entry) => entry.id);
// BUILD-SOURCE: the production builder's bucket-level read on the project's default Cloud Build bucket.
const BUILD_SOURCE_BUCKET = "tibotattle-prod_cloudbuild";
const BUILD_SOURCE_READER = "build-source-bucket-iam:bind:roles/storage.objectViewer|serviceAccount:"
  + "tibotattle-builder@tibotattle-prod.iam.gserviceaccount.com|";

test("the production apply rehearsal (in memory): birth, pass 1, pins and pass 2 converge with no left-out secret", () => {
  let desired = production();
  assert.deepEqual([desired.project, desired.projectNumber, desired.region, desired.projectTenancy],
    ["tibotattle-prod", "874229235044", "us-east1", "dedicated"]);
  assert.deepEqual(Object.keys(desired.secrets), [...KEPT_SECRETS]);
  const world = emptyWorld();
  const writer = memoryWriter();
  const gcloud = createFakeGcloud(world, { files: writer.files, project: desired.project, region: desired.region,
    projectNumber: desired.projectNumber });
  const plan = (options = {}) => operations.planInfrastructure(desired,
    operations.readbackInfrastructure(desired, { runner: gcloud.runner }), options);

  // Before the birth: the only blockers are the bucket's, and nothing is refused. The project has
  // had no `gcloud builds submit` yet, so its default Cloud Build bucket is absent too (BUILD-SOURCE):
  // a finding, not a blocker.
  const before = plan();
  assert.deepEqual([before.summary.refused, before.findings, before.blockers],
    [0, ["BUCKET_ABSENT", "BUCKET_PROOF_UNPINNED", "BUILD_SOURCE_BUCKET_ABSENT"],
      ["BUCKET_ABSENT", "BUCKET_PROOF_UNPINNED"]]);
  assert.throws(() => operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: before.planDigest }),
    { code: "APPLY_BUCKET_PROOF_UNPINNED" });

  // The birth (gcp-infra.mjs bucket-birth) and its pinned proof.
  world.buckets.push(bornBucket({ name: desired.bucket.name, location: desired.bucket.location,
    generation: PROOF.bucketGeneration, extra: { projectNumber: desired.projectNumber } }));
  desired = production((value) => { value.bucket.proof = { ...PROOF }; });
  const first = plan();
  assert.deepEqual([first.summary.refused, first.findings, first.blockers], [0, ["BUILD_SOURCE_BUCKET_ABSENT"], []]);
  const ids = executable(first);
  // Six accounts, the verifier grant, the custom role, six project bindings,
  // the repository and its writer binding, four secrets and their accessor
  // bindings, Cloud SQL with its database and two IAM users, and the logging
  // exclusion. The trigger is not among them: round 15 (C3) leaves the refresh
  // cadence to the production-scale measurement, so the committed schedule is
  // null and its create is deferred (SCHEDULER_CADENCE_UNSET), with no pause.
  // D-OPS4's maintenance job, trigger and grant wait for the telemetry
  // storage namespace the job reads. BUILD-SOURCE: pass 1 creates the absent
  // <project>_cloudbuild (uniform bucket-level access, public access
  // prevention enforced) and defers the builder's read binding to pass 2.
  assert.equal(ids.length, 30, ids.join("\n"));
  assert.deepEqual(first.operations.find((entry) => entry.id === "build-source-bucket:create").argv, ["storage",
    "buckets", "create", `gs://${BUILD_SOURCE_BUCKET}`, "--project=tibotattle-prod", "--location=us-east1",
    "--uniform-bucket-level-access", "--public-access-prevention"]);
  for (const id of ["custom-role:create", "artifact-registry:create", "cloud-sql:create", "cloud-sql-database:create",
    "cloud-sql-user:create:runtime", "cloud-sql-user:create:migrator", "logging-exclusion:create",
    "verifier-iam:bind:roles/iam.serviceAccountTokenCreator|user:adamallcock@gmail.com|"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.deepEqual(ids.filter((id) => id.startsWith("scheduler:")), []);
  for (const name of KEPT_SECRETS) assert.ok(ids.includes(`secret:create:${name}`), name);
  assert.equal(deferred(first).length, 11);
  assert.deepEqual(deferred(first), [
    `${BUILD_SOURCE_READER}:BUILD_SOURCE_BUCKET_ABSENT`,
    "run-service:create:TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED",
    "run-service-iam:bind:roles/run.invoker|serviceAccount:tibotattle-edge-invoker@tibotattle-prod.iam.gserviceaccount.com|:TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED",
    "run-service-iam:bind:roles/run.invoker|serviceAccount:tibotattle-verifier@tibotattle-prod.iam.gserviceaccount.com|:TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED",
    "run-job:create:production-migrate:BOOTSTRAP_IMAGE_REQUIRED",
    "run-job:create:analytics-refresh:BOOTSTRAP_IMAGE_REQUIRED",
    "run-job:create:maintenance:TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED",
    "scheduler:create:analytics-refresh:SCHEDULER_CADENCE_UNSET",
    `${EXECUTOR}:BOOTSTRAP_IMAGE_REQUIRED`,
    "scheduler:create:maintenance:TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED",
    `${MAINTENANCE_EXECUTOR}:TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED`,
  ]);
  const argv = first.operations.map((entry) => entry.argv.join(" ")).join("\n");
  // Nothing names a left-out secret, a staging resource or a test resource.
  assert.doesNotMatch(argv, LEFT_OUT);
  assert.doesNotMatch(argv, /staging|tibotattle-test/u);
  // Cloud SQL IAM users go by their PostgreSQL names, never the full email (73b38784).
  const users = first.operations.filter((entry) => entry.id.startsWith("cloud-sql-user:create:"));
  assert.deepEqual(users.map((entry) => entry.argv[3]),
    ["tibotattle-runtime@tibotattle-prod.iam", "tibotattle-migrator@tibotattle-prod.iam"]);
  // The deferred trigger create carries no schedule flag: it cannot be applied as it stands.
  const trigger = first.operations.find((entry) => entry.id === "scheduler:create:analytics-refresh");
  assert.equal(trigger.deferred, "SCHEDULER_CADENCE_UNSET");
  assert.equal(trigger.argv.some((argument) => argument.startsWith("--schedule=")), false);

  const applied = operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: first.planDigest,
    createSpecWriter: () => writer.create() });
  // The bucket now exists, so the re-plan apply reports holds its binding as executable.
  assert.deepEqual(applied.remaining, { planDigest: applied.remaining.planDigest, executable: 1, deferred: 10, refused: 0 });
  const sourceBucket = world.buckets.find((bucket) => bucket.name === BUILD_SOURCE_BUCKET);
  assert.deepEqual([sourceBucket.location, sourceBucket.projectNumber, sourceBucket.iamConfiguration], ["US-EAST1",
    "874229235044", { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" }]);
  // No trigger exists, so none can run anything; the scheduler account cannot run any job yet either.
  assert.deepEqual(world.schedulerJobs, []);
  assert.deepEqual(world.secrets.map((secret) => secret.name.split("/").at(-1)).sort(), [...KEPT_SECRETS].sort());

  // The owner adds the owner-held versions and the main session the new random one; then the pins.
  for (const name of KEPT_SECRETS) {
    world.secretVersions[name] = [{ name: `projects/874229235044/secrets/${name}/versions/1`, state: "ENABLED" }];
  }
  desired = production((value) => {
    value.bucket.proof = { ...PROOF };
    for (const secret of Object.values(value.secrets)) secret.version = "1";
    value.service.telemetryStorageNamespace = "synthetic-namespace";
  });
  const second = plan({ bootstrap: IMAGE });
  // ROUTES-R12 narrowed CR-3 to the committed secrets, so the service and its two invoker
  // grants are created in this pass. The scheduler account's executor grant on the refresh job is
  // not among them: with no cadence there is no refresh trigger, and the grant waits for the plan
  // that creates and pauses one (SCHEDULER_CADENCE_UNSET). The maintenance job's trigger has its
  // pinned cadence (D-OPS4), so it is created, paused at once, and only then granted.
  assert.deepEqual(executable(second), [
    BUILD_SOURCE_READER,
    "run-service:create",
    "run-service-iam:bind:roles/run.invoker|serviceAccount:tibotattle-edge-invoker@tibotattle-prod.iam.gserviceaccount.com|",
    "run-service-iam:bind:roles/run.invoker|serviceAccount:tibotattle-verifier@tibotattle-prod.iam.gserviceaccount.com|",
    "run-job:create:production-migrate", "run-job:create:analytics-refresh",
    "run-job:create:maintenance", "scheduler:create:maintenance", "scheduler:pause:maintenance", MAINTENANCE_EXECUTOR]);
  assert.deepEqual(deferred(second).filter((entry) => entry.endsWith(":SCHEDULER_CADENCE_UNSET")), [
    "scheduler:create:analytics-refresh:SCHEDULER_CADENCE_UNSET", `${EXECUTOR}:SCHEDULER_CADENCE_UNSET`]);
  operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: second.planDigest, bootstrap: IMAGE,
    createSpecWriter: () => writer.create() });
  // Nothing waits any more: the service composed with the committed secrets.
  assert.deepEqual([...operations.infrastructureCleanliness(plan()).reasons], []);
  // The builder reads its sources through that one bucket-level binding, and holds no project storage role.
  assert.deepEqual(world.bucketPolicies[BUILD_SOURCE_BUCKET].bindings.filter((binding) =>
    binding.role === "roles/storage.objectViewer"), [{ role: "roles/storage.objectViewer",
    members: ["serviceAccount:tibotattle-builder@tibotattle-prod.iam.gserviceaccount.com"] }]);
  assert.equal(JSON.stringify(world.projectPolicy).includes("roles/storage."), false);
  // The rendered service mounts exactly the four kept secrets, none of them a retired sign-in one.
  assert.equal(world.services.length, 1);
  assert.deepEqual(world.services[0].spec.template.spec.containers[0].env
    .filter((entry) => entry.valueFrom !== undefined).map((entry) => entry.name), [...KEPT_SECRETS]);
  // Pass 2 still creates no refresh trigger: the cadence is the owner's, and the clean reasons above
  // omit it. Nor does the scheduler account hold run.jobsExecutor on the refresh job: both wait for
  // the cadence. The only trigger is the maintenance job's, PAUSED, with its grant.
  assert.deepEqual(world.schedulerJobs.map((job) => [job.name.split("/").at(-1), job.state]),
    [[MAINTENANCE_TRIGGER, "PAUSED"]]);
  assert.deepEqual([executorOn(world, "tibotattle-analytics-refresh"), executorOn(world, "tibotattle-maintenance"),
    executorOn(world, "tibotattle-migrate")], [false, true, false]);
  // The maintenance job reads the identity-link secret only; the unread GitHub token is left out.
  const maintenanceJob = world.jobs.find((job) => job.metadata.name === "tibotattle-maintenance");
  assert.deepEqual(maintenanceJob.spec.template.spec.template.spec.containers[0].env
    .filter((entry) => entry.valueFrom !== undefined).map((entry) => entry.name), ["IDENTITY_LINK_SECRET"]);
  // The rollout accepts that; the cutover's gate (readback --require-clean --require-cadence) does not.
  assert.deepEqual([...operations.infrastructureCleanliness(plan(), { requireCadence: true }).reasons.filter(
    (reason) => reason.endsWith(":SCHEDULER_CADENCE_UNSET"))], [
    "DEFERRED:scheduler:create:analytics-refresh:SCHEDULER_CADENCE_UNSET", `DEFERRED:${EXECUTOR}:SCHEDULER_CADENCE_UNSET`]);
  // Every mutation named the production project and nothing else.
  const mutations = gcloud.calls.filter((call) => operations.classifyGcloudCommand(call) === "mutate");
  assert.ok(mutations.length > 0);
  for (const call of mutations) {
    assert.ok(call.includes("--project=tibotattle-prod") || call.includes("tibotattle-prod"), call.join(" "));
    assert.doesNotMatch(call.join(" "), LEFT_OUT);
    assert.doesNotMatch(call.join(" "), /tibotattle-test|staging/u);
  }
});

test("BUILD-SOURCE: when tibotattle-prod_cloudbuild already exists, pass 1 binds instead of creating and pass 1b is empty", () => {
  let desired = production();
  const world = emptyWorld();
  const writer = memoryWriter();
  const gcloud = createFakeGcloud(world, { files: writer.files, project: desired.project, region: desired.region,
    projectNumber: desired.projectNumber });
  // Some earlier submit made the project's default Cloud Build bucket, with Cloud Storage's own bindings only.
  withCloudBuildBucket(world, { project: desired.project, projectNumber: desired.projectNumber });
  const plan = (options = {}) => operations.planInfrastructure(desired,
    operations.readbackInfrastructure(desired, { runner: gcloud.runner }), options);
  // Step 3 (before the birth) and step 5 (pass 1): 30 executable, 10 deferred, no BUILD_SOURCE finding.
  const before = plan();
  assert.deepEqual([before.findings, executable(before).length, deferred(before).length],
    [["BUCKET_ABSENT", "BUCKET_PROOF_UNPINNED"], 30, 10]);
  world.buckets.push(bornBucket({ name: desired.bucket.name, location: desired.bucket.location,
    generation: PROOF.bucketGeneration, extra: { projectNumber: desired.projectNumber } }));
  desired = production((value) => { value.bucket.proof = { ...PROOF }; });
  const first = plan();
  assert.deepEqual([first.findings, first.blockers, executable(first).length, deferred(first).length],
    [[], [], 30, 10]);
  assert.ok(executable(first).includes(BUILD_SOURCE_READER));
  assert.equal(first.operations.some((entry) => entry.id === "build-source-bucket:create"), false);
  const applied = operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: first.planDigest,
    createSpecWriter: () => writer.create() });
  // Step 5's remaining executable is 0, so there is no pass 1b (approval 4b) to run.
  assert.deepEqual({ ...applied.remaining, planDigest: null }, { planDigest: null, executable: 0, deferred: 10, refused: 0 });
  assert.deepEqual(world.bucketPolicies[BUILD_SOURCE_BUCKET].bindings.filter((binding) =>
    binding.role === "roles/storage.objectViewer"), [{ role: "roles/storage.objectViewer",
    members: ["serviceAccount:tibotattle-builder@tibotattle-prod.iam.gserviceaccount.com"] }]);
});

test("a cadence the owner commits later (synthetic here) is created paused after pass 2, with the grant only after the pause", () => {
  const pinned = (cadence) => (value) => {
    value.bucket.proof = { ...PROOF };
    for (const secret of Object.values(value.secrets)) secret.version = "1";
    value.service.telemetryStorageNamespace = "synthetic-namespace";
    value.scheduler["analytics-refresh"].schedule = cadence;
  };
  // Pass 1 has no pins yet, as in the first test; pass 2 and the later plan carry them all.
  let desired = production((value) => { value.bucket.proof = { ...PROOF }; });
  const world = emptyWorld();
  const writer = memoryWriter();
  const gcloud = createFakeGcloud(world, { files: writer.files, project: desired.project, region: desired.region,
    projectNumber: desired.projectNumber });
  world.buckets.push(bornBucket({ name: desired.bucket.name, location: desired.bucket.location,
    generation: PROOF.bucketGeneration, extra: { projectNumber: desired.projectNumber } }));
  const plan = (options = {}) => operations.planInfrastructure(desired,
    operations.readbackInfrastructure(desired, { runner: gcloud.runner }), options);
  const apply = (digest, options = {}) => operations.applyInfrastructure(desired, { runner: gcloud.runner,
    authorize: digest, createSpecWriter: () => writer.create(), ...options });
  const granted = () => executorOn(world, "tibotattle-analytics-refresh");
  const refreshTriggers = () => world.schedulerJobs.filter((job) => !job.name.endsWith(`/${MAINTENANCE_TRIGGER}`));

  // Pass 1 with no cadence creates no trigger (the production-scale measurement comes first).
  const first = plan();
  assert.deepEqual([executable(first).length, deferred(first).length], [30, 11]);
  apply(first.planDigest);
  assert.deepEqual(world.schedulerJobs, []);

  // The pins, then pass 2: both jobs are created. Neither the trigger nor the scheduler's executor
  // grant exists yet, so the account cannot start a job.
  for (const name of KEPT_SECRETS) {
    world.secretVersions[name] = [{ name: `projects/874229235044/secrets/${name}/versions/1`, state: "ENABLED" }];
  }
  desired = production(pinned(null));
  const second = plan({ bootstrap: IMAGE });
  apply(second.planDigest, { bootstrap: IMAGE });
  assert.deepEqual([refreshTriggers().length, world.jobs.length, granted()], [0, 3, false]);

  // After the measurement the owner commits a cadence. A later plan has a new digest and creates the
  // trigger, pauses it at once, and only then grants the account run.jobsExecutor: the order that
  // makes a trigger whose pause failed unable to start the job, now with both jobs already live.
  desired = production(pinned(SYNTHETIC_CADENCE));
  const later = plan();
  assert.notEqual(later.planDigest, second.planDigest);
  assert.deepEqual(later.blockers, []);
  assert.deepEqual(later.operations.filter((entry) => entry.deferred === undefined).map((entry) => entry.id),
    ["scheduler:create:analytics-refresh", "scheduler:pause:analytics-refresh", EXECUTOR]);
  assert.deepEqual(deferred(later).filter((entry) => entry.includes("SCHEDULER")), []);
  const create = later.operations.find((entry) => entry.id === "scheduler:create:analytics-refresh");
  assert.ok(create.argv.includes(`--schedule=${SYNTHETIC_CADENCE}`));
  assert.ok(create.argv.includes("--time-zone=Etc/UTC"));
  assert.ok(create.argv.includes("--max-retry-attempts=0"));
  // The old digest no longer authorizes the changed estate.
  assert.throws(() => apply(second.planDigest), { code: "APPLY_PLAN_DIGEST_MISMATCH" });

  // A pause that fails leaves an ENABLED trigger and no grant: it cannot start the production job.
  const failing = createFakeGcloud(world, { files: writer.files, project: desired.project, region: desired.region,
    failWhen: (argv) => argv.slice(0, 3).join(" ") === "scheduler jobs pause" });
  assert.throws(() => operations.applyInfrastructure(desired, { runner: failing.runner, authorize: later.planDigest,
    createSpecWriter: () => writer.create() }), (error) => error.code === "APPLY_OPERATION_FAILED"
    && error.operation === "scheduler:pause:analytics-refresh");
  assert.deepEqual(refreshTriggers().map((job) => job.state), ["ENABLED"]);
  assert.equal(granted(), false);
  // The next plan pauses it, then grants; the estate is then PAUSED and bound.
  const repair = plan();
  assert.deepEqual(executable(repair), ["scheduler:pause:analytics-refresh", EXECUTOR]);
  apply(repair.planDigest);
  assert.deepEqual(world.schedulerJobs.map((job) => [job.name.split("/").at(-1), job.state]),
    [[MAINTENANCE_TRIGGER, "PAUSED"], ["tibotattle-analytics-refresh-trigger", "PAUSED"]]);
  assert.equal(granted(), true);
  assert.deepEqual(executable(plan()), []);
  assert.equal(deferred(plan()).some((entry) => entry.startsWith("scheduler:")), false);
  // The cutover's gate no longer finds the cadence unset.
  assert.equal([...operations.infrastructureCleanliness(plan(), { requireCadence: true }).reasons]
    .some((reason) => reason.endsWith(":SCHEDULER_CADENCE_UNSET")), false);
});
