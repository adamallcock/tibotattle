/**
 * Manifest file verification and no-clobber publication.
 */

import { lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  RELEASE_EVIDENCE_MAX_MANIFEST_BYTES,
  RELEASE_EVIDENCE_MAX_METADATA_BYTES,
} from "../config/release-evidence.js";
import {
  assert,
  assertSafeFileName,
  digestRegularFile,
  ensureOutputDirectory,
  fail,
  pathWithin,
  readJsonFile,
  sha256Bytes,
  stableStringify,
  withOutputLock,
  writeExclusiveFile,
} from "./release-evidence-primitives.js";
import {
  buildSha256Sums,
  RELEASE_EVIDENCE_MANIFEST_FILE_NAME,
  RELEASE_EVIDENCE_SUMS_FILE_NAME,
  validateSigstoreBundle,
  validateSpdxJson,
  validateStoreDeliveryReceipt,
  validateCanonicalManifest,
} from "./release-evidence-policy.js";

async function verifyManifestFiles(manifest, artifactRoot) {
  const root = resolve(artifactRoot);
  for (const artifact of manifest.artifacts) {
    const files = [
      [artifact.fileName, `${artifact.fileName} artifact`, null],
    ];
    if (artifact.store !== null) {
      files.push([
        artifact.store.receipt.fileName,
        `${artifact.fileName} Store delivery receipt`,
        artifact.store.receipt,
        "store-receipt",
      ]);
    }
    if (artifact.sbom !== null) {
      files.push([
        artifact.sbom.fileName,
        `${artifact.fileName} SPDX SBOM`,
        artifact.sbom,
        "spdx",
      ]);
      if (artifact.sbom.attestation !== null) {
        files.push([
          artifact.sbom.attestation.fileName,
          `${artifact.fileName} SPDX SBOM attestation`,
          artifact.sbom.attestation,
          "sigstore",
        ]);
      }
    }
    if (artifact.provenance !== null) {
      files.push([
        artifact.provenance.fileName,
        `${artifact.fileName} provenance`,
        artifact.provenance,
        "sigstore",
      ]);
    }
    if (artifact.updater.enabled) {
      files.push([
        artifact.updater.metadata.fileName,
        `${artifact.fileName} updater metadata`,
        artifact.updater.metadata,
      ]);
    }
    const seenNames = new Set();
    for (const [fileName, label, expected, kind] of files) {
      assertSafeFileName(fileName, `${label}.fileName`);
      const key = fileName.toLowerCase();
      assert(!seenNames.has(key), "RELEASE_EVIDENCE_DUPLICATE_FILE_NAME",
        `${label} reuses a file name`);
      seenNames.add(key);
      const path = resolve(root, fileName);
      assert(pathWithin(root, path), "RELEASE_EVIDENCE_UNSAFE_PATH",
        `${label} escapes the artifact root`);
      const maximumBytes = kind === undefined
        ? null
        : RELEASE_EVIDENCE_MAX_METADATA_BYTES;
      const digest = await digestRegularFile(path, label, maximumBytes, root);
      if (expected !== null) {
        assert(digest.bytes === expected.bytes, "RELEASE_EVIDENCE_BYTES_MISMATCH",
          `${label} byte count does not match the manifest`);
        assert(digest.sha256 === expected.sha256, "RELEASE_EVIDENCE_HASH_MISMATCH",
          `${label} SHA-256 does not match the manifest`);
        if (kind !== undefined) {
          const parsed = await readJsonFile(path, label, maximumBytes, root);
          assert(parsed.bytes === digest.bytes && parsed.sha256 === digest.sha256,
            "RELEASE_EVIDENCE_FILE_CHANGED",
            `${label} changed between hashing and structural validation`);
          if (kind === "spdx") {
            validateSpdxJson(parsed.value, label);
          } else if (kind === "sigstore") {
            validateSigstoreBundle(parsed.value, label);
          } else if (kind === "store-receipt") {
            validateStoreDeliveryReceipt(parsed.value, {
              label,
              productName: manifest.product.name,
              release: {
                version: manifest.version,
                tag: manifest.tag,
                commit: manifest.commit,
                repository: manifest.repository,
              },
              provider: artifact.store.provider,
              listing: artifact.store.listing,
              artifactFileName: artifact.fileName,
              artifactBytes: artifact.bytes,
              artifactSha256: artifact.sha256,
            });
          }
        }
      } else {
        assert(digest.bytes === artifact.bytes && digest.sha256 === artifact.sha256,
          "RELEASE_EVIDENCE_HASH_MISMATCH",
          `${label} does not match the manifest`);
      }
    }
  }
  return true;
}

export async function validateReleaseEvidenceManifest(
  manifest,
  { artifactRoot = null, manifestPath = null } = {},
) {
  validateCanonicalManifest(manifest);
  if (artifactRoot !== null) await verifyManifestFiles(manifest, artifactRoot);
  if (manifestPath !== null) {
    assert(basename(resolve(manifestPath)) === RELEASE_EVIDENCE_MANIFEST_FILE_NAME,
      "RELEASE_EVIDENCE_MANIFEST_FILE_NAME_INVALID",
      `manifestPath must end in ${RELEASE_EVIDENCE_MANIFEST_FILE_NAME}`);
    const manifestText = await readJsonFile(manifestPath,
      "release-manifest.json", RELEASE_EVIDENCE_MAX_MANIFEST_BYTES);
    const expected = Buffer.from(`${stableStringify(manifest)}\n`, "utf8");
    assert(manifestText.bytes === expected.length
        && manifestText.sha256 === sha256Bytes(expected),
    "RELEASE_EVIDENCE_MANIFEST_HASH_MISMATCH",
    "release-manifest.json bytes do not match its canonical JSON");
  }
  return manifest;
}

/**
 * Write a pair only when both names are absent.  An exclusive directory lock
 * serializes cooperating writers; hard-link installation prevents a foreign
 * concurrent writer from being overwritten.  A crash leaves the lock and
 * staging files for explicit operator inspection rather than silently
 * replacing a release pair.
 */
export async function writeReleaseEvidenceFiles({
  manifest,
  manifestPath,
  sumsPath = join(dirname(resolve(manifestPath)), RELEASE_EVIDENCE_SUMS_FILE_NAME),
  artifactRoot = null,
  replace = false,
}) {
  assert(replace === false || replace === undefined, "RELEASE_EVIDENCE_REPLACE_UNSUPPORTED",
    "replace mode is disabled; stage into a fresh directory instead");
  validateCanonicalManifest(manifest);
  const requestedManifestPath = resolve(manifestPath);
  const requestedSumsPath = resolve(sumsPath);
  assert(dirname(requestedManifestPath) === dirname(requestedSumsPath),
    "RELEASE_EVIDENCE_OUTPUT_DIR_MISMATCH",
    "manifest and SHA256SUMS must be written to the same directory");
  assert(basename(requestedManifestPath) === RELEASE_EVIDENCE_MANIFEST_FILE_NAME,
    "RELEASE_EVIDENCE_MANIFEST_FILE_NAME_INVALID",
    `manifestPath must end in ${RELEASE_EVIDENCE_MANIFEST_FILE_NAME}`);
  assert(basename(requestedSumsPath) === RELEASE_EVIDENCE_SUMS_FILE_NAME,
    "RELEASE_EVIDENCE_SUMS_FILE_NAME_INVALID",
    `sumsPath must end in ${RELEASE_EVIDENCE_SUMS_FILE_NAME}`);
  assert(requestedManifestPath !== requestedSumsPath,
    "RELEASE_EVIDENCE_OUTPUT_COLLISION",
    "manifest and SHA256SUMS must be different files");
  if (artifactRoot !== null) await verifyManifestFiles(manifest, artifactRoot);
  const outputDirectory = await ensureOutputDirectory(
    requestedManifestPath,
    artifactRoot,
  );
  const selectedManifestPath = join(
    outputDirectory,
    RELEASE_EVIDENCE_MANIFEST_FILE_NAME,
  );
  const selectedSumsPath = join(outputDirectory, RELEASE_EVIDENCE_SUMS_FILE_NAME);
  const manifestText = `${stableStringify(manifest)}\n`;
  const sumsText = buildSha256Sums(manifest);
  assert(Buffer.byteLength(manifestText, "utf8") <= RELEASE_EVIDENCE_MAX_MANIFEST_BYTES,
    "RELEASE_EVIDENCE_LIMIT_EXCEEDED",
    "canonical release manifest exceeds the read size limit");
  assert(Buffer.byteLength(sumsText, "utf8") <= RELEASE_EVIDENCE_MAX_MANIFEST_BYTES,
    "RELEASE_EVIDENCE_LIMIT_EXCEEDED",
    "canonical SHA256SUMS exceeds the read size limit");
  return withOutputLock(dirname(selectedManifestPath), async () => {
    for (const path of [selectedManifestPath, selectedSumsPath]) {
      try {
        await lstat(path);
        fail("RELEASE_EVIDENCE_OUTPUT_EXISTS", `${path} already exists`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    // Install SHA256SUMS first and the canonical manifest last. The manifest is
    // the pair's commit marker. If the second exclusive link fails, preserve
    // the sums file for explicit inspection; cleanup must never unlink a path
    // that a non-cooperating process could have replaced.
    await writeExclusiveFile(selectedSumsPath, sumsText);
    await writeExclusiveFile(selectedManifestPath, manifestText);
    return Object.freeze({
      manifestPath: selectedManifestPath,
      sumsPath: selectedSumsPath,
      manifestText,
      sumsText,
    });
  });
}

export { verifyManifestFiles };
