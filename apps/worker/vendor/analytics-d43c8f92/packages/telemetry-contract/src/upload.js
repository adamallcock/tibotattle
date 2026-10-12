import {
  ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION,
} from "./constants.js";
import {
  validateTelemetryContribution,
} from "./telemetry-v0.1.js";
import {
  validateAccountScopedTelemetryContribution,
} from "./telemetry-v0.2.js";

export function validateContributionForUpload(value, options = {}) {
  if (
    value?.schemaVersion
      === ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION
  ) {
    return validateAccountScopedTelemetryContribution(value, options);
  }
  return validateTelemetryContribution(value, options);
}
