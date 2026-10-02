/**
 * Contribution envelope and upload-authorization format seams (GCP fast
 * path, IN-1).
 *
 * POST /api/v1/contributions stays one route. Its shared preamble (bearer
 * auth, upload-authorization claim, transport floor, receipt,
 * abandon-on-failure) runs first; only then does the origin
 * dispatch on the envelope's body.schemaVersion through a registry built
 * here, and after the handler returns the preamble records the receipt.
 * Envelope versions are registry entries, not routes: postgres-test-dispatch
 * registers v1.2 from its own dependencies, and the v1.1/v1.0/v0.1 ports
 * export registrations that the composition root passes in. An unregistered
 * version keeps the origin's existing refusal unchanged; resolve() returns
 * null and the caller owns that response.
 *
 * POST /api/v1/device/upload-authorizations likewise validates
 * telemetrySchemaVersion through a format table built by
 * createUploadAuthorizationFormats(). The same table enforces the transport
 * floor in the contributions preamble: an envelope version is admitted under
 * the format contributionTransportSchemaVersion() names. A registered
 * envelope without its format, or a format whose envelope no handler can
 * redeem, is refused at startup (assertContributionEnvelopeFormats()).
 *
 * Both registries are built once at startup from immutable entries, so
 * registration order and import side effects cannot change routing. This
 * file is plain JavaScript with no imports so node:test specs can load it
 * directly.
 */

/**
 * The exact claimed request body, as the Worker's readBoundedJson returns it:
 * bytes is the bounded body, raw its fatal-UTF-8 text and value its JSON.
 *
 * @typedef {Readonly<{ bytes: Uint8Array, raw: string, value: unknown }>} ContributionEnvelopeBody
 */

/**
 * The active participant the claimed upload authorization belongs to, read in
 * the preamble (the Worker's participants row).
 *
 * @typedef {Readonly<{
 *   id: string,
 *   consentVersion: string | null,
 *   ownerKind: "social" | "accountless",
 * }>} ContributionEnvelopeParticipant
 */

/**
 * The upload-authorization claim the preamble made.
 *
 * @typedef {Readonly<{
 *   authorizationId: string,
 *   participantId: string,
 *   authorizationKind: "device",
 * }>} ContributionEnvelopeClaim
 */

/**
 * The per-request context the contributions preamble hands an envelope
 * handler. Handlers must treat unknown fields as absent. On the PostgreSQL
 * origin (postgres-test-dispatch.mjs) it carries:
 * - request: the admitted request (its body is already consumed);
 * - envelopeDigest, bodyBytes, contentType: the values the claim was bound to;
 * - principal: Readonly<{ participantId, deviceId }>, the device principal the
 *   PostgreSQL write authorities take;
 * - schema: Readonly<{ primarySchema }>;
 * - primaryPool, objectStore: the origin's storage handles;
 * - envelopePublicJwk, envelopePrivateJwk: the origin's envelope key pair;
 * - sourceNamespace: the origin's typed-storage source namespace;
 * - markPersistStarted(): call immediately before the first durable write
 *   whose outcome can be uncertain. From then on the preamble no longer
 *   abandons the claim when the handler throws, and the handler resolves the
 *   claim itself.
 *
 * The receipt: once the handler returns, the preamble reads the response's
 * JSON contributionId (anything but a string is 500 INTERNAL_ERROR) and
 * consumes the claimed authorization against it, as d43c8f92
 * handleContribution does with recordDeviceUploadReceipt after every
 * envelope handler. For a replay that is the retained contribution's id. The
 * recorder accepts an authorization the handler already consumed against
 * the same id in its persist transaction. If the receipt fails, the preamble
 * abandons the claim (a no-op once it is consumed or a contribution references
 * it) and the error answers. A registration made with ownsReceipt: true
 * resolves the claim itself instead, and the preamble records nothing.
 *
 * @typedef {Readonly<Record<string, unknown>>} ContributionEnvelopeContext
 */

/**
 * Runs only after the shared preamble has authenticated the bearer, claimed
 * the upload authorization and enforced the transport floor. If it throws
 * before markPersistStarted(), the preamble abandons the claim and the
 * origin maps the error; it must not repeat any preamble step. It returns the client receipt as a Response whose JSON body
 * carries the contributionId the preamble records the receipt against.
 *
 * @typedef {(
 *   body: ContributionEnvelopeBody,
 *   participant: ContributionEnvelopeParticipant,
 *   sourceDeviceId: string,
 *   claimed: ContributionEnvelopeClaim,
 *   context: ContributionEnvelopeContext,
 * ) => Response | Promise<Response>} ContributionEnvelopeHandler
 */

/**
 * Optional pre-claim validation of the parsed envelope and its exact raw
 * text. It runs before the bearer is claimed, so it must be pure: no storage,
 * no network, and it throws the origin's refusal for a malformed envelope.
 *
 * @typedef {(envelope: unknown, raw: string) => void} ContributionEnvelopeValidator
 */

/**
 * ownsReceipt is false unless the registration asked for it: the preamble
 * then records the receipt after the handler returns. true means the handler
 * resolves the claimed authorization on every path itself (the PostgreSQL
 * v1.2 handler consumes it in its persist transaction and revokes it on a
 * replay).
 *
 * @typedef {Readonly<{
 *   schemaVersion: string,
 *   handler: ContributionEnvelopeHandler,
 *   validateEnvelope: ContributionEnvelopeValidator | null,
 *   ownsReceipt: boolean,
 * }>} ContributionEnvelopeRegistration
 */

/**
 * @typedef {Readonly<{
 *   schemaVersions: readonly string[],
 *   has: (schemaVersion: unknown) => boolean,
 *   resolve: (schemaVersion: unknown) => ContributionEnvelopeHandler | null,
 *   resolveRegistration: (schemaVersion: unknown) => ContributionEnvelopeRegistration | null,
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
const REGISTRATION_OPTION_KEYS = Object.freeze(["validateEnvelope", "ownsReceipt"]);
const DEFINED_REGISTRATIONS = new WeakSet();

// Seam errors carry a stable code so a bad registration stops the origin at
// startup with a named reason (server.mjs reports error.code) rather than the
// generic runtime-configuration failure.
function envelopeError(message) {
  return Object.assign(new Error("CONTRIBUTION_ENVELOPE_REGISTRY_INVALID: " + message), {
    code: "CONTRIBUTION_ENVELOPE_REGISTRY_INVALID",
  });
}

function formatError(message) {
  return Object.assign(new Error("UPLOAD_AUTHORIZATION_FORMAT_INVALID: " + message), {
    code: "UPLOAD_AUTHORIZATION_FORMAT_INVALID",
  });
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
 * options.validateEnvelope, when given, runs before the claim (see
 * ContributionEnvelopeValidator). Without it the envelope is validated only by
 * the handler, after the preamble. options.ownsReceipt: true opts out of the
 * preamble's receipt (see ContributionEnvelopeRegistration); omit it to have
 * the preamble record the receipt, as production does for every envelope.
 *
 * @param {string} schemaVersion
 * @param {ContributionEnvelopeHandler} handler
 * @param {{ validateEnvelope?: ContributionEnvelopeValidator, ownsReceipt?: boolean }} [options]
 * @returns {ContributionEnvelopeRegistration}
 */
export function registerContributionEnvelope(schemaVersion, handler, options = {}) {
  if (typeof schemaVersion !== "string" || !ENVELOPE_SCHEMA_VERSION.test(schemaVersion)) {
    throw envelopeError("schemaVersion must look like telemetry-envelope-v<major>.<minor>");
  }
  if (typeof handler !== "function") {
    throw envelopeError("handler must be a function");
  }
  if (!isPlainObject(options)
      || Object.keys(options).some((key) => !REGISTRATION_OPTION_KEYS.includes(key))) {
    throw envelopeError("options may contain only validateEnvelope and ownsReceipt");
  }
  const validateEnvelope = options.validateEnvelope ?? null;
  if (validateEnvelope !== null && typeof validateEnvelope !== "function") {
    throw envelopeError("validateEnvelope must be a function");
  }
  const ownsReceipt = options.ownsReceipt === undefined ? false : options.ownsReceipt;
  if (typeof ownsReceipt !== "boolean") {
    throw envelopeError("ownsReceipt must be a boolean");
  }
  const registration = Object.freeze({ schemaVersion, handler, validateEnvelope, ownsReceipt });
  DEFINED_REGISTRATIONS.add(registration);
  return registration;
}

/**
 * The transport (upload-authorization format) version a contribution envelope
 * version is admitted under: telemetry-envelope-vX.Y maps to
 * telemetry-contribution-vX.Y, as the Worker's
 * telemetryTransportSchemaForEnvelope() does for every supported version.
 * Returns null for anything that is not an envelope version string.
 *
 * @param {unknown} schemaVersion
 * @returns {string | null}
 */
export function contributionTransportSchemaVersion(schemaVersion) {
  if (typeof schemaVersion !== "string" || !ENVELOPE_SCHEMA_VERSION.test(schemaVersion)) return null;
  return schemaVersion.replace("telemetry-envelope-", "telemetry-contribution-");
}

/**
 * The envelope version an upload-authorization format admits: the inverse of
 * contributionTransportSchemaVersion(). Returns null for anything that is not
 * a contribution transport version string.
 *
 * @param {unknown} telemetrySchemaVersion
 * @returns {string | null}
 */
export function contributionEnvelopeSchemaVersion(telemetrySchemaVersion) {
  if (typeof telemetrySchemaVersion !== "string"
      || !CONTRIBUTION_SCHEMA_VERSION.test(telemetrySchemaVersion)) return null;
  return telemetrySchemaVersion.replace("telemetry-contribution-", "telemetry-envelope-");
}

/**
 * Fail closed at startup unless the two tables pair exactly: every registered
 * envelope version has the upload-authorization format its transport floor is
 * enforced through, and every format has an envelope handler, so the origin
 * never issues an authorization that POST /api/v1/contributions cannot
 * redeem.
 *
 * @param {ContributionEnvelopeRegistry} envelopes
 * @param {UploadAuthorizationFormats} formats
 */
export function assertContributionEnvelopeFormats(envelopes, formats) {
  if (envelopes === null || typeof envelopes !== "object"
      || !Array.isArray(envelopes.schemaVersions) || typeof envelopes.has !== "function"
      || formats === null || typeof formats !== "object"
      || !Array.isArray(formats.telemetrySchemaVersions) || typeof formats.has !== "function") {
    throw envelopeError("envelopes and formats must be built registries");
  }
  for (const schemaVersion of envelopes.schemaVersions) {
    const transport = contributionTransportSchemaVersion(schemaVersion);
    if (transport === null || !formats.has(transport)) {
      throw envelopeError(schemaVersion + " has no " + String(transport)
        + " upload-authorization format for its transport floor");
    }
  }
  for (const telemetrySchemaVersion of formats.telemetrySchemaVersions) {
    const envelope = contributionEnvelopeSchemaVersion(telemetrySchemaVersion);
    if (envelope === null || !envelopes.has(envelope)) {
      throw envelopeError(telemetrySchemaVersion + " has no " + String(envelope)
        + " handler to redeem its upload authorizations");
    }
  }
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
  /** @type {Map<string, ContributionEnvelopeRegistration>} */
  const byVersion = new Map();
  for (const registration of registrations) {
    if (!DEFINED_REGISTRATIONS.has(registration)) {
      throw envelopeError("register only values returned by registerContributionEnvelope()");
    }
    if (byVersion.has(registration.schemaVersion)) {
      throw envelopeError("more than one handler claims " + registration.schemaVersion);
    }
    byVersion.set(registration.schemaVersion, registration);
  }
  const schemaVersions = Object.freeze([...byVersion.keys()]);
  return Object.freeze({
    schemaVersions,
    has(schemaVersion) {
      return typeof schemaVersion === "string" && byVersion.has(schemaVersion);
    },
    resolve(schemaVersion) {
      if (typeof schemaVersion !== "string") return null;
      return byVersion.get(schemaVersion)?.handler ?? null;
    },
    resolveRegistration(schemaVersion) {
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
