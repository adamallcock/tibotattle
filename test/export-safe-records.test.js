import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeActivityMarker,
  normalizeClaudeStatusQuotaSnapshots,
  normalizeCodexCollectorQuotaCandidate,
  normalizeCodexQuotaSnapshot,
  scanCodexSafeRecords,
  summarizeActivityMarkerPlan,
} from "../src/export-safe-records.js";
import { buildLocalMetadataBundle } from "../src/metadata-exporter.js";
import { createExportResourceGuard } from "../src/export-resource-policy.js";
import { stableJson } from "../src/storage.js";

const SECRET = Buffer.alloc(32, 37);
const CLAUDE_OCCURRENCE = `claude-ledger-occurrence:v1:${"G".repeat(43)}`;
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

function collectorCandidate(overrides = {}) {
  return {
    candidateVersion: "codex-collector-quota-candidate-v0.1",
    kind: "quota_snapshot_candidate",
    provider: "openai_codex",
    observedTime: "2026-07-24T12:02:00.000Z",
    receivedTime: "2026-07-24T12:02:01.000Z",
    source: "app_server_read",
    planType: "pro",
    limitId: "codex",
    slot: "secondary",
    usedPercent: 12.3,
    displayPrecision: 1,
    windowDurationMinutes: 10_080,
    resetsAt: "2026-07-31T12:00:00.000Z",
    sharedPoolSurface: "account_shared_unallocated",
    accountScopeSubject: `openai-account:v1:${"A".repeat(43)}`,
    sessionScopeId: null,
    observationIdentityMaterial: "b".repeat(64),
    ...overrides,
  };
}

function claudeStatus(overrides = {}) {
  return {
    schemaVersion: "0.2",
    kind: "claude_rate_limit_snapshot",
    provider: "anthropic_claude_code",
    capturedAt: "2026-07-24T12:02:00.000Z",
    clientVersion: "2.1.0",
    modelId: "claude_opus",
    fastMode: false,
    sessionPseudonym: `claude-session:v1:${"C".repeat(43)}`,
    limits: {
      fiveHour: { windowMinutes: 300, usedPercent: 8.4, resetsAt: 1_785_000_000 },
      sevenDay: { windowMinutes: 10_080, usedPercent: 19, resetsAt: 1_785_500_000 },
    },
    privacy: {
      rawSessionIdentifierStored: false,
      transcriptPathStored: false,
      workspaceStored: false,
      conversationContentStored: false,
      accountIdentifierStored: false,
      repositoryMetadataStored: false,
    },
    ...overrides,
  };
}

test("safe-record adapter preserves scanner-release order while its canonical bundle matches legacy bytes", async () => {
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
      bundleId: `bundle:v1:${"a".repeat(64)}`,
      createdAt: "2026-07-24T12:30:00.000Z",
    });

    assert.deepEqual(envelopes.map(({ recordType }) => recordType), [
      // Leading quota snapshots are deliberately held until the parser has
      // accepted a real usage record; this is the scanner's streaming order,
      // while the bundle comparison below remains canonicalized.
      "usageEvent", "quotaSnapshot", "quotaSnapshot", "activityMarker",
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

test("activity-marker planning rejects an oversized input before normalization or dedupe", () => {
  const outOfWindow = {
    ...marker(),
    observedAt: "2020-01-01T00:00:00.000Z",
  };
  assert.throws(
    () => summarizeActivityMarkerPlan(SECRET, [outOfWindow, outOfWindow], {
      startMs: Date.parse(START_AT),
      endMs: Date.parse(END_AT),
    }, { maximumRecords: 1 }),
    (error) => error.code === "export_resource_output_records",
  );
});

test("collector candidates normalize deterministically without exporting source identity material", () => {
  const candidate = collectorCandidate();
  const first = normalizeCodexCollectorQuotaCandidate(SECRET, candidate);
  const repeat = normalizeCodexCollectorQuotaCandidate(SECRET, structuredClone(candidate));
  assert.deepEqual(first, repeat);
  assert.equal(first.sessionScopeId, null);
  assert.match(first.accountScopeId, /^account:v1:[a-f0-9]{64}$/);
  assert.equal(first.snapshotSource, "app_server_read");
  const serialized = stableJson(first);
  assert.equal(serialized.includes(candidate.accountScopeSubject), false);
  assert.equal(serialized.includes(candidate.observationIdentityMaterial), false);

  const notification = normalizeCodexCollectorQuotaCandidate(SECRET, collectorCandidate({
    source: "app_server_notification",
    observationIdentityMaterial: "f".repeat(64),
  }));
  assert.equal(notification.snapshotSource, "notification");
});

test("safe plan normalization retains prolite and fails closed for arbitrary identifiers", () => {
  const quotaEvent = (planType) => normalizeCodexQuotaSnapshot(SECRET, {
    timestamp: "2026-07-24T12:02:00.000Z",
    sourceScopeId: `session:v1:${"a".repeat(64)}`,
    window: {
      limitId: "codex",
      planType,
      slot: "secondary",
      usedPercent: 12.3,
      windowDurationMins: 10_080,
      resetsAt: 1_785_430_800,
    },
  });
  assert.equal(quotaEvent("prolite").planType, "prolite");
  assert.equal(quotaEvent("arbitrary-plan-name").planType, "unknown");

  const bounds = {
    startMs: Date.parse(START_AT),
    endMs: Date.parse(END_AT),
  };
  assert.equal(
    normalizeActivityMarker(SECRET, { ...marker(), planType: "prolite" }, bounds).planType,
    "prolite",
  );
  assert.equal(
    normalizeActivityMarker(SECRET, { ...marker(), planType: "arbitrary-plan-name" }, bounds).planType,
    "unknown",
  );
});

test("sessionless unattributed collector states cannot collapse across distinct observations", () => {
  const first = normalizeCodexCollectorQuotaCandidate(SECRET, collectorCandidate({
    accountScopeSubject: "unattributed",
    observationIdentityMaterial: "d".repeat(64),
  }));
  const repeat = normalizeCodexCollectorQuotaCandidate(SECRET, collectorCandidate({
    accountScopeSubject: "unattributed",
    observationIdentityMaterial: "d".repeat(64),
  }));
  const distinct = normalizeCodexCollectorQuotaCandidate(SECRET, collectorCandidate({
    accountScopeSubject: "unattributed",
    observationIdentityMaterial: "e".repeat(64),
  }));
  assert.equal(first.accountScopeId, "unattributed");
  assert.equal(first.providerStateId, repeat.providerStateId);
  assert.notEqual(first.snapshotId, distinct.snapshotId);
  assert.notEqual(first.providerStateId, distinct.providerStateId);
});

test("collector candidate normalization rejects unknown fields and session-scoped inputs", () => {
  assert.throws(
    () => normalizeCodexCollectorQuotaCandidate(SECRET, { ...collectorCandidate(), content: "private" }),
    /Invalid privacy-safe collector quota candidate/,
  );
  assert.throws(
    () => normalizeCodexCollectorQuotaCandidate(SECRET, collectorCandidate({
      sessionScopeId: `session:v1:${"f".repeat(64)}`,
    })),
    /Invalid privacy-safe collector quota candidate/,
  );
});

test("Claude status quota normalization is deterministic and requires a session pseudonym", () => {
  const first = normalizeClaudeStatusQuotaSnapshots(SECRET, claudeStatus(), {
    physicalOccurrenceMaterial: CLAUDE_OCCURRENCE,
  });
  const repeat = normalizeClaudeStatusQuotaSnapshots(SECRET, claudeStatus(), {
    physicalOccurrenceMaterial: CLAUDE_OCCURRENCE,
  });
  assert.deepEqual(first, repeat);
  assert.deepEqual(first.map((snapshot) => snapshot.slot), ["five_hour", "seven_day"]);
  assert.ok(first.every((snapshot) => snapshot.snapshotSource === "status_line"));
  assert.ok(first.every((snapshot) => /^session:v1:[a-f0-9]{64}$/.test(snapshot.sessionScopeId)));
  assert.notEqual(first[0].snapshotId, first[1].snapshotId);
  assert.throws(
    () => normalizeClaudeStatusQuotaSnapshots(SECRET, claudeStatus({ sessionPseudonym: null }), {
      physicalOccurrenceMaterial: CLAUDE_OCCURRENCE,
    }),
    /requires a privacy-safe session pseudonym/,
  );
  assert.throws(
    () => normalizeClaudeStatusQuotaSnapshots(SECRET, claudeStatus()),
    /requires privacy-safe physical occurrence material/,
  );
});

test("windowless Claude status records emit no snapshots without requiring identity material", () => {
  const snapshots = normalizeClaudeStatusQuotaSnapshots(SECRET, claudeStatus({
    sessionPseudonym: null,
    limits: { fiveHour: null, sevenDay: null },
  }));
  assert.deepEqual(snapshots, []);
});

test("distinct Claude physical records cannot collapse to one observation identity", () => {
  const first = normalizeClaudeStatusQuotaSnapshots(SECRET, claudeStatus(), {
    physicalOccurrenceMaterial: `claude-ledger-occurrence:v1:${"H".repeat(43)}`,
  });
  const second = normalizeClaudeStatusQuotaSnapshots(SECRET, claudeStatus(), {
    physicalOccurrenceMaterial: `claude-ledger-occurrence:v1:${"I".repeat(43)}`,
  });
  assert.notEqual(first[0].snapshotId, second[0].snapshotId);
  assert.equal(stableJson(first).includes("claude-ledger-occurrence"), false);
  assert.equal(stableJson(second).includes("claude-ledger-occurrence"), false);
});
