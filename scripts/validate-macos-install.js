#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_MANIFEST } from "../config/release-manifest.js";
import {
  validateInstalledMacOSApp,
  validateMacOSDMG,
} from "./macos-release-core.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

function parseArguments(argv) {
  let appPath = null;
  let dmgPath = null;
  let development = false;
  let release = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--app" && appPath === null && index + 1 < argv.length) {
      appPath = resolve(argv[++index]);
    } else if (argument === "--dmg"
        && dmgPath === null
        && index + 1 < argv.length) {
      dmgPath = resolve(argv[++index]);
    } else if (argument === "--development" && !development) {
      development = true;
    } else if (argument === "--release" && !release) {
      release = true;
    } else {
      throw new Error(`Unknown or repeated argument: ${argument}`);
    }
  }
  if (release && (appPath !== null || dmgPath !== null || development)) {
    throw new Error("--release cannot be combined with an explicit target or --development");
  }
  if (release) {
    return {
      appPath: null,
      dmgPath: resolve(
        join(
          ".release-build",
          "macos-release",
          RELEASE_MANIFEST.macOS.arm64DmgFileName,
        ),
      ),
      production: true,
    };
  }
  if ((appPath === null) === (dmgPath === null)) {
    throw new Error("Provide exactly one of --app or --dmg");
  }
  return { appPath, dmgPath, production: !development };
}

export async function main(argv) {
  const options = parseArguments(argv);
  const result = options.appPath
    ? await validateInstalledMacOSApp(options.appPath, {
      production: options.production,
    })
    : await validateMacOSDMG(options.dmgPath, {
      production: options.production,
    });
  console.log("TiboTattle clean-install validation: passed");
  console.log(`Bundle identifier: ${result.bundleIdentifier}`);
  console.log(`Version: ${result.shortVersion}`);
  console.log(`Production assurances required: ${result.production}`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`validate-macos-install: ${error.message}`);
    process.exitCode = 1;
  });
}
