import { ApiError } from "./errors";

export const TELEMETRY_PERFORMANCE_ENVELOPE_SCHEMA_VERSION =
  "telemetry-performance-envelope-v1" as const;
export const TELEMETRY_PERFORMANCE_MAX_CIPHERTEXT_CHARS = 2_000_000;

export interface TelemetryPerformanceEnvelope {
  readonly schemaVersion: typeof TELEMETRY_PERFORMANCE_ENVELOPE_SCHEMA_VERSION;
  readonly synthetic: false;
  readonly keyId: string;
  readonly wrappedKey: string;
  readonly iv: string;
  readonly ciphertext: string;
}

const KEY_ID = /^key:[A-Za-z0-9._-]{1,64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function base64url(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string"
    && value.length >= minimum
    && value.length <= maximum
    && BASE64URL.test(value);
}

/**
 * Validate the independent performance envelope at the Worker boundary.
 * Ciphertext remains opaque: privacy canaries are checked only after
 * decryption by the report parser.
 */
export function validateTelemetryPerformanceEnvelope(
  value: unknown,
): TelemetryPerformanceEnvelope {
  if (!exact(value, ["ciphertext", "iv", "keyId", "schemaVersion", "synthetic", "wrappedKey"])
      || value.schemaVersion !== TELEMETRY_PERFORMANCE_ENVELOPE_SCHEMA_VERSION
      || value.synthetic !== false
      || typeof value.keyId !== "string"
      || !KEY_ID.test(value.keyId)
      || !base64url(value.wrappedKey, 342, 342)
      || !base64url(value.iv, 16, 16)
      || !base64url(value.ciphertext, 16, TELEMETRY_PERFORMANCE_MAX_CIPHERTEXT_CHARS)) {
    throw new ApiError(400, "ENVELOPE_INVALID");
  }
  return Object.freeze(value as unknown as TelemetryPerformanceEnvelope);
}
