import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_DESKTOP_ACCOUNTING_VENDOR,
  CLAUDE_DESKTOP_PRICING_ADAPTER_VERSION,
  CLAUDE_DESKTOP_PRODUCT_PROVIDER,
  claudeDesktopWinnerToPricingRecord,
  priceClaudeDesktopWinner,
} from "../src/claude-desktop-pricing.js";
import { priceClaudeUsageRecord } from "@app-usagemonitor/accounting";

const RECOGNIZED_WINNER = Object.freeze({
  provider: "anthropic_claude_code",
  eventTime: "2026-07-25T15:00:00.000Z",
  modelDeclaration: Object.freeze({
    modelId: "claude-sonnet-4-6",
    modelRecognition: "recognized",
    modelFingerprint: null,
  }),
  billingSurface: "claude_subscription",
  outputKind: "provider_reported_combined",
  totalInputContextTokens: 3_000_000,
  components: Object.freeze({
    inputUncachedTokens: 1_000_000,
    inputCacheReadTokens: 1_000_000,
    inputCacheWriteTokens: 1_000_000,
    inputCacheWrite5mTokens: 500_000,
    inputCacheWrite1hTokens: 500_000,
    outputCombinedTokens: 1_000_000,
  }),
});

function makeWinner(overrides = {}) {
  const winner = structuredClone(RECOGNIZED_WINNER);
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "components" || key === "modelDeclaration") {
      winner[key] = { ...winner[key], ...value };
    } else {
      winner[key] = value;
    }
  }
  return winner;
}

function wrapWinner(candidate = makeWinner(), overrides = {}) {
  return {
    provider: "anthropic_claude_code",
    billingSurface: "claude_subscription",
    outputKind: "provider_reported_combined",
    sourceKey: "a".repeat(64),
    sourceGeneration: 1,
    candidate,
    ...overrides,
  };
}

test("Claude winner adapter preserves canonical pricing and vendor semantics", () => {
  const wrapped = wrapWinner();
  const record = claudeDesktopWinnerToPricingRecord(wrapped);
  assert.deepEqual(record, {
    eventTime: RECOGNIZED_WINNER.eventTime,
    modelId: "claude-sonnet-4-6",
    modelRecognition: "recognized",
    totalInputContextTokens: 3_000_000,
    components: { ...RECOGNIZED_WINNER.components },
  });

  const projected = priceClaudeDesktopWinner(RECOGNIZED_WINNER);
  const direct = priceClaudeUsageRecord(record);
  assert.deepEqual(projected.pricing, direct);
  assert.equal(projected.productProvider, CLAUDE_DESKTOP_PRODUCT_PROVIDER);
  assert.equal(projected.accountingVendor, CLAUDE_DESKTOP_ACCOUNTING_VENDOR);
  assert.equal(projected.pricing.provider, "anthropic");
  assert.equal(projected.pricing.surface, "anthropic.messages");
  assert.equal(projected.pricing.coverageStatus, "fully_priced");
  assert.equal(projected.pricing.pricingContext.pricedAt, RECOGNIZED_WINNER.eventTime);
  assert.equal(
    projected.pricing.components.find((item) => item.name === "output_combined_tokens").pricedAs,
    "output_text_tokens",
  );
  assert.equal(
    CLAUDE_DESKTOP_PRICING_ADAPTER_VERSION,
    "claude-desktop-winner-pricing-adapter-v0.2",
  );
});

test("ledger-shaped counters are rejected instead of being priced as a canonical winner", () => {
  assert.throws(
    () => claudeDesktopWinnerToPricingRecord({
      provider: "anthropic_claude_code",
      eventTime: RECOGNIZED_WINNER.eventTime,
      billingSurface: "claude_subscription",
      outputKind: "provider_reported_combined",
      modelKey: "b".repeat(64),
      inputUncachedTokens: 10,
      inputCacheReadTokens: 20,
      inputCacheWriteTokens: 30,
      outputCombinedTokens: 40,
    }),
    /model_declaration|components_shape/,
  );
});

test("unknown model and absent cache TTL stay visibly unpriced without exposing a raw label", () => {
  const winner = makeWinner({
    modelDeclaration: {
      modelId: "unknown",
      modelRecognition: "unrecognized",
      modelFingerprint: `model:v1:${"c".repeat(64)}`,
    },
    components: {
      inputUncachedTokens: 10,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 5,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
      outputCombinedTokens: 2,
    },
    totalInputContextTokens: 15,
  });
  const result = priceClaudeDesktopWinner(winner);
  assert.equal(result.pricing.model, "unknown");
  assert.equal(result.pricing.coverageStatus, "unpriced");
  assert.equal(result.pricing.totalUsd, "0");
  assert.equal(
    result.pricing.warnings.coverage.some((warning) => warning.code === "anthropic_cache_write_ttl_split_missing"),
    true,
  );
  assert.equal(
    result.pricing.components.some((item) => item.reasonCode === "anthropic_cache_write_ttl_split_missing"),
    true,
  );
  assert.equal(JSON.stringify(result).includes("claude-secret-model"), false);
});

test("provider, billing surface, and output kind are exact on both winner layers", () => {
  for (const [field, value, pattern] of [
    ["provider", "openai_codex", /provider/],
    ["billingSurface", "openai_api", /billingSurface/],
    ["outputKind", "separate_text_reasoning", /outputKind/],
  ]) {
    assert.throws(() => claudeDesktopWinnerToPricingRecord(makeWinner({ [field]: value })), pattern);
    assert.throws(() => claudeDesktopWinnerToPricingRecord(
      wrapWinner(makeWinner(), { [field]: value }),
    ), pattern);
  }
  assert.throws(
    () => claudeDesktopWinnerToPricingRecord(
      wrapWinner(makeWinner({ provider: "openai_codex" })),
    ),
    /provider/,
  );
  assert.throws(
    () => claudeDesktopWinnerToPricingRecord(
      wrapWinner(makeWinner(), { candidate: makeWinner({ provider: "openai_codex" }) }),
    ),
    /provider/,
  );
  const missingSurface = makeWinner();
  delete missingSurface.billingSurface;
  assert.throws(() => claudeDesktopWinnerToPricingRecord(missingSurface), /billingSurface/);
  const missingOutputKind = makeWinner();
  delete missingOutputKind.outputKind;
  assert.throws(() => claudeDesktopWinnerToPricingRecord(missingOutputKind), /outputKind/);
});

test("token counters require safe nonnegative values and exact reconciliation", () => {
  const invalidWinners = [
    [
      "negative input",
      makeWinner({ components: { inputUncachedTokens: -1 } }),
      /components_inputUncachedTokens/,
    ],
    [
      "unsafe output",
      makeWinner({ components: { outputCombinedTokens: Number.MAX_SAFE_INTEGER + 1 } }),
      /components_outputCombinedTokens/,
    ],
    [
      "wrong aggregate",
      makeWinner({ totalInputContextTokens: 3_000_001 }),
      /input_reconciliation/,
    ],
    [
      "split exceeds aggregate zero",
      makeWinner({
        totalInputContextTokens: 0,
        components: {
          inputUncachedTokens: 0,
          inputCacheReadTokens: 0,
          inputCacheWriteTokens: 0,
          inputCacheWrite5mTokens: 1,
          inputCacheWrite1hTokens: 0,
          outputCombinedTokens: 0,
        },
      }),
      /cache_write_reconciliation/,
    ],
    [
      "only one TTL split",
      makeWinner({ components: { inputCacheWrite5mTokens: 1, inputCacheWrite1hTokens: null } }),
      /cache_write_ttl_pair/,
    ],
    [
      "split does not reconcile",
      makeWinner({ components: { inputCacheWrite5mTokens: 400_000, inputCacheWrite1hTokens: 400_000 } }),
      /cache_write_reconciliation/,
    ],
  ];
  for (const [name, winner, pattern] of invalidWinners) {
    assert.throws(() => claudeDesktopWinnerToPricingRecord(winner), pattern, name);
  }
});

test("event time must already be canonical ISO with milliseconds", () => {
  assert.throws(
    () => claudeDesktopWinnerToPricingRecord(makeWinner({ eventTime: "2026-07-25T15:00:00Z" })),
    /event_time/,
  );
  assert.throws(
    () => claudeDesktopWinnerToPricingRecord(makeWinner({ eventTime: "not-a-date" })),
    /event_time/,
  );
});

test("model declarations require the reviewed Claude allowlist and a closed safe shape", () => {
  assert.throws(
    () => claudeDesktopWinnerToPricingRecord(makeWinner({
      modelDeclaration: {
        modelId: "claude-secret-model",
        modelRecognition: "recognized",
        modelFingerprint: null,
      },
    })),
    /model_declaration/,
  );
  assert.throws(
    () => claudeDesktopWinnerToPricingRecord(makeWinner({
      modelDeclaration: {
        modelId: "claude-secret-model",
        modelRecognition: "unrecognized",
        modelFingerprint: `model:v1:${"d".repeat(64)}`,
      },
    })),
    /model_declaration/,
  );
  assert.throws(
    () => claudeDesktopWinnerToPricingRecord(makeWinner({
      modelDeclaration: {
        modelId: "claude-sonnet-4-6",
        modelRecognition: "recognized",
        modelFingerprint: null,
        rawLabel: "PRIVATE_RAW_LABEL",
      },
    })),
    /model_declaration_shape/,
  );
  const missing = makeWinner({
    modelDeclaration: { modelId: "unknown", modelRecognition: "missing", modelFingerprint: null },
  });
  const missingRecord = claudeDesktopWinnerToPricingRecord(missing);
  assert.equal(missingRecord.modelId, "unknown");
  assert.equal(missingRecord.modelRecognition, "missing");
  assert.equal(Object.hasOwn(missingRecord, "modelFingerprint"), false);
});

test("pricing cannot switch away from event-time Standard semantics", () => {
  assert.throws(
    () => priceClaudeDesktopWinner(RECOGNIZED_WINNER, { priceEpochBasis: "current_price_sensitivity" }),
    /event_time/,
  );
  assert.throws(
    () => priceClaudeDesktopWinner(RECOGNIZED_WINNER, { apiServiceTier: "batch" }),
    /standard/,
  );
  assert.throws(
    () => priceClaudeDesktopWinner(RECOGNIZED_WINNER, { provider: "anthropic" }),
    /pricing_option_provider/,
  );
});

test("winner adapter rejects cross-provider input and does not mutate the winner", () => {
  const winner = structuredClone(RECOGNIZED_WINNER);
  const before = structuredClone(winner);
  assert.throws(
    () => claudeDesktopWinnerToPricingRecord({ ...winner, provider: "openai_codex" }),
    /provider/,
  );
  priceClaudeDesktopWinner(winner);
  assert.deepEqual(winner, before);
});
