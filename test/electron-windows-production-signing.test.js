import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  invokeElectronWindowsSigning,
  parseElectronWindowsSigningArguments,
  preflightElectronWindowsSigning,
} from "../scripts/finalize-electron-windows-signing.mjs";
import { productionElectronCandidatePlan } from "../scripts/package-electron-production.mjs";

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
  azureCliResult = null } = {}) {
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

test("Windows signing refuses ambiguous invocation and unavailable prerequisites before a signer runs", async () => {
  assert.deepEqual(
    parseElectronWindowsSigningArguments([
      "--candidate-receipt", "candidate.json",
    ]),
    { candidateReceiptPath: "candidate.json", sign: false },
  );
  assert.deepEqual(
    parseElectronWindowsSigningArguments([
      "--sign", "--confirm-azure-trusted-signing", "--candidate-receipt", "candidate.json",
    ]),
    { candidateReceiptPath: "candidate.json", sign: true },
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
