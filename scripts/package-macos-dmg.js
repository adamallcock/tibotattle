#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageMacOSDMG } from "./macos-release-core.js";

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
  if (!appPath || !output) {
    throw new Error("--app and --output are required");
  }
  return { appPath, output, replace };
}

export async function main(argv) {
  const result = await packageMacOSDMG(parseArguments(argv));
  console.log("Usage Monitor DMG: built");
  console.log(`Output: ${result.output}`);
  console.log(`SHA-256: ${result.sha256}`);
  console.log(`Bytes: ${result.bytes}`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`package-macos-dmg: ${error.message}`);
    process.exitCode = 1;
  });
}
