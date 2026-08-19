/**
 * Descriptor normalization and manifest generation.
 *
 * Local paths are consumed here and never leave this module.  The returned
 * object is the canonical public manifest, validated by the shared policy
 * module before it is returned.
 */

import {
  RELEASE_EVIDENCE_INPUT_SCHEMA_VERSION,
  RELEASE_EVIDENCE_MAX_ARTIFACTS,
  RELEASE_EVIDENCE_MAX_METADATA_BYTES,
  RELEASE_EVIDENCE_MAX_TOTAL_METADATA_BYTES,
  RELEASE_EVIDENCE_SCHEMA_VERSION,
  RELEASE_EVIDENCE_STORE_RECEIPT_FORMAT,
  RELEASE_EVIDENCE_STORE_RECEIPT_SCHEMA_VERSION,
} from "../config/release-evidence.js";
import { resolve } from "node:path";
import {
  assert,
  assertByteCount,
  assertPlainObject,
  assertSafeFileName,
  assertSafeText,
  digestDescriptorFile,
  digestRegularFile,
  isPlainObject,
  readJsonFile,
  resolveDescriptorPath,
} from "./release-evidence-primitives.js";
import {
  assertAllowedKeys,
  assertArchitecture,
  assertChannel,
  assertCommit,
  assertDistribution,
  assertFormat,
  assertPlatform,
  assertRepository,
  assertTag,
  assertVersion,
  compareArtifactIdentity,
  normalizeAttestationMetadata,
  normalizeBuild,
  normalizeNativeTrust,
  normalizeSource,
  normalizeStore,
  validateSigstoreBundle,
  validateStoreDeliveryReceipt,
  normalizeUpdater,
  validateAssurances,
  validateCanonicalManifest,
  validateDistribution,
  validateSpdxJson,
} from "./release-evidence-policy.js";

function validateReleaseIdentity(input) {
  assertPlainObject(input, "RELEASE_EVIDENCE_INPUT_INVALID", "release input");
  assertAllowedKeys(input,
    ["schemaVersion", "product", "version", "tag", "commit", "repository", "artifacts"],
    "release input", "RELEASE_EVIDENCE_INPUT_INVALID");
  if (input.schemaVersion !== undefined) {
    assert(input.schemaVersion === RELEASE_EVIDENCE_INPUT_SCHEMA_VERSION
        || input.schemaVersion === RELEASE_EVIDENCE_SCHEMA_VERSION,
    "RELEASE_EVIDENCE_SCHEMA_INVALID",
    "release input has an unsupported schema version");
  }
  const product = assertPlainObject(input.product,
    "RELEASE_EVIDENCE_PRODUCT_INVALID", "product");
  assertAllowedKeys(product, ["name"], "product", "RELEASE_EVIDENCE_PRODUCT_INVALID");
  assertSafeText(product.name, "RELEASE_EVIDENCE_PRODUCT_INVALID", "product.name");
  const release = {
    version: assertVersion(input.version),
    tag: assertTag(input.tag),
    commit: assertCommit(input.commit),
    repository: assertRepository(input.repository),
  };
  assert(release.tag === `v${release.version}`,
  "RELEASE_EVIDENCE_VERSION_MISMATCH",
  "tag must equal v<version>; prerelease/build identifiers belong in version");
  return Object.freeze({
    product: Object.freeze({ name: product.name }),
    release: Object.freeze(release),
  });
}

function consumeMetadata(context, bytes, label) {
  assertByteCount(bytes, label);
  context.totalMetadataBytes += bytes;
  assert(context.totalMetadataBytes <= RELEASE_EVIDENCE_MAX_TOTAL_METADATA_BYTES,
    "RELEASE_EVIDENCE_LIMIT_EXCEEDED",
    "release evidence metadata exceeds the aggregate size limit");
}

async function normalizeOptionalAttestation({
  descriptor,
  source,
  artifactDigest,
  baseDir,
  context,
  label,
  kind,
}) {
  if (descriptor === null || descriptor === undefined) return null;
  const selected = assertPlainObject(descriptor,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", label);
  const digest = await digestDescriptorFile(selected, baseDir, label, RELEASE_EVIDENCE_MAX_METADATA_BYTES);
  consumeMetadata(context, digest.bytes, label);
  const parsed = await readJsonFile(digest.path, label, RELEASE_EVIDENCE_MAX_METADATA_BYTES, baseDir);
  assert(parsed.bytes === digest.bytes && parsed.sha256 === digest.sha256,
    "RELEASE_EVIDENCE_FILE_CHANGED",
    `${label} changed between hashing and parsing`);
  validateSigstoreBundle(parsed.value, label);
  return normalizeAttestationMetadata({
    value: selected,
    source,
    artifactDigest,
    file: digest,
    label,
    kind,
  });
}

async function normalizeOptionalSbom({
  descriptor,
  source,
  artifactDigest,
  baseDir,
  context,
}) {
  if (descriptor === null || descriptor === undefined) return null;
  const selected = assertPlainObject(descriptor,
    "RELEASE_EVIDENCE_SBOM_INVALID", "artifact.sbom");
  assert(Object.hasOwn(selected, "attestation"), "RELEASE_EVIDENCE_SBOM_INVALID",
    "artifact.sbom.attestation is required when an SBOM is supplied");
  assertAllowedKeys(selected,
    ["path", "file", "fileName", "bytes", "sha256", "subjectSha256", "attestation"],
    "artifact.sbom", "RELEASE_EVIDENCE_SBOM_INVALID");
  const digest = await digestDescriptorFile(selected, baseDir, "SBOM", RELEASE_EVIDENCE_MAX_METADATA_BYTES);
  consumeMetadata(context, digest.bytes, "SBOM");
  const parsed = await readJsonFile(digest.path, "SBOM", RELEASE_EVIDENCE_MAX_METADATA_BYTES, baseDir);
  assert(parsed.bytes === digest.bytes && parsed.sha256 === digest.sha256,
    "RELEASE_EVIDENCE_FILE_CHANGED",
    "SBOM changed between hashing and parsing");
  validateSpdxJson(parsed.value, "SBOM");
  const attestation = await normalizeOptionalAttestation({
    descriptor: selected.attestation,
    source,
    artifactDigest,
    baseDir,
    context,
    label: "sbom.attestation",
    kind: "sbom",
  });
  const fileName = assertSafeFileName(selected.fileName ?? digest.path.split(/[\\/]/u).pop(),
    "sbom.fileName");
  assert(fileName === digest.path.split(/[\\/]/u).pop(),
    "RELEASE_EVIDENCE_FILE_NAME_MISMATCH",
    "sbom.fileName must match the supplied file name");
  if (selected.subjectSha256 !== undefined) {
    assert(selected.subjectSha256 === artifactDigest, "RELEASE_EVIDENCE_SUBJECT_MISMATCH",
      "sbom.subjectSha256 must match the final artifact SHA-256");
  }
  return {
    format: "spdx-json",
    fileName,
    bytes: digest.bytes,
    sha256: digest.sha256,
    subjectSha256: artifactDigest,
    source: { ...source },
    attestation,
  };
}

async function normalizeStoreReceipt({
  descriptor,
  productName,
  release,
  provider,
  listing,
  artifactFile,
  baseDir,
  context,
}) {
  const selected = assertPlainObject(descriptor,
    "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID", "artifact.store.receipt");
  assertAllowedKeys(selected, ["path", "file", "fileName", "bytes", "sha256"],
    "artifact.store.receipt", "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID");
  const digest = await digestDescriptorFile(selected, baseDir,
    "Store delivery receipt", RELEASE_EVIDENCE_MAX_METADATA_BYTES);
  consumeMetadata(context, digest.bytes, "Store delivery receipt");
  const parsed = await readJsonFile(digest.path, "Store delivery receipt",
    RELEASE_EVIDENCE_MAX_METADATA_BYTES, baseDir);
  assert(parsed.bytes === digest.bytes && parsed.sha256 === digest.sha256,
    "RELEASE_EVIDENCE_FILE_CHANGED",
    "Store delivery receipt changed between hashing and parsing");
  validateStoreDeliveryReceipt(parsed.value, {
    label: "Store delivery receipt",
    productName,
    release,
    provider,
    listing,
    artifactFileName: artifactFile.path.split(/[\\/]/u).pop(),
    artifactBytes: artifactFile.bytes,
    artifactSha256: artifactFile.sha256,
  });
  const fileName = assertSafeFileName(selected.fileName
    ?? digest.path.split(/[\\/]/u).pop(), "store.receipt.fileName");
  assert(fileName === digest.path.split(/[\\/]/u).pop(),
    "RELEASE_EVIDENCE_FILE_NAME_MISMATCH",
    "store.receipt.fileName must match the supplied file name");
  if (selected.bytes !== undefined) assert(selected.bytes === digest.bytes,
    "RELEASE_EVIDENCE_BYTES_MISMATCH",
    "store.receipt.bytes does not match the supplied file");
  if (selected.sha256 !== undefined) assert(selected.sha256 === digest.sha256,
    "RELEASE_EVIDENCE_HASH_MISMATCH",
    "store.receipt.sha256 does not match the supplied file");
  return {
    format: RELEASE_EVIDENCE_STORE_RECEIPT_FORMAT,
    schemaVersion: RELEASE_EVIDENCE_STORE_RECEIPT_SCHEMA_VERSION,
    fileName,
    bytes: digest.bytes,
    sha256: digest.sha256,
    subjectSha256: artifactFile.sha256,
  };
}

async function normalizeArtifact(descriptor, release, productName, baseDir, context) {
  const selected = assertPlainObject(descriptor,
    "RELEASE_EVIDENCE_ARTIFACT_INVALID", "artifact");
  assertAllowedKeys(selected, [
    "platform", "channel", "architecture", "format", "version", "path", "file", "fileName",
    "bytes", "sha256", "source", "distribution", "downloadUrl", "nativeTrust", "build",
    "sbom", "provenance", "assurances", "platformAssurances", "store", "updater",
  ], "artifact", "RELEASE_EVIDENCE_ARTIFACT_INVALID");
  const platform = assertPlatform(selected.platform);
  const channel = assertChannel(selected.channel);
  const architecture = assertArchitecture(selected.architecture);
  const format = assertFormat(selected.format);
  const artifactPath = resolveDescriptorPath(
    selected.path === undefined ? selected.file : selected.path,
    baseDir,
    "artifact.path",
  );
  const artifactFile = await digestRegularFile(artifactPath, "artifact", null, baseDir);
  const fileName = assertSafeFileName(selected.fileName ?? artifactPath.split(/[\\/]/u).pop(),
    "artifact.fileName");
  assert(fileName === artifactPath.split(/[\\/]/u).pop(),
    "RELEASE_EVIDENCE_FILE_NAME_MISMATCH",
    "artifact.fileName must match the supplied file name");
  if (selected.bytes !== undefined) assert(selected.bytes === artifactFile.bytes,
    "RELEASE_EVIDENCE_BYTES_MISMATCH", "artifact.bytes does not match the supplied file");
  if (selected.sha256 !== undefined) assert(selected.sha256 === artifactFile.sha256,
    "RELEASE_EVIDENCE_HASH_MISMATCH", "artifact.sha256 does not match the supplied file");
  const artifactVersion = selected.version ?? release.version;
  assertVersion(artifactVersion, "artifact.version");
  assert(artifactVersion === release.version, "RELEASE_EVIDENCE_VERSION_MISMATCH",
    "artifact.version does not match the release");
  const source = normalizeSource({ value: selected.source, release, label: "artifact.source" });
  const sbom = await normalizeOptionalSbom({
    descriptor: selected.sbom,
    source,
    artifactDigest: artifactFile.sha256,
    baseDir,
    context,
  });
  const provenance = await normalizeOptionalAttestation({
    descriptor: selected.provenance,
    source,
    artifactDigest: artifactFile.sha256,
    baseDir,
    context,
    label: "provenance",
    kind: "provenance",
  });
  const updaterInput = selected.updater;
  assert(updaterInput !== undefined, "RELEASE_EVIDENCE_UPDATER_INVALID",
    "artifact.updater is required");
  let updaterMetadata = null;
  if (isPlainObject(updaterInput) && updaterInput.enabled === true
      && isPlainObject(updaterInput.metadata)) {
    const metadataDescriptor = updaterInput.metadata;
    const metadataDigest = await digestDescriptorFile(metadataDescriptor, baseDir,
      "updater metadata", RELEASE_EVIDENCE_MAX_METADATA_BYTES);
    consumeMetadata(context, metadataDigest.bytes, "updater metadata");
    const metadataName = assertSafeFileName(metadataDescriptor.fileName
      ?? metadataDigest.path.split(/[\\/]/u).pop(), "updater.metadata.fileName");
    assert(metadataName === metadataDigest.path.split(/[\\/]/u).pop(),
      "RELEASE_EVIDENCE_FILE_NAME_MISMATCH",
      "updater.metadata.fileName must match the supplied file name");
    if (metadataDescriptor.subjectSha256 !== undefined) {
      assert(metadataDescriptor.subjectSha256 === artifactFile.sha256,
        "RELEASE_EVIDENCE_SUBJECT_MISMATCH",
        "updater.metadata.subjectSha256 must match the final artifact SHA-256");
    }
    updaterMetadata = {
      fileName: metadataName,
      bytes: metadataDigest.bytes,
      sha256: metadataDigest.sha256,
      subjectSha256: artifactFile.sha256,
    };
  }
  const updater = normalizeUpdater(updaterInput, platform, channel,
    "updater", updaterMetadata);
  const assurances = validateAssurances(
    selected.assurances === undefined ? selected.platformAssurances : selected.assurances,
    platform,
    channel,
    "artifact.assurances",
  );
  let store = normalizeStore(selected.store, platform, channel, "artifact.store", {
    artifactDigest: artifactFile.sha256,
    allowReceiptPath: true,
  });
  if (store !== null) {
    const receipt = await normalizeStoreReceipt({
      descriptor: store.receiptDescriptor,
      productName,
      release,
      provider: store.provider,
      listing: store.listing,
      artifactFile,
      baseDir,
      context,
    });
    store = { provider: store.provider, listing: store.listing, receipt };
  }
  const nativeTrust = normalizeNativeTrust({
    value: selected.nativeTrust,
    platform,
    channel,
    store,
    label: "artifact.nativeTrust",
  });
  const build = normalizeBuild(selected.build, channel, "artifact.build");
  const distribution = validateDistribution({
    value: selected.distribution,
    channel,
    platform,
    store,
    source,
    fileName,
    downloadUrl: selected.downloadUrl,
    label: "artifact.distribution",
  });
  return {
    platform,
    channel,
    architecture,
    format,
    version: release.version,
    distribution,
    downloadUrl: selected.downloadUrl,
    fileName,
    bytes: artifactFile.bytes,
    sha256: artifactFile.sha256,
    source,
    nativeTrust,
    build,
    sbom,
    provenance,
    assurances,
    store,
    updater,
  };
}

/**
 * Re-open every descriptor-controlled byte source immediately before the
 * generated manifest is returned.  Each digest is taken on one stable file
 * handle and compared with the value already recorded in the manifest.  This
 * closes the useful race window between initial normalization and output
 * publication without retaining local paths in the public manifest.
 */
async function recheckDescriptorFiles(descriptors, manifest, baseDir) {
  for (const descriptor of descriptors) {
    const selected = assertPlainObject(descriptor,
      "RELEASE_EVIDENCE_ARTIFACT_INVALID", "artifact");
    const artifactPath = resolveDescriptorPath(
      selected.path === undefined ? selected.file : selected.path,
      baseDir,
      "artifact.path",
    );
    const artifactFileName = selected.fileName
      ?? artifactPath.split(/[\\/]/u).pop();
    const artifact = manifest.artifacts.find((candidate) => candidate.platform === selected.platform
      && candidate.channel === selected.channel
      && candidate.architecture === selected.architecture
      && candidate.format === selected.format
      && candidate.fileName === artifactFileName);
    assert(artifact !== undefined, "RELEASE_EVIDENCE_ARTIFACT_INVALID",
      "generated artifact disappeared before final publication");
    const artifactDigest = await digestRegularFile(artifactPath,
      "artifact final recheck", null, baseDir);
    assert(artifactDigest.bytes === artifact.bytes && artifactDigest.sha256 === artifact.sha256,
      "RELEASE_EVIDENCE_FILE_CHANGED",
      "artifact changed before release evidence publication");

    const recheckMetadata = async (metadata, expected, label) => {
      if (metadata === null || metadata === undefined || expected === null) return;
      const path = resolveDescriptorPath(metadata.path === undefined
        ? metadata.file : metadata.path, baseDir, `${label}.path`);
      const digest = await digestRegularFile(path, `${label} final recheck`,
        RELEASE_EVIDENCE_MAX_METADATA_BYTES, baseDir);
      assert(digest.bytes === expected.bytes && digest.sha256 === expected.sha256,
        "RELEASE_EVIDENCE_FILE_CHANGED",
        `${label} changed before release evidence publication`);
    };

    await recheckMetadata(selected.sbom, artifact.sbom, "SBOM");
    if (selected.sbom?.attestation !== undefined && selected.sbom?.attestation !== null) {
      await recheckMetadata(selected.sbom.attestation, artifact.sbom?.attestation,
        "SBOM attestation");
    }
    await recheckMetadata(selected.provenance, artifact.provenance, "provenance");
    if (selected.store !== undefined && selected.store !== null) {
      await recheckMetadata(selected.store.receipt, artifact.store?.receipt,
        "Store delivery receipt");
    }
    if (selected.updater?.enabled === true) {
      await recheckMetadata(selected.updater.metadata, artifact.updater.metadata,
        "updater metadata");
    }
  }
}

export async function generateReleaseEvidence({ descriptor, baseDir = process.cwd() }) {
  const input = typeof descriptor === "string"
    ? (await readJsonFile(descriptor, "release descriptor", RELEASE_EVIDENCE_MAX_METADATA_BYTES)).value
    : descriptor;
  const identity = validateReleaseIdentity(input);
  assert(Array.isArray(input.artifacts) && input.artifacts.length > 0,
    "RELEASE_EVIDENCE_ARTIFACT_INVALID", "release input must supply at least one artifact");
  assert(input.artifacts.length <= RELEASE_EVIDENCE_MAX_ARTIFACTS,
    "RELEASE_EVIDENCE_LIMIT_EXCEEDED", "release input contains too many artifacts");
  const context = { totalMetadataBytes: 0 };
  const artifacts = [];
  for (const descriptorArtifact of input.artifacts) {
    artifacts.push(await normalizeArtifact(descriptorArtifact, identity.release,
      identity.product.name, resolve(baseDir), context));
  }
  artifacts.sort(compareArtifactIdentity);
  const manifest = {
    schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
    product: identity.product,
    version: identity.release.version,
    tag: identity.release.tag,
    commit: identity.release.commit,
    repository: identity.release.repository,
    artifacts,
  };
  validateCanonicalManifest(manifest);
  await recheckDescriptorFiles(input.artifacts, manifest, resolve(baseDir));
  return manifest;
}

export { validateReleaseIdentity, normalizeArtifact };
