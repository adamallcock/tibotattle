import test from "node:test";
import assert from "node:assert/strict";
import {
  createCorrection,
  digestDerivedValue,
  renderCorrectionReport,
  resolveCorrections,
  stableCorrectionRecords,
} from "../src/corrections.js";
import { stableJson } from "../src/storage.js";

const METHODS = Object.freeze({
  parser: "codex-log-scan@0.3.0",
  estimator: "api-price-equivalent@0.3.0",
  pricing: "openai-api-pricing@2026-07-23",
  lineage: "fork-replay-dedup@0.3.0",
});

function derived({ total = 100, warning = "unknown_model", cost = 0.1 } = {}) {
  return {
    aggregateTokenTotal: total,
    apiPricedCostUsd: cost,
    warnings: warning ? [warning] : [],
  };
}

function original({ observationId = "observation-a", schemaVersion = "0.2", value = derived() } = {}) {
  return {
    schemaVersion,
    kind: "codex_quota_observation",
    observationId,
    capturedAt: "2026-07-23T12:00:00.000Z",
    provider: "openai_codex",
    derived: value,
  };
}

function correction({
  correctionId = "correction-a",
  supersedesId = "observation-a",
  supersededDerived = derived(),
  replacementDerived = derived({ total: 90, warning: null, cost: 0.09 }),
  createdAt = "2026-07-23T12:01:00.000Z",
  ...overrides
} = {}) {
  return createCorrection({
    correctionId,
    supersedesId,
    reason: "Remove replayed fork-history usage from a derived aggregate.",
    category: "lineage_replay_deduplication",
    createdAt,
    methodVersions: METHODS,
    originalValueDigest: digestDerivedValue(supersededDerived),
    replacementDerived,
    diagnostics: { replayedForkHistoryTokensRemoved: 10 },
    sourceInputCoverage: {
      retainedTokenEvents: 3,
      excludedForkReplayEvents: 1,
      complete: true,
    },
    operatorNote: "Aggregate-only replay correction; no raw log content retained.",
    ...overrides,
  });
}

function resolve({ originals = [original()], corrections = [] } = {}) {
  return resolveCorrections({ originals, corrections });
}

function effective(result, observationId = "observation-a") {
  const record = result.effectiveByOriginalId?.[observationId];
  assert.ok(record, `expected an effective result for ${observationId}`);
  return record;
}

function assertError(result, code) {
  assert.ok(
    result.errors?.some((error) => error.code === code),
    `expected an explicit ${code} error; got ${stableJson(result.errors ?? [])}`,
  );
}

function walk(value) {
  if (Array.isArray(value)) return value.flatMap(walk);
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(walk)];
}

function assertCorrectionPrivacy(value) {
  const serialized = stableJson(value);
  for (const forbidden of [
    "session-private-123",
    "/private/repository/path",
    "raw prompt text",
    "sk-test-private-key",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `correction data leaked ${forbidden}`);
  }
  for (const record of walk(value)) {
    for (const key of ["sessionId", "rolloutId", "repositoryPath", "rawLogPath", "prompt", "response", "toolArguments", "apiKey"]) {
      assert.equal(Object.hasOwn(record, key), false, `correction data must not serialize ${key}`);
    }
  }
}

test("a correction replaces only derived fields while preserving an immutable original and an auditable chain", () => {
  const source = original();
  const before = stableJson(source);
  const record = correction();
  const result = resolve({ corrections: [record] });
  const resolved = effective(result);

  assert.equal(stableJson(source), before, "resolution must never mutate the source observation");
  assert.equal(resolved.originalObservationId, "observation-a");
  assert.equal(resolved.effectiveRecordId, "correction-a");
  assert.deepEqual(resolved.derived, derived({ total: 90, warning: null, cost: 0.09 }));
  assert.deepEqual(resolved.chainIds, ["observation-a", "correction-a"]);
  assert.equal(result.errors.length, 0);
});

test("a multi-step supersession chain validates every predecessor digest and uses the terminal derived value", () => {
  const first = correction();
  const second = correction({
    correctionId: "correction-b",
    supersedesId: "correction-a",
    supersededDerived: first.replacementDerived,
    replacementDerived: derived({ total: 80, warning: null, cost: 0.08 }),
    createdAt: "2026-07-23T12:02:00.000Z",
  });
  const result = resolve({ corrections: [first, second] });
  const resolved = effective(result);

  assert.equal(resolved.effectiveRecordId, "correction-b");
  assert.deepEqual(resolved.chainIds, ["observation-a", "correction-a", "correction-b"]);
  assert.deepEqual(resolved.derived, derived({ total: 80, warning: null, cost: 0.08 }));
  assert.equal(result.errors.length, 0);
});

test("byte-identical duplicate corrections collapse idempotently instead of creating a branch", () => {
  const record = correction();
  const records = stableCorrectionRecords([record, structuredClone(record)]);
  const result = resolve({ corrections: [record, structuredClone(record)] });
  const resolved = effective(result);

  assert.deepEqual(records, [record]);
  assert.equal(resolved.effectiveRecordId, "correction-a");
  assert.deepEqual(resolved.chainIds, ["observation-a", "correction-a"]);
  assert.equal(result.errors.length, 0);
});

test("two non-identical corrections for one predecessor are an explicit conflict and are never selected silently", () => {
  const left = correction({ correctionId: "correction-left" });
  const right = correction({
    correctionId: "correction-right",
    replacementDerived: derived({ total: 80, warning: null, cost: 0.08 }),
  });
  const result = resolve({ corrections: [left, right] });

  assertError(result, "branching_correction_conflict");
  assert.equal(result.effectiveByOriginalId?.["observation-a"], undefined, "a conflicted root cannot acquire a guessed effective value");
});

test("a correction cycle is an error even when individual records are well formed", () => {
  const a = correction({
    correctionId: "correction-a",
    supersedesId: "correction-b",
    supersededDerived: derived({ total: 90, warning: null, cost: 0.09 }),
  });
  const b = correction({
    correctionId: "correction-b",
    supersedesId: "correction-a",
    supersededDerived: derived({ total: 90, warning: null, cost: 0.09 }),
  });
  const result = resolve({ originals: [], corrections: [a, b] });

  assertError(result, "correction_cycle");
  assert.equal(Object.keys(result.effectiveByOriginalId ?? {}).length, 0);
});

test("a correction whose target is absent is rejected rather than treated as a new observation", () => {
  const record = correction({ supersedesId: "missing-observation" });
  const result = resolve({ corrections: [record] });

  assertError(result, "missing_superseded_target");
  assert.equal(effective(result).effectiveRecordId, "observation-a", "the unrelated original remains effective");
});

test("a digest mismatch cannot alter the effective result", () => {
  const record = correction({ originalValueDigest: "sha256:wrong-derived-value" });
  const result = resolve({ corrections: [record] });

  assertError(result, "original_value_digest_mismatch");
  assert.equal(effective(result).effectiveRecordId, "observation-a");
  assert.deepEqual(effective(result).derived, derived());
});

test("incompatible correction schemas are rejected without discarding a compatible original", () => {
  const record = correction({ schemaVersion: "9.9" });
  const result = resolve({ corrections: [record] });

  assertError(result, "incompatible_correction_schema");
  assert.equal(effective(result).effectiveRecordId, "observation-a");
});

test("schema-0.1 observations remain readable and can be corrected without rewriting their legacy shape", () => {
  const legacy = original({ observationId: "legacy-observation", schemaVersion: "0.1" });
  const before = stableJson(legacy);
  const record = correction({ supersedesId: "legacy-observation" });
  const result = resolve({ originals: [legacy], corrections: [record] });
  const resolved = effective(result, "legacy-observation");

  assert.equal(stableJson(legacy), before, "legacy evidence is append-only and unchanged");
  assert.equal(resolved.effectiveRecordId, "correction-a");
  assert.deepEqual(resolved.derived.warnings, [], "the corrected value removes the obsolete warning");
});

test("the report exposes original and effective derived values plus a visible correction history", () => {
  const result = resolve({ corrections: [correction()] });
  const report = renderCorrectionReport(result);

  assert.match(report, /Original derived values/i);
  assert.match(report, /Effective derived values/i);
  assert.match(report, /Correction history/i);
  assert.match(report, /observation-a/);
  assert.match(report, /correction-a/);
  assert.match(report, /100/);
  assert.match(report, /90/);
});

test("correction construction canonicalizes records deterministically and rejects sensitive provenance fields", () => {
  const first = correction();
  const second = correction();
  assert.equal(stableJson(first), stableJson(second));
  assert.equal(stableJson(stableCorrectionRecords([second, first])), stableJson([first]));
  assertCorrectionPrivacy(first);

  assert.throws(() => correction({
    sourceInputCoverage: {
      retainedTokenEvents: 3,
      rawLogPath: "/private/repository/path",
    },
  }), /private|sensitive|raw.*path/i);
  assert.throws(() => correction({ operatorNote: "raw prompt text and sk-test-private-key" }), /private|sensitive|operator note/i);
  assert.throws(() => correction({
    sourceInputCoverage: { retainedTokenEvents: 3, path: "/Users/private/source.jsonl" },
  }), /private|sensitive|path/i);
});

test("resolution rejects a schema-compatible correction that acquires private data after construction", () => {
  const unsafe = correction();
  unsafe.diagnostics.prompt = "secret raw prompt that must never survive resolution";
  const result = resolve({ corrections: [unsafe] });
  const report = renderCorrectionReport(result);

  assertError(result, "correction_privacy_violation");
  assert.equal(effective(result).effectiveRecordId, "observation-a");
  assert.deepEqual(effective(result).derived, derived());
  assert.equal(stableJson(result).includes("secret raw prompt"), false);
  assert.equal(report.includes("secret raw prompt"), false);
});

test("resolution never echoes an unsafe correction identifier into errors or reports", () => {
  const unsafe = correction();
  unsafe.correctionId = "raw prompt PRIVATE_VALUE";
  const result = resolve({ corrections: [unsafe] });
  const report = renderCorrectionReport(result);

  assertError(result, "invalid_correction_identifier");
  assert.equal(stableJson(result).includes("PRIVATE_VALUE"), false);
  assert.equal(report.includes("PRIVATE_VALUE"), false);
  assert.equal(effective(result).effectiveRecordId, "observation-a");
});
