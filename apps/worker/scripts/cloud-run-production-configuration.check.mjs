/**
 * Repo-only drift guard for the Cloud Run production configuration.
 *
 * The origin's frozen constants (cloud-run/postgres-production-configuration.mjs)
 * mirror the checked-in Worker configuration, wrangler.jsonc env.production.
 * Every production var and rate limit there must be accounted for:
 *
 *   - a var equals PRODUCTION_VARS, unless production-live-settings.receipt.json
 *     records a live override, in which case PRODUCTION_VARS carries the live
 *     value and the checked-in value must still differ from it;
 *   - a var may instead be edge-only (it stays with the Cloudflare edge) or
 *     deployment-provided (each deployment supplies and validates it);
 *   - every PRODUCTION_VARS key is in wrangler.jsonc or declared origin-only;
 *   - the eight rate limits split into the six edge-tier names and the two
 *     origin-tier limits, whose values must match;
 *   - the Worker's required secrets are a subset of the origin's, and the
 *     production hostnames and Cloudflare resource names match the frozen
 *     origins and fingerprint.
 *
 * It also pins cloudbuild.production.yaml to the test build line for line,
 * apart from its placeholder service account and image. Nothing here reads a
 * live resource. Each guarded property is shown to fail on a doctored temp
 * copy.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, printParseErrorCode } from "jsonc-parser";
import * as configuration from "../cloud-run/postgres-production-configuration.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_PATH = resolve(WORKER_ROOT, "wrangler.jsonc");
const RECEIPT_PATH = resolve(WORKER_ROOT, "cloud-run/production-live-settings.receipt.json");
const TEST_BUILD_PATH = resolve(WORKER_ROOT, "cloud-run/cloudbuild.yaml");
const PRODUCTION_BUILD_PATH = resolve(WORKER_ROOT, "cloud-run/cloudbuild.production.yaml");

const RECEIPT_SCHEMA = "tibotattle-production-live-settings-v1";
// The receipt is content-free: setting names and these values only. Widening
// this set is a deliberate review, not a drift fix.
const RECEIPT_VALUES = new Set(["typed"]);
const PRODUCTION_BUILD_SERVICE_ACCOUNT = "serviceAccount: projects/${PROJECT}/serviceAccounts/${BUILDER_SA}";
const PRODUCTION_BUILD_IMAGE = "  _IMAGE: ${IMAGE_REPOSITORY}:source-${SOURCE_COMMIT}";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonc(text) {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: false, disallowComments: false });
  if (errors.length > 0) {
    throw new Error(`WRANGLER_PARSE_FAILED:${printParseErrorCode(errors[0].error)}`);
  }
  return value;
}

function edgeOnlyVar(name) {
  return configuration.EDGE_ONLY_VAR_NAMES.includes(name)
    || configuration.EDGE_ONLY_VAR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function receiptFindings(receipt) {
  if (!isObject(receipt) || Object.keys(receipt).sort().join() !== "overrides,schemaVersion"
      || receipt.schemaVersion !== RECEIPT_SCHEMA || !isObject(receipt.overrides)) {
    return { findings: ["RECEIPT_INVALID"], overrides: {} };
  }
  const findings = [];
  for (const [name, value] of Object.entries(receipt.overrides)) {
    if (!RECEIPT_VALUES.has(value)) findings.push(`RECEIPT_VALUE_INVALID:${name}`);
    if (!Object.hasOwn(configuration.PRODUCTION_VARS, name)) {
      findings.push(`RECEIPT_OVERRIDE_UNKNOWN:${name}`);
    }
  }
  return { findings, overrides: receipt.overrides };
}

function varFindings(wranglerVars, overrides) {
  const pinned = configuration.PRODUCTION_VARS;
  if (!isObject(wranglerVars)) return ["WRANGLER_VARS_INVALID"];
  const findings = [];
  for (const [name, value] of Object.entries(wranglerVars)) {
    if (edgeOnlyVar(name)) {
      if (Object.hasOwn(pinned, name)) findings.push(`EDGE_ONLY_VAR_PINNED:${name}`);
      continue;
    }
    if (configuration.DEPLOYMENT_PROVIDED_VAR_NAMES.includes(name)) {
      if (Object.hasOwn(pinned, name)) findings.push(`DEPLOYMENT_VAR_PINNED:${name}`);
      continue;
    }
    if (configuration.ORIGIN_ONLY_VAR_NAMES.includes(name)) {
      findings.push(`ORIGIN_ONLY_VAR_IN_WRANGLER:${name}`);
      continue;
    }
    if (!Object.hasOwn(pinned, name)) {
      findings.push(`VAR_UNCLASSIFIED:${name}`);
      continue;
    }
    if (Object.hasOwn(overrides, name)) {
      if (pinned[name] !== overrides[name]) findings.push(`LIVE_OVERRIDE_MISMATCH:${name}`);
      if (value === overrides[name]) findings.push(`LIVE_OVERRIDE_STALE:${name}`);
      continue;
    }
    if (value !== pinned[name]) findings.push(`VAR_DRIFT:${name}`);
  }
  for (const name of Object.keys(pinned)) {
    if (!Object.hasOwn(wranglerVars, name) && !configuration.ORIGIN_ONLY_VAR_NAMES.includes(name)) {
      findings.push(`VAR_UNDECLARED:${name}`);
    }
  }
  for (const name of configuration.ORIGIN_ONLY_VAR_NAMES) {
    if (!Object.hasOwn(pinned, name)) findings.push(`ORIGIN_ONLY_VAR_UNPINNED:${name}`);
  }
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(wranglerVars, name)) findings.push(`LIVE_OVERRIDE_UNUSED:${name}`);
  }
  return findings;
}

function rateLimitFindings(ratelimits) {
  if (!Array.isArray(ratelimits)) return ["WRANGLER_RATE_LIMITS_INVALID"];
  const originByBinding = new Map(Object.entries(configuration.ORIGIN_TIER_RATE_LIMITS)
    .map(([name, limit]) => [limit.binding, { name, ...limit }]));
  const findings = [];
  const seen = new Set();
  for (const entry of ratelimits) {
    const binding = entry?.name;
    if (typeof binding !== "string") {
      findings.push("RATE_LIMIT_INVALID");
      continue;
    }
    if (seen.has(binding)) findings.push(`RATE_LIMIT_DUPLICATE:${binding}`);
    seen.add(binding);
    const limit = entry.simple?.limit;
    const period = entry.simple?.period;
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(period) || period < 1) {
      findings.push(`RATE_LIMIT_INVALID:${binding}`);
      continue;
    }
    if (configuration.EDGE_TIER_RATE_LIMIT_BINDINGS.includes(binding)) continue;
    const origin = originByBinding.get(binding);
    if (origin === undefined) {
      findings.push(`RATE_LIMIT_UNCLASSIFIED:${binding}`);
    } else if (origin.limit !== limit || origin.periodSeconds !== period) {
      findings.push(`ORIGIN_TIER_LIMIT_DRIFT:${origin.name}`);
    }
  }
  for (const binding of configuration.EDGE_TIER_RATE_LIMIT_BINDINGS) {
    if (!seen.has(binding)) findings.push(`EDGE_TIER_RATE_LIMIT_MISSING:${binding}`);
  }
  for (const binding of originByBinding.keys()) {
    if (!seen.has(binding)) findings.push(`ORIGIN_TIER_RATE_LIMIT_MISSING:${binding}`);
  }
  return findings;
}

function secretFindings(secrets) {
  const required = secrets?.required;
  if (!Array.isArray(required)) return ["WRANGLER_SECRETS_INVALID"];
  const findings = [];
  const origin = [...configuration.REQUIRED_SECRET_NAMES, ...configuration.OPTIONAL_SECRET_NAMES];
  for (const name of required) {
    if (!origin.includes(name) && !configuration.EDGE_ONLY_SECRET_NAMES.includes(name)) {
      findings.push(`SECRET_UNCLASSIFIED:${name}`);
    }
  }
  for (const name of configuration.REQUIRED_SECRET_NAMES) {
    if (!required.includes(name) && !configuration.ORIGIN_ONLY_SECRET_NAMES.includes(name)) {
      findings.push(`SECRET_UNDECLARED:${name}`);
    }
  }
  return findings;
}

function hostFindings(production) {
  const hosts = (Array.isArray(production.routes) ? production.routes : [])
    .filter((route) => route?.custom_domain === true)
    .map((route) => route.pattern)
    .sort();
  const expected = [
    new URL(configuration.PRODUCTION_PUBLIC_ORIGIN).host,
    new URL(configuration.PRODUCTION_ADMIN_ORIGIN).host,
    configuration.PRODUCTION_WWW_HOST,
  ].sort();
  return hosts.join() === expected.join()
    && [...configuration.PRODUCTION_RESOURCE_FINGERPRINT.hosts].sort().join() === expected.join()
    ? []
    : ["PRODUCTION_HOSTS_DRIFT"];
}

function fingerprintFindings(production) {
  const names = [
    production.name,
    ...(Array.isArray(production.d1_databases) ? production.d1_databases : [])
      .map((database) => database?.database_name),
    ...(Array.isArray(production.r2_buckets) ? production.r2_buckets : [])
      .map((bucket) => bucket?.bucket_name),
  ].sort();
  return names.join() === [...configuration.PRODUCTION_RESOURCE_FINGERPRINT.cloudflareResourceNames]
    .sort().join()
    ? []
    : ["FINGERPRINT_CLOUDFLARE_RESOURCES_DRIFT"];
}

/** Returns sorted findings; an empty list means no drift. */
function productionConfigurationDrift({ wranglerText, receiptText }) {
  let wrangler;
  try {
    wrangler = parseJsonc(wranglerText);
  } catch (error) {
    return [error.message];
  }
  const production = wrangler?.env?.production;
  if (!isObject(production)) return ["WRANGLER_PRODUCTION_MISSING"];
  let receipt;
  try { receipt = JSON.parse(receiptText); } catch { receipt = null; }
  const { findings, overrides } = receiptFindings(receipt);
  return [
    ...findings,
    ...varFindings(production.vars, overrides),
    ...rateLimitFindings(production.ratelimits),
    ...secretFindings(production.secrets),
    ...hostFindings(production),
    ...fingerprintFindings(production),
  ].sort();
}

function withoutComments(text) {
  return text.split("\n").filter((line) => !/^\s*#/u.test(line));
}

/** The production build equals the test build except its two placeholder lines. */
function productionBuildFindings({ testBuildText, productionBuildText }) {
  const testLines = withoutComments(testBuildText);
  const productionLines = withoutComments(productionBuildText);
  const expected = testLines.map((line) => {
    if (line.startsWith("serviceAccount: ")) return PRODUCTION_BUILD_SERVICE_ACCOUNT;
    if (line.startsWith("  _IMAGE: ")) return PRODUCTION_BUILD_IMAGE;
    return line;
  });
  const findings = [];
  if (expected.join("\n") !== productionLines.join("\n")) findings.push("PRODUCTION_BUILD_DRIFT");
  if (/tibotattle-test|\.iam\.gserviceaccount\.com|docker\.pkg\.dev/u.test(productionBuildText)) {
    findings.push("PRODUCTION_BUILD_CONCRETE_IDENTIFIER");
  }
  return findings.sort();
}

const [WRANGLER_TEXT, RECEIPT_TEXT, TEST_BUILD_TEXT, PRODUCTION_BUILD_TEXT] = await Promise.all([
  readFile(WRANGLER_PATH, "utf8"),
  readFile(RECEIPT_PATH, "utf8"),
  readFile(TEST_BUILD_PATH, "utf8"),
  readFile(PRODUCTION_BUILD_PATH, "utf8"),
]);

/** Writes doctored copies to a temp directory and checks them from there. */
async function driftOfTempCopy({ wranglerText = WRANGLER_TEXT, receiptText = RECEIPT_TEXT } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cloud-run-production-configuration-"));
  try {
    const wranglerPath = join(directory, "wrangler.jsonc");
    const receiptPath = join(directory, "production-live-settings.receipt.json");
    await writeFile(wranglerPath, wranglerText, { flag: "wx" });
    await writeFile(receiptPath, receiptText, { flag: "wx" });
    return productionConfigurationDrift({
      wranglerText: await readFile(wranglerPath, "utf8"),
      receiptText: await readFile(receiptPath, "utf8"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function doctor(text, from, to) {
  const index = text.indexOf(from);
  assert.ok(index >= 0 && text.indexOf(from, index + 1) < 0, `expected exactly one ${JSON.stringify(from)}`);
  return text.slice(0, index) + to + text.slice(index + from.length);
}

/** Doctors a line inside env.production only (the synthetic defaults repeat names). */
function doctorProduction(text, from, to) {
  const start = text.indexOf("\n    \"production\": {");
  assert.ok(start > 0);
  return text.slice(0, start) + doctor(text.slice(start), from, to);
}

function doctorReceipt(mutate) {
  const receipt = JSON.parse(RECEIPT_TEXT);
  mutate(receipt);
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

const UPLOAD_AUTHORIZATION_LIMIT = [
  "\"name\": \"UPLOAD_AUTHORIZATION_RATE_LIMIT\",",
  "          \"namespace_id\": \"3005\",",
  "          \"simple\": { \"limit\": 3000, \"period\": 60 }",
].join("\n");

test("the checked-in wrangler.jsonc, receipt and production build pass", async () => {
  assert.deepEqual(productionConfigurationDrift({ wranglerText: WRANGLER_TEXT, receiptText: RECEIPT_TEXT }), []);
  assert.deepEqual(await driftOfTempCopy(), []);
  assert.deepEqual(productionBuildFindings({
    testBuildText: TEST_BUILD_TEXT,
    productionBuildText: PRODUCTION_BUILD_TEXT,
  }), []);
});

test("the receipt records only the live typed-storage override, content-free", () => {
  assert.deepEqual(JSON.parse(RECEIPT_TEXT), {
    schemaVersion: RECEIPT_SCHEMA,
    overrides: { TELEMETRY_STORAGE_MODE: "typed" },
  });
  assert.equal(configuration.PRODUCTION_VARS.TELEMETRY_STORAGE_MODE, "typed");
});

test("a changed var in a temp copy fails", async () => {
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"SIGN_IN_START_MAX_PER_MINUTE\": \"300\"", "\"SIGN_IN_START_MAX_PER_MINUTE\": \"301\""),
  }), ["VAR_DRIFT:SIGN_IN_START_MAX_PER_MINUTE"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"ENROLLMENT_MODE\": \"open\"", "\"ENROLLMENT_MODE\": \"disabled\""),
  }), ["VAR_DRIFT:ENROLLMENT_MODE"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"PUBLIC_ORIGIN\": \"https://tibotattle.com\"", "\"PUBLIC_ORIGIN\": \"https://www.tibotattle.com\""),
  }), ["VAR_DRIFT:PUBLIC_ORIGIN"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"UPLOAD_INGRESS_MAX_CONCURRENT\": \"64\"", "\"UPLOAD_INGRESS_MAX_CONCURRENT\": 64"),
  }), ["VAR_DRIFT:UPLOAD_INGRESS_MAX_CONCURRENT"]);
});

test("a changed origin-tier limit in a temp copy fails", async () => {
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT, UPLOAD_AUTHORIZATION_LIMIT,
      UPLOAD_AUTHORIZATION_LIMIT.replace("\"limit\": 3000", "\"limit\": 2999")),
  }), ["ORIGIN_TIER_LIMIT_DRIFT:UPLOAD_AUTHORIZATION"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT, UPLOAD_AUTHORIZATION_LIMIT,
      UPLOAD_AUTHORIZATION_LIMIT.replace("\"period\": 60", "\"period\": 10")),
  }), ["ORIGIN_TIER_LIMIT_DRIFT:UPLOAD_AUTHORIZATION"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"name\": \"UPLOAD_PRINCIPAL_RATE_LIMIT\",", "\"name\": \"UPLOAD_PRINCIPAL_RATE_LIMIT_V2\","),
  }), ["ORIGIN_TIER_RATE_LIMIT_MISSING:UPLOAD_PRINCIPAL_RATE_LIMIT",
    "RATE_LIMIT_UNCLASSIFIED:UPLOAD_PRINCIPAL_RATE_LIMIT_V2"]);
});

test("edge-tier limits must all be present, and their values stay with the edge", async () => {
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"name\": \"PUBLIC_READ_RATE_LIMIT\",", "\"name\": \"PUBLIC_READS_RATE_LIMIT\","),
  }), ["EDGE_TIER_RATE_LIMIT_MISSING:PUBLIC_READ_RATE_LIMIT",
    "RATE_LIMIT_UNCLASSIFIED:PUBLIC_READS_RATE_LIMIT"]);
  // The edge enforces its own values; the origin never pins them.
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"simple\": { \"limit\": 5, \"period\": 60 }", "\"simple\": { \"limit\": 6, \"period\": 60 }"),
  }), []);
});

test("unclassified or undeclared vars, secrets and hosts fail", async () => {
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"PUBLIC_ANALYTICS_MODE\": \"enabled\",",
      "\"PUBLIC_ANALYTICS_MODE\": \"enabled\",\n        \"SYNTHETIC_NEW_MODE\": \"enabled\","),
  }), ["VAR_UNCLASSIFIED:SYNTHETIC_NEW_MODE"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "        \"INCREMENTAL_EXTERNAL_PARTICIPANTS\": \"authorized\",\n", ""),
  }), ["VAR_UNDECLARED:INCREMENTAL_EXTERNAL_PARTICIPANTS"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"PUBLIC_ANALYTICS_MODE\": \"enabled\",",
      "\"PUBLIC_ANALYTICS_MODE\": \"enabled\",\n        \"EDGE_ORIGIN_MODE\": \"cloudflare-worker-iam\","),
  }), ["ORIGIN_ONLY_VAR_IN_WRANGLER:EDGE_ORIGIN_MODE"]);
  // Edge-only vars may change freely; they never reach the origin.
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"SPARKLE_APPCAST_GUARD_CHANNEL\": \"stable\"", "\"SPARKLE_APPCAST_GUARD_CHANNEL\": \"beta\""),
  }), []);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"GOOGLE_OIDC_CLIENT_SECRET\"\n", "\"GOOGLE_OIDC_CLIENT_SECRET\",\n          \"SYNTHETIC_NEW_SECRET\"\n"),
  }), ["SECRET_UNCLASSIFIED:SYNTHETIC_NEW_SECRET"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT, "          \"APPLE_PRIVATE_KEY\",\n", ""),
  }), ["SECRET_UNDECLARED:APPLE_PRIVATE_KEY"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "{ \"pattern\": \"www.tibotattle.com\", \"custom_domain\": true },",
      "{ \"pattern\": \"www2.tibotattle.com\", \"custom_domain\": true },"),
  }), ["PRODUCTION_HOSTS_DRIFT"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"bucket_name\": \"app-usagemonitor-production-quarantine\"",
      "\"bucket_name\": \"app-usagemonitor-production-quarantine-v2\""),
  }), ["FINGERPRINT_CLOUDFLARE_RESOURCES_DRIFT"]);
});

test("live overrides come only from the receipt, and a stale or mismatched one fails", async () => {
  // Without the receipt, the live typed pin is drift from the checked-in json.
  assert.deepEqual(await driftOfTempCopy({
    receiptText: doctorReceipt((receipt) => { receipt.overrides = {}; }),
  }), ["VAR_DRIFT:TELEMETRY_STORAGE_MODE"]);
  // Once wrangler.jsonc says typed too, the override is stale and must go.
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"TELEMETRY_STORAGE_MODE\": \"json\"", "\"TELEMETRY_STORAGE_MODE\": \"typed\""),
  }), ["LIVE_OVERRIDE_STALE:TELEMETRY_STORAGE_MODE"]);
  assert.deepEqual(await driftOfTempCopy({
    receiptText: doctorReceipt((receipt) => { receipt.overrides.ENROLLMENT_MODE = "typed"; }),
  }), ["LIVE_OVERRIDE_MISMATCH:ENROLLMENT_MODE"]);
  assert.deepEqual(await driftOfTempCopy({
    receiptText: doctorReceipt((receipt) => { receipt.overrides.TELEMETRY_STORAGE_MODE = "json"; }),
  }), [
    "LIVE_OVERRIDE_MISMATCH:TELEMETRY_STORAGE_MODE",
    "LIVE_OVERRIDE_STALE:TELEMETRY_STORAGE_MODE",
    "RECEIPT_VALUE_INVALID:TELEMETRY_STORAGE_MODE",
  ]);
  assert.deepEqual(await driftOfTempCopy({
    receiptText: doctorReceipt((receipt) => { receipt.overrides.SYNTHETIC_SETTING = "typed"; }),
  }), ["LIVE_OVERRIDE_UNUSED:SYNTHETIC_SETTING", "RECEIPT_OVERRIDE_UNKNOWN:SYNTHETIC_SETTING"]);
  for (const receiptText of [
    doctorReceipt((receipt) => { receipt.observedAt = "2026-09-23"; }),
    doctorReceipt((receipt) => { receipt.schemaVersion = "v0"; }),
    "not json",
  ]) {
    assert.deepEqual(await driftOfTempCopy({ receiptText }), [
      "RECEIPT_INVALID",
      "VAR_DRIFT:TELEMETRY_STORAGE_MODE",
    ]);
  }
});

test("the production build differs from the test build only in its placeholders", () => {
  const build = (text) => productionBuildFindings({
    testBuildText: TEST_BUILD_TEXT,
    productionBuildText: text,
  });
  assert.deepEqual(build(doctor(PRODUCTION_BUILD_TEXT,
    "--file=apps/worker/cloud-run/Dockerfile", "--file=apps/worker/cloud-run/Dockerfile.production")),
  ["PRODUCTION_BUILD_DRIFT"]);
  assert.deepEqual(build(doctor(PRODUCTION_BUILD_TEXT,
    "  requestedVerifyOption: VERIFIED\n", "")), ["PRODUCTION_BUILD_DRIFT"]);
  assert.deepEqual(build(doctor(PRODUCTION_BUILD_TEXT, PRODUCTION_BUILD_SERVICE_ACCOUNT,
    "serviceAccount: projects/tibotattle/serviceAccounts/tibotattle-test-builder@tibotattle.iam.gserviceaccount.com")),
  ["PRODUCTION_BUILD_CONCRETE_IDENTIFIER", "PRODUCTION_BUILD_DRIFT"]);
  assert.deepEqual(build(doctor(PRODUCTION_BUILD_TEXT, PRODUCTION_BUILD_IMAGE,
    "  _IMAGE: us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host:content-digest-required")),
  ["PRODUCTION_BUILD_CONCRETE_IDENTIFIER", "PRODUCTION_BUILD_DRIFT"]);
  const builder = /gcr\.io\/cloud-builders\/docker@sha256:[0-9a-f]{64}/u.exec(TEST_BUILD_TEXT)?.[0];
  assert.ok(builder);
  assert.deepEqual(build(doctor(PRODUCTION_BUILD_TEXT, builder, "gcr.io/cloud-builders/docker:latest")),
    ["PRODUCTION_BUILD_DRIFT"]);
});
