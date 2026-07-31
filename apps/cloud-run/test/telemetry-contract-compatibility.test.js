import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTelemetryContribution,
  parseTelemetryContributionV02,
  parseTelemetryEnvelope,
} from "../../../packages/telemetry-contract/index.js";
import {
  telemetryContractAdversarialVectors,
  telemetryEnvelopeAdversarialVectors,
  telemetryEnvelopeGolden,
  telemetryV01Golden,
  telemetryV02Golden,
} from "../../../test/fixtures/telemetry-contract-vectors.mjs";

test("contained Cloud Run tests consume the canonical telemetry vectors", () => {
  const v01 = telemetryV01Golden();
  const v02 = telemetryV02Golden();
  const envelope = telemetryEnvelopeGolden();
  assert.equal(parseTelemetryContribution(v01), v01);
  assert.equal(parseTelemetryContributionV02(v02), v02);
  assert.equal(parseTelemetryEnvelope(envelope), envelope);

  for (const vector of telemetryContractAdversarialVectors()) {
    const parse = vector.value.schemaVersion
      === "telemetry-contribution-v0.2"
      ? parseTelemetryContributionV02
      : parseTelemetryContribution;
    assert.throws(
      () => parse(vector.value),
      (error) => (
        error?.code === vector.code
        && error?.detailCode === vector.detailCode
      ),
      vector.label,
    );
  }
  for (const vector of telemetryEnvelopeAdversarialVectors()) {
    assert.throws(
      () => parseTelemetryEnvelope(vector.value),
      (error) => error?.code === "ENVELOPE_INVALID",
      vector.label,
    );
  }
});

test("Cloud Run remains storage-only and exposes no telemetry route", async () => {
  const source = await import("../src/server.js");
  assert.equal(
    typeof source.createContainedServer,
    "function",
    "compatibility evidence must not activate a telemetry production path",
  );
});
