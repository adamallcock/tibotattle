import { describe, expect, it } from "vitest";

import {
  telemetryContractAdversarialVectors,
  telemetryEnvelopeAdversarialVectors,
  telemetryEnvelopeGolden,
  telemetryV01Golden,
  telemetryV02Golden,
  telemetryV02LegacyIdGolden,
} from "../../../test/fixtures/telemetry-contract-vectors.mjs";
import { ApiError } from "../src/errors";
import {
  canonicalTelemetryContributionV01,
  validateTelemetryContributionV02,
} from "../src/telemetry-v0.2";
import {
  validateTelemetryContribution,
  validateTelemetryEnvelope,
} from "../src/telemetry-validation";

describe("shared telemetry contract adapter parity", () => {
  it("accepts the same frozen v0.1 and v0.2 golden records", () => {
    const v01 = telemetryV01Golden();
    const v02 = telemetryV02Golden();
    expect(validateTelemetryContribution(v01)).toBe(v01);
    expect(validateTelemetryContributionV02(v02)).toBe(v02);
    expect(canonicalTelemetryContributionV01(
      validateTelemetryContributionV02(v02),
    )).toEqual(v01);
  });

  it("preserves legacy 43-character telemetry IDs through the shared package", () => {
    const legacy = telemetryV02LegacyIdGolden();
    const validated = validateTelemetryContributionV02(legacy);
    const canonical = canonicalTelemetryContributionV01(validated);
    expect(validated).toBe(legacy);
    expect(validated.usageEvents).toHaveLength(1);
    expect(canonical.usageEvents).toHaveLength(1);
    expect(canonical.usageEvents[0]?.eventId)
      .toBe(validated.usageEvents[0]?.eventId);
  });

  it("accepts and rejects the same frozen envelope vectors", () => {
    const golden = telemetryEnvelopeGolden();
    expect(validateTelemetryEnvelope(golden)).toBe(golden);
    for (const vector of telemetryEnvelopeAdversarialVectors()) {
      try {
        validateTelemetryEnvelope(vector.value);
        throw new Error(`expected ${vector.label} to fail`);
      } catch (error) {
        expect(error, vector.label).toBeInstanceOf(ApiError);
        expect((error as ApiError).code, vector.label)
          .toBe("ENVELOPE_INVALID");
      }
    }
  });

  it("maps every shared adversarial classification to a content-free API error", () => {
    for (const vector of telemetryContractAdversarialVectors()) {
      const validate = vector.value.schemaVersion
        === "telemetry-contribution-v0.2"
        ? validateTelemetryContributionV02
        : validateTelemetryContribution;
      try {
        validate(vector.value);
        throw new Error(`expected ${vector.label} to fail`);
      } catch (error) {
        expect(error, vector.label).toBeInstanceOf(ApiError);
        expect((error as ApiError).code, vector.label).toBe(vector.code);
        expect((error as Error).message, vector.label)
          .not.toContain("private-content-canary");
      }
    }
  });
});
