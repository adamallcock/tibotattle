/**
 * POST /api/v1/me/telemetry-v11/domain-activate (route id
 * telemetry_v11_domain_activate) on the PostgreSQL origin (GCP fast path,
 * IN-2).
 *
 * Oracle: d43c8f92 index.ts handleTelemetryV11Domain(activate = true):
 * deviceSyncPrincipal(POST), the processing collection control, the bounded
 * JSON domain manifest, then createPostgresTelemetryV11Domain().activate,
 * which validates the closed manifest schema; 201 (also for a replay or an
 * unchanged acknowledgement, as the Worker answers).
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
  validateDeviceRouteDependencies,
} from "./v11-route-support.mjs";

export const TELEMETRY_V11_DOMAIN_ACTIVATE_PATH = "/api/v1/me/telemetry-v11/domain-activate";

export function createTelemetryV11DomainActivateRouteModule(dependencies) {
  const route = "telemetry_v11_domain_activate";
  const deps = validateDeviceRouteDependencies(route, dependencies);
  if (typeof deps.createDomain !== "function") throw routeConfigurationError(route, "createDomain must be a function");

  async function handleTelemetryV11DomainActivate(request) {
    try {
      const device = await deviceSyncPrincipal(request, deps, "POST");
      await deps.assertCollectionControl(deps.primaryPool, deps.schema.primarySchema, "processing");
      const body = await readBoundedJson(request, deps.readBoundedRequestBody, deps.maxRequestBytes);
      const domain = deps.createDomain(deps.primaryPool, { schema: deps.schema });
      return jsonResponse(201, await domain.activate(
        { participantId: device.participantId, deviceId: device.deviceId }, body.value, Date.now(),
      ));
    } catch (error) {
      return routeErrorResponse(error);
    }
  }

  return defineOriginRouteModule({
    method: "POST", pathname: TELEMETRY_V11_DOMAIN_ACTIVATE_PATH, overridesBuiltIn: false,
    handler: handleTelemetryV11DomainActivate,
  });
}
