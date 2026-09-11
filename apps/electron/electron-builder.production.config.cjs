"use strict";

/**
 * One target-specific production candidate configuration.
 *
 * This file is deliberately only a source configuration.  It does not invoke
 * electron-builder, upload a feed, sign, notarize, or make a release claim.
 * A finalizer must provide every input below and run electron-builder with
 * `--publish never`; the generic provider still makes builder write the fixed
 * app-update.yml that electron-updater reads from the installed application.
 */

const { readFileSync } = require("node:fs");
const path = require("node:path");

const distribution = require("../../config/electron-production-distribution.cjs");

const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
const TARGET_ENV = "TIBOTATTLE_ELECTRON_TARGET";
const VERSION_ENV = "TIBOTATTLE_ELECTRON_VERSION";
const SOURCE_REVISION_ENV = "TIBOTATTLE_ELECTRON_SOURCE_REVISION";
const BUILD_NUMBER_ENV = "TIBOTATTLE_ELECTRON_BUILD_NUMBER";
const REHEARSAL_CANDIDATE_ENV = "TIBOTATTLE_ELECTRON_REHEARSAL_CANDIDATE";
const REHEARSAL_CURRENT_VERSION_ENV = "TIBOTATTLE_ELECTRON_REHEARSAL_CURRENT_VERSION";
const REHEARSAL_NEXT_VERSION_ENV = "TIBOTATTLE_ELECTRON_REHEARSAL_NEXT_VERSION";
const SIGNED_STAGING_REHEARSAL_ENV = "TIBOTATTLE_ELECTRON_ACCOUNTLESS_SIGNED_STAGING_REHEARSAL";
const SIGNED_STAGING_EXPECTED_TEST_UID_ENV = "TIBOTATTLE_ELECTRON_SIGNED_STAGING_EXPECTED_TEST_UID";
const SIGNED_STAGING_EXPECTED_TEST_USERNAME_ENV = "TIBOTATTLE_ELECTRON_SIGNED_STAGING_EXPECTED_TEST_USERNAME";
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const UID_PATTERN = /^(?:[1-9][0-9]{0,9})$/u;

class ProductionElectronBuilderConfigError extends Error {
  constructor() {
    super("Production Electron builder configuration is invalid");
    this.name = "ProductionElectronBuilderConfigError";
    this.code = "electron_production_builder_config_invalid";
  }
}

function fail() {
  throw new ProductionElectronBuilderConfigError();
}

function exactEnvironment(name) {
  if (!Object.hasOwn(process.env, name)
      || typeof process.env[name] !== "string"
      || process.env[name].length === 0
      || process.env[name] !== process.env[name].trim()) {
    fail();
  }
  return process.env[name];
}

function optionalExactEnvironment(name) {
  if (!Object.hasOwn(process.env, name)) return undefined;
  return exactEnvironment(name);
}

function requiredUIDEnvironment(name) {
  const value = exactEnvironment(name);
  if (!UID_PATTERN.test(value)) fail();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail();
  return parsed;
}

function readSourceReleaseVersion() {
  try {
    const manifest = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
    if (manifest?.name !== "app-usagemonitor"
        || typeof manifest.version !== "string"
        || !VERSION_PATTERN.test(manifest.version)) {
      fail();
    }
    return manifest.version;
  } catch (error) {
    if (error instanceof ProductionElectronBuilderConfigError) throw error;
    fail();
  }
}

function readInputs() {
  const target = exactEnvironment(TARGET_ENV);
  const targetSpec = distribution.PRODUCTION_ELECTRON_TARGETS[target];
  const signedStagingMarker = optionalExactEnvironment(SIGNED_STAGING_REHEARSAL_ENV);
  const signedStaging = signedStagingMarker !== undefined;
  if (signedStaging && signedStagingMarker !== "rehearsal-v1") fail();
  const rehearsal = optionalExactEnvironment(REHEARSAL_CANDIDATE_ENV) ?? null;
  const rehearsalCurrentVersion = optionalExactEnvironment(REHEARSAL_CURRENT_VERSION_ENV);
  const rehearsalNextVersion = optionalExactEnvironment(REHEARSAL_NEXT_VERSION_ENV);
  const expectedTestUID = signedStaging
    ? requiredUIDEnvironment(SIGNED_STAGING_EXPECTED_TEST_UID_ENV)
    : optionalExactEnvironment(SIGNED_STAGING_EXPECTED_TEST_UID_ENV);
  const expectedTestUsername = signedStaging
    ? exactEnvironment(SIGNED_STAGING_EXPECTED_TEST_USERNAME_ENV)
    : optionalExactEnvironment(SIGNED_STAGING_EXPECTED_TEST_USERNAME_ENV);
  const signedStagingSelection = signedStaging
    ? distribution.accountlessSignedStagingRehearsalForTarget({
      target,
      expectedTestUID,
      expectedTestUsername,
    })
    : null;
  const sourceReleaseVersion = readSourceReleaseVersion();
  const distributionSelection = signedStaging
    ? null
    : distribution.productionElectronDistributionForTarget({
    target,
    rehearsal,
    rehearsalCurrentVersion,
    rehearsalNextVersion,
    minimumRehearsalVersion: rehearsal === null ? undefined : sourceReleaseVersion,
  });
  const sourceRevision = exactEnvironment(SOURCE_REVISION_ENV);
  const buildNumber = exactEnvironment(BUILD_NUMBER_ENV);
  const version = distributionSelection?.semanticVersion ?? sourceReleaseVersion;
  if (!targetSpec || (signedStaging
    ? signedStagingSelection === null || rehearsal !== null
      || expectedTestUID === undefined || expectedTestUsername === undefined
    : distributionSelection === null || expectedTestUID !== undefined || expectedTestUsername !== undefined)
      || !SOURCE_REVISION_PATTERN.test(sourceRevision)
      || !distribution.PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN.test(buildNumber)
      || exactEnvironment(VERSION_ENV) !== version) {
    fail();
  }
  return Object.freeze({
    buildNumber,
    distributionSelection,
    expectedTestUID,
    expectedTestUsername,
    rehearsal,
    rehearsalCurrentVersion,
    rehearsalNextVersion,
    signedStaging,
    signedStagingSelection,
    sourceReleaseVersion,
    sourceRevision,
    target,
    targetSpec,
    version,
  });
}

function distributionMetadata({ buildNumber, distributionSelection, sourceRevision, target }) {
  const metadata = {
    appId: distribution.PRODUCTION_ELECTRON_APP_ID,
    buildNumber,
    channel: distributionSelection.channel,
    contributionPolicy: distributionSelection.contributionPolicy,
    schemaVersion: distributionSelection.schemaVersion,
    sourceRevision,
    target,
    updateFeed: distributionSelection.feedURL,
  };
  if (distributionSelection.semanticVersion !== null) {
    metadata.semanticVersion = distributionSelection.semanticVersion;
    metadata.rehearsalCurrentVersion = distributionSelection.rehearsalCurrentVersion;
    metadata.rehearsalNextVersion = distributionSelection.rehearsalNextVersion;
  }
  return Object.freeze(metadata);
}

function signedStagingManifestFields({ signedStagingSelection, sourceRevision }) {
  return Object.freeze({
    appId: signedStagingSelection.appId,
    channel: signedStagingSelection.channel,
    contributionPolicy: signedStagingSelection.contributionPolicy,
    credentialStorage: signedStagingSelection.credentialStorage,
    executionProfile: signedStagingSelection.executionProfile,
    expectedTestUID: signedStagingSelection.expectedTestUID,
    expectedTestUsername: signedStagingSelection.expectedTestUsername,
    schemaVersion: signedStagingSelection.schemaVersion,
    sourceRevision,
    target: signedStagingSelection.target,
    updater: "disabled",
  });
}

function stagingClosure() {
  return [
    {
      from: ".",
      to: ".",
      filter: [
        "package.json",
        "electron-runtime-manifest.json",
        "apps/electron/**",
        "apps/local/**",
        "apps/web/public/**",
        "config/**",
        "contracts/**",
        "native/macos-keychain/contract.js",
        "native/windows-filesystem/build/Release/windows_filesystem.node",
        "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
        "native/linux-credential-mutex/build/qualification/linux_credential_mutex.node",
        "native/linux-credential-mutex/build/qualification/linux_credential_mutex.node.manifest.json",
        "schemas/**",
        "src/**",
        "generated/**",
      ],
    },
    {
      from: "node_modules",
      to: "node_modules",
      filter: ["**/*"],
    },
  ];
}

function asarUnpackFor(target) {
  if (target === "win32-x64") {
    return [
      "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
      "native/windows-filesystem/build/Release/windows_filesystem.node",
    ];
  }
  const keytarTarget = target.startsWith("darwin-") ? target : "linux-x64";
  return [
    `node_modules/@github/keytar/prebuilds/${keytarTarget}/keytar.node`,
    ...(target === "linux-x64" ? [
      "native/linux-credential-mutex/build/qualification/linux_credential_mutex.node",
      "native/linux-credential-mutex/build/qualification/linux_credential_mutex.node.manifest.json",
    ] : []),
  ];
}

const INPUTS = readInputs();
const metadata = INPUTS.signedStaging ? null : distributionMetadata(INPUTS);
const packagedSourceReleaseVersion = INPUTS.signedStaging
  || INPUTS.version === INPUTS.sourceReleaseVersion
  ? null
  : INPUTS.sourceReleaseVersion;
const signedStagingFields = INPUTS.signedStaging
  ? signedStagingManifestFields(INPUTS)
  : null;
const stagingPathSegments = INPUTS.signedStaging
  ? distribution.accountlessSignedStagingRehearsalStagingPathSegments({
    target: INPUTS.target,
    expectedTestUID: INPUTS.expectedTestUID,
    expectedTestUsername: INPUTS.expectedTestUsername,
  })
  : distribution.productionElectronStagingPathSegments({
    target: INPUTS.target,
    rehearsal: INPUTS.rehearsal,
    rehearsalCurrentVersion: INPUTS.rehearsalCurrentVersion,
    rehearsalNextVersion: INPUTS.rehearsalNextVersion,
    minimumRehearsalVersion: INPUTS.rehearsal === null ? undefined : readSourceReleaseVersion(),
  });
if (stagingPathSegments === null) fail();
const targetDirectory = path.join(
  REPOSITORY_ROOT,
  ".release-build",
  ...stagingPathSegments,
);
const targetBuildVersion = distribution.productionElectronBuildVersionForTarget({
  target: INPUTS.target,
  version: INPUTS.version,
  buildNumber: INPUTS.buildNumber,
});
const macBundleShortVersion = INPUTS.targetSpec.platform === "darwin"
  ? distribution.productionElectronMacOSBundleShortVersionForTarget({
    target: INPUTS.target,
    version: INPUTS.version,
  })
  : null;
const nativeHandoverHelperPath = path.join(
  targetDirectory,
  ...distribution.PRODUCTION_ELECTRON_NATIVE_HANDOVER_HELPER_RESOURCE_RELATIVE_PATH,
);
const nativeHandoverHelperContentsPath = [
  "MacOS",
  distribution.PRODUCTION_ELECTRON_NATIVE_HANDOVER_HELPER_RESOURCE_RELATIVE_PATH.at(-1),
].join("/");
const nativeMacOSKeychainAdapterPath = path.join(
  targetDirectory,
  ...distribution.PRODUCTION_ELECTRON_MACOS_KEYCHAIN_ADAPTER_RESOURCE_RELATIVE_PATH,
);
const nativeMacOSKeychainAdapterResourcesPath =
  distribution.PRODUCTION_ELECTRON_MACOS_KEYCHAIN_ADAPTER_RESOURCE_RELATIVE_PATH.join("/");

function assertExactStagedManifest() {
  let staged;
  try {
    staged = JSON.parse(readFileSync(path.join(targetDirectory, "app", "package.json"), "utf8"));
  } catch {
    fail();
  }
  if (staged?.version !== INPUTS.version
      || (packagedSourceReleaseVersion === null
        ? Object.hasOwn(staged, "tibotattleSourceReleaseVersion")
        : staged.tibotattleSourceReleaseVersion !== packagedSourceReleaseVersion)) {
    fail();
  }
  if (!INPUTS.signedStaging) {
    if (JSON.stringify(staged.tibotattleDistribution) !== JSON.stringify(metadata)) fail();
    return;
  }
  const marker = staged.tibotattleAccountlessSignedStagingRehearsal;
  const exactKeys = [
    ...Object.keys(signedStagingFields),
    "origin",
  ].sort();
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)
      || Object.keys(marker).sort().join("\n") !== exactKeys.join("\n")
      || typeof marker.origin !== "string" || marker.origin.length === 0
      || Object.entries(signedStagingFields).some(([key, value]) => marker[key] !== value)
      || Object.hasOwn(staged, "tibotattleDistribution")
      || Object.hasOwn(staged, "tibotattleAccountlessHostedRehearsal")) {
    fail();
  }
}

const configuration = {
  appId: distribution.PRODUCTION_ELECTRON_APP_ID,
  productName: "TiboTattle",
  artifactName: "TiboTattle-${version}-${os}-${arch}.${ext}",
  buildNumber: INPUTS.buildNumber,
  // electron-builder uses this for CFBundleVersion and PE FileVersion. The
  // closed policy maps the same explicit candidate input to each platform's
  // accepted numeric representation; ambient CI build-number variables cannot
  // affect it.
  buildVersion: targetBuildVersion,
  directories: {
    app: path.join(targetDirectory, "app"),
    output: path.join(targetDirectory, "artifacts"),
  },
  files: stagingClosure(),
  asar: { smartUnpack: false },
  asarUnpack: asarUnpackFor(INPUTS.target),
  extraMetadata: {
    main: "apps/electron/main.js",
    name: "app-usagemonitor",
    productName: "TiboTattle",
    version: INPUTS.version,
    ...(packagedSourceReleaseVersion === null
      ? {} : { tibotattleSourceReleaseVersion: packagedSourceReleaseVersion }),
    ...(metadata === null ? {} : { tibotattleDistribution: metadata }),
    // app-builder-lib uses these fields for Windows executable and NSIS
    // ProductVersion values. Keep them in the same valid four-component form
    // as buildVersion instead of allowing its default decimal build number to
    // overflow a PE resource component.
    ...(INPUTS.targetSpec.platform === "win32" ? {
      shortVersion: targetBuildVersion,
      shortVersionWindows: targetBuildVersion,
    } : {}),
  },
  forceCodeSigning: true,
  electronFuses: {
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  beforeBuild: () => false,
  // The staging script and builder config independently derive the closed
  // selection. Verify their package-level semantic version and distribution
  // metadata match before electron-builder can turn it into an installer.
  beforePack: () => assertExactStagedManifest(),
  npmRebuild: true,
  buildDependenciesFromSource: false,
  nodeGypRebuild: false,
  // The updater remains a stable/handover distribution capability. The signed
  // staging marker deliberately omits it, and `--publish never` still applies
  // to all source-candidate invocations.
  ...(INPUTS.signedStaging ? {} : {
    publish: [{ provider: "generic", url: INPUTS.distributionSelection.feedURL }],
  }),
};

if (INPUTS.targetSpec.platform === "darwin") {
  // Source preparation compiles this exact unsigned, thin helper into the
  // target-local native directory before electron-builder runs. `extraFiles`
  // places it at Contents/MacOS/TiboTattleNativeHandover so Bundle.main and
  // SMAppService resolve against the enclosing signed app.
  configuration.extraFiles = [{
    from: nativeHandoverHelperPath,
    to: nativeHandoverHelperContentsPath,
  }];
  // The adapter stays outside app.asar at this exact Resources path. Its
  // loader independently verifies the enclosing signed app and this fixed
  // resource before Node can load native code.
  configuration.extraResources = [{
    from: nativeMacOSKeychainAdapterPath,
    to: nativeMacOSKeychainAdapterResourcesPath,
  }];
  configuration.mac = {
    // Match the supported platform floor in the signed bundle metadata, so
    // macOS and package managers can reject unsupported systems accurately.
    minimumSystemVersion: "14.0",
    // electron-updater uses the prerelease package version. The guided native
    // handover reads the numeric plist fields, so tie both values to this one
    // reviewed selection rather than letting electron-builder derive one from
    // an ambient package version.
    bundleShortVersion: macBundleShortVersion,
    bundleVersion: targetBuildVersion,
    target: [
      { target: "dmg", arch: [INPUTS.targetSpec.architecture] },
      { target: "zip", arch: [INPUTS.targetSpec.architecture] },
    ],
    icon: path.join(REPOSITORY_ROOT, "apps/macos/Assets/AppIcon.icns"),
    // osx-sign 1.3.3 must sign the extra Contents/MacOS helper before the
    // actual CFBundleExecutable, which seals the enclosing app bundle.
    sign: "./scripts/electron-macos-sign-order.mjs",
    hardenedRuntime: true,
    gatekeeperAssess: true,
  };
}

if (INPUTS.targetSpec.platform === "win32") {
  configuration.win = {
    target: [{ target: "nsis", arch: ["x64"] }],
    signAndEditExecutable: true,
    signExecutable: true,
    requestedExecutionLevel: "asInvoker",
    verifyUpdateCodeSignature: true,
  };
  configuration.nsis = {
    guid: distribution.PRODUCTION_ELECTRON_WINDOWS_TOAST_ACTIVATOR_CLSID,
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    selectPerMachineByDefault: false,
    allowToChangeInstallationDirectory: false,
    runAfterFinish: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    differentialPackage: false,
    packElevateHelper: false,
    buildUniversalInstaller: false,
  };
}

if (INPUTS.targetSpec.platform === "linux") {
  configuration.linux = {
    target: [{ target: "AppImage", arch: ["x64"] }],
    category: "Utility",
    executableName: "tibotattle",
    syncDesktopName: true,
    executableArgs: [],
  };
}

module.exports = configuration;
