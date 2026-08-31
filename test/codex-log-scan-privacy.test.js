import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { localCodexLogScanner } from "../src/local-node-runtime.js";

const {
  codexLogSourceFingerprint,
  scanCodexLogEvents,
} = localCodexLogScanner;

const START_AT = "2000-01-01T00:00:00.000Z";
const END_AT = "2100-01-01T00:00:00.000Z";
const EVENT_AT = "2026-07-30T12:00:00.000Z";
const MODEL = "gpt-5.6-codex-privacy-test";
const SOURCE_SCOPE_ID = `session:v1:${"a".repeat(64)}`;

const RAW_CANARIES = Object.freeze({
  sessionId: "session-id-canary-31c48af4",
  parentId: "parent-id-canary-7bdf2091",
  cwd: "/Users/private/cwd-canary-059bc841",
  repo: "ssh://private.example/repo-canary-d85a3920.git",
  title: "title-canary-25ee4a91",
  prompt: "prompt-canary-e2064f5d",
  response: "response-canary-a0b395ec",
  toolInput: "tool-input-canary-cad72698",
  toolName: "private_tool_name_canary_f430b1de",
  callId: "call-id-canary-156ed54c",
  turnId: "turn-id-canary-685b2b47",
  threadSource: "automated_review_canary-a862d77c",
});

const USAGE_CALLBACK_KEYS = [
  "componentAvailability",
  "components",
  "model",
  "raw",
  "rawAvailability",
  "sourceRecordOrdinal",
  "sourceRolloutOrdinal",
  "sourceScopeId",
  "surfaceClassification",
  "tierSemantics",
  "timestamp",
];

const RATE_LIMIT_CALLBACK_KEYS = [
  "sourceRecordOrdinal",
  "sourceScopeId",
  "surfaceClassification",
  "timestamp",
  "timestampMs",
  "window",
];

const TOOL_CALLBACK_KEYS = [
  "model",
  "serverBillableUnit",
  "sourceKind",
  "sourceRecordOrdinal",
  "sourceScopeId",
  "surfaceClassification",
  "timestamp",
  "timestampMs",
  "toolClass",
];

function assertExactKeys(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function assertOmitsCanaries(value, canaries) {
  const serialized = JSON.stringify(value);
  for (const canary of canaries) {
    assert.equal(
      serialized.includes(canary),
      false,
      `serialized output exposed prohibited canary: ${canary}`,
    );
  }
}

async function privacyFixture() {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-absolute-path-canary-"));
  const archiveDirectory = join(codexHome, "archived_sessions");
  await mkdir(archiveDirectory, { recursive: true });
  const rolloutPath = join(
    archiveDirectory,
    "rollout-2026-07-30T12-00-00-basename-canary-f6d78c2e.jsonl",
  );
  const usage = {
    input_tokens: 12,
    cached_input_tokens: 3,
    cache_write_input_tokens: 2,
    output_tokens: 5,
    reasoning_output_tokens: 2,
    total_tokens: 17,
  };
  const records = [
    {
      timestamp: EVENT_AT,
      type: "session_meta",
      payload: {
        id: RAW_CANARIES.sessionId,
        forked_from_id: RAW_CANARIES.parentId,
        cwd: RAW_CANARIES.cwd,
        repository: RAW_CANARIES.repo,
        title: RAW_CANARIES.title,
        source_path: rolloutPath,
        source_basename: basename(rolloutPath),
        origin: "terminal",
        thread_source: RAW_CANARIES.threadSource,
      },
    },
    {
      timestamp: EVENT_AT,
      type: "turn_context",
      payload: {
        model: MODEL,
        turn_id: RAW_CANARIES.turnId,
        cwd: RAW_CANARIES.cwd,
        repository: RAW_CANARIES.repo,
        title: RAW_CANARIES.title,
      },
    },
    {
      timestamp: EVENT_AT,
      type: "event_msg",
      payload: {
        type: "user_message",
        message: RAW_CANARIES.prompt,
      },
    },
    {
      timestamp: EVENT_AT,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: RAW_CANARIES.response }],
      },
    },
    {
      timestamp: EVENT_AT,
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: RAW_CANARIES.turnId,
      },
    },
    {
      timestamp: EVENT_AT,
      type: "response_item",
      payload: {
        type: "function_call",
        name: RAW_CANARIES.toolName,
        arguments: JSON.stringify({ secret: RAW_CANARIES.toolInput }),
        input: RAW_CANARIES.toolInput,
        call_id: RAW_CANARIES.callId,
        id: `provider-${RAW_CANARIES.callId}`,
        turn_id: RAW_CANARIES.turnId,
      },
    },
    {
      timestamp: EVENT_AT,
      type: "event_msg",
      payload: {
        type: "token_count",
        turn_id: RAW_CANARIES.turnId,
        prompt: RAW_CANARIES.prompt,
        response: RAW_CANARIES.response,
        info: {
          total_token_usage: usage,
          last_token_usage: usage,
        },
        rate_limits: {
          limit_id: "codex",
          plan_type: "plus",
          primary: {
            used_percent: 33,
            window_minutes: 300,
            resets_at: 1_785_430_800,
          },
        },
      },
    },
    {
      timestamp: EVENT_AT,
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: RAW_CANARIES.turnId,
      },
    },
  ];
  await writeFile(rolloutPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return {
    codexHome,
    rolloutPath,
    rolloutBasename: basename(rolloutPath),
  };
}

test("raw Codex scan callbacks and result retain accounting semantics without exposing source content", async () => {
  const fixture = await privacyFixture();
  try {
    // The fork-parent canary must resolve to a real (content-free) rollout:
    // an unresolvable inline-fork parent now fails accounting closed by
    // design, and this test is probing privacy, not orphan-fork semantics.
    await writeFile(
      join(fixture.codexHome, "archived_sessions", "rollout-2026-07-30T11-00-00-parent-canary.jsonl"),
      `${JSON.stringify({
        timestamp: EVENT_AT,
        type: "session_meta",
        payload: { id: RAW_CANARIES.parentId },
      })}\n`,
    );
    const usageEvents = [];
    const rateLimitSnapshots = [];
    const toolCalls = [];
    const result = await scanCodexLogEvents({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
      sourceScopeForRollout: () => SOURCE_SCOPE_ID,
      onUsage: (event) => usageEvents.push(event),
      onRateLimitSnapshot: (snapshot) => rateLimitSnapshots.push(snapshot),
      onToolCall: (toolCall) => toolCalls.push(toolCall),
    });

    assert.equal(usageEvents.length, 1);
    assert.equal(rateLimitSnapshots.length, 1);
    assert.equal(toolCalls.length, 1);
    assertExactKeys(usageEvents[0], USAGE_CALLBACK_KEYS);
    assertExactKeys(rateLimitSnapshots[0], RATE_LIMIT_CALLBACK_KEYS);
    assertExactKeys(toolCalls[0], TOOL_CALLBACK_KEYS);

    assert.equal(usageEvents[0].model, MODEL);
    assert.equal(toolCalls[0].model, MODEL);
    assert.equal(usageEvents[0].sourceScopeId, SOURCE_SCOPE_ID);
    assert.equal(rateLimitSnapshots[0].sourceScopeId, SOURCE_SCOPE_ID);
    assert.equal(toolCalls[0].sourceScopeId, SOURCE_SCOPE_ID);
    assert.deepEqual(usageEvents[0].components, {
      input_uncached_tokens: 7,
      input_cache_read_tokens: 3,
      input_cache_write_tokens: 2,
      output_text_tokens: 3,
      output_reasoning_tokens: 2,
    });
    assert.equal(rateLimitSnapshots[0].window.usedPercent, 33);
    assert.equal(toolCalls[0].toolClass, "other");
    assert.equal(toolCalls[0].sourceKind, "client_function_call");
    assert.deepEqual(result.toolCallsByClass, { other: 1 });
    assert.deepEqual(usageEvents[0].surfaceClassification, {
      schemaVersion: "0.1",
      threadSource: "unknown",
      surface: "cli_exec",
      agentScope: "unknown",
      lineageDisposition: "forked",
    });
    assert.deepEqual(
      rateLimitSnapshots[0].surfaceClassification,
      usageEvents[0].surfaceClassification,
    );
    assert.deepEqual(
      toolCalls[0].surfaceClassification,
      usageEvents[0].surfaceClassification,
    );

    const prohibited = [
      fixture.codexHome,
      fixture.rolloutPath,
      fixture.rolloutBasename,
      ...Object.values(RAW_CANARIES),
    ];
    assertOmitsCanaries(usageEvents, prohibited);
    assertOmitsCanaries(rateLimitSnapshots, prohibited);
    assertOmitsCanaries(toolCalls, prohibited);
    assertOmitsCanaries(result, prohibited);
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});

test("Codex source fingerprints are path-free by default and opt in only to the local source mapping", async () => {
  const fixture = await privacyFixture();
  try {
    const pathFree = await codexLogSourceFingerprint({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    const localOnly = await codexLogSourceFingerprint({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
      includeSourcePaths: true,
    });

    assertExactKeys(pathFree, [
      "fileCount",
      "files",
      "fingerprint",
      "maxMtimeMs",
      "schemaVersion",
      "totalSizeBytes",
    ]);
    assert.equal(Object.hasOwn(pathFree, "sourcePathByKeyHash"), false);
    assert.equal(pathFree.files.length, 1);

    assertExactKeys(localOnly, [
      "fileCount",
      "files",
      "fingerprint",
      "maxMtimeMs",
      "schemaVersion",
      "sourcePathByKeyHash",
      "totalSizeBytes",
    ]);
    const { sourcePathByKeyHash, ...pathFreeLocalOnly } = localOnly;
    assert.deepEqual(pathFreeLocalOnly, pathFree);
    assert.deepEqual(sourcePathByKeyHash, {
      [pathFree.files[0].keyHash]: fixture.rolloutPath,
    });

    const allCanaries = [
      fixture.codexHome,
      fixture.rolloutPath,
      fixture.rolloutBasename,
      ...Object.values(RAW_CANARIES),
    ];
    assertOmitsCanaries(pathFree, allCanaries);
    assertOmitsCanaries(localOnly, Object.values(RAW_CANARIES));
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});
