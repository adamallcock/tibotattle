import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";

import { startLocalCompanionServer } from "../apps/local/server.js";
import { createProductionDistributionMetadata } from "../apps/electron/desktop-updater.js";
import { DesktopSettingsBackendError } from "../apps/electron/desktop-settings-backends.js";
import { createDesktopSharingCoordinator } from "../apps/electron/desktop-sharing.js";
import { normalizeLocalOnboarding } from "../apps/web/public/data-client.js";
import {
  inspectLocalOnboarding,
  prepareLocalInstallationRoots,
} from "../src/local-installation-diagnostics.js";
import { localCodexLogScanner } from "../src/local-node-runtime.js";
import { WindowsProtectedStateStoreError } from "../src/platform/windows-protected-state-store.js";
import {
  buildWindowsNormalCandidateEnvironment,
  buildWindowsNormalCandidateLaunchSpec,
  prepareWindowsDevelopmentProfile,
} from "../scripts/launch-electron-windows-development.mjs";
import {
  buildWindowsNormalCandidateFirewallCreateArguments,
  buildWindowsNormalCandidateFirewallRemoveArguments,
  createWindowsNormalCandidateQuitProtocol,
  installOutboundFirewallBlock,
  jsonFetch,
  localNetworkObserver,
  inspectWindowsNormalCandidateStartupRefreshCompletion,
  normalizeStartupCompletionDiagnostic,
  normalizeStartupFailureDiagnostic,
  removeOutboundFirewallBlock,
  parseWindowsNormalCandidateSmokeArguments,
  prepareWindowsNormalCandidateProfile,
  runWindowsNormalCandidateSmoke,
  releaseWindowsNormalCandidateStartupRefreshGate,
  classifyWindowsNormalCandidatePreloadContext,
  classifyWindowsNormalCandidateStartupRefreshGateFailure,
  inspectWindowsNormalCandidateStartupRefreshGate,
  observeWindowsNormalCandidatePreloadContexts,
  waitForWindowsNormalCandidateStartupRefreshGate,
  waitForWindowsNormalCandidateStartupRefreshCompletion,
  seedWindowsNormalCandidateCodexFixture,
  selectWindowsNormalCandidateDashboardTarget,
  selectWindowsNormalCandidateSettingsTarget,
  validateWindowsNormalCandidateSmokeMetadata,
  verifyWindowsNormalCandidateOptOut,
  verifyWindowsNormalCandidateSmokePackage,
  WINDOWS_NORMAL_CANDIDATE_FIREWALL_TIMEOUT_MS,
} from "../scripts/smoke-electron-windows-normal-candidate.mjs";

const SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";
const APP_PATH = String.raw`C:\candidate\artifacts\win-unpacked\TiboTattle.exe`;
const STAGED_APP_PATH = String.raw`C:\candidate\app`;
const SOURCE_CANDIDATE_PATH = String.raw`C:\candidate\production-source-candidate.json`;
const RECEIPT_PATH = String.raw`C:\workspace\.release-build\electron-windows-normal-candidate\normal-candidate-smoke.json`;
const FIREWALL_RULE = "tibotattle-normal-candidate-550e8400-e29b-41d4-a716-446655440000";

test("startup failure diagnostics retain only fixed categories and booleans", () => {
  const value = { launch: "restart", requests: "zero", refreshStatus: "idle",
    onboarding: "ready", electronMarked: true, refreshDisabled: false,
    sourceReadable: true, rolloutPresent: true, stateWritable: true };
  assert.deepEqual(normalizeStartupFailureDiagnostic(value), value);
  for (const changed of [null, { ...value, raw: "private" },
    { ...value, refreshStatus: "private" }, { ...value, sourceReadable: "private" },
    { ...value, requests: 42 }, { ...value, launch: "private" }]) {
    assert.equal(normalizeStartupFailureDiagnostic(changed), null);
  }
});

test("startup completion diagnostics retain fixed classifier and controller categories", () => {
  const value = {
    phase: "completion",
    requestCount: "one",
    refreshStatus: "failed",
    classifierStatus: "failed",
    classifierReason: "failed",
    failedStep: "accounting",
    controllerError: "refresh_resource_limited",
  };
  assert.deepEqual(normalizeStartupCompletionDiagnostic(value), value);
  for (const changed of [
    null,
    { ...value, failureCode: "private" },
    { ...value, failedStep: "private" },
    { ...value, controllerError: "private" },
    { ...value, classifierReason: "private" },
    { ...value, classifierStatus: "pending" },
    { ...value, requestCount: "zero" },
  ]) {
    assert.equal(normalizeStartupCompletionDiagnostic(changed), null);
  }

  const unknownController = inspectWindowsNormalCandidateStartupRefreshCompletion({
    requestCount: 1,
    refresh: {
      status: "failed",
      refreshId: "startup-refresh-id",
      errorCode: "private_controller_detail",
      failedStep: "private_step",
      failureCode: "private_failure_code",
    },
    expectedRefreshId: "startup-refresh-id",
  });
  assert.equal(unknownController.decision.status, "failed");
  assert.deepEqual(unknownController.diagnostic, {
    phase: "completion",
    requestCount: "one",
    refreshStatus: "failed",
    classifierStatus: "failed",
    classifierReason: "failed",
    failedStep: "other",
    controllerError: "other",
  });
  assert.doesNotMatch(JSON.stringify(unknownController.diagnostic), /private/u);

  const unknownStatus = inspectWindowsNormalCandidateStartupRefreshCompletion({
    requestCount: 1,
    refresh: { status: "not_observed", refreshId: "startup-refresh-id" },
    expectedRefreshId: "startup-refresh-id",
  });
  assert.equal(unknownStatus.diagnostic.refreshStatus, "other");

  const unavailable = inspectWindowsNormalCandidateStartupRefreshCompletion({
    requestCount: 1,
    expectedRefreshId: "startup-refresh-id",
    unavailable: true,
  });
  assert.equal(unavailable.decision.status, "pending");
  assert.deepEqual(unavailable.diagnostic, {
    phase: "completion",
    requestCount: "one",
    refreshStatus: "unavailable",
    classifierStatus: "pending",
    classifierReason: "none",
    failedStep: "none",
    controllerError: "none",
  });
});

test("normal candidate startup completion returns a failed classifier without waiting for a timeout", async () => {
  let polls = 0;
  await assert.rejects(waitForWindowsNormalCandidateStartupRefreshCompletion({
    refreshCount: () => 1,
    readRefresh: async () => ({
      status: "failed",
      refreshId: "startup-refresh-id",
      errorCode: "refresh_resource_limited",
      failedStep: "accounting",
      failureCode: "private_failure_code",
    }),
    expectedRefreshId: "startup-refresh-id",
    waitForPoll: async (operation) => {
      polls += 1;
      return operation();
    },
  }), (error) => {
    assert.equal(error?.code, "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_LOCAL_STARTUP_REFRESH_COMPLETION_UNAVAILABLE");
    assert.deepEqual(error?.startupCompletionDiagnostic, {
      phase: "completion",
      requestCount: "one",
      refreshStatus: "failed",
      classifierStatus: "failed",
      classifierReason: "failed",
      failedStep: "accounting",
      controllerError: "refresh_resource_limited",
    });
    assert.doesNotMatch(JSON.stringify(error?.startupCompletionDiagnostic), /private/u);
    return true;
  });
  assert.equal(polls, 1);
});

test("normal Windows refresh observer counts detailed and returning-profile quick requests", () => {
  const handlers = new Map();
  const observer = localNetworkObserver({
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
  }, "http://127.0.0.1:12345");
  const emit = (path, method = "POST") => handlers.get("Network.requestWillBeSent")({
    request: { url: `http://127.0.0.1:12345${path}`, method },
  });
  emit("/api/local/refresh");
  assert.equal(observer.refreshCount(), 1);
  observer.resetRefreshes();
  emit("/api/local/refresh/quick");
  assert.equal(observer.refreshCount(), 1);
  emit("/api/local/refresh", "GET");
  emit("/api/local/refresh/cancel");
  emit("/api/local/refresh/quick-extra");
  assert.equal(observer.refreshCount(), 1);
  handlers.get("Network.requestWillBeSent")({ request: {
    url: "http://127.0.0.1:54321/api/local/refresh/quick", method: "POST",
  } });
  assert.equal(observer.refreshCount(), 1);
  assert.equal(observer.valid(), false);
  observer.dispose();
  assert.equal(handlers.size, 0);
});

test("normal candidate loopback requests refuse redirects and bound response waits", async () => {
  let options;
  await assert.rejects(jsonFetch("http://127.0.0.1:12345/api/local/health", {
    fetchImpl: async (_url, selected) => {
      options = selected;
      return { ok: true, redirected: true, json: async () => ({ status: "ready" }) };
    },
  }), /loopback response unavailable/u);
  assert.equal(options.redirect, "error");
  assert.equal(options.signal.aborted, true);
  await assert.rejects(jsonFetch("http://127.0.0.1:12345/api/local/health", {
    timeoutMs: 10,
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
  }), /loopback response unavailable/u);
});

test("normal candidate releases its startup gate only through the fixed Windows preload bridge", async () => {
  const expressions = [];
  assert.equal(await releaseWindowsNormalCandidateStartupRefreshGate({
    async evaluate(expression) {
      expressions.push(expression);
      return "released";
    },
  }), true);
  assert.equal(expressions.length, 1);
  assert.match(expressions[0], /__TIBOTATTLE_ELECTRON_WINDOWS_SMOKE__/u);
  assert.match(expressions[0], /releaseStartupRefresh/u);
  assert.match(expressions[0], /tibotattleDesktop\?\.version === "v1"/u);
  assert.equal(await releaseWindowsNormalCandidateStartupRefreshGate({
    async evaluate() { return false; },
  }), false);
  assert.equal(await releaseWindowsNormalCandidateStartupRefreshGate(null), false);
  assert.equal(await inspectWindowsNormalCandidateStartupRefreshGate({
    async evaluate() { return "unavailable"; },
  }), "unavailable");
});

test("normal candidate waits for its preload gate before releasing the startup refresh", async () => {
  let attempts = 0;
  let now = 0;
  const cdp = {
    async evaluate() {
      attempts += 1;
      return attempts === 1 ? "unavailable" : "released";
    },
  };
  const released = await waitForWindowsNormalCandidateStartupRefreshGate(cdp, {
    timeoutMs: 321,
    clock: () => now,
    async sleep(milliseconds) {
      assert.equal(milliseconds, 150);
      now += milliseconds;
    },
  });
  assert.deepEqual(released, { released: true, failureCode: null });
  assert.equal(attempts, 2);
  assert.deepEqual(await waitForWindowsNormalCandidateStartupRefreshGate({
    async evaluate() { return "already_released"; },
  }), { released: false, failureCode: "LOCAL_STARTUP_REFRESH_GATE_ALREADY_RELEASED" });
  assert.deepEqual(await waitForWindowsNormalCandidateStartupRefreshGate({
    async evaluate() { return "evaluation_failed"; },
  }, { timeoutMs: 1, clock: (() => { let tick = 0; return () => tick++; })(), sleep: async () => {} }),
  { released: false, failureCode: "LOCAL_STARTUP_REFRESH_GATE_EVALUATION_FAILED" });
  assert.deepEqual(await waitForWindowsNormalCandidateStartupRefreshGate({
    async evaluate() { return "preload_active_gate_absent"; },
  }, { timeoutMs: 1, clock: (() => { let tick = 0; return () => tick++; })(), sleep: async () => {} }),
  { released: false, failureCode: "LOCAL_STARTUP_REFRESH_GATE_PRELOAD_ACTIVE_GATE_ABSENT" });
});

test("normal candidate preload diagnostic retains only closed context observations", async () => {
  assert.equal(classifyWindowsNormalCandidatePreloadContext("normal_environment_match"), "normal_environment_match");
  assert.equal(classifyWindowsNormalCandidatePreloadContext("private-env-value"), "evaluation_failed");
  assert.equal(classifyWindowsNormalCandidateStartupRefreshGateFailure({
    failureCode: "LOCAL_STARTUP_REFRESH_GATE_UNAVAILABLE",
  }, []), "LOCAL_STARTUP_REFRESH_GATE_PRELOAD_CONTEXT_UNAVAILABLE");
  assert.equal(classifyWindowsNormalCandidateStartupRefreshGateFailure({
    failureCode: "LOCAL_STARTUP_REFRESH_GATE_UNAVAILABLE",
  }, ["control_other_or_absent"]), "LOCAL_STARTUP_REFRESH_GATE_ISOLATED_CONTEXT_ENV_NOT_MATCHED");
  assert.equal(classifyWindowsNormalCandidateStartupRefreshGateFailure({
    failureCode: "LOCAL_STARTUP_REFRESH_GATE_UNAVAILABLE",
  }, ["normal_environment_match", "private-value"]),
  "LOCAL_STARTUP_REFRESH_GATE_ISOLATED_CONTEXT_ENV_MATCH_BRIDGE_ABSENT");
  assert.equal(classifyWindowsNormalCandidateStartupRefreshGateFailure({
    failureCode: "LOCAL_STARTUP_REFRESH_GATE_EVALUATION_FAILED",
  }, ["normal_environment_match"]), "LOCAL_STARTUP_REFRESH_GATE_EVALUATION_FAILED");
});

test("normal candidate preload context observer evaluates only isolated contexts", async () => {
  const handlers = new Map();
  const calls = [];
  const observer = observeWindowsNormalCandidatePreloadContexts({
    on(method, handler) {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    },
    async request(method, params) {
      calls.push({ method, params });
      return { result: { value: params.contextId === 7 ? "normal_environment_match" : "private-value" } };
    },
  });
  handlers.get("Runtime.executionContextCreated")({ context: { id: 3, auxData: { type: "default" } } });
  handlers.get("Runtime.executionContextCreated")({ context: { id: 7, auxData: { type: "isolated" } } });
  handlers.get("Runtime.executionContextCreated")({ context: { id: 9, auxData: { type: "isolated" } } });
  assert.deepEqual(await observer.inspect(), ["evaluation_failed", "normal_environment_match"]);
  assert.deepEqual(calls.map(({ params }) => params.contextId), [7, 9]);
  assert.equal(calls.every(({ method, params }) => method === "Runtime.evaluate"
    && params.awaitPromise === true && params.returnByValue === true
    && typeof params.expression === "string" && !params.expression.includes("process.env,")), true);
  observer.dispose();
  assert.equal(handlers.has("Runtime.executionContextCreated"), false);
});

function smokeOptions() {
  return {
    appPath: APP_PATH,
    stagedAppPath: STAGED_APP_PATH,
    sourceCandidatePath: SOURCE_CANDIDATE_PATH,
    sourceRevision: SOURCE_REVISION,
    receiptPath: RECEIPT_PATH,
  };
}

function sourceCandidate() {
  return {
    schemaVersion: "tibotattle-electron-production-source-candidate-v1",
    status: "production_source_staged",
    target: "win32-x64",
    sourceRevision: SOURCE_REVISION,
    version: "0.1.0",
    stagingDirectory: ".release-build/electron-production/win32-x64/app",
    builderConfiguration: "apps/electron/electron-builder.production.config.cjs",
    updaterEnabled: true,
    signingRequired: true,
    signingPerformed: false,
    publishingPerformed: false,
    windowsRuntimeQualification: "required",
  };
}

function candidateMetadata() {
  return createProductionDistributionMetadata({
    buildNumber: "12345",
    sourceRevision: SOURCE_REVISION,
    target: "win32-x64",
  });
}

function packageStageFailure(code) {
  return Object.assign(new Error(code), {
    code: `ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_${code}`,
  });
}

function packageVerificationDependencies({
  verifyPaths = async () => {},
  readJsonFile,
  digest = async () => ({ bytes: 1, sha256: "a".repeat(64) }),
  asar,
  validateNative,
  validateRuntimeClosure,
  useNativePair = false,
  useRuntimeClosure = false,
} = {}) {
  const manifest = { version: "0.1.0", tibotattleDistribution: candidateMetadata() };
  const selectedValidateNative = validateNative ?? (useNativePair ? undefined : async () => ({
    windowsFilesystemSha256: "b".repeat(64),
    keytarSha256: "c".repeat(64),
  }));
  const selectedValidateRuntimeClosure = validateRuntimeClosure
    ?? (useRuntimeClosure ? undefined : async () => {});
  return {
    platform: "win32",
    architecture: "x64",
    verifyPaths,
    readJsonFile: readJsonFile ?? (async (_path, code) => {
      if (code === "SOURCE_CANDIDATE_INVALID") return sourceCandidate();
      assert.equal(code, "PACKAGE_STAGED_MANIFEST_INVALID");
      return manifest;
    }),
    digest,
    asar: asar ?? {
      extractFile: () => Buffer.from(JSON.stringify(manifest)),
    },
    ...(selectedValidateNative === undefined ? {} : { validateNative: selectedValidateNative }),
    ...(selectedValidateRuntimeClosure === undefined
      ? {} : { validateRuntimeClosure: selectedValidateRuntimeClosure }),
  };
}

function passedJourney() {
  return {
    dashboardRendered: true,
    localRefreshObserved: true,
    localRefreshTerminal: "succeeded",
    sharingOptOutRetained: true,
    settingsPersisted: true,
    cleanQuit: true,
  };
}

function normalCandidateSeedDependencies(overrides = {}) {
  let receipt = null;
  return {
    createAdapter: () => Object.freeze({ productionSafe: false }),
    createStore: () => Object.freeze({}),
    createReceiptBackend: () => Object.freeze({
      async load() { return receipt; },
      async save(value) { receipt = value; return value; },
    }),
    createSharingBackend: () => Object.freeze({
      async load() { return null; },
      async save() {},
    }),
    createCoordinator: () => Object.freeze({
      async initialize() {},
      async setEnabled() { return Object.freeze({ enabled: false }); },
      async readAuthorization() {
        return Object.freeze({ enabled: false, transportStatus: "off" });
      },
      dispose() {},
    }),
    ...overrides,
  };
}

const NORMAL_CANDIDATE_PROFILE = Object.freeze({
  userData: String.raw`C:\tibotattle-normal-candidate-test-${randomUUID()}\user-data`,
});

test("normal candidate adds one content-free Codex source before launch", async () => {
  const profile = Object.freeze({
    codex: String.raw`C:\runner\owned\profile\codex`,
    home: String.raw`C:\runner\owned\profile\home`,
  });
  const calls = [];
  let fixtureContent = null;
  const fixture = await seedWindowsNormalCandidateCodexFixture({ profile }, {
    createDirectory: async (path, options) => {
      calls.push({ kind: "directory", path, options });
    },
    metadata: async (path) => path.endsWith("sessions")
      ? { isDirectory: () => true, isSymbolicLink: () => false }
      : {
        isFile: () => true,
        isSymbolicLink: () => false,
        nlink: 1,
        size: Buffer.byteLength(fixtureContent),
      },
    writeFixture: async (path, value, options) => {
      fixtureContent = value;
      calls.push({ kind: "file", path, value, options });
    },
  });
  assert.equal(fixture.codexHome, win32.join(profile.home, ".codex"));
  assert.notEqual(fixture.codexHome, profile.codex);
  assert.equal(fixture.sessions, String.raw`C:\runner\owned\profile\home\.codex\sessions`);
  assert.equal(
    fixture.fixture,
    String.raw`C:\runner\owned\profile\home\.codex\sessions\rollout-2026-09-08T00-00-00-70000000-0000-4000-8000-000000000001.jsonl`,
  );
  const records = fixtureContent.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.type), [
    "session_meta", "turn_context", "event_msg",
  ]);
  assert.equal(records[0].payload.id, "70000000-0000-4000-8000-000000000001");
  assert.equal(records[1].payload.model, "gpt-5.6-sol");
  assert.equal(records[2].payload.info.total_token_usage.total_tokens, 120);
  assert.deepEqual(calls, [
    {
      kind: "directory",
      path: fixture.sessions,
      options: { recursive: true, mode: 0o700 },
    },
    {
      kind: "file",
      path: fixture.fixture,
      value: fixtureContent,
      options: { mode: 0o600, flag: "wx" },
    },
  ]);
  await assert.rejects(seedWindowsNormalCandidateCodexFixture({ profile }, {
    createDirectory: async () => {},
    metadata: async () => ({ isDirectory: () => false, isSymbolicLink: () => false }),
    writeFixture: async () => {},
  }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_SYNTHETIC_FIXTURE_UNAVAILABLE",
  });
});

test("normal candidate fixture passes Codex discovery, onboarding, and local refresh preflight", async () => {
  const captured = { content: null, fileName: null };
  await seedWindowsNormalCandidateCodexFixture({
    profile: { home: String.raw`C:\runner\owned\profile\home` },
  }, {
    createDirectory: async () => {},
    metadata: async (path) => path.endsWith("sessions")
      ? { isDirectory: () => true, isSymbolicLink: () => false }
      : {
        isFile: () => true,
        isSymbolicLink: () => false,
        nlink: 1,
        size: Buffer.byteLength(captured.content),
      },
    writeFixture: async (path, value) => {
      captured.fileName = win32.basename(path);
      captured.content = value;
    },
  });
  const root = await mkdtemp(join(await realpath(tmpdir()), "tibotattle-windows-normal-fixture-"));
  const codexHome = join(root, "codex");
  const rejectedCodexHome = join(root, "rejected-codex");
  const stateRoot = join(root, "state");
  const sessions = join(codexHome, "sessions");
  const rejectedSessions = join(rejectedCodexHome, "sessions");
  let app = null;
  try {
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    await mkdir(rejectedSessions, { recursive: true, mode: 0o700 });
    await writeFile(join(sessions, captured.fileName), captured.content, {
      mode: 0o600,
      flag: "wx",
    });
    // The earlier fixture made onboarding appear ready but could never reach
    // Codex discovery because its filename was not a canonical rollout name.
    await writeFile(join(rejectedSessions, "synthetic-windows-normal-candidate.jsonl"),
      '{"type":"session_meta","id":"synthetic-windows-normal-candidate"}\n',
      { mode: 0o600, flag: "wx" });
    prepareLocalInstallationRoots({ resourceRoot: process.cwd(), stateRoot });
    const rejected = await localCodexLogScanner.discoverCodexRolloutInfos({
      codexHome: rejectedCodexHome,
      startAt: "2026-09-01T00:00:00.000Z",
    });
    assert.equal(rejected.length, 0);
    const sources = await localCodexLogScanner.discoverCodexRolloutInfos({
      codexHome,
      startAt: "2026-09-01T00:00:00.000Z",
    });
    assert.equal(sources.length, 1);
    const onboarding = await inspectLocalOnboarding({ codexHome, stateRoot });
    assert.equal(onboarding.status, "ready");
    const normalized = normalizeLocalOnboarding(onboarding);
    assert.equal(normalized.state, "ready");
    assert.equal(normalized.sessionsReadable, true);
    assert.equal(normalized.rolloutFilesPresent, true);
    assert.equal(normalized.stateWritable, true);
    assert.equal(normalized.explicitRefresh, true);

    const serverOptions = {
      port: 0,
      resourceRoot: process.cwd(),
      stateRoot,
      codexHome,
      environment: {
        ...process.env,
        CODEX_HOME: codexHome,
        HOME: root,
        USERPROFILE: root,
        USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
        USAGE_MONITOR_RESOURCE_ROOT: process.cwd(),
        USAGE_MONITOR_STATE_ROOT: stateRoot,
      },
    };
    app = await startLocalCompanionServer(serverOptions);
    const base = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${base}/api/local/onboarding`);
    assert.equal(response.status, 200);
    assert.equal(normalizeLocalOnboarding(await response.json()).state, "ready");
    const refresh = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: "{}",
    });
    assert.equal(refresh.status, 202);
    const deadline = Date.now() + 5_000;
    let terminal = null;
    while (Date.now() < deadline) {
      const status = await fetch(`${base}/api/local/refresh`).then((value) => value.json());
      if (["succeeded", "degraded"].includes(status?.refresh?.status)) {
        terminal = status.refresh.status;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.ok(["succeeded", "degraded"].includes(terminal));
    await app.close();
    app = await startLocalCompanionServer(serverOptions);
    const restartedBase = `http://127.0.0.1:${app.port}`;
    const restartedOnboarding = await fetch(`${restartedBase}/api/local/onboarding`);
    assert.equal(restartedOnboarding.status, 200);
    assert.equal(normalizeLocalOnboarding(await restartedOnboarding.json()).state, "ready");
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows normal candidate smoke accepts only its exact unpacked invocation", () => {
  assert.deepEqual(parseWindowsNormalCandidateSmokeArguments([
    "--app", APP_PATH,
    "--staged-app", STAGED_APP_PATH,
    "--source-candidate", SOURCE_CANDIDATE_PATH,
    "--source-revision", SOURCE_REVISION,
    "--receipt", RECEIPT_PATH,
  ]), smokeOptions());
  for (const invalid of [
    ["--app", APP_PATH],
    ["--app", APP_PATH, "--app", APP_PATH,
      "--staged-app", STAGED_APP_PATH,
      "--source-candidate", SOURCE_CANDIDATE_PATH,
      "--source-revision", SOURCE_REVISION,
      "--receipt", RECEIPT_PATH],
    ["--app", String.raw`C:\candidate\artifacts\win-unpacked\other.exe`,
      "--staged-app", STAGED_APP_PATH,
      "--source-candidate", SOURCE_CANDIDATE_PATH,
      "--source-revision", SOURCE_REVISION,
      "--receipt", RECEIPT_PATH],
    ["--app", APP_PATH,
      "--staged-app", String.raw`C:\other\app`,
      "--source-candidate", SOURCE_CANDIDATE_PATH,
      "--source-revision", SOURCE_REVISION,
      "--receipt", RECEIPT_PATH],
  ]) {
    assert.throws(() => parseWindowsNormalCandidateSmokeArguments(invalid), {
      code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_ARGUMENT_INVALID",
    });
  }
});

test("Windows normal candidate smoke binds source staging and archived metadata to stable win32-x64", () => {
  const distribution = candidateMetadata();
  const manifest = { version: "0.1.0", tibotattleDistribution: distribution };
  assert.deepEqual(validateWindowsNormalCandidateSmokeMetadata({
    sourceCandidate: sourceCandidate(),
    stagedManifest: manifest,
    archiveManifest: manifest,
    sourceRevision: SOURCE_REVISION,
  }), {
    sourceRevision: SOURCE_REVISION,
    target: "win32-x64",
    distribution,
  });
  for (const invalid of [
    { ...sourceCandidate(), target: "linux-x64" },
    { ...sourceCandidate(), signingRequired: false },
    { ...sourceCandidate(), windowsRuntimeQualification: "not_applicable" },
  ]) {
    assert.throws(() => validateWindowsNormalCandidateSmokeMetadata({
      sourceCandidate: invalid,
      stagedManifest: manifest,
      archiveManifest: manifest,
      sourceRevision: SOURCE_REVISION,
    }), /ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_SOURCE_CANDIDATE_INVALID/u);
  }
  assert.throws(() => validateWindowsNormalCandidateSmokeMetadata({
    sourceCandidate: sourceCandidate(),
    stagedManifest: manifest,
    archiveManifest: { version: "0.1.0", tibotattleDistribution: { ...distribution, channel: "beta" } },
    sourceRevision: SOURCE_REVISION,
  }), /ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_METADATA_INVALID/u);
});

test("normal candidate package verification keeps its closed failure stages distinct", async () => {
  const verify = (dependencies) => verifyWindowsNormalCandidateSmokePackage(
    smokeOptions(),
    packageVerificationDependencies(dependencies),
  );
  const valid = await verify({
    validateNative: async ({ failureCode }) => {
      assert.equal(failureCode, "PACKAGE_NATIVE_MEMBERS_INVALID");
      return {
        windowsFilesystemSha256: "b".repeat(64),
        keytarSha256: "c".repeat(64),
      };
    },
  });
  assert.equal(valid.target, "win32-x64");

  await assert.rejects(verify({
    verifyPaths: async () => { throw packageStageFailure("PACKAGE_PATHS_INVALID"); },
  }), { code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_PATHS_INVALID" });

  const readCodes = [];
  await assert.rejects(verify({
    readJsonFile: async (_path, code) => {
      readCodes.push(code);
      if (code === "SOURCE_CANDIDATE_INVALID") return sourceCandidate();
      throw packageStageFailure("PACKAGE_STAGED_MANIFEST_INVALID");
    },
  }), { code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_STAGED_MANIFEST_INVALID" });
  assert.deepEqual(readCodes, ["SOURCE_CANDIDATE_INVALID", "PACKAGE_STAGED_MANIFEST_INVALID"]);

  await assert.rejects(verify({
    asar: { extractFile: () => { throw new Error("unavailable"); } },
  }), { code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_ARCHIVE_MANIFEST_INVALID" });

  const manifest = { version: "0.1.0", tibotattleDistribution: {
    ...candidateMetadata(), channel: "beta",
  } };
  await assert.rejects(verify({
    asar: { extractFile: () => Buffer.from(JSON.stringify(manifest)) },
  }), { code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_METADATA_INVALID" });

  let nativeFailureCode = null;
  await assert.rejects(verify({
    validateNative: async ({ failureCode }) => {
      nativeFailureCode = failureCode;
      throw packageStageFailure("PACKAGE_NATIVE_MEMBERS_INVALID");
    },
  }), { code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_NATIVE_MEMBERS_INVALID" });
  assert.equal(nativeFailureCode, "PACKAGE_NATIVE_MEMBERS_INVALID");

  let runtimeFailureCode = null;
  await assert.rejects(verify({
    validateRuntimeClosure: async ({ failureCode }) => {
      runtimeFailureCode = failureCode;
      throw packageStageFailure("PACKAGE_RUNTIME_CLOSURE_INVALID");
    },
  }), { code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_RUNTIME_CLOSURE_INVALID" });
  assert.equal(runtimeFailureCode, "PACKAGE_RUNTIME_CLOSURE_INVALID");
});

test("normal candidate package verification uses Windows ASAR separators for the virtual native sidecar", async () => {
  const nativeManifest = Buffer.from("fixed-native-sidecar", "utf8");
  const nativeDigest = Object.freeze({
    bytes: nativeManifest.byteLength,
    sha256: createHash("sha256").update(nativeManifest).digest("hex"),
  });
  const virtualManifest = String.raw`native\windows-filesystem\build\Release\windows_filesystem.node.manifest.json`;
  const members = [];
  const result = await verifyWindowsNormalCandidateSmokePackage(
    smokeOptions(),
    packageVerificationDependencies({
      useNativePair: true,
      digest: async () => nativeDigest,
      asar: {
        extractFile: (_archive, member) => {
          members.push(member);
          if (member === "package.json") {
            return Buffer.from(JSON.stringify({
              version: "0.1.0",
              tibotattleDistribution: candidateMetadata(),
            }));
          }
          if (member === virtualManifest) return nativeManifest;
          throw new Error("unexpected archive member");
        },
      },
    }),
  );
  assert.equal(result.target, "win32-x64");
  assert.deepEqual(members, ["package.json", virtualManifest]);
});

test("normal candidate package verification binds the staged preload and runtime manifest to ASAR", async () => {
  const preload = Buffer.from("fixed-preload", "utf8");
  const runtimeManifest = {
    files: [{
      path: "apps/electron/preload.cjs",
      bytes: preload.byteLength,
      sha256: createHash("sha256").update(preload).digest("hex"),
    }],
  };
  const nativeManifest = Buffer.from("fixed-native-sidecar", "utf8");
  const nativeDigest = Object.freeze({
    bytes: nativeManifest.byteLength,
    sha256: createHash("sha256").update(nativeManifest).digest("hex"),
  });
  const digestFor = (bytes) => Object.freeze({
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const verifyClosure = async ({
    stagedRuntimeManifest = runtimeManifest,
    archivedRuntimeBytes = null,
    archivedPreload = preload,
  } = {}) => {
    const stagedRuntimeBytes = Buffer.from(JSON.stringify(stagedRuntimeManifest), "utf8");
    const selectedArchivedRuntimeBytes = archivedRuntimeBytes ?? stagedRuntimeBytes;
    return await verifyWindowsNormalCandidateSmokePackage(smokeOptions(), packageVerificationDependencies({
      useNativePair: true,
      useRuntimeClosure: true,
      readJsonFile: async (path, code) => {
        if (code === "SOURCE_CANDIDATE_INVALID") return sourceCandidate();
        if (path.endsWith("package.json")) return { version: "0.1.0", tibotattleDistribution: candidateMetadata() };
        if (path.endsWith("electron-runtime-manifest.json")) return stagedRuntimeManifest;
        throw new Error("unexpected staged member");
      },
      digest: async (path) => path.endsWith("electron-runtime-manifest.json")
        ? digestFor(stagedRuntimeBytes)
        : /apps[\\/]electron[\\/]preload\.cjs$/u.test(path)
          ? digestFor(preload) : nativeDigest,
      asar: {
        extractFile: (_archive, member) => {
          if (member === "package.json") return Buffer.from(JSON.stringify({
            version: "0.1.0", tibotattleDistribution: candidateMetadata(),
          }));
          if (member === "electron-runtime-manifest.json") return selectedArchivedRuntimeBytes;
          if (member === String.raw`apps\electron\preload.cjs`) return archivedPreload;
          if (member === String.raw`native\windows-filesystem\build\Release\windows_filesystem.node.manifest.json`) {
            return nativeManifest;
          }
          throw new Error("unexpected archive member");
        },
      },
    }));
  };
  const result = await verifyClosure();
  assert.equal(result.target, "win32-x64");
  await assert.rejects(verifyClosure({ archivedPreload: Buffer.from("stale-preload", "utf8") }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_RUNTIME_CLOSURE_INVALID",
  });
  await assert.rejects(verifyClosure({ archivedRuntimeBytes: Buffer.from("stale-runtime-manifest", "utf8") }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_RUNTIME_CLOSURE_INVALID",
  });
  await assert.rejects(verifyClosure({ stagedRuntimeManifest: {
    files: [{ path: "apps/electron/preload.cjs", bytes: preload.byteLength + 1, sha256: "f".repeat(64) }],
  } }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_RUNTIME_CLOSURE_INVALID",
  });
});

test("normal candidate protected opt-out seeding retains closed source causes by stage", async () => {
  const seed = (dependencies) => prepareWindowsNormalCandidateProfile({
    profile: NORMAL_CANDIDATE_PROFILE,
    stagedAppPath: STAGED_APP_PATH,
  }, normalCandidateSeedDependencies(dependencies));

  await assert.rejects(seed({
    createAdapter() {
      throw Object.assign(new Error("unavailable"), {
        code: "WINDOWS_FILESYSTEM_BINDING_UNAVAILABLE",
      });
    },
  }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PROTECTED_OPT_OUT_ADAPTER_UNAVAILABLE_WINDOWS_FILESYSTEM_BINDING_UNAVAILABLE",
  });

  await assert.rejects(seed({
    createStore() { throw new WindowsProtectedStateStoreError("security_policy"); },
  }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PROTECTED_OPT_OUT_STORE_UNAVAILABLE_WINDOWS_PROTECTED_STATE_STORE_SECURITY_POLICY",
  });

  await assert.rejects(seed({
    createReceiptBackend: () => Object.freeze({
      async load() { throw new DesktopSettingsBackendError("store_unsafe"); },
      async save() {},
    }),
  }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PROTECTED_OPT_OUT_INITIAL_READ_UNAVAILABLE_DESKTOP_SETTINGS_BACKEND_STORE_UNSAFE",
  });

  await assert.rejects(seed({
    createReceiptBackend: () => Object.freeze({
      async load() { return null; },
      async save() { throw new DesktopSettingsBackendError("write_failed"); },
    }),
  }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PROTECTED_OPT_OUT_FIRST_RUN_UNAVAILABLE_DESKTOP_SETTINGS_BACKEND_WRITE_FAILED",
  });

  await assert.rejects(seed({
    createCoordinator: () => Object.freeze({
      async initialize() {},
      async setEnabled() { throw new DesktopSettingsBackendError("unavailable"); },
      async readAuthorization() { return null; },
      dispose() {},
    }),
  }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PROTECTED_OPT_OUT_SHARING_UNAVAILABLE_DESKTOP_SETTINGS_BACKEND_UNAVAILABLE",
  });

  const unknownStages = [
    {
      stage: "PROTECTED_OPT_OUT_ADAPTER_UNAVAILABLE",
      dependencies: {
        createAdapter() { throw new Error("private adapter detail"); },
      },
    },
    {
      stage: "PROTECTED_OPT_OUT_STORE_UNAVAILABLE",
      dependencies: {
        createStore() { throw new Error("private store detail"); },
      },
    },
    {
      stage: "PROTECTED_OPT_OUT_INITIAL_READ_UNAVAILABLE",
      dependencies: {
        createReceiptBackend: () => Object.freeze({
          async load() { throw new Error("private initial detail"); },
          async save() {},
        }),
      },
    },
    {
      stage: "PROTECTED_OPT_OUT_FIRST_RUN_UNAVAILABLE",
      dependencies: {
        createReceiptBackend: () => Object.freeze({
          async load() { return null; },
          async save() { throw new Error("private receipt detail"); },
        }),
      },
    },
    {
      stage: "PROTECTED_OPT_OUT_SHARING_UNAVAILABLE",
      dependencies: {
        createCoordinator: () => Object.freeze({
          async initialize() {},
          async setEnabled() { throw new Error("private sharing detail"); },
          async readAuthorization() { return null; },
          dispose() {},
        }),
      },
    },
  ];
  for (const { stage, dependencies } of unknownStages) {
    await assert.rejects(seed(dependencies), (error) => {
      assert.equal(error.code, `ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_${stage}`);
      assert.equal(error.message, error.code);
      assert.doesNotMatch(error.message, /private/u);
      return true;
    });
  }
});

test("normal candidate opt-out distinguishes raw authorization from projected transport state", async () => {
  let sharingText = null;
  const sharingBackend = Object.freeze({
    async load() { return sharingText; },
    async save(value) { sharingText = value; },
  });
  const seed = await prepareWindowsNormalCandidateProfile({
    profile: NORMAL_CANDIDATE_PROFILE,
    stagedAppPath: STAGED_APP_PATH,
  }, normalCandidateSeedDependencies({
    createSharingBackend: () => sharingBackend,
    createCoordinator: createDesktopSharingCoordinator,
  }));
  assert.equal(await verifyWindowsNormalCandidateOptOut(seed, {
    createCoordinator: createDesktopSharingCoordinator,
  }), true);

  const coordinator = createDesktopSharingCoordinator({
    backend: sharingBackend,
    installationState: "fresh",
    destinationOrigin: "https://tibotattle.com",
  });
  const authorization = await coordinator.readAuthorization();
  const inspection = await coordinator.inspect();
  assert.equal(authorization.available, true);
  assert.equal(authorization.current, true);
  assert.equal(authorization.enabled, false);
  assert.equal(Object.hasOwn(authorization, "transportStatus"), false);
  assert.equal(inspection.enabled, false);
  assert.equal(inspection.transportStatus, "off");
  coordinator.dispose();
});

test("normal candidate runner preserves a package stage in its content-free receipt", async () => {
  let receipt = null;
  await assert.rejects(runWindowsNormalCandidateSmoke(smokeOptions(), {
    platform: "win32",
    architecture: "x64",
    environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: String.raw`C:\\runner\\temp` },
    ensureReceiptParent: async () => {},
    reserveReceipt: async () => ({
      writeFile: async (value) => { receipt = JSON.parse(value); },
      sync: async () => {},
      close: async () => {},
    }),
    verifyPackage: async () => { throw packageStageFailure("PACKAGE_ARCHIVE_MANIFEST_INVALID"); },
  }), { code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_ARCHIVE_MANIFEST_INVALID" });
  assert.equal(receipt.errorCode, "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_ARCHIVE_MANIFEST_INVALID");
  assert.equal(receipt.packageArtifactVerified, false);
  assert.equal(receipt.packagedElectronExecutionVerified, false);
});

test("normal candidate receipt retains distinct terminal startup-gate causes", async () => {
  for (const suffix of [
    "LOCAL_STARTUP_REFRESH_GATE_ALREADY_RELEASED",
    "LOCAL_STARTUP_REFRESH_GATE_EVALUATION_FAILED",
  ]) {
    const expected = `ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_${suffix}`;
    let receipt = null;
    await assert.rejects(runWindowsNormalCandidateSmoke(smokeOptions(), {
      platform: "win32",
      architecture: "x64",
      environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: String.raw`C:\\runner\\temp` },
      ensureReceiptParent: async () => {},
      reserveReceipt: async () => ({
        writeFile: async (value) => { receipt = JSON.parse(value); },
        sync: async () => {},
        close: async () => {},
      }),
      verifyPackage: async () => ({ sourceRevision: SOURCE_REVISION, artifactSha256: "a".repeat(64), executableSha256: "b".repeat(64) }),
      createRoot: async () => String.raw`C:\\runner\\temp\\owned`,
      prepareProfile: async () => ({ root: String.raw`C:\\runner\\temp\\owned\\profile` }),
      seedCodexFixture: async () => {},
      seedProfile: async () => ({ shareBackend: {} }),
      assertProcessAbsence: async () => true,
      installFirewall: async () => FIREWALL_RULE,
      launchJourney: async () => { throw Object.assign(new Error("private failure"), { code: expected }); },
      verifyOptOut: async () => true,
      removeFirewall: async () => true,
      removeProfile: async () => {},
    }), { code: expected });
    assert.equal(receipt.errorCode, expected);
    assert.doesNotMatch(JSON.stringify(receipt), /private failure/u);
  }
});

test("normal candidate launcher keeps only the private profile, unified mode, and quit-only control", async () => {
  const root = await mkdtemp(join(
    await realpath(tmpdir()),
    "tibotattle-windows-normal-candidate-test-",
  ));
  try {
    const profile = await prepareWindowsDevelopmentProfile({
      appPath: join(root, "candidate", "TiboTattle.exe"),
      profilePath: join(root, "profile"),
    });
    const environment = buildWindowsNormalCandidateEnvironment({
      profile,
      environment: {
        PATH: "/safe/bin",
        SystemRoot: "/windows",
        NODE_OPTIONS: "--require=private.js",
        USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
        USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
        USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1",
        USAGE_MONITOR_ACCOUNTLESS_ORIGIN: "https://example.invalid",
        USAGE_MONITOR_CENTRAL_ORIGIN: "https://example.invalid",
      },
    });
    assert.equal(environment.USAGE_MONITOR_ACCOUNTING_SOURCE_MODE, "unified");
    assert.equal(environment.CODEX_HOME, join(environment.HOME, ".codex"));
    assert.notEqual(environment.CODEX_HOME, profile.codex);
    assert.equal(environment.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL, "quit-v1");
    for (const key of [
      "NODE_OPTIONS",
      "USAGE_MONITOR_TEST_LANE",
      "USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION",
      "USAGE_MONITOR_ACCOUNTLESS_ORIGIN",
      "USAGE_MONITOR_CENTRAL_ORIGIN",
    ]) assert.equal(Object.hasOwn(environment, key), false, key);
    const spec = buildWindowsNormalCandidateLaunchSpec({
      appPath: join(root, "candidate", "TiboTattle.exe"),
      profile,
      remoteDebuggingPort: 9222,
      environment: { PATH: "/safe/bin" },
    });
    assert.deepEqual(spec.args, [
      `--user-data-dir=${profile.userData}`,
      "--remote-debugging-port=9222",
      "--remote-debugging-address=127.0.0.1",
      "--disable-gpu",
    ]);
    assert.equal(spec.options.shell, false);
    assert.equal(spec.options.env.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL, "quit-v1");
    assert.throws(() => buildWindowsNormalCandidateLaunchSpec({
      appPath: join(root, "candidate", "TiboTattle Dev.exe"),
      profile,
      remoteDebuggingPort: 9222,
    }), /ELECTRON_WINDOWS_DEVELOPMENT_APP_INVALID/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normal candidate firewall scripts use the direct COM policy and recheck exact ownership before removal", () => {
  const create = buildWindowsNormalCandidateFirewallCreateArguments();
  const remove = buildWindowsNormalCandidateFirewallRemoveArguments();
  assert.equal(create.length, 5);
  assert.equal(remove.length, 5);
  for (const command of [create[4], remove[4]]) {
    assert.match(command, /USAGE_MONITOR_WINDOWS_NORMAL_CANDIDATE_APP/u);
    assert.match(command, /USAGE_MONITOR_WINDOWS_NORMAL_CANDIDATE_FIREWALL_RULE/u);
    assert.match(command, /HNetCfg\.FwPolicy2/u);
    assert.doesNotMatch(command, /C:\\candidate|tibotattle-normal-candidate-550e/u);
    assert.doesNotMatch(command, /(?:Get|New|Remove)-NetFirewall|CimSession/u);
  }
  assert.match(create[4], /HNetCfg\.FWRule/u);
  assert.match(create[4], /\$rule\.ApplicationName=\$expected/u);
  assert.match(create[4], /\$rule\.Direction=2/u);
  assert.match(create[4], /\$rule\.Action=0/u);
  assert.match(create[4], /\$rule\.Protocol=256/u);
  assert.match(create[4], /\$rule\.Profiles=2147483647/u);
  assert.match(create[4], /\$rule\.Enabled=\$true/u);
  assert.match(create[4], /\$rules\.Add\(\$rule\)/u);
  assert.match(create[4], /\[int\]\$rule\.Direction -ne 2/u);
  assert.match(create[4], /\[int\]\$rule\.Action -ne 0/u);
  assert.match(create[4], /\[int64\]\$rule\.Profiles -ne 2147483647/u);
  assert.match(create[4], /\[int\]\$rule\.Protocol -ne 256/u);
  assert.ok(remove[4].indexOf("$rules.Remove($name)") > remove[4].indexOf("$ownedRules.Count -ne 1"));
  assert.match(remove[4], /\$ownedRules\.Count -ne 0/u);
  assert.doesNotMatch(create[4], /\$matches/u);
  assert.doesNotMatch(remove[4], /\$matches/u);
});

test("normal candidate firewall setup and cleanup use their dedicated bounded budget", async () => {
  const environment = { SystemRoot: String.raw`C:\Windows` };
  const calls = [];
  const runProgram = async (_command, _argumentsList, options) => {
    calls.push(options);
    return Object.freeze({
      settled: true,
      timedOut: false,
      exitCode: 0,
      output: calls.length === 1 ? "verified" : "removed",
    });
  };
  const name = await installOutboundFirewallBlock({
    appPath: APP_PATH,
    environment,
    name: FIREWALL_RULE,
    runProgram,
  });
  assert.equal(name, FIREWALL_RULE);
  assert.equal(await removeOutboundFirewallBlock({
    appPath: APP_PATH,
    environment,
    name,
    runProgram,
  }), true);
  assert.equal(WINDOWS_NORMAL_CANDIDATE_FIREWALL_TIMEOUT_MS, 60_000);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.timeoutMs, WINDOWS_NORMAL_CANDIDATE_FIREWALL_TIMEOUT_MS);
  }
});

test("normal candidate CDP selection accepts the real trailing-slash root and rejects other origins", () => {
  const targets = [
    {
      type: "page",
      url: "http://127.0.0.1:43123/",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/dashboard",
    },
    {
      type: "page",
      url: "https://example.invalid/",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/remote",
    },
  ];
  assert.equal(selectWindowsNormalCandidateDashboardTarget(targets, 9222), targets[0]);
  assert.equal(selectWindowsNormalCandidateDashboardTarget([
    { ...targets[0], url: "http://127.0.0.1:43123" },
  ], 9222), undefined);
  const settings = {
    type: "page",
    url: "http://127.0.0.1:43123/electron-settings.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/settings",
  };
  assert.equal(selectWindowsNormalCandidateSettingsTarget([settings], "http://127.0.0.1:43123", 9222), settings);
  assert.equal(selectWindowsNormalCandidateSettingsTarget([settings], "http://127.0.0.1:43124", 9222), undefined);
});

test("normal candidate quit protocol accepts only the fixed lifecycle acknowledgement", async () => {
  const child = new EventEmitter();
  child.connected = true;
  const sent = [];
  child.send = (message, callback) => {
    sent.push(message);
    callback?.();
    child.emit("message", { type: "unexpected" });
    setImmediate(() => child.emit("message", { type: "tibotattle-electron-smoke-quit-accepted-v1" }));
  };
  const protocol = createWindowsNormalCandidateQuitProtocol(child, { timeoutMs: 1_000 });
  await protocol.requestQuit();
  protocol.close();
  assert.deepEqual(sent, [{ type: "tibotattle-electron-smoke-quit-v1" }]);
});

test("normal candidate runner orders firewall coverage around both ordinary launches and writes a content-free receipt", async () => {
  const events = [];
  let receipt = null;
  let launchNumber = 0;
  const result = await runWindowsNormalCandidateSmoke(smokeOptions(), {
    platform: "win32",
    architecture: "x64",
    environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: String.raw`C:\runner\temp` },
    ensureReceiptParent: async () => { events.push("receipt-parent"); },
    reserveReceipt: async () => ({
      writeFile: async (value) => { receipt = JSON.parse(value); },
      sync: async () => {},
      close: async () => {},
    }),
    verifyPackage: async () => {
      events.push("package");
      return { sourceRevision: SOURCE_REVISION, artifactSha256: "a".repeat(64), executableSha256: "b".repeat(64) };
    },
    createRoot: async () => { events.push("root"); return String.raw`C:\runner\temp\owned`; },
    prepareProfile: async () => ({ root: String.raw`C:\runner\temp\owned\profile` }),
    seedCodexFixture: async () => { events.push("fixture"); },
    seedProfile: async () => ({ shareBackend: {} }),
    assertProcessAbsence: async () => { events.push("absent"); return true; },
    installFirewall: async () => { events.push("firewall-add"); return FIREWALL_RULE; },
    launchJourney: async ({ candidateState, changeSettings }) => {
      events.push(changeSettings ? "first" : "second");
      candidateState.quiescent = false;
      candidateState.tracked = [];
      candidateState.quiescent = true;
      launchNumber += 1;
      return passedJourney();
    },
    verifyOptOut: async () => { events.push("opt-out"); return true; },
    removeFirewall: async () => { events.push("firewall-remove"); return true; },
    removeProfile: async () => { events.push("profile-remove"); },
  });
  assert.equal(launchNumber, 2);
  assert.equal(result.status, "passed");
  assert.ok(events.indexOf("firewall-add") < events.indexOf("first"));
  assert.ok(events.indexOf("second") < events.indexOf("firewall-remove"));
  assert.deepEqual(events, [
    "receipt-parent", "package", "root", "fixture", "absent", "firewall-add", "first", "second", "opt-out", "firewall-remove", "profile-remove",
  ]);
  assert.deepEqual(receipt, {
    schemaVersion: "tibotattle-electron-windows-normal-candidate-smoke-v1",
    status: "passed",
    scope: "candidate_only",
    target: "win32-x64",
    sourceRevision: SOURCE_REVISION,
    artifactSha256: "a".repeat(64),
    executableSha256: "b".repeat(64),
    packageArtifactVerified: true,
    packagedElectronExecutionVerified: true,
    dashboardRendered: true,
    localRefreshObserved: true,
    localRefreshTerminal: "succeeded",
    settingsPersistedAcrossRestart: true,
    durableContributionOptOutRetained: true,
    loopbackJourneyVerified: true,
    outboundFirewallRuleVerified: true,
    outboundFirewallRuleRemoved: true,
    ownedProfileRemoved: true,
    errorCode: null,
    productionReady: false,
  });
});

test("normal candidate runner retains the outbound block and profile when process cleanup is uncertain", async () => {
  let receipt = null;
  const startupDiagnostic = { launch: "first", requests: "zero", refreshStatus: "idle",
    onboarding: "ready", electronMarked: true, refreshDisabled: true,
    sourceReadable: true, rolloutPresent: true, stateWritable: true };
  const startupCompletionDiagnostic = {
    phase: "completion",
    requestCount: "one",
    refreshStatus: "failed",
    classifierStatus: "failed",
    classifierReason: "failed",
    failedStep: "accounting",
    controllerError: "refresh_resource_limited",
  };
  let removedFirewall = false;
  let removedProfile = false;
  await assert.rejects(() => runWindowsNormalCandidateSmoke(smokeOptions(), {
    platform: "win32",
    architecture: "x64",
    environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: String.raw`C:\runner\temp` },
    ensureReceiptParent: async () => {},
    reserveReceipt: async () => ({
      writeFile: async (value) => { receipt = JSON.parse(value); },
      sync: async () => {},
      close: async () => {},
    }),
    verifyPackage: async () => ({ sourceRevision: SOURCE_REVISION, artifactSha256: "a".repeat(64), executableSha256: "b".repeat(64) }),
    createRoot: async () => String.raw`C:\runner\temp\owned`,
    prepareProfile: async () => ({ root: String.raw`C:\runner\temp\owned\profile` }),
    seedCodexFixture: async () => {},
    seedProfile: async () => ({ shareBackend: {} }),
    assertProcessAbsence: async () => true,
    installFirewall: async () => FIREWALL_RULE,
    launchJourney: async ({ candidateState }) => {
      candidateState.quiescent = false;
      throw Object.assign(new Error("dashboard"), {
        code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_DASHBOARD_UNAVAILABLE",
        startupDiagnostic,
        startupCompletionDiagnostic,
      });
    },
    verifyOptOut: async () => true,
    removeFirewall: async () => { removedFirewall = true; return true; },
    removeProfile: async () => { removedProfile = true; },
  }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_OWNED_PROCESS_REMAINS",
  });
  assert.equal(removedFirewall, false);
  assert.equal(removedProfile, false);
  assert.equal(receipt.outboundFirewallRuleVerified, true);
  assert.equal(receipt.outboundFirewallRuleRemoved, false);
  assert.equal(receipt.ownedProfileRemoved, false);
  assert.equal(receipt.errorCode, "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_OWNED_PROCESS_REMAINS");
  assert.deepEqual(receipt.startupDiagnostic, startupDiagnostic);
  assert.deepEqual(receipt.startupCompletionDiagnostic, startupCompletionDiagnostic);
});

test("normal candidate refuses to launch before the outbound block is verified", async () => {
  let launched = false;
  let firewallCalls = 0;
  let receipt = null;
  await assert.rejects(runWindowsNormalCandidateSmoke(smokeOptions(), {
    platform: "win32",
    architecture: "x64",
    environment: {
      GITHUB_ACTIONS: "true",
      RUNNER_TEMP: String.raw`C:\runner\temp`,
      SystemRoot: String.raw`C:\Windows`,
    },
    ensureReceiptParent: async () => {},
    reserveReceipt: async () => ({
      writeFile: async (value) => { receipt = JSON.parse(value); },
      sync: async () => {},
      close: async () => {},
    }),
    verifyPackage: async () => ({ sourceRevision: SOURCE_REVISION, artifactSha256: "a".repeat(64), executableSha256: "b".repeat(64) }),
    createRoot: async () => String.raw`C:\runner\temp\owned`,
    prepareProfile: async () => ({ root: String.raw`C:\runner\temp\owned\profile` }),
    seedCodexFixture: async () => {},
    seedProfile: async () => ({ shareBackend: {} }),
    assertProcessAbsence: async () => true,
    installFirewall: (options) => installOutboundFirewallBlock({
      ...options,
      runProgram: async () => {
        firewallCalls += 1;
        return Object.freeze({
          settled: true,
          timedOut: false,
          exitCode: 0,
          output: "unverified",
        });
      },
    }),
    launchJourney: async () => {
      launched = true;
      return passedJourney();
    },
    verifyOptOut: async () => true,
    removeFirewall: async () => true,
    removeProfile: async () => {},
  }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_FIREWALL_UNAVAILABLE",
  });
  assert.equal(firewallCalls, 1);
  assert.equal(launched, false);
  assert.equal(receipt.outboundFirewallRuleVerified, false);
  assert.equal(receipt.packagedElectronExecutionVerified, false);
});
