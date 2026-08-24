import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "../src/cli.js";
import { sanitizeClaudeStatusline } from "../src/claude-statusline.js";
import { writeClaudeStatusSnapshot } from "../src/claude-statusline-storage.js";
import {
  createLocalExportWorkspace,
  inspectLocalExportWorkspace,
  resumeLocalExportWorkspace,
} from "../src/export-set-controller.js";
import { ExportWorkspaceError, openExportWorkspace } from "../src/export-workspace.js";

const SECRET = Buffer.alloc(32, 53);

function usage(input, output, cached, reasoning) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "usage-monitor-set-controller-")));
  const home = join(root, "codex-home");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const total = usage(100, 20, 40, 8);
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_SESSION" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    JSON.stringify({
      timestamp: "2026-07-24T12:02:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: total, last_token_usage: total, prompt: "PRIVATE_PROMPT" },
        rate_limits: {
          limit_id: "codex", plan_type: "pro",
          primary: { used_percent: 12, window_minutes: 300, resets_at: 1784912400 },
          secondary: { used_percent: 6, window_minutes: 10080, resets_at: 1785430800 },
        },
      },
    }),
  ];
  const source = join(home, "sessions", "rollout-2026-07-24T12-00-00-controller.jsonl");
  await writeFile(source, `${lines.join("\n")}\n`);
  return { root, home, source, workspace: join(root, "workspace") };
}

const CLI_ACCOUNT_SCOPE_CANARY = `openai-account:v1:${"Z".repeat(43)}`;
const CLI_CONTENT_CANARY = "PRIVATE_SUPPLEMENTAL_CONTENT_CANARY_account@example.test";

function collectorQuotaRecord() {
  return {
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    provider: "openai_codex",
    observedAt: "2026-07-24T12:04:00.000Z",
    receivedAt: "2026-07-24T12:04:00.000Z",
    stalenessMs: 0,
    source: "app_server_notification",
    windows: [{
      provider: "openai_codex",
      planType: "pro",
      limitId: "codex",
      slot: "primary",
      usedPercent: 17,
      windowDurationMins: 300,
      resetsAt: 1_784_912_400,
    }],
    providerSurface: "account_shared_unallocated",
    accountScope: {
      status: "available",
      reason: null,
      version: "openai-account-v1",
      scopeId: CLI_ACCOUNT_SCOPE_CANARY,
      planType: "pro",
    },
    officialDailyTokens: [],
    officialUsageSummary: null,
    controlledState: "unknown",
    eventKey: "f".repeat(64),
  };
}

function claudeQuotaStatus() {
  return sanitizeClaudeStatusline({
    version: "2.1.176",
    model: { id: "claude-opus-4-20260701", display_name: CLI_CONTENT_CANARY },
    session_id: CLI_CONTENT_CANARY,
    cwd: `/private/${CLI_CONTENT_CANARY}`,
    prompt: CLI_CONTENT_CANARY,
    account_id: CLI_CONTENT_CANARY,
    rate_limits: {
      five_hour: { used_percentage: 23, resets_at: 1_784_912_400 },
      seven_day: { used_percentage: 41, resets_at: 1_785_430_800 },
    },
  }, "2026-07-24T12:05:00.000Z", { sessionSecret: Buffer.alloc(32, 111) });
}

async function readExportArtifactText(directory) {
  const texts = [];
  for (const name of await readdir(directory)) {
    const bytes = await readFile(join(directory, name));
    texts.push(name.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8"));
  }
  return texts.join("\n");
}

test("export-set CLI parses explicit supplemental source selections without auto-detection", () => {
  const selected = parseArgs([
    "export-set",
    "--collector-file", "./private-collector.jsonl",
    "--claude-state-dir", "./private-claude-state",
    "--claude-projects-dir", "./private-claude-projects",
  ]);
  assert.equal(selected.collectorFile, resolve("./private-collector.jsonl"));
  assert.equal(selected.claudeStatus, false);
  assert.equal(selected.claudeStateDirectory, resolve("./private-claude-state"));
  assert.equal(selected.claudeUsage, false);
  assert.equal(selected.claudeProjectsDirectory, resolve("./private-claude-projects"));

  const defaultClaude = parseArgs(["export-set", "--claude-status"]);
  assert.equal(defaultClaude.claudeStatus, true);
  assert.equal(defaultClaude.claudeStateDirectory, null);

  const defaultClaudeUsage = parseArgs(["export-set", "--claude-usage"]);
  assert.equal(defaultClaudeUsage.claudeUsage, true);
  assert.equal(defaultClaudeUsage.claudeProjectsDirectory, null);

  assert.throws(
    () => parseArgs(["export-set", "--claude-status", "--claude-state-dir", "./private-claude-state"]),
    /either --claude-status or --claude-state-dir/,
  );
  assert.throws(() => parseArgs(["doctor", "--claude-status"]), /only for export-set/);
  assert.throws(() => parseArgs(["quality", "--claude-state-dir", "./private-claude-state"]), /only for export-set/);
  assert.throws(() => parseArgs(["doctor", "--claude-usage"]), /only for export-set/);
  assert.throws(() => parseArgs(["quality", "--claude-projects-dir", "./private-claude-projects"]), /only for export-set/);

  const omitted = parseArgs(["export-set"]);
  assert.equal(omitted.collectorFile, null);
  assert.equal(omitted.claudeStatus, false);
  assert.equal(omitted.claudeStateDirectory, null);
  assert.equal(omitted.claudeUsage, false);
  assert.equal(omitted.claudeProjectsDirectory, null);
});

test("controller creates a complete bounded workspace from frozen source prefixes", async () => {
  const value = await fixture();
  try {
    const result = await createLocalExportWorkspace({
      directory: value.workspace,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: value.home,
      secret: SECRET,
    });
    assert.deepEqual(result.status.recordCounts, {
      usageEvents: 1,
      quotaSnapshots: 2,
      activityMarkers: 0,
    });
    assert.equal(result.status.scanComplete, true);
    assert.equal(result.resourceUsage.scope, "export_set");
    assert.ok(result.resourceUsage.workspaceHighWaterBytes >= result.status.workspaceBytes);
    assert.ok(result.resourceUsage.counters.workspaceBytes >= result.status.workspaceBytes);
    const persisted = await openExportWorkspace({ directory: value.workspace });
    try {
      assert.equal(
        result.resourceUsage.workspaceHighWaterBytes,
        persisted.resourceUsage().workspaceHighWaterBytes,
      );
    } finally {
      persisted.close();
    }
    const inspected = await inspectLocalExportWorkspace({ directory: value.workspace });
    assert.equal(inspected.sourcePlan.sourceFiles, 1);
    assert.equal(inspected.scanComplete, true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("controller resumes an interrupted record batch without duplication", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      createLocalExportWorkspace({
        directory: value.workspace,
        startAt: "2026-07-24T11:00:00.000Z",
        endAt: "2026-07-24T13:00:00.000Z",
        createdAt: "2026-07-24T13:00:00.000Z",
        codexHome: value.home,
        secret: SECRET,
        async failpoint(stage) {
          if (stage === "after_record_batch") throw new Error("simulated interruption");
        },
      }),
      /simulated interruption/,
    );
    const incomplete = await inspectLocalExportWorkspace({ directory: value.workspace });
    assert.equal(incomplete.scanComplete, false);
    assert.deepEqual(incomplete.recordCounts, { usageEvents: 1, quotaSnapshots: 2, activityMarkers: 0 });
    const resumed = await resumeLocalExportWorkspace({
      directory: value.workspace,
      codexHome: value.home,
      secret: SECRET,
    });
    assert.equal(resumed.status.scanComplete, true);
    assert.deepEqual(resumed.status.recordCounts, incomplete.recordCounts);
    assert.ok(resumed.resourceUsage.workspaceHighWaterBytes >= resumed.status.workspaceBytes);
    const persisted = await openExportWorkspace({ directory: value.workspace });
    try {
      assert.equal(
        resumed.resourceUsage.workspaceHighWaterBytes,
        persisted.resourceUsage().workspaceHighWaterBytes,
      );
    } finally {
      persisted.close();
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("controller resumes safely from diagnostics and scan-complete failpoints", async () => {
  for (const failureStage of ["after_diagnostics", "after_scan_complete"]) {
    const value = await fixture();
    try {
      await assert.rejects(
        createLocalExportWorkspace({
          directory: value.workspace,
          startAt: "2026-07-24T11:00:00.000Z",
          endAt: "2026-07-24T13:00:00.000Z",
          createdAt: "2026-07-24T13:00:00.000Z",
          codexHome: value.home,
          secret: SECRET,
          async failpoint(stage) {
            if (stage === failureStage) throw new Error("simulated controller interruption");
          },
        }),
        /simulated controller interruption/,
      );
      const resumed = await resumeLocalExportWorkspace({
        directory: value.workspace,
        codexHome: value.home,
        secret: SECRET,
      });
      assert.equal(resumed.status.scanComplete, true);
      assert.deepEqual(resumed.status.recordCounts, {
        usageEvents: 1,
        quotaSnapshots: 2,
        activityMarkers: 0,
      });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("resume fails closed after identity rotation", async () => {
  const value = await fixture();
  try {
    await createLocalExportWorkspace({
      directory: value.workspace,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: value.home,
      secret: SECRET,
    });
    await assert.rejects(
      resumeLocalExportWorkspace({
        directory: value.workspace,
        codexHome: value.home,
        secret: Buffer.alloc(32, 54),
      }),
      (error) => error instanceof ExportWorkspaceError
        && error.code === "export_workspace_checkpoint_mismatch",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("resume fails closed when the bounded activity-marker set changes", async () => {
  const value = await fixture();
  const first = {
    markerId: "019f9010-2222-7222-8222-222222222222",
    observedAt: "2026-07-24T12:01:00.000Z",
    surface: "chatgpt_work",
    state: "pulse",
    agenticPoolCoupling: "shared_agentic_pool",
    planType: "pro",
    planVariant: "pro-20x",
  };
  try {
    await assert.rejects(
      createLocalExportWorkspace({
        directory: value.workspace,
        startAt: "2026-07-24T11:00:00.000Z",
        endAt: "2026-07-24T13:00:00.000Z",
        createdAt: "2026-07-24T13:00:00.000Z",
        codexHome: value.home,
        secret: SECRET,
        activityMarkers: [first],
        async failpoint(stage) {
          if (stage === "after_record_batch") throw new Error("simulated interruption");
        },
      }),
      /simulated interruption/,
    );
    await assert.rejects(
      resumeLocalExportWorkspace({
        directory: value.workspace,
        codexHome: value.home,
        secret: SECRET,
        activityMarkers: [{ ...first, state: "end" }],
      }),
      (error) => error instanceof ExportWorkspaceError
        && error.code === "export_workspace_checkpoint_mismatch",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("export-set CLI creates and resumes a content-free local set", async () => {
  const value = await fixture();
  const output = join(value.root, "output");
  const secretFile = join(value.root, "participant-secret");
  const collectorDirectory = join(value.root, "PRIVATE_COLLECTOR_DIRECTORY_CANARY");
  const collectorFile = join(collectorDirectory, "PRIVATE_COLLECTOR_FILENAME_CANARY.jsonl");
  const claudeStateDirectory = join(value.root, "PRIVATE_CLAUDE_STATE_DIRECTORY_CANARY");
  const claudeProjectsDirectory = join(value.root, "PRIVATE_CLAUDE_PROJECTS_DIRECTORY_CANARY");
  const claudeTranscriptFile = join(claudeProjectsDirectory, "PRIVATE_CLAUDE_TRANSCRIPT_FILENAME_CANARY.jsonl");
  const claudeTranscriptContentCanary = "PRIVATE_CLAUDE_TRANSCRIPT_CONTENT_CANARY";
  const claudeTranscriptSessionCanary = "PRIVATE_CLAUDE_TRANSCRIPT_SESSION_CANARY";
  let claudeRecord;
  try {
    await mkdir(collectorDirectory, { mode: 0o700 });
    await writeFile(collectorFile, `${JSON.stringify(collectorQuotaRecord())}\n`, { mode: 0o600 });
    claudeRecord = await writeClaudeStatusSnapshot(claudeQuotaStatus(), {
      stateDirectory: claudeStateDirectory,
      uuid: "90000000-0000-4000-8000-000000000001",
    });
    await mkdir(claudeProjectsDirectory, { mode: 0o700 });
    await writeFile(claudeTranscriptFile, `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-24T12:06:00.000Z",
      sessionId: claudeTranscriptSessionCanary,
      message: {
        id: "msg_cli_claude_usage_1",
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 11,
          cache_read_input_tokens: 12,
          cache_creation_input_tokens: 13,
          output_tokens: 14,
          service_tier: "standard",
          speed: "standard",
        },
        content: [{ type: "text", text: claudeTranscriptContentCanary }],
      },
    })}\n`, { mode: 0o600 });
    const common = [
      "--workspace", value.workspace,
      "--directory", output,
      "--codex-home", value.home,
      "--secret-file", secretFile,
      "--collector-file", collectorFile,
      "--claude-state-dir", claudeStateDirectory,
      "--claude-projects-dir", claudeProjectsDirectory,
      "--max-records-per-chunk", "1",
      "--max-bundle-bytes", "33554432",
      "--max-artifact-bytes", "35651584",
    ];
    const created = spawnSync(process.execPath, [
      "./src/cli.js", "export-set",
      "--since", "2026-07-24T11:00:00.000Z",
      "--until", "2026-07-24T13:00:00.000Z",
      ...common,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /Local metadata export set: complete/);
    assert.match(created.stdout, /Upload: disabled/);
    assert.match(created.stdout, /Records: 2 usage, 5 quota, 0 markers/);

    const workspace = await openExportWorkspace({ directory: value.workspace });
    let supplementalSourceKeys;
    try {
      supplementalSourceKeys = workspace.loadSupplementalSourcePlan().sources.map((source) => source.sourceKey);
      assert.deepEqual(workspace.getDescriptor().sourceProviders, ["openai_codex", "anthropic_claude_code"]);
    } finally {
      workspace.close();
    }

    const inspected = spawnSync(process.execPath, [
      "./src/cli.js", "inspect-export-workspace", "--workspace", value.workspace,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.match(inspected.stdout, /Sources: 4; bytes: \d+/);
    assert.match(inspected.stdout, /Providers: openai_codex, anthropic_claude_code/);

    const missingSelection = spawnSync(process.execPath, [
      "./src/cli.js", "export-set", "--resume",
      "--workspace", value.workspace,
      "--directory", output,
      "--codex-home", value.home,
      "--secret-file", secretFile,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(missingSelection.status, 0);
    assert.match(missingSelection.stderr, /checkpoint_mismatch/);

    const resumed = spawnSync(process.execPath, [
      "./src/cli.js", "export-set", "--resume", ...common,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /Workspace status: scan_complete/);

    const verified = spawnSync(process.execPath, [
      "./src/cli.js", "verify-export-set", "--directory", output,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /Local metadata export-set verification: passed/);
    assert.match(verified.stdout, /Records: 2 usage, 5 quota, 0 markers/);

    const artifactText = await readExportArtifactText(output);
    const allOutput = [created.stdout, inspected.stdout, missingSelection.stdout, missingSelection.stderr,
      resumed.stdout, verified.stdout, artifactText].join("\n");
    for (const forbidden of [
      value.root,
      value.home,
      value.source,
      collectorDirectory,
      collectorFile,
      basename(collectorFile),
      claudeStateDirectory,
      claudeRecord.recordFile,
      basename(claudeRecord.recordFile),
      claudeProjectsDirectory,
      claudeTranscriptFile,
      basename(claudeTranscriptFile),
      claudeTranscriptContentCanary,
      claudeTranscriptSessionCanary,
      ...supplementalSourceKeys,
      CLI_ACCOUNT_SCOPE_CANARY,
      CLI_CONTENT_CANARY,
      "PRIVATE_SESSION",
      "PRIVATE_PROMPT",
    ]) {
      assert.equal(allOutput.includes(forbidden), false, forbidden);
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a post-read source-integrity failure permanently poisons the incomplete workspace", async () => {
  const value = await fixture();
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_SESSION" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
  ];
  for (let index = 1; index <= 1001; index += 1) {
    lines.push(JSON.stringify({
      timestamp: `2026-07-24T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: usage(index, index, 0, 0),
          last_token_usage: usage(1, 1, 0, 0),
        },
        rate_limits: null,
      },
    }));
  }
  const original = `${lines.join("\n")}\n`;
  await writeFile(value.source, original);
  let mutated = false;
  try {
    await assert.rejects(
      createLocalExportWorkspace({
        directory: value.workspace,
        startAt: "2026-07-24T11:00:00.000Z",
        endAt: "2026-07-24T13:00:00.000Z",
        createdAt: "2026-07-24T13:00:00.000Z",
        codexHome: value.home,
        secret: SECRET,
        async failpoint(stage) {
          if (!mutated && stage === "after_record_batch") {
            mutated = true;
            await writeFile(value.source, original.replace("PRIVATE_SESSION", "CHANGED_SESSION"));
          }
        },
      }),
      /source plan failed \(source_changed\)/,
    );
    const inspected = await inspectLocalExportWorkspace({ directory: value.workspace });
    assert.equal(inspected.poisoned, true);
    assert.equal(inspected.scanComplete, false);
    const cliInspection = spawnSync(process.execPath, [
      "./src/cli.js", "inspect-export-workspace", "--workspace", value.workspace,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(cliInspection.status, 0, cliInspection.stderr);
    assert.match(cliInspection.stdout, /Status: poisoned_source_integrity/);
    assert.equal(cliInspection.stdout.includes(value.root), false);
    await writeFile(value.source, original);
    await assert.rejects(
      resumeLocalExportWorkspace({
        directory: value.workspace,
        codexHome: value.home,
        secret: SECRET,
      }),
      (error) => error instanceof ExportWorkspaceError
        && error.code === "export_workspace_checkpoint_mismatch",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("malformed Codex accounting poisons a checkpoint workspace before completion", async () => {
  const value = await fixture();
  try {
    await writeFile(value.source, `${[
      JSON.stringify({
        timestamp: "2026-07-24T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "PRIVATE_SESSION" },
      }),
      JSON.stringify({
        timestamp: "2026-07-24T12:00:00.001Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      }),
      "{\"timestamp\":\"2026-07-24T12:02:00.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"",
    ].join("\n")}\n`);

    await assert.rejects(
      createLocalExportWorkspace({
        directory: value.workspace,
        startAt: "2026-07-24T11:00:00.000Z",
        endAt: "2026-07-24T13:00:00.000Z",
        createdAt: "2026-07-24T13:00:00.000Z",
        codexHome: value.home,
        secret: SECRET,
      }),
      (error) => error?.code
        === "export_source_codex_rollout_content_invalid",
    );
    const inspected = await inspectLocalExportWorkspace({
      directory: value.workspace,
    });
    assert.equal(inspected.poisoned, true);
    assert.equal(inspected.scanComplete, false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a malformed Codex speed setting poisons a checkpoint workspace", async () => {
  const value = await fixture();
  try {
    await writeFile(value.source, `${[
      JSON.stringify({
        timestamp: "2026-07-24T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "PRIVATE_SESSION" },
      }),
      JSON.stringify({
        timestamp: "2026-07-24T12:00:00.001Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      }),
      JSON.stringify({
        timestamp: "2026-07-24T12:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: { service_tier: 42 },
        },
      }),
    ].join("\n")}\n`);

    await assert.rejects(createLocalExportWorkspace({
      directory: value.workspace,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: value.home,
      secret: SECRET,
    }), (error) => error?.code
      === "export_source_codex_rollout_content_invalid");
    const inspected = await inspectLocalExportWorkspace({
      directory: value.workspace,
    });
    assert.equal(inspected.poisoned, true);
    assert.equal(inspected.scanComplete, false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("duplicate Codex session metadata poisons a checkpoint workspace", async () => {
  const value = await fixture();
  try {
    const meta = JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "PRIVATE_SESSION" },
    });
    await writeFile(value.source, `${meta}\n${meta}\n`);
    await assert.rejects(createLocalExportWorkspace({
      directory: value.workspace,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: value.home,
      secret: SECRET,
    }), (error) => error?.code
      === "export_source_codex_rollout_content_invalid");
    const inspected = await inspectLocalExportWorkspace({
      directory: value.workspace,
    });
    assert.equal(inspected.poisoned, true);
    assert.equal(inspected.scanComplete, false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
