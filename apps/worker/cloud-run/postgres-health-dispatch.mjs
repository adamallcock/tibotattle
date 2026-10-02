/**
 * RD-3: GET /api/health on the Cloud Run origin (CR-6/CR-7, D-CRB).
 *
 * The d43c8f92 health body, minus checks.deletionLedger and
 * capabilities.deletionSafeRestoreReplay (the accepted append-only decision
 * record), built by src/postgres-health.ts buildPostgresHealthBody. Each
 * evaluation runs in the Worker's order (index.ts, route 'health'):
 * configuredEnrollmentMode(env); the shared preflight
 * (originStatusPreflight); the collection controls; the retention row and
 * SELECT 1 (src/postgres-health.ts readers, on the readiness pool); the
 * object-store shape and a head of the probe key (the GCS quarantine store,
 * which answers a missing key with the OD-2 bucket birth proof); the
 * deployment source commit. The Worker's deletion-ledger probe is dropped
 * with the ledger. A raw failure is 500 INTERNAL_ERROR.
 *
 * The two capability flags the origin cannot serve are derived from the
 * route registry (owner decision OD-CR-5): participantExport and
 * coordinatedSignInAdmission are false while participant_export and the
 * Google sign-in start are unported (healthCapabilityFlags).
 *
 * Single flight as RD-2 (STATUS_REUSE_MILLISECONDS). A route family (FC-2).
 */

import { configuredEnrollmentMode } from "../src/admission.ts";
import { ApiError, jsonResponse } from "../src/errors.ts";
import {
  buildPostgresHealthBody,
  postgresDeploymentSourceCommit,
  readPostgresHealthControls,
  readPostgresHealthRetention,
} from "../src/postgres-health.ts";
import { apiErrorToResponse, requestIdFor } from "./postgres-family-contract.mjs";
import { ORIGIN_ROUTE_DISPOSITIONS } from "./postgres-production-registry.mjs";
import { methodNotAllowedGet, originStatusPreflight, singleFlight } from "./postgres-readiness-dispatch.mjs";

/** The Worker's health probe key (index.ts, route 'health'). */
export const HEALTH_PROBE_OBJECT_KEY = "__usage_monitor_health_probe__";

/**
 * OD-CR-5: each health capability flag the origin derives from the route
 * registry, and the route ids that must ALL be ported for it to be true.
 * participantExport is the export route (retired, OD-CR-2); the Worker's
 * coordinatedSignInAdmission is the coordinated Google sign-in start.
 */
export const HEALTH_CAPABILITY_ROUTE_IDS = Object.freeze({
  participantExport: Object.freeze(["participant_export"]),
  coordinatedSignInAdmission: Object.freeze(["identity_google_start"]),
});

export const HEALTH_DISPATCH_CONFIGURATION_INVALID = "HEALTH_DISPATCH_CONFIGURATION_INVALID";

function configurationError(name) {
  return Object.assign(new TypeError(`${HEALTH_DISPATCH_CONFIGURATION_INVALID}: ${name}`), {
    code: HEALTH_DISPATCH_CONFIGURATION_INVALID,
  });
}

function isPool(value) {
  return value !== null && typeof value === "object" && typeof value.connect === "function";
}

/**
 * OD-CR-5: the capability flags from a resolver over route ids (the CR-6
 * registry's resolve, or the production ported list before the registry
 * exists): a flag is true only when every route it names is ported.
 */
export function healthCapabilityFlags(isPorted) {
  if (typeof isPorted !== "function") throw configurationError("isPorted");
  return Object.freeze(Object.fromEntries(Object.entries(HEALTH_CAPABILITY_ROUTE_IDS)
    .map(([flag, ids]) => [flag, ids.every((id) => isPorted(id) === true)])));
}

/** The registry-backed resolver healthCapabilityFlags takes. */
export function registryPorted(registry) {
  return (id) => registry.resolve(id).disposition === ORIGIN_ROUTE_DISPOSITIONS.PORTED;
}

function storeShapeValid(objectStore) {
  return objectStore !== null && typeof objectStore === "object"
    && typeof objectStore.head === "function"
    && typeof objectStore.put === "function"
    && typeof objectStore.delete === "function";
}

/**
 * deps (FC-3): requestContext, env (the frozen origin env), readinessPool,
 * primarySchema, objectStore (the quarantine store), capabilityFlags (from
 * healthCapabilityFlags), clock? (Date.now). Returns async (request) =>
 * Response.
 */
export function createPostgresHealthDispatch(deps) {
  if (deps === null || typeof deps !== "object") throw configurationError("deps");
  const { requestContext, env, readinessPool, primarySchema, objectStore, capabilityFlags } = deps;
  const clock = deps.clock ?? Date.now;
  if (typeof requestContext !== "function") throw configurationError("requestContext");
  if (env === null || typeof env !== "object" || !Object.isFrozen(env)) throw configurationError("env");
  if (!isPool(readinessPool)) throw configurationError("readinessPool");
  if (typeof primarySchema !== "string") throw configurationError("primarySchema");
  if (objectStore === null || typeof objectStore !== "object") throw configurationError("objectStore");
  if (capabilityFlags === null || typeof capabilityFlags !== "object" || !Object.isFrozen(capabilityFlags)) {
    throw configurationError("capabilityFlags");
  }
  if (typeof clock !== "function") throw configurationError("clock");
  const evaluate = singleFlight(async () => {
    const enrollmentMode = configuredEnrollmentMode(env);
    await originStatusPreflight(env);
    const controls = await readPostgresHealthControls(readinessPool, primarySchema);
    if (!storeShapeValid(objectStore)) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    const retention = await readPostgresHealthRetention(readinessPool, primarySchema);
    await objectStore.head(HEALTH_PROBE_OBJECT_KEY);
    const sourceCommit = postgresDeploymentSourceCommit(env);
    return buildPostgresHealthBody({ env, enrollmentMode, controls, retention, sourceCommit, capabilityFlags });
  }, clock);
  return async function dispatchPostgresHealth(request) {
    try {
      if (request.method !== "GET") throw methodNotAllowedGet();
      return jsonResponse(await evaluate(), 200, { "cache-control": "no-store" });
    } catch (error) {
      return apiErrorToResponse(error, requestIdFor({ requestContext }, request));
    }
  };
}
