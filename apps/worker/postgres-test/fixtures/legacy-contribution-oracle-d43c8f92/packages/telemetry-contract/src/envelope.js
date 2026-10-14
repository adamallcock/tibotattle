import {
  TELEMETRY_ENVELOPE_SCHEMA_VERSION,
} from "./constants.js";
import {
  telemetryContractFailure,
} from "./errors.js";
import {
  hasTelemetryExactKeys,
  isTelemetryBase64Url,
} from "./primitives.js";

export function parseTelemetryEnvelope(value) {
  if (
    !hasTelemetryExactKeys(value, [
      "schemaVersion",
      "synthetic",
      "keyId",
      "wrappedKey",
      "iv",
      "ciphertext",
    ])
    || value.schemaVersion !== TELEMETRY_ENVELOPE_SCHEMA_VERSION
    || value.synthetic !== false
    || typeof value.keyId !== "string"
    || !/^key:[A-Za-z0-9._-]{1,64}$/u.test(value.keyId)
    || !isTelemetryBase64Url(value.wrappedKey, 342, 342)
    || !isTelemetryBase64Url(value.iv, 16, 16)
    || !isTelemetryBase64Url(value.ciphertext, 16, 2_000_000)
  ) {
    telemetryContractFailure(
      "ENVELOPE_INVALID",
      "envelope_invalid",
      "The telemetry envelope is invalid.",
    );
  }
  return value;
}

export function validateTelemetryEnvelope(value) {
  parseTelemetryEnvelope(value);
  return true;
}
