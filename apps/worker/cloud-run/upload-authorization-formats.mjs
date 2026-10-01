/**
 * Legacy upload-authorization formats for the PostgreSQL origin (GCP fast
 * path, IN-3).
 *
 * POST /api/v1/device/upload-authorizations validates telemetrySchemaVersion
 * through the table createUploadAuthorizationFormats() builds
 * (contribution-envelope-registry.mjs, IN-1). This module supplies the
 * entries for the formats the d43c8f92 Worker still authorizes besides v1.2,
 * plus the Worker's request-body parser. The route module that uses both,
 * routes/upload-authorizations.mjs, must replace the v1.2-only built-in
 * route whenever these formats are registered, so the origin answers exactly
 * as handleDeviceUploadAuthorization (apps/worker/src/index.ts at d43c8f92):
 *
 *   1. The body is an object with 3 or 4 keys drawn from envelopeDigest,
 *      contentLengthBytes, contentType and telemetrySchemaVersion; the digest
 *      is 64 lowercase hex; contentLengthBytes is a safe integer in
 *      1..MAX_REQUEST_BYTES; contentType is application/json. Anything else
 *      is 400 BODY_INVALID. This is the only size check: every format shares
 *      the 2 MiB request bound (a v1.0 chunk's 1,250,000-byte canonical
 *      bound is enforced at ingest, not here).
 *   2. A missing telemetrySchemaVersion means telemetry-contribution-v1.0.
 *      A value outside the five transport identifiers is 403
 *      TELEMETRY_TRANSPORT_BLOCKED (telemetryTransportSchemaVersion).
 *   3. The format's write authority decides, with the Worker's codes. For
 *      every legacy format that is assertTelemetryTransportWriteAllowed,
 *      which the PostgreSQL port (src/postgres-transport-write-authority.ts,
 *      TA-1) reproduces: no joined row 401 DEVICE_AUTH_INVALID; non-accepted
 *      lifecycle or a rank under the floor 403 TELEMETRY_TRANSPORT_BLOCKED;
 *      v1.1 without the social consent or the accountless v1.1 grant chain
 *      403 TELEMETRY_CONSENT_INVALID. That consent refusal is the only
 *      consent check the Worker runs before issuing an authorization; the
 *      v1.0 consent-once grant is checked at ingest (403
 *      TELEMETRY_CONSENT_INVALID from the chunk handler).
 *
 * The write-authority function is injected by the composition root, so this
 * file stays plain JavaScript with no imports and node:test can load it.
 */

export const DEFAULT_UPLOAD_AUTHORIZATION_SCHEMA_VERSION = "telemetry-contribution-v1.0";

/** Formats IN-3 registers tonight, as the brief names them. */
export const LEGACY_V1_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS = Object.freeze([
  "telemetry-contribution-v1.0",
  "telemetry-contribution-v1.1",
]);

/**
 * The retained v0.x formats. d43c8f92 still authorizes v0.1 for a
 * participant whose floor is rank 1 (format lifecycle 'accepted' since D1
 * 0044) and refuses v0.2 through its 'blocked' lifecycle. Register these
 * only together with a telemetry-envelope-v0.1 handler; until then an
 * authorization the origin issued could not be redeemed.
 */
export const RETAINED_V0_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS = Object.freeze([
  "telemetry-contribution-v0.1",
  "telemetry-contribution-v0.2",
]);

/** Every identifier telemetryTransportSchemaVersion accepts at d43c8f92. */
export const TRANSPORT_SCHEMA_VERSIONS = Object.freeze([
  "telemetry-contribution-v0.1",
  "telemetry-contribution-v0.2",
  "telemetry-contribution-v1.0",
  "telemetry-contribution-v1.1",
  "telemetry-contribution-v1.2",
]);

const BODY_KEYS = Object.freeze([
  "envelopeDigest", "contentLengthBytes", "contentType", "telemetrySchemaVersion",
]);
const DIGEST = /^[0-9a-f]{64}$/u;

function refusal(status, code) {
  return Object.assign(new Error(code), { code, status });
}

function formatsError(message) {
  return new Error("UPLOAD_AUTHORIZATION_FORMAT_INVALID: " + message);
}

/**
 * The Worker's request-body check (index.ts handleDeviceUploadAuthorization
 * at d43c8f92), including the v1.0 default. Throws the Worker's refusal.
 *
 * @param {unknown} value parsed JSON body
 * @param {{ maxRequestBytes: number }} options
 * @returns {Readonly<{ envelopeDigest: string, contentLengthBytes: number, telemetrySchemaVersion: string }>}
 */
export function parseUploadAuthorizationRequest(value, { maxRequestBytes }) {
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    throw formatsError("maxRequestBytes must be a positive safe integer");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw refusal(400, "BODY_INVALID");
  }
  const keys = Object.keys(value);
  if (![3, 4].includes(keys.length)
      || keys.some((key) => !BODY_KEYS.includes(key))
      || typeof value.envelopeDigest !== "string"
      || !DIGEST.test(value.envelopeDigest)
      || !Number.isSafeInteger(value.contentLengthBytes)
      || value.contentLengthBytes <= 0
      || value.contentLengthBytes > maxRequestBytes
      || value.contentType !== "application/json") {
    throw refusal(400, "BODY_INVALID");
  }
  // Like the Worker, an explicit null falls back to the default too (`??`).
  const declared = value.telemetrySchemaVersion ?? DEFAULT_UPLOAD_AUTHORIZATION_SCHEMA_VERSION;
  if (typeof declared !== "string" || !TRANSPORT_SCHEMA_VERSIONS.includes(declared)) {
    throw refusal(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  return Object.freeze({
    envelopeDigest: value.envelopeDigest,
    contentLengthBytes: value.contentLengthBytes,
    telemetrySchemaVersion: declared,
  });
}

/**
 * Resolve a parsed telemetrySchemaVersion to its registered format. A known
 * transport identifier with no registered format is refused with the same
 * 403 TELEMETRY_TRANSPORT_BLOCKED the Worker gives an unknown identifier,
 * so an unregistered format can never mint an authorization.
 *
 * @param {{ resolve: (version: unknown) => unknown }} formats
 * @param {string} telemetrySchemaVersion
 */
export function resolveUploadAuthorizationFormat(formats, telemetrySchemaVersion) {
  if (formats === null || typeof formats !== "object" || typeof formats.resolve !== "function") {
    throw formatsError("formats must come from createUploadAuthorizationFormats()");
  }
  const format = formats.resolve(telemetrySchemaVersion);
  if (format === null || format === undefined) throw refusal(403, "TELEMETRY_TRANSPORT_BLOCKED");
  return format;
}

/**
 * Build plain format entries for createUploadAuthorizationFormats(). Each
 * entry runs the injected transport write authority for its own identifier
 * through a pool, in its own bounded read (the Worker reads D1 outside any
 * transaction here too).
 *
 * @param {{
 *   assertTelemetryTransportWriteAllowed: (
 *     pool: unknown, principal: unknown, schemaVersion: string,
 *     options: { nowEpoch: number, schema: unknown },
 *   ) => unknown,
 *   schemaVersions?: readonly string[],
 * }} options
 * @returns {Readonly<Record<string, Readonly<{ assertUploadAllowed: Function }>>>}
 */
export function legacyUploadAuthorizationFormatEntries({
  assertTelemetryTransportWriteAllowed,
  schemaVersions = LEGACY_V1_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS,
} = {}) {
  if (typeof assertTelemetryTransportWriteAllowed !== "function") {
    throw formatsError("assertTelemetryTransportWriteAllowed must be a function");
  }
  if (!Array.isArray(schemaVersions) || schemaVersions.length < 1) {
    throw formatsError("schemaVersions must be a non-empty array");
  }
  const allowed = [
    ...LEGACY_V1_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS,
    ...RETAINED_V0_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS,
  ];
  /** @type {Record<string, Readonly<{ assertUploadAllowed: Function }>>} */
  const entries = {};
  for (const schemaVersion of schemaVersions) {
    if (!allowed.includes(schemaVersion)) {
      throw formatsError(String(schemaVersion) + " is not a legacy upload-authorization format");
    }
    if (Object.hasOwn(entries, schemaVersion)) {
      throw formatsError("duplicate format " + schemaVersion);
    }
    entries[schemaVersion] = Object.freeze({
      assertUploadAllowed(pool, device, nowEpoch, { schema } = {}) {
        return assertTelemetryTransportWriteAllowed(pool, device, schemaVersion, { nowEpoch, schema });
      },
    });
  }
  return Object.freeze(entries);
}
