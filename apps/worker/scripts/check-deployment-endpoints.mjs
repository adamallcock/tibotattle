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
  CANONICAL_APPCAST_URL,
  CANONICAL_UPDATE_ORIGIN,
} from "../../../scripts/publish-sparkle-update.js";

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
  exactArray(routeHosts, endpoints.public.routeHosts, "Worker custom domains");
  return Object.freeze({
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
        !== endpoints.sparkle.appcastURL) {
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
    publicOrigin: endpoints.public.origin,
    r2Bucket: endpoints.sparkle.r2Bucket,
  });
}

export function validateWorkerDeploymentEndpointGates(workerPackage) {
  const scripts = workerPackage?.scripts;
  if (!scripts || typeof scripts !== "object"
      || scripts["deployment:endpoints:check"]
        !== "node ./scripts/check-deployment-endpoints.mjs") {
    fail("Worker package must expose the deployment endpoint checker");
  }
  for (const script of [
    "deploy:dry",
    "production:deploy:dry",
    "staging:check",
    "staging:deploy",
  ]) {
    if (typeof scripts[script] !== "string"
        || !scripts[script].includes("npm run deployment:endpoints:check")) {
      fail(`${script} must run the deployment endpoint checker before Wrangler`);
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
    sparkleGuardNonceMigration,
    buildSource,
    macOSReleaseSource,
    nativeSource,
    publisherSource,
  ] = await Promise.all([
    readFile(wranglerConfigPath, "utf8"),
    readFile(workerTypesPath, "utf8"),
    readFile(workerPackagePath, "utf8"),
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
  return Object.freeze({ ...consumers, gates, sparkleGuard, worker });
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
