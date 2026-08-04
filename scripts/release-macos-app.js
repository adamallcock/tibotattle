#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_MANIFEST } from "../config/release-manifest.js";
import {
  STABLE_RELEASE_CHANNEL,
  resolveReleaseChannel,
} from "../config/release-channels.js";
import { releaseMacOSApp } from "./macos-release-core.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

export function parseArguments(argv) {
  let appPath = null;
  let channel = null;
  let output = null;
  let previousStableManifestPath = null;
  let replace = false;
  let stableBootstrap = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--app" && appPath === null && index + 1 < argv.length) {
      appPath = resolve(argv[++index]);
    } else if (argument === "--channel"
        && channel === null
        && index + 1 < argv.length) {
      channel = argv[++index];
    } else if (argument === "--output"
        && output === null
        && index + 1 < argv.length) {
      output = resolve(argv[++index]);
    } else if (argument === "--previous-stable-manifest"
        && previousStableManifestPath === null
        && index + 1 < argv.length) {
      previousStableManifestPath = resolve(argv[++index]);
    } else if (argument === "--stable-bootstrap" && !stableBootstrap) {
      stableBootstrap = true;
    } else if (argument === "--replace" && !replace) {
      replace = true;
    } else {
      throw new Error(`Unknown or repeated argument: ${argument}`);
    }
  }
  if (!appPath) {
    throw new Error("--app is required");
  }
  if (!channel) {
    throw new Error("--channel is required; choose a named release channel explicitly");
  }
  const releaseChannel = resolveReleaseChannel(channel);
  if (releaseChannel.name !== STABLE_RELEASE_CHANNEL
      && (previousStableManifestPath !== null || stableBootstrap)) {
    throw new Error(
      "Stable continuity options are only valid for the stable channel",
    );
  }
  if (previousStableManifestPath !== null && stableBootstrap) {
    throw new Error(
      "--stable-bootstrap cannot be combined with --previous-stable-manifest",
    );
  }
  const defaultOutput = channel === "stable"
    ? join(
      ".release-build",
      "macos-release",
      RELEASE_MANIFEST.macOS.arm64DmgFileName,
    )
    : join(
      ".release-build",
      "macos-release",
      channel,
      RELEASE_MANIFEST.macOS.arm64DmgFileName,
    );
  return {
    appPath,
    channel,
    output: output ?? resolve(defaultOutput),
    previousStableManifestPath,
    replace,
    stableBootstrap,
  };
}

export async function main(argv) {
  const result = await releaseMacOSApp(parseArguments(argv));
  console.log("TiboTattle macOS release: complete");
  console.log(`Channel: ${result.channel}`);
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
