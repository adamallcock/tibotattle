import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localCodexLogScanner } from "../src/local-node-runtime.js";
import { CodexLogSourceChangedError } from
  "../src/providers/codex/logs.js";

const {
  discoverCodexRolloutInfos,
  scanCodexLogEvents,
} = localCodexLogScanner;

const START_AT = "2026-07-24T11:00:00.000Z";
const END_AT = "2026-07-24T13:00:00.000Z";

function tokenRecord(timestamp, inputTokens = 10) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
          total_tokens: inputTokens + 1,
        },
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
          total_tokens: inputTokens + 1,
        },
      },
    },
  });
}

async function fixture() {
  const codexHome = await mkdtemp(join(tmpdir(), "usage-monitor-active-source-"));
  const sessions = join(codexHome, "sessions", "2026", "07", "24");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
  const path = join(sessions, "rollout-2026-07-24T12-00-00-active.jsonl");
  const text = [
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "private-active-session" },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-test" },
    }),
    tokenRecord("2026-07-24T12:01:00.000Z"),
    "",
  ].join("\n");
  await writeFile(path, text);
  return { codexHome, path, text };
}

async function discovered(value) {
  return discoverCodexRolloutInfos({
    codexHome: value.codexHome,
    startAt: START_AT,
    endAt: END_AT,
  });
}

function safeSourceChange(error) {
  assert.equal(error instanceof CodexLogSourceChangedError, true);
  assert.equal(error.code, "codex_log_source_changed");
  assert.equal(error.retryable, true);
  assert.equal(error.message, "Codex log source changed during scan; retry");
  assert.equal(error.message.includes("private-active-session"), false);
  assert.equal(error.message.includes("/tmp/"), false);
  return true;
}

test("active rollout scan accepts a bounded append proven to be after the requested end", async () => {
  const value = await fixture();
  try {
    let appended = false;
    const usage = [];
    const result = await scanCodexLogEvents({
      startAt: START_AT,
      endAt: END_AT,
      codexHome: value.codexHome,
      onUsage: async (event) => {
        usage.push(event);
        if (appended) return;
        appended = true;
        await appendFile(value.path, `${tokenRecord("2026-07-24T14:00:00.000Z", 20)}\n`);
      },
    });
    assert.equal(usage.length, 1);
    assert.equal(result.diagnostics.filesScanned, 1);
  } finally {
    await rm(value.codexHome, { recursive: true, force: true });
  }
});

test("active rollout scan rejects a relevant append after discovery with a retryable content-free error", async () => {
  const value = await fixture();
  try {
    const rolloutInfos = await discovered(value);
    await appendFile(value.path, `${tokenRecord("2026-07-24T12:05:00.000Z", 20)}\n`);
    await assert.rejects(
      scanCodexLogEvents({
        startAt: START_AT,
        endAt: END_AT,
        codexHome: value.codexHome,
        rolloutInfos,
      }),
      safeSourceChange,
    );
  } finally {
    await rm(value.codexHome, { recursive: true, force: true });
  }
});

test("active rollout scan rejects truncation while parsing the frozen prefix", async () => {
  const value = await fixture();
  try {
    let truncated = false;
    await assert.rejects(
      scanCodexLogEvents({
        startAt: START_AT,
        endAt: END_AT,
        codexHome: value.codexHome,
        onUsage: async () => {
          if (truncated) return;
          truncated = true;
          await writeFile(value.path, "");
        },
      }),
      safeSourceChange,
    );
  } finally {
    await rm(value.codexHome, { recursive: true, force: true });
  }
});

test("active rollout scan rejects path replacement while retaining the opened descriptor", async (t) => {
  if (process.platform === "win32") {
    return t.skip("Windows replacement semantics require the deferred handle-identity contract");
  }
  const value = await fixture();
  try {
    const replacement = join(value.codexHome, "replacement.jsonl");
    await writeFile(replacement, value.text);
    let replaced = false;
    await assert.rejects(
      scanCodexLogEvents({
        startAt: START_AT,
        endAt: END_AT,
        codexHome: value.codexHome,
        onUsage: async () => {
          if (replaced) return;
          replaced = true;
          await rename(replacement, value.path);
        },
      }),
      safeSourceChange,
    );
  } finally {
    await rm(value.codexHome, { recursive: true, force: true });
  }
});
