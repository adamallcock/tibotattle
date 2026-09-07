#!/usr/bin/env node

/**
 * Bind Electron updater metadata to the exact macOS artifacts after a separate
 * signing/notarization/stapling operation has completed.
 *
 * This script deliberately does not sign, notarize, call a network service,
 * publish a feed, install an application, or verify a signing identity.  Its
 * scope is limited to the updater manifest and the outer-DMG blockmap.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";

import {
  createProductionDistributionMetadata,
  PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CHANNEL,
  PRODUCTION_ELECTRON_TARGETS,
} from "../apps/electron/desktop-updater.js";
import distribution from "../config/electron-production-distribution.cjs";
import { PRODUCT_BRAND } from "../config/product-brand.js";
import { RELEASE_VERSION } from "../config/release-manifest.js";
import { productionElectronCandidatePlan } from "./package-electron-production.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REQUIRE = createRequire(import.meta.url);

const CANDIDATE_SCHEMA = "tibotattle-electron-production-source-candidate-v1";
const FINALIZATION_SCHEMA = "tibotattle-electron-update-metadata-finalization-v1";
const SOURCE_STATUS = "native_to_electron_handover_rehearsal_source_staged";
const FINALIZATION_STATUS = "final_updater_metadata_bound";
const FINALIZATION_SCOPE = "final_artifact_metadata_only";
const TRANSPORT_CHANNEL = "native-to-electron-handover";
const TRANSPORT_MANIFEST = `${TRANSPORT_CHANNEL}-mac.yml`;
const FINALIZATION_RECEIPT = "electron-update-metadata-finalization-receipt.json";
const EVIDENCE_DIRECTORY = Object.freeze(["evidence", "pre-finalization"]);
const MAX_RECEIPT_BYTES = 128 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_BLOCKMAP_BYTES = 32 * 1024 * 1024;
const MAX_BLOCKMAP_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024 * 1024;
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const BLOCKMAP_CHECKSUM = /^[A-Za-z0-9+/]{24}$/u;
const MACOS_HOST_ARCHITECTURES = new Set(["arm64", "x64"]);

function failure(code) {
  const error = new Error(`ELECTRON_MACOS_METADATA_FINALIZATION_${code}`);
  error.code = error.message;
  return error;
}

function fail(code) {
  throw failure(code);
}

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  return isPlainRecord(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function exactString(value, expected) {
  return typeof value === "string" && value === expected;
}

function validSha512(value) {
  return typeof value === "string" && SHA512_BASE64.test(value);
}

function validIsoUtc(value) {
  return typeof value === "string"
    && ISO_UTC.test(value)
    && new Date(value).toISOString() === value;
}

function sameMetadata(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.nlink === right.nlink;
}

async function requiredRegularFile(path, {
  code,
  maximumBytes,
} = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail(code);
  }
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || !Number.isSafeInteger(metadata.size)
      || metadata.size < 1
      || metadata.size > maximumBytes) {
    fail(code);
  }
  return metadata;
}

async function requiredDirectory(path, code) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail(code);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(code);
  try {
    return await realpath(path);
  } catch {
    fail(code);
  }
}

async function readBoundedRegularFile(path, {
  code,
  maximumBytes,
} = {}) {
  const before = await requiredRegularFile(path, { code, maximumBytes });
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    fail(code);
  }
  let after;
  try {
    after = await requiredRegularFile(path, { code, maximumBytes });
  } catch {
    fail(code);
  }
  if (!sameMetadata(before, after) || bytes.length !== before.size) fail(code);
  return Object.freeze({ bytes, metadata: before });
}

async function synchronizeRegularFile(path, {
  code,
  maximumBytes,
} = {}) {
  const before = await requiredRegularFile(path, { code, maximumBytes });
  let handle = null;
  try {
    handle = await open(path, "r");
    const opened = await handle.stat();
    if (!sameMetadata(before, opened)) fail(code);
    await handle.sync();
    const after = await requiredRegularFile(path, { code, maximumBytes });
    if (!sameMetadata(before, after)) fail(code);
  } catch (error) {
    if (error?.code === `ELECTRON_MACOS_METADATA_FINALIZATION_${code}`) throw error;
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function synchronizeDirectory(path, code) {
  let handle = null;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeSynchronizedFile(path, bytes, {
  code,
  maximumBytes,
  mode,
} = {}) {
  let handle = null;
  try {
    handle = await open(path, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch {
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
  await synchronizeRegularFile(path, { code, maximumBytes });
}

async function fingerprintRegularFile(path, {
  code,
  maximumBytes,
} = {}) {
  const before = await requiredRegularFile(path, { code, maximumBytes });
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      bytes += chunk.length;
      if (bytes > maximumBytes) fail(code);
      sha256.update(chunk);
      sha512.update(chunk);
    }
  } catch (error) {
    if (error?.code === `ELECTRON_MACOS_METADATA_FINALIZATION_${code}`) throw error;
    fail(code);
  }
  let after;
  try {
    after = await requiredRegularFile(path, { code, maximumBytes });
  } catch {
    fail(code);
  }
  if (!sameMetadata(before, after) || bytes !== before.size) fail(code);
  return Object.freeze({
    bytes,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64"),
  });
}

function sameFingerprint(left, right) {
  return left.bytes === right.bytes
    && left.sha256 === right.sha256
    && left.sha512 === right.sha512;
}

function loadPinnedBuilderDependencies() {
  try {
    const builderPackagePath = REQUIRE.resolve("electron-builder/package.json");
    const builderRequire = createRequire(builderPackagePath);
    const electronBuilder = builderRequire("electron-builder/package.json");
    const appBuilder = builderRequire("app-builder-lib/package.json");
    const blockmap = builderRequire("app-builder-lib/out/targets/blockmap/blockmap.js");
    const yaml = builderRequire("js-yaml");
    if (electronBuilder?.version !== "26.15.7"
        || appBuilder?.version !== "26.15.7"
        || typeof blockmap?.buildBlockMap !== "function"
        || typeof yaml?.load !== "function"
        || yaml.JSON_SCHEMA === undefined) {
      fail("PINNED_BUILDER_UNAVAILABLE");
    }
    return Object.freeze({
      buildBlockMap: blockmap.buildBlockMap,
      builderVersion: electronBuilder.version,
      yaml,
    });
  } catch (error) {
    if (error?.code === "ELECTRON_MACOS_METADATA_FINALIZATION_PINNED_BUILDER_UNAVAILABLE") {
      throw error;
    }
    fail("PINNED_BUILDER_UNAVAILABLE");
  }
}

function parseUpdaterManifest(bytes, {
  expectedDmgFile,
  expectedVersion,
  expectedZipFile,
  yaml,
} = {}) {
  let manifest;
  try {
    manifest = yaml.load(bytes.toString("utf8"), {
      schema: yaml.JSON_SCHEMA,
      json: false,
    });
  } catch {
    fail("UPDATER_MANIFEST_INVALID");
  }
  if (!hasExactKeys(manifest, ["version", "files", "path", "sha512", "releaseDate"])
      || !exactString(manifest.version, expectedVersion)
      || !Array.isArray(manifest.files)
      || manifest.files.length !== 2
      || !exactString(manifest.path, expectedZipFile)
      || !validSha512(manifest.sha512)
      || !validIsoUtc(manifest.releaseDate)) {
    fail("UPDATER_MANIFEST_INVALID");
  }
  const [zip, dmg] = manifest.files;
  const validateFile = (entry, expectedFile) => hasExactKeys(entry, ["url", "sha512", "size"])
    && exactString(entry.url, expectedFile)
    && validSha512(entry.sha512)
    && Number.isSafeInteger(entry.size)
    && entry.size > 0
    && entry.size <= MAX_ARTIFACT_BYTES;
  if (!validateFile(zip, expectedZipFile)
      || !validateFile(dmg, expectedDmgFile)
      || manifest.sha512 !== zip.sha512) {
    fail("UPDATER_MANIFEST_INVALID");
  }
  return Object.freeze({
    dmg: Object.freeze({ bytes: dmg.size, file: dmg.url, sha512: dmg.sha512 }),
    releaseDate: manifest.releaseDate,
    version: manifest.version,
    zip: Object.freeze({ bytes: zip.size, file: zip.url, sha512: zip.sha512 }),
  });
}

function serializeUpdaterManifest({ version, zip, dmg, releaseDate } = {}) {
  if (typeof version !== "string"
      || !isPlainRecord(zip)
      || !isPlainRecord(dmg)
      || !validIsoUtc(releaseDate)
      || !validSha512(zip.sha512)
      || !validSha512(dmg.sha512)
      || !Number.isSafeInteger(zip.bytes)
      || !Number.isSafeInteger(dmg.bytes)) {
    fail("UPDATER_MANIFEST_INVALID");
  }
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${zip.file}`,
    `    sha512: ${zip.sha512}`,
    `    size: ${zip.bytes}`,
    `  - url: ${dmg.file}`,
    `    sha512: ${dmg.sha512}`,
    `    size: ${dmg.bytes}`,
    `path: ${zip.file}`,
    `sha512: ${zip.sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
}

function parseBlockmap(bytes, expectedArtifactBytes) {
  let decoded;
  try {
    decoded = JSON.parse(gunzipSync(bytes, {
      maxOutputLength: MAX_BLOCKMAP_DECOMPRESSED_BYTES,
    }).toString("utf8"));
  } catch {
    fail("BLOCKMAP_INVALID");
  }
  if (!hasExactKeys(decoded, ["version", "files"])
      || decoded.version !== "2"
      || !Array.isArray(decoded.files)
      || decoded.files.length !== 1) {
    fail("BLOCKMAP_INVALID");
  }
  const file = decoded.files[0];
  if (!hasExactKeys(file, ["name", "offset", "checksums", "sizes"])
      || file.name !== "file"
      || file.offset !== 0
      || !Array.isArray(file.checksums)
      || !Array.isArray(file.sizes)
      || file.checksums.length === 0
      || file.checksums.length !== file.sizes.length) {
    fail("BLOCKMAP_INVALID");
  }
  let bytesCovered = 0;
  for (let index = 0; index < file.sizes.length; index += 1) {
    const size = file.sizes[index];
    if (!Number.isSafeInteger(size)
        || size < 1
        || size > 32 * 1024
        || typeof file.checksums[index] !== "string"
        || !BLOCKMAP_CHECKSUM.test(file.checksums[index])) {
      fail("BLOCKMAP_INVALID");
    }
    bytesCovered += size;
    if (!Number.isSafeInteger(bytesCovered) || bytesCovered > expectedArtifactBytes) {
      fail("BLOCKMAP_INVALID");
    }
  }
  if (bytesCovered !== expectedArtifactBytes) fail("BLOCKMAP_INVALID");
  return Object.freeze({ chunks: file.sizes.length });
}

async function readAndValidateBlockmap(path, expectedArtifactBytes) {
  const value = await readBoundedRegularFile(path, {
    code: "BLOCKMAP_INVALID",
    maximumBytes: MAX_BLOCKMAP_BYTES,
  });
  const metadata = parseBlockmap(value.bytes, expectedArtifactBytes);
  const fingerprint = Object.freeze({
    bytes: value.bytes.length,
    sha256: createHash("sha256").update(value.bytes).digest("hex"),
  });
  return Object.freeze({ ...metadata, fingerprint, raw: value.bytes });
}

function candidateKeys() {
  return [
    "schemaVersion",
    "buildNumber",
    "sourceRevision",
    "version",
    "target",
    "updateFeed",
    "host",
    "stagingDirectory",
    "artifactDirectory",
    "builderConfiguration",
    "builderArguments",
    "builderEnvironment",
    "updaterEnabled",
    "signingRequired",
    "signingPerformed",
    "publishingPerformed",
    "nativeHandoverHelper",
    "nativeMacOSKeychainAdapter",
    "rehearsal",
    "windowsRuntimeQualification",
    "status",
    "stagedManifest",
    "runtimeManifest",
  ];
}

function validateCandidateReceipt(value) {
  if (!hasExactKeys(value, candidateKeys())
      || value.schemaVersion !== CANDIDATE_SCHEMA
      || !hasExactKeys(value.host, ["platform", "architecture"])
      || !hasExactKeys(value.rehearsal, [
        "candidate", "currentVersion", "id", "nextVersion", "releaseStatus", "hostedUploads",
      ])
      || !Object.hasOwn(distribution.PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CANDIDATES,
        value.rehearsal.candidate)) {
    fail("CANDIDATE_RECEIPT_INVALID");
  }
  const targetSpec = PRODUCTION_ELECTRON_TARGETS[value.target];
  if (!targetSpec
      || targetSpec.platform !== "darwin"
      || value.host.platform !== "darwin"
      || !MACOS_HOST_ARCHITECTURES.has(value.host.architecture)) {
    fail("CANDIDATE_RECEIPT_INVALID");
  }
  let expected;
  try {
    expected = productionElectronCandidatePlan({
      target: value.target,
      sourceRevision: value.sourceRevision,
      buildNumber: value.buildNumber,
      rehearsal: value.rehearsal.candidate,
      rehearsalCurrentVersion: value.rehearsal.currentVersion,
      rehearsalNextVersion: value.rehearsal.nextVersion,
      hostPlatform: value.host.platform,
      hostArchitecture: value.host.architecture,
    });
  } catch {
    fail("CANDIDATE_RECEIPT_INVALID");
  }
  const stagedNativeHandoverHelper = Object.freeze({
    ...expected.nativeHandoverHelper,
    status: "contract_ok",
  });
  const stagedNativeMacOSKeychainAdapter = Object.freeze({
    ...expected.nativeMacOSKeychainAdapter,
    status: "source_compiled_unsigned",
  });
  for (const key of Reflect.ownKeys(expected)) {
    const expectedValue = key === "nativeHandoverHelper"
      ? stagedNativeHandoverHelper
      : key === "nativeMacOSKeychainAdapter"
        ? stagedNativeMacOSKeychainAdapter
        : expected[key];
    if (!isDeepStrictEqual(value[key], expectedValue)) fail("CANDIDATE_RECEIPT_INVALID");
  }
  if (value.status !== SOURCE_STATUS
      || value.stagedManifest !== "app/package.json"
      || value.runtimeManifest !== "app/electron-runtime-manifest.json") {
    fail("CANDIDATE_RECEIPT_INVALID");
  }
  let distributionMetadata;
  try {
    distributionMetadata = createProductionDistributionMetadata({
      buildNumber: value.buildNumber,
      rehearsal: value.rehearsal.candidate,
      rehearsalCurrentVersion: value.rehearsal.currentVersion,
      rehearsalNextVersion: value.rehearsal.nextVersion,
      sourceRevision: value.sourceRevision,
      target: value.target,
    });
  } catch {
    fail("CANDIDATE_RECEIPT_INVALID");
  }
  if (distributionMetadata.channel
        !== PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CHANNEL
      || distributionMetadata.semanticVersion !== value.version
      || distributionMetadata.updateFeed !== value.updateFeed) {
    fail("CANDIDATE_RECEIPT_INVALID");
  }
  const artifactStem = `${PRODUCT_BRAND.displayName}-${value.version}-mac-${targetSpec.architecture}`;
  return Object.freeze({
    candidate: value.rehearsal.candidate,
    distributionMetadata,
    dmgFile: `${artifactStem}.dmg`,
    target: value.target,
    version: value.version,
    zipFile: `${artifactStem}.zip`,
  });
}

async function readCandidateReceipt(path) {
  const selected = resolve(path);
  const candidateDirectory = await requiredDirectory(dirname(selected), "CANDIDATE_RECEIPT_INVALID");
  const raw = await readBoundedRegularFile(selected, {
    code: "CANDIDATE_RECEIPT_INVALID",
    maximumBytes: MAX_RECEIPT_BYTES,
  });
  let parsed;
  try {
    parsed = JSON.parse(raw.bytes.toString("utf8"));
  } catch {
    fail("CANDIDATE_RECEIPT_INVALID");
  }
  const candidate = validateCandidateReceipt(parsed);
  return Object.freeze({
    artifactDirectory: join(candidateDirectory, "artifacts"),
    candidate,
    candidateReceipt: selected,
  });
}

async function assertAbsent(path, code) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail(code);
  }
  fail(code);
}

async function optionalBoundedRegularFile(path, {
  code,
  maximumBytes,
} = {}) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail(code);
  }
  return readBoundedRegularFile(path, { code, maximumBytes });
}

async function createVerifiedDirectory(path, {
  code,
  parent,
} = {}) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") fail(code);
  }
  const resolved = await requiredDirectory(path, code);
  await synchronizeDirectory(parent, code);
  return resolved;
}

/**
 * Preserve exact builder-side updater metadata only after every artifact input
 * has been checked. Existing sidecars are accepted solely when they are the
 * same immutable bytes as the still-unfinalized root metadata; a partial,
 * stale, or conflicting backup fails closed.
 */
async function preservePreFinalizationSidecars({
  artifactDirectory,
  dmgBlockmapBytes,
  dmgBlockmapPath,
  manifestBytes,
  manifestPath,
} = {}) {
  const evidenceDirectory = join(artifactDirectory, "evidence");
  const preFinalizationDirectory = join(evidenceDirectory, "pre-finalization");
  const preFinalizationManifestPath = join(preFinalizationDirectory, TRANSPORT_MANIFEST);
  const preFinalizationDmgBlockmapPath = join(
    preFinalizationDirectory,
    basename(dmgBlockmapPath),
  );
  const currentManifest = await readBoundedRegularFile(manifestPath, {
    code: "PREFINALIZATION_CONFLICT",
    maximumBytes: MAX_MANIFEST_BYTES,
  });
  const currentDmgBlockmap = await readBoundedRegularFile(dmgBlockmapPath, {
    code: "PREFINALIZATION_CONFLICT",
    maximumBytes: MAX_BLOCKMAP_BYTES,
  });
  if (!currentManifest.bytes.equals(manifestBytes)
      || !currentDmgBlockmap.bytes.equals(dmgBlockmapBytes)) {
    fail("PREFINALIZATION_CONFLICT");
  }

  let resolvedEvidenceDirectory;
  try {
    resolvedEvidenceDirectory = await requiredDirectory(
      evidenceDirectory,
      "PREFINALIZATION_SIDECAR_INVALID",
    );
  } catch (error) {
    if (error?.code !== "ELECTRON_MACOS_METADATA_FINALIZATION_PREFINALIZATION_SIDECAR_INVALID") {
      throw error;
    }
    resolvedEvidenceDirectory = await createVerifiedDirectory(evidenceDirectory, {
      code: "PREFINALIZATION_SIDECAR_INVALID",
      parent: artifactDirectory,
    });
  }
  let resolvedPreFinalizationDirectory;
  try {
    resolvedPreFinalizationDirectory = await requiredDirectory(
      preFinalizationDirectory,
      "PREFINALIZATION_SIDECAR_INVALID",
    );
  } catch (error) {
    if (error?.code !== "ELECTRON_MACOS_METADATA_FINALIZATION_PREFINALIZATION_SIDECAR_INVALID") {
      throw error;
    }
    resolvedPreFinalizationDirectory = await createVerifiedDirectory(preFinalizationDirectory, {
      code: "PREFINALIZATION_SIDECAR_INVALID",
      parent: resolvedEvidenceDirectory,
    });
  }
  if (resolvedPreFinalizationDirectory !== preFinalizationDirectory
      || resolvedEvidenceDirectory !== evidenceDirectory) {
    // The artifacts directory is canonical. A differently resolved child can
    // only be an unexpected indirection and is not a safe backup destination.
    fail("PREFINALIZATION_SIDECAR_INVALID");
  }

  const preservedManifest = await optionalBoundedRegularFile(preFinalizationManifestPath, {
    code: "PREFINALIZATION_SIDECAR_INVALID",
    maximumBytes: MAX_MANIFEST_BYTES,
  });
  const preservedDmgBlockmap = await optionalBoundedRegularFile(preFinalizationDmgBlockmapPath, {
    code: "PREFINALIZATION_SIDECAR_INVALID",
    maximumBytes: MAX_BLOCKMAP_BYTES,
  });
  if (Boolean(preservedManifest) !== Boolean(preservedDmgBlockmap)) {
    fail("PREFINALIZATION_CONFLICT");
  }
  if (preservedManifest !== null) {
    if (!preservedManifest.bytes.equals(manifestBytes)
        || !preservedDmgBlockmap.bytes.equals(dmgBlockmapBytes)) {
      fail("PREFINALIZATION_CONFLICT");
    }
    return Object.freeze({
      dmgBlockmap: preservedDmgBlockmap,
      manifest: preservedManifest,
    });
  }

  await writeSynchronizedFile(preFinalizationManifestPath, manifestBytes, {
    code: "PREFINALIZATION_SIDECAR_WRITE_FAILED",
    maximumBytes: MAX_MANIFEST_BYTES,
    mode: 0o600,
  });
  await writeSynchronizedFile(preFinalizationDmgBlockmapPath, dmgBlockmapBytes, {
    code: "PREFINALIZATION_SIDECAR_WRITE_FAILED",
    maximumBytes: MAX_BLOCKMAP_BYTES,
    mode: 0o600,
  });
  await synchronizeDirectory(resolvedPreFinalizationDirectory, "PREFINALIZATION_SIDECAR_WRITE_FAILED");
  return Object.freeze({
    dmgBlockmap: await readBoundedRegularFile(preFinalizationDmgBlockmapPath, {
      code: "PREFINALIZATION_SIDECAR_WRITE_FAILED",
      maximumBytes: MAX_BLOCKMAP_BYTES,
    }),
    manifest: await readBoundedRegularFile(preFinalizationManifestPath, {
      code: "PREFINALIZATION_SIDECAR_WRITE_FAILED",
      maximumBytes: MAX_MANIFEST_BYTES,
    }),
  });
}

async function acquireFinalizationLock(artifactDirectory) {
  const lockPath = join(artifactDirectory, ".electron-update-metadata-finalization.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch {
    fail("FINALIZATION_BUSY");
  }
  return async () => {
    try {
      await handle.close();
    } finally {
      await unlink(lockPath).catch(() => {});
    }
  };
}

async function atomicallyReplace(path, temporaryPath, code) {
  await requiredRegularFile(path, { code, maximumBytes: MAX_BLOCKMAP_BYTES });
  await synchronizeRegularFile(temporaryPath, { code, maximumBytes: MAX_BLOCKMAP_BYTES });
  try {
    await rename(temporaryPath, path);
  } catch {
    fail(code);
  }
  await synchronizeDirectory(dirname(path), code);
  await requiredRegularFile(path, { code, maximumBytes: MAX_BLOCKMAP_BYTES });
}

async function writeNoClobberReceipt(path, receipt, temporaryDirectory) {
  const temporaryPath = join(temporaryDirectory, "metadata-receipt.json");
  const content = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  try {
    await writeSynchronizedFile(temporaryPath, content, {
      code: "FINALIZATION_RECEIPT_WRITE_FAILED",
      maximumBytes: MAX_RECEIPT_BYTES,
      mode: 0o600,
    });
    await link(temporaryPath, path);
    await synchronizeDirectory(dirname(path), "FINALIZATION_RECEIPT_WRITE_FAILED");
  } catch (error) {
    if (error?.code === "EEXIST") fail("FINALIZATION_RECEIPT_EXISTS");
    fail("FINALIZATION_RECEIPT_WRITE_FAILED");
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  const written = await readBoundedRegularFile(path, {
    code: "FINALIZATION_RECEIPT_WRITE_FAILED",
    maximumBytes: MAX_RECEIPT_BYTES,
  });
  if (!written.bytes.equals(content)) fail("FINALIZATION_RECEIPT_WRITE_FAILED");
}

function createFinalizationReceipt({
  candidate,
  builderVersion,
  dmg,
  dmgBlockmap,
  preFinalization,
  zip,
  zipBlockmap,
} = {}) {
  return Object.freeze({
    schemaVersion: FINALIZATION_SCHEMA,
    status: FINALIZATION_STATUS,
    scope: FINALIZATION_SCOPE,
    candidate: Object.freeze({
      buildNumber: candidate.distributionMetadata.buildNumber,
      kind: candidate.candidate,
      sourceRevision: candidate.distributionMetadata.sourceRevision,
      target: candidate.target,
      version: candidate.version,
    }),
    distribution: Object.freeze({
      logicalChannel: candidate.distributionMetadata.channel,
      manifest: TRANSPORT_MANIFEST,
      transportChannel: TRANSPORT_CHANNEL,
      updateFeed: candidate.distributionMetadata.updateFeed,
    }),
    builder: Object.freeze({ version: builderVersion }),
    artifacts: Object.freeze({
      dmg: Object.freeze({
        bytes: dmg.bytes,
        file: candidate.dmgFile,
        sha256: dmg.sha256,
        sha512: dmg.sha512,
      }),
      zip: Object.freeze({
        bytes: zip.bytes,
        file: candidate.zipFile,
        sha256: zip.sha256,
        sha512: zip.sha512,
      }),
      blockmaps: Object.freeze({
        dmg: Object.freeze({
          bytes: dmgBlockmap.bytes,
          file: `${candidate.dmgFile}.blockmap`,
          sha256: dmgBlockmap.sha256,
        }),
        zip: Object.freeze({
          bytes: zipBlockmap.bytes,
          file: `${candidate.zipFile}.blockmap`,
          sha256: zipBlockmap.sha256,
        }),
      }),
    }),
    preFinalizationSidecars: Object.freeze({
      dmgBlockmap: Object.freeze({
        bytes: preFinalization.dmgBlockmap.bytes,
        file: `${EVIDENCE_DIRECTORY.join("/")}/${candidate.dmgFile}.blockmap`,
        sha256: preFinalization.dmgBlockmap.sha256,
      }),
      manifest: Object.freeze({
        bytes: preFinalization.manifest.bytes,
        file: `${EVIDENCE_DIRECTORY.join("/")}/${TRANSPORT_MANIFEST}`,
        sha256: preFinalization.manifest.sha256,
      }),
    }),
  });
}

/**
 * Regenerate the outer-DMG blockmap and bind the fixed transport manifest to
 * final DMG and ZIP bytes.  Calling this twice is intentionally refused: the
 * retained pre-finalization sidecars make a prior or conflicting operation
 * visible rather than silently overwriting it.
 */
export async function finalizeElectronMacOSUpdateMetadata({
  candidateReceiptPath,
} = {}, testOnly = undefined) {
  if (typeof candidateReceiptPath !== "string"
      || candidateReceiptPath.length === 0
      || candidateReceiptPath.includes("\0")) {
    fail("ARGUMENT_INVALID");
  }
  if (testOnly !== undefined
      && (!isPlainRecord(testOnly)
        || (testOnly.afterBlockmapGeneration !== undefined
          && typeof testOnly.afterBlockmapGeneration !== "function")
        || (testOnly.afterMetadataCommit !== undefined
          && typeof testOnly.afterMetadataCommit !== "function")
        || Reflect.ownKeys(testOnly).some((key) => key !== "afterBlockmapGeneration"
          && key !== "afterMetadataCommit"))) {
    fail("ARGUMENT_INVALID");
  }
  const resolvedCandidate = await readCandidateReceipt(candidateReceiptPath);
  const artifactDirectory = await requiredDirectory(
    resolvedCandidate.artifactDirectory,
    "ARTIFACT_DIRECTORY_INVALID",
  );
  const releaseLock = await acquireFinalizationLock(artifactDirectory);
  let temporaryDirectory = null;
  try {
    const dependencies = loadPinnedBuilderDependencies();
    const selectedBuildBlockMap = dependencies.buildBlockMap;

    const { candidate } = resolvedCandidate;
    const manifestPath = join(artifactDirectory, TRANSPORT_MANIFEST);
    const legacyManifestPath = join(artifactDirectory, "latest-mac.yml");
    const dmgPath = join(artifactDirectory, candidate.dmgFile);
    const zipPath = join(artifactDirectory, candidate.zipFile);
    const dmgBlockmapPath = `${dmgPath}.blockmap`;
    const zipBlockmapPath = `${zipPath}.blockmap`;
    const preFinalizationDirectory = join(artifactDirectory, ...EVIDENCE_DIRECTORY);
    const preFinalizationManifestPath = join(preFinalizationDirectory, TRANSPORT_MANIFEST);
    const preFinalizationDmgBlockmapPath = join(
      preFinalizationDirectory,
      `${candidate.dmgFile}.blockmap`,
    );
    const finalReceiptPath = join(artifactDirectory, FINALIZATION_RECEIPT);

    await assertAbsent(legacyManifestPath, "TRANSPORT_MANIFEST_CONFLICT");
    await assertAbsent(finalReceiptPath, "FINALIZATION_RECEIPT_EXISTS");
    const existingManifest = await readBoundedRegularFile(manifestPath, {
      code: "UPDATER_MANIFEST_INVALID",
      maximumBytes: MAX_MANIFEST_BYTES,
    });
    const preManifest = parseUpdaterManifest(existingManifest.bytes, {
      expectedDmgFile: candidate.dmgFile,
      expectedVersion: candidate.version,
      expectedZipFile: candidate.zipFile,
      yaml: dependencies.yaml,
    });

    const existingDmgBlockmap = await readAndValidateBlockmap(
      dmgBlockmapPath,
      preManifest.dmg.bytes,
    );

    const initialZip = await fingerprintRegularFile(zipPath, {
      code: "ARTIFACT_INVALID",
      maximumBytes: MAX_ARTIFACT_BYTES,
    });
    const initialDmg = await fingerprintRegularFile(dmgPath, {
      code: "ARTIFACT_INVALID",
      maximumBytes: MAX_ARTIFACT_BYTES,
    });
    if (initialZip.bytes !== preManifest.zip.bytes
        || initialZip.sha512 !== preManifest.zip.sha512) {
      fail("ZIP_ARTIFACT_CHANGED");
    }

    temporaryDirectory = await mkdtemp(join(artifactDirectory, ".electron-update-metadata-"));
    const temporaryDmgBlockmapPath = join(temporaryDirectory, `${candidate.dmgFile}.blockmap`);
    const temporaryZipBlockmapPath = join(temporaryDirectory, `${candidate.zipFile}.blockmap`);
    const temporaryManifestPath = join(temporaryDirectory, TRANSPORT_MANIFEST);
    let generatedDmg;
    let generatedZip;
    try {
      generatedZip = await selectedBuildBlockMap(zipPath, "gzip", temporaryZipBlockmapPath);
      generatedDmg = await selectedBuildBlockMap(dmgPath, "gzip", temporaryDmgBlockmapPath);
    } catch {
      fail("BLOCKMAP_GENERATION_FAILED");
    }
    if (!isPlainRecord(generatedDmg)
        || !Number.isSafeInteger(generatedDmg.size)
        || !validSha512(generatedDmg.sha512)
        || !isPlainRecord(generatedZip)
        || !Number.isSafeInteger(generatedZip.size)
        || !validSha512(generatedZip.sha512)) {
      fail("BLOCKMAP_GENERATION_FAILED");
    }

    const afterGenerationZip = await fingerprintRegularFile(zipPath, {
      code: "ARTIFACT_CHANGED",
      maximumBytes: MAX_ARTIFACT_BYTES,
    });
    const afterGenerationDmg = await fingerprintRegularFile(dmgPath, {
      code: "ARTIFACT_CHANGED",
      maximumBytes: MAX_ARTIFACT_BYTES,
    });
    if (!sameFingerprint(initialZip, afterGenerationZip)
        || !sameFingerprint(initialDmg, afterGenerationDmg)
        || generatedDmg.size !== initialDmg.bytes
        || generatedDmg.sha512 !== initialDmg.sha512
        || generatedZip.size !== initialZip.bytes
        || generatedZip.sha512 !== initialZip.sha512) {
      fail("ARTIFACT_CHANGED");
    }

    const zipBlockmap = await readAndValidateBlockmap(zipBlockmapPath, initialZip.bytes);
    const generatedZipBlockmap = await readAndValidateBlockmap(
      temporaryZipBlockmapPath,
      initialZip.bytes,
    );
    const generatedDmgBlockmap = await readAndValidateBlockmap(
      temporaryDmgBlockmapPath,
      initialDmg.bytes,
    );
    if (!zipBlockmap.raw.equals(generatedZipBlockmap.raw)) fail("ZIP_BLOCKMAP_INVALID");
    await testOnly?.afterBlockmapGeneration?.({
      artifactDirectory,
      dmgBlockmapPath,
      dmgPath,
      manifestPath,
      zipBlockmapPath,
      zipPath,
    });
    const afterHookZip = await fingerprintRegularFile(zipPath, {
      code: "ARTIFACT_CHANGED",
      maximumBytes: MAX_ARTIFACT_BYTES,
    });
    const afterHookDmg = await fingerprintRegularFile(dmgPath, {
      code: "ARTIFACT_CHANGED",
      maximumBytes: MAX_ARTIFACT_BYTES,
    });
    if (!sameFingerprint(initialZip, afterHookZip) || !sameFingerprint(initialDmg, afterHookDmg)) {
      fail("ARTIFACT_CHANGED");
    }

    const preservedSidecars = await preservePreFinalizationSidecars({
      artifactDirectory,
      dmgBlockmapBytes: existingDmgBlockmap.raw,
      dmgBlockmapPath,
      manifestBytes: existingManifest.bytes,
      manifestPath,
    });
    const preFinalizationManifest = preservedSidecars.manifest;
    const preFinalizationDmgBlockmap = await readAndValidateBlockmap(
      join(artifactDirectory, ...EVIDENCE_DIRECTORY, `${candidate.dmgFile}.blockmap`),
      preManifest.dmg.bytes,
    );
    if (!preFinalizationManifest.bytes.equals(existingManifest.bytes)
        || !preFinalizationDmgBlockmap.raw.equals(existingDmgBlockmap.raw)) {
      fail("PREFINALIZATION_CONFLICT");
    }
    const preFinalization = Object.freeze({
      dmgBlockmap: preFinalizationDmgBlockmap.fingerprint,
      manifest: Object.freeze({
        bytes: preFinalizationManifest.bytes.length,
        sha256: createHash("sha256").update(preFinalizationManifest.bytes).digest("hex"),
      }),
    });
    const finalManifestText = serializeUpdaterManifest({
      version: candidate.version,
      zip: Object.freeze({
        bytes: initialZip.bytes,
        file: candidate.zipFile,
        sha512: initialZip.sha512,
      }),
      dmg: Object.freeze({
        bytes: initialDmg.bytes,
        file: candidate.dmgFile,
        sha512: initialDmg.sha512,
      }),
      releaseDate: preManifest.releaseDate,
    });
    const parsedFinalManifest = parseUpdaterManifest(Buffer.from(finalManifestText, "utf8"), {
      expectedDmgFile: candidate.dmgFile,
      expectedVersion: candidate.version,
      expectedZipFile: candidate.zipFile,
      yaml: dependencies.yaml,
    });
    if (parsedFinalManifest.zip.sha512 !== initialZip.sha512
        || parsedFinalManifest.zip.bytes !== initialZip.bytes
        || parsedFinalManifest.dmg.sha512 !== initialDmg.sha512
        || parsedFinalManifest.dmg.bytes !== initialDmg.bytes) {
      fail("UPDATER_MANIFEST_INVALID");
    }
    await writeSynchronizedFile(temporaryManifestPath, finalManifestText, {
      code: "UPDATER_MANIFEST_WRITE_FAILED",
      maximumBytes: MAX_MANIFEST_BYTES,
      mode: 0o600,
    });

    const beforeCommitManifest = await readBoundedRegularFile(manifestPath, {
      code: "PREFINALIZATION_CONFLICT",
      maximumBytes: MAX_MANIFEST_BYTES,
    });
    const beforeCommitDmgBlockmap = await readBoundedRegularFile(dmgBlockmapPath, {
      code: "PREFINALIZATION_CONFLICT",
      maximumBytes: MAX_BLOCKMAP_BYTES,
    });
    if (!beforeCommitManifest.bytes.equals(preFinalizationManifest.bytes)
        || !beforeCommitDmgBlockmap.bytes.equals(preFinalizationDmgBlockmap.raw)) {
      fail("PREFINALIZATION_CONFLICT");
    }
    const beforeCommitZip = await fingerprintRegularFile(zipPath, {
      code: "ARTIFACT_CHANGED",
      maximumBytes: MAX_ARTIFACT_BYTES,
    });
    const beforeCommitDmg = await fingerprintRegularFile(dmgPath, {
      code: "ARTIFACT_CHANGED",
      maximumBytes: MAX_ARTIFACT_BYTES,
    });
    if (!sameFingerprint(initialZip, beforeCommitZip)
        || !sameFingerprint(initialDmg, beforeCommitDmg)) {
      fail("ARTIFACT_CHANGED");
    }

    await atomicallyReplace(dmgBlockmapPath, temporaryDmgBlockmapPath, "BLOCKMAP_WRITE_FAILED");
    await atomicallyReplace(manifestPath, temporaryManifestPath, "UPDATER_MANIFEST_WRITE_FAILED");
    await testOnly?.afterMetadataCommit?.({
      artifactDirectory,
      dmgBlockmapPath,
      dmgPath,
      manifestPath,
      zipBlockmapPath,
      zipPath,
    });

    const finalDmg = await fingerprintRegularFile(dmgPath, {
      code: "ARTIFACT_CHANGED",
      maximumBytes: MAX_ARTIFACT_BYTES,
    });
    const finalZip = await fingerprintRegularFile(zipPath, {
      code: "ARTIFACT_CHANGED",
      maximumBytes: MAX_ARTIFACT_BYTES,
    });
    if (!sameFingerprint(initialDmg, finalDmg) || !sameFingerprint(initialZip, finalZip)) {
      fail("ARTIFACT_CHANGED");
    }
    const finalizedManifest = await readBoundedRegularFile(manifestPath, {
      code: "UPDATER_MANIFEST_INVALID",
      maximumBytes: MAX_MANIFEST_BYTES,
    });
    const parsedFinalizedManifest = parseUpdaterManifest(finalizedManifest.bytes, {
      expectedDmgFile: candidate.dmgFile,
      expectedVersion: candidate.version,
      expectedZipFile: candidate.zipFile,
      yaml: dependencies.yaml,
    });
    const finalizedDmgBlockmap = await readAndValidateBlockmap(dmgBlockmapPath, finalDmg.bytes);
    const finalizedZipBlockmap = await readAndValidateBlockmap(zipBlockmapPath, finalZip.bytes);
    if (parsedFinalizedManifest.zip.sha512 !== finalZip.sha512
        || parsedFinalizedManifest.zip.bytes !== finalZip.bytes
        || parsedFinalizedManifest.dmg.sha512 !== finalDmg.sha512
        || parsedFinalizedManifest.dmg.bytes !== finalDmg.bytes) {
      fail("UPDATER_MANIFEST_INVALID");
    }
    if (!finalizedManifest.bytes.equals(Buffer.from(finalManifestText, "utf8"))
        || !finalizedDmgBlockmap.raw.equals(generatedDmgBlockmap.raw)
        || !finalizedZipBlockmap.raw.equals(generatedZipBlockmap.raw)) {
      fail("FINALIZATION_OUTPUT_CHANGED");
    }

    const preservedManifest = await readBoundedRegularFile(preFinalizationManifestPath, {
      code: "PREFINALIZATION_SIDECAR_CHANGED",
      maximumBytes: MAX_MANIFEST_BYTES,
    });
    const preservedDmgBlockmap = await readAndValidateBlockmap(
      preFinalizationDmgBlockmapPath,
      preManifest.dmg.bytes,
    );
    const preservedManifestFingerprint = Object.freeze({
      bytes: preservedManifest.bytes.length,
      sha256: createHash("sha256").update(preservedManifest.bytes).digest("hex"),
    });
    if (!preservedManifest.bytes.equals(preFinalizationManifest.bytes)
        || preservedDmgBlockmap.fingerprint.sha256 !== preFinalization.dmgBlockmap.sha256
        || preservedDmgBlockmap.fingerprint.bytes !== preFinalization.dmgBlockmap.bytes
        || preservedManifestFingerprint.sha256 !== preFinalization.manifest.sha256
        || preservedManifestFingerprint.bytes !== preFinalization.manifest.bytes) {
      fail("PREFINALIZATION_SIDECAR_CHANGED");
    }

    const receipt = createFinalizationReceipt({
      candidate,
      builderVersion: dependencies.builderVersion,
      dmg: finalDmg,
      dmgBlockmap: finalizedDmgBlockmap.fingerprint,
      preFinalization,
      zip: finalZip,
      zipBlockmap: finalizedZipBlockmap.fingerprint,
    });
    await writeNoClobberReceipt(finalReceiptPath, receipt, temporaryDirectory);
    return receipt;
  } finally {
    if (temporaryDirectory !== null) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
    await releaseLock();
  }
}

export function parseElectronMacOSMetadataFinalizationArguments(argv) {
  if (!Array.isArray(argv)) fail("ARGUMENT_INVALID");
  if (argv.length !== 2 || argv[0] !== "--candidate-receipt"
      || typeof argv[1] !== "string"
      || argv[1].length === 0
      || argv[1].startsWith("--")
      || argv[1].includes("\0")) {
    fail("ARGUMENT_INVALID");
  }
  return Object.freeze({ candidateReceiptPath: argv[1] });
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  try {
    const receipt = await finalizeElectronMacOSUpdateMetadata(
      parseElectronMacOSMetadataFinalizationArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${/^ELECTRON_MACOS_METADATA_FINALIZATION_[A-Z_]+$/u.test(error?.code ?? "")
      ? error.code
      : "ELECTRON_MACOS_METADATA_FINALIZATION_FAILED"}\n`);
    process.exitCode = 1;
  }
}
