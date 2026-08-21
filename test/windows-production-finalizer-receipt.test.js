import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  WINDOWS_INSTALLER_ROLLBACK_POLICY,
} from "../config/windows-installer-contract.js";
import {
  WINDOWS_NATIVE_PRESIGN_MODULES,
  WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY,
  WINDOWS_NATIVE_PRESIGN_SCHEMA,
  WINDOWS_NATIVE_PRESIGN_STATUS,
  WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
  serializeWindowsNativePresignReceipt,
} from "../scripts/windows-native-presign.mjs";
import {
  WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST,
  WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_SCHEMA,
  WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS,
  WINDOWS_PRODUCTION_AUTHENTICODE_MAIN_EXECUTABLE,
  WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES,
  WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER,
  WINDOWS_PRODUCTION_AUTHENTICODE_FIXED_STATUS as AUTH_STATUS,
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
  WINDOWS_PRODUCTION_AUTHORITY_PROMOTED_CAPABILITIES,
  WINDOWS_PRODUCTION_AUTHORITY_UNAVAILABLE_CAPABILITIES,
  createWindowsProductionAuthorityManifest,
  serializeWindowsProductionAuthorityManifest,
} from "../src/platform/windows-production-authority-manifest.js";
import {
  WINDOWS_PRODUCTION_FINALIZER_RECEIPT_SCHEMA,
  WINDOWS_PRODUCTION_FINALIZER_RECEIPT_STATUS,
  FIXED_STATUS as STATUS,
  WindowsProductionFinalizerReceiptError,
  buildWindowsProductionFinalizerReceipt,
  buildWindowsProductionFinalizerReceiptForTest,
  parseWindowsProductionFinalizerReceiptForTest,
  serializeWindowsProductionFinalizerReceiptForTest,
  runWindowsProductionFinalizerReceiptForTest,
  runWindowsProductionFinalizerReceiptForProduction,
  writeWindowsProductionFinalizerReceiptForTest,
} from "../scripts/build-windows-production-finalizer-receipt.mjs";
import {
  WINDOWS_PRODUCTION_INSTALLER_SCHEMA,
  WINDOWS_PRODUCTION_INSTALLER_STATUS,
  serializeWindowsProductionInstallerReceipt,
} from "../scripts/verify-windows-production-installer.mjs";
import {
  serializeWindowsProductionPackagedArtifactReceipt,
  WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STATUS,
} from "../scripts/verify-windows-production-packaged-artifact.mjs";

const REVISION = "a".repeat(40);
const VERSION = "0.1.16";
const PUBLISHER = WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER;
const INSTALLER_NAME = `TiboTattle-${VERSION}-Windows-x64.exe`;
const INSTALLER_SHA = "9".repeat(64);
const INSTALLER_BYTES = 12345;
const AUTHORITY_HANDOFF_SHA = "b".repeat(64);
const MODULE0_UNSIGNED_SHA = "c".repeat(64);
const MODULE0_SIGNED_SHA = "d".repeat(64);
const MODULE1_SIGNED_SHA = "e".repeat(64);
const SOURCE_PACKAGE_SHA = "f".repeat(64);
const RUNTIME_SHA = "1".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function bytes(value) {
  return Buffer.from(value, "utf8");
}

function digestForPath(role, path, index) {
  if (role === "installer") return { bytes: INSTALLER_BYTES, sha256: INSTALLER_SHA };
  if (path === WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES[0].path) {
    return { bytes: 20, sha256: MODULE0_SIGNED_SHA };
  }
  if (path === WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES[1].path) {
    return { bytes: 21, sha256: MODULE1_SIGNED_SHA };
  }
  return { bytes: 100 + index, sha256: `${(index + 2).toString(16)}`.repeat(64) };
}

function inventoryDigest(rows) {
  const hash = createHash("sha256");
  let total = 0;
  for (const row of [...rows].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))) {
    total += row.bytes;
    hash.update(`F\0${row.role}\0${row.path}\0${row.bytes}\0${row.sha256}\0`);
  }
  return { bytes: total, count: rows.length, sha256: hash.digest("hex"), signedCount: rows.length };
}

function presignReceipt() {
  return {
    schemaVersion: WINDOWS_NATIVE_PRESIGN_SCHEMA,
    status: WINDOWS_NATIVE_PRESIGN_STATUS,
    target: "win32-x64",
    revision: REVISION,
    packageVersion: VERSION,
    qualificationHandoffSha256: AUTHORITY_HANDOFF_SHA,
    signingRequestPolicy: { ...WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY },
    modules: WINDOWS_NATIVE_PRESIGN_MODULES.map((module, index) => ({
      name: module.name,
      packagedPath: module.packagedPath,
      unsignedBytes: 10 + index,
      signedBytes: 20 + index,
      unsignedSha256: index === 0 ? MODULE0_UNSIGNED_SHA : WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
      signedSha256: index === 0 ? MODULE0_SIGNED_SHA : MODULE1_SIGNED_SHA,
      authenticode: {
        status: "Valid",
        publisher: PUBLISHER,
        signerThumbprint: `${index + 1}`.repeat(40),
        timestampPresent: true,
        policy: "authenticode-pa",
        signtoolPaValid: true,
      },
    })),
  };
}

function authorityFixture(presignHash) {
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
      sha256: SOURCE_PACKAGE_SHA,
    },
    sourceQualification: {
      workflow: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW,
      run: 100,
      runAttempt: 1,
      ref: WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
      revision: REVISION,
      handoff: { schemaVersion: WINDOWS_PRODUCTION_AUTHORITY_HANDOFF_SCHEMA, sha256: AUTHORITY_HANDOFF_SHA },
      binding: { bytes: 10, sha256: MODULE0_UNSIGNED_SHA },
      receipts: [
        {
          cacheMode: "warm",
          run: 100,
          runAttempt: 1,
          revision: REVISION,
          artifactId: 1,
          artifactDigest: `sha256:${"3".repeat(64)}`,
          rawReceiptSha256: "3".repeat(64),
        },
        {
          cacheMode: "clean",
          run: 100,
          runAttempt: 1,
          revision: REVISION,
          artifactId: 2,
          artifactDigest: `sha256:${"5".repeat(64)}`,
          rawReceiptSha256: "5".repeat(64),
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
    nativeModules: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES.map((module, index) => ({
      name: module.name,
      packagedPath: module.packagedPath,
      unsignedBytes: 10 + index,
      signedBytes: 20 + index,
      unsignedSha256: index === 0 ? MODULE0_UNSIGNED_SHA : WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
      signedSha256: index === 0 ? MODULE0_SIGNED_SHA : MODULE1_SIGNED_SHA,
    })),
    nativePresign: {
      receiptSha256: presignHash,
      schemaVersion: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_SCHEMA,
      status: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_STATUS,
      target: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_TARGET,
      revision: REVISION,
      packageVersion: VERSION,
      qualificationHandoffSha256: AUTHORITY_HANDOFF_SHA,
    },
    runtimeManifest: {
      packagedPath: WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
      bytes: 100,
      sha256: RUNTIME_SHA,
    },
    signerPolicy: { publisher: PUBLISHER, match: "exact" },
    promotedCapabilities: [...WINDOWS_PRODUCTION_AUTHORITY_PROMOTED_CAPABILITIES],
    unavailableCapabilities: [...WINDOWS_PRODUCTION_AUTHORITY_UNAVAILABLE_CAPABILITIES],
  });
}

function inventoryFixture() {
  const expected = [
    ["main-executable", WINDOWS_PRODUCTION_AUTHENTICODE_MAIN_EXECUTABLE],
    ...WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST.map((path) => ["electron-dll", path]),
    ["installer", INSTALLER_NAME],
    ...WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES.map(({ path }) => ["native-module", path]),
  ];
  const rows = expected.map(([role, path], index) => ({
    ...digestForPath(role, path, index),
    path,
    role,
  })).sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return {
    schemaVersion: WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_SCHEMA,
    status: WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS,
    target: "win32-x64",
    revision: REVISION,
    packageVersion: VERSION,
    publisher: PUBLISHER,
    probeMode: "injected",
    deferred: {
      reason: "uninstaller-authenticode-requires-installed-lifecycle",
      status: "deferred",
    },
    installer: { bytes: INSTALLER_BYTES, sha256: INSTALLER_SHA },
    files: rows,
    inventory: {
      ...inventoryDigest(rows),
      roles: {
        electronDlls: WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST.length,
        installer: 1,
        mainExecutable: 1,
        nativeModules: WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES.length,
        uninstaller: 0,
      },
    },
  };
}

function installerFixture(authorityBytes, inventoryBytes) {
  return {
    receiptSchemaVersion: WINDOWS_PRODUCTION_INSTALLER_SCHEMA,
    status: WINDOWS_PRODUCTION_INSTALLER_STATUS,
    target: "win32-x64",
    revision: REVISION,
    publisher: PUBLISHER,
    artifact: { format: "exe", name: INSTALLER_NAME, bytes: INSTALLER_BYTES, sha256: INSTALLER_SHA },
    authority: {
      bytes: authorityBytes.byteLength,
      sha256: sha256(authorityBytes),
      inventorySha256: sha256(inventoryBytes),
    },
    identity: {
      status: "policy_bound_not_inspected",
      productName: "TiboTattle",
      appId: "com.usagemonitor.local",
      upgradeGuid: "FDA705D7-5644-50E8-8CD2-3005D51B98C5",
    },
    signature: {
      required: true,
      source: "authenticode_inventory_native_windows",
      status: "verified",
    },
    staticConfig: {
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
    },
    lifecycle: { installed: "not_run", registry: "not_run", retention: "not_run", uninstaller: "not_run" },
    nativeProof: { status: "not_run" },
    rollback: WINDOWS_INSTALLER_ROLLBACK_POLICY,
    retention: { ordinaryUninstall: "not_run", explicitPurge: "policy_only" },
    publication: { enabled: false, distribution: "unpublished" },
  };
}

function packageFixture(authorityBytes, signingLedgerBytes, inventory) {
  const aggregate = (seed, count) => ({
    bytes: 1000 + seed,
    count,
    sha256: `${seed.toString(16)}`.repeat(64),
  });
  return {
    status: WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STATUS,
    target: "win32-x64",
    authority: { bytes: authorityBytes.byteLength, sha256: sha256(authorityBytes) },
    ledger: { bytes: signingLedgerBytes.byteLength, sha256: sha256(signingLedgerBytes) },
    peInventory: {
      bytes: inventory.inventory.bytes,
      count: inventory.inventory.count,
      sha256: inventory.inventory.sha256,
      signedCount: inventory.inventory.signedCount,
    },
    staged: aggregate(10, 12),
    asar: aggregate(11, 9),
    unpacked: aggregate(12, 2),
    nativeFileCount: 2,
  };
}

async function fixture(overrides = {}) {
  const presign = presignReceipt();
  const presignBytes = Buffer.from(serializeWindowsNativePresignReceipt(presign), "utf8");
  const authority = authorityFixture(sha256(presignBytes));
  const authorityBytes = Buffer.from(serializeWindowsProductionAuthorityManifest(authority), "utf8");
  const inventory = inventoryFixture();
  const inventoryBytes = Buffer.from(serializeWindowsProductionAuthenticodeInventoryReceipt(inventory), "utf8");
  const signingLedger = {
    schemaVersion: "tibotattle-windows-signing-operation-ledger-v1",
    status: "WINDOWS_SIGNING_OPERATION_LEDGER_RECORDED",
    builder: "app-builder-lib",
    builderVersion: "26.15.7",
    ledgerCount: 1,
    operationCount: 11,
    classes: { exe: 4, dll: 7, node: 0, unexpected: 0 },
  };
  const signingLedgerBytes = Buffer.from(`${JSON.stringify(signingLedger)}\n`, "utf8");
  const installer = installerFixture(authorityBytes, inventoryBytes);
  const installerBytes = Buffer.from(serializeWindowsProductionInstallerReceipt(installer), "utf8");
  const packaged = packageFixture(authorityBytes, signingLedgerBytes, inventory);
  const packagedBytes = Buffer.from(serializeWindowsProductionPackagedArtifactReceipt(packaged), "utf8");
  const value = {
    authorityBytes,
    nativePresignBytes: presignBytes,
    signingLedgerBytes,
    packagedArtifactBytes: packagedBytes,
    authenticodeInventoryBytes: inventoryBytes,
    installerBytes,
    ...overrides,
  };
  const parent = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-finalizer-receipt-")));
  const root = join(parent, "evidence");
  await mkdir(root, { mode: 0o700 });
  await Promise.all([
    writeFile(join(root, "authority.json"), authorityBytes, { mode: 0o600 }),
    writeFile(
      join(root, `windows-native-presign-${REVISION}.json`),
      presignBytes,
      { mode: 0o600 },
    ),
    writeFile(join(root, "windows-signing-operation-ledger.json"), signingLedgerBytes, { mode: 0o600 }),
    writeFile(join(root, "packaged-artifact-receipt.json"), packagedBytes, { mode: 0o600 }),
    writeFile(join(root, "authenticode-inventory.json"), inventoryBytes, { mode: 0o600 }),
    writeFile(join(root, "installer-receipt.json"), installerBytes, { mode: 0o600 }),
  ]);
  return {
    ...value,
    authority,
    presign,
    inventory,
    installer,
    packaged,
    signingLedger,
    parent,
    root,
  };
}

function runFinalizerCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "scripts/build-windows-production-finalizer-receipt.mjs"), ...args],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function expectCode(code) {
  return (error) => {
    assert.equal(error instanceof WindowsProductionFinalizerReceiptError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, "Windows production finalizer receipt join failed");
    return true;
  };
}

function options(value, overrides = {}) {
  return {
    authorityBytes: value.authorityBytes,
    nativePresignBytes: value.nativePresignBytes,
    signingLedgerBytes: value.signingLedgerBytes,
    packagedArtifactBytes: value.packagedArtifactBytes,
    authenticodeInventoryBytes: value.authenticodeInventoryBytes,
    installerBytes: value.installerBytes,
    ...overrides,
  };
}

test("joins canonical evidence into a frozen, content-free not-ready receipt", async () => {
  const value = await fixture();
  try {
    const receipt = await buildWindowsProductionFinalizerReceiptForTest(options(value));
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(receipt.schemaVersion, WINDOWS_PRODUCTION_FINALIZER_RECEIPT_SCHEMA);
    assert.equal(receipt.status, WINDOWS_PRODUCTION_FINALIZER_RECEIPT_STATUS);
    assert.equal(receipt.target, "win32-x64");
    assert.equal(receipt.revision, REVISION);
    assert.equal(receipt.packageVersion, VERSION);
    assert.equal(receipt.authenticode.receipt.probeMode, "injected");
    assert.deepEqual(receipt.installedLifecycle, {
      installed: "not_run",
      nativeProof: "not_run",
      registry: "not_run",
      retention: "not_run",
      status: "not_run",
      uninstaller: "not_run",
    });
    assert.deepEqual(receipt.production, { distribution: "unpublished", enabled: false, ready: false });
    const serialized = serializeWindowsProductionFinalizerReceiptForTest(receipt);
    const parsed = parseWindowsProductionFinalizerReceiptForTest(serialized);
    assert.deepEqual(parsed, receipt);
    assert.equal(serialized.includes(value.parent), false);
    assert.doesNotMatch(serialized, /(?:SignerCertificate|secret|password|diagnostic)/iu);
    assert.equal(serialized, serializeWindowsProductionFinalizerReceiptForTest(parsed));
  } finally {
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("is deterministic and independently hashes every raw subject", async () => {
  const value = await fixture();
  try {
    const first = await buildWindowsProductionFinalizerReceiptForTest(options(value));
    const second = await buildWindowsProductionFinalizerReceiptForTest(options(value));
    assert.equal(serializeWindowsProductionFinalizerReceiptForTest(first), serializeWindowsProductionFinalizerReceiptForTest(second));
    assert.equal(first.authority.sha256, sha256(value.authorityBytes));
    assert.equal(first.nativePresign.sha256, sha256(value.nativePresignBytes));
    assert.equal(first.signingLedger.sha256, sha256(value.signingLedgerBytes));
    assert.equal(first.packagedArtifact.sha256, sha256(value.packagedArtifactBytes));
    assert.equal(first.authenticode.sha256, sha256(value.authenticodeInventoryBytes));
    assert.equal(first.installer.sha256, sha256(value.installerBytes));
  } finally {
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("closed finalizer CLI runner joins fixed evidence leaves and publishes once", async () => {
  const value = await fixture();
  try {
    const result = await runWindowsProductionFinalizerReceiptForTest(value.root);
    const outputPath = join(value.root, "windows-production-finalizer-receipt.json");
    const output = await readFile(outputPath, "utf8");
    assert.equal(output, serializeWindowsProductionFinalizerReceiptForTest(result.receipt));
    assert.equal(result.publication.path, outputPath);
    await assert.rejects(
      runWindowsProductionFinalizerReceiptForTest(value.root),
      expectCode(STATUS.outputExists),
    );
  } finally {
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("zero-argument production CLI rejects caller-supplied paths", async () => {
  const result = await runFinalizerCli(["--evidence-root", "/tmp/redirected-evidence"]);
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${STATUS.inputInvalid}\n`);
});

test("rejects revision/version/authority/native/artifact/signature binding mismatches", async () => {
  const value = await fixture();
  try {
    const cases = [
      ["presign revision", "nativePresignBytes", (raw) => Buffer.from(raw.toString("utf8").replace(`\"revision\":\"${REVISION}\"`, `\"revision\":\"${"b".repeat(40)}\"`)), STATUS.mismatch],
      ["packaged authority", "packagedArtifactBytes", (raw) => Buffer.from(raw.toString("utf8").replace(sha256(value.authorityBytes), "6".repeat(64))), STATUS.mismatch],
      ["inventory publisher", "authenticodeInventoryBytes", (raw) => Buffer.from(raw.toString("utf8").replace(PUBLISHER, "Other Publisher")), STATUS.inventoryInvalid],
      ["installer artifact", "installerBytes", (raw) => Buffer.from(raw.toString("utf8").replace(INSTALLER_SHA, "7".repeat(64))), STATUS.mismatch],
      ["native signature", "nativePresignBytes", (raw) => Buffer.from(raw.toString("utf8").replace(PUBLISHER, "Other Publisher")), STATUS.presignInvalid],
    ];
    for (const [name, key, mutate, code] of cases) {
      await assert.rejects(
        buildWindowsProductionFinalizerReceiptForTest(options(value, { [key]: mutate(value[key]) })),
        expectCode(code),
        name,
      );
    }
  } finally {
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("requires native Windows Authenticode mode and rejects injected probe claims", async () => {
  const value = await fixture();
  try {
    const forgedNative = Buffer.from(value.authenticodeInventoryBytes.toString("utf8").replace("injected", "native-windows"));
    await assert.rejects(
      buildWindowsProductionFinalizerReceipt(options(value, { authenticodeInventoryBytes: forgedNative })),
      expectCode(STATUS.probeModeInvalid),
    );
    const injected = await buildWindowsProductionFinalizerReceiptForTest(options(value));
    assert.equal(injected.authenticode.receipt.probeMode, "injected");
  } finally {
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("rejects independently valid but spliced ledger and PE inventory subjects", async () => {
  const value = await fixture();
  try {
    const alternateLedger = {
      ...value.signingLedger,
      operationCount: 12,
      classes: { ...value.signingLedger.classes, exe: 5 },
    };
    const alternateLedgerBytes = Buffer.from(`${JSON.stringify(alternateLedger)}\n`, "utf8");
    await assert.rejects(
      buildWindowsProductionFinalizerReceiptForTest(
        options(value, { signingLedgerBytes: alternateLedgerBytes }),
      ),
      expectCode(STATUS.mismatch),
    );

    const alteredRows = value.inventory.files.map((row) => row.role === "main-executable"
      ? { ...row, bytes: row.bytes + 1, sha256: sha256(Buffer.from("independent-pe\n")) }
      : row);
    const alteredInventory = {
      ...value.inventory,
      files: alteredRows,
      inventory: {
        ...inventoryDigest(alteredRows),
        roles: { ...value.inventory.inventory.roles },
      },
    };
    const alteredInventoryBytes = Buffer.from(
      serializeWindowsProductionAuthenticodeInventoryReceipt(alteredInventory),
      "utf8",
    );
    const alteredInstaller = {
      ...value.installer,
      authority: {
        ...value.installer.authority,
        inventorySha256: sha256(alteredInventoryBytes),
      },
    };
    const alteredInstallerBytes = Buffer.from(
      serializeWindowsProductionInstallerReceipt(alteredInstaller),
      "utf8",
    );
    await assert.rejects(
      buildWindowsProductionFinalizerReceiptForTest(
        options(value, {
          authenticodeInventoryBytes: alteredInventoryBytes,
          installerBytes: alteredInstallerBytes,
        }),
      ),
      expectCode(STATUS.mismatch),
    );
  } finally {
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("production orchestration fails closed before trusting serialized native leaves", {
  skip: process.platform === "win32",
}, async () => {
  await assert.rejects(
    runWindowsProductionFinalizerReceiptForProduction(),
    (error) => error?.code === AUTH_STATUS.platformRequired,
  );
  await assert.rejects(
    runWindowsProductionFinalizerReceiptForProduction("/tmp/redirected"),
    expectCode(STATUS.inputInvalid),
  );
});

test("rejects duplicate keys, noncanonical subjects, extras, getters, proxies, and oversized bytes", async () => {
  const value = await fixture();
  try {
    const duplicate = Buffer.from(value.signingLedgerBytes.toString("utf8").replace(
      '"status":"WINDOWS_SIGNING_OPERATION_LEDGER_RECORDED",',
      '"status":"WINDOWS_SIGNING_OPERATION_LEDGER_RECORDED","status":"WINDOWS_SIGNING_OPERATION_LEDGER_RECORDED",',
    ));
    await assert.rejects(
      buildWindowsProductionFinalizerReceiptForTest(options(value, { signingLedgerBytes: duplicate })),
      expectCode(STATUS.ledgerNoncanonical),
    );
    await assert.rejects(
      buildWindowsProductionFinalizerReceiptForTest(options(value, { authorityBytes: Buffer.from(`${value.authorityBytes.toString("utf8")} `) })),
      expectCode(STATUS.authorityNoncanonical),
    );
    await assert.rejects(
      buildWindowsProductionFinalizerReceiptForTest({ ...options(value), extra: true }),
      expectCode(STATUS.inputInvalid),
    );
    const getter = options(value);
    Object.defineProperty(getter, "installerBytes", { enumerable: true, get() { return value.installerBytes; } });
    await assert.rejects(buildWindowsProductionFinalizerReceiptForTest(getter), expectCode(STATUS.inputInvalid));
    await assert.rejects(buildWindowsProductionFinalizerReceiptForTest(new Proxy(options(value), {})), expectCode(STATUS.inputInvalid));
    await assert.rejects(
      buildWindowsProductionFinalizerReceiptForTest(options(value, { signingLedgerBytes: Buffer.alloc(64 * 1024 + 1) })),
      expectCode(STATUS.inputInvalid),
    );
  } finally {
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("publishes transactionally with no clobber and cleans temporary files", async () => {
  const value = await fixture();
  try {
    const receipt = await buildWindowsProductionFinalizerReceiptForTest(options(value));
    const first = await writeWindowsProductionFinalizerReceiptForTest(value.root, receipt);
    assert.equal(first.bytes, Buffer.byteLength(serializeWindowsProductionFinalizerReceiptForTest(receipt)));
    await assert.rejects(
      writeWindowsProductionFinalizerReceiptForTest(value.root, receipt),
      expectCode(STATUS.outputExists),
    );
    const output = await readFile(join(value.root, "windows-production-finalizer-receipt.json"), "utf8");
    assert.equal(output, serializeWindowsProductionFinalizerReceiptForTest(receipt));
  } finally {
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("rejects links and detects root replacement during publication", async () => {
  const value = await fixture();
  try {
    const receipt = await buildWindowsProductionFinalizerReceiptForTest(options(value));
    const output = join(value.root, "windows-production-finalizer-receipt.json");
    const target = join(value.parent, "target");
    await writeFile(target, "target", { mode: 0o600 });
    await symlink(target, output);
    await assert.rejects(writeWindowsProductionFinalizerReceiptForTest(value.root, receipt), expectCode(STATUS.linkRejected));
    await rm(output, { force: true });
    await link(target, output);
    await assert.rejects(writeWindowsProductionFinalizerReceiptForTest(value.root, receipt), expectCode(STATUS.linkRejected));
    await rm(output, { force: true });
    await assert.rejects(
      writeWindowsProductionFinalizerReceiptForTest(value.root, receipt, null, {
        beforeOutputPublish: async () => {
          await rm(value.root, { recursive: true, force: true });
          await mkdir(value.root, { mode: 0o700 });
        },
        afterOutputPublish: undefined,
      }),
      expectCode(STATUS.rootReplaced),
    );
  } finally {
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("rejects malformed aggregate output and preserves explicit not-run lifecycle", async () => {
  const value = await fixture();
  try {
    const receipt = await buildWindowsProductionFinalizerReceiptForTest(options(value));
    const altered = JSON.parse(serializeWindowsProductionFinalizerReceiptForTest(receipt));
    altered.installedLifecycle.status = "passed";
    await assert.rejects(
      Promise.resolve().then(() => parseWindowsProductionFinalizerReceiptForTest(`${JSON.stringify(altered)}\n`)),
      expectCode(STATUS.receiptInvalid),
    );
    assert.equal(receipt.production.ready, false);
  } finally {
    await rm(value.parent, { recursive: true, force: true });
  }
});
