import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalExportWorkspace, resumeLocalExportWorkspace } from "../src/export-set-controller.js";
import { openExportWorkspace } from "../src/export-workspace.js";
import { stableJson } from "../src/storage.js";

const SECRET = Buffer.alloc(32, 121);
const START = "2026-07-24T12:00:00.000Z";
const END = "2026-07-24T13:00:00.000Z";
const PRIVATE = "PRIVATE_CLAUDE_TRANSCRIPT_WORKSPACE_CANARY";

function row(index, { messageId = `message-${index}`, output = 20 + index, toolId = `tool-${index}` } = {}) {
  const timestamp = new Date(Date.parse("2026-07-24T12:10:00.000Z") + index * 1_000).toISOString();
  return {
    type: "assistant",
    timestamp,
    sessionId: `session-${PRIVATE}`,
    cwd: `/private/${PRIVATE}`,
    requestId: PRIVATE,
    gitBranch: PRIVATE,
    message: {
      id: messageId,
      model: "claude-sonnet-5",
      content: [{ type: "tool_use", id: toolId, name: "Read", input: { path: PRIVATE } }],
      usage: {
        input_tokens: 10 + index,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
        cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 10 },
        output_tokens: output,
        speed: index % 2 === 0 ? "standard" : "fast",
        inference_geo: PRIVATE,
      },
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-claude-transcript-workspace-"));
  await chmod(root, 0o700);
  const codexHome = join(root, "codex-home");
  const projectsDirectory = join(root, "claude-projects");
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
  await mkdir(join(projectsDirectory, "project"), { recursive: true });
  const transcriptPath = join(projectsDirectory, "project", "session.jsonl");
  await writeFile(transcriptPath, `${[row(0), row(1), row(2)].map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  return { root, codexHome, projectsDirectory, transcriptPath };
}

async function records(directory) {
  const workspace = await openExportWorkspace({ directory });
  try {
    return [...workspace.iterateRecords()]
      .filter((item) => item.family === "usageEvents")
      .map((item) => item.record);
  } finally {
    workspace.close();
  }
}

async function create(value, directory, options = {}) {
  return createLocalExportWorkspace({
    directory,
    startAt: START,
    endAt: END,
    createdAt: END,
    codexHome: value.codexHome,
    claudeProjectsDirectory: value.projectsDirectory,
    secret: SECRET,
    ...options,
  });
}

test("Claude transcript controller path emits canonical privacy-safe usage deterministically", async () => {
  const value = await fixture();
  const one = join(value.root, "workspace-one");
  const many = join(value.root, "workspace-many");
  try {
    const first = await create(value, one, { claudeTranscriptRecordsPerBatch: 1 });
    const second = await create(value, many, { claudeTranscriptRecordsPerBatch: 100 });
    assert.equal(first.status.scanComplete, true);
    assert.equal(first.status.recordCounts.usageEvents, 3);
    assert.deepEqual(first.descriptor.sourceProviders, ["openai_codex", "anthropic_claude_code"]);
    const firstRecords = await records(one);
    assert.equal(stableJson(firstRecords), stableJson(await records(many)));
    assert.deepEqual(firstRecords[0].components, {
      inputUncachedTokens: 10,
      inputCacheReadTokens: 30,
      inputCacheWriteTokens: 40,
      inputCacheWrite5mTokens: 30,
      inputCacheWrite1hTokens: 10,
      outputTextTokens: null,
      outputReasoningTokens: null,
      outputCombinedTokens: 20,
    });
    assert.equal(firstRecords[0].modelId, "claude-sonnet-5");
    assert.equal(firstRecords[0].toolClassCounts.fileSearch, 1);
    const serialized = `${stableJson(first.descriptor)}${stableJson(firstRecords)}`;
    assert.equal(serialized.includes(PRIVATE), false);
    assert.equal(serialized.includes(value.root), false);
    assert.equal(serialized.includes("inference_geo"), false);
    assert.equal(serialized.includes("requestId"), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Claude transcript checkpoint resume is exactly-once after a committed batch", async () => {
  const value = await fixture();
  const interrupted = join(value.root, "workspace-interrupted");
  const control = join(value.root, "workspace-control");
  let stopped = false;
  try {
    await assert.rejects(create(value, interrupted, {
      claudeTranscriptRecordsPerBatch: 1,
      async failpoint(stage) {
        if (stage === "after_claude_transcript_checkpoint_batch" && !stopped) {
          stopped = true;
          throw new Error("simulated_process_death");
        }
      },
    }), /simulated_process_death/u);
    assert.equal(stopped, true);
    const resumed = await resumeLocalExportWorkspace({
      directory: interrupted,
      codexHome: value.codexHome,
      claudeProjectsDirectory: value.projectsDirectory,
      secret: SECRET,
    });
    assert.equal(resumed.status.scanComplete, true);
    await create(value, control, { claudeTranscriptRecordsPerBatch: 100 });
    assert.equal(stableJson(await records(interrupted)), stableJson(await records(control)));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Claude transcript terminal proof rejects same-size frozen-prefix mutation", async () => {
  const value = await fixture();
  const workspace = join(value.root, "workspace-mutated");
  let mutated = false;
  try {
    await assert.rejects(create(value, workspace, {
      claudeTranscriptRecordsPerBatch: 1,
      async failpoint(stage) {
        if (stage !== "after_claude_transcript_checkpoint_batch" || mutated) return;
        mutated = true;
        const original = await readFile(value.transcriptPath, "utf8");
        const replacement = original.replace(`\"output_tokens\":20`, `\"output_tokens\":21`);
        assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
        await writeFile(value.transcriptPath, replacement, { mode: 0o600 });
      },
    }), (error) => error.code === "claude_transcript_export_source_changed");
    assert.equal(mutated, true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Claude transcript zero-selection source still rejects same-size frozen-prefix mutation", async () => {
  const value = await fixture();
  const workspace = join(value.root, "workspace-zero-mutated");
  const zeroPath = join(value.projectsDirectory, "project", "zero.jsonl");
  let mutated = false;
  try {
    await writeFile(zeroPath, `${JSON.stringify({ type: "user", marker: "A" })}\n`, { mode: 0o600 });
    await assert.rejects(create(value, workspace, {
      claudeTranscriptRecordsPerBatch: 1,
      async failpoint(stage) {
        if (stage !== "after_claude_transcript_checkpoint_batch" || mutated) return;
        mutated = true;
        const original = await readFile(zeroPath, "utf8");
        const replacement = original.replace(`\"marker\":\"A\"`, `\"marker\":\"B\"`);
        assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
        await writeFile(zeroPath, replacement, { mode: 0o600 });
      },
    }), (error) => error.code === "claude_transcript_export_source_changed");
    assert.equal(mutated, true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Claude transcript checkpoint batches do not rehash or recount the whole prefix per batch", async () => {
  const value = await fixture();
  const workspace = join(value.root, "workspace-cost");
  let clockReads = 0;
  try {
    const irrelevant = JSON.stringify({ type: "user", message: { content: "x".repeat(384 * 1024) } });
    const lines = [irrelevant, row(0), irrelevant, row(1), irrelevant, row(2), irrelevant];
    await writeFile(value.transcriptPath, `${lines.map((item) => (
      typeof item === "string" ? item : JSON.stringify(item)
    )).join("\n")}\n`, { mode: 0o600 });
    const result = await create(value, workspace, {
      claudeTranscriptRecordsPerBatch: 1,
      resourceClock() { clockReads += 1; return 1_000; },
    });
    assert.equal(result.status.scanComplete, true);
    // Planning streams and binds the inventory once; population streams it
    // once and performs one terminal whole-prefix hash proof. The bound line
    // count removes the redundant terminal newline pass.
    assert.ok(clockReads < 160, `unexpected resource runtime checks: ${clockReads}`);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
