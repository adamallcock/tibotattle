/**
 * POST /api/v1/me/device-telemetry-consents (route id telemetry_v11_consent)
 * on the PostgreSQL origin (GCP fast path, IN-2).
 *
 * Oracle: d43c8f92 index.ts handleTelemetryV11Consent. Order and answers:
 * 405 for another method; the personal session (cookie, no bearer; a
 * deleted participant's session fails it, there is no deletion-ledger
 * tombstone read); CSRF; the uploadRegistration collection control; the
 * social consent version (400 TELEMETRY_REQUIRED); the Worker's bounded JSON
 * body with exactly deviceId, consent and ongoingUpload: true (400
 * BODY_INVALID otherwise); then grantPostgresTelemetryV11Consent, answered
 * 201 with Vary: Cookie.
 *
 * Not a built-in of the origin: it is mounted through v11-composition.mjs's
 * pathname dispatch, which hands every method to this handler so a wrong one
 * gets the Worker's 405 (IN-2 hand-off to the lead).
 */

import { defineOriginRouteModule } from "../origin-route-modules.mjs";
import {
  jsonResponse,
  methodNotAllowed,
  readBoundedJson,
  routeConfigurationError,
  routeErrorResponse,
  routeFailure,
  storageUnavailable,
} from "./v11-route-support.mjs";

export const TELEMETRY_V11_CONSENT_PATH = "/api/v1/me/device-telemetry-consents";
const CONSENT_KEYS = Object.freeze(["consent", "deviceId", "ongoingUpload"]);

export function createTelemetryV11ConsentRouteModule(dependencies) {
  const route = "telemetry_v11_consent";
  if (dependencies === null || typeof dependencies !== "object") {
    throw routeConfigurationError(route, "dependencies must be an object");
  }
  for (const name of ["authenticatePersonalSession", "assertPersonalSessionCsrf",
    "assertCollectionControl", "grantConsent", "readBoundedRequestBody"]) {
    if (typeof dependencies[name] !== "function") throw routeConfigurationError(route, name + " must be a function");
  }
  const { primaryPool, schema, maxRequestBytes, socialConsentVersion } = dependencies;
  if (!primaryPool || typeof primaryPool.connect !== "function"
      || schema === null || typeof schema !== "object" || typeof schema.primarySchema !== "string"
      || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1
      || typeof socialConsentVersion !== "string" || socialConsentVersion.length < 1) {
    throw routeConfigurationError(route, "pool, schema, maxRequestBytes and socialConsentVersion are required");
  }
  const deps = Object.freeze({ ...dependencies });

  async function handleTelemetryV11Consent(request) {
    try {
      if (request.method !== "POST") throw methodNotAllowed(["POST"]);
      if (request.headers.has("authorization")) throw routeFailure(401, "AUTH_INVALID");
      const session = await deps.authenticatePersonalSession(
        deps.primaryPool, request.headers.get("cookie"), { schema: deps.schema },
      );
      if (session === null || typeof session !== "object"
          || typeof session.participantId !== "string" || typeof session.sessionId !== "string"
          || typeof session.csrfToken !== "string"
          || (session.consentVersion !== null && typeof session.consentVersion !== "string")) {
        throw storageUnavailable();
      }
      deps.assertPersonalSessionCsrf(request, session.csrfToken);
      await deps.assertCollectionControl(deps.primaryPool, deps.schema.primarySchema, "uploadRegistration");
      if (session.consentVersion !== deps.socialConsentVersion) throw routeFailure(400, "TELEMETRY_REQUIRED");
      const { value } = await readBoundedJson(request, deps.readBoundedRequestBody, deps.maxRequestBytes);
      if (value === null || typeof value !== "object" || Array.isArray(value)
          || Object.keys(value).length !== CONSENT_KEYS.length
          || Object.keys(value).some((key) => !CONSENT_KEYS.includes(key))
          || typeof value.deviceId !== "string" || value.ongoingUpload !== true) {
        throw routeFailure(400, "BODY_INVALID");
      }
      const granted = await deps.grantConsent(deps.primaryPool, {
        participantId: session.participantId, sessionId: session.sessionId, deviceId: value.deviceId,
      }, value.consent, Date.now(), { schema: deps.schema });
      return jsonResponse(201, granted, { vary: "Cookie" });
    } catch (error) {
      return routeErrorResponse(error);
    }
  }

  return defineOriginRouteModule({
    method: "POST",
    pathname: TELEMETRY_V11_CONSENT_PATH,
    overridesBuiltIn: false,
    handler: handleTelemetryV11Consent,
  });
}
