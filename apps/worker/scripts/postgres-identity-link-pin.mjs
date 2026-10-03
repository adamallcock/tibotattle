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
