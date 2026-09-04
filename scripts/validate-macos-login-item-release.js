#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_BRAND } from "../config/product-brand.js";
import {
  resolveReleaseChannel,
  STABLE_RELEASE_CHANNEL,
} from "../config/release-channels.js";
import { normalizeMacOSBuildArchitecture } from "./build-macos-app.js";
import {
  inspectMacOSApp,
  validateInstalledMacOSApp,
  validateMacOSLoginItemReleaseRehearsal,
} from "./macos-release-core.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REQUIRED_APPLICATION_PATH =
  `/Applications/${PRODUCT_BRAND.bundleName}`;

export function parseArguments(argv) {
  let appPath = null;
  let architecture = null;
  let channel = null;
  let rehearsalPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--app" && appPath === null && index + 1 < argv.length) {
      appPath = resolve(argv[++index]);
    } else if (argument === "--architecture"
        && architecture === null && index + 1 < argv.length) {
      architecture = normalizeMacOSBuildArchitecture(argv[++index]);
    } else if (argument === "--channel"
        && channel === null && index + 1 < argv.length) {
      channel = argv[++index];
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
  architecture ??= "arm64";
  const releaseChannel = resolveReleaseChannel(channel ?? STABLE_RELEASE_CHANNEL, {
    architecture,
  });
  return { appPath, architecture, channel: releaseChannel.name, rehearsalPath };
}

export async function main(argv, dependencies = {}) {
  const { appPath, architecture, channel, rehearsalPath } = parseArguments(argv);
  const validateInstalled = dependencies.validateInstalledMacOSApp
    ?? validateInstalledMacOSApp;
  const inspectApp = dependencies.inspectMacOSApp ?? inspectMacOSApp;
  // Production validation includes a compiled fake-manager contract smoke;
  // it never registers or changes this Mac's real Login Item.
  await validateInstalled(appPath, { architecture, channel, production: true });
  const inspected = await inspectApp(appPath, {
    architecture,
    channel,
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
    architecture: inspected.architecture,
    channel: inspected.buildManifest?.release?.channelName,
    sourceCommit: inspected.buildManifest?.release?.source?.commit,
    payloadSha256: inspected.buildManifest?.payload?.payloadSha256,
    minimumMacos: inspected.minimumMacos,
  });
  console.log("TiboTattle Login Item manual receipt validation: passed");
  console.log(`Bundle identifier: ${receipt.bundleIdentifier}`);
  console.log(`Bundle version: ${receipt.bundleVersion}`);
  console.log(`Rehearsal date: ${receipt.recordedOn}`);
  console.log(`Manual lifecycle checks: ${receipt.requiredChecks.length}`);
  console.log("Native hardware and runtime checks are human-attested, not automatic physical proof");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`validate-macos-login-item-release: ${error.message}`);
    process.exitCode = 1;
  });
}
