/**
 * Production configuration for the IAM-private Cloud Run origin and its
 * production jobs.
 *
 * Everything the Worker treats as reviewed production configuration is a
 * frozen code constant here: origins, pinned vars, rate-limit tiers, pool
 * sizes and admission timeouts. A deployment supplies only its identity
 * (source commit, service or job, origins it was assigned), the Cloud SQL and
 * GCS resource names, the edge-invoker settings and secrets. Two steps turn a
 * process environment into the Worker-shaped env the reused handlers read:
 *
 *   readProductionConfiguration(processEnv, profile) -> frozen configuration
 *   createProductionWorkerEnv(configuration, { bindings }) -> frozen env
 *
 * The env is built from named keys only. It never spreads or copies the
 * process environment, so test seams the Worker reads with Reflect.get
 * (ACCESS_TEST_JWKS_JSON, IDENTITY_TEST_JWKS_JSON, ...), D1/R2/asset bindings
 * and edge-only secrets can never reach it. Pinned vars are not overridable:
 * a process value such as TELEMETRY_STORAGE_MODE=json is ignored.
 *
 * Error handling: every refusal throws an Error whose message and `code` are
 * the same constant. Codes name a setting, never a value, and no secret value
 * is ever logged, returned or attached to an error. Secrets live behind
 * opaque handles; only createProductionWorkerEnv and revealProductionSecret
 * read them.
 *
 * This module stays importable by plain Node (the infrastructure scripts read
 * the secret-name sets from it): its only TypeScript import is the
 * self-contained EP-0 edge/origin contract. Validators whose canonical form
 * lives in Worker TypeScript are mirrored here and cross-checked against that
 * source in postgres-production-configuration.check.mjs.
 *
 * Live settings: production (Worker version 152, observed 2026-09-23 and
 * recorded in docs/plans/2026-09-24-gcp-source-integration.md, "Observed
 * production boundary") runs typed telemetry although the checked-in
 * wrangler.jsonc still says json. PRODUCTION_VARS pins 'typed', and
 * production-live-settings.receipt.json records that override so the repo
 * drift check (scripts/cloud-run-production-configuration.check.mjs) can
 * compare everything else with wrangler.jsonc env.production.
 */

import {
  canonicalRunAppOrigin,
  isEdgeOriginAudience,
  isEdgeServiceAccountEmail,
} from "../src/edge-origin-contract.ts";
import { assertPostgresScheduledMaintenanceEnabled } from "./postgres-maintenance-gate.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./postgres-test-dispatch.mjs";

// ---------------------------------------------------------------------------
// Frozen production constants

export const PRODUCTION_PUBLIC_ORIGIN = "https://tibotattle.com";
export const PRODUCTION_ADMIN_ORIGIN = "https://admin.tibotattle.com";
export const PRODUCTION_WWW_HOST = "www.tibotattle.com";

/** Per-instance PostgreSQL pool sizes for the production service. */
export const PRODUCTION_POOL_SIZES = Object.freeze({
  data: 3,
  ledger: 2,
  admission: 4,
  readiness: 1,
});

/**
 * Transaction bounds for the origin-tier limiters and the ingress budget on
 * the admission pool, in the shape PostgresRateLimiter takes as its
 * transaction options.
 */
export const PRODUCTION_ADMISSION_TIMEOUTS = Object.freeze({
  lockTimeoutMilliseconds: 1_000,
  statementTimeoutMilliseconds: 2_000,
});

/**
 * Address-keyed limits enforced at the Cloudflare edge. The origin receives
 * only the edge's outcome and replays it through these binding names; they
 * are never instantiated as PostgreSQL limiters.
 */
export const EDGE_TIER_RATE_LIMIT_NAMES = Object.freeze([
  "ENROLLMENT",
  "RECOVERY",
  "CLIENT_ATTEMPT",
  "PUBLIC_READ",
  "UPLOAD_INGRESS_REQUEST",
  "UPLOAD_INGRESS_CLIENT",
]);
export const EDGE_TIER_RATE_LIMIT_BINDINGS = Object.freeze(
  EDGE_TIER_RATE_LIMIT_NAMES.map((name) => `${name}_RATE_LIMIT`),
);

/** Identity-keyed limits the origin enforces in PostgreSQL. */
export const ORIGIN_TIER_RATE_LIMITS = Object.freeze({
  UPLOAD_AUTHORIZATION: Object.freeze({
    binding: "UPLOAD_AUTHORIZATION_RATE_LIMIT",
    limit: 3_000,
    periodSeconds: 60,
  }),
  UPLOAD_PRINCIPAL: Object.freeze({
    binding: "UPLOAD_PRINCIPAL_RATE_LIMIT",
    limit: 3_000,
    periodSeconds: 60,
  }),
});

export const UPLOAD_INGRESS_BUDGET_BINDING = "UPLOAD_INGRESS_BUDGET";

/** The injected bindings a service env carries, and nothing else. */
export const PRODUCTION_WORKER_BINDING_NAMES = Object.freeze([
  ...EDGE_TIER_RATE_LIMIT_BINDINGS,
  ...Object.values(ORIGIN_TIER_RATE_LIMITS).map(({ binding }) => binding),
  UPLOAD_INGRESS_BUDGET_BINDING,
]);

export const REQUIRED_SECRET_NAMES = Object.freeze([
  "IDENTITY_LINK_SECRET",
  "POSTGRES_RATE_LIMIT_SECRET",
  "ENVELOPE_PUBLIC_JWK",
  "ENVELOPE_PRIVATE_JWK",
  "GOOGLE_OIDC_CLIENT_SECRET",
  "APPLE_PRIVATE_KEY",
]);
export const OPTIONAL_SECRET_NAMES = Object.freeze(["DISTRIBUTION_GITHUB_API_TOKEN"]);

/** Origin secrets the Cloudflare Worker never had. */
export const ORIGIN_ONLY_SECRET_NAMES = Object.freeze(["POSTGRES_RATE_LIMIT_SECRET"]);

/** Secrets the Worker code reads from env. POSTGRES_RATE_LIMIT_SECRET is not one. */
const WORKER_ENV_SECRET_NAMES = Object.freeze([
  "IDENTITY_LINK_SECRET",
  "ENVELOPE_PUBLIC_JWK",
  "ENVELOPE_PRIVATE_JWK",
  "GOOGLE_OIDC_CLIENT_SECRET",
  "APPLE_PRIVATE_KEY",
  "DISTRIBUTION_GITHUB_API_TOKEN",
]);

/** Cloudflare-only secrets. They stay at the edge and are refused here. */
export const EDGE_ONLY_SECRET_NAMES = Object.freeze([
  "EDGE_CLIENT_KEY_SECRET",
  "EDGE_INVOKER_KEY_JSON",
  "DISTRIBUTION_ANALYTICS_API_TOKEN",
  "SPARKLE_APPCAST_GUARD_TOKEN",
]);

/**
 * wrangler.jsonc env.production vars that stay with the Cloudflare edge
 * (distribution analytics and the Sparkle appcast guard). They are never
 * part of the origin configuration.
 */
export const EDGE_ONLY_VAR_NAMES = Object.freeze(["DISTRIBUTION_ANALYTICS_ZONE_ID"]);
export const EDGE_ONLY_VAR_PREFIXES = Object.freeze(["SPARKLE_"]);

/** Pinned origin vars with no wrangler.jsonc counterpart. */
export const ORIGIN_ONLY_VAR_NAMES = Object.freeze([
  "PERFORMANCE_TELEMETRY_STORAGE_MODE",
  "EDGE_ORIGIN_MODE",
]);

/** Vars each deployment supplies and this module validates. */
export const DEPLOYMENT_PROVIDED_VAR_NAMES = Object.freeze([
  "TELEMETRY_STORAGE_NAMESPACE",
  "DEPLOYMENT_SOURCE_COMMIT",
]);

export const EDGE_ORIGIN_MODE = "cloudflare-worker-iam";

/**
 * wrangler.jsonc env.production vars, minus the edge-only ones, plus the
 * origin-only switches. TELEMETRY_STORAGE_MODE is the live 'typed' setting
 * (see the header and production-live-settings.receipt.json).
 */
export const PRODUCTION_VARS = Object.freeze({
  PUBLIC_ANALYTICS_MODE: "enabled",
  ENVIRONMENT: "production",
  ALLOWANCE_RECONSTRUCTION_MODE: "resumable",
  PUBLIC_ORIGIN: PRODUCTION_PUBLIC_ORIGIN,
  ENROLLMENT_MODE: "open",
  ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
  ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
  ACCOUNT_SCOPED_INGEST_MODE: "disabled",
  TELEMETRY_STORAGE_MODE: "typed",
  UPLOAD_INGRESS_QUEUE_MODE: "disabled",
  UPLOAD_INGRESS_MAX_CONCURRENT: "64",
  UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE: "1200",
  UPLOAD_INGRESS_BURST: "1200",
  UPLOAD_INGRESS_LEASE_SECONDS: "90",
  UPLOAD_INGRESS_BODY_TOTAL_SECONDS: "60",
  UPLOAD_INGRESS_BODY_IDLE_SECONDS: "15",
  SIGN_IN_START_MAX_PER_MINUTE: "300",
  INCREMENTAL_EXTERNAL_PARTICIPANTS: "authorized",
  IDENTITY_LINK_SECRET_VERSION: "production-v1",
  GOOGLE_OIDC_CLIENT_ID: "806510610397-f6k0uje651hpurbmfr7vub9iqj04428j.apps.googleusercontent.com",
  APPLE_SERVICES_ID: "com.usagemonitor.web",
  APPLE_KEY_ID: "L58X7J2J7A",
  APPLE_TEAM_ID: "43RTH622SB",
  ACCESS_TEAM_DOMAIN: "tibotattle.cloudflareaccess.com",
  ACCESS_AUD: "3ffbc68d303a9da74f462a685b788c57935c65024df4e9b144e1c872598bb61c",
  ACCESS_ADMIN_EMAIL: "adamallcock@gmail.com",
  PERFORMANCE_TELEMETRY_STORAGE_MODE: "enabled",
  EDGE_ORIGIN_MODE,
});

/**
 * Production values a staging deployment must never carry. GCP resource
 * names are not listed: they do not exist yet, so the staging and production
 * planes are kept apart by name markers instead (see STAGING_RESOURCE_MARKER).
 */
export const PRODUCTION_RESOURCE_FINGERPRINT = Object.freeze({
  origins: Object.freeze([
    PRODUCTION_PUBLIC_ORIGIN,
    PRODUCTION_ADMIN_ORIGIN,
    `https://${PRODUCTION_WWW_HOST}`,
  ]),
  hosts: Object.freeze([
    new URL(PRODUCTION_PUBLIC_ORIGIN).host,
    new URL(PRODUCTION_ADMIN_ORIGIN).host,
    PRODUCTION_WWW_HOST,
  ]),
  accessAud: PRODUCTION_VARS.ACCESS_AUD,
  identityLinkSecretVersion: PRODUCTION_VARS.IDENTITY_LINK_SECRET_VERSION,
  googleOidcClientId: PRODUCTION_VARS.GOOGLE_OIDC_CLIENT_ID,
  appleKeyId: PRODUCTION_VARS.APPLE_KEY_ID,
  // The Cloudflare production Worker, its D1 databases and R2 buckets.
  cloudflareResourceNames: Object.freeze([
    "app-usagemonitor",
    "app-usagemonitor-production",
    "app-usagemonitor-production-deletion-ledger",
    "app-usagemonitor-production-quarantine",
    "tibotattle-updates",
  ]),
});

/**
 * Staging names every plane-identifying resource (service or job, Cloud SQL
 * instances, bucket, envelope key id) with this token; production never
 * does. A staging name must not carry the production token either. Tokens
 * are delimited by any character other than a lowercase letter or digit.
 */
export const STAGING_RESOURCE_MARKER = "staging";
export const PRODUCTION_RESOURCE_MARKER = "production";

/** Present in the process environment at all (even empty): refused. */
export const PRODUCTION_FORBIDDEN_VARIABLES = Object.freeze({
  ACCESS_TEST_JWKS_JSON: "ACCESS_TEST_JWKS_JSON_FORBIDDEN",
  IDENTITY_TEST_JWKS_JSON: "IDENTITY_TEST_JWKS_JSON_FORBIDDEN",
  POSTGRES_TEST_HTTP_MODE: "POSTGRES_TEST_HTTP_MODE_FORBIDDEN",
  ADMIN_OWNER_FIXTURE_JSON: "ADMIN_OWNER_FIXTURE_JSON_FORBIDDEN",
  ADMIN_OWNER_PREVIOUS_FIXTURE_JSON: "ADMIN_OWNER_PREVIOUS_FIXTURE_JSON_FORBIDDEN",
  EDGE_PROOF_SECRET: "EDGE_PROOF_SECRET_FORBIDDEN",
  EDGE_PROOF_SHA256: "EDGE_PROOF_SHA256_FORBIDDEN",
  EDGE_CLIENT_KEY_SECRET: "EDGE_CLIENT_KEY_SECRET_FORBIDDEN",
  EDGE_INVOKER_KEY_JSON: "EDGE_INVOKER_KEY_JSON_FORBIDDEN",
  DISTRIBUTION_ANALYTICS_API_TOKEN: "DISTRIBUTION_ANALYTICS_API_TOKEN_FORBIDDEN",
  SPARKLE_APPCAST_GUARD_TOKEN: "SPARKLE_APPCAST_GUARD_TOKEN_FORBIDDEN",
});
export const PRODUCTION_FORBIDDEN_VARIABLE_PREFIXES = Object.freeze({
  HOST_RATE_LIMIT_: "HOST_RATE_LIMIT_OVERRIDE_FORBIDDEN",
});

/**
 * Keys a production Worker env never holds: D1, R2 and asset bindings, the
 * test and development seams the Worker reads with Reflect.get, the old test
 * host's backend seams, origin-only and edge-only secrets. Any key outside
 * the env's named allowlist is absent; this list names the ones that matter.
 */
export const PRODUCTION_WORKER_ENV_ABSENT_KEYS = Object.freeze([
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
  "DISTRIBUTION_ANALYTICS_ZONE_ID",
  ...EDGE_ONLY_SECRET_NAMES,
]);

export const PRODUCTION_CONFIGURATION_PROFILES = Object.freeze([
  "production",
  "staging",
  "maintenance-job",
  "analytics-job",
]);

/** Job switches, by profile, with the Worker's semantics (unset is off). */
export const PRODUCTION_JOB_SWITCH_NAMES = Object.freeze({
  "maintenance-job": Object.freeze(["POSTGRES_SCHEDULED_MAINTENANCE_ENABLED"]),
  "analytics-job": Object.freeze([
    "POSTGRES_ANALYTICS_MODE",
    "POSTGRES_ANALYTICS_PUBLICATION_LANE",
    "POSTGRES_ANALYTICS_PUBLICATION_EXTERNAL",
  ]),
});

/** Staging supplies its own identity-bound vars; the rest are production's. */
export const STAGING_PROVIDED_VAR_NAMES = Object.freeze([
  "PUBLIC_ORIGIN",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
  "ACCESS_ADMIN_EMAIL",
  "IDENTITY_LINK_SECRET_VERSION",
  "GOOGLE_OIDC_CLIENT_ID",
  "APPLE_SERVICES_ID",
  "APPLE_KEY_ID",
  "APPLE_TEAM_ID",
]);

// ---------------------------------------------------------------------------
// Validation grammars

const SERVICE_PROFILES = new Set(["production", "staging"]);
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
// Cloud Run service and job names: a DNS label that starts with a letter.
const CLOUD_RUN_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const MAX_VERIFIER_SERVICE_ACCOUNTS = 4;
// Mirrors encodeTypedTelemetryId (src/typed-telemetry-codec.ts) as used by
// parseTelemetryStorageMode; cross-checked in the configuration check.
const TELEMETRY_STORAGE_NAMESPACE_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
// project:region:instance, as Cloud SQL instance connection names are written.
const INSTANCE_CONNECTION_NAME_PATTERN =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z]+-[a-z]+[0-9]+:[a-z](?:[a-z0-9-]{0,96}[a-z0-9])?$/u;
// Mirrors cloud-sql.mjs (DATABASE_PATTERN, IAM_ROLE_PATTERN) and
// src/postgres-client.ts (SCHEMA_IDENTIFIER and its reserved names).
const DATABASE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/u;
const IAM_ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@_.-]{0,62}$/u;
// Mirrors bucketName in src/gcs-erasure-object-store.ts, without dots (a
// dotted name is a domain-verified bucket, which this service never uses).
const BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{1,61}[a-z0-9])$/u;
const GENERATION_PATTERN = /^[1-9][0-9]{0,18}$/u;
const MAX_GENERATION = 9_223_372_036_854_775_807n;
const MAX_HISTORY_PROOF_BYTES = 16_384;
const HISTORY_PROOF_KEYS = Object.freeze([
  "bucket",
  "bucketGeneration",
  "bucketMetageneration",
  "softDeleteRetentionDurationSeconds",
]);
// Mirrors src/crypto.ts parseJwk.
const ENVELOPE_KEY_ID_PATTERN = /^key:[A-Za-z0-9._-]{1,64}$/u;
// Mirrors src/identity-link-configuration.ts.
const IDENTITY_LINK_SECRET_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MIN_IDENTITY_LINK_SECRET_LENGTH = 32;
const MIN_RATE_LIMIT_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 65_536;
// Mirrors src/identity-apple.ts.
const PKCS8_PEM_PATTERN =
  /-----BEGIN PRIVATE KEY-----([\sA-Za-z0-9+/=]+)-----END PRIVATE KEY-----/u;
const APPLE_ID_PATTERN = /^[A-Z0-9]{10}$/u;
const APPLE_SERVICES_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,254}[A-Za-z0-9])?$/u;
const ACCESS_AUD_PATTERN = /^[a-f0-9]{64}$/u;
const ACCESS_TEAM_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u;
const EMAIL_PATTERN = /^[!-?A-~]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,187}[a-z0-9])?$/u;
const GOOGLE_OIDC_CLIENT_ID_PATTERN = /^[0-9]{1,32}-[a-z0-9]{1,64}\.apps\.googleusercontent\.com$/u;
const DNS_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SWITCH_VALUES = new Set(["enabled", "disabled"]);

// ---------------------------------------------------------------------------
// Internal state

const CONFIGURATIONS = new WeakSet();
const SECRET_VALUES = new WeakMap();

function configurationError(code) {
  throw Object.assign(new Error(code), { code });
}

function readEnvironment(processEnv) {
  if (processEnv === null || typeof processEnv !== "object") {
    configurationError("PRODUCTION_ENVIRONMENT_INVALID");
  }
  const has = (name) => Object.prototype.hasOwnProperty.call(processEnv, name);
  return Object.freeze({
    has,
    /** A present, non-empty string value, else undefined. */
    value(name) {
      if (!has(name)) return undefined;
      const value = processEnv[name];
      return typeof value === "string" && value !== "" ? value : undefined;
    },
    required(name) {
      const value = this.value(name);
      if (value === undefined) configurationError(`${name}_MISSING`);
      return value;
    },
    // Enumerated only to find the refused prefixes; never copied.
    names: () => Object.keys(processEnv),
  });
}

function assertNoForbiddenVariables(environment) {
  for (const [name, code] of Object.entries(PRODUCTION_FORBIDDEN_VARIABLES)) {
    if (environment.has(name)) configurationError(code);
  }
  const names = environment.names();
  for (const [prefix, code] of Object.entries(PRODUCTION_FORBIDDEN_VARIABLE_PREFIXES)) {
    if (names.some((name) => name.startsWith(prefix))) configurationError(code);
  }
}

function matching(environment, name, pattern) {
  const value = environment.required(name);
  if (!pattern.test(value)) configurationError(`${name}_INVALID`);
  return value;
}

/** A canonical https origin (no credentials, port, path, query or fragment). */
function canonicalHttpsOrigin(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
      || url.port !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== ""
      || url.origin !== value || !DNS_HOSTNAME_PATTERN.test(url.hostname)) {
    return null;
  }
  return url.origin;
}

function markerPattern(marker) {
  return new RegExp(`(?:^|[^a-z0-9])${marker}(?:[^a-z0-9]|$)`, "iu");
}
const STAGING_MARKER = markerPattern(STAGING_RESOURCE_MARKER);
const PRODUCTION_MARKER = markerPattern(PRODUCTION_RESOURCE_MARKER);

/** Normalizes like cloud-sql.mjs normalizeIamUser; cross-checked there. */
function iamDatabaseUser(value) {
  const user = value.endsWith(".gserviceaccount.com")
    ? value.slice(0, -".gserviceaccount.com".length)
    : value;
  if (!IAM_ROLE_PATTERN.test(user) || new TextEncoder().encode(user).byteLength > 63) {
    configurationError("POSTGRES_IAM_USER_INVALID");
  }
  return user;
}

function reservedSchema(value) {
  return value === "information_schema" || value.startsWith("pg_");
}

function databaseResource(environment, role) {
  const prefix = role.toUpperCase();
  const instanceConnectionName = matching(
    environment, `${prefix}_INSTANCE_CONNECTION_NAME`, INSTANCE_CONNECTION_NAME_PATTERN,
  );
  const database = matching(environment, `${prefix}_DATABASE`, DATABASE_PATTERN);
  const schema = matching(environment, `${prefix}_SCHEMA`, SCHEMA_PATTERN);
  if (reservedSchema(schema)) configurationError(`${prefix}_SCHEMA_INVALID`);
  return Object.freeze({ instanceConnectionName, database, schema });
}

/**
 * Mirrors createGcsErasureBucketHistoryProof (src/gcs-erasure-object-store.ts)
 * and accepts either the proof or a bucket-birth receipt carrying it under
 * `proof`, as the test host does. The proof's keys are closed, as the test
 * deployment's readback requires.
 */
function bucketHistoryProof(environment, bucket) {
  const raw = environment.required("GCS_ERASURE_BUCKET_HISTORY_PROOF");
  if (new TextEncoder().encode(raw).byteLength > MAX_HISTORY_PROOF_BYTES) {
    configurationError("GCS_ERASURE_BUCKET_HISTORY_PROOF_INVALID");
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const proof = isObject(parsed) && parsed.proof !== undefined ? parsed.proof : parsed;
  const generation = (value) => {
    if (typeof value !== "string" || !GENERATION_PATTERN.test(value)
        || BigInt(value) > MAX_GENERATION) {
      configurationError("GCS_ERASURE_BUCKET_HISTORY_PROOF_INVALID");
    }
    return value;
  };
  if (!isObject(proof) || Object.keys(proof).sort().join() !== HISTORY_PROOF_KEYS.join()
      || typeof proof.bucket !== "string" || proof.softDeleteRetentionDurationSeconds !== "0") {
    configurationError("GCS_ERASURE_BUCKET_HISTORY_PROOF_INVALID");
  }
  const bucketGeneration = generation(proof.bucketGeneration);
  const bucketMetageneration = generation(proof.bucketMetageneration);
  if (proof.bucket !== bucket) {
    configurationError("GCS_ERASURE_BUCKET_HISTORY_PROOF_BUCKET_MISMATCH");
  }
  return Object.freeze({
    bucket,
    bucketGeneration,
    bucketMetageneration,
    softDeleteRetentionDurationSeconds: "0",
  });
}

function verifierServiceAccounts(environment, invoker) {
  if (!environment.has("EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS")) return Object.freeze([]);
  const raw = environment.value("EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS");
  // Rendered empty when no verifier is configured.
  if (raw === undefined) return Object.freeze([]);
  const accounts = raw.split(",");
  if (accounts.length > MAX_VERIFIER_SERVICE_ACCOUNTS
      || accounts.some((account) => !isEdgeServiceAccountEmail(account) || account === invoker)
      || new Set(accounts).size !== accounts.length) {
    configurationError("EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS_INVALID");
  }
  return Object.freeze(accounts);
}

function testTargetValues() {
  const values = new Set();
  const visit = (value) => {
    if (typeof value === "string") values.add(value);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(CLOUD_RUN_IAM_TEST_TARGET);
  values.add(new URL(CLOUD_RUN_IAM_TEST_TARGET.origin).host);
  values.add(`${CLOUD_RUN_IAM_TEST_TARGET.postgres.iamUser}.gserviceaccount.com`);
  return values;
}
const TEST_TARGET_VALUES = testTargetValues();

function fingerprintValues() {
  const values = new Set();
  for (const value of Object.values(PRODUCTION_RESOURCE_FINGERPRINT)) {
    for (const item of Array.isArray(value) ? value : [value]) values.add(item);
  }
  return values;
}
const PRODUCTION_FINGERPRINT_VALUES = fingerprintValues();

function assertNotTestTarget(settings) {
  for (const [name, value] of settings) {
    if (TEST_TARGET_VALUES.has(value)) configurationError(`${name}_TEST_TARGET_FORBIDDEN`);
  }
}

function secretBytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function secretHandle(name, value) {
  const handle = Object.freeze({ name });
  SECRET_VALUES.set(handle, value);
  return handle;
}

function parseJwk(raw, code) {
  let jwk;
  try { jwk = JSON.parse(raw); } catch { configurationError(code); }
  if (jwk === null || typeof jwk !== "object" || Array.isArray(jwk)
      || jwk.kty !== "RSA" || typeof jwk.kid !== "string"
      || !ENVELOPE_KEY_ID_PATTERN.test(jwk.kid)
      || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
    configurationError(code);
  }
  return jwk;
}

/** Validates every secret by name; values never leave through an error. */
function readSecrets(environment) {
  const values = new Map();
  for (const name of REQUIRED_SECRET_NAMES) {
    const value = environment.required(name);
    if (secretBytes(value) > MAX_SECRET_BYTES) configurationError(`${name}_INVALID`);
    values.set(name, value);
  }
  if (values.get("IDENTITY_LINK_SECRET").length < MIN_IDENTITY_LINK_SECRET_LENGTH) {
    configurationError("IDENTITY_LINK_SECRET_INVALID");
  }
  if (secretBytes(values.get("POSTGRES_RATE_LIMIT_SECRET")) < MIN_RATE_LIMIT_SECRET_BYTES) {
    configurationError("POSTGRES_RATE_LIMIT_SECRET_INVALID");
  }
  const publicJwk = parseJwk(values.get("ENVELOPE_PUBLIC_JWK"), "ENVELOPE_PUBLIC_JWK_INVALID");
  if (publicJwk.d !== undefined) configurationError("ENVELOPE_PUBLIC_JWK_INVALID");
  const privateJwk = parseJwk(values.get("ENVELOPE_PRIVATE_JWK"), "ENVELOPE_PRIVATE_JWK_INVALID");
  if (typeof privateJwk.d !== "string") configurationError("ENVELOPE_PRIVATE_JWK_INVALID");
  if (privateJwk.kid !== publicJwk.kid) configurationError("ENVELOPE_KEY_ID_MISMATCH");
  // Secret stores commonly flatten the .p8 newlines to backslash-n.
  if (!PKCS8_PEM_PATTERN.test(values.get("APPLE_PRIVATE_KEY").replaceAll("\\n", "\n"))) {
    configurationError("APPLE_PRIVATE_KEY_INVALID");
  }
  for (const name of OPTIONAL_SECRET_NAMES) {
    const value = environment.value(name);
    if (value === undefined) continue;
    if (secretBytes(value) > MAX_SECRET_BYTES) configurationError(`${name}_INVALID`);
    values.set(name, value);
  }
  const handles = {};
  for (const [name, value] of values) handles[name] = secretHandle(name, value);
  return { handles: Object.freeze(handles), envelopeKeyId: publicJwk.kid };
}

function switchValue(environment, name) {
  if (!environment.has(name)) return "disabled";
  const value = environment.value(name) ?? "disabled";
  if (!SWITCH_VALUES.has(value)) configurationError(`${name}_INVALID`);
  return value;
}

function readJobSwitches(environment, profile) {
  if (profile === "maintenance-job") {
    // The existing gate: anything but 'enabled' keeps the writer dormant.
    const probe = Object.freeze({
      POSTGRES_SCHEDULED_MAINTENANCE_ENABLED:
        environment.value("POSTGRES_SCHEDULED_MAINTENANCE_ENABLED"),
    });
    assertPostgresScheduledMaintenanceEnabled(probe);
    return Object.freeze({ POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled" });
  }
  if (profile === "analytics-job") {
    // Worker semantics: unset or 'disabled' is off; only 'enabled' is on.
    return Object.freeze(Object.fromEntries(PRODUCTION_JOB_SWITCH_NAMES["analytics-job"]
      .map((name) => [name, switchValue(environment, name)])));
  }
  return Object.freeze({});
}

function readStagingVars(environment) {
  const patterns = {
    ACCESS_TEAM_DOMAIN: ACCESS_TEAM_DOMAIN_PATTERN,
    ACCESS_AUD: ACCESS_AUD_PATTERN,
    ACCESS_ADMIN_EMAIL: EMAIL_PATTERN,
    IDENTITY_LINK_SECRET_VERSION: IDENTITY_LINK_SECRET_VERSION_PATTERN,
    GOOGLE_OIDC_CLIENT_ID: GOOGLE_OIDC_CLIENT_ID_PATTERN,
    APPLE_SERVICES_ID: APPLE_SERVICES_ID_PATTERN,
    APPLE_KEY_ID: APPLE_ID_PATTERN,
    APPLE_TEAM_ID: APPLE_ID_PATTERN,
  };
  const vars = {};
  for (const [name, pattern] of Object.entries(patterns)) {
    vars[name] = matching(environment, name, pattern);
  }
  if (vars.ACCESS_ADMIN_EMAIL.length > 254) configurationError("ACCESS_ADMIN_EMAIL_INVALID");
  return vars;
}

function readOrigins(environment, profile) {
  if (!SERVICE_PROFILES.has(profile)) {
    return Object.freeze({
      public: PRODUCTION_PUBLIC_ORIGIN,
      admin: PRODUCTION_ADMIN_ORIGIN,
      wwwHost: PRODUCTION_WWW_HOST,
      host: null,
    });
  }
  const host = canonicalRunAppOrigin(environment.required("HOST_ORIGIN"));
  if (host === null) configurationError("HOST_ORIGIN_INVALID");
  if (profile === "production") {
    if (environment.required("PUBLIC_ORIGIN") !== PRODUCTION_PUBLIC_ORIGIN) {
      configurationError("PUBLIC_ORIGIN_INVALID");
    }
    if (environment.has("ADMIN_HOST_ORIGIN")
        && environment.value("ADMIN_HOST_ORIGIN") !== PRODUCTION_ADMIN_ORIGIN) {
      configurationError("ADMIN_HOST_ORIGIN_INVALID");
    }
    return Object.freeze({
      public: PRODUCTION_PUBLIC_ORIGIN,
      admin: PRODUCTION_ADMIN_ORIGIN,
      wwwHost: PRODUCTION_WWW_HOST,
      host,
    });
  }
  const publicOrigin = canonicalHttpsOrigin(environment.required("PUBLIC_ORIGIN"));
  if (publicOrigin === null || publicOrigin === host) configurationError("PUBLIC_ORIGIN_INVALID");
  const adminOrigin = canonicalHttpsOrigin(environment.required("ADMIN_HOST_ORIGIN"));
  if (adminOrigin === null || adminOrigin === host || adminOrigin === publicOrigin) {
    configurationError("ADMIN_HOST_ORIGIN_INVALID");
  }
  return Object.freeze({ public: publicOrigin, admin: adminOrigin, wwwHost: null, host });
}

function readEdge(environment) {
  if (environment.required("EDGE_ORIGIN_MODE") !== EDGE_ORIGIN_MODE) {
    configurationError("EDGE_ORIGIN_MODE_INVALID");
  }
  const audience = environment.required("EDGE_ORIGIN_AUDIENCE");
  if (!isEdgeOriginAudience(audience)) configurationError("EDGE_ORIGIN_AUDIENCE_INVALID");
  const invokerServiceAccount = environment.required("EDGE_INVOKER_SERVICE_ACCOUNT");
  if (!isEdgeServiceAccountEmail(invokerServiceAccount)) {
    configurationError("EDGE_INVOKER_SERVICE_ACCOUNT_INVALID");
  }
  return Object.freeze({
    mode: EDGE_ORIGIN_MODE,
    audience,
    invokerServiceAccount,
    verifierServiceAccounts: verifierServiceAccounts(environment, invokerServiceAccount),
  });
}

/** Keeps staging and production apart without knowing production's GCP names. */
function assertPlaneSeparation(profile, planeNames, stagingValues) {
  if (profile === "staging") {
    for (const [name, value] of stagingValues) {
      if (PRODUCTION_FINGERPRINT_VALUES.has(value)) {
        configurationError(`${name}_PRODUCTION_VALUE_FORBIDDEN`);
      }
    }
    for (const [name, value] of planeNames) {
      if (PRODUCTION_MARKER.test(value)) configurationError(`${name}_PRODUCTION_VALUE_FORBIDDEN`);
      if (!STAGING_MARKER.test(value)) configurationError(`${name}_STAGING_MARKER_MISSING`);
    }
    return;
  }
  for (const [name, value] of planeNames) {
    if (STAGING_MARKER.test(value)) configurationError(`${name}_STAGING_VALUE_FORBIDDEN`);
  }
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Validates a process environment for one profile and returns a frozen
 * configuration. `profile` is 'production' or 'staging' for the service, or
 * 'maintenance-job' / 'analytics-job' for the production jobs. Throws an
 * Error whose message and `code` name the first refused setting.
 */
export function readProductionConfiguration(processEnv, profile) {
  if (!PRODUCTION_CONFIGURATION_PROFILES.includes(profile)) {
    configurationError("PRODUCTION_PROFILE_INVALID");
  }
  const environment = readEnvironment(processEnv);
  assertNoForbiddenVariables(environment);
  const service = SERVICE_PROFILES.has(profile);

  const sourceCommit = matching(environment, "DEPLOYMENT_SOURCE_COMMIT", SOURCE_COMMIT_PATTERN);
  const workload = service
    ? Object.freeze({ kind: "service", name: matching(environment, "K_SERVICE", CLOUD_RUN_NAME_PATTERN) })
    : Object.freeze({ kind: "job", name: matching(environment, "CLOUD_RUN_JOB", CLOUD_RUN_NAME_PATTERN) });
  const workloadVariable = service ? "K_SERVICE" : "CLOUD_RUN_JOB";
  const origins = readOrigins(environment, profile);
  const edge = service ? readEdge(environment) : null;
  const namespace = matching(
    environment, "TELEMETRY_STORAGE_NAMESPACE", TELEMETRY_STORAGE_NAMESPACE_PATTERN,
  );

  const primary = databaseResource(environment, "primary");
  const ledger = databaseResource(environment, "ledger");
  if (ledger.instanceConnectionName === primary.instanceConnectionName) {
    configurationError("LEDGER_INSTANCE_CONNECTION_NAME_NOT_INDEPENDENT");
  }
  if (ledger.schema === primary.schema) configurationError("LEDGER_SCHEMA_NOT_INDEPENDENT");
  const rawIamUser = environment.required("POSTGRES_IAM_USER");
  const iamUser = iamDatabaseUser(rawIamUser);
  const bucket = matching(environment, "GCS_BUCKET_NAME", BUCKET_PATTERN);
  const historyProof = bucketHistoryProof(environment, bucket);

  const deploymentValues = [
    [workloadVariable, workload.name],
    ["TELEMETRY_STORAGE_NAMESPACE", namespace],
    ["PRIMARY_INSTANCE_CONNECTION_NAME", primary.instanceConnectionName],
    ["PRIMARY_DATABASE", primary.database],
    ["PRIMARY_SCHEMA", primary.schema],
    ["LEDGER_INSTANCE_CONNECTION_NAME", ledger.instanceConnectionName],
    ["LEDGER_DATABASE", ledger.database],
    ["LEDGER_SCHEMA", ledger.schema],
    ["POSTGRES_IAM_USER", rawIamUser],
    ["POSTGRES_IAM_USER", iamUser],
    ["GCS_BUCKET_NAME", bucket],
  ];
  if (origins.host !== null) {
    deploymentValues.push(["HOST_ORIGIN", origins.host], ["HOST_ORIGIN", new URL(origins.host).host]);
  }
  if (edge !== null) {
    deploymentValues.push(
      ["EDGE_ORIGIN_AUDIENCE", edge.audience],
      ["EDGE_INVOKER_SERVICE_ACCOUNT", edge.invokerServiceAccount],
      ...edge.verifierServiceAccounts.map((account) =>
        ["EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS", account]),
    );
  }
  if (profile === "staging") {
    deploymentValues.push(
      ["PUBLIC_ORIGIN", origins.public],
      ["PUBLIC_ORIGIN", new URL(origins.public).host],
      ["ADMIN_HOST_ORIGIN", origins.admin],
      ["ADMIN_HOST_ORIGIN", new URL(origins.admin).host],
    );
  }
  assertNotTestTarget(deploymentValues);

  const stagingVars = profile === "staging" ? readStagingVars(environment) : null;
  const secrets = readSecrets(environment);
  const planeNames = [
    [workloadVariable, workload.name],
    ["PRIMARY_INSTANCE_CONNECTION_NAME", primary.instanceConnectionName],
    ["LEDGER_INSTANCE_CONNECTION_NAME", ledger.instanceConnectionName],
    ["GCS_BUCKET_NAME", bucket],
    ["ENVELOPE_KEY_ID", secrets.envelopeKeyId],
  ];
  const stagingValues = stagingVars === null ? [] : [
    ...deploymentValues,
    ...Object.entries(stagingVars),
    ["ENVELOPE_KEY_ID", secrets.envelopeKeyId],
  ];
  assertPlaneSeparation(profile, planeNames, stagingValues);

  const jobSwitches = readJobSwitches(environment, profile);
  const vars = Object.freeze({
    ...PRODUCTION_VARS,
    ...(stagingVars === null ? {} : {
      ...stagingVars,
      ENVIRONMENT: "staging",
      PUBLIC_ORIGIN: origins.public,
    }),
    TELEMETRY_STORAGE_NAMESPACE: namespace,
    DEPLOYMENT_SOURCE_COMMIT: sourceCommit,
    ...jobSwitches,
  });
  const workerEnvKeys = Object.freeze([
    ...Object.keys(vars),
    ...WORKER_ENV_SECRET_NAMES.filter((name) => secrets.handles[name] !== undefined),
    ...(service ? PRODUCTION_WORKER_BINDING_NAMES : []),
  ].sort());

  const configuration = Object.freeze({
    profile,
    environment: vars.ENVIRONMENT,
    deployment: Object.freeze({ sourceCommit, workload }),
    origins,
    edge,
    vars,
    jobSwitches,
    secrets: secrets.handles,
    resources: Object.freeze({
      primary,
      ledger,
      iamUser,
      bucket,
      historyProof,
    }),
    poolSizes: PRODUCTION_POOL_SIZES,
    admissionTimeouts: PRODUCTION_ADMISSION_TIMEOUTS,
    rateLimits: Object.freeze({
      edgeTier: EDGE_TIER_RATE_LIMIT_NAMES,
      originTier: ORIGIN_TIER_RATE_LIMITS,
    }),
    workerEnvKeys,
  });
  CONFIGURATIONS.add(configuration);
  return configuration;
}

/** Returns a secret's value from a handle this module issued. */
export function revealProductionSecret(handle) {
  const value = handle !== null && typeof handle === "object" ? SECRET_VALUES.get(handle) : undefined;
  if (value === undefined) configurationError("PRODUCTION_SECRET_HANDLE_INVALID");
  return value;
}

function readBindings(configuration, options) {
  if (options === undefined || options === null || typeof options !== "object"
      || Object.keys(options).some((key) => key !== "bindings")) {
    configurationError("PRODUCTION_ENV_OPTIONS_INVALID");
  }
  const { bindings } = options;
  if (configuration.deployment.workload.kind === "job") {
    // Jobs admit no requests, so they hold no limiter or ingress budget.
    if (bindings !== undefined && (bindings === null || typeof bindings !== "object"
        || Object.keys(bindings).length !== 0)) {
      configurationError("PRODUCTION_JOB_BINDINGS_FORBIDDEN");
    }
    return [];
  }
  if (bindings === null || typeof bindings !== "object" || Array.isArray(bindings)) {
    configurationError("PRODUCTION_BINDINGS_INVALID");
  }
  if (Object.keys(bindings).some((name) => !PRODUCTION_WORKER_BINDING_NAMES.includes(name))) {
    configurationError("PRODUCTION_BINDING_UNEXPECTED");
  }
  return PRODUCTION_WORKER_BINDING_NAMES.map((name) => {
    if (!Object.prototype.hasOwnProperty.call(bindings, name) || bindings[name] === undefined) {
      configurationError(`${name}_BINDING_MISSING`);
    }
    const binding = bindings[name];
    const method = name === UPLOAD_INGRESS_BUDGET_BINDING ? "getByName" : "limit";
    if (binding === null || typeof binding !== "object" || typeof binding[method] !== "function") {
      configurationError(`${name}_BINDING_INVALID`);
    }
    return [name, binding];
  });
}

/**
 * Builds the frozen Worker-shaped env from a configuration returned by
 * readProductionConfiguration. Service profiles must inject exactly the six
 * edge-tier replay bindings, the two origin-tier limiters and
 * UPLOAD_INGRESS_BUDGET; job profiles take no bindings. The env holds only
 * named keys (configuration.workerEnvKeys) and has a null prototype.
 */
export function createProductionWorkerEnv(configuration, options = {}) {
  if (!CONFIGURATIONS.has(configuration)) configurationError("PRODUCTION_CONFIGURATION_INVALID");
  const bindings = readBindings(configuration, options);
  const env = Object.create(null);
  for (const name of Object.keys(configuration.vars)) env[name] = configuration.vars[name];
  for (const name of WORKER_ENV_SECRET_NAMES) {
    const handle = configuration.secrets[name];
    if (handle !== undefined) env[name] = revealProductionSecret(handle);
  }
  for (const [name, binding] of bindings) env[name] = binding;
  return Object.freeze(env);
}
