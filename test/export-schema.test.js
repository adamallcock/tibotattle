import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { validateExportRecord } from "../src/export-schema.js";

function usageEvent() {
  return {
    schemaVersion: "usage-event-v0.1",
    eventTime: "2026-07-24T12:00:00.000Z",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    modelFingerprint: null,
    billingSurface: "chatgpt_subscription",
    speedMode: "fast",
    apiServiceTier: "unknown",
    reasoningEffort: "unknown",
    components: {
      inputUncachedTokens: 10,
      inputCacheReadTokens: 20,
      inputCacheWriteTokens: 0,
      outputTextTokens: 5,
      outputReasoningTokens: 3,
    },
    totalInputContextTokens: 30,
    surface: "local_interactive_unclassified",
    agentScope: "root",
    lineageDisposition: "standalone",
    toolClassCounts: {},
    outcome: "unknown",
    eventId: `event:v1:${"A".repeat(43)}`,
    sessionScopeId: `session:v1:${"B".repeat(43)}`,
    accountScopeId: "unattributed",
  };
}

test("allowlist schema accepts a valid usage event and rejects unknown nested fields", () => {
  assert.equal(validateExportRecord("usageEvent", usageEvent()).valid, true);
  const contaminated = usageEvent();
  contaminated.components.prompt = "private";
  const result = validateExportRecord("usageEvent", contaminated);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.keyword === "additionalProperties"));
  assert.equal(JSON.stringify(result.errors).includes("private"), false);
});

test("arbitrary source-like fields cannot pass the strict usage schema", () => {
  fc.assert(fc.property(
    fc.stringMatching(/^[a-z][a-zA-Z0-9]{2,24}$/).filter((key) => !Object.hasOwn(usageEvent(), key)),
    fc.oneof(fc.string(), fc.integer(), fc.boolean()),
    (key, value) => {
      const candidate = { ...usageEvent(), [key]: value };
      return validateExportRecord("usageEvent", candidate).valid === false;
    },
  ), { numRuns: 100 });
});
