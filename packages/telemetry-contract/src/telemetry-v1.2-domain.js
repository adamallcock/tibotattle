import { isTelemetryContractError, telemetryContractFailure } from "./errors.js";
import {
  assertTelemetryClientBounds,
  hasTelemetryExactKeys,
  isTelemetryInstant,
  telemetryPrivacyCanary,
} from "./primitives.js";
import {
  MAX_TELEMETRY_V12_CHUNK_CANONICAL_BYTES,
  canonicalTelemetryV12Json,
} from "./telemetry-v1.2.js";

export const TELEMETRY_V12_DOMAIN_MANIFEST_SCHEMA_VERSION = "telemetry-domain-manifest-v1.2";
export const MAX_TELEMETRY_V12_DOMAIN_DAYS = 4_096;

const V12_DOMAIN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const V12_DOMAIN_DIGEST = /^[0-9a-f]{64}$/u;
const V12_DOMAIN_DAY_MS = 86_400_000;
const V12_DOMAIN_DAY = /^\d{4}-\d{2}-\d{2}$/u;

function v12DomainInvalid() {
  telemetryContractFailure("TELEMETRY_RECORD_INVALID", "v12_domain_invalid");
}

function v12DomainDayMs(value) {
  if (typeof value !== "string" || !V12_DOMAIN_DAY.test(value)
      || !isTelemetryInstant(`${value}T00:00:00.000Z`)) v12DomainInvalid();
  return Date.parse(`${value}T00:00:00.000Z`);
}

function v12DomainGuard(value, operation) {
  try {
    assertTelemetryClientBounds(value, {
      maxSerializedBytes: MAX_TELEMETRY_V12_CHUNK_CANONICAL_BYTES,
      maxDepth: 8,
      maxArrayItems: MAX_TELEMETRY_V12_DOMAIN_DAYS,
    });
    if (telemetryPrivacyCanary(value)) {
      telemetryContractFailure("PRIVACY_CANARY_DETECTED", "v12_domain_privacy_canary");
    }
    return operation();
  } catch (error) {
    if (isTelemetryContractError(error)) throw error;
    v12DomainInvalid();
  }
}

/** One complete comparison domain, including days with no admitted records. */
export function parseTelemetryV12DomainManifest(value) {
  return v12DomainGuard(value, () => {
    if (!hasTelemetryExactKeys(value, ["schemaVersion", "fromDay", "throughDay",
      "predecessor", "days", "manifestDigest"])
        || value.schemaVersion !== TELEMETRY_V12_DOMAIN_MANIFEST_SCHEMA_VERSION
        || !hasTelemetryExactKeys(value.predecessor, ["token", "previousGenerationId", "legacyFingerprint"])
        || typeof value.predecessor.token !== "string" || !V12_DOMAIN_UUID.test(value.predecessor.token)
        || !(value.predecessor.previousGenerationId === null
          || (typeof value.predecessor.previousGenerationId === "string"
            && V12_DOMAIN_UUID.test(value.predecessor.previousGenerationId)))
        || typeof value.predecessor.legacyFingerprint !== "string"
        || !V12_DOMAIN_DIGEST.test(value.predecessor.legacyFingerprint)
        || typeof value.manifestDigest !== "string" || !V12_DOMAIN_DIGEST.test(value.manifestDigest)
        || !Array.isArray(value.days) || value.days.length < 1
        || value.days.length > MAX_TELEMETRY_V12_DOMAIN_DAYS) v12DomainInvalid();
    const start = v12DomainDayMs(value.fromDay);
    const end = v12DomainDayMs(value.throughDay);
    if (end < start || (end - start) / V12_DOMAIN_DAY_MS + 1 !== value.days.length) v12DomainInvalid();
    const ids = new Set();
    for (let i = 0; i < value.days.length; i += 1) {
      const entry = value.days[i];
      if (!hasTelemetryExactKeys(entry, ["day", "manifestId", "manifestDigest"])
          || v12DomainDayMs(entry.day) !== start + i * V12_DOMAIN_DAY_MS
          || typeof entry.manifestId !== "string" || !V12_DOMAIN_UUID.test(entry.manifestId)
          || ids.has(entry.manifestId)
          || typeof entry.manifestDigest !== "string" || !V12_DOMAIN_DIGEST.test(entry.manifestDigest)) v12DomainInvalid();
      ids.add(entry.manifestId);
    }
    return value;
  });
}

/** Tokens are short-lived capabilities, not semantic generation identity. */
export function telemetryV12DomainManifestDigestInput(value) {
  const manifest = parseTelemetryV12DomainManifest(value);
  return canonicalTelemetryV12Json({
    schemaVersion: manifest.schemaVersion,
    fromDay: manifest.fromDay,
    throughDay: manifest.throughDay,
    predecessor: {
      previousGenerationId: manifest.predecessor.previousGenerationId,
      legacyFingerprint: manifest.predecessor.legacyFingerprint,
    },
    days: manifest.days,
  });
}
