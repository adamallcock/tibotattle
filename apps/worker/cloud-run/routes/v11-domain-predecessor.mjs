/**
 * POST /api/v1/me/telemetry-v11/domain-predecessor (route id
 * telemetry_v11_domain_predecessor) on the PostgreSQL origin (GCP fast path,
 * IN-2).
 *
 * Oracle: d43c8f92 index.ts handleTelemetryV11Domain(activate = false):
 * deviceSyncPrincipal(POST), the processing collection control, the bounded
 * JSON body, which must be exactly {} (400 BODY_INVALID), then
 * createPostgresTelemetryV11Domain().createPredecessor; 201.
 *
 * Not a built-in of the origin: it is mounted through v11-composition.mjs's
 * pathname dispatch, which hands every method to this handler so a wrong one
 * gets the Worker's 405 (IN-2 hand-off to the lead).
 */

import { defineOriginRouteModule } from "../origin-route-modules.mjs";
import {
  deviceSyncPrincipal,
  jsonResponse,
  readBoundedJson,
  routeConfigurationError,
  routeErrorResponse,
  routeFailure,
  validateDeviceRouteDependencies,
  routeRequestId,
} from "./v11-route-support.mjs";

export const TELEMETRY_V11_DOMAIN_PREDECESSOR_PATH = "/api/v1/me/telemetry-v11/domain-predecessor";

export function createTelemetryV11DomainPredecessorRouteModule(dependencies) {
  const route = "telemetry_v11_domain_predecessor";
  const deps = validateDeviceRouteDependencies(route, dependencies);
  if (typeof deps.createDomain !== "function") throw routeConfigurationError(route, "createDomain must be a function");

  async function handleTelemetryV11DomainPredecessor(request) {
    try {
      const device = await deviceSyncPrincipal(request, deps, "POST");
      await deps.assertCollectionControl(deps.primaryPool, deps.schema.primarySchema, "processing");
      const body = await readBoundedJson(request, deps.readBoundedRequestBody, deps.maxRequestBytes);
      if (body.value === null || typeof body.value !== "object" || Array.isArray(body.value)
          || Object.keys(body.value).length !== 0) {
        throw routeFailure(400, "BODY_INVALID");
      }
      const domain = deps.createDomain(deps.primaryPool, { schema: deps.schema });
      return jsonResponse(201, await domain.createPredecessor(
        { participantId: device.participantId, deviceId: device.deviceId }, Date.now(),
      ));
    } catch (error) {
      return routeErrorResponse(error, routeRequestId(deps, request));
    }
  }

  return defineOriginRouteModule({
    method: "POST", pathname: TELEMETRY_V11_DOMAIN_PREDECESSOR_PATH, overridesBuiltIn: false,
    handler: handleTelemetryV11DomainPredecessor,
  });
}
