import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createProductionDistributionMetadata } from "../apps/electron/desktop-updater.js";
import {
  assertSyntheticCodexFixture,
  classifyLinuxNormalPackagedObservation,
  createLinuxNormalPackagedSmokeFixture,
  normalPackagedSmokeEnvironment,
  normalPackagedSmokeFailureStageCode,
  LINUX_STARTUP_DIAGNOSTIC_DETAILS,
  LINUX_STARTUP_DIAGNOSTIC_STEPS,
  readLinuxNormalStartupFailure,
  runLinuxNormalPackagedSmoke,
  runExactAsarSnapshot,
  runExactAsarSnapshotInside,
  parseLinuxNormalPackagedSmokeArguments,
  runLinuxNormalPackagedSmokeSession,
  validateLinuxNormalPackagedSmokeMetadata,
  verifyLinuxNormalPackagedSmokePackage,
} from "../scripts/smoke-electron-linux-packaged.mjs";
import {
  LINUX_COMPANION_PROCESS_DIAGNOSTIC_SCHEMA,
  LINUX_DASHBOARD_FAILURE_DIAGNOSTIC_SCHEMA,
  validateRendererReadinessDiagnostics,
} from "../scripts/smoke-electron-linux.mjs";
import {
  ELECTRON_LINUX_SMOKE_FAILURE_STAGES,
  terminateLinuxSmokeChild,
} from "../scripts/smoke-electron-linux.mjs";

const SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";
const ARTIFACT_SHA256 = "a".repeat(64);
const APP_PATH = "/private/tmp/tibotattle-linux-unpacked/tibotattle";
const FIXTURE_BINARY = resolve("test/fixtures/linux-packaged-codex/codex");

test("Linux failure receipt vocabulary matches the server's closed startup journal", async () => {
  const server = await import("../apps/local/server.js");
  assert.deepEqual([...LINUX_STARTUP_DIAGNOSTIC_STEPS].sort(),
    [...server.LOCAL_STARTUP_DIAGNOSTIC_STEPS].sort());
  assert.deepEqual([...LINUX_STARTUP_DIAGNOSTIC_DETAILS].sort(),
    [...server.LOCAL_STARTUP_DIAGNOSTIC_DETAILS].sort());
});

test("Linux startup journal reader exports the latest fixed failure across retries and rejects unsafe files", async () => {
  const userData = await mkdtemp(join(tmpdir(), "linux-startup-journal-"));
  const state = join(userData, "companion-state");
  const file = join(state, "diagnostics-v0.1.log");
  const note = {
    schemaVersion: "local-diagnostic-note-v0.1", recordedAt: "2026-09-08T00:00:00.000Z",
    reference: "TT-123ABC", surface: "local_startup", code: "snapshot_unavailable",
    requestId: "", step: "data_store", detail: "local_collector_projection_worker_failed",
  };
  try {
    await mkdir(state, { mode: 0o700 });
    const statuses = [];
    const read = () => readLinuxNormalStartupFailure(userData, { onStatus: (status) => statuses.push(status) });
    assert.equal(await read(), null);
    assert.equal(statuses.at(-1), "absent");
    await writeFile(file, `${JSON.stringify(note)}\n`, { mode: 0o600 });
    assert.deepEqual(await readLinuxNormalStartupFailure(userData), {
      step: "data_store", detail: "local_collector_projection_worker_failed",
    });
    await writeFile(file, `${JSON.stringify({ ...note, detail: "private_payload" })}\n`);
    assert.equal(await readLinuxNormalStartupFailure(userData), null);
    await writeFile(file, `${JSON.stringify(note)}\n${JSON.stringify({ ...note, detail: "type_error" })}\n`);
    assert.deepEqual(await read(), { step: "data_store", detail: "type_error" });
    assert.equal(statuses.at(-1), "failure");
    await writeFile(file, `${JSON.stringify(note)}\n`);
    await chmod(file, 0o644);
    assert.equal(await readLinuxNormalStartupFailure(userData), null);
    await chmod(file, 0o600);
    const alias = join(state, "private-alias");
    await link(file, alias);
    assert.equal(await readLinuxNormalStartupFailure(userData), null);
    await rm(file);
    await symlink(alias, file);
    assert.equal(await readLinuxNormalStartupFailure(userData), null);
  } finally { await rm(userData, { recursive: true, force: true }); }
});

test("Linux session and outer receipt preserve a fixed startup failure without widening renderer results", async () => {
  const child = sessionChild();
  const failure = { step: "data_store", detail: "type_error" };
  const emitFailure = () => queueMicrotask(() => {
    child.stdout.end();
    child.stderr.write("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SOURCE_SMOKE_RENDERER_READINESS_MARKER_FALSE_TITLE_TRUE_HEADING_TRUE_FAILED\n");
    child.stderr.write(`${JSON.stringify({
      schemaVersion: "tibotattle-electron-linux-normal-packaged-startup-failure-v1",
      companionStartupJournalStatus: "failure",
      companionStartupFailure: failure,
    })}\n`);
    child.stderr.end();
    child.exitCode = 1;
    child.emit("exit", 1, null);
  });
  const identity = { sourceRevision: SOURCE_REVISION, artifactSha256: ARTIFACT_SHA256 };
  const receipt = await runLinuxNormalPackagedSmoke({
    sourceRevision: SOURCE_REVISION, receiptPath: "/private/tmp/linux-startup-receipt.json",
  }, {
    verifyPackage: async () => identity,
    runSession: () => runLinuxNormalPackagedSmokeSession(identity, {
      appPath: APP_PATH, spawnSession: () => { emitFailure(); return child; },
    }),
    reserve: async () => ({}), write: async () => {},
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.packagedElectronExecutionVerified, false);
  assert.deepEqual(receipt.companionStartupFailure, failure);
  assert.equal(receipt.companionStartupJournalStatus, "failure");
  assert.equal(receipt.rendererReadinessDiagnostics, undefined);
  const missingJournal = await runLinuxNormalPackagedSmoke({ sourceRevision: SOURCE_REVISION }, {
    verifyPackage: async () => identity,
    runSession: async () => { throw Object.assign(new Error("private content"), {
      code: receipt.errorCode, companionStartupJournalStatus: "absent",
    }); },
    reserve: async () => ({}), write: async () => {},
  });
  assert.equal(missingJournal.companionStartupJournalStatus, "absent");
  assert.equal(missingJournal.companionStartupFailure, undefined);
  assert.equal(JSON.stringify(missingJournal).includes("private content"), false);
});

test("Linux session and outer receipt preserve closed process observations and reject forged fields", async () => {
  const diagnostic = {
    lastEvent: { event: "started", phase: "starting", outcome: null },
    firstUnexpectedExit: { event: "exited", phase: "ready", outcome: "signal_abrt" },
  };
  const identity = { sourceRevision: SOURCE_REVISION, artifactSha256: ARTIFACT_SHA256 };
  const dashboardFailure = { stage: "render_process_gone", reason: "oom" };
  for (const value of [diagnostic, { ...diagnostic, stderr: "private payload" }]) {
    const child = sessionChild();
    const receipt = await runLinuxNormalPackagedSmoke({ sourceRevision: SOURCE_REVISION }, {
      verifyPackage: async () => identity,
      runSession: () => runLinuxNormalPackagedSmokeSession(identity, {
        appPath: APP_PATH, spawnSession: () => {
          queueMicrotask(() => {
            child.stdout.end();
            child.stderr.write("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SOURCE_SMOKE_RENDERER_READINESS_MARKER_FALSE_TITLE_TRUE_HEADING_TRUE_FAILED\n");
            child.stderr.write(`${JSON.stringify({
              schemaVersion: LINUX_COMPANION_PROCESS_DIAGNOSTIC_SCHEMA,
              companionProcessDiagnostics: value,
            })}\n`);
            child.stderr.end(`${JSON.stringify({
              schemaVersion: LINUX_DASHBOARD_FAILURE_DIAGNOSTIC_SCHEMA,
              dashboardLoadFailure: value === diagnostic ? dashboardFailure
                : { ...dashboardFailure, private: "payload" },
            })}\n`);
            child.exitCode = 1;
            child.emit("exit", 1, null);
          });
          return child;
        },
      }),
      reserve: async () => ({}), write: async () => {},
    });
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.packagedElectronExecutionVerified, false);
    assert.deepEqual(receipt.companionProcessDiagnostics, value === diagnostic ? diagnostic : undefined);
    assert.deepEqual(receipt.dashboardLoadFailure, value === diagnostic ? dashboardFailure : undefined);
    assert.equal(JSON.stringify(receipt).includes("private payload"), false);
  }
});

test("Linux session retains only fixed automatic refresh failure classifiers", async () => {
  const identity = { sourceRevision: SOURCE_REVISION, artifactSha256: ARTIFACT_SHA256 };
  const fixed = "ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_RECEIPT_CHANGED";
  for (const value of [fixed, "private refresh detail"]) {
    const child = sessionChild();
    const receipt = await runLinuxNormalPackagedSmoke({ sourceRevision: SOURCE_REVISION }, {
      verifyPackage: async () => identity,
      runSession: () => runLinuxNormalPackagedSmokeSession(identity, {
        appPath: APP_PATH, spawnSession: () => {
          queueMicrotask(() => {
            child.stdout.end();
            child.stderr.write("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SOURCE_SMOKE_RELOAD_REFRESH_FAILED\n");
            child.stderr.end(`${JSON.stringify({
              schemaVersion: "tibotattle-electron-linux-normal-packaged-automatic-refresh-failure-v1",
              automaticRefreshFailure: value,
            })}\n`);
            child.exitCode = 1;
            child.emit("exit", 1, null);
          });
          return child;
        },
      }),
      reserve: async () => ({}), write: async () => {},
    });
    assert.equal(receipt.errorCode,
      "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SOURCE_SMOKE_RELOAD_REFRESH_FAILED");
    assert.equal(receipt.automaticRefreshFailure, value === fixed ? fixed : undefined);
    assert.equal(JSON.stringify(receipt).includes("private refresh detail"), false);
  }
});

function productionMetadata(sourceRevision = SOURCE_REVISION) {
  return createProductionDistributionMetadata({
    buildNumber: "12345",
    sourceRevision,
    target: "linux-x64",
  });
}

function sourceCandidate({ sourceRevision = SOURCE_REVISION, version = "0.1.0" } = {}) {
  return {
    status: "production_source_staged",
    target: "linux-x64",
    sourceRevision,
    version,
    stagingDirectory: ".release-build/electron-production/linux-x64/app",
    builderConfiguration: "apps/electron/electron-builder.production.config.cjs",
    updaterEnabled: true,
    signingRequired: false,
    signingPerformed: false,
    publishingPerformed: false,
  };
}

function validInnerReceipt() {
  return {
    schemaVersion: "tibotattle-electron-linux-normal-packaged-smoke-v1",
    status: "passed",
    scope: "candidate_only",
    target: "linux-x64",
    execution: "packaged_electron_normal",
    sourceRevision: SOURCE_REVISION,
    artifactSha256: ARTIFACT_SHA256,
    availableServiceRefresh: "completed",
    accountObservationLifecycle: "available",
    unavailableServiceResponse: "bounded",
    cleanup: "owned_apps_stopped",
    productionReady: false,
  };
}

function validRendererReadinessDiagnostics() {
  const assets = [
    "app.js", "community-data.js", "data-client.js", "desktop-shell.js",
    "i18n.generated.js", "install-cta.js", "lib.js", "localization.js",
    "navigation.js", "telemetry-envelope.js", "telemetry-shared.generated.js",
    "ui-format.js",
  ].map((asset) => ({
    asset,
    responseClass: asset === "app.js" ? "2xx" : "unobserved",
    completion: asset === "app.js" ? "finished" : "unobserved",
  }));
  return validateRendererReadinessDiagnostics({
    exception: {
      observed: true, classification: "type", asset: "app.js", line: 24,
    },
    assets,
    primaryApis: [
      { endpoint: "overview", responseClass: "5xx", completion: "finished" },
      { endpoint: "gradient", responseClass: "2xx", completion: "finished" },
      { endpoint: "weekly", responseClass: "unobserved", completion: "failed" },
      { endpoint: "quality", responseClass: "unobserved", completion: "unobserved" },
    ],
    primaryProbe: [
      { endpoint: "overview", responseClass: "5xx", outcome: "response" },
      { endpoint: "gradient", responseClass: "2xx", outcome: "response" },
      { endpoint: "weekly", responseClass: "unobserved", outcome: "request_failed" },
      { endpoint: "quality", responseClass: "unobserved", outcome: "timeout" },
    ],
    companionSnapshot: {
      status: "failed",
      errorCode: "collector_projection_unavailable",
    },
  });
}

function sessionChild() {
  const child = new EventEmitter();
  child.pid = 48_321;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test("normal packaged Linux smoke accepts only closed outer and inner arguments", () => {
  assert.deepEqual(parseLinuxNormalPackagedSmokeArguments([
    "--app", APP_PATH,
    "--staged-app", "/private/tmp/tibotattle-linux-stage/app",
    "--source-candidate", "/private/tmp/tibotattle-linux-stage/production-source-candidate.json",
    "--source-revision", SOURCE_REVISION,
    "--receipt", "/private/tmp/tibotattle-linux-receipt.json",
  ]), {
    mode: "outer",
    appPath: APP_PATH,
    stagedAppPath: "/private/tmp/tibotattle-linux-stage/app",
    sourceCandidatePath: "/private/tmp/tibotattle-linux-stage/production-source-candidate.json",
    sourceRevision: SOURCE_REVISION,
    receiptPath: "/private/tmp/tibotattle-linux-receipt.json",
  });
  assert.deepEqual(parseLinuxNormalPackagedSmokeArguments([
    "--inside-isolated-session",
    "--app", APP_PATH,
    "--source-revision", SOURCE_REVISION,
    "--artifact-digest", ARTIFACT_SHA256,
  ]), {
    mode: "inside",
    appPath: APP_PATH,
    sourceRevision: SOURCE_REVISION,
    artifactSha256: ARTIFACT_SHA256,
  });
  for (const invalid of [
    ["--app", APP_PATH],
    ["--inside-isolated-session", "--app", APP_PATH, "--source-revision", SOURCE_REVISION,
      "--artifact-digest", ARTIFACT_SHA256, "--receipt", "/private/tmp/extra.json"],
    ["--app", APP_PATH, "--app", APP_PATH,
      "--staged-app", "/private/tmp/stage", "--source-candidate", "/private/tmp/source.json",
      "--source-revision", SOURCE_REVISION, "--receipt", "/private/tmp/receipt.json"],
  ]) {
    assert.throws(() => parseLinuxNormalPackagedSmokeArguments(invalid), {
      code: "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_ARGUMENT_INVALID",
    });
  }
});

test("normal packaged Linux smoke binds staged and archived stable metadata to the candidate", () => {
  const metadata = productionMetadata();
  const manifest = { version: "0.1.0", tibotattleDistribution: metadata };
  const valid = validateLinuxNormalPackagedSmokeMetadata({
    sourceCandidate: sourceCandidate(), stagedManifest: manifest, archiveManifest: structuredClone(manifest),
    sourceRevision: SOURCE_REVISION,
  });
  assert.equal(valid.target, "linux-x64");
  assert.equal(valid.sourceRevision, SOURCE_REVISION);
  assert.throws(() => validateLinuxNormalPackagedSmokeMetadata({
    sourceCandidate: sourceCandidate(), stagedManifest: manifest,
    archiveManifest: { ...manifest, tibotattleDistribution: productionMetadata("fedcba9876543210fedcba9876543210fedcba98") },
    sourceRevision: SOURCE_REVISION,
  }), { code: "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_PACKAGE_IDENTITY_INVALID" });
  assert.throws(() => validateLinuxNormalPackagedSmokeMetadata({
    sourceCandidate: { ...sourceCandidate(), target: "darwin-arm64" },
    stagedManifest: manifest, archiveManifest: manifest, sourceRevision: SOURCE_REVISION,
  }), { code: "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SOURCE_CANDIDATE_INVALID" });
});

test("normal packaged Linux smoke verifies the exact source, ASAR, executable, and native pair before launch", async () => {
  const metadata = productionMetadata();
  const manifest = { version: "0.1.0", tibotattleDistribution: metadata };
  let nativeInputs = null;
  const result = await verifyLinuxNormalPackagedSmokePackage({
    appPath: APP_PATH,
    stagedAppPath: "/private/tmp/tibotattle-linux-stage/app",
    sourceCandidatePath: "/private/tmp/tibotattle-linux-stage/production-source-candidate.json",
    sourceRevision: SOURCE_REVISION,
  }, {
    platform: "linux",
    architecture: "x64",
    readJsonFile: async (path) => path.endsWith("production-source-candidate.json")
      ? sourceCandidate() : manifest,
    readArchiveManifest: async () => structuredClone(manifest),
    digest: async (path) => ({ bytes: path.endsWith("app.asar") ? 22 : 11, sha256: "b".repeat(64) }),
    validateNative: async (inputs) => {
      nativeInputs = inputs;
      return { keytarSha256: "c".repeat(64), mutexSha256: "d".repeat(64) };
    },
  });
  assert.deepEqual(nativeInputs, {
    appPath: APP_PATH,
    stagedAppPath: "/private/tmp/tibotattle-linux-stage/app",
  });
  assert.deepEqual(result, {
    artifactSha256: "b".repeat(64),
    executableSha256: "b".repeat(64),
    native: { keytarSha256: "c".repeat(64), mutexSha256: "d".repeat(64) },
    sourceRevision: SOURCE_REVISION,
    target: "linux-x64",
  });
});

test("normal packaged Linux smoke uses an image-owned codex fixture and strips inherited selectors", async () => {
  assert.equal(await assertSyntheticCodexFixture({
    metadata: async () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      uid: 0,
      mode: 0o100555,
    }),
  }), "/opt/tibotattle-linux-packaged-smoke/bin");
  await assert.rejects(assertSyntheticCodexFixture({
    metadata: async () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      uid: 1000,
      mode: 0o100755,
    }),
  }), { code: "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_CONTAINER_INVALID" });

  const fixture = {
    claudeHome: "/private/tmp/private-claude",
    codexHome: "/private/tmp/private-home/.codex",
    home: "/private/tmp/private-home",
    root: "/private/tmp/private-root",
    unavailableBusAddress: "unix:path=/private/tmp/private-root/absent-session-bus",
  };
  const selected = normalPackagedSmokeEnvironment({
    fixture,
    service: "unavailable",
    environment: {
      PATH: "/usr/bin",
      HOME: "/private/tmp/home",
      XDG_CONFIG_HOME: "/private/tmp/config",
      XDG_CACHE_HOME: "/private/tmp/cache",
      XDG_DATA_HOME: "/private/tmp/data",
      XDG_RUNTIME_DIR: "/private/tmp/runtime",
      CODEX_BIN: "/private/tmp/ambient-codex",
      ELECTRON_RUN_AS_NODE: "1",
      USAGE_MONITOR_RESOURCE_ROOT: "/private/tmp/ambient-resource",
      USAGE_MONITOR_STATE_ROOT: "/private/tmp/ambient-state",
      USAGE_MONITOR_TEST_LANE: "ambient",
      USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_BROKER_IPC: "1",
      XDG_STATE_HOME: "/private/tmp/ambient-xdg-state",
    },
  });
  assert.equal(selected.PATH, "/opt/tibotattle-linux-packaged-smoke/bin:/usr/bin");
  assert.equal(selected.DBUS_SESSION_BUS_ADDRESS, fixture.unavailableBusAddress);
  assert.equal(selected.HOME, fixture.home);
  assert.equal(selected.CODEX_HOME, fixture.codexHome);
  assert.equal(selected.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL, "quit-v1");
  for (const key of [
    "CODEX_BIN", "ELECTRON_RUN_AS_NODE", "USAGE_MONITOR_RESOURCE_ROOT",
    "USAGE_MONITOR_STATE_ROOT", "USAGE_MONITOR_TEST_LANE",
    "USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_BROKER_IPC", "XDG_STATE_HOME",
  ]) assert.equal(Object.hasOwn(selected, key), false, key);
});

test("normal packaged Linux smoke fixture keeps raw input private and the app-server dependency image-owned", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "tibotattle-linux-normal-packaged-test-"));
  try {
    const fixture = await createLinuxNormalPackagedSmokeFixture({ runtimeDirectory: runtime });
    assert.equal(Object.hasOwn(fixture, "binaryDirectory"), false);
    assert.equal((await stat(fixture.root)).mode & 0o777, 0o700);
    assert.equal(fixture.codexHome, join(fixture.home, ".codex"));
    assert.equal((await stat(join(fixture.codexHome, "sessions", "synthetic-linux-smoke.jsonl"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(fixture.userData, "desktop-settings", "desktop-first-run-v1.json"))).mode & 0o777, 0o600);
    assert.equal(fixture.stateFile,
      join(fixture.userData, "companion-state", "local-collector-state-v1.sqlite"));
    const selected = normalPackagedSmokeEnvironment({
      fixture,
      service: "available",
      environment: {
        PATH: "/usr/bin",
        HOME: join(runtime, "ambient-home"),
        XDG_CONFIG_HOME: join(runtime, "config"),
        XDG_CACHE_HOME: join(runtime, "cache"),
        XDG_DATA_HOME: join(runtime, "data"),
        XDG_RUNTIME_DIR: runtime,
      },
    });
    assert.equal(selected.HOME, fixture.home);
    assert.equal(selected.CODEX_HOME, join(selected.HOME, ".codex"));
  } finally {
    await rm(runtime, { recursive: true, force: true });
  }
});

test("image fixture answers only the minimal synthetic app-server contract", async () => {
  const version = spawnSync(FIXTURE_BINARY, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^codex [0-9]+\.[0-9]+\.[0-9]+\n$/u);
  const child = spawn(FIXTURE_BINARY, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
  const output = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => output.push(...chunk.trim().split("\n").filter(Boolean)));
  child.stdin.write(`${JSON.stringify({ id: 0, method: "initialize", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ id: 1, method: "account/read", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ id: 2, method: "account/rateLimits/read", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ id: 3, method: "account/usage/read", params: {} })}\n`);
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("fixture response timeout")), 2_000);
    const ready = () => {
      if (output.length !== 4) return;
      clearTimeout(timer);
      resolveReady();
    };
    child.stdout.on("data", ready);
    child.once("error", rejectReady);
    ready();
  });
  child.stdin.end();
  await once(child, "exit");
  assert.equal(child.exitCode, 0);
  const messages = output.map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.id), [0, 1, 2, 3]);
  assert.equal(messages[0].result !== undefined, true);
  assert.equal(messages[1].result?.account?.planType, "pro");
  assert.equal(messages[2].result?.rateLimits?.limitId, "codex");
  assert.equal(Array.isArray(messages[3].result?.dailyUsageBuckets), true);
});

test("normal packaged Linux smoke keeps available and unavailable observation evidence distinct", () => {
  const available = {
    accountScopeMarker: {
      accountScope: {
        status: "available",
        version: "openai-account-v1",
        scopeId: `openai-account:v1:${"A".repeat(43)}`,
      },
    },
  };
  assert.equal(classifyLinuxNormalPackagedObservation(available, "available"), "available");
  assert.equal(classifyLinuxNormalPackagedObservation({ accountScopeMarker: null }, "unavailable"), "unavailable");
  assert.equal(classifyLinuxNormalPackagedObservation(available, "unavailable"), "invalid");
  assert.equal(classifyLinuxNormalPackagedObservation({ accountScopeMarker: null }, "available"), "invalid");
});

test("normal packaged Linux smoke maps each shared source failure boundary to a closed receipt code", () => {
  assert.deepEqual(Object.fromEntries(ELECTRON_LINUX_SMOKE_FAILURE_STAGES.map(
    (stage) => [stage, normalPackagedSmokeFailureStageCode(stage)],
  )), {
    startup: "SOURCE_SMOKE_STARTUP_FAILED",
    target: "SOURCE_SMOKE_TARGET_FAILED",
    renderer_readiness_unobserved: "SOURCE_SMOKE_RENDERER_READINESS_UNOBSERVED_FAILED",
    renderer_readiness_marker_false_title_false_heading_false:
      "SOURCE_SMOKE_RENDERER_READINESS_MARKER_FALSE_TITLE_FALSE_HEADING_FALSE_FAILED",
    renderer_readiness_marker_false_title_false_heading_true:
      "SOURCE_SMOKE_RENDERER_READINESS_MARKER_FALSE_TITLE_FALSE_HEADING_TRUE_FAILED",
    renderer_readiness_marker_false_title_true_heading_false:
      "SOURCE_SMOKE_RENDERER_READINESS_MARKER_FALSE_TITLE_TRUE_HEADING_FALSE_FAILED",
    renderer_readiness_marker_false_title_true_heading_true:
      "SOURCE_SMOKE_RENDERER_READINESS_MARKER_FALSE_TITLE_TRUE_HEADING_TRUE_FAILED",
    renderer_readiness_marker_true_title_false_heading_false:
      "SOURCE_SMOKE_RENDERER_READINESS_MARKER_TRUE_TITLE_FALSE_HEADING_FALSE_FAILED",
    renderer_readiness_marker_true_title_false_heading_true:
      "SOURCE_SMOKE_RENDERER_READINESS_MARKER_TRUE_TITLE_FALSE_HEADING_TRUE_FAILED",
    renderer_readiness_marker_true_title_true_heading_false:
      "SOURCE_SMOKE_RENDERER_READINESS_MARKER_TRUE_TITLE_TRUE_HEADING_FALSE_FAILED",
    renderer_origin: "SOURCE_SMOKE_RENDERER_ORIGIN_FAILED",
    renderer_health: "SOURCE_SMOKE_RENDERER_HEALTH_FAILED",
    renderer_resource: "SOURCE_SMOKE_RENDERER_RESOURCE_FAILED",
    renderer_navigation: "SOURCE_SMOKE_RENDERER_NAVIGATION_FAILED",
    initial_refresh: "SOURCE_SMOKE_INITIAL_REFRESH_FAILED",
    reload_refresh: "SOURCE_SMOKE_RELOAD_REFRESH_FAILED",
    observation: "SOURCE_SMOKE_OBSERVATION_FAILED",
    renderer_late_network: "SOURCE_SMOKE_RENDERER_LATE_NETWORK_FAILED",
    quit_cleanup: "SOURCE_SMOKE_QUIT_CLEANUP_FAILED",
  });
  assert.equal(normalPackagedSmokeFailureStageCode("private renderer detail"), null);
});

test("normal packaged Linux session and outer receipt retain only validated renderer readiness diagnostics", async () => {
  const diagnostic = validRendererReadinessDiagnostics();
  assert.notEqual(diagnostic, null);
  const child = sessionChild();
  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.write("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SOURCE_SMOKE_RENDERER_READINESS_MARKER_FALSE_TITLE_TRUE_HEADING_TRUE_FAILED\n");
    child.stderr.write(`${JSON.stringify({
      schemaVersion: "tibotattle-electron-linux-normal-packaged-renderer-readiness-diagnostic-v2",
      rendererReadinessDiagnostics: diagnostic,
    })}\n`);
    child.stderr.end();
    child.exitCode = 1;
    child.emit("exit", 1, null);
  });
  let sessionFailure = null;
  await assert.rejects(runLinuxNormalPackagedSmokeSession({
    sourceRevision: SOURCE_REVISION,
    artifactSha256: ARTIFACT_SHA256,
  }, { appPath: APP_PATH, spawnSession: () => child }), (error) => {
    sessionFailure = error;
    return error?.code
      === "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SOURCE_SMOKE_RENDERER_READINESS_MARKER_FALSE_TITLE_TRUE_HEADING_TRUE_FAILED";
  });
  assert.deepEqual(sessionFailure?.rendererReadinessDiagnostics, diagnostic);

  let written = null;
  const receipt = await runLinuxNormalPackagedSmoke({
    appPath: APP_PATH,
    receiptPath: "/private/tmp/tibotattle-linux-receipt.json",
    sourceRevision: SOURCE_REVISION,
  }, {
    verifyPackage: async () => ({
      sourceRevision: SOURCE_REVISION,
      artifactSha256: ARTIFACT_SHA256,
      executableSha256: "b".repeat(64),
    }),
    runSession: async () => { throw sessionFailure; },
    reserve: async () => Object.freeze({}),
    write: async (_handle, value) => { written = value; },
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.errorCode,
    "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SOURCE_SMOKE_RENDERER_READINESS_MARKER_FALSE_TITLE_TRUE_HEADING_TRUE_FAILED");
  assert.deepEqual(receipt.rendererReadinessDiagnostics, diagnostic);
  assert.deepEqual(written, receipt);
});

test("forced Linux child cleanup never acts as the normal clean-quit proof", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGTERM") {
      child.exitCode = 143;
      queueMicrotask(() => child.emit("exit", 143, null));
    }
    return true;
  };
  assert.equal(await terminateLinuxSmokeChild(child, { graceMs: 20 }), true);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(child.exitCode, 143);
});

test("normal packaged Linux session timeout requires owned-session cleanup and remains failed", async () => {
  const child = sessionChild();
  let cleanupCalls = 0;
  await assert.rejects(runLinuxNormalPackagedSmokeSession({
    sourceRevision: SOURCE_REVISION,
    artifactSha256: ARTIFACT_SHA256,
  }, {
    appPath: APP_PATH,
    deadlineMs: 1,
    spawnSession: () => child,
    stopSession: async (owned) => {
      cleanupCalls += 1;
      assert.equal(owned, child);
      return true;
    },
  }), { code: "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SESSION_DEADLINE_EXCEEDED" });
  assert.equal(cleanupCalls, 1);
  await assert.rejects(runLinuxNormalPackagedSmokeSession({
    sourceRevision: SOURCE_REVISION,
    artifactSha256: ARTIFACT_SHA256,
  }, {
    appPath: APP_PATH,
    deadlineMs: 1,
    spawnSession: () => sessionChild(),
    stopSession: async () => false,
  }), { code: "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SESSION_CLEANUP_UNCONFIRMED" });
});

test("normal packaged Linux session accepts only the fixed clean inner receipt", async () => {
  const child = sessionChild();
  queueMicrotask(() => {
    child.stdout.write(`${JSON.stringify(validInnerReceipt())}\n`);
    child.stdout.end();
    child.stderr.end();
    child.exitCode = 0;
    child.emit("exit", 0, null);
  });
  const receipt = await runLinuxNormalPackagedSmokeSession({
    sourceRevision: SOURCE_REVISION,
    artifactSha256: ARTIFACT_SHA256,
  }, { appPath: APP_PATH, spawnSession: () => child });
  assert.deepEqual(receipt, validInnerReceipt());
});

test("normal packaged Linux session retains a closed observation failure stage", async () => {
  const child = sessionChild();
  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.write("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_OBSERVATION_UNAVAILABLE\n");
    child.stderr.end();
    child.exitCode = 1;
    child.emit("exit", 1, null);
  });
  await assert.rejects(runLinuxNormalPackagedSmokeSession({
    sourceRevision: SOURCE_REVISION,
    artifactSha256: ARTIFACT_SHA256,
  }, { appPath: APP_PATH, spawnSession: () => child }), {
    code: "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_OBSERVATION_UNAVAILABLE",
  });
});

test("normal packaged Linux session retains a closed renderer substage", async () => {
  const child = sessionChild();
  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.write("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SOURCE_SMOKE_RENDERER_LATE_NETWORK_FAILED\n");
    child.stderr.end();
    child.exitCode = 1;
    child.emit("exit", 1, null);
  });
  await assert.rejects(runLinuxNormalPackagedSmokeSession({
    sourceRevision: SOURCE_REVISION,
    artifactSha256: ARTIFACT_SHA256,
  }, { appPath: APP_PATH, spawnSession: () => child }), {
    code: "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SOURCE_SMOKE_RENDERER_LATE_NETWORK_FAILED",
  });
});

test("normal packaged Linux session separates execution, receipt, and passing-receipt stderr failures", async () => {
  const failedChild = sessionChild();
  queueMicrotask(() => {
    failedChild.stdout.end();
    failedChild.stderr.write("private runner detail\nELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_FAILED\n");
    failedChild.stderr.end();
    failedChild.exitCode = 1;
    failedChild.emit("exit", 1, null);
  });
  let executionFailure;
  await assert.rejects(runLinuxNormalPackagedSmokeSession({
    sourceRevision: SOURCE_REVISION,
    artifactSha256: ARTIFACT_SHA256,
  }, { appPath: APP_PATH, spawnSession: () => failedChild }), (error) => {
    executionFailure = error;
    return error?.code === "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SESSION_EXECUTION_FAILED";
  });
  assert.equal(String(executionFailure?.message).includes("private runner detail"), false);

  const invalidReceiptChild = sessionChild();
  queueMicrotask(() => {
    invalidReceiptChild.stdout.write("not-json\n");
    invalidReceiptChild.stdout.end();
    invalidReceiptChild.stderr.end();
    invalidReceiptChild.exitCode = 0;
    invalidReceiptChild.emit("exit", 0, null);
  });
  await assert.rejects(runLinuxNormalPackagedSmokeSession({
    sourceRevision: SOURCE_REVISION,
    artifactSha256: ARTIFACT_SHA256,
  }, { appPath: APP_PATH, spawnSession: () => invalidReceiptChild }), {
    code: "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SESSION_RECEIPT_INVALID",
  });

  const stderrChild = sessionChild();
  queueMicrotask(() => {
    stderrChild.stdout.write(`${JSON.stringify(validInnerReceipt())}\n`);
    stderrChild.stdout.end();
    stderrChild.stderr.write("D-Bus activation diagnostic\n");
    stderrChild.stderr.end();
    stderrChild.exitCode = 0;
    stderrChild.emit("exit", 0, null);
  });
  await assert.rejects(runLinuxNormalPackagedSmokeSession({
    sourceRevision: SOURCE_REVISION,
    artifactSha256: ARTIFACT_SHA256,
  }, { appPath: APP_PATH, spawnSession: () => stderrChild }), {
    code: "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_PASS_RECEIPT_STDERR_REJECTED",
  });
});


test("exact ASAR snapshot uses the production startup store and fixed failure codes", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "linux-exact-snapshot-"));
  try {
    for (const errorCode of [null, "local_collector_projection_worker_failed", "private-detail"]) {
      const snapshotRoot = await mkdtemp(join(runtime, "fixture-"));
      const modules = [];
      let initialized = false;
      const receipt = await runExactAsarSnapshotInside({
        appPath: APP_PATH, sourceRevision: SOURCE_REVISION, artifactSha256: ARTIFACT_SHA256,
        snapshotRoot: await (await import("node:fs/promises")).realpath(snapshotRoot),
      }, {
        assertRuntime: async () => {},
        loadModule: async (url) => {
          modules.push(url);
          if (url.endsWith("local-installation-diagnostics.js")) {
            return import("../src/local-installation-diagnostics.js");
          }
          return {
            buildLocalCompanionSnapshot: async (options) => {
              assert.equal(options.accountingSourceMode, "unified");
              assert.equal(options.unifiedProjectionMode, "deferred");
              assert.equal(options.archiveIndexFile, null);
              assert.ok(options.codexHome.endsWith("/home/.codex"));
            },
            LocalCompanionDataStore: class {
              constructor(options) {
                assert.ok(options.snapshotFile.endsWith(".json"));
                this.options = options;
              }
              async initialize(options) {
                assert.equal(options.purpose, "startup");
                initialized = true;
                await this.options.builder();
                if (errorCode !== null) throw Object.assign(new Error("private detail"), { code: errorCode });
              }
            },
          };
        },
      });
      assert.equal(initialized, true);
      assert.equal(modules.length, 2);
      assert.ok(modules.every((url) => url.includes("/resources/app.asar/src/")));
      assert.equal(receipt.errorCode, errorCode === null ? null
        : errorCode === "local_collector_projection_worker_failed"
          ? "SNAPSHOT_COLLECTOR_PROJECTION_WORKER_FAILED" : "SNAPSHOT_UNKNOWN_FAILED");
      assert.equal(JSON.stringify(receipt).includes("private"), false);
    }
  } finally { await rm(runtime, { recursive: true, force: true }); }
});

test("exact ASAR diagnostic accepts only one bound child receipt and removes stopped fixtures", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "linux-snapshot-child-"));
  try {
    for (const mode of ["passed", "failed", "extra"]) {
      let fixture;
      const operation = runExactAsarSnapshot({ sourceRevision: SOURCE_REVISION, artifactSha256: ARTIFACT_SHA256 }, {
        appPath: APP_PATH, environment: { XDG_RUNTIME_DIR: runtime, HOME: runtime },
        spawnChild: (app, args, spec) => {
          assert.equal(app, APP_PATH);
          assert.equal(spec.env.ELECTRON_RUN_AS_NODE, "1");
          assert.equal(args[1], "--inside-exact-asar-snapshot");
          fixture = args.at(-1);
          const child = new EventEmitter();
          child.stdout = new PassThrough(); child.stderr = new PassThrough();
          child.exitCode = null; child.signalCode = null;
          queueMicrotask(() => {
            const receipt = {
              schemaVersion: "tibotattle-electron-linux-normal-packaged-snapshot-diagnostic-v1",
              status: mode === "failed" ? "failed" : "passed", scope: "candidate_only", target: "linux-x64",
              execution: "packaged_electron_run_as_node", sourceRevision: SOURCE_REVISION,
              artifactSha256: ARTIFACT_SHA256,
              errorCode: mode === "failed" ? "SNAPSHOT_COLLECTOR_PROJECTION_WORKER_FAILED" : null,
              ...(mode === "extra" ? { private: "discard" } : {}),
            };
            child.exitCode = mode === "failed" ? 1 : 0;
            child.emit("exit", child.exitCode, null);
            // The receipt can drain after exit; wait for the stdio close event.
            child.stdout.end(JSON.stringify(receipt));
            child.stderr.end();
            child.emit("close", child.exitCode, null);
          });
          return child;
        },
      });
      if (mode === "passed") assert.equal((await operation).status, "passed");
      else await assert.rejects(operation, { code: mode === "failed"
        ? "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SNAPSHOT_COLLECTOR_PROJECTION_WORKER_FAILED"
        : "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SNAPSHOT_RECEIPT_INVALID" });
      await assert.rejects(stat(fixture), { code: "ENOENT" });
    }
  } finally { await rm(runtime, { recursive: true, force: true }); }
});

test("exact ASAR diagnostic retains its private fixture when timeout cleanup cannot be proved", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "linux-snapshot-timeout-"));
  let fixture;
  try {
    await assert.rejects(runExactAsarSnapshot({ sourceRevision: SOURCE_REVISION, artifactSha256: ARTIFACT_SHA256 }, {
      appPath: APP_PATH, environment: { XDG_RUNTIME_DIR: runtime },
      spawnChild: (_app, args) => {
        fixture = args.at(-1);
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.exitCode = null; child.signalCode = null;
        return child;
      },
      waitForExit: async () => null,
      stopChild: async () => false,
    }), { code: "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SNAPSHOT_CLEANUP_UNCONFIRMED" });
    assert.equal((await stat(fixture)).mode & 0o777, 0o700);
  } finally { await rm(runtime, { recursive: true, force: true }); }
});

test("exact ASAR diagnostic classifies fixture creation failure without exposing its path", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "linux-snapshot-missing-root-"));
  await rm(runtime, { recursive: true });
  await assert.rejects(runExactAsarSnapshot({
    sourceRevision: SOURCE_REVISION, artifactSha256: ARTIFACT_SHA256,
  }, {
    appPath: APP_PATH, environment: { XDG_RUNTIME_DIR: runtime },
    spawnChild: () => assert.fail("a missing fixture must never launch Electron"),
  }), {
    code: "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SNAPSHOT_FIXTURE_INVALID",
    message: "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_SNAPSHOT_FIXTURE_INVALID",
  });
});
