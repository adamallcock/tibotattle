import { Buffer } from "node:buffer";

import {
  createLocalMetadataBundleVerificationContext,
} from "./application/index.js";
import { exportCompatibilityTuple } from "./export-contract.js";
import {
  readOwnerOnlyLocalMetadataBundlePair,
  sha256Hex,
} from "./platform/index.js";

const legacyVerifier = createLocalMetadataBundleVerificationContext({
  readOwnerOnlyLocalMetadataBundlePair,
  sha256Hex,
  compatibilityTuple: exportCompatibilityTuple,
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

export const loadVerifiedLocalMetadataBundleFiles =
  legacyVerifier.loadVerifiedLocalMetadataBundleFiles;
export const verifyLocalMetadataBundleFiles =
  legacyVerifier.verifyLocalMetadataBundleFiles;
