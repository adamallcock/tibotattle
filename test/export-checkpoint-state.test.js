import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_CHECKPOINT_PARSER_VERSION,
} from "../src/export/index.js";
import { localCodexCheckpointState } from
  "../src/local-node-runtime.js";

const {
  createEmptyCodexCheckpointState,
  digestCodexCheckpointState,
  normalizeCodexCheckpointState,
  serializeCodexCheckpointState,
} = localCodexCheckpointState;

function stateWithCumulativeTotals() {
  const value = createEmptyCodexCheckpointState();
  value.currentModel = {
    modelId: "unknown",
    modelRecognition: "unrecognized",
    modelFingerprint: `model:v1:${"a".repeat(64)}`,
  };
  value.previousTotals = {
    input_tokens: 100,
    cached_input_tokens: 20,
    cache_write_input_tokens: 5,
    output_tokens: 10,
    reasoning_output_tokens: 4,
    total_tokens: 110,
  };
  value.previousTotalsPresence = {
    input_tokens: true,
    cached_input_tokens: true,
    cache_write_input_tokens: true,
    output_tokens: true,
    reasoning_output_tokens: false,
    total_tokens: true,
  };
  value.tier = { timelineIndex: 7, speedMode: "fast", apiServiceTier: "unknown" };
  value.pendingToolCounts.localShell = 2;
  value.pendingToolCounts.subagent = 1;
  return value;
}

test("empty Codex checkpoint state is closed and independently mutable", () => {
  const first = createEmptyCodexCheckpointState();
  const second = createEmptyCodexCheckpointState();
  assert.equal(first.schemaVersion, EXPORT_CHECKPOINT_PARSER_VERSION);
  assert.equal(first.currentModel, null);
  assert.equal(first.previousTotals, null);
  assert.equal(first.previousTotalsPresence, null);
  assert.equal(first.reAnchored, false);
  assert.equal(first.sessionMetaSeen, false);
  assert.deepEqual(first.tier, { timelineIndex: 0, speedMode: "unknown", apiServiceTier: "unknown" });
  first.pendingToolCounts.mcp = 3;
  assert.equal(second.pendingToolCounts.mcp, 0);
});

test("normalization returns a canonical clone and round trips through canonical JSON", () => {
  const source = stateWithCumulativeTotals();
  const normalized = normalizeCodexCheckpointState(source);
  assert.deepEqual(normalized, source);
  assert.notEqual(normalized, source);
  assert.notEqual(normalized.pendingToolCounts, source.pendingToolCounts);
  source.pendingToolCounts.localShell = 9;
  assert.equal(normalized.pendingToolCounts.localShell, 2);
  assert.deepEqual(normalizeCodexCheckpointState(JSON.parse(serializeCodexCheckpointState(normalized))), normalized);
});

test("serialization and digest are deterministic across input key order", () => {
  const source = stateWithCumulativeTotals();
  const reordered = {
    pendingToolCounts: Object.fromEntries(Object.entries(source.pendingToolCounts).reverse()),
    tier: { apiServiceTier: "unknown", speedMode: "fast", timelineIndex: 7 },
    previousTotalsPresence: Object.fromEntries(Object.entries(source.previousTotalsPresence).reverse()),
    previousTotals: Object.fromEntries(Object.entries(source.previousTotals).reverse()),
    sessionMetaSeen: source.sessionMetaSeen,
    reAnchored: source.reAnchored,
    currentModel: { modelFingerprint: source.currentModel.modelFingerprint, modelRecognition: "unrecognized", modelId: "unknown" },
    schemaVersion: EXPORT_CHECKPOINT_PARSER_VERSION,
  };
  assert.equal(serializeCodexCheckpointState(source), serializeCodexCheckpointState(reordered));
  assert.equal(digestCodexCheckpointState(source), digestCodexCheckpointState(reordered));
  assert.match(digestCodexCheckpointState(source), /^[0-9a-f]{64}$/);
});

test("closed-shape validation rejects raw identifiers, arbitrary keys, and inconsistent totals", () => {
  const cases = [
    { mutate(value) { value.privateSessionId = "PRIVATE_SESSION_CANARY"; } },
    { mutate(value) { value.currentModel = { modelId: "private-model-canary", modelRecognition: "recognized", modelFingerprint: null }; } },
    { mutate(value) { value.currentModel = { modelId: "unknown", modelRecognition: "unrecognized", modelFingerprint: "PRIVATE_MODEL_CANARY" }; } },
    { mutate(value) { value.tier.rawProviderTier = "PRIVATE_FAST_CANARY"; } },
    { mutate(value) { value.pendingToolCounts.privateTool = 1; } },
    { mutate(value) { value.previousTotals = { input_tokens: 1 }; value.previousTotalsPresence = null; } },
    { mutate(value) { value.previousTotals = null; value.previousTotalsPresence = { input_tokens: false }; } },
    { mutate(value) { value.pendingToolCounts.mcp = 1_000_001; } },
    { mutate(value) { value.reAnchored = 1; } },
    { mutate(value) { value.sessionMetaSeen = "yes"; } },
    { mutate(value) { Object.defineProperty(value, "hidden", { value: "PRIVATE_HIDDEN_CANARY" }); } },
  ];
  for (const { mutate } of cases) {
    const value = createEmptyCodexCheckpointState();
    mutate(value);
    assert.throws(() => normalizeCodexCheckpointState(value), /Invalid privacy-safe Codex checkpoint state/);
  }
});

test("recognized checkpoint models remain limited to the reviewed export registry", () => {
  const accepted = createEmptyCodexCheckpointState();
  accepted.currentModel = {
    modelId: "gpt-5.6-sol",
    modelRecognition: "recognized",
    modelFingerprint: null,
  };
  assert.deepEqual(normalizeCodexCheckpointState(accepted).currentModel, accepted.currentModel);
  accepted.currentModel.modelId = "gpt-5.6-private-canary";
  assert.throws(() => normalizeCodexCheckpointState(accepted), /Invalid privacy-safe Codex checkpoint state/);
});

test("privacy canaries cannot enter serialization or validation errors", () => {
  const safe = serializeCodexCheckpointState(stateWithCumulativeTotals());
  for (const canary of ["PRIVATE_PROMPT_CANARY", "PRIVATE_RESPONSE_CANARY", "PRIVATE_SESSION_CANARY", "PRIVATE_MODEL_CANARY", "PRIVATE_TOOL_CANARY"]) {
    assert.equal(safe.includes(canary), false);
  }
  const invalid = createEmptyCodexCheckpointState();
  invalid.currentModel = { modelId: "PRIVATE_MODEL_CANARY", modelRecognition: "recognized", modelFingerprint: null };
  let error;
  try {
    normalizeCodexCheckpointState(invalid);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.equal(String(error).includes("PRIVATE_MODEL_CANARY"), false);
});
