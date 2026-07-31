import { createHmac, hkdfSync } from "node:crypto";

const SECRET_BYTES = 32;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PSEUDONYM_PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function decodeSecret(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const result = Buffer.from(value);
    if (result.byteLength !== SECRET_BYTES) {
      throw new Error("Participant secret must contain exactly 32 bytes");
    }
    return result;
  }
  if (typeof value !== "string") {
    throw new Error("Participant secret must be a 32-byte base64url value");
  }
  const normalized = value.trim();
  if (!BASE64URL_256_PATTERN.test(normalized)) {
    throw new Error("Participant secret must be a 32-byte base64url value");
  }
  const result = Buffer.from(normalized, "base64url");
  if (result.byteLength !== SECRET_BYTES) {
    throw new Error("Participant secret must contain exactly 32 bytes");
  }
  return result;
}

function assertPrefix(prefix) {
  if (typeof prefix !== "string"
      || !PSEUDONYM_PREFIX_PATTERN.test(prefix)) {
    throw new Error("Pseudonym prefix is invalid");
  }
}

function assertSubject(subject) {
  if (typeof subject !== "string"
      || subject.length === 0
      || subject.length > 4096) {
    throw new Error("Pseudonym subject must be a bounded non-empty string");
  }
}

function deriveDigest(secret, prefix, subject, version) {
  const decodedSecret = decodeSecret(secret);
  let derivedKey = null;
  try {
    derivedKey = Buffer.from(hkdfSync(
      "sha256",
      decodedSecret,
      Buffer.from("app-usagemonitor/export-identity/v1", "utf8"),
      Buffer.from(version === 1 ? prefix : `${prefix}-v2`, "utf8"),
      SECRET_BYTES,
    ));
    return createHmac("sha256", derivedKey)
      .update(`app-usagemonitor/${prefix}/v${version}\0`, "utf8")
      .update(subject, "utf8")
      .digest("hex");
  } finally {
    // These are internal copies. Never wipe the caller-owned input, but do not
    // retain decoded participant secrets or derived domain keys after use.
    decodedSecret.fill(0);
    derivedKey?.fill(0);
  }
}

export function deriveExportPseudonym(secret, prefix, subject) {
  assertPrefix(prefix);
  assertSubject(subject);
  // The textual identity version remains the domain-separation version. This
  // contract is still unfrozen; its body uses lowercase hex so an otherwise
  // valid derived identifier cannot accidentally contain credential syntax.
  const digest = deriveDigest(secret, prefix, subject, 1);
  return `${prefix}:v1:${digest}`;
}

export function deriveExportPseudonymV2(secret, prefix, subject) {
  assertPrefix(prefix);
  assertSubject(subject);
  const digest = deriveDigest(secret, prefix, subject, 2);
  return `${prefix}:v2:${digest}`;
}
