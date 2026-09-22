import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModelPerformanceController } from "./model-performance-controller.js";

const BASE = Date.parse("2026-09-01T12:00:00.000Z");
const DAY = "2026-09-01";
const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function record(offset, type, payload) {
  return {
    timestamp: new Date(BASE + offset).toISOString(),
    type,
    payload,
  };
}

function event(offset, type, turnId, payload = {}) {
  return record(offset, "event_msg", { type, turn_id: turnId, ...payload });
}

function setting(offset, turnId, serviceTier) {
  return event(offset, "thread_settings_applied", turnId, {
    thread_settings: { service_tier: serviceTier },
  });
}

function usage(offset, sessionId, turnId, responseId, outputTokens, totalTokens) {
  return record(offset, "token_usage_record", {
    thread_id: sessionId,
    turn_id: turnId,
    response_id: responseId,
    usage: { output_tokens: outputTokens, reasoning_output_tokens: outputTokens / 2 },
    turn_token_usage: { output_tokens: totalTokens, reasoning_output_tokens: totalTokens / 2 },
  });
}

function completeTurn({ sessionId, turnId, start, serviceTier }) {
  return [
    setting(start - 1, turnId, serviceTier),
    record(start, "turn_context", { turn_id: turnId, model: "gpt-6-astra", effort: "high" }),
    event(start, "task_started", turnId),
    event(start + 1_000, "item_completed", turnId, {
      thread_id: sessionId,
      item: { type: "Reasoning" },
      started_at_ms: BASE + start,
      completed_at_ms: BASE + start + 1_000,
    }),
    usage(start + 1_000, sessionId, turnId, `${turnId}-response-one`, 100, 100),
    record(start + 201_000, "response_item", {
      type: "function_call_output",
      output: "synthetic tool result",
    }),
    event(start + 202_000, "item_completed", turnId, {
      thread_id: sessionId,
      item: { type: "AgentMessage" },
      started_at_ms: BASE + start + 201_000,
      completed_at_ms: BASE + start + 202_000,
    }),
    usage(start + 202_000, sessionId, turnId, `${turnId}-response-two`, 100, 200),
    event(start + 202_000, "task_complete", turnId, {
      duration_ms: 202_000,
      time_to_first_token_ms: 100,
    }),
  ];
}

function incompleteTurn({ sessionId, turnId, start, serviceTier }) {
  return completeTurn({ sessionId, turnId, start, serviceTier }).slice(0, -1);
}

function lines(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function totalTurns(snapshot) {
  return snapshot.models.reduce((sum, model) => sum + model.turns, 0);
}

async function waitForReady(controller, expectedTurns) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snapshots = await Promise.all(["standard", "fast"].map(speedMode => controller.read("all", { speedMode })));
    if (snapshots.every(snapshot => snapshot.status === "ready" && !snapshot.collecting && !snapshot.stale)
        && snapshots.reduce((sum, snapshot) => sum + totalTurns(snapshot), 0) === expectedTurns) return snapshots;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`performance worker did not publish ${expectedTurns} turns`);
}

async function readPreparedReport(options, expectedTurns) {
  const controller = createModelPerformanceController(options);
  try {
    await waitForReady(controller, expectedTurns);
    return await controller.preparePerformanceDay({ day: DAY, nowEpoch: NOW });
  } finally {
    await controller.close();
  }
}

function recordFor(report, speedMode) {
  const match = report.records.find((record) => record.speedMode === speedMode);
  assert.ok(match, `report has a ${speedMode} cohort`);
  return match;
}

test("real performance worker advances report provenance through append and late correction", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "model-performance-telemetry-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex");
  const sessions = join(codexHome, "sessions");
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const sourceA = join(sessions, "session-a.jsonl");
  const sourceB = join(sessions, "session-b.jsonl");
  const options = { directory: join(root, "timing"), codexHome, idleMs: 60_000 };

  // Source A has one complete Fast turn and one incomplete Standard turn.
  // The incomplete turn stays out of the first report but leaves a real
  // parser checkpoint for the later exhausted-source correction.
  const correction = completeTurn({
    sessionId: "synthetic-session-a",
    turnId: "synthetic-correction",
    start: 400_000,
    serviceTier: "standard",
  });
  await writeFile(sourceA, lines([
    record(0, "session_meta", { id: "synthetic-session-a" }),
    ...completeTurn({
      sessionId: "synthetic-session-a",
      turnId: "synthetic-fast",
      start: 0,
      serviceTier: "priority",
    }),
    ...incompleteTurn({
      sessionId: "synthetic-session-a",
      turnId: "synthetic-correction",
      start: 400_000,
      serviceTier: "standard",
    }),
  ]), { mode: 0o600 });

  const initial = await readPreparedReport(options, 1);
  // The production worker retains one source fact for each primary and
  // independently checkpointed tool-free store.
  assert.equal(initial.sourceRevision, 2);
  assert.match(initial.sourceDigest, /^[a-f0-9]{64}$/u);
  assert.equal(initial.records.length, 1);
  const initialFast = recordFor(initial, "fast");
  assert.equal(initialFast.speedMethod, "receipt");
  assert.equal(initialFast.turns, 1);
  assert.equal(initialFast.speedHistogram.sampleCount, 1);
  assert.equal(initialFast.ttftHistogram.sampleCount, 1);
  assert.equal(initialFast.completionHistogram.sampleCount, 1);
  assert.doesNotMatch(JSON.stringify(initial), /synthetic-session|synthetic-correction/u);

  // A newly discovered source is a normal append: its source telemetry
  // counter contributes one new unit while the existing source remains stable.
  await writeFile(sourceB, lines([
    record(0, "session_meta", { id: "synthetic-session-b" }),
    ...completeTurn({
      sessionId: "synthetic-session-b",
      turnId: "synthetic-standard",
      start: 700_000,
      serviceTier: "standard",
    }),
  ]), { mode: 0o600 });
  const appended = await readPreparedReport(options, 2);
  assert.equal(appended.sourceRevision, 4);
  assert.notEqual(appended.sourceDigest, initial.sourceDigest);
  assert.notEqual(appended.reportRevision, initial.reportRevision);
  assert.equal(appended.records.length, 2);
  assert.equal(recordFor(appended, "fast").speedHistogram.sampleCount, 1);
  const appendedStandard = recordFor(appended, "standard");
  assert.equal(appendedStandard.turns, 1);
  assert.equal(appendedStandard.speedHistogram.sampleCount, 1);
  assert.equal(appendedStandard.completionHistogram.sampleCount, 1);

  // The source was exhausted after the previous scan. Appending its delayed
  // completion forces a replay, replaces the incomplete checkpointed turn,
  // and advances both source facts and aggregate histograms.
  await appendFile(sourceA, JSON.stringify(correction.at(-1)) + "\n");
  const corrected = await readPreparedReport(options, 3);
  assert.equal(corrected.sourceRevision, 6);
  assert.notEqual(corrected.sourceDigest, appended.sourceDigest);
  assert.notEqual(corrected.reportRevision, appended.reportRevision);
  assert.equal(corrected.records.length, 2);
  assert.equal(recordFor(corrected, "fast").completionHistogram.sampleCount, 1);
  const correctedStandard = recordFor(corrected, "standard");
  assert.equal(correctedStandard.turns, 2);
  assert.equal(correctedStandard.speedHistogram.sampleCount, 2);
  assert.equal(correctedStandard.ttftHistogram.sampleCount, 2);
  assert.equal(correctedStandard.completionHistogram.sampleCount, 2);
});
