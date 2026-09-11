#!/usr/bin/env node

/**
 * Compile the closed macOS Keychain N-API adapter from source.
 *
 * This is source qualification only. It neither signs, packages, installs,
 * loads, nor asks the Keychain for data. A signed Electron candidate remains a
 * separate production qualification gate.
 */
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const MAXIMUM_TOOL_OUTPUT_BYTES = 64 * 1024;

export const MACOS_KEYCHAIN_ADAPTER_SOURCE = resolve(
  REPOSITORY_ROOT,
  "native/macos-keychain/macos-keychain.mm",
);
export const MACOS_KEYCHAIN_ADAPTER_MINIMUM_MACOS = "14.0";
export const MACOS_KEYCHAIN_ADAPTER_ARCHITECTURES = Object.freeze(["arm64", "x64"]);
export const MACOS_KEYCHAIN_ADAPTER_CLANG_ARCHITECTURES = Object.freeze({
  arm64: "arm64",
  x64: "x86_64",
});
export const MACOS_KEYCHAIN_ADAPTER_NODE_INCLUDE = resolve(
  dirname(process.execPath),
  "..",
  "include",
  "node",
);

function fail(code) {
  const error = new Error("macOS Keychain adapter build failed");
  error.name = "MacOSKeychainAdapterBuildError";
  error.code = `macos_keychain_adapter_${code}`;
  throw error;
}

function assertOutput(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || !isAbsolute(path)) {
    fail("invalid_output");
  }
  return resolve(path);
}

function assertArchitecture(architecture) {
  if (!MACOS_KEYCHAIN_ADAPTER_ARCHITECTURES.includes(architecture)) {
    fail("invalid_architecture");
  }
  return architecture;
}

function assertNodeIncludeDirectory(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || !isAbsolute(path)) {
    fail("invalid_node_headers");
  }
  return resolve(path);
}

export function macOSKeychainAdapterClangArchitecture(architecture) {
  return MACOS_KEYCHAIN_ADAPTER_CLANG_ARCHITECTURES[assertArchitecture(architecture)];
}

/** The exact compiler arguments are exported for source-only contract tests. */
export function macOSKeychainAdapterCompilerArguments({
  output,
  architecture,
  nodeIncludeDirectory = MACOS_KEYCHAIN_ADAPTER_NODE_INCLUDE,
} = {}) {
  const selectedOutput = assertOutput(output);
  const selectedArchitecture = assertArchitecture(architecture);
  const selectedNodeIncludeDirectory = assertNodeIncludeDirectory(nodeIncludeDirectory);
  return Object.freeze([
    "--sdk",
    "macosx",
    "clang++",
    "-std=c++17",
    "-x",
    "objective-c++",
    "-arch",
    macOSKeychainAdapterClangArchitecture(selectedArchitecture),
    `-mmacosx-version-min=${MACOS_KEYCHAIN_ADAPTER_MINIMUM_MACOS}`,
    "-fobjc-arc",
    "-Wno-deprecated-declarations",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-I",
    selectedNodeIncludeDirectory,
    MACOS_KEYCHAIN_ADAPTER_SOURCE,
    "-framework",
    "Security",
    "-framework",
    "CoreFoundation",
    "-o",
    selectedOutput,
  ]);
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

/** Compile to a caller-selected, previously absent path. Never signs or installs output. */
export async function compileMacOSKeychainAdapter({
  output,
  architecture = process.arch,
  platform = process.platform,
  nodeIncludeDirectory = MACOS_KEYCHAIN_ADAPTER_NODE_INCLUDE,
  spawnSync = nodeSpawnSync,
} = {}) {
  if (platform !== "darwin") fail("unsupported_platform");
  if (typeof spawnSync !== "function") fail("invalid_spawn");
  const selectedOutput = assertOutput(output);
  const selectedArchitecture = assertArchitecture(architecture);
  const selectedNodeIncludeDirectory = assertNodeIncludeDirectory(nodeIncludeDirectory);
  await outputMustNotExist(selectedOutput);
  try {
    await mkdir(dirname(selectedOutput), { recursive: true, mode: 0o700 });
  } catch {
    fail("output_unavailable");
  }

  let moduleCache;
  try {
    moduleCache = await mkdtemp(join(dirname(selectedOutput), ".macos-keychain-cache-"));
    toolResult(
      spawnSync,
      macOSKeychainAdapterCompilerArguments({
        output: selectedOutput,
        architecture: selectedArchitecture,
        nodeIncludeDirectory: selectedNodeIncludeDirectory,
      }),
      moduleCache,
    );
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
    if (error?.code?.startsWith("macos_keychain_adapter_")) throw error;
    fail("compile_failed");
  }
  return selectedOutput;
}

function parseArguments(argumentsList) {
  const result = { output: null, architecture: process.arch };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--output") {
      result.output = argumentsList[index + 1] ?? null;
      index += 1;
    } else if (argument === "--architecture") {
      result.architecture = argumentsList[index + 1] ?? "";
      index += 1;
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
    await compileMacOSKeychainAdapter({
      output: selected.output,
      architecture: selected.architecture,
    });
    process.stdout.write("macOS Keychain adapter source compiled.\n");
  } catch {
    process.stderr.write("macOS Keychain adapter source compilation failed.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] === SCRIPT_PATH) await main();
