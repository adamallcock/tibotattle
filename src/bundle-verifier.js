import { Buffer } from "node:buffer";
import { platform as nodePlatform } from "node:os";

import {
  createLocalMetadataBundleVerificationContext,
} from "./application/index.js";
import { exportCompatibilityTuple } from "./export-contract.js";
import {
  readOwnerOnlyLocalMetadataBundlePair,
  sha256Hex,
} from "./platform/index.js";

function platformName() {
  if (nodePlatform() === "darwin") return "macos";
  if (nodePlatform() === "linux") return "linux";
  if (nodePlatform() === "win32") return "windows";
  return "other";
}

const legacyVerifier = createLocalMetadataBundleVerificationContext({
  readOwnerOnlyLocalMetadataBundlePair,
  sha256Hex,
  compatibilityTuple: exportCompatibilityTuple,
  platformName,
});

export {
  BundleVerificationError,
} from "./export/bundle-verification.js";

function normalizeLegacyByteSequence(value) {
  return value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : value;
}

export function loadVerifiedLocalMetadataBundleBytes({
  bundleBytes,
  receiptBytes,
} = {}) {
  return legacyVerifier.loadVerifiedLocalMetadataBundleBytes({
    bundleBytes: normalizeLegacyByteSequence(bundleBytes),
    receiptBytes: normalizeLegacyByteSequence(receiptBytes),
  });
}

function createInjectedVerifier(reviewPairStorage, reviewPairStorageValidator) {
  return createLocalMetadataBundleVerificationContext({
    sha256Hex,
    compatibilityTuple: exportCompatibilityTuple,
    platformName: () => "windows",
    reviewPairStorage,
    reviewPairStorageValidator,
  });
}

export async function loadVerifiedLocalMetadataBundleFiles(options = {}) {
  const {
    reviewPairStorage,
    reviewPairStorageValidator,
    ...files
  } = options;
  if (reviewPairStorage !== undefined) {
    return createInjectedVerifier(
      reviewPairStorage,
      reviewPairStorageValidator,
    ).loadVerifiedLocalMetadataBundleFiles(files);
  }
  return legacyVerifier.loadVerifiedLocalMetadataBundleFiles(files);
}

export async function verifyLocalMetadataBundleFiles(options = {}) {
  const {
    reviewPairStorage,
    reviewPairStorageValidator,
    ...files
  } = options;
  if (reviewPairStorage !== undefined) {
    return createInjectedVerifier(
      reviewPairStorage,
      reviewPairStorageValidator,
    ).verifyLocalMetadataBundleFiles(files);
  }
  return legacyVerifier.verifyLocalMetadataBundleFiles(files);
}
