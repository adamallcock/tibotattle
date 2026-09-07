import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  finalizeElectronMacOSUpdateMetadata,
  parseElectronMacOSMetadataFinalizationArguments,
} from "../scripts/finalize-electron-macos-update-metadata.mjs";
import { productionElectronCandidatePlan } from "../scripts/package-electron-production.mjs";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const { buildBlockMap } = builderRequire("app-builder-lib/out/targets/blockmap/blockmap.js");
const yaml = builderRequire("js-yaml");
const SOURCE_REVISION = "a".repeat(40);
const BUILD_NUMBER = "2026090701";
const CURRENT_VERSION = "0.1.19-native-to-electron-handover.1";
const NEXT_VERSION = "0.1.19-native-to-electron-handover.2";
const TRANSPORT_MANIFEST = "native-to-electron-handover-mac.yml";
const FINALIZATION_RECEIPT = "electron-update-metadata-finalization-receipt.json";

function sha512(bytes) {
  return createHash("sha512").update(bytes).digest("base64");
}

function updaterManifest({ dmgFile, dmgBytes, releaseDate, version, zipFile, zipBytes }) {
  const zipDigest = sha512(zipBytes);
  return Buffer.from([
    `version: ${version}`,
    "files:",
    `  - url: ${zipFile}`,
    `    sha512: ${zipDigest}`,
    `    size: ${zipBytes.length}`,
    `  - url: ${dmgFile}`,
    `    sha512: ${sha512(dmgBytes)}`,
    `    size: ${dmgBytes.length}`,
    `path: ${zipFile}`,
    `sha512: ${zipDigest}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n"), "utf8");
}

function candidateReceipt({
  candidate = "current",
  hostArchitecture = "arm64",
  target = "darwin-arm64",
} = {}) {
  const buildNumber = candidate === "next" ? "2026090702" : BUILD_NUMBER;
  const plan = productionElectronCandidatePlan({
    buildNumber,
    hostArchitecture,
    hostPlatform: "darwin",
    rehearsal: candidate,
    rehearsalCurrentVersion: CURRENT_VERSION,
    rehearsalNextVersion: NEXT_VERSION,
    sourceRevision: SOURCE_REVISION,
    target,
  });
  return {
    ...plan,
    nativeHandoverHelper: {
      ...plan.nativeHandoverHelper,
      status: "contract_ok",
    },
    nativeMacOSKeychainAdapter: {
      ...plan.nativeMacOSKeychainAdapter,
      status: "source_compiled_unsigned",
    },
    runtimeManifest: "app/electron-runtime-manifest.json",
    stagedManifest: "app/package.json",
    status: "native_to_electron_handover_rehearsal_source_staged",
  };
}

async function fileAbsent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function readOrAbsent(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function withFixture(run, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-metadata-finalization-"));
  try {
    return await run(await createFixture(root, options));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function createFixture(root, {
  candidate = "current",
  hostArchitecture = "arm64",
  target = "darwin-arm64",
} = {}) {
  const version = candidate === "next" ? NEXT_VERSION : CURRENT_VERSION;
  const architecture = target.split("-").at(-1);
  const candidateDirectory = join(root, `mirrored-${candidate}`);
  const artifactDirectory = join(candidateDirectory, "artifacts");
  const evidenceDirectory = join(artifactDirectory, "evidence", "pre-finalization");
  await mkdir(evidenceDirectory, { recursive: true });

  const receipt = candidateReceipt({ candidate, hostArchitecture, target });
  const stem = `TiboTattle-${version}-mac-${architecture}`;
  const dmgFile = `${stem}.dmg`;
  const zipFile = `${stem}.zip`;
  const dmgPath = join(artifactDirectory, dmgFile);
  const zipPath = join(artifactDirectory, zipFile);
  const manifestPath = join(artifactDirectory, TRANSPORT_MANIFEST);
  const preManifestPath = join(evidenceDirectory, TRANSPORT_MANIFEST);
  const preDmgBlockmapPath = join(evidenceDirectory, `${dmgFile}.blockmap`);
  const dmgBlockmapPath = `${dmgPath}.blockmap`;
  const zipBlockmapPath = `${zipPath}.blockmap`;
  const candidateReceiptPath = join(candidateDirectory, "production-source-candidate.json");
  const releaseDate = "2026-09-07T18:52:16.630Z";
  const zipBytes = Buffer.concat([
    Buffer.from("zip-final-artifact\n", "utf8"),
    Buffer.alloc(70_000, 0x5a),
  ]);
  const preDmgBytes = Buffer.concat([
    Buffer.from("dmg-before-outer-staple\n", "utf8"),
    Buffer.alloc(70_000, 0x16),
  ]);
  const finalDmgBytes = Buffer.concat([
    preDmgBytes,
    Buffer.from("post-staple-ticket-boundary\n", "utf8"),
  ]);
  const preManifest = updaterManifest({
    dmgBytes: preDmgBytes,
    dmgFile,
    releaseDate,
    version,
    zipBytes,
    zipFile,
  });

  await writeFile(candidateReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(zipPath, zipBytes, { flag: "wx", mode: 0o644 });
  await writeFile(dmgPath, finalDmgBytes, { flag: "wx", mode: 0o644 });
  await writeFile(manifestPath, preManifest, { flag: "wx", mode: 0o600 });
  await buildBlockMap(zipPath, "gzip", zipBlockmapPath);

  const preDmgPath = join(root, "pre-finalization-dmg.dmg");
  const sourcePreDmgBlockmapPath = `${preDmgPath}.blockmap`;
  await writeFile(preDmgPath, preDmgBytes, { flag: "wx", mode: 0o600 });
  await buildBlockMap(preDmgPath, "gzip", sourcePreDmgBlockmapPath);
  const preDmgBlockmapBytes = await readFile(sourcePreDmgBlockmapPath);
  await copyFile(sourcePreDmgBlockmapPath, dmgBlockmapPath);
  await rm(preDmgPath, { force: true });
  await rm(sourcePreDmgBlockmapPath, { force: true });
  const sentinelPath = join(evidenceDirectory, "pre-finalization-binding.json");
  await writeFile(sentinelPath, "{\"opaque\":\"preserved\"}\n", { flag: "wx", mode: 0o600 });

  return Object.freeze({
    artifactDirectory,
    candidate,
    candidateReceiptPath,
    dmgBlockmapPath,
    dmgFile,
    dmgPath,
    finalDmgBytes,
    manifestPath,
    preDmgBlockmapBytes,
    preManifest,
    preDmgBlockmapPath,
    preManifestPath,
    sentinelPath,
    target,
    version,
    zipFile,
    zipBlockmapPath,
    zipPath,
  });
}

async function outputSnapshot(fixture) {
  return Object.freeze({
    dmgBlockmap: await readFile(fixture.dmgBlockmapPath),
    manifest: await readFile(fixture.manifestPath),
    preDmgBlockmap: await readOrAbsent(fixture.preDmgBlockmapPath),
    preManifest: await readOrAbsent(fixture.preManifestPath),
    sentinel: await readFile(fixture.sentinelPath),
    zipBlockmap: await readFile(fixture.zipBlockmapPath),
  });
}

async function assertOutputsUnchanged(fixture, snapshot) {
  assert.deepEqual(await readFile(fixture.dmgBlockmapPath), snapshot.dmgBlockmap);
  assert.deepEqual(await readFile(fixture.manifestPath), snapshot.manifest);
  assert.deepEqual(await readOrAbsent(fixture.preDmgBlockmapPath), snapshot.preDmgBlockmap);
  assert.deepEqual(await readOrAbsent(fixture.preManifestPath), snapshot.preManifest);
  assert.deepEqual(await readFile(fixture.sentinelPath), snapshot.sentinel);
  assert.deepEqual(await readFile(fixture.zipBlockmapPath), snapshot.zipBlockmap);
  assert.equal(await fileAbsent(join(fixture.artifactDirectory, FINALIZATION_RECEIPT)), true);
}

test("finalizes a mirrored macOS rehearsal candidate against final artifact bytes only", async () => {
  await withFixture(async (fixture) => {
    const before = await outputSnapshot(fixture);
    const receipt = await finalizeElectronMacOSUpdateMetadata({
      candidateReceiptPath: fixture.candidateReceiptPath,
    });

    const manifest = yaml.load(await readFile(fixture.manifestPath, "utf8"), {
      schema: yaml.JSON_SCHEMA,
    });
    const [zip, dmg] = manifest.files;
    assert.equal(manifest.version, fixture.version);
    assert.equal(manifest.path, fixture.zipFile);
    assert.equal(manifest.sha512, sha512(await readFile(fixture.zipPath)));
    assert.deepEqual(zip, {
      url: fixture.zipFile,
      sha512: sha512(await readFile(fixture.zipPath)),
      size: (await lstat(fixture.zipPath)).size,
    });
    assert.deepEqual(dmg, {
      url: fixture.dmgFile,
      sha512: sha512(fixture.finalDmgBytes),
      size: fixture.finalDmgBytes.length,
    });
    assert.notDeepEqual(await readFile(fixture.dmgBlockmapPath), before.dmgBlockmap);
    assert.deepEqual(await readFile(fixture.preManifestPath), before.manifest);
    assert.deepEqual(await readFile(fixture.preDmgBlockmapPath), before.dmgBlockmap);
    assert.deepEqual(await readFile(fixture.sentinelPath), before.sentinel);

    assert.equal(receipt.schemaVersion, "tibotattle-electron-update-metadata-finalization-v1");
    assert.equal(receipt.scope, "final_artifact_metadata_only");
    assert.equal(receipt.distribution.logicalChannel,
      "native-to-electron-handover-rehearsal-v1");
    assert.equal(receipt.distribution.transportChannel, "native-to-electron-handover");
    assert.equal(receipt.distribution.manifest, TRANSPORT_MANIFEST);
    assert.equal(Object.hasOwn(receipt, "signing"), false);
    assert.equal(Object.hasOwn(receipt, "notarization"), false);
    assert.equal(Object.hasOwn(receipt, "publication"), false);
    const onDiskReceipt = JSON.parse(await readFile(
      join(fixture.artifactDirectory, FINALIZATION_RECEIPT),
      "utf8",
    ));
    assert.deepEqual(onDiskReceipt, receipt);
  });
});

test("accepts receipt-shaped Apple Silicon host metadata for the next Intel candidate", async () => {
  await withFixture(async (fixture) => {
    const receipt = await finalizeElectronMacOSUpdateMetadata({
      candidateReceiptPath: fixture.candidateReceiptPath,
    });
    assert.equal(fixture.target, "darwin-x64");
    assert.equal(fixture.version, NEXT_VERSION);
    assert.equal(receipt.candidate.kind, "next");
    assert.equal(receipt.candidate.target, "darwin-x64");
    assert.equal(receipt.candidate.version, NEXT_VERSION);
    const candidate = JSON.parse(await readFile(fixture.candidateReceiptPath, "utf8"));
    assert.deepEqual(candidate.host, { platform: "darwin", architecture: "arm64" });
  }, {
    candidate: "next",
    hostArchitecture: "arm64",
    target: "darwin-x64",
  });
});

test("refuses unsupported host metadata without creating pre-finalization sidecars", async () => {
  await withFixture(async (fixture) => {
    const candidate = JSON.parse(await readFile(fixture.candidateReceiptPath, "utf8"));
    candidate.host.architecture = "unsupported";
    await writeFile(fixture.candidateReceiptPath, `${JSON.stringify(candidate)}\n`, { flag: "w" });
    const snapshot = await outputSnapshot(fixture);
    await assert.rejects(
      finalizeElectronMacOSUpdateMetadata({ candidateReceiptPath: fixture.candidateReceiptPath }),
      (error) => error?.code === "ELECTRON_MACOS_METADATA_FINALIZATION_CANDIDATE_RECEIPT_INVALID",
    );
    await assertOutputsUnchanged(fixture, snapshot);
  });
});

test("requires the exact staged native helper and adapter status fields", async () => {
  await withFixture(async (fixture) => {
    const candidate = JSON.parse(await readFile(fixture.candidateReceiptPath, "utf8"));
    delete candidate.nativeHandoverHelper.status;
    await writeFile(fixture.candidateReceiptPath, `${JSON.stringify(candidate)}\n`, { flag: "w" });
    const snapshot = await outputSnapshot(fixture);
    await assert.rejects(
      finalizeElectronMacOSUpdateMetadata({ candidateReceiptPath: fixture.candidateReceiptPath }),
      (error) => error?.code === "ELECTRON_MACOS_METADATA_FINALIZATION_CANDIDATE_RECEIPT_INVALID",
    );
    await assertOutputsUnchanged(fixture, snapshot);
  });
});

test("refuses corrupted pre-finalization metadata without changing outputs", async () => {
  await withFixture(async (fixture) => {
    const snapshot = await outputSnapshot(fixture);
    await writeFile(fixture.preManifestPath, fixture.preManifest, { flag: "wx", mode: 0o600 });
    await writeFile(fixture.preDmgBlockmapPath, "corrupt-blockmap", { flag: "wx", mode: 0o600 });
    await writeFile(fixture.dmgBlockmapPath, "corrupt-blockmap", { flag: "w" });
    const corrupted = await outputSnapshot(fixture);
    await assert.rejects(
      finalizeElectronMacOSUpdateMetadata({ candidateReceiptPath: fixture.candidateReceiptPath }),
      (error) => error?.code === "ELECTRON_MACOS_METADATA_FINALIZATION_BLOCKMAP_INVALID",
    );
    await assertOutputsUnchanged(fixture, corrupted);
    assert.notDeepEqual(corrupted.dmgBlockmap, snapshot.dmgBlockmap);
  });
});

test("refuses a structurally valid ZIP blockmap for different bytes without changing outputs", async () => {
  await withFixture(async (fixture) => {
    const alternateZipPath = join(fixture.artifactDirectory, "different.zip");
    const alternateZipBlockmapPath = `${alternateZipPath}.blockmap`;
    await writeFile(alternateZipPath, Buffer.concat([
      Buffer.from("different-zip-bytes\n", "utf8"),
      Buffer.alloc((await lstat(fixture.zipPath)).size - 20, 0x33),
    ]), { flag: "wx", mode: 0o600 });
    await buildBlockMap(alternateZipPath, "gzip", alternateZipBlockmapPath);
    await copyFile(alternateZipBlockmapPath, fixture.zipBlockmapPath);
    await rm(alternateZipPath, { force: true });
    await rm(alternateZipBlockmapPath, { force: true });
    const snapshot = await outputSnapshot(fixture);
    await assert.rejects(
      finalizeElectronMacOSUpdateMetadata({ candidateReceiptPath: fixture.candidateReceiptPath }),
      (error) => error?.code === "ELECTRON_MACOS_METADATA_FINALIZATION_ZIP_BLOCKMAP_INVALID",
    );
    await assertOutputsUnchanged(fixture, snapshot);
  });
});

test("refuses a legacy transport manifest or unrelated artifact filename without changing outputs", async () => {
  await withFixture(async (fixture) => {
    const snapshot = await outputSnapshot(fixture);
    await writeFile(join(fixture.artifactDirectory, "latest-mac.yml"), "unrelated\n", {
      flag: "wx",
      mode: 0o600,
    });
    await assert.rejects(
      finalizeElectronMacOSUpdateMetadata({ candidateReceiptPath: fixture.candidateReceiptPath }),
      (error) => error?.code === "ELECTRON_MACOS_METADATA_FINALIZATION_TRANSPORT_MANIFEST_CONFLICT",
    );
    await assertOutputsUnchanged(fixture, snapshot);
  });

  await withFixture(async (fixture) => {
    const original = await readFile(fixture.manifestPath, "utf8");
    const unrelated = Buffer.from(original.replace(fixture.zipFile, "other-candidate.zip"), "utf8");
    await writeFile(fixture.manifestPath, unrelated, { flag: "w" });
    await writeFile(fixture.preManifestPath, unrelated, { flag: "w" });
    const snapshot = await outputSnapshot(fixture);
    await assert.rejects(
      finalizeElectronMacOSUpdateMetadata({ candidateReceiptPath: fixture.candidateReceiptPath }),
      (error) => error?.code === "ELECTRON_MACOS_METADATA_FINALIZATION_UPDATER_MANIFEST_INVALID",
    );
    await assertOutputsUnchanged(fixture, snapshot);
  });
});

test("refuses a final artifact changed during blockmap generation without publishing metadata", async () => {
  await withFixture(async (fixture) => {
    const snapshot = await outputSnapshot(fixture);
    await assert.rejects(
      finalizeElectronMacOSUpdateMetadata({
        candidateReceiptPath: fixture.candidateReceiptPath,
      }, {
        afterBlockmapGeneration: async () => {
          await writeFile(fixture.dmgPath, Buffer.concat([
            await readFile(fixture.dmgPath),
            Buffer.from("changed-after-blockmap", "utf8"),
          ]), { flag: "w" });
        },
      }),
      (error) => error?.code === "ELECTRON_MACOS_METADATA_FINALIZATION_ARTIFACT_CHANGED",
    );
    await assertOutputsUnchanged(fixture, snapshot);
  });
});

test("refuses post-commit blockmap corruption before it can emit a finalization receipt", async () => {
  await withFixture(async (fixture) => {
    const alternateDmgPath = join(fixture.artifactDirectory, "different-final.dmg");
    const alternateDmgBlockmapPath = `${alternateDmgPath}.blockmap`;
    await writeFile(alternateDmgPath, Buffer.concat([
      Buffer.from("different-final-dmg\n", "utf8"),
      Buffer.alloc(fixture.finalDmgBytes.length - 20, 0x61),
    ]), { flag: "wx", mode: 0o600 });
    await buildBlockMap(alternateDmgPath, "gzip", alternateDmgBlockmapPath);
    await assert.rejects(
      finalizeElectronMacOSUpdateMetadata({
        candidateReceiptPath: fixture.candidateReceiptPath,
      }, {
        afterMetadataCommit: async () => copyFile(alternateDmgBlockmapPath, fixture.dmgBlockmapPath),
      }),
      (error) => error?.code === "ELECTRON_MACOS_METADATA_FINALIZATION_FINALIZATION_OUTPUT_CHANGED",
    );
    assert.equal(await fileAbsent(join(fixture.artifactDirectory, FINALIZATION_RECEIPT)), true);
    assert.deepEqual(await readFile(fixture.preManifestPath), fixture.preManifest);
    assert.deepEqual(await readFile(fixture.preDmgBlockmapPath), fixture.preDmgBlockmapBytes);
  });
});

test("accepts only the closed candidate receipt CLI shape", () => {
  assert.deepEqual(parseElectronMacOSMetadataFinalizationArguments([
    "--candidate-receipt",
    "mirror/production-source-candidate.json",
  ]), {
    candidateReceiptPath: "mirror/production-source-candidate.json",
  });
  for (const argv of [
    [],
    ["--candidate-receipt"],
    ["--candidate-receipt", "candidate.json", "--feed", "https://example.invalid"],
    ["--feed", "https://example.invalid"],
  ]) {
    assert.throws(
      () => parseElectronMacOSMetadataFinalizationArguments(argv),
      (error) => error?.code === "ELECTRON_MACOS_METADATA_FINALIZATION_ARGUMENT_INVALID",
    );
  }
});
