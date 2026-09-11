#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_MANIFEST } from "../config/release-manifest.js";
import { resolveReleaseChannel } from "../config/release-channels.js";
import {
  MACOS_PREVIEW_DISTRIBUTION_CHANNEL,
  normalizeMacOSBuildArchitecture,
  validateMacOSPreviewApp,
} from "./build-macos-app.js";
import {
  validateInstalledMacOSApp,
  validateMacOSDMG,
} from "./macos-release-core.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

export function parseArguments(argv) {
  let appPath = null;
  let architecture = null;
  let dmgPath = null;
  let channel = null;
  let development = false;
  let preview = false;
  let release = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--app" && appPath === null && index + 1 < argv.length) {
      appPath = resolve(argv[++index]);
    } else if (argument === "--architecture" && architecture === null && index + 1 < argv.length) {
      architecture = normalizeMacOSBuildArchitecture(argv[++index]);
    } else if (argument === "--dmg"
        && dmgPath === null
        && index + 1 < argv.length) {
      dmgPath = resolve(argv[++index]);
    } else if (argument === "--channel") {
      if (channel !== null || index + 1 >= argv.length) {
        throw new Error("--channel must be provided at most once with a value");
      }
      channel = argv[++index];
    } else if (argument === "--development" && !development) {
      development = true;
    } else if (argument === "--preview" && !preview) {
      preview = true;
    } else if (argument === "--release" && !release) {
      release = true;
    } else {
      throw new Error(`Unknown or repeated argument: ${argument}`);
    }
  }
  if (release && (appPath !== null || dmgPath !== null || development || preview)) {
    throw new Error("--release cannot be combined with an explicit target or a non-release mode");
  }
  if (development && preview) {
    throw new Error("--development and --preview are mutually exclusive");
  }
  if (!release && (appPath === null) === (dmgPath === null)) {
    throw new Error("Provide exactly one of --app or --dmg");
  }
  if (channel === null) {
    throw new Error(
      "--channel is required; choose a named release channel explicitly",
    );
  }
  const production = !development && !preview;
  architecture ??= "arm64";
  if (preview && channel !== MACOS_PREVIEW_DISTRIBUTION_CHANNEL) {
    throw new Error(
      `--preview requires --channel ${MACOS_PREVIEW_DISTRIBUTION_CHANNEL}`,
    );
  }
  const releaseChannel = preview
    ? Object.freeze({ name: MACOS_PREVIEW_DISTRIBUTION_CHANNEL })
    : resolveReleaseChannel(channel, { architecture });
  if (release) {
    return {
      appPath: null,
      dmgPath: resolve(
        join(
          ".release-build",
          "macos-release",
          ...(releaseChannel.name === "stable" ? [] : [releaseChannel.name]),
          architecture === "x64" ? RELEASE_MANIFEST.macOS.x64DmgFileName : RELEASE_MANIFEST.macOS.arm64DmgFileName,
        ),
      ),
      channel: releaseChannel.name,
      architecture,
      distribution: "release",
      production,
    };
  }
  return {
    appPath,
    architecture,
    channel: releaseChannel.name,
    distribution: production ? "release" : preview ? "preview" : "development",
    dmgPath,
    production,
  };
}

export async function main(argv, dependencies = {}) {
  const options = parseArguments(argv);
  const validateInstalled = dependencies.validateInstalledMacOSApp
    ?? validateInstalledMacOSApp;
  const validatePreview = dependencies.validateMacOSPreviewApp
    ?? validateMacOSPreviewApp;
  const validateDMG = dependencies.validateMacOSDMG ?? validateMacOSDMG;
  const validationOptions = {
    architecture: options.architecture,
    channel: options.channel,
    distribution: options.distribution,
    production: options.production,
  };
  let result;
  if (options.appPath && options.distribution === "preview") {
    const inspected = await validatePreview(options.appPath, { architecture: options.architecture });
    result = {
      bundleIdentifier: inspected.bundleIdentifier,
      production: false,
      shortVersion: inspected.shortVersion,
    };
  } else {
    result = options.appPath
      ? await validateInstalled(options.appPath, validationOptions)
      : await validateDMG(options.dmgPath, validationOptions);
  }
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
