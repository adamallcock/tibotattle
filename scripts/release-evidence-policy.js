/**
 * Canonical release-evidence policy.
 *
 * Generation and validation both call these routines.  The functions are
 * intentionally offline: attestation metadata is a claim about a bundle;
 * cryptographic verification belongs to the protected finalizer/gh CLI.
 */

import {
  RELEASE_EVIDENCE_ALLOWED_PLATFORM_ASSURANCES,
  RELEASE_EVIDENCE_ARCHITECTURE_PATTERN,
  RELEASE_EVIDENCE_CHANNELS,
  RELEASE_EVIDENCE_COMMIT_PATTERN,
  RELEASE_EVIDENCE_DEFAULT_UPDATER_MECHANISMS,
  RELEASE_EVIDENCE_DISTRIBUTION_PATTERN,
  RELEASE_EVIDENCE_FORMAT_PATTERN,
  RELEASE_EVIDENCE_GITHUB_REPOSITORY_SLUG_PATTERN,
  RELEASE_EVIDENCE_MAX_ARTIFACTS,
  RELEASE_EVIDENCE_PLATFORM_ASSURANCES,
  RELEASE_EVIDENCE_PLATFORMS,
  RELEASE_EVIDENCE_PROVENANCE_MEDIA_TYPE_PATTERN,
  RELEASE_EVIDENCE_PROVENANCE_PREDICATE_PATTERN,
  RELEASE_EVIDENCE_SCHEMA_VERSION,
  RELEASE_EVIDENCE_STORE_RECEIPT_FORMAT,
  RELEASE_EVIDENCE_STORE_RECEIPT_SCHEMA_VERSION,
  RELEASE_EVIDENCE_SBOM_PREDICATE_PATTERN,
  RELEASE_EVIDENCE_SIGNER_DIGEST_PATTERN,
  RELEASE_EVIDENCE_SIGNER_WORKFLOW_PATTERN,
  RELEASE_EVIDENCE_STORE_LISTING_HOSTS,
  RELEASE_EVIDENCE_STORE_PROVIDERS,
  RELEASE_EVIDENCE_TAG_PATTERN,
  RELEASE_EVIDENCE_VERSION_PATTERN,
  RELEASE_EVIDENCE_RUN_URL_PATTERN,
} from "../config/release-evidence.js";

const ALL_STORE_PROVIDERS = new Set(
  Object.values(RELEASE_EVIDENCE_STORE_PROVIDERS).flat(),
);
import {
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
  fail,
  isPlainObject,
  sha256Bytes,
  stableStringify,
} from "./release-evidence-primitives.js";

export const RELEASE_EVIDENCE_MANIFEST_FILE_NAME = "release-manifest.json";
export const RELEASE_EVIDENCE_SUMS_FILE_NAME = "SHA256SUMS";
export const RELEASE_EVIDENCE_SPDX_FORMAT = "spdx-json";
export const RELEASE_EVIDENCE_SIGSTORE_FORMAT = "sigstore-bundle";

export function assertVersion(value, label = "version") {
  return assertSafeText(value, "RELEASE_EVIDENCE_VERSION_INVALID", label, {
    pattern: RELEASE_EVIDENCE_VERSION_PATTERN,
    maximumBytes: 128,
  });
}

export function assertTag(value, label = "tag") {
  return assertSafeText(value, "RELEASE_EVIDENCE_TAG_INVALID", label, {
    pattern: RELEASE_EVIDENCE_TAG_PATTERN,
    maximumBytes: 128,
  });
}

export function assertCommit(value, label = "commit") {
  return assertSafeText(value, "RELEASE_EVIDENCE_COMMIT_INVALID", label, {
    pattern: RELEASE_EVIDENCE_COMMIT_PATTERN,
    maximumBytes: 64,
  });
}

export function assertRepository(value, label = "repository") {
  assertSafeText(value, "RELEASE_EVIDENCE_REPOSITORY_INVALID", label, {
    maximumBytes: 512,
  });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("RELEASE_EVIDENCE_REPOSITORY_INVALID",
      `${label} must be a canonical HTTPS URL`);
  }
  assert(parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.pathname.length > 1
      && !parsed.pathname.endsWith("/")
      && !parsed.pathname.endsWith(".git")
      && parsed.hostname === parsed.hostname.toLowerCase()
      && parsed.href === value,
  "RELEASE_EVIDENCE_REPOSITORY_INVALID",
  `${label} must be a canonical HTTPS repository URL`);
  return value;
}

export function assertPlatform(value) {
  assert(RELEASE_EVIDENCE_PLATFORMS.includes(value),
    "RELEASE_EVIDENCE_PLATFORM_INVALID",
    `Unsupported release platform: ${String(value)}`);
  return value;
}

export function assertChannel(value) {
  assert(RELEASE_EVIDENCE_CHANNELS.includes(value),
    "RELEASE_EVIDENCE_CHANNEL_INVALID",
    `Unsupported release channel: ${String(value)}`);
  return value;
}

export function assertArchitecture(value) {
  return assertSafeText(value, "RELEASE_EVIDENCE_ARCHITECTURE_INVALID", "architecture", {
    pattern: RELEASE_EVIDENCE_ARCHITECTURE_PATTERN,
    maximumBytes: 64,
  });
}

export function assertFormat(value) {
  return assertSafeText(value, "RELEASE_EVIDENCE_FORMAT_INVALID", "format", {
    pattern: RELEASE_EVIDENCE_FORMAT_PATTERN,
    maximumBytes: 64,
  });
}

export function assertDistribution(value) {
  return assertSafeText(value, "RELEASE_EVIDENCE_DISTRIBUTION_INVALID", "distribution", {
    pattern: RELEASE_EVIDENCE_DISTRIBUTION_PATTERN,
    maximumBytes: 64,
  });
}

export function assertAllowedKeys(value, allowed, label, code = "RELEASE_EVIDENCE_POLICY_INVALID") {
  for (const key of Object.keys(value)) {
    assert(allowed.includes(key), code,
      `${label}.${key} is not supported by the checked-in contract`);
  }
}

/**
 * Check the JSON shape of a Sigstore bundle without claiming that its
 * signature, certificate, transparency log entry, or timestamp is valid.
 * Cryptographic verification is deliberately performed by the protected
 * release finalizer (for example, `gh attestation verify --bundle`).
 */
export function validateSigstoreBundle(value, label = "sigstore bundle") {
  const bundle = assertPlainObject(value,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", label);
  assert(RELEASE_EVIDENCE_PROVENANCE_MEDIA_TYPE_PATTERN.test(bundle.mediaType),
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.mediaType must identify a Sigstore bundle v0.3`);
  const verificationMaterial = assertPlainObject(bundle.verificationMaterial,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", `${label}.verificationMaterial`);
  const hasKnownVerificationMaterial = (isPlainObject(verificationMaterial.certificate)
      && Object.keys(verificationMaterial.certificate).length > 0)
    || (isPlainObject(verificationMaterial.x509CertificateChain)
      && Object.keys(verificationMaterial.x509CertificateChain).length > 0)
    || (Array.isArray(verificationMaterial.tlogEntries)
      && verificationMaterial.tlogEntries.length > 0)
    || (isPlainObject(verificationMaterial.timestampVerificationData)
      && Object.keys(verificationMaterial.timestampVerificationData).length > 0);
  assert(hasKnownVerificationMaterial,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.verificationMaterial must contain bundle verification material`);
  const dsseEnvelope = bundle.dsseEnvelope;
  const messageSignature = bundle.messageSignature;
  assert(!(dsseEnvelope !== undefined && messageSignature !== undefined),
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label} must contain one DSSE or message-signature content container`);
  if (dsseEnvelope !== undefined) {
    assertPlainObject(dsseEnvelope, "RELEASE_EVIDENCE_PROVENANCE_INVALID",
      `${label}.dsseEnvelope`);
    assert(typeof dsseEnvelope.payload === "string" && dsseEnvelope.payload.length > 0,
      "RELEASE_EVIDENCE_PROVENANCE_INVALID",
      `${label}.dsseEnvelope.payload must be non-empty`);
    assert(typeof dsseEnvelope.payloadType === "string" && dsseEnvelope.payloadType.length > 0,
      "RELEASE_EVIDENCE_PROVENANCE_INVALID",
      `${label}.dsseEnvelope.payloadType must be non-empty`);
    assert(Array.isArray(dsseEnvelope.signatures) && dsseEnvelope.signatures.length > 0
        && dsseEnvelope.signatures.every((signature) => isPlainObject(signature)
          && typeof signature.sig === "string" && signature.sig.length > 0),
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.dsseEnvelope.signatures must contain a signature`);
  } else {
    assertPlainObject(messageSignature, "RELEASE_EVIDENCE_PROVENANCE_INVALID",
      `${label}.messageSignature`);
    assert(typeof messageSignature.signature === "string"
        && messageSignature.signature.length > 0,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.messageSignature.signature must be non-empty`);
  }
  return bundle;
}

export function sourceObject({ version, tag, commit, repository }) {
  return { version, tag, commit, repository };
}

export function normalizeSource({ value, release, label }) {
  if (value === undefined) return sourceObject(release);
  const selected = assertPlainObject(value, "RELEASE_EVIDENCE_SOURCE_INVALID", label);
  assertAllowedKeys(selected, ["version", "tag", "commit", "repository"], label,
    "RELEASE_EVIDENCE_SOURCE_INVALID");
  const normalized = sourceObject({
    version: selected.version === undefined ? release.version : selected.version,
    tag: selected.tag === undefined ? release.tag : selected.tag,
    commit: selected.commit === undefined ? release.commit : selected.commit,
    repository: selected.repository === undefined ? release.repository : selected.repository,
  });
  assertVersion(normalized.version, `${label}.version`);
  assertTag(normalized.tag, `${label}.tag`);
  assertCommit(normalized.commit, `${label}.commit`);
  assertRepository(normalized.repository, `${label}.repository`);
  assert(normalized.version === release.version,
    "RELEASE_EVIDENCE_VERSION_MISMATCH", `${label}.version does not match the release`);
  assert(normalized.tag === release.tag
      && normalized.commit === release.commit
      && normalized.repository === release.repository,
  "RELEASE_EVIDENCE_SOURCE_MISMATCH",
  `${label} does not identify the exact release source`);
  return normalized;
}

export function validateAssurances(value, platform, channel, label) {
  const assurances = assertPlainObject(value,
    "RELEASE_EVIDENCE_ASSURANCES_INVALID", label);
  assertAllowedKeys(assurances,
    RELEASE_EVIDENCE_ALLOWED_PLATFORM_ASSURANCES[platform][channel], label,
    "RELEASE_EVIDENCE_ASSURANCES_UNKNOWN");
  for (const [key, assurance] of Object.entries(assurances)) {
    assert(typeof assurance === "boolean", "RELEASE_EVIDENCE_ASSURANCES_INVALID",
      `${label}.${key} must be boolean`);
  }
  for (const key of RELEASE_EVIDENCE_PLATFORM_ASSURANCES[platform][channel]) {
    assert(assurances[key] === true, "RELEASE_EVIDENCE_ASSURANCES_INCOMPLETE",
      `${label}.${key} must be true for ${platform}/${channel}`);
  }
  return assurances;
}

function storeListingUrl(value, provider, label) {
  const listing = assertHttpsUrl(value, "RELEASE_EVIDENCE_STORE_INVALID", label, {
    maximumBytes: 2048,
  });
  const hostAllowlist = RELEASE_EVIDENCE_STORE_LISTING_HOSTS[provider] ?? [];
  if (hostAllowlist.length > 0) {
    const hostname = new URL(listing).hostname.toLowerCase();
    assert(hostAllowlist.includes(hostname), "RELEASE_EVIDENCE_STORE_INVALID",
      `${label} must use a canonical ${provider} host`);
  }
  return listing;
}

const STORE_RECEIPT_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})Z$/u;

/**
 * Validate the machine-readable evidence produced after a store package has
 * been retrieved from its public listing.  The receipt is intentionally
 * bound to the release and final artifact bytes here; an upload candidate
 * must use a different subjectKind and cannot satisfy this contract.
 */
export function validateStoreDeliveryReceipt(value, {
  label = "store delivery receipt",
  productName,
  release,
  provider,
  listing,
  artifactFileName,
  artifactBytes,
  artifactSha256,
} = {}) {
  const receipt = assertPlainObject(value,
    "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID", label);
  assertAllowedKeys(receipt, [
    "schemaVersion", "format", "product", "provider", "listing",
    "version", "tag", "commit", "repository", "artifactFileName",
    "artifactBytes", "artifactSha256", "subjectKind", "deliveryState",
    "uploadCandidate", "retrievedAt",
  ], label, "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID");
  assert(receipt.schemaVersion === RELEASE_EVIDENCE_STORE_RECEIPT_SCHEMA_VERSION,
    "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID",
    `${label}.schemaVersion is invalid`);
  assert(receipt.format === RELEASE_EVIDENCE_STORE_RECEIPT_FORMAT,
    "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID",
    `${label}.format is invalid`);
  assertSafeText(receipt.product, "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID",
    `${label}.product`, { maximumBytes: 1024 });
  assertSafeText(receipt.provider, "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID",
    `${label}.provider`, { pattern: /^[a-z][a-z0-9-]{1,63}$/u, maximumBytes: 64 });
  assert(receipt.provider === provider, "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID",
    `${label}.provider must match the manifest store provider`);
  const receiptListing = storeListingUrl(receipt.listing, receipt.provider,
    `${label}.listing`);
  assert(receiptListing === listing, "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID",
    `${label}.listing must match the manifest Store listing`);
  const receiptVersion = assertVersion(receipt.version, `${label}.version`);
  const receiptTag = assertTag(receipt.tag, `${label}.tag`);
  const receiptCommit = assertCommit(receipt.commit, `${label}.commit`);
  const receiptRepository = assertRepository(receipt.repository, `${label}.repository`);
  assert(receiptVersion === release.version && receiptTag === release.tag
      && receiptCommit === release.commit && receiptRepository === release.repository,
  "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID",
  `${label} must identify the exact release source`);
  assertSafeText(receipt.artifactFileName,
    "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID", `${label}.artifactFileName`, {
      maximumBytes: 256,
    });
  assertSafeFileName(receipt.artifactFileName, `${label}.artifactFileName`);
  assert(receipt.artifactFileName === artifactFileName,
    "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID",
    `${label}.artifactFileName must match the final Store subject`);
  assertByteCount(receipt.artifactBytes, `${label}.artifactBytes`);
  assert(receipt.artifactBytes === artifactBytes,
    "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID",
    `${label}.artifactBytes must match the final Store subject`);
  assertCanonicalSubjectDigest(receipt.artifactSha256, artifactSha256,
    `${label}.artifactSha256`);
  assert(receipt.subjectKind === "store-retrieved",
    "RELEASE_EVIDENCE_STORE_RECEIPT_NOT_DELIVERED",
    `${label}.subjectKind must be store-retrieved`);
  assert(receipt.deliveryState === "final",
    "RELEASE_EVIDENCE_STORE_RECEIPT_NOT_DELIVERED",
    `${label}.deliveryState must be final`);
  assert(receipt.uploadCandidate === false,
    "RELEASE_EVIDENCE_STORE_RECEIPT_NOT_DELIVERED",
    `${label}.uploadCandidate must be false`);
  assertSafeText(receipt.retrievedAt,
    "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID", `${label}.retrievedAt`, {
      pattern: STORE_RECEIPT_TIME_PATTERN,
      maximumBytes: 24,
    });
  assert(Number.isFinite(Date.parse(receipt.retrievedAt)),
    "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID",
    `${label}.retrievedAt must be a valid UTC timestamp`);
  if (productName !== undefined) {
    assert(receipt.product === productName,
      "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID",
      `${label}.product must match the manifest product`);
  }
  return receipt;
}

function normalizeStoreReceiptMetadata(value, artifactDigest, label) {
  const receipt = assertPlainObject(value,
    "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID", label);
  assertAllowedKeys(receipt, [
    "format", "schemaVersion", "fileName", "bytes", "sha256", "subjectSha256",
  ], label, "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID");
  assert(receipt.format === RELEASE_EVIDENCE_STORE_RECEIPT_FORMAT,
    "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID", `${label}.format is invalid`);
  assert(receipt.schemaVersion === RELEASE_EVIDENCE_STORE_RECEIPT_SCHEMA_VERSION,
    "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID", `${label}.schemaVersion is invalid`);
  assertSafeFileName(receipt.fileName, `${label}.fileName`);
  assertByteCount(receipt.bytes, `${label}.bytes`);
  assertSha256(receipt.sha256, `${label}.sha256`);
  assertCanonicalSubjectDigest(receipt.subjectSha256, artifactDigest,
    `${label}.subjectSha256`);
  return {
    format: RELEASE_EVIDENCE_STORE_RECEIPT_FORMAT,
    schemaVersion: RELEASE_EVIDENCE_STORE_RECEIPT_SCHEMA_VERSION,
    fileName: receipt.fileName,
    bytes: receipt.bytes,
    sha256: receipt.sha256,
    subjectSha256: artifactDigest,
  };
}

export function normalizeStore(value, platform, channel, label, {
  artifactDigest = null,
  allowReceiptPath = false,
} = {}) {
  if (channel === "direct") {
    assert(value === null || value === undefined,
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      `${label} must be null for a direct artifact`);
    return null;
  }
  const store = assertPlainObject(value, "RELEASE_EVIDENCE_STORE_INVALID", label);
  assertAllowedKeys(store, ["provider", "listing", "receipt"], label,
    "RELEASE_EVIDENCE_STORE_INVALID");
  const provider = assertSafeText(store.provider, "RELEASE_EVIDENCE_STORE_INVALID",
    `${label}.provider`, {
      pattern: /^[a-z][a-z0-9-]{1,63}$/u,
      maximumBytes: 64,
    });
  assert(RELEASE_EVIDENCE_STORE_PROVIDERS[platform]?.includes(provider),
    "RELEASE_EVIDENCE_STORE_INVALID",
    `${label}.provider is not valid for ${platform}`);
  const listing = storeListingUrl(store.listing, provider, `${label}.listing`);
  assert(artifactDigest !== null, "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID",
    `${label} requires the final artifact digest`);
  if (allowReceiptPath && isPlainObject(store.receipt)
      && (store.receipt.path !== undefined || store.receipt.file !== undefined)) {
    assertAllowedKeys(store.receipt, ["path", "file", "fileName", "bytes", "sha256"],
      `${label}.receipt`, "RELEASE_EVIDENCE_STORE_RECEIPT_INVALID");
    return { provider, listing, receiptDescriptor: store.receipt };
  }
  const receipt = normalizeStoreReceiptMetadata(store.receipt, artifactDigest,
    `${label}.receipt`);
  return { provider, listing, receipt };
}

export function normalizeNativeTrust({ value, platform, channel, store, label }) {
  const trust = assertPlainObject(value, "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", label);
  if (channel === "store") {
    assertAllowedKeys(trust, ["provider", "publisher", "listing"], label,
      "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID");
    const provider = assertSafeText(trust.provider,
      "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", `${label}.provider`, {
        pattern: /^[a-z][a-z0-9-]{1,63}$/u,
        maximumBytes: 64,
      });
    assert(store?.provider === provider,
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      `${label}.provider must match the store distribution`);
    const listing = storeListingUrl(trust.listing, provider, `${label}.listing`);
    assert(store?.listing === listing,
      "RELEASE_EVIDENCE_STORE_INVALID",
      `${label}.listing must match store.listing and artifact.downloadUrl`);
    return {
      provider,
      publisher: assertSafeText(trust.publisher,
        "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", `${label}.publisher`, {
          maximumBytes: 512,
        }),
      listing,
    };
  }
  if (platform === "macos") {
    assertAllowedKeys(trust, ["signerIdentity", "teamId"], label,
      "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID");
    return {
      signerIdentity: assertSafeText(trust.signerIdentity,
        "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", `${label}.signerIdentity`, {
          maximumBytes: 512,
        }),
      teamId: assertSafeText(trust.teamId,
        "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", `${label}.teamId`, {
          pattern: /^[A-Z0-9]{10}$/u,
          maximumBytes: 10,
        }),
    };
  }
  if (platform === "windows") {
    assertAllowedKeys(trust, ["publisher", "certificateSha256", "timestampAuthority"], label,
      "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID");
    const result = {
      publisher: assertSafeText(trust.publisher,
        "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", `${label}.publisher`, {
          maximumBytes: 512,
        }),
      certificateSha256: assertSha256(trust.certificateSha256, `${label}.certificateSha256`),
    };
    if (trust.timestampAuthority !== undefined) {
      result.timestampAuthority = assertSafeText(trust.timestampAuthority,
        "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", `${label}.timestampAuthority`, {
          maximumBytes: 512,
        });
    }
    return result;
  }
  assertAllowedKeys(trust, ["scheme", "keyFingerprint"], label,
    "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID");
  const scheme = assertSafeText(trust.scheme, "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID",
    `${label}.scheme`, {
      pattern: /^[a-z][a-z0-9-]{1,63}$/u,
      maximumBytes: 64,
    });
  assert(["none", "appimage-detached", "apt-repository", "rpm-repository"].includes(scheme),
    "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID",
    `${label}.scheme is not supported for Linux direct artifacts`);
  if (scheme === "none") {
    assert(trust.keyFingerprint === undefined,
      "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID",
      `${label}.keyFingerprint is not valid when scheme is none`);
    return { scheme };
  }
  return {
    scheme,
    keyFingerprint: assertSafeText(trust.keyFingerprint,
      "RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", `${label}.keyFingerprint`, {
        pattern: /^[A-Fa-f0-9]{40,64}$/u,
        maximumBytes: 64,
      }).toUpperCase(),
  };
}

export function normalizeBuild(value, channel, label) {
  if (channel === "store") {
    assert(value === null, "RELEASE_EVIDENCE_BUILD_INVALID",
      `${label} must be null for a Store-delivered subject`);
    return null;
  }
  const build = assertPlainObject(value, "RELEASE_EVIDENCE_BUILD_INVALID", label);
  assertAllowedKeys(build, ["sourceManifestSha256", "unsignedPayloadSha256"], label,
    "RELEASE_EVIDENCE_BUILD_INVALID");
  return {
    sourceManifestSha256: assertSha256(build.sourceManifestSha256,
      `${label}.sourceManifestSha256`),
    unsignedPayloadSha256: assertSha256(build.unsignedPayloadSha256,
      `${label}.unsignedPayloadSha256`),
  };
}

export function validateDistribution({
  value,
  channel,
  platform,
  store,
  source,
  fileName,
  downloadUrl,
  label,
}) {
  const distribution = assertDistribution(value);
  const selectedUrl = assertHttpsUrl(downloadUrl,
    "RELEASE_EVIDENCE_DOWNLOAD_URL_INVALID", `${label}.downloadUrl`);
  if (channel === "store") {
    assert(store !== null && distribution === store.provider,
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      `${label} must identify the supplied store provider`);
    assert(store.listing === selectedUrl,
      "RELEASE_EVIDENCE_STORE_INVALID",
      `${label}.downloadUrl must equal the verified Store listing URL`);
    return distribution;
  }
  assert(!ALL_STORE_PROVIDERS.has(distribution),
    "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
    `${label} cannot identify any Store provider for a direct artifact`);
  if (distribution === "github-release") {
    const repositoryUrl = new URL(source.repository);
    assert(repositoryUrl.hostname === "github.com",
      "RELEASE_EVIDENCE_DOWNLOAD_URL_MISMATCH",
      "github-release distribution requires a GitHub source repository");
    const expectedPath = `${repositoryUrl.pathname}/releases/download/`
      + `${encodeURIComponent(source.tag)}/${encodeURIComponent(fileName)}`;
    const parsed = new URL(selectedUrl);
    assert(parsed.origin === repositoryUrl.origin && parsed.pathname === expectedPath,
      "RELEASE_EVIDENCE_DOWNLOAD_URL_MISMATCH",
      "GitHub release downloadUrl must identify the exact tag and artifact file");
  }
  return distribution;
}

export function normalizeSignerMetadata({ value, source, label }) {
  assertAllowedKeys(value, [
    "mediaType", "predicateType", "builderId", "fileName", "bytes", "sha256",
    "subjectSha256", "verificationStatus", "signerRepository", "signerWorkflow", "signerDigest", "runUrl",
    "denySelfHostedRunners", "path", "file",
  ], label, "RELEASE_EVIDENCE_PROVENANCE_INVALID");
  const signerWorkflow = assertSafeText(value.signerWorkflow,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", `${label}.signerWorkflow`, {
      pattern: RELEASE_EVIDENCE_SIGNER_WORKFLOW_PATTERN,
      maximumBytes: 512,
    });
  const repository = new URL(source.repository);
  assert(repository.hostname === "github.com",
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.signerWorkflow requires a GitHub repository source`);
  const repositorySlug = repository.pathname.slice(1);
  const signerRepository = assertSafeText(
    value.signerRepository === undefined ? repositorySlug : value.signerRepository,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", `${label}.signerRepository`, {
      pattern: RELEASE_EVIDENCE_GITHUB_REPOSITORY_SLUG_PATTERN,
      maximumBytes: 256,
    });
  assert(signerWorkflow.startsWith(`${signerRepository}/.github/workflows/`),
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.signerWorkflow must belong to signerRepository`);
  if (value.signerRepository === undefined) {
    assert(signerRepository === repositorySlug,
      "RELEASE_EVIDENCE_PROVENANCE_INVALID",
      `${label}.signerWorkflow must belong to the release repository unless signerRepository is explicit`);
  }
  const signerDigest = assertSafeText(value.signerDigest,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", `${label}.signerDigest`, {
      pattern: RELEASE_EVIDENCE_SIGNER_DIGEST_PATTERN,
      maximumBytes: 40,
    });
  const runUrl = assertHttpsUrl(value.runUrl,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", `${label}.runUrl`, { maximumBytes: 512 });
  assert(RELEASE_EVIDENCE_RUN_URL_PATTERN.test(runUrl),
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.runUrl must identify a GitHub Actions run`);
  const sourceRepositoryUrl = new URL(source.repository);
  const signerRepositoryUrl = new URL(`https://github.com/${signerRepository}`);
  const sourceRunPrefix = `${sourceRepositoryUrl.origin}${sourceRepositoryUrl.pathname}/actions/runs/`;
  const signerRunPrefix = `${signerRepositoryUrl.origin}${signerRepositoryUrl.pathname}/actions/runs/`;
  assert(runUrl.startsWith(sourceRunPrefix) || runUrl.startsWith(signerRunPrefix),
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.runUrl must belong to the release or signer repository`);
  assert(value.denySelfHostedRunners === true,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.denySelfHostedRunners must be true`);
  return {
    signerRepository,
    signerWorkflow,
    signerDigest,
    runUrl,
    verificationInputs: {
      command: "gh attestation verify --bundle",
      bundleRequired: true,
      denySelfHostedRunners: true,
    },
  };
}

export function normalizeAttestationMetadata({
  value,
  source,
  artifactDigest,
  file,
  label,
  kind = "provenance",
}) {
  const selected = assertPlainObject(value,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", label);
  const mediaType = assertSafeText(selected.mediaType,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", `${label}.mediaType`, {
      pattern: RELEASE_EVIDENCE_PROVENANCE_MEDIA_TYPE_PATTERN,
    });
  const predicateType = assertSafeText(selected.predicateType,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", `${label}.predicateType`, {
      pattern: kind === "sbom"
        ? RELEASE_EVIDENCE_SBOM_PREDICATE_PATTERN
        : RELEASE_EVIDENCE_PROVENANCE_PREDICATE_PATTERN,
    });
  assertCanonicalSubjectDigest(selected.subjectSha256 ?? artifactDigest,
    artifactDigest, `${label}.subjectSha256`);
  const signer = normalizeSignerMetadata({ value: selected, source, label });
  const builderId = assertSafeText(selected.builderId,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", `${label}.builderId`, { maximumBytes: 2048 });
  const fileName = assertSafeFileName(
    selected.fileName === undefined ? file.path.split(/[\\/]/u).pop() : selected.fileName,
    `${label}.fileName`,
  );
  assert(fileName === file.path.split(/[\\/]/u).pop(),
    "RELEASE_EVIDENCE_FILE_NAME_MISMATCH",
    `${label}.fileName must match the supplied file name`);
  return {
    format: RELEASE_EVIDENCE_SIGSTORE_FORMAT,
    mediaType,
    predicateType,
    builderId,
    fileName,
    bytes: file.bytes,
    sha256: file.sha256,
    subjectSha256: artifactDigest,
    verificationStatus: "unverified",
    source: sourceObject(source),
    ...signer,
  };
}

export function validateSpdxJson(value, label = "sbom") {
  const sbom = assertPlainObject(value, "RELEASE_EVIDENCE_SBOM_INVALID", label);
  assert(sbom.spdxVersion === "SPDX-2.3", "RELEASE_EVIDENCE_SBOM_INVALID",
    `${label}.spdxVersion must be exactly SPDX-2.3`);
  assert(sbom.dataLicense === "CC0-1.0", "RELEASE_EVIDENCE_SBOM_INVALID",
    `${label}.dataLicense must be exactly CC0-1.0 for SPDX-2.3`);
  assert(typeof sbom.SPDXID === "string" && /^SPDXRef-[A-Za-z0-9.-]+$/u.test(sbom.SPDXID),
    "RELEASE_EVIDENCE_SBOM_INVALID", `${label}.SPDXID is required`);
  assert(typeof sbom.name === "string" && sbom.name.length > 0,
    "RELEASE_EVIDENCE_SBOM_INVALID", `${label}.name is required`);
  assert(typeof sbom.documentNamespace === "string"
      && /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(sbom.documentNamespace),
  "RELEASE_EVIDENCE_SBOM_INVALID", `${label}.documentNamespace must be a URI`);
  const creationInfo = assertPlainObject(sbom.creationInfo,
    "RELEASE_EVIDENCE_SBOM_INVALID", `${label}.creationInfo`);
  assert(typeof creationInfo.created === "string" && creationInfo.created.length > 0,
    "RELEASE_EVIDENCE_SBOM_INVALID", `${label}.creationInfo.created is required`);
  assert(Array.isArray(creationInfo.creators) && creationInfo.creators.length > 0
      && creationInfo.creators.every((item) => typeof item === "string" && item.length > 0),
  "RELEASE_EVIDENCE_SBOM_INVALID",
  `${label}.creationInfo.creators must contain at least one creator`);
  assert(Array.isArray(sbom.packages), "RELEASE_EVIDENCE_SBOM_INVALID",
    `${label}.packages must be an array`);
  for (const [index, packageEntry] of sbom.packages.entries()) {
    assertPlainObject(packageEntry, "RELEASE_EVIDENCE_SBOM_INVALID",
      `${label}.packages[${index}]`);
    assert(typeof packageEntry.SPDXID === "string"
        && /^SPDXRef-[A-Za-z0-9.-]+$/u.test(packageEntry.SPDXID)
        && typeof packageEntry.name === "string" && packageEntry.name.length > 0,
    "RELEASE_EVIDENCE_SBOM_INVALID",
    `${label}.packages[${index}] must have SPDXID and name`);
  }
  if (sbom.files !== undefined) assert(Array.isArray(sbom.files),
    "RELEASE_EVIDENCE_SBOM_INVALID", `${label}.files must be an array`);
  if (sbom.relationships !== undefined) assert(Array.isArray(sbom.relationships),
    "RELEASE_EVIDENCE_SBOM_INVALID", `${label}.relationships must be an array`);
  return sbom;
}

export function validateCanonicalAttestation(value, {
  label,
  release,
  artifactDigest,
  kind = "provenance",
}) {
  if (value === null) return null;
  const attestation = assertPlainObject(value,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", label);
  assertAllowedKeys(attestation, [
    "format", "mediaType", "predicateType", "builderId", "signerRepository",
    "verificationStatus", "signerWorkflow", "signerDigest", "runUrl", "verificationInputs", "fileName",
    "bytes", "sha256", "subjectSha256", "source",
  ], label, "RELEASE_EVIDENCE_PROVENANCE_INVALID");
  assert(attestation.format === RELEASE_EVIDENCE_SIGSTORE_FORMAT,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", `${label}.format is invalid`);
  assert(attestation.verificationStatus === "unverified",
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.verificationStatus must be exactly unverified until the protected finalizer checks it`);
  assertSafeFileName(attestation.fileName, `${label}.fileName`);
  assertByteCount(attestation.bytes, `${label}.bytes`);
  assertSha256(attestation.sha256, `${label}.sha256`);
  assertSafeText(attestation.mediaType, "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.mediaType`, { pattern: RELEASE_EVIDENCE_PROVENANCE_MEDIA_TYPE_PATTERN });
  assertSafeText(attestation.predicateType, "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.predicateType`, {
      pattern: kind === "sbom"
        ? RELEASE_EVIDENCE_SBOM_PREDICATE_PATTERN
        : RELEASE_EVIDENCE_PROVENANCE_PREDICATE_PATTERN,
    });
  assertSafeText(attestation.builderId, "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.builderId`, { maximumBytes: 2048 });
  assertCanonicalSubjectDigest(attestation.subjectSha256, artifactDigest,
    `${label}.subjectSha256`);
  const signerWorkflow = assertSafeText(attestation.signerWorkflow,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", `${label}.signerWorkflow`, {
      pattern: RELEASE_EVIDENCE_SIGNER_WORKFLOW_PATTERN,
      maximumBytes: 512,
    });
  const repositoryUrl = new URL(release.repository);
  assert(repositoryUrl.hostname === "github.com",
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.signerWorkflow requires a GitHub repository source`);
  const signerRepository = assertSafeText(attestation.signerRepository,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", `${label}.signerRepository`, {
      pattern: RELEASE_EVIDENCE_GITHUB_REPOSITORY_SLUG_PATTERN,
      maximumBytes: 256,
    });
  assert(signerWorkflow.startsWith(`${signerRepository}/.github/workflows/`),
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.signerWorkflow must belong to signerRepository`);
  assertSafeText(attestation.signerDigest,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", `${label}.signerDigest`, {
      pattern: RELEASE_EVIDENCE_SIGNER_DIGEST_PATTERN,
      maximumBytes: 40,
    });
  const runUrl = assertHttpsUrl(attestation.runUrl,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", `${label}.runUrl`, { maximumBytes: 512 });
  assert(RELEASE_EVIDENCE_RUN_URL_PATTERN.test(runUrl),
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.runUrl must identify a GitHub Actions run`);
  const sourceRunPrefix = `${repositoryUrl.origin}${repositoryUrl.pathname}/actions/runs/`;
  const signerRepositoryUrl = new URL(`https://github.com/${signerRepository}`);
  const signerRunPrefix = `${signerRepositoryUrl.origin}${signerRepositoryUrl.pathname}/actions/runs/`;
  assert(runUrl.startsWith(sourceRunPrefix) || runUrl.startsWith(signerRunPrefix),
    "RELEASE_EVIDENCE_PROVENANCE_INVALID",
    `${label}.runUrl must belong to the release or signer repository`);
  const verificationInputs = assertPlainObject(attestation.verificationInputs,
    "RELEASE_EVIDENCE_PROVENANCE_INVALID", `${label}.verificationInputs`);
  assertAllowedKeys(verificationInputs,
    ["command", "bundleRequired", "denySelfHostedRunners"],
    `${label}.verificationInputs`, "RELEASE_EVIDENCE_PROVENANCE_INVALID");
  assert(verificationInputs.command === "gh attestation verify --bundle"
      && verificationInputs.bundleRequired === true
      && verificationInputs.denySelfHostedRunners === true,
  "RELEASE_EVIDENCE_PROVENANCE_INVALID",
  `${label}.verificationInputs must require protected bundle verification`);
  const source = assertPlainObject(attestation.source,
    "RELEASE_EVIDENCE_SOURCE_INVALID", `${label}.source`);
  assertAllowedKeys(source, ["version", "tag", "commit", "repository"],
    `${label}.source`, "RELEASE_EVIDENCE_SOURCE_INVALID");
  assert(source.version === release.version && source.tag === release.tag
      && source.commit === release.commit && source.repository === release.repository,
  "RELEASE_EVIDENCE_SOURCE_MISMATCH",
  `${label}.source does not identify the exact release source`);
  return attestation;
}

export function normalizeUpdater(value, platform, channel, label, metadata = null) {
  const updater = assertPlainObject(value, "RELEASE_EVIDENCE_UPDATER_INVALID", label);
  assertAllowedKeys(updater, ["enabled", "mechanism", "metadata"], label,
    "RELEASE_EVIDENCE_UPDATER_INVALID");
  const enabled = assertBoolean(updater.enabled,
    "RELEASE_EVIDENCE_UPDATER_INVALID", `${label}.enabled`);
  const mechanism = assertSafeText(updater.mechanism,
    "RELEASE_EVIDENCE_UPDATER_INVALID", `${label}.mechanism`, {
      pattern: /^[a-z][a-z0-9-]{1,63}$/u,
      maximumBytes: 64,
    });
  assert(RELEASE_EVIDENCE_DEFAULT_UPDATER_MECHANISMS[platform].includes(mechanism),
    "RELEASE_EVIDENCE_UPDATER_INVALID",
    `${label}.mechanism ${mechanism} is not valid for ${platform}`);
  if (channel === "store") {
    assert(!enabled && mechanism === "store-managed",
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      "Store artifacts must use the store-managed updater");
  } else {
    assert(mechanism !== "store-managed",
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      "direct artifacts cannot use the store-managed updater");
  }
  if (!enabled) {
    assert(updater.metadata === null || updater.metadata === undefined,
      "RELEASE_EVIDENCE_UPDATER_INVALID",
      `${label}.metadata must be null when disabled`);
    return { enabled: false, mechanism, metadata: null };
  }
  assert(metadata !== null, "RELEASE_EVIDENCE_UPDATER_INVALID",
    `${label}.metadata must be supplied as a regular file`);
  return { enabled: true, mechanism, metadata };
}

export function artifactIdentity(artifact) {
  return [artifact.channel, artifact.platform, artifact.architecture,
    artifact.format, artifact.fileName].join("/");
}

export function compareArtifactIdentity(left, right) {
  return compareCodeUnits(artifactIdentity(left), artifactIdentity(right));
}

function filenameKey(value) {
  return value.toLowerCase();
}

function artifactFileNames(artifact) {
  return [
    artifact.fileName,
    ...(artifact.store === null ? [] : [artifact.store.receipt.fileName]),
    ...(artifact.sbom === null ? [] : [
      artifact.sbom.fileName,
      ...(artifact.sbom.attestation === null ? [] : [artifact.sbom.attestation.fileName]),
    ]),
    ...(artifact.provenance === null ? [] : [artifact.provenance.fileName]),
    ...(artifact.updater.enabled ? [artifact.updater.metadata.fileName] : []),
  ];
}

export function validateCanonicalArtifact(artifact, release, index) {
  const label = `artifacts[${index}]`;
  assertPlainObject(artifact, "RELEASE_EVIDENCE_ARTIFACT_INVALID", label);
  assertAllowedKeys(artifact, [
    "platform", "channel", "architecture", "format", "version", "distribution",
    "downloadUrl", "fileName", "bytes", "sha256", "source", "nativeTrust", "build",
    "sbom", "provenance", "assurances", "store", "updater",
  ], label, "RELEASE_EVIDENCE_ARTIFACT_INVALID");
  assert(Object.prototype.hasOwnProperty.call(artifact, "store"),
    "RELEASE_EVIDENCE_ARTIFACT_INVALID",
    `${label}.store must be explicitly null for a direct artifact`);
  const platform = assertPlatform(artifact.platform);
  const channel = assertChannel(artifact.channel);
  assertArchitecture(artifact.architecture);
  assertFormat(artifact.format);
  assertVersion(artifact.version, `${label}.version`);
  assert(artifact.version === release.version, "RELEASE_EVIDENCE_VERSION_MISMATCH",
    `${label}.version does not match the release`);
  assertSafeFileName(artifact.fileName, `${label}.fileName`);
  assertByteCount(artifact.bytes, `${label}.bytes`);
  assertSha256(artifact.sha256, `${label}.sha256`);
  const source = assertPlainObject(artifact.source,
    "RELEASE_EVIDENCE_SOURCE_INVALID", `${label}.source`);
  assertAllowedKeys(source, ["version", "tag", "commit", "repository"],
    `${label}.source`, "RELEASE_EVIDENCE_SOURCE_INVALID");
  assert(source.version === release.version && source.tag === release.tag
      && source.commit === release.commit && source.repository === release.repository,
  "RELEASE_EVIDENCE_SOURCE_MISMATCH",
  `${label}.source does not identify the exact release source`);
  const downloadUrl = assertHttpsUrl(artifact.downloadUrl,
    "RELEASE_EVIDENCE_DOWNLOAD_URL_INVALID", `${label}.downloadUrl`);

  if (artifact.sbom !== null) {
    const sbom = assertPlainObject(artifact.sbom, "RELEASE_EVIDENCE_SBOM_INVALID",
      `${label}.sbom`);
    assertAllowedKeys(sbom, ["format", "fileName", "bytes", "sha256", "subjectSha256",
      "source", "attestation"], `${label}.sbom`, "RELEASE_EVIDENCE_SBOM_INVALID");
    assert(sbom.format === RELEASE_EVIDENCE_SPDX_FORMAT,
      "RELEASE_EVIDENCE_SBOM_INVALID", `${label}.sbom.format must be SPDX JSON`);
    assertSafeFileName(sbom.fileName, `${label}.sbom.fileName`);
    assertByteCount(sbom.bytes, `${label}.sbom.bytes`);
    assertSha256(sbom.sha256, `${label}.sbom.sha256`);
    assertCanonicalSubjectDigest(sbom.subjectSha256, artifact.sha256,
      `${label}.sbom.subjectSha256`);
    const sbomSource = assertPlainObject(sbom.source,
      "RELEASE_EVIDENCE_SOURCE_INVALID", `${label}.sbom.source`);
    assert(source.version === sbomSource.version && source.tag === sbomSource.tag
        && source.commit === sbomSource.commit && source.repository === sbomSource.repository,
    "RELEASE_EVIDENCE_SOURCE_MISMATCH",
    `${label}.sbom.source does not identify the exact release source`);
    validateCanonicalAttestation(sbom.attestation, {
      label: `${label}.sbom.attestation`, release, artifactDigest: artifact.sha256, kind: "sbom",
    });
  }
  validateCanonicalAttestation(artifact.provenance, {
    label: `${label}.provenance`, release, artifactDigest: artifact.sha256,
  });
  validateAssurances(artifact.assurances, platform, channel, `${label}.assurances`);
  const store = normalizeStore(artifact.store, platform, channel, `${label}.store`, {
    artifactDigest: artifact.sha256,
  });
  normalizeNativeTrust({ value: artifact.nativeTrust, platform, channel, store,
    label: `${label}.nativeTrust` });
  normalizeBuild(artifact.build, channel, `${label}.build`);
  validateDistribution({ value: artifact.distribution, channel, platform, store,
    source: release, fileName: artifact.fileName, downloadUrl, label: `${label}.distribution` });
  const updater = assertPlainObject(artifact.updater,
    "RELEASE_EVIDENCE_UPDATER_INVALID", `${label}.updater`);
  assertAllowedKeys(updater, ["enabled", "mechanism", "metadata"], `${label}.updater`,
    "RELEASE_EVIDENCE_UPDATER_INVALID");
  const enabled = assertBoolean(updater.enabled, "RELEASE_EVIDENCE_UPDATER_INVALID",
    `${label}.updater.enabled`);
  const mechanism = assertSafeText(updater.mechanism, "RELEASE_EVIDENCE_UPDATER_INVALID",
    `${label}.updater.mechanism`, {
      pattern: /^[a-z][a-z0-9-]{1,63}$/u,
      maximumBytes: 64,
    });
  assert(RELEASE_EVIDENCE_DEFAULT_UPDATER_MECHANISMS[platform].includes(mechanism),
    "RELEASE_EVIDENCE_UPDATER_INVALID",
    `${label}.updater.mechanism is invalid for ${platform}`);
  if (channel === "store") {
    assert(!enabled && mechanism === "store-managed",
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      `${label}.updater must be store-managed`);
  } else {
    assert(mechanism !== "store-managed",
      "RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
      `${label}.updater cannot be store-managed`);
  }
  if (enabled) {
    const metadata = assertPlainObject(updater.metadata,
      "RELEASE_EVIDENCE_UPDATER_INVALID", `${label}.updater.metadata`);
    assertAllowedKeys(metadata, ["fileName", "bytes", "sha256", "subjectSha256"],
      `${label}.updater.metadata`, "RELEASE_EVIDENCE_UPDATER_INVALID");
    assertSafeFileName(metadata.fileName, `${label}.updater.metadata.fileName`);
    assertByteCount(metadata.bytes, `${label}.updater.metadata.bytes`);
    assertSha256(metadata.sha256, `${label}.updater.metadata.sha256`);
    assertCanonicalSubjectDigest(metadata.subjectSha256, artifact.sha256,
      `${label}.updater.metadata.subjectSha256`);
  } else {
    assert(updater.metadata === null,
      "RELEASE_EVIDENCE_UPDATER_INVALID",
      `${label}.updater.metadata must be null when disabled`);
  }
  return artifactIdentity(artifact);
}

export function validateCanonicalManifest(manifest) {
  assertPlainObject(manifest, "RELEASE_EVIDENCE_MANIFEST_INVALID", "manifest");
  assertAllowedKeys(manifest, ["schemaVersion", "product", "version", "tag", "commit",
    "repository", "artifacts"], "manifest", "RELEASE_EVIDENCE_MANIFEST_INVALID");
  assert(manifest.schemaVersion === RELEASE_EVIDENCE_SCHEMA_VERSION,
    "RELEASE_EVIDENCE_SCHEMA_INVALID", "manifest schema version is invalid");
  const product = assertPlainObject(manifest.product,
    "RELEASE_EVIDENCE_PRODUCT_INVALID", "manifest.product");
  assertAllowedKeys(product, ["name"], "manifest.product", "RELEASE_EVIDENCE_PRODUCT_INVALID");
  assertSafeText(product.name, "RELEASE_EVIDENCE_PRODUCT_INVALID", "manifest.product.name");
  const release = {
    version: assertVersion(manifest.version, "manifest.version"),
    tag: assertTag(manifest.tag, "manifest.tag"),
    commit: assertCommit(manifest.commit, "manifest.commit"),
    repository: assertRepository(manifest.repository, "manifest.repository"),
  };
  assert(release.tag === `v${release.version}`,
  "RELEASE_EVIDENCE_VERSION_MISMATCH",
  "manifest.tag must equal v<version>; prerelease/build identifiers belong in version");
  assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0,
    "RELEASE_EVIDENCE_ARTIFACT_INVALID", "manifest.artifacts must contain supplied artifacts");
  assert(manifest.artifacts.length <= RELEASE_EVIDENCE_MAX_ARTIFACTS,
    "RELEASE_EVIDENCE_LIMIT_EXCEEDED", "manifest contains too many artifacts");
  const identities = new Set();
  const names = new Set([
    RELEASE_EVIDENCE_MANIFEST_FILE_NAME.toLowerCase(),
    RELEASE_EVIDENCE_SUMS_FILE_NAME.toLowerCase(),
  ]);
  let previous = "";
  for (let index = 0; index < manifest.artifacts.length; index += 1) {
    const identity = validateCanonicalArtifact(manifest.artifacts[index], release, index);
    assert(!identities.has(identity), "RELEASE_EVIDENCE_DUPLICATE_ARTIFACT",
      `duplicate artifact identity: ${identity}`);
    identities.add(identity);
    for (const fileName of artifactFileNames(manifest.artifacts[index])) {
      const key = filenameKey(fileName);
      assert(!names.has(key), "RELEASE_EVIDENCE_DUPLICATE_FILE_NAME",
        `duplicate release evidence file name (case-insensitive): ${fileName}`);
      names.add(key);
    }
    assert(compareCodeUnits(identity, previous) >= 0,
      "RELEASE_EVIDENCE_ORDER_INVALID",
      "manifest.artifacts must be sorted by canonical identity");
    previous = identity;
  }
  return Object.freeze({ release, product, identities, names });
}

export function buildSha256Sums(manifest) {
  validateCanonicalManifest(manifest);
  const rows = [{
    fileName: RELEASE_EVIDENCE_MANIFEST_FILE_NAME,
    sha256: sha256Bytes(Buffer.from(`${stableStringify(manifest)}\n`, "utf8")),
  }];
  for (const artifact of manifest.artifacts) {
    rows.push({ fileName: artifact.fileName, sha256: artifact.sha256 });
    if (artifact.store !== null) {
      rows.push({
        fileName: artifact.store.receipt.fileName,
        sha256: artifact.store.receipt.sha256,
      });
    }
    if (artifact.sbom !== null) {
      rows.push({ fileName: artifact.sbom.fileName, sha256: artifact.sbom.sha256 });
      if (artifact.sbom.attestation !== null) {
        rows.push({
          fileName: artifact.sbom.attestation.fileName,
          sha256: artifact.sbom.attestation.sha256,
        });
      }
    }
    if (artifact.provenance !== null) {
      rows.push({ fileName: artifact.provenance.fileName, sha256: artifact.provenance.sha256 });
    }
    if (artifact.updater.enabled) {
      rows.push({ fileName: artifact.updater.metadata.fileName,
        sha256: artifact.updater.metadata.sha256 });
    }
  }
  rows.sort((left, right) => compareCodeUnits(left.fileName, right.fileName));
  const names = new Set();
  for (const row of rows) {
    const key = filenameKey(row.fileName);
    assert(!names.has(key), "RELEASE_EVIDENCE_DUPLICATE_FILE_NAME",
      `duplicate SHA256SUMS file name: ${row.fileName}`);
    names.add(key);
  }
  return `${rows.map(({ sha256, fileName }) => `${sha256}  ${fileName}`).join("\n")}\n`;
}

export { artifactFileNames };
