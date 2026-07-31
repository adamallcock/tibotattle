import {
  BundleVerificationError,
  LOCAL_METADATA_BUNDLE_VERIFICATION_LIMITS,
  createLocalMetadataBundleByteVerifier,
} from "../export/bundle-verification.js";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

export function createLocalMetadataBundleVerificationContext({
  readOwnerOnlyLocalMetadataBundlePair,
  sha256Hex,
  compatibilityTuple,
} = {}) {
  const readPair = requireFunction(
    readOwnerOnlyLocalMetadataBundlePair,
    "readOwnerOnlyLocalMetadataBundlePair",
  );
  const hash = requireFunction(sha256Hex, "sha256Hex");
  const currentCompatibilityTuple = requireFunction(
    compatibilityTuple,
    "compatibilityTuple",
  );
  const loadVerifiedLocalMetadataBundleBytes =
    createLocalMetadataBundleByteVerifier({
      sha256Hex: hash,
      compatibilityTuple: currentCompatibilityTuple,
    });

  async function loadVerifiedLocalMetadataBundleFiles({
    bundleFile,
    receiptFile,
  } = {}) {
    const { bundleBytes, receiptBytes } = await readPair({
      bundleFile,
      receiptFile,
      maximumBundleBytes:
        LOCAL_METADATA_BUNDLE_VERIFICATION_LIMITS.maximumBundleBytes,
      maximumReceiptBytes:
        LOCAL_METADATA_BUNDLE_VERIFICATION_LIMITS.maximumReceiptBytes,
      createError: (code) => new BundleVerificationError(code),
    });
    return loadVerifiedLocalMetadataBundleBytes({
      bundleBytes,
      receiptBytes,
    });
  }

  async function verifyLocalMetadataBundleFiles(files = {}) {
    return (await loadVerifiedLocalMetadataBundleFiles(files)).summary;
  }

  return Object.freeze({
    loadVerifiedLocalMetadataBundleBytes,
    loadVerifiedLocalMetadataBundleFiles,
    verifyLocalMetadataBundleFiles,
  });
}
