import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, win32 } from "node:path";
import test from "node:test";

import { createCompanionWindowsStateComposition } from "../apps/local/server.js";
import {
  classifyWindowsSqliteError,
  WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST,
  WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST,
  WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST,
} from "../scripts/windows-security-qualification.mjs";
import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import {
  createWindowsFilesystemAdapter,
} from "../src/platform/windows-filesystem.js";
import {
  createWindowsQualificationModeContext,
  WINDOWS_QUALIFICATION_MODE_ACCOUNTING_SOURCE_MODE,
  WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VALUE,
  WINDOWS_QUALIFICATION_MODE_TEST_LANE,
  WINDOWS_QUALIFICATION_REQUIRED_RESOURCE_PATHS,
  WINDOWS_QUALIFICATION_RESOURCE_MANIFEST_FILE,
  WINDOWS_QUALIFICATION_RESOURCE_MANIFEST_SCHEMA,
} from "../src/platform/windows-qualification-mode.js";

const NATIVE_WINDOWS = process.platform === "win32" && process.arch === "x64";
const NATIVE_SKIP = NATIVE_WINDOWS ? false : "native Windows x64 only";
const requireNative = createRequire(import.meta.url);
const QUALIFICATION_BINDING_ENVIRONMENT =
  "TIBOTATTLE_WINDOWS_QUALIFICATION_BINDING_PATH";
const QUALIFICATION_BINDING_FILE = "windows_filesystem_qualification.node";
const CONTRACT = "usage-event-v0.2";
const WINDOWS_BINDING_MANIFEST_PATH =
  "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json";
const WINDOWS_BINDING_PATH =
  "native/windows-filesystem/build/Release/windows_filesystem.node";
const KEYTAR_PATH = "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node";

function qualificationBindingPath() {
  const configured = process.env[QUALIFICATION_BINDING_ENVIRONMENT];
  if (typeof configured !== "string"
      || !win32.isAbsolute(configured)
      || basename(configured).toLowerCase() !== QUALIFICATION_BINDING_FILE) {
    throw new Error("WINDOWS_UNIFIED_INDEX_QUALIFICATION_BINDING_INVALID");
  }
  return configured;
}

function resourceKind(path) {
  if (path.startsWith("apps/electron/")
      || path === "src/desktop-shell-status.js"
      || path === "src/platform/windows-credential-manager-probe.js") {
    return "electron_shell";
  }
  if (path === "apps/local/server.js") return "companion_source";
  if (path.startsWith("apps/web/")) return "dashboard_asset";
  if (path.startsWith("native/")) return "windows_native_binding";
  return "third_party_dependency";
}

function resourceRow(path, bytes) {
  return {
    bytes: bytes.byteLength,
    kind: resourceKind(path),
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function resourcePayloadSha256(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(
      `F\0${file.path}\0${file.bytes}\0${file.sha256}\0${file.kind}\0`,
    );
  }
  return hash.digest("hex");
}

async function writeStrictResourceManifest(resourceRoot, bindingPath) {
  const repositoryRoot = resolve(".");
  const bindingBytes = await readFile(bindingPath);
  const bindingManifestBytes = await readFile(
    resolve(repositoryRoot, WINDOWS_BINDING_MANIFEST_PATH),
  );
  const keytarBytes = await readFile(resolve(repositoryRoot, KEYTAR_PATH));
  const contentFor = new Map([
    [WINDOWS_BINDING_PATH, bindingBytes],
    [WINDOWS_BINDING_MANIFEST_PATH, bindingManifestBytes],
    [KEYTAR_PATH, keytarBytes],
  ]);
  const files = [
    ...WINDOWS_QUALIFICATION_REQUIRED_RESOURCE_PATHS,
    WINDOWS_BINDING_PATH,
    WINDOWS_BINDING_MANIFEST_PATH,
    KEYTAR_PATH,
  ]
    .toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    .map((path) => resourceRow(
      path,
      contentFor.get(path) ?? Buffer.from(`qualification:${path}`, "utf8"),
    ));
  const binding = files.find((file) => file.path === WINDOWS_BINDING_PATH);
  const payloadBytes = files.reduce((total, file) => total + file.bytes, 0);
  const manifest = {
    architecture: "x64",
    dashboardRoot: "apps/web/public",
    entrypoint: "apps/electron/main.js",
    files,
    payload: {
      bytes: payloadBytes,
      sha256: resourcePayloadSha256(files),
    },
    releaseVersion: "native-unified-index-qualification",
    schemaVersion: WINDOWS_QUALIFICATION_RESOURCE_MANIFEST_SCHEMA,
    target: "win32",
    windowsBinding: {
      binding: {
        bytes: binding.bytes,
        path: binding.path,
        sha256: binding.sha256,
      },
      included: true,
      manifest: { path: WINDOWS_BINDING_MANIFEST_PATH },
      status: "included_unverified",
      verified: false,
    },
  };
  await writeFile(
    join(resourceRoot, WINDOWS_QUALIFICATION_RESOURCE_MANIFEST_FILE),
    `${JSON.stringify(manifest)}\n`,
    { mode: 0o600 },
  );
}

async function createQualificationFixture() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-unified-index-native-"));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const claudeConfigDirectory = join(home, ".claude");
  const stateRoot = join(root, "state");
  const resourceRoot = join(root, "resources");
  await mkdir(home, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(claudeConfigDirectory, { recursive: true });
  await mkdir(resourceRoot, { recursive: true });

  const bindingPath = qualificationBindingPath();
  const binding = requireNative(bindingPath);
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  adapter.ensureDirectory(stateRoot);
  await writeStrictResourceManifest(resourceRoot, bindingPath);

  const environment = {
    USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION:
      WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VALUE,
    USAGE_MONITOR_TEST_LANE: WINDOWS_QUALIFICATION_MODE_TEST_LANE,
    USAGE_MONITOR_ACCOUNTING_SOURCE_MODE:
      WINDOWS_QUALIFICATION_MODE_ACCOUNTING_SOURCE_MODE,
    TEMP: root,
    TMP: root,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfigDirectory,
    USAGE_MONITOR_RESOURCE_ROOT: resourceRoot,
    USAGE_MONITOR_STATE_ROOT: stateRoot,
  };
  const context = createWindowsQualificationModeContext({
    platform: "win32",
    architecture: "x64",
    environment,
    adapter,
    resourceRoot,
    stateRoot,
  });
  const composition = createCompanionWindowsStateComposition({
    platform: "win32",
    architecture: "x64",
    resourceRoot,
    stateRoot,
    windowsFilesystemAdapter: adapter,
    windowsQualificationModeContext: context,
    environment,
    homeDirectory: home,
  });

  const sessions = join(codexHome, "sessions");
  await mkdir(sessions, { recursive: true });
  const usage = {
    input_tokens: 100,
    cached_input_tokens: 20,
    cache_write_input_tokens: 0,
    output_tokens: 24,
    reasoning_output_tokens: 8,
    total_tokens: 124,
  };
  const rows = [
    {
      timestamp: "2026-08-24T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "windows-unified-index-native",
        session_id: "windows-unified-index-native",
        thread_source: "user",
        originator: "codex_cli_rs",
      },
    },
    {
      timestamp: "2026-08-24T00:00:01.000Z",
      type: "turn_context",
      payload: {
        turn_id: "turn-native-unified-index",
        model: "gpt-5.6-sol",
        effort: "high",
      },
    },
    {
      timestamp: "2026-08-24T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: usage,
          last_token_usage: usage,
        },
      },
    },
  ];
  await writeFile(
    join(sessions, "rollout-windows-unified-index-native.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    { mode: 0o600 },
  );
  return {
    root,
    codexHome,
    resourceRoot,
    stateRoot,
    indexFile: join(stateRoot, "local-unified-index-v1.sqlite"),
    secretFile: join(stateRoot, "local-unified-index-device-salt-v1"),
    adapter,
    context,
    composition,
  };
}

function assertNoStagedResidue(entries) {
  assert.deepEqual(
    entries.filter((entry) => /\.(?:building|incremental)-/u.test(entry)),
    [],
  );
}

function ownStringProperty(value, property) {
  try {
    if (value === null
        || (typeof value !== "object" && typeof value !== "function")) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    return descriptor !== undefined
      && Object.hasOwn(descriptor, "value")
      && typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function emitBoundedIngestFailureDiagnostic(testContext, error) {
  if (process.env.USAGE_MONITOR_WINDOWS_QUALIFICATION !== "1") return;

  // These markers are consumed by the qualification harness' existing
  // allowlisted parsers. Keep the SQLite category visible even when the
  // higher-level index wrapper has already removed the native errcode.
  testContext.diagnostic(
    `windowsSqliteErrorCategory: ${classifyWindowsSqliteError(error)}`,
  );

  const stage = ownStringProperty(error, "windowsFilesystemStage");
  if (WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST.includes(stage)) {
    testContext.diagnostic(`windowsFilesystemStage: ${stage}`);
  }

  const code = ownStringProperty(error, "code");
  if (WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST.includes(code)) {
    testContext.diagnostic(`windowsFilesystemError: ${code}`);
  }

  const unifiedIndexStage = ownStringProperty(error, "windowsUnifiedIndexStage");
  if (WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST.includes(unifiedIndexStage)) {
    testContext.diagnostic(`unifiedIndexStage: ${unifiedIndexStage}`);
  }
}

async function ingestWithBoundedFailureDiagnostic(options, testContext) {
  try {
    return await ingestLocalUnifiedIndexIncrement(options);
  } catch (error) {
    emitBoundedIngestFailureDiagnostic(testContext, error);
    throw error;
  }
}

test("native Windows unified index ingests fresh protected state and settles unchanged", {
  skip: NATIVE_SKIP,
}, async (t) => {
  const fixture = await createQualificationFixture();
  try {
    const options = {
      codexHome: fixture.codexHome,
      indexFile: fixture.indexFile,
      secretFile: fixture.secretFile,
      contractVersion: CONTRACT,
      windowsFilesystemAdapter: fixture.adapter,
      windowsProtectedStateStore: fixture.composition.protectedStateStore,
      windowsQualificationModeContext: fixture.context,
      resourceRoot: fixture.resourceRoot,
      stateRoot: fixture.stateRoot,
      windowsSqliteStateSessionFactory:
        fixture.composition.sqliteStateSessionFactory,
      windowsSqliteStateStaging: fixture.composition.sqliteStateStaging,
    };
    const first = await ingestWithBoundedFailureDiagnostic(options, t);
    assert.equal(first.status, "ingested");
    assert.equal(first.unchanged, false);
    assert.equal(first.generation.status, "complete");
    assert.equal(first.sourcesScanned, 1);
    assert.ok(first.insertedUsageEvents > 0);
    assert.ok(first.totalUsageEvents > 0);
    assertNoStagedResidue(await readdir(fixture.stateRoot));

    const second = await ingestWithBoundedFailureDiagnostic(options, t);
    assert.equal(second.status, "ingested");
    assert.equal(second.unchanged, true);
    assert.equal(second.sourcesSkipped, 1);
    assert.equal(second.sourcesScanned, 0);
    assert.equal(second.insertedUsageEvents, 0);
    assert.equal(second.totalUsageEvents, first.totalUsageEvents);
    assertNoStagedResidue(await readdir(fixture.stateRoot));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
