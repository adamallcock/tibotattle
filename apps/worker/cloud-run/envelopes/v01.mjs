/**
 * telemetry-envelope-v0.1 contribution envelope for the PostgreSQL origin
 * (GCP fast path, IN-3). A registry entry, not a route, dispatched after the
 * shared contributions preamble exactly like envelopes/v10.mjs.
 *
 * Retired at the switch; the composed origin does not register this module.
 * d43c8f92 still routes telemetry-envelope-v0.1 to
 * handleTelemetryContribution, and the D1 format table keeps
 * telemetry-contribution-v0.1 'accepted' (migrations/0044), but owner round
 * 12 (2026-10-02) retires v0.x uploads at the switch. The composed origin
 * (origin-intake-composition.mjs) registers a retired envelope and a retired
 * format for v0.1 and v0.2 instead, and each answers 503
 * POSTGRES_ROUTE_NOT_PORTED before any upload authorization is claimed. This
 * module and its port, admitPostgresTelemetryV01Contribution in
 * src/postgres-legacy-contribution-admission.ts, are kept only for
 * postgres-test/postgres-legacy-contribution-admission.spec.mjs, which proves
 * the port against primary 0061 and legacy_contribution_admission. Do not
 * register this module in a production or staging composition. Re-admitting
 * v0.1 uploads would need a new owner decision. It would also need this
 * envelope, the port and a live v0.1 upload-authorization format
 * (upload-authorization-formats.mjs RETAINED_V0_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS)
 * registered together, in place of the retired pair.
 *
 * Arguments are those of envelopes/v10.mjs; the context needs primaryPool,
 * schema, objectStore, envelopePublicJwk and envelopePrivateJwk. As there,
 * the exact envelope key occurrences are checked first (400
 * ENVELOPE_INVALID) and the preamble abandons the claim on every throw.
 */
import { registerContributionEnvelope } from "../contribution-envelope-registry.mjs";
import { hasExactEnvelopeKeyOccurrences } from "./legacy-envelope-keys.mjs";

export const TELEMETRY_V01_ENVELOPE_SCHEMA_VERSION = "telemetry-envelope-v0.1";

const CONTEXT_KEYS = Object.freeze([
  "primaryPool", "schema", "objectStore", "envelopePublicJwk", "envelopePrivateJwk",
]);

function configurationError(message) {
  return new Error("TELEMETRY_V01_ENVELOPE_CONFIGURATION_INVALID: " + message);
}

function storageUnavailable() {
  return Object.assign(new Error("BACKEND_STORAGE_UNAVAILABLE"), {
    code: "BACKEND_STORAGE_UNAVAILABLE", status: 503,
  });
}

function envelopeInvalid() {
  return Object.assign(new Error("ENVELOPE_INVALID"), { code: "ENVELOPE_INVALID", status: 400 });
}

/**
 * @param {{
 *   admitTelemetryV01Contribution: (input: object) => Promise<Response>,
 * }} dependencies
 */
export function createTelemetryV01ContributionEnvelope({ admitTelemetryV01Contribution } = {}) {
  if (typeof admitTelemetryV01Contribution !== "function") {
    throw configurationError("admitTelemetryV01Contribution must be a function");
  }
  return registerContributionEnvelope(
    TELEMETRY_V01_ENVELOPE_SCHEMA_VERSION,
    async function handleTelemetryV01Envelope(body, participant, sourceDeviceId, claimed, context) {
      if (context === null || typeof context !== "object"
          || CONTEXT_KEYS.some((key) => context[key] === undefined || context[key] === null)) {
        throw storageUnavailable();
      }
      if (body === null || typeof body !== "object" || typeof body.raw !== "string"
          || participant === null || typeof participant !== "object"
          || claimed === null || typeof claimed !== "object") {
        throw storageUnavailable();
      }
      if (!hasExactEnvelopeKeyOccurrences(body.raw)) throw envelopeInvalid();
      return admitTelemetryV01Contribution({
        pool: context.primaryPool,
        schema: context.schema,
        objectStore: context.objectStore,
        envelopePublicJwk: context.envelopePublicJwk,
        envelopePrivateJwk: context.envelopePrivateJwk,
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
