/**
 * The unpublished Windows installer boundary.
 *
 * This is deliberately a contract, not an electron-builder configuration.
 * The development builder remains directory-only and unsigned; a later native
 * Windows finalizer must map this exact contract to an NSIS build and then
 * prove the resulting installer.  Keep the values here closed and content-free
 * so an open or user-controlled shape cannot silently widen the release lane.
 */

export const WINDOWS_INSTALLER_CONTRACT_SCHEMA_VERSION =
  "tibotattle-windows-installer-contract-v1";
export const WINDOWS_INSTALLER_PLATFORM = "win32";
export const WINDOWS_INSTALLER_ARCHITECTURE = "x64";
export const WINDOWS_INSTALLER_APP_ID = "com.usagemonitor.local";
export const WINDOWS_INSTALLER_UPGRADE_GUID =
  "FDA705D7-5644-50E8-8CD2-3005D51B98C5";
export const WINDOWS_INSTALLER_PRODUCT_NAME = "TiboTattle";
export const WINDOWS_INSTALLER_ARTIFACT_NAME_TEMPLATE =
  "TiboTattle-{version}-Windows-x64.exe";

const WINDOWS_INSTALLER_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const WINDOWS_INSTALLER_GUID_PATTERN =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[1-5][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/u;
const WINDOWS_INSTALLER_ARTIFACT_NAME_PATTERN =
  /^TiboTattle-(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-Windows-x64\.exe$/u;

const WINDOWS_INSTALLER_CONTRACT_KEYS = Object.freeze([
  "schemaVersion",
  "platform",
  "architecture",
  "application",
  "installer",
  "dataRetention",
  "updater",
  "rollback",
  "publication",
]);
const WINDOWS_INSTALLER_APPLICATION_KEYS = Object.freeze([
  "productName",
  "appId",
  "upgradeGuid",
]);
const WINDOWS_INSTALLER_KEYS = Object.freeze([
  "target",
  "artifactFormat",
  "artifactNameTemplate",
  "oneClick",
  "perMachine",
  "allowElevation",
  "selectPerMachineByDefault",
  "allowToChangeInstallationDirectory",
  "runAfterFinish",
  "createDesktopShortcut",
  "createStartMenuShortcut",
  "deleteAppDataOnUninstall",
  "differentialPackage",
]);
const WINDOWS_INSTALLER_DATA_RETENTION_KEYS = Object.freeze([
  "ordinaryUninstall",
  "explicitPurge",
]);
const WINDOWS_INSTALLER_ORDINARY_UNINSTALL_KEYS = Object.freeze([
  "removesApplicationFiles",
  "preservesAppState",
  "preservesCredentialManager",
]);
const WINDOWS_INSTALLER_EXPLICIT_PURGE_KEYS = Object.freeze([
  "implemented",
  "status",
  "requiresExplicitConfirmation",
  "separateFromOrdinaryUninstall",
  "removesAppState",
  "removesCredentialManager",
  "credentialScope",
]);
const WINDOWS_INSTALLER_UPDATER_KEYS = Object.freeze([
  "enabled",
  "mechanism",
  "metadata",
]);
const WINDOWS_INSTALLER_ROLLBACK_KEYS = Object.freeze([
  "mode",
  "automaticDowngrade",
  "silentDowngrade",
  "selection",
  "verification",
  "confirmation",
  "identity",
  "state",
  "receipt",
  "rejection",
]);
const WINDOWS_INSTALLER_ROLLBACK_SELECTION_KEYS = Object.freeze([
  "required",
  "artifact",
]);
const WINDOWS_INSTALLER_ROLLBACK_VERIFICATION_KEYS = Object.freeze([
  "publisher",
  "signature",
  "digest",
]);
const WINDOWS_INSTALLER_ROLLBACK_CONFIRMATION_KEYS = Object.freeze([
  "required",
  "actor",
]);
const WINDOWS_INSTALLER_ROLLBACK_IDENTITY_KEYS = Object.freeze([
  "appId",
  "upgradeGuid",
  "match",
]);
const WINDOWS_INSTALLER_ROLLBACK_STATE_KEYS = Object.freeze([
  "backupBeforeReplacement",
  "retention",
]);
const WINDOWS_INSTALLER_ROLLBACK_RECEIPT_KEYS = Object.freeze([
  "required",
  "type",
]);
const WINDOWS_INSTALLER_ROLLBACK_REJECTION_KEYS = Object.freeze([
  "unsupported",
  "unsigned",
  "crossIdentity",
]);
const WINDOWS_INSTALLER_PUBLICATION_KEYS = Object.freeze([
  "enabled",
  "distribution",
]);

export class WindowsInstallerContractError extends Error {
  constructor() {
    super("Windows installer contract is invalid");
    this.name = "WindowsInstallerContractError";
    this.code = "windows_installer_contract_invalid";
  }
}

function fail() {
  throw new WindowsInstallerContractError();
}

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, expected) {
  if (!isPlainRecord(value)) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) return false;
  const sortedActual = actual.slice().sort();
  const sortedExpected = [...expected].sort();
  return sortedActual.length === sortedExpected.length
    && sortedActual.every((key, index) => key === sortedExpected[index]);
}

function requireExactValue(value, expected) {
  if (value !== expected) fail();
}

function requireSafeVersion(value) {
  if (typeof value !== "string"
      || value.length > 64
      || !WINDOWS_INSTALLER_VERSION_PATTERN.test(value)) {
    fail();
  }
}

function requireSafeText(value, pattern, maximumLength = 256) {
  if (typeof value !== "string"
      || value.length === 0
      || value.length > maximumLength
      || value.includes("\0")
      || !pattern.test(value)) {
    fail();
  }
}

function validateApplication(value) {
  if (!hasExactKeys(value, WINDOWS_INSTALLER_APPLICATION_KEYS)) fail();
  requireExactValue(value.productName, WINDOWS_INSTALLER_PRODUCT_NAME);
  requireExactValue(value.appId, WINDOWS_INSTALLER_APP_ID);
  requireExactValue(value.upgradeGuid, WINDOWS_INSTALLER_UPGRADE_GUID);
  requireSafeText(value.appId, /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/u, 128);
  requireSafeText(value.upgradeGuid, WINDOWS_INSTALLER_GUID_PATTERN, 36);
}

function validateInstaller(value) {
  if (!hasExactKeys(value, WINDOWS_INSTALLER_KEYS)) fail();
  requireExactValue(value.target, "nsis");
  requireExactValue(value.artifactFormat, "exe");
  requireExactValue(value.artifactNameTemplate, WINDOWS_INSTALLER_ARTIFACT_NAME_TEMPLATE);
  // The alternative assisted NSIS mode exposes an install-mode page.
  // One-click plus perMachine=false is the closed electron-builder path that
  // cannot select an all-users installation or require elevation.
  requireExactValue(value.oneClick, true);
  requireExactValue(value.perMachine, false);
  requireExactValue(value.allowElevation, false);
  requireExactValue(value.selectPerMachineByDefault, false);
  requireExactValue(value.allowToChangeInstallationDirectory, false);
  requireExactValue(value.runAfterFinish, false);
  requireExactValue(value.createDesktopShortcut, true);
  requireExactValue(value.createStartMenuShortcut, true);
  requireExactValue(value.deleteAppDataOnUninstall, false);
  requireExactValue(value.differentialPackage, false);
}

function validateDataRetention(value) {
  if (!hasExactKeys(value, WINDOWS_INSTALLER_DATA_RETENTION_KEYS)
      || !hasExactKeys(value.ordinaryUninstall, WINDOWS_INSTALLER_ORDINARY_UNINSTALL_KEYS)
      || !hasExactKeys(value.explicitPurge, WINDOWS_INSTALLER_EXPLICIT_PURGE_KEYS)) {
    fail();
  }
  requireExactValue(value.ordinaryUninstall.removesApplicationFiles, true);
  requireExactValue(value.ordinaryUninstall.preservesAppState, true);
  requireExactValue(value.ordinaryUninstall.preservesCredentialManager, true);
  requireExactValue(value.explicitPurge.implemented, false);
  requireExactValue(value.explicitPurge.status, "policy_only");
  requireExactValue(value.explicitPurge.requiresExplicitConfirmation, true);
  requireExactValue(value.explicitPurge.separateFromOrdinaryUninstall, true);
  requireExactValue(value.explicitPurge.removesAppState, true);
  requireExactValue(value.explicitPurge.removesCredentialManager, true);
  requireExactValue(
    value.explicitPurge.credentialScope,
    "application_owned_exact_capabilities",
  );
}

function validateUpdater(value) {
  if (!hasExactKeys(value, WINDOWS_INSTALLER_UPDATER_KEYS)) fail();
  requireExactValue(value.enabled, false);
  requireExactValue(value.mechanism, "none");
  requireExactValue(value.metadata, null);
}

function validateRollback(value) {
  if (!hasExactKeys(value, WINDOWS_INSTALLER_ROLLBACK_KEYS)
      || !hasExactKeys(value.selection, WINDOWS_INSTALLER_ROLLBACK_SELECTION_KEYS)
      || !hasExactKeys(value.verification, WINDOWS_INSTALLER_ROLLBACK_VERIFICATION_KEYS)
      || !hasExactKeys(value.confirmation, WINDOWS_INSTALLER_ROLLBACK_CONFIRMATION_KEYS)
      || !hasExactKeys(value.identity, WINDOWS_INSTALLER_ROLLBACK_IDENTITY_KEYS)
      || !hasExactKeys(value.state, WINDOWS_INSTALLER_ROLLBACK_STATE_KEYS)
      || !hasExactKeys(value.receipt, WINDOWS_INSTALLER_ROLLBACK_RECEIPT_KEYS)
      || !hasExactKeys(value.rejection, WINDOWS_INSTALLER_ROLLBACK_REJECTION_KEYS)) {
    fail();
  }
  requireExactValue(value.mode, "manual_only");
  requireExactValue(value.automaticDowngrade, false);
  requireExactValue(value.silentDowngrade, false);

  requireExactValue(value.selection.required, true);
  requireExactValue(value.selection.artifact, "explicitly_selected_previously_signed");

  requireExactValue(value.verification.publisher, "exact");
  requireExactValue(value.verification.signature, "authenticode_valid");
  requireExactValue(value.verification.digest, "sha256_exact");

  requireExactValue(value.confirmation.required, true);
  requireExactValue(value.confirmation.actor, "user_or_operator");

  requireExactValue(value.identity.appId, WINDOWS_INSTALLER_APP_ID);
  requireExactValue(value.identity.upgradeGuid, WINDOWS_INSTALLER_UPGRADE_GUID);
  requireExactValue(value.identity.match, "exact");

  requireExactValue(value.state.backupBeforeReplacement, true);
  requireExactValue(value.state.retention, "preserve_app_state");

  requireExactValue(value.receipt.required, true);
  requireExactValue(value.receipt.type, "native_installed_lifecycle");

  requireExactValue(value.rejection.unsupported, "fail_closed");
  requireExactValue(value.rejection.unsigned, "fail_closed");
  requireExactValue(value.rejection.crossIdentity, "fail_closed");
}

function validatePublication(value) {
  if (!hasExactKeys(value, WINDOWS_INSTALLER_PUBLICATION_KEYS)) fail();
  requireExactValue(value.enabled, false);
  requireExactValue(value.distribution, "unpublished");
}

function validateContractShape(value) {
  if (!hasExactKeys(value, WINDOWS_INSTALLER_CONTRACT_KEYS)) fail();
  requireExactValue(value.schemaVersion, WINDOWS_INSTALLER_CONTRACT_SCHEMA_VERSION);
  requireExactValue(value.platform, WINDOWS_INSTALLER_PLATFORM);
  requireExactValue(value.architecture, WINDOWS_INSTALLER_ARCHITECTURE);
  validateApplication(value.application);
  validateInstaller(value.installer);
  validateDataRetention(value.dataRetention);
  validateUpdater(value.updater);
  validateRollback(value.rollback);
  validatePublication(value.publication);
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const WINDOWS_INSTALLER_CONTRACT = deepFreeze({
  schemaVersion: WINDOWS_INSTALLER_CONTRACT_SCHEMA_VERSION,
  platform: WINDOWS_INSTALLER_PLATFORM,
  architecture: WINDOWS_INSTALLER_ARCHITECTURE,
  application: {
    productName: WINDOWS_INSTALLER_PRODUCT_NAME,
    appId: WINDOWS_INSTALLER_APP_ID,
    upgradeGuid: WINDOWS_INSTALLER_UPGRADE_GUID,
  },
  installer: {
    target: "nsis",
    artifactFormat: "exe",
    artifactNameTemplate: WINDOWS_INSTALLER_ARTIFACT_NAME_TEMPLATE,
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
  },
  dataRetention: {
    ordinaryUninstall: {
      removesApplicationFiles: true,
      preservesAppState: true,
      preservesCredentialManager: true,
    },
    explicitPurge: {
      implemented: false,
      status: "policy_only",
      requiresExplicitConfirmation: true,
      separateFromOrdinaryUninstall: true,
      removesAppState: true,
      removesCredentialManager: true,
      credentialScope: "application_owned_exact_capabilities",
    },
  },
  updater: {
    enabled: false,
    mechanism: "none",
    metadata: null,
  },
  rollback: {
    mode: "manual_only",
    automaticDowngrade: false,
    silentDowngrade: false,
    selection: {
      required: true,
      artifact: "explicitly_selected_previously_signed",
    },
    verification: {
      publisher: "exact",
      signature: "authenticode_valid",
      digest: "sha256_exact",
    },
    confirmation: {
      required: true,
      actor: "user_or_operator",
    },
    identity: {
      appId: WINDOWS_INSTALLER_APP_ID,
      upgradeGuid: WINDOWS_INSTALLER_UPGRADE_GUID,
      match: "exact",
    },
    state: {
      backupBeforeReplacement: true,
      retention: "preserve_app_state",
    },
    receipt: {
      required: true,
      type: "native_installed_lifecycle",
    },
    rejection: {
      unsupported: "fail_closed",
      unsigned: "fail_closed",
      crossIdentity: "fail_closed",
    },
  },
  publication: {
    enabled: false,
    distribution: "unpublished",
  },
});

export const WINDOWS_INSTALLER_ROLLBACK_POLICY = WINDOWS_INSTALLER_CONTRACT.rollback;

/**
 * Validate an exact Windows installer contract without echoing untrusted data.
 * The canonical exported contract is deeply frozen; callers validating a
 * deserialized copy should retain that copy only after this check succeeds.
 */
export function validateWindowsInstallerContract(value = WINDOWS_INSTALLER_CONTRACT) {
  try {
    validateContractShape(value);
    // Return the only trusted, deeply frozen representation. A validated
    // deserialized value is intentionally not promoted into a mutable policy
    // object merely because its current shape matched.
    return WINDOWS_INSTALLER_CONTRACT;
  } catch (error) {
    if (error instanceof WindowsInstallerContractError) throw error;
    fail();
  }
}

export function windowsInstallerArtifactFileName(version) {
  try {
    requireSafeVersion(version);
    return WINDOWS_INSTALLER_ARTIFACT_NAME_TEMPLATE.replace("{version}", version);
  } catch (error) {
    if (error instanceof WindowsInstallerContractError) throw error;
    fail();
  }
}

export function isWindowsInstallerArtifactFileName(value, version = null) {
  if (typeof value !== "string" || !WINDOWS_INSTALLER_ARTIFACT_NAME_PATTERN.test(value)) {
    return false;
  }
  if (version === null) return true;
  if (typeof version !== "string" || !WINDOWS_INSTALLER_VERSION_PATTERN.test(version)) {
    return false;
  }
  return value === windowsInstallerArtifactFileName(version);
}

export function assertWindowsInstallerArtifactFileName(value, version) {
  if (!isWindowsInstallerArtifactFileName(value, version)) fail();
  return value;
}

validateWindowsInstallerContract();
