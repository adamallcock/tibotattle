#!/usr/bin/env node

/**
 * GCP test gate for the isolated TiboTattle database service.
 *
 * The target is intentionally fixed to tibotattle/us-east1 and one named test
 * service. Local context checks and read-only Cloud Run assessments remain
 * available. Verify and deploy require a generated local source archive and a
 * matching regional Cloud Build provenance receipt before using an image.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCloudRunBuildArchive } from "./cloud-run-build-archive.mjs";
import {
  buildGcpTestBucketCreateRequest,
  GCP_TEST_BUCKET_HISTORY_RECEIPT_SCHEMA,
  GCP_TEST_BUCKET_HISTORY_TARGET,
} from "./gcp-test-bucket-history.mjs";

export const GCP_PRIVATE_TEST_TARGET = Object.freeze({
  project: "tibotattle",
  projectNumber: "806510610397",
  region: "us-east1",
  service: "tibotattle-test-app",
  hostOrigin: "https://tibotattle-test-app-5t5mehqi7a-ue.a.run.app",
  runtimeServiceAccount: "tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com",
  primaryInstanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
  primaryDatabase: "tibotattle",
  primarySchema: "tibotattle_v12_a2_20260925",
  ledgerInstanceConnectionName: "tibotattle:us-east1:tibotattle-test-ledger-20260922",
  ledgerDatabase: "tibotattle_ledger",
  ledgerSchema: "tibotattle_ledger_v12_a2_20260925",
  postgresIamUser: "tibotattle-test-runtime@tibotattle.iam",
  gcsBucketName: "tibotattle-gcs-test-cleanup-20260925-a2",
  buildBucket: "tibotattle-gcs-test-build-20260922",
  imageRepository:
    "us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host",
});

export const GCP_PRIVATE_TEST_BUILD = Object.freeze({
  serviceAccount:
    "projects/tibotattle/serviceAccounts/tibotattle-test-builder@tibotattle.iam.gserviceaccount.com",
  imageTag: GCP_PRIVATE_TEST_TARGET.imageRepository + ":content-digest-required",
  dockerBuilderImage:
    "gcr.io/cloud-builders/docker@sha256:bbb3d633c5c2813b2ce5245852979e1d637768f4acfc504d8ece288f91e9b60f",
  // Pin only after review; archive creation and provenance qualification check
  // this digest against the exact cloudbuild.yaml tar member.
  cloudBuildConfigSha256: "a6dd372a20429ab6b3e9b11b738514d201c6b5b0ca8e395e6c69bb0b166dbc12",
  sourceObjectPrefix: "source/cloud-run-host-",
});

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_CONTEXT_CHECK = resolve(WORKER_ROOT, "scripts/cloud-run-build-context.mjs");
const DIGEST = /^[a-f0-9]{64}$/u;
const BUILD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_SOURCE_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_BUCKET_HISTORY_RECEIPT_BYTES = 64 * 1024;
const GENERATION = /^[1-9]\d{0,19}$/u;
const CLOUD_BUILD_HASH_TYPES = new Set([
  "SHA256", "MD5", "SHA512", "GO_MODULE_H1", "DIRSUM_SHA256",
]);
const IMAGE_REFERENCE =
  /^us-east1-docker\.pkg\.dev\/tibotattle\/tibotattle-test\/tibotattle-host@sha256:([a-f0-9]{64})$/u;
const HEALTH_PATH = "/api/health";
const V12_CHUNK_PATH = "/api/v1/contributions";

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

export function parseArgs(argv) {
  const command = argv[0] ?? "preflight";
  if (!["preflight", "verify", "deploy"].includes(command)) {
    fail("GCP_PRIVATE_TEST_COMMAND_INVALID");
  }
  const allowed = new Set(["--project", "--region", "--service", "--image",
    "--source-digest", "--build-id", "--source-archive",
    "--source-archive-sha256", "--source-bucket", "--source-object",
    "--source-generation", "--bucket-history-receipt"]);
  const values = new Map();
  for (const argument of argv.slice(1)) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) {
      fail("GCP_PRIVATE_TEST_ARGUMENT_INVALID");
    }
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (!allowed.has(name) || value.length === 0 || values.has(name)) {
      fail("GCP_PRIVATE_TEST_ARGUMENT_INVALID");
    }
    values.set(name, value);
  }
  const config = {
    command,
    project: values.get("--project") ?? GCP_PRIVATE_TEST_TARGET.project,
    region: values.get("--region") ?? GCP_PRIVATE_TEST_TARGET.region,
    service: values.get("--service") ?? GCP_PRIVATE_TEST_TARGET.service,
    image: values.get("--image") ?? "",
    sourceDigest: values.get("--source-digest") ?? "",
    buildId: values.get("--build-id") ?? "",
    sourceArchivePath: values.get("--source-archive") ?? "",
    sourceArchiveSha256: values.get("--source-archive-sha256") ?? "",
    sourceBucket: values.get("--source-bucket") ?? "",
    sourceObject: values.get("--source-object") ?? "",
    sourceGeneration: values.get("--source-generation") ?? "",
    bucketHistoryReceiptPath: values.get("--bucket-history-receipt") ?? "",
  };
  validateConfig(config);
  return Object.freeze(config);
}

export function validateConfig(config) {
  const buildId = config?.buildId ?? "";
  const sourceArchivePath = config?.sourceArchivePath ?? "";
  const sourceArchiveSha256 = config?.sourceArchiveSha256 ?? "";
  const sourceBucket = config?.sourceBucket ?? "";
  const sourceObject = config?.sourceObject ?? "";
  const sourceGeneration = config?.sourceGeneration ?? "";
  const bucketHistoryReceiptPath = config?.bucketHistoryReceiptPath ?? "";
  if (config?.project !== GCP_PRIVATE_TEST_TARGET.project
      || config?.region !== GCP_PRIVATE_TEST_TARGET.region
      || config?.service !== GCP_PRIVATE_TEST_TARGET.service) {
    fail("GCP_PRIVATE_TEST_TARGET_FIXED");
  }
  if (config.command !== "preflight"
      && (typeof bucketHistoryReceiptPath !== "string"
        || !isAbsolute(bucketHistoryReceiptPath))) {
    fail("GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_REQUIRED");
  }
  if (bucketHistoryReceiptPath !== ""
      && (typeof bucketHistoryReceiptPath !== "string" || !isAbsolute(bucketHistoryReceiptPath))) {
    fail("GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_PATH_INVALID");
  }
  if (typeof config.image !== "string" || !IMAGE_REFERENCE.test(config.image)) {
    fail("GCP_PRIVATE_TEST_IMAGE_DIGEST_REQUIRED");
  }
  if (typeof config.sourceDigest !== "string" || !DIGEST.test(config.sourceDigest)) {
    fail("GCP_PRIVATE_TEST_SOURCE_DIGEST_REQUIRED");
  }
  if (buildId !== "" && !BUILD_ID.test(buildId)) {
    fail("GCP_PRIVATE_TEST_BUILD_ID_INVALID");
  }
  if (sourceArchivePath !== "" && typeof sourceArchivePath !== "string") {
    fail("GCP_PRIVATE_TEST_SOURCE_ARCHIVE_PATH_INVALID");
  }
  if (sourceArchiveSha256 !== "" && !DIGEST.test(sourceArchiveSha256)) {
    fail("GCP_PRIVATE_TEST_SOURCE_ARCHIVE_SHA256_INVALID");
  }
  if (sourceBucket !== "" && sourceBucket !== GCP_PRIVATE_TEST_TARGET.buildBucket) {
    fail("GCP_PRIVATE_TEST_SOURCE_BUCKET_UNEXPECTED");
  }
  if (sourceGeneration !== "" && !GENERATION.test(sourceGeneration)) {
    fail("GCP_PRIVATE_TEST_SOURCE_GENERATION_INVALID");
  }
  if (sourceObject !== "" && sourceArchiveSha256 !== ""
      && config.sourceDigest !== "") {
    const expectedObject = GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix
      + config.sourceDigest + "-" + sourceArchiveSha256 + ".tar.gz";
    if (sourceObject !== expectedObject) {
      fail("GCP_PRIVATE_TEST_SOURCE_OBJECT_UNEXPECTED");
    }
  }
  return Object.freeze({
    digest: IMAGE_REFERENCE.exec(config.image)[1],
    sourceDigest: config.sourceDigest,
  });
}

function serviceImage(service) {
  return service?.spec?.template?.spec?.containers?.[0]?.image
    ?? service?.template?.containers?.[0]?.image
    ?? null;
}

function serviceIngress(service) {
  return service?.metadata?.annotations?.["run.googleapis.com/ingress"]
    ?? service?.ingress
    ?? null;
}

function serviceUrl(service) {
  return service?.uri ?? service?.status?.url ?? service?.url ?? null;
}

function serviceAccountName(service) {
  return service?.spec?.template?.spec?.serviceAccountName
    ?? service?.template?.serviceAccount
    ?? null;
}

function readyCondition(service) {
  const terminalCondition = service?.status?.terminalCondition ?? service?.terminalCondition;
  const conditions = service?.status?.conditions ?? service?.conditions ?? [];
  const condition = terminalCondition ?? conditions.find((value) => value?.type === "Ready");
  if (!condition) return false;
  const signals = [];
  if (condition.status !== undefined) signals.push(condition.status === "True");
  if (condition.state !== undefined) {
    signals.push(condition.state === "CONDITION_SUCCEEDED");
  }
  return signals.length > 0 && signals.every(Boolean);
}

function invokerIamCheckEnabled(service) {
  const field = service?.invokerIamDisabled;
  const annotation = service?.metadata?.annotations?.["run.googleapis.com/invoker-iam-disabled"];
  const templateAnnotation = service?.spec?.template?.metadata?.annotations
    ?.["run.googleapis.com/invoker-iam-disabled"];
  const values = [field, annotation, templateAnnotation].filter((value) => value !== undefined);
  if (values.some((value) => value === true || value === "true")) return false;
  if (values.some((value) => value !== false && value !== "false")) return false;
  // Cloud Run enables the Invoker IAM check by default when no disabling field
  // or annotation is present.
  return true;
}

function revisionNameMatches(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftName = left.split("/").at(-1);
  const rightName = right.split("/").at(-1);
  return leftName.length > 0 && leftName === rightName;
}

function serviceGenerationObserved(service) {
  const generation = service?.metadata?.generation ?? service?.generation;
  const observedGeneration = service?.status?.observedGeneration
    ?? service?.observedGeneration;
  if (generation === undefined && observedGeneration === undefined) return true;
  if (generation === undefined || observedGeneration === undefined) return false;
  const normalize = (value) => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === "string" && /^\d+$/u.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
    return null;
  };
  const desired = normalize(generation);
  return desired !== null && desired === normalize(observedGeneration);
}

function routesAllTrafficToLatestReadyRevision(service) {
  const status = service?.status ?? service;
  const latestReady = status?.latestReadyRevisionName ?? status?.latestReadyRevision;
  const latestCreated = status?.latestCreatedRevisionName ?? status?.latestCreatedRevision;
  const traffic = status?.traffic ?? status?.trafficStatuses;
  if (typeof latestReady !== "string" || latestReady.length === 0 || !Array.isArray(traffic)) {
    return false;
  }
  if (!revisionNameMatches(latestCreated, latestReady) || !serviceGenerationObserved(service)) {
    return false;
  }
  if (traffic.some((target) => target === null || typeof target !== "object"
      || !Number.isSafeInteger(target.percent) || target.percent < 0 || target.percent > 100)) {
    return false;
  }
  const activeTargets = traffic.filter((target) =>
    Number.isSafeInteger(target?.percent) && target.percent > 0,
  );
  if (activeTargets.length !== 1 || activeTargets[0].percent !== 100) return false;
  const target = activeTargets[0];
  return target.latestRevision === true
    || revisionNameMatches(target.revisionName, latestReady)
    || revisionNameMatches(target.revision, latestReady);
}

function serviceEnvironment(service) {
  const values = serviceEnvironmentEntries(service);
  return new Map(values
    .filter((value) => typeof value?.name === "string" && typeof value?.value === "string")
    .map((value) => [value.name, value.value]));
}

function serviceEnvironmentEntries(service) {
  const values = service?.spec?.template?.spec?.containers?.[0]?.env
    ?? service?.template?.containers?.[0]?.env
    ?? [];
  return Array.isArray(values) ? values : [];
}

function exactServiceEnvironmentValue(service, name, expected) {
  const matches = serviceEnvironmentEntries(service).filter((entry) => entry?.name === name);
  return matches.length === 1 && exactRecord(matches[0], { name, value: expected });
}

const GCP_PRIVATE_TEST_BACKING_ENVIRONMENT = Object.freeze({
  PRIMARY_INSTANCE_CONNECTION_NAME: GCP_PRIVATE_TEST_TARGET.primaryInstanceConnectionName,
  PRIMARY_DATABASE: GCP_PRIVATE_TEST_TARGET.primaryDatabase,
  PRIMARY_SCHEMA: GCP_PRIVATE_TEST_TARGET.primarySchema,
  LEDGER_INSTANCE_CONNECTION_NAME: GCP_PRIVATE_TEST_TARGET.ledgerInstanceConnectionName,
  LEDGER_DATABASE: GCP_PRIVATE_TEST_TARGET.ledgerDatabase,
  LEDGER_SCHEMA: GCP_PRIVATE_TEST_TARGET.ledgerSchema,
  GCS_BUCKET_NAME: GCP_PRIVATE_TEST_TARGET.gcsBucketName,
});
const GCP_PRIVATE_TEST_PREVIOUS_BACKING_ENVIRONMENT = Object.freeze({
  ...GCP_PRIVATE_TEST_BACKING_ENVIRONMENT,
  PRIMARY_SCHEMA: "tibotattle",
  LEDGER_SCHEMA: "tibotattle_ledger",
  GCS_BUCKET_NAME: "tibotattle-gcs-test-app-20260922",
});

const ALTERNATE_DATABASE_CREDENTIAL_ENVIRONMENT_NAME = /^(?:(?:DATABASE|DB|PRIMARY|LEDGER|POSTGRES|PG)(?:_.*)?_(?:URL|URI|PASSWORD|PASS|PASSFILE|CREDENTIALS?|CONNECTION_STRING|USER)|DATABASE_URL|DB_URL|PGPASSWORD|PGUSER|PGPASSFILE|PGSERVICE|PGSERVICEFILE|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE)$/u;

function backingTargetsReadbackReady(service) {
  return Object.entries(GCP_PRIVATE_TEST_BACKING_ENVIRONMENT).every(([name, value]) =>
    exactServiceEnvironmentValue(service, name, value),
  );
}

function backingTargetsMatch(service, expected) {
  return Object.entries(expected).every(([name, value]) =>
    exactServiceEnvironmentValue(service, name, value),
  );
}

function previousBucketHistoryProofReadbackReady(service) {
  const entries = serviceEnvironmentEntries(service)
    .filter((entry) => entry?.name === "GCS_ERASURE_BUCKET_HISTORY_PROOF");
  if (entries.length !== 1 || typeof entries[0]?.value !== "string") return false;
  let parsed;
  try { parsed = JSON.parse(entries[0].value); } catch { return false; }
  const proof = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      && parsed.proof !== undefined ? parsed.proof : parsed;
  if (!exactKeys(proof, [
    "bucket", "bucketGeneration", "bucketMetageneration", "softDeleteRetentionDurationSeconds",
  ])
      || proof.bucket !== GCP_PRIVATE_TEST_PREVIOUS_BACKING_ENVIRONMENT.GCS_BUCKET_NAME
      || !validBucketGeneration(proof.bucketGeneration)
      || !validBucketGeneration(proof.bucketMetageneration)
      || proof.softDeleteRetentionDurationSeconds !== "0") {
    return false;
  }
  if (parsed.proof !== undefined) {
    return parsed.schemaVersion === GCP_TEST_BUCKET_HISTORY_RECEIPT_SCHEMA
      && parsed.source === "storage.buckets.insert"
      && parsed.project === GCP_PRIVATE_TEST_TARGET.project
      && parsed.projectNumber === GCP_TEST_BUCKET_HISTORY_TARGET.projectNumber;
  }
  return true;
}

function knownDeploymentSourceBackingReadbackReady(service, expectedBucketHistoryProof) {
  if (backingTargetsMatch(service, GCP_PRIVATE_TEST_BACKING_ENVIRONMENT)) {
    return expectedBucketHistoryProof !== undefined
      && exactServiceEnvironmentValue(
        service,
        "GCS_ERASURE_BUCKET_HISTORY_PROOF",
        expectedBucketHistoryProof,
      );
  }
  return backingTargetsMatch(service, GCP_PRIVATE_TEST_PREVIOUS_BACKING_ENVIRONMENT)
    && previousBucketHistoryProofReadbackReady(service);
}

function credentialScopeReadbackReady(service) {
  const environment = serviceEnvironmentEntries(service);
  return exactServiceEnvironmentValue(
    service,
    "POSTGRES_IAM_USER",
    GCP_PRIVATE_TEST_TARGET.postgresIamUser,
  ) && !environment.some((entry) => typeof entry?.name === "string"
    && entry.name !== "POSTGRES_IAM_USER"
    && ALTERNATE_DATABASE_CREDENTIAL_ENVIRONMENT_NAME.test(entry.name));
}

function sourceProvenanceInputsReady(config) {
  return typeof config?.buildId === "string" && BUILD_ID.test(config.buildId)
    && typeof config?.sourceArchivePath === "string" && config.sourceArchivePath.length > 0
    && typeof config?.sourceArchiveSha256 === "string" && DIGEST.test(config.sourceArchiveSha256)
    && config?.sourceBucket === GCP_PRIVATE_TEST_TARGET.buildBucket
    && typeof config?.sourceGeneration === "string" && GENERATION.test(config.sourceGeneration)
    && typeof config?.sourceObject === "string"
    && config.sourceObject === GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix
      + config.sourceDigest + "-" + config.sourceArchiveSha256 + ".tar.gz";
}

function buildStepImageDigest(value) {
  if (typeof value !== "string") return null;
  const match = /(?:@)?sha256:([a-f0-9]{64})$/u.exec(value);
  return match?.[1] ?? null;
}

function wellFormedCloudBuildHash(hash) {
  if (hash === null || typeof hash !== "object"
      || !CLOUD_BUILD_HASH_TYPES.has(hash.type)
      || typeof hash.value !== "string"
      || !exactRecord(hash, { type: hash.type, value: hash.value })) {
    return false;
  }
  let bytes;
  // Cloud Build's REST schema represents bytes as base64; gcloud readbacks
  // have also shown URL-safe base64, with and without canonical padding.
  if (/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(hash.value)) {
    bytes = Buffer.from(hash.value, "base64");
    if (bytes.toString("base64") !== hash.value) return false;
  } else if (/^[A-Za-z0-9_-]+$/u.test(hash.value) && hash.value.length % 4 !== 1) {
    bytes = Buffer.from(hash.value, "base64url");
    if (bytes.toString("base64url") !== hash.value) return false;
  } else if (/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}==|[A-Za-z0-9_-]{3}=)$/u.test(hash.value)) {
    bytes = Buffer.from(hash.value, "base64url");
    const unpadded = bytes.toString("base64url");
    const padding = "=".repeat((4 - (unpadded.length % 4)) % 4);
    if (unpadded + padding !== hash.value) return false;
  } else {
    return false;
  }
  if (bytes.length === 0) return false;
  if ((hash.type === "MD5" && bytes.length !== 16)
      || ((hash.type === "SHA256" || hash.type === "DIRSUM_SHA256") && bytes.length !== 32)
      || (hash.type === "SHA512" && bytes.length !== 64)) {
    return false;
  }
  if (hash.type === "GO_MODULE_H1") {
    const text = bytes.toString("ascii");
    if (!/^(?:[a-f0-9]{2})+$/u.test(text)) return false;
  }
  return true;
}

const CLOUD_BUILD_TOP_LEVEL_FIELDS = new Set([
  "name", "id", "projectId", "status", "statusDetail", "source", "steps",
  "results", "createTime", "startTime", "finishTime", "timeout", "images",
  "queueTtl", "artifacts", "logsBucket", "sourceProvenance", "buildTriggerId",
  "options", "logUrl", "substitutions", "tags", "secrets", "timing", "approval",
  "serviceAccount", "availableSecrets", "warnings", "gitConfig", "failureInfo",
  "dependencies",
]);
const CLOUD_BUILD_UNCONFIGURED_FIELDS = Object.freeze([
  "logsBucket", "buildTriggerId", "tags", "secrets", "availableSecrets",
  "approval", "gitConfig", "dependencies",
]);

function hasOnlyKeys(value, allowedKeys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowedKeys.has(key));
}

function exactRecord(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const expectedKeys = Object.keys(expected);
  return keys.length === expectedKeys.length
    && expectedKeys.every((key) => value[key] === expected[key]);
}

function buildConfigurationMatchesReviewedConfig(build) {
  if (!hasOnlyKeys(build, CLOUD_BUILD_TOP_LEVEL_FIELDS)
      || CLOUD_BUILD_UNCONFIGURED_FIELDS.some((key) => Object.hasOwn(build, key))) {
    return false;
  }

  // These response fields are fixed by the generated submission contract:
  // gcloud receives --timeout=1200s, queueTtl uses the documented 3600s
  // default, and artifacts.images echoes the one reviewed image output.
  if (build.timeout !== undefined && build.timeout !== "1200s") return false;
  if (build.queueTtl !== undefined && build.queueTtl !== "3600s") return false;
  if (build.artifacts !== undefined
      && (!hasOnlyKeys(build.artifacts, new Set(["images"]))
        || !Array.isArray(build.artifacts.images)
        || build.artifacts.images.length !== 1
        || build.artifacts.images[0] !== GCP_PRIVATE_TEST_BUILD.imageTag)) {
    return false;
  }

  const step = Array.isArray(build.steps) && build.steps.length === 1
    ? build.steps[0]
    : null;
  const allowedStepKeys = new Set([
    "name", "args", "timing", "pullTiming", "status", "exitCode",
  ]);
  const resolvedArgs = [
    "build",
    "--file=apps/worker/cloud-run/Dockerfile",
    "--tag=" + GCP_PRIVATE_TEST_BUILD.imageTag,
    ".",
  ];
  if (!hasOnlyKeys(step, allowedStepKeys)
      || step.name !== GCP_PRIVATE_TEST_BUILD.dockerBuilderImage
      || JSON.stringify(step.args) !== JSON.stringify(resolvedArgs)
      || step.status !== "SUCCESS"
      || (step.exitCode !== undefined && step.exitCode !== 0)) {
    return false;
  }

  const options = build.options;
  const allowedOptionKeys = new Set([
    "logging", "sourceProvenanceHash", "requestedVerifyOption", "pool",
  ]);
  if (!hasOnlyKeys(options, allowedOptionKeys)
      || options.logging !== "CLOUD_LOGGING_ONLY"
      || !Array.isArray(options.sourceProvenanceHash)
      || options.sourceProvenanceHash.length !== 1
      || options.sourceProvenanceHash[0] !== "SHA256"
      || options.requestedVerifyOption !== "VERIFIED"
      || (options.pool !== undefined && !exactRecord(options.pool, {}))) {
    return false;
  }

  return exactRecord(build.substitutions, { _IMAGE: GCP_PRIVATE_TEST_BUILD.imageTag });
}

export function assessCloudBuildProvenance({ build, config } = {}) {
  const blockers = [];
  if (!sourceProvenanceInputsReady(config)) {
    return Object.freeze({
      ok: false,
      blockers: Object.freeze(["GCP_BUILD_PROVENANCE_ARGUMENTS_REQUIRED"]),
    });
  }
  if (!build || typeof build !== "object") {
    return Object.freeze({
      ok: false,
      blockers: Object.freeze(["GCP_BUILD_READBACK_MISSING"]),
    });
  }
  const expectedNames = new Set([
    GCP_PRIVATE_TEST_TARGET.project,
    GCP_PRIVATE_TEST_TARGET.projectNumber,
  ].map((project) =>
    `projects/${project}/locations/${GCP_PRIVATE_TEST_TARGET.region}/builds/${config.buildId}`,
  ));
  if (build.id !== config.buildId || build.projectId !== config.project
      || !expectedNames.has(build.name)) {
    blockers.push("GCP_BUILD_IDENTITY_MISMATCH");
  }
  if (!buildConfigurationMatchesReviewedConfig(build)) {
    blockers.push("GCP_BUILD_CONFIGURATION_UNEXPECTED");
  }
  if (build.status !== "SUCCESS") blockers.push("GCP_BUILD_NOT_SUCCESSFUL");
  if (build.serviceAccount !== GCP_PRIVATE_TEST_BUILD.serviceAccount) {
    blockers.push("GCP_BUILD_SERVICE_ACCOUNT_UNEXPECTED");
  }

  const options = build.options;
  if (!Array.isArray(options?.sourceProvenanceHash)
      || options.sourceProvenanceHash.length !== 1
      || options.sourceProvenanceHash[0] !== "SHA256"
      || options.requestedVerifyOption !== "VERIFIED") {
    blockers.push("GCP_BUILD_PROVENANCE_OPTIONS_UNQUALIFIED");
  }

  const steps = build.steps;
  if (!Array.isArray(steps) || steps.length !== 1
      || steps[0]?.name !== GCP_PRIVATE_TEST_BUILD.dockerBuilderImage
      || steps[0]?.status !== "SUCCESS"
      || (steps[0]?.exitCode !== undefined && steps[0].exitCode !== 0)) {
    blockers.push("GCP_BUILD_STEP_UNEXPECTED");
  }
  const stepImages = build.results?.buildStepImages;
  if (!Array.isArray(stepImages) || stepImages.length !== 1
      || buildStepImageDigest(stepImages[0])
        !== GCP_PRIVATE_TEST_BUILD.dockerBuilderImage.slice("gcr.io/cloud-builders/docker@sha256:".length)) {
    blockers.push("GCP_BUILD_STEP_IMAGE_DIGEST_UNEXPECTED");
  }

  const expectedSourceName = {
    bucket: config.sourceBucket,
    object: config.sourceObject,
    generation: config.sourceGeneration,
  };
  const source = build.source?.storageSource;
  if (!exactRecord(source, expectedSourceName)
      || source?.bucket !== expectedSourceName.bucket
      || source?.object !== expectedSourceName.object
      || String(source?.generation) !== config.sourceGeneration
      || !exactRecord(build.source, { storageSource: source })) {
    blockers.push("GCP_BUILD_SOURCE_OBJECT_MISMATCH");
  }
  const resolvedSource = build.sourceProvenance?.resolvedStorageSource;
  if (!exactRecord(resolvedSource, {
    bucket: expectedSourceName.bucket,
    object: expectedSourceName.object,
    generation: config.sourceGeneration,
  }) || resolvedSource?.bucket !== expectedSourceName.bucket
      || resolvedSource?.object !== expectedSourceName.object
      || typeof resolvedSource?.generation !== "string"
      || resolvedSource.generation !== config.sourceGeneration
      || !exactRecord(build.sourceProvenance, {
        resolvedStorageSource: resolvedSource,
        fileHashes: build.sourceProvenance?.fileHashes,
      })) {
    blockers.push("GCP_BUILD_SOURCE_GENERATION_MISMATCH");
  }
  const expectedSourceUri = `gs://${config.sourceBucket}/${config.sourceObject}#${config.sourceGeneration}`;
  const fileHashes = build.sourceProvenance?.fileHashes;
  const hashKeys = fileHashes !== null && typeof fileHashes === "object"
      && !Array.isArray(fileHashes) ? Object.keys(fileHashes) : [];
  const hashes = fileHashes?.[expectedSourceUri]?.fileHash;
  const archiveHashBytes = Buffer.from(config.sourceArchiveSha256, "hex");
  const paddedBase64UrlArchiveHash = archiveHashBytes.toString("base64")
    .replaceAll("+", "-").replaceAll("/", "_");
  const expectedArchiveHashValues = new Set([
    archiveHashBytes.toString("base64"),
    archiveHashBytes.toString("base64url"),
    paddedBase64UrlArchiveHash,
  ]);
  const hashEntry = fileHashes?.[expectedSourceUri];
  const results = build.results;
  const allowedResultKeys = new Set(["images", "buildStepImages", "buildStepOutputs"]);
  const allowedImageResultKeys = new Set([
    "name", "digest", "pushTiming", "artifactRegistryPackage", "ociMediaType",
  ]);
  if (hashKeys.length !== 1 || hashKeys[0] !== expectedSourceUri
      || !exactRecord(hashEntry, { fileHash: hashes })
      || !Array.isArray(hashes) || hashes.length === 0
      || hashes.some((hash) => !wellFormedCloudBuildHash(hash))
      || new Set(hashes.map((hash) => hash.type)).size !== hashes.length
      || hashes.filter((hash) => hash.type === "SHA256").length !== 1
      || !expectedArchiveHashValues.has(hashes.find((hash) => hash.type === "SHA256")?.value)
      || !exactRecord(build.sourceProvenance, {
        resolvedStorageSource: resolvedSource,
        fileHashes,
      })
      || !hasOnlyKeys(results, allowedResultKeys)
      || !Array.isArray(results?.images) || results.images.length !== 1
      || !hasOnlyKeys(results.images[0], allowedImageResultKeys)
      || (results.buildStepOutputs !== undefined
        && (!Array.isArray(results.buildStepOutputs)
          || results.buildStepOutputs.length !== 1
          || results.buildStepOutputs[0] !== ""))) {
    blockers.push("GCP_BUILD_SOURCE_ARCHIVE_SHA256_MISMATCH");
  }

  const expectedImageDigest = IMAGE_REFERENCE.exec(config.image)?.[1];
  const images = build.results?.images;
  if (build.images?.length !== 1 || build.images[0] !== GCP_PRIVATE_TEST_BUILD.imageTag
      || !Array.isArray(images) || images.length !== 1
      || images[0]?.name !== GCP_PRIVATE_TEST_BUILD.imageTag
      || images[0]?.digest !== `sha256:${expectedImageDigest}`) {
    blockers.push("GCP_BUILD_IMAGE_DIGEST_MISMATCH");
  }
  return Object.freeze({
    ok: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    sourceGeneration: resolvedSource?.generation ?? null,
    image: images?.[0]?.name && images?.[0]?.digest
      ? `${images[0].name.replace(/:[^/:]+$/u, "")}@${images[0].digest}`
      : null,
  });
}

export async function assessLocalCloudBuildSourceArchive(config, {
  archiveBuilder = createCloudRunBuildArchive,
} = {}) {
  const blockers = [];
  if (!sourceProvenanceInputsReady(config)) {
    return Object.freeze({
      ok: false,
      blockers: Object.freeze(["GCP_BUILD_PROVENANCE_ARGUMENTS_REQUIRED"]),
    });
  }
  let canonical;
  try {
    canonical = await archiveBuilder();
  } catch {
    return Object.freeze({
      ok: false,
      blockers: Object.freeze(["GCP_PRIVATE_TEST_SOURCE_ARCHIVE_BUILD_FAILED"]),
    });
  }
  if (canonical?.sourceContentDigest !== config.sourceDigest) {
    blockers.push("GCP_PRIVATE_TEST_SOURCE_CONTEXT_DIGEST_MISMATCH");
  }
  if (canonical?.cloudBuildConfigSha256 !== GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256) {
    blockers.push("GCP_PRIVATE_TEST_BUILD_CONFIG_SHA256_MISMATCH");
  }
  let bytes;
  let handle;
  try {
    const path = resolve(config.sourceArchivePath);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || stat.size <= 0 || stat.size > MAX_SOURCE_ARCHIVE_BYTES) {
      blockers.push("GCP_PRIVATE_TEST_SOURCE_ARCHIVE_UNSAFE");
    } else {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.nlink !== 1
          || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino
          || openedStat.size !== stat.size || openedStat.size > MAX_SOURCE_ARCHIVE_BYTES) {
        blockers.push("GCP_PRIVATE_TEST_SOURCE_ARCHIVE_UNSAFE");
      } else {
        bytes = await handle.readFile();
      }
    }
  } catch {
    blockers.push("GCP_PRIVATE_TEST_SOURCE_ARCHIVE_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => {});
  }
  let observedSha256 = null;
  if (bytes !== undefined) {
    observedSha256 = createHash("sha256").update(bytes).digest("hex");
    if (observedSha256 !== config.sourceArchiveSha256) {
      blockers.push("GCP_PRIVATE_TEST_SOURCE_ARCHIVE_SHA256_MISMATCH");
    }
    if (observedSha256 !== canonical?.sourceArchiveSha256) {
      blockers.push("GCP_PRIVATE_TEST_SOURCE_ARCHIVE_CONTEXT_MISMATCH");
    }
  }
  return Object.freeze({
    ok: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    sourceContentDigest: canonical?.sourceContentDigest ?? null,
    sourceArchiveSha256: observedSha256,
  });
}

function hasPublicInvokerBinding(policy) {
  return (Array.isArray(policy?.bindings) ? policy.bindings : []).some((binding) =>
    binding.role === "roles/run.invoker"
      && Array.isArray(binding.members)
      && binding.members.some((member) =>
        member === "allUsers" || member === "allAuthenticatedUsers"),
  );
}

export function assessCloudRunReadback({
  service,
  policy,
  expectedImage,
  expectedSourceDigest,
  expectedBucketHistoryProof,
  requireExactImage = true,
  requireSourceDigest = true,
  requireLatestReadyTraffic = requireExactImage,
  requireCloudRunHostMode = false,
  requireBackingTargets = true,
  allowKnownPreviousBackingTargets = false,
} = {}) {
  const blockers = [];
  if (!service || !policy) return Object.freeze({
    ok: false,
    blockers: Object.freeze(["GCP_TEST_SERVICE_READBACK_MISSING"]),
  });
  if (!readyCondition(service)) blockers.push("GCP_TEST_SERVICE_NOT_READY");
  if (serviceIngress(service) !== "all"
      && serviceIngress(service) !== "INGRESS_TRAFFIC_ALL") {
    blockers.push("GCP_TEST_INGRESS_UNEXPECTED");
  }
  if (!invokerIamCheckEnabled(service)) blockers.push("GCP_TEST_INVOKER_IAM_CHECK_DISABLED");
  if (hasPublicInvokerBinding(policy)) blockers.push("GCP_TEST_PUBLIC_INVOKER_PRESENT");
  if (requireLatestReadyTraffic && !routesAllTrafficToLatestReadyRevision(service)) {
    blockers.push("GCP_TEST_LATEST_REVISION_TRAFFIC_UNQUALIFIED");
  }
  if (requireExactImage && serviceImage(service) !== expectedImage) {
    blockers.push("GCP_TEST_IMAGE_DIGEST_MISMATCH");
  }
  if (requireSourceDigest
      && serviceEnvironment(service).get("SOURCE_CONTENT_DIGEST") !== expectedSourceDigest) {
    blockers.push("GCP_TEST_SOURCE_DIGEST_READBACK_MISMATCH");
  }
  if (requireBackingTargets && !backingTargetsReadbackReady(service)) {
    blockers.push("GCP_TEST_BACKING_TARGET_READBACK_UNQUALIFIED");
  }
  if (allowKnownPreviousBackingTargets
      && !knownDeploymentSourceBackingReadbackReady(service, expectedBucketHistoryProof)) {
    blockers.push("GCP_TEST_BACKING_TARGET_READBACK_UNQUALIFIED");
  }
  if (expectedBucketHistoryProof !== undefined
      && !(allowKnownPreviousBackingTargets
        && backingTargetsMatch(service, GCP_PRIVATE_TEST_PREVIOUS_BACKING_ENVIRONMENT))
      && !exactServiceEnvironmentValue(
        service,
        "GCS_ERASURE_BUCKET_HISTORY_PROOF",
        expectedBucketHistoryProof,
      )) {
    blockers.push("GCP_TEST_BUCKET_HISTORY_PROOF_READBACK_UNQUALIFIED");
  }
  if (!credentialScopeReadbackReady(service)) {
    blockers.push("GCP_TEST_CREDENTIAL_SCOPE_READBACK_UNQUALIFIED");
  }
  if (serviceAccountName(service) !== GCP_PRIVATE_TEST_TARGET.runtimeServiceAccount) {
    blockers.push("GCP_TEST_RUNTIME_SERVICE_ACCOUNT_UNQUALIFIED");
  }
  if (requireCloudRunHostMode) {
    const environment = serviceEnvironment(service);
    const resolvedServiceUrl = serviceUrl(service);
    if (resolvedServiceUrl !== GCP_PRIVATE_TEST_TARGET.hostOrigin
        || environment.get("HOST") !== "0.0.0.0"
        || environment.get("HOST_ORIGIN") !== GCP_PRIVATE_TEST_TARGET.hostOrigin
        || environment.get("POSTGRES_TEST_HTTP_MODE") !== "cloud-run-iam") {
      blockers.push("GCP_TEST_HOST_MODE_READBACK_UNQUALIFIED");
    }
  }
  return Object.freeze({
    ok: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

export function cloudRunHostModeReady(isPrivateHost) {
  if (typeof isPrivateHost !== "function") return false;
  try {
    return isPrivateHost({
      mode: "cloud-run-iam",
      service: GCP_PRIVATE_TEST_TARGET.service,
      project: GCP_PRIVATE_TEST_TARGET.project,
      region: GCP_PRIVATE_TEST_TARGET.region,
      listenHost: "0.0.0.0",
      hostOrigin: GCP_PRIVATE_TEST_TARGET.hostOrigin,
      port: 8080,
    }) === true;
  } catch {
    return false;
  }
}

function parseJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

function exactKeys(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function validBucketGeneration(value) {
  if (typeof value !== "string" || !GENERATION.test(value)) return false;
  try { return BigInt(value) <= 9_223_372_036_854_775_807n; } catch { return false; }
}

function validateBucketHistoryReceipt(receipt) {
  const target = GCP_PRIVATE_TEST_TARGET;
  const responseFields = [
    "bucket", "projectNumber", "bucketGeneration", "bucketMetageneration", "location",
    "timeCreated", "softDeleteRetentionDurationSeconds", "iamConfiguration", "versioningEnabled",
  ];
  const proofFields = [
    "bucket", "bucketGeneration", "bucketMetageneration", "softDeleteRetentionDurationSeconds",
  ];
  if (!exactKeys(receipt, [
    "schemaVersion", "source", "project", "projectNumber", "creationRequestSha256",
    "creationResponse", "creationResponseSha256", "proof",
  ])
      || receipt.schemaVersion !== GCP_TEST_BUCKET_HISTORY_RECEIPT_SCHEMA
      || receipt.source !== "storage.buckets.insert"
      || receipt.project !== target.project
      || receipt.projectNumber !== GCP_TEST_BUCKET_HISTORY_TARGET.projectNumber
      || !DIGEST.test(receipt.creationRequestSha256 ?? "")
      || !DIGEST.test(receipt.creationResponseSha256 ?? "")
      || receipt.creationRequestSha256 !== createHash("sha256")
        .update(JSON.stringify(buildGcpTestBucketCreateRequest(target.gcsBucketName))).digest("hex")
      || !exactKeys(receipt.creationResponse, responseFields)
      || !exactKeys(receipt.proof, proofFields)) {
    fail("GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_INVALID");
  }

  const response = receipt.creationResponse;
  const proof = receipt.proof;
  if (response.bucket !== target.gcsBucketName
      || response.projectNumber !== target.projectNumber
      || !validBucketGeneration(response.bucketGeneration)
      || response.bucketMetageneration !== "1"
      || response.location !== GCP_TEST_BUCKET_HISTORY_TARGET.location
      || response.softDeleteRetentionDurationSeconds !== "0"
      || response.iamConfiguration === null || typeof response.iamConfiguration !== "object"
      || Array.isArray(response.iamConfiguration)
      || !exactRecord(response.iamConfiguration, {
        uniformBucketLevelAccess: true,
        publicAccessPrevention: "enforced",
      })
      || response.versioningEnabled !== false
      || typeof response.timeCreated !== "string"
      || !Number.isFinite(Date.parse(response.timeCreated))
      || receipt.creationResponseSha256 !== createHash("sha256")
        .update(JSON.stringify(response)).digest("hex")
      || proof.bucket !== response.bucket
      || proof.bucketGeneration !== response.bucketGeneration
      || proof.bucketMetageneration !== response.bucketMetageneration
      || proof.softDeleteRetentionDurationSeconds !== response.softDeleteRetentionDurationSeconds) {
    fail("GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_INVALID");
  }
  return JSON.stringify(proof);
}

async function readExactFileBytes(handle, size) {
  const bytes = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) fail("GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_UNSAFE");
  return bytes.subarray(0, size);
}

/** Read and validate the owner-only bucket birth receipt without exposing its contents. */
export async function readGcpPrivateTestBucketHistoryProof(receiptPath) {
  if (typeof receiptPath !== "string" || !isAbsolute(receiptPath)) {
    fail("GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_REQUIRED");
  }
  const path = resolve(receiptPath);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let handle;
  try {
    const pathStat = await lstat(path);
    if (uid === null || !pathStat.isFile() || pathStat.isSymbolicLink()
        || pathStat.nlink !== 1 || pathStat.uid !== uid
        || (pathStat.mode & 0o777) !== 0o600
        || pathStat.size < 1 || pathStat.size > MAX_BUCKET_HISTORY_RECEIPT_BYTES) {
      fail("GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_UNSAFE");
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.nlink !== 1 || openedStat.uid !== uid
        || (openedStat.mode & 0o777) !== 0o600
        || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino
        || openedStat.size !== pathStat.size
        || openedStat.size < 1 || openedStat.size > MAX_BUCKET_HISTORY_RECEIPT_BYTES) {
      fail("GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_UNSAFE");
    }
    const bytes = await readExactFileBytes(handle, openedStat.size);
    const afterReadStat = await handle.stat();
    const finalPathStat = await lstat(path);
    if (afterReadStat.dev !== openedStat.dev || afterReadStat.ino !== openedStat.ino
        || afterReadStat.size !== openedStat.size || afterReadStat.mtimeMs !== openedStat.mtimeMs
        || finalPathStat.dev !== openedStat.dev || finalPathStat.ino !== openedStat.ino
        || finalPathStat.uid !== uid || finalPathStat.nlink !== 1
        || (finalPathStat.mode & 0o777) !== 0o600) {
      fail("GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_UNSAFE");
    }
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
      fail("GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_INVALID");
    }
    const receipt = parseJson(text, "GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_INVALID");
    if (`${JSON.stringify(receipt, null, 2)}\n` !== text) {
      fail("GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_INVALID");
    }
    return validateBucketHistoryReceipt(receipt);
  } catch (error) {
    if (typeof error?.code === "string"
        && /^GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_(?:REQUIRED|UNSAFE|INVALID)$/u.test(error.code)) {
      throw error;
    }
    fail("GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function encodeUpdateEnvVars(entries) {
  const delimiter = "|";
  if (!Array.isArray(entries) || entries.length === 0
      || entries.some(({ name, value }) => !/^[A-Z][A-Z0-9_]*$/u.test(name)
        || typeof value !== "string" || value.length === 0 || value.includes(delimiter))) {
    fail("GCP_PRIVATE_TEST_ENV_UPDATE_INVALID");
  }
  // gcloud's dictionary parser uses commas by default; the bucket proof is
  // JSON, so use its documented alternate-list delimiter for one atomic flag.
  return "--update-env-vars=^|^" + entries.map(({ name, value }) => `${name}=${value}`).join(delimiter);
}

function spawnGcloud(args, spawn = spawnSync) {
  const result = spawn("gcloud", args, {
    cwd: WORKER_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) fail("GCP_PRIVATE_TEST_GCLOUD_OPERATION_FAILED");
  return result.stdout.trim();
}

function checkedBuildContext(sourceDigest, spawn = spawnSync) {
  const result = spawn(process.execPath, [BUILD_CONTEXT_CHECK, "--check"], {
    cwd: WORKER_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) fail("GCP_PRIVATE_TEST_SOURCE_CONTEXT_CHECK_FAILED");
  const receipt = parseJson(result.stdout, "GCP_PRIVATE_TEST_SOURCE_CONTEXT_RECEIPT_INVALID");
  if (receipt?.status !== "ok" || receipt?.mode !== "check"
      || receipt?.sourceContentDigest !== sourceDigest) {
    fail("GCP_PRIVATE_TEST_SOURCE_CONTEXT_DIGEST_MISMATCH");
  }
  return receipt;
}

async function loadPrivateHostPredicate() {
  try {
    const module = await import("../cloud-run/postgres-test-dispatch.mjs");
    return module.isPrivatePostgresTestHost;
  } catch {
    return null;
  }
}

function validateServiceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("GCP_PRIVATE_TEST_SERVICE_URL_INVALID");
  }
  if (url.protocol !== "https:" || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || url.origin !== value) {
    fail("GCP_PRIVATE_TEST_SERVICE_URL_INVALID");
  }
  return url.origin;
}

function syntheticInvalidEnvelope() {
  // This is deliberately invalid and is rejected before authorization or
  // persistence. It is a route boundary probe, not an ingestion success test.
  return JSON.stringify({
    schemaVersion: "telemetry-envelope-v1.2",
    synthetic: true,
    keyId: "key:synthetic-smoke",
    wrappedKey: "",
    iv: "",
    ciphertext: "",
  });
}

async function authenticatedRequest(url, token, options, fetchImpl) {
  const response = await fetchImpl(url, {
    ...options,
    redirect: "error",
    headers: {
      authorization: "Bearer " + token,
      accept: "application/json",
      "cache-control": "no-store",
      ...options.headers,
    },
  });
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json"
      || response.headers.get("cache-control") !== "no-store"
      || response.headers.get("referrer-policy") !== "no-referrer"
      || response.headers.get("x-content-type-options") !== "nosniff") {
    fail("GCP_PRIVATE_TEST_SMOKE_RESPONSE_HEADERS_INVALID");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    fail("GCP_PRIVATE_TEST_SMOKE_RESPONSE_INVALID");
  }
  return { response, body };
}

export async function runSyntheticRouteBoundarySmoke({
  serviceUrl,
  token,
  fetchImpl = fetch,
} = {}) {
  if (typeof token !== "string" || token.length < 16 || token.length > 16_384) {
    fail("GCP_PRIVATE_TEST_IDENTITY_TOKEN_UNAVAILABLE");
  }
  const origin = validateServiceUrl(serviceUrl);
  const health = await authenticatedRequest(
    new URL(HEALTH_PATH, origin),
    token,
    { method: "GET" },
    fetchImpl,
  );
  if (health.response.status !== 200
      || health.body?.schemaVersion !== "gcp-postgres-test-health-v1"
      || health.body?.status !== "ready"
      || health.body?.workerApplicationReady !== false
      || health.body?.checks?.primaryMigrationReceipt?.status !== "current"
      || health.body?.checks?.ledgerMigrationReceipt?.status !== "current") {
    fail("GCP_PRIVATE_TEST_HEALTH_SMOKE_FAILED");
  }

  // This IAM-token Authorization header is used only for this invalid-envelope
  // boundary: it is rejected before application device authorization. A valid
  // route smoke must send the Cloud Run ID token in X-Serverless-Authorization
  // and a separate application device token in Authorization.
  const route = await authenticatedRequest(
    new URL(V12_CHUNK_PATH, origin),
    token,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: syntheticInvalidEnvelope(),
    },
    fetchImpl,
  );
  if (route.response.status !== 400
      || route.body?.error?.code !== "ENVELOPE_INVALID") {
    fail("GCP_PRIVATE_TEST_SYNTHETIC_ROUTE_BOUNDARY_FAILED");
  }
  return Object.freeze({
    health: "ready",
    routeBoundary: "synthetic_invalid_envelope_rejected",
    validRouteSmoke: "not_tested_requires_cloud_run_and_device_tokens",
    writesAttempted: false,
  });
}

export async function runUnauthenticatedInvokerProbe({
  serviceUrl,
  fetchImpl = fetch,
} = {}) {
  const origin = validateServiceUrl(serviceUrl);
  try {
    const response = await fetchImpl(new URL(HEALTH_PATH, origin), {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        "cache-control": "no-store",
      },
    });
    if (response.status === 401 || response.status === 403) {
      return Object.freeze({ ok: true, result: "denied_without_identity" });
    }
    return Object.freeze({ ok: false, result: "unexpected_http_status" });
  } catch {
    return Object.freeze({ ok: false, result: "network_probe_unavailable" });
  }
}

async function readCloudRunState(config, spawn = spawnSync) {
  const project = config.project;
  const region = config.region;
  const service = config.service;
  const serviceJson = parseJson(spawnGcloud([
    "run", "services", "describe", service,
    "--project=" + project,
    "--region=" + region,
    "--format=json",
  ], spawn), "GCP_PRIVATE_TEST_SERVICE_READBACK_INVALID");
  const policyJson = parseJson(spawnGcloud([
    "run", "services", "get-iam-policy", service,
    "--project=" + project,
    "--region=" + region,
    "--format=json",
  ], spawn), "GCP_PRIVATE_TEST_IAM_READBACK_INVALID");
  return Object.freeze({ service: serviceJson, policy: policyJson });
}

function readCloudBuild(config, spawn = spawnSync) {
  return parseJson(spawnGcloud([
    "builds", "describe", config.buildId,
    "--project=" + config.project,
    "--region=" + config.region,
    "--format=json",
  ], spawn), "GCP_PRIVATE_TEST_BUILD_READBACK_INVALID");
}

async function assessRequestedSourceProvenance(config, archiveBuilder, spawn) {
  if (!sourceProvenanceInputsReady(config)) {
    return Object.freeze({
      ok: false,
      blockers: Object.freeze(["GCP_BUILD_PROVENANCE_ARGUMENTS_REQUIRED"]),
      local: null,
      build: null,
    });
  }
  const local = await assessLocalCloudBuildSourceArchive(config, { archiveBuilder });
  if (!local.ok) {
    return Object.freeze({
      ok: false,
      blockers: local.blockers,
      local,
      build: null,
    });
  }
  let build;
  try {
    build = assessCloudBuildProvenance({ build: readCloudBuild(config, spawn), config });
  } catch {
    build = Object.freeze({
      ok: false,
      blockers: Object.freeze(["GCP_BUILD_READBACK_UNAVAILABLE"]),
    });
  }
  return Object.freeze({
    ok: local.ok && build.ok,
    blockers: Object.freeze(build.ok ? [] : build.blockers),
    local,
    build,
  });
}

export async function runGcpPrivateTestDeployment({
  config,
  spawn = spawnSync,
  fetchImpl = fetch,
  isPrivateHost,
  archiveBuilder = createCloudRunBuildArchive,
  readBucketHistoryProof = readGcpPrivateTestBucketHistoryProof,
} = {}) {
  validateConfig(config);
  let bucketHistoryProof;
  if (config.command !== "preflight"
      || (typeof config.bucketHistoryReceiptPath === "string"
        && config.bucketHistoryReceiptPath.length > 0)) {
    bucketHistoryProof = await readBucketHistoryProof(config.bucketHistoryReceiptPath);
  }
  checkedBuildContext(config.sourceDigest, spawn);
  const hostModeReady = cloudRunHostModeReady(isPrivateHost);
  const provenance = await assessRequestedSourceProvenance(config, archiveBuilder, spawn);
  const provenanceBlockers = provenance.ok
    ? []
    : ["SOURCE_PROVENANCE_UNQUALIFIED", ...provenance.blockers];
  if (config.command === "deploy" && !provenance.ok) {
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze([
        ...provenanceBlockers,
        ...(!hostModeReady ? ["POSTGRES_TEST_HOST_CLOUD_RUN_MODE_UNAVAILABLE"] : []),
      ]),
    });
  }

  const initial = await readCloudRunState(config, spawn);
  const deploying = config.command === "deploy";
  const assessment = assessCloudRunReadback({
    service: initial.service,
    policy: initial.policy,
    expectedImage: config.image,
    expectedSourceDigest: config.sourceDigest,
    requireExactImage: !deploying,
    requireSourceDigest: !deploying,
    requireLatestReadyTraffic: true,
    requireCloudRunHostMode: config.command === "verify",
    // The fixed service may still be serving its previous known database and
    // bucket revision. Deployment replaces image and all A2 backing settings
    // together; retain service identity, IAM, privacy, and credential checks.
    requireBackingTargets: !deploying,
    ...(bucketHistoryProof === undefined ? {} : { expectedBucketHistoryProof: bucketHistoryProof }),
    allowKnownPreviousBackingTargets: deploying,
  });
  const origin = validateServiceUrl(serviceUrl(initial.service));
  const unauthenticatedProbe = await runUnauthenticatedInvokerProbe({
    serviceUrl: origin,
    fetchImpl,
  });

  if (config.command === "preflight") {
    const blockers = [
      ...provenanceBlockers,
      ...assessment.blockers,
      ...(!hostModeReady ? ["POSTGRES_TEST_HOST_CLOUD_RUN_MODE_UNAVAILABLE"] : []),
      ...(origin !== GCP_PRIVATE_TEST_TARGET.hostOrigin ? ["GCP_TEST_SERVICE_URL_UNEXPECTED"] : []),
      ...(!unauthenticatedProbe.ok ? ["GCP_TEST_UNAUTHENTICATED_PROBE_FAILED"] : []),
    ];
    return Object.freeze({
      status: blockers.length === 0 ? "ready" : "blocked",
      blockers: Object.freeze([...new Set(blockers)]),
      readOnlyAssessment: true,
      unauthenticatedProbe: unauthenticatedProbe.result,
    });
  }

  if (config.command === "verify") {
    const blockers = [...provenanceBlockers, ...assessment.blockers];
    if (!hostModeReady) blockers.push("POSTGRES_TEST_HOST_CLOUD_RUN_MODE_UNAVAILABLE");
    if (origin !== GCP_PRIVATE_TEST_TARGET.hostOrigin) blockers.push("GCP_TEST_SERVICE_URL_UNEXPECTED");
    if (!unauthenticatedProbe.ok) blockers.push("GCP_TEST_UNAUTHENTICATED_PROBE_FAILED");
    return Object.freeze({
      status: blockers.length === 0 ? "verified" : "blocked",
      blockers: Object.freeze([...new Set(blockers)]),
      readOnlyAssessment: true,
      unauthenticatedProbe: unauthenticatedProbe.result,
      sourceProvenance: provenance.ok ? Object.freeze({
        buildId: config.buildId,
        sourceGeneration: provenance.build.sourceGeneration,
        sourceArchiveSha256: provenance.local.sourceArchiveSha256,
        image: provenance.build.image,
      }) : null,
    });
  }

  const preDeployBlockers = [
    ...assessment.blockers,
    ...(!hostModeReady ? ["POSTGRES_TEST_HOST_CLOUD_RUN_MODE_UNAVAILABLE"] : []),
    ...(origin !== GCP_PRIVATE_TEST_TARGET.hostOrigin ? ["GCP_TEST_SERVICE_URL_UNEXPECTED"] : []),
    ...(!unauthenticatedProbe.ok ? ["GCP_TEST_UNAUTHENTICATED_PROBE_FAILED"] : []),
  ];
  if (preDeployBlockers.length > 0) {
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze([...new Set(preDeployBlockers)]),
      preDeployReadOnlyAssessment: true,
      unauthenticatedProbe: unauthenticatedProbe.result,
    });
  }

  const updateEnv = [
    { name: "HOST", value: "0.0.0.0" },
    { name: "HOST_ORIGIN", value: GCP_PRIVATE_TEST_TARGET.hostOrigin },
    { name: "POSTGRES_TEST_HTTP_MODE", value: "cloud-run-iam" },
    ...Object.entries(GCP_PRIVATE_TEST_BACKING_ENVIRONMENT).map(([name, value]) => ({ name, value })),
    { name: "GCS_ERASURE_BUCKET_HISTORY_PROOF", value: bucketHistoryProof },
    { name: "POSTGRES_IAM_USER", value: GCP_PRIVATE_TEST_TARGET.postgresIamUser },
    { name: "SOURCE_CONTENT_DIGEST", value: config.sourceDigest },
  ];
  spawnGcloud([
    "run", "deploy", config.service,
    "--project=" + config.project,
    "--region=" + config.region,
    "--image=" + config.image,
    "--port=8080",
    "--service-account=" + GCP_PRIVATE_TEST_TARGET.runtimeServiceAccount,
    encodeUpdateEnvVars(updateEnv),
    "--no-allow-unauthenticated",
    "--quiet",
  ], spawn);

  // Cloud Run can retain a service-level traffic pin to an older revision.
  // Move only this fixed test service to its latest revision before the
  // post-deploy readback; do not let a ready-but-retired revision pass as live.
  spawnGcloud([
    "run", "services", "update-traffic", config.service,
    "--to-latest",
    "--project=" + config.project,
    "--region=" + config.region,
    "--quiet",
  ], spawn);

  const deployed = await readCloudRunState(config, spawn);
  const deployedAssessment = assessCloudRunReadback({
    service: deployed.service,
    policy: deployed.policy,
    expectedImage: config.image,
    expectedSourceDigest: config.sourceDigest,
    requireExactImage: true,
    requireSourceDigest: true,
    requireLatestReadyTraffic: true,
    requireCloudRunHostMode: true,
    expectedBucketHistoryProof: bucketHistoryProof,
  });
  const deployedUrl = validateServiceUrl(serviceUrl(deployed.service));
  const deployedUnauthenticatedProbe = await runUnauthenticatedInvokerProbe({
    serviceUrl: deployedUrl,
    fetchImpl,
  });
  const deployedBlockers = [
    ...deployedAssessment.blockers,
    ...(deployedUrl !== GCP_PRIVATE_TEST_TARGET.hostOrigin ? ["GCP_TEST_SERVICE_URL_UNEXPECTED"] : []),
    ...(!deployedUnauthenticatedProbe.ok ? ["GCP_TEST_UNAUTHENTICATED_PROBE_FAILED"] : []),
  ];
  return Object.freeze({
    status: deployedBlockers.length === 0 ? "deployed" : "blocked",
    blockers: Object.freeze([...new Set(deployedBlockers)]),
    sourceProvenance: Object.freeze({
      buildId: config.buildId,
      sourceGeneration: provenance.build.sourceGeneration,
      sourceArchiveSha256: provenance.local.sourceArchiveSha256,
      image: provenance.build.image,
    }),
    postDeployAssessment: true,
    unauthenticatedProbe: deployedUnauthenticatedProbe.result,
    routeSmoke: "not_run_application_device_token_required",
  });
}

async function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
    const isPrivateHost = await loadPrivateHostPredicate();
    const result = await runGcpPrivateTestDeployment({
      config,
      isPrivateHost,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "blocked") process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({
      status: "error",
      code: typeof error?.code === "string"
        ? error.code
        : "GCP_PRIVATE_TEST_GATE_FAILED",
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
