import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { createProductionDistributionMetadata } from "../apps/electron/desktop-updater.js";
import { productionElectronCandidatePlan } from "../scripts/package-electron-production.mjs";
import { extractEsmImports } from "../scripts/lib/esm-imports.mjs";

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
const RELEASE_SOURCE_REVISION = "a".repeat(40);
const RELEASE_BUILD_NUMBER = "20260909";
const RELEASE_STAGING_ROOT = resolve(".release-build/electron-production/win32-x64");
const RELEASE_CANDIDATE_PATH = join(RELEASE_STAGING_ROOT, "production-source-candidate.json");
const POLICY = require("../config/electron-production-distribution.cjs");

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
      if (request === "./codeSign/windowsCodeSign") {
        return { signWindows: async () => true };
      }
      return unusedDependency;
    },
    setTimeout,
  };
  runInNewContext(source, context, { filename: sourcePath });
  return module.exports;
}

async function loadPatchedPlatformPackagerRuntime() {
  const sourcePath = appBuilderRequire.resolve("./out/platformPackager");
  const source = await fsPromises.readFile(sourcePath, "utf8");
  const unusedDependency = new Proxy(function unusedDependency() {}, {
    apply: () => undefined,
    construct: () => ({}),
    get: () => unusedDependency,
  });
  const module = { exports: {} };
  const context = {
    Buffer,
    clearTimeout,
    exports: module.exports,
    module,
    process,
    require: (request) => (
      request === "builder-util" ? appBuilderRequire("builder-util") : unusedDependency
    ),
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
    TIBOTATTLE_ELECTRON_TARGET: "win32-x64",
    TIBOTATTLE_ELECTRON_SIGNING_MODE: "azure-trusted-signing",
    TIBOTATTLE_ELECTRON_VERSION: PACKAGE_VERSION,
    TIBOTATTLE_ELECTRON_SOURCE_REVISION: RELEASE_SOURCE_REVISION,
    TIBOTATTLE_ELECTRON_BUILD_NUMBER: RELEASE_BUILD_NUMBER,
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

async function withReleaseConfigFixture(run) {
  let created = false;
  try {
    await fsPromises.lstat(RELEASE_STAGING_ROOT);
    throw new Error("Windows release-config fixture root already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    const plan = productionElectronCandidatePlan({
      target: "win32-x64",
      sourceRevision: RELEASE_SOURCE_REVISION,
      buildNumber: RELEASE_BUILD_NUMBER,
      hostPlatform: "win32",
      hostArchitecture: "x64",
    });
    const candidate = {
      ...plan,
      status: "production_source_staged",
      stagedManifest: "app/package.json",
      runtimeManifest: "app/electron-runtime-manifest.json",
    };
    const distribution = createProductionDistributionMetadata({
      target: "win32-x64",
      sourceRevision: RELEASE_SOURCE_REVISION,
      buildNumber: RELEASE_BUILD_NUMBER,
    });
    await fsPromises.mkdir(join(RELEASE_STAGING_ROOT, "app"), { recursive: true, mode: 0o700 });
    created = true;
    await fsPromises.writeFile(
      join(RELEASE_STAGING_ROOT, "app", "package.json"),
      `${JSON.stringify({
        name: "app-usagemonitor",
        version: PACKAGE_VERSION,
        tibotattleDistribution: distribution,
      }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    await fsPromises.writeFile(RELEASE_CANDIDATE_PATH, candidateBytes, {
      encoding: "utf8",
      mode: 0o600,
    });
    const environment = await releaseConfigEnvironment({
      TIBOTATTLE_ELECTRON_WINDOWS_SOURCE_CANDIDATE_RECEIPT: RELEASE_CANDIDATE_PATH,
      TIBOTATTLE_ELECTRON_WINDOWS_SOURCE_CANDIDATE_SHA256:
        createHash("sha256").update(candidateBytes).digest("hex"),
    });
    return await run({ candidate, environment, plan });
  } finally {
    if (created) await fsPromises.rm(RELEASE_STAGING_ROOT, { recursive: true, force: true });
  }
}

function loadReleaseConfig(environment) {
  const source = [
    `const config = require(${JSON.stringify(RELEASE_CONFIG_PATH)});`,
    "process.stdout.write(JSON.stringify({",
    "  appId: config.appId,",
    "  buildNumber: config.buildNumber,",
    "  buildVersion: config.buildVersion,",
    "  directories: config.directories,",
    "  extraMetadata: config.extraMetadata,",
    "  forceCodeSigning: config.forceCodeSigning,",
    "  nsisGuid: config.nsis.guid,",
    "  publish: config.publish,",
    "  files: config.files,",
    "  signExts: config.win.signExts,",
    "  icon: config.win.icon,",
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

function validateReleaseConfig(environment) {
  const source = [
    'const { createRequire } = require("node:module");',
    'const electronBuilderRequire = createRequire(require.resolve("electron-builder/package.json"));',
    'const appBuilderRequire = createRequire(electronBuilderRequire.resolve("app-builder-lib/package.json"));',
    'const { validateConfiguration } = appBuilderRequire("./out/util/config/config");',
    `const config = require(${JSON.stringify(RELEASE_CONFIG_PATH)});`,
    'validateConfiguration(config, { isEnabled: false, add() {} }).then(',
    '  () => process.stdout.write("WINDOWS_RELEASE_BUILDER_SCHEMA_VALID\\n"),',
    '  () => { process.exitCode = 1; },',
    ');',
  ].join("\n");
  return spawnSync(process.execPath, ["-e", source], {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function staticallyImportedMacOSCredentialContract() {
  const mainPath = resolve("apps/electron/main.js");
  const mainImports = await extractEsmImports(await fsPromises.readFile(mainPath, "utf8"), {
    sourceName: mainPath,
  });
  const macOSCredentialImport = mainImports.find((entry) => entry.kind === "import"
    && entry.specifier === "./desktop-macos-keychain.js");
  assert.notEqual(macOSCredentialImport, undefined, "main must retain its credential composition import");
  const macOSCredentialPath = resolve(dirname(mainPath), macOSCredentialImport.specifier);
  const credentialImports = await extractEsmImports(
    await fsPromises.readFile(macOSCredentialPath, "utf8"),
    { sourceName: macOSCredentialPath },
  );
  const contractImport = credentialImports.find((entry) => entry.kind === "import"
    && typeof entry.specifier === "string"
    && entry.specifier.startsWith("../../native/macos-keychain/"));
  assert.notEqual(contractImport, undefined, "credential facade must retain its native contract import");
  return relative(resolve("."), resolve(dirname(macOSCredentialPath), contractImport.specifier))
    .split(sep).join("/");
}

test("Windows release config requires the patched signing runtime contract", async () => {
  await withReleaseConfigFixture(async ({ candidate, environment }) => {
    const result = loadReleaseConfig(environment);
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.appId, POLICY.PRODUCTION_ELECTRON_APP_ID);
    assert.equal(config.buildNumber, RELEASE_BUILD_NUMBER);
    assert.equal(
      config.buildVersion,
      POLICY.productionElectronBuildVersionForTarget({
        target: "win32-x64",
        version: PACKAGE_VERSION,
        buildNumber: RELEASE_BUILD_NUMBER,
      }),
    );
    assert.deepEqual(config.directories, {
      app: join(RELEASE_STAGING_ROOT, "app"),
      output: join(RELEASE_STAGING_ROOT, "artifacts"),
    });
    assert.deepEqual(config.publish, [{ provider: "generic", url: candidate.updateFeed }]);
    assert.equal(config.nsisGuid, POLICY.PRODUCTION_ELECTRON_WINDOWS_TOAST_ACTIVATOR_CLSID);
    assert.equal(config.extraMetadata.tibotattleDistribution.target, "win32-x64");
    assert.equal(config.forceCodeSigning, true);
    assert.equal(config.icon, resolve("apps/electron/assets/tibotattle.ico"));
    assert.ok(config.files[0].filter.includes(await staticallyImportedMacOSCredentialContract()));
    assert.equal(config.files[0].filter.includes("native/macos-keychain.node"), false);
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
    const validated = validateReleaseConfig(environment);
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(validated.stdout, "WINDOWS_RELEASE_BUILDER_SCHEMA_VALID\n");

    const forbidden = loadReleaseConfig({
      ...environment,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    });
    assert.notEqual(forbidden.status, 0);

    const mismatchedReceiptDigest = loadReleaseConfig({
      ...environment,
      TIBOTATTLE_ELECTRON_WINDOWS_SOURCE_CANDIDATE_SHA256: "b".repeat(64),
    });
    assert.notEqual(mismatchedReceiptDigest.status, 0);

    const wrongTarget = loadReleaseConfig({
      ...environment,
      TIBOTATTLE_ELECTRON_TARGET: "win32",
    });
    assert.notEqual(wrongTarget.status, 0);
  });
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
      () => winPackager.WinPackager.prototype._sign.call({
        windowsSigningOperationEvidenceRoot: evidenceRoot,
      }, join(evidenceRoot, "native.node")),
      /rejected a native \.node signing attempt/u,
    );
    const untrackedCounts = { exe: 0, dll: 0, node: 0, unexpected: 0 };
    assert.equal(
      await winPackager.WinPackager.prototype._sign.call({
        forceCodeSigning: false,
        platformSpecificBuildOptions: {},
        windowsSigningOperationCounts: untrackedCounts,
        windowsSigningOperationEvidenceRoot: null,
      }, join(evidenceRoot, "native.node")),
      true,
    );
    assert.deepEqual(untrackedCounts, { exe: 0, dll: 0, node: 0, unexpected: 0 });
  } finally {
    await fsPromises.rm(evidenceRoot, { recursive: true, force: true });
  }
});

test("patched build finalizer includes deferred NSIS signing once across architectures", async () => {
  const { Packager } = appBuilderRequire("./out/packager");
  const { PlatformPackager } = await loadPatchedPlatformPackagerRuntime();
  const { Platform } = appBuilderRequire("./out/core");
  const { Arch } = appBuilderRequire("builder-util");
  const output = await fsPromises.mkdtemp(join(tmpdir(), "windows-ledger-lifecycle-"));
  try {
    for (const scenario of ["complete", "sync-failure", "async-failure", "cancelled", "linux"]) {
      const events = [], cancellationToken = { cancelled: false };
      const platform = scenario === "linux" ? Platform.LINUX : Platform.WINDOWS;
      const targets = [false, true].map((isAsyncSupported) => ({
        name: isAsyncSupported ? "async-fixture" : "nsis-fixture", outDir: output, isAsyncSupported,
        build: async (_directory, arch) => { events.push(`build-${arch}`); },
        finishBuild: async () => {
          events.push(isAsyncSupported ? "async-finish" : "installer-sign");
          await new Promise((done) => setImmediate(done));
          if (scenario === (isAsyncSupported ? "async-failure" : "sync-failure")) throw new Error("synthetic target failure");
          if (scenario === "cancelled") cancellationToken.cancelled = true;
          events.push(isAsyncSupported ? "async-finished" : "uninstaller-sign");
        },
      }));
      const helper = {
        info: { cancellationToken }, platform, config: { directories: { output } },
        expandMacro: () => output, defaultTarget: targets.map((target) => target.name),
        createTargets: (_names, mapper) => { for (const target of targets) mapper(target.name, () => target); },
        writeWindowsSigningOperationLedger: async () => { events.push("ledger"); },
        pack: async (_out, arch, selected, tasks) => {
          PlatformPackager.prototype.packageInDistributableFormat.call(helper, output, arch, selected, tasks);
        },
      };
      const receiver = { cancellationToken, projectDir: output,
        config: { directories: { output } },
        options: { targets: new Map([[platform, new Map([[Arch.x64, helper.defaultTarget], [Arch.arm64, helper.defaultTarget]])]]) },
        createHelper: async () => helper,
      };
      if (scenario.endsWith("failure")) {
        await assert.rejects(Packager.prototype.doBuild.call(receiver), /synthetic target failure/u);
        assert.equal(events.includes("ledger"), false, scenario);
      } else {
        await Packager.prototype.doBuild.call(receiver);
        assert.equal(events.filter((event) => event === "ledger").length, scenario === "complete" ? 1 : 0, scenario);
        if (scenario === "complete") {
          assert.equal(events.at(-1), "ledger");
          assert.ok(events.indexOf("ledger") > events.indexOf("async-finished"));
          assert.ok(events.indexOf("ledger") > events.indexOf("uninstaller-sign"));
          assert.equal(events.filter((event) => event.startsWith("build-")).length, 4);
        }
      }
    }
  } finally { await fsPromises.rm(output, { recursive: true, force: true }); }
});

test("Windows branding contains all taskbar and installer icon sizes", async () => {
  const bytes = await fsPromises.readFile(resolve("apps/electron/assets/tibotattle.ico"));
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  assert.equal(bytes.readUInt16LE(4), sizes.length);
  let expectedOffset = 6 + sizes.length * 16;
  for (const [index, size] of sizes.entries()) {
    const offset = 6 + index * 16;
    assert.equal(bytes[offset] || 256, size);
    assert.equal(bytes[offset + 1] || 256, size);
    assert.equal(bytes.readUInt16LE(offset + 6), 32);
    const length = bytes.readUInt32LE(offset + 8);
    const imageOffset = bytes.readUInt32LE(offset + 12);
    assert.equal(imageOffset, expectedOffset);
    assert.ok(length > 24 && imageOffset + length <= bytes.length);
    const png = bytes.subarray(imageOffset, imageOffset + length);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    expectedOffset += length;
  }
  assert.equal(expectedOffset, bytes.length);
});
