import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";

import {
  TelemetryContractError,
  canonicalTelemetryContributionV01,
  inspectTelemetryContributionDatasetV02,
  inspectTelemetryContributionV02,
  parseTelemetryEnvelope,
  parseTelemetryContribution,
  parseTelemetryContributionV02,
  validateContributionForUpload,
} from "../packages/telemetry-contract/index.js";
import {
  telemetryHashIdPatternSource,
} from "../packages/telemetry-contract/src/primitives.js";
import {
  telemetryContractAdversarialVectors,
  telemetryEnvelopeAdversarialVectors,
  telemetryEnvelopeGolden,
  telemetryV01Golden,
  telemetryV02Golden,
  telemetryV02LegacyIdGolden,
} from "./fixtures/telemetry-contract-vectors.mjs";

async function compiledV02Schema() {
  const directory = new URL(
    "../packages/telemetry-contract/schemas/v0.2/",
    import.meta.url,
  );
  const names = [
    "usage-event.schema.json",
    "quota-snapshot.schema.json",
    "activity-marker.schema.json",
    "contribution.schema.json",
  ];
  const schemas = await Promise.all(names.map(async (name) => (
    JSON.parse(await readFile(new URL(name, directory), "utf8"))
  )));
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });
  for (const schema of schemas.slice(0, -1)) ajv.addSchema(schema);
  return Object.freeze({
    schemas,
    validate: ajv.compile(schemas.at(-1)),
  });
}

test("strict package accepts and preserves the frozen golden contracts", () => {
  const v01 = telemetryV01Golden();
  const v02 = telemetryV02Golden();
  assert.equal(parseTelemetryContribution(v01), v01);
  assert.equal(parseTelemetryContributionV02(v02), v02);
  assert.equal(validateContributionForUpload(v01), true);
  assert.equal(validateContributionForUpload(v02), true);
  assert.deepEqual(canonicalTelemetryContributionV01(v02), v01);
  assert.deepEqual(inspectTelemetryContributionV02(v02), {
    valid: true,
    errors: [],
  });
  assert.deepEqual(inspectTelemetryContributionDatasetV02([v02]), {
    valid: true,
    errors: [],
  });
});

test("mixed event price bases are represented at batch level without relabeling rows", async () => {
  const value = telemetryV01Golden();
  const second = structuredClone(value.usageEvents[0]);
  second.eventId = `event:v2:${"b".repeat(64)}`;
  second.accounting = {
    estimatedApiCostUsd: null,
    pricingCoveragePercent: 0,
    unknownBillableUnits: 0,
    priceBasis: "historical_api_prices",
  };
  value.usageEvents.push(second);
  value.accounting = {
    estimatedApiCostUsd: "0.420000",
    pricedEventCoveragePercent: 50,
    unknownModelEventCount: 0,
    unknownBillableUnits: 0,
    priceBasis: "mixed_api_prices",
  };
  assert.equal(parseTelemetryContribution(value), value);
  assert.equal(value.usageEvents[0].accounting.priceBasis, "current_api_prices");
  assert.equal(value.usageEvents[1].accounting.priceBasis, "historical_api_prices");

  const v02 = telemetryV02Golden();
  const secondV02 = structuredClone(v02.usageEvents[0]);
  secondV02.eventId = `event:v2:${"b".repeat(64)}`;
  secondV02.accountingDiagnostic = {
    ...secondV02.accountingDiagnostic,
    estimatedApiCostUsd: null,
    pricingCoveragePercent: 0,
    priceBasis: "historical_api_prices",
  };
  v02.usageEvents.push(secondV02);
  v02.accountingDiagnostic = {
    ...v02.accountingDiagnostic,
    pricedEventCoveragePercent: 50,
    priceBasis: "mixed_api_prices",
  };
  const compiled = await compiledV02Schema();
  assert.equal(compiled.validate(v02), true, JSON.stringify(compiled.validate.errors));
  assert.equal(parseTelemetryContributionV02(v02), v02);
  assert.equal(canonicalTelemetryContributionV01(v02).accounting.priceBasis, "mixed_api_prices");
});

test("runtime and JSON Schema deliberately preserve legacy 43-character ID compatibility", async () => {
  const legacy = telemetryV02LegacyIdGolden();
  assert.equal(parseTelemetryContributionV02(legacy), legacy);
  assert.deepEqual(
    canonicalTelemetryContributionV01(legacy),
    {
      ...telemetryV01Golden(),
      usageEvents: [{
        ...telemetryV01Golden().usageEvents[0],
        eventId: legacy.usageEvents[0].eventId,
        modelId: "unknown",
        modelRecognition: "unrecognized",
        modelFingerprint: legacy.usageEvents[0].modelFingerprint,
      }],
      quotaSnapshots: [{
        ...telemetryV01Golden().quotaSnapshots[0],
        snapshotId: legacy.quotaSnapshots[0].snapshotId,
      }],
      activityMarkers: [{
        ...telemetryV01Golden().activityMarkers[0],
        markerId: legacy.activityMarkers[0].markerId,
      }],
      accounting: {
        ...telemetryV01Golden().accounting,
        unknownModelEventCount: 1,
      },
    },
  );

  const { schemas, validate } = await compiledV02Schema();
  assert.equal(validate(legacy), true, JSON.stringify(validate.errors));
  const [usageSchema, quotaSchema, activitySchema] = schemas;
  assert.equal(
    usageSchema.properties.eventId.pattern,
    telemetryHashIdPatternSource("event:v2"),
  );
  assert.equal(
    usageSchema.properties.modelFingerprint.pattern,
    telemetryHashIdPatternSource("model:v1"),
  );
  assert.equal(
    quotaSchema.properties.snapshotId.pattern,
    telemetryHashIdPatternSource("snapshot:v2"),
  );
  assert.equal(
    activitySchema.properties.markerId.pattern,
    telemetryHashIdPatternSource("marker:v2"),
  );

  for (const mutate of [
    (value) => {
      value.datasetId = `dataset:v1:${"A".repeat(43)}`;
    },
    (value) => {
      value.usageEvents[0].accountTrackId =
        `account-track:v1:${"A".repeat(43)}`;
    },
  ]) {
    const invalidNewId = telemetryV02LegacyIdGolden();
    mutate(invalidNewId);
    assert.throws(
      () => parseTelemetryContributionV02(invalidNewId),
      (error) => (
        error instanceof TelemetryContractError
        && error.code === "TELEMETRY_RECORD_INVALID"
      ),
    );
    assert.equal(validate(invalidNewId), false);
  }
});

test("v0.2 canonicalization validates hostile inputs before dereferencing them", () => {
  for (const value of [null, {}, []]) {
    assert.throws(
      () => canonicalTelemetryContributionV01(value),
      (error) => (
        error instanceof TelemetryContractError
        && error.code === "TELEMETRY_RECORD_INVALID"
        && !error.message.includes("private-content-canary")
      ),
    );
  }

  let getterCalls = 0;
  const accessor = telemetryV02Golden();
  Object.defineProperty(accessor, "accountingDiagnostic", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("private-content-canary");
    },
  });
  assert.throws(
    () => canonicalTelemetryContributionV01(accessor),
    (error) => (
      error instanceof TelemetryContractError
      && error.code === "TELEMETRY_RECORD_INVALID"
      && error.detailCode === "accessor_or_hidden_field"
      && !error.message.includes("private-content-canary")
    ),
  );
  assert.equal(getterCalls, 0);

  let methodCalls = 0;
  const executableValue = telemetryV02Golden();
  executableValue.toJSON = () => {
    methodCalls += 1;
    throw new Error("private-content-canary");
  };
  assert.throws(
    () => canonicalTelemetryContributionV01(executableValue),
    (error) => (
      error instanceof TelemetryContractError
      && error.code === "TELEMETRY_RECORD_INVALID"
      && error.detailCode === "non_json_value"
      && !error.message.includes("private-content-canary")
    ),
  );
  assert.equal(methodCalls, 0);

  for (const [hostileProxy, detailCode] of [
    [new Proxy(telemetryV02Golden(), {
      ownKeys() {
        throw new Error("private-content-canary");
      },
    }), "non_json_object"],
    [new Proxy(telemetryV02Golden(), {
      get(target, key, receiver) {
        if (key === "schemaVersion") {
          throw new Error("private-content-canary");
        }
        return Reflect.get(target, key, receiver);
      },
    }), "serialization_failed"],
  ]) {
    assert.throws(
      () => canonicalTelemetryContributionV01(hostileProxy),
      (error) => (
        error instanceof TelemetryContractError
        && error.code === "TELEMETRY_RECORD_INVALID"
        && error.detailCode === detailCode
        && !error.message.includes("private-content-canary")
      ),
    );
  }
});

test("strict package accepts only the frozen closed envelope contract", () => {
  const golden = telemetryEnvelopeGolden();
  assert.equal(parseTelemetryEnvelope(golden), golden);
  for (const vector of telemetryEnvelopeAdversarialVectors()) {
    assert.throws(
      () => parseTelemetryEnvelope(vector.value),
      (error) => (
        error instanceof TelemetryContractError
        && error.code === "ENVELOPE_INVALID"
        && error.detailCode === "envelope_invalid"
      ),
      vector.label,
    );
  }
});

test("strict package emits stable content-free errors for adversarial vectors", () => {
  for (const vector of telemetryContractAdversarialVectors()) {
    assert.throws(
      () => validateContributionForUpload(vector.value),
      (error) => {
        assert.ok(error instanceof TelemetryContractError, vector.label);
        assert.equal(error.code, vector.code, vector.label);
        assert.equal(error.detailCode, vector.detailCode, vector.label);
        assert.equal(
          error.message.includes("private-content-canary"),
          false,
          vector.label,
        );
        return true;
      },
    );
  }
});

test("strict package rejects accessors, exotic objects, and cycles without evaluating them", () => {
  let getterCalls = 0;
  const accessor = telemetryV01Golden();
  Object.defineProperty(accessor.accounting, "hidden", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "private-content-canary";
    },
  });
  assert.throws(
    () => parseTelemetryContribution(accessor),
    (error) => error?.code === "PRIVACY_CANARY_DETECTED",
  );
  assert.equal(getterCalls, 0);

  const exotic = telemetryV01Golden();
  exotic.accounting = Object.assign(
    Object.create({ inherited: true }),
    exotic.accounting,
  );
  assert.throws(
    () => parseTelemetryContribution(exotic),
    (error) => error?.code === "PRIVACY_CANARY_DETECTED",
  );

  const cyclic = telemetryV01Golden();
  cyclic.accounting.cycle = cyclic;
  assert.throws(
    () => parseTelemetryContribution(cyclic),
    (error) => error?.code === "PRIVACY_CANARY_DETECTED",
  );

  const hostileProxy = new Proxy(telemetryV01Golden(), {
    ownKeys() {
      throw new Error("private-content-canary");
    },
  });
  assert.throws(
    () => parseTelemetryContribution(hostileProxy),
    (error) => (
      error?.code === "PRIVACY_CANARY_DETECTED"
      && !error.message.includes("private-content-canary")
    ),
  );
});

test("v0.2 complete datasets fail closed when a declared part is absent", () => {
  const first = telemetryV02Golden();
  first.partCount = 2;
  const result = inspectTelemetryContributionDatasetV02([first]);
  assert.deepEqual(result, {
    valid: false,
    errors: ["complete_dataset_missing_parts"],
  });
});
