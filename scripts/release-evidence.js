#!/usr/bin/env node

/**
 * Public facade for the cross-platform release-evidence contract.
 *
 * The implementation is split into primitives (safe file/digest mechanics),
 * policy (canonical validation), descriptor normalization, and output.  Keep
 * this file as the stable import surface for release callers and tests.
 */

export {
  ReleaseEvidenceError,
  assert,
  assertBoolean,
  assertByteCount,
  assertCanonicalSubjectDigest,
  assertHttpsUrl,
  assertPlainObject,
  assertSafeFileName,
  assertSafeText,
  assertSha256,
  compareCodeUnits,
  digestDescriptorFile,
  digestRegularFile,
  isPlainObject,
  pathWithin,
  readJsonFile,
  readTextFile,
  resolveDescriptorPath,
  sha256Bytes,
  stableStringify,
} from "./release-evidence-primitives.js";

export {
  artifactIdentity,
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
  buildSha256Sums,
  compareArtifactIdentity,
  normalizeAttestationMetadata,
  normalizeBuild,
  normalizeNativeTrust,
  normalizeSource,
  normalizeStore,
  normalizeUpdater,
  RELEASE_EVIDENCE_MANIFEST_FILE_NAME,
  RELEASE_EVIDENCE_SIGSTORE_FORMAT,
  RELEASE_EVIDENCE_SPDX_FORMAT,
  RELEASE_EVIDENCE_SUMS_FILE_NAME,
  validateAssurances,
  validateCanonicalArtifact,
  validateCanonicalAttestation,
  validateCanonicalManifest,
  validateSigstoreBundle,
  validateStoreDeliveryReceipt,
  validateDistribution,
  validateSpdxJson,
} from "./release-evidence-policy.js";

export {
  generateReleaseEvidence,
  validateReleaseIdentity,
} from "./release-evidence-descriptor.js";

export {
  validateReleaseEvidenceManifest,
  writeReleaseEvidenceFiles,
} from "./release-evidence-output.js";
