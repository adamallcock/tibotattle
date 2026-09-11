import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveCodexTransitionSeries,
  deriveCodexTransitionSeriesCooperatively,
  mineCodexTransitions,
} from "../src/codex-transition-miner.js";
import { scanAndPriceCodexLogs } from "../src/codex-local-usage-analysis.js";
import { stableJson, writeJsonOwnerOnlyAtomic } from "../src/storage.js";

const PRICE_CARDS = [{
  schema_version: "0.1",
  id: "openai:gpt-test:test",
  provider: "openai",
  model: "gpt-test",
  components: [
    { usage_component: "input_uncached_tokens", unit: "token", price: { amount: "1", currency: "USD", per: "1" } },
    { usage_component: "input_cache_read_tokens", unit: "token", price: { amount: "0.1", currency: "USD", per: "1" } },
    { usage_component: "output_text_tokens", unit: "token", price: { amount: "2", currency: "USD", per: "1" } },
    { usage_component: "output_reasoning_tokens", unit: "token", price: { amount: "3", currency: "USD", per: "1" } },
  ],
  source: { name: "test", url: "https://example.invalid/pricing", retrieved_at: "2026-07-23T00:00:00.000Z" },
}];

function usage(input, output = 0, cached = 0, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function limits({ primary, secondary, reset = 1784854800 }) {
  return {
    limit_id: "codex",
    plan_type: "pro",
    primary: primary === null ? null : {
      used_percent: primary,
      window_minutes: 300,
      resets_at: reset,
    },
    secondary: secondary === undefined || secondary === null ? null : {
      used_percent: secondary,
      window_minutes: 10080,
      resets_at: reset + 604800,
    },
  };
}

function tokenRecord(timestamp, total, last, rateLimits) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last },
      rate_limits: rateLimits,
    },
  });
}

function tierRecord(timestamp, serviceTier) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "thread_settings_applied",
      thread_settings: { service_tier: serviceTier },
    },
  });
}

async function fixtureHome(lines, { archiveLines = null, name = "rollout-2026-07-23T00-00-00-fixture.jsonl" } = {}) {
  const home = await mkdtemp(join(tmpdir(), "app-usagemonitor-transition-"));
  await mkdir(join(home, "sessions"), { recursive: true });
  await writeFile(join(home, "sessions", name), `${lines.join("\n")}\n`);
  if (archiveLines) {
    await mkdir(join(home, "archived_sessions"), { recursive: true });
    await writeFile(join(home, "archived_sessions", name), `${archiveLines.join("\n")}\n`);
  }
  return home;
}

function metadata(model = "gpt-test") {
  return [
    JSON.stringify({ timestamp: "2026-07-23T00:00:00.000Z", type: "session_meta", payload: { id: "fixture-session-private" } }),
    JSON.stringify({ timestamp: "2026-07-23T00:00:00.001Z", type: "turn_context", payload: { model } }),
  ];
}

const RANGE = {
  startAt: "2026-07-22T23:59:00.000Z",
  endAt: "2026-07-23T00:10:00.000Z",
  priceCards: PRICE_CARDS,
};

test("legacy pricing consumers preserve short-context Priority and long-context assumed subtotals", async () => {
  const home = await fixtureHome([
    ...metadata("gpt-5.5"),
    tokenRecord("2026-07-23T00:00:01.000Z", usage(1_000), usage(1_000), null),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(273_000), usage(272_000), null),
  ]);
  try {
    const options = { ...RANGE, priceCards: null, codexHome: home };
    const transitions = await mineCodexTransitions(options);
    const local = await scanAndPriceCodexLogs(options);
    for (const sensitivity of [
      transitions.pricing.subscriptionSpeedSensitivity,
      local.runcost.subscriptionSpeedSensitivity,
    ]) {
      assert.equal(sensitivity.scenarios.standard.weightedStandardApiEquivalentUsd, 2.725);
      assert.equal(sensitivity.scenarios.fast.weightedStandardApiEquivalentUsd, 5.4525);
      assert.equal(sensitivity.scenarios.fast.assumedRatioStandardApiEquivalentUsd, 2.72);
      assert.equal(sensitivity.modelMultipliers["gpt-5.5"], null);
    }
    assert.equal(transitions.pricing.observedTierSensitivity.complete, true);
    assert.equal(transitions.pricing.observedTierSensitivity.upperWeightedStandardApiEquivalentUsd, 5.4525);
  } finally {
    await rm(home, { recursive: true });
  }
});

test("pure transition derivation rejects invalid envelopes and ignores malformed rows", () => {
  assert.throws(
    () => deriveCodexTransitionSeries({
      startAt: "not-an-instant",
      endAt: RANGE.endAt,
    }),
    /Transition series inputs are invalid/,
  );
  const derived = deriveCodexTransitionSeries({
    startAt: RANGE.startAt,
    endAt: RANGE.endAt,
    rawUsageEvents: [null, "not-an-event"],
    rateLimitSnapshots: [null, { timestamp: RANGE.startAt }],
    toolEvents: [null],
  });
  assert.equal(derived.usageEvents.length, 0);
  assert.equal(derived.rateLimitSnapshots.length, 0);
  assert.equal(derived.transitions.length, 0);
});

test("cooperative transition derivation preserves the synchronous result", async () => {
  const rawUsageEvents = [{
    timestamp: "2026-07-23T00:00:01.000Z",
    model: "gpt-test",
    totalInputContextTokens: 10,
    components: {
      input_uncached_tokens: 10,
      input_cache_read_tokens: 0,
      input_cache_write_tokens: 0,
      output_text_tokens: 0,
      output_reasoning_tokens: 0,
    },
    tierSemantics: {
      codexSpeedMode: "standard",
      apiServiceTier: "unknown",
    },
  }];
  const rateLimitSnapshots = [1, 2].map((usedPercent, index) => ({
    timestamp: `2026-07-23T00:00:0${index + 1}.000Z`,
    window: {
      provider: "openai_codex",
      planType: "pro",
      limitId: "codex",
      slot: "primary",
      windowDurationMins: 300,
      resetsAt: 1784854800,
      usedPercent,
    },
  }));
  const options = {
    ...RANGE,
    rawUsageEvents,
    rateLimitSnapshots,
    diagnostics: {},
    includeSnapshotIntervals: false,
  };

  assert.deepEqual(
    await deriveCodexTransitionSeriesCooperatively(options),
    deriveCodexTransitionSeries(options),
  );
});

test("transition miner collapses repeated snapshots and retains skipped and regressing transitions", async () => {
  const lines = [
    ...metadata(),
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), limits({ primary: 1 })),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(20), usage(10), limits({ primary: 1 })),
    tokenRecord("2026-07-23T00:00:03.000Z", usage(30), usage(10), limits({ primary: 3 })),
    tokenRecord("2026-07-23T00:00:04.000Z", usage(40), usage(10), limits({ primary: 2 })),
  ];
  const home = await fixtureHome(lines);
  try {
    const dataset = await mineCodexTransitions({ ...RANGE, codexHome: home });
    assert.equal(dataset.summary.transitions, 2);
    assert.equal(dataset.summary.snapshotIntervals, 3);
    assert.deepEqual(dataset.snapshotIntervals.map((item) => item.nextUsedPercent - item.priorUsedPercent), [0, 2, -1]);
    assert.equal(dataset.snapshotIntervals[0].marginalApiPricedUsd, 10);
    assert.deepEqual(dataset.transitions.map((item) => [item.priorUsedPercent, item.nextUsedPercent]), [[1, 3], [3, 2]]);
    assert.equal(dataset.transitions[0].lastPriorObservedAt, "2026-07-23T00:00:02.000Z");
    assert.equal(dataset.transitions[0].marginalApiPricedUsd, 10);
    assert.equal(dataset.transitions[0].marginalComponents.input_uncached_tokens, 10);
    assert.match(dataset.pricing.eventTimeHistoricalTotalUsdExact, /^\d+(?:\.\d+)?$/u);
    assert.equal(dataset.pricing.currentPriceSensitivityTotalUsdExact, null);
    assert.equal(dataset.pricing.serviceTier.observed, null);
    assert.equal(dataset.pricing.serviceTier.apiPriceAssumption, "standard");
    assert.equal(dataset.pricing.longContext.observedFrom, "per_event_total_input_tokens");
    assert.ok(dataset.transitions[0].quality.warnings.includes("display_percentage_skipped_value"));
    assert.ok(dataset.transitions[1].quality.warnings.includes("display_percentage_regression"));
  } finally {
    await rm(home, { recursive: true });
  }
});

test("transition miner separates reset identities and simultaneous five-hour and weekly windows", async () => {
  const firstReset = 1784854800;
  const secondReset = firstReset + 300;
  const lines = [
    ...metadata(),
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), limits({ primary: 1, secondary: 10, reset: firstReset })),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(20), usage(10), limits({ primary: 2, secondary: 11, reset: firstReset })),
    tokenRecord("2026-07-23T00:00:03.000Z", usage(30), usage(10), limits({ primary: 0, secondary: null, reset: secondReset })),
    tokenRecord("2026-07-23T00:00:04.000Z", usage(40), usage(10), limits({ primary: 1, secondary: null, reset: secondReset })),
  ];
  const home = await fixtureHome(lines);
  try {
    const dataset = await mineCodexTransitions({ ...RANGE, codexHome: home });
    assert.equal(dataset.summary.resetGroups, 3);
    assert.equal(dataset.summary.transitions, 3);
    assert.deepEqual(dataset.transitions.map((item) => item.slot).sort(), ["primary", "primary", "secondary"]);
    assert.equal(new Set(dataset.transitions.filter((item) => item.slot === "primary").map((item) => item.resetsAt)).size, 2);
  } finally {
    await rm(home, { recursive: true });
  }
});

test("transition miner attaches privacy-safe Standard, Fast, and cleared tier timelines", async () => {
  const lines = [
    ...metadata("gpt-5.6-sol"),
    tierRecord("2026-07-23T00:00:00.500Z", "default"),
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), limits({ primary: 1 })),
    tierRecord("2026-07-23T00:00:01.500Z", "priority"),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(20), usage(10), limits({ primary: 2 })),
    tierRecord("2026-07-23T00:00:02.500Z", null),
    tokenRecord("2026-07-23T00:00:03.000Z", usage(30), usage(10), limits({ primary: 3 })),
  ];
  const home = await fixtureHome(lines);
  try {
    const dataset = await mineCodexTransitions({ ...RANGE, codexHome: home });
    assert.deepEqual(dataset.diagnostics.tierSettingCounts, { standard: 1, fast: 1, unknown: 1 });
    assert.deepEqual(dataset.transitions.map((item) => item.tierUsageEventCounts), [{ fast: 1 }, { unknown: 1 }]);
    assert.equal(stableJson(dataset).includes("fixture-session-private"), false);
  } finally {
    await rm(home, { recursive: true });
  }
});

test("tier attribution follows timestamps and cannot leak a future setting into earlier usage", async () => {
  const lines = [
    ...metadata("gpt-5.6-sol"),
    tierRecord("2026-07-23T00:00:00.500Z", "default"),
    tierRecord("2026-07-23T00:00:03.500Z", "priority"),
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), limits({ primary: 1 })),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(20), usage(10), limits({ primary: 2 })),
    tokenRecord("2026-07-23T00:00:04.000Z", usage(30), usage(10), limits({ primary: 3 })),
  ];
  const home = await fixtureHome(lines);
  try {
    const dataset = await mineCodexTransitions({ ...RANGE, codexHome: home });
    assert.deepEqual(dataset.transitions.map((item) => item.tierUsageEventCounts), [{ standard: 1 }, { fast: 1 }]);
  } finally {
    await rm(home, { recursive: true });
  }
});

test("a byte-identical active/archive duplicate is scanned once and malformed records remain diagnostic", async () => {
  const active = [
    ...metadata(),
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), null),
    '{"type":"event_msg","payload":{"type":"token_count"',
    tokenRecord("2026-07-23T00:00:02.000Z", usage(20), usage(10), limits({ primary: 1 })),
    tokenRecord("2026-07-23T00:00:03.000Z", usage(30), usage(10), limits({ primary: 2 })),
  ];
  const archive = [...active];
  const home = await fixtureHome(active, { archiveLines: archive });
  try {
    const dataset = await mineCodexTransitions({ ...RANGE, codexHome: home });
    assert.equal(dataset.summary.filesScanned, 1);
    assert.equal(dataset.summary.usageEvents, 3);
    assert.equal(dataset.summary.transitions, 1);
    assert.equal(dataset.diagnostics.missingRateLimitRecords, 1);
    assert.equal(dataset.diagnostics.malformedLines, 1);
    assert.equal(stableJson(dataset).includes("fixture-session-private"), false);
  } finally {
    await rm(home, { recursive: true });
  }
});

test("unknown model usage remains explicit and unpriced", async () => {
  const lines = [
    ...metadata("gpt-not-priced"),
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), limits({ primary: 1 })),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(20), usage(10), limits({ primary: 2 })),
  ];
  const home = await fixtureHome(lines);
  try {
    const dataset = await mineCodexTransitions({ ...RANGE, codexHome: home });
    assert.equal(dataset.summary.partiallyPricedEvents, 0);
    assert.equal(dataset.summary.unpricedEvents, 2);
    assert.equal(dataset.transitions[0].modelMix["gpt-not-priced"].events, 1);
    assert.ok(dataset.transitions[0].quality.pricingWarnings.length > 0);
    assert.equal(dataset.transitions[0].marginalApiPricedUsd, 0);
  } finally {
    await rm(home, { recursive: true });
  }
});

test("normalized output is deterministic and owner-only", async () => {
  const lines = [
    ...metadata(),
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), limits({ primary: 1 })),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(20), usage(10), limits({ primary: 2 })),
  ];
  const home = await fixtureHome(lines);
  try {
    const first = await mineCodexTransitions({ ...RANGE, codexHome: home });
    const second = await mineCodexTransitions({ ...RANGE, codexHome: home });
    assert.equal(stableJson(first), stableJson(second));
    const output = join(home, "output", "transitions.json");
    await writeJsonOwnerOnlyAtomic(output, first);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(await readFile(output, "utf8"), stableJson(first));
  } finally {
    await rm(home, { recursive: true });
  }
});
