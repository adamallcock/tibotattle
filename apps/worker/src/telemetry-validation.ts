import {
  TELEMETRY_MODEL_IDS,
  isTelemetryContractError,
  parseTelemetryContribution,
  parseTelemetryEnvelope,
  type TelemetryActivityMarker,
  type TelemetryContribution,
  type TelemetryEnvelope,
  type TelemetryQuotaSnapshot,
  type TelemetryUsageEvent,
  type UsageAccounting,
} from "@app-usagemonitor/telemetry-contract";

import { ApiError } from "./errors";

export {
  TELEMETRY_MODEL_IDS,
  type TelemetryActivityMarker,
  type TelemetryContribution,
  type TelemetryEnvelope,
  type TelemetryQuotaSnapshot,
  type TelemetryUsageEvent,
  type UsageAccounting,
};

function mapContractError(error: unknown): never {
  if (isTelemetryContractError(error)) {
    throw new ApiError(400, error.code);
  }
  throw error;
}

/**
 * Worker HTTP adapter for the runtime-neutral envelope contract.
 *
 * The shared package deliberately has no dependency on Worker response
 * semantics. This boundary maps its content-free error classifications to the
 * public API without exposing diagnostic detail or input data.
 */
export function validateTelemetryEnvelope(
  value: unknown,
): TelemetryEnvelope {
  try {
    return parseTelemetryEnvelope(value);
  } catch (error) {
    return mapContractError(error);
  }
}

/**
 * Worker HTTP adapter for the canonical v0.1 plaintext contract.
 */
export function validateTelemetryContribution(
  value: unknown,
): TelemetryContribution {
  try {
    return parseTelemetryContribution(value);
  } catch (error) {
    return mapContractError(error);
  }
}
