#!/usr/bin/env node

/**
 * Build a reviewable GCS test-asset setup plan. This module is deliberately
 * pure: it never reads gcloud configuration, invokes a command, authenticates,
 * contacts Google, or changes a resource.
 */

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GCS_TEST_ASSETS_PLAN_SCHEMA_VERSION = "gcs-test-assets-plan-v1";
export const GCS_TEST_BUCKET_PREFIX = "tibotattle-gcs-test-";
export const GCS_TEST_SERVICE_ACCOUNT_ID = "gcs-adapter-test";
export const GCS_TEST_APPROVED_TARGET = Object.freeze({
  project: "tibotattle",
  bucket: "tibotattle-gcs-test-release-20260915-a7c92f",
  region: "us-east1",
  serviceAccount: "gcs-adapter-test@tibotattle.iam.gserviceaccount.com",
});

const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const REGION_PATTERN = /^[a-z][a-z0-9-]{1,31}[a-z0-9]$/u;
const SERVICE_ACCOUNT_PATTERN = /^([a-z][a-z0-9-]{5,29})@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/u;
const REQUIRED_APIS = Object.freeze([
  "storage.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
]);
const MAX_BUCKET_LENGTH = 63;
const SOURCES = Object.freeze({
  bucketCreate: "https://cloud.google.com/sdk/gcloud/reference/storage/buckets/create",
  bucketIam: "https://cloud.google.com/sdk/gcloud/reference/storage/buckets/add-iam-policy-binding",
  storageRoles: "https://cloud.google.com/storage/docs/access-control/iam-roles",
  shortLivedCredentials: "https://cloud.google.com/iam/docs/create-short-lived-credentials-direct",
  tokenCommand: "https://cloud.google.com/sdk/gcloud/reference/auth/print-access-token",
});

function command(...argv) {
  return Object.freeze(argv);
}

function fail(code) {
  throw new TypeError(code);
}

function validateText(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function normalizeInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_INPUT");
  }
  const project = validateText(input.project, PROJECT_PATTERN, "INVALID_PROJECT");
  const bucket = validateText(input.bucket, BUCKET_PATTERN, "INVALID_BUCKET");
  if (bucket.length > MAX_BUCKET_LENGTH || !bucket.startsWith(GCS_TEST_BUCKET_PREFIX)
      || bucket.includes("..")) fail("INVALID_BUCKET");
  const region = validateText(input.region, REGION_PATTERN, "INVALID_REGION");
  if (region === "global") fail("INVALID_REGION");
  const serviceAccount = validateText(
    input.serviceAccount,
    SERVICE_ACCOUNT_PATTERN,
    "INVALID_SERVICE_ACCOUNT",
  );
  const match = SERVICE_ACCOUNT_PATTERN.exec(serviceAccount);
  if (match?.[1] !== GCS_TEST_SERVICE_ACCOUNT_ID || match[2] !== project) {
    fail("INVALID_SERVICE_ACCOUNT");
  }
  return Object.freeze({ project, bucket, region, serviceAccount });
}

function explicitProject(project) {
  return `--project=${project}`;
}

function planCommands(target) {
  const projectFlag = explicitProject(target.project);
  const bucketUrl = `gs://${target.bucket}`;
  const accountId = GCS_TEST_SERVICE_ACCOUNT_ID;
  const serviceAccount = target.serviceAccount;
  const preflight = Object.freeze([
    command("gcloud", "services", "list", "--enabled", projectFlag, "--format=json"),
    command("gcloud", "storage", "buckets", "describe", bucketUrl, projectFlag, "--format=json"),
    command("gcloud", "storage", "buckets", "get-iam-policy", bucketUrl, projectFlag, "--format=json"),
    command("gcloud", "iam", "service-accounts", "describe", serviceAccount, projectFlag, "--format=json"),
    command("gcloud", "iam", "service-accounts", "get-iam-policy", serviceAccount, projectFlag, "--format=json"),
    command("gcloud", "iam", "service-accounts", "keys", "list",
      `--iam-account=${serviceAccount}`, "--managed-by=user", projectFlag, "--format=json"),
  ]);
  return Object.freeze({
    preflight,
    postflight: preflight,
    createAndConfigure: Object.freeze([
      command("gcloud", "services", "enable", ...REQUIRED_APIS, projectFlag),
      command("gcloud", "iam", "service-accounts", "create", accountId, projectFlag,
        "--display-name=GCS adapter test", "--description=Short-lived GCS adapter qualification identity"),
      command("gcloud", "storage", "buckets", "create", bucketUrl, projectFlag,
        `--location=${target.region}`, "--default-storage-class=STANDARD",
        "--uniform-bucket-level-access", "--public-access-prevention"),
      command("gcloud", "storage", "buckets", "add-iam-policy-binding", bucketUrl,
        projectFlag, `--member=serviceAccount:${serviceAccount}`, "--role=roles/storage.objectUser"),
    ]),
    ownerReviewedCallerBindingTemplate: command(
      "gcloud", "iam", "service-accounts", "add-iam-policy-binding", serviceAccount,
      projectFlag, "--member=CALLER_PRINCIPAL",
      "--role=roles/iam.serviceAccountTokenCreator",
      "--condition=^|^title=gcs-test-short-lived|description=Owner-reviewed expiry for synthetic GCS test|expression=request.time < timestamp(\"EXPIRY_RFC3339\")",
    ),
    keylessToken: command("gcloud", "auth", "print-access-token", projectFlag,
      `--impersonate-service-account=${serviceAccount}`, "--lifetime=1800s"),
  });
}

export function buildGcsTestAssetsPlan(input) {
  const target = normalizeInput(input);
  const commands = planCommands(target);
  const approvedTarget = JSON.stringify(target) === JSON.stringify(GCS_TEST_APPROVED_TARGET);
  return Object.freeze({
    schemaVersion: GCS_TEST_ASSETS_PLAN_SCHEMA_VERSION,
    state: approvedTarget
      ? "reviewed_target_plan_only"
      : "custom_explicit_test_target_requires_owner_review",
    remoteActionsAuthorized: false,
    target,
    targetReview: Object.freeze({
      approvedCurrentTarget: GCS_TEST_APPROVED_TARGET,
      matchesApprovedCurrentTarget: approvedTarget,
      customTargetsRequireOwnerReview: true,
    }),
    commands,
    sources: SOURCES,
    bucketPostconditions: Object.freeze({
      location: target.region,
      storageClass: "STANDARD",
      uniformBucketLevelAccess: true,
      publicAccessPrevention: "enforced",
      softDelete: Object.freeze({
        action: "preserve_provider_default",
        createFlagOmitted: true,
        minimumRetentionSeconds: 604800,
      }),
      noPublicIamMembers: true,
      serviceAccountBucketRole: "roles/storage.objectUser",
      noProjectLevelStorageGrant: true,
    }),
    keylessCredentialWorkflow: Object.freeze({
      callerBindingRequired: true,
      callerBindingScope: "service-account-only",
      callerBindingRole: "roles/iam.serviceAccountTokenCreator",
      callerBindingCommandIsTemplate: true,
      callerBindingCommandRequirement:
        "Replace CALLER_PRINCIPAL and EXPIRY_RFC3339 only after owner review; do not infer either value.",
      tokenCommand: commands.keylessToken,
      tokenLifetimeSeconds: 1800,
      staticServiceAccountKeys: "forbidden",
      requiredKeyCheck: commands.preflight.at(-1),
      tokenHandling: "capture stdout directly to an owner-only 0600 temporary file; never run the token command visibly, print the token, or persist a service-account key",
    }),
    safetyGates: Object.freeze([
      "Run the read-only preflight first, compare the expected postconditions, and stop if the bucket or service account already exists; create commands are reproducibility recipes only and must not be applied blindly.",
      "Every gcloud command carries an explicit --project flag; no gcloud active-project or ambient project is used.",
      "The create command omits --soft-delete-duration so the provider default remains enabled; verify the resulting policy before use.",
      "Do not add public IAM members, project-level storage roles, service-account keys, bucket updates, bucket deletes, or object cleanup commands to this plan.",
      "The caller Token Creator grant is a separate owner-reviewed, time-bounded prerequisite and is not inferred by this tool.",
    ]),
    forbiddenOperations: Object.freeze([
      "gcloud iam service-accounts keys create",
      "gcloud iam service-accounts keys upload",
      "gcloud storage buckets update",
      "gcloud storage buckets delete",
      "gcloud storage rm",
      "terraform",
    ]),
  });
}

export function parsePlanArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return null;
  const allowed = new Set(["--project", "--bucket", "--region", "--service-account"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined || value.startsWith("--") || values.has(key)) {
      fail("INVALID_ARGUMENTS");
    }
    values.set(key, value);
    index += 1;
  }
  if (values.size !== allowed.size) fail("INVALID_ARGUMENTS");
  return {
    project: values.get("--project"),
    bucket: values.get("--bucket"),
    region: values.get("--region"),
    serviceAccount: values.get("--service-account"),
  };
}

function usage() {
  return "Usage: node apps/worker/scripts/gcs-test-assets-plan.mjs --project <project-id> --bucket <tibotattle-gcs-test-...> --region <region> --service-account <gcs-adapter-test@project.iam.gserviceaccount.com>";
}

async function main() {
  try {
    const input = parsePlanArguments(process.argv.slice(2));
    if (input === null) {
      process.stdout.write(`${usage()}\nThis prints a plan only; it never authenticates or contacts Google.\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(buildGcsTestAssetsPlan(input), null, 2)}\n`);
  } catch (error) {
    const code = typeof error?.message === "string" && /^[A-Z0-9_]+$/u.test(error.message)
      ? error.message : "INVALID_PLAN";
    process.stderr.write(`${JSON.stringify({status: "failed", code})}\n`);
    process.exitCode = 2;
  }
}

const scriptFile = fileURLToPath(import.meta.url);
if (process.argv[1]
    && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(scriptFile).href) {
  await main();
}
