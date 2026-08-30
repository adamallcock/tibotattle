import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_WINDOW_BREAKDOWN_SCHEMA_VERSION,
  MAX_WINDOW_BREAKDOWN_SPAN_MS,
  readLocalUnifiedWindowBreakdown,
  summarizeWindowBreakdownRows,
} from "../src/local-unified-window-breakdown.js";

// A row shaped exactly like the unified-index usage SELECT the reader runs.
function usageRow({
  model,
  speed = "standard",
  observedAt = "2026-07-29T20:00:00.000Z",
  inputUncached = 0,
  cacheRead = 0,
  cacheWrite = 0,
  outputText = 0,
  outputReasoning = 0,
  outputCombined = 0,
}) {
  return {
    observed_at_ms: Date.parse(observedAt),
    model_id: model,
    codex_speed_mode: speed,
    api_service_tier: "unknown",
    tokens_in_uncached: inputUncached,
    tokens_in_cache_read: cacheRead,
    tokens_in_cache_write: cacheWrite,
    tokens_out_text: outputText,
    tokens_out_reasoning: outputReasoning,
    tokens_out_combined: outputCombined,
  };
}

test("windowed repricing groups by model and speed with a real priced cost", () => {
  const rows = [
    // gpt-5.6-sol, standard: input + output tokens are both priced.
    usageRow({ model: "gpt-5.6-sol", speed: "standard", inputUncached: 1_000_000, outputText: 100_000 }),
    // gpt-5.6-sol, fast: same tokens, a different observed speed bucket.
    usageRow({ model: "gpt-5.6-sol", speed: "fast", inputUncached: 1_000_000, outputText: 100_000 }),
    // gpt-5.4-mini, standard: a cheaper priced model.
    usageRow({ model: "gpt-5.4-mini", speed: "standard", inputUncached: 500_000, outputText: 50_000 }),
    // A zero-token row contributes nothing (projection returns null).
    usageRow({ model: "gpt-5.6-sol", speed: "standard" }),
  ];
  const summary = summarizeWindowBreakdownRows(rows);

  assert.equal(summary.events, 3);
  assert.equal(summary.unpricedEvents, 0);
  assert.equal(summary.unpricedShare, 0);
  assert.ok(summary.costUsd > 0, "priced through the real registry");

  // Two models, sorted by cost descending. gpt-5.6-sol dominates.
  assert.equal(summary.byModel.length, 2);
  assert.equal(summary.byModel[0].model, "gpt-5.6-sol");
  assert.equal(summary.byModel[0].events, 2);
  // This July long-context epoch has Standard rates but no Priority card.
  assert.equal(summary.byModel[0].fastModeMultiplier, null);
  assert.equal(summary.byModel[0].fastModeFamily, "unsupported");
  assert.equal(summary.byModel[1].model, "gpt-5.4-mini");
  assert.equal(summary.byModel[1].events, 1);

  // Speed buckets: one standard sol, one fast sol, one standard mini.
  assert.equal(summary.bySpeed.standard.events, 2);
  assert.equal(summary.bySpeed.fast.events, 1);
  assert.equal(summary.fastEvents, 1);
  assert.ok(summary.fastCostUsd > 0);
  // The fast bucket is exactly the fast sol event's cost.
  assert.equal(summary.fastCostUsd, summary.bySpeed.fast.costUsd);

  // The model costs sum to the window total (within float rounding).
  const modelSum = summary.byModel.reduce((total, row) => total + row.costUsd, 0);
  assert.ok(Math.abs(modelSum - summary.costUsd) < 1e-6);
});

test("unpriced share reflects models with no published price card", () => {
  const rows = [
    // gpt-5.6-sol is priced.
    usageRow({ model: "gpt-5.6-sol", inputUncached: 1_000_000, outputText: 10_000 }),
    // gpt-5.3-codex-spark meters against its own allowance: it is separated out
    // as Spark, never counted in the main-pool unpriced share.
    usageRow({ model: "gpt-5.3-codex-spark", inputUncached: 1_000_000, outputText: 10_000 }),
    // An unrecognized identity is priced as "unknown" and carries no price.
    usageRow({ model: "totally-made-up-model", inputUncached: 1_000_000, outputText: 10_000 }),
  ];
  const summary = summarizeWindowBreakdownRows(rows);

  // Spark is excluded from the main pool entirely.
  assert.equal(summary.spark.events, 1);
  assert.equal(summary.events, 2);
  // One of the two main-pool events (the unknown model) is unpriced.
  assert.equal(summary.unpricedEvents, 1);
  assert.equal(summary.unpricedShare, 0.5);
  const unknownRow = summary.byModel.find((row) => row.model === "unknown");
  assert.ok(unknownRow, "unrecognized identity is grouped as unknown");
  assert.equal(unknownRow.unpricedShare, 1);
});

test("readLocalUnifiedWindowBreakdown validates the range before touching disk", async () => {
  await assert.rejects(
    readLocalUnifiedWindowBreakdown({ indexFile: "/nonexistent.sqlite", fromMs: 200, toMs: 100 }),
    (error) => error.code === "window_range_invalid",
  );
  await assert.rejects(
    readLocalUnifiedWindowBreakdown({
      indexFile: "/nonexistent.sqlite",
      fromMs: 0,
      toMs: MAX_WINDOW_BREAKDOWN_SPAN_MS + 1,
    }),
    (error) => error.code === "window_range_invalid",
  );
  await assert.rejects(
    readLocalUnifiedWindowBreakdown({ indexFile: "", fromMs: 100, toMs: 200 }),
    TypeError,
  );
});

test("a missing index degrades to a typed unavailable breakdown", async () => {
  const result = await readLocalUnifiedWindowBreakdown({
    indexFile: "/definitely/not/a/real/index.sqlite",
    fromMs: 100,
    toMs: 200,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.schemaVersion, LOCAL_WINDOW_BREAKDOWN_SCHEMA_VERSION);
  assert.equal(result.from, 100);
  assert.equal(result.to, 200);
});
