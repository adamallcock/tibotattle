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
 * Profiles belong to one of two planes. The production plane has the
 * 'production' service and the 'maintenance-job' and 'analytics-job' jobs;
 * the staging plane mirrors them as 'staging', 'staging-maintenance-job' and
 * 'staging-analytics-job'. Each profile requires only the secrets it consumes
 * (PRODUCTION_PROFILE_SECRET_NAMES) and refuses the others, even when empty.
 * Job templates and secret mounts therefore render
 * PRODUCTION_PROFILE_SECRET_NAMES[profile]; REQUIRED_SECRET_NAMES and
 * OPTIONAL_SECRET_NAMES are the service set (and the Secret Manager
 * containers), not what every workload mounts.
 *
 * Test-target refusal compares resource identities, not name coincidences: a
 * deployment value equal to the IAM test deployment's service, origin or host,
 * Cloud SQL instance, schema, runtime identity or bucket is refused in any
 * setting (testTargetIdentities). The repository's conventional database
 * names and the test project and region are not identities and are accepted;
 * the test instances themselves are still refused by name.
 *
 * One Cloud SQL PostgreSQL 17 instance, no deletion ledger (append-only
 * decision record 2026-09-26, D2 and D4; SIMP-0 item 7): every service pool
 * opens the primary instance, and the configuration names only that
 * instance, its database and schema. The retired ledger and erasure-era
 * bucket-history settings (LEDGER_INSTANCE_CONNECTION_NAME, LEDGER_DATABASE,
 * LEDGER_SCHEMA, any other LEDGER_ name and GCS_ERASURE_BUCKET_HISTORY_PROOF)
 * are refused when present, even empty, so a deployment rendered from a
 * stale template fails closed instead of being silently ignored.
 *
 * Owner decision OD-2 (2026-10-02) re-admits the quarantine bucket's birth
 * proof under its own name, GCS_QUARANTINE_BUCKET_HISTORY_PROOF: every profile
 * that names GCS_BUCKET_NAME requires it, as the OPS-2 bucket-birth receipt's
 * proof record for exactly that bucket (closed keys, decimal generations,
 * soft delete "0"), and returns it as resources.bucketHistoryProof. The
 * quarantine store needs it on a bucket with soft delete disabled. This
 * validator (parseQuarantineBucketHistoryProof) is the one OD-2 grammar: the
 * test host and the maintenance Job read the proof through it, and the
 * store's own parser was removed (D-CRB). The Cloudflare
 * DELETION_LEDGER binding and the production deletion-ledger D1 name stay in
 * the absent-key and fingerprint lists: that is cutover hygiene, not a GCP
 * resource.
 *
 * Staging is synthetic-only by default: it runs the closed admission posture
 * of the checked-in staging Worker (STAGING_CONTAINMENT_VARS and
 * STAGING_ORIGIN_TIER_RATE_LIMITS, pinned to wrangler.jsonc env.staging by the
 * repo drift check) and never declares external participants authorized.
 * STAGING_ADMISSION_MODE='synthetic-rehearsal' opens only accountless
 * admission, as the owner-reviewed staging rehearsal override does. No
 * setting admits real clients to staging; that needs an owner decision first.
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
 * Live settings: production (Worker version 152, recorded on 2026-09-24 in
 * docs/plans/2026-09-24-gcp-source-integration.md, "Observed production
 * boundary") runs typed telemetry although the checked-in wrangler.jsonc
 * still says json. PRODUCTION_VARS pins 'typed', and
 * production-live-settings.receipt.json records that override, the
 * checked-in value it replaces and the observation's provenance (recording
 * date, Worker version and version id), so the repo drift check
 * (scripts/cloud-run-production-configuration.check.mjs) can compare
 * everything else with wrangler.jsonc env.production. The receipt is
 * point-in-time evidence: re-observing live production is a deliberate
 * receipt change.
 */

import {
  canonicalRunAppOrigin,
  isEdgeOriginAudience,
  isEdgeServiceAccountEmail,
} from "../src/edge-origin-contract.ts";
import { assertPostgresScheduledMaintenanceEnabled } from "./postgres-maintenance-gate.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./cloud-run-iam-test-target.mjs";

// ---------------------------------------------------------------------------
// Frozen production constants

export const PRODUCTION_PUBLIC_ORIGIN = "https://tibotattle.com";
export const PRODUCTION_ADMIN_ORIGIN = "https://admin.tibotattle.com";
export const PRODUCTION_WWW_HOST = "www.tibotattle.com";

/**
 * PostgreSQL pool sizes for one service instance. `readiness` is the size of
 * the dedicated readiness pool on the one Cloud SQL instance.
 */
export const PRODUCTION_POOL_SIZES = Object.freeze({
  data: 3,
  admission: 4,
  readiness: 1,
});

/**
 * The PostgreSQL application_name each service pool sets (the production
 * host's createIamPool calls). The OPS-4 runtime probe classifies sessions by
 * these names (cloud-run/ops-probe-contract.mjs OPS_APPLICATION_CLASSES maps
 * each to "origin"), so a renamed pool must change both; the probe check pins
 * them equal.
 */
export const PRODUCTION_POOL_APPLICATION_NAMES = Object.freeze({
  data: "tibotattle-origin-data",
  admission: "tibotattle-origin-admission",
  readiness: "tibotattle-origin-readiness",
});

/** The Cloud SQL instance each service pool opens: always the one primary. */
export const PRODUCTION_POOL_INSTANCES = Object.freeze({
  data: Object.freeze(["primary"]),
  admission: Object.freeze(["primary"]),
  readiness: Object.freeze(["primary"]),
});

/**
 * The most connections one service instance holds on the Cloud SQL instance
 * (primary: data + admission + readiness). The infrastructure connection
 * budget multiplies this by the instance count.
 */
export const PRODUCTION_POOL_CONNECTIONS_PER_INSTANCE = Object.freeze(
  Object.entries(PRODUCTION_POOL_INSTANCES).reduce((budget, [pool, instances]) => {
    for (const instance of instances) {
      budget[instance] = (budget[instance] ?? 0) + PRODUCTION_POOL_SIZES[pool];
    }
    return budget;
  }, {}),
);

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
 * are never instantiated as PostgreSQL limiters. createProductionWorkerEnv
 * accepts only edge replay bindings for them: frozen plain objects whose one
 * own property is the limit() method (EP-6 createEdgeAdmissionLimiters).
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

/**
 * The staging plane's origin-tier limits: the checked-in staging Worker's
 * values (wrangler.jsonc env.staging, pinned by the repo drift check).
 */
export const STAGING_ORIGIN_TIER_RATE_LIMITS = Object.freeze({
  UPLOAD_AUTHORIZATION: Object.freeze({
    binding: "UPLOAD_AUTHORIZATION_RATE_LIMIT",
    limit: 300,
    periodSeconds: 60,
  }),
  UPLOAD_PRINCIPAL: Object.freeze({
    binding: "UPLOAD_PRINCIPAL_RATE_LIMIT",
    limit: 6,
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

const SERVICE_SECRETS = Object.freeze({
  required: REQUIRED_SECRET_NAMES,
  optional: OPTIONAL_SECRET_NAMES,
});
const NO_SECRETS = Object.freeze({ required: Object.freeze([]), optional: Object.freeze([]) });

/**
 * The secrets each profile consumes; any other REQUIRED/OPTIONAL secret
 * present in a profile's environment is refused. The service reads all of
 * them. Scheduled maintenance reads IDENTITY_LINK_SECRET (backend lifecycle
 * and restore replay) and, in production only, the GitHub distribution sync
 * token. The analytics lanes read none.
 */
export const PRODUCTION_PROFILE_SECRET_NAMES = Object.freeze({
  production: SERVICE_SECRETS,
  staging: SERVICE_SECRETS,
  "maintenance-job": Object.freeze({
    required: Object.freeze(["IDENTITY_LINK_SECRET"]),
    optional: Object.freeze(["DISTRIBUTION_GITHUB_API_TOKEN"]),
  }),
  "analytics-job": NO_SECRETS,
  "staging-maintenance-job": Object.freeze({
    required: Object.freeze(["IDENTITY_LINK_SECRET"]),
    optional: Object.freeze([]),
  }),
  "staging-analytics-job": NO_SECRETS,
});

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
  // Both OAuth clients: each is the audience its id_tokens are verified against.
  googleOidcClientId: PRODUCTION_VARS.GOOGLE_OIDC_CLIENT_ID,
  appleServicesId: PRODUCTION_VARS.APPLE_SERVICES_ID,
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
  // Retired with the deletion ledger (decisions D2 and D4): one instance only.
  LEDGER_INSTANCE_CONNECTION_NAME: "LEDGER_INSTANCE_CONNECTION_NAME_FORBIDDEN",
  LEDGER_DATABASE: "LEDGER_DATABASE_FORBIDDEN",
  LEDGER_SCHEMA: "LEDGER_SCHEMA_FORBIDDEN",
  GCS_ERASURE_BUCKET_HISTORY_PROOF: "GCS_ERASURE_BUCKET_HISTORY_PROOF_FORBIDDEN",
});
export const PRODUCTION_FORBIDDEN_VARIABLE_PREFIXES = Object.freeze({
  HOST_RATE_LIMIT_: "HOST_RATE_LIMIT_OVERRIDE_FORBIDDEN",
  LEDGER_: "LEDGER_CONFIGURATION_FORBIDDEN",
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
  "staging-maintenance-job",
  "staging-analytics-job",
]);

/** Each profile's plane, workload kind and job. */
const PROFILE_SHAPES = Object.freeze({
  production: Object.freeze({ plane: "production", workload: "service", job: null }),
  staging: Object.freeze({ plane: "staging", workload: "service", job: null }),
  "maintenance-job": Object.freeze({ plane: "production", workload: "job", job: "maintenance" }),
  "analytics-job": Object.freeze({ plane: "production", workload: "job", job: "analytics" }),
  "staging-maintenance-job": Object.freeze({ plane: "staging", workload: "job", job: "maintenance" }),
  "staging-analytics-job": Object.freeze({ plane: "staging", workload: "job", job: "analytics" }),
});

const MAINTENANCE_SWITCH_NAMES = Object.freeze(["POSTGRES_SCHEDULED_MAINTENANCE_ENABLED"]);
const ANALYTICS_SWITCH_NAMES = Object.freeze([
  "POSTGRES_ANALYTICS_MODE",
  "POSTGRES_ANALYTICS_PUBLICATION_LANE",
  "POSTGRES_ANALYTICS_PUBLICATION_EXTERNAL",
]);

/** Job switches, by profile (see readJobSwitches for their semantics). */
export const PRODUCTION_JOB_SWITCH_NAMES = Object.freeze({
  "maintenance-job": MAINTENANCE_SWITCH_NAMES,
  "analytics-job": ANALYTICS_SWITCH_NAMES,
  "staging-maintenance-job": MAINTENANCE_SWITCH_NAMES,
  "staging-analytics-job": ANALYTICS_SWITCH_NAMES,
});

/**
 * The staging plane's admission posture, overriding PRODUCTION_VARS: the
 * checked-in staging Worker's closed values (wrangler.jsonc env.staging,
 * pinned by the repo drift check). Staging also never carries
 * STAGING_ABSENT_VAR_NAMES, so its health surface declares no external
 * participants.
 */
export const STAGING_CONTAINMENT_VARS = Object.freeze({
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
export const STAGING_ABSENT_VAR_NAMES = Object.freeze(["INCREMENTAL_EXTERNAL_PARTICIPANTS"]);

/**
 * The staging service's STAGING_ADMISSION_MODE values and the vars each one
 * sets over the closed posture. Unset means 'closed'. 'synthetic-rehearsal'
 * is the owner-reviewed staging rehearsal override
 * (scripts/accountless-staging-rehearsal-plan.mjs): accountless admission
 * only, public enrollment stays disabled. Every other profile refuses the
 * setting.
 */
export const STAGING_ADMISSION_MODES = Object.freeze({
  closed: Object.freeze({}),
  "synthetic-rehearsal": Object.freeze({
    ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
    ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
  }),
});

/**
 * The staging plane (service and jobs) supplies its own identity-bound vars,
 * with ADMIN_HOST_ORIGIN = admin.<PUBLIC_ORIGIN hostname>; its admission
 * posture is STAGING_CONTAINMENT_VARS; every other var is production's.
 */
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

const ALL_SECRET_NAMES = Object.freeze([...REQUIRED_SECRET_NAMES, ...OPTIONAL_SECRET_NAMES]);
const ADMIN_HOST_PREFIX = "admin.";
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
// OD-2: the one grammar of the quarantine bucket's birth proof (D-CRB removed
// the second copy from src/gcs-quarantine-object-store.ts). Its values are
// the ones createGcsErasureBucketHistoryProof accepts, which the store
// re-validates; the configuration check pins the two equal.
export const QUARANTINE_BUCKET_HISTORY_PROOF_SETTING = "GCS_QUARANTINE_BUCKET_HISTORY_PROOF";
const BUCKET_HISTORY_PROOF_KEYS = Object.freeze([
  "bucket", "bucketGeneration", "bucketMetageneration", "softDeleteRetentionDurationSeconds",
]);
const BUCKET_HISTORY_PROOF_MAX_BYTES = 1_024;
const BUCKET_GENERATION_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;
const MAX_BUCKET_GENERATION = 9_223_372_036_854_775_807n;
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
// At most 64 + 1 + 189 = 254 characters, the longest usable address.
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
    /** A present value exactly as given (an empty string included), else undefined. */
    raw: (name) => (has(name) ? processEnv[name] : undefined),
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

/**
 * OD-2: the quarantine bucket's birth proof for exactly `bucket`, frozen.
 * The value never reaches an error.
 */
function quarantineBucketHistoryProof(environment, bucket) {
  return parseQuarantineBucketHistoryProof(environment.required(QUARANTINE_BUCKET_HISTORY_PROOF_SETTING), bucket);
}

/**
 * OD-2: parse one GCS_QUARANTINE_BUCKET_HISTORY_PROOF value for exactly
 * `bucket`: the OPS-2 bucket-birth receipt's closed four-key proof record
 * (decimal generations from 1, soft delete "0"), at most 1 KiB of JSON. The
 * production profiles read it through resources.bucketHistoryProof, and the
 * private test host (server.mjs) parses its own setting here, so the origin
 * has one proof grammar. Throws GCS_QUARANTINE_BUCKET_HISTORY_PROOF_INVALID
 * for anything else; the value never reaches the error.
 */
export function parseQuarantineBucketHistoryProof(raw, bucket) {
  const code = `${QUARANTINE_BUCKET_HISTORY_PROOF_SETTING}_INVALID`;
  if (typeof raw !== "string" || raw === "" || typeof bucket !== "string" || !BUCKET_PATTERN.test(bucket)
      || new TextEncoder().encode(raw).byteLength > BUCKET_HISTORY_PROOF_MAX_BYTES) {
    configurationError(code);
  }
  let value;
  try { value = JSON.parse(raw); } catch { configurationError(code); }
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== BUCKET_HISTORY_PROOF_KEYS.join(",")
      || value.bucket !== bucket
      || value.softDeleteRetentionDurationSeconds !== "0") {
    configurationError(code);
  }
  for (const name of ["bucketGeneration", "bucketMetageneration"]) {
    const generation = value[name];
    if (typeof generation !== "string" || !BUCKET_GENERATION_PATTERN.test(generation)
        || BigInt(generation) < 1n || BigInt(generation) > MAX_BUCKET_GENERATION) {
      configurationError(code);
    }
  }
  return Object.freeze({
    bucket,
    bucketGeneration: value.bucketGeneration,
    bucketMetageneration: value.bucketMetageneration,
    softDeleteRetentionDurationSeconds: "0",
  });
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

/**
 * The IAM test deployment's resource identities: its service, origin, Cloud
 * SQL instances, schemas, runtime identity and bucket. Each is a distinctive
 * name, so a deployment value equal to any of them, in any setting, reuses
 * the test deployment. The test estate still has a second (ledger) instance
 * and schema; production never configures one, but they stay identities, so
 * the primary settings can never name them either. Two kinds of
 * CLOUD_RUN_IAM_TEST_TARGET value are deliberately not identities:
 * - database names ('tibotattle', 'tibotattle_ledger') are scoped to their
 *   instance, and the test instances are refused by name; the same names on
 *   another instance are the repository's conventional names;
 * - the project and region (and the listen address) are shared locations. A
 *   new resource in the test project is a distinct resource; whether
 *   production shares that project is an owner layout decision (the
 *   infrastructure plan recommends separate projects).
 */
function testTargetIdentities() {
  const target = CLOUD_RUN_IAM_TEST_TARGET;
  const { primary, ledger, iamUser } = target.postgres;
  return new Set([
    target.service,
    target.origin,
    new URL(target.origin).host,
    primary.instanceConnectionName,
    ledger.instanceConnectionName,
    primary.schema,
    ledger.schema,
    iamUser,
    `${iamUser}.gserviceaccount.com`,
    target.gcsBucket,
  ]);
}
const TEST_TARGET_VALUES = testTargetIdentities();

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

/**
 * Validates the profile's secrets by name and refuses every other secret the
 * profile does not consume; values never leave through an error.
 */
function readSecrets(environment, profile) {
  const { required, optional } = PRODUCTION_PROFILE_SECRET_NAMES[profile];
  for (const name of ALL_SECRET_NAMES) {
    if (!required.includes(name) && !optional.includes(name) && environment.has(name)) {
      configurationError(`${name}_PROFILE_FORBIDDEN`);
    }
  }
  const values = new Map();
  for (const name of required) {
    const value = environment.required(name);
    if (secretBytes(value) > MAX_SECRET_BYTES) configurationError(`${name}_INVALID`);
    values.set(name, value);
  }
  if (values.has("IDENTITY_LINK_SECRET")
      && values.get("IDENTITY_LINK_SECRET").length < MIN_IDENTITY_LINK_SECRET_LENGTH) {
    configurationError("IDENTITY_LINK_SECRET_INVALID");
  }
  if (values.has("POSTGRES_RATE_LIMIT_SECRET")
      && secretBytes(values.get("POSTGRES_RATE_LIMIT_SECRET")) < MIN_RATE_LIMIT_SECRET_BYTES) {
    configurationError("POSTGRES_RATE_LIMIT_SECRET_INVALID");
  }
  // The envelope pair and the Apple key are service secrets, always together.
  let envelopeKeyId = null;
  if (values.has("ENVELOPE_PUBLIC_JWK")) {
    const publicJwk = parseJwk(values.get("ENVELOPE_PUBLIC_JWK"), "ENVELOPE_PUBLIC_JWK_INVALID");
    if (publicJwk.d !== undefined) configurationError("ENVELOPE_PUBLIC_JWK_INVALID");
    const privateJwk = parseJwk(values.get("ENVELOPE_PRIVATE_JWK"), "ENVELOPE_PRIVATE_JWK_INVALID");
    if (typeof privateJwk.d !== "string") configurationError("ENVELOPE_PRIVATE_JWK_INVALID");
    if (privateJwk.kid !== publicJwk.kid) configurationError("ENVELOPE_KEY_ID_MISMATCH");
    envelopeKeyId = publicJwk.kid;
  }
  // Secret stores commonly flatten the .p8 newlines to backslash-n.
  if (values.has("APPLE_PRIVATE_KEY")
      && !PKCS8_PEM_PATTERN.test(values.get("APPLE_PRIVATE_KEY").replaceAll("\\n", "\n"))) {
    configurationError("APPLE_PRIVATE_KEY_INVALID");
  }
  for (const name of optional) {
    const value = environment.value(name);
    if (value === undefined) continue;
    if (secretBytes(value) > MAX_SECRET_BYTES) configurationError(`${name}_INVALID`);
    values.set(name, value);
  }
  const handles = {};
  for (const [name, value] of values) handles[name] = secretHandle(name, value);
  return { handles: Object.freeze(handles), envelopeKeyId };
}

/**
 * An analytics job switch, read as the Worker reads its counterpart
 * (storage-analytics-worker.ts, storage-publication-worker.ts):
 * - POSTGRES_ANALYTICS_MODE (STORAGE_ANALYTICS_MODE): unset or 'disabled' is
 *   off, 'enabled' is on, and anything else, an empty value included, is a
 *   configuration error.
 * - the publication lane switches (PUBLICATION_LANE, PUBLICATION_LANE_EXTERNAL):
 *   exactly 'enabled' is on and every other value, unset included, is off, as
 *   the Worker's `=== 'enabled'` reads them. A value such as 'true' is never
 *   a configuration error: it leaves the lane as unset would and never stops
 *   the job's other lanes (delivery and its erasure step among them).
 * The configuration and env carry the normalized 'enabled' or 'disabled'.
 */
function analyticsSwitch(environment, name) {
  if (name !== "POSTGRES_ANALYTICS_MODE") {
    return environment.raw(name) === "enabled" ? "enabled" : "disabled";
  }
  if (!environment.has(name)) return "disabled";
  const value = environment.raw(name);
  if (!SWITCH_VALUES.has(value)) configurationError(`${name}_INVALID`);
  return value;
}

function readJobSwitches(environment, job) {
  if (job === "maintenance") {
    // The existing gate: anything but 'enabled' keeps the writer dormant.
    const probe = Object.freeze({
      POSTGRES_SCHEDULED_MAINTENANCE_ENABLED:
        environment.value("POSTGRES_SCHEDULED_MAINTENANCE_ENABLED"),
    });
    assertPostgresScheduledMaintenanceEnabled(probe);
    return Object.freeze({ POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled" });
  }
  if (job === "analytics") {
    return Object.freeze(Object.fromEntries(ANALYTICS_SWITCH_NAMES
      .map((name) => [name, analyticsSwitch(environment, name)])));
  }
  return Object.freeze({});
}

/** The staging service's admission mode; null for every other profile. */
function readStagingAdmissionMode(environment, profile) {
  if (profile !== "staging") {
    if (environment.has("STAGING_ADMISSION_MODE")) {
      configurationError("STAGING_ADMISSION_MODE_FORBIDDEN");
    }
    return null;
  }
  if (!environment.has("STAGING_ADMISSION_MODE")) return "closed";
  const value = environment.raw("STAGING_ADMISSION_MODE");
  if (typeof value !== "string" || !Object.hasOwn(STAGING_ADMISSION_MODES, value)) {
    configurationError("STAGING_ADMISSION_MODE_INVALID");
  }
  return value;
}

/** Production's pinned vars, or the staging plane's closed variant of them. */
function planeVars(plane, stagingVars, origins, admissionMode) {
  if (plane === "production") return PRODUCTION_VARS;
  const vars = { ...PRODUCTION_VARS };
  for (const name of STAGING_ABSENT_VAR_NAMES) delete vars[name];
  return {
    ...vars,
    ...STAGING_CONTAINMENT_VARS,
    ...STAGING_ADMISSION_MODES[admissionMode ?? "closed"],
    ...stagingVars,
    ENVIRONMENT: "staging",
    PUBLIC_ORIGIN: origins.public,
  };
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
  return vars;
}

/**
 * Production origins are constants; a production job takes them as given.
 * The staging plane (service and jobs) supplies its public origin and the
 * admin origin, which must be admin.<public hostname>: the host the Worker
 * (adminHostname) and the edge dispatcher derive from PUBLIC_ORIGIN. Only a
 * service has a HOST_ORIGIN.
 */
function readOrigins(environment, shape) {
  let host = null;
  if (shape.workload === "service") {
    host = canonicalRunAppOrigin(environment.required("HOST_ORIGIN"));
    if (host === null) configurationError("HOST_ORIGIN_INVALID");
  }
  if (shape.plane === "production") {
    if (shape.workload === "service") {
      if (environment.required("PUBLIC_ORIGIN") !== PRODUCTION_PUBLIC_ORIGIN) {
        configurationError("PUBLIC_ORIGIN_INVALID");
      }
      if (environment.has("ADMIN_HOST_ORIGIN")
          && environment.value("ADMIN_HOST_ORIGIN") !== PRODUCTION_ADMIN_ORIGIN) {
        configurationError("ADMIN_HOST_ORIGIN_INVALID");
      }
    }
    return Object.freeze({
      public: PRODUCTION_PUBLIC_ORIGIN,
      admin: PRODUCTION_ADMIN_ORIGIN,
      wwwHost: PRODUCTION_WWW_HOST,
      host,
    });
  }
  const publicOrigin = canonicalHttpsOrigin(environment.required("PUBLIC_ORIGIN"));
  if (publicOrigin === null || publicOrigin === host
      || new URL(publicOrigin).hostname.startsWith(ADMIN_HOST_PREFIX)) {
    configurationError("PUBLIC_ORIGIN_INVALID");
  }
  const adminOrigin = canonicalHttpsOrigin(environment.required("ADMIN_HOST_ORIGIN"));
  if (adminOrigin === null
      || adminOrigin !== `https://${ADMIN_HOST_PREFIX}${new URL(publicOrigin).hostname}`) {
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
function assertPlaneSeparation(plane, planeNames, stagingValues) {
  if (plane === "staging") {
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
 * configuration. `profile` is one of PRODUCTION_CONFIGURATION_PROFILES:
 * 'production' or 'staging' for the service, 'maintenance-job' /
 * 'analytics-job' for the production jobs and 'staging-maintenance-job' /
 * 'staging-analytics-job' for the staging plane's jobs. Throws an Error whose
 * message and `code` name the first refused setting.
 */
export function readProductionConfiguration(processEnv, profile) {
  if (!PRODUCTION_CONFIGURATION_PROFILES.includes(profile)) {
    configurationError("PRODUCTION_PROFILE_INVALID");
  }
  const shape = PROFILE_SHAPES[profile];
  const environment = readEnvironment(processEnv);
  assertNoForbiddenVariables(environment);
  const service = shape.workload === "service";
  const admissionMode = readStagingAdmissionMode(environment, profile);

  const sourceCommit = matching(environment, "DEPLOYMENT_SOURCE_COMMIT", SOURCE_COMMIT_PATTERN);
  const workloadVariable = service ? "K_SERVICE" : "CLOUD_RUN_JOB";
  const workload = Object.freeze({
    kind: shape.workload,
    name: matching(environment, workloadVariable, CLOUD_RUN_NAME_PATTERN),
  });
  const origins = readOrigins(environment, shape);
  const edge = service ? readEdge(environment) : null;
  const namespace = matching(
    environment, "TELEMETRY_STORAGE_NAMESPACE", TELEMETRY_STORAGE_NAMESPACE_PATTERN,
  );

  const primary = databaseResource(environment, "primary");
  const rawIamUser = environment.required("POSTGRES_IAM_USER");
  const iamUser = iamDatabaseUser(rawIamUser);
  const bucket = matching(environment, "GCS_BUCKET_NAME", BUCKET_PATTERN);

  // Database names are scoped to their instance, so they are not listed.
  const deploymentValues = [
    [workloadVariable, workload.name],
    ["TELEMETRY_STORAGE_NAMESPACE", namespace],
    ["PRIMARY_INSTANCE_CONNECTION_NAME", primary.instanceConnectionName],
    ["PRIMARY_SCHEMA", primary.schema],
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
  if (shape.plane === "staging") {
    deploymentValues.push(
      ["PUBLIC_ORIGIN", origins.public],
      ["PUBLIC_ORIGIN", new URL(origins.public).host],
      ["ADMIN_HOST_ORIGIN", origins.admin],
      ["ADMIN_HOST_ORIGIN", new URL(origins.admin).host],
    );
  }
  assertNotTestTarget(deploymentValues);

  const stagingVars = shape.plane === "staging" ? readStagingVars(environment) : null;
  const secrets = readSecrets(environment, profile);
  const envelopeKeyId = secrets.envelopeKeyId === null
    ? []
    : [["ENVELOPE_KEY_ID", secrets.envelopeKeyId]];
  const planeNames = [
    [workloadVariable, workload.name],
    ["PRIMARY_INSTANCE_CONNECTION_NAME", primary.instanceConnectionName],
    ["GCS_BUCKET_NAME", bucket],
    ...envelopeKeyId,
  ];
  const stagingValues = stagingVars === null ? [] : [
    ...deploymentValues,
    ...Object.entries(stagingVars),
    ...envelopeKeyId,
  ];
  assertPlaneSeparation(shape.plane, planeNames, stagingValues);
  // Read after the bucket passed the test-target and plane checks, so a
  // refused bucket reports its own code rather than a proof mismatch.
  const bucketHistoryProof = quarantineBucketHistoryProof(environment, bucket);

  const jobSwitches = readJobSwitches(environment, shape.job);
  const vars = Object.freeze({
    ...planeVars(shape.plane, stagingVars, origins, admissionMode),
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
    plane: shape.plane,
    environment: vars.ENVIRONMENT,
    stagingAdmissionMode: admissionMode,
    deployment: Object.freeze({ sourceCommit, workload }),
    origins,
    edge,
    vars,
    jobSwitches,
    secrets: secrets.handles,
    resources: Object.freeze({
      primary,
      iamUser,
      bucket,
      bucketHistoryProof,
    }),
    poolSizes: PRODUCTION_POOL_SIZES,
    admissionTimeouts: PRODUCTION_ADMISSION_TIMEOUTS,
    rateLimits: Object.freeze({
      edgeTier: EDGE_TIER_RATE_LIMIT_NAMES,
      originTier: shape.plane === "staging"
        ? STAGING_ORIGIN_TIER_RATE_LIMITS
        : ORIGIN_TIER_RATE_LIMITS,
    }),
    workerEnvKeys,
  });
  CONFIGURATIONS.add(configuration);
  return configuration;
}

/**
 * True only for a configuration readProductionConfiguration issued. A frozen
 * copy, a lookalike with the same keys and values, or any other value is
 * false: the PostgreSQL route families admit the production origins only on
 * this provenance (D-CRB, wave-3 host brief B2(a)).
 */
export function isProductionConfiguration(value) {
  return value !== null && typeof value === "object" && CONFIGURATIONS.has(value);
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
  const originTier = new Map(Object.values(configuration.rateLimits.originTier)
    .map((limits) => [limits.binding, limits]));
  return PRODUCTION_WORKER_BINDING_NAMES.map((name) => {
    if (!Object.prototype.hasOwnProperty.call(bindings, name) || bindings[name] === undefined) {
      configurationError(`${name}_BINDING_MISSING`);
    }
    const binding = bindings[name];
    const method = name === UPLOAD_INGRESS_BUDGET_BINDING ? "getByName" : "limit";
    if (binding === null || typeof binding !== "object" || typeof binding[method] !== "function") {
      configurationError(`${name}_BINDING_INVALID`);
    }
    if (EDGE_TIER_RATE_LIMIT_BINDINGS.includes(name) && !isEdgeReplayBinding(binding)) {
      configurationError(`${name}_BINDING_NOT_EDGE_REPLAY`);
    }
    // An origin-tier limiter carries its plane's frozen limit and period, as
    // PostgresRateLimiter exposes them (limitValue, periodSeconds).
    const limits = originTier.get(name);
    if (limits !== undefined && (binding.limitValue !== limits.limit
        || binding.periodSeconds !== limits.periodSeconds)) {
      configurationError(`${name}_BINDING_LIMIT_MISMATCH`);
    }
    return [name, binding];
  });
}

/**
 * An edge-tier binding replays the edge's outcome; it is never a PostgreSQL
 * limiter. The replay bindings (EP-6 createEdgeAdmissionLimiters) are frozen
 * plain objects whose only own property is a limit() data method. A class
 * instance such as PostgresRateLimiter (limit() on its prototype, its pool,
 * name and limits as own fields) or any other object is refused.
 */
function isEdgeReplayBinding(binding) {
  if (!Object.isFrozen(binding)) return false;
  const prototype = Object.getPrototypeOf(binding);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(binding);
  if (keys.length !== 1 || keys[0] !== "limit") return false;
  return typeof Reflect.getOwnPropertyDescriptor(binding, "limit").value === "function";
}

/**
 * Builds the frozen Worker-shaped env from a configuration returned by
 * readProductionConfiguration. Service profiles must inject exactly the six
 * edge-tier replay bindings, the two origin-tier limiters and
 * UPLOAD_INGRESS_BUDGET; job profiles take no bindings. Each origin-tier
 * limiter must be built with configuration.rateLimits.originTier (production
 * or staging, by plane): its limitValue and periodSeconds are compared with
 * them, and a mismatch is refused with <NAME>_BINDING_LIMIT_MISMATCH. The env
 * holds only named keys (configuration.workerEnvKeys) and has a null
 * prototype.
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
