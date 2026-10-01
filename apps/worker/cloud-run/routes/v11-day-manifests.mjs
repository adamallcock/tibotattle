/**
 * GET and POST /api/v1/device/telemetry/v1.1/day-manifests (route id
 * telemetry_v11_day_manifests) on the PostgreSQL origin (GCP fast path, IN-2).
 *
 * Oracle: d43c8f92 index.ts handleTelemetryV11DayManifests.
 *   POST: deviceSyncPrincipal, the processing collection control, the bounded
 *         JSON manifest, registerPostgresTelemetryV11DayManifest, then the
 *         exact staged chunk vector; 201 { ...candidate, stagedChunks }.
 *   GET:  deviceSyncPrincipal, exactly one fromDay and one toDay (400
 *         BODY_INVALID otherwise), readPostgresTelemetryV11DayCandidates; 200.
 * Any other method is 405 with Allow: GET, POST.
 *
 * Two modules share one handler because a route module carries one method.
 * Not a built-in of the origin: it is mounted through v11-composition.mjs's
 * pathname dispatch, which hands every method to this handler so a wrong one
 * gets the Worker's 405 (IN-2 hand-off to the lead).
 */

import { defineOriginRouteModule } from "../origin-route-modules.mjs";
import {
  deviceSyncPrincipal,
  jsonResponse,
  methodNotAllowed,
  readBoundedJson,
  routeErrorResponse,
  routeFailure,
  routeConfigurationError,
  validateDeviceRouteDependencies,
} from "./v11-route-support.mjs";

export const TELEMETRY_V11_DAY_MANIFESTS_PATH = "/api/v1/device/telemetry/v1.1/day-manifests";

export function createTelemetryV11DayManifestRouteModules(dependencies) {
  const route = "telemetry_v11_day_manifests";
  const deps = validateDeviceRouteDependencies(route, dependencies);
  for (const name of ["registerDayManifest", "readDayChunkVector", "readDayCandidates"]) {
    if (typeof deps[name] !== "function") throw routeConfigurationError(route, name + " must be a function");
  }
  const options = Object.freeze({ schema: deps.schema });

  async function handleTelemetryV11DayManifests(request) {
    try {
      if (request.method !== "GET" && request.method !== "POST") throw methodNotAllowed(["GET", "POST"]);
      const device = await deviceSyncPrincipal(request, deps, request.method);
      const principal = { participantId: device.participantId, deviceId: device.deviceId };
      if (request.method === "POST") {
        await deps.assertCollectionControl(deps.primaryPool, deps.schema.primarySchema, "processing");
        const body = await readBoundedJson(request, deps.readBoundedRequestBody, deps.maxRequestBytes);
        const candidate = await deps.registerDayManifest(deps.primaryPool, principal, body.value, Date.now(), options);
        const stagedChunks = await deps.readDayChunkVector(deps.primaryPool, principal, candidate.manifestId, options);
        return jsonResponse(201, { ...candidate, stagedChunks });
      }
      const query = new URL(request.url).searchParams;
      if ([...query.keys()].some((key) => key !== "fromDay" && key !== "toDay")
          || query.getAll("fromDay").length !== 1 || query.getAll("toDay").length !== 1) {
        throw routeFailure(400, "BODY_INVALID");
      }
      return jsonResponse(200, await deps.readDayCandidates(deps.primaryPool, principal, {
        fromDay: query.get("fromDay"), toDay: query.get("toDay"),
      }, options));
    } catch (error) {
      return routeErrorResponse(error);
    }
  }

  return Object.freeze([
    defineOriginRouteModule({
      method: "GET", pathname: TELEMETRY_V11_DAY_MANIFESTS_PATH, overridesBuiltIn: false,
      handler: handleTelemetryV11DayManifests,
    }),
    defineOriginRouteModule({
      method: "POST", pathname: TELEMETRY_V11_DAY_MANIFESTS_PATH, overridesBuiltIn: false,
      handler: handleTelemetryV11DayManifests,
    }),
  ]);
}
