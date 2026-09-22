import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEPLOYMENT_ENDPOINTS } from "../../config/deployment-endpoints.js";
import { createLocalAccountlessContribution } from "./accountless-contribution.js";
import { prepareTelemetryPerformanceDay } from "../../src/application/index.js";
import {
  attachAccountlessParentChannel,
} from "../../src/platform/index.js";
import {
  PERFORMANCE_BUCKET_SCHEME_VERSION,
  PERFORMANCE_MEASUREMENT_VERSION,
  PERFORMANCE_RECORD_SCHEMA_VERSION,
  buildPerformanceHistogram,
} from "../../packages/telemetry-contract/index.js";

const origin = "http://127.0.0.1:18765";
test("companion accountless mode is absent without an explicit mode and private channel", () => {
  assert.equal(createLocalAccountlessContribution({ environment: {} }), null);
  for (const environment of [
    { USAGE_MONITOR_ACCOUNTLESS_ORIGIN: origin },
    { USAGE_MONITOR_ACCOUNTLESS_ORIGIN: "https://tibotattle.com", USAGE_MONITOR_TEST_LANE: "accountless-local-lab-v1" },
    { USAGE_MONITOR_ACCOUNTLESS_ORIGIN: origin, USAGE_MONITOR_TEST_LANE: "accountless-local-lab-v1", USAGE_MONITOR_CENTRAL_ORIGIN: "https://tibotattle.com" },
  ]) assert.throws(() => createLocalAccountlessContribution({ environment }), /Invalid accountless contribution configuration/u);
});

for (const mode of ["laboratory", "production", "rehearsal"]) test(`${mode} companion composes saved preference, private credential port and one bounded runner`, async () => {
  const origin = mode === "laboratory" ? "http://127.0.0.1:18765"
    : mode === "rehearsal" ? DEPLOYMENT_ENDPOINTS.staging.origin
      : "https://tibotattle.com";
  const parent = new EventEmitter();
  const child = new EventEmitter();
  for (const [from, to] of [[parent, child], [child, parent]]) {
    from.connected = true;
    from.send = (value, cb) => queueMicrotask(() => { to.emit("message", structuredClone(value)); cb?.(); });
  }
  let enabled = true;
  let calls = 0;
  const host = attachAccountlessParentChannel({ channel: parent, backend: {}, readPreference: async () => ({
    available: true, current: true, enabled, policyVersion: "accountless-opt-out-v1", destinationOrigin: origin,
  }) });
  const selected = createLocalAccountlessContribution({
    environment: { USAGE_MONITOR_ACCOUNTLESS_ORIGIN: origin,
      ...(mode === "laboratory" ? { USAGE_MONITOR_TEST_LANE: "accountless-local-lab-v1" }
        : { USAGE_MONITOR_ACCOUNTLESS_MODE: mode === "rehearsal"
          ? "rehearsal-v1" : "production-v1" }) },
    stateRoot: "/synthetic", indexFile: "/synthetic/index.sqlite", channel: child,
    schedulerOptions: { setTimer: () => 1, clearTimer: () => {} },
    runner: async (options) => {
      calls++;
      assert.equal(options.laboratory, mode === "laboratory");
      assert.equal(options.production, mode === "production");
      assert.equal(options.rehearsal, mode === "rehearsal");
      assert.equal(options.origin, origin);
      assert.equal(options.indexFile, "/synthetic/index.sqlite");
      assert.equal(options.stateFile, "/synthetic/accountless-device-binding-v1.json");
      assert.equal((await options.readPreference()).enabled, true);
      assert.ok(options.signal instanceof AbortSignal);
      return { status: "complete", chunksUploaded: 1 };
    },
  });
  selected.start();
  await selected.runNow();
  assert.equal(calls, 1);
  enabled = false;
  host.invalidate();
  await new Promise((resolve) => setImmediate(resolve));
  await selected.runNow();
  assert.equal(calls, 1);
  assert.equal(selected.inspect().state, "off");
  await selected.stop();
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("disconnect"), 0);
  host.dispose();
});

test("companion detaches its private channel even if scheduler cleanup fails", async () => {
  const child = new EventEmitter();
  child.connected = true;
  child.send = () => {};
  const selected = createLocalAccountlessContribution({
    environment: { USAGE_MONITOR_ACCOUNTLESS_ORIGIN: origin, USAGE_MONITOR_TEST_LANE: "accountless-local-lab-v1" },
    stateRoot: "/synthetic", indexFile: "/synthetic/index.sqlite", channel: child,
    schedulerOptions: { setTimer: () => 1, clearTimer: () => { throw new Error("synthetic timer failure"); } },
  });
  selected.start();
  await assert.rejects(selected.stop(), /synthetic timer failure/u);
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("disconnect"), 0);
});

test("accountless performance scheduler obtains its own grant, backfills seven days plus today, and stops on opt-out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "accountless-performance-composition-"));
  const stateRoot = join(root, "state");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const deviceId = "11111111-1111-4111-8111-111111111111";
  await writeFile(join(stateRoot, "accountless-device-binding-v1.json"), `${JSON.stringify({
    schemaVersion: "contribution-device-binding-v1",
    origin,
    deviceId,
    createdAt: "2026-09-21T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  const parent = new EventEmitter();
  const child = new EventEmitter();
  for (const [from, to] of [[parent, child], [child, parent]]) {
    from.connected = true;
    from.send = (value, cb) => queueMicrotask(() => { to.emit("message", structuredClone(value)); cb?.(); });
  }
  let enabled = true;
  const host = attachAccountlessParentChannel({
    channel: parent,
    readPreference: async () => ({
      available: true, current: true, enabled,
      policyVersion: "accountless-opt-out-v1", destinationOrigin: origin,
    }),
    backend: {
      async read() { return Buffer.alloc(32, 7); },
      async createIfMissing() { throw new Error("unexpected credential create"); },
      async deleteExact() { throw new Error("unexpected credential delete"); },
    },
  });
  const requests = [];
  const preparedDays = [];
  const capability = {
    schemaVersion: "telemetry-performance-capabilities-v1",
    lifecycle: "accepted",
    consentCurrent: true,
    authorizationCurrent: true,
    supportedSpeedMethods: ["receipt", "tool_free"],
    requiredConsent: {
      schemaVersion: PERFORMANCE_RECORD_SCHEMA_VERSION,
      fieldDictionaryVersion: "telemetry-performance-registry-2026-09-21.1",
      privacyContractVersion: "privacy-safe-model-performance-v1",
      scope: "model-performance-daily",
    },
    authorization: {
      schemaVersion: "telemetry-performance-authorization-v1",
      capabilityRevision: 1,
      authorityEpoch: 1,
      issuedAt: "2026-09-21T00:00:00.000Z",
      expiresAt: "2026-10-21T00:00:00.000Z",
      scope: "model-performance-daily",
    },
  };
  const response = (status, value = null) => ({
    status,
    async json() { return value; },
    async text() { return JSON.stringify(value); },
  });
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    requests.push({ method: init.method ?? "GET", path: parsed.pathname });
    if (parsed.pathname === "/api/v1/accountless/telemetry-performance-authorization") return response(201, {});
    if (parsed.pathname === "/api/v1/device/telemetry/performance/capabilities") return response(200, capability);
    if (parsed.pathname === "/api/v1/envelope-key") return response(200, {
      algorithm: "RSA-OAEP-256", keyId: "key:performance-fixture", publicJwk: { kty: "RSA" },
    });
    if (parsed.pathname === "/api/v1/device/telemetry/performance/reports") return response(202, {});
    throw new Error(`unexpected route ${parsed.pathname}`);
  };
  const reportForDay = async day => {
    const record = {
      schemaVersion: PERFORMANCE_RECORD_SCHEMA_VERSION,
      day,
      provider: "openai_codex",
      modelId: "gpt-5.6-luna",
      reasoningEffort: "high",
      speedMethod: "receipt",
      speedMode: "standard",
      speedModeSource: "rollout_thread_settings",
      apiServiceTier: "standard",
      measurementVersion: PERFORMANCE_MEASUREMENT_VERSION,
      bucketSchemeVersion: PERFORMANCE_BUCKET_SCHEME_VERSION,
      turns: 1, speedTurns: 1, ttftTurns: 1, completionTurns: 1, timedResponses: 1,
      speedTokens: 100, speedDurationMs: 2_000,
      speedHistogram: buildPerformanceHistogram("speed", [50]),
      ttftHistogram: buildPerformanceHistogram("ttft", [400]),
      completionHistogram: buildPerformanceHistogram("turnDuration", [2_000]),
    };
    return prepareTelemetryPerformanceDay({
      records: [record], day, sourceGeneration: "timing:fixture",
      sourceDigest: "a".repeat(64), sourceRevision: 1,
      parserVersion: "codex-inference-timing-v17",
    });
  };
  const selected = createLocalAccountlessContribution({
    environment: {
      USAGE_MONITOR_ACCOUNTLESS_ORIGIN: origin,
      USAGE_MONITOR_TEST_LANE: "accountless-local-lab-v1",
    },
    stateRoot,
    indexFile: join(root, "index.sqlite"),
    channel: child,
    runner: async () => ({ status: "complete", chunksUploaded: 0 }),
    schedulerOptions: { setTimer: () => 1, clearTimer: () => {} },
    performanceOptions: {
      fetchImpl,
      readPreparedDay: async ({ day }) => {
        preparedDays.push(day);
        return reportForDay(day);
      },
      createEnvelope: async ({ report }) => ({
        schemaVersion: "telemetry-performance-envelope-v1", report,
      }),
      schedulerOptions: {
        setTimer: () => 1,
        clearTimer: () => {},
        now: () => Date.parse("2026-09-21T12:00:00.000Z"),
      },
    },
  });
  selected.start();
  const first = await selected.performanceRunNow();
  assert.equal(first.state, "up_to_date");
  assert.deepEqual(preparedDays, [
    "2026-09-21", "2026-09-20", "2026-09-19", "2026-09-18",
    "2026-09-17", "2026-09-16", "2026-09-15", "2026-09-14",
  ]);
  assert.equal(requests.filter(item => item.path === "/api/v1/accountless/telemetry-performance-authorization").length, 1);
  assert.equal(requests.filter(item => item.path === "/api/v1/device/telemetry/performance/reports").length, 8);
  enabled = false;
  host.invalidate();
  await new Promise(resolve => setImmediate(resolve));
  const beforeOptOut = requests.length;
  const paused = await selected.performanceRunNow();
  assert.equal(paused.state, "paused");
  assert.equal(requests.length, beforeOptOut);
  enabled = true;
  host.invalidate();
  await new Promise((resolve) => setImmediate(resolve));
  const resumed = await selected.performanceRunNow();
  assert.equal(resumed.state, "up_to_date");
  assert.equal(requests.filter(item => item.path === "/api/v1/accountless/telemetry-performance-authorization").length, 2);
  assert.equal(requests.filter(item => item.path === "/api/v1/device/telemetry/performance/reports").length, 16);
  await selected.stop();
  host.dispose();
});


test("production companion refuses ambient modes without the private parent capability", () => {
  const base = { USAGE_MONITOR_ACCOUNTLESS_ORIGIN: "https://tibotattle.com",
    USAGE_MONITOR_ACCOUNTLESS_MODE: "production-v1" };
  for (const environment of [base, { ...base, USAGE_MONITOR_TEST_LANE: "macos-electron-local-qa-v1" },
    { ...base, USAGE_MONITOR_ACCOUNTLESS_ORIGIN: "https://unreviewed.example" },
    { ...base, USAGE_MONITOR_ACCOUNTLESS_ORIGIN: DEPLOYMENT_ENDPOINTS.staging.origin },
    { USAGE_MONITOR_ACCOUNTLESS_MODE: "rehearsal-v1",
      USAGE_MONITOR_ACCOUNTLESS_ORIGIN: DEPLOYMENT_ENDPOINTS.staging.origin }]) {
    assert.throws(() => createLocalAccountlessContribution({ environment, channel: {} }),
      /Invalid accountless contribution configuration/u);
  }
});
