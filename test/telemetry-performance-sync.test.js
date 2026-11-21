import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import {
  buildPerformanceHistogram,
} from "@app-usagemonitor/telemetry-contract";
import {
  initialTelemetryPerformanceSyncState,
  parseTelemetryPerformanceSyncState,
  resumeTelemetryPerformanceSyncAfterAuthorization,
  prepareTelemetryPerformanceDay,
  runTelemetryPerformanceSync,
} from "../src/contribution/telemetry-performance-sync.js";
import { createTelemetryPerformanceClient, createTelemetryPerformanceScheduler } from "../src/application/index.js";
import {
  createTelemetryPerformanceEnvelope,
  validateTelemetryPerformanceEnvelope,
} from "../src/platform/telemetry-performance-envelope.js";

globalThis.crypto ??= webcrypto;

const DAY = "2026-09-21";
const DIGEST = "a".repeat(64);

test("renewed performance authorization preserves progress and rechecks the hosted capability", async () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");
  for (const reason of ["authorization_rejected", "response_invalid"]) {
    const previous = { ...initialTelemetryPerformanceSyncState(), cursorDay: DAY,
      lastReportRevision: DIGEST, paused: true, pausedReason: reason, retryCount: 3,
      lastAttemptAt: new Date(now - 1_000).toISOString(),
      lastOutcome: { at: new Date(now - 1_000).toISOString(), code: reason, status: "paused" } };
    const resumed = resumeTelemetryPerformanceSyncAfterAuthorization(previous);
    assert.equal(resumed.paused, false);
    assert.equal(resumed.retryCount, 0);
    assert.equal(resumed.cursorDay, previous.cursorDay);
    assert.equal(resumed.lastReportRevision, previous.lastReportRevision);
    assert.deepEqual(resumed.lastOutcome, previous.lastOutcome);
    assert.equal(previous.paused, true);
    const common = { day: DAY, nowEpoch: now, state: JSON.parse(JSON.stringify(resumed)),
      prepareDay: () => assert.fail("an obsolete grant must not prepare data"),
      createEnvelope: () => assert.fail("an obsolete grant must not encrypt data"),
      send: () => assert.fail("an obsolete grant must not upload") };
    const oldCapability = capability(now);
    oldCapability.requiredConsent.fieldDictionaryVersion = "telemetry-performance-registry-2026-09-21.1";
    const rejected = await runTelemetryPerformanceSync({ ...common, readCapabilities: async () => oldCapability });
    assert.equal(rejected.state.pausedReason, "response_invalid");
    assert.equal(rejected.state.cursorDay, DAY);
    const accepted = await runTelemetryPerformanceSync({ ...common,
      state: resumeTelemetryPerformanceSyncAfterAuthorization(rejected.state),
      readCapabilities: async () => capability(now), prepareDay: () => report(),
      createEnvelope: async ({ report }) => ({ report }), send: async ({ report: sent }) => ({ status: 202, receipt: reportReceipt(sent) }) });
    assert.equal(accepted.status, "succeeded");
  }
  for (const reason of ["global_paused", "device_disconnected", "report_invalid", "upload_rejected", "user_opt_out"]) {
    const state = { ...initialTelemetryPerformanceSyncState(), paused: true, pausedReason: reason };
    assert.deepEqual(resumeTelemetryPerformanceSyncAfterAuthorization(state), state);
  }
  assert.throws(() => resumeTelemetryPerformanceSyncAfterAuthorization({ paused: true }),
    error => error.code === "telemetry_performance_state_invalid");
});

function record(overrides = {}) {
  return {
    schemaVersion: "model-performance-daily-v1",
    day: DAY,
    provider: "openai_codex",
    modelId: "gpt-5.6-luna",
    reasoningEffort: "high",
    speedMethod: "receipt",
    speedMode: "standard",
    speedModeSource: "rollout_thread_settings",
    apiServiceTier: "unknown",
    measurementVersion: "model-performance-samples-v1",
    bucketSchemeVersion: "performance-histogram-v1",
    turns: 1,
    speedTurns: 1,
    ttftTurns: 1,
    completionTurns: 1,
    timedResponses: 1,
    speedTokens: 100,
    speedDurationMs: 1_000,
    speedHistogram: buildPerformanceHistogram("speed", [100]),
    ttftHistogram: buildPerformanceHistogram("ttft", [100]),
    completionHistogram: buildPerformanceHistogram("turnDuration", [1_000]),
    ...overrides,
  };
}

async function report(records = [record()], day = DAY) {
  return prepareTelemetryPerformanceDay({
    records,
    day,
    sourceGeneration: "source:v1:fixture",
    sourceDigest: DIGEST,
    sourceRevision: 3,
    parserVersion: "codex-parser-v17",
  });
}

function reportReceipt(report, status = "accepted") {
  return {
    schemaVersion: "telemetry-performance-receipt-v1",
    status,
    reportId: "12345678-1234-4234-8234-123456789abc",
    day: report.day,
    reportRevision: report.reportRevision,
    replayed: status === "idempotent",
  };
}

function responseJson(status, value, headers = {}) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}

function capability(now = Date.parse("2026-09-21T12:00:00.000Z")) {
  return {
    schemaVersion: "telemetry-performance-capabilities-v1",
    lifecycle: "accepted",
    consentCurrent: true,
    authorizationCurrent: true,
    supportedSpeedMethods: ["receipt", "tool_free"],
    requiredConsent: {
      schemaVersion: "model-performance-daily-v1",
      fieldDictionaryVersion: "telemetry-performance-registry-2026-09-29.1",
      privacyContractVersion: "privacy-safe-model-performance-v1",
      scope: "model-performance-daily",
    },
    authorization: {
      schemaVersion: "telemetry-performance-authorization-v1",
      capabilityRevision: 1,
      authorityEpoch: 1,
      issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 86_400_000).toISOString(),
      scope: "model-performance-daily",
    },
  };
}

test("refuses an old or mismatched speed-method capability before preparation", async () => {
  const stale = capability();
  delete stale.supportedSpeedMethods;
  let prepared = false;
  const result = await runTelemetryPerformanceSync({
    day: DAY,
    nowEpoch: Date.parse("2026-09-21T12:00:00.000Z"),
    readCapabilities: async () => stale,
    prepareDay: async () => { prepared = true; return await report(); },
    createEnvelope: async () => { throw new Error("must not create an envelope"); },
    send: async () => { throw new Error("must not send"); },
  });
  assert.equal(prepared, false);
  assert.equal(result.state.lastOutcome.code, "response_invalid");
  assert.equal(result.status, "paused");

  const mismatched = capability();
  mismatched.supportedSpeedMethods = ["receipt", "legacy"];
  const mismatch = await runTelemetryPerformanceSync({
    day: DAY,
    nowEpoch: Date.parse("2026-09-21T12:00:00.000Z"),
    readCapabilities: async () => mismatched,
    prepareDay: async () => { throw new Error("must not prepare"); },
    createEnvelope: async () => { throw new Error("must not create an envelope"); },
    send: async () => { throw new Error("must not send"); },
  });
  assert.equal(mismatch.state.lastOutcome.code, "response_invalid");
  assert.equal(mismatch.state.pausedReason, "response_invalid");
});

test("prepares deterministic path-free report revisions", async () => {
  const prepared = await report();
  assert.equal(prepared.schemaVersion, "telemetry-performance-report-v1");
  assert.match(prepared.reportRevision, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(prepared).includes("/Users/"), false);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.records[0]), true);
  assert.deepEqual(
    (await report([record(), record({ modelId: "gpt-5.6-sol" })])).records.map((item) => item.modelId),
    ["gpt-5.6-luna", "gpt-5.6-sol"],
  );
  await assert.rejects(
    () => report([record(), record()]),
    (error) => error.code === "telemetry_performance_report_order_invalid",
  );
});

test("keeps performance state independent and classifies retry, replay, and authorization", async () => {
  const base = initialTelemetryPerformanceSyncState();
  const saved = [];
  const prepared = await report();
  const common = {
    day: DAY,
    state: base,
    nowEpoch: Date.parse("2026-09-21T12:00:00.000Z"),
    readCapabilities: async () => capability(),
    prepareDay: async () => prepared,
    createEnvelope: async ({ report: value }) => ({ report: value }),
    saveState: async (value) => saved.push(value),
  };
  const retry = await runTelemetryPerformanceSync({ ...common, send: async () => ({ status: 503 }) });
  assert.equal(retry.status, "retry");
  assert.equal(retry.state.cursorDay, null);
  const accepted = await runTelemetryPerformanceSync({
    ...common,
    state: retry.state,
    nowEpoch: common.nowEpoch + 60_000,
    send: async ({ report: sent }) => ({ status: 202, receipt: reportReceipt(sent) }),
  });
  assert.equal(accepted.status, "succeeded");
  assert.equal(accepted.state.cursorDay, DAY);
  const replay = await runTelemetryPerformanceSync({
    ...common,
    state: accepted.state,
    send: async ({ report: sent }) => ({ status: 202, receipt: reportReceipt(sent, "idempotent"), idempotencyReplayed: true }),
  });
  assert.equal(replay.status, "succeeded");
  const paused = await runTelemetryPerformanceSync({
    ...common,
    send: async () => ({ status: 403 }),
  });
  assert.equal(paused.state.pausedReason, "authorization_rejected");
  assert.equal(saved.length, 7);
  assert.deepEqual([saved[0], saved[3], saved[5]].map(item => item.cursorDay), [null, DAY, null],
    "send intents cannot advance the acknowledged cursor");
  assert.ok([saved[0], saved[3], saved[5]].every(item => item.pendingReports[0].code === "report_acknowledgement_pending"));
});

test("encrypts only the independent performance report envelope", async () => {
  const keys = await webcrypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
  publicJwk.kid = "key:performance-fixture";
  const prepared = await report();
  const envelope = await createTelemetryPerformanceEnvelope({
    report: prepared,
    publicJwk,
    keyId: publicJwk.kid,
    cryptoImpl: webcrypto,
  });
  assert.equal(validateTelemetryPerformanceEnvelope(envelope), envelope);
  assert.equal(JSON.stringify(envelope).includes(prepared.reportRevision), false);
});

test("rejects malformed persisted state and cross-dialect capability", () => {
  assert.deepEqual(parseTelemetryPerformanceSyncState(null), initialTelemetryPerformanceSyncState());
  assert.throws(
    () => parseTelemetryPerformanceSyncState({
      ...initialTelemetryPerformanceSyncState(),
      pausedReason: "/private/path",
    }),
    /sync failed closed/,
  );
});

test("prepares a zero-record day tombstone when the source revision becomes ineligible", async () => {
  const tombstone = await report([], DAY);
  assert.equal(tombstone.day, DAY);
  assert.deepEqual(tombstone.records, []);
  assert.match(tombstone.reportRevision, /^[a-f0-9]{64}$/u);
  await assert.rejects(
    () => report([], "not-a-day"),
    /sync failed closed/u,
  );
});

test("performance transient failures saturate backoff without permanently pausing and recover after restart", async () => {
  for (const phase of ["capability", "envelope", "send"]) {
    let now = Date.parse("2026-09-21T12:00:00.000Z");
    let state = initialTelemetryPerformanceSyncState();
    let offline = true;
    const common = {
      day: DAY,
      readCapabilities: async () => {
        if (offline && phase === "capability") throw Object.assign(new Error("synthetic outage"), { retryAfter: "120" });
        return capability(now);
      },
      prepareDay: async () => report(),
      createEnvelope: async ({ report }) => {
        if (offline && phase === "envelope") throw Object.assign(new Error("synthetic outage"), { code: "telemetry_performance_capability_unavailable" });
        return { report };
      },
      send: async ({ report: sent }) => offline
        ? { status: 503, retryAfter: "120" }
        : { status: 202, receipt: reportReceipt(sent) },
    };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = await runTelemetryPerformanceSync({ ...common, state, nowEpoch: now });
      assert.equal(result.status, "retry", phase);
      assert.equal(result.state.paused, false);
      assert.ok(result.state.retryCount <= 8);
      assert.equal(result.state.cursorDay, null);
      state = JSON.parse(JSON.stringify(result.state));
      const early = await runTelemetryPerformanceSync({ ...common, state, nowEpoch: now + 1,
        readCapabilities: async () => assert.fail("early retry cannot reach network") });
      assert.equal(early.status, "retry");
      assert.deepEqual(early.state, state);
      now = Date.parse(state.nextAttemptAt);
    }
    offline = false;
    // Existing installations may carry the old permanent outage pause.
    state = { ...state, paused: true, pausedReason: "retry_exhausted" };
    const recovered = await runTelemetryPerformanceSync({ ...common, state, nowEpoch: now });
    assert.equal(recovered.status, "succeeded");
    assert.equal(recovered.state.retryCount, 0);
    assert.equal(recovered.state.cursorDay, DAY);
  }
});

test("performance retry-after is bounded and terminal authority or response errors never retry", async () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");
  const common = { day: DAY, nowEpoch: now, readCapabilities: async () => capability(now),
    prepareDay: async () => report(), createEnvelope: async ({ report }) => ({ report }) };
  for (const [retryAfter, delay] of [["120", 120_000], ["999999999", 604_800_000],
    ["Mon, 21 Sep 2026 12:03:00 GMT", 180_000], ["invalid", 10_000]]) {
    const result = await runTelemetryPerformanceSync({ ...common, send: async () => ({ status: 429, retryAfter }) });
    assert.equal(Date.parse(result.state.nextAttemptAt) - now, delay);
  }
  for (const phase of ["capability", "envelope", "send"]) {
    for (const code of ["authorization_rejected", "response_invalid"]) {
      const fail = async () => { throw Object.assign(new Error("synthetic terminal"), { code: `telemetry_performance_${code}` }); };
      const result = await runTelemetryPerformanceSync({ ...common,
        ...(phase === "capability" ? { readCapabilities: fail } : phase === "envelope" ? { createEnvelope: fail } : {}),
        send: phase === "send" ? fail : async () => assert.fail("terminal failure must not upload"),
      });
      assert.equal(result.status, "paused");
      assert.equal(result.state.pausedReason, code);
      assert.equal(result.state.nextAttemptAt, null);
    }
  }
});


test("deterministic envelope failures cannot become an endless network retry", async () => {
  const result = await runTelemetryPerformanceSync({ day: DAY, nowEpoch: Date.parse("2026-09-21T12:00:00.000Z"),
    readCapabilities: async () => capability(), prepareDay: async () => report(),
    createEnvelope: async () => { throw new TypeError("synthetic invalid envelope"); },
    send: async () => assert.fail("invalid envelope cannot upload"),
  });
  assert.equal(result.status, "paused");
  assert.equal(result.state.pausedReason, "response_invalid");
  assert.equal(result.state.nextAttemptAt, null);
});


test("successful current-day prefixes preserve older-day retry backoff across scheduler restarts", async () => {
  let now = Date.parse("2026-09-21T12:00:00.000Z");
  let state = initialTelemetryPerformanceSyncState();
  let unavailable = true;
  let nextDelay = null;
  const uploadedDays = [];
  const client = createTelemetryPerformanceClient({
    origin: "https://telemetry.example.test", readAuthorization: async () => "Device synthetic-token",
    readState: async () => JSON.parse(JSON.stringify(state)), saveState: async (next) => { state = next; },
    readPreparedDay: async ({ day }) => report([], day), createEnvelope: async ({ report }) => ({ report }),
    fetchImpl: async (_, request) => {
      if (request.method === "GET") return new Response(JSON.stringify(capability(now)), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
      const sent = JSON.parse(request.body).report;
      uploadedDays.push(sent.day);
      return unavailable && sent.day === "2026-09-20"
        ? new Response(null, { status: 503 }) : responseJson(202, reportReceipt(sent));
    },
  });
  const runPass = async () => {
    const scheduler = createTelemetryPerformanceScheduler({ runner: (options) => client.runDay(options),
      now: () => now, backfillDays: 1, includeCurrentDay: true, retryMilliseconds: 1_000,
      setTimer: (_, delay) => { nextDelay = delay; return 1; }, clearTimer: () => {},
    });
    scheduler.start();
    const result = await scheduler.runNow();
    await scheduler.stop();
    return result;
  };
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = await runPass();
    assert.equal(result.state, "retry_wait");
    assert.equal(state.retryCount, Math.min(attempt, 8));
    assert.equal(nextDelay, 5_000 * (2 ** Math.min(attempt, 8)));
    assert.deepEqual(uploadedDays.slice(-2), [DAY, "2026-09-20"]);
    now += nextDelay;
  }
  unavailable = false;
  const recovered = await runPass();
  assert.equal(recovered.state, "up_to_date");
  assert.equal(state.retryCount, 0);
  assert.equal(state.paused, false);
});

test("a mixed report rejected by the old service recovers once through the end of the retry window", async () => {
  const mixedDay = "2026-11-17";
  const prepared = await report([
    record({ day: mixedDay }), record({ day: mixedDay, modelId: "gpt-6.2-sol" }),
  ], mixedDay);
  let now = Date.parse(`${mixedDay}T12:00:00.000Z`);
  const { pendingReports, lastExpiredReportDay, ...legacy } = initialTelemetryPerformanceSyncState();
  let state = {
    ...legacy, schemaVersion: "telemetry-performance-sync-state-v1",
    cursorDay: mixedDay, lastReportRevision: prepared.reportRevision,
    lastAttemptAt: new Date(now - 1_000).toISOString(),
    lastOutcome: { at: new Date(now - 1_000).toISOString(), status: "succeeded", code: "idempotent" },
  };
  const submitted = [];
  const admitted = new Map();
  let upgraded = false;
  let loseReceipt = true;
  const createClient = () => createTelemetryPerformanceClient({
    origin: "https://telemetry.example.test",
    readAuthorization: async () => "Device synthetic-token",
    readState: async () => JSON.parse(JSON.stringify(state)),
    saveState: async value => { state = value; },
    readPreparedDay: async ({ day }) => day === mixedDay ? prepared : report([], day),
    createEnvelope: async ({ report: sent }) => ({ report: sent }),
    fetchImpl: async (_, request) => {
      if (request.method === "GET") return responseJson(200, capability(now));
      const { report: sent } = JSON.parse(request.body);
      submitted.push(sent.day);
      if (sent.day === mixedDay && !upgraded) {
        assert.deepEqual(sent.records, prepared.records);
        return responseJson(409, { error: { code: "TELEMETRY_RECORD_INVALID", requestId: "synthetic" } });
      }
      const replayed = admitted.has(sent.reportRevision);
      admitted.set(sent.reportRevision, sent.records);
      if (sent.day === mixedDay && loseReceipt) {
        loseReceipt = false;
        return new Response(new ReadableStream({
          start(controller) { controller.error(new Error("private transport error")); },
        }), { status: 202, headers: { "cache-control": "no-store", "content-type": "application/json" } });
      }
      return responseJson(202, reportReceipt(sent, replayed ? "idempotent" : "accepted"),
        replayed ? { "idempotency-replayed": "true" } : {});
    },
  });
  const runPass = async (runCarryover = false) => {
    const client = createClient();
    let nextTimer;
    const scheduler = createTelemetryPerformanceScheduler({
      runner: client.runDay, readRetryDays: client.readRetryDays,
      now: () => now, includeCurrentDay: true, retryMilliseconds: 1_000,
      setTimer: callback => { nextTimer = callback; return 1; }, clearTimer: () => {},
    });
    scheduler.start();
    try {
      const before = submitted.length;
      const ordinary = await scheduler.runNow();
      assert.equal(submitted.length - before, 8, "ordinary delivery stays in its seven-day scope");
      if (!runCarryover) return ordinary;
      assert.equal(ordinary.state, "retry_wait");
      now = Date.parse(ordinary.nextAttemptAt);
      const beforeRetry = submitted.length;
      nextTimer();
      const rerun = await scheduler.runNow();
      assert.deepEqual(submitted.slice(beforeRetry), [mixedDay], "retry timer sends only the pending day");
      return rerun;
    } finally { await scheduler.stop(); }
  };

  const migrated = parseTelemetryPerformanceSyncState(state);
  assert.equal(migrated.cursorDay, null);
  assert.equal(migrated.lastReportRevision, null);
  assert.equal(migrated.lastOutcome, null);
  const initial = await runPass();
  assert.equal(initial.state, "retry_wait");
  assert.equal(initial.lastAcceptedAt, null);
  assert.equal(admitted.has(prepared.reportRevision), false);
  assert.equal(submitted.length, 8, "a rejected current day must not starve the rest of the window");
  assert.equal(state.cursorDay, "2026-11-10");
  assert.deepEqual(state.pendingReports.map(({ day, code }) => [day, code]), [[mixedDay, "report_record_invalid"]]);

  for (const age of [8, 9]) {
    now = Date.parse(`2026-11-${17 + age}T12:00:00.000Z`);
    const previous = submitted.length;
    const refused = await runPass(true);
    assert.equal(refused.state, "retry_wait");
    assert.equal(submitted.length - previous, 9, "only the carried refused day extends ordinary scope");
    assert.equal(submitted.at(-1), mixedDay);
  }

  upgraded = true;
  now = Date.parse("2026-11-27T12:00:00.000Z");
  const interrupted = await runPass(true);
  assert.equal(interrupted.state, "retry_wait", "lost receipt cannot prove the host commit");
  assert.equal(state.pendingReports[0].code, "report_receipt_invalid");
  assert.notEqual(state.cursorDay, mixedDay);
  assert.deepEqual(admitted.get(prepared.reportRevision), prepared.records);

  now = Date.parse(interrupted.nextAttemptAt);
  const recovered = await runPass(true);
  assert.equal(recovered.state, "up_to_date");
  assert.equal(state.cursorDay, mixedDay);
  assert.equal(state.lastReportRevision, prepared.reportRevision);
  assert.equal(state.lastOutcome.code, "idempotent");
  assert.deepEqual(state.pendingReports, []);
  assert.equal([...admitted.values()].flat().filter(item => item.day === mixedDay).length, 2);
  assert.equal(JSON.stringify(state).includes("private transport error"), false);
});

test("validation, conflict and unconfirmed acknowledgements keep progress and retire expired retries honestly", async () => {
  const now = Date.parse("2026-11-28T12:00:00.000Z");
  const dated = "2026-11-28";
  const accepted = "2026-11-27";
  const expired = "2026-11-17";
  const prepared = await report([], dated);
  const previous = { ...initialTelemetryPerformanceSyncState(), cursorDay: accepted, lastReportRevision: DIGEST,
    pendingReports: [{ day: expired, code: "report_record_invalid", retryCount: 4,
      nextAttemptAt: new Date(now - 1000).toISOString() }] };
  const cases = [
    [() => new Response(null, { status: 409 }), "report_conflict_unconfirmed"],
    [() => new Response("invalid-json", { status: 409,
      headers: { "content-type": "application/json", "cache-control": "no-store" } }), "report_conflict_unconfirmed"],
    [() => responseJson(409, { error: { code: "TELEMETRY_MANIFEST_CONFLICT", details: "private-canary" } }), "report_manifest_conflict"],
    [() => responseJson(409, { error: { code: "private-canary" }, ...reportReceipt(prepared, "idempotent") }), "report_conflict_unconfirmed"],
    [() => responseJson(409, {}, { "content-length": "16385" }), "report_conflict_unconfirmed"],
    [() => responseJson(202, { ...reportReceipt(prepared), reportRevision: DIGEST }), "report_receipt_invalid"],
    [() => responseJson(202, { ...reportReceipt(prepared), day: expired }), "report_receipt_invalid"],
    [() => responseJson(202, { ...reportReceipt(prepared), replayed: true }), "report_receipt_invalid"],
    [() => responseJson(202, reportReceipt(prepared, "idempotent")), "report_receipt_invalid"],
    [() => responseJson(202, reportReceipt(prepared, "idempotent"), { "idempotency-replayed": "false" }), "report_receipt_invalid"],
    [() => responseJson(202, reportReceipt(prepared, "replaced"), { "idempotency-replayed": "true" }), "report_receipt_invalid"],
    [() => responseJson(200, reportReceipt(prepared)), "report_receipt_invalid"],
  ];
  for (const [makeResponse, code] of cases) {
    let state = previous;
    let sends = 0;
    const client = createTelemetryPerformanceClient({
      origin: "https://telemetry.example.test", readAuthorization: async () => "Device synthetic-token",
      readState: async () => state, saveState: async next => { state = next; },
      readPreparedDay: async () => prepared,
      createEnvelope: async ({ report: sent }) => ({ report: sent }),
      fetchImpl: async (_, request) => {
        if (request.method === "GET") return responseJson(200, capability(now));
        sends += 1;
        return makeResponse();
      },
    });
    assert.deepEqual(await client.readRetryDays({ nowEpoch: now }), []);
    const refused = await client.runDay({ day: dated, nowEpoch: now });
    assert.equal(refused.status, "retry");
    assert.equal(refused.retryScope, "day");
    assert.equal(state.cursorDay, accepted);
    assert.equal(state.lastReportRevision, DIGEST);
    assert.equal(state.lastExpiredReportDay, expired);
    assert.deepEqual(state.pendingReports.map(({ day, code: saved }) => [day, saved]), [[dated, code]]);
    assert.equal(JSON.stringify(state).includes("private-canary"), false);
    assert.equal((await client.runDay({ day: dated, nowEpoch: now + 1 })).status, "retry");
    assert.equal(sends, 1, "a not-yet-due rejection must not send twice");
  }
});

test("overlapping attempts and a changed device cannot commit an acknowledgement or a stale carried day", async () => {
  const now = Date.parse("2026-11-26T12:00:00.000Z");
  const carried = "2026-11-17";
  const prepared = await report([], carried);
  const firstDevice = "11111111-1111-4111-8111-111111111111";
  const nextDevice = "22222222-2222-4222-8222-222222222222";
  let device = firstDevice;
  let writes = 0;
  let sends = 0;
  const initial = initialTelemetryPerformanceSyncState();
  const states = new Map([[firstDevice, { ...initial, pendingReports: [{
    day: carried, code: "report_record_invalid", retryCount: 1, nextAttemptAt: "2026-11-26T00:00:00.000Z",
  }] }]]);
  const arrived = Promise.withResolvers();
  const complete = Promise.withResolvers();
  const client = createTelemetryPerformanceClient({
    origin: "https://telemetry.example.test",
    readDeviceId: async () => device,
    readAuthorization: async bound => { assert.equal(bound, firstDevice); return "Device synthetic-token"; },
    readState: async id => states.get(id) ?? initial,
    saveState: async () => { writes += 1; },
    readPreparedDay: async () => prepared,
    createEnvelope: async ({ report: sent }) => ({ report: sent }),
    fetchImpl: async (_, request) => {
      if (request.method === "GET") return responseJson(200, capability(now));
      sends += 1;
      arrived.resolve();
      await complete.promise;
      return responseJson(202, reportReceipt(prepared));
    },
  });
  const options = { day: carried, nowEpoch: now, onlyPending: true };
  assert.deepEqual(await client.readRetryDays({ nowEpoch: now }), [carried]);
  const attempt = client.runDay(options);
  await arrived.promise;
  await assert.rejects(client.runDay(options), /telemetry_performance_attempt_in_progress/u);
  device = nextDevice;
  complete.resolve();
  await assert.rejects(attempt, error => error.code === "telemetry_performance_device_binding_changed");
  assert.equal((await client.runDay(options)).status, "skipped", "old scheduled carryover cannot follow a device change");
  assert.equal(sends, 1);
  assert.equal(writes, 0);
});

test("an interrupted post has a durable send intent before any network write", async () => {
  const dated = "2026-11-17";
  const now = Date.parse("2026-11-24T23:59:00.000Z");
  const prepared = await report([], dated);
  let saved = initialTelemetryPerformanceSyncState();
  let writes = 0;
  const attempt = {
    day: dated, nowEpoch: now, readCapabilities: async () => capability(now),
    prepareDay: async () => prepared, createEnvelope: async () => ({}),
    saveState: async next => {
      writes += 1;
      if (writes === 2) throw new Error("synthetic process interrupted before the outcome write");
      saved = next;
    },
    send: async () => {
      assert.equal(writes, 1);
      assert.equal(saved.cursorDay, null);
      assert.equal(saved.pendingReports[0].code, "report_acknowledgement_pending");
      throw new Error("synthetic connection loss after commit");
    },
  };
  await assert.rejects(runTelemetryPerformanceSync(attempt), /interrupted before the outcome/u);
  assert.equal(saved.pendingReports[0].code, "report_acknowledgement_pending");
  const restart = await runTelemetryPerformanceSync({ ...attempt,
    state: JSON.parse(JSON.stringify(saved)), onlyPending: true, nowEpoch: now + 120_000,
    send: async ({ report: sent }) => ({ status: 202, receipt: reportReceipt(sent, "idempotent"), idempotencyReplayed: true }),
  });
  assert.equal(restart.state.cursorDay, dated);
  assert.equal(restart.state.lastReportRevision, prepared.reportRevision);
  assert.equal(restart.state.lastOutcome.code, "idempotent");
  assert.deepEqual(restart.state.pendingReports, []);
});
