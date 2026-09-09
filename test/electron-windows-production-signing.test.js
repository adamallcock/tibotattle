import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  invokeElectronWindowsSigning,
  parseElectronWindowsSigningArguments,
  prepareElectronWindowsBuilderHost,
  preflightElectronWindowsSigning,
} from "../scripts/finalize-electron-windows-signing.mjs";
import { productionElectronCandidatePlan } from "../scripts/package-electron-production.mjs";

const require = createRequire(import.meta.url);
const electronBuilderRequire = createRequire(require.resolve("electron-builder/package.json"));
const appBuilderRequire = createRequire(
  electronBuilderRequire.resolve("app-builder-lib/package.json"),
);
const { WindowsSignAzureManager } = appBuilderRequire(
  "./out/codeSign/windowsSignAzureManager",
);
const { VmManager } = appBuilderRequire("./out/vm/vm");

const SOURCE_REVISION = "a".repeat(40);
const BUILD_NUMBER = "20260909";
const RESOURCE_ENVIRONMENT = Object.freeze({
  TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME: "Publisher",
  TIBOTATTLE_ELECTRON_AZURE_ENDPOINT: "https://example.codesigning.azure.net/",
  TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME: "account",
  TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME: "profile",
});
const WINDOWS_SIGNING_ENVIRONMENT = Object.freeze({
  ...RESOURCE_ENVIRONMENT,
  AZURE_CONFIG_DIR: "C:\\azureCli",
  SystemRoot: "C:\\Windows",
});

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-signing-"));
  try {
    const candidatePath = join(
      root,
      ".release-build",
      "electron-production",
      "win32-x64",
      "production-source-candidate.json",
    );
    const candidate = {
      ...productionElectronCandidatePlan({
        target: "win32-x64",
        sourceRevision: SOURCE_REVISION,
        buildNumber: BUILD_NUMBER,
        hostPlatform: "win32",
        hostArchitecture: "x64",
      }),
      status: "production_source_staged",
      stagedManifest: "app/package.json",
      runtimeManifest: "app/electron-runtime-manifest.json",
    };
    await mkdir(join(root, ".release-build", "electron-production", "win32-x64"), {
      recursive: true,
      mode: 0o700,
    });
    const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    await writeFile(candidatePath, bytes, { flag: "wx", mode: 0o600 });
    return await run({ bytes, candidate, candidatePath, root });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function successfulResult({ stdout = "" } = {}) {
  return { error: undefined, signal: null, status: 0, stdout };
}

function testDependencies({ calls = [], environment = WINDOWS_SIGNING_ENVIRONMENT,
  azureCliResult = null, builderHostModuleResult = null, builderResult = null } = {}) {
  return {
    architecture: "x64",
    builderCli: "C:\\reviewed\\electron-builder.cjs",
    environment,
    platform: "win32",
    repositoryRoot: undefined,
    run(command, arguments_, options) {
      calls.push({ arguments: arguments_, command, environment: options?.environment,
        captureOutput: options?.captureOutput === true });
      if (command === "git" && arguments_[0] === "rev-parse") {
        return successfulResult({ stdout: `${SOURCE_REVISION}\n` });
      }
      if (command === "C:\\Windows\\System32\\cmd.exe" && azureCliResult !== null) {
        return azureCliResult;
      }
      if (command === process.execPath && arguments_[0] === "-e"
          && arguments_[1].includes("WindowsSignAzureManager")
          && builderHostModuleResult !== null) {
        return builderHostModuleResult;
      }
      if (command === process.execPath && arguments_[0] === "C:\\reviewed\\electron-builder.cjs"
          && builderResult !== null) {
        return builderResult;
      }
      return successfulResult();
    },
    version: "v26.2.0",
  };
}

test("Windows signing preflight validates the canonical source receipt without writing or Azure access", async () => {
  await withFixture(async ({ bytes, candidatePath, root }) => {
    const calls = [];
    const dependencies = testDependencies({ calls });
    dependencies.repositoryRoot = root;
    const before = await readFile(candidatePath);
    const receipt = await preflightElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies);
    assert.deepEqual(receipt, {
      schemaVersion: "tibotattle-electron-windows-signing-preflight-v1",
      status: "preflight_ready",
      scope: "no_signing_or_packaging_performed",
      candidate: {
        buildNumber: BUILD_NUMBER,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sourceRevision: SOURCE_REVISION,
        target: "win32-x64",
        version: candidateVersion(),
      },
      builderConfiguration: "apps/electron/electron-builder.release.config.cjs",
      azureResourceConfiguration: "validated",
      host: "windows_x64_node_26_2_0",
      nativeModuleFinalization: "not_performed",
      windowsRuntimeQualification: "required",
    });
    assert.deepEqual(await readFile(candidatePath), before);
    assert.equal((await lstat(candidatePath)).nlink, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, process.execPath);
    assert.deepEqual(calls[0].arguments.slice(0, 1), ["-e"]);
  });
});

function candidateVersion() {
  return productionElectronCandidatePlan({
    target: "win32-x64",
    sourceRevision: SOURCE_REVISION,
    buildNumber: BUILD_NUMBER,
    hostPlatform: "win32",
    hostArchitecture: "x64",
  }).version;
}

test("Windows signing preflight reports missing host or resource selection without invoking Azure", async () => {
  await withFixture(async ({ candidatePath, root }) => {
    const calls = [];
    const dependencies = testDependencies({ calls, environment: {} });
    dependencies.repositoryRoot = root;
    dependencies.platform = "darwin";
    const receipt = await preflightElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies);
    assert.equal(receipt.status, "preflight_incomplete");
    assert.equal(receipt.azureResourceConfiguration, "missing_or_invalid");
    assert.equal(receipt.host, "windows_x64_node_26_2_0_required");
    assert.equal(calls.length, 0);
  });
});

test("Windows signing invocation is explicit, strips ambient secrets, and keeps publishing disabled", async () => {
  await withFixture(async ({ candidatePath, root }) => {
    const calls = [];
    const environment = {
      ...RESOURCE_ENVIRONMENT,
      AZURE_CONFIG_DIR: "C:\\azureCli",
      AZURE_EXTENSION_DIR: "must-not-reach-builder",
      CSC_LINK: "must-not-reach-builder",
      AZURE_CLIENT_SECRET: "must-not-reach-builder",
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\signer",
    };
    const dependencies = testDependencies({ calls, environment });
    dependencies.repositoryRoot = root;
    const receipt = await invokeElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies);
    assert.equal(receipt.status, "builder_signing_completed_pending_native_module_finalization");
    assert.equal(receipt.publishing, "not_performed");
    assert.equal(receipt.nativeModuleFinalization, "required_before_signed_candidate_receipt");
    assert.equal(calls.length, 5);
    assert.deepEqual(calls.map(({ command, arguments: args }) => [command, args]), [
      [process.execPath, calls[0].arguments],
      ["git", ["rev-parse", "--verify", "HEAD"]],
      ["git", ["status", "--porcelain=v1", "--untracked-files=all"]],
      ["C:\\Windows\\System32\\cmd.exe", [
        "/d", "/s", "/c", "az account show --only-show-errors --output none",
      ]],
      [process.execPath, [
        "C:\\reviewed\\electron-builder.cjs",
        "--config", join(root, "apps", "electron", "electron-builder.release.config.cjs"),
        "--win", "nsis", "--x64", "--publish", "never",
      ]],
    ]);
    assert.equal(calls[1].captureOutput, true);
    assert.equal(calls[2].captureOutput, true);
    assert.equal(calls[3].captureOutput, true);
    assert.equal(calls[4].captureOutput, true);
    const builderEnvironment = calls.at(-1).environment;
    assert.equal(builderEnvironment.CSC_LINK, undefined);
    assert.equal(builderEnvironment.AZURE_CLIENT_SECRET, undefined);
    assert.equal(builderEnvironment.AZURE_EXTENSION_DIR, undefined);
    assert.equal(builderEnvironment.AZURE_CONFIG_DIR, "C:\\azureCli");
    assert.equal(builderEnvironment.TIBOTATTLE_ELECTRON_TARGET, "win32-x64");
    assert.equal(builderEnvironment.TIBOTATTLE_ELECTRON_WINDOWS_SOURCE_CANDIDATE_RECEIPT, candidatePath);
  });
});

test("Windows signing preserves only the fixed GitHub-hosted Azure CLI cache directory", async () => {
  for (const environment of [
    { ...WINDOWS_SIGNING_ENVIRONMENT, AZURE_CONFIG_DIR: undefined },
    { ...WINDOWS_SIGNING_ENVIRONMENT, AZURE_CONFIG_DIR: "C:\\untrusted" },
  ]) {
    await withFixture(async ({ candidatePath, root }) => {
      const calls = [];
      const dependencies = testDependencies({ calls, environment });
      dependencies.repositoryRoot = root;
      await assert.rejects(
        invokeElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies),
        { code: "ELECTRON_WINDOWS_SIGNING_AZURE_CLI_CONFIG_DIRECTORY_UNAVAILABLE" },
      );
      assert.equal(calls.length, 0);
    });
  }
});

test("Windows signing classifies the fixed Azure CLI account probe without retaining its output", async () => {
  await withFixture(async ({ candidatePath, root }) => {
    const calls = [];
    const dependencies = testDependencies({
      calls,
      azureCliResult: {
        error: { code: "ENOENT" }, signal: null, status: null,
        stdout: "", stderr: "untrusted diagnostic content",
      },
    });
    dependencies.repositoryRoot = root;
    await assert.rejects(
      invokeElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies),
      { code: "ELECTRON_WINDOWS_SIGNING_AZURE_CLI_ACCOUNT_SHOW_LAUNCH_UNAVAILABLE" },
    );
    const invocation = calls.at(-1);
    assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(invocation.arguments, [
      "/d", "/s", "/c", "az account show --only-show-errors --output none",
    ]);
    assert.equal(invocation.captureOutput, true);
  });

  await withFixture(async ({ candidatePath, root }) => {
    const dependencies = testDependencies({
      azureCliResult: {
        error: undefined, signal: null, status: 1, stdout: "",
        stderr: "ERROR: Please run 'az login' to setup account.",
      },
    });
    dependencies.repositoryRoot = root;
    await assert.rejects(
      invokeElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies),
      { code: "ELECTRON_WINDOWS_SIGNING_AZURE_CLI_ACCOUNT_SHOW_AUTHENTICATION_UNAVAILABLE" },
    );
  });
});

test("Windows builder-host preparation uses the resolved manager contract before native signing", async () => {
  await withFixture(async ({ candidatePath, root }) => {
    const calls = [];
    const environment = {
      ...WINDOWS_SIGNING_ENVIRONMENT,
      AZURE_CLIENT_SECRET: "must-not-reach-builder",
    };
    const dependencies = testDependencies({
      calls,
      environment,
      builderHostModuleResult: successfulResult({
        stdout: "TIBOTATTLE_ELECTRON_BUILDER_HOST_MODULE_READY\n",
      }),
    });
    dependencies.repositoryRoot = root;
    const receipt = await prepareElectronWindowsBuilderHost(
      { candidateReceiptPath: candidatePath },
      dependencies,
    );
    assert.deepEqual(receipt, {
      schemaVersion: "tibotattle-electron-windows-builder-host-preflight-v1",
      status: "builder_host_module_ready",
      scope: "builder_dependency_initialization_only_no_azure_signing",
      candidate: {
        buildNumber: BUILD_NUMBER,
        sha256: createHash("sha256").update(await readFile(candidatePath)).digest("hex"),
        sourceRevision: SOURCE_REVISION,
        target: "win32-x64",
        version: candidateVersion(),
      },
      azureResourceConfiguration: "validated",
      builderConfiguration: "apps/electron/electron-builder.release.config.cjs",
      builderHost: "electron_builder_vm_manager",
      trustedSigningModulePreflight: "required_version_0_5_0_import_switch_contract_verified",
      nativeModuleFinalization: "not_performed",
      signing: "not_performed",
      windowsRuntimeQualification: "required",
    });
    assert.equal(calls.length, 2);
    const invocation = calls.at(-1);
    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.arguments[0], "-e");
    assert.equal(invocation.captureOutput, true);
    assert.match(invocation.arguments[1], /new WindowsSignAzureManager/u);
    assert.match(invocation.arguments[1], /Import-Module -Name TrustedSigning -RequiredVersion 0\.5\.0/u);
    assert.match(invocation.arguments[1], /Get-Command -Name Invoke-TrustedSigning/u);
    assert.match(invocation.arguments[1], /System\.Management\.Automation\.SwitchParameter/u);
    assert.doesNotMatch(invocation.arguments[1], /signFile/u);
    assert.equal(invocation.environment.AZURE_CLIENT_SECRET, undefined);
    assert.equal(invocation.environment.AZURE_CONFIG_DIR, "C:\\azureCli");
  });
});

test("builder-host preflight shim satisfies the resolved VM and manager initialization contract", async () => {
  const invocations = [];
  const vm = new VmManager();
  vm.exec = async (command, arguments_) => {
    invocations.push({ arguments_, command });
    return "";
  };
  const manager = new WindowsSignAzureManager({
    platformSpecificBuildOptions: { azureSignOptions: { publisherName: "TiboTattle" } },
    vm: { value: Promise.resolve(vm) },
  });
  await manager.initialize();
  assert.deepEqual(invocations, [
    ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Command pwsh.exe"]],
    ["pwsh.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser",
    ]],
    ["pwsh.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Install-Module -Name TrustedSigning -RequiredVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser",
    ]],
  ].map(([command, arguments_]) => ({ arguments_, command })));
});

test("Windows builder failures expose only fixed diagnostic fields", async () => {
  await withFixture(async ({ candidatePath, root }) => {
    const dependencies = testDependencies({
      builderResult: {
        error: undefined,
        signal: null,
        status: 1,
        stderr: "Parameter cannot be found; arbitrary-private-builder-content",
        stdout: "",
      },
    });
    dependencies.repositoryRoot = root;
    await assert.rejects(
      invokeElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies),
      (error) => {
        assert.equal(error.code, "ELECTRON_WINDOWS_SIGNING_BUILDER_SIGNING_FAILED");
        assert.equal(
          error.diagnostic,
          "ELECTRON_WINDOWS_SIGNING_BUILDER_DIAGNOSTIC;stage=command_serialization;exit=code_1;spawn=none;outer_pwsh_lookup=no;module_install=no;module_import=no;command_serialization=yes;packaging_metadata=no;signer=no",
        );
        assert.doesNotMatch(error.diagnostic, /arbitrary-private-builder-content/u);
        return true;
      },
    );
  });

  await withFixture(async ({ candidatePath, root }) => {
    const dependencies = testDependencies({
      builderResult: {
        error: { code: "ENOENT" }, signal: null, status: null,
        stderr: "arbitrary-private-builder-content", stdout: "",
      },
    });
    dependencies.repositoryRoot = root;
    await assert.rejects(
      invokeElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies),
      (error) => {
        assert.equal(error.code, "ELECTRON_WINDOWS_SIGNING_BUILDER_SIGNING_FAILED");
        assert.equal(
          error.diagnostic,
          "ELECTRON_WINDOWS_SIGNING_BUILDER_DIAGNOSTIC;stage=unknown;exit=none;spawn=not_found;outer_pwsh_lookup=no;module_install=no;module_import=no;command_serialization=no;packaging_metadata=no;signer=no",
        );
        return true;
      },
    );
  });

  await withFixture(async ({ candidatePath, root }) => {
    const dependencies = testDependencies({
      builderResult: {
        error: { code: "ENOBUFS" }, signal: null, status: null,
        stderr: "arbitrary-private-builder-content", stdout: "",
      },
    });
    dependencies.repositoryRoot = root;
    await assert.rejects(
      invokeElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies),
      (error) => {
        assert.equal(error.code, "ELECTRON_WINDOWS_SIGNING_BUILDER_SIGNING_FAILED");
        assert.match(error.diagnostic, /;exit=none;spawn=buffer_overflow;/u);
        return true;
      },
    );
  });
});

test("Windows signing refuses ambiguous invocation and unavailable prerequisites before a signer runs", async () => {
  assert.deepEqual(
    parseElectronWindowsSigningArguments([
      "--candidate-receipt", "candidate.json",
    ]),
    { candidateReceiptPath: "candidate.json", prepareBuilderHost: false, sign: false },
  );
  assert.deepEqual(
    parseElectronWindowsSigningArguments([
      "--prepare-builder-host", "--candidate-receipt", "candidate.json",
    ]),
    { candidateReceiptPath: "candidate.json", prepareBuilderHost: true, sign: false },
  );
  assert.deepEqual(
    parseElectronWindowsSigningArguments([
      "--sign", "--confirm-azure-trusted-signing", "--candidate-receipt", "candidate.json",
    ]),
    { candidateReceiptPath: "candidate.json", prepareBuilderHost: false, sign: true },
  );
  assert.throws(
    () => parseElectronWindowsSigningArguments(["--sign", "--candidate-receipt", "candidate.json"]),
    { code: "ELECTRON_WINDOWS_SIGNING_ARGUMENT_INVALID" },
  );
  await withFixture(async ({ candidatePath, root }) => {
    const calls = [];
    const dependencies = testDependencies({ calls });
    dependencies.repositoryRoot = root;
    dependencies.architecture = "arm64";
    await assert.rejects(
      invokeElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies),
      { code: "ELECTRON_WINDOWS_SIGNING_SIGNING_PREREQUISITES_UNAVAILABLE" },
    );
    assert.equal(calls.length, 0);
  });
});
