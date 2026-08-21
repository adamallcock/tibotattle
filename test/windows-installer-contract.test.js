import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWindowsInstallerArtifactFileName,
  isWindowsInstallerArtifactFileName,
  WINDOWS_INSTALLER_ARTIFACT_NAME_TEMPLATE,
  WINDOWS_INSTALLER_CONTRACT,
  WINDOWS_INSTALLER_CONTRACT_SCHEMA_VERSION,
  WindowsInstallerContractError,
  validateWindowsInstallerContract,
  windowsInstallerArtifactFileName,
} from "../config/windows-installer-contract.js";

const INVALID_CODE = "windows_installer_contract_invalid";
const INVALID_MESSAGE = "Windows installer contract is invalid";

function cloneContract() {
  return structuredClone(WINDOWS_INSTALLER_CONTRACT);
}

function expectInvalid(value) {
  assert.throws(
    () => validateWindowsInstallerContract(value),
    (error) => error instanceof WindowsInstallerContractError
      && error.code === INVALID_CODE
      && error.message === INVALID_MESSAGE,
  );
}

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) assertDeepFrozen(child);
  }
}

test("canonical Windows installer contract is deeply frozen and exact", () => {
  assertDeepFrozen(WINDOWS_INSTALLER_CONTRACT);
  assert.equal(WINDOWS_INSTALLER_CONTRACT.schemaVersion,
    WINDOWS_INSTALLER_CONTRACT_SCHEMA_VERSION);
  assert.equal(WINDOWS_INSTALLER_CONTRACT.platform, "win32");
  assert.equal(WINDOWS_INSTALLER_CONTRACT.architecture, "x64");
  assert.deepEqual(WINDOWS_INSTALLER_CONTRACT.application, {
    productName: "TiboTattle",
    appId: "com.usagemonitor.local",
    // electron-builder 26.15.7's deterministic v5 GUID for the stable app ID.
    upgradeGuid: "FDA705D7-5644-50E8-8CD2-3005D51B98C5",
  });
  assert.deepEqual(WINDOWS_INSTALLER_CONTRACT.installer, {
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
  });
  assert.deepEqual(WINDOWS_INSTALLER_CONTRACT.dataRetention, {
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
  });
  assert.deepEqual(WINDOWS_INSTALLER_CONTRACT.updater, {
    enabled: false,
    mechanism: "none",
    metadata: null,
  });
  assert.deepEqual(WINDOWS_INSTALLER_CONTRACT.publication, {
    enabled: false,
    distribution: "unpublished",
  });
  assert.equal(validateWindowsInstallerContract(), WINDOWS_INSTALLER_CONTRACT);
  assert.equal(validateWindowsInstallerContract(cloneContract()), WINDOWS_INSTALLER_CONTRACT);
});

test("Windows installer artifact naming is deterministic and version-bound", () => {
  const name = windowsInstallerArtifactFileName("0.1.15");
  assert.equal(name, "TiboTattle-0.1.15-Windows-x64.exe");
  assert.equal(isWindowsInstallerArtifactFileName(name), true);
  assert.equal(isWindowsInstallerArtifactFileName(name, "0.1.15"), true);
  assert.equal(isWindowsInstallerArtifactFileName(name, "0.1.14"), false);
  assert.equal(isWindowsInstallerArtifactFileName("TiboTattle-0.1.15-Windows-x86.exe"), false);
  assert.equal(isWindowsInstallerArtifactFileName("C:\\Users\\tester\\TiboTattle-0.1.15-Windows-x64.exe"), false);
  assert.equal(assertWindowsInstallerArtifactFileName(name, "0.1.15"), name);
  assert.throws(
    () => windowsInstallerArtifactFileName("0.1.15/secret"),
    (error) => error.code === INVALID_CODE && error.message === INVALID_MESSAGE,
  );
  assert.throws(
    () => windowsInstallerArtifactFileName("0.1.16-beta.1"),
    (error) => error.code === INVALID_CODE && error.message === INVALID_MESSAGE,
  );
  assert.throws(
    () => assertWindowsInstallerArtifactFileName(name, "0.1.14"),
    (error) => error.code === INVALID_CODE && error.message === INVALID_MESSAGE,
  );
});

test("open, altered, and hostile installer contract shapes fail closed", () => {
  const open = cloneContract();
  open.unexpected = "C:\\Users\\tester\\secret";
  expectInvalid(open);

  const nestedOpen = cloneContract();
  nestedOpen.installer.unexpected = true;
  expectInvalid(nestedOpen);

  const perMachine = cloneContract();
  perMachine.installer.perMachine = true;
  expectInvalid(perMachine);

  const oneClick = cloneContract();
  oneClick.installer.oneClick = false;
  expectInvalid(oneClick);

  const purgeImplementation = cloneContract();
  purgeImplementation.dataRetention.explicitPurge.implemented = true;
  expectInvalid(purgeImplementation);

  const updater = cloneContract();
  updater.updater.enabled = true;
  expectInvalid(updater);

  const publication = cloneContract();
  publication.publication.enabled = true;
  expectInvalid(publication);

  expectInvalid(null);
  expectInvalid([]);
  expectInvalid(Object.create(null));

  const throwingGetter = cloneContract();
  Object.defineProperty(throwingGetter, "schemaVersion", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error("C:\\Users\\tester\\secret");
    },
  });
  expectInvalid(throwingGetter);

  const symbolKey = cloneContract();
  symbolKey[Symbol("unexpected")] = true;
  expectInvalid(symbolKey);
});

test("contract validation does not echo hostile values", () => {
  const hostile = cloneContract();
  hostile.unexpected = "password=secret-token-C:\\Users\\tester";
  assert.throws(
    () => validateWindowsInstallerContract(hostile),
    (error) => !error.message.includes("password")
      && !error.message.includes("secret-token")
      && !error.message.includes("C:\\Users\\tester")
      && error.code === INVALID_CODE,
  );
});
