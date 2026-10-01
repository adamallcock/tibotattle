/**
 * Contribution envelope and upload-authorization format seams (GCP fast
 * path, IN-1).
 *
 * POST /api/v1/contributions stays one route. Its shared preamble (bearer
 * auth, upload-authorization claim, deletion-tombstone check, transport
 * floor, receipt, abandon-on-failure) runs first; only then does the origin
 * dispatch on the envelope's body.schemaVersion through a registry built here.
 * Envelope versions are registry entries, not routes: v1.2 is registered by
 * the composition root, and the v1.1/v1.0/v0.1 ports export registrations.
 * An unregistered version must keep the origin's existing refusal unchanged;
 * resolve() returns null and the caller owns that response.
 *
 * POST /api/v1/device/upload-authorizations likewise validates
 * telemetrySchemaVersion through a format table built by
 * createUploadAuthorizationFormats().
 *
 * Both registries are built once at startup from immutable entries, so
 * registration order and import side effects cannot change routing. This
 * file is plain JavaScript with no imports so node:test specs can load it
 * directly.
 */

/**
 * The per-request context the contributions preamble hands an envelope
 * handler. The composition root (IN-1b) fixes its fields; handlers must treat
 * unknown fields as absent.
 *
 * @typedef {Readonly<Record<string, unknown>>} ContributionEnvelopeContext
 */

/**
 * Runs only after the shared preamble has authenticated the bearer, claimed
 * the upload authorization, refused tombstoned participants and enforced the
 * transport floor. If it throws, the preamble abandons the claim and maps the
 * error; it must not repeat any preamble step.
 *
 * @typedef {(
 *   body: unknown,
 *   participant: unknown,
 *   sourceDeviceId: string,
 *   claimed: unknown,
 *   context: ContributionEnvelopeContext,
 * ) => Response | Promise<Response>} ContributionEnvelopeHandler
 */

/**
 * @typedef {Readonly<{
 *   schemaVersion: string,
 *   handler: ContributionEnvelopeHandler,
 * }>} ContributionEnvelopeRegistration
 */

/**
 * @typedef {Readonly<{
 *   schemaVersions: readonly string[],
 *   has: (schemaVersion: unknown) => boolean,
 *   resolve: (schemaVersion: unknown) => ContributionEnvelopeHandler | null,
 * }>} ContributionEnvelopeRegistry
 */

/**
 * One upload-authorization format. assertUploadAllowed enforces the format's
 * transport floor for the authenticated device before an authorization is
 * issued; it throws the origin's existing refusal when the device may not
 * upload this format.
 *
 * @typedef {Readonly<{
 *   assertUploadAllowed: (
 *     pool: unknown,
 *     device: unknown,
 *     nowEpoch: number,
 *     options: Readonly<{ schema: unknown }>,
 *   ) => unknown | Promise<unknown>,
 * }>} UploadAuthorizationFormat
 */

/**
 * @typedef {Readonly<{
 *   telemetrySchemaVersions: readonly string[],
 *   has: (telemetrySchemaVersion: unknown) => boolean,
 *   resolve: (telemetrySchemaVersion: unknown) => UploadAuthorizationFormat | null,
 * }>} UploadAuthorizationFormats
 */

const ENVELOPE_SCHEMA_VERSION = /^telemetry-envelope-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const CONTRIBUTION_SCHEMA_VERSION = /^telemetry-contribution-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const FORMAT_KEYS = Object.freeze(["assertUploadAllowed"]);
const DEFINED_REGISTRATIONS = new WeakSet();

function envelopeError(message) {
  return new Error("CONTRIBUTION_ENVELOPE_REGISTRY_INVALID: " + message);
}

function formatError(message) {
  return new Error("UPLOAD_AUTHORIZATION_FORMAT_INVALID: " + message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Define the handler for one envelope schemaVersion (for example
 * "telemetry-envelope-v1.2"). Returns an immutable registration; it does not
 * mutate any shared state. Pass registrations to
 * createContributionEnvelopeRegistry().
 *
 * @param {string} schemaVersion
 * @param {ContributionEnvelopeHandler} handler
 * @returns {ContributionEnvelopeRegistration}
 */
export function registerContributionEnvelope(schemaVersion, handler) {
  if (typeof schemaVersion !== "string" || !ENVELOPE_SCHEMA_VERSION.test(schemaVersion)) {
    throw envelopeError("schemaVersion must look like telemetry-envelope-v<major>.<minor>");
  }
  if (typeof handler !== "function") {
    throw envelopeError("handler must be a function");
  }
  const registration = Object.freeze({ schemaVersion, handler });
  DEFINED_REGISTRATIONS.add(registration);
  return registration;
}

/**
 * Build the startup registry of envelope handlers. An empty list is valid and
 * resolves nothing.
 *
 * @param {readonly ContributionEnvelopeRegistration[]} registrations
 * @returns {ContributionEnvelopeRegistry}
 */
export function createContributionEnvelopeRegistry(registrations) {
  if (!Array.isArray(registrations)) {
    throw envelopeError("registrations must be an array");
  }
  /** @type {Map<string, ContributionEnvelopeHandler>} */
  const byVersion = new Map();
  for (const registration of registrations) {
    if (!DEFINED_REGISTRATIONS.has(registration)) {
      throw envelopeError("register only values returned by registerContributionEnvelope()");
    }
    if (byVersion.has(registration.schemaVersion)) {
      throw envelopeError("more than one handler claims " + registration.schemaVersion);
    }
    byVersion.set(registration.schemaVersion, registration.handler);
  }
  const schemaVersions = Object.freeze([...byVersion.keys()]);
  return Object.freeze({
    schemaVersions,
    has(schemaVersion) {
      return typeof schemaVersion === "string" && byVersion.has(schemaVersion);
    },
    resolve(schemaVersion) {
      if (typeof schemaVersion !== "string") return null;
      return byVersion.get(schemaVersion) ?? null;
    },
  });
}

/**
 * Build the upload-authorization format table from a plain object or Map of
 * telemetrySchemaVersion (for example "telemetry-contribution-v1.2") to
 * format. An empty table is valid and accepts nothing.
 *
 * @param {Readonly<Record<string, UploadAuthorizationFormat>> | ReadonlyMap<string, UploadAuthorizationFormat>} map
 * @returns {UploadAuthorizationFormats}
 */
export function createUploadAuthorizationFormats(map) {
  /** @type {[unknown, unknown][]} */
  let entries;
  if (map instanceof Map) {
    entries = [...map.entries()];
  } else if (isPlainObject(map)) {
    entries = Object.entries(map);
  } else {
    throw formatError("formats must be a plain object or a Map");
  }
  /** @type {Map<string, UploadAuthorizationFormat>} */
  const byVersion = new Map();
  for (const [telemetrySchemaVersion, format] of entries) {
    if (typeof telemetrySchemaVersion !== "string"
        || !CONTRIBUTION_SCHEMA_VERSION.test(telemetrySchemaVersion)) {
      throw formatError("telemetrySchemaVersion must look like telemetry-contribution-v<major>.<minor>");
    }
    if (!isPlainObject(format)) {
      throw formatError(telemetrySchemaVersion + " needs a plain format object");
    }
    const keys = Object.keys(format).sort();
    if (keys.length !== FORMAT_KEYS.length || keys.some((key, index) => key !== FORMAT_KEYS[index])) {
      throw formatError(telemetrySchemaVersion + " format has exactly assertUploadAllowed");
    }
    if (typeof format.assertUploadAllowed !== "function") {
      throw formatError(telemetrySchemaVersion + " assertUploadAllowed must be a function");
    }
    byVersion.set(telemetrySchemaVersion, Object.freeze({
      assertUploadAllowed: format.assertUploadAllowed,
    }));
  }
  const telemetrySchemaVersions = Object.freeze([...byVersion.keys()]);
  return Object.freeze({
    telemetrySchemaVersions,
    has(telemetrySchemaVersion) {
      return typeof telemetrySchemaVersion === "string" && byVersion.has(telemetrySchemaVersion);
    },
    resolve(telemetrySchemaVersion) {
      if (typeof telemetrySchemaVersion !== "string") return null;
      return byVersion.get(telemetrySchemaVersion) ?? null;
    },
  });
}
