import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { populateCheckpointedCodexSources } from "../src/codex-export-checkpoint-scan.js";
import { createLocalExportWorkspace } from "../src/export-set-controller.js";
import { exportCompatibilityTuple } from "../src/export-contract.js";
import { deriveParticipantId } from "../src/export-identity.js";
import { createExportResourceGuard } from "../src/export-resource-policy.js";
import { scanCodexSafeRecords, summarizeActivityMarkerPlan } from "../src/export-safe-records.js";
import { createCodexExportSourcePlan } from "../src/export-source-plan.js";
import { buildExportWorkspaceDescriptor, createExportWorkspace } from "../src/export-workspace.js";
import { stableJson } from "../src/storage.js";

const SECRET = Buffer.alloc(32, 81);
const START_AT = "2026-07-24T11:55:00.000Z";
const END_AT = "2026-07-24T12:10:00.000Z";
const PRIVATE_CHECKPOINT_CANARIES = Object.freeze([
  "PRIVATE_PARENT", "PRIVATE_CHILD", "PRIVATE_PARENT_TASK", "PRIVATE_TOOL_1", "PRIVATE_TOOL_2",
  "ordinary private-looking text without a scanner needle", "await tools.spawn_agent({})",
]);

function usage({ input, cached = 0, cacheWrite = 0, output = 0, reasoning = 0, total }) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total ?? input + output,
  };
}

function tokenCount(timestamp, total, last, usedPercent, explicitModel = undefined) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      ...(explicitModel === undefined ? {} : { model: explicitModel }),
      info: { total_token_usage: total, last_token_usage: last },
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 1784912400 },
        secondary: { used_percent: usedPercent / 2, window_minutes: 10080, resets_at: 1785430800 },
      },
    },
  });
}

async function fixture({ replayTool = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-checkpoint-equivalence-"));
  const home = join(root, "codex-home");
  const sessions = join(home, "sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });

  // Tier records are deliberately not in timestamp order.  The first usage
  // must nevertheless resolve to fast/priority and the second to standard.
  const parent = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_PARENT" } }),
    "",
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.010Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:02:00.000Z", type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "standard" } } }),
    JSON.stringify({ timestamp: "2026-07-24T12:01:00.000Z", type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } } }),
    JSON.stringify({ timestamp: "2026-07-24T12:01:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "PRIVATE_PARENT_TASK" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:01:10.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "PRIVATE_TOOL_1" } }),
    tokenCount("2026-07-24T12:01:30.000Z", usage({ input: 100, cached: 40, output: 20, reasoning: 8, total: 120 }), usage({ input: 100, cached: 40, output: 20, reasoning: 8, total: 120 }), 11.2),
    // A malformed non-accounting record remains a safe diagnostic. Malformed
    // accounting records are covered separately and poison the export.
    '{"timestamp":"2026-07-24T12:01:40.000Z","type":"response_item","payload":{"type":"function_call"',
    "ordinary private-looking text without a scanner needle",
    JSON.stringify({ timestamp: "2026-07-24T12:02:10.000Z", type: "response_item", payload: { type: "shell_call", call_id: "PRIVATE_TOOL_2" } }),
    tokenCount("2026-07-24T12:02:30.000Z", usage({ input: 160, cached: 60, output: 35, reasoning: 11, total: 195 }), usage({ input: 60, cached: 20, output: 15, reasoning: 3, total: 75 }), 14.6, 42),
    // Missing component fields exercise the component-presence contract.
    tokenCount("2026-07-24T12:03:00.000Z", { input_tokens: 190, total_tokens: 225 }, { input_tokens: 30, total_tokens: 30 }, 16.4),
    JSON.stringify({ timestamp: "2026-07-24T12:03:01.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "PRIVATE_PARENT_TASK" } }),
  ];
  const child = [
    JSON.stringify({ timestamp: "2026-07-24T12:03:10.000Z", type: "session_meta", payload: { id: "PRIVATE_CHILD", forked_from_id: "PRIVATE_PARENT" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:03:10.010Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    // Exact replay of the parent's final cumulative snapshot.
    tokenCount("2026-07-24T12:03:11.000Z", { input_tokens: 190, total_tokens: 225 }, { input_tokens: 30, total_tokens: 30 }, 16.4),
    ...(replayTool ? [
      JSON.stringify({ timestamp: "2026-07-24T12:02:10.000Z", type: "response_item", payload: { type: "shell_call", call_id: "PRIVATE_TOOL_2" } }),
    ] : []),
    JSON.stringify({ timestamp: "2026-07-24T12:03:20.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "await tools.spawn_agent({})" } }),
    tokenCount("2026-07-24T12:04:00.000Z", { input_tokens: 240, total_tokens: 280 }, { input_tokens: 50, total_tokens: 55 }, 19.8),
  ];
  await writeFile(join(sessions, "rollout-2026-07-24T12-00-00-parent.jsonl"), `${parent.join("\n")}\n`);
  await writeFile(join(sessions, "rollout-2026-07-24T12-03-10-child.jsonl"), `${child.join("\n")}\n`);
  return { root, home };
}

function canonicalEnvelopes(envelopes) {
  return envelopes
    .map((item) => ({ recordType: item.recordType, record: item.record }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

async function legacyResult(home) {
  const records = [];
  const result = await scanCodexSafeRecords({
    startAt: START_AT,
    endAt: END_AT,
    codexHome: home,
    secret: SECRET,
    onRecord(envelope) {
      records.push(envelope);
    },
  });
  return { records: canonicalEnvelopes(records), diagnostics: result.diagnostics.codes };
}

function workspaceEnvelopes(workspace) {
  const recordTypeForFamily = {
    usageEvents: "usageEvent",
    quotaSnapshots: "quotaSnapshot",
    activityMarkers: "activityMarker",
  };
  return canonicalEnvelopes([...workspace.iterateRecords()].map((item) => ({
    recordType: recordTypeForFamily[item.family],
    record: item.record,
  })));
}

async function checkpointResult({ root, home, label, maximumLinesPerBatch, interruptAfterBatch = null }) {
  const plan = await createCodexExportSourcePlan({ codexHome: home, startAt: START_AT, endAt: END_AT });
  const descriptor = buildExportWorkspaceDescriptor({
    participantId: deriveParticipantId(SECRET),
    createdAt: "2026-07-24T12:10:00.000Z",
    coveredAt: { startAt: START_AT, endAt: END_AT },
    compatibility: exportCompatibilityTuple(),
    sourcePlan: plan,
    activityPlan: summarizeActivityMarkerPlan(SECRET, [], { startAt: START_AT, endAt: END_AT }),
  });
  const workspace = await createExportWorkspace({
    directory: join(root, `workspace-${label}`),
    descriptor,
    sourcePlan: plan,
  });
  try {
    const run = async (failpoint = async () => {}) => populateCheckpointedCodexSources({
      workspace,
      sourcePlan: plan,
      secret: SECRET,
      resourceGuard: createExportResourceGuard({ scope: "export_set" }),
      maximumLinesPerBatch,
      failpoint,
    });
    if (interruptAfterBatch !== null) {
      let committedBatches = 0;
      await assert.rejects(run(async (stage) => {
        if (stage === "after_source_checkpoint_batch" && ++committedBatches === interruptAfterBatch) {
          throw new Error(`interrupted-after-checkpoint-${interruptAfterBatch}`);
        }
      }), new RegExp(`interrupted-after-checkpoint-${interruptAfterBatch}`));
    }
    await run();
    workspace.finalizeScan();
    const databaseBytes = await readFile(workspace.databaseFile);
    return {
      records: workspaceEnvelopes(workspace),
      diagnostics: workspace.scanDiagnostics().codes,
      privateCanariesPresent: PRIVATE_CHECKPOINT_CANARIES
        .filter((canary) => databaseBytes.includes(Buffer.from(canary))),
    };
  } finally {
    workspace.close();
  }
}

test("checkpoint scanner has byte-for-byte logical parity with the legacy scanner across batches and resumes", async () => {
  const value = await fixture();
  try {
    const legacy = await legacyResult(value.home);
    const usageEvents = legacy.records.filter((item) => item.recordType === "usageEvent");
    const quotaSnapshots = legacy.records.filter((item) => item.recordType === "quotaSnapshot");
    assert.equal(usageEvents.length, 4, "parent deltas plus one non-replayed child delta");
    assert.equal(quotaSnapshots.length, 8, "two slots for each non-replayed token snapshot");
    assert.deepEqual(legacy.diagnostics, [
      { code: "fork_replay_events_skipped", count: 1 },
      { code: "malformed_lines", count: 1 },
    ]);
    assert.deepEqual(usageEvents.map((item) => item.record.speedMode).sort(), [
      "fast", "standard", "standard", "unknown",
    ]);
    assert.equal(usageEvents.some((item) => item.record.toolClassCounts.localShell === 1), true);
    assert.equal(usageEvents.some((item) => item.record.toolClassCounts.hostedShell === 1), true);
    assert.equal(usageEvents.some((item) => item.record.toolClassCounts.subagent === 1), true);
    assert.equal(usageEvents.some((item) => item.record.modelRecognition === "missing"), true);
    // Batch size one is the most adversarial line-boundary path.  Separate
    // runs simulate process interruption after tier and record checkpoints.
    const uninterrupted = await checkpointResult({
      ...value,
      label: "uninterrupted",
      maximumLinesPerBatch: 1,
    });
    assert.deepEqual(uninterrupted.records, legacy.records);
    assert.deepEqual(uninterrupted.diagnostics, legacy.diagnostics);
    assert.deepEqual(uninterrupted.privateCanariesPresent, []);

    for (const interruptAfterBatch of [1, 3, 9, 17]) {
      const resumed = await checkpointResult({
        ...value,
        label: `resume-${interruptAfterBatch}`,
        maximumLinesPerBatch: 2,
        interruptAfterBatch,
      });
      assert.deepEqual(resumed.records, legacy.records, `records after checkpoint ${interruptAfterBatch}`);
      assert.deepEqual(resumed.diagnostics, legacy.diagnostics, `diagnostics after checkpoint ${interruptAfterBatch}`);
      assert.deepEqual(resumed.privateCanariesPresent, [], `privacy canaries after checkpoint ${interruptAfterBatch}`);
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("checkpoint lineage excludes copied parent tool calls from child usage", async () => {
  const value = await fixture({ replayTool: true });
  try {
    const result = await checkpointResult({
      ...value,
      label: "tool-replay",
      maximumLinesPerBatch: 2,
    });
    const usageEvents = result.records.filter((item) => item.recordType === "usageEvent");
    assert.equal(usageEvents.reduce((sum, item) => sum + item.record.toolClassCounts.hostedShell, 0), 1);
    assert.equal(result.diagnostics.some((item) => item.code === "replayed_tool_calls_skipped" && item.count === 1), true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("checkpoint counter re-anchors survive one-line batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-checkpoint-reanchor-"));
  const home = join(root, "codex-home");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_REANCHOR" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.010Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    tokenCount("2026-07-24T12:01:00.000Z", usage({ input: 100, total: 100 }), usage({ input: 100, total: 100 }), 1),
    tokenCount("2026-07-24T12:02:00.000Z", usage({ input: 1_000, total: 1_000 }), usage({ input: 100, total: 100 }), 2),
    tokenCount("2026-07-24T12:03:00.000Z", usage({ input: 50, total: 50 }), usage({ input: 50, total: 50 }), 3),
    tokenCount("2026-07-24T12:04:00.000Z", usage({ input: 100, total: 100 }), usage({ input: 50, total: 50 }), 4),
  ];
  await writeFile(
    join(home, "sessions", "rollout-2026-07-24T12-00-00-reanchor.jsonl"),
    `${lines.join("\n")}\n`,
  );
  try {
    const legacy = await legacyResult(home);
    const checkpoint = await checkpointResult({
      root,
      home,
      label: "reanchor",
      maximumLinesPerBatch: 1,
    });
    assert.equal(legacy.records.filter((item) => item.recordType === "usageEvent").length, 4);
    assert.deepEqual(checkpoint.records, legacy.records);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint scanner streams oversized message text containing tool-like prose", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-checkpoint-oversized-prose-"));
  const home = join(root, "codex-home");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_OVERSIZED" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.010Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    JSON.stringify({
      timestamp: "2026-07-24T12:00:30.000Z",
      type: "event_msg",
      payload: {
        type: "other",
        unrelatedKind: "function_call",
        content: `${"x".repeat(2_000)} tool_call and literal \"type\":\"function_call\" prose`,
      },
    }),
    tokenCount(
      "2026-07-24T12:01:00.000Z",
      usage({ input: 10, output: 2, total: 12 }),
      usage({ input: 10, output: 2, total: 12 }),
      1,
    ),
  ];
  await writeFile(
    join(home, "sessions", "rollout-2026-07-24T12-00-00-oversized-prose.jsonl"),
    `${lines.join("\n")}\n`,
  );
  try {
    const result = await createLocalExportWorkspace({
      directory: join(root, "workspace"),
      startAt: START_AT,
      endAt: END_AT,
      createdAt: "2026-07-24T12:10:00.000Z",
      codexHome: home,
      secret: SECRET,
      resourceLimits: { maximumLineBytes: 1_000 },
    });
    assert.deepEqual(result.status.recordCounts, {
      usageEvents: 1,
      quotaSnapshots: 2,
      activityMarkers: 0,
    });
    assert.equal(result.resourceUsage.counters.oversizedIrrelevantLines, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dense token lines flush at the 1,000-record transaction boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-checkpoint-dense-"));
  const home = join(root, "codex-home");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_DENSE" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
  ];
  for (let index = 1; index <= 334; index += 1) {
    lines.push(tokenCount(
      `2026-07-24T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      usage({ input: index, output: index, total: 2 * index }),
      usage({ input: 1, output: 1, total: 2 }),
      index / 10,
    ));
  }
  await writeFile(join(home, "sessions", "rollout-2026-07-24T12-00-00-dense.jsonl"), `${lines.join("\n")}\n`);
  try {
    const result = await createLocalExportWorkspace({
      directory: join(root, "workspace"),
      codexHome: home,
      secret: SECRET,
      startAt: START_AT,
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
    });
    assert.deepEqual(result.status.recordCounts, {
      usageEvents: 334,
      quotaSnapshots: 668,
      activityMarkers: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
