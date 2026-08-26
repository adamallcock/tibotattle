import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  WINDOWS_PRODUCTION_AUTHORITY_APP_ID,
  WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_EVENT,
  WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
  WINDOWS_PRODUCTION_AUTHORITY_HANDOFF_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS,
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_STATUS,
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_TARGET,
  WINDOWS_PRODUCTION_AUTHORITY_PRODUCT,
  WINDOWS_PRODUCTION_AUTHORITY_PROMOTED_CAPABILITIES,
  WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
  WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
  WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_NAME,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_PATH,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW,
  WINDOWS_PRODUCTION_AUTHORITY_UNAVAILABLE_CAPABILITIES,
  createWindowsProductionAuthorityManifest,
  serializeWindowsProductionAuthorityManifest,
} from "../src/platform/windows-production-authority-manifest.js";
import {
  WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST,
  WINDOWS_PRODUCTION_AUTHENTICODE_MAIN_EXECUTABLE,
  WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES,
} from "../scripts/verify-windows-production-authenticode-inventory.mjs";
import { windowsInstallerArtifactFileName } from "../config/windows-installer-contract.js";
import {
  WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS as STATUS,
  WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STATUS,
  WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_SIGNING_LEDGER_FILE,
  normalizeArchivePath,
  parseWindowsProductionPackagedArtifactReceipt,
  parseArguments,
  readArchive,
  runWindowsProductionPackagedArtifactForTest,
  serializeWindowsProductionPackagedArtifactReceipt,
  transformedPackageJsonBytes,
  verifyWindowsProductionPackagedArtifact,
  writeWindowsProductionPackagedArtifactReceiptForTest,
} from "../scripts/verify-windows-production-packaged-artifact.mjs";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { createTransformer: createBuilderTransformer } =
  appBuilderRequire("app-builder-lib/out/fileTransformer.js");
const asarModule = builderRequire("@electron/asar");
const asarTools = asarModule?.default ?? asarModule;
const PACKAGE_VERSION = "0.1.16";
const REVISION = "a".repeat(40);
const BINDING_PATH = "native/windows-filesystem/build/Release/windows_filesystem.node";
const SIDECAR_PATH = `${BINDING_PATH}.manifest.json`;
const KEYTAR_PATH = "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertNoPathLeak(value, root) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(text.includes(root), false);
  assert.equal(text.includes(JSON.stringify(root)), false);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function payloadDigest(rows) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of [...rows].sort((left, right) => left.path.localeCompare(right.path))) {
    bytes += row.bytes;
    hash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function bindingSidecar(bytes, { sha256Override = null } = {}) {
  return {
    schemaVersion: "windows-filesystem-binding-manifest-v1",
    bindingFile: "windows_filesystem.node",
    platform: "win32",
    architecture: "x64",
    bytes: bytes.byteLength,
    sha256: sha256Override ?? sha256(bytes),
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    sqliteStateLeaseContractVersion: "windows-sqlite-state-lease-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    companionInstanceMutexContractVersion: "windows-companion-instance-mutex-v1",
    preparedArtifactContractVersion: "windows-prepared-artifact-v1",
    requiredMethods: [
      "inspectPath",
      "ensureDirectory",
      "readFile",
      "readFileBounded",
      "createFile",
      "deleteFile",
      "replaceFile",
      "inspectProtectedChild",
      "readProtectedChild",
      "createProtectedChild",
      "deleteProtectedChild",
      "replaceProtectedChild",
      "acquireSqliteStateLease",
      "releaseSqliteStateLease",
      "acquireCredentialAuditFileGuard",
      "releaseCredentialAuditFileGuard",
      "acquireCredentialMutex",
      "releaseCredentialMutex",
      "acquireCompanionInstanceMutex",
      "releaseCompanionInstanceMutex",
      "inspectPreparedChild",
      "ensurePreparedDirectory",
      "enumeratePreparedDirectory",
      "removePreparedDirectory",
      "renamePreparedDirectory",
      "createPreparedFile",
      "readPreparedFile",
      "deletePreparedFile",
      "publishPreparedFile",
    ],
    nativeClaims: {
      productionSafe: false,
      pathWalkRaceSafe: false,
      credentialMutexSafe: true,
      companionInstanceMutexSafe: false,
      credentialAuditFileGuardSafe: true,
      sqliteStateLeaseSafe: false,
      preparedArtifactSafe: false,
    },
    approvedPolicy: {
      productionSafe: false,
      pathWalkRaceSafe: false,
      credentialMutexSafe: true,
      companionInstanceMutexSafe: false,
      credentialAuditFileGuardSafe: true,
      sqliteStateLeaseSafe: false,
      preparedArtifactSafe: false,
    },
    bindingProvenance: {
      contractVersion: "windows-binding-provenance-v1",
      status: "unqualified",
      source: "unsigned-development-binding",
    },
  };
}

function makeAuthority({ runtimeManifestBytes, binding, keytar, signedBinding, signedKeytar }) {
  const authority = {
    schemaVersion: WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA,
    status: WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS,
    product: WINDOWS_PRODUCTION_AUTHORITY_PRODUCT,
    appId: WINDOWS_PRODUCTION_AUTHORITY_APP_ID,
    packageVersion: PACKAGE_VERSION,
    platform: "win32",
    architecture: "x64",
    repository: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
    sourceRevision: REVISION,
    sourcePackage: {
      path: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_PATH,
      name: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_NAME,
      version: PACKAGE_VERSION,
      revision: REVISION,
      bytes: 123,
      sha256: "b".repeat(64),
    },
    sourceQualification: {
      workflow: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW,
      run: 123,
      runAttempt: 1,
      ref: WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
      revision: REVISION,
      handoff: {
        schemaVersion: WINDOWS_PRODUCTION_AUTHORITY_HANDOFF_SCHEMA,
        sha256: "c".repeat(64),
      },
      binding: { bytes: binding.byteLength, sha256: sha256(binding) },
      receipts: [
        {
          cacheMode: "warm",
          run: 123,
          runAttempt: 1,
          revision: REVISION,
          artifactId: 1,
          artifactDigest: `sha256:${"d".repeat(64)}`,
          rawReceiptSha256: "d".repeat(64),
        },
        {
          cacheMode: "clean",
          run: 123,
          runAttempt: 1,
          revision: REVISION,
          artifactId: 2,
          artifactDigest: `sha256:${"e".repeat(64)}`,
          rawReceiptSha256: "e".repeat(64),
        },
      ],
    },
    preparation: {
      handoff: { sha256: "6".repeat(64) },
      source: {
        ref: WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
        revision: REVISION,
        run: 123,
        runAttempt: 1,
        workflow: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW,
      },
      workflow: {
        path: WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
        ref: WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
        revision: REVISION,
        run: 456,
        runAttempt: 1,
      },
    },
    finalizer: {
      workflow: WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
      repository: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
      run: 456,
      runAttempt: 1,
      ref: WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
      event: WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_EVENT,
      headSha: REVISION,
      sourceRevision: REVISION,
    },
    nativeModules: [
      {
        name: "windows-filesystem",
        packagedPath: BINDING_PATH,
        unsignedBytes: binding.byteLength,
        signedBytes: signedBinding.byteLength,
        unsignedSha256: sha256(binding),
        signedSha256: sha256(signedBinding),
      },
      {
        name: "keytar",
        packagedPath: KEYTAR_PATH,
        unsignedBytes: keytar.byteLength,
        signedBytes: signedKeytar.byteLength,
        unsignedSha256: sha256(keytar),
        signedSha256: sha256(signedKeytar),
      },
    ],
    nativePresign: {
      receiptSha256: "f".repeat(64),
      schemaVersion: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_SCHEMA,
      status: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_STATUS,
      target: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_TARGET,
      revision: REVISION,
      packageVersion: PACKAGE_VERSION,
      qualificationHandoffSha256: "c".repeat(64),
      certificateSubjectSha256: "1".repeat(64),
    },
    runtimeManifest: {
      packagedPath: WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
      bytes: runtimeManifestBytes.byteLength,
      sha256: sha256(runtimeManifestBytes),
    },
    signerPolicy: { publisher: "Adam Allcock", match: "exact" },
    promotedCapabilities: [...WINDOWS_PRODUCTION_AUTHORITY_PROMOTED_CAPABILITIES],
    unavailableCapabilities: [...WINDOWS_PRODUCTION_AUTHORITY_UNAVAILABLE_CAPABILITIES],
  };
  return createWindowsProductionAuthorityManifest(authority);
}

async function writeRelative(root, path, bytes) {
  const destination = join(root, ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

async function waitForArchiveReady(asarPath, expectedRootBytes) {
  const archivePath = "package.json";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const actual = asarTools.extractFile(asarPath, archivePath, false);
      if (Buffer.compare(actual, expectedRootBytes) === 0) return;
    } catch {
      // @electron/asar 3.4.1 returns from createPackageWithOptions before its
      // write stream emits finish; retry until the fixture payload is stable.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fixture archive did not become ready");
}

async function makeFixture({
  packedNative = false,
  extraUnpacked = null,
  sidecarSha256Override = null,
  archiveLink = null,
  archiveRootBytes = null,
  archiveDependencyBytes = null,
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-production-artifact-")));
  const productionRoot = join(root, "production");
  const stagedPath = join(productionRoot, "app");
  const sourcePath = join(root, "source");
  const winUnpackedPath = join(productionRoot, "artifacts", "win-unpacked");
  const artifactsRoot = join(productionRoot, "artifacts");
  const evidenceRoot = join(productionRoot, "evidence");
  const resourcesPath = join(winUnpackedPath, "resources");
  const asarPath = join(resourcesPath, "app.asar");
  const unpackedPath = `${asarPath}.unpacked`;
  await Promise.all([
    mkdir(stagedPath, { recursive: true }),
    mkdir(sourcePath, { recursive: true }),
    mkdir(resourcesPath, { recursive: true }),
    mkdir(evidenceRoot, { recursive: true }),
  ]);
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
  const packageBytes = Buffer.from(`${JSON.stringify({
    name: "source-name",
    version: "0.0.1",
    private: true,
    type: "module",
    description: "fixture application",
    scripts: { test: "echo test" },
    keywords: ["fixture"],
    devDependencies: { fixture: "1.0.0" },
    _fixture: true,
    dist: { integrity: "sha512-fixture" },
  })}\n`);
  const dependencyPath = "node_modules/fixture-package/package.json";
  const dependencyBytes = Buffer.from(`${JSON.stringify({
    name: "fixture-package",
    version: "1.0.0",
    scripts: { test: "echo test" },
    keywords: ["fixture"],
    bugs: { url: "https://example.invalid/fixture" },
    dist: { integrity: "sha512-fixture" },
    _fixture: true,
    babel: { presets: [] },
    dependencies: { fixture: "1.0.0" },
    devDependencies: { devFixture: "1.0.0" },
  })}\n`);
  const transformedRootBytes = transformedPackageJsonBytes(packageBytes, {
    isMain: true,
    packageVersion: PACKAGE_VERSION,
  });
  const transformedDependencyBytes = transformedPackageJsonBytes(dependencyBytes, {
    isMain: false,
    packageVersion: PACKAGE_VERSION,
  });
  const binding = Buffer.from("unsigned Windows binding\n");
  const keytar = Buffer.from("unsigned keytar binding\n");
  const signedBinding = Buffer.from("signed Windows binding\n");
  const signedKeytar = Buffer.from("signed keytar binding\n");
  const sidecar = Buffer.from(`${JSON.stringify(
    bindingSidecar(binding, { sha256Override: sidecarSha256Override }),
    null,
    2,
  )}\n`);
  const files = [
    {
      kind: "runtime_metadata",
      path: "package.json",
      bytes: packageBytes,
    },
    {
      kind: "third_party_dependency",
      path: dependencyPath,
      bytes: dependencyBytes,
    },
    {
      kind: "windows_native_binding",
      path: BINDING_PATH,
      bytes: binding,
    },
    {
      kind: "windows_native_binding",
      path: SIDECAR_PATH,
      bytes: sidecar,
    },
    {
      kind: "third_party_dependency",
      path: KEYTAR_PATH,
      bytes: keytar,
    },
  ];
  const runtimeRows = files.map(({ kind, path, bytes }) => ({
    bytes: bytes.byteLength,
    kind,
    path,
    sha256: sha256(bytes),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const runtimeManifest = {
    schemaVersion: "usage-monitor-electron-runtime-v0.1",
    target: "win32",
    architecture: "x64",
    releaseVersion: PACKAGE_VERSION,
    entrypoint: "apps/electron/main.js",
    dashboardRoot: "apps/web/public",
    files: runtimeRows,
    payload: payloadDigest(runtimeRows),
    windowsBinding: {
      binding: {
        bytes: binding.byteLength,
        path: BINDING_PATH,
        sha256: sha256(binding),
      },
      included: true,
      manifest: { path: SIDECAR_PATH },
      status: "included_unverified",
      verified: false,
    },
  };
  const runtimeManifestBytes = Buffer.from(`${JSON.stringify(runtimeManifest, null, 2)}\n`);
  const authority = makeAuthority({
    runtimeManifestBytes,
    binding,
    keytar,
    signedBinding,
    signedKeytar,
  });
  const authorityBytes = Buffer.from(serializeWindowsProductionAuthorityManifest(authority));
  await writeFile(join(evidenceRoot, "authority.json"), authorityBytes, { mode: 0o600 });
  await writeFile(
    join(evidenceRoot, WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_SIGNING_LEDGER_FILE),
    signingLedgerBytes,
    { mode: 0o600 },
  );
  const stagedFiles = [
    { path: "package.json", bytes: packageBytes },
    { path: dependencyPath, bytes: dependencyBytes },
    { path: BINDING_PATH, bytes: signedBinding },
    { path: SIDECAR_PATH, bytes: sidecar },
    { path: KEYTAR_PATH, bytes: signedKeytar },
    { path: WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH, bytes: runtimeManifestBytes },
  ];
  const packageFiles = [
    { path: "package.json", bytes: archiveRootBytes ?? transformedRootBytes },
    { path: dependencyPath, bytes: archiveDependencyBytes ?? transformedDependencyBytes },
    { path: BINDING_PATH, bytes: signedBinding },
    { path: SIDECAR_PATH, bytes: sidecar },
    { path: KEYTAR_PATH, bytes: signedKeytar },
    { path: WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH, bytes: runtimeManifestBytes },
  ];
  await Promise.all([
    ...stagedFiles.map(({ path, bytes }) => writeRelative(stagedPath, path, bytes)),
    ...packageFiles.map(({ path, bytes }) => writeRelative(sourcePath, path, bytes)),
  ]);
  const peSubjects = [
    ["main-executable", WINDOWS_PRODUCTION_AUTHENTICODE_MAIN_EXECUTABLE],
    ...WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST.map((path) => ["electron-dll", path]),
    ["installer", windowsInstallerArtifactFileName(PACKAGE_VERSION)],
    ...WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES.map(({ path }) => ["native-module", path]),
  ];
  await Promise.all(peSubjects.map(([role, path]) => {
    const rootForSubject = role === "installer" ? artifactsRoot : winUnpackedPath;
    return writeRelative(
      rootForSubject,
      path,
      Buffer.from(`${role}:${path}\n`, "utf8"),
    );
  }));
  if (archiveLink) {
    await symlink("package.json", join(sourcePath, ...archiveLink.split("/")));
  }
  if (extraUnpacked) {
    await writeRelative(sourcePath, extraUnpacked, Buffer.from("extra native\n"));
  }
  await asarTools.createPackageWithOptions(sourcePath, asarPath, {
    unpack: packedNative ? undefined : "**/*.node",
  });
  await waitForArchiveReady(asarPath, archiveRootBytes ?? transformedRootBytes);
  await mkdir(unpackedPath, { recursive: true });
  if (extraUnpacked) {
    await writeRelative(unpackedPath, extraUnpacked, Buffer.from("extra native\n"));
  }
  return {
    root,
    productionRoot,
    evidenceRoot,
    stagedPath,
    winUnpackedPath,
    asarPath,
    unpackedPath,
    authorityBytes,
    signingLedgerBytes,
    signedBinding,
    packageBytes,
    dependencyBytes,
    transformedRootBytes,
    transformedDependencyBytes,
  };
}

async function withFixture(options, run) {
  const fixture = await makeFixture(options);
  try {
    return await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function verify(fixture) {
  return verifyWindowsProductionPackagedArtifact({
    authorityBytes: fixture.authorityBytes,
    signingLedgerBytes: fixture.signingLedgerBytes,
    stagedPath: fixture.stagedPath,
    winUnpackedPath: fixture.winUnpackedPath,
    asarPath: fixture.asarPath,
    unpackedPath: fixture.unpackedPath,
  });
}

function runVerifierCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "scripts/verify-windows-production-packaged-artifact.mjs"), ...args],
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

test("verifies signed staging plus app.asar.unpacked using authority native overlay", async () => {
  await withFixture({}, async (fixture) => {
    const result = await verify(fixture);
    assert.equal(result.status, WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STATUS);
    assert.equal(result.target, "win32-x64");
    assert.equal(result.nativeFileCount, 2);
    assert.equal(result.unpacked.count, 2);
    assert.equal(result.staged.count, 6);
    assert.equal(result.ledger.bytes, fixture.signingLedgerBytes.byteLength);
    assert.equal(result.ledger.sha256, sha256(fixture.signingLedgerBytes));
    assert.equal(result.peInventory.count, 10);
    assert.equal(result.peInventory.signedCount, 10);
    assertNoPathLeak(result, fixture.root);
    assert.deepEqual(Object.keys(result).sort(), [
      "asar",
      "authority",
      "ledger",
      "nativeFileCount",
      "peInventory",
      "staged",
      "status",
      "target",
      "unpacked",
    ].sort());
  });
});

test("closed production CLI runner reads fixed leaves and publishes a canonical receipt", async () => {
  await withFixture({}, async (fixture) => {
    const result = await runWindowsProductionPackagedArtifactForTest({
      productionRoot: fixture.productionRoot,
      stagingRoot: fixture.stagedPath,
      winUnpackedRoot: fixture.winUnpackedPath,
      evidenceRoot: fixture.evidenceRoot,
    });
    const receiptPath = join(fixture.evidenceRoot, "packaged-artifact-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.deepEqual(receipt, result);
    assert.equal(receipt.status, WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STATUS);
    assert.equal((await readFile(receiptPath, "utf8")).endsWith("\n"), true);
  });
});

test("packaged receipt owner enforces bounded canonical bytes", async () => {
  await withFixture({}, async (fixture) => {
    const result = await verify(fixture);
    const serialized = serializeWindowsProductionPackagedArtifactReceipt(result);
    assert.deepEqual(parseWindowsProductionPackagedArtifactReceipt(serialized), result);
    assert.throws(
      () => parseWindowsProductionPackagedArtifactReceipt(
        Buffer.from(serialized.replace("\"status\":\"WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_VERIFIED\",", "\"status\":\"WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_VERIFIED\",\"status\":\"WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_VERIFIED\",")),
      ),
      (error) => error.code === STATUS.receiptNoncanonical,
    );
    assert.throws(
      () => parseWindowsProductionPackagedArtifactReceipt(Buffer.from(`${serialized} `)),
      (error) => error.code === STATUS.receiptNoncanonical,
    );
  });
});

test("packaged receipt publication is no-clobber and detects an output race", async () => {
  await withFixture({}, async (fixture) => {
    const result = await verify(fixture);
    const target = join(fixture.root, "receipt-target");
    const output = join(fixture.evidenceRoot, "packaged-artifact-receipt.json");
    await writeFile(target, "foreign\n", { mode: 0o600 });
    await link(target, output);
    await assert.rejects(
      writeWindowsProductionPackagedArtifactReceiptForTest(fixture.evidenceRoot, result),
      (error) => error.code === STATUS.linkRejected,
    );
  });
  await withFixture({}, async (fixture) => {
    const result = await verify(fixture);
    const first = await writeWindowsProductionPackagedArtifactReceiptForTest(
      fixture.evidenceRoot,
      result,
    );
    assert.equal(first.bytes, (await readFile(first.path)).byteLength);
    await assert.rejects(
      writeWindowsProductionPackagedArtifactReceiptForTest(fixture.evidenceRoot, result),
      (error) => error.code === STATUS.outputExists,
    );
  });
  await withFixture({}, async (fixture) => {
    const result = await verify(fixture);
    await assert.rejects(
      writeWindowsProductionPackagedArtifactReceiptForTest(
        fixture.evidenceRoot,
        result,
        {
          beforeOutputPublish: async () => {
            await writeFile(
              join(fixture.evidenceRoot, "packaged-artifact-receipt.json"),
              "raced\n",
              { mode: 0o600 },
            );
          },
          afterOutputPublish: undefined,
        },
      ),
      (error) => error.code === STATUS.outputExists,
    );
    const temporary = (await readdir(fixture.evidenceRoot)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(temporary, []);
  });
  await withFixture({}, async (fixture) => {
    const result = await verify(fixture);
    await assert.rejects(
      writeWindowsProductionPackagedArtifactReceiptForTest(
        fixture.evidenceRoot,
        result,
        {
          beforeOutputPublish: async () => {
            await rm(fixture.evidenceRoot, { recursive: true, force: true });
            await mkdir(fixture.evidenceRoot, { mode: 0o700 });
          },
          afterOutputPublish: undefined,
        },
      ),
      (error) => error.code === STATUS.rootReplaced,
    );
  });
});

test("rejects an evidence junction on native Windows", {
  skip: process.platform !== "win32",
}, async () => {
  await withFixture({}, async (fixture) => {
    const result = await verify(fixture);
    const junction = join(fixture.root, "evidence-junction");
    await symlink(fixture.evidenceRoot, junction, "junction");
    await assert.rejects(
      writeWindowsProductionPackagedArtifactReceiptForTest(junction, result),
      (error) => error.code === STATUS.rootsInvalid,
    );
  });
});

test("binds ASAR inputs to the explicit win-unpacked resources pair", async () => {
  await withFixture({}, async (fixture) => {
    await assert.rejects(
      () => verify({ ...fixture, winUnpackedPath: undefined }),
      (error) => error.code === STATUS.inputInvalid,
    );
    const unrelatedAsar = join(fixture.root, "unrelated.asar");
    await writeFile(unrelatedAsar, await readFile(fixture.asarPath));
    await assert.rejects(
      () => verify({ ...fixture, asarPath: unrelatedAsar }),
      (error) => error.code === STATUS.inputInvalid,
    );
    const relocatedUnpacked = join(fixture.root, "relocated.unpacked");
    await mkdir(relocatedUnpacked);
    await assert.rejects(
      () => verify({ ...fixture, unpackedPath: relocatedUnpacked }),
      (error) => error.code === STATUS.inputInvalid,
    );
  });
});

test("matches the fixed electron-builder package-json transform for root and dependencies", async () => {
  await withFixture({}, async (fixture) => {
    const archivePath = (path) => process.platform === "win32" ? path.replaceAll("/", "\\") : path;
    const rootBytes = asarTools.extractFile(fixture.asarPath, archivePath("package.json"), false);
    const dependencyBytes = asarTools.extractFile(
      fixture.asarPath,
      archivePath("node_modules/fixture-package/package.json"),
      false,
    );
    assert.deepEqual(JSON.parse(rootBytes.toString("utf8")), {
      name: "app-usagemonitor",
      version: PACKAGE_VERSION,
      private: true,
      type: "module",
      description: "fixture application",
      main: "apps/electron/main.js",
      productName: "TiboTattle",
    });
    assert.deepEqual(JSON.parse(dependencyBytes.toString("utf8")), {
      name: "fixture-package",
      version: "1.0.0",
      dependencies: { fixture: "1.0.0" },
      devDependencies: { devFixture: "1.0.0" },
    });
    assert.deepEqual(rootBytes, fixture.transformedRootBytes);
    assert.deepEqual(dependencyBytes, fixture.transformedDependencyBytes);
  });
});

test("regresses the pinned app-builder-lib 26.15.7 transformer independently", async () => {
  await withFixture({}, async (fixture) => {
    assert.equal(appBuilderRequire("app-builder-lib/package.json").version, "26.15.7");
    const unchangedPath = "node_modules/unchanged-fixture/package.json";
    const unchangedBytes = Buffer.from(`${JSON.stringify({
      name: "unchanged-fixture",
      version: "1.0.0",
    })}\n`);
    await writeRelative(fixture.stagedPath, unchangedPath, unchangedBytes);

    const builderTransformer = createBuilderTransformer(
      fixture.stagedPath,
      {},
      {
        main: "apps/electron/main.js",
        name: "app-usagemonitor",
        productName: "TiboTattle",
        version: PACKAGE_VERSION,
      },
    );
    const builderRoot = await builderTransformer(join(fixture.stagedPath, "package.json"));
    const builderDependency = await builderTransformer(
      join(fixture.stagedPath, ..."node_modules/fixture-package/package.json".split("/")),
    );
    const builderUnchanged = await builderTransformer(
      join(fixture.stagedPath, ...unchangedPath.split("/")),
    );
    const expectedRoot = transformedPackageJsonBytes(fixture.packageBytes, {
      isMain: true,
      packageVersion: PACKAGE_VERSION,
    });
    const expectedDependency = transformedPackageJsonBytes(fixture.dependencyBytes, {
      isMain: false,
      packageVersion: PACKAGE_VERSION,
    });
    const expectedUnchanged = transformedPackageJsonBytes(unchangedBytes, {
      isMain: false,
      packageVersion: PACKAGE_VERSION,
    });
    assert.equal(builderRoot, expectedRoot.toString("utf8"));
    assert.equal(builderDependency, expectedDependency.toString("utf8"));
    assert.equal(builderUnchanged, null);
    assert.equal(expectedUnchanged, null);
  });
});

test("rejects package-json bytes outside the fixed builder transform", async () => {
  await withFixture({ archiveRootBytes: Buffer.from("{\"unexpected\":true}\n") }, async (fixture) => {
    await assert.rejects(() => verify(fixture), (error) => error.code === STATUS.inventoryMismatch);
  });
  await withFixture({ archiveDependencyBytes: Buffer.from("{\"unexpected\":true}\n") }, async (fixture) => {
    await assert.rejects(() => verify(fixture), (error) => error.code === STATUS.inventoryMismatch);
  });
});

test("rejects native hash drift, missing native rows, and extra unpacked rows", async () => {
  await withFixture({}, async (fixture) => {
    const bindingPath = join(fixture.stagedPath, ...BINDING_PATH.split("/"));
    await writeFile(bindingPath, Buffer.concat([fixture.signedBinding, Buffer.from("drift")]));
    await assert.rejects(() => verify(fixture), (error) => error.code === STATUS.stagedInventoryInvalid);
  });
  await withFixture({}, async (fixture) => {
    await rm(join(fixture.stagedPath, ...KEYTAR_PATH.split("/")));
    await assert.rejects(() => verify(fixture), (error) => error.code === STATUS.stagedInventoryInvalid);
  });
  await withFixture({ extraUnpacked: "relocated/extra.node" }, async (fixture) => {
    await assert.rejects(() => verify(fixture), (error) => error.code === STATUS.nativeMismatch);
  });
  await withFixture({}, async (fixture) => {
    const bindingPath = join(fixture.unpackedPath, ...BINDING_PATH.split("/"));
    await writeFile(bindingPath, Buffer.concat([fixture.signedBinding, Buffer.from("drift")]));
    await assert.rejects(() => verify(fixture), (error) => error.code === STATUS.nativeMismatch);
  });
  await withFixture({}, async (fixture) => {
    await rm(join(fixture.unpackedPath, ...KEYTAR_PATH.split("/")));
    await assert.rejects(() => verify(fixture), (error) => error.code === STATUS.nativeMismatch);
  });
  await withFixture({}, async (fixture) => {
    await writeRelative(
      fixture.unpackedPath,
      "NATIVE/windows-filesystem/build/Release/windows_filesystem.node",
      Buffer.from("case collision\n"),
    );
    await assert.rejects(() => verify(fixture), (error) => error.code === STATUS.nativeMismatch);
  });
  await withFixture({}, async (fixture) => {
    await writeRelative(
      fixture.stagedPath,
      "NATIVE/windows-filesystem/build/Release/windows_filesystem.node",
      Buffer.from("case collision\n"),
    );
    await assert.rejects(() => verify(fixture), (error) => error.code === STATUS.stagedInventoryInvalid);
  });
});

test("rejects a native payload inside app.asar", async () => {
  await withFixture({ packedNative: true }, async (fixture) => {
    await assert.rejects(() => verify(fixture), (error) => error.code === STATUS.nativeMismatch);
  });
});

test("rejects ASAR symlink entries without following their targets", {
  // The portable archive API can construct and expose this ASAR link case on
  // POSIX. Native Windows reparse-point qualification remains a separate gap.
  skip: process.platform === "win32",
}, async () => {
  await withFixture({ archiveLink: "linked-package.json" }, async (fixture) => {
    await assert.rejects(
      () => verify(fixture),
      (error) => error.code === STATUS.archiveInvalid,
    );
  });
});

test("rejects app.asar mutation between archive inspection phases", async () => {
  await withFixture({}, async (fixture) => {
    let mutated = false;
    const adapter = {
      listPackage(path) {
        const listed = asarTools.listPackage(path);
        appendFileSync(path, Buffer.from("archive mutation\n"));
        mutated = true;
        return listed;
      },
      statFile: (...args) => asarTools.statFile(...args),
      extractFile: (...args) => asarTools.extractFile(...args),
    };
    await assert.rejects(
      () => readArchive(fixture.asarPath, adapter),
      (error) => error.code === STATUS.archiveInvalid,
    );
    assert.equal(mutated, true);
  });
});

test("rejects sidecar/manifest disagreement", async () => {
  await withFixture({ sidecarSha256Override: "0".repeat(64) }, async (fixture) => {
    await assert.rejects(() => verify(fixture), (error) => error.code === STATUS.sidecarMismatch);
  });
});

test("rejects unsafe staged links", {
  skip: process.platform === "win32",
}, async () => {
  await withFixture({}, async (fixture) => {
    await symlink(fixture.stagedPath, join(fixture.root, "staged-alias"));
    await assert.rejects(
      () => verify({ ...fixture, stagedPath: join(fixture.root, "staged-alias") }),
      (error) => error.code === STATUS.inputInvalid,
    );
  });
});

test("rejects traversal and foreign-separator archive spellings", () => {
  for (const path of ["/../escape", "/foo//bar", "/foo\\bar", "/C:/drive-relative"]) {
    assert.throws(
      () => normalizeArchivePath(path),
      (error) => error.code === STATUS.archiveInvalid,
    );
  }
});

test("requires unique, known CLI flags including the fixed subject root", () => {
  assert.deepEqual(parseArguments([
    "--authority", "/tmp/authority.json",
    "--staged", "/tmp/staged",
    "--win-unpacked", "/tmp/win-unpacked",
    "--asar", "/tmp/win-unpacked/resources/app.asar",
    "--unpacked", "/tmp/win-unpacked/resources/app.asar.unpacked",
  ]), {
    authority: "/tmp/authority.json",
    stagedPath: "/tmp/staged",
    winUnpackedPath: "/tmp/win-unpacked",
    asarPath: "/tmp/win-unpacked/resources/app.asar",
    unpackedPath: "/tmp/win-unpacked/resources/app.asar.unpacked",
  });
  for (const argv of [
    ["--unknown", "value"],
    ["--authority", "/tmp/a", "--authority", "/tmp/b"],
    ["--authority", "/tmp/a", "--unpacked", "/tmp/u"],
  ]) {
    assert.throws(
      () => parseArguments(argv),
      (error) => error.code === STATUS.inputInvalid,
    );
  }
});

test("rejects malformed and oversized authority bytes", async () => {
  await withFixture({}, async (fixture) => {
    await assert.rejects(
      () => verify({ ...fixture, authorityBytes: Buffer.from("{") }),
      (error) => error.code === STATUS.authorityInvalid,
    );
    await assert.rejects(
      () => verify({ ...fixture, authorityBytes: Buffer.alloc(512 * 1024 + 1) }),
      (error) => error.code === STATUS.authorityInvalid,
    );
  });
});

test("keeps throwing getter and proxy options fixed and content-free", async () => {
  await withFixture({}, async (fixture) => {
    const getterOptions = {
      get authorityBytes() {
        throw new Error(fixture.root);
      },
      signingLedgerBytes: fixture.signingLedgerBytes,
      stagedPath: fixture.stagedPath,
      winUnpackedPath: fixture.winUnpackedPath,
      asarPath: fixture.asarPath,
      unpackedPath: fixture.unpackedPath,
    };
    await assert.rejects(
      () => verifyWindowsProductionPackagedArtifact(getterOptions),
      (error) => {
        assert.equal(error.code, STATUS.inputInvalid);
        assert.equal(error.message, "Windows production packaged artifact verification failed");
        assertNoPathLeak(error.message, fixture.root);
        return true;
      },
    );
    const proxyOptions = new Proxy({
      authorityBytes: fixture.authorityBytes,
      signingLedgerBytes: fixture.signingLedgerBytes,
      stagedPath: fixture.stagedPath,
      winUnpackedPath: fixture.winUnpackedPath,
      asarPath: fixture.asarPath,
      unpackedPath: fixture.unpackedPath,
    }, {
      get() {
        throw new Error(fixture.root);
      },
    });
    await assert.rejects(
      () => verifyWindowsProductionPackagedArtifact(proxyOptions),
      (error) => {
        assert.equal(error.code, STATUS.inputInvalid);
        assertNoPathLeak(error.message, fixture.root);
        return true;
      },
    );
  });
});

test("CLI failures emit only a fixed status and no input details", async () => {
  await withFixture({}, async (fixture) => {
    for (const args of [
      ["--unknown", fixture.root],
      ["--authority", fixture.root, "--authority", fixture.root],
    ]) {
      const result = await runVerifierCli(args);
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `${STATUS.inputInvalid}\n`);
      assertNoPathLeak(result.stdout, fixture.root);
      assertNoPathLeak(result.stderr, fixture.root);
    }
  });
});

test("rejects noncanonical or relocated authority native expectations", async () => {
  await withFixture({}, async (fixture) => {
    const text = fixture.authorityBytes.toString("utf8");
    await assert.rejects(
      () => verify({ ...fixture, authorityBytes: Buffer.from(`${text} `) }),
      (error) => error.code === STATUS.authorityNoncanonical,
    );
    const authority = JSON.parse(text);
    authority.nativeModules[0].packagedPath = "native/elsewhere.node";
    await assert.rejects(
      () => verify({
        ...fixture,
        authorityBytes: Buffer.from(`${JSON.stringify(stableValue(authority))}\n`),
      }),
      (error) => error.code === STATUS.authorityInvalid,
    );
  });
});
