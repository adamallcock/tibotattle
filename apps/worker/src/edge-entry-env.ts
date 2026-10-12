/**
 * The edge entry's named-key env builders and the release-guard D1 facade.
 *
 * edge-entry.ts imports these and does not re-export them: the deployed main
 * module may export only its default handler and functions or classes
 * (workerd refuses to start a main module with any other named export, such
 * as a string, a RegExp or an array), so the values the specs need live here.
 *
 * Outside worker mode the Worker code never sees the deployed env. It sees a
 * frozen env built from named keys (buildEdgeLocalEnv), never a spread of the
 * deployed env. The Sparkle guard alone also gets USAGE_MONITOR_DB, as a
 * facade over the dedicated RELEASE_GUARD_DB that accepts only SQL naming the
 * nonce table (createReleaseGuardDatabase).
 */
import { isDevelopmentEnvironment } from "./admission";

// ---------------------------------------------------------------------------
// Named-key env builders

/**
 * The only deployed env keys the edge hands to handleRequest outside worker
 * mode: the public origin and environment, the publication switch, the
 * static assets, the admin Access settings, the deployment identity, and the
 * Sparkle guard's settings, token and release bucket. Frozen and sorted.
 */
export const EDGE_LOCAL_ENV_KEYS = Object.freeze([
  "ACCESS_ADMIN_EMAIL",
  "ACCESS_AUD",
  "ACCESS_TEAM_DOMAIN",
  "ASSETS",
  "DEPLOYMENT_SOURCE_COMMIT",
  "ENVIRONMENT",
  "PUBLIC_ANALYTICS_MODE",
  "PUBLIC_ORIGIN",
  "SPARKLE_APPCAST_GUARD_APPCAST_KEY",
  "SPARKLE_APPCAST_GUARD_BUCKET",
  "SPARKLE_APPCAST_GUARD_CACHE_CONTROL",
  "SPARKLE_APPCAST_GUARD_CHANNEL",
  "SPARKLE_APPCAST_GUARD_CONTENT_TYPE",
  "SPARKLE_APPCAST_GUARD_ENDPOINT_PATH",
  "SPARKLE_APPCAST_GUARD_MAX_XML_BYTES",
  "SPARKLE_APPCAST_GUARD_MODE",
  "SPARKLE_APPCAST_GUARD_PUBLIC_ED_KEY",
  "SPARKLE_APPCAST_GUARD_PUBLIC_ED_KEY_SHA256",
  "SPARKLE_APPCAST_GUARD_TOKEN",
  "SPARKLE_RELEASES",
] as const);

export type EdgeLocalEnvKey = (typeof EDGE_LOCAL_ENV_KEYS)[number];

/**
 * admin-access.ts replaces the Access JWKS fetch with this value whenever it
 * is present. The edge passes it on only in a development ENVIRONMENT, so a
 * stray test JWKS on a hosted edge can never stand in for Cloudflare Access.
 */
const EDGE_DEVELOPMENT_ONLY_ENV_KEY = "ACCESS_TEST_JWKS_JSON";

function namedEnvValues(env: Env): Record<string, unknown> {
  const names: string[] = [...EDGE_LOCAL_ENV_KEYS];
  if (isDevelopmentEnvironment(env)) names.push(EDGE_DEVELOPMENT_ONLY_ENV_KEY);
  names.sort();
  const values: Record<string, unknown> = {};
  for (const name of names) {
    const value: unknown = Reflect.get(env, name);
    // An absent and an undefined setting read the same to every handler.
    if (value !== undefined) values[name] = value;
  }
  return values;
}

/**
 * The env handleRequest sees outside worker mode: only EDGE_LOCAL_ENV_KEYS
 * (plus ACCESS_TEST_JWKS_JSON in a development ENVIRONMENT), read one by one
 * by name, present keys only, frozen. The deployed env is never spread.
 */
export function buildEdgeLocalEnv(env: Env): Readonly<Env> {
  return Object.freeze(namedEnvValues(env)) as unknown as Readonly<Env>;
}

/**
 * The Sparkle guard's env: the same named keys, re-read from `localEnv`, plus
 * USAGE_MONITOR_DB as the nonce-only facade over the release guard D1.
 */
export function buildEdgeGuardEnv(
  localEnv: Readonly<Env>,
  releaseGuardDb: D1Database,
): Readonly<Env> {
  return Object.freeze({
    ...namedEnvValues(localEnv),
    USAGE_MONITOR_DB: createReleaseGuardDatabase(releaseGuardDb),
  }) as unknown as Readonly<Env>;
}

// ---------------------------------------------------------------------------
// Release guard D1 facade

export const EDGE_GUARD_DB_STATEMENT_REFUSED = "EDGE_GUARD_DB_STATEMENT_REFUSED";
export const EDGE_GUARD_NONCE_TABLE_PATTERN = /\bsparkle_appcast_guard_nonces\b/u;

function statementRefused(): Error {
  const error = new Error(EDGE_GUARD_DB_STATEMENT_REFUSED);
  Object.defineProperty(error, "code", { value: EDGE_GUARD_DB_STATEMENT_REFUSED, enumerable: true });
  return error;
}

function namesNonceTable(sql: unknown): sql is string {
  return typeof sql === "string" && EDGE_GUARD_NONCE_TABLE_PATTERN.test(sql);
}

/**
 * A D1Database over the release guard D1 that the Sparkle guard can use as
 * its USAGE_MONITOR_DB. prepare and exec run only SQL naming
 * sparkle_appcast_guard_nonces; batch runs only statements this facade
 * prepared (and their bind results); withSession and dump always refuse.
 * Every refusal is an Error whose message and code are
 * EDGE_GUARD_DB_STATEMENT_REFUSED, thrown before the database is touched.
 *
 * The guard's own statements are the nonce DELETE and INSERT. Its catch path's
 * diagnostic INSERT into diagnostic_error_events is refused here and swallowed
 * by recordDiagnosticError's own try/catch, so the release guard D1 never
 * holds anything but nonces.
 */
export function createReleaseGuardDatabase(db: D1Database): D1Database {
  // Facade statement -> the database's own statement. Membership is the
  // "this facade prepared it" check for batch.
  const prepared = new WeakMap<object, D1PreparedStatement>();

  function wrap(statement: D1PreparedStatement): D1PreparedStatement {
    const facadeStatement = Object.freeze({
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: (column?: string) => (column === undefined
        ? statement.first()
        : statement.first(column)),
      run: () => statement.run(),
      all: () => statement.all(),
      raw: (options?: { readonly columnNames?: boolean }) => (options?.columnNames === true
        ? statement.raw({ columnNames: true })
        : statement.raw()),
    });
    prepared.set(facadeStatement, statement);
    return facadeStatement as unknown as D1PreparedStatement;
  }

  const facade: D1Database = {
    prepare(query: string): D1PreparedStatement {
      if (!namesNonceTable(query)) throw statementRefused();
      return wrap(db.prepare(query));
    },
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      if (!Array.isArray(statements)) throw statementRefused();
      const underlying: D1PreparedStatement[] = [];
      for (const statement of statements) {
        const own = typeof statement === "object" && statement !== null
          ? prepared.get(statement)
          : undefined;
        if (own === undefined) throw statementRefused();
        underlying.push(own);
      }
      return db.batch<T>(underlying);
    },
    exec(query: string): Promise<D1ExecResult> {
      if (!namesNonceTable(query)) throw statementRefused();
      return db.exec(query);
    },
    withSession(): D1DatabaseSession {
      throw statementRefused();
    },
    dump(): Promise<ArrayBuffer> {
      throw statementRefused();
    },
  };
  return Object.freeze(facade);
}
