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
import { bornBucket, createFakeGcloud, emptyWorld, memoryWriter } from "./fixtures/gcp-ops-infra/fake-gcloud.mjs";
import { unpinnedProductionText } from "./fixtures/gcp-ops-infra/production-unfilled.mjs";

process.env.PATH = "/nonexistent-gcloud-guard";

const IMAGE = Object.freeze({ imageDigest: "c".repeat(64), sourceCommit: "d".repeat(40) });
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

test("the production apply rehearsal (in memory): birth, pass 1, pins and pass 2 converge with no left-out secret", () => {
  let desired = production();
  assert.deepEqual([desired.project, desired.projectNumber, desired.region, desired.projectTenancy],
    ["tibotattle-prod", "874229235044", "us-east1", "dedicated"]);
  assert.deepEqual(Object.keys(desired.secrets), [...KEPT_SECRETS]);
  const world = emptyWorld();
  const writer = memoryWriter();
  const gcloud = createFakeGcloud(world, { files: writer.files, project: desired.project, region: desired.region });
  const plan = (options = {}) => operations.planInfrastructure(desired,
    operations.readbackInfrastructure(desired, { runner: gcloud.runner }), options);

  // Before the birth: the only blockers are the bucket's, and nothing is refused.
  const before = plan();
  assert.deepEqual([before.summary.refused, before.findings, before.blockers],
    [0, ["BUCKET_ABSENT", "BUCKET_PROOF_UNPINNED"], ["BUCKET_ABSENT", "BUCKET_PROOF_UNPINNED"]]);
  assert.throws(() => operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: before.planDigest }),
    { code: "APPLY_BUCKET_PROOF_UNPINNED" });

  // The birth (gcp-infra.mjs bucket-birth) and its pinned proof.
  world.buckets.push(bornBucket({ name: desired.bucket.name, location: desired.bucket.location,
    generation: PROOF.bucketGeneration, extra: { projectNumber: desired.projectNumber } }));
  desired = production((value) => { value.bucket.proof = { ...PROOF }; });
  const first = plan();
  assert.deepEqual([first.summary.refused, first.findings, first.blockers], [0, [], []]);
  const ids = executable(first);
  // Six accounts, the verifier grant, the custom role, six project bindings,
  // the repository and its writer binding, four secrets and their accessor
  // bindings, Cloud SQL with its database and two IAM users, the logging
  // exclusion, and the trigger created and paused at once.
  assert.equal(ids.length, 31, ids.join("\n"));
  for (const id of ["custom-role:create", "artifact-registry:create", "cloud-sql:create", "cloud-sql-database:create",
    "cloud-sql-user:create:runtime", "cloud-sql-user:create:migrator", "logging-exclusion:create",
    "scheduler:create:analytics-refresh", "scheduler:pause:analytics-refresh",
    "verifier-iam:bind:roles/iam.serviceAccountTokenCreator|user:adamallcock@gmail.com|"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(ids.indexOf("scheduler:create:analytics-refresh") + 1 === ids.indexOf("scheduler:pause:analytics-refresh"));
  for (const name of KEPT_SECRETS) assert.ok(ids.includes(`secret:create:${name}`), name);
  assert.deepEqual(deferred(first), [
    "run-service:create:TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED",
    "run-service-iam:bind:roles/run.invoker|serviceAccount:tibotattle-edge-invoker@tibotattle-prod.iam.gserviceaccount.com|:TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED",
    "run-service-iam:bind:roles/run.invoker|serviceAccount:tibotattle-verifier@tibotattle-prod.iam.gserviceaccount.com|:TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED",
    "run-job:create:production-migrate:BOOTSTRAP_IMAGE_REQUIRED",
    "run-job:create:analytics-refresh:BOOTSTRAP_IMAGE_REQUIRED",
    "run-job-iam:analytics-refresh:bind:roles/run.jobsExecutor|serviceAccount:tibotattle-scheduler@tibotattle-prod.iam.gserviceaccount.com|:BOOTSTRAP_IMAGE_REQUIRED",
  ]);
  const argv = first.operations.map((entry) => entry.argv.join(" ")).join("\n");
  // Nothing names a left-out secret, a staging resource or a test resource.
  assert.doesNotMatch(argv, LEFT_OUT);
  assert.doesNotMatch(argv, /staging|tibotattle-test/u);
  // Cloud SQL IAM users go by their PostgreSQL names, never the full email (73b38784).
  const users = first.operations.filter((entry) => entry.id.startsWith("cloud-sql-user:create:"));
  assert.deepEqual(users.map((entry) => entry.argv[3]),
    ["tibotattle-runtime@tibotattle-prod.iam", "tibotattle-migrator@tibotattle-prod.iam"]);
  assert.ok(first.operations.find((entry) => entry.id === "scheduler:create:analytics-refresh").argv
    .includes("--schedule=15 2 * * *"));

  const applied = operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: first.planDigest,
    createSpecWriter: () => writer.create() });
  assert.deepEqual(applied.remaining, { planDigest: applied.remaining.planDigest, executable: 0, deferred: 6, refused: 0 });
  // The trigger exists and is paused; the scheduler account cannot run any job yet.
  assert.deepEqual(world.schedulerJobs.map((job) => [job.name.split("/").at(-1), job.state]),
    [["tibotattle-analytics-refresh-trigger", "PAUSED"]]);
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
  assert.deepEqual(executable(second), [
    "run-job:create:production-migrate", "run-job:create:analytics-refresh",
    "run-job-iam:analytics-refresh:bind:roles/run.jobsExecutor|serviceAccount:tibotattle-scheduler@tibotattle-prod.iam.gserviceaccount.com|",
  ]);
  operations.applyInfrastructure(desired, { runner: gcloud.runner, authorize: second.planDigest, bootstrap: IMAGE,
    createSpecWriter: () => writer.create() });
  // The service waits for ROUTES-R12: CR-3 still requires the retired Google secret.
  assert.deepEqual([...operations.infrastructureCleanliness(plan()).reasons], [
    "DEFERRED:run-service:create:SERVICE_RETIRED_SECRET_STILL_REQUIRED:GOOGLE_OIDC_CLIENT_SECRET",
    "DEFERRED:run-service-iam:bind:roles/run.invoker|serviceAccount:tibotattle-edge-invoker@tibotattle-prod.iam.gserviceaccount.com|:SERVICE_RETIRED_SECRET_STILL_REQUIRED:GOOGLE_OIDC_CLIENT_SECRET",
    "DEFERRED:run-service-iam:bind:roles/run.invoker|serviceAccount:tibotattle-verifier@tibotattle-prod.iam.gserviceaccount.com|:SERVICE_RETIRED_SECRET_STILL_REQUIRED:GOOGLE_OIDC_CLIENT_SECRET",
  ]);
  assert.deepEqual(world.schedulerJobs.map((job) => job.state), ["PAUSED"]);
  assert.deepEqual(world.services, []);
  // Every mutation named the production project and nothing else.
  const mutations = gcloud.calls.filter((call) => operations.classifyGcloudCommand(call) === "mutate");
  assert.ok(mutations.length > 0);
  for (const call of mutations) {
    assert.ok(call.includes("--project=tibotattle-prod") || call.includes("tibotattle-prod"), call.join(" "));
    assert.doesNotMatch(call.join(" "), LEFT_OUT);
    assert.doesNotMatch(call.join(" "), /tibotattle-test|staging/u);
  }
});
