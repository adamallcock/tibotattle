#!/usr/bin/env node

/**
 * Stage the unsigned Electron development app source tree.
 *
 * This deliberately stops before electron-builder: the output is a reviewed,
 * directory-only input for the later target-specific Electron `dir` build.
 * The companion runtime packager owns the exact source/dependency closure and
 * this wrapper opts it into the Electron shell files and shell entrypoint.
 */

import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildElectronRuntime,
  ELECTRON_TARGETS,
  normalizeElectronTarget,
} from "./build-electron-runtime.mjs";
import {
  ELECTRON_BUILDER_PACKAGE_PROFILES,
} from "./lib/electron-builder-package-json.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const DEFAULT_TARGET = "darwin-arm64";
export const DEFAULT_ELECTRON_APP_OUTPUT = resolve(
  REPOSITORY_ROOT,
  ".release-build/electron-dev/darwin-arm64/app",
);
export const DEFAULT_WINDOWS_ELECTRON_APP_OUTPUT = resolve(
  REPOSITORY_ROOT,
  ".release-build/electron-dev/win32-x64/app",
);
export const ELECTRON_APP_OUTPUTS = Object.freeze(
  Object.fromEntries(Object.keys(ELECTRON_TARGETS).map((target) => [
    target,
    resolve(REPOSITORY_ROOT, ".release-build", "electron-dev", target, "app"),
  ])),
);
const WINDOWS_TARGET = "win32-x64";
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

function normalizePackagingProfile(value) {
  if (value === undefined) return value;
  if (typeof value !== "string"
      || !Object.hasOwn(ELECTRON_BUILDER_PACKAGE_PROFILES, value)) {
    fail("INVALID_PROFILE", "The Electron packaging profile is not supported");
  }
  return value;
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
  target = DEFAULT_TARGET,
  replace = false,
  windowsBindingPath,
  windowsManifestPath,
  packagingProfile,
  packageVersion,
} = {}) {
  const selectedTarget = normalizeElectronTarget(target);
  const selectedPackagingProfile = normalizePackagingProfile(packagingProfile);
  const windowsInputs = selectedTarget === WINDOWS_TARGET
    ? await requireWindowsInputs({ windowsBindingPath, windowsManifestPath })
    : null;
  if (selectedTarget !== WINDOWS_TARGET && (windowsBindingPath || windowsManifestPath)) {
    fail("WINDOWS_INPUT_TARGET", "Windows binding inputs require the Windows target");
  }
  return buildElectronRuntime({
    output: output ?? (selectedTarget === WINDOWS_TARGET
      ? DEFAULT_WINDOWS_ELECTRON_APP_OUTPUT
      : ELECTRON_APP_OUTPUTS[selectedTarget] ?? DEFAULT_ELECTRON_APP_OUTPUT),
    target: selectedTarget,
    replace,
    includeElectronShell: true,
    packagingProfile: selectedPackagingProfile,
    packageVersion,
    ...(windowsInputs ?? {}),
  });
}

export function parseElectronAppArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const parsed = {
    output: null,
    target: DEFAULT_TARGET,
    replace: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--replace") {
      parsed.replace = true;
      continue;
    }
    if (argument !== "--output" && argument !== "--target" && argument !== "--platform"
        && argument !== "--windows-binding" && argument !== "--windows-manifest"
        && argument !== "--profile" && argument !== "--version") {
      fail("INVALID_ARGUMENT", `Unknown Electron app argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", `Missing value for ${argument}`);
    }
    index += 1;
    if (argument === "--output") parsed.output = value;
    else if (argument === "--target" || argument === "--platform") {
      parsed.target = normalizeElectronTarget(value);
    }
    else if (argument === "--windows-binding") parsed.windowsBindingPath = value;
    else if (argument === "--profile") parsed.packagingProfile = normalizePackagingProfile(value);
    else if (argument === "--version") parsed.packageVersion = value;
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
      : ELECTRON_APP_OUTPUTS[parsed.target] ?? DEFAULT_ELECTRON_APP_OUTPUT),
  });
}

async function main(argv) {
  try {
    const parsed = parseElectronAppArguments(argv);
    const result = await buildElectronApp(parsed);
    process.stdout.write(`${JSON.stringify({
      output: result.output,
      manifest: result.manifestPath,
      target: parsed.target,
      platform: result.manifest.target,
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
