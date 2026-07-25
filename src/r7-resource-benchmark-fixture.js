import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeClaudeStatusline } from "./claude-statusline.js";
import { writeClaudeStatusSnapshot } from "./claude-statusline-storage.js";
import { stableJson } from "./storage.js";

export const R7_FIXTURE_VERSION = "g1-r7-structural-fixture-v0.1";
export const R7_FIXTURE_START_AT = "2026-07-24T11:00:00.000Z";
export const R7_FIXTURE_END_AT = "2026-07-24T13:00:00.000Z";
export const R7_FIXTURE_CREATED_AT = "2026-07-24T13:00:00.000Z";
export const R7_FIXTURE_SECRET = Buffer.alloc(32, 0x72);
const STATUS_SECRET = Buffer.alloc(32, 0x73);
const SYNTHETIC_CANARY = "R7_SYNTHETIC_CONTENT_CANARY_NEVER_EXPORT";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function codexUsage(input, cached, output, reasoning) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function collectorRecord(observedAt, usedPercent) {
  return {
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    provider: "openai_codex",
    observedAt,
    receivedAt: observedAt,
    stalenessMs: 0,
    source: "app_server_read",
    windows: [{
      provider: "openai_codex",
      planType: "pro",
      limitId: "codex",
      slot: "secondary",
      usedPercent,
      windowDurationMins: 10_080,
      resetsAt: 1_785_430_800,
    }],
    providerSurface: "account_shared_unallocated",
    accountScope: {
      status: "unavailable",
      reason: "missing_secret",
      version: "openai-account-v1",
      scopeId: null,
      planType: "pro",
    },
    officialDailyTokens: [],
    officialUsageSummary: null,
    controlledState: "unknown",
    eventKey: "e".repeat(64),
  };
}

function claudeStatus(capturedAt, fiveHourPercent) {
  return sanitizeClaudeStatusline({
    version: "2.1.176",
    model: { id: "claude-sonnet-5", display_name: SYNTHETIC_CANARY },
    session_id: "r7-synthetic-session",
    cwd: `/synthetic/${SYNTHETIC_CANARY}`,
    prompt: SYNTHETIC_CANARY,
    rate_limits: {
      five_hour: { used_percentage: fiveHourPercent, resets_at: 1_774_608_000 },
      seven_day: { used_percentage: 40, resets_at: 1_775_212_800 },
    },
  }, capturedAt, { sessionSecret: STATUS_SECRET });
}

function transcriptRecord(timestamp, index) {
  return {
    type: "assistant",
    timestamp,
    sessionId: "r7-synthetic-transcript-session",
    cwd: `/synthetic/${SYNTHETIC_CANARY}`,
    requestId: SYNTHETIC_CANARY,
    isSidechain: index === 1,
    agentId: index === 1 ? "r7-synthetic-agent" : undefined,
    message: {
      id: `r7-synthetic-message-${index}`,
      model: index === 1 ? "claude-opus-4-8" : "claude-sonnet-5",
      content: [{
        type: "tool_use",
        id: `r7-synthetic-tool-${index}`,
        name: index === 1 ? "Bash" : "Read",
        input: { value: SYNTHETIC_CANARY },
      }],
      usage: {
        input_tokens: 10 + index,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
        output_tokens: 40 + index,
        cache_creation: {
          ephemeral_5m_input_tokens: index === 0 ? 30 : 0,
          ephemeral_1h_input_tokens: index === 1 ? 30 : 0,
        },
        service_tier: "standard_only",
        speed: index === 0 ? "fast" : "standard",
      },
    },
  };
}

async function artifactEvidence(bytesByCategory) {
  const categories = [];
  for (const [category, byteArrays] of Object.entries(bytesByCategory).sort(([a], [b]) => a.localeCompare(b))) {
    const digest = createHash("sha256");
    digest.update(`app-usagemonitor/r7-fixture/${category}/v1\0`);
    let bytes = 0;
    for (const value of byteArrays) {
      digest.update(String(value.length));
      digest.update("\0");
      digest.update(value);
      bytes += value.length;
    }
    categories.push({ category, files: byteArrays.length, bytes, sha256: digest.digest("hex") });
  }
  const projection = { fixtureVersion: R7_FIXTURE_VERSION, categories };
  return { ...projection, manifestSha256: sha256(stableJson(projection)) };
}

export async function createR7StructuralFixture(root) {
  const codexHome = join(root, "codex-home");
  const collectorPath = join(root, "collector.jsonl");
  const claudeStateDirectory = join(root, "claude-state");
  const claudeProjectsDirectory = join(root, "claude-projects");
  await chmod(root, 0o700);
  await mkdir(join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true, mode: 0o700 });
  await mkdir(claudeProjectsDirectory, { recursive: true, mode: 0o700 });

  const first = codexUsage(100, 20, 40, 8);
  const second = codexUsage(150, 30, 60, 11);
  const codexBytes = Buffer.from(`${[
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "r7-synthetic-session", prompt: SYNTHETIC_CANARY },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.001Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:02:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: first, last_token_usage: first } },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:04:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: second, last_token_usage: codexUsage(50, 10, 20, 3) } },
    }),
  ].join("\n")}\n`);
  await writeFile(
    join(codexHome, "sessions", "rollout-2026-07-24T12-00-00-r7.jsonl"),
    codexBytes,
    { mode: 0o600 },
  );

  const collectorBytes = Buffer.from(`${[
    collectorRecord("2026-07-24T12:10:00.000Z", 10),
    collectorRecord("2026-07-24T12:11:00.000Z", 11),
  ].map(JSON.stringify).join("\n")}\n`);
  await writeFile(collectorPath, collectorBytes, { mode: 0o600 });

  const statusBytes = [];
  for (let index = 0; index < 2; index += 1) {
    const status = claudeStatus(
      new Date(Date.parse("2026-07-24T12:20:00.000Z") + (index * 60_000)).toISOString(),
      10 + index,
    );
    await writeClaudeStatusSnapshot(status, {
      stateDirectory: claudeStateDirectory,
      uuid: `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    });
  }
  const statusRecordsDirectory = join(claudeStateDirectory, "records");
  for (const name of (await readdir(statusRecordsDirectory)).sort()) {
    statusBytes.push(await readFile(join(statusRecordsDirectory, name)));
  }

  const transcriptBytes = Buffer.from(`${[
    transcriptRecord("2026-07-24T12:30:00.000Z", 0),
    transcriptRecord("2026-07-24T12:31:00.000Z", 1),
  ].map(JSON.stringify).join("\n")}\n`);
  await writeFile(join(claudeProjectsDirectory, "session.jsonl"), transcriptBytes, { mode: 0o600 });

  const evidence = await artifactEvidence({
    claude_status: statusBytes,
    claude_transcript: [transcriptBytes],
    codex_collector: [collectorBytes],
    codex_rollout: [codexBytes],
  });
  return {
    paths: { codexHome, collectorPath, claudeStateDirectory, claudeProjectsDirectory },
    evidence,
    syntheticCanary: SYNTHETIC_CANARY,
  };
}

export async function inspectR7StructuralFixture(paths) {
  const statusRecordsDirectory = join(paths.claudeStateDirectory, "records");
  const statusBytes = [];
  for (const name of (await readdir(statusRecordsDirectory)).sort()) {
    statusBytes.push(await readFile(join(statusRecordsDirectory, name)));
  }
  return artifactEvidence({
    claude_status: statusBytes,
    claude_transcript: [await readFile(join(paths.claudeProjectsDirectory, "session.jsonl"))],
    codex_collector: [await readFile(paths.collectorPath)],
    codex_rollout: [await readFile(join(
      paths.codexHome,
      "sessions",
      "rollout-2026-07-24T12-00-00-r7.jsonl",
    ))],
  });
}
