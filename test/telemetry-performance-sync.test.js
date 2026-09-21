import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import {
  buildPerformanceHistogram,
} from "@app-usagemonitor/telemetry-contract";
import {
  initialTelemetryPerformanceSyncState,
  parseTelemetryPerformanceSyncState,
  prepareTelemetryPerformanceDay,
  runTelemetryPerformanceSync,
} from "../src/contribution/telemetry-performance-sync.js";
import {
  createTelemetryPerformanceEnvelope,
  validateTelemetryPerformanceEnvelope,
} from "../src/platform/telemetry-performance-envelope.js";

globalThis.crypto ??= webcrypto;

const DAY = "2026-09-21";
const DIGEST = "a".repeat(64);

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

function capability(now = Date.parse("2026-09-21T12:00:00.000Z")) {
  return {
    schemaVersion: "telemetry-performance-capabilities-v1",
    lifecycle: "accepted",
    consentCurrent: true,
    authorizationCurrent: true,
    supportedSpeedMethods: ["receipt", "tool_free"],
    requiredConsent: {
      schemaVersion: "model-performance-daily-v1",
      fieldDictionaryVersion: "telemetry-performance-registry-2026-09-21.1",
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
  assert.equal(result.state.lastOutcome.code, "capability_unavailable");
  assert.equal(result.status, "retry");

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
  assert.equal(mismatch.state.lastOutcome.code, "capability_unavailable");
  assert.equal(mismatch.state.pausedReason, null);
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
    send: async () => ({ status: 201 }),
  });
  assert.equal(accepted.status, "succeeded");
  assert.equal(accepted.state.cursorDay, DAY);
  const replay = await runTelemetryPerformanceSync({
    ...common,
    state: accepted.state,
    send: async () => ({ status: 409 }),
  });
  assert.equal(replay.status, "succeeded");
  const paused = await runTelemetryPerformanceSync({
    ...common,
    send: async () => ({ status: 403 }),
  });
  assert.equal(paused.state.pausedReason, "authorization_rejected");
  assert.equal(saved.length, 4);
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
