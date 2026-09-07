#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_MANIFEST } from "../config/release-manifest.js";
import { normalizeMacOSBuildArchitecture } from "./build-macos-app.js";
import {
  STABLE_RELEASE_CHANNEL,
  resolveReleaseChannel,
} from "../config/release-channels.js";
import {
  prepareMacOSReleaseCandidate,
  releaseMacOSApp,
} from "./macos-release-core.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

export function parseArguments(argv) {
  let appPath = null;
  let architecture = null;
  let nodeRuntime = null;
  let channel = null;
  let output = null;
  let previousStableManifestPath = null;
  let prepareCandidate = false;
  let replace = false;
  let stableBootstrap = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--app" && appPath === null && index + 1 < argv.length) {
      appPath = resolve(argv[++index]);
    } else if (argument === "--architecture" && architecture === null && index + 1 < argv.length) {
      architecture = normalizeMacOSBuildArchitecture(argv[++index]);
    } else if (argument === "--node-runtime" && nodeRuntime === null && index + 1 < argv.length) {
      const selected = argv[++index];
      if (!selected || selected.startsWith("--") || selected.includes("\0")) {
        throw new Error("--node-runtime requires a file path");
      }
      nodeRuntime = resolve(selected);
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
    } else if (argument === "--prepare-candidate" && !prepareCandidate) {
      prepareCandidate = true;
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
  architecture ??= "arm64";
  if ((architecture === "x64") !== (nodeRuntime !== null)) {
    throw new Error("Intel releases require --node-runtime; ARM releases use the pinned builder runtime");
  }
  const releaseChannel = resolveReleaseChannel(channel, { architecture });
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
      architecture === "x64" ? RELEASE_MANIFEST.macOS.x64DmgFileName : RELEASE_MANIFEST.macOS.arm64DmgFileName,
    )
    : join(
      ".release-build",
      "macos-release",
      channel,
      architecture === "x64" ? RELEASE_MANIFEST.macOS.x64DmgFileName : RELEASE_MANIFEST.macOS.arm64DmgFileName,
    );
  return {
    appPath,
    architecture,
    nodeRuntime,
    channel,
    output: output ?? resolve(defaultOutput),
    previousStableManifestPath,
    prepareCandidate,
    replace,
    stableBootstrap,
  };
}

export async function main(argv) {
  const options = parseArguments(argv);
  if (options.prepareCandidate) {
    await prepareMacOSReleaseCandidate({
      architecture: options.architecture,
      nodeRuntime: options.nodeRuntime,
      channel: options.channel,
      output: options.appPath,
      previousStableManifestPath: options.previousStableManifestPath,
      stableBootstrap: options.stableBootstrap,
    });
    console.log(`Review candidate: ${options.appPath}`);
  }
  const result = await releaseMacOSApp(options);
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
