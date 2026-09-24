#!/usr/bin/env node

/**
 * GCP test gate for the isolated TiboTattle database service.
 *
 * The target is intentionally fixed to tibotattle/us-east1 and one named test
 * service. Local context checks and read-only Cloud Run assessments remain
 * available, but deploy and exact-image verification stay blocked until the
 * Cloud Build source can be tied to the checked local context.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GCP_PRIVATE_TEST_TARGET = Object.freeze({
  project: "tibotattle",
  region: "us-east1",
  service: "tibotattle-test-app",
  imageRepository:
    "us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host",
});

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_CONTEXT_CHECK = resolve(WORKER_ROOT, "scripts/cloud-run-build-context.mjs");
const DIGEST = /^[a-f0-9]{64}$/u;
const IMAGE_REFERENCE =
  /^us-east1-docker\.pkg\.dev\/tibotattle\/tibotattle-test\/tibotattle-host@sha256:([a-f0-9]{64})$/u;
const HEALTH_PATH = "/api/health";
const V12_CHUNK_PATH = "/api/v1/contributions";

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function parseArgs(argv) {
  const command = argv[0] ?? "preflight";
  if (!["preflight", "verify", "deploy"].includes(command)) {
    fail("GCP_PRIVATE_TEST_COMMAND_INVALID");
  }
  const allowed = new Set(["--project", "--region", "--service", "--image",
    "--source-digest", "--build-id"]);
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
  };
  validateConfig(config);
  return Object.freeze(config);
}

export function validateConfig(config) {
  if (config?.project !== GCP_PRIVATE_TEST_TARGET.project
      || config?.region !== GCP_PRIVATE_TEST_TARGET.region
      || config?.service !== GCP_PRIVATE_TEST_TARGET.service) {
    fail("GCP_PRIVATE_TEST_TARGET_FIXED");
  }
  if (typeof config.image !== "string" || !IMAGE_REFERENCE.test(config.image)) {
    fail("GCP_PRIVATE_TEST_IMAGE_DIGEST_REQUIRED");
  }
  if (typeof config.sourceDigest !== "string" || !DIGEST.test(config.sourceDigest)) {
    fail("GCP_PRIVATE_TEST_SOURCE_DIGEST_REQUIRED");
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

function readyCondition(service) {
  const conditions = service?.status?.conditions ?? service?.conditions ?? [];
  return conditions.find((condition) => condition.type === "Ready")?.status === "True";
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
  const values = service?.spec?.template?.spec?.containers?.[0]?.env
    ?? service?.template?.containers?.[0]?.env
    ?? [];
  return new Map(values
    .filter((value) => typeof value?.name === "string" && typeof value?.value === "string")
    .map((value) => [value.name, value.value]));
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
  requireExactImage = true,
  requireSourceDigest = true,
  requireLatestReadyTraffic = requireExactImage,
} = {}) {
  const blockers = [];
  if (!service || !policy) return Object.freeze({
    ok: false,
    blockers: Object.freeze(["GCP_TEST_SERVICE_READBACK_MISSING"]),
  });
  if (!readyCondition(service)) blockers.push("GCP_TEST_SERVICE_NOT_READY");
  if (serviceIngress(service) !== "all") blockers.push("GCP_TEST_INGRESS_UNEXPECTED");
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
      listenHost: "0.0.0.0",
      hostOrigin: "https://service.invalid",
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

export async function runGcpPrivateTestDeployment({
  config,
  spawn = spawnSync,
  fetchImpl = fetch,
  isPrivateHost,
} = {}) {
  validateConfig(config);
  checkedBuildContext(config.sourceDigest, spawn);
  const hostModeReady = cloudRunHostModeReady(isPrivateHost);
  if (config.command === "deploy") {
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze([
        "SOURCE_PROVENANCE_UNQUALIFIED",
        ...(!hostModeReady ? ["POSTGRES_TEST_HOST_CLOUD_RUN_MODE_UNAVAILABLE"] : []),
      ]),
    });
  }

  const initial = await readCloudRunState(config, spawn);
  const assessment = assessCloudRunReadback({
    service: initial.service,
    policy: initial.policy,
    expectedImage: config.image,
    expectedSourceDigest: config.sourceDigest,
    requireExactImage: config.command === "verify",
    requireSourceDigest: config.command === "verify",
    requireLatestReadyTraffic: config.command === "verify",
  });
  const origin = validateServiceUrl(initial.service?.status?.url ?? initial.service?.url);
  const unauthenticatedProbe = await runUnauthenticatedInvokerProbe({
    serviceUrl: origin,
    fetchImpl,
  });

  if (config.command === "preflight") {
    const blockers = [
      "SOURCE_PROVENANCE_UNQUALIFIED",
      ...assessment.blockers,
      ...(!hostModeReady ? ["POSTGRES_TEST_HOST_CLOUD_RUN_MODE_UNAVAILABLE"] : []),
      ...(!unauthenticatedProbe.ok ? ["GCP_TEST_UNAUTHENTICATED_PROBE_FAILED"] : []),
    ];
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze([...new Set(blockers)]),
      readOnlyAssessment: true,
      unauthenticatedProbe: unauthenticatedProbe.result,
    });
  }

  if (config.command === "verify") {
    const blockers = ["SOURCE_PROVENANCE_UNQUALIFIED", ...assessment.blockers];
    if (!hostModeReady) blockers.push("POSTGRES_TEST_HOST_CLOUD_RUN_MODE_UNAVAILABLE");
    if (!unauthenticatedProbe.ok) blockers.push("GCP_TEST_UNAUTHENTICATED_PROBE_FAILED");
    return Object.freeze({
      status: "blocked",
      blockers: Object.freeze([...new Set(blockers)]),
      readOnlyAssessment: true,
      unauthenticatedProbe: unauthenticatedProbe.result,
    });
  }
  return Object.freeze({
    status: "blocked",
    blockers: Object.freeze(["GCP_PRIVATE_TEST_COMMAND_INVALID"]),
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
