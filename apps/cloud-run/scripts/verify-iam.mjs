#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVICE_NAME = "app-usagemonitor-contained";
const PUBLIC_MEMBERS = new Set(["allUsers", "allAuthenticatedUsers"]);
const MAX_POLICY_BINDINGS = 500;
const MAX_BINDING_MEMBERS = 1_000;
const MAX_GCLOUD_OUTPUT_BYTES = 2 * 1024 * 1024;

function fail(code) {
  const error = new Error("Google Cloud IAM verification failed");
  error.code = code;
  throw error;
}

function argument(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) fail("arguments_invalid");
  return argv[index + 1];
}

function boundedBindings(policy) {
  if (!policy || typeof policy !== "object"
      || (policy.bindings !== undefined && !Array.isArray(policy.bindings))) {
    fail("policy_invalid");
  }
  const bindings = policy.bindings ?? [];
  if (bindings.length > MAX_POLICY_BINDINGS) fail("policy_invalid");
  return bindings.map((binding) => {
    if (!binding || typeof binding !== "object"
        || typeof binding.role !== "string"
        || binding.role.length < 1
        || binding.role.length > 160
        || !Array.isArray(binding.members)
        || binding.members.length > MAX_BINDING_MEMBERS
        || binding.members.some((member) =>
          typeof member !== "string"
          || member.length < 1
          || member.length > 320)) {
      fail("policy_invalid");
    }
    return {
      role: binding.role,
      members: binding.members,
      conditional: binding.condition !== undefined,
    };
  });
}

function publicMemberPresent(bindings) {
  return bindings.some((binding) =>
    binding.members.some((member) => PUBLIC_MEMBERS.has(member)));
}

export function verifyIamPolicies({
  runPolicy,
  bucketPolicy,
  projectPolicy,
  serviceAccount,
}) {
  if (typeof serviceAccount !== "string"
      || !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/u
        .test(serviceAccount)) {
    fail("service_account_invalid");
  }
  const runtimeMember = `serviceAccount:${serviceAccount}`;
  const runBindings = boundedBindings(runPolicy);
  const bucketBindings = boundedBindings(bucketPolicy);
  const projectBindings = boundedBindings(projectPolicy);
  if (publicMemberPresent(runBindings)
      || publicMemberPresent(bucketBindings)
      || publicMemberPresent(projectBindings)) {
    fail("public_access_detected");
  }
  const bucketRoles = bucketBindings.filter((binding) =>
    binding.members.includes(runtimeMember));
  if (bucketRoles.length !== 1
      || bucketRoles[0].role !== "roles/storage.objectUser"
      || bucketRoles[0].conditional) {
    fail("bucket_scope_invalid");
  }
  if (projectBindings.some((binding) =>
    binding.members.includes(runtimeMember))) {
    fail("project_scope_too_broad");
  }
  return Object.freeze({
    schemaVersion: "contained-gcp-iam-verification-v0.1",
    status: "passed",
    service: SERVICE_NAME,
    directPublicInvoker: false,
    directBucketPublicAccess: false,
    directProjectPublicAccess: false,
    bucketRuntimeRole: "roles/storage.objectUser",
    directProjectRuntimeRoles: 0,
  });
}

function gcloudJson(args) {
  const result = spawnSync("gcloud", args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: MAX_GCLOUD_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0
      || Buffer.byteLength(result.stdout ?? "") > MAX_GCLOUD_OUTPUT_BYTES) {
    fail("gcloud_read_failed");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("gcloud_response_invalid");
  }
}

export function verifyLiveIam({
  project,
  region,
  bucket,
  serviceAccount,
}) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project)
      || !/^[a-z]+-[a-z]+[0-9]$/u.test(region)
      || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/u.test(bucket)) {
    fail("arguments_invalid");
  }
  return verifyIamPolicies({
    serviceAccount,
    runPolicy: gcloudJson([
      "run",
      "services",
      "get-iam-policy",
      SERVICE_NAME,
      `--region=${region}`,
      `--project=${project}`,
      "--format=json",
    ]),
    bucketPolicy: gcloudJson([
      "storage",
      "buckets",
      "get-iam-policy",
      `gs://${bucket}`,
      `--project=${project}`,
      "--format=json",
    ]),
    projectPolicy: gcloudJson([
      "projects",
      "get-iam-policy",
      project,
      "--format=json",
    ]),
  });
}

if (process.argv[1]
    && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const verified = verifyLiveIam({
      project: argument("--project"),
      region: argument("--region"),
      bucket: argument("--bucket"),
      serviceAccount: argument("--service-account"),
    });
    process.stdout.write(`${JSON.stringify(verified)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: "contained-gcp-iam-verification-error-v0.1",
      status: "failed",
      errorCode: typeof error?.code === "string"
        ? error.code
        : "verification_failed",
    })}\n`);
    process.exitCode = 1;
  }
}
