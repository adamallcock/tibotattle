import { stableJson } from "./canonical-json.js";
import { createPrivacySafeBundleVerifier } from "./privacy.js";
import { DEFAULT_EXPORT_RESOURCE_LIMITS } from "./resource-policy.js";
import { validateExportRecord } from "./schema.js";

export const LOCAL_METADATA_BUNDLE_VERIFICATION_LIMITS = Object.freeze({
  maximumBundleBytes:
    DEFAULT_EXPORT_RESOURCE_LIMITS.maximumCanonicalBundleBytes,
  maximumReceiptBytes: 1024 * 1024,
});

const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: false,
  // The legacy decoder retains a leading BOM. Preserve that behavior so a
  // BOM-prefixed artifact cannot become canonical merely through decoding.
  ignoreBOM: true,
});

export class BundleVerificationError extends Error {
  constructor(code) {
    super(`Bundle verification failed (${code})`);
    this.name = "BundleVerificationError";
    this.code = code;
  }
}

function fail(code) {
  throw new BundleVerificationError(code);
}

function parseCanonicalJson(bytes, label) {
  const text = UTF8_DECODER.decode(bytes);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`${label}_json`);
  }
  if (stableJson(value) !== text) fail(`${label}_not_canonical`);
  return value;
}

function assertByteSequence(value, label, maximumBytes) {
  if (!(value instanceof Uint8Array)) fail(`${label}_input`);
  if (
    !Number.isSafeInteger(value.byteLength)
    || value.byteLength < 1
    || value.byteLength > maximumBytes
  ) {
    fail(`${label}_size`);
  }
  return value;
}

function ordered(records, timeField, idField) {
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    const previousTime = Date.parse(previous[timeField]);
    const currentTime = Date.parse(current[timeField]);
    if (
      !Number.isFinite(previousTime)
      || !Number.isFinite(currentTime)
      || previousTime > currentTime
    ) {
      return false;
    }
    if (
      previousTime === currentTime
      && previous[idField] >= current[idField]
    ) {
      return false;
    }
  }
  return true;
}

function hasUniqueIds(records, field) {
  return new Set(records.map((record) => record[field])).size
    === records.length;
}

function assertBundleSemantics(bundle) {
  const start = Date.parse(bundle.coveredAt.startAt);
  const end = Date.parse(bundle.coveredAt.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    fail("bundle_time_bounds");
  }
  const totalRecords = bundle.recordCounts.usageEvents
    + bundle.recordCounts.quotaSnapshots
    + bundle.recordCounts.activityMarkers;
  if (totalRecords > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumOutputRecords) {
    fail("bundle_record_limit");
  }
  const groups = [
    [bundle.records.usageEvents, "eventTime", "eventId"],
    [bundle.records.quotaSnapshots, "observedTime", "snapshotId"],
    [bundle.records.activityMarkers, "observedTime", "markerId"],
  ];
  for (const [records, timeField, idField] of groups) {
    if (!hasUniqueIds(records, idField)) fail("bundle_duplicate_ids");
    if (!ordered(records, timeField, idField)) fail("bundle_record_order");
    if (records.some((record) => {
      const time = Date.parse(record[timeField]);
      return !Number.isFinite(time) || time < start || time > end;
    })) {
      fail("bundle_record_out_of_bounds");
    }
  }
  for (const snapshot of bundle.records.quotaSnapshots) {
    const observed = Date.parse(snapshot.observedTime);
    const received = Date.parse(snapshot.receivedTime);
    if (
      !Number.isFinite(received)
      || received < start
      || received > end
    ) {
      fail("bundle_record_out_of_bounds");
    }
    if (received < observed) fail("bundle_received_before_observed");
  }
  const declared = new Set(bundle.sourceProviders);
  const observed = [
    ...bundle.records.usageEvents.map((record) => record.provider),
    ...bundle.records.quotaSnapshots.map((record) => record.provider),
  ];
  if (observed.some((provider) => !declared.has(provider))) {
    fail("bundle_provider_declaration");
  }
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

export function createLocalMetadataBundleByteVerifier({
  sha256Hex,
  compatibilityTuple,
} = {}) {
  const hash = requireFunction(sha256Hex, "sha256Hex");
  const currentCompatibilityTuple = requireFunction(
    compatibilityTuple,
    "compatibilityTuple",
  );
  const verifyPrivacySafeBundle = createPrivacySafeBundleVerifier({
    sha256Hex: hash,
    compatibilityTuple: currentCompatibilityTuple,
  });

  return function loadVerifiedLocalMetadataBundleBytes({
    bundleBytes,
    receiptBytes,
  } = {}) {
    const canonicalReceiptBytes = assertByteSequence(
      receiptBytes,
      "receipt",
      LOCAL_METADATA_BUNDLE_VERIFICATION_LIMITS.maximumReceiptBytes,
    );
    const canonicalBundleBytes = assertByteSequence(
      bundleBytes,
      "bundle",
      LOCAL_METADATA_BUNDLE_VERIFICATION_LIMITS.maximumBundleBytes,
    );
    const receipt = parseCanonicalJson(
      canonicalReceiptBytes,
      "receipt",
    );
    if (!validateExportRecord("privacyReceipt", receipt).valid) {
      fail("receipt_schema");
    }
    if (
      receipt.bundleBytes
      > LOCAL_METADATA_BUNDLE_VERIFICATION_LIMITS.maximumBundleBytes
    ) {
      fail("receipt_bundle_size");
    }
    if (canonicalBundleBytes.byteLength !== receipt.bundleBytes) {
      fail("bundle_digest");
    }
    const bundle = parseCanonicalJson(canonicalBundleBytes, "bundle");
    if (!validateExportRecord("bundle", bundle).valid) {
      fail("bundle_schema");
    }
    assertBundleSemantics(bundle);
    if (receipt.createdAt !== bundle.createdAt) {
      fail("receipt_created_at");
    }

    let expectedReceipt;
    try {
      expectedReceipt = verifyPrivacySafeBundle(bundle, {
        createdAt: receipt.createdAt,
      });
    } catch {
      fail("privacy_gate");
    }
    if (stableJson(expectedReceipt) !== stableJson(receipt)) {
      fail("receipt_mismatch");
    }
    const bundleSha256 = hash(canonicalBundleBytes);
    if (
      bundleSha256 !== receipt.bundleSha256
      || canonicalBundleBytes.byteLength !== receipt.bundleBytes
    ) {
      fail("bundle_digest");
    }

    const summary = {
      verdict: "passed",
      schemaVersion: bundle.schemaVersion,
      contractFamily: bundle.compatibility.contract.family,
      contractStatus: bundle.compatibility.contract.status,
      exporterVersion: bundle.compatibility.implementation.exporterVersion,
      bundleBytes: canonicalBundleBytes.byteLength,
      recordCounts: structuredClone(bundle.recordCounts),
      transportReady: bundle.transportReady,
    };
    return {
      summary,
      bundle,
      receipt,
      bundleBytes: canonicalBundleBytes,
      receiptBytes: canonicalReceiptBytes,
      bundleSha256,
      receiptSha256: hash(canonicalReceiptBytes),
    };
  };
}
