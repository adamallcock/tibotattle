import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";
import { APP_OFFICIAL_PRICE_CARDS } from "@app-usagemonitor/accounting";
import {
  REVIEWED_MODEL_CATALOG, REVIEWED_CODEX_MODEL_IDS, TELEMETRY_MODEL_IDS,
  reviewedModelIdentity, codexRequestReasoningEffort, parseTelemetryContribution,
  codexCacheReasoningConfiguration,
} from "@app-usagemonitor/telemetry-contract";
import * as browser from "../apps/web/public/telemetry-shared.generated.js";
import { recognizedCodexModelId, codexModelPricingStatus, codexModelAllowanceTrack } from "../src/export/registries.js";
import { telemetryV01Golden } from "./fixtures/telemetry-contract-vectors.mjs";

test("reviewed identity catalog covers priced OpenAI models and explicit aliases, never provider tools", () => {
  const models = REVIEWED_MODEL_CATALOG.filter((entry) => entry.provider === "openai_codex");
  const priced = new Set(APP_OFFICIAL_PRICE_CARDS.filter((card) => card.provider === "openai"
    && card.model !== "openai-provider-tools").flatMap((card) => [card.model, ...(card.aliases ?? [])]));
  assert.deepEqual(models.filter((entry) => entry.pricingStatus !== "unpriced").map((entry) => entry.id).sort(), [...priced].sort());
  assert.deepEqual(models.filter((entry) => entry.pricingStatus === "unpriced").map((entry) => entry.id), ["gpt-5.3-codex-spark"]);
  assert.equal(models.length, 39);
  assert.equal(TELEMETRY_MODEL_IDS.length, new Set(TELEMETRY_MODEL_IDS).size);
  for (const entry of models) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(recognizedCodexModelId(entry.id.toUpperCase()), entry.id);
    assert.equal(codexModelPricingStatus(entry.id), entry.pricingStatus === "unpriced" ? "known_unpriced" : "priced");
    assert.equal(codexModelAllowanceTrack(entry.id), entry.allowanceTrack);
    assert.equal(reviewedModelIdentity(entry.id), entry);
  }
  assert.notEqual(reviewedModelIdentity("gpt-5.5-codex"), reviewedModelIdentity("gpt-5.5"));
  assert.equal(reviewedModelIdentity("gpt-5.5-codex").pricingStatus, "assumed_alias");
  assert.equal(reviewedModelIdentity("gpt-5.3-codex-spark").priceModelId, null);
  for (const value of ["gpt-6t", "gpt-6-astra-private", "openai-provider-tools", "gpt-5.6-sol/sensitive", null, {}]) {
    assert.equal(reviewedModelIdentity(value), null);
    assert.equal(recognizedCodexModelId(value), null);
  }
});

test("package, browser and closed upload schemas preserve all reviewed models and provider boundaries", async () => {
  assert.deepEqual(browser.REVIEWED_MODEL_CATALOG, REVIEWED_MODEL_CATALOG);
  assert.deepEqual(browser.TELEMETRY_MODEL_IDS, TELEMETRY_MODEL_IDS);
  // Existing enum positions remain stable; newly reviewed identities append.
  assert.deepEqual(TELEMETRY_MODEL_IDS.slice(0, 15), [
    "unknown", "gpt-4.1", "gpt-5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5",
    "gpt-5.5-codex", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
    "claude-fable-5", "claude-haiku-4-5-20251001", "claude-opus-4-8",
    "claude-sonnet-4-6", "claude-sonnet-5",
  ]);
  const schema = JSON.parse(await readFile(new URL("../packages/telemetry-contract/schemas/v0.2/usage-event.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...schema.properties.modelId.enum].sort(), [...TELEMETRY_MODEL_IDS].sort());
  const validateId = new Ajv().compile(schema.properties.modelId);
  for (const modelId of REVIEWED_CODEX_MODEL_IDS) {
    const record = telemetryV01Golden();
    record.usageEvents[0].modelId = modelId;
    assert.equal(validateId(modelId), true);
    assert.equal(parseTelemetryContribution(record), record);
    assert.equal(browser.parseTelemetryContribution(record), record);
    record.usageEvents[0].provider = "anthropic_claude_code";
    assert.throws(() => parseTelemetryContribution(record));
  }
  for (const modelId of ["gpt-6t", "o3-private", "unknown-model-content"]) assert.equal(validateId(modelId), false);
});

test("requested effort mapping is model-specific and does not assert cache or effective update state", () => {
  for (const [model, effort, expected] of [
    ["gpt-6-astra", "ultra", "xhigh"], ["gpt-6-astra", "max", "max"],
    ["gpt-6-astra", "xhigh", "xhigh"], ["gpt-5.6-sol", "ultra", "max"],
    ["gpt-6t", "ultra", "ultra"], ["claude-sonnet-5", "ultra", "ultra"],
    ["gpt-6-astra", "custom-private", null],
  ]) {
    assert.equal(codexRequestReasoningEffort(model, effort), expected);
    assert.equal(browser.codexRequestReasoningEffort(model, effort), expected);
  }
  assert.equal(codexCacheReasoningConfiguration("gpt-6-astra", "ultra"), "ultra");
  assert.equal(codexCacheReasoningConfiguration("gpt-6-astra", "xhigh"), "xhigh");
  assert.equal(codexCacheReasoningConfiguration("gpt-6-astra", "max"), "max");
  assert.equal(codexCacheReasoningConfiguration("gpt-5.6-sol", "ultra"), "max");
  assert.equal(codexCacheReasoningConfiguration("gpt-6t", "ultra"), "ultra");
  assert.equal(codexCacheReasoningConfiguration("gpt-6-astra", "unreviewed"), null);
  assert.equal(browser.codexCacheReasoningConfiguration("gpt-6-astra", "ultra"), "ultra");
});
