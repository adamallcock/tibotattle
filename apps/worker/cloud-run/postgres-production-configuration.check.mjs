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
import { CLOUD_RUN_IAM_TEST_TARGET } from "./postgres-test-dispatch.mjs";
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
  const [storage, crypto, identityLink, gcs, postgresClient, apple] = await Promise.all([
    vite.ssrLoadModule("/src/telemetry-storage-mode.ts"),
    vite.ssrLoadModule("/src/crypto.ts"),
    vite.ssrLoadModule("/src/identity-link-configuration.ts"),
    vite.ssrLoadModule("/src/gcs-erasure-object-store.ts"),
    vite.ssrLoadModule("/src/postgres-client.ts"),
    vite.ssrLoadModule("/src/identity-apple.ts"),
  ]);
  canonical = { storage, crypto, identityLink, gcs, postgresClient, apple };
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
    LEDGER_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-ledger",
    LEDGER_DATABASE: "origin_ledger",
    LEDGER_SCHEMA: "origin_ledger",
    POSTGRES_IAM_USER: "origin-runtime@synthetic-project.iam",
    GCS_BUCKET_NAME: "synthetic-origin-quarantine",
    GCS_ERASURE_BUCKET_HISTORY_PROOF: proof("synthetic-origin-quarantine"),
    ...envelopeKeys("key:synthetic-production-check"),
    IDENTITY_LINK_SECRET: SECRET_VALUES.IDENTITY_LINK_SECRET,
    POSTGRES_RATE_LIMIT_SECRET: SECRET_VALUES.POSTGRES_RATE_LIMIT_SECRET,
    GOOGLE_OIDC_CLIENT_SECRET: SECRET_VALUES.GOOGLE_OIDC_CLIENT_SECRET,
    APPLE_PRIVATE_KEY: SECRET_VALUES.APPLE_PRIVATE_KEY,
    DISTRIBUTION_GITHUB_API_TOKEN: SECRET_VALUES.DISTRIBUTION_GITHUB_API_TOKEN,
  };
}

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
    ...overrides,
  };
}

function stagingEnv(overrides = {}) {
  return {
    ...productionEnv(),
    HOST_MODE: "staging",
    K_SERVICE: "tibotattle-staging-origin",
    HOST_ORIGIN: "https://tibotattle-staging-origin-abc123def4-ue.a.run.app",
    PUBLIC_ORIGIN: "https://staging.synthetic.example",
    ADMIN_HOST_ORIGIN: "https://admin.staging.synthetic.example",
    EDGE_ORIGIN_AUDIENCE: "tibotattle-staging-origin-audience",
    TELEMETRY_STORAGE_NAMESPACE: "synthetic-staging-namespace",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-staging-primary",
    LEDGER_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-staging-ledger",
    GCS_BUCKET_NAME: "synthetic-staging-quarantine",
    GCS_ERASURE_BUCKET_HISTORY_PROOF: proof("synthetic-staging-quarantine"),
    ...envelopeKeys("key:staging-synthetic-check"),
    ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    ACCESS_ADMIN_EMAIL: "owner@synthetic.example",
    IDENTITY_LINK_SECRET_VERSION: "staging-v1",
    GOOGLE_OIDC_CLIENT_ID: "123456789012-syntheticstaging.apps.googleusercontent.com",
    APPLE_SERVICES_ID: "example.synthetic.staging",
    APPLE_KEY_ID: "SYNTHKEY01",
    APPLE_TEAM_ID: "SYNTHTEAM1",
    ...overrides,
  };
}

function jobEnv(profile, overrides = {}) {
  return {
    CLOUD_RUN_JOB: profile === "maintenance-job" ? "tibotattle-maintenance" : "tibotattle-analytics-delivery",
    ...productionResources(),
    ...(profile === "maintenance-job" ? { POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled" } : {}),
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

function serviceBindings() {
  return Object.fromEntries(configuration.PRODUCTION_WORKER_BINDING_NAMES.map((name) => [
    name,
    name === "UPLOAD_INGRESS_BUDGET" ? Object.freeze({ getByName() { return {}; } }) : limiter(),
  ]));
}

const LEAK_MARKERS = Object.freeze([...Object.values(SECRET_VALUES), PRIVATE_EXPONENT]);

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
  assert.deepEqual(configuration.PRODUCTION_POOL_SIZES, { data: 3, ledger: 2, admission: 4, readiness: 1 });
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
  // Pinned independently of the module, so dropping an entry fails here.
  assert.deepEqual(Object.keys(configuration.PRODUCTION_FORBIDDEN_VARIABLES).sort(), [
    "ACCESS_TEST_JWKS_JSON", "ADMIN_OWNER_FIXTURE_JSON", "ADMIN_OWNER_PREVIOUS_FIXTURE_JSON",
    "DISTRIBUTION_ANALYTICS_API_TOKEN",
    "EDGE_CLIENT_KEY_SECRET", "EDGE_INVOKER_KEY_JSON", "EDGE_PROOF_SECRET", "EDGE_PROOF_SHA256",
    "IDENTITY_TEST_JWKS_JSON", "POSTGRES_TEST_HTTP_MODE", "SPARKLE_APPCAST_GUARD_TOKEN",
  ]);
  assert.deepEqual(configuration.PRODUCTION_FORBIDDEN_VARIABLE_PREFIXES, {
    HOST_RATE_LIMIT_: "HOST_RATE_LIMIT_OVERRIDE_FORBIDDEN",
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
    "./postgres-maintenance-gate.mjs",
    "./postgres-test-dispatch.mjs",
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
  assert.equal(config.environment, "production");
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
  assert.deepEqual(config.resources, {
    primary: {
      instanceConnectionName: "synthetic-project:us-east1:origin-primary",
      database: "origin_primary",
      schema: "origin_primary",
    },
    ledger: {
      instanceConnectionName: "synthetic-project:us-east1:origin-ledger",
      database: "origin_ledger",
      schema: "origin_ledger",
    },
    iamUser: "origin-runtime@synthetic-project.iam",
    bucket: "synthetic-origin-quarantine",
    historyProof: {
      bucket: "synthetic-origin-quarantine",
      bucketGeneration: "1700000000000001",
      bucketMetageneration: "1",
      softDeleteRetentionDurationSeconds: "0",
    },
  });
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
    ...Object.entries(configuration.PRODUCTION_FORBIDDEN_VARIABLES),
    ["HOST_RATE_LIMIT_ENROLLMENT_RATE_LIMIT_LIMIT", "HOST_RATE_LIMIT_OVERRIDE_FORBIDDEN"],
    ["HOST_RATE_LIMIT_CLIENT_ATTEMPT_RATE_LIMIT_PERIOD_SECONDS", "HOST_RATE_LIMIT_OVERRIDE_FORBIDDEN"],
  ];
  assert.equal(new Set(cases.map(([, code]) => code)).size, cases.length - 1);
  for (const [name, code] of cases) {
    for (const value of ["synthetic-forbidden-value", ""]) {
      expectCode(() => readProductionConfiguration(productionEnv({ [name]: value }), "production"), code);
      expectCode(() => readProductionConfiguration(stagingEnv({ [name]: value }), "staging"), code);
      for (const profile of ["maintenance-job", "analytics-job"]) {
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
    expectCode(() => readProductionConfiguration(without(jobEnv("maintenance-job"), name),
      "maintenance-job"), `${name}_MISSING`);
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
  const testProof = proof(target.gcsBucket);
  const cases = [
    [{ K_SERVICE: target.service }, "K_SERVICE_TEST_TARGET_FORBIDDEN"],
    [{ HOST_ORIGIN: target.origin }, "HOST_ORIGIN_TEST_TARGET_FORBIDDEN"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: target.postgres.primary.instanceConnectionName },
      "PRIMARY_INSTANCE_CONNECTION_NAME_TEST_TARGET_FORBIDDEN"],
    [{ PRIMARY_DATABASE: target.postgres.primary.database }, "PRIMARY_DATABASE_TEST_TARGET_FORBIDDEN"],
    [{ PRIMARY_SCHEMA: target.postgres.primary.schema }, "PRIMARY_SCHEMA_TEST_TARGET_FORBIDDEN"],
    [{ LEDGER_INSTANCE_CONNECTION_NAME: target.postgres.ledger.instanceConnectionName },
      "LEDGER_INSTANCE_CONNECTION_NAME_TEST_TARGET_FORBIDDEN"],
    [{ LEDGER_DATABASE: target.postgres.ledger.database }, "LEDGER_DATABASE_TEST_TARGET_FORBIDDEN"],
    [{ LEDGER_SCHEMA: target.postgres.ledger.schema }, "LEDGER_SCHEMA_TEST_TARGET_FORBIDDEN"],
    [{ POSTGRES_IAM_USER: target.postgres.iamUser }, "POSTGRES_IAM_USER_TEST_TARGET_FORBIDDEN"],
    [{ POSTGRES_IAM_USER: `${target.postgres.iamUser}.gserviceaccount.com` },
      "POSTGRES_IAM_USER_TEST_TARGET_FORBIDDEN"],
    [{ GCS_BUCKET_NAME: target.gcsBucket, GCS_ERASURE_BUCKET_HISTORY_PROOF: testProof },
      "GCS_BUCKET_NAME_TEST_TARGET_FORBIDDEN"],
    [{ EDGE_INVOKER_SERVICE_ACCOUNT: `${target.postgres.iamUser}.gserviceaccount.com` },
      "EDGE_INVOKER_SERVICE_ACCOUNT_TEST_TARGET_FORBIDDEN"],
    [{ EDGE_ORIGIN_AUDIENCE: target.origin }, "EDGE_ORIGIN_AUDIENCE_TEST_TARGET_FORBIDDEN"],
    [{ TELEMETRY_STORAGE_NAMESPACE: target.postgres.primary.schema },
      "TELEMETRY_STORAGE_NAMESPACE_TEST_TARGET_FORBIDDEN"],
  ];
  for (const [overrides, code] of cases) {
    expectCode(() => readProductionConfiguration(productionEnv(overrides), "production"), code);
  }
  expectCode(() => readProductionConfiguration(
    jobEnv("analytics-job", { PRIMARY_DATABASE: target.postgres.primary.database }), "analytics-job"),
  "PRIMARY_DATABASE_TEST_TARGET_FORBIDDEN");
  // The whole test deployment, as the IAM test host is configured.
  expectCode(() => readProductionConfiguration(productionEnv({
    K_SERVICE: target.service,
    HOST_ORIGIN: target.origin,
    PRIMARY_INSTANCE_CONNECTION_NAME: target.postgres.primary.instanceConnectionName,
    PRIMARY_DATABASE: target.postgres.primary.database,
    PRIMARY_SCHEMA: target.postgres.primary.schema,
    LEDGER_INSTANCE_CONNECTION_NAME: target.postgres.ledger.instanceConnectionName,
    LEDGER_DATABASE: target.postgres.ledger.database,
    LEDGER_SCHEMA: target.postgres.ledger.schema,
    POSTGRES_IAM_USER: target.postgres.iamUser,
    GCS_BUCKET_NAME: target.gcsBucket,
    GCS_ERASURE_BUCKET_HISTORY_PROOF: testProof,
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
    [{ LEDGER_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-primary" },
      "LEDGER_INSTANCE_CONNECTION_NAME_NOT_INDEPENDENT"],
    [{ PRIMARY_DATABASE: "origin-primary" }, "PRIMARY_DATABASE_INVALID"],
    [{ LEDGER_SCHEMA: "origin_primary" }, "LEDGER_SCHEMA_NOT_INDEPENDENT"],
    [{ PRIMARY_SCHEMA: "pg_origin" }, "PRIMARY_SCHEMA_INVALID"],
    [{ LEDGER_SCHEMA: "information_schema" }, "LEDGER_SCHEMA_INVALID"],
    [{ LEDGER_SCHEMA: "Origin_Ledger" }, "LEDGER_SCHEMA_INVALID"],
    [{ POSTGRES_IAM_USER: "" }, "POSTGRES_IAM_USER_MISSING"],
    [{ POSTGRES_IAM_USER: "origin runtime" }, "POSTGRES_IAM_USER_INVALID"],
    [{ GCS_BUCKET_NAME: "Synthetic" }, "GCS_BUCKET_NAME_INVALID"],
    [{ GCS_BUCKET_NAME: "synthetic.origin.quarantine" }, "GCS_BUCKET_NAME_INVALID"],
    [{ GCS_ERASURE_BUCKET_HISTORY_PROOF: "" }, "GCS_ERASURE_BUCKET_HISTORY_PROOF_MISSING"],
    [{ GCS_ERASURE_BUCKET_HISTORY_PROOF: "{" }, "GCS_ERASURE_BUCKET_HISTORY_PROOF_INVALID"],
    [{ GCS_ERASURE_BUCKET_HISTORY_PROOF: proof("synthetic-other-bucket") },
      "GCS_ERASURE_BUCKET_HISTORY_PROOF_BUCKET_MISMATCH"],
    [{ GCS_ERASURE_BUCKET_HISTORY_PROOF: proof("synthetic-origin-quarantine", { extra: "1" }) },
      "GCS_ERASURE_BUCKET_HISTORY_PROOF_INVALID"],
    [{ GCS_ERASURE_BUCKET_HISTORY_PROOF: proof("synthetic-origin-quarantine", { bucketGeneration: "0" }) },
      "GCS_ERASURE_BUCKET_HISTORY_PROOF_INVALID"],
    [{ GCS_ERASURE_BUCKET_HISTORY_PROOF: proof("synthetic-origin-quarantine",
      { softDeleteRetentionDurationSeconds: "604800" }) }, "GCS_ERASURE_BUCKET_HISTORY_PROOF_INVALID"],
  ];
  for (const [overrides, code] of cases) {
    expectCode(() => readProductionConfiguration(productionEnv(overrides), "production"), code);
  }
  const wrapped = expectAccepted(productionEnv({
    GCS_ERASURE_BUCKET_HISTORY_PROOF: JSON.stringify({
      schemaVersion: "synthetic-receipt",
      proof: JSON.parse(proof("synthetic-origin-quarantine")),
    }),
  }), "production");
  assert.equal(wrapped.resources.historyProof.bucketGeneration, "1700000000000001");
  const serviceAccountUser = expectAccepted(productionEnv({
    POSTGRES_IAM_USER: "origin-runtime@synthetic-project.iam.gserviceaccount.com",
  }), "production");
  assert.equal(serviceAccountUser.resources.iamUser, "origin-runtime@synthetic-project.iam");
});

test("staging requires its own plane and aborts on any production value", () => {
  const staging = expectAccepted(stagingEnv(), "staging");
  assert.equal(staging.environment, "staging");
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
  const cases = [
    [{ PUBLIC_ORIGIN: "https://tibotattle.com" }, "PUBLIC_ORIGIN_PRODUCTION_VALUE_FORBIDDEN"],
    [{ PUBLIC_ORIGIN: "https://www.tibotattle.com" }, "PUBLIC_ORIGIN_PRODUCTION_VALUE_FORBIDDEN"],
    [{ ADMIN_HOST_ORIGIN: "https://admin.tibotattle.com" }, "ADMIN_HOST_ORIGIN_PRODUCTION_VALUE_FORBIDDEN"],
    [{ ACCESS_AUD: production.ACCESS_AUD }, "ACCESS_AUD_PRODUCTION_VALUE_FORBIDDEN"],
    [{ IDENTITY_LINK_SECRET_VERSION: "production-v1" }, "IDENTITY_LINK_SECRET_VERSION_PRODUCTION_VALUE_FORBIDDEN"],
    [{ GOOGLE_OIDC_CLIENT_ID: production.GOOGLE_OIDC_CLIENT_ID }, "GOOGLE_OIDC_CLIENT_ID_PRODUCTION_VALUE_FORBIDDEN"],
    [{ APPLE_KEY_ID: production.APPLE_KEY_ID }, "APPLE_KEY_ID_PRODUCTION_VALUE_FORBIDDEN"],
    [{ GCS_BUCKET_NAME: "app-usagemonitor-production-quarantine",
      GCS_ERASURE_BUCKET_HISTORY_PROOF: proof("app-usagemonitor-production-quarantine") },
    "GCS_BUCKET_NAME_PRODUCTION_VALUE_FORBIDDEN"],
    [{ K_SERVICE: "tibotattle-production-staging" }, "K_SERVICE_PRODUCTION_VALUE_FORBIDDEN"],
    [{ K_SERVICE: "tibotattle-origin" }, "K_SERVICE_STAGING_MARKER_MISSING"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-primary" },
      "PRIMARY_INSTANCE_CONNECTION_NAME_STAGING_MARKER_MISSING"],
    [{ LEDGER_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-production-staging-ledger" },
      "LEDGER_INSTANCE_CONNECTION_NAME_PRODUCTION_VALUE_FORBIDDEN"],
    [{ GCS_BUCKET_NAME: "synthetic-quarantine", GCS_ERASURE_BUCKET_HISTORY_PROOF: proof("synthetic-quarantine") },
      "GCS_BUCKET_NAME_STAGING_MARKER_MISSING"],
    [envelopeKeys("key:synthetic-production-check"), "ENVELOPE_KEY_ID_PRODUCTION_VALUE_FORBIDDEN"],
    [envelopeKeys("key:synthetic-check"), "ENVELOPE_KEY_ID_STAGING_MARKER_MISSING"],
    // A marker must be a delimited token, not a substring.
    [envelopeKeys("key:nonstaging"), "ENVELOPE_KEY_ID_STAGING_MARKER_MISSING"],
    [{ PUBLIC_ORIGIN: "https://tibotattle-staging-origin-abc123def4-ue.a.run.app" }, "PUBLIC_ORIGIN_INVALID"],
    [{ ADMIN_HOST_ORIGIN: "https://staging.synthetic.example" }, "ADMIN_HOST_ORIGIN_INVALID"],
    [without(stagingEnv(), "ADMIN_HOST_ORIGIN"), "ADMIN_HOST_ORIGIN_MISSING"],
    [{ ACCESS_AUD: "A".repeat(64) }, "ACCESS_AUD_INVALID"],
    [{ IDENTITY_LINK_SECRET_VERSION: "-staging" }, "IDENTITY_LINK_SECRET_VERSION_INVALID"],
    [without(stagingEnv(), "APPLE_KEY_ID"), "APPLE_KEY_ID_MISSING"],
  ];
  for (const [overrides, code] of cases) {
    const env = "HOST_MODE" in overrides ? overrides : stagingEnv(overrides);
    expectCode(() => readProductionConfiguration(env, "staging"), code);
  }
  // Staging may share the owner's Access team, admin email, Apple team and
  // services id; those identify no production secret or data plane.
  expectAccepted(stagingEnv({
    ACCESS_TEAM_DOMAIN: production.ACCESS_TEAM_DOMAIN,
    ACCESS_ADMIN_EMAIL: production.ACCESS_ADMIN_EMAIL,
    APPLE_TEAM_ID: production.APPLE_TEAM_ID,
    APPLE_SERVICES_ID: production.APPLE_SERVICES_ID,
  }), "staging");
});

test("production and its jobs refuse staging-marked resources", () => {
  const cases = [
    [{ K_SERVICE: "tibotattle-staging-origin" }, "K_SERVICE_STAGING_VALUE_FORBIDDEN"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-staging-primary" },
      "PRIMARY_INSTANCE_CONNECTION_NAME_STAGING_VALUE_FORBIDDEN"],
    [{ LEDGER_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:staging" },
      "LEDGER_INSTANCE_CONNECTION_NAME_STAGING_VALUE_FORBIDDEN"],
    [{ GCS_BUCKET_NAME: "synthetic-staging-quarantine",
      GCS_ERASURE_BUCKET_HISTORY_PROOF: proof("synthetic-staging-quarantine") },
    "GCS_BUCKET_NAME_STAGING_VALUE_FORBIDDEN"],
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
    ["maintenance-job", jobEnv("maintenance-job", { TELEMETRY_STORAGE_MODE: "json" })],
    ["analytics-job", jobEnv("analytics-job", { TELEMETRY_STORAGE_MODE: "json" })],
  ]) {
    const config = expectAccepted(env, profile);
    const workerEnv = createProductionWorkerEnv(config, profile.endsWith("-job") ? {} : {
      bindings: serviceBindings(),
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

test("the analytics-job profile carries its switches with Worker semantics", () => {
  const defaults = expectAccepted(jobEnv("analytics-job"), "analytics-job");
  assert.deepEqual(defaults.jobSwitches, {
    POSTGRES_ANALYTICS_MODE: "disabled",
    POSTGRES_ANALYTICS_PUBLICATION_LANE: "disabled",
    POSTGRES_ANALYTICS_PUBLICATION_EXTERNAL: "disabled",
  });
  const enabled = expectAccepted(jobEnv("analytics-job", {
    POSTGRES_ANALYTICS_MODE: "enabled",
    POSTGRES_ANALYTICS_PUBLICATION_LANE: "",
    POSTGRES_ANALYTICS_PUBLICATION_EXTERNAL: "enabled",
    POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled",
  }), "analytics-job");
  const env = createProductionWorkerEnv(enabled);
  assert.equal(env.POSTGRES_ANALYTICS_MODE, "enabled");
  assert.equal(env.POSTGRES_ANALYTICS_PUBLICATION_LANE, "disabled");
  assert.equal(env.POSTGRES_ANALYTICS_PUBLICATION_EXTERNAL, "enabled");
  assert.equal(env.PUBLIC_ANALYTICS_MODE, "enabled");
  assert.equal(Reflect.get(env, "POSTGRES_SCHEDULED_MAINTENANCE_ENABLED"), undefined);
  for (const name of configuration.PRODUCTION_JOB_SWITCH_NAMES["analytics-job"]) {
    for (const value of ["Enabled", "true", "on"]) {
      expectCode(() => readProductionConfiguration(jobEnv("analytics-job", { [name]: value }),
        "analytics-job"), `${name}_INVALID`);
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
  for (const [primary, ledger] of [
    ["origin_primary", "origin_ledger"],
    ["origin_primary", "origin_primary"],
    ["pg_primary", "origin_ledger"],
    ["origin_primary", "information_schema"],
    ["Origin", "origin_ledger"],
    ["_origin", "origin_ledger"],
    ["a".repeat(63), "origin_ledger"],
    ["a".repeat(64), "origin_ledger"],
  ]) {
    assert.equal(
      acceptsProduction({ PRIMARY_SCHEMA: primary, LEDGER_SCHEMA: ledger }),
      acceptsCanonical(() => canonical.postgresClient.createPostgresSchemaConfig({
        primarySchema: primary, ledgerSchema: ledger,
      })),
      `${primary}/${ledger}`,
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

test("every history proof accepted here is accepted by createGcsErasureBucketHistoryProof", () => {
  const base = JSON.parse(proof("synthetic-origin-quarantine"));
  const variants = [
    base,
    { ...base, bucketGeneration: "9223372036854775807" },
    { ...base, bucketGeneration: "9223372036854775808" },
    { ...base, bucketGeneration: "0" },
    { ...base, bucketGeneration: "01" },
    { ...base, bucketGeneration: 1 },
    { ...base, bucketMetageneration: "" },
    { ...base, softDeleteRetentionDurationSeconds: 0 },
  ];
  for (const variant of variants) {
    const accepted = acceptsProduction({ GCS_ERASURE_BUCKET_HISTORY_PROOF: JSON.stringify(variant) });
    const canonicalAccepted = acceptsCanonical(() =>
      canonical.gcs.createGcsErasureBucketHistoryProof(variant));
    assert.equal(accepted, canonicalAccepted, JSON.stringify(variant));
  }
});
