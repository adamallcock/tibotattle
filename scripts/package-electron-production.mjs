#!/usr/bin/env node

/**
 * Prepare one reviewable production Electron source candidate.
 *
 * This entrypoint stages the exact app and updater dependency closure only.
 * It intentionally never invokes electron-builder, signing, notarization, or
 * publishing. The returned plan names the later builder invocation, whose
 * config requires the same source revision and explicit build number.
 */

import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildElectronApp,
} from "./build-electron-app.mjs";
import {
  ELECTRON_TARGETS,
} from "./build-electron-runtime.mjs";
import {
  compileNativeElectronHandoverHelper,
  runNativeElectronHandoverHelperContractSmoke,
} from "./build-electron-native-handover-helper.mjs";
import {
  compileMacOSKeychainAdapter,
} from "./build-electron-macos-keychain-adapter.mjs";
import {
  createProductionDistributionMetadata,
  validateProductionDistributionMetadata,
  PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN,
  PRODUCTION_ELECTRON_TARGETS,
} from "../apps/electron/desktop-updater.js";
import distribution from "../config/electron-production-distribution.cjs";
import { RELEASE_VERSION } from "../config/release-manifest.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const SHA = /^[0-9a-f]{40}$/u;
const SCHEMA_VERSION = "tibotattle-electron-production-source-candidate-v1";
const TARGETS = Object.freeze(Object.keys(PRODUCTION_ELECTRON_TARGETS));
const PLATFORM_FLAGS = Object.freeze({ darwin: "--mac", win32: "--win", linux: "--linux" });
const DISTRIBUTION_TARGETS = Object.freeze({
  darwin: Object.freeze(["dmg", "zip"]),
  win32: Object.freeze(["nsis"]),
  linux: Object.freeze(["AppImage"]),
});
const NATIVE_HANDOVER_HELPER_PACKAGED_PATH = Object.freeze([
  "Contents",
  "MacOS",
  distribution.PRODUCTION_ELECTRON_NATIVE_HANDOVER_HELPER_RESOURCE_RELATIVE_PATH.at(-1),
].join("/"));
const NATIVE_MACOS_KEYCHAIN_ADAPTER_PACKAGED_PATH = Object.freeze([
  "Contents",
  "Resources",
  ...distribution.PRODUCTION_ELECTRON_MACOS_KEYCHAIN_ADAPTER_RESOURCE_RELATIVE_PATH,
].join("/"));
const MAXIMUM_MACOS_KEYCHAIN_ADAPTER_BYTES = 5 * 1024 * 1024;
const MACH_O_64_MAGIC = 0xfeedfacf;
const MACH_O_CPU_TYPES = Object.freeze({
  arm64: 0x0100000c,
  x64: 0x01000007,
});

function failure(code) {
  const error = new Error(`ELECTRON_PRODUCTION_${code}`);
  error.code = error.message;
  return error;
}

function fail(code) {
  throw failure(code);
}

function validSourceRevision(value) {
  return typeof value === "string" && SHA.test(value);
}

function validBuildNumber(value) {
  return typeof value === "string" && PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN.test(value);
}

function requireArgumentValue(argv, index) {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")
      || value.includes("\0")) {
    fail("ARGUMENT_INVALID");
  }
  return value;
}

export function parseProductionCandidateArguments(argv) {
  if (!Array.isArray(argv)) fail("ARGUMENT_INVALID");
  const result = { replaceStaging: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) fail("DUPLICATE_ARGUMENT");
    seen.add(flag);
    if (flag === "--replace-staging") {
      result.replaceStaging = true;
      continue;
    }
    const property = {
      "--target": "target",
      "--source-revision": "sourceRevision",
      "--build-number": "buildNumber",
      "--windows-binding": "windowsBindingPath",
      "--windows-manifest": "windowsManifestPath",
    }[flag];
    if (!property) fail("ARGUMENT_INVALID");
    result[property] = requireArgumentValue(argv, index);
    index += 1;
  }
  if (!TARGETS.includes(result.target)
      || !validSourceRevision(result.sourceRevision)
      || !validBuildNumber(result.buildNumber)
      || Boolean(result.windowsBindingPath) !== Boolean(result.windowsManifestPath)
      || (result.target !== "win32-x64" && result.windowsBindingPath)) {
    fail("ARGUMENT_INVALID");
  }
  return Object.freeze(result);
}

/**
 * Make a source-only plan without inspecting the checkout or invoking a
 * builder. This keeps workflow and unit checks safe to run before a real
 * candidate number or signing environment has been allocated.
 */
export function productionElectronCandidatePlan({
  target,
  sourceRevision,
  buildNumber,
  hostPlatform = process.platform,
  hostArchitecture = process.arch,
} = {}) {
  const targetSpec = PRODUCTION_ELECTRON_TARGETS[target];
  const runtimeTarget = ELECTRON_TARGETS[target];
  if (!targetSpec || !runtimeTarget
      || targetSpec.platform !== runtimeTarget.platform
      || targetSpec.architecture !== runtimeTarget.architecture
      || !validSourceRevision(sourceRevision)
      || !validBuildNumber(buildNumber)) {
    fail("PLAN_INVALID");
  }
  const metadata = createProductionDistributionMetadata({ buildNumber, sourceRevision, target });
  const stagingRoot = `.release-build/electron-production/${target}`;
  const nativeHandoverHelper = targetSpec.platform === "darwin"
    ? Object.freeze({
      architecture: targetSpec.architecture,
      packagedPath: NATIVE_HANDOVER_HELPER_PACKAGED_PATH,
      sourcePath: `${stagingRoot}/${distribution
        .PRODUCTION_ELECTRON_NATIVE_HANDOVER_HELPER_RESOURCE_RELATIVE_PATH.join("/")}`,
      signed: false,
    })
    : null;
  const nativeMacOSKeychainAdapter = targetSpec.platform === "darwin"
    ? Object.freeze({
      architecture: targetSpec.architecture,
      packagedPath: NATIVE_MACOS_KEYCHAIN_ADAPTER_PACKAGED_PATH,
      sourcePath: `${stagingRoot}/${distribution
        .PRODUCTION_ELECTRON_MACOS_KEYCHAIN_ADAPTER_RESOURCE_RELATIVE_PATH.join("/")}`,
      signed: false,
    })
    : null;
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    buildNumber,
    sourceRevision,
    version: RELEASE_VERSION,
    target,
    updateFeed: metadata.updateFeed,
    host: Object.freeze({ platform: hostPlatform, architecture: hostArchitecture }),
    stagingDirectory: `${stagingRoot}/app`,
    artifactDirectory: `${stagingRoot}/artifacts`,
    builderConfiguration: "apps/electron/electron-builder.production.config.cjs",
    builderArguments: Object.freeze([
      PLATFORM_FLAGS[targetSpec.platform],
      ...DISTRIBUTION_TARGETS[targetSpec.platform],
      `--${targetSpec.architecture}`,
      "--publish",
      "never",
    ]),
    updaterEnabled: true,
    signingRequired: targetSpec.platform !== "linux",
    signingPerformed: false,
    publishingPerformed: false,
    nativeHandoverHelper,
    nativeMacOSKeychainAdapter,
    // The current Windows runtime still requires a separate qualification
    // context. Source staging does not turn this into a launch claim.
    windowsRuntimeQualification: target === "win32-x64" ? "required" : "not_applicable",
  });
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    let output = "";
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const capture = (chunk) => {
      output += chunk;
      if (output.length > 64 * 1024) child.kill();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", () => reject(failure("SOURCE_COMMAND_UNAVAILABLE")));
    child.once("exit", (code) => {
      if (code !== 0 || output.length > 64 * 1024) {
        reject(failure("SOURCE_COMMAND_FAILED"));
        return;
      }
      resolveRun(output.trim());
    });
  });
}

async function cleanSourceRevision() {
  const sourceRevision = await run("git", ["rev-parse", "HEAD"]);
  if (!validSourceRevision(sourceRevision)) fail("SOURCE_INVALID");
  if ((await run("git", ["status", "--porcelain", "--untracked-files=normal"])) !== "") {
    fail("SOURCE_DIRTY");
  }
  return sourceRevision;
}

function targetOutput(plan) {
  return resolve(REPOSITORY_ROOT, plan.stagingDirectory);
}

function helperOutput(plan) {
  const helper = plan.nativeHandoverHelper;
  if (helper === null) return null;
  const selected = resolve(REPOSITORY_ROOT, helper.sourcePath);
  const stagingRoot = resolve(REPOSITORY_ROOT, dirname(plan.stagingDirectory));
  if (!selected.startsWith(`${stagingRoot}${sep}`)) fail("NATIVE_HANDOVER_HELPER_PATH");
  return selected;
}

function macOSKeychainAdapterOutput(plan) {
  const adapter = plan.nativeMacOSKeychainAdapter;
  if (adapter === null) return null;
  const selected = resolve(REPOSITORY_ROOT, adapter.sourcePath);
  const stagingRoot = resolve(REPOSITORY_ROOT, dirname(plan.stagingDirectory));
  if (!selected.startsWith(`${stagingRoot}${sep}`)) {
    fail("NATIVE_MACOS_KEYCHAIN_ADAPTER_PATH");
  }
  return selected;
}

async function assertNoSymbolicLinkPathComponents(
  path,
  pathFailureCode = "NATIVE_HANDOVER_HELPER_PATH",
) {
  const selected = resolve(path);
  const relativePath = relative(REPOSITORY_ROOT, selected);
  if (relativePath === "" || isAbsolute(relativePath)
      || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    fail(pathFailureCode);
  }
  let current = REPOSITORY_ROOT;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        fail(pathFailureCode);
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (error?.code?.startsWith("ELECTRON_PRODUCTION_")) throw error;
      fail(pathFailureCode);
    }
  }
}

async function removePreviousRegularFile(path, { replace, existsCode, unsafeCode }) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail(unsafeCode);
  }
  if (!replace) fail(existsCode);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) fail(unsafeCode);
  try {
    await unlink(path);
  } catch {
    fail(unsafeCode);
  }
}

async function prepareNativeHandoverHelper({ plan, replaceStaging }) {
  const helper = plan.nativeHandoverHelper;
  if (helper === null) return null;
  const output = helperOutput(plan);
  const outputDirectory = dirname(output);
  await assertNoSymbolicLinkPathComponents(outputDirectory);
  try {
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  } catch {
    fail("NATIVE_HANDOVER_HELPER_PATH");
  }
  await assertNoSymbolicLinkPathComponents(outputDirectory);
  await removePreviousRegularFile(output, {
    replace: replaceStaging,
    existsCode: "NATIVE_HANDOVER_HELPER_EXISTS",
    unsafeCode: "NATIVE_HANDOVER_HELPER_UNSAFE",
  });
  try {
    await compileNativeElectronHandoverHelper({
      output,
      architecture: helper.architecture,
    });
    const smoke = runNativeElectronHandoverHelperContractSmoke({ executable: output });
    if (smoke.status !== "contract_ok") fail("NATIVE_HANDOVER_HELPER_COMPILE");
    const metadata = await lstat(output);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || metadata.size < 1 || (metadata.mode & 0o111) === 0) {
      fail("NATIVE_HANDOVER_HELPER_COMPILE");
    }
  } catch (error) {
    if (error?.code?.startsWith("ELECTRON_PRODUCTION_")) throw error;
    fail("NATIVE_HANDOVER_HELPER_COMPILE");
  }
  return Object.freeze({
    architecture: helper.architecture,
    packagedPath: helper.packagedPath,
    signed: false,
    sourcePath: helper.sourcePath,
    status: "contract_ok",
  });
}

async function prepareNativeMacOSKeychainAdapter({ plan, replaceStaging }) {
  const adapter = plan.nativeMacOSKeychainAdapter;
  if (adapter === null) return null;
  const output = macOSKeychainAdapterOutput(plan);
  const outputDirectory = dirname(output);
  await assertNoSymbolicLinkPathComponents(
    outputDirectory,
    "NATIVE_MACOS_KEYCHAIN_ADAPTER_PATH",
  );
  try {
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  } catch {
    fail("NATIVE_MACOS_KEYCHAIN_ADAPTER_PATH");
  }
  await assertNoSymbolicLinkPathComponents(
    outputDirectory,
    "NATIVE_MACOS_KEYCHAIN_ADAPTER_PATH",
  );
  await removePreviousRegularFile(output, {
    replace: replaceStaging,
    existsCode: "NATIVE_MACOS_KEYCHAIN_ADAPTER_EXISTS",
    unsafeCode: "NATIVE_MACOS_KEYCHAIN_ADAPTER_UNSAFE",
  });
  try {
    await compileMacOSKeychainAdapter({
      output,
      architecture: adapter.architecture,
    });
    const metadata = await lstat(output);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || metadata.size < 8 || metadata.size > MAXIMUM_MACOS_KEYCHAIN_ADAPTER_BYTES
        || (metadata.mode & 0o022) !== 0) {
      fail("NATIVE_MACOS_KEYCHAIN_ADAPTER_COMPILE");
    }
    const bytes = await readFile(output);
    if (bytes.length !== metadata.size
        || bytes.readUInt32LE(0) !== MACH_O_64_MAGIC
        || bytes.readUInt32LE(4) !== MACH_O_CPU_TYPES[adapter.architecture]) {
      fail("NATIVE_MACOS_KEYCHAIN_ADAPTER_COMPILE");
    }
  } catch (error) {
    if (error?.code?.startsWith("ELECTRON_PRODUCTION_")) throw error;
    fail("NATIVE_MACOS_KEYCHAIN_ADAPTER_COMPILE");
  }
  return Object.freeze({
    architecture: adapter.architecture,
    packagedPath: adapter.packagedPath,
    signed: false,
    sourcePath: adapter.sourcePath,
    status: "source_compiled_unsigned",
  });
}

/**
 * Stage the app whose package.json carries the exact source, target, feed and
 * build number. No installer is built here; the config named in the receipt
 * is the later explicit signing/finalization boundary.
 */
export async function prepareProductionElectronCandidate(options = {}) {
  if (process.version !== "v26.2.0") fail("NODE_VERSION_REQUIRED");
  const plan = productionElectronCandidatePlan(options);
  const actualRevision = await cleanSourceRevision();
  if (actualRevision !== plan.sourceRevision) fail("SOURCE_REVISION_MISMATCH");
  const targetSpec = PRODUCTION_ELECTRON_TARGETS[plan.target];
  const metadata = createProductionDistributionMetadata({
    buildNumber: plan.buildNumber,
    sourceRevision: plan.sourceRevision,
    target: plan.target,
  });
  const staged = await buildElectronApp({
    output: targetOutput(plan),
    target: plan.target,
    replace: options.replaceStaging === true,
    packagingProfile: "production",
    distributionMetadata: metadata,
    ...(plan.target === "win32-x64" ? {
      windowsBindingPath: options.windowsBindingPath,
      windowsManifestPath: options.windowsManifestPath,
    } : {}),
  });
  const nativeHandoverHelper = await prepareNativeHandoverHelper({
    plan,
    replaceStaging: options.replaceStaging === true,
  });
  const nativeMacOSKeychainAdapter = await prepareNativeMacOSKeychainAdapter({
    plan,
    replaceStaging: options.replaceStaging === true,
  });
  let stagedManifest;
  try {
    stagedManifest = JSON.parse(await readFile(join(staged.output, "package.json"), "utf8"));
  } catch {
    fail("STAGED_MANIFEST_INVALID");
  }
  let stagedMetadata;
  try {
    stagedMetadata = validateProductionDistributionMetadata(stagedManifest.tibotattleDistribution, {
      platform: targetSpec.platform,
      architecture: targetSpec.architecture,
    });
  } catch {
    fail("STAGED_MANIFEST_INVALID");
  }
  if (JSON.stringify(stagedMetadata) !== JSON.stringify(metadata)) fail("STAGED_MANIFEST_INVALID");
  if (await cleanSourceRevision() !== plan.sourceRevision) fail("SOURCE_CHANGED");
  const receipt = Object.freeze({
    ...plan,
    ...(nativeHandoverHelper === null ? {} : { nativeHandoverHelper }),
    ...(nativeMacOSKeychainAdapter === null ? {} : { nativeMacOSKeychainAdapter }),
    status: "production_source_staged",
    stagedManifest: "app/package.json",
    runtimeManifest: "app/electron-runtime-manifest.json",
  });
  const receiptPath = join(dirname(staged.output), "production-source-candidate.json");
  await removePreviousRegularFile(receiptPath, {
    replace: options.replaceStaging === true,
    existsCode: "RECEIPT_EXISTS",
    unsafeCode: "RECEIPT_UNSAFE",
  });
  await writeFile(
    receiptPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return receipt;
}

if (resolve(process.argv[1] ?? "") === SCRIPT_FILE) {
  try {
    const options = parseProductionCandidateArguments(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await prepareProductionElectronCandidate(options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${/^ELECTRON_PRODUCTION_[A-Z_]+$/u.test(error?.code ?? "")
      ? error.code
      : "ELECTRON_PRODUCTION_FAILED"}\n`);
    process.exitCode = 1;
  }
}
