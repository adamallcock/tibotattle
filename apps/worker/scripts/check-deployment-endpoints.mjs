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

export async function checkDeploymentEndpointConsumers({
  wranglerConfigPath = WRANGLER_CONFIG_PATH,
  workerTypesPath = WORKER_TYPES_PATH,
  macOSBuildPath = MACOS_BUILD_PATH,
  macOSReleaseCorePath = MACOS_RELEASE_CORE_PATH,
  macOSNativeSourcePath = MACOS_NATIVE_SOURCE_PATH,
  sparklePublisherPath = SPARKLE_PUBLISHER_PATH,
  endpoints = DEPLOYMENT_ENDPOINTS,
} = {}) {
  const [
    wranglerText,
    workerTypes,
    buildSource,
    macOSReleaseSource,
    nativeSource,
    publisherSource,
  ] = await Promise.all([
    readFile(wranglerConfigPath, "utf8"),
    readFile(workerTypesPath, "utf8"),
    readFile(macOSBuildPath, "utf8"),
    readFile(macOSReleaseCorePath, "utf8"),
    readFile(macOSNativeSourcePath, "utf8"),
    readFile(sparklePublisherPath, "utf8"),
  ]);
  const worker = validateWorkerDeploymentEndpoints(
    parseWranglerConfiguration(wranglerText),
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
  return Object.freeze({ ...consumers, worker });
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
