#!/usr/bin/env node

/**
 * Fixed-target, source-pinned deploy/readback guard for the public test gateway.
 * Deployment requires an explicit service-name confirmation. It creates a
 * no-traffic revision, verifies its immutable image and preserved settings,
 * switches traffic to that exact ready revision, then verifies again. Any
 * failed stage or post-switch check restores the captured revision.
 */

import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  GCP_PRIVATE_TEST_BUILD,
  GCP_PRIVATE_TEST_TARGET,
  assessCloudBuildProvenance,
  assessLocalCloudBuildSourceArchive,
} from "./gcp-private-test-deploy.mjs";
import { createCloudRunBuildArchive } from "./cloud-run-build-archive.mjs";

export const GCP_TEST_GATEWAY_TARGET = Object.freeze({
  project: GCP_PRIVATE_TEST_TARGET.project,
  projectNumber: GCP_PRIVATE_TEST_TARGET.projectNumber,
  region: GCP_PRIVATE_TEST_TARGET.region,
  service: "tibotattle-test-oauth-gateway",
  runtimeServiceAccount:
    "tibotattle-test-oauth-gateway@tibotattle.iam.gserviceaccount.com",
  publicOrigin: "https://tibotattle-test-oauth-gateway-806510610397.us-east1.run.app",
  backendOrigin: GCP_PRIVATE_TEST_TARGET.hostOrigin,
  logSink: "_Default",
  logExclusionName: "tibotattle_test_oauth_gateway_requests",
});

export const GCP_TEST_GATEWAY_STAGE_TAG = "codex-stage";
const READINESS_POLL_ATTEMPTS = 30;
const READINESS_POLL_INTERVAL_MS = 1_000;

const IMAGE_REFERENCE = new RegExp(
  "^" + GCP_PRIVATE_TEST_TARGET.imageRepository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    + "@sha256:([a-f0-9]{64})$",
  "u",
);
const DIGEST = /^[a-f0-9]{64}$/u;
const BUILD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const GENERATION = /^[1-9]\d{0,19}$/u;
const EXPECTED_LOG_FILTER =
  'resource.type="cloud_run_revision" AND resource.labels.service_name="tibotattle-test-oauth-gateway" AND log_id("run.googleapis.com/requests")';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(stdout, code) {
  try {
    const value = JSON.parse(stdout);
    if (!isRecord(value)) fail(code);
    return value;
  } catch {
    fail(code);
  }
}

function exactRecord(value, expected) {
  return isRecord(value)
    && Object.keys(value).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function revisionName(value) {
  if (typeof value !== "string") return null;
  const name = value.split("/").at(-1);
  return name.length > 0 ? name : null;
}

function serviceStatus(service) {
  return service?.status ?? service;
}

function latestReadyRevisionName(service) {
  const status = serviceStatus(service);
  return revisionName(status?.latestReadyRevisionName ?? status?.latestReadyRevision);
}

function latestCreatedRevisionName(service) {
  const status = serviceStatus(service);
  return revisionName(status?.latestCreatedRevisionName ?? status?.latestCreatedRevision);
}

function serviceGenerationObserved(service) {
  const generation = service?.metadata?.generation ?? service?.generation;
  const observed = serviceStatus(service)?.observedGeneration;
  if (generation === undefined || observed === undefined) return false;
  const parse = (value) => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === "string" && /^\d+$/u.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
    return null;
  };
  const desired = parse(generation);
  return desired !== null && desired === parse(observed);
}

function conditionReady(condition) {
  if (!condition) return false;
  const signals = [];
  if (condition.status !== undefined) signals.push(condition.status === "True");
  if (condition.state !== undefined) signals.push(condition.state === "CONDITION_SUCCEEDED");
  return signals.length > 0 && signals.every(Boolean);
}

function serviceReady(service) {
  const status = serviceStatus(service);
  const condition = status?.terminalCondition
    ?? status?.conditions?.find((entry) => entry?.type === "Ready");
  return conditionReady(condition);
}

function revisionReady(revision) {
  const condition = revision?.status?.conditions?.find((entry) => entry?.type === "Ready")
    ?? revision?.status?.terminalCondition;
  return conditionReady(condition)
    && !(typeof condition?.reason === "string" && /retired/iu.test(condition.reason));
}

function ingress(service) {
  return service?.metadata?.annotations?.["run.googleapis.com/ingress"]
    ?? service?.ingress
    ?? null;
}

function invokerIamCheckEnabled(service) {
  const values = [
    service?.invokerIamDisabled,
    service?.metadata?.annotations?.["run.googleapis.com/invoker-iam-disabled"],
    service?.spec?.template?.metadata?.annotations?.["run.googleapis.com/invoker-iam-disabled"],
  ].filter((value) => value !== undefined);
  return !values.some((value) => value === true || value === "true")
    && values.every((value) => value === false || value === "false");
}

function revisionSpec(revision) {
  return revision?.spec ?? revision?.template ?? {};
}

function revisionContainer(revision) {
  const spec = revisionSpec(revision);
  return spec?.containers?.[0] ?? spec?.template?.spec?.containers?.[0] ?? null;
}

function revisionServiceAccount(revision) {
  const spec = revisionSpec(revision);
  return spec?.serviceAccountName ?? spec?.serviceAccount
    ?? spec?.template?.spec?.serviceAccountName ?? null;
}

function revisionEnvironment(revision) {
  const values = revisionContainer(revision)?.env;
  return Array.isArray(values) ? values : [];
}

function exactEnvironmentValue(revision, name, expected) {
  const matches = revisionEnvironment(revision).filter((entry) => entry?.name === name);
  return matches.length === 1 && exactRecord(matches[0], { name, value: expected });
}

function exactGatewayEnvironmentReady(revision, expectedEnvironment) {
  const entries = revisionEnvironment(revision);
  const expectedNames = Object.keys(expectedEnvironment);
  return entries.length === expectedNames.length
    && expectedNames.every((name) => exactEnvironmentValue(revision, name, expectedEnvironment[name]))
    && entries.every((entry) => typeof entry?.name === "string"
      && Object.hasOwn(expectedEnvironment, entry.name)
      && exactRecord(entry, { name: entry.name, value: expectedEnvironment[entry.name] }));
}

function revisionImage(revision) {
  return revisionContainer(revision)?.image ?? null;
}

function serviceTemplateImage(service) {
  return service?.spec?.template?.spec?.containers?.[0]?.image
    ?? service?.spec?.template?.containers?.[0]?.image
    ?? null;
}

function serviceTraffic(service) {
  const status = serviceStatus(service);
  return status?.traffic ?? status?.trafficStatuses;
}

function singleActiveTrafficRevisionName(service) {
  const traffic = serviceTraffic(service);
  if (!Array.isArray(traffic) || traffic.some((entry) => !isRecord(entry)
      || (entry.percent === undefined && typeof entry.tag === "string"
        ? false
        : !Number.isSafeInteger(entry.percent) || entry.percent < 0 || entry.percent > 100))) {
    return null;
  }
  const active = traffic.filter((entry) => (entry.percent ?? 0) > 0);
  if (active.length !== 1 || active[0].percent !== 100) return null;
  return revisionName(active[0].revisionName ?? active[0].revision);
}

function stageTagAssignments(service) {
  const traffic = serviceTraffic(service);
  if (!Array.isArray(traffic)) return [];
  return traffic.filter((entry) => entry?.tag === GCP_TEST_GATEWAY_STAGE_TAG);
}

function stageTagRevisionName(service) {
  const matches = stageTagAssignments(service);
  if (matches.length !== 1) return null;
  return revisionName(matches[0].revisionName ?? matches[0].revision);
}

function stageTagStateReady(service, expectedRevision) {
  const matches = stageTagAssignments(service);
  if (expectedRevision === null) return matches.length === 0;
  return matches.length === 1
    && revisionName(matches[0].revisionName ?? matches[0].revision) === expectedRevision
    && (matches[0].percent === undefined || matches[0].percent === 0);
}

function trafficToRevision(service, expectedRevision, { requireReady = true } = {}) {
  const status = serviceStatus(service);
  const traffic = status?.traffic ?? status?.trafficStatuses;
  if (!Array.isArray(traffic) || (requireReady && !serviceReady(service))
      || !serviceGenerationObserved(service)) {
    return false;
  }
  if (traffic.some((entry) => !isRecord(entry)
      || (entry.percent === undefined && typeof entry.tag === "string"
        ? false
        : !Number.isSafeInteger(entry.percent) || entry.percent < 0 || entry.percent > 100))) {
    return false;
  }
  const active = traffic.filter((entry) => (entry.percent ?? 0) > 0);
  return active.length === 1
    && active[0].percent === 100
    && revisionName(active[0].revisionName ?? active[0].revision) === expectedRevision;
}

function publicGatewayIamReady(policy) {
  const bindings = policy?.bindings;
  // The reviewed gateway policy has one public invoker binding. Extra members
  // or roles are unreviewed access drift, even when they are not public.
  if (!Array.isArray(bindings) || bindings.length !== 1) return false;
  const binding = bindings[0];
  return isRecord(binding)
    && Object.keys(binding).length === 2
    && binding.role === "roles/run.invoker"
    && Array.isArray(binding.members)
    && binding.members.length === 1
    && binding.members[0] === "allUsers";
}

function requestLogExclusionReady(sink) {
  if (sink?.name !== GCP_TEST_GATEWAY_TARGET.logSink || !Array.isArray(sink.exclusions)) {
    return false;
  }
  const matches = sink.exclusions.filter((entry) =>
    entry?.name === GCP_TEST_GATEWAY_TARGET.logExclusionName,
  );
  if (matches.length !== 1
      || (matches[0].disabled !== undefined && matches[0].disabled !== false)) return false;
  return typeof matches[0].filter === "string"
    && matches[0].filter.replace(/\s+/gu, " ").trim() === EXPECTED_LOG_FILTER;
}

export function assessGatewayReadback({
  service,
  policy,
  sink,
  revision,
  expectedImage,
  expectedTrafficRevision,
  expectedTemplateImage,
  expectedStageTagRevision = null,
  requireRevisionReady = true,
  requireServiceReady = true,
} = {}) {
  const blockers = [];
  if (!isRecord(service) || !isRecord(policy) || !isRecord(sink) || !isRecord(revision)) {
    return Object.freeze({ ok: false, blockers: Object.freeze(["GCP_GATEWAY_READBACK_MISSING"]) });
  }
  if (service?.metadata?.name !== GCP_TEST_GATEWAY_TARGET.service) {
    blockers.push("GCP_GATEWAY_SERVICE_IDENTITY_UNQUALIFIED");
  }
  if ((requireServiceReady && !serviceReady(service))
      || (requireRevisionReady && !revisionReady(revision))) {
    blockers.push("GCP_GATEWAY_REVISION_NOT_READY");
  }
  const actualRevision = revisionName(revision?.metadata?.name);
  const revisionService = revision?.metadata?.labels?.["serving.knative.dev/service"];
  if (revisionService !== undefined && revisionService !== GCP_TEST_GATEWAY_TARGET.service) {
    blockers.push("GCP_GATEWAY_REVISION_SERVICE_MISMATCH");
  }
  if (ingress(service) !== "all" && ingress(service) !== "INGRESS_TRAFFIC_ALL") {
    blockers.push("GCP_GATEWAY_PUBLIC_INGRESS_UNQUALIFIED");
  }
  if (!invokerIamCheckEnabled(service) || !publicGatewayIamReady(policy)) {
    blockers.push("GCP_GATEWAY_PUBLIC_IAM_UNQUALIFIED");
  }
  if (revisionServiceAccount(revision) !== GCP_TEST_GATEWAY_TARGET.runtimeServiceAccount) {
    blockers.push("GCP_GATEWAY_RUNTIME_ACCOUNT_UNQUALIFIED");
  }
  const expectedTemplate = expectedTemplateImage ?? revisionImage(revision);
  if (!expectedTemplate || serviceTemplateImage(service) !== expectedTemplate) {
    blockers.push("GCP_GATEWAY_SERVICE_TEMPLATE_IMAGE_MISMATCH");
  }
  const expectedTraffic = expectedTrafficRevision ?? actualRevision;
  if (!expectedTraffic || !trafficToRevision(service, expectedTraffic)) {
    blockers.push("GCP_GATEWAY_TRAFFIC_REVISION_UNQUALIFIED");
  }
  if (!stageTagStateReady(service, expectedStageTagRevision)) {
    blockers.push("GCP_GATEWAY_STAGE_TAG_STATE_UNQUALIFIED");
  }
  const expectedEnvironment = {
    OAUTH_GATEWAY_MODE: "test-only",
    OAUTH_GATEWAY_PUBLIC_ORIGIN: GCP_TEST_GATEWAY_TARGET.publicOrigin,
    OAUTH_GATEWAY_BACKEND_ORIGIN: GCP_TEST_GATEWAY_TARGET.backendOrigin,
    OAUTH_GATEWAY_BACKEND_AUDIENCE: GCP_TEST_GATEWAY_TARGET.backendOrigin,
  };
  // The live gateway has exactly these four configured variables. Reject
  // unreviewed toggles and secret references without including values in results.
  if (!exactGatewayEnvironmentReady(revision, expectedEnvironment)) {
    blockers.push("GCP_GATEWAY_ENVIRONMENT_UNQUALIFIED");
  }
  const image = revisionImage(revision);
  if (!IMAGE_REFERENCE.test(image ?? "") || (expectedImage && image !== expectedImage)) {
    blockers.push("GCP_GATEWAY_IMAGE_DIGEST_UNQUALIFIED");
  }
  if (!requestLogExclusionReady(sink)) {
    blockers.push("GCP_GATEWAY_REQUEST_LOG_EXCLUSION_UNQUALIFIED");
  }
  return Object.freeze({
    ok: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    revision: actualRevision,
    image: IMAGE_REFERENCE.test(image ?? "") ? image : null,
  });
}

export function parseArgs(argv) {
  const command = argv[0] ?? "preflight";
  if (!["preflight", "verify", "deploy"].includes(command)) {
    fail("GCP_GATEWAY_COMMAND_INVALID");
  }
  const allowed = new Set([
    "--image", "--source-digest", "--build-id", "--source-archive",
    "--source-archive-sha256", "--source-bucket", "--source-object",
    "--source-generation", "--confirm-test-gateway-deploy",
  ]);
  const values = new Map();
  for (const argument of argv.slice(1)) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) fail("GCP_GATEWAY_ARGUMENT_INVALID");
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (!allowed.has(name) || value.length === 0 || values.has(name)) {
      fail("GCP_GATEWAY_ARGUMENT_INVALID");
    }
    values.set(name, value);
  }
  const config = Object.freeze({
    command,
    project: GCP_TEST_GATEWAY_TARGET.project,
    region: GCP_TEST_GATEWAY_TARGET.region,
    service: GCP_TEST_GATEWAY_TARGET.service,
    image: values.get("--image") ?? "",
    sourceDigest: values.get("--source-digest") ?? "",
    buildId: values.get("--build-id") ?? "",
    sourceArchivePath: values.get("--source-archive") ?? "",
    sourceArchiveSha256: values.get("--source-archive-sha256") ?? "",
    sourceBucket: values.get("--source-bucket") ?? "",
    sourceObject: values.get("--source-object") ?? "",
    sourceGeneration: values.get("--source-generation") ?? "",
    confirmation: values.get("--confirm-test-gateway-deploy") ?? "",
  });
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  if (!isRecord(config) || !["preflight", "verify", "deploy"].includes(config.command)
      || config.project !== GCP_TEST_GATEWAY_TARGET.project
      || config.region !== GCP_TEST_GATEWAY_TARGET.region
      || config.service !== GCP_TEST_GATEWAY_TARGET.service) {
    fail("GCP_GATEWAY_TARGET_FIXED");
  }
  const provenanceValues = [
    config.sourceDigest,
    config.buildId,
    config.sourceArchivePath,
    config.sourceArchiveSha256,
    config.sourceBucket,
    config.sourceObject,
    config.sourceGeneration,
  ];
  const hasAnyProvenance = provenanceValues.some((value) => value !== "");
  const requiresProvenance = config.command === "verify" || config.command === "deploy";
  if (config.command === "preflight" && (hasAnyProvenance || config.image !== "")) {
    fail("GCP_GATEWAY_PREFLIGHT_READ_ONLY_ARGUMENTS_INVALID");
  }
  if (requiresProvenance) {
    if (!IMAGE_REFERENCE.test(config.image ?? "")) fail("GCP_GATEWAY_IMAGE_DIGEST_REQUIRED");
    if (!DIGEST.test(config.sourceDigest ?? "")) fail("GCP_GATEWAY_SOURCE_DIGEST_REQUIRED");
    if (!BUILD_ID.test(config.buildId ?? "")) fail("GCP_GATEWAY_BUILD_ID_INVALID");
    if (typeof config.sourceArchivePath !== "string" || !isAbsolute(config.sourceArchivePath)) {
      fail("GCP_GATEWAY_SOURCE_ARCHIVE_PATH_INVALID");
    }
    if (!DIGEST.test(config.sourceArchiveSha256 ?? "")) {
      fail("GCP_GATEWAY_SOURCE_ARCHIVE_SHA256_INVALID");
    }
    if (config.sourceBucket !== GCP_PRIVATE_TEST_TARGET.buildBucket) {
      fail("GCP_GATEWAY_SOURCE_BUCKET_UNEXPECTED");
    }
    const expectedObject = GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix + config.sourceDigest
      + "-" + config.sourceArchiveSha256 + ".tar.gz";
    if (config.sourceObject !== expectedObject) fail("GCP_GATEWAY_SOURCE_OBJECT_UNEXPECTED");
    if (!GENERATION.test(config.sourceGeneration ?? "")) {
      fail("GCP_GATEWAY_SOURCE_GENERATION_INVALID");
    }
  }
  if (config.command === "deploy"
      ? config.confirmation !== GCP_TEST_GATEWAY_TARGET.service
      : config.confirmation !== "") {
    fail("GCP_GATEWAY_DEPLOY_CONFIRMATION_REQUIRED");
  }
  return true;
}

function spawnGcloud(args, spawn = spawnSync) {
  let result;
  try {
    result = spawn("gcloud", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    fail("GCP_GATEWAY_GCLOUD_UNAVAILABLE");
  }
  if (result?.status !== 0) fail("GCP_GATEWAY_GCLOUD_COMMAND_FAILED");
  return result.stdout ?? "";
}

function readJsonGcloud(args, code, spawn) {
  return parseJson(spawnGcloud(args, spawn), code);
}

function readGatewayService(spawn) {
  return readJsonGcloud([
    "run", "services", "describe", GCP_TEST_GATEWAY_TARGET.service,
    "--project=" + GCP_TEST_GATEWAY_TARGET.project,
    "--region=" + GCP_TEST_GATEWAY_TARGET.region,
    "--format=json",
  ], "GCP_GATEWAY_SERVICE_READBACK_INVALID", spawn);
}

async function readGatewayState(spawn) {
  const args = [
    "--project=" + GCP_TEST_GATEWAY_TARGET.project,
    "--region=" + GCP_TEST_GATEWAY_TARGET.region,
  ];
  const service = readGatewayService(spawn);
  const policy = readJsonGcloud([
    "run", "services", "get-iam-policy", GCP_TEST_GATEWAY_TARGET.service,
    ...args, "--format=json",
  ], "GCP_GATEWAY_IAM_READBACK_INVALID", spawn);
  const sink = readJsonGcloud([
    "logging", "sinks", "describe", GCP_TEST_GATEWAY_TARGET.logSink,
    "--project=" + GCP_TEST_GATEWAY_TARGET.project, "--format=json",
  ], "GCP_GATEWAY_LOG_SINK_READBACK_INVALID", spawn);
  return Object.freeze({ service, policy, sink });
}

function readRevisionNamed(name, spawn) {
  const revision = revisionName(name);
  if (!revision) fail("GCP_GATEWAY_LATEST_READY_REVISION_MISSING");
  return readJsonGcloud([
    "run", "revisions", "describe", revision,
    "--project=" + GCP_TEST_GATEWAY_TARGET.project,
    "--region=" + GCP_TEST_GATEWAY_TARGET.region,
    "--format=json",
  ], "GCP_GATEWAY_REVISION_READBACK_INVALID", spawn);
}

function readRevision(service, spawn) {
  const name = singleActiveTrafficRevisionName(service)
    ?? latestReadyRevisionName(service);
  if (!name) fail("GCP_GATEWAY_ACTIVE_TRAFFIC_REVISION_MISSING");
  return readRevisionNamed(name, spawn);
}

function readServiceAndRevision(spawn) {
  return readGatewayState(spawn).then((state) => ({
    ...state,
    revision: readRevision(state.service, spawn),
  }));
}

function buildProvenanceConfig(config) {
  return {
    ...config,
    project: GCP_TEST_GATEWAY_TARGET.project,
    region: GCP_TEST_GATEWAY_TARGET.region,
  };
}

async function assessSourceProvenance(config, { spawn, archiveBuilder }) {
  const checked = await assessLocalCloudBuildSourceArchive(buildProvenanceConfig(config), {
    archiveBuilder,
  });
  if (!checked.ok) return Object.freeze({
    ok: false,
    blockers: Object.freeze(["SOURCE_ARCHIVE_UNQUALIFIED", ...checked.blockers]),
    local: checked,
    build: null,
  });
  let build;
  try {
    build = assessCloudBuildProvenance({
      build: readJsonGcloud([
        "builds", "describe", config.buildId,
        "--project=" + GCP_TEST_GATEWAY_TARGET.project,
        "--region=" + GCP_TEST_GATEWAY_TARGET.region,
        "--format=json",
      ], "GCP_GATEWAY_BUILD_READBACK_INVALID", spawn),
      config: buildProvenanceConfig(config),
    });
  } catch {
    build = Object.freeze({
      ok: false,
      blockers: Object.freeze(["GCP_BUILD_READBACK_UNAVAILABLE"]),
    });
  }
  if (build.ok && build.image !== config.image) {
    build = Object.freeze({
      ...build,
      ok: false,
      blockers: Object.freeze(["GCP_GATEWAY_IMAGE_BUILD_MISMATCH"]),
    });
  }
  return Object.freeze({
    ok: checked.ok && build.ok,
    blockers: build.ok ? [] : build.blockers,
    local: checked,
    build,
  });
}

function gatewayAssessment(state, options = {}) {
  return assessGatewayReadback({
    service: state.service,
    policy: state.policy,
    sink: state.sink,
    revision: state.revision,
    ...options,
  });
}

function updateTrafficArgs(revision, { removeStageTag = true } = {}) {
  return [
    "run", "services", "update-traffic", GCP_TEST_GATEWAY_TARGET.service,
    "--to-revisions=" + revision + "=100",
    ...(removeStageTag ? ["--remove-tags=" + GCP_TEST_GATEWAY_STAGE_TAG] : []),
    "--project=" + GCP_TEST_GATEWAY_TARGET.project,
    "--region=" + GCP_TEST_GATEWAY_TARGET.region,
    "--quiet",
  ];
}

function updateStageTagArgs(revision) {
  return [
    "run", "services", "update-traffic", GCP_TEST_GATEWAY_TARGET.service,
    "--update-tags=" + GCP_TEST_GATEWAY_STAGE_TAG + "=" + revision,
    "--project=" + GCP_TEST_GATEWAY_TARGET.project,
    "--region=" + GCP_TEST_GATEWAY_TARGET.region,
    "--quiet",
  ];
}

function restoreTemplateArgs(image) {
  return [
    "run", "services", "update", GCP_TEST_GATEWAY_TARGET.service,
    "--image=" + image,
    "--no-traffic",
    "--project=" + GCP_TEST_GATEWAY_TARGET.project,
    "--region=" + GCP_TEST_GATEWAY_TARGET.region,
    "--quiet",
  ];
}

function stageUpdateArgs(image) {
  return [
    "run", "services", "update", GCP_TEST_GATEWAY_TARGET.service,
    "--image=" + image,
    "--no-traffic",
    "--tag=" + GCP_TEST_GATEWAY_STAGE_TAG,
    "--project=" + GCP_TEST_GATEWAY_TARGET.project,
    "--region=" + GCP_TEST_GATEWAY_TARGET.region,
    "--quiet",
  ];
}

function stageMutationState(service, rollbackRevision, candidateRevision = null) {
  const taggedRevision = stageTagRevisionName(service);
  return taggedRevision !== null
    && (candidateRevision === null || taggedRevision === candidateRevision)
    && trafficToRevision(service, rollbackRevision);
}

async function waitForStagedRevision({
  rollbackRevision,
  expectedImage,
  spawn,
  sleepFn = sleep,
  knownRevision = null,
  maxAttempts = READINESS_POLL_ATTEMPTS,
  intervalMs = READINESS_POLL_INTERVAL_MS,
}) {
  let candidateRevision = knownRevision;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let service;
    try {
      service = readGatewayService(spawn);
    } catch {
      if (attempt + 1 < maxAttempts) await sleepFn(intervalMs);
      continue;
    }
    const latestCreated = latestCreatedRevisionName(service);
    const taggedRevision = stageTagRevisionName(service);
    if (taggedRevision) {
      if (candidateRevision && taggedRevision !== candidateRevision) {
        return Object.freeze({
          ok: false,
          kind: "unrelated_revision",
          candidateRevision,
          observedRevision: taggedRevision,
        });
      }
      candidateRevision = taggedRevision;
    }
    if (!candidateRevision && latestCreated && latestCreated !== rollbackRevision
        && serviceTemplateImage(service) === expectedImage) {
      candidateRevision = latestCreated;
    }
    if (candidateRevision && latestCreated && latestCreated !== candidateRevision
        && latestCreated !== rollbackRevision) {
      return Object.freeze({
        ok: false,
        kind: "unrelated_revision",
        candidateRevision,
        observedRevision: latestCreated,
      });
    }
    if (candidateRevision && latestCreated === candidateRevision
        && stageTagStateReady(service, candidateRevision)
        && serviceGenerationObserved(service)) {
      try {
        const revision = readRevisionNamed(candidateRevision, spawn);
        if (revisionReady(revision)) {
          return Object.freeze({
            ok: true,
            kind: "ready",
            candidateRevision,
            service,
            revision,
            expectedImageMatches: revisionImage(revision) === expectedImage,
          });
        }
      } catch {
        // Cloud Run may publish the service revision before its revision readback.
      }
    }
    if (attempt + 1 < maxAttempts) await sleepFn(intervalMs);
  }
  return Object.freeze({
    ok: false,
    kind: "timeout",
    candidateRevision,
  });
}

async function waitForRollbackReadback({ revision, image, spawn, sleepFn = sleep }) {
  let lastBlockers = ["GCP_GATEWAY_ROLLBACK_READBACK_FAILED"];
  for (let attempt = 0; attempt < READINESS_POLL_ATTEMPTS; attempt += 1) {
    try {
      const state = await readServiceAndRevision(spawn);
      const assessment = gatewayAssessment(state, {
        expectedImage: image,
        expectedTemplateImage: image,
        expectedTrafficRevision: revision,
        expectedStageTagRevision: null,
        requireServiceReady: false,
      });
      if (assessment.ok) return Object.freeze({ ok: true, blockers: Object.freeze([]) });
      lastBlockers = assessment.blockers;
    } catch {
      lastBlockers = ["GCP_GATEWAY_ROLLBACK_READBACK_FAILED"];
    }
    if (attempt + 1 < READINESS_POLL_ATTEMPTS) await sleepFn(READINESS_POLL_INTERVAL_MS);
  }
  return Object.freeze({ ok: false, blockers: Object.freeze(lastBlockers) });
}

async function cleanupStageTagAfterConcurrentRevision({
  rollbackRevision,
  candidateRevision,
  spawn,
}) {
  let service;
  try {
    service = readGatewayService(spawn);
  } catch {
    return Object.freeze({
      attempted: false,
      ok: false,
      complete: false,
      blockers: Object.freeze(["GCP_GATEWAY_CONCURRENT_STATE_UNAVAILABLE"]),
    });
  }
  if (!stageMutationState(service, rollbackRevision, candidateRevision)) {
    return Object.freeze({
      attempted: false,
      ok: false,
      complete: false,
      blockers: Object.freeze(["GCP_GATEWAY_CONCURRENT_STATE_NOT_OWNED"]),
    });
  }
  try {
    spawnGcloud([
      "run", "services", "update-traffic", GCP_TEST_GATEWAY_TARGET.service,
      "--remove-tags=" + GCP_TEST_GATEWAY_STAGE_TAG,
      "--project=" + GCP_TEST_GATEWAY_TARGET.project,
      "--region=" + GCP_TEST_GATEWAY_TARGET.region,
      "--quiet",
    ], spawn);
  } catch {
    return Object.freeze({
      attempted: true,
      ok: false,
      complete: false,
      blockers: Object.freeze(["GCP_GATEWAY_CONCURRENT_STAGE_TAG_CLEANUP_FAILED"]),
    });
  }
  try {
    service = readGatewayService(spawn);
  } catch {
    return Object.freeze({
      attempted: true,
      ok: false,
      complete: false,
      blockers: Object.freeze(["GCP_GATEWAY_CONCURRENT_CLEANUP_READBACK_FAILED"]),
    });
  }
  const cleaned = stageTagAssignments(service).length === 0
    && trafficToRevision(service, rollbackRevision);
  return Object.freeze({
    attempted: true,
    ok: false,
    complete: false,
    stageTagRemoved: cleaned,
    templateRestored: false,
    blockers: Object.freeze([cleaned
      ? "GCP_GATEWAY_CONCURRENT_TEMPLATE_RESTORE_DEFERRED"
      : "GCP_GATEWAY_CONCURRENT_CLEANUP_UNVERIFIED"]),
  });
}

async function waitForTrafficRevision({
  revision,
  image,
  spawn,
  sleepFn = sleep,
  maxAttempts = READINESS_POLL_ATTEMPTS,
  intervalMs = READINESS_POLL_INTERVAL_MS,
}) {
  let lastAssessment = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const state = await readServiceAndRevision(spawn);
      lastAssessment = gatewayAssessment(state, {
        expectedImage: image,
        expectedTemplateImage: image,
        expectedTrafficRevision: revision,
        expectedStageTagRevision: null,
      });
      if (lastAssessment.ok && lastAssessment.revision === revision) {
        return Object.freeze({ ok: true, state, assessment: lastAssessment });
      }
    } catch {
      lastAssessment = null;
    }
    if (attempt + 1 < maxAttempts) await sleepFn(intervalMs);
  }
  return Object.freeze({
    ok: false,
    assessment: lastAssessment,
    blockers: Object.freeze(lastAssessment?.blockers
      ?? ["GCP_GATEWAY_POSTDEPLOY_READBACK_FAILED"]),
  });
}

async function restoreCapturedRevision({ revision, image, spawn, sleepFn = sleep }) {
  const blockers = [];
  try {
    spawnGcloud(updateTrafficArgs(revision), spawn);
  } catch {
    blockers.push("GCP_GATEWAY_ROLLBACK_TRAFFIC_UPDATE_FAILED");
  }
  let templateRestoreAttempted = false;
  try {
    const service = readGatewayService(spawn);
    if (serviceTemplateImage(service) !== image) {
      templateRestoreAttempted = true;
      spawnGcloud(restoreTemplateArgs(image), spawn);
    }
  } catch {
    blockers.push("GCP_GATEWAY_ROLLBACK_TEMPLATE_RESTORE_FAILED");
  }
  const readback = await waitForRollbackReadback({ revision, image, spawn, sleepFn });
  blockers.push(...readback.blockers);
  return Object.freeze({
    attempted: true,
    ok: blockers.length === 0,
    complete: readback.ok,
    templateRestoreAttempted,
    templateRestored: readback.ok,
    stageTagRemoved: readback.ok,
    revision,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

async function restoreAfterFailedNoTrafficUpdate({ revision, image, spawn, sleepFn = sleep }) {
  for (let attempt = 0; attempt < READINESS_POLL_ATTEMPTS; attempt += 1) {
    let service;
    try {
      service = readGatewayService(spawn);
    } catch {
      if (attempt + 1 === READINESS_POLL_ATTEMPTS) {
        return Object.freeze({
          attempted: false,
          ok: false,
          complete: false,
          revision,
          blockers: Object.freeze(["GCP_GATEWAY_MUTATION_STATE_UNAVAILABLE"]),
        });
      }
    }
    if (service) {
      const changed = latestCreatedRevisionName(service) !== revision
        || serviceTemplateImage(service) !== image
        || stageTagAssignments(service).length > 0
        || !trafficToRevision(service, revision);
      if (changed) return restoreCapturedRevision({ revision, image, spawn, sleepFn });
    }
    if (attempt + 1 < READINESS_POLL_ATTEMPTS) await sleepFn(READINESS_POLL_INTERVAL_MS);
  }
  return Object.freeze({
    attempted: false,
    ok: true,
    complete: true,
    templateRestored: true,
    stageTagRemoved: true,
    revision,
    blockers: Object.freeze([]),
  });
}

function deploymentProvenanceResult(config, provenance) {
  return Object.freeze({
    buildId: config.buildId,
    sourceGeneration: provenance.build.sourceGeneration,
    sourceArchiveSha256: provenance.local.sourceArchiveSha256,
    image: provenance.build.image,
  });
}

export async function runGcpTestGatewayDeployment({
  config,
  spawn = spawnSync,
  archiveBuilder = createCloudRunBuildArchive,
  sleepFn = sleep,
  pollAttempts = READINESS_POLL_ATTEMPTS,
  pollIntervalMs = READINESS_POLL_INTERVAL_MS,
} = {}) {
  validateConfig(config);
  let provenance = null;
  if (config.command !== "preflight") {
    provenance = await assessSourceProvenance(config, { spawn, archiveBuilder });
    if (!provenance.ok) return Object.freeze({
      status: "blocked",
      blockers: provenance.blockers,
      readOnlyAssessment: true,
    });
  }

  let initial;
  try {
    initial = await readServiceAndRevision(spawn);
  } catch {
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze(["GCP_GATEWAY_INITIAL_READBACK_FAILED"]),
      readOnlyAssessment: true,
    });
  }
  let initialAssessment = gatewayAssessment(initial, {
    ...(config.command === "verify" ? { expectedImage: config.image } : {}),
    ...(config.command === "deploy"
      ? { expectedTemplateImage: serviceTemplateImage(initial.service) }
      : {}),
  });
  if (config.command === "preflight") return Object.freeze({
    status: initialAssessment.ok ? "ready" : "blocked",
    blockers: initialAssessment.blockers,
    readOnlyAssessment: true,
    currentRevision: initialAssessment.revision,
    currentImage: initialAssessment.image,
    routeSmoke: "not_run_application_device_token_required",
  });
  if (config.command === "verify") return Object.freeze({
    status: initialAssessment.ok ? "verified" : "blocked",
    blockers: initialAssessment.blockers,
    readOnlyAssessment: true,
    sourceProvenance: deploymentProvenanceResult(config, provenance),
    revision: initialAssessment.revision,
    image: initialAssessment.image,
    routeSmoke: "not_run_application_device_token_required",
  });
  const activeRevision = initialAssessment.revision;
  const activeImage = initialAssessment.image;
  const templateImage = serviceTemplateImage(initial.service);
  let reusableCandidate = null;
  if (templateImage !== activeImage && templateImage === config.image
      && initialAssessment.ok) {
    const latestCreated = latestCreatedRevisionName(initial.service);
    if (latestCreated && latestCreated !== activeRevision) {
      try {
        const candidate = readRevisionNamed(latestCreated, spawn);
        const assessment = gatewayAssessment({ ...initial, revision: candidate }, {
          expectedImage: config.image,
          expectedTemplateImage: config.image,
          expectedTrafficRevision: activeRevision,
          requireRevisionReady: false,
        });
        if (assessment.ok) reusableCandidate = latestCreated;
      } catch {
        reusableCandidate = null;
      }
    }
    // A prior no-traffic update left this exact image as the latest-created
    // revision. Tag and qualify it in place instead of making a duplicate.
  }
  if (!initialAssessment.ok) return Object.freeze({
    status: "blocked",
    blockers: Object.freeze(["GCP_GATEWAY_PREDEPLOY_READBACK_UNQUALIFIED", ...initialAssessment.blockers]),
    preDeployReadOnlyAssessment: true,
  });
  if (templateImage !== activeImage && !reusableCandidate) return Object.freeze({
    status: "blocked",
    blockers: Object.freeze([
      "GCP_GATEWAY_PREDEPLOY_READBACK_UNQUALIFIED",
      "GCP_GATEWAY_SERVICE_TEMPLATE_IMAGE_MISMATCH",
    ]),
    preDeployReadOnlyAssessment: true,
  });
  if (activeImage === config.image) return Object.freeze({
    status: "blocked",
    blockers: Object.freeze(["GCP_GATEWAY_IMAGE_ALREADY_SERVING_USE_VERIFY"]),
    preDeployReadOnlyAssessment: true,
  });

  const rollbackRevision = activeRevision;
  const rollbackImage = activeImage;
  try {
    if (reusableCandidate) {
      spawnGcloud(updateStageTagArgs(reusableCandidate), spawn);
    } else {
      spawnGcloud(stageUpdateArgs(config.image), spawn);
    }
  } catch {
    const rollback = await restoreAfterFailedNoTrafficUpdate({
      revision: rollbackRevision,
      image: rollbackImage,
      spawn,
      sleepFn,
    });
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze(["GCP_GATEWAY_NO_TRAFFIC_STAGE_FAILED"]),
      rollback,
    });
  }

  const stagedReady = await waitForStagedRevision({
    rollbackRevision,
    expectedImage: config.image,
    spawn,
    sleepFn,
    knownRevision: reusableCandidate,
    maxAttempts: pollAttempts,
    intervalMs: pollIntervalMs,
  });
  if (!stagedReady.ok && stagedReady.kind === "unrelated_revision") {
    const rollback = await cleanupStageTagAfterConcurrentRevision({
      rollbackRevision,
      candidateRevision: stagedReady.candidateRevision,
      spawn,
    });
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze(["GCP_GATEWAY_STAGED_REVISION_CHANGED"]),
      rollback,
    });
  }
  if (!stagedReady.ok) {
    const rollback = await restoreCapturedRevision({
      revision: rollbackRevision,
      image: rollbackImage,
      spawn,
      sleepFn,
    });
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze([stagedReady.kind === "timeout"
        ? "GCP_GATEWAY_STAGED_REVISION_READINESS_TIMEOUT"
        : "GCP_GATEWAY_STAGED_REVISION_READBACK_FAILED"]),
      rollback,
    });
  }

  let staged;
  let stagedAssessment;
  try {
    const state = await readGatewayState(spawn);
    const candidate = readRevisionNamed(stagedReady.candidateRevision, spawn);
    staged = { ...state, revision: candidate };
    if (latestCreatedRevisionName(state.service) !== stagedReady.candidateRevision) {
      stagedAssessment = Object.freeze({
        ok: false,
        blockers: Object.freeze(["GCP_GATEWAY_STAGED_REVISION_CHANGED"]),
      });
    } else {
      stagedAssessment = gatewayAssessment(staged, {
        expectedImage: config.image,
        expectedTemplateImage: config.image,
        expectedTrafficRevision: rollbackRevision,
        expectedStageTagRevision: stagedReady.candidateRevision,
      });
    }
  } catch {
    stagedAssessment = Object.freeze({
      ok: false,
      blockers: Object.freeze(["GCP_GATEWAY_STAGED_READBACK_FAILED"]),
    });
  }
  if (!stagedAssessment.ok) {
    const rollback = await restoreCapturedRevision({
      revision: rollbackRevision,
      image: rollbackImage,
      spawn,
      sleepFn,
    });
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze(["GCP_GATEWAY_STAGED_REVISION_UNQUALIFIED", ...stagedAssessment.blockers]),
      rollback,
    });
  }

  try {
    spawnGcloud(updateTrafficArgs(stagedReady.candidateRevision), spawn);
  } catch {
    const rollback = await restoreCapturedRevision({
      revision: rollbackRevision,
      image: rollbackImage,
      spawn,
      sleepFn,
    });
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze(["GCP_GATEWAY_TRAFFIC_SWITCH_FAILED"]),
      rollback,
    });
  }

  const deployed = await waitForTrafficRevision({
    revision: stagedReady.candidateRevision,
    image: config.image,
    spawn,
    sleepFn,
    maxAttempts: pollAttempts,
    intervalMs: pollIntervalMs,
  });
  if (!deployed.ok) {
    const rollback = await restoreCapturedRevision({
      revision: rollbackRevision,
      image: rollbackImage,
      spawn,
      sleepFn,
    });
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze(["GCP_GATEWAY_POSTDEPLOY_READBACK_UNQUALIFIED", ...deployed.blockers]),
      rollback,
    });
  }
  return Object.freeze({
    status: "deployed",
    blockers: Object.freeze([]),
    sourceProvenance: deploymentProvenanceResult(config, provenance),
    deployedRevision: deployed.assessment.revision,
    image: deployed.assessment.image,
    rollbackRevision,
    rollbackImage,
    postDeployReadback: true,
    routeSmoke: "not_run_application_device_token_required",
  });
}

async function main() {
  try {
    const config = parseArgs(process.argv.slice(2));
    const result = await runGcpTestGatewayDeployment({ config });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "blocked") process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({
      status: "error",
      code: typeof error?.code === "string" ? error.code : "GCP_GATEWAY_GATE_FAILED",
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
