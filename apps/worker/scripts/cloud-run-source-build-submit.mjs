#!/usr/bin/env node

/**
 * Submit the reviewed Cloud Run host archive directly as a regional Cloud
 * Build source. This deliberately avoids `gcloud builds submit`, which stages
 * source through the caller's default Cloud Build bucket.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GCP_PRIVATE_TEST_BUILD,
  GCP_PRIVATE_TEST_TARGET,
} from "./gcp-private-test-deploy.mjs";
import { createCloudRunBuildArchive } from "./cloud-run-build-archive.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;
const GENERATION = /^[1-9]\d{0,19}$/u;
const BUILD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const OPERATION_NAME = /^[A-Za-z0-9._/-]{1,512}$/u;
const CLOUD_BUILD_API_URL = "https://cloudbuild.googleapis.com/v1/projects/tibotattle/locations/us-east1/builds?projectId=tibotattle";
const BUILD_CONFIG_MEMBER = "apps/worker/cloud-run/cloudbuild.yaml";
const BUILD_CONFIG_TEXT = [
  "steps:",
  `  - name: ${GCP_PRIVATE_TEST_BUILD.dockerBuilderImage}`,
  "    args:",
  "      - build",
  "      - --file=apps/worker/cloud-run/Dockerfile",
  "      - --tag=${_IMAGE}",
  "      - .",
  "images:",
  "  - ${_IMAGE}",
  "options:",
  "  logging: CLOUD_LOGGING_ONLY",
  "  sourceProvenanceHash: [SHA256]",
  "  requestedVerifyOption: VERIFIED",
  `serviceAccount: ${GCP_PRIVATE_TEST_BUILD.serviceAccount}`,
  "substitutions:",
  `  _IMAGE: ${GCP_PRIVATE_TEST_BUILD.imageTag}`,
  "",
].join("\n");
const EXPECTED_BUILD_CONFIG_BYTES = Buffer.from(BUILD_CONFIG_TEXT, "utf8");
const CLOUD_BUILD_FIELDS = new Set([
  "name", "id", "projectId", "status", "statusDetail", "source", "steps",
  "results", "createTime", "startTime", "finishTime", "timeout", "images",
  "queueTtl", "artifacts", "logsBucket", "sourceProvenance", "buildTriggerId",
  "options", "logUrl", "substitutions", "tags", "secrets", "timing", "approval",
  "serviceAccount", "availableSecrets", "warnings", "gitConfig", "failureInfo",
  "dependencies",
]);
const UNCONFIGURED_BUILD_FIELDS = Object.freeze([
  "buildTriggerId", "tags", "secrets", "availableSecrets", "approval", "gitConfig",
  "dependencies",
]);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return isRecord(value) && Object.keys(value).every((key) => keys.has(key));
}

function exactRecord(value, expected) {
  return isRecord(value) && Object.keys(value).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function parseArguments(argv) {
  const allowed = new Set([
    "--archive", "--archive-sha256", "--source-digest", "--source-bucket",
    "--source-object", "--source-generation", "--build-config", "--build-config-sha256",
  ]);
  const values = new Map();
  for (const argument of argv) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) fail("CLOUD_BUILD_SOURCE_ARGUMENT_INVALID");
    const key = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (!allowed.has(key) || value.length === 0 || values.has(key)) {
      fail("CLOUD_BUILD_SOURCE_ARGUMENT_INVALID");
    }
    values.set(key, value);
  }
  if (values.size !== allowed.size) fail("CLOUD_BUILD_SOURCE_ARGUMENTS_REQUIRED");
  return Object.freeze({
    archivePath: values.get("--archive"),
    archiveSha256: values.get("--archive-sha256"),
    sourceDigest: values.get("--source-digest"),
    sourceBucket: values.get("--source-bucket"),
    sourceObject: values.get("--source-object"),
    sourceGeneration: values.get("--source-generation"),
    buildConfigPath: values.get("--build-config"),
    buildConfigSha256: values.get("--build-config-sha256"),
  });
}

function validateInputs(config) {
  if (!isRecord(config)
      || typeof config.archivePath !== "string" || config.archivePath.length === 0
      || !DIGEST.test(config.archiveSha256 ?? "")
      || !DIGEST.test(config.sourceDigest ?? "")
      || config.sourceBucket !== GCP_PRIVATE_TEST_TARGET.buildBucket
      || config.sourceObject !== GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix
        + config.sourceDigest + "-" + config.archiveSha256 + ".tar.gz"
      || !GENERATION.test(config.sourceGeneration ?? "")
      || typeof config.buildConfigPath !== "string"
      || resolve(config.buildConfigPath) !== resolve(config.archivePath + ".cloudbuild.yaml")
      || config.buildConfigSha256 !== GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256) {
    fail("CLOUD_BUILD_SOURCE_INPUTS_UNQUALIFIED");
  }
}

async function readBoundedFile(path, maxBytes, errorCode) {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || before.size <= 0 || before.size > maxBytes) {
      fail(errorCode);
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1
        || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.size > maxBytes) {
      fail(errorCode);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== opened.size || after.size !== opened.size
        || after.dev !== opened.dev || after.ino !== opened.ino) {
      fail(errorCode);
    }
    return bytes;
  } catch (error) {
    if (error?.code === errorCode) throw error;
    fail(errorCode);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function validateLocalArchive(config, archiveBuilder) {
  let canonical;
  try {
    canonical = await archiveBuilder();
  } catch {
    fail("CLOUD_BUILD_SOURCE_CANONICAL_ARCHIVE_UNAVAILABLE");
  }
  const archiveBytes = await readBoundedFile(
    resolve(config.archivePath), MAX_ARCHIVE_BYTES, "CLOUD_BUILD_SOURCE_ARCHIVE_UNSAFE",
  );
  const configBytes = await readBoundedFile(
    resolve(config.buildConfigPath), 1024 * 1024, "CLOUD_BUILD_SOURCE_CONFIG_UNSAFE",
  );
  const observedArchiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const observedConfigSha256 = createHash("sha256").update(configBytes).digest("hex");
  if (!Buffer.isBuffer(canonical?.bytes)
      || !Buffer.isBuffer(canonical?.cloudBuildConfigBytes)
      || canonical.sourceContentDigest !== config.sourceDigest
      || canonical.sourceArchiveSha256 !== config.archiveSha256
      || canonical.cloudBuildConfigSha256 !== GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256
      || observedArchiveSha256 !== config.archiveSha256
      || !archiveBytes.equals(canonical.bytes)
      || observedConfigSha256 !== config.buildConfigSha256
      || !configBytes.equals(canonical.cloudBuildConfigBytes)
      || !configBytes.equals(EXPECTED_BUILD_CONFIG_BYTES)) {
    fail("CLOUD_BUILD_SOURCE_ARCHIVE_OR_CONFIG_MISMATCH");
  }
  return Object.freeze({
    archiveBytes,
    sourceContentDigest: canonical.sourceContentDigest,
    sourceArchiveSha256: observedArchiveSha256,
    cloudBuildConfigSha256: observedConfigSha256,
  });
}

function createBuildRequest(config) {
  return Object.freeze({
    source: Object.freeze({
      storageSource: Object.freeze({
        bucket: config.sourceBucket,
        object: config.sourceObject,
        generation: config.sourceGeneration,
      }),
    }),
    steps: Object.freeze([Object.freeze({
      name: GCP_PRIVATE_TEST_BUILD.dockerBuilderImage,
      args: Object.freeze([
        "build",
        "--file=apps/worker/cloud-run/Dockerfile",
        "--tag=${_IMAGE}",
        ".",
      ]),
    })]),
    images: Object.freeze(["${_IMAGE}"]),
    options: Object.freeze({
      logging: "CLOUD_LOGGING_ONLY",
      sourceProvenanceHash: Object.freeze(["SHA256"]),
      requestedVerifyOption: "VERIFIED",
    }),
    serviceAccount: GCP_PRIVATE_TEST_BUILD.serviceAccount,
    substitutions: Object.freeze({ _IMAGE: GCP_PRIVATE_TEST_BUILD.imageTag }),
    // This matches the established gcloud submission contract; it is an
    // explicit request setting, while the canonical config hash binds YAML.
    timeout: "1200s",
  });
}

function validateCreatedOperation(operation, config) {
  if (!hasOnlyKeys(operation, new Set(["name", "metadata", "done"]))
      || typeof operation.name !== "string" || !OPERATION_NAME.test(operation.name)
      || (operation.done !== undefined && operation.done !== false)
      || !exactRecord(operation.metadata, {
        "@type": "type.googleapis.com/google.devtools.cloudbuild.v1.BuildOperationMetadata",
        build: operation.metadata?.build,
      })
      || !hasOnlyKeys(operation.metadata.build, CLOUD_BUILD_FIELDS)) {
    fail("CLOUD_BUILD_SOURCE_CREATE_RESPONSE_UNEXPECTED");
  }
  const build = operation.metadata.build;
  const allowedBuildNames = new Set([
    `projects/${GCP_PRIVATE_TEST_TARGET.project}/locations/${GCP_PRIVATE_TEST_TARGET.region}/builds/${build.id}`,
    `projects/${GCP_PRIVATE_TEST_TARGET.projectNumber}/locations/${GCP_PRIVATE_TEST_TARGET.region}/builds/${build.id}`,
  ]);
  const source = build.source?.storageSource;
  const step = Array.isArray(build.steps) && build.steps.length === 1 ? build.steps[0] : null;
  const allowedOptions = isRecord(build.options)
    && hasOnlyKeys(build.options, new Set([
      "logging", "sourceProvenanceHash", "requestedVerifyOption", "pool",
    ]))
    && build.options.logging === "CLOUD_LOGGING_ONLY"
    && Array.isArray(build.options.sourceProvenanceHash)
    && build.options.sourceProvenanceHash.length === 1
    && build.options.sourceProvenanceHash[0] === "SHA256"
    && build.options.requestedVerifyOption === "VERIFIED"
    && (build.options.pool === undefined || exactRecord(build.options.pool, {}));
  const stepArgs = [
    "build",
    "--file=apps/worker/cloud-run/Dockerfile",
    "--tag=" + GCP_PRIVATE_TEST_BUILD.imageTag,
    ".",
  ];
  const allowedStep = isRecord(step)
    && hasOnlyKeys(step, new Set(["name", "args", "status", "exitCode", "timing", "pullTiming"]))
    && step.name === GCP_PRIVATE_TEST_BUILD.dockerBuilderImage
    && Array.isArray(step.args) && step.args.length === stepArgs.length
    && step.args.every((argument, index) => argument === stepArgs[index])
    && (step.status === undefined || ["QUEUED", "WORKING", "SUCCESS"].includes(step.status))
    && (step.exitCode === undefined || step.exitCode === 0);
  if (!BUILD_ID.test(build.id ?? "")
      || build.projectId !== GCP_PRIVATE_TEST_TARGET.project
      || !allowedBuildNames.has(build.name)
      || !["QUEUED", "WORKING", "SUCCESS"].includes(build.status)
      || !exactRecord(build.source, { storageSource: source })
      || !exactRecord(source, {
        bucket: config.sourceBucket,
        object: config.sourceObject,
        generation: config.sourceGeneration,
      })
      || build.serviceAccount !== GCP_PRIVATE_TEST_BUILD.serviceAccount
      || !allowedStep
      || !allowedOptions
      || !Array.isArray(build.images) || build.images.length !== 1
      || build.images[0] !== GCP_PRIVATE_TEST_BUILD.imageTag
      || !exactRecord(build.substitutions, { _IMAGE: GCP_PRIVATE_TEST_BUILD.imageTag })
      || build.timeout !== "1200s"
      || (build.queueTtl !== undefined && build.queueTtl !== "3600s")
      || (build.artifacts !== undefined
        && (!exactRecord(build.artifacts, { images: build.artifacts.images })
          || !Array.isArray(build.artifacts.images)
          || build.artifacts.images.length !== 1
          || build.artifacts.images[0] !== GCP_PRIVATE_TEST_BUILD.imageTag))
      || UNCONFIGURED_BUILD_FIELDS.some((field) => Object.hasOwn(build, field))) {
    fail("CLOUD_BUILD_SOURCE_CREATE_RESPONSE_UNEXPECTED");
  }
  return Object.freeze({ buildId: build.id, operationName: operation.name });
}

function readAccessToken(spawn) {
  let result;
  try {
    result = spawn("gcloud", ["auth", "print-access-token"], {
      cwd: WORKER_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024,
      windowsHide: true,
    });
  } catch {
    fail("CLOUD_BUILD_SOURCE_AUTH_UNAVAILABLE");
  }
  if (result?.status !== 0 || typeof result?.stdout !== "string") {
    fail("CLOUD_BUILD_SOURCE_AUTH_UNAVAILABLE");
  }
  const token = result.stdout.trim();
  if (token.length === 0 || token.length > 16 * 1024 || !/^[\x21-\x7e]+$/u.test(token)) {
    fail("CLOUD_BUILD_SOURCE_AUTH_UNAVAILABLE");
  }
  return token;
}

/** Submit exactly one regional build. There is intentionally no retry. */
export async function submitCloudRunSourceBuild({
  config,
  archiveBuilder = createCloudRunBuildArchive,
  fetchImpl = globalThis.fetch,
  spawn = spawnSync,
} = {}) {
  validateInputs(config);
  if (typeof archiveBuilder !== "function" || typeof fetchImpl !== "function"
      || typeof spawn !== "function") {
    fail("CLOUD_BUILD_SOURCE_DEPENDENCY_INVALID");
  }
  await validateLocalArchive(config, archiveBuilder);
  const requestBody = createBuildRequest(config);
  let token = readAccessToken(spawn);
  try {
    let response;
    try {
      response = await fetchImpl(CLOUD_BUILD_API_URL, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      fail("CLOUD_BUILD_SOURCE_CREATE_REQUEST_FAILED");
    }
    if (!response || response.status !== 200) {
      fail("CLOUD_BUILD_SOURCE_CREATE_REJECTED");
    }
    let operation;
    try {
      operation = await response.json();
    } catch {
      fail("CLOUD_BUILD_SOURCE_CREATE_RESPONSE_INVALID");
    }
    return Object.freeze({
      status: "submitted",
      ...validateCreatedOperation(operation, config),
    });
  } finally {
    token = "";
  }
}

function parseArgs(argv) {
  return parseArguments(argv);
}

async function main() {
  try {
    const result = await submitCloudRunSourceBuild({ config: parseArgs(process.argv.slice(2)) });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({
      status: "error",
      code: typeof error?.code === "string" ? error.code : "CLOUD_BUILD_SOURCE_SUBMIT_FAILED",
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
