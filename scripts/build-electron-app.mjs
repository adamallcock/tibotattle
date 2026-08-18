#!/usr/bin/env node

/**
 * Stage the unsigned Electron development app source tree.
 *
 * This deliberately stops before electron-builder: the output is a reviewed,
 * directory-only input for the later macOS arm64 or Windows x64 `dir` build.
 * The companion runtime packager owns the exact source/dependency closure and
 * this wrapper opts it into the Electron shell files and shell entrypoint.
 */

import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildElectronRuntime,
} from "./build-electron-runtime.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
export const DEFAULT_ELECTRON_APP_OUTPUT = resolve(
  REPOSITORY_ROOT,
  ".release-build/electron-dev/mac-arm64/app",
);
export const DEFAULT_WINDOWS_ELECTRON_APP_OUTPUT = resolve(
  REPOSITORY_ROOT,
  ".release-build/electron-dev/windows-x64/app",
);
const DARWIN_TARGET = "darwin";
const WINDOWS_TARGET = "win32";
const DEFAULT_WINDOWS_BINDING_PATH = resolve(
  REPOSITORY_ROOT,
  "native/windows-filesystem/build/Release/windows_filesystem.node",
);
const DEFAULT_WINDOWS_MANIFEST_PATH = `${DEFAULT_WINDOWS_BINDING_PATH}.manifest.json`;

function failure(code, message) {
  const error = new Error(message);
  error.code = `ELECTRON_APP_${code}`;
  return error;
}

function fail(code, message) {
  throw failure(code, message);
}

function normalizeTarget(value = DARWIN_TARGET) {
  if (value === "macos" || value === "macOS" || value === DARWIN_TARGET) {
    return DARWIN_TARGET;
  }
  if (value === "windows" || value === "win" || value === WINDOWS_TARGET) {
    return WINDOWS_TARGET;
  }
  fail("UNSUPPORTED_TARGET", "The Electron development app supports macOS arm64 and Windows x64 only");
}

async function requireWindowsInputs({ windowsBindingPath, windowsManifestPath } = {}) {
  const bindingPath = windowsBindingPath ?? DEFAULT_WINDOWS_BINDING_PATH;
  const manifestPath = windowsManifestPath ?? DEFAULT_WINDOWS_MANIFEST_PATH;
  if ((windowsBindingPath && !windowsManifestPath)
      || (!windowsBindingPath && windowsManifestPath)) {
    fail("WINDOWS_INPUT_PAIR", "Windows binding and manifest must be supplied together");
  }
  try {
    await access(bindingPath);
    await access(manifestPath);
  } catch {
    fail(
      "WINDOWS_INPUT_REQUIRED",
      "Windows staging requires the reviewed native binding and matching manifest",
    );
  }
  return Object.freeze({
    windowsBindingPath: bindingPath,
    windowsManifestPath: manifestPath,
  });
}

/**
 * Build the exact app source tree consumed by electron-builder's directory
 * target.  No installer, signing, native rebuild, publish, or version bump is
 * performed here.
 */
export async function buildElectronApp({
  output,
  target = DARWIN_TARGET,
  replace = false,
  windowsBindingPath,
  windowsManifestPath,
} = {}) {
  const selectedTarget = normalizeTarget(target);
  const windowsInputs = selectedTarget === WINDOWS_TARGET
    ? await requireWindowsInputs({ windowsBindingPath, windowsManifestPath })
    : null;
  if (selectedTarget === DARWIN_TARGET && (windowsBindingPath || windowsManifestPath)) {
    fail("WINDOWS_INPUT_TARGET", "Windows binding inputs require the Windows target");
  }
  return buildElectronRuntime({
    output: output ?? (selectedTarget === WINDOWS_TARGET
      ? DEFAULT_WINDOWS_ELECTRON_APP_OUTPUT
      : DEFAULT_ELECTRON_APP_OUTPUT),
    target: selectedTarget,
    replace,
    includeElectronShell: true,
    ...(windowsInputs ?? {}),
  });
}

export function parseElectronAppArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const parsed = {
    output: null,
    target: DARWIN_TARGET,
    replace: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--replace") {
      parsed.replace = true;
      continue;
    }
    if (argument !== "--output" && argument !== "--target" && argument !== "--platform"
        && argument !== "--windows-binding" && argument !== "--windows-manifest") {
      fail("INVALID_ARGUMENT", `Unknown Electron app argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", `Missing value for ${argument}`);
    }
    index += 1;
    if (argument === "--output") parsed.output = value;
    else if (argument === "--target" || argument === "--platform") parsed.target = normalizeTarget(value);
    else if (argument === "--windows-binding") parsed.windowsBindingPath = value;
    else parsed.windowsManifestPath = value;
  }
  if ((parsed.windowsBindingPath && !parsed.windowsManifestPath)
      || (!parsed.windowsBindingPath && parsed.windowsManifestPath)) {
    fail("WINDOWS_INPUT_PAIR", "Windows binding and manifest must be supplied together");
  }
  if (parsed.target !== WINDOWS_TARGET
      && (parsed.windowsBindingPath || parsed.windowsManifestPath)) {
    fail("WINDOWS_INPUT_TARGET", "Windows binding inputs require the Windows target");
  }
  return Object.freeze({
    ...parsed,
    output: parsed.output ?? (parsed.target === WINDOWS_TARGET
      ? DEFAULT_WINDOWS_ELECTRON_APP_OUTPUT
      : DEFAULT_ELECTRON_APP_OUTPUT),
  });
}

async function main(argv) {
  try {
    const result = await buildElectronApp(parseElectronAppArguments(argv));
    process.stdout.write(`${JSON.stringify({
      output: result.output,
      manifest: result.manifestPath,
      target: result.manifest.target,
      architecture: result.manifest.architecture,
      entrypoint: result.manifest.entrypoint,
      files: result.manifest.files.length,
      payloadBytes: result.manifest.payload.bytes,
      windowsBinding: result.manifest.windowsBinding,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  await main(process.argv.slice(2));
}
