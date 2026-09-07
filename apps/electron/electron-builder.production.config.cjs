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
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

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

function readPackageVersion() {
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
  const sourceRevision = exactEnvironment(SOURCE_REVISION_ENV);
  const buildNumber = exactEnvironment(BUILD_NUMBER_ENV);
  const version = readPackageVersion();
  if (!targetSpec
      || !SOURCE_REVISION_PATTERN.test(sourceRevision)
      || !distribution.PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN.test(buildNumber)
      || exactEnvironment(VERSION_ENV) !== version) {
    fail();
  }
  return Object.freeze({ buildNumber, sourceRevision, target, targetSpec, version });
}

function distributionMetadata({ buildNumber, sourceRevision, target, targetSpec }) {
  return Object.freeze({
    appId: distribution.PRODUCTION_ELECTRON_APP_ID,
    buildNumber,
    channel: distribution.PRODUCTION_ELECTRON_CHANNEL,
    contributionPolicy: distribution.PRODUCTION_ELECTRON_CONTRIBUTION_POLICY,
    schemaVersion: distribution.PRODUCTION_ELECTRON_DISTRIBUTION_SCHEMA_VERSION,
    sourceRevision,
    target,
    updateFeed: targetSpec.feedURL,
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
        "native/windows-filesystem/build/Release/windows_filesystem.node",
        "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
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
  return [`node_modules/@github/keytar/prebuilds/${keytarTarget}/keytar.node`];
}

const INPUTS = readInputs();
const metadata = distributionMetadata(INPUTS);
const targetDirectory = path.join(
  REPOSITORY_ROOT,
  ".release-build",
  "electron-production",
  INPUTS.target,
);
const targetBuildVersion = distribution.productionElectronBuildVersionForTarget({
  target: INPUTS.target,
  version: INPUTS.version,
  buildNumber: INPUTS.buildNumber,
});
const nativeHandoverHelperPath = path.join(
  targetDirectory,
  ...distribution.PRODUCTION_ELECTRON_NATIVE_HANDOVER_HELPER_RESOURCE_RELATIVE_PATH,
);
const nativeHandoverHelperContentsPath = [
  "MacOS",
  distribution.PRODUCTION_ELECTRON_NATIVE_HANDOVER_HELPER_RESOURCE_RELATIVE_PATH.at(-1),
].join("/");

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
    tibotattleDistribution: metadata,
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
  npmRebuild: true,
  buildDependenciesFromSource: false,
  nodeGypRebuild: false,
  // The URL is fixed per target. The CLI publish policy remains `never` in
  // the source-candidate path, so generic hosting is a later explicit gate.
  publish: [{ provider: "generic", url: INPUTS.targetSpec.feedURL }],
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
  configuration.mac = {
    target: [
      { target: "dmg", arch: [INPUTS.targetSpec.architecture] },
      { target: "zip", arch: [INPUTS.targetSpec.architecture] },
    ],
    icon: path.join(REPOSITORY_ROOT, "apps/macos/Assets/AppIcon.icns"),
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
    guid: "FDA705D7-5644-50E8-8CD2-3005D51B98C5",
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
