import test from "node:test";
import assert from "node:assert/strict";
import { localSafeRecords } from "../src/local-node-runtime.js";
import { stableJson } from "../src/storage.js";

const {
  createEmptySafeToolClassCounts,
  normalizeCodexUsageEvent,
  safeExportModelDeclaration,
  safeToolCountFieldForScannerToolClass,
} = localSafeRecords;

const SECRET = Buffer.alloc(32, 9);

function usageEvent(overrides = {}) {
  return {
    timestamp: "2026-07-24T12:00:00.000Z",
    model: "gpt-5.6-sol",
    raw: {
      input_tokens: 120,
      cached_input_tokens: 20,
      cache_write_input_tokens: 0,
      output_tokens: 30,
      reasoning_output_tokens: 8,
      total_tokens: 150,
    },
    rawAvailability: {
      input_tokens: true,
      cached_input_tokens: true,
      cache_write_input_tokens: true,
      output_tokens: true,
      reasoning_output_tokens: true,
      total_tokens: true,
    },
    components: {
      input_uncached_tokens: 100,
      input_cache_read_tokens: 20,
      input_cache_write_tokens: 0,
      output_text_tokens: 22,
      output_reasoning_tokens: 8,
    },
    componentAvailability: {
      input_uncached_tokens: true,
      input_cache_read_tokens: true,
      input_cache_write_tokens: true,
      output_text_tokens: true,
      output_reasoning_tokens: true,
    },
    tierSemantics: {
      billingSurface: "chatgpt_subscription",
      codexSpeedMode: "fast",
      apiServiceTier: "priority",
    },
    surfaceClassification: {
      surface: "local_rollout_unclassified",
      agentScope: "root",
      lineageDisposition: "standalone",
    },
    sourceScopeId: `session:v1:${"9".repeat(64)}`,
    sourceRecordOrdinal: 17,
    ...overrides,
  };
}

function checkpointUsageEvent(modelDeclaration) {
  const event = usageEvent({ modelDeclaration });
  delete event.model;
  return event;
}

test("checkpoint model declaration produces byte-identical normalized usage to raw-model mode", () => {
  const raw = usageEvent({ model: "private model /Users/alice/private-project" });
  const declaration = safeExportModelDeclaration(SECRET, raw.model);
  const checkpoint = checkpointUsageEvent(declaration);

  const rawRecord = normalizeCodexUsageEvent(SECRET, raw);
  const checkpointRecord = normalizeCodexUsageEvent(SECRET, checkpoint);
  assert.equal(stableJson(checkpointRecord), stableJson(rawRecord));
  assert.equal(checkpointRecord.modelId, "unknown");
  assert.match(checkpointRecord.modelFingerprint, /^model:v1:/);
  assert.equal(stableJson(checkpointRecord).includes(raw.model), false);
});

test("recognized declarations and raw recognized models retain parity", () => {
  const raw = normalizeCodexUsageEvent(SECRET, usageEvent());
  const event = checkpointUsageEvent(safeExportModelDeclaration(SECRET, "gpt-5.6-sol"));
  const checkpoint = normalizeCodexUsageEvent(SECRET, event);
  assert.equal(stableJson(checkpoint), stableJson(raw));
  assert.deepEqual(checkpoint.modelFingerprint, null);
});

test("safe tool counters are fresh, fixed shape, and collapse unknown scanner classes", () => {
  const first = createEmptySafeToolClassCounts();
  const second = createEmptySafeToolClassCounts();
  first.localShell = 4;
  assert.equal(second.localShell, 0);
  assert.deepEqual(Object.keys(first), [
    "webSearch", "fileSearch", "codeInterpreter", "hostedShell", "computerUse", "mcp",
    "applyPatch", "localShell", "subagent", "toolGateway", "other", "unknown",
  ]);
  assert.equal(safeToolCountFieldForScannerToolClass("web_search"), "webSearch");
  assert.equal(safeToolCountFieldForScannerToolClass("local_shell"), "localShell");
  assert.equal(safeToolCountFieldForScannerToolClass("tool_gateway"), "toolGateway");
  assert.equal(safeToolCountFieldForScannerToolClass("PRIVATE_TOOL_NAME_CANARY"), "unknown");
  assert.equal(safeToolCountFieldForScannerToolClass(null), "unknown");
});

test("invalid checkpoint declarations and ambiguous raw-model input fail without echoing", () => {
  const canary = "PRIVATE_RAW_MODEL_CANARY";
  const invalidCases = [
    checkpointUsageEvent({ ...safeExportModelDeclaration(SECRET, "gpt-5.6-sol"), rawProviderModel: canary }),
    checkpointUsageEvent({ modelId: "unknown", modelRecognition: "unrecognized", modelFingerprint: canary }),
    usageEvent({ model: canary, modelDeclaration: safeExportModelDeclaration(SECRET, "gpt-5.6-sol") }),
  ];
  for (const event of invalidCases) {
    let error;
    try {
      normalizeCodexUsageEvent(SECRET, event);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.match(String(error), /Invalid privacy-safe model declaration/);
    assert.equal(String(error).includes(canary), false);
  }
});
