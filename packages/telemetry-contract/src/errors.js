export const TELEMETRY_CONTRACT_ERROR_CODES = Object.freeze([
  "ENVELOPE_INVALID",
  "PRIVACY_CANARY_DETECTED",
  "TELEMETRY_RECORD_INVALID",
]);

const ERROR_CODES = new Set(TELEMETRY_CONTRACT_ERROR_CODES);

/**
 * Content-free trust-boundary error.
 *
 * `code` is the stable adapter-facing classification. `detailCode` is a
 * bounded diagnostic selected by this package and never includes input data.
 */
export class TelemetryContractError extends TypeError {
  constructor(code, detailCode, message = "The telemetry contract is invalid.") {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown telemetry contract error code.");
    }
    if (
      typeof detailCode !== "string"
      || !/^[a-z][a-z0-9_]{0,63}$/u.test(detailCode)
    ) {
      throw new TypeError("Invalid telemetry contract detail code.");
    }
    super(message);
    this.code = code;
    this.detailCode = detailCode;
  }
}

export function isTelemetryContractError(value) {
  return value instanceof TelemetryContractError
    && ERROR_CODES.has(value.code);
}

export function telemetryContractFailure(
  code,
  detailCode,
  message,
) {
  throw new TelemetryContractError(code, detailCode, message);
}
