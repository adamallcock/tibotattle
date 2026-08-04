#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_BRAND } from "../config/product-brand.js";
import {
  inspectMacOSApp,
  validateInstalledMacOSApp,
  validateMacOSLoginItemReleaseRehearsal,
} from "./macos-release-core.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REQUIRED_APPLICATION_PATH =
  `/Applications/${PRODUCT_BRAND.bundleName}`;

function parseArguments(argv) {
  let appPath = null;
  let rehearsalPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--app" && appPath === null && index + 1 < argv.length) {
      appPath = resolve(argv[++index]);
    } else if (argument === "--rehearsal"
        && rehearsalPath === null && index + 1 < argv.length) {
      rehearsalPath = resolve(argv[++index]);
    } else {
      throw new Error(`Unknown or repeated argument: ${argument}`);
    }
  }
  if (!appPath || !rehearsalPath) {
    throw new Error("--app and --rehearsal are required");
  }
  if (appPath !== REQUIRED_APPLICATION_PATH) {
    throw new Error(
      `Login Item release rehearsal must use ${REQUIRED_APPLICATION_PATH}`,
    );
  }
  return { appPath, rehearsalPath };
}

export async function main(argv) {
  const { appPath, rehearsalPath } = parseArguments(argv);
  // Production validation includes a compiled fake-manager contract smoke;
  // it never registers or changes this Mac's real Login Item.
  await validateInstalledMacOSApp(appPath, { production: true });
  const inspected = await inspectMacOSApp(appPath, {
    requireExternalDistribution: true,
  });
  let rehearsal;
  try {
    rehearsal = JSON.parse(await readFile(rehearsalPath, "utf8"));
  } catch {
    throw new Error("Login Item release rehearsal receipt is unreadable");
  }
  const receipt = validateMacOSLoginItemReleaseRehearsal(rehearsal, {
    bundleIdentifier: inspected.bundleIdentifier,
    bundleVersion: inspected.bundleVersion,
    shortVersion: inspected.shortVersion,
  });
  console.log("TiboTattle Login Item release gate: passed");
  console.log(`Bundle identifier: ${receipt.bundleIdentifier}`);
  console.log(`Bundle version: ${receipt.bundleVersion}`);
  console.log(`Rehearsal date: ${receipt.recordedOn}`);
  console.log(`Manual lifecycle checks: ${receipt.requiredChecks.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`validate-macos-login-item-release: ${error.message}`);
    process.exitCode = 1;
  });
}
