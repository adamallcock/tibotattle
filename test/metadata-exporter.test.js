import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLocalMetadataBundle, writeLocalMetadataBundle } from "../src/metadata-exporter.js";
import { stableJson } from "../src/storage.js";

const SECRET = Buffer.alloc(32, 11);
const BUNDLE_ID = `bundle:v1:${"C".repeat(43)}`;
const CREATED_AT = "2026-07-24T12:30:00.000Z";

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

function tokenRecord(timestamp, total, last, usedPercent) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last, prompt: "PRIVATE_PROMPT" },
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 1784912400 },
        secondary: { used_percent: usedPercent / 2, window_minutes: 10080, resets_at: 1785430800 },
        unknown_private_field: "adam@example.com",
      },
      response: "PRIVATE_RESPONSE",
    },
  });
}

async function privateFixture() {
  const home = await mkdtemp(join(tmpdir(), "app-usagemonitor-export-"));
  await mkdir(join(home, "sessions"), { recursive: true });
  const rawSession = "private-session-adam@example.com";
  const rawPath = "/Users/adam/private/project";
  const rawToolArguments = `open ${rawPath} with Bearer private-secret-token-value`;
  const unknownModel = `internal model ${rawPath}`;
  const lines = [
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: rawSession, source: "user", cwd: rawPath, repository: "secret-repo" },
    }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol", user_prompt: "PRIVATE_PROMPT" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.002Z", type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } } }),
    JSON.stringify({ timestamp: "2026-07-24T12:01:00.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "private-call-id", arguments: rawToolArguments } }),
    tokenRecord("2026-07-24T12:02:00.000Z", usage(100, 20, 40, 8), usage(100, 20, 40, 8), 12.3),
    JSON.stringify({ timestamp: "2026-07-24T12:03:00.000Z", type: "turn_context", payload: { model: unknownModel } }),
    tokenRecord("2026-07-24T12:04:00.000Z", usage(150, 30, 60, 11), usage(50, 10, 20, 3), 13.4),
  ];
  await writeFile(join(home, "sessions", "rollout-2026-07-24T12-00-00-private.jsonl"), `${lines.join("\n")}\n`);
  return { home, rawSession, rawPath, rawToolArguments, unknownModel };
}

test("bounded exporter emits only allowlisted metadata and fingerprints unknown models", async () => {
  const fixture = await privateFixture();
  const rawAccountScope = "raw-account-scope-adam@example.com";
  const rawMarkerId = "private-marker-id";
  try {
    const result = await buildLocalMetadataBundle({
      startAt: "2026-07-24T11:59:00.000Z",
      endAt: "2026-07-24T12:10:00.000Z",
      codexHome: fixture.home,
      secret: SECRET,
      bundleId: BUNDLE_ID,
      createdAt: CREATED_AT,
      activityMarkers: [{
        markerId: rawMarkerId,
        observedAt: "2026-07-24T12:05:00.000Z",
        surface: "chatgpt_work",
        state: "pulse",
        agenticPoolCoupling: "shared_agentic_pool",
        planType: "pro",
        planVariant: "pro-20x",
        accountScope: { status: "available", scopeId: rawAccountScope },
        experimentId: "private-experiment-label",
        content: "PRIVATE_MARKER_CONTENT",
      }],
      forbiddenSourceValues: [
        fixture.rawSession, fixture.rawPath, fixture.rawToolArguments, fixture.unknownModel,
        rawAccountScope, rawMarkerId, "PRIVATE_PROMPT", "PRIVATE_RESPONSE", "PRIVATE_MARKER_CONTENT",
      ],
    });

    assert.deepEqual(result.bundle.recordCounts, { usageEvents: 2, quotaSnapshots: 4, activityMarkers: 1 });
    assert.equal(result.bundle.transportReady, false);
    assert.equal(result.receipt.verdict, "passed");
    assert.equal(result.receipt.transportReady, false);
    assert.equal(result.bundle.records.usageEvents[0].speedMode, "fast");
    assert.equal(result.bundle.records.usageEvents[0].toolClassCounts.localShell, 1);
    assert.deepEqual(result.bundle.records.usageEvents[0].components, {
      inputUncachedTokens: 60,
      inputCacheReadTokens: 40,
      inputCacheWriteTokens: 0,
      outputTextTokens: 12,
      outputReasoningTokens: 8,
    });
    assert.equal(result.bundle.records.usageEvents[1].modelId, "unknown");
    assert.match(result.bundle.records.usageEvents[1].modelFingerprint, /^model:v1:/);
    assert.match(result.bundle.records.activityMarkers[0].accountScopeId, /^account:v1:/);
    const serialized = stableJson(result.bundle);
    for (const canary of [fixture.rawSession, fixture.rawPath, fixture.rawToolArguments, fixture.unknownModel, rawAccountScope, rawMarkerId, "PRIVATE_PROMPT"]) {
      assert.equal(serialized.includes(canary), false, `export leaked canary: ${canary}`);
    }
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("local export and receipt are written owner-only", async () => {
  const fixture = await privateFixture();
  const outputDirectory = await mkdtemp(join(tmpdir(), "app-usagemonitor-output-"));
  try {
    const result = await buildLocalMetadataBundle({
      startAt: "2026-07-24T11:59:00.000Z",
      endAt: "2026-07-24T12:10:00.000Z",
      codexHome: fixture.home,
      secret: SECRET,
      bundleId: BUNDLE_ID,
      createdAt: CREATED_AT,
    });
    const outputFile = join(outputDirectory, "review.umx.json");
    const receiptFile = join(outputDirectory, "review.privacy-receipt.json");
    await writeLocalMetadataBundle({ ...result, outputFile, receiptFile });
    assert.equal((await stat(outputFile)).mode & 0o777, 0o600);
    assert.equal((await stat(receiptFile)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(outputFile, "utf8")), result.bundle);
    assert.deepEqual(JSON.parse(await readFile(receiptFile, "utf8")), result.receipt);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
