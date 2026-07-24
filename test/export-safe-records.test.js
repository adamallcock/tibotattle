import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCodexSafeRecords } from "../src/export-safe-records.js";
import { buildLocalMetadataBundle } from "../src/metadata-exporter.js";
import { createExportResourceGuard } from "../src/export-resource-policy.js";
import { stableJson } from "../src/storage.js";

const SECRET = Buffer.alloc(32, 37);
const START_AT = "2026-07-24T11:59:00.000Z";
const END_AT = "2026-07-24T12:10:00.000Z";

function tokenRecord() {
  return JSON.stringify({
    timestamp: "2026-07-24T12:02:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          cache_write_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 8,
          total_tokens: 120,
        },
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          cache_write_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 8,
          total_tokens: 120,
        },
        prompt: "PRIVATE_PROMPT_CANARY",
      },
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: { used_percent: 12.3, window_minutes: 300, resets_at: 1784912400 },
        secondary: { used_percent: 6.1, window_minutes: 10080, resets_at: 1785430800 },
      },
      response: "PRIVATE_RESPONSE_CANARY",
    },
  });
}

async function safeRecordFixture() {
  const home = await mkdtemp(join(tmpdir(), "app-usagemonitor-safe-records-"));
  await mkdir(join(home, "sessions"), { recursive: true });
  const lines = [
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "PRIVATE_SESSION_CANARY", source: "user", cwd: "/private/project" },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.001Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol", user_prompt: "PRIVATE_PROMPT_CANARY" },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:01:00.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", arguments: "PRIVATE_ARGUMENT_CANARY" },
    }),
    tokenRecord(),
  ];
  await writeFile(join(home, "sessions", "rollout-2026-07-24T12-00-00-safe.jsonl"), `${lines.join("\n")}\n`);
  return home;
}

function marker() {
  return {
    markerId: "019f9010-2222-7222-8222-222222222222",
    observedAt: "2026-07-24T12:05:00.000Z",
    surface: "chatgpt_work",
    state: "pulse",
    agenticPoolCoupling: "shared_agentic_pool",
    planType: "pro",
    planVariant: "pro-20x",
    accountScope: { status: "available", scopeId: "PRIVATE_ACCOUNT_CANARY" },
    content: "PRIVATE_MARKER_CANARY",
  };
}

function canonicalCollection(envelopes, diagnostics) {
  const usageEvents = envelopes
    .filter(({ recordType }) => recordType === "usageEvent")
    .map(({ record }) => record)
    .sort((left, right) => left.eventTime.localeCompare(right.eventTime) || left.eventId.localeCompare(right.eventId));
  const quotaSnapshots = [...new Map(envelopes
    .filter(({ recordType }) => recordType === "quotaSnapshot")
    .map(({ record }) => [record.snapshotId, record])).values()]
    .sort((left, right) => left.observedTime.localeCompare(right.observedTime) || left.snapshotId.localeCompare(right.snapshotId));
  const activityMarkers = envelopes
    .filter(({ recordType }) => recordType === "activityMarker")
    .map(({ record }) => record)
    .sort((left, right) => left.observedTime.localeCompare(right.observedTime) || left.markerId.localeCompare(right.markerId));
  return { records: { usageEvents, quotaSnapshots, activityMarkers }, diagnostics };
}

test("safe-record adapter emits validated metadata-only envelopes matching the legacy bundle bytes", async () => {
  const home = await safeRecordFixture();
  try {
    const envelopes = [];
    const guard = createExportResourceGuard();
    const scan = await scanCodexSafeRecords({
      startAt: START_AT,
      endAt: END_AT,
      codexHome: home,
      secret: SECRET,
      activityMarkers: [marker()],
      resourceGuard: guard,
      onRecord(envelope) {
        assert.equal(typeof envelope.recordType, "string");
        assert.equal(typeof envelope.record, "object");
        envelopes.push(envelope);
      },
    });
    const bundle = await buildLocalMetadataBundle({
      startAt: START_AT,
      endAt: END_AT,
      codexHome: home,
      secret: SECRET,
      activityMarkers: [marker()],
      bundleId: `bundle:v1:${"A".repeat(43)}`,
      createdAt: "2026-07-24T12:30:00.000Z",
    });

    assert.deepEqual(envelopes.map(({ recordType }) => recordType), [
      "quotaSnapshot", "quotaSnapshot", "usageEvent", "activityMarker",
    ]);
    assert.equal(guard.snapshot().counters.outputRecords, envelopes.length);
    assert.equal(
      stableJson(canonicalCollection(envelopes, scan.diagnostics)),
      stableJson({ records: bundle.bundle.records, diagnostics: bundle.bundle.diagnostics }),
    );
    const serialized = stableJson(envelopes);
    for (const canary of [
      "PRIVATE_PROMPT_CANARY", "PRIVATE_RESPONSE_CANARY", "PRIVATE_SESSION_CANARY",
      "PRIVATE_ARGUMENT_CANARY", "PRIVATE_ACCOUNT_CANARY", "PRIVATE_MARKER_CANARY",
    ]) {
      assert.equal(serialized.includes(canary), false, `safe-record sink received source content: ${canary}`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("safe-record adapter awaits asynchronous sinks before continuing extraction", async () => {
  const home = await safeRecordFixture();
  try {
    let active = 0;
    let maximumActive = 0;
    let completed = 0;
    await scanCodexSafeRecords({
      startAt: START_AT,
      endAt: END_AT,
      codexHome: home,
      secret: SECRET,
      async onRecord() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        completed += 1;
        active -= 1;
      },
    });
    assert.equal(completed, 3);
    assert.equal(maximumActive, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
