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
 *   instance, database and schema default to the primary's);
 * - mounts the analytics-v2 GET /api/v1/community/daily route module, which
 *   overrides the built-in, when ANALYTICS_V2_ENABLED=1.
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

const LEDGER_SCHEMA_SUFFIX = "_ledger";
const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const ROUTE_MODULE_FIELDS = Object.freeze(["method", "pathname", "overridesBuiltIn", "handler"]);

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
  const ledgerSchema = envValue(env, "LEDGER_SCHEMA") ?? primarySchema + LEDGER_SCHEMA_SUFFIX;
  if (ledgerSchema !== primarySchema + LEDGER_SCHEMA_SUFFIX) {
    configurationError("POSTGRES_FASTPATH_TEST_SCHEMA_INVALID");
  }
  const primaryDatabase = requiredEnv(env, "PRIMARY_DATABASE");
  const primaryInstance = requiredEnv(env, "PRIMARY_INSTANCE_CONNECTION_NAME");
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
      database: envValue(env, "LEDGER_DATABASE") ?? primaryDatabase,
      instanceConnectionName: envValue(env, "LEDGER_INSTANCE_CONNECTION_NAME") ?? primaryInstance,
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
