"use strict";

/**
 * Closed production distribution policy shared by the Electron builder and
 * the main-process updater.  Development packages intentionally do not read
 * this policy: they have a separate identifier and no updater configuration.
 */

const PRODUCTION_ELECTRON_DISTRIBUTION_SCHEMA_VERSION =
  "tibotattle-electron-distribution-v1";
const PRODUCTION_ELECTRON_APP_ID = "com.usagemonitor.local";
const PRODUCTION_ELECTRON_CHANNEL = "stable";
const PRODUCTION_ELECTRON_CONTRIBUTION_POLICY = "accountless-opt-out-v1";
const PRODUCTION_ELECTRON_UPDATE_ORIGIN = "https://updates.tibotattle.com";
// This is deliberately a supplied candidate input rather than a release
// allocation in source control. It is limited to ten decimal digits because
// the macOS handover validator compares CFBundleVersion components as bounded
// numeric values. A candidate still has to prove it is newer than the actual
// installed native application before a handover can proceed.
const PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN = /^[1-9][0-9]{0,9}$/u;
const PRODUCTION_ELECTRON_RELEASE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const WINDOWS_FILE_VERSION_COMPONENT_LIMIT = 65_535n;
const WINDOWS_FILE_VERSION_COMPONENTS = 4;
const PRODUCTION_ELECTRON_NATIVE_HANDOVER_HELPER_RESOURCE_RELATIVE_PATH = Object.freeze([
  "native",
  "TiboTattleNativeHandover",
]);
// This unsigned source-candidate resource is compiled separately for each
// reviewed macOS target. The signed enclosing Electron app is the later
// authority that may load it; no development package receives this binary.
const PRODUCTION_ELECTRON_MACOS_KEYCHAIN_ADAPTER_RESOURCE_RELATIVE_PATH = Object.freeze([
  "native",
  "macos-keychain.node",
]);

const PRODUCTION_ELECTRON_TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    architecture: "arm64",
    feedURL: `${PRODUCTION_ELECTRON_UPDATE_ORIGIN}/electron/stable/darwin-arm64`,
    platform: "darwin",
  }),
  "darwin-x64": Object.freeze({
    architecture: "x64",
    feedURL: `${PRODUCTION_ELECTRON_UPDATE_ORIGIN}/electron/stable/darwin-x64`,
    platform: "darwin",
  }),
  "win32-x64": Object.freeze({
    architecture: "x64",
    feedURL: `${PRODUCTION_ELECTRON_UPDATE_ORIGIN}/electron/stable/win32-x64`,
    platform: "win32",
  }),
  "linux-x64": Object.freeze({
    architecture: "x64",
    feedURL: `${PRODUCTION_ELECTRON_UPDATE_ORIGIN}/electron/stable/linux-x64`,
    platform: "linux",
  }),
});

function productionElectronTargetFor(platform, architecture) {
  const target = `${platform}-${architecture}`;
  return Object.hasOwn(PRODUCTION_ELECTRON_TARGETS, target) ? target : null;
}

function productionElectronFeedForTarget(target) {
  return PRODUCTION_ELECTRON_TARGETS[target]?.feedURL ?? null;
}

function assertProductionBuildNumber(buildNumber) {
  if (typeof buildNumber !== "string" || !PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN.test(buildNumber)) {
    throw new TypeError("buildNumber must be a bounded positive decimal string");
  }
  return buildNumber;
}

/**
 * Convert the exact decimal candidate identifier into all four unsigned
 * 16-bit Windows resource-version components. This is a lossless base-65536
 * representation, so numeric candidate order is preserved without allowing a
 * decimal input such as 20260906 to overflow a PE version component.
 */
function productionElectronWindowsFileVersion(buildNumber) {
  let remaining = BigInt(assertProductionBuildNumber(buildNumber));
  const components = Array(WINDOWS_FILE_VERSION_COMPONENTS).fill("0");
  for (let index = WINDOWS_FILE_VERSION_COMPONENTS - 1; index >= 0; index -= 1) {
    components[index] = String(remaining % (WINDOWS_FILE_VERSION_COMPONENT_LIMIT + 1n));
    remaining /= WINDOWS_FILE_VERSION_COMPONENT_LIMIT + 1n;
  }
  if (remaining !== 0n) {
    throw new TypeError("buildNumber cannot be represented as a Windows file version");
  }
  return components.join(".");
}

/**
 * Return the target-specific value passed to electron-builder's buildVersion.
 * macOS retains the supplied integer as CFBundleVersion for native handover
 * ordering. Windows receives four valid PE components, and AppImage carries
 * both the release version and exact candidate identifier.
 */
function productionElectronBuildVersionForTarget({ target, version, buildNumber } = {}) {
  const targetSpec = PRODUCTION_ELECTRON_TARGETS[target];
  if (!targetSpec || typeof version !== "string" || !PRODUCTION_ELECTRON_RELEASE_VERSION_PATTERN.test(version)) {
    throw new TypeError("target and release version are required");
  }
  const selectedBuildNumber = assertProductionBuildNumber(buildNumber);
  if (targetSpec.platform === "darwin") return selectedBuildNumber;
  if (targetSpec.platform === "win32") {
    return productionElectronWindowsFileVersion(selectedBuildNumber);
  }
  return `${version}.${selectedBuildNumber}`;
}

module.exports = Object.freeze({
  PRODUCTION_ELECTRON_APP_ID,
  PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN,
  PRODUCTION_ELECTRON_CHANNEL,
  PRODUCTION_ELECTRON_CONTRIBUTION_POLICY,
  PRODUCTION_ELECTRON_DISTRIBUTION_SCHEMA_VERSION,
  PRODUCTION_ELECTRON_MACOS_KEYCHAIN_ADAPTER_RESOURCE_RELATIVE_PATH,
  PRODUCTION_ELECTRON_NATIVE_HANDOVER_HELPER_RESOURCE_RELATIVE_PATH,
  PRODUCTION_ELECTRON_RELEASE_VERSION_PATTERN,
  PRODUCTION_ELECTRON_TARGETS,
  PRODUCTION_ELECTRON_UPDATE_ORIGIN,
  WINDOWS_FILE_VERSION_COMPONENT_LIMIT,
  productionElectronBuildVersionForTarget,
  productionElectronFeedForTarget,
  productionElectronTargetFor,
  productionElectronWindowsFileVersion,
});
