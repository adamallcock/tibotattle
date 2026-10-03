/**
 * Repo-only drift guard for the Cloud Run production configuration.
 *
 * The origin's frozen constants (cloud-run/postgres-production-configuration.mjs)
 * mirror the checked-in Worker configuration, wrangler.jsonc env.production.
 * Every production var and rate limit there must be accounted for:
 *
 *   - a var equals PRODUCTION_VARS, unless production-live-settings.receipt.json
 *     records a live override, in which case PRODUCTION_VARS carries the live
 *     value and the checked-in value must still be the one the receipt
 *     recorded it replacing (equal to the live value it is stale; anything
 *     else is base drift). The receipt also records when, and from which
 *     Worker version, the live value was observed;
 *   - a var may instead be edge-only (it stays with the Cloudflare edge) or
 *     deployment-provided (each deployment supplies and validates it);
 *   - a var in the closed rotated category (ORIGIN_ROTATED_VAR_NAMES) must
 *     equal its recorded `wrangler` value in wrangler.jsonc and its recorded
 *     `origin` value in PRODUCTION_VARS. Round 16 rotates the lost
 *     IDENTITY_LINK_SECRET at the cutover: the origin mounts a new secret
 *     under production-v2, while wrangler.jsonc keeps production-v1, which
 *     names the Cloudflare secret until its deletion. This is a reviewed
 *     divergence, not an observed live override, so the live-settings
 *     receipt never records it;
 *   - every PRODUCTION_VARS key is in wrangler.jsonc or declared origin-only;
 *   - the eight rate limits split into the six edge-tier names and the two
 *     origin-tier limits, whose values must match;
 *   - the Worker's required secrets are a subset of the origin's, and the
 *     production hostnames and Cloudflare resource names match the frozen
 *     origins and fingerprint;
 *   - the staging plane's closed posture (STAGING_CONTAINMENT_VARS and
 *     STAGING_ORIGIN_TIER_RATE_LIMITS) equals the checked-in staging Worker's
 *     (wrangler.jsonc env.staging), which declares no external participants.
 *
 * It also pins cloudbuild.production.yaml to the test build line for line,
 * apart from its placeholder service account and image. Nothing here reads a
 * live resource. Each guarded property is shown to fail on a doctored temp
 * copy.
 *
 * The origin has one Cloud SQL instance and no deletion ledger (decisions D2
 * and D4, SIMP-0 item 7). The retired ledger and bucket-history settings are
 * never origin configuration: a wrangler var of that name is unclassified
 * drift. The Cloudflare deletion-ledger D1 stays in the production
 * fingerprint and its DELETION_LEDGER binding stays absent from the origin
 * env: that is cutover hygiene for the Worker, not a GCP resource.
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
// The receipt is content-free: setting names, these values and the
// observation's provenance (the date it was recorded, the Worker version and
// its version id) only. Widening a set is a deliberate review, not a drift fix.
const RECEIPT_KEYS = "overrides,recordedOn,schemaVersion,workerVersion,workerVersionId";
const RECEIPT_OVERRIDE_KEYS = "checkedIn,live";
const RECEIPT_VALUES = new Set(["json", "typed"]);
const RECEIPT_DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const RECEIPT_VERSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PRODUCTION_BUILD_SERVICE_ACCOUNT = "serviceAccount: projects/${PROJECT}/serviceAccounts/${BUILDER_SA}";
const PRODUCTION_BUILD_IMAGE = "  _IMAGE: ${IMAGE_REPOSITORY}:source-${SOURCE_COMMIT}";
/**
 * Vars the origin deliberately rotated away from the checked-in Worker
 * value. Closed: widening it is a reviewed owner decision (round 16 for the
 * identity-link label), never a drift fix.
 */
const ORIGIN_ROTATED_VAR_NAMES = Object.freeze({
  IDENTITY_LINK_SECRET_VERSION: Object.freeze({ wrangler: "production-v1", origin: "production-v2" }),
});

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

function calendarDate(value) {
  if (typeof value !== "string" || !RECEIPT_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function receiptOverride(entry) {
  return isObject(entry) && Object.keys(entry).sort().join() === RECEIPT_OVERRIDE_KEYS
    && RECEIPT_VALUES.has(entry.checkedIn) && RECEIPT_VALUES.has(entry.live)
    && entry.checkedIn !== entry.live;
}

/**
 * The receipt names each overridden var with the checked-in value it
 * replaces and the live value, plus when and from which Worker version the
 * live values were recorded. A malformed override is reported and ignored.
 */
function receiptFindings(receipt) {
  if (!isObject(receipt) || Object.keys(receipt).sort().join() !== RECEIPT_KEYS
      || receipt.schemaVersion !== RECEIPT_SCHEMA || !calendarDate(receipt.recordedOn)
      || !Number.isSafeInteger(receipt.workerVersion) || receipt.workerVersion < 1
      || typeof receipt.workerVersionId !== "string"
      || !RECEIPT_VERSION_ID_PATTERN.test(receipt.workerVersionId)
      || !isObject(receipt.overrides)) {
    return { findings: ["RECEIPT_INVALID"], overrides: {} };
  }
  const findings = [];
  const overrides = {};
  for (const [name, entry] of Object.entries(receipt.overrides)) {
    if (!Object.hasOwn(configuration.PRODUCTION_VARS, name)) {
      findings.push(`RECEIPT_OVERRIDE_UNKNOWN:${name}`);
    }
    if (!receiptOverride(entry)) {
      findings.push(`RECEIPT_VALUE_INVALID:${name}`);
      continue;
    }
    overrides[name] = entry;
  }
  return { findings, overrides };
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
    if (Object.hasOwn(ORIGIN_ROTATED_VAR_NAMES, name)) {
      const rotated = ORIGIN_ROTATED_VAR_NAMES[name];
      if (Object.hasOwn(overrides, name)) findings.push(`ROTATED_VAR_LIVE_OVERRIDE:${name}`);
      if (value !== rotated.wrangler) findings.push(`ROTATED_VAR_WRANGLER_DRIFT:${name}`);
      if (pinned[name] !== rotated.origin) findings.push(`ROTATED_VAR_ORIGIN_DRIFT:${name}`);
      continue;
    }
    if (Object.hasOwn(overrides, name)) {
      const { checkedIn, live } = overrides[name];
      if (pinned[name] !== live) findings.push(`LIVE_OVERRIDE_MISMATCH:${name}`);
      // wrangler.jsonc caught up with production: the override must go.
      if (value === live) findings.push(`LIVE_OVERRIDE_STALE:${name}`);
      // wrangler.jsonc moved elsewhere: the receipt no longer describes it.
      else if (value !== checkedIn) findings.push(`LIVE_OVERRIDE_BASE_DRIFT:${name}`);
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

/** The staging plane's closed posture must stay the staging Worker's. */
function stagingFindings(staging) {
  if (!isObject(staging) || !isObject(staging.vars) || !Array.isArray(staging.ratelimits)) {
    return ["WRANGLER_STAGING_INVALID"];
  }
  const findings = [];
  for (const [name, value] of Object.entries(configuration.STAGING_CONTAINMENT_VARS)) {
    if (staging.vars[name] !== value) findings.push(`STAGING_VAR_DRIFT:${name}`);
  }
  for (const name of configuration.STAGING_ABSENT_VAR_NAMES) {
    if (Object.hasOwn(staging.vars, name)) findings.push(`STAGING_VAR_PRESENT:${name}`);
  }
  for (const [name, limit] of Object.entries(configuration.STAGING_ORIGIN_TIER_RATE_LIMITS)) {
    const entries = staging.ratelimits.filter((entry) => entry?.name === limit.binding);
    if (entries.length !== 1 || entries[0].simple?.limit !== limit.limit
        || entries[0].simple?.period !== limit.periodSeconds) {
      findings.push(`STAGING_ORIGIN_TIER_LIMIT_DRIFT:${name}`);
    }
  }
  return findings;
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
    ...stagingFindings(wrangler.env.staging),
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

/** Doctors a line inside env.staging only (env.production follows it). */
function doctorStaging(text, from, to) {
  const start = text.indexOf("\n    \"staging\": {");
  const end = text.indexOf("\n    \"production\": {");
  assert.ok(start > 0 && end > start);
  return text.slice(0, start) + doctor(text.slice(start, end), from, to) + text.slice(end);
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

test("the receipt records only the live typed-storage override and its provenance, content-free", () => {
  // Re-observing live production is a deliberate change to this pin.
  assert.deepEqual(JSON.parse(RECEIPT_TEXT), {
    schemaVersion: RECEIPT_SCHEMA,
    recordedOn: "2026-09-24",
    workerVersion: 152,
    workerVersionId: "a2c8a0c4-bedc-48fd-8b01-345b316c02a2",
    overrides: { TELEMETRY_STORAGE_MODE: { checkedIn: "json", live: "typed" } },
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

test("round 16: the identity-link label is the one closed rotated var, held at both recorded values", async () => {
  assert.deepEqual(JSON.parse(JSON.stringify(ORIGIN_ROTATED_VAR_NAMES)),
    { IDENTITY_LINK_SECRET_VERSION: { wrangler: "production-v1", origin: "production-v2" } });
  // The origin side is the configuration's rotated label; the wrangler side its retired one.
  assert.equal(ORIGIN_ROTATED_VAR_NAMES.IDENTITY_LINK_SECRET_VERSION.origin,
    configuration.PRODUCTION_IDENTITY_LINK_SECRET_VERSION);
  assert.deepEqual([...configuration.PRODUCTION_RETIRED_IDENTITY_LINK_VERSIONS],
    [ORIGIN_ROTATED_VAR_NAMES.IDENTITY_LINK_SECRET_VERSION.wrangler]);
  assert.equal(configuration.PRODUCTION_VARS.IDENTITY_LINK_SECRET_VERSION, "production-v2");
  // wrangler.jsonc keeps production-v1: it names the Cloudflare secret, which
  // nobody rewrites before the switch.
  assert.ok(WRANGLER_TEXT.includes("\"IDENTITY_LINK_SECRET_VERSION\": \"production-v1\""));
  // Moving wrangler to the new label, or anywhere else, is drift.
  for (const label of ["production-v2", "production-v3"]) {
    assert.deepEqual(await driftOfTempCopy({
      wranglerText: doctorProduction(WRANGLER_TEXT, "\"IDENTITY_LINK_SECRET_VERSION\": \"production-v1\"",
        `"IDENTITY_LINK_SECRET_VERSION": "${label}"`),
    }), ["ROTATED_VAR_WRANGLER_DRIFT:IDENTITY_LINK_SECRET_VERSION"], label);
  }
  // The live-settings receipt must not be used to carry the rotation.
  assert.deepEqual(await driftOfTempCopy({
    receiptText: doctorReceipt((receipt) => {
      receipt.overrides.IDENTITY_LINK_SECRET_VERSION = { checkedIn: "json", live: "typed" };
    }),
  }), ["ROTATED_VAR_LIVE_OVERRIDE:IDENTITY_LINK_SECRET_VERSION"]);
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

test("a malformed or repeated rate limit fails, even an edge-tier one", async () => {
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"simple\": { \"limit\": 5, \"period\": 60 }", "\"simple\": { \"limit\": \"5\", \"period\": 60 }"),
  }), ["RATE_LIMIT_INVALID:CLIENT_ATTEMPT_RATE_LIMIT"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"simple\": { \"limit\": 5, \"period\": 60 }", "\"simple\": { \"limit\": 5, \"period\": 0 }"),
  }), ["RATE_LIMIT_INVALID:CLIENT_ATTEMPT_RATE_LIMIT"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT, UPLOAD_AUTHORIZATION_LIMIT,
      UPLOAD_AUTHORIZATION_LIMIT.replace("\"limit\": 3000", "\"limit\": 3000.5")),
  }), ["RATE_LIMIT_INVALID:UPLOAD_AUTHORIZATION_RATE_LIMIT"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"name\": \"RECOVERY_RATE_LIMIT\",", "\"name\": \"ENROLLMENT_RATE_LIMIT\","),
  }), ["EDGE_TIER_RATE_LIMIT_MISSING:RECOVERY_RATE_LIMIT", "RATE_LIMIT_DUPLICATE:ENROLLMENT_RATE_LIMIT"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"name\": \"UPLOAD_PRINCIPAL_RATE_LIMIT\",", "\"name\": \"UPLOAD_AUTHORIZATION_RATE_LIMIT\","),
  }), ["ORIGIN_TIER_RATE_LIMIT_MISSING:UPLOAD_PRINCIPAL_RATE_LIMIT",
    "RATE_LIMIT_DUPLICATE:UPLOAD_AUTHORIZATION_RATE_LIMIT"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"name\": \"PUBLIC_READ_RATE_LIMIT\",", "\"name\": 4,"),
  }), ["EDGE_TIER_RATE_LIMIT_MISSING:PUBLIC_READ_RATE_LIMIT", "RATE_LIMIT_INVALID"]);
});

test("the staging plane's closed posture matches the staging Worker's", async () => {
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorStaging(WRANGLER_TEXT,
      "\"SIGN_IN_START_MAX_PER_MINUTE\": \"5\"", "\"SIGN_IN_START_MAX_PER_MINUTE\": \"300\""),
  }), ["STAGING_VAR_DRIFT:SIGN_IN_START_MAX_PER_MINUTE"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorStaging(WRANGLER_TEXT,
      "\"ENROLLMENT_MODE\": \"disabled\"", "\"ENROLLMENT_MODE\": \"open\""),
  }), ["STAGING_VAR_DRIFT:ENROLLMENT_MODE"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorStaging(WRANGLER_TEXT,
      "\"ACCOUNTLESS_OWNERSHIP_MODE\": \"disabled\",",
      "\"ACCOUNTLESS_OWNERSHIP_MODE\": \"disabled\",\n        \"INCREMENTAL_EXTERNAL_PARTICIPANTS\": \"authorized\","),
  }), ["STAGING_VAR_PRESENT:INCREMENTAL_EXTERNAL_PARTICIPANTS"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorStaging(WRANGLER_TEXT,
      "\"simple\": { \"limit\": 6, \"period\": 60 }", "\"simple\": { \"limit\": 7, \"period\": 60 }"),
  }), ["STAGING_ORIGIN_TIER_LIMIT_DRIFT:UPLOAD_PRINCIPAL"]);
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorStaging(WRANGLER_TEXT,
      "\"name\": \"UPLOAD_AUTHORIZATION_RATE_LIMIT\",", "\"name\": \"UPLOAD_AUTHORIZATION_RATE_LIMIT_V2\","),
  }), ["STAGING_ORIGIN_TIER_LIMIT_DRIFT:UPLOAD_AUTHORIZATION"]);
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

test("the retired ledger and history-proof settings are never origin configuration", async () => {
  const retired = [
    "LEDGER_INSTANCE_CONNECTION_NAME", "LEDGER_DATABASE", "LEDGER_SCHEMA", "GCS_ERASURE_BUCKET_HISTORY_PROOF",
  ];
  const secrets = [...configuration.REQUIRED_SECRET_NAMES, ...configuration.OPTIONAL_SECRET_NAMES];
  for (const name of retired) {
    assert.equal(Object.hasOwn(configuration.PRODUCTION_VARS, name), false, name);
    assert.equal(configuration.DEPLOYMENT_PROVIDED_VAR_NAMES.includes(name), false, name);
    assert.equal(configuration.ORIGIN_ONLY_VAR_NAMES.includes(name), false, name);
    assert.equal(secrets.includes(name), false, name);
    assert.equal(configuration.PRODUCTION_FORBIDDEN_VARIABLES[name], `${name}_FORBIDDEN`, name);
    // Declared in wrangler.jsonc, it is unclassified drift, never pinned or provided.
    assert.deepEqual(await driftOfTempCopy({
      wranglerText: doctorProduction(WRANGLER_TEXT,
        "\"PUBLIC_ANALYTICS_MODE\": \"enabled\",",
        `"PUBLIC_ANALYTICS_MODE": "enabled",\n        ${JSON.stringify(name)}: "synthetic",`),
    }), [`VAR_UNCLASSIFIED:${name}`], name);
  }
  assert.equal(configuration.PRODUCTION_FORBIDDEN_VARIABLE_PREFIXES.LEDGER_, "LEDGER_CONFIGURATION_FORBIDDEN");
  // OD-2 re-admits the quarantine bucket's birth proof under its own name as
  // a resource setting (like GCS_BUCKET_NAME): never a Worker var, a secret
  // or a forbidden variable.
  const quarantineProof = configuration.QUARANTINE_BUCKET_HISTORY_PROOF_SETTING;
  assert.equal(quarantineProof, "GCS_QUARANTINE_BUCKET_HISTORY_PROOF");
  assert.equal(Object.hasOwn(configuration.PRODUCTION_VARS, quarantineProof), false);
  assert.equal(configuration.DEPLOYMENT_PROVIDED_VAR_NAMES.includes(quarantineProof), false);
  assert.equal(secrets.includes(quarantineProof), false);
  assert.equal(Object.hasOwn(configuration.PRODUCTION_FORBIDDEN_VARIABLES, quarantineProof), false);
  // The Worker's deletion-ledger D1 stays fingerprinted (staging may never
  // name it) and its binding never reaches the origin env.
  assert.ok(configuration.PRODUCTION_RESOURCE_FINGERPRINT.cloudflareResourceNames
    .includes("app-usagemonitor-production-deletion-ledger"));
  assert.ok(configuration.PRODUCTION_WORKER_ENV_ABSENT_KEYS.includes("DELETION_LEDGER"));
  assert.deepEqual(await driftOfTempCopy({
    wranglerText: doctorProduction(WRANGLER_TEXT,
      "\"database_name\": \"app-usagemonitor-production-deletion-ledger\"",
      "\"database_name\": \"app-usagemonitor-production-deletion-ledger-v2\""),
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
  // Any other checked-in change to an overridden var is drift from the receipt.
  for (const mode of ["synthetic-future-mode", "", "JSON"]) {
    assert.deepEqual(await driftOfTempCopy({
      wranglerText: doctorProduction(WRANGLER_TEXT,
        "\"TELEMETRY_STORAGE_MODE\": \"json\"", `"TELEMETRY_STORAGE_MODE": ${JSON.stringify(mode)}`),
    }), ["LIVE_OVERRIDE_BASE_DRIFT:TELEMETRY_STORAGE_MODE"], mode);
  }
  assert.deepEqual(await driftOfTempCopy({
    receiptText: doctorReceipt((receipt) => {
      receipt.overrides.ENROLLMENT_MODE = { checkedIn: "json", live: "typed" };
    }),
  }), ["LIVE_OVERRIDE_BASE_DRIFT:ENROLLMENT_MODE", "LIVE_OVERRIDE_MISMATCH:ENROLLMENT_MODE"]);
  assert.deepEqual(await driftOfTempCopy({
    receiptText: doctorReceipt((receipt) => {
      receipt.overrides.TELEMETRY_STORAGE_MODE = { checkedIn: "typed", live: "json" };
    }),
  }), ["LIVE_OVERRIDE_MISMATCH:TELEMETRY_STORAGE_MODE", "LIVE_OVERRIDE_STALE:TELEMETRY_STORAGE_MODE"]);
  assert.deepEqual(await driftOfTempCopy({
    receiptText: doctorReceipt((receipt) => {
      receipt.overrides.SYNTHETIC_SETTING = { checkedIn: "json", live: "typed" };
    }),
  }), ["LIVE_OVERRIDE_UNUSED:SYNTHETIC_SETTING", "RECEIPT_OVERRIDE_UNKNOWN:SYNTHETIC_SETTING"]);
  // A malformed override is reported and ignored, so the pinned typed value drifts.
  for (const entry of [
    "typed",
    { checkedIn: "json", live: "enabled" },
    { checkedIn: "typed", live: "typed" },
    { checkedIn: "json" },
    { checkedIn: "json", live: "typed", note: "synthetic" },
    null,
  ]) {
    assert.deepEqual(await driftOfTempCopy({
      receiptText: doctorReceipt((receipt) => { receipt.overrides.TELEMETRY_STORAGE_MODE = entry; }),
    }), [
      "RECEIPT_VALUE_INVALID:TELEMETRY_STORAGE_MODE",
      "VAR_DRIFT:TELEMETRY_STORAGE_MODE",
    ], JSON.stringify(entry));
  }
  // Provenance is required and closed.
  for (const receiptText of [
    doctorReceipt((receipt) => { receipt.observedAt = "2026-09-23"; }),
    doctorReceipt((receipt) => { delete receipt.recordedOn; }),
    doctorReceipt((receipt) => { receipt.recordedOn = "2026-02-30"; }),
    doctorReceipt((receipt) => { receipt.recordedOn = "2026-09-24T00:00:00Z"; }),
    doctorReceipt((receipt) => { delete receipt.workerVersion; }),
    doctorReceipt((receipt) => { receipt.workerVersion = "152"; }),
    doctorReceipt((receipt) => { receipt.workerVersion = 0; }),
    doctorReceipt((receipt) => { receipt.workerVersion = 152.5; }),
    doctorReceipt((receipt) => { delete receipt.workerVersionId; }),
    doctorReceipt((receipt) => { receipt.workerVersionId = receipt.workerVersionId.toUpperCase(); }),
    doctorReceipt((receipt) => { receipt.workerVersionId = "version-152"; }),
    doctorReceipt((receipt) => { receipt.schemaVersion = "v0"; }),
    doctorReceipt((receipt) => { receipt.overrides = []; }),
    "not json",
  ]) {
    assert.deepEqual(await driftOfTempCopy({ receiptText }), [
      "RECEIPT_INVALID",
      "VAR_DRIFT:TELEMETRY_STORAGE_MODE",
    ], receiptText);
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
