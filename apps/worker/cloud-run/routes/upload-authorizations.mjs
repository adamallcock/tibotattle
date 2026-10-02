/**
 * POST /api/v1/device/upload-authorizations for the PostgreSQL origin once
 * legacy formats are registered (GCP fast path, IN-3). An origin route
 * module that replaces the built-in route (ORIGIN_OVERRIDABLE_BUILT_INS).
 *
 * Why it exists: the built-in route in postgres-test-dispatch.mjs was written
 * for the v1.2-only origin and requires exactly four body keys. Shipped
 * d43c8f92 v1.0 clients send three (src/contribution-incremental-sync.js and
 * src/contribution-device-sync.js omit telemetrySchemaVersion), and
 * d43c8f92 handleDeviceUploadAuthorization defaults the version to
 * telemetry-contribution-v1.0 and answers an unknown version 403
 * TELEMETRY_TRANSPORT_BLOCKED. Mount this module whenever a legacy
 * envelope and its format are registered; without it a shipped v1.0 client
 * can never obtain an authorization.
 *
 * Behaviour: the built-in route step for step (query string, storage
 * receipt, admission bindings, cookie, device bearer,
 * upload-authorization bindings, upload-registration control, rate limits,
 * content type, declared length, bounded fatal-UTF-8 JSON, the format's
 * write authority, 201 with the created authorization, and the built-in's
 * error body), with one change: the body is read by
 * parseUploadAuthorizationRequest and the version resolved by
 * resolveUploadAuthorizationFormat (upload-authorization-formats.mjs), the
 * Worker's own rules. A four-key v1.2 request is answered exactly as the
 * built-in answers it. The format table must therefore be the origin's whole
 * table, v1.2 included; the module refuses to start without v1.2.
 *
 * Every storage and admission step is injected and bound once at startup
 * (origin-route-modules.mjs: modules take no per-request storage). The
 * composition root passes the same adapters the built-in uses:
 *   assertStorageCurrent()          the built-in's primary
 *                                   schema-receipt check; throws 503
 *                                   BACKEND_STORAGE_UNAVAILABLE unless it
 *                                   is current
 *   assertAdmissionBindings(env), assertUploadAuthorizationBindings(env),
 *   assertUploadAuthorizationAllowed(limit, principalLimit, participantId, env)
 *                                   the Worker's admission functions
 *   assertUploadRegistrationEnabled(pool, primarySchema)
 *                                   the uploadRegistration collection control
 *   authenticateDevice(pool, header, { schema })   authenticatePostgresDevice
 *                                   (a deleted participant's bearer fails
 *                                   it; there is no deletion-ledger
 *                                   tombstone read)
 *   readBoundedRequestBody(request, maxBytes, timing)
 *   createDeviceUploadAuthorization(pool, device, { envelopeDigest, bodyBytes }, { schema })
 *   formats                         createUploadAuthorizationFormats() output
 *
 * Plain JavaScript with no runtime-specific imports so node:test specs can
 * load it directly.
 */

import { defineOriginRouteModule } from "../origin-route-modules.mjs";
import { requestIdFrom } from "../postgres-request-context.mjs";
import {
  parseUploadAuthorizationRequest,
  resolveUploadAuthorizationFormat,
} from "../upload-authorization-formats.mjs";

export const DEVICE_UPLOAD_AUTHORIZATION_PATH = "/api/v1/device/upload-authorizations";
const V12_UPLOAD_AUTHORIZATION_SCHEMA_VERSION = "telemetry-contribution-v1.2";

const REQUIRED_FUNCTIONS = Object.freeze([
  "assertStorageCurrent",
  "assertAdmissionBindings",
  "assertUploadAuthorizationBindings",
  "assertUploadAuthorizationAllowed",
  "assertUploadRegistrationEnabled",
  "authenticateDevice",
  "readBoundedRequestBody",
  "createDeviceUploadAuthorization",
]);

function configurationError(message) {
  return Object.assign(new Error("UPLOAD_AUTHORIZATION_ROUTE_CONFIGURATION_INVALID: " + message), {
    code: "UPLOAD_AUTHORIZATION_ROUTE_CONFIGURATION_INVALID",
  });
}

function refusal(status, code) {
  return Object.assign(new Error(code), { code, status });
}

/** The built-in's json() helper. */
function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

/** The built-in's routeError(): closed errors keep their answer, the rest are 500. */
function routeError(error, requestId) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/u.test(error.code)
    ? error.code : "INTERNAL_ERROR";
  const status = Number.isSafeInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status : 500;
  const body = {
    error: {
      code,
      requestId,
      ...(error?.publicDetails && typeof error.publicDetails === "object"
        ? { details: error.publicDetails } : {}),
    },
  };
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  if (error?.responseHeaders) {
    for (const [name, value] of new Headers(error.responseHeaders)) headers.set(name, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * @param {Record<string, unknown>} dependencies see the module comment
 */
export function createUploadAuthorizationRouteModule(dependencies) {
  if (dependencies === null || typeof dependencies !== "object") {
    throw configurationError("dependencies must be an object");
  }
  for (const name of REQUIRED_FUNCTIONS) {
    if (typeof dependencies[name] !== "function") throw configurationError(name + " must be a function");
  }
  const { primaryPool, schema, maxRequestBytes, formats } = dependencies;
  if (!primaryPool || typeof primaryPool.connect !== "function"
      || schema === null || typeof schema !== "object"
      || typeof schema.primarySchema !== "string"
      || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    throw configurationError("pool, schema and maxRequestBytes are required");
  }
  if (formats === null || typeof formats !== "object" || typeof formats.resolve !== "function"
      || typeof formats.has !== "function"
      || !formats.has(V12_UPLOAD_AUTHORIZATION_SCHEMA_VERSION)) {
    throw configurationError("formats must be the origin's whole format table, v1.2 included");
  }
  const deps = Object.freeze({ ...dependencies });
  const admissionEnv = deps.admissionEnv;

  async function handleDeviceUploadAuthorization(request) {
    let url;
    try { url = new URL(request.url); } catch {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    // The built-in serves no query string on this route.
    if (url.search) return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    const requestId = requestIdFrom(deps.requestContext, request);
    try {
      await deps.assertStorageCurrent();
      deps.assertAdmissionBindings(admissionEnv);
      if (request.headers.has("cookie")) throw refusal(401, "DEVICE_AUTH_INVALID");
      const device = await deps.authenticateDevice(
        deps.primaryPool, request.headers.get("authorization"), { schema: deps.schema },
      );
      if (device === null || typeof device !== "object" || typeof device.participantId !== "string") {
        throw refusal(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      deps.assertUploadAuthorizationBindings(admissionEnv);
      await deps.assertUploadRegistrationEnabled(deps.primaryPool, deps.schema.primarySchema);
      await deps.assertUploadAuthorizationAllowed(
        admissionEnv?.UPLOAD_AUTHORIZATION_RATE_LIMIT,
        admissionEnv?.UPLOAD_PRINCIPAL_RATE_LIMIT,
        device.participantId,
        admissionEnv,
      );

      const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (contentType !== "application/json") throw refusal(415, "CONTENT_TYPE_INVALID");
      const declared = request.headers.get("content-length");
      if (declared !== null) {
        const length = Number(declared);
        if (!Number.isSafeInteger(length) || length < 0) throw refusal(400, "BODY_INVALID");
        if (length > deps.maxRequestBytes) throw refusal(413, "BODY_TOO_LARGE");
      }
      const bytes = await deps.readBoundedRequestBody(request, deps.maxRequestBytes, {
        maximumTotalMilliseconds: 15_000,
        maximumIdleMilliseconds: 5_000,
      });
      let value;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
      } catch {
        throw refusal(400, "BODY_INVALID");
      }
      // The Worker's body rules: 3 or 4 keys, a missing or null version is
      // telemetry-contribution-v1.0, an unknown one 403. A known version
      // with no registered format is refused with the same 403.
      const parsed = parseUploadAuthorizationRequest(value, { maxRequestBytes: deps.maxRequestBytes });
      const format = resolveUploadAuthorizationFormat(deps.formats, parsed.telemetrySchemaVersion);
      await format.assertUploadAllowed(deps.primaryPool, device, Date.now(), { schema: deps.schema });
      return json(201, await deps.createDeviceUploadAuthorization(
        deps.primaryPool,
        device,
        { envelopeDigest: parsed.envelopeDigest, bodyBytes: parsed.contentLengthBytes },
        { schema: deps.schema },
      ));
    } catch (error) {
      return routeError(error, requestId);
    }
  }

  return defineOriginRouteModule({
    method: "POST",
    pathname: DEVICE_UPLOAD_AUTHORIZATION_PATH,
    overridesBuiltIn: true,
    handler: handleDeviceUploadAuthorization,
  });
}
