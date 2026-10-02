/**
 * Shared plumbing for the six admin console route families on the
 * PostgreSQL origin (GCP, C-ADMIN).
 *
 * Authorization follows d43c8f92 handleRequest's admin-hostname branch. The
 * composition root runs the Access chokepoint (src/postgres-admin-access.ts:
 * verifyAdminAccessAssertion, then authorizeAdminEmail against
 * ACCESS_ADMIN_EMAIL) before any admin route, exactly where the Worker runs
 * it, and registers the resulting identity key in the request context
 * (FC-4). A family never re-verifies Access: it reads the registered key and
 * refuses with 403 ADMIN_REQUIRED when there is none, so a root that forgot
 * the chokepoint fails closed instead of serving the owner surface.
 *
 * Responses use the family contract (FC-5): 200 bodies carry the Worker's
 * `cache-control: no-store` and `vary: Cookie`; every refusal is the Worker
 * error envelope with no-store, Allow only on a 405 and never retry-after.
 * Families never log (FC-6); the root classifies and records responses.
 */

import { ApiError } from "../../src/errors.ts";
import {
  adminIdentityFor,
  apiErrorToResponse,
  requestIdFor,
  workerJson,
} from "../postgres-family-contract.mjs";

/** handleAdmin* response headers (index.ts at d43c8f92). */
export const ADMIN_RESPONSE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  vary: "Cookie",
});

/** The code an unported admin task answers (OD-CR-3 vocabulary; no retry-after, OD-CR-6 iv). */
export const ADMIN_TASK_NOT_PORTED_CODE = "POSTGRES_ROUTE_NOT_PORTED";

export const ADMIN_ROUTE_CONFIGURATION_INVALID = "ADMIN_ROUTE_CONFIGURATION_INVALID";

export function adminRouteConfigurationError(route, message) {
  return Object.assign(
    new TypeError(`${ADMIN_ROUTE_CONFIGURATION_INVALID}: ${route}: ${message}`),
    { code: ADMIN_ROUTE_CONFIGURATION_INVALID },
  );
}

/** Validate the FC-3 dependencies every admin family reads. */
export function assertAdminFamilyDeps(route, deps) {
  if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
    throw adminRouteConfigurationError(route, "deps");
  }
  if (typeof deps.requestContext !== "function") {
    throw adminRouteConfigurationError(route, "requestContext");
  }
  if (deps.clock !== undefined && typeof deps.clock !== "function") {
    throw adminRouteConfigurationError(route, "clock");
  }
  return deps;
}

/** An optional injected adapter: undefined, or a function. */
export function optionalFunction(route, name, value) {
  if (value !== undefined && typeof value !== "function") {
    throw adminRouteConfigurationError(route, name);
  }
  return value;
}

/** A mandatory injected adapter. */
export function requiredFunction(route, name, value) {
  if (typeof value !== "function") throw adminRouteConfigurationError(route, name);
  return value;
}

/** The registered owner identity key, or 403 ADMIN_REQUIRED. */
export function requireAdminIdentity(deps, request) {
  const identityKey = adminIdentityFor(deps, request);
  if (identityKey === null) throw new ApiError(403, "ADMIN_REQUIRED");
  return identityKey;
}

/** The Worker's methodNotAllowed: 405 METHOD_NOT_ALLOWED with Allow. */
export function assertAdminMethod(request, method) {
  if (request.method === method) return;
  const error = new ApiError(405, "METHOD_NOT_ALLOWED");
  Object.defineProperty(error, "allowed", { value: Object.freeze([method]) });
  throw error;
}

export function adminOk(body) {
  return workerJson(200, body, ADMIN_RESPONSE_HEADERS);
}

/** 503 POSTGRES_ROUTE_NOT_PORTED for an admin task with no PostgreSQL port yet. */
export function adminTaskNotPorted() {
  return new ApiError(503, ADMIN_TASK_NOT_PORTED_CODE);
}

/** The clock a family reads: the injected one, or Date.now. */
export function familyClock(deps) {
  return deps.clock ?? Date.now;
}

/**
 * Wrap a handler: any throw becomes the Worker error envelope under the
 * root's request id. The dispatcher takes exactly one argument (FC-2).
 */
export function adminFamilyDispatcher(deps, handler) {
  return async function adminFamilyDispatch(request) {
    try {
      return await handler(request);
    } catch (error) {
      return apiErrorToResponse(error, requestIdFor(deps, request));
    }
  };
}
