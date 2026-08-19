/**
 * Cross-platform release evidence vocabulary.
 *
 * This module describes the small, platform-neutral part of a release.  It
 * intentionally does not perform signing, notarization, publishing, or
 * network lookups; those are platform/release-pipeline operations.  The
 * generated manifest records only artifacts that were actually supplied to
 * the generator.
 */

export const RELEASE_EVIDENCE_SCHEMA_VERSION =
  "usage-monitor-release-evidence-v1";
export const RELEASE_EVIDENCE_INPUT_SCHEMA_VERSION =
  "usage-monitor-release-evidence-input-v1";

export const RELEASE_EVIDENCE_PLATFORMS = Object.freeze([
  "macos",
  "windows",
  "linux",
]);

export const RELEASE_EVIDENCE_CHANNELS = Object.freeze([
  "direct",
  "store",
]);

// These are intentionally broad tokens rather than an architecture matrix.
// A release may add a native architecture without changing the evidence
// schema; the native build and install gates remain responsible for whether
// that architecture is actually supported.
export const RELEASE_EVIDENCE_ARCHITECTURE_PATTERN =
  /^[a-z0-9][a-z0-9._-]{0,31}$/u;
export const RELEASE_EVIDENCE_FORMAT_PATTERN =
  /^[a-z0-9][a-z0-9._-]{0,31}$/u;
export const RELEASE_EVIDENCE_DISTRIBUTION_PATTERN =
  /^[a-z][a-z0-9-]{1,63}$/u;

export const RELEASE_EVIDENCE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const RELEASE_EVIDENCE_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/u;
export const RELEASE_EVIDENCE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u;
export const RELEASE_EVIDENCE_TAG_PATTERN =
  /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u;

export const RELEASE_EVIDENCE_SAFE_FILE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

// Bounds are part of the offline contract as well as resource hygiene.  They
// prevent a downloaded manifest or a descriptor-controlled metadata directory
// from turning validation into an unbounded memory/CPU operation.
export const RELEASE_EVIDENCE_MAX_ARTIFACTS = 64;
export const RELEASE_EVIDENCE_MAX_METADATA_BYTES = 64 * 1024 * 1024;
export const RELEASE_EVIDENCE_MAX_TOTAL_METADATA_BYTES = 256 * 1024 * 1024;
export const RELEASE_EVIDENCE_MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
export const RELEASE_EVIDENCE_MAX_PATH_BYTES = 4096;
export const RELEASE_EVIDENCE_STORE_RECEIPT_SCHEMA_VERSION =
  "usage-monitor-store-delivery-receipt-v1";
export const RELEASE_EVIDENCE_STORE_RECEIPT_FORMAT = "store-delivery-receipt";

export const RELEASE_EVIDENCE_STORE_LISTING_HOSTS = Object.freeze({
  "mac-app-store": Object.freeze(["apps.apple.com"]),
  "microsoft-store": Object.freeze(["apps.microsoft.com"]),
  flathub: Object.freeze(["flathub.org"]),
  snap: Object.freeze(["snapcraft.io"]),
  // APT/RPM repositories are intentionally host-neutral: organizations may
  // operate their own repository.  They still require a canonical HTTPS URL.
  apt: Object.freeze([]),
  rpm: Object.freeze([]),
});

/**
 * The minimum positive assurances for a final artifact.  Linux direct
 * downloads deliberately do not claim a universal OS signing mechanism:
 * Linux trust is distribution-specific, so the contract requires a clean
 * native install and an independently checked final digest instead.
 */
export const RELEASE_EVIDENCE_PLATFORM_ASSURANCES = Object.freeze({
  macos: Object.freeze({
    direct: Object.freeze([
      "cleanInstallSmokePassed",
      "developerIdSigned",
      "hardenedRuntime",
      "notarizationAccepted",
      "ticketStapled",
      "gatekeeperAssessmentPassed",
    ]),
    store: Object.freeze([
      "storePublisherVerified",
      "storeBuildVerified",
      "storeSignatureVerified",
    ]),
  }),
  windows: Object.freeze({
    direct: Object.freeze([
      "cleanInstallSmokePassed",
      "authenticodeSigned",
      "timestamped",
    ]),
    store: Object.freeze([
      "storePublisherVerified",
      "storeBuildVerified",
      "storeSignatureVerified",
    ]),
  }),
  linux: Object.freeze({
    direct: Object.freeze([
      "cleanInstallSmokePassed",
      "artifactIntegrityVerified",
    ]),
    store: Object.freeze([
      "storePublisherVerified",
      "storeBuildVerified",
      "storeSignatureVerified",
    ]),
  }),
});

// The manifest is a public claims boundary.  Required keys above are the
// minimum gate; this allowlist permits only reviewed, platform-specific
// boolean claims and rejects arbitrary labels that could be mistaken for a
// security assurance.
export const RELEASE_EVIDENCE_ALLOWED_PLATFORM_ASSURANCES = Object.freeze({
  macos: Object.freeze({
    direct: Object.freeze([
      ...RELEASE_EVIDENCE_PLATFORM_ASSURANCES.macos.direct,
      "appNotarizationAccepted",
      "appTicketStapled",
      "dmgNotarizationAccepted",
      "dmgTicketStapled",
      "dmgGatekeeperAssessmentPassed",
      "cleanProfileSmokePassed",
      "sparkleFeedSigned",
    ]),
    store: Object.freeze([
      ...RELEASE_EVIDENCE_PLATFORM_ASSURANCES.macos.store,
      "storeSubmissionAccepted",
    ]),
  }),
  windows: Object.freeze({
    direct: Object.freeze([
      ...RELEASE_EVIDENCE_PLATFORM_ASSURANCES.windows.direct,
      "installerSignatureVerified",
      "smartScreenReputationObserved",
    ]),
    store: Object.freeze([
      ...RELEASE_EVIDENCE_PLATFORM_ASSURANCES.windows.store,
      "storeSubmissionAccepted",
    ]),
  }),
  linux: Object.freeze({
    direct: Object.freeze([
      ...RELEASE_EVIDENCE_PLATFORM_ASSURANCES.linux.direct,
      "packageSignatureVerified",
      "repositoryMetadataSigned",
    ]),
    store: Object.freeze([
      ...RELEASE_EVIDENCE_PLATFORM_ASSURANCES.linux.store,
      "storeSubmissionAccepted",
    ]),
  }),
});

export const RELEASE_EVIDENCE_STORE_PROVIDERS = Object.freeze({
  macos: Object.freeze(["mac-app-store"]),
  windows: Object.freeze(["microsoft-store"]),
  linux: Object.freeze(["flathub", "snap", "apt", "rpm"]),
});

export const RELEASE_EVIDENCE_PROVENANCE_MEDIA_TYPE_PATTERN =
  /^application\/vnd\.dev\.sigstore\.bundle\.v0\.3\+json$/u;
export const RELEASE_EVIDENCE_PROVENANCE_PREDICATE_PATTERN =
  /^https:\/\/slsa\.dev\/provenance\/v1$/u;
export const RELEASE_EVIDENCE_SBOM_PREDICATE_PATTERN =
  /^https:\/\/spdx\.dev\/Document\/v2\.3$/u;
export const RELEASE_EVIDENCE_SIGNER_WORKFLOW_PATTERN =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+$/u;
export const RELEASE_EVIDENCE_GITHUB_REPOSITORY_SLUG_PATTERN =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
export const RELEASE_EVIDENCE_SIGNER_DIGEST_PATTERN = /^[a-f0-9]{40}$/u;
export const RELEASE_EVIDENCE_RUN_URL_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*(?:\/attempt\/[1-9][0-9]*)?$/u;

export const RELEASE_EVIDENCE_DEFAULT_UPDATER_MECHANISMS = Object.freeze({
  macos: Object.freeze(["sparkle", "none", "store-managed"]),
  windows: Object.freeze(["electron-updater", "none", "store-managed"]),
  linux: Object.freeze(["none", "store-managed"]),
});
