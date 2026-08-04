#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_MANIFEST } from "../config/release-manifest.js";
import { releaseMacOSApp } from "./macos-release-core.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

function parseArguments(argv) {
  let appPath = null;
  let output = null;
  let replace = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--app" && appPath === null && index + 1 < argv.length) {
      appPath = resolve(argv[++index]);
    } else if (argument === "--output"
        && output === null
        && index + 1 < argv.length) {
      output = resolve(argv[++index]);
    } else if (argument === "--replace" && !replace) {
      replace = true;
    } else {
      throw new Error(`Unknown or repeated argument: ${argument}`);
    }
  }
  if (!appPath) {
    throw new Error("--app is required");
  }
  return {
    appPath,
    output: output ?? resolve(
      join(
        ".release-build",
        "macos-release",
        RELEASE_MANIFEST.macOS.arm64DmgFileName,
      ),
    ),
    replace,
  };
}

export async function main(argv) {
  const result = await releaseMacOSApp(parseArguments(argv));
  console.log("TiboTattle macOS release: complete");
  console.log(`DMG: ${result.output}`);
  console.log(`Release manifest: ${result.releaseManifest}`);
  console.log(`SHA-256: ${result.sha256}`);
  console.log("Developer ID hardened runtime: verified");
  console.log("Apple notarization and stapling: verified");
  console.log("Clean-profile and Gatekeeper checks: passed");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`release-macos-app: ${error.message}`);
    process.exitCode = 1;
  });
}
