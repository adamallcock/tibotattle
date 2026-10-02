/**
 * CR-6: the Worker-order request handler of the Cloud Run origin.
 *
 * createProductionRequestHandler is the inner handler EP-6
 * (createEdgeOriginDispatch) wraps in production and, after phase B, in
 * edge-test. It follows d43c8f92 handleRequest (src/index.ts) step by step
 * over the CR-6 route registry (postgres-production-registry.mjs):
 *
 * 0. requestId and hostKind come from the EP-6 edge context; a verifier
 *    request has none, so it gets a fresh id and is an apex request. The
 *    Worker's migration mutation barrier is deliberately absent: the edge's
 *    fenced mode owns it and the deployed constant is false.
 * 1. The configured www alias answers the Worker's 308 (defense only: EP-6
 *    never rebuilds on www).
 * 2. The admin host follows the injected OD-CR-3 policy, which has no
 *    default: 'refuse' answers 503 POSTGRES_ROUTE_NOT_PORTED before
 *    anything else; 'chokepoint' runs the injected Access chokepoint
 *    (src/postgres-admin-access.ts createPostgresAdminAccessChokepoint, built
 *    once: the Worker's Access verification and owner pin) on every
 *    admin-host request first. A ported admin route id then goes straight to
 *    its family with {requestId, routeId, adminIdentityKey} registered: the
 *    registry method envelope does not run first, because the family answers
 *    its own 405 after the identity check (C-ADMIN root contract). Any other
 *    route, an unported admin id included, continues through the generic
 *    pipeline below.
 * 3. On the public host, the admin surface paths and the six admin route ids
 *    answer 404 NOT_FOUND.
 * 4. An exact route checks its registry methods: 405 METHOD_NOT_ALLOWED with
 *    Allow set to the methods joined by ', '.
 * 5. community_daily answers 503 PUBLICATION_DISABLED, unlogged, when
 *    PUBLIC_ANALYTICS_MODE is not enabled.
 * 6. unknown_api is 404 NOT_FOUND; an asset is the JSON 404 NOT_FOUND of
 *    EP-6's edgeServedAssets (the edge serves the site), rendered here with
 *    this request's id, unlogged as the Worker's asset fetch is.
 * 7. Exact routes by disposition: root routes answer 404 NOT_FOUND (the
 *    method was enforced in step 4); unported routes answer
 *    503 POSTGRES_ROUTE_NOT_PORTED, with the injected OD-CR-6(iv)
 *    retry-after or none, and never reach a family; a ported route runs its
 *    family handler inside the request context store with
 *    {requestId, routeId[, adminIdentityKey]}.
 *    community_daily first passes the storage gate, and its 200 passes
 *    through unmodified (public, max-age=300); every other response is
 *    no-store.
 *
 * A thrown ApiError renders the Worker envelope (Allow from error.allowed,
 * retry-after and other headers from responseHeaders); anything else is
 * 500 INTERNAL_ERROR. Thrown errors and family error responses are logged as
 * one JSON line with exactly ORIGIN_REQUEST_LOG_FIELDS, classified as the
 * Worker classifies them, and every request_failed event is offered to the
 * injected diagnostic recorder (which keeps the Worker's sampled 5xx rule).
 * Nothing logged carries a URL, query, header, cookie, address, token or
 * body.
 *
 * createPrivateTestRequestHandler is the loopback fastpath-test pipeline
 * over the same registry. Phase B wires both (see the W3-CRA receipt).
 */

import {
  adminHostname,
  canonicalPublicOrigin,
  canonicalPublicRedirectUrl,
  isAdminSurfacePath,
} from "../src/admin-ui.ts";
import { ApiError, errorResponse } from "../src/errors.ts";
import { publicAnalyticsEnabled } from "../src/public-analytics-gate.ts";
import { WORKER_ROUTE_POLICY, matchWorkerRoute } from "../src/route-registry.ts";
import { ORIGIN_ROUTE_DISPOSITIONS, isProductionRouteRegistry } from "./postgres-production-registry.mjs";

/** The events of the root's request log line (OPS-5 alerting keys on these). */
export const ORIGIN_REQUEST_LOG_EVENTS = Object.freeze(["request_failed", "request_pending", "request_unavailable"]);

/** Exactly these keys, in this order, on every request log line. */
export const ORIGIN_REQUEST_LOG_FIELDS = Object.freeze([
  "level",
  "severity",
  "event",
  "requestId",
  "method",
  "routeClass",
  "code",
  "status",
]);

/**
 * OD-CR-3 (open owner decision): the admin host at the origin while the admin
 * routes are unported. There is no default; the handler refuses to build
 * without one of these.
 */
export const ORIGIN_ADMIN_HOST_POLICIES = Object.freeze(["refuse", "chokepoint"]);

/**
 * The closed answer for an unported route (and the admin host under
 * 'refuse'). Its retry-after is OD-CR-6(iv), an open owner decision, so it
 * is not part of this constant: createProductionRequestHandler takes it as
 * the required unportedRetryAfterSeconds.
 */
export const ORIGIN_ROUTE_NOT_PORTED = Object.freeze({
  status: 503,
  code: "POSTGRES_ROUTE_NOT_PORTED",
});

/**
 * The Worker's expected containment codes plus the origin's own unported
 * code: a 5xx with one of these is logged at warn, not error.
 */
export const ORIGIN_CONTAINMENT_CODES = Object.freeze([
  "COLLECTION_ENROLLMENT_DISABLED",
  "ACCOUNTLESS_ENROLLMENT_DISABLED",
  "UPLOAD_REGISTRATION_DISABLED",
  "PROCESSING_DISABLED",
  "PUBLICATION_DISABLED",
  ORIGIN_ROUTE_NOT_PORTED.code,
]);

/** The Worker's read-only admin aggregate codes, logged as request_unavailable. */
export const ORIGIN_UNAVAILABLE_CODES = Object.freeze([
  "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE",
  "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE",
  "ADMIN_ALLOWANCE_STORAGE_UNAVAILABLE",
  "ADMIN_METRICS_HISTORY_STORAGE_UNAVAILABLE",
  "ADMIN_RECONSTRUCTION_PROGRESS_UNAVAILABLE",
]);

/** The Worker's identity flow-control code, logged as request_pending at info. */
export const ORIGIN_PENDING_CODE = "IDENTITY_RESULT_PENDING";

/** The code logged for an error response the root cannot classify. */
export const ORIGIN_UNCLASSIFIED_CODE = "UNCLASSIFIED";

/** How much of a JSON error response the root reads for its code. */
export const ORIGIN_ERROR_CODE_READ_BYTES = 8 * 1024;

/** The six admin route ids: the policy's 'admin' authority (handleRequest's list). */
export const ORIGIN_ADMIN_ROUTE_IDS = Object.freeze(WORKER_ROUTE_POLICY
  .filter((route) => route.authority === "admin")
  .map((route) => route.id));

/** Every configuration code the two factories throw. */
export const ORIGIN_HANDLER_CONFIGURATION_CODES = Object.freeze([
  "PRODUCTION_HANDLER_REGISTRY_INVALID",
  "PRODUCTION_HANDLER_ENV_INVALID",
  "PRODUCTION_HANDLER_CONTEXT_STORE_INVALID",
  "PRODUCTION_HANDLER_REQUEST_CONTEXT_INVALID",
  "PRODUCTION_HANDLER_STORAGE_GATE_INVALID",
  "PRODUCTION_HANDLER_DIAGNOSTIC_INVALID",
  "PRODUCTION_HANDLER_LOGGER_INVALID",
  "PRODUCTION_HANDLER_ADMIN_HOST_POLICY_UNDECIDED",
  "PRODUCTION_HANDLER_ADMIN_ACCESS_INVALID",
  "PRODUCTION_HANDLER_UNPORTED_RETRY_AFTER_UNDECIDED",
  "PRIVATE_TEST_HANDLER_ORIGIN_INVALID",
  "PRIVATE_TEST_HANDLER_FALLBACK_INVALID",
]);

const ADMIN_ROUTE_ID_SET = new Set(ORIGIN_ADMIN_ROUTE_IDS);
const CONTAINMENT_CODE_SET = new Set(ORIGIN_CONTAINMENT_CODES);
const UNAVAILABLE_CODE_SET = new Set(ORIGIN_UNAVAILABLE_CODES);
const LOGGED_METHODS = new Set(["GET", "POST", "DELETE", "HEAD", "PUT", "PATCH", "OPTIONS"]);
const ERROR_CODE = /^[A-Z0-9_]{1,80}$/u;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/iu;
const SEVERITY = Object.freeze({ info: "INFO", warn: "WARNING", error: "ERROR" });

function configurationError(code) {
  return Object.assign(new TypeError(code), { code });
}

function noStore(response) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * OD-CR-6(iv): the unported answer's retry-after. The composition root
 * passes null (postgres-production-host.mjs
 * PRODUCTION_UNPORTED_RETRY_AFTER_SECONDS): none is sent, as the loopback
 * fallback's fail-closed answers (postgres-test-dispatch.mjs) send none. A
 * positive safe integer would send that many seconds. There is no default.
 */
function validatedUnportedRetryAfter(value) {
  if (value === null || (Number.isSafeInteger(value) && value >= 1)) return value;
  throw configurationError("PRODUCTION_HANDLER_UNPORTED_RETRY_AFTER_UNDECIDED");
}

function routeNotPorted(retryAfterSeconds) {
  return new ApiError(ORIGIN_ROUTE_NOT_PORTED.status, ORIGIN_ROUTE_NOT_PORTED.code,
    retryAfterSeconds === null ? undefined : { responseHeaders: { "retry-after": String(retryAfterSeconds) } });
}

/** The Worker's methodNotAllowed: a 405 whose non-enumerable `allowed` lists the methods. */
function methodNotAllowed(allowed) {
  const error = new ApiError(405, "METHOD_NOT_ALLOWED");
  Object.defineProperty(error, "allowed", { value: Object.freeze([...allowed]) });
  return error;
}

function assertRouteMethod(request, route) {
  if (route.methods === "all") return;
  if (!route.methods.includes(request.method)) throw methodNotAllowed(route.methods);
}

/**
 * The Worker's catch classification for one code and status:
 * IDENTITY_RESULT_PENDING is request_pending at info; the five admin
 * aggregate codes are request_unavailable at warn; everything else is
 * request_failed, at error when it is a 5xx outside ORIGIN_CONTAINMENT_CODES
 * and at warn otherwise. Only request_failed reaches the diagnostic
 * recorder (Worker parity: recordDiagnosticError is called for every
 * request_failed and keeps only sampled 5xx), except the origin's own
 * unported code, which has no Worker counterpart.
 */
export function classifyOriginOutcome(code, status) {
  if (code === ORIGIN_PENDING_CODE) {
    return Object.freeze({ event: "request_pending", level: "info", diagnostic: false });
  }
  if (UNAVAILABLE_CODE_SET.has(code)) {
    return Object.freeze({ event: "request_unavailable", level: "warn", diagnostic: false });
  }
  return Object.freeze({
    event: "request_failed",
    level: status >= 500 && !CONTAINMENT_CODE_SET.has(code) ? "error" : "warn",
    diagnostic: code !== ORIGIN_ROUTE_NOT_PORTED.code,
  });
}

/** The one log line: exactly ORIGIN_REQUEST_LOG_FIELDS, each from a closed source. */
export function originRequestLogLine({ level, event, requestId, method, routeClass, code, status }) {
  return JSON.stringify({
    level,
    severity: SEVERITY[level],
    event,
    requestId,
    method: LOGGED_METHODS.has(method) ? method : "OTHER",
    routeClass,
    code,
    status,
  });
}

/**
 * The error code of a family response, read from a bounded clone so the
 * original body still streams to the caller: body.error.code, or body.error
 * when it is a string (the legacy test dispatchers), matching the closed
 * code pattern. Anything else (no JSON content type, no body, more than
 * ORIGIN_ERROR_CODE_READ_BYTES, unparsable, no such member) is
 * { code: UNCLASSIFIED, envelope: false }.
 */
export async function responseErrorCode(response) {
  const unclassified = Object.freeze({ code: ORIGIN_UNCLASSIFIED_CODE, envelope: false });
  if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) return unclassified;
  let reader;
  try {
    const clone = response.clone();
    if (clone.body === null) return unclassified;
    reader = clone.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > ORIGIN_ERROR_CODE_READ_BYTES) return unclassified;
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const error = body !== null && typeof body === "object" ? body.error : undefined;
    const code = typeof error === "string"
      ? error
      : error !== null && typeof error === "object" ? error.code : undefined;
    return typeof code === "string" && ERROR_CODE.test(code)
      ? Object.freeze({ code, envelope: true })
      : Object.freeze({ code: ORIGIN_UNCLASSIFIED_CODE, envelope: error !== undefined });
  } catch {
    return unclassified;
  } finally {
    // Never awaited: a tee branch's cancel settles only once the other
    // branch (the body the caller reads) is cancelled or finished.
    reader?.cancel().catch(() => {});
  }
}

function validatedLogger(logger) {
  if (logger === undefined) return (line) => console.log(line);
  if (typeof logger !== "function") throw configurationError("PRODUCTION_HANDLER_LOGGER_INVALID");
  return logger;
}

/**
 * The storage gate before a route module: a receipt that is not current, or
 * a gate that cannot read it, is 503 BACKEND_STORAGE_UNAVAILABLE (the answer
 * the v1.2 family gives for the same gate), never the 500 of an unexpected
 * throw.
 */
async function assertStorageCurrent(storageGate) {
  try {
    await storageGate.assertCurrent();
  } catch {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

/**
 * Build the production request handler. Every parameter is required except
 * logger (console.log by default):
 * - registry: an issued CR-6 registry over the Worker's WORKER_ROUTE_POLICY;
 * - env: the frozen Worker-shaped env (CR-3 createProductionWorkerEnv, or the
 *   edge-test equivalent) with a canonical HTTPS PUBLIC_ORIGIN;
 * - requestContextStore: createRequestContextStore() (its dispatch is used);
 * - requestContext: EP-6's edgeRequestContext accessor;
 * - storageGate: { assertCurrent() } (the receipt check, phase B);
 * - recordDiagnostic: (event) => Promise, e.g. recordPostgresDiagnosticError
 *   bound to the data pool; it never changes the answer;
 * - adminHostPolicy: one of ORIGIN_ADMIN_HOST_POLICIES (OD-CR-3, no default);
 * - adminAccess: the Access chokepoint, (request) => Promise<identityKey>,
 *   required with 'chokepoint' and refused with 'refuse';
 * - unportedRetryAfterSeconds: null or a positive integer, the unported
 *   answer's retry-after (OD-CR-6(iv), no default).
 */
export function createProductionRequestHandler({
  registry,
  env,
  requestContextStore,
  requestContext,
  storageGate,
  recordDiagnostic,
  logger,
  adminHostPolicy,
  adminAccess,
  unportedRetryAfterSeconds,
} = {}) {
  if (!isProductionRouteRegistry(registry) || registry.routePolicy !== WORKER_ROUTE_POLICY) {
    throw configurationError("PRODUCTION_HANDLER_REGISTRY_INVALID");
  }
  if (env === null || typeof env !== "object" || !Object.isFrozen(env) || canonicalPublicOrigin(env) === null) {
    throw configurationError("PRODUCTION_HANDLER_ENV_INVALID");
  }
  if (requestContextStore === null || typeof requestContextStore !== "object"
      || typeof requestContextStore.dispatch !== "function") {
    throw configurationError("PRODUCTION_HANDLER_CONTEXT_STORE_INVALID");
  }
  if (typeof requestContext !== "function") throw configurationError("PRODUCTION_HANDLER_REQUEST_CONTEXT_INVALID");
  if (storageGate === null || typeof storageGate !== "object" || typeof storageGate.assertCurrent !== "function") {
    throw configurationError("PRODUCTION_HANDLER_STORAGE_GATE_INVALID");
  }
  if (typeof recordDiagnostic !== "function") throw configurationError("PRODUCTION_HANDLER_DIAGNOSTIC_INVALID");
  const log = validatedLogger(logger);
  if (!ORIGIN_ADMIN_HOST_POLICIES.includes(adminHostPolicy)) {
    throw configurationError("PRODUCTION_HANDLER_ADMIN_HOST_POLICY_UNDECIDED");
  }
  if (adminHostPolicy === "chokepoint" ? typeof adminAccess !== "function" : adminAccess !== undefined) {
    throw configurationError("PRODUCTION_HANDLER_ADMIN_ACCESS_INVALID");
  }
  const retryAfterSeconds = validatedUnportedRetryAfter(unportedRetryAfterSeconds);

  function writeLog(fields) {
    try {
      log(originRequestLogLine(fields));
    } catch {
      // A failing sink never changes the answer.
    }
  }

  async function report(outcome, requestId, method, routeClass, code, status) {
    writeLog({ level: outcome.level, event: outcome.event, requestId, method, routeClass, code, status });
    if (outcome.event === "request_failed" && outcome.diagnostic) {
      try {
        await recordDiagnostic(Object.freeze({ requestId, routeClass, code, status }));
      } catch {
        // Diagnostics cannot turn a useful answer into a second failure.
      }
    }
  }

  /**
   * A family that answers an error envelope instead of throwing is logged as
   * if it had thrown. The RD-2 not-ready DTO (a 503 without an error member)
   * is an ordinary answer, as handleReady's is, and is not logged.
   */
  async function reportFamilyResponse(response, routeId, requestId, method, routeClass) {
    if (response.status < 400) return;
    const { code, envelope } = await responseErrorCode(response);
    if (!envelope && routeId === "ready") return;
    await report(classifyOriginOutcome(code, response.status), requestId, method, routeClass, code, response.status);
  }

  return async function handleProductionRequest(request) {
    const edge = requestContext(request);
    const requestId = edge?.requestId ?? crypto.randomUUID();
    const hostKind = edge?.hostKind ?? "apex";
    const url = new URL(request.url);
    const route = matchWorkerRoute(url.pathname);
    try {
      const redirect = canonicalPublicRedirectUrl(url, env);
      if (redirect !== null) return Response.redirect(redirect, 308);
      const configuredAdminHostname = adminHostname(env);
      const adminHost = hostKind === "admin"
        || (configuredAdminHostname !== null && url.hostname === configuredAdminHostname);
      let adminIdentityKey = null;
      if (adminHost) {
        if (adminHostPolicy === "refuse") throw routeNotPorted(retryAfterSeconds);
        adminIdentityKey = await adminAccess(request);
      } else if (configuredAdminHostname !== null
          && (isAdminSurfacePath(url.pathname)
            || (route.kind === "exact" && ADMIN_ROUTE_ID_SET.has(route.id)))) {
        throw new ApiError(404, "NOT_FOUND");
      }
      // A ported admin route answers its own 405 after the identity check (the
      // C-ADMIN family, as the Worker's handlers); an unported one keeps the
      // registry envelope, then the unported answer.
      const adminRoute = adminIdentityKey !== null && route.kind === "exact" && ADMIN_ROUTE_ID_SET.has(route.id)
        && registry.resolve(route.id).disposition === ORIGIN_ROUTE_DISPOSITIONS.PORTED;
      if (route.kind === "exact" && !adminRoute) assertRouteMethod(request, route);
      if (route.id === "community_daily" && !publicAnalyticsEnabled(env)) {
        return noStore(errorResponse(new ApiError(503, "PUBLICATION_DISABLED"), requestId));
      }
      if (route.kind === "unknown_api") throw new ApiError(404, "NOT_FOUND");
      if (route.kind === "asset") return noStore(errorResponse(new ApiError(404, "NOT_FOUND"), requestId));
      const resolved = registry.resolve(route.id);
      if (resolved.disposition === ORIGIN_ROUTE_DISPOSITIONS.ROOT) throw new ApiError(404, "NOT_FOUND");
      if (resolved.disposition !== ORIGIN_ROUTE_DISPOSITIONS.PORTED) throw routeNotPorted(retryAfterSeconds);
      if (route.id === "community_daily") await assertStorageCurrent(storageGate);
      const context = adminRoute
        ? { requestId, routeId: route.id, adminIdentityKey }
        : { requestId, routeId: route.id };
      const response = await requestContextStore.dispatch(request, context, resolved.handler);
      if (!(response instanceof Response)) throw new TypeError("ORIGIN_FAMILY_RESPONSE_INVALID");
      await reportFamilyResponse(response, route.id, requestId, request.method, route.routeClass);
      return route.id === "community_daily" && response.status === 200 ? response : noStore(response);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR");
      await report(classifyOriginOutcome(apiError.code, apiError.status), requestId, request.method,
        route.routeClass, apiError.code, apiError.status);
      const response = errorResponse(apiError, requestId);
      const allowed = Reflect.get(apiError, "allowed");
      if (!Array.isArray(allowed)) return noStore(response);
      const headers = new Headers(response.headers);
      headers.set("allow", allowed.join(", "));
      return noStore(new Response(response.body, { status: response.status, headers }));
    }
  };
}

/**
 * The loopback fastpath-test pipeline over the same registry: a request for
 * another origin goes to fallback (which keeps the legacy
 * 503 POSTGRES_TEST_ROUTE_UNSUPPORTED); an exact route the registry resolves
 * as ported goes to its family handler, which keeps its own 405s; everything
 * else goes to fallback (the v12 dispatch).
 */
export function createPrivateTestRequestHandler({ registry, dispatchOrigin, fallback } = {}) {
  if (!isProductionRouteRegistry(registry) || registry.routePolicy !== WORKER_ROUTE_POLICY) {
    throw configurationError("PRODUCTION_HANDLER_REGISTRY_INVALID");
  }
  let origin;
  try { origin = new URL(dispatchOrigin).origin; } catch { origin = null; }
  if (origin === null || origin !== dispatchOrigin) throw configurationError("PRIVATE_TEST_HANDLER_ORIGIN_INVALID");
  if (typeof fallback !== "function") throw configurationError("PRIVATE_TEST_HANDLER_FALLBACK_INVALID");
  return async function handlePrivateTestRequest(request) {
    const url = new URL(request.url);
    if (url.origin !== dispatchOrigin) return fallback(request);
    const route = matchWorkerRoute(url.pathname);
    if (route.kind === "exact") {
      const resolved = registry.resolve(route.id);
      if (resolved.disposition === ORIGIN_ROUTE_DISPOSITIONS.PORTED) return resolved.handler(request);
    }
    return fallback(request);
  };
}
