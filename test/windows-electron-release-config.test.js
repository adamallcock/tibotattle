import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  WINDOWS_INSTALLER_CONTRACT,
  WINDOWS_INSTALLER_UPGRADE_GUID,
} from "../config/windows-installer-contract.js";

const require = createRequire(import.meta.url);
const REPOSITORY_ROOT = resolve(".");
const RELEASE_CONFIG_PATH = resolve(
  "apps/electron/electron-builder.release.config.cjs",
);
const DEVELOPMENT_CONFIG_PATH = resolve(
  "apps/electron/electron-builder.config.cjs",
);
const PACKAGE_VERSION = JSON.parse(
  readFileSync(resolve("package.json"), "utf8"),
).version;
const SIGNING_MODE = "azure-trusted-signing";
const REQUIRED_ENV = Object.freeze({
  TIBOTATTLE_ELECTRON_TARGET: "win32",
  TIBOTATTLE_ELECTRON_SIGNING_MODE: SIGNING_MODE,
  TIBOTATTLE_ELECTRON_VERSION: PACKAGE_VERSION,
  TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME: "Adam Allcock",
  TIBOTATTLE_ELECTRON_AZURE_ENDPOINT: "https://eus.codesigning.azure.net/",
  TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME: "tibotattlesigning",
  TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME: "tibotattle-windows-public",
});
const TRUSTEDSIGNING_AZURE_CLI_ONLY_EXCLUSIONS = Object.freeze({
  ExcludeEnvironmentCredential: true,
  ExcludeWorkloadIdentityCredential: true,
  ExcludeManagedIdentityCredential: true,
  ExcludeSharedTokenCacheCredential: true,
  ExcludeVisualStudioCredential: true,
  ExcludeVisualStudioCodeCredential: true,
  ExcludeAzurePowerShellCredential: true,
  ExcludeAzureDeveloperCliCredential: true,
  ExcludeInteractiveBrowserCredential: true,
});
// Keep the child-process fixture independent from any developer or CI
// signing context.  The explicit list covers every name rejected by the
// release config, including ambient AZURE_CLIENT_ID/TENANT_ID and the Azure
// subscription/profile variables that the future workflow must not pass to
// electron-builder.  The token-pattern fallback also removes dynamically
// prefixed CSC/PFX/P12 names before the required test values are assigned.
const FORBIDDEN_ENVIRONMENT_NAMES = Object.freeze([
  "CSC_LINK",
  "WIN_CSC_LINK",
  "CSC_KEY_PASSWORD",
  "WIN_CSC_KEY_PASSWORD",
  "CSC_NAME",
  "CSC_IDENTITY_AUTO_DISCOVERY",
  "CSC_FOR_PULL_REQUEST",
  "CSC_CERTIFICATE_FILE",
  "CSC_CERTIFICATE_PASSWORD",
  "WIN_CERTIFICATE_FILE",
  "WIN_CERTIFICATE_PASSWORD",
  "TIBOTATTLE_WINDOWS_PFX_PATH",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_CERTIFICATE_PASSWORD",
  "AZURE_USERNAME",
  "AZURE_PASSWORD",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_CODE_SIGNING_ACCOUNT_NAME",
  "AZURE_CODE_SIGNING_PROFILE_NAME",
  "AZURE_CODE_SIGNING_ENDPOINT",
  "AZURE_CODE_SIGNING_PUBLISHER_NAME",
  "AZURE_CODE_SIGNING_TIMESTAMP_URL",
  "ARM_CLIENT_ID",
  "ARM_TENANT_ID",
  "ARM_SUBSCRIPTION_ID",
  "ARM_CLIENT_SECRET",
  "ARM_CLIENT_CERTIFICATE_PATH",
  "ARM_CLIENT_CERTIFICATE_PASSWORD",
  "ARM_USERNAME",
  "ARM_PASSWORD",
  "ARM_FEDERATED_TOKEN_FILE",
]);
const FORBIDDEN_ENVIRONMENT_KEY_PATTERN = /(?:^|_)(?:WIN_)?CSC(?:_|$)|(?:^|_)(?:PFX|P12)(?:_|$)/u;

function validEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const name of FORBIDDEN_ENVIRONMENT_NAMES) delete environment[name];
  for (const key of Object.keys(environment)) {
    if (FORBIDDEN_ENVIRONMENT_KEY_PATTERN.test(key.toUpperCase())) {
      delete environment[key];
    }
  }
  Object.assign(environment, REQUIRED_ENV);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

function configSnapshot(config) {
  return {
    keys: Object.keys(config).sort(),
    appId: config.appId,
    productName: config.productName,
    directories: config.directories,
    files: config.files,
    asar: config.asar,
    asarUnpack: config.asarUnpack,
    extraMetadata: config.extraMetadata,
    forceCodeSigning: config.forceCodeSigning,
    electronFuses: config.electronFuses,
    beforeBuildResult: config.beforeBuild(),
    npmRebuild: config.npmRebuild,
    buildDependenciesFromSource: config.buildDependenciesFromSource,
    nodeGypRebuild: config.nodeGypRebuild,
    publish: config.publish,
    win: config.win,
    nsis: config.nsis,
  };
}

function runConfig(configPath, overrides = {}) {
  const childSource = [
    "try {",
    `  const config = require(${JSON.stringify(configPath)});`,
    "  process.stdout.write(JSON.stringify({ ok: true, snapshot: (",
    "    config.beforeBuild ? {",
    "      keys: Object.keys(config).sort(),",
    "      appId: config.appId,",
    "      productName: config.productName,",
    "      directories: config.directories,",
    "      files: config.files,",
    "      asar: config.asar,",
    "      asarUnpack: config.asarUnpack,",
    "      extraMetadata: config.extraMetadata,",
    "      forceCodeSigning: config.forceCodeSigning,",
    "      electronFuses: config.electronFuses,",
    "      beforeBuildResult: config.beforeBuild(),",
    "      npmRebuild: config.npmRebuild,",
    "      buildDependenciesFromSource: config.buildDependenciesFromSource,",
    "      nodeGypRebuild: config.nodeGypRebuild,",
    "      publish: config.publish,",
    "      win: config.win,",
    "      nsis: config.nsis,",
    "    } : null",
    "  )}));",
    "} catch (error) {",
    "  process.stdout.write(JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }));",
    "  process.exitCode = 41;",
    "}",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", childSource], {
    cwd: REPOSITORY_ROOT,
    env: validEnvironment(overrides),
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.stdout, "", result.stderr);
  return {
    status: result.status,
    stderr: result.stderr,
    payload: JSON.parse(result.stdout),
  };
}

function expectInvalid(overrides) {
  const result = runConfig(RELEASE_CONFIG_PATH, overrides);
  assert.equal(result.status, 41);
  assert.deepEqual(result.payload, {
    ok: false,
    error: {
      code: "windows_release_builder_config_invalid",
      message: "Windows release builder configuration is invalid",
    },
  });
  return result;
}

function installedAppBuilderSource(relativePath) {
  const electronBuilderEntry = require.resolve("electron-builder");
  const electronBuilderRoot = resolve(dirname(electronBuilderEntry), "..");
  const appBuilderRoot = resolve(electronBuilderRoot, "..", "app-builder-lib");
  return readFileSync(join(appBuilderRoot, relativePath), "utf8");
}

test("Windows release config maps the frozen installer contract exactly", () => {
  const result = runConfig(RELEASE_CONFIG_PATH);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.payload.ok, true);
  const config = result.payload.snapshot;
  const installer = WINDOWS_INSTALLER_CONTRACT.installer;

  assert.equal(config.appId, WINDOWS_INSTALLER_CONTRACT.application.appId);
  assert.equal(config.productName, WINDOWS_INSTALLER_CONTRACT.application.productName);
  assert.equal(config.nsis.guid, WINDOWS_INSTALLER_UPGRADE_GUID);
  assert.equal(config.nsis.artifactName, "TiboTattle-${version}-Windows-x64.${ext}");
  assert.equal(
    config.nsis.artifactName
      .replace("${version}", "{version}")
      .replace("${ext}", "exe"),
    WINDOWS_INSTALLER_CONTRACT.installer.artifactNameTemplate,
  );
  assert.equal(config.nsis.oneClick, installer.oneClick);
  assert.equal(config.nsis.perMachine, installer.perMachine);
  assert.equal(config.nsis.allowElevation, installer.allowElevation);
  assert.equal(
    config.nsis.selectPerMachineByDefault,
    installer.selectPerMachineByDefault,
  );
  assert.equal(
    config.nsis.allowToChangeInstallationDirectory,
    installer.allowToChangeInstallationDirectory,
  );
  assert.equal(config.nsis.runAfterFinish, installer.runAfterFinish);
  assert.equal(config.nsis.createDesktopShortcut, installer.createDesktopShortcut);
  assert.equal(config.nsis.createStartMenuShortcut, installer.createStartMenuShortcut);
  assert.equal(config.nsis.deleteAppDataOnUninstall, installer.deleteAppDataOnUninstall);
  assert.equal(config.nsis.differentialPackage, installer.differentialPackage);
  assert.equal(config.nsis.packElevateHelper, false);
  assert.equal(config.nsis.warningsAsErrors, true);
  assert.equal(config.nsis.buildUniversalInstaller, false);
  assert.equal(config.nsis.script, undefined);
  assert.equal(config.nsis.include, undefined);

  assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.equal(config.win.signAndEditExecutable, true);
  assert.equal(config.win.signExecutable, true);
  assert.deepEqual(config.win.signExts, [".dll", "!.node"]);
  assert.equal(config.win.requestedExecutionLevel, "asInvoker");
  assert.equal(config.win.verifyUpdateCodeSignature, true);
  assert.match(
    config.win.windowsSigningOperationEvidenceRoot,
    /\.release-build[\\/]electron-production[\\/]windows-x64[\\/]evidence$/u,
  );
  assert.equal(
    config.win.windowsSigningOperationLedgerLeaf,
    "windows-signing-operation-ledger.json",
  );
  assert.equal(config.win.signtoolOptions, undefined);
  assert.deepEqual(config.win.azureSignOptions, {
    publisherName: REQUIRED_ENV.TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME,
    endpoint: REQUIRED_ENV.TIBOTATTLE_ELECTRON_AZURE_ENDPOINT,
    certificateProfileName:
      REQUIRED_ENV.TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME,
    codeSigningAccountName:
      REQUIRED_ENV.TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME,
    fileDigest: "SHA256",
    timestampRfc3161: "http://timestamp.acs.microsoft.com",
    timestampDigest: "SHA256",
    ...TRUSTEDSIGNING_AZURE_CLI_ONLY_EXCLUSIONS,
  });
  assert.equal(
    Object.hasOwn(config.win.azureSignOptions, "ExcludeAzureCliCredential"),
    false,
  );
  assert.equal(config.forceCodeSigning, true);
  assert.deepEqual(config.electronFuses, {
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  });
  assert.equal(config.publish, "never");
  assert.match(
    config.directories.app,
    /\.release-build[\\/]electron-production[\\/]windows-x64[\\/]app$/u,
  );
  assert.match(
    config.directories.output,
    /\.release-build[\\/]electron-production[\\/]windows-x64[\\/]artifacts$/u,
  );
  assert.equal(config.extraMetadata.version, PACKAGE_VERSION);
  assert.equal(config.beforeBuildResult, false);
  assert.equal(config.npmRebuild, true);
  assert.equal(config.buildDependenciesFromSource, false);
  assert.equal(config.nodeGypRebuild, false);
  assert.equal(config.nsis.updater, undefined);
  assert.equal(config.keys.includes("mac"), false);
  assert.equal(config.keys.includes("linux"), false);
});

test("release config reuses the reviewed Windows staging and ASAR closure", () => {
  const releaseResult = runConfig(RELEASE_CONFIG_PATH);
  const developmentResult = runConfig(DEVELOPMENT_CONFIG_PATH, {
    TIBOTATTLE_ELECTRON_TARGET: "win32",
  });
  assert.equal(releaseResult.status, 0, releaseResult.stderr);
  assert.equal(developmentResult.status, 0, developmentResult.stderr);
  assert.deepEqual(releaseResult.payload.snapshot.files, developmentResult.payload.snapshot.files);
  assert.deepEqual(
    releaseResult.payload.snapshot.asar,
    developmentResult.payload.snapshot.asar,
  );
  assert.deepEqual(
    releaseResult.payload.snapshot.asarUnpack,
    developmentResult.payload.snapshot.asarUnpack,
  );

  const releaseSource = readFileSync(RELEASE_CONFIG_PATH, "utf8");
  assert.doesNotMatch(releaseSource, /electron-builder\.config\.cjs/u);
  assert.doesNotMatch(releaseSource, /require\([^)]*electron-builder/u);
});

test("release config requires the exact target, signing mode, and complete Azure inputs", () => {
  expectInvalid({ TIBOTATTLE_ELECTRON_TARGET: undefined });
  expectInvalid({ TIBOTATTLE_ELECTRON_TARGET: "windows" });
  expectInvalid({ TIBOTATTLE_ELECTRON_SIGNING_MODE: undefined });
  expectInvalid({ TIBOTATTLE_ELECTRON_VERSION: undefined });
  expectInvalid({ TIBOTATTLE_ELECTRON_SIGNING_MODE: "pfx" });
  expectInvalid({ TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME: undefined });
  expectInvalid({ TIBOTATTLE_ELECTRON_AZURE_ENDPOINT: undefined });
  expectInvalid({ TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME: undefined });
  expectInvalid({ TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME: undefined });
});

test("release config rejects malformed endpoint, identifiers, and version", () => {
  expectInvalid({ TIBOTATTLE_ELECTRON_AZURE_ENDPOINT: "http://eus.codesigning.azure.net/" });
  expectInvalid({ TIBOTATTLE_ELECTRON_AZURE_ENDPOINT: "https://evil.example/" });
  expectInvalid({ TIBOTATTLE_ELECTRON_AZURE_ENDPOINT: "https://eus.codesigning.azure.net/sign" });
  expectInvalid({ TIBOTATTLE_ELECTRON_AZURE_ENDPOINT: "https://eus.codesigning.azure.net/?secret=not-used" });
  expectInvalid({ TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME: "account/name" });
  expectInvalid({ TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME: "profile\nname" });
  expectInvalid({ TIBOTATTLE_ELECTRON_AZURE_ENDPOINT: "https://west.codesigning.azure.net/" });
  expectInvalid({ TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME: "another-account" });
  expectInvalid({ TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME: "another-profile" });
  expectInvalid({ TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME: "Another Publisher" });
  expectInvalid({ TIBOTATTLE_ELECTRON_VERSION: "0.1.15-beta.1" });
  expectInvalid({ TIBOTATTLE_ELECTRON_VERSION: "0.1.14" });
  const hostile = expectInvalid({
    TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME: "CN=secret-token\nC:\\Users\\tester",
  });
  assert.doesNotMatch(hostile.payload.error.message, /secret-token|Users/u);
});

test("release config rejects legacy certificate, PFX, and client-secret environments", () => {
  expectInvalid({ CSC_LINK: "C:\\Users\\tester\\signing.pfx" });
  expectInvalid({ WIN_CSC_KEY_PASSWORD: "secret" });
  expectInvalid({ TIBOTATTLE_WINDOWS_PFX_PATH: "/tmp/signing.pfx" });
  expectInvalid({ AZURE_CLIENT_SECRET: "secret" });
  expectInvalid({ AZURE_CLIENT_ID: "client-id" });
  expectInvalid({ AZURE_TENANT_ID: "tenant-id" });
  expectInvalid({ ARM_CLIENT_SECRET: "secret" });
});

test("release config rejects every named ambient Azure or signing variable", () => {
  for (const name of FORBIDDEN_ENVIRONMENT_NAMES) {
    expectInvalid({ [name]: "ambient-value" });
  }
});

test("installed electron-builder 26.15.7 supports Azure signing and signs generated uninstallers", () => {
  const electronBuilderEntry = require.resolve("electron-builder");
  const electronBuilderRoot = resolve(dirname(electronBuilderEntry), "..");
  const electronBuilderPackage = JSON.parse(
    readFileSync(join(electronBuilderRoot, "package.json"), "utf8"),
  );
  assert.equal(electronBuilderPackage.version, "26.15.7");

  const winOptions = installedAppBuilderSource("out/options/winOptions.d.ts");
  assert.match(winOptions, /azureSignOptions\?: WindowsAzureSigningConfiguration/u);
  assert.match(winOptions, /signAndEditExecutable\?: boolean/u);
  assert.match(winOptions, /signExecutable\?: boolean/u);
  assert.match(winOptions, /signExts\?: string\[\]/u);
  assert.match(winOptions, /certificateProfileName: string/u);
  assert.match(winOptions, /codeSigningAccountName: string/u);
  assert.match(winOptions, /timestampRfc3161\?: string/u);
  assert.match(winOptions, /timestampDigest\?: string/u);
  assert.match(winOptions, /fileDigest\?: string/u);
  assert.match(winOptions, /\[k: string\]: string \| boolean \| Nullish/u);

  const azureManager = installedAppBuilderSource(
    "out/codeSign/windowsSignAzureManager.js",
  );
  assert.match(azureManager, /Invoke-TrustedSigning/u);
  assert.match(azureManager, /CertificateProfileName/u);
  assert.match(azureManager, /CodeSigningAccountName/u);
  assert.match(azureManager, /TimestampRfc3161/u);
  assert.match(azureManager, /Files:/u);
  assert.match(azureManager, /value !== false/u);
  assert.match(azureManager, /value === true/u);

  const nsisTarget = installedAppBuilderSource("out/targets/nsis/NsisTarget.js");
  assert.match(nsisTarget, /await packager\.signIf\(uninstallerPath\)/u);
  assert.match(
    nsisTarget,
    /custom NSIS script is used.*uninstaller is not signed/u,
  );
  assert.match(nsisTarget, /computeScriptAndSignUninstaller/u);

  const nsisUtility = installedAppBuilderSource("out/targets/nsis/nsisUtil.js");
  assert.match(nsisUtility, /packElevateHelper = false/u);
  assert.match(nsisUtility, /target\.packager\.signIf\(outFile\)/u);
});

test("release config excludes pre-signed native modules using pinned app-builder semantics", () => {
  const source = readFileSync(RELEASE_CONFIG_PATH, "utf8");
  assert.match(source, /signExts:\s*\["\.dll",\s*"!\.node"\]/u);
  const winPackager = installedAppBuilderSource("out/winPackager.js");
  assert.match(
    winPackager,
    /signExts\.some\(ext => ext\.startsWith\("!"\) && file\.endsWith\(ext\.substring\(1\)\)\)/u,
  );
  assert.match(
    winPackager,
    /signExts\.some\(ext => file\.endsWith\(ext\)\)/u,
  );
  const positiveMatch = winPackager.indexOf(
    "signExts.some(ext => file.endsWith(ext))",
  );
  const negativeMatch = winPackager.indexOf(
    'signExts.some(ext => ext.startsWith("!") && file.endsWith(ext.substring(1)))',
  );
  assert.equal(positiveMatch >= 0 && negativeMatch > positiveMatch, true);
});

test("electron-builder embeds Windows ASAR integrity before fusing and signing", () => {
  const framework = installedAppBuilderSource("out/electron/ElectronFramework.js");
  assert.match(framework, /if \(options\.asarIntegrity\)/u);
  assert.match(
    framework,
    /addWinAsarIntegrity\)\(executable, options\.asarIntegrity\)/u,
  );

  const packager = installedAppBuilderSource("out/platformPackager.js");
  const computeIntegrity = packager.indexOf("integrity_1.computeData");
  const embedIntegrity = packager.indexOf(
    "await framework.beforeCopyExtraFiles",
    computeIntegrity,
  );
  const flipFuses = packager.indexOf("await this.doAddElectronFuses(packContext)");
  const signPackage = packager.indexOf("await this.doSignAfterPack(");
  assert.equal(
    computeIntegrity >= 0
      && embedIntegrity > computeIntegrity
      && flipFuses > embedIntegrity
      && signPackage > flipFuses,
    true,
  );
  assert.match(packager, /fuses\.runAsNode/u);
  assert.match(packager, /fuses\.enableEmbeddedAsarIntegrityValidation/u);
  assert.match(packager, /fuses\.onlyLoadAppFromAsar/u);
});
