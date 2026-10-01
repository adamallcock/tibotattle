/**
 * Shared request plumbing for the v1.1 origin route modules (GCP fast path,
 * IN-2): the Worker's readBoundedJson, deviceSyncPrincipal and error body,
 * over injected PostgreSQL adapters. Plain JavaScript with no imports, so
 * node:test specs load the route modules directly.
 */

export function routeFailure(status, code, responseHeaders) {
  return Object.assign(new Error(code), {
    code, status, ...(responseHeaders ? { responseHeaders } : {}),
  });
}

export function storageUnavailable() {
  return routeFailure(503, "BACKEND_STORAGE_UNAVAILABLE");
}

export function routeConfigurationError(route, message) {
  return Object.assign(new Error("TELEMETRY_V11_ROUTE_CONFIGURATION_INVALID: " + route + ": " + message), {
    code: "TELEMETRY_V11_ROUTE_CONFIGURATION_INVALID",
  });
}

export function jsonResponse(status, value, additionalHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...additionalHeaders,
    },
  });
}

/**
 * The Worker's catch path (index.ts, family contract FC-5): a closed
 * ApiError-shaped error keeps its status, code, details and headers; anything
 * else is 500 INTERNAL_ERROR, and no thrown message reaches the body. Storage
 * failures arrive here already closed as 503 BACKEND_STORAGE_UNAVAILABLE.
 */
export function routeErrorResponse(error) {
  const closed = Number.isSafeInteger(error?.status) && error.status >= 400 && error.status <= 599
    && typeof error?.code === "string" && /^[A-Z0-9_]+$/u.test(error.code);
  const effective = closed ? error : routeFailure(500, "INTERNAL_ERROR");
  const headers = {};
  if (effective.responseHeaders) {
    for (const [name, value] of new Headers(effective.responseHeaders)) headers[name] = value;
  }
  return jsonResponse(effective.status, {
    error: {
      code: effective.code,
      requestId: crypto.randomUUID(),
      ...(effective.publicDetails && typeof effective.publicDetails === "object"
        ? { details: effective.publicDetails } : {}),
    },
  }, headers);
}

/** The Worker's readBoundedJson: content type, declared length, bounded UTF-8 JSON. */
export async function readBoundedJson(request, readBoundedRequestBody, maxRequestBytes) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw routeFailure(415, "CONTENT_TYPE_INVALID");
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw routeFailure(400, "BODY_INVALID");
    if (length > maxRequestBytes) throw routeFailure(413, "BODY_TOO_LARGE");
  }
  const bytes = await readBoundedRequestBody(request, maxRequestBytes, {
    maximumTotalMilliseconds: 15_000,
    maximumIdleMilliseconds: 5_000,
  });
  try {
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return { bytes, raw, value: JSON.parse(raw) };
  } catch {
    throw routeFailure(400, "BODY_INVALID");
  }
}

export function methodNotAllowed(methods) {
  return routeFailure(405, "METHOD_NOT_ALLOWED", { allow: methods.join(", ") });
}

const DEVICE_DEPENDENCIES = Object.freeze([
  "assertAdmissionBindings", "assertAttemptAllowed", "authenticateDevice",
  "hasDeletionTombstone", "assertCollectionControl", "readBoundedRequestBody",
]);

/** Validate the bound dependencies every device-authenticated v1.1 route shares. */
export function validateDeviceRouteDependencies(route, dependencies) {
  if (dependencies === null || typeof dependencies !== "object") {
    throw routeConfigurationError(route, "dependencies must be an object");
  }
  for (const name of DEVICE_DEPENDENCIES) {
    if (typeof dependencies[name] !== "function") throw routeConfigurationError(route, name + " must be a function");
  }
  const { primaryPool, ledgerPool, schema, maxRequestBytes } = dependencies;
  if (!primaryPool || typeof primaryPool.connect !== "function"
      || !ledgerPool || typeof ledgerPool.connect !== "function"
      || schema === null || typeof schema !== "object"
      || typeof schema.primarySchema !== "string" || typeof schema.ledgerSchema !== "string"
      || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    throw routeConfigurationError(route, "pools, schema and maxRequestBytes are required");
  }
  return Object.freeze({ ...dependencies });
}

/**
 * The Worker's deviceSyncPrincipal: method, admission bindings, the
 * device_sync attempt limit, no cookie, device bearer (the generic v1.1
 * accountless gate), and the deletion tombstone.
 */
export async function deviceSyncPrincipal(request, deps, method) {
  if (request.method !== method) throw methodNotAllowed([method]);
  deps.assertAdmissionBindings(deps.admissionEnv);
  await deps.assertAttemptAllowed(
    deps.admissionEnv?.RECOVERY_RATE_LIMIT,
    deps.admissionEnv?.CLIENT_ATTEMPT_RATE_LIMIT,
    request,
    deps.admissionEnv,
    "device_sync",
  );
  if (request.headers.has("cookie")) throw routeFailure(401, "DEVICE_AUTH_INVALID");
  const device = await deps.authenticateDevice(
    deps.primaryPool, request.headers.get("authorization"), { schema: deps.schema },
  );
  if (device === null || typeof device !== "object"
      || typeof device.participantId !== "string" || typeof device.deviceId !== "string") {
    throw storageUnavailable();
  }
  if (await deps.hasDeletionTombstone(deps.ledgerPool, device.participantId, Date.now(), { schema: deps.schema })) {
    throw routeFailure(401, "DEVICE_AUTH_INVALID");
  }
  return device;
}
