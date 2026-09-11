import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import * as application from "../src/application/index.js";
import * as applicationOwner from "../src/application/export-sources/index.js";
import * as platform from "../src/platform/index.js";
import * as platformOwner from "../src/platform/local-export-source-ports.js";
import { localExportSourcePipeline as pipeline } from
  "../src/local-node-runtime.js";
import { runLocalReview } from "../local-review/cli.js";

const ROOT = resolve(import.meta.dirname, "..");
const LEGACY = Object.freeze({
  "export-set-controller": ["controller", [
    "createLocalExportWorkspace", "inspectLocalExportWorkspace", "resumeLocalExportWorkspace",
  ]],
  "export-source-plan": ["codexSourcePlan", [
    "EXPORT_SOURCE_PLAN_VERSION", "ExportSourcePlanError", "createCodexExportSourcePlan",
    "openVerifiedCodexExportSource", "resolveCodexExportSourcePlan", "summarizeExportSourcePlan",
    "verifyCodexExportSourceHandle", "verifyCodexExportSourcePlan",
  ]],
  "export-source-plan-bundle": ["sourcePlanBundle", [
    "EXPORT_SOURCE_PLAN_BUNDLE_VERSION", "ExportSourcePlanBundleError", "createExportSourcePlanBundle",
    "exportSourcePlanBundleFailureContext",
    "resolveExportSourcePlanBundle", "summarizeExportSourcePlanBundle",
  ]],
  "codex-export-checkpoint-scan": ["codexCheckpoint", [
    "CODEX_CHECKPOINT_SCAN_VERSION", "DEFAULT_CHECKPOINT_LINES_PER_BATCH", "populateCheckpointedCodexSources",
  ]],
  "codex-collector-export-source": ["codexCollectorExport", [
    "CODEX_COLLECTOR_CANDIDATE_VERSION", "CODEX_COLLECTOR_SOURCE_CURSOR_VERSION",
    "CODEX_COLLECTOR_SOURCE_PLAN_VERSION", "CodexCollectorExportSourceError",
    "createCodexCollectorExportCursor", "createCodexCollectorExportSourcePlan",
    "scanCodexCollectorExportSource", "verifyCodexCollectorExportSourcePlan",
  ]],
  "codex-collector-workspace-source": ["codexCollectorWorkspace", [
    "CODEX_COLLECTOR_DIAGNOSTIC_REGISTRY_CODES", "CODEX_COLLECTOR_WORKSPACE_SOURCE_VERSION",
    "CodexCollectorWorkspaceSourceError", "DEFAULT_CODEX_COLLECTOR_CANDIDATES_PER_BATCH",
    "appendCodexCollectorWorkspaceSource", "codexCollectorWorkspaceSourceKey", "collectorPlanningGuard",
    "createCodexCollectorWorkspaceSource", "populateCodexCollectorWorkspaceSource",
    "resolveCodexCollectorWorkspaceSource", "summarizeCodexCollectorDiagnostics",
  ]],
  "claude-statusline-export-source": ["claudeStatusExport", [
    "CLAUDE_STATUS_LEDGER_OCCURRENCE_VERSION", "CLAUDE_STATUS_LEDGER_SOURCE_CURSOR_VERSION",
    "CLAUDE_STATUS_LEDGER_SOURCE_PLAN_VERSION", "ClaudeStatusLedgerExportSourceError",
    "createClaudeStatusLedgerExportCursor", "createClaudeStatusLedgerExportSourcePlan",
    "scanClaudeStatusLedgerExportSource", "verifyClaudeStatusLedgerExportSourcePlan",
  ]],
  "claude-statusline-workspace-source": ["claudeStatusWorkspace", [
    "CLAUDE_STATUS_WORKSPACE_CURSOR_VERSION", "CLAUDE_STATUS_WORKSPACE_SOURCE_VERSION",
    "ClaudeStatusWorkspaceSourceError", "DEFAULT_CLAUDE_STATUS_RECORDS_PER_BATCH",
    "appendClaudeStatusWorkspaceSource", "claudeStatusWorkspaceSourceKey", "createClaudeStatusWorkspaceSource",
    "populateClaudeStatusWorkspaceSource", "resolveClaudeStatusWorkspaceSource",
  ]],
  "claude-transcript-export-source": ["claudeTranscriptExport", [
    "CLAUDE_TRANSCRIPT_SOURCE_CURSOR_VERSION", "CLAUDE_TRANSCRIPT_SOURCE_PLAN_VERSION",
    "CLAUDE_TRANSCRIPT_USAGE_CANDIDATE_VERSION", "ClaudeTranscriptExportSourceError",
    "createClaudeTranscriptExportCursor", "createClaudeTranscriptExportPlanCheckpoint",
    "createClaudeTranscriptExportSourcePlan", "defaultClaudeProjectsDirectory",
    "minimizeClaudeTranscriptCanonicalOccurrence", "restoreClaudeTranscriptExportSourcePlan",
    "scanClaudeTranscriptExportSource", "sliceClaudeTranscriptExportSourcePlan",
    "sliceClaudeTranscriptExportSourcePlans", "summarizeClaudeTranscriptPlan",
    "verifyClaudeTranscriptExportSource",
  ]],
  "claude-transcript-workspace-source": ["claudeTranscriptWorkspace", [
    "CLAUDE_TRANSCRIPT_WORKSPACE_SOURCE_VERSION", "ClaudeTranscriptWorkspaceSourceError",
    "DEFAULT_CLAUDE_TRANSCRIPT_RECORDS_PER_BATCH", "appendClaudeTranscriptWorkspaceSources",
    "createClaudeTranscriptWorkspaceSource", "populateClaudeTranscriptWorkspaceSources",
  ]],
});

function workspaceRuntime() {
  return application.createLocalExportWorkspaceRuntimeContext({
    createStorage: platform.createOwnerOnlyExportWorkspaceStorageContext,
    createLease: platform.createOwnerOnlyExportWorkspaceLeaseContext,
    sha256Hex: platform.sha256Hex,
    platformName: platform.localPlatformName,
  });
}

function compose(configuration = {}) {
  return application.createLocalExportSourcePipelineContext(
    platform.localIsProxy,
    platform.createLocalExportSourcePorts(),
    { workspace: workspaceRuntime(), exportCompatibilityTuple: () => ({}), ...configuration },
  );
}

function createPipeline(ports, configuration) {
  return application.createLocalExportSourcePipelineContext(
    platform.localIsProxy,
    ports,
    configuration,
  );
}

test("ten flat export-source shims preserve the exact singleton binding identities", async () => {
  for (const [moduleName, [contextName, names]] of Object.entries(LEGACY)) {
    const legacy = await import(`../src/${moduleName}.js`);
    assert.deepEqual(Object.keys(legacy).sort(), [...names].sort(), moduleName);
    for (const name of names) assert.equal(legacy[name], pipeline[contextName][name], `${moduleName}:${name}`);
  }
  assert.equal(application.createLocalExportSourcePipelineContext, applicationOwner.createLocalExportSourcePipelineContext);
  assert.equal(application.createLocalExportSetController, applicationOwner.createLocalExportSetController);
  assert.equal(platform.createLocalExportSourcePorts, platformOwner.createLocalExportSourcePorts);
  assert.equal(platform.localIsProxy, platformOwner.localIsProxy);
});

test("application pipeline authenticates its explicit proxy detector before invoking it", () => {
  const ports = platform.createLocalExportSourcePorts();
  const configuration = { workspace: workspaceRuntime(), exportCompatibilityTuple: () => ({}) };
  let touched = 0;
  const callableProxy = new Proxy(() => false, {
    apply() { touched += 1; throw new Error("PRIVATE_PROXY_DETECTOR_CANARY"); },
  });
  assert.throws(
    () => application.createLocalExportSourcePipelineContext(callableProxy, ports, configuration),
    /configuration is invalid/u,
  );
  assert.equal(touched, 0);
  assert.throws(
    () => application.createLocalExportSourcePipelineContext(() => false, ports, configuration),
    /configuration is invalid/u,
  );
  assert.equal(touched, 0);
});

test("application pipeline rejects source-port Proxies before descriptor evaluation", () => {
  let touched = 0;
  const sourcePorts = new Proxy({}, {
    ownKeys() { touched += 1; throw new Error("PRIVATE_SOURCE_PORT_KEYS_CANARY"); },
    getOwnPropertyDescriptor() { touched += 1; throw new Error("PRIVATE_SOURCE_PORT_DESCRIPTOR_CANARY"); },
    get() { touched += 1; throw new Error("PRIVATE_SOURCE_PORT_GET_CANARY"); },
  });
  assert.throws(() => createPipeline(sourcePorts, {
    workspace: workspaceRuntime(), exportCompatibilityTuple: () => ({}),
  }), /configuration is invalid/u);
  assert.equal(touched, 0);
});

test("application pipeline snapshots an exact accessor-free source-port contract", () => {
  const original = platform.createLocalExportSourcePorts();
  const configuration = { workspace: workspaceRuntime(), exportCompatibilityTuple: () => ({}) };
  let touched = 0;
  for (const key of ["clock", "rss", "codexLogPorts"]) {
    const hostile = { ...original };
    Object.defineProperty(hostile, key, {
      enumerable: true,
      get() { touched += 1; throw new Error("PRIVATE_SOURCE_PORT_ACCESSOR_CANARY"); },
    });
    assert.throws(() => createPipeline(hostile, configuration), /configuration is invalid/u, key);
    assert.equal(touched, 0, key);
  }

  const fakeDetector = new Proxy(() => false, {
    apply() { touched += 1; throw new Error("PRIVATE_FAKE_SOURCE_IS_PROXY_CANARY"); },
  });
  assert.throws(
    () => createPipeline({ ...original, isProxy: fakeDetector }, configuration),
    /configuration is invalid/u,
  );
  assert.equal(touched, 0);

  const missing = { ...original };
  delete missing.clock;
  assert.throws(() => createPipeline(missing, configuration), /configuration is invalid/u);
  assert.throws(() => createPipeline({ ...original, unexpected: 1 }, configuration), /configuration is invalid/u);
  assert.throws(() => createPipeline({ ...original, then: () => {} }, configuration), /configuration is invalid/u);

  const constantsAccessor = {};
  Object.defineProperties(constantsAccessor, {
    O_NOFOLLOW: { enumerable: true, value: original.fsConstants.O_NOFOLLOW },
    O_RDONLY: {
      enumerable: true,
      get() { touched += 1; throw new Error("PRIVATE_FS_CONSTANTS_ACCESSOR_CANARY"); },
    },
  });
  assert.throws(
    () => createPipeline({ ...original, fsConstants: constantsAccessor }, configuration),
    /configuration is invalid/u,
  );
  assert.equal(touched, 0);
  assert.throws(
    () => createPipeline({
      ...original,
      fsConstants: { ...original.fsConstants, unexpected: 1 },
    }, configuration),
    /configuration is invalid/u,
  );
});

test("application pipeline snapshots exact nested Codex-log capabilities without canary execution", () => {
  const original = platform.createLocalExportSourcePorts();
  const configuration = { workspace: workspaceRuntime(), exportCompatibilityTuple: () => ({}) };
  let touched = 0;

  const codexPortsProxy = new Proxy({}, {
    ownKeys() { touched += 1; throw new Error("PRIVATE_CODEX_PORTS_PROXY_CANARY"); },
    getOwnPropertyDescriptor() { touched += 1; throw new Error("PRIVATE_CODEX_PORTS_PROXY_CANARY"); },
  });
  assert.throws(
    () => createPipeline({ ...original, codexLogPorts: codexPortsProxy }, configuration),
    /configuration is invalid/u,
  );
  assert.equal(touched, 0);

  for (const key of ["filesystem", "lineReader"]) {
    const nested = { ...original.codexLogPorts };
    Object.defineProperty(nested, key, {
      enumerable: true,
      get() { touched += 1; throw new Error("PRIVATE_CODEX_PORT_OWNER_ACCESSOR_CANARY"); },
    });
    assert.throws(
      () => createPipeline({ ...original, codexLogPorts: nested }, configuration),
      /configuration is invalid/u,
      key,
    );
    assert.equal(touched, 0, key);
  }

  const filesystemProxy = new Proxy({}, {
    ownKeys() { touched += 1; throw new Error("PRIVATE_CODEX_FILESYSTEM_PROXY_CANARY"); },
    getOwnPropertyDescriptor() { touched += 1; throw new Error("PRIVATE_CODEX_FILESYSTEM_PROXY_CANARY"); },
  });
  assert.throws(
    () => createPipeline({
      ...original,
      codexLogPorts: { filesystem: filesystemProxy, lineReader: original.codexLogPorts.lineReader },
    }, configuration),
    /configuration is invalid/u,
  );
  assert.equal(touched, 0);

  const lineReader = {};
  Object.defineProperty(lineReader, "readBoundedUtf8Lines", {
    enumerable: true,
    get() { touched += 1; throw new Error("PRIVATE_CODEX_LINE_READER_ACCESSOR_CANARY"); },
  });
  assert.throws(
    () => createPipeline({
      ...original,
      codexLogPorts: { filesystem: original.codexLogPorts.filesystem, lineReader },
    }, configuration),
    /configuration is invalid/u,
  );
  assert.equal(touched, 0);

  const filesystem = { ...original.codexLogPorts.filesystem };
  Object.defineProperty(filesystem, "defaultCodexHome", {
    enumerable: true,
    get() { touched += 1; throw new Error("PRIVATE_CODEX_FILESYSTEM_ACCESSOR_CANARY"); },
  });
  assert.throws(
    () => createPipeline({
      ...original,
      codexLogPorts: { filesystem, lineReader: original.codexLogPorts.lineReader },
    }, configuration),
    /configuration is invalid/u,
  );
  assert.equal(touched, 0);

  const callableProxy = new Proxy(() => {}, {
    apply() { touched += 1; throw new Error("PRIVATE_CODEX_CALLABLE_CANARY"); },
  });
  assert.throws(
    () => createPipeline({
      ...original,
      codexLogPorts: {
        filesystem: { ...original.codexLogPorts.filesystem, defaultCodexHome: callableProxy },
        lineReader: original.codexLogPorts.lineReader,
      },
    }, configuration),
    /configuration is invalid/u,
  );
  assert.equal(touched, 0);

  const missingFilesystem = { ...original.codexLogPorts.filesystem };
  delete missingFilesystem.defaultCodexHome;
  assert.throws(
    () => createPipeline({
      ...original,
      codexLogPorts: {
        filesystem: missingFilesystem,
        lineReader: original.codexLogPorts.lineReader,
      },
    }, configuration),
    /configuration is invalid/u,
  );
  assert.throws(
    () => createPipeline({
      ...original,
      codexLogPorts: {
        ...original.codexLogPorts,
        unexpected: Object.freeze({}),
      },
    }, configuration),
    /configuration is invalid/u,
  );
  assert.throws(
    () => createPipeline({
      ...original,
      codexLogPorts: { ...original.codexLogPorts, then: () => {} },
    }, configuration),
    /configuration is invalid/u,
  );
});

test("application pipeline behavior is detached from later source-port mutation", async () => {
  const original = platform.createLocalExportSourcePorts();
  const filesystem = {
    ...original.codexLogPorts.filesystem,
    defaultCodexHome: () => resolve(ROOT, ".tmp-does-not-exist-snapshotted-codex-home"),
  };
  const mutable = {
    ...original,
    clock: () => 0,
    rss: () => 0,
    codexLogPorts: {
      filesystem,
      lineReader: { ...original.codexLogPorts.lineReader },
    },
  };
  const context = createPipeline(mutable, {
    workspace: workspaceRuntime(), exportCompatibilityTuple: () => ({}),
  });
  let touched = 0;
  mutable.clock = new Proxy(() => 0, {
    apply() { touched += 1; throw new Error("PRIVATE_MUTATED_CLOCK_CANARY"); },
  });
  filesystem.defaultCodexHome = new Proxy(() => "/private/canary", {
    apply() { touched += 1; throw new Error("PRIVATE_MUTATED_CODEX_HOME_CANARY"); },
  });

  await assert.rejects(
    context.codexCollectorExport.createCodexCollectorExportSourcePlan({ collectorPath: "" }),
    /plan_invalid/u,
  );
  const plan = await context.codexSourcePlan.createCodexExportSourcePlan({
    startAt: "2026-07-01T00:00:00.000Z",
    endAt: "2026-07-02T00:00:00.000Z",
  });
  assert.equal(plan.sources.length, 0);
  assert.equal(touched, 0);
});

test("application pipeline rejects hostile configuration before evaluating traps", () => {
  const ports = platform.createLocalExportSourcePorts();
  let touched = 0;
  const proxy = new Proxy({}, {
    get() { touched += 1; throw new Error("PRIVATE_PIPELINE_PROXY_CANARY"); },
    getOwnPropertyDescriptor() { touched += 1; throw new Error("PRIVATE_PIPELINE_PROXY_CANARY"); },
  });
  assert.throws(() => createPipeline(ports, proxy), /configuration is invalid/u);
  assert.equal(touched, 0);

  for (const key of ["workspace", "exportCompatibilityTuple"]) {
    const configuration = { workspace: workspaceRuntime(), exportCompatibilityTuple: () => ({}) };
    Object.defineProperty(configuration, key, {
      enumerable: true,
      get() { touched += 1; throw new Error("PRIVATE_PIPELINE_ACCESSOR_CANARY"); },
    });
    assert.throws(() => createPipeline(ports, configuration), /configuration is invalid/u);
    assert.equal(touched, 0, key);
  }

  const callableProxy = new Proxy(() => ({}), {
    apply() { touched += 1; throw new Error("PRIVATE_PIPELINE_CALLABLE_CANARY"); },
  });
  assert.throws(() => createPipeline(ports, {
    workspace: workspaceRuntime(), exportCompatibilityTuple: callableProxy,
  }), /configuration is invalid/u);
  assert.equal(touched, 0);
});

test("workspace ports and thenables are snapshotted without accessors or callable Proxy invocation", () => {
  const ports = platform.createLocalExportSourcePorts();
  const callableKeys = [
    "ExportWorkspaceError", "buildExportWorkspaceDescriptor", "createExportWorkspace", "openExportWorkspace",
    "sourceCheckpointBatchSha256", "supplementalSourceCheckpointBatchSha256", "withExportWorkspaceLease",
  ];
  let touched = 0;
  for (const key of ["DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS", ...callableKeys]) {
    const workspace = workspaceRuntime();
    const hostile = Object.fromEntries(Object.keys(workspace).map((name) => [name, workspace[name]]));
    Object.defineProperty(hostile, key, {
      enumerable: true,
      get() { touched += 1; throw new Error("PRIVATE_WORKSPACE_ACCESSOR_CANARY"); },
    });
    assert.throws(() => createPipeline(ports, {
      workspace: hostile, exportCompatibilityTuple: () => ({}),
    }), /configuration is invalid/u);
    assert.equal(touched, 0, key);
  }
  for (const key of callableKeys) {
    const workspace = Object.fromEntries(Object.entries(workspaceRuntime()));
    workspace[key] = new Proxy(() => {}, {
      apply() { touched += 1; throw new Error("PRIVATE_WORKSPACE_CALLABLE_CANARY"); },
    });
    assert.throws(() => createPipeline(ports, {
      workspace, exportCompatibilityTuple: () => ({}),
    }), /configuration is invalid/u);
    assert.equal(touched, 0, key);
  }
  const thenable = Object.fromEntries(Object.entries(workspaceRuntime()));
  Object.defineProperty(thenable, "then", {
    get() { touched += 1; throw new Error("PRIVATE_WORKSPACE_THENABLE_CANARY"); },
  });
  assert.throws(() => createPipeline(ports, {
    workspace: thenable, exportCompatibilityTuple: () => ({}),
  }), /configuration is invalid/u);
  assert.equal(touched, 0);
});

test("platform ports reject hostile configuration without evaluating traps", () => {
  let touched = 0;
  const proxy = new Proxy({}, {
    get() { touched += 1; throw new Error("PRIVATE_PLATFORM_PROXY_CANARY"); },
    getOwnPropertyDescriptor() { touched += 1; throw new Error("PRIVATE_PLATFORM_PROXY_CANARY"); },
  });
  assert.throws(() => platform.createLocalExportSourcePorts(proxy), /configuration is invalid/u);
  assert.equal(touched, 0);
  const accessor = {};
  Object.defineProperty(accessor, "environment", {
    get() { touched += 1; throw new Error("PRIVATE_PLATFORM_ACCESSOR_CANARY"); },
  });
  assert.throws(() => platform.createLocalExportSourcePorts(accessor), /configuration is invalid/u);
  assert.equal(touched, 0);
});

test("platform ports snapshot only required environment data and retain no caller environment", () => {
  const environment = {
    LOCALAPPDATA: "/local/app-data",
    XDG_STATE_HOME: "/xdg/state",
    CODEX_HOME: "/codex/original",
  };
  let touched = 0;
  Object.defineProperty(environment, "UNRELATED_PRIVATE_VALUE", {
    enumerable: true,
    get() { touched += 1; throw new Error("PRIVATE_UNRELATED_ENVIRONMENT_CANARY"); },
  });
  const ports = platform.createLocalExportSourcePorts({
    environment,
    homeDirectory: "/home/original",
    platform: "linux",
  });
  assert.equal(touched, 0);
  assert.equal(Object.hasOwn(ports, "environment"), false);
  assert.equal(
    ports.defaultClaudeStatusStateDirectory(),
    "/xdg/state/app-usagemonitor/claude-statusline-v0.2",
  );
  assert.equal(ports.codexLogPorts.filesystem.defaultCodexHome(), "/codex/original");

  environment.XDG_STATE_HOME = "/xdg/mutated";
  environment.LOCALAPPDATA = "/local/mutated";
  environment.CODEX_HOME = "/codex/mutated";
  assert.equal(
    ports.defaultClaudeStatusStateDirectory(),
    "/xdg/state/app-usagemonitor/claude-statusline-v0.2",
  );
  assert.equal(ports.codexLogPorts.filesystem.defaultCodexHome(), "/codex/original");
  assert.equal(touched, 0);
});

test("platform ports reject nested environment Proxies and accessors without canary execution", () => {
  let touched = 0;
  const proxy = new Proxy({}, {
    get() { touched += 1; throw new Error("PRIVATE_NESTED_ENVIRONMENT_PROXY_CANARY"); },
    getOwnPropertyDescriptor() { touched += 1; throw new Error("PRIVATE_NESTED_ENVIRONMENT_PROXY_CANARY"); },
  });
  assert.throws(
    () => platform.createLocalExportSourcePorts({ environment: proxy }),
    /configuration is invalid/u,
  );
  assert.equal(touched, 0);

  for (const key of ["LOCALAPPDATA", "XDG_STATE_HOME", "CODEX_HOME"]) {
    const environment = {};
    Object.defineProperty(environment, key, {
      enumerable: true,
      get() { touched += 1; throw new Error("PRIVATE_NESTED_ENVIRONMENT_ACCESSOR_CANARY"); },
    });
    assert.throws(
      () => platform.createLocalExportSourcePorts({ environment }),
      /configuration is invalid/u,
      key,
    );
    assert.equal(touched, 0, key);
  }

  const ports = platform.createLocalExportSourcePorts({
    environment: {}, homeDirectory: "/home/original", platform: "linux",
  });
  assert.throws(
    () => ports.defaultClaudeStatusStateDirectory(proxy),
    /configuration is invalid/u,
  );
  assert.equal(touched, 0);
  assert.throws(
    () => ports.defaultClaudeStatusStateDirectory({ env: proxy }),
    /configuration is invalid/u,
  );
  assert.equal(touched, 0);
  const envAccessor = {};
  Object.defineProperty(envAccessor, "XDG_STATE_HOME", {
    enumerable: true,
    get() { touched += 1; throw new Error("PRIVATE_OPTION_ENVIRONMENT_ACCESSOR_CANARY"); },
  });
  assert.throws(
    () => ports.defaultClaudeStatusStateDirectory({ env: envAccessor }),
    /configuration is invalid/u,
  );
  assert.equal(touched, 0);
});

test("owner dependency closure and local-review composition remain explicit", async () => {
  const applicationSource = await readFile(resolve(ROOT, "src/application/export-sources/index.js"), "utf8");
  const platformSource = await readFile(resolve(ROOT, "src/platform/local-export-source-ports.js"), "utf8");
  const localReviewSource = await readFile(resolve(ROOT, "local-review/cli.js"), "utf8");
  assert.doesNotMatch(applicationSource, /node:|\.\.\/\.\.\/platform|\.\.\/\.\.\/storage/u);
  assert.doesNotMatch(platformSource, /\.\.\/(?:application|export|providers)|\.\/\.\.\/storage/u);
  assert.doesNotMatch(localReviewSource, /src\/export-set-controller\.js/u);
  assert.match(localReviewSource, /createLocalExportSourcePipelineContext/u);
  assert.match(localReviewSource, /createLocalExportSourcePorts/u);
});

test("local Node runtime imports without source discovery or local state", () => {
  const missing = resolve(ROOT, ".tmp-does-not-exist-export-source-import");
  const imported = spawnSync(process.execPath, [
    "--input-type=module", "-e",
    "await import('./src/local-node-runtime.js'); console.log('imported')",
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, HOME: missing, CODEX_HOME: missing, XDG_STATE_HOME: missing },
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.trim(), "imported");
});

test("local-review accepts the composed controller as an explicit default seam", async () => {
  const calls = [];
  const originalLog = console.log;
  console.log = () => {};
  try {
    await runLocalReview(["inspect-export-workspace", "--workspace", "/opaque/workspace"], {
      exportSetController: {
        async createLocalExportWorkspace() { throw new Error("not called"); },
        async resumeLocalExportWorkspace() { throw new Error("not called"); },
        async inspectLocalExportWorkspace(options) {
          calls.push(options);
          return {
            poisoned: false,
            scanComplete: true,
            coveredAt: { startAt: "2026-07-01T00:00:00.000Z", endAt: "2026-07-02T00:00:00.000Z" },
            sourceProviders: ["openai_codex"],
            recordCounts: { usageEvents: 1, quotaSnapshots: 2, activityMarkers: 0 },
            workspaceBytes: 123,
          };
        },
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(calls, [{ directory: "/opaque/workspace" }]);
});
