import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  GCS_TEST_APPROVED_TARGET,
  buildGcsTestAssetsPlan,
  parsePlanArguments,
} from "./gcs-test-assets-plan.mjs";

const script = fileURLToPath(new URL("./gcs-test-assets-plan.mjs", import.meta.url));

function commandText(argv) {
  return argv.join(" ");
}

test("approved target plan is pure, explicit, private, and keyless", () => {
  const plan = buildGcsTestAssetsPlan(GCS_TEST_APPROVED_TARGET);
  assert.equal(plan.state, "reviewed_target_plan_only");
  assert.equal(plan.remoteActionsAuthorized, false);
  assert.deepEqual(plan.target, GCS_TEST_APPROVED_TARGET);
  assert.equal(plan.targetReview.matchesApprovedCurrentTarget, true);

  const allCommands = [
    ...plan.commands.preflight,
    ...plan.commands.postflight,
    ...plan.commands.createAndConfigure,
    plan.commands.ownerReviewedCallerBindingTemplate,
    plan.commands.keylessToken,
  ];
  for (const argv of allCommands) {
    assert.equal(argv[0], "gcloud");
    assert.equal(argv.some((part) => part === "--project=tibotattle"), true);
  }

  const bucketCreate = plan.commands.createAndConfigure.find(
    (argv) => argv.includes("buckets") && argv.includes("create"),
  );
  assert.deepEqual(bucketCreate.slice(0, 5), [
    "gcloud", "storage", "buckets", "create",
    "gs://tibotattle-gcs-test-release-20260915-a7c92f",
  ]);
  assert.equal(bucketCreate.includes("--location=us-east1"), true);
  assert.equal(bucketCreate.includes("--uniform-bucket-level-access"), true);
  assert.equal(bucketCreate.includes("--public-access-prevention"), true);
  assert.equal(bucketCreate.some((part) => part.startsWith("--soft-delete-duration")), false);

  const binding = plan.commands.createAndConfigure.find(
    (argv) => argv.includes("add-iam-policy-binding"),
  );
  assert.equal(binding.includes("--member=serviceAccount:gcs-adapter-test@tibotattle.iam.gserviceaccount.com"), true);
  assert.equal(binding.includes("--role=roles/storage.objectUser"), true);
  assert.equal(plan.keylessCredentialWorkflow.staticServiceAccountKeys, "forbidden");
  assert.equal(plan.commands.keylessToken.includes("--impersonate-service-account=gcs-adapter-test@tibotattle.iam.gserviceaccount.com"), true);
  assert.equal(plan.commands.keylessToken.includes("--lifetime=1800s"), true);
  assert.match(commandText(plan.commands.ownerReviewedCallerBindingTemplate), /roles\/iam\.serviceAccountTokenCreator/u);
  assert.equal(plan.forbiddenOperations.some((value) => value.includes("keys create")), true);
  assert.equal(plan.forbiddenOperations.includes("terraform"), true);
});

test("custom explicit test targets remain bounded and never use an ambient project", () => {
  const plan = buildGcsTestAssetsPlan({
    project: "other-test-project",
    bucket: "tibotattle-gcs-test-another-01",
    region: "us-west1",
    serviceAccount: "gcs-adapter-test@other-test-project.iam.gserviceaccount.com",
  });
  assert.equal(plan.state, "custom_explicit_test_target_requires_owner_review");
  assert.equal(plan.targetReview.matchesApprovedCurrentTarget, false);
  for (const argv of [...plan.commands.preflight, ...plan.commands.createAndConfigure]) {
    assert.equal(argv.some((part) => part === "--project=other-test-project"), true);
  }
});

test("input validation refuses production-shaped resources and missing fields", () => {
  assert.throws(() => buildGcsTestAssetsPlan({
    ...GCS_TEST_APPROVED_TARGET,
    bucket: "tibotattle-updates",
  }), /INVALID_BUCKET/u);
  assert.throws(() => buildGcsTestAssetsPlan({
    ...GCS_TEST_APPROVED_TARGET,
    serviceAccount: "production@tibotattle.iam.gserviceaccount.com",
  }), /INVALID_SERVICE_ACCOUNT/u);
  assert.throws(() => buildGcsTestAssetsPlan({
    ...GCS_TEST_APPROVED_TARGET,
    serviceAccount: "gcs-adapter-test@other-project.iam.gserviceaccount.com",
  }), /INVALID_SERVICE_ACCOUNT/u);
  assert.throws(() => buildGcsTestAssetsPlan({
    ...GCS_TEST_APPROVED_TARGET,
    region: "not a region",
  }), /INVALID_REGION/u);
  assert.throws(() => parsePlanArguments(["--project", "tibotattle"]), /INVALID_ARGUMENTS/u);
  assert.throws(() => parsePlanArguments([
    "--project", "tibotattle", "--project", "other",
    "--bucket", GCS_TEST_APPROVED_TARGET.bucket,
    "--region", "us-east1",
    "--service-account", GCS_TEST_APPROVED_TARGET.serviceAccount,
  ]), /INVALID_ARGUMENTS/u);
});

test("CLI help and plan are offline and the source has no execution or network primitive", () => {
  const source = readFileSync(script, "utf8");
  assert.doesNotMatch(source, /from ["']node:(?:child_process|http|https|net)["']/u);
  assert.doesNotMatch(source, /\b(?:spawn|execFile|fetch)\s*\(/u);

  const help = spawnSync(process.execPath, [script, "--help"], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 32_768,
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /never authenticates or contacts Google/u);

  const plan = spawnSync(process.execPath, [
    script,
    "--project", GCS_TEST_APPROVED_TARGET.project,
    "--bucket", GCS_TEST_APPROVED_TARGET.bucket,
    "--region", GCS_TEST_APPROVED_TARGET.region,
    "--service-account", GCS_TEST_APPROVED_TARGET.serviceAccount,
  ], { encoding: "utf8", timeout: 5_000, maxBuffer: 256_000 });
  assert.equal(plan.status, 0);
  assert.equal(JSON.parse(plan.stdout).remoteActionsAuthorized, false);
  assert.equal(plan.stderr, "");

  const missing = spawnSync(process.execPath, [script, "--helpful"], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 16_384,
  });
  assert.equal(missing.status, 2);
  assert.deepEqual(JSON.parse(missing.stderr), { status: "failed", code: "INVALID_ARGUMENTS" });
});
