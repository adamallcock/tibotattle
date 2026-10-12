import { telemetryContractFailure } from "./errors.js";
import { hasTelemetryExactKeys, isTelemetryInstant } from "./primitives.js";
import { canonicalTelemetryV11Json } from "./telemetry-v1.1.js";

export const TELEMETRY_V11_DOMAIN_MANIFEST_SCHEMA_VERSION = "telemetry-domain-manifest-v1.1";
export const MAX_TELEMETRY_V11_DOMAIN_DAYS = 4_096;
const V11_DOMAIN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const V11_DOMAIN_DIGEST = /^[0-9a-f]{64}$/u;
const V11_DOMAIN_DAY_MS = 86_400_000;

function v11DomainInvalid() {
  telemetryContractFailure("TELEMETRY_RECORD_INVALID", "v11_domain_invalid");
}

function v11DomainDayMs(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
      || !isTelemetryInstant(`${value}T00:00:00.000Z`)) v11DomainInvalid();
  return Date.parse(`${value}T00:00:00.000Z`);
}

/** One complete comparison domain, including days with no admitted records. */
export function parseTelemetryV11DomainManifest(value) {
  if (!hasTelemetryExactKeys(value, ["schemaVersion", "fromDay", "throughDay",
    "predecessor", "days", "manifestDigest"])
      || value.schemaVersion !== TELEMETRY_V11_DOMAIN_MANIFEST_SCHEMA_VERSION
      || !hasTelemetryExactKeys(value.predecessor, ["token", "previousGenerationId", "legacyFingerprint"])
      || typeof value.predecessor.token !== "string" || !V11_DOMAIN_UUID.test(value.predecessor.token)
      || !(value.predecessor.previousGenerationId === null
        || (typeof value.predecessor.previousGenerationId === "string"
          && V11_DOMAIN_UUID.test(value.predecessor.previousGenerationId)))
      || typeof value.predecessor.legacyFingerprint !== "string"
      || !V11_DOMAIN_DIGEST.test(value.predecessor.legacyFingerprint)
      || typeof value.manifestDigest !== "string" || !V11_DOMAIN_DIGEST.test(value.manifestDigest)
      || !Array.isArray(value.days) || value.days.length < 1
      || value.days.length > MAX_TELEMETRY_V11_DOMAIN_DAYS) v11DomainInvalid();
  const start = v11DomainDayMs(value.fromDay);
  const end = v11DomainDayMs(value.throughDay);
  if (end < start || (end - start) / V11_DOMAIN_DAY_MS + 1 !== value.days.length) v11DomainInvalid();
  const ids = new Set();
  for (let i = 0; i < value.days.length; i += 1) {
    const entry = value.days[i];
    if (!hasTelemetryExactKeys(entry, ["day", "manifestId", "manifestDigest"])
        || v11DomainDayMs(entry.day) !== start + i * V11_DOMAIN_DAY_MS
        || typeof entry.manifestId !== "string" || !V11_DOMAIN_UUID.test(entry.manifestId)
        || ids.has(entry.manifestId)
        || typeof entry.manifestDigest !== "string" || !V11_DOMAIN_DIGEST.test(entry.manifestDigest)) v11DomainInvalid();
    ids.add(entry.manifestId);
  }
  return value;
}

/** Tokens are short-lived capabilities, not semantic generation identity. */
export function telemetryV11DomainManifestDigestInput(value) {
  const manifest = parseTelemetryV11DomainManifest(value);
  return canonicalTelemetryV11Json({
    schemaVersion: manifest.schemaVersion, fromDay: manifest.fromDay, throughDay: manifest.throughDay,
    predecessor: { previousGenerationId: manifest.predecessor.previousGenerationId,
      legacyFingerprint: manifest.predecessor.legacyFingerprint },
    days: manifest.days,
  });
}
