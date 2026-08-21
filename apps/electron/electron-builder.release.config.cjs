const { readFileSync } = require("node:fs");
const path = require("node:path");

const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
const INVALID_CONFIG_CODE = "windows_release_builder_config_invalid";
const INVALID_CONFIG_MESSAGE = "Windows release builder configuration is invalid";
const RELEASE_TARGET_ENV = "TIBOTATTLE_ELECTRON_TARGET";
const RELEASE_MODE_ENV = "TIBOTATTLE_ELECTRON_SIGNING_MODE";
const RELEASE_VERSION_ENV = "TIBOTATTLE_ELECTRON_VERSION";
const RELEASE_SIGNING_MODE = "azure-trusted-signing";
const AZURE_PUBLISHER_ENV = "TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME";
const AZURE_ENDPOINT_ENV = "TIBOTATTLE_ELECTRON_AZURE_ENDPOINT";
const AZURE_ACCOUNT_ENV = "TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME";
const AZURE_PROFILE_ENV = "TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME";
// These values are supplied by the reviewed Azure Artifact Signing handoff.
// Keep them closed here: a syntactically valid but different resource must
// never silently redirect a production-shaped build to another signer.
const AZURE_EXPECTED_PUBLISHER = "Adam Allcock";
const AZURE_EXPECTED_ENDPOINT = "https://eus.codesigning.azure.net/";
const AZURE_EXPECTED_ACCOUNT = "tibotattlesigning";
const AZURE_EXPECTED_PROFILE = "tibotattle-windows-public";
const AZURE_EXPECTED_TIMESTAMP = "http://timestamp.acs.microsoft.com";
const WINDOWS_SIGNING_OPERATION_EVIDENCE_ROOT = path.join(
  REPOSITORY_ROOT,
  ".release-build/electron-production/windows-x64/evidence",
);
const WINDOWS_SIGNING_OPERATION_LEDGER_LEAF = "windows-signing-operation-ledger.json";
// TrustedSigning 0.5.0 uses DefaultAzureCredential.  Azure/login supplies
// the approved service-principal session through the Azure CLI cache; every
// other credential source is disabled explicitly.  ExcludeAzureCliCredential
// is intentionally absent so the two signing paths share one credential mode.
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
// Keep this list in lockstep with the protected finalizer policy.  These
// names must not be present in the builder process even when a developer or
// runner has them in its ambient environment.  The four TIBOTATTLE_ELECTRON_*
// resource variables below are the only Azure values intentionally passed to
// electron-builder.
const LEGACY_SIGNING_ENV_NAMES = new Set([
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
  "TIBOTATTLE_WINDOWS_PFX_PATH",
]);
const FORBIDDEN_SIGNING_ENVIRONMENT_PATTERNS = Object.freeze([
  /(?:^|_)(?:WIN_)?CSC(?:_|$)/u,
  /(?:^|_)(?:PFX|P12)(?:_|$)/u,
  /(?:^|_)(?:AZURE|ARM)_(?:CLIENT_SECRET|CLIENT_CERTIFICATE|FEDERATED_TOKEN)(?:_|$)/u,
]);
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PUBLISHER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,&()=+_-]{0,255}$/u;
const ENDPOINT_HOST_PATTERN = /^[a-z0-9-]+\.codesigning\.azure\.net$/u;

class WindowsReleaseBuilderConfigError extends Error {
  constructor() {
    super(INVALID_CONFIG_MESSAGE);
    this.name = "WindowsReleaseBuilderConfigError";
    this.code = INVALID_CONFIG_CODE;
  }
}

function fail() {
  throw new WindowsReleaseBuilderConfigError();
}

function hasEnvironmentVariable(name) {
  return Object.prototype.hasOwnProperty.call(process.env, name);
}

function hasForbiddenSigningEnvironment() {
  return Object.keys(process.env).some((key) => {
    const upperKey = key.toUpperCase();
    if (LEGACY_SIGNING_ENV_NAMES.has(upperKey)) return true;
    if (FORBIDDEN_SIGNING_ENVIRONMENT_PATTERNS.some((pattern) => pattern.test(upperKey))) {
      return true;
    }
    return false;
  });
}

function requireExactEnvironmentValue(name, expected) {
  if (!hasEnvironmentVariable(name) || process.env[name] !== expected) fail();
}

function requireStableVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) fail();
  return value;
}

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(
      readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
    );
    return requireStableVersion(packageJson.version);
  } catch (error) {
    if (error instanceof WindowsReleaseBuilderConfigError) throw error;
    fail();
  }
}

function requireSafeEnvironmentValue(name, pattern) {
  const value = process.env[name];
  if (!hasEnvironmentVariable(name)
      || typeof value !== "string"
      || value.length === 0
      || value.length > 256
      || value !== value.trim()
      || !pattern.test(value)) {
    fail();
  }
  return value;
}

function requireAzureEndpoint() {
  const value = process.env[AZURE_ENDPOINT_ENV];
  if (!hasEnvironmentVariable(AZURE_ENDPOINT_ENV)
      || typeof value !== "string"
      || value.length === 0
      || value.length > 256) {
    fail();
  }
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:"
        || endpoint.username !== ""
        || endpoint.password !== ""
        || endpoint.port !== ""
        || endpoint.pathname !== "/"
        || endpoint.search !== ""
        || endpoint.hash !== ""
        || !ENDPOINT_HOST_PATTERN.test(endpoint.hostname)) {
      fail();
    }
  } catch (error) {
    if (error instanceof WindowsReleaseBuilderConfigError) throw error;
    fail();
  }
  return value;
}

function requireExactAzureResource(name, expected, pattern) {
  const value = requireSafeEnvironmentValue(name, pattern);
  if (value !== expected) fail();
  return value;
}

function requireExactAzureEndpoint() {
  const value = requireAzureEndpoint();
  if (value !== AZURE_EXPECTED_ENDPOINT) fail();
  return value;
}

function readReleaseInputs() {
  if (hasForbiddenSigningEnvironment()) fail();
  requireExactEnvironmentValue(RELEASE_TARGET_ENV, "win32");
  requireExactEnvironmentValue(RELEASE_MODE_ENV, RELEASE_SIGNING_MODE);

  const packageVersion = readPackageVersion();
  requireExactEnvironmentValue(RELEASE_VERSION_ENV, packageVersion);

  return Object.freeze({
    packageVersion,
    publisherName: requireExactAzureResource(
      AZURE_PUBLISHER_ENV,
      AZURE_EXPECTED_PUBLISHER,
      PUBLISHER_NAME_PATTERN,
    ),
    endpoint: requireExactAzureEndpoint(),
    codeSigningAccountName: requireExactAzureResource(
      AZURE_ACCOUNT_ENV,
      AZURE_EXPECTED_ACCOUNT,
      RESOURCE_NAME_PATTERN,
    ),
    certificateProfileName: requireExactAzureResource(
      AZURE_PROFILE_ENV,
      AZURE_EXPECTED_PROFILE,
      RESOURCE_NAME_PATTERN,
    ),
  });
}

const RELEASE_INPUTS = readReleaseInputs();

// Keep this closure deliberately explicit and target-specific. The unsigned
// development configuration is a separate lane; importing and mutating it
// here would allow a future development edit to change the production input
// or signing boundary without a release-config review.
function createWindowsStagingFileClosure() {
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

function createWindowsAsarUnpackClosure() {
  return [
    "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
    "native/windows-filesystem/build/Release/windows_filesystem.node",
  ];
}

module.exports = {
  appId: "com.usagemonitor.local",
  productName: "TiboTattle",
  directories: {
    app: path.join(
      REPOSITORY_ROOT,
      ".release-build/electron-production/windows-x64/app",
    ),
    output: path.join(
      REPOSITORY_ROOT,
      ".release-build/electron-production/windows-x64/artifacts",
    ),
  },
  files: createWindowsStagingFileClosure(),
  asar: { smartUnpack: false },
  asarUnpack: createWindowsAsarUnpackClosure(),
  extraMetadata: {
    main: "apps/electron/main.js",
    name: "app-usagemonitor",
    productName: "TiboTattle",
    version: RELEASE_INPUTS.packageVersion,
  },
  forceCodeSigning: true,
  // The companion is intentionally spawned with ELECTRON_RUN_AS_NODE, so
  // RunAsNode must remain enabled until that architecture is replaced. The
  // other production fuses close environment/inspector and loose-app-code
  // entry points while enforcing electron-builder's embedded ASAR integrity.
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
  publish: "never",
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    signAndEditExecutable: true,
    signExecutable: true,
    // Foundation state: electron-builder is the only signer today. The
    // production finalizer must pre-sign and hash both native modules, then
    // remove `.node` here before it may mint an authority manifest; otherwise
    // this pass would mutate those recorded bytes a second time.
    // Native .node files are signed by the finalizer's fixed pre-sign pass.
    // electron-builder's negative extension rule keeps this packaging pass
    // from mutating the bytes that the authority manifest records.
    signExts: [".dll", "!.node"],
    requestedExecutionLevel: "asInvoker",
    verifyUpdateCodeSignature: true,
    // The pinned app-builder-lib patch emits one content-free, no-clobber
    // operation ledger here after the complete packaging/signing pass. Its
    // JSON contains only fixed extension classes and counts; the protected
    // finalizer binds it to this exact production output before promotion.
    windowsSigningOperationEvidenceRoot: WINDOWS_SIGNING_OPERATION_EVIDENCE_ROOT,
    windowsSigningOperationLedgerLeaf: WINDOWS_SIGNING_OPERATION_LEDGER_LEAF,
    azureSignOptions: {
      publisherName: RELEASE_INPUTS.publisherName,
      endpoint: RELEASE_INPUTS.endpoint,
      certificateProfileName: RELEASE_INPUTS.certificateProfileName,
      codeSigningAccountName: RELEASE_INPUTS.codeSigningAccountName,
      fileDigest: "SHA256",
      timestampRfc3161: AZURE_EXPECTED_TIMESTAMP,
      timestampDigest: "SHA256",
      ...TRUSTEDSIGNING_AZURE_CLI_ONLY_EXCLUSIONS,
    },
  },
  nsis: {
    guid: "FDA705D7-5644-50E8-8CD2-3005D51B98C5",
    artifactName: "TiboTattle-${version}-Windows-x64.${ext}",
    warningsAsErrors: true,
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
  },
};
