/**
 * Offline check of the production configuration module. Every environment
 * here is synthetic and content-free; nothing reads or writes a live
 * resource. The module under test is imported the way the infrastructure
 * scripts import it (plain Node); the Worker's canonical TypeScript
 * validators are loaded through Vite only to cross-check the mirrors.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspect } from "node:util";
import { createServer } from "vite";
import { normalizeIamUser } from "./cloud-sql.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./cloud-run-iam-test-target.mjs";
import * as configuration from "./postgres-production-configuration.mjs";

const {
  createProductionWorkerEnv,
  readProductionConfiguration,
  revealProductionSecret,
} = configuration;

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(ROOT, "..");
const MODULE_PATH = resolve(ROOT, "postgres-production-configuration.mjs");

const vite = await createServer({
  root: WORKER_ROOT,
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true, ws: false },
  appType: "custom",
});
let canonical;
try {
  const [storage, crypto, identityLink, postgresClient, apple, rateLimiter, publication, quarantineStore] = await Promise.all([
    vite.ssrLoadModule("/src/telemetry-storage-mode.ts"),
    vite.ssrLoadModule("/src/crypto.ts"),
    vite.ssrLoadModule("/src/identity-link-configuration.ts"),
    vite.ssrLoadModule("/src/postgres-client.ts"),
    vite.ssrLoadModule("/src/identity-apple.ts"),
    vite.ssrLoadModule("/src/postgres-rate-limiter.ts"),
    vite.ssrLoadModule("/src/storage-publication-worker.ts"),
    vite.ssrLoadModule("/src/gcs-quarantine-object-store.ts"),
  ]);
  canonical = { storage, crypto, identityLink, postgresClient, apple, rateLimiter, publication, quarantineStore };
} finally {
  await vite.close();
}

// ---------------------------------------------------------------------------
// Synthetic fixtures

const SECRET_VALUES = Object.freeze({
  IDENTITY_LINK_SECRET: "synthetic-identity-link-secret-value-0000000001",
  POSTGRES_RATE_LIMIT_SECRET: "synthetic-rate-limit-secret-value-00000000002",
  GOOGLE_OIDC_CLIENT_SECRET: "synthetic-google-client-secret-value-3",
  APPLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nc3ludGhldGljLWFwcGxlLWtleQ==\\n-----END PRIVATE KEY-----",
  DISTRIBUTION_GITHUB_API_TOKEN: "synthetic-github-token-value-4",
});
const PRIVATE_EXPONENT = "synthetic-private-exponent-value-5";

function envelopeKeys(kid) {
  return {
    ENVELOPE_PUBLIC_JWK: JSON.stringify({ kty: "RSA", kid, n: "synthetic-modulus", e: "AQAB" }),
    ENVELOPE_PRIVATE_JWK: JSON.stringify({
      kty: "RSA", kid, n: "synthetic-modulus", e: "AQAB", d: PRIVATE_EXPONENT,
    }),
  };
}

/**
 * A bucket-birth history proof (the OPS-2 receipt's proof record): required
 * as GCS_QUARANTINE_BUCKET_HISTORY_PROOF (OD-2), refused under the retired
 * GCS_ERASURE_BUCKET_HISTORY_PROOF name.
 */
function proof(bucket, extra = {}) {
  return JSON.stringify({
    bucket,
    bucketGeneration: "1700000000000001",
    bucketMetageneration: "1",
    softDeleteRetentionDurationSeconds: "0",
    ...extra,
  });
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const EDGE_INVOKER = "edge-invoker@synthetic-project.iam.gserviceaccount.com";
const VERIFIERS = [
  "edge-verifier-a@synthetic-project.iam.gserviceaccount.com",
  "edge-verifier-b@synthetic-project.iam.gserviceaccount.com",
  "edge-verifier-c@synthetic-project.iam.gserviceaccount.com",
  "edge-verifier-d@synthetic-project.iam.gserviceaccount.com",
  "edge-verifier-e@synthetic-project.iam.gserviceaccount.com",
];

function productionResources() {
  return {
    DEPLOYMENT_SOURCE_COMMIT: COMMIT,
    TELEMETRY_STORAGE_NAMESPACE: "synthetic-namespace",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-primary",
    PRIMARY_DATABASE: "origin_primary",
    PRIMARY_SCHEMA: "origin_primary",
    POSTGRES_IAM_USER: "origin-runtime@synthetic-project.iam",
    GCS_BUCKET_NAME: "synthetic-origin-quarantine",
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: proof("synthetic-origin-quarantine"),
  };
}

function serviceSecrets() {
  return {
    ...envelopeKeys("key:synthetic-production-check"),
    IDENTITY_LINK_SECRET: SECRET_VALUES.IDENTITY_LINK_SECRET,
    POSTGRES_RATE_LIMIT_SECRET: SECRET_VALUES.POSTGRES_RATE_LIMIT_SECRET,
    GOOGLE_OIDC_CLIENT_SECRET: SECRET_VALUES.GOOGLE_OIDC_CLIENT_SECRET,
    APPLE_PRIVATE_KEY: SECRET_VALUES.APPLE_PRIVATE_KEY,
    DISTRIBUTION_GITHUB_API_TOKEN: SECRET_VALUES.DISTRIBUTION_GITHUB_API_TOKEN,
  };
}

// The secrets each job consumes, listed here independently of the module.
const JOB_SECRET_NAMES = Object.freeze({
  "maintenance-job": ["IDENTITY_LINK_SECRET", "DISTRIBUTION_GITHUB_API_TOKEN"],
  "analytics-job": [],
  "staging-maintenance-job": ["IDENTITY_LINK_SECRET"],
  "staging-analytics-job": [],
});
const JOB_PROFILES = Object.freeze(Object.keys(JOB_SECRET_NAMES));
const SERVICE_ONLY_SECRET_NAMES = Object.freeze([
  "POSTGRES_RATE_LIMIT_SECRET", "ENVELOPE_PUBLIC_JWK", "ENVELOPE_PRIVATE_JWK",
  "GOOGLE_OIDC_CLIENT_SECRET", "APPLE_PRIVATE_KEY",
]);

function productionEnv(overrides = {}) {
  return {
    HOST: "0.0.0.0",
    HOST_MODE: "production",
    K_SERVICE: "tibotattle-origin",
    HOST_ORIGIN: "https://tibotattle-origin-abc123def4-ue.a.run.app",
    PUBLIC_ORIGIN: "https://tibotattle.com",
    EDGE_ORIGIN_MODE: "cloudflare-worker-iam",
    EDGE_ORIGIN_AUDIENCE: "tibotattle-origin-audience",
    EDGE_INVOKER_SERVICE_ACCOUNT: EDGE_INVOKER,
    EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: "",
    ...productionResources(),
    ...serviceSecrets(),
    ...overrides,
  };
}

/** The staging plane's own origins, resources and identity vars. */
function stagingPlane() {
  return {
    PUBLIC_ORIGIN: "https://staging.synthetic.example",
    ADMIN_HOST_ORIGIN: "https://admin.staging.synthetic.example",
    TELEMETRY_STORAGE_NAMESPACE: "synthetic-staging-namespace",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-staging-primary",
    GCS_BUCKET_NAME: "synthetic-staging-quarantine",
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: proof("synthetic-staging-quarantine"),
    ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    ACCESS_ADMIN_EMAIL: "owner@synthetic.example",
    IDENTITY_LINK_SECRET_VERSION: "staging-v1",
    GOOGLE_OIDC_CLIENT_ID: "123456789012-syntheticstaging.apps.googleusercontent.com",
    APPLE_SERVICES_ID: "example.synthetic.staging",
    APPLE_KEY_ID: "SYNTHKEY01",
    APPLE_TEAM_ID: "SYNTHTEAM1",
  };
}

function stagingEnv(overrides = {}) {
  return {
    ...productionEnv(),
    HOST_MODE: "staging",
    K_SERVICE: "tibotattle-staging-origin",
    HOST_ORIGIN: "https://tibotattle-staging-origin-abc123def4-ue.a.run.app",
    EDGE_ORIGIN_AUDIENCE: "tibotattle-staging-origin-audience",
    ...stagingPlane(),
    ...envelopeKeys("key:staging-synthetic-check"),
    ...overrides,
  };
}

function jobEnv(profile, overrides = {}) {
  const staging = profile.startsWith("staging-");
  const maintenance = profile.endsWith("maintenance-job");
  return {
    CLOUD_RUN_JOB: `tibotattle-${staging ? "staging-" : ""}${maintenance ? "maintenance" : "analytics-delivery"}`,
    ...productionResources(),
    ...(staging ? stagingPlane() : {}),
    ...Object.fromEntries(JOB_SECRET_NAMES[profile].map((name) => [name, SECRET_VALUES[name]])),
    ...(maintenance ? { POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled" } : {}),
    ...overrides,
  };
}

function without(env, ...names) {
  const copy = { ...env };
  for (const name of names) delete copy[name];
  return copy;
}

function limiter() {
  return Object.freeze({ async limit() { return { success: true }; } });
}

/** An origin-tier limiter exposing its limits as PostgresRateLimiter does. */
function originLimiter(limitValue, periodSeconds) {
  return Object.freeze({ limitValue, periodSeconds, async limit() { return { success: true }; } });
}

/** The nine service bindings, origin-tier limiters built with the given plane's limits. */
function serviceBindings(originTier = configuration.ORIGIN_TIER_RATE_LIMITS) {
  const origin = new Map(Object.values(originTier).map((limits) => [limits.binding, limits]));
  return Object.fromEntries(configuration.PRODUCTION_WORKER_BINDING_NAMES.map((name) => {
    if (name === "UPLOAD_INGRESS_BUDGET") return [name, Object.freeze({ getByName() { return {}; } })];
    const limits = origin.get(name);
    return [name, limits === undefined ? limiter() : originLimiter(limits.limit, limits.periodSeconds)];
  }));
}

const LEAK_MARKERS = Object.freeze([...Object.values(SECRET_VALUES), PRIVATE_EXPONENT]);

// The deletion-ledger and bucket-history settings the single-instance
// configuration retired (decisions D2 and D4, SIMP-0 item 7). Each is refused
// when present at all, even empty, rather than ignored.
const RETIRED_LEDGER_VARIABLE_NAMES = Object.freeze([
  "LEDGER_INSTANCE_CONNECTION_NAME", "LEDGER_DATABASE", "LEDGER_SCHEMA",
  "GCS_ERASURE_BUCKET_HISTORY_PROOF",
]);

// The refused variables, listed here independently of the module. Each one's
// code is `${name}_FORBIDDEN`.
const FORBIDDEN_VARIABLE_NAMES = Object.freeze([
  "ACCESS_TEST_JWKS_JSON", "ADMIN_OWNER_FIXTURE_JSON", "ADMIN_OWNER_PREVIOUS_FIXTURE_JSON",
  "DISTRIBUTION_ANALYTICS_API_TOKEN",
  "EDGE_CLIENT_KEY_SECRET", "EDGE_INVOKER_KEY_JSON", "EDGE_PROOF_SECRET", "EDGE_PROOF_SHA256",
  "IDENTITY_TEST_JWKS_JSON", "POSTGRES_TEST_HTTP_MODE", "SPARKLE_APPCAST_GUARD_TOKEN",
  ...RETIRED_LEDGER_VARIABLE_NAMES,
]);

// Every D1, R2 and asset binding and every test or development seam the
// Worker reads, listed here independently of the module under test.
const REQUIRED_ABSENT_ENV_KEYS = Object.freeze([
  "USAGE_MONITOR_DB",
  "DELETION_LEDGER",
  "ANALYTICS_DB",
  "STORAGE_ANALYTICS_DB",
  "STORAGE_INGESTION_DB",
  "QUARANTINE",
  "SPARKLE_RELEASES",
  "ASSETS",
  "ACCESS_TEST_JWKS_JSON",
  "IDENTITY_TEST_JWKS_JSON",
  "ADMIN_OWNER_FIXTURE_JSON",
  "ADMIN_OWNER_PREVIOUS_FIXTURE_JSON",
  "ADMIN_IDENTITY_LINK_KEY",
  "POSTGRES_TEST_HTTP_MODE",
  "POSTGRES_WORKER_BACKEND",
  "POSTGRES_OBJECT_STORE",
  "POSTGRES_RATE_LIMIT_SECRET",
  "EDGE_PROOF_SECRET",
  "EDGE_PROOF_SHA256",
  "EDGE_CLIENT_KEY_SECRET",
  "EDGE_INVOKER_KEY_JSON",
  "DISTRIBUTION_ANALYTICS_API_TOKEN",
  "DISTRIBUTION_ANALYTICS_ZONE_ID",
  "SPARKLE_APPCAST_GUARD_TOKEN",
]);

function assertNoLeak(value, markers = LEAK_MARKERS) {
  const rendered = [
    typeof value === "string" ? value : "",
    inspect(value, { depth: 8, showHidden: true }),
    (() => { try { return JSON.stringify(value) ?? ""; } catch { return ""; } })(),
    value instanceof Error ? `${value.message}\n${value.stack}\n${String(value.cause)}` : "",
  ].join("\n");
  for (const marker of markers) {
    assert.equal(rendered.includes(marker), false, "a secret value reached the output");
  }
}

function expectCode(action, code, markers) {
  let thrown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, `expected ${code}`);
  assert.equal(thrown.code, code);
  assert.equal(thrown.message, code);
  assert.equal(thrown.cause, undefined);
  assertNoLeak(thrown, markers);
}

function expectAccepted(env, profile) {
  return readProductionConfiguration(env, profile);
}

function assertDeepFrozen(value, path = "value") {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value), `${path} is not frozen`);
  for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], `${path}.${String(key)}`);
}

// Every test runs with console spies installed; the module never writes.
const consoleCalls = [];
for (const method of ["log", "info", "warn", "error", "debug", "trace"]) {
  const original = console[method];
  console[method] = (...args) => {
    consoleCalls.push(method);
    original.apply(console, args);
  };
}
test.afterEach(() => {
  assert.deepEqual(consoleCalls, [], "the configuration module wrote to the console");
});

// ---------------------------------------------------------------------------
// Constants

test("exports the frozen production constants", () => {
  for (const name of Object.keys(configuration)) {
    if (typeof configuration[name] !== "function") assertDeepFrozen(configuration[name], name);
  }
  assert.equal(configuration.PRODUCTION_PUBLIC_ORIGIN, "https://tibotattle.com");
  assert.equal(configuration.PRODUCTION_ADMIN_ORIGIN, "https://admin.tibotattle.com");
  assert.equal(configuration.PRODUCTION_WWW_HOST, "www.tibotattle.com");
  // One Cloud SQL instance and no deletion ledger: no ledger pool, and the
  // one readiness pool opens the primary, 3 + 4 + 1 connections per instance.
  assert.deepEqual(configuration.PRODUCTION_POOL_SIZES, { data: 3, admission: 4, readiness: 1 });
  assert.deepEqual(configuration.PRODUCTION_POOL_INSTANCES, {
    data: ["primary"], admission: ["primary"], readiness: ["primary"],
  });
  assert.deepEqual(configuration.PRODUCTION_POOL_CONNECTIONS_PER_INSTANCE, { primary: 8 });
  assert.deepEqual(configuration.PRODUCTION_ADMISSION_TIMEOUTS, {
    lockTimeoutMilliseconds: 1_000,
    statementTimeoutMilliseconds: 2_000,
  });
  assert.deepEqual(configuration.EDGE_TIER_RATE_LIMIT_NAMES, [
    "ENROLLMENT", "RECOVERY", "CLIENT_ATTEMPT", "PUBLIC_READ",
    "UPLOAD_INGRESS_REQUEST", "UPLOAD_INGRESS_CLIENT",
  ]);
  assert.deepEqual(configuration.ORIGIN_TIER_RATE_LIMITS, {
    UPLOAD_AUTHORIZATION: { binding: "UPLOAD_AUTHORIZATION_RATE_LIMIT", limit: 3_000, periodSeconds: 60 },
    UPLOAD_PRINCIPAL: { binding: "UPLOAD_PRINCIPAL_RATE_LIMIT", limit: 3_000, periodSeconds: 60 },
  });
  assert.deepEqual(configuration.STAGING_ORIGIN_TIER_RATE_LIMITS, {
    UPLOAD_AUTHORIZATION: { binding: "UPLOAD_AUTHORIZATION_RATE_LIMIT", limit: 300, periodSeconds: 60 },
    UPLOAD_PRINCIPAL: { binding: "UPLOAD_PRINCIPAL_RATE_LIMIT", limit: 6, periodSeconds: 60 },
  });
  assert.deepEqual(configuration.PRODUCTION_CONFIGURATION_PROFILES, [
    "production", "staging", "maintenance-job", "analytics-job",
    "staging-maintenance-job", "staging-analytics-job",
  ]);
  const analyticsSwitches = [
    "POSTGRES_ANALYTICS_MODE", "POSTGRES_ANALYTICS_PUBLICATION_LANE",
    "POSTGRES_ANALYTICS_PUBLICATION_EXTERNAL",
  ];
  assert.deepEqual(configuration.PRODUCTION_JOB_SWITCH_NAMES, {
    "maintenance-job": ["POSTGRES_SCHEDULED_MAINTENANCE_ENABLED"],
    "analytics-job": analyticsSwitches,
    "staging-maintenance-job": ["POSTGRES_SCHEDULED_MAINTENANCE_ENABLED"],
    "staging-analytics-job": analyticsSwitches,
  });
  // The staging Worker's closed posture (wrangler.jsonc env.staging).
  assert.deepEqual(configuration.STAGING_CONTAINMENT_VARS, {
    ENROLLMENT_MODE: "disabled",
    ACCOUNTLESS_ENROLLMENT_MODE: "disabled",
    ACCOUNTLESS_OWNERSHIP_MODE: "disabled",
    ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    UPLOAD_INGRESS_QUEUE_MODE: "disabled",
    UPLOAD_INGRESS_MAX_CONCURRENT: "8",
    UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE: "120",
    UPLOAD_INGRESS_BURST: "16",
    UPLOAD_INGRESS_LEASE_SECONDS: "90",
    UPLOAD_INGRESS_BODY_TOTAL_SECONDS: "60",
    UPLOAD_INGRESS_BODY_IDLE_SECONDS: "15",
    SIGN_IN_START_MAX_PER_MINUTE: "5",
  });
  assert.deepEqual(configuration.STAGING_ABSENT_VAR_NAMES, ["INCREMENTAL_EXTERNAL_PARTICIPANTS"]);
  assert.deepEqual(configuration.STAGING_ADMISSION_MODES, {
    closed: {},
    "synthetic-rehearsal": { ACCOUNTLESS_ENROLLMENT_MODE: "enabled", ACCOUNTLESS_OWNERSHIP_MODE: "enabled" },
  });
  assert.deepEqual(configuration.PRODUCTION_WORKER_BINDING_NAMES, [
    "ENROLLMENT_RATE_LIMIT", "RECOVERY_RATE_LIMIT", "CLIENT_ATTEMPT_RATE_LIMIT",
    "PUBLIC_READ_RATE_LIMIT", "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
    "UPLOAD_INGRESS_CLIENT_RATE_LIMIT", "UPLOAD_AUTHORIZATION_RATE_LIMIT",
    "UPLOAD_PRINCIPAL_RATE_LIMIT", "UPLOAD_INGRESS_BUDGET",
  ]);
  assert.deepEqual(configuration.REQUIRED_SECRET_NAMES, [
    "IDENTITY_LINK_SECRET", "POSTGRES_RATE_LIMIT_SECRET", "ENVELOPE_PUBLIC_JWK",
    "ENVELOPE_PRIVATE_JWK", "GOOGLE_OIDC_CLIENT_SECRET", "APPLE_PRIVATE_KEY",
  ]);
  assert.deepEqual(configuration.OPTIONAL_SECRET_NAMES, ["DISTRIBUTION_GITHUB_API_TOKEN"]);
  const service = {
    required: configuration.REQUIRED_SECRET_NAMES,
    optional: configuration.OPTIONAL_SECRET_NAMES,
  };
  assert.deepEqual(configuration.PRODUCTION_PROFILE_SECRET_NAMES, {
    production: service,
    staging: service,
    "maintenance-job": { required: ["IDENTITY_LINK_SECRET"], optional: ["DISTRIBUTION_GITHUB_API_TOKEN"] },
    "analytics-job": { required: [], optional: [] },
    "staging-maintenance-job": { required: ["IDENTITY_LINK_SECRET"], optional: [] },
    "staging-analytics-job": { required: [], optional: [] },
  });
  for (const profile of JOB_PROFILES) {
    const { required, optional } = configuration.PRODUCTION_PROFILE_SECRET_NAMES[profile];
    assert.deepEqual([...required, ...optional], JOB_SECRET_NAMES[profile], profile);
  }
  // Pinned independently of the module, so dropping or relabelling an entry fails here.
  assert.deepEqual(configuration.PRODUCTION_FORBIDDEN_VARIABLES, Object.fromEntries(
    FORBIDDEN_VARIABLE_NAMES.map((name) => [name, `${name}_FORBIDDEN`]),
  ));
  assert.deepEqual(configuration.PRODUCTION_FORBIDDEN_VARIABLE_PREFIXES, {
    HOST_RATE_LIMIT_: "HOST_RATE_LIMIT_OVERRIDE_FORBIDDEN",
    LEDGER_: "LEDGER_CONFIGURATION_FORBIDDEN",
  });
  assert.deepEqual(configuration.EDGE_ONLY_SECRET_NAMES, [
    "EDGE_CLIENT_KEY_SECRET", "EDGE_INVOKER_KEY_JSON", "DISTRIBUTION_ANALYTICS_API_TOKEN",
    "SPARKLE_APPCAST_GUARD_TOKEN",
  ]);
  assert.deepEqual(configuration.ORIGIN_ONLY_SECRET_NAMES, ["POSTGRES_RATE_LIMIT_SECRET"]);
  assert.deepEqual(configuration.EDGE_ONLY_VAR_NAMES, ["DISTRIBUTION_ANALYTICS_ZONE_ID"]);
  assert.deepEqual(configuration.EDGE_ONLY_VAR_PREFIXES, ["SPARKLE_"]);
  assert.deepEqual(configuration.ORIGIN_ONLY_VAR_NAMES, ["PERFORMANCE_TELEMETRY_STORAGE_MODE", "EDGE_ORIGIN_MODE"]);
  assert.deepEqual(configuration.DEPLOYMENT_PROVIDED_VAR_NAMES, [
    "TELEMETRY_STORAGE_NAMESPACE", "DEPLOYMENT_SOURCE_COMMIT",
  ]);
  for (const name of REQUIRED_ABSENT_ENV_KEYS) {
    assert.ok(configuration.PRODUCTION_WORKER_ENV_ABSENT_KEYS.includes(name), name);
  }
  const vars = configuration.PRODUCTION_VARS;
  assert.equal(vars.TELEMETRY_STORAGE_MODE, "typed");
  assert.equal(vars.PERFORMANCE_TELEMETRY_STORAGE_MODE, "enabled");
  assert.equal(vars.EDGE_ORIGIN_MODE, "cloudflare-worker-iam");
  assert.equal(vars.PUBLIC_ORIGIN, configuration.PRODUCTION_PUBLIC_ORIGIN);
  assert.equal(vars.ENVIRONMENT, "production");
  assert.equal(vars.IDENTITY_LINK_SECRET_VERSION, "production-v1");
  // Staging refuses each of these; both OAuth client identities are included.
  assert.deepEqual(configuration.PRODUCTION_RESOURCE_FINGERPRINT, {
    origins: ["https://tibotattle.com", "https://admin.tibotattle.com", "https://www.tibotattle.com"],
    hosts: ["tibotattle.com", "admin.tibotattle.com", "www.tibotattle.com"],
    accessAud: vars.ACCESS_AUD,
    identityLinkSecretVersion: "production-v1",
    googleOidcClientId: vars.GOOGLE_OIDC_CLIENT_ID,
    appleServicesId: "com.usagemonitor.web",
    appleKeyId: vars.APPLE_KEY_ID,
    cloudflareResourceNames: [
      "app-usagemonitor",
      "app-usagemonitor-production",
      "app-usagemonitor-production-deletion-ledger",
      "app-usagemonitor-production-quarantine",
      "tibotattle-updates",
    ],
  });
  for (const name of Object.keys(vars)) {
    assert.equal(configuration.EDGE_ONLY_VAR_NAMES.includes(name), false, name);
    assert.equal(configuration.EDGE_ONLY_VAR_PREFIXES.some((prefix) => name.startsWith(prefix)), false, name);
    assert.equal(configuration.DEPLOYMENT_PROVIDED_VAR_NAMES.includes(name), false, name);
  }
  const secrets = [...configuration.REQUIRED_SECRET_NAMES, ...configuration.OPTIONAL_SECRET_NAMES];
  for (const name of secrets) {
    assert.equal(Object.hasOwn(configuration.PRODUCTION_FORBIDDEN_VARIABLES, name), false, name);
    assert.equal(Object.hasOwn(vars, name), false, name);
  }
  for (const name of configuration.EDGE_ONLY_SECRET_NAMES) {
    assert.ok(Object.hasOwn(configuration.PRODUCTION_FORBIDDEN_VARIABLES, name), name);
  }
});

test("the module never reads, spreads or copies process.env, and reuses EP-0's validators", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  assert.equal(/\bprocess\s*\.\s*env\b/u.test(code), false);
  assert.equal(/\.\.\.\s*processEnv\b/u.test(code), false);
  assert.equal(/Object\.(?:assign|entries|values|fromEntries)\(\s*processEnv\b/u.test(code), false);
  assert.equal(/structuredClone\(\s*processEnv\b/u.test(code), false);
  const imports = [...code.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gmu)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), [
    "../src/edge-origin-contract.ts",
    "./cloud-run-iam-test-target.mjs",
    "./postgres-maintenance-gate.mjs",
  ]);
  for (const validator of ["canonicalRunAppOrigin", "isEdgeOriginAudience", "isEdgeServiceAccountEmail"]) {
    assert.ok(new RegExp(`\\b${validator}\\(`, "u").test(code), validator);
  }
});

// ---------------------------------------------------------------------------
// readProductionConfiguration

test("a valid production environment yields a frozen configuration with opaque secrets", () => {
  const config = expectAccepted(productionEnv(), "production");
  assertDeepFrozen(config, "configuration");
  assert.equal(config.profile, "production");
  assert.equal(config.plane, "production");
  assert.equal(config.environment, "production");
  assert.equal(config.stagingAdmissionMode, null);
  assert.deepEqual(config.origins, {
    public: "https://tibotattle.com",
    admin: "https://admin.tibotattle.com",
    wwwHost: "www.tibotattle.com",
    host: "https://tibotattle-origin-abc123def4-ue.a.run.app",
  });
  assert.deepEqual(config.edge, {
    mode: "cloudflare-worker-iam",
    audience: "tibotattle-origin-audience",
    invokerServiceAccount: EDGE_INVOKER,
    verifierServiceAccounts: [],
  });
  assert.deepEqual(config.deployment, {
    sourceCommit: COMMIT,
    workload: { kind: "service", name: "tibotattle-origin" },
  });
  // One instance and no deletion ledger: no ledger resource (SIMP-0 item 7).
  // The quarantine bucket carries its birth proof (OD-2).
  assert.deepEqual(config.resources, {
    primary: {
      instanceConnectionName: "synthetic-project:us-east1:origin-primary",
      database: "origin_primary",
      schema: "origin_primary",
    },
    iamUser: "origin-runtime@synthetic-project.iam",
    bucket: "synthetic-origin-quarantine",
    bucketHistoryProof: JSON.parse(proof("synthetic-origin-quarantine")),
  });
  assert.deepEqual(Reflect.ownKeys(config.resources), ["primary", "iamUser", "bucket", "bucketHistoryProof"]);
  assert.equal(Object.isFrozen(config.resources.bucketHistoryProof), true);
  assert.equal(config.poolSizes, configuration.PRODUCTION_POOL_SIZES);
  assert.equal(config.admissionTimeouts, configuration.PRODUCTION_ADMISSION_TIMEOUTS);
  assert.equal(config.rateLimits.edgeTier, configuration.EDGE_TIER_RATE_LIMIT_NAMES);
  assert.equal(config.rateLimits.originTier, configuration.ORIGIN_TIER_RATE_LIMITS);
  assert.deepEqual(config.jobSwitches, {});
  assert.deepEqual(config.vars, {
    ...configuration.PRODUCTION_VARS,
    TELEMETRY_STORAGE_NAMESPACE: "synthetic-namespace",
    DEPLOYMENT_SOURCE_COMMIT: COMMIT,
  });
  assert.deepEqual(Object.keys(config.secrets).sort(), [
    ...configuration.REQUIRED_SECRET_NAMES, ...configuration.OPTIONAL_SECRET_NAMES,
  ].sort());
  for (const [name, handle] of Object.entries(config.secrets)) {
    assert.deepEqual(Reflect.ownKeys(handle), ["name"]);
    assert.equal(handle.name, name);
  }
  assert.equal(revealProductionSecret(config.secrets.POSTGRES_RATE_LIMIT_SECRET),
    SECRET_VALUES.POSTGRES_RATE_LIMIT_SECRET);
  assertNoLeak(config);
  expectCode(() => revealProductionSecret({ name: "POSTGRES_RATE_LIMIT_SECRET" }),
    "PRODUCTION_SECRET_HANDLE_INVALID");
  expectCode(() => revealProductionSecret(undefined), "PRODUCTION_SECRET_HANDLE_INVALID");
});

test("an optional secret may be absent", () => {
  const config = expectAccepted(without(productionEnv(), "DISTRIBUTION_GITHUB_API_TOKEN"), "production");
  assert.equal(config.secrets.DISTRIBUTION_GITHUB_API_TOKEN, undefined);
  assert.equal(config.workerEnvKeys.includes("DISTRIBUTION_GITHUB_API_TOKEN"), false);
  expectAccepted(productionEnv({ DISTRIBUTION_GITHUB_API_TOKEN: "" }), "production");
});

test("each forbidden variable aborts with its own code in every profile, even when empty", () => {
  const cases = [
    ...FORBIDDEN_VARIABLE_NAMES.map((name) => [name, `${name}_FORBIDDEN`]),
    ["HOST_RATE_LIMIT_ENROLLMENT_RATE_LIMIT_LIMIT", "HOST_RATE_LIMIT_OVERRIDE_FORBIDDEN"],
    ["HOST_RATE_LIMIT_CLIENT_ATTEMPT_RATE_LIMIT_PERIOD_SECONDS", "HOST_RATE_LIMIT_OVERRIDE_FORBIDDEN"],
    // Any other ledger-named setting, by prefix.
    ["LEDGER_POOL_SIZE", "LEDGER_CONFIGURATION_FORBIDDEN"],
  ];
  assert.equal(new Set(cases.map(([, code]) => code)).size, cases.length - 1);
  for (const [name, code] of cases) {
    for (const value of ["synthetic-forbidden-value", ""]) {
      expectCode(() => readProductionConfiguration(productionEnv({ [name]: value }), "production"), code);
      expectCode(() => readProductionConfiguration(stagingEnv({ [name]: value }), "staging"), code);
      for (const profile of JOB_PROFILES) {
        expectCode(() => readProductionConfiguration(jobEnv(profile, { [name]: value }), profile), code);
      }
    }
  }
});

test("missing secrets abort naming only the secret", () => {
  for (const name of configuration.REQUIRED_SECRET_NAMES) {
    expectCode(() => readProductionConfiguration(without(productionEnv(), name), "production"),
      `${name}_MISSING`);
    expectCode(() => readProductionConfiguration(productionEnv({ [name]: "" }), "production"),
      `${name}_MISSING`);
    expectCode(() => readProductionConfiguration(without(stagingEnv(), name), "staging"),
      `${name}_MISSING`);
  }
  for (const profile of ["maintenance-job", "staging-maintenance-job"]) {
    expectCode(() => readProductionConfiguration(without(jobEnv(profile), "IDENTITY_LINK_SECRET"), profile),
      "IDENTITY_LINK_SECRET_MISSING");
    expectCode(() => readProductionConfiguration(jobEnv(profile, { IDENTITY_LINK_SECRET: "" }), profile),
      "IDENTITY_LINK_SECRET_MISSING");
    expectCode(() => readProductionConfiguration(jobEnv(profile, {
      IDENTITY_LINK_SECRET: "x".repeat(31),
    }), profile), "IDENTITY_LINK_SECRET_INVALID");
  }
});

test("each job requires only the secrets it consumes and refuses the rest", () => {
  const all = serviceSecrets();
  for (const profile of JOB_PROFILES) {
    const config = expectAccepted(jobEnv(profile), profile);
    assert.deepEqual(Object.keys(config.secrets).sort(), [...JOB_SECRET_NAMES[profile]].sort(), profile);
    const env = createProductionWorkerEnv(config);
    for (const name of [...configuration.REQUIRED_SECRET_NAMES, ...configuration.OPTIONAL_SECRET_NAMES]) {
      const consumed = JOB_SECRET_NAMES[profile].includes(name);
      assert.equal(Object.hasOwn(env, name), consumed, `${profile} ${name}`);
      if (consumed) continue;
      // A secret the job never reads is refused, even when rendered empty.
      for (const value of [all[name], ""]) {
        expectCode(() => readProductionConfiguration(jobEnv(profile, { [name]: value }), profile),
          `${name}_PROFILE_FORBIDDEN`);
      }
    }
    assertNoLeak(env, [SECRET_VALUES.POSTGRES_RATE_LIMIT_SECRET, SECRET_VALUES.APPLE_PRIVATE_KEY,
      SECRET_VALUES.GOOGLE_OIDC_CLIENT_SECRET, PRIVATE_EXPONENT]);
  }
  // The production maintenance job reads the optional GitHub token; the staging one never does.
  const withoutToken = expectAccepted(without(jobEnv("maintenance-job"), "DISTRIBUTION_GITHUB_API_TOKEN"),
    "maintenance-job");
  assert.deepEqual(Object.keys(withoutToken.secrets), ["IDENTITY_LINK_SECRET"]);
  for (const name of SERVICE_ONLY_SECRET_NAMES) {
    assert.equal(configuration.PRODUCTION_PROFILE_SECRET_NAMES["maintenance-job"].required.includes(name), false);
  }
});

test("malformed secrets abort with named codes and never echo a value", () => {
  const marker = "synthetic-leak-marker-value-6";
  const markers = [...LEAK_MARKERS, marker];
  const cases = [
    [{ IDENTITY_LINK_SECRET: `${marker}`.padEnd(31, "x") }, "IDENTITY_LINK_SECRET_INVALID"],
    // 11 three-byte characters: 33 bytes but only 11 characters.
    [{ IDENTITY_LINK_SECRET: "€".repeat(11) }, "IDENTITY_LINK_SECRET_INVALID"],
    [{ POSTGRES_RATE_LIMIT_SECRET: `${marker}`.padEnd(31, "x") }, "POSTGRES_RATE_LIMIT_SECRET_INVALID"],
    [{ POSTGRES_RATE_LIMIT_SECRET: "x".repeat(65_537) }, "POSTGRES_RATE_LIMIT_SECRET_INVALID"],
    [{ ENVELOPE_PUBLIC_JWK: `{"kty":"RSA","kid":"${marker}` }, "ENVELOPE_PUBLIC_JWK_INVALID"],
    [{ ENVELOPE_PUBLIC_JWK: `not json ${marker}` }, "ENVELOPE_PUBLIC_JWK_INVALID"],
    [{ ENVELOPE_PUBLIC_JWK: JSON.stringify({ kty: "RSA", kid: `key:${marker}`, n: "n", e: "e", d: marker }) },
      "ENVELOPE_PUBLIC_JWK_INVALID"],
    [{ ENVELOPE_PUBLIC_JWK: JSON.stringify({ kty: "EC", kid: "key:synthetic", n: "n", e: "e" }) },
      "ENVELOPE_PUBLIC_JWK_INVALID"],
    [{ ENVELOPE_PRIVATE_JWK: `[${JSON.stringify(marker)}]` }, "ENVELOPE_PRIVATE_JWK_INVALID"],
    [{ ENVELOPE_PRIVATE_JWK: JSON.stringify({ kty: "RSA", kid: "key:synthetic-production-check", n: "n", e: "e" }) },
      "ENVELOPE_PRIVATE_JWK_INVALID"],
    [{ ENVELOPE_PRIVATE_JWK: JSON.stringify({ kty: "RSA", kid: "key:other", n: "n", e: "e", d: marker }) },
      "ENVELOPE_KEY_ID_MISMATCH"],
    [{ APPLE_PRIVATE_KEY: marker }, "APPLE_PRIVATE_KEY_INVALID"],
    [{ DISTRIBUTION_GITHUB_API_TOKEN: "x".repeat(65_537) }, "DISTRIBUTION_GITHUB_API_TOKEN_INVALID"],
  ];
  for (const [overrides, code] of cases) {
    expectCode(() => readProductionConfiguration(productionEnv(overrides), "production"), code, markers);
  }
});

test("test-target resources abort", () => {
  const target = CLOUD_RUN_IAM_TEST_TARGET;
  const cases = [
    [{ K_SERVICE: target.service }, "K_SERVICE_TEST_TARGET_FORBIDDEN"],
    [{ HOST_ORIGIN: target.origin }, "HOST_ORIGIN_TEST_TARGET_FORBIDDEN"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: target.postgres.primary.instanceConnectionName },
      "PRIMARY_INSTANCE_CONNECTION_NAME_TEST_TARGET_FORBIDDEN"],
    [{ PRIMARY_SCHEMA: target.postgres.primary.schema }, "PRIMARY_SCHEMA_TEST_TARGET_FORBIDDEN"],
    // The test estate's second (ledger) instance and schema stay identities:
    // production names one instance, and it may never be either of them.
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: target.postgres.ledger.instanceConnectionName },
      "PRIMARY_INSTANCE_CONNECTION_NAME_TEST_TARGET_FORBIDDEN"],
    [{ PRIMARY_SCHEMA: target.postgres.ledger.schema }, "PRIMARY_SCHEMA_TEST_TARGET_FORBIDDEN"],
    // A test database is refused through its instance.
    [{
      PRIMARY_INSTANCE_CONNECTION_NAME: target.postgres.primary.instanceConnectionName,
      PRIMARY_DATABASE: target.postgres.primary.database,
    }, "PRIMARY_INSTANCE_CONNECTION_NAME_TEST_TARGET_FORBIDDEN"],
    [{ POSTGRES_IAM_USER: target.postgres.iamUser }, "POSTGRES_IAM_USER_TEST_TARGET_FORBIDDEN"],
    [{ POSTGRES_IAM_USER: `${target.postgres.iamUser}.gserviceaccount.com` },
      "POSTGRES_IAM_USER_TEST_TARGET_FORBIDDEN"],
    [{ GCS_BUCKET_NAME: target.gcsBucket }, "GCS_BUCKET_NAME_TEST_TARGET_FORBIDDEN"],
    [{ EDGE_INVOKER_SERVICE_ACCOUNT: `${target.postgres.iamUser}.gserviceaccount.com` },
      "EDGE_INVOKER_SERVICE_ACCOUNT_TEST_TARGET_FORBIDDEN"],
    [{ EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: `${VERIFIERS[0]},${target.postgres.iamUser}.gserviceaccount.com` },
      "EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS_TEST_TARGET_FORBIDDEN"],
    [{ EDGE_ORIGIN_AUDIENCE: target.origin }, "EDGE_ORIGIN_AUDIENCE_TEST_TARGET_FORBIDDEN"],
    [{ TELEMETRY_STORAGE_NAMESPACE: target.postgres.primary.schema },
      "TELEMETRY_STORAGE_NAMESPACE_TEST_TARGET_FORBIDDEN"],
  ];
  for (const [overrides, code] of cases) {
    expectCode(() => readProductionConfiguration(productionEnv(overrides), "production"), code);
  }
  for (const profile of JOB_PROFILES) {
    expectCode(() => readProductionConfiguration(jobEnv(profile, {
      PRIMARY_INSTANCE_CONNECTION_NAME: target.postgres.primary.instanceConnectionName,
    }), profile), "PRIMARY_INSTANCE_CONNECTION_NAME_TEST_TARGET_FORBIDDEN");
    expectCode(() => readProductionConfiguration(jobEnv(profile, { CLOUD_RUN_JOB: target.service }), profile),
      "CLOUD_RUN_JOB_TEST_TARGET_FORBIDDEN");
  }
  expectCode(() => readProductionConfiguration(stagingEnv({ GCS_BUCKET_NAME: target.gcsBucket }), "staging"),
    "GCS_BUCKET_NAME_TEST_TARGET_FORBIDDEN");
  // Resource identities, not name coincidences: the repository's conventional
  // database and schema names ('tibotattle', 'tibotattle_ledger', which the
  // test deployment's databases also use) are accepted on other instances.
  const conventional = expectAccepted(productionEnv({
    PRIMARY_DATABASE: target.postgres.primary.database,
    PRIMARY_SCHEMA: target.postgres.primary.database,
    TELEMETRY_STORAGE_NAMESPACE: target.project,
  }), "production");
  assert.equal(expectAccepted(productionEnv({ PRIMARY_DATABASE: target.postgres.ledger.database }), "production")
    .resources.primary.database, "tibotattle_ledger");
  assert.deepEqual(conventional.resources.primary, {
    instanceConnectionName: "synthetic-project:us-east1:origin-primary",
    database: "tibotattle",
    schema: "tibotattle",
  });
  // The whole test deployment, as the IAM test host is configured.
  expectCode(() => readProductionConfiguration(productionEnv({
    K_SERVICE: target.service,
    HOST_ORIGIN: target.origin,
    PRIMARY_INSTANCE_CONNECTION_NAME: target.postgres.primary.instanceConnectionName,
    PRIMARY_DATABASE: target.postgres.primary.database,
    PRIMARY_SCHEMA: target.postgres.primary.schema,
    POSTGRES_IAM_USER: target.postgres.iamUser,
    GCS_BUCKET_NAME: target.gcsBucket,
  }), "production"), "K_SERVICE_TEST_TARGET_FORBIDDEN");
});

test("deployment identity, origins and edge settings are validated", () => {
  const cases = [
    [without(productionEnv(), "DEPLOYMENT_SOURCE_COMMIT"), "DEPLOYMENT_SOURCE_COMMIT_MISSING"],
    [productionEnv({ DEPLOYMENT_SOURCE_COMMIT: COMMIT.slice(0, 12) }), "DEPLOYMENT_SOURCE_COMMIT_INVALID"],
    [productionEnv({ DEPLOYMENT_SOURCE_COMMIT: COMMIT.toUpperCase() }), "DEPLOYMENT_SOURCE_COMMIT_INVALID"],
    [without(productionEnv(), "K_SERVICE"), "K_SERVICE_MISSING"],
    [productionEnv({ K_SERVICE: "Origin" }), "K_SERVICE_INVALID"],
    [without(productionEnv(), "HOST_ORIGIN"), "HOST_ORIGIN_MISSING"],
    [productionEnv({ HOST_ORIGIN: "http://tibotattle-origin-abc123def4-ue.a.run.app" }), "HOST_ORIGIN_INVALID"],
    [productionEnv({ HOST_ORIGIN: "https://tibotattle-origin-abc123def4-ue.a.run.app/" }), "HOST_ORIGIN_INVALID"],
    [productionEnv({ HOST_ORIGIN: "https://origin.synthetic.example" }), "HOST_ORIGIN_INVALID"],
    [without(productionEnv(), "PUBLIC_ORIGIN"), "PUBLIC_ORIGIN_MISSING"],
    [productionEnv({ PUBLIC_ORIGIN: "https://www.tibotattle.com" }), "PUBLIC_ORIGIN_INVALID"],
    [productionEnv({ ADMIN_HOST_ORIGIN: "https://admin.synthetic.example" }), "ADMIN_HOST_ORIGIN_INVALID"],
    [without(productionEnv(), "EDGE_ORIGIN_MODE"), "EDGE_ORIGIN_MODE_MISSING"],
    [productionEnv({ EDGE_ORIGIN_MODE: "cloudflare-shared-secret" }), "EDGE_ORIGIN_MODE_INVALID"],
    [without(productionEnv(), "EDGE_ORIGIN_AUDIENCE"), "EDGE_ORIGIN_AUDIENCE_MISSING"],
    [productionEnv({ EDGE_ORIGIN_AUDIENCE: " padded" }), "EDGE_ORIGIN_AUDIENCE_INVALID"],
    [without(productionEnv(), "EDGE_INVOKER_SERVICE_ACCOUNT"), "EDGE_INVOKER_SERVICE_ACCOUNT_MISSING"],
    [productionEnv({ EDGE_INVOKER_SERVICE_ACCOUNT: "owner@synthetic.example" }),
      "EDGE_INVOKER_SERVICE_ACCOUNT_INVALID"],
    [productionEnv({ EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: VERIFIERS.join(",") }),
      "EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS_INVALID"],
    [productionEnv({ EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: `${VERIFIERS[0]},${VERIFIERS[0]}` }),
      "EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS_INVALID"],
    [productionEnv({ EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: EDGE_INVOKER }),
      "EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS_INVALID"],
    [productionEnv({ EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: `${VERIFIERS[0]}, ${VERIFIERS[1]}` }),
      "EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS_INVALID"],
    [productionEnv({ EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: `${VERIFIERS[0]},` }),
      "EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS_INVALID"],
    [without(productionEnv(), "TELEMETRY_STORAGE_NAMESPACE"), "TELEMETRY_STORAGE_NAMESPACE_MISSING"],
    [productionEnv({ TELEMETRY_STORAGE_NAMESPACE: "space in namespace" }), "TELEMETRY_STORAGE_NAMESPACE_INVALID"],
  ];
  for (const [env, code] of cases) {
    expectCode(() => readProductionConfiguration(env, "production"), code);
  }
  for (let count = 1; count <= 4; count += 1) {
    const config = expectAccepted(productionEnv({
      EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: VERIFIERS.slice(0, count).join(","),
    }), "production");
    assert.deepEqual(config.edge.verifierServiceAccounts, VERIFIERS.slice(0, count));
  }
  assert.deepEqual(expectAccepted(without(productionEnv(), "EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS"),
    "production").edge.verifierServiceAccounts, []);
  expectAccepted(productionEnv({ ADMIN_HOST_ORIGIN: "https://admin.tibotattle.com" }), "production");
  expectCode(() => readProductionConfiguration(productionEnv(), "Production"), "PRODUCTION_PROFILE_INVALID");
  expectCode(() => readProductionConfiguration(productionEnv(), undefined), "PRODUCTION_PROFILE_INVALID");
  expectCode(() => readProductionConfiguration(null, "production"), "PRODUCTION_ENVIRONMENT_INVALID");
});

test("Cloud SQL and bucket resources are validated", () => {
  const cases = [
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "origin-primary" }, "PRIMARY_INSTANCE_CONNECTION_NAME_INVALID"],
    // project:region:instance, each part in its own grammar.
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "Synthetic-project:us-east1:origin-primary" },
      "PRIMARY_INSTANCE_CONNECTION_NAME_INVALID"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "short:us-east1:origin-primary" },
      "PRIMARY_INSTANCE_CONNECTION_NAME_INVALID"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:useast1:origin-primary" },
      "PRIMARY_INSTANCE_CONNECTION_NAME_INVALID"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east:origin-primary" },
      "PRIMARY_INSTANCE_CONNECTION_NAME_INVALID"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:Origin-primary" },
      "PRIMARY_INSTANCE_CONNECTION_NAME_INVALID"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-primary-" },
      "PRIMARY_INSTANCE_CONNECTION_NAME_INVALID"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-primary:extra" },
      "PRIMARY_INSTANCE_CONNECTION_NAME_INVALID"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-primary/1" },
      "PRIMARY_INSTANCE_CONNECTION_NAME_INVALID"],
    [{ PRIMARY_DATABASE: "origin-primary" }, "PRIMARY_DATABASE_INVALID"],
    [{ PRIMARY_SCHEMA: "pg_origin" }, "PRIMARY_SCHEMA_INVALID"],
    [{ PRIMARY_SCHEMA: "information_schema" }, "PRIMARY_SCHEMA_INVALID"],
    [{ PRIMARY_SCHEMA: "Origin_Primary" }, "PRIMARY_SCHEMA_INVALID"],
    [without(productionEnv(), "PRIMARY_SCHEMA"), "PRIMARY_SCHEMA_MISSING"],
    [{ POSTGRES_IAM_USER: "" }, "POSTGRES_IAM_USER_MISSING"],
    [{ POSTGRES_IAM_USER: "origin runtime" }, "POSTGRES_IAM_USER_INVALID"],
    [{ GCS_BUCKET_NAME: "Synthetic" }, "GCS_BUCKET_NAME_INVALID"],
    [{ GCS_BUCKET_NAME: "synthetic.origin.quarantine" }, "GCS_BUCKET_NAME_INVALID"],
  ];
  for (const [overrides, code] of cases) {
    const env = "HOST_MODE" in overrides ? overrides : productionEnv(overrides);
    expectCode(() => readProductionConfiguration(env, "production"), code);
  }
  const serviceAccountUser = expectAccepted(productionEnv({
    POSTGRES_IAM_USER: "origin-runtime@synthetic-project.iam.gserviceaccount.com",
  }), "production");
  assert.equal(serviceAccountUser.resources.iamUser, "origin-runtime@synthetic-project.iam");
});

test("staging requires its own plane and aborts on any production value", () => {
  const staging = expectAccepted(stagingEnv(), "staging");
  assert.equal(staging.environment, "staging");
  assert.equal(staging.plane, "staging");
  assert.deepEqual(staging.origins, {
    public: "https://staging.synthetic.example",
    admin: "https://admin.staging.synthetic.example",
    wwwHost: null,
    host: "https://tibotattle-staging-origin-abc123def4-ue.a.run.app",
  });
  assert.equal(staging.vars.ENVIRONMENT, "staging");
  assert.equal(staging.vars.PUBLIC_ORIGIN, "https://staging.synthetic.example");
  assert.equal(staging.vars.ACCESS_AUD, "a".repeat(64));
  assert.equal(staging.vars.IDENTITY_LINK_SECRET_VERSION, "staging-v1");
  assert.equal(staging.vars.TELEMETRY_STORAGE_MODE, "typed");

  const production = configuration.PRODUCTION_VARS;
  const email254 = `${"a".repeat(64)}@${"b".repeat(185)}.com`;
  assert.equal(email254.length, 254);
  const cases = [
    [{ PUBLIC_ORIGIN: "https://tibotattle.com", ADMIN_HOST_ORIGIN: "https://admin.tibotattle.com" },
      "PUBLIC_ORIGIN_PRODUCTION_VALUE_FORBIDDEN"],
    [{ PUBLIC_ORIGIN: "https://www.tibotattle.com", ADMIN_HOST_ORIGIN: "https://admin.www.tibotattle.com" },
      "PUBLIC_ORIGIN_PRODUCTION_VALUE_FORBIDDEN"],
    [{ ACCESS_AUD: production.ACCESS_AUD }, "ACCESS_AUD_PRODUCTION_VALUE_FORBIDDEN"],
    [{ IDENTITY_LINK_SECRET_VERSION: "production-v1" }, "IDENTITY_LINK_SECRET_VERSION_PRODUCTION_VALUE_FORBIDDEN"],
    [{ GOOGLE_OIDC_CLIENT_ID: production.GOOGLE_OIDC_CLIENT_ID }, "GOOGLE_OIDC_CLIENT_ID_PRODUCTION_VALUE_FORBIDDEN"],
    // Apple's OAuth client (the id_token audience) is separated like Google's.
    [{ APPLE_SERVICES_ID: production.APPLE_SERVICES_ID }, "APPLE_SERVICES_ID_PRODUCTION_VALUE_FORBIDDEN"],
    [{ APPLE_KEY_ID: production.APPLE_KEY_ID }, "APPLE_KEY_ID_PRODUCTION_VALUE_FORBIDDEN"],
    [{ GCS_BUCKET_NAME: "app-usagemonitor-production-quarantine" },
      "GCS_BUCKET_NAME_PRODUCTION_VALUE_FORBIDDEN"],
    [{ K_SERVICE: "tibotattle-production-staging" }, "K_SERVICE_PRODUCTION_VALUE_FORBIDDEN"],
    [{ K_SERVICE: "tibotattle-origin" }, "K_SERVICE_STAGING_MARKER_MISSING"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-primary" },
      "PRIMARY_INSTANCE_CONNECTION_NAME_STAGING_MARKER_MISSING"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-production-staging-primary" },
      "PRIMARY_INSTANCE_CONNECTION_NAME_PRODUCTION_VALUE_FORBIDDEN"],
    [{ GCS_BUCKET_NAME: "synthetic-quarantine" }, "GCS_BUCKET_NAME_STAGING_MARKER_MISSING"],
    [envelopeKeys("key:synthetic-production-check"), "ENVELOPE_KEY_ID_PRODUCTION_VALUE_FORBIDDEN"],
    [envelopeKeys("key:synthetic-check"), "ENVELOPE_KEY_ID_STAGING_MARKER_MISSING"],
    // A marker must be a delimited token, not a substring.
    [envelopeKeys("key:nonstaging"), "ENVELOPE_KEY_ID_STAGING_MARKER_MISSING"],
    [{ PUBLIC_ORIGIN: "https://tibotattle-staging-origin-abc123def4-ue.a.run.app" }, "PUBLIC_ORIGIN_INVALID"],
    [{ PUBLIC_ORIGIN: "https://staging.synthetic.example/" }, "PUBLIC_ORIGIN_INVALID"],
    // The public origin is never itself an admin host.
    [{ PUBLIC_ORIGIN: "https://admin.synthetic.example", ADMIN_HOST_ORIGIN: "https://admin.admin.synthetic.example" },
      "PUBLIC_ORIGIN_INVALID"],
    // The admin origin is exactly admin.<public hostname>, as the Worker and the edge derive it.
    [{ ADMIN_HOST_ORIGIN: "https://staging.synthetic.example" }, "ADMIN_HOST_ORIGIN_INVALID"],
    [{ ADMIN_HOST_ORIGIN: "https://ops.other.example" }, "ADMIN_HOST_ORIGIN_INVALID"],
    [{ ADMIN_HOST_ORIGIN: "https://admin.tibotattle.com" }, "ADMIN_HOST_ORIGIN_INVALID"],
    [{ ADMIN_HOST_ORIGIN: "https://admin.staging.synthetic.example:8443" }, "ADMIN_HOST_ORIGIN_INVALID"],
    [without(stagingEnv(), "ADMIN_HOST_ORIGIN"), "ADMIN_HOST_ORIGIN_MISSING"],
    [{ ACCESS_AUD: "A".repeat(64) }, "ACCESS_AUD_INVALID"],
    [{ ACCESS_TEAM_DOMAIN: "access.synthetic.example" }, "ACCESS_TEAM_DOMAIN_INVALID"],
    [{ ACCESS_TEAM_DOMAIN: "-synthetic.cloudflareaccess.com" }, "ACCESS_TEAM_DOMAIN_INVALID"],
    [{ ACCESS_ADMIN_EMAIL: "owner.synthetic.example" }, "ACCESS_ADMIN_EMAIL_INVALID"],
    [{ ACCESS_ADMIN_EMAIL: "owner@Synthetic.example" }, "ACCESS_ADMIN_EMAIL_INVALID"],
    [{ ACCESS_ADMIN_EMAIL: `${"a".repeat(65)}@synthetic.example` }, "ACCESS_ADMIN_EMAIL_INVALID"],
    [{ ACCESS_ADMIN_EMAIL: `${"a".repeat(64)}@${"b".repeat(186)}.com` }, "ACCESS_ADMIN_EMAIL_INVALID"],
    [{ IDENTITY_LINK_SECRET_VERSION: "-staging" }, "IDENTITY_LINK_SECRET_VERSION_INVALID"],
    [{ GOOGLE_OIDC_CLIENT_ID: "not-a-client-id" }, "GOOGLE_OIDC_CLIENT_ID_INVALID"],
    [{ GOOGLE_OIDC_CLIENT_ID: "123456789012-synthetic.apps.example.com" }, "GOOGLE_OIDC_CLIENT_ID_INVALID"],
    [{ APPLE_SERVICES_ID: ".synthetic.staging" }, "APPLE_SERVICES_ID_INVALID"],
    [{ APPLE_SERVICES_ID: "synthetic staging" }, "APPLE_SERVICES_ID_INVALID"],
    [{ APPLE_TEAM_ID: "synthteam1" }, "APPLE_TEAM_ID_INVALID"],
    [{ APPLE_TEAM_ID: "SYNTHTEAM" }, "APPLE_TEAM_ID_INVALID"],
    [{ APPLE_KEY_ID: "SYNTHKEY001" }, "APPLE_KEY_ID_INVALID"],
    [without(stagingEnv(), "APPLE_KEY_ID"), "APPLE_KEY_ID_MISSING"],
  ];
  for (const [overrides, code] of cases) {
    const env = "HOST_MODE" in overrides ? overrides : stagingEnv(overrides);
    expectCode(() => readProductionConfiguration(env, "staging"), code);
  }
  // Staging may share the owner's Access team, admin email and Apple team;
  // those identify no production secret, data plane or OAuth client.
  expectAccepted(stagingEnv({
    ACCESS_TEAM_DOMAIN: production.ACCESS_TEAM_DOMAIN,
    ACCESS_ADMIN_EMAIL: production.ACCESS_ADMIN_EMAIL,
    APPLE_TEAM_ID: production.APPLE_TEAM_ID,
  }), "staging");
  assert.equal(expectAccepted(stagingEnv({ ACCESS_ADMIN_EMAIL: email254 }), "staging")
    .vars.ACCESS_ADMIN_EMAIL, email254);
});

test("staging is synthetic-only by default: a closed posture no setting can open", () => {
  const production = expectAccepted(productionEnv(), "production");
  assert.equal(production.vars.ENROLLMENT_MODE, "open");
  assert.equal(production.vars.INCREMENTAL_EXTERNAL_PARTICIPANTS, "authorized");
  assert.equal(production.rateLimits.originTier, configuration.ORIGIN_TIER_RATE_LIMITS);

  // The process environment asks for production's open posture; it is ignored.
  const open = {
    ENROLLMENT_MODE: "open",
    ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
    ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
    INCREMENTAL_EXTERNAL_PARTICIPANTS: "authorized",
    SIGN_IN_START_MAX_PER_MINUTE: "300",
    UPLOAD_INGRESS_MAX_CONCURRENT: "64",
  };
  for (const env of [stagingEnv(), stagingEnv(open), stagingEnv({ ...open, STAGING_ADMISSION_MODE: "closed" })]) {
    const config = expectAccepted(env, "staging");
    assert.equal(config.stagingAdmissionMode, "closed");
    assert.equal(config.rateLimits.originTier, configuration.STAGING_ORIGIN_TIER_RATE_LIMITS);
    const workerEnv = createProductionWorkerEnv(config, {
      bindings: serviceBindings(configuration.STAGING_ORIGIN_TIER_RATE_LIMITS),
    });
    for (const [name, value] of Object.entries(configuration.STAGING_CONTAINMENT_VARS)) {
      assert.equal(workerEnv[name], value, name);
    }
    assert.equal(workerEnv.ENROLLMENT_MODE, "disabled");
    assert.equal(workerEnv.ACCOUNTLESS_ENROLLMENT_MODE, "disabled");
    assert.equal(workerEnv.ACCOUNTLESS_OWNERSHIP_MODE, "disabled");
    assert.equal(workerEnv.SIGN_IN_START_MAX_PER_MINUTE, "5");
    assert.equal(workerEnv.UPLOAD_INGRESS_MAX_CONCURRENT, "8");
    assert.equal(Object.hasOwn(workerEnv, "INCREMENTAL_EXTERNAL_PARTICIPANTS"), false);
    assert.equal(Reflect.get(workerEnv, "INCREMENTAL_EXTERNAL_PARTICIPANTS"), undefined);
    assert.equal(Reflect.get(workerEnv, "STAGING_ADMISSION_MODE"), undefined);
    assert.equal(workerEnv.ENVIRONMENT, "staging");
    // Everything else is production's pinned configuration.
    assert.equal(workerEnv.TELEMETRY_STORAGE_MODE, "typed");
    assert.equal(workerEnv.PERFORMANCE_TELEMETRY_STORAGE_MODE, "enabled");
    assert.equal(workerEnv.EDGE_ORIGIN_MODE, "cloudflare-worker-iam");
    assert.equal(workerEnv.ALLOWANCE_RECONSTRUCTION_MODE, "resumable");
  }

  // The owner-reviewed rehearsal override opens accountless admission only.
  const rehearsal = expectAccepted(stagingEnv({ ...open, STAGING_ADMISSION_MODE: "synthetic-rehearsal" }),
    "staging");
  assert.equal(rehearsal.stagingAdmissionMode, "synthetic-rehearsal");
  assert.equal(rehearsal.vars.ACCOUNTLESS_ENROLLMENT_MODE, "enabled");
  assert.equal(rehearsal.vars.ACCOUNTLESS_OWNERSHIP_MODE, "enabled");
  assert.equal(rehearsal.vars.ENROLLMENT_MODE, "disabled");
  assert.equal(rehearsal.vars.SIGN_IN_START_MAX_PER_MINUTE, "5");
  assert.equal(Object.hasOwn(rehearsal.vars, "INCREMENTAL_EXTERNAL_PARTICIPANTS"), false);
  assert.equal(rehearsal.rateLimits.originTier, configuration.STAGING_ORIGIN_TIER_RATE_LIMITS);

  for (const value of ["", "open", "Closed", "synthetic_rehearsal", "real-clients", "__proto__", "constructor"]) {
    expectCode(() => readProductionConfiguration(stagingEnv({ STAGING_ADMISSION_MODE: value }), "staging"),
      "STAGING_ADMISSION_MODE_INVALID");
  }
  // Only the staging service reads the switch; everywhere else it is refused.
  for (const value of ["closed", "synthetic-rehearsal", ""]) {
    expectCode(() => readProductionConfiguration(productionEnv({ STAGING_ADMISSION_MODE: value }),
      "production"), "STAGING_ADMISSION_MODE_FORBIDDEN");
    for (const profile of JOB_PROFILES) {
      expectCode(() => readProductionConfiguration(jobEnv(profile, { STAGING_ADMISSION_MODE: value }), profile),
        "STAGING_ADMISSION_MODE_FORBIDDEN");
    }
  }
});

test("staging jobs run on the staging plane with its identity, origins and markers", () => {
  for (const profile of ["staging-maintenance-job", "staging-analytics-job"]) {
    const config = expectAccepted(jobEnv(profile, {
      ENROLLMENT_MODE: "open",
      INCREMENTAL_EXTERNAL_PARTICIPANTS: "authorized",
    }), profile);
    assert.equal(config.plane, "staging", profile);
    assert.equal(config.environment, "staging", profile);
    assert.equal(config.stagingAdmissionMode, null, profile);
    assert.equal(config.edge, null, profile);
    assert.deepEqual(config.origins, {
      public: "https://staging.synthetic.example",
      admin: "https://admin.staging.synthetic.example",
      wwwHost: null,
      host: null,
    });
    assert.equal(config.rateLimits.originTier, configuration.STAGING_ORIGIN_TIER_RATE_LIMITS);
    const env = createProductionWorkerEnv(config);
    assert.equal(env.ENVIRONMENT, "staging");
    assert.equal(env.PUBLIC_ORIGIN, "https://staging.synthetic.example");
    assert.equal(env.IDENTITY_LINK_SECRET_VERSION, "staging-v1");
    assert.equal(env.ACCESS_AUD, "a".repeat(64));
    assert.equal(env.ENROLLMENT_MODE, "disabled");
    assert.equal(Reflect.get(env, "INCREMENTAL_EXTERNAL_PARTICIPANTS"), undefined);
    assert.equal(env.TELEMETRY_STORAGE_NAMESPACE, "synthetic-staging-namespace");
    for (const name of configuration.PRODUCTION_WORKER_BINDING_NAMES) {
      assert.equal(Reflect.get(env, name), undefined, name);
    }
    const cases = [
      [{ CLOUD_RUN_JOB: "tibotattle-maintenance" }, "CLOUD_RUN_JOB_STAGING_MARKER_MISSING"],
      [{ CLOUD_RUN_JOB: "tibotattle-production-staging-maintenance" }, "CLOUD_RUN_JOB_PRODUCTION_VALUE_FORBIDDEN"],
      [{ PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-primary" },
        "PRIMARY_INSTANCE_CONNECTION_NAME_STAGING_MARKER_MISSING"],
      [{ GCS_BUCKET_NAME: "synthetic-quarantine" }, "GCS_BUCKET_NAME_STAGING_MARKER_MISSING"],
      [{ ACCESS_AUD: configuration.PRODUCTION_VARS.ACCESS_AUD }, "ACCESS_AUD_PRODUCTION_VALUE_FORBIDDEN"],
      [{ IDENTITY_LINK_SECRET_VERSION: "production-v1" },
        "IDENTITY_LINK_SECRET_VERSION_PRODUCTION_VALUE_FORBIDDEN"],
      [{ APPLE_SERVICES_ID: configuration.PRODUCTION_VARS.APPLE_SERVICES_ID },
        "APPLE_SERVICES_ID_PRODUCTION_VALUE_FORBIDDEN"],
      [{ PUBLIC_ORIGIN: "https://tibotattle.com", ADMIN_HOST_ORIGIN: "https://admin.tibotattle.com" },
        "PUBLIC_ORIGIN_PRODUCTION_VALUE_FORBIDDEN"],
      [{ ADMIN_HOST_ORIGIN: "https://ops.other.example" }, "ADMIN_HOST_ORIGIN_INVALID"],
      [without(jobEnv(profile), "PUBLIC_ORIGIN"), "PUBLIC_ORIGIN_MISSING"],
      [without(jobEnv(profile), "APPLE_TEAM_ID"), "APPLE_TEAM_ID_MISSING"],
    ];
    for (const [overrides, code] of cases) {
      const env = "DEPLOYMENT_SOURCE_COMMIT" in overrides ? overrides : jobEnv(profile, overrides);
      expectCode(() => readProductionConfiguration(env, profile), code);
    }
  }
});

test("production and its jobs refuse staging-marked resources", () => {
  const cases = [
    [{ K_SERVICE: "tibotattle-staging-origin" }, "K_SERVICE_STAGING_VALUE_FORBIDDEN"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-staging-primary" },
      "PRIMARY_INSTANCE_CONNECTION_NAME_STAGING_VALUE_FORBIDDEN"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:staging" },
      "PRIMARY_INSTANCE_CONNECTION_NAME_STAGING_VALUE_FORBIDDEN"],
    [{ GCS_BUCKET_NAME: "synthetic-staging-quarantine" }, "GCS_BUCKET_NAME_STAGING_VALUE_FORBIDDEN"],
    [envelopeKeys("key:staging-synthetic-check"), "ENVELOPE_KEY_ID_STAGING_VALUE_FORBIDDEN"],
  ];
  for (const [overrides, code] of cases) {
    expectCode(() => readProductionConfiguration(productionEnv(overrides), "production"), code);
  }
  expectCode(() => readProductionConfiguration(
    jobEnv("maintenance-job", { CLOUD_RUN_JOB: "tibotattle-staging-maintenance" }), "maintenance-job"),
  "CLOUD_RUN_JOB_STAGING_VALUE_FORBIDDEN");
});

// ---------------------------------------------------------------------------
// createProductionWorkerEnv

test("the frozen env holds only named keys, pinned vars and the injected bindings", () => {
  const bindings = serviceBindings();
  // Everything below is present in the process environment and must not
  // reach the env: D1/R2/asset names, development seams, Worker-era vars,
  // overrides of pinned vars and job switches that belong to other profiles.
  const seams = Object.fromEntries(REQUIRED_ABSENT_ENV_KEYS
    .filter((name) => !Object.hasOwn(configuration.PRODUCTION_FORBIDDEN_VARIABLES, name)
      && !configuration.REQUIRED_SECRET_NAMES.includes(name))
    .map((name) => [name, "synthetic"]));
  assert.deepEqual(Object.keys(seams).sort(), [
    "ADMIN_IDENTITY_LINK_KEY", "ANALYTICS_DB", "ASSETS", "DELETION_LEDGER",
    "DISTRIBUTION_ANALYTICS_ZONE_ID", "POSTGRES_OBJECT_STORE", "POSTGRES_WORKER_BACKEND",
    "QUARANTINE", "SPARKLE_RELEASES", "STORAGE_ANALYTICS_DB", "STORAGE_INGESTION_DB",
    "USAGE_MONITOR_DB",
  ]);
  const noisy = productionEnv({
    ...seams,
    ADMIN_IDENTITY_LINK_KEY: "a".repeat(64),
    SPARKLE_APPCAST_GUARD_MODE: "enabled",
    TELEMETRY_STORAGE_MODE: "json",
    PERFORMANCE_TELEMETRY_STORAGE_MODE: "disabled",
    ENVIRONMENT: "synthetic-development",
    ENROLLMENT_MODE: "local_open",
    SIGN_IN_START_MAX_PER_MINUTE: "1",
    IDENTITY_LINK_SECRET_VERSION: "synthetic-v9",
    ACCESS_AUD: "b".repeat(64),
    POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled",
    POSTGRES_ANALYTICS_MODE: "enabled",
    SYNTHETIC_UNRELATED: "synthetic",
  });
  const config = expectAccepted(noisy, "production");
  const env = createProductionWorkerEnv(config, { bindings });
  assert.ok(Object.isFrozen(env));
  assert.equal(Object.getPrototypeOf(env), null);
  assert.deepEqual(Reflect.ownKeys(env).sort(), config.workerEnvKeys);
  assert.deepEqual(config.workerEnvKeys, [
    ...Object.keys(configuration.PRODUCTION_VARS),
    "TELEMETRY_STORAGE_NAMESPACE",
    "DEPLOYMENT_SOURCE_COMMIT",
    "IDENTITY_LINK_SECRET",
    "ENVELOPE_PUBLIC_JWK",
    "ENVELOPE_PRIVATE_JWK",
    "GOOGLE_OIDC_CLIENT_SECRET",
    "APPLE_PRIVATE_KEY",
    "DISTRIBUTION_GITHUB_API_TOKEN",
    ...configuration.PRODUCTION_WORKER_BINDING_NAMES,
  ].sort());
  assert.equal(env.DEPLOYMENT_SOURCE_COMMIT, COMMIT);
  assert.equal(env.PERFORMANCE_TELEMETRY_STORAGE_MODE, "enabled");
  assert.equal(env.PUBLIC_ORIGIN, "https://tibotattle.com");
  assert.equal(env.TELEMETRY_STORAGE_MODE, "typed");
  assert.equal(env.TELEMETRY_STORAGE_NAMESPACE, "synthetic-namespace");
  assert.equal(env.ENVIRONMENT, "production");
  assert.equal(env.ENROLLMENT_MODE, "open");
  assert.equal(env.SIGN_IN_START_MAX_PER_MINUTE, "300");
  assert.equal(env.IDENTITY_LINK_SECRET_VERSION, "production-v1");
  assert.equal(env.ACCESS_AUD, configuration.PRODUCTION_VARS.ACCESS_AUD);
  assert.equal(env.EDGE_ORIGIN_MODE, "cloudflare-worker-iam");
  assert.equal(env.IDENTITY_LINK_SECRET, SECRET_VALUES.IDENTITY_LINK_SECRET);
  assert.equal(env.GOOGLE_OIDC_CLIENT_SECRET, SECRET_VALUES.GOOGLE_OIDC_CLIENT_SECRET);
  for (const name of configuration.PRODUCTION_WORKER_BINDING_NAMES) {
    assert.equal(env[name], bindings[name], name);
  }
  const absent = [
    ...REQUIRED_ABSENT_ENV_KEYS,
    ...configuration.PRODUCTION_WORKER_ENV_ABSENT_KEYS,
    ...Object.keys(configuration.PRODUCTION_FORBIDDEN_VARIABLES),
    "HOST_RATE_LIMIT_ENROLLMENT_RATE_LIMIT_LIMIT",
    "HOST_RATE_LIMIT_UPLOAD_AUTHORIZATION_RATE_LIMIT_PERIOD_SECONDS",
    "POSTGRES_SCHEDULED_MAINTENANCE_ENABLED",
    "POSTGRES_ANALYTICS_MODE",
    "SPARKLE_APPCAST_GUARD_MODE",
    "HOST_ORIGIN",
    "K_SERVICE",
    "EDGE_ORIGIN_AUDIENCE",
    "EDGE_INVOKER_SERVICE_ACCOUNT",
    "SYNTHETIC_UNRELATED",
    "constructor",
    "__proto__",
    "toString",
  ];
  for (const name of absent) {
    assert.equal(Object.hasOwn(env, name), false, name);
    assert.equal(Reflect.get(env, name), undefined, name);
  }
  assert.throws(() => { "use strict"; env.TELEMETRY_STORAGE_MODE = "json"; }, TypeError);
  assert.throws(() => { "use strict"; env.ACCESS_TEST_JWKS_JSON = "{}"; }, TypeError);
});

test("processEnv TELEMETRY_STORAGE_MODE=json keeps the pinned 'typed' in every profile", () => {
  for (const [profile, env] of [
    ["production", productionEnv({ TELEMETRY_STORAGE_MODE: "json" })],
    ["staging", stagingEnv({ TELEMETRY_STORAGE_MODE: "json" })],
    ...JOB_PROFILES.map((job) => [job, jobEnv(job, { TELEMETRY_STORAGE_MODE: "json" })]),
  ]) {
    const config = expectAccepted(env, profile);
    const workerEnv = createProductionWorkerEnv(config, profile.endsWith("-job") ? {} : {
      bindings: serviceBindings(config.rateLimits.originTier),
    });
    assert.equal(workerEnv.TELEMETRY_STORAGE_MODE, "typed", profile);
    assert.equal(workerEnv.PERFORMANCE_TELEMETRY_STORAGE_MODE, "enabled", profile);
  }
});

test("service envs require exactly the nine injected bindings", () => {
  const config = expectAccepted(productionEnv(), "production");
  for (const name of configuration.PRODUCTION_WORKER_BINDING_NAMES) {
    expectCode(() => createProductionWorkerEnv(config, { bindings: without(serviceBindings(), name) }),
      `${name}_BINDING_MISSING`);
    expectCode(() => createProductionWorkerEnv(config, {
      bindings: { ...serviceBindings(), [name]: Object.freeze({}) },
    }), `${name}_BINDING_INVALID`);
  }
  for (const extra of ["USAGE_MONITOR_DB", "DELETION_LEDGER", "ASSETS", "ACCESS_TEST_JWKS_JSON",
    "QUARANTINE", "POSTGRES_WORKER_BACKEND"]) {
    expectCode(() => createProductionWorkerEnv(config, {
      bindings: { ...serviceBindings(), [extra]: limiter() },
    }), "PRODUCTION_BINDING_UNEXPECTED");
  }
  expectCode(() => createProductionWorkerEnv(config, {}), "PRODUCTION_BINDINGS_INVALID");
  expectCode(() => createProductionWorkerEnv(config), "PRODUCTION_BINDINGS_INVALID");
  // Origin-tier limiters are PostgreSQL limiters; class instances are accepted there.
  const postgresLimiter = (name, limit = 3_000, periodSeconds = 60) =>
    canonical.rateLimiter.createPostgresRateLimiter(
      { connect() { throw new Error("SYNTHETIC_POOL_UNUSED"); } },
      { name, limit, periodSeconds, keyHashSecret: SECRET_VALUES.POSTGRES_RATE_LIMIT_SECRET },
    );
  const postgresOriginLimiters = (originTier) => Object.fromEntries(Object.values(originTier)
    .map(({ binding, limit, periodSeconds }) => [binding, postgresLimiter(binding, limit, periodSeconds)]));
  const staging = expectAccepted(stagingEnv(), "staging");
  for (const [plane, originTier] of [
    [config, configuration.ORIGIN_TIER_RATE_LIMITS],
    [staging, configuration.STAGING_ORIGIN_TIER_RATE_LIMITS],
  ]) {
    const env = createProductionWorkerEnv(plane, {
      bindings: { ...serviceBindings(originTier), ...postgresOriginLimiters(originTier) },
    });
    for (const { binding } of Object.values(originTier)) {
      assert.ok(env[binding] instanceof canonical.rateLimiter.PostgresRateLimiter, binding);
    }
  }
  // Each origin-tier limiter carries exactly its plane's frozen limit and period.
  const productionTier = configuration.ORIGIN_TIER_RATE_LIMITS;
  const stagingTier = configuration.STAGING_ORIGIN_TIER_RATE_LIMITS;
  const mismatches = [
    // Staging built with production's limits, and production with a test-host-like 1000/60.
    [staging, { ...serviceBindings(stagingTier), ...postgresOriginLimiters(productionTier) }],
    [config, { ...serviceBindings(), UPLOAD_AUTHORIZATION_RATE_LIMIT:
      postgresLimiter("UPLOAD_AUTHORIZATION_RATE_LIMIT", 1_000, 60) }],
  ];
  for (const [plane, bindings] of mismatches) {
    expectCode(() => createProductionWorkerEnv(plane, { bindings }),
      "UPLOAD_AUTHORIZATION_RATE_LIMIT_BINDING_LIMIT_MISMATCH");
  }
  for (const { binding: name, limit, periodSeconds } of Object.values(productionTier)) {
    for (const binding of [
      originLimiter(limit + 1, periodSeconds),
      originLimiter(limit, periodSeconds + 1),
      originLimiter(String(limit), periodSeconds),
      originLimiter(limit, undefined),
      postgresLimiter(name, limit, 30),
      limiter(),
    ]) {
      expectCode(() => createProductionWorkerEnv(config, { bindings: { ...serviceBindings(), [name]: binding } }),
        `${name}_BINDING_LIMIT_MISMATCH`);
    }
    const stagingLimits = Object.values(stagingTier).find((limits) => limits.binding === name);
    expectCode(() => createProductionWorkerEnv(staging, { bindings: {
      ...serviceBindings(stagingTier),
      [name]: originLimiter(limit, periodSeconds),
    } }), `${name}_BINDING_LIMIT_MISMATCH`);
    assert.notEqual(stagingLimits.limit, limit, name);
  }
  // Edge-tier names take only edge replay bindings, never a PostgreSQL limiter.
  class SyntheticReplay {
    async limit() { return { success: true }; }
  }
  // One own data property, frozen, but a class instance all the same.
  class SyntheticOwnFieldReplay {
    limit = async () => ({ success: true });
  }
  const getterLimit = Object.freeze(Object.defineProperty({}, "limit", {
    get() { return async () => ({ success: true }); },
    enumerable: true,
  }));
  for (const name of configuration.EDGE_TIER_RATE_LIMIT_BINDINGS) {
    for (const binding of [
      postgresLimiter(name),
      Object.freeze(postgresLimiter(name)),
      Object.freeze(new SyntheticReplay()),
      Object.freeze(new SyntheticOwnFieldReplay()),
      { async limit() { return { success: true }; } },
      Object.freeze({ async limit() { return { success: true }; }, name }),
      Object.freeze({ limit: limiter().limit, [Symbol("synthetic")]: true }),
      getterLimit,
    ]) {
      expectCode(() => createProductionWorkerEnv(config, { bindings: { ...serviceBindings(), [name]: binding } }),
        `${name}_BINDING_NOT_EDGE_REPLAY`);
    }
    const nullPrototype = Object.freeze(Object.assign(Object.create(null), { limit: limiter().limit }));
    assert.equal(createProductionWorkerEnv(config, {
      bindings: { ...serviceBindings(), [name]: nullPrototype },
    })[name], nullPrototype, name);
  }
  expectCode(() => createProductionWorkerEnv(config, { bindings: serviceBindings(), extra: true }),
    "PRODUCTION_ENV_OPTIONS_INVALID");
  expectCode(() => createProductionWorkerEnv(config, null), "PRODUCTION_ENV_OPTIONS_INVALID");
  // Only a configuration this module validated can build an env.
  for (const forged of [{ ...config }, structuredClone(config), JSON.parse(JSON.stringify(config))]) {
    expectCode(() => createProductionWorkerEnv(forged, { bindings: serviceBindings() }),
      "PRODUCTION_CONFIGURATION_INVALID");
  }
});

test("the maintenance-job profile requires the enabled switch and carries it", () => {
  for (const env of [
    without(jobEnv("maintenance-job"), "POSTGRES_SCHEDULED_MAINTENANCE_ENABLED"),
    jobEnv("maintenance-job", { POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "true" }),
    jobEnv("maintenance-job", { POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "" }),
  ]) {
    expectCode(() => readProductionConfiguration(env, "maintenance-job"),
      "POSTGRES_SCHEDULED_MAINTENANCE_DISABLED");
  }
  expectCode(() => readProductionConfiguration(
    without(jobEnv("maintenance-job"), "CLOUD_RUN_JOB"), "maintenance-job"), "CLOUD_RUN_JOB_MISSING");
  const config = expectAccepted(jobEnv("maintenance-job", { POSTGRES_ANALYTICS_MODE: "enabled" }),
    "maintenance-job");
  assert.equal(config.edge, null);
  assert.equal(config.origins.host, null);
  assert.deepEqual(config.deployment.workload, { kind: "job", name: "tibotattle-maintenance" });
  assert.deepEqual(config.jobSwitches, { POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled" });
  const env = createProductionWorkerEnv(config);
  assert.equal(env.POSTGRES_SCHEDULED_MAINTENANCE_ENABLED, "enabled");
  assert.equal(env.DEPLOYMENT_SOURCE_COMMIT, COMMIT);
  assert.equal(env.ENVIRONMENT, "production");
  assert.equal(Reflect.get(env, "POSTGRES_ANALYTICS_MODE"), undefined);
  for (const name of configuration.PRODUCTION_WORKER_BINDING_NAMES) {
    assert.equal(Reflect.get(env, name), undefined, name);
  }
  assert.deepEqual(Reflect.ownKeys(env).sort(), config.workerEnvKeys);
  assert.deepEqual(Reflect.ownKeys(createProductionWorkerEnv(config, { bindings: {} })).sort(),
    config.workerEnvKeys);
  expectCode(() => createProductionWorkerEnv(config, { bindings: serviceBindings() }),
    "PRODUCTION_JOB_BINDINGS_FORBIDDEN");
  expectCode(() => createProductionWorkerEnv(config, { bindings: null }),
    "PRODUCTION_JOB_BINDINGS_FORBIDDEN");
});

test("the analytics-job profiles carry their switches with Worker semantics", () => {
  for (const profile of ["analytics-job", "staging-analytics-job"]) {
    const defaults = expectAccepted(jobEnv(profile), profile);
    assert.deepEqual(defaults.jobSwitches, {
      POSTGRES_ANALYTICS_MODE: "disabled",
      POSTGRES_ANALYTICS_PUBLICATION_LANE: "disabled",
      POSTGRES_ANALYTICS_PUBLICATION_EXTERNAL: "disabled",
    });
    const enabled = expectAccepted(jobEnv(profile, {
      POSTGRES_ANALYTICS_MODE: "enabled",
      POSTGRES_ANALYTICS_PUBLICATION_LANE: "",
      POSTGRES_ANALYTICS_PUBLICATION_EXTERNAL: "enabled",
      POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled",
    }), profile);
    const env = createProductionWorkerEnv(enabled);
    assert.equal(env.POSTGRES_ANALYTICS_MODE, "enabled");
    assert.equal(env.POSTGRES_ANALYTICS_PUBLICATION_LANE, "disabled");
    assert.equal(env.POSTGRES_ANALYTICS_PUBLICATION_EXTERNAL, "enabled");
    assert.equal(env.PUBLIC_ANALYTICS_MODE, "enabled");
    assert.equal(Reflect.get(env, "POSTGRES_SCHEDULED_MAINTENANCE_ENABLED"), undefined);
    assert.deepEqual(expectAccepted(jobEnv(profile, {
      POSTGRES_ANALYTICS_MODE: "disabled",
      POSTGRES_ANALYTICS_PUBLICATION_LANE: "disabled",
      POSTGRES_ANALYTICS_PUBLICATION_EXTERNAL: "",
    }), profile).jobSwitches, defaults.jobSwitches);
    // As STORAGE_ANALYTICS_MODE (storage-analytics-worker.ts): only unset or
    // 'disabled' is off, 'enabled' is on, and anything else, an empty value
    // included, is a configuration error, never a silent no-op.
    for (const value of ["", "Enabled", "true", "on", " enabled"]) {
      expectCode(() => readProductionConfiguration(jobEnv(profile, { POSTGRES_ANALYTICS_MODE: value }), profile),
        "POSTGRES_ANALYTICS_MODE_INVALID");
    }
    // As PUBLICATION_LANE and PUBLICATION_LANE_EXTERNAL (`=== 'enabled'`):
    // every other value is off, and it never stops the job's other lanes.
    for (const name of ["POSTGRES_ANALYTICS_PUBLICATION_LANE", "POSTGRES_ANALYTICS_PUBLICATION_EXTERNAL"]) {
      for (const value of ["Enabled", "true", "on", " enabled", "enabled ", "1"]) {
        const config = expectAccepted(jobEnv(profile, { POSTGRES_ANALYTICS_MODE: "enabled", [name]: value }),
          profile);
        assert.equal(config.jobSwitches[name], "disabled", `${name}=${JSON.stringify(value)}`);
        assert.equal(config.jobSwitches.POSTGRES_ANALYTICS_MODE, "enabled");
        assert.equal(createProductionWorkerEnv(config)[name], "disabled");
      }
      assert.equal(expectAccepted(jobEnv(profile, { [name]: "enabled" }), profile).jobSwitches[name], "enabled");
    }
    // Cross-checked against the Worker's own lane predicate
    // (storagePublicationLaneEnabled; PUBLICATION_LANE_EXTERNAL is read the
    // same way inline in storage-analytics-worker.ts).
    for (const value of [undefined, "", "enabled", "disabled", "Enabled", "true", " enabled", "enabled "]) {
      const overrides = value === undefined ? {} : { POSTGRES_ANALYTICS_PUBLICATION_LANE: value };
      assert.equal(
        expectAccepted(jobEnv(profile, overrides), profile).jobSwitches.POSTGRES_ANALYTICS_PUBLICATION_LANE === "enabled",
        canonical.publication.storagePublicationLaneEnabled(value === undefined ? {} : { PUBLICATION_LANE: value }),
        JSON.stringify(value),
      );
    }
  }
  const service = createProductionWorkerEnv(
    expectAccepted(productionEnv({ POSTGRES_ANALYTICS_MODE: "enabled" }), "production"),
    { bindings: serviceBindings() },
  );
  for (const names of Object.values(configuration.PRODUCTION_JOB_SWITCH_NAMES)) {
    for (const name of names) assert.equal(Reflect.get(service, name), undefined, name);
  }
});

test("the staging maintenance job requires the enabled switch too", () => {
  expectCode(() => readProductionConfiguration(
    without(jobEnv("staging-maintenance-job"), "POSTGRES_SCHEDULED_MAINTENANCE_ENABLED"),
    "staging-maintenance-job"), "POSTGRES_SCHEDULED_MAINTENANCE_DISABLED");
  const config = expectAccepted(jobEnv("staging-maintenance-job"), "staging-maintenance-job");
  assert.deepEqual(config.jobSwitches, { POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled" });
  assert.deepEqual(config.deployment.workload, { kind: "job", name: "tibotattle-staging-maintenance" });
});

test("OD-2: every profile requires the quarantine bucket's birth proof, closed and bound to its bucket", () => {
  const profiles = [
    ["production", (overrides) => productionEnv(overrides), "synthetic-origin-quarantine"],
    ["staging", (overrides) => stagingEnv(overrides), "synthetic-staging-quarantine"],
    ...JOB_PROFILES.map((job) => [job, (overrides) => jobEnv(job, overrides),
      job.startsWith("staging-") ? "synthetic-staging-quarantine" : "synthetic-origin-quarantine"]),
  ];
  const code = "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_INVALID";
  for (const [profile, env, bucket] of profiles) {
    const accepted = readProductionConfiguration(env(), profile);
    assert.deepEqual(accepted.resources.bucketHistoryProof, JSON.parse(proof(bucket)), profile);
    expectCode(() => readProductionConfiguration(without(env(), "GCS_QUARANTINE_BUCKET_HISTORY_PROOF"), profile),
      "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_MISSING");
    for (const value of [
      "",
      proof("another-synthetic-quarantine"),
      proof(bucket, { extra: "1" }),
      JSON.stringify({ proof: JSON.parse(proof(bucket)) }),
      JSON.stringify({ schemaVersion: "tibotattle-gcp-bucket-birth-v1", proof: JSON.parse(proof(bucket)) }),
      proof(bucket, { softDeleteRetentionDurationSeconds: "604800" }),
      proof(bucket, { softDeleteRetentionDurationSeconds: 0 }),
      proof(bucket, { bucketGeneration: "0" }),
      proof(bucket, { bucketGeneration: "01" }),
      proof(bucket, { bucketGeneration: 1700000000000001 }),
      proof(bucket, { bucketMetageneration: "9223372036854775808" }),
      "[]",
      "null",
      "not-json",
      " ".repeat(2_000),
    ]) {
      expectCode(() => readProductionConfiguration(env({ GCS_QUARANTINE_BUCKET_HISTORY_PROOF: value }), profile),
        value === "" ? "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_MISSING" : code);
    }
    // The retired erasure-era name stays refused next to a valid proof.
    expectCode(() => readProductionConfiguration(env({ GCS_ERASURE_BUCKET_HISTORY_PROOF: proof(bucket) }), profile),
      "GCS_ERASURE_BUCKET_HISTORY_PROOF_FORBIDDEN");
  }
  // A test-target bucket is still refused by its own code, before the proof.
  expectCode(() => readProductionConfiguration(productionEnv({ GCS_BUCKET_NAME: CLOUD_RUN_IAM_TEST_TARGET.gcsBucket,
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: proof(CLOUD_RUN_IAM_TEST_TARGET.gcsBucket) }), "production"),
  "GCS_BUCKET_NAME_TEST_TARGET_FORBIDDEN");
});

// ---------------------------------------------------------------------------
// Mirrors of Worker validators, cross-checked against the canonical source

function acceptsProduction(overrides) {
  try {
    readProductionConfiguration(productionEnv(overrides), "production");
    return true;
  } catch (error) {
    assert.ok(typeof error?.code === "string");
    return false;
  }
}

function acceptsCanonical(action) {
  try {
    action();
    return true;
  } catch {
    return false;
  }
}

test("one quarantine bucket-history proof grammar: CR-3's, which the store accepts (OD-2)", () => {
  const bucket = "synthetic-origin-quarantine";
  const token = async () => "synthetic-token";
  const accepted = [
    proof(bucket),
    proof(bucket, { bucketGeneration: "9223372036854775807", bucketMetageneration: "2" }),
  ];
  const refused = [
    proof(bucket, { bucketGeneration: "9223372036854775808" }),
    proof(bucket, { bucketGeneration: "0" }),
    proof(bucket, { bucketGeneration: "1e3" }),
    proof(bucket, { bucketMetageneration: "" }),
    proof(bucket, { softDeleteRetentionDurationSeconds: "1" }),
    proof("another-synthetic-quarantine"),
    proof(bucket, { extra: true }),
    JSON.stringify({ proof: JSON.parse(proof(bucket)) }),
    JSON.stringify({ bucket, bucketGeneration: "1", bucketMetageneration: "1" }),
    "{}",
    "[]",
    "not-json",
    "",
    `${proof(bucket)}${" ".repeat(1_100)}`,
  ];
  for (const value of accepted) {
    assert.equal(acceptsProduction({ GCS_QUARANTINE_BUCKET_HISTORY_PROOF: value }), true, value);
    const parsed = configuration.parseQuarantineBucketHistoryProof(value, bucket);
    assert.ok(Object.isFrozen(parsed));
    assert.deepEqual(parsed, JSON.parse(value));
    // The store re-validates the parsed proof and accepts it for its bucket only.
    assert.doesNotThrow(() => canonical.quarantineStore.createGcsQuarantineObjectStore(
      bucket, token, undefined, undefined, parsed));
    assert.throws(() => canonical.quarantineStore.createGcsQuarantineObjectStore(
      "another-synthetic-quarantine", token, undefined, undefined, parsed));
  }
  for (const value of refused) {
    assert.equal(acceptsProduction({ GCS_QUARANTINE_BUCKET_HISTORY_PROOF: value }), false, value.slice(0, 120));
    expectCode(() => configuration.parseQuarantineBucketHistoryProof(value, bucket),
      "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_INVALID");
  }
  expectCode(() => configuration.parseQuarantineBucketHistoryProof(proof(bucket), "Not A Bucket"),
    "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_INVALID");
  // The second grammar is gone: src keeps the setting name only.
  assert.equal(canonical.quarantineStore.parseGcsQuarantineBucketHistoryProof, undefined);
  assert.equal(configuration.QUARANTINE_BUCKET_HISTORY_PROOF_SETTING,
    canonical.quarantineStore.GCS_QUARANTINE_BUCKET_HISTORY_PROOF_SETTING);
});

test("isProductionConfiguration accepts only an issued configuration, never a lookalike", () => {
  const issued = readProductionConfiguration(productionEnv(), "production");
  assert.equal(configuration.isProductionConfiguration(issued), true);
  const lookalike = Object.freeze({ ...issued });
  assert.deepEqual(lookalike, issued);
  assert.equal(configuration.isProductionConfiguration(lookalike), false);
  assert.equal(configuration.isProductionConfiguration(structuredClone({ origins: issued.origins })), false);
  for (const value of [null, undefined, "production", 1, [], {}]) {
    assert.equal(configuration.isProductionConfiguration(value), false, inspect(value));
  }
  // A lookalike is also refused where the configuration is consumed.
  expectCode(() => createProductionWorkerEnv(lookalike, { bindings: {} }), "PRODUCTION_CONFIGURATION_INVALID");
});

test("the namespace grammar matches parseTelemetryStorageMode", () => {
  const values = [
    "synthetic-namespace", "a", "a".repeat(256), "a".repeat(257), "tele:metry.v1_x-y",
    "f".repeat(64), "space here", "slash/namespace", "é", "tab\tname", "UPPER.case",
  ];
  for (const value of values) {
    assert.equal(
      acceptsProduction({ TELEMETRY_STORAGE_NAMESPACE: value }),
      acceptsCanonical(() => canonical.storage.parseTelemetryStorageMode({
        TELEMETRY_STORAGE_MODE: "typed",
        TELEMETRY_STORAGE_NAMESPACE: value,
      })),
      value,
    );
  }
});

test("the envelope key grammar matches src/crypto.ts", () => {
  const publicKeys = [
    { kty: "RSA", kid: "key:synthetic-production-check", n: "n", e: "e" },
    { kty: "RSA", kid: "key:", n: "n", e: "e" },
    { kty: "RSA", kid: `key:${"a".repeat(65)}`, n: "n", e: "e" },
    { kty: "RSA", kid: "synthetic", n: "n", e: "e" },
    { kty: "RSA", kid: "key:synthetic", n: 1, e: "e" },
    { kty: "RSA", kid: "key:synthetic", n: "n", e: "e", d: "d" },
    { kty: "oct", kid: "key:synthetic", n: "n", e: "e" },
  ];
  for (const jwk of publicKeys) {
    const raw = JSON.stringify(jwk);
    const privateRaw = JSON.stringify({ ...jwk, d: "d" });
    assert.equal(
      acceptsProduction({ ENVELOPE_PUBLIC_JWK: raw, ENVELOPE_PRIVATE_JWK: privateRaw }),
      acceptsCanonical(() => canonical.crypto.publicEnvelopeKey(raw)),
      raw,
    );
  }
});

test("the IAM user, schema, Apple key and identity-version mirrors match their sources", () => {
  for (const value of [
    "origin-runtime@synthetic-project.iam",
    "origin-runtime@synthetic-project.iam.gserviceaccount.com",
    "a".repeat(63),
    "a".repeat(64),
    "-leading",
    "origin runtime",
  ]) {
    const expected = acceptsCanonical(() => normalizeIamUser(value));
    assert.equal(acceptsProduction({ POSTGRES_IAM_USER: value }), expected, value);
    if (expected) {
      assert.equal(readProductionConfiguration(productionEnv({ POSTGRES_IAM_USER: value }), "production")
        .resources.iamUser, normalizeIamUser(value));
    }
  }
  // The primary schema grammar. LEAD-SIMP made the canonical runtime
  // validator primary-only (it refuses a second schema key), so the primary
  // value alone decides.
  for (const primary of [
    "origin_primary", "pg_primary", "information_schema", "Origin", "_origin",
    "a".repeat(63), "a".repeat(64), "origin-primary", "origin primary",
  ]) {
    assert.equal(
      acceptsProduction({ PRIMARY_SCHEMA: primary }),
      acceptsCanonical(() => canonical.postgresClient.createPostgresSchemaConfig({
        primarySchema: primary,
      })),
      primary,
    );
  }
  for (const key of [
    SECRET_VALUES.APPLE_PRIVATE_KEY,
    SECRET_VALUES.APPLE_PRIVATE_KEY.replaceAll("\\n", "\n"),
    "-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----\nc3ludGhldGlj\n-----END EC PRIVATE KEY-----",
    "c3ludGhldGlj",
  ]) {
    assert.equal(
      acceptsProduction({ APPLE_PRIVATE_KEY: key }),
      acceptsCanonical(() => canonical.apple.appleSignInConfiguration({
        APPLE_SERVICES_ID: configuration.PRODUCTION_VARS.APPLE_SERVICES_ID,
        APPLE_TEAM_ID: configuration.PRODUCTION_VARS.APPLE_TEAM_ID,
        APPLE_KEY_ID: configuration.PRODUCTION_VARS.APPLE_KEY_ID,
        APPLE_PRIVATE_KEY: key,
      })),
      key,
    );
  }
  for (const version of ["staging-v1", "staging.v2_x", "-staging", "a".repeat(64), "a".repeat(65), "st aging"]) {
    let accepted;
    try {
      readProductionConfiguration(stagingEnv({ IDENTITY_LINK_SECRET_VERSION: version }), "staging");
      accepted = true;
    } catch (error) {
      assert.equal(error.code, "IDENTITY_LINK_SECRET_VERSION_INVALID");
      accepted = false;
    }
    assert.equal(accepted, canonical.identityLink.IDENTITY_LINK_SECRET_VERSION_PATTERN.test(version), version);
  }
  // The production pins themselves satisfy the staging grammars.
  assert.ok(canonical.identityLink.IDENTITY_LINK_SECRET_VERSION_PATTERN.test(
    configuration.PRODUCTION_VARS.IDENTITY_LINK_SECRET_VERSION,
  ));
});

test("one Cloud SQL instance and no deletion ledger: retired settings are refused, never read", () => {
  // The pool map and the readiness roles name only the primary.
  for (const instances of Object.values(configuration.PRODUCTION_POOL_INSTANCES)) {
    assert.deepEqual([...instances], ["primary"]);
  }
  assert.equal(Object.hasOwn(configuration.PRODUCTION_POOL_SIZES, "ledger"), false);
  assert.deepEqual(Object.keys(configuration.PRODUCTION_POOL_CONNECTIONS_PER_INSTANCE), ["primary"]);
  // Each retired setting is refused when present, valid-looking or empty, in
  // every profile: the closed-key rule here is refusal, not silent ignore.
  const retired = {
    LEDGER_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-ledger",
    LEDGER_DATABASE: "origin_ledger",
    LEDGER_SCHEMA: "origin_ledger",
    GCS_ERASURE_BUCKET_HISTORY_PROOF: proof("synthetic-origin-quarantine"),
    LEDGER_ANY_OTHER_SETTING: "synthetic",
  };
  for (const [name, value] of Object.entries(retired)) {
    const code = RETIRED_LEDGER_VARIABLE_NAMES.includes(name)
      ? `${name}_FORBIDDEN`
      : "LEDGER_CONFIGURATION_FORBIDDEN";
    for (const supplied of [value, ""]) {
      expectCode(() => readProductionConfiguration(productionEnv({ [name]: supplied }), "production"), code);
      expectCode(() => readProductionConfiguration(stagingEnv({ [name]: supplied }), "staging"), code);
      for (const profile of JOB_PROFILES) {
        expectCode(() => readProductionConfiguration(jobEnv(profile, { [name]: supplied }), profile), code);
      }
    }
  }
  // The accepted configuration and its env carry none of them.
  for (const [profile, env] of [
    ["production", productionEnv()],
    ["staging", stagingEnv()],
    ...JOB_PROFILES.map((job) => [job, jobEnv(job)]),
  ]) {
    const config = expectAccepted(env, profile);
    assert.deepEqual(Object.keys(config.resources), ["primary", "iamUser", "bucket", "bucketHistoryProof"], profile);
    assert.equal(config.resources.bucketHistoryProof.bucket, config.resources.bucket, profile);
    const workerEnv = createProductionWorkerEnv(config, profile.endsWith("-job") ? {} : {
      bindings: serviceBindings(config.rateLimits.originTier),
    });
    for (const key of [...Object.keys(retired), "DELETION_LEDGER"]) {
      assert.equal(Reflect.get(workerEnv, key), undefined, `${profile} ${key}`);
    }
    assert.equal(JSON.stringify(config).toLowerCase().includes("ledger"), false, profile);
  }
  // Cutover hygiene stays: a stray Cloudflare DELETION_LEDGER binding still
  // fails, and the production deletion-ledger D1 stays in the fingerprint.
  const config = expectAccepted(productionEnv({ DELETION_LEDGER: "synthetic" }), "production");
  expectCode(() => createProductionWorkerEnv(config, {
    bindings: { ...serviceBindings(), DELETION_LEDGER: limiter() },
  }), "PRODUCTION_BINDING_UNEXPECTED");
  assert.ok(configuration.PRODUCTION_WORKER_ENV_ABSENT_KEYS.includes("DELETION_LEDGER"));
  assert.ok(configuration.PRODUCTION_RESOURCE_FINGERPRINT.cloudflareResourceNames
    .includes("app-usagemonitor-production-deletion-ledger"));
  for (const job of JOB_PROFILES) {
    expectCode(() => createProductionWorkerEnv(expectAccepted(jobEnv(job), job), {
      bindings: { DELETION_LEDGER: limiter() },
    }), "PRODUCTION_JOB_BINDINGS_FORBIDDEN");
  }
});
