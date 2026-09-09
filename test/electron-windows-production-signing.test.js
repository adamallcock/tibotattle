import assert from "node:assert/strict";
import { createDecipheriv, createHash, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
const DIAGNOSTIC_PUBLIC_KEY_BASE64_ENV = "TIBOTATTLE_ELECTRON_WINDOWS_BUILDER_DIAGNOSTIC_PUBLIC_KEY_BASE64";
const DIAGNOSTIC_PUBLIC_KEY_SHA256_ENV = "TIBOTATTLE_ELECTRON_WINDOWS_BUILDER_DIAGNOSTIC_PUBLIC_KEY_SHA256";

function diagnosticKeyPair() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 4096 });
  const publicKey = Buffer.from(pair.publicKey.export({ format: "pem", type: "spki" }), "utf8");
  return {
    environment: Object.freeze({
      ...WINDOWS_SIGNING_ENVIRONMENT,
      [DIAGNOSTIC_PUBLIC_KEY_BASE64_ENV]: publicKey.toString("base64"),
      [DIAGNOSTIC_PUBLIC_KEY_SHA256_ENV]: createHash("sha256").update(publicKey).digest("hex"),
    }),
    privateKey: pair.privateKey,
  };
}

function decryptDiagnosticEnvelope(envelope, privateKey) {
  const aes = privateDecrypt({ key: privateKey, oaepHash: "sha256" }, Buffer.from(envelope.wrappedKey, "base64"));
  try {
    const decipher = createDecipheriv("aes-256-gcm", aes, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(JSON.stringify({
      binding: envelope.binding,
      schemaVersion: envelope.schemaVersion,
    }), "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
  } finally {
    aes.fill(0);
  }
}

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
    const run = dependencies.run;
    dependencies.run = (command, arguments_, options) => {
      if (command === process.execPath && arguments_[0] === "C:\\reviewed\\electron-builder.cjs") {
        const evidenceRoot = join(root, ".release-build", "electron-production", "win32-x64", "evidence");
        assert.equal(existsSync(evidenceRoot), true);
        const metadata = lstatSync(evidenceRoot);
        assert.equal(metadata.isDirectory(), true);
        assert.equal(metadata.isSymbolicLink(), false);
      }
      return run(command, arguments_, options);
    };
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
    const evidenceRoot = join(root, ".release-build", "electron-production", "win32-x64", "evidence");
    const evidenceMetadata = await lstat(evidenceRoot);
    assert.equal(evidenceMetadata.isDirectory(), true);
    assert.equal(evidenceMetadata.isSymbolicLink(), false);
    await assert.rejects(lstat(join(evidenceRoot, "windows-signing-operation-ledger.json")), { code: "ENOENT" });
  });
});

test("Windows signing prepares only the exact new ledger root before builder access", async () => {
  await withFixture(async ({ candidatePath, root }) => {
    const evidenceRoot = join(root, ".release-build", "electron-production", "win32-x64", "evidence");
    const ledgerPath = join(evidenceRoot, "windows-signing-operation-ledger.json");
    await mkdir(evidenceRoot, { mode: 0o700 });
    await writeFile(ledgerPath, "stale-ledger\n", { flag: "wx", mode: 0o600 });
    const calls = [];
    const dependencies = testDependencies({ calls });
    dependencies.repositoryRoot = root;
    await assert.rejects(
      invokeElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies),
      { code: "ELECTRON_WINDOWS_SIGNING_SIGNING_OPERATION_LEDGER_PREEXISTS" },
    );
    assert.equal(calls.some(({ command }) => command === "C:\\Windows\\System32\\cmd.exe"), false);
    assert.equal(calls.some(({ arguments: args }) => args[0] === "C:\\reviewed\\electron-builder.cjs"), false);
    assert.deepEqual(await readFile(ledgerPath, "utf8"), "stale-ledger\n");
  });

  await withFixture(async ({ candidatePath, root }) => {
    const evidenceRoot = join(root, ".release-build", "electron-production", "win32-x64", "evidence");
    const alternateRoot = join(root, "alternate-evidence");
    await mkdir(alternateRoot, { mode: 0o700 });
    await symlink(alternateRoot, evidenceRoot, "dir");
    const calls = [];
    const dependencies = testDependencies({ calls });
    dependencies.repositoryRoot = root;
    await assert.rejects(
      invokeElectronWindowsSigning({ candidateReceiptPath: candidatePath }, dependencies),
      { code: "ELECTRON_WINDOWS_SIGNING_SIGNING_OPERATION_EVIDENCE_ROOT_UNAVAILABLE" },
    );
    assert.equal(calls.some(({ command }) => command === "C:\\Windows\\System32\\cmd.exe"), false);
    assert.equal(calls.some(({ arguments: args }) => args[0] === "C:\\reviewed\\electron-builder.cjs"), false);
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
        stderr: "Parameter cannot be found; EPERM; arbitrary-private-builder-content",
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
          "ELECTRON_WINDOWS_SIGNING_BUILDER_DIAGNOSTIC;stage=command_serialization;exit=code_1;spawn=none;vendor_code=EPERM;outer_pwsh_lookup=no;module_install=no;module_import=no;command_serialization=yes;packaging_metadata=no;signer=no",
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
          "ELECTRON_WINDOWS_SIGNING_BUILDER_DIAGNOSTIC;stage=unknown;exit=none;spawn=not_found;vendor_code=unknown;outer_pwsh_lookup=no;module_install=no;module_import=no;command_serialization=no;packaging_metadata=no;signer=no",
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

test("Windows builder failure capture encrypts bounded raw output and binds it to the exact candidate", async () => {
  await withFixture(async ({ bytes, candidatePath, root }) => {
    const { environment, privateKey } = diagnosticKeyPair();
    const calls = [];
    const dependencies = testDependencies({
      calls,
      environment,
      builderResult: {
        error: undefined,
        signal: null,
        status: 1,
        stdout: "private builder stdout that must not reach CI logs",
        stderr: "private builder stderr that must not reach CI logs",
      },
    });
    dependencies.repositoryRoot = root;
    await assert.rejects(
      invokeElectronWindowsSigning({
        candidateReceiptPath: candidatePath,
        captureEncryptedBuilderDiagnostic: true,
      }, dependencies),
      (error) => {
        assert.equal(error.code, "ELECTRON_WINDOWS_SIGNING_BUILDER_SIGNING_FAILED");
        assert.equal(error.encryptedDiagnostic, "written");
        assert.doesNotMatch(error.diagnostic, /private builder/u);
        return true;
      },
    );
    const builderEnvironment = calls.at(-1).environment;
    assert.equal(builderEnvironment[DIAGNOSTIC_PUBLIC_KEY_BASE64_ENV], undefined);
    assert.equal(builderEnvironment[DIAGNOSTIC_PUBLIC_KEY_SHA256_ENV], undefined);
    const envelopePath = join(
      root,
      ".release-build",
      "electron-production",
      "win32-x64",
      "evidence",
      "windows-builder-failure.envelope.json",
    );
    const serialized = await readFile(envelopePath, "utf8");
    assert.doesNotMatch(serialized, /private builder/u);
    assert.doesNotMatch(serialized, /BEGIN PRIVATE KEY/u);
    const envelope = JSON.parse(serialized);
    assert.deepEqual(envelope.binding, {
      buildNumber: BUILD_NUMBER,
      candidateSha256: createHash("sha256").update(bytes).digest("hex"),
      sourceRevision: SOURCE_REVISION,
      target: "win32-x64",
    });
    assert.equal(envelope.publicKeySha256, environment[DIAGNOSTIC_PUBLIC_KEY_SHA256_ENV]);
    const plaintext = decryptDiagnosticEnvelope(envelope, privateKey);
    try {
      assert.match(plaintext.toString("utf8"), /private builder stdout/u);
      assert.match(plaintext.toString("utf8"), /private builder stderr/u);
    } finally {
      plaintext.fill(0);
    }
    assert.throws(
      () => decryptDiagnosticEnvelope({
        ...envelope,
        binding: { ...envelope.binding, candidateSha256: "b".repeat(64) },
      }, privateKey),
    );
    const metadata = await lstat(envelopePath);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.nlink, 1);
  });
});

test("encrypted builder capture reserves bounded diagnostic tails for both output streams", async () => {
  await withFixture(async ({ candidatePath, root }) => {
    const { environment, privateKey } = diagnosticKeyPair();
    const dependencies = testDependencies({
      environment,
      builderResult: {
        error: undefined,
        signal: null,
        status: 1,
        stdout: `${"stdout-noise".repeat(16 * 1024)}\nSTDOUT_TAIL_DIAGNOSTIC`,
        stderr: `${"stderr-noise".repeat(16 * 1024)}\nSTDERR_TAIL_DIAGNOSTIC`,
      },
    });
    dependencies.repositoryRoot = root;
    await assert.rejects(
      invokeElectronWindowsSigning({
        candidateReceiptPath: candidatePath,
        captureEncryptedBuilderDiagnostic: true,
      }, dependencies),
      (error) => error.code === "ELECTRON_WINDOWS_SIGNING_BUILDER_SIGNING_FAILED"
        && error.encryptedDiagnostic === "written",
    );
    const envelope = JSON.parse(await readFile(join(
      root,
      ".release-build",
      "electron-production",
      "win32-x64",
      "evidence",
      "windows-builder-failure.envelope.json",
    ), "utf8"));
    const plaintext = decryptDiagnosticEnvelope(envelope, privateKey);
    try {
      assert.ok(plaintext.byteLength <= 256 * 1024);
      const output = plaintext.toString("utf8");
      assert.match(output, /STDOUT_TAIL_DIAGNOSTIC/u);
      assert.match(output, /STDERR_TAIL_DIAGNOSTIC/u);
      assert.equal((output.match(/\[tibotattle-builder-output-truncated\]/gu) ?? []).length, 2);
    } finally {
      plaintext.fill(0);
    }
  });
});

test("encrypted builder capture rejects a private or mismatched public key before signer commands", async () => {
  await withFixture(async ({ candidatePath, root }) => {
    const { privateKey } = diagnosticKeyPair();
    const privatePem = Buffer.from(privateKey.export({ format: "pem", type: "pkcs8" }), "utf8");
    const calls = [];
    const dependencies = testDependencies({
      calls,
      environment: {
        ...WINDOWS_SIGNING_ENVIRONMENT,
        [DIAGNOSTIC_PUBLIC_KEY_BASE64_ENV]: privatePem.toString("base64"),
        [DIAGNOSTIC_PUBLIC_KEY_SHA256_ENV]: createHash("sha256").update(privatePem).digest("hex"),
      },
    });
    dependencies.repositoryRoot = root;
    await assert.rejects(
      invokeElectronWindowsSigning({
        candidateReceiptPath: candidatePath,
        captureEncryptedBuilderDiagnostic: true,
      }, dependencies),
      { code: "ELECTRON_WINDOWS_SIGNING_ENCRYPTED_BUILDER_DIAGNOSTIC_KEY_INVALID" },
    );
    assert.equal(calls.length, 0);
  });
});

test("encrypted builder capture never overwrites an existing evidence envelope", async () => {
  await withFixture(async ({ candidatePath, root }) => {
    const { environment } = diagnosticKeyPair();
    const evidenceRoot = join(root, ".release-build", "electron-production", "win32-x64", "evidence");
    await mkdir(evidenceRoot, { mode: 0o700 });
    const envelopePath = join(evidenceRoot, "windows-builder-failure.envelope.json");
    const original = Buffer.from("retained-envelope-must-not-change\n", "utf8");
    await writeFile(envelopePath, original, { flag: "wx", mode: 0o600 });
    const dependencies = testDependencies({
      environment,
      builderResult: {
        error: undefined,
        signal: null,
        status: 1,
        stderr: "private builder output",
        stdout: "",
      },
    });
    dependencies.repositoryRoot = root;
    await assert.rejects(
      invokeElectronWindowsSigning({
        candidateReceiptPath: candidatePath,
        captureEncryptedBuilderDiagnostic: true,
      }, dependencies),
      (error) => error.code === "ELECTRON_WINDOWS_SIGNING_BUILDER_SIGNING_FAILED"
        && error.encryptedDiagnostic === "unavailable",
    );
    assert.deepEqual(await readFile(envelopePath), original);
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
  assert.deepEqual(
    parseElectronWindowsSigningArguments([
      "--sign", "--confirm-azure-trusted-signing", "--capture-encrypted-builder-diagnostic",
      "--candidate-receipt", "candidate.json",
    ]),
    {
      candidateReceiptPath: "candidate.json",
      captureEncryptedBuilderDiagnostic: true,
      prepareBuilderHost: false,
      sign: true,
    },
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
