import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localExportSourcePipeline, localExportWorkspace } from
  "../src/local-node-runtime.js";
import { stableJson } from "../src/storage.js";

const { createLocalExportWorkspace, inspectLocalExportWorkspace } =
  localExportSourcePipeline.controller;
const { openExportWorkspace } = localExportWorkspace;

const SECRET = Buffer.alloc(32, 83);
const START_AT = "2026-07-24T11:00:00.000Z";
const END_AT = "2026-07-24T13:00:00.000Z";
const CREATED_AT = "2026-07-24T13:00:00.000Z";
const PRIVATE_CANARY = "PROCESS_DEATH_PRIVATE_PROMPT_DO_NOT_EXPORT";
const WORKER = new URL("../scripts/test-fixtures/checkpoint-crash-worker.js", import.meta.url);

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

function runWorker(environment) {
  return spawnSync(process.execPath, [WORKER.pathname], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function killAfterCommittedAcknowledgement(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER.pathname], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let acknowledged = false;
    let sigkillSupported = true;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`checkpoint worker acknowledgement timed out: ${stderr}`));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (acknowledged || !stdout.includes("checkpoint_committed\n")) return;
      acknowledged = true;
      if (!child.kill("SIGKILL")) {
        sigkillSupported = false;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, acknowledged, sigkillSupported });
    });
  });
}

function stableResourceTotals(value) {
  return {
    policyVersion: value.policyVersion,
    sourceFiles: value.sourceFiles,
    sourceBytes: value.sourceBytes,
    lines: value.lines,
    oversizedIrrelevantLines: value.oversizedIrrelevantLines,
    outputRecords: value.outputRecords,
    expandedRecordBytes: value.expandedRecordBytes,
  };
}

async function logicalWorkspaceSnapshot(directory) {
  const workspace = await openExportWorkspace({ directory });
  try {
    return {
      records: [...workspace.iterateRecords()].map((row) => ({
        family: row.family,
        recordId: row.recordId,
        recordTime: row.recordTime,
        recordJson: row.recordJson,
      })),
      diagnostics: workspace.diagnostics(),
      resourceUsage: workspace.resourceUsage(),
    };
  } finally {
    workspace.close();
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-checkpoint-death-"));
  const home = join(root, "codex-home");
  const source = join(home, "sessions", "rollout-2026-07-24T12-00-00-process-death.jsonl");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_SESSION" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol", prompt: PRIVATE_CANARY } }),
  ];
  // This crosses three 256-physical-line batches in both the tier and record passes.
  for (let index = 1; index <= 770; index += 1) {
    const timestamp = new Date(Date.parse("2026-07-24T12:01:00.000Z") + (index * 50)).toISOString();
    const total = cumulativeUsage(index);
    lines.push(JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: total,
          last_token_usage: cumulativeUsage(1),
          prompt: PRIVATE_CANARY,
        },
        rate_limits: null,
      },
    }));
  }
  await writeFile(source, `${lines.join("\n")}\n`, { mode: 0o600 });
  return {
    root,
    home,
    source,
    crashedWorkspace: join(root, "workspace-crashed"),
    controlWorkspace: join(root, "workspace-control"),
    crashMarker: join(root, "checkpoint-crash-once"),
  };
}

test("a parent SIGKILL after a committed source batch recovers exactly once without content leakage", { timeout: 60_000 }, async (t) => {
  const value = await fixture();
  try {
    const workerEnvironment = {
      CHECKPOINT_WORKSPACE_DIRECTORY: value.crashedWorkspace,
      CHECKPOINT_CODEX_HOME: value.home,
      CHECKPOINT_SECRET_HEX: SECRET.toString("hex"),
      CHECKPOINT_START_AT: START_AT,
      CHECKPOINT_END_AT: END_AT,
      CHECKPOINT_CREATED_AT: CREATED_AT,
      CHECKPOINT_CRASH_MARKER: value.crashMarker,
    };
    const crashed = await killAfterCommittedAcknowledgement({
      ...workerEnvironment,
      CHECKPOINT_WORKER_MODE: "create-and-await-kill",
    });
    if (!crashed.sigkillSupported) {
      t.skip("SIGKILL is unavailable on this platform");
      return;
    }
    assert.equal(crashed.acknowledged, true, `worker stderr: ${crashed.stderr}`);
    assert.equal(crashed.code, null);
    assert.equal(crashed.signal, "SIGKILL");
    assert.equal(crashed.stdout.includes(PRIVATE_CANARY), false);
    assert.equal(crashed.stdout.includes(value.root), false);
    assert.equal(crashed.stderr.includes(PRIVATE_CANARY), false);
    assert.equal(crashed.stderr.includes(value.root), false);

    const incomplete = await inspectLocalExportWorkspace({ directory: value.crashedWorkspace });
    assert.equal(incomplete.poisoned, false);
    assert.equal(incomplete.scanComplete, false);
    assert.ok(incomplete.recordCounts.usageEvents > 0, "the killed process must have committed a record batch");
    assert.ok(incomplete.recordCounts.usageEvents < 770);

    const status = spawnSync(process.execPath, ["./src/cli.js", "inspect-export-workspace", "--workspace", value.crashedWorkspace], {
      cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Status: incomplete/);
    for (const output of [status.stdout, status.stderr]) {
      assert.equal(output.includes(PRIVATE_CANARY), false);
      assert.equal(output.includes(value.root), false);
      assert.equal(output.includes(value.source), false);
    }

    const resumed = runWorker({ ...workerEnvironment, CHECKPOINT_WORKER_MODE: "resume" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resumed.stderr.includes(PRIVATE_CANARY), false);
    assert.equal(resumed.stdout.includes(PRIVATE_CANARY), false);
    assert.deepEqual(JSON.parse(resumed.stdout), {
      scanComplete: true,
      recordCounts: { usageEvents: 770, quotaSnapshots: 0, activityMarkers: 0 },
    });

    const control = await createLocalExportWorkspace({
      directory: value.controlWorkspace,
      startAt: START_AT,
      endAt: END_AT,
      createdAt: CREATED_AT,
      codexHome: value.home,
      secret: SECRET,
    });
    assert.equal(control.status.scanComplete, true);

    const recoveredSnapshot = await logicalWorkspaceSnapshot(value.crashedWorkspace);
    const controlSnapshot = await logicalWorkspaceSnapshot(value.controlWorkspace);
    assert.equal(recoveredSnapshot.records.length, 770);
    assert.equal(new Set(recoveredSnapshot.records.map((record) => record.recordId)).size, 770);
    assert.equal(stableJson(recoveredSnapshot.records), stableJson(controlSnapshot.records));
    assert.deepEqual(recoveredSnapshot.diagnostics, controlSnapshot.diagnostics);
    // RSS, elapsed time, and directory-entry work are process-attempt counters;
    // the durable logical/accounting totals must remain equal across recovery.
    assert.deepEqual(stableResourceTotals(recoveredSnapshot.resourceUsage), stableResourceTotals(controlSnapshot.resourceUsage));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
