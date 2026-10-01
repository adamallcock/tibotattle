/**
 * Edge Worker entry: EDGE_UPSTREAM_MODE worker | fenced | gcp.
 *
 * The production Worker becomes a thin edge in front of the IAM-private Cloud
 * Run origin in three steps, each a deploy of this module as `main` with a
 * different EDGE_UPSTREAM_MODE:
 *
 * - worker: the unchanged Worker. fetch and scheduled delegate to index.ts's
 *   default export with the original env, so this mode follows whatever that
 *   export does on the line it is built from.
 * - fenced: the cutover fence. Every request goes to handleRequest with the
 *   migration barrier enabled and an env that holds no storage binding, so
 *   only public assets, the www redirect and the storage-free barrier health
 *   answer; every other request is the barrier's 503 MUTATION_BARRIER_ACTIVE,
 *   to which this entry adds retry-after: 300. Scheduled work stops.
 * - gcp: the thin edge (edge-origin-proxy.ts). The edge answers its local
 *   classes and the Sparkle guard itself and forwards everything else to the
 *   origin with an edge-minted Google ID token. Scheduled work stops.
 *
 * An absent, unknown or wrongly cased mode, and a gcp mode whose settings are
 * incomplete or malformed, fail closed: www and assets still serve and every
 * other request is 503 EDGE_NOT_CONFIGURED with retry-after: 60. Nothing is
 * forwarded and no network call is made.
 *
 * Outside worker mode the Worker code never sees the deployed env. It sees a
 * frozen env built from named keys (buildEdgeLocalEnv), never a spread of the
 * deployed env, so the storage bindings (USAGE_MONITOR_DB, ANALYTICS_DB,
 * DELETION_LEDGER, QUARANTINE), the rate-limit bindings, the Durable Object,
 * the EDGE_* secrets and every other Worker secret stay out of its reach. The
 * Sparkle guard alone also gets USAGE_MONITOR_DB, as a facade over the
 * dedicated RELEASE_GUARD_DB that accepts only SQL naming the nonce table
 * (createReleaseGuardDatabase).
 *
 * Logging is one content-free warn line per EDGE_NOT_CONFIGURED response,
 * naming only the code: never which setting failed, a URL, a host or a value.
 *
 * Module surface: everything index.ts exports (so handleRequest and the
 * route helpers stay importable from the deployed main), UploadIngressBudget
 * from ingress-budget.ts (the Durable Object class wrangler must find on the
 * main module) and this entry's own default export. The imports name ./index
 * and ./ingress-budget, never ./cloudflare-entry (which exists only on the GCP
 * line), so the file builds unchanged on the production line too, where
 * index.ts also exports UploadIngressBudget and the explicit export below
 * shadows the star export.
 */
import { isDevelopmentEnvironment } from "./admission";
import { adminHostname, canonicalPublicOrigin, isAdminSurfacePath } from "./admin-ui";
import { JSON_HEADERS } from "./constants";
import type { EdgeAdmissionBinding, EdgeAdmissionLimiters } from "./edge-admission-policy";
import { createGoogleIdTokenSource } from "./edge-google-id-token";
import {
  EDGE_FENCE_RETRY_AFTER_SECONDS,
  EDGE_MIN_CLIENT_KEY_SECRET_LENGTH,
  EDGE_NOT_CONFIGURED,
  EDGE_UNAVAILABLE_RETRY_AFTER_SECONDS,
  parseEdgeOriginConfiguration,
  parseEdgeUpstreamMode,
} from "./edge-origin-contract";
import type { EdgeOriginConfiguration } from "./edge-origin-contract";
import { classifyEdgeRequest, createEdgeOriginProxy } from "./edge-origin-proxy";
import type { EdgeDistributionConfiguration, EdgeOriginProxy } from "./edge-origin-proxy";
import worker, { handleRequest } from "./index";
import { mutationBarrierBlocksDynamicRequest } from "./mutation-barrier";
import { matchWorkerRoute } from "./route-registry";

export * from "./index";
export { UploadIngressBudget } from "./ingress-budget";

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

// ---------------------------------------------------------------------------
// Responses

function notConfigured(): Response {
  console.warn(JSON.stringify({ level: "warn", code: EDGE_NOT_CONFIGURED }));
  return Response.json(
    { error: { code: EDGE_NOT_CONFIGURED, requestId: crypto.randomUUID() } },
    {
      status: 503,
      headers: {
        ...JSON_HEADERS,
        "retry-after": String(EDGE_UNAVAILABLE_RETRY_AFTER_SECONDS),
      },
    },
  );
}

/**
 * The fail-closed mode: www and assets go to handleRequest with the local
 * env, every other request is 503 EDGE_NOT_CONFIGURED.
 */
function notConfiguredFetch(request: Request, localEnv: Readonly<Env>): Promise<Response> {
  const requestClass = classifyEdgeRequest(request, localEnv);
  if (requestClass.kind === "local"
      && (requestClass.reason === "www" || requestClass.reason === "asset")) {
    return handleRequest(request, localEnv);
  }
  return Promise.resolve(notConfigured());
}

// ---------------------------------------------------------------------------
// fenced

async function fencedFetch(request: Request, env: Env): Promise<Response> {
  const fencedEnv = buildEdgeLocalEnv(env);
  const response = await handleRequest(request, fencedEnv, true);
  if (response.status !== 503) return response;
  const url = new URL(request.url);
  const route = matchWorkerRoute(url.pathname);
  // handleRequest's own admin-surface and barrier predicates, on the same env.
  const adminSurface = isAdminSurfacePath(url.pathname)
    || adminHostname(fencedEnv) === url.hostname;
  if (!mutationBarrierBlocksDynamicRequest(route.id, adminSurface, true)) return response;
  // The public barrier health keeps its own 503 (no source commit) as is.
  if (route.id === "health" && request.method === "GET" && !adminSurface) return response;
  const headers = new Headers(response.headers);
  headers.set("retry-after", String(EDGE_FENCE_RETRY_AFTER_SECONDS));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// gcp

interface EdgeGcpSettings {
  readonly config: EdgeOriginConfiguration;
  readonly invokerKeyJson: string;
  readonly clientKeySecret: string;
  readonly releaseGuardDb: D1Database;
  readonly limiters: EdgeAdmissionLimiters;
  readonly distribution: EdgeDistributionConfiguration | null;
}

function isRateLimit(value: unknown): value is RateLimit {
  // admission.ts assertLimiterConfigured's own test.
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "limit") === "function";
}

function isD1Database(value: unknown): value is D1Database {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "prepare") === "function"
    && typeof Reflect.get(value, "batch") === "function";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The six EDGE_ADMISSION_BINDINGS, each read by its literal name. The
 * `satisfies` clause fails the build if EP-1's binding set changes without
 * this list. A missing or malformed binding is a configuration defect, as the
 * Worker's assertAdmissionBindings and assertUploadIngressRateLimitBindings
 * treat it.
 */
function readAdmissionLimiters(env: Env): EdgeAdmissionLimiters | null {
  const limiters = {
    ENROLLMENT_RATE_LIMIT: Reflect.get(env, "ENROLLMENT_RATE_LIMIT"),
    RECOVERY_RATE_LIMIT: Reflect.get(env, "RECOVERY_RATE_LIMIT"),
    CLIENT_ATTEMPT_RATE_LIMIT: Reflect.get(env, "CLIENT_ATTEMPT_RATE_LIMIT"),
    PUBLIC_READ_RATE_LIMIT: Reflect.get(env, "PUBLIC_READ_RATE_LIMIT"),
    UPLOAD_INGRESS_REQUEST_RATE_LIMIT: Reflect.get(env, "UPLOAD_INGRESS_REQUEST_RATE_LIMIT"),
    UPLOAD_INGRESS_CLIENT_RATE_LIMIT: Reflect.get(env, "UPLOAD_INGRESS_CLIENT_RATE_LIMIT"),
  } satisfies Record<EdgeAdmissionBinding, unknown>;
  for (const limiter of Object.values(limiters)) {
    if (!isRateLimit(limiter)) return null;
  }
  return Object.freeze(limiters as Record<EdgeAdmissionBinding, RateLimit>);
}

/**
 * Distribution analytics are merged only where the Worker itself reads them:
 * a production ENVIRONMENT (index.ts handleAdminOverview) with both the zone
 * id and the API token set.
 */
function readDistribution(env: Env): EdgeDistributionConfiguration | null {
  if (Reflect.get(env, "ENVIRONMENT") !== "production") return null;
  const zoneId: unknown = Reflect.get(env, "DISTRIBUTION_ANALYTICS_ZONE_ID");
  const apiToken: unknown = Reflect.get(env, "DISTRIBUTION_ANALYTICS_API_TOKEN");
  if (!nonEmptyString(zoneId) || !nonEmptyString(apiToken)) return null;
  return Object.freeze({ zoneId, apiToken });
}

/**
 * Every gcp-mode setting, or null for any defect. A canonical PUBLIC_ORIGIN
 * is required too: without it the admin host is not recognised, so admin-host
 * requests would be forwarded as apex without the Access chokepoint.
 */
function readGcpSettings(env: Env, localEnv: Readonly<Env>): EdgeGcpSettings | null {
  if (canonicalPublicOrigin(localEnv) === null) return null;
  const config = parseEdgeOriginConfiguration((name) => Reflect.get(env, name));
  if (config === null) return null;
  const invokerKeyJson: unknown = Reflect.get(env, "EDGE_INVOKER_KEY_JSON");
  if (!nonEmptyString(invokerKeyJson)) return null;
  const clientKeySecret: unknown = Reflect.get(env, "EDGE_CLIENT_KEY_SECRET");
  if (typeof clientKeySecret !== "string"
      || clientKeySecret.length < EDGE_MIN_CLIENT_KEY_SECRET_LENGTH) {
    return null;
  }
  const releaseGuardDb: unknown = Reflect.get(env, "RELEASE_GUARD_DB");
  if (!isD1Database(releaseGuardDb)) return null;
  const limiters = readAdmissionLimiters(env);
  if (limiters === null) return null;
  return {
    config,
    invokerKeyJson,
    clientKeySecret,
    releaseGuardDb,
    limiters,
    distribution: readDistribution(env),
  };
}

async function constructEdgeProxy(settings: EdgeGcpSettings): Promise<EdgeOriginProxy> {
  const idTokenSource = await createGoogleIdTokenSource({
    serviceAccountKeyJson: settings.invokerKeyJson,
    expectedServiceAccount: settings.config.invokerServiceAccount,
    audience: settings.config.audience,
  });
  return createEdgeOriginProxy({
    config: settings.config,
    // Two arguments: the barrier always takes its deployed constant here.
    handleRequest: (request, env) => handleRequest(request, env),
    idTokenSource,
    clientKeySecret: settings.clientKeySecret,
    limiters: settings.limiters,
    distribution: settings.distribution,
  });
}

/**
 * Per-isolate proxies, keyed on the deployed env object. A construction
 * failure (EDGE_INVOKER_KEY_INVALID, EDGE_PROXY_OPTIONS_INVALID) is cached as
 * null and never retried within the isolate: that env keeps answering
 * EDGE_NOT_CONFIGURED for the life of the isolate. A different env object
 * (or a new isolate) constructs afresh; it costs one key import, never a
 * wrong answer.
 */
const isolateProxies = new WeakMap<object, Promise<EdgeOriginProxy | null>>();

function isolateProxy(env: Env, settings: EdgeGcpSettings): Promise<EdgeOriginProxy | null> {
  const cached = isolateProxies.get(env);
  if (cached !== undefined) return cached;
  const pending = constructEdgeProxy(settings).then(
    (proxy): EdgeOriginProxy | null => proxy,
    (): EdgeOriginProxy | null => null,
  );
  isolateProxies.set(env, pending);
  return pending;
}

async function gcpFetch(request: Request, env: Env): Promise<Response> {
  const localEnv = buildEdgeLocalEnv(env);
  const settings = readGcpSettings(env, localEnv);
  if (settings === null) return notConfiguredFetch(request, localEnv);
  const proxy = await isolateProxy(env, settings);
  if (proxy === null) return notConfiguredFetch(request, localEnv);
  return proxy(request, localEnv, buildEdgeGuardEnv(localEnv, settings.releaseGuardDb));
}

// ---------------------------------------------------------------------------
// Entry

/** index.ts's default export, typed as the handler wrangler calls. */
const workerHandler: ExportedHandler<Env> = worker;

function edgeMode(env: Env) {
  return parseEdgeUpstreamMode(Reflect.get(env, "EDGE_UPSTREAM_MODE"));
}

export default {
  fetch(request, env, ctx): Promise<Response> {
    switch (edgeMode(env)) {
      case "worker": {
        if (workerHandler.fetch === undefined) return Promise.resolve(notConfigured());
        return Promise.resolve(workerHandler.fetch(request, env, ctx));
      }
      case "fenced":
        return fencedFetch(request, env);
      case "gcp":
        return gcpFetch(request, env);
      case null:
        return notConfiguredFetch(request, buildEdgeLocalEnv(env));
    }
  },
  async scheduled(controller, env, ctx): Promise<void> {
    // Only the unchanged Worker runs maintenance; every other mode (and an
    // unconfigured one) has no storage to maintain.
    if (edgeMode(env) !== "worker" || workerHandler.scheduled === undefined) return;
    await workerHandler.scheduled(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
