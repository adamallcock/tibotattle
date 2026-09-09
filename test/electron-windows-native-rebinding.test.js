import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { productionElectronCandidatePlan } from "../scripts/package-electron-production.mjs";
import { createWindowsFilesystemBindingManifest } from "../scripts/build-windows-filesystem-manifest.mjs";
import { WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS } from "../src/platform/windows-filesystem.js";
import { verifyStagedElectronRuntime } from "../scripts/build-electron-runtime.mjs";
import { createProductionDistributionMetadata } from "../apps/electron/desktop-updater.js";
import {
  inspectWindowsNativeRebinding, parseWindowsNativeRebindingArguments,
  prepareWindowsNativeRebinding, rebindWindowsNativeModules, rebindWindowsNativeModulesForTest,
  windowsNativeUnsignedContentDigest,
} from "../scripts/rebind-electron-windows-native-modules.mjs";
const FS = "native/windows-filesystem/build/Release/windows_filesystem.node";
const SIDECAR = `${FS}.manifest.json`;
const KEYTAR = "node_modules/@github/keytar/build/Release/keytar.node";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
function native() {
  return { ...Object.fromEntries(WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS.map((name) => [name, () => {}])),
    contractVersion: "windows-filesystem-v1", securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1", productionSafe: false,
    pathWalkRaceSafe: false, credentialMutexSafe: true, credentialAuditFileGuardSafe: true };
}
function pe(signed = false) {
  const bytes = Buffer.alloc(signed ? 536 : 512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(240, 84);
  bytes.writeUInt16LE(0x20b, 88);
  bytes.writeUInt32LE(16, 196);
  bytes[400] = 41;
  if (signed) {
    bytes.writeUInt32LE(42, 152); // PE checksum.
    bytes.writeUInt32LE(512, 232);
    bytes.writeUInt32LE(24, 236);
    bytes.fill(7, 512);
  }
  return bytes;
}
function payload(rows) {
  const digest = createHash("sha256");
  for (const row of rows) digest.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  return { bytes: rows.reduce((total, row) => total + row.bytes, 0), sha256: digest.digest("hex") };
}
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "windows-native-rebinding-"));
  const base = join(root, ".release-build/electron-production/win32-x64");
  const stage = join(base, "app");
  const candidate = { ...productionElectronCandidatePlan({ target: "win32-x64", sourceRevision: "a".repeat(40),
    buildNumber: "20260909", hostPlatform: "win32", hostArchitecture: "x64" }),
  status: "production_source_staged", stagedManifest: "app/package.json", runtimeManifest: "app/electron-runtime-manifest.json" };
  const candidateReceiptPath = join(base, "production-source-candidate.json");
  const files = new Map([[FS, pe()], [KEYTAR, pe()], [SIDECAR, Buffer.from(json(createWindowsFilesystemBindingManifest({ bytes: pe(), binding: native() })))],
    ["package.json", Buffer.from(json({ name: "app-usagemonitor", version: candidate.version,
      tibotattleDistribution: createProductionDistributionMetadata({ target: "win32-x64", buildNumber: candidate.buildNumber, sourceRevision: candidate.sourceRevision }) }))],
    ["apps/local/server.js", Buffer.from("export {};\n")]]);
  const rows = [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes),
    kind: path === "package.json" ? "runtime_metadata" : path === FS || path === SIDECAR ? "windows_native_binding"
      : path.startsWith("node_modules/") ? "third_party_dependency" : "companion_source" })).sort((a, b) => a.path < b.path ? -1 : 1);
  const manifest = { schemaVersion: "usage-monitor-electron-runtime-v0.1", target: "win32", architecture: "x64",
    releaseVersion: candidate.version, entrypoint: "apps/local/server.js", dashboardRoot: "apps/web/public", files: rows,
    payload: payload(rows), windowsBinding: { included: true, status: "included_unverified", verified: false,
      binding: { path: FS, bytes: pe().length, sha256: hash(pe()) }, manifest: { path: SIDECAR } } };
  try {
    for (const [path, bytes] of [...files, ["electron-runtime-manifest.json", json(manifest)]]) {
      await mkdir(dirname(join(stage, path)), { recursive: true }); await writeFile(join(stage, path), bytes);
    }
    await writeFile(candidateReceiptPath, json(candidate));
    const options = { candidateReceiptPath };
    const dependencies = { repositoryRoot: root, platform: "win32", architecture: "x64", version: "v26.2.0",
      verifySignature: async () => {}, loadBinding: () => native() };
    await run({ root, base, stage, manifest, options, dependencies, sign: async () => {
      await writeFile(join(stage, FS), pe(true)); await writeFile(join(stage, KEYTAR), pe(true));
    } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("native content digest permits Authenticode fields only and rejects malformed PE", () => {
  assert.equal(windowsNativeUnsignedContentDigest(pe()), windowsNativeUnsignedContentDigest(pe(true)));
  const altered = pe(true); altered[400] = 55;
  assert.notEqual(windowsNativeUnsignedContentDigest(altered), windowsNativeUnsignedContentDigest(pe()));
  const truncated = pe(true); truncated.writeUInt32LE(32, 236);
  assert.throws(() => windowsNativeUnsignedContentDigest(truncated), { code: "WINDOWS_NATIVE_REBIND_PE_INVALID" });
  assert.throws(() => windowsNativeUnsignedContentDigest(Buffer.alloc(512)), { code: "WINDOWS_NATIVE_REBIND_PE_INVALID" });
});
test("inspect does not write; prepare is no-clobber and binds exact candidate", async () => {
  await fixture(async ({ options, dependencies, base }) => {
    assert.equal((await inspectWindowsNativeRebinding(options, dependencies)).status, "original_stage_verified");
    await assert.rejects(readFile(join(base, "windows-native-rebinding/journal.json")), { code: "ENOENT" });
    await prepareWindowsNativeRebinding(options, dependencies);
    await assert.rejects(prepareWindowsNativeRebinding(options, dependencies), { code: "EEXIST" });
    await assert.rejects(prepareWindowsNativeRebinding({ candidateReceiptPath: join(base, "wrong.json") }, dependencies), { code: "WINDOWS_NATIVE_REBIND_CANDIDATE_PATH_INVALID" });
  });
});
test("rebinding changes only native rows, sidecar and payload; policy and replay remain stable", async () => {
  await fixture(async ({ options, dependencies, stage, manifest, sign }) => {
    await prepareWindowsNativeRebinding(options, dependencies); await sign();
    const receipt = await rebindWindowsNativeModulesForTest(options, dependencies);
    assert.equal(receipt.status, "native_integrity_rebound");
    assert.equal(receipt.windowsRuntimeQualification, "required");
    assert.equal(receipt.packagedArtifactVerification, "not_performed");
    assert.equal(receipt.signingAlgorithmPolicy, "not_verified");
    assert.equal(receipt.directoryDurability, "not_qualified");
    const result = await verifyStagedElectronRuntime({ output: stage, target: "win32-x64", version: manifest.releaseVersion });
    assert.equal(result.manifest.windowsBinding.verified, false);
    const sidecar = JSON.parse(await readFile(join(stage, SIDECAR), "utf8"));
    assert.equal(sidecar.approvedPolicy.productionSafe, false);
    assert.equal(sidecar.bindingProvenance.status, "unqualified");
    const unchanged = (rows) => rows.filter(({ path }) => ![FS, KEYTAR, SIDECAR].includes(path));
    assert.deepEqual(unchanged(result.manifest.files), unchanged(manifest.files));
    assert.deepEqual(await rebindWindowsNativeModulesForTest(options, dependencies), receipt);
  });
});
test("rebind resumes an interruption after sidecar replacement without new trust claims", async () => {
  await fixture(async ({ options, dependencies, stage, sign }) => {
    await prepareWindowsNativeRebinding(options, dependencies); await sign();
    const before = await readFile(join(stage, "electron-runtime-manifest.json"));
    await assert.rejects(rebindWindowsNativeModulesForTest(options, { ...dependencies,
      afterSidecar() { throw new Error("synthetic interruption"); } }), /synthetic interruption/);
    assert.deepEqual(await readFile(join(stage, "electron-runtime-manifest.json")), before);
    assert.equal((await rebindWindowsNativeModulesForTest(options, dependencies)).status, "native_integrity_rebound");
  });
});
test("rebind refuses native payload mutation, unrelated files, and unverified signatures before metadata writes", async () => {
  for (const fault of ["native", "extra", "signature", "policy"]) {
    await fixture(async ({ options, dependencies, stage, sign }) => {
      await prepareWindowsNativeRebinding(options, dependencies); await sign();
      const before = await readFile(join(stage, "electron-runtime-manifest.json"));
      if (fault === "native") { const changed = pe(true); changed[400]++; await writeFile(join(stage, KEYTAR), changed); }
      if (fault === "extra") await writeFile(join(stage, "extra.txt"), "unrecorded");
      if (fault === "signature") dependencies.verifySignature = () => { throw new Error("signature refused"); };
      if (fault === "policy") dependencies.loadBinding = () => ({ ...native(), productionSafe: true });
      await assert.rejects(rebindWindowsNativeModulesForTest(options, dependencies));
      assert.deepEqual(await readFile(join(stage, "electron-runtime-manifest.json")), before);
    });
  }
});
test("CLI defaults to inspection, rejects ambiguous mode, and native rebind refuses a foreign host", async () => {
  assert.equal(parseWindowsNativeRebindingArguments(["--candidate-receipt", "a.json"]).mode, "inspect");
  assert.equal(parseWindowsNativeRebindingArguments(["--prepare", "--candidate-receipt", "a.json"]).mode, "prepare");
  assert.throws(() => parseWindowsNativeRebindingArguments(["--rebind", "--prepare", "--candidate-receipt", "a.json"]));
  if (process.platform !== "win32") await assert.rejects(rebindWindowsNativeModules({}), { code: "WINDOWS_NATIVE_REBIND_NATIVE_WINDOWS_REQUIRED" });
});
test("rebinding refuses linked native files and a modified metadata journal before writing", async () => {
  for (const fault of ["symlink", "hardlink", "journal"]) {
    await fixture(async ({ options, dependencies, base, stage, sign }) => {
      await prepareWindowsNativeRebinding(options, dependencies); await sign();
      const before = await readFile(join(stage, "electron-runtime-manifest.json"));
      if (fault === "symlink") {
        await rm(join(stage, KEYTAR)); await symlink(join(stage, FS), join(stage, KEYTAR));
      } else if (fault === "hardlink") {
        await link(join(stage, KEYTAR), join(base, "foreign-hardlink.node"));
      } else {
        const path = join(base, "windows-native-rebinding/journal.json");
        const journal = JSON.parse(await readFile(path, "utf8"));
        journal.candidate.sourceRevision = "b".repeat(40);
        await writeFile(path, json(journal));
      }
      await assert.rejects(rebindWindowsNativeModulesForTest(options, dependencies));
      assert.deepEqual(await readFile(join(stage, "electron-runtime-manifest.json")), before);
    });
  }
});
