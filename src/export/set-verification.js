import { BundleVerificationError } from "./bundle-verifier.js";
import {
  decompressExportBytes,
  ExportCompressionError,
} from "./compression.js";
import { stableJson } from "./canonical-json.js";
import {
  createExportResourceGuard,
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  ExportResourceLimitError,
} from "./resource-policy.js";
import {
  assertValidExportSetManifest,
  EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_1,
  EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_2,
  EXPORT_SET_MANIFEST_VERSION_V0_1,
  EXPORT_SET_MANIFEST_VERSION_V0_2,
  exportSetChunkBasenames,
} from "./set-schema.js";

const MAXIMUM_MANIFEST_RECEIPT_BYTES = 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();
const FAMILY = Object.freeze([
  ["usageEvents", "eventTime", "eventId"],
  ["quotaSnapshots", "observedTime", "snapshotId"],
  ["activityMarkers", "observedTime", "markerId"],
]);
const SAFE_BUNDLE_VERIFY_CODES = new Set([
  "bundle_digest",
  "bundle_duplicate_ids",
  "bundle_input",
  "bundle_json",
  "bundle_not_canonical",
  "bundle_provider_declaration",
  "bundle_received_before_observed",
  "bundle_record_limit",
  "bundle_record_order",
  "bundle_record_out_of_bounds",
  "bundle_schema",
  "bundle_size",
  "bundle_time_bounds",
  "privacy_gate",
  "receipt_bundle_size",
  "receipt_created_at",
  "receipt_input",
  "receipt_json",
  "receipt_mismatch",
  "receipt_not_canonical",
  "receipt_schema",
  "receipt_size",
]);
const SAFE_COMPRESSION_VERIFY_CODES = new Set([
  "decoded_bytes",
  "encoded_bytes",
  "gzip",
  "input",
]);
const SAFE_RESOURCE_VERIFY_CODES = new Set([
  "canonical_bundle_bytes",
  "chunk_count",
  "covered_duration",
  "directory_entries",
  "elapsed_time",
  "encoded_artifact_bytes",
  "expanded_record_bytes",
  "export_set_decoded_bytes",
  "export_set_encoded_bytes",
  "line_bytes",
  "manifest_bytes",
  "output_records",
  "rss",
  "source_bytes",
  "source_files",
  "workspace_bytes",
]);

const SAFE_VERIFY_CODES = new Set([
  "directory",
  "manifest_missing",
  "manifest_type",
  "manifest_owner",
  "manifest_permissions",
  "manifest_links",
  "manifest_size",
  "manifest_changed",
  "manifest_json",
  "manifest_canonical",
  "manifest_schema",
  "manifest_receipt",
  "compatibility",
  "mixed_representation",
  "chunk_artifact_missing",
  "chunk_artifact_type",
  "chunk_artifact_owner",
  "chunk_artifact_permissions",
  "chunk_artifact_links",
  "chunk_artifact_size",
  "chunk_artifact_changed",
  "chunk_artifact_read",
  "chunk_artifact_digest",
  "chunk_receipt_missing",
  "chunk_receipt_type",
  "chunk_receipt_owner",
  "chunk_receipt_permissions",
  "chunk_receipt_links",
  "chunk_receipt_size",
  "chunk_receipt_changed",
  "chunk_receipt_read",
  "chunk_metadata",
  "chunk_shared_contract",
  "chunk_diagnostics",
  "chunk_order",
  "chunk_duplicate",
  "chunk_nonmaximal",
  "logical_digest",
  "verification_index",
]);

export class ExportSetVerificationError extends Error {
  constructor(code) {
    if (!SAFE_VERIFY_CODES.has(code)) {
      throw new TypeError("Unknown export-set verification code");
    }
    super(`Export-set verification failed (${code})`);
    this.name = "ExportSetVerificationError";
    this.code = `export_set_verify_${code}`;
  }
}

function fail(code) {
  throw new ExportSetVerificationError(code);
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function readConfigProperty(value, property, message) {
  try {
    return value[property];
  } catch {
    throw new TypeError(message);
  }
}

function requireFunctionProperty(value, property, name) {
  return requireFunction(
    readConfigProperty(value, property, `${name} must be a function`),
    name,
  );
}

function captureFunctionProperty(value, property, name) {
  const operation = requireFunctionProperty(value, property, name);
  return (...args) => Reflect.apply(operation, value, args);
}

function requireDataProperty(value, property, code) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (!descriptor || !("value" in descriptor)) fail(code);
    return descriptor.value;
  } catch (error) {
    if (isReviewedFailure(error)) throw error;
    fail(code);
  }
}

function requireByteSequence(value, code) {
  try {
    if (
      !(value instanceof Uint8Array)
      || !Number.isSafeInteger(value.byteLength)
      || value.byteLength < 1
    ) {
      fail(code);
    }
  } catch (error) {
    if (isReviewedFailure(error)) throw error;
    fail(code);
  }
  return value;
}

function isReviewedFailure(error) {
  try {
    // Structured clone rejects Proxy-wrapped errors without requiring a
    // Node-specific proxy detector. Exact prototypes reject subclasses, while
    // own data fields avoid invoking attacker-controlled accessors.
    structuredClone(error);
    const prototype = Object.getPrototypeOf(error);
    const name = Object.getOwnPropertyDescriptor(error, "name");
    const code = Object.getOwnPropertyDescriptor(error, "code");
    const message = Object.getOwnPropertyDescriptor(error, "message");
    if (
      !name
      || !("value" in name)
      || !code
      || !("value" in code)
      || !message
      || !("value" in message)
      || typeof code.value !== "string"
    ) {
      return false;
    }
    if (prototype === BundleVerificationError.prototype) {
      return name.value === "BundleVerificationError"
        && SAFE_BUNDLE_VERIFY_CODES.has(code.value)
        && message.value === `Bundle verification failed (${code.value})`;
    }
    if (prototype === ExportCompressionError.prototype) {
      const shortCode = code.value.replace(/^export_compression_/u, "");
      return name.value === "ExportCompressionError"
        && code.value === `export_compression_${shortCode}`
        && SAFE_COMPRESSION_VERIFY_CODES.has(shortCode)
        && message.value === `Local export compression failed (${shortCode})`;
    }
    if (prototype === ExportResourceLimitError.prototype) {
      const shortCode = code.value.replace(/^export_resource_/u, "");
      return name.value === "ExportResourceLimitError"
        && code.value === `export_resource_${shortCode}`
        && SAFE_RESOURCE_VERIFY_CODES.has(shortCode)
        && message.value
          === `Local export stopped at the ${shortCode} resource limit`;
    }
    if (prototype === ExportSetVerificationError.prototype) {
      const shortCode = code.value.replace(/^export_set_verify_/u, "");
      return name.value === "ExportSetVerificationError"
        && code.value === `export_set_verify_${shortCode}`
        && SAFE_VERIFY_CODES.has(shortCode)
        && message.value === `Export-set verification failed (${shortCode})`;
    }
    return false;
  } catch {
    return false;
  }
}

function rethrowReviewedOrFail(error, code) {
  if (isReviewedFailure(error)) throw error;
  fail(code);
}

async function invokePort(operation, input, code) {
  try {
    return await operation(input);
  } catch (error) {
    rethrowReviewedOrFail(error, code);
  }
}

function invokeSyncPort(operation, input, code) {
  try {
    return operation(input);
  } catch (error) {
    rethrowReviewedOrFail(error, code);
  }
}

function requireStorage(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("storage must be an object");
    }
  } catch {
    throw new TypeError("storage must be an object");
  }
  const storage = {};
  for (const name of [
    "artifactPath",
    "clock",
    "createSha256Digest",
    "createUniquenessIndex",
    "enumerateDirectory",
    "inspectOwnerDirectory",
    "readCanonicalArtifact",
    "readOwnerOnlyBytes",
    "rss",
    "sha256Hex",
  ]) {
    storage[name] = captureFunctionProperty(
      value,
      name,
      `storage.${name}`,
    );
  }
  const defaultTemporaryRoot = readConfigProperty(
    value,
    "defaultTemporaryRoot",
    "storage.defaultTemporaryRoot must be a non-empty path",
  );
  if (
    typeof defaultTemporaryRoot !== "string"
    || defaultTemporaryRoot.length < 1
  ) {
    throw new TypeError("storage.defaultTemporaryRoot must be a non-empty path");
  }
  storage.defaultTemporaryRoot = defaultTemporaryRoot;
  return Object.freeze(storage);
}

function requireBasename(value, name) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new TypeError(`${name} must be a basename`);
  }
  return value;
}

function utf8Bytes(value) {
  return UTF8_ENCODER.encode(value);
}

function frameDigest(digest, family, record) {
  const frame = utf8Bytes(stableJson({ family, record }));
  const size = new Uint8Array(8);
  new DataView(size.buffer).setBigUint64(0, BigInt(frame.byteLength), false);
  digest.update(size);
  digest.update(frame);
}

function chunkRecords(bundle) {
  const rows = [];
  for (const [family, timeField, idField] of FAMILY) {
    for (const record of bundle.records[family]) {
      rows.push({ family, time: record[timeField], id: record[idField], record });
    }
  }
  return rows;
}

function sharedChunkContract(bundle) {
  return {
    compatibility: bundle.compatibility,
    participantId: bundle.participantId,
    createdAt: bundle.createdAt,
    coveredAt: bundle.coveredAt,
    sourceProviders: bundle.sourceProviders,
    clientPlatform: bundle.clientPlatform,
    transportReady: bundle.transportReady,
  };
}

function manifestSharedContract(manifest) {
  return {
    compatibility: manifest.compatibility,
    participantId: manifest.participantId,
    createdAt: manifest.createdAt,
    coveredAt: manifest.coveredAt,
    sourceProviders: manifest.sourceProviders,
    clientPlatform: manifest.clientPlatform,
    transportReady: manifest.transportReady,
  };
}

function firstRecordFitsPriorChunk(manifest, bundle, firstRow) {
  bundle.records[firstRow.family].push(firstRow.record);
  bundle.recordCounts[firstRow.family] += 1;
  let candidateBytes;
  try {
    candidateBytes = utf8Bytes(stableJson(bundle));
  } finally {
    bundle.records[firstRow.family].pop();
    bundle.recordCounts[firstRow.family] -= 1;
  }
  return candidateBytes.byteLength
    <= manifest.chunking.maximumCanonicalBundleBytes;
}

function assertManifestReceipt(receipt, manifestBytes, manifestVersion, hash) {
  const receiptVersion = manifestVersion === EXPORT_SET_MANIFEST_VERSION_V0_2
    ? EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_2
    : EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_1;
  const expected = {
    schemaVersion: receiptVersion,
    manifestSha256: hash(manifestBytes),
    manifestBytes: manifestBytes.byteLength,
    transportReady: false,
  };
  if (stableJson(receipt) !== stableJson(expected)) fail("manifest_receipt");
}

function manifestByteTotals(manifest) {
  if (manifest.schemaVersion === EXPORT_SET_MANIFEST_VERSION_V0_2) {
    return {
      decoded: manifest.totals.decodedBundleBytes,
      encoded: manifest.totals.encodedArtifactBytes,
    };
  }
  return { decoded: manifest.totals.bundleBytes, encoded: 0 };
}

function snapshotCanonicalArtifact(value, code) {
  try {
    const artifactValue = requireDataProperty(value, "value", code);
    const artifactBytes = requireByteSequence(
      requireDataProperty(value, "bytes", code),
      code,
    );
    return {
      value: structuredClone(artifactValue),
      bytes: new Uint8Array(artifactBytes),
    };
  } catch (error) {
    rethrowReviewedOrFail(error, code);
  }
}

function snapshotVerifiedBundle(value) {
  try {
    const rawBundle = requireDataProperty(value, "bundle", "chunk_metadata");
    if (
      rawBundle === null
      || typeof rawBundle !== "object"
      || Array.isArray(rawBundle)
    ) {
      fail("chunk_metadata");
    }
    const bundle = structuredClone(rawBundle);
    const bundleSha256 = requireDataProperty(
      value,
      "bundleSha256",
      "chunk_metadata",
    );
    const receiptSha256 = requireDataProperty(
      value,
      "receiptSha256",
      "chunk_metadata",
    );
    if (typeof bundleSha256 !== "string" || typeof receiptSha256 !== "string") {
      fail("chunk_metadata");
    }
    return {
      bundle,
      bundleSha256,
      receiptSha256,
      bundleBytes: new Uint8Array(requireByteSequence(
        requireDataProperty(value, "bundleBytes", "chunk_metadata"),
        "chunk_metadata",
      )),
      receiptBytes: new Uint8Array(requireByteSequence(
        requireDataProperty(value, "receiptBytes", "chunk_metadata"),
        "chunk_metadata",
      )),
    };
  } catch (error) {
    rethrowReviewedOrFail(error, "chunk_metadata");
  }
}

function snapshotPortMethods(value, names, code) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(code);
    }
    return Object.freeze(Object.fromEntries(names.map((name) => [
      name,
      captureFunctionProperty(value, name, name),
    ])));
  } catch (error) {
    rethrowReviewedOrFail(error, code);
  }
}

function snapshotVerificationIndex(value) {
  const fields = [
    "batchLimitRecords",
    "recordsIndexed",
    "nonEmptyBatchCount",
    "fullBatchCount",
    "maximumBatchRecords",
    "finalBatchRecords",
  ];
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail("verification_index");
    }
    return Object.fromEntries(fields.map((name) => {
      const field = requireDataProperty(value, name, "verification_index");
      if (!Number.isSafeInteger(field) || field < 0) {
        fail("verification_index");
      }
      return [name, field];
    }));
  } catch (error) {
    rethrowReviewedOrFail(error, "verification_index");
  }
}

function snapshotVerificationRequest(value) {
  const options = value === undefined ? {} : value;
  try {
    if (
      options === null
      || typeof options !== "object"
      || Array.isArray(options)
    ) {
      throw new TypeError("verification request must be an object");
    }
  } catch {
    throw new TypeError("verification request must be an object");
  }
  const directory = readConfigProperty(
    options,
    "directory",
    "verification request directory could not be read",
  );
  const selectedResourceLimits = readConfigProperty(
    options,
    "resourceLimits",
    "verification request resourceLimits could not be read",
  );
  const selectedIndexBytes = readConfigProperty(
    options,
    "maximumVerificationIndexBytes",
    "verification request maximumVerificationIndexBytes could not be read",
  );
  const selectedTemporaryRoot = readConfigProperty(
    options,
    "verificationTemporaryRoot",
    "verification request verificationTemporaryRoot could not be read",
  );
  return Object.freeze({
    directory,
    resourceLimits: selectedResourceLimits === undefined
      ? {}
      : selectedResourceLimits,
    maximumVerificationIndexBytes: selectedIndexBytes === undefined
      ? null
      : selectedIndexBytes,
    verificationTemporaryRoot: selectedTemporaryRoot,
  });
}

export function createLocalExportSetVerifier(options = {}) {
  try {
    if (
      options === null
      || typeof options !== "object"
      || Array.isArray(options)
    ) {
      throw new TypeError("verification options must be an object");
    }
  } catch {
    throw new TypeError("verification options must be an object");
  }
  const storage = readConfigProperty(
    options,
    "storage",
    "storage must be an object",
  );
  const files = requireStorage(storage);
  const bundleVerification = readConfigProperty(
    options,
    "bundleVerification",
    "bundleVerification must be an object",
  );
  try {
    if (
      bundleVerification === null
      || typeof bundleVerification !== "object"
      || Array.isArray(bundleVerification)
    ) {
      throw new TypeError("bundleVerification must be an object");
    }
  } catch {
    throw new TypeError("bundleVerification must be an object");
  }
  const loadVerifiedLocalMetadataBundleBytes = captureFunctionProperty(
    bundleVerification,
    "loadVerifiedLocalMetadataBundleBytes",
    "bundleVerification.loadVerifiedLocalMetadataBundleBytes",
  );
  const loadVerifiedLocalMetadataBundleFiles = captureFunctionProperty(
    bundleVerification,
    "loadVerifiedLocalMetadataBundleFiles",
    "bundleVerification.loadVerifiedLocalMetadataBundleFiles",
  );
  const currentCompatibilityTuple = requireFunction(
    readConfigProperty(
      options,
      "exportCompatibilityTuple",
      "exportCompatibilityTuple must be a function",
    ),
    "exportCompatibilityTuple",
  );
  const selectedManifestBasename = requireBasename(
    readConfigProperty(
      options,
      "manifestBasename",
      "manifestBasename must be a basename",
    ),
    "manifestBasename",
  );
  const selectedManifestReceiptBasename = requireBasename(
    readConfigProperty(
      options,
      "manifestReceiptBasename",
      "manifestReceiptBasename must be a basename",
    ),
    "manifestReceiptBasename",
  );

  async function assertNoMixedRepresentation(
    root,
    manifestVersion,
    maximumEntries,
  ) {
    let entries;
    try {
      entries = await files.enumerateDirectory({
        root,
        maximumEntries,
        createLimitError: (code) => new ExportResourceLimitError(code),
      });
    } catch (error) {
      if (isReviewedFailure(error)) throw error;
      fail("directory");
    }
    try {
      if (
        !Array.isArray(entries)
        || entries.some((name) => typeof name !== "string")
      ) {
        fail("directory");
      }
      const oppositePattern =
        manifestVersion === EXPORT_SET_MANIFEST_VERSION_V0_2
          ? /^chunk-\d{6}\.bundle\.json$/
          : /^chunk-\d{6}\.bundle\.json\.gz$/;
      if (entries.some((name) => oppositePattern.test(name))) {
        fail("mixed_representation");
      }
    } catch (error) {
      rethrowReviewedOrFail(error, "directory");
    }
  }

  async function loadVerifiedSetChunk({
    root,
    manifest,
    entry,
    resourceGuard,
  }) {
    const names = exportSetChunkBasenames(entry.index, manifest.schemaVersion);
    resourceGuard.observeCanonicalBundle(entry.bundleBytes);
    if (manifest.schemaVersion === EXPORT_SET_MANIFEST_VERSION_V0_1) {
      let selectedBundleFile;
      let selectedReceiptFile;
      try {
        selectedBundleFile = files.artifactPath(root, names.bundle);
        selectedReceiptFile = files.artifactPath(root, names.receipt);
      } catch (error) {
        rethrowReviewedOrFail(error, "chunk_metadata");
      }
      return snapshotVerifiedBundle(await invokePort(
        loadVerifiedLocalMetadataBundleFiles,
        {
          bundleFile: selectedBundleFile,
          receiptFile: selectedReceiptFile,
        },
        "chunk_metadata",
      ));
    }

    resourceGuard.observeEncodedArtifact(entry.artifactBytes);
    const artifactBytes = requireByteSequence(await invokePort(
      files.readOwnerOnlyBytes,
      {
        root,
        basename: names.bundle,
        label: "chunk_artifact",
        maximumBytes: resourceGuard.limits.maximumEncodedArtifactBytes,
        expectedBytes: entry.artifactBytes,
        createError: (code) => new ExportSetVerificationError(code),
      },
      "chunk_artifact_read",
    ), "chunk_artifact_read");
    if (
      invokeSyncPort(
        files.sha256Hex,
        artifactBytes,
        "chunk_artifact_digest",
      ) !== entry.artifactSha256
    ) {
      fail("chunk_artifact_digest");
    }

    const bundleBytes = decompressExportBytes(artifactBytes, {
      maximumEncodedBytes: entry.artifactBytes,
      maximumDecodedBytes: Math.min(
        entry.bundleBytes,
        resourceGuard.limits.maximumCanonicalBundleBytes,
      ),
    });
    if (
      bundleBytes.byteLength !== entry.bundleBytes
      || invokeSyncPort(
        files.sha256Hex,
        bundleBytes,
        "chunk_metadata",
      ) !== entry.bundleSha256
    ) {
      fail("chunk_metadata");
    }

    const receiptBytes = requireByteSequence(await invokePort(
      files.readOwnerOnlyBytes,
      {
        root,
        basename: names.receipt,
        label: "chunk_receipt",
        maximumBytes: MAXIMUM_MANIFEST_RECEIPT_BYTES,
        expectedBytes: entry.receiptBytes,
        createError: (code) => new ExportSetVerificationError(code),
      },
      "chunk_receipt_read",
    ), "chunk_receipt_read");
    if (
      invokeSyncPort(
        files.sha256Hex,
        receiptBytes,
        "chunk_metadata",
      ) !== entry.receiptSha256
    ) {
      fail("chunk_metadata");
    }
    return snapshotVerifiedBundle(await invokePort(
      loadVerifiedLocalMetadataBundleBytes,
      { bundleBytes, receiptBytes },
      "chunk_metadata",
    ));
  }

  async function verifyLocalExportSet(requestOptions = {}) {
    const request = snapshotVerificationRequest(requestOptions);
    const directory = request.directory;
    const resourceLimits = request.resourceLimits;
    const maximumVerificationIndexBytes =
      request.maximumVerificationIndexBytes;
    const verificationTemporaryRoot = request.verificationTemporaryRoot
      === undefined
      ? files.defaultTemporaryRoot
      : request.verificationTemporaryRoot;
    const root = await invokePort(
      files.inspectOwnerDirectory,
      {
        directory,
        createError: (code) => new ExportSetVerificationError(code),
      },
      "directory",
    );
    if (typeof root !== "string" || root.length < 1) fail("directory");
    const manifestArtifact = snapshotCanonicalArtifact(await invokePort(
      files.readCanonicalArtifact,
      {
        root,
        basename: selectedManifestBasename,
        label: "manifest",
        maximumBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumManifestBytes,
        canonicalJson: stableJson,
        createError: (code) => new ExportSetVerificationError(code),
      },
      "manifest_changed",
    ), "manifest_changed");
    const receiptArtifact = snapshotCanonicalArtifact(await invokePort(
      files.readCanonicalArtifact,
      {
        root,
        basename: selectedManifestReceiptBasename,
        label: "manifest",
        maximumBytes: MAXIMUM_MANIFEST_RECEIPT_BYTES,
        canonicalJson: stableJson,
        createError: (code) => new ExportSetVerificationError(code),
      },
      "manifest_changed",
    ), "manifest_changed");
    try {
      assertValidExportSetManifest(manifestArtifact.value);
    } catch {
      fail("manifest_schema");
    }
    const manifest = manifestArtifact.value;
    assertManifestReceipt(
      receiptArtifact.value,
      manifestArtifact.bytes,
      manifest.schemaVersion,
      (bytes) => invokeSyncPort(
        files.sha256Hex,
        bytes,
        "manifest_receipt",
      ),
    );
    try {
      if (
        stableJson(manifest.compatibility)
        !== stableJson(currentCompatibilityTuple())
      ) {
        fail("compatibility");
      }
    } catch (error) {
      rethrowReviewedOrFail(error, "compatibility");
    }
    const resourceGuard = createExportResourceGuard({
      scope: "export_set",
      limits: resourceLimits,
      clock() {
        try {
          return files.clock();
        } catch {
          throw new ExportResourceLimitError("elapsed_time");
        }
      },
      rss() {
        try {
          return files.rss();
        } catch {
          throw new ExportResourceLimitError("rss");
        }
      },
    });
    await assertNoMixedRepresentation(
      root,
      manifest.schemaVersion,
      resourceGuard.limits.maximumDirectoryEntries,
    );
    const verificationIndexLimit = maximumVerificationIndexBytes
      ?? resourceGuard.limits.maximumWorkspaceBytes;
    if (
      !Number.isSafeInteger(verificationIndexLimit)
      || verificationIndexLimit < 1
      || verificationIndexLimit > resourceGuard.limits.maximumWorkspaceBytes
    ) {
      throw new TypeError(
        "maximumVerificationIndexBytes must fit the workspace resource policy",
      );
    }
    resourceGuard.assertCoveredInterval(
      Date.parse(manifest.coveredAt.startAt),
      Date.parse(manifest.coveredAt.endAt),
    );
    resourceGuard.observeSourcePlan(
      manifest.sourcePlan.sourceFiles,
      manifest.sourcePlan.sourceBytes,
    );
    resourceGuard.observeChunkCount(manifest.chunks.length);
    resourceGuard.observeManifest(manifestArtifact.bytes.byteLength);
    const declaredBytes = manifestByteTotals(manifest);
    resourceGuard.observeExportSetBytes(
      declaredBytes.decoded,
      declaredBytes.encoded,
    );

    const uniquenessPort = snapshotPortMethods(await invokePort(
      files.createUniquenessIndex,
      {
        maximumBytes: verificationIndexLimit,
        batchLimitRecords: resourceGuard.limits.maximumSqliteBatchRecords,
        temporaryRoot: verificationTemporaryRoot,
        observeWorkspace: (bytes) => resourceGuard.observeWorkspace(bytes),
        createLimitError: (code) => new ExportResourceLimitError(code),
        isResourceLimitError: (error) =>
          error instanceof ExportResourceLimitError,
        createError: (code) => new ExportSetVerificationError(code),
      },
      "verification_index",
    ), ["add", "close"], "verification_index");
    const unique = Object.freeze({
      add(family, id) {
        try {
          return uniquenessPort.add(family, id);
        } catch (error) {
          rethrowReviewedOrFail(error, "verification_index");
        }
      },
      close() {
        return invokePort(
          uniquenessPort.close,
          undefined,
          "verification_index",
        );
      },
    });
    const digestPort = snapshotPortMethods(invokeSyncPort(
      files.createSha256Digest,
      undefined,
      "logical_digest",
    ), ["update", "digest"], "logical_digest");
    const logical = Object.freeze({
      update(value) {
        return invokeSyncPort(digestPort.update, value, "logical_digest");
      },
      digest(value) {
        return invokeSyncPort(digestPort.digest, value, "logical_digest");
      },
    });
    logical.update("app-usagemonitor/export-set-logical-records/v1\0");
    let priorLast = null;
    let priorBundle = null;
    let priorCount = 0;
    let diagnostics = null;
    let actualDecodedBytes = 0;
    let actualEncodedBytes = 0;
    let actualReceiptBytes = 0;
    let verificationIndex = null;
    let primaryFailure = null;
    try {
      for (const entry of manifest.chunks) {
        const verified = await loadVerifiedSetChunk({
          root,
          manifest,
          entry,
          resourceGuard,
        });
        const bundle = verified.bundle;
        if (
          bundle.bundleId !== entry.bundleId
          || verified.bundleSha256 !== entry.bundleSha256
          || verified.bundleBytes.byteLength !== entry.bundleBytes
          || verified.receiptSha256 !== entry.receiptSha256
          || verified.receiptBytes.byteLength !== entry.receiptBytes
          || stableJson(bundle.recordCounts) !== stableJson(entry.recordCounts)
        ) {
          fail("chunk_metadata");
        }
        actualDecodedBytes += verified.bundleBytes.byteLength;
        actualReceiptBytes += verified.receiptBytes.byteLength;
        if (manifest.schemaVersion === EXPORT_SET_MANIFEST_VERSION_V0_2) {
          actualEncodedBytes += entry.artifactBytes;
        }
        resourceGuard.observeExportSetBytes(
          actualDecodedBytes,
          actualEncodedBytes,
        );
        if (
          stableJson(sharedChunkContract(bundle))
          !== stableJson(manifestSharedContract(manifest))
        ) {
          fail("chunk_shared_contract");
        }
        if (diagnostics === null) diagnostics = stableJson(bundle.diagnostics);
        else if (stableJson(bundle.diagnostics) !== diagnostics) {
          fail("chunk_diagnostics");
        }

        const rows = chunkRecords(bundle);
        if (
          priorBundle
          && rows.length > 0
          && priorCount < manifest.chunking.maximumRecordsPerChunk
          && firstRecordFitsPriorChunk(manifest, priorBundle, rows[0])
        ) {
          fail("chunk_nonmaximal");
        }
        for (const row of rows) {
          resourceGuard.observeOutputRecord(
            utf8Bytes(stableJson(row.record)).byteLength,
          );
          const familyOrder = FAMILY.findIndex(
            ([family]) => family === row.family,
          );
          const key = [familyOrder, row.time, row.id];
          if (
            priorLast
            && (
              key[0] < priorLast[0]
              || (key[0] === priorLast[0] && key[1] < priorLast[1])
              || (
                key[0] === priorLast[0]
                && key[1] === priorLast[1]
                && key[2] <= priorLast[2]
              )
            )
          ) {
            fail("chunk_order");
          }
          unique.add(row.family, row.id);
          frameDigest(logical, row.family, row.record);
          priorLast = key;
        }
        priorBundle = bundle;
        priorCount = rows.length;
      }
      if (logical.digest("hex") !== manifest.totals.logicalRecordsSha256) {
        fail("logical_digest");
      }
      if (
        actualDecodedBytes !== declaredBytes.decoded
        || actualEncodedBytes !== declaredBytes.encoded
        || actualReceiptBytes !== manifest.totals.receiptBytes
      ) {
        fail("chunk_metadata");
      }
    } catch (error) {
      primaryFailure = isReviewedFailure(error)
        ? error
        : new ExportSetVerificationError("chunk_metadata");
      throw primaryFailure;
    } finally {
      try {
        verificationIndex = snapshotVerificationIndex(await unique.close());
      } catch (error) {
        if (primaryFailure === null) throw error;
      }
    }

    return {
      verdict: "passed",
      schemaVersion: manifest.schemaVersion,
      contractStatus: manifest.compatibility.contract.status,
      chunkCount: manifest.chunks.length,
      recordCounts: structuredClone(manifest.totals.recordCounts),
      bundleBytes: declaredBytes.decoded,
      decodedBundleBytes: declaredBytes.decoded,
      encodedArtifactBytes: declaredBytes.encoded,
      transportReady: manifest.transportReady,
      verificationIndex,
    };
  }

  return Object.freeze({ verifyLocalExportSet });
}
