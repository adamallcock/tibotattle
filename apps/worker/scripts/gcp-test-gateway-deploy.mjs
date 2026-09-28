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
  return conditionReady(condition);
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

function trafficToRevision(service, expectedRevision, { requireReady = true } = {}) {
  const status = serviceStatus(service);
  const traffic = status?.traffic ?? status?.trafficStatuses;
  if (!Array.isArray(traffic) || (requireReady && !serviceReady(service))
      || !serviceGenerationObserved(service)) {
    return false;
  }
  if (traffic.some((entry) => !isRecord(entry)
      || !Number.isSafeInteger(entry.percent) || entry.percent < 0 || entry.percent > 100)) {
    return false;
  }
  const active = traffic.filter((entry) => entry.percent > 0);
  return active.length === 1
    && active[0].percent === 100
    && revisionName(active[0].revisionName ?? active[0].revision) === expectedRevision;
}

function trafficToLatestReady(service) {
  const latestReady = latestReadyRevisionName(service);
  const latestCreated = latestCreatedRevisionName(service);
  if (!latestReady || latestCreated !== latestReady) return false;
  const status = serviceStatus(service);
  const traffic = status?.traffic ?? status?.trafficStatuses;
  if (!Array.isArray(traffic) || !serviceReady(service) || !serviceGenerationObserved(service)) {
    return false;
  }
  if (traffic.some((entry) => !isRecord(entry)
      || !Number.isSafeInteger(entry.percent) || entry.percent < 0 || entry.percent > 100)) {
    return false;
  }
  const active = traffic.filter((entry) => entry.percent > 0);
  const activeName = active.length === 1
    ? revisionName(active[0].revisionName ?? active[0].revision)
    : null;
  return active.length === 1
    && active[0].percent === 100
    && (activeName === null
      ? active[0].latestRevision === true
      : activeName === latestReady);
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
  requireLatestReadyTraffic = true,
  requireLatestReadyRevision = true,
  requireServiceReady = true,
} = {}) {
  const blockers = [];
  if (!isRecord(service) || !isRecord(policy) || !isRecord(sink) || !isRecord(revision)) {
    return Object.freeze({ ok: false, blockers: Object.freeze(["GCP_GATEWAY_READBACK_MISSING"]) });
  }
  if (service?.metadata?.name !== GCP_TEST_GATEWAY_TARGET.service) {
    blockers.push("GCP_GATEWAY_SERVICE_IDENTITY_UNQUALIFIED");
  }
  if ((requireServiceReady && !serviceReady(service)) || !revisionReady(revision)) {
    blockers.push("GCP_GATEWAY_REVISION_NOT_READY");
  }
  const expectedReadyRevision = latestReadyRevisionName(service);
  const actualRevision = revisionName(revision?.metadata?.name);
  if (requireLatestReadyRevision && (!expectedReadyRevision
      || expectedReadyRevision !== actualRevision
      || latestCreatedRevisionName(service) !== expectedReadyRevision)) {
    blockers.push("GCP_GATEWAY_LATEST_READY_REVISION_MISMATCH");
  }
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
  if (requireLatestReadyTraffic && !trafficToLatestReady(service)) {
    blockers.push("GCP_GATEWAY_LATEST_READY_TRAFFIC_UNQUALIFIED");
  }
  if (expectedTrafficRevision && !trafficToRevision(service, expectedTrafficRevision)) {
    blockers.push("GCP_GATEWAY_TRAFFIC_REVISION_UNQUALIFIED");
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
  const name = latestReadyRevisionName(service);
  if (!name) fail("GCP_GATEWAY_LATEST_READY_REVISION_MISSING");
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

function updateTrafficArgs(revision) {
  return [
    "run", "services", "update-traffic", GCP_TEST_GATEWAY_TARGET.service,
    "--to-revisions=" + revision + "=100",
    "--project=" + GCP_TEST_GATEWAY_TARGET.project,
    "--region=" + GCP_TEST_GATEWAY_TARGET.region,
    "--quiet",
  ];
}

async function restoreCapturedRevision({ revision, image, spawn }) {
  const blockers = [];
  try {
    spawnGcloud(updateTrafficArgs(revision), spawn);
  } catch {
    blockers.push("GCP_GATEWAY_ROLLBACK_TRAFFIC_UPDATE_FAILED");
  }
  try {
    const state = await readGatewayState(spawn);
    const rollbackState = { ...state, revision: readRevisionNamed(revision, spawn) };
    const assessment = gatewayAssessment(rollbackState, {
      expectedImage: image,
      expectedTrafficRevision: revision,
      requireLatestReadyTraffic: false,
      requireLatestReadyRevision: false,
      requireServiceReady: false,
    });
    blockers.push(...assessment.blockers);
  } catch {
    blockers.push("GCP_GATEWAY_ROLLBACK_READBACK_FAILED");
  }
  return Object.freeze({
    attempted: true,
    ok: blockers.length === 0,
    revision,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

async function restoreAfterFailedNoTrafficUpdate({ revision, image, spawn }) {
  let service;
  try {
    service = readGatewayService(spawn);
  } catch {
    return Object.freeze({
      attempted: false,
      ok: false,
      revision,
      blockers: Object.freeze(["GCP_GATEWAY_MUTATION_STATE_UNAVAILABLE"]),
    });
  }
  const changed = latestCreatedRevisionName(service) !== revision
    || latestReadyRevisionName(service) !== revision
    || !trafficToRevision(service, revision);
  if (!changed) return Object.freeze({
    attempted: false,
    ok: true,
    revision,
    blockers: Object.freeze([]),
  });
  return restoreCapturedRevision({ revision, image, spawn });
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
  const initialAssessment = gatewayAssessment(initial, {
    ...(config.command === "verify" ? { expectedImage: config.image } : {}),
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
  if (!initialAssessment.ok) return Object.freeze({
    status: "blocked",
    blockers: Object.freeze(["GCP_GATEWAY_PREDEPLOY_READBACK_UNQUALIFIED", ...initialAssessment.blockers]),
    preDeployReadOnlyAssessment: true,
  });
  if (initialAssessment.image === config.image) return Object.freeze({
    status: "blocked",
    blockers: Object.freeze(["GCP_GATEWAY_IMAGE_ALREADY_SERVING_USE_VERIFY"]),
    preDeployReadOnlyAssessment: true,
  });

  const rollbackRevision = initialAssessment.revision;
  const rollbackImage = initialAssessment.image;
  try {
    spawnGcloud([
      "run", "services", "update", GCP_TEST_GATEWAY_TARGET.service,
      "--image=" + config.image,
      "--no-traffic",
      "--project=" + GCP_TEST_GATEWAY_TARGET.project,
      "--region=" + GCP_TEST_GATEWAY_TARGET.region,
      "--quiet",
    ], spawn);
  } catch {
    const rollback = await restoreAfterFailedNoTrafficUpdate({
      revision: rollbackRevision,
      image: rollbackImage,
      spawn,
    });
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze(["GCP_GATEWAY_NO_TRAFFIC_UPDATE_FAILED"]),
      rollback,
    });
  }

  let staged;
  let stagedAssessment;
  try {
    staged = await readServiceAndRevision(spawn);
    stagedAssessment = gatewayAssessment(staged, {
      expectedImage: config.image,
      expectedTrafficRevision: rollbackRevision,
      requireLatestReadyTraffic: false,
    });
    if (stagedAssessment.revision === rollbackRevision) {
      stagedAssessment = Object.freeze({
        ...stagedAssessment,
        ok: false,
        blockers: Object.freeze([...stagedAssessment.blockers, "GCP_GATEWAY_NEW_REVISION_NOT_READY"]),
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
    });
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze(["GCP_GATEWAY_STAGED_REVISION_UNQUALIFIED", ...stagedAssessment.blockers]),
      rollback,
    });
  }

  try {
    spawnGcloud(updateTrafficArgs(stagedAssessment.revision), spawn);
  } catch {
    const rollback = await restoreCapturedRevision({
      revision: rollbackRevision,
      image: rollbackImage,
      spawn,
    });
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze(["GCP_GATEWAY_TRAFFIC_SWITCH_FAILED"]),
      rollback,
    });
  }

  let deployedAssessment;
  try {
    const deployed = await readServiceAndRevision(spawn);
    deployedAssessment = gatewayAssessment(deployed, {
      expectedImage: config.image,
    });
    if (deployedAssessment.revision !== stagedAssessment.revision) {
      deployedAssessment = Object.freeze({
        ...deployedAssessment,
        ok: false,
        blockers: Object.freeze([...deployedAssessment.blockers, "GCP_GATEWAY_DEPLOYED_REVISION_CHANGED"]),
      });
    }
  } catch {
    deployedAssessment = Object.freeze({
      ok: false,
      blockers: Object.freeze(["GCP_GATEWAY_POSTDEPLOY_READBACK_FAILED"]),
    });
  }
  if (!deployedAssessment.ok) {
    const rollback = await restoreCapturedRevision({
      revision: rollbackRevision,
      image: rollbackImage,
      spawn,
    });
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze(["GCP_GATEWAY_POSTDEPLOY_READBACK_UNQUALIFIED", ...deployedAssessment.blockers]),
      rollback,
    });
  }
  return Object.freeze({
    status: "deployed",
    blockers: Object.freeze([]),
    sourceProvenance: deploymentProvenanceResult(config, provenance),
    deployedRevision: deployedAssessment.revision,
    image: deployedAssessment.image,
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
