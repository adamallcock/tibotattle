/**
 * The restored accountless performance intake on the PostgreSQL origin
 * (owner decision 2026-10-10, decision 1; GATE-Q 6 and 8):
 *
 *   POST     /api/v1/accountless/telemetry-performance-authorization
 *            (accountless_telemetry_performance_authorization)
 *   GET      /api/v1/device/telemetry/performance/capabilities
 *            (telemetry_performance_capabilities)
 *   GET/POST /api/v1/device/telemetry/performance/reports
 *            (telemetry_performance_reports)
 *
 * The consent route (telemetry_performance_consent) stays retired and is
 * not served here.
 *
 * Oracle: the D1 Worker at D (22d9d90f5) src/index.ts
 * handleAccountlessTelemetryPerformanceAuthorization (804-838),
 * deviceSyncPrincipal (3019-3044), handleTelemetryPerformanceCapabilities
 * and handleTelemetryPerformanceReports (3094-3199). Each step below is the
 * origin's port of the Worker's step, in the Worker's order, through the
 * same injected adapters the sibling v1.2 and v1.1 routes use.
 *
 * Grant (POST only; Allow: POST):
 *  1. a session cookie (not any cookie): 401 AUTH_INVALID;
 *  2. the origin's storage gate: 503 BACKEND_STORAGE_UNAVAILABLE;
 *  3. ACCOUNTLESS_OWNERSHIP_MODE: 503 ACCOUNTLESS_OWNERSHIP_DISABLED or
 *     ACCOUNTLESS_OWNERSHIP_CONFIGURATION_INVALID;
 *  4. assertAdmissionBindings;
 *  5. the uploadRegistration collection control;
 *  6. assertAttemptAllowed(RECOVERY, CLIENT_ATTEMPT, accountless_ownership);
 *  7. the accountless device bearer against the base v1.1 graph (the grant
 *     is what is being requested); a principal whose authorityKind is not
 *     exactly 'accountless' (absent included) is 401 DEVICE_AUTH_INVALID;
 *  8. a query string: 503 POSTGRES_TEST_ROUTE_UNSUPPORTED, the v1.2
 *     dispatch's owner-accepted OD-CR-6 (ii) refusal for its POST routes;
 *  9. deps.policy.assertStorage (the Worker's
 *     requireTelemetryPerformanceStorageMode, index.ts:827), which the
 *     Worker runs before it reads the body;
 * 10. the bounded JSON body (MAX_REQUEST_BYTES, 15 s total, 5 s idle):
 *     415, 400, 413 or the reader's 408;
 * 11. deps.policy.parseGrantRequest: 400 BODY_INVALID or 403
 *     TELEMETRY_CONSENT_INVALID;
 * 12. deps.policy.grant;
 * 13. 201 with the exact request body echoed.
 *
 * Capabilities (GET only; Allow: GET): the storage gate, the admission
 * bindings, assertAttemptAllowed(..., device_sync), any cookie 401
 * DEVICE_AUTH_INVALID, the device bearer with accountlessAuthorizationVersion
 * "v1.1" (never the v1.2 default: performance is an independent dialect and
 * a v1.1-only device must reach it), deps.policy.assertStorage, then
 * deps.policy.readCapability answered 200.
 *
 * Reports (GET, POST; Allow: GET, POST): the capabilities principal and
 * deps.policy.assertStorage, then
 * - GET: only fromDay, throughDay and includeSuperseded, each at most once,
 *   includeSuperseded only "true" or "false" (400 BODY_INVALID otherwise);
 *   deps.reports.read answered 200;
 * - POST: the processing collection control; the bounded JSON body;
 *   validateTelemetryPerformanceEnvelope (400 ENVELOPE_INVALID); the
 *   capability read BEFORE decryption, so a device without a current
 *   capability is refused 403 before any RSA work; decryptSyntheticEnvelope
 *   (400 KEY_ID_INVALID on a key id mismatch); deps.reports.admit with the
 *   sha256 of the raw body; 202 { schemaVersion
 *   telemetry-performance-receipt-v1, status, reportId, day, reportRevision,
 *   replayed }, with idempotency-replayed: true on a replay.
 *
 * Every response is no-store. The edge-replayed attempt limiter is called
 * exactly once per request at the Worker's call point, so the origin's
 * replay bindings (postgres-edge-admission-limiters.mjs) see the Worker's
 * exact call sequence.
 *
 * Refusal counters. Once the device has authenticated, every 4xx or 5xx
 * answer is also passed to deps.recordRefusal({ routeId, code, status }),
 * where code is the closed response code, or for 409 TELEMETRY_RECORD_INVALID
 * the code joined to the report parser's closed detail (for example
 * TELEMETRY_RECORD_INVALID_MODEL_UNREVIEWED, or
 * TELEMETRY_RECORD_INVALID_REPORT_DAY_OUT_OF_WINDOW for a report day outside
 * the admission's server-time window). The detail is read from the
 * refused error's `detail` property (SPD-G3's
 * PostgresTelemetryPerformanceRecordInvalidError) and appended only
 * when it is one of the parser's closed details; it never reaches the
 * response body. Recording is awaited for at most
 * PERFORMANCE_TELEMETRY_REFUSAL_BOUND_MILLISECONDS, any failure is ignored,
 * and the response is built before recording starts, so a recorder that
 * throws, hangs or times out never changes it. Refusals before
 * authentication (method, cookie, storage gate, modes, bindings, controls,
 * limiter, bearer) are not counted.
 *
 * Dependencies (bound once at startup; SPD-X1a wires them):
 *   primaryPool, schema ({ primarySchema }), admissionEnv (frozen; it holds
 *     the limiter bindings, ACCOUNTLESS_OWNERSHIP_MODE and
 *     PERFORMANCE_TELEMETRY_STORAGE_MODE), maxRequestBytes,
 *     performanceStorageMode (optional; when absent the mode passed to
 *     policy.assertStorage is admissionEnv.PERFORMANCE_TELEMETRY_STORAGE_MODE),
 *     envelopePublicJwk, envelopePrivateJwk, requestContext (optional)
 *   assertStorageCurrent()                  the origin's storage gate
 *   assertAdmissionBindings(env), assertAttemptAllowed(coarse, client,
 *     request, env, purpose)                src/admission.ts
 *   assertCollectionControl(pool, primarySchema, name)
 *   authenticateGrantDevice(pool, header, { schema, accountlessAuthorizationVersion })
 *     authenticatePostgresAccountlessForV12Grant
 *   authenticateDevice(pool, header, { schema, accountlessAuthorizationVersion })
 *     authenticatePostgresDeviceBearer
 *   readBoundedRequestBody(request, maxBytes, timing)
 *   validateTelemetryPerformanceEnvelope(value)
 *   decryptSyntheticEnvelope(envelope, publicJwk, privateJwk), sha256Hex(bytes)
 *   policy: SPD-G2 src/postgres-telemetry-performance-policy.ts
 *     assertStorage(pool, { schema, mode })            assertPostgresTelemetryPerformanceStorage
 *     parseGrantRequest(value)                         parsePostgresTelemetryPerformanceGrantRequest
 *     grant(pool, { schema, principal, request, nowEpoch })
 *                                                      grantPostgresTelemetryPerformanceAccountlessAuthorization
 *     readCapability(pool, { schema, principal, nowEpoch })
 *                                                      readPostgresTelemetryPerformanceCapability
 *   reports: SPD-G3 src/postgres-telemetry-performance-reports.ts
 *     admit(pool, { schema, principal, plaintext, capability, envelopeDigest, nowEpoch })
 *                                                      admitPostgresTelemetryPerformanceReport
 *     read(pool, { schema, participantId, deviceId, fromDay, throughDay, includeSuperseded })
 *                                                      readPostgresTelemetryPerformanceReports
 *   recordRefusal({ routeId, code, status })   bound to
 *     recordPostgresTelemetryPerformanceRefusal (src/postgres-performance-refusal-counts.ts)
 *   clock() (optional, default Date.now)
 *
 * Nothing here logs. Plain JavaScript whose only import is the v1.1 route
 * support leaf, so node:test loads it without a database or a bundler.
 */

import {
  jsonResponse,
  methodNotAllowed,
  readBoundedJson,
  routeConfigurationError,
  routeErrorResponse,
  routeFailure,
  routeRequestId,
  storageUnavailable,
} from "./v11-route-support.mjs";

export const PERFORMANCE_TELEMETRY_ROUTE_IDS = Object.freeze([
  "accountless_telemetry_performance_authorization",
  "telemetry_performance_capabilities",
  "telemetry_performance_reports",
]);

export const PERFORMANCE_TELEMETRY_PATHNAMES = Object.freeze({
  accountless_telemetry_performance_authorization: "/api/v1/accountless/telemetry-performance-authorization",
  telemetry_performance_capabilities: "/api/v1/device/telemetry/performance/capabilities",
  telemetry_performance_reports: "/api/v1/device/telemetry/performance/reports",
});

/** The recorder's wall-clock bound inside a request. */
export const PERFORMANCE_TELEMETRY_REFUSAL_BOUND_MILLISECONDS = 1_000;

/**
 * The reports module's closed refusal details
 * (POSTGRES_TELEMETRY_PERFORMANCE_RECORD_INVALID_DETAILS), the only suffixes a
 * counter code takes. postgres-telemetry-performance-reports.spec.mjs pins the
 * two lists equal.
 */
export const PERFORMANCE_TELEMETRY_RECORD_INVALID_DETAILS = Object.freeze([
  "MODEL_UNREVIEWED", "DICTIONARY_UNACCEPTED", "SCHEME_MISMATCH", "ORDER",
  "DUPLICATE_COHORT", "DAY_MISMATCH", "SIZE", "SHAPE", "REPORT_DAY_OUT_OF_WINDOW",
]);

const RECEIPT_SCHEMA_VERSION = "telemetry-performance-receipt-v1";
const ADMISSION_STATUSES = new Set(["accepted", "replaced", "idempotent"]);
const REPORT_QUERY_KEYS = new Set(["fromDay", "throughDay", "includeSuperseded"]);
// src/constants.ts SESSION_COOKIE_NAME, read by src/session.ts hasSessionCookie;
// performance-telemetry.check.mjs pins it against the TypeScript source.
const SESSION_COOKIE_NAME = "__Host-usage_monitor_session";
const CLOSED_CODE = /^[A-Z0-9_]+$/u;

const REQUIRED_FUNCTIONS = Object.freeze([
  "assertStorageCurrent", "assertAdmissionBindings", "assertAttemptAllowed",
  "assertCollectionControl", "authenticateGrantDevice", "authenticateDevice",
  "readBoundedRequestBody", "validateTelemetryPerformanceEnvelope",
  "decryptSyntheticEnvelope", "sha256Hex", "recordRefusal",
]);
const POLICY_FUNCTIONS = Object.freeze(["assertStorage", "parseGrantRequest", "grant", "readCapability"]);
const REPORT_FUNCTIONS = Object.freeze(["admit", "read"]);

/** src/session.ts hasSessionCookie: only the session cookie counts, not any cookie. */
function hasSessionCookie(cookieHeader) {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((part) => (
    part.slice(0, Math.max(0, part.indexOf("="))).trim() === SESSION_COOKIE_NAME
  ));
}

/** The status and code routeErrorResponse answers for this error. */
function closedAnswer(error) {
  const closed = Number.isSafeInteger(error?.status) && error.status >= 400 && error.status <= 599
    && typeof error?.code === "string" && CLOSED_CODE.test(error.code);
  return closed ? { status: error.status, code: error.code } : { status: 500, code: "INTERNAL_ERROR" };
}

/** The counter code: the closed code, plus the parser's closed detail for an invalid record. */
function refusalCode(error, answer) {
  if (answer.status !== 409 || answer.code !== "TELEMETRY_RECORD_INVALID") return answer.code;
  const detail = error?.detail;
  return typeof detail === "string" && PERFORMANCE_TELEMETRY_RECORD_INVALID_DETAILS.includes(detail)
    ? `${answer.code}_${detail}` : answer.code;
}

function principalOf(device) {
  if (device === null || typeof device !== "object"
      || typeof device.participantId !== "string" || typeof device.deviceId !== "string") {
    throw storageUnavailable();
  }
  return Object.freeze({ participantId: device.participantId, deviceId: device.deviceId });
}

function validateDependencies(dependencies) {
  const route = "performance_telemetry";
  if (dependencies === null || typeof dependencies !== "object") {
    throw routeConfigurationError(route, "dependencies must be an object");
  }
  for (const name of REQUIRED_FUNCTIONS) {
    if (typeof dependencies[name] !== "function") throw routeConfigurationError(route, name + " must be a function");
  }
  for (const [group, names] of [["policy", POLICY_FUNCTIONS], ["reports", REPORT_FUNCTIONS]]) {
    for (const name of names) {
      if (typeof dependencies[group]?.[name] !== "function") {
        throw routeConfigurationError(route, group + "." + name + " must be a function");
      }
    }
  }
  const {
    primaryPool, schema, admissionEnv, maxRequestBytes, envelopePublicJwk, envelopePrivateJwk,
    requestContext, clock, performanceStorageMode,
  } = dependencies;
  if (!primaryPool || typeof primaryPool.connect !== "function"
      || schema === null || typeof schema !== "object" || typeof schema.primarySchema !== "string"
      || admissionEnv === null || typeof admissionEnv !== "object" || !Object.isFrozen(admissionEnv)
      || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1
      || typeof envelopePublicJwk !== "string" || envelopePublicJwk.length === 0
      || typeof envelopePrivateJwk !== "string" || envelopePrivateJwk.length === 0) {
    throw routeConfigurationError(route,
      "pool, schema, frozen admissionEnv, maxRequestBytes and envelope keys are required");
  }
  if (requestContext !== undefined && typeof requestContext !== "function") {
    throw routeConfigurationError(route, "requestContext must be a function");
  }
  if (performanceStorageMode !== undefined && typeof performanceStorageMode !== "string") {
    throw routeConfigurationError(route, "performanceStorageMode must be a string");
  }
  if (clock !== undefined && typeof clock !== "function") {
    throw routeConfigurationError(route, "clock must be a function");
  }
  return Object.freeze({
    ...dependencies,
    policy: Object.freeze(Object.fromEntries(POLICY_FUNCTIONS.map((name) => [name, dependencies.policy[name]]))),
    reports: Object.freeze(Object.fromEntries(REPORT_FUNCTIONS.map((name) => [name, dependencies.reports[name]]))),
    clock: clock ?? Date.now,
  });
}

/**
 * @param {Record<string, unknown>} dependencies see the module comment
 * @returns {Readonly<{ dispatch: (request: Request) => Promise<Response | null>, pathnames: readonly string[] }>}
 */
export function createPerformanceTelemetryDispatch(dependencies) {
  const deps = validateDependencies(dependencies);
  const { admissionEnv } = deps;
  const schemaOption = Object.freeze({ schema: deps.schema });

  /** Best-effort, bounded, never throwing: the response is already decided. */
  async function recordRefusal(routeId, error) {
    const answer = closedAnswer(error);
    const refusal = Object.freeze({ routeId, code: refusalCode(error, answer), status: answer.status });
    let timer;
    try {
      const recording = Promise.resolve().then(() => deps.recordRefusal(refusal)).catch(() => {});
      const bound = new Promise((resolve) => {
        timer = setTimeout(resolve, PERFORMANCE_TELEMETRY_REFUSAL_BOUND_MILLISECONDS);
        timer?.unref?.();
      });
      await Promise.race([recording, bound]);
    } catch {
      // A recorder is never allowed to change or fail the answer.
    } finally {
      clearTimeout(timer);
    }
  }

  async function assertStorageGate() {
    try {
      await deps.assertStorageCurrent();
    } catch {
      throw storageUnavailable();
    }
  }

  async function assertPerformanceStorage() {
    await deps.policy.assertStorage(deps.primaryPool, {
      schema: deps.schema, mode: deps.performanceStorageMode ?? admissionEnv.PERFORMANCE_TELEMETRY_STORAGE_MODE,
    });
  }

  /** Steps 1-7 of the grant: everything before the principal exists. */
  async function grantPrincipal(request) {
    if (hasSessionCookie(request.headers.get("cookie"))) throw routeFailure(401, "AUTH_INVALID");
    await assertStorageGate();
    const mode = admissionEnv.ACCOUNTLESS_OWNERSHIP_MODE;
    if (mode === undefined || mode === "disabled") throw routeFailure(503, "ACCOUNTLESS_OWNERSHIP_DISABLED");
    if (mode !== "enabled") throw routeFailure(503, "ACCOUNTLESS_OWNERSHIP_CONFIGURATION_INVALID");
    deps.assertAdmissionBindings(admissionEnv);
    await deps.assertCollectionControl(deps.primaryPool, deps.schema.primarySchema, "uploadRegistration");
    await deps.assertAttemptAllowed(
      admissionEnv.RECOVERY_RATE_LIMIT,
      admissionEnv.CLIENT_ATTEMPT_RATE_LIMIT,
      request,
      admissionEnv,
      "accountless_ownership",
    );
    const device = await deps.authenticateGrantDevice(deps.primaryPool, request.headers.get("authorization"), {
      ...schemaOption, accountlessAuthorizationVersion: "v1.1",
    });
    // Defence in depth: the bound authenticator already refuses any other
    // authority, but the grant requires an explicit accountless principal.
    if (device === null || typeof device !== "object" || device.authorityKind !== "accountless") {
      throw routeFailure(401, "DEVICE_AUTH_INVALID");
    }
    return principalOf(device);
  }

  /** The Worker's deviceSyncPrincipal behind the origin's storage gate. */
  async function devicePrincipal(request) {
    await assertStorageGate();
    deps.assertAdmissionBindings(admissionEnv);
    await deps.assertAttemptAllowed(
      admissionEnv.RECOVERY_RATE_LIMIT,
      admissionEnv.CLIENT_ATTEMPT_RATE_LIMIT,
      request,
      admissionEnv,
      "device_sync",
    );
    if (request.headers.has("cookie")) throw routeFailure(401, "DEVICE_AUTH_INVALID");
    return principalOf(await deps.authenticateDevice(deps.primaryPool, request.headers.get("authorization"), {
      ...schemaOption, accountlessAuthorizationVersion: "v1.1",
    }));
  }

  async function grant(request, url, state) {
    const principal = await grantPrincipal(request);
    state.authenticated = true;
    if (url.search) throw routeFailure(503, "POSTGRES_TEST_ROUTE_UNSUPPORTED");
    await assertPerformanceStorage();
    const { value } = await readBoundedJson(request, deps.readBoundedRequestBody, deps.maxRequestBytes);
    const parsed = deps.policy.parseGrantRequest(value);
    if (parsed === null || typeof parsed !== "object" || parsed.echo === null || typeof parsed.echo !== "object") {
      throw storageUnavailable();
    }
    await deps.policy.grant(deps.primaryPool, {
      schema: deps.schema, principal, request: parsed, nowEpoch: deps.clock(),
    });
    return jsonResponse(201, parsed.echo);
  }

  async function capabilities(request, state) {
    const principal = await devicePrincipal(request);
    state.authenticated = true;
    await assertPerformanceStorage();
    return jsonResponse(200, await deps.policy.readCapability(deps.primaryPool, {
      schema: deps.schema, principal, nowEpoch: deps.clock(),
    }));
  }

  async function reports(request, url, state) {
    const principal = await devicePrincipal(request);
    state.authenticated = true;
    await assertPerformanceStorage();
    if (request.method === "GET") {
      const query = url.searchParams;
      if ([...query.keys()].some((key) => !REPORT_QUERY_KEYS.has(key))
          || query.getAll("fromDay").length > 1
          || query.getAll("throughDay").length > 1
          || query.getAll("includeSuperseded").length > 1) {
        throw routeFailure(400, "BODY_INVALID");
      }
      const includeSuperseded = query.get("includeSuperseded");
      if (includeSuperseded !== null && includeSuperseded !== "true" && includeSuperseded !== "false") {
        throw routeFailure(400, "BODY_INVALID");
      }
      return jsonResponse(200, await deps.reports.read(deps.primaryPool, {
        schema: deps.schema,
        participantId: principal.participantId,
        deviceId: principal.deviceId,
        fromDay: query.get("fromDay") ?? undefined,
        throughDay: query.get("throughDay") ?? undefined,
        includeSuperseded: includeSuperseded === null ? undefined : includeSuperseded === "true",
      }));
    }
    await deps.assertCollectionControl(deps.primaryPool, deps.schema.primarySchema, "processing");
    const body = await readBoundedJson(request, deps.readBoundedRequestBody, deps.maxRequestBytes);
    const envelope = deps.validateTelemetryPerformanceEnvelope(body.value);
    // The capability is read immediately before decryption (index.ts:3174-
    // 3180): a device without a current capability is refused before any RSA
    // work, and admission repeats the exact fence before it writes.
    const capability = await deps.policy.readCapability(deps.primaryPool, {
      schema: deps.schema, principal, nowEpoch: deps.clock(),
    });
    const plaintext = await deps.decryptSyntheticEnvelope(envelope, deps.envelopePublicJwk, deps.envelopePrivateJwk);
    const result = await deps.reports.admit(deps.primaryPool, {
      schema: deps.schema,
      principal,
      plaintext,
      capability,
      envelopeDigest: await deps.sha256Hex(body.bytes),
      nowEpoch: deps.clock(),
    });
    if (result === null || typeof result !== "object" || !ADMISSION_STATUSES.has(result.status)
        || typeof result.reportId !== "string" || typeof result.day !== "string"
        || typeof result.reportRevision !== "string") {
      throw storageUnavailable();
    }
    const replayed = result.status === "idempotent";
    return jsonResponse(202, {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      status: result.status,
      reportId: result.reportId,
      day: result.day,
      reportRevision: result.reportRevision,
      replayed,
    }, replayed ? { "idempotency-replayed": "true" } : {});
  }

  const routes = new Map([
    [PERFORMANCE_TELEMETRY_PATHNAMES.accountless_telemetry_performance_authorization, Object.freeze({
      routeId: "accountless_telemetry_performance_authorization",
      methods: Object.freeze(["POST"]),
      handle: (request, url, state) => grant(request, url, state),
    })],
    [PERFORMANCE_TELEMETRY_PATHNAMES.telemetry_performance_capabilities, Object.freeze({
      routeId: "telemetry_performance_capabilities",
      methods: Object.freeze(["GET"]),
      handle: (request, _url, state) => capabilities(request, state),
    })],
    [PERFORMANCE_TELEMETRY_PATHNAMES.telemetry_performance_reports, Object.freeze({
      routeId: "telemetry_performance_reports",
      methods: Object.freeze(["GET", "POST"]),
      handle: (request, url, state) => reports(request, url, state),
    })],
  ]);

  async function dispatch(request) {
    let url;
    try { url = new URL(request.url); } catch { return null; }
    const route = routes.get(url.pathname);
    if (route === undefined) return null;
    const state = { authenticated: false };
    try {
      if (!route.methods.includes(request.method)) throw methodNotAllowed(route.methods);
      return await route.handle(request, url, state);
    } catch (error) {
      const response = routeErrorResponse(error, routeRequestId(deps, request));
      if (state.authenticated) await recordRefusal(route.routeId, error);
      return response;
    }
  }

  return Object.freeze({
    pathnames: Object.freeze([...routes.keys()]),
    dispatch,
  });
}
