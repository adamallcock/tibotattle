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
// This is a separately packaged, unsigned development-only selection for
// the private hosted scheduler rehearsal. It deliberately has no production
// app identity, updater feed, signing contract, or native Keychain adapter.
// The reviewed staging origin remains in config/deployment-endpoints.js so
// this policy never becomes a second authority for Worker hostnames.
const ACCOUNTLESS_HOSTED_REHEARSAL_APP_ID =
  "com.adamallcock.tibotattle.electron.dev";
const ACCOUNTLESS_HOSTED_REHEARSAL_CHANNEL =
  "accountless-hosted-rehearsal-v1";
const ACCOUNTLESS_HOSTED_REHEARSAL_CREDENTIAL_STORAGE =
  "electron-safe-storage-file-v1";
const ACCOUNTLESS_HOSTED_REHEARSAL_SCHEMA_VERSION =
  "tibotattle-accountless-hosted-rehearsal-v1";
const ACCOUNTLESS_HOSTED_REHEARSAL_TARGET = "darwin-arm64";
// The signed staging rehearsal preserves the production bundle and native
// credential authority while keeping its scheduler isolated from production.
// It is intentionally a separate package marker instead of a distribution
// channel: it has no updater feed and is allowed only in an explicitly bound
// disposable macOS account.
const ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_CHANNEL =
  "accountless-signed-staging-rehearsal-v1";
const ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_CREDENTIAL_STORAGE =
  "native-macos-keychain-accountless-installation-v1";
const ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_SCHEMA_VERSION =
  "tibotattle-accountless-signed-staging-rehearsal-v1";
const ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_TARGET = "darwin-arm64";
const ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_ID =
  "accountless-signed-staging-rehearsal-v1";
// The package is deliberately consumable only by the reviewed hosted macOS
// arm64 profile. The runtime checks the complete GitHub-provided tuple in
// addition to the OS-provided account identity; environment values never
// select this package path.
const ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_EXECUTION_PROFILE =
  "github-hosted-macos-arm64-v1";
const MACOS_UID_MAXIMUM = 4_294_967_295;
const MACOS_LOGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
// The native-to-Electron handover accepts one explicit, ordered prerelease
// pair. It shares a private target-scoped feed so an installed current
// candidate can discover the later candidate, while remaining isolated from
// the stable feeds. The pair is supplied by the rehearsal preparation, not
// allocated in source control. Nothing here uploads, signs, notarizes, or
// advertises either candidate as supported.
const PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_ID =
  "native-to-electron-handover-v1";
const PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CHANNEL =
  "native-to-electron-handover-rehearsal-v1";
const PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CONTRIBUTION_POLICY =
  "disabled-for-native-to-electron-handover-rehearsal-v1";
const PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_SCHEMA_VERSION =
  "tibotattle-electron-handover-rehearsal-v1";
const PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_FEED_PREFIX =
  "electron/rehearsal/native-to-electron-handover-v1";
const PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CANDIDATES = Object.freeze({
  current: "current",
  next: "next",
});
// This is deliberately a supplied candidate input rather than a release
// allocation in source control. It is limited to ten decimal digits because
// the macOS handover validator compares CFBundleVersion components as bounded
// numeric values. A candidate still has to prove it is newer than the actual
// installed native application before a handover can proceed.
const PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN = /^[1-9][0-9]{0,9}$/u;
const PRODUCTION_ELECTRON_RELEASE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_VERSION_PATTERN =
  /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})-native-to-electron-handover\.([1-9][0-9]{0,8})$/u;
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

function parseNativeToElectronHandoverRehearsalVersion(value) {
  if (typeof value !== "string") return null;
  const match = PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_VERSION_PATTERN.exec(
    value,
  );
  if (match === null) return null;
  return Object.freeze({
    core: Object.freeze([BigInt(match[1]), BigInt(match[2]), BigInt(match[3])]),
    ordinal: BigInt(match[4]),
    version: value,
  });
}

function compareVersionCores(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function productionElectronNativeToElectronHandoverRehearsalPair({
  currentVersion,
  nextVersion,
  minimumVersion,
} = {}) {
  const current = parseNativeToElectronHandoverRehearsalVersion(currentVersion);
  const next = parseNativeToElectronHandoverRehearsalVersion(nextVersion);
  if (current === null || next === null
      || compareVersionCores(current.core, next.core) !== 0
      || current.ordinal >= next.ordinal) {
    return null;
  }
  if (minimumVersion !== undefined) {
    if (typeof minimumVersion !== "string"
        || !PRODUCTION_ELECTRON_RELEASE_VERSION_PATTERN.test(minimumVersion)) {
      return null;
    }
    const minimumCore = minimumVersion.split(".").map((component) => BigInt(component));
    if (compareVersionCores(current.core, minimumCore) <= 0) return null;
  }
  return Object.freeze({ currentVersion, nextVersion });
}

function productionElectronDistributionForTarget({
  target,
  rehearsal = null,
  rehearsalCurrentVersion,
  rehearsalNextVersion,
  minimumRehearsalVersion,
} = {}) {
  const targetSpec = PRODUCTION_ELECTRON_TARGETS[target];
  if (!targetSpec) return null;
  if (rehearsal === null || rehearsal === undefined) {
    if (rehearsalCurrentVersion !== undefined || rehearsalNextVersion !== undefined
        || minimumRehearsalVersion !== undefined) return null;
    return Object.freeze({
      channel: PRODUCTION_ELECTRON_CHANNEL,
      contributionPolicy: PRODUCTION_ELECTRON_CONTRIBUTION_POLICY,
      feedURL: targetSpec.feedURL,
      rehearsal: null,
      schemaVersion: PRODUCTION_ELECTRON_DISTRIBUTION_SCHEMA_VERSION,
      semanticVersion: null,
      target,
    });
  }
  const candidate = PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CANDIDATES[rehearsal];
  const pair = productionElectronNativeToElectronHandoverRehearsalPair({
    currentVersion: rehearsalCurrentVersion,
    nextVersion: rehearsalNextVersion,
    ...(minimumRehearsalVersion === undefined ? {} : { minimumVersion: minimumRehearsalVersion }),
  });
  // The required handover is only from the released native macOS application.
  // Do not turn a source rehearsal into Windows or Linux support by accepting
  // those targets here.
  if (!candidate || pair === null || targetSpec.platform !== "darwin") return null;
  return Object.freeze({
    channel: PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CHANNEL,
    contributionPolicy:
      PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CONTRIBUTION_POLICY,
    feedURL: `${PRODUCTION_ELECTRON_UPDATE_ORIGIN}/${PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_FEED_PREFIX}/${target}`,
    rehearsal,
    schemaVersion: PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_SCHEMA_VERSION,
    rehearsalCurrentVersion: pair.currentVersion,
    rehearsalNextVersion: pair.nextVersion,
    semanticVersion: pair[`${candidate}Version`],
    target,
  });
}

function productionElectronStagingPathSegments(options = {}) {
  const distribution = productionElectronDistributionForTarget(options);
  if (distribution === null) return null;
  if (distribution.rehearsal === null) {
    return Object.freeze(["electron-production", distribution.target]);
  }
  return Object.freeze([
    "electron-production",
    "rehearsal",
    PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_ID,
    distribution.rehearsal,
    distribution.target,
  ]);
}

function validMacOSUID(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MACOS_UID_MAXIMUM;
}

function validMacOSLoginName(value) {
  return typeof value === "string" && MACOS_LOGIN_NAME_PATTERN.test(value);
}

/**
 * The signed staging package is bound to one disposable OS user. Both parts
 * of that account identity are supplied by the finalizer; the source tree
 * never guesses a local account UID or login name. A hosted runner may reuse
 * the builder's numeric UID, so the operating-system login name and closed
 * execution profile are also part of the package contract.
 */
function accountlessSignedStagingRehearsalForTarget({
  target,
  expectedTestUID,
  expectedTestUsername,
} = {}) {
  if (target !== ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_TARGET
      || !validMacOSUID(expectedTestUID)
      || !validMacOSLoginName(expectedTestUsername)) {
    return null;
  }
  return Object.freeze({
    appId: PRODUCTION_ELECTRON_APP_ID,
    channel: ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_CHANNEL,
    contributionPolicy: PRODUCTION_ELECTRON_CONTRIBUTION_POLICY,
    credentialStorage: ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_CREDENTIAL_STORAGE,
    executionProfile: ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_EXECUTION_PROFILE,
    expectedTestUID,
    expectedTestUsername,
    schemaVersion: ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_SCHEMA_VERSION,
    target: ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_TARGET,
  });
}

function accountlessSignedStagingRehearsalStagingPathSegments(options = {}) {
  const selection = accountlessSignedStagingRehearsalForTarget(options);
  return selection === null ? null : Object.freeze([
    "electron-production",
    "rehearsal",
    ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_ID,
    selection.target,
  ]);
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
  if (!targetSpec || typeof version !== "string"
      || (!PRODUCTION_ELECTRON_RELEASE_VERSION_PATTERN.test(version)
        && parseNativeToElectronHandoverRehearsalVersion(version) === null)) {
    throw new TypeError("target and release version are required");
  }
  const selectedBuildNumber = assertProductionBuildNumber(buildNumber);
  if (targetSpec.platform === "darwin") return selectedBuildNumber;
  if (targetSpec.platform === "win32") {
    return productionElectronWindowsFileVersion(selectedBuildNumber);
  }
  return `${version}.${selectedBuildNumber}`;
}

/**
 * electron-updater reads the packaged semantic version, while the guided
 * native handover reads the numeric CFBundleShortVersionString. A rehearsal
 * prerelease therefore keeps its fixed numeric core in the macOS plist and
 * retains the complete prerelease in package metadata for updater ordering.
 */
function productionElectronMacOSBundleShortVersionForTarget({ target, version } = {}) {
  const targetSpec = PRODUCTION_ELECTRON_TARGETS[target];
  if (!targetSpec || targetSpec.platform !== "darwin" || typeof version !== "string") {
    throw new TypeError("darwin target and semantic version are required");
  }
  if (PRODUCTION_ELECTRON_RELEASE_VERSION_PATTERN.test(version)) return version;
  const rehearsal = parseNativeToElectronHandoverRehearsalVersion(version);
  if (rehearsal === null) {
    throw new TypeError("macOS bundle short version must be a reviewed release or rehearsal version");
  }
  return rehearsal.core.map((part) => String(part)).join(".");
}

module.exports = Object.freeze({
  ACCOUNTLESS_HOSTED_REHEARSAL_APP_ID,
  ACCOUNTLESS_HOSTED_REHEARSAL_CHANNEL,
  ACCOUNTLESS_HOSTED_REHEARSAL_CREDENTIAL_STORAGE,
  ACCOUNTLESS_HOSTED_REHEARSAL_SCHEMA_VERSION,
  ACCOUNTLESS_HOSTED_REHEARSAL_TARGET,
  ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_CHANNEL,
  ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_CREDENTIAL_STORAGE,
  ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_EXECUTION_PROFILE,
  ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_ID,
  ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_SCHEMA_VERSION,
  ACCOUNTLESS_SIGNED_STAGING_REHEARSAL_TARGET,
  PRODUCTION_ELECTRON_APP_ID,
  PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN,
  PRODUCTION_ELECTRON_CHANNEL,
  PRODUCTION_ELECTRON_CONTRIBUTION_POLICY,
  PRODUCTION_ELECTRON_DISTRIBUTION_SCHEMA_VERSION,
  PRODUCTION_ELECTRON_MACOS_KEYCHAIN_ADAPTER_RESOURCE_RELATIVE_PATH,
  PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CANDIDATES,
  PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CHANNEL,
  PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CONTRIBUTION_POLICY,
  PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_FEED_PREFIX,
  PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_ID,
  PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_SCHEMA_VERSION,
  PRODUCTION_ELECTRON_NATIVE_HANDOVER_HELPER_RESOURCE_RELATIVE_PATH,
  PRODUCTION_ELECTRON_RELEASE_VERSION_PATTERN,
  PRODUCTION_ELECTRON_TARGETS,
  PRODUCTION_ELECTRON_UPDATE_ORIGIN,
  WINDOWS_FILE_VERSION_COMPONENT_LIMIT,
  accountlessSignedStagingRehearsalForTarget,
  accountlessSignedStagingRehearsalStagingPathSegments,
  productionElectronBuildVersionForTarget,
  productionElectronDistributionForTarget,
  productionElectronFeedForTarget,
  productionElectronMacOSBundleShortVersionForTarget,
  productionElectronNativeToElectronHandoverRehearsalPair,
  productionElectronStagingPathSegments,
  productionElectronTargetFor,
  productionElectronWindowsFileVersion,
});
