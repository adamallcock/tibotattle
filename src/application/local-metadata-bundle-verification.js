import {
  BundleVerificationError,
  LOCAL_METADATA_BUNDLE_VERIFICATION_LIMITS,
  createLocalMetadataBundleByteVerifier,
} from "../export/bundle-verification.js";
import { isProxy } from "node:util/types";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

const WINDOWS_REVIEW_PAIR_STORAGE_CONTRACT_VERSION =
  "windows-review-pair-storage-v1";
const WINDOWS_REVIEW_PAIR_STORAGE_METHODS = Object.freeze([
  "writeReviewPair",
  "readReviewPair",
  "recoverReviewPairTransactions",
  "recoverOwnerOnlyPairTransactions",
  "writeOwnerOnlyPairNoClobber",
  "readOwnerOnlyLocalMetadataBundlePair",
]);

function ownValue(object, name, message) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError(message);
  }
  return descriptor.value;
}

function optionalOwnFunction(configuration, name) {
  const descriptor = Object.getOwnPropertyDescriptor(configuration, name);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "function"
      || isProxy(descriptor.value)) {
    throw new TypeError(`${name} must be a function`);
  }
  return descriptor.value;
}

function reviewPairStoragePort(configuration) {
  const descriptor = Object.getOwnPropertyDescriptor(configuration, "reviewPairStorage");
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) {
    throw new TypeError("Windows review pair storage is invalid");
  }
  const storage = descriptor.value;
  if (!storage || typeof storage !== "object" || Array.isArray(storage)
      || isProxy(storage)) {
    throw new TypeError("Windows review pair storage is invalid");
  }
  const validator = optionalOwnFunction(configuration, "reviewPairStorageValidator");
  if (!validator) {
    throw new TypeError("Windows review pair storage validator is required");
  }
  let reviewed;
  try {
    reviewed = Reflect.apply(validator, undefined, [storage]);
  } catch {
    throw new TypeError("Windows review pair storage is invalid");
  }
  if (reviewed !== true) throw new TypeError("Windows review pair storage is invalid");
  if (ownValue(storage, "contractVersion", "Windows review pair storage is invalid")
      !== WINDOWS_REVIEW_PAIR_STORAGE_CONTRACT_VERSION) {
    throw new TypeError("Windows review pair storage is invalid");
  }
  for (const name of WINDOWS_REVIEW_PAIR_STORAGE_METHODS) {
    const value = ownValue(storage, name, "Windows review pair storage is invalid");
    if (typeof value !== "function" || isProxy(value)) {
      throw new TypeError("Windows review pair storage is invalid");
    }
  }
  return Object.freeze({
    readOwnerOnlyLocalMetadataBundlePair: ownValue(
      storage,
      "readOwnerOnlyLocalMetadataBundlePair",
      "Windows review pair storage is invalid",
    ),
  });
}

export function createLocalMetadataBundleVerificationContext({
  readOwnerOnlyLocalMetadataBundlePair,
  sha256Hex,
  compatibilityTuple,
  platformName = null,
  reviewPairStorage,
  reviewPairStorageValidator,
} = {}) {
  const configuredReader = readOwnerOnlyLocalMetadataBundlePair === undefined
    ? undefined
    : requireFunction(
      readOwnerOnlyLocalMetadataBundlePair,
      "readOwnerOnlyLocalMetadataBundlePair",
    );
  const hash = requireFunction(sha256Hex, "sha256Hex");
  const currentCompatibilityTuple = requireFunction(
    compatibilityTuple,
    "compatibilityTuple",
  );
  const selectedPlatform = platformName === null
    ? null
    : requireFunction(platformName, "platformName")();
  const reviewedWindowsPairStorage = selectedPlatform === "windows"
    ? reviewPairStoragePort(
      reviewPairStorage === undefined && reviewPairStorageValidator === undefined
        ? {}
        : { reviewPairStorage, reviewPairStorageValidator },
    )
    : undefined;
  if (selectedPlatform !== "windows" && !configuredReader && !reviewedWindowsPairStorage) {
    throw new TypeError("readOwnerOnlyLocalMetadataBundlePair must be a function");
  }
  const loadVerifiedLocalMetadataBundleBytes =
    createLocalMetadataBundleByteVerifier({
      sha256Hex: hash,
      compatibilityTuple: currentCompatibilityTuple,
    });

  async function loadVerifiedLocalMetadataBundleFiles({
    bundleFile,
    receiptFile,
  } = {}) {
    const readPair = selectedPlatform === "windows"
      ? reviewedWindowsPairStorage?.readOwnerOnlyLocalMetadataBundlePair
      : configuredReader;
    if (typeof readPair !== "function") {
      throw new TypeError("Windows review pair storage reader is required");
    }
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
