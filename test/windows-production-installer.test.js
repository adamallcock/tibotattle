import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  WINDOWS_INSTALLER_CONTRACT,
  WINDOWS_INSTALLER_ROLLBACK_POLICY,
} from "../config/windows-installer-contract.js";
import {
  WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST,
  WINDOWS_PRODUCTION_AUTHENTICODE_MAIN_EXECUTABLE,
  WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES,
  WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER,
  buildWindowsProductionAuthenticodeInventory,
  serializeWindowsProductionAuthenticodeInventoryReceipt,
} from "../scripts/verify-windows-production-authenticode-inventory.mjs";
import {
  WINDOWS_PRODUCTION_AUTHORITY_APP_ID,
  WINDOWS_PRODUCTION_AUTHORITY_ARCHITECTURE,
  WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_EVENT,
  WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
  WINDOWS_PRODUCTION_AUTHORITY_HANDOFF_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS,
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES,
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_STATUS,
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_TARGET,
  WINDOWS_PRODUCTION_AUTHORITY_PRODUCT,
  WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
  WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
  WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_NAME,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_PATH,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW,
  WINDOWS_PRODUCTION_AUTHORITY_UNAVAILABLE_CAPABILITIES,
  WINDOWS_PRODUCTION_AUTHORITY_PROMOTED_CAPABILITIES,
  createWindowsProductionAuthorityManifest,
  serializeWindowsProductionAuthorityManifest,
} from "../src/platform/windows-production-authority-manifest.js";
import {
  FIXED_STATUS as STATUS,
  WINDOWS_PRODUCTION_INSTALLER_SCHEMA,
  WINDOWS_PRODUCTION_INSTALLER_STATUS,
  WindowsProductionInstallerError,
  parseWindowsProductionInstallerReceipt,
  serializeWindowsProductionInstallerReceipt,
  validateWindowsProductionInstallerReceipt,
  verifyWindowsProductionInstaller,
  writeWindowsProductionInstallerReceiptForTest,
} from "../scripts/verify-windows-production-installer.mjs";

const REVISION = "a".repeat(40);
const VERSION = "0.1.16";
const PUBLISHER = WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER;
const INSTALLER_NAME = `TiboTattle-${VERSION}-Windows-x64.exe`;
const INSTALLER_BYTES = Buffer.from("MZ deterministic NSIS installer fixture\n", "utf8");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function authorityFixture() {
  const binding = Buffer.from("windows-filesystem-unsigned\n", "utf8");
  const keytar = Buffer.from("keytar-unsigned\n", "utf8");
  const handoffSha = "b".repeat(64);
  const warmSha = "c".repeat(64);
  const cleanSha = "d".repeat(64);
  return createWindowsProductionAuthorityManifest({
    schemaVersion: WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA,
    status: WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS,
    product: WINDOWS_PRODUCTION_AUTHORITY_PRODUCT,
    appId: WINDOWS_PRODUCTION_AUTHORITY_APP_ID,
    packageVersion: VERSION,
    platform: "win32",
    architecture: WINDOWS_PRODUCTION_AUTHORITY_ARCHITECTURE,
    repository: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
    sourceRevision: REVISION,
    sourcePackage: {
      path: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_PATH,
      name: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_NAME,
      version: VERSION,
      revision: REVISION,
      bytes: 1000,
      sha256: "e".repeat(64),
    },
    sourceQualification: {
      workflow: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW,
      run: 100,
      runAttempt: 1,
      ref: WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
      revision: REVISION,
      handoff: { schemaVersion: WINDOWS_PRODUCTION_AUTHORITY_HANDOFF_SCHEMA, sha256: handoffSha },
      binding: { bytes: binding.byteLength, sha256: sha256(binding) },
      receipts: [
        {
          cacheMode: "warm",
          run: 100,
          runAttempt: 1,
          revision: REVISION,
          artifactId: 1,
          artifactDigest: `sha256:${warmSha}`,
          rawReceiptSha256: warmSha,
        },
        {
          cacheMode: "clean",
          run: 100,
          runAttempt: 1,
          revision: REVISION,
          artifactId: 2,
          artifactDigest: `sha256:${cleanSha}`,
          rawReceiptSha256: cleanSha,
        },
      ],
    },
    finalizer: {
      workflow: WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
      repository: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
      run: 101,
      runAttempt: 1,
      ref: WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
      event: WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_EVENT,
      headSha: REVISION,
      sourceRevision: REVISION,
    },
    nativeModules: [
      {
        name: "windows-filesystem",
        packagedPath: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES[0].packagedPath,
        unsignedBytes: binding.byteLength,
        signedBytes: binding.byteLength + 1,
        unsignedSha256: sha256(binding),
        signedSha256: "f".repeat(64),
      },
      {
        name: "keytar",
        packagedPath: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES[1].packagedPath,
        unsignedBytes: keytar.byteLength,
        signedBytes: keytar.byteLength + 1,
        unsignedSha256: sha256(keytar),
        signedSha256: "1".repeat(64),
      },
    ],
    nativePresign: {
      receiptSha256: "2".repeat(64),
      schemaVersion: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_SCHEMA,
      status: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_STATUS,
      target: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_TARGET,
      revision: REVISION,
      packageVersion: VERSION,
      qualificationHandoffSha256: handoffSha,
    },
    runtimeManifest: {
      packagedPath: WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
      bytes: 100,
      sha256: "3".repeat(64),
    },
    signerPolicy: { publisher: PUBLISHER, match: "exact" },
    promotedCapabilities: [...WINDOWS_PRODUCTION_AUTHORITY_PROMOTED_CAPABILITIES],
    unavailableCapabilities: [...WINDOWS_PRODUCTION_AUTHORITY_UNAVAILABLE_CAPABILITIES],
  });
}

function authProbe() {
  return {
    policy: "authenticode-pa",
    publisher: PUBLISHER,
    signtoolPaValid: true,
    status: "Valid",
    timestampPresent: true,
  };
}

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-installer-")));
  const productionRoot = join(parent, "production");
  const artifactsRoot = join(productionRoot, "artifacts");
  const winUnpackedRoot = join(artifactsRoot, "win-unpacked");
  const evidenceRoot = join(productionRoot, "evidence");
  await mkdir(winUnpackedRoot, { recursive: true, mode: 0o700 });
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const files = [
    ["main-executable", WINDOWS_PRODUCTION_AUTHENTICODE_MAIN_EXECUTABLE],
    ...WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST.map((path) => ["electron-dll", path]),
    ["installer", INSTALLER_NAME],
    ...WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES.map(({ path }) => ["native-module", path]),
  ];
  for (const [role, path] of files) {
    const absolute = role === "installer"
      ? join(artifactsRoot, path)
      : join(winUnpackedRoot, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(
      absolute,
      role === "installer" ? INSTALLER_BYTES : Buffer.from(`${role}:${path}\n`, "utf8"),
      { mode: 0o600 },
    );
  }
  const authority = authorityFixture();
  const authorityBytes = Buffer.from(serializeWindowsProductionAuthorityManifest(authority), "utf8");
  const injectedInventory = await buildWindowsProductionAuthenticodeInventory(
    { revision: REVISION, packageVersion: VERSION, publisher: PUBLISHER },
    {
      platform: "darwin",
      testOnly: true,
      testRoot: productionRoot,
      probe: async () => authProbe(),
    },
    {
      installerSha256: sha256(INSTALLER_BYTES),
      packageVersion: VERSION,
      publisher: PUBLISHER,
      revision: REVISION,
    },
  );
  const injectedInventoryBytes = Buffer.from(
    serializeWindowsProductionAuthenticodeInventoryReceipt(injectedInventory),
    "utf8",
  );
  // This is a closed serialized native-mode fixture for portable unit tests;
  // it does not establish local native Windows proof. The native Windows
  // workflow is the only producer allowed to emit native probe mode in reality.
  const inventory = {
    ...injectedInventory,
    probeMode: "native-windows",
  };
  const inventoryBytes = Buffer.from(
    serializeWindowsProductionAuthenticodeInventoryReceipt(inventory),
    "utf8",
  );
  return {
    parent,
    productionRoot,
    artifactsRoot,
    evidenceRoot,
    authority,
    authorityBytes,
    inventory,
    inventoryBytes,
    injectedInventoryBytes,
    async cleanup() {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error instanceof WindowsProductionInstallerError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, "Windows production installer verification failed");
    return true;
  };
}

function options(value, overrides = {}) {
  return {
    authorityBytes: value.authorityBytes,
    authenticodeInventoryBytes: value.inventoryBytes,
    testOnly: true,
    testRoot: value.productionRoot,
    ...overrides,
  };
}

test("verifies the exact deterministic installer and emits a closed deferred-lifecycle receipt", async () => {
  const value = await fixture();
  try {
    const receipt = await verifyWindowsProductionInstaller(options(value));
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(receipt.receiptSchemaVersion, WINDOWS_PRODUCTION_INSTALLER_SCHEMA);
    assert.equal(receipt.status, WINDOWS_PRODUCTION_INSTALLER_STATUS);
    assert.deepEqual(receipt.artifact, {
      bytes: INSTALLER_BYTES.byteLength,
      format: "exe",
      name: INSTALLER_NAME,
      sha256: sha256(INSTALLER_BYTES),
    });
    assert.deepEqual(receipt.identity, {
      status: "policy_bound_not_inspected",
      productName: "TiboTattle",
      appId: WINDOWS_INSTALLER_CONTRACT.application.appId,
      upgradeGuid: WINDOWS_INSTALLER_CONTRACT.application.upgradeGuid,
    });
    assert.deepEqual(receipt.staticConfig, {
      status: "policy_bound_not_inspected",
      target: "policy_only",
      artifactFormat: "policy_only",
      artifactName: "policy_only",
      oneClick: "policy_only",
      perMachine: "policy_only",
      allowElevation: "policy_only",
      architecture: "policy_only",
      productName: "policy_only",
      appId: "policy_only",
      upgradeGuid: "policy_only",
    });
    assert.deepEqual(receipt.lifecycle, {
      installed: "not_run",
      registry: "not_run",
      uninstaller: "not_run",
      retention: "not_run",
    });
    assert.deepEqual(receipt.nativeProof, { status: "not_run" });
    assert.deepEqual(receipt.retention, {
      ordinaryUninstall: "not_run",
      explicitPurge: "policy_only",
    });
    assert.deepEqual(receipt.publication, { enabled: false, distribution: "unpublished" });
    assert.equal(receipt.signature.source, "authenticode_inventory_native_windows");
    assert.deepEqual(receipt.rollback, WINDOWS_INSTALLER_ROLLBACK_POLICY);
    assert.equal(JSON.stringify(receipt).includes(value.parent), false);
    const serialized = serializeWindowsProductionInstallerReceipt(receipt);
    assert.equal(serialized.includes(value.parent), false);
    const parsed = parseWindowsProductionInstallerReceipt(serialized, {
      artifactBytes: INSTALLER_BYTES.byteLength,
      artifactSha256: sha256(INSTALLER_BYTES),
      authorityBytes: value.authorityBytes.byteLength,
      authoritySha256: sha256(value.authorityBytes),
      inventorySha256: sha256(value.inventoryBytes),
      packageVersion: VERSION,
      publisher: PUBLISHER,
      revision: REVISION,
    });
    assert.deepEqual(parsed, receipt);
    assert.equal(serializeWindowsProductionInstallerReceipt(parsed), serialized);
  } finally {
    await value.cleanup();
  }
});

test("binds authority, inventory signature row, and artifact bytes exactly", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      verifyWindowsProductionInstaller(options(value, {
        authenticodeInventoryBytes: value.injectedInventoryBytes,
      })),
      expectCode(STATUS.inventoryInvalid),
    );
    const alteredAuthority = { ...value.authority, packageVersion: "0.1.17" };
    const alteredAuthorityBytes = Buffer.from(stableJson(alteredAuthority), "utf8");
    await assert.rejects(
      verifyWindowsProductionInstaller(options(value, { authorityBytes: alteredAuthorityBytes })),
      expectCode(STATUS.authorityInvalid),
    );

    const alteredInventory = JSON.parse(value.inventoryBytes.toString("utf8"));
    alteredInventory.publisher = "Other Publisher";
    await assert.rejects(
      verifyWindowsProductionInstaller(options(value, {
        authenticodeInventoryBytes: Buffer.from(stableJson(alteredInventory), "utf8"),
      })),
      expectCode(STATUS.inventoryInvalid),
    );

    const missingSignature = JSON.parse(value.inventoryBytes.toString("utf8"));
    missingSignature.files = missingSignature.files.filter((row) => row.role !== "installer");
    await assert.rejects(
      verifyWindowsProductionInstaller(options(value, {
        authenticodeInventoryBytes: Buffer.from(stableJson(missingSignature), "utf8"),
      })),
      expectCode(STATUS.inventoryInvalid),
    );

    await writeFile(join(value.artifactsRoot, INSTALLER_NAME), Buffer.from("changed\n", "utf8"));
    await assert.rejects(
      verifyWindowsProductionInstaller(options(value)),
      expectCode(STATUS.bindingMismatch),
    );
  } finally {
    await value.cleanup();
  }
});

test("rejects caller paths, arbitrary roots, links, hardlinks, and hostile object shapes", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      verifyWindowsProductionInstaller({
        ...options(value),
        installerPath: join(value.artifactsRoot, INSTALLER_NAME),
      }),
      expectCode(STATUS.optionsInvalid),
    );
    await assert.rejects(
      verifyWindowsProductionInstaller({
        authorityBytes: value.authorityBytes,
        authenticodeInventoryBytes: value.inventoryBytes,
        testRoot: value.productionRoot,
      }),
      expectCode(STATUS.optionsInvalid),
    );
    const proxied = new Proxy(options(value), {});
    await assert.rejects(verifyWindowsProductionInstaller(proxied), expectCode(STATUS.optionsInvalid));
    const accessor = options(value);
    Object.defineProperty(accessor, "testRoot", {
      enumerable: true,
      configurable: true,
      get() {
        return value.productionRoot;
      },
    });
    await assert.rejects(verifyWindowsProductionInstaller(accessor), expectCode(STATUS.optionsInvalid));

    const installerPath = join(value.artifactsRoot, INSTALLER_NAME);
    const moved = join(value.artifactsRoot, `${INSTALLER_NAME}.moved`);
    await rename(installerPath, moved);
    await symlink(`${INSTALLER_NAME}.moved`, installerPath);
    await assert.rejects(
      verifyWindowsProductionInstaller(options(value)),
      expectCode(STATUS.linkRejected),
    );
    await rm(installerPath, { force: true });
    await rename(moved, installerPath);

    const hardlinked = join(value.artifactsRoot, `${INSTALLER_NAME}.hardlink`);
    await link(installerPath, hardlinked);
    await assert.rejects(
      verifyWindowsProductionInstaller(options(value)),
      expectCode(STATUS.linkRejected),
    );
    await rm(hardlinked, { force: true });

    const rootLink = join(value.parent, "root-link");
    await symlink(value.productionRoot, rootLink);
    await assert.rejects(
      verifyWindowsProductionInstaller(options(value, { testRoot: rootLink })),
      expectCode(STATUS.rootsInvalid),
    );
    await rm(rootLink, { force: true });
  } finally {
    await value.cleanup();
  }
});

test("rejects duplicate or noncanonical evidence and receipt JSON", async () => {
  const value = await fixture();
  try {
    const authorityText = value.authorityBytes.toString("utf8");
    await assert.rejects(
      verifyWindowsProductionInstaller(options(value, {
        authorityBytes: Buffer.from(`${authorityText.trimEnd()}\n${authorityText}`, "utf8"),
      })),
      expectCode(STATUS.authorityInvalid),
    );
    const receipt = await verifyWindowsProductionInstaller(options(value));
    const serialized = serializeWindowsProductionInstallerReceipt(receipt);
    assert.throws(
      () => parseWindowsProductionInstallerReceipt(`${serialized} `),
      expectCode(STATUS.receiptNoncanonical),
    );
    const duplicate = serialized.replace(
      `"status":"${WINDOWS_PRODUCTION_INSTALLER_STATUS}"`,
      `"status":"${WINDOWS_PRODUCTION_INSTALLER_STATUS}","status":"${WINDOWS_PRODUCTION_INSTALLER_STATUS}"`,
    );
    assert.throws(
      () => parseWindowsProductionInstallerReceipt(duplicate),
      expectCode(STATUS.receiptNoncanonical),
    );
    const tampered = JSON.parse(serialized);
    tampered.rollback.mode = "automatic";
    assert.throws(
      () => validateWindowsProductionInstallerReceipt(tampered),
      expectCode(STATUS.receiptInvalid),
    );
  } finally {
    await value.cleanup();
  }
});

test("publishes receipt transactionally without clobbering and cleans temporary files", async () => {
  const value = await fixture();
  try {
    const receipt = await verifyWindowsProductionInstaller(options(value));
    const output = await writeWindowsProductionInstallerReceiptForTest(
      value.evidenceRoot,
      receipt,
    );
    assert.equal(output.bytes, Buffer.byteLength(serializeWindowsProductionInstallerReceipt(receipt)));
    assert.equal((await lstat(join(value.evidenceRoot, "installer-receipt.json"))).nlink, 1);
    const original = await readFile(join(value.evidenceRoot, "installer-receipt.json"), "utf8");
    assert.equal(original, serializeWindowsProductionInstallerReceipt(receipt));
    await assert.rejects(
      writeWindowsProductionInstallerReceiptForTest(value.evidenceRoot, receipt),
      expectCode(STATUS.outputExists),
    );
    const tempFiles = await readdir(value.evidenceRoot);
    assert.deepEqual(tempFiles.filter((name) => name.endsWith(".tmp")), []);
    await rm(join(value.evidenceRoot, "installer-receipt.json"), { force: true });
    await assert.rejects(
      writeWindowsProductionInstallerReceiptForTest(value.evidenceRoot, receipt, "before-publish"),
      expectCode(STATUS.outputInvalid),
    );
    assert.deepEqual(
      (await readdir(value.evidenceRoot)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await value.cleanup();
  }
});

test("test-only replacement hooks fail closed and preserve ownership-aware cleanup", async () => {
  const value = await fixture();
  const receipt = await verifyWindowsProductionInstaller(options(value));
  const installerPath = join(value.artifactsRoot, INSTALLER_NAME);
  try {
    const movedRoot = join(value.parent, "production-replaced");
    await assert.rejects(
      verifyWindowsProductionInstaller(options(value, {
        testHooks: {
          beforeArtifactRootRecheck: async () => {
            await rename(value.productionRoot, movedRoot);
          },
        },
      })),
      expectCode(STATUS.rootReplaced),
    );
    await rename(movedRoot, value.productionRoot);

    const movedBeforeOpen = join(value.artifactsRoot, `${INSTALLER_NAME}.before-open`);
    await assert.rejects(
      verifyWindowsProductionInstaller(options(value, {
        testHooks: {
          beforeArtifactOpen: async () => {
            await rename(installerPath, movedBeforeOpen);
            await writeFile(installerPath, Buffer.from("replacement-before-open\n", "utf8"));
          },
        },
      })),
      expectCode(STATUS.fileReplaced),
    );
    await rm(installerPath, { force: true });
    await rename(movedBeforeOpen, installerPath);

    const movedBeforeFinal = join(value.artifactsRoot, `${INSTALLER_NAME}.before-final`);
    await assert.rejects(
      verifyWindowsProductionInstaller(options(value, {
        testHooks: {
          beforeArtifactFinalPathCheck: async () => {
            await rename(installerPath, movedBeforeFinal);
            await writeFile(installerPath, Buffer.from("replacement-before-final\n", "utf8"));
          },
        },
      })),
      expectCode(STATUS.fileReplaced),
    );
    await rm(installerPath, { force: true });
    await rename(movedBeforeFinal, installerPath);

    const outputPath = join(value.evidenceRoot, "installer-receipt.json");
    const symlinkTarget = join(value.parent, "receipt-target");
    await writeFile(symlinkTarget, "target\n", "utf8");
    await symlink(symlinkTarget, outputPath);
    await assert.rejects(
      writeWindowsProductionInstallerReceiptForTest(value.evidenceRoot, receipt),
      expectCode(STATUS.linkRejected),
    );
    await rm(outputPath, { force: true });

    const hardlinkTarget = join(value.parent, "receipt-hardlink-target");
    await writeFile(hardlinkTarget, "target\n", "utf8");
    await link(hardlinkTarget, outputPath);
    await assert.rejects(
      writeWindowsProductionInstallerReceiptForTest(value.evidenceRoot, receipt),
      expectCode(STATUS.linkRejected),
    );
    await rm(outputPath, { force: true });

    const beforePublishTarget = join(value.parent, "receipt-before-publish-target");
    await assert.rejects(
      writeWindowsProductionInstallerReceiptForTest(
        value.evidenceRoot,
        receipt,
        null,
        {
          beforeOutputPublish: async () => {
            await writeFile(beforePublishTarget, "target\n", "utf8");
            await symlink(beforePublishTarget, outputPath);
          },
        },
      ),
      (error) => error instanceof WindowsProductionInstallerError
        && (error.code === STATUS.outputExists || error.code === STATUS.linkRejected),
    );
    await rm(outputPath, { force: true });
    await rm(beforePublishTarget, { force: true });

    const afterPublishTarget = join(value.parent, "receipt-after-publish-target");
    await assert.rejects(
      writeWindowsProductionInstallerReceiptForTest(
        value.evidenceRoot,
        receipt,
        null,
        {
          afterOutputPublish: async () => {
            await rm(outputPath, { force: true });
            await writeFile(afterPublishTarget, "target\n", "utf8");
            await symlink(afterPublishTarget, outputPath);
          },
        },
      ),
      expectCode(STATUS.outputInvalid),
    );
    assert.deepEqual(
      (await readdir(value.evidenceRoot)).filter((name) => name.endsWith(".tmp")),
      [],
    );
    await rm(outputPath, { force: true });
    await rm(afterPublishTarget, { force: true });
  } finally {
    await rm(installerPath, { force: true });
    const movedBeforeOpen = join(value.artifactsRoot, `${INSTALLER_NAME}.before-open`);
    const movedBeforeFinal = join(value.artifactsRoot, `${INSTALLER_NAME}.before-final`);
    if (!(await lstat(installerPath).catch(() => null))) {
      const backup = await lstat(movedBeforeFinal).catch(() => null)
        ? movedBeforeFinal
        : movedBeforeOpen;
      if (await lstat(backup).catch(() => null)) await rename(backup, installerPath);
    }
    await value.cleanup();
  }
});

test("native Windows rejects an artifacts directory junction before installer access", {
  skip: process.platform !== "win32",
}, async () => {
  const value = await fixture();
  const artifactsPath = value.artifactsRoot;
  const movedPath = join(value.productionRoot, "artifacts-real");
  try {
    await rename(artifactsPath, movedPath);
    await symlink(movedPath, artifactsPath, "junction");
    await assert.rejects(
      verifyWindowsProductionInstaller(options(value)),
      (error) => error instanceof WindowsProductionInstallerError
        && (error.code === STATUS.rootsInvalid || error.code === STATUS.linkRejected),
    );
  } finally {
    await rm(artifactsPath, { recursive: true, force: true });
    await rename(movedPath, artifactsPath).catch(() => {});
    await value.cleanup();
  }
});
