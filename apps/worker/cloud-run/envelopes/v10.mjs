/**
 * telemetry-envelope-v1.0 contribution envelope for the PostgreSQL origin
 * (GCP fast path, IN-3). A registry entry, not a route: the composition root
 * passes the returned registration to createContributionEnvelopeRegistry()
 * next to v1.2, and POST /api/v1/contributions dispatches to it only after
 * the shared preamble (bearer auth, upload-authorization claim, tombstone,
 * transport floor). The work is the d43c8f92 handleTelemetryV1Contribution
 * port in src/postgres-legacy-contribution-admission.ts, injected here so
 * this file stays plain JavaScript that node:test can load.
 *
 * Handler arguments, as the preamble supplies them:
 *   body           { raw: string, value: unknown } - the exact claimed HTTP
 *                  body and its parsed JSON (the Worker's readBoundedJson).
 *   participant    { id, consentVersion, ownerKind } - the active participant
 *                  the claim resolved.
 *   sourceDeviceId issued_by_device_id of the claimed upload authorization.
 *   claimed        { authorizationId, participantId, authorizationKind }.
 *   context        { primaryPool, schema, objectStore, envelopePublicJwk,
 *                    envelopePrivateJwk, typedV1SourceNamespace, nowEpoch? }.
 *
 * It returns the Worker's 202 receipt (fresh or replayed) or throws the
 * Worker's ApiError; the preamble abandons the claim on a throw and records
 * the receipt (recordPostgresDeviceUploadReceipt) after a 202.
 */
import { registerContributionEnvelope } from "../contribution-envelope-registry.mjs";

export const TELEMETRY_V10_ENVELOPE_SCHEMA_VERSION = "telemetry-envelope-v1.0";

const CONTEXT_KEYS = Object.freeze([
  "primaryPool", "schema", "objectStore", "envelopePublicJwk", "envelopePrivateJwk",
  "typedV1SourceNamespace",
]);

function configurationError(message) {
  return new Error("TELEMETRY_V10_ENVELOPE_CONFIGURATION_INVALID: " + message);
}

function storageUnavailable() {
  return Object.assign(new Error("BACKEND_STORAGE_UNAVAILABLE"), {
    code: "BACKEND_STORAGE_UNAVAILABLE", status: 503,
  });
}

/**
 * @param {{
 *   admitTelemetryV1Contribution: (input: object) => Promise<Response>,
 * }} dependencies
 */
export function createTelemetryV10ContributionEnvelope({ admitTelemetryV1Contribution } = {}) {
  if (typeof admitTelemetryV1Contribution !== "function") {
    throw configurationError("admitTelemetryV1Contribution must be a function");
  }
  return registerContributionEnvelope(
    TELEMETRY_V10_ENVELOPE_SCHEMA_VERSION,
    async function handleTelemetryV10Envelope(body, participant, sourceDeviceId, claimed, context) {
      // A composition error is the origin's fault, never the client's: answer
      // the constant 503 rather than a code that would make a client retry
      // a different request shape.
      if (context === null || typeof context !== "object"
          || CONTEXT_KEYS.some((key) => context[key] === undefined || context[key] === null)) {
        throw storageUnavailable();
      }
      if (body === null || typeof body !== "object" || typeof body.raw !== "string"
          || participant === null || typeof participant !== "object"
          || claimed === null || typeof claimed !== "object") {
        throw storageUnavailable();
      }
      return admitTelemetryV1Contribution({
        pool: context.primaryPool,
        schema: context.schema,
        objectStore: context.objectStore,
        envelopePublicJwk: context.envelopePublicJwk,
        envelopePrivateJwk: context.envelopePrivateJwk,
        sourceNamespace: context.typedV1SourceNamespace,
        body: { raw: body.raw, value: body.value },
        participant: { id: participant.id, consentVersion: participant.consentVersion ?? null },
        deviceId: sourceDeviceId,
        authorization: {
          authorizationId: claimed.authorizationId,
          authorizationKind: claimed.authorizationKind,
        },
        ...(context.nowEpoch === undefined ? {} : { nowEpoch: context.nowEpoch }),
      });
    },
  );
}
