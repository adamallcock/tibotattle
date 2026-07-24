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

async function collidingSessionsFixture({ reverse = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "app-usagemonitor-collision-"));
  await mkdir(join(home, "sessions"), { recursive: true });
  const sessions = reverse ? ["session-beta", "session-alpha"] : ["session-alpha", "session-beta"];
  for (const [index, session] of sessions.entries()) {
    const lines = [
      JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: session, source: "user" } }),
      JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      JSON.stringify({ timestamp: "2026-07-24T12:01:00.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "reused-across-sessions" } }),
      tokenRecord("2026-07-24T12:02:00.000Z", usage(100, 20, 40, 8), usage(100, 20, 40, 8), 12),
    ];
    await writeFile(join(home, "sessions", `rollout-2026-07-24T12-00-0${index}-${session}.jsonl`), `${lines.join("\n")}\n`);
  }
  return home;
}

test("bounded exporter emits only allowlisted metadata and fingerprints unknown models", async () => {
  const fixture = await privateFixture();
  const rawAccountScope = "raw-account-scope-adam@example.com";
  const rawMarkerId = "019f9010-1111-7111-8111-111111111111";
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

test("source-occurrence IDs remain stable when export bounds change", async () => {
  const fixture = await privateFixture();
  try {
    const common = {
      endAt: "2026-07-24T12:02:00.000Z",
      codexHome: fixture.home,
      secret: SECRET,
      bundleId: BUNDLE_ID,
      createdAt: CREATED_AT,
    };
    const wide = await buildLocalMetadataBundle({ ...common, startAt: "2026-07-24T11:59:00.000Z" });
    const narrow = await buildLocalMetadataBundle({ ...common, startAt: "2026-07-24T12:02:00.000Z" });
    assert.equal(wide.bundle.records.usageEvents[0].eventId, narrow.bundle.records.usageEvents[0].eventId);
    assert.deepEqual(
      wide.bundle.records.quotaSnapshots.map((row) => row.snapshotId),
      narrow.bundle.records.quotaSnapshots.map((row) => row.snapshotId),
    );
    assert.equal(wide.bundle.records.usageEvents[0].toolClassCounts.localShell, 1);
    assert.equal(narrow.bundle.records.usageEvents[0].toolClassCounts.localShell, 0);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("identical token records from independent sessions are not collapsed or traversal-dependent", async () => {
  const firstHome = await collidingSessionsFixture();
  const secondHome = await collidingSessionsFixture({ reverse: true });
  try {
    const common = {
      startAt: "2026-07-24T11:59:00.000Z",
      endAt: "2026-07-24T12:03:00.000Z",
      secret: SECRET,
      bundleId: BUNDLE_ID,
      createdAt: CREATED_AT,
    };
    const first = await buildLocalMetadataBundle({ ...common, codexHome: firstHome });
    const second = await buildLocalMetadataBundle({ ...common, codexHome: secondHome });
    assert.equal(first.bundle.records.usageEvents.length, 2);
    assert.equal(new Set(first.bundle.records.usageEvents.map((row) => row.eventId)).size, 2);
    assert.deepEqual(first.bundle.records.usageEvents.map((row) => row.toolClassCounts.localShell), [1, 1]);
    assert.deepEqual(
      first.bundle.records.usageEvents.map((row) => row.eventId).sort(),
      second.bundle.records.usageEvents.map((row) => row.eventId).sort(),
    );
    assert.equal(new Set(first.bundle.records.quotaSnapshots.map((row) => row.providerStateId)).size, 4);
  } finally {
    await rm(firstHome, { recursive: true, force: true });
    await rm(secondHome, { recursive: true, force: true });
  }
});

test("same-session tool records without provider IDs remain separate physical occurrences", async () => {
  const home = await mkdtemp(join(tmpdir(), "app-usagemonitor-tool-collision-"));
  await mkdir(join(home, "sessions"), { recursive: true });
  const tool = JSON.stringify({
    timestamp: "2026-07-24T12:01:00.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "exec_command" },
  });
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "session-tools", source: "user" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    tool,
    tool,
    tokenRecord("2026-07-24T12:02:00.000Z", usage(100, 20, 40, 8), usage(100, 20, 40, 8), 12),
  ];
  await writeFile(join(home, "sessions", "rollout-2026-07-24T12-00-00-tools.jsonl"), `${lines.join("\n")}\n`);
  try {
    const result = await buildLocalMetadataBundle({
      startAt: "2026-07-24T11:59:00.000Z",
      endAt: "2026-07-24T12:03:00.000Z",
      codexHome: home,
      secret: SECRET,
      bundleId: BUNDLE_ID,
      createdAt: CREATED_AT,
    });
    assert.equal(result.bundle.records.usageEvents[0].toolClassCounts.localShell, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("distinct rollout files claiming one session identity fail closed instead of dropping one occurrence", async () => {
  const home = await mkdtemp(join(tmpdir(), "app-usagemonitor-duplicate-session-"));
  await mkdir(join(home, "sessions"), { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "duplicated-session", source: "user" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    tokenRecord("2026-07-24T12:02:00.000Z", usage(100, 20, 40, 8), usage(100, 20, 40, 8), 12),
  ];
  await writeFile(join(home, "sessions", "rollout-2026-07-24T12-00-00-duplicate-a.jsonl"), `${lines.join("\n")}\n`);
  await writeFile(join(home, "sessions", "rollout-2026-07-24T12-00-01-duplicate-b.jsonl"), `${lines.join("\n")}\n`);
  try {
    await assert.rejects(
      buildLocalMetadataBundle({
        startAt: "2026-07-24T11:59:00.000Z",
        endAt: "2026-07-24T12:03:00.000Z",
        codexHome: home,
        secret: SECRET,
        bundleId: BUNDLE_ID,
        createdAt: CREATED_AT,
      }),
      /Ambiguous duplicate Codex session identity/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("missing source token components remain unavailable rather than becoming observed zero", async () => {
  const home = await mkdtemp(join(tmpdir(), "app-usagemonitor-missing-components-"));
  await mkdir(join(home, "sessions"), { recursive: true });
  const incomplete = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "session-incomplete", source: "user" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    tokenRecord("2026-07-24T12:02:00.000Z", incomplete, incomplete, 12),
  ];
  await writeFile(join(home, "sessions", "rollout-2026-07-24T12-00-00-incomplete.jsonl"), `${lines.join("\n")}\n`);
  try {
    const result = await buildLocalMetadataBundle({
      startAt: "2026-07-24T11:59:00.000Z",
      endAt: "2026-07-24T12:03:00.000Z",
      codexHome: home,
      secret: SECRET,
      bundleId: BUNDLE_ID,
      createdAt: CREATED_AT,
    });
    const [event] = result.bundle.records.usageEvents;
    assert.equal(event.totalInputContextTokens, 100);
    assert.deepEqual(event.components, {
      inputUncachedTokens: null,
      inputCacheReadTokens: null,
      inputCacheWriteTokens: null,
      outputTextTokens: null,
      outputReasoningTokens: null,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("activity marker identity depends only on its persisted UUID", async () => {
  const fixture = await privateFixture();
  const markerId = "019f9010-2222-7222-8222-222222222222";
  const marker = {
    markerId,
    observedAt: "2026-07-24T12:05:00.000Z",
    surface: "chatgpt_work",
    state: "pulse",
    agenticPoolCoupling: "shared_agentic_pool",
    planType: "pro",
    planVariant: "pro-20x",
  };
  try {
    const common = {
      startAt: "2026-07-24T11:59:00.000Z",
      endAt: "2026-07-24T12:10:00.000Z",
      codexHome: fixture.home,
      secret: SECRET,
      bundleId: BUNDLE_ID,
      createdAt: CREATED_AT,
    };
    const first = await buildLocalMetadataBundle({ ...common, activityMarkers: [marker] });
    const changed = await buildLocalMetadataBundle({
      ...common,
      activityMarkers: [{ ...marker, planVariant: "pro-5x", state: "start" }],
    });
    assert.equal(
      first.bundle.records.activityMarkers[0].markerId,
      changed.bundle.records.activityMarkers[0].markerId,
    );
    await assert.rejects(
      buildLocalMetadataBundle({ ...common, activityMarkers: [{ ...marker, markerId: null }] }),
      /persisted UUID/,
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});
