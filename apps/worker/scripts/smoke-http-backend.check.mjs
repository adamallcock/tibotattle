import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDerivedCommunityExpectations,
  deriveCommunityExpectations,
} from "./smoke-http-backend-lib.mjs";

function usageEvent({
  provider = "openai_codex",
  modelId = "gpt-5.6-sol",
  components = {},
  toolUnits = 0,
} = {}) {
  return {
    provider,
    modelId,
    components: {
      inputUncachedTokens: null,
      inputCacheReadTokens: null,
      inputCacheWriteTokens: null,
      outputTextTokens: null,
      outputReasoningTokens: null,
      outputCombinedTokens: null,
      ...components,
    },
    toolClassCounts: {
      other: toolUnits,
    },
  };
}

test("derives the original generated-fixture clipped and rounded expectations", () => {
  const expected = deriveCommunityExpectations({
    usageEvents: [usageEvent({
      components: {
        inputUncachedTokens: 100,
        inputCacheReadTokens: 900,
        inputCacheWriteTokens: 0,
        outputTextTokens: 50,
        outputReasoningTokens: 25,
      },
    })],
  }, 20);

  assert.equal(expected.comparisonCells.length, 1);
  assert.deepEqual(expected.comparisonCells[0].metrics.usageEvents, {
    status: "comparable",
    participantClippedValue: 1,
    communityRoundedValue: 20,
    unit: "events",
  });
  assert.deepEqual(expected.comparisonCells[0].metrics.inputCacheReadTokens, {
    status: "comparable",
    participantClippedValue: 900,
    communityRoundedValue: 0,
    unit: "tokens",
  });
  assert.deepEqual(expected.comparisonCells[0].metrics.outputCombinedTokens, {
    status: "community_not_released",
  });
  assert.deepEqual(expected.aggregateCells[0].metrics.inputCacheReadTokens, {
    status: "released",
    value: 0,
    unit: "tokens_rounded_down",
  });
});

test("derives arbitrary multi-cell sums, clipping, null suppression, and round-down", () => {
  const contribution = {
    usageEvents: [
      usageEvent({
        components: {
          inputCacheReadTokens: 3_000_000,
          outputTextTokens: 60_001,
        },
        toolUnits: 7,
      }),
      usageEvent({
        components: {
          inputCacheReadTokens: 3_000_000,
          outputTextTokens: 60_001,
        },
        toolUnits: 6,
      }),
      usageEvent({
        provider: "anthropic_claude_code",
        modelId: "claude-sonnet-5",
        components: {
          outputCombinedTokens: 123_456,
        },
        toolUnits: 13,
      }),
    ],
  };

  const expected = deriveCommunityExpectations(contribution, 20);
  assert.equal(expected.comparisonCells.length, 2);
  const openai = expected.comparisonCells.find(
    (cell) => cell.provider === "openai_codex",
  );
  const claude = expected.comparisonCells.find(
    (cell) => cell.provider === "anthropic_claude_code",
  );
  assert.deepEqual(openai.metrics.inputCacheReadTokens, {
    status: "comparable",
    participantClippedValue: 5_000_000,
    communityRoundedValue: 100_000_000,
    unit: "tokens",
  });
  assert.deepEqual(openai.metrics.outputTextTokens, {
    status: "comparable",
    participantClippedValue: 120_002,
    communityRoundedValue: 2_400_000,
    unit: "tokens",
  });
  assert.deepEqual(claude.metrics.inputCacheReadTokens, {
    status: "community_not_released",
  });
  assert.deepEqual(claude.metrics.outputCombinedTokens, {
    status: "comparable",
    participantClippedValue: 123_456,
    communityRoundedValue: 2_400_000,
    unit: "tokens",
  });
  assert.deepEqual(claude.metrics.toolUnits, {
    status: "comparable",
    participantClippedValue: 13,
    communityRoundedValue: 260,
    unit: "units",
  });
});

test("asserts both private comparison and public aggregate against derived cells", () => {
  const contribution = {
    usageEvents: [usageEvent({
      components: {
        inputCacheReadTokens: 12_345,
      },
    })],
  };
  const expected = deriveCommunityExpectations(contribution, 20);

  assert.doesNotThrow(() => assertDerivedCommunityExpectations({
    contribution,
    participantCount: 20,
    comparisonCells: structuredClone(expected.comparisonCells),
    aggregateCells: structuredClone(expected.aggregateCells),
  }));

  const incorrect = structuredClone(expected);
  incorrect.comparisonCells[0].metrics.inputCacheReadTokens.communityRoundedValue = 1;
  assert.throws(
    () => assertDerivedCommunityExpectations({
      contribution,
      participantCount: 20,
      comparisonCells: incorrect.comparisonCells,
      aggregateCells: incorrect.aggregateCells,
    }),
    /Private community comparison did not match the derived values/,
  );
});
