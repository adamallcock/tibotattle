/**
 * Offline check of the OPS-2 operator CLI (scripts/gcp-infra.mjs): closed
 * arguments, a dry run by default, render with no call, plan and readback
 * through read shapes only, apply only under --authorize and never for the
 * synthetic fixture, OPS-10's `readback --require-clean --environment=<env>`
 * form over the committed desired state, the scheduler probe, and named error
 * codes that never echo gcloud output. The runner is
 * the synthetic in-memory gcloud; PATH is blanked for this process and for
 * the spawned CLI, so no real gcloud can run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { committedDesiredStatePath } from "./gcp-ops-infra-manifest.mjs";
import { classifyGcloudCommand } from "./gcp-ops-infra-operations.mjs";
import { main, parseGcpInfraArgs } from "./gcp-infra.mjs";
import { INFRA_READBACK_ARGV, ROLLOUT_ARGV } from "./gcp-production-rollout.mjs";
import {
  bornBucket,
  createFakeGcloud,
  emptyWorld,
  memoryWriter,
  withCloudBuildBucket,
  withSecretValues,
} from "./fixtures/gcp-ops-infra/fake-gcloud.mjs";
import { unfilledProductionText, unpinnedProductionText } from "./fixtures/gcp-ops-infra/production-unfilled.mjs";

process.env.PATH = "/nonexistent-gcloud-guard";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = dirname(SCRIPTS_ROOT);
const FIXTURE_PATH = join(SCRIPTS_ROOT, "fixtures/gcp-ops-infra/desired-state.synthetic.json");
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf8");
const UNMARKED_PATH = "/synthetic-desired/example-ops-prod1.json";
const UNMARKED_TEXT = FIXTURE_TEXT.replaceAll("synthetic-ops-project", "example-ops-prod1");
const IMAGE = ["--bootstrap-image-digest=" + "c".repeat(64), "--bootstrap-source-commit=" + "d".repeat(40)];
const COMMITTED_PRODUCTION = committedDesiredStatePath("production");
// A cadence for tests that need a set one: the committed production file carries none (round 15, C3).
const SYNTHETIC_CADENCE = "40 6 * * 2";
const COMMITTED_STAGING = committedDesiredStatePath("staging");

/** Reads synthetic files; the committed production path is a synthetic stand-in unless `committed` says otherwise. */
function reader(committed = UNMARKED_TEXT) {
  return (path) => {
    if (path === FIXTURE_PATH) return FIXTURE_TEXT;
    if (path === UNMARKED_PATH) return UNMARKED_TEXT;
    if (path === COMMITTED_PRODUCTION) return committed;
    throw new Error("synthetic: unexpected read");
  };
}

/** The born quarantine bucket, the owner's secrets and (unless `cloudBuild` is false) <project>_cloudbuild. */
function world(project, { cloudBuild = true } = {}) {
  const value = withSecretValues(emptyWorld(), { project, region: "us-east1",
    names: ["IDENTITY_LINK_SECRET", "POSTGRES_RATE_LIMIT_SECRET", "ENVELOPE_PUBLIC_JWK", "ENVELOPE_PRIVATE_JWK"] });
  value.buckets.push(bornBucket({ name: "synthetic-ops-quarantine", location: "US-EAST1" }));
  if (cloudBuild) withCloudBuildBucket(value, { project });
  return value;
}

async function run(argv, { project = "synthetic-ops-project", gcloud, writer = memoryWriter(), readFile = reader(),
  now } = {}) {
  const fake = gcloud ?? createFakeGcloud(world(project), { files: writer.files, project, region: "us-east1" });
  const out = [];
  const err = [];
  const code = await main(argv, {
    runner: fake.runner,
    fetchImpl: async () => { throw new Error("synthetic: no network in this check"); },
    ...(readFile === null ? {} : { readFile }),
    ...(now === undefined ? {} : { now }),
    createSpecWriter: () => writer.create(),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, out: out.join(""), err: err.join(""), calls: fake.calls, fake };
}

test("arguments are closed and dangerous combinations are refused", () => {
  assert.deepEqual(parseGcpInfraArgs(["plan", `--desired-state=${FIXTURE_PATH}`]), {
    command: "plan", desiredStatePath: FIXTURE_PATH, environment: null, bootstrap: null, authorize: null, apply: false,
    requireClean: false, requireCadence: false, receiptPath: null, pauseReceiptPath: null, only: null,
  });
  // OPS-10's preflight argv (ROLLOUT_ARGV.infraReadback): no path, the environment's committed file.
  assert.deepEqual(parseGcpInfraArgs(["readback", "--require-clean", "--environment=production"]), {
    command: "readback", desiredStatePath: null, environment: "production", bootstrap: null, authorize: null,
    apply: false, requireClean: true, requireCadence: false, receiptPath: null, pauseReceiptPath: null, only: null,
  });
  // The cutover's stricter form of the same preflight.
  assert.deepEqual(parseGcpInfraArgs(["readback", "--require-clean", "--require-cadence", "--environment=production"]), {
    command: "readback", desiredStatePath: null, environment: "production", bootstrap: null, authorize: null,
    apply: false, requireClean: true, requireCadence: true, receiptPath: null, pauseReceiptPath: null, only: null,
  });
  const cases = [
    [[], "GCP_INFRA_COMMAND_INVALID"],
    [["destroy", `--desired-state=${FIXTURE_PATH}`], "GCP_INFRA_COMMAND_INVALID"],
    [["plan"], "GCP_INFRA_ARGUMENT_MISSING"],
    [["plan", "--desired-state=relative.json"], "GCP_INFRA_DESIRED_STATE_PATH_INVALID"],
    [["plan", `--desired-state=${FIXTURE_PATH}`, `--desired-state=${FIXTURE_PATH}`], "GCP_INFRA_ARGUMENT_INVALID"],
    [["plan", `--desired-state=${FIXTURE_PATH}`, "--authorize=" + "a".repeat(64)], "GCP_INFRA_ARGUMENT_INVALID"],
    [["plan", `--desired-state=${FIXTURE_PATH}`, "--apply"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["readback", `--desired-state=${FIXTURE_PATH}`, ...IMAGE], "GCP_INFRA_ARGUMENT_INVALID"],
    [["plan", `--desired-state=${FIXTURE_PATH}`, IMAGE[0]], "BOOTSTRAP_IMAGE_INVALID"],
    [["plan", `--desired-state=${FIXTURE_PATH}`, "--bootstrap-image-digest=latest", IMAGE[1]], "BOOTSTRAP_IMAGE_INVALID"],
    [["apply", `--desired-state=${FIXTURE_PATH}`], "APPLY_AUTHORIZATION_REQUIRED"],
    [["apply", `--desired-state=${FIXTURE_PATH}`, "--authorize"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["bucket-birth", `--desired-state=${FIXTURE_PATH}`, "--apply"], "BUCKET_BIRTH_AUTHORIZATION_MISMATCH"],
    [["bucket-birth", `--desired-state=${FIXTURE_PATH}`, "--authorize=bucket-birth:x:y"], "BUCKET_BIRTH_AUTHORIZATION_MISMATCH"],
    [["bucket-birth", `--desired-state=${FIXTURE_PATH}`, "--receipt-out=/synthetic/receipt.json"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["bucket-birth", `--desired-state=${FIXTURE_PATH}`, "--apply", "--authorize=bucket-birth:x:y",
      "--receipt-out=relative.json"], "BUCKET_BIRTH_RECEIPT_PATH_INVALID"],
    [["plan", `--desired-state=${FIXTURE_PATH}`, "--force"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["readback"], "GCP_INFRA_ARGUMENT_MISSING"],
    [["readback", "--require-clean"], "GCP_INFRA_ARGUMENT_MISSING"],
    [["readback", "--environment=test"], "GCP_INFRA_ENVIRONMENT_INVALID"],
    [["readback", "--environment="], "GCP_INFRA_ARGUMENT_INVALID"],
    [["readback", "--environment=production", "--environment=staging"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["readback", "--environment=production", "--require-clean", "--require-clean"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["readback", "--environment=production", "--require-clean=yes"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["plan", "--environment=production", "--require-clean"], "GCP_INFRA_ARGUMENT_INVALID"],
    // --require-cadence strengthens --require-clean and means nothing without it, or on any other command.
    [["readback", "--environment=production", "--require-cadence"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["readback", "--environment=production", "--require-clean", "--require-cadence", "--require-cadence"],
      "GCP_INFRA_ARGUMENT_INVALID"],
    [["readback", "--environment=production", "--require-clean", "--require-cadence=yes"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["plan", "--environment=production", "--require-clean", "--require-cadence"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["apply", "--environment=production", "--require-cadence", "--authorize=" + "a".repeat(64)],
      "GCP_INFRA_ARGUMENT_INVALID"],
    [["apply", "--environment=production", "--require-clean", "--authorize=" + "a".repeat(64)],
      "GCP_INFRA_ARGUMENT_INVALID"],
    // A real change is made only from the committed desired state.
    [["apply", `--desired-state=${FIXTURE_PATH}`, "--authorize=" + "a".repeat(64)],
      "GCP_INFRA_COMMITTED_DESIRED_STATE_REQUIRED"],
    [["apply", "--environment=production", `--desired-state=${UNMARKED_PATH}`, "--authorize=" + "a".repeat(64)],
      "GCP_INFRA_COMMITTED_DESIRED_STATE_REQUIRED"],
    [["bucket-birth", `--desired-state=${FIXTURE_PATH}`, "--apply", "--authorize=bucket-birth:x:y"],
      "GCP_INFRA_COMMITTED_DESIRED_STATE_REQUIRED"],
    [["scheduler-probe"], "GCP_INFRA_ARGUMENT_MISSING"],
    [["scheduler-probe", "--environment=staging", "--require-clean"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["scheduler-probe", "--environment=staging", "--now=2026-10-02T00:00:00Z"], "GCP_INFRA_ARGUMENT_INVALID"],
    // OPS-3: dry runs by default; an applied run needs its digest, a receipt path and the committed state.
    [["pause-all", "--environment=production", "--apply"], "OPS3_AUTHORIZATION_MISMATCH"],
    [["pause-all", "--environment=production", "--authorize=" + "a".repeat(64)], "OPS3_AUTHORIZATION_MISMATCH"],
    [["pause-all", "--environment=production", "--apply", "--authorize=" + "a".repeat(64)],
      "PAUSE_ALL_RECEIPT_PATH_REQUIRED"],
    [["pause-all", "--environment=production", "--receipt-out=/synthetic/pause.json"], "PAUSE_ALL_RECEIPT_PATH_REQUIRED"],
    [["pause-all", "--environment=production", "--apply", "--authorize=" + "a".repeat(64), "--receipt-out=pause.json"],
      "OPS_RECEIPT_PATH_INVALID"],
    [["pause-all", `--desired-state=${UNMARKED_PATH}`, "--apply", "--authorize=" + "a".repeat(64),
      "--receipt-out=/synthetic/pause.json"], "GCP_INFRA_COMMITTED_DESIRED_STATE_REQUIRED"],
    [["pause-all", "--environment=production", "--only=x"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["resume-all", "--environment=production"], "RESUME_ALL_SOURCE_REQUIRED"],
    [["resume-all", "--environment=production", "--only=a,,b"], "RESUME_ALL_ONLY_INVALID"],
    [["resume-all", "--environment=production", "--only=a b"], "RESUME_ALL_ONLY_INVALID"],
    [["resume-all", "--environment=production", "--pause-receipt=pause.json"], "PAUSE_ALL_RECEIPT_PATH_INVALID"],
    [["resume-all", "--environment=production", "--only=a", "--apply"], "OPS3_AUTHORIZATION_MISMATCH"],
    [["resume-all", "--environment=production", "--only=a", "--receipt-out=/synthetic/r.json"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["resume-all", `--desired-state=${UNMARKED_PATH}`, "--only=a", "--apply", "--authorize=" + "a".repeat(64)],
      "GCP_INFRA_COMMITTED_DESIRED_STATE_REQUIRED"],
  ];
  for (const [argv, code] of cases) {
    assert.throws(() => parseGcpInfraArgs(argv), { code }, argv.join(" "));
  }
});

test("render makes no call and shows the estate", async () => {
  const result = await run(["render", `--desired-state=${FIXTURE_PATH}`]);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  const rendered = JSON.parse(result.out);
  assert.equal(rendered.schema, "tibotattle-gcp-ops-infra-render-v1");
  assert.equal(rendered.synthetic, true);
  assert.equal(rendered.connectionBudget.total, 84);
  assert.deepEqual(rendered.service, { unavailable: "BOOTSTRAP_IMAGE_REQUIRED" });
  // The refresh trigger waits for the owner's cadence; the maintenance trigger's is pinned, so its flags render.
  assert.deepEqual(Object.keys(rendered.scheduler), ["analytics-refresh", "maintenance"]);
  assert.deepEqual(rendered.scheduler["analytics-refresh"], { unavailable: "SCHEDULER_CADENCE_UNSET" });
  assert.ok(rendered.scheduler.maintenance.includes("--schedule=* * * * *"));
  assert.ok(rendered.scheduler.maintenance.includes("--max-retry-attempts=0"));
  assert.deepEqual(Object.keys(rendered.jobs), ["production-migrate", "analytics-refresh", "maintenance"]);
  assert.deepEqual(rendered.verifierIam, { account: "synthetic-verifier@synthetic-ops-project.iam.gserviceaccount.com",
    role: "roles/iam.serviceAccountTokenCreator", members: ["group:synthetic-operators@example.com"] });
  // BUILD-SOURCE: the project's default Cloud Build bucket, its create when absent and the builder's one role on it.
  assert.deepEqual(rendered.buildSource, {
    bucket: "synthetic-ops-project_cloudbuild",
    sourceDir: "gs://synthetic-ops-project_cloudbuild/source",
    createArgs: ["storage", "buckets", "create", "gs://synthetic-ops-project_cloudbuild",
      "--project=synthetic-ops-project", "--location=us-east1", "--uniform-bucket-level-access",
      "--public-access-prevention"],
    readerBinding: { role: "roles/storage.objectViewer",
      member: "serviceAccount:synthetic-builder@synthetic-ops-project.iam.gserviceaccount.com", condition: null },
  });
  const withImage = JSON.parse((await run(["render", `--desired-state=${FIXTURE_PATH}`, ...IMAGE])).out);
  assert.equal(withImage.service.kind, "Service");
  assert.equal(withImage.jobs["production-migrate"].kind, "Job");
  // The analytics-refresh job renders the production refresh-job contract.
  assert.deepEqual(withImage.jobs["analytics-refresh"].spec.template.spec.template.spec.containers[0].args,
    ["--max-old-space-size=12288", "dist/analytics-refresh.mjs", "--mode=full"]);
  // The maintenance job renders C-MAINT's job contract (D-OPS4), secrets by reference only.
  assert.deepEqual(withImage.jobs.maintenance.spec.template.spec.template.spec.containers[0].args,
    ["dist/postgres-maintenance-job.mjs", "--profile=maintenance-job"]);
  assert.deepEqual(withImage.jobs.maintenance.spec.template.spec.template.spec.containers[0].env
    .filter((entry) => entry.valueFrom !== undefined).map((entry) => entry.name), ["IDENTITY_LINK_SECRET"]);
  assert.doesNotMatch(JSON.stringify(withImage), /LEDGER|ERASURE_BUCKET_HISTORY_PROOF/u);
  // OD-2: the service carries the quarantine bucket's pinned birth proof.
  assert.match(JSON.stringify(withImage), /GCS_QUARANTINE_BUCKET_HISTORY_PROOF/u);
});

test("readback and plan issue read shapes only and the plan is a dry run", async () => {
  const readback = await run(["readback", `--desired-state=${FIXTURE_PATH}`]);
  assert.equal(readback.code, 0, readback.err);
  assert.ok(readback.calls.length > 0);
  assert.ok(readback.calls.every((argv) => classifyGcloudCommand(argv) === "read"));
  const first = await run(["plan", `--desired-state=${FIXTURE_PATH}`, ...IMAGE]);
  const second = await run(["plan", `--desired-state=${FIXTURE_PATH}`, ...IMAGE]);
  assert.equal(first.code, 0, first.err);
  assert.ok(first.calls.every((argv) => classifyGcloudCommand(argv) === "read"));
  assert.equal(JSON.parse(first.out).planDigest, JSON.parse(second.out).planDigest);
  assert.equal(first.calls.map((argv) => argv.join(" ")).join("\n").includes("versions access"), false);
  // A plan that apply would refuse exits 2.
  const stale = createFakeGcloud(world("synthetic-ops-project"), { project: "synthetic-ops-project", region: "us-east1" });
  stale.world.buckets[0].metageneration = "2";
  const refused = await run(["plan", `--desired-state=${FIXTURE_PATH}`, ...IMAGE], { gcloud: stale });
  assert.equal(refused.code, 2);
  assert.deepEqual(JSON.parse(refused.out).findings, ["BUCKET_PROOF_STALE"]);
});

test("apply refuses the synthetic fixture before any call, and runs an authorized plan otherwise", async () => {
  const plan = JSON.parse((await run(["plan", `--desired-state=${FIXTURE_PATH}`, ...IMAGE])).out);
  // Apply reads only the committed desired state, and a synthetic one is never committed.
  const refused = await run(["apply", "--environment=production", `--authorize=${plan.planDigest}`, ...IMAGE],
    { readFile: reader(FIXTURE_TEXT) });
  assert.equal(refused.code, 1);
  assert.deepEqual(JSON.parse(refused.err), { status: "error", code: "COMMITTED_DESIRED_STATE_SYNTHETIC" });
  assert.equal(refused.calls.length, 0);
  assert.equal(refused.out, "");

  const project = "example-ops-prod1";
  const writer = memoryWriter();
  const gcloud = createFakeGcloud(world(project), { files: writer.files, project, region: "us-east1" });
  const unmarked = JSON.parse((await run(["plan", `--desired-state=${UNMARKED_PATH}`, ...IMAGE], { gcloud })).out);
  gcloud.calls.length = 0;
  const stale = await run(["apply", "--environment=production", `--authorize=${"0".repeat(64)}`, ...IMAGE],
    { gcloud });
  assert.deepEqual(JSON.parse(stale.err), { status: "error", code: "APPLY_PLAN_DIGEST_MISMATCH" });
  assert.ok(gcloud.calls.every((argv) => classifyGcloudCommand(argv) === "read"));
  gcloud.calls.length = 0;
  const applied = await run(["apply", "--environment=production", `--authorize=${unmarked.planDigest}`, ...IMAGE],
    { gcloud, writer });
  assert.equal(applied.code, 0, applied.err);
  const receipt = JSON.parse(applied.out);
  assert.equal(receipt.planDigest, unmarked.planDigest);
  assert.equal(receipt.remaining.executable, 0);
  assert.ok(gcloud.calls.some((argv) => classifyGcloudCommand(argv) === "mutate"));
  // A failed step is reported with what ran, never with gcloud output.
  const failing = createFakeGcloud(world(project), { project, region: "us-east1",
    failWhen: (argv) => argv[0] === "iam" && argv[2] === "create" });
  const failingPlan = JSON.parse((await run(["plan", `--desired-state=${UNMARKED_PATH}`, ...IMAGE],
    { gcloud: failing })).out);
  const broken = await run(["apply", "--environment=production", `--authorize=${failingPlan.planDigest}`, ...IMAGE],
    { gcloud: failing });
  assert.equal(broken.code, 1);
  const error = JSON.parse(broken.err);
  assert.equal(error.code, "APPLY_OPERATION_FAILED");
  assert.equal(error.operation, "service-account:create:runtime");
  assert.deepEqual(error.outcomes, [{ id: "service-account:create:runtime", outcome: "failed" }]);
  assert.equal(broken.err.includes("MARKER"), false);
});

test("readback --require-clean --environment is OPS-10's preflight: exit 0 only when clean", async () => {
  const project = "example-ops-prod1";
  // Exactly the argv OPS-10's rollout runs (from apps/worker), less `node <script>`.
  const rolloutArgv = ROLLOUT_ARGV.infraReadback("production");
  assert.deepEqual(rolloutArgv.slice(0, 2), ["node", "scripts/gcp-infra.mjs"]);
  assert.deepEqual(rolloutArgv.slice(0, INFRA_READBACK_ARGV.length), [...INFRA_READBACK_ARGV]);
  const preflight = rolloutArgv.slice(2);
  assert.deepEqual(preflight, ["readback", "--require-clean", "--environment=production"]);
  const writer = memoryWriter();
  const gcloud = createFakeGcloud(world(project), { files: writer.files, project, region: "us-east1" });
  // An estate apply has not built yet is not clean.
  const empty = await run(preflight, { gcloud });
  assert.equal(empty.code, 2, empty.err);
  const dirty = JSON.parse(empty.out);
  assert.equal(dirty.schema, "tibotattle-gcp-ops-infra-clean-v1");
  assert.equal(dirty.clean, false);
  assert.ok(dirty.reasons.includes("EXECUTABLE:cloud-sql:create"));
  assert.ok(gcloud.calls.every((argv) => classifyGcloudCommand(argv) === "read"));
  // Converge it, then the preflight passes; the readback is carried for OPS-10's digest.
  const plan = JSON.parse((await run(["plan", "--environment=production", ...IMAGE], { gcloud })).out);
  assert.equal((await run(["apply", "--environment=production", `--authorize=${plan.planDigest}`, ...IMAGE],
    { gcloud, writer })).code, 0);
  gcloud.calls.length = 0;
  const clean = await run(preflight, { gcloud });
  assert.equal(clean.code, 0, clean.out);
  const verdict = JSON.parse(clean.out);
  assert.deepEqual([verdict.clean, verdict.reasons, verdict.environment, verdict.project],
    [true, [], "production", project]);
  // Two deferrals: the trigger's create and the scheduler's executor grant, both waiting on the cadence.
  assert.deepEqual(verdict.summary, { executable: 0, deferred: 2, refused: 0 });
  assert.equal(verdict.readback.schema, "tibotattle-gcp-ops-infra-readback-v1");
  assert.ok(gcloud.calls.every((argv) => classifyGcloudCommand(argv) === "read"));
  // The cutover's stricter form refuses the unset cadence the rollout accepts; both are read-only.
  gcloud.calls.length = 0;
  const strict = await run([...preflight, "--require-cadence"], { gcloud });
  assert.equal(strict.code, 2, strict.out);
  const strictVerdict = JSON.parse(strict.out);
  assert.deepEqual([strictVerdict.clean, strictVerdict.schema], [false, "tibotattle-gcp-ops-infra-clean-v1"]);
  assert.deepEqual(strictVerdict.reasons, [
    "DEFERRED:scheduler:create:analytics-refresh:SCHEDULER_CADENCE_UNSET",
    `DEFERRED:run-job-iam:analytics-refresh:bind:roles/run.jobsExecutor|serviceAccount:synthetic-scheduler@${
      project}.iam.gserviceaccount.com|:SCHEDULER_CADENCE_UNSET`,
  ]);
  assert.equal(strictVerdict.planDigest, verdict.planDigest);
  assert.ok(gcloud.calls.every((argv) => classifyGcloudCommand(argv) === "read"));
  // The rollout's argv does not carry it: the cadence is measured on the rolled image.
  assert.equal(rolloutArgv.includes("--require-cadence"), false);
  // A running trigger, a stale proof or any drift fails it.
  gcloud.world.buckets[0].metageneration = "2";
  const stale = await run(preflight, { gcloud });
  assert.equal(stale.code, 2);
  assert.deepEqual(JSON.parse(stale.out).reasons, ["FINDING:BUCKET_PROOF_STALE"]);
  // The desired state comes only from the environment's committed file, which must describe it.
  const staging = (path) => (path === COMMITTED_STAGING ? UNMARKED_TEXT : reader()(path));
  for (const [argv, readFile, code] of [
    // A production file whose OWN-5 placeholders are unfilled.
    [preflight, reader(unfilledProductionText()), "DESIRED_STATE_PLACEHOLDER_UNFILLED:project"],
    [preflight, reader("{"), "DESIRED_STATE_UNREADABLE"],
    [["readback", "--require-clean", "--environment=staging"], staging, "GCP_INFRA_ENVIRONMENT_MISMATCH"],
    [["readback", "--environment=staging", `--desired-state=${UNMARKED_PATH}`], reader(), "GCP_INFRA_ENVIRONMENT_MISMATCH"],
  ]) {
    const refused = await run(argv, { gcloud, readFile });
    assert.equal(refused.code, 1, code);
    assert.deepEqual(JSON.parse(refused.err), { status: "error", code }, code);
    assert.equal(refused.out, "", code);
  }
});

test("BUILD-SOURCE: an absent <project>_cloudbuild is reported, created by pass 1 and bound by pass 2", async () => {
  const project = "example-ops-prod1";
  const bucket = `${project}_cloudbuild`;
  const builder = `serviceAccount:synthetic-builder@${project}.iam.gserviceaccount.com`;
  const readerId = `build-source-bucket-iam:bind:roles/storage.objectViewer|${builder}|`;
  const writer = memoryWriter();
  const gcloud = createFakeGcloud(world(project, { cloudBuild: false }), { files: writer.files, project,
    region: "us-east1" });
  const preflight = ["readback", "--require-clean", "--environment=production"];
  // Readback reports the absent bucket (exit 2), and the preflight is not clean.
  const readback = await run(["readback", "--environment=production"], { gcloud });
  assert.equal(readback.code, 2);
  assert.deepEqual(JSON.parse(readback.out).findings, ["BUILD_SOURCE_BUCKET_ABSENT"]);
  assert.equal(JSON.parse(readback.out).observed.buildSource, null);
  // Pass 1 creates the bucket and defers the binding with the closed code.
  const first = JSON.parse((await run(["plan", "--environment=production", ...IMAGE], { gcloud })).out);
  const create = first.operations.find((entry) => entry.id === "build-source-bucket:create");
  assert.deepEqual(create.argv, ["storage", "buckets", "create", `gs://${bucket}`, `--project=${project}`,
    "--location=us-east1", "--uniform-bucket-level-access", "--public-access-prevention"]);
  assert.equal(create.deferred, undefined);
  assert.equal(first.operations.find((entry) => entry.id === readerId).deferred, "BUILD_SOURCE_BUCKET_ABSENT");
  assert.equal((await run(["apply", "--environment=production", `--authorize=${first.planDigest}`, ...IMAGE],
    { gcloud, writer })).code, 0);
  const created = gcloud.world.buckets.find((entry) => entry.name === bucket);
  assert.deepEqual([created.location, created.iamConfiguration], ["US-EAST1",
    { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" }]);
  assert.equal(JSON.stringify(gcloud.world.bucketPolicies[bucket]).includes(builder), false);
  // Between the passes the preflight names the one remaining step.
  const between = JSON.parse((await run(preflight, { gcloud })).out);
  assert.deepEqual(between.reasons, [`EXECUTABLE:${readerId}`]);
  // Pass 2 binds on the bucket readback now lists as the project's own; then it is clean.
  const second = JSON.parse((await run(["plan", "--environment=production"], { gcloud })).out);
  assert.deepEqual(second.operations.filter((entry) => entry.deferred === undefined).map((entry) => entry.id),
    [readerId]);
  assert.equal((await run(["apply", "--environment=production", `--authorize=${second.planDigest}`],
    { gcloud, writer })).code, 0);
  assert.ok(gcloud.world.bucketPolicies[bucket].bindings.some((binding) => binding.role === "roles/storage.objectViewer"
    && binding.members.length === 1 && binding.members[0] === builder));
  const clean = await run(preflight, { gcloud });
  assert.equal(clean.code, 0, clean.out);
});

test("bucket birth is a dry run by default and refuses the synthetic fixture", async () => {
  const dry = await run(["bucket-birth", `--desired-state=${FIXTURE_PATH}`]);
  assert.equal(dry.code, 0);
  assert.equal(JSON.parse(dry.out).status, "dry_run");
  assert.equal(dry.calls.length, 0);
  const refused = await run(["bucket-birth", "--environment=production", "--apply",
    "--authorize=bucket-birth:synthetic-ops-project:synthetic-ops-quarantine"], { readFile: reader(FIXTURE_TEXT) });
  assert.deepEqual(JSON.parse(refused.err), { status: "error", code: "COMMITTED_DESIRED_STATE_SYNTHETIC" });
  assert.equal(refused.calls.length, 0);
});

test("the committed desired states render offline: staging's and production's waits are named", async () => {
  const staging = await run(["render", "--environment=staging", ...IMAGE], { readFile: null, project: "tibotattle" });
  assert.equal(staging.code, 0, staging.err);
  assert.equal(staging.calls.length, 0);
  const rendered = JSON.parse(staging.out);
  assert.deepEqual([rendered.environment, rendered.project, rendered.synthetic], ["staging", "tibotattle", false]);
  // STG-PREP: the owner's Access AUD is committed, so the staging template renders,
  // and the maintenance job renders the staging-maintenance-job profile from the
  // same stagingOrigin block (STAGING-MAINT-RENDER).
  const STAGING_ACCESS_AUD = "b000414465233b6feb03671fa4ec60cfc505d8bc10e435fd77e8fb78656474ad";
  const plainEnv = (container) => Object.fromEntries(container.env.filter((entry) => entry.valueFrom === undefined)
    .map((entry) => [entry.name, entry.value]));
  assert.equal(rendered.service.kind, "Service");
  assert.equal(plainEnv(rendered.service.spec.template.spec.containers[0]).ACCESS_AUD, STAGING_ACCESS_AUD);
  const maintenance = rendered.jobs.maintenance.spec.template.spec.template.spec.containers[0];
  assert.deepEqual(maintenance.args, ["dist/postgres-maintenance-job.mjs", "--profile=staging-maintenance-job"]);
  assert.equal(plainEnv(maintenance).ACCESS_AUD, STAGING_ACCESS_AUD);
  assert.equal(plainEnv(maintenance).ADMIN_HOST_ORIGIN, "https://admin.staging.tibotattle.com");
  // The owner named the staging verifier operator on 2026-10-02.
  assert.deepEqual(rendered.verifierIam, { account: "tibotattle-staging-verifier@tibotattle.iam.gserviceaccount.com",
    role: "roles/iam.serviceAccountTokenCreator", members: ["user:adamallcock@gmail.com"] });
  assert.equal(rendered.jobs["analytics-refresh"].metadata.name, "tibotattle-staging-analytics-refresh");
  assert.equal(rendered.jobs["analytics-refresh"].spec.template.spec.template.spec.containers[0].env
    .find((entry) => entry.name === "ANALYTICS_REFRESH_TARGET").value, "staging");
  assert.doesNotMatch(staging.out, /tibotattle-test|BEGIN PRIVATE KEY/u);
  // PROD-PREP filled production (round 13). Rendered as it reads before the
  // main session pins its versions, proof and namespace, so this holds after them.
  const unpinned = reader(unpinnedProductionText());
  const production = await run(["render", "--environment=production", ...IMAGE], { readFile: unpinned });
  assert.equal(production.code, 0, production.err);
  assert.equal(production.calls.length, 0);
  const prod = JSON.parse(production.out);
  assert.deepEqual([prod.environment, prod.project, prod.region, prod.synthetic], ["production", "tibotattle-prod", "us-east1", false]);
  assert.deepEqual(prod.verifierIam, { account: "tibotattle-verifier@tibotattle-prod.iam.gserviceaccount.com",
    role: "roles/iam.serviceAccountTokenCreator", members: ["user:adamallcock@gmail.com"] });
  assert.deepEqual(prod.service, { unavailable: "TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED" });
  assert.equal(prod.bucket.location, "US-EAST1");
  assert.equal(prod.jobs["analytics-refresh"].metadata.name, "tibotattle-analytics-refresh");
  // Round 15 (C3): the owner decides the refresh cadence after the production-scale
  // measurement, so the committed schedule is null and the trigger is not rendered.
  // D-OPS4's maintenance trigger has its pinned every-minute cadence, so its flags render.
  assert.deepEqual(Object.keys(prod.scheduler), ["analytics-refresh", "maintenance"]);
  assert.deepEqual(prod.scheduler["analytics-refresh"], { unavailable: "SCHEDULER_CADENCE_UNSET" });
  assert.ok(prod.scheduler.maintenance.includes("--schedule=* * * * *"));
  assert.ok(prod.scheduler.maintenance.includes(
    "--uri=https://run.googleapis.com/v2/projects/tibotattle-prod/locations/us-east1/jobs/tibotattle-maintenance:run"));
  // The maintenance job reads the telemetry storage namespace, which this unpinned file leaves unassigned.
  assert.deepEqual(prod.jobs.maintenance, { unavailable: "TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED" });
  // A set cadence still renders its flags. The value is synthetic and lives in this test only.
  const cadenced = JSON.parse(unpinnedProductionText());
  cadenced.scheduler["analytics-refresh"].schedule = SYNTHETIC_CADENCE;
  const scheduled = JSON.parse((await run(["render", "--environment=production", ...IMAGE],
    { readFile: reader(`${JSON.stringify(cadenced, null, 2)}\n`) })).out);
  assert.ok(scheduled.scheduler["analytics-refresh"].includes(`--schedule=${SYNTHETIC_CADENCE}`));
  assert.ok(scheduled.scheduler["analytics-refresh"].includes("--time-zone=Etc/UTC"));
  // Round 12 retired Google and Apple sign-in: no production secret, container or reference names them.
  assert.doesNotMatch(production.out, /GOOGLE_OIDC_CLIENT_SECRET|APPLE_PRIVATE_KEY|tibotattle-test|staging|BEGIN PRIVATE KEY/u);
  // With the namespace pinned, the service waits only for the bucket's birth proof: ROUTES-R12
  // narrowed CR-3 to the committed secrets, so no retired sign-in secret holds it back.
  const named = unpinnedProductionText().replace('"telemetryStorageNamespace": null', '"telemetryStorageNamespace": "synthetic-namespace"');
  const waiting = JSON.parse((await run(["render", "--environment=production", ...IMAGE], { readFile: reader(named) })).out);
  assert.deepEqual(waiting.service, { unavailable: "SERVICE_RENDER_BUCKET_PROOF_UNPINNED" });
  // A production file whose OWN-5 placeholders are unfilled is refused before any call.
  for (const command of ["render", "plan", "readback", "scheduler-probe"]) {
    const unfilled = await run([command, "--environment=production"], { readFile: reader(unfilledProductionText()) });
    assert.equal(unfilled.code, 1, command);
    assert.deepEqual(JSON.parse(unfilled.err), { status: "error", code: "DESIRED_STATE_PLACEHOLDER_UNFILLED:project" });
    assert.equal(unfilled.calls.length, 0, command);
  }
});

test("scheduler-probe reads the triggers once and exits 2 on the paused-too-long signal", async () => {
  const project = "example-ops-prod1";
  const resumed = UNMARKED_TEXT.replace('"schedule": null', '"schedule": "15 3 * * *"')
    .replace('"state": "PAUSED"', '"state": "ENABLED"');
  assert.notEqual(resumed, UNMARKED_TEXT);
  const gcloud = createFakeGcloud(world(project), { project, region: "us-east1" });
  gcloud.world.schedulerJobs.push({ name: `projects/${project}/locations/us-east1/jobs/synthetic-analytics-refresh-trigger`,
    state: "PAUSED", userUpdateTime: "2026-10-02T00:00:00Z" });
  const now = () => Date.parse("2026-10-02T06:30:00Z");
  const alerting = await run(["scheduler-probe", "--environment=production"], { gcloud, readFile: reader(resumed), now });
  assert.equal(alerting.code, 2, alerting.err);
  const probe = JSON.parse(alerting.out);
  assert.equal(probe.signal, "SCHEDULER_TRIGGER_PAUSED_TOO_LONG");
  // The maintenance trigger does not exist in this fake estate and is committed PAUSED: not created yet, no alert.
  assert.deepEqual(probe.triggers.map((entry) => [entry.job, entry.verdict, entry.quietMinutes]),
    [["analytics-refresh", "paused_too_long", 390], ["maintenance", "absent_not_created", null]]);
  assert.deepEqual(gcloud.calls.map((argv) => classifyGcloudCommand(argv)), ["read"]);
  const early = await run(["scheduler-probe", "--environment=production"], { gcloud, readFile: reader(resumed),
    now: () => Date.parse("2026-10-02T05:00:00Z") });
  assert.equal(early.code, 0, early.err);
  // Before OPS-3 resumes it (desired PAUSED), a paused trigger raises nothing.
  const prelaunch = await run(["scheduler-probe", `--desired-state=${UNMARKED_PATH}`], { gcloud, now });
  assert.equal(prelaunch.code, 0, prelaunch.err);
  assert.equal(JSON.parse(prelaunch.out).triggers[0].verdict, "paused_as_desired");
});

test("pause-all and resume-all: dry runs by default, applied only under their digest from the committed state",
  async (t) => {
    const project = "example-ops-prod1";
    const resumed = UNMARKED_TEXT.replace('"schedule": null', '"schedule": "15 3 * * *"')
      .replace('"state": "PAUSED"', '"state": "ENABLED"');
    const gcloud = createFakeGcloud(world(project), { project, region: "us-east1" });
    const runUri = `https://run.googleapis.com/v2/projects/${project}/locations/us-east1/jobs/synthetic-analytics-refresh:run`;
    gcloud.world.schedulerJobs.push({ name: `projects/${project}/locations/us-east1/jobs/synthetic-analytics-refresh-trigger`,
      state: "ENABLED", httpTarget: { uri: runUri } });
    const readFile = reader(resumed);
    const dry = await run(["pause-all", "--environment=production"], { gcloud, readFile });
    assert.equal(dry.code, 0, dry.err);
    const plan = JSON.parse(dry.out);
    assert.deepEqual(plan.triggers.map(({ name, action }) => [name, action]),
      [["synthetic-analytics-refresh-trigger", "pause"]]);
    assert.ok(gcloud.calls.every((argv) => classifyGcloudCommand(argv) === "read"), "the dry run only reads");
    const directory = await mkdtemp(join(tmpdir(), "gcp-infra-ops3-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const receiptPath = join(directory, "pause.json");
    const stale = await run(["pause-all", "--environment=production", "--apply", `--authorize=${"0".repeat(64)}`,
      `--receipt-out=${receiptPath}`], { gcloud, readFile });
    assert.deepEqual([stale.code, JSON.parse(stale.err)], [1, { status: "error", code: "PAUSE_ALL_PLAN_DIGEST_MISMATCH" }]);
    const paused = await run(["pause-all", "--environment=production", "--apply", `--authorize=${plan.planDigest}`,
      `--receipt-out=${receiptPath}`], { gcloud, readFile });
    assert.equal(paused.code, 0, paused.err);
    assert.deepEqual(JSON.parse(paused.out).paused, ["synthetic-analytics-refresh-trigger"]);
    assert.equal(gcloud.world.schedulerJobs[0].state, "PAUSED");
    const resumePlan = await run(["resume-all", "--environment=production", `--pause-receipt=${receiptPath}`],
      { gcloud, readFile });
    assert.equal(resumePlan.code, 0, resumePlan.err);
    const { planDigest, resume } = JSON.parse(resumePlan.out);
    assert.deepEqual(resume, ["synthetic-analytics-refresh-trigger"]);
    assert.equal(gcloud.world.schedulerJobs[0].state, "PAUSED", "the resume plan is a dry run");
    const resumedRun = await run(["resume-all", "--environment=production", `--pause-receipt=${receiptPath}`, "--apply",
      `--authorize=${planDigest}`], { gcloud, readFile });
    assert.equal(resumedRun.code, 0, resumedRun.err);
    assert.equal(gcloud.world.schedulerJobs[0].state, "ENABLED");
    // A missing or tampered receipt is a named refusal.
    const missing = await run(["resume-all", "--environment=production", `--pause-receipt=${join(directory, "none.json")}`],
      { gcloud, readFile });
    assert.deepEqual(JSON.parse(missing.err), { status: "error", code: "PAUSE_ALL_RECEIPT_REQUIRED" });
    await writeFile(join(directory, "tampered.json"), JSON.stringify({ ...JSON.parse(paused.out), paused: [] }));
    const tampered = await run(["resume-all", "--environment=production",
      `--pause-receipt=${join(directory, "tampered.json")}`], { gcloud, readFile });
    assert.deepEqual(JSON.parse(tampered.err), { status: "error", code: "PAUSE_ALL_RECEIPT_INVALID" });
    // A co-tenant-free dedicated estate with a blocking trigger state exits 2 from the dry run.
    gcloud.world.schedulerJobs[0].state = "UPDATE_FAILED";
    assert.equal((await run(["pause-all", "--environment=production"], { gcloud, readFile })).code, 2);
  });

test("a bad desired state is a named error", async () => {
  const result = await run(["plan", "--desired-state=/synthetic-desired/absent.json"]);
  assert.deepEqual(JSON.parse(result.err), { status: "error", code: "DESIRED_STATE_UNREADABLE" });
  assert.equal(result.calls.length, 0);
});

test("the CLI runs through a symlinked path, fails closed and finds no gcloud", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gcp-infra-cli-"));
  try {
    const realPath = join(SCRIPTS_ROOT, "gcp-infra.mjs");
    const linkedPath = join(directory, "gcp-infra.mjs");
    await symlink(realPath, linkedPath);
    const env = { PATH: "/nonexistent-gcloud-guard" };
    for (const entry of [realPath, linkedPath]) {
      const invalid = spawnSync(process.execPath, [entry, "destroy"], { encoding: "utf8", env, cwd: WORKER_ROOT });
      assert.equal(invalid.status, 1, entry);
      assert.equal(invalid.stdout, "", entry);
      assert.deepEqual(JSON.parse(invalid.stderr), { status: "error", code: "GCP_INFRA_COMMAND_INVALID" }, entry);
    }
    // With no gcloud on PATH, a real plan fails closed rather than reporting an empty estate.
    const plan = spawnSync(process.execPath, [realPath, "plan", `--desired-state=${FIXTURE_PATH}`],
      { encoding: "utf8", env, cwd: WORKER_ROOT });
    assert.equal(plan.status, 1);
    assert.deepEqual(JSON.parse(plan.stderr), { status: "error", code: "GCLOUD_CALL_FAILED:iam-service-accounts-list" });
    const render = spawnSync(process.execPath, [realPath, "render", `--desired-state=${FIXTURE_PATH}`],
      { encoding: "utf8", env, cwd: WORKER_ROOT });
    assert.equal(render.status, 0, render.stderr);
    assert.equal(JSON.parse(render.stdout).project, "synthetic-ops-project");
    // A desired state written elsewhere is read from its absolute path.
    const copy = join(directory, "desired.json");
    await writeFile(copy, FIXTURE_TEXT);
    const fromCopy = spawnSync(process.execPath, [realPath, "render", `--desired-state=${copy}`],
      { encoding: "utf8", env, cwd: WORKER_ROOT });
    assert.equal(fromCopy.status, 0, fromCopy.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no OPS-2 module uses a shell, and the package runs exactly these checks", () => {
  for (const name of ["gcp-infra.mjs", "gcp-ops-infra-manifest.mjs", "gcp-ops-infra-operations.mjs",
    "gcp-ops-bucket-birth.mjs", "gcp-staging-desired-state.mjs", "gcp-staging-secrets.mjs", "gcp-staging-bucket-birth.mjs",
    "gcp-scheduler-run-target.mjs", "gcp-ops-monitoring-policies.mjs", "gcp-monitoring.mjs",
    "gcp-identity-link-pin-check.mjs", "gcp-build-source-bucket.mjs"]) {
    const source = readFileSync(join(SCRIPTS_ROOT, name), "utf8");
    // A regular expression's .exec() is not a process call.
    assert.doesNotMatch(source, /\bexecSync\b|(?<![.\w])exec\(|\bexecFile|shell:\s*true|["'`](?:sh|bash|zsh)["'`]/u, name);
    assert.doesNotMatch(source, /postgres-ledger-authority/u, name);
  }
  const scripts = JSON.parse(readFileSync(join(WORKER_ROOT, "package.json"), "utf8")).scripts;
  const gate = scripts["gcp:ops:infra:check"];
  for (const check of ["gcp-ops-infra-manifest.check.mjs", "gcp-ops-infra-operations.check.mjs",
    "gcp-ops-bucket-birth.check.mjs", "gcp-infra.check.mjs", "gcp-ops-infra-staging-service.check.mjs",
    "gcp-ops-infra-production.check.mjs", "gcp-staging-secrets.check.mjs", "gcp-staging-bucket-birth.check.mjs", "gcp-ops-monitoring-policies.check.mjs",
    "gcp-monitoring.check.mjs", "gcp-identity-link-pin-check.check.mjs"]) {
    assert.ok(gate.includes(`./scripts/${check}`), check);
  }
  assert.doesNotMatch(gate, /gcloud|wrangler|--apply|apply /u);
  // BUILD-SOURCE: the shared leaf is syntax-checked by the gate and imports nothing.
  assert.ok(gate.includes("node --check ./scripts/gcp-build-source-bucket.mjs"));
  assert.doesNotMatch(readFileSync(join(SCRIPTS_ROOT, "gcp-build-source-bucket.mjs"), "utf8"), /^import /mu);
});
