import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPerformanceHistogram,
  mergePerformanceHistograms,
} from "@app-usagemonitor/telemetry-contract";
import { projectTelemetryPerformanceDay } from "../src/contribution/index.js";
import { createCodexPerformanceTimingParser } from "../src/providers/codex/logs.js";

const DAY = "2026-09-21";
const DAY_START = Date.parse(`${DAY}T00:00:00.000Z`);
const NOW = Date.parse(`${DAY}T12:00:00.000Z`);

function row(overrides = {}) {
  return {
    at: NOW,
    model: "gpt-5.6-sol",
    effort: "high",
    sample_method: "receipt",
    sample_tokens: 100,
    sample_duration: 1_000,
    sample_responses: 1,
    sample_total_responses: 1,
    ttft: 500,
    turn_duration: 1_500,
    speed_mode: "standard",
    speed_mode_source: "rollout_thread_settings",
    api_service_tier: "priority",
    ...overrides,
  };
}

function project(rows, options = {}) {
  return projectTelemetryPerformanceDay(rows, {
    day: DAY,
    provider: "openai_codex",
    now: NOW,
    ...options,
  });
}

function byMethod(records, method) {
  return records.find((record) => record.speedMethod === method);
}

const TIMING_BASE = Date.parse("2026-09-01T12:00:00.000Z");
const TIMING_DAY = "2026-09-01";
const TIMING_KEY = Buffer.alloc(32, 9);

function timingRecord(offset, type, payload) {
  return {
    timestamp: new Date(TIMING_BASE + offset).toISOString(),
    type,
    payload,
  };
}

function timingEvent(offset, type, payload = {}) {
  return timingRecord(offset, "event_msg", {
    type,
    turn_id: "synthetic-turn",
    ...payload,
  });
}

function parserTimingFixture() {
  return [
    timingRecord(0, "session_meta", { id: "synthetic-session" }),
    timingEvent(-1, "thread_settings_applied", {
      thread_settings: { service_tier: "priority" },
    }),
    timingRecord(0, "turn_context", {
      turn_id: "synthetic-turn",
      model: "gpt-6-astra",
      effort: "high",
    }),
    timingEvent(0, "task_started"),
    timingEvent(1_000, "item_completed", {
      thread_id: "synthetic-session",
      item: { type: "Reasoning" },
      started_at_ms: TIMING_BASE,
      completed_at_ms: TIMING_BASE + 1_000,
    }),
    timingRecord(1_000, "token_usage_record", {
      thread_id: "synthetic-session",
      turn_id: "synthetic-turn",
      response_id: "synthetic-response-one",
      usage: { output_tokens: 100, reasoning_output_tokens: 50 },
      turn_token_usage: { output_tokens: 100, reasoning_output_tokens: 50 },
    }),
    timingRecord(201_000, "response_item", {
      type: "function_call_output",
      output: "synthetic tool result",
    }),
    timingEvent(202_000, "item_completed", {
      thread_id: "synthetic-session",
      item: { type: "AgentMessage" },
      started_at_ms: TIMING_BASE + 201_000,
      completed_at_ms: TIMING_BASE + 202_000,
    }),
    timingRecord(202_000, "token_usage_record", {
      thread_id: "synthetic-session",
      turn_id: "synthetic-turn",
      response_id: "synthetic-response-two",
      usage: { output_tokens: 100, reasoning_output_tokens: 50 },
      turn_token_usage: { output_tokens: 200, reasoning_output_tokens: 100 },
    }),
    timingEvent(202_000, "task_complete", {
      duration_ms: 202_000,
      time_to_first_token_ms: 100,
    }),
  ];
}

function parseTimingFixture(rows) {
  const result = [];
  const parser = createCodexPerformanceTimingParser(TIMING_KEY, null, (value) => {
    result.push(value);
  });
  rows.forEach((value, index) => {
    parser.line(Buffer.from(JSON.stringify(value)), index + 1, false);
  });
  return result;
}

test("projects eligible receipt and legacy rows while preserving independent metrics", () => {
  const records = project([
    row(),
    row({
      sample_method: "legacy",
      sample_tokens: 200,
      speed_mode: "fast",
      speed_mode_source: "lineage_inherited",
      api_service_tier: "standard",
    }),
    row({
      sample_method: "receipt",
      sample_duration: null,
      speed_mode: undefined,
      speed_mode_source: undefined,
      api_service_tier: undefined,
      ttft: 0,
      turn_duration: undefined,
    }),
  ]);
  assert.equal(records.length, 3);
  const receipt = byMethod(records, "receipt");
  assert.equal(receipt.turns, 1);
  assert.equal(receipt.speedTurns, 1);
  assert.equal(receipt.timedResponses, 1);
  assert.equal(receipt.speedTokens, 100);
  assert.equal(receipt.speedDurationMs, 1_000);
  assert.equal(receipt.ttftTurns, 1);
  assert.equal(receipt.completionTurns, 1);
  assert.equal(receipt.apiServiceTier, "unknown");
  assert.deepEqual([receipt.speedMode, receipt.speedModeSource], [
    "standard", "rollout_thread_settings",
  ]);

  const legacy = byMethod(records, "legacy");
  assert.equal(legacy.speedTokens, 200);
  assert.deepEqual([legacy.speedMode, legacy.speedModeSource], [
    "fast", "lineage_inherited",
  ]);

  const unavailable = byMethod(records, "unavailable");
  assert.equal(unavailable.speedTurns, 0);
  assert.equal(unavailable.ttftTurns, 1);
  assert.equal(unavailable.ttftHistogram.buckets["0"], 1);
  assert.equal(unavailable.completionTurns, 0);
  assert.deepEqual([unavailable.speedMode, unavailable.speedModeSource], [
    "unknown", "unobserved",
  ]);
  assert.equal(unavailable.apiServiceTier, "unknown");
  assert.deepEqual(unavailable.speedHistogram, buildPerformanceHistogram("speed", []));
});

test("uses one tool-free fallback sample when receipt timing is unavailable", () => {
  const fallback = project([row({
    sample_method: null,
    sample_tokens: null,
    sample_duration: null,
    sample_responses: 0,
    sample_total_responses: 0,
    tool_free_tokens: 120,
    tool_free_duration: 4_000,
  })]);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].speedMethod, "tool_free");
  assert.equal(fallback[0].turns, 1);
  assert.equal(fallback[0].speedTurns, 1);
  assert.equal(fallback[0].timedResponses, 1);
  assert.equal(fallback[0].speedTokens, 120);
  assert.equal(fallback[0].speedDurationMs, 4_000);

  // A row carrying both sources still contributes once: the receipt is the
  // selected sample and the supplemental tool-free evidence is ignored.
  const preferred = project([row({
    tool_free_tokens: 120,
    tool_free_duration: 4_000,
  })]);
  assert.equal(preferred.length, 1);
  assert.equal(preferred[0].speedMethod, "receipt");
  assert.equal(preferred[0].speedTurns, 1);
  assert.equal(preferred[0].speedTokens, 100);
  assert.equal(preferred[0].speedDurationMs, 1_000);

  const directSidecar = project([row({
    sample_method: "tool_free",
    sample_tokens: 120,
    sample_duration: 4_000,
    sample_responses: 1,
    sample_total_responses: 1,
    tool_free_tokens: undefined,
    tool_free_duration: undefined,
  })]);
  assert.equal(directSidecar.length, 1);
  assert.equal(directSidecar[0].speedMethod, "tool_free");
  assert.equal(directSidecar[0].speedTokens, 120);
  assert.equal(directSidecar[0].speedDurationMs, 4_000);
});

test("projects the public Codex parser output, including full-turn tool wait evidence", () => {
  const timingRows = parseTimingFixture(parserTimingFixture());
  assert.equal(timingRows.length, 1);
  const timing = timingRows[0];
  assert.equal(timing.tokens, 200);
  assert.equal(timing.reasoning, 100);
  assert.equal(timing.sample_duration, 2_000);
  assert.equal(timing.turn_duration, 202_000);
  assert.equal(timing.ttft, 100);
  assert.equal(timing.speed_mode, "fast");
  assert.equal(timing.speed_mode_source, "rollout_thread_settings");
  assert.equal(timing.api_service_tier, "unknown");

  const [record] = projectTelemetryPerformanceDay(timingRows, {
    day: TIMING_DAY,
    provider: "openai_codex",
    now: TIMING_BASE + 202_000,
  });
  assert.equal(record.modelId, "gpt-6-astra");
  assert.equal(record.speedMethod, "receipt");
  assert.equal(record.speedMode, "fast");
  assert.equal(record.speedModeSource, "rollout_thread_settings");
  assert.equal(record.apiServiceTier, "unknown");
  assert.equal(record.speedTokens, 200);
  assert.equal(record.speedDurationMs, 2_000);
  assert.equal(record.speedHistogram.min, 10_000);
  assert.equal(record.speedHistogram.max, 10_000);
  assert.equal(record.ttftTurns, 1);
  assert.equal(record.ttftHistogram.min, 100);
  assert.equal(record.ttftHistogram.max, 100);
  assert.equal(record.completionTurns, 1);
  assert.equal(record.completionHistogram.min, 202_000);
  assert.equal(record.completionHistogram.max, 202_000);
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("synthetic-session"), false);
  assert.equal(serialized.includes("synthetic-response"), false);

  const oldRow = { ...timing };
  delete oldRow.turn_duration;
  delete oldRow.speed_mode;
  delete oldRow.speed_mode_source;
  delete oldRow.api_service_tier;
  const [oldRecord] = projectTelemetryPerformanceDay([oldRow], {
    day: TIMING_DAY,
    provider: "openai_codex",
    now: TIMING_BASE + 202_000,
  });
  assert.equal(oldRecord.speedMethod, "receipt");
  assert.equal(oldRecord.speedTokens, 200);
  assert.equal(oldRecord.speedDurationMs, 2_000);
  assert.equal(oldRecord.ttftHistogram.min, 100);
  assert.equal(oldRecord.completionTurns, 0);
  assert.equal(oldRecord.speedMode, "unknown");
  assert.equal(oldRecord.speedModeSource, "unobserved");
  assert.equal(oldRecord.apiServiceTier, "unknown");
});

test("keeps fast, standard, and mixed mode evidence in separate cohorts", () => {
  const records = project([
    row(),
    row({ speed_mode: "fast", speed_mode_source: "lineage_inherited" }),
    row({ speed_mode: "mixed", speed_mode_source: "mixed" }),
    row({ speed_mode: "fast", speed_mode_source: "mixed" }),
    row({ effort: "not-an-effort" }),
  ]);
  assert.deepEqual(records.map((record) => [
    record.reasoningEffort,
    record.speedMode,
    record.speedModeSource,
  ]), [
    ["high", "fast", "lineage_inherited"],
    ["high", "mixed", "mixed"],
    ["high", "standard", "rollout_thread_settings"],
    ["high", "unknown", "unobserved"],
    ["unknown", "standard", "rollout_thread_settings"],
  ]);
});

test("disjoint single-row projections merge to the same fixed histograms", () => {
  const first = row({ sample_tokens: 81, ttft: 0, turn_duration: 2_000 });
  const second = row({ sample_tokens: 95, ttft: 575, turn_duration: 3_000 });
  const combined = project([first, second])[0];
  const left = project([first])[0];
  const right = project([second])[0];
  assert.deepEqual(combined.speedHistogram, mergePerformanceHistograms([
    left.speedHistogram,
    right.speedHistogram,
  ]));
  assert.deepEqual(combined.ttftHistogram, mergePerformanceHistograms([
    left.ttftHistogram,
    right.ttftHistogram,
  ]));
  assert.deepEqual(combined.completionHistogram, mergePerformanceHistograms([
    left.completionHistogram,
    right.completionHistogram,
  ]));
  assert.equal(combined.turns, 2);
  assert.equal(combined.speedTokens, 176);
  assert.equal(combined.speedDurationMs, 2_000);
  assert.equal(combined.ttftTurns, 2);
  assert.equal(combined.completionTurns, 2);
});

test("completion-only rows and measured zero TTFT remain useful without speed", () => {
  const record = project([row({
    sample_method: null,
    sample_tokens: null,
    sample_duration: null,
    sample_responses: null,
    sample_total_responses: null,
    ttft: 0,
    turn_duration: 2_500,
  })])[0];
  assert.equal(record.speedMethod, "unavailable");
  assert.equal(record.speedTurns, 0);
  assert.equal(record.ttftTurns, 1);
  assert.equal(record.completionTurns, 1);
  assert.equal(record.ttftHistogram.min, 0);
  assert.equal(record.ttftHistogram.max, 0);
  assert.equal(record.completionHistogram.min, 2_500);
  assert.equal(record.completionHistogram.max, 2_500);
});

test("filters to the canonical UTC day and the supplied completion cutoff", () => {
  const records = project([
    row({ at: DAY_START - 1 }),
    row({ at: NOW }),
    row({ at: NOW + 1 }),
    row({ at: DAY_START + 86_400_000 }),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].turns, 1);
  assert.equal(records[0].day, DAY);
});

test("normalizes invalid evidence, skips unknown models, and never leaks source fields", () => {
  const records = project([
    row({
      model: "private-model-canary",
      source_offset: 123,
      path: "/Users/private/rollout.jsonl",
      prompt: "private-synthetic-canary",
    }),
    row({
      speed_mode: "fast",
      speed_mode_source: "mixed",
      effort: "future-effort",
      api_service_tier: "private-tier",
      turn_duration: undefined,
    }),
  ]);
  assert.equal(records.length, 1);
  assert.deepEqual([records[0].modelId, records[0].reasoningEffort,
    records[0].speedMode, records[0].speedModeSource,
    records[0].apiServiceTier, records[0].completionTurns], [
    "gpt-5.6-sol", "unknown", "unknown", "unobserved", "unknown", 0,
  ]);
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes("private-model-canary"), false);
  assert.equal(serialized.includes("/Users/private"), false);
  assert.equal(serialized.includes("source_offset"), false);
  assert.equal(serialized.includes("private-synthetic-canary"), false);
});

test("rejects unsafe options, accessors, row bounds, and checked sum overflow", () => {
  assert.throws(() => project([], { now: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => project([], { now: DAY_START - 1 }));
  assert.throws(() => project([], { day: "2026-02-29" }));
  assert.throws(() => project([], { provider: "private-provider" }));
  assert.throws(() => project(new Array(100_001).fill(row())));

  let invoked = false;
  const accessor = row();
  Object.defineProperty(accessor, "at", {
    enumerable: true,
    get() {
      invoked = true;
      return NOW;
    },
  });
  assert.throws(() => project([accessor]));
  assert.equal(invoked, false);

  const maximum = Number.MAX_SAFE_INTEGER;
  assert.throws(() => project([
    row({ sample_tokens: maximum, sample_duration: maximum }),
    row({ sample_tokens: maximum, sample_duration: maximum }),
  ]));
});

test("returns deterministic cohort ordering independent of row order", () => {
  const rows = [
    row({ model: "gpt-5.6-terra", effort: "low", speed_mode: "fast", speed_mode_source: "rollout_thread_settings" }),
    row({ model: "gpt-5.6-sol", effort: "high" }),
    row({ model: "gpt-5.6-sol", effort: "high", speed_mode: "mixed", speed_mode_source: "mixed" }),
  ];
  const forward = project(rows);
  const reverse = project([...rows].reverse());
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.map((record) => [record.modelId, record.reasoningEffort,
    record.speedMode]), [
    ["gpt-5.6-sol", "high", "mixed"],
    ["gpt-5.6-sol", "high", "standard"],
    ["gpt-5.6-terra", "low", "fast"],
  ]);
});
