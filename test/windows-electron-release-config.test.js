import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const electronBuilderRequire = createRequire(require.resolve("electron-builder/package.json"));
const appBuilderRequire = createRequire(
  electronBuilderRequire.resolve("app-builder-lib/package.json"),
);
const { WindowsSignAzureManager } = appBuilderRequire(
  "./out/codeSign/windowsSignAzureManager",
);
const RELEASE_CONFIG_PATH = resolve("apps/electron/electron-builder.release.config.cjs");
const PACKAGE_VERSION = require("../package.json").version;

async function loadPatchedWinPackagerRuntime() {
  const sourcePath = appBuilderRequire.resolve("./out/winPackager");
  const source = await fsPromises.readFile(sourcePath, "utf8");
  class InvalidConfigurationError extends Error {}
  class PlatformPackager {}
  const unusedDependency = new Proxy(function unusedDependency() {}, {
    apply: () => undefined,
    construct: () => ({}),
    get: () => unusedDependency,
  });
  const module = { exports: {} };
  const context = {
    BigInt,
    Buffer,
    clearTimeout,
    exports: module.exports,
    module,
    process,
    require: (request) => {
      if (request === "builder-util") {
        return { InvalidConfigurationError };
      }
      if (request === "fs/promises") {
        return fsPromises;
      }
      if (request === "path") {
        return appBuilderRequire("node:path");
      }
      if (request === "./platformPackager") {
        return { PlatformPackager };
      }
      return unusedDependency;
    },
    setTimeout,
  };
  runInNewContext(source, context, { filename: sourcePath });
  return module.exports;
}

function readReleaseConfigConstant(source, name) {
  const match = source.match(new RegExp(`const ${name} = "([^"\\n]+)";`, "u"));
  assert.notEqual(match, null, `${name} must remain a string constant`);
  return match[1];
}

async function releaseConfigEnvironment(overrides = {}) {
  const source = await fsPromises.readFile(RELEASE_CONFIG_PATH, "utf8");
  return {
    TIBOTATTLE_ELECTRON_TARGET: "win32",
    TIBOTATTLE_ELECTRON_SIGNING_MODE: "azure-trusted-signing",
    TIBOTATTLE_ELECTRON_VERSION: PACKAGE_VERSION,
    TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME:
      readReleaseConfigConstant(source, "AZURE_EXPECTED_PUBLISHER"),
    TIBOTATTLE_ELECTRON_AZURE_ENDPOINT:
      readReleaseConfigConstant(source, "AZURE_EXPECTED_ENDPOINT"),
    TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME:
      readReleaseConfigConstant(source, "AZURE_EXPECTED_ACCOUNT"),
    TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME:
      readReleaseConfigConstant(source, "AZURE_EXPECTED_PROFILE"),
    ...overrides,
  };
}

function loadReleaseConfig(environment) {
  const source = [
    `const config = require(${JSON.stringify(RELEASE_CONFIG_PATH)});`,
    "process.stdout.write(JSON.stringify({",
    "  forceCodeSigning: config.forceCodeSigning,",
    "  signExts: config.win.signExts,",
    "  ledgerLeaf: config.win.windowsSigningOperationLedgerLeaf,",
    "  ledgerRoot: config.win.windowsSigningOperationEvidenceRoot,",
    "  azureSignOptions: config.win.azureSignOptions,",
    "}));",
  ].join("\n");
  return spawnSync(process.execPath, ["-e", source], {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("Windows release config requires the patched signing runtime contract", async () => {
  const environment = await releaseConfigEnvironment();
  const result = loadReleaseConfig(environment);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.forceCodeSigning, true);
  assert.deepEqual(config.signExts, [".dll", "!.node"]);
  assert.equal(config.ledgerLeaf, "windows-signing-operation-ledger.json");
  assert.equal(basename(config.ledgerRoot), "evidence");
  assert.equal(config.azureSignOptions.ExcludeAzureCliCredential, undefined);
  for (const name of [
    "ExcludeEnvironmentCredential",
    "ExcludeWorkloadIdentityCredential",
    "ExcludeManagedIdentityCredential",
    "ExcludeSharedTokenCacheCredential",
    "ExcludeVisualStudioCredential",
    "ExcludeVisualStudioCodeCredential",
    "ExcludeAzurePowerShellCredential",
    "ExcludeAzureDeveloperCliCredential",
    "ExcludeInteractiveBrowserCredential",
  ]) {
    assert.equal(config.azureSignOptions[name], true, name);
  }

  const forbidden = loadReleaseConfig(await releaseConfigEnvironment({
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  }));
  assert.notEqual(forbidden.status, 0);
});

test("patched Azure signer serializes credential exclusions as switches and pins the module", async () => {
  const invocations = [];
  const vm = {
    powershellCommand: { value: Promise.resolve("powershell.exe") },
    toVmFile: (path) => path,
    exec: async (command, arguments_) => {
      invocations.push({ command, arguments_ });
    },
  };
  const manager = new WindowsSignAzureManager({
    platformSpecificBuildOptions: { azureSignOptions: { publisherName: "TiboTattle" } },
    vm: { value: Promise.resolve(vm) },
  });

  await manager.initialize();
  assert.equal(invocations.length, 2);
  assert.equal(
    invocations[1].arguments_.at(-1),
    "Install-Module -Name TrustedSigning -RequiredVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser",
  );

  await manager.signFile({
    path: "C:\\candidate.exe",
    options: {
      azureSignOptions: {
        publisherName: "TiboTattle",
        endpoint: "https://example.codesigning.azure.net/",
        certificateProfileName: "profile",
        codeSigningAccountName: "account",
        fileDigest: "SHA256",
        timestampRfc3161: "http://timestamp.example.invalid",
        timestampDigest: "SHA256",
        ExcludeEnvironmentCredential: true,
        ExcludeAzureCliCredential: false,
      },
    },
  });
  const command = invocations.at(-1).arguments_.at(-1);
  assert.match(command, /(?:^|\s)-ExcludeEnvironmentCredential(?:\s|$)/u);
  assert.doesNotMatch(command, /ExcludeEnvironmentCredential\s+'true'/u);
  assert.doesNotMatch(command, /ExcludeAzureCliCredential/u);
});

test("patched Windows runtime rejects builder .node signing and emits one content-free ledger", async () => {
  const winPackager = await loadPatchedWinPackagerRuntime();
  const canonicalTemporaryRoot = await fsPromises.realpath(tmpdir());
  const evidenceRoot = await fsPromises.mkdtemp(join(canonicalTemporaryRoot, "tibotattle-signing-ledger-"));
  const receiver = {
    windowsSigningOperationEvidenceRoot: evidenceRoot,
    windowsSigningOperationLedgerWritten: false,
    windowsSigningOperationLedgerPath: join(evidenceRoot, "windows-signing-operation-ledger.json"),
    windowsSigningOperationCounts: { exe: 2, dll: 1, node: 0, unexpected: 0 },
  };
  try {
    await winPackager.WinPackager.prototype.writeWindowsSigningOperationLedger.call(receiver);
    const ledger = JSON.parse(await fsPromises.readFile(receiver.windowsSigningOperationLedgerPath, "utf8"));
    assert.deepEqual(ledger, {
      schemaVersion: winPackager.WINDOWS_SIGNING_OPERATION_LEDGER_SCHEMA,
      status: winPackager.WINDOWS_SIGNING_OPERATION_LEDGER_STATUS,
      builder: "app-builder-lib",
      builderVersion: "26.15.7",
      ledgerCount: 1,
      operationCount: 3,
      classes: { exe: 2, dll: 1, node: 0, unexpected: 0 },
    });
    await assert.rejects(
      () => winPackager.WinPackager.prototype.writeWindowsSigningOperationLedger.call(receiver),
      /emitted more than once/u,
    );
    await assert.rejects(
      () => winPackager.WinPackager.prototype._sign.call({}, join(evidenceRoot, "native.node")),
      /rejected a native \.node signing attempt/u,
    );
  } finally {
    await fsPromises.rm(evidenceRoot, { recursive: true, force: true });
  }
});
