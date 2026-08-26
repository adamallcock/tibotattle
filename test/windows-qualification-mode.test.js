import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ELECTRON_SHELL_RUNTIME_FILES,
} from "../scripts/build-electron-runtime.mjs";
import {
  createWindowsFilesystemAdapter,
  WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS,
} from "../src/platform/windows-filesystem.js";
import {
  WINDOWS_QUALIFICATION_MODE_ACCOUNTING_SOURCE_MODE,
  WINDOWS_QUALIFICATION_MODE_CONTRACT_VERSION,
  WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VALUE,
  WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VARIABLE,
  WINDOWS_QUALIFICATION_MODE_PRODUCTION_SAFE,
  WINDOWS_QUALIFICATION_MODE_QUALIFICATION_ONLY,
  WINDOWS_QUALIFICATION_MODE_TEST_LANE,
  WINDOWS_QUALIFICATION_MODE_TEST_LANE_ENVIRONMENT_VARIABLE,
  WINDOWS_QUALIFICATION_REQUIRED_RESOURCE_PATHS,
  WindowsQualificationModeError,
  createWindowsQualificationModeContext,
  isWindowsQualificationModeContext,
  isWindowsQualificationModeContextFor,
} from "../src/platform/windows-qualification-mode.js";

const TEMP_ROOT = "C:\\Users\\runner\\AppData\\Local\\Temp\\tibotattle-qualification";
const HOME = `${TEMP_ROOT}\\home`;
const STATE_ROOT = `${TEMP_ROOT}\\state`;
const CODEX_HOME = `${HOME}\\.codex`;
const CLAUDE_HOME = `${HOME}\\.claude`;
const RESOURCE_ROOT = mkdtempSync(join(tmpdir(), "tibotattle-qualification-resource-"));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildResourceManifest() {
  const paths = [
  "config/deployment-endpoints.js",
  "apps/electron/companion-supervisor.js",
  "apps/electron/desktop-command.js",
  "apps/electron/desktop-contract.js",
  "apps/electron/desktop-codex-roots.js",
  "apps/electron/desktop-deep-links.js",
  "apps/electron/desktop-diagnostics.js",
    "apps/electron/desktop-controller.js",
    "apps/electron/desktop-copy.js",
  "apps/electron/desktop-first-run.js",
  "apps/electron/desktop-first-run-login.js",
  "apps/electron/desktop-hosted-signin.js",
  "apps/electron/desktop-recovery-settings.js",
  "apps/electron/desktop-ipc.js",
  "apps/electron/desktop-owned-downloads.js",
  "apps/electron/desktop-lifecycle.js",
  "apps/electron/desktop-notification-coordinator.js",
  "apps/electron/desktop-notification-delivery.js",
  "apps/electron/desktop-notification-policy.js",
    "apps/electron/desktop-platform-services.js",
    "apps/electron/desktop-runtime.js",
    "apps/electron/desktop-settings-backends.js",
    "apps/electron/desktop-settings-store.js",
    "apps/electron/desktop-menu.js",
    "apps/electron/desktop-tray.js",
    "apps/electron/desktop-status-monitor.js",
    "apps/electron/desktop-tray-status.js",
    "apps/electron/errors.js",
    "apps/electron/loopback-policy.js",
    "apps/electron/main.js",
    "apps/electron/platform-gate.js",
    "apps/electron/preload.cjs",
    "apps/electron/recovery-preload.cjs",
    "apps/electron/recovery-window.js",
    "apps/electron/ready-line.js",
  "apps/electron/windows-qualification.js",
  "src/desktop-shell-status.js",
  "src/platform/windows-credential-manager-probe.js",
    "apps/local/server.js",
    "apps/web/public/index.html",
    "native/windows-filesystem/build/Release/windows_filesystem.node",
    "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
    "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
  ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const files = paths.map((path) => {
    const value = Buffer.from(path, "utf8");
    return {
      bytes: value.byteLength,
      kind: path.startsWith("apps/electron/")
        || path === "config/deployment-endpoints.js"
        || path === "src/desktop-shell-status.js"
        || path === "src/platform/windows-credential-manager-probe.js"
        ? "electron_shell"
        : path.startsWith("apps/web/")
          ? "dashboard_asset"
          : path === "apps/local/server.js"
            ? "companion_source"
          : path.startsWith("native/")
            ? "windows_native_binding"
            : "third_party_dependency",
      path,
      sha256: sha256(value),
    };
  });
  const payloadHash = createHash("sha256");
  let payloadBytes = 0;
  for (const row of files) {
    payloadBytes += row.bytes;
    payloadHash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  const binding = files.find((row) =>
    row.path === "native/windows-filesystem/build/Release/windows_filesystem.node");
  return {
    architecture: "x64",
    dashboardRoot: "apps/web/public",
    entrypoint: "apps/electron/main.js",
    files,
    payload: {
      bytes: payloadBytes,
      sha256: payloadHash.digest("hex"),
    },
    releaseVersion: "0.1.0-dev",
    schemaVersion: "usage-monitor-electron-runtime-v0.1",
    target: "win32",
    windowsBinding: {
      binding: {
        bytes: binding.bytes,
        path: binding.path,
        sha256: binding.sha256,
      },
      included: true,
      manifest: {
        path: "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
      },
      status: "included_unverified",
      verified: false,
    },
  };
}

writeFileSync(
  join(RESOURCE_ROOT, "electron-runtime-manifest.json"),
  `${JSON.stringify(buildResourceManifest())}\n`,
);
test.after(() => rmSync(RESOURCE_ROOT, { recursive: true, force: true }));

test("qualification resource authority tracks the complete packaged shell closure", () => {
  assert.deepEqual(
    [...WINDOWS_QUALIFICATION_REQUIRED_RESOURCE_PATHS].sort(),
    [
      ...ELECTRON_SHELL_RUNTIME_FILES,
      "apps/local/server.js",
      "apps/web/public/index.html",
    ].sort(),
  );
});

function bindingForTests() {
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
  };
  for (const method of WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS) {
    binding[method] = () => undefined;
  }
  binding.inspectPath = () => ({
    identity: {
      volumeSerialNumber: "0000000000000001",
      fileId: "00112233445566778899aabbccddeeff",
      linkCount: 1,
    },
    isDirectory: true,
    isRegularFile: false,
    isReparsePoint: false,
    finalPathResolved: true,
  });
  return binding;
}

function adapterForTests() {
  return createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding: bindingForTests(),
  });
}

function environmentForTests(overrides = {}) {
  return {
    [WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VARIABLE]:
      WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VALUE,
    [WINDOWS_QUALIFICATION_MODE_TEST_LANE_ENVIRONMENT_VARIABLE]:
      WINDOWS_QUALIFICATION_MODE_TEST_LANE,
    USAGE_MONITOR_ACCOUNTING_SOURCE_MODE:
      WINDOWS_QUALIFICATION_MODE_ACCOUNTING_SOURCE_MODE,
    TEMP: TEMP_ROOT,
    HOME,
    USERPROFILE: HOME,
    CODEX_HOME,
    CLAUDE_CONFIG_DIR: CLAUDE_HOME,
    USAGE_MONITOR_RESOURCE_ROOT: RESOURCE_ROOT,
    USAGE_MONITOR_STATE_ROOT: STATE_ROOT,
    ...overrides,
  };
}

function contextOptions(overrides = {}) {
  return {
    platform: "win32",
    architecture: "x64",
    adapter: adapterForTests(),
    environment: environmentForTests(),
    resourceRoot: RESOURCE_ROOT,
    ...overrides,
  };
}

function qualificationError(code) {
  return (error) => {
    assert.equal(error instanceof WindowsQualificationModeError, true);
    assert.equal(error.code, `windows_qualification_mode_${code}`);
    return true;
  };
}

test("creates an immutable, qualification-only context with exact bindings", () => {
  const adapter = adapterForTests();
  const context = createWindowsQualificationModeContext({
    ...contextOptions(),
    adapter,
  });

  assert.equal(isWindowsQualificationModeContext(context), true);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(context.contractVersion, WINDOWS_QUALIFICATION_MODE_CONTRACT_VERSION);
  assert.equal(context.platform, "win32");
  assert.equal(context.architecture, "x64");
  assert.equal(context.qualificationOnly, WINDOWS_QUALIFICATION_MODE_QUALIFICATION_ONLY);
  assert.equal(context.productionSafe, WINDOWS_QUALIFICATION_MODE_PRODUCTION_SAFE);
  assert.equal(context.accountingSourceMode, "unified");
  assert.equal(context.testLane, WINDOWS_QUALIFICATION_MODE_TEST_LANE);
  assert.equal(context.disposableRoot, TEMP_ROOT);
  assert.equal(context.tempRoot, TEMP_ROOT);
  assert.equal(context.resourceRoot, RESOURCE_ROOT);
  assert.equal(typeof context.resourceManifestSha256, "string");
  assert.equal(context.stateRoot, STATE_ROOT);
  assert.equal(context.codexHome, CODEX_HOME);
  assert.equal(context.claudeConfigDirectory, CLAUDE_HOME);
  assert.equal(context.claudeHome, CLAUDE_HOME);
  assert.equal(context.homeDirectory, HOME);
  assert.equal("readiness" in context, false);

  assert.equal(
    isWindowsQualificationModeContextFor({
      context,
      adapter,
      stateRoot: STATE_ROOT,
      resourceRoot: RESOURCE_ROOT,
    }),
    true,
  );
  assert.equal(
    isWindowsQualificationModeContextFor({
      context,
      adapter,
      stateRoot: STATE_ROOT.replaceAll("\\", "/"),
      resourceRoot: RESOURCE_ROOT,
    }),
    true,
  );
  assert.equal(
    isWindowsQualificationModeContextFor({
      context,
      adapter: { ...adapter },
      stateRoot: STATE_ROOT,
      resourceRoot: RESOURCE_ROOT,
    }),
    false,
  );
  assert.equal(
    isWindowsQualificationModeContextFor({
      context,
      adapter,
      stateRoot: `${TEMP_ROOT}\\other-state`,
      resourceRoot: RESOURCE_ROOT,
    }),
    false,
  );
  assert.equal(
    isWindowsQualificationModeContextFor({
      context,
      adapter,
      stateRoot: STATE_ROOT,
      resourceRoot: `${RESOURCE_ROOT}\\other-resource`,
    }),
    false,
  );
  assert.equal(
    isWindowsQualificationModeContext({ ...context }),
    false,
  );
});

test("derives portable path inputs from the disposable Windows environment", () => {
  const environment = environmentForTests();
  delete environment.CODEX_HOME;
  delete environment.CLAUDE_CONFIG_DIR;
  const context = createWindowsQualificationModeContext({
    ...contextOptions({ environment }),
    codexHome: CODEX_HOME,
    claudeConfigDirectory: CLAUDE_HOME,
  });
  assert.equal(context.codexHome, CODEX_HOME);
  assert.equal(context.claudeConfigDirectory, CLAUDE_HOME);
});

test("requires exact smoke markers and unified accounting", () => {
  for (const [key, value, code] of [
    [WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VARIABLE, "wrong", "invalid_environment"],
    [WINDOWS_QUALIFICATION_MODE_TEST_LANE_ENVIRONMENT_VARIABLE, "wrong", "invalid_environment"],
    ["USAGE_MONITOR_ACCOUNTING_SOURCE_MODE", "legacy", "invalid_environment"],
  ]) {
    assert.throws(
      () => createWindowsQualificationModeContext({
        ...contextOptions({ environment: environmentForTests({ [key]: value }) }),
      }),
      qualificationError(code),
    );
  }
  assert.throws(
    () => createWindowsQualificationModeContext({
      ...contextOptions({ accountingSourceMode: "legacy" }),
    }),
    qualificationError("accounting_mode"),
  );
});

test("requires the packaged resource authority and rechecks its manifest", () => {
  assert.throws(
    () => createWindowsQualificationModeContext({
      ...contextOptions({ resourceRoot: join(RESOURCE_ROOT, "missing") }),
    }),
    qualificationError("resource_authority"),
  );
  const environment = environmentForTests({
    USAGE_MONITOR_RESOURCE_ROOT: join(RESOURCE_ROOT, "missing"),
  });
  assert.throws(
    () => createWindowsQualificationModeContext({
      ...contextOptions({ environment, resourceRoot: RESOURCE_ROOT }),
    }),
    qualificationError("resource_authority"),
  );
  const adapter = adapterForTests();
  const context = createWindowsQualificationModeContext({
    ...contextOptions({ adapter }),
  });
  assert.equal(
    isWindowsQualificationModeContextFor({
      context,
      adapter,
      stateRoot: STATE_ROOT,
      resourceRoot: RESOURCE_ROOT,
    }),
    true,
  );
  assert.equal(
    isWindowsQualificationModeContextFor({
      context,
      adapter,
      stateRoot: STATE_ROOT,
      resourceRoot: join(RESOURCE_ROOT, "missing"),
    }),
    false,
  );
});

test("rejects central/contribution origins and development identity settings", () => {
  for (const [key, value, code] of [
    ["USAGE_MONITOR_CENTRAL_ORIGIN", "https://central.example", "forbidden_origin"],
    ["USAGE_MONITOR_CONTRIBUTION_SERVICE_ORIGIN", "https://central.example", "forbidden_origin"],
    ["USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE", "C:\\secret", "development_identity_forbidden"],
    ["USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY", "1", "development_identity_forbidden"],
    ["APP_USAGEMONITOR_EXPORT_SECRET", "secret", "development_identity_forbidden"],
  ]) {
    assert.throws(
      () => createWindowsQualificationModeContext({
        ...contextOptions({ environment: environmentForTests({ [key]: value }) }),
      }),
      qualificationError(code),
    );
  }
  for (const [key, value, code] of [
    ["centralOrigin", "https://central.example", "forbidden_origin"],
    ["contributionServiceOrigin", "https://central.example", "forbidden_origin"],
    ["developmentExportSecretFile", "C:\\secret", "development_identity_forbidden"],
    ["developmentIdentityOptIn", "1", "development_identity_forbidden"],
  ]) {
    assert.throws(
      () => createWindowsQualificationModeContext({
        ...contextOptions({ [key]: value }),
      }),
      qualificationError(code),
    );
  }
});

test("requires an exact repository-branded non-production adapter", () => {
  assert.throws(
    () => createWindowsQualificationModeContext({
      ...contextOptions({ adapter: null }),
    }),
    qualificationError("invalid_adapter"),
  );
  const adapter = adapterForTests();
  assert.throws(
    () => createWindowsQualificationModeContext({
      ...contextOptions({
        adapter: {
          ...adapter,
          productionSafe: true,
        },
      }),
    }),
    qualificationError("invalid_adapter"),
  );
  assert.throws(
    () => createWindowsQualificationModeContext({
      ...contextOptions({ adapter: { ...adapter } }),
    }),
    qualificationError("invalid_adapter"),
  );
});

test("rejects wrong logical platform/architecture and malformed disposable roots", () => {
  assert.throws(
    () => createWindowsQualificationModeContext({
      ...contextOptions({ platform: "darwin" }),
    }),
    qualificationError("unsupported_platform"),
  );
  assert.throws(
    () => createWindowsQualificationModeContext({
      ...contextOptions({ architecture: "arm64" }),
    }),
    qualificationError("unsupported_architecture"),
  );
  assert.throws(
    () => createWindowsQualificationModeContext({
      ...contextOptions({ environment: environmentForTests({ TEMP: "/tmp/not-windows" }) }),
    }),
    qualificationError("invalid_root"),
  );
  assert.throws(
    () => createWindowsQualificationModeContext({
      ...contextOptions({
        environment: environmentForTests({ TEMP: undefined }),
      }),
    }),
    qualificationError("invalid_environment"),
  );
});

test("rejects path escapes and paths outside TEMP", () => {
  const environment = environmentForTests();
  delete environment.USAGE_MONITOR_STATE_ROOT;
  for (const stateRoot of [
    `${TEMP_ROOT}\\..\\outside`,
    "C:\\Users\\runner\\outside",
    TEMP_ROOT,
    "relative-state",
  ]) {
    assert.throws(
      () => createWindowsQualificationModeContext({
        ...contextOptions({ environment, stateRoot }),
      }),
      (error) => error instanceof WindowsQualificationModeError,
    );
  }
  assert.throws(
    () => createWindowsQualificationModeContext({
      ...contextOptions({
        environment: environmentForTests({
          HOME: `${TEMP_ROOT}\\..\\outside-home`,
          USERPROFILE: `${TEMP_ROOT}\\..\\outside-home`,
        }),
      }),
    }),
    (error) => error instanceof WindowsQualificationModeError,
  );
  const codexEnvironment = environmentForTests();
  delete codexEnvironment.CODEX_HOME;
  assert.throws(
    () => createWindowsQualificationModeContext({
      ...contextOptions({
        environment: codexEnvironment,
        codexHome: "C:\\Users\\runner\\outside\\.codex",
      }),
    }),
    qualificationError("path_escape"),
  );
});

test("rejects junctions in disposable provider path components", () => {
  const binding = bindingForTests();
  binding.inspectPath = (path) => ({
    identity: {
      volumeSerialNumber: "0000000000000001",
      fileId: "00112233445566778899aabbccddeeff",
      linkCount: 1,
    },
    isDirectory: true,
    isRegularFile: false,
    isReparsePoint: path.toLowerCase() === HOME.toLowerCase(),
    finalPathResolved: true,
  });
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  assert.throws(
    () => createWindowsQualificationModeContext({
      ...contextOptions(),
      adapter,
    }),
    qualificationError("path_escape"),
  );
});
