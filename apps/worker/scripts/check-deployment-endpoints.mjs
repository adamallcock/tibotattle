#!/usr/bin/env node
/**
 * Checks every deployment endpoint consumer that cannot share the JavaScript
 * manifest directly. The manifest is authoritative; this script makes the
 * checked-in Wrangler, generated Worker types, macOS build metadata, native
 * About link, signed-release configuration, and Sparkle publisher fail closed
 * if any of them drift.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";
import {
  DEPLOYMENT_ENDPOINTS,
  assertDeploymentEndpoints,
} from "../../../config/deployment-endpoints.js";
import {
  MACOS_PREVIEW_PUBLIC_CONFIGURATION,
} from "../../../scripts/build-macos-app.js";
import {
  APPROVED_R2_BUCKET,
  APPCAST_ATOMIC_GUARD_SCHEMA,
  APPCAST_ATOMIC_GUARD_ROUTE,
  APPCAST_CACHE_CONTROL,
  CANONICAL_APPCAST_URL,
  CANONICAL_UPDATE_ORIGIN,
  IMMUTABLE_CACHE_CONTROL,
} from "../../../scripts/publish-sparkle-update.js";
import {
  RELEASE_CHANNELS,
  STABLE_RELEASE_CHANNEL,
} from "../../../config/release-channels.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..", "..", "..");
export const WRANGLER_CONFIG_PATH = join(
  REPOSITORY_ROOT,
  "apps",
  "worker",
  "wrangler.jsonc",
);
export const WORKER_TYPES_PATH = join(
  REPOSITORY_ROOT,
  "apps",
  "worker",
  "worker-configuration.d.ts",
);
export const WORKER_PACKAGE_PATH = join(
  REPOSITORY_ROOT,
  "apps",
  "worker",
  "package.json",
);
export const WORKER_SPARKLE_RELEASE_CONTRACT_PATH = join(
  REPOSITORY_ROOT,
  "apps",
  "worker",
  "src",
  "sparkle-release-contract.json",
);
export const SPARKLE_GUARD_NONCE_MIGRATION_PATH = join(
  REPOSITORY_ROOT,
  "apps",
  "worker",
  "migrations",
  "0029_sparkle_appcast_guard_nonces.sql",
);
export const MACOS_BUILD_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "build-macos-app.js",
);
export const MACOS_RELEASE_CORE_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "macos-release-core.js",
);
export const MACOS_NATIVE_SOURCE_PATH = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "UsageMonitorApp.swift",
);
export const SPARKLE_PUBLISHER_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "publish-sparkle-update.js",
);

function fail(message) {
  const error = new Error(message);
  error.code = "DEPLOYMENT_ENDPOINTS_MISMATCH";
  throw error;
}

function exactArray(value, expected, label) {
  if (!Array.isArray(value)
      || value.length !== expected.length
      || value.some((entry, index) => entry !== expected[index])) {
    fail(`${label} must match config/deployment-endpoints.js`);
  }
}

function requireManifestImport(source, label) {
  if (!source.includes("DEPLOYMENT_ENDPOINTS")) {
    fail(`${label} must import config/deployment-endpoints.js`);
  }
}

function rejectEmbeddedEndpoint(source, endpoint, label) {
  if (source.includes(endpoint)) {
    fail(`${label} embeds ${endpoint}; use config/deployment-endpoints.js`);
  }
}

export const SPARKLE_APPCAST_GUARD_R2_BINDING = "SPARKLE_RELEASES";
export const SPARKLE_APPCAST_GUARD_D1_BINDING = "USAGE_MONITOR_DB";

const WORKER_SPARKLE_RELEASE_CONTRACT_SCHEMA =
  "usage-monitor-worker-sparkle-release-contract-v1";

function parseWorkerSparkleReleaseContract(text) {
  try {
    const contract = JSON.parse(text);
    if (!contract || typeof contract !== "object"
        || Array.isArray(contract)) {
      fail("Worker Sparkle release contract must be a JSON object");
    }
    return contract;
  } catch (error) {
    if (error?.code === "DEPLOYMENT_ENDPOINTS_MISMATCH") throw error;
    fail("Worker Sparkle release contract is invalid JSON");
  }
}

export function validateWorkerSparkleReleaseContract(
  contract,
  endpoints = DEPLOYMENT_ENDPOINTS,
) {
  assertDeploymentEndpoints(endpoints);
  const stable = RELEASE_CHANNELS[STABLE_RELEASE_CHANNEL];
  const expected = [
    ["schemaVersion", WORKER_SPARKLE_RELEASE_CONTRACT_SCHEMA],
    ["channel", STABLE_RELEASE_CHANNEL],
    ["serviceOrigin", stable.serviceOrigin],
    ["updateOrigin", stable.sparkle.origin],
    ["appcastURL", stable.sparkle.appcastURL],
    ["appcastObjectKey", stable.sparkle.appcastObjectKey],
    ["r2Bucket", stable.sparkle.r2Bucket],
    ["objectPrefix", stable.sparkle.objectPrefix],
    ["guardSchema", APPCAST_ATOMIC_GUARD_SCHEMA],
    ["guardRoute", APPCAST_ATOMIC_GUARD_ROUTE],
    ["appcastContentType", "application/xml; charset=utf-8"],
    ["appcastCacheControl", APPCAST_CACHE_CONTROL],
    ["artifactContentType", "application/x-apple-diskimage"],
    ["artifactCacheControl", IMMUTABLE_CACHE_CONTROL],
  ];
  for (const [field, expectedValue] of expected) {
    if (contract?.[field] !== expectedValue) {
      fail(
        `Worker Sparkle release contract ${field} must match the canonical release manifests`,
      );
    }
  }
  if (contract.serviceOrigin !== endpoints.public.origin
      || contract.updateOrigin !== endpoints.sparkle.origin
      || contract.appcastURL !== endpoints.sparkle.appcastURL
      || contract.r2Bucket !== endpoints.sparkle.r2Bucket) {
    fail("Worker Sparkle release contract must match config/deployment-endpoints.js");
  }
  return Object.freeze({
    channel: contract.channel,
    appcastURL: contract.appcastURL,
    appcastObjectKey: contract.appcastObjectKey,
    guardRoute: contract.guardRoute,
    objectPrefix: contract.objectPrefix,
    r2Bucket: contract.r2Bucket,
  });
}

function environmentEntries(configuration) {
  return [
    ["default", configuration],
    ["staging", configuration?.env?.staging],
    ["production", configuration?.env?.production],
  ];
}

function bindingEntries(environment, field) {
  return Array.isArray(environment?.[field]) ? environment[field] : [];
}

export function validateWorkerSparkleAppcastGuard(
  configuration,
  nonceMigration,
  endpoints = DEPLOYMENT_ENDPOINTS,
) {
  assertDeploymentEndpoints(endpoints);
  if (typeof nonceMigration !== "string") {
    fail("Sparkle appcast guard nonce migration must be readable");
  }
  const normalizedMigration = nonceMigration
    .replace(/--[^\n]*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (!/create table if not exists sparkle_appcast_guard_nonces \( nonce text primary key not null, expires_at integer not null \)/u.test(normalizedMigration)
      || !/create index if not exists idx_sparkle_appcast_guard_nonces_expires_at on sparkle_appcast_guard_nonces\s*\(expires_at\)/u.test(normalizedMigration)) {
    fail("Sparkle appcast guard nonce schema is required");
  }

  const environments = environmentEntries(configuration);
  for (const [label, environment] of environments) {
    for (const binding of bindingEntries(environment, "r2_buckets")) {
      if (binding?.binding === SPARKLE_APPCAST_GUARD_R2_BINDING
          && binding.bucket_name !== endpoints.sparkle.r2Bucket) {
        fail(`${label} Sparkle R2 binding must match the reviewed manifest bucket`);
      }
    }
    const mode = environment?.vars?.SPARKLE_APPCAST_GUARD_MODE;
    if (mode !== "enabled") continue;
    const hasReviewedR2Binding = bindingEntries(environment, "r2_buckets")
      .some((binding) => binding?.binding === SPARKLE_APPCAST_GUARD_R2_BINDING
        && binding.bucket_name === endpoints.sparkle.r2Bucket);
    if (!hasReviewedR2Binding) {
      fail(`${label} enabled Sparkle appcast guard requires the reviewed R2 binding`);
    }
    const hasNonceDatabase = bindingEntries(environment, "d1_databases")
      .some((binding) => binding?.binding === SPARKLE_APPCAST_GUARD_D1_BINDING
        && binding.migrations_dir === "migrations");
    if (!hasNonceDatabase) {
      fail(`${label} enabled Sparkle appcast guard requires the nonce D1 binding`);
    }
  }
  return Object.freeze({
    nonceTable: "sparkle_appcast_guard_nonces",
    r2Binding: SPARKLE_APPCAST_GUARD_R2_BINDING,
    r2Bucket: endpoints.sparkle.r2Bucket,
  });
}

/**
 * Worker JSONC cannot import JavaScript. Require the production config's
 * public origin and custom domains to be exact projections of the manifest.
 */
export function validateWorkerDeploymentEndpoints(
  configuration,
  endpoints = DEPLOYMENT_ENDPOINTS,
) {
  assertDeploymentEndpoints(endpoints);
  const production = configuration?.env?.production;
  if (!production || typeof production !== "object") {
    fail("wrangler.jsonc must define an env.production deployment");
  }
  if (production.vars?.PUBLIC_ORIGIN !== endpoints.public.origin) {
    fail("Worker PUBLIC_ORIGIN must match config/deployment-endpoints.js");
  }
  const routeHosts = production.routes?.map((route) =>
    route?.custom_domain === true ? route.pattern : null);
  // The reviewed production custom domains are the public hosts plus the
  // admin hostname the Cloudflare Access application protects.
  exactArray(
    routeHosts,
    [...endpoints.public.routeHosts, endpoints.admin.host],
    "Worker custom domains",
  );
  // The Access binding variables must exist in production, even as empty
  // fail-closed placeholders, so the admin hostname can never route without
  // a reviewed Zero Trust configuration slot.
  if (typeof production.vars?.ACCESS_TEAM_DOMAIN !== "string"
      || typeof production.vars?.ACCESS_AUD !== "string") {
    fail("Worker production vars must declare ACCESS_TEAM_DOMAIN and ACCESS_AUD");
  }
  return Object.freeze({
    adminHost: endpoints.admin.host,
    publicOrigin: production.vars.PUBLIC_ORIGIN,
    routeHosts: Object.freeze([...routeHosts]),
  });
}

export function validateDeploymentEndpointConsumers({
  buildSource,
  macOSReleaseSource,
  nativeSource,
  publisherSource,
  workerTypes,
  endpoints = DEPLOYMENT_ENDPOINTS,
}) {
  assertDeploymentEndpoints(endpoints);
  if (MACOS_PREVIEW_PUBLIC_CONFIGURATION.centralOrigin
      !== endpoints.public.origin
      || MACOS_PREVIEW_PUBLIC_CONFIGURATION.sparkleAppcastURL
        !== endpoints.sparkle.previewAppcastURL) {
    fail("macOS preview defaults must match config/deployment-endpoints.js");
  }
  if (APPROVED_R2_BUCKET !== endpoints.sparkle.r2Bucket
      || CANONICAL_UPDATE_ORIGIN !== endpoints.sparkle.origin
      || CANONICAL_APPCAST_URL !== endpoints.sparkle.appcastURL) {
    fail("Sparkle publisher constants must match config/deployment-endpoints.js");
  }

  for (const [source, label] of [
    [buildSource, "macOS build"],
    [macOSReleaseSource, "macOS signed-release build"],
    [publisherSource, "Sparkle publisher"],
  ]) {
    requireManifestImport(source, label);
    rejectEmbeddedEndpoint(source, endpoints.public.origin, label);
    rejectEmbeddedEndpoint(source, endpoints.sparkle.origin, label);
    rejectEmbeddedEndpoint(source, endpoints.sparkle.r2Bucket, label);
  }
  if (!buildSource.includes("UsageMonitorPublicWebsiteOrigin")) {
    fail("macOS build must generate the native public website origin");
  }
  if (nativeSource.includes(endpoints.public.origin)
      || !nativeSource.includes("BundledProduct.publicWebsiteOrigin")) {
    fail("native About must use its bundled public website origin");
  }
  if (!workerTypes.includes(
    `PUBLIC_ORIGIN: \"${endpoints.public.origin}\"`,
  )) {
    fail("generated Worker types must match the manifest public origin");
  }
  return Object.freeze({
    appcastURL: endpoints.sparkle.appcastURL,
    previewAppcastURL: endpoints.sparkle.previewAppcastURL,
    publicOrigin: endpoints.public.origin,
    r2Bucket: endpoints.sparkle.r2Bucket,
  });
}

export function validateWorkerDeploymentEndpointGates(workerPackage) {
  const scripts = workerPackage?.scripts;
  const endpointCheckCommand = "npm run deployment:endpoints:check";
  const endpointGatedDeploymentOperations = [
    ["deploy:dry", "wrangler deploy"],
    ["production:deploy:dry", "wrangler deploy"],
    ["staging:check", "wrangler deploy"],
    ["staging:deploy", "node ./scripts/deploy-disabled-staging.mjs"],
  ];
  if (!scripts || typeof scripts !== "object"
      || scripts["deployment:endpoints:check"]
        !== "node ./scripts/check-deployment-endpoints.mjs") {
    fail("Worker package must expose the deployment endpoint checker");
  }
  for (const [script, deploymentOperation] of endpointGatedDeploymentOperations) {
    const command = scripts[script];
    if (typeof command !== "string") {
      fail(`${script} must define a deployment command`);
    }
    const endpointCheckIndex = command.indexOf(endpointCheckCommand);
    const deploymentOperationIndex = command.indexOf(deploymentOperation);
    if (endpointCheckIndex < 0
        || deploymentOperationIndex < 0
        || endpointCheckIndex > deploymentOperationIndex) {
      fail(
        `${script} must run the deployment endpoint checker before ${deploymentOperation}`,
      );
    }
  }
  if (scripts["production:deploy"]
      !== "node ./scripts/production-deploy.mjs") {
    fail(
      "production:deploy must use the receipt-gated production deployment wrapper",
    );
  }
  return Object.freeze({
    checkedScripts: Object.freeze([
      "deploy:dry",
      "production:deploy",
      "production:deploy:dry",
      "staging:check",
      "staging:deploy",
    ]),
  });
}

function parseWranglerConfiguration(text) {
  const errors = [];
  const configuration = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    fail(
      `wrangler.jsonc is invalid JSONC (${printParseErrorCode(errors[0].error)})`,
    );
  }
  return configuration;
}

function parseWorkerPackage(text) {
  try {
    const workerPackage = JSON.parse(text);
    if (!workerPackage || typeof workerPackage !== "object") {
      fail("apps/worker/package.json must be a JSON object");
    }
    return workerPackage;
  } catch (error) {
    if (error?.code === "DEPLOYMENT_ENDPOINTS_MISMATCH") throw error;
    fail("apps/worker/package.json is invalid JSON");
  }
}

export async function checkDeploymentEndpointConsumers({
  wranglerConfigPath = WRANGLER_CONFIG_PATH,
  workerTypesPath = WORKER_TYPES_PATH,
  workerPackagePath = WORKER_PACKAGE_PATH,
  workerSparkleReleaseContractPath = WORKER_SPARKLE_RELEASE_CONTRACT_PATH,
  sparkleGuardNonceMigrationPath = SPARKLE_GUARD_NONCE_MIGRATION_PATH,
  macOSBuildPath = MACOS_BUILD_PATH,
  macOSReleaseCorePath = MACOS_RELEASE_CORE_PATH,
  macOSNativeSourcePath = MACOS_NATIVE_SOURCE_PATH,
  sparklePublisherPath = SPARKLE_PUBLISHER_PATH,
  endpoints = DEPLOYMENT_ENDPOINTS,
} = {}) {
  const [
    wranglerText,
    workerTypes,
    workerPackageText,
    workerSparkleReleaseContractText,
    sparkleGuardNonceMigration,
    buildSource,
    macOSReleaseSource,
    nativeSource,
    publisherSource,
  ] = await Promise.all([
    readFile(wranglerConfigPath, "utf8"),
    readFile(workerTypesPath, "utf8"),
    readFile(workerPackagePath, "utf8"),
    readFile(workerSparkleReleaseContractPath, "utf8"),
    readFile(sparkleGuardNonceMigrationPath, "utf8"),
    readFile(macOSBuildPath, "utf8"),
    readFile(macOSReleaseCorePath, "utf8"),
    readFile(macOSNativeSourcePath, "utf8"),
    readFile(sparklePublisherPath, "utf8"),
  ]);
  const wranglerConfiguration = parseWranglerConfiguration(wranglerText);
  const worker = validateWorkerDeploymentEndpoints(
    wranglerConfiguration,
    endpoints,
  );
  const workerSparkleReleaseContract = validateWorkerSparkleReleaseContract(
    parseWorkerSparkleReleaseContract(workerSparkleReleaseContractText),
    endpoints,
  );
  const sparkleGuard = validateWorkerSparkleAppcastGuard(
    wranglerConfiguration,
    sparkleGuardNonceMigration,
    endpoints,
  );
  const consumers = validateDeploymentEndpointConsumers({
    buildSource,
    macOSReleaseSource,
    nativeSource,
    publisherSource,
    workerTypes,
    endpoints,
  });
  const gates = validateWorkerDeploymentEndpointGates(
    parseWorkerPackage(workerPackageText),
  );
  return Object.freeze({
    ...consumers,
    gates,
    sparkleGuard,
    worker,
    workerSparkleReleaseContract,
  });
}

async function main() {
  const checked = await checkDeploymentEndpointConsumers();
  process.stdout.write(
    `Deployment endpoints: ${checked.publicOrigin} · ${checked.appcastURL}\n`,
  );
}

if (process.argv[1]
    && resolve(process.argv[1]) === resolve(SCRIPT_FILE)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
