/**
 * POSTGRES_TEST_HTTP_MODE=fastpath-test (GCP fast path, IN-1).
 *
 * A local-only origin mode for the fast-path rehearsal. server.mjs composes
 * it exactly like health-and-v12-day-manifest: it listens on 127.0.0.1 with
 * an http://127.0.0.1 origin (privatePostgresTestHostConfiguration refuses
 * anything else), serves every PostgreSQL test route except the Google
 * identity routes, and takes no public or admin origin. On top of that it:
 *
 * - takes a configurable rehearsal schema: PRIMARY_SCHEMA must start with one
 *   of FASTPATH_TEST_SCHEMA_PREFIXES, and the ledger is the "<schema>_ledger"
 *   schema, which may live on the primary instance and database (the ledger
 *   instance, database and schema default to the primary's). The one
 *   explicit alternative is the GCP fast-path database's pinned ledger
 *   schema (FASTPATH_TEST_CLOUD_TARGET.ledgerSchema, created by the fastpath
 *   migrate Job), paired with a primary in the same database;
 * - may run as the GCP fast-path test origin (K_SERVICE set): still on
 *   127.0.0.1 behind the test edge sidecar, and only as
 *   FASTPATH_TEST_CLOUD_TARGET's service, instance, database
 *   (tibotattle_fastpath, never the shared test database) and runtime user;
 * - mounts the analytics-v2 GET /api/v1/community/daily route module, which
 *   overrides the built-in, when ANALYTICS_V2_ENABLED=1;
 * - accepts ANALYTICS_V2_TEST_NOW_MS, the route's injected test clock (a
 *   rehearsal pins the oracle's nowMs); any other mode refuses it.
 *
 * Nothing here opens a pool or reads the network. server.mjs passes the
 * environment and, for the route module, the factory and optional test clock.
 * Plain JavaScript so node:test specs can load it directly.
 */

import { defineOriginRouteModule } from "./origin-route-modules.mjs";

export const FASTPATH_TEST_MODE = "fastpath-test";

/** Rehearsal schema prefixes a fastpath-test origin may serve. */
export const FASTPATH_TEST_SCHEMA_PREFIXES = Object.freeze([
  "typed_legacy_transfer_rehearsal_target_",
  "tibotattle_fastpath_",
]);

/**
 * The GCP fast-path test resources (D-1, scripts/gcp-fastpath-test-deploy.mjs
 * FASTPATH_TEST, which a check pins equal): a disposable database on the test
 * primary instance, its pinned migrate-Job schemas, the runtime IAM user, the
 * origin service and the analytics-refresh Job.
 */
export const FASTPATH_TEST_CLOUD_TARGET = Object.freeze({
  project: "tibotattle",
  instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
  database: "tibotattle_fastpath",
  primarySchema: "tibotattle_fastpath_20261001",
  ledgerSchema: "tibotattle_fastpath_ledger_20261001",
  seededSchemaPrefix: "typed_legacy_transfer_rehearsal_target_fastpath_",
  iamUser: "tibotattle-test-runtime@tibotattle.iam",
  originService: "tibotattle-fastpath-test-origin",
  refreshJob: "tibotattle-fastpath-test-analytics-refresh",
});

const LEDGER_SCHEMA_SUFFIX = "_ledger";
const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const ROUTE_MODULE_FIELDS = Object.freeze(["method", "pathname", "overridesBuiltIn", "handler"]);
const EPOCH_MILLISECONDS = /^(?:0|[1-9][0-9]{0,15})$/u;

function configurationError(code) {
  throw Object.assign(new Error(code), { code });
}

function envValue(env, name) {
  const value = env?.[name];
  return value === undefined || value === "" ? undefined : value;
}

function requiredEnv(env, name) {
  const value = envValue(env, name);
  if (value === undefined) configurationError(`${name}_MISSING`);
  return value;
}

/**
 * True when schema is a rehearsal schema a fastpath-test origin may serve:
 * a plain lower-case identifier with an allowed prefix and a non-empty
 * suffix, short enough that "<schema>_ledger" is also an identifier.
 *
 * @param {unknown} schema
 */
export function isFastpathTestSchema(schema) {
  return typeof schema === "string"
    && SCHEMA_IDENTIFIER.test(schema)
    && SCHEMA_IDENTIFIER.test(schema + LEDGER_SCHEMA_SUFFIX)
    && FASTPATH_TEST_SCHEMA_PREFIXES.some((prefix) =>
      schema.startsWith(prefix) && schema.length > prefix.length);
}

/**
 * The fastpath-test database configuration, in the shape server.mjs's
 * databaseConfig() returns. Throws POSTGRES_FASTPATH_TEST_SCHEMA_INVALID for
 * a primary schema outside the rehearsal prefixes or a ledger schema other
 * than "<schema>_ledger"; never opens a connection.
 *
 * @param {Readonly<Record<string, string | undefined>>} env
 */
export function fastpathTestDatabaseConfig(env) {
  const primarySchema = envValue(env, "PRIMARY_SCHEMA");
  if (!isFastpathTestSchema(primarySchema)) {
    configurationError("POSTGRES_FASTPATH_TEST_SCHEMA_INVALID");
  }
  const primaryDatabase = requiredEnv(env, "PRIMARY_DATABASE");
  const primaryInstance = requiredEnv(env, "PRIMARY_INSTANCE_CONNECTION_NAME");
  const ledgerDatabase = envValue(env, "LEDGER_DATABASE") ?? primaryDatabase;
  const ledgerInstance = envValue(env, "LEDGER_INSTANCE_CONNECTION_NAME") ?? primaryInstance;
  const ledgerSchema = envValue(env, "LEDGER_SCHEMA") ?? primarySchema + LEDGER_SCHEMA_SUFFIX;
  // The ledger is "<schema>_ledger", or the GCP fast-path database's pinned
  // ledger schema with both roles in that one database.
  const cloud = FASTPATH_TEST_CLOUD_TARGET;
  const pinnedCloudLedger = ledgerSchema === cloud.ledgerSchema && ledgerSchema !== primarySchema
    && primaryDatabase === cloud.database && ledgerDatabase === cloud.database
    && ledgerInstance === primaryInstance;
  if (ledgerSchema !== primarySchema + LEDGER_SCHEMA_SUFFIX && !pinnedCloudLedger) {
    configurationError("POSTGRES_FASTPATH_TEST_SCHEMA_INVALID");
  }
  if (envValue(env, "K_SERVICE") !== undefined) {
    // On Cloud Run: only the fast-path origin service, its disposable
    // database and runtime user, and a pinned or seeded fast-path schema.
    if (env.K_SERVICE !== cloud.originService
        || primaryInstance !== cloud.instanceConnectionName || ledgerInstance !== cloud.instanceConnectionName
        || primaryDatabase !== cloud.database || ledgerDatabase !== cloud.database
        || envValue(env, "POSTGRES_IAM_USER") !== cloud.iamUser
        || !(primarySchema === cloud.primarySchema || primarySchema.startsWith(cloud.seededSchemaPrefix))) {
      configurationError("POSTGRES_FASTPATH_TEST_CLOUD_TARGET_INVALID");
    }
  }
  return {
    primary: {
      role: "primary",
      schema: primarySchema,
      database: primaryDatabase,
      instanceConnectionName: primaryInstance,
      max: 3,
    },
    ledger: {
      role: "ledger",
      schema: ledgerSchema,
      database: ledgerDatabase,
      instanceConnectionName: ledgerInstance,
      max: 2,
    },
  };
}

/**
 * ANALYTICS_V2_ENABLED: "1" mounts the analytics-v2 route module; unset, ""
 * or "0" leaves the built-in route. Anything else stops the origin.
 *
 * @param {Readonly<Record<string, string | undefined>>} env
 */
export function isAnalyticsV2Enabled(env) {
  const value = envValue(env, "ANALYTICS_V2_ENABLED");
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  return configurationError("ANALYTICS_V2_ENABLED_INVALID");
}

/**
 * ANALYTICS_V2_TEST_NOW_MS: the analytics-v2 route's injected clock, as Unix
 * epoch milliseconds. Unset gives null (the route uses Date.now). Only a
 * fastpath-test origin may set it: under any other POSTGRES_TEST_HTTP_MODE,
 * or none, the origin refuses to start rather than serve a pinned clock.
 *
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {string | null | undefined} mode the validated POSTGRES_TEST_HTTP_MODE
 * @returns {(() => number) | null}
 */
export function analyticsV2TestClock(env, mode) {
  const value = envValue(env, "ANALYTICS_V2_TEST_NOW_MS");
  if (value === undefined) return null;
  if (mode !== FASTPATH_TEST_MODE) configurationError("ANALYTICS_V2_TEST_CLOCK_REFUSED");
  const nowMs = EPOCH_MILLISECONDS.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(nowMs)) configurationError("ANALYTICS_V2_CLOCK_INVALID");
  return () => nowMs;
}

/**
 * The route modules a fastpath-test origin mounts. With ANALYTICS_V2_ENABLED=1
 * that is the analytics-v2 community-daily module built by
 * createAnalyticsV2CommunityDailyRoute({ pool, schema, originMode, clock? })
 * (src/analytics-v2/community-daily-route.ts, A-4). The factory is injected
 * by the composition root; when it is missing the origin refuses to start
 * rather than silently serving the built-in. The optional clock is a test
 * seam the factory accepts only in fastpath-test mode.
 *
 * @param {{
 *   env: Readonly<Record<string, string | undefined>>,
 *   primaryPool: unknown,
 *   primarySchema: string,
 *   createAnalyticsV2CommunityDailyRoute?: ((options: object) => unknown) | null,
 *   clock?: (() => number) | null,
 * }} options
 */
export function fastpathTestRouteModules({
  env,
  primaryPool,
  primarySchema,
  createAnalyticsV2CommunityDailyRoute = null,
  clock = null,
}) {
  if (!isAnalyticsV2Enabled(env)) return [];
  if (typeof createAnalyticsV2CommunityDailyRoute !== "function") {
    configurationError("ANALYTICS_V2_COMMUNITY_DAILY_ROUTE_UNAVAILABLE");
  }
  if (clock !== null && typeof clock !== "function") {
    configurationError("ANALYTICS_V2_CLOCK_INVALID");
  }
  const built = createAnalyticsV2CommunityDailyRoute({
    pool: primaryPool,
    schema: primarySchema,
    originMode: FASTPATH_TEST_MODE,
    ...(clock === null ? {} : { clock }),
  });
  if (built === null || typeof built !== "object") {
    configurationError("ANALYTICS_V2_COMMUNITY_DAILY_ROUTE_INVALID");
  }
  // The route-module registry, not this file, decides which paths a module
  // may claim; pass exactly the module fields through defineOriginRouteModule.
  const definition = {};
  for (const field of ROUTE_MODULE_FIELDS) definition[field] = built[field];
  return [defineOriginRouteModule(definition)];
}
