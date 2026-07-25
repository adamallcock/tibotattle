import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = Buffer.alloc(32, 89);
const EVENT_COUNT = 3_000;
const OPEN_TASK_COUNT = 20_000;
const FORK_SNAPSHOT_COUNT = 10_000;
const PRIVATE_CANARY = "BOUNDED_HEAP_PRIVATE_ARGUMENT_DO_NOT_EXPORT";
const START_AT = "2026-07-24T11:00:00.000Z";
const END_AT = "2026-07-24T13:00:00.000Z";
const CREATED_AT = "2026-07-24T13:00:00.000Z";
const CONTROLLER_MODULE = new URL("../src/export-set-controller.js", import.meta.url).href;
const WORKSPACE_MODULE = new URL("../src/export-workspace.js", import.meta.url).href;

const HEAP_WORKER = String.raw`
const { createLocalExportWorkspace } = await import(process.env.HEAP_CONTROLLER_MODULE);
const { openExportWorkspace } = await import(process.env.HEAP_WORKSPACE_MODULE);
const secret = Buffer.from(process.env.HEAP_SECRET_HEX, "hex");
const options = {
  directory: process.env.HEAP_WORKSPACE_DIRECTORY,
  codexHome: process.env.HEAP_CODEX_HOME,
  secret,
  startAt: process.env.HEAP_START_AT,
  endAt: process.env.HEAP_END_AT,
  createdAt: process.env.HEAP_CREATED_AT,
};
if (process.env.HEAP_CHECKPOINT_LINES_PER_BATCH) {
  options.checkpointLinesPerBatch = Number(process.env.HEAP_CHECKPOINT_LINES_PER_BATCH);
}
const result = await createLocalExportWorkspace(options);
const workspace = await openExportWorkspace({ directory: process.env.HEAP_WORKSPACE_DIRECTORY });
let usageRecords = 0;
let localShellTools = 0;
try {
  for (const row of workspace.iterateRecords()) {
    if (row.family !== "usageEvents") continue;
    usageRecords += 1;
    localShellTools += row.record.toolClassCounts.localShell;
  }
  const sourcePlan = workspace.loadSourcePlan();
  const openTasks = sourcePlan.sources.reduce(
    (sum, source) => sum + workspace.sourceOpenTaskKeys(source.sourceKey).length,
    0,
  );
  process.stdout.write(JSON.stringify({
    scanComplete: result.status.scanComplete,
    recordCounts: result.status.recordCounts,
    sourceFiles: sourcePlan.sources.length,
    openTasks,
    usageRecords,
    localShellTools,
    diagnostics: workspace.diagnostics(),
    lines: workspace.resourceUsage().lines,
  }) + "\n");
} finally {
  workspace.close();
}
`;

function cumulativeUsage(total) {
  return {
    input_tokens: total,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: total,
    reasoning_output_tokens: 0,
    total_tokens: total * 2,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-checkpoint-heap-"));
  const home = join(root, "codex-home");
  const sessions = join(home, "sessions");
  const source = join(sessions, "rollout-2026-07-24T12-00-00-bounded-heap.jsonl");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_HEAP_SESSION" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
  ];
  for (let index = 1; index <= EVENT_COUNT; index += 1) {
    const base = Date.parse("2026-07-24T12:01:00.000Z") + (index * 10);
    const turnId = `PRIVATE_TASK_${index}`;
    lines.push(
      JSON.stringify({
        timestamp: new Date(base).toISOString(),
        type: "event_msg",
        payload: { type: "task_started", turn_id: turnId },
      }),
      JSON.stringify({
        timestamp: new Date(base + 1).toISOString(),
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: `PRIVATE_TOOL_${index}`,
          arguments: PRIVATE_CANARY,
        },
      }),
      JSON.stringify({
        timestamp: new Date(base + 2).toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: cumulativeUsage(index),
            last_token_usage: cumulativeUsage(1),
            prompt: PRIVATE_CANARY,
          },
          rate_limits: null,
        },
      }),
      JSON.stringify({
        timestamp: new Date(base + 3).toISOString(),
        type: "event_msg",
        payload: { type: "task_complete", turn_id: turnId },
      }),
    );
  }
  await writeFile(source, `${lines.join("\n")}\n`, { mode: 0o600 });
  return { root, home, source, workspace: join(root, "workspace") };
}

async function openTaskFixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-checkpoint-open-tasks-"));
  const home = join(root, "codex-home");
  const sessions = join(home, "sessions");
  const source = join(sessions, "rollout-2026-07-24T12-00-00-open-tasks.jsonl");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_OPEN_TASK_SESSION" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
  ];
  const base = Date.parse("2026-07-24T12:01:00.000Z");
  for (let index = 1; index <= OPEN_TASK_COUNT; index += 1) {
    lines.push(JSON.stringify({
      timestamp: new Date(base + index).toISOString(),
      type: "event_msg",
      payload: { type: "task_started", turn_id: `PRIVATE_OPEN_TASK_${index}` },
    }));
  }
  await writeFile(source, `${lines.join("\n")}\n`, { mode: 0o600 });
  return { root, home, source, workspace: join(root, "workspace") };
}

function tokenCountLine(timestamp, total) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: cumulativeUsage(total),
        last_token_usage: cumulativeUsage(1),
      },
      rate_limits: null,
    },
  });
}

async function forkSnapshotFixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-checkpoint-fork-snapshots-"));
  const home = join(root, "codex-home");
  const sessions = join(home, "sessions");
  const parentSource = join(sessions, "rollout-2026-07-24T12-00-00-snapshot-parent.jsonl");
  const childSource = join(sessions, "rollout-2026-07-24T12-30-00-snapshot-child.jsonl");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const parentSnapshots = [];
  const base = Date.parse("2026-07-24T12:01:00.000Z");
  for (let index = 1; index <= FORK_SNAPSHOT_COUNT; index += 1) {
    parentSnapshots.push(tokenCountLine(new Date(base + index).toISOString(), index));
  }
  const parent = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_SNAPSHOT_PARENT" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    ...parentSnapshots,
  ];
  const child = [
    JSON.stringify({
      timestamp: "2026-07-24T12:30:00.000Z",
      type: "session_meta",
      payload: { id: "PRIVATE_SNAPSHOT_CHILD", forked_from_id: "PRIVATE_SNAPSHOT_PARENT" },
    }),
    JSON.stringify({ timestamp: "2026-07-24T12:30:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    ...parentSnapshots,
  ];
  await writeFile(parentSource, `${parent.join("\n")}\n`, { mode: 0o600 });
  await writeFile(childSource, `${child.join("\n")}\n`, { mode: 0o600 });
  return { root, home, source: parentSource, workspace: join(root, "workspace") };
}

function runHeapWorker(value, { checkpointLinesPerBatch } = {}) {
  const child = spawnSync(process.execPath, [
    "--max-old-space-size=64",
    "--input-type=module",
    "--eval",
    HEAP_WORKER,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 45_000,
    env: {
      ...process.env,
      HEAP_CONTROLLER_MODULE: CONTROLLER_MODULE,
      HEAP_WORKSPACE_MODULE: WORKSPACE_MODULE,
      HEAP_WORKSPACE_DIRECTORY: value.workspace,
      HEAP_CODEX_HOME: value.home,
      HEAP_SECRET_HEX: SECRET.toString("hex"),
      HEAP_START_AT: START_AT,
      HEAP_END_AT: END_AT,
      HEAP_CREATED_AT: CREATED_AT,
      ...(checkpointLinesPerBatch === undefined
        ? {}
        : { HEAP_CHECKPOINT_LINES_PER_BATCH: String(checkpointLinesPerBatch) }),
    },
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  for (const output of [child.stdout, child.stderr]) {
    assert.equal(output.includes(PRIVATE_CANARY), false);
    assert.equal(output.includes(value.root), false);
    assert.equal(output.includes(value.source), false);
  }
  return JSON.parse(child.stdout);
}

test("checkpoint scanner completes a task/tool-heavy export under a constrained old-space heap", { timeout: 60_000 }, async () => {
  const value = await fixture();
  try {
    assert.deepEqual(runHeapWorker(value, { checkpointLinesPerBatch: 256 }), {
      scanComplete: true,
      recordCounts: { usageEvents: EVENT_COUNT, quotaSnapshots: 0, activityMarkers: 0 },
      sourceFiles: 1,
      openTasks: 0,
      usageRecords: EVENT_COUNT,
      localShellTools: EVENT_COUNT,
      diagnostics: [{ code: "missing_rate_limit_records", count: EVENT_COUNT }],
      // The tier and record passes read the whole source; lineage discovery
      // stops after its first session_meta line.
      lines: ((2 + (EVENT_COUNT * 4)) * 2) + 1,
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("checkpoint scanner bounds a default-batch export with many simultaneously open tasks", { timeout: 60_000 }, async () => {
  const value = await openTaskFixture();
  try {
    assert.deepEqual(runHeapWorker(value), {
      scanComplete: true,
      recordCounts: { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 },
      sourceFiles: 1,
      openTasks: OPEN_TASK_COUNT,
      usageRecords: 0,
      localShellTools: 0,
      diagnostics: [],
      lines: ((2 + OPEN_TASK_COUNT) * 2) + 1,
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("checkpoint scanner bounds default-batch inherited snapshot lookups at a second scale", { timeout: 60_000 }, async () => {
  const value = await forkSnapshotFixture();
  try {
    assert.deepEqual(runHeapWorker(value), {
      scanComplete: true,
      recordCounts: { usageEvents: FORK_SNAPSHOT_COUNT, quotaSnapshots: 0, activityMarkers: 0 },
      sourceFiles: 2,
      openTasks: 0,
      usageRecords: FORK_SNAPSHOT_COUNT,
      localShellTools: 0,
      diagnostics: [
        { code: "fork_replay_events_skipped", count: FORK_SNAPSHOT_COUNT },
        { code: "missing_rate_limit_records", count: FORK_SNAPSHOT_COUNT },
      ],
      lines: (((2 + FORK_SNAPSHOT_COUNT) * 2) * 2) + 2,
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
