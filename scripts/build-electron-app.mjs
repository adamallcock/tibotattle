#!/usr/bin/env node

/**
 * Stage the unsigned Electron development app source tree.
 *
 * This deliberately stops before electron-builder: the output is a reviewed,
 * directory-only input for the later macOS arm64 `dir` build.  The companion
 * runtime packager owns the exact source/dependency closure and this wrapper
 * opts it into the Electron shell files and shell entrypoint.
 */

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
const DARWIN_TARGET = "darwin";

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
  fail("UNSUPPORTED_TARGET", "The Electron development app currently stages macOS arm64 only");
}

/**
 * Build the exact app source tree consumed by electron-builder's directory
 * target.  No installer, signing, native rebuild, publish, or version bump is
 * performed here.
 */
export async function buildElectronApp({
  output = DEFAULT_ELECTRON_APP_OUTPUT,
  target = DARWIN_TARGET,
  replace = false,
} = {}) {
  const selectedTarget = normalizeTarget(target);
  return buildElectronRuntime({
    output,
    target: selectedTarget,
    replace,
    includeElectronShell: true,
  });
}

export function parseElectronAppArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const parsed = {
    output: DEFAULT_ELECTRON_APP_OUTPUT,
    target: DARWIN_TARGET,
    replace: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--replace") {
      parsed.replace = true;
      continue;
    }
    if (argument !== "--output" && argument !== "--target" && argument !== "--platform") {
      fail("INVALID_ARGUMENT", `Unknown Electron app argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", `Missing value for ${argument}`);
    }
    index += 1;
    if (argument === "--output") parsed.output = value;
    else parsed.target = normalizeTarget(value);
  }
  return Object.freeze(parsed);
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
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  await main(process.argv.slice(2));
}
