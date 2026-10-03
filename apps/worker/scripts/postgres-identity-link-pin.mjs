// PT8-C: the identity-link pin (design/pt8-lite-design-2026-10-02.md section 6).
//
// Only the OWNER runs `identity-pin` (postgres-production-transfer.mjs). The
// deployed IDENTITY_LINK_SECRET is read from STDIN only (never an argument or
// an environment variable, which a child process would inherit), e.g.
//
//   gcloud secrets versions access <N> --secret=<prod id> | \
//     node apps/worker/scripts/postgres-production-transfer.mjs identity-pin \
//       --owner-dir <dir> --key-version <label> --secret-name <id> --secret-version <N>
//
// The secret lives only in this process's memory. The pin is
// HMAC-SHA256(key = secret, msg = "app-usagemonitor/identity-link-secret-fingerprint/v1\0"),
// byte-equal to the Worker's identityLinkSecretFingerprint
// (src/identity-link-configuration.ts). It is a keyed digest: keep it in the
// owner directory, never in the repository.
//
// The pin hashes the EXACT stdin bytes, because the service hashes the exact
// mounted bytes (configuredIdentityLinkSecret checks only the length and never
// trims). Input ending in "\n" or "\r" is refused rather than stripped: a
// Secret Manager version stored with a trailing newline (for example written
// with `echo … |`) loads WITH it, so a stripped pin would pass P8 and the
// service would then fail every hosted-identity operation after markLive.

import { createHmac } from "node:crypto";

export const IDENTITY_LINK_PIN_SCHEMA = "tibotattle-identity-link-pin-v1";
export const IDENTITY_LINK_FINGERPRINT_DOMAIN = "app-usagemonitor/identity-link-secret-fingerprint/v1\0";
/** The Worker's configuredIdentityLinkSecret minimum. */
export const IDENTITY_LINK_SECRET_MIN_LENGTH = 32;
const MAX_SECRET_BYTES = 4096;
/** IDENTITY_LINK_SECRET_VERSION_PATTERN in src/identity-link-configuration.ts. */
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SECRET_NAME = /^[A-Za-z0-9_-]{1,255}$/u;
const SECRET_VERSION = /^[1-9][0-9]{0,9}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class IdentityLinkPinError extends Error {
  constructor(code) {
    super(code);
    this.name = "IdentityLinkPinError";
    this.code = code;
  }
}

function fail(code) {
  throw new IdentityLinkPinError(code);
}

/** The Worker's fingerprint of a secret string. Refuses a secret shorter than 32 characters. */
export function identityLinkSecretFingerprint(secret) {
  if (typeof secret !== "string" || secret.length < IDENTITY_LINK_SECRET_MIN_LENGTH) {
    fail("CUTOVER_IDENTITY_LINK_SECRET_INVALID");
  }
  return createHmac("sha256", secret).update(IDENTITY_LINK_FINGERPRINT_DOMAIN).digest("hex");
}

/**
 * Read the secret from a stream (stdin): at most 4 KiB of strict UTF-8, kept
 * byte for byte (a leading byte-order mark is kept too). Input that ends in a
 * line feed or a carriage return is refused (CUTOVER_IDENTITY_LINK_SECRET_INVALID),
 * never stripped: check how that Secret Manager version was stored. The bytes
 * are never logged.
 */
export async function readSecretFromStream(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    size += buffer.length;
    if (size > MAX_SECRET_BYTES) fail("CUTOVER_IDENTITY_LINK_SECRET_INVALID");
    chunks.push(buffer);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    fail("CUTOVER_IDENTITY_LINK_SECRET_INVALID");
  }
  if (text.endsWith("\n") || text.endsWith("\r")) fail("CUTOVER_IDENTITY_LINK_SECRET_INVALID");
  return text;
}

/**
 * The pin document: { schema, keyVersion, secretFingerprint, secretName,
 * secretVersion, computedAt }. secretVersion must be a numeric Secret Manager
 * version: 'latest' is refused, because the pin must name what the service
 * template mounts.
 */
export function buildIdentityLinkPin({ secret, keyVersion, secretName, secretVersion, computedAt }) {
  if (typeof keyVersion !== "string" || !KEY_VERSION.test(keyVersion)
      || typeof secretName !== "string" || !SECRET_NAME.test(secretName)
      || typeof secretVersion !== "string" || !SECRET_VERSION.test(secretVersion)
      || typeof computedAt !== "string" || !INSTANT.test(computedAt)) {
    fail("CUTOVER_IDENTITY_PIN_INVALID");
  }
  return Object.freeze({
    schema: IDENTITY_LINK_PIN_SCHEMA,
    keyVersion,
    secretFingerprint: identityLinkSecretFingerprint(secret),
    secretName,
    secretVersion,
    computedAt,
  });
}

/** Validate a parsed pin document (closed keys). */
export function validateIdentityLinkPin(value) {
  const keys = ["schema", "keyVersion", "secretFingerprint", "secretName", "secretVersion", "computedAt"];
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
      || value.schema !== IDENTITY_LINK_PIN_SCHEMA
      || typeof value.keyVersion !== "string" || !KEY_VERSION.test(value.keyVersion)
      || typeof value.secretFingerprint !== "string" || !SHA256.test(value.secretFingerprint)
      || typeof value.secretName !== "string" || !SECRET_NAME.test(value.secretName)
      || typeof value.secretVersion !== "string" || !SECRET_VERSION.test(value.secretVersion)
      || typeof value.computedAt !== "string" || !INSTANT.test(value.computedAt)) {
    fail("CUTOVER_IDENTITY_PIN_INVALID");
  }
  return Object.freeze({ ...value });
}

/**
 * Preflight P8 against the sealed singleton row and the expected deployment
 * label: the pin must equal the sealed { key_version, secret_fingerprint }
 * (CUTOVER_IDENTITY_LINK_SECRET_MISMATCH) and keyVersion must equal the
 * production service's IDENTITY_LINK_SECRET_VERSION.
 */
export function assertPinMatchesSealed(pin, sealedRows, { expectedKeyVersion }) {
  const valid = validateIdentityLinkPin(pin);
  if (typeof expectedKeyVersion !== "string" || !KEY_VERSION.test(expectedKeyVersion)) fail("CUTOVER_IDENTITY_PIN_INVALID");
  if (valid.keyVersion !== expectedKeyVersion) fail("CUTOVER_IDENTITY_LINK_VERSION_MISMATCH");
  if (!Array.isArray(sealedRows) || sealedRows.length !== 1 || sealedRows[0].key_version !== valid.keyVersion
      || sealedRows[0].secret_fingerprint !== valid.secretFingerprint) {
    fail("CUTOVER_IDENTITY_LINK_SECRET_MISMATCH");
  }
  return Object.freeze({ keyVersion: valid.keyVersion, secretFingerprint: valid.secretFingerprint });
}

/**
 * Preflight P8 against the deployment: the pin must name the Secret Manager
 * secret and the numeric version the production service template mounts
 * (the IDENTITY_LINK_SECRET entry of the committed production desired state).
 * A mount that is not pinned to a numeric version (null, 'latest' or any
 * other form) refuses CUTOVER_IDENTITY_LINK_MOUNT_UNPINNED, and a pin taken
 * from another secret or version refuses CUTOVER_IDENTITY_LINK_MOUNT_MISMATCH,
 * so the import cannot carry a fingerprint the service will not load.
 */
export function assertPinMatchesMount(pin, mount) {
  const valid = validateIdentityLinkPin(pin);
  if (mount === null || typeof mount !== "object" || Array.isArray(mount)
      || typeof mount.secretName !== "string" || !SECRET_NAME.test(mount.secretName)
      || typeof mount.version !== "string" || !SECRET_VERSION.test(mount.version)) {
    fail("CUTOVER_IDENTITY_LINK_MOUNT_UNPINNED");
  }
  if (valid.secretName !== mount.secretName || valid.secretVersion !== mount.version) {
    fail("CUTOVER_IDENTITY_LINK_MOUNT_MISMATCH");
  }
  return Object.freeze({ secretName: valid.secretName, secretVersion: valid.secretVersion });
}

// ---------------------------------------------------------------------------
// Round 16: rotate at the cutover (owner decisions 2026-10-02, round 16).
//
// The production IDENTITY_LINK_SECRET is lost (Cloudflare Worker secrets are
// write-only). Round 12 retires every route that consumes the pin, a link key
// or a cooldown digest (IDENTITY_LINK_CONSUMER_ROUTE_IDS), so the owner chose
// to ROTATE: the origin mounts a newly generated Secret Manager version under
// a new label, and the imported D1 pin row is replaced at the cutover only
// under a second authorization token and a recorded, tamper-evident rotation
// document. Never silently: without the document every continuity check
// still refuses a mismatched secret. (The origin still keys its 60-second
// rate-limit subjects with the secret; those carry no continuity.)
//
// The labels are not free: a rotation moves the pin FROM a label the
// deployment retired TO the label the deployment runs (the production
// composition passes PRODUCTION_RETIRED_IDENTITY_LINK_VERSIONS and
// PRODUCTION_IDENTITY_LINK_SECRET_VERSION from
// cloud-run/postgres-production-configuration.mjs), so a pin can never be
// moved to a label the origin does not use.
//
// `identity-rotate-pin` (owner only) reads the NEW secret from stdin, like
// `identity-pin`, and the sealed D1 pin from --sealed-pin-file: the output of
// the read-only
//   (umask 077; wrangler d1 execute <production database> --remote --env production --json \
//     --command "SELECT key_version, secret_fingerprint FROM identity_link_secret_configuration" \
//     > <owner dir>/sealed-pin.json)
// (a keyed digest, kept in the 0700 owner directory, never the repository).
// The file must be private (no group or other permission bits, one link, the
// caller's own): a plain redirect under the usual umask makes it 0644, which
// refuses CUTOVER_IDENTITY_ROTATION_SOURCE_UNREADABLE.
// It writes identity-pin.json (the new pin) and identity-rotation.json.

export const IDENTITY_LINK_ROTATION_SCHEMA = "tibotattle-identity-link-rotation-v1";
export const IDENTITY_LINK_ROTATION_REASON = "secret-lost";
export const IDENTITY_LINK_ROTATION_DECISION = "owner-decisions-2026-10-02 round 16";
const MAX_SEALED_PIN_FILE_BYTES = 64 * 1024;
const SEALED_PIN_ROW_KEYS = Object.freeze(["key_version", "recorded_at", "secret_fingerprint", "singleton"]);

/**
 * Parse the sealed-pin file: exactly one D1 row with key_version and
 * secret_fingerprint (singleton and recorded_at may accompany them), either
 * as wrangler's --json output ([{ results: [row], success: true, ... }]) or
 * as the bare row. Refuses CUTOVER_IDENTITY_ROTATION_SOURCE_MISMATCH.
 */
export function parseSealedPinFile(bytes) {
  let value;
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_SEALED_PIN_FILE_BYTES) throw new Error("size");
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("CUTOVER_IDENTITY_ROTATION_SOURCE_MISMATCH");
  }
  let row = value;
  if (Array.isArray(value)) {
    if (value.length !== 1 || value[0] === null || typeof value[0] !== "object" || value[0].success !== true
        || !Array.isArray(value[0].results) || value[0].results.length !== 1) {
      fail("CUTOVER_IDENTITY_ROTATION_SOURCE_MISMATCH");
    }
    [row] = value[0].results;
  }
  if (row === null || typeof row !== "object" || Array.isArray(row)
      || Object.keys(row).some(key => !SEALED_PIN_ROW_KEYS.includes(key))
      || (Object.hasOwn(row, "singleton") && row.singleton !== 1)
      || typeof row.key_version !== "string" || !KEY_VERSION.test(row.key_version)
      || typeof row.secret_fingerprint !== "string" || !SHA256.test(row.secret_fingerprint)) {
    fail("CUTOVER_IDENTITY_ROTATION_SOURCE_MISMATCH");
  }
  return Object.freeze({ keyVersion: row.key_version, secretFingerprint: row.secret_fingerprint });
}

function closedRecord(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

/**
 * Validate a parsed identity-rotation.json (closed keys at every level).
 * `consumerRouteIds` is the registry's IDENTITY_LINK_CONSUMER_ROUTE_IDS: the
 * document must name exactly that list, in that order.
 */
export function validateIdentityLinkRotation(value, { consumerRouteIds }) {
  if (!closedRecord(value, ["schema", "from", "to", "reason", "decision", "retiredConsumerRoutes", "computedAt"])
      || value.schema !== IDENTITY_LINK_ROTATION_SCHEMA || value.reason !== IDENTITY_LINK_ROTATION_REASON
      || value.decision !== IDENTITY_LINK_ROTATION_DECISION
      || !closedRecord(value.from, ["keyVersion", "secretFingerprint"])
      || !closedRecord(value.to, ["keyVersion", "secretFingerprint", "secretName", "secretVersion"])
      || typeof value.from.keyVersion !== "string" || !KEY_VERSION.test(value.from.keyVersion)
      || typeof value.from.secretFingerprint !== "string" || !SHA256.test(value.from.secretFingerprint)
      || typeof value.to.keyVersion !== "string" || !KEY_VERSION.test(value.to.keyVersion)
      || typeof value.to.secretFingerprint !== "string" || !SHA256.test(value.to.secretFingerprint)
      || typeof value.to.secretName !== "string" || !SECRET_NAME.test(value.to.secretName)
      || typeof value.to.secretVersion !== "string" || !SECRET_VERSION.test(value.to.secretVersion)
      || value.from.keyVersion === value.to.keyVersion || value.from.secretFingerprint === value.to.secretFingerprint
      || !Array.isArray(consumerRouteIds) || !Array.isArray(value.retiredConsumerRoutes)
      || JSON.stringify(value.retiredConsumerRoutes) !== JSON.stringify([...consumerRouteIds])
      || typeof value.computedAt !== "string" || !INSTANT.test(value.computedAt)) {
    fail("CUTOVER_IDENTITY_ROTATION_INVALID");
  }
  return Object.freeze({
    ...value,
    from: Object.freeze({ ...value.from }),
    to: Object.freeze({ ...value.to }),
    retiredConsumerRoutes: Object.freeze([...value.retiredConsumerRoutes]),
  });
}

/**
 * The rotation's label rule. `labels` is the deployment's
 * { currentKeyVersion, retiredKeyVersions }: a non-empty list of retired
 * labels that excludes the current one (anything else refuses
 * CUTOVER_IDENTITY_PIN_INVALID). `toKeyVersion` must be the current label and
 * `fromKeyVersion` one of the retired labels; any other well-formed label,
 * another plane's included, refuses CUTOVER_IDENTITY_LINK_VERSION_MISMATCH.
 */
export function assertRotationLabels({ fromKeyVersion, toKeyVersion }, labels) {
  const current = labels?.currentKeyVersion;
  const retired = labels?.retiredKeyVersions;
  if (typeof current !== "string" || !KEY_VERSION.test(current) || !Array.isArray(retired) || retired.length === 0
      || retired.some(label => typeof label !== "string" || !KEY_VERSION.test(label)) || retired.includes(current)) {
    fail("CUTOVER_IDENTITY_PIN_INVALID");
  }
  if (toKeyVersion !== current || !retired.includes(fromKeyVersion)) fail("CUTOVER_IDENTITY_LINK_VERSION_MISMATCH");
  return Object.freeze({ fromKeyVersion, toKeyVersion });
}

/**
 * Build the rotation's two owner documents from the NEW secret: the pin of
 * the new secret (the existing pin schema, labelled `toKeyVersion`) and the
 * rotation document binding it to the sealed D1 pin. The sealed pin must
 * carry `fromKeyVersion`, the labels must satisfy assertRotationLabels for
 * the deployment's `labels`, and the fingerprints must change.
 */
export function buildIdentityLinkRotation({ secret, sealedPin, fromKeyVersion, toKeyVersion, secretName,
  secretVersion, consumerRouteIds, computedAt, labels }) {
  if (sealedPin === null || typeof sealedPin !== "object" || typeof fromKeyVersion !== "string"
      || !KEY_VERSION.test(fromKeyVersion) || sealedPin.keyVersion !== fromKeyVersion) {
    fail("CUTOVER_IDENTITY_ROTATION_SOURCE_MISMATCH");
  }
  assertRotationLabels({ fromKeyVersion, toKeyVersion }, labels);
  const pin = buildIdentityLinkPin({ secret, keyVersion: toKeyVersion, secretName, secretVersion, computedAt });
  const rotation = validateIdentityLinkRotation({
    schema: IDENTITY_LINK_ROTATION_SCHEMA,
    from: { keyVersion: sealedPin.keyVersion, secretFingerprint: sealedPin.secretFingerprint },
    to: { keyVersion: pin.keyVersion, secretFingerprint: pin.secretFingerprint, secretName: pin.secretName,
      secretVersion: pin.secretVersion },
    reason: IDENTITY_LINK_ROTATION_REASON,
    decision: IDENTITY_LINK_ROTATION_DECISION,
    retiredConsumerRoutes: Array.isArray(consumerRouteIds) ? [...consumerRouteIds] : null,
    computedAt,
  }, { consumerRouteIds });
  return Object.freeze({ pin, rotation });
}

/**
 * Preflight P8-R over a rotation: both labels must follow the deployment's
 * `labels` ({ currentKeyVersion, retiredKeyVersions }; `to` and the pin carry
 * the current label, `from` a retired one; CUTOVER_IDENTITY_LINK_VERSION_MISMATCH),
 * `from` must be the sealed D1 row exactly
 * (CUTOVER_IDENTITY_ROTATION_SOURCE_MISMATCH), and the pin must be the
 * rotation's `to` (CUTOVER_IDENTITY_ROTATION_PIN_MISMATCH).
 */
export function assertRotationMatchesSealed(rotation, pin, sealedRows, labels) {
  const valid = validateIdentityLinkPin(pin);
  assertRotationLabels({ fromKeyVersion: rotation.from.keyVersion, toKeyVersion: rotation.to.keyVersion }, labels);
  if (!Array.isArray(sealedRows) || sealedRows.length !== 1 || sealedRows[0].key_version !== rotation.from.keyVersion
      || sealedRows[0].secret_fingerprint !== rotation.from.secretFingerprint) {
    fail("CUTOVER_IDENTITY_ROTATION_SOURCE_MISMATCH");
  }
  if (valid.keyVersion !== labels.currentKeyVersion) fail("CUTOVER_IDENTITY_LINK_VERSION_MISMATCH");
  if (valid.secretFingerprint !== rotation.to.secretFingerprint || valid.secretName !== rotation.to.secretName
      || valid.secretVersion !== rotation.to.secretVersion) {
    fail("CUTOVER_IDENTITY_ROTATION_PIN_MISMATCH");
  }
  return Object.freeze({ fromKeyVersion: rotation.from.keyVersion, toKeyVersion: rotation.to.keyVersion,
    toSecretVersion: rotation.to.secretVersion });
}
