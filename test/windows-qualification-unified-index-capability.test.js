import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS,
  createWindowsFilesystemAdapter,
} from "../src/platform/windows-filesystem.js";
import {
  WINDOWS_QUALIFICATION_MODE_ACCOUNTING_SOURCE_MODE,
  WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VALUE,
  WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VARIABLE,
  WINDOWS_QUALIFICATION_MODE_TEST_LANE,
  WINDOWS_QUALIFICATION_MODE_TEST_LANE_ENVIRONMENT_VARIABLE,
  WINDOWS_QUALIFICATION_REQUIRED_RESOURCE_PATHS,
  createWindowsQualificationModeContext,
} from "../src/platform/windows-qualification-mode.js";
import {
  createWindowsQualificationStateSessionFactory,
  isWindowsQualificationStateSessionFor,
} from "../src/platform/local-collector-state-session.js";
import {
  createWindowsSqliteStateSession,
} from "../src/platform/windows-sqlite-state-session.js";
import {
  createWindowsProtectedStateStore,
  isWindowsQualificationProtectedStateStoreFor,
} from "../src/platform/windows-protected-state-store.js";
import {
  createWindowsSqliteStateStaging,
  isWindowsQualificationSqliteStateStagingFor,
} from "../src/platform/windows-sqlite-state-staging.js";

const STATE_ROOT = "C:\\Users\\runner\\AppData\\Local\\Temp\\tibotattle-capability\\state";
const RESOURCE_BINDING_PATH =
  "native/windows-filesystem/build/Release/windows_filesystem.node";
const RESOURCE_BINDING_MANIFEST_PATH = `${RESOURCE_BINDING_PATH}.manifest.json`;
const RESOURCE_KEYTAR_PATH = "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node";
const IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});

function metadata({ directory = false, identity = IDENTITY } = {}) {
  return {
    identity,
    isDirectory: directory,
    isRegularFile: !directory,
    isReparsePoint: false,
    ownerMatches: true,
    nullDacl: false,
    daclProtected: true,
    broadAccess: false,
    nonOwnerAllow: false,
    unrecognizedAce: false,
    finalPathResolved: true,
  };
}

function fixtureBinding() {
  const binding = {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion:
      "windows-credential-audit-file-guard-v1",
    sqliteStateLeaseContractVersion: "windows-sqlite-state-lease-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    companionInstanceMutexContractVersion:
      "windows-companion-instance-mutex-v1",
    preparedArtifactContractVersion: "windows-prepared-artifact-v1",
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    companionInstanceMutexSafe: false,
    credentialAuditFileGuardSafe: true,
    sqliteStateLeaseSafe: false,
    preparedArtifactSafe: false,
    inspectPath: () => metadata({ directory: true }),
    ensureDirectory: () => IDENTITY,
    inspectProtectedChild: () => metadata(),
    acquireSqliteStateLease: () => ({
      lease: {},
      databaseIdentity: IDENTITY,
      journalIdentity: IDENTITY,
    }),
    releaseSqliteStateLease: () => undefined,
  };
  for (const method of WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS) {
    if (typeof binding[method] !== "function") binding[method] = () => undefined;
  }
  return binding;
}

function resourceManifest() {
  const paths = new Set([
    ...WINDOWS_QUALIFICATION_REQUIRED_RESOURCE_PATHS,
    RESOURCE_BINDING_PATH,
    RESOURCE_BINDING_MANIFEST_PATH,
    RESOURCE_KEYTAR_PATH,
  ]);
  const sha = "0".repeat(64);
  const files = [...paths].sort((left, right) =>
    Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")))
    .map((path) => ({
      bytes: 1,
      kind: path.startsWith("apps/electron/")
        || path === "src/desktop-shell-status.js"
        || path === "src/platform/windows-credential-manager-probe.js"
        ? "electron_shell"
        : path === "apps/local/server.js"
          ? "companion_source"
          : path.startsWith("apps/web/")
            ? "dashboard_asset"
            : path.startsWith("native/")
              ? "windows_native_binding"
              : "third_party_dependency",
      path,
      sha256: sha,
    }));
  const payload = createHash("sha256");
  for (const row of files) {
    payload.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  return {
    architecture: "x64",
    dashboardRoot: "apps/web/public",
    entrypoint: "apps/electron/main.js",
    files,
    payload: { bytes: files.length, sha256: payload.digest("hex") },
    releaseVersion: "0.1.0",
    schemaVersion: "usage-monitor-electron-runtime-v0.1",
    target: "win32",
    windowsBinding: {
      binding: { bytes: 1, path: RESOURCE_BINDING_PATH, sha256: sha },
      included: true,
      manifest: { path: RESOURCE_BINDING_MANIFEST_PATH },
      status: "included_unverified",
      verified: false,
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "windows-unified-capability-"));
  const resourceRoot = join(root, "resources");
  const environment = {
    [WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VARIABLE]:
      WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VALUE,
    [WINDOWS_QUALIFICATION_MODE_TEST_LANE_ENVIRONMENT_VARIABLE]:
      WINDOWS_QUALIFICATION_MODE_TEST_LANE,
    USAGE_MONITOR_ACCOUNTING_SOURCE_MODE:
      WINDOWS_QUALIFICATION_MODE_ACCOUNTING_SOURCE_MODE,
    TEMP: "C:\\Users\\runner\\AppData\\Local\\Temp\\tibotattle-capability",
    HOME: "C:\\Users\\runner\\AppData\\Local\\Temp\\tibotattle-capability\\home",
    USERPROFILE: "C:\\Users\\runner\\AppData\\Local\\Temp\\tibotattle-capability\\home",
    CODEX_HOME: "C:\\Users\\runner\\AppData\\Local\\Temp\\tibotattle-capability\\home\\.codex",
    CLAUDE_CONFIG_DIR: "C:\\Users\\runner\\AppData\\Local\\Temp\\tibotattle-capability\\home\\.claude",
    USAGE_MONITOR_STATE_ROOT: STATE_ROOT,
  };
  await import("node:fs/promises").then(({ mkdir }) => mkdir(resourceRoot));
  await writeFile(
    join(resourceRoot, "electron-runtime-manifest.json"),
    `${JSON.stringify(resourceManifest())}\n`,
  );
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding: fixtureBinding(),
  });
  const context = createWindowsQualificationModeContext({
    platform: "win32",
    architecture: "x64",
    adapter,
    environment,
    resourceRoot,
    stateRoot: STATE_ROOT,
  });
  return { root, adapter, context, resourceRoot };
}

function databaseFactory(path) {
  const database = {
    isOpen: true,
    isTransaction: false,
    enableDefensive() {},
    setAuthorizer() {},
    location() { return path; },
    exec() {},
    prepare(sql) {
      const normalized = sql.toLowerCase();
      const key = normalized.match(/pragma\s+([a-z_]+)/u)?.[1] ?? "";
      const values = {
        journal_mode: "persist",
        synchronous: 2,
        foreign_keys: 1,
        trusted_schema: 0,
        temp_store: 2,
        mmap_size: 0,
      };
      return { get: () => ({ [key]: values[key] }) };
    },
    close() { this.isOpen = false; },
  };
  return database;
}

test("qualification-only staging/store/session capabilities are exact and fail closed", async () => {
  const value = await fixture();
  const { adapter, context, resourceRoot } = value;
  try {
    const staging = createWindowsSqliteStateStaging({
      adapter,
      rootPath: STATE_ROOT,
      windowsQualificationModeContext: context,
      resourceRoot,
    });
    const store = createWindowsProtectedStateStore({
      adapter,
      rootPath: STATE_ROOT,
      windowsQualificationModeContext: context,
      resourceRoot,
    });
    assert.equal(isWindowsQualificationSqliteStateStagingFor({
      staging,
      context,
      adapter,
      path: `${STATE_ROOT}\\index.sqlite.building-test`,
      stateRoot: STATE_ROOT,
      resourceRoot,
    }), true);
    assert.equal(isWindowsQualificationProtectedStateStoreFor({
      store,
      context,
      adapter,
      path: `${STATE_ROOT}\\device-salt`,
      stateRoot: STATE_ROOT,
      resourceRoot,
    }), true);
    const copiedContext = Object.freeze({ ...context });
    for (const candidate of [
      { context: null },
      { context: copiedContext },
      { context, stateRoot: `${STATE_ROOT}\\other` },
      { context, path: "C:\\Users\\runner\\outside\\index.sqlite" },
      { context, resourceRoot: `${resourceRoot}-other` },
    ]) {
      assert.equal(isWindowsQualificationSqliteStateStagingFor({
        staging,
        adapter,
        path: `${STATE_ROOT}\\index.sqlite`,
        stateRoot: STATE_ROOT,
        resourceRoot,
        ...candidate,
        ...(candidate.path === undefined ? {} : { path: candidate.path }),
      }), false);
      assert.equal(isWindowsQualificationProtectedStateStoreFor({
        store,
        adapter,
        path: `${STATE_ROOT}\\device-salt`,
        stateRoot: STATE_ROOT,
        resourceRoot,
        ...candidate,
        ...(candidate.path === undefined ? {} : { path: candidate.path }),
      }), false);
    }

    const factory = createWindowsQualificationStateSessionFactory({
      platform: "win32",
      architecture: "x64",
      windowsFilesystemAdapter: adapter,
      windowsQualificationModeContext: context,
      stateRoot: STATE_ROOT,
      resourceRoot,
      databaseFactory,
    });
    const session = factory({
      rootPath: STATE_ROOT,
      databaseName: "index.sqlite",
      readOnly: false,
      create: true,
    });
    assert.equal(isWindowsQualificationStateSessionFor({
      session,
      context,
      adapter,
      stateFile: `${STATE_ROOT}\\index.sqlite`,
      stateRoot: STATE_ROOT,
      resourceRoot,
    }), true);
    assert.equal(isWindowsQualificationStateSessionFor({
      session: { ...session },
      context,
      adapter,
      stateFile: `${STATE_ROOT}\\index.sqlite`,
      stateRoot: STATE_ROOT,
      resourceRoot,
    }), false);
    assert.equal(isWindowsQualificationStateSessionFor({
      session,
      context,
      adapter,
      stateFile: `${STATE_ROOT}\\other.sqlite`,
      stateRoot: STATE_ROOT,
      resourceRoot,
    }), false);
    const directSession = createWindowsSqliteStateSession({
      platform: "win32",
      architecture: "x64",
      adapter,
      rootPath: STATE_ROOT,
      databaseName: "direct.sqlite",
      databaseFactory,
      windowsQualificationModeContext: context,
      windowsQualificationResourceRoot: resourceRoot,
    });
    assert.equal(isWindowsQualificationStateSessionFor({
      session: directSession,
      context,
      adapter,
      stateFile: `${STATE_ROOT}\\direct.sqlite`,
      stateRoot: STATE_ROOT,
      resourceRoot,
    }), false);
    directSession.close();
    session.close();
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
