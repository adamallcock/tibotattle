import test from "node:test";
import assert from "node:assert/strict";
import { localSafeRecords } from "../src/local-node-runtime.js";
import { stableJson } from "../src/storage.js";
import { createCodexLogIngestion } from "../src/providers/codex/log-ingestion.js";
import { createCodexLogParser } from "../src/providers/codex/log-parser.js";

const {
  createEmptySafeToolClassCounts,
  normalizeCodexUsageEvent,
  normalizeCodexQuotaSnapshot,
  quotaObservationIdentitySubject,
  safeExportModelDeclaration,
  safeToolCountFieldForScannerToolClass,
  usageEventIdentitySubject,
} = localSafeRecords;

const SECRET = Buffer.alloc(32, 9);

function usageEvent(overrides = {}) {
  return {
    timestamp: "2026-07-24T12:00:00.000Z",
    model: "gpt-5.6-sol",
    raw: {
      input_tokens: 120,
      cached_input_tokens: 20,
      cache_write_input_tokens: 0,
      output_tokens: 30,
      reasoning_output_tokens: 8,
      total_tokens: 150,
    },
    rawAvailability: {
      input_tokens: true,
      cached_input_tokens: true,
      cache_write_input_tokens: true,
      output_tokens: true,
      reasoning_output_tokens: true,
      total_tokens: true,
    },
    components: {
      input_uncached_tokens: 100,
      input_cache_read_tokens: 20,
      input_cache_write_tokens: 0,
      output_text_tokens: 22,
      output_reasoning_tokens: 8,
    },
    componentAvailability: {
      input_uncached_tokens: true,
      input_cache_read_tokens: true,
      input_cache_write_tokens: true,
      output_text_tokens: true,
      output_reasoning_tokens: true,
    },
    tierSemantics: {
      billingSurface: "chatgpt_subscription",
      codexSpeedMode: "fast",
      apiServiceTier: "priority",
    },
    surfaceClassification: {
      surface: "local_rollout_unclassified",
      agentScope: "root",
      lineageDisposition: "standalone",
    },
    sourceScopeId: `session:v1:${"9".repeat(64)}`,
    sourceRecordOrdinal: 17,
    ...overrides,
  };
}

function checkpointUsageEvent(modelDeclaration) {
  const event = usageEvent({ modelDeclaration });
  delete event.model;
  return event;
}

function quotaEvent(overrides = {}) {
  return {
    ...usageEvent(),
    window: {
      limitId: "codex",
      slot: "primary",
      planType: "plus",
      usedPercent: 30,
      windowDurationMins: 300,
      resetsAt: 1_785_430_800,
    },
    ...overrides,
  };
}

test("checkpoint model declaration produces byte-identical normalized usage to raw-model mode", () => {
  const raw = usageEvent({ model: "private model /Users/alice/private-project" });
  const declaration = safeExportModelDeclaration(SECRET, raw.model);
  const checkpoint = checkpointUsageEvent(declaration);

  const rawRecord = normalizeCodexUsageEvent(SECRET, raw);
  const checkpointRecord = normalizeCodexUsageEvent(SECRET, checkpoint);
  assert.equal(stableJson(checkpointRecord), stableJson(rawRecord));
  assert.equal(checkpointRecord.modelId, "unknown");
  assert.match(checkpointRecord.modelFingerprint, /^model:v1:/);
  assert.equal(stableJson(checkpointRecord).includes(raw.model), false);
});

test("recognized declarations and raw recognized models retain parity", () => {
  const raw = normalizeCodexUsageEvent(SECRET, usageEvent());
  const event = checkpointUsageEvent(safeExportModelDeclaration(SECRET, "gpt-5.6-sol"));
  const checkpoint = normalizeCodexUsageEvent(SECRET, event);
  assert.equal(stableJson(checkpoint), stableJson(raw));
  assert.deepEqual(checkpoint.modelFingerprint, null);
});

test("safe tool counters are fresh, fixed shape, and collapse unknown scanner classes", () => {
  const first = createEmptySafeToolClassCounts();
  const second = createEmptySafeToolClassCounts();
  first.localShell = 4;
  assert.equal(second.localShell, 0);
  assert.deepEqual(Object.keys(first), [
    "webSearch", "fileSearch", "codeInterpreter", "hostedShell", "computerUse", "mcp",
    "applyPatch", "localShell", "subagent", "toolGateway", "other", "unknown",
  ]);
  assert.equal(safeToolCountFieldForScannerToolClass("web_search"), "webSearch");
  assert.equal(safeToolCountFieldForScannerToolClass("local_shell"), "localShell");
  assert.equal(safeToolCountFieldForScannerToolClass("tool_gateway"), "toolGateway");
  assert.equal(safeToolCountFieldForScannerToolClass("PRIVATE_TOOL_NAME_CANARY"), "unknown");
  assert.equal(safeToolCountFieldForScannerToolClass(null), "unknown");
});

test("invalid checkpoint declarations and ambiguous raw-model input fail without echoing", () => {
  const canary = "PRIVATE_RAW_MODEL_CANARY";
  const invalidCases = [
    checkpointUsageEvent({ ...safeExportModelDeclaration(SECRET, "gpt-5.6-sol"), rawProviderModel: canary }),
    checkpointUsageEvent({ modelId: "unknown", modelRecognition: "unrecognized", modelFingerprint: canary }),
    usageEvent({ model: canary, modelDeclaration: safeExportModelDeclaration(SECRET, "gpt-5.6-sol") }),
  ];
  for (const event of invalidCases) {
    let error;
    try {
      normalizeCodexUsageEvent(SECRET, event);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.match(String(error), /Invalid privacy-safe model declaration/);
    assert.equal(String(error).includes(canary), false);
  }
});

test("legacy usage and quota occurrence subjects retain their exact v1 shape", () => {
  const expected = {
    identityVersion: "codex-source-occurrence-v1",
    provider: "openai_codex",
    sourceFormat: "codex-rollout-jsonl",
    sourceScopeId: usageEvent().sourceScopeId,
    sourceRecordOrdinal: 17,
    recordKind: "token_count",
  };
  assert.deepEqual(usageEventIdentitySubject(usageEvent()), expected);
  assert.deepEqual(quotaObservationIdentitySubject(quotaEvent(), "primary"), {
    ...expected,
    recordKind: "rate_limit_snapshot",
    slot: "primary",
  });
});

test("paginated usage and quota v2 occurrences separate physical resets but retain the logical session", () => {
  const firstScope = `session:v1:${"a".repeat(64)}`;
  const secondScope = `session:v1:${"b".repeat(64)}`;
  const firstEvent = usageEvent({ sourceOccurrenceScopeId: firstScope });
  const subject = usageEventIdentitySubject(firstEvent);
  assert.deepEqual(subject, {
    identityVersion: "codex-source-occurrence-v2",
    provider: "openai_codex",
    sourceFormat: "codex-rollout-jsonl",
    sourceScopeId: firstEvent.sourceScopeId,
    sourceOccurrenceScopeId: firstScope,
    sourceRecordOrdinal: 17,
    recordKind: "token_count",
  });
  assert.deepEqual(quotaObservationIdentitySubject(firstEvent, "primary"), {
    ...subject,
    recordKind: "rate_limit_snapshot",
    slot: "primary",
  });
  const firstUsage = normalizeCodexUsageEvent(SECRET, firstEvent);
  const secondUsage = normalizeCodexUsageEvent(SECRET, usageEvent({ sourceOccurrenceScopeId: secondScope }));
  assert.notEqual(firstUsage.eventId, secondUsage.eventId);
  assert.notEqual(firstUsage.eventId, normalizeCodexUsageEvent(SECRET, usageEvent()).eventId);
  assert.deepEqual(firstUsage, normalizeCodexUsageEvent(SECRET, firstEvent));
  assert.deepEqual({ ...firstUsage, eventId: secondUsage.eventId }, secondUsage);
  assert.equal(firstUsage.sessionScopeId, firstEvent.sourceScopeId);
  assert.equal(Object.hasOwn(firstUsage, "sourceOccurrenceScopeId"), false);

  const firstQuota = normalizeCodexQuotaSnapshot(SECRET, quotaEvent({ sourceOccurrenceScopeId: firstScope }));
  const secondQuota = normalizeCodexQuotaSnapshot(SECRET, quotaEvent({ sourceOccurrenceScopeId: secondScope }));
  assert.notEqual(firstQuota.snapshotId, secondQuota.snapshotId);
  assert.notEqual(firstQuota.snapshotId, normalizeCodexQuotaSnapshot(SECRET, quotaEvent()).snapshotId);
  assert.deepEqual(firstQuota, normalizeCodexQuotaSnapshot(SECRET, quotaEvent({ sourceOccurrenceScopeId: firstScope })));
  assert.deepEqual({ ...firstQuota, snapshotId: secondQuota.snapshotId }, secondQuota);
  assert.equal(firstQuota.providerStateId, secondQuota.providerStateId);
  assert.equal(firstQuota.sessionScopeId, firstEvent.sourceScopeId);
  assert.equal(Object.hasOwn(firstQuota, "sourceOccurrenceScopeId"), false);
});

test("malformed optional occurrence scopes fail closed without evaluating accessors or echoing input", () => {
  const canary = "PRIVATE_PHYSICAL_SOURCE_CANARY";
  for (const value of [undefined, null, 9, {}, "", canary, `session:v1:${"A".repeat(64)}`,
    `session:v1:${"a".repeat(65)}`]) {
    for (const [normalize, event] of [
      [normalizeCodexUsageEvent, usageEvent({ sourceOccurrenceScopeId: value })],
      [normalizeCodexQuotaSnapshot, quotaEvent({ sourceOccurrenceScopeId: value })],
    ]) {
      assert.throws(() => normalize(SECRET, event), {
        name: "TypeError",
        message: "Invalid privacy-safe source occurrence scope",
      });
    }
  }
  const event = usageEvent();
  let accessorCalls = 0;
  Object.defineProperty(event, "sourceOccurrenceScopeId", {
    get() { accessorCalls += 1; throw new Error(canary); },
  });
  assert.throws(() => usageEventIdentitySubject(event), {
    name: "TypeError", message: "Invalid privacy-safe source occurrence scope",
  });
  assert.equal(accessorCalls, 0);
});

function occurrenceScannerFixture(historyMode = "paginated") {
  const rawPhysicalIdentity = "PRIVATE_PHYSICAL_SOURCE_CANARY";
  const rawSessionId = "PRIVATE_LOGICAL_SESSION_CANARY";
  const timestamp = usageEvent().timestamp;
  const records = [
    { type: "session_meta", timestamp, payload: { id: rawSessionId } },
    { type: "turn_context", timestamp, payload: { model: "gpt-5.6-sol" } },
    { type: "response_item", timestamp, payload: { type: "function_call", name: "shell_command" } },
    { type: "event_msg", timestamp, payload: {
      type: "token_count",
      info: { last_token_usage: usageEvent().raw },
      rate_limits: { limit_id: "codex", plan_type: "plus", primary: {
        used_percent: 30, window_minutes: 300, resets_at: 1_785_430_800,
      } },
    } },
  ].map((record) => JSON.stringify(record));
  const info = {
    path: records,
    location: "archived",
    size: records.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0),
    sourceIdentity: rawPhysicalIdentity,
    rolloutKey: "PRIVATE_ROLLOUT_KEY_CANARY",
    mtimeMs: Date.parse(timestamp),
    lineage: { sessionId: rawSessionId, historyMode, historyBase: null, isInlineFork: false },
  };
  const scan = createCodexLogIngestion({
    parserVersion: "test",
    sources: {
      codexRolloutDiscoveryReceipt: () => ({ status: "complete", reasonCounts: {} }),
      summarizeCodexRolloutSources: () => ({}),
    },
    parser: createCodexLogParser({ lineReader: {
      async *readBoundedUtf8Lines(source) { yield* source; },
    } }),
  });
  return {
    scan,
    rawPhysicalIdentity,
    options: {
      startAt: "2026-07-24T00:00:00.000Z",
      endAt: "2026-07-25T00:00:00.000Z",
      rolloutInfos: [info],
      sourceScopeForRollout: () => usageEvent().sourceScopeId,
    },
  };
}

test("scanner propagates only validated optional physical pseudonyms to usage, quota, and tool events", async () => {
  const fixture = occurrenceScannerFixture();
  const occurrenceScope = `session:v1:${"c".repeat(64)}`;
  const observed = { usage: [], quota: [], tool: [] };
  let callbackCalls = 0;
  await fixture.scan({
    ...fixture.options,
    sourceOccurrenceScopeForRollout(subject) {
      callbackCalls += 1;
      assert.equal(subject, fixture.rawPhysicalIdentity);
      return occurrenceScope;
    },
    onUsage: (event) => observed.usage.push(event),
    onRateLimitSnapshot: (event) => observed.quota.push(event),
    onToolCall: (event) => observed.tool.push(event),
  });
  assert.equal(callbackCalls, 1);
  for (const events of Object.values(observed)) {
    assert.equal(events.length, 1);
    assert.equal(events[0].sourceOccurrenceScopeId, occurrenceScope);
    assert.equal(events[0].sourceScopeId, usageEvent().sourceScopeId);
  }
  assert.equal(JSON.stringify(observed).includes("PRIVATE_"), false);
});

test("scanner occurrence callback remains optional and leaves legacy callbacks unchanged", async () => {
  for (const [historyMode, callback] of [["paginated", null], ["inline", () => {
    throw new Error("legacy source must not request a physical scope");
  }]]) {
    const fixture = occurrenceScannerFixture(historyMode);
    const events = [];
    await fixture.scan({
      ...fixture.options,
      ...(callback === null ? {} : { sourceOccurrenceScopeForRollout: callback }),
      onUsage: (event) => events.push(event),
      onRateLimitSnapshot: (event) => events.push(event),
      onToolCall: (event) => events.push(event),
    });
    assert.equal(events.length, 3);
    assert.equal(events.some((event) => Object.hasOwn(event, "sourceOccurrenceScopeId")), false);
  }
});

test("scanner awaits an asynchronous occurrence pseudonym before emitting events", async () => {
  const fixture = occurrenceScannerFixture();
  const occurrenceScope = `session:v1:${"d".repeat(64)}`;
  const events = [];
  let callbackCalls = 0;
  await fixture.scan({
    ...fixture.options,
    async sourceOccurrenceScopeForRollout(subject) {
      callbackCalls += 1;
      assert.equal(subject, fixture.rawPhysicalIdentity);
      return occurrenceScope;
    },
    onUsage: (event) => events.push(event),
    onRateLimitSnapshot: (event) => events.push(event),
    onToolCall: (event) => events.push(event),
  });
  assert.equal(callbackCalls, 1);
  assert.equal(events.length, 3);
  assert.equal(events.every((event) => event.sourceOccurrenceScopeId === occurrenceScope), true);
  assert.equal(JSON.stringify(events).includes("PRIVATE_"), false);
});

test("scanner rejects malformed optional occurrence callbacks and pseudonyms with fixed errors", async () => {
  const fixture = occurrenceScannerFixture();
  for (const value of [undefined, null, 9, {}, "", "PRIVATE_SOURCE_CANARY",
    `session:v1:${"A".repeat(64)}`, `session:v1:${"a".repeat(65)}`]) {
    await assert.rejects(fixture.scan({
      ...fixture.options,
      sourceOccurrenceScopeForRollout: () => value,
    }), {
      message: "sourceOccurrenceScopeForRollout must return a versioned privacy-safe pseudonym",
    });
  }
  await assert.rejects(fixture.scan({
    ...fixture.options,
    sourceOccurrenceScopeForRollout: "PRIVATE_CALLBACK_CANARY",
  }), {
    name: "TypeError",
    message: "sourceOccurrenceScopeForRollout must be a function or null",
  });
  await assert.rejects(fixture.scan({
    ...fixture.options,
    sourceOccurrenceScopeForRollout() { throw new Error("PRIVATE_CALLBACK_INPUT_CANARY"); },
  }), {
    message: "sourceOccurrenceScopeForRollout must return a versioned privacy-safe pseudonym",
  });
  await assert.rejects(fixture.scan({
    ...fixture.options,
    async sourceOccurrenceScopeForRollout() { throw new Error("PRIVATE_ASYNC_CALLBACK_INPUT_CANARY"); },
  }), {
    message: "sourceOccurrenceScopeForRollout must return a versioned privacy-safe pseudonym",
  });
});
