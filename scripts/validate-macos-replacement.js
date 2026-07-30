#!/usr/bin/env node
import {
  validateMacOSSignedReplacementArtifacts,
} from "./macos-release-core.js";

function usage() {
  return [
    "Usage:",
    "  node scripts/validate-macos-replacement.js \\",
    "    --previous RELEASE.json --candidate RELEASE.json",
  ].join("\n");
}

function readArguments(argv) {
  const result = {
    previousReleaseManifestPath: null,
    candidateReleaseManifestPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--previous") {
      result.previousReleaseManifestPath = argv[++index] ?? null;
    } else if (argument === "--candidate") {
      result.candidateReleaseManifestPath = argv[++index] ?? null;
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!result.previousReleaseManifestPath
      || !result.candidateReleaseManifestPath) {
    throw new Error(usage());
  }
  return result;
}

try {
  const result = await validateMacOSSignedReplacementArtifacts(
    readArguments(process.argv.slice(2)),
  );
  console.log("Signed replacement contract: valid");
  console.log(`Bundle identifier: ${result.bundleIdentifier}`);
  console.log(
    `Bundle versions: ${result.previousBundleVersion} -> ${result.candidateBundleVersion}`,
  );
  console.log(`Update mode: ${result.updateMode}`);
  console.log(`Rollback mode: ${result.rollbackMode}`);
  console.log("Automatic updater: absent");
  console.log("Hosted data mutation: none");
} catch (error) {
  const code =
    typeof error?.code === "string"
    ? error.code
    : "MACOS_REPLACEMENT_VALIDATION_FAILED";
  console.error(code);
  process.exitCode = 1;
}
