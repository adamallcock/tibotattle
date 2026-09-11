#!/usr/bin/env node

/**
 * Compile the one-shot macOS native-to-Electron handover bridge from source.
 *
 * This is deliberately a source/contract tool only. It neither signs nor
 * installs the executable, changes a Login Item, reads Keychain material, nor
 * claims that an existing 0.1.17/0.1.18 native artifact already carries it.
 */
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
export const NATIVE_ELECTRON_HANDOVER_HELPER_SOURCE = resolve(
  REPOSITORY_ROOT,
  "apps/macos/Helpers/NativeElectronHandoverHelper.swift",
);
export const NATIVE_ELECTRON_HANDOVER_HELPER_MINIMUM_MACOS = "14.0";
export const NATIVE_ELECTRON_HANDOVER_HELPER_ARCHITECTURES = Object.freeze(["arm64", "x64"]);
export const NATIVE_ELECTRON_HANDOVER_HELPER_SWIFT_ARCHITECTURES = Object.freeze({
  arm64: "arm64",
  x64: "x86_64",
});
const MAXIMUM_TOOL_OUTPUT_BYTES = 64 * 1024;

function fail(code) {
  const error = new Error("Native handover helper build failed");
  error.name = "NativeElectronHandoverHelperBuildError";
  error.code = `native_electron_handover_helper_${code}`;
  throw error;
}

function assertOutput(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || !isAbsolute(path)) {
    fail("invalid_output");
  }
  return resolve(path);
}

function assertArchitecture(architecture) {
  if (!NATIVE_ELECTRON_HANDOVER_HELPER_ARCHITECTURES.includes(architecture)) {
    fail("invalid_architecture");
  }
  return architecture;
}

/** Swift triples use x86_64 while Electron names the Intel target x64. */
export function nativeElectronHandoverHelperSwiftArchitecture(architecture) {
  const selectedArchitecture = assertArchitecture(architecture);
  return NATIVE_ELECTRON_HANDOVER_HELPER_SWIFT_ARCHITECTURES[selectedArchitecture];
}

async function outputMustNotExist(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("output_unavailable");
  }
  fail("output_exists");
}

function toolResult(spawnSync, argumentsList, moduleCache) {
  let result;
  try {
    result = spawnSync("/usr/bin/xcrun", argumentsList, {
      cwd: REPOSITORY_ROOT,
      // Keep Swift/Clang module artifacts beside the caller-selected temporary
      // output. Source qualification must not write a compiler cache into a
      // developer profile.
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "C",
        CLANG_MODULE_CACHE_PATH: moduleCache,
        TMPDIR: moduleCache,
      },
      encoding: "utf8",
      maxBuffer: MAXIMUM_TOOL_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch {
    fail("tool_unavailable");
  }
  if (!result || result.error || result.status !== 0 || result.signal !== null) {
    fail("compile_failed");
  }
}

/** Compile to a caller-selected, previously absent path. Never installs or signs output. */
export async function compileNativeElectronHandoverHelper({
  output,
  architecture = process.arch,
  platform = process.platform,
  spawnSync = nodeSpawnSync,
} = {}) {
  if (platform !== "darwin") fail("unsupported_platform");
  if (typeof spawnSync !== "function") fail("invalid_spawn");
  const selectedOutput = assertOutput(output);
  const selectedArchitecture = assertArchitecture(architecture);
  const swiftArchitecture = nativeElectronHandoverHelperSwiftArchitecture(selectedArchitecture);
  await outputMustNotExist(selectedOutput);
  try {
    await mkdir(dirname(selectedOutput), { recursive: true, mode: 0o700 });
  } catch {
    fail("output_unavailable");
  }
  let moduleCache;
  try {
    moduleCache = await mkdtemp(join(dirname(selectedOutput), ".native-electron-handover-cache-"));
    toolResult(spawnSync, [
      "--sdk",
      "macosx",
      "swiftc",
      NATIVE_ELECTRON_HANDOVER_HELPER_SOURCE,
      "-parse-as-library",
      "-target",
      `${swiftArchitecture}-apple-macos${NATIVE_ELECTRON_HANDOVER_HELPER_MINIMUM_MACOS}`,
      "-framework",
      "AppKit",
      "-framework",
      "ServiceManagement",
      "-o",
      selectedOutput,
    ], moduleCache);
  } finally {
    if (moduleCache !== undefined) {
      try { await rm(moduleCache, { recursive: true, force: true, maxRetries: 0 }); } catch { /* bounded cache cleanup */ }
    }
  }
  try {
    const metadata = await lstat(selectedOutput);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1) {
      fail("compile_failed");
    }
  } catch (error) {
    if (error?.code?.startsWith("native_electron_handover_helper_")) throw error;
    fail("compile_failed");
  }
  return selectedOutput;
}

/** Run only the helper's no-side-effect contract smoke. */
export function runNativeElectronHandoverHelperContractSmoke({
  executable,
  spawnSync = nodeSpawnSync,
} = {}) {
  const selectedExecutable = assertOutput(executable);
  if (typeof spawnSync !== "function") fail("invalid_spawn");
  let result;
  try {
    result = spawnSync(selectedExecutable, ["--contract-smoke-test"], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      encoding: "utf8",
      maxBuffer: 8 * 1024,
      windowsHide: true,
    });
  } catch {
    fail("smoke_failed");
  }
  if (!result || result.error || result.status !== 0 || result.signal !== null) fail("smoke_failed");
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    fail("smoke_failed");
  }
  if (response?.schemaVersion !== "tibotattle-native-electron-handover-bridge-v1"
      || response?.status !== "contract_ok") {
    fail("smoke_failed");
  }
  return Object.freeze({ status: "contract_ok" });
}

function parseArguments(argumentsList) {
  const result = { output: null, architecture: process.arch, contractSmoke: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--output") {
      result.output = argumentsList[index + 1] ?? null;
      index += 1;
    } else if (argument === "--architecture") {
      result.architecture = argumentsList[index + 1] ?? "";
      index += 1;
    } else if (argument === "--contract-smoke") {
      result.contractSmoke = true;
    } else {
      fail("invalid_arguments");
    }
  }
  if (result.output === null) fail("invalid_output");
  return result;
}

async function main() {
  try {
    const selected = parseArguments(process.argv.slice(2));
    const output = await compileNativeElectronHandoverHelper({
      output: selected.output,
      architecture: selected.architecture,
    });
    if (selected.contractSmoke) runNativeElectronHandoverHelperContractSmoke({ executable: output });
    process.stdout.write("Native handover helper source compiled.\n");
  } catch (error) {
    process.stderr.write("Native handover helper source compilation failed.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] === SCRIPT_PATH) await main();
